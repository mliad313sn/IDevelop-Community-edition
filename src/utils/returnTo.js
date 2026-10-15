'use strict';

/**
 * The page an auth guard bounced to /login, used ONCE after sign-in (password,
 * MFA, SSO). Kept free of passport/express so the SSO controller can read it
 * without loading them.
 *
 * It is NOT kept in the session: remembering it there would create a session
 * row for every anonymous navigation to a protected URL (a crawler or a bot
 * hitting fifteen deep links = fifteen rows). It rides a short-lived cookie:
 *   app_return_to = base64url(path) "." at "." HMAC-SHA256(path, at)
 *   HttpOnly, SameSite=Lax, Path=/, Max-Age 15 min, Secure on HTTPS.
 * The HMAC key is derived from SESSION_SECRET (first key), so a value the
 * browser did not receive from us is ignored; the path is re-validated by
 * safeReturnPath on every read, signed or not. The cookie rides same-site
 * navigations and OIDC GET callbacks, not a cross-site SAML POST.
 *
 * The remembered path is ALWAYS relative and same-origin: one leading « / »
 * (never « // » or « /\ »), no control character or backslash, no scheme,
 * 512 characters at most, never /login, /logout, /auth, /api or a static file.
 * It expires after 15 minutes (a shared computer does not take the next person
 * to someone else's page) and is consumed once.
 */
const crypto = require('crypto');

const RETURN_TO_MAX = 512;
const RETURN_TO_TTL_MS = 15 * 60 * 1000;
const RETURN_TO_COOKIE = 'app_return_to';
const RETURN_TO_REFUSED =
    /^\/(?:login|logout|logout-beacon|auth|api|scim|lti|integrations|css|js|icons|vendor|uploads|static|public|fonts|images|img|favicon|service-worker|manifest|offline|robots|forgot-password|reset-password|signup|health|healthz|readyz|metrics)(?:[/?#.]|$)/i;

/** A same-origin relative path safe to redirect to after sign-in, else null. */
function safeReturnPath(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw;
    if (!s || s.length > RETURN_TO_MAX) return null;
    if (s[0] !== '/' || s.startsWith('//') || s.startsWith('/\\')) return null;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f || c === 0x5c) return null;
    }
    // No scheme anywhere in the PATH part (« /javascript:… », « /https://… »).
    const pathPart = s.split(/[?#]/)[0];
    if (pathPart.includes(':')) return null;
    if (RETURN_TO_REFUSED.test(s)) return null;
    return s;
}

let _key = null;
function signingKey() {
    if (_key) return _key;
    let base = null;
    try {
        base = String(require('../config/app').sessionSecret || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)[0];
    } catch (_) {
        base = null;
    }
    // No configured secret (unit context): a per-process random key — a cookie
    // then never outlives the process, which only costs the deep link.
    _key = crypto
        .createHash('sha256')
        .update('app_return_to|' + (base || crypto.randomBytes(32).toString('hex')))
        .digest();
    return _key;
}

function mac(payload) {
    return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/** The cookie value for (path, at). Exposed for tests. */
function encodeReturnTo(path, at) {
    const payload = Buffer.from(String(path), 'utf8').toString('base64url') + '.' + Number(at);
    return payload + '.' + mac(payload);
}

/** { path, at } from a cookie value whose signature matches, else null. */
function decodeReturnTo(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[0] + '.' + parts[1];
    const want = Buffer.from(mac(payload));
    const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const at = Number(parts[1]);
    if (!Number.isFinite(at)) return null;
    let path;
    try {
        path = Buffer.from(parts[0], 'base64url').toString('utf8');
    } catch (_) {
        return null;
    }
    return { path, at };
}

function readCookie(req) {
    const header = req && req.headers && req.headers.cookie;
    if (!header) return null;
    for (const part of String(header).split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() !== RETURN_TO_COOKIE) continue;
        try {
            return decodeURIComponent(part.slice(i + 1).trim());
        } catch (_) {
            return null;
        }
    }
    return null;
}

function cookieOptions(req) {
    return {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: Boolean(req && req.secure),
    };
}

/**
 * Remember `path` for this browser (cookie on `res`). Returns false when the
 * path is not one we would ever follow. Never touches the session.
 */
function setReturnTo(req, res, path) {
    const p = safeReturnPath(path);
    if (!p || !res || typeof res.cookie !== 'function') return false;
    res.cookie(RETURN_TO_COOKIE, encodeReturnTo(p, Date.now()), {
        ...cookieOptions(req),
        maxAge: RETURN_TO_TTL_MS,
    });
    return true;
}

/** The remembered path (signed, still fresh and safe), without consuming it. */
function peekReturnTo(req) {
    const r = decodeReturnTo(readCookie(req));
    if (!r) return null;
    if (!(Date.now() - r.at <= RETURN_TO_TTL_MS)) return null;
    return safeReturnPath(r.path);
}

/** Read AND forget the remembered path (one use). */
function takeReturnTo(req) {
    const p = peekReturnTo(req);
    const res = req && req.res;
    if (readCookie(req) !== null && res && typeof res.clearCookie === 'function') {
        try {
            res.clearCookie(RETURN_TO_COOKIE, cookieOptions(req));
        } catch (_) {
            /* headers already sent: the 15-minute expiry is the backstop */
        }
    }
    // Forget the cookie for the rest of THIS request too (one use).
    if (req && req.headers && req.headers.cookie)
        req.headers.cookie = String(req.headers.cookie)
            .split(';')
            .filter((c) => c.split('=')[0].trim() !== RETURN_TO_COOKIE)
            .join(';');
    return p;
}

/**
 * The redirect target after sign-in: the remembered path when it is a
 * single-slash relative path, else `fallback` (a fixed path of ours).
 */
function returnTarget(path, fallback) {
    const p = safeReturnPath(path);
    if (p && p.startsWith('/') && !p.startsWith('//')) return p;
    return fallback;
}

module.exports = {
    RETURN_TO_MAX,
    RETURN_TO_TTL_MS,
    RETURN_TO_COOKIE,
    RETURN_TO_REFUSED,
    safeReturnPath,
    setReturnTo,
    peekReturnTo,
    takeReturnTo,
    returnTarget,
    encodeReturnTo,
    decodeReturnTo,
};
