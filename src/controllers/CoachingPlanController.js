'use strict';
const svc = require('../services/CoachingPlanService');
// Shared JSON error discipline: domain errors keep their message + status, DB /
// runtime faults become one generic FR sentence + a request id and are logged.
// See utils/apiErrors — the old inline wrapper returned err.message for EVERY
// throw, so raw PostgreSQL text reached the browser.
const { makeHandle, requireId } = require('../utils/apiErrors');

const handle = makeHandle('CoachingPlanController');
/** Route :id → positive integer, or a 400 "identifiant invalide" before any query. */
const id = (req, name = 'id') => requireId(req.params[name], name);

class CoachingPlanController {
    create = handle(async (req) => ({ plan: await svc.createPlan(req.user, req.body, req) }));
    addAction = handle(async (req) => ({
        action: await svc.addAction(req.user, id(req), req.body, req),
    }));
    progress = handle(async (req) => ({
        plan: await svc.updateProgress(req.user, id(req), req.body, req),
    }));
    actionUpdate = handle(async (req) => ({
        action: await svc.updateAction(req.user, id(req, 'actionId'), req.body, req),
    }));
    session = handle(async (req) => ({
        result: await svc.recordSession(req.user, id(req), req.body, req),
    }));
    validate = handle(async (req) => ({
        plan: await svc.validateCompletion(req.user, id(req), req),
    }));
    cancel = handle(async (req) => ({
        plan: await svc.cancelPlan(req.user, id(req), req),
    }));
    get = handle(async (req) => {
        const plan = await svc.getPlan(id(req));
        if (!plan) throw new Error('Plan not found');
        const auth = await svc.resolveAuthority(req.user, plan.employeeId);
        if (!(auth.canView || auth.canSupervise || auth.canManage)) {
            throw new Error('Not authorized');
        }
        // The SUBJECT reads their own plan here too (3.23.17, B-7): same A4
        // confidentiality guard as /api/coaching/mine — free text a manager
        // typed (title, objective, outcome, actions, context) must not
        // disclose an undisclosed 9-box placement. Either of the subject's
        // accounts counts as the subject.
        const { personIdOf } = require('../utils/personIdentity');
        const viewer = await personIdOf(req.user);
        if (viewer != null && viewer === Number(plan.employeeId)) {
            return { plan: await this._redactPlanForSubject(plan) };
        }
        return { plan };
    });

    /** One full plan (with actions + context) as its SUBJECT may read it. Fails closed. */
    async _redactPlanForSubject(plan) {
        const conf = require('../services/TalentConfidentialityService');
        let disclosed = false;
        try {
            disclosed = Boolean(await conf.disclosedPlacement(plan.employeeId));
        } catch (_) {
            disclosed = false;
        }
        const safe = (t) => (t == null ? t : conf.redactForSubject(String(t), { disclosed }).text);
        return {
            ...plan,
            title: safe(plan.title),
            objective: safe(plan.objective),
            expectedOutcome: safe(plan.expectedOutcome),
            actions: Array.isArray(plan.actions)
                ? plan.actions.map((a) => ({
                      ...a,
                      description: safe(a.description),
                      progressNote: safe(a.progressNote),
                  }))
                : plan.actions,
            context:
                plan.context && typeof plan.context === 'object'
                    ? { ...plan.context, label: safe(plan.context.label) }
                    : plan.context,
        };
    }
    // /api/coaching/mine is what my-coaching.ejs re-renders from on load, so the
    // A4 guard has to live here too — guarding only the server render would let
    // the client put the 9-box label straight back on the page.
    mine = handle(async (req) => ({
        items: await this._safeForSubject(req.user.id, await svc.listForEmployee(req.user.id)),
    }));

    /** Redact 9-box vocabulary from coaching rows a SUBJECT reads (see myPage). */
    async _safeForSubject(employeeId, items) {
        try {
            const conf = require('../services/TalentConfidentialityService');
            const disclosed = Boolean(await conf.disclosedPlacement(employeeId));
            const safe = (t) => conf.redactForSubject(t, { disclosed }).text;
            return items.map((p) => ({
                ...p,
                title: safe(p.title || ''),
                objective: safe(p.objective || ''),
                expectedOutcome: safe(p.expectedOutcome || ''),
            }));
        } catch (_) {
            return items;
        }
    }
    queue = handle(async (req) => ({ items: await svc.listForSupervisor(req.user) }));
    monitor = handle(async (req) => ({ monitor: await svc.monitor(req.user) }));
    roster = handle(async (req) => ({ employees: await svc.roster(req.user) }));
    contextOptions = handle(async (req) => ({
        options: await svc.contextOptions(req.user, id(req, 'employeeId')),
    }));

    consolePage = (req, res) =>
        res.render('pages/coaching/plans-console', {
            title: req.t ? req.t('chrome:pt_coaching_mentoring') : 'Coaching & Mentoring',
        });
    // Server-render the initial rows (usable without JS); the JS re-renders on load.
    //
    // 3 — same confidentiality guard as /employee/my-development.
    // A coaching plan title and objective are free text a manager types, and this
    // page is read by the SUBJECT: naming their 9-box cell here would disclose a
    // placement nobody decided to disclose. `redactForSubject` drops the sentence
    // that names it and keeps everything else the manager wrote.
    myPage = async (req, res) => {
        let items = [];
        try {
            items = await svc.listForEmployee(req.user.id);
        } catch (_) {
            items = [];
        }
        items = await this._safeForSubject(req.user.id, items);
        res.render('pages/employee/my-coaching', {
            title: req.t ? req.t('chrome:pt_my_coaching_mentoring') : 'My Coaching & Mentoring',
            items,
        });
    };
}
module.exports = new CoachingPlanController();
