'use strict';
/**
 * HTTP hardening for server.js.
 *
 * These pieces used to live inline in server.js, where no test could reach
 * them without booting the whole application. They are small, pure factories
 * here, so each rule is proved on a real express stack:
 *
 *   isJsonType / JSON_TYPES   JSON detection on the MIME ESSENCE (anchored)
 *   securityHeaders           Permissions-Policy everywhere; no-referrer on /api, /scim
 *   isSsoCallbackPath         IdP callback paths (cross-site by design)
 *   makeValidatedApiCredential  a key or bearer that actually VALIDATES
 *   originGuard               same-origin guard; `Origin: null` never passes a mutation
 *   csrfSkip                  requests the synchroniser-token check does not apply to
 *   csrfFailureLogFields      never the session id, only a short hash prefix
 *   sessionCookieName         `__Host-app.sid` when always Secure, `app.sid` otherwise
 *   legacyCookieBridge        carries an `app.sid` session over the rename once
 *   sessionCookieAlias        clearCookie('app.sid') expires the cookie in use
 *   logoutHardening           Clear-Site-Data on logout
 *   healthHandler / readyHandler  status only; details for the /metrics callers
 *   requestAuditSink          which store a finished request goes to
 *
 * IDevelop-only controls stay where they were (server.js): the JSON-only 415
 * guard (middleware/jsonContentType), the SSO-migration parser skip, HSTS
 * (utils/tlsServer) and the static-document CSP.
 */
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// JSON media types: application/json and the RFC 6839 `+json` suffix
// (application/scim+json is what Entra / Okta send to /scim/v2, RFC 7644).
// The body parser, the origin guard and the CSRF skip must all agree on this.
// Anchored on the essence: the old unanchored regex matched
// `text/plain; x=application/json` or `multipart/form-data;
// boundary=application/json`, which then skipped the CSRF check.
// ---------------------------------------------------------------------------
const JSON_TYPES = Object.freeze(['application/json', 'application/*+json']);

function mimeEssence(ct) {
    return String(ct || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
}
function isJsonType(ct) {
    const e = mimeEssence(ct);
    return e === 'application/json' || /^application\/[a-z0-9!#$&^_.-]+\+json$/.test(e);
}
function isMultipart(ct) {
    return mimeEssence(ct) === 'multipart/form-data';
}

// ---------------------------------------------------------------------------
// Browser features the product never uses are denied to every page, so an
// injected script or a framed page cannot reach the camera, microphone,
// location, payment or device APIs (ASVS 14.4, tests/unit/asvsHeaders.test.js).
// ---------------------------------------------------------------------------
const PERMISSIONS_POLICY = [
    'accelerometer=()',
    'autoplay=()',
    'bluetooth=()',
    'browsing-topics=()',
    'camera=()',
    'display-capture=()',
    'encrypted-media=()',
    'fullscreen=(self)',
    'geolocation=()',
    'gyroscope=()',
    'hid=()',
    'magnetometer=()',
    'microphone=()',
    'midi=()',
    'payment=()',
    'picture-in-picture=()',
    'publickey-credentials-get=()',
    'screen-wake-lock=()',
    'serial=()',
    'usb=()',
    'xr-spatial-tracking=()',
].join(', ');

function isMachinePath(p) {
    return p === '/api' || p.startsWith('/api/') || p === '/scim' || p.startsWith('/scim/');
}

/**
 * Pages use `Referrer-Policy: same-origin` (set through helmet in server.js):
 * nothing leaves for another site and, unlike `no-referrer`, the browser sends
 * a real `Origin` on a same-origin form POST (the Fetch standard turns it into
 * `null` under no-referrer). That lets originGuard refuse `Origin: null`.
 * API and SCIM answers keep `no-referrer`.
 */
function securityHeaders(req, res, next) {
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    if (isMachinePath(req.path || '')) res.setHeader('Referrer-Policy', 'no-referrer');
    next();
}

// ---------------------------------------------------------------------------
// IdP callbacks (OIDC form_post, SAML ACS) are cross-site by design and are
// protected by state/nonce or the signed assertion instead of Origin/CSRF.
// ---------------------------------------------------------------------------
// The optional "/login" prefix: see the compatibility callback in routes/index.js.
const SSO_CALLBACK = /^(?:\/login)?\/auth\/sso\/[^/]+\/callback$/;

/** The SAML ACS configured on the SSO page when it is not the canonical path. */
function _samlAlias() {
    try {
        return require('../config/sso').samlCallbackAliasPath();
    } catch (_) {
        return null;
    }
}

function isSsoCallbackPath(p) {
    const path = String(p || '');
    if (SSO_CALLBACK.test(path)) return true;
    const alias = _samlAlias();
    return !!alias && path.replace(/\/+$/, '') === alias;
}

// ---------------------------------------------------------------------------
// A credential that may stand in for the Origin check.
// ---------------------------------------------------------------------------
/**
 * Does the request carry a credential that actually VALIDATES? The presence of
 * `?apiKey=anything` or of any `Authorization: Bearer` header used to switch
 * the origin guard off: an unvalidated string, appended by whoever crafted the
 * URL, disabling the sole CSRF defence for JSON mutations on a session-cookie
 * request. A JWT-shaped bearer is accepted when Entra bearer auth is enabled
 * (it is verified by the route's own auth and never rides a browser session);
 * everything else must resolve through ApiKeyService or match the legacy
 * shared key (never APP_KEY, S-02).
 * @param {object} [deps] injectable for tests
 */
function makeValidatedApiCredential(deps = {}) {
    const getSso = deps.sso || (() => require('../config/sso'));
    const getApiKeys = deps.apiKeys || (() => require('../services/ApiKeyService'));
    const getApiAuth = deps.apiAuth || (() => require('./apiAuth'));
    return async function validatedApiCredential(req) {
        const h = req.headers || {};
        const bearer = String(h.authorization || '').replace(/^Bearer\s+/i, '');
        const key = h['x-api-key'] || bearer || (req.query && req.query.apiKey);
        if (!key || typeof key !== 'string') return false;
        try {
            const sso = getSso();
            if (
                bearer &&
                sso.looksLikeJwt &&
                sso.looksLikeJwt(bearer) &&
                sso.isEntraBearerEnabled &&
                sso.isEntraBearerEnabled()
            )
                return true;
        } catch (_) {
            /* SSO module optional */
        }
        try {
            if (await getApiKeys().validate(key)) return true;
        } catch (_) {
            /* fall through to the legacy key */
        }
        try {
            const a = Buffer.from(String(key));
            const b = Buffer.from(String(getApiAuth().legacySharedKey() || ''));
            if (a.length && b.length && a.length === b.length && crypto.timingSafeEqual(a, b))
                return true;
        } catch (_) {
            /* no legacy key */
        }
        return false;
    };
}

// ---------------------------------------------------------------------------
// Same-origin guard for state-changing requests.
// ---------------------------------------------------------------------------
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The CSRF token check is skipped for JSON bodies (see csrfSkip), so for a JSON
 * mutation this guard is the ONLY CSRF defence and must not fall open. A
 * browser sends `Origin` on every cross-origin fetch/XHR/POST and on same-origin
 * POSTs; API clients carry a key. Form posts with no Origin go on to the token
 * check.
 *
 * @param {object} o
 * @param {() => any} o.trustProxy          app.get('trust proxy')
 * @param {(req) => Promise<boolean>} o.validatedCredential  a key/bearer that VALIDATES
 * @param {(req, action, details) => void} [o.secLog]
 */
function originGuard({ trustProxy, validatedCredential, secLog }) {
    const log = typeof secLog === 'function' ? secLog : () => {};
    return async (req, res, next) => {
        if (SAFE_METHODS.has(req.method)) return next();
        if (isSsoCallbackPath(req.path)) return next();
        const origin = req.headers.origin;
        const isJson = isJsonType(req.headers['content-type']);
        const opaque = origin === 'null';
        const missing = origin == null || origin === '';
        // Only consulted when it can matter, so the common browser path pays
        // nothing for the validation.
        let hasCredential = false;
        const needsCredential = opaque || (isJson && (missing || !/^https?:\/\//i.test(origin)));
        if (needsCredential) {
            try {
                hasCredential = await validatedCredential(req);
            } catch (_) {
                hasCredential = false;
            }
        }
        // `Origin: null` is what a sandboxed iframe, a data:/file: document or a
        // cross-site redirect chain sends, never one of our own pages (they
        // carry Referrer-Policy: same-origin). Only a validated machine
        // credential may stand in for it.
        if (opaque) {
            if (hasCredential) return next();
            log(req, 'ORIGIN_GUARD_BLOCKED', `Origin "null" ${req.method} ${req.path} refused`);
            return res.status(403).json({ error: 'origin_required' });
        }
        if (missing) {
            if (isJson && !hasCredential) {
                log(
                    req,
                    'ORIGIN_GUARD_BLOCKED',
                    `Origin-less JSON ${req.method} ${req.path} refused (origin_required)`
                );
                return res.status(403).json({ error: 'origin_required' });
            }
            return next();
        }
        // Only trust X-Forwarded-Host when a reverse proxy is explicitly trusted;
        // otherwise a client could spoof it to match a crafted Origin.
        const tp = typeof trustProxy === 'function' ? trustProxy() : trustProxy;
        const host =
            tp && req.headers['x-forwarded-host']
                ? req.headers['x-forwarded-host']
                : req.headers.host;
        let originHost;
        try {
            originHost = new URL(origin).host;
        } catch (_) {
            if (hasCredential) return next();
            log(
                req,
                'ORIGIN_GUARD_BLOCKED',
                `Malformed Origin on ${req.method} ${req.path} refused`
            );
            return res.status(403).json({ error: 'origin_required' });
        }
        if (originHost !== host) {
            log(
                req,
                'CROSS_ORIGIN_BLOCKED',
                `Cross-origin ${req.method} ${req.path} refused (origin host "${String(originHost).slice(0, 100)}" != "${String(host).slice(0, 100)}")`
            );
            return res.status(403).json({ error: 'cross_origin_blocked' });
        }
        next();
    };
}

// ---------------------------------------------------------------------------
// CSRF skip list.
// ---------------------------------------------------------------------------
/**
 * Multipart upload routes still exempt from the token check: multer parses the
 * body AFTER the check, so `_csrf` is not visible yet. They rely on the origin
 * guard above plus `SameSite=Lax` (audit SA-15, open until the client side
 * sends the token on every multipart request). Prefix-match, never substring,
 * so a future route that merely CONTAINS a fragment cannot inherit it.
 */
const CSRF_EXEMPT_UPLOADS = Object.freeze([
    '/data-management/import/',
    '/data-management/skill-matrix-workbook/import',
    '/data-management/skill-matrix-workbook/preview',
    '/admin/data/',
]);
const CSRF_EXEMPT_UPLOAD_EXACT = Object.freeze(['/compliance/certifications']);

/** Requests the CSRF synchroniser-token check does not apply to. */
function csrfSkip(req) {
    const p = req.path || '';
    if (p.startsWith('/api/')) return true; // key/bearer or session JSON, origin-guarded
    if (p === '/login' && req.method === 'POST') return true;
    if (isSsoCallbackPath(p) && req.method === 'POST') return true;
    if (
        req.method === 'POST' &&
        (CSRF_EXEMPT_UPLOADS.some((x) => p.startsWith(x)) || CSRF_EXEMPT_UPLOAD_EXACT.includes(p))
    )
        return true;
    // JSON bodies cannot be sent cross-site without CORS; the origin guard
    // refuses a JSON mutation that has neither a matching Origin nor a key.
    if (isJsonType(req.headers && req.headers['content-type'])) return true;
    return false;
}

/** What a CSRF failure may log: a short hash of the sid, never the sid. */
function csrfFailureLogFields(req) {
    const sid = req.sessionID ? String(req.sessionID) : '';
    return {
        path: req.path,
        method: req.method,
        sidHash: sid ? crypto.createHash('sha256').update(sid).digest('hex').slice(0, 8) : null,
        hasSession: !!req.session,
    };
}

// ---------------------------------------------------------------------------
// Session cookie name.
// ---------------------------------------------------------------------------
const LEGACY_COOKIE = 'app.sid';
const HOST_COOKIE = '__Host-app.sid';

/**
 * `__Host-app.sid` whenever the cookie is ALWAYS Secure (COOKIE_SECURE on, or
 * this process terminates TLS itself): the prefix makes the browser refuse a
 * cookie without Secure, with a Domain, or with a Path other than '/'. Plain
 * HTTP (and COOKIE_SECURE=auto behind an unknown topology) keeps `app.sid`.
 * An explicit SESSION_COOKIE_NAME always wins.
 */
function sessionCookieName({ env = process.env, cookieSecure, tlsConfigured } = {}) {
    const explicit = String(env.SESSION_COOKIE_NAME || '').trim();
    if (explicit) return explicit;
    return cookieSecure === true || tlsConfigured ? HOST_COOKIE : LEGACY_COOKIE;
}

function _cookieValue(header, name) {
    const parts = String(header || '').split(';');
    for (const part of parts) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
}

/**
 * One-time bridge for the rename: a browser that still holds `app.sid` (set
 * before the upgrade) on an HTTPS request is read as if it held the new name
 * (the signed value is the same), so nobody is logged out. The session's
 * rolling Set-Cookie then writes the new name and the old cookie is expired.
 * Once the browser holds the new cookie the bridge does nothing.
 */
function legacyCookieBridge(newName, oldName = LEGACY_COOKIE) {
    return (req, res, next) => {
        if (!newName || newName === oldName) return next();
        const header = req.headers.cookie;
        if (!header || _cookieValue(header, newName) != null) return next();
        const old = _cookieValue(header, oldName);
        if (old == null || !req.secure) return next();
        req.headers.cookie = `${header}; ${newName}=${old}`;
        res.clearCookie(oldName, { path: '/' });
        next();
    };
}

/**
 * The other readers of the cookie name (AuthController logout, sessionActivity
 * idle sign-out) compute `SESSION_COOKIE_NAME || 'app.sid'`. When the session
 * actually rides in `__Host-app.sid`, their `res.clearCookie('app.sid')` is
 * mapped onto the real cookie, with the attributes a `__Host-` cookie needs to
 * be expired (Secure, Path=/), and the pre-upgrade `app.sid` is expired too.
 */
function sessionCookieAlias(readerName, cookieName) {
    return (req, res, next) => {
        if (!cookieName || readerName === cookieName) return next();
        const orig = res.clearCookie.bind(res);
        res.clearCookie = (name, opts) => {
            if (name !== readerName && name !== cookieName) return orig(name, opts);
            if (readerName !== cookieName) orig(readerName, { path: '/' });
            return orig(cookieName, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                ...(opts || {}),
                ...(String(cookieName).startsWith('__Host-') ? { secure: true, path: '/' } : {}),
            });
        };
        next();
    };
}

/**
 * Logout sends `Clear-Site-Data: "cache"`: a shared workstation must not keep
 * cached HR pages for the next person. Not "storage": that would also wipe the
 * offline self-assessment drafts not yet synced (IndexedDB) and the theme
 * preference, which is lost work.
 */
function logoutHardening() {
    return (req, res, next) => {
        res.setHeader('Clear-Site-Data', '"cache"');
        next();
    };
}

// ---------------------------------------------------------------------------
// Health / readiness probes: status only for everybody; details (service name,
// uptime, timestamps, db state) only for a caller that passes the /metrics gate.
// ---------------------------------------------------------------------------
function healthHandler({ startedAt, detailsAllowed, serviceName }) {
    return (req, res) => {
        if (!detailsAllowed(req)) return res.json({ status: 'ok' });
        res.json({
            status: 'ok',
            service: serviceName || require('../config/product').name,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            ts: new Date().toISOString(),
        });
    };
}
function readyHandler({ db, startedAt, detailsAllowed }) {
    return async (req, res) => {
        const details = detailsAllowed(req);
        try {
            const row = await db.get('SELECT 1 AS ok');
            if (!row || Number(row.ok) !== 1) throw new Error('database probe returned no row');
            if (!details) return res.json({ status: 'ready' });
            res.json({
                status: 'ready',
                db: 'up',
                uptimeSec: Math.round((Date.now() - startedAt) / 1000),
                ts: new Date().toISOString(),
            });
        } catch (e) {
            // Never the raw DB error to a probe; log it server-side.
            console.error('[readyz] db probe failed:', e && e.message);
            if (!details) return res.status(503).json({ status: 'degraded' });
            res.status(503).json({ status: 'degraded', db: 'down', ts: new Date().toISOString() });
        }
    };
}

// ---------------------------------------------------------------------------
// Where a finished request is recorded.
//   'system' -> system_logs (evidentiary, hash-chained, kept): 401/403/5xx only
//   null     -> nothing here. Authenticated mutations are written to
//               perf_events (bounded trail) by middleware/activityTrail;
//               business events are audited by their controllers.
// ---------------------------------------------------------------------------
function requestAuditSink(statusCode) {
    const sc = Number(statusCode);
    if (sc === 401 || sc === 403 || sc >= 500) return 'system';
    return null;
}

module.exports = {
    JSON_TYPES,
    mimeEssence,
    isJsonType,
    isMultipart,
    PERMISSIONS_POLICY,
    securityHeaders,
    isSsoCallbackPath,
    makeValidatedApiCredential,
    originGuard,
    CSRF_EXEMPT_UPLOADS,
    CSRF_EXEMPT_UPLOAD_EXACT,
    csrfSkip,
    csrfFailureLogFields,
    LEGACY_COOKIE,
    HOST_COOKIE,
    sessionCookieName,
    legacyCookieBridge,
    sessionCookieAlias,
    logoutHardening,
    healthHandler,
    readyHandler,
    requestAuditSink,
};
