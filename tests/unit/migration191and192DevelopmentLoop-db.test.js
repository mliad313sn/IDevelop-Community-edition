'use strict';
/**
 * Migrations 191 (idp_action_progress) and 192 (dev_proposals) against the
 * REAL schema, inside transactions that are always rolled back.
 *
 *   - both are idempotent: a re-run changes nothing and raises nothing;
 *   - both end by keeping the SQL console reader in step (migration 168);
 *   - the CHECKs bind: negative hours, an unknown evidence source, an unknown
 *     proposal status / route / type, an empty proposal are refused;
 *   - an install that already holds negative planned hours upgrades anyway:
 *     the hours constraint is added NOT VALID, never a failed migration;
 *   - the free-text columns are in the erasure registry.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(60000);

const db = HAS_DB ? require('../../src/config/database') : null;
const read = (f) => fs.readFileSync(path.join(__dirname, '../../db/postgres', f), 'utf8');
const MIG191 = read('191_idp_action_progress.sql');
const MIG192 = read('192_dev_proposals.sql');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ROLLBACK = new Error('__MIG191_ROLLBACK__');
async function inRolledBackTx(fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            out = await fn(db._txStore.getStore());
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
    return out;
}
async function refused(q, sql, params = []) {
    await q.query('SAVEPOINT probe');
    try {
        await q.query(sql, params);
        await q.query('RELEASE SAVEPOINT probe');
        return null;
    } catch (e) {
        await q.query('ROLLBACK TO SAVEPOINT probe');
        return e.code || 'error';
    }
}

describe('the migration files', () => {
    test('each ends by syncing the console reader, and qualifies its tables', () => {
        for (const sql of [MIG191, MIG192]) {
            expect(sql.trim().endsWith('SELECT public.fn_console_reader_sync();')).toBe(true);
            expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
            expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
        }
        expect(MIG191).toMatch(/ALTER TABLE public\.idp_actions ADD COLUMN IF NOT EXISTS/);
        expect(MIG192).toMatch(/CREATE TABLE IF NOT EXISTS public\.dev_proposals/);
    });

    test('the person-bearing free text is in the erasure registry', () => {
        const { SUBJECT_DATA_REGISTRY: reg } = require('../../src/services/erasureRegistry');
        const DSR = require('../../src/services/DSRService');
        const acts = reg.find((e) => e.table === 'idp_actions' && e.key === 'idpActionNotes');
        expect(acts).toMatchObject({ treatment: 'redacted', export: 'idpActionNotes' });
        const dp = reg.find((e) => e.table === 'dev_proposals' && e.column === 'employee_id');
        expect(dp).toMatchObject({ treatment: 'redacted', key: 'devProposals' });
        const red = Object.fromEntries(DSR.REDACTED_ON_ERASURE.map((c) => [c.key, c]));
        expect(red.idpActionNotes.erased).toEqual(['reported_note', 'validation_note']);
        expect(red.devProposals.erased).toEqual(['proposal_text', 'decision_reason']);
        const golive = require('../../scripts/reset-for-golive');
        expect(golive.WIPE.has('dev_proposals')).toBe(true);
    });
});

suite('migrations 191 and 192 on the real schema', () => {
    test('a re-run is a no-op, and the checks bind', async () => {
        const out = await inRolledBackTx(async (q) => {
            await q.query(MIG191);
            await q.query(MIG192);
            await q.query(MIG191);
            await q.query(MIG192);
            const cols = await q.query(
                `SELECT table_name, column_name FROM information_schema.columns
                  WHERE table_schema = 'public'
                    AND ((table_name = 'idp_actions' AND column_name IN ('reported_done_at', 'reported_note',
                          'reported_by_type', 'reported_by_id', 'validated_by_type', 'validated_by_id',
                          'validation_note', 'actual_hours', 'due_on', 'place'))
                      OR (table_name = 'action_effectiveness' AND column_name IN ('evidence_source', 'official'))
                      OR (table_name IN ('idp_objectives', 'idp_plans') AND column_name = 'target_role_id'))`
            );
            const plan = await q.query(
                `INSERT INTO idp_plans (employee_id, status)
                 SELECT id, 'archived' FROM employees ORDER BY id LIMIT 1 RETURNING id, employee_id`
            );
            const idpId = plan.rows[0].id;
            const emp = plan.rows[0].employee_id;
            const act = await q.query(
                `INSERT INTO idp_actions (idp_id, type, title, status) VALUES ($1, 'training', 't', 'pending')
                 RETURNING id`,
                [idpId]
            );
            const aid = act.rows[0].id;
            const r = {
                cols: cols.rows.length,
                negHours: await refused(
                    q,
                    'UPDATE idp_actions SET actual_hours = -1 WHERE id = $1',
                    [aid]
                ),
                negPlanned: await refused(
                    q,
                    'UPDATE idp_actions SET estimated_hours = -2 WHERE id = $1',
                    [aid]
                ),
                badReporter: await refused(
                    q,
                    "UPDATE idp_actions SET reported_by_type = 'robot' WHERE id = $1",
                    [aid]
                ),
                badSource: await refused(
                    q,
                    `INSERT INTO action_effectiveness (action_id, rating_pre, rating_post, uplift, evidence_source)
                     VALUES ($1, 1, 2, 1, 'rumour')`,
                    [aid]
                ),
                okSource: await refused(
                    q,
                    `INSERT INTO action_effectiveness (action_id, rating_pre, rating_post, uplift, evidence_source)
                     VALUES ($1, 1, 2, 1, 'coaching')`,
                    [aid]
                ),
                badStatus: await refused(
                    q,
                    "INSERT INTO dev_proposals (employee_id, proposal_text, status) VALUES ($1, 'x', 'maybe')",
                    [emp]
                ),
                badRoute: await refused(
                    q,
                    "INSERT INTO dev_proposals (employee_id, proposal_text, routed_to) VALUES ($1, 'x', 'ceo')",
                    [emp]
                ),
                badType: await refused(
                    q,
                    "INSERT INTO dev_proposals (employee_id, proposal_text, action_type) VALUES ($1, 'x', 'golf')",
                    [emp]
                ),
                empty: await refused(
                    q,
                    "INSERT INTO dev_proposals (employee_id, proposal_text) VALUES ($1, '   ')",
                    [emp]
                ),
                ok: await refused(
                    q,
                    "INSERT INTO dev_proposals (employee_id, proposal_text) VALUES ($1, 'Shadow a colleague')",
                    [emp]
                ),
            };
            const ae = await q.query(
                'SELECT official FROM action_effectiveness WHERE action_id = $1',
                [aid]
            );
            r.officialDefault = ae.rows[0].official;
            return r;
        });
        expect(out.cols).toBe(14);
        expect(out.negHours).toBe('23514');
        expect(out.negPlanned).toBe('23514');
        expect(out.badReporter).toBe('23514');
        expect(out.badSource).toBe('23514');
        expect(out.okSource).toBeNull();
        expect(out.officialDefault).toBe(false);
        expect(out.badStatus).toBe('23514');
        expect(out.badRoute).toBe('23514');
        expect(out.badType).toBe('23514');
        expect(out.empty).toBe('23514');
        expect(out.ok).toBeNull();
    });

    test('negative planned hours already in place: the constraint is added NOT VALID, the upgrade passes', async () => {
        const out = await inRolledBackTx(async (q) => {
            await q.query(
                'ALTER TABLE idp_actions DROP CONSTRAINT IF EXISTS chk_idp_actions_hours_nonneg'
            );
            const plan = await q.query(
                `INSERT INTO idp_plans (employee_id, status)
                 SELECT id, 'archived' FROM employees ORDER BY id LIMIT 1 RETURNING id`
            );
            await q.query(
                `INSERT INTO idp_actions (idp_id, type, title, status, estimated_hours)
                 VALUES ($1, 'training', 'legacy', 'pending', -4)`,
                [plan.rows[0].id]
            );
            await q.query(MIG191);
            const c = await q.query(
                "SELECT convalidated FROM pg_constraint WHERE conname = 'chk_idp_actions_hours_nonneg'"
            );
            return c.rows[0];
        });
        expect(out).toEqual({ convalidated: false });
    });
});
