'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const PipService = require('../services/PipService');
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

const TalentTaskService = require('../services/TalentTaskService');
const db = require('../config/database');
const ah = require('../utils/asyncHandler');

PipService.register();

// Manager-managed model (no HR): a user may manage PIPs only for employees in
// their governed set (super admin → all; local admin → scope; manager → reports).
// The /v2/pip mount is already gated to manager/admin in routes/index.js.
//
// A VIEWER NEVER ACTS. The mount guard is by the SHAPE of the role
// (requireManagerOrAdmin) and let a read-only delegation through: measured,
// viewer 1035 POST /v2/pip/propose {employeeId:87} -> 200, pips 0 -> 1,
// initiated_by = 1035. Every write route below goes through this predicate.
//
// And the LINE of the person behind an administration account counts: a
// manager signed in on their linked admin account (admins.linked_employee_id)
// was listed their team by scopeFilter and refused every one of them here
// (getFilteredEmployees is clearance only). Same union as RBACService.scopeFilter.
async function canManage(user, employeeId) {
    if (RBACService.isViewer(user)) return false;
    if (RBACService.isSuperAdmin(user)) return true;
    const emps = await RBACService.getFilteredEmployees(user);
    if (emps.some((e) => Number(e.id) === Number(employeeId))) return true;
    if (user && user.userType === 'admin') {
        const line = await require('../services/GovernanceService').lineAuthorityEmployeeIds(user);
        return line.some((id) => Number(id) === Number(employeeId));
    }
    return false;
}

router.get(
    '/',
    requireAuth,
    ah(async (req, res) => {
        const sc = await RBACService.scopeFilter(req.user, { empAlias: 'e' });
        const list = await db.all(
            `SELECT p.*, e.first_name, e.last_name, e.employee_number
         FROM pips p JOIN employees e ON e.id = p.employee_id
         WHERE 1=1 ${sc.clause} ORDER BY p.created_at DESC`,
            sc.params
        );
        const employees = (await RBACService.getFilteredEmployees(req.user)).map((e) => ({
            id: Number(e.id),
            name: `${e.firstName} ${e.lastName}`,
            number: e.employeeNumber || '',
        }));
        // the tasks a low placement raised, waiting on THIS manager's decision.
        // Fail-soft — the console must still open if the queue query fails.
        const tasks = await TalentTaskService.listOpen(req.user).catch(() => []);
        res.render('pages/pip/index', {
            list,
            employees,
            tasks,
            title: req.t ? req.t('pip:title') : 'Performance Improvement Plans',
        });
    })
);

// ---- A3: the machine proposes, the manager decides -------------
// A low-performance placement no longer opens a plan; it raises a task here.
// The manager turns the task into a plan WITH A WRITTEN REASON, or records that
// no plan is needed — also with a reason. Nothing closes silently.

router.get(
    '/tasks',
    requireAuth,
    ah(async (req, res) => {
        res.json({ ok: true, tasks: await TalentTaskService.listOpen(req.user) });
    })
);

router.post(
    '/tasks/:id/open-plan',
    requireAuth,
    ah(async (req, res) => {
        const task = await TalentTaskService.get(req.params.id);
        if (!task || task.state !== 'open')
            return res.status(404).json({ ok: false, error: 'Task not found or already resolved' });
        if (!(await canManage(req.user, task.employeeId))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        const reason = req.body.reason == null ? '' : String(req.body.reason).trim();
        if (!reason) {
            const msg = req.t
                ? req.t('flash:pip_reason_required', {
                      defaultValue:
                          'Un motif écrit est obligatoire pour ouvrir un plan d’amélioration.',
                  })
                : 'Un motif écrit est obligatoire pour ouvrir un plan d’amélioration.';
            return res.status(400).json({ ok: false, error: msg });
        }
        // The manager's own words are the plan's summary. CONFIDENTIALITY: the
        // summary is read by the SUBJECT, so if the manager names the 9-box cell in
        // it, TalentConfidentialityService strips that sentence on the way out to
        // them (src/controllers/EmployeePortalController.myDevelopment). Nothing is
        // rewritten in storage — the manager keeps their record.
        let row;
        try {
            row = await PipService.proposeDirect({
                employeeId: task.employeeId,
                actor: req.user,
                startsOn: req.body.startsOn,
                endsOn: req.body.endsOn,
                summary: req.body.summary || reason,
                objectives: req.body.objectives,
                successCriteria: req.body.successCriteria,
                reviewCheckpoints: req.body.reviewCheckpoints,
                supportOffered: req.body.supportOffered,
                originEvaluationId: task.originEvaluationId || null,
            });
        } catch (e) {
            if (e && e.code === 'PIP_OPEN_EXISTS') {
                const msg = req.t
                    ? req.t('flash:pip_open_plan_exists', { defaultValue: e.message })
                    : e.message;
                return res
                    .status(409)
                    .json({ ok: false, error: msg, existingId: e.existingId || null });
            }
            if (e && e.code === 'INVALID_PERIOD') {
                const msg = req.t
                    ? req.t('flash:pip_invalid_period', { defaultValue: e.message })
                    : e.message;
                return res.status(400).json({ ok: false, error: msg });
            }
            throw e;
        }
        await TalentTaskService.resolve(
            task.id,
            req.user,
            { resolution: 'plan_opened', reason, targetId: row.id },
            req
        );
        // The support plan that used to be created automatically beside the PIP now
        // hangs off the plan a human opened. Never lets a coaching failure undo it.
        const coaching =
            await require('../services/DevelopmentTriggerService').createSupportCoaching(
                req.user,
                task.employeeId,
                row.id,
                req
            );
        res.json({ ok: true, id: row.id, coachingPlanId: coaching.coachingPlanId || null });
    })
);

router.post(
    '/tasks/:id/dismiss',
    requireAuth,
    ah(async (req, res) => {
        const task = await TalentTaskService.get(req.params.id);
        if (!task || task.state !== 'open')
            return res.status(404).json({ ok: false, error: 'Task not found or already resolved' });
        if (!(await canManage(req.user, task.employeeId))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        try {
            const done = await TalentTaskService.resolve(
                task.id,
                req.user,
                { resolution: 'no_plan', reason: req.body.reason },
                req
            );
            if (!done) return res.status(409).json({ ok: false, error: 'Task is not open' });
        } catch (e) {
            if (e && e.code === 'REASON_REQUIRED')
                return res.status(400).json({ ok: false, error: e.message });
            throw e;
        }
        res.json({ ok: true });
    })
);
// ---- tasks ---------------------------------------------------

// Propose — direct (manager-managed; no HR maker-checker step).
router.post(
    '/propose',
    requireAuth,
    ah(async (req, res) => {
        const employeeId = Number(req.body.employeeId);
        if (!employeeId) return res.status(400).json({ ok: false, error: 'employeeId required' });
        if (!(await canManage(req.user, employeeId))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        let row;
        try {
            row = await PipService.proposeDirect({
                employeeId,
                actor: req.user,
                startsOn: req.body.startsOn,
                endsOn: req.body.endsOn,
                summary: req.body.summary,
                objectives: req.body.objectives,
                successCriteria: req.body.successCriteria,
                reviewCheckpoints: req.body.reviewCheckpoints,
                supportOffered: req.body.supportOffered,
            });
        } catch (e) {
            // Deliberate refusals from the service carry their own status: a second
            // open PIP for the same person is a 409, an impossible period a 400 —
            // never the raw unique-violation / driver text as a 500.
            if (e && e.code === 'PIP_OPEN_EXISTS') {
                const msg = req.t
                    ? req.t('flash:pip_open_plan_exists', { defaultValue: e.message })
                    : e.message;
                return res
                    .status(409)
                    .json({ ok: false, error: msg, existingId: e.existingId || null });
            }
            if (e && e.code === 'INVALID_PERIOD') {
                const msg = req.t
                    ? req.t('flash:pip_invalid_period', { defaultValue: e.message })
                    : e.message;
                return res.status(400).json({ ok: false, error: msg });
            }
            throw e;
        }
        res.json({ ok: true, id: row.id });
    })
);

router.post(
    '/:id/activate',
    requireAuth,
    ah(async (req, res) => {
        const pip = await db.get('SELECT employee_id FROM pips WHERE id = ?', [
            Number(req.params.id),
        ]);
        if (!pip) return res.status(404).json({ ok: false, error: 'PIP not found' });
        if (!(await canManage(req.user, pip.employeeId))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        // `activate` reports whether it actually changed anything. Answering ok:true
        // regardless meant a second click, or a PIP already active or closed, was
        // confirmed as a fresh activation.
        const activated = await PipService.activate(Number(req.params.id));
        if (!activated) {
            return res
                .status(409)
                .json({ ok: false, error: 'This PIP is not in a state that can be activated.' });
        }
        res.json({ ok: true });
    })
);

router.post(
    '/:id/close',
    requireAuth,
    ah(async (req, res) => {
        const pip = await db.get('SELECT employee_id FROM pips WHERE id = ?', [
            Number(req.params.id),
        ]);
        if (!pip) return res.status(404).json({ ok: false, error: 'PIP not found' });
        if (!(await canManage(req.user, pip.employeeId))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        // Tell the caller their note was unusable rather than dropping it silently
        // (the service also bounds it, for every other caller).
        if (req.body.outcome != null && typeof req.body.outcome !== 'string') {
            return res.status(400).json({ ok: false, error: 'outcome must be text' });
        }
        // The closure carries its author (closed_by_ref + PIP_CLOSED with actor_ref)
        // and a NOT-MET verdict needs a written note — the service refuses it with
        // REASON_REQUIRED, answered here as a 400 in the page's language.
        let closed;
        try {
            closed = await PipService.close(
                Number(req.params.id),
                req.body.success === 'true' || req.body.success === true,
                req.body.outcome,
                req.user,
                req
            );
        } catch (e) {
            if (e && e.code === 'REASON_REQUIRED') {
                const msg = req.t
                    ? req.t('flash:pip_close_note_required', { defaultValue: e.message })
                    : e.message;
                return res.status(400).json({ ok: false, error: msg });
            }
            throw e;
        }
        if (!closed)
            return res
                .status(409)
                .json({ ok: false, error: 'PIP is not in an open state (already closed?)' });
        res.json({ ok: true });
    })
);

// ---- the owner closes their own plan ---------------------------
// Rulebook rule 8: "un plan ouvert automatiquement doit pouvoir être refermé par
// son propriétaire, sans procédure administrative à deux personnes". Cancelling
// a PIP was a CancellationService request an ADMINISTRATOR decided, and /v2/pip
// had no cancel route at all — so a plan that should never have run could only
// be closed as met/not met, or left to expire against the person's record
// (measured: PIP #12, 'proposed' from 2026-06-15 to its own end date).
//
// Withdrawing is NOT a verdict: state becomes 'cancelled', never
// 'closed_failure'. A written reason is mandatory — this is the one action whose
// whole purpose is to explain why a plan stops without a judgement. The
// two-person queue stays for closing somebody ELSE's plan.
router.post(
    '/:id/withdraw',
    requireAuth,
    ah(async (req, res) => {
        const pipId = Number(req.params.id);
        const pip = await db.get('SELECT employee_id, state FROM pips WHERE id = ?', [pipId]);
        if (!pip) return res.status(404).json({ ok: false, error: 'PIP not found' });
        if (!(await canManage(req.user, pip.employeeId))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        try {
            const done = await PipService.withdraw(pipId, req.body.reason, req.user, req);
            if (!done)
                return res
                    .status(409)
                    .json({ ok: false, error: 'PIP is not in an open state (already closed?)' });
        } catch (e) {
            if (e && e.code === 'REASON_REQUIRED')
                return res.status(400).json({ ok: false, error: e.message });
            throw e;
        }
        res.json({ ok: true });
    })
);
// ---- withdraw ------------------------------------------------

module.exports = router;
