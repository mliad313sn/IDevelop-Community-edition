'use strict';

/**
 * The domain radar subtracted two unrelated averages and called it a gap.
 *
 * `actual` averaged v_domain_capability — every assessment a person holds,
 * INCLUDING skills their role does not require. `required` averaged the role
 * requirements fanned out by headcount — INCLUDING requirements nobody has
 * ever been assessed on. Neither population is a subset of the other, so the
 * difference is not a gap; it is two means of different things subtracted.
 *
 * It overstated every domain (dev dataset, org-wide):
 *
 *   domain                          shown   paired
 *   4. Compliance & Certification    1.21    0.36     3.4x
 *   6. People Management             0.91    0.44
 *   2. Functional Technical          0.54    0.13
 *   1. HSE & Operational Risk        0.44    0.33
 *   5. Business Acumen               0.37    0.05
 *   3. Digital, Data & Work Tools    0.19    0.06
 *
 * Both layers now come from v_employee_skill_gaps, which pairs a required
 * level with the level that person was actually assessed at, restricted to
 * MEASURED requirements — so a difference is a shortfall somebody observed.
 * Unmeasured requirements are reported as coverage (measuredPairs/totalPairs)
 * rather than folded into the average: Compliance & Certification turns out to
 * be 148 measured pairs of 577, which is the fact that matters about it.
 *
 * A domain with nothing measured yields NULL on both axes, and the two
 * consumers (top-10 / worst-10 radars, and the summary table) rank over the
 * measured domains only — with `|| 0` an unmeasured domain scored 0 against
 * its full required level, the largest gap arithmetic can produce, and took a
 * place in "worst 10" on the strength of having no data.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const DashboardModel = HAS_DB ? require('../../src/models/DashboardModel') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('both radar layers describe the same rows', () => {
    let rows = null;
    beforeAll(async () => {
        rows = await DashboardModel.getOrgDomainRadar({});
    });

    test('the fixture we rely on still exists (guards against a vacuous suite)', () => {
        expect(rows.length).toBeGreaterThan(0);
        // there must be UNMEASURED requirements somewhere, or the old and new
        // arithmetic agree and nothing here is being tested
        const partial = rows.some((r) => Number(r.measuredPairs) < Number(r.totalPairs));
        expect(partial).toBe(true);
    });

    test('every domain matches a hand-computed paired average', async () => {
        const paired = await db.all(
            `SELECT g.domain_name AS dom,
                    ROUND(AVG(g.actual_level), 2)   AS a,
                    ROUND(AVG(g.required_level), 2) AS r
               FROM v_employee_skill_gaps g
              WHERE g.required_level > 0 AND g.is_assessed = 1
              GROUP BY 1`
        );
        const byName = new Map(paired.map((p) => [p.dom, p]));
        for (const r of rows) {
            const p = byName.get(r.domainName);
            if (!p) continue;
            expect(Number(r.avgActual)).toBeCloseTo(Number(p.a), 2);
            expect(Number(r.avgRequired)).toBeCloseTo(Number(p.r), 2);
        }
    });

    test('the coverage behind each gap travels with it', () => {
        for (const r of rows) {
            expect(Number(r.totalPairs)).toBeGreaterThan(0);
            expect(Number(r.measuredPairs)).toBeLessThanOrEqual(Number(r.totalPairs));
            // a measured domain must actually have measured pairs
            if (r.avgActual != null) expect(Number(r.measuredPairs)).toBeGreaterThan(0);
        }
    });

    test('an unmeasured domain is null on both axes, never 0', () => {
        for (const r of rows) {
            if (Number(r.measuredPairs) === 0) {
                expect(r.avgActual).toBeNull();
                expect(r.avgRequired).toBeNull();
            }
        }
    });

    test('the filters still scope it', async () => {
        const all = await DashboardModel.getOrgDomainRadar({});
        const one = await DashboardModel.getOrgDomainRadar({ domainName: all[0].domainName });
        expect(one).toHaveLength(1);
        expect(one[0].domainName).toBe(all[0].domainName);

        const site = await db.get('SELECT name FROM sites ORDER BY id LIMIT 1');
        const scoped = await DashboardModel.getOrgDomainRadar({ siteName: site.name });
        expect(Array.isArray(scoped)).toBe(true);
        // a scoped view cannot have MORE pairs than the org-wide one
        const total = (xs) => xs.reduce((t, x) => t + Number(x.totalPairs), 0);
        expect(total(scoped)).toBeLessThanOrEqual(total(all));
    });
});

// the former dashboard page and public/js/dashboard.js were retired in wave 12 (D3); the server-rendered dashboard has its own tests (dash*.test.js)
