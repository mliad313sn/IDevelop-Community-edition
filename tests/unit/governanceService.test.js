'use strict';
/**
 * GovernanceService — responsibility falls through
 *     supervisor -> manager -> the local admin whose scope covers the person
 * and review access follows that reporting line rather than whoever the row
 * happened to be assigned to.
 *
 * canReview is an ACCESS GUARD, so its negative cases matter as much as the
 * positive ones. DB mocked.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockFindGovernedIds = jest.fn();
jest.mock('../../src/models/EmployeeModel', () => ({
    findGovernedIds: (...a) => mockFindGovernedIds(...a),
}));

const mockGetFilteredEmployees = jest.fn();
jest.mock('../../src/services/RBACService', () => ({
    getFilteredEmployees: (...a) => mockGetFilteredEmployees(...a),
}));

const Gov = require('../../src/services/GovernanceService');

const SUPERADMIN = { id: 1, userType: 'admin', role: 'superadmin' };
const LOCALADMIN = { id: 7, userType: 'admin', role: 'localadmin' };
const MANAGER = { id: 20, userType: 'manager', role: 'manager' };

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockFindGovernedIds.mockReset().mockResolvedValue([]);
    mockGetFilteredEmployees.mockReset().mockResolvedValue([]);
});

describe('resolveReviewer — the fall-through', () => {
    test('a supervisor wins over everything else', async () => {
        mockDb.get.mockResolvedValue({
            id: 5,
            supervisorId: 99,
            managerId: 77,
            supervisorName: 'SUP',
            managerName: 'MGR',
        });
        await expect(Gov.resolveReviewer(5)).resolves.toMatchObject({ kind: 'supervisor', id: 99 });
        expect(mockDb.all).not.toHaveBeenCalled(); // no need to look at admin scopes
    });

    test('the manager is used when there is no supervisor', async () => {
        mockDb.get.mockResolvedValue({
            id: 5,
            supervisorId: null,
            managerId: 77,
            managerName: 'MGR',
        });
        await expect(Gov.resolveReviewer(5)).resolves.toMatchObject({ kind: 'manager', id: 77 });
    });

    test('falls back to the covering local admin, NARROWEST scope first', async () => {
        mockDb.get.mockResolvedValue({ id: 5, supervisorId: null, managerId: null });
        mockDb.all.mockResolvedValue([
            { adminId: 3, username: 'siteAdmin', role: 'localadmin', scopeType: 'site' },
            { adminId: 4, username: 'svcAdmin', role: 'localadmin', scopeType: 'service' },
        ]);
        const r = await Gov.resolveReviewer(5);
        expect(r).toMatchObject({ kind: 'local_admin', id: 4, scopeType: 'service' });
        expect(r.alternates.map((a) => a.id)).toEqual([3]); // the wider scope is kept, not dropped
    });

    test('reports "none" rather than guessing when nobody covers the person', async () => {
        mockDb.get.mockResolvedValue({ id: 5, supervisorId: null, managerId: null });
        mockDb.all.mockResolvedValue([]);
        await expect(Gov.resolveReviewer(5)).resolves.toMatchObject({ kind: 'none', id: null });
    });

    test('an unknown employee never throws', async () => {
        mockDb.get.mockResolvedValue(undefined);
        await expect(Gov.resolveReviewer(999)).resolves.toMatchObject({ kind: 'none' });
    });
});

describe('reviewableEmployeeIds', () => {
    test('superadmin is unrestricted', async () => {
        await expect(Gov.reviewableEmployeeIds(SUPERADMIN)).resolves.toBeNull();
    });

    test('a manager gets their governed sub-tree', async () => {
        mockFindGovernedIds.mockResolvedValue([11, 12]);
        await expect(Gov.reviewableEmployeeIds(MANAGER)).resolves.toEqual([11, 12]);
    });

    test('a local admin gets their scope UNIONed with their fallback people', async () => {
        mockGetFilteredEmployees.mockResolvedValue([{ id: 11 }, { id: 12 }]);
        mockDb.all.mockResolvedValue([{ id: 12 }, { id: 13 }]); // fallback incl. one not in scope
        const ids = await Gov.reviewableEmployeeIds(LOCALADMIN);
        expect(ids.sort()).toEqual([11, 12, 13]); // de-duplicated
    });

    test('no user sees nobody', async () => {
        await expect(Gov.reviewableEmployeeIds(null)).resolves.toEqual([]);
    });
});

describe('canReview — access guard', () => {
    test('a superadmin may review anyone', async () => {
        await expect(Gov.canReview(SUPERADMIN, 12345)).resolves.toBe(true);
    });

    test('a manager may review somebody in their line', async () => {
        mockFindGovernedIds.mockResolvedValue([11, 12]);
        await expect(Gov.canReview(MANAGER, 12)).resolves.toBe(true);
    });

    test('a manager may NOT review somebody outside their line', async () => {
        mockFindGovernedIds.mockResolvedValue([11, 12]);
        await expect(Gov.canReview(MANAGER, 99)).resolves.toBe(false);
    });

    test('a manager governing nobody may review nobody', async () => {
        mockFindGovernedIds.mockResolvedValue([]);
        await expect(Gov.canReview(MANAGER, 11)).resolves.toBe(false);
    });

    test('string and numeric ids compare correctly', async () => {
        mockFindGovernedIds.mockResolvedValue([11, 12]);
        await expect(Gov.canReview(MANAGER, '12')).resolves.toBe(true);
    });
});

describe('scope queries exclude expired scopes', () => {
    test('every scope-matching query filters on expires_at', async () => {
        mockDb.get.mockResolvedValue({ id: 5, supervisorId: null, managerId: null });
        await Gov.coveringAdmins(5);
        await Gov.fallbackEmployeeIdsForAdmin(7);
        await Gov.orphanedEmployees();
        const sqls = mockDb.all.mock.calls.map((c) => c[0]);
        expect(sqls.length).toBeGreaterThanOrEqual(3);
        sqls.forEach((sql) =>
            expect(sql).toMatch(/expires_at IS NULL OR sc\.expires_at > now\(\)/)
        );
    });

    test('only ACTIVE admins confer responsibility', async () => {
        await Gov.coveringAdmins(5);
        expect(mockDb.all.mock.calls[0][0]).toMatch(/a\.is_active = true/);
    });
});
