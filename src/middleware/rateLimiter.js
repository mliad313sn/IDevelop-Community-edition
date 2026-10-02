/**
 * Rate Limiting Middleware
 * Protects against brute force attacks and API abuse
 */

const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const LoginAttemptModel = require('../models/LoginAttemptModel');
const LogService = require('../services/LogService');
const db = require('../config/database');

// ---------------------------------------------------------------------------
// Multi-instance rate-limit store. express-rate-limit's default MemoryStore is
// per-process, so behind >1 instance each gets its own counters. When REDIS_URL
// is set we back the counters with Redis (shared) using the ioredis client that
// is already a dependency — no extra package, no install-time change. Without
// Redis, makeStore returns undefined and the limiter falls back to memory
// (unchanged single-instance behaviour). The DB-backed account lockout
// (login_attempts) is already cluster-safe regardless.
// ---------------------------------------------------------------------------
let _redis = null;
(function initRedis() {
    if (!process.env.REDIS_URL) return;
    try {
        const IORedis = require('ioredis');
        _redis = new IORedis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
            lazyConnect: false,
        });
        // REDIS_URL was configured on purpose (a multi-instance deployment), so a
        // connection failure is a SECURITY-RELEVANT event, not a benign warning:
        // per-process in-memory counters would let an attacker exceed the global
        // limit by a factor of N behind the load balancer. Surface it loudly.
        _redis.on('error', (e) =>
            console.error(
                '[rate-limit] REDIS ERROR — rate limits are degrading to per-process counters, which UNDER-PROTECTS a multi-instance deployment. Fix Redis or unset REDIS_URL:',
                e && e.message
            )
        );
        console.log('[rate-limit] Redis-backed counters enabled (multi-instance)');
    } catch (e) {
        console.error(
            '[rate-limit] REDIS_URL is set but ioredis could not initialise — falling back to per-process counters (UNSAFE across instances):',
            e && e.message
        );
    }
})();

class RedisRateStore {
    constructor(prefix) {
        this.prefix = 'rl:' + prefix + ':';
        this.windowMs = 60000;
    }
    init(opts) {
        if (opts && opts.windowMs) this.windowMs = opts.windowMs;
    }
    _k(key) {
        return this.prefix + key;
    }
    async increment(key) {
        const k = this._k(key);
        const hits = await _redis.incr(k);
        if (hits === 1) await _redis.pexpire(k, this.windowMs);
        let pttl = await _redis.pttl(k);
        if (pttl < 0) {
            await _redis.pexpire(k, this.windowMs);
            pttl = this.windowMs;
        }
        return { totalHits: hits, resetTime: new Date(Date.now() + pttl) };
    }
    async decrement(key) {
        try {
            await _redis.decr(this._k(key));
        } catch (_) {
            /* best effort */
        }
    }
    async resetKey(key) {
        try {
            await _redis.del(this._k(key));
        } catch (_) {
            /* best effort */
        }
    }
}
function makeStore(name) {
    return _redis ? new RedisRateStore(name) : undefined;
}

// Resolve a submitted login identifier (username OR email, any case) to ONE
// canonical bucket so failed-attempt lockout can't be bypassed by alternating
// between a username and its email (or case variants).
async function canonicalLoginKey(identifier) {
    const id = String(identifier || '')
        .trim()
        .toLowerCase();
    if (!id) return id;
    try {
        const a = await db.get(
            'SELECT username FROM admins WHERE lower(username) = ? OR lower(email) = ? LIMIT 1',
            [id, id]
        );
        if (a && a.username) return String(a.username).toLowerCase();
        const e = await db.get(
            'SELECT username FROM employees WHERE lower(username) = ? OR lower(email) = ? LIMIT 1',
            [id, id]
        );
        if (e && e.username) return String(e.username).toLowerCase();
    } catch (_) {
        /* fall back to the normalized identifier */
    }
    return id;
}

// Best-effort security audit (never throws / never blocks the request).
function secAudit(req, action, details) {
    try {
        LogService.log({
            adminId: null,
            action,
            entityType: 'auth',
            details,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
    } catch (_) {
        /* logging must not break auth */
    }
}

/** Localised flash with an English fallback (the login page may have no i18n on a bare API caller). */
function say(req, key, params, fallback) {
    return req && typeof req.t === 'function' ? req.t(key, params) : fallback;
}

// Environment variables with defaults
const LOGIN_RATE_LIMIT = parseInt(process.env.LOGIN_RATE_LIMIT) || 5;
const LOGIN_RATE_WINDOW = parseInt(process.env.LOGIN_RATE_WINDOW) || 15; // minutes
const LOGIN_LOCKOUT_DURATION = parseInt(process.env.LOGIN_LOCKOUT_DURATION) || 30; // minutes
const API_RATE_LIMIT = parseInt(process.env.API_RATE_LIMIT) || 2000;
const API_RATE_WINDOW = parseInt(process.env.API_RATE_WINDOW) || 15; // minutes

/**
 * The account-lockout policy: threshold and duration are App Settings
 * (`maxLoginAttempts`, `loginLockoutMinutes` — rows seeded by migration 110,
 * edited on the settings screen, no restart) with the env variables as the
 * fallback for an install that never touched the screen. Read through the
 * model's TTL cache, so this costs nothing on the login hot path. Anything
 * unreadable, zero or negative falls back — a lockout can never be switched
 * off by a typo.
 * @returns {Promise<{maxAttempts:number, lockoutMinutes:number}>}
 */
async function lockoutPolicy() {
    const pick = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
    };
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        const [attempts, minutes] = await Promise.all([
            AppSettingsModel.getValue('maxLoginAttempts', LOGIN_RATE_LIMIT),
            AppSettingsModel.getValue('loginLockoutMinutes', LOGIN_LOCKOUT_DURATION),
        ]);
        return {
            maxAttempts: pick(attempts, LOGIN_RATE_LIMIT),
            lockoutMinutes: pick(minutes, LOGIN_LOCKOUT_DURATION),
        };
    } catch (_) {
        return { maxAttempts: LOGIN_RATE_LIMIT, lockoutMinutes: LOGIN_LOCKOUT_DURATION };
    }
}

/**
 * Is this account locked right now, and until when? The lock is count-based
 * over a sliding window, so it lifts the instant the Nth most recent failure
 * ages out of the window — that timestamp + the window IS the release time,
 * which is what the helpdesk needs to say ("verrouillé jusqu'à 14:35").
 * Rows are stored under the canonical lowercased username.
 * @returns {Promise<{locked:boolean, attempts:number, until:Date|null, policy:Object}>}
 */
async function lockStateFor(username, policy = null) {
    const p = policy || (await lockoutPolicy());
    const key = String(username || '')
        .trim()
        .toLowerCase();
    if (!key) return { locked: false, attempts: 0, until: null, policy: p };
    const attempts =
        Number(await LoginAttemptModel.getFailedAttemptsCount(key, p.lockoutMinutes)) || 0;
    if (attempts < p.maxAttempts) return { locked: false, attempts, until: null, policy: p };
    let until = null;
    try {
        const nth = await db.get(
            `SELECT attempted_at FROM login_attempts
              WHERE username = ? AND successful = false
                AND attempted_at > now() - (? * interval '1 minute')
              ORDER BY attempted_at DESC
              OFFSET ? LIMIT 1`,
            [key, p.lockoutMinutes, p.maxAttempts - 1]
        );
        if (nth && nth.attemptedAt)
            until = new Date(new Date(nth.attemptedAt).getTime() + p.lockoutMinutes * 60000);
    } catch (_) {
        until = null;
    }
    return { locked: true, attempts, until, policy: p };
}

/** "dd/MM/yyyy HH:mm" in the request language for a lock release time. */
function releaseLabel(req, until) {
    if (!until) return '';
    try {
        const { fmtDateTime } = require('../utils/dateFormat');
        return fmtDateTime(until, (req && req.language) || 'fr');
    } catch (_) {
        return until.toISOString();
    }
}

/**
 * Rate limiter for login attempts
 * Limits based on IP address
 */
const loginRateLimiter = rateLimit({
    windowMs: LOGIN_RATE_WINDOW * 60 * 1000,
    max: LOGIN_RATE_LIMIT,
    store: makeStore('login'),
    message: `Too many login attempts. Please try again in ${LOGIN_RATE_WINDOW} minutes.`,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true, // Don't count successful logins
    // ...but "successful" cannot be judged by the HTTP status here. A failed login
    // answers `res.redirect('/login')` — a 302 — and the library's default
    // predicate is `statusCode < 400`, so every failure was classified a success
    // and decremented straight back out of the window. The limiter therefore never
    // accumulated anything on /login, /login/mfa, /forgot-password or
    // /reset-password. Reproduced before the fix: 12 consecutive bad passwords from
    // one IP, never blocked. On /login/mfa this was the only network-level cap on
    // guessing a 6-digit TOTP code.
    //
    // Success means an authenticated session actually exists. /forgot-password and
    // /reset-password never establish one, so every attempt there counts — which is
    // the intent: it stops a third party having unlimited reset mail sent to a victim.
    requestWasSuccessful: (req, res) =>
        res.statusCode < 400 &&
        !!(req.session && req.session.passport && req.session.passport.user),
    handler: (req, res) => {
        secAudit(
            req,
            'LOGIN_RATE_LIMITED',
            `IP exceeded ${LOGIN_RATE_LIMIT} login attempts in ${LOGIN_RATE_WINDOW}m (username "${String((req.body && req.body.username) || '').slice(0, 64)}")`
        );
        // 3.23.19: a password sign-in refused while SSO is enforced reads the same whatever the cause.
        if (req.path === '/login' && ssoEnforced()) return enforcedRefusal(req, res);
        req.flash(
            'error',
            say(
                req,
                'flash:adm_too_many_attempts',
                { minutes: LOGIN_RATE_WINDOW },
                `Too many login attempts. Please try again in ${LOGIN_RATE_WINDOW} minutes.`
            )
        );
        res.redirect('/login');
    },
});

/**
 * Stricter limiter for self-service signup — counts ALL attempts (no
 * skipSuccessfulRequests), since each success creates a pending request that an
 * admin must triage. Defends the open-signup surface against flooding.
 */
const SIGNUP_RATE_LIMIT = parseInt(process.env.SIGNUP_RATE_LIMIT) || 5;
const SIGNUP_RATE_WINDOW = parseInt(process.env.SIGNUP_RATE_WINDOW) || 60; // minutes
const signupRateLimiter = rateLimit({
    windowMs: SIGNUP_RATE_WINDOW * 60 * 1000,
    max: SIGNUP_RATE_LIMIT,
    store: makeStore('signup'),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        secAudit(
            req,
            'SIGNUP_RATE_LIMITED',
            `IP exceeded ${SIGNUP_RATE_LIMIT} signup attempts in ${SIGNUP_RATE_WINDOW}m`
        );
        req.flash(
            'error',
            say(
                req,
                'flash:adm_too_many_signups',
                { minutes: SIGNUP_RATE_WINDOW },
                `Too many sign-up attempts. Please try again in ${SIGNUP_RATE_WINDOW} minutes.`
            )
        );
        res.redirect('/signup');
    },
});

/**
 * Rate limiter for API endpoints.
 *
 * The per-key bucket used to be keyed on the RAW, unvalidated credential: every
 * random junk key got a fresh bucket of its own, so a caller rotating keys was
 * never limited at all. Now:
 *   1. the per-IP bucket ALWAYS applies (API_IP_RATE_LIMIT, default
 *      API_RATE_LIMIT); requests carrying an invalid key count against it;
 *   2. a SECOND, per-key bucket applies only once the key VALIDATES (an
 *      api_keys row, or the legacy shared env key). A JWT bearer is validated
 *      by the route itself and stays on the IP bucket here.
 * An integration key therefore still gets its own quota (one Power BI feed
 * cannot exhaust another's), but only a real key earns one.
 */
const API_IP_RATE_LIMIT = parseInt(process.env.API_IP_RATE_LIMIT) || API_RATE_LIMIT;
const _apiLimitMessage = {
    error: 'Too many requests. Please try again later.',
    retryAfter: API_RATE_WINDOW,
};
const _apiIpLimiter = rateLimit({
    windowMs: API_RATE_WINDOW * 60 * 1000,
    max: API_IP_RATE_LIMIT,
    store: makeStore('api'),
    message: _apiLimitMessage,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => 'ip:' + req.ip,
});
const _apiKeyLimiter = rateLimit({
    windowMs: API_RATE_WINDOW * 60 * 1000,
    max: API_RATE_LIMIT,
    store: makeStore('api-key'),
    message: _apiLimitMessage,
    standardHeaders: false, // the IP bucket's headers stay the ones the client reads
    legacyHeaders: false,
    keyGenerator: (req) => 'apikey:' + req._rateKeyId,
});

// A validated key is remembered briefly (hash -> key id) so the limiter does not
// add a second DB round-trip to every API call. Only POSITIVE results are kept:
// an invalid key never earns a bucket.
const _validKeyCache = new Map();
const VALID_KEY_TTL_MS = 30000;
async function validatedKeyId(raw) {
    const h = crypto.createHash('sha256').update(String(raw)).digest('hex');
    const hit = _validKeyCache.get(h);
    if (hit && Date.now() - hit.at < VALID_KEY_TTL_MS) return hit.id;
    let id = null;
    try {
        const p = await require('../services/ApiKeyService').validate(String(raw));
        if (p && p.id != null) id = String(p.id);
    } catch (_) {
        id = null;
    }
    if (id == null) {
        try {
            const legacy = require('./apiAuth').legacySharedKey();
            const a = Buffer.from(String(raw));
            const b = Buffer.from(String(legacy || ''));
            if (legacy && a.length === b.length && crypto.timingSafeEqual(a, b)) id = 'env';
        } catch (_) {
            id = null;
        }
    }
    if (id != null) {
        if (_validKeyCache.size > 5000) _validKeyCache.clear();
        _validKeyCache.set(h, { id, at: Date.now() });
    }
    return id;
}

function apiRateLimiter(req, res, next) {
    _apiIpLimiter(req, res, (err) => {
        if (err) return next(err);
        const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const looksJwt = /^[\w-]+\.[\w-]+\.[\w-]*$/.test(bearer);
        const raw =
            req.headers['x-api-key'] ||
            (bearer && !looksJwt ? bearer : '') ||
            (req.query && req.query.apiKey);
        if (!raw) return next();
        validatedKeyId(raw)
            .then((id) => {
                if (id == null) return next(); // invalid: the IP bucket alone
                req._rateKeyId = id;
                return _apiKeyLimiter(req, res, next);
            })
            .catch(() => next());
    });
}

// Per-user write limiter for cheap-to-spam authenticated endpoints (survey
// responses, recognition, feedback) — keyed by the signed-in user so one
// account can't flood aggregate stats. Generous ceiling; only stops abuse.
const writeActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.WRITE_ACTION_LIMIT) || 30,
    store: makeStore('writeaction'),
    message: { error: 'Too many submissions. Please slow down and try again shortly.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
        req.user && req.user.id != null ? `${req.user.userType || 'u'}:${req.user.id}` : req.ip,
});

/**
 * 3.23.18 — POST /account (« Mon profil ») re-authentication limiter.
 *
 * Changing one's own e-mail requires the current password (it is the address the
 * self-service reset writes to), so POST /account is a password oracle for
 * whoever holds a session: nothing capped the guesses. This limiter has its OWN
 * key namespace (store prefix 'account-reauth', keys 'acct:<type>:<id>') — it
 * never shares a counter with the login limiter — and is keyed per signed-in
 * user, so rotating IPs does not help and colleagues behind one NAT are not
 * penalised for each other.
 *
 * Only REFUSED posts consume the budget. Both outcomes answer a 302 to /account,
 * so "refused" is read from what the controller left behind: an error flash
 * queued DURING this request (counted before/after, so an unread flash from an
 * earlier page does not count). A normal profile save costs nothing.
 */
const ACCOUNT_REAUTH_LIMIT = parseInt(process.env.ACCOUNT_REAUTH_LIMIT) || 10;
const ACCOUNT_REAUTH_WINDOW = parseInt(process.env.ACCOUNT_REAUTH_WINDOW) || 15; // minutes
function _flashErrorCount(req) {
    const f = req && req.session && req.session.flash;
    return f && Array.isArray(f.error) ? f.error.length : 0;
}
const _accountReauthLimiter = rateLimit({
    windowMs: ACCOUNT_REAUTH_WINDOW * 60 * 1000,
    max: ACCOUNT_REAUTH_LIMIT,
    store: makeStore('account-reauth'),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
        req.user && req.user.id != null
            ? `acct:${req.user.userType || 'u'}:${req.user.id}`
            : `acct-ip:${req.ip}`,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) =>
        res.statusCode < 400 && _flashErrorCount(req) <= (req._acctFlashErrorsBefore || 0),
    handler: (req, res) => {
        const who = req.user ? `${req.user.userType || 'u'}:${req.user.id}` : 'anonymous';
        secAudit(
            req,
            'ACCOUNT_REAUTH_RATE_LIMITED',
            `${who} exceeded ${ACCOUNT_REAUTH_LIMIT} refused profile updates (re-authentication) in ${ACCOUNT_REAUTH_WINDOW}m`
        );
        const msg =
            req && typeof req.t === 'function'
                ? req.t('flash:account_reauth_rate_limited', {
                      minutes: ACCOUNT_REAUTH_WINDOW,
                      defaultValue: `Trop de tentatives refusées. Réessayez dans ${ACCOUNT_REAUTH_WINDOW} minutes.`,
                  })
                : `Too many refused attempts. Please try again in ${ACCOUNT_REAUTH_WINDOW} minutes.`;
        if (typeof req.flash === 'function') req.flash('error', msg);
        res.redirect('/account');
    },
});
function accountReauthLimiter(req, res, next) {
    req._acctFlashErrorsBefore = _flashErrorCount(req);
    return _accountReauthLimiter(req, res, next);
}

/**
 * Middleware to check if account is locked due to failed attempts
 */
function ssoEnforced() {
    try {
        return require('../services/AdminSsoService').isEnforced();
    } catch (_) {
        return false;
    }
}

// The single refusal of amendment A1 (same text as AuthController's).
function enforcedRefusal(req, res) {
    req.flash(
        'error',
        say(
            req,
            'flash:auth_password_sso_enforced',
            {},
            'Connexion par mot de passe non autorisée ou identifiants invalides. Utilisez la connexion SSO.'
        )
    );
    return res.redirect('/login?breakglass=1');
}

const checkAccountLockout = async (req, res, next) => {
    if (req.method !== 'POST' || !req.body.username) {
        return next();
    }

    const username = await canonicalLoginKey(req.body.username);
    const ipAddress = req.ip;

    try {
        // Threshold and window come from App Settings (env fallback) — .
        const policy = await lockoutPolicy();
        const enforced = ssoEnforced();

        if (enforced) {
            // 3.23.19 (S2 + residual-leak fix): while SSO is enforced there is no
            // global account lock that someone elsewhere could trigger. Instead a
            // PROGRESSIVE DELAY (none for 2 failures, then 1 s, 2 s, 4 s … 30 s)
            // from the throttle counter keyed on (normalized identifier, IP) that
            // EVERY failed password attempt feeds — so the delay is the same for a
            // non-existent name as for the SuperAdmin's, and reveals nothing.
            const n = enforcedFailureCount(req.body.username, ipAddress, policy.lockoutMinutes);
            // and the across-addresses slowdown on the same name (≥ 5 s from
            // the 10th failure, 60 s max) — whichever is longer.
            const nAll = enforcedIdFailureCount(req.body.username, policy.lockoutMinutes);
            const ms = Math.max(progressiveDelayMs(n), accountSlowdownMs(nAll));
            if (ms > 0) {
                secAudit(
                    req,
                    'LOGIN_DELAYED',
                    `Password sign-in for "${String(username).slice(0, 64)}" from this address delayed ${ms} ms after ${n} failures (SSO enforced)`
                );
                await new Promise((r) => setTimeout(r, ms));
            }
        } else {
            // Check failed attempts by username (canonicalized)
            const state = await lockStateFor(username, policy);
            if (state.locked) {
                secAudit(
                    req,
                    'ACCOUNT_LOCKED',
                    `Account "${String(username).slice(0, 64)}" locked after ${state.attempts} failed attempts (${policy.lockoutMinutes}m)`
                );
                const time = releaseLabel(req, state.until);
                req.flash(
                    'error',
                    time
                        ? say(
                              req,
                              'flash:adm_account_locked_until',
                              { time, minutes: policy.lockoutMinutes },
                              `Account temporarily locked due to too many failed login attempts. Please try again after ${time}.`
                          )
                        : say(
                              req,
                              'flash:adm_account_locked',
                              { minutes: policy.lockoutMinutes },
                              `Account temporarily locked due to too many failed login attempts. Please try again in ${policy.lockoutMinutes} minutes.`
                          )
                );
                return res.redirect('/login');
            }
        }

        // Check failed attempts by IP
        // While SSO is enforced the IP block counts EVERY failed password attempt
        // from this address (any identifier, existing or not) from the throttle's
        // IP counter — identical whatever names are sprayed. Otherwise: as before.
        const ipAttempts = enforced
            ? enforcedIpFailureCount(ipAddress, policy.lockoutMinutes)
            : await LoginAttemptModel.getFailedAttemptsByIP(ipAddress, policy.lockoutMinutes);

        if (ipAttempts >= policy.maxAttempts * 2) {
            // More lenient for IP (allows multiple users)
            secAudit(
                req,
                'IP_BLOCKED',
                `IP blocked after ${ipAttempts} failed login attempts across accounts (${policy.lockoutMinutes}m)`
            );
            // decided BEFORE any flash — the enforced refusal is the only message.
            if (enforced) return enforcedRefusal(req, res);
            req.flash(
                'error',
                say(
                    req,
                    'flash:adm_ip_blocked',
                    { minutes: policy.lockoutMinutes },
                    'Too many failed login attempts from your network. Please try again later.'
                )
            );
            return res.redirect('/login');
        }

        next();
    } catch (error) {
        console.error('Account lockout check error:', error);
        next(); // Don't block login on error
    }
};

// ---------------------------------------------------------------------------
// 3.23.19 — the break-glass THROTTLE while SSO is enforced. ONE counter for
// EVERY failed password attempt (unknown name, employee, local admin, viewer,
// SuperAdmin alike), keyed on (normalized identifier, IP). It is NOT the
// account-lockout counter: it never locks any account (S2 stays true), it only
// delays the next answer — identically for every identifier, so the delay
// cannot reveal which name is the SuperAdmin. In memory, per process; entries
// expire with the lockout window.
// ---------------------------------------------------------------------------
const _enforcedFails = new Map(); // key -> { n, since }
const ENFORCED_FAILS_MAX_KEYS = 20000;

function enforcedKey(identifier, ip) {
    // Plain normalization, no database lookup: the same work for every name.
    return `${String(identifier || '')
        .trim()
        .toLowerCase()}|${String(ip || '')}`;
}

function enforcedFailureCount(identifier, ip, windowMinutes) {
    const key = enforcedKey(identifier, ip);
    const e = _enforcedFails.get(key);
    if (!e) return 0;
    if (Date.now() - e.since > Number(windowMinutes || 15) * 60000) {
        _enforcedFails.delete(key);
        return 0;
    }
    return e.n;
}

// The IP-wide half: EVERY failed password attempt from an address while
// enforced, whatever the identifier (existing or not). It drives the IP block
// identically — spraying unknown names or the SuperAdmin's name trips it at the
// same attempt — and never touches any account.
const _enforcedIpFails = new Map(); // ip -> { n, since }

function enforcedIpFailureCount(ip, windowMinutes) {
    const key = String(ip || '');
    const e = _enforcedIpFails.get(key);
    if (!e) return 0;
    if (Date.now() - e.since > Number(windowMinutes || 15) * 60000) {
        _enforcedIpFails.delete(key);
        return 0;
    }
    return e.n;
}

function bump(map, key, windowMs, now) {
    const e = map.get(key);
    if (!e || now - e.since > windowMs) {
        if (map.size >= ENFORCED_FAILS_MAX_KEYS) {
            // Bounded memory: drop the oldest entries first (Map keeps insertion order).
            for (const k of map.keys()) {
                map.delete(k);
                if (map.size < ENFORCED_FAILS_MAX_KEYS * 0.9) break;
            }
        }
        map.set(key, { n: 1, since: now });
    } else {
        e.n += 1;
    }
}

// the ACROSS-ADDRESSES half: failed attempts per normalized identifier from
// ANY address. From the 10th failure within the window every further attempt on
// that name waits at least 5 s (5, 10, 20, 40, then 60 s max) — a slowdown, never
// a lock. Kept for every identifier alike (so it reveals nothing); when the name
// is an active SuperAdmin's, a CRITICAL alert is raised (not awaited: the answer
// time does not depend on it).
const _enforcedIdFails = new Map(); // identifier -> { n, since }
const ACCOUNT_SLOWDOWN_AFTER = 10;

function enforcedIdFailureCount(identifier, windowMinutes) {
    const key = enforcedKey(identifier, '').replace(/\|$/, '');
    const e = _enforcedIdFails.get(key);
    if (!e) return 0;
    if (Date.now() - e.since > Number(windowMinutes || 15) * 60000) {
        _enforcedIdFails.delete(key);
        return 0;
    }
    return e.n;
}

/** N5: 0 below 10 failures, then at least 5 s, doubling, capped at 60 s. */
function accountSlowdownMs(failures) {
    const n = Number(failures) || 0;
    if (n < ACCOUNT_SLOWDOWN_AFTER) return 0;
    return Math.min(60000, 5000 * 2 ** (n - ACCOUNT_SLOWDOWN_AFTER));
}

function alertIfSuperadmin(identifier, n) {
    Promise.resolve()
        .then(async () => {
            const id = String(identifier || '')
                .trim()
                .toLowerCase();
            const a = await db.get(
                `SELECT id, username FROM admins
                  WHERE (lower(username) = ? OR lower(email) = ?) AND role = 'superadmin' AND is_active = true
                  LIMIT 1`,
                [id, id]
            );
            if (!a) return;
            console.error(
                `[CRITICAL] ${n} failed break-glass password attempts on SuperAdmin "${a.username}" within the window, from one or more addresses — attempts are now slowed down (no lock).`
            );
            LogService.log({
                adminId: Number(a.id),
                action: 'SUPERADMIN_PASSWORD_ATTACK',
                entityType: 'auth',
                details: `${n} failed break-glass password attempts on SuperAdmin "${a.username}" (all addresses) — progressive slowdown engaged`,
            });
        })
        .catch(() => {});
}

/** Count one failed password attempt while enforced (every identifier). */
async function noteEnforcedFailure(identifier, ip) {
    const policy = await lockoutPolicy();
    bump(_enforcedIpFails, String(ip || ''), policy.lockoutMinutes * 60000, Date.now());
    const idKey = enforcedKey(identifier, '').replace(/\|$/, '');
    bump(_enforcedIdFails, idKey, policy.lockoutMinutes * 60000, Date.now());
    const nId = _enforcedIdFails.get(idKey).n;
    if (nId >= ACCOUNT_SLOWDOWN_AFTER && nId % ACCOUNT_SLOWDOWN_AFTER === 0)
        alertIfSuperadmin(identifier, nId);
    const key = enforcedKey(identifier, ip);
    const now = Date.now();
    const e = _enforcedFails.get(key);
    if (!e || now - e.since > policy.lockoutMinutes * 60000) {
        if (_enforcedFails.size >= ENFORCED_FAILS_MAX_KEYS) {
            // Bounded memory: drop the oldest entries first (Map keeps insertion order).
            for (const k of _enforcedFails.keys()) {
                _enforcedFails.delete(k);
                if (_enforcedFails.size < ENFORCED_FAILS_MAX_KEYS * 0.9) break;
            }
        }
        _enforcedFails.set(key, { n: 1, since: now });
    } else {
        e.n += 1;
    }
}

/** A successful break-glass sign-in clears its own throttle entry. */
function clearEnforcedFailures(identifier, ip) {
    _enforcedFails.delete(enforcedKey(identifier, ip));
    _enforcedIdFails.delete(enforcedKey(identifier, '').replace(/\|$/, ''));
}

/** S2: 0 below 3 failures, then 1 s, 2 s, 4 s … capped at 30 s. */
function progressiveDelayMs(failures) {
    const n = Number(failures) || 0;
    if (n < 3) return 0;
    return Math.min(30000, 1000 * 2 ** (n - 3));
}

/**
 * Record login attempt after authentication
 * Use this in auth strategy
 */
const recordLoginAttempt = async (username, ipAddress, successful) => {
    try {
        username = await canonicalLoginKey(username); // same bucket as the lockout check
        if (successful) {
            await LoginAttemptModel.recordSuccessfulLogin(username, ipAddress);
            await LoginAttemptModel.clearFailedAttempts(username);
        } else {
            await LoginAttemptModel.recordFailedAttempt(username, ipAddress);
        }
    } catch (error) {
        console.error('Failed to record login attempt:', error);
    }
};

module.exports = {
    loginRateLimiter,
    signupRateLimiter,
    apiRateLimiter,
    writeActionLimiter,
    accountReauthLimiter,
    checkAccountLockout,
    recordLoginAttempt,
    lockoutPolicy,
    lockStateFor,
    progressiveDelayMs,
    noteEnforcedFailure,
    enforcedFailureCount,
    enforcedIpFailureCount,
    enforcedIdFailureCount,
    accountSlowdownMs,
    clearEnforcedFailures,
    validatedKeyId,
    _resetApiKeyCacheForTests: () => _validKeyCache.clear(),
};
