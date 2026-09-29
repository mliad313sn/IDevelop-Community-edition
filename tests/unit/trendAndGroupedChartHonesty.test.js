'use strict';

/**
 * Re-audit J9 + L4 (rendering honesty on the dashboard charts).
 *
 * J9 — the readiness trend used a CATEGORY x-axis, so a week-long gap between two
 *      snapshots was drawn the same width as one day; and its tooltip showed only
 *      the readiness %, hiding the coverage and the population it was measured
 *      over. The axis is now a linear time scale (ticks forced onto the recorded
 *      days, no adapter needed) and the tooltip carries coverage + measured.
 * L4 — renderGroupedBarChart plotted bare SKILL names under a "gap concentration
 *      by department/service" heading and never said the list was truncated. Each
 *      bar now names the group it belongs to, and a caption states the top-N.
 *
 * No jsdom here — source-shape, whitespace-tolerant (the pre-commit hook reflows).
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const flat = read('public/js/dashboard.js').replace(/\s+/g, ' ');

describe('J9 — the readiness trend is time-scaled and states its coverage', () => {
    test('the x-axis is a linear time scale with ticks forced onto the recorded days', () => {
        expect(flat).toMatch(/const xs = series\.map\(\(d\) => new Date\(d\.date\)\.getTime\(\)\)/);
        expect(flat).toMatch(/type: 'linear'/);
        expect(flat).toMatch(
            /afterBuildTicks: \(axis\) => \{ axis\.ticks = xs\.map\(\(v\) => \(\{ value: v \}\)\); \}/
        );
    });

    test('the data points are {x,y} pairs, not a bare category series', () => {
        expect(flat).toMatch(/data: series\.map\(\(d, i\) => \(\{ x: xs\[i\], y: d\.avg \}\)\)/);
    });

    test('the tooltip carries coverage and measured, not readiness alone', () => {
        expect(flat).toMatch(/I18N\.trendCoverage \|\| 'Coverage'/);
        expect(flat).toMatch(/I18N\.trendMeasured \|\| 'Measured'/);
        expect(flat).toMatch(/const p = series\[c\.dataIndex\] \|\| \{\}/);
    });
});

describe('L4 — the grouped gap chart is attributed and disclosed', () => {
    test('each bar names the department/service it belongs to', () => {
        expect(flat).toMatch(/`\$\{r\.skillName\} · \$\{r\.groupLabel\}`/);
        expect(flat).toMatch(/labelKey: 'label'/);
    });

    test('a truncated list carries a caption', () => {
        expect(flat).toMatch(/const truncated = \(data \|\| \[\]\)\.length >= 10/);
        expect(flat).toMatch(/caption: truncated/);
    });

    test('renderBarChart supports a caption via the title plugin', () => {
        expect(flat).toMatch(/title: options\.caption/);
        expect(flat).toMatch(/position: 'bottom', text: options\.caption/);
    });
});

describe('the new chart strings exist in both locales', () => {
    const en = JSON.parse(read('locales/en/dash.json'));
    const fr = JSON.parse(read('locales/fr/dash.json'));
    test.each(['trend_coverage', 'trend_measured', 'showing_top_gaps'])('%s in FR + EN', (k) => {
        expect(en[k]).toBeTruthy();
        expect(fr[k]).toBeTruthy();
    });
});
