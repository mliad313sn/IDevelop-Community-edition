'use strict';
/**
 * 3.23.18 lane P-privacy — the same S-07 behaviour on the REAL test database
 * (idevelop_fixtures), inside ONE transaction that is always rolled back: migration
 * 151 is applied in the transaction, a leaver is made due, the report pass
 * touches nothing, the apply pass erases through DSRService.erase and leaves a
 * tombstone, a simulated restore brings the person back and the tombstone
 * erases them again, and a reporting loop is found by the cycle query.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');

const HAS_DB = !!process.env.DATABASE_URL && /_test\b/.test(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', '..', 'db', 'postgres', '151_retention_purge_tombstones.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function inRolledBackTx(fn) {
    let result = null;
    await db
        .runTransaction(async () => {
            await db._client().query(MIGRATION);
            result = await fn();
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    return result;
}

suite('S-07 on the real schema (rolled back)', () => {
    jest.setTimeout(60000);
    const DSR = () => require('../../src/services/DSRService');

    test('report → apply → restore → re-apply, and the ledger / tombstone trail', async () => {
        const out = await inRolledBackTx(async () => {
            const emp = await db.get(
                `SELECT id FROM employees WHERE erased_at IS NULL AND cancelled_at IS NULL
                  ORDER BY id DESC LIMIT 1`
            );
            if (!emp) return null;
            const id = Number(emp.id);
            await db.run('UPDATE employees SET is_active = false WHERE id = ?', [id]);
            await db.run('DELETE FROM pii_cleanup_jobs WHERE employee_id = ?', [id]);
            await db.run(
                "INSERT INTO pii_cleanup_jobs (employee_id, country_code, due_at) VALUES (?, 'SN', now() - interval '2 days')",
                [id]
            );
            // Other due jobs of the fixture base must not be erased by this test.
            await db.run(
                "UPDATE pii_cleanup_jobs SET legal_hold_at = now(), legal_hold_reason = 'test' WHERE employee_id <> ? AND completed_at IS NULL",
                [id]
            );

            const rep = await DSR().runRetention({ mode: 'report' });
            const afterReport = await db.get(
                'SELECT erased_at, first_name FROM employees WHERE id = ?',
                [id]
            );
            const status = await DSR().retentionStatus();

            const app = await DSR().runRetention({ mode: 'apply' });
            const afterApply = await db.get(
                'SELECT erased_at, first_name FROM employees WHERE id = ?',
                [id]
            );
            const job = await db.get(
                'SELECT completed_at FROM pii_cleanup_jobs WHERE employee_id = ?',
                [id]
            );
            const tomb = await db.get(
                "SELECT method FROM erasure_tombstones WHERE subject_type = 'employee' AND subject_id = ?",
                [id]
            );
            const ledger = await db.all(
                'SELECT mode, action FROM retention_ledger WHERE subject_id = ? ORDER BY id',
                [id]
            );
            const again = await DSR().runRetention({ mode: 'apply' });

            // A restore of a backup taken BEFORE the erasure:
            await db.run(
                "UPDATE employees SET erased_at = NULL, first_name = 'Restored', email = 'restored@example.test' WHERE id = ?",
                [id]
            );
            const re = await DSR().reapplyTombstones({ source: 'test', file: null });
            const afterReapply = await db.get(
                'SELECT erased_at, first_name, email FROM employees WHERE id = ?',
                [id]
            );
            return {
                id,
                rep,
                afterReport,
                status,
                app,
                afterApply,
                job,
                tomb,
                ledger,
                again,
                re,
                afterReapply,
            };
        });
        expect(out).not.toBeNull(); // the fixture base has employees — never pass vacuously
        expect(out.rep.counts.would_erase).toBe(1);
        expect(out.afterReport.erasedAt).toBeNull();
        expect(out.afterReport.firstName).not.toBe('Erased');
        expect(out.status.due.some((d) => Number(d.employeeId) === out.id)).toBe(true);
        expect(out.status.lastRun.mode).toBe('report');
        expect(out.status.tombstones).not.toBeNull();
        // every panel query is MEASURED on the real schema (null would mean a bad query)
        expect(out.status.periods).not.toBeNull();
        expect(out.status.pendingNotDue).not.toBeNull();
        expect(out.status.unscheduledLeavers).not.toBeNull();

        expect(out.app.counts.erased).toBe(1);
        expect(out.afterApply.erasedAt).not.toBeNull();
        expect(out.afterApply.firstName).toBe('Erased');
        expect(out.job.completedAt).not.toBeNull();
        expect(out.tomb.method).toBe('retention_purge');
        expect(out.ledger).toEqual([
            { mode: 'report', action: 'would_erase' },
            { mode: 'apply', action: 'erased' },
        ]);
        expect(out.again.counts.erased).toBeUndefined(); // idempotent

        expect(out.re.reapplied).toContain(out.id);
        expect(out.re.failed).toEqual([]);
        expect(out.afterReapply.erasedAt).not.toBeNull();
        expect(out.afterReapply.firstName).toBe('Erased');
        expect(out.afterReapply.email).not.toMatch(/restored@/);
    });

    test('the cycle query finds a two-person reporting loop exactly once', async () => {
        const Snap = require('../../src/services/SnapshotService');
        const out = await inRolledBackTx(async () => {
            const two = await db.all('SELECT id FROM employees ORDER BY id LIMIT 2');
            if (two.length < 2) return null;
            const [a, b] = two.map((r) => Number(r.id));
            const before = await Snap.findReportingCycles();
            await db.run('UPDATE employees SET supervisor_id = ? WHERE id = ?', [b, a]);
            await db.run('UPDATE employees SET supervisor_id = ? WHERE id = ?', [a, b]);
            const after = await Snap.findReportingCycles();
            return { a, b, before, after };
        });
        expect(out).not.toBeNull();
        const key = (c) => c.join(',');
        const expected = [Math.min(out.a, out.b), Math.max(out.a, out.b), Math.min(out.a, out.b)];
        expect(Array.isArray(out.before)).toBe(true);
        expect(out.after.map(key)).toContain(key(expected));
        expect(out.after.filter((c) => key(c) === key(expected))).toHaveLength(1);
    });
});
