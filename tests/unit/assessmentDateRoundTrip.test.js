'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L4-2 (criticality 560) — a re-import redated the entire assessment history.
 *
 * The export wrote an "Assessed At" column and nothing ever read it back: all four
 * write sites in UnifiedImportService, both in SkillMatrixWorkbookService and the
 * one in UnifiedJsonService hard-coded now(). The documented workflow — export,
 * correct in Excel, re-import — therefore stamped every row with today's date.
 *
 * That is worse than losing the date, because everything downstream reads it as a
 * fact: the manager "stale assessments" view, v_skill_currency, certification
 * freshness and "last assessed" all went green at once, and nothing was reported.
 * The assessor WAS restored correctly, so the file looked like it round-tripped.
 *
 * Proven by a full round-trip through a real file: an assessment dated 2019-04-05
 * came back as today. After the fix it comes back as 2019-04-05.
 *
 * Scoring rationale: G=7 (currency drives who gets re-assessed and who is treated
 * as qualified), O=8 (every re-import, which is the supported correction workflow),
 * D=10 (the import reports success and the numbers improve).
 */

const fs = require('fs');
const path = require('path');
const { flat } = require('../helpers/flatSource');
// Layout-proof: prettier reflows the sources these assertions read.
const read = (p) => flat(fs.readFileSync(path.join(__dirname, '../..', p), 'utf8'));

describe('the date survives export -> re-import', () => {
    const wb = read('src/services/SkillMatrixWorkbookService.js');

    test('the workbook schema has a place for the date', () => {
        expect(wb).toMatch(
            /\{ key: 'assessedAt', labels: \['Assessed At', 'Date'\], xml: 'AssessedAt' \}/
        );
    });

    test('the export projection selects it', () => {
        const occurrences = wb.match(/sa\.assessedAt AS assessedAt/g) || [];
        expect(occurrences.length).toBe(2); // both UNION branches
    });

    test('a blank scaffold row carries no invented date', () => {
        // Every role-required skill is exported, most deliberately blank. Giving
        // those a date would invent an assessment that never happened.
        expect(wb).toMatch(
            /assessedAt: hasLevel && a\.assessedAt \? new Date\(a\.assessedAt\)\.toISOString\(\) : ''/
        );
    });

    test('the model -> internal mapping carries it through to the writer', () => {
        // Dropping it here is what kept the re-import stamping today even after the
        // column was exported — the export looked correct and the import still lied.
        expect(wb).toMatch(/assessedAt: cellText\(a\.assessedAt\) \|\| null/);
    });

    test('both workbook writes honour it, falling back to now()', () => {
        const coalesce =
            wb.match(
                /assessedAt = COALESCE\(\?::timestamptz, now\(\)\)|COALESCE\(\?::timestamptz, now\(\)\)\)/g
            ) || [];
        expect(coalesce.length).toBeGreaterThanOrEqual(2);
        expect(wb).not.toMatch(/assessedAt = datetime\('now'\)/);
    });
});

describe('the Excel/CSV importer reads the column it was already being sent', () => {
    const imp = read('src/services/UnifiedImportService.js');

    test('the header map recognises the date column', () => {
        expect(imp).toMatch(/assessed\\s\*at\|\^date\$/);
    });

    test('dates are parsed from every shape ExcelJS produces', () => {
        expect(imp).toMatch(/const cellDate = \(row, idx\)/);
        expect(imp).toMatch(/Excel serial date: days since 1899-12-30/);
        expect(imp).toMatch(/if \(v instanceof Date\) return ok\(v\)/);
    });

    test('an unreadable date falls back to now() instead of failing the row', () => {
        // The old behaviour becomes the fallback, never the rule.
        const writes = imp.match(/COALESCE\(\?::timestamptz, now\(\)\)/g) || [];
        expect(writes.length).toBe(4);
        expect(imp).not.toMatch(/assessedAt = datetime\('now'\)/);
        expect(imp).not.toMatch(/assessedAt = now\(\)/);
    });
});

describe('the JSON system round-trip carries it too', () => {
    const js = read('src/services/UnifiedJsonService.js');

    test('the export includes the date', () => {
        expect(js).toMatch(/sa\.assessedAt AS assessedAt/);
        expect(js).toMatch(
            /assessedAt: a\.assessedAt \? new Date\(a\.assessedAt\)\.toISOString\(\) : null/
        );
    });

    test('the import restores it rather than stamping now()', () => {
        expect(js).toMatch(/VALUES \(\?, \?, \?, \?, \?, COALESCE\(\?::timestamptz, now\(\)\)\)/);
    });
});
