'use strict';

/**
 * Re-audit F1 — a manager's "Périmètre" tiles (getMeasures) and the scope bar
 * counted 17 where the manager's governance span — and the headcount KPI — were
 * 16. The KPI reads req.scope.employeeIds, which the RBAC middleware sets to
 * findGovernedIds (the reports, NO self); DashboardController._scopeEmployeeIds
 * additionally pushed the manager's own id, so the two surfaces disagreed by one
 * and the manager's own site/department could appear as an extra unit. The scope
 * used for those tiles is now the governed set, matching the middleware.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
}));

const mockGoverned = jest.fn();
jest.mock('../../src/models/EmployeeModel', () => ({
    findGovernedIds: (...a) => mockGoverned(...a),
}));
// RBACService is required by the controller module; a stub is enough.
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: jest.fn(() => false),
    getFilteredEmployees: jest.fn(async () => []),
}));

const DashboardController = require('../../src/controllers/DashboardController');
const ctl = new DashboardController();

beforeEach(() => mockGoverned.mockReset());

describe('F1 — the manager perimeter is the governed reports, not reports + self', () => {
    test('_scopeEmployeeIds returns exactly the governed set for a manager', async () => {
        mockGoverned.mockResolvedValue([7, 8, 9]);
        const ids = await ctl._scopeEmployeeIds({ user: { userType: 'manager', id: 5 } });
        expect(ids.sort((a, b) => a - b)).toEqual([7, 8, 9]); // 5 (self) is NOT added
        expect(mockGoverned).toHaveBeenCalledWith(5);
    });

    test('a report-less manager scopes to no one, never org-wide', async () => {
        mockGoverned.mockResolvedValue([]);
        const ids = await ctl._scopeEmployeeIds({ user: { userType: 'employee', id: 42 } });
        // Empty (not null): every consumer filters with `= ANY(?)`, which matches
        // nothing on an empty set — the manager sees no one, not everyone.
        expect(ids).toEqual([]);
    });
});
