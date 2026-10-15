'use strict';

/**
 * Idle-timeout + session activity tracking.
 *
 * For an authenticated request, if the session has been inactive longer than the
 * idle window it is destroyed and the user is bounced to the login page with a
 * "session expired" notice. Otherwise the last-activity stamp is refreshed (with
 * `rolling: true` on the cookie this gives a sliding inactivity window on top of
 * the absolute maxAge cap). Also records lightweight session metadata (IP, device,
 * login time) so the user can review/manage their active sessions.
 *
 * Tunable from App Settings ('sessionIdleMinutes', category security, applies
 * immediately) with the SESSION_IDLE_MINUTES env var / 30 as fallback. getValue
 * is TTL-cached, so the per-request read costs no extra query.
 *
 * SHARED-COMPUTER (kiosk) MODE — OFF unless a SuperAdmin switches
 * kioskModeEnabled on. A session is in shared-device mode when the person
 * ticked « Shared computer » on the login
 * page (password form, or the SSO button: the choice travels in a short-lived
 * intent cookie that survives passport's session regeneration and the IdP
 * round-trip), or ALWAYS when the sign-in comes from an address listed in the
 * SuperAdmin setting `kioskIpRanges`. In that mode:
 *   - the idle window is `kioskIdleMinutes` (default 5, 1-30) — it can only
 *     SHORTEN the normal idle window, never lengthen it; the absolute cap is
 *     unchanged;
 *   - the session cookie is a browser-session cookie (no persistent expiry);
 *   - closing the tab/browser ends the session: public/js/shared-device.js sends
 *     a beacon on `pagehide` carrying a per-session token (the CSRF defence of
 *     that endpoint) and the render time of the page. The server closes the
 *     session only if that page is the LATEST one rendered for the session — a
 *     navigation inside the app renders the next page BEFORE the old one fires
 *     pagehide, so moving around never signs anyone out. Beacons are best-effort:
 *     the short server-side idle window is the backstop;
 *   - an idle expiry also sends Clear-Site-Data "cache" (as /logout does).
 */

const crypto = require('crypto');
const net = require('net');

// Secure defaults (ASVS 3.3.2): 30 min idle, 12 h absolute. The App Settings
// (sessionIdleMinutes / sessionTimeout) win when set; migration 162 moves only
// UNTOUCHED old defaults (60 / 24) on an upgrade.
const ENV_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 30;
// Absolute session lifetime. rolling:true slides the cookie maxAge forward on every
// response, so a continuously-used session would otherwise never expire. This is the
// hard ceiling (matches SESSION_MAX_HOURS used for the cookie maxAge), enforced
// independently of the sliding idle window — a session older than this is destroyed
// even if the user is active. Set SESSION_MAX_HOURS=0 to disable the absolute cap.
const ABSOLUTE_MAX_MS = Number(process.env.SESSION_MAX_HOURS || 12) * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'app.sid';

// ---- shared-device (kiosk) mode -------------------------------------------
const KIOSK_IDLE_DEFAULT = 5;
const KIOSK_IDLE_MIN = 1;
const KIOSK_IDLE_MAX = 30;
/** Short-lived « Shared computer » intent written by the login page (not a secret). */
const KIOSK_INTENT_COOKIE = 'app_kiosk';
const KIOSK_INTENT_MAX_AGE_MS = 15 * 60 * 1000;
const BEACON_PATH = '/logout-beacon';

// Never gate static assets / probes / the auth screens themselves on idle logout.
const SKIP =
    /^\/(login|logout|health|healthz|readyz|metrics|favicon|css|js|img|images|fonts|public|vendor|assets|auth\/sso|robots\.txt)\b/i;

/** `::ffff:10.1.2.3` → `10.1.2.3` (Node reports IPv4 clients that way on a dual stack). */
function normaliseIp(ip) {
    const s = String(ip == null ? '' : ip).trim();
    if (/^::ffff:/i.test(s) && net.isIPv4(s.slice(7))) return s.slice(7);
    return s;
}

/** One entry of kioskIpRanges: `10.20.0.0/16`, `10.20.3.7`, `fd00::/8`. */
function parseRangeToken(tok) {
    const [addr, pfx, extra] = String(tok).split('/');
    if (extra !== undefined) return null;
    const fam = net.isIP(addr);
    if (!fam) return null;
    const max = fam === 4 ? 32 : 128;
    if (pfx !== undefined && !/^\d{1,3}$/.test(pfx)) return null;
    const prefix = pfx === undefined ? max : Number(pfx);
    if (prefix > max) return null;
    return { addr, prefix, type: fam === 4 ? 'ipv4' : 'ipv6' };
}

let _rangeCache = { text: null, parsed: null };
/**
 * Parse the kioskIpRanges setting (comma / space / newline separated CIDRs or
 * single addresses). One BlockList per family: a mixed list would also test an
 * IPv4 address against IPv4-mapped IPv6 entries.
 */
function parseRanges(text) {
    const src = String(text == null ? '' : text);
    if (_rangeCache.text === src) return _rangeCache.parsed;
    const v4 = new net.BlockList();
    const v6 = new net.BlockList();
    const invalid = [];
    let count = 0;
    for (const tok of src.split(/[\s,;]+/).filter(Boolean)) {
        const r = parseRangeToken(tok);
        if (!r) {
            invalid.push(tok);
            continue;
        }
        (r.type === 'ipv4' ? v4 : v6).addSubnet(r.addr, r.prefix, r.type);
        count += 1;
    }
    if (invalid.length)
        console.warn('[sessionActivity] kioskIpRanges: ignored invalid entries:', invalid);
    const parsed = { v4, v6, count, invalid };
    _rangeCache = { text: src, parsed };
    return parsed;
}

/** Is `ip` inside one of the ranges of `text`? */
function ipInRanges(ip, text) {
    const p = parseRanges(text);
    if (!p.count) return false;
    const a = normaliseIp(ip);
    const fam = net.isIP(a);
    if (fam === 4) return p.v4.check(a, 'ipv4');
    if (fam === 6) return p.v6.check(a, 'ipv6');
    return false;
}

async function settingValue(key, fallback) {
    try {
        return await require('../models/AppSettingsModel').getValue(key, fallback);
    } catch {
        return fallback;
    }
}

/**
 * Master switch `kioskModeEnabled` (SuperAdmin, OFF by default). OFF:
 * no « Shared computer » box on the login page, the box / intent cookie and
 * kioskIpRanges are ignored, so no NEW session enters shared-device mode. A
 * session already in that mode keeps it until it ends (fail closed).
 */
async function kioskEnabled() {
    const v = await settingValue('kioskModeEnabled', 'false');
    return v === true || /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}

/** Does this request come from an address a SuperAdmin declared as shared (kiosk)? */
async function isKioskIp(req) {
    if (!(await kioskEnabled())) return false;
    const ranges = await settingValue('kioskIpRanges', '');
    if (!ranges) return false;
    return ipInRanges(req && req.ip, ranges);
}

/** kioskIdleMinutes, clamped to 1-30 (default 5). */
async function kioskIdleMinutes() {
    const v = Number(await settingValue('kioskIdleMinutes', KIOSK_IDLE_DEFAULT));
    if (!Number.isFinite(v) || v <= 0) return KIOSK_IDLE_DEFAULT;
    return Math.min(KIOSK_IDLE_MAX, Math.max(KIOSK_IDLE_MIN, Math.round(v)));
}

function readCookie(req, name) {
    const raw = (req && req.headers && req.headers.cookie) || '';
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
}

/** Did the login page leave a « Shared computer » intent on this browser? */
function hasKioskIntent(req) {
    return readCookie(req, KIOSK_INTENT_COOKIE) === '1';
}

function setKioskIntent(req, res) {
    res.cookie(KIOSK_INTENT_COOKIE, '1', {
        path: '/',
        sameSite: 'lax',
        httpOnly: false, // the login page's checkbox mirrors it; it holds no secret
        secure: Boolean(req && req.secure),
        maxAge: KIOSK_INTENT_MAX_AGE_MS,
    });
}

function clearKioskIntent(res) {
    res.clearCookie(KIOSK_INTENT_COOKIE, { path: '/' });
}

function isShared(req) {
    return Boolean(req && req.session && req.session.sharedDevice);
}

/**
 * When a session on a SHARED computer ends — sign-out,
 * idle lapse, page-close beacon — the language the previous person chose is
 * dropped, so the next worker at the kiosk gets the site's default language
 * (i18n detection: no `lang` cookie → the device's language → French). The
 * cookie is the one GET /lang/:lng sets (path '/').
 */
function resetLanguage(res) {
    res.clearCookie('lang', { path: '/' });
}

/**
 * Put the CURRENT session in shared-device mode. Call it on the FINAL session
 * (inside the req.logIn callback — passport 0.6 regenerates the session inside
 * logIn and copies nothing across). Idempotent; the beacon token is minted once.
 */
function enableSharedDevice(req, source) {
    const s = req && req.session;
    if (!s) return;
    s.kioskDecided = true;
    if (!s.sharedDevice) {
        s.sharedDevice = {
            source: source === 'ip' ? 'ip' : 'checkbox',
            token: crypto.randomBytes(24).toString('base64url'),
            since: Date.now(),
        };
    } else if (source === 'ip') {
        s.sharedDevice.source = 'ip';
    }
    // A browser-session cookie: closing the browser drops it. The absolute cap
    // stays enforced server-side (createdAt).
    if (s.cookie) s.cookie.maxAge = null;
}

/**
 * Decide the mode of a freshly signed-in session (once), then keep an address
 * listed in kioskIpRanges in shared-device mode on every request (fail closed —
 * a session cannot leave shared-device mode, only enter it).
 */
async function decideSharedDevice(req, res) {
    const s = req.session;
    if (!s.kioskDecided) {
        s.kioskDecided = true;
        if (hasKioskIntent(req) && (await kioskEnabled())) {
            enableSharedDevice(req, 'checkbox');
            clearKioskIntent(res);
        }
    }
    if (!isShared(req) && (await isKioskIp(req))) enableSharedDevice(req, 'ip');
}

/** Is this GET a top-level page load (not a fetch, not an iframe)? */
function isDocumentLoad(req, wantsJson) {
    if (req.method !== 'GET') return false;
    const mode = req.get && req.get('sec-fetch-mode');
    const dest = req.get && req.get('sec-fetch-dest');
    if (mode || dest) return mode === 'navigate' && (!dest || dest === 'document');
    return !wantsJson();
}

function sameOriginBeacon(req) {
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin') return false;
    const origin = req.get('origin');
    if (origin) {
        try {
            if (new URL(origin).host !== req.get('host')) return false;
        } catch {
            return false;
        }
    }
    return true;
}

function tokenMatches(presented, expected) {
    const a = Buffer.from(String(presented || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function auditClose(req, details) {
    try {
        const u = req.user;
        require('../services/LogService')
            .log({
                action: 'LOGOUT',
                entityType: 'security',
                details,
                category: 'security',
                requestId: req.id || null,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
                actorRef: u ? `${u.userType}:${u.id}` : null,
            })
            .catch(() => {});
    } catch {
        /* audit is best-effort */
    }
}

/**
 * POST /logout-beacon — shared-device sessions only. Body (urlencoded, as
 * navigator.sendBeacon sends URLSearchParams): `token` (the per-session beacon
 * token, the CSRF defence: it is only ever printed into this session's pages),
 * `action` = close | ping, `renderedAt` (close: the render time of the page
 * being hidden). Always answers without a body.
 *   close — ends the session when the page being closed is the latest page
 *           rendered for it; an older page (a navigation already rendered the
 *           next one, or another tab is newer) is ignored.
 *   ping  — the person is typing on the page without any request (a long
 *           justification): refreshes the idle stamp, unless it already lapsed.
 */
async function handleBeacon(req, res) {
    const s = req.session;
    const sd = s && s.sharedDevice;
    const authed = Boolean(req.isAuthenticated && req.isAuthenticated());
    if (!s || !sd || !authed) return res.status(204).end();
    const body = req.body || {};
    if (!sameOriginBeacon(req) || !tokenMatches(body.token, sd.token)) return res.status(403).end();
    const action = String(body.action || 'close');
    const closeNow = (details) => {
        auditClose(req, details);
        s.destroy(() => {
            res.clearCookie(SESSION_COOKIE_NAME);
            resetLanguage(res);
            res.setHeader('Clear-Site-Data', '"cache"');
            res.status(204).end();
        });
    };
    if (action === 'ping') {
        const idle = await effectiveIdleMs(true);
        if (s.lastActivity && Date.now() - s.lastActivity > idle)
            return closeNow('shared device: idle window lapsed before the keep-alive');
        s.lastActivity = Date.now();
        return res.status(204).end();
    }
    const renderedAt = Number(body.renderedAt);
    if (!Number.isFinite(renderedAt) || renderedAt < Number(s.kioskLastRender || 0))
        return res.status(204).end();
    const u = req.user || {};
    return closeNow(
        // The audit line names the account by type:id, never by username.
        `shared device: ${u.userType || 'user'}:${u.id != null ? u.id : '?'} signed out — page closed`
    );
}

/** The idle window in ms; shared-device mode can only SHORTEN it. */
async function effectiveIdleMs(shared) {
    let idleMinutes = ENV_IDLE_MINUTES;
    const v = Number(await settingValue('sessionIdleMinutes', ENV_IDLE_MINUTES));
    if (Number.isFinite(v) && v > 0) idleMinutes = v;
    if (shared) idleMinutes = Math.min(idleMinutes, await kioskIdleMinutes());
    return idleMinutes * 60 * 1000;
}

async function sessionActivity(req, res, next) {
    if (req.method === 'POST' && req.path === BEACON_PATH) return handleBeacon(req, res);
    if (!req.session || !req.isAuthenticated || !req.isAuthenticated()) return next();
    if (SKIP.test(req.path || '')) return next();

    // UN SEUL `wantsJson`, celui de middleware/auth.js. Celui qui vivait ICI ne
    // regardait que `req.xhr` et `Accept` — or les assistants fetch des pages
    // n'envoient QUE `Content-Type: application/json`. Mesure du 16/09/2026,
    // session uat.admin reculée de 2 h : l'appel arrivait donc ici en « pas du
    // JSON », repartait en `302 → /login?expired=1`, le navigateur suivait la
    // redirection, la page de connexion revenait en `200 text/html`, `r.ok`
    // valait true — et l'écran annonçait « Plan de coaching créé » sur une base
    // où RIEN n'avait été écrit. La branche 440 juste en dessous existait déjà et
    // n'était simplement jamais atteinte. Require paresseux : même style que le
    // require d'AppSettingsModel ci-dessus, et aucun cycle au chargement.
    const wantsJson = () => require('./auth').wantsJson(req);

    // Shared-device (kiosk) decision — before the idle check, so a kiosk address
    // gets the short window from its very first request.
    try {
        await decideSharedDevice(req, res);
    } catch {
        /* settings unavailable → the session keeps its current mode */
    }
    const shared = isShared(req);

    // The absolute cap is the `sessionTimeout` App Setting (hours)
    // the row was shown as live but nothing read it. Cached read (60 s
    // TTL), env SESSION_MAX_HOURS as fallback; the cookie's own maxAge follows
    // it so the browser drops the cookie at the same moment the server would.
    let absoluteMaxMs = ABSOLUTE_MAX_MS;
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        const h = Number(await AppSettingsModel.getValue('sessionTimeout', null));
        if (Number.isFinite(h) && h > 0) absoluteMaxMs = h * 60 * 60 * 1000;
    } catch {
        /* settings unavailable → env/default */
    }
    const IDLE_MS = await effectiveIdleMs(shared);
    if (shared) {
        // Browser-session cookie in shared-device mode (dropped with the browser).
        if (req.session.cookie && req.session.cookie.maxAge != null)
            req.session.cookie.maxAge = null;
    } else if (
        absoluteMaxMs > 0 &&
        req.session.cookie &&
        req.session.cookie.maxAge !== absoluteMaxMs
    )
        req.session.cookie.maxAge = absoluteMaxMs;

    const now = Date.now();
    const last = req.session.lastActivity;
    // Session creation time for the absolute cap. Stamp it once on the first
    // authenticated request (falls back to an existing meta.loginAt so sessions
    // predating this field still get a ceiling).
    if (!req.session.createdAt)
        req.session.createdAt = (req.session.meta && req.session.meta.loginAt) || now;

    const endSession = (reason) =>
        req.session.destroy(() => {
            res.clearCookie(SESSION_COOKIE_NAME);
            // A shared computer must not keep the pages of the person who left.
            if (shared) {
                res.setHeader('Clear-Site-Data', '"cache"');
                resetLanguage(res); // the next person gets the default language
            }
            if (wantsJson()) return res.status(440).json({ error: reason, expired: true });
            return res.redirect('/login?expired=1');
        });

    // Absolute lifetime cap — independent of activity. An active session that has
    // lived longer than the ceiling is force-expired (re-auth required).
    if (absoluteMaxMs > 0 && req.session.createdAt && now - req.session.createdAt > absoluteMaxMs) {
        return endSession('Session expired (maximum lifetime reached)');
    }

    if (last && now - last > IDLE_MS) {
        // Inactive too long → end the session.
        return endSession('Session expired due to inactivity');
    }

    req.session.lastActivity = now;
    // Capture stable metadata once, so /account/sessions can show device/IP/login time.
    if (!req.session.meta) {
        req.session.meta = {
            ip: req.ip,
            ua: (req.get('user-agent') || '').slice(0, 300),
            loginAt: now,
        };
    }
    if (shared) {
        // The render stamp a closing page must still hold for its beacon to count.
        if (isDocumentLoad(req, wantsJson)) req.session.kioskLastRender = now;
        const u = req.user || {};
        res.locals.sharedDevice = {
            source: req.session.sharedDevice.source,
            beaconToken: req.session.sharedDevice.token,
            renderAt: req.session.kioskLastRender || now,
            idleMinutes: Math.round(IDLE_MS / 60000),
            // Whose offline self-assessment drafts to look for before a logout
            // (public/js/draft-store.js keys them by employee id).
            draftOwner: u.userType === 'admin' ? '' : String(u.id || ''),
        };
    }
    next();
}

module.exports = sessionActivity;
module.exports.KIOSK_INTENT_COOKIE = KIOSK_INTENT_COOKIE;
module.exports.BEACON_PATH = BEACON_PATH;
module.exports.parseRangeToken = parseRangeToken;
module.exports.ipInRanges = ipInRanges;
module.exports.kioskEnabled = kioskEnabled;
module.exports.isKioskIp = isKioskIp;
module.exports.kioskIdleMinutes = kioskIdleMinutes;
module.exports.hasKioskIntent = hasKioskIntent;
module.exports.setKioskIntent = setKioskIntent;
module.exports.clearKioskIntent = clearKioskIntent;
module.exports.enableSharedDevice = enableSharedDevice;
module.exports.isShared = isShared;
module.exports.resetLanguage = resetLanguage;
module.exports.handleBeacon = handleBeacon;
