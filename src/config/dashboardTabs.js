'use strict';
/**
 * The dashboard's context tabs, blocks and lists — pure data, no I/O.
 *
 * Every tab and every block carries:
 *   module      the optional module it belongs to (config/modules.js), null =
 *               core. A tab or block whose module is off is OMITTED by
 *               DashboardHomeService (never shown as "not measured"), and no
 *               link it would carry is printed.
 *   permission  the capability (DashboardHomeService.capabilities) the reader
 *               needs, null = anyone who may open the dashboard.
 *
 * Tab ids are the URL slugs (?tab=readiness): English, short and stable. The
 * labels are locale keys (French and English). The workspace components a
 * SuperAdmin may hide per administrator (config/workspaceComponents.js,
 * `tab:<id>`) are the same ids.
 */

/** Context tabs, in display order. `overview` is the default. */
const TABS = Object.freeze([
    Object.freeze({ id: 'overview', module: null, permission: null, icon: 'fa-compass' }),
    Object.freeze({ id: 'readiness', module: null, permission: null, icon: 'fa-gauge-high' }),
    Object.freeze({ id: 'safety', module: null, permission: 'safety', icon: 'fa-helmet-safety' }),
    // the 9-box grid is core in IDevelop (config/modules.js CORE_PREFIXES)
    Object.freeze({ id: 'talent', module: null, permission: 'talent', icon: 'fa-table-cells' }),
    Object.freeze({
        id: 'succession',
        module: 'talent',
        permission: 'continuity',
        icon: 'fa-people-arrows',
    }),
    // the person's own development plan is core; the other plans are blocks
    Object.freeze({
        id: 'development',
        module: null,
        permission: 'plans',
        icon: 'fa-seedling',
    }),
    Object.freeze({
        id: 'assessments',
        module: null,
        permission: 'assessView',
        icon: 'fa-clipboard-check',
    }),
]);

const DEFAULT_TAB = 'overview';

/**
 * Former dashboard tabs (the #hash of the previous page, and the workspace
 * component keys stored before this release) → the tab that replaces them.
 */
const LEGACY_TABS = Object.freeze({
    executive: 'overview',
    capability: 'readiness',
    comparator: 'readiness',
    training: 'development',
    team: 'development',
    talentdev: 'talent',
});

/**
 * Blocks of the tabs. `kpi` = the indicator it shows or details (KpiService).
 * Order inside a tab is the display order.
 */
const BLOCKS = Object.freeze([
    // overview
    { id: 'gauge', tab: 'overview', module: null, permission: null },
    { id: 'trend', tab: 'overview', module: null, permission: null, kpi: 'K1' },
    { id: 'siteStatus', tab: 'overview', module: null, permission: null, kpi: 'K1' },
    // the « Whole framework » row of the capability map, linked to the full map
    { id: 'capStrip', tab: 'overview', module: null, permission: 'skills', kpi: 'K2' },
    // readiness
    { id: 'readinessTiles', tab: 'readiness', module: null, permission: null },
    { id: 'bell', tab: 'readiness', module: null, permission: null, kpi: 'K2' },
    { id: 'byGroup', tab: 'readiness', module: null, permission: null, kpi: 'K1' },
    { id: 'compare', tab: 'readiness', module: null, permission: 'skills', kpi: 'K2' },
    // the capability map: every pillar (disclosing its sub-domains) x every unit
    { id: 'capabilityMap', tab: 'readiness', module: null, permission: 'skills', kpi: 'K2' },
    // safety
    { id: 'safetyTiles', tab: 'safety', module: null, permission: 'safety' },
    { id: 'certCalendar', tab: 'safety', module: null, permission: 'safety', kpi: 'K8' },
    { id: 'coverageHeat', tab: 'safety', module: null, permission: 'safety', kpi: 'K4' },
    // talent
    { id: 'nineBox', tab: 'talent', module: null, permission: 'talent' },
    // succession (talent module)
    { id: 'successionTiles', tab: 'succession', module: 'talent', permission: 'continuity' },
    // development
    { id: 'plans', tab: 'development', module: null, permission: 'plans', kpi: 'K16' },
    { id: 'devTiles', tab: 'development', module: 'development', permission: 'assess' },
    // the development loop's outcomes: plans achieved, durations, effort (K30)
    {
        id: 'devOutcomes',
        tab: 'development',
        module: 'development',
        permission: 'plans',
        kpi: 'K30',
    },
    { id: 'deficitHeat', tab: 'development', module: null, permission: 'skills', kpi: 'K2' },
    // assessments
    { id: 'campaign', tab: 'assessments', module: 'campaigns', permission: 'campaign', kpi: 'K11' },
    { id: 'validations', tab: 'assessments', module: null, permission: 'validate' },
    { id: 'freshness', tab: 'assessments', module: null, permission: null, kpi: 'K3' },
]);

/**
 * The lists behind the figures (« See the list »): the drill page
 * /dashboard/list?kpi=…&part=… prints the exact population behind a count,
 * as AGGREGATES (by site, by role) — never a name. Its « Open the list » link
 * goes to the page that holds the names (`list`, a navigation entry), printed
 * only when the reader's navigation offers that page.
 *   kind  'people' (person ids), 'roles' (role ids), 'cells' (site × skill)
 *   cap   the capability of the block that shows the figure
 */
const DRILLS = Object.freeze({
    K1: {
        module: null,
        cap: null,
        kind: 'people',
        list: 'readiness',
        parts: ['not_ready', 'partial', 'not_assessed', 'ready'],
    },
    K4: { module: null, cap: null, kind: 'people', list: 'gaps_report', parts: ['not_met'] },
    K8: {
        module: null,
        cap: 'safety',
        kind: 'people',
        list: 'compliance',
        parts: ['expired', 'expiring', 'missing'],
    },
    K9: {
        module: null,
        cap: 'safety',
        kind: 'people',
        list: 'safety_gate',
        parts: ['unfit', 'not_demonstrated'],
    },
    K6: {
        module: 'talent',
        cap: 'continuity',
        kind: 'roles',
        list: 'continuity',
        parts: ['uncovered'],
    },
    K7: {
        module: 'talent',
        cap: 'continuity',
        kind: 'cells',
        list: 'key_people',
        parts: ['cells'],
    },
    K11: {
        module: 'campaigns',
        cap: 'campaign',
        kind: 'people',
        list: 'cycles',
        parts: ['not_validated'],
    },
    K16: {
        module: null,
        cap: 'plans',
        kind: 'people',
        list: 'dev_plans',
        parts: ['active', 'overdue'],
    },
    // a heatmap cell: the people below the requirement on one pillar (p<id>)
    // or one sub-domain (s<id>, the capability map)
    DOM: {
        module: null,
        cap: 'skills',
        kind: 'people',
        list: 'gaps_report',
        parts: [],
        partPattern: /^[ps][1-9][0-9]{0,9}$/,
    },
    VAL: {
        module: null,
        cap: 'validate',
        kind: 'people',
        list: 'sa_reviews',
        parts: ['waiting', 'overdue'],
    },
});

/** A self-assessment waiting longer than this is late. */
const VALIDATION_LATE_DAYS = 7;

/** The first row of tiles, canonical order; the most severe come first. */
const TILE_ORDER = Object.freeze(['K9', 'K8', 'K1', 'VAL', 'K6', 'K11', 'K3', 'K16', 'K4', 'K7']);
const FIRST_ROW_MAX = 5;

/** The areas the clearance line names when the reader may not see them. */
const AREAS = Object.freeze([
    { cap: 'safety', module: null, key: 'safety' },
    { cap: 'continuity', module: 'talent', key: 'succession' },
    { cap: 'campaign', module: 'campaigns', key: 'campaigns' },
    { cap: 'validate', module: null, key: 'validations' },
    { cap: 'talent', module: null, key: 'talent' },
    { cap: 'names', module: null, key: 'lists' },
]);

module.exports = {
    TABS,
    DEFAULT_TAB,
    LEGACY_TABS,
    BLOCKS,
    DRILLS,
    VALIDATION_LATE_DAYS,
    TILE_ORDER,
    FIRST_ROW_MAX,
    AREAS,
};
