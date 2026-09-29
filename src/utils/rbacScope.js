'use strict';

/**
 * Shared "scope before aggregate" helpers — the single implementation of the
 * RBAC visibility rule used by the analytics/compliance query layers (same
 * resolution as the Power BI feeds and the app pages):
 *
 *   SuperAdmin            → unrestricted (null)
 *   manager / supervisor  → their governed sub-tree (EmployeeModel.findGovernedIds)
 *   local admin / viewer  → employees inside their assigned scopes
 *                           (RBACService.getFilteredEmployees)
 *
 * Callers filter row-level views by employee_id BEFORE any GROUP BY, so a
 * person outside the caller's clearance can never influence a returned number.
 */

/**
 * Resolve the caller's visible employee ids.
 * @returns {Promise<number[]|null>} null = unrestricted; [] = nothing visible.
 */
async function scopedEmployeeIds(user) {
    if (!user) return [];
    if (user.userType === 'admin' && user.role === 'superadmin') return null;
    if (user.userType === 'manager' || user.userType === 'employee') {
        const EmployeeModel = require('../models/EmployeeModel');
        return EmployeeModel.findGovernedIds(user.id);
    }
    const RBACService = require('../services/RBACService');
    const employees = await RBACService.getFilteredEmployees(user);
    return employees.map((e) => Number(e.id));
}

/**
 * Build " AND <column> IN (?,?,…)" for an ids array, pushing the ids onto
 * `params`. '' when unrestricted (null); " AND 1 = 0" for an empty scope.
 */
function scopeClause(ids, params, column = 'employee_id') {
    if (ids === null) return '';
    if (!ids.length) return ' AND 1 = 0';
    params.push(...ids);
    return ` AND ${column} IN (${ids.map(() => '?').join(',')})`;
}

module.exports = { scopedEmployeeIds, scopeClause };
