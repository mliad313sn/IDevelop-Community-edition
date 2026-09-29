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
router.get('/board-pack', ah(ExecDecisionController.boardPackPage));

module.exports = router;
