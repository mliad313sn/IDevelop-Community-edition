'use strict';

/**
 * requireSessionCsrf — the session's synchroniser token, required on one JSON
 * route on top of the same-origin guard.
 *
 * `/api/*` is exempt from the global csrf-sync check (httpHardening.csrfSkip):
 * a JSON mutation there is defended by the origin guard alone. "Approve all"
 * writes many official skill levels in one request, so it also asks for the
 * session's token — the header every signed-in page already sends
 * (public/js/main.js adds `x-csrf-token` to each same-origin unsafe fetch from
 * <meta name="csrf-token">). Constant-time comparison; a missing session
 * token, a missing header or a mismatch is a 403 JSON refusal in the page's
 * language, never a redirect.
 */
const crypto = require('crypto');
const { csrfTokenFromRequest } = require('./httpHardening');

const FALLBACK = 'Security token missing or expired: reload the page.';

function sameToken(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireSessionCsrf(req, res, next) {
    const expected = req.session && req.session.csrfToken;
    const presented = csrfTokenFromRequest(req);
    if (sameToken(presented, expected)) return next();
    const error =
        typeof req.t === 'function'
            ? req.t('common:err_csrf_session', { defaultValue: FALLBACK })
            : FALLBACK;
    return res.status(403).json({ success: false, code: 'csrf_required', error });
}

module.exports = requireSessionCsrf;
module.exports.sameToken = sameToken;
