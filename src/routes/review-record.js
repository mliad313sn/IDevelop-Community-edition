'use strict';

/**
 * The end-of-campaign record (4.0.0 port, wave 5) — the signed-in person's
 * OWN records only. Mounted at /employee/review-record (core: never behind a
 * module switch, src/config/modules.js CORE_PREFIXES).
 *
 *   GET  /                          the locked / closed campaigns the person had ratings in
 *   GET  /:cycleId                  one record (live until acknowledged, then frozen)
 *   POST /:cycleId/acknowledge      « I have read it » (a reading, never an agreement)
 *   POST /:cycleId/comment          the person's comment (may be changed later)
 *
 * No route takes a person id: every call passes req.user.id, so a person can
 * only ever reach their own record. Another person's campaign, or one the
 * person had no rating in, answers 404. The POSTs go through the app-wide CSRF
 * check (server.js) like every form; the redirects are fixed relative paths
 * built from the id the database returned.
 */

const express = require('express');
const router = express.Router();
const { requireEmployeeOrManager } = require('../middleware/auth');
const ReviewRecordService = require('../services/ReviewRecordService');
const ah = require('../utils/asyncHandler');

const LIST = '/employee/review-record';

function wantsJson(req) {
    return Boolean(req.xhr || String(req.headers.accept || '').indexOf('json') > -1);
}

/** The flash sentence of one of the service's refusals. */
function refusal(req, e) {
    const key = {
        RR_NOT_FOUND: 'employee:rr_err_not_found',
        RR_NOT_CLOSED: 'employee:rr_err_not_closed',
        RR_NOT_ACKNOWLEDGED: 'employee:rr_err_not_acknowledged',
        RR_TEXT_REQUIRED: 'employee:rr_err_text_required',
        RR_TEXT_TOO_LONG: 'employee:rr_err_text_too_long',
    }[e.code];
    return req.t && key ? req.t(key) : 'Error';
}

function isRefusal(e) {
    return Boolean(e && typeof e.code === 'string' && e.code.startsWith('RR_') && e.status);
}

router.use(requireEmployeeOrManager);

router.get(
    '/',
    ah(async (req, res) => {
        const records = await ReviewRecordService.listForEmployee(Number(req.user.id));
        res.render('pages/employee/review-record', {
            title: req.t ? req.t('employee:rr_title') : 'End-of-campaign records',
            records,
            record: null,
        });
    })
);

router.get(
    '/:cycleId(\\d+)',
    ah(async (req, res, next) => {
        let record;
        try {
            record = await ReviewRecordService.view(Number(req.user.id), req.params.cycleId);
        } catch (e) {
            if (!isRefusal(e)) throw e;
            if (e.status === 404) return next(); // the app's normal 404
            req.flash('error', refusal(req, e));
            return res.redirect(LIST);
        }
        res.render('pages/employee/review-record', {
            title: req.t ? req.t('employee:rr_title') : 'End-of-campaign records',
            records: null,
            record,
            commentMax: ReviewRecordService.COMMENT_MAX,
        });
    })
);

function post(path, run, okKey) {
    router.post(
        '/:cycleId(\\d+)/' + path,
        ah(async (req, res) => {
            let back = LIST;
            try {
                const cycleId = await run(req);
                back = `${LIST}/${Number(cycleId)}`;
            } catch (e) {
                if (!isRefusal(e)) throw e;
                if (wantsJson(req))
                    return res
                        .status(e.status)
                        .json({ ok: false, code: e.code, error: refusal(req, e) });
                req.flash('error', refusal(req, e));
                return res.redirect(LIST);
            }
            if (wantsJson(req)) return res.json({ ok: true });
            req.flash('success', req.t ? req.t(okKey) : 'Saved');
            return res.redirect(back);
        })
    );
}

post(
    'acknowledge',
    async (req) => {
        const comment = req.body && typeof req.body.comment === 'string' ? req.body.comment : null;
        await ReviewRecordService.acknowledge(Number(req.user.id), req.params.cycleId, comment);
        const c = await ReviewRecordService._cycle(Number(req.user.id), req.params.cycleId);
        return c.id;
    },
    'employee:rr_ok_acknowledged'
);

post(
    'comment',
    async (req) => {
        const text = req.body && typeof req.body.comment === 'string' ? req.body.comment : '';
        await ReviewRecordService.comment(Number(req.user.id), req.params.cycleId, text);
        const c = await ReviewRecordService._cycle(Number(req.user.id), req.params.cycleId);
        return c.id;
    },
    'employee:rr_ok_comment'
);

module.exports = router;
