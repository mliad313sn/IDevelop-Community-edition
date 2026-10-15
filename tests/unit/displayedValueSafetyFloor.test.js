'use strict';
/**
 * Decide on what is displayed, and never round a compliance % up.
 *
 *  - utils/displayedValue: one rounding for the printed value and the status;
 *    safety / compliance units round DOWN, so a value below 100 never prints 100.
 *  - The critical-compliance KPI (critical requirements met / assessed) is
 *    floored at the source: 1 999 of 2 000 met reads 99.9 %, never 100 %.
 *  - The department brief colours a % on the value it prints; the dashboard
 *    tiles colour on the one-decimal value fmtPct prints.
 */
const fs = require('fs');
const path = require('path');
const DV = require('../../src/utils/displayedValue');

const ROOT = path.join(__dirname, '..', '..');

describe('displayedValue', () => {
    test.each([
        [79.6, 'pct', 80],
        [79.4, 'pct', 79],
        [79.96, 'pct1', 80],
        [0.796, 'ratio', 0.8],
        [1.85, 'level', 1.9],
        [-0.04, 1, 0],
        [12.345, 2, 12.35],
    ])('%s %s → %s', (v, unit, out) => {
        expect(DV.displayedValue(v, unit)).toBe(out);
    });

    test.each([
        [99.5, 'pctFloor', 99],
        [99.9, 'pctFloor', 99],
        [99.95, 'pct1Floor', 99.9],
        [99.99, 'pct1Floor', 99.9],
        [100, 'pctFloor', 100],
        [94.99, 'pctFloor', 94],
        [28.999999999999996, 'pctFloor', 29], // binary noise meant as 29
        [0, 'pctFloor', 0],
    ])('safety unit: %s %s → %s', (v, unit, out) => {
        expect(DV.displayedValue(v, unit)).toBe(out);
    });

    test('a safety value below 100 never prints 100; unmeasured stays null', () => {
        for (let i = 0; i < 2000; i++) {
            const v = Math.random() * 100;
            expect(DV.displayedValue(v, 'pctFloor')).toBeLessThanOrEqual(v + 1e-9);
            expect(DV.displayedValue(v, 'pct1Floor')).toBeLessThan(100);
        }
        for (const v of [null, undefined, '', ' ', true, 'abc', NaN])
            expect(DV.displayedValue(v, 'pct')).toBe(null);
        expect(DV.safetyUnit(0)).toBe('pctFloor');
        expect(DV.safetyUnit(1)).toBe('pct1Floor');
        expect(() => DV.displayedValue(1, 'nope')).toThrow(/unknown unit/);
    });

    test('below / atLeast decide on the displayed value', () => {
        expect(DV.below(79.6, 80, 'pct')).toBe(false); // printed 80 %: reached
        expect(DV.below(79.4, 80, 'pct')).toBe(true);
        expect(DV.atLeast(1.85, 1.9, 'level')).toBe(true);
        expect(DV.below(null, 80)).toBe(null);
        // a safety unit compares against the threshold as given (never floored)
        expect(DV.below(99.9, 100, 'pctFloor')).toBe(true);
        expect(DV.below(100, 100, 'pctFloor')).toBe(false);
    });
});

describe('the critical-compliance KPI is floored at the source', () => {
    test('getOverviewKPIs floors to the printed decimal instead of rounding', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/models/DashboardModel.js'), 'utf8');
        expect(src).toMatch(
            /THEN FLOOR\(1000\.0 \* SUM\(critical_met\) \/ NULLIF\(SUM\(critical_assessed\), 0\)\) \/ 10\s+END as criticalCompliance/
        );
        expect(src).not.toMatch(
            /ROUND\(100\.0 \* SUM\(critical_met\) \/ NULLIF\(SUM\(critical_assessed\), 0\), 1\)/
        );
    });

    test('the SQL expression: 1 999 of 2 000 → 99.9, all met → 100', () => {
        // The same arithmetic, evaluated in JS.
        const floorPct = (met, assessed) => Math.floor((1000 * met) / assessed) / 10;
        expect(floorPct(1999, 2000)).toBe(99.9);
        expect(floorPct(199, 200)).toBe(99.5);
        expect(floorPct(2000, 2000)).toBe(100);
    });
});

describe('the department brief colours a % on the value it prints', () => {
    test('a % at 79.96 prints 80,0 and is coloured as 80', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/config/database', () => ({}));
            const svc = require('../../src/services/DeptBriefService');
            const { cell } = svc;
            expect(typeof cell).toBe('function');
            const thresholds = { good: 80, warn: 50 };
            const shown = cell(79.96, { unit: 'pct', thresholds });
            const reached = cell(80, { unit: 'pct', thresholds });
            expect(shown.text.en).toBe('80%');
            expect(shown.color).toBe(reached.color);
        });
    });

    test('frNum / enNum and the colour use displayedValue', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/services/DeptBriefService.js'), 'utf8');
        expect(src).toMatch(/return String\(displayedValue\(Number\(n\), 1\)\)\.replace/);
        expect(src).toMatch(
            /_colorFor\(unit === 'pct' \? displayedValue\(n, 1\) : n, thresholds\)/
        );
    });
});

test('dashboard tiles colour on the one-decimal value fmtPct prints', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/dashboard.js'), 'utf8');
    const fn = src.slice(src.indexOf('function getColorForValue('));
    expect(fn.slice(0, 400)).toMatch(/const shown = Number\(Number\(val\)\.toFixed\(1\)\);/);
    expect(fn.slice(0, 400)).toMatch(/if \(shown >= goodThresh\)/);
});
