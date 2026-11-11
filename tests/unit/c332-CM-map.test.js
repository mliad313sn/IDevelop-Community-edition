'use strict';
/**
 * The capability map (pure model + its two partials, no database): the WHOLE
 * framework (every pillar, each disclosing its sub-domains, « Whole
 * framework » first) x every unit of the scope, « Overall » last; same
 * measure, tokens and rules as the heatmap (units under 5 pooled, « < 5 »
 * masked with complementary suppression, « Not measured » hatched never 0,
 * « Not required in this scope » a dot, the status decided on the printed
 * value, links only to the aggregate list).
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const H = require('../../src/utils/heatModel');
const KF = require('../../src/utils/kpiFormat');

const tr = (lang) => (key, vars) => {
    const [ns, k] = String(key).split(':');
    // eslint-disable-next-line security/detect-non-literal-require
    const dict = require(`../../locales/${lang}/${ns}.json`);
    const get = (p) =>
        p.split('.').reduce((o, x) => (o && typeof o === 'object' ? o[x] : undefined), dict);
    let v = get(k);
    if (typeof v !== 'string' && vars && vars.count !== undefined)
        v = get(k + (Number(vars.count) === 1 ? '_one' : '_other'));
    if (typeof v !== 'string') v = k;
    return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, x) => (vars && vars[x] != null ? vars[x] : ''));
};
const render = (rel, locals, lang = 'en') =>
    ejs.render(
        fs.readFileSync(path.join(ROOT, rel), 'utf8'),
        { __: tr(lang), lang, numFmt: KF.forLang(lang), ...locals },
        { filename: path.join(ROOT, rel) }
    );

// a cube row like DashboardHomeService.capabilityMap
const r = (part, u, p, s, sa, sr, m, n) => ({
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
/**
 * Sites A, B (10 and 12 people) and C (3) x pillar 1 (subs 11, 12) and
 * pillar 2 (sub 21); pillar 3 is in the framework but nobody is required on it.
 */
function cube(over = {}, twoSmall = true) {
    const rows = [
        r('us', 'A', '1', '11', 70, 100, 50, 10),
        r('us', 'A', '1', '12', 90, 100, 50, 10),
        r('us', 'B', '1', '11', 100, 100, 50, 12),
        r('us', 'B', '1', '12', 110, 100, 50, 12),
        r('us', 'C', '1', '11', 30, 40, 20, 3),
        r('us', 'A', '2', '21', 40, 100, 50, 10),
        r('us', 'B', '2', '21', null, null, 0, 0), // a requirement nobody assessed
        r('up', 'A', '1', null, 160, 200, 100, 10),
        r('up', 'B', '1', null, 210, 200, 100, 12),
        r('up', 'C', '1', null, 30, 40, 20, 3),
        r('up', 'A', '2', null, 40, 100, 50, 10),
        r('up', 'B', '2', null, null, null, 0, 0),
        r('u', 'A', null, null, 200, 300, 150, 10),
        r('u', 'B', null, null, 210, 200, 100, 12),
        r('u', 'C', null, null, 30, 40, 20, 3),
        r('s', null, '1', '11', 200, 240, 120, 23),
        r('s', null, '1', '12', 200, 200, 100, 20),
        r('s', null, '2', '21', 40, 100, 50, 10),
        r('p', null, '1', null, 400, 440, 220, 23),
        r('p', null, '2', null, 40, 100, 50, 10),
        r('total', null, null, null, 440, 540, 270, 23),
    ].concat(
        twoSmall // a fourth site of 3 people: « Others » pools 6 people (>= 5, a real value)
            ? [
                  r('us', 'D', '1', '11', 30, 40, 20, 3),
                  r('up', 'D', '1', null, 30, 40, 20, 3),
                  r('u', 'D', null, null, 30, 40, 20, 3),
              ]
            : []
    );
    return rows.map((x) => {
        const o = over[[x.part, x.unitKey, x.pillarKey, x.subKey].join(':')];
        return o ? { ...x, ...o } : x;
    });
}
const TREE = [
    {
        key: '1',
        label: 'Operations',
        subs: [
            { key: '11', label: 'Permits' },
            { key: '12', label: 'Isolation' },
        ],
    },
    { key: '2', label: 'Technical', subs: [{ key: '21', label: 'Maintenance' }] },
    { key: '3', label: 'Legal', subs: [{ key: '31', label: 'Contracts' }] },
];
const HREF = (u, part) => `/dashboard/list?kpi=DOM&part=${part}&site=${u}`;

describe('model', () => {
    const m = H.capabilityMapModel(cube(), TREE, { unit: 'site', hrefOf: HREF });
    test('every pillar of the framework, in framework order, each with ALL its sub-domains', () => {
        expect(m.rows.map((x) => x.label)).toEqual(['Operations', 'Technical', 'Legal']);
        expect(m.rows[0].children.map((x) => x.label)).toEqual(['Permits', 'Isolation']);
        const legal = m.rows[2]; // nobody in scope is required on it: « Not required », never 0
        expect(legal.cells.every((c) => c.state === 'na')).toBe(true);
        expect(legal.marg.state).toBe('na');
        expect(legal.children[0].cells.every((c) => c.state === 'na')).toBe(true);
        expect(m.hasNa).toBe(true);
    });
    test('« Whole framework » first: population aggregates, never a mean of cells', () => {
        expect(m.totalFirst).toBe(true);
        const a = m.cols.find((c) => c.key === 'A');
        expect(a.marg.value).toBeCloseTo(200 / 300, 9);
        expect(m.total.value).toBeCloseTo(440 / 540, 9);
        expect(m.total.n).toBe(23);
    });
    const mSmall = H.capabilityMapModel(cube({}, false), TREE, { unit: 'site', hrefOf: HREF });
    test('units under 5 people are pooled into « Others », last; pooled n >= 5 is a real value', () => {
        const last = m.cols[m.cols.length - 1];
        expect(last.pooled).toEqual(['Site C', 'Site D']);
        expect(last.marg.state).toBe('ok');
        expect(last.marg.value).toBeCloseTo(60 / 80, 9);
        expect(last.marg.n).toBe(6);
        expect(mSmall.cols[mSmall.cols.length - 1].marg.state).toBe('masked');
        expect(m.cols.map((c) => c.key)).toEqual(['A', 'B', 'pooled']); // worst first
    });
    test('a requirement nobody assessed is « Not measured »: no value, no colour, never 0', () => {
        const t = m.rows[1];
        const b = t.cells[m.cols.findIndex((c) => c.key === 'B')];
        expect(b.state).toBe('unmeasured');
        expect(b.bin).toBeUndefined();
        expect(b.value).toBeUndefined();
    });
    test('complementary suppression on the pillars, inside a pillar and on « Whole framework »', () => {
        const ops = mSmall.rows[0];
        const ia = mSmall.cols.findIndex((c) => c.key === 'A');
        const ip = mSmall.cols.length - 1;
        expect(ops.cells[ip].state).toBe('masked');
        expect(ops.cells[ia]).toMatchObject({ state: 'masked', complementary: true });
        expect(ops.children[0].cells[ia].state).toBe('masked');
        expect(mSmall.cols[ia].marg.state).toBe('masked'); // the pooled total cannot be worked out
    });
    test('links only on measured, non-pooled cells: pillar p<id>, sub-domain s<id>', () => {
        const ops = m.rows[0];
        const ia = m.cols.findIndex((c) => c.key === 'A');
        expect(ops.cells[ia].href).toBe(HREF('A', 'p1'));
        expect(ops.children[0].cells[ia].href).toBe(HREF('A', 's11'));
        expect(ops.cells[m.cols.length - 1].href).toBeUndefined();
        expect(m.cols[ia].marg.href).toBeUndefined(); // the « Whole framework » row has no list
    });
    test('status on the PRINTED value: 79.6 % prints « 80 % » and carries no ▼', () => {
        const m2 = H.capabilityMapModel(
            cube({ 'up:B:1:': { sumActual: 159.2, sumRequired: 200 } }),
            TREE,
            { unit: 'site' }
        );
        const c = m2.rows[0].cells[m2.cols.findIndex((x) => x.key === 'B')];
        expect(c.value).toBeCloseTo(0.796, 9);
        expect(c.below).toBe(false);
    });
    test('the phone list: the worst measured sub-domain cells, « Pillar › Sub-domain »', () => {
        expect(m.flat[0].row).toBe('Technical › Maintenance');
        expect(m.flat.every((x) => x.state === 'ok')).toBe(true);
    });
    test('the sentence reads the pillar totals', () => {
        expect(m.pillarsBelow).toEqual(['Technical']);
    });
    test('nothing in scope: empty, and no strip', () => {
        expect(H.capabilityMapModel([], TREE, {}).empty).toBe(true);
        expect(H.capabilityMapStrip(H.capabilityMapModel([], TREE, {}))).toBeNull();
    });
});

describe('render: the full map', () => {
    const m = H.capabilityMapModel(cube(), TREE, { unit: 'site', hrefOf: HREF });
    const h = render('views/partials/viz/capmap.ejs', { H: m, heatId: 'cm' });
    test('« Whole framework » is the first body row, then the pillars', () => {
        const body = h.slice(h.indexOf('<tbody>'));
        expect(body.indexOf('Whole framework')).toBeGreaterThan(-1);
        expect(body.indexOf('Whole framework')).toBeLessThan(body.indexOf('Operations'));
    });
    test('each pillar discloses its sub-domains: button, aria-expanded, aria-controls, hidden tbody', () => {
        expect(h).toMatch(
            /<button type="button" class="vh-disc" data-vh-disc aria-expanded="false" aria-controls="cm-g-p1">/
        );
        expect(h).toMatch(
            /<tbody class="vh-subs" id="cm-g-p1" hidden>[\s\S]*?Permits[\s\S]*?Isolation[\s\S]*?<\/tbody>/
        );
        expect(h).toMatch(/data-vh-expand-all/);
        expect(h).not.toMatch(/\son[a-z]+="/i);
    });
    test('a sub-domain cell links with s<id>; its tooltip names « Pillar › Sub-domain »', () => {
        expect(h).toMatch(
            /data-tip="Operations › Permits — Site A[\s\S]*?href="\/dashboard\/list\?kpi=DOM&amp;part=s11&amp;site=A"/
        );
    });
    test('the data table carries the total, every pillar and every sub-domain', () => {
        const t = h.slice(h.indexOf('id="cm-data"'));
        expect(t).toMatch(/Whole framework/);
        expect(t).toMatch(/Operations › Isolation/);
        expect(t).toMatch(
            /Legal › Contracts<\/th><td>Site A<\/td>\s*<td class="viz-num viz-unmeasured-cell" colspan="4">· Not required in this scope/
        );
    });
    test('an unmeasured cell is hatched; legend keys for masked, unmeasured and not required', () => {
        expect(h).toMatch(/class="vh-c vh-c--unmeasured viz-hatch"/);
        expect(h).toMatch(/vh-sw--na[^>]*>·<\/span>Not required in this scope/);
    });
    test('French copy', () => {
        const f = render('views/partials/viz/capmap.ejs', { H: m, heatId: 'cm' }, 'fr');
        expect(f).toMatch(/Ensemble du référentiel/);
        expect(f).toMatch(/Pilier \/ sous-domaine/);
        expect(f).toMatch(/1 piliers sur 3 sous 80 % du requis : Technical\./);
        expect(f).not.toMatch(/Whole framework/);
    });
});

describe('render: the Overview strip', () => {
    const S = H.capabilityMapStrip(H.capabilityMapModel(cube({}, false), TREE, { unit: 'site' }));
    const h = render('views/partials/viz/capstrip.ejs', {
        S,
        stripId: 'st',
        href: '/dashboard?tab=readiness#ds-capmap',
    });
    test('the « Whole framework » row only: one cell per column and « Overall »', () => {
        expect((h.match(/<li class="vh-strip-c/g) || []).length).toBe(S.cols.length + 1);
        // Site A is masked: the pooled cell cannot be worked out. Site B's raw sums
        // carry a surplus (105 %): no level is credited above the requirement, so it
        // prints « 100% » (src/utils/capability.js)
        expect(h).toMatch(/Site B[\s\S]*?100%/);
        expect(h).not.toMatch(/105%/);
        expect(h).toMatch(/vh-strip-c--total[\s\S]*?Overall[\s\S]*?81%/);
        expect(h).not.toMatch(/Operations/);
    });
    test('a pooled unit under 5 is « < 5 » with no value; the link opens the full map', () => {
        expect(h).toMatch(/vh-strip-c--masked[\s\S]*?&lt; 5/);
        expect(h).toMatch(
            /href="\/dashboard\?tab=readiness#ds-capmap">See the full capability map/
        );
    });
});

describe('copy parity and the hatch cascade', () => {
    test('viz heat map_* keys exist in FR and EN', () => {
        const fr = Object.keys(require('../../locales/fr/viz.json').heat).filter((k) =>
            k.startsWith('map_')
        );
        const en = Object.keys(require('../../locales/en/viz.json').heat).filter((k) =>
            k.startsWith('map_')
        );
        expect(fr.sort()).toEqual(en.sort());
        expect(fr.length).toBeGreaterThanOrEqual(12);
    });
    test('« Not measured » strip cells: a LATER rule sets the hatch over the background', () => {
        const css = fs.readFileSync(path.join(ROOT, 'public/css/viz.css'), 'utf8');
        const base = css.indexOf('.vh-strip-c {');
        const um = css.indexOf('.vh-strip-c--unmeasured,');
        expect(base).toBeGreaterThan(-1);
        expect(um).toBeGreaterThan(base);
        expect(css.slice(um, css.indexOf('}', um))).toMatch(
            /background-image:\s*var\(--viz-hatch\)/
        );
    });
    test('the DOM list accepts a sub-domain part and nothing else', () => {
        const T = require('../../src/config/dashboardTabs');
        for (const ok of ['p1', 's42']) expect(T.DRILLS.DOM.partPattern.test(ok)).toBe(true);
        for (const bad of ['x1', 's0', 'p', 's1a', 'p1;drop'])
            expect(T.DRILLS.DOM.partPattern.test(bad)).toBe(false);
    });
});
