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
    // S3 (3.23.19): the forced password change must stay reachable too, or the
    // two holds (password change + MFA enrolment) would bounce into each other.
    '/change-password',
    '/health',
    '/branding/', // logo/favicon on the setup page
];

function truthy(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * 3.23.20 (Amendment C2a): a SuperAdmin ALWAYS needs MFA, whatever the setting
 * says, and fails CLOSED (an enforcement error holds it on the setup page).
 *
 * When the App Setting `mfaRequiredForPrivileged` is on, a privileged (admin)
 * account that has NOT confirmed MFA is forced to the MFA setup screen before it
 * can use anything else. Previously this setting existed in the schema but was
 * never enforced anywhere — a dead policy. Fails OPEN on any error so an
 * enforcement hiccup can never lock every admin out of their own instance.
 */
/**
 * UX-8 (3.23.21): may this signed-in person change a password here? Not while
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

async function enforceMfaEnrollment(req, res, next) {
    if (res && res.locals && req.user)
        res.locals.passwordChangeAllowed = passwordChangeAllowed(req.user);
    try {
        if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) return next();
        const u = req.user;
        if (u.userType !== 'admin') return next(); // employees are exempt from this policy

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

        // 3.23.19: a session HELD on MFA enrolment — an admin who
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

        // L1 (3.23.19): the hold is ALSO derived from the session's own origin,
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

        // C2a (3.23.20): a SuperAdmin ALWAYS needs MFA — whatever the settings,
        // with or without SSO. ONLY a second factor proven IN THIS SESSION lets it
        // through (security N1: MFA merely being active on the account — enrolled
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

        const required = await AppSettingsModel.getValue('mfaRequiredForPrivileged', false);
        if (!truthy(required)) return next();

        let active = false;
        try {
            active = await MfaService.isActive({
                userType: MfaService.mfaUserType(u),
                userId: u.id,
            });
        } catch (_) {
            return next(); // MFA tables absent / DB hiccup → do NOT lock the admin out
        }
        if (active) return next();

        // Policy on + privileged + not enrolled → force enrollment.
        return holdOnSetup(req, res, p);
    } catch (_) {
        // Never hard-block on an enforcement error — except a HELD session, which
        // has not proven a second factor and stays on the setup page.
        if (req.session && req.session.mfaEnrolRequired === true)
            return res.redirect('/v2/uam/mfa/setup');
        // C2a: …and a SuperAdmin fails closed too.
        if (req.user && req.user.userType === 'admin' && req.user.role === 'superadmin')
            return res.redirect('/v2/uam/mfa/setup');
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

module.exports = { enforceMfaEnrollment, passwordChangeAllowed };
