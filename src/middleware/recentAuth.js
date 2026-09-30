'use strict';

/**
 * Re-authentication for sensitive actions (ASVS 3.7.1, 4.3.3).
 *
 * A live session is not enough to mint an API key or to make someone a
 * SuperAdmin: a borrowed laptop or a stolen cookie would be enough to plant a
 * lasting credential or a lasting privilege. These actions therefore need
 * EITHER a sign-in in the last REAUTH_WINDOW_MINUTES (15 by default) OR the
 * current password, sent with the request as `currentPassword`.
 *
 * "Signed in at" is the first authenticated request of the session
 * (`session.meta.loginAt`, stamped by sessionActivity right after the sign-in
 * regenerated the session), refreshed by a successful password confirmation
 * here (`session.reauthAt`).
 *
 * Wrong passwords are capped per account (REAUTH_MAX_FAILURES in the window)
 * so this gate cannot be used as a password oracle. Every refusal and every
 * confirmation is audited; the password itself is never logged and is removed
 * from `req.body` before the route runs.
 *
 * Other sensitive actions already re-authenticate in their own handler:
 * changing one's password (current password), one's e-mail (current
 * password, AuthController.updateProfile) and deactivating MFA (a current
 * code, routes/v2-uam.js).
 */

const WINDOW_MINUTES = Number(process.env.REAUTH_WINDOW_MINUTES) || 15;
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;
const MAX_FAILURES = Number(process.env.REAUTH_MAX_FAILURES) || 5;

const failures = new Map(); // `${userType}:${id}` -> [timestamps]

function keyOf(user) {
    return `${(user && user.userType) || 'user'}:${user && user.id}`;
}

function recentFailures(user, now = Date.now()) {
    const k = keyOf(user);
    const list = (failures.get(k) || []).filter((t) => now - t < WINDOW_MS);
    if (list.length) failures.set(k, list);
    else failures.delete(k);
    return list.length;
}

function noteFailure(user, now = Date.now()) {
    const k = keyOf(user);
    const list = (failures.get(k) || []).filter((t) => now - t < WINDOW_MS);
    list.push(now);
    failures.set(k, list);
}

/** Epoch ms of the last proof of identity in this session, or 0. */
function authenticatedAt(session) {
    if (!session) return 0;
    const at = Math.max(
        Number(session.reauthAt) || 0,
        Number(session.meta && session.meta.loginAt) || 0
    );
    return Number.isFinite(at) ? at : 0;
}

function isRecent(req, now = Date.now()) {
    const at = authenticatedAt(req.session);
    return at > 0 && now - at >= 0 && now - at <= WINDOW_MS;
}

/** 'ok' | 'missing' | 'bad' | 'no_local_password' */
async function checkCurrentPassword(user, supplied) {
    let record = null;
    try {
        if (user.userType === 'admin') {
            record = await require('../models/AdminModel').findById(user.id);
        } else {
            record = await require('../models/EmployeeModel').findById(user.id);
        }
    } catch (_) {
        record = null;
    }
    const hash = record && (record.passwordHash || record.password_hash);
    if (!hash || record.passwordDisabled === true || record.password_disabled === true)
        return 'no_local_password';
    if (!supplied) return 'missing';
    const ok = await require('bcrypt')
        .compare(String(supplied), hash)
        .catch(() => false);
    return ok ? 'ok' : 'bad';
}

function audit(req, action, details) {
    try {
        const u = req.user || {};
        require('../services/LogService')
            .log({
                adminId: u.userType === 'admin' ? u.id : null,
                actorRef: u.id != null ? `${u.userType || 'user'}:${u.id}` : null,
                action,
                entityType: 'auth',
                details,
                category: 'security',
                severity: action === 'REAUTH_CONFIRMED' ? 'info' : 'warn',
                requestId: req.id || null,
                ipAddress: req.ip,
                userAgent: req.get ? req.get('user-agent') : null,
            })
            .catch(() => {});
    } catch (_) {
        /* audit never blocks */
    }
}

/** The refusal sentence, in the session's language (literal keys, one per case). */
function message(req, verdict) {
    const minutes = WINDOW_MINUTES;
    const t = typeof req.t === 'function' ? req.t.bind(req) : null;
    const fill = (fb) => fb.replace('{{minutes}}', String(minutes));
    const pick = (s, fb) => (s && !/^flash:|^reauth_/.test(s) ? s : fill(fb));
    if (verdict === 'bad') {
        const fb = 'Mot de passe actuel incorrect : l’action n’a pas été effectuée.';
        return pick(t && t('flash:reauth_bad_password', { minutes, defaultValue: fill(fb) }), fb);
    }
    if (verdict === 'no_local_password') {
        const fb =
            'Pour cette action sensible, déconnectez-vous puis reconnectez-vous, et recommencez dans les {{minutes}} minutes.';
        return pick(t && t('flash:reauth_sign_in_again', { minutes, defaultValue: fill(fb) }), fb);
    }
    if (verdict === 'locked') {
        const fb = 'Trop de mots de passe incorrects. Réessayez dans {{minutes}} minutes.';
        return pick(t && t('flash:reauth_locked', { minutes, defaultValue: fill(fb) }), fb);
    }
    const fb =
        'Pour cette action sensible, confirmez votre mot de passe actuel (dernière connexion il y a plus de {{minutes}} minutes).';
    return pick(t && t('flash:reauth_required', { minutes, defaultValue: fill(fb) }), fb);
}

function refuse(req, res, verdict, redirectTo) {
    const code = verdict === 'bad' ? 'reauth_failed' : 'reauth_required';
    const text = message(req, verdict);
    let json = false;
    try {
        json = require('./auth').wantsJson(req) || /^\/api\//.test(req.originalUrl || req.path);
    } catch (_) {
        json = true;
    }
    if (json || typeof req.flash !== 'function') {
        return res
            .status(403)
            .json({ ok: false, code, error: text, reauthMinutes: WINDOW_MINUTES });
    }
    req.flash('error', text);
    const back =
        typeof redirectTo === 'function'
            ? redirectTo(req)
            : redirectTo || require('../utils/safeRedirect').safeBackUrl(req);
    return res.redirect(back);
}

/**
 * @param {object} [opts]
 * @param {(req) => boolean|Promise<boolean>} [opts.when]  apply only when this returns true
 * @param {string} [opts.action]          label for the audit trail
 * @param {string|function} [opts.redirectTo]  where an HTML refusal goes back to
 */
function requireRecentAuth(opts = {}) {
    const { when = null, action = 'sensitive action', redirectTo = null } = opts;
    return async function recentAuth(req, res, next) {
        try {
            if (when && !(await when(req))) return next();
            if (!req.user || !req.session) return refuse(req, res, 'missing', redirectTo);
            const supplied =
                req.body && typeof req.body.currentPassword === 'string'
                    ? req.body.currentPassword
                    : '';
            if (req.body) delete req.body.currentPassword;
            if (isRecent(req)) return next();

            if (recentFailures(req.user) >= MAX_FAILURES) {
                audit(
                    req,
                    'REAUTH_LOCKED',
                    `Re-authentication refused for ${action}: too many wrong passwords`
                );
                return refuse(req, res, 'locked', redirectTo);
            }
            const verdict = await checkCurrentPassword(req.user, supplied);
            if (verdict === 'ok') {
                req.session.reauthAt = Date.now();
                audit(req, 'REAUTH_CONFIRMED', `Current password confirmed for ${action}`);
                return next();
            }
            if (verdict === 'bad') {
                noteFailure(req.user);
                audit(req, 'REAUTH_FAILED', `Wrong current password for ${action}`);
            } else {
                audit(req, 'REAUTH_REQUIRED', `Recent sign-in required for ${action} (${verdict})`);
            }
            return refuse(req, res, verdict, redirectTo);
        } catch (e) {
            return next(e);
        }
    };
}

module.exports = {
    requireRecentAuth,
    isRecent,
    authenticatedAt,
    checkCurrentPassword,
    WINDOW_MINUTES,
    _reset: () => failures.clear(),
};
