'use strict';

/**
 * The PERSON's side of their own performance-improvement plan (4.0.0 port,
 * wave 6, migration 195). Mounted on /employee/pip behind the development
 * module (routes/index.js) and requireEmployeeOrManager:
 *
 *   POST /:id/acknowledge                « I have read this plan » — a date,
 *                                        never an agreement
 *   POST /:id/comment                    their own observations
 *   POST /checkpoints/:rid/respond       their answer to a checkpoint
 *   GET  /:id/letter                     the printable letter of their plan
 *
 * Every route acts on the signed-in person's OWN plans only, and only on a plan
 * they may see (PipService.subjectVisibleSql: one that was activated). Any other
 * id answers « not found ». The id is a path parameter, the person is
 * req.user.id; the POSTs go through the global CSRF check.
 */
const express = require('express');
const router = express.Router();
const ah = require('../utils/asyncHandler');
const db = require('../config/database');
const PipService = require('../services/PipService');
const { requireEmployeeOrManager } = require('../middleware/auth');
const { sayText } = require('../utils/apiErrors');

const KEYS = new Map([
    ['PIP_NOT_FOUND', 'pip:err_not_found'],
    ['TEXT_REQUIRED', 'pip:err_text_required'],
    ['TEXT_TOO_LONG', 'pip:err_text_too_long'],
]);

function sendRefusal(req, res, e) {
    if (!e || !Number.isInteger(e.status) || e.status < 400 || e.status > 499) return false;
    const key = KEYS.get(e.code);
    res.status(e.status).json({
        ok: false,
        code: e.code,
        error: key ? sayText(req, key, e.message) : e.message,
    });
    return true;
}

/** A positive integer path id, or null. */
function idParam(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
}

router.use(requireEmployeeOrManager);

router.post(
    '/:id/acknowledge',
    ah(async (req, res) => {
        try {
            const done = await PipService.acknowledge(idParam(req.params.id), Number(req.user.id));
            res.json({ ok: true, acknowledged: done });
        } catch (e) {
            if (!sendRefusal(req, res, e)) throw e;
        }
    })
);

router.post(
    '/:id/comment',
    ah(async (req, res) => {
        try {
            await PipService.comment(
                idParam(req.params.id),
                Number(req.user.id),
                req.body ? req.body.comment : null
            );
            res.json({ ok: true });
        } catch (e) {
            if (!sendRefusal(req, res, e)) throw e;
        }
    })
);

router.post(
    '/checkpoints/:rid/respond',
    ah(async (req, res) => {
        try {
            await PipService.respondReview(
                idParam(req.params.rid),
                Number(req.user.id),
                req.body ? req.body.response : null
            );
            res.json({ ok: true });
        } catch (e) {
            if (!sendRefusal(req, res, e)) throw e;
        }
    })
);

router.get(
    '/:id/letter',
    ah(async (req, res) => {
        const id = idParam(req.params.id);
        const p = id
            ? await db.get(
                  `SELECT p.*, e.first_name, e.last_name, e.employee_number
                     FROM pips p JOIN employees e ON e.id = p.employee_id
                    WHERE p.id = ? AND p.employee_id = ? AND ${PipService.subjectVisibleSql('p')}`,
                  [id, Number(req.user.id)]
              )
            : null;
        if (!p)
            return res.status(404).render('pages/error', {
                message: sayText(req, 'pip:err_not_found', 'Plan not found.'),
                title: req.t ? req.t('chrome:pt_not_found') : 'Not found',
            });
        // The same confidentiality guard as « My development »: a sentence that
        // names an undisclosed 9-box cell never reaches its subject.
        const conf = require('../services/TalentConfidentialityService');
        const disclosed = Boolean(
            (await conf.nineBoxVisibleToEmployees().catch(() => false)) &&
            (await conf.disclosedPlacement(Number(req.user.id)).catch(() => null))
        );
        const safe = (text) =>
            text ? conf.redactForSubject(String(text), { disclosed }).text || '' : text;
        for (const k of [
            'summary',
            'objectives',
            'successCriteria',
            'reviewCheckpoints',
            'supportOffered',
            'outcome',
        ])
            p[k] = safe(p[k]);
        const reviews = (await PipService.listReviews(id)).map((r) => ({
            ...r,
            managerNote: safe(r.managerNote),
        }));
        res.set('Cache-Control', 'no-store');
        res.render('pages/pip/letter', {
            title: req.t ? req.t('pip:letter_title') : 'Improvement plan letter',
            pip: p,
            reviews,
            own: true,
        });
    })
);

module.exports = router;
module.exports.sendRefusal = sendRefusal;
