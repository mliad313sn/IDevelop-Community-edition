'use strict';
/**
 * KPI definitions, contract kpi-2, on the real test database (the invented
 * KPI world of tests/helpers/kpiWorld.js, inside a transaction that is
 * always rolled back):
 *   - assessment freshness is fresh ÷ ASSESSED requirements (K3 keeps the
 *     expected ones), so the health score does not count coverage twice;
 *   - one K2 per unit: the organisation row IS K2, a single-site scope's unit
 *     IS the organisation, the people add up;
 *   - K1 by site « with a comparable role mix »: a site with the
 *     organisation's role mix expects exactly what it observes;
 *   - K14 is a Kaplan–Meier median: people not ready yet are censored, so
 *     with fewer than half ready the median is « beyond N days », never the
 *     naive median of those who made it;
 *   - the snapshot row is written under kpi-2;
 *   - the overview tab carries the measurability line and the trend ends on
 *     the live K1 tile.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/kpiWorld');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(180000);

let db;
let K;
let F;
const tx = (fn) => W.inRolledBackTx(db, fn);
const scopeOf = (w) => ({ system: true, employeeIds: W.fixtureIds(w) });

suite('KPI contract kpi-2 on the test database (rolled back)', () => {
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
        K = require('../../src/services/KpiService');
        F = await W.seedFacts(db);
    });
    afterAll(async () => {
        await db.close();
    });

    test('freshness is over the ASSESSED requirements; K3 over the expected ones', async () => {
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const s = scopeOf(w);
            return { fr: await K.assessmentFreshness(s), k3: await K.k3Coverage(s) };
        });
        // world: 6 × 3 (A…A4, B) + C 1 + E 1 = 20 assessed of 10 people × 3 expected
        expect(out.fr.denominator).toBe(out.k3.breakdown.assessedRequirements);
        expect(out.fr.numerator).toBe(out.fr.denominator); // everything assessed today
        expect(out.fr.value).toBe(100);
        expect(out.k3.value).toBeLessThan(100);
        expect(out.fr.breakdown.unassessed).toBe(
            out.k3.breakdown.expectedRequirements - out.k3.breakdown.assessedRequirements
        );
    });

    test('one K2 per unit: the organisation row is K2, a single site is the organisation', async () => {
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const s = scopeOf(w);
            return {
                w,
                k2: await K.compute('K2', s),
                bySite: await K.k2ByUnit(s, 'site'),
                byDept: await K.k2ByUnit(s, 'department'),
            };
        });
        expect(out.bySite.org.value).toBe(out.k2.value);
        expect(out.bySite.org.n).toBe(out.k2.n);
        const site = out.bySite.units.get(String(F.ORG.siteId));
        // H (no site) is not assessed: every K2 person is on the fixture site
        expect(site.value).toBe(out.k2.value);
        expect(out.byDept.org.value).toBe(out.k2.value);
        const n = [...out.bySite.units.values()].reduce((a, u) => a + u.n, 0);
        expect(n).toBe(out.k2.n);
        await expect(K.k2ByUnit(scopeOf(out.w), 'role; DROP TABLE x')).rejects.toThrow(
            /unknown unit/
        );
    });

    test('K1 « with a comparable role mix »: the organisation mix expects what it observes', async () => {
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const s = scopeOf(w);
            return { k1: await K.compute('K1', s), exp: await K.k1RoleExpected(s) };
        });
        const site = out.exp.get(String(F.ORG.siteId));
        // A…A4 ready, B and E not ready: 6 people with a verdict, all in role R
        expect(site).toMatchObject({ n: 6, state: 'ok' });
        expect(site.expected).toBe(site.observed);
        expect(site.observed).toBe(out.k1.value);
    });

    test('K14 is a Kaplan–Meier median: the people not ready yet are censored', async () => {
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            // A…A4 started 10 to 40 days ago and are ready today; B, C, D, E and H
            // started 200 days ago and are not ready
            const starts = [
                [w.A, 10],
                [w.A2, 20],
                [w.A3, 30],
                [w.A4, 40],
                [w.B, 200],
                [w.C, 200],
                [w.D, 200],
                [w.E, 200],
                [w.H, 200],
            ];
            for (const [id, days] of starts)
                await db.run(
                    'UPDATE employees SET role_start_date = CURRENT_DATE - ?::int WHERE id = ?',
                    [days, id]
                );
            return K.compute('K14', scopeOf(w));
        });
        expect(out.breakdown).toMatchObject({ captured: 9, reached: 4, censored: 5 });
        // the naive median of the four who made it (25 days) is NOT the answer
        expect(out.rawValue).toBeNull();
        expect(out.breakdown.medianBeyond).toBe(200);
        expect(out.value).toBeNull();
    });

    test('the snapshot is written under kpi-2', async () => {
        const m = await tx(async (q) => {
            const w = await W.world(db, F, q);
            return K.snapshotMetrics(scopeOf(w));
        });
        expect(m.kpiContract).toBe('kpi-2');
    });

    test('the overview tab: measurability under the score, the trend ends on the live K1', async () => {
        const D = require('../../src/services/DashboardHomeService');
        const out = await tx(async (q) => {
            await W.world(db, F, q);
            const ctx = await D.context({ user: F.SUPER, query: {}, remember: false });
            const k1 = await K.compute('K1', ctx.kpiScope);
            const m = await D.tabModel(ctx, 'overview', { query: {} });
            return { k1, m };
        });
        const MZ = out.m.measurability;
        expect(MZ.emptyScope).toBeFalsy();
        expect(MZ.scored).toBe(out.k1.denominator);
        expect(MZ.notAssessed).toBe(out.k1.breakdown.notAssessed);
        expect(MZ.population).toBe(out.k1.breakdown.population);
        const est = out.m.reconstructed || [];
        expect(est.length).toBeGreaterThan(0);
        const last = est[est.length - 1];
        expect(last.live).toBe(true);
        expect(last.K1).toBe(out.k1.value === undefined ? null : out.k1.value);
    });
});
