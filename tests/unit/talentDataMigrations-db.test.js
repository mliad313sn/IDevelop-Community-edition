'use strict';
/**
 * Migrations 176–179, rehearsed on the REAL test database inside transactions
 * that are always rolled back. Each file is applied twice: the second run must
 * change nothing.
 *
 *  176  skill_assessments.validation: ONLY the rows whose note proves a
 *       promotion become 'manager_validated'; any other row stays 'self'.
 *  177  coaching_signoffs.actor_ref exists.
 *  178  every employee erased without a tombstone gets one, with the real
 *       erasure instant; an existing tombstone is never overwritten; the
 *       restore gate (reapplyTombstones' query) then sees the person.
 *  179  opportunity_applications.status admits exactly applied / withdrawn /
 *       accepted / declined; an install holding another value gets the CHECK
 *       NOT VALID (new rows checked, old rows untouched) instead of a failed
 *       migration; supervisor_reviews.priority_index is marked deprecated.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

const db = HAS_DB ? require('../../src/config/database') : null;
const MIG = (n) => {
    const dir = path.join(__dirname, '..', '..', 'db', 'postgres');
    const f = fs.readdirSync(dir).find((x) => x.startsWith(n + '_') && !/_down\.sql$/.test(x));
    return fs.readFileSync(path.join(dir, f), 'utf8');
};

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function inRolledBackTx(fn) {
    let out;
    await db
        .runTransaction(async () => {
            out = await fn();
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    return out;
}
const apply = (n) => db._client().query(MIG(n));

let seq = 0;
async function person() {
    const tpl = await db.get(
        'SELECT site_id, department_id, service_id, role_id FROM employees ORDER BY id LIMIT 1'
    );
    seq += 1;
    const r = await db.get(
        `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                service_id, role_id, is_active)
         VALUES (?, 'Data', ?, ?, ?, ?, ?, true) RETURNING id`,
        [
            `TDM-${Date.now()}-${seq}`,
            `Fixture ${seq}`,
            tpl.siteId,
            tpl.departmentId,
            tpl.serviceId,
            tpl.roleId,
        ]
    );
    return Number(r.id);
}

suite('migration 176: validation backfilled only where a promotion is proven', () => {
    test('promoted notes become manager_validated, everything else stays self; twice = once', async () => {
        const out = await inRolledBackTx(async () => {
            const a = await person();
            const b = await person();
            const admin = await db.get('SELECT id FROM admins ORDER BY id LIMIT 1');
            const skills = await db.all('SELECT id FROM skills ORDER BY id LIMIT 3');
            const plan = [
                [a, 0, 'Set from approved self-assessment'],
                [a, 1, 'Set from supervisor-validated rating'],
                [a, 2, 'Set by dispute resolution (final decided rating).'],
                [b, 0, 'Validated by supervisor review. Gap: -1'],
                [b, 1, 'Imported from the 2025 workbook'],
                [b, 2, null],
            ];
            for (const [emp, i, note] of plan)
                await db.run(
                    `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
                     VALUES (?, ?, 2, ?, ?)`,
                    [emp, skills[i].id, admin.id, note]
                );
            const count = () =>
                db.get(
                    'SELECT COUNT(*)::int AS n FROM assessment_history WHERE employee_id = ANY(?::bigint[])',
                    [[a, b]]
                );
            const historyBefore = await count();
            await apply('176');
            await apply('176');
            const rows = await db.all(
                `SELECT validation::text AS v, current_level FROM skill_assessments
                  WHERE employee_id = ANY(?::bigint[]) ORDER BY employee_id, skill_id`,
                [[a, b]]
            );
            const historyAfter = await count();
            return { rows, h0: historyBefore.n, h1: historyAfter.n };
        });
        expect(out.rows.map((r) => r.v)).toEqual([
            'manager_validated',
            'manager_validated',
            'manager_validated',
            'manager_validated',
            'self',
            'self',
        ]);
        expect(out.rows.every((r) => Number(r.currentLevel) === 2)).toBe(true);
        expect(out.h1).toBe(out.h0); // no history row: the level did not change
    });
});

suite('migration 177: coaching_signoffs.actor_ref', () => {
    test('the column exists and the file is idempotent', async () => {
        const out = await inRolledBackTx(async () => {
            await apply('177');
            await apply('177');
            return db.get(
                `SELECT data_type FROM information_schema.columns
                  WHERE table_name = 'coaching_signoffs' AND column_name = 'actor_ref'`
            );
        });
        expect(out && out.dataType).toBe('text');
    });
});

suite('migration 178: erasure tombstones for the people erased before 151', () => {
    test('a tombstone with the real instant; an existing one is kept; the restore gate sees the person', async () => {
        const out = await inRolledBackTx(async () => {
            const a = await person();
            const b = await person();
            await db.run(
                "UPDATE employees SET erased_at = '2024-03-04T05:06:07Z' WHERE id = ANY(?::bigint[])",
                [[a, b]]
            );
            await db.run(
                `INSERT INTO erasure_tombstones (subject_type, subject_id, erased_at, method)
                 VALUES ('employee', ?, '2024-03-05T00:00:00Z', 'dsr_erase')`,
                [b]
            );
            await apply('178');
            const n1 = await db.get('SELECT COUNT(*)::int AS n FROM erasure_tombstones');
            await apply('178');
            const n2 = await db.get('SELECT COUNT(*)::int AS n FROM erasure_tombstones');
            const ta = await db.get(
                "SELECT erased_at, method FROM erasure_tombstones WHERE subject_type = 'employee' AND subject_id = ?",
                [a]
            );
            const tb = await db.get(
                "SELECT erased_at, method FROM erasure_tombstones WHERE subject_type = 'employee' AND subject_id = ?",
                [b]
            );
            // A restore puts the person back: the gate must list them.
            await db.run('UPDATE employees SET erased_at = NULL WHERE id = ?', [a]);
            const stale = await db.all(
                `SELECT t.subject_id FROM erasure_tombstones t
                   JOIN employees e ON e.id = t.subject_id
                  WHERE t.subject_type = 'employee' AND e.erased_at IS NULL`
            );
            return { ta, tb, n1: n1.n, n2: n2.n, stale: stale.map((r) => Number(r.subjectId)), a };
        });
        expect(out.ta.method).toBe('backfill_151');
        expect(new Date(out.ta.erasedAt).toISOString()).toBe('2024-03-04T05:06:07.000Z');
        expect(out.tb.method).toBe('dsr_erase');
        expect(new Date(out.tb.erasedAt).toISOString()).toBe('2024-03-05T00:00:00.000Z');
        expect(out.n2).toBe(out.n1);
        expect(out.stale).toContain(out.a);
    });
});

suite('migration 179: opportunity_applications.status CHECK, priority_index deprecated', () => {
    async function opportunity() {
        const r = await db.get(
            `INSERT INTO opportunities (title) VALUES ('TDM opportunity') RETURNING id`
        );
        return Number(r.id);
    }
    const refused = async (fn) => {
        try {
            await db.runInSavepoint(fn);
            return null;
        } catch (e) {
            return e;
        }
    };

    test('the four written values pass, a fifth is refused; the comment marks the deprecated column', async () => {
        const out = await inRolledBackTx(async () => {
            await apply('179');
            await apply('179');
            const opp = await opportunity();
            const ok = [];
            for (const status of ['applied', 'withdrawn', 'accepted', 'declined']) {
                const emp = await person();
                const e = await refused(() =>
                    db.run(
                        'INSERT INTO opportunity_applications (opportunity_id, employee_id, status) VALUES (?, ?, ?)',
                        [opp, emp, status]
                    )
                );
                ok.push(e === null);
            }
            const emp = await person();
            const fifth = await refused(() =>
                db.run(
                    "INSERT INTO opportunity_applications (opportunity_id, employee_id, status) VALUES (?, ?, 'pending')",
                    [opp, emp]
                )
            );
            const con = await db.get(
                `SELECT convalidated FROM pg_constraint
                  WHERE conname = 'chk_opportunity_applications_status'`
            );
            const comment = await db.get(
                `SELECT col_description('public.supervisor_reviews'::regclass, a.attnum) AS c
                   FROM pg_attribute a
                  WHERE a.attrelid = 'public.supervisor_reviews'::regclass AND a.attname = 'priority_index'`
            );
            return { ok, fifth, con, comment: comment && comment.c };
        });
        expect(out.ok).toEqual([true, true, true, true]);
        expect(out.fifth && out.fifth.code).toBe('23514'); // check_violation
        expect(out.con.convalidated).toBe(true);
        expect(out.comment).toMatch(/^DEPRECATED/);
    });

    test('an install holding another value gets the CHECK NOT VALID, never a failed migration', async () => {
        const out = await inRolledBackTx(async () => {
            await db.run(
                'ALTER TABLE opportunity_applications DROP CONSTRAINT IF EXISTS chk_opportunity_applications_status'
            );
            const opp = await opportunity();
            const emp = await person();
            await db.run(
                "INSERT INTO opportunity_applications (opportunity_id, employee_id, status) VALUES (?, ?, 'legacy')",
                [opp, emp]
            );
            await apply('179');
            const con = await db.get(
                `SELECT convalidated FROM pg_constraint
                  WHERE conname = 'chk_opportunity_applications_status'`
            );
            const kept = await db.get(
                'SELECT status FROM opportunity_applications WHERE opportunity_id = ? AND employee_id = ?',
                [opp, emp]
            );
            const emp2 = await person();
            const fifth = await refused(() =>
                db.run(
                    "INSERT INTO opportunity_applications (opportunity_id, employee_id, status) VALUES (?, ?, 'legacy')",
                    [opp, emp2]
                )
            );
            return { con, kept, fifth };
        });
        expect(out.con.convalidated).toBe(false);
        expect(out.kept.status).toBe('legacy');
        expect(out.fifth && out.fifth.code).toBe('23514');
    });
});
