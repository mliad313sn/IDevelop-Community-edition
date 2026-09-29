'use strict';

/**
 * Person identity for two-person (maker-checker) rules — 3.23.17, lane B.
 *
 * One human may hold an EMPLOYEE account and an ADMINISTRATION account linked to
 * it (`admins.linked_employee_id`). Every rule of the form "the requester is
 * never the approver" / "never one's own" must compare PEOPLE, not accounts:
 * comparing only same-type refs (employee vs employee, admin vs admin) let one
 * person raise on one login and decide on the other.
 */

const db = require('../config/database');

/**
 * The employee an administration account names, whatever that person's current
 * state: a two-person rule must never be satisfied by the same human holding two
 * logins, even after one of them was deactivated.
 * @returns {Promise<number|null>}
 */
async function linkedPersonOfAdmin(adminId) {
    if (adminId == null) return null;
    const row = await db.get('SELECT linked_employee_id FROM admins WHERE id = ?', [
        Number(adminId),
    ]);
    const v = row && (row.linkedEmployeeId ?? row.linked_employee_id);
    return v == null ? null : Number(v);
}

/**
 * THE PERSON behind an account. An employee/manager session IS the person; an
 * administration account is the person it links to, or nobody.
 * @returns {Promise<number|null>} employee id, or null when the account names nobody.
 */
async function personIdOf(user) {
    if (!user || user.id == null) return null;
    if (user.userType !== 'admin') return Number(user.id);
    return linkedPersonOfAdmin(user.id);
}

/**
 * True when `user` is the same HUMAN as the recorded actor `ref` — the same
 * account, or an admin account linked to that employee, or vice versa.
 *
 * @param {object} user  the session user ({ id, userType })
 * @param {string|{adminId?:number, employeeId?:number}} ref
 *        'admin:5' / 'employee:137' (also 'manager:'/'supervisor:'), or an explicit pair.
 */
async function isSamePerson(user, ref) {
    if (!user || user.id == null || ref == null) return false;
    let refKind = null;
    let refId = null;
    if (typeof ref === 'string') {
        const m = /^(admin|employee|manager|supervisor):(\d+)$/.exec(ref.trim());
        if (!m) return false;
        refKind = m[1] === 'admin' ? 'admin' : 'employee';
        refId = Number(m[2]);
    } else if (ref.employeeId != null) {
        refKind = 'employee';
        refId = Number(ref.employeeId);
    } else if (ref.adminId != null) {
        refKind = 'admin';
        refId = Number(ref.adminId);
    } else {
        return false;
    }
    const userKind = user.userType === 'admin' ? 'admin' : 'employee';
    // Same id space: equal ids are the same account; different ids are different
    // people (an admin account links to at most one employee and each employee to
    // at most one admin account — idx_admins_linked_employee). No lookup needed.
    if (userKind === refKind) return Number(user.id) === refId;
    // Mixed: the admin side is the same person only through its link.
    if (userKind === 'admin') {
        const linked = await linkedPersonOfAdmin(user.id);
        return linked != null && linked === refId;
    }
    const linked = await linkedPersonOfAdmin(refId);
    return linked != null && linked === Number(user.id);
}

module.exports = { personIdOf, isSamePerson, linkedPersonOfAdmin };
