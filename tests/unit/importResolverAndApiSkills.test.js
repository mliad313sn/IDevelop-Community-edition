'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L4-3 (criticality 480) and L4-5 (400) — the soft-retired twin problem.
 *
 * Merged duplicate skills are soft-retired (`skills.is_active = false`) so old
 * assessments stay readable. Two places ignored that:
 *
 * L4-3  The workbook importer resolved skills with a bare
 *       `SELECT id FROM skills WHERE name = ?` — no isActive, no ORDER BY, no
 *       LIMIT. PostgreSQL may return ANY matching row. Verified on this
 *       catalogue: "Change Management" has three rows, two of them retired, and
 *       "dilution" and "PM compliance" have four each. The role requirement or
 *       assessment therefore landed on a skill no screen displays while the real
 *       one on the live twin stayed untouched — the role silently gained a
 *       phantom requirement and a retired skill came back to life in the data.
 *       The correct resolver already existed in utils/importSkillResolver and was
 *       already wired into the three OTHER importers; only this one was missed.
 *       G=8, O=6, D=10.
 *
 * L4-5  `/api/v1/skills` had no isActive predicate and did not expose the flag,
 *       so a Power BI model received 1 142 skills where the JSON export publishes
 *       1 126 — the API contradicted the export — joined to 55 domains of which
 *       49 are inactive, with no way for the consumer to filter. `count()` was
 *       unfiltered too, so the pagination total did not describe the pages.
 *       G=5, O=8, D=10.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('the workbook importer resolves skills the same way as every other importer', () => {
    const wb = read('src/services/SkillMatrixWorkbookService.js');

    test('it uses the shared resolver', () => {
        expect(wb).toMatch(/require\('\.\.\/utils\/importSkillResolver'\)/);
        expect(wb).toMatch(/await resolveActiveSkillByName\(db, req\.skillName, req\.domainName\)/);
        expect(wb).toMatch(/await resolveActiveSkillByName\(db, a\.skillName, a\.domainName\)/);
    });

    test('no bare name lookup remains on the two write paths', () => {
        expect(wb).not.toMatch(
            /if \(!skill\) skill = await db\.get\('SELECT id FROM skills WHERE name = \?'/
        );
    });

    test('a retired-only name is reported as retired, never silently skipped as missing', () => {
        expect(wb).toMatch(/Requirement: skill "\$\{req\.skillName\}" is retired \(soft-deleted\)/);
        expect(wb).toMatch(/Assessment: skill "\$\{a\.skillName\}" is retired \(soft-deleted\)/);
    });

    test('the resolver is deterministic and active-only', () => {
        // Verified against the live catalogue: "Change Management" -> 334 (active),
        // never 341 or 780 (retired). A retired-only name resolves to null.
        const res = read('src/utils/importSkillResolver.js');
        expect(res).toMatch(
            /isActive = true\s*\n?\s*ORDER BY s\.id LIMIT 1|isActive = true ORDER BY id LIMIT 1/
        );
    });
});

describe('the API skills feed agrees with the export', () => {
    const repo = read('src/api/v1/repository.js');
    const idx = read('src/api/v1/index.js');

    test('retired skills are excluded by default', () => {
        expect(repo).toMatch(/const where = includeInactive \? '' : ' WHERE s\.is_active = true'/);
    });

    test('every row carries isActive, so a consumer never has to guess', () => {
        expect(repo).toMatch(/s\.is_active AS isActive/);
        expect(repo).toMatch(/isActive: bool\(r\.isActive\)/);
    });

    test('count applies the same predicate as list', () => {
        // Otherwise the pagination envelope reports a total that does not match
        // what the pages actually contain.
        expect(repo).toMatch(/async count\(\{ includeInactive = false \} = \{\}\)/);
        expect(repo).toMatch(
            /FROM skills s\$\{includeInactive \? '' : ' WHERE s\.is_active = true'\}/
        );
    });

    test('the route threads one flag into both calls', () => {
        expect(idx).toMatch(
            /const includeInactive = String\(req\.query\.includeInactive \|\| ''\)\.toLowerCase\(\) === 'true'/
        );
        // The RULE — one flag threaded into the list call — not the object
        // literal's line breaks. Prettier expands the argument onto four lines
        // once it overflows, and the single-line pattern then failed on a call
        // that had not changed.
        expect(idx).toMatch(
            /SkillsRepository\.list\(\{\s*limit:\s*req\.query\.limit,\s*offset:\s*req\.query\.offset,\s*includeInactive,?\s*\}\)/
        );
        expect(idx).toMatch(/SkillsRepository\.count\(\{ includeInactive \}\)/);
    });
});
