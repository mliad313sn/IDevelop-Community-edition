'use strict';
/**
 * The profile radar (public/js/profile-radar.js + views/partials/viz/radar.ejs)
 * and the gap bars (public/js/dumbbell.js + views/partials/viz/dumbbell.ejs):
 *   - an unmeasured axis or row is null — a gap, "Not measured" — never 0 and
 *     never ranked among the widest gaps;
 *   - the server renders the data without JS, and the radar as SVG for print;
 *   - the data travels in an escaped JSON block, no inline script, no
 *     injected stylesheet; every text goes in as text;
 *   - the benchmark role page builds its profile from ASSESSED cells only.
 */
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));
const Dumbbell = require('../../public/js/dumbbell');
const ProfileRadar = require('../../public/js/profile-radar');
const { render, read } = require('../helpers/vizRender');
const { roleProfileAxes } = require('../../src/controllers/BenchmarkController');

const rows = [
    { label: 'Lockout procedure', actual: 1.5, required: 3, n: 12 },
    { label: 'Lifting', actual: null, required: 2, n: 0 },
    { label: 'Gas detection', actual: 2, required: 3, n: 9 },
    { label: 'First aid', actual: 3.5, required: 3, n: 7 },
];

describe('gap bars', () => {
    test('build: the unmeasured row has no value and no gap, sorted last', () => {
        const m = Dumbbell.build(rows);
        expect(m.items.map((x) => x.label)).toEqual([
            'Lockout procedure',
            'Gas detection',
            'First aid',
            'Lifting',
        ]);
        const un = m.items[3];
        expect(un).toMatchObject({ measured: false, actual: null, gap: null, actualPct: null });
        expect(m.widest).toEqual(['Lockout procedure', 'Gas detection']);
        expect(m.unmeasured).toBe(1);
        expect(m.items[2].gap).toBe(-0.5); // a surplus, not a gap
    });
    test('topN keeps the widest MEASURED gaps and still reports the unmeasured', () => {
        const m = Dumbbell.build(rows, { topN: 1 });
        expect(m.items.map((x) => x.label)).toEqual(['Lockout procedure', 'Lifting']);
    });
    test('the summary is in the page language and counts the unmeasured', () => {
        expect(Dumbbell.summary(Dumbbell.build(rows), { lang: 'en' })).toBe(
            'Lockout procedure : demonstrated 1.5, required 3.0 ; Gas detection : demonstrated 2.0, required 3.0 ; First aid : demonstrated 3.5, required 3.0 ; Not measured yet : 1'
        );
    });
    test('no stylesheet injected, no markup sink: positions through the CSSOM, text as text', () => {
        const src = read('public/js/dumbbell.js');
        expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|createElement\('style'\)/);
        expect(read('public/css/viz.css')).toMatch(
            /\.db-track--unmeasured \{[^}]*var\(--viz-hatch\)/
        );
    });
    test('the partial: a table without JS, "Not measured" for a null, an escaped data block', () => {
        const h = render('views/partials/viz/dumbbell.ejs', {
            dumbbell: {
                id: 'g',
                rows: [...rows, { label: '</script><b>x</b>', actual: 1, required: 2 }],
            },
        });
        expect(h).toMatch(/<td class="viz-num viz-unmeasured-cell">Pas encore mesuré<\/td>/);
        expect(h).toMatch(/<td class="viz-num">1,5<\/td>/);
        const block = h.match(
            /<script type="application\/json" class="dumbbell-data">([\s\S]*?)<\/script>/
        )[1];
        expect(block).not.toMatch(/</);
        expect(JSON.parse(block).rows).toHaveLength(5);
        expect(h).not.toMatch(/<b>x<\/b>/);
    });
});

describe('profile radar', () => {
    const axes = [
        { label: 'Leading teams', actual: 2.6, required: 2.7, assessed: 14, total: 18 },
        { label: 'Developing people', actual: null, required: 2.5, assessed: 0, total: 12 },
        { label: 'Process excellence', actual: 1.3, required: 2, assessed: 4, total: 6 },
    ];
    test('an unmeasured axis is null (never 0) and says so in its label', () => {
        const m = ProfileRadar.build(axes, { lang: 'en' });
        expect(m.actual).toEqual([2.6, null, 1.3]);
        expect(m.pointLabels[1]).toEqual(['Developing people', '(Not measured yet)']);
        expect(m.unmeasured).toEqual(['Developing people']);
    });
    test('the partial: the data without JS, the print SVG breaks at the gap', () => {
        const h = render(
            'views/partials/viz/radar.ejs',
            { radar: { id: 'r', title: 'Profile', axes } },
            'en'
        );
        expect(h).toMatch(/data-profile-radar/);
        expect(h).toMatch(/<td class="viz-num viz-unmeasured-cell">Not measured yet<\/td>/);
        expect(h).toMatch(/<svg class="viz-radar-svg"/);
        expect(h).toMatch(/Developing people \(Not measured yet\)<\/text>/);
        // the demonstrated polygon is two segments: it never passes through the gap
        const measured = h.match(/<polyline class="viz-radar-line viz-radar-line--0"/g) || [];
        expect(measured).toHaveLength(1);
        const pts = h.match(/viz-radar-line--0" points="([^"]+)"/)[1].split(' ');
        expect(pts).toHaveLength(2); // axis 3 → axis 1 (closing), never through axis 2
        expect(h).not.toMatch(/<script(?![^>]*type="application\/json")[^>]*>/);
    });
    test('fewer than 3 axes: no radar shape is drawn on paper', () => {
        const h = render('views/partials/viz/radar.ejs', {
            radar: { id: 'r', axes: axes.slice(0, 2) },
        });
        expect(h).not.toMatch(/<svg/);
    });
});

describe('the benchmark role profile is built from assessed cells only', () => {
    test('a sub-domain nobody assessed is null, never 0', () => {
        const domains = [
            {
                name: 'Leadership',
                subs: [
                    {
                        name: 'Leading teams',
                        skills: [
                            {
                                required: 3,
                                cells: {
                                    1: { actual: 2, assessed: true },
                                    2: { actual: null, assessed: false },
                                },
                            },
                            {
                                required: 2,
                                cells: {
                                    1: { actual: 3, assessed: true },
                                    2: { actual: 1, assessed: true },
                                },
                            },
                        ],
                    },
                    {
                        name: 'Coaching',
                        skills: [{ required: 2, cells: { 1: { actual: null, assessed: false } } }],
                    },
                ],
            },
        ];
        expect(roleProfileAxes(domains)).toEqual([
            { label: 'Leading teams', required: 2.5, actual: 2, assessed: 3, total: 4 },
            { label: 'Coaching', required: 2, actual: null, assessed: 0, total: 1 },
        ]);
    });
});
