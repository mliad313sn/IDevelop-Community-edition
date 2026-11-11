'use strict';

/**
 * Privacy notice gate (GDPR art. 13/14 and equivalent national laws).
 *
 * Every signed-in person (employee, manager or administrator) is held on
 * /privacy/notice until they have acknowledged the PUBLISHED version in force,
 * at first sign-in and again whenever a SuperAdmin publishes a new version. The
 * acknowledgement is keyed on the signed-in identity, so on a shared kiosk each
 * person acknowledges once, whatever the device.
 *
 * Never held: the sign-in / MFA / sign-out / forced-password-change flows (the
 * earlier holds must stay reachable or they would bounce into this one), the
 * notice itself, the language switch, static assets, health probes, and
 * machine traffic (API keys, SCIM, LTI, /api/v1).
 *
 * Failure policy:
 *   - no version was ever published (or the table does not exist yet): the
 *     feature is off, let through (logged once);
 *   - any other error while reading the version or the acknowledgement:
 *     FAIL CLOSED, held on the notice page (JSON callers get a 403).
 *
 * Mounted in server.js after the MFA / auth-policy holds and before the routes.
 */

const { wantsJson } = require('../utils/wantsJson');

const NOTICE_PATH = '/privacy/notice';

const EXEMPT_EXACT = new Set(['/login', '/logout', '/favicon.ico', '/robots.txt', '/sw.js']);
const EXEMPT_PREFIXES = [
    '/login/', // /login/mfa and the SSO sign-in steps
    '/auth/', // SSO initiate / callback / choose
    '/saml/',
    '/v2/uam/mfa', // MFA setup / verify / manage
    '/change-password',
    NOTICE_PATH, // the notice and its acknowledgement
    '/lang/', // read the notice in the other language
    '/health', // /health, /healthz
    '/readyz',
    '/metrics',
    '/css/',
    '/js/',
    '/images/',
    '/img/',
    '/vendor/',
    '/fonts/',
    '/branding/',
    '/manifest',
    '/scim',
    '/lti',
    '/api/v1',
    // The page chrome of the notice itself (bell, action centre): the person's
    // own counters. Refusing them only fills the console with 403s.
    '/api/my-actions',
    '/api/notifications',
];

function isExempt(p) {
    if (EXEMPT_EXACT.has(p)) return true;
    return EXEMPT_PREFIXES.some((x) => p === x || p.startsWith(x));
}

let _loggedOff = false;

function hold(req, res, p) {
    if (wantsJson(req) || p.startsWith('/api/')) {
        const msg = 'Please read and acknowledge the privacy notice first.';
        return res.status(403).json({
            ok: false,
            error: req.t ? req.t('compliance:privacy_notice_required', { defaultValue: msg }) : msg,
            code: 'privacy_notice_required',
            privacyNoticeRequired: true,
            redirect: NOTICE_PATH,
        });
    }
    // Come back where the person was going (GET pages only, same-origin path).
    if (req.method === 'GET' && req.session) {
        const target = String(req.originalUrl || '');
        if (/^\/(?!\/)[^\\\r\n]*$/.test(target) && target.length <= 500) {
            req.session.privacyReturnTo = target;
        }
    }
    return res.redirect(NOTICE_PATH);
}

async function privacyNotice(req, res, next) {
    const u = req.user;
    if (!u) return next();
    if (typeof req.isAuthenticated === 'function' && !req.isAuthenticated()) return next();
    if (u._apiKey) return next(); // API-key principal (BI tools, integrations)
    const p = req.path || '';
    if (isExempt(p)) return next();

    const Privacy = require('../services/PrivacyService');
    let current;
    try {
        current = await Privacy.currentVersion();
    } catch (e) {
        console.error('[privacy-notice] version lookup failed, held:', e && e.message);
        return hold(req, res, p);
    }
    if (!current) {
        if (!_loggedOff) {
            _loggedOff = true;
            if (process.env.NODE_ENV !== 'test')
                console.log('[privacy-notice] no published notice version: gate inactive');
        }
        return next();
    }
    const identity = Privacy.identityOf(u);
    if (!identity) return hold(req, res, p);
    const version = Number(current.version);

    // Per-session memo, bound to the identity AND the version: a kiosk session
    // that changes hands or a new version published meanwhile both miss it and
    // go back to the database.
    const memo = req.session && req.session.privacyAck;
    if (memo && memo.t === identity.type && memo.id === identity.id && memo.v === version)
        return next();

    let ok = false;
    try {
        ok = await Privacy.hasAcknowledged(identity, version);
    } catch (e) {
        console.error('[privacy-notice] acknowledgement lookup failed, held:', e && e.message);
        return hold(req, res, p);
    }
    if (ok) {
        if (req.session) req.session.privacyAck = { t: identity.type, id: identity.id, v: version };
        return next();
    }
    return hold(req, res, p);
}

module.exports = { privacyNotice, isExempt, NOTICE_PATH };
