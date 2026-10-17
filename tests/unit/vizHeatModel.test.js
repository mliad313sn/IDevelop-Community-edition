'use strict';
/**
 * The heatmap: one scale (src/utils/heatBins.js), one model
 * (src/utils/heatModel.js), one component (views/partials/viz/heat.ejs).
 *   1  bins: exact edges for attain / deficit / coverage / level
 *   2  "Not measured" is never coloured; a MEASURED 0 is a result
 *   3  fewer than 5 people: masked (no value, colour or link) + complementary
 *      suppression
 *   4  small units pooled into one « Others » column
 *   5  marginals are population aggregates, never a mean of cells
 *   6  worst first (rows and columns), ties by n
 *   7  coverage: at level ÷ ASSESSED (an unassessed person is never a gap)
 *   8  the render contract (one tab stop, value + n + tooltip text, a real
 *      data table, the phone list, a legend of the bins present), FR / EN copy
 *   9  the benchmark matrices on the component's scale (no red-to-green ramp),
 *      an unassessed person × skill cell is never level 0
 */
const HB = require('../../src/utils/heatBins');
const HM = require('../../src/utils/heatModel');
const { render, read, ns } = require('../helpers/vizRender');

const cell = (u, k, sa, sr, m, n, label) => ({
    part: 'cell',
    unitKey: u,
    unitName: 'U' + u,
    key: k,
    label: label || 'P' + k,
    sumActual: sa,
    sumRequired: sr,
    measured: m,
    n,
});
const unitT = (u, sa, sr, m, n) => ({
    part: 'unit',
    unitKey: u,
    sumActual: sa,
    sumRequired: sr,
    measured: m,
    n,
});
const axisT = (k, sa, sr, m, n) => ({
    part: 'axis',
    key: k,
    sumActual: sa,
    sumRequired: sr,
    measured: m,
    n,
});
const totalT = (sa, sr, m, n) => ({
    part: 'total',
    sumActual: sa,
    sumRequired: sr,
    measured: m,
    n,
});

/** 3 units × 2 axes, every cell n >= 5 unless overridden. */
function cube(overrides = {}) {
    const rows = [
        cell('1', '10', 70, 100, 50, 10),
        cell('2', '10', 95, 100, 50, 8),
        cell('3', '10', 110, 100, 50, 6),
        cell('1', '20', 50, 100, 50, 10),
        cell('2', '20', 90, 100, 50, 8),
        cell('3', '20', 100, 100, 50, 6),
        unitT('1', 120, 200, 100, 10),
        unitT('2', 185, 200, 100, 8),
        unitT('3', 210, 200, 100, 6),
        axisT('10', 275, 300, 150, 24),
        axisT('20', 240, 300, 150, 24),
        totalT(515, 600, 300, 24),
    ];
    return rows.map((r) => {
        const o = overrides[r.part + ':' + (r.unitKey || '') + ':' + (r.key || '')];
        return o ? { ...r, ...o } : r;
    });
}

describe('1 — bins: exact edges (inclusive low, exclusive high)', () => {
    test.each([
        [0.5999, 'below-3'],
        [0.6, 'below-2'],
        [0.8, 'below-1'],
        // at or above the requirement is ONE state (src/utils/capability.js):
        // a gap remains below 100 %, and there is no « above » step any more
        [0.9999, 'below-1'],
        [1, 'at'],
        [1.3, 'at'],
    ])('attain %p → %p', (v, b) => expect(HB.binOf('attain', v)).toBe(b));
    test.each([
        [0.0999, 'at'],
        [0.1, 'below-1'],
        [0.5, 'below-2'],
        [1.0, 'below-3'],
    ])('deficit %p → %p', (v, b) => expect(HB.binOf('deficit', v)).toBe(b));
    test.each([
        [0.4999, 'below-3'],
        [0.5, 'below-2'],
        [0.8, 'below-1'],
        [1.0, 'at'],
    ])('coverage %p → %p', (v, b) => expect(HB.binOf('coverage', v)).toBe(b));
    test('levels 0-4 are the sequential scale, clamped', () => {
        expect([0, 1.4, 2.5, 4, 9].map((v) => HB.binOf('level', v))).toEqual([
            'seq-0',
            'seq-1',
            'seq-3',
            'seq-4',
            'seq-4',
        ]);
    });
    test('nothing measured has NO bin; an unknown kind throws', () => {
        for (const k of ['attain', 'deficit', 'coverage', 'level'])
            for (const v of [null, undefined, '', true]) expect(HB.binOf(k, v)).toBeNull();
        expect(() => HB.binOf('other', 1)).toThrow();
    });
    test('▼: below 80 % of the requirement; deficit half a level or more', () => {
        expect(HB.belowMark('attain', 0.7999)).toBe(true);
        expect(HB.belowMark('attain', 0.8)).toBe(false);
        expect(HB.belowMark('deficit', 0.5)).toBe(true);
        expect(HB.belowMark('coverage', null)).toBe(false);
    });
    test('one person against a requirement: unassessed has no bin (never level 0)', () => {
        expect(HB.personGapBin(0, 3, false)).toBeNull();
        expect(HB.personGapBin(null, 3, true)).toBeNull();
        expect(HB.personGapBin(0, 3, true)).toBe('below-3');
        expect(HB.personGapBin(3, 3, true)).toBe('at');
        expect(HB.personGapBin(4, 3, true)).toBe('at');
    });
});

describe('2 — not measured is never a result; a measured 0 is', () => {
    test('model and render', () => {
        const m = HM.heatModel(
            cube({
                'cell:1:10': { sumActual: null, sumRequired: null, measured: 0, n: 0 },
                'cell:2:20': { sumActual: 0, sumRequired: 100, measured: 50, n: 8 },
            }),
            { kind: 'attain' }
        );
        const c = m.rows.find((x) => x.key === '10').cells[m.cols.findIndex((x) => x.key === '1')];
        expect(c.state).toBe('unmeasured');
        expect(c.bin).toBeUndefined();
        expect(c.value).toBeUndefined();
        const h = render('views/partials/viz/heat.ejs', { H: m, heatId: 't2' });
        const um = h.match(/<td[^>]*vh-c--unmeasured[^>]*>[\s\S]*?<\/td>/)[0];
        expect(um).not.toMatch(/data-bin=/);
        expect(um).toMatch(/viz-hatch/);
        expect(um).toMatch(/Pas encore mesuré/);
        expect(h).toMatch(/data-bin="below-3"[^>]*>[\s\S]{0,300}?0 %/);
    });
});

describe('3 — fewer than 5 people: masked, complementary suppression', () => {
    test('a single masked cell in a row masks a second — and in its column too', () => {
        const m = HM.heatModel(cube({ 'cell:1:10': { n: 4 } }), {
            kind: 'attain',
            hrefOf: () => '/reports/gaps',
        });
        for (const r of m.rows) {
            const masked = r.cells.filter((c) => c.state === 'masked');
            expect(masked.length === 0 || masked.length >= 2).toBe(true);
            for (const c of masked) {
                expect(c.value).toBeUndefined();
                expect(c.bin).toBeUndefined();
                expect(c.href).toBeUndefined();
                expect(c.n).toBeNull();
            }
        }
        for (let j = 0; j < m.cols.length; j++) {
            const k = m.rows.filter((r) => r.cells[j].state === 'masked').length;
            expect(k === 0 || k >= 2).toBe(true);
        }
        const h = render('views/partials/viz/heat.ejs', { H: m, heatId: 't3' });
        const cells = h.match(/<td[^>]*vh-c--masked[^>]*>[\s\S]*?<\/td>/g) || [];
        expect(cells.length).toBeGreaterThanOrEqual(2);
        for (const c of cells) {
            expect(c).not.toMatch(/data-bin=|vh-drill/);
            expect(c).toMatch(/&lt; 5/);
        }
    });
});

describe('4 — small units pooled into ONE « Others » column', () => {
    const rows = () =>
        cube().concat([
            cell('4', '10', 6, 10, 5, 2),
            cell('4', '20', 7, 10, 5, 2),
            unitT('4', 13, 20, 10, 2),
            cell('5', '10', 9, 10, 5, 2),
            cell('5', '20', 8, 10, 5, 2),
            unitT('5', 17, 20, 10, 2),
        ]);
    test('two units of 2 people ⇒ one pooled column of 4, masked, last', () => {
        const m = HM.heatModel(rows(), { kind: 'attain', unitLabel: (u) => 'Site ' + u });
        const pooled = m.cols.filter((c) => c.pooled);
        expect(pooled).toHaveLength(1);
        expect(pooled[0].pooled.sort()).toEqual(['Site 4', 'Site 5']);
        expect(pooled[0].n).toBe(4);
        expect(m.cols[m.cols.length - 1].pooled).toBeTruthy();
        const j = m.cols.indexOf(pooled[0]);
        expect(m.rows.every((r) => r.cells[j].state === 'masked')).toBe(true);
    });
    test('three units of 2 people ⇒ pooled n = 6: a real value on the pooled people, no link', () => {
        const m = HM.heatModel(
            rows().concat([
                cell('6', '10', 5, 10, 5, 2),
                cell('6', '20', 5, 10, 5, 2),
                unitT('6', 10, 20, 10, 2),
            ]),
            { kind: 'attain', hrefOf: () => '/reports/gaps' }
        );
        const j = m.cols.findIndex((c) => c.pooled);
        const c = m.rows.find((r) => r.key === '10').cells[j];
        expect(c.state).toBe('ok');
        expect(c.value).toBeCloseTo(20 / 30, 6);
        expect(c.href).toBeUndefined();
    });
});

describe('5 — marginals are population aggregates', () => {
    test('row and column marginals come from the cube totals', () => {
        const m = HM.heatModel(
            cube({
                'cell:1:10': { sumActual: 140, sumRequired: 200, measured: 100 },
                'axis::10': { sumActual: 345, sumRequired: 400, measured: 200 },
            }),
            { kind: 'attain' }
        );
        const r10 = m.rows.find((r) => r.key === '10');
        expect(r10.marg.value).toBeCloseTo(345 / 400, 9);
        expect(Math.abs(r10.marg.value - (0.7 + 0.95 + 1.1) / 3)).toBeGreaterThan(1e-6);
        expect(m.cols.find((c) => c.key === '1').marg.value).toBeCloseTo(120 / 200, 9);
        expect(m.total.value).toBeCloseTo(515 / 600, 9);
    });
    test('deficit = mean required − mean demonstrated, on the printed levels', () => {
        const m = HM.heatModel(cube(), { kind: 'deficit' });
        const r20 = m.rows.find((r) => r.key === '20');
        expect(r20.marg.value).toBeCloseTo(0.4, 9);
        expect(r20.marg.bin).toBe(HB.binOf('deficit', 0.4));
    });
});

describe('6 — worst first, ties by n', () => {
    test('attain: lowest row and column marginals first; maxRows counts the rest', () => {
        const m = HM.heatModel(cube(), { kind: 'attain' });
        expect(m.rows.map((r) => r.key)).toEqual(['20', '10']);
        expect(m.cols.map((c) => c.key)).toEqual(['1', '2', '3']);
        expect(m.rows[0].cells[0].value).toBeCloseTo(0.5, 9);
        const d = HM.heatModel(cube(), { kind: 'deficit', maxRows: 1 });
        expect(d.rows.map((r) => r.key)).toEqual(['20']);
        expect(d.restRows).toBe(1);
    });
    test('ties broken by the larger n', () => {
        const m = HM.heatModel(
            [
                cell('1', 'a', 8, 10, 5, 5, 'A'),
                cell('1', 'b', 8, 10, 5, 9, 'B'),
                unitT('1', 16, 20, 10, 9),
                axisT('a', 8, 10, 5, 5),
                axisT('b', 8, 10, 5, 9),
                totalT(16, 20, 10, 9),
            ],
            { kind: 'attain' }
        );
        expect(m.rows.map((r) => r.label)).toEqual(['B', 'A']);
    });
    test('an empty cube is an empty model, never a grid of zeros', () => {
        expect(HM.heatModel([], { kind: 'attain' })).toMatchObject({
            rows: [],
            cols: [],
            empty: true,
        });
    });
});

describe('7 — coverage: at level ÷ ASSESSED, counts at any n', () => {
    const cov = {
        emptyScope: false,
        sites: [
            { siteKey: '1', siteId: 1, siteName: 'Northgate' },
            { siteKey: '2', siteId: 2, siteName: 'Stonebridge' },
            { siteKey: 'none', siteId: null, siteName: null, noSite: true },
        ],
        rows: [
            {
                skillId: 7,
                skillName: 'Lockout procedure',
                cells: [
                    { required: 5, measured: 4, available: 2 },
                    { required: 3, measured: 0, available: 0 },
                    null,
                ],
            },
            {
                skillId: 8,
                skillName: 'Lifting',
                cells: [{ required: 2, measured: 0, available: 0 }, null, null],
            },
        ],
    };
    test('an unassessed holder is never a gap; a never-assessed row is counted, not drawn', () => {
        const m = HM.coverageHeatModel(cov, {
            hrefOf: (s, r) => '/reports/gaps?skill=' + r.skillId,
        });
        expect(m.rows).toHaveLength(1);
        expect(m.unmeasuredRows).toBe(1);
        const r = m.rows[0];
        const a = r.cells[m.cols.findIndex((c) => c.key === '1')];
        expect(a.value).toBeCloseTo(0.5, 9); // 2 of 4 assessed, not 2 of 5
        expect(a.bin).toBe('below-2');
        expect(a.href).toBe('/reports/gaps?skill=7');
        expect(r.cells[m.cols.findIndex((c) => c.key === '2')].state).toBe('unmeasured');
        expect(r.cells[m.cols.findIndex((c) => c.key === 'none')].state).toBe('na');
        const h = render('views/partials/viz/heat.ejs', { H: m, heatId: 'cov' });
        expect(h).toMatch(/2 sur 5/);
        expect(h).toMatch(/1 non évaluée/);
        expect(h).toMatch(/Sans site/);
        const en = render('views/partials/viz/heat.ejs', { H: m, heatId: 'cov' }, 'en');
        expect(en).toMatch(/2 of 5/);
        expect(en).toMatch(/1 not assessed/);
        expect(en).toMatch(/No site/);
    });
    test('an empty scope stays an empty scope', () => {
        expect(HM.coverageHeatModel({ emptyScope: true })).toEqual({ emptyScope: true });
        expect(HM.coverageHeatModel(null)).toBeNull();
    });
});

describe('8 — the render contract', () => {
    const m = HM.heatModel(cube(), {
        kind: 'attain',
        unitLabel: (u) => 'Site ' + u,
        hrefOf: (u, k) => '/reports/gaps?site=' + u + '&part=' + k,
    });
    const h = render('views/partials/viz/heat.ejs', { H: m, heatId: 'rc', heatTitle: 'Titre' });
    test('one tab stop per grid: the first measured cell', () => {
        const grid = h.slice(h.indexOf('<table class="vh-grid"'), h.indexOf('</table>'));
        expect((grid.match(/tabindex="0"/g) || []).length).toBe(1);
        expect(grid).toMatch(/role="grid"/);
        expect((grid.match(/role="gridcell"/g) || []).length).toBe(2 * 3 + 2 + 3 + 1);
    });
    test('a cell carries its value, n, tooltip text and its link; colour is never alone', () => {
        expect(h).toMatch(/data-tip="[^"]*Démontré 1,0 · requis 2,0 \(50 %\)/);
        expect(h).toMatch(/data-tip="[^"]*Entrée : ouvrir le détail/);
        expect(h).toMatch(
            /<a class="vh-drill" href="\/reports\/gaps\?site=1&amp;part=20" tabindex="-1"/
        );
        expect(h).toMatch(/<span class="vh-mk">▼<\/span>/);
        expect(h).toMatch(/class="vh-n" aria-hidden="true">10 pers\./);
        // each cell is read aloud as text
        expect(h).toMatch(/<span class="viz-live">P20, Site 1 : 50 % ▼\./);
    });
    test('marginals, a real data table, the phone list, the takeaway', () => {
        expect(h).toMatch(/vh-colh vh-marg[\s\S]*?Ensemble/);
        expect(h).toMatch(
            /<tr class="vh-margrow"><th scope="row" class="vh-rowh">Tous les domaines/
        );
        expect(h).toMatch(/<table class="viz-table" id="rc-data">/);
        expect(h).toMatch(/<ol class="vh-list"/);
        expect(h).toMatch(/P20 : 1 unités sur 3 sous 80 % du requis\./);
    });
    test('the legend lists only the bins present', () => {
        const legend = h.slice(
            h.indexOf('class="vh-legend"'),
            h.indexOf('</p>', h.indexOf('class="vh-legend"'))
        );
        const bins = [...legend.matchAll(/data-bin="([^"]+)"/g)].map((x) => x[1]);
        expect(bins.sort()).toEqual([...m.binsPresent].sort());
        expect(legend).not.toMatch(/Plus de 120 %/);
    });
    test('English copy in English; the page title never leaks into the component', () => {
        const e = render(
            'views/partials/viz/heat.ejs',
            { H: m, heatId: 'rc', title: 'Page title' },
            'en'
        );
        expect(e).toMatch(/Overall/);
        expect(e).toMatch(/All domains/);
        expect(e).not.toMatch(/Ensemble|Tous les domaines|Page title/);
    });
    test('a hostile label is text: escaped in the cell, the tooltip and the list', () => {
        const hm = HM.heatModel(
            cube().map((r) =>
                r.part === 'cell' && r.key === '10'
                    ? { ...r, label: '<img src=x onerror=alert(1)>' }
                    : r
            ),
            { kind: 'attain', unitLabel: () => '"><b>x</b>' }
        );
        const out = render('views/partials/viz/heat.ejs', { H: hm, heatId: 'x' }, 'en');
        expect(out).not.toMatch(/<img src=x|<b>x<\/b>/);
        expect(out).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
    });
    test('deficit cells use the decimal comma in French', () => {
        const d = render('views/partials/viz/heat.ejs', {
            H: HM.heatModel(cube(), { kind: 'deficit' }),
            heatId: 'dc',
        });
        expect(d).toMatch(/manque 0,6/);
        expect(d).not.toMatch(/manque 0\.6/);
    });
});

describe('copy: FR / EN parity of the viz namespace', () => {
    const flat = (o, p = '') =>
        Object.entries(o).flatMap(([k, v]) =>
            v && typeof v === 'object' ? flat(v, p + k + '.') : [p + k]
        );
    test('the same keys in both languages, every bin label present', () => {
        expect(flat(ns('fr', 'viz')).sort()).toEqual(flat(ns('en', 'viz')).sort());
        for (const kind of ['attain', 'deficit', 'coverage'])
            for (const b of HB.BINS[kind])
                expect(
                    ns('fr', 'viz').heat['bin_' + kind + '_' + b.replace('-', '_')]
                ).toBeTruthy();
    });
    test('the namespace is loaded by the app', () => {
        expect(read('src/config/i18n.js')).toMatch(/'viz',/);
    });
});

describe('9 — the benchmark matrices on the component scale', () => {
    test.each(['views/pages/benchmark/index.ejs', 'views/pages/benchmark/role.ejs'])(
        '%s',
        (rel) => {
            const src = read(rel);
            expect(src).not.toMatch(
                /rgba\(244,\s*67,\s*54|rgba\(76,\s*175,\s*80|rgba\(139,\s*195,\s*74|bm-heat-/
            );
            expect(src).toMatch(/data-bin="/);
        }
    );
    test('the role page: an unassessed cell is « Not assessed », never coloured as a level', () => {
        const src = read('views/pages/benchmark/role.ejs');
        expect(src).toMatch(
            /<% if \(c && c\.assessed\) \{ var _bin = personGapBin\(c\.actual, sk\.required, true\);/
        );
        expect(src).toMatch(/vh-c--unmeasured viz-hatch bm-unassessed/);
        expect(src).toMatch(/__\('dash:bm_not_assessed'\)/);
    });
    test('the model: an unassessed occupant cell has no level and is neither met nor a gap', () => {
        const model = read('src/models/BenchmarkModel.js');
        expect(model).toMatch(/: \{ actual: null, met: null, assessed: false \};/);
    });
});
