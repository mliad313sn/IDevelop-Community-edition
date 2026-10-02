const appConfig = require('../config/app');
const crypto = require('crypto');
const ApiKeyService = require('../services/ApiKeyService');
const AdminModel = require('../models/AdminModel');
const sso = require('../config/sso');

// Constant-time string compare to avoid a byte-by-byte timing oracle on the key.
function safeEqual(a, b) {
    const ab = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    if (ab.length === 0 || bb.length === 0 || ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

/**
 * The legacy shared key, or null. Defence in depth for S-02 (3.23.17): even if
 * a config hands us a key equal to APP_KEY (the at-rest encryption key), it is
 * never accepted as a credential. config/app.js already refuses it at load.
 */
function legacySharedKey() {
    const k = appConfig.apiKey ? String(appConfig.apiKey) : '';
    if (!k) return null;
    const appKey = String(process.env.APP_KEY || '').trim();
    if (appKey && k.trim() === appKey) return null;
    return k;
}

/**
 * SEC-2 (3.23.21) — PER-FEED scope allow-lists.
 *
 * `requireApiKey` used to authenticate the key and stop there: whatever its
 * scope said, it opened every surface that used the middleware. A key issued
 * for the safety gate (`safety.read`) read the Power BI HR feeds; a Power BI key
 * read SCIM Users. Each machine surface now names the scopes it accepts, and
 * ANY OTHER scope — including one nobody has thought of yet — is refused.
 *
 *   powerbi  /api/powerbi/*      Power BI report feeds (read)
 *   scim     /scim/*             IdP provisioning (writes still need apiKeyCanWrite)
 *   safety   /v2/safety-gate/*   access-control / permit-to-work systems
 *   v1       /api/v1/*           versioned API (a safety or SCIM key is refused)
 *
 * `legacy.shared` (the env key) and `entra.bearer` (an Entra-token principal,
 * RBAC-scoped as the linked account) keep the reporting surfaces they served
 * before; neither reaches SCIM or the safety gate.
 */
const FEED_SCOPES = Object.freeze({
    powerbi: Object.freeze(['powerbi.read', 'read', 'legacy.shared', 'entra.bearer']),
    scim: Object.freeze(['scim.write', 'scim.read', 'scim']),
    safety: Object.freeze([
        'safety.read',
        'safety_gate.read',
        'safety-gate.read',
        'safetygate.read',
    ]),
    v1: Object.freeze(['read', 'powerbi.read', 'legacy.shared', 'entra.bearer']),
});

/**
 * The scopes a super admin may ISSUE — one list for the admin page and for
 * POST /api/v1/admin/api-keys (the v1 endpoint used to store any string).
 */
const ISSUABLE_API_KEY_SCOPES = Object.freeze([
    'powerbi.read',
    'read',
    'safety.read',
    'scim.write',
]);

/** Scope tokens: a stored scope may list several, space- or comma-separated. */
function scopeTokens(scope) {
    return String(scope == null ? '' : scope)
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean);
}

/** True when `scope` carries at least one token the feed accepts. Unknown feed → false. */
function feedScopeAllowed(feed, scope) {
    const allowed = Object.prototype.hasOwnProperty.call(FEED_SCOPES, feed)
        ? FEED_SCOPES[feed]
        : null;
    if (!allowed) return false;
    return scopeTokens(scope).some((t) => allowed.includes(t));
}

/** The issuable scope asked for, or null when it is not on the list. */
function issuableScope(scope) {
    const s = String(scope == null ? '' : scope)
        .trim()
        .toLowerCase();
    return ISSUABLE_API_KEY_SCOPES.includes(s) ? s : null;
}

/**
 * Which feed a request addresses, from the URL it came in on. An Express
 * request always carries `originalUrl`; a URL-less object only exists in unit
 * tests and is treated as the historical Power BI feed (read-only). A URL that
 * matches no feed → null → refused.
 */
function feedOf(req) {
    const raw = (req && (req.originalUrl || req.url)) || null;
    if (raw == null) return 'powerbi';
    const p = String(raw).split('?')[0].toLowerCase();
    if (p === '/api/powerbi' || p.startsWith('/api/powerbi/')) return 'powerbi';
    if (p === '/scim' || p.startsWith('/scim/')) return 'scim';
    if (p === '/v2/safety-gate' || p.startsWith('/v2/safety-gate/')) return 'safety';
    if (p === '/api/v1' || p.startsWith('/api/v1/')) return 'v1';
    return null;
}

function refuseScope(res, feed) {
    if (feed === 'scim') {
        return res.status(403).json({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '403',
            scimType: 'noPermission',
            detail: 'This API key’s scope does not grant access to SCIM provisioning.',
        });
    }
    return res.status(403).json({
        error: 'insufficient_scope',
        hint: 'this API key’s scope does not grant access to this feed',
    });
}

const SYSTEM_PRINCIPAL = {
    id: 0,
    userType: 'admin',
    role: 'superadmin',
    username: 'api-key',
    isSystemApiKey: true,
};

/**
 * Require a valid API Key. Two credential sources, in order:
 *
 *  1. A per-profile key from the `api_keys` table (preferred). The key is bound
 *     to an OWNER admin; the request then runs AS THAT ADMIN, so the report feeds
 *     (which all filter via RBACService.getFilteredEmployees(req.user)) return
 *     ONLY the data that profile's clearance allows. A key with no owner gets
 *     full-org (system) scope.
 *  2. The legacy shared env key (appConfig.apiKey) → full-org system principal,
 *     for backward compatibility with existing server-to-server feeds.
 *
 * Prefers the 'X-API-Key' header; the 'apiKey' query param is still accepted for
 * legacy Power BI feeds but discouraged (it leaks into access/proxy logs).
 */
const requireApiKey = async (req, res, next) => {
    // SEC-2: the feed this request addresses; a key must carry one of ITS scopes.
    const feed = feedOf(req);
    try {
        // Entra (Azure AD) JWT bearer token — an alternative to an API key for
        // callers that already hold a Microsoft-issued access token (e.g. Power BI
        // with an Entra service principal). Validated by jose (JWKS) and
        // resolved to a local, RBAC-scoped principal. Skipped entirely when Entra
        // bearer auth is not configured. Only JWT-shaped bearers are considered.
        const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (bearer && sso.looksLikeJwt(bearer) && sso.isEntraBearerEnabled()) {
            const principal = await sso.authenticateEntraBearer(req);
            if (principal) {
                const entraScope = principal.apiScope || 'entra.bearer';
                if (!feedScopeAllowed(feed, entraScope)) return refuseScope(res, feed);
                req._apiKey = {
                    id: null,
                    scope: entraScope,
                    label: 'entra',
                };
                req.user = principal;
                return next();
            }
            return res.status(401).json({
                error: 'Entra bearer token was rejected or is not linked to a IDevelop account',
            });
        }

        // An OPAQUE bearer token is an API key too: SCIM clients (Entra
        // provisioning "Secret Token", Okta) send it as `Authorization: Bearer <key>`,
        // never as X-API-Key — every real IdP call was refused 401 here. JWT-shaped
        // bearers stay reserved for the Entra branch above.
        const opaqueBearer = bearer && !sso.looksLikeJwt(bearer) ? bearer : null;
        const apiKey = req.headers['x-api-key'] || opaqueBearer || req.query.apiKey;
        if (!apiKey) {
            return res.status(401).json({
                error: 'Authentication required. Please provide a valid API Key in the X-API-Key header, or an Entra bearer token.',
            });
        }

        // 1) Per-profile key from the api_keys table.
        const principal = await ApiKeyService.validate(apiKey);
        if (principal) {
            // Scope first: a key of another feed never becomes a principal here.
            if (!feedScopeAllowed(feed, principal.scope)) return refuseScope(res, feed);
            req._apiKey = { id: principal.id, scope: principal.scope, label: principal.label };
            if (principal.ownerAdminId != null) {
                // Run as the owning admin → inherit exactly their RBAC clearance.
                const admin = await AdminModel.findWithScopes(principal.ownerAdminId);
                if (!admin) {
                    return res.status(403).json({ error: 'API key owner no longer exists' });
                }
                // De-authorization, mirrored from auth.js deserializeUser and from
                // ApiKeyService.validate's JOIN. Defence in depth: a key must never
                // outlive its owner's account, whichever layer notices first (the
                // account can be disabled between the two queries). `=== false` /
                // `=== 0` only — a missing column must never lock every feed out.
                if (admin.isActive === false || admin.isActive === 0) {
                    return res.status(403).json({ error: 'API key owner account is deactivated' });
                }
                admin.userType = 'admin';
                admin.isSystemApiKey = true;
                req.user = admin;
            } else {
                // Ownerless key = full-org system principal (legacy behaviour).
                req.user = { ...SYSTEM_PRINCIPAL };
            }
            return next();
        }

        // 2) Legacy shared env key → full-org system principal. Only an explicit
        //    API_KEY distinct from APP_KEY (see legacySharedKey).
        const legacy = legacySharedKey();
        if (legacy && safeEqual(apiKey, legacy)) {
            if (!feedScopeAllowed(feed, 'legacy.shared')) return refuseScope(res, feed);
            req._apiKey = { id: null, scope: 'legacy.shared', label: 'env' };
            req.user = { ...SYSTEM_PRINCIPAL };
            return next();
        }

        return res.status(403).json({ error: 'Invalid API Key' });
    } catch (err) {
        return res.status(500).json({ error: 'API key validation failed' });
    }
};

/**
 * The scope string of the calling API key, or null for a real session.
 *
 * TWO SHAPES EXIST and they are not interchangeable: this middleware marks the
 * REQUEST (`req._apiKey = { scope }`) and leaves `req.user` as the resolved
 * admin, while the /api/v1 router marks the USER (`req.user._apiKey = true`,
 * `req.user.apiScope`). A predicate that reads only one of them silently
 * returns "not an API key" for callers authenticated through the other — which
 * is a write gate that permits everything, and looks correct while doing it.
 * Read both, here, once.
 */
function apiKeyScopeOf(reqOrUser) {
    const x = reqOrUser;
    if (!x) return null;
    // (a) a REQUEST marked by this middleware: `req._apiKey = { scope }`.
    if (x._apiKey && typeof x._apiKey === 'object' && x._apiKey.scope != null) {
        return String(x._apiKey.scope);
    }
    // (b) a USER marked by the /api/v1 router: `_apiKey: true`, `apiScope`.
    //     Callers pass the user object directly as well as the request, so
    //     accept it here — failing to RECOGNISE a key is the permissive
    //     direction, and that is exactly the mistake worth designing out.
    if (x._apiKey) return String(x.apiScope || '');
    // (c) a REQUEST whose user carries (b).
    if (x.user && x.user._apiKey) return String(x.user.apiScope || '');
    return null;
}

/**
 * May the caller WRITE?
 *
 * A real session → yes, RBAC decides downstream. An API-KEY principal → only if
 * its scope grants writing. Read scopes ('powerbi.read', the legacy shared key)
 * are reject-on-write, so a read-only integration key can never mutate data.
 */
function apiKeyCanWrite(req) {
    const scope = apiKeyScopeOf(req);
    if (scope === null) return true;
    const s = scope.toLowerCase();
    return /(^|[.:_-])(write|rw|readwrite|admin|full)([.:_-]|$)/.test(s) || s.includes('write');
}

/**
 * Gate for GET /metrics (3.23.17, S-11). The endpoint used to answer anyone.
 * Allowed when EITHER:
 *   - the TCP peer is loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1) AND the
 *     request carries no forwarding header — a reverse proxy on the same box
 *     would otherwise make every internet request look local; or
 *   - METRICS_TOKEN is set and presented as `Authorization: Bearer <token>`
 *     (constant-time compare), for a remote Prometheus.
 * Everything else gets 403. Reads the socket, never req.ip (trust-proxy aware).
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const _normIp = (ip) =>
    String(ip || '')
        .trim()
        .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1')
        .toLowerCase();
function _forwarded(req) {
    const h = (req && req.headers) || {};
    return !!(h['x-forwarded-for'] || h.forwarded || h['x-real-ip']);
}
/** The TCP peer is loopback and no proxy forwarded the request. */
function isLoopbackUnforwarded(req) {
    const peer = (req && req.socket && req.socket.remoteAddress) || '';
    return LOOPBACK.has(peer) && !_forwarded(req);
}
/**
 * METRICS_ALLOW_IPS: comma-separated exact peer addresses (a remote Prometheus
 * on the LAN) allowed without a token. Compared with the socket peer (never
 * X-Forwarded-For) and never when a forwarding header is present: a reverse
 * proxy on an allowed host must not open it to the world.
 */
function metricsAllowListed(req) {
    const list = String(process.env.METRICS_ALLOW_IPS || '')
        .split(/[\s,;]+/)
        .map(_normIp)
        .filter(Boolean);
    if (!list.length || _forwarded(req)) return false;
    const peer = _normIp(req && req.socket && req.socket.remoteAddress);
    return !!peer && list.includes(peer);
}
function metricsAccessAllowed(req) {
    const token = String(process.env.METRICS_TOKEN || '').trim();
    if (token) {
        const auth = String((req.headers && req.headers.authorization) || '');
        const m = /^Bearer\s+(.+)$/i.exec(auth);
        if (m && safeEqual(m[1].trim(), token)) return true;
    }
    return isLoopbackUnforwarded(req) || metricsAllowListed(req);
}
function requireMetricsAccess(req, res, next) {
    if (metricsAccessAllowed(req)) return next();
    return res.status(403).type('text/plain').send('Forbidden\n');
}

module.exports = {
    requireApiKey,
    FEED_SCOPES,
    ISSUABLE_API_KEY_SCOPES,
    feedScopeAllowed,
    issuableScope,
    feedOf,
    apiKeyScopeOf,
    apiKeyCanWrite,
    legacySharedKey,
    metricsAccessAllowed,
    requireMetricsAccess,
    isLoopbackUnforwarded,
};
