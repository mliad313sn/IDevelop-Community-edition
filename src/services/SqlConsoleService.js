'use strict';

const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('../config/database');
const DatabaseCleanupService = require('./DatabaseCleanupService');
const LogService = require('./LogService');

/**
 * SqlConsoleService — powers the super-admin-only SQL toolbox:
 *   1. execute(sql)          — run a raw SQL script (transactional when possible,
 *                              statement-by-statement autocommit when the script
 *                              contains statements PostgreSQL forbids in a
 *                              transaction block: VACUUM, CREATE DATABASE,
 *                              CREATE INDEX CONCURRENTLY, ALTER SYSTEM, …).
 *   2. Restore points        — before ANY database-changing script, a pg_dump
 *                              restore point is taken automatically. A failing
 *                              non-transactional script is auto-reverted from it;
 *                              any restore point can also be reverted manually.
 *   3. generateFromWorkbook  — turn a full-system Excel template into an idempotent SQL
 *                              script that reproduces what the Excel importer would do,
 *                              so an admin can copy-paste it instead of uploading a file.
 *
 * SECURITY: every caller must already be gated to role === 'superadmin' at the route.
 *
 * SEPARATION OF DUTIES: the console is OFF unless the operator of the host sets
 * SQL_CONSOLE_ENABLED=1 in the environment. A super administrator is an
 * application role; raw SQL on the production database is an infrastructure
 * power. Keeping the switch in the environment (not in App Settings) means the
 * application's own super admin cannot turn it on for themselves — whoever runs
 * the server has to. When off, every console route answers 404 and the menu
 * entry is hidden (see isEnabled()).
 */
class SqlConsoleService {
    /**
     * Whether the SQL console is switched on for this instance. Read on every call
     * (never cached) so an operator can switch it off with a restart-free env
     * reload in tests and a plain restart in production.
     * @returns {boolean}
     */
    isEnabled() {
        const v = String(process.env.SQL_CONSOLE_ENABLED || '')
            .trim()
            .toLowerCase();
        return v === '1' || v === 'true';
    }

    /**
     * The append-only audit tables, as real PostgreSQL names. ONE declared list,
     * owned by DatabaseCleanupService.IMMUTABLE_TABLES — used both by the editor's
     * tamper guard (refuse to write them) and by the restore-point revert (preserve
     * them across the restore). The two must never drift: a table the editor
     * refuses to modify that a revert silently rolled back would be an empty
     * promise.
     *
     * "Must never drift" used to be a sentence in a comment. It drifted: migration
     * 116 guarded self_assessment_events and this list stayed at three, so the
     * console accepted a row delete on self_assessment_events (and a `DROP TABLE` —
     * measured, the table really disappeared) on a journal the database itself calls
     * append-only. The sentence is now enforced from both ends:
     *   • resolvedProtectedTables below takes the UNION of this list and what the
     *     DATABASE reports (public.append_only_tables, migration 120), so a table
     *     that carries the guards is protected even if the list lags;
     *   • a unit test compares this list with the CREATE TRIGGER statements in
     *     db/postgres/*.sql, so the drift itself turns the suite red.
     */
    get PROTECTED_TABLES() {
        return DatabaseCleanupService.IMMUTABLE_PG_TABLES;
    }

    /**
     * The append-only tables as the DATABASE reports them: every public table
     * carrying a block_mutation/block_truncate trigger. Migration 120 exposes
     * this as public.append_only_tables; older databases are read straight from
     * pg_trigger so an un-migrated install is still protected.
     * Returns [] (never throws) when the database cannot answer — the caller then
     * falls back to the declared list, which is never weaker than before.
     */
    async _liveAppendOnlyTables() {
        const rows = await this._rawQuery(`SELECT DISTINCT c.relname AS table_name
              FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE n.nspname = 'public' AND NOT t.tgisinternal
               AND p.proname IN ('block_mutation', 'block_truncate')`);
        return rows.map((r) => r.table_name).filter(Boolean);
    }

    /**
     * Catalog probe that BYPASSES the sql-compat translation layer. These queries
     * read PostgreSQL's own catalogs with their real, already-snake_case names; the
     * translator has no business rewriting them, and a rewritten `count(*) FILTER`
     * or `CAST(x AS TEXT)` has been measured returning false zeros through db.get.
     * Returns [] instead of throwing: a guard that cannot consult the catalog must
     * degrade to its static check, not crash the console.
     */
    async _rawQuery(sql, params = []) {
        try {
            const res = await db.pool.query(sql, params);
            return (res && res.rows) || [];
        } catch (_) {
            return [];
        }
    }

    /**
     * The set the guards actually enforce: declared list ∪ live database. A short
     * TTL keeps a run of statements from re-querying the catalog each time while
     * still picking up a migration without a restart.
     */
    async resolvedProtectedTables() {
        const now = Date.now();
        if (this._protCache && now - this._protCache.at < 30_000) return this._protCache.list;
        const live = await this._liveAppendOnlyTables();
        const list = [...new Set([...this.PROTECTED_TABLES, ...live])].sort();
        this._protCache = { at: now, list };
        return list;
    }

    /**
     * Relations that ARE a protected table without being NAMED one: views (and
     * views on views) whose rewrite rules read a protected table. This is the
     * pg_depend answer to the laundering trick design review measured — a view
     * makes the name disappear from the statement text, so a name-only guard sees
     * `DELETE FROM uat3_v_logs` and waves it through while PostgreSQL deletes from
     * system_logs. Returns [] when the catalog cannot be read; the caller then
     * still has the name-based check.
     */
    async _protectedRelationAliases(protectedTables) {
        if (!protectedTables.length) return [];
        const rows = await this._rawQuery(
            `WITH RECURSIVE prot AS (
                     SELECT c.oid FROM pg_class c
                       JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND c.relname = ANY($1)
                 ), dep AS (
                     SELECT oid FROM prot
                     UNION
                     SELECT r.ev_class
                       FROM pg_rewrite r
                       JOIN pg_depend d ON d.objid = r.oid
                                       AND d.classid = 'pg_rewrite'::regclass
                                       AND d.refclassid = 'pg_class'::regclass
                       JOIN dep ON dep.oid = d.refobjid
                 )
                 SELECT c.relname AS alias_name
                   FROM pg_class c JOIN dep ON dep.oid = c.oid
                  WHERE c.relname <> ALL($1)`,
            [protectedTables]
        );
        return rows.map((r) => r.alias_name).filter(Boolean);
    }

    // ---- SQL literal helpers -------------------------------------------------
    static str(v) {
        if (v === null || v === undefined) return 'NULL';
        const s = typeof v === 'object' && v.text ? v.text : v; // exceljs rich text / hyperlink cells
        const t = String(s).trim();
        if (t === '') return 'NULL';
        return `'${t.replace(/'/g, "''")}'`;
    }

    static num(v) {
        if (v === null || v === undefined || String(v).trim() === '') return 'NULL';
        const n = Number(v);
        return Number.isFinite(n) ? String(n) : 'NULL';
    }

    // A scalar subselect that resolves an active skill id by name (names are not
    // globally unique, so we take the lowest id deterministically).
    static _skillIdExpr(name) {
        return `(SELECT id FROM skills WHERE is_active AND lower(name) = lower(${this.str(name)}) ORDER BY id LIMIT 1)`;
    }

    // ---- Excel → SQL ---------------------------------------------------------
    /**
     * Read a worksheet into an array of plain objects keyed by our canonical field
     * names, matching each column by header alias (case-insensitive). Returns [] if
     * the sheet is missing.
     */
    _rows(workbook, sheetNames, aliasSpec) {
        let sheet = null;
        for (const n of sheetNames) {
            sheet = workbook.getWorksheet(n);
            if (sheet) break;
        }
        if (!sheet) return { rows: [], skillCols: [] };

        const header = sheet.getRow(1);
        const colOf = {};
        const known = new Set();
        header.eachCell((cell, c) => {
            const label = (cell.value == null ? '' : String(cell.value.text || cell.value))
                .trim()
                .toLowerCase();
            if (!label) return;
            for (const [key, aliases] of Object.entries(aliasSpec)) {
                if (colOf[key] == null && aliases.includes(label)) {
                    colOf[key] = c;
                    known.add(c);
                }
            }
        });
        // Any header column not claimed as a known field is treated as a skill-matrix column.
        const skillCols = [];
        header.eachCell((cell, c) => {
            if (known.has(c)) return;
            const label = (cell.value == null ? '' : String(cell.value.text || cell.value)).trim();
            if (label) skillCols.push({ col: c, name: label });
        });

        const rows = [];
        sheet.eachRow((row, n) => {
            if (n === 1) return;
            const obj = {};
            for (const [key, c] of Object.entries(colOf)) {
                const v = row.getCell(c).value;
                obj[key] = v == null ? null : v.text != null ? v.text : v;
            }
            const skills = {};
            for (const sc of skillCols) {
                const v = row.getCell(sc.col).value;
                if (v !== null && v !== undefined && String(v).trim() !== '') skills[sc.name] = v;
            }
            obj.__skills = skills;
            rows.push(obj);
        });
        return { rows, skillCols };
    }

    async generateFromWorkbook(workbook) {
        const S = SqlConsoleService;
        const out = [];
        const push = (...lines) => out.push(...lines);

        push(
            '-- ================================================================',
            '-- Full-system import script generated from an Excel template.',
            '-- Idempotent: safe to run more than once (existing rows are skipped).',
            '-- The SQL Console runs this whole script in ONE transaction, so a single',
            '-- failure rolls everything back — do NOT add BEGIN/COMMIT yourself.',
            '-- NOTE: employees created here have NO login yet (password cannot be hashed',
            '--       in SQL). Provision logins from the Employees screen after loading.',
            '-- ================================================================',
            ''
        );

        // 1. Organization: sites → departments → services
        const org = this._rows(workbook, ['Organization', 'Organization Structure', 'Org'], {
            site: ['site', 'site name'],
            department: ['department', 'dept', 'department name'],
            service: ['service', 'service name'],
        });
        if (org.rows.length) {
            push('-- 1. Organization (Site → Department → Service)');
            const sites = new Set(),
                depts = new Set(),
                svcs = new Set();
            for (const r of org.rows) {
                if (r.site && !sites.has(r.site)) {
                    sites.add(r.site);
                    push(
                        `INSERT INTO sites (name, is_active) SELECT ${S.str(r.site)}, true` +
                            ` WHERE NOT EXISTS (SELECT 1 FROM sites WHERE lower(name)=lower(${S.str(r.site)}));`
                    );
                }
            }
            for (const r of org.rows) {
                const k = `${r.site}||${r.department}`;
                if (r.site && r.department && !depts.has(k)) {
                    depts.add(k);
                    push(
                        `INSERT INTO departments (name, site_id, is_active)` +
                            ` SELECT ${S.str(r.department)}, s.id, true FROM sites s WHERE lower(s.name)=lower(${S.str(r.site)})` +
                            ` AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.site_id=s.id AND lower(d.name)=lower(${S.str(r.department)}));`
                    );
                }
            }
            for (const r of org.rows) {
                const k = `${r.site}||${r.department}||${r.service}`;
                if (r.site && r.department && r.service && !svcs.has(k)) {
                    svcs.add(k);
                    push(
                        `INSERT INTO services (name, department_id, is_active)` +
                            ` SELECT ${S.str(r.service)}, d.id, true FROM departments d JOIN sites s ON s.id=d.site_id` +
                            ` WHERE lower(s.name)=lower(${S.str(r.site)}) AND lower(d.name)=lower(${S.str(r.department)})` +
                            ` AND NOT EXISTS (SELECT 1 FROM services sv WHERE sv.department_id=d.id AND lower(sv.name)=lower(${S.str(r.service)}));`
                    );
                }
            }
            push('');
        }

        // 2. Domains & Sub-domains & Skills
        const ds = this._rows(
            workbook,
            ['Domains & Skills', 'Domains_Skills', 'Skills', 'Data Model'],
            {
                domain: ['domain', 'domain name'],
                subDomain: ['sub-domain', 'sub domain', 'subdomain', 'sub-domain name'],
                skill: ['skill', 'skill name', 'name'],
                category: ['category', 'type'],
                description: ['description', 'definition'],
            }
        );
        if (ds.rows.length) {
            push('-- 2. Domains → Sub-domains → Skills');
            const domains = new Set(),
                subs = new Set();
            for (const r of ds.rows) {
                if (r.domain && !domains.has(r.domain)) {
                    domains.add(r.domain);
                    push(
                        `INSERT INTO domains (name, is_active) SELECT ${S.str(r.domain)}, true` +
                            ` WHERE NOT EXISTS (SELECT 1 FROM domains WHERE lower(name)=lower(${S.str(r.domain)}));`
                    );
                }
            }
            for (const r of ds.rows) {
                const k = `${r.domain}||${r.subDomain}`;
                if (r.domain && r.subDomain && !subs.has(k)) {
                    subs.add(k);
                    push(
                        `INSERT INTO sub_domains (domain_id, name, position, is_active)` +
                            ` SELECT d.id, ${S.str(r.subDomain)}, 999, true FROM domains d WHERE lower(d.name)=lower(${S.str(r.domain)})` +
                            ` AND NOT EXISTS (SELECT 1 FROM sub_domains sd WHERE sd.domain_id=d.id AND lower(sd.name)=lower(${S.str(r.subDomain)}));`
                    );
                }
            }
            for (const r of ds.rows) {
                if (!r.domain || !r.skill) continue;
                if (r.subDomain) {
                    push(
                        `INSERT INTO skills (name, domain_id, sub_domain_id, category, description, is_active)` +
                            ` SELECT ${S.str(r.skill)}, d.id, sd.id, ${S.str(r.category)}, ${S.str(r.description)}, true` +
                            ` FROM domains d JOIN sub_domains sd ON sd.domain_id=d.id AND lower(sd.name)=lower(${S.str(r.subDomain)})` +
                            ` WHERE lower(d.name)=lower(${S.str(r.domain)})` +
                            ` AND NOT EXISTS (SELECT 1 FROM skills s WHERE s.is_active AND s.sub_domain_id=sd.id AND lower(s.name)=lower(${S.str(r.skill)}));`
                    );
                } else {
                    push(
                        `INSERT INTO skills (name, domain_id, category, description, is_active)` +
                            ` SELECT ${S.str(r.skill)}, d.id, ${S.str(r.category)}, ${S.str(r.description)}, true` +
                            ` FROM domains d WHERE lower(d.name)=lower(${S.str(r.domain)})` +
                            ` AND NOT EXISTS (SELECT 1 FROM skills s WHERE s.is_active AND s.domain_id=d.id AND s.sub_domain_id IS NULL AND lower(s.name)=lower(${S.str(r.skill)}));`
                    );
                }
            }
            push('');
        }

        // 3. Role families → Roles → Requirements
        const roles = this._rows(workbook, ['Roles ', 'Roles', 'Role Requirements'], {
            role: ['role name', 'role', 'name'],
            description: ['description'],
            roleFamily: ['role family', 'family'],
            level: ['level', 'role level'],
        });
        if (roles.rows.length) {
            push('-- 3. Role families → Roles → Requirements');
            const fams = new Set();
            for (const r of roles.rows) {
                if (r.roleFamily && !fams.has(r.roleFamily)) {
                    fams.add(r.roleFamily);
                    push(
                        `INSERT INTO role_families (name, origin, is_active) SELECT ${S.str(r.roleFamily)}, 'standard', true` +
                            ` WHERE NOT EXISTS (SELECT 1 FROM role_families WHERE lower(name)=lower(${S.str(r.roleFamily)}));`
                    );
                }
            }
            for (const r of roles.rows) {
                if (!r.role) continue;
                if (r.roleFamily) {
                    push(
                        `INSERT INTO roles (name, description, role_family_id, is_active)` +
                            ` SELECT ${S.str(r.role)}, ${S.str(r.description)}, rf.id, true FROM role_families rf WHERE lower(rf.name)=lower(${S.str(r.roleFamily)})` +
                            ` AND NOT EXISTS (SELECT 1 FROM roles WHERE lower(name)=lower(${S.str(r.role)}));`
                    );
                } else {
                    push(
                        `INSERT INTO roles (name, description, is_active) SELECT ${S.str(r.role)}, ${S.str(r.description)}, true` +
                            ` WHERE NOT EXISTS (SELECT 1 FROM roles WHERE lower(name)=lower(${S.str(r.role)}));`
                    );
                }
                for (const [skillName, lvl] of Object.entries(r.__skills)) {
                    const level = S.num(lvl);
                    if (level === 'NULL') continue;
                    push(
                        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level)` +
                            ` SELECT r.id, ${S._skillIdExpr(skillName)}, ${level} FROM roles r WHERE lower(r.name)=lower(${S.str(r.role)})` +
                            ` AND ${S._skillIdExpr(skillName)} IS NOT NULL` +
                            ` AND NOT EXISTS (SELECT 1 FROM role_skill_requirements rsr WHERE rsr.role_id=r.id AND rsr.skill_id=${S._skillIdExpr(skillName)});`
                    );
                }
            }
            push('');
        }

        // 4. Employees → Assessments
        const emps = this._rows(workbook, ['Employees', 'Employee Directory', 'Employees_Live'], {
            empNo: ['employee id', 'employee number', 'emp id'],
            firstName: ['first name', 'first'],
            lastName: ['last name', 'last'],
            email: ['email'],
            site: ['site'],
            department: ['department', 'dept'],
            service: ['service'],
            role: ['role'],
        });
        if (emps.rows.length) {
            push(
                '-- 4. Employees (no login yet — provision from the Employees screen) → Assessments'
            );
            for (const r of emps.rows) {
                if (!r.empNo || !r.firstName || !r.lastName) continue;
                push(
                    `INSERT INTO employees (employee_number, first_name, last_name, email, site_id, department_id, service_id, role_id, is_active)` +
                        ` SELECT ${S.str(r.empNo)}, ${S.str(r.firstName)}, ${S.str(r.lastName)}, ${S.str(r.email)}, s.id, d.id, sv.id, r.id, true` +
                        ` FROM sites s JOIN departments d ON d.site_id=s.id JOIN services sv ON sv.department_id=d.id JOIN roles r ON true` +
                        ` WHERE lower(s.name)=lower(${S.str(r.site)}) AND lower(d.name)=lower(${S.str(r.department)}) AND lower(sv.name)=lower(${S.str(r.service)}) AND lower(r.name)=lower(${S.str(r.role)})` +
                        ` AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.employee_number=${S.str(r.empNo)});`
                );
                for (const [skillName, lvl] of Object.entries(r.__skills)) {
                    const level = S.num(lvl);
                    if (level === 'NULL') continue;
                    push(
                        `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by)` +
                            ` SELECT e.id, ${S._skillIdExpr(skillName)}, ${level}, (SELECT id FROM admins ORDER BY id LIMIT 1)` +
                            ` FROM employees e WHERE e.employee_number=${S.str(r.empNo)}` +
                            ` AND ${S._skillIdExpr(skillName)} IS NOT NULL AND EXISTS (SELECT 1 FROM admins)` +
                            ` AND NOT EXISTS (SELECT 1 FROM skill_assessments sa WHERE sa.employee_id=e.id AND sa.skill_id=${S._skillIdExpr(skillName)});`
                    );
                }
            }
            push('');
        }

        push('-- End of generated script.');
        return out.join('\n');
    }

    /**
     * Split a SQL script into individual statements, respecting single-quoted
     * strings (with '' escapes), dollar-quoted strings ($tag$…$tag$), line and
     * block comments — so a ';' inside a literal or comment does not split.
     * Returns an array of statement strings (without the trailing ';').
     */
    _splitStatements(text) {
        const s = String(text);
        const out = [];
        let buf = '';
        let i = 0;
        const n = s.length;
        while (i < n) {
            const ch = s[i];
            const two = s.slice(i, i + 2);
            if (two === '--') {
                // line comment
                const nl = s.indexOf('\n', i);
                const end = nl === -1 ? n : nl + 1;
                buf += s.slice(i, end);
                i = end;
                continue;
            }
            if (two === '/*') {
                // block comment
                const close = s.indexOf('*/', i + 2);
                const end = close === -1 ? n : close + 2;
                buf += s.slice(i, end);
                i = end;
                continue;
            }
            if (ch === "'") {
                // single-quoted string
                let j = i + 1;
                while (j < n) {
                    if (s[j] === "'" && s[j + 1] === "'") {
                        j += 2;
                        continue;
                    }
                    if (s[j] === "'") {
                        j++;
                        break;
                    }
                    j++;
                }
                buf += s.slice(i, j);
                i = j;
                continue;
            }
            if (ch === '$') {
                // dollar-quoted string ($tag$ ... $tag$)
                const m = /^\$[A-Za-z0-9_]*\$/.exec(s.slice(i));
                if (m) {
                    const tag = m[0];
                    const close = s.indexOf(tag, i + tag.length);
                    const end = close === -1 ? n : close + tag.length;
                    buf += s.slice(i, end);
                    i = end;
                    continue;
                }
            }
            if (ch === ';') {
                out.push(buf.trim());
                buf = '';
                i++;
                continue;
            }
            buf += ch;
            i++;
        }
        if (buf.trim()) out.push(buf.trim());
        return out.filter((st) => st.length);
    }

    /**
     * Strip statements that are ONLY transaction control (BEGIN/COMMIT/ROLLBACK/
     * SAVEPOINT/…). The console owns the transaction; letting a pasted COMMIT run
     * would defeat dry-run rollback and the atomic wrapper. Returns { clean, stripped }.
     */
    _stripTxControl(text) {
        const stripped = [];
        const kept = [];
        for (const stmt of this._splitStatements(text)) {
            // Strip leading comments/whitespace before classifying the statement.
            const code = stmt.replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '').trim();
            if (
                /^(begin|commit|rollback|end|start\s+transaction|savepoint\s+\S+|release\s+savepoint\s+\S+|abort)(\s+work|\s+transaction)?$/i.test(
                    code
                )
            ) {
                stripped.push(code);
            } else {
                kept.push(stmt);
            }
        }
        return { clean: kept.join(';\n') + (kept.length ? ';' : ''), stripped };
    }

    // ---- Statement classification ---------------------------------------------
    /** Leading code of a statement with comments/whitespace stripped, lowercased. */
    _head(stmt) {
        return String(stmt)
            .replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '')
            .trim()
            .toLowerCase();
    }

    /**
     * True when the statement can change database state. Deliberately conservative:
     * anything that is not clearly read-only counts as a write (a false positive
     * only costs an unneeded restore point; a false negative would skip the safety
     * net). WITH-CTEs count as writes when they contain data-modifying keywords.
     */
    _isWrite(stmt) {
        const head = this._head(stmt);
        const noStrings = head.replace(/'[^']*'/g, '');
        if (/^(show|table|values)\b/.test(head)) return false;
        if (/^select\b/.test(head)) return /\binto\b/.test(noStrings); // SELECT … INTO creates a table
        // EXPLAIN ANALYZE <write> executes the write; WITH-CTEs can modify data.
        if (/^(explain|with)\b/.test(head))
            return /\b(insert|update|delete|merge)\b/.test(noStrings);
        return true;
    }

    /**
     * Every identifier the statement uses as a function call, lower-cased and
     * un-qualified. Deliberately over-inclusive: SQL keywords followed by '(' come
     * back too (`in (`, `values (`), and that costs nothing — they resolve to no
     * pg_proc row. Missing a REAL call is what costs: see _writeAnalysis.
     */
    _calledFunctionNames(stmt) {
        const bare = this._head(stmt)
            .replace(/'[^']*'/g, "''")
            .replace(/\$[a-z0-9_]*\$[\s\S]*?\$[a-z0-9_]*\$/g, ' ');
        const out = new Set();
        const re = /([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)*)\s*\(/g;
        let m;
        while ((m = re.exec(bare)) !== null) {
            const parts = m[1].split('.');
            out.add(parts[parts.length - 1]);
        }
        return [...out];
    }

    /** Which of `names` PostgreSQL knows as VOLATILE functions. Throws if it cannot ask. */
    async _volatileFunctionNames(names) {
        if (!names.length) return new Set();
        const res = await db.pool.query(
            `SELECT DISTINCT p.proname FROM pg_proc p WHERE p.proname = ANY($1) AND p.provolatile = 'v'`,
            [names]
        );
        return new Set((res.rows || []).map((r) => r.proname));
    }

    /**
     * Does this script change the database? Returns { hasWrite, volatileCalls }.
     *
     * WHY THIS IS NOT JUST _isWrite. The file's own invariant says "anything that is
     * not clearly read-only counts as a write … a false negative would skip the
     * safety net", and the code did the opposite: every statement starting with
     * `select` (without INTO) was filed as read-only. Measured, for real, committed:
     *   SELECT uat3_p2s03_wipe;   -- a plpgsql function whose body is a DELETE
     *   -> 200, ok=true, 25 rows deleted and COMMITTED, restorePoint = null
     * on a page that promises a backup "before any script that modifies the
     * database". `SELECT setval(…)` did the same to a sequence.
     *
     * A SELECT is now read-only only when it is PROVABLY pure: PostgreSQL is asked
     * whether any function it calls is VOLATILE — which is exactly what a plpgsql
     * function that writes, nextval and setval all are, and what count/lower/
     * now are not. If the catalog cannot be consulted we fail CLOSED and take the
     * restore point: an unnecessary dump is cheap, a missing one is not.
     */
    async _writeAnalysis(stmts) {
        const readish = [];
        for (const s of stmts) {
            if (this._isWrite(s)) return { hasWrite: true, volatileCalls: [] };
            readish.push(s);
        }
        const names = [...new Set(readish.flatMap((s) => this._calledFunctionNames(s)))];
        if (!names.length) return { hasWrite: false, volatileCalls: [] };
        let volatiles;
        try {
            volatiles = await this._volatileFunctionNames(names);
        } catch (_) {
            return { hasWrite: true, volatileCalls: [] }; // cannot prove purity → treat as a write
        }
        const volatileCalls = names.filter((n) => volatiles.has(n));
        return { hasWrite: volatileCalls.length > 0, volatileCalls };
    }

    /**
     * Returns a human reason string if any statement would tamper with the append-only
     * audit trail, else null. Blocks: (a) DISABLE TRIGGER anywhere (disabling the
     * immutability triggers defeats the whole control); (b) any mutating/DDL statement
     * (DELETE/TRUNCATE/UPDATE/DROP/ALTER) that references one of the protected audit
     * tables. String literals are stripped so a table name inside quotes doesn't trip it.
     */
    _auditTamperViolation(stmts, protectedNames = null) {
        // `PROTECTED` GROWS AS THE SCRIPT IS READ. pg_depend can only name a view
        // that already exists; the measured bypass created it in the same script —
        //   SET session_replication_role='replica';
        //   CREATE VIEW v AS SELECT * FROM system_logs;
        //   DELETE FROM v WHERE id=12;          -> 200, ok=true, rowCount=1
        // — so every relation this script defines ON TOP of a protected one joins the
        // protected set for the statements that follow it.
        const PROTECTED = [
            ...(protectedNames && protectedNames.length ? protectedNames : this.PROTECTED_TABLES),
        ];
        const refsProtected = (txt) =>
            PROTECTED.find((t) => new RegExp('\\b(public\\.)?' + t + '\\b').test(txt));
        // CREATE [OR REPLACE] [TEMP|UNLOGGED] [MATERIALIZED] VIEW|TABLE <name> [AS …]
        const DEFINES =
            /^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+|unlogged\s+|global\s+|local\s+)*(?:materialized\s+|recursive\s+)*(view|table)\s+(?:if\s+not\s+exists\s+)?([a-z0-9_$."]+)/;
        for (const s of stmts) {
            const raw = String(s).toLowerCase();
            // Every classification below reads the statement HEAD — leading comments
            // and whitespace stripped by _head, exactly as _isWrite/_cannotRunInTx
            // already did — never the raw text. The anchored (^) tests used to run on
            // the raw text, so "/* routine cleanup */ TRUNCATE system_logs" matched the
            // comment instead of the verb, passed the guard, executed and COMMITTED:
            // measured on a clone, system_logs 6085 -> 0 and assessment_history -> 0,
            // while the same statement without the comment was refused.
            const head = this._head(s);
            const bare = head.replace(/'[^']*'/g, "''"); // strip string literals (avoid FPs on normal SQL)
            // 1) Disabling triggers is never allowed from the console.
            if (/\bdisable\s+trigger\b/.test(bare))
                return 'disabling triggers is not allowed from the SQL console.';
            // 1b) session_replication_role = 'replica' turns EVERY ordinary trigger off
            //     for the session without naming one — the append-only guards included.
            //     Measured: `SET session_replication_role='replica'` + a view over
            //     system_logs + `DELETE FROM <view>` returned 200, ok=true, rowCount=1,
            //     and on self_assessment_events the SET alone was enough. Refused for
            //     every spelling that ASSIGNS it (SET, SET LOCAL/SESSION, set_config,
            //     ALTER DATABASE/ROLE/SYSTEM … SET); reading it back is still allowed.
            //     Tested by the SHAPE of an assignment, not by the mere mention of the
            //     name. Reading it back and naming it in prose are legitimate and were
            //     being refused: measured, `-- never SET session_replication_role here`
            //     followed by a plain `SELECT count(*) FROM employees` was refused, and
            //     so was `SELECT current_setting('session_replication_role')` — which
            //     the line above promises is allowed. The name is scanned on the RAW
            //     text so `set_config` is still seen through its string argument.
            //     Comments are removed first — a warning ABOUT the setting is not a use
            //     of it, and refusing a whole script because someone documented the rule
            //     in a `--` line is a guard that costs without protecting.
            const noComment = raw.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
            const SRR_ASSIGN = /\bset(?:\s+(?:local|session))?\s+session_replication_role\b/;
            const SRR_SETCONFIG = /\bset_config\s*\(\s*'?\s*session_replication_role\b/;
            if (SRR_ASSIGN.test(noComment) || SRR_SETCONFIG.test(noComment)) {
                return 'session_replication_role cannot be changed from the SQL console — it would switch off the append-only triggers for the whole session.';
            }
            // 1c) The event trigger added by migration 120 is what refuses DROP TABLE on
            //     an append-only table at the database level. Turning it off from here
            //     would re-open exactly the hole it closes.
            if (/^alter\s+event\s+trigger\b/.test(bare) || /^drop\s+event\s+trigger\b/.test(bare)) {
                return 'event triggers cannot be altered or dropped from the SQL console — one of them is the DDL guard on the append-only tables.';
            }
            // 1d) COPY … TO/FROM PROGRAM runs an ARBITRARY OPERATING-SYSTEM COMMAND as the
            //     account the database server runs under, and the installer ships a
            //     superuser connection. Every guard in this file reasons about SQL; a
            //     shell escape steps around all of them at once — `COPY (SELECT 1) TO
            //     PROGRAM 'psql -c "DROP TABLE self_assessment_events"'` erases the journal
            //     without a single refused statement.
            //     MEASURED on a development database, in a DRY RUN — the mode whose own
            //     label says "no row is saved":
            //       COPY (SELECT '…') TO PROGRAM 'cmd /c more > C:\tmp\witness.txt';
            //     -> ok=true, restorePoint=null, and the file existed on disk afterwards.
            //     The rollback cannot un-run a command that already ran. lo_export is the
            //     same class by a different door: it writes any byte string to any path the
            //     server can reach (a restore point, a source file), so it goes with it.
            //     COPY … TO a server FILE goes with them, for the same reason one step
            //     removed: also measured in a dry run, `COPY (SELECT '…') TO 'C:/tmp/x.csv'`
            //     returned ok=true and the file was on disk. As the database superuser that
            //     writes anywhere the server can reach — a restore-point dump, or this very
            //     file, which would take the guard out at the next restart. Reading a file
            //     IN (`COPY … FROM '<path>'`) stays allowed: it loads rows into the database,
            //     where every other guard on this page still applies. An operator who wants
            //     the rows out has the result grid and the Excel export, both of which reach
            //     the browser rather than the server's disk.
            if (/^copy\b/.test(bare) && /\b(to|from)\s+program\b/.test(bare)) {
                return 'COPY … TO/FROM PROGRAM is never allowed from the SQL console — it runs an operating-system command as the database server and would step around every guard on this page.';
            }
            if (/^copy\b/.test(bare) && /\bto\s+''/.test(bare)) {
                return 'COPY … TO a file on the server is not allowed from the SQL console — it writes outside the database, as the database server, where nothing here can undo it. Use the result grid or the Excel export.';
            }
            if (/\blo_export\s*\(/.test(bare)) {
                return 'lo_export() is never allowed from the SQL console — it writes a file anywhere the database server can reach, outside anything this page can roll back.';
            }
            // 1e) The guard's own machinery. Migration 120 keeps the append-only registry
            //     and the DDL event trigger in a SEPARATE schema (audit_guard) so that a
            //     `DROP SCHEMA public CASCADE` cannot take them along. Nothing protected
            //     the schema from being named directly, and PostgreSQL cannot help here:
            //     MEASURED, in a rolled-back transaction —
            //       DROP SCHEMA audit_guard CASCADE;   -- succeeds: the CASCADE drops the
            //                                          -- event trigger, so it never fires
            //       DROP TABLE self_assessment_events; -- then succeeds, to_regclass NULL
            //     and the shorter road, also measured:
            //       DELETE FROM audit_guard.append_only_registry WHERE table_name='…';
            //       DROP TABLE self_assessment_events; -- succeeds
            //     The console refused the second statement of each pair by name, so the
            //     journal was never reachable THROUGH THIS PAGE — but the page was happy to
            //     disarm the database-level guard that protects it on every OTHER path
            //     (psql, a migration, a third-party tool). Migration 124 closes both at the
            //     database; this closes them at the console, which is the one door a
            //     super-admin who is not trusted with the server can open.
            //     READING the registry stays allowed: migration 120 grants SELECT to PUBLIC
            //     on purpose, and a guard that hides its own state is a guard nobody audits.
            const GUARD_SCHEMA = /\b(audit_guard\b|append_only_registry\b)/;
            const guardDdl =
                /^(drop\s+schema|drop\s+table|drop\s+trigger|alter\s+table|truncate|delete\s+from|update|insert\s+into|merge\s+into|grant|revoke|alter\s+schema|create\s+(?:or\s+replace\s+)?rule|drop\s+rule)\b/.test(
                    bare
                );
            if (guardDdl && GUARD_SCHEMA.test(bare)) {
                return "the append-only guard's own objects (schema audit_guard, table append_only_registry) cannot be modified or dropped from the SQL console — they are what refuses a DROP on the audit trail.";
            }
            if (
                /\b(create|alter|drop|replace)\b/.test(bare) &&
                /\b(function|procedure)\b/.test(bare) &&
                /\b(block_append_only_drop|sync_append_only_registry|on_create_trigger|append_only_tables|block_audit_guard_drop|block_registry_mutation)\b/.test(
                    raw
                )
            ) {
                return 'the append-only guard functions (append_only_tables, sync_append_only_registry, block_append_only_drop, …) cannot be redefined or dropped from the SQL console.';
            }
            // 2) Dynamic SQL (DO/CALL block, EXECUTE, or a dollar-quoted body) that references a
            //    protected audit table — the bypass vector, since the real payload hides inside a
            //    string/quoted body the stripped scan can't see. Scan the RAW text here.
            if ((/\b(do|call|execute)\b/.test(bare) || /\$\$/.test(raw)) && refsProtected(raw)) {
                return `${refsProtected(raw)} cannot be referenced from a DO/EXECUTE dynamic-SQL block.`;
            }
            // 2b) The immutability trigger FUNCTIONS are the control itself: redefining
            //     block_mutation/block_truncate as a no-op would let every later
            //     DELETE/UPDATE/TRUNCATE through without ever naming a protected table.
            if (
                /\b(create|alter|drop|replace)\b/.test(bare) &&
                /\bfunction\b/.test(bare) &&
                /\bblock_(mutation|truncate)\b/.test(raw)
            ) {
                return 'the append-only trigger functions (block_mutation, block_truncate) cannot be redefined from the SQL console.';
            }
            // 2c) A FUNCTION/PROCEDURE BODY is arbitrary SQL that runs later with the same
            //     rights, and it travels as a STRING LITERAL — which `bare` strips before
            //     any test above can read it. Every guard here was therefore blind to it.
            //     MEASURED on a development database (dry run, transaction rolled back), four lines:
            //       CREATE FUNCTION f RETURNS void LANGUAGE sql
            //         AS 'ALTER TABLE system_logs DISABLE TRIGGER ALL';
            //       CREATE FUNCTION g RETURNS void LANGUAGE sql
            //         AS 'DELETE FROM system_logs WHERE id = 12';
            //       SELECT f; SELECT g;
            //     -> ok=TRUE, the audit row went 1 -> 0. With
            //     'ALTER EVENT TRIGGER trg_block_append_only_drop DISABLE' in the first
            //     body, the DROP of an append-only table then succeeded (to_regclass NULL).
            //     Only ROUTINE DEFINITIONS are scanned raw, so an ordinary statement that
            //     merely names a protected table in a comment or a literal still passes.
            if (/^(create|alter)\b/.test(bare) && /\b(function|procedure)\b/.test(bare)) {
                if (/\bdisable\s+trigger\b/.test(raw)) {
                    return 'a function or procedure body cannot disable triggers — it would run later with the same rights and switch the append-only guards off.';
                }
                if (/\b(alter|drop)\s+event\s+trigger\b/.test(raw)) {
                    return 'a function or procedure body cannot alter or drop an event trigger — one of them is the DDL guard on the append-only tables.';
                }
                if (/\bdrop\s+schema\b/.test(raw) && /\b(public|audit_guard)\b/.test(raw)) {
                    return 'a function or procedure body cannot DROP SCHEMA public or audit_guard — it would destroy the audit tables or the guard that protects them.';
                }
                if (/\bdrop\s+(owned|database)\b/.test(raw)) {
                    return 'a function or procedure body cannot DROP OWNED or DROP DATABASE.';
                }
                // Same two doors as 1d/1e, one statement later: a body is arbitrary SQL that
                // runs when someone calls it, with the same rights, and `bare` has already
                // thrown the body away as a string literal. Scanned RAW, like the rest of
                // this block.
                if (/\bcopy\b/.test(raw) && /\b(to|from)\s+program\b/.test(raw)) {
                    return 'a function or procedure body cannot use COPY … TO/FROM PROGRAM — it would run an operating-system command as the database server when called.';
                }
                if (/\bcopy\b/.test(raw) && /\bto\s+'[^']/.test(raw)) {
                    return 'a function or procedure body cannot COPY … TO a file on the server — it would write outside the database when called.';
                }
                if (/\blo_export\s*\(/.test(raw)) {
                    return 'a function or procedure body cannot call lo_export() — it would write a file outside the database when called.';
                }
                if (
                    /\b(delete\s+from|update|truncate|drop\s+table|alter\s+table|insert\s+into)\b/.test(
                        raw
                    ) &&
                    /\bappend_only_registry\b/.test(raw)
                ) {
                    return 'a function or procedure body cannot write to audit_guard.append_only_registry — it is what refuses a DROP on the audit trail.';
                }
                const bodyDdl =
                    /\b(delete\s+from|truncate|update|merge\s+into|drop\s+table|drop\s+trigger|alter\s+table|create\s+(?:or\s+replace\s+)?rule|drop\s+rule|create\s+trigger)\b/.test(
                        raw
                    );
                if (bodyDdl && refsProtected(raw)) {
                    return `${refsProtected(raw)} cannot be written to from a function or procedure body.`;
                }
            }
            // 3) Whole-schema / whole-database destruction removes the audit tables
            //    without naming them, so these are refused unconditionally.
            if (/^drop\s+schema\b/.test(bare) && /\bpublic\b/.test(bare)) {
                return 'DROP SCHEMA public would destroy the audit tables and is never allowed from the SQL console.';
            }
            if (/^drop\s+owned\b/.test(bare))
                return 'DROP OWNED would destroy the audit tables and is never allowed from the SQL console.';
            if (/^drop\s+database\b/.test(bare))
                return 'DROP DATABASE is never allowed from the SQL console.';
            // 4) Direct mutation/DDL of a protected table — or of a relation that IS one
            //    without being named one. `PROTECTED` carries, besides the append-only
            //    tables themselves, every view whose rewrite rules read one (resolved
            //    through pg_depend by the caller): `CREATE VIEW v AS SELECT * FROM
            //    system_logs; DELETE FROM v` deleted a row and reported ok=true, because
            //    the guard only ever looked for the NAME in the text.
            //    CREATE RULE is listed for the same reason in reverse: a rule can send a
            //    DELETE on an innocent table INTO a protected one.
            //    A plain DROP VIEW / ALTER VIEW is deliberately NOT here: a reporting
            //    view built on the audit trail is not the trail, and refusing to let an
            //    operator maintain one would be a guard that costs without protecting.
            const mutatingDdl =
                /^(delete\s+from|truncate|update|merge\s+into|drop\s+table|drop\s+trigger|drop\s+schema|alter\s+table|create\s+(?:or\s+replace\s+)?rule|drop\s+rule|create\s+trigger)\b/.test(
                    bare
                ) ||
                (/^(with|explain)\b/.test(bare) &&
                    /\b(insert\s+into|delete\s+from|truncate|update|merge\s+into|alter\s+table|drop\s+table|drop\s+trigger|drop\s+schema)\b/.test(
                        bare
                    ));
            if (mutatingDdl && refsProtected(bare))
                return `${refsProtected(bare)} cannot be modified.`;

            // 5) …and if THIS statement builds a new relation on top of a protected
            //    one, that relation is protected too from here on.
            const def = DEFINES.exec(bare);
            if (def && refsProtected(bare)) {
                const alias = def[2].replace(/"/g, '').replace(/^public\./, '');
                if (alias && !PROTECTED.includes(alias)) PROTECTED.push(alias);
            }
        }
        return null;
    }

    /** True when PostgreSQL refuses to run the statement inside a transaction block. */
    _cannotRunInTx(stmt) {
        const head = this._head(stmt);
        return /^(vacuum|checkpoint|cluster\s*;?$|cluster\s+(?!\()|create\s+database|drop\s+database|create\s+tablespace|drop\s+tablespace|alter\s+system|reindex\s+.*concurrently|create\s+(unique\s+)?index\s+concurrently|drop\s+index\s+concurrently|discard\s+all)/.test(
            head
        );
    }

    // ---- Secret guard -----------------------------------------------------------
    /**
     * WHY. The console is a SuperAdmin tool, but "SuperAdmin" must not mean
     * "can read every live session cookie, TOTP secret, API-key hash, password
     * hash and SSO secret": `SELECT sess FROM session` was a one-line session
     * hijack of every signed-in user, `SELECT secret_enc FROM mfa_secrets` a
     * second-factor bypass. These relations and columns are refused for READ
     * and WRITE, whoever runs the console.
     *
     * HOW — not a regex over the text. The script is TOKENISED the way
     * PostgreSQL reads it (comments dropped, nested block comments, '…' / E'…' /
     * $tag$…$tag$ strings, "quoted" identifiers kept exact, unquoted folded to
     * lower case, schema-qualified chains), and then:
     *   1. whole relations: SECRET_TABLES, plus every EXISTING view that reads
     *      one of them or a secret column (pg_depend, column-level), plus every
     *      relation the script itself defines on top of one;
     *   2. secret columns anywhere (password_hash, key_hash, token_hash, …) and,
     *      for a table that carries one, the table-specific name (app_settings.
     *      setting_value, webhook_subscriptions.secret, hris_connectors.credentials);
     *   3. whole-row and `*` access to a table that carries a secret column:
     *      refused in any statement that could STORE the row (write, DDL, COPY,
     *      subquery / CTE, routine body) or turn it into one value (row_to_json(a),
     *      `SELECT a FROM admins a`); a TOP-LEVEL `SELECT *` of a pure read is
     *      allowed and its secret cells are masked in the result (maskSecretCells);
     *   4. doors that reach the same data without naming it: pg_read_file & co,
     *      lo_*, dblink*, *_to_xml, ts_stat, current_setting / set_config,
     *      pg_authid / pg_shadow / pg_settings / pg_largeobject, COPY to/from a
     *      server file, SET ROLE / SESSION AUTHORIZATION, CREATE/ALTER ROLE|USER,
     *      CREATE EXTENSION / SERVER / FOREIGN TABLE / USER MAPPING /
     *      PUBLICATION / SUBSCRIPTION, LOAD, untrusted routine languages,
     *      triggers/rules on a secret-bearing table, renaming one;
     *   5. dynamic SQL: DO blocks and routine bodies are tokenised and checked
     *      the same way; an EXECUTE whose SQL is COMPUTED (format(), ||, a
     *      variable) cannot be checked and is refused; an existing routine that
     *      the script CALLS is checked through its pg_proc source and its return
     *      type.
     * Every refusal is audit-logged (SQL_CONSOLE_SECRET_REFUSED). The database
     * role of migration 167 (sqlconsole_reader, when present) is the
     * second, database-side layer — see _consoleReadRole().
     */
    static get SECRET_TABLES() {
        return [
            'session',
            'mfa_secrets',
            'mfa_backup_codes',
            'mfa_used_codes',
            'admin_mfa_enrol_codes',
            'password_reset_tokens',
            'password_history',
            'saml_request_cache',
        ];
    }

    static get SECRET_COLUMNS() {
        return [
            'password_hash',
            'key_hash',
            'token_hash',
            'code_hash',
            'secret_enc',
            'auth_config',
            'webhook_secret',
            'sess',
        ];
    }

    /** Tables that carry a secret column: table → the column(s) that are secret there. */
    static get GUARDED_TABLES() {
        return {
            admins: ['password_hash'],
            employees: ['password_hash'],
            onboarding_requests: ['password_hash'],
            api_keys: ['key_hash'],
            lms_integrations: ['auth_config', 'webhook_secret'],
            safety_gate_settings: ['webhook_secret'],
            webhook_subscriptions: ['secret'],
            app_settings: ['setting_value'],
            // HRIS connector credentials (API tokens, sealed with secretBox).
            hris_connectors: ['credentials'],
        };
    }

    static get FORBIDDEN_RELATIONS() {
        return [
            'pg_authid',
            'pg_shadow',
            'pg_user_mapping',
            'pg_user_mappings',
            'pg_settings',
            'pg_file_settings',
            'pg_hba_file_rules',
            'pg_ident_file_rules',
            'pg_largeobject',
            'pg_largeobject_metadata',
        ];
    }

    static get FORBIDDEN_FUNCTION_RE() {
        return /^(pg_read_file|pg_read_binary_file|pg_ls_[a-z_]+|pg_stat_file|pg_file_[a-z_]+|pg_logdir_ls|lo_[a-z_]+|loread|lowrite|dblink[a-z_]*|current_setting|set_config|query_to_xml[a-z_]*|cursor_to_xml[a-z_]*|table_to_xml[a-z_]*|schema_to_xml[a-z_]*|database_to_xml[a-z_]*|ts_stat)$/;
    }

    /**
     * Tokenise SQL like PostgreSQL's lexer does, as far as the guard needs:
     * { t: 'id', v, q } identifiers (unquoted folded to lower case, "quoted"
     * kept exact), { t: 'str', v } string bodies ('…', E'…', $tag$…$tag$),
     * { t: 'p', v } punctuation/operators, { t: 'num' }, { t: 'param' },
     * { t: 'opaque' } for U&-escaped text the guard refuses to guess at.
     */
    _sqlTokens(text) {
        const s = String(text == null ? '' : text);
        const n = s.length;
        const out = [];
        let i = 0;
        const isIdStart = (c) => /[A-Za-z_\u0080-￿]/.test(c);
        const isIdPart = (c) => /[A-Za-z0-9_$\u0080-￿]/.test(c);
        while (i < n) {
            const c = s[i];
            if (/\s/.test(c)) {
                i++;
                continue;
            }
            if (c === '-' && s[i + 1] === '-') {
                const nl = s.indexOf('\n', i);
                i = nl === -1 ? n : nl + 1;
                continue;
            }
            if (c === '/' && s[i + 1] === '*') {
                // PostgreSQL block comments NEST.
                let depth = 1;
                let j = i + 2;
                while (j < n && depth > 0) {
                    if (s[j] === '/' && s[j + 1] === '*') {
                        depth++;
                        j += 2;
                    } else if (s[j] === '*' && s[j + 1] === '/') {
                        depth--;
                        j += 2;
                    } else j++;
                }
                i = j;
                continue;
            }
            if ((c === 'u' || c === 'U') && s[i + 1] === '&' && /['"]/.test(s[i + 2] || '')) {
                out.push({ t: 'opaque', v: 'U&' });
                i += 2;
                continue;
            }
            if ((c === 'e' || c === 'E') && s[i + 1] === "'") {
                // E'…' — backslash escapes.
                let j = i + 2;
                let v = '';
                while (j < n) {
                    if (s[j] === '\\' && j + 1 < n) {
                        v += s[j + 1];
                        j += 2;
                        continue;
                    }
                    if (s[j] === "'" && s[j + 1] === "'") {
                        v += "'";
                        j += 2;
                        continue;
                    }
                    if (s[j] === "'") {
                        j++;
                        break;
                    }
                    v += s[j++];
                }
                out.push({ t: 'str', v });
                i = j;
                continue;
            }
            if (c === "'") {
                let j = i + 1;
                let v = '';
                while (j < n) {
                    if (s[j] === "'" && s[j + 1] === "'") {
                        v += "'";
                        j += 2;
                        continue;
                    }
                    if (s[j] === "'") {
                        j++;
                        break;
                    }
                    v += s[j++];
                }
                out.push({ t: 'str', v });
                i = j;
                continue;
            }
            if (c === '"') {
                let j = i + 1;
                let v = '';
                while (j < n) {
                    if (s[j] === '"' && s[j + 1] === '"') {
                        v += '"';
                        j += 2;
                        continue;
                    }
                    if (s[j] === '"') {
                        j++;
                        break;
                    }
                    v += s[j++];
                }
                out.push({ t: 'id', v, q: true });
                i = j;
                continue;
            }
            if (c === '$') {
                const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
                if (m) {
                    const tag = m[0];
                    const close = s.indexOf(tag, i + tag.length);
                    const end = close === -1 ? n : close;
                    out.push({ t: 'str', v: s.slice(i + tag.length, end), dollar: true });
                    i = close === -1 ? n : close + tag.length;
                    continue;
                }
                let j = i + 1;
                while (j < n && /[0-9]/.test(s[j])) j++;
                out.push({ t: 'param', v: s.slice(i, j) });
                i = Math.max(j, i + 1);
                continue;
            }
            if (isIdStart(c)) {
                let j = i + 1;
                while (j < n && isIdPart(s[j])) j++;
                out.push({ t: 'id', v: s.slice(i, j).toLowerCase() });
                i = j;
                continue;
            }
            if (/[0-9]/.test(c)) {
                let j = i + 1;
                while (j < n && /[0-9.eE_]/.test(s[j])) j++;
                out.push({ t: 'num', v: s.slice(i, j) });
                i = j;
                continue;
            }
            if (c === ':' && s[i + 1] === ':') {
                out.push({ t: 'p', v: '::' });
                i += 2;
                continue;
            }
            out.push({ t: 'p', v: c });
            i++;
        }
        return out;
    }

    /**
     * The relations the guard treats as secret: the declared tables plus every
     * existing view that (transitively) reads one of them or a secret column.
     * Cached 30 s. A catalog that cannot be read leaves the declared list.
     */
    async _secretRelationContext() {
        const now = Date.now();
        if (this._secretCtxCache && now - this._secretCtxCache.at < 30_000)
            return this._secretCtxCache.ctx;
        const S = SqlConsoleService;
        const secretTables = new Set(S.SECRET_TABLES);
        const colPairs = [];
        for (const [t, cols] of Object.entries(S.GUARDED_TABLES))
            for (const c of cols) colPairs.push(`${t}.${c}`);
        for (const t of S.SECRET_TABLES)
            for (const c of S.SECRET_COLUMNS) colPairs.push(`${t}.${c}`);
        const rows = await this._rawQuery(
            `WITH RECURSIVE dep AS (
                 SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = ANY($1)
                 UNION
                 SELECT r.ev_class
                   FROM pg_rewrite r
                   JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass
                                   AND d.refclassid = 'pg_class'::regclass
                   JOIN pg_class t ON t.oid = d.refobjid
                   JOIN pg_namespace tn ON tn.oid = t.relnamespace AND tn.nspname = 'public'
                   JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                  WHERE (t.relname || '.' || a.attname) = ANY($2)
                 UNION
                 SELECT r.ev_class
                   FROM pg_rewrite r
                   JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass
                                   AND d.refclassid = 'pg_class'::regclass
                   JOIN dep ON dep.oid = d.refobjid
             )
             SELECT c.relname AS rel FROM pg_class c JOIN dep ON dep.oid = c.oid`,
            [S.SECRET_TABLES, colPairs]
        );
        for (const r of rows) if (r && r.rel) secretTables.add(String(r.rel));
        const ctx = { secretTables };
        this._secretCtxCache = { at: now, ctx };
        return ctx;
    }

    /** Catalog read that says when it FAILED (null) instead of pretending "no rows". */
    async _catalogQuery(sql, params = []) {
        try {
            const res = await db.pool.query(sql, params);
            return (res && res.rows) || [];
        } catch (_) {
            return null;
        }
    }

    /**
     * Analyse ONE token stream (a statement, a DO body, a routine body).
     * Returns { reason, relation } for the first violation, or null.
     * `opts.write` = the statement can store what it reads (anything that is not
     * a pure top-level read); `opts.calls` collects called routine names.
     */
    _secretTokenViolation(toks, secretTables, opts = {}) {
        const S = SqlConsoleService;
        const GUARDED = S.GUARDED_TABLES;
        const SECRET_COLS = new Set(S.SECRET_COLUMNS);
        const FORBIDDEN_REL = new Set(S.FORBIDDEN_RELATIONS);
        const FN_RE = S.FORBIDDEN_FUNCTION_RE;
        const write = !!opts.write;
        const calls = opts.calls || new Set();
        const V = (k) => (toks[k] && toks[k].t === 'id' && !toks[k].q ? toks[k].v : null);
        const deny = (reason, relation = null) => ({ reason, relation });

        if (toks.some((t) => t.t === 'opaque'))
            return deny(
                'Unicode-escaped identifiers or strings (U&…) cannot be checked by the SQL console guard.'
            );

        // ---- statement-level doors ------------------------------------------
        const w = [0, 1, 2, 3, 4].map(V);
        const headIs = (...words) => words.every((x, k) => w[k] === x);
        if (
            (w[0] === 'set' || w[0] === 'reset') &&
            (w[1] === 'role' ||
                (w[1] === 'session' && w[2] === 'authorization') ||
                ((w[1] === 'local' || w[1] === 'session') &&
                    (w[2] === 'role' || (w[2] === 'session' && w[3] === 'authorization'))))
        )
            return deny(
                'switching the database role (SET ROLE / SESSION AUTHORIZATION) is not allowed from the SQL console.'
            );
        if (
            (w[0] === 'create' || w[0] === 'alter' || w[0] === 'drop') &&
            (w[1] === 'role' || w[1] === 'user' || w[1] === 'group')
        )
            return deny(
                'database roles, users and user mappings cannot be managed from the SQL console.'
            );
        if (
            headIs('create', 'extension') ||
            headIs('create', 'server') ||
            headIs('alter', 'server') ||
            headIs('create', 'foreign') ||
            headIs('import', 'foreign') ||
            headIs('create', 'publication') ||
            headIs('alter', 'publication') ||
            headIs('create', 'subscription') ||
            headIs('alter', 'subscription') ||
            w[0] === 'load'
        )
            return deny(
                'extensions, foreign servers/tables, replication and LOAD are not allowed from the SQL console — each can read data outside the guarded query path.'
            );
        if (w[0] === 'grant' && toks.some((t) => t.t === 'id' && !t.q && /^pg_/.test(t.v)))
            return deny(
                'granting a built-in pg_* role (server files, all data) is not allowed from the SQL console.'
            );
        if (w[0] === 'create' || w[0] === 'alter') {
            const langAt = toks.findIndex((t, k) => V(k) === 'language');
            if (langAt >= 0) {
                const lang = toks[langAt + 1] ? String(toks[langAt + 1].v).toLowerCase() : '';
                if (/^(c|internal|plpythonu|plpython2u|plpython3u|plperlu|pltclu)$/.test(lang))
                    return deny(
                        `routines in the untrusted language "${lang}" cannot be created from the SQL console.`
                    );
            }
        }
        if (
            w[0] === 'copy' &&
            toks.some((t, k) => t.t === 'str' && (V(k - 1) === 'from' || V(k - 1) === 'to'))
        )
            return deny(
                'COPY to or from a file on the server is not allowed from the SQL console — the server holds the key file (.env) that protects every stored secret.'
            );

        // ---- identifier chains ---------------------------------------------------
        const guardedRefs = new Map(); // name or alias -> table
        const declPos = new Set();
        const RESERVED = new Set(
            'where join on set inner left right full cross natural using group order limit union returning values select from lateral tablesample for window having offset fetch except intersect default only as and or not into do then when with'.split(
                ' '
            )
        );
        let parenDepth = 0;
        const depthAt = [];
        for (let k = 0; k < toks.length; k++) {
            const t = toks[k];
            if (t.t === 'p' && t.v === '(') parenDepth++;
            depthAt[k] = parenDepth;
            if (t.t === 'p' && t.v === ')') parenDepth = Math.max(0, parenDepth - 1);
        }
        for (let k = 0; k < toks.length; k++) {
            const t = toks[k];
            if (t.t !== 'id') continue;
            if (toks[k - 1] && toks[k - 1].t === 'p' && toks[k - 1].v === '.') continue; // mid-chain
            const parts = [t.v];
            let e = k;
            while (
                toks[e + 1] &&
                toks[e + 1].t === 'p' &&
                toks[e + 1].v === '.' &&
                toks[e + 2] &&
                toks[e + 2].t === 'id'
            ) {
                parts.push(toks[e + 2].v);
                e += 2;
            }
            const last = parts[parts.length - 1];
            const next = toks[e + 1];
            const prevWord = V(k - 1);
            const isCall = next && next.t === 'p' && next.v === '(';
            if (FORBIDDEN_REL.has(last))
                return deny(
                    `${last} is a server secret catalog and cannot be read from the SQL console.`,
                    last
                );
            if (isCall) {
                if (FN_RE.test(last))
                    return deny(
                        `${last}() is not allowed from the SQL console — it reads server files, settings or data outside the guarded query path.`,
                        last
                    );
                calls.add(last);
            }
            if (secretTables.has(last)) {
                const kwSession =
                    last === 'session' &&
                    !t.q &&
                    parts.length === 1 &&
                    (prevWord === 'set' ||
                        prevWord === 'reset' ||
                        prevWord === 'show' ||
                        prevWord === 'local' ||
                        V(e + 1) === 'authorization' ||
                        V(e + 1) === 'characteristics');
                if (!kwSession)
                    return deny(
                        `${last} holds secrets (sessions, second factors, tokens, hashes) and cannot be read or written from the SQL console.`,
                        last
                    );
            }
            if (SECRET_COLS.has(last))
                return deny(
                    `the column ${last} holds a secret and cannot be read or written from the SQL console.`,
                    last
                );
            // (`INSERT INTO app_settings (…)` puts a '(' after the name: still a relation.)
            if (Object.prototype.hasOwnProperty.call(GUARDED, last)) {
                guardedRefs.set(last, last);
                for (let x = k; x <= e; x++) declPos.add(x);
                // Alias: `admins a` / `admins AS a`.
                let a = e + 1;
                if (V(a) === 'as') a++;
                const at = toks[a];
                if (at && at.t === 'id' && (at.q || !RESERVED.has(at.v))) {
                    guardedRefs.set(at.v, last);
                    declPos.add(a);
                }
                // Rename / move / re-parent a secret-bearing table: the next
                // statement could read it under a name the guard does not know.
                if (
                    w[0] === 'alter' &&
                    toks.some(
                        (tt, kk) =>
                            ['rename', 'inherit', 'attach'].includes(V(kk)) ||
                            (V(kk) === 'set' && V(kk + 1) === 'schema')
                    )
                )
                    return deny(
                        `${last} carries a secret column and cannot be renamed, moved or re-parented from the SQL console.`,
                        last
                    );
                if (
                    (w[0] === 'create' &&
                        toks.some((tt, kk) => ['trigger', 'rule', 'policy'].includes(V(kk)))) ||
                    w[0] === 'copy'
                )
                    return deny(
                        `${last} carries a secret column: triggers, rules and COPY on it are not allowed from the SQL console.`,
                        last
                    );
            }
        }

        if (guardedRefs.size) {
            const tables = new Set(guardedRefs.values());
            // Table-specific secret columns (app_settings.setting_value, …).
            const specific = new Set();
            for (const tb of tables) for (const c of GUARDED[tb]) specific.add(c);
            for (let k = 0; k < toks.length; k++) {
                const t = toks[k];
                if (t.t === 'id' && specific.has(t.v) && !declPos.has(k))
                    return deny(
                        `the column ${t.v} of ${[...tables].join(', ')} holds a secret and cannot be read or written from the SQL console.`,
                        t.v
                    );
            }
            // INSERT INTO <guarded> without a column list writes every column.
            const insAt = toks.findIndex((t, k) => V(k) === 'insert' && V(k + 1) === 'into');
            if (insAt >= 0) {
                let k = insAt + 2;
                // target chain: ident ('.' ident)*, then an optional `AS alias`
                while (toks[k + 1] && toks[k + 1].t === 'p' && toks[k + 1].v === '.' && toks[k + 2])
                    k += 2;
                const target = toks[k] && toks[k].v;
                k++;
                if (V(k) === 'as') k += 2;
                if (tables.has(target) && !(toks[k] && toks[k].t === 'p' && toks[k].v === '('))
                    return deny(
                        `INSERT INTO ${target} must name its columns — without a list it writes the secret column too.`,
                        target
                    );
            }
            for (let k = 0; k < toks.length; k++) {
                const t = toks[k];
                // `*` as "every column": after SELECT / DISTINCT / ALL / , / RETURNING,
                // after DISTINCT ON (…), or qualified `x.*`.
                if (t.t === 'p' && t.v === '*') {
                    const pv = toks[k - 1];
                    let star = false;
                    let qualifier = null;
                    if (pv && pv.t === 'p' && pv.v === '.') {
                        star = true;
                        qualifier = toks[k - 2] && toks[k - 2].v;
                    } else if (
                        pv &&
                        pv.t === 'id' &&
                        ['select', 'distinct', 'all', 'returning'].includes(pv.v) &&
                        !pv.q
                    ) {
                        star = true;
                    } else if (pv && pv.t === 'p' && pv.v === ',') {
                        star = true;
                    } else if (pv && pv.t === 'p' && pv.v === ')') {
                        let d = 0;
                        let m = k - 1;
                        for (; m >= 0; m--) {
                            if (toks[m].t === 'p' && toks[m].v === ')') d++;
                            else if (toks[m].t === 'p' && toks[m].v === '(') {
                                d--;
                                if (d === 0) break;
                            }
                        }
                        if (V(m - 1) === 'on' && V(m - 2) === 'distinct') star = true;
                    }
                    if (!star) continue;
                    if (qualifier && !guardedRefs.has(qualifier)) continue; // x.* of an unguarded relation
                    if (write || depthAt[k] > 0 || opts.body)
                        return deny(
                            `${[...tables].join(', ')} carries a secret column: "*" is only allowed in a top-level read, never in a statement that stores, nests or wraps the rows.`,
                            [...tables][0]
                        );
                    opts.maskNeeded = true;
                }
                // Whole-row reference: `SELECT a FROM admins a`, row_to_json(a), a::text.
                if (t.t === 'id' && guardedRefs.has(t.v) && !declPos.has(k)) {
                    const nx = toks[k + 1];
                    const pv = toks[k - 1];
                    if (nx && nx.t === 'p' && nx.v === '.') continue; // a.column
                    if (pv && pv.t === 'p' && pv.v === '.') continue;
                    return deny(
                        `${guardedRefs.get(t.v)} carries a secret column: a whole-row reference ("${t.v}") would carry it and is not allowed from the SQL console.`,
                        guardedRefs.get(t.v)
                    );
                }
                // TABLE admins
                if (V(k) === 'table' && k === 0 && toks[1] && tables.has(toks[1].v)) {
                    if (write || opts.body)
                        return deny(`TABLE ${toks[1].v} would carry the secret column.`, toks[1].v);
                    opts.maskNeeded = true;
                }
            }
        }

        // ---- dynamic SQL ---------------------------------------------------------
        const dynamicBody =
            w[0] === 'do' ||
            ((w[0] === 'create' || w[0] === 'alter') &&
                toks.some((t, k) => V(k) === 'function' || V(k) === 'procedure')) ||
            opts.body;
        if (dynamicBody) {
            for (let k = 0; k < toks.length; k++) {
                const t = toks[k];
                if (
                    t.t === 'str' &&
                    !opts.body &&
                    (t.dollar || w[0] === 'do' || V(k - 1) === 'as' || toks[k - 1]?.v === ',')
                ) {
                    const inner = this._sqlTokens(t.v);
                    const r = this._secretTokenViolation(inner, secretTables, {
                        write: true,
                        body: true,
                        calls,
                    });
                    if (r) return r;
                }
                if (opts.body && V(k) === 'execute') {
                    const nx = toks[k + 1];
                    const after = toks[k + 2];
                    const literalOnly =
                        nx &&
                        nx.t === 'str' &&
                        (!after ||
                            (after.t === 'p' && after.v === ';') ||
                            ['using', 'into'].includes(V(k + 2)));
                    if (!literalOnly)
                        return deny(
                            'dynamic SQL built at run time (EXECUTE of a computed string) cannot be checked and is not allowed from the SQL console.'
                        );
                    const r = this._secretTokenViolation(this._sqlTokens(nx.v), secretTables, {
                        write: true,
                        body: true,
                        calls,
                    });
                    if (r) return r;
                }
            }
        }
        return null;
    }

    /**
     * The secret guard over a whole script. Returns { reason, relation } or null.
     * Relations a statement DEFINES on top of a secret one join the secret set
     * for the statements that follow (CREATE VIEW v AS SELECT … FROM session).
     */
    async _secretAccessViolation(stmts, state = {}) {
        const ctx = await this._secretRelationContext();
        const secretTables = new Set(ctx.secretTables);
        const calls = new Set();
        state.maskNeeded = false;
        const DEFINES =
            /^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+|unlogged\s+|global\s+|local\s+)*(?:materialized\s+|recursive\s+)*(?:view|table)\s+(?:if\s+not\s+exists\s+)?([a-z0-9_$."]+)/;
        for (const s of stmts) {
            const toks = this._sqlTokens(s);
            const opts = { write: this._isWrite(s), calls };
            const r = this._secretTokenViolation(toks, secretTables, opts);
            if (r) return r;
            if (opts.maskNeeded) state.maskNeeded = true;
            const def = DEFINES.exec(this._head(s));
            if (def) {
                // Defined on top of a secret relation (already refused) is moot;
                // track the NAME so a later statement cannot launder through it.
                const alias = def[1].replace(/"/g, '').replace(/^public\./, '');
                if (toks.some((t) => t.t === 'id' && secretTables.has(t.v)))
                    secretTables.add(alias);
            }
        }
        // Existing routines the script calls: their body and return type count.
        if (calls.size) {
            const rows = await this._catalogQuery(
                `SELECT p.proname, p.prosrc, rt.typrelid::regclass::text AS returns_rel
                   FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                   LEFT JOIN pg_type rt ON rt.oid = p.prorettype
                  WHERE p.proname = ANY($1) AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
                [[...calls]]
            );
            if (rows === null)
                return {
                    reason: 'the routines this script calls cannot be verified (catalog unavailable) — refused.',
                    relation: null,
                };
            const guardedNames = Object.keys(SqlConsoleService.GUARDED_TABLES);
            for (const r of rows) {
                const rel = r.returns_rel ? String(r.returns_rel).replace(/^public\./, '') : null;
                if (rel && rel !== '-' && (secretTables.has(rel) || guardedNames.includes(rel)))
                    return {
                        reason: `${r.proname}() returns whole rows of ${rel}, which carries a secret column.`,
                        relation: rel,
                    };
                const v = this._secretTokenViolation(
                    this._sqlTokens(r.prosrc || ''),
                    secretTables,
                    {
                        write: true,
                        body: true,
                        calls: new Set(),
                    }
                );
                if (v) return { reason: `${r.proname}() — ${v.reason}`, relation: v.relation };
            }
        }
        return null;
    }

    /**
     * Mask secret cells in a result set (defence in depth, and the reason a
     * top-level `SELECT * FROM employees` stays usable): secret column names,
     * app_settings.setting_value of secret keys, and any value that is a
     * secretBox ciphertext or a password hash.
     */
    maskSecretCells(fields, rows) {
        const S = SqlConsoleService;
        const SECRET_FIELDS = new Set([...S.SECRET_COLUMNS, 'secret', 'credentials']);
        const MASK = '[secret]';
        const fieldList = fields || [];
        const hasKey = fieldList.includes('setting_key');
        let isSecretKey = () => true;
        try {
            isSecretKey = (k) => require('../utils/secretSettingKeys').isSecretKey(k);
        } catch (_) {
            /* keep the fail-closed default */
        }
        const looksSecret = (v) =>
            typeof v === 'string' && /^(enc:v[12]:|\$2[aby]\$\d\d\$|\$argon2)/.test(v);
        return (rows || []).map((row) => {
            if (!row || typeof row !== 'object') return row;
            const out = { ...row };
            for (const f of Object.keys(out)) {
                if (SECRET_FIELDS.has(f) && out[f] != null) out[f] = MASK;
                else if (f === 'setting_value' && out[f] != null && out[f] !== '') {
                    if (!hasKey || isSecretKey(out.setting_key)) out[f] = MASK;
                } else if (looksSecret(out[f])) out[f] = MASK;
            }
            return out;
        });
    }

    /**
     * Optional database-side layer: a read-only role WITHOUT privileges on the
     * secret relations/columns (db/postgres/167_console_reader_role.sql).
     * Pure-read scripts run under it when it exists; absent = unchanged.
     */
    async _consoleReadRole() {
        const name = process.env.SQL_CONSOLE_READ_ROLE || 'sqlconsole_reader';
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) return null;
        const now = Date.now();
        if (this._roleCache && now - this._roleCache.at < 60_000) return this._roleCache.role;
        // Used only when it is really usable HERE: the role exists, the current
        // user may SET ROLE to it, and migration 167 granted it in THIS database
        // (roles are cluster-wide — a role created for another database on the
        // same cluster has no grants here and would make every read fail).
        const rows = await this._rawQuery(
            `SELECT 1 AS ok FROM pg_roles r
              WHERE r.rolname = $1
                AND pg_has_role(current_user, r.oid, 'MEMBER')
                AND has_table_privilege(r.oid, 'public.schema_meta', 'SELECT')`,
            [name]
        );
        const role = rows.length ? name : null;
        this._roleCache = { at: now, role };
        return role;
    }

    // ---- Restore points (pg_dump / pg_restore) ---------------------------------
    _connInfo() {
        const u = new URL(process.env.DATABASE_URL);
        return {
            host: u.hostname || 'localhost',
            port: u.port || '5432',
            user: decodeURIComponent(u.username || 'postgres'),
            password: decodeURIComponent(u.password || ''),
            dbname: (u.pathname || '/').replace(/^\//, ''),
        };
    }

    /** Locate a PostgreSQL client binary (pg_dump / pg_restore). */
    _pgBin(exe) {
        const candidates = [];
        if (process.env.PG_BIN)
            candidates.push(
                path.join(process.env.PG_BIN, exe + '.exe'),
                path.join(process.env.PG_BIN, exe)
            );
        for (const root of [
            'C:\\Program Files\\PostgreSQL',
            'C:\\Program Files (x86)\\PostgreSQL',
        ]) {
            try {
                const versions = fs.readdirSync(root).sort((a, b) => Number(b) - Number(a));
                for (const v of versions) candidates.push(path.join(root, v, 'bin', exe + '.exe'));
            } catch (_) {
                /* root absent */
            }
        }
        for (const c of candidates) {
            try {
                if (fs.existsSync(c)) return c;
            } catch (_) {}
        }
        return exe; // fall back to PATH
    }

    /** A filesystem-safe form of the database this instance is connected to. */
    _dbKey() {
        try {
            const n = this._connInfo().dbname;
            return n ? n.replace(/[^A-Za-z0-9_.-]/g, '_') : 'unknown-database';
        } catch (_) {
            return 'unknown-database';
        }
    }

    /**
     * The shared base directory. %ProgramData% "survives reinstalls" by design, and
     * the installer makes the database NAME a parameter — so two instances on one
     * machine wrote their full dumps into the SAME folder, under names that carry no
     * database at all ({name, sizeBytes, createdAt} and nothing else). Reverting the
     * wrong one would have restored a foreign database over a live one, and the
     * post-restore probe (`SELECT count(*) FROM admins`) would have passed.
     */
    _restoreBaseDir() {
        return (
            process.env.SQL_CONSOLE_BACKUP_DIR ||
            (process.env.ProgramData
                ? path.join(process.env.ProgramData, 'IDevelop', 'sql-restore-points')
                : null) ||
            path.join(path.resolve(__dirname, '..', '..'), 'data', 'sql-restore-points')
        );
    }

    /** Where THIS database's restore points live: one sub-folder per database. */
    /**
     * This database's restore-point folder. Only a WRITE creates it (3.23.18):
     * a read (list / locate) that tried to mkdir answered 500 (EPERM) wherever the
     * account could read the folder but not create it.
     */
    _restoreDir({ create = true } = {}) {
        const dir = path.join(this._restoreBaseDir(), this._dbKey());
        if (create) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** Sidecar that records which database a restore point came from. */
    _sidecarPath(dir, name) {
        return path.join(dir, `${name}.json`);
    }

    _readSidecar(dir, name) {
        try {
            return JSON.parse(fs.readFileSync(this._sidecarPath(dir, name), 'utf8'));
        } catch (_) {
            return null;
        }
    }

    /**
     * The database a dump was really taken from, read from the ARTEFACT — a custom-
     * format dump carries `; dbname: <db>` in its header, so the identity was always
     * there; nothing read it. Returns null when pg_restore cannot read the file.
     */
    async _dumpDatabaseName(file) {
        const r = await this._execFile(this._pgBin('pg_restore'), ['-l', file], {});
        const m = /^;\s*dbname:\s*(\S+)\s*$/m.exec(r.stdout);
        return m ? m[1] : null;
    }

    _execFile(bin, args, env) {
        return new Promise((resolve) => {
            execFile(
                bin,
                args,
                { env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
                (error, stdout, stderr) =>
                    resolve({
                        code: error ? error.code || 1 : 0,
                        stdout: String(stdout || ''),
                        stderr: String(stderr || ''),
                    })
            );
        });
    }

    /** pg_dump the whole live DB to a custom-format file. Returns { name, file, sizeBytes }. */
    async createRestorePoint(label = 'sql-console', opts = {}) {
        const c = this._connInfo();
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const name = `${label}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
        const dir = this._restoreDir();
        const file = path.join(dir, `${name}.dump`);
        const r = await this._execFile(
            this._pgBin('pg_dump'),
            [
                '-h',
                c.host,
                '-p',
                c.port,
                '-U',
                c.user,
                '-d',
                c.dbname,
                '-Fc',
                '--no-owner',
                '--no-privileges',
                '-f',
                file,
            ],
            { PGPASSWORD: c.password }
        );
        if (r.code !== 0)
            throw new Error(
                `Restore point failed (pg_dump exit ${r.code}): ${r.stderr.slice(0, 500)}`
            );
        const sizeBytes = fs.statSync(file).size;
        if (!sizeBytes) throw new Error('Restore point failed: empty dump file.');
        // The identity lives next to the dump so the LIST can show it without paying
        // a pg_restore spawn per file; the dump header stays the authority and is
        // what a revert actually verifies.
        try {
            fs.writeFileSync(
                this._sidecarPath(dir, name),
                JSON.stringify(
                    {
                        database: c.dbname,
                        host: c.host,
                        port: String(c.port),
                        label,
                        createdAt: new Date().toISOString(),
                        sizeBytes,
                    },
                    null,
                    2
                ),
                'utf8'
            );
        } catch (_) {
            /* a missing sidecar degrades the list to "unknown", never to a wrong answer */
        }
        this._pruneRestorePoints(20, opts.protect || null);
        return { name, file, sizeBytes, database: c.dbname };
    }

    /**
     * Restore points visible to this instance: this database's own folder first,
     * then any legacy dump still sitting in the shared root (written before restore
     * points were filed per database). A legacy point's database is NOT guessed —
     * it is reported as null, shown as "—", and verified from the dump header before
     * anything is restored from it.
     */
    listRestorePoints() {
        const mine = this._restoreDir({ create: false });
        const base = this._restoreBaseDir();
        const scan = (dir, scope) => {
            let files = [];
            try {
                files = fs.readdirSync(dir);
            } catch (_) {
                return [];
            }
            return files
                .filter((f) => f.endsWith('.dump'))
                .map((f) => {
                    const name = f.replace(/\.dump$/, '');
                    const st = fs.statSync(path.join(dir, f));
                    const side = this._readSidecar(dir, name);
                    return {
                        name,
                        sizeBytes: st.size,
                        createdAt: st.mtime.toISOString(),
                        // null = not recorded. Never invented, never shown as this database.
                        database: (side && side.database) || null,
                        scope,
                    };
                });
        };
        const out = scan(mine, 'database');
        if (path.resolve(base) !== path.resolve(mine)) {
            const seen = new Set(out.map((r) => r.name));
            for (const rp of scan(base, 'legacy')) if (!seen.has(rp.name)) out.push(rp);
        }
        return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    /** Absolute path of a restore point: this database's folder, else the legacy root. */
    _restorePointFile(name) {
        const mine = path.join(this._restoreDir({ create: false }), name + '.dump');
        if (fs.existsSync(mine))
            return { file: mine, dir: this._restoreDir({ create: false }), scope: 'database' };
        const legacy = path.join(this._restoreBaseDir(), name + '.dump');
        if (fs.existsSync(legacy))
            return { file: legacy, dir: this._restoreBaseDir(), scope: 'legacy' };
        return null;
    }

    _pruneRestorePoints(keep, protectName = null) {
        // Restore points are full UNENCRYPTED DB dumps (all PII). Cap by BOTH count
        // and AGE so old copies don't linger at rest: keep the newest `keep`, and
        // additionally delete anything older than SQL_CONSOLE_RESTORE_MAX_AGE_DAYS
        // (default 7 — they are short-lived safety nets, not archives).
        //
        // ONLY THIS DATABASE'S OWN FOLDER IS PRUNED. The old code walked the shared
        // %ProgramData% directory, so one instance's 21st restore point deleted
        // another instance's safety net — and a legacy dump of unknown origin was
        // deleted on age alone. Anything we cannot prove is ours is left alone; it is
        // listed as "—" instead, so an operator can see it and decide.
        const dirOf = (rp) =>
            rp.scope === 'database' ? this._restoreDir() : this._restoreBaseDir();
        const mine = this.listRestorePoints().filter((r) => r.scope === 'database');
        const maxAgeDays = Number(process.env.SQL_CONSOLE_RESTORE_MAX_AGE_DAYS) || 7;
        const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
        const doomed = new Map(mine.slice(keep).map((r) => [r.name, r]));
        for (const rp of mine)
            if (new Date(rp.createdAt).getTime() < cutoff) doomed.set(rp.name, rp);
        doomed.delete(protectName);
        for (const rp of doomed.values()) {
            const dir = dirOf(rp);
            try {
                fs.unlinkSync(path.join(dir, rp.name + '.dump'));
            } catch (_) {}
            try {
                fs.unlinkSync(this._sidecarPath(dir, rp.name));
            } catch (_) {}
        }
    }

    // ---- Append-only preservation across a revert ------------------------------
    /**
     * WHY THIS EXISTS
     * ---------------
     * `pg_restore --clean` drops and recreates every table in the dump — including
     * system_logs (the hash-chained audit trail), assessment_history and
     * review_signatures. So a plain revert erased exactly the three tables the SQL
     * editor above refuses to let anyone write to: the tamper guard said "append-only"
     * while the Revert button next to it rewrote HR history in one click.
     *
     * The revert now brackets the restore:
     *   1. copy the three tables into a per-revert quarantine schema (a fresh name
     *      that CANNOT appear in any older dump, so pg_restore --clean can't drop it);
     *   2. pg_restore as before — operational data really does go back;
     *   3. re-attach every preserved row the restore removed, verbatim (the hash-chain
     *      trigger is suspended for the re-insert so prev_hash/row_hash are carried
     *      across byte-for-byte and the chain still verifies);
     *   4. drop the quarantine only when every row is back. Rows that cannot be
     *      re-attached — their subject was deleted by the revert, so the FK has no
     *      parent — STAY in the quarantine schema and are reported. Nothing is
     *      silently dropped.
     * The revert's own audit entry is written BEFORE step 1, so step 3 carries it
     * back: the record that a revert happened survives the revert.
     */
    _quarantinePrefix() {
        return 'audit_preserve_';
    }

    /**
     * Protected tables that actually exist in this install — the declared list UNION
     * what the database itself guards. The union is the point: self_assessment_events
     * carried the append-only triggers since migration 116 and was missing from the
     * declared list, so the quarantine held 3 tables while the database guarded 4 and
     * a revert would have rolled that fourth journal back (pg_restore --clean drops
     * and recreates it; `pg_restore -l` of a real point shows both the TABLE and its
     * TABLE DATA entry).
     */
    async _existingProtectedTables(client) {
        const declared = this.PROTECTED_TABLES;
        let live = [];
        try {
            const r = await client.query(`SELECT DISTINCT c.relname
                  FROM pg_trigger t
                  JOIN pg_class c ON c.oid = t.tgrelid
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                  JOIN pg_proc p ON p.oid = t.tgfoid
                 WHERE n.nspname = 'public' AND NOT t.tgisinternal
                   AND p.proname IN ('block_mutation', 'block_truncate')`);
            live = r.rows.map((x) => x.relname);
        } catch (_) {
            /* older database: the declared list still applies */
        }
        const wanted = [...new Set([...declared, ...live])];
        const { rows } = await client.query(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
            [wanted]
        );
        return rows.map((r) => r.relname);
    }

    /**
     * Turn migration 120's DDL guard (trg_block_append_only_drop) off or on. The ONE
     * legitimate reason to lift it is pg_restore --clean during a revert, which must
     * drop and recreate every table in the dump; the caller always restores it in a
     * finally. Silently tolerant on databases that predate migration 120.
     */
    async _setDropGuard(enabled) {
        // BOTH sql_drop guards, not just the first. Migration 124 adds a second one in
        // the public schema whose only job is to refuse the drop of the audit_guard
        // schema — a DROP SCHEMA audit_guard CASCADE took its own trigger down with it
        // and therefore never fired (measured). pg_restore --clean drops every object
        // in the dump, the audit_guard ones included, so leaving that second trigger
        // armed would make a revert fail part-way: the two are lifted and restored
        // together.
        const NAMES = ['trg_block_append_only_drop', 'trg_block_audit_guard_drop'];
        let present = [];
        try {
            const r = await db.pool.query(
                'SELECT evtname FROM pg_event_trigger WHERE evtname = ANY($1)',
                [NAMES]
            );
            present = r.rows.map((x) => x.evtname);
        } catch (_) {
            return 'unknown';
        }
        if (!present.length) return 'absent'; // pre-120 database, or the role could not install it
        try {
            for (const n of present) {
                await db.pool.query(`ALTER EVENT TRIGGER ${n} ${enabled ? 'ENABLE' : 'DISABLE'}`);
            }
            return enabled ? 'enabled' : 'disabled';
        } catch (e) {
            // Owned by another role (installed by a superuser, app runs as the app
            // role). Saying so is the whole point: proceeding would let pg_restore
            // --clean hit the guard mid-restore and leave the database half-restored.
            return 'failed:' + e.message;
        }
    }

    /** Quarantine schemas left behind by an earlier, incompletely re-attached revert. */
    async _leftoverQuarantines(client) {
        const { rows } = await client.query(
            'SELECT nspname FROM pg_namespace WHERE nspname LIKE $1 ORDER BY nspname',
            [this._quarantinePrefix() + '%']
        );
        return rows.map((r) => r.nspname);
    }

    /** Snapshot the append-only tables into a fresh quarantine schema. */
    async _preserveAuditTables(client) {
        const stamp = new Date()
            .toISOString()
            .replace(/[^0-9]/g, '')
            .slice(0, 14);
        const suffix = Math.random()
            .toString(36)
            .replace(/[^a-z0-9]/g, '')
            .slice(0, 4)
            .padEnd(4, '0');
        const schema = `${this._quarantinePrefix()}${stamp}_${suffix}`;
        const tables = await this._existingProtectedTables(client);
        await client.query(`CREATE SCHEMA "${schema}"`);
        const counts = {};
        for (const t of tables) {
            // CREATE TABLE AS copies rows only — no triggers, no constraints — so the
            // append-only guard is never reached and the copy always succeeds.
            await client.query(`CREATE TABLE "${schema}"."${t}" AS TABLE public."${t}"`);
            const r = await client.query(`SELECT count(*)::int AS n FROM "${schema}"."${t}"`);
            counts[t] = r.rows[0].n;
        }
        return { schema, tables, counts };
    }

    /** Column names present in BOTH the restored table and its quarantined copy. */
    async _commonColumns(client, schema, table) {
        const { rows } = await client.query(
            `SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
               AND EXISTS (SELECT 1 FROM pg_attribute b
                           WHERE b.attrelid = to_regclass($2) AND b.attnum > 0
                             AND NOT b.attisdropped AND b.attname = a.attname)
             ORDER BY a.attnum`,
            [`public.${table}`, `"${schema}"."${table}"`]
        );
        return rows.map((r) => r.attname);
    }

    async _quarantineColumns(client, schema, table) {
        const { rows } = await client.query(
            `SELECT attname FROM pg_attribute
             WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
            [`"${schema}"."${table}"`]
        );
        return rows.map((r) => r.attname);
    }

    /**
     * Re-insert every preserved row the restore removed. Returns a per-table report:
     *   { preserved, missingAfterRestore, reattached, unreattachable:[{id,error}], droppedColumns }
     */
    async _reattachAuditTables(client, preserved) {
        // The hash-chain trigger recomputes prev_hash/row_hash on INSERT. Suspend it so
        // preserved rows keep their ORIGINAL hashes and the chain still verifies; the
        // append-only trigger itself is BEFORE DELETE OR UPDATE only, so INSERT is fine.
        const chainTriggers = (
            await client.query(
                `SELECT c.relname AS tbl, t.tgname FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE n.nspname = 'public' AND NOT t.tgisinternal AND p.proname = 'fn_system_logs_hashchain'`
            )
        ).rows;
        const suspend = async () => {
            for (const { tbl, tgname } of chainTriggers)
                await client.query(`ALTER TABLE public."${tbl}" DISABLE TRIGGER "${tgname}"`);
        };
        const resume = async () => {
            for (const { tbl, tgname } of chainTriggers)
                await client.query(`ALTER TABLE public."${tbl}" ENABLE TRIGGER "${tgname}"`);
        };

        // Plan (read-only): which rows are missing, which columns can be carried.
        const plan = [];
        const report = {};
        for (const t of preserved.tables) {
            const cols = await this._commonColumns(client, preserved.schema, t);
            const qCols = await this._quarantineColumns(client, preserved.schema, t);
            const missing = (
                await client.query(
                    `SELECT p.id FROM "${preserved.schema}"."${t}" p
                 WHERE NOT EXISTS (SELECT 1 FROM public."${t}" x WHERE x.id = p.id) ORDER BY p.id`
                )
            ).rows.map((r) => r.id);
            report[t] = {
                preserved: preserved.counts[t],
                missingAfterRestore: missing.length,
                reattached: 0,
                unreattachable: [],
                // The restore point may predate a migration that added columns; those
                // values cannot be carried into the older table shape.
                droppedColumns: qCols.filter((c) => !cols.includes(c)),
            };
            plan.push({ table: t, cols, missing });
        }
        const anyMissing = plan.some((p) => p.missing.length);
        if (!anyMissing) return report;

        const list = (cols) => cols.map((c) => `"${c}"`).join(', ');
        const bulkSql = (p) =>
            `INSERT INTO public."${p.table}" (${list(p.cols)})` +
            ` SELECT ${list(p.cols)} FROM "${preserved.schema}"."${p.table}" q` +
            ` WHERE NOT EXISTS (SELECT 1 FROM public."${p.table}" x WHERE x.id = q.id) ORDER BY q.id`;

        // Fast path: one transaction for everything. Either the whole audit tail comes
        // back or nothing changes and we fall through to the row-by-row pass.
        let bulkOk = true;
        await client.query('BEGIN');
        try {
            await suspend();
            for (const p of plan) {
                if (!p.missing.length) continue;
                const res = await client.query(bulkSql(p));
                report[p.table].reattached = res.rowCount;
            }
            await resume();
            await client.query('COMMIT');
        } catch (_) {
            bulkOk = false;
            try {
                await client.query('ROLLBACK');
            } catch (__) {
                /* ignore */
            }
            for (const p of plan) report[p.table].reattached = 0;
        }

        // Slow path: re-attach row by row so ONE unattachable row (its employee/skill/
        // review was deleted by the revert, so its FK has no parent) cannot cost us the
        // rest of the audit tail. Survivors are re-inserted; the rest are named.
        if (!bulkOk) {
            await client.query('BEGIN');
            try {
                await suspend();
                for (const p of plan) {
                    for (const id of p.missing) {
                        await client.query('SAVEPOINT reattach_row');
                        try {
                            await client.query(
                                `INSERT INTO public."${p.table}" (${list(p.cols)})` +
                                    ` SELECT ${list(p.cols)} FROM "${preserved.schema}"."${p.table}" WHERE id = $1`,
                                [id]
                            );
                            await client.query('RELEASE SAVEPOINT reattach_row');
                            report[p.table].reattached += 1;
                        } catch (e) {
                            await client.query('ROLLBACK TO SAVEPOINT reattach_row');
                            report[p.table].unreattachable.push({
                                id: String(id),
                                error: e.message,
                            });
                        }
                    }
                }
                await resume();
                await client.query('COMMIT');
            } catch (e) {
                try {
                    await client.query('ROLLBACK');
                } catch (__) {
                    /* ignore */
                }
                throw new Error(
                    `Audit re-attachment failed: ${e.message}. The preserved audit rows are intact in schema "${preserved.schema}".`
                );
            }
        }

        // Re-inserting explicit ids leaves the restored sequence behind the max id;
        // without this the next audit INSERT would collide on the primary key.
        for (const p of plan) {
            if (!report[p.table].reattached) continue;
            await client.query(
                `SELECT CASE WHEN pg_get_serial_sequence('public.${p.table}', 'id') IS NOT NULL
                             THEN setval(pg_get_serial_sequence('public.${p.table}', 'id'),
                                         GREATEST(COALESCE((SELECT max(id) FROM public."${p.table}"), 1), 1))
                        END`
            );
        }
        return report;
    }

    /**
     * Revert the live DB to a restore point (pg_restore --clean --if-exists) WITHOUT
     * rolling back the append-only audit tables — see _quarantinePrefix above for
     * the full rationale and sequence.
     *
     * pg_restore exits 1 on ignorable warnings (e.g. extension objects), so we verify
     * success by re-querying the DB afterwards rather than by exit code.
     */
    async revertRestorePoint(name, opts = {}) {
        if (!/^[A-Za-z0-9._-]+$/.test(String(name))) throw new Error('Invalid restore point name.');
        const located = this._restorePointFile(name);
        if (!located) throw new Error(`Restore point "${name}" not found.`);
        const file = located.file;
        const actor = opts.actor || {};

        // --- 1. Preflight + preserve ------------------------------------------
        let preserved;
        let client = await db.pool.connect();
        try {
            const leftovers = await this._leftoverQuarantines(client);
            if (leftovers.length) {
                throw new Error(
                    `Refusing to revert: audit rows from an earlier revert are still quarantined in ${leftovers.join(', ')} ` +
                        '(they could not be re-attached because the rows they describe no longer exist). Reconcile or archive ' +
                        'that schema first — reverting again would stack a second unreconciled copy of the audit trail on top of it.'
                );
            }
        } finally {
            client.release();
        }

        // --- 1b. WHERE DOES THIS FILE COME FROM? -------------------------------
        // The restore-point folder used to be shared by every instance on the
        // machine and the listing carried no database at all, so the wrong file was
        // one click away — and the post-restore probe (`count(*) FROM admins`) would
        // have passed happily on a FOREIGN database of the same shape. The dump's own
        // header says where it came from; it is read BEFORE pg_restore touches
        // anything, and a mismatch — or a header we cannot read — stops the revert.
        const c = this._connInfo();
        const origin = await this._dumpDatabaseName(file);
        if (!origin) {
            throw new Error(
                `Refusing to revert: "${name}" is not a readable PostgreSQL custom-format dump ` +
                    '(its archive header could not be read), so its origin cannot be verified.'
            );
        }
        if (origin !== c.dbname) {
            throw new Error(
                `Refusing to revert: restore point "${name}" was taken from database "${origin}", ` +
                    `and this instance is connected to "${c.dbname}". Restoring it would overwrite one database with another.`
            );
        }

        // --- 1c. A safety net for the safety net -------------------------------
        // Reverting is itself destructive and had NO backup of the state it replaces.
        // Take one first; it is excluded from its own pruning so it cannot be the file
        // the prune removes, and the point being reverted to is protected as well.
        let preRevert = null;
        try {
            preRevert = await this.createRestorePoint('pre-revert', { protect: name });
        } catch (e) {
            throw new Error(
                `Refusing to revert: could not back up the CURRENT database state first. ${e.message}`
            );
        }

        client = await db.pool.connect();
        try {
            // Written BEFORE the snapshot on purpose: the snapshot carries this entry
            // over the restore, so the audit trail of the revert itself survives it.
            await LogService.log({
                adminId: actor.adminId || null,
                action: 'SQL_CONSOLE_REVERT_STARTED',
                entityType: 'database',
                details:
                    `Reverting database "${c.dbname}" to restore point "${name}" (verified origin: ${origin}). ` +
                    `Current state backed up as "${preRevert.name}". ` +
                    `Append-only tables (${(await this.resolvedProtectedTables()).join(', ')}) are preserved across the restore.`,
                severity: 'critical',
                category: 'security',
                ipAddress: actor.ipAddress || null,
                userAgent: actor.userAgent || null,
            });
            preserved = await this._preserveAuditTables(client);
        } finally {
            client.release();
        }

        // --- 2. Restore --------------------------------------------------------
        // pg_restore --clean DROPS every table in the dump, and migration 120's event
        // trigger refuses to let an append-only table be dropped. This is the one
        // legitimate caller: the guard is lifted for the length of the restore only,
        // and always put back (finally) — the rows themselves are already quarantined.
        const lifted = await this._setDropGuard(false);
        if (String(lifted).startsWith('failed:')) {
            throw new Error(
                'Refusing to revert: the append-only DDL guard (event trigger ' +
                    'trg_block_append_only_drop) could not be lifted for the restore, so pg_restore --clean would ' +
                    'fail part-way and leave the database half-restored. Nothing was changed. ' +
                    `Disable it as its owner and retry. PostgreSQL said: ${String(lifted).slice(7)}`
            );
        }
        let r;
        let restored = 'absent';
        try {
            r = await this._execFile(
                this._pgBin('pg_restore'),
                [
                    '-h',
                    c.host,
                    '-p',
                    c.port,
                    '-U',
                    c.user,
                    '-d',
                    c.dbname,
                    '--clean',
                    '--if-exists',
                    '--no-owner',
                    '--no-privileges',
                    file,
                ],
                { PGPASSWORD: c.password }
            );
        } finally {
            if (lifted === 'disabled') restored = await this._setDropGuard(true);
        }
        // Sanity probe: the DB must answer and core tables must exist.
        let probeOk = false;
        try {
            const p = await db.get('SELECT count(*)::int AS n FROM admins');
            probeOk = p && p.n >= 0;
        } catch (_) {
            probeOk = false;
        }
        if (!probeOk) {
            throw new Error(
                `Revert may have failed — the database did not answer the sanity probe. The append-only audit rows ` +
                    `are preserved in schema "${preserved.schema}" and were NOT re-attached. pg_restore said: ${r.stderr.slice(0, 500)}`
            );
        }

        // --- 3. Re-attach the audit trail --------------------------------------
        let audit;
        client = await db.pool.connect();
        try {
            // pg_restore dropped and recreated the tables under this pooled connection's
            // feet; clear cached plans so the re-attach doesn't hit a stale one.
            try {
                await client.query('DISCARD ALL');
            } catch (_) {
                /* not fatal */
            }
            audit = await this._reattachAuditTables(client, preserved);
        } finally {
            client.release();
        }

        // --- 4. Drop the quarantine only when every row made it back ------------
        const unresolved = Object.values(audit).reduce((n, t) => n + t.unreattachable.length, 0);
        if (!unresolved) {
            const dropClient = await db.pool.connect();
            try {
                await dropClient.query(`DROP SCHEMA "${preserved.schema}" CASCADE`);
            } finally {
                dropClient.release();
            }
        }

        const reattached = Object.values(audit).reduce((n, t) => n + t.reattached, 0);
        await LogService.log({
            adminId: actor.adminId || null,
            action: 'SQL_CONSOLE_REVERT_AUDIT_PRESERVED',
            entityType: 'database',
            details:
                `Restore point "${name}" (from database "${origin}") applied to "${c.dbname}". ` +
                `${reattached} append-only audit row(s) re-attached after the restore` +
                (unresolved
                    ? `; ${unresolved} row(s) could NOT be re-attached (their subject no longer exists after the revert) and are kept in schema "${preserved.schema}".`
                    : ' (none lost); quarantine schema dropped.'),
            severity: unresolved ? 'critical' : 'warn',
            category: 'security',
            ipAddress: actor.ipAddress || null,
            userAgent: actor.userAgent || null,
        });

        // A guard that was lifted and did NOT come back is not a detail: say it here,
        // and say it in the audit trail, rather than leaving the database unguarded
        // and the operator unaware.
        const guardWarning =
            lifted === 'disabled' && restored !== 'enabled'
                ? [
                      `The append-only DDL guard (trg_block_append_only_drop) was lifted for the restore and could NOT be re-enabled (${restored}). Re-enable it: ALTER EVENT TRIGGER trg_block_append_only_drop ENABLE;`,
                  ]
                : [];
        if (guardWarning.length) {
            await LogService.log({
                adminId: actor.adminId || null,
                action: 'SQL_CONSOLE_REVERT_DDL_GUARD_NOT_RESTORED',
                entityType: 'database',
                details: guardWarning[0],
                severity: 'critical',
                category: 'security',
                ipAddress: actor.ipAddress || null,
                userAgent: actor.userAgent || null,
            });
        }

        // 3.23.18: a revert rolls the database back past later erasures — re-apply
        // every erasure tombstone so an erased person never comes back. A failure
        // is surfaced as a warning (the revert itself already happened).
        let erasures = null;
        try {
            erasures = await require('./DSRService').reapplyTombstones({
                actorAdminId: actor.adminId || null,
                source: 'SQL console revert ' + name,
            });
        } catch (e) {
            guardWarning.push(
                `Erasures could not be re-applied after the revert (${e.message}). Run: node scripts/reapply-erasures.js`
            );
        }

        return {
            name,
            database: c.dbname,
            verifiedOrigin: origin,
            erasuresReapplied: erasures,
            preRevertRestorePoint: preRevert ? preRevert.name : null,
            warnings: guardWarning.concat(
                r.code !== 0 ? r.stderr.split('\n').filter(Boolean).slice(-8) : []
            ),
            auditPreservation: {
                tables: audit,
                reattached,
                unreattachable: unresolved,
                quarantineSchema: unresolved ? preserved.schema : null,
            },
        };
    }

    // ---- Raw SQL execution ---------------------------------------------------
    /**
     * Execute a raw SQL script.
     *  - Scripts of transaction-safe statements run in ONE transaction (all-or-
     *    nothing); dryRun always rolls back.
     *  - Scripts containing statements PostgreSQL forbids inside a transaction
     *    (VACUUM, CREATE DATABASE, CREATE INDEX CONCURRENTLY, ALTER SYSTEM, …)
     *    run statement-by-statement in autocommit; these cannot be dry-run.
     *  - Before ANY database-changing script (non-dry-run), a pg_dump restore
     *    point is created automatically; a failed autocommit script is
     *    auto-reverted from it. "Database-changing" is decided by _writeAnalysis,
     *    which asks PostgreSQL about function volatility instead of trusting the
     *    leading verb — `SELECT some_function_that_deletes` committed 25 deletions
     *    with restorePoint = null before that.
     */
    async execute(sqlText, { dryRun = false, actor = null } = {}) {
        const result = {
            ok: false,
            dryRun: !!dryRun,
            statements: [],
            error: null,
            stripped: [],
            restorePoint: null,
            autoReverted: false,
            auditPreservation: null,
            mode: 'transaction',
            warnings: [],
        };
        const raw = String(sqlText || '').trim();
        if (!raw) {
            result.error = 'Empty script.';
            return result;
        }

        // The console owns the transaction — remove any pasted BEGIN/COMMIT/ROLLBACK
        // so an embedded COMMIT can't defeat dry-run rollback or the atomic wrapper.
        const { clean, stripped } = this._stripTxControl(raw);
        result.stripped = stripped;
        const text = clean.trim();
        if (!text) {
            result.error = 'Nothing to run (only transaction-control statements were provided).';
            return result;
        }

        const stmts = this._splitStatements(text);

        // Tamper guard: the SQL console is the one in-app path that could disable the
        // append-only audit triggers or rewrite the audit trail. Refuse any statement
        // that disables a trigger, or mutates/DDLs the immutable audit tables — so a
        // rogue/compromised superadmin can't quietly rewrite HR history through here.
        // The set the guard enforces is resolved, not recited: the declared list, plus
        // every table the DATABASE guards (so a migration cannot leave the console
        // behind), plus every existing view built on one of them (so a statement that
        // never spells the name is still recognised by what it reaches).
        const protectedTables = await this.resolvedProtectedTables();
        const protectedNames = [
            ...protectedTables,
            ...(await this._protectedRelationAliases(protectedTables)),
        ];
        const tamper = this._auditTamperViolation(stmts, protectedNames);
        if (tamper) {
            result.error = `Refused: ${tamper} The audit trail (${protectedTables.join(', ')}) is append-only and cannot be altered from the SQL console — reverting a restore point does not erase it either.`;
            return result;
        }

        // Secret guard: sessions, second factors, tokens, hashes and stored
        // secrets are never read or written from here — refused before anything
        // runs, and the refusal is audited on its own line.
        const secretState = {};
        const secret = await this._secretAccessViolation(stmts, secretState);
        if (secret) {
            result.error = `Refused: ${secret.reason} Secrets are managed only from their own pages (sessions, MFA, API keys, SSO, settings).`;
            result.errorCode = 'secret_refused';
            result.refusedRelation = secret.relation || null;
            try {
                await LogService.log({
                    adminId: actor && actor.adminId ? actor.adminId : null,
                    action: 'SQL_CONSOLE_SECRET_REFUSED',
                    entityType: 'database',
                    details: `SQL console refused a statement touching secret data${secret.relation ? ` (${secret.relation})` : ''}: ${secret.reason}`,
                    severity: 'warning',
                    ipAddress: actor && actor.ipAddress,
                    userAgent: actor && actor.userAgent,
                });
            } catch (_) {
                /* audit best-effort — the refusal stands either way */
            }
            return result;
        }

        const { hasWrite, volatileCalls } = await this._writeAnalysis(stmts);
        // Said out loud rather than assumed away: a script whose only statements are
        // SELECTs can still write, and a dry run's ROLLBACK does not un-consume a
        // sequence value. The page said "nothing is saved"; it now names what is.
        if (volatileCalls.length)
            result.warnings.push({ code: 'volatile_calls', functions: volatileCalls });
        const noTx = stmts.some((s) => this._cannotRunInTx(s));
        result.mode = noTx ? 'autocommit' : 'transaction';

        if (noTx && dryRun) {
            result.error =
                'This script contains statements PostgreSQL cannot run inside a transaction ' +
                '(e.g. VACUUM, CREATE DATABASE, CREATE INDEX CONCURRENTLY, ALTER SYSTEM), so it cannot be ' +
                'previewed with a dry run. Uncheck “Dry run” to execute — a restore point is created first ' +
                'and the script is automatically reverted if a statement fails.';
            return result;
        }

        // Safety net: restore point before anything that changes the database.
        if (hasWrite && !dryRun) {
            try {
                result.restorePoint = await this.createRestorePoint('sql-console');
            } catch (e) {
                result.error = `Refusing to run: could not create the automatic restore point. ${e.message}`;
                return result;
            }
        }

        const pushParts = (res) => {
            const parts = Array.isArray(res) ? res : [res];
            for (const r of parts) {
                const fields = (r.fields || []).map((f) => f.name);
                result.statements.push({
                    command: r.command || null,
                    rowCount: typeof r.rowCount === 'number' ? r.rowCount : null,
                    fields,
                    // Secret cells never leave the server (see maskSecretCells).
                    rows: this.maskSecretCells(fields, (r.rows || []).slice(0, 200)),
                    rowsTruncated: (r.rows || []).length > 200,
                });
            }
        };
        const readRole = !hasWrite ? await this._consoleReadRole() : null;

        if (!noTx) {
            // Transactional path: one BEGIN…COMMIT around the whole script.
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                // Pure reads run under the restricted role when the database has it.
                if (readRole) await client.query(`SET LOCAL ROLE "${readRole}"`);
                // No parameters → simple query protocol, which allows multiple statements
                // separated by ';' and returns an array of per-statement results.
                const res = await client.query(text);
                pushParts(res);
                if (dryRun) {
                    await client.query('ROLLBACK');
                } else {
                    await client.query('COMMIT');
                }
                result.ok = true;
            } catch (e) {
                try {
                    await client.query('ROLLBACK');
                } catch (_) {
                    /* ignore */
                }
                result.error = e.message;
                result.errorDetail = { code: e.code, position: e.position };
                // Pure reads run under the restricted role (migration 167): a « * » over
                // a table that holds a secret column is refused by PostgreSQL itself.
                if (e.code === '42501') result.errorCode = 'column_privilege';
            } finally {
                client.release();
            }
            return result;
        }

        // Autocommit path: one client.query per statement (a multi-statement simple
        // query runs in an implicit transaction, which those statements forbid).
        const client = await db.pool.connect();
        let failedAt = -1;
        try {
            for (let i = 0; i < stmts.length; i++) {
                try {
                    const res = await client.query(stmts[i]);
                    pushParts(res);
                } catch (e) {
                    failedAt = i;
                    result.error = `Statement #${i + 1} failed: ${e.message}`;
                    result.errorDetail = {
                        code: e.code,
                        position: e.position,
                        statement: stmts[i].slice(0, 300),
                    };
                    break;
                }
            }
        } finally {
            client.release();
        }

        if (failedAt === -1) {
            result.ok = true;
            return result;
        }

        // A statement failed mid-script with earlier statements already committed —
        // automatically revert to the restore point taken before the run.
        if (result.restorePoint) {
            try {
                const rev = await this.revertRestorePoint(result.restorePoint.name, { actor });
                result.autoReverted = true;
                result.auditPreservation = rev.auditPreservation;
            } catch (e) {
                result.error += ` — AUTOMATIC REVERT FAILED (${e.message}). Revert manually from restore point "${result.restorePoint.name}".`;
            }
        }
        return result;
    }

    async generateFromExcelFile(filepath) {
        const workbook = new ExcelJS.Workbook();
        require('../utils/importGuards').assertSafeXlsxFile(filepath); // zip-bomb guard (SA-09)
        await workbook.xlsx.readFile(filepath);
        return this.generateFromWorkbook(workbook);
    }
}

module.exports = new SqlConsoleService();
