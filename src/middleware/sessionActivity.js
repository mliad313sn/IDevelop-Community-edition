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
 * immediately) with the SESSION_IDLE_MINUTES env var / 60 as fallback. getValue
 * is TTL-cached, so the per-request read costs no extra query.
 */

const ENV_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 60;
// Absolute session lifetime. rolling:true slides the cookie maxAge forward on every
// response, so a continuously-used session would otherwise never expire. This is the
// hard ceiling (matches SESSION_MAX_HOURS used for the cookie maxAge), enforced
// independently of the sliding idle window — a session older than this is destroyed
// even if the user is active. Set SESSION_MAX_HOURS=0 to disable the absolute cap.
const ABSOLUTE_MAX_MS = Number(process.env.SESSION_MAX_HOURS || 24) * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'app.sid';

// Never gate static assets / probes / the auth screens themselves on idle logout.
const SKIP =
    /^\/(login|logout|health|healthz|readyz|metrics|favicon|css|js|img|images|fonts|public|vendor|assets|auth\/sso|robots\.txt)\b/i;

module.exports = async function sessionActivity(req, res, next) {
    if (!req.session || !req.isAuthenticated || !req.isAuthenticated()) return next();
    if (SKIP.test(req.path || '')) return next();

    let idleMinutes = ENV_IDLE_MINUTES;
    // The absolute cap is the `sessionTimeout` App Setting (hours)
    // the row was shown as live but nothing read it. Cached read (60 s
    // TTL), env SESSION_MAX_HOURS as fallback; the cookie's own maxAge follows
    // it so the browser drops the cookie at the same moment the server would.
    let absoluteMaxMs = ABSOLUTE_MAX_MS;
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        const v = Number(await AppSettingsModel.getValue('sessionIdleMinutes', ENV_IDLE_MINUTES));
        if (Number.isFinite(v) && v > 0) idleMinutes = v;
        const h = Number(await AppSettingsModel.getValue('sessionTimeout', null));
        if (Number.isFinite(h) && h > 0) absoluteMaxMs = h * 60 * 60 * 1000;
    } catch {
        /* settings unavailable → env/default */
    }
    const IDLE_MS = idleMinutes * 60 * 1000;
    if (absoluteMaxMs > 0 && req.session.cookie && req.session.cookie.maxAge !== absoluteMaxMs)
        req.session.cookie.maxAge = absoluteMaxMs;

    const now = Date.now();
    const last = req.session.lastActivity;
    // Session creation time for the absolute cap. Stamp it once on the first
    // authenticated request (falls back to an existing meta.loginAt so sessions
    // predating this field still get a ceiling).
    if (!req.session.createdAt)
        req.session.createdAt = (req.session.meta && req.session.meta.loginAt) || now;

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
    const endSession = (reason) =>
        req.session.destroy(() => {
            res.clearCookie(SESSION_COOKIE_NAME);
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
    next();
};
