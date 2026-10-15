'use strict';
/**
 * The context tabs of the dashboard, rendered from models (no database), with
 * the real locale files:
 *   overview    the gauge (partial score said in words, no score under 3
 *               areas), the areas listed with their weights, the trend with
 *               the recorded line solid and the reconstruction dashed on a
 *               fitted axis, starting at the first month with data and
 *               labelled in the reader's language; the sites, risk rows first;
 *   readiness   its section headings in order (FR, EN parity), the bell ‖
 *               groups pair, the comparison radar (axisN per axis, « required »
 *               dashed, an unmeasured axis null, never 0), a table instead of
 *               a radar under 3 pillars, « fewer than 3 gaps » in words;
 *   talent      the doughnut with « Not placed » apart and its counts;
 *   no tab prints a person name field.
 */
const { render } = require('../helpers/vizRender');

const ctx = { scope: {}, scopeQuery: '', navVisible: { nine_box: true } };
const panel = (P, lang = 'fr') =>
    render('views/pages/dashboard/_panel.ejs', { panel: P, ctx, monthLabel: (m) => 'M' + m }, lang);
const configOf = (html, id) => {
    const m = html.match(
        new RegExp(
            `id="${id}"[\\s\\S]*?<script type="application/json" class="viz-config">([\\s\\S]*?)</script>`
        )
    );
    return m ? JSON.parse(m[1]).config : null;
};
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('overview', () => {
    const P = {
        id: 'overview',
        blocks: ['gauge', 'trend', 'siteStatus'],
        threshold: 80,
        profile: {
            axes: [
                { key: 'K1', weight: 30, value: 70, state: 'measured', status: 'watch' },
                { key: 'K3', weight: 15, value: 80, state: 'measured', status: 'compliant' },
                { key: 'K4', weight: 25, value: null, state: 'outside' },
                { key: 'FR', weight: 15, value: 60, state: 'measured', status: 'watch' },
            ],
        },
        gauge: { score: 69.2, status: 'warn', partial: true, measuredCount: 3, total: 4 },
        recorded: [
            { month: '2026-09', K1: 66 },
            { month: '2026-10', K1: 70 },
        ],
        reconstructed: [
            { month: '2026-07', K1: null, K3: null },
            { month: '2026-08', K1: 60, K3: 40 },
            { month: '2026-09', K1: 64, K3: 50 },
            { month: '2026-10', K1: 70, K3: 60 },
        ],
        sites: [
            { key: '2', siteName: 'Sud', rank: 0, k1: { value: 40, status: 'at_risk' } },
            { key: '1', siteName: 'Nord', rank: 2, k1: { value: 90, status: 'compliant' } },
            {
                key: 'none',
                noSite: true,
                rank: 2,
                k1: { status: 'small_n', numerator: 2, denominator: 3 },
            },
        ],
    };
    test('the gauge says it is partial; the areas carry their weights; outside is said', () => {
        const html = panel(P);
        expect(html).toMatch(/id="ds-gauge" data-score="69.2"/);
        expect(text(html)).toContain('Score partiel : 3 domaines mesurés sur 4');
        expect(text(html)).toContain(
            'Compétences critiques (poids 25) non visible avec vos droits'
        );
        const none = panel({
            ...P,
            gauge: { score: null, partial: true, measuredCount: 2, total: 4 },
        });
        expect(none).not.toMatch(/ds-gauge-arc/);
        expect(text(none)).toContain('Non mesuré : moins de 3 domaines sont mesurés.');
    });
    test('the trend: recorded solid, reconstruction dashed, fitted axis, from the first month with data', () => {
        const c = configOf(panel(P), 'ds-trend');
        expect(c.kind).toBe('line');
        expect(c.fitAxis).toBe(true);
        expect(c.labels).toEqual(['M2026-08', 'M2026-09', 'M2026-10']);
        const by = Object.fromEntries(c.series.map((s) => [s.key, s]));
        expect(by.k1_recorded.dashed).toBeUndefined();
        expect(by.k1_recorded.data).toEqual([null, 66, 70]);
        expect(by.k1_est.dashed).toBe(true);
        expect(by.k3_est.dashed).toBe(true);
        expect(c.threshold.value).toBe(80);
    });
    test('nothing to draw ⇒ a sentence, not an empty chart', () => {
        const html = panel({
            ...P,
            recorded: [],
            reconstructed: [{ month: '2026-10', K1: null, K3: null }],
        });
        expect(html).not.toMatch(/id="ds-trend"/);
        expect(text(html)).toContain('Pas encore assez d’historique');
    });
    test('the sites table keeps the risk rows first and never prints a % under 5 people', () => {
        const html = panel(P);
        const rows = [...html.matchAll(/<tr data-rank="(\d)">\s*<th scope="row">([^<]*)</g)].map(
            (m) => [m[1], m[2]]
        );
        expect(rows).toEqual([
            ['0', 'Sud'],
            ['2', 'Nord'],
            ['2', 'Sans site'],
        ]);
        expect(text(html)).toContain('2 sur 3');
        expect(html).toMatch(/viz-chip--risk/);
    });
});

describe('readiness', () => {
    const groups = {
        rows: [
            {
                key: '1',
                id: 1,
                label: 'Nord',
                value: 50,
                denominator: 10,
                status: 'at_risk',
                population: 12,
            },
            {
                key: '2',
                id: 2,
                label: 'Sud',
                value: null,
                denominator: 3,
                status: 'small_n',
                population: 3,
            },
        ],
    };
    const base = {
        id: 'readiness',
        blocks: ['readinessTiles', 'bell', 'byGroup', 'compare', 'pillarHeat'],
        threshold: 80,
        bell: {
            n: 30,
            hidden: false,
            bins: [
                { from: 0, to: 50, count: 10 },
                { from: 50, to: 100, count: 20 },
            ],
            curve: [
                { x: 0, y: 1 },
                { x: 100, y: 2 },
            ],
            mean: 60,
            sd: 10,
        },
        distribution: { unmeasured: 4, noRequirement: 1, bins: [] },
        groupUnit: 'site',
        byGroup: groups,
        compare: {
            unit: 'site',
            id: 1,
            label: 'Nord',
            isDefault: true,
            people: 12,
            axes: [
                { key: '1', label: 'A', ref: 2, unit: 1.5, required: 3, axisN: 8 },
                { key: '2', label: 'B', ref: 2.5, unit: null, required: 3, axisN: 3 },
                { key: '3', label: 'C', ref: 2.2, unit: 2, required: 3, axisN: 6 },
            ],
            gaps: [{ label: 'X', gap: 2, n: 6 }],
            options: [
                { id: 1, label: 'Nord' },
                { id: 2, label: 'Sud' },
            ],
        },
    };
    test('section headings in order (FR) and in English', () => {
        const heads = (h) => [...h.matchAll(/<h3 class="ds-section-h">([^<]*)</g)].map((m) => m[1]);
        expect(heads(panel(base))).toEqual([
            'Répartition de la préparation',
            'Une unité comparée à tout le périmètre',
        ]);
        expect(heads(panel(base, 'en'))).toEqual([
            'How readiness is spread',
            'A unit compared with the whole scope',
        ]);
    });
    test('the bell curve and the groups share one pair; the groups chart keeps n and the threshold', () => {
        const html = panel(base);
        const pair = html.slice(html.indexOf('<div class="ds-pair">'));
        expect(pair.indexOf('id="ds-bell"')).toBeLessThan(pair.indexOf('id="ds-groups"'));
        const c = configOf(html, 'ds-groups');
        expect(c.series[0].n).toEqual([10, 3]);
        expect(c.series[0].data).toEqual([50, null]);
        expect(c.threshold.value).toBe(80);
        expect(text(html)).toContain('Pas encore mesurés : 4. Sans exigence : 1.');
    });
    test('the comparison radar: axisN per axis, required dashed, unmeasured null (never 0)', () => {
        const html = panel(base);
        const c = configOf(html, 'ds-compare-radar');
        expect(c.kind).toBe('radar');
        expect(c.axisN).toEqual([8, 3, 6]);
        const by = Object.fromEntries(c.series.map((s) => [s.key, s]));
        expect(by.unit.data).toEqual([1.5, null, 2]);
        expect(by.required.dashed).toBe(true);
        expect(text(html)).toContain('Affichée par défaut');
        expect(html).toMatch(/id="ds-compare-few"/); // one gap only: no ranking
    });
    test('fewer than 3 pillars ⇒ a table, not a radar; a chosen unit drops the default sentence', () => {
        const two = {
            ...base,
            compare: { ...base.compare, isDefault: false, axes: base.compare.axes.slice(0, 2) },
        };
        const html = panel(two);
        expect(html).not.toMatch(/id="ds-compare-radar"/);
        expect(html).toMatch(/id="ds-compare-table"/);
        expect(text(html)).toContain('Pas encore mesuré');
        expect(html).not.toMatch(/id="ds-compare-default"/);
    });
});

describe('talent', () => {
    test('the doughnut: « Not placed » apart, counts printed, a link to the grid', () => {
        const html = panel({
            id: 'talent',
            blocks: ['nineBox'],
            nineBox: {
                total: 14,
                placed: 10,
                notPlaced: 4,
                slices: [
                    {
                        kind: 'cell',
                        cell: 'high-high',
                        key: 'nb_cell_gold',
                        zone: 'good',
                        count: 7,
                        pct: 50,
                    },
                    { kind: 'others', count: 3, pct: 21.4, cells: 2 },
                    { kind: 'not_placed', count: 4, pct: 28.6 },
                ],
            },
        });
        expect((html.match(/<path class="ds-slice--/g) || []).length).toBe(3);
        expect(text(html)).toContain('Non positionnés 4');
        expect(text(html)).toContain('Autres (moins de 5 chacune) 3');
        expect(html).toMatch(/href="\/talent\/nine-box"/);
    });
});
