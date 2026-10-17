'use strict';

/**
 * DashboardHomeService — the model of the dashboard (/dashboard), the
 * manager's home (/supervisor/dashboard), the lists behind the figures
 * (/dashboard/list) and the board pack (/exec/board-pack).
 *
 * ONE dashboard, adapted to the reader's clearance: there is no switch
 * between views of different jobs. What a reader sees follows from three things only:
 *   - the population of their clearance (KpiService.resolvePopulation:
 *     active, not erased, inside RBACService.scopeFilter), narrowed by the
 *     scope bar (a site or a department of that population);
 *   - their capabilities (capabilities(): plain permission reading);
 *   - the optional modules (ModuleService.flags(), resolved ONCE per request):
 *     a tab, a block or a list whose module is off is OMITTED, never shown as
 *     "not measured", and no link points into it.
 *
 * NO PERSON NAME. The dashboard, the manager's home and the board pack carry
 * counts only. Each count has a « See the list » link to its list page, which
 * prints the exact population behind the count as aggregates (by site, by
 * role) and links to the page holding the names only when the reader's
 * navigation offers that page (src/config/navigation.js gates).
 *
 * HONESTY. Every figure comes from KpiService (one definition per indicator).
 * A movement (delta) compares with a recorded snapshot of the SAME contract
 * (kpi_snapshots.kpi_contract) and the same population; the reconstructed
 * trend is an estimate drawn apart and never feeds a delta. Fewer than 5
 * people never get a percentage.
 */

const db = require('../config/database');
const T = require('../config/dashboardTabs');
const P = require('../utils/kpiPredicates');
const Scope = require('./DashboardScopeService');

const K = () => require('./KpiService');
const SMALL_N = P.SMALL_N;
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const round1 = (v) => Math.round(v * 10) / 10;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ---------------------------------------------------------------------------
// Capabilities, modules, tabs
// ---------------------------------------------------------------------------

/**
 * What this reader's dashboard may show. Pure permission reading plus the
 * population the reader is cleared for; never a guess of a job title.
 *   pop        somebody in the cleared population
 *   names      may open a list page (aggregates of a population): SuperAdmin,
 *              a manager (their team), an admin holding a people permission
 *   safety     certificates and the safety gate: view/manage_compliance, manager
 *   continuity succession and key people: view_continuity, manage_succession
 *   campaign   the campaign console: manage_cycles
 *   validate   self-assessments to validate: approve_assessments, manager
 *   assess     assessment and learning figures: manage/approve_assessments,
 *              configure_lms
 *   assessView the assessments tab: assess, validate or campaign
 *   plans      plans in progress: assess, validate or a manager
 *   talent     the 9-box: manage_talent_reviews, manager
 *   skills     pillar profiles and heatmaps: view_domains_skills, assess, manager
 *   multiSite  two sites or more in the population (« No site » counts as one)
 */
function capabilities(user, pop) {
    const RBACService = require('./RBACService');
    const u = user || {};
    const isAdmin = u.userType === 'admin';
    const isMgr = u.userType === 'manager';
    const su = RBACService.isSuperAdmin(u);
    const can = (s) => isAdmin && RBACService.hasPermission(u, s);
    const P0 = pop || { ids: [], rows: [] };
    const siteKeys = new Set(
        (P0.rows || []).map((r) =>
            r.siteId === null || r.siteId === undefined ? 'none' : r.siteId
        )
    );
    const safety = su || isMgr || can('view_compliance') || can('manage_compliance');
    const continuity = su || can('view_continuity') || can('manage_succession');
    const validate = su || isMgr || can('approve_assessments');
    const assess =
        su || can('manage_assessments') || can('approve_assessments') || can('configure_lms');
    const campaign = su || can('manage_cycles');
    return {
        pop: (P0.ids || []).length > 0,
        people: (P0.ids || []).length,
        names:
            su ||
            isMgr ||
            can('view_employees') ||
            can('manage_employees') ||
            can('edit_employees'),
        safety,
        continuity,
        campaign,
        validate,
        assess,
        assessView: assess || validate || campaign,
        plans: assess || validate || isMgr,
        talent: su || isMgr || can('manage_talent_reviews'),
        skills: su || isMgr || can('view_domains_skills') || assess,
        multiSite: siteKeys.size >= 2,
        manager: isMgr,
        superAdmin: su,
    };
}

const moduleOn = (flags, m) => m === null || m === undefined || !!(flags && flags[m] === true);
const capOk = (caps, need) => need === null || need === undefined || !!(caps && caps[need]);

/** Is the workspace component `tab:<id>` visible for this reader (admins only)? */
function workspaceShows(user, tabId) {
    try {
        return require('../config/workspaceComponents').isVisible('tab:' + tabId, user);
    } catch (_) {
        return true;
    }
}

/** The tabs this reader may open: module on, capability held, a population, not hidden. */
function tabsFor(caps, flags, user) {
    if (!caps || !caps.pop) return [];
    return T.TABS.filter(
        (t) => moduleOn(flags, t.module) && capOk(caps, t.permission) && workspaceShows(user, t.id)
    ).map((t) => ({ id: t.id, icon: t.icon, module: t.module, permission: t.permission }));
}

/** ?tab= (or a former tab name) → an allowed tab id; anything else → the first allowed one. */
function resolveTab(value, tabs) {
    const raw = Array.isArray(value) ? value[value.length - 1] : value;
    let v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (has(T.LEGACY_TABS, v)) v = T.LEGACY_TABS[v];
    const list = tabs || [];
    if (list.some((t) => t.id === v)) return v;
    if (list.some((t) => t.id === T.DEFAULT_TAB)) return T.DEFAULT_TAB;
    return list.length ? list[0].id : null;
}

/** The blocks of a tab this reader sees (module on, capability held). */
function blocksFor(tabId, caps, flags) {
    return T.BLOCKS.filter(
        (b) => b.tab === tabId && moduleOn(flags, b.module) && capOk(caps, b.permission)
    ).map((b) => b.id);
}

/** Is `part` one of the parts of a list (a fixed word, or the list's own id pattern)? */
function partOk(d, part) {
    if (!d || typeof part !== 'string') return false;
    if (d.partPattern) return d.partPattern.test(part);
    return d.parts.includes(part);
}

/** May this reader open the list behind `kpi`? (block capability AND `names`; module on) */
function drillAllowed(caps, flags, kpi) {
    if (!has(T.DRILLS, kpi)) return false;
    const d = T.DRILLS[kpi];
    return !!(caps && caps.names && moduleOn(flags, d.module) && capOk(caps, d.cap));
}

/** The areas the reader may not see, among those whose module is on (« Not visible with your rights »). */
function hiddenAreas(caps, flags) {
    return T.AREAS.filter((a) => moduleOn(flags, a.module) && !capOk(caps, a.cap)).map(
        (a) => a.key
    );
}

// ---------------------------------------------------------------------------
// Request context: modules once, population once, scope bar
// ---------------------------------------------------------------------------

async function moduleFlags() {
    try {
        return await require('./ModuleService').flags();
    } catch (_) {
        return {};
    }
}

/**
 * Resolve everything a dashboard request needs ONCE.
 * @param {object} a { user, query, page, remember, navVisible }
 *   navVisible: the navigation gates of the reader (NAV.gates(buildContext(locals))),
 *   used to decide which list pages a link may point to.
 */
async function context({ user, query, page = 'dashboard', remember = true, navVisible = null }) {
    const Kpi = K();
    const flags = await moduleFlags();
    const full = await Kpi.resolvePopulation({ viewer: user });
    const opts = await Scope.options(full);
    const sc = await Scope.resolve({ user, query, page, opts, remember });
    const kpiScope = { ...Scope.kpiScope(user, sc.scope), modules: flags };
    const pop =
        sc.scope && (sc.scope.site !== undefined || sc.scope.department !== undefined)
            ? await Kpi.resolvePopulation(kpiScope)
            : full;
    kpiScope.__population = pop;
    const caps = capabilities(user, pop);
    return {
        user,
        flags,
        full,
        opts,
        scope: sc.scope,
        scopeSource: sc.source,
        scopeRefused: sc.refused,
        scopeQuery: Scope.queryOf(sc.scope),
        kpiScope,
        pop,
        caps,
        tabs: tabsFor(caps, flags, user),
        navVisible: navVisible || {},
    };
}

/** The navigation page behind a list, when the reader's navigation offers it. */
function navHref(ctx, navId) {
    if (!navId) return null;
    const NAV = require('../config/navigation');
    if (!has(NAV.CATALOGUE, navId)) return null;
    const vis = ctx && ctx.navVisible ? ctx.navVisible : {};
    if (!(has(vis, navId) && vis[navId])) return null;
    return NAV.CATALOGUE[navId].href || null;
}

/** The list page of a figure (/dashboard/list?…), or null when the reader may not open it. */
function drillHref(ctx, kpi, part) {
    if (!drillAllowed(ctx.caps, ctx.flags, kpi)) return null;
    const d = T.DRILLS[kpi];
    if (!partOk(d, part)) return null;
    const q = ['kpi=' + encodeURIComponent(kpi), 'part=' + encodeURIComponent(part)];
    if (ctx.scopeQuery) q.push(ctx.scopeQuery);
    return '/dashboard/list?' + q.join('&');
}

/** The scope label: « All of my scope », a site, « No site », a department. */
function scopeLabel(ctx, t) {
    const s = ctx.scope || {};
    const tr = typeof t === 'function' ? t : (k) => k;
    const parts = [];
    if (s.site === 'none') parts.push(tr('dash:d3_scope_no_site'));
    else if (s.site !== undefined) {
        const site = (ctx.opts.sites || []).find((x) => x.id === s.site);
        parts.push(site ? site.name : '#' + s.site);
    }
    if (s.department !== undefined) {
        const d = (ctx.opts.departments || []).find((x) => x.id === s.department);
        parts.push(d ? d.label : '#' + s.department);
    }
    if (parts.length) return parts.join(' · ');
    return ctx.user && ctx.user.userType === 'manager'
        ? tr('dash:d3_scope_team')
        : tr('dash:d3_scope_all');
}

// ---------------------------------------------------------------------------
// Snapshots: deltas and sparklines of the SAME contract and population
// ---------------------------------------------------------------------------

/**
 * The recorded snapshot scope that matches the reader's population exactly,
 * or null. kpi_snapshots holds the organisation, each site and (migration
 * 187) each department: a reader sees a movement only when their population
 * IS one of them (a partial view of a unit never borrows the unit's history).
 */
async function snapshotScope(ctx) {
    const s = ctx.scope || {};
    if (s.site === 'none') return null;
    const Kpi = K();
    if (s.department !== undefined) {
        if (s.site !== undefined) return null; // no row is « this department within this site »
        const sys = await Kpi.resolvePopulation({ system: true, departmentId: s.department });
        return sys.ids.length && sys.ids.length === ctx.pop.ids.length
            ? { scopeType: 'department', scopeId: s.department }
            : null;
    }
    if (s.site !== undefined) {
        const sys = await Kpi.resolvePopulation({ system: true, siteId: s.site });
        return sys.ids.length === ctx.pop.ids.length
            ? { scopeType: 'site', scopeId: s.site }
            : null;
    }
    const sys = await Kpi.resolvePopulation({ system: true });
    return sys.ids.length === ctx.pop.ids.length ? { scopeType: 'org', scopeId: 0 } : null;
}

const k1PctOf = (row) => {
    if (!row) return null;
    const r = Number(row.roleReadyCount);
    const n = Number(row.notReadyCount);
    if (!isNum(row.roleReadyCount) || !isNum(row.notReadyCount) || r + n < SMALL_N) return null;
    return round1((100 * r) / (r + n));
};

/**
 * Movements since the most recent snapshot at least 28 days old, of the SAME
 * KPI contract (KpiService.CONTRACT_VERSION). A metric with no comparable
 * side has no delta (absent, never 0). Pure apart from the reads.
 * @returns {Promise<{since: string|null, values: object, series: Array}>}
 */
async function movements(ctx, current) {
    const none = { since: null, values: {}, series: [] };
    let sc = null;
    try {
        sc = await snapshotScope(ctx);
    } catch (_) {
        sc = null;
    }
    if (!sc) return none;
    const S = require('./KpiSnapshotService');
    const contract = K().CONTRACT_VERSION;
    try {
        const prior = await S.priorSnapshot(sc.scopeType, sc.scopeId, 28, contract);
        const rows = await S.series(sc.scopeType, sc.scopeId, 400);
        const series = monthlySeries((rows || []).filter((r) => r.kpiContract === contract));
        return { since: prior ? prior.date : null, values: deltaValues(current, prior), series };
    } catch (_) {
        return none;
    }
}

/** Per-metric differences current − prior; a missing side gives no key. Pure. */
function deltaValues(current, prior) {
    const out = {};
    if (!current || !prior) return out;
    const d = (a, b) => (isNum(a) && isNum(b) ? round1(Number(a) - Number(b)) : null);
    const pairs = {
        K1: d(k1PctOf(current), k1PctOf(prior)),
        K3: d(current.assessmentCoverage, prior.assessmentCoverage),
        K4: d(current.criticalCompliance, prior.criticalCompliance),
        K8: d(current.certsExpired, prior.certsExpired),
        K8soon: d(current.certsExpiring90d, prior.certsExpiring90d),
        K9: d(current.safetyFitPct, prior.safetyFitPct),
        K7: d(current.soleHolderCount, prior.soleHolderCount),
        ready: d(current.roleReadyCount, prior.roleReadyCount),
    };
    for (const [k, v] of Object.entries(pairs)) if (v !== null) out[k] = v;
    return out;
}

/** The last snapshot of each month, oldest first, with the K1 % (null below 5). Pure. */
function monthlySeries(rows) {
    const byMonth = new Map();
    for (const r of rows || []) byMonth.set(String(r.date).slice(0, 7), r);
    return [...byMonth.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([month, r]) => ({
            month,
            K1: k1PctOf(r),
            K3: isNum(r.assessmentCoverage) ? Number(r.assessmentCoverage) : null,
            K2: isNum(r.avgReadiness) ? Number(r.avgReadiness) : null,
        }));
}

/** A sparkline: ≥ 3 usable points, a null is a gap; else null. Pure. */
function sparkOf(series, key) {
    const pts = (series || []).slice(-12).map((p) => (isNum(p[key]) ? Number(p[key]) : null));
    return pts.filter((v) => v !== null).length >= 3 ? pts : null;
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

const STATUS_CHIP = Object.freeze({
    compliant: 'good',
    watch: 'warn',
    at_risk: 'risk',
});
const chipOf = (status) => (has(STATUS_CHIP, status) ? STATUS_CHIP[status] : null);
const SEVERITY = Object.freeze({ at_risk: 0, watch: 1, compliant: 2 });

/** A self-assessment validation summary of a population (people, not rows). */
async function pendingValidations(ids) {
    if (!ids || !ids.length) return { waiting: [], overdue: [] };
    const rows = await db.all(
        `SELECT sa.employee_id AS "id",
                MIN(COALESCE(sa.submitted_at, sa.updated_at, sa.created_at)) AS "since"
           FROM self_assessments sa
          WHERE sa.employee_id = ANY(?) AND sa.workflow_state = 'submitted'
            AND sa.cancelled_at IS NULL
          GROUP BY sa.employee_id`,
        [ids]
    );
    const late = Date.now() - T.VALIDATION_LATE_DAYS * 86400000;
    const waiting = (rows || []).map((r) => Number(r.id)).sort((a, b) => a - b);
    const overdue = (rows || [])
        .filter((r) => r.since && new Date(r.since).getTime() < late)
        .map((r) => Number(r.id))
        .sort((a, b) => a - b);
    return { waiting, overdue };
}

/**
 * Compute the indicators of the first screen on ONE population, module-aware
 * (an indicator whose module is off is never computed) and capability-aware
 * (an indicator of an area the reader may not see is never computed).
 */
async function indicators(ctx) {
    const Kpi = K();
    const s = ctx.kpiScope;
    const out = {};
    const want = (kpi) => Kpi.isAvailable(kpi, ctx.flags);
    if (!ctx.caps.pop) return out;
    out.K1 = await Kpi.compute('K1', s);
    out.K2 = await Kpi.compute('K2', s);
    out.K3 = await Kpi.compute('K3', s);
    out.K4 = await Kpi.compute('K4', s);
    if (ctx.caps.safety) {
        out.K8 = await Kpi.compute('K8', s);
        out.K9 = await Kpi.compute('K9', s);
    }
    if (ctx.caps.continuity && want('K6')) {
        out.K5 = await Kpi.compute('K5', s);
        out.K6 = await Kpi.compute('K6', s);
        out.K7 = await Kpi.compute('K7', s);
    }
    if (ctx.caps.campaign && want('K11')) out.K11 = await Kpi.compute('K11', s);
    if (ctx.caps.plans) out.K16 = await Kpi.compute('K16', s);
    if (ctx.caps.validate) out.VAL = await pendingValidations(ctx.pop.ids);
    return out;
}

/** The first open campaign of a K11 result (or null). */
function currentCampaign(k11) {
    if (!k11 || k11.noCampaign || !Array.isArray(k11.campaigns) || !k11.campaigns.length)
        return null;
    return k11.campaigns[0];
}

/**
 * The tile model of one indicator, for views/partials/kpi-tile.ejs. Labels are
 * locale keys resolved by `t`; numbers are formatted by the partial.
 */
function tileOf(ctx, kpi, ind, mv, t, { keepEmpty = false } = {}) {
    const tr = typeof t === 'function' ? t : (k) => k;
    const r = ind[kpi];
    const D = (mv && mv.values) || {};
    const spark = mv && mv.series;
    const base = {
        id: 'kpi-' + kpi.toLowerCase(),
        kpi,
        label: tr('kpi:' + kpi.toLowerCase() + '_name'),
        glossaryHref: '/kpi/glossary#' + kpi,
        asOf: null,
    };
    const link = (part, n, key) => {
        const href = drillHref(ctx, kpi, part);
        if (!href || !isNum(n) || Number(n) <= 0) return {};
        return {
            drillHref: href,
            drillLabel: tr(key || 'dash:d3_see_list'),
            drillCount: Number(n),
        };
    };
    if (kpi === 'VAL') {
        const v = r || { waiting: [], overdue: [] };
        return {
            ...base,
            label: tr('dash:d3_val_name'),
            glossaryHref: null,
            value: v.waiting.length,
            unit: 'count',
            status: v.overdue.length ? 'warn' : null,
            severity: v.overdue.length ? 1 : 3,
            sub: tr('dash:d3_val_sub', { count: v.overdue.length, n: v.overdue.length }),
            ...link('waiting', v.waiting.length),
        };
    }
    if (!r) return null;
    if (r.status === 'not_configured') {
        if (!keepEmpty) return null;
        return {
            ...base,
            value: null,
            emptyState: { state: 'not_configured', message: tr('kpi:status_not_configured') },
        };
    }
    const sev = has(SEVERITY, r.status) ? SEVERITY[r.status] : 3;
    if (kpi === 'K1') {
        const b = r.breakdown || {};
        return {
            ...base,
            value: r.value,
            unit: 'pct',
            numerator: r.numerator,
            denominator: r.denominator,
            status: chipOf(r.status),
            severity: sev,
            delta: isNum(D.K1) ? D.K1 : null,
            sparkline: sparkOf(spark, 'K1'),
            sub: tr('dash:d3_k1_sub', { n: r.denominator || 0, count: r.denominator || 0 }),
            extra: [
                { key: 'not_ready', label: tr('kpi:state_not_ready'), value: b.notReady },
                { key: 'partial', label: tr('kpi:state_partial'), value: b.partial },
                { key: 'not_assessed', label: tr('kpi:state_not_assessed'), value: b.notAssessed },
            ],
            ...link('not_ready', b.notReady, 'dash:d3_see_not_ready'),
        };
    }
    if (kpi === 'K3' || kpi === 'K2') {
        return {
            ...base,
            value: r.value,
            unit: 'pct',
            numerator: r.numerator,
            denominator: r.denominator,
            status: chipOf(r.status),
            severity: sev,
            delta: kpi === 'K3' && isNum(D.K3) ? D.K3 : null,
            sparkline: sparkOf(spark, kpi),
        };
    }
    if (kpi === 'K4') {
        const den = Array.isArray(r.drill) ? r.drill : [];
        const num = new Set(Array.isArray(r.numeratorDrill) ? r.numeratorDrill : []);
        const notMet = den.filter((id) => !num.has(id)).length;
        return {
            ...base,
            value: r.value,
            unit: 'pct',
            numerator: r.numerator,
            denominator: r.denominator,
            status: chipOf(r.status),
            severity: sev,
            delta: isNum(D.K4) ? D.K4 : null,
            ...link('not_met', notMet, 'dash:d3_see_not_met'),
        };
    }
    if (kpi === 'K8') {
        const b = r.breakdown || {};
        return {
            ...base,
            value: r.value,
            unit: 'count',
            polarity: 'lower_better',
            status: chipOf(r.status),
            severity: sev,
            delta: isNum(D.K8) ? D.K8 : null,
            sub: tr('dash:d3_k8_sub'),
            extra: [
                { key: 'expiring', label: tr('dash:d3_k8_expiring'), value: b.expiringPeople },
                { key: 'missing', label: tr('dash:d3_k8_missing'), value: b.missingPeople },
            ],
            ...link('expired', r.value, 'dash:d3_see_expired'),
        };
    }
    if (kpi === 'K9') {
        const unfit = (r.breakdown && r.breakdown.unfit) || 0;
        return {
            ...base,
            value: r.value,
            unit: 'pct',
            numerator: r.numerator,
            denominator: r.denominator,
            status: chipOf(r.status),
            severity: sev,
            delta: isNum(D.K9) ? D.K9 : null,
            extra: [
                {
                    key: 'not_demonstrated',
                    label: tr('dash:d3_k9_not_demonstrated'),
                    value: r.breakdown ? r.breakdown.notDemonstrated : null,
                },
            ],
            ...link('unfit', unfit, 'dash:d3_see_unfit'),
        };
    }
    if (kpi === 'K5') {
        return {
            ...base,
            value: r.value,
            unit: 'pct',
            numerator: r.numerator,
            denominator: r.denominator,
            status: chipOf(r.status),
            severity: sev,
        };
    }
    if (kpi === 'K6' || kpi === 'K7') {
        return {
            ...base,
            value: r.value,
            unit: 'count',
            polarity: 'lower_better',
            status: chipOf(r.status),
            severity: sev,
            delta: kpi === 'K7' && isNum(D.K7) ? D.K7 : null,
            ...link(kpi === 'K6' ? 'uncovered' : 'cells', r.value),
        };
    }
    if (kpi === 'K11') {
        const c = currentCampaign(r);
        if (!c) return null;
        const b = c.breakdown || {};
        return {
            ...base,
            value: c.value,
            unit: 'pct',
            numerator: c.numerator,
            denominator: c.denominator,
            status: chipOf(c.status),
            severity: has(SEVERITY, c.status) ? SEVERITY[c.status] : 3,
            sub: tr('dash:d3_k11_sub', { invited: b.invited || 0, validated: b.validated || 0 }),
            ...link('not_validated', (b.invited || 0) - (b.validated || 0)),
        };
    }
    if (kpi === 'K16') {
        return {
            ...base,
            value: r.value,
            unit: 'count',
            status: r.overdue ? 'warn' : null,
            severity: r.overdue ? 1 : 3,
            sub: tr('dash:d3_k16_sub', { count: r.overdue || 0, n: r.overdue || 0 }),
            ...link('active', r.value),
        };
    }
    return {
        ...base,
        value: r.value,
        unit: K().CONTRACTS[kpi] ? K().CONTRACTS[kpi].unit : 'num',
        numerator: r.numerator,
        denominator: r.denominator,
        status: chipOf(r.status),
        severity: sev,
    };
}

/**
 * The development outcomes block (K30, with K28 beside it): plans achieved and
 * not achieved, median durations, ageing of the plans past due, and the effort
 * (hours planned and done; "not entered" is null, never 0). Aggregates only.
 */
function devOutcomesModel(k30, k28) {
    if (!k30) return null;
    const b = k30.breakdown || {};
    const idp = b.idp || {};
    const coaching = b.coaching || {};
    const e = k30.effort || {};
    const k28b = (k28 && k28.breakdown) || {};
    return {
        value: k30.value,
        status: k30.status || null,
        n: k30.n || 0,
        idp: {
            achieved: idp.achieved || 0,
            notAchieved: idp.notAchieved || 0,
            cancelled: idp.cancelled || 0,
            medianDays: idp.medianDays == null ? null : idp.medianDays,
        },
        coaching: {
            achieved: coaching.achieved || 0,
            cancelled: coaching.cancelled || 0,
            medianDays: coaching.medianDays == null ? null : coaching.medianDays,
        },
        ageing: b.ageing || { upTo30: 0, upTo90: 0, over90: 0 },
        effort: {
            plannedHours: e.plannedHours == null ? null : e.plannedHours,
            plannedMissing: e.plannedMissing || 0,
            doneHours: e.doneHours == null ? null : e.doneHours,
            doneMissing: e.doneMissing || 0,
            levelsValidated: e.levelsValidated == null ? null : e.levelsValidated,
            levelsPer100h: e.levelsPer100h == null ? null : e.levelsPer100h,
        },
        lms: k28
            ? {
                  status: k28.status || null,
                  value: k28.value,
                  measured: k28b.measured || 0,
                  noBefore: k28b.noBefore || 0,
                  awaitingAfter: k28b.awaitingAfter || 0,
                  unmapped: k28b.unmapped || 0,
              }
            : null,
    };
}

/** The first row: configured, visible tiles, most severe first, canonical order otherwise. */
function firstRow(tiles) {
    const order = new Map(T.TILE_ORDER.map((k, i) => [k, i]));
    return tiles
        .filter(Boolean)
        .filter((x) => order.has(x.kpi))
        .sort(
            (a, b) =>
                (a.severity === undefined ? 3 : a.severity) -
                    (b.severity === undefined ? 3 : b.severity) ||
                order.get(a.kpi) - order.get(b.kpi)
        )
        .slice(0, T.FIRST_ROW_MAX);
}

// ---------------------------------------------------------------------------
// « In brief » and « What is left to set up »
// ---------------------------------------------------------------------------

/** Up to four sentences, counts only, from the indicators. Pure. */
function briefLines(ind, mv, fmt, t, dateFmt) {
    const day = typeof dateFmt === 'function' ? dateFmt : (d) => d;
    const tr = typeof t === 'function' ? t : (k) => k;
    const F = fmt || { num: (v) => String(v), pct: (v) => String(v) + ' %' };
    const lines = [];
    const k1 = ind.K1;
    if (k1 && !k1.emptyScope) {
        const b = k1.breakdown || {};
        if (k1.denominator >= SMALL_N && isNum(k1.value))
            lines.push({
                tone: chipOf(k1.status),
                text: tr('dash:d3_brief_k1', {
                    ready: F.num(b.ready),
                    den: F.num(k1.denominator),
                    pct: F.pct(k1.value),
                }),
            });
        else if (k1.denominator > 0)
            lines.push({
                tone: null,
                text: tr('dash:d3_brief_k1_small', {
                    ready: F.num(b.ready),
                    den: F.num(k1.denominator),
                }),
            });
        else lines.push({ tone: null, text: tr('dash:d3_brief_k1_none') });
        if (b.notAssessed)
            lines.push({
                tone: null,
                text: tr('dash:d3_brief_unassessed', {
                    count: b.notAssessed,
                    n: F.num(b.notAssessed),
                }),
            });
    }
    const k9 = ind.K9;
    if (k9 && k9.breakdown && k9.breakdown.unfit)
        lines.push({
            tone: 'risk',
            text: tr('dash:d3_brief_k9', {
                count: k9.breakdown.unfit,
                n: F.num(k9.breakdown.unfit),
            }),
        });
    const k8 = ind.K8;
    if (k8 && k8.status !== 'not_configured' && k8.breakdown) {
        if (k8.value)
            lines.push({
                tone: 'risk',
                text: tr('dash:d3_brief_k8', { count: k8.value, n: F.num(k8.value) }),
            });
        else if (k8.breakdown.expiringPeople)
            lines.push({
                tone: 'warn',
                text: tr('dash:d3_brief_k8_soon', {
                    count: k8.breakdown.expiringPeople,
                    n: F.num(k8.breakdown.expiringPeople),
                }),
            });
    }
    const v = ind.VAL;
    if (v && v.waiting.length)
        lines.push({
            tone: v.overdue.length ? 'warn' : null,
            text: tr('dash:d3_brief_val', { count: v.waiting.length, n: F.num(v.waiting.length) }),
        });
    if (mv && mv.since && isNum(mv.values.K1))
        lines.push({
            tone: null,
            text: tr('dash:d3_brief_moved', {
                delta: (mv.values.K1 > 0 ? '+' : '') + F.num(mv.values.K1, 1),
                since: day(mv.since),
            }),
        });
    return lines.slice(0, 4);
}

/**
 * « What changed » over 30 days (NarrativeService) for the snapshot scope that
 * IS the reader's population, or null: sentences only about what this
 * reader's dashboard shows (capabilities, modules), each linked to its list
 * when the reader may open it. Never a name.
 */
async function whatChanged(ctx, lang) {
    try {
        const sc = await snapshotScope(ctx);
        if (!sc) return null;
        return await require('./NarrativeService').whatChanged(
            { type: sc.scopeType, id: sc.scopeId },
            {
                days: 30,
                capabilities: ctx.caps,
                flags: ctx.flags,
                locale: lang === 'en' ? 'en' : 'fr',
                hrefOf: (kpi, part) => drillHref(ctx, kpi, part),
            }
        );
    } catch (_) {
        return null;
    }
}

/** « What is left to set up »: unconfigured areas, each with a link the reader may follow. */
async function setupItems(ctx, ind) {
    const items = [];
    if (ctx.caps.superAdmin) {
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const dismissed = await AppSettingsModel.getValue('setupDismissed', false);
            if (!dismissed) {
                const progress = await require('../controllers/SetupController').getProgress();
                if (progress && !progress.complete)
                    items.push({
                        key: 'setup',
                        done: progress.done,
                        total: progress.total,
                        next: progress.next ? progress.next.key : null,
                        href: progress.next ? progress.next.href : '/setup',
                    });
            }
        } catch (_) {
            /* the card is best effort */
        }
    }
    const k1 = ind.K1;
    if (
        k1 &&
        ctx.caps.pop &&
        k1.breakdown &&
        k1.breakdown.noRequirement === k1.breakdown.population
    )
        items.push({ key: 'requirements', href: navHref(ctx, 'roles') });
    if (ind.K8 && ind.K8.status === 'not_configured')
        items.push({ key: 'certificates', href: navHref(ctx, 'compliance') });
    if (ind.K9 && ind.K9.status === 'not_configured')
        items.push({ key: 'safety_gate', href: navHref(ctx, 'safety_rules') });
    if (ind.K11 && !currentCampaign(ind.K11))
        items.push({ key: 'campaign', href: navHref(ctx, 'cycles') });
    if (ind.K6 && ind.K6.status === 'not_configured')
        items.push({ key: 'critical_roles', href: navHref(ctx, 'continuity') });
    return items;
}

/**
 * The first screen of /dashboard: scope bar, « In brief », the first row of
 * tiles, the clearance line, « What is left to set up ».
 */
async function firstScreen(ctx, { t, fmt, dateFmt } = {}) {
    if (!ctx.caps.pop) return { empty: true, tiles: [], more: [], brief: [], setup: [] };
    const ind = await indicators(ctx);
    let current = null;
    try {
        current = await K().snapshotMetrics(ctx.kpiScope);
    } catch (_) {
        current = null;
    }
    const mv = current ? await movements(ctx, current) : { since: null, values: {}, series: [] };
    const changed = await whatChanged(ctx, (fmt && fmt.lang) || 'fr');
    const all = ['K9', 'K8', 'K1', 'VAL', 'K6', 'K11', 'K3', 'K16', 'K4', 'K7']
        .filter((k) => has(ind, k))
        .map((k) => tileOf(ctx, k, ind, mv, t))
        .filter(Boolean);
    const tiles = firstRow(all);
    const shown = new Set(tiles.map((x) => x.kpi));
    return {
        empty: false,
        tiles,
        more: all.filter((x) => !shown.has(x.kpi)),
        brief: briefLines(ind, mv, fmt, t, dateFmt),
        changed,
        since: mv.since,
        coverage: ind.K3 ? ind.K3.value : null,
        setup: await setupItems(ctx, ind),
        hidden: hiddenAreas(ctx.caps, ctx.flags),
        indicators: ind,
        movements: mv,
    };
}

// ---------------------------------------------------------------------------
// Pure models of the tab blocks
// ---------------------------------------------------------------------------

/** « Health profile » axes and the weights of the overall gauge (Σ = 100). */
const HEALTH_AXES = Object.freeze([
    { key: 'K1', weight: 30, cap: null, module: null },
    { key: 'K3', weight: 15, cap: null, module: null },
    { key: 'K4', weight: 25, cap: 'safety', module: null },
    { key: 'K5', weight: 15, cap: 'continuity', module: 'talent' },
    { key: 'FR', weight: 15, cap: null, module: null },
]);
/** Fewer measured axes than this ⇒ no overall score at all. */
const GAUGE_MIN_AXES = 3;

/**
 * The health profile: one axis per area. An axis outside the reader's
 * clearance is omitted and said in words; an axis whose module is off is not
 * part of the profile at all; an unmeasured axis is a gap, never 0. Pure.
 */
function healthProfile({ k1, k3, k4, k5, fr, caps, flags }) {
    const src = { K1: k1, K3: k3, K4: k4, K5: k5, FR: fr };
    const axes = HEALTH_AXES.filter((a) => moduleOn(flags, a.module)).map((a) => {
        if (a.cap && !(caps && caps[a.cap]))
            return { key: a.key, weight: a.weight, value: null, state: 'outside' };
        const r = src[a.key];
        if (!r || r.emptyScope)
            return { key: a.key, weight: a.weight, value: null, state: 'unmeasured' };
        if (r.status === 'not_configured')
            return { key: a.key, weight: a.weight, value: null, state: 'not_configured' };
        if (r.status === 'small_n')
            return { key: a.key, weight: a.weight, value: null, state: 'small_n', n: r.n };
        if (!isNum(r.value))
            return { key: a.key, weight: a.weight, value: null, state: 'unmeasured' };
        return {
            key: a.key,
            weight: a.weight,
            value: Number(r.value),
            state: 'measured',
            status: r.status || null,
            n: isNum(r.n) ? Number(r.n) : null,
        };
    });
    return {
        axes,
        partial: axes.some((a) => a.state === 'outside'),
        outside: axes.filter((a) => a.state === 'outside').map((a) => a.key),
    };
}

/**
 * The overall gauge: the weighted mean of the MEASURED axes only (an
 * unmeasured axis is never 0 or 100); a missing axis makes it « partial —
 * N of M axes »; fewer than 3 measured axes ⇒ no score. Band: the K1 bands. Pure.
 */
function globalGauge(profile, threshold = 80) {
    const axes = (profile && profile.axes) || [];
    const measured = axes.filter((a) => a.state === 'measured' && isNum(a.value));
    const missing = axes.filter((a) => !(a.state === 'measured' && isNum(a.value)));
    const out = {
        total: axes.length,
        measuredCount: measured.length,
        missing: missing.map((a) => ({ key: a.key, state: a.state })),
        partial: missing.length > 0,
        score: null,
        status: null,
    };
    if (measured.length < GAUGE_MIN_AXES) return out;
    let w = 0;
    let s = 0;
    for (const a of measured) {
        w += a.weight;
        s += a.weight * Number(a.value);
    }
    if (!w) return out;
    out.score = round1(s / w);
    out.status = chipOf(P.statusBand(out.score, 'K1', { threshold }));
    return out;
}

/**
 * « Measurability » under the health score: on how many people of the scope
 * the score is actually computed — K1's own denominator (people with a
 * verdict, « ready » or « not ready ») — with, apart and never folded into
 * one « not measurable » figure: the people whose role has no requirement,
 * the partly assessed and the « not yet assessed » (measurable, just not
 * assessed yet). The health axes not measured yet are named. Counts only,
 * never a name; fewer than 5 people ⇒ counts, no %. `complete` only at 100 %:
 * the chip is coloured below it and calm at it. Pure.
 * @returns {null|{population, scored, pct, complete, smallN, noRequirement,
 *          partial, notAssessed, axesMissing: string[], emptyScope?: true}}
 */
function measurability(k1, profile) {
    if (!k1) return null;
    const missing = ((profile && profile.axes) || [])
        .filter(
            (a) => a.state === 'unmeasured' || a.state === 'not_configured' || a.state === 'small_n'
        )
        .map((a) => a.key);
    if (k1.emptyScope) return { emptyScope: true, population: 0, axesMissing: missing };
    const b = k1.breakdown || {};
    const population = Number(b.population) || 0;
    if (!population) return { emptyScope: true, population: 0, axesMissing: missing };
    const scored = Math.max(0, Math.min(population, Number(k1.denominator) || 0));
    const smallN = population < SMALL_N;
    return {
        population,
        scored,
        pct: smallN ? null : round1((100 * scored) / population),
        complete: scored === population,
        smallN,
        noRequirement: Number(b.noRequirement) || 0,
        partial: Number(b.partial) || 0,
        notAssessed: Number(b.notAssessed) || 0,
        axesMissing: missing,
    };
}

/**
 * The « comparable role mix » rows beside K1 by site (KpiService.k1RoleExpected),
 * in the order of the K1 ranking; sites with nothing to say are left out. Pure.
 */
function expectedRows(groups, exp) {
    if (!exp || typeof exp.get !== 'function') return [];
    return (groups || [])
        .map((g) => {
            const e = exp.get(g.none ? 'none' : String(g.id));
            if (!e) return null;
            return {
                key: g.key,
                label: g.label,
                none: !!g.none,
                observed: g.value,
                expected: e.expected,
                state: e.state,
                n: e.n,
            };
        })
        .filter(Boolean);
}

/** The bell curve: hidden below 20 people; the reference normal curve has the same mean and sd. */
const BELL_MIN_N = 20;
function bellCurve(values, scale = { min: 0, max: 100, width: 10 }) {
    const vals = (values || []).filter(isNum).map(Number);
    const n = vals.length;
    const out = { n, hidden: n < BELL_MIN_N, bins: [], curve: [], mean: null, sd: null };
    if (out.hidden) return out;
    const { min, max, width } = scale;
    const count = Math.max(1, Math.round((max - min) / width));
    out.bins = Array.from({ length: count }, (_, i) => ({
        from: min + i * width,
        to: min + (i + 1) * width,
        count: 0,
    }));
    for (const v of vals) {
        const i = Math.min(count - 1, Math.max(0, Math.floor((v - min) / width)));
        out.bins[i].count++;
    }
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    const sd = Math.sqrt(variance);
    out.mean = round1(mean);
    out.sd = round1(sd);
    if (sd > 0) {
        for (let k = 0; k <= 20; k++) {
            const x = min + ((max - min) * k) / 20;
            const pdf =
                Math.exp(-((x - mean) * (x - mean)) / (2 * variance)) /
                (sd * Math.sqrt(2 * Math.PI));
            out.curve.push({ x: round1(x), y: Math.round(pdf * n * width * 100) / 100 });
        }
    }
    return out;
}

/** 9-box cell keys (performance-potential → talentx label). */
const NINE_BOX_CELLS = Object.freeze({
    'high-low': { key: 'nb_cell_diamond', zone: 'warn' },
    'high-medium': { key: 'nb_cell_shooting', zone: 'good' },
    'high-high': { key: 'nb_cell_gold', zone: 'good' },
    'medium-low': { key: 'nb_cell_dilemma', zone: 'warn' },
    'medium-medium': { key: 'nb_cell_critical', zone: 'neutral' },
    'medium-high': { key: 'nb_cell_emerging', zone: 'good' },
    'low-low': { key: 'nb_cell_concern', zone: 'risk' },
    'low-medium': { key: 'nb_cell_essential', zone: 'neutral' },
    'low-high': { key: 'nb_cell_trusted', zone: 'neutral' },
});

/**
 * The 9-box doughnut: approved placements per cell, « Not placed » a separate
 * slice, cells under 5 merged into « Others (fewer than 5 each) » — never ONE
 * small slice alone (it is merged with the next smallest so its count cannot
 * be worked out). Pure.
 */
function nineBoxPie(nb) {
    if (!nb) return null;
    const total = (Number(nb.placed) || 0) + (Number(nb.notPlaced) || 0);
    const boxes = Object.entries(nb.cells || {})
        .map(([cell, count]) => ({
            cell,
            key: has(NINE_BOX_CELLS, cell) ? NINE_BOX_CELLS[cell].key : null,
            zone: has(NINE_BOX_CELLS, cell) ? NINE_BOX_CELLS[cell].zone : 'neutral',
            count: Number(count) || 0,
        }))
        .filter((b) => b.count > 0 && b.key)
        .sort((a, b) => b.count - a.count || (a.cell < b.cell ? -1 : 1));
    let small = boxes.filter((b) => b.count < SMALL_N);
    let big = boxes.filter((b) => b.count >= SMALL_N);
    if (small.length === 1 && big.length) {
        const next = big.slice().sort((a, b) => a.count - b.count || (a.cell < b.cell ? -1 : 1))[0];
        small = small.concat(next);
        big = big.filter((b) => b !== next);
    }
    const pct = (c) => (total ? round1((100 * c) / total) : null);
    const slices = big.map((b) => ({ kind: 'cell', ...b, pct: pct(b.count) }));
    if (small.length === 1 && !big.length) {
        // one small cell and nothing else: its count is the placed total, already public
        slices.push({ kind: 'cell', ...small[0], pct: pct(small[0].count) });
    } else if (small.length) {
        const c = small.reduce((a, b) => a + b.count, 0);
        slices.push({ kind: 'others', count: c, pct: pct(c), cells: small.length });
    }
    if (Number(nb.notPlaced) > 0)
        slices.push({
            kind: 'not_placed',
            count: Number(nb.notPlaced),
            pct: pct(Number(nb.notPlaced)),
        });
    return { total, placed: Number(nb.placed) || 0, notPlaced: Number(nb.notPlaced) || 0, slices };
}

/**
 * The reconstructed trend: K1 and K3 replayed month by month from the dated
 * assessments of the CURRENT population (assumption: the same people all
 * along). An ESTIMATE, drawn dashed and labelled; never a delta. A month
 * before any evidence, or with fewer than 5 people behind it, is a gap.
 * The CURRENT month is not reconstructed when `live` is given: it is the live
 * K1 / K3 of the tiles beside the chart (certificate lapses, approved
 * self-assessments, the same rules), so the dashed line ends exactly on the
 * tile value instead of a little away from it (a move that did not happen).
 * Pure.
 */
function backcastSeries(
    { reqs, events },
    { threshold = 80, months = 12, now = Date.now(), live = null } = {}
) {
    const Kpi = K();
    const ev = new Map();
    for (const x of events || []) {
        const k = x.e + ':' + x.s;
        if (!ev.has(k)) ev.set(k, []);
        ev.get(k).push(x);
    }
    for (const list of ev.values()) list.sort((a, b) => a.t - b.t);
    const today = new Date(now);
    const out = [];
    for (let i = months - 1; i >= 0; i--) {
        const end = new Date(
            Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i + 1, 0, 23, 59, 59)
        );
        const cut = Math.min(end.getTime(), now);
        const facts = new Map();
        for (const q of reqs || []) {
            let f = facts.get(q.e);
            if (!f) {
                f = {
                    totalReq: 0,
                    assessed: 0,
                    ptsGained: 0,
                    ptsReq: 0,
                    ptsGainedAssessed: 0,
                    ptsReqAssessed: 0,
                    critTotal: 0,
                    critAssessed: 0,
                    critMet: 0,
                };
                facts.set(q.e, f);
            }
            const list = ev.get(q.e + ':' + q.s) || [];
            let lvl = null;
            for (const x of list) {
                if (x.t <= cut) lvl = x.l;
                else break;
            }
            f.totalReq++;
            f.ptsReq += q.r;
            if (q.c) f.critTotal++;
            if (lvl !== null) {
                const g = Math.min(lvl, q.r);
                f.assessed++;
                f.ptsGained += g;
                f.ptsGainedAssessed += g;
                f.ptsReqAssessed += q.r;
                if (q.c) {
                    f.critAssessed++;
                    if (lvl >= q.r) f.critMet++;
                }
            }
        }
        let ready = 0;
        let notReady = 0;
        let assessed = 0;
        let expected = 0;
        let people = 0;
        for (const f of facts.values()) {
            const c = Kpi.classifyReadiness(f, threshold);
            if (c.state === P.READINESS.READY) ready++;
            else if (c.state === P.READINESS.NOT_READY) notReady++;
            assessed += f.assessed;
            expected += f.totalReq;
            people++;
        }
        const den = ready + notReady;
        out.push({
            month: end.toISOString().slice(0, 7),
            K1: den >= SMALL_N ? round1((100 * ready) / den) : null,
            K3:
                expected && assessed > 0 && people >= SMALL_N
                    ? round1((100 * assessed) / expected)
                    : null,
        });
    }
    if (live && out.length) {
        const last = out[out.length - 1];
        const val = (r) => (r && !r.emptyScope && isNum(r.value) ? Number(r.value) : null);
        if (live.K1 !== undefined) last.K1 = val(live.K1);
        if (live.K3 !== undefined) last.K3 = val(live.K3);
        last.live = true;
    }
    return out;
}

/**
 * The comparison unit shown by default: the WEAKEST measured unit of the
 * readiness ranking (K1 by group), inside the reader's options, with at least
 * 5 people — never the whole population, never an unmeasured unit (absence
 * is not weakness). Ties: larger population first, then id. Pure.
 */
function defaultCompare(groups, options, popSize) {
    const allowed = new Set((options || []).map((o) => String(o.id)));
    const cand = (groups || []).filter(
        (g) =>
            !g.none &&
            g.id !== null &&
            allowed.has(String(g.id)) &&
            isNum(g.value) &&
            (g.population || 0) >= SMALL_N &&
            (g.population || 0) < (popSize || Infinity)
    );
    cand.sort(
        (a, b) =>
            a.value - b.value ||
            (b.population || 0) - (a.population || 0) ||
            Number(a.id) - Number(b.id)
    );
    return cand.length ? Number(cand[0].id) : null;
}

/** Pair a reference profile and a unit profile axis by axis (n of the weaker side). Pure. */
function pairProfiles(ref, unit) {
    const u = new Map((unit || []).map((r) => [r.key, r]));
    return (ref || []).map((r) => {
        const x = u.get(r.key) || null;
        const okRef = r.measured > 0 && r.n >= SMALL_N;
        const okUnit = !!x && x.measured > 0 && x.n >= SMALL_N;
        return {
            key: r.key,
            label: r.label,
            ref: okRef ? r.actual : null,
            unit: okUnit ? x.actual : null,
            required: okRef ? r.required : null,
            // the n that decides whether the axis is drawn: the smaller measured side
            axisN: !x || !x.measured ? 0 : Math.min(r.n || 0, x.n || 0),
        };
    });
}

/** The 12 widest MEASURED skill gaps of a unit (unmeasured, small n, at level: never ranked). Pure. */
function rankSkillGaps(rows, cap = 12) {
    return (rows || [])
        .filter(
            (r) =>
                r.measured > 0 &&
                r.n >= SMALL_N &&
                isNum(r.actual) &&
                isNum(r.required) &&
                r.required - r.actual > 0
        )
        .map((r) => ({ ...r, gap: round1((r.required - r.actual) * 100) / 100 }))
        .sort((a, b) => b.gap - a.gap || String(a.label).localeCompare(String(b.label)))
        .slice(0, cap);
}

/**
 * Site status rows: K1, K8 and K9 per site (safety columns only for a reader
 * who may see them), « at risk » rows first. Pure.
 */
function siteStatusRows(k1Site, k8Site, k9Site, caps) {
    const by = new Map();
    const add = (res, field) => {
        for (const r of (res && res.rows) || []) {
            const key = r.noSite ? 'none' : String(r.siteId);
            if (!by.has(key))
                by.set(key, { key, siteId: r.siteId, siteName: r.siteName, noSite: !!r.noSite });
            by.get(key)[field] = r.result;
        }
    };
    add(k1Site, 'k1');
    if (caps && caps.safety) {
        add(k8Site, 'k8');
        add(k9Site, 'k9');
    }
    const rank = (row) => {
        const st = [row.k1, row.k8, row.k9].filter(Boolean).map((x) => x.status);
        if (st.includes('at_risk')) return 0;
        if (st.includes('watch')) return 1;
        return 2;
    };
    return [...by.values()]
        .map((r) => ({ ...r, rank: rank(r) }))
        .sort(
            (a, b) =>
                a.rank - b.rank ||
                (a.noSite === b.noSite ? 0 : a.noSite ? 1 : -1) ||
                String(a.siteName || '').localeCompare(String(b.siteName || ''))
        );
}

/** A manager's team as aggregates: people per readiness state and per next step; no name. Pure. */
function teamSummary(people, waiting) {
    const byState = { ready: 0, not_ready: 0, partial: 0, not_assessed: 0, no_requirement: 0 };
    for (const p of people || []) if (has(byState, p.state)) byState[p.state]++;
    const w = new Set((waiting || []).map(Number));
    const byNext = {
        validate: (people || []).filter((p) => w.has(p.id)).length,
        assess: byState.not_assessed + byState.partial,
        develop: byState.not_ready,
    };
    return { total: (people || []).length, byState, byNext };
}

// ---------------------------------------------------------------------------
// Aggregate reads of the tabs (ids in, aggregates out, never a name)
// ---------------------------------------------------------------------------

/** The org-unit columns of v_employee_skill_gaps (fixed whitelist). */
const UNIT_COLUMNS = Object.freeze({
    site: { id: 'g.site_id', name: 'g.site_name' },
    department: { id: 'g.department_id', name: 'g.department_name' },
});
/** The axis columns of a capability profile (fixed whitelist). */
const PROFILE_AXES = Object.freeze({
    domain: { key: 'g.domain_id', label: 'g.domain_name', join: '' },
    subdomain: {
        key: 'sd.id',
        label: 'sd.name',
        join: 'JOIN skills sk ON sk.id = g.skill_id JOIN sub_domains sd ON sd.id = sk.sub_domain_id',
    },
    skill: { key: 'g.skill_id', label: 'g.skill_name', join: '' },
});

/** The credited level of one requirement row of v_employee_skill_gaps (fixed SQL). */
const CREDITED = require('../utils/capability').creditedSql('g.actual_level', 'g.required_level');

function profileRow(r) {
    const measured = Number(r.measured) || 0;
    const actual = measured && isNum(r.actual) ? Math.round(Number(r.actual) * 100) / 100 : null;
    const required =
        measured && isNum(r.required) ? Math.round(Number(r.required) * 100) / 100 : null;
    return {
        key: r.key === null || r.key === undefined ? null : String(r.key),
        label: r.label || null,
        actual,
        required,
        n: Number(r.n) || 0,
        measured,
        people: Number(r.people) || 0,
    };
}

/**
 * Demonstrated vs required level per axis, PAIRED over the measured requirement
 * rows. The demonstrated side is the CREDITED level LEAST(actual, required)
 * (src/utils/capability.js): a surplus on one skill or one person never offsets
 * a gap elsewhere, so required − actual is the mean POSITIVE gap.
 */
async function capabilityProfile(ids, axis = 'domain') {
    if (!has(PROFILE_AXES, axis)) throw new Error('capabilityProfile: unknown axis');
    if (!Array.isArray(ids) || !ids.length) return [];
    const A = PROFILE_AXES[axis];
    const rows = await db.all(
        `SELECT ${A.key} AS "key", MAX(${A.label}) AS "label",
                AVG(${CREDITED}) FILTER (WHERE g.is_assessed = 1) AS "actual",
                AVG(g.required_level) FILTER (WHERE g.is_assessed = 1) AS "required",
                COUNT(DISTINCT g.employee_id) FILTER (WHERE g.is_assessed = 1)::int AS "n",
                COALESCE(SUM(g.is_assessed), 0)::int AS "measured",
                COUNT(DISTINCT g.employee_id)::int AS "people"
           FROM v_employee_skill_gaps g ${A.join}
          WHERE g.employee_id = ANY(?)
          GROUP BY ${A.key}
          ORDER BY MAX(${A.label})`,
        [ids]
    );
    return (rows || []).map(profileRow);
}

/**
 * The heatmap cube (utils/heatModel.heatModel): SUMS of the paired levels per
 * (unit × axis) and every marginal in one GROUPING SETS pass, so pooled
 * columns and totals are population aggregates, never a mean of cells. The
 * demonstrated side is the credited level (never above the requirement).
 */
async function capabilityHeat(ids, unit = 'site', level = 'domain') {
    if (!has(UNIT_COLUMNS, unit)) throw new Error('capabilityHeat: unknown unit');
    if (!Array.isArray(ids) || !ids.length) return [];
    const U = UNIT_COLUMNS[unit];
    const A = level === 'subdomain' ? PROFILE_AXES.subdomain : PROFILE_AXES.domain;
    const rows = await db.all(
        `WITH base AS (
             SELECT ${U.id} AS u_id, ${U.name} AS u_name, ${A.key} AS k_id, ${A.label} AS k_label,
                    ${CREDITED} AS act, g.required_level AS req, g.is_assessed AS assessed,
                    g.employee_id AS emp
               FROM v_employee_skill_gaps g ${A.join}
              WHERE g.employee_id = ANY(?)
         )
         SELECT GROUPING(u_id)::int AS "gu", GROUPING(k_id)::int AS "gk",
                u_id AS "unitId", MAX(u_name) AS "unitName", k_id AS "key", MAX(k_label) AS "label",
                SUM(act) FILTER (WHERE assessed = 1) AS "sumActual",
                SUM(req) FILTER (WHERE assessed = 1) AS "sumRequired",
                COALESCE(SUM(assessed), 0)::int AS "measured",
                COUNT(DISTINCT emp) FILTER (WHERE assessed = 1)::int AS "n",
                COUNT(DISTINCT emp)::int AS "people"
           FROM base
          GROUP BY GROUPING SETS ((u_id, k_id), (u_id), (k_id), ())`,
        [ids]
    );
    const nn = (v) => (isNum(v) ? Number(v) : null);
    return (rows || []).map((r) => ({
        part: Number(r.gu) ? (Number(r.gk) ? 'total' : 'axis') : Number(r.gk) ? 'unit' : 'cell',
        unitKey: Number(r.gu)
            ? null
            : r.unitId === null || r.unitId === undefined
              ? 'none'
              : String(r.unitId),
        unitName: r.unitName || null,
        key: Number(r.gk) ? null : r.key === null || r.key === undefined ? null : String(r.key),
        label: r.label || null,
        sumActual: nn(r.sumActual),
        sumRequired: nn(r.sumRequired),
        measured: Number(r.measured) || 0,
        n: Number(r.n) || 0,
        people: Number(r.people) || 0,
    }));
}

/**
 * The capability-map cube (utils/heatModel.capabilityMapModel): SUMS of the
 * paired levels per unit x pillar x sub-domain and every marginal in ONE
 * GROUPING SETS pass, so the pooled columns, the pillar rows and « Whole
 * framework » are population aggregates, never a mean of cells. Its unit and
 * pillar marginals are the capabilityHeat ones (same base).
 */
async function capabilityMap(ids, unit = 'site') {
    if (!has(UNIT_COLUMNS, unit)) throw new Error('capabilityMap: unknown unit');
    if (!Array.isArray(ids) || !ids.length) return [];
    const U = UNIT_COLUMNS[unit];
    const rows = await db.all(
        `WITH base AS (
             SELECT ${U.id} AS u_id, ${U.name} AS u_name, g.domain_id AS p_id,
                    sk.sub_domain_id AS s_id, ${CREDITED} AS act, g.required_level AS req,
                    g.is_assessed AS assessed, g.employee_id AS emp
               FROM v_employee_skill_gaps g
               JOIN skills sk ON sk.id = g.skill_id
              WHERE g.employee_id = ANY(?)
         )
         SELECT GROUPING(u_id)::int AS "gu", GROUPING(p_id)::int AS "gp", GROUPING(s_id)::int AS "gs",
                u_id AS "unitId", MAX(u_name) AS "unitName", p_id AS "pillarId", s_id AS "subId",
                SUM(act) FILTER (WHERE assessed = 1) AS "sumActual",
                SUM(req) FILTER (WHERE assessed = 1) AS "sumRequired",
                COALESCE(SUM(assessed), 0)::int AS "measured",
                COUNT(DISTINCT emp) FILTER (WHERE assessed = 1)::int AS "n"
           FROM base
          GROUP BY GROUPING SETS ((u_id, p_id, s_id), (u_id, p_id), (u_id), (p_id, s_id), (p_id), ())`,
        [ids]
    );
    const nn = (v) => (isNum(v) ? Number(v) : null);
    const key = (v) => (v === null || v === undefined ? null : String(v));
    const partOf = (r) => {
        const g = `${Number(r.gu)}${Number(r.gp)}${Number(r.gs)}`;
        return (
            { '000': 'us', '001': 'up', '011': 'u', 100: 's', 101: 'p', 111: 'total' }[g] || null
        );
    };
    return (rows || [])
        .map((r) => {
            const part = partOf(r);
            const unitKey = Number(r.gu) ? null : key(r.unitId) === null ? 'none' : key(r.unitId);
            return {
                part,
                unitKey,
                unitName: r.unitName || null,
                pillarKey: Number(r.gp) ? null : key(r.pillarId),
                subKey: Number(r.gs) ? null : key(r.subId),
                sumActual: nn(r.sumActual),
                sumRequired: nn(r.sumRequired),
                measured: Number(r.measured) || 0,
                n: Number(r.n) || 0,
            };
        })
        .filter((r) => r.part !== null);
}

/** The active framework in its order: pillars by name, their sub-domains by position. */
async function frameworkTree() {
    const rows = await db.all(
        `SELECT d.id AS "pid", d.name AS "pname", sd.id AS "sid", sd.name AS "sname"
           FROM domains d
           LEFT JOIN sub_domains sd ON sd.domain_id = d.id AND sd.is_active = true
          WHERE d.is_active = true
          ORDER BY d.name, d.id, sd.position, sd.name, sd.id`
    );
    const out = [];
    const by = new Map();
    for (const r of rows || []) {
        const pk = String(r.pid);
        if (!by.has(pk)) {
            const p = { key: pk, label: r.pname, subs: [] };
            by.set(pk, p);
            out.push(p);
        }
        if (r.sid !== null && r.sid !== undefined)
            by.get(pk).subs.push({ key: String(r.sid), label: r.sname });
    }
    return out;
}

/** Requirements and dated assessed levels of a population (the reconstructed trend). */
async function backcastInputs(ids) {
    if (!Array.isArray(ids) || !ids.length) return { reqs: [], events: [] };
    const reqs = await db.all(
        `SELECT g.employee_id AS "e", g.skill_id AS "s", g.required_level AS "r", g.is_critical AS "c"
           FROM v_employee_skill_gaps g WHERE g.employee_id = ANY(?)`,
        [ids]
    );
    const events = await db.all(
        `SELECT ah.employee_id AS "e", ah.skill_id AS "s", ah.new_level AS "l", ah.assessed_at AS "t"
           FROM assessment_history ah WHERE ah.employee_id = ANY(?) AND ah.new_level IS NOT NULL
         UNION ALL
         SELECT sa.employee_id, sa.skill_id, sa.current_level, sa.assessed_at
           FROM skill_assessments sa WHERE sa.employee_id = ANY(?) AND sa.current_level IS NOT NULL`,
        [ids, ids]
    );
    return {
        reqs: (reqs || []).map((x) => ({
            e: Number(x.e),
            s: Number(x.s),
            r: Number(x.r) || 0,
            c: x.c === true || x.c === 't',
        })),
        events: (events || [])
            .map((x) => ({
                e: Number(x.e),
                s: Number(x.s),
                l: Number(x.l),
                t: x.t ? new Date(x.t).getTime() : NaN,
            }))
            .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.l)),
    };
}

/** Approved 9-box positions of a population, counted per cell; no name. */
async function nineBoxCounts(ids) {
    if (!Array.isArray(ids) || !ids.length) return { placed: 0, notPlaced: 0, cells: {} };
    const rows = await db.all(
        `SELECT cur.performance AS "performance", cur.potential AS "potential", COUNT(*)::int AS "n"
           FROM (SELECT DISTINCT ON (ev.employee_id) ev.employee_id, ev.performance, ev.potential
                   FROM nine_box_evaluations ev
                  WHERE ev.employee_id = ANY(?) AND ev.status = 'approved'
                  ORDER BY ev.employee_id, ev.approved_at DESC NULLS LAST, ev.id DESC) cur
          GROUP BY cur.performance, cur.potential`,
        [ids]
    );
    const cells = new Map();
    let placed = 0;
    for (const r of rows || []) {
        const key = `${r.performance}-${r.potential}`;
        if (!has(NINE_BOX_CELLS, key)) continue;
        cells.set(key, (cells.get(key) || 0) + Number(r.n));
        placed += Number(r.n);
    }
    return { placed, notPlaced: ids.length - placed, cells: Object.fromEntries(cells) };
}

/** The most frequent unmet requirements of a population (skill, people), aggregates only. */
async function frequentGaps(ids, limit = 5) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const rows = await db.all(
        `SELECT g.skill_id AS "skillId", MAX(g.skill_name) AS "skillName",
                bool_or(g.is_critical) AS "critical", COUNT(DISTINCT g.employee_id)::int AS "people"
           FROM v_employee_skill_gaps g
          WHERE g.employee_id = ANY(?) AND g.is_assessed = 1 AND g.is_met = 0
          GROUP BY g.skill_id
          ORDER BY COUNT(DISTINCT g.employee_id) DESC, MAX(g.skill_name)
          LIMIT ?`,
        [ids, Math.max(1, Math.min(20, Number(limit) || 5))]
    );
    return (rows || []).map((r) => ({
        skillId: Number(r.skillId),
        skillName: r.skillName,
        critical: r.critical === true || r.critical === 't',
        people: Number(r.people) || 0,
    }));
}

// ---------------------------------------------------------------------------
// Tab models
// ---------------------------------------------------------------------------

/** The unit options of the scope (site or department) for grouping and comparison. */
function groupUnit(ctx) {
    if (ctx.scope && ctx.scope.site !== undefined) return 'department';
    return ctx.caps.multiSite ? 'site' : 'department';
}

/**
 * The model of ONE context tab, lazily loaded (/dashboard/panel?tab=…) or
 * inline when JavaScript is off. Only the blocks the reader may see are
 * computed.
 */
async function tabModel(ctx, tabId, { query = {}, t } = {}) {
    const tab = ctx.tabs.find((x) => x.id === tabId);
    if (!tab) return null;
    const Kpi = K();
    const s = ctx.kpiScope;
    const blocks = blocksFor(tabId, ctx.caps, ctx.flags);
    const want = (b) => blocks.includes(b);
    const m = { id: tabId, blocks, scopeQuery: ctx.scopeQuery };
    const threshold = await Kpi.readinessThreshold();
    m.threshold = threshold;

    if (tabId === 'overview') {
        const [k1, k3, k4] = [
            await Kpi.compute('K1', s),
            await Kpi.compute('K3', s),
            await Kpi.compute('K4', s),
        ];
        const k5 =
            ctx.caps.continuity && Kpi.isAvailable('K5', ctx.flags)
                ? await Kpi.compute('K5', s)
                : null;
        const fresh = await Kpi.computeBlock('assessmentFreshness', s);
        const fr = fresh
            ? { value: fresh.value, status: fresh.status, n: fresh.n, emptyScope: fresh.emptyScope }
            : null;
        m.profile = healthProfile({ k1, k3, k4, k5, fr, caps: ctx.caps, flags: ctx.flags });
        m.gauge = globalGauge(m.profile, threshold);
        if (want('trend')) {
            let current = null;
            try {
                current = await Kpi.snapshotMetrics(s);
            } catch (_) {
                current = null;
            }
            const mv = current ? await movements(ctx, current) : { series: [] };
            m.recorded = (mv.series || []).filter((p) => isNum(p.K1) || isNum(p.K3));
            m.reconstructed = backcastSeries(await backcastInputs(ctx.pop.ids), {
                threshold,
                live: { K1: k1, K3: k3 },
            });
        }
        // « Measurability »: on how many people the score above is computed
        m.measurability = measurability(k1, m.profile);
        if (want('capStrip')) {
            m.groupUnit = groupUnit(ctx);
            m.mapCube = await capabilityMap(ctx.pop.ids, m.groupUnit);
            m.mapTree = await frameworkTree();
            m.mapK2 = await Kpi.k2ByUnit(s, m.groupUnit);
            m.stripOnly = true;
        }
        if (want('siteStatus') && ctx.caps.multiSite) {
            const k1Site = await Kpi.bySite('K1', s);
            const k8Site = ctx.caps.safety ? await Kpi.bySite('K8', s) : null;
            const k9Site = ctx.caps.safety ? await Kpi.bySite('K9', s) : null;
            m.sites = siteStatusRows(k1Site, k8Site, k9Site, ctx.caps);
        }
    }

    if (tabId === 'readiness') {
        m.tiles = ['K1', 'K2', 'K3', 'K4'];
        m.k = {
            K1: await Kpi.compute('K1', s),
            K2: await Kpi.compute('K2', s),
            K3: await Kpi.compute('K3', s),
            K4: await Kpi.compute('K4', s),
        };
        const dist = await Kpi.computeBlock('readinessDistribution', s);
        m.bell = bellCurve(dist ? dist.values : []);
        m.distribution = dist;
        const unit = groupUnit(ctx);
        m.groupUnit = unit;
        const byGroup = await Kpi.computeBlock('k1ByGroup', s, unit);
        m.byGroup = byGroup;
        // K1 by site « with a comparable role mix »: the organisation's role
        // rates applied to each site's roles, beside the observed rate
        if (byGroup && unit === 'site' && ctx.caps.multiSite)
            m.expected = expectedRows(byGroup.rows, await Kpi.k1RoleExpected(s));
        if (want('capabilityMap')) {
            m.mapCube = await capabilityMap(ctx.pop.ids, unit);
            m.mapTree = await frameworkTree();
            m.mapK2 = await Kpi.k2ByUnit(s, unit);
        }
        if (want('compare') && byGroup && byGroup.rows.length >= 2) {
            const options = unit === 'site' ? ctx.opts.sites : ctx.opts.departments;
            const raw = Array.isArray(query.compare)
                ? query.compare[query.compare.length - 1]
                : query.compare;
            const asked = /^[1-9][0-9]{0,9}$/.test(String(raw || '')) ? Number(raw) : null;
            const chosen =
                asked !== null && (options || []).some((o) => o.id === asked)
                    ? asked
                    : defaultCompare(byGroup.rows, options, ctx.pop.ids.length);
            if (chosen !== null) {
                const unitIds = ctx.pop.rows
                    .filter((r) => (unit === 'site' ? r.siteId : r.departmentId) === chosen)
                    .map((r) => r.id);
                const ref = await capabilityProfile(ctx.pop.ids, 'domain');
                const mine = await capabilityProfile(unitIds, 'domain');
                const opt = (options || []).find((o) => o.id === chosen);
                m.compare = {
                    unit,
                    id: chosen,
                    label: opt ? opt.label || opt.name : null,
                    isDefault: asked === null || asked !== chosen,
                    people: unitIds.length,
                    axes: pairProfiles(ref, mine),
                    gaps: rankSkillGaps(await capabilityProfile(unitIds, 'skill')),
                    options: (options || []).map((o) => ({ id: o.id, label: o.label || o.name })),
                };
            }
        }
    }

    if (tabId === 'safety') {
        m.k = {
            K4: await Kpi.compute('K4', s),
            K8: await Kpi.compute('K8', s),
            K9: await Kpi.compute('K9', s),
        };
        m.tiles = ['K9', 'K8', 'K4'];
        if (want('certCalendar')) m.calendar = await Kpi.computeBlock('certExpiryCalendar', s);
        if (want('coverageHeat')) m.coverage = await Kpi.computeBlock('criticalSkillCoverage', s);
    }

    if (tabId === 'talent' && want('nineBox')) {
        m.nineBox = nineBoxPie(await nineBoxCounts(ctx.pop.ids));
    }

    if (tabId === 'succession') {
        m.k = {
            K5: await Kpi.compute('K5', s),
            K6: await Kpi.compute('K6', s),
            K7: await Kpi.compute('K7', s),
        };
        m.tiles = ['K5', 'K6', 'K7'];
    }

    if (tabId === 'development') {
        m.k = { K16: await Kpi.compute('K16', s) };
        m.tiles = ['K16'];
        if (want('devTiles')) {
            for (const id of ['K12', 'K13', 'K15', 'K28', 'K30'])
                if (Kpi.isAvailable(id, ctx.flags)) {
                    m.k[id] = await Kpi.compute(id, s);
                    m.tiles.push(id);
                }
        }
        if (want('devOutcomes') && Kpi.isAvailable('K30', ctx.flags))
            m.devOutcomes = devOutcomesModel(
                m.k.K30 || (await Kpi.compute('K30', s)),
                m.k.K28 || (Kpi.isAvailable('K28', ctx.flags) ? await Kpi.compute('K28', s) : null)
            );
        m.groupUnit = groupUnit(ctx);
        if (want('deficitHeat'))
            m.deficitCube = await capabilityHeat(ctx.pop.ids, m.groupUnit, 'subdomain');
    }

    if (tabId === 'assessments') {
        m.k = { K3: await Kpi.compute('K3', s) };
        m.tiles = ['K3'];
        m.freshness = await Kpi.computeBlock('assessmentFreshness', s);
        if (want('campaign')) {
            m.k.K11 = await Kpi.compute('K11', s);
            m.campaign = currentCampaign(m.k.K11);
        }
        if (want('validations')) m.validations = await pendingValidations(ctx.pop.ids);
    }
    if (m.tiles && m.k)
        m.tileModels = m.tiles
            .map((k) => tileOf(ctx, k, m.k, null, t, { keepEmpty: true }))
            .filter(Boolean);
    const H = require('../utils/heatModel');
    const unitLabel = (u, name) => (u === 'none' ? null : name);
    if (m.mapCube) {
        const map = H.capabilityMapModel(m.mapCube, m.mapTree, {
            unit: m.groupUnit,
            unitLabel,
            hrefOf: (unitKey, part) => domHref(ctx, m.groupUnit, unitKey, part),
        });
        H.withK2Margins(map, m.mapK2);
        if (m.stripOnly) m.capStrip = H.capabilityMapStrip(map);
        else m.capabilityMap = map.empty ? null : map;
    }
    if (m.deficitCube)
        m.deficitHeat = H.heatModel(m.deficitCube, { kind: 'deficit', unitLabel, maxRows: 12 });
    if (m.coverage) m.coverageHeat = H.coverageHeatModel(m.coverage);
    delete m.mapCube;
    delete m.mapTree;
    delete m.mapK2;
    delete m.stripOnly;
    delete m.deficitCube;
    return m;
}

/**
 * The list of the people below the requirement on a pillar or a sub-domain in
 * one unit (a heatmap or capability-map cell). `axisKey` is a pillar id, or a
 * part already prefixed: 'p<id>' (pillar) / 's<id>' (sub-domain).
 */
function domHref(ctx, unit, unitKey, axisKey) {
    if (!drillAllowed(ctx.caps, ctx.flags, 'DOM')) return null;
    const k = String(axisKey);
    const part = /^[1-9][0-9]{0,9}$/.test(k) ? 'p' + k : k;
    if (!T.DRILLS.DOM.partPattern.test(part) || !/^[1-9][0-9]{0,9}$/.test(String(unitKey)))
        return null;
    const s = { ...(ctx.scope || {}) };
    if (unit === 'site') s.site = Number(unitKey);
    else s.department = Number(unitKey);
    return '/dashboard/list?kpi=DOM&part=' + part + '&' + Scope.queryOf(s);
}

// ---------------------------------------------------------------------------
// The list behind a figure (aggregates: by site, by role)
// ---------------------------------------------------------------------------

/** Person ids behind (kpi, part), computed on the reader's population. */
async function drillIds(ctx, kpi, part) {
    const Kpi = K();
    const s = ctx.kpiScope;
    if (kpi === 'K1') {
        const r = await Kpi.compute('K1', s);
        const by = r.drillByState || {};
        return { ids: by[part] || [] };
    }
    if (kpi === 'K4') {
        const r = await Kpi.compute('K4', s);
        const num = new Set(r.numeratorDrill || []);
        return { ids: (r.drill || []).filter((id) => !num.has(id)) };
    }
    if (kpi === 'K8') {
        const r = await Kpi.compute('K8', s);
        if (part === 'expired') return { ids: r.drill || [] };
        if (part === 'expiring') return { ids: r.drillExpiring || [] };
        return { ids: r.drillMissing || [] };
    }
    if (kpi === 'K9') {
        const r = await Kpi.compute('K9', s);
        if (part === 'not_demonstrated') return { ids: r.drillNotDemonstrated || [] };
        const fit = new Set(r.numeratorDrill || []);
        return { ids: (r.drill || []).filter((id) => !fit.has(id)) };
    }
    if (kpi === 'K6') {
        const r = await Kpi.compute('K6', s);
        return { roles: r.drill || [] };
    }
    if (kpi === 'K7') {
        const r = await Kpi.compute('K7', s);
        return { cells: r.drill || [] };
    }
    if (kpi === 'K11') {
        const r = await Kpi.compute('K11', s);
        const c = currentCampaign(r);
        if (!c) return { ids: [] };
        // invited people whose self-assessment is not validated yet
        const done = new Set(c.numeratorDrill || []);
        return { ids: (c.drill || []).filter((id) => !done.has(id)) };
    }
    if (kpi === 'K16') {
        const r = await Kpi.compute('K16', s);
        const items = [];
        for (const e of Object.values(r.byType || {}))
            if (e && !e.hidden) items.push(...(part === 'overdue' ? e.overdueDrill : e.drill));
        return {
            ids: [...new Set(items.map((x) => x.employeeId))].sort((a, b) => a - b),
            plans: items.length,
        };
    }
    if (kpi === 'DOM') {
        // people of the scope with an ASSESSED requirement of the pillar (p<id>)
        // or of the sub-domain (s<id>) below its level
        const axis = Number(String(part).slice(1));
        if (!ctx.pop.ids.length) return { ids: [] };
        const rows =
            String(part).charAt(0) === 's'
                ? await db.all(
                      `SELECT DISTINCT g.employee_id AS "id" FROM v_employee_skill_gaps g
                         JOIN skills sk ON sk.id = g.skill_id
                        WHERE g.employee_id = ANY(?) AND sk.sub_domain_id = ?
                          AND g.is_assessed = 1 AND g.is_met = 0`,
                      [ctx.pop.ids, axis]
                  )
                : await db.all(
                      `SELECT DISTINCT g.employee_id AS "id" FROM v_employee_skill_gaps g
                        WHERE g.employee_id = ANY(?) AND g.domain_id = ? AND g.is_assessed = 1 AND g.is_met = 0`,
                      [ctx.pop.ids, axis]
                  );
        return { ids: (rows || []).map((r) => Number(r.id)).sort((a, b) => a - b) };
    }
    if (kpi === 'VAL') {
        const v = await pendingValidations(ctx.pop.ids);
        return { ids: part === 'overdue' ? v.overdue : v.waiting };
    }
    return { ids: [] };
}

/**
 * The list page behind a figure. Refused (`{forbidden: true}`) BEFORE any list
 * is computed when the reader may not open it. The result carries counts by
 * site and by role (or by skill for K7) — never a name — and the page that
 * holds the names when the reader's navigation offers it.
 */
async function drillList(ctx, kpi, part) {
    if (!has(T.DRILLS, kpi)) return null;
    const d = T.DRILLS[kpi];
    if (!partOk(d, part)) return null;
    if (!drillAllowed(ctx.caps, ctx.flags, kpi)) return { forbidden: true, kpi, part };
    const got = await drillIds(ctx, kpi, part);
    const out = { kpi, part, kind: d.kind, moduleHref: navHref(ctx, d.list), groups: {} };
    if (d.kind === 'roles') {
        const ids = (got.roles || []).map(Number);
        out.count = ids.length;
        out.groups.byRole = ids.length
            ? (
                  await db.all(
                      `SELECT r.id AS "id", r.name AS "label" FROM roles r WHERE r.id = ANY(?) ORDER BY r.name`,
                      [ids]
                  )
              ).map((r) => ({ id: Number(r.id), label: r.label, count: 1 }))
            : [];
        return out;
    }
    if (d.kind === 'cells') {
        const cells = got.cells || [];
        out.count = cells.length;
        const siteNames = new Map((ctx.opts.sites || []).map((x) => [x.id, x.name]));
        const bySite = new Map();
        for (const c of cells) {
            const key = c.siteId === null ? 'none' : String(c.siteId);
            const e = bySite.get(key) || {
                key,
                label: c.siteId === null ? null : siteNames.get(c.siteId) || null,
                none: c.siteId === null,
                count: 0,
            };
            e.count++;
            bySite.set(key, e);
        }
        out.groups.bySite = [...bySite.values()];
        const skillIds = [...new Set(cells.map((c) => c.skillId))];
        const skills = skillIds.length
            ? await db.all(`SELECT id AS "id", name AS "label" FROM skills WHERE id = ANY(?)`, [
                  skillIds,
              ])
            : [];
        const skillName = new Map((skills || []).map((x) => [Number(x.id), x.label]));
        const bySkill = new Map();
        for (const c of cells) bySkill.set(c.skillId, (bySkill.get(c.skillId) || 0) + 1);
        out.groups.bySkill = [...bySkill.entries()]
            .map(([id, count]) => ({ id, label: skillName.get(id) || '#' + id, count }))
            .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
        return out;
    }
    const ids = (got.ids || []).map(Number);
    const set = new Set(ids);
    out.count = ids.length;
    if (got.plans !== undefined) out.plans = got.plans;
    const rows = ctx.pop.rows.filter((r) => set.has(r.id));
    const bySite = new Map();
    for (const r of rows) {
        const key = r.siteId === null ? 'none' : String(r.siteId);
        const e = bySite.get(key) || { key, label: r.siteName, none: r.siteId === null, count: 0 };
        e.count++;
        bySite.set(key, e);
    }
    out.groups.bySite = [...bySite.values()].sort(
        (a, b) => b.count - a.count || (a.none === b.none ? 0 : a.none ? 1 : -1)
    );
    const roleCount = new Map();
    for (const r of rows) roleCount.set(r.roleId, (roleCount.get(r.roleId) || 0) + 1);
    const roleIds = [...roleCount.keys()].filter((x) => x !== null);
    const roleNames = roleIds.length
        ? await db.all(`SELECT id AS "id", name AS "label" FROM roles WHERE id = ANY(?)`, [roleIds])
        : [];
    const rn = new Map((roleNames || []).map((x) => [Number(x.id), x.label]));
    out.groups.byRole = [...roleCount.entries()]
        .map(([id, count]) => ({
            id,
            label: id === null ? null : rn.get(id) || '#' + id,
            none: id === null,
            count,
        }))
        .sort(
            (a, b) =>
                b.count - a.count || String(a.label || '').localeCompare(String(b.label || ''))
        );
    return out;
}

// ---------------------------------------------------------------------------
// The manager's home
// ---------------------------------------------------------------------------

/**
 * The manager's home (/supervisor/dashboard): the people the manager governs
 * (RBACService.scopeFilter, the same population as everywhere), as counts:
 * tiles (K1, validations, K8, K16), people per readiness state and per next
 * step, the most frequent gaps. No name: the named roster is « My team »
 * (/supervisor/team).
 */
async function teamHome(ctx, { t, fmt } = {}) {
    const Kpi = K();
    const s = ctx.kpiScope;
    if (!ctx.caps.pop) return { empty: true, tiles: [], summary: teamSummary([], []), gaps: [] };
    const ind = {};
    ind.K1 = await Kpi.compute('K1', s);
    ind.VAL = await pendingValidations(ctx.pop.ids);
    if (ctx.caps.safety) ind.K8 = await Kpi.compute('K8', s);
    ind.K16 = await Kpi.compute('K16', s);
    const mv = { since: null, values: {}, series: [] };
    const tiles = ['K1', 'VAL', 'K8', 'K16']
        .filter((k) => has(ind, k))
        .map((k) => tileOf(ctx, k, ind, mv, t))
        .filter(Boolean);
    const { people } = await Kpi.readinessBundle(s);
    return {
        empty: false,
        tiles,
        brief: briefLines(ind, mv, fmt, t),
        summary: teamSummary(people, ind.VAL.waiting),
        gaps: await frequentGaps(ctx.pop.ids, 5),
        coverage: (await Kpi.compute('K3', s)).value,
    };
}

module.exports = {
    // config
    HEALTH_AXES,
    GAUGE_MIN_AXES,
    BELL_MIN_N,
    NINE_BOX_CELLS,
    UNIT_COLUMNS,
    PROFILE_AXES,
    // capabilities, tabs
    capabilities,
    tabsFor,
    resolveTab,
    blocksFor,
    drillAllowed,
    partOk,
    domHref,
    hiddenAreas,
    moduleOn,
    // request
    context,
    navHref,
    drillHref,
    scopeLabel,
    // figures
    indicators,
    tileOf,
    firstRow,
    briefLines,
    whatChanged,
    setupItems,
    firstScreen,
    movements,
    deltaValues,
    monthlySeries,
    sparkOf,
    snapshotScope,
    pendingValidations,
    // pure blocks
    healthProfile,
    globalGauge,
    bellCurve,
    nineBoxPie,
    backcastSeries,
    measurability,
    expectedRows,
    defaultCompare,
    pairProfiles,
    rankSkillGaps,
    siteStatusRows,
    teamSummary,
    // reads
    capabilityProfile,
    capabilityHeat,
    capabilityMap,
    frameworkTree,
    backcastInputs,
    nineBoxCounts,
    frequentGaps,
    // tabs, lists, homes
    tabModel,
    drillList,
    teamHome,
};
