'use strict';

/**
 * Re-audit F1 — a manager's perimeter tiles and the scope bar counted 17 where
 * the manager's governance span — and the headcount KPI — were 16: one surface
 * added the manager's own id to the governed reports. The dashboard now reads
 * ONE population (KpiService.resolvePopulation over RBACService.scopeFilter):
 * the governed reports, never the manager themselves, and a report-less
 * manager sees no one, never the whole organisation.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockAll = jest.fn(async () => []);
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: (...a) => mockAll(...a),
    run: jest.fn(async () => ({})),
}));

const mockGoverned = jest.fn();
jest.mock('../../src/models/EmployeeModel', () => ({
    findGovernedIds: (...a) => mockGoverned(...a),
}));

const K = require('../../src/services/KpiService');

beforeEach(() => {
    mockGoverned.mockReset();
    mockAll.mockClear();
});

describe('F1 — the manager perimeter is the governed reports, not reports + self', () => {
    test('the dashboard population reads exactly the governed set for a manager', async () => {
        mockGoverned.mockResolvedValue([7, 8, 9]);
        await K.resolvePopulation({ viewer: { userType: 'manager', id: 5 } });
        expect(mockGoverned).toHaveBeenCalledWith(5);
        const [sql, params] = mockAll.mock.calls[0];
        expect(sql).toMatch(/AND e\.id = ANY\(\?\)/);
        expect(params[0]).toEqual([7, 8, 9]); // 5 (self) is NOT added
    });

    test('a report-less manager scopes to no one, never org-wide', async () => {
        mockGoverned.mockResolvedValue([]);
        await K.resolvePopulation({ viewer: { userType: 'manager', id: 42 } });
        const [sql] = mockAll.mock.calls[0];
        expect(sql).toMatch(/AND 1=0/);
    });
});
