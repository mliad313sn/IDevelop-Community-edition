'use strict';
/**
 * The dashboard building blocks of the KPI module, on the REAL test database
 * (fixtures inside a transaction that is always rolled back,
 * tests/helpers/kpiWorld.js: invented people). Each block reconciles with the
 * indicator it details, on the same population:
 *   criticalSkillCoverage  measured / available add up to K4's critical
 *                          requirements assessed / met; a never-assessed holder
 *                          is never a gap; people without a site are their own column;
 *   k1ByGroup              the groups add up to K1's four states;
 *   readinessDistribution  the measured people are K2's people; not measured
 *                          and no requirement are counted apart, never in a bucket;
 *   assessmentFreshness    its expected requirements are K3's;
 *   certExpiryCalendar     nothing required ⇒ not configured, like K8;
 * and leavers and erased people are in none of them. The rendered coverage
 * heatmap carries no person name.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(180000);

const W = require('../helpers/kpiWorld');
const { render } = require('../helpers/vizRender');
const { coverageHeatModel } = require('../../src/utils/heatModel');
const db = HAS_DB ? require('../../src/config/database') : null;
const K = HAS_DB ? require('../../src/services/KpiService') : null;

let F = null;
beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    F = await W.seedFacts(db);
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const tx = (fn) => W.inRolledBackTx(db, fn);
const scopeOf = (w) => ({ viewer: F.SUPER, employeeIds: W.fixtureIds(w) });

suite('dashboard building blocks on the real database', () => {
    test('critical-skill coverage reconciles with K4; never-assessed is not a gap', async () => {
        const { w, cov, k4 } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const s = scopeOf(w);
            return {
                w,
                cov: await K.criticalSkillCoverage(s),
                k4: await K.k4CriticalCompliance(s),
            };
        });
        expect(cov.emptyScope).toBe(false);
        expect(cov.rows.map((r) => r.skillId)).toEqual([w.S1]);
        expect(cov.sites.map((s) => s.siteKey)).toEqual([String(F.ORG.siteId), 'none']);
        const [site, none] = cov.rows[0].cells;
        // A×4 met, B and E assessed below, C and D never assessed (F leaver, G erased: out)
        expect(site).toMatchObject({ required: 8, measured: 6, available: 4, unmeasured: false });
        expect(none).toMatchObject({
            required: 1,
            measured: 0,
            available: 0,
            unmeasured: true,
            status: null,
        });
        const sum = (k) =>
            cov.rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + (c ? c[k] : 0), 0), 0);
        expect(sum('measured')).toBe(k4.breakdown.criticalAssessed);
        expect(sum('available')).toBe(k4.breakdown.criticalMet);
        expect(cov.rows[0].ratio).toBe(66.7);

        // the rendered heatmap: aggregates only, no fixture name
        const html = render(
            'views/partials/viz/heat.ejs',
            { H: coverageHeatModel(cov), heatId: 'db' },
            'en'
        );
        expect(html).toMatch(/4 of 8/);
        expect(html).toMatch(/2 not assessed/);
        expect(html).not.toMatch(/Kpi[A-H]\d*|Fixture\d+|KPI-[A-Z0-9]+-\d+/);
    });

    test('K1 by site and by role add up to K1', async () => {
        const { site, role, k1 } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const s = scopeOf(w);
            return {
                site: await K.k1ByGroup(s, 'site'),
                role: await K.k1ByGroup(s, 'role'),
                k1: await K.k1RoleReady(s),
            };
        });
        for (const g of [site, role]) {
            const tot = (k) => g.rows.reduce((a, r) => a + r.counts[k], 0);
            expect(tot('ready')).toBe(k1.breakdown.ready);
            expect(tot('notReady')).toBe(k1.breakdown.notReady);
            expect(tot('partial')).toBe(k1.breakdown.partial);
            expect(tot('notAssessed')).toBe(k1.breakdown.notAssessed);
            expect(tot('noRequirement')).toBe(k1.breakdown.noRequirement);
        }
        const none = site.rows.find((r) => r.none);
        expect(none).toMatchObject({ key: 'none', population: 1, unmeasured: true, value: null });
        expect(site.rows[site.rows.length - 1].none).toBe(true); // unmeasured last
        const main = site.rows.find((r) => !r.none);
        expect(main).toMatchObject({ numerator: 4, denominator: 6, value: 66.7 });
    });

    test('the readiness distribution is K2’s population; unmeasured is never a 0', async () => {
        const { dist, k2 } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const s = scopeOf(w);
            return { dist: await K.readinessDistribution(s), k2: await K.k2AvgReadiness(s) };
        });
        expect(dist.measured).toBe(k2.denominator);
        expect(dist.bins.reduce((a, b) => a + b.count, 0)).toBe(dist.measured);
        expect(dist.unmeasured).toBe(2); // D and H
        expect(dist.noRequirement).toBe(1); // the manager
        expect(dist.population).toBe(dist.measured + dist.unmeasured + dist.noRequirement);
    });

    test('assessment freshness is over the ASSESSED requirements (kpi-2); K3 keeps the expected ones', async () => {
        const { fr, k3 } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const s = scopeOf(w);
            return { fr: await K.assessmentFreshness(s), k3: await K.k3Coverage(s) };
        });
        // coverage is K3's job: freshness never counts a never-assessed requirement
        expect(fr.denominator).toBe(k3.breakdown.assessedRequirements);
        expect(fr.breakdown.assessed).toBe(k3.breakdown.assessedRequirements);
        expect(fr.breakdown.expected).toBe(k3.breakdown.expectedRequirements);
        expect(fr.breakdown.fresh).toBe(fr.breakdown.assessed); // assessed today
        expect(fr.value).toBe(100);
        expect(fr.breakdown.stale).toBe(0);
        expect(fr.bySite.reduce((a, r) => a + r.expected, 0)).toBe(fr.breakdown.expected);
        expect(fr.bySite.reduce((a, r) => a + r.assessed, 0)).toBe(fr.denominator);
    });

    test('nothing required: the certificate calendar is « not configured », like K8', async () => {
        const { cal, k8 } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const s = scopeOf(w);
            return { cal: await K.certExpiryCalendar(s), k8: await K.k8Certifications(s) };
        });
        expect(cal.configured).toBe(false);
        expect(cal.weeks).toEqual([]);
        expect(k8.status).toBe('not_configured');
    });

    test('computeBlock: module-aware, closed list of blocks and groups', async () => {
        const r = await tx(async (q) => {
            const w = await W.world(db, F, q);
            return K.computeBlock('k1ByGroup', { ...scopeOf(w), modules: {} }, 'department');
        });
        expect(r.groupBy).toBe('department');
        await expect(K.computeBlock('nope', { viewer: F.SUPER })).rejects.toThrow('unknown block');
        await expect(K.k1ByGroup({ viewer: F.SUPER }, '__proto__')).rejects.toThrow(
            'unknown group'
        );
        await expect(K.k1ByGroup({ viewer: F.SUPER }, 'e.id; DROP TABLE x')).rejects.toThrow(
            'unknown group'
        );
    });

    test('an empty scope is an empty scope, never zeros', async () => {
        const s = { viewer: F.SUPER, employeeIds: [] };
        expect(await K.criticalSkillCoverage(s)).toMatchObject({ emptyScope: true, rows: [] });
        expect(await K.certExpiryCalendar(s)).toMatchObject({
            emptyScope: true,
            configured: false,
        });
        expect((await K.assessmentFreshness(s)).value).toBeNull();
        expect((await K.k1ByGroup(s, 'site')).rows).toEqual([]);
        expect((await K.readinessDistribution(s)).measured).toBe(0);
    });
});
