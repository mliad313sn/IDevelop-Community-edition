'use strict';

/**
 * The sub-domain radar ranked never-assessed sub-domains as the worst gaps.
 *
 * `getOrgSubDomainRadar` merges two layers — actual proficiency from
 * assessments, required level from role requirements — and filled the missing
 * side with 0. A sub-domain nobody has ever been assessed on therefore arrived
 * with `avgActual: 0`, which is the largest gap the arithmetic can produce.
 *
 * The client then caps the radar at 12 axes by sorting on
 * `avgRequired - avgActual`, so the fabricated gaps did not merely appear —
 * they deterministically OWNED the top of the ranking, under a caption reading
 * "the 12 sub-domains with the largest gaps".
 *
 * Measured on idevelop before the fix — the seven worst "training priorities":
 *
 *   1. Values and inclusive leadership      gap 3.55   assessed 0
 *   2. Cost awareness and ownership         gap 3.20   assessed 0
 *   3. Contractor compliance                gap 3.03   assessed 0
 *   4. Operational discipline               gap 3.00   assessed 0
 *   5. Supervision and work direction       gap 3.00   assessed 0
 *   6. Emergency preparedness               gap 2.60   assessed 0
 *   7. Mandatory training and licences      gap 2.60   assessed 0
 *   8. Risk-based decision making           gap 1.36   assessed 13   <- the first real one
 *
 * A director funding training from that chart funds seven things nobody has
 * measured, and never sees the worst gap that was actually observed.
 *
 * After the fix: both axes are NULL when absent, the client ranks over measured
 * sub-domains only, and the excluded ones are stated in words in the caption
 * rather than drawn as a maximal gap.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isFixturesDatabaseUrl } = require('../helpers/testDatabase');
// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = isFixturesDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const DashboardModel = HAS_DB ? require('../../src/models/DashboardModel') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('a sub-domain nobody was assessed on has no proficiency, not a proficiency of 0', () => {
    let rows = null;
    beforeAll(async () => {
        rows = await DashboardModel.getOrgSubDomainRadar({});
    });

    test('the fixture we rely on still exists (guards against a vacuous suite)', () => {
        // If every sub-domain were measured, each assertion below would pass
        // without exercising anything.
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter((r) => Number(r.assessedCount || 0) === 0).length).toBeGreaterThan(0);
    });

    test('avgActual is null, never 0, where nobody has been assessed', () => {
        for (const r of rows.filter((x) => Number(x.assessedCount || 0) === 0)) {
            expect(r.avgActual).toBeNull();
        }
    });

    test('avgRequired is null, never 0, where no role requires the sub-domain', () => {
        for (const r of rows.filter((x) => Number(x.requiredSkillCount || 0) === 0)) {
            expect(r.avgRequired).toBeNull();
        }
    });

    test('a MEASURED sub-domain still reports a real figure — the guard blanked nothing', () => {
        const measured = rows.filter((x) => Number(x.assessedCount || 0) > 0);
        expect(measured.length).toBeGreaterThan(0);
        for (const r of measured) {
            expect(r.avgActual).not.toBeNull();
            expect(Number(r.avgActual)).toBeGreaterThanOrEqual(0);
            expect(Number(r.avgActual)).toBeLessThanOrEqual(4);
        }
    });

    test('no unmeasured sub-domain can out-rank a measured one for the 12 axes', () => {
        // The exact selection the client performs.
        const num = (v) => Number(v) || 0;
        const measured = rows.filter(
            (d) => d.avgActual != null && d.avgRequired != null && num(d.assessedCount) > 0
        );
        const top = [...measured]
            .sort(
                (a, b) =>
                    num(b.avgRequired) - num(b.avgActual) - (num(a.avgRequired) - num(a.avgActual))
            )
            .slice(0, 12);

        expect(top.length).toBeGreaterThan(0);
        for (const r of top) expect(num(r.assessedCount)).toBeGreaterThan(0);

        // and the top gap must be a plausible measured one, not a fabricated
        // maximum: before the fix this was 3.55 on zero assessments.
        const topGap = num(top[0].avgRequired) - num(top[0].avgActual);
        expect(topGap).toBeLessThan(2.5);
    });
});

// the former dashboard page and public/js/dashboard.js were retired in wave 12 (D3); the server-rendered dashboard has its own tests (dash*.test.js)
