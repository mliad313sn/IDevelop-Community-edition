'use strict';

/**
 * requireBulkApproveRight — the route guard of "approve the selected skills".
 *
 * One item is a single approval: let through, and approve() decides, exactly
 * as for POST /api/self-assessment/:id/approve (requireAuth).
 *
 * More than one item is a bulk approval, and asks what "approve all" asks
 * (requireLineOrPermission('approve_assessments')):
 *   - strict mode: a manager session, a SuperAdmin, or an administrator holding
 *     approve_assessments — the guard of approve-all today;
 *   - extended mode: anyone the ladder lets act on someone; approve() still
 *     decides every item on the person.
 */
const SLUG = 'approve_assessments';
const { requireLineOrPermission, wouldLetThrough } = require('./requireLineAuthority');

function itemCount(req) {
    const items = req.body && req.body.items;
    return Array.isArray(items) ? items.length : 0;
}

function requireBulkApproveRight(req, res, next) {
    if (itemCount(req) <= 1) return next();
    return requireLineOrPermission(SLUG)(req, res, next);
}

/** For the view: may this account select several skills? (no checkbox that ends in a 403) */
function mayBulkApprove(user) {
    return wouldLetThrough(user, SLUG);
}

module.exports = requireBulkApproveRight;
module.exports.mayBulkApprove = mayBulkApprove;
module.exports.SLUG = SLUG;
