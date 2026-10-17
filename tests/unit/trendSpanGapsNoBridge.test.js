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
    test('the benchmark role fit-trend is a viz line, and every viz line breaks at a null', () => {
        // The trend is drawn by the viz layer (views/partials/viz/chart.ejs):
        // every dataset of a `line` gets spanGaps:false there.
        const v = read('views/pages/benchmark/role.ejs');
        expect(v).toMatch(/id: 'rb-fit-trend'[\s\S]{0,200}kind: 'line'/);
        expect(v).not.toMatch(/spanGaps:\s*true/);
        const viz = read('public/js/viz.js');
        expect(viz).toMatch(/ds\.spanGaps = false;/);
        expect(viz).not.toMatch(/spanGaps\s*[:=]\s*true/);
        const Viz = require('../../public/js/viz.js');
        const cfg = Viz.buildChartConfig({
            kind: 'line',
            labels: ['a', 'b', 'c'],
            series: [
                { key: 'fit', data: [60, null, 70] },
                { key: 'coverage', data: [null, 50, 55] },
            ],
        });
        cfg.data.datasets.forEach((ds) => expect(ds.spanGaps).toBe(false));
        expect(cfg.data.datasets[0].data).toEqual([60, null, 70]);
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
