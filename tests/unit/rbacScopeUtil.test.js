'use strict';
/**
 * src/utils/rbacScope — the single "scope before aggregate" implementation
 * shared by the analytics, compliance and BI-feed query layers. These tests
 * pin the visibility contract:
 *   SuperAdmin → null (unrestricted) · manager → governed sub-tree ·
 *   local admin → RBAC-filtered employees · no user → nothing.
 * DB-free: models/services mocked.
 */

jest.mock('../../src/models/EmployeeModel', () => ({
    findGovernedIds: jest.fn(),
}));
jest.mock('../../src/services/RBACService', () => ({
    getFilteredEmployees: jest.fn(),
}));

const EmployeeModel = require('../../src/models/EmployeeModel');
const RBACService = require('../../src/services/RBACService');
const { scopedEmployeeIds, scopeClause } = require('../../src/utils/rbacScope');

describe('scopedEmployeeIds', () => {
    test('no user → empty scope (sees nothing)', async () => {
        expect(await scopedEmployeeIds(null)).toEqual([]);
        expect(await scopedEmployeeIds(undefined)).toEqual([]);
    });

    test('SuperAdmin → null (unrestricted)', async () => {
        expect(
            await scopedEmployeeIds({ userType: 'admin', role: 'superadmin', id: 1 })
        ).toBeNull();
        expect(EmployeeModel.findGovernedIds).not.toHaveBeenCalled();
        expect(RBACService.getFilteredEmployees).not.toHaveBeenCalled();
    });

    test('manager → their governed sub-tree ids', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([7, 8, 9]);
        expect(await scopedEmployeeIds({ userType: 'manager', id: 5 })).toEqual([7, 8, 9]);
        expect(EmployeeModel.findGovernedIds).toHaveBeenCalledWith(5);
    });

    test('employee → same governed-ids path (self-manager semantics)', async () => {
        EmployeeModel.findGovernedIds.mockResolvedValue([]);
        expect(await scopedEmployeeIds({ userType: 'employee', id: 42 })).toEqual([]);
    });

    test('local admin → RBAC-filtered employee ids, numeric', async () => {
        RBACService.getFilteredEmployees.mockResolvedValue([{ id: '3' }, { id: 4 }]);
        const ids = await scopedEmployeeIds({ userType: 'admin', role: 'localadmin', id: 2 });
        expect(ids).toEqual([3, 4]);
    });
});

describe('scopeClause', () => {
    test('unrestricted (null) → empty clause, params untouched', () => {
        const params = ['x'];
        expect(scopeClause(null, params)).toBe('');
        expect(params).toEqual(['x']);
    });

    test('empty scope → impossible predicate (never leaks unscoped rows)', () => {
        const params = [];
        expect(scopeClause([], params)).toBe(' AND 1 = 0');
        expect(params).toEqual([]);
    });

    test('ids → IN-list with matching pushed params and custom column', () => {
        const params = [10];
        const clause = scopeClause([1, 2, 3], params, 'cc.employee_id');
        expect(clause).toBe(' AND cc.employee_id IN (?,?,?)');
        expect(params).toEqual([10, 1, 2, 3]);
    });
});
