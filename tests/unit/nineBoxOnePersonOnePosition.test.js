'use strict';
/**
 * AMDEC C1 (criticality 648) — the 9-box grid plotted ONE person as three dots in
 * two boxes, and the roster badge and the dashboard tile gave two different answers
 * for the same person.
 *
 * REPRODUCED BY EXECUTION on idevelop before the fix: 37 non-archived rows for 11
 * people. Employee 87 held 10 rows, all drafts, spread over boxes 5 / 8 / 9 —
 * `grid()` selected every row with status <> 'archived' and `createDraft()` inserted
 * unconditionally with no unique index. Employee 88 held 7 approved rows in box 1
 * plus 2 drafts in box 8: the roster showed the unapproved DRAFT with no marker, the
 * employee dashboard showed the APPROVED placement, and the talent-development
 * dashboard COUNTed all 7 approved rows, so one person contributed seven people to
 * the "Concern" cell of the distribution.
 *
 * THE RULE (migration 95 + NineBoxService):
 *   A placement is what has been APPROVED. A draft is a proposal, never a position.
 *   At most one open proposal and at most one approved placement per employee;
 *   approving supersedes the previous approval by archiving it; the grid, the roster
 *   badge and the dashboard all resolve the SAME row through one precedence.
 *
 * These are BEHAVIOURAL tests against the real database, because the invariant lives
 * in SQL (a DISTINCT ON and two partial unique indexes) — a mocked driver would
 * return whatever the test stubbed and prove nothing. Every write runs inside a
 * transaction that is rolled back, and the file asserts the counts are unchanged
 * afterwards. All fixtures are prefixed UAT-.
 */

require('dotenv').config();
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/idevelop';

const db = require('../../src/config/database');
const NineBox = require('../../src/services/NineBoxService');

const ROLLBACK = '__ROLLBACK__';
/** Run `fn` and always undo its writes. Returns whatever fn resolved to. */
async function inRolledBackTx(fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            out = await fn();
            throw new Error(ROLLBACK);
        });
    } catch (e) {
        if (!e || e.message !== ROLLBACK) throw e;
    }
    return out;
}

let reachable = false;
let USER = null;
let EMP = null; // an employee with no 9-box row at all
let baseline = null;

beforeAll(async () => {
    try {
        await db.connect();
        const a = await db.get('SELECT id, username, role FROM admins ORDER BY id LIMIT 1');
        USER = { id: Number(a.id), userType: 'admin', role: a.role, username: a.username };
        const e = await db.get(
            `SELECT e.id FROM employees e
              WHERE e.is_active
                AND NOT EXISTS (SELECT 1 FROM nine_box_evaluations n WHERE n.employee_id = e.id)
              ORDER BY e.id LIMIT 1`
        );
        EMP = Number(e.id);
        baseline = await db.get('SELECT COUNT(*) AS n FROM nine_box_evaluations');
        reachable = Boolean(USER && EMP);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[nineBoxOnePersonOnePosition] Postgres unreachable:', err && err.message);
    }
}, 30000);

afterAll(async () => {
    if (reachable) {
        const after = await db.get('SELECT COUNT(*) AS n FROM nine_box_evaluations');
        expect(Number(after.n)).toBe(Number(baseline.n));
    }
    await db.close().catch(() => {});
});

const insertRow = (employeeId, status, perf, pot, box, extra = '') =>
    db.get(
        `INSERT INTO nine_box_evaluations
        (employee_id, performance, potential, box, box_label, status, clearance,
         cell_tier, cell_trend, position_source, comments${status === 'approved' ? ', approved_at' : ''})
     VALUES (?, ?, ?, ?, 'UAT-fixture', ?, 'confidential', 2, 'stable', 'manager', 'UAT-C1'${status === 'approved' ? ', now()' : ''})
     RETURNING id, status${extra}`,
        [employeeId, perf, pot, box, status]
    );

describe('AMDEC C1 — one person, one position', () => {
    test('Postgres is reachable (these tests are worthless without it)', () => {
        expect(reachable).toBe(true);
    });

    test('a second OPEN proposal for the same employee is refused by the database', async () => {
        const err = await inRolledBackTx(async () => {
            await insertRow(EMP, 'draft', 'medium', 'medium', 5);
            try {
                await insertRow(EMP, 'draft', 'high', 'high', 9);
                return null;
            } catch (e) {
                return e;
            }
        });
        expect(err).toBeTruthy();
        // 23505 = unique_violation, from uq_ninebox_open_per_employee (migration 95).
        expect(err.code).toBe('23505');
    });

    test('a second APPROVED placement for the same employee is refused by the database', async () => {
        const err = await inRolledBackTx(async () => {
            await insertRow(EMP, 'approved', 'low', 'low', 1);
            try {
                await insertRow(EMP, 'approved', 'high', 'high', 9);
                return null;
            } catch (e) {
                return e;
            }
        });
        expect(err).toBeTruthy();
        expect(err.code).toBe('23505');
    });

    test('archived and rejected rows do not consume the slot (history stays writable)', async () => {
        const ok = await inRolledBackTx(async () => {
            await insertRow(EMP, 'archived', 'low', 'low', 1);
            await insertRow(EMP, 'archived', 'high', 'high', 9);
            await insertRow(EMP, 'rejected', 'medium', 'medium', 5);
            await insertRow(EMP, 'rejected', 'low', 'high', 3);
            const r = await db.get(
                'SELECT COUNT(*) AS n FROM nine_box_evaluations WHERE employee_id = ?',
                [EMP]
            );
            return Number(r.n);
        });
        expect(ok).toBe(4);
    });

    test('grid() plots each employee exactly ONCE, on the approved placement', async () => {
        const out = await inRolledBackTx(async () => {
            await insertRow(EMP, 'approved', 'low', 'low', 1);
            await insertRow(EMP, 'draft', 'medium', 'high', 8);
            await insertRow(EMP, 'archived', 'high', 'high', 9);
            await insertRow(EMP, 'rejected', 'low', 'high', 3);
            const grid = await NineBox.grid(USER);
            return grid.filter((r) => Number(r.employeeId) === EMP);
        });
        expect(out).toHaveLength(1);
        expect(out[0].status).toBe('approved');
        expect(Number(out[0].box)).toBe(1);
        // The draft is reported as a PENDING PROPOSAL, never as the position.
        expect(out[0].provisional).toBe(false);
        expect(out[0].pendingProposal).toBe(true);
    });

    test('with no approval, the grid shows the proposal MARKED as provisional', async () => {
        const out = await inRolledBackTx(async () => {
            await insertRow(EMP, 'draft', 'medium', 'high', 8);
            const grid = await NineBox.grid(USER);
            return grid.filter((r) => Number(r.employeeId) === EMP);
        });
        expect(out).toHaveLength(1);
        expect(out[0].status).toBe('draft');
        expect(out[0].provisional).toBe(true);
        expect(out[0].pendingProposal).toBe(false);
    });

    test('grid() never plots an archived or rejected row as a position', async () => {
        const out = await inRolledBackTx(async () => {
            await insertRow(EMP, 'archived', 'high', 'high', 9);
            await insertRow(EMP, 'rejected', 'low', 'high', 3);
            const grid = await NineBox.grid(USER);
            return grid.filter((r) => Number(r.employeeId) === EMP);
        });
        expect(out).toHaveLength(0);
    });

    test('the roster badge and the grid answer with the SAME row for the same person', async () => {
        const out = await inRolledBackTx(async () => {
            await insertRow(EMP, 'approved', 'low', 'low', 1);
            await insertRow(EMP, 'draft', 'medium', 'high', 8);
            const grid = (await NineBox.grid(USER)).filter((r) => Number(r.employeeId) === EMP);
            const roster = (await NineBox.roster(USER)).filter((r) => Number(r.employeeId) === EMP);
            return { grid, roster };
        });
        expect(out.grid).toHaveLength(1);
        expect(out.roster).toHaveLength(1);
        const [g] = out.grid;
        const [r] = out.roster;
        expect(Number(r.placement.id)).toBe(Number(g.id));
        expect(Number(r.placement.box)).toBe(Number(g.box));
        expect(r.placement.status).toBe('approved');
        expect(r.provisional).toBe(false);
        // The unapproved draft is surfaced separately, with its own id and box.
        expect(r.pendingProposal).toBeTruthy();
        expect(r.pendingProposal.box).toBe(8);
        expect(r.pendingProposal.status).toBe('draft');
    });

    test('the roster marks a badge that is only a proposal', async () => {
        const out = await inRolledBackTx(async () => {
            await insertRow(EMP, 'draft', 'medium', 'high', 8);
            return (await NineBox.roster(USER)).filter((r) => Number(r.employeeId) === EMP);
        });
        expect(out).toHaveLength(1);
        expect(out[0].provisional).toBe(true);
        expect(out[0].placement.status).toBe('draft');
        expect(out[0].pendingProposal).toBeNull();
        // No approval → still due for a decision.
        expect(out[0].dueForReassessment).toBe(true);
    });

    test('re-assessing an open proposal EDITS it — it never becomes a second dot', async () => {
        const out = await inRolledBackTx(async () => {
            const a = await NineBox.createDraft(USER, {
                employeeId: EMP,
                performance: 'medium',
                potential: 'medium',
                comments: 'UAT-C1 first',
            });
            const b = await NineBox.createDraft(USER, {
                employeeId: EMP,
                performance: 'high',
                potential: 'high',
                comments: 'UAT-C1 second',
            });
            const rows = await db.all(
                `SELECT id, status, box FROM nine_box_evaluations
                  WHERE employee_id = ? AND status IN ('draft','under_review') ORDER BY id`,
                [EMP]
            );
            return { a: Number(a.id), b: Number(b.id), rows, box: Number(b.box) };
        });
        expect(out.rows).toHaveLength(1);
        expect(out.b).toBe(out.a);
        expect(out.box).toBe(9);
        expect(Number(out.rows[0].box)).toBe(9);
    });

    test('approving supersedes the previous approval instead of stacking beside it', async () => {
        const out = await inRolledBackTx(async () => {
            const old = await insertRow(EMP, 'approved', 'low', 'low', 1);
            const fresh = await NineBox.createDraft(USER, {
                employeeId: EMP,
                performance: 'high',
                potential: 'high',
                comments: 'UAT-C1 new',
            });
            await NineBox.approve(USER, fresh.id);
            const rows = await db.all(
                'SELECT id, status FROM nine_box_evaluations WHERE employee_id = ? ORDER BY id',
                [EMP]
            );
            const events = await db.all(
                "SELECT action, from_status, to_status FROM nine_box_events WHERE evaluation_id = ? AND action = 'supersede'",
                [old.id]
            );
            return { oldId: Number(old.id), newId: Number(fresh.id), rows, events };
        });
        const byId = Object.fromEntries(out.rows.map((r) => [Number(r.id), r.status]));
        expect(byId[out.oldId]).toBe('archived');
        expect(byId[out.newId]).toBe('approved');
        expect(out.rows.filter((r) => r.status === 'approved')).toHaveLength(1);
        // The supersession is auditable, not silent.
        expect(out.events).toHaveLength(1);
        expect(out.events[0].toStatus).toBe('archived');
    });

    test('a superseded approval is still readable as history (placementTrend)', async () => {
        const out = await inRolledBackTx(async () => {
            await insertRow(EMP, 'approved', 'low', 'low', 1);
            const fresh = await NineBox.createDraft(USER, {
                employeeId: EMP,
                performance: 'high',
                potential: 'high',
            });
            await NineBox.approve(USER, fresh.id);
            return NineBox.placementTrend(EMP, USER);
        });
        expect(out.length).toBe(2);
        expect(out.map((r) => Number(r.box)).sort()).toEqual([1, 9]);
    });
});
