'use strict';

/**
 * /exec — executive decision surfaces.
 *
 * The mount in routes/index.js already applies requireAuth + requireManagerOrAdmin
 * + rbacMiddleware, the same chain the dashboard uses.
 *
 * The key-person routes carry an ADDITIONAL gate. Naming the one person who can
 * do a critical job is continuity-grade data: a manager qualifies (they only
 * ever see their own reports), a superadmin qualifies, and a local admin needs
 * one of the continuity grants. A plain scoped admin with dashboard rights but
 * no continuity grant gets the standard explanatory 403, not a blank page.
 */

const router = require('express').Router();
const ah = require('../utils/asyncHandler');
const { requireManagerOrAnyPermission } = require('../middleware/auth');
const ExecDecisionController = require('../controllers/ExecDecisionController');

const requireContinuityRead = requireManagerOrAnyPermission(
    'view_continuity',
    'manage_succession',
    'view_retention_risk',
    'manage_handover'
);

// ---- Key-person risk (single points of failure, by name) -------------------
router.get('/key-person', requireContinuityRead, ah(ExecDecisionController.keyPersonPage));
router.get('/api/key-person', requireContinuityRead, ah(ExecDecisionController.keyPersonApi));

// ---- Exposure by site ------------------------------------------------------
router.get('/site-exposure', ah(ExecDecisionController.siteExposurePage));
router.get('/api/site-exposure', ah(ExecDecisionController.siteExposureApi));

// ---- Board pack ------------------------------------------------------------
// counts only, the same figures as the dashboard (DashboardHomeService)
router.get('/board-pack', ah(require('../controllers/DashboardHomeController').boardPack));

// ---- Board decisions and the pack recorded as presented (migrations 197, 198)
// State-changing routes: the session CSRF token (server.js) and the service's
// own write check (a manager, or an administrator who is not read-only); the
// pack scope is re-validated on every request (BoardDecisionController).
const BoardDecisionController = require('../controllers/BoardDecisionController');
router.post('/board-pack/record', ah(BoardDecisionController.record));
router.get('/decisions', ah(BoardDecisionController.page));
router.post('/decisions', ah(BoardDecisionController.create));
router.post('/decisions/:id/state', ah(BoardDecisionController.state));
router.post('/decisions/:id/note', ah(BoardDecisionController.note));

module.exports = router;
