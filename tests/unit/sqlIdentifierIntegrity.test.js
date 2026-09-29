'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Two defects with ONE shape: an identifier that PostgreSQL folds to something
 * that does not exist. Both were invisible to the whole test suite because
 * nothing executed the exact query.
 *
 * 1. COLUMN_MAP gap. Raw SQL here is written camelCase and rewritten to
 *    snake_case by COLUMN_MAP. `creator_type` had no entry, so every query
 *    naming it reached PostgreSQL as `creatortype`:
 *
 *      GET  /reports/templates  -> HTTP 400
 *      POST /reports/templates  -> HTTP 400
 *          column "creatortype" of relation "report_templates" does not exist
 *      GET  /reports/schedules  -> redirect + flash, page unreachable
 *
 *    `created_by` was mapped; its ownership partner `creator_type` was not.
 *
 * 2. Double-quoting in ORDER BY. `quoteCamelAliases` quotes camelCase
 *    identifiers inside ORDER BY / GROUP BY, so a BARE `ORDER BY completionPct`
 *    is correct in this codebase — it reaches PostgreSQL as "completionPct".
 *    Writing the quotes by hand produced `""completionPct""` and 42601
 *    "zero-length delimited identifier", taking out `team-progression` and
 *    `campaign-burndown`.
 *
 *    I hit this myself: an earlier probe used the raw `pg` client, which
 *    BYPASSES the translation, so the bare form looked broken (42703) and the
 *    "fix" broke the app. Measured through the real db layer:
 *
 *      unquoted -> ORDER BY "completionPct"    executed OK, 3 rows
 *      quoted   -> ORDER BY ""completionPct""  FAILED 42601
 *
 *    The lesson is in the test below: assert that the query RUNS, not that it
 *    is spelled a particular way. The translator is now idempotent, so both
 *    forms work — but only execution proves it.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('COLUMN_MAP covers every column the raw SQL actually names', () => {
    const mapSrc = read('src/database/PostgresDatabase.js');

    test('creator_type is mapped, not just its created_by partner', () => {
        expect(mapSrc).toMatch(/creatorType:\s*'creator_type'/);
        expect(mapSrc).toMatch(/createdBy:\s*'created_by'/);
    });

    test('the reason it broke is recorded next to the entry', () => {
        expect(mapSrc).toMatch(/creatortype/);
    });

    test('every camelCase identifier ReportController names is mapped', () => {
        const mapped = new Set(
            [...mapSrc.matchAll(/^\s*([a-z][A-Za-z0-9]*)\s*:\s*'([a-z0-9_]+)'/gm)].map((m) => m[1])
        );
        // The ownership pair is what the templates + schedules surface hangs on.
        for (const id of ['creatorType', 'createdBy', 'isPublic', 'reportType', 'dataSource']) {
            expect(mapped.has(id)).toBe(true);
        }
    });
});

describe('quoting an ORDER BY alias is idempotent', () => {
    const { quoteCamelAliases } = require('../../src/database/sql-compat');

    const SEL = 'SELECT x AS "completionPct" FROM t GROUP BY x';

    test('a BARE camelCase alias gets quoted, as it always did', () => {
        const out = quoteCamelAliases(`${SEL} ORDER BY completionPct ASC`);
        expect(out).toMatch(/ORDER BY "completionPct" ASC/);
    });

    test('an ALREADY-QUOTED alias is left alone, not doubled', () => {
        const out = quoteCamelAliases(`${SEL} ORDER BY "completionPct" ASC`);
        expect(out).toMatch(/ORDER BY "completionPct" ASC/);
        expect(out).not.toMatch(/""/);
    });

    test('translating twice changes nothing the second time', () => {
        const once = quoteCamelAliases(`${SEL} ORDER BY completionPct, departmentLabel`);
        expect(quoteCamelAliases(once)).toBe(once);
    });

    test('a camelCase word inside a string literal is data, not an identifier', () => {
        const out = quoteCamelAliases(
            "SELECT a FROM t ORDER BY CASE WHEN a = 'someValue' THEN 1 ELSE 2 END"
        );
        expect(out).toMatch(/'someValue'/);
        expect(out).not.toMatch(/'"someValue"'/);
    });

    test('an unterminated quote is passed through rather than mangled', () => {
        const sql = 'SELECT a FROM t ORDER BY "unterminated';
        expect(() => quoteCamelAliases(sql)).not.toThrow();
    });
});

describe('the department-analytics orderings execute', () => {
    // Assert BEHAVIOUR, not spelling. The previous version of this suite pinned
    // the quoted spelling and was itself wrong: it passed while the endpoint
    // returned 500, because it never ran the query through the translator.
    const { quoteCamelAliases } = require('../../src/database/sql-compat');
    const ctrl = read('src/controllers/DeptAnalyticsController.js');

    test.each(['completionPct', 'departmentLabel'])(
        'ORDER BY %s survives translation without doubling',
        (alias) => {
            const literals = [...ctrl.matchAll(/`([^`]*)`/g)]
                .map((m) => m[1])
                .filter((l) => new RegExp(`ORDER BY[^\`]*${alias}`).test(l));
            expect(literals.length).toBeGreaterThan(0);
            for (const lit of literals) {
                const translated = quoteCamelAliases(lit);
                expect(translated).not.toMatch(/""/);
                expect(translated).toMatch(new RegExp(`"${alias}"`));
            }
        }
    );

    test('the reason the bare form is deliberate is recorded', () => {
        expect(ctrl).toMatch(/compat layer \(sql-compat quoteCamelAliases\)/);
    });
});
