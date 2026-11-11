'use strict';
/**
 * KPI definitions, contract kpi-2 (pure parts, no database):
 *   1  the contract version is kpi-2, and the glossary says what changed
 *   2  Kaplan–Meier: people not ready yet are censored, never dropped
 *   3  the reconstructed trend ends ON the live tile values
 *   4  the capability map's « Whole framework » row and total carry K2, the
 *      columns re-ordered worst first on K2, the same permutation on every row
 *   5  measurability: K1's own denominator, « not yet assessed » apart, no %
 *      under 5 people, rendered without any name
 *   6  K1 by site « with a comparable role mix » rows
 */
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));
const K = require('../../src/services/KpiService');
const D = require('../../src/services/DashboardHomeService');
const HM = require('../../src/utils/heatModel');
const { render, ns } = require('../helpers/vizRender');

describe('1 — the contract', () => {
    test('the definitions are version kpi-2', () => {
        expect(K.CONTRACT_VERSION).toBe('kpi-2');
    });
    test('the glossary explains the change and the restart, FR and EN', () => {
        for (const lang of ['fr', 'en']) {
            const k = ns(lang, 'kpi');
            expect(k.glossary_contract_changed).toMatch(/kpi-2/);
            expect(k.common_capability).toMatch(/100 %/);
            expect(k.common_fresh_assessed).toMatch(/K3/);
            expect(k.k14_formula).toMatch(/Kaplan/);
        }
    });
});

describe('2 — Kaplan–Meier quantile', () => {
    test('without censoring it is the ordinary lower median', () => {
        expect(K.kmQuantile([10, 20, 30, 40, 50], [])).toBe(30);
        expect(K.kmQuantile([10, 20, 30, 40], [])).toBe(20);
    });
    test('people still on the way push the median UP (dropping them biases it down)', () => {
        // naive median of the four who made it: 25 days
        const km = K.kmQuantile([10, 20, 30, 40], [35, 60, 90]);
        expect(km).toBeGreaterThan(25);
        expect(km).toBe(40);
    });
    test('fewer than half reached: the median is not reached (null), never a number', () => {
        expect(K.kmQuantile([10, 20], [200, 200, 200])).toBeNull();
        expect(K.kmQuantile([], [])).toBeNull();
    });
    test('an event before a censoring at the same time (standard convention)', () => {
        expect(K.kmQuantile([10], [10])).toBe(10);
    });
});

describe('3 — the reconstructed trend ends on the live tiles', () => {
    const now = Date.UTC(2026, 9, 15, 12);
    const reqs = Array.from({ length: 6 }, (_, i) => ({ e: i + 1, s: 1, r: 2, c: false }));
    const events = reqs.map((q) => ({ e: q.e, s: 1, l: 2, t: Date.UTC(2026, 3, 1) }));
    test('the last month IS the live K1 / K3 of the tiles', () => {
        const est = D.backcastSeries({ reqs, events }, { now, months: 3 });
        expect(est[est.length - 1].K1).toBe(100);
        const live = D.backcastSeries(
            { reqs, events },
            { now, months: 3, live: { K1: { value: 71.4 }, K3: { value: 64.2 } } }
        );
        const last = live[live.length - 1];
        expect(last).toMatchObject({ K1: 71.4, K3: 64.2, live: true });
        // the earlier months are untouched
        expect(live[0]).toEqual(est[0]);
    });
    test('a live tile without a value (small n, empty scope) is a gap, never 0', () => {
        const live = D.backcastSeries(
            { reqs, events },
            { now, months: 2, live: { K1: { value: null }, K3: { emptyScope: true, value: 3 } } }
        );
        expect(live[1].K1).toBeNull();
        expect(live[1].K3).toBeNull();
    });
});

/** A capability-map cube: sites 1, 2, 3 (10, 8, 6 people) x pillar 1 (sub 11). */
const c = (part, u, p, s, sa, sr, m, n) => ({
    part,
    unitKey: u,
    unitName: u ? 'Site ' + u : null,
    pillarKey: p,
    subKey: s,
    sumActual: sa,
    sumRequired: sr,
    measured: m,
    n,
});
const cube = () => [
    c('us', '1', '1', '11', 60, 100, 50, 10),
    c('us', '2', '1', '11', 90, 100, 50, 8),
    c('us', '3', '1', '11', 80, 100, 50, 6),
    c('up', '1', '1', null, 60, 100, 50, 10),
    c('up', '2', '1', null, 90, 100, 50, 8),
    c('up', '3', '1', null, 80, 100, 50, 6),
    c('u', '1', null, null, 60, 100, 50, 10),
    c('u', '2', null, null, 90, 100, 50, 8),
    c('u', '3', null, null, 80, 100, 50, 6),
    c('s', null, '1', '11', 230, 300, 150, 24),
    c('p', null, '1', null, 230, 300, 150, 24),
    c('total', null, null, null, 230, 300, 150, 24),
];
const tree = [{ key: '1', label: 'Pillar 1', subs: [{ key: '11', label: 'Sub 11' }] }];

describe('4 — the map « Whole framework » carries K2', () => {
    test('row and total print K2; the columns follow K2 worst first, on every row', () => {
        const map = HM.capabilityMapModel(cube(), tree, { unit: 'site' });
        // Σ estimator: site 1 (60 %) is the weakest
        expect(map.cols[0].key).toBe('1');
        const k2 = {
            org: { value: 78, n: 24, status: 'watch' },
            units: new Map([
                ['1', { value: 88, n: 10 }],
                ['2', { value: 70, n: 8 }],
                ['3', { value: 75, n: 6 }],
            ]),
        };
        HM.withK2Margins(map, k2);
        expect(map.estimator).toBe('K2');
        expect(map.cols.map((x) => x.key)).toEqual(['2', '3', '1']);
        expect(map.cols.map((x) => x.marg.value)).toEqual([0.7, 0.75, 0.88]);
        expect(map.cols.every((x) => x.marg.estimator === 'K2')).toBe(true);
        expect(map.total).toMatchObject({ value: 0.78, estimator: 'K2' });
        // the pillar cells keep Σ credited ÷ Σ required, in the new column order
        expect(map.rows[0].cells.map((x) => x.value)).toEqual([0.9, 0.8, 0.6]);
        expect(map.rows[0].children[0].cells.map((x) => x.value)).toEqual([0.9, 0.8, 0.6]);
        const html = render('views/partials/viz/capmap.ejs', { H: map, heatId: 'cm' }, 'en');
        expect(html).toMatch(/data-estimator="K2"/);
        expect(html).toMatch(/Average readiness \(K2\)/);
    });
    test('a unit whose K2 is under 5 people is masked, and a second cell with it', () => {
        const map = HM.capabilityMapModel(cube(), tree, { unit: 'site' });
        HM.withK2Margins(map, {
            org: { value: 78, n: 24 },
            units: new Map([
                ['1', { value: 88, n: 10 }],
                ['2', { value: null, n: 3 }],
                ['3', { value: 75, n: 6 }],
            ]),
        });
        const masked = map.cols.filter((x) => x.marg.state === 'masked');
        expect(masked.length).toBe(2);
        expect(map.hasMasked).toBe(true);
    });
    test('no K2 (read failed or empty) leaves the map as it was', () => {
        const map = HM.capabilityMapModel(cube(), tree, { unit: 'site' });
        const before = JSON.stringify(map);
        HM.withK2Margins(map, null);
        expect(JSON.stringify(map)).toBe(before);
    });
});

describe('5 — measurability', () => {
    const k1 = (over = {}) => ({
        denominator: 21,
        breakdown: {
            ready: 15,
            notReady: 6,
            partial: 3,
            notAssessed: 6,
            noRequirement: 2,
            population: 32,
        },
        ...over,
    });
    const profile = {
        axes: [
            { key: 'K1', state: 'measured' },
            { key: 'K5', state: 'unmeasured' },
            { key: 'FR', state: 'small_n' },
        ],
    };
    test("K1's own denominator, every other group apart, the missing axes named", () => {
        const m = D.measurability(k1(), profile);
        expect(m).toMatchObject({
            population: 32,
            scored: 21,
            pct: 65.6,
            complete: false,
            noRequirement: 2,
            partial: 3,
            notAssessed: 6,
            axesMissing: ['K5', 'FR'],
        });
        const html = render('views/pages/dashboard/_measurability.ejs', { MZ: m }, 'en');
        expect(html).toMatch(/score computed on 21 of 32 people \(66 ?%\)/);
        expect(html).toMatch(/6 not yet assessed/);
        expect(html).toMatch(/2 without requirements for their role/);
        expect(html).toMatch(/not measured yet: Succession, Assessments under 12 months/);
        expect(html).toMatch(/viz-chip--warn/);
        const fr = render('views/pages/dashboard/_measurability.ejs', { MZ: m }, 'fr');
        expect(fr).toMatch(/6 pas encore évaluées/);
        expect(fr).toMatch(/« Pas encore évaluée » n’est pas « non mesurable »/);
    });
    test('everybody scored: complete, no colour', () => {
        const m = D.measurability(
            k1({
                denominator: 10,
                breakdown: { ready: 8, notReady: 2, population: 10 },
            }),
            { axes: [] }
        );
        expect(m.complete).toBe(true);
        const html = render('views/pages/dashboard/_measurability.ejs', { MZ: m }, 'en');
        expect(html).not.toMatch(/viz-chip--warn/);
        expect(html).toMatch(/data-measurability="complete"/);
    });
    test('under 5 people: counts, no %', () => {
        const m = D.measurability(
            k1({
                denominator: 2,
                breakdown: { ready: 1, notReady: 1, notAssessed: 2, population: 4 },
            }),
            { axes: [] }
        );
        expect(m.pct).toBeNull();
        const html = render('views/pages/dashboard/_measurability.ejs', { MZ: m }, 'en');
        expect(html).toMatch(/score computed on 2 of 4 people\b/);
        expect(html).not.toMatch(/\d ?%/);
    });
    test('an empty scope says « not measured »; no K1 at all renders nothing', () => {
        const m = D.measurability({ emptyScope: true }, { axes: [] });
        expect(m.emptyScope).toBe(true);
        expect(render('views/pages/dashboard/_measurability.ejs', { MZ: m }, 'en')).toMatch(
            /viz-chip--unmeasured/
        );
        expect(D.measurability(null, null)).toBeNull();
        expect(render('views/pages/dashboard/_measurability.ejs', { MZ: null }, 'en').trim()).toBe(
            ''
        );
    });
});

describe('6 — K1 by site « with a comparable role mix »', () => {
    test('rows in the K1 order, « not computable » kept, sites without a figure left out', () => {
        const groups = [
            { key: '2', id: 2, label: 'Site 2', value: 40 },
            { key: '1', id: 1, label: 'Site 1', value: 70 },
            { key: 'none', id: null, label: null, none: true, value: null },
            { key: '3', id: 3, label: 'Site 3', value: 90 },
        ];
        const exp = new Map([
            ['1', { expected: 65, observed: 70, n: 12, state: 'ok' }],
            ['2', { expected: null, observed: 40, n: 6, state: 'na' }],
            ['none', { expected: null, observed: null, n: 2, state: 'na' }],
        ]);
        const rows = D.expectedRows(groups, exp);
        expect(rows.map((r) => r.key)).toEqual(['2', '1', 'none']);
        expect(rows[1]).toMatchObject({ observed: 70, expected: 65, state: 'ok' });
        expect(D.expectedRows(groups, null)).toEqual([]);
    });
});
