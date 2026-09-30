const router = require('express').Router();
const DashboardController = require('../controllers/DashboardController');
const ctrl = new DashboardController();
const { requireAuth, requireManagerOrAdmin } = require('../middleware/auth');
const { rbacMiddleware } = require('../middleware/rbac');
const { apiRateLimiter } = require('../middleware/rateLimiter');

// Middleware Aliases to match User Spec
const authMiddleware = requireAuth;
const apiSecurity = apiRateLimiter;

// Page Route — manager/admin only (self-service employees use /employee/*)
router.get(
    '/dashboard',
    authMiddleware,
    requireManagerOrAdmin,
    rbacMiddleware,
    ctrl.renderDashboard.bind(ctrl)
);

// Benchmark module — role×skill required-level matrix + per-role fit. Same RBAC guard.
const BenchmarkController = require('../controllers/BenchmarkController');
router.get(
    '/benchmark',
    authMiddleware,
    requireManagerOrAdmin,
    rbacMiddleware,
    BenchmarkController.index.bind(BenchmarkController)
);
router.get(
    '/benchmark/role/:id',
    authMiddleware,
    requireManagerOrAdmin,
    rbacMiddleware,
    BenchmarkController.roleDetail.bind(BenchmarkController)
);
router.get(
    '/api/benchmark/fit',
    authMiddleware,
    requireManagerOrAdmin,
    rbacMiddleware,
    require('../utils/ttlCache').dashboardCacheMiddleware,
    BenchmarkController.getFit.bind(BenchmarkController)
);

// API Routes
// Guard chain: Authenticated -> Manager/Admin -> RBAC Role/Scope applied,
// then a short-TTL response cache (keyed per user, busted on assessment
// writes) so the heavy executive aggregates aren't recomputed per request.
const { dashboardCacheMiddleware } = require('../utils/ttlCache');
const guard = [authMiddleware, requireManagerOrAdmin, rbacMiddleware, dashboardCacheMiddleware];

router.get('/api/dashboard/overview-kpis', ...guard, ctrl.getOverviewKPIs.bind(ctrl));
router.get('/api/dashboard/measures', ...guard, ctrl.getMeasures.bind(ctrl));
router.get(
    '/api/dashboard/readiness-distribution',
    ...guard,
    ctrl.getReadinessDistribution.bind(ctrl)
);
router.get('/api/dashboard/skill-gaps', ...guard, ctrl.getSkillGaps.bind(ctrl));
router.get('/api/dashboard/role-readiness', ...guard, ctrl.getRoleStaffing.bind(ctrl));
router.get('/api/dashboard/readiness-by-group', ...guard, ctrl.getReadinessByGroup.bind(ctrl));
router.get('/api/dashboard/domain-gaps', ...guard, ctrl.getDomainGaps.bind(ctrl));
router.get('/api/dashboard/gaps-by-service', ...guard, ctrl.getGapsByService.bind(ctrl));
router.get('/api/dashboard/gaps-by-group', ...guard, ctrl.getGapsByGroup.bind(ctrl));
router.get('/api/dashboard/gap-drilldown/:skillId', ...guard, ctrl.getGapDrilldown.bind(ctrl));
router.get('/api/dashboard/employee-list', ...guard, ctrl.getEmployeeList.bind(ctrl));
router.get('/api/dashboard/employee-detail/:id', ...guard, ctrl.getEmployeeDetail.bind(ctrl));
router.get('/api/dashboard/domain-heatmap', ...guard, ctrl.getDomainHeatmap.bind(ctrl));
router.get('/api/dashboard/domain-radar', ...guard, ctrl.getDomainRadarData.bind(ctrl));
router.get('/api/dashboard/filter-options', ...guard, ctrl.getFilterOptions.bind(ctrl));
router.get('/api/dashboard/action-board', ...guard, ctrl.getManagerActionBoard.bind(ctrl));
router.get('/api/dashboard/trend', ...guard, ctrl.getExecutiveTrend.bind(ctrl));
router.get('/api/dashboard/org-domain-radar', ...guard, ctrl.getOrgDomainRadar.bind(ctrl));
router.get('/api/dashboard/org-subdomain-radar', ...guard, ctrl.getOrgSubDomainRadar.bind(ctrl));
router.get('/api/dashboard/comparator-radars', ...guard, ctrl.getComparatorRadars.bind(ctrl));
router.get('/api/dashboard/strategic-insights', ...guard, ctrl.getStrategicInsights.bind(ctrl));
router.get('/api/dashboard/talent-development', ...guard, ctrl.getTalentDevelopment.bind(ctrl));

// ---- Operational compliance & campaign summary (migrations 56/57) ----
// Feeds the Executive tab's "Compliance & Campaign" strip: certification
// expiry pressure, coverage-rule breaches and current-campaign completion,
// all scoped BEFORE aggregation like every other dashboard figure. Cached by
// the same short-TTL layer.
router.get(
    '/api/dashboard/compliance-summary',
    ...guard,
    require('../utils/asyncHandler')(async (req, res) => {
        const { scopedEmployeeIds } = require('../utils/rbacScope');
        const CertificationService = require('../services/CertificationService');
        const CoverageService = require('../services/CoverageService');
        const DashboardService = require('../services/DashboardService');

        const ids = await scopedEmployeeIds(req.user);
        // Campaign completion comes from the PARTICIPANT ROSTER (migration 70), so
        // the person who never opened the campaign is in the denominator. Deriving
        // it from self_assessments counted only people who had already acted and
        // reported 100 % on a campaign 5 of 78 people had started.
        const [counts, lapsed, coverage, campaign] = await Promise.all([
            CertificationService.statusCounts(ids),
            CertificationService.listLapsed(ids, { limit: 1000 }),
            CoverageService.status(ids),
            DashboardService.getCampaignFunnel(ids),
        ]);

        res.json({
            certifications: {
                valid: counts.valid + counts.no_expiry,
                expiring: counts.expiring,
                expired: counts.expired,
                lapsed: lapsed.length,
            },
            coverage: {
                rules: coverage.length,
                breached: coverage.filter((r) => !r.satisfied).length,
                critical: coverage.filter((r) => !r.satisfied && r.severity === 'critical').length,
            },
            campaign,
        });
    })
);

// ---- V2 dashboard widgets (Phase 6) — always mounted; each answers 404 while
// its module is off (Administration → Modules; V2_FEATURES=1 forces them on).
{
    const DashboardV2Controller = require('../controllers/DashboardV2Controller');
    const ah = require('../utils/asyncHandler');
    const mod = (k) => require('../services/ModuleService').requireModule(k);
    router.get(
        '/api/dashboard/v2/bias-monitor',
        mod('talent'),
        ...guard,
        ah(DashboardV2Controller.biasMonitor)
    );
    router.get(
        '/api/dashboard/v2/cycle-countdown',
        mod('campaigns'),
        ...guard,
        ah(DashboardV2Controller.cycleCountdown)
    );
    router.get(
        '/api/dashboard/v2/action-effectiveness',
        mod('talent'),
        ...guard,
        ah(DashboardV2Controller.actionEffectiveness)
    );
    router.get(
        '/api/dashboard/v2/pip-overview',
        mod('development'),
        ...guard,
        ah(DashboardV2Controller.pipOverview)
    );
}

module.exports = router;
