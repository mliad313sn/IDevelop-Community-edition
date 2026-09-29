'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireEmployeeOrManager } = require('../middleware/auth');
const CoachingService = require('../services/CoachingService');
const RBACService = require('../services/RBACService');
/**
 * M-02 — « Not authorized for this employee », la phrase de refus la plus
 * répandue de ce domaine, était un LITTÉRAL anglais rendu tel quel sur une page
 * française : treize lignes, cinq fichiers de routes et un contrôleur, et aucun
 * `say` ne pouvait les atteindre puisqu'elles ne LANCENT pas — elles répondent
 * directement. Le catalogue est partagé (`common:err_not_authorized_employee`)
 * et la phrase anglaise reste la référence par défaut.
 */
const { sayText } = require('../utils/apiErrors');
const notAuthorizedForEmployee = (req) =>
    sayText(req, 'common:err_not_authorized_employee', 'Not authorized for this employee');

const db = require('../config/database');
const ah = require('../utils/asyncHandler');

const GovernanceService = require('../services/GovernanceService');

// `coaching_sessions.coach_id` is a foreign key to EMPLOYEES: the coach is a
// PERSON. This route used to write `req.user.id` there — for an administrator
// that is an ADMIN id, and the two id spaces overlap: a session created by
// admin #N became the session of employee #N (GROW, coach signature), or failed
// the FK (measured: superadmin 666 -> 400 fk_coaching_sessions_coach). The coach
// is the person behind the account (admins.linked_employee_id), or nobody.
const coachIdFor = (user) => GovernanceService.actingPersonId(user);

// Clearance UNION the reporting line of the person behind an admin account —
// the same union RBACService.scopeFilter applies to every list.
async function adminCovers(user, employeeId) {
    if (RBACService.isSuperAdmin(user)) return true;
    if (
        (await RBACService.getFilteredEmployees(user)).some(
            (e) => Number(e.id) === Number(employeeId)
        )
    )
        return true;
    return (await GovernanceService.lineAuthorityEmployeeIds(user)).some(
        (id) => Number(id) === Number(employeeId)
    );
}

// A coaching session is private to its employee + coach (admins in-scope too).
// The coach comparison is typed: `coach_id` holds a PERSON id, so an admin
// account matches it only through the person it is linked to.
async function canAccessSession(user, sessionId) {
    const s = await db.get('SELECT employee_id, coach_id FROM coaching_sessions WHERE id = ?', [
        Number(sessionId),
    ]);
    if (!s) return { ok: false, notFound: true };
    if (user.userType === 'admin') {
        const personId = await coachIdFor(user);
        const isCoach = personId != null && Number(personId) === Number(s.coachId);
        return { ok: isCoach || (await adminCovers(user, s.employeeId)), session: s, personId };
    }
    return {
        ok: Number(user.id) === Number(s.employeeId) || Number(user.id) === Number(s.coachId),
        session: s,
        personId: Number(user.id),
    };
}

// A viewer reads (print) but never writes (create, GROW, sign).
const refuseViewer = (req, res) => {
    if (!RBACService.isViewer(req.user)) return false;
    res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
    return true;
};

// The session LIST that used to live here was an orphan: no nav link pointed at
// it, it had no title and no empty state, and it filtered on
// `employee_id = me OR coach_id = me` — so a manager whose reports are coached
// by someone else saw nothing, while the same manager's /coaching/plans
// console is scoped to everyone they govern. Coaching has two real surfaces —
// /coaching/plans (manager/admin, governed scope) and /employee/my-coaching
// (the person's own plans) — so this route now sends each caller to theirs.
// The session write/print endpoints below stay: they are the API the plans
// pages and the printable EDP use.
router.get('/', requireEmployeeOrManager, (req, res) => {
    res.redirect(req.user.userType === 'manager' ? '/coaching/plans' : '/employee/my-coaching');
});

router.post(
    '/sessions',
    requireAuth,
    ah(async (req, res) => {
        const employeeId = Number(req.body.employeeId);
        if (!employeeId)
            return res.status(400).json({ ok: false, error: 'employeeId is required' });
        if (refuseViewer(req, res)) return;
        // Coaching is manager-owned and scoped to the actor's reports — never let a
        // caller create a confidential coaching record for an employee they don't govern.
        const covered =
            req.user.userType === 'admin'
                ? await adminCovers(req.user, employeeId)
                : await RBACService.canAccessEmployee(req.user, employeeId);
        if (!covered) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        const coachId = await coachIdFor(req.user);
        if (coachId == null) {
            return res.status(400).json({
                ok: false,
                error: req.t
                    ? req.t('flash:coaching_no_acting_person', {
                          defaultValue:
                              'Only a person can hold a coaching session: this administration account is linked to no employee.',
                      })
                    : 'Only a person can hold a coaching session: this administration account is linked to no employee.',
            });
        }
        // coaching_sessions.kind is the coach_kind enum ('coach'|'mentor'); accept the
        // plan-style 'coaching'/'mentoring' synonyms too and normalise.
        const k = String(req.body.kind || '').toLowerCase();
        const kind = k === 'mentor' || k === 'mentoring' ? 'mentor' : 'coach';
        const id = await CoachingService.createSession({
            employeeId,
            coachId,
            kind,
            sessionAt: req.body.sessionAt,
            agenda: req.body.agenda,
            planId: req.body.planId ? Number(req.body.planId) : null,
            contextType: req.body.contextType,
            idpId: req.body.idpId ? Number(req.body.idpId) : null,
            pipId: req.body.pipId ? Number(req.body.pipId) : null,
            skillId: req.body.skillId ? Number(req.body.skillId) : null,
        });
        res.json({ ok: true, id });
    })
);

router.post(
    '/sessions/:id/grow',
    requireAuth,
    ah(async (req, res) => {
        if (refuseViewer(req, res)) return;
        const acc = await canAccessSession(req.user, req.params.id);
        if (acc.notFound) return res.status(404).json({ ok: false, error: 'Session not found' });
        if (!acc.ok) return res.status(403).json({ ok: false, error: 'Not authorized' });
        await CoachingService.upsertGrow({
            sessionId: Number(req.params.id),
            goal: req.body.goal,
            reality: req.body.reality,
            options: req.body.options,
            wayForward: req.body.wayForward,
        });
        res.json({ ok: true });
    })
);

router.post(
    '/sessions/:id/sign',
    requireAuth,
    ah(async (req, res) => {
        if (refuseViewer(req, res)) return;
        const acc = await canAccessSession(req.user, req.params.id);
        if (acc.notFound) return res.status(404).json({ ok: false, error: 'Session not found' });
        if (!acc.ok) return res.status(403).json({ ok: false, error: 'Not authorized' });
        // Derive the sign-off role from the caller's relationship to the session — never
        // trust a body-supplied role (a party could otherwise sign as the other side).
        // Typed on the PERSON: an admin whose id equals the employee's is never the
        // employee party (id spaces overlap).
        const role =
            req.user.userType !== 'admin' && Number(req.user.id) === Number(acc.session.employeeId)
                ? 'employee'
                : 'coach';
        await CoachingService.signOff({
            sessionId: Number(req.params.id),
            role,
            userId: req.user.id,
            ip: req.ip,
            ua: req.get('user-agent'),
        });
        res.json({ ok: true });
    })
);

router.get(
    '/sessions/:id/print',
    requireAuth,
    ah(async (req, res) => {
        const acc = await canAccessSession(req.user, req.params.id);
        if (acc.notFound)
            return res.status(404).render('pages/error', {
                message: 'Session not found',
                title: req.t ? req.t('chrome:pt_not_found') : 'Not found',
            });
        if (!acc.ok)
            return res.status(403).render('pages/error', {
                message: 'Not authorized',
                title: req.t ? req.t('chrome:pt_forbidden') : 'Forbidden',
            });
        const s = await db.get(`SELECT * FROM coaching_sessions WHERE id = ?`, [req.params.id]);
        const grow = await db.get(`SELECT * FROM coaching_grow WHERE session_id = ?`, [
            req.params.id,
        ]);
        const objectives = await db.all(`SELECT * FROM coaching_objectives WHERE session_id = ?`, [
            req.params.id,
        ]);
        res.render('pages/coaching/print-edp', { session: s, grow, objectives });
    })
);

module.exports = router;
