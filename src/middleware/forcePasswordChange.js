'use strict';
/**
 * Force first-login password change: accounts flagged force_password_change
 * (e.g. bulk-imported employees/admins) are funnelled to /change-password until
 * they reset. Assets are served by express.static earlier; the change-password
 * page and logout stay reachable. req.user is re-hydrated from the DB each
 * request, so the redirect stops the moment the flag is cleared.
 *
 * 3.23.19: a session opened through SSO is never sent to
 * change a password it did not use — while SSO is enforced that password cannot
 * sign anyone in (only the SuperAdmin's), so the funnel would be a dead end, and
 * with the MFA-enrolment hold it would bounce between the two pages.
 * (Moved out of server.js unchanged otherwise, so it can be tested.)
 */
function forcePasswordChange(req, res, next) {
    const u = req.user;
    if (!u) return next();
    if (!(u.forcePasswordChange === true || u.forcePasswordChange === 1)) return next();
    const sp = req.session && req.session.passport && req.session.passport.user;
    if (sp && sp.via === 'sso') return next();
    if (req.path === '/change-password' || req.path === '/logout') return next();
    if (req.path.startsWith('/api/')) {
        return res
            .status(403)
            .json({ error: 'Password change required', mustChangePassword: true });
    }
    return res.redirect('/change-password');
}

module.exports = { forcePasswordChange };
