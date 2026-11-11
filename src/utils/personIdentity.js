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
    // Mixed: the admin side is the same person through its link, or — for an
    // admin account linked to nobody — through a shared identity (below).
    if (userKind === 'admin') {
        const linked = await linkedPersonOfAdmin(user.id);
        if (linked != null) return linked === refId;
        return adminMatchesEmployee(user.id, refId);
    }
    const linked = await linkedPersonOfAdmin(refId);
    if (linked != null) return linked === Number(user.id);
    return adminMatchesEmployee(refId, user.id);
}

/**
 * An administration account that is NOT linked to an employee record is still
 * the same human as an employee when the two share an identity: the same
 * e-mail (case- and space-insensitive), the same external (SSO) id, or an SSO
 * identity of one account (user_identities) that is the other's inline SSO id.
 *
 * Used ONLY to REFUSE self-action and to keep two-person rules two people —
 * never to grant anything. A lookup error answers "not matched" (the reads
 * that would grant the action fail on the same outage).
 * @returns {Promise<boolean>}
 */
async function adminMatchesEmployee(adminId, employeeId) {
    const a = Number(adminId);
    const e = Number(employeeId);
    if (!Number.isInteger(a) || !Number.isInteger(e) || a <= 0 || e <= 0) return false;
    try {
        const row = await db.get(
            `SELECT 1 AS "hit"
               FROM admins a, employees e
              WHERE a.id = ? AND e.id = ?
                AND ((a.email IS NOT NULL AND btrim(a.email) <> ''
                      AND lower(btrim(a.email)) = lower(btrim(coalesce(e.email, ''))))
                  OR (a.external_id IS NOT NULL AND btrim(a.external_id) <> ''
                      AND a.external_id = e.external_id)
                  OR EXISTS (SELECT 1 FROM user_identities ia
                              WHERE ia.subject_type = 'admin' AND ia.subject_id = a.id
                                AND ia.sso_provider = e.auth_provider
                                AND ia.sso_uid = e.external_id)
                  OR EXISTS (SELECT 1 FROM user_identities ie
                              WHERE ie.subject_type = 'employee' AND ie.subject_id = e.id
                                AND ie.sso_provider = a.auth_provider
                                AND ie.sso_uid = a.external_id))`,
            [a, e]
        );
        return Boolean(row && Number(row.hit) === 1);
    } catch (_) {
        return false;
    }
}

module.exports = { personIdOf, isSamePerson, linkedPersonOfAdmin, adminMatchesEmployee };
