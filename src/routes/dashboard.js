const router = require('express').Router();
const { requireAuth, requireManagerOrAdmin } = require('../middleware/auth');
const { rbacMiddleware } = require('../middleware/rbac');

// Middleware Aliases to match User Spec
const authMiddleware = requireAuth;

// ---------------------------------------------------------------------------
// The dashboard (DashboardHomeController, DashboardHomeService). ONE page
// adapted to the reader's clearance; counts only, every count links to the
// list behind it (/dashboard/list). An employee who reaches /dashboard (an
// old bookmark, a shared link) is taken to their own home, without the
// « access denied » flash of the manager/admin guard.
// ---------------------------------------------------------------------------
const DashboardHomeController = require('../controllers/DashboardHomeController');
const ah = require('../utils/asyncHandler');
const toOwnHome = (req, res, next) =>
    req.user && req.user.userType === 'employee'
        ? res.redirect(302, '/employee/dashboard')
        : next();
const pageGuard = [authMiddleware, toOwnHome, requireManagerOrAdmin, rbacMiddleware];
router.get('/dashboard', ...pageGuard, ah(DashboardHomeController.page));
// one context tab, fetched on demand with the same scope and gates as the page
router.get('/dashboard/panel', ...pageGuard, ah(DashboardHomeController.panel));
// the list behind a figure, as aggregates (403 without the block's capability)
router.get('/dashboard/list', ...pageGuard, ah(DashboardHomeController.list));

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

// ---------------------------------------------------------------------------
// RETIRED: the JSON endpoints of the former dashboard page. Its only caller,
// public/js/dashboard.js, is gone with that page (no other view, script, test
// helper or API document calls them; the Power BI and /api/v1 feeds are
// separate). Several returned names and filtered by unit NAME. Every figure is
// now rendered on the server by the dashboard (DashboardHomeService, ID-scoped
// by KpiService.resolvePopulation). They answer 410 Gone for everyone, never
// data.
// ---------------------------------------------------------------------------
const RETIRED = Object.freeze([
    '/api/benchmark/fit',
    '/api/dashboard/overview-kpis',
    '/api/dashboard/measures',
    '/api/dashboard/readiness-distribution',
    '/api/dashboard/skill-gaps',
    '/api/dashboard/role-readiness',
    '/api/dashboard/readiness-by-group',
    '/api/dashboard/domain-gaps',
    '/api/dashboard/gaps-by-service',
    '/api/dashboard/gaps-by-group',
    '/api/dashboard/gap-drilldown/:skillId',
    '/api/dashboard/employee-list',
    '/api/dashboard/employee-detail/:id',
    '/api/dashboard/domain-heatmap',
    '/api/dashboard/domain-radar',
    '/api/dashboard/filter-options',
    '/api/dashboard/action-board',
    '/api/dashboard/trend',
    '/api/dashboard/org-domain-radar',
    '/api/dashboard/org-subdomain-radar',
    '/api/dashboard/comparator-radars',
    '/api/dashboard/strategic-insights',
    '/api/dashboard/talent-development',
    '/api/dashboard/compliance-summary',
]);
const retired = (req, res) =>
    res.status(410).json({
        error: req && typeof req.t === 'function' ? req.t('dash:d3_retired') : 'Endpoint retired',
        code: 'endpoint_retired',
    });
for (const p of RETIRED) router.get(p, authMiddleware, retired);

/**
 * The SAME capability as the dashboard block the widget feeds (403 otherwise),
 * computed on the reader's cleared population.
 */
function requireDashCapability(cap) {
    return async (req, res, next) => {
        try {
            const D = require('../services/DashboardHomeService');
            const pop = await require('../services/KpiService').resolvePopulation({
                viewer: req.user,
            });
            const caps = D.capabilities(req.user, pop);
            if (caps && caps[cap]) return next();
        } catch (_) {
            /* an unresolvable capability is never a granted one */
        }
        return res
            .status(403)
            .json({ error: 'forbidden', code: 'capability_required', capability: cap });
    };
}

const { dashboardCacheMiddleware } = require('../utils/ttlCache');
const guard = [authMiddleware, requireManagerOrAdmin, rbacMiddleware];

// ---- V2 dashboard widgets (Phase 6) — always mounted; each answers 404 while
// its module is off (Administration → Modules; V2_FEATURES=1 forces them on).
{
    const DashboardV2Controller = require('../controllers/DashboardV2Controller');
    const mod = (k) => require('../services/ModuleService').requireModule(k);
    router.get(
        '/api/dashboard/v2/bias-monitor',
        mod('talent'),
        ...guard,
        requireDashCapability('talent'),
        dashboardCacheMiddleware,
        ah(DashboardV2Controller.biasMonitor)
    );
    router.get(
        '/api/dashboard/v2/cycle-countdown',
        mod('campaigns'),
        ...guard,
        requireDashCapability('campaign'),
        dashboardCacheMiddleware,
        ah(DashboardV2Controller.cycleCountdown)
    );
    router.get(
        '/api/dashboard/v2/action-effectiveness',
        mod('talent'),
        ...guard,
        requireDashCapability('talent'),
        dashboardCacheMiddleware,
        ah(DashboardV2Controller.actionEffectiveness)
    );
    router.get(
        '/api/dashboard/v2/pip-overview',
        mod('development'),
        ...guard,
        requireDashCapability('plans'),
        dashboardCacheMiddleware,
        ah(DashboardV2Controller.pipOverview)
    );
}

module.exports = router;
module.exports.RETIRED = RETIRED;
module.exports.requireDashCapability = requireDashCapability;
