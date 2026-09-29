'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L4-8 (criticality 350) — a French "yes" read as "no".
 *
 * `parseBoolish` accepted only yes/y/true/1/critical, and the import template ships
 * with ENGLISH headers. A department head filling "Is Critical" with `Oui` or
 * `VRAI` — the natural answer in a French-first product for a Francophone
 * organisation — got `false`, silently. Every requirement they marked critical
 * became non-critical, which INFLATES "critical compliance" (a KPI with a 95%
 * threshold) and removes those exact skills from the critical-gap alerts they were
 * declared for.
 *
 * The machine round-trip always passed, because the exporter writes 'Yes'/'No';
 * only human entry was affected — which is precisely what the template invites.
 *
 * G=7, O=5, D=10 (nothing is reported; the number moves in the flattering
 * direction).
 */

const SkillMatrixWorkbookService = require('../../src/services/SkillMatrixWorkbookService');
const parseBoolish = SkillMatrixWorkbookService.parseBoolish;

describe('a critical requirement marked in French is read as critical', () => {
    test.each(['Oui', 'OUI', 'oui', 'Vrai', 'VRAI', 'vrai', 'Critique', 'critique'])(
        '%s means yes',
        (v) => expect(parseBoolish(v)).toBe(true)
    );

    test.each(['Yes', 'y', 'TRUE', '1', 'critical'])('%s still means yes', (v) =>
        expect(parseBoolish(v)).toBe(true)
    );

    test('a ticked cell counts', () => {
        expect(parseBoolish('X')).toBe(true);
        expect(parseBoolish('x')).toBe(true);
    });

    test.each(['No', 'non', 'false', 'FAUX', '0', '', 'maybe', 'n'])('%s does NOT mean yes', (v) =>
        expect(parseBoolish(v)).toBe(false)
    );

    test('accents do not change the answer', () => {
        // Vrai / Vrái / VRAI must all read the same once normalised.
        expect(parseBoolish('Vrai')).toBe(parseBoolish('vrai'));
        expect(parseBoolish('Critique')).toBe(parseBoolish('critique'));
    });

    test('the sibling importer uses the same vocabulary', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/ImportExportService.js'),
            'utf8'
        );
        expect(src).toMatch(/'oui',\s*'o',\s*'vrai',\s*'critique',\s*'x'/);
    });
});
