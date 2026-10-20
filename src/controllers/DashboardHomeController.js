'use strict';

/**
 * DashboardHomeController — the dashboard pages (no SQL here: every figure
 * comes from DashboardHomeService, which reads KpiService).
 *
 *   GET /dashboard                  the dashboard: scope bar, « In brief », the
 *                                   first row of tiles, the context tabs (the
 *                                   active one inline, the others on demand)
 *   GET /dashboard/panel?tab=…      one context tab as an HTML fragment, with
 *                                   the same scope and the same gates as the page
 *   GET /dashboard/list?kpi=…&part= the list behind a figure, as aggregates
 *   GET /supervisor/dashboard       the manager's home (their team, counts only)
 *   GET /supervisor/team            « My team »: the named roster of the manager
 *   GET /exec/board-pack            the printable board pack (counts only)
 *
 * An employee who reaches /dashboard is taken to their own home. A manager's
 * « Dashboard » is /supervisor/dashboard; /dashboard (Reports → Indicators)
 * shows them the same page as an administrator, on their team.
 */

const D = require('../services/DashboardHomeService');
const T = require('../config/dashboardTabs');
const NAV = require('../config/navigation');
const RC = require('../utils/readerCache');

/**
 * The heavy models go through the per-reader cache (src/utils/readerCache.js):
 * the entry belongs to this reader, this clearance, this scope, this language
 * and these parameters, and any successful write drops it.
 */
function cached(name, ctx, res, extra, compute) {
    const parts = {
        ...RC.contextParts(ctx),
        lang: (res && res.locals && res.locals.lang) || '',
        ...(extra || {}),
    };
    return RC.memo(name, parts, compute);
}

/**
 * The query of a request as sorted [name, value] pairs of plain strings (what a
 * tab model may read). An array, never an object keyed by request data.
 */
function queryParts(q) {
    return Object.entries(q || {})
        .filter(([, v]) => typeof v === 'string' || Array.isArray(v))
        .map(([k, v]) => [
            String(k).slice(0, 50),
            Array.isArray(v) ? v.slice(0, 50).map((x) => String(x).slice(0, 200)) : v.slice(0, 200),
        ])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Tabs whose inline content draws a canvas (Chart.js is loaded only for them). */
const CHART_TABS = Object.freeze(['overview', 'readiness']);

/** Chart.js and the chart theme are needed on first paint? (« Print everything » renders every tab.) */
function needsChart(activeTab, printAll) {
    return !!printAll || CHART_TABS.includes(String(activeTab || T.DEFAULT_TAB));
}

function navVisible(res) {
    try {
        return NAV.gates(NAV.buildContext(res.locals || {}));
    } catch (_) {
        return {};
    }
}

function tr(req) {
    return typeof req.t === 'function' ? req.t.bind(req) : (k) => k;
}

/** The query keys a dashboard URL may carry (anything else is dropped from links). */
function tabQuery(q) {
    const keep = {};
    if (typeof q.tab === 'string' && /^[a-z]{1,20}$/.test(q.tab)) keep.tab = q.tab;
    return keep;
}

const DashboardHomeController = {
    needsChart,
    CHART_TABS,

    /** GET /dashboard */
    async page(req, res, next) {
        try {
            const q = req.query || {};
            const ctx = await D.context({
                user: req.user,
                query: q,
                page: 'dashboard',
                navVisible: navVisible(res),
            });
            const t = tr(req);
            const fmt = res.locals.numFmt;
            const printAll = q.print === 'all';
            const screen = await cached('firstScreen', ctx, res, null, () =>
                D.firstScreen(ctx, { t, fmt, dateFmt: res.locals.fmtDate })
            );
            const active = D.resolveTab(q.tab, ctx.tabs);
            const panels = [];
            if (active) {
                const ids = printAll ? ctx.tabs.map((x) => x.id) : [active];
                for (const id of ids)
                    panels.push(
                        await cached('tab', ctx, res, { tab: id, query: queryParts(q) }, () =>
                            D.tabModel(ctx, id, { query: q, t })
                        )
                    );
            }
            let smtpRelay = null;
            if (req.user && req.user.userType === 'admin') {
                try {
                    smtpRelay = await require('../services/EmailService').plaintextRelayStatus();
                } catch (_) {
                    smtpRelay = null;
                }
            }
            res.status(ctx.scopeRefused ? 400 : 200).render('pages/dashboard/index', {
                title: t('dash:d3_title'),
                ctx,
                screen,
                scopeLabel: D.scopeLabel(ctx, t),
                tabs: ctx.tabs,
                active,
                panels: panels.filter(Boolean),
                printAll,
                needsChart: needsChart(active, printAll),
                keep: tabQuery(q),
                smtpRelay,
                asOf: RC.computedAt(screen) || new Date(),
                navLinks: {
                    boardPack: D.navHref(ctx, 'board_pack'),
                    glossary: D.navHref(ctx, 'kpi_glossary'),
                },
            });
        } catch (err) {
            next(err);
        }
    },

    /** GET /dashboard/panel?tab=… — one tab, the same scope and gates as the page. */
    async panel(req, res, next) {
        try {
            const q = req.query || {};
            const ctx = await D.context({
                user: req.user,
                query: q,
                page: 'dashboard',
                remember: false,
                navVisible: navVisible(res),
            });
            if (ctx.scopeRefused) return res.status(400).type('text/plain').send('');
            const want = typeof q.tab === 'string' ? q.tab : '';
            const active = D.resolveTab(want, ctx.tabs);
            // an unknown or unauthorised tab is not silently swapped for another
            if (
                !active ||
                (active !== want && !Object.prototype.hasOwnProperty.call(T.LEGACY_TABS, want))
            )
                return res.status(404).type('text/plain').send('');
            const model = await cached('tab', ctx, res, { tab: active, query: queryParts(q) }, () =>
                D.tabModel(ctx, active, { query: q, t: tr(req) })
            );
            res.set('Cache-Control', 'no-store');
            res.render('pages/dashboard/_panel', {
                layout: false,
                ctx,
                panel: model,
            });
        } catch (err) {
            next(err);
        }
    },

    /** GET /dashboard/list?kpi=…&part=… — the population behind a figure, counted. */
    async list(req, res, next) {
        try {
            const q = req.query || {};
            const kpi = typeof q.kpi === 'string' ? q.kpi : '';
            const part = typeof q.part === 'string' ? q.part : '';
            if (
                !Object.prototype.hasOwnProperty.call(T.DRILLS, kpi) ||
                !D.partOk(T.DRILLS[kpi], part)
            )
                return res.status(404).render('pages/errors/404', {
                    title: tr(req)('dash:d3_list_title'),
                });
            const ctx = await D.context({
                user: req.user,
                query: q,
                page: 'dashboard',
                remember: false,
                navVisible: navVisible(res),
            });
            const t = tr(req);
            const back = '/dashboard' + (ctx.scopeQuery ? '?' + ctx.scopeQuery : '');
            if (ctx.scopeRefused) {
                return res.status(400).render('pages/dashboard/list', {
                    title: t('dash:d3_list_title'),
                    ctx,
                    list: null,
                    refused: true,
                    back,
                    scopeLabel: D.scopeLabel(ctx, t),
                });
            }
            const list = await D.drillList(ctx, kpi, part);
            res.status(list && list.forbidden ? 403 : 200).render('pages/dashboard/list', {
                title: t('dash:d3_list_title'),
                ctx,
                list,
                refused: false,
                back,
                scopeLabel: D.scopeLabel(ctx, t),
            });
        } catch (err) {
            next(err);
        }
    },

    /** GET /supervisor/dashboard — the manager's home: their team in counts. */
    async teamHome(req, res, next) {
        try {
            const ctx = await D.context({
                user: req.user,
                query: {},
                page: 'dashboard',
                remember: false,
                navVisible: navVisible(res),
            });
            const t = tr(req);
            const home = await cached('teamHome', ctx, res, null, () =>
                D.teamHome(ctx, { t, fmt: res.locals.numFmt })
            );
            res.render('pages/dashboard/team', {
                title: t('dash:d3_title'),
                ctx,
                home,
                scopeLabel: D.scopeLabel(ctx, t),
                asOf: RC.computedAt(home) || new Date(),
            });
        } catch (err) {
            next(err);
        }
    },

    /** GET /supervisor/team — « My team »: one row per direct report (names live here). */
    async teamRoster(req, res) {
        let team = null;
        try {
            team = await require('../services/TeamRosterService').forManager(req.user);
        } catch (_) {
            team = null;
        }
        res.render('pages/supervisor/team', {
            title: tr(req)('dash:d3_roster_title'),
            team,
        });
    },

    /** GET /exec/board-pack — the printable board pack, counts only. */
    async boardPack(req, res, next) {
        try {
            const q = req.query || {};
            const ctx = await D.context({
                user: req.user,
                query: q,
                page: 'board_pack',
                navVisible: navVisible(res),
            });
            const t = tr(req);
            const screen = await cached('firstScreen', ctx, res, null, () =>
                D.firstScreen(ctx, {
                    t,
                    fmt: res.locals.numFmt,
                    dateFmt: res.locals.fmtDate,
                })
            );
            const overview = ctx.tabs.some((x) => x.id === 'overview')
                ? await cached('tab', ctx, res, { tab: 'overview', query: [] }, () =>
                      D.tabModel(ctx, 'overview', { query: {}, t })
                  )
                : null;
            // targets and gaps, since the last pack, decisions, K17 / K19 /
            // K20, site deltas, the Development section (BoardPackService)
            const B = require('../services/BoardPackService');
            const board =
                ctx.caps.pop && !ctx.scopeRefused
                    ? await cached('boardPack', ctx, res, null, () =>
                          B.packModel(ctx, screen, { t })
                      )
                    : null;
            res.status(ctx.scopeRefused ? 400 : 200).render('pages/exec/board-pack', {
                title: t('exec:bp_title'),
                ctx,
                screen,
                overview,
                board,
                hidden: require('./BoardDecisionController').hiddenFields(ctx.scope),
                scopeLabel: D.scopeLabel(ctx, t),
                // the time the figures were computed (a cached pack says so)
                generatedAt: RC.computedAt(screen) || new Date(),
                currentPath: '/exec/board-pack',
            });
        } catch (err) {
            next(err);
        }
    },
};

module.exports = DashboardHomeController;
