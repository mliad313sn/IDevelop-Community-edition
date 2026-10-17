'use strict';
/**
 * The capability rule (src/utils/capability.js): reaching the required level
 * is ONE state, « met ». A level above the requirement is credited at the
 * requirement, never more, so a surplus never offsets a gap and no role or
 * unit figure goes above 100 %.
 *   1  the helper: at, above, below, a measured 0, unmeasured, no requirement
 *   2  the aggregate: capped, a surplus never makes up for a gap (property test)
 *   3  the heat scale: no « above » step, the legend says « Met » / « Atteint »
 *   4  heat cells never print a surplus, even from raw (uncapped) sums
 *   5  the role-gap summary re-evaluates against the role it is given
 */
const CAP = require('../../src/utils/capability');
const HB = require('../../src/utils/heatBins');
const HM = require('../../src/utils/heatModel');
const { render, read, ns } = require('../helpers/vizRender');

describe('1 — one skill against one requirement', () => {
    test('at the requirement: met, ratio 1, gap 0', () => {
        expect(CAP.skillAttainment(2, 2)).toEqual({
            state: 'met',
            ratio: 1,
            gap: 0,
            credited: 2,
            required: 2,
        });
    });
    test('above the requirement: the SAME state, credited at the requirement', () => {
        expect(CAP.skillAttainment(4, 2)).toEqual({
            state: 'met',
            ratio: 1,
            gap: 0,
            credited: 2,
            required: 2,
        });
    });
    test('below: a gap, ratio under 1', () => {
        const s = CAP.skillAttainment(1, 3);
        expect(s.state).toBe('gap');
        expect(s.ratio).toBeCloseTo(1 / 3, 9);
        expect(s.gap).toBe(2);
    });
    test('a measured 0 is a result, not « unmeasured »', () => {
        expect(CAP.skillAttainment(0, 2)).toMatchObject({ state: 'gap', ratio: 0, gap: 2 });
    });
    test.each([null, undefined, '', ' ', 'x', NaN, true])(
        'no level (%p) is unmeasured, never 0',
        (d) => {
            expect(CAP.skillAttainment(d, 2)).toEqual({
                state: 'unmeasured',
                ratio: null,
                gap: null,
                credited: null,
                required: 2,
            });
        }
    );
    test.each([0, null, undefined, -1])('a required level of %p is not a requirement', (r) => {
        const s = CAP.skillAttainment(3, r);
        expect(s.state).toBe('unmeasured');
        expect(s.ratio).toBeNull();
        expect(s.gap).toBeNull();
    });
    test('credited, gapOf, cappedRatio, cappedLevel and the SQL fragments', () => {
        expect(CAP.credited(4, 2)).toBe(2);
        expect(CAP.credited(1, 2)).toBe(1);
        expect(CAP.credited(null, 2)).toBeNull();
        expect(CAP.gapOf(4, 2)).toBe(0);
        expect(CAP.gapOf(1, 2)).toBe(1);
        expect(CAP.gapOf(1, 0)).toBeNull();
        expect(CAP.gapOf(null, 2)).toBeNull();
        expect(CAP.cappedRatio(13, 10)).toBe(1);
        expect(CAP.cappedRatio(5, 10)).toBe(0.5);
        expect(CAP.cappedRatio(5, 0)).toBeNull();
        expect(CAP.cappedRatio(null, 10)).toBeNull();
        expect(CAP.cappedLevel(3.4, 2.5)).toBe(2.5);
        expect(CAP.cappedLevel(1.2, 2.5)).toBe(1.2);
        expect(CAP.cappedLevel(null, 2)).toBeNull();
        expect(CAP.creditedSql('g.actual_level', 'g.required_level')).toBe(
            'LEAST(g.actual_level, g.required_level)'
        );
        expect(CAP.gapSql('a', 'r')).toBe('GREATEST(r - a, 0)');
    });
});

describe('2 — aggregates: capped, a surplus never offsets a gap', () => {
    test('a surplus on one skill does not make up for a gap on another', () => {
        // uncredited Σ actual ÷ Σ required would read (4 + 1) / (2 + 2) = 125 %
        const r = CAP.roleAttainment([
            { demonstrated: 4, required: 2 },
            { demonstrated: 1, required: 2 },
        ]);
        expect(r.ratio).toBeCloseTo(3 / 4, 9);
        expect(r.gapPoints).toBe(1);
        expect(r).toMatchObject({ state: 'gap', met: 1, gaps: 1, measured: 2 });
    });
    test('everything at or above: exactly 100 %, met', () => {
        const r = CAP.roleAttainment([
            { actual: 4, required: 1 },
            { actual: 3, required: 3 },
        ]);
        expect(r.ratio).toBe(1);
        expect(r.state).toBe('met');
    });
    test('unmeasured rows are counted, never scored; nothing measured has no ratio', () => {
        const r = CAP.roleAttainment([
            { demonstrated: null, required: 2 },
            { demonstrated: 2, required: 4 },
            { demonstrated: 3, required: 0 },
        ]);
        expect(r).toMatchObject({ ratio: 0.5, unmeasured: 1, measured: 1 });
        expect(CAP.roleAttainment([{ demonstrated: null, required: 2 }])).toMatchObject({
            state: 'unmeasured',
            ratio: null,
        });
        expect(CAP.roleAttainment([]).ratio).toBeNull();
        expect(CAP.roleAttainment(null).ratio).toBeNull();
    });
    test('property: no aggregate above 100 % over 2 000 generated role profiles', () => {
        let seed = 11;
        const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let i = 0; i < 2000; i++) {
            const rows = Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => ({
                demonstrated: rnd() < 0.15 ? null : Math.floor(rnd() * 5),
                required: 1 + Math.floor(rnd() * 4),
            }));
            const r = CAP.roleAttainment(rows);
            if (r.ratio === null) continue;
            expect(r.ratio).toBeLessThanOrEqual(1);
            expect(r.ratio).toBeGreaterThanOrEqual(0);
            expect(r.gapPoints).toBeGreaterThanOrEqual(0);
            expect(r.state === 'met').toBe(r.gapPoints === 0);
        }
    });
});

describe('3 — the heat scale: « met » is one state', () => {
    test('the attain scale has no « above » step; at or above the requirement is « at »', () => {
        expect(HB.BINS.attain).toEqual(['below-3', 'below-2', 'below-1', 'at']);
        expect(HB.binOf('attain', 1)).toBe('at');
        expect(HB.binOf('attain', 1.3)).toBe('at');
        expect(HB.binOf('attain', 0.97)).toBe('below-1');
    });
    test('the legend copy: « Met » / « Atteint », no « above » key left in FR or EN', () => {
        const fr = ns('fr', 'viz').heat;
        const en = ns('en', 'viz').heat;
        expect(en.bin_attain_at).toBe('Met');
        expect(fr.bin_attain_at).toBe('Atteint');
        for (const o of [fr, en]) expect(Object.keys(o).filter((k) => /above/.test(k))).toEqual([]);
        expect(JSON.stringify(fr)).not.toMatch(/120 %|105 %/);
        expect(JSON.stringify(en)).not.toMatch(/120%|105%/);
    });
    test('the heat CSS has no « above » token or rule', () => {
        const css = read('public/css/viz.css');
        expect(css).not.toMatch(/--vh-above|data-bin='above/);
        for (const v of ['views/partials/viz/heat.ejs', 'views/partials/viz/capmap.ejs'])
            expect(read(v)).not.toMatch(/'above-/);
    });
});

/** A cube whose sums carry a surplus (raw sums: what a faulty caller would hand in). */
const r = (part, u, k, sa, sr, m, n) => ({
    part,
    unitKey: u,
    unitName: u ? 'Unit ' + u : null,
    key: k,
    label: k ? 'Pillar ' + k : null,
    sumActual: sa,
    sumRequired: sr,
    measured: m,
    n,
});
const surplusCube = () => [
    r('cell', '1', '10', 130, 100, 50, 10),
    r('cell', '2', '10', 70, 100, 50, 10),
    r('cell', '3', '10', 100, 100, 50, 10),
    r('unit', '1', null, 130, 100, 50, 10),
    r('unit', '2', null, 70, 100, 50, 10),
    r('unit', '3', null, 100, 100, 50, 10),
    r('axis', null, '10', 300, 300, 150, 30),
    r('total', null, null, 300, 300, 150, 30),
];
const okCells = (m) => {
    const out = [m.total, ...m.cols.map((c) => c.marg)];
    m.rows.forEach((x) => out.push(x.marg, ...x.cells));
    return out.filter((c) => c && c.state === 'ok');
};

describe('4 — heat cells never print a surplus', () => {
    test('attain: every value at most 1, the demonstrated level never above the requirement', () => {
        const m = HM.heatModel(surplusCube(), { kind: 'attain' });
        const cells = okCells(m);
        expect(cells.length).toBeGreaterThan(0);
        for (const c of cells) {
            expect(c.value).toBeLessThanOrEqual(1);
            expect(c.actual).toBeLessThanOrEqual(c.required);
            expect(HB.BINS.attain).toContain(c.bin);
        }
        const html = render('views/partials/viz/heat.ejs', { H: m, heatId: 'cap' });
        expect(html).not.toMatch(/data-bin="above/);
        expect(html).not.toMatch(/130\s?%/);
        expect(html).toMatch(/Atteint/);
        expect(render('views/partials/viz/heat.ejs', { H: m, heatId: 'cap' }, 'en')).toMatch(
            />Met</
        );
    });
    test('deficit: never negative', () => {
        const m = HM.heatModel(surplusCube(), { kind: 'deficit' });
        for (const c of okCells(m)) expect(c.value).toBeGreaterThanOrEqual(0);
    });
});

describe('5 — another role re-evaluates every skill against ITS requirement', () => {
    const { summariseRoleGap } = require('../../src/services/EmployeeGrowthService');
    const levels = { S1: 4, S2: 2 };
    const against = (reqs) =>
        summariseRoleGap(
            Object.entries(reqs).map(([k, req]) => ({
                skillName: k,
                required: req,
                current: levels[k],
                isAssessed: levels[k] !== undefined,
                isCritical: false,
            }))
        );
    test('the same levels meet one role and fall short of another', () => {
        const own = against({ S1: 2, S2: 2 });
        expect(own).toMatchObject({ met: 2, gaps: 0, readiness: 100 });
        const target = against({ S1: 4, S2: 3 });
        expect(target).toMatchObject({ met: 1, gaps: 1, readiness: 50 });
        // the surplus on S1 in the own role never lowers the S2 gap of the target
        expect(target.growRows.map((x) => [x.skillName, x.gap])).toEqual([['S2', 1]]);
        for (const x of own.rows) expect(x.gap).toBeGreaterThanOrEqual(0);
    });
});

describe('6 — the employee reads the rule on the self-assessment page (FR / EN)', () => {
    const fs = require('fs');
    const path = require('path');
    const ejs = require('ejs');
    const { tr } = require('../helpers/vizRender');
    const file = path.join(__dirname, '..', '..', 'views/pages/employee/self-assessment.ejs');
    const page = (lang) =>
        ejs.render(
            fs.readFileSync(file, 'utf8'),
            {
                __: tr(lang),
                lang,
                colon: ' :',
                cspNonce: 'n',
                csrfToken: 'c',
                assetVersion: '1',
                user: { id: 1 },
                skillHelpCore: require('../../src/utils/skillHelp'),
                enumLabel: (a, b) => String(b),
                employee: { roleName: 'R' },
                skillsWithAssessments: [],
                cycle: null,
                lockedCycle: null,
            },
            { filename: file }
        );
    test.each([
        ['fr', /Comment une compétence est-elle comptée/, /ne compense jamais/],
        ['en', /How is a skill counted\?/, /never makes up for another skill/],
    ])(
        '%s: a folded « how is it counted » note, at most 100 % said in words',
        (lang, sum, body) => {
            const html = page(lang);
            const at = html.indexOf('id="saRule"');
            expect(at).toBeGreaterThan(0);
            const block = html.slice(at, html.indexOf('</details>', at));
            expect(block).toMatch(sum);
            expect(block).toMatch(body);
            expect(block).toMatch(/100 %/);
            // folded by default: the note never pushes the form down
            expect(html.slice(html.lastIndexOf('<details', at), at)).not.toMatch(/\bopen\b/);
        }
    );
});
