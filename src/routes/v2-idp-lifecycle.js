'use strict';

/**
 * IDP lifecycle routes (3.23.17, F3) — complete / archive a plan, move an
 * objective. Mounted under /v2/idp NEXT TO routes/v2-idp.js:
 *
 *     router.use('/v2/idp', require('./v2-idp-lifecycle'));
 *
 * Every decision (who may act, from which state, with which reason) lives in
 * IDPService; these handlers only translate the outcome: a plain HTML form
 * gets a flash and a redirect back to the plan, an XHR/API caller gets JSON.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const IDPService = require('../services/IDPService');
const ah = require('../utils/asyncHandler');

function wantsJson(req) {
    return Boolean(req.xhr || String(req.headers.accept || '').indexOf('json') > -1);
}

function say(req, e) {
    if (e && e.i18n && req.t) {
        return req.t(e.i18n.key, { ...(e.i18n.vars || {}), defaultValue: e.message });
    }
    return (e && e.message) || 'Error';
}

/**
 * Run one lifecycle move and answer. Only the service's own refusals (they
 * carry `code` + `status`) are answered here; anything else is a real failure
 * and goes to the error handler.
 */
function handle(action, { successKey, successFallback, backTo }) {
    return ah(async (req, res) => {
        let result;
        let back;
        try {
            ({ result, back } = await action(req));
        } catch (e) {
            if (!(
                e &&
                e.code &&
                typeof e.code === 'string' &&
                e.code.startsWith('IDP_') &&
                e.status
            ))
                throw e;
            const message = say(req, e);
            if (wantsJson(req))
                return res.status(e.status).json({ ok: false, code: e.code, error: message });
            req.flash('error', message);
            return res.redirect(backTo(req, e));
        }
        if (wantsJson(req)) return res.json({ ok: true, ...result });
        req.flash(
            'success',
            req.t ? req.t(successKey, { defaultValue: successFallback }) : successFallback
        );
        return res.redirect(back);
    });
}

const planPage = (req) => '/v2/idp/' + Number(req.params.id);

router.post(
    '/:id(\\d+)/complete',
    requireAuth,
    handle(
        async (req) => ({
            result: await IDPService.completePlan({
                idpId: Number(req.params.id),
                user: req.user,
                reason: req.body && req.body.reason,
            }),
            back: planPage(req),
        }),
        {
            successKey: 'idp:flash_completed',
            successFallback: 'Plan de développement terminé.',
            backTo: planPage,
        }
    )
);

router.post(
    '/:id(\\d+)/archive',
    requireAuth,
    handle(
        async (req) => ({
            result: await IDPService.archivePlan({
                idpId: Number(req.params.id),
                user: req.user,
                reason: req.body && req.body.reason,
            }),
            back: planPage(req),
        }),
        {
            successKey: 'idp:flash_archived',
            successFallback: 'Plan de développement archivé.',
            backTo: planPage,
        }
    )
);

// The plan detail offered no way to ADD an objective or an action (a dead end).
// Two plain HTML forms on the detail page post here; authority, state and
// journalling live in IDPService.addObjective / addAction.
router.post(
    '/:id(\\d+)/objectives',
    requireAuth,
    handle(
        async (req) => ({
            result: await IDPService.addObjective({
                idpId: Number(req.params.id),
                user: req.user,
                smartText: req.body && req.body.smartText,
                skillId: req.body && req.body.skillId,
                dueOn: req.body && req.body.dueOn,
                locale: String(req.language || 'fr').slice(0, 2) === 'en' ? 'en' : 'fr',
            }),
            back: planPage(req) + '#idp-objectives',
        }),
        {
            successKey: 'idp:flash_objective_added',
            successFallback: 'Objective added.',
            backTo: planPage,
        }
    )
);

router.post(
    '/:id(\\d+)/actions',
    requireAuth,
    handle(
        async (req) => ({
            result: await IDPService.addAction({
                idpId: Number(req.params.id),
                user: req.user,
                title: req.body && req.body.title,
                type: req.body && req.body.type,
                description: req.body && req.body.description,
                objectiveId: req.body && req.body.objectiveId,
                skillId: req.body && req.body.skillId,
                plannedHours: req.body && req.body.plannedHours,
                dueOn: req.body && req.body.dueOn,
            }),
            back: planPage(req) + '#idp-actions',
        }),
        {
            successKey: 'idp:flash_action_added',
            successFallback: 'Action added.',
            backTo: planPage,
        }
    )
);

// ---------------------------------------------------------------------------
// THE ACTION LOOP (4.0.0 port, wave 4): start / report done / validate / give
// a training. Plain HTML forms from the plan page and the person's development
// page. Who may do what is decided by IDPService (the person starts and
// reports, only the line validates); these handlers only answer.
// ---------------------------------------------------------------------------

/**
 * Where a form comes back to: a FIXED set of relative paths, never a URL taken
 * from the request. `back=mine` is the person's development page; anything
 * else is the plan page (at the action).
 */
function backFor(req, fallback) {
    const b = String((req.body && req.body.back) || '');
    if (b === 'mine') return '/employee/my-development';
    if (b === 'manage') return '/v2/idp/manage#proposals';
    if (b === 'propose') return '/v2/idp/propose';
    return fallback;
}

async function planOfAction(actionId) {
    const db = require('../config/database');
    const row = await db.get('SELECT idp_id AS "idpId" FROM idp_actions WHERE id = ?', [
        Number(actionId),
    ]);
    return row ? Number(row.idpId) : null;
}

function actionRoute(path, run, successKey, successFallback) {
    router.post(
        '/actions/:aid(\\d+)/' + path,
        requireAuth,
        ah(async (req, res, next) => {
            const idpId = await planOfAction(req.params.aid);
            const anchor =
                idpId != null
                    ? `/v2/idp/${idpId}#action-${Number(req.params.aid)}`
                    : '/employee/my-development';
            return handle(async (r) => ({ result: await run(r), back: backFor(r, anchor) }), {
                successKey,
                successFallback,
                backTo: (r) => backFor(r, anchor),
            })(req, res, next);
        })
    );
}

actionRoute(
    'start',
    (req) => IDPService.startAction({ actionId: Number(req.params.aid), user: req.user }),
    'idp:flash_action_started',
    'Action started.'
);
actionRoute(
    'done',
    (req) =>
        IDPService.reportActionDone({
            actionId: Number(req.params.aid),
            user: req.user,
            note: req.body && req.body.note,
            hours: req.body && req.body.hours,
        }),
    'idp:flash_action_reported',
    'Noted: your manager will validate this action.'
);
actionRoute(
    'validate',
    (req) =>
        IDPService.validateAction({
            actionId: Number(req.params.aid),
            user: req.user,
            observedLevel: req.body && req.body.observedLevel,
            note: req.body && req.body.note,
            actualHours: req.body && req.body.actualHours,
        }),
    'idp:flash_action_validated',
    'Action validated.'
);
actionRoute(
    'training',
    (req) =>
        IDPService.planTraining({
            actionId: Number(req.params.aid),
            user: req.user,
            courseId: req.body && req.body.courseId,
            dueOn: req.body && req.body.dueOn,
            place: req.body && req.body.place,
            plannedHours: req.body && req.body.plannedHours,
        }),
    'idp:flash_training_planned',
    'Training planned.'
);

// ---------------------------------------------------------------------------
// PROPOSALS (4.0.0 port, wave 4): the person proposes an action to their line;
// the line accepts it into the plan or declines it with a reason.
// ---------------------------------------------------------------------------
router.get(
    '/propose',
    requireAuth,
    ah(async (req, res) => {
        // An administration account proposes nothing for itself: the team console.
        if (req.user.userType === 'admin') return res.redirect('/v2/idp/manage');
        const db = require('../config/database');
        const me = Number(req.user.id);
        const skills = await db.all(
            `SELECT s.id, s.name, rsr.required_level AS "required", sa.current_level AS "current"
               FROM employees e
               JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id AND rsr.required_level > 0
               JOIN skills s ON s.id = rsr.skill_id
               LEFT JOIN skill_assessments sa ON sa.employee_id = e.id AND sa.skill_id = s.id
              WHERE e.id = ? ORDER BY s.name`,
            [me]
        );
        const mine = await require('../services/DevelopmentLoopService')
            .proposals(me)
            .catch(() => []);
        const pre = Number(req.query.skillId) || null;
        res.render('pages/idp/propose', {
            skills,
            proposals: mine,
            preSkillId: skills.some((x) => Number(x.id) === pre) ? pre : null,
            actionTypes: IDPService.ACTION_TYPES,
            title: req.t ? req.t('idp:propose_title') : 'Propose an action',
        });
    })
);

router.post(
    '/proposals',
    requireAuth,
    handle(
        async (req) => ({
            result: await IDPService.proposeAction({
                user: req.user,
                skillId: req.body && req.body.skillId,
                type: req.body && req.body.type,
                text: req.body && req.body.text,
            }),
            back: backFor(req, '/v2/idp/propose'),
        }),
        {
            successKey: 'idp:flash_proposal_sent',
            successFallback: 'Your proposal was sent.',
            backTo: (req) => backFor(req, '/v2/idp/propose'),
        }
    )
);

router.post(
    '/proposals/:pid(\\d+)/decide',
    requireAuth,
    handle(
        async (req) => {
            const r = await IDPService.decideProposal({
                proposalId: Number(req.params.pid),
                user: req.user,
                decision: req.body && req.body.decision,
                reason: req.body && req.body.reason,
            });
            return {
                result: r,
                back: r && r.idpId ? '/v2/idp/' + Number(r.idpId) : '/v2/idp/manage#proposals',
            };
        },
        {
            successKey: 'idp:flash_proposal_decided',
            successFallback: 'Decision recorded.',
            backTo: () => '/v2/idp/manage#proposals',
        }
    )
);

// The objective's plan is resolved by the service; the redirect needs it too.
async function planOfObjective(objectiveId) {
    const db = require('../config/database');
    const row = await db.get('SELECT idp_id AS "idpId" FROM idp_objectives WHERE id = ?', [
        Number(objectiveId),
    ]);
    return row ? Number(row.idpId) : null;
}

router.post(
    '/objectives/:oid(\\d+)/state',
    requireAuth,
    ah(async (req, res, next) => {
        const idpId = await planOfObjective(req.params.oid);
        req.params.id = idpId != null ? String(idpId) : '0';
        return handle(
            async (r) => ({
                result: await IDPService.setObjectiveState({
                    objectiveId: Number(r.params.oid),
                    user: r.user,
                    state: r.body && r.body.state,
                    note: r.body && r.body.note,
                }),
                back: idpId != null ? planPage(r) : '/v2/idp',
            }),
            {
                successKey: 'idp:flash_objective_updated',
                successFallback: 'Objectif mis à jour.',
                backTo: (r) => (idpId != null ? planPage(r) : '/v2/idp'),
            }
        )(req, res, next);
    })
);

module.exports = router;
