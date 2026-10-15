'use strict';
/**
 * The dashboard's pure rules (no database):
 *   - capabilities: plain permission reading, never a job title; a viewer
 *     never acts; an employee gets nothing (their home is separate);
 *   - context tabs: module, capability and workspace gates, the binding order,
 *     ?tab= (and the former tab names) resolution;
 *   - every list (drill) needs the block's capability AND `names`, its module on;
 *   - the first row: configured tiles only, most severe first, at most 5;
 *   - the overall gauge: measured areas only, partial below the full set, no
 *     score under 3 areas, an area outside the clearance omitted;
 *   - the bell curve hidden under 20 people; the 9-box doughnut with « Not
 *     placed » apart and small cells merged (never one alone);
 *   - the reconstructed trend: gaps before any evidence, small months gaps,
 *     never a movement (movements read snapshots of the same contract only);
 *   - comparison: the weakest measured unit with ≥ 5 people inside the
 *     clearance, deterministic; the widest MEASURED gaps only;
 *   - sparklines from ≥ 3 usable points; a missing side is no movement;
 *   - aggregates only: no name field, no name SQL in the dashboard code;
 *   - the former endpoints are declared retired; FR / EN parity.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
}));

const D = require('../../src/services/DashboardHomeService');
const T = require('../../src/config/dashboardTabs');
const WS = require('../../src/config/workspaceComponents');

const ALL_ON = {
    campaigns: true,
    development: true,
    talent: true,
    mobility: true,
    engagement: true,
    ai: true,
    localContent: false,
};
const STAGE1 = {
    ...ALL_ON,
    development: false,
    talent: false,
    mobility: false,
    engagement: false,
    ai: false,
};
const pop = (n, sites = [1]) => ({
    ids: Array.from({ length: n }, (_, i) => i + 1),
    rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, siteId: sites[i % sites.length] })),
});
const SA = { id: 1, userType: 'admin', role: 'superadmin' };
const admin = (perms, role = 'localadmin') => ({
    id: 9,
    userType: 'admin',
    role,
    permissions: perms,
});
const MGR = { id: 5, userType: 'manager' };

describe('capabilities: permission reading only', () => {
    test('SuperAdmin: every area', () => {
        const c = D.capabilities(SA, pop(10, [1, 2]));
        for (const k of [
            'pop',
            'names',
            'safety',
            'continuity',
            'campaign',
            'validate',
            'assess',
            'plans',
            'talent',
            'skills',
            'multiSite',
        ])
            expect([k, c[k]]).toEqual([k, true]);
    });
    test('a manager: their line rights over the team; never campaigns or succession', () => {
        const c = D.capabilities(MGR, pop(6));
        expect(c.names && c.safety && c.validate && c.plans && c.talent && c.skills).toBe(true);
        expect(c.campaign || c.continuity).toBe(false);
    });
    test('a viewer reads, never acts; an auditor without a people grant opens no list', () => {
        const c = D.capabilities(
            admin(['view_compliance', 'view_continuity', 'manage_cycles'], 'viewer'),
            pop(6)
        );
        expect(c.safety && c.continuity).toBe(true);
        expect(c.names).toBe(false);
        // manage_cycles is a write grant: a viewer never holds it
        expect(c.campaign).toBe(false);
    });
    test('nobody in the clearance: no population, so no tab at all', () => {
        const c = D.capabilities(SA, { ids: [], rows: [] });
        expect(c.pop).toBe(false);
        expect(D.tabsFor(c, ALL_ON, SA)).toEqual([]);
    });
});

describe('context tabs: gates, order, resolution', () => {
    test('SuperAdmin at stage 3: the seven tabs in the binding order', () => {
        const tabs = D.tabsFor(D.capabilities(SA, pop(10)), ALL_ON, SA).map((t) => t.id);
        expect(tabs).toEqual([
            'overview',
            'readiness',
            'safety',
            'talent',
            'succession',
            'development',
            'assessments',
        ]);
    });
    test('a tab of a module that is off is omitted (stage 1: no succession)', () => {
        const tabs = D.tabsFor(D.capabilities(SA, pop(10)), STAGE1, SA).map((t) => t.id);
        expect(tabs).not.toContain('succession');
        expect(tabs).toContain('talent'); // the 9-box grid is core
    });
    test('each tab needs its capability', () => {
        const steward = admin(['view_employees', 'view_domains_skills']);
        const tabs = D.tabsFor(D.capabilities(steward, pop(10)), ALL_ON, steward).map((t) => t.id);
        expect(tabs).toEqual(['overview', 'readiness']);
    });
    test('a tab a SuperAdmin hid for an administrator is not offered (workspace component)', () => {
        const u = admin(['view_compliance', 'view_employees']);
        u.workspacePrefs = { 'tab:safety': false };
        const tabs = D.tabsFor(D.capabilities(u, pop(10)), ALL_ON, u).map((t) => t.id);
        expect(tabs).not.toContain('safety');
    });
    test('?tab= unknown or unauthorised ⇒ the overview; former tab names are understood', () => {
        const tabs = D.tabsFor(D.capabilities(SA, pop(10)), ALL_ON, SA);
        expect(D.resolveTab('readiness', tabs)).toBe('readiness');
        expect(D.resolveTab('nope', tabs)).toBe('overview');
        expect(D.resolveTab(['safety', 'talent'], tabs)).toBe('talent');
        expect(D.resolveTab('executive', tabs)).toBe('overview');
        expect(D.resolveTab('comparator', tabs)).toBe('readiness');
        expect(D.resolveTab('talentdev', tabs)).toBe('talent');
        expect(D.resolveTab('safety', [{ id: 'overview' }])).toBe('overview');
    });
    test('the workspace keys stored before keep applying to their successors', () => {
        const u = admin(['view_continuity', 'manage_talent_reviews']);
        u.workspacePrefs = { 'tab:talentdev': false, 'tab:executive': true };
        expect(WS.isVisible('tab:talent', u)).toBe(false);
        expect(WS.isVisible('tab:succession', u)).toBe(false);
        expect(WS.isVisible('tab:overview', u)).toBe(true);
        u.workspacePrefs = { 'tab:talentdev': false, 'tab:talent': true };
        expect(WS.isVisible('tab:talent', u)).toBe(true);
        expect(
            WS.describeFor(u)
                .filter((c) => c.group === 'tab')
                .map((c) => c.key)
        ).toEqual(T.TABS.map((t) => 'tab:' + t.id));
    });
    test('every tab and block carries a module and a permission', () => {
        for (const t of T.TABS) {
            expect(Object.prototype.hasOwnProperty.call(t, 'module')).toBe(true);
            expect(Object.prototype.hasOwnProperty.call(t, 'permission')).toBe(true);
        }
        for (const b of T.BLOCKS) {
            expect([b.id, Object.prototype.hasOwnProperty.call(b, 'module')]).toEqual([b.id, true]);
            expect([b.id, Object.prototype.hasOwnProperty.call(b, 'permission')]).toEqual([
                b.id,
                true,
            ]);
        }
        expect(D.blocksFor('assessments', D.capabilities(SA, pop(10)), STAGE1)).toContain(
            'campaign'
        );
        expect(D.blocksFor('development', D.capabilities(SA, pop(10)), STAGE1)).not.toContain(
            'devTiles'
        );
    });
});

describe('lists: the block capability AND names, the module on', () => {
    test('drillAllowed', () => {
        const c = D.capabilities(SA, pop(10));
        expect(D.drillAllowed(c, ALL_ON, 'K6')).toBe(true);
        expect(D.drillAllowed(c, STAGE1, 'K6')).toBe(false);
        const auditor = D.capabilities(admin(['view_compliance'], 'viewer'), pop(10));
        expect(D.drillAllowed(auditor, ALL_ON, 'K8')).toBe(false); // no names
        const steward = D.capabilities(admin(['view_employees']), pop(10));
        expect(D.drillAllowed(steward, ALL_ON, 'K8')).toBe(false); // no safety
        expect(D.drillAllowed(steward, ALL_ON, 'K1')).toBe(true);
        expect(D.drillAllowed(c, ALL_ON, 'NOPE')).toBe(false);
    });
    test('a list part is a fixed word or the list own id pattern; the href keeps the scope', () => {
        expect(D.partOk(T.DRILLS.K1, 'not_ready')).toBe(true);
        expect(D.partOk(T.DRILLS.K1, "not_ready' OR 1=1")).toBe(false);
        expect(D.partOk(T.DRILLS.DOM, 'p12')).toBe(true);
        expect(D.partOk(T.DRILLS.DOM, 'p1 OR 1=1')).toBe(false);
        const ctx = {
            caps: D.capabilities(SA, pop(10)),
            flags: ALL_ON,
            scopeQuery: 'site=4',
            scope: { site: 4 },
        };
        expect(D.drillHref(ctx, 'K1', 'not_ready')).toBe(
            '/dashboard/list?kpi=K1&part=not_ready&site=4'
        );
        expect(D.drillHref(ctx, 'K1', 'nope')).toBeNull();
        expect(D.domHref({ ...ctx }, 'department', '7', '12')).toBe(
            '/dashboard/list?kpi=DOM&part=p12&site=4&department=7'
        );
        expect(D.domHref(ctx, 'site', 'none', '12')).toBeNull();
    });
    test('hidden areas: only those whose module is on', () => {
        const steward = D.capabilities(admin(['view_employees']), pop(10));
        expect(D.hiddenAreas(steward, ALL_ON)).toEqual([
            'safety',
            'succession',
            'campaigns',
            'validations',
            'talent',
        ]);
        expect(D.hiddenAreas(steward, STAGE1)).toEqual([
            'safety',
            'campaigns',
            'validations',
            'talent',
        ]);
    });
});

describe('the first row: configured, most severe first, at most 5', () => {
    const t = (k) => k;
    const ctx = { caps: D.capabilities(SA, pop(10)), flags: ALL_ON, scopeQuery: '' };
    test('never a « not configured » tile; ranking by severity then canonical order', () => {
        const ind = {
            K1: {
                status: 'watch',
                value: 60,
                numerator: 6,
                denominator: 10,
                breakdown: { notReady: 4 },
            },
            K3: { status: 'compliant', value: 90, numerator: 9, denominator: 10 },
            K4: {
                status: 'at_risk',
                value: 40,
                numerator: 4,
                denominator: 10,
                drill: [1, 2],
                numeratorDrill: [1],
            },
            K8: { status: 'not_configured', value: null },
            K9: {
                status: 'compliant',
                value: 100,
                numerator: 5,
                denominator: 5,
                breakdown: { unfit: 0 },
            },
            K16: { status: 'compliant', value: 3, overdue: 0 },
            VAL: { waiting: [1, 2], overdue: [1] },
        };
        const all = ['K9', 'K8', 'K1', 'VAL', 'K3', 'K16', 'K4']
            .map((k) => D.tileOf(ctx, k, ind, null, t))
            .filter(Boolean);
        expect(all.map((x) => x.kpi)).not.toContain('K8');
        const row = D.firstRow(all).map((x) => x.kpi);
        expect(row).toEqual(['K4', 'K1', 'VAL', 'K9', 'K3']);
        expect(row.length).toBeLessThanOrEqual(T.FIRST_ROW_MAX);
    });
    test('a list link only where the reader may open it, with the count it opens', () => {
        const ind = {
            K1: {
                status: 'watch',
                value: 60,
                numerator: 6,
                denominator: 10,
                breakdown: { notReady: 4 },
            },
        };
        const tile = D.tileOf(ctx, 'K1', ind, null, t);
        expect(tile.drillHref).toBe('/dashboard/list?kpi=K1&part=not_ready');
        expect(tile.drillCount).toBe(4);
        const auditor = {
            ...ctx,
            caps: D.capabilities(admin(['view_compliance'], 'viewer'), pop(10)),
        };
        expect(D.tileOf(auditor, 'K1', ind, null, t).drillHref).toBeUndefined();
    });
});

describe('the overall gauge and the health profile', () => {
    const r = (value, status = 'watch') => ({ value, status, n: 20 });
    const caps = { safety: true, continuity: true };
    test('5 measured areas ⇒ the weighted mean, not partial', () => {
        const p = D.healthProfile({
            k1: r(80),
            k3: r(60),
            k4: r(100),
            k5: r(50),
            fr: r(70),
            caps,
            flags: ALL_ON,
        });
        const g = D.globalGauge(p, 80);
        expect(g.partial).toBe(false);
        expect(g.score).toBeCloseTo((80 * 30 + 60 * 15 + 100 * 25 + 50 * 15 + 70 * 15) / 100, 1);
    });
    test('an unmeasured area is never 0 or 100: a partial score over the measured ones', () => {
        const p = D.healthProfile({
            k1: r(80),
            k3: r(60),
            k4: { status: 'not_measured', value: null },
            k5: null,
            fr: r(70),
            caps,
            flags: ALL_ON,
        });
        const g = D.globalGauge(p, 80);
        expect(g.partial).toBe(true);
        expect(g.measuredCount).toBe(3);
        expect(g.score).toBeCloseTo((80 * 30 + 60 * 15 + 70 * 15) / 60, 1);
    });
    test('fewer than 3 measured areas ⇒ no score', () => {
        const p = D.healthProfile({
            k1: r(80),
            k3: { status: 'small_n', value: null, n: 3 },
            k4: null,
            k5: null,
            fr: r(50),
            caps,
            flags: ALL_ON,
        });
        expect(D.globalGauge(p).score).toBeNull();
    });
    test('an area outside the clearance is omitted, never computed; a module that is off is not an area', () => {
        const p = D.healthProfile({
            k1: r(80),
            k3: r(60),
            k4: r(90),
            k5: r(70),
            fr: r(70),
            caps: { safety: false, continuity: true },
            flags: STAGE1,
        });
        expect(p.axes.map((a) => a.key)).toEqual(['K1', 'K3', 'K4', 'FR']);
        expect(p.axes.find((a) => a.key === 'K4').state).toBe('outside');
        expect(p.partial).toBe(true);
    });
});

describe('bell curve and 9-box doughnut', () => {
    test('the bell curve is hidden under 20 people; the reference curve has the same mean', () => {
        expect(D.bellCurve([50, 60, 70]).hidden).toBe(true);
        const vals = Array.from({ length: 30 }, (_, i) => 40 + i);
        const b = D.bellCurve(vals);
        expect(b.hidden).toBe(false);
        expect(b.mean).toBeCloseTo(54.5, 1);
        expect(b.bins.reduce((s, x) => s + x.count, 0)).toBe(30);
        expect(b.curve.length).toBe(21);
        expect(D.bellCurve([null, undefined, 'x']).n).toBe(0);
    });
    test('the doughnut: « Not placed » apart, cells under 5 merged, never one small cell alone', () => {
        const p = D.nineBoxPie({
            placed: 10,
            notPlaced: 4,
            cells: { 'high-high': 7, 'medium-medium': 2, 'low-low': 1 },
        });
        expect(p.slices.map((s) => s.kind)).toEqual(['cell', 'others', 'not_placed']);
        expect(p.slices[1].count).toBe(3);
        const lone = D.nineBoxPie({
            placed: 8,
            notPlaced: 0,
            cells: { 'high-high': 6, 'low-low': 2 },
        });
        // the lone small cell is merged with the next smallest: its count cannot be worked out
        expect(lone.slices).toEqual([{ kind: 'others', count: 8, pct: 100, cells: 2 }]);
        expect(D.nineBoxPie({ placed: 0, notPlaced: 3, cells: {} }).slices).toEqual([
            { kind: 'not_placed', count: 3, pct: 100 },
        ]);
    });
});

describe('the reconstructed trend is an estimate, never a movement', () => {
    const now = Date.UTC(2026, 9, 15);
    const reqs = [];
    const events = [];
    for (let e = 1; e <= 6; e++) {
        reqs.push({ e, s: 1, r: 2, c: true });
        events.push({ e, s: 1, l: e <= 4 ? 2 : 1, t: Date.UTC(2026, 6, 10) });
    }
    test('months before any evidence are gaps (null), never 0 %; then the replayed values', () => {
        const s = D.backcastSeries({ reqs, events }, { months: 6, now });
        expect(s.map((p) => p.month)).toEqual([
            '2026-05',
            '2026-06',
            '2026-07',
            '2026-08',
            '2026-09',
            '2026-10',
        ]);
        expect(s[0].K1).toBeNull();
        expect(s[0].K3).toBeNull();
        expect(s[2].K1).toBeCloseTo(66.7, 1);
        expect(s[5].K3).toBe(100);
    });
    test('fewer than 5 people behind a month ⇒ a gap', () => {
        const s = D.backcastSeries(
            { reqs: reqs.slice(0, 4), events: events.slice(0, 4) },
            { months: 2, now }
        );
        expect(s.every((p) => p.K1 === null && p.K3 === null)).toBe(true);
    });
    test('movements read snapshots of the same contract only, never the reconstruction', () => {
        const src = read('src/services/DashboardHomeService.js');
        const mv = src.slice(
            src.indexOf('async function movements('),
            src.indexOf('function deltaValues(')
        );
        expect(mv).toMatch(/priorSnapshot\(sc\.scopeType, sc\.scopeId, 28, contract\)/);
        expect(mv).toMatch(/r\.kpiContract === contract/);
        expect(mv).not.toMatch(/backcast/);
        expect(
            D.deltaValues(
                { roleReadyCount: 6, notReadyCount: 4 },
                { roleReadyCount: null, notReadyCount: 3 }
            )
        ).toEqual({});
        expect(D.deltaValues({ certsExpired: 3 }, { certsExpired: 1 })).toEqual({ K8: 2 });
        expect(D.deltaValues(null, { certsExpired: 1 })).toEqual({});
    });
    test('a sparkline needs 3 usable points; a small-n month is a gap', () => {
        const series = D.monthlySeries([
            { date: '2026-07-31', roleReadyCount: 6, notReadyCount: 4 },
            { date: '2026-08-31', roleReadyCount: 2, notReadyCount: 1 },
            { date: '2026-09-30', roleReadyCount: 7, notReadyCount: 3 },
        ]);
        expect(series.map((p) => p.K1)).toEqual([60, null, 70]);
        expect(D.sparkOf(series, 'K1')).toBeNull();
        series.push({ month: '2026-10', K1: 72 });
        expect(D.sparkOf(series, 'K1')).toEqual([60, null, 70, 72]);
    });
});

describe('comparison: the weakest measured unit, deterministic', () => {
    const options = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    test('the weakest measured unit with ≥ 5 people inside the clearance', () => {
        const groups = [
            { id: 1, value: 70, population: 8 },
            { id: 2, value: 40, population: 6 },
            { id: 3, value: 20, population: 3 }, // fewer than 5
            { id: 9, value: 10, population: 9 }, // outside the options
            { id: 4, value: null, population: 12 }, // not measured is not weakest
            { id: null, none: true, value: 5, population: 9 },
        ];
        expect(D.defaultCompare(groups, options, 50)).toBe(2);
    });
    test('ties: larger population first, then id; nothing measured ⇒ null; never the whole population', () => {
        expect(
            D.defaultCompare(
                [
                    { id: 3, value: 40, population: 6 },
                    { id: 2, value: 40, population: 9 },
                ],
                options,
                50
            )
        ).toBe(2);
        expect(
            D.defaultCompare(
                [
                    { id: 1, value: 40, population: 6 },
                    { id: 2, value: 40, population: 6 },
                ],
                options,
                50
            )
        ).toBe(1);
        expect(D.defaultCompare([{ id: 1, value: null, population: 6 }], options, 50)).toBeNull();
        expect(D.defaultCompare([{ id: 1, value: 30, population: 10 }], options, 10)).toBeNull();
    });
    test('paired axes carry the n that hides them; unmeasured is null, never 0', () => {
        const ref = [
            { key: '1', label: 'A', actual: 2, required: 3, n: 10, measured: 10 },
            { key: '2', label: 'B', actual: 2.5, required: 3, n: 10, measured: 10 },
        ];
        const unit = [
            { key: '1', label: 'A', actual: 1.5, required: 3, n: 6, measured: 6 },
            { key: '2', label: 'B', actual: 1, required: 3, n: 3, measured: 3 },
        ];
        const ax = D.pairProfiles(ref, unit);
        expect(ax[0]).toEqual({ key: '1', label: 'A', ref: 2, unit: 1.5, required: 3, axisN: 6 });
        expect(ax[1].unit).toBeNull();
        expect(ax[1].axisN).toBe(3);
        expect(D.pairProfiles(ref, [])[0].axisN).toBe(0);
    });
    test('only the widest MEASURED gaps with ≥ 5 people are ranked, at most 12', () => {
        const rows = [
            { label: 'x', actual: 1, required: 3, n: 6, measured: 6 },
            { label: 'y', actual: 2, required: 3, n: 6, measured: 6 },
            { label: 'z', actual: 0, required: 3, n: 2, measured: 2 },
            { label: 'w', actual: null, required: null, n: 0, measured: 0 },
            { label: 'v', actual: 3, required: 3, n: 9, measured: 9 },
        ];
        expect(D.rankSkillGaps(rows).map((r) => r.label)).toEqual(['x', 'y']);
        const many = Array.from({ length: 20 }, (_, i) => ({
            label: 's' + i,
            actual: 0,
            required: 3,
            n: 5,
            measured: 5,
        }));
        expect(D.rankSkillGaps(many)).toHaveLength(12);
    });
});

describe('aggregates only: no name anywhere', () => {
    test('the team summary: states and next steps, no name field', () => {
        const people = [
            { id: 1, state: 'ready', firstName: 'X' },
            { id: 2, state: 'not_ready' },
            { id: 3, state: 'partial' },
            { id: 4, state: 'not_assessed' },
        ];
        const s = D.teamSummary(people, [2, 9]);
        expect(s).toEqual({
            total: 4,
            byState: { ready: 1, not_ready: 1, partial: 1, not_assessed: 1, no_requirement: 0 },
            byNext: { validate: 1, assess: 2, develop: 1 },
        });
        expect(JSON.stringify(s)).not.toMatch(/firstName|lastName|name/);
    });
    test('no person-name SQL in the dashboard service, controller or views', () => {
        const files = [
            'src/services/DashboardHomeService.js',
            'src/controllers/DashboardHomeController.js',
            ...fs
                .readdirSync(path.join(ROOT, 'views/pages/dashboard'))
                .map((f) => 'views/pages/dashboard/' + f),
            'views/pages/exec/board-pack.ejs',
        ];
        for (const f of files) {
            const s = read(f);
            expect([
                f,
                /first_name|last_name|full_name|firstName|lastName|fullName|employee_number/.test(
                    s
                ),
            ]).toEqual([f, false]);
        }
    });
    test('no persona switch left (vue / persona / homePersona)', () => {
        for (const f of [
            'src/services/DashboardHomeService.js',
            'views/pages/dashboard/index.ejs',
            'public/js/dashboard-tabs.js',
        ])
            expect([f, /homePersona|\?vue=|persona/i.test(read(f))]).toEqual([f, false]);
    });
});

describe('retired endpoints, scripts and locales', () => {
    test('the former JSON endpoints are declared retired (410), never handled', () => {
        const src = read('src/routes/dashboard.js');
        for (const p of [
            '/api/dashboard/employee-list',
            '/api/dashboard/overview-kpis',
            '/api/benchmark/fit',
            '/api/dashboard/compliance-summary',
        ])
            expect(src).toContain(`'${p}'`);
        expect(src).toMatch(/res\.status\(410\)/);
        expect(fs.existsSync(path.join(ROOT, 'public/js/dashboard.js'))).toBe(false);
        expect(fs.existsSync(path.join(ROOT, 'views/pages/dashboard.ejs'))).toBe(false);
    });
    test('Chart.js only on a tab whose first screen draws a canvas (or « Print everything »)', () => {
        const C = require('../../src/controllers/DashboardHomeController');
        expect(C.needsChart('overview', false)).toBe(true);
        expect(C.needsChart('readiness', false)).toBe(true);
        expect(C.needsChart('talent', false)).toBe(false);
        expect(C.needsChart('safety', true)).toBe(true);
        const idx = read('views/pages/dashboard/index.ejs');
        expect(idx).toMatch(
            /viz: \{ chart: needsChart, heat: true, radar: needsChart, axisFit: needsChart \}/
        );
        // a tab fetched later loads the chart scripts it needs from fixed same-origin paths
        const js = read('public/js/dashboard-tabs.js');
        expect(js).toMatch(/'\/vendor\/chart\.umd\.min\.js'/);
        expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
        expect(js).toMatch(/new DOMParser\(\)\.parseFromString/);
    });
    test('FR / EN parity of the dash and viz catalogues', () => {
        const flat = (o, p = '') =>
            Object.entries(o).flatMap(([k, v]) =>
                v && typeof v === 'object' ? flat(v, p + k + '.') : [p + k]
            );
        for (const ns of ['dash', 'viz', 'chrome', 'admin', 'compliance']) {
            const fr = flat(JSON.parse(read(`locales/fr/${ns}.json`))).sort();
            const en = flat(JSON.parse(read(`locales/en/${ns}.json`))).sort();
            expect([ns, fr]).toEqual([ns, en]);
        }
        const fr = JSON.parse(read('locales/fr/dash.json'));
        const en = JSON.parse(read('locales/en/dash.json'));
        for (const k of Object.keys(fr).filter((x) => x.startsWith('d3_') && x.length > 12))
            if (
                !/^d3_(area_validations|scope_site|unit_site|col_site)/.test(k) &&
                fr[k].length > 12
            )
                expect([k, fr[k] === en[k]]).toEqual([k, false]);
    });
    test('every dash key the new views use exists in both languages', () => {
        const fr = JSON.parse(read('locales/fr/dash.json'));
        const en = JSON.parse(read('locales/en/dash.json'));
        const dir = path.join(ROOT, 'views/pages/dashboard');
        const files = [
            ...fs.readdirSync(dir).map((f) => path.join(dir, f)),
            path.join(ROOT, 'views/pages/exec/board-pack.ejs'),
            path.join(ROOT, 'views/partials/scope-bar.ejs'),
        ];
        const missing = [];
        for (const f of files) {
            const s = fs.readFileSync(f, 'utf8');
            for (const m of s.matchAll(/__\('dash:([a-z0-9_]+)'/g)) {
                const k = m[1];
                if (k.endsWith('_')) continue; // a generated key: checked below
                const has = (d) => d[k] !== undefined || d[k + '_one'] !== undefined;
                if (!has(fr) || !has(en)) missing.push(k);
            }
        }
        // the generated ones, from the registries that generate them
        const gen = [
            ...T.TABS.map((t) => 'd3_tab_' + t.id),
            ...T.AREAS.map((a) => 'd3_area_' + a.key),
            ...['requirements', 'certificates', 'safety_gate', 'campaign', 'critical_roles'].map(
                (k) => 'd3_setup_' + k
            ),
            ...Object.entries(T.DRILLS)
                .filter(([k]) => k !== 'DOM')
                .flatMap(([k, d]) => d.parts.map((p) => `d3_part_${k}_${p}`)),
            ...D.HEALTH_AXES.map((a) => 'd3_ov_axis_' + a.key),
            ...['outside', 'unmeasured', 'not_configured', 'small_n'].map((k) => 'd3_ov_axis_' + k),
            ...['idp', 'pip', 'coaching'].map((k) => 'd3_dv_type_' + k),
            ...['people', 'roles', 'cells'].map((k) => 'd3_list_count_' + k),
            ...['validate', 'assess', 'develop'].map((k) => 'd3_tm_next_' + k),
        ];
        for (const k of gen) {
            const has = (d) => d[k] !== undefined || d[k + '_one'] !== undefined;
            if (!has(fr) || !has(en)) missing.push(k);
        }
        expect(missing).toEqual([]);
    });
});
