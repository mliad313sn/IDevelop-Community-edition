'use strict';

/**
 * A3 — the comparator's "Org Average" reference line was an unweighted mean of
 * per-group means, while the ranking drawn beside it is population-weighted.
 *
 * For each domain the line averaged every group's domain-average equally, so a
 * 7-assessment site counted the same as a 238-assessment one. The reference a
 * director reads to judge "above or below the org" therefore disagreed with the
 * weighted ranking. It is now weighted by sampleCount, exactly like the ranking.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const norm = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\s+/g, ' ');

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
let M;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
    M = require('../../src/models/DashboardModel');
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const isOrg = (x) => /Org Average/.test(x.label);
const isGroup = (x) => !/Org Average|\(Best\)|\(Worst\)|📌/.test(x.label);

suite('the comparator Org Average is population-weighted', () => {
    let org;
    let base; // ALL site groups: [{ groupName, domainName(category), avgLevel, sampleCount }]

    beforeAll(async () => {
        const site = await db.get(
            `SELECT DISTINCT site_name AS s FROM v_employee_details WHERE site_name IS NOT NULL LIMIT 1`
        );
        const res = await M.getComparatorRadars({}, { compSite: site.s });
        org = (res.bySite || []).find(isOrg);
        // Independently reproduce the comparator's per-(site, category) base query
        // over ALL sites — the result only exposes selected/best/worst, so the
        // weighted average cannot be checked from it.
        base = await db.all(
            `SELECT e.site_name AS group_name, c.category AS domain_name,
                    ROUND(AVG(c.level), 2) AS avg_level, COUNT(*)::int AS sample_count
               FROM v_domain_capability c
               JOIN v_employee_details e ON e.employee_id = c.employee_id
              WHERE e.is_active = true AND e.site_name IS NOT NULL
              GROUP BY e.site_name, c.category`
        );
    });

    test('an Org Average dataset was produced (guards against a vacuous test)', () => {
        expect(org).toBeTruthy();
        expect(org.data.length).toBeGreaterThan(0);
        expect(base.length).toBeGreaterThan(2);
    });

    // Weighted vs unweighted mean of the group means, per category, from ALL groups.
    const meansFor = (domainName) => {
        let ws = 0;
        let w = 0;
        let sum = 0;
        let count = 0;
        for (const r of base) {
            if (r.domainName !== domainName) continue;
            const wt = Number(r.sampleCount) || 0;
            ws += Number(r.avgLevel) * wt;
            w += wt;
            sum += Number(r.avgLevel);
            count++;
        }
        return {
            weighted: w ? Math.round((ws / w) * 100) / 100 : null,
            unweighted: count ? Math.round((sum / count) * 100) / 100 : null,
        };
    };

    test('each domain equals the sampleCount-weighted mean of ALL group means', () => {
        for (const d of org.data) {
            expect(d.avgLevel).toBe(meansFor(d.domainName).weighted);
            expect(Number.isNaN(d.avgLevel)).toBe(false);
        }
    });

    test('it actually differs from the old unweighted mean for at least one domain', () => {
        let differs = 0;
        for (const d of org.data) {
            const m = meansFor(d.domainName);
            if (m.weighted !== m.unweighted) differs++;
        }
        expect(differs).toBeGreaterThan(0); // uneven group sizes => weighting bites
    });
});

describe('the org-average source is weighted', () => {
    const src = norm('src/models/DashboardModel.js');
    test('the Org Average multiplies by sampleCount, not a plain count average', () => {
        expect(src).toMatch(/weightedSum \+= Number\(d\.avgLevel\) \* w/);
        expect(src).not.toMatch(
            /return \{ domainName, avgLevel: Math\.round\(\(sum \/ count\) \* 100\) \/ 100 \}/
        );
    });
});
