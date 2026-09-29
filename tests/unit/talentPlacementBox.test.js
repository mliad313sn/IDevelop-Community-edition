'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L2-1 (criticality 700) — the 9-box mirror wrote a value nothing can read.
 *
 * `nine_box_evaluations.box` is a SMALLINT 1-9 used for display. `talent_placements
 * .box` is TEXT, and every consumer parses it as "{potential}-{performance}":
 * BiasDetectionService.boxScore, DEIService, CopilotService, ReportDataService,
 * TalentDepthService. The approval mirror passed the integer.
 *
 * Proven by probe on a real approval (rolled back): the column stored "4" and
 * `boxScore("4")` returned 0 instead of 4 — so every employee placed through the
 * 9-box dragged the cohort mean down and the bias engine fabricated or masked
 * discrimination alerts. After the fix the same approval stored "high-medium" and
 * the score went 0 -> 5, the true value.
 *
 * Scoring rationale: G=7 (HR and the executive committee act on a false bias and
 * DEI reading), O=10 (every single approval), D=10 (the numbers look plausible —
 * nothing anywhere reports a parse failure, because there is none: the split just
 * silently yields undefined).
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('the placement mirror speaks the vocabulary its consumers read', () => {
    const svc = read('src/services/NineBoxService.js');

    test('the mirror writes "{potential}-{performance}", not the display integer', () => {
        expect(svc).toMatch(
            /const placementBox = `\$\{approved\.potential\}-\$\{approved\.performance\}`/
        );
        expect(svc).toMatch(/\[\s*approved\.employeeId,\s*cyc\.id,\s*placementBox,\s*tier,\s*src,/);
    });

    test('the integer is no longer passed as the placement box', () => {
        // `approved.box` may still be read for the display label; it must not reach
        // the talent_placements INSERT.
        const insert = svc.slice(
            svc.indexOf('INSERT INTO talent_placements'),
            svc.indexOf('INSERT INTO talent_placements') + 900
        );
        expect(insert).not.toMatch(/cyc\.id, approved\.box/);
    });

    test('an unknown combination fails loudly instead of storing something unreadable', () => {
        expect(svc).toMatch(
            /if \(!Object\.prototype\.hasOwnProperty\.call\(BOX_LABELS, placementBox\)\)/
        );
        expect(svc).toMatch(/throw new Error\(\s*`invalid placement box/);
    });

    test('BOX_LABELS really is the nine-key vocabulary being validated against', () => {
        for (const box of [
            'high-high',
            'high-medium',
            'high-low',
            'medium-high',
            'medium-medium',
            'medium-low',
            'low-high',
            'low-medium',
            'low-low',
        ]) {
            expect(svc).toMatch(new RegExp(`'${box}':`));
        }
    });
});

describe('the repair migration inverts computeBox exactly', () => {
    const mig = read('db/postgres/86_talent_placement_box_vocabulary.sql');

    test('it converts only rows still holding a bare digit', () => {
        expect(mig).toMatch(/WHERE box ~ '\^\[1-9\]\$'/);
    });

    test('it inverts box = potential * 3 + performance + 1', () => {
        // Verified by execution against Postgres for all nine boxes.
        expect(mig).toMatch(/\(\(box::int - 1\) \/ 3\) \+ 1/);
        expect(mig).toMatch(/\(\(box::int - 1\) % 3\) \+ 1/);
    });

    test('the arithmetic matches computeBox in the service', () => {
        const svc = read('src/services/NineBoxService.js');
        expect(svc).toMatch(/BAND\[potential\] \* 3 \+ BAND\[performance\] \+ 1/);
        expect(svc).toMatch(/const BAND = \{ low: 0, medium: 1, high: 2 \}/);
        expect(mig).toMatch(/ARRAY\['low', 'medium', 'high'\]/);
    });
});
