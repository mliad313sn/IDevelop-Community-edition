'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * A JS `//` comment inside a SQL template literal is a PostgreSQL syntax error
 * (PostgreSQL comments with `--`). It cannot be caught by linting, by `node
 * --check`, or by any test that does not execute that exact query — and this
 * codebase deliberately swallows failures on best-effort paths, so such a query
 * fails silently for as long as nobody looks.
 *
 * This was not hypothetical: while fixing AMDEC L2-11 a comment was inserted inside
 * the 9-box placement-mirror query, and the whole suite stayed green while every
 * approval logged "talent_placements mirror failed: syntax error at or near //"
 * and wrote nothing. The mirror is exactly the surface AMDEC L2-1 had just been
 * fixed to make trustworthy.
 *
 * The guard is cheap and covers every query in the codebase at once.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../src');
const SQL_KEYWORD =
    /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WHERE|FROM|JOIN|ORDER BY|GROUP BY|VALUES|SET)\b/i;

function jsFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) jsFiles(p, out);
        else if (entry.name.endsWith('.js')) out.push(p);
    }
    return out;
}

describe('no JS comment ever sits inside a SQL string', () => {
    test('every SQL template literal in src/ is free of //', () => {
        const offenders = [];
        for (const file of jsFiles(SRC)) {
            const src = fs.readFileSync(file, 'utf8');
            for (const lit of src.match(/`[^`]*`/g) || []) {
                if (!SQL_KEYWORD.test(lit)) continue;
                // Ignore ${...} interpolations, and `://` inside a URL.
                const stripped = lit.replace(/\$\{[^}]*\}/g, '');
                const hit = stripped.match(/(^|[^:])\/\/[^\n]*/);
                if (!hit) continue;
                // A literal that is prose in a comment block, not a query, will not
                // start with a SQL verb once trimmed.
                const firstWord = lit.replace(/^`\s*/, '').split(/\s+/)[0] || '';
                if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)$/i.test(firstWord)) continue;
                offenders.push(`${path.relative(SRC, file)}: ${hit[0].trim().slice(0, 70)}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

/**
 * Third member of the family: a legal SQL `--` comment that still breaks the
 * query, because the compat layer REWRITES the SQL around it.
 *
 * `_translate` runs `expandGroupBy`, which re-emits non-aggregated SELECT items
 * into the GROUP BY clause for PostgreSQL's strict mode. A `--` comment sitting
 * in the SELECT list is carried along, and once inside GROUP BY it comments out
 * everything after it on that line — including the HAVING:
 *
 *   GROUP BY e.site_name, -- Role-ready means ready for the ROLE (all requir...
 *       -- critical met)
 *   HAVING COUNT(e.employee_id) > 0        <- now unreachable
 *   => syntax error at or near "HAVING"
 *
 * The comment is valid SQL and the untranslated query is valid; only the
 * rewritten form is broken, so nothing catches it until that endpoint runs.
 * Annotate ABOVE the template literal instead.
 */
/*
 * NOTE — there is deliberately NO static guard here for the third variant.
 *
 * `expandGroupBy` only drags a SELECT-list comment into the GROUP BY when the
 * grouping column MATCHES a select item, and the grouping column is often an
 * interpolation (`GROUP BY e.${groupCol}`) whose value is unknowable from the
 * source text. Substituting a placeholder stops reproducing the expansion, so a
 * static probe passes while the real query fails — I built exactly that guard,
 * mutation-tested it, and it did not bite. A test that cannot fail is worse than
 * no test, because it reads as coverage.
 *
 * That variant is covered by EXECUTION instead, in
 * tests/unit/readinessCountsAreCanonical.test.js, which runs the affected model
 * queries against the database.
 */

/**
 * The same family, one level up: an annotation that breaks the FILE.
 *
 * Documenting the ORDER BY fix in DeptAnalyticsController, a backtick was written
 * inside a `--` comment that itself sits inside a SQL template literal. The
 * backtick closed the literal, and the file stopped parsing — taking out every
 * suite that transitively requires the route registry (11 failures in
 * notificationKinds alone, none of which mention the real cause).
 *
 * Requiring a file only proves the files some test happens to touch. Parsing
 * every file in src/ proves all of them, and costs a fraction of a second.
 */
describe('every source file parses', () => {
    test('no file in src/ has a syntax error', () => {
        const vm = require('vm');
        const offenders = [];
        for (const file of jsFiles(SRC)) {
            const src = fs.readFileSync(file, 'utf8');
            try {
                // Compile only — nothing is executed, so no side effects and no
                // dependency on a database, a port, or an environment variable.
                new vm.Script(src, { filename: file });
            } catch (e) {
                offenders.push(`${path.relative(SRC, file)}: ${e.message}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
