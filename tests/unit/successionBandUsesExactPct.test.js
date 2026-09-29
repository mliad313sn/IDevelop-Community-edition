'use strict';

/**
 * 89.5 % of a critical role's benchmark was published as "Ready Now".
 *
 * `scoreRows` rounded the readiness percentage to an integer, and
 * `bandFromReadiness` then compared that ROUNDED value against 90 and 70. So
 * everything in [89.5, 90) banded as ready_now and everything in [69.5, 70)
 * as ready_1_2y.
 *
 *   true 89.5  -> rounds to 90 -> ready_now    (should be ready_1_2y)
 *   true 89.75 -> rounds to 90 -> ready_now    (should be ready_1_2y)
 *   true 69.5  -> rounds to 70 -> ready_1_2y   (should be ready_3y)
 *
 * "Ready Now" means "can step into the post today", and crossing into it fires
 * continuity.successor_ready at the plan owner (LmsService._reevaluateSuccessors).
 * The drift was already live, just not yet across a boundary: readinessForRole
 * returned 97 for people ReadinessService and v_employee_assessment_coverage
 * both scored 96.8 and 96.7.
 *
 * scoreRows now carries `pctExact` alongside the rounded `pct`; the rounded one
 * is for display, the exact one decides the band. Also removed a second,
 * unreferenced `bandFromReadiness` in LmsService that had NO coverage floor —
 * a live copy of the pre-floor rule sitting one autocomplete from the
 * succession path.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ContinuityService = require('../../src/services/ContinuityService');

describe('the band is chosen from the exact percentage, not the rounded one', () => {
    const B = (p, cov = 100) => ContinuityService.bandFromReadiness(p, cov);

    test.each([
        [89.0, 'ready_1_2y'],
        [89.5, 'ready_1_2y'], // rounded to 90 this said ready_now
        [89.75, 'ready_1_2y'],
        [89.999, 'ready_1_2y'],
        [90.0, 'ready_now'],
        [69.0, 'ready_3y'],
        [69.5, 'ready_3y'], // rounded to 70 this said ready_1_2y
        [69.999, 'ready_3y'],
        [70.0, 'ready_1_2y'],
    ])('%s%% -> %s', (pct, expected) => {
        expect(B(pct)).toBe(expected);
    });

    test('the coverage floor still applies at the top band', () => {
        expect(B(95, 100)).toBe('ready_now');
        expect(B(95, 79)).toBe('ready_1_2y'); // measured too thinly to promise
        expect(B(95, 80)).toBe('ready_now'); // exactly on the floor
    });

    test('nothing measured is still the lowest band, not an error', () => {
        expect(B(null)).toBe('ready_3y');
    });
});

describe('scoreRows exposes both numbers, and they mean different things', () => {
    test('pct is rounded for display, pctExact is not', () => {
        // 179 of 200 points = 89.5 %
        const rows = [];
        for (let i = 0; i < 50; i++)
            rows.push({ skillId: i, skillName: 's', required: 4, current: 4, assessedLevel: 4 });
        const out = ContinuityService.scoreRows(rows);
        expect(out.pct).toBe(100);
        expect(out.pctExact).toBe(100);

        // now a set that lands on a boundary: 7 of 8 points = 87.5 %
        const edge = ContinuityService.scoreRows([
            { skillId: 1, skillName: 'a', required: 4, current: 4, assessedLevel: 4 },
            { skillId: 2, skillName: 'b', required: 4, current: 3, assessedLevel: 3 },
        ]);
        expect(edge.pct).toBe(88); // display rounds
        expect(edge.pctExact).toBeCloseTo(87.5, 5); // banding does not
        expect(ContinuityService.bandFromReadiness(edge.pctExact, edge.coveragePct)).toBe(
            'ready_1_2y'
        );
    });

    test('nothing measured leaves both null', () => {
        const out = ContinuityService.scoreRows([
            { skillId: 1, skillName: 'a', required: 3, current: null, assessedLevel: null },
        ]);
        expect(out.pct).toBeNull();
        expect(out.pctExact).toBeNull();
    });
});

describe('every band call site reads the exact value', () => {
    const cont = read('src/services/ContinuityService.js').replace(/\s+/g, ' ');
    const lms = read('src/services/LmsService.js').replace(/\s+/g, ' ');

    test('no caller bands from the rounded pct any more', () => {
        expect(cont).not.toMatch(/bandFromReadiness\(c\.pct,/);
        expect(cont).not.toMatch(/bandFromReadiness\(r\.pct,/);
        expect(lms).not.toMatch(/bandFromReadiness\(rd\.pct,/);
        expect(cont).toMatch(/bandFromReadiness\(c\.pctExact \?\? c\.pct,/);
        expect(cont).toMatch(/bandFromReadiness\(r\.pctExact \?\? r\.pct,/);
        expect(lms).toMatch(/bandFromReadiness\(rd\.pctExact \?\? rd\.pct,/);
    });

    test('confidence combines fit with coverage (T6), not fit alone', () => {
        // Re-audit T6: confidence was fit alone (every candidate at fit/100); it
        // is now fit × coverage so thin evidence lowers it. It is a stored
        // presentation value, not a threshold input.
        expect(cont).toMatch(/confidenceFrom\(r\.pct, r\.coveragePct\)/);
    });

    test('LmsService no longer defines a floor-less band function of its own', () => {
        expect(() => require('../../src/services/LmsService')).not.toThrow();
        expect(lms).not.toMatch(/function bandFromReadiness\(pct\) \{/);
        // the only banding it does is the shared one, WITH coverage
        expect(lms).toMatch(/Cont\.bandFromReadiness\(/);
    });
});
