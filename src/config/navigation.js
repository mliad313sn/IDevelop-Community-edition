'use strict';
/**
 * The navigation config — one place that says WHERE a person can go.
 *
 * Every navigation surface reads this module:
 *   - the rail (views/partials/sidebar.ejs);
 *   - the breadcrumb trail (views/partials/breadcrumbs.ejs);
 *   - the quick-search palette (views/partials/command-palette.ejs);
 *   - the account menu (views/partials/header.ejs);
 *   - the contextual-help titles (public/js/help.js reads the glossary map the
 *     rail emits), so the rail, the page and its help use the same name.
 *
 * A destination is declared ONCE in CATALOGUE: its label key, tooltip key, URL,
 * icon, the path prefixes that make it the current entry, and whether it is a
 * work queue. The per-persona trees (SECTIONS, MY_OWN) only arrange catalogue
 * ids. Visibility is ONE predicate per id in `gates(ctx)`, written with the same
 * `can()` the route guards use (src/services/RBACService.hasPermission) and the
 * optional modules of Administration → Modules (res.locals.appModules, resolved
 * by src/services/ModuleService). A link never widens its route's gate: a module
 * that is off removes its entries (its routes answer 404), and a page whose route
 * would refuse the person is not offered.
 *
 * Label keys without a namespace are `chrome:` keys; a key with a namespace
 * (`talentx:f360_nav`) is used as it is, so a page keeps the name it already has.
 */
const workspaceComponents = require('./workspaceComponents');

/** localStorage key of the remembered fold state. Bumped once: every saved rail
 *  state from the previous menu (keyed on its old sections) is reset. */
const STORAGE_KEY = 'sidebarNav.v3';
/** Older keys, wiped on first run and on sign-out (shared computers). */
const LEGACY_STORAGE_KEYS = ['sidebarNav.v2', 'sidebarNav'];
/**
 * Every group of the rail opens folded: the group holding the current page is
 * always open (sidebar.ejs), and a group the person opened or closed keeps that
 * choice. A long rail of open groups put dozens of links and Tab stops before
 * the page itself.
 */
const CLOSED_BY_DEFAULT = [
    'section_my_team',
    'section_people',
    'section_assessments',
    'section_campaigns_assessments',
    'section_talent',
    'section_safety',
    'section_reports',
    'section_my_space',
    'section_reference',
    'section_system',
    'section_help',
];
/** A read-only account reads; its framework and reports open unfolded. */
const OPEN_FOR_READ_ONLY = ['section_reference', 'section_reports'];

/**
 * Destinations. `match`: path prefixes that make this entry the current one (the
 * longest matching prefix over the VISIBLE entries wins; `{ p, exact: true }`
 * only matches the path itself). `notMatch`: prefixes that never select it.
 * `queue`: a work queue — not shown to read-only accounts (navigation only; the
 * route gates are unchanged). `hub`: a disclosure button grouping sub-pages.
 */
const CATALOGUE = {
    // ── level 0 ────────────────────────────────────────────────────────────
    home: { label: 'nav_dashboard', title: 'nav_dashboard_title', icon: 'fa-house' },
    tasks: {
        label: 'nav_tasks',
        title: 'nav_tasks_title',
        href: '/tasks',
        icon: 'fa-list-check',
        queue: true,
    },

    // ── the person's own work (employee; a manager under « Mon espace ») ───
    my_assessment: {
        label: 'nav_my_assessments',
        title: 'nav_my_assessments_title',
        href: '/employee/self-assessment',
        icon: 'fa-clipboard-check',
    },
    my_status: {
        label: 'nav_my_status',
        title: 'nav_my_status_title',
        href: '/employee/assessment-status',
        icon: 'fa-hourglass-half',
    },
    my_manager_review: {
        label: 'employee:loop_nav_my_reviews',
        title: 'employee:loop_nav_my_reviews_title',
        href: '/employee/supervisor-reviews',
        icon: 'fa-comments',
        match: ['/employee/supervisor-reviews', '/employee/reviews'],
    },
    acr_mine: {
        label: 'nav_acr',
        title: 'nav_acr_title',
        href: '/assessment-changes',
        icon: 'fa-pen-to-square',
    },
    my_progress: {
        label: 'nav_my_progress',
        title: 'nav_my_progress_title',
        href: '/employee/my-progress',
        icon: 'fa-arrow-trend-up',
    },
    // The end-of-campaign record (4.0.0 port, wave 5): the person's own.
    my_review_record: {
        label: 'employee:rr_nav',
        title: 'employee:rr_nav_title',
        href: '/employee/review-record',
        icon: 'fa-file-signature',
    },
    my_development: {
        label: 'nav_my_plan',
        title: 'nav_my_development_title',
        href: '/employee/my-development',
        icon: 'fa-seedling',
        match: ['/employee/my-development', { p: '/v2/idp', exact: true }],
    },
    my_okr: {
        label: 'nav_my_okr',
        title: 'nav_my_okr_title',
        href: '/employee/okr',
        icon: 'fa-bullseye',
    },
    one_on_one: {
        label: 'growth:oo_nav',
        title: 'growth:oo_nav_title',
        href: '/one-on-one',
        icon: 'fa-comment-dots',
    },
    feedback360: {
        label: 'talentx:f360_nav',
        title: 'talentx:f360_nav_title',
        href: '/feedback-360',
        icon: 'fa-street-view',
        notMatch: ['/feedback-360/manage', '/feedback-360/rounds'],
    },
    my_coaching: {
        label: 'nav_my_coaching',
        title: 'nav_my_coaching_title',
        href: '/employee/my-coaching',
        icon: 'fa-hands-helping',
    },
    my_growth: {
        label: 'nav_my_growth',
        title: 'nav_my_growth_title',
        href: '/employee/opportunities',
        icon: 'fa-compass',
    },
    my_learning: {
        label: 'nav_my_learning',
        title: 'lms:ml_nav_title',
        href: '/employee/my-learning',
        icon: 'fa-graduation-cap',
    },
    my_certificates: {
        label: 'employee:cert_nav',
        title: 'employee:cert_nav_title',
        href: '/employee/my-certifications',
        icon: 'fa-id-badge',
    },
    safety_me: {
        label: 'nav_my_safety',
        title: 'nav_my_safety_title',
        href: '/safety-gate/me',
        icon: 'fa-shield-heart',
    },

    // ── people ─────────────────────────────────────────────────────────────
    employees: {
        label: 'nav_employees',
        title: 'nav_employees_title',
        href: '/employees',
        icon: 'fa-address-book',
    },
    skill_matrix: { label: 'nav_skill_matrix', href: '/skill-matrix', icon: 'fa-border-all' },
    team_roster: {
        label: 'nav_team_roster',
        title: 'nav_team_roster_title',
        href: '/supervisor/team',
        icon: 'fa-users',
    },
    gap: {
        label: 'nav_gap_analysis',
        title: 'nav_gap_analysis_title',
        href: '/supervisor/gap-analysis',
        icon: 'fa-chart-bar',
    },
    org_chart: {
        label: 'nav_org_chart',
        title: 'nav_org_chart_title',
        href: '/org-chart',
        icon: 'fa-sitemap',
    },
    accounts: {
        label: 'nav_accounts',
        title: 'nav_accounts_title',
        href: '/admin/accounts',
        icon: 'fa-paper-plane',
        match: ['/admin/accounts', '/admin/invitations'],
        queue: true,
    },
    onboarding: {
        label: 'nav_onboarding',
        title: 'nav_onboarding_title',
        href: '/onboarding',
        icon: 'fa-user-plus',
        queue: true,
    },
    lifecycle: {
        label: 'nav_lifecycle',
        title: 'nav_lifecycle_title',
        href: '/v2/lifecycle',
        icon: 'fa-user-gear',
        queue: true,
    },
    movements: {
        label: 'nav_movements',
        title: 'nav_movements_title',
        href: '/movements',
        icon: 'fa-right-left',
        queue: true,
    },

    // ── campaigns & assessments ────────────────────────────────────────────
    cycles: {
        label: 'section_campaigns',
        title: 'admin:cyc_nav_console',
        href: '/cycles',
        icon: 'fa-calendar-check',
        queue: true,
    },
    sa_reviews: {
        label: 'nav_sa_reviews',
        title: 'nav_sa_reviews_title',
        href: '/supervisor/self-assessment-reviews',
        icon: 'fa-inbox',
        queue: true,
    },
    acr: {
        label: 'nav_acr',
        title: 'nav_acr_title',
        href: '/assessment-changes',
        icon: 'fa-pen-to-square',
        queue: true,
    },
    post_reviews: {
        label: 'nav_post_reviews',
        title: 'nav_post_reviews_title',
        href: '/reviews/post-approval',
        icon: 'fa-clock-rotate-left',
        queue: true,
    },
    disputes: {
        label: 'nav_disputes',
        title: 'nav_disputes_title',
        href: '/v2/slf/disputes',
        icon: 'fa-gavel',
        queue: true,
    },

    // ── talent & development ───────────────────────────────────────────────
    nine_box: {
        label: 'nav_nine_box',
        title: 'nav_nine_box_title',
        href: '/talent/nine-box',
        icon: 'fa-table-cells-large',
    },
    nine_box_movements: {
        label: 'nav_nine_box_movements',
        title: 'nav_nine_box_movements_title',
        href: '/talent/nine-box/movements',
        icon: 'fa-arrows-up-down-left-right',
    },
    talent_actions: {
        label: 'nav_talent_actions',
        title: 'nav_talent_actions_title',
        href: '/talent/actions',
        icon: 'fa-clipboard-list',
        queue: true,
    },
    career_path: {
        label: 'nav_career_path',
        title: 'nav_career_path_title',
        href: '/talent/career-path',
        icon: 'fa-route',
    },
    dev_plans: {
        label: 'nav_dev_plans',
        title: 'nav_dev_plans_title',
        href: '/v2/idp/manage',
        icon: 'fa-diagram-project',
        match: ['/v2/idp/manage', '/v2/idp/new'],
        queue: true,
    },
    pip: {
        label: 'nav_pip',
        title: 'nav_pip_title',
        href: '/v2/pip',
        icon: 'fa-user-clock',
        queue: true,
    },
    coaching: {
        label: 'nav_coaching',
        title: 'nav_coaching_title',
        href: '/coaching/plans',
        icon: 'fa-people-arrows',
        match: ['/coaching'],
        queue: true,
    },
    f360_console: {
        label: 'talentx:f360_nav_console',
        title: 'talentx:f360_nav_console_title',
        href: '/feedback-360/manage',
        icon: 'fa-users-viewfinder',
        match: ['/feedback-360/manage', '/feedback-360/rounds'],
    },
    cancellations: {
        label: 'nav_cancellations',
        title: 'nav_cancellations_title',
        href: '/cancellations',
        icon: 'fa-ban',
        queue: true,
    },
    continuity: {
        label: 'nav_continuity',
        title: 'nav_continuity_title',
        href: '/v2/continuity',
        icon: 'fa-people-roof',
    },
    key_people: {
        label: 'exec:kp_title',
        title: 'exec:kp_subtitle',
        href: '/exec/key-person',
        icon: 'fa-user-shield',
    },
    talent_suite: {
        label: 'nav_talent_suite',
        title: 'nav_talent_suite_title',
        href: '/v2/cap',
        icon: 'fa-layer-group',
        match: ['/v2/cap'],
        // The person's own diversity data lives under /v2/cap but is core and
        // personal (account menu), not a page of the talent suite.
        notMatch: ['/v2/cap/my-diversity'],
    },
    lms_hub: {
        label: 'nav_lms_hub',
        title: 'nav_lms_hub_title',
        href: '/v2/lms',
        icon: 'fa-plug',
        notMatch: ['/v2/lms/uplifts'],
    },

    // ── safety & compliance ────────────────────────────────────────────────
    safety_gate: {
        label: 'nav_safety_gate',
        title: 'nav_safety_gate_title',
        href: '/safety-gate',
        icon: 'fa-helmet-safety',
        notMatch: ['/safety-gate/me'],
    },
    safety_rules: {
        label: 'nav_safety_rules',
        title: 'nav_safety_rules_title',
        href: '/safety-gate/config',
        icon: 'fa-scale-balanced',
    },
    compliance: {
        label: 'nav_compliance',
        title: 'nav_compliance_title',
        href: '/compliance',
        icon: 'fa-file-shield',
    },
    qualified: {
        label: 'nav_qualified',
        title: 'nav_qualified_title',
        href: '/qualified',
        icon: 'fa-user-check',
    },
    lms_uplifts: {
        label: 'nav_lms_uplifts',
        title: 'nav_lms_uplifts_title',
        href: '/v2/lms/uplifts',
        icon: 'fa-award',
        queue: true,
    },

    // ── reports ────────────────────────────────────────────────────────────
    // A manager's home is the team view; the organisation indicators stay one
    // click away under « Rapports ». An admin's home IS the indicators page.
    indicators: {
        label: 'nav_indicators',
        title: 'nav_indicators_title',
        href: '/dashboard',
        icon: 'fa-chart-pie',
        match: [{ p: '/dashboard', exact: true }],
    },
    reports: {
        label: 'nav_reports',
        title: 'nav_reports_title',
        href: '/reports/builder',
        icon: 'fa-file-lines',
        match: ['/reports/builder', '/reports'],
    },
    report_schedules: {
        label: 'nav_report_schedules',
        title: 'nav_report_schedules_title',
        href: '/reports/schedules',
        icon: 'fa-calendar-days',
    },
    dept_analytics: {
        label: 'nav_dept_analytics',
        title: 'nav_dept_analytics_title',
        href: '/reports/dept-analytics',
        icon: 'fa-chart-column',
    },
    dept_brief: {
        label: 'nav_dept_brief',
        title: 'nav_dept_brief_title',
        href: '/reports/dept-brief',
        icon: 'fa-file-invoice',
    },
    gaps_report: {
        label: 'nav_gaps_report',
        title: 'nav_gaps_report_title',
        href: '/reports/gaps',
        icon: 'fa-chart-simple',
    },
    readiness: {
        label: 'nav_readiness',
        title: 'nav_readiness_title',
        href: '/reports/readiness',
        icon: 'fa-gauge-high',
    },
    benchmark: { label: 'nav_benchmark', href: '/benchmark', icon: 'fa-table-cells' },
    // The indicator definitions of the KPI module (KpiGlossaryController).
    kpi_glossary: {
        label: 'nav_kpi_glossary',
        title: 'nav_kpi_glossary_title',
        href: '/kpi/glossary',
        icon: 'fa-calculator',
    },
    // The targets of the indicators and their alerts (KpiTargetController).
    kpi_targets: {
        label: 'nav_kpi_targets',
        title: 'nav_kpi_targets_title',
        href: '/kpi/targets',
        // fa-bullseye is the person's own objectives (my_okr)
        icon: 'fa-crosshairs',
    },
    site_exposure: {
        label: 'exec:se_title',
        title: 'exec:se_subtitle',
        href: '/exec/site-exposure',
        icon: 'fa-map-location-dot',
    },
    board_pack: {
        label: 'exec:bp_title',
        title: 'exec:bp_subtitle',
        href: '/exec/board-pack',
        icon: 'fa-briefcase',
    },
    // The decisions taken on a pack and their follow-up (BoardDecisionController):
    // reachable before only from a link inside the pack.
    board_decisions: {
        label: 'exec:bd_title',
        title: 'exec:bd_nav_title',
        href: '/exec/decisions',
        icon: 'fa-stamp',
    },
    local_content: { label: 'nav_local_content', href: '/reports/local-content', icon: 'fa-flag' },

    // ── framework & settings ───────────────────────────────────────────────
    organization: { label: 'nav_organization', href: '/organization', icon: 'fa-building' },
    domains_skills: {
        label: 'nav_domains_skills',
        href: '/domains-skills',
        icon: 'fa-cubes',
        match: ['/domains-skills', '/domains', '/skills'],
    },
    roles: { label: 'nav_roles', href: '/roles', icon: 'fa-user-tie' },
    data_management: {
        label: 'nav_data_management',
        href: '/data-management',
        icon: 'fa-database',
    },
    admins: { label: 'nav_admins', href: '/admins', icon: 'fa-shield-halved' },
    delegation: {
        label: 'nav_delegation',
        title: 'nav_delegation_title',
        href: '/admin/delegation',
        icon: 'fa-share-nodes',
    },
    system_logs: { label: 'nav_system_logs', href: '/system-logs', icon: 'fa-scroll' },
    // 4.0.0 port (wave 10): the counts that keep the indicators from being
    // measured, and the use of the product per site (not the module stages).
    data_quality: {
        label: 'nav_data_quality',
        title: 'nav_data_quality_title',
        href: '/admin/data-quality',
        icon: 'fa-stethoscope',
    },
    usage: {
        label: 'nav_usage',
        title: 'nav_usage_title',
        href: '/admin/usage',
        icon: 'fa-users-line',
    },
    settings: {
        label: 'nav_settings',
        title: 'nav_settings_title',
        href: '/app-settings',
        icon: 'fa-gear',
    },

    // ── system administration (SuperAdmin) ─────────────────────────────────
    hub_access: { label: 'nav_hub_access', icon: 'fa-lock', hub: true },
    hub_platform: { label: 'nav_hub_platform', icon: 'fa-server', hub: true },
    sso: { label: 'nav_sso', href: '/app-settings/sso', icon: 'fa-right-to-bracket' },
    sso_migration: { label: 'nav_sso_migration', href: '/admin/sso-migration', icon: 'fa-shuffle' },
    access_review: {
        label: 'nav_access_review',
        href: '/admin/access-review',
        icon: 'fa-user-lock',
    },
    sessions: {
        label: 'nav_session_monitor',
        href: '/admin/sessions',
        icon: 'fa-tower-observation',
    },
    approvals: {
        label: 'nav_approvals',
        title: 'nav_approvals_title',
        href: '/v2/uam/maker-checker/queue',
        icon: 'fa-check-double',
        match: ['/v2/uam/maker-checker'],
    },
    api_keys: {
        label: 'nav_api_keys',
        title: 'nav_api_keys_title',
        href: '/admin/api-keys',
        icon: 'fa-key',
    },
    modules_admin: {
        label: 'nav_modules',
        title: 'nav_modules_title',
        href: '/admin/modules',
        icon: 'fa-toggle-on',
    },
    hris: {
        label: 'nav_hris',
        title: 'nav_hris_title',
        href: '/admin/integrations/hris',
        icon: 'fa-arrows-rotate',
    },
    health: { label: 'nav_health', href: '/admin/health', icon: 'fa-heart-pulse' },
    maintenance: {
        label: 'nav_maintenance',
        href: '/admin/maintenance',
        icon: 'fa-screwdriver-wrench',
    },
    admin_notifications: {
        label: 'admin:notif_nav',
        href: '/admin/notifications',
        icon: 'fa-envelope-open-text',
    },
    notif_catalogue: {
        label: 'nav_notif_catalogue',
        title: 'nav_notif_catalogue_title',
        href: '/admin/notifications/catalogue',
        icon: 'fa-rectangle-list',
    },
    notif_metrics: {
        label: 'nav_notif_metrics',
        title: 'nav_notif_metrics_title',
        href: '/admin/notifications/metrics',
        icon: 'fa-chart-line',
    },
    sql_console: {
        label: 'nav_sql_console',
        title: 'nav_sql_console_title',
        href: '/data-management/sql-console',
        icon: 'fa-terminal',
    },
    license: { label: 'nav_license', href: '/admin/license', icon: 'fa-certificate' },
    setup: { label: 'nav_setup', title: 'nav_setup_title', href: '/setup', icon: 'fa-rocket' },
    // The same checklist, read-only, for an administrator who is not a
    // SuperAdmin (4.0.0 port, wave 10): one href, so the quick search and the
    // breadcrumbs list it once; only one of the two is ever visible.
    setup_readonly: {
        label: 'nav_setup',
        title: 'nav_setup_readonly_title',
        href: '/setup',
        icon: 'fa-rocket',
    },

    // ── help ───────────────────────────────────────────────────────────────
    guide: { label: 'nav_help', title: 'nav_guide', href: '/guide', icon: 'fa-circle-question' },
    about: { label: 'nav_about', href: '/about', icon: 'fa-circle-info' },
};

/** The account menu (header) — also indexed by the palette; one list, one order. */
const ACCOUNT_MENU = [
    { id: 'my_profile', label: 'menu_my_profile', href: '/account', icon: 'fa-user' },
    {
        id: 'my_access',
        label: 'admin:acc_menu_my_access',
        href: '/mon-acces',
        icon: 'fa-id-card',
        visible: (c) => c.isAdm,
    },
    {
        id: 'notif_prefs',
        label: 'nav_notif_prefs',
        href: '/account/notifications',
        icon: 'fa-bell-concierge',
    },
    // The archive of the person's « What changed » summaries (DigestController).
    { id: 'my_digests', label: 'nav_my_digests', href: '/digests', icon: 'fa-newspaper' },
    {
        id: 'change_password',
        label: 'menu_change_password',
        href: '/change-password',
        icon: 'fa-key',
        visible: (c) => c.passwordChangeAllowed,
    },
    {
        id: 'two_factor',
        label: 'menu_two_factor',
        href: '/v2/uam/mfa/manage',
        icon: 'fa-shield-halved',
    },
    {
        id: 'my_sessions',
        label: 'menu_active_sessions',
        href: '/account/sessions',
        icon: 'fa-desktop',
    },
    // The person's OWN data register (route requireEmployeeOrManager).
    {
        id: 'my_data',
        label: 'compliance:mydata_nav',
        href: '/employee/my-data',
        icon: 'fa-fingerprint',
        visible: (c) => c.isEmp || c.isMgr,
    },
    // Consent and withdrawal stay reachable whatever the talent module says.
    {
        id: 'my_diversity',
        label: 'talentx:dei_my_title',
        href: '/v2/cap/my-diversity',
        icon: 'fa-people-group',
        visible: (c) => c.isEmp || c.isMgr,
    },
    { id: 'notifications', label: 'nav_notifications', href: '/notifications', icon: 'fa-bell' },
];

// ── context ──────────────────────────────────────────────────────────────────

const COMPONENT = new Map(workspaceComponents.COMPONENTS.map((c) => [c.key, c]));

/** Where « Tableau de bord » leads for this person (the sign-in landing page). */
function homeUrl(user) {
    const u = user || {};
    if (u.userType === 'employee') return '/employee/dashboard';
    if (u.userType === 'manager') return '/supervisor/dashboard';
    return '/dashboard';
}

/** Resolve a label key: bare keys are chrome:, namespaced keys are used as they are. */
function i18nKey(k) {
    const s = String(k || '');
    return s.includes(':') ? s : 'chrome:' + s;
}

/**
 * Build the evaluation context from view locals (res.locals): user, can(),
 * wsVisible(), appModules, featureLocalContent, sqlConsoleEnabled, currentPath
 * and passwordChangeAllowed.
 */
function buildContext(locals) {
    const L = locals || {};
    const user = L.user || {};
    const ut = user.userType;
    const isEmp = ut === 'employee';
    const isMgr = ut === 'manager';
    const isAdm = ut === 'admin';
    const can = (s) => typeof L.can === 'function' && !!L.can(s);
    const wsRaw = (k) => typeof L.wsVisible !== 'function' || !!L.wsVisible(k);
    const prefsRaw = user.workspacePrefs || user.workspace_prefs || {};
    const prefs =
        prefsRaw && typeof prefsRaw === 'object' && !Array.isArray(prefsRaw) ? prefsRaw : {};
    /**
     * An administration / configuration link is hidden only when a SuperAdmin
     * EXPLICITLY hid that workspace component for this admin. The permission-aware
     * DEFAULT of the component is not stacked on top of the link's own permission
     * gate: it hid « Gestion des données » from an exporter and « Comptes &
     * invitations » from an inviter, while their routes let them in.
     */
    const wsExplicit = (k) => {
        if (wsRaw(k)) return true;
        if (prefs[k] === false) return false;
        const comp = COMPONENT.get(k);
        return !!(comp && comp.permAny && comp.permAny.length);
    };
    const modules = L.appModules && typeof L.appModules === 'object' ? L.appModules : {};
    const path = typeof L.currentPath === 'string' ? L.currentPath : '';
    return {
        user,
        isEmp,
        isMgr,
        isAdm,
        sa: isAdm && user.role === 'superadmin',
        viewer: isAdm && user.role === 'viewer',
        can,
        ws: wsRaw,
        wsExplicit,
        // Optional modules (Administration → Modules): strict `true` only.
        mod: (k) => modules[k] === true,
        lc: !!L.featureLocalContent,
        sqlConsole: L.sqlConsoleEnabled === true,
        path,
        passwordChangeAllowed: L.passwordChangeAllowed !== false,
    };
}

/**
 * One visibility predicate per catalogue id: the section gate AND the link gate
 * the route carries, AND the module that owns the route (config/modules.js
 * MODULE_PREFIXES) when there is one.
 */
function gates(c) {
    const { isEmp, isMgr, isAdm, sa, can, mod, lc } = c;
    const gMain = !isEmp && c.ws('nav:main');
    const gMainDash = gMain && (isMgr || isAdm);
    const gPeople = gMain && (isMgr || (isAdm && can('view_employees')));
    const gMine = isEmp || isMgr;
    const gTeam = (isMgr || isAdm) && c.ws('nav:team');
    const gTalent = (isMgr || isAdm) && c.ws('nav:talent');
    const gTools = (isAdm || isMgr) && c.ws('nav:tools');
    const canCont =
        isMgr ||
        can('view_continuity') ||
        can('manage_succession') ||
        can('view_retention_risk') ||
        can('manage_handover');
    const canLms = isMgr || can('configure_lms');
    const capHub = mod('talent') || mod('mobility') || mod('engagement') || mod('ai');
    // Administration / configuration: per-link permission + explicit workspace hide.
    const wsAdm = isAdm && c.wsExplicit('nav:administration');
    const wsCfg = isAdm && c.wsExplicit('nav:configuration');
    const admCamp = wsAdm && (can('manage_cycles') || sa);
    return {
        // Always first; a hidden nav:main hides the analytics, never the entry.
        home: true,
        // Managers and admins who can act (read-only accounts: `queue`).
        tasks: isMgr || isAdm,

        my_assessment: gMine,
        my_status: gMine,
        my_manager_review: gMine,
        acr_mine: isEmp, // a manager decides it under « Évaluations »
        my_progress: gMine,
        my_review_record: gMine,
        my_development: gMine,
        my_okr: gMine && mod('engagement'),
        one_on_one: gMine && mod('engagement'),
        feedback360: gMine && mod('development'),
        my_coaching: gMine && mod('development'),
        my_growth: gMine && (mod('mobility') || mod('engagement')),
        my_learning: gMine,
        my_certificates: gMine,
        safety_me: gMine,

        employees: gPeople,
        skill_matrix: gPeople,
        // « My team »: the named roster behind the manager's dashboard
        team_roster: isMgr && c.ws('nav:team'),
        gap: gTeam,
        org_chart: gTalent,
        accounts: wsAdm && can('manage_invitations'),
        onboarding: wsAdm && can('manage_onboarding'),
        lifecycle: gTalent && mod('mobility'),
        movements: gTools,

        cycles: wsAdm && can('manage_cycles') && mod('campaigns'),
        sa_reviews: gTeam,
        acr: isMgr || admCamp,
        post_reviews: admCamp || (gTools && isMgr),
        // Core: the disputes router is always mounted.
        disputes: gTeam,

        nine_box: gTalent,
        // Same audience as the grid (route requireManagerOrAdmin).
        nine_box_movements: gTalent,
        talent_actions: gTalent,
        career_path: gTalent,
        dev_plans: gTeam && mod('development'),
        pip: gTeam && mod('development'),
        coaching: gTeam && mod('development'),
        f360_console: gTeam && mod('development'),
        cancellations: admCamp || (gTools && isMgr),
        continuity: gTalent && mod('talent') && canCont,
        key_people: gTalent && mod('talent') && canCont,
        talent_suite: gTalent && capHub && canLms,
        lms_hub: gTalent && mod('development') && canLms && can('configure_lms'),

        // Managers too: the route admits them (requireManagerOrAnyPermission).
        safety_gate:
            gTools && (isMgr || (isAdm && (can('view_compliance') || can('manage_compliance')))),
        // Route: requirePermission('manage_compliance').
        safety_rules: gTools && isAdm && can('manage_compliance'),
        compliance: gTools && (isMgr || can('view_compliance')),
        qualified: gTools,
        // Mounted under /v2/lms (development module); who may decide is the
        // service's own rule, the page says so when nothing is waiting.
        lms_uplifts: gTools && mod('development') && canLms,

        indicators: gMainDash && isMgr,
        reports: gTools,
        // requireManagerOrAdmin, like the builder.
        report_schedules: gTools,
        dept_analytics: gTools,
        dept_brief: gTools,
        gaps_report: gTools,
        readiness: gTools,
        // Route requireManagerOrAdmin, like the reports; the page itself
        // leaves out the indicators of a module that is off.
        kpi_glossary: gTools,
        // Route requireAdmin (read); a decision needs manage_kpi_targets.
        kpi_targets: gTools && isAdm,
        benchmark: gMainDash,
        site_exposure: gMainDash,
        board_pack: gMainDash,
        // The same mount as the pack (routes/exec.js); writing is the service's check.
        board_decisions: gMainDash,
        // Nationality by unit: SuperAdmin or view_local_content only (the
        // controller refuses everyone else), and only with the module on.
        local_content: gTools && lc && isAdm && can('view_local_content'),

        organization: wsCfg && can('manage_organization'),
        domains_skills: wsCfg && can('view_domains_skills'),
        roles: wsCfg && can('view_roles'),
        // Shown iff export_data || import_data (route requireAnyPermission).
        data_management: wsAdm && (can('export_data') || can('import_data')),
        admins: wsAdm && can('manage_admins'),
        delegation: wsAdm && can('manage_admins'),
        system_logs: wsAdm && can('view_system_logs'),
        // Route: requireAnyPermission(DataQualityService.PANEL_SLUGS); SuperAdmin passes.
        data_quality:
            wsAdm &&
            (sa ||
                [
                    'view_employees',
                    'view_domains_skills',
                    'view_roles',
                    'view_compliance',
                    'manage_compliance',
                    'view_system_logs',
                ].some((s) => can(s))),
        // Route: requireAdmin + requirePermission('view_employees').
        usage: wsAdm && can('view_employees'),
        settings: wsCfg && can('view_app_settings'),

        hub_access: true,
        hub_platform: true,
        sso: wsCfg && sa,
        sso_migration: wsAdm && sa,
        access_review: wsAdm && sa,
        sessions: wsAdm && sa,
        // Core: the two-person rule queue is always mounted.
        approvals: admCamp && sa,
        api_keys: wsCfg && sa,
        modules_admin: wsCfg && sa,
        hris: wsCfg && sa,
        health: wsCfg && sa,
        maintenance: wsCfg && sa,
        admin_notifications: wsAdm && sa,
        notif_catalogue: wsAdm && sa,
        notif_metrics: wsAdm && sa,
        // An operator switch (SQL_CONSOLE_ENABLED=1): its routes answer 404 when off.
        sql_console: wsAdm && sa && c.sqlConsole,
        license: wsCfg && sa,
        setup: wsCfg && sa,
        // Route: requireAdmin; the page is read-only for them (scoped counts,
        // no SuperAdmin link, no dismiss).
        setup_readonly: wsCfg && !sa,

        guide: true,
        about: true,
    };
}

// ── trees ────────────────────────────────────────────────────────────────────
// [id, [children…]] = an entry with a sub-list; a bare id = a plain entry.

const MY_OWN = [
    [
        'my_assessment',
        ['my_status', 'my_manager_review', 'acr_mine', 'my_progress', 'my_review_record'],
    ],
    ['my_development', ['my_okr', 'one_on_one', 'feedback360', 'my_coaching', 'my_growth']],
    ['my_learning', ['my_certificates']],
    'safety_me',
];
const HELP = [['guide', ['about']]];

const TALENT_MGR = [
    ['nine_box', ['nine_box_movements', 'talent_actions', 'career_path']],
    'dev_plans',
    'pip',
    'coaching',
    'f360_console',
    'cancellations',
    ['continuity', ['key_people', 'lifecycle']],
    ['talent_suite', ['lms_hub']],
];
const TALENT_ADM = [
    ['nine_box', ['nine_box_movements', 'talent_actions', 'career_path']],
    'dev_plans',
    'pip',
    'coaching',
    'f360_console',
    'cancellations',
    ['continuity', ['key_people']],
    ['talent_suite', ['lms_hub']],
];
const REPORTS = [
    ['indicators', ['site_exposure', 'board_pack', 'board_decisions']],
    ['reports', ['report_schedules']],
    'dept_analytics',
    'dept_brief',
    'gaps_report',
    'readiness',
    'kpi_glossary',
    'benchmark',
    'local_content',
];

const SECTIONS = {
    manager: {
        section_my_team: ['team_roster', ['employees', ['skill_matrix']], 'gap', 'org_chart'],
        section_assessments: ['sa_reviews', 'acr', 'post_reviews', 'disputes'],
        section_talent: TALENT_MGR,
        section_safety: [
            ['safety_gate', ['safety_rules']],
            'compliance',
            'qualified',
            'lms_uplifts',
            'movements',
        ],
        section_reports: REPORTS,
        section_my_space: MY_OWN,
        section_help: HELP,
    },
    admin: {
        section_people: [
            ['employees', ['skill_matrix']],
            'org_chart',
            'accounts',
            'onboarding',
            'lifecycle',
            'movements',
        ],
        section_campaigns_assessments: [
            'cycles',
            'sa_reviews',
            'acr',
            'post_reviews',
            'disputes',
            'gap',
        ],
        section_talent: TALENT_ADM,
        section_safety: [
            ['safety_gate', ['safety_rules']],
            'compliance',
            'qualified',
            'lms_uplifts',
        ],
        // An admin's home is the indicators page: its two decision surfaces
        // (site exposure, board pack) are plain entries here.
        section_reports: [
            ['reports', ['report_schedules']],
            'dept_analytics',
            'dept_brief',
            'gaps_report',
            'readiness',
            'kpi_glossary',
            'kpi_targets',
            'benchmark',
            'site_exposure',
            ['board_pack', ['board_decisions']],
            'local_content',
        ],
        section_reference: [
            'organization',
            'domains_skills',
            'roles',
            'data_management',
            'admins',
            'delegation',
            'system_logs',
            ['data_quality', ['usage']],
            'settings',
            'setup_readonly',
        ],
        section_system: [
            [
                'hub_access',
                ['sso', 'sso_migration', 'access_review', 'sessions', 'approvals', 'api_keys'],
            ],
            [
                'hub_platform',
                [
                    'modules_admin',
                    'hris',
                    'health',
                    'maintenance',
                    'admin_notifications',
                    'notif_catalogue',
                    'notif_metrics',
                    'sql_console',
                    'license',
                    'setup',
                ],
            ],
        ],
        section_help: HELP,
    },
};

/** Section order per persona. */
function sectionOrder(c) {
    if (c.isMgr) {
        return [
            'section_my_team',
            'section_assessments',
            'section_talent',
            'section_safety',
            'section_reports',
            'section_my_space',
            'section_help',
        ];
    }
    if (c.viewer) {
        // An auditor (holds the activity logs) reads safety and the framework
        // first; another read-only account reads the reports first.
        return c.can('view_system_logs')
            ? [
                  'section_safety',
                  'section_reports',
                  'section_talent',
                  'section_reference',
                  'section_people',
                  'section_campaigns_assessments',
                  'section_help',
              ]
            : [
                  'section_reports',
                  'section_talent',
                  'section_safety',
                  'section_people',
                  'section_campaigns_assessments',
                  'section_reference',
                  'section_help',
              ];
    }
    const base = [
        'section_people',
        'section_campaigns_assessments',
        'section_talent',
        'section_safety',
        'section_reports',
        'section_reference',
        'section_system',
        'section_help',
    ];
    // A compliance holder without campaign or invitation work starts with safety.
    const hse =
        (c.can('view_compliance') || c.can('manage_compliance')) &&
        !c.can('manage_cycles') &&
        !c.can('manage_invitations');
    if (hse) return ['section_safety', ...base.filter((s) => s !== 'section_safety')];
    return base;
}

function pick(id) {
    const def = CATALOGUE[id];
    if (!def) throw new Error('navigation: unknown id ' + id);
    return def;
}

function node(id, def, c, children) {
    const href = id === 'home' ? homeUrl(c.user) : def.href || null;
    return {
        id,
        labelKey: i18nKey(def.label),
        titleKey: i18nKey(def.title || def.label),
        href,
        icon: def.icon,
        hub: !!def.hub,
        queue: !!def.queue,
        children: children || [],
    };
}

/** Turn a tree spec into visible nodes; a hidden parent hands its children up. */
function materialise(spec, vis, c) {
    const out = [];
    for (const item of spec) {
        const id = Array.isArray(item) ? item[0] : item;
        const kids = Array.isArray(item) ? materialise(item[1], vis, c) : [];
        const def = pick(id);
        const shown = vis[id] && !(c.viewer && def.queue);
        if (def.hub) {
            if (kids.length) out.push(node(id, def, c, kids));
            continue;
        }
        if (shown) out.push(node(id, def, c, kids));
        else out.push(...kids);
    }
    return out;
}

/** Match spec for an entry: [{ p, exact }]. */
function matchesOf(n) {
    if (n.id === 'home') return [{ p: String(n.href).split('#')[0], exact: true }];
    const def = CATALOGUE[n.id];
    const raw = def.match || (n.href ? [n.href] : []);
    return raw.map((m) => (typeof m === 'string' ? { p: m, exact: false } : m));
}

function walk(nodes, fn, parents = []) {
    for (const n of nodes) {
        fn(n, parents);
        if (n.children.length) walk(n.children, fn, parents.concat(n));
    }
}

/** Mark the current entry (longest matching prefix) and the chain that holds it. */
function markActive(tree, c) {
    const path = c.path || '';
    let best = null;
    const consider = (n, parents, section) => {
        const def = CATALOGUE[n.id];
        if (def && def.notMatch && def.notMatch.some((p) => path === p || path.startsWith(p + '/')))
            return;
        for (const m of matchesOf(n)) {
            const hit = m.exact ? path === m.p : path === m.p || path.startsWith(m.p + '/');
            if (hit && (!best || m.p.length > best.len)) {
                best = { node: n, parents, section, len: m.p.length, exact: path === m.p };
            }
        }
    };
    for (const top of tree) {
        if (top.type === 'section') walk(top.items, (n, p) => consider(n, p, top));
        else walk([top], (n, p) => consider(n, p, null));
    }
    if (!best) return null;
    best.node.active = true;
    best.node.current = best.exact ? 'page' : 'true';
    for (const p of best.parents) p.open = true;
    if (best.section) best.section.hasCurrent = true;
    return best;
}

/**
 * The visible rail for this person: an ordered list of
 *   { type:'link', …node }  (level 0: Tableau de bord, À traiter; employee entries)
 *   { type:'section', key, labelKey, closedByDefault, items:[node…] }
 * where node = { id, labelKey, titleKey, href, icon, hub, children, active, current, open }.
 */
function buildNav(locals) {
    const c = buildContext(locals);
    const vis = gates(c);
    const tree = [];
    tree.push({ type: 'link', ...node('home', CATALOGUE.home, c, []) });
    if (c.isEmp) {
        // A flat list for the frontline (no group header), help last.
        for (const n of materialise(MY_OWN, vis, c)) tree.push({ type: 'link', ...n });
        for (const n of materialise(HELP, vis, c)) tree.push({ type: 'link', ...n });
    } else {
        if (vis.tasks && !c.viewer)
            tree.push({ type: 'link', ...node('tasks', CATALOGUE.tasks, c, []) });
        const persona = c.isMgr ? 'manager' : 'admin';
        for (const key of sectionOrder(c)) {
            const spec = SECTIONS[persona][key];
            if (!spec) continue;
            if (key === 'section_system' && !c.sa) continue;
            const items = materialise(spec, vis, c);
            if (!items.length) continue;
            tree.push({
                type: 'section',
                key,
                labelKey: i18nKey(key),
                // Folded unless it holds the current page (sidebar.ejs); a
                // read-only account's framework and reports open by default.
                closedByDefault:
                    CLOSED_BY_DEFAULT.includes(key) &&
                    !(c.viewer && OPEN_FOR_READ_ONLY.includes(key)),
                items,
            });
        }
    }
    const active = markActive(tree, c);
    return {
        tree,
        active,
        ctx: c,
        storageKey: STORAGE_KEY,
        legacyStorageKeys: LEGACY_STORAGE_KEYS,
    };
}

/** Every visible link, depth-first (section → entry → sub-entry), with its section. */
function flatten(nav) {
    const out = [];
    for (const top of nav.tree) {
        if (top.type === 'section')
            walk(top.items, (n, parents) => out.push({ node: n, section: top, parents }));
        else walk([top], (n, parents) => out.push({ node: n, section: null, parents }));
    }
    return out.filter((x) => x.node.href);
}

/**
 * Breadcrumb trail: Tableau de bord › <section> › <entry> › <page>.
 * Returns null when the current page is not reached through the rail.
 * Items: { labelKey | label, href|null, current }.
 */
function trail(locals, pageTitle) {
    const nav = buildNav(locals);
    const home = nav.tree[0];
    const a = nav.active;
    if (!a || a.node.id === 'home') return null;
    const out = [{ labelKey: 'chrome:nav_breadcrumb_root', href: home.href }];
    if (a.section) out.push({ labelKey: a.section.labelKey, href: null });
    for (const p of a.parents) out.push({ labelKey: p.labelKey, href: p.href || null });
    out.push({ labelKey: a.node.labelKey, href: a.node.href });
    if (!a.exact && pageTitle) out.push({ label: String(pageTitle), href: null });
    const last = out[out.length - 1];
    last.current = true;
    last.href = null;
    return out;
}

/** The account menu entries this person may see (header). */
function accountMenu(locals) {
    const c = buildContext(locals);
    return ACCOUNT_MENU.filter((m) => !m.visible || m.visible(c)).map((m) => ({
        id: m.id,
        labelKey: i18nKey(m.label),
        href: m.href,
        icon: m.icon,
    }));
}

/** Palette index: every rail destination this person sees + the account menu. */
function paletteIndex(locals) {
    const nav = buildNav(locals);
    const pages = flatten(nav).map(({ node: n, section }) => ({
        labelKey: n.labelKey,
        groupKey: section ? section.labelKey : 'chrome:nav_dashboard',
        href: n.href,
        icon: 'fas ' + n.icon,
    }));
    const account = accountMenu(locals).map((m) => ({
        labelKey: m.labelKey,
        groupKey: 'chrome:nav_palette_account',
        href: m.href,
        icon: 'fas ' + m.icon,
    }));
    return pages.concat(account);
}

/**
 * path → label key, for EVERY catalogue destination (help titles). Persona homes
 * all map to « Tableau de bord ». Given the view locals, the local-content page
 * is left out while its module is off — no trace of it in the page.
 */
function glossaryMap(locals) {
    const out = new Map([
        ['/employee/dashboard', 'chrome:nav_dashboard'],
        ['/supervisor/dashboard', 'chrome:nav_dashboard'],
        ['/dashboard', 'chrome:nav_dashboard'],
    ]);
    for (const def of Object.values(CATALOGUE)) {
        if (def.href && !out.has(def.href)) out.set(def.href, i18nKey(def.label));
    }
    for (const m of ACCOUNT_MENU) if (!out.has(m.href)) out.set(m.href, i18nKey(m.label));
    if (locals && !locals.featureLocalContent) out.delete(CATALOGUE.local_content.href);
    return out;
}

/**
 * A short, non-reversible tag of WHO the remembered fold state belongs to. On a
 * shared computer the next person signing in gets the defaults, not the previous
 * person's open menus — whatever ended the previous session.
 */
function ownerTag(user) {
    const u = user || {};
    const s = `${u.userType || ''}:${u.id || ''}:${u.username || u.employeeNumber || ''}`;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

module.exports = {
    STORAGE_KEY,
    LEGACY_STORAGE_KEYS,
    CLOSED_BY_DEFAULT,
    OPEN_FOR_READ_ONLY,
    CATALOGUE,
    ACCOUNT_MENU,
    SECTIONS,
    MY_OWN,
    homeUrl,
    i18nKey,
    buildContext,
    gates,
    sectionOrder,
    buildNav,
    flatten,
    trail,
    paletteIndex,
    accountMenu,
    glossaryMap,
    ownerTag,
};
