'use strict';
/**
 * Shared one-to-one space — /one-on-one (engagement module; mounted behind
 * ModuleService.requireModule('engagement') in routes/index.js).
 *
 *   /one-on-one              the signed-in person's own space (with their manager)
 *   /one-on-one/:employeeId  a person's space: the person, their direct manager,
 *                            or HR within scope (shared content, read-only)
 *
 * Authority lives in OneOnOneService: a stranger gets the app's 404; private
 * notes are read by their author only, whoever else asks.
 */
const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { safeBackUrl } = require('../utils/safeRedirect');
const svc = require('../services/OneOnOneService');
const GovernanceService = require('../services/GovernanceService');

/** Refusal code → catalogue key (literal keys only). */
const MSG = {
    oo_not_found: 'growth:oo_err_not_found',
    oo_forbidden: 'growth:oo_err_forbidden',
    oo_no_manager: 'growth:oo_err_no_manager',
    oo_topic_required: 'growth:oo_err_topic_required',
    oo_too_long: 'growth:oo_err_too_long',
    oo_bad_visibility: 'growth:oo_err_bad_visibility',
    oo_action_required: 'growth:oo_err_action_required',
    oo_bad_owner: 'growth:oo_err_bad_owner',
    oo_bad_date: 'growth:oo_err_bad_date',
    oo_bad_link: 'growth:oo_err_bad_link',
    oo_meeting_held: 'growth:oo_err_meeting_held',
};

const ah = (fn) =>
    asyncHandler(async (req, res, next) => {
        try {
            return await fn(req, res, next);
        } catch (e) {
            if (e && e.code && MSG[e.code] && typeof req.t === 'function') {
                e.userMessage = req.t(MSG[e.code]);
                e.message = e.userMessage;
            }
            if (e && Number(e.status) === 404) return next(e);
            throw e;
        }
    });

/** JSON for the app's fetch calls; back to the page for a plain form. */
function done(req, res, payload, okKey) {
    const { wantsJson } = require('../middleware/auth');
    if (wantsJson(req)) return res.json({ ok: true, ...(payload || {}) });
    if (okKey && typeof req.flash === 'function') req.flash('success', req.t(okKey));
    return res.redirect(safeBackUrl(req, '/one-on-one'));
}
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 'on';

router.get(
    '/',
    ah(async (req, res) => {
        const personId = await GovernanceService.actingPersonId(req.user);
        if (personId == null) {
            const e = new Error('oo_not_found');
            e.status = 404;
            e.code = 'oo_not_found';
            e.expose = true;
            throw e;
        }
        return res.redirect(`/one-on-one/${Number(personId)}`);
    })
);

router.get(
    '/:employeeId(\\d+)',
    ah(async (req, res) => {
        const space = await svc.space(req.user, req.params.employeeId);
        res.render('pages/oneonone/space', {
            title: req.t('growth:oo_title'),
            space,
        });
    })
);

router.get(
    '/:employeeId(\\d+)/data.json',
    ah(async (req, res) => {
        res.json({ data: await svc.space(req.user, req.params.employeeId) });
    })
);

router.post(
    '/:employeeId(\\d+)/topics',
    ah(async (req, res) => {
        const out = await svc.addTopic(req.user, req.params.employeeId, (req.body || {}).body);
        done(req, res, out, 'growth:oo_ok_topic');
    })
);

router.post(
    '/topics/:id(\\d+)/discussed',
    ah(async (req, res) => {
        await svc.setTopicDiscussed(req.user, req.params.id, truthy((req.body || {}).discussed));
        done(req, res);
    })
);

router.post(
    '/topics/:id(\\d+)/delete',
    ah(async (req, res) => {
        await svc.removeTopic(req.user, req.params.id);
        done(req, res);
    })
);

router.post(
    '/meetings/:id(\\d+)/notes',
    ah(async (req, res) => {
        const b = req.body || {};
        await svc.saveNote(req.user, req.params.id, String(b.visibility || ''), b.body);
        done(req, res, null, 'growth:oo_ok_note');
    })
);

router.post(
    '/meetings/:id(\\d+)/actions',
    ah(async (req, res) => {
        const b = req.body || {};
        const out = await svc.addAction(req.user, req.params.id, {
            body: b.body,
            ownerId: b.ownerId,
            dueOn: b.dueOn || null,
            idpObjectiveId: b.idpObjectiveId || null,
            goalId: b.goalId || null,
        });
        done(req, res, out, 'growth:oo_ok_action');
    })
);

router.post(
    '/actions/:id(\\d+)/done',
    ah(async (req, res) => {
        await svc.setActionDone(req.user, req.params.id, truthy((req.body || {}).done));
        done(req, res);
    })
);

router.post(
    '/meetings/:id(\\d+)/schedule',
    ah(async (req, res) => {
        await svc.schedule(req.user, req.params.id, (req.body || {}).scheduledAt);
        done(req, res, null, 'growth:oo_ok_scheduled');
    })
);

router.post(
    '/meetings/:id(\\d+)/complete',
    ah(async (req, res) => {
        const out = await svc.complete(req.user, req.params.id);
        done(req, res, out, 'growth:oo_ok_completed');
    })
);

module.exports = router;
module.exports.MSG = MSG;
