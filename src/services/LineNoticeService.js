'use strict';

/**
 * LineNoticeService — tells a person's direct manager when someone ABOVE them
 * decided for their team (4.0.0 port, wave 2; kind `line.acted_above`).
 *
 * "Above" is anyone who is neither the person's supervisor nor their direct
 * manager (by either of their accounts): the line above in extended mode, a
 * local administrator in clearance, a SuperAdmin. The notice goes to the
 * direct manager only, never to the person. Its payload is ids, a short action
 * code and the rung (AuthorityService) — no name, no rating, no free text.
 *
 * Best-effort: it never blocks or fails the act it reports.
 */

const AuthorityService = require('./AuthorityService');

/** The action codes a notice may carry (payload `action`) and the page each opens. */
const LINKS = Object.freeze({
    ninebox_approved: '/talent/nine-box',
    pip_activated: '/v2/pip',
    dispute_l0: '/v2/slf/disputes',
    dispute_l1: '/v2/slf/disputes',
});
const ACTION_CODES = Object.freeze(Object.keys(LINKS));

const LineNoticeService = {
    ACTION_CODES,

    /**
     * @param {object} actor   the session user who acted
     * @param {number} employeeId the person acted on
     * @param {string} code    one of ACTION_CODES
     * @returns {Promise<boolean>} true when a notice was queued
     */
    async actedAbove(actor, employeeId, code) {
        try {
            if (!ACTION_CODES.includes(code)) return false;
            if (!actor || actor.id == null || employeeId == null) return false;
            const eid = Number(employeeId);
            if (!Number.isInteger(eid) || eid <= 0) return false;
            const rel = await AuthorityService.relation(actor, eid);
            if (!rel || rel.isSelf || rel.selfByIdentity) return false;
            if (rel.isSupervisor || rel.isDirectManager || rel.isAdminManager) return false;
            const emp = rel.employee;
            if (emp.managerId == null) return false;
            const mType = emp.managerType === 'admin' ? 'admin' : 'employee';
            const aType = actor.userType === 'admin' ? 'admin' : 'employee';
            if (mType === aType && Number(emp.managerId) === Number(actor.id)) return false;
            const noted = AuthorityService.auditAs(actor, eid).replace(' as=', '');
            await require('./NotificationService')
                .notify({
                    userType: mType,
                    userId: Number(emp.managerId),
                    kind: 'line.acted_above',
                    payload: {
                        action: code,
                        employeeId: eid,
                        as: noted || rel.as,
                        link: LINKS[code],
                    },
                })
                .catch(() => null);
            return true;
        } catch (_) {
            return false;
        }
    },
};

module.exports = LineNoticeService;
