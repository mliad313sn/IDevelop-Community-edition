'use strict';
/**
 * public/js/viz.js, the shared chart wrapper (pure parts, run in node):
 *   - null stays null (a gap, a hatched "Not measured"), never 0;
 *   - a percentage over fewer than 5 people is not drawn as a percentage;
 *   - one measure colour for every status, the risk red only for "At risk";
 *     the stacked composition in the FIXED status order;
 *   - the generated summary, the data table, the sorted list of a phone
 *     (worst first, small n next, unmeasured last); tooltips in the page language;
 *   - a time series: x from the first month with data, end-of-line labels, an
 *     estimate labelled only when its measure is absent;
 *   - the radar: wrapped axis names, the shared legend, the target ring, the
 *     requirement named on the chart;
 *   - print: one picture per live chart before printing, removed after;
 *   - no canvas text under 12 px.
 */
const Viz = require('../../public/js/viz.js');
const CT = require('../../public/js/chart-theme.js');
const { read } = require('../helpers/vizRender');

const sites = {
    kind: 'hbar',
    unit: 'pct',
    labels: ['Site A', 'Site B', 'Site C', 'Site D'],
    series: [
        { key: 'k1', label: 'Prêts pour le poste', data: [91.2, 41, null, 60], n: [41, 12, 30, 3] },
    ],
    threshold: { value: 80 },
};

describe('buildChartConfig', () => {
    test('null stays null — never coerced to 0; n < 5 is not drawn as a %', () => {
        const c = Viz.buildChartConfig(sites);
        expect(c.type).toBe('bar');
        expect(c.options.indexAxis).toBe('y');
        expect(c.data.datasets[0].data).toEqual([91.2, 41, null, null]);
    });
    test('single-series bars: one measure colour for every status, red only for « At risk »', () => {
        const ds = Viz.buildChartConfig(sites).data.datasets[0];
        expect(ds.vizStatus).toEqual(['good', 'risk', 'unmeasured', null]);
        expect(ds.backgroundColor({ dataIndex: 1, chart: {} })).toBe(CT.viz.risk);
        const good = ds.backgroundColor({ dataIndex: 0, chart: {} });
        expect([CT.viz.measure, CT.viz.measureHi]).toContain(good);
        expect(good).not.toBe(CT.viz.good);
    });
    test('line: gaps for null, an area on the first measure, an estimate never filled', () => {
        const cfg = {
            kind: 'line',
            labels: ['Aug', 'Sep', 'Oct'],
            series: [
                { key: 'k1', label: 'Ready', data: [60, null, 63.2] },
                { key: 'k9', label: 'Fit', data: [90, 91, null] },
            ],
        };
        const c = Viz.buildChartConfig(cfg);
        c.data.datasets.forEach((ds) => expect(ds.spanGaps).toBe(false));
        expect(c.data.datasets[0].fill).toBe('origin');
        expect(c.data.datasets[0].borderColor).toBe(CT.viz.measure);
        expect(c.data.datasets[1].fill).toBe(false);
        const est = Viz.buildChartConfig({
            ...cfg,
            series: [{ key: 'k1_est', data: [50, 55, 60], dashed: true }, cfg.series[0]],
        });
        expect(est.data.datasets[0].fill).toBe(false);
        expect(est.data.datasets[0].borderDash).toEqual([6, 4]);
        expect(est.data.datasets[0].borderColor).toBe(est.data.datasets[1].borderColor);
    });
    test('stacked100: the fixed status order whatever the input order, an empty row is null', () => {
        const c = Viz.buildChartConfig({
            kind: 'stacked100',
            labels: ['Site A', 'Site B'],
            series: [
                { key: 'unassessed', data: [10, 0] },
                { key: 'ready', data: [20, 0] },
                { key: 'not_ready', data: [5, 0] },
                { key: 'partial', data: [5, 0] },
            ],
        });
        expect(c.data.datasets.map((d) => d.vizKey)).toEqual([
            'ready',
            'partial',
            'not_ready',
            'unassessed',
        ]);
        expect(c.data.datasets.map((d) => d.label)).toEqual([
            'Prêt',
            'Partiellement évalué',
            'Non prêt',
            'Non évalué',
        ]);
        expect(c.data.datasets[0].data).toEqual([50, null]);
        expect(c.data.datasets[0].backgroundColor).toBe(CT.viz.good);
        expect(c.options.scales.x.stacked).toBe(true);
    });
    test('tooltips and ticks in the page language (French here, English on request)', () => {
        const c = Viz.buildChartConfig(sites);
        const label = c.options.plugins.tooltip.callbacks.label;
        expect(label({ dataset: c.data.datasets[0], dataIndex: 0 })).toBe(
            'Prêts pour le poste : 91,2 % (n = 41)'
        );
        expect(label({ dataset: c.data.datasets[0], dataIndex: 2 })).toBe(
            'Prêts pour le poste : Pas encore mesuré (n = 30)'
        );
        expect(c.options.scales.x.ticks.callback(80)).toBe('80 %');
        const en = Viz.buildChartConfig(sites, Viz.i18n({ lang: 'en' }), 'en');
        expect(
            en.options.plugins.tooltip.callbacks.label({
                dataset: en.data.datasets[0],
                dataIndex: 2,
            })
        ).toBe('Prêts pour le poste : Not measured yet (n = 30)');
    });
    test('the plugins are per chart, never global; canvas text is never under 12 px', () => {
        const c = Viz.buildChartConfig(sites);
        expect(c.plugins.map((p) => p.id)).toEqual([
            'vizThreshold',
            'vizLabels',
            'vizAnnotate',
            'vizEndLabels',
        ]);
        const src = read('public/js/viz.js');
        expect(src).toMatch(/var MIN_FONT = 12;/);
        expect(src).not.toMatch(/fontPx\((?:[0-9]|1[01])\)/);
    });
});

describe('the phone list, the summary, the table', () => {
    test('worst first, then small n, then unmeasured; status from the bands', () => {
        const items = Viz.buildListItems(sites);
        expect(items.map((i) => i.label)).toEqual(['Site B', 'Site A', 'Site D', 'Site C']);
        expect(items[0]).toMatchObject({ value: 41, display: '41,0 %', n: 12, status: 'risk' });
        expect(items[2]).toMatchObject({ value: null, small: true, display: '—', status: null });
        expect(items[3]).toMatchObject({ value: null, display: null, status: 'unmeasured' });
    });
    test('a time series stays chronological, without status chips; lower-better sorts highest first', () => {
        const t = Viz.buildListItems({
            kind: 'line',
            labels: ['Jul', 'Aug', 'Sep'],
            series: [{ key: 'k1', data: [70, null, 40] }],
        });
        expect(t.map((i) => i.label)).toEqual(['Jul', 'Aug', 'Sep']);
        expect(t.map((i) => i.status)).toEqual([null, null, null]);
        const lb = Viz.buildListItems({
            ...sites,
            polarity: 'lower_better',
            unit: 'count',
            series: [{ key: 'x', data: [1, 9, 5, 3] }],
        });
        expect(lb.map((i) => i.value)).toEqual([9, 5, 3, 1]);
    });
    test('the summary: title, count, lowest, highest with n, unmeasured; English on request', () => {
        expect(Viz.buildSummary(sites, { title: 'Prêts par site' })).toBe(
            'Prêts par site : 4 éléments ; le plus bas : Site B, 41,0 % (n = 12) ; le plus haut : Site A, 91,2 % (n = 41) ; pas encore mesurés : 1'
        );
        expect(
            Viz.buildSummary(sites, { lang: 'en' }).startsWith('4 items ; lowest: Site B, 41.0%')
        ).toBe(true);
        expect(Viz.buildSummary(sites, { summary: 'Given' })).toBe('Given');
    });
    test('the table: null ⇒ a null cell ("Not measured"), small n ⇒ the reason, an n column', () => {
        const t = Viz.buildTable(sites);
        expect(t.head).toEqual(['Libellé', 'Prêts pour le poste', 'Effectif']);
        expect(t.rows[0]).toEqual(['Site A', '91,2 %', '41']);
        expect(t.rows[2]).toEqual(['Site C', null, '30']);
        expect(t.rows[3]).toEqual(['Site D', 'Moins de 5 personnes : effectif seulement', '3']);
        const table = { head: ['a'], rows: [['b']] };
        expect(Viz.buildTable(sites, { table })).toBe(table);
    });
});

describe('time series: x from the first month with data, end-of-line labels', () => {
    const line = (over = {}) => ({
        kind: 'line',
        unit: 'pct',
        decimals: 0,
        labels: ['Nov', 'Dec', 'Jan', 'Feb', 'Mar'],
        series: [
            {
                key: 'k1_est',
                label: 'Ready (estimate)',
                data: [null, null, null, 60, 64],
                dashed: true,
            },
            {
                key: 'k3_est',
                label: 'Assessed (estimate)',
                data: [null, null, 70, 72, 74],
                dashed: true,
            },
        ],
        ...over,
    });
    test('xMinFromData ⇒ x.min = the first label holding a value in ANY series', () => {
        expect(Viz.buildChartConfig(line({ xMinFromData: true })).options.scales.x.min).toBe('Jan');
        expect(Viz.buildChartConfig(line()).options.scales.x.min).toBeUndefined();
    });
    test('endLabels ⇒ legend hidden, right padding reserved', () => {
        const c = Viz.buildChartConfig(line({ endLabels: true }));
        expect(c.options.plugins.legend.display).toBe(false);
        expect(c.options.layout.padding.right).toBeGreaterThan(60);
        expect(Viz.buildChartConfig(line()).options.plugins.legend.display).toBe(true);
    });
    test('label = series label + value of the LAST measured point', () => {
        const it = Viz.endLabelItems(line({ endLabels: true }), 'en');
        expect(it.map((x) => x.text)).toEqual(['Ready (estimate) 64%', 'Assessed (estimate) 74%']);
    });
    test('an estimate is not labelled when its measure is drawn; an empty series gets none', () => {
        const cfg = line({
            endLabels: true,
            series: [
                {
                    key: 'k1_est',
                    label: 'Ready (estimate)',
                    data: [50, 55, 60, null, null],
                    dashed: true,
                },
                { key: 'k1', label: 'Ready', data: [null, null, 60, 66, 68] },
            ],
        });
        expect(Viz.endLabelItems(cfg, 'en').map((x) => x.text)).toEqual(['Ready 68%']);
        expect(
            Viz.endLabelItems(
                line({ series: [{ key: 'k9', data: [null, null, null, null, null] }] })
            )
        ).toEqual([]);
    });
    test('spreadLabels keeps labels >= 14 px apart, order preserved', () => {
        expect(Viz.spreadLabels([100, 104, 300], 14)).toEqual([100, 114, 300]);
        expect(Viz.spreadLabels([104, 100], 14)).toEqual([114, 100]);
    });
});

describe('radar', () => {
    const mockChart = (built) => {
        const calls = [];
        const ctx = new Proxy(
            {},
            {
                get: (t, k) =>
                    typeof k === 'string' && /^[a-z]/.test(k)
                        ? (...a) => calls.push([k, ...a])
                        : undefined,
                set: (t, k, v) => {
                    calls.push(['set:' + String(k), v]);
                    return true;
                },
            }
        );
        return {
            calls,
            chart: {
                ctx,
                data: built.data,
                isDatasetVisible: () => true,
                getDatasetMeta: () => ({
                    data: built.data.labels.map((_, i) => ({ x: 200 + i * 10, y: 100 + i * 10 })),
                }),
                scales: {
                    r: {
                        xCenter: 200,
                        yCenter: 200,
                        drawingArea: 150,
                        getPointPositionForValue: (i, v) => ({ x: 200 + i, y: 200 - v }),
                        getIndexAngle: () => 0,
                    },
                },
            },
        };
    };
    test('an unmeasured axis is a gap labelled "Not measured"; long names wrap', () => {
        const rm = Viz.radarModel({
            kind: 'radar',
            labels: ['Collaboration across functions', 'Safety', 'Values and inclusive leadership'],
            series: [{ key: 'a', data: [1, 2, null] }],
        });
        expect(rm.pointLabels[0]).toEqual(['Collaboration', 'across functions']);
        expect(rm.pointLabels[2]).toEqual([
            'Values and',
            'inclusive',
            'leadership',
            '(Pas encore mesuré)',
        ]);
        const c = Viz.buildChartConfig({
            kind: 'radar',
            labels: ['A', 'B', 'C'],
            series: [{ key: 'actual', data: [1, null, 3] }],
        });
        expect(c.data.datasets[0].data).toEqual([1, null, 3]);
        expect(c.data.datasets[0].spanGaps).toBe(false);
    });
    test('an axis with fewer than 5 people is hidden, but stays in the data table', () => {
        const cfg = {
            kind: 'radar',
            labels: ['A', 'B', 'C', 'D'],
            axisN: [10, 3, 8, 9],
            series: [{ key: 'actual', data: [1, 2, 3, 2] }],
        };
        expect(Viz.radarModel(cfg).hidden).toEqual(['B']);
        expect(Viz.buildTable(cfg).rows.map((r) => r[0])).toEqual(['A', 'B', 'C', 'D']);
    });
    test('legend: false hides the per-chart legend', () => {
        const c = {
            kind: 'radar',
            labels: ['A', 'B', 'C'],
            series: [
                { key: 'actual', data: [1, 2, 3] },
                { key: 'required', data: [2, 2, 3] },
            ],
        };
        expect(Viz.buildChartConfig(c).options.plugins.legend.display).toBe(true);
        expect(Viz.buildChartConfig({ ...c, legend: false }).options.plugins.legend.display).toBe(
            false
        );
    });
    test('the target ring is a dashed polygon AT the target on every axis, with its label', () => {
        const built = Viz.buildChartConfig({
            kind: 'radar',
            unit: 'pct',
            labels: ['A', 'B', 'C', 'D', 'E'],
            series: [{ key: 'v', data: [68, 74, null, 60, 74] }],
            targetRing: { value: 80, label: 'Target 80' },
        });
        const { chart, calls } = mockChart(built);
        built.plugins.find((x) => x.id === 'vizRadarAnnot').afterDatasetsDraw(chart);
        const pts = calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo');
        expect(pts).toHaveLength(5);
        expect(pts.every((c) => c[2] === 120)).toBe(true);
        expect(calls.find((c) => c[0] === 'fillText')[1]).toBe('Target 80');
    });
    test('requiredLabel names the required polygon at its first measured vertex', () => {
        const built = Viz.buildChartConfig({
            kind: 'radar',
            labels: ['A', 'B', 'C'],
            requiredLabel: 'required',
            series: [
                { key: 'actual', data: [1, 2, 3] },
                { key: 'required', data: [null, 3, 3] },
            ],
        });
        const { chart, calls } = mockChart(built);
        built.plugins.find((x) => x.id === 'vizRadarAnnot').afterDatasetsDraw(chart);
        const t = calls.filter((c) => c[0] === 'fillText');
        expect(t).toHaveLength(1);
        expect(t[0][3]).toBe(110 - 9);
    });
});

describe('print pictures', () => {
    test('ChartTheme.all() lists a registered live chart once', () => {
        const ch = { canvas: {} };
        CT.register(ch);
        CT.register(ch);
        expect(CT.all().filter((x) => x === ch)).toHaveLength(1);
        CT.unregister(ch);
        expect(CT.all()).not.toContain(ch);
    });

    function fakeWindow() {
        const listeners = {};
        const mk = (tag) => {
            const el = {
                tagName: tag.toUpperCase(),
                children: [],
                attrs: {},
                parentNode: null,
                className: '',
                appendChild(c) {
                    c.parentNode = el;
                    el.children.push(c);
                    return c;
                },
                removeChild(c) {
                    el.children = el.children.filter((x) => x !== c);
                    c.parentNode = null;
                },
                getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
                setAttribute: (k, v) => {
                    el.attrs[k] = String(v);
                },
                querySelector(sel) {
                    if (sel === 'img.viz-print-img')
                        return (
                            el.children.find(
                                (c) => c.tagName === 'IMG' && c.className === 'viz-print-img'
                            ) || null
                        );
                    return null;
                },
                clientWidth: 600,
                clientHeight: 300,
            };
            return el;
        };
        return {
            mk,
            document: {
                readyState: 'complete',
                createElement: mk,
                querySelectorAll: () => [],
                addEventListener: () => {},
            },
            addEventListener: (k, fn) => (listeners[k] = listeners[k] || []).push(fn),
            fire: (k) => (listeners[k] || []).forEach((fn) => fn({})),
            listeners,
        };
    }

    test('beforeprint ⇒ one PNG per chart, resized to its box; afterprint ⇒ removed and resized back', () => {
        const win = fakeWindow();
        const charts = [0, 1].map((i) => {
            const wrap = win.mk('div');
            const canvas = win.mk('canvas');
            canvas.setAttribute('aria-label', 'Chart ' + i);
            wrap.appendChild(canvas);
            return {
                canvas,
                wrap,
                resized: [],
                resize(w, h) {
                    this.resized.push(w === undefined ? [] : [w, h]);
                },
                update() {},
                toBase64Image: () => 'data:image/png;base64,AAAA' + i,
            };
        });
        win.ChartTheme = { all: () => charts };
        let V;
        global.window = win;
        try {
            jest.isolateModules(() => {
                V = require('../../public/js/viz.js');
            });
        } finally {
            delete global.window;
        }
        win.fire('beforeprint');
        charts.forEach((ch, i) => {
            const img = ch.wrap.querySelector('img.viz-print-img');
            expect(img.src).toBe('data:image/png;base64,AAAA' + i);
            expect(img.alt).toBe('Chart ' + i);
            expect(ch.resized[0]).toEqual([600, 300]);
        });
        win.fire('beforeprint');
        expect(charts[0].wrap.children.filter((c) => c.tagName === 'IMG')).toHaveLength(1);
        win.fire('afterprint');
        charts.forEach((ch) => {
            expect(ch.wrap.querySelector('img.viz-print-img')).toBe(null);
            expect(ch.resized[ch.resized.length - 1]).toEqual([]);
        });
        expect(V.printSnap(true)).toBe(2);
    });
    test('a snapshot that is not a PNG data URL is never put on the page', () => {
        const src = read('public/js/viz.js');
        expect(src).toMatch(/String\(src\)\.indexOf\('data:image\/png'\) !== 0/);
    });
});
