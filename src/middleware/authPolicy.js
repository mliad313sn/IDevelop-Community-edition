'use strict';

/**
 * Per-USER authentication policy enforcement (employees.auth_policy /
 * admins.auth_policy, migration 55). Complements the global role-level
 * `mfaRequiredForPrivileged` setting (mfaEnforcement.js):
 *
 *   'mfa_required' — THIS user must enrol in two-factor auth before using the
 *                    app, regardless of role. Enforced here: until MFA is
 *                    active, every page funnels to the MFA setup (same UX as
 *                    the global policy — setup/logout stay reachable).
 *   'sso_only'     — local password login refused; enforced at the point of
 *                    login in AuthService / EmployeeAuthService.
 *   'local_only'   — SSO callback refused; enforced in SsoController.
 *
 * Fails CLOSED for an 'mfa_required' account (an unreadable MFA state holds it
 * on the setup page, as mfaEnforcement does); everyone else is untouched.
 */

const MfaService = require('../services/MfaService');

// Must stay reachable for a not-yet-enrolled user (no redirect loops).
const ALLOW_PREFIXES = [
    '/v2/uam/mfa/',
    '/logout',
    '/login',
    '/change-password', // forced first-login rotation may run before enrolment
    '/health',
    '/branding/',
];

async function enforceUserAuthPolicy(req, res, next) {
    try {
        if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) return next();
        const u = req.user;
        if (String(u.authPolicy || 'any') !== 'mfa_required') return next();

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

        let active = false;
        try {
            active = await MfaService.isActive({
                userType: MfaService.mfaUserType(u),
                userId: u.id,
            });
        } catch (_) {
            // FAIL CLOSED: this account's policy says MFA is mandatory; an
            // unreadable MFA state must not open the app without it.
            return hold(req, res, p);
        }
        if (active) return next();
        return hold(req, res, p);
    } catch (_) {
        // Fail closed for an account under 'mfa_required'; anyone else passes.
        const u = req.user;
        if (u && String(u.authPolicy || 'any') === 'mfa_required')
            return hold(req, res, req.path || '');
        return next();
    }
}

function hold(req, res, p) {
    if (String(p).startsWith('/api/')) {
        return res.status(403).json({
            error: 'Two-factor enrollment is required for your account. Set it up at /v2/uam/mfa/setup.',
        });
    }
    if (typeof req.flash === 'function')
        req.flash(
            'error',
            req.t
                ? req.t('flash:mfa_enrollment_required')
                : 'Your account requires two-factor authentication. Please set it up to continue.'
        );
    return res.redirect('/v2/uam/mfa/setup');
}

module.exports = { enforceUserAuthPolicy };
