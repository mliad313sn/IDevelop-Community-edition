'use strict';

/**
 * requireLineOrPermission(...slugs) — the route half of the authority ladder
 * (services/AuthorityService).
 *
 * strict mode (the default): exactly requireManagerOrAnyPermission(...slugs),
 * the guard these routes had before the ladder — a manager session, a
 * SuperAdmin, or an administrator holding one of the slugs (never a viewer
 * for a write slug).
 *
 * extended mode: the route only asks "could this account act on anyone by the
 * ladder?" (AuthorityService.mayActOnSomeone: a manager session, a SuperAdmin,
 * any administration account that is not read-only) and the service decides on
 * the person (canAct). Everyone else gets the house refusal of
 * requireManagerOrAnyPermission, so the status, the shape and the audit of a
 * refusal do not change with the mode.
 */
const AuthorityService = require('../services/AuthorityService');

function requireLineOrPermission(...slugs) {
    const guard = function requireLineOrPermissionGuard(req, res, next) {
        // Resolved per request: middleware/auth is required by this module's callers.
        const house = require('./auth').requireManagerOrAnyPermission(...slugs);
        const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
        if (!authed || !AuthorityService.mayActOnSomeone(req.user)) return house(req, res, next);
        Promise.resolve(AuthorityService.mode())
            .catch(() => 'strict')
            .then((mode) => (mode === 'extended' ? next() : house(req, res, next)))
            .catch(next);
    };
    guard.slugs = slugs;
    return guard;
}

/**
 * The same decision without a response, for a view that must not offer a
 * button the guard would refuse. Resolves to a boolean.
 */
async function wouldLetThrough(user, ...slugs) {
    if (!user) return false;
    if (user.userType === 'manager') return true;
    if (user.userType !== 'admin') return false;
    if (user.role === 'superadmin') return true;
    if (AuthorityService.mayActOnSomeone(user) && (await AuthorityService.mode()) === 'extended')
        return true;
    const isViewer = user.role === 'viewer';
    const writeSlugs = require('../config/permissions').WRITE_SLUGS;
    const grants = Array.isArray(user.permissions) ? user.permissions : [];
    return slugs.some((s) => grants.includes(s) && !(isViewer && writeSlugs.has(s)));
}

module.exports = { requireLineOrPermission, wouldLetThrough };
