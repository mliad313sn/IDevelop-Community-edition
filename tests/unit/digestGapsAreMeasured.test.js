'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * The weekly manager digest reported an ABSENCE OF MEASUREMENT as a RESULT.
 *
 * `v_employee_skill_gaps` COALESCEs a missing level to 0, so
 *   gap = required_level - COALESCE(actual, 0)
 * A critical skill requiring level 3 that NOBODY HAS EVER ASSESSED comes back
 * as "gap 3". The digest filtered on `is_critical AND gap > 0` and omitted
 * `is_assessed`, so every unmeasured requirement was mailed to the manager as a
 * proven competence shortfall, in red.
 *
 * Measured on this database before the fix:
 *
 *   critical gaps reported : 303
 *   of those, assessed     : 0        <- not one was real
 *   gap points org-wide    : 3352 reported vs 852 measured
 *
 * After the fix, running the real job: the one manager whose reports carry
 * unmeasured critical skills gets "Critical gaps: 0 · Unmeasured: 145", and
 * the 145 matches what the database attributes to supervised employees.
 *
 * The unmeasured count is REPORTED, not dropped — it is the more actionable
 * signal — but as measurement debt in amber, never as a competence gap in red.
 */

const fs = require('fs');
const path = require('path');
const job = fs.readFileSync(path.join(__dirname, '../../src/jobs/manager-digest.js'), 'utf8');
// Whitespace-normalised: the pre-commit hook (prettier) reflows arguments and
// object literals across lines, so pin the logic, not the layout.
const jobFlat = job.replace(/\s+/g, ' ');

describe('a reported gap is a measured gap', () => {
    test('the gap query requires is_assessed = 1', () => {
        expect(job).toMatch(/g\.is_critical AND g\.gap > 0\s*\n\s*AND g\.is_assessed = 1/);
    });

    test('no gap query counts rows without checking is_assessed', () => {
        const gapQueries = [...job.matchAll(/g\.is_critical AND g\.gap > 0[\s\S]{0,120}/g)].map(
            (m) => m[0]
        );
        expect(gapQueries.length).toBeGreaterThan(0);
        for (const q of gapQueries) expect(q).toMatch(/is_assessed = 1/);
    });

    test('the measured inflation is recorded so nobody re-simplifies the filter', () => {
        expect(job).toMatch(/303/);
        expect(job).toMatch(/3 352|3352/);
    });
});

describe('the unmeasured skills are still reported, separately', () => {
    test('there is a query for critical skills with is_assessed = 0', () => {
        expect(job).toMatch(/g\.is_critical AND g\.is_assessed = 0/);
    });

    test('it has its own total', () => {
        expect(job).toMatch(/unmeasured: unmeasured\.reduce\(/);
    });

    test('it has its own KPI tile, in amber rather than the gap red', () => {
        expect(job).toMatch(/label: 'Non mesuré \/ Unmeasured'/);
        expect(jobFlat).toMatch(/totals\.unmeasured \? '#b45309' : '#15803d'/);
    });

    test('it has its own bilingual section, not folded into the gaps table', () => {
        expect(jobFlat).toMatch(
            /T\.section\( 'Compétences critiques non mesurées', 'Critical skills not yet measured'/
        );
    });

    test('it appears in the plain-text summary too', () => {
        expect(jobFlat).toMatch(/Non mesuré \/ Unmeasured: \$\{totals\.unmeasured\}/);
    });

    test('a team with ONLY unmeasured skills still gets a mail rather than silence', () => {
        expect(jobFlat).toMatch(/!totals\.gaps && !totals\.unmeasured/);
    });
});
