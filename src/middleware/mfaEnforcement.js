'use strict';

const AppSettingsModel = require('../models/AppSettingsModel');
const MfaService = require('../services/MfaService');

// Paths a not-yet-enrolled privileged user MUST still reach — otherwise enforcing
// enrollment would create a redirect loop (they need the setup/verify flow, and a
// way to log out).
const ALLOW_PREFIXES = [
    '/v2/uam/mfa/', // setup, verify, manage, disable, backup codes
    '/logout',
    '/login',
    // The forced password change must stay reachable too, or the
    // two holds (password change + MFA enrolment) would bounce into each other.
    '/change-password',
    '/health',
    '/branding/', // logo/favicon on the setup page
];

function truthy(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * A SuperAdmin ALWAYS needs MFA, whatever the setting
 * says, and fails CLOSED (an enforcement error holds it on the setup page).
 *
 * When the App Setting `mfaRequiredForPrivileged` is on, a privileged (admin)
 * account that has NOT confirmed MFA is forced to the MFA setup screen before it
 * can use anything else. The same applies to managers signed in by
 * password (`mfaRequiredForManagers`), with an upgrade grace period and a
 * countdown; and the gate now FAILS CLOSED (an unreadable setting or MFA state
 * holds the session on the setup page instead of waving it through).
 */
/**
 * May this signed-in person change a password here? Not while
 * SSO is enforced — except the SuperAdmin (break-glass) and an employee a
 * SuperAdmin listed as an SSO exception. Read by views/partials/header.ejs.
 */
function passwordChangeAllowed(u) {
    try {
        const AdminSso = require('../services/AdminSsoService');
        if (!AdminSso.isEnforced()) return true;
        return AdminSso.passwordAllowedWhileEnforced(u);
    } catch (_) {
        return true; // a menu entry only; the page itself keeps its own checks
    }
}

/**
 * Who must hold MFA, and until when a missing enrolment is
 * tolerated.
 *   admin (every admin role, incl. HR-wide viewers)  mfaRequiredForPrivileged
 *   manager signed in by PASSWORD                    mfaRequiredForManagers
 *     (a manager session opened through SSO satisfies it with the IdP's MFA)
 * Upgrades get a grace period from `mfaGraceStartedAt` (written by migration
 * 162): mfaGraceAdminDays (14) / mfaGraceManagerDays (30). A new install has no
 * start date → no grace. Throws when the settings cannot be read (the caller
 * fails CLOSED).
 * @returns {Promise<{required:boolean, graceEndsAt:Date|null}>}
 */
async function mfaPolicyFor(u) {
    const isAdmin = u.userType === 'admin';
    const required = truthy(
        await AppSettingsModel.getValue(
            isAdmin ? 'mfaRequiredForPrivileged' : 'mfaRequiredForManagers',
            isAdmin
        )
    );
    if (!required) return { required: false, graceEndsAt: null };
    const startRaw = await AppSettingsModel.getValue('mfaGraceStartedAt', '');
    const start = startRaw ? new Date(String(startRaw)) : null;
    if (!start || Number.isNaN(start.getTime())) return { required: true, graceEndsAt: null };
    const days = Number(
        await AppSettingsModel.getValue(
            isAdmin ? 'mfaGraceAdminDays' : 'mfaGraceManagerDays',
            isAdmin ? 14 : 30
        )
    );
    const d = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 0;
    return { required: true, graceEndsAt: d ? new Date(start.getTime() + d * 86400000) : null };
}

/** The countdown: once per session a warning flash + audit; every page gets res.locals.mfaGrace. */
function graceNotice(req, res, u, graceEndsAt) {
    const daysLeft = Math.max(1, Math.ceil((graceEndsAt.getTime() - Date.now()) / 86400000));
    let date = graceEndsAt.toISOString().slice(0, 10);
    try {
        date = require('../utils/dateFormat').fmtDateTime(graceEndsAt, req.language || 'fr');
    } catch (_) {
        /* ISO date */
    }
    if (res && res.locals) res.locals.mfaGrace = { daysLeft, deadline: graceEndsAt, date };
    if (!req.session || req.session.mfaGraceNoticeShown) return;
    req.session.mfaGraceNoticeShown = true;
    if (typeof req.flash === 'function')
        req.flash(
            'warning',
            req.t
                ? req.t('auth:mfa_grace_notice', { count: daysLeft, days: daysLeft, date })
                : `La double authentification deviendra obligatoire pour votre compte le ${date} (dans ${daysLeft} jour(s)). Activez-la dès maintenant.`
        );
    try {
        require('../services/LogService').log({
            adminId: u.userType === 'admin' ? u.id : null,
            actorRef: u.userType === 'admin' ? null : `${u.userType}#${u.id}`,
            action: 'MFA_GRACE_PROMPT',
            entityType: 'auth',
            details: `Two-factor enrolment required by policy — ${daysLeft} day(s) of grace left (until ${graceEndsAt.toISOString()})`,
            ipAddress: req.ip,
            userAgent: req.get ? req.get('user-agent') : null,
        });
    } catch (_) {
        /* audit best effort */
    }
}

/**
 * The policy gate for a non-SuperAdmin admin or a password-signed-in manager.
 * FAILS CLOSED: settings or MFA state unreadable → held on the setup page.
 */
async function policyGate(req, res, next, u, p) {
    let policy;
    try {
        policy = await mfaPolicyFor(u);
    } catch (_) {
        return holdOnSetup(req, res, p);
    }
    if (!policy.required) return next();
    if (req.session && req.session.mfaVerifiedInSession === true) return next();
    const mfaType = MfaService.mfaUserType(u);
    if (MfaService.hasFreshEnrolment(mfaType, u.id, 5 * 60_000)) return next();
    let active = false;
    try {
        active = await MfaService.isActive({ userType: mfaType, userId: u.id });
    } catch (_) {
        return holdOnSetup(req, res, p);
    }
    if (active) {
        MfaService.rememberEnrolment(mfaType, u.id);
        return next();
    }
    if (policy.graceEndsAt && Date.now() < policy.graceEndsAt.getTime()) {
        graceNotice(req, res, u, policy.graceEndsAt);
        return next();
    }
    return holdOnSetup(req, res, p);
}

async function enforceMfaEnrollment(req, res, next) {
    if (res && res.locals && req.user)
        res.locals.passwordChangeAllowed = passwordChangeAllowed(req.user);
    try {
        if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) return next();
        const u = req.user;

        const p = req.path || '';
        if (
            p.startsWith('/css/') ||
            p.startsWith('/js/') ||
            p.startsWith('/images/') ||
            p.startsWith('/vendor/') ||
            p === '/favicon.ico'
        )
            return next();
        if (ALLOW_PREFIXES.some((a) => p === a || p.startsWith(a))) return next();

        // A MANAGER who signed in by password must hold MFA (a
        // manager session opened through SSO satisfies it with the IdP's MFA).
        if (u.userType === 'manager') {
            const via = req.session && req.session.passport && req.session.passport.user;
            if (via && via.via === 'sso') return next();
            return policyGate(req, res, next, u, p);
        }
        if (u.userType !== 'admin') return next(); // employees are exempt from this policy

        // A session HELD on MFA enrolment — an admin who
        // signed in through SSO with a one-time enrolment code, or the SuperAdmin
        // break-glass with no local MFA while SSO is enforced — stays held,
        // whatever the policy says, until a TOTP code is verified IN THIS SESSION
        // (v2-uam /mfa/verify clears the flag). Fails CLOSED.
        const forced = !!(req.session && req.session.mfaEnrolRequired === true);
        if (forced) {
            if (req.session.mfaVerifiedInSession === true) {
                delete req.session.mfaEnrolRequired;
                return next();
            }
            let activeElsewhere = false;
            try {
                activeElsewhere = await MfaService.isActive({
                    userType: MfaService.mfaUserType(u),
                    userId: u.id,
                });
            } catch (_) {
                activeElsewhere = false;
            }
            if (activeElsewhere) {
                // Enrolled meanwhile, but not proven in THIS session: sign in again
                // (the /login/mfa challenge then applies). Never released here.
                return req.logout
                    ? req.logout(() => {
                          if (req.flash)
                              req.flash(
                                  'warning',
                                  req.t
                                      ? req.t('flash:mfa_signin_again')
                                      : 'Reconnectez-vous : la double authentification est active sur ce compte.'
                              );
                          res.redirect('/login');
                      })
                    : res.redirect('/login');
            }
            return holdOnSetup(req, res, p);
        }

        // The hold is ALSO derived from the session's own origin,
        // not only from the flag — an admin session opened by SSO or by the
        // SuperAdmin break-glass (recorded by serializeUser as `via`, in the same
        // save as the sign-in itself) with no second factor proven in THIS session
        // (the /login/mfa code, IdP-asserted MFA, or /mfa/verify) and no local MFA
        // active is held on the setup page. Fails CLOSED.
        const sp = req.session && req.session.passport && req.session.passport.user;
        const origin = sp && (sp.via === 'sso' || sp.via === 'breakglass') ? sp.via : null;
        if (origin && req.session.mfaVerifiedInSession !== true) {
            let localActive = false;
            try {
                localActive = await MfaService.isActive({
                    userType: MfaService.mfaUserType(u),
                    userId: u.id,
                });
            } catch (_) {
                return holdOnSetup(req, res, p);
            }
            if (!localActive) return holdOnSetup(req, res, p);
        }

        // A SuperAdmin ALWAYS needs MFA — whatever the settings,
        // with or without SSO. ONLY a second factor proven IN THIS SESSION lets it
        // through (MFA merely being active on the account — enrolled
        // elsewhere, e.g. by the real owner — never releases a session held on
        // setup). Enrolled but not proven here → signed out, back to the
        // /login/mfa challenge; not enrolled → held on setup. FAILS CLOSED.
        if (u.role === 'superadmin') {
            if (req.session && req.session.mfaVerifiedInSession === true) return next();
            let saActive = false;
            try {
                saActive = await MfaService.isActive({
                    userType: MfaService.mfaUserType(u),
                    userId: u.id,
                });
            } catch (_) {
                return holdOnSetup(req, res, p);
            }
            if (!saActive) return holdOnSetup(req, res, p);
            return req.logout
                ? req.logout(() => {
                      if (req.flash)
                          req.flash(
                              'warning',
                              req.t
                                  ? req.t('flash:mfa_signin_again')
                                  : 'Reconnectez-vous : la double authentification est active sur ce compte.'
                          );
                      res.redirect('/login');
                  })
                : res.redirect('/login');
        }

        // Every admin role — with the upgrade grace period, and
        // FAILING CLOSED (it used to wave the admin through on any read error).
        return await policyGate(req, res, next, u, p);
    } catch (_) {
        // FAIL CLOSED for every account this policy governs — admins and
        // password-signed-in managers — as it already did for a held session and
        // the SuperAdmin. Only employees (outside the policy) pass.
        const u = req.user;
        const via = req.session && req.session.passport && req.session.passport.user;
        const governed =
            (req.session && req.session.mfaEnrolRequired === true) ||
            (u && u.userType === 'admin') ||
            (u && u.userType === 'manager' && !(via && via.via === 'sso'));
        if (governed) return res.redirect('/v2/uam/mfa/setup');
        return next();
    }
}

function holdOnSetup(req, res, p) {
    if (p.startsWith('/api/')) {
        return res.status(403).json({
            error: 'Two-factor enrollment is required by policy. Set it up at /v2/uam/mfa/setup.',
        });
    }
    req.flash(
        'error',
        req.t
            ? req.t('flash:mfa_enrollment_required')
            : 'Your administrator requires two-factor authentication. Please set it up to continue.'
    );
    return res.redirect('/v2/uam/mfa/setup');
}

module.exports = { enforceMfaEnrollment, passwordChangeAllowed, mfaPolicyFor };
