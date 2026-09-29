'use strict';

/**
 * Re-audit J1 — fit-history skipped the whole tick when ANY row existed for
 * today (SELECT 1 ... LIMIT 1), and had no per-role catch. So a run that wrote
 * some roles and then failed on one left a PERMANENT hole in the trend: every
 * retry saw a row, said "already_today", and never healed the missing roles.
 *
 * The tick now checks COMPLETENESS (every role getFit returns is snapped today,
 * kpi-snapshot's isDayComplete), fills exactly the missing roles, and catches
 * per role so one failure neither aborts the pass nor locks the day.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockRun = jest.fn(async () => ({}));
const mockAll = jest.fn(async () => []);
jest.mock('../../src/config/database', () => ({
    run: (...a) => mockRun(...a),
    all: (...a) => mockAll(...a),
    get: jest.fn(async () => null),
}));

const mockGetFit = jest.fn(async () => []);
jest.mock('../../src/models/BenchmarkModel', () => ({ getFit: (...a) => mockGetFit(...a) }));

const tick = () => require('../../src/jobs/fit-history').tick();
const ROLES = [
    { roleId: 1, occupants: 2, coverage: 50, benchmarkFit: 70, criticalFit: 80 },
    { roleId: 2, occupants: 1, coverage: 0, benchmarkFit: 0, criticalFit: 0 }, // unmeasured
    { roleId: 3, occupants: 3, coverage: 90, benchmarkFit: 88, criticalFit: 95 },
];
const insertedRoleIds = () =>
    mockRun.mock.calls
        .filter((c) => /INSERT INTO benchmark_fit_history/.test(c[0]))
        .map((c) => c[1][0]);

beforeEach(() => {
    jest.clearAllMocks();
    mockGetFit.mockResolvedValue(ROLES);
    mockAll.mockResolvedValue([]); // nothing snapped yet
});

describe('J1 — a partial day is healed, never locked', () => {
    test('a partial prior run: only the MISSING roles are filled, not skipped', async () => {
        mockAll.mockResolvedValue([{ role_id: 1 }]); // role 1 already snapped earlier today
        const out = await tick();
        expect(out.skipped).toBeUndefined(); // NOT "already_today"
        expect(insertedRoleIds().sort()).toEqual([2, 3]); // role 1 not re-inserted
        expect(out.snapped).toBe(2);
    });

    test('every role already present → honestly skips as already_today', async () => {
        mockAll.mockResolvedValue([{ role_id: 1 }, { role_id: 2 }, { role_id: 3 }]);
        const out = await tick();
        expect(out).toEqual({ snapped: 0, skipped: 'already_today' });
        expect(insertedRoleIds()).toEqual([]);
    });

    test('one failing role neither aborts the pass nor locks the day', async () => {
        mockRun.mockImplementation(async (sql, params) => {
            if (/INSERT/.test(sql) && params[0] === 2) throw new Error('deadlock');
            return {};
        });
        const out = await tick();
        expect(insertedRoleIds().sort()).toEqual([1, 2, 3]); // all attempted
        expect(out.snapped).toBe(2); // roles 1 and 3 landed
        expect(out.failed).toEqual([expect.objectContaining({ roleId: 2 })]);
    });

    test('an empty benchmark is a clean skip, not a failure', async () => {
        mockGetFit.mockResolvedValue([]);
        const out = await tick();
        expect(out).toEqual({ snapped: 0, skipped: 'no_roles' });
    });
});
