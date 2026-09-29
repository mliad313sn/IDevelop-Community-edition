'use strict';

/**
 * AI companion API — the « Assistant » tab of the help panel, for EVERY signed-in
 * user (employee, manager, administrator). Mounted at /api/companion.
 *
 *   POST /api/companion/ask          { question (≤ 500 chars), path? } → answer
 *   GET  /api/companion/suggestions  ?path=/current/page               → prompts
 *
 * Authentication: any signed-in account (requireAuth). CSRF: the global
 * csrf-sync middleware checks the POST like every other JSON endpoint (the
 * client sends the page's token in x-csrf-token). The ask is rate limited per
 * user (writeActionLimiter) on top of the global /api/ limiter. Both routes
 * answer 404 while the administrator has switched the companion off
 * (companion.enabled). See src/services/CompanionService.js.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { writeActionLimiter } = require('../middleware/rateLimiter');
const ah = require('../utils/asyncHandler');
const Companion = require('../services/CompanionService');

const langOf = (req) =>
    String(req.language || (req.i18n && req.i18n.language) || 'fr')
        .toLowerCase()
        .startsWith('en')
        ? 'en'
        : 'fr';

const translatorFor = (req) => (key, fallback, params) =>
    typeof req.t === 'function'
        ? req.t(key, { defaultValue: fallback, ...(params || {}) })
        : fallback;

async function requireEnabled(req, res, next) {
    if (await Companion.isEnabled()) return next();
    const msg =
        typeof req.t === 'function'
            ? req.t('companion:disabled', { defaultValue: 'The assistant is switched off.' })
            : 'The assistant is switched off.';
    return res.status(404).json({ ok: false, code: 'companion_disabled', error: msg });
}

router.post(
    '/ask',
    requireAuth,
    ah(requireEnabled),
    writeActionLimiter,
    ah(async (req, res) => {
        const body = req.body || {};
        if (typeof body.question !== 'string' || !body.question.trim())
            return res
                .status(400)
                .json({ ok: false, code: 'question_required', error: 'question required' });
        const question = body.question.trim();
        if (question.length > Companion.MAX_QUESTION) {
            const msg =
                typeof req.t === 'function'
                    ? req.t('companion:too_long', { defaultValue: '500 characters maximum.' })
                    : '500 characters maximum.';
            return res.status(400).json({ ok: false, code: 'question_too_long', error: msg });
        }
        const path = typeof body.path === 'string' ? body.path : '';
        const out = await Companion.ask(req.user, question, {
            path,
            lng: langOf(req),
            translate: translatorFor(req),
        });
        res.json({ ok: true, ...out });
    })
);

router.get(
    '/suggestions',
    requireAuth,
    ah(requireEnabled),
    ah(async (req, res) => {
        const path = typeof req.query.path === 'string' ? req.query.path : '';
        res.json({
            ok: true,
            suggestions: Companion.suggestions(req.user, path, { lng: langOf(req) }),
        });
    })
);

module.exports = router;
