'use strict';

/**
 * EmailAccountsService — "who else uses this e-mail address?"
 *
 * Since migration 107 an address may belong to several accounts (a person with
 * an employee record AND an admin account, two records across entities, a shared
 * departmental mailbox). The product rule is: allow it, but ADVISE. Every screen
 * that creates or edits an account with an address calls `accountsWithEmail`
 * and, when other accounts carry the same address, shows the advisory instead
 * of refusing — so a genuine duplicate person is still noticed by the one
 * typing, and a deliberate second account is never blocked.
 *
 * The same lookup serves the flows that used to assume one account per
 * address: they must now REFUSE ambiguity rather than guess (login by e-mail,
 * SSO first-time match, LMS completion by e-mail) — see `uniqueEmployeeByEmail`.
 */

const db = require('../config/database');

const norm = (email) =>
    String(email == null ? '' : email)
        .trim()
        .toLowerCase();

const EmailAccountsService = {
    /**
     * Every account carrying this address, across employees and admins.
     * @param {string} email
     * @param {{excludeEmployeeId?: number, excludeAdminId?: number}} [opts]
     * @returns {Promise<Array<{kind:'employee'|'admin', id:number, username:string|null, label:string, isActive:boolean}>>}
     */
    async accountsWithEmail(email, opts = {}) {
        const e = norm(email);
        if (!e) return [];
        const out = [];
        const emps = await db.all(
            `SELECT id, username, first_name AS "firstName", last_name AS "lastName",
                    employee_number AS "employeeNumber", is_active AS "isActive"
               FROM employees WHERE lower(email) = ? ORDER BY id`,
            [e]
        );
        for (const r of emps) {
            if (opts.excludeEmployeeId != null && Number(r.id) === Number(opts.excludeEmployeeId))
                continue;
            out.push({
                kind: 'employee',
                id: Number(r.id),
                username: r.username || null,
                label:
                    `${r.firstName || ''} ${r.lastName || ''}`.trim() +
                    (r.employeeNumber ? ` (${r.employeeNumber})` : ''),
                isActive: r.isActive !== false,
            });
        }
        const admins = await db.all(
            `SELECT id, username, role, is_active AS "isActive" FROM admins WHERE lower(email) = ? ORDER BY id`,
            [e]
        );
        for (const r of admins) {
            if (opts.excludeAdminId != null && Number(r.id) === Number(opts.excludeAdminId))
                continue;
            out.push({
                kind: 'admin',
                id: Number(r.id),
                username: r.username || null,
                label: `${r.username} (admin)`,
                isActive: r.isActive !== false,
            });
        }
        return out;
    },

    /**
     * What the actor may be told about the other accounts: a count, and names
     * only for accounts they may see (an employee sees no names, a scoped admin
     * or manager only their own people); the rest are counted, so the advisory
     * never leaks a name out of scope.
     * @returns {Promise<{count:number, who:string, matches:Array}>}
     */
    async describe(req, email, opts = {}) {
        const matches = await this.accountsWithEmail(email, opts);
        if (!matches.length) return { count: 0, who: '', matches };
        const RBAC = require('./RBACService');
        const user = req && req.user;
        const isAdminActor = Boolean(user && user.userType === 'admin');
        const isManagerActor = Boolean(user && user.userType === 'manager');
        const named = [];
        let hidden = 0;
        for (const m of matches) {
            let visible = false;
            if (user && RBAC.isSuperAdmin(user)) visible = true;
            else if (m.kind === 'employee' && (isAdminActor || isManagerActor)) {
                try {
                    const row = await require('../models/EmployeeModel').findById(m.id);
                    visible = row ? await RBAC.canAccessEmployeeData(user, row) : false;
                } catch (_) {
                    visible = false;
                }
            } else if (m.kind === 'admin' && isAdminActor) visible = true;
            if (visible) named.push(m.label);
            else hidden++;
        }
        const otherWord =
            req && req.t
                ? req.t('flash:email_shared_others', {
                      count: hidden,
                      defaultValue: `${hidden} other account(s)`,
                  })
                : `${hidden} other account(s)`;
        const who = named.join(', ') + (hidden ? (named.length ? ' + ' : '') + otherWord : '');
        return { count: matches.length, who, matches };
    },

    /** The advisory sentence for a flash, or null when the address is unused. */
    async advisory(req, email, opts = {}) {
        const d = await this.describe(req, email, opts);
        if (!d.count) return null;
        if (req && req.t) return req.t('flash:email_shared', { count: d.count, who: d.who });
        return `Note: this e-mail address is already used by ${d.count} other account(s): ${d.who}. A person may hold several accounts — check that this is intended.`;
    },

    /**
     * The ONE active employee carrying this address, or null when there is none
     * — or when there are several (ambiguous: the caller must not guess).
     * @returns {Promise<{row: object|null, ambiguous: boolean}>}
     */
    async uniqueEmployeeByEmail(email, { activeLoginOnly = false } = {}) {
        const e = norm(email);
        if (!e) return { row: null, ambiguous: false };
        const rows = await db.all(
            `SELECT id, username, email FROM employees
              WHERE lower(email) = ?${activeLoginOnly ? ' AND is_account_active = true' : ''} ORDER BY id`,
            [e]
        );
        if (rows.length === 1) return { row: rows[0], ambiguous: false };
        return { row: null, ambiguous: rows.length > 1 };
    },

    /** Same contract for admins. */
    async uniqueAdminByEmail(email) {
        const e = norm(email);
        if (!e) return { row: null, ambiguous: false };
        const rows = await db.all(
            'SELECT id, username, email FROM admins WHERE lower(email) = ? ORDER BY id',
            [e]
        );
        if (rows.length === 1) return { row: rows[0], ambiguous: false };
        return { row: null, ambiguous: rows.length > 1 };
    },
};

module.exports = EmailAccountsService;
