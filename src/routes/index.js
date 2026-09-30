const PRODUCT = require('../config/product');
const express = require('express');
const router = express.Router();

// Controllers
const AuthController = require('../controllers/AuthController');

const EmployeeController = require('../controllers/EmployeeController');
const AssessmentController = require('../controllers/AssessmentController');
const OrganizationController = require('../controllers/OrganizationController');
const RoleController = require('../controllers/RoleController');
const SkillController = require('../controllers/SkillController');
const DomainController = require('../controllers/DomainController');
const SubDomainController = require('../controllers/SubDomainController');
const AdminController = require('../controllers/AdminController');
const ReportController = require('../controllers/ReportController');
const SkillMatrixController = require('../controllers/SkillMatrixController');
const DataManagementController = require('../controllers/DataManagementController');
const SystemLogController = require('../controllers/SystemLogController');
const NotificationAdminController = require('../controllers/NotificationAdminController');
const AppSettingsController = require('../controllers/AppSettingsController');
const EmployeePortalController = require('../controllers/EmployeePortalController');
const OrgChartController = require('../controllers/OrgChartController');
const TalentActionsController = require('../controllers/TalentActionsController');
const NotificationController = require('../controllers/NotificationController');
const EmployeeGrowthController = require('../controllers/EmployeeGrowthController');
const GuideController = require('../controllers/GuideController');
const SupervisorReviewController = require('../controllers/SupervisorReviewController');
const SelfAssessmentWorkflowController = require('../controllers/SelfAssessmentWorkflowController');
const CoachingPlanController = require('../controllers/CoachingPlanController');
const NineBoxController = require('../controllers/NineBoxController');
const { safeBackUrl } = require('../utils/safeRedirect');

// Middleware
const {
    requireAuth,
    requireSuperAdmin,
    requireSuperAdminPage,
    requirePermission,
    requireAnyPermission,
    requireEmployee,
    requireEmployeeOrManager,
    requireManager,
    requireManagerOrAdmin,
    requireManagerOrAnyPermission,
    requireAdmin,
} = require('../middleware/auth');
const {
    checkEmployeeAccess,
    checkEmployeeReadAccess,
    rbacMiddleware,
} = require('../middleware/rbac');

/**
 * Reject a non-numeric :param on an HTML (non-/api) route BEFORE any bigint
 * query runs.
 *
 * `/employees/abc` used to reach checkEmployeeAccess → `parseInt('abc')` → NaN →
 * a naked `{"error":"Employee ID required"}` JSON blob rendered as raw text in
 * the browser; `/supervisor/reviews/abc` went one worse and reached PostgreSQL,
 * which answered `invalid input syntax for type bigint: "abc"`. Both are a
 * mis-typed URL — a 404. Forwarding a status-tagged Error hands it to the shared
 * error middleware, which renders the styled error page for HTML callers and
 * keeps JSON for API/XHR callers.
 *
 * @param {string} name the route parameter to validate (default 'id')
 */
const requireNumericParam =
    (name = 'id') =>
    (req, res, next) => {
        const raw = req.params[name];
        if (/^\d+$/.test(String(raw || '').trim())) return next();
        const err = new Error(req.t ? req.t('flash:invalid_identifier') : 'Identifiant invalide');
        err.status = 404;
        err.expose = true;
        return next(err);
    };
const DepartmentModel = require('../models/DepartmentModel');
const ServiceModel = require('../models/ServiceModel');
const RBACService = require('../services/RBACService');
const ModuleService = require('../services/ModuleService');
// Module switch guard (Administration → Modules): the app's normal 404 while
// none of the named modules is on. Read per request (TTL-cached settings).
const _mod = (...keys) => ModuleService.requireModule(...keys);

// Validators (moved here to avoid circular dependencies)
const {
    employeeValidation,
    siteValidation,
    departmentValidation,
    serviceValidation,
    domainValidation,
    skillValidation,
    roleValidation,
    adminValidation,
    adminUpdateValidation,
    assessmentValidation,
} = require('../utils/validators');

// Public routes
// Contextual, clearance-aware user guide (in-app).
router.get('/guide', requireAuth, GuideController.index);

// The standalone illustrated manual, at the URLs it has always had. It used to
// sit in public/ and was therefore handed to ANY caller that could reach the
// port: express.static is mounted before the session, so no authentication ran
//. It now lives in private/guides/, which nothing serves,
// and reaches the reader only through this route.
//
// The two file names are a fixed map, never a path built from the request, so
// there is nothing here to traverse with.
const GUIDE_FILES = {
    '/user-guide.html': 'user-guide.html',
    '/user-guide.en.html': 'user-guide.en.html',
};
router.get(Object.keys(GUIDE_FILES), requireAuth, (req, res) => {
    const file = GUIDE_FILES[req.path];
    if (!file) return res.status(404).end();
    // Still a document a signed-in reader may keep open; revalidate rather than
    // cache for a week, exactly as the static mount did.
    res.set('Cache-Control', 'no-cache');
    // `path` is declared further down this file, so it is in the temporal dead
    // zone here: require it inline, as the other early handlers do.
    return res.sendFile(
        require('path').join(__dirname, '..', '..', 'private', 'guides', file),
        (err) => {
            if (err && !res.headersSent) res.status(404).end();
        }
    );
});
// About / version info — full live detail of the running version.
router.get('/about', requireAuth, async (req, res) => {
    let pkg = {};
    try {
        pkg = require('../../package.json');
    } catch (_) {
        /* ignore */
    }
    const db = require('../config/database');

    // Resilient single-value query helper (returns null on any failure so this
    // page renders even against an older DB without the V3 framework tables).
    const one = async (sql) => {
        try {
            const r = await db.get(sql);
            return r ? Object.values(r)[0] : null;
        } catch (_) {
            return null;
        }
    };

    // DB name (without exposing credentials).
    let dbName = null;
    try {
        const m = String(process.env.DATABASE_URL || '').match(/\/([^/?]+)(?:\?|$)/);
        dbName = m ? m[1] : null;
    } catch (_) {
        /* ignore */
    }

    const [
        pgVersion,
        schemaCount,
        latestMigration,
        v3Loaded,
        pillars,
        subDomains,
        roleFamilies,
        skillsTotal,
        skillsStandard,
        skillsLegacy,
        junctions,
    ] = await Promise.all([
        one("SELECT split_part(version(), ',', 1) AS v"),
        one('SELECT COUNT(*)::int AS n FROM schema_meta'),
        one("SELECT key FROM schema_meta WHERE key ~ '^[0-9]' ORDER BY key DESC LIMIT 1"),
        one("SELECT value FROM schema_meta WHERE key = 'v3_framework_loaded'"),
        one('SELECT COUNT(*)::int AS n FROM domains WHERE is_active = true'),
        one('SELECT COUNT(*)::int AS n FROM sub_domains'),
        one('SELECT COUNT(*)::int AS n FROM role_families'),
        one('SELECT COUNT(*)::int AS n FROM skills WHERE is_active = true'),
        one("SELECT COUNT(*)::int AS n FROM skills WHERE source = 'standard'"),
        one("SELECT COUNT(*)::int AS n FROM skills WHERE source = 'legacy'"),
        one('SELECT COUNT(*)::int AS n FROM skill_role_families'),
    ]);

    // Technical/system internals (DB name, PG/Node version, port, environment) are
    // for admins only — a rebranded appliance must not show every employee the
    // engine under the hood. The sovereignty/framework story stays for everyone.
    const showSystem = req.user && req.user.userType === 'admin';

    // "Schema migrations 109" answered nothing about upgrade
    // readiness. Pending migrations (the runner's own rule), database size and
    // the last backup are the three numbers an operator needs before an upgrade;
    // the detail lives on /admin/health, linked from here.
    let ops = null;
    if (showSystem) {
        const HealthController = require('../controllers/HealthController');
        const [migrations, sizeBytes, backup] = await Promise.all([
            HealthController.migrationsState().catch(() => null),
            one('SELECT pg_database_size(current_database()) AS n'),
            require('../jobs/db-backup')
                .status()
                .catch(() => null),
        ]);
        ops = {
            pending: migrations ? migrations.pending : null,
            ahead: migrations ? migrations.ahead : null,
            sizeBytes: sizeBytes != null ? Number(sizeBytes) : null,
            backup: backup
                ? {
                      lastRunOn: backup.lastRunOn,
                      lastStatus: backup.lastStatus,
                      stale: backup.stale,
                  }
                : null,
            isSuperAdmin: req.user.role === 'superadmin',
        };
    }
    // Respect white-label branding for the product name.
    const brandName = (res.locals.branding && res.locals.branding.appName) || PRODUCT.name;

    // Security posture: the documented controls for everyone; the live state of
    // the switchable ones for administrators only.
    const posture = require('../config/securityPosture');
    let securityLive = null;
    if (showSystem) {
        const flag = async (fn) => {
            try {
                return await fn();
            } catch (_) {
                return null;
            }
        };
        const AppSettings = require('../models/AppSettingsModel');
        const Copilot = require('../services/CopilotService');
        securityLive = {
            https: Boolean(req.secure),
            secretsEncrypted: require('../utils/secretBox').isEnabled(),
            mfaPrivileged: await flag(() =>
                AppSettings.getValue('mfaRequiredForPrivileged', false)
            ),
            sqlConsoleOff: !require('../services/SqlConsoleService').isEnabled(),
            copilotEuOnly: await flag(() => Copilot.euOnlyProviders()),
            copilotNoRanking: await flag(async () => !(await Copilot.allowNamedPersonRanking())),
        };
    }

    res.render('pages/about', {
        security: posture.postureFor(req.language || (req.i18n && req.i18n.language) || 'fr'),
        securityTotals: posture.totals(),
        securityAsvs: posture.ASVS_L2,
        securityLive,
        title: req.t ? req.t('chrome:pt_about') : 'About',
        appName: PRODUCT.fullName,
        displayName: brandName,
        showSystem,
        version: pkg.version || 'unknown',
        description: pkg.description || '',
        nodeVersion: process.version,
        platform: `${process.platform} ${process.arch}`,
        environment: process.env.NODE_ENV || 'development',
        adoptionStage: res.locals.adoptionStage,
        modulesLegacy: res.locals.modulesLegacy,
        ssoEnabled: process.env.SSO_ENABLED === '1',
        jobsMode: process.env.REDIS_URL ? 'BullMQ (Redis)' : 'in-process scheduler',
        appPort: process.env.PORT || '3000',
        uptimeSec: Math.round(process.uptime()),
        db: {
            name: dbName,
            engine: pgVersion || 'PostgreSQL',
            migrations: schemaCount,
            latestMigration,
        },
        ops,
        framework: {
            loaded: Boolean(v3Loaded),
            loadedAt: v3Loaded || null,
            pillars,
            subDomains,
            roleFamilies,
            skillsTotal,
            skillsStandard,
            skillsLegacy,
            junctions,
        },
    });
});
router.get('/login', AuthController.showLogin);
router.post('/login', AuthController.login);
// MFA second step (identity already password-verified, parked in the session)
const { loginRateLimiter, signupRateLimiter } = require('../middleware/rateLimiter');
router.get('/login/mfa', AuthController.showMfaChallenge);
router.post('/login/mfa', loginRateLimiter, AuthController.verifyMfaChallenge);
router.post('/logout', requireAuth, AuthController.logout);

// Self-service password reset ("forgot password"). PUBLIC by definition — the
// whole point is that the person cannot log in. CSRF-protected; the POSTs are
// rate-limited and anti-enumeration (same response for any identifier).
//
// These MUST stay above `router.use(requireAuth)`. They previously sat ~300
// lines below it, carrying this very comment, which made the entire feature
// unreachable for the only people who need it: logged out, GET /forgot-password
// and GET /reset-password?token=... both 302'd to /login and the POSTs answered
// 403. The service layer underneath was correct the whole time, so nothing
// failed loudly — the door was simply locked from the inside.
router.get('/forgot-password', AuthController.showForgotPassword);
router.post('/forgot-password', loginRateLimiter, AuthController.requestPasswordReset);
router.get('/reset-password', AuthController.showResetPassword);
router.post('/reset-password', loginRateLimiter, AuthController.resetPassword);

// Multi-provider single sign-on (gated by SSO_ENABLED + per-provider config;
// :provider = entra | oidc | saml | google). The strategies no-op when off, so
// these routes simply bounce back to /login. Callbacks are exempt from CSRF +
// the same-origin guard in server.js because they are IdP-driven cross-site
// requests (OIDC `state`/`nonce` and signed SAML assertions protect the flow).
const SsoController = require('../controllers/SsoController');
// 3.23.19 (D3b / D6): « Continuer en tant que … » — the account chooser for a
// person who is also the linked person of an administrator account. Public (the
// person is not signed in yet: the choice is parked in their session), CSRF-
// protected by the global guard (not a callback), rate-limited like /login/mfa.
// MUST precede '/auth/sso/:provider', which would otherwise take 'choose' for a
// provider key.
router.get('/auth/sso/choose', SsoController.showChoice);
router.post('/auth/sso/choose', loginRateLimiter, SsoController.submitChoice);
// the one-time MFA enrolment-code step after an admin SSO sign-in.
router.get('/auth/sso/enrol-code', SsoController.showEnrolCode);
router.post('/auth/sso/enrol-code', loginRateLimiter, SsoController.submitEnrolCode);
router.get('/auth/sso/:provider', SsoController.initiate);
// SP metadata — PUBLIC (above requireAuth): the address an IdP admin downloads
// it from, which is also our entity ID. It carries nothing secret.
router.get(
    '/saml/metadata',
    require('../utils/asyncHandler')(require('../controllers/SsoSettingsController').spMetadata)
);
// Both POST (form_post / SAML ACS) and GET (query mode) callbacks are supported.
router.post('/auth/sso/:provider/callback', SsoController.callback);
router.get('/auth/sso/:provider/callback', SsoController.callback);

// Self-service onboarding — public entry points (gated at runtime by the
// onboarding.* settings; the controller bounces back to /login when disabled).
const OnboardingController = require('../controllers/OnboardingController');
router.get('/signup', OnboardingController.signupForm);
router.post('/signup', signupRateLimiter, OnboardingController.signup);
router.get('/onboarding/pending', OnboardingController.pending);

// Power BI Integration API routes (Protected by API Key, bypasses session auth)
const { requireApiKey } = require('../middleware/apiAuth');
// ASVS 3.7.1: recent sign-in or current password for sensitive actions.
const { requireRecentAuth } = require('../middleware/recentAuth');
router.get('/api/powerbi/employees', requireApiKey, ReportController.powerbIEmployees);
router.get('/api/powerbi/assessments', requireApiKey, ReportController.powerbIAssessments);
router.get('/api/powerbi/readiness', requireApiKey, ReportController.powerbIReadiness);
router.get('/api/powerbi/organization', requireApiKey, ReportController.powerbIOrganization);
router.get('/api/powerbi/ninebox', requireApiKey, ReportController.powerbINineBox);
router.get('/api/powerbi/pips', requireApiKey, ReportController.powerbIPips);
router.get('/api/powerbi/idp', requireApiKey, ReportController.powerbIIdp);
router.get('/api/powerbi/coaching', requireApiKey, ReportController.powerbICoaching);
router.get('/api/powerbi/goals', requireApiKey, ReportController.powerbIGoals);

// LMS completion webhook — PUBLIC (no session), validated by a per-provider
// shared secret. Posts application/json, which the global csurf guard skips.
// Mounted before requireAuth so external LMS callers can reach it.
router.post(
    '/integrations/lms/:provider/webhook',
    require('../utils/asyncHandler')(async (req, res) => {
        if (!(await ModuleService.isOn('development'))) return res.status(404).json({ ok: false });
        const LmsService = require('../services/LmsService');
        const provider = String(req.params.provider || '').toLowerCase();
        // Secret only via header — never from the JSON body (request bodies are
        // commonly logged by proxies / app loggers, which would leak it).
        const secret = req.get('x-webhook-secret');
        const ok = await LmsService.verifyWebhookSecret(provider, secret);
        if (!ok)
            return res.status(401).json({ ok: false, error: 'invalid or missing webhook secret' });
        try {
            const out = await LmsService.ingestWebhook(provider, req.body || {});
            return res.json({ ok: true, ...out });
        } catch (e) {
            return res.status(400).json({ ok: false, error: e.message });
        }
    })
);

/**
 * ST-2 (3.23.21): a router that fails to LOAD must say so. Every optional mount
 * below used to sit in `catch (_) {}` — a syntax error or a missing module in
 * v2-safety-gate or v2-idp-lifecycle silently removed a whole surface, and the
 * only symptom was a 404 in production. The mount stays optional (the rest of
 * the app still boots), but the failure is logged with its cause.
 */
function mountFailed(name, e) {
    console.error(`[routes] ${name} not mounted`, e);
}

// Throttle the LTI + SCIM surfaces (they live outside the /api/ prefix, so the
// global apiRateLimiter doesn't cover them). SCIM deprovisioning and LTI launches
// are unauthenticated-reachable and expensive enough to warrant a bucket.
try {
    const { apiRateLimiter } = require('../middleware/rateLimiter');
    router.use(['/lti', '/scim'], apiRateLimiter);
} catch (e) {
    mountFailed('lti/scim rate limiter', e);
}

// LTI 1.3 Platform endpoints (public: JWKS + OIDC authorization). Mounted
// before requireAuth so the LMS Tool's browser redirects can reach them.
try {
    router.use('/', require('./lti'));
} catch (e) {
    mountFailed('lti', e);
}

// SCIM 2.0 provisioning (API-key authed) — IdP-driven deprovisioning. Public path.
try {
    router.use('/', require('./scim'));
} catch (e) {
    mountFailed('scim', e);
}

// 3.23.18 — safety-competency gate: read API for access-control / permit-to-work
// systems (issued API key with the safety.read scope, or a session). Public path
// with its own auth, rate-limited like SCIM.
try {
    router.use('/v2/safety-gate/status', require('../middleware/rateLimiter').apiRateLimiter);
} catch (e) {
    mountFailed('safety-gate rate limiter', e);
}
try {
    router.use('/', require('./v2-safety-gate').apiRouter);
} catch (e) {
    mountFailed('v2-safety-gate api', e);
}

// Protected routes (require authentication)
router.use(requireAuth);

// Dashboard Routes (Importing the new modular router)
const dashboardRoutes = require('./dashboard');
router.use('/', dashboardRoutes);

// Executive decision surfaces — key-person risk, exposure by site, board pack.
// Same guard chain as the dashboard (manager/admin + RBAC scope); the
// key-person routes add a continuity-grant check of their own inside.
// Key-person risk belongs to the talent module (continuity): 404 while it is off.
router.use(['/exec/key-person', '/exec/api/key-person'], _mod('talent'));
router.use('/exec', requireManagerOrAdmin, rbacMiddleware, require('./exec'));

// Employee Portal Routes (require employee authentication)

router.get('/employee/dashboard', requireEmployeeOrManager, EmployeePortalController.dashboard);
// My OKRs & 1-on-1s — the signed-in person's own goals and check-in sessions.
// OKRs & 1:1s — engagement module (Administration → Modules).
router.get(
    '/employee/okr',
    _mod('engagement'),
    requireEmployeeOrManager,
    EmployeePortalController.myOkr
);
// « Mon développement » — the signed-in person's OWN PIP(s), IDP(s) and a
// pointer to their coaching. No :id and no query-string employee id: the
// controller keys every query on req.user.id. /v2/pip is manager/admin-only, so
// without this page a PIP notified its subject with nowhere to read the plan.
router.get(
    '/employee/my-development',
    requireEmployeeOrManager,
    EmployeePortalController.myDevelopment
);
// « Mes certifications » — where the cert-expiry ladder lands. The employee is
// alerted four times (90/60/30 days, then expired) that a certificate is running
// out, but the only certification surface, /compliance, is manager/
// manage_compliance-gated. Same identity contract as my-development: no :id and
// no query-string employee id — the controller keys everything on req.user.id.
router.get(
    '/employee/my-certifications',
    requireEmployeeOrManager,
    EmployeePortalController.myCertifications
);
// "My team": one row per DIRECT report (TeamRosterService scopes on the
// reporting line of the person behind the account). A failure to read it
// leaves `team` null, which the page says, rather than an empty team.
router.get('/supervisor/dashboard', requireManager, async (req, res) => {
    let team = null;
    try {
        team = await require('../services/TeamRosterService').forManager(req.user);
    } catch (_) {
        team = null;
    }
    res.render('pages/supervisor/dashboard', {
        title: req.t ? req.t('chrome:mgr_workspace_title') : 'Manager workspace',
        team,
    });
});

// Managers are employees too — let them complete their own self-assessment.
router.get(
    '/employee/self-assessment',
    requireEmployeeOrManager,
    EmployeePortalController.selfAssessment
);
router.post(
    '/employee/self-assessment/submit',
    requireEmployeeOrManager,
    EmployeePortalController.submitSelfAssessment
);
router.post(
    '/employee/self-assessment/save-draft',
    requireEmployeeOrManager,
    EmployeePortalController.saveDraftSelfAssessment
);
router.get(
    '/employee/supervisor-reviews',
    requireEmployeeOrManager,
    EmployeePortalController.viewSupervisorReviews
);
router.post(
    '/employee/reviews/:reviewId/dispute',
    requireEmployeeOrManager,
    EmployeePortalController.disputeReview
);

// ---- Phase 2: Self-Assessment workflow (JSON API) -------------------------
// Authorization is enforced in the service (admin inherits supervisor/manager),
// so these use requireAuth and the service returns 403 when not permitted.
// Pages
// 3.23.17: a reviewer ASSIGNED on the campaign console may be a plain employee
// account (no reports of their own) — requireAuth here; the service scopes the
// queue to their assignments and fails closed for everyone else.
router.get(
    '/supervisor/self-assessment-reviews',
    requireAuth,
    SelfAssessmentWorkflowController.reviewConsolePage
);
router.get(
    '/employee/assessment-status',
    requireEmployeeOrManager,
    SelfAssessmentWorkflowController.myStatusPage
);
// Read
router.get('/api/self-assessment/queue', requireAuth, SelfAssessmentWorkflowController.queue);
router.get(
    '/api/self-assessment/queue-by-employee',
    requireAuth,
    SelfAssessmentWorkflowController.queueByEmployee
);
router.post(
    '/api/self-assessment/employee/:employeeId/approve-all',
    requireManagerOrAnyPermission('approve_assessments'),
    SelfAssessmentWorkflowController.bulkApprove
);
// "Approve all agreed ratings for my team": same guard and the same JSON/CSRF
// contract as the per-employee approve-all above; the service loops that very
// method, agreed ratings only, re-authorising every employee and every row.
router.post(
    '/api/self-assessment/team/approve-all',
    requireManagerOrAnyPermission('approve_assessments'),
    SelfAssessmentWorkflowController.teamApproveAgreed
);
// Per-employee assessment movement timeline (employee ↔ reviewer handoffs).
router.get(
    '/api/self-assessment/employee/:id/movement',
    requireAuth,
    SelfAssessmentWorkflowController.movement
);
router.get(
    '/api/self-assessment/mine',
    requireEmployeeOrManager,
    SelfAssessmentWorkflowController.mine
);
router.get(
    '/api/self-assessment/analytics',
    requireManagerOrAdmin,
    SelfAssessmentWorkflowController.analytics
);
router.get('/api/self-assessment/:id/thread', requireAuth, SelfAssessmentWorkflowController.thread);
// Non-mutating discussion comment (does NOT move the assessment to changes_requested).
router.post(
    '/api/self-assessment/:id/comment',
    requireAuth,
    SelfAssessmentWorkflowController.comment
);
router.get('/api/self-assessment/:id/events', requireAuth, SelfAssessmentWorkflowController.events);
// "Is this e-mail address already used by another account?" — the inline
// advisory on every e-mail field (js/email-shared-check.js), signed-in users
// only. A shared address is ALLOWED (a person may hold several accounts,
// migration 107); this only tells the person typing. Names are scoped: an
// employee gets a count, a scoped admin/manager only the accounts they may see.
router.get('/api/accounts/email-check', requireAuth, async (req, res) => {
    try {
        const email = String(req.query.email || '').trim();
        if (!email || !email.includes('@')) return res.json({ count: 0, who: '', note: '' });
        const EmailAccountsService = require('../services/EmailAccountsService');
        const isAdmin = req.user && req.user.userType === 'admin';
        const isManager = req.user && req.user.userType === 'manager';
        const opts = {};
        // Exclusions: an admin/manager may exclude the record being edited; an
        // employee only ever excludes THEMSELVES (their own profile page).
        if (isAdmin || isManager) {
            if (req.query.excludeEmployee)
                opts.excludeEmployeeId = Number(req.query.excludeEmployee);
            if (isAdmin && req.query.excludeAdmin)
                opts.excludeAdminId = Number(req.query.excludeAdmin);
        } else if (req.user) {
            opts.excludeEmployeeId = Number(req.user.id);
        }
        const d = await EmailAccountsService.describe(req, email, opts);
        const note = d.count
            ? req.t
                ? req.t('admin:email_shared_note', { count: d.count, who: d.who })
                : `Already used by ${d.who} — allowed (a person may hold several accounts); check that this is intended.`
            : '';
        res.json({ count: d.count, who: d.who, note });
    } catch (e) {
        res.status(500).json({ count: 0, who: '', note: '' });
    }
});
// Employee
router.post(
    '/api/self-assessment/:id/respond',
    requireEmployeeOrManager,
    SelfAssessmentWorkflowController.respond
);
// Supervisor (or admin)
router.post(
    '/api/self-assessment/:id/open-review',
    requireAuth,
    SelfAssessmentWorkflowController.openReview
);
router.post(
    '/api/self-assessment/:id/request-changes',
    requireAuth,
    SelfAssessmentWorkflowController.requestChanges
);
router.post(
    '/api/self-assessment/:id/approve',
    requireAuth,
    SelfAssessmentWorkflowController.approve
);
router.post(
    '/api/self-assessment/:id/reject',
    requireAuth,
    SelfAssessmentWorkflowController.reject
);
// Manager (or admin)
router.post(
    '/api/self-assessment/:id/validate',
    requireAuth,
    SelfAssessmentWorkflowController.validate
);
router.post(
    '/api/self-assessment/:id/arbitrate',
    requireAuth,
    SelfAssessmentWorkflowController.arbitrate
);

// ---- Learner-facing LMS ("Mes formations") ---------------------------------
// Mounted here, NOT inside the V2 block: /v2/lms is the admin console (manager
// or configure_lms, and only while the development module is on). The learner's own list must
// exist whenever an assignment notification can be sent, which is always.
try {
    router.use('/employee', require('./v2-lms').learnerRouter);
} catch (e) {
    /* LMS module optional — but a load failure is logged (ST-2) */
    mountFailed('v2-lms learner', e);
}

// ---- Phase 3: Coaching & Mentoring plans -----------------------------------
// Part of the development module (Administration → Modules).
router.use(['/coaching/plans', '/employee/my-coaching', '/api/coaching'], _mod('development'));
router.get('/coaching/plans', requireManagerOrAdmin, CoachingPlanController.consolePage);
router.get('/employee/my-coaching', requireEmployeeOrManager, CoachingPlanController.myPage);
router.get('/api/coaching/queue', requireManagerOrAdmin, CoachingPlanController.queue);
router.get('/api/coaching/mine', requireEmployeeOrManager, CoachingPlanController.mine);
router.get('/api/coaching/monitor', requireManagerOrAdmin, CoachingPlanController.monitor);
router.get('/api/coaching/roster', requireManagerOrAdmin, CoachingPlanController.roster);
router.get(
    '/api/coaching/context/:employeeId',
    requireManagerOrAdmin,
    CoachingPlanController.contextOptions
);
router.get('/api/coaching/:id', requireAuth, CoachingPlanController.get);
router.post('/api/coaching', requireAuth, CoachingPlanController.create);
router.post('/api/coaching/:id/actions', requireAuth, CoachingPlanController.addAction);
// Authority is enforced in CoachingPlanService (plan owner or admin) — the
// route only needs authentication; requireEmployeeOrManager here blocked
// admins the service allows and 302-redirected an API call to /login.
router.post('/api/coaching/:id/progress', requireAuth, CoachingPlanController.progress);
router.post('/api/coaching/:id/session', requireAuth, CoachingPlanController.session);
router.post('/api/coaching/:id/validate', requireAuth, CoachingPlanController.validate);
// Governed: files a cancellation_requests row (reason mandatory, body.reason) for
// a different local admin to decide — never flips the plan state directly.
// See CoachingPlanService.cancelPlan → CancellationService.request.
router.post('/api/coaching/:id/cancel', requireAuth, CoachingPlanController.cancel);
router.post('/api/coaching/actions/:actionId', requireAuth, CoachingPlanController.actionUpdate);

// ---- Phase 4: 9-Box Talent Management (manager-driven, confidential) --------
// Confidential: managers/admins only — regular employees may never reach these.
// Consolidated HR oversight hub: PIPs + IDPs + coaching + calibration/bias in one view.
// These handlers await DB calls without their own try/catch, so wrap in asyncHandler
// (a bare rejection would otherwise hang the request with no response).
const asyncHandler = require('../utils/asyncHandler');
router.get('/talent/actions', requireManagerOrAdmin, asyncHandler(TalentActionsController.index));
router.get(
    '/talent/career-path',
    requireManagerOrAdmin,
    asyncHandler(TalentActionsController.careerPathPage)
);
router.get(
    '/api/talent/career-path',
    requireManagerOrAdmin,
    asyncHandler(TalentActionsController.careerPathData)
);
router.get('/api/my-actions', requireAuth, asyncHandler(TalentActionsController.myActions));
// AI companion (help panel « Assistant » tab) — every signed-in user; the
// router carries its own requireAuth, rate limit and companion.enabled switch.
router.use('/api/companion', require('./companion'));

// Employee "Mon évolution" — surfaces the mobility/aspirations/surveys/recognition
// features that were built but had no employee UI.
router.get(
    '/employee/opportunities',
    _mod('mobility', 'engagement'),
    requireAuth,
    asyncHandler(EmployeeGrowthController.page.bind(EmployeeGrowthController))
);

// ---- LOT BILAN B3 — department brief: consultable archive + cadence prefs ----
//
// Placed HERE, immediately before `/account/notifications`, for one reason: the
// `attachPrefs` line below is a res.locals provider, and Express runs layers in
// registration order — mounted after that route it would never fire, and the
// four cadence checkboxes on the shared preferences page could not render their
// real state server-side. `/account/notifications` itself is rendered by
// NotificationController, which belongs to no lot of this programme and is not
// edited by this one.
//
// The page routes sit under requireManagerOrAdmin (a supervisor carries
// `userType === 'manager'` in session, so all three audiences reach them); the
// preference route is requireAuth only, because it is the one surface the three
// roles share and nobody may be denied the ability to switch a message off.
const DeptBriefController = require('../controllers/DeptBriefController');
router.use(
    '/account/notifications',
    requireAuth,
    asyncHandler(DeptBriefController.attachPrefs.bind(DeptBriefController))
);
router.get(
    '/reports/dept-brief',
    requireManagerOrAdmin,
    asyncHandler(DeptBriefController.list.bind(DeptBriefController))
);
router.get(
    '/reports/dept-brief/:id',
    requireManagerOrAdmin,
    requireNumericParam('id'),
    asyncHandler(DeptBriefController.show.bind(DeptBriefController))
);
router.post(
    '/reports/dept-brief/:id/recompute',
    requireManagerOrAdmin,
    requireNumericParam('id'),
    asyncHandler(DeptBriefController.recompute.bind(DeptBriefController))
);
router.post(
    '/account/dept-brief-prefs',
    requireAuth,
    asyncHandler(DeptBriefController.savePrefs.bind(DeptBriefController))
);
// ---- end LOT BILAN B3 ----

// In-app Notification Centre (inbox) — complements the live Action Center bell.
router.get(
    '/api/notifications',
    requireAuth,
    asyncHandler(NotificationController.bell.bind(NotificationController))
);
router.get(
    '/notifications',
    requireAuth,
    asyncHandler(NotificationController.page.bind(NotificationController))
);
router.get(
    '/notifications/:id/go',
    requireAuth,
    asyncHandler(NotificationController.go.bind(NotificationController))
);
router.post(
    '/notifications/read-all',
    requireAuth,
    asyncHandler(NotificationController.readAll.bind(NotificationController))
);
router.get(
    '/account/notifications',
    requireAuth,
    asyncHandler(NotificationController.prefsPage.bind(NotificationController))
);
router.post(
    '/account/notifications',
    requireAuth,
    asyncHandler(NotificationController.savePrefs.bind(NotificationController))
);
// Org chart (manager / supervisor reporting lines), RBAC-scoped
router.get('/org-chart', requireManagerOrAdmin, OrgChartController.page);
router.get('/api/org-chart', requireManagerOrAdmin, (req, res) =>
    OrgChartController.data(req, res)
);

router.get('/talent/nine-box', requireManagerOrAdmin, NineBoxController.gridPage);
router.get('/api/ninebox/grid', requireManagerOrAdmin, NineBoxController.grid);
router.get('/api/ninebox/roster', requireManagerOrAdmin, NineBoxController.roster);
router.get('/api/ninebox/:id', requireManagerOrAdmin, NineBoxController.get);
router.get('/api/ninebox/:id/history', requireManagerOrAdmin, NineBoxController.history);
router.get('/api/ninebox/employee/:id/trend', requireManagerOrAdmin, NineBoxController.trend);
router.get(
    '/api/ninebox/employee/:id/suggest-position',
    requireManagerOrAdmin,
    NineBoxController.suggestPosition
);
// Every 9-box WRITE carries the manage_talent_reviews slug (managers keep it
// implicitly for their own reports). Only approve did; create/update/submit/
// reject/archive/disclose were role-shape gated, so a local admin DENIED the
// slug archived and disclosed placements (NineBoxService asked only
// isLocalAdmin && inScope).
router.post(
    '/api/ninebox',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    NineBoxController.create
);
router.post(
    '/api/ninebox/:id/update',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    NineBoxController.update
);
router.post(
    '/api/ninebox/:id/submit',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    NineBoxController.submit
);
router.post(
    '/api/ninebox/:id/approve',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    NineBoxController.approve
);
router.post(
    '/api/ninebox/:id/reject',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    NineBoxController.reject
);
router.post(
    '/api/ninebox/:id/archive',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    NineBoxController.archive
);
router.post(
    '/api/ninebox/:id/disclose',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    NineBoxController.disclose
);

// Supervisor/Manager Routes

// Supervisor Review Routes (available to managers AND admins — admins stand in
// for absent managers; requireManagerOrAdmin matches every other talent surface
// and redirects to /dashboard rather than bouncing admins to /login).
router.get('/supervisor/reviews', requireManagerOrAdmin, SupervisorReviewController.index);
router.get(
    '/supervisor/reviews/:reviewId',
    requireManagerOrAdmin,
    requireNumericParam('reviewId'),
    SupervisorReviewController.review
);
router.post(
    '/supervisor/reviews/:reviewId/complete',
    requireManagerOrAdmin,
    SupervisorReviewController.completeReview
);

router.get(
    '/supervisor/gap-analysis',
    requireManagerOrAdmin,
    SupervisorReviewController.viewGapAnalysis
);

// ---- V2 phase routers ----
// Always mounted. The optional ones sit behind their module switch
// (Administration → Modules, ModuleService.requireModule): while a module is
// off its pages answer the app's normal 404, and switching it on needs no
// restart. /v2/uam (MFA, maker-checker) and /v2/slf (self-assessment cycles,
// disputes) are CORE and never gated. V2_FEATURES=1 still forces every module
// on (legacy installs).
{
    try {
        router.use('/v2/uam', require('./v2-uam'));
    } catch (e) {
        mountFailed('v2-uam', e);
    }
    try {
        router.use('/v2/slf', require('./v2-slf'));
    } catch (e) {
        mountFailed('v2-slf', e);
    }
    try {
        router.use('/v2/idp', _mod('development'), require('./v2-idp'));
    } catch (e) {
        mountFailed('v2-idp', e);
    }
    try {
        // 3.23.17: complete / archive a plan, move an objective (IDP lifecycle).
        // Its own block: a failure here no longer takes v2-idp down with it (or
        // the other way round), and it is logged.
        router.use('/v2/idp', _mod('development'), require('./v2-idp-lifecycle'));
    } catch (e) {
        mountFailed('v2-idp-lifecycle', e);
    }
    try {
        // Confidential talent/bias data — managers/admins only.
        router.use('/v2/talent', _mod('talent'), requireManagerOrAdmin, require('./v2-talent'));
    } catch (e) {
        mountFailed('v2-talent', e);
    }
    try {
        router.use('/v2/coaching', _mod('development'), require('./v2-coaching'));
    } catch (e) {
        mountFailed('v2-coaching', e);
    }
    try {
        // Performance-improvement plans — managers/admins only.
        router.use('/v2/pip', _mod('development'), requireManagerOrAdmin, require('./v2-pip'));
    } catch (e) {
        mountFailed('v2-pip', e);
    }
    try {
        // Lifecycle/HR events — managers/admins only.
        router.use(
            '/v2/lifecycle',
            _mod('mobility'),
            requireManagerOrAdmin,
            require('./v2-lifecycle')
        );
    } catch (e) {
        mountFailed('v2-lifecycle', e);
    }
    try {
        // People continuity — managers always; local admins need a continuity grant.
        router.use(
            '/v2/continuity',
            _mod('talent'),
            requireManagerOrAnyPermission(
                'view_continuity',
                'manage_succession',
                'view_retention_risk',
                'manage_handover'
            ),
            require('./v2-continuity')
        );
    } catch (e) {
        mountFailed('v2-continuity', e);
    }
    try {
        // LMS Integration Hub — managers always; local admins need configure_lms.
        router.use(
            '/v2/lms',
            _mod('development'),
            requireManagerOrAnyPermission('configure_lms'),
            require('./v2-lms')
        );
    } catch (e) {
        mountFailed('v2-lms', e);
    }
    try {
        // Capability expansion: calibration, goal cascade, mobility, surveys,
        // recognition, DEI, skills graph, outbound webhooks, GDPR DSR.
        // Each sub-path belongs to one module (config/modules.js CAP_PATHS);
        // GDPR DSR, webhooks and the skills graph are core.
        router.use('/v2/cap', ModuleService.capGuard(), require('./v2-capability'));
    } catch (e) {
        mountFailed('v2-capability', e);
    }
}

// Home Route
router.get('/', (req, res) => {
    // Land each role on a screen appropriate to them.
    const u = req.user || {};
    if (u.userType === 'employee') return res.redirect('/employee/dashboard');
    if (u.userType === 'manager') return res.redirect('/supervisor/dashboard');
    // Admins land on the DASHBOARD, not the employee list. The list is one
    // operational screen among many (and is now gated on `view_employees`), so
    // sending every admin there made the product open on a wall of staff PII —
    // and 403'd any admin delegated only configuration or reporting work.
    // /dashboard is the module hub and already renders the zero-data case.
    return res.redirect('/dashboard');
});

// Language switcher — sets the i18next detection cookie and bounces back.
router.get('/lang/:lng', (req, res) => {
    const lng = req.params.lng === 'en' ? 'en' : 'fr';
    res.cookie('lang', lng, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    // Only bounce to a same-origin relative path (no open redirect).
    res.redirect(safeBackUrl(req, '/'));
});

// Change Password
router.get('/change-password', AuthController.showChangePassword);
router.post('/change-password', AuthController.changePassword);

// Session monitoring is an ADMIN capability: admins review their own device
// list at /account/sessions, and SuperAdmins get the platform-wide monitor
// with per-session force-close. (Password change still auto-revokes other
// sessions for everyone, and idle timeout applies to all users.)
// Self-service "my devices/sessions" — available to EVERY signed-in user (admins,
// managers AND employees). The controller + SessionService are user-type-generic
// (scoped to req.user), so each person only ever sees and revokes their OWN sessions.
// « Mon profil » — the missing member of the /account family. Every signed-in
// person can READ their own record here; an employee/manager can correct their
// own EMAIL and PHONE and nothing else (role, site, department, service,
// supervisor, employee number, username and all competency data are read-only
// and are never read from the request body). Behind requireAuth, like its
// siblings. The email set here is the address the self-service password reset
// depends on — before this route, an employee had no way to provide one.
router.get('/account', requireAuth, asyncHandler(AuthController.showProfile.bind(AuthController)));
router.post(
    '/account',
    requireAuth,
    require('../middleware/rateLimiter').accountReauthLimiter,
    asyncHandler(AuthController.updateProfile.bind(AuthController))
);
router.get('/account/sessions', requireAuth, AuthController.showSessions);
router.post('/account/sessions/revoke-others', requireAuth, AuthController.revokeOtherSessions);
// « Mon accès » — self-service read of one's OWN scope + capabilities. The
// counterpart to the explanatory 403: an admin can check what they hold before
// hitting a wall. Admins only (the controller bounces employees/managers to
// their dashboard); every query inside is keyed on req.user.id.
const MyAccessController = require('../controllers/MyAccessController');
router.get(
    '/mon-acces',
    requireAuth,
    asyncHandler(MyAccessController.page.bind(MyAccessController))
);

router.get('/admin/sessions', requireSuperAdmin, AuthController.adminSessions.bind(AuthController));
router.post(
    '/admin/sessions/revoke',
    requireSuperAdmin,
    AuthController.adminRevokeSession.bind(AuthController)
);

// Privileged-access review / attestation (superadmin governance)
const AccessReviewController = require('../controllers/AccessReviewController');
const _ahAR = require('../utils/asyncHandler');
router.get(
    '/admin/access-review',
    requireSuperAdmin,
    _ahAR(AccessReviewController.page.bind(AccessReviewController))
);
router.get(
    '/admin/access-review/export.csv',
    requireSuperAdmin,
    _ahAR(AccessReviewController.exportCsv.bind(AccessReviewController))
);
router.post(
    '/admin/access-review/:id/attest',
    requireSuperAdmin,
    _ahAR(AccessReviewController.attest.bind(AccessReviewController))
);

// SSO migration — bulk remap of existing employees onto SSO identities
// (migration 144). SuperAdmin only, like the SSO settings themselves.
const SsoMigrationController = require('../controllers/SsoMigrationController');
const _smc = (fn) => _ahAR(fn.bind(SsoMigrationController));
router.get('/admin/sso-migration', requireSuperAdmin, _smc(SsoMigrationController.page));
router.get(
    '/admin/sso-migration/template.csv',
    requireSuperAdmin,
    _smc(SsoMigrationController.template)
);
router.get(
    '/admin/sso-migration/unmapped.csv',
    requireSuperAdmin,
    _smc(SsoMigrationController.unmappedCsv)
);
router.get(
    '/admin/sso-migration/pending.csv',
    requireSuperAdmin,
    _smc(SsoMigrationController.pendingCsv)
);
router.get(
    '/admin/sso-migration/employees',
    requireSuperAdmin,
    _smc(SsoMigrationController.searchEmployees)
);
router.post(
    '/admin/sso-migration/preview',
    requireSuperAdmin,
    require('express').json({ limit: '10mb' }), // parsed only once the caller is a SuperAdmin (server.js)
    _smc(SsoMigrationController.preview)
);
router.post('/admin/sso-migration/apply', requireSuperAdmin, _smc(SsoMigrationController.apply));
router.post(
    '/admin/sso-migration/batches/:id/undo',
    requireSuperAdmin,
    _smc(SsoMigrationController.undo)
);

// Maintenance — the SuperAdmin's way back out of a record raised in error
// (IDP, PIP, 9-box position, employee record). Every action is reasoned,
// reversible in principle, and written to system_logs + the movement feed.
// SuperAdmin-only at the route AND re-checked in the service, because this
// path deliberately bypasses the two-person cancellation rule.
const MaintenanceController = require('../controllers/MaintenanceController');
router.get(
    '/admin/maintenance',
    requireSuperAdmin,
    _ahAR(MaintenanceController.page.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/cancel-plan',
    requireSuperAdmin,
    _ahAR(MaintenanceController.cancelPlan.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/cancel-assessment',
    requireSuperAdmin,
    _ahAR(MaintenanceController.cancelAssessment.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/reopen-assessment',
    requireSuperAdmin,
    _ahAR(MaintenanceController.reopenAssessment.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/withdraw-review',
    requireSuperAdmin,
    _ahAR(MaintenanceController.withdrawReview.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/cancel-placement',
    requireSuperAdmin,
    _ahAR(MaintenanceController.cancelPlacement.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/void-employee',
    requireSuperAdmin,
    _ahAR(MaintenanceController.voidEmployee.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/restore-employee',
    requireSuperAdmin,
    _ahAR(MaintenanceController.restoreEmployee.bind(MaintenanceController))
);

// ---- SECTION campaigns — Campaign console (assessment cycles) ----------------------------
// Reads are open to a manager (scoped to the people they govern) or an admin
// holding 'manage_cycles'. Three write tiers (design review, open question 1
// default): LIFECYCLE (create/edit/launch/extend/reopen/lock/close/cancel) is
// SuperAdmin-only — a site-scoped admin must not fire or end a company-wide
// campaign; ROSTER control (excuse / re-include / reviewer) needs
// manage_cycles and is scoped in the service; CHASING is open to managers for
// their own reports. The lifecycle guard answers fetch callers with a JSON 403.
const CycleController = require('../controllers/CycleController');
const _ahCYC = require('../utils/asyncHandler');
const _cycRead = requireManagerOrAnyPermission('manage_cycles');
const _cycWrite = requirePermission('manage_cycles');
const _cycLifecycle = CycleController.constructor.requireLifecycle;
const _cycNudge = CycleController.constructor.requireNudge;
// The campaign console is the campaigns module (on in every adoption stage;
// only a custom choice switches it off).
router.use('/cycles', _mod('campaigns'));
router.get('/cycles', _cycRead, _ahCYC(CycleController.index.bind(CycleController)));
router.get('/cycles/new', _cycLifecycle, _ahCYC(CycleController.newForm.bind(CycleController)));
router.post('/cycles', _cycLifecycle, _ahCYC(CycleController.create.bind(CycleController)));
router.get(
    '/cycles/running.json',
    _cycRead,
    _ahCYC(CycleController.runningJson.bind(CycleController))
);
router.get('/cycles/:id(\\d+)', _cycRead, _ahCYC(CycleController.show.bind(CycleController)));
router.get(
    '/cycles/:id(\\d+)/edit',
    _cycLifecycle,
    _ahCYC(CycleController.editForm.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)',
    _cycLifecycle,
    _ahCYC(CycleController.update.bind(CycleController))
);
router.get(
    '/cycles/:id(\\d+)/export.csv',
    _cycRead,
    _ahCYC(CycleController.exportCsv.bind(CycleController))
);
router.get(
    '/cycles/:id(\\d+)/roster.json',
    _cycRead,
    _ahCYC(CycleController.rosterJson.bind(CycleController))
);
// Previews the company-wide headcount a launch would contact — gated like the launch.
router.get(
    '/cycles/:id(\\d+)/relaunch-preview',
    _cycLifecycle,
    _ahCYC(CycleController.relaunchPreview.bind(CycleController))
);
// DELIBERATE human actions — they start, extend, reopen or end a campaign. Confirmed in the UI and audited.
router.post(
    '/cycles/:id(\\d+)/relaunch',
    _cycLifecycle,
    _ahCYC(CycleController.relaunch.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)/reopen',
    _cycLifecycle,
    _ahCYC(CycleController.reopen.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)/extend',
    _cycLifecycle,
    _ahCYC(CycleController.extend.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)/lock',
    _cycLifecycle,
    _ahCYC(CycleController.lock.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)/cancel',
    _cycLifecycle,
    _ahCYC(CycleController.cancel.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)/close',
    _cycLifecycle,
    _ahCYC(CycleController.close.bind(CycleController))
);
// PERSON-level roster changes only. There is no skill-level equivalent, by design.
router.post(
    '/cycles/:id(\\d+)/participants/exclude-bulk',
    _cycWrite,
    _ahCYC(CycleController.excludeBulk.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)/participants/:employeeId(\\d+)/exclude',
    _cycWrite,
    _ahCYC(CycleController.exclude.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)/participants/:employeeId(\\d+)/include',
    _cycWrite,
    _ahCYC(CycleController.include.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)/participants/:employeeId(\\d+)/reviewer',
    _cycWrite,
    _ahCYC(CycleController.assignReviewer.bind(CycleController))
);
// Chase: a manager for their reports, an admin for their clearance.
router.post(
    '/cycles/:id(\\d+)/nudge',
    _cycNudge,
    _ahCYC(CycleController.nudge.bind(CycleController))
);
// ---- end SECTION campaigns ----------------------------------------------------------------

// ---- SECTION campaign-rules — campaign lifecycle: A5 (reopen a CLOSED campaign), A6
//      (off-campaign measurement), A8 (an overdue campaign is PROPOSED for
//      closure, never closed on its own). Same three tiers as reopening a
//      closed campaign and deciding a closure proposal end/restart a company-wide
//      campaign, so they are SuperAdmin-only; the two reads follow the console.
router.post(
    '/cycles/:id(\\d+)/reopen-closed',
    _cycLifecycle,
    _ahCYC(CycleController.reopenClosed.bind(CycleController))
);
router.post(
    '/cycles/:id(\\d+)/closure-proposal/decide',
    _cycLifecycle,
    _ahCYC(CycleController.decideClosureProposal.bind(CycleController))
);
router.get(
    '/cycles/off-campaign.json',
    _cycRead,
    _ahCYC(CycleController.offCampaignJson.bind(CycleController))
);
router.get(
    '/cycles/:id(\\d+)/write-gate.json',
    _cycRead,
    _ahCYC(CycleController.writeGateJson.bind(CycleController))
);
// ---- end SECTION campaign-rules ------------------------------------------------------------

// ---- la demande de modification, et l'annulation par le superviseur.
//      Règle du propriétaire : l'employé modifie librement en brouillon ou quand une
//      nouvelle campagne le redemande ; au-delà il DEMANDE. Le superviseur/manager
//      ANNULE directement tant que ce n'est pas validé ; au-delà il DEMANDE aussi.
//      Toutes ces routes sont ouvertes à un compte authentifié : c'est le service qui
//      résout l'autorité sur la PERSONNE concernée (un administrateur hors périmètre
//      est refusé par une phrase, jamais par une page blanche).
const AssessmentChangeRequestController = require('../controllers/AssessmentChangeRequestController');
const _ahACR = require('../utils/asyncHandler');
router.get('/assessment-changes', requireAuth, _ahACR(AssessmentChangeRequestController.page));
router.post(
    '/assessment-changes/raise',
    requireAuth,
    _ahACR(AssessmentChangeRequestController.raiseForm)
);
router.post(
    '/assessment-changes/cancel',
    requireAuth,
    _ahACR(AssessmentChangeRequestController.cancelForm)
);
router.post(
    '/assessment-changes/:id(\\d+)/decide',
    requireAuth,
    _ahACR(AssessmentChangeRequestController.decideForm)
);
router.post(
    '/assessment-changes/:id(\\d+)/withdraw',
    requireAuth,
    _ahACR(AssessmentChangeRequestController.withdrawForm)
);
router.get('/api/assessment-changes/mine', requireAuth, AssessmentChangeRequestController.mine);
router.get(
    '/api/assessment-changes/queue',
    requireManagerOrAdmin,
    AssessmentChangeRequestController.queue
);
router.get(
    '/api/self-assessment/:id(\\d+)/change-requests',
    requireAuth,
    AssessmentChangeRequestController.forAssessment
);
router.post(
    '/api/self-assessment/:id(\\d+)/change-request',
    requireAuth,
    AssessmentChangeRequestController.create
);
router.post(
    '/api/self-assessment/:id(\\d+)/cancel',
    requireAuth,
    AssessmentChangeRequestController.cancel
);
router.post(
    '/api/assessment-changes/:id(\\d+)/grant',
    requireAuth,
    AssessmentChangeRequestController.grant
);
router.post(
    '/api/assessment-changes/:id(\\d+)/refuse',
    requireAuth,
    AssessmentChangeRequestController.refuse
);
// ---- ----------------------------------------------------------

// Optional modules & adoption stage (superadmin) — the switches that replace
// the old boot-time V2_FEATURES gate. Audit-logged; no restart needed.
const ModulesController = require('../controllers/ModulesController');
router.get(
    '/admin/modules',
    requireSuperAdminPage,
    _ahAR(ModulesController.page.bind(ModulesController))
);
router.post(
    '/admin/modules',
    requireSuperAdmin,
    _ahAR(ModulesController.save.bind(ModulesController))
);

// Appliance license & entitlement (superadmin)
const LicenseController = require('../controllers/LicenseController');
router.get(
    '/admin/license',
    requireSuperAdmin,
    _ahAR(LicenseController.page.bind(LicenseController))
);
router.post(
    '/admin/license',
    requireSuperAdmin,
    _ahAR(LicenseController.save.bind(LicenseController))
);

// Employees
//
// READING staff is now its own withholdable capability. Until now the directory
// and the individual record were gated on role SHAPE alone (requireManagerOrAdmin
// / nothing), so every local admin — including one delegated purely configuration
// or reporting work, and every zero-permission account — could read the PII of
// everyone inside their scope. `view_employees` closes that. It is IMPLIED BY
// edit_employees and manage_employees (config/permissions.js), so every admin who
// already had a reason to reach these pages keeps reaching them with no re-grant
// and no data migration. The SCOPE checks are untouched: requireEmployeeRead only
// decides WHETHER the caller may read employees at all; checkEmployeeAccess /
// RBACService still decide WHICH ones.
const _requireEmployeeReadPerm = requireManagerOrAnyPermission('view_employees');
/**
 * Employee READ guard. Managers pass (their span of control is the scope check);
 * a self-service EMPLOYEE also passes so that opening one's OWN record keeps
 * working exactly as before — checkEmployeeAccess already restricts them to
 * themselves. Admins must hold `view_employees`.
 */
const requireEmployeeRead = (req, res, next) => {
    const t = req.user && req.user.userType;
    if (req.isAuthenticated() && (t === 'employee' || t === 'manager')) return next();
    return _requireEmployeeReadPerm(req, res, next);
};
router.get('/employees', _requireEmployeeReadPerm, EmployeeController.index);
router.get('/employees/create', requirePermission('edit_employees'), EmployeeController.createForm);
router.post(
    '/employees',
    requirePermission('edit_employees'),
    employeeValidation,
    EmployeeController.create
);
router.get(
    '/employees/:id',
    requireEmployeeRead,
    requireNumericParam('id'),
    checkEmployeeReadAccess, // read: also an admin's directly-designated reports
    EmployeeController.show
);
// Managers may edit the employees they govern (their span of control) — the
// per-target check is checkEmployeeAccess (findGovernedIds). Admins still need
// the edit_employees grant. Create/delete/credentials remain admin-only.
router.get(
    '/employees/:id/edit',
    requireManagerOrAnyPermission('edit_employees'),
    requireNumericParam('id'),
    checkEmployeeAccess,
    EmployeeController.editForm
);
router.post(
    '/employees/:id',
    requireManagerOrAnyPermission('edit_employees'),
    employeeValidation,
    checkEmployeeAccess,
    EmployeeController.update
);
// Quick supervisor assignment (inline control on the employee list). Managers
// may only assign themselves or someone in their governed span (enforced in
// the controller); admins need the edit_employees grant.
router.post(
    '/employees/:id/supervisor',
    requireManagerOrAnyPermission('edit_employees'),
    checkEmployeeAccess,
    EmployeeController.setSupervisor
);
router.post(
    '/employees/:id/delete',
    requirePermission('edit_employees'),
    checkEmployeeAccess,
    EmployeeController.delete
);
// (the dead `/employees/:id/activate-account` and
// `/employees/:id/reset-password` endpoints were removed — no view used them;
// `/employees/:id/credentials` below is the one credential-writing primitive.)
// Set/choose username AND/OR password for an existing or new account. Sensitive
// (sets credentials) so it needs reset_employee_password; scope still enforced.
router.post(
    '/employees/:id/credentials',
    requirePermission('reset_employee_password'),
    checkEmployeeAccess,
    EmployeeController.setCredentials
);

// Assessments
router.get(
    '/employees/:id/assessments',
    requireEmployeeRead,
    requireNumericParam('id'),
    checkEmployeeAccess,
    AssessmentController.show
);
router.post(
    '/employees/:id/assessments',
    requirePermission('manage_assessments'),
    checkEmployeeAccess,
    assessmentValidation,
    AssessmentController.update
);
router.post(
    '/employees/:id/assessments/bulk',
    requirePermission('manage_assessments'),
    checkEmployeeAccess,
    AssessmentController.bulkUpdate
);
router.get(
    '/employees/:id/assessments/history',
    requireEmployeeRead,
    requireNumericParam('id'),
    checkEmployeeAccess,
    AssessmentController.history
);
router.get(
    '/employees/:id/development',
    requireEmployeeRead,
    requireNumericParam('id'),
    checkEmployeeAccess,
    asyncHandler(TalentActionsController.employeeDevelopment)
);
router.get(
    '/employees/:id/timeline',
    requireEmployeeRead,
    requireNumericParam('id'),
    checkEmployeeAccess,
    asyncHandler(TalentActionsController.employeeTimeline)
);
router.get(
    '/employees/:id/assessments/history/:skillId',
    requireEmployeeRead,
    requireNumericParam('id'),
    checkEmployeeAccess,
    AssessmentController.history
);

// Account access & identity: merge an SSO identity onto an employee, or promote
// the employee to an admin. Guarded by manage_admins; the service applies the
// finer rule (promote-to-admin is SuperAdmin-only).
router.post(
    '/employees/:id/sso-link',
    requirePermission('manage_admins'),
    EmployeeController.linkSso
);
router.post(
    '/employees/:id/sso-unlink',
    requirePermission('manage_admins'),
    EmployeeController.unlinkSso
);
router.post(
    '/employees/:id/identity/remove',
    requirePermission('manage_admins'),
    EmployeeController.removeIdentity
);
router.post(
    '/employees/:id/password-auth',
    requirePermission('manage_admins'),
    EmployeeController.setPasswordAuth
);
router.post(
    '/employees/:id/grant-admin',
    requirePermission('manage_admins'),
    EmployeeController.grantAdmin
);

// Organization (Unified page with tabs) — manager/admin only, matching the
// /employees list guard. The page exposes whole-org site/department dropdown
// data, so it must not be reachable by regular employees.
router.get('/organization', requireManagerOrAdmin, OrganizationController.index);
// Keep individual routes for backward compatibility and direct access
router.get('/organization/sites', requireManagerOrAdmin, OrganizationController.sitesIndex);
router.get(
    '/organization/departments',
    requireManagerOrAdmin,
    OrganizationController.departmentsIndex
);
router.get('/organization/services', requireManagerOrAdmin, OrganizationController.servicesIndex);
// CRUD operations
router.post(
    '/organization/sites',
    requirePermission('manage_organization'),
    siteValidation,
    OrganizationController.sitesCreate
);
router.post(
    '/organization/sites/:id',
    requirePermission('manage_organization'),
    siteValidation,
    OrganizationController.sitesUpdate
);
router.post(
    '/organization/sites/:id/delete',
    requirePermission('manage_organization'),
    OrganizationController.sitesDelete
);
// Geography: create a country (with its region) so sites can be assigned an operating
// country — this is what drives the Local Content national/expatriate classification.
router.post(
    '/organization/countries',
    requirePermission('manage_organization'),
    OrganizationController.countriesCreate
);

router.post(
    '/organization/departments',
    requirePermission('manage_organization'),
    departmentValidation,
    OrganizationController.departmentsCreate
);
router.post(
    '/organization/departments/:id',
    requirePermission('manage_organization'),
    departmentValidation,
    OrganizationController.departmentsUpdate
);
router.post(
    '/organization/departments/:id/delete',
    requirePermission('manage_organization'),
    OrganizationController.departmentsDelete
);

router.post(
    '/organization/services',
    requirePermission('manage_organization'),
    serviceValidation,
    OrganizationController.servicesCreate
);
router.post(
    '/organization/services/:id',
    requirePermission('manage_organization'),
    serviceValidation,
    OrganizationController.servicesUpdate
);
router.post(
    '/organization/services/:id/delete',
    requirePermission('manage_organization'),
    OrganizationController.servicesDelete
);

// Domains & Skills (delegatable: manage_domains_skills)
router.get('/domains-skills', requirePermission('view_domains_skills'), DomainController.index);
// Legacy routes for backward compatibility
// Legacy standalone Domains/Skills pages were English duplicates of the canonical
// Framework hub, and the /skills create modal produced orphan skills (no sub-domain).
// Redirect the GETs to the localized hub; keep the POST endpoints below.
router.get('/domains', requirePermission('view_domains_skills'), (req, res) =>
    res.redirect('/domains-skills?tab=domains')
);
router.get('/skills', requirePermission('view_domains_skills'), (req, res) =>
    res.redirect('/domains-skills?tab=skills')
);
// CRUD operations
router.post(
    '/domains',
    requirePermission('manage_domains_skills'),
    domainValidation,
    DomainController.create
);
router.post(
    '/domains/:id',
    requirePermission('manage_domains_skills'),
    domainValidation,
    DomainController.update
);
router.post(
    '/domains/:id/delete',
    requirePermission('manage_domains_skills'),
    DomainController.delete
);

// Sub-Domains (Competency Elements) — the middle tier: Domain → Sub-Domain → Skill
router.post('/subdomains', requirePermission('manage_domains_skills'), SubDomainController.create);
router.post(
    '/subdomains/:id',
    requirePermission('manage_domains_skills'),
    SubDomainController.update
);
router.post(
    '/subdomains/:id/delete',
    requirePermission('manage_domains_skills'),
    SubDomainController.delete
);

router.post(
    '/skills',
    requirePermission('manage_domains_skills'),
    skillValidation,
    SkillController.create
);
router.post(
    '/skills/:id',
    requirePermission('manage_domains_skills'),
    skillValidation,
    SkillController.update
);
router.post(
    '/skills/:id/delete',
    requirePermission('manage_domains_skills'),
    SkillController.delete
);

// « Qualité du référentiel » (3.23.21, D12/D13): skill descriptions, level anchors,
// description proposals and their Excel round-trip. Admin-only (requirePermission
// refuses every non-admin), so an employee can never reach a proposal.
const SkillQualityController = require('../controllers/SkillQualityController');
const _sqUpload = require('multer')({
    storage: require('multer').memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, /\.xlsx$/i.test(file.originalname || '')),
});
const _sqManage = requirePermission('manage_domains_skills');
router.get(
    '/framework/quality',
    requirePermission('view_domains_skills'),
    SkillQualityController.page
);
router.get(
    '/framework/quality/export.xlsx',
    requirePermission('view_domains_skills'),
    SkillQualityController.exportXlsx
);
// Multipart: the CSRF token travels in the x-csrf-token header (sent by the
// page script skill-quality.js) — the global CSRF check still runs and fails closed.
router.post(
    '/framework/quality/import',
    _sqManage,
    _sqUpload.single('file'),
    SkillQualityController.importXlsx
);
router.post('/framework/quality/load-starter', _sqManage, SkillQualityController.loadStarter);
router.post('/framework/proposals/bulk-approve', _sqManage, SkillQualityController.bulkApprove);
router.post('/framework/proposals/:id', _sqManage, SkillQualityController.update);
router.post('/framework/proposals/:id/approve', _sqManage, SkillQualityController.approve);
router.post('/framework/proposals/:id/reject', _sqManage, SkillQualityController.reject);

// Skills library: sector packs and the ESCO import (dry run → confirm). Writes
// the framework, so every route — the page included — needs manage_domains_skills
// (a SuperAdmin holds it implicitly).
const FrameworkLibraryController = require('../controllers/FrameworkLibraryController');
const _libUpload = require('multer')({
    storage: require('multer').memoryStorage(),
    limits: {
        fileSize: (Number(process.env.ESCO_UPLOAD_MAX_MB) || 30) * 1024 * 1024,
        files: 5,
    },
    fileFilter: (req, file, cb) => cb(null, /\.(csv|zip)$/i.test(file.originalname || '')),
});
// multer rejects an oversized upload with an error; answer it as JSON like the
// rest of the upload endpoint instead of the generic error page.
const _libUploadMw = (req, res, next) =>
    _libUpload.array('files', 5)(req, res, (err) => {
        if (!err) return next();
        return res.status(400).json({
            ok: false,
            code: 'upload_refused',
            message: req.t ? req.t('framework:lib_esco_err_upload') : 'Upload refused',
        });
    });
router.get('/framework/library', _sqManage, FrameworkLibraryController.page);
router.post(
    '/framework/library/packs/:id/dry-run',
    _sqManage,
    FrameworkLibraryController.packDryRun
);
router.post(
    '/framework/library/packs/:id/commit',
    _sqManage,
    FrameworkLibraryController.packCommit
);
// Multipart: the CSRF token travels in the x-csrf-token header (sent by the page
// script framework-library.js) — the global CSRF check still runs and fails closed.
router.post(
    '/framework/library/esco/upload',
    _sqManage,
    _libUploadMw,
    FrameworkLibraryController.escoUpload
);
router.post('/framework/library/esco/dry-run', _sqManage, FrameworkLibraryController.escoDryRun);
router.post('/framework/library/esco/commit', _sqManage, FrameworkLibraryController.escoCommit);
router.post('/framework/library/esco/discard', _sqManage, FrameworkLibraryController.escoDiscard);

// Roles (delegatable: manage_roles)
router.get('/roles', requirePermission('view_roles'), RoleController.index);
router.get('/roles/:id', requirePermission('view_roles'), RoleController.show);
router.post('/roles', requirePermission('manage_roles'), roleValidation, RoleController.create);
router.post('/roles/:id', requirePermission('manage_roles'), roleValidation, RoleController.update);
router.post('/roles/:id/duplicate', requirePermission('manage_roles'), RoleController.duplicate);
router.post('/roles/:id/delete', requirePermission('manage_roles'), RoleController.delete);
router.post(
    '/roles/:id/requirements',
    requirePermission('manage_roles'),
    RoleController.addRequirement
);
router.post(
    '/roles/:id/requirements/:requirementId',
    requirePermission('manage_roles'),
    RoleController.updateRequirement
);
router.post(
    '/roles/:id/requirements/:requirementId/delete',
    requirePermission('manage_roles'),
    RoleController.removeRequirement
);

// App Settings (delegatable: manage_app_settings)
router.get('/app-settings', requirePermission('view_app_settings'), AppSettingsController.index);
router.post(
    '/app-settings',
    requirePermission('manage_app_settings'),
    AppSettingsController.update
);
router.post(
    '/app-settings/reset',
    requirePermission('manage_app_settings'),
    AppSettingsController.reset
);
router.post(
    '/app-settings/test-email',
    requirePermission('manage_app_settings'),
    AppSettingsController.testEmail
);
router.post(
    '/app-settings/test-copilot',
    requirePermission('manage_app_settings'),
    AppSettingsController.testCopilot
);
// White-label branding (logo/favicon are small images → dedicated multer instance).
const brandUpload = require('multer')({
    dest: require('path').join(__dirname, '../../tmp'),
    fileFilter: (req, file, cb) => {
        const ok = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'].includes(
            require('path').extname(file.originalname).toLowerCase()
        );
        cb(ok ? null : new Error('Images only (PNG, JPG, WEBP, SVG, ICO)'), ok);
    },
    limits: { fileSize: 512 * 1024 },
});
router.post(
    '/app-settings/branding',
    requirePermission('manage_app_settings'),
    brandUpload.fields([
        { name: 'logoFile', maxCount: 1 },
        { name: 'faviconFile', maxCount: 1 },
    ]),
    AppSettingsController.updateBranding
);
router.post(
    '/app-settings/branding/reset',
    requirePermission('manage_app_settings'),
    AppSettingsController.resetBranding
);
// Cached branding assets — served once and browser-cached (the ?v= hash busts on
// change) instead of inlining ~800KB of base64 into every page. Public: a company
// logo/favicon is shown on the login page too, so no auth is required.
const _serveBrandingAsset = (kind) => async (req, res) => {
    try {
        const dataUrl = await require('../utils/branding').getAssetDataUrl(kind);
        if (!dataUrl) return res.status(404).end();
        const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
        if (!m) return res.status(404).end();
        const buf = Buffer.from(m[2], 'base64');
        const etag =
            '"' + require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"';
        if (req.headers['if-none-match'] === etag) return res.status(304).end();
        res.setHeader('Content-Type', m[1]);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('ETag', etag);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // ASVS 5.2.7 / 12.5.2: an uploaded SVG opened directly (not through
        // <img>) must stay an inert picture. The upload filter is a blocklist;
        // this policy is the allowlist: no script, no event handler, no fetch.
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"
        );
        return res.end(buf);
    } catch (e) {
        return res.status(500).end();
    }
};
router.get('/branding/logo', _serveBrandingAsset('logo'));
router.get('/branding/favicon', _serveBrandingAsset('favicon'));

// Single Sign-On management (SuperAdmin only — controls how users authenticate).
const SsoSettingsController = require('../controllers/SsoSettingsController');
router.get('/app-settings/sso', requireSuperAdmin, SsoSettingsController.index);
router.post('/app-settings/sso', requireSuperAdmin, SsoSettingsController.update);
router.post('/app-settings/sso/test', requireSuperAdmin, SsoSettingsController.test);
// SSO facilitator (phase 1): IdP metadata import + no-session test sign-in.
const _ahSso = require('../utils/asyncHandler');
router.post(
    '/app-settings/sso/saml/metadata/preview',
    requireSuperAdmin,
    _ahSso(SsoSettingsController.metadataPreview)
);
router.post(
    '/app-settings/sso/saml/metadata/apply',
    requireSuperAdmin,
    _ahSso(SsoSettingsController.metadataApply)
);
router.get(
    '/app-settings/sso/test-signin/:provider',
    requireSuperAdmin,
    _ahSso(SsoSettingsController.testSignin)
);
router.get(
    '/app-settings/sso/test-result/:nonce',
    requireSuperAdmin,
    _ahSso(SsoSettingsController.testResult)
);
// EXC (3.23.21): an employee's SSO exception — SuperAdmin only, audited.
router.post(
    '/employees/:id/sso-exception',
    requireSuperAdmin,
    requireNumericParam('id'),
    _ahSso(SsoSettingsController.setEmployeeException)
);

// Onboarding queue — review and place self-onboarded users (manage_onboarding).
router.get('/onboarding', requirePermission('manage_onboarding'), OnboardingController.queue);
router.post(
    '/onboarding/:id/approve',
    requirePermission('manage_onboarding'),
    OnboardingController.approve
);
router.post(
    '/onboarding/:id/merge',
    requirePermission('manage_onboarding'),
    OnboardingController.merge
);
router.post(
    '/onboarding/:id/reject',
    requirePermission('manage_onboarding'),
    OnboardingController.reject
);

// Admin Management (delegatable: manage_admins — guarded so a delegate cannot
// touch SuperAdmins or escalate beyond their own grants; see AdminController).
router.get('/admins', requirePermission('manage_admins'), AdminController.index);
// Delegation of authority — the READABLE view of who holds what, over whom.
// /admins/:id is an edit form; this answers the governance questions instead.
const DelegationController = require('../controllers/DelegationController');
router.get(
    '/admin/delegation',
    requirePermission('manage_admins'),
    _ahAR(DelegationController.page.bind(DelegationController))
);
router.get('/admins/create', requirePermission('manage_admins'), AdminController.createForm);
// every /admins/:id* route takes a NUMERIC id. `POST /admins/create`
// used to fall through to the UPDATE handler and answer « Erreur lors de la mise à
// jour de l'administrateur » for a create attempt; it is a 404 now.
router.get('/admins/:id(\\d+)', requirePermission('manage_admins'), AdminController.show);
// ASVS 3.7.1: granting SuperAdmin (a new SuperAdmin account, or promoting an
// existing one) needs a recent sign-in or the granter's current password.
const _grantsSuperadmin = async (req) => {
    if (!req.body || req.body.role !== 'superadmin') return false;
    if (!req.params.id) return true;
    const target = await require('../models/AdminModel').findById(Number(req.params.id));
    return !target || target.role !== 'superadmin';
};
const _superadminGrantReauth = requireRecentAuth({
    when: _grantsSuperadmin,
    action: 'SuperAdmin grant',
    redirectTo: (req) => (req.params.id ? `/admins/${Number(req.params.id)}` : '/admins/create'),
});
router.post(
    '/admins',
    requirePermission('manage_admins'),
    _superadminGrantReauth,
    adminValidation,
    AdminController.create
);
router.post(
    '/admins/:id(\\d+)',
    requirePermission('manage_admins'),
    _superadminGrantReauth,
    adminUpdateValidation,
    AdminController.update
);
router.post(
    '/admins/:id(\\d+)/reset-password',
    requirePermission('manage_admins'),
    AdminController.resetPassword
);
router.post(
    '/admins/:id(\\d+)/unlock',
    requirePermission('manage_admins'),
    AdminController.unlockAccount
);
router.post(
    '/admins/:id(\\d+)/force-password-change',
    requirePermission('manage_admins'),
    AdminController.forcePasswordChange
);
router.post(
    '/admins/:id(\\d+)/workspace',
    requirePermission('manage_admins'),
    AdminController.updateWorkspace
);
// Re-certify a delegated account: push its access window out 12 months on BOTH
// admin_permissions and admin_scopes in one transaction (see extendAccess).
router.post(
    '/admins/:id(\\d+)/extend-access',
    requirePermission('manage_admins'),
    AdminController.extendAccess
);
router.post('/admins/:id(\\d+)/delete', requirePermission('manage_admins'), AdminController.delete);
// SSO identity link/unlink + revoke promoted admin access (service enforces the
// SuperAdmin-only rule for admin targets / revocation).
router.post(
    '/admins/:id(\\d+)/sso-link',
    requirePermission('manage_admins'),
    AdminController.linkSso
);
router.post(
    '/admins/:id(\\d+)/sso-unlink',
    requirePermission('manage_admins'),
    AdminController.unlinkSso
);
router.post(
    '/admins/:id(\\d+)/revoke-access',
    requirePermission('manage_admins'),
    AdminController.revokeAccess
);

// Admin Data Management - Bulk Import/Export (SuperAdmin only)
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure tmp directory exists
const tmpDir = path.join(__dirname, '../../tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

// Configure multer for Excel file uploads
const upload = multer({
    dest: tmpDir,
    fileFilter: (req, file, cb) => {
        const allowedExts = ['.xlsx', '.xls', '.json'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed types: Excel (.xlsx, .xls) and JSON (.json)'));
        }
    },
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
});

// ---- API Keys & Power BI (per-profile, superadmin only) --------------------
const ApiKeyService = require('../services/ApiKeyService');
const _akDb = require('../config/database');
const _ah = require('../utils/asyncHandler');
router.get(
    '/admin/api-keys',
    requireSuperAdmin,
    _ah(async (req, res) => {
        const keys = await ApiKeyService.list();
        // Selectable "profiles" = admin accounts whose clearance a key can inherit.
        const admins = await _akDb.all(
            'SELECT id, username, role FROM admins ORDER BY role, username'
        );
        // every admin page carries a <title>; this one showed a bare "IDevelop".
        res.render('pages/admin/api-keys', {
            keys,
            admins,
            title: req.t ? req.t('chrome:pt_api_keys') : 'API keys & Power BI',
        });
    })
);
// les quatre refus de cette route se lisent dans la langue
// de la page. `req.t('admin:ops_apikey_past_expiry')` était appelé sur une clé
// ABSENTE des deux fichiers de locales : i18next rend alors la clé nue, le repli
// anglais du ternaire n'est jamais atteint, et `api-keys.ejs` affichait
// littéralement une boîte « ops_apikey_past_expiry ». Les clés existent
// désormais en FR et en EN ; `_akT` garde le repli pour un appel sans req.t
// (test unitaire, sonde) et détecte l'écho de clé plutôt que de le servir.
const _akT = (req, key, fallback) => {
    const s = req && typeof req.t === 'function' ? req.t(`admin:${key}`) : null;
    return s && s !== key && s !== `admin:${key}` ? s : fallback;
};
// ASVS 3.7.1: minting a key needs a sign-in in the last 15 minutes or the
// current password (src/middleware/recentAuth.js).
router.post(
    '/admin/api-keys',
    requireSuperAdmin,
    requireRecentAuth({ action: 'API key creation' }),
    _ah(async (req, res) => {
        const label = String(req.body.label || '').trim();
        if (!label)
            return res.status(400).json({
                ok: false,
                code: 'label_required',
                error: _akT(req, 'ops_apikey_label_required', 'A label for the key is required.'),
            });
        // SEC-2 (3.23.21): ONE issuable-scope list, shared with POST /api/v1/admin/api-keys.
        // No scope → the historical default; a scope off the list → refused, never
        // silently swapped for another one.
        const { issuableScope } = require('../middleware/apiAuth');
        const askedScope = String(req.body.scope || '').trim();
        const scope = askedScope ? issuableScope(askedScope) : 'powerbi.read';
        if (!scope)
            return res.status(400).json({
                ok: false,
                code: 'bad_scope',
                error: _akT(req, 'ops_apikey_bad_scope', 'This scope cannot be issued.'),
            });
        let ownerAdminId = req.body.ownerAdminId ? Number(req.body.ownerAdminId) : null;
        if (ownerAdminId) {
            const a = await _akDb.get('SELECT id FROM admins WHERE id = ?', [ownerAdminId]);
            if (!a)
                return res.status(400).json({
                    ok: false,
                    code: 'unknown_owner',
                    error: _akT(
                        req,
                        'ops_apikey_unknown_owner',
                        'That owner profile does not exist.'
                    ),
                });
        }
        // expiresAt is a date in the FUTURE or nothing — the raw
        // PG cast error ("invalid input syntax for type timestamp") never reaches
        // the client; the message is a locale sentence with a stable code.
        const expiresAt = req.body.expiresAt ? String(req.body.expiresAt) : null;
        if (expiresAt) {
            const d = new Date(expiresAt);
            if (!/^\d{4}-\d{2}-\d{2}/.test(expiresAt) || Number.isNaN(d.getTime())) {
                return res.status(400).json({
                    ok: false,
                    code: 'bad_expiry',
                    error: _akT(
                        req,
                        'ops_apikey_bad_expiry',
                        'Expiry must be a date (YYYY-MM-DD).'
                    ),
                });
            }
            if (d.getTime() <= Date.now()) {
                return res.status(400).json({
                    ok: false,
                    code: 'past_expiry',
                    error: _akT(req, 'ops_apikey_past_expiry', 'Expiry must be in the future.'),
                });
            }
        }
        const k = await ApiKeyService.generate(
            { label, scope, createdBy: req.user.id, ownerAdminId, expiresAt },
            req
        );
        res.json({ ok: true, id: k.id, key: k.key });
    })
);
router.post(
    '/admin/api-keys/:id/revoke',
    requireSuperAdmin,
    _ah(async (req, res) => {
        await ApiKeyService.revoke(Number(req.params.id), req);
        res.json({ ok: true });
    })
);

router.get('/admin/data-management', requireSuperAdmin, (req, res) =>
    res.redirect('/data-management')
);
// `POST /admin/data/cleanup` was removed: a data-wipe endpoint
// with no UI, no typed phrase and no pre-backup abort. The guarded reset on
// /data-management is the only destructive path.
// Full-system dumps carry ADMIN accounts + scopes + all employee PII, so they are
// superadmin-only — not the delegatable export_data grant (which covers per-category
// CSV/report packs). Secret settings are also stripped from the JSON (UnifiedJsonService).
router.get('/admin/data/export', requireSuperAdmin, DataManagementController.exportFullSystem);
router.get('/admin/data/export-full', requireSuperAdmin, DataManagementController.exportFullSystem);
router.get('/admin/data/export-json', requireSuperAdmin, DataManagementController.exportSystemJson);
router.post(
    '/admin/data/import',
    requirePermission('import_data'),
    upload.single('excelFile'),
    DataManagementController.importFullSystem
);
router.post(
    '/admin/data/import-json',
    requirePermission('import_data'),
    upload.single('jsonFile'),
    DataManagementController.importSystemJson
);
router.post(
    '/admin/data/preview',
    requirePermission('import_data'),
    upload.single('excelFile'),
    DataManagementController.previewImport
);
// Dry-run preview of a full-system JSON import (onboarding wizard)
router.post(
    '/admin/data/preview-json',
    requirePermission('import_data'),
    upload.single('jsonFile'),
    DataManagementController.previewSystemJson
);

// SQL Console (super-admin only): run raw SQL + convert an Excel template to SQL.
// Separation of duties: the whole console is OFF unless the host operator sets
// SQL_CONSOLE_ENABLED=1. While off, every console route answers 404 — before the
// role check, so the console does not even reveal that it exists.
const SqlConsoleController = require('../controllers/SqlConsoleController');
const { requireSqlConsoleEnabled } = require('../middleware/sqlConsoleEnabled');
router.use('/data-management/sql-console', requireSqlConsoleEnabled);
router.get(
    '/data-management/sql-console',
    requireSuperAdmin,
    SqlConsoleController.index.bind(SqlConsoleController)
);
router.post(
    '/data-management/sql-console/execute',
    requireSuperAdmin,
    SqlConsoleController.execute.bind(SqlConsoleController)
);
router.post(
    '/data-management/sql-console/from-excel',
    requireSuperAdmin,
    upload.single('excelFile'),
    SqlConsoleController.fromExcel.bind(SqlConsoleController)
);
router.get(
    '/data-management/sql-console/restore-points',
    requireSuperAdmin,
    SqlConsoleController.listRestorePoints.bind(SqlConsoleController)
);
router.post(
    '/data-management/sql-console/restore-points/:name/revert',
    requireSuperAdmin,
    SqlConsoleController.revertRestorePoint.bind(SqlConsoleController)
);

// System Logs — delegatable via view_system_logs. Access is granted by the
// permission, but the DATA is scoped to the holder's clearance: SuperAdmin sees
// all logs; a scope-restricted admin sees only rows whose actor is a governed
// employee (or their own admin actions), and global-infra signals (perf/login/IP)
// stay SuperAdmin-only. Scoping is applied in SystemLogController/SystemLogModel.
router.get('/system-logs', requirePermission('view_system_logs'), SystemLogController.index);
router.get(
    '/system-logs/analytics',
    requirePermission('view_system_logs'),
    SystemLogController.analytics
);
router.get(
    '/system-logs/issues',
    requirePermission('view_system_logs'),
    SystemLogController.issues
);
router.get(
    '/system-logs/request/:id',
    requirePermission('view_system_logs'),
    SystemLogController.requestTrail
);
router.get(
    '/system-logs/export',
    requirePermission('view_system_logs'),
    SystemLogController.export
);

// Notifications monitor — every notification the platform produced, in-app and
// email, with delivery state and a re-queue for failed ones. SuperAdmin only:
// it shows who was notified of what across the whole org.
router.get(
    '/admin/notifications',
    requireSuperAdmin,
    NotificationAdminController.index.bind(NotificationAdminController)
);
router.post(
    '/admin/notifications/:id/retry',
    requireSuperAdmin,
    NotificationAdminController.retry.bind(NotificationAdminController)
);

// Reports — manager/admin only
router.get('/reports/builder', requireManagerOrAdmin, ReportController.builder);
// The report builder reads staff data (view_employees / export_data to run it)
// and its download is an EXPORT (export_data) — the same capability
// /data-management/export requires, which the builder used to bypass on
// role shape alone. Managers keep their scoped access on all three.
router.post(
    '/reports/generate',
    requireManagerOrAnyPermission('view_employees', 'export_data'),
    ReportController.generate
);
router.post(
    '/reports/export',
    requireManagerOrAnyPermission('export_data'),
    ReportController.export
);
router.get('/reports/templates', requireManagerOrAdmin, ReportController.listTemplates);
router.post('/reports/templates', requireManagerOrAdmin, ReportController.saveTemplate);
router.get('/reports/templates/:id', requireManagerOrAdmin, ReportController.loadTemplate);
router.delete('/reports/templates/:id', requireManagerOrAdmin, ReportController.deleteTemplate);
// First-run setup checklist. SuperAdmin-only. The wizard reports
// GLOBAL counts (all sites, all departments, the whole headcount) and its steps
// link to /organization, /domains-skills, /roles and /app-settings — pages a
// site-scoped admin is refused on. Shown to a local admin it leaked out-of-scope
// headcount and nagged with a dead-end wizard it could not dismiss.
const SetupController = require('../controllers/SetupController');
router.get('/setup', requireSuperAdminPage, SetupController.index.bind(SetupController));
router.post('/setup/dismiss', requireSuperAdmin, SetupController.dismiss.bind(SetupController));

// Local Content / Nationalization — OPTIONAL module (settings-gated in the controller)
const LocalContentController = require('../controllers/LocalContentController');
router.get(
    '/reports/local-content',
    requireManagerOrAdmin,
    rbacMiddleware,
    LocalContentController.index.bind(LocalContentController)
);
// 3.23.18: safety-competency gate pages (/safety-gate, /safety-gate/config).
router.use('/safety-gate', require('./v2-safety-gate').pageRouter);
// 3.23.18: nationalisation succession plans + regulator-ready local-content packs
// (the module keeps its own featureLocalContent gate).
router.use(
    '/reports/local-content',
    requireManagerOrAdmin,
    rbacMiddleware,
    require('./v2-localcontent')
);

// Scheduled email delivery of saved templates
router.get('/reports/schedules', requireManagerOrAdmin, ReportController.listSchedules);
router.post('/reports/schedules', requireManagerOrAdmin, ReportController.createSchedule);
router.post(
    '/reports/schedules/:id/delete',
    requireManagerOrAdmin,
    ReportController.deleteSchedule
);
router.get('/reports/reference/:source', requireManagerOrAdmin, ReportController.getReferenceData);
router.post(
    '/reports/data',
    requireManagerOrAnyPermission('view_employees', 'export_data'),
    ReportController.reportData
);
router.get('/reports/readiness', requireManagerOrAdmin, ReportController.readiness);
router.get('/reports/gaps', requireManagerOrAdmin, ReportController.gaps);

// Skill Matrix — manager/admin only
router.get('/skill-matrix', requireManagerOrAdmin, SkillMatrixController.index);
router.post(
    '/skill-matrix/update-assessment',
    requirePermission('manage_assessments'),
    SkillMatrixController.updateAssessment
);

// Data Management hub — reachable by exporters or importers.
router.get(
    '/data-management',
    requireAnyPermission('export_data', 'import_data'),
    DataManagementController.index
);
router.get(
    '/api/data-management/statistics',
    requireAnyPermission('export_data', 'import_data'),
    DataManagementController.getStatistics
);

// Export routes (export_data)
router.get(
    '/data-management/export/employees',
    requirePermission('export_data'),
    DataManagementController.exportEmployees
);
router.get(
    '/data-management/export/assessments',
    requirePermission('export_data'),
    DataManagementController.exportAssessments
);
router.get(
    '/data-management/export/history',
    requirePermission('export_data'),
    DataManagementController.exportHistory
);
router.get(
    '/data-management/export/assessments/excel',
    requirePermission('export_data'),
    DataManagementController.exportAssessmentsExcel
);
router.get(
    '/data-management/export/assessments/json',
    requirePermission('export_data'),
    DataManagementController.exportAssessmentsJSON
);
router.get(
    '/data-management/export/organization',
    requirePermission('export_data'),
    DataManagementController.exportOrganization
);
router.get(
    '/data-management/export/domains-skills',
    requirePermission('export_data'),
    DataManagementController.exportDomainsSkills
);
// Exporting admin accounts is admin management, not general data export.
router.get(
    '/data-management/export/local-admins',
    requirePermission('manage_admins'),
    DataManagementController.exportLocalAdmins
);

// Template download routes (export_data — templates are blank export shapes)
router.get(
    '/data-management/templates/domains-skills',
    requirePermission('export_data'),
    DataManagementController.downloadDomainsSkillsTemplate
);
router.get(
    '/data-management/templates/organization',
    requirePermission('export_data'),
    DataManagementController.downloadOrganizationTemplate
);
router.get(
    '/data-management/templates/employees',
    requirePermission('export_data'),
    DataManagementController.downloadEmployeesTemplate
);
router.get(
    '/data-management/templates/local-admins',
    requirePermission('manage_admins'),
    DataManagementController.downloadLocalAdminsTemplate
);
router.get(
    '/data-management/templates/roles',
    requirePermission('export_data'),
    DataManagementController.downloadRolesTemplate
);
router.get(
    '/data-management/templates/assessments',
    requirePermission('export_data'),
    DataManagementController.downloadAssessmentsTemplate
);
router.get(
    '/data-management/templates/skill-framework',
    requirePermission('export_data'),
    DataManagementController.downloadSkillFrameworkTemplate
);
router.get(
    '/data-management/templates/full-system',
    requirePermission('export_data'),
    DataManagementController.downloadFullSystemTemplate
);

// JSON Template download routes (export_data)
router.get(
    '/data-management/templates/json/full',
    requirePermission('export_data'),
    DataManagementController.downloadFullSystemJsonTemplate
);
router.get(
    '/data-management/templates/json/domains-skills',
    requirePermission('export_data'),
    DataManagementController.downloadDomainsSkillsJsonTemplate
);
router.get(
    '/data-management/templates/json/organization',
    requirePermission('export_data'),
    DataManagementController.downloadOrganizationJsonTemplate
);
router.get(
    '/data-management/templates/json/employees',
    requirePermission('export_data'),
    DataManagementController.downloadEmployeesJsonTemplate
);
router.get(
    '/data-management/templates/json/roles',
    requirePermission('export_data'),
    DataManagementController.downloadRolesJsonTemplate
);
router.get(
    '/data-management/templates/json/assessments',
    requirePermission('export_data'),
    DataManagementController.downloadAssessmentsJsonTemplate
);

// Import routes (with multer middleware if available)
const uploadMiddleware = DataManagementController.upload
    ? DataManagementController.upload.single('file')
    : (req, res, next) => {
          res.status(500).json({
              error: 'Import functionality requires multer module. Please install it with: npm install multer@^1.4.5-lts.1',
          });
      };

router.post(
    '/data-management/import/organization',
    requirePermission('import_data'),
    uploadMiddleware,
    DataManagementController.importOrganization
);
router.post(
    '/data-management/import/domains-skills',
    requirePermission('import_data'),
    uploadMiddleware,
    DataManagementController.importDomainsSkills
);
router.post(
    '/data-management/import/employees',
    requirePermission('import_data'),
    uploadMiddleware,
    DataManagementController.importEmployees
);
// Importing admin accounts is admin management, not general data import.
router.post(
    '/data-management/import/local-admins',
    requirePermission('manage_admins'),
    uploadMiddleware,
    DataManagementController.importLocalAdmins
);
router.post(
    '/data-management/import/roles',
    requirePermission('import_data'),
    uploadMiddleware,
    DataManagementController.importRoles
);
router.post(
    '/data-management/import/skill-framework',
    requirePermission('import_data'),
    uploadMiddleware,
    DataManagementController.importSkillFramework
);

router.post(
    '/data-management/import/assessments',
    requirePermission('import_data'),
    uploadMiddleware,
    DataManagementController.importAssessments
);

// Skill Matrix (single-file provisioning — IA_Skill_Matrix layout) in any of
// excel | json | xml | csv. Export/template take a :format; import/preview
// auto-detect from the uploaded file extension.
router.get(
    '/data-management/skill-matrix-workbook/export/:format',
    requirePermission('export_data'),
    DataManagementController.exportSkillMatrix
);
router.get(
    '/data-management/skill-matrix-workbook/template/:format',
    requirePermission('export_data'),
    DataManagementController.downloadSkillMatrixTemplate
);
// Back-compat (no :format) → Excel default.
router.get(
    '/data-management/skill-matrix-workbook/export',
    requirePermission('export_data'),
    DataManagementController.exportSkillMatrix
);
router.get(
    '/data-management/skill-matrix-workbook/template',
    requirePermission('export_data'),
    DataManagementController.downloadSkillMatrixTemplate
);
router.post(
    '/data-management/skill-matrix-workbook/preview',
    requirePermission('import_data'),
    uploadMiddleware,
    DataManagementController.previewSkillMatrix
);
router.post(
    '/data-management/skill-matrix-workbook/import',
    requirePermission('import_data'),
    uploadMiddleware,
    DataManagementController.importSkillMatrix
);

// Snapshot routes
router.post(
    '/data-management/snapshots',
    requireSuperAdmin,
    DataManagementController.createSnapshot
);
router.post(
    '/data-management/snapshots/:id/restore',
    requireSuperAdmin,
    DataManagementController.restoreSnapshot
);
router.delete(
    '/data-management/snapshots/:id',
    requireSuperAdmin,
    DataManagementController.deleteSnapshot
);
router.get(
    '/data-management/snapshots/:id/stats',
    requireSuperAdmin,
    DataManagementController.getSnapshotStats
);

// Reset route
router.post('/data-management/reset', requireSuperAdmin, DataManagementController.resetDatabase);

// AJAX routes
// Cascading-select reference lookups (org unit id+name only — no people data).
// Open to admins AND managers: managers need them to edit their reports, and
// the old canAccessSite/canAccessDepartment checks 403'd both managers and
// department/service-scoped local admins, leaving the Department/Service
// dropdowns EMPTY on the employee form. The employee routes themselves stay
// RBAC-guarded; org-unit names are shown to these roles all over the app.
router.get('/api/departments', requireAuth, async (req, res) => {
    try {
        const siteId = parseInt(req.query.siteId);
        if (!siteId) {
            return res.json([]);
        }
        const u = req.user;
        if (u.userType === 'employee') return res.status(403).json({ error: 'Access denied' });

        const departments = await DepartmentModel.findBySiteId(siteId);
        res.json(departments);
    } catch (error) {
        console.error('AJAX departments error:', error);
        res.status(500).json({ error: 'Error loading departments' });
    }
});

router.get('/api/services', requireAuth, async (req, res) => {
    try {
        const departmentId = parseInt(req.query.departmentId);
        if (!departmentId) {
            return res.json([]);
        }
        const u = req.user;
        if (u.userType === 'employee') return res.status(403).json({ error: 'Access denied' });

        const services = await ServiceModel.findByDepartmentId(departmentId);
        res.json(services);
    } catch (error) {
        console.error('AJAX services error:', error);
        res.status(500).json({ error: 'Error loading services' });
    }
});

// =====================================================================
// Migration-55 feature set: departmental analytics, SuperAdmin employee
// deactivation, onboarding credential issuance, per-user auth policy, and
// departmental digest subscriptions.
// =====================================================================
const DeptAnalyticsController = require('../controllers/DeptAnalyticsController');
const _m55 = require('../utils/asyncHandler');

// --- Cancelling a coaching / mentoring / PIP / IDP plan, under a local
//     admin's approval. Managers and admins may REQUEST; only an admin may
//     DECIDE (and never the requester). Nothing is deleted - the plan is marked
//     cancelled and the request keeps the explanation. ---
const CancellationController = require('../controllers/CancellationController');
router.get('/cancellations', requireManagerOrAdmin, _m55(CancellationController.page));
router.post('/cancellations', requireManagerOrAdmin, _m55(CancellationController.request));
router.post(
    '/cancellations/:id/withdraw',
    requireManagerOrAdmin,
    _m55(CancellationController.withdraw)
);
router.post(
    '/cancellations/:id/decide',
    requireManagerOrAnyPermission('manage_mobility'),
    _m55(CancellationController.decide)
);

// --- "Who is qualified": the daily dispatch question a shift supervisor asks.
//     Read-only and RBAC-scoped inside the service. ---
const QualifiedPeopleController = require('../controllers/QualifiedPeopleController');
router.get('/qualified', requireManagerOrAdmin, _m55(QualifiedPeopleController.page));
router.get('/api/qualified/skills', requireManagerOrAdmin, _m55(QualifiedPeopleController.skills));

// --- Bulk coverage-rule generation, manage_compliance only.
//
// PREVIEW → CONFIRM. The preview evaluates the plan and returns two numbers:
// how many rules would be created, and how many of them would be IN BREACH the
// instant they exist. The commit must echo both back (`expectedRules` /
// `expectedBreaches`); if the org has moved since the preview the numbers no
// longer match and the commit is refused with the fresh figures rather than
// quietly creating a different set. A hard cap
// (CoverageService.MAX_RULES_PER_GENERATION) stops a single run from producing
// a rule set nobody can triage. ---
router.post(
    '/compliance/rules/generate',
    requirePermission('manage_compliance'),
    _m55(async (req, res) => {
        try {
            const CoverageService = require('../services/CoverageService');
            const spec = {
                skillIds: [].concat(req.body.skillIds || []).filter(Boolean),
                domainId: req.body.domainId || null,
                scope: req.body.scope,
                minLevel: req.body.minLevel,
                minHeadcount: req.body.minHeadcount,
                requireValidCert:
                    req.body.requireValidCert === '1' || req.body.requireValidCert === true,
                severity: req.body.severity,
                onlyWhereStaffed: req.body.onlyWhereStaffed !== '0',
            };
            const commit = req.body.commit === '1' || req.body.commit === true;
            if (!commit) {
                const preview = await CoverageService.generateRules(
                    spec,
                    req.user && req.user.id,
                    false,
                    { actor: req.user }
                );
                return res.json(preview);
            }

            // Confirm handshake: the caller must have seen a preview and must state
            // the exact figures it showed.
            const expectedRules = parseInt(req.body.expectedRules, 10);
            const expectedBreaches = parseInt(req.body.expectedBreaches, 10);
            if (!Number.isFinite(expectedRules) || !Number.isFinite(expectedBreaches)) {
                return res.status(400).json({ error: 'confirm_required' });
            }
            const dry = await CoverageService.generateRules(spec, req.user && req.user.id, false, {
                actor: req.user,
            });
            if (dry.plannedCount !== expectedRules || dry.immediateBreaches !== expectedBreaches) {
                return res.status(409).json({
                    error: 'plan_changed',
                    plannedCount: dry.plannedCount,
                    immediateBreaches: dry.immediateBreaches,
                    cap: dry.cap,
                });
            }

            const out = await CoverageService.generateRules(spec, req.user && req.user.id, true, {
                actor: req.user,
            });
            require('../services/LogService').log({
                adminId: req.user && req.user.id,
                action: 'COVERAGE_RULES_GENERATED',
                entityType: 'coverage_rule',
                entityId: null,
                details: JSON.stringify({
                    created: out.created,
                    skipped: out.skipped,
                    scope: spec.scope,
                    immediateBreaches: out.immediateBreaches,
                    confirmed: true,
                }),
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            res.json(out);
        } catch (e) {
            if (e && e.code === 'too_many_rules') {
                return res
                    .status(400)
                    .json({ error: 'too_many_rules', plannedCount: e.plannedCount, cap: e.cap });
            }
            res.status(400).json({ error: e.message || 'generate_failed' });
        }
    })
);

// --- Post-approval re-review: a supervisor may contest an ALREADY APPROVED
//     score; only an administrator may decide it. requireManagerOrAdmin lets
//     supervisors/managers reach the queue and raise a case; the decide route
//     is admin-only, and the service + a DB CHECK enforce that independently. ---
const PostApprovalReviewController = require('../controllers/PostApprovalReviewController');
router.get(
    '/reviews/post-approval',
    requireManagerOrAdmin,
    _m55(PostApprovalReviewController.page)
);
router.post(
    '/reviews/post-approval',
    requireManagerOrAdmin,
    _m55(PostApprovalReviewController.raise)
);
router.post(
    '/reviews/post-approval/:id/withdraw',
    requireManagerOrAdmin,
    _m55(PostApprovalReviewController.withdraw)
);
router.post(
    '/reviews/post-approval/:id/decide',
    requireManagerOrAnyPermission('approve_assessments'),
    _m55(PostApprovalReviewController.decide)
);

// --- Movement & activity trail: one page answering what / where / who.
//     Scoped inside MovementService, same "scope before aggregate" rule as
//     every other analytic surface. ---
const MovementController = require('../controllers/MovementController');
router.get('/movements', requireManagerOrAdmin, _m55(MovementController.page));
router.get('/movements/export.csv', requireManagerOrAdmin, _m55(MovementController.exportCsv));
router.get('/api/movements', requireManagerOrAdmin, _m55(MovementController.api));

// --- Departmental analytics (RBAC-scoped inside the controller) ---
router.get(
    '/reports/dept-analytics',
    requireManagerOrAdmin,
    _m55(DeptAnalyticsController.page.bind(DeptAnalyticsController))
);
router.get(
    '/api/analytics/department-completion',
    requireManagerOrAdmin,
    _m55(DeptAnalyticsController.departmentCompletion.bind(DeptAnalyticsController))
);
router.get(
    '/api/analytics/ninebox-by-department',
    requireManagerOrAdmin,
    _m55(DeptAnalyticsController.nineboxByDepartment.bind(DeptAnalyticsController))
);
router.get(
    '/api/analytics/perf-actions-trend',
    requireManagerOrAdmin,
    _m55(DeptAnalyticsController.perfActionsTrend.bind(DeptAnalyticsController))
);
router.get(
    '/api/analytics/campaign-burndown',
    requireManagerOrAdmin,
    _m55(DeptAnalyticsController.campaignBurndown.bind(DeptAnalyticsController))
);
router.get(
    '/api/analytics/team-progression',
    requireManagerOrAdmin,
    _m55(DeptAnalyticsController.teamProgression.bind(DeptAnalyticsController))
);

// --- SuperAdmin: deactivate / reactivate an employee (global soft toggle).
// is_active drives v_employee_details, so a deactivated employee vanishes from
// the Skill Matrix, 9-box, readiness and every report instantly; the account
// login is disabled too, and the per-request deserialize drops any live session.
router.post(
    '/employees/:id/deactivate',
    requireSuperAdmin,
    _m55(async (req, res) => {
        const EmployeeModel = require('../models/EmployeeModel');
        const LogService = require('../services/LogService');
        const LifecycleService = require('../services/LifecycleService');
        const employee = await EmployeeModel.findById(req.params.id);
        if (!employee) return res.status(404).json({ error: 'Employee not found' });

        // This used to be `update(id, { isActive: 0, isAccountActive: 0 })` and
        // nothing else, while the audit line claimed "login disabled". It was not:
        // an employee promoted to admin has a SECOND account
        // (admins.linked_employee_id) that `deserializeUser` gates on
        // `admins.is_active`, and their /api/v1 keys resolve through the OWNING
        // ADMIN's is_active. Both stayed true, so a "deactivated" person kept a
        // fully valid admin login with full HR reach and a working Power BI key.
        // No lifecycle event was recorded either, so `reactivate` — which already
        // went through LifecycleService.reinstate expressly "so linked admin
        // accounts / API keys come back too" — had nothing to put back. The pair
        // was asymmetric: the undo restored something the do never did.
        //
        // `departure: false` takes the identical revocation without the departure
        // consequences (no PII erasure clock, no handover plan, no manager notice)
        // and records what it switched off, so reinstate restores exactly that.
        const out = await LifecycleService.deprovision(employee.id, {
            source: 'admin_deactivate',
            actorRef: `admin:${req.user.id}`,
            departure: false,
        });

        const revoked = (out && out.revoked) || {};
        const nAdmins = (revoked.adminIds || []).length;
        const nKeys = (revoked.apiKeyIds || []).length;
        await LogService.log({
            adminId: req.user.id,
            action: 'EMPLOYEE_DEACTIVATED',
            entityType: 'employee',
            entityId: employee.id,
            // Say what was actually switched off, so the line is checkable.
            details:
                `Employee ${employee.employeeNumber} deactivated (excluded from matrix, 9-box and analytics; ` +
                `sessions revoked; ${nAdmins} linked admin account(s) and ${nKeys} API key(s) disabled)`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({
            success: true,
            message: 'Employee deactivated',
            adminAccountsDisabled: nAdmins,
            apiKeysRevoked: nKeys,
        });
    })
);
// whoever may deprovision within scope (edit_employees +
// checkEmployeeAccess) may reinstate within scope — through
// LifecycleService.reinstate, so linked admin accounts / API keys come back
// too and voided / erased records are refused.
router.post(
    '/employees/:id/reactivate',
    requirePermission('edit_employees'),
    requireNumericParam('id'),
    checkEmployeeAccess,
    _m55(EmployeeController.reactivate.bind(EmployeeController))
);

// --- Onboarding credentials: generate username + temp password, email them,
// and force a password change at first login. Sensitive → the dedicated
// reset_employee_password grant (not general employee editing).
//
// checkEmployeeAccess is REQUIRED here, not optional: reset_employee_password is
// a scope-delegated grant ("within the assigned scope"), and this route was the
// only credential-writing /employees/:id route missing the scope guard its
// siblings all carry (reset-password, credentials, activate-account). Without it
// a site-scoped admin could POST any employee id org-wide and force a password
// reset + account activation on someone they do not govern — invalidating that
// person's current password and disclosing their username. The service does not
// re-check: it uses `actor` only for invited_by and the audit row.
router.post(
    '/employees/:id/send-credentials',
    requirePermission('reset_employee_password'),
    requireNumericParam('id'),
    checkEmployeeAccess,
    _m55(EmployeeController.sendCredentials.bind(EmployeeController))
);

// --- Per-user authentication policy (migration 55). SuperAdmin only.
// employees: any | sso_only | local_only | mfa_required
// admins:    any | local_only | mfa_required
//   3.23.19: for an admin, 'any' = password, or SSO when a SuperAdmin has
//   turned on sso.adminSsoEnabled (AdminSsoService); 'local_only' = password
//   only, never SSO; 'mfa_required' = like 'any' + mandatory MFA enrolment.
router.post(
    '/employees/:id/auth-policy',
    requireSuperAdmin,
    _m55(async (req, res) => {
        const policy = String(req.body.policy || '');
        if (!['any', 'sso_only', 'local_only', 'mfa_required'].includes(policy)) {
            return res.status(400).json({ error: 'Invalid policy' });
        }
        const EmployeeModel = require('../models/EmployeeModel');
        const LogService = require('../services/LogService');
        const employee = await EmployeeModel.findById(req.params.id);
        if (!employee) return res.status(404).json({ error: 'Employee not found' });
        await EmployeeModel.update(employee.id, { authPolicy: policy });
        await LogService.log({
            adminId: req.user.id,
            action: 'AUTH_POLICY_SET',
            entityType: 'employee',
            entityId: employee.id,
            details: `Authentication policy for employee ${employee.employeeNumber} set to '${policy}'`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({ success: true, policy });
    })
);
router.post(
    '/admins/:id(\\d+)/auth-policy',
    requireSuperAdmin,
    _m55(async (req, res) => {
        const policy = String(req.body.policy || '');
        if (!['any', 'local_only', 'mfa_required'].includes(policy)) {
            return res.status(400).json({ error: 'Invalid policy' });
        }
        const db = require('../config/database');
        const LogService = require('../services/LogService');
        const admin = await db.get('SELECT id, username FROM admins WHERE id = ?', [req.params.id]);
        if (!admin) return res.status(404).json({ error: 'Admin not found' });
        await db.run('UPDATE admins SET auth_policy = ? WHERE id = ?', [policy, admin.id]);
        await LogService.log({
            adminId: req.user.id,
            action: 'AUTH_POLICY_SET',
            entityType: 'admin',
            entityId: admin.id,
            details: `Authentication policy for admin ${admin.username} set to '${policy}'`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({ success: true, policy });
    })
);

// --- Departmental digest subscriptions (self-service opt-in for admins,
// managers and supervisors; the dept-digest job sends the scoped report).
router.get(
    '/api/digest-subscriptions/mine',
    requireManagerOrAdmin,
    _m55(async (req, res) => {
        const db = require('../config/database');
        const subscriberType = req.user.userType === 'admin' ? 'admin' : 'employee';
        const row = await db.get(
            `SELECT id, frequency, day_of_week AS "dayOfWeek", day_of_month AS "dayOfMonth",
                hour, is_active AS "isActive", last_sent_on AS "lastSentOn"
           FROM digest_subscriptions WHERE subscriber_type = ? AND subscriber_id = ?`,
            [subscriberType, req.user.id]
        );
        res.json({ subscription: row || null });
    })
);
router.post(
    '/api/digest-subscriptions',
    requireManagerOrAdmin,
    _m55(async (req, res) => {
        const db = require('../config/database');
        const frequency = String(req.body.frequency || 'biweekly');
        if (!['biweekly', 'monthly'].includes(frequency))
            return res.status(400).json({ error: 'frequency must be biweekly or monthly' });
        // Number.isFinite guards, not `|| default` — 0 is a legal hour (midnight)
        // and a legal day-of-week (Sunday) and must not collapse to the default.
        const _num = (v, def) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : def;
        };
        const dayOfWeek = Math.min(Math.max(_num(req.body.dayOfWeek, 1), 0), 6);
        const dayOfMonth = Math.min(Math.max(_num(req.body.dayOfMonth, 1), 1), 28);
        const hour = Math.min(Math.max(_num(req.body.hour, 7), 0), 23);
        const subscriberType = req.user.userType === 'admin' ? 'admin' : 'employee';
        await db.run(
            `INSERT INTO digest_subscriptions (subscriber_type, subscriber_id, frequency, day_of_week, day_of_month, hour, is_active)
         VALUES (?, ?, ?, ?, ?, ?, true)
         ON CONFLICT (subscriber_type, subscriber_id)
         DO UPDATE SET frequency = EXCLUDED.frequency, day_of_week = EXCLUDED.day_of_week,
                       day_of_month = EXCLUDED.day_of_month, hour = EXCLUDED.hour,
                       is_active = true, updated_at = now()`,
            [subscriberType, req.user.id, frequency, dayOfWeek, dayOfMonth, hour]
        );
        res.json({ success: true, frequency, dayOfWeek, dayOfMonth, hour });
    })
);
router.post(
    '/api/digest-subscriptions/cancel',
    requireManagerOrAdmin,
    _m55(async (req, res) => {
        const db = require('../config/database');
        const subscriberType = req.user.userType === 'admin' ? 'admin' : 'employee';
        await db.run(
            'UPDATE digest_subscriptions SET is_active = false, updated_at = now() WHERE subscriber_type = ? AND subscriber_id = ?',
            [subscriberType, req.user.id]
        );
        res.json({ success: true });
    })
);

// =====================================================================
// Migration-56 feature set: Operational Compliance Assurance —
// certification/VOC engine, position-coverage rules, evidence uploads.
// Reads: managers + view_compliance holders (scoped inside the controller).
//
// Writes come in two flavours, and conflating them is what broke this module:
//
//   FIELD ACTS  — recording a certification / VOC sign-off, revoking one, and
//                 logging a planned absence. These are done at the pit by the
//                 site supervisor or the training coordinator, not by an HR
//                 administrator. `requirePermission` admits admins ONLY, so
//                 after the access-profile work no manager could sign off a VOC
//                 at all. They are gated on requireManagerOrAnyPermission:
//                 a manager reaches them for their own reports, a delegate
//                 reaches them with `manage_compliance`. Scope is enforced
//                 employee-by-employee inside the controller either way.
//
//   CONFIGURATION — certification policies, coverage rules (create / toggle /
//                 delete / bulk generate) and the bulk certificate import.
//                 These define the compliance programme for the whole org, so
//                 they stay on `manage_compliance` (SuperAdmin implicitly, and
//                 any delegate holding the slug — e.g. the `training_coord`
//                 access profile). A line manager does not get to author
//                 org-wide safe-shift rules.
// =====================================================================
const ComplianceController = require('../controllers/ComplianceController');
const _cmul = require('multer')({
    dest: require('path').resolve('tmp'),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.docx', '.xlsx'];
        cb(null, allowed.includes(require('path').extname(file.originalname).toLowerCase()));
    },
});
const _cc = ComplianceController;
router.get(
    '/compliance',
    requireManagerOrAnyPermission('view_compliance'),
    _m55(_cc.page.bind(_cc))
);
// Employee-representative (works council / CSE) register — generated from the
// live configuration, SuperAdmin only, printable to PDF from the browser.
router.get('/compliance/register', requireSuperAdminPage, _m55(_cc.register.bind(_cc)));
// « Ce qui est enregistré sur moi » — the signed-in person's own data only
// (the controller keys on req.user.id; no :id, no query-string id).
router.get('/employee/my-data', requireEmployeeOrManager, _m55(_cc.myData.bind(_cc)));
router.get(
    '/api/compliance/certifications',
    requireManagerOrAnyPermission('view_compliance'),
    _m55(_cc.certifications.bind(_cc))
);
router.get(
    '/api/compliance/currency',
    requireManagerOrAnyPermission('view_compliance'),
    _m55(_cc.currency.bind(_cc))
);
router.get(
    '/api/compliance/coverage',
    requireManagerOrAnyPermission('view_compliance'),
    _m55(_cc.coverage.bind(_cc))
);
router.get(
    '/compliance/evidence/:id',
    requireManagerOrAnyPermission('view_compliance'),
    _m55(_cc.evidence.bind(_cc))
);
router.post(
    '/compliance/policies',
    requirePermission('manage_compliance'),
    _m55(_cc.setPolicy.bind(_cc))
);
// Multipart (evidence file) — CSRF-exempted in server.js like the other
// multer routes (multer parses the body AFTER the CSRF middleware), and
// permission-gated + scope-checked inside the controller.
router.post(
    '/compliance/certifications',
    requireManagerOrAnyPermission('manage_compliance'),
    _cmul.single('evidence'),
    _m55(_cc.recordCertification.bind(_cc))
);
router.post(
    '/compliance/certifications/:id/revoke',
    requireManagerOrAnyPermission('manage_compliance'),
    _m55(_cc.revokeCertification.bind(_cc))
);
router.post(
    '/compliance/rules',
    requirePermission('manage_compliance'),
    _m55(_cc.createRule.bind(_cc))
);
router.post(
    '/compliance/rules/:id/toggle',
    requirePermission('manage_compliance'),
    _m55(_cc.toggleRule.bind(_cc))
);
// Deleting ONE rule. The bulk generator can produce a grid the operator did not
// want; without this the only way back was a DB console. Permission-guarded
// (configuration, not a field act) and audited with the full rule definition so
// a deleted safe-shift rule is never an untraceable disappearance.
router.post(
    '/compliance/rules/:id/delete',
    requirePermission('manage_compliance'),
    _m55(_cc.deleteRule.bind(_cc))
);
// Planned absences (migration 58) — feed the predicted-breach projection.
router.post(
    '/compliance/absences',
    requireManagerOrAnyPermission('manage_compliance'),
    _m55(_cc.addAbsence.bind(_cc))
);
router.post(
    '/compliance/absences/:id/delete',
    requireManagerOrAnyPermission('manage_compliance'),
    _m55(_cc.deleteAbsence.bind(_cc))
);

// --- Bulk account invitations (v2, 3.22.36) — credentials + welcome email,
// forced password change at first login. Delegable: any admin holding
// reset_employee_password runs it for THEIR scope (SuperAdmin implicitly);
// the controller enforces scope on every read and write.
const InvitationController = require('../controllers/InvitationController');
// the console lives at /admin/accounts; bookmarks and the sidebar link land there.
router.get(
    '/admin/invitations',
    requirePermission('manage_invitations'),
    InvitationController.legacyPage.bind(InvitationController)
);
router.post(
    '/admin/invitations/send',
    requirePermission('manage_invitations'),
    _m55(InvitationController.send.bind(InvitationController))
);
router.post(
    '/admin/invitations/:id/email',
    requirePermission('manage_invitations'),
    _m55(InvitationController.setEmail.bind(InvitationController))
);
router.get(
    '/admin/invitations/:id/preview',
    requirePermission('manage_invitations'),
    _m55(InvitationController.preview.bind(InvitationController))
);

// --- Global quick-search behind the command palette (Ctrl/Cmd+K).
// RBAC-scoped: employees are restricted to the caller's visible set, and
// employee results are omitted entirely for self-service employees.
router.get(
    '/api/quick-search',
    requireAuth,
    _m55(async (req, res) => {
        const db = require('../config/database');
        const { scopedEmployeeIds, scopeClause } = require('../utils/rbacScope');
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ employees: [], skills: [], roles: [] });
        const like = `%${q}%`;
        const u = req.user;
        const canSeePeople = u.userType === 'admin' || u.userType === 'manager';

        let employees = [];
        if (canSeePeople) {
            const ids = await scopedEmployeeIds(u);
            const params = [like, like];
            const scope = scopeClause(ids, params, 'e.id');
            employees = await db.all(
                `SELECT e.id, e.first_name || ' ' || e.last_name AS name,
                    e.employee_number AS "employeeNumber", r.name AS role
               FROM employees e JOIN roles r ON r.id = e.role_id
              WHERE e.is_active
                AND ((e.first_name || ' ' || e.last_name) ILIKE ? OR e.employee_number ILIKE ?)${scope}
              ORDER BY e.last_name LIMIT 6`,
                params
            );
        }
        const [skills, roles] = await Promise.all([
            db.all(
                'SELECT id, name FROM skills WHERE is_active AND name ILIKE ? ORDER BY name LIMIT 5',
                [like]
            ),
            canSeePeople
                ? db.all(
                      'SELECT id, name FROM roles WHERE is_active AND name ILIKE ? ORDER BY name LIMIT 5',
                      [like]
                  )
                : Promise.resolve([]),
        ]);
        res.json({ employees, skills, roles });
    })
);

// --- Unlock an employee account blocked by failed login attempts (3.22.37).
// The lockout is count-based (login_attempts rows within the window, enforced
// by checkAccountLockout for ANY identifier) — clearing the failed rows for
// both identifiers the person can sign in with (username AND email) unlocks
// immediately. Scoped to the actor's clearance; audited. Admin accounts have
// the equivalent at /admins/:id/unlock.
router.post(
    '/employees/:id/unlock',
    requirePermission('reset_employee_password'),
    requireNumericParam('id'),
    _m55(EmployeeController.unlock.bind(EmployeeController))
);
// Bulk certification import — lives under the data-management namespace so the
// existing multipart CSRF exemption prefix (/data-management/import/) applies.
// dryRun=1 in the form body = preview (nothing written).
router.get(
    '/data-management/templates/certifications',
    requirePermission('manage_compliance'),
    _m55(_cc.importTemplate.bind(_cc))
);
router.post(
    '/data-management/import/certifications',
    requirePermission('manage_compliance'),
    uploadMiddleware,
    _m55(_cc.importCertifications.bind(_cc))
);

// --- Power BI feeds #10 + #11: certifications & position coverage. Same
// API-key auth + RBAC scoping as the nine existing feeds (an owner-bound key
// sees only its owner's scope; the system key sees the whole org).
router.get(
    '/api/powerbi/certifications',
    requireApiKey,
    _m55(async (req, res) => {
        const db = require('../config/database');
        const { scopedEmployeeIds, scopeClause } = require('../utils/rbacScope');
        const ids = await scopedEmployeeIds(req.user);
        const params = [];
        const rows = await db.all(
            `SELECT * FROM v_certification_current cc WHERE 1 = 1${scopeClause(ids, params, 'cc.employee_id')}
          ORDER BY cc.expires_on ASC NULLS LAST`,
            params
        );
        res.json(
            rows.map((r) => ({
                CertificationID: Number(r.certificationId),
                EmployeeID: Number(r.employeeId),
                EmployeeName: r.fullName,
                SiteID: Number(r.siteId),
                Site: r.siteName,
                DepartmentID: Number(r.departmentId),
                Department: r.departmentName,
                ServiceID: Number(r.serviceId),
                Service: r.serviceName,
                SkillID: Number(r.skillId),
                Skill: r.skillName,
                CertNumber: r.certNumber || null,
                IssuedOn: r.issuedOn ? new Date(r.issuedOn).toISOString().slice(0, 10) : null,
                ExpiresOn: r.expiresOn ? new Date(r.expiresOn).toISOString().slice(0, 10) : null,
                DaysToExpiry: r.daysToExpiry != null ? Number(r.daysToExpiry) : null,
                Status: r.certStatus,
            }))
        );
    })
);
router.get(
    '/api/powerbi/coverage',
    requireApiKey,
    _m55(async (req, res) => {
        const { scopedEmployeeIds } = require('../utils/rbacScope');
        const CoverageService = require('../services/CoverageService');
        const rows = await CoverageService.status(await scopedEmployeeIds(req.user));
        res.json(
            rows.map((r) => ({
                RuleID: Number(r.ruleId),
                Rule: r.name,
                Severity: r.severity,
                SiteID: r.siteId ? Number(r.siteId) : null,
                Site: r.siteName || null,
                DepartmentID: r.departmentId ? Number(r.departmentId) : null,
                Department: r.departmentName || null,
                ServiceID: r.serviceId ? Number(r.serviceId) : null,
                Service: r.serviceName || null,
                SkillID: Number(r.skillId),
                Skill: r.skillName,
                MinLevel: Number(r.minLevel),
                RequiredHeadcount: Number(r.minHeadcount),
                QualifiedHeadcount: Number(r.qualifiedHeadcount),
                RequiresValidCert: !!r.requireValidCert,
                Satisfied: !!r.satisfied,
                BreachedSince: r.breachedSince ? new Date(r.breachedSince).toISOString() : null,
            }))
        );
    })
);

// --- Per-employee assessment-cycle history & progression (migration 57).
// Managers/admins: RBAC via checkEmployeeAccess. Employees: own view only.
const EmployeeProgressController = require('../controllers/EmployeeProgressController');
router.get(
    '/employees/:id/progress',
    requireEmployeeRead,
    requireNumericParam('id'),
    checkEmployeeAccess,
    _m55(EmployeeProgressController.page.bind(EmployeeProgressController))
);
router.get(
    '/api/employees/:id/cycle-progress',
    // 3.23.17 (A-5): authenticated + a STRICT numeric id — `137e1` passed
    // checkEmployeeAccess as 137 (parseInt) and was read as 1370 (Number).
    requireAuth,
    requireNumericParam('id'),
    checkEmployeeAccess,
    _m55(EmployeeProgressController.data.bind(EmployeeProgressController))
);
router.get(
    '/employee/my-progress',
    requireEmployeeOrManager,
    _m55(EmployeeProgressController.myPage.bind(EmployeeProgressController))
);

// ---- SECTION accounts — Accounts console & lifecycle (2026-09-10) -----------------------
// The Comptes / Accounts console (InvitationController, evolved): ONE list of
// every active employee in scope with an account state, per-row + bulk actions,
// CSV. Gate: reset_employee_password;
// scope is enforced per id inside the controller.
router.get(
    '/admin/accounts',
    requirePermission('manage_invitations'),
    _m55(InvitationController.page.bind(InvitationController))
);
router.get(
    '/admin/accounts/export.csv',
    requirePermission('manage_invitations'),
    _m55(InvitationController.exportCsv.bind(InvitationController))
);
// the bulk console keeps `reset_employee_password` — one of its actions
// ('reset') overwrites an existing password, which `manage_invitations` must not
// grant on its own. Sending/re-sending a single invitation stays on the weaker slug.
router.post(
    '/admin/accounts/bulk',
    requirePermission('reset_employee_password'),
    _m55(InvitationController.bulk.bind(InvitationController))
);
// 3.23.20 (C3g): « Imprimer les notices SSO » — printable notices for migrated
// accounts without an e-mail address (scope enforced in the controller).
router.get(
    '/admin/accounts/sso-notices',
    requirePermission('manage_invitations'),
    _m55(InvitationController.ssoNotices.bind(InvitationController))
);
router.post(
    '/admin/accounts/requests/:id/decline',
    requirePermission('manage_invitations'),
    requireNumericParam('id'),
    _m55(InvitationController.declineRequest.bind(InvitationController))
);
// Employee directory export is served
// by the list itself as `/employees?export=csv`: a `/employees/export.csv` route
// declared here can never be reached, `/employees/:id` (line ~706) matches first
// and refuses the non-numeric id with a 404.
// A manager's "request unlock / resend" for a report — governs check via
// checkEmployeeAccess; admins act directly on the console instead.
router.post(
    '/employees/:id/account-request',
    requireManagerOrAdmin,
    requireNumericParam('id'),
    checkEmployeeAccess,
    _m55(EmployeeController.accountRequest.bind(EmployeeController))
);
// GDPR export / erase from the maintenance panel (SuperAdmin, reason + double confirmation).
router.get(
    '/admin/maintenance/dsr/:id/export.json',
    requireSuperAdmin,
    requireNumericParam('id'),
    _m55(MaintenanceController.dsrExport.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/dsr-erase',
    requireSuperAdmin,
    _m55(MaintenanceController.dsrErase.bind(MaintenanceController))
);
// ---- end SECTION accounts ----------------------------------------------------------------

// ---- SECTION operations — Operations health & settings (2026-09-10) -----------------------
// Instance health: job ledger, backups, SMTP, database,
// licence — SuperAdmin only (the page runs jobs and writes backups).
const HealthController = require('../controllers/HealthController');
const _ahD = require('../utils/asyncHandler');
router.get('/admin/health', requireSuperAdmin, _ahD(HealthController.page.bind(HealthController)));
router.get(
    '/admin/health/history/:tick',
    requireSuperAdmin,
    _ahD(HealthController.history.bind(HealthController))
);
router.post(
    '/admin/health/run/:tick',
    requireSuperAdmin,
    _ahD(HealthController.runTick.bind(HealthController))
);
router.post(
    '/admin/health/backup',
    requireSuperAdmin,
    _ahD(HealthController.backupNow.bind(HealthController))
);
// Re-send ONE archived department brief to ONE recipient. The frozen payload is
// re-rendered, never recomputed, and the re-send runs under the job ledger so it
// is as auditable as a scheduled one.
router.post(
    '/admin/health/resend-brief',
    requireSuperAdmin,
    _ahD(HealthController.resendBrief.bind(HealthController))
);
// Maintenance panel: server-side search/filters/paging, trail
// filters + CSV, and the reverse of a maintenance cancel for plans/placements.
router.get(
    '/admin/maintenance/trail/export.csv',
    requireSuperAdmin,
    _ahD(MaintenanceController.trailExport.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/restore-plan',
    requireSuperAdmin,
    _ahD(MaintenanceController.restorePlan.bind(MaintenanceController))
);
router.post(
    '/admin/maintenance/restore-placement',
    requireSuperAdmin,
    _ahD(MaintenanceController.restorePlacement.bind(MaintenanceController))
);
// Report schedules: run one now, pause/resume.
router.post(
    '/reports/schedules/:id/run',
    requireManagerOrAdmin,
    requireNumericParam('id'),
    _ahD(ReportController.runScheduleNow.bind(ReportController))
);
router.post(
    '/reports/schedules/:id/toggle',
    requireManagerOrAdmin,
    requireNumericParam('id'),
    _ahD(ReportController.toggleSchedule.bind(ReportController))
);
// ---- end SECTION operations ----------------------------------------------------------------

// ---- SECTION access — Admin accounts & access governance (..25, ) ---------
// New verbs of the admin console. The pre-existing /admins/* lines above are
// untouched (`/admins/:id/delete` now answers as an alias of deactivate). The
// list-level GET/POST live under /admin/admin-accounts/… for two reasons:
// `/admins/:id` is registered earlier and would capture "export.csv" as an id
// (Postgres answered `pg_strtoint64_safe` on it), and `/admin/accounts/…` is
// the EMPLOYEE console — registered earlier too, so it would have shadowed
// these two lines entirely.
router.get(
    '/admin/admin-accounts/export.csv',
    requirePermission('manage_admins'),
    AdminController.exportCsv
);
router.post('/admin/admin-accounts/bulk', requirePermission('manage_admins'), AdminController.bulk);
router.post(
    '/admins/:id(\\d+)/deactivate',
    requirePermission('manage_admins'),
    AdminController.deactivate
);
router.post(
    '/admins/:id(\\d+)/reactivate',
    requirePermission('manage_admins'),
    AdminController.reactivate
);
router.post(
    '/admins/:id(\\d+)/sessions/revoke-all',
    requirePermission('manage_admins'),
    AdminController.revokeSessions
);
router.post('/admins/:id(\\d+)/mfa-reset', requireSuperAdmin, AdminController.resetMfa);
// 3.23.19: « Autoriser l'enrôlement MFA » — a ONE-TIME
// code (24 h, single use, hashed at rest, audited) that lets this admin sign in by
// SSO once to enrol TOTP. SuperAdmin only; never for a SuperAdmin target.
router.post(
    '/admins/:id(\\d+)/mfa-enrol-code',
    requireSuperAdmin,
    require('../utils/asyncHandler')(SsoController.issueEnrolCode)
);
// « Confirmer cette identité pour l'accès administrateur » (readiness report).
router.post(
    '/app-settings/sso/identities/:id(\\d+)/confirm-admin',
    requireSuperAdmin,
    require('../utils/asyncHandler')(async (req, res) => {
        const r = await require('../services/AdminSsoService').confirmIdentityForAdmin(
            req.params.id,
            req.user
        );
        // a SuperAdmin target is refused and said so.
        const key = r.ok
            ? 'flash:sso_identity_confirmed'
            : r.code === 'superadmin_target'
              ? 'flash:sso_identity_confirm_superadmin'
              : 'flash:sso_identity_confirm_failed';
        req.flash(
            r.ok ? 'success' : 'error',
            req.t
                ? req.t(key)
                : r.ok
                  ? 'Identité confirmée pour l’accès administrateur.'
                  : 'Identité non confirmée.'
        );
        res.redirect('/app-settings/sso#sso-readiness');
    })
);
// ---- end SECTION access ----------------------------------------------------------------

// ---- SECTION ux — canonical aliases for the URLs the docs and the brief use --------
// Both are pure redirects: one canonical route, one documented URL, no 404 from a
// bookmark or a copy-pasted link .
// `/account/my-access` is the English spelling of « Mon accès » used throughout
// the documentation; the page itself lives at /mon-acces.
router.get('/account/my-access', requireAuth, (req, res) => res.redirect(302, '/mon-acces'));
// `/action-center` is the old name of the merged Action Center + bell; the
// Notification Centre replaced it (v3.22.56/.57) and is the page people mean.
router.get('/action-center', requireAuth, (req, res) => res.redirect(302, '/notifications'));
// ---- end SECTION ux ----------------------------------------------------------------

module.exports = router;
