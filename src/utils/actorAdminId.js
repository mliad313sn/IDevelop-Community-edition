'use strict';

const db = require('../config/database');

/**
 * The `admins(id)` to record for whoever is acting, or NULL.
 *
 * Several columns that record WHO did something — succession_plans.owner_admin_id,
 * course_skill_map's mapper, lms_enrollments.assigned_by — are foreign keys onto
 * admins(id). A supervisor or manager is an EMPLOYEE, so their id cannot go
 * there.
 *
 * The routers used to resolve that by falling back to the built-in 'admin'
 * account. That is not a fallback, it is a WRONG ANSWER written into the
 * record: every continuity and LMS act performed by a manager came back
 * attributed to the system administrator — owner, nominator, reviewer — and the
 * person who actually did it was gone. An operator reading the plan a year
 * later is told something untrue by a column whose entire purpose is to say who
 * acted.
 *
 * Order:
 *   1. an admin acting as themselves  -> their own id;
 *   2. an employee/manager who HAS a linked admin account -> that account, which
 *      is genuinely them;
 *   3. otherwise NULL.
 *
 * NULL over a false attribution is the project's own arbitration, and these
 * columns are all nullable. "Nobody is recorded" is a fact an operator can act
 * on; "the system administrator did it" is not. The real actor is still in the
 * audit trail either way — LogService records actorRef for every one of these
 * routes.
 */
async function actorAdminId(user) {
    if (!user || user.id == null) return null;
    if (user.userType === 'admin') return Number(user.id);
    try {
        const linked = await db.get(
            'SELECT id FROM admins WHERE linked_employee_id = ? AND is_active = true ORDER BY id LIMIT 1',
            [Number(user.id)]
        );
        return linked ? Number(linked.id) : null;
    } catch (_) {
        return null;
    }
}

module.exports = { actorAdminId };
