/**
 * Database Cleanup Service (PostgreSQL)
 * Safely clean database tables while preserving admin accounts.
 * Backups are logical JSON dumps written to data/backups (PG-native — no
 * SQLite file copy).
 */

const db = require('../config/database');
const fs = require('fs').promises;
const path = require('path');

// Child → parent order: safe to DELETE top-to-bottom. snake_case = real PG
// table names. Tables that don't exist in a given install are skipped (the
// per-table DELETE is wrapped in try/catch by the caller).
const CLEAN_ORDER = [
    // coaching (V1 plans + V2 sessions)
    'coaching_signoffs',
    'coaching_objectives',
    'coaching_grow',
    'coaching_plan_actions',
    'coaching_sessions',
    'coaching_plans',
    // IDP
    'idp_signoffs',
    'action_effectiveness',
    'action_evidence',
    'action_skill_links',
    'idp_actions',
    'idp_objectives',
    'idp_plans',
    // PIP
    'pip_milestones',
    'pips',
    // 9-box / talent
    'nine_box_events',
    'nine_box_evaluations',
    'talent_placements',
    'talent_ratings',
    'bias_alerts',
    // self-assessment workflow + evidence + disputes
    'assessment_disputes',
    'assessment_evidence',
    // self_assessment_events is APPEND-ONLY since migration 116: the explicit
    // DELETE is skipped (it would raise and poison the transaction). The rows
    // still go when the cleanup clears self_assessment_rounds — the FK is
    // ON DELETE CASCADE — with the block_mutation guards suspended below.
    'self_assessment_comments',
    'self_assessment_events',
    // `selfAssessments` is the CURRENT-round VIEW since migration 113: deleting
    // through it would leave every superseded round behind and report a count
    // that is not the number of rows removed. The base table holds every round.
    'supervisorReviews',
    'self_assessment_rounds',
    // assessments
    'assessmentHistory',
    'skillAssessments',
    // training plans
    'training_plan_items',
    'training_plans',
    // misc
    'readiness_snapshots',
    'lifecycle_events',
    'roleSkillRequirements',
    'snapshots',
    'report_templates',
    // org + catalog (parents last)
    'employees',
    'skills',
    'roles',
    'services',
    'departments',
    'sites',
    'domains',
];

// Append-only audit tables guarded by block_mutation triggers (BEFORE
// DELETE/UPDATE). A DELETE on these RAISES and — inside a transaction — poisons
// the whole transaction (a JS try/catch can't recover it). They are never wiped
// or "restored": they are immutable history by design.
//
// THIS LIST IS THE DECLARED INTENT, NOT THE SOLE AUTHORITY. It drifted once and
// the drift was invisible: migration 116 put the same two guards on
// self_assessment_events ("la seule trace qui nomme l'acteur d'une approbation
// administrateur") and this list was not updated, so for one release the SQL
// console let a row delete — and a whole-table `DROP TABLE` — through on
// self_assessment_events while calling itself append-only. Two things now make
// that impossible:
//   • tests/unit/sqlConsoleAppendOnlyDrift.test.js compares this list against the
//     CREATE TRIGGER statements in db/postgres/*.sql — a migration that adds a
//     guard without adding the table here turns the suite red;
//   • SqlConsoleService resolves the live set from the database itself
//     (public.append_only_tables, migration 120) and protects the UNION, so a
//     table that carries the triggers is guarded even if this list lags.
const IMMUTABLE_TABLES = new Set([
    'assessment_history',
    'assessmentHistory',
    'system_logs',
    'systemLogs',
    'review_signatures',
    'reviewSignatures',
    // Migration 116 — trg_sa_events_immutable / trg_sa_events_no_truncate.
    'self_assessment_events',
    'selfAssessmentEvents',
]);

const BACKUP_DIR = path.resolve(__dirname, '../../data/backups');

class DatabaseCleanupService {
    /**
     * The append-only tables, exposed so every destructive path (cleanup, restore,
     * AND the Danger-Zone reset in DataManagementController) uses ONE list. A
     * DELETE against any of these raises inside the trigger and poisons the whole
     * PostgreSQL transaction, so they must be skipped, never "tried".
     */
    get IMMUTABLE_TABLES() {
        return IMMUTABLE_TABLES;
    }

    /**
     * The same list as real PostgreSQL table names, de-duplicated
     * (['assessment_history', 'system_logs', 'review_signatures']).
     *
     * IMMUTABLE_TABLES carries both spellings of each table because callers pass
     * camelCase identifiers; anything that talks to PostgreSQL directly (the SQL
     * console's tamper guard, and its restore-point preservation) needs the real
     * names. Deriving them here keeps ONE list: add a table to IMMUTABLE_TABLES
     * and every guard picks it up.
     */
    get IMMUTABLE_PG_TABLES() {
        return [...new Set([...IMMUTABLE_TABLES].map((t) => this.pgName(t)))];
    }

    /** True when `table` (camelCase or snake_case) is append-only. */
    isImmutable(table) {
        return IMMUTABLE_TABLES.has(table);
    }

    /**
     * Real PostgreSQL table name for a possibly-camelCase identifier.
     * The driver rewrites camelCase identifiers inside SQL text, but NOT inside a
     * bound parameter — so `to_regclass('public.roleSkillRequirements')` folds to
     * `roleskillrequirements`, returns NULL, and the table gets wrongly reported
     * as absent and never cleaned. Normalise before the existence probe.
     */
    pgName(table) {
        return String(table)
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .toLowerCase();
    }

    /**
     * Every table that must be emptied to delete `roots`, in an order PostgreSQL
     * accepts — computed from the LIVE foreign-key graph, never from a hand-kept
     * list.
     *
     * A hand-kept list trusts ON DELETE CASCADE for everything it does not name.
     * Seven foreign keys onto `employees` do not cascade (coaching_sessions.coach_id,
     * training_plans.created_by, action_evidence.uploaded_by, assessment_disputes
     * .decided_by, …), so with ONE coaching session on file the reset died on
     * "fk_coaching_sessions_coach" (customer appliance, 2026-09-09) — and the dev
     * database, purged of test data, could not show it.
     *
     * The plan is the transitive closure of DEPENDENTS (tables that reference a
     * table in the set) minus `preserved`, ordered children-before-parents
     * (Kahn). Self-references (employees.supervisor_id) need no ordering: one
     * DELETE statement satisfies them. A genuine cycle between distinct tables
     * cannot be ordered; those tables are appended last, in name order, and
     * reported in `cycle` so a failure names the culprit.
     *
     * @param {string[]} roots      real (snake_case) table names to empty
     * @param {string[]} preserved  tables that must NEVER be emptied (they are
     *                              also never entered through a dependency)
     * @returns {Promise<{order: string[], added: string[], cycle: string[]}>}
     */
    async wipePlan(roots, preserved = []) {
        const norm = (t) =>
            String(t)
                .replace(/^public\./, '')
                .replace(/"/g, '');
        const edges = (
            await db.all(
                `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
               FROM pg_constraint c
               JOIN pg_namespace n ON n.oid = c.connamespace
              WHERE c.contype = 'f' AND n.nspname = 'public' AND c.conrelid <> c.confrelid`
            )
        ).map((e) => ({ child: norm(e.child), parent: norm(e.parent) }));
        const keep = new Set(preserved.map(norm));
        const rootSet = new Set(roots.map(norm).filter((t) => !keep.has(t)));
        const set = new Set(rootSet);
        let grew = true;
        while (grew) {
            grew = false;
            for (const e of edges) {
                if (set.has(e.parent) && !set.has(e.child) && !keep.has(e.child)) {
                    set.add(e.child);
                    grew = true;
                }
            }
        }
        const order = [];
        const remaining = new Set(set);
        const cycle = [];
        const dependentsOf = (t) =>
            edges
                .filter((e) => e.parent === t && e.child !== t && remaining.has(e.child))
                .map((e) => e.child);
        // Is `t` on a cycle among the remaining tables? (follow child -> parent)
        const onCycle = (t) => {
            const seen = new Set();
            const stack = [t];
            while (stack.length) {
                const cur = stack.pop();
                for (const e of edges) {
                    if (e.child !== cur || !remaining.has(e.parent) || e.parent === cur) continue;
                    if (e.parent === t) return true;
                    if (!seen.has(e.parent)) {
                        seen.add(e.parent);
                        stack.push(e.parent);
                    }
                }
            }
            return false;
        };
        while (remaining.size) {
            const ready = [...remaining].filter((t) => dependentsOf(t).length === 0).sort();
            if (ready.length) {
                order.push(...ready);
                for (const t of ready) remaining.delete(t);
                continue;
            }
            // Stuck: only cycles are left at the front. Break the cycle at its
            // member with the fewest remaining dependents (name order on a tie);
            // everything else keeps its children-first order afterwards.
            const members = [...remaining].filter(onCycle).sort();
            const pick = (members.length ? members : [...remaining].sort()).sort(
                (a, b) => dependentsOf(a).length - dependentsOf(b).length || a.localeCompare(b)
            )[0];
            cycle.push(pick);
            order.push(pick);
            remaining.delete(pick);
        }
        return { order, added: order.filter((t) => !rootSet.has(t)), cycle: cycle.sort() };
    }

    /**
     * Clean all data tables (preserve admins by default).
     */
    async cleanupDatabase(options = { preserveAdmins: true }) {
        const backup = await this.createBackup();

        const results = {};

        let toggled = [];
        await db.runTransaction(async () => {
            // Suspend the append-only guards for this explicitly-invoked,
            // backup-first cleanup — same mechanism as scripts/reset-for-golive.js.
            // Skipping the immutable tables is not enough on its own: the guard is
            // reached by CASCADE from tables this DOES clear —
            //   employees / skills                -> assessment_history  (CASCADE)
            //   employees -> supervisor_reviews   -> review_signatures   (CASCADE)
            //   admins    -> system_logs.admin_id (SET NULL = an UPDATE, also blocked)
            // Without this, DELETE FROM employees raised IMMUTABLE_TABLE, its
            // savepoint rolled back, and every dependent parent (skills, roles,
            // services, departments, sites, domains) then failed on its foreign key
            // — while the caller still reported "Database cleaned successfully".
            // ALTER TABLE is transactional: a rollback restores the triggers.
            toggled = await db.all(`
                SELECT c.relname AS tbl, t.tgname AS tgname
                FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_proc p ON p.oid = t.tgfoid
                WHERE n.nspname = 'public' AND NOT t.tgisinternal AND p.proname = 'block_mutation'`);
            for (const { tbl, tgname } of toggled) {
                await db.run(`ALTER TABLE public."${tbl}" DISABLE TRIGGER "${tgname}"`);
            }

            // PostgreSQL resolves FK ordering via the child→parent delete order
            // below; no PRAGMA needed.
            for (const table of CLEAN_ORDER) {
                if (IMMUTABLE_TABLES.has(table)) {
                    results[table] = 'skipped (append-only)';
                    continue;
                }
                // A missing table (partial install) or an immutable-trigger abort inside a
                // Postgres transaction poisons EVERY subsequent statement — the outer COMMIT
                // then silently ROLLBACKs and we'd report success having deleted nothing.
                // Guard each table with existence precheck + SAVEPOINT so one failure is
                // isolated to that table.
                const reg = await db.get('SELECT to_regclass(?) AS oid', [
                    `public.${this.pgName(table)}`,
                ]);
                if (!reg || !reg.oid) {
                    results[table] = 'skipped (absent)';
                    continue;
                }
                await db.run('SAVEPOINT clean_tbl');
                try {
                    const countResult = await db.get(`SELECT COUNT(*) as count FROM ${table}`);
                    results[table] = Number(countResult.count);
                    await db.run(`DELETE FROM ${table}`);
                    await db.run('RELEASE SAVEPOINT clean_tbl');
                } catch (error) {
                    await db.run('ROLLBACK TO SAVEPOINT clean_tbl');
                    console.error(`Error cleaning ${table}:`, error.message);
                    results[table] = { error: error.message };
                }
            }

            // Optionally clean admin-related tables.
            if (!options.preserveAdmins) {
                await db.run('DELETE FROM adminScopes');
                await db.run('DELETE FROM admins');
                await db.run('DELETE FROM password_history');
                results.adminScopes = 'cleaned';
                results.admins = 'cleaned';
                results.password_history = 'cleaned';
            }

            // system_logs is the audit trail of this very cleanup — never emptied,
            // even with the guard suspended. Only prune login_attempts.
            await db.run(
                "DELETE FROM login_attempts WHERE attemptedAt < now() - interval '7 days'"
            );

            // Restore the append-only guards before COMMIT.
            for (const { tbl, tgname } of toggled) {
                await db.run(`ALTER TABLE public."${tbl}" ENABLE TRIGGER "${tgname}"`);
            }
        });

        // Report honestly: a per-table failure previously left `results` carrying
        // {error} entries while the message still said "cleaned successfully".
        const failed = Object.entries(results)
            .filter(([, v]) => v && typeof v === 'object' && v.error)
            .map(([t]) => t);
        return {
            success: failed.length === 0,
            backup,
            results,
            failed,
            message:
                failed.length === 0
                    ? 'Database cleaned successfully'
                    : `Database partially cleaned — ${failed.length} table(s) failed: ${failed.join(', ')}. See results for details.`,
        };
    }

    /**
     * Create a logical JSON backup of all data tables in data/backups.
     * Returns the absolute path to the written file.
     */
    async createBackup() {
        const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
        const backupPath = path.join(BACKUP_DIR, `backup_${timestamp}.json`);

        await fs.mkdir(BACKUP_DIR, { recursive: true });

        const dump = { timestamp: new Date().toISOString(), format: 'pg-json/1', data: {} };
        for (const table of CLEAN_ORDER) {
            try {
                dump.data[table] = await db.all(`SELECT * FROM ${table}`);
            } catch (error) {
                dump.data[table] = { error: error.message };
            }
        }

        await fs.writeFile(backupPath, JSON.stringify(dump, null, 2), 'utf8');
        return backupPath;
    }

    /**
     * Get database statistics.
     */
    async getDatabaseStats() {
        const tables = [
            'sites',
            'departments',
            'services',
            'domains',
            'roles',
            'skills',
            'employees',
            'admins',
            'skillAssessments',
            'selfAssessments',
            'supervisorReviews',
            'roleSkillRequirements',
            'coaching_plans',
            'coaching_sessions',
            'pips',
            'idp_plans',
            'nine_box_evaluations',
        ];

        const stats = {};
        for (const table of tables) {
            try {
                const result = await db.get(`SELECT COUNT(*) as count FROM ${table}`);
                stats[table] = Number(result.count);
            } catch (error) {
                stats[table] = { error: error.message };
            }
        }
        return stats;
    }

    /**
     * Restore from a logical JSON backup produced by createBackup.
     * Truncates the affected tables, then re-inserts rows parent → child.
     *
     * KNOWN LIMITATION (deliberately NOT changed here): the wipe below reaches the
     * append-only guard by cascade (employees/skills -> assessment_history,
     * employees -> supervisor_reviews -> review_signatures), so a restore aborts
     * whenever that history is non-empty. Suspending the guard the way
     * cleanupDatabase does would make the restore run — but it would then
     * permanently DELETE history this method never re-inserts, and re-inserting
     * system_logs would rewrite its hash chain. Making restore lossless is a
     * design decision about the audit trail, not a mechanical fix; today it
     * fails safe instead of losing history silently.
     */
    async restoreBackup(backupPath) {
        let raw;
        try {
            raw = await fs.readFile(backupPath, 'utf8');
        } catch (error) {
            throw new Error('Backup file not found');
        }
        const dump = JSON.parse(raw);
        if (!dump || !dump.data) throw new Error('Invalid backup file');

        await db.runTransaction(async () => {
            // Wipe child → parent (skip append-only audit tables — DELETE on them
            // would abort the whole transaction; they are immutable history).
            for (const table of CLEAN_ORDER) {
                if (IMMUTABLE_TABLES.has(table)) continue;
                await db.run(`DELETE FROM ${table}`);
            }
            // Re-insert parent → child.
            const insertOrder = [...CLEAN_ORDER].reverse();
            for (const table of insertOrder) {
                if (IMMUTABLE_TABLES.has(table)) continue; // append-only: never restored
                const rows = dump.data[table];
                if (!Array.isArray(rows) || rows.length === 0) continue;
                for (const row of rows) {
                    const cols = Object.keys(row);
                    if (cols.length === 0) continue;
                    const placeholders = cols.map(() => '?').join(', ');
                    const values = cols.map((c) => {
                        const v = row[c];
                        // Serialize nested objects (e.g. JSON/JSONB columns).
                        return v !== null && typeof v === 'object' && !(v instanceof Date)
                            ? JSON.stringify(v)
                            : v;
                    });
                    // Dump keys are camelCased by the driver; map them back to the
                    // real snake_case column names. Multi-word V2 columns not in the
                    // driver's COLUMN_MAP (e.g. contextType) would otherwise fold to
                    // lowercase (contexttype) and fail with "column does not exist".
                    const sqlCols = cols.map((c) =>
                        c.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
                    );
                    await db.run(
                        `INSERT INTO ${table} (${sqlCols.join(', ')}) VALUES (${placeholders})`,
                        values
                    );
                }
            }
        });

        return {
            success: true,
            message: 'Database restored successfully',
        };
    }
}

module.exports = new DatabaseCleanupService();
