'use strict';

/**
 * Two more null->0/worst rendering fabrications the re-audit found.
 *
 * N4 — renderBarChart with thresholdColors sent a null value (an unmeasured
 * site/dept/service) down getColorForValue's last branch (`null >= 50` false)
 * and painted it the worst red, then the tooltip printed " null%". An
 * unmeasured group now renders muted grey with a "not measured" tooltip, the
 * way the sibling renderDeptRankingChart already does.
 *
 * N5 — renderBenchmarkFitTable printed "0" crit gaps and "0/2 ready" for a role
 * nobody has assessed (measuredOccupants 0), reading as an all-clear. The
 * benchmark/index.ejs table shows a dash from the same endpoint; this twin now
 * matches.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const src = fs.readFileSync(path.join(ROOT, 'public/js/dashboard.js'), 'utf8');

const extract = (name) => {
    const s = src.indexOf(`function ${name}(`);
    let i = src.indexOf('{', s);
    let d = 0;
    let e = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}' && --d === 0) {
            e = i + 1;
            break;
        }
    }
    return src.slice(s, e);
};

describe('N4 — renderBarChart colours and labels a null value as unmeasured', () => {
    // Drive the color/tooltip logic the renderer uses, extracted verbatim.
    test('a null value is muted grey, not the worst-red branch', () => {
        const COLORS = { good: 'G', warning: 'A', danger: 'R', neutral: 'N' };
        const CT = { ROLE: { noData: 'GREY' } };
        const getColorForValue = new Function(
            'COLORS',
            `${extract('getColorForValue')}; return getColorForValue;`
        )(COLORS);
        // the exact expression from renderBarChart
        const noData = (CT.ROLE && CT.ROLE.noData) || 'rgba(148,163,184,0.5)';
        const colourOf = (v) => (v == null ? noData : getColorForValue(v, 80, 50));
        expect(colourOf(null)).toBe('GREY'); // not 'R'
        expect(colourOf(90)).toBe('G');
        expect(colourOf(60)).toBe('A');
        expect(colourOf(10)).toBe('R');
        // and getColorForValue alone WOULD have reddened null — proves the guard matters
        expect(getColorForValue(null, 80, 50)).toBe('R');
    });

    test('the source guards both the colour and the tooltip', () => {
        const body = extract('renderBarChart').replace(/\s+/g, ' ');
        expect(body).toMatch(/v == null \? noData : getColorForValue\(v, 80, 50\)/);
        expect(body).toMatch(/if \(v == null\) return ' ' \+ \(I18N\.rdNotMeasured/);
    });
});

describe('N5 — renderBenchmarkFitTable dashes the unmeasured, not 0/0', () => {
    const I18N = {
        role: 'Rôle',
        occupants: 'Titulaires',
        benchmarkFit: 'Adéquation',
        coverage: 'Couverture',
        criticalFit: 'Adéq. crit.',
        critGaps: 'Écarts crit.',
        readyGe80: 'Prêts ≥80%',
        noData: 'Aucune donnée',
        noOccupantsAssessed: 'Aucun titulaire évalué',
    };
    const render = (fit) => {
        const el = { innerHTML: '' };
        new Function(
            'I18N',
            'container',
            `const fmtPct = (v) => v + '%'; ${extract('renderBenchmarkFitTable')}; renderBenchmarkFitTable(container, container.__fit);`
        )(I18N, Object.assign(el, { __fit: fit }));
        return el.innerHTML;
    };

    const NEVER = {
        roleId: 1,
        roleName: 'Audit Manager',
        occupants: 2,
        measuredOccupants: 0,
        benchmarkFit: null,
        coverage: 0,
        occupantsCriticalGap: 0,
        occupantsReady: 0,
        criticalFit: null,
    };
    const MEASURED = {
        roleId: 2,
        roleName: 'UX/UI',
        occupants: 3,
        measuredOccupants: 2,
        benchmarkFit: 30,
        coverage: 100,
        occupantsCriticalGap: 1,
        occupantsReady: 1,
        criticalFit: 40,
    };

    test('a never-assessed role shows dashes for crit gaps and ready, not 0 and 0/2', () => {
        const rows = render([NEVER, MEASURED]).split('<tr>').slice(2); // drop header
        const audit = rows[0];
        expect(audit).not.toContain('>0/2<'); // was "0/2 ready"
        expect(audit).not.toMatch(/;">0<\/td>/); // was a bare 0 crit gap
        // fit + crit-gap + ready all dashed
        expect((audit.match(/bm-nodata/g) || []).length).toBe(3);
    });

    test('a measured role keeps its real numbers', () => {
        const rows = render([NEVER, MEASURED]).split('<tr>').slice(2);
        expect(rows[1]).toContain('1/3'); // ready
        expect(rows[1]).not.toContain('bm-nodata');
    });
});
