'use strict';
/**
 * SECTION accounts / B5 — one employee already holding an open IDP must not cost the WHOLE
 * cycle its development plans.
 *
 * `uq_idp_open_per_employee` (migration 64) permits exactly ONE draft-or-active
 * plan per employee ACROSS ALL CYCLES. `generateDrafts` deduped on `cycle_id`
 * only, so anyone carrying an open plan from an earlier cycle was selected, the
 * INSERT hit the index, and — the whole loop being one transaction — every plan
 * for the cycle rolled back. `jobs/index.js emitEvent` swallows the throw into a
 * console.warn, so the visible symptom was a cycle closing and producing nothing.
 * This path is now reachable in production: the cycle-deadline job locks and
 * closes an overdue cycle, which emits 'cycle.closed' -> generateDrafts.
 *
 * Probe BEFORE (rolled back, 3 employees with a real gap, employee 84 already
 * holding an open plan from an earlier cycle):
 *
 *   employee 84 already holds an OPEN plan from an earlier cycle
 *   generateDrafts THREW: 23505 duplicate key value violates unique constraint "uq_idp_open_per_employee"
 *   plans actually created for the cycle: 0 of 2
 *   VERDICT: DEFECT — one blocked employee wiped out draft generation for the WHOLE cycle
 *
 * Probe AFTER, same script:
 *
 *   [idp] cycle 31 — 1 employee(s) skipped: 84 (open_plan_exists)
 *   generateDrafts -> {"plans":2,"gaps":2,"skipped":[{"employeeId":84,"reason":"open_plan_exists"}]}
 *   plans actually created for the cycle: 2 of 2 that should have been
 *
 * And with the pre-check deliberately blinded back to `WHERE cycle_id = ?`, so
 * only the per-employee SAVEPOINT can save the run — proving the two layers
 * independently:
 *
 *   pre-check blinded — only the SAVEPOINT layer can save the cycle now
 *   generateDrafts -> {"plans":2,"gaps":2,"skipped":[{"employeeId":84,"reason":"open_plan_exists"}]}
 *
 * DB mocked here; the live behaviour is the rolled-back probe quoted above.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn() }));

const LogService = require('../../src/services/LogService');
const IDPService = require('../../src/services/IDPService');

const gap = (employeeId, skillId) => ({
    employeeId,
    skillId,
    currentLevel: 1,
    requiredLevel: 3,
    skillName: `Skill ${skillId}`,
});

/**
 * @param gaps            the rows generateDrafts selects
 * @param sameCycleOwners people who already have a plan FOR THIS CYCLE
 * @param openPlanOwners  people who hold an open plan from an EARLIER cycle —
 *                        these only come back if the lookup actually asks for
 *                        `status IN ('draft','active')`, so a lookup narrowed to
 *                        `cycle_id` cannot see them, exactly as in production
 * @param collideFor      employee ids whose idp_plans INSERT raises 23505 — the
 *                        race the pre-check cannot see
 */
function stub({ gaps = [], sameCycleOwners = [], openPlanOwners = [], collideFor = [] } = {}) {
    let seq = 100;
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    mockDb.get.mockResolvedValue(null);
    mockDb.all.mockImplementation(async (sql) => {
        if (/FROM supervisor_reviews sr/.test(sql)) return gaps;
        if (/FROM idp_plans/.test(sql)) {
            const ids = [...sameCycleOwners];
            if (/status IN \('draft', 'active'\)/.test(sql)) ids.push(...openPlanOwners);
            return ids.map((id) => ({ employeeId: id }));
        }
        return [];
    });
    // Anyone holding an open plan is rejected by uq_idp_open_per_employee if the
    // code gets as far as the INSERT — so the stub enforces the index, and a test
    // cannot pass merely because the lookup happened to filter them out.
    const rejects = [...new Set([...collideFor, ...openPlanOwners])];
    mockDb.run.mockImplementation(async (sql, params) => {
        if (/INSERT INTO idp_plans/.test(sql) && rejects.includes(Number(params[0]))) {
            const e = new Error(
                'duplicate key value violates unique constraint "uq_idp_open_per_employee"'
            );
            e.code = '23505';
            throw e;
        }
        return { lastID: ++seq, changes: 1 };
    });
}

/** Every db.run call whose SQL matches. */
const runs = (re) => mockDb.run.mock.calls.filter(([sql]) => re.test(sql));

beforeEach(() => {
    for (const m of Object.values(mockDb)) m.mockReset();
    LogService.log.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('B5 — the "already spoken for" lookup matches the database rule', () => {
    test('it spans ALL cycles, like uq_idp_open_per_employee does', async () => {
        stub({ gaps: [gap(85, 9)] });
        await IDPService.generateDrafts(7);
        const [lookup] = mockDb.all.mock.calls.filter(([sql]) => /FROM idp_plans/.test(sql));
        expect(lookup).toBeDefined();
        expect(lookup[0]).toMatch(/status IN \('draft', 'active'\)/);
    });

    test('it still covers re-runs of the same cycle (idempotence)', async () => {
        stub({ gaps: [gap(85, 9), gap(86, 9)], sameCycleOwners: [85] });
        const out = await IDPService.generateDrafts(7);
        const [lookup] = mockDb.all.mock.calls.filter(([sql]) => /FROM idp_plans/.test(sql));
        expect(lookup[0]).toMatch(/cycle_id = \?/);
        expect(lookup[1]).toEqual([7]);
        expect(runs(/INSERT INTO idp_plans/).map((c) => c[1][0])).toEqual([86]);
        expect(out.plans).toBe(1);
    });

    test('an employee already holding an open plan is skipped, and everyone else is served', async () => {
        stub({ gaps: [gap(84, 9), gap(85, 9), gap(86, 9)], openPlanOwners: [84] });
        const out = await IDPService.generateDrafts(7);
        expect(out.plans).toBe(2);
        expect(out.gaps).toBe(2);
        expect(out.skipped).toEqual([{ employeeId: 84, reason: 'open_plan_exists' }]);
        expect(runs(/INSERT INTO idp_plans/).map((c) => c[1][0])).toEqual([85, 86]);
    });
});

describe('B5 — a collision costs one person, never the cycle', () => {
    test('a 23505 the pre-check could not see is contained', async () => {
        // The pre-check is empty on purpose: this is the race, and the savepoint
        // is the only thing standing between one collision and an empty cycle.
        stub({ gaps: [gap(84, 9), gap(85, 9), gap(86, 9)], collideFor: [84] });
        const out = await IDPService.generateDrafts(7);
        expect(out.plans).toBe(2);
        expect(out.gaps).toBe(2);
        expect(out.skipped).toEqual([{ employeeId: 84, reason: 'open_plan_exists' }]);
    });

    test('generateDrafts does not throw the collision into the caller', async () => {
        stub({ gaps: [gap(84, 9)], collideFor: [84] });
        await expect(IDPService.generateDrafts(7)).resolves.toEqual(
            expect.objectContaining({ plans: 0, gaps: 0 })
        );
    });

    test('a person who collided is not retried on their remaining gaps', async () => {
        stub({ gaps: [gap(84, 9), gap(84, 10), gap(84, 11), gap(85, 9)], collideFor: [84] });
        const out = await IDPService.generateDrafts(7);
        expect(runs(/INSERT INTO idp_plans/).map((c) => c[1][0])).toEqual([84, 85]);
        expect(out.skipped).toHaveLength(1);
    });

    test('each plan is written inside its own savepoint', async () => {
        stub({ gaps: [gap(84, 9), gap(85, 9)] });
        await IDPService.generateDrafts(7);
        expect(mockDb.runInSavepoint).toHaveBeenCalledTimes(2);
    });
});

describe('B5 — a skip is never silent', () => {
    test('the skipped people and the reason are returned to the caller', async () => {
        stub({ gaps: [gap(84, 9)], openPlanOwners: [84] });
        const out = await IDPService.generateDrafts(7);
        expect(out).toHaveProperty('skipped');
        expect(out.skipped[0].reason).toBe('open_plan_exists');
    });

    test('and written to the audit trail, where an operator can find them', async () => {
        stub({ gaps: [gap(84, 9)], openPlanOwners: [84] });
        await IDPService.generateDrafts(7);
        expect(LogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'IDP_DRAFTS_SKIPPED', entityId: 7 })
        );
        expect(LogService.log.mock.calls[0][0].details).toMatch(/84 \(open_plan_exists\)/);
    });

    test('a clean run logs nothing — the audit line means something', async () => {
        stub({ gaps: [gap(85, 9)] });
        await IDPService.generateDrafts(7);
        expect(LogService.log).not.toHaveBeenCalled();
    });
});
