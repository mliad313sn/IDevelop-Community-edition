'use strict';
/**
 * 3.23.21 — lane L2, ST-5: rbacMiddleware runs on EVERY admin request and
 * re-resolved the reporting line each time (account → linked person →
 * governed sub-tree → admin-designated people: up to three queries), including
 * every /api/benchmark/fit call. It now reads a per-account memo (60 s).
 * Per-object authority guards keep the uncached resolution.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockEmp = {
    findGovernedIds: jest.fn(async () => [138, 139]),
    orgUnitsOf: jest.fn(async () => ({ siteIds: [2], departmentIds: [20], serviceIds: [200] })),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmp);
const mockScope = {
    resolveAdminScope: jest.fn(async () => ({
        unrestricted: false,
        siteIds: [1],
        departmentIds: [10],
        serviceIds: [100],
        employeeIds: [5],
    })),
};
jest.mock('../../src/utils/adminScope', () => mockScope);

const Gov = require('../../src/services/GovernanceService');
const { rbacMiddleware } = require('../../src/middleware/rbac');

const ADMIN = { id: 703, userType: 'admin', role: 'localadmin' };
const OTHER = { id: 704, userType: 'admin', role: 'localadmin' };

/** Queries the line resolution issues: the linked-person lookup is the marker. */
const personLookups = () =>
    mockDb.get.mock.calls.filter(([sql]) => /linked_employee_id/.test(sql)).length;

beforeEach(() => {
    jest.clearAllMocks();
    Gov.clearLineAuthorityCache();
    mockDb.get.mockImplementation(async (sql) =>
        /linked_employee_id/.test(sql) ? { id: 136 } : undefined
    );
    mockDb.all.mockImplementation(async (sql) =>
        /manager_type = 'admin'/.test(sql) ? [{ id: 287 }] : []
    );
});

async function run(user) {
    const req = { user };
    await new Promise((resolve) => rbacMiddleware(req, {}, resolve));
    return req.scope;
}

describe('ST-5 — the reporting line is memoised for rbacMiddleware', () => {
    test('ten admin requests resolve the line ONCE, and every one carries it', async () => {
        for (let i = 0; i < 10; i++) {
            const s = await run(ADMIN);
            expect(s.employeeIds.sort((a, b) => a - b)).toEqual([5, 138, 139, 287]);
        }
        expect(personLookups()).toBe(1);
        expect(mockEmp.findGovernedIds).toHaveBeenCalledTimes(1);
    });

    test('the memo is per account', async () => {
        await run(ADMIN);
        await run(OTHER);
        await run(ADMIN);
        expect(personLookups()).toBe(2);
    });

    test('it expires (TTL) and is re-resolved', async () => {
        const now = jest.spyOn(Date, 'now');
        now.mockReturnValue(1_000_000);
        await run(ADMIN);
        now.mockReturnValue(1_000_000 + 59_000);
        await run(ADMIN);
        expect(personLookups()).toBe(1);
        now.mockReturnValue(1_000_000 + 61_000);
        await run(ADMIN);
        expect(personLookups()).toBe(2);
        now.mockRestore();
    });

    test('a failure is not memoised: the next request retries', async () => {
        mockEmp.findGovernedIds.mockRejectedValueOnce(new Error('db down'));
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        const s1 = await run(ADMIN);
        expect(s1.employeeIds).toEqual([5]); // clearance only, never wider
        const s2 = await run(ADMIN);
        expect(s2.employeeIds.sort((a, b) => a - b)).toEqual([5, 138, 139, 287]);
        err.mockRestore();
    });

    test('the authority resolution itself stays uncached (guards read live data)', async () => {
        await Gov.lineAuthorityEmployeeIds(ADMIN);
        await Gov.lineAuthorityEmployeeIds(ADMIN);
        expect(personLookups()).toBe(2);
    });

    test('a returned list is a copy: a caller mutating it cannot poison the memo', async () => {
        const a = await Gov.lineAuthorityEmployeeIdsCached(ADMIN);
        a.push(999);
        const b = await Gov.lineAuthorityEmployeeIdsCached(ADMIN);
        expect(b).not.toContain(999);
    });
});
