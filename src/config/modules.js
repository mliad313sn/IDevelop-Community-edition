'use strict';
/**
 * Optional modules and adoption stages — pure data, no I/O.
 *
 * The talent suite used to be switched on by one boot-time environment
 * variable (V2_FEATURES=1) that an HR administrator could not reach. Each
 * optional module is now a setting stored in the database and switched from
 * /admin/modules, without a restart. src/services/ModuleService.js resolves
 * the effective state; this file only says WHAT the modules are.
 *
 * CORE — never gated by a module (EntitlementService.CORE_FEATURES says the
 * same for the licence): the framework, roles, self-assessments, reviews and
 * disputes, readiness, gaps, the 9-box grid, the person's own development
 * plan, reports, SSO, access management (MFA, maker-checker) and the GDPR /
 * webhook administration. CORE_PREFIXES lists their routes; a test checks that
 * no module path overlaps them.
 */

/** Every module, in display order. `localContent` reuses its historical key. */
const MODULE_KEYS = Object.freeze([
    'campaigns',
    'development',
    'talent',
    'mobility',
    'engagement',
    'ai',
    'localContent',
]);

/** The database setting behind each module. */
const SETTING_KEYS = Object.freeze({
    campaigns: 'modules.campaigns',
    development: 'modules.development',
    talent: 'modules.talent',
    mobility: 'modules.mobility',
    engagement: 'modules.engagement',
    ai: 'modules.ai',
    // Pre-existing optional module (migration 45): its key is kept so an
    // install that already switched it on keeps it on.
    localContent: 'featureLocalContent',
});

/** The modules a stage preset decides. localContent is a regional option,
 *  independent of the stage (it was never behind V2_FEATURES either). */
const STAGED_MODULES = Object.freeze([
    'campaigns',
    'development',
    'talent',
    'mobility',
    'engagement',
    'ai',
]);

const STAGE_KEY = 'adoption.stage';
const STAGES = Object.freeze(['1', '2', '3', 'custom']);

/** Stage → modules switched on. Stage 3 switches on every staged module. */
const PRESETS = Object.freeze({
    1: Object.freeze(['campaigns']),
    2: Object.freeze(['campaigns', 'development', 'talent', 'mobility']),
    3: Object.freeze(['campaigns', 'development', 'talent', 'mobility', 'engagement', 'ai']),
});

/** A fresh install starts here (an install with V2_FEATURES=1 starts at 3). */
const DEFAULT_STAGE = '1';
const LEGACY_STAGE = '3';

/**
 * Route prefixes each module owns. A request under one of them answers the
 * app's normal 404 while the module is off (ModuleService.requireModule).
 * Informational here — the guards are wired where the routers are mounted —
 * and used by the tests to prove that no module prefix touches CORE_PREFIXES.
 */
const MODULE_PREFIXES = Object.freeze({
    campaigns: ['/cycles', '/api/dashboard/v2/cycle-countdown'],
    development: [
        '/v2/idp',
        '/v2/coaching',
        '/v2/pip',
        '/v2/lms',
        '/lti',
        '/.well-known/lms-jwks.json',
        '/integrations/lms',
        '/coaching/plans',
        '/api/coaching',
        '/employee/my-coaching',
        '/api/dashboard/v2/pip-overview',
    ],
    talent: [
        '/v2/talent',
        '/v2/continuity',
        '/v2/cap/calibration',
        '/v2/cap/dei',
        '/api/dashboard/v2/bias-monitor',
        '/api/dashboard/v2/action-effectiveness',
    ],
    mobility: ['/v2/lifecycle', '/v2/cap/opportunity', '/v2/cap/aspirations'],
    engagement: [
        '/v2/cap/survey',
        '/v2/cap/recognition',
        '/v2/cap/feedback',
        '/v2/cap/objective',
        '/employee/okr',
    ],
    ai: ['/v2/cap/copilot'],
    localContent: ['/reports/local-content'],
});

/** Sub-paths of the capability router (/v2/cap) and the module owning each. */
const CAP_PATHS = Object.freeze([
    ['/calibration', 'talent'],
    ['/dei', 'talent'],
    ['/opportunity', 'mobility'],
    ['/aspirations', 'mobility'],
    ['/survey', 'engagement'],
    ['/recognition', 'engagement'],
    ['/feedback', 'engagement'],
    ['/objective', 'engagement'], // also /objectives
    ['/copilot', 'ai'],
]);
/** The /v2/cap hub page is shown while any of these is on. */
const CAP_HUB_MODULES = Object.freeze(['talent', 'mobility', 'engagement', 'ai']);

/** Core routes — never behind a module switch (a test holds this). */
const CORE_PREFIXES = Object.freeze([
    '/dashboard',
    '/domains',
    '/skills',
    '/roles',
    '/employees',
    '/skill-matrix',
    '/employee/self-assessment',
    '/employee/assessment-status',
    '/employee/my-development',
    '/employee/my-learning',
    '/supervisor/reviews',
    '/supervisor/self-assessment-reviews',
    '/supervisor/gap-analysis',
    '/assessment-changes',
    '/reviews/post-approval',
    '/talent/nine-box',
    '/api/ninebox',
    '/reports/builder',
    '/reports/readiness',
    '/reports/gaps',
    '/reports/dept-analytics',
    '/v2/slf',
    '/v2/uam',
    '/v2/cap/dsr',
    '/v2/cap/webhooks',
    '/v2/cap/skills',
    '/app-settings',
    '/setup',
    '/admin',
]);

/**
 * The menu entries each module brings — shown on /admin/modules as the impact
 * of a change ("these menus appear / disappear"). Literal i18n keys only.
 */
const MODULE_MENUS = Object.freeze({
    campaigns: ['chrome:section_campaigns'],
    development: [
        'chrome:nav_coaching',
        'chrome:nav_dev_plans',
        'chrome:nav_pip',
        'chrome:nav_lms_hub',
        'chrome:nav_my_coaching',
    ],
    talent: ['chrome:nav_continuity', 'exec:kp_title', 'chrome:nav_talent_suite'],
    mobility: ['chrome:nav_lifecycle', 'chrome:nav_my_growth', 'chrome:nav_talent_suite'],
    engagement: ['chrome:nav_my_okr', 'chrome:nav_my_growth', 'chrome:nav_talent_suite'],
    ai: ['chrome:nav_talent_suite'],
    localContent: ['chrome:nav_local_content'],
});

module.exports = {
    MODULE_KEYS,
    SETTING_KEYS,
    STAGED_MODULES,
    STAGE_KEY,
    STAGES,
    PRESETS,
    DEFAULT_STAGE,
    LEGACY_STAGE,
    MODULE_PREFIXES,
    CAP_PATHS,
    CAP_HUB_MODULES,
    CORE_PREFIXES,
    MODULE_MENUS,
};
