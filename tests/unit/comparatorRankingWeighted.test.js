'use strict';

/**
 * The site labelled "⚠ Worst" was sixth of nine.
 *
 * `getComparatorRadars` ranked groups by an UNWEIGHTED mean of their
 * per-domain means, so every domain got an equal vote regardless of how many
 * assessments stood behind it.
 *
 * Measured on the dev dataset, by site — the domain samples inside a single
 * site range from 7 assessments to 238:
 *
 *   rank  site          mean-of-means   weighted   moves to
 *     3   Lakeside               1.873        1.768        5th
 *     5   Riverside           1.678        1.671        7th
 *     6   Southport           1.567        1.635        9th  <- the real worst
 *     7   Westbrook              1.552        1.871        3rd
 *     9   Stonebridge          1.462        1.761        6th  <- was labelled Worst
 *
 * Five of the nine sites change rank. Stonebridge's seven compliance ratings
 * counted for as much as its 238 operational ones, and a director reading
 * "worst site" was sent to the wrong place entirely — Southport, the genuinely
 * lowest, sat mid-table.
 *
 * Ranking is now weighted by sampleCount, which the query carries for exactly
 * this purpose.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const DashboardModel = HAS_DB ? require('../../src/models/DashboardModel') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('groups are ranked by a sample-weighted average', () => {
    let raw = null;
    beforeAll(async () => {
        raw = await db.all(`SELECT e.siteName AS g, c.category AS dom,
                                   ROUND(AVG(c.level), 2) AS avg, COUNT(*)::int AS n
                              FROM v_domain_capability c
                              JOIN v_employee_details e ON e.employeeId = c.employeeId
                             WHERE e.isActive = 1 AND e.siteName IS NOT NULL
                             GROUP BY 1, 2`);
    });

    const fold = (rows) => {
        const by = {};
        rows.forEach((r) => (by[r.g] = by[r.g] || []).push(r));
        return Object.entries(by).map(([name, ds]) => {
            const n = ds.reduce((t, d) => t + d.n, 0);
            return {
                name,
                meanOfMeans: ds.reduce((t, d) => t + Number(d.avg), 0) / ds.length,
                weighted: ds.reduce((t, d) => t + Number(d.avg) * d.n, 0) / n,
                spread: Math.max(...ds.map((d) => d.n)) / Math.min(...ds.map((d) => d.n)),
            };
        });
    };

    test('the fixture we rely on still exists (guards against a vacuous suite)', () => {
        const g = fold(raw);
        expect(g.length).toBeGreaterThan(2);
        // At least one group must have lopsided domain samples, or weighting
        // changes nothing and this suite proves nothing.
        expect(Math.max(...g.map((x) => x.spread))).toBeGreaterThan(2);
    });

    test('the two rankings genuinely disagree on this data', () => {
        const g = fold(raw);
        const a = [...g].sort((x, y) => y.meanOfMeans - x.meanOfMeans).map((x) => x.name);
        const b = [...g].sort((x, y) => y.weighted - x.weighted).map((x) => x.name);
        expect(a).not.toEqual(b);
        // and specifically: the mean-of-means loser is NOT the weighted loser
        expect(a[a.length - 1]).not.toBe(b[b.length - 1]);
    });

    test('the model labels the weighted loser as Worst, not the unweighted one', async () => {
        const g = fold(raw);
        const byMoM = [...g].sort((x, y) => y.meanOfMeans - x.meanOfMeans);
        const byW = [...g].sort((x, y) => y.weighted - x.weighted);
        const oldWorst = byMoM[byMoM.length - 1].name;
        const trueWorst = byW[byW.length - 1].name;

        // Select the old "worst" so the panel has to name someone else.
        const panels = await DashboardModel.getComparatorRadars({}, { compSite: oldWorst });
        const worstLabel = (panels.bySite || []).find((p) => /Worst/.test(p.label));
        expect(worstLabel).toBeTruthy();
        expect(worstLabel.label).toContain(trueWorst);
        expect(worstLabel.label).not.toContain(oldWorst);
    });

    test('every series carries the sample count it was weighted by', async () => {
        const panels = await DashboardModel.getComparatorRadars({}, {});
        const series = panels.bySite || [];
        expect(series.length).toBeGreaterThan(0);
        for (const s of series) {
            for (const d of s.data) {
                expect(Number.isFinite(Number(d.sampleCount))).toBe(true);
                expect(Number(d.sampleCount)).toBeGreaterThan(0);
            }
        }
    });
});
