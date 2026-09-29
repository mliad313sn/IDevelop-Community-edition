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
            if (
                !(
                    e &&
                    e.code &&
                    typeof e.code === 'string' &&
                    e.code.startsWith('IDP_') &&
                    e.status
                )
            )
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
