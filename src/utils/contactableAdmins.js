'use strict';

/**
 * contactableAdmins — who a refused user should actually go and talk to.
 *
 * the 403 page used to list every active admin holding
 * manage_admins BY LOGIN NAME, so every refused user was told to contact
 * « admin · SuperAdmin, test.super · SuperAdmin » — a demo login offered as a
 * human being, and a login name disclosed to anyone who hit a wall.
 *
 * Rules, in order:
 *   - holders of `manage_admins` (SuperAdmins included), else the SuperAdmins;
 *   - ACTIVE accounts only — a deactivated admin cannot grant anything;
 *   - never a test/demo/QA login (`test.`, `demo.`, `qa.` prefixes) — those are
 *     fixtures, not people;
 *   - the DISPLAY NAME comes from the linked employee record when there is one,
 *     otherwise the username;
 *   - e-mail addresses NEVER leave this helper (the refusal page is reachable by
 *     any signed-in user, employees included).
 */

const DEMO_LOGIN = /^(test|demo|qa)\./i;

/** Excluded from every contact list: fixtures, not people. */
function isFixtureLogin(username) {
    return DEMO_LOGIN.test(String(username || ''));
}

/**
 * @returns {Promise<Array<{displayName: string, role: string}>>} at most 10 rows.
 *          Empty on any failure — the caller falls back to generic guidance.
 */
async function contactableGranters() {
    try {
        // eslint-disable-next-line global-require
        const db = require('../config/database');
        // eslint-disable-next-line global-require
        const RBACService = require('../services/RBACService');
        const select = `SELECT a.username, a.role,
                               TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS employee_name
                          FROM admins a
                          LEFT JOIN employees e
                                 ON e.id = a.linked_employee_id AND COALESCE(e.is_active, true) = true`;
        let rows = [];
        const ids = await RBACService.adminsWithPermission('manage_admins');
        if (ids.length) {
            rows = await db.all(
                `${select}
                  WHERE a.id IN (${ids.map(() => '?').join(',')})
                    AND COALESCE(a.is_active, true) = true
                  ORDER BY (a.role = 'superadmin') DESC, a.username
                  LIMIT 20`,
                ids
            );
        }
        if (!rows.length) {
            rows = await db.all(
                `${select}
                  WHERE a.role = 'superadmin' AND COALESCE(a.is_active, true) = true
                  ORDER BY a.username
                  LIMIT 20`
            );
        }
        return rows
            .filter((r) => !isFixtureLogin(r.username))
            .map((r) => ({
                displayName: (r.employeeName ?? r.employee_name ?? '').trim() || r.username,
                role: r.role,
            }))
            .slice(0, 10);
    } catch (_) {
        return [];
    }
}

module.exports = { contactableGranters, isFixtureLogin };
