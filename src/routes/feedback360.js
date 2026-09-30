'use strict';
/**
 * 360° feedback — /feedback-360 (development module; mounted behind
 * ModuleService.requireModule('development') in routes/index.js).
 *
 * Authority lives in Feedback360Service; these handlers only translate. A
 * stranger gets the app's 404 (the round does not exist for them); a known
 * party refused an action gets 403 (JSON) or a flash (HTML form).
 */
const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireManagerOrAdmin } = require('../middleware/auth');
const svc = require('../services/Feedback360Service');
const C = require('../config/feedback360');

/**
 * Refusal code → catalogue key. Literal keys only (tests read them), so the
 * catalogue and the service can never drift apart silently.
 */
const MSG = {
    f360_not_found: 'talentx:f360_err_not_found',
    f360_forbidden: 'talentx:f360_err_forbidden',
    f360_title_required: 'talentx:f360_err_title_required',
    f360_deadline_invalid: 'talentx:f360_err_deadline_invalid',
    f360_subjects_required: 'talentx:f360_err_subjects_required',
    f360_too_many_subjects: 'talentx:f360_err_too_many_subjects',
    f360_subject_inactive: 'talentx:f360_err_subject_inactive',
    f360_bad_nomination: 'talentx:f360_err_bad_nomination',
    f360_cannot_nominate_self: 'talentx:f360_err_cannot_nominate_self',
    f360_manager_already_rater: 'talentx:f360_err_manager_already_rater',
    f360_duplicate_rater: 'talentx:f360_err_duplicate_rater',
    f360_too_many_raters: 'talentx:f360_err_too_many_raters',
    f360_rater_inactive: 'talentx:f360_err_rater_inactive',
    f360_not_a_direct_report: 'talentx:f360_err_not_a_direct_report',
    f360_nominations_closed: 'talentx:f360_err_nominations_closed',
    f360_not_enough_raters: 'talentx:f360_err_not_enough_raters',
    f360_round_closed: 'talentx:f360_err_round_closed',
    f360_round_open: 'talentx:f360_err_round_open',
    f360_bad_rating: 'talentx:f360_err_bad_rating',
    f360_comment_too_long: 'talentx:f360_err_comment_too_long',
    f360_already_answered: 'talentx:f360_err_already_answered',
    f360_report_not_ready: 'talentx:f360_err_report_not_ready',
    f360_report_not_released: 'talentx:f360_err_report_not_released',
    f360_nothing_to_add: 'talentx:f360_err_nothing_to_add',
};

/** asyncHandler, plus: a translated message, and a real 404 page for a stranger. */
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

const langOf = (req, res) => (res.locals && res.locals.lang) || req.language || 'fr';
const flashOk = (req, key) => {
    if (typeof req.flash === 'function') req.flash('success', req.t ? req.t(key) : key);
};
const toArray = (v) =>
    Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v];

// ---- My 360 ------------------------------------------------------------------
router.get(
    '/',
    ah(async (req, res) => {
        const home = await svc.home(req.user);
        const isStaff = req.user.userType === 'admin' || req.user.userType === 'manager';
        res.render('pages/feedback360/index', {
            title: req.t('talentx:f360_title'),
            home,
            isStaff,
        });
    })
);

// ---- Console (managers and HR) -------------------------------------------------
router.get(
    '/manage',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const [rounds, candidates] = await Promise.all([
            svc.consoleRounds(req.user),
            svc.launchCandidates(req.user),
        ]);
        const d = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
        res.render('pages/feedback360/manage', {
            title: req.t('talentx:f360_console_title'),
            rounds,
            candidates,
            defaults: {
                deadline: d,
                minRaters: C.DEFAULT_MIN_RATERS,
                threshold: C.DEFAULT_THRESHOLD,
            },
        });
    })
);

router.post(
    '/manage/rounds',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const b = req.body || {};
        const out = await svc.launchRound(req.user, {
            title: b.title,
            deadline: b.deadline,
            minRaters: b.minRaters,
            threshold: b.threshold,
            releaseMode: b.releaseMode,
            employeeIds: toArray(b.employeeIds),
        });
        flashOk(req, 'talentx:f360_ok_launched');
        res.redirect(`/feedback-360/rounds/${out.roundId}`);
    })
);

router.get(
    '/rounds/:id',
    ah(async (req, res) => {
        const view = await svc.roundView(req.user, req.params.id);
        res.render('pages/feedback360/round', {
            title: view.round.title,
            view,
        });
    })
);

router.post(
    '/rounds/:id/close',
    ah(async (req, res) => {
        await svc.closeRound(req.user, req.params.id);
        flashOk(req, 'talentx:f360_ok_closed');
        res.redirect(`/feedback-360/rounds/${Number(req.params.id)}`);
    })
);

router.post(
    '/rounds/:id/remind',
    ah(async (req, res) => {
        const out = await svc.remind(req.user, req.params.id);
        if (typeof req.flash === 'function')
            req.flash('success', req.t('talentx:f360_ok_reminded', { n: out.reminded }));
        res.redirect(`/feedback-360/rounds/${Number(req.params.id)}`);
    })
);

// ---- Nominations -----------------------------------------------------------------
router.get(
    '/subjects/:id',
    ah(async (req, res) => {
        const view = await svc.subjectView(req.user, req.params.id);
        res.render('pages/feedback360/subject', {
            title: req.t('talentx:f360_subject_title'),
            view,
            groups: C.NOMINABLE_GROUPS,
        });
    })
);

router.get(
    '/people',
    ah(async (req, res) => {
        res.json({ data: await svc.searchPeople(req.user, req.query.q) });
    })
);

// JSON body: { raters: [{employeeId, group}], submit: boolean }
router.post(
    '/subjects/:id/nominations',
    ah(async (req, res) => {
        const b = req.body || {};
        const out = await svc.nominate(req.user, req.params.id, {
            raters: Array.isArray(b.raters) ? b.raters : [],
            submit: b.submit === true || b.submit === 'true',
        });
        res.json({ ok: true, ...out });
    })
);

// JSON body: { decisions: [{nominationId, status}], additions: [{employeeId, group}] }
router.post(
    '/subjects/:id/approve',
    ah(async (req, res) => {
        const b = req.body || {};
        const out = await svc.approve(req.user, req.params.id, {
            decisions: Array.isArray(b.decisions) ? b.decisions : [],
            additions: Array.isArray(b.additions) ? b.additions : [],
        });
        res.json({ ok: true, ...out });
    })
);

router.post(
    '/subjects/:id/release',
    ah(async (req, res) => {
        await svc.release(req.user, req.params.id);
        flashOk(req, 'talentx:f360_ok_released');
        res.redirect(`/feedback-360/subjects/${Number(req.params.id)}/report`);
    })
);

// ---- Report ---------------------------------------------------------------------
router.get(
    '/subjects/:id/report.json',
    ah(async (req, res) => {
        res.json({ data: await svc.report(req.user, req.params.id, langOf(req, res)) });
    })
);

router.get(
    '/subjects/:id/report',
    ah(async (req, res) => {
        const report = await svc.report(req.user, req.params.id, langOf(req, res));
        const view = await svc.subjectView(req.user, req.params.id);
        res.render('pages/feedback360/report', {
            title: req.t('talentx:f360_report_title'),
            report,
            view,
        });
    })
);

router.post(
    '/subjects/:id/idp',
    ah(async (req, res) => {
        const out = await svc.addToIdp(
            req.user,
            req.params.id,
            toArray((req.body || {}).skillIds),
            langOf(req, res)
        );
        if (typeof req.flash === 'function')
            req.flash(
                'success',
                req.t('talentx:f360_ok_idp', { added: out.added, skipped: out.skipped })
            );
        res.redirect(`/feedback-360/subjects/${Number(req.params.id)}/report`);
    })
);

// ---- Answering ------------------------------------------------------------------
router.get(
    '/answer/:id',
    ah(async (req, res) => {
        const q = await svc.questionnaire(req.user, req.params.id, langOf(req, res));
        res.render('pages/feedback360/answer', {
            title: req.t('talentx:f360_answer_title'),
            q,
        });
    })
);

router.post(
    '/answer/:id',
    ah(async (req, res) => {
        const b = req.body || {};
        // A form posts flat fields: r__skill__12, r__behaviour__b_listens, c__keep…
        const ratings = {};
        for (const [k, v] of Object.entries(b)) {
            const m = /^r__(skill|behaviour)__([A-Za-z0-9_]{1,64})$/.exec(k);
            if (m) ratings[`${m[1]}:${m[2]}`] = String(v);
        }
        const comments = {};
        for (const k of C.COMMENT_KINDS)
            if (typeof b[`c__${k}`] === 'string') comments[k] = b[`c__${k}`];
        if (b.ratings && typeof b.ratings === 'object') Object.assign(ratings, b.ratings);
        if (b.comments && typeof b.comments === 'object') Object.assign(comments, b.comments);
        await svc.submitResponse(req.user, req.params.id, { ratings, comments });
        const { wantsJson } = require('../middleware/auth');
        if (wantsJson(req)) return res.json({ ok: true });
        flashOk(req, 'talentx:f360_ok_answered');
        res.redirect('/feedback-360');
    })
);

module.exports = router;
module.exports.MSG = MSG;
