const SnapshotModel = require('../models/SnapshotModel');
const db = require('../config/database');
const fs = require('fs');
const path = require('path');

class SnapshotService {
    /** A settings row that holds a secret (by key, or because its value is sealed). */
    static isSecretSetting(row) {
        if (!row) return false;
        const key = row.settingKey != null ? row.settingKey : row.setting_key;
        const val = row.settingValue != null ? row.settingValue : row.setting_value;
        const AppSettingsModel = require('../models/AppSettingsModel');
        return (
            AppSettingsModel.isSecretKey(
                key,
                row.settingType != null ? row.settingType : row.setting_type
            ) ||
            require('../utils/secretBox').isEncrypted(val) ||
            val === AppSettingsModel.SECRET_MASK
        );
    }

    static withoutSecretSettings(rows) {
        return Array.isArray(rows) ? rows.filter((r) => !SnapshotService.isSecretSetting(r)) : rows;
    }

    /**
     * Put the live secret rows back after the wipe, exactly as they were
     * (sealed value included). No id: the snapshot's own rows own the ids, and
     * the secret row keeps its key, which is what everything reads by.
     */
    async _restoreLiveSecretSettings(rows) {
        for (const r of rows || []) {
            const row = { ...r };
            delete row.id;
            delete row.updatedByUsername;
            await db.run('DELETE FROM app_settings WHERE setting_key = ?', [
                row.settingKey != null ? row.settingKey : row.setting_key,
            ]);
            await this._restoreRows('app_settings', [row]);
        }
    }

    /**
     * Remove secret settings from snapshots taken before secrets were masked (they copied
     * every app_settings row, SMTP password and LLM key included). Idempotent,
     * best-effort; returns how many snapshots were rewritten. The snapshot keeps
     * everything else — nothing is deleted but the secret rows.
     */
    async scrubSecretsFromStoredSnapshots() {
        let rows;
        try {
            rows = await db.all(
                // (`->` not `?`: a `?` would be read as a bind placeholder.)
                "SELECT id, snapshot_data FROM snapshots WHERE (snapshot_data -> 'data') IS NOT NULL AND (snapshot_data -> 'secretsOmitted') IS NULL"
            );
        } catch (_) {
            return 0;
        }
        let n = 0;
        for (const r of rows || []) {
            const data =
                typeof r.snapshotData === 'string' ? JSON.parse(r.snapshotData) : r.snapshotData;
            if (!data || !data.data) continue;
            data.data.appSettings = SnapshotService.withoutSecretSettings(data.data.appSettings);
            data.secretsOmitted = true;
            await db.run('UPDATE snapshots SET snapshot_data = ? WHERE id = ?', [
                JSON.stringify(data),
                r.id,
            ]);
            n++;
        }
        return n;
    }

    // Create a snapshot of the entire database
    async createSnapshot(name, description, createdBy) {
        try {
            // Get all data from all tables
            const snapshotData = {
                timestamp: new Date().toISOString(),
                version: '1.0',
                data: {},
            };

            // Sites
            snapshotData.data.sites = await db.all('SELECT * FROM sites');

            // Departments
            snapshotData.data.departments = await db.all('SELECT * FROM departments');

            // Services
            snapshotData.data.services = await db.all('SELECT * FROM services');

            // Domains + Sub-Domains (skills FK sub_domain_id → sub_domains)
            snapshotData.data.domains = await db.all('SELECT * FROM domains');
            snapshotData.data.subDomains = await db.all('SELECT * FROM sub_domains');

            // Skills
            snapshotData.data.skills = await db.all('SELECT * FROM skills');

            // Role Families (roles FK role_family_id → role_families) + Roles
            snapshotData.data.roleFamilies = await db.all('SELECT * FROM role_families');
            snapshotData.data.roles = await db.all('SELECT * FROM roles');

            // Role Skill Requirements
            snapshotData.data.roleSkillRequirements = await db.all(
                'SELECT * FROM roleSkillRequirements'
            );

            // Employees (strip credential columns — a password hash must never be
            // written into the snapshot jsonb or egress to the client; mirrors the
            // admins query below which already omits passwords "for security").
            snapshotData.data.employees = (await db.all('SELECT * FROM employees')).map((e) => {
                const { passwordHash, password_hash, ...safe } = e;
                return safe;
            });

            // Skill Assessments
            snapshotData.data.skillAssessments = await db.all('SELECT * FROM skillAssessments');

            // Assessment History
            snapshotData.data.assessmentHistory = await db.all('SELECT * FROM assessmentHistory');

            // Admins (excluding passwords for security)
            snapshotData.data.admins = await db.all(
                'SELECT id, username, email, role, isActive, createdAt, updatedAt FROM admins'
            );

            // Admin Scopes
            snapshotData.data.adminScopes = await db.all('SELECT * FROM adminScopes');

            // App Settings — WITHOUT secrets: a snapshot is a jsonb copy that
            // outlives any key rotation and is restorable by design, so a stored
            // credential (SMTP password, LLM key, SSO client secret …) is never
            // copied into it, not even as ciphertext. The rows are omitted; the
            // restore keeps whatever secret is live at that moment.
            snapshotData.data.appSettings = SnapshotService.withoutSecretSettings(
                await db.all('SELECT * FROM appSettings')
            );
            snapshotData.secretsOmitted = true;

            // Save snapshot
            const snapshot = await SnapshotModel.create({
                name: name.trim(),
                description: description?.trim() || null,
                snapshotData: JSON.stringify(snapshotData),
                createdBy,
            });

            return snapshot;
        } catch (error) {
            console.error('Create snapshot error:', error);
            throw error;
        }
    }

    // Restore database from snapshot
    async restoreSnapshot(snapshotId, adminId) {
        const snapshot = await SnapshotModel.findById(snapshotId);
        if (!snapshot) {
            throw new Error('Snapshot not found');
        }

        // snapshot_data is a jsonb column — node-pg already returns it parsed.
        // Guard against a legacy text-stored value too.
        const snapshotData =
            typeof snapshot.snapshotData === 'string'
                ? JSON.parse(snapshot.snapshotData)
                : snapshot.snapshotData;

        // APPEND-ONLY JOURNALS ARE NEVER WIPED. Refuse BEFORE the pg_dump below
        // when the restore would have to delete rows of one — otherwise the
        // restore point is taken, then the DELETE dies on the immutability
        // trigger (23514) where it exists, and silently destroys the journal
        // where it does not. Measured on the test base: 91 tables in the wipe
        // set, self_assessment_events among them → "IMMUTABLE_TABLE:
        // self_assessment_events is append-only", every time.
        await this.assertRestorable(snapshotData.data);

        // SAFETY: a restore wipes tables that reference the captured set — including
        // PIP/IDP/coaching/9-box/dispute/lifecycle history that snapshots do NOT
        // capture — so a successful restore permanently deletes governance records
        // created since. Take a FULL pg_dump first and refuse to proceed if it fails,
        // so this destructive, irreversible operation is always recoverable.
        let preRestore = null;
        try {
            preRestore =
                await require('./SqlConsoleService').createRestorePoint('pre-snapshot-restore');
        } catch (e) {
            throw new Error(
                'Restore aborted: could not create a pre-restore safety backup (' +
                    (e && e.message ? e.message : 'pg_dump unavailable') +
                    '). Ensure pg_dump is available, then retry.'
            );
        }
        try {
            await require('./LogService').log({
                adminId,
                action: 'SNAPSHOT_RESTORE_PRE_BACKUP',
                entityType: 'snapshot',
                entityId: Number(snapshotId),
                details: `Pre-restore safety backup created: ${preRestore && preRestore.name} (${preRestore && preRestore.sizeBytes} bytes).`,
            });
        } catch (_) {
            /* audit best-effort */
        }

        // Deletes run child → parent and inserts run parent → child, so foreign
        // keys stay satisfied throughout (no need to disable them).
        // Wrap the entire wipe+restore (including trigger disable/re-enable) in a
        // single transaction so a mid-restore failure rolls everything back — no
        // half-wiped DB, and the trigger state is restored by the rollback too.
        return await db.runTransaction(async () => {
            // The snapshot restores assessment_history explicitly, so suppress the
            // auto-capture trigger while we re-insert skill_assessments (otherwise it
            // would log spurious "now" history rows). Best-effort: never block restore.
            await db
                .run('ALTER TABLE skill_assessments DISABLE TRIGGER trg_skill_assessment_history')
                .catch(() => {});
            // assessment_history is append-only (block_mutation trigger). The snapshot
            // replaces it wholesale, so suppress the immutability trigger for the wipe.
            // Best-effort: never block restore.
            await db
                .run(
                    'ALTER TABLE assessment_history DISABLE TRIGGER trg_assessment_history_immutable'
                )
                .catch(() => {});
            // The live secret settings, read BEFORE the wipe deletes app_settings.
            const liveSecretSettings = (await db.all('SELECT * FROM appSettings')).filter((r) =>
                SnapshotService.isSecretSetting(r)
            );
            // Wipe the captured tables AND every table that (transitively) references
            // them — computed from live FK metadata, in child→parent order — so the
            // DELETE never fails on a workflow table (supervisor_reviews, PIP, IDP,
            // coaching, 9-box, goals, disputes, lifecycle…). `admins` is preserved
            // (its employee link is nulled first). Reset-to-snapshot semantics: the
            // workflow tables the snapshot doesn't capture are cleared, not orphaned.
            await this._wipeForRestore(snapshotData.data);

            // Restore data (parent→child). GENERIC per-row insert of EVERY captured
            // column (was: hard-coded column lists that silently DROPPED newer
            // columns — hierarchy, is_org_root, username, skill dedup/category,
            // assessment validation, role_family_id, sub_domain_id, country_id…).
            const D = snapshotData.data;
            await this._restoreRows('role_families', D.roleFamilies);
            await this._restoreRows('sites', D.sites);
            await this._restoreRows('domains', D.domains);
            await this._restoreRows('sub_domains', D.subDomains);
            await this._restoreRows('roles', D.roles);
            await this._restoreRows('departments', D.departments);
            await this._restoreRows('services', D.services);
            await this._restoreRows('skills', D.skills);
            await this._restoreRows('role_skill_requirements', D.roleSkillRequirements);
            // Employees: insert everything EXCEPT the self-referential FKs first
            // (a manager/supervisor row may not exist yet), then wire them in a 2nd
            // pass so the full hierarchy is preserved.
            await this._restoreRows('employees', D.employees, ['manager_id', 'supervisor_id']);
            if (D.employees) {
                for (const emp of D.employees) {
                    const sup = emp.supervisorId ?? emp.supervisor_id ?? null;
                    const mgr = emp.managerId ?? emp.manager_id ?? null;
                    const mtype = emp.managerType ?? emp.manager_type ?? null;
                    if (sup != null || mgr != null || mtype != null) {
                        await db.run(
                            'UPDATE employees SET supervisor_id = ?, manager_id = ?, manager_type = ? WHERE id = ?',
                            [sup, mgr, mtype, emp.id]
                        );
                    }
                }
            }
            await this._restoreRows('skill_assessments', D.skillAssessments);
            await this._restoreRows('assessment_history', D.assessmentHistory);
            await this._restoreRows('admin_scopes', D.adminScopes);
            // Secrets: never taken FROM a snapshot (an old snapshot may still
            // hold one in clear, or a mask) — the live ones read before the wipe
            // are put back verbatim (still sealed).
            await this._restoreRows(
                'app_settings',
                SnapshotService.withoutSecretSettings(D.appSettings)
            );
            await this._restoreLiveSecretSettings(liveSecretSettings);

            // Note: admins (and password hashes) are intentionally NOT restored —
            // snapshots never capture credential material.

            // Rows were inserted with explicit ids — advance each PG identity
            // sequence so subsequent inserts don't collide with restored ids.
            await this._resyncSequences();

            // Re-enable the triggers inside the transaction so success commits them
            // re-enabled; a rollback (on failure above) restores trigger state too.
            await db
                .run('ALTER TABLE skill_assessments ENABLE TRIGGER trg_skill_assessment_history')
                .catch(() => {});
            await db
                .run(
                    'ALTER TABLE assessment_history ENABLE TRIGGER trg_assessment_history_immutable'
                )
                .catch(() => {});

            // S-07: an ERASED person must not come back with the snapshot. Every
            // erasure tombstone (no FK — the wipe above kept them) is re-applied
            // through DSRService.erase. Fail CLOSED: if one cannot be re-applied
            // the whole restore rolls back rather than resurrect that person.
            const erasures = await require('./DSRService').reapplyTombstones({
                actorAdminId: adminId,
                source: `snapshot restore #${snapshotId}`,
            });
            if (erasures.failed.length) {
                throw new Error(
                    'Restore aborted: erased subject(s) could not be erased again after the restore (' +
                        erasures.failed.map((f) => `#${f.id}: ${f.error}`).join('; ') +
                        '). Nothing was changed.'
                );
            }

            // The second pass above wrote supervisor_id / manager_id verbatim from
            // the snapshot, with none of the cycle guards the edit forms apply. A
            // reporting LOOP is reported (never rewritten: which link is wrong is
            // a human decision) in the summary and the audit trail.
            const reportingCycles = await this.findReportingCycles();
            if (reportingCycles && reportingCycles.length) {
                try {
                    await require('./LogService').log({
                        adminId,
                        action: 'SNAPSHOT_RESTORE_REPORTING_CYCLES',
                        entityType: 'snapshot',
                        entityId: Number(snapshotId),
                        details:
                            `${reportingCycles.length} reporting loop(s) present after the restore: ` +
                            reportingCycles.map((c) => c.join(' → ')).join(' | '),
                        severity: 'warning',
                    });
                } catch (_) {
                    /* audit best-effort */
                }
            }

            return {
                success: true,
                message: 'Snapshot restored successfully',
                erasuresReapplied: erasures.reapplied,
                tombstones: erasures.tombstones,
                reportingCycles,
            };
        });
    }

    /**
     * Reporting LOOPS in the live hierarchy: every cycle through
     * `supervisor_id` and `manager_id` (when manager_type = 'employee' — the
     * polymorphic column also points at admins, whose ids overlap). Each cycle
     * is returned ONCE, as the list of employee ids starting at its smallest
     * id and closed on it (e.g. [12, 40, 12]). Read-only.
     */
    async findReportingCycles(limit = 100) {
        let rows = [];
        // Inside the restore transaction a failing statement would poison it:
        // the query runs in a savepoint (a pass-through outside a transaction).
        const sp = (fn) => (typeof db.runInSavepoint === 'function' ? db.runInSavepoint(fn) : fn());
        try {
            rows = await sp(() =>
                db.all(
                    `WITH RECURSIVE edges AS (
                     SELECT id AS child, supervisor_id AS parent FROM employees WHERE supervisor_id IS NOT NULL
                     UNION
                     SELECT id, manager_id FROM employees
                      WHERE manager_type = 'employee' AND manager_id IS NOT NULL
                 ),
                 walk (start_id, node, path, cyc) AS (
                     SELECT child, parent, ARRAY[child, parent], child = parent FROM edges
                     UNION ALL
                     SELECT w.start_id, e.parent, w.path || e.parent, e.parent = ANY (w.path)
                       FROM walk w JOIN edges e ON e.child = w.node
                      WHERE NOT w.cyc AND cardinality(w.path) < 64
                 )
                 SELECT start_id, path FROM walk WHERE cyc AND node = start_id LIMIT 2000`
                )
            );
        } catch (e) {
            // NOT MEASURED is null, never "no cycle".
            console.error('[snapshot] reporting-cycle check failed:', e && e.message);
            return null;
        }
        const seen = new Set();
        const out = [];
        for (const r of rows) {
            const p = (r.path || []).map(Number);
            const ring = p.slice(0, -1); // path is closed on start_id
            if (!ring.length) continue;
            const minAt = ring.indexOf(Math.min(...ring));
            const rot = ring.slice(minAt).concat(ring.slice(0, minAt));
            const key = rot.join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(rot.concat(rot[0]));
            if (out.length >= limit) break;
        }
        return out;
    }

    /**
     * Wipe the captured "root" tables plus every table that transitively
     * references them, in child→parent order, using live FK metadata — so restore
     * never fails on an unhandled workflow FK (and doesn't need a hard-coded delete
     * list that falls behind the schema). `admins` is never wiped; its
     * `linked_employee_id` is nulled first so employees can be deleted.
     */
    /**
     * Journals that a restore must NEVER delete: the append-only tables the
     * database itself declares (row triggers on block_mutation/block_truncate —
     * migrations 101/104/116/120) UNIONED with the product's own list, so a
     * base where a trigger was never installed is protected all the same.
     *
     * assessment_history is the one deliberate exception: the snapshot CAPTURES
     * and RESTORES it wholesale (restoreSnapshot disables its trigger for the
     * duration), so its content is replaced by its own earlier copy, not lost.
     */
    static get PROTECTED_JOURNALS() {
        return [
            'review_signatures',
            'self_assessment_events',
            'system_logs',
            'nine_box_events',
            'lifecycle_events',
            'employee_movements',
        ];
    }

    async _appendOnlyTables() {
        const live = await db
            .all(
                `
            SELECT DISTINCT c.relname AS table_name
              FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_proc p ON p.oid = t.tgfoid
             WHERE NOT t.tgisinternal AND n.nspname = 'public'
               AND p.proname IN ('block_mutation', 'block_truncate')`
            )
            .catch(() => []);
        const set = new Set(SnapshotService.PROTECTED_JOURNALS);
        for (const r of live)
            if (r.tableName && r.tableName !== 'assessment_history') set.add(r.tableName);
        return set;
    }

    async _fkEdges() {
        // Child column and delete rule included: a CASCADE from a wiped parent
        // into a protected journal would delete journal rows too.
        return db.all(`
            SELECT c.conrelid::regclass::text AS child,
                   c.confrelid::regclass::text AS parent,
                   a.attname AS child_col,
                   c.confdeltype AS delete_rule
              FROM pg_constraint c
              JOIN pg_namespace n ON n.oid = c.connamespace
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
             WHERE c.contype = 'f' AND n.nspname = 'public'`);
    }

    /** The wipe set: roots + everything that transitively references them, MINUS the journals. */
    _wipeSet(data, edges, protectedTables) {
        // Roots = the tables this snapshot actually restores.
        const roots = [
            'role_families',
            'sites',
            'departments',
            'services',
            'domains',
            'sub_domains',
            'skills',
            'roles',
            'role_skill_requirements',
            'employees',
            'skill_assessments',
            'assessment_history',
            'admin_scopes',
            'app_settings',
        ].filter((t) => {
            // Only wipe a reference table if the snapshot can restore it (old
            // snapshots lack sub_domains/role_families — preserve those).
            if (t === 'sub_domains') return Array.isArray(data.subDomains);
            if (t === 'role_families') return Array.isArray(data.roleFamilies);
            return true;
        });
        const childrenOf = {};
        for (const e of edges) {
            if (e.child !== e.parent)
                (childrenOf[e.parent] = childrenOf[e.parent] || []).push(e.child);
        }
        // BFS: everything that (transitively) references a root must also be wiped
        // (except admins, which we keep, and the append-only journals, which are
        // never deleted — see assertRestorable).
        const wipe = new Set(roots);
        const queue = [...roots];
        while (queue.length) {
            const t = queue.shift();
            for (const c of childrenOf[t] || []) {
                if (c === 'admins' || protectedTables.has(c) || wipe.has(c)) continue;
                wipe.add(c);
                queue.push(c);
            }
        }
        return wipe;
    }

    /**
     * Pre-flight: can this snapshot be restored WITHOUT deleting a row of an
     * append-only journal? For every FK from a protected journal into the wipe
     * set, a non-null reference means the parent DELETE would either be refused
     * by the immutability trigger (23514) or, where the trigger is missing,
     * cascade into the journal. Either way the restore is refused HERE, before
     * any pg_dump or write. Throws with the offending tables named.
     */
    async assertRestorable(data) {
        const protectedTables = await this._appendOnlyTables();
        const edges = await this._fkEdges();
        const wipe = this._wipeSet(data, edges, protectedTables);
        const blockers = [];
        for (const e of edges) {
            if (!protectedTables.has(e.child) || !wipe.has(e.parent)) continue;
            const r = await db.get(
                `SELECT COUNT(*)::int AS n FROM ${e.child} WHERE ${e.childCol} IS NOT NULL`
            );
            const n = r ? Number(r.n) : 0;
            if (n > 0) blockers.push(`${e.child}.${e.childCol} -> ${e.parent} (${n} rows)`);
        }
        if (blockers.length) {
            const err = new Error(
                'Restore refused: it would delete rows of an append-only journal — ' +
                    blockers.join('; ') +
                    '. Journals are never wiped; restore a full pg_dump restore point instead.'
            );
            err.code = 'SNAPSHOT_RESTORE_PROTECTED_JOURNAL';
            err.blockers = blockers;
            throw err;
        }
        return { wipe, edges, protected: protectedTables };
    }

    async _wipeForRestore(data) {
        // Re-asserted here so a direct caller gets the refusal too, never a
        // DELETE that reaches a journal.
        const { wipe, edges } = await this.assertRestorable(data);

        // admins is preserved — clear its FK to employees so the delete succeeds.
        await db
            .run('UPDATE admins SET linked_employee_id = NULL WHERE linked_employee_id IS NOT NULL')
            .catch(() => {});

        // Topological delete: repeatedly delete tables in `wipe` not referenced by
        // any other still-present table in `wipe` (children first).
        const inWipeEdges = edges.filter(
            (e) => wipe.has(e.child) && wipe.has(e.parent) && e.child !== e.parent
        );
        const remaining = new Set(wipe);
        while (remaining.size) {
            const referenced = new Set(
                inWipeEdges
                    .filter((e) => remaining.has(e.child) && remaining.has(e.parent))
                    .map((e) => e.parent)
            );
            let deletable = [...remaining].filter((t) => !referenced.has(t));
            if (!deletable.length) deletable = [...remaining]; // FK cycle — delete the rest
            for (const t of deletable) {
                await db.run(`DELETE FROM ${t}`);
                remaining.delete(t);
            }
        }
    }

    // camelCase result key → snake_case DB column (deterministic; round-trips the
    // capture-time camelization). Used to insert EVERY captured column generically.
    _toSnake(k) {
        return String(k)
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
            .toLowerCase();
    }

    /**
     * Insert every captured row into `table` preserving ALL columns present in the
     * snapshot (schema-adaptive — no hard-coded column list to fall behind). Column
     * identifiers are emitted snake_case so the compat layer passes them through
     * unchanged (avoids the managerId/manager_id COLUMN_MAP gap). `exclude` names
     * snake_case columns to skip (e.g. self-referential FKs handled in a 2nd pass).
     */
    async _restoreRows(table, rows, exclude = []) {
        if (!Array.isArray(rows) || !rows.length) return;
        const skip = new Set(exclude);
        for (const row of rows) {
            const cols = [];
            const vals = [];
            for (const k of Object.keys(row)) {
                if (row[k] === undefined) continue;
                const snake = this._toSnake(k);
                if (skip.has(snake)) continue;
                cols.push(snake);
                vals.push(row[k]);
            }
            if (!cols.length) continue;
            const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
            await db.run(sql, vals);
        }
    }

    // Re-align serial/identity sequences after an explicit-id restore.
    async _resyncSequences() {
        const tables = [
            'role_families',
            'sites',
            'domains',
            'sub_domains',
            'roles',
            'departments',
            'services',
            'skills',
            'role_skill_requirements',
            'employees',
            'skill_assessments',
            'assessment_history',
            'admin_scopes',
            'app_settings',
        ];
        for (const t of tables) {
            try {
                await db.run(
                    `SELECT setval(pg_get_serial_sequence('${t}', 'id'),
                        (SELECT COALESCE(MAX(id), 1) FROM ${t}), true)`
                );
            } catch (_) {
                // Table may lack an id sequence — ignore.
            }
        }
    }

    // Get snapshot statistics
    async getSnapshotStats(snapshotId) {
        const snapshot = await SnapshotModel.findById(snapshotId);
        if (!snapshot) {
            return null;
        }

        // snapshot_data is a jsonb column — node-pg already returns it parsed.
        // Guard against a legacy text-stored value too.
        const snapshotData =
            typeof snapshot.snapshotData === 'string'
                ? JSON.parse(snapshot.snapshotData)
                : snapshot.snapshotData;
        return {
            sites: snapshotData.data.sites?.length || 0,
            departments: snapshotData.data.departments?.length || 0,
            services: snapshotData.data.services?.length || 0,
            domains: snapshotData.data.domains?.length || 0,
            skills: snapshotData.data.skills?.length || 0,
            roles: snapshotData.data.roles?.length || 0,
            employees: snapshotData.data.employees?.length || 0,
            assessments: snapshotData.data.skillAssessments?.length || 0,
            historyEntries: snapshotData.data.assessmentHistory?.length || 0,
        };
    }
}

module.exports = new SnapshotService();
