'use strict';
/**
 * Migration 193 (review_records, newInRoleMonths) — the file, and the REAL
 * schema inside transactions that are always rolled back.
 *
 *   - idempotent (a re-run changes nothing and raises nothing), public.
 *     qualified, ends by keeping the SQL console reader in step;
 *   - the setting newInRoleMonths is seeded (6) and is NOT security-class;
 *   - the table is append-only for every destructive path (block_mutation on
 *     DELETE, so append_only_tables() and the cleanup find it) while its own
 *     guard lets only the comment change;
 *   - the snapshot must be an object, the comment is at most 4000 characters,
 *     one record per person and campaign;
 *   - the person's comment is in the erasure registry, the export and the
 *     compliance register; the go-live reset wipes the table; the cleanup
 *     and the restore-point revert list it.
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
const MIG = fs.readFileSync(
    path.join(__dirname, '../../db/postgres', '193_review_records.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ROLLBACK = new Error('__MIG193_ROLLBACK__');
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

describe('the migration file and the lists that must know the table', () => {
    test('idempotent forms only, qualified, ends with the console sync', () => {
        expect(MIG.trim().endsWith('SELECT public.fn_console_reader_sync();')).toBe(true);
        expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS public\.review_records/);
        expect(MIG).toMatch(/ON CONFLICT \(setting_key\) DO NOTHING/);
        expect(MIG).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
        expect(MIG).not.toMatch(/\bDELETE\s+FROM\b/i);
        expect(MIG).toMatch(
            /BEFORE DELETE ON public\.review_records[\s\S]{0,80}public\.block_mutation\(\)/
        );
    });

    test('erasure, export, register, cleanup, revert and go-live reset know it', () => {
        const { SUBJECT_DATA_REGISTRY: reg } = require('../../src/services/erasureRegistry');
        expect(
            reg.find((e) => e.table === 'review_records' && e.column === 'employee_id')
        ).toMatchObject({
            treatment: 'redacted',
            key: 'reviewRecords',
        });
        const DSR = require('../../src/services/DSRService');
        const red = Object.fromEntries(DSR.REDACTED_ON_ERASURE.map((c) => [c.key, c]));
        expect(red.reviewRecords.erased).toEqual(['employee_comment']);
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/ComplianceRegisterService.js'),
            'utf8'
        );
        expect(src).toMatch(/\{ key: 'reviewRecords', group: 'skills', audience: 'self_admins' \}/);
        for (const lang of ['fr', 'en'])
            expect(require(`../../locales/${lang}/compliance.json`).cat_reviewRecords).toBeTruthy();
        const cleanup = require('../../src/services/DatabaseCleanupService');
        expect(cleanup.isImmutable('review_records')).toBe(true);
        expect(require('../../src/services/SqlConsoleService').PROTECTED_TABLES).toContain(
            'review_records'
        );
        const golive = require('../../scripts/reset-for-golive');
        expect(golive.WIPE.has('review_records')).toBe(true);
        // a row trigger only: the TRUNCATE of the reset needs no guard lifted
        expect(golive.APPEND_ONLY_WIPE).not.toContain('review_records');
    });

    test('newInRoleMonths is an ordinary setting with a rule and labels', () => {
        const { isSecurityClassSetting } = require('../../src/utils/securitySettings');
        expect(isSecurityClassSetting('newInRoleMonths', 'readiness')).toBe(false);
        for (const lang of ['fr', 'en']) {
            const a = require(`../../locales/${lang}/admin.json`);
            expect(a.set_name_newInRoleMonths).toBeTruthy();
            expect(a.set_desc_newInRoleMonths).toBeTruthy();
        }
    });
});

suite('migration 193 on the real schema', () => {
    test('a re-run is a no-op; the checks and the guards bind', async () => {
        const out = await inRolledBackTx(async (q) => {
            await q.query(MIG);
            await q.query(MIG);
            const setting = await q.query(
                "SELECT setting_value, category FROM app_settings WHERE setting_key = 'newInRoleMonths'"
            );
            const trg = await q.query(
                `SELECT t.tgname FROM pg_trigger t WHERE t.tgrelid = 'public.review_records'::regclass
                   AND NOT t.tgisinternal ORDER BY 1`
            );
            const aot = await q.query('SELECT table_name FROM public.append_only_tables()');
            const e = await q.query('SELECT id FROM employees ORDER BY id LIMIT 1');
            const a = await q.query('SELECT id FROM admins ORDER BY id LIMIT 1');
            const c = await q.query(
                `INSERT INTO assessment_cycles (code, label, opened_at, closes_at, status, created_by)
                 VALUES ('MIG193', 'Mig 193', now() - interval '9 days', now() - interval '1 day', 'closed', $1)
                 RETURNING id`,
                [a.rows[0].id]
            );
            const emp = e.rows[0].id;
            const cyc = c.rows[0].id;
            const r = {
                notObject: await refused(
                    q,
                    `INSERT INTO review_records (employee_id, cycle_id, snapshot) VALUES ($1, $2, '[]'::jsonb)`,
                    [emp, cyc]
                ),
                tooLong: await refused(
                    q,
                    `INSERT INTO review_records (employee_id, cycle_id, snapshot, employee_comment)
                     VALUES ($1, $2, '{}'::jsonb, repeat('x', 4001))`,
                    [emp, cyc]
                ),
                ok: await refused(
                    q,
                    `INSERT INTO review_records (employee_id, cycle_id, snapshot) VALUES ($1, $2, '{"v":1}'::jsonb)`,
                    [emp, cyc]
                ),
                twice: await refused(
                    q,
                    `INSERT INTO review_records (employee_id, cycle_id, snapshot) VALUES ($1, $2, '{"v":1}'::jsonb)`,
                    [emp, cyc]
                ),
                comment: await refused(
                    q,
                    `UPDATE review_records SET employee_comment = 'mine', comment_at = now()
                      WHERE employee_id = $1 AND cycle_id = $2`,
                    [emp, cyc]
                ),
                snapshot: await refused(
                    q,
                    `UPDATE review_records SET snapshot = '{"v":2}'::jsonb WHERE employee_id = $1 AND cycle_id = $2`,
                    [emp, cyc]
                ),
                move: await refused(
                    q,
                    `UPDATE review_records SET employee_id = employee_id + 0, cycle_id = $2
                      WHERE employee_id = $1 AND cycle_id = $2`,
                    [emp, cyc]
                ),
                del: await refused(
                    q,
                    'DELETE FROM review_records WHERE employee_id = $1 AND cycle_id = $2',
                    [emp, cyc]
                ),
            };
            // The cleanup's way: block_mutation suspended in the transaction, the
            // row goes (by cascade from employees, or directly).
            await q.query(
                'ALTER TABLE public.review_records DISABLE TRIGGER trg_review_records_no_delete'
            );
            r.delSuspended = await refused(
                q,
                'DELETE FROM review_records WHERE employee_id = $1 AND cycle_id = $2',
                [emp, cyc]
            );
            await q.query(
                'ALTER TABLE public.review_records ENABLE TRIGGER trg_review_records_no_delete'
            );
            return {
                setting: setting.rows[0],
                triggers: trg.rows.map((x) => x.tgname),
                aot: aot.rows.map((x) => x.table_name),
                r,
            };
        });
        expect(out.setting).toEqual({ setting_value: '6', category: 'readiness' });
        expect(out.triggers).toEqual(['trg_review_records_guard', 'trg_review_records_no_delete']);
        expect(out.aot).toContain('review_records');
        expect(out.r.notObject).toBe('23514');
        expect(out.r.tooLong).toBe('23514');
        expect(out.r.ok).toBeNull();
        expect(out.r.twice).toBe('23505');
        expect(out.r.comment).toBeNull();
        expect(out.r.snapshot).toBe('23514');
        expect(out.r.move).toBeNull(); // nothing actually changed: the guard compares values
        expect(out.r.del).toBe('23514');
        expect(out.r.delSuspended).toBeNull();
    });
});
