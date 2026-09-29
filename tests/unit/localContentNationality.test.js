'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L3-1 (criticality 720), L3-7 (432) and L3-11 (189).
 *
 * The local-content report is the artifact handed to the ministry, so a wrong
 * number here is a regulatory statement, not a cosmetic defect.
 *
 * L3-1  `employees.nationality` is free text and was compared to the country's
 *       French DISPLAY NAME. Nothing a human types matches that except the exact
 *       French spelling: not "Ivory Coast", not "Ivoirien", not "CI". Measured
 *       before the fix: 0 nationals and 71 expatriates out of 77, while 55
 *       employees are Ivorian and 41 of them work on Ivorian sites. The
 *       "positions to nationalise" list proposed nationalising 71 posts, most
 *       already held by nationals. After the fix: 41 nationals, 30 expatriates,
 *       6 unspecified, and 30 positions listed.
 * L3-7  The ratio divided by the whole headcount, so an unrecorded nationality
 *       read as a nationalisation shortfall — an absence of measurement presented
 *       as a result — and the CSV had Headcount != Nationals + Expatriates.
 * L3-11 A site with no country and no fallback setting classed its entire staff
 *       as expatriate in silence. It is now "unspecified".
 *
 * Scoring rationale for L3-1: G=8 (a false regulatory declaration), O=10 (every
 * run — the comparison can essentially never succeed), D=9 (0% local content
 * looks like a real compliance problem, not like a bug).
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('a nationality is resolved to a country, not to a string', () => {
    const ctrl = read('src/controllers/LocalContentController.js');

    test('the classifier matches through the accepted spellings', () => {
        expect(ctrl).toMatch(/EXISTS \(SELECT 1 FROM country_aliases _ca/);
        expect(ctrl).toMatch(/_ca\.country_id = COALESCE\(_co\.id, _hc\.id\)/);
    });

    test('matching ignores case and accents', () => {
        // "Cote d'Ivoire" must match "Côte d'Ivoire"; "IVOIRIEN" must match "Ivoirien".
        expect(ctrl).toMatch(
            /lower\(unaccent\(_ca\.alias\)\) = lower\(unaccent\(btrim\(e\.nationality\)\)\)/
        );
    });

    test('the old display-name comparison is gone everywhere, including the peer count', () => {
        expect(ctrl).not.toMatch(/lower\(e\.nationality\) = lower\(/);
        expect(ctrl).not.toMatch(/lower\(n\.nationality\) = lower\(/);
        expect(ctrl).toMatch(/_ca2\.alias/); // the peer subquery resolves the same way
    });

    test('the home-country setting is resolved to a country id, not compared as text', () => {
        expect(ctrl).toMatch(/async _resolveCountryId\(home\)/);
        expect(ctrl).toMatch(/const homeCountryId = await this\._resolveCountryId\(home\)/);
    });

    test('a site with no country yields "unspecified", never "expatriate"', () => {
        expect(ctrl).toMatch(/WHEN COALESCE\(_co\.id, _hc\.id\) IS NULL THEN NULL/);
    });
});

describe('the ratio states its own base', () => {
    const ctrl = read('src/controllers/LocalContentController.js');
    // Whitespace-normalised, so prettier reflowing a line across several does not
    // break a logic assertion (the pre-commit hook reformats staged files).
    const ctrlFlat = ctrl.replace(/\s+/g, ' ');

    test('the percentage is computed on the population whose nationality is known', () => {
        expect(ctrl).toMatch(/kpi\.specified = kpi\.nationals \+ kpi\.expats/);
        expect(ctrlFlat).toMatch(
            /kpi\.specified \? Math\.round\(\(100 \* kpi\.nationals\) \/ kpi\.specified\) : null/
        );
    });

    test('every group row carries its unspecified count', () => {
        expect(ctrl).toMatch(/count\(\*\) FILTER \(WHERE \$\{NAT\} IS NULL\)::int AS unspecified/);
    });

    test('the CSV columns make Headcount = Nationals + Expatriates + Unspecified auditable', () => {
        expect(ctrlFlat).toMatch(/'Unspecified', 'Specified', 'National % \(of specified\)'/);
        // An empty base must not be rendered as 0% — that is the same "absence
        // presented as a result" the fix is about.
        expect(ctrl).toMatch(/: 'n\/a'/);
    });
});

describe('the alias table', () => {
    const mig = read('db/postgres/85_country_aliases.sql');

    test('every country always accepts its own ISO code and display name', () => {
        expect(mig).toMatch(/CROSS JOIN LATERAL \(VALUES \(c\.code\), \(c\.name\)\)/);
    });

    test('curated spellings cover the English name and both demonyms', () => {
        for (const alias of ['Ivory Coast', 'Ivoirien', 'Ivorian', 'Burkinabè', 'South Africa']) {
            expect(mig).toContain(alias);
        }
    });

    test('curated rows are seeded only for countries this installation has', () => {
        expect(mig).toMatch(/JOIN countries c ON lower\(c\.code\) = lower\(a\.code\)/);
    });

    test('re-running the migration cannot duplicate an alias', () => {
        const guards = mig.match(/NOT EXISTS \(\s*SELECT 1 FROM country_aliases ca/g) || [];
        expect(guards.length).toBe(2);
        expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS country_aliases/);
    });
});
