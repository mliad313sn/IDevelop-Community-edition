'use strict';

/**
 * J7 — a fit/level trend bridged its null gaps into a fabricated line.
 *
 * A daily/monthly trend where a null point means "could not be measured that
 * period" must NOT connect across the gap: Chart.js `spanGaps: true` draws a
 * straight line over the missing data, inventing continuity the null exists to
 * deny. The role benchmark fit-trend, the department monthly-level trend and the
 * employee monthly confirmed-level line are all dense series where a null is
 * missing data — they now use spanGaps:false.
 *
 * The employee "readiness at cycle" line is a SPARSE event series (a value only
 * at each cycle close), where connecting the real cycle measurements is intended,
 * so it deliberately keeps spanGaps — this test does not touch it.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('dense trends break at a null instead of bridging it', () => {
    test('the benchmark role fit-trend uses spanGaps:false on both datasets', () => {
        const v = read('views/pages/benchmark/role.ejs');
        // both the fit and coverage datasets
        const falses = (v.match(/spanGaps:\s*false/g) || []).length;
        expect(falses).toBeGreaterThanOrEqual(2);
        expect(v).not.toMatch(/spanGaps:\s*true/);
    });

    test('the department monthly-level trend uses spanGaps:false', () => {
        const v = read('views/pages/reports/dept-analytics.ejs');
        expect(v).toMatch(/spanGaps:\s*false/);
        expect(v).not.toMatch(/spanGaps:\s*true/);
    });

    test('the employee monthly confirmed-level line uses spanGaps:false', () => {
        const v = read('views/pages/employees/progress.ejs');
        // the dense monthly avgLevel line no longer bridges
        expect(v).toMatch(/Avg confirmed level \(monthly\)[\s\S]{0,400}spanGaps:\s*false/);
    });
});
