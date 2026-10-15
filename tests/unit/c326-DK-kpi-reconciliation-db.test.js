'use strict';
/**
 * KPI module reconciliation on the REAL test database. Every test builds its
 * own fixtures INSIDE a transaction that is always rolled back
 * (tests/helpers/kpiWorld.js: invented people, one new role, a manager and a
 * local administrator).
 *
 * The contract under test (src/services/KpiService.js): active, not-erased
 * population inside the reader's clearance; unmeasured never folded into 0;
 * fewer than 5 people gives no %; status bands from one source; `drill` is
 * the exact list behind a number; the sum of the sites equals the
 * organisation; the snapshot of the day IS the indicator and a movement never
 * crosses a change of definition.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(180000);

const W = require('../helpers/kpiWorld');
const db = HAS_DB ? require('../../src/config/database') : null;
const K = HAS_DB ? require('../../src/services/KpiService') : null;
const MIG_184 = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/184_kpi_snapshot_columns.sql'),
    'utf8'
);

/** K5 / K6 drill ROLE ids, not person ids. */
const ROLE_DRILLS = new Set(['K5', 'K6']);
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
const scopeOf = (w, extra = {}) => ({ viewer: F.SUPER, employeeIds: W.fixtureIds(w), ...extra });

suite('KPI module on the real database', () => {
    test('K1 four states: never assessed is not_assessed, never not_ready; a known critical fail is not_ready', async () => {
        const { w, r } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            return { w, r: await K.k1RoleReady(scopeOf(w)) };
        });
        expect(r.breakdown).toMatchObject({
            ready: 4,
            notReady: 2,
            partial: 1,
            notAssessed: 2,
            noRequirement: 1,
        });
        expect(r.drillByState.not_assessed.sort()).toEqual([w.D, w.H].sort());
        expect(r.drillByState.not_ready).not.toContain(w.D);
        expect(r.drillByState.not_ready.sort()).toEqual([w.B, w.E].sort());
        expect(r.drillByState.partial).toEqual([w.C]);
        // 4 ÷ (4 + 2), n = 6 ≥ 5
        expect(r.numerator).toBe(4);
        expect(r.denominator).toBe(6);
        expect(r.value).toBe(66.7);
        expect(r.status).toBe('watch');
        expect(r.drill).toHaveLength(r.denominator);
        expect(r.numeratorDrill).toHaveLength(r.numerator);
    });

    test('small n: fewer than 5 people gives no %, the counts stay, status small_n', async () => {
        const r = await tx(async (q) => {
            const w = await W.world(db, F, q);
            return K.k1RoleReady({ viewer: F.SUPER, employeeIds: [w.A, w.B, w.C] });
        });
        expect(r.value).toBeNull();
        expect(r.rawValue).toBe(50);
        expect(r.numerator).toBe(1);
        expect(r.denominator).toBe(2);
        expect(r.status).toBe('small_n');
    });

    test('empty denominator gives null and not_measured (never 0 %)', async () => {
        const r = await tx(async (q) => {
            const w = await W.world(db, F, q);
            return K.k1RoleReady({ viewer: F.SUPER, employeeIds: [w.D, w.H] });
        });
        expect(r.value).toBeNull();
        expect(r.status).toBe('not_measured');
        expect(r.breakdown.notAssessed).toBe(2);
    });

    test('the leaver and the erased person are absent from EVERY indicator for SuperAdmin, local admin and manager', async () => {
        const { w, seen } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            // F and G also carry an active plan each: they must not be counted
            await db.run(
                `INSERT INTO pips (employee_id, initiated_by, state, summary, ends_on)
                 VALUES (?, ?, 'active', 'KPI fixture', CURRENT_DATE - 3)`,
                [w.F, F.adminId]
            );
            await db.run(
                `INSERT INTO idp_plans (employee_id, status, ends_on) VALUES (?, 'active', CURRENT_DATE - 3)`,
                [w.G]
            );
            const viewers = { super: F.SUPER, local: w.LOCAL, manager: W.managerOf(w) };
            const seen = {};
            for (const [name, viewer] of Object.entries(viewers)) {
                const pop = await K.resolvePopulation({ viewer });
                const all = new Set(pop.ids);
                for (const id of Object.keys(K.KPI_FUNCTIONS).filter((k) => !ROLE_DRILLS.has(k))) {
                    const r = await K.compute(id, { viewer, modules: { development: true } });
                    for (const x of W.idsIn(r)) all.add(x);
                }
                seen[name] = { ids: [...all], popA: pop.ids.includes(w.A) };
            }
            return { w, seen };
        });
        for (const name of ['super', 'local', 'manager']) {
            expect([name, seen[name].ids.includes(w.F)]).toEqual([name, false]);
            expect([name, seen[name].ids.includes(w.G)]).toEqual([name, false]);
            // the population itself is not empty: the fixtures ARE visible
            expect([name, seen[name].popA]).toEqual([name, true]);
        }
    });

    test('the sites add up to the organisation (with a "No site" row) for K1, K3, K4, K7, K8, K9, K15, K16', async () => {
        const out = await tx(async (q) => {
            await W.world(db, F, q);
            const res = {};
            for (const id of ['K1', 'K3', 'K4', 'K7', 'K8', 'K9', 'K15', 'K16']) {
                res[id] = await K.bySite(id, { viewer: F.SUPER });
            }
            return res;
        });
        const sum = (rows, f) => rows.reduce((a, r) => a + (Number(f(r.result)) || 0), 0);
        for (const [id, bs] of Object.entries(out)) {
            const noSite = bs.rows.filter((r) => r.noSite);
            expect([id, noSite.length]).toEqual([id, 1]); // H
            expect(noSite[0].labelKey).toBe('kpi:no_site');
            for (const f of [(r) => r.numerator, (r) => r.denominator, (r) => r.n]) {
                expect([id, sum(bs.rows, f)]).toEqual([id, Number(f(bs.org)) || 0]);
            }
            if (bs.org.breakdown && typeof bs.org.breakdown === 'object') {
                for (const [k, v] of Object.entries(bs.org.breakdown)) {
                    if (typeof v !== 'number') continue;
                    expect([id, k, sum(bs.rows, (r) => r.breakdown && r.breakdown[k])]).toEqual([
                        id,
                        k,
                        v,
                    ]);
                }
            }
            if (Array.isArray(bs.org.drill)) {
                expect([id, sum(bs.rows, (r) => (r.drill || []).length)]).toEqual([
                    id,
                    bs.org.drill.length,
                ]);
            }
        }
    });

    test('the figure is the length of its drill for every indicator (organisation, SuperAdmin)', async () => {
        const res = await tx(async (q) => {
            await W.world(db, F, q);
            const r = {};
            for (const id of Object.keys(K.KPI_FUNCTIONS))
                r[id] = await K.compute(id, { viewer: F.SUPER });
            return r;
        });
        for (const id of ['K1', 'K2', 'K3', 'K4', 'K9']) {
            expect([id, res[id].drill.length]).toEqual([id, res[id].n]);
            if (res[id].numeratorDrill)
                expect([id, res[id].numeratorDrill.length]).toEqual([id, res[id].numerator]);
        }
        for (const id of ['K7', 'K8', 'K15', 'K16']) {
            if (res[id].value != null)
                expect([id, res[id].drill.length]).toEqual([id, res[id].value]);
        }
        for (const c of res.K11.campaigns || []) expect(c.drill.length).toBe(c.denominator);
    });

    test('K15 ignores first measurements; a real level increase counts once', async () => {
        const { w, r } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            await db.run(
                'UPDATE skill_assessments SET current_level = 3 WHERE employee_id = ? AND skill_id = ?',
                [w.A, w.S2]
            );
            return { w, r: await K.k15LevelUps(scopeOf(w)) };
        });
        expect(r.value).toBe(1);
        expect(r.drill).toEqual([{ employeeId: w.A, skillId: w.S2 }]);
        // 4×3 (A..A4) + 3 (B) + 1 (C) + 1 (E) first measurements, never increases
        expect(r.breakdown.firstMeasurementsExcluded).toBe(17);
    });

    test('K7 sole holder inside the scope; K4 assessed only, with "not demonstrated" apart', async () => {
        const { w, k7, k4 } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            return {
                w,
                k7: await K.k7SoleHolders({ viewer: F.SUPER, employeeIds: [w.A, w.B, w.D] }),
                k4: await K.k4CriticalCompliance(scopeOf(w)),
            };
        });
        expect(k7.value).toBe(1);
        expect(k7.drill).toEqual([{ siteId: F.ORG.siteId, skillId: w.S1, employeeId: w.A }]);
        // critical S1: assessed for A..A4, B, E (6), met for 4; never for C, D, H
        expect(k4.breakdown).toMatchObject({
            criticalAssessed: 6,
            criticalMet: 4,
            criticalUnassessed: 3,
        });
        expect(k4.value).toBe(66.6); // a compliance % rounds DOWN (4 / 6 = 66.66…)
        expect(k4.status).toBe('at_risk');
        expect(k4.drillNotDemonstrated.sort()).toEqual([w.C, w.D, w.H].sort());
    });

    test('K8: nothing required gives not_configured (never 0); expired / within 90 days in PEOPLE', async () => {
        const { w, before, after } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const scope = scopeOf(w);
            const before = await K.k8Certifications(scope);
            await db.run(
                `INSERT INTO skill_certification_policies (skill_id, is_certification, validity_months, revalidation_window_days)
                 VALUES (?, true, 12, 90)`,
                [w.S2]
            );
            await db.run(
                `INSERT INTO employee_certifications (employee_id, skill_id, issued_on, expires_on)
                 VALUES (?, ?, CURRENT_DATE - 400, CURRENT_DATE - 1),
                        (?, ?, CURRENT_DATE - 300, CURRENT_DATE + 20),
                        (?, ?, CURRENT_DATE - 300, CURRENT_DATE + 200)`,
                [w.A, w.S2, w.B, w.S2, w.C, w.S2]
            );
            return { w, before, after: await K.k8Certifications(scope) };
        });
        expect(before.status).toBe('not_configured');
        expect(before.value).toBeNull();
        expect(after.value).toBe(1);
        expect(after.drill).toEqual([w.A]);
        expect(after.drillExpiring).toEqual([w.B]);
        expect(after.breakdown).toMatchObject({
            expiredPeople: 1,
            expiringPeople: 1,
            expiring30People: 1,
        });
        expect(after.status).toBe('at_risk');
        // required but never recorded (A2, A3, A4, D, E, H): counted apart
        expect(after.breakdown.missingPeople).toBe(6);
        expect(after.drillMissing.sort()).toEqual([w.A2, w.A3, w.A4, w.D, w.E, w.H].sort());
    });

    test('K9: no gated role gives not_configured; a known fail is in the %, the unassessed apart', async () => {
        const { w, before, after } = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const scope = scopeOf(w);
            const before = await K.k9SafetyFitness(scope);
            await db.run(
                `INSERT INTO safety_gate_rules (role_id, skill_id, min_level, cert_required, is_active, mode)
                 VALUES (?, ?, 2, false, true, 'enforce')`,
                [w.R, w.S1]
            );
            return { w, before, after: await K.k9SafetyFitness(scope) };
        });
        expect(before.status).toBe('not_configured');
        // fit A..A4 (4); unfit B, E (S1 at 1); not demonstrated C, D, H
        expect(after.breakdown).toMatchObject({ fit: 4, unfit: 2, notDemonstrated: 3 });
        expect(after.numerator).toBe(4);
        expect(after.denominator).toBe(6);
        expect(after.drillNotDemonstrated.sort()).toEqual([w.C, w.D, w.H].sort());
        expect(after.status).toBe('at_risk');
        // ids and codes only: no person name leaves the KPI module
        expect(JSON.stringify(after.unfitDetail)).not.toMatch(/Fixture/);
    });

    test('K16: one active predicate, the overdue sub-count, PIP hidden without clearance, development types gated by the module', async () => {
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            // a "proposed" PIP is a silent proposal: a draft, not an active plan
            await db.run(
                `INSERT INTO pips (employee_id, initiated_by, state, summary, ends_on)
                 VALUES (?, ?, 'proposed', 'KPI fixture', CURRENT_DATE + 30),
                        (?, ?, 'active', 'KPI fixture', CURRENT_DATE + 30)`,
                [w.A, F.adminId, w.B, F.adminId]
            );
            await db.run(
                `INSERT INTO idp_plans (employee_id, status, ends_on) VALUES (?, 'active', CURRENT_DATE - 1),
                        (?, 'draft', CURRENT_DATE - 1), (?, 'completed', CURRENT_DATE - 1)`,
                [w.A, w.B, w.C]
            );
            await db.run(
                `INSERT INTO coaching_plans (employee_id, kind, title, state, target_date)
                 VALUES (?, 'coaching', 'KPI', 'active', NULL), (?, 'coaching', 'KPI', 'cancelled', NULL)`,
                [w.B, w.C]
            );
            const on = { development: true };
            const s = { employeeIds: W.fixtureIds(w) };
            return {
                w,
                sup: await K.k16ActivePlans({ ...s, viewer: F.SUPER, modules: on }),
                loc: await K.k16ActivePlans({ ...s, viewer: w.LOCAL, modules: on }),
                off: await K.k16ActivePlans({ ...s, viewer: F.SUPER, modules: {} }),
            };
        });
        const { w, sup, loc, off } = out;
        expect(sup.byType.pip.value).toBe(1); // B active; A proposed is not counted
        expect(sup.byType.pip.drill.map((x) => x.employeeId)).toEqual([w.B]);
        expect(sup.byType.idp).toMatchObject({ value: 1, overdue: 1 });
        expect(sup.byType.coaching).toMatchObject({ value: 1, overdue: 0 });
        expect(sup.value).toBe(3);
        expect(sup.overdue).toBe(1);
        expect(sup.status).toBe('watch');
        expect(loc.byType.pip).toMatchObject({ hidden: true, value: null });
        expect(loc.value).toBe(2);
        // development module off: only the (core) development plans remain
        expect(off.types).toEqual(['idp']);
        expect(Object.keys(off.byType)).toEqual(['idp']);
        expect(off.value).toBe(1);
    });

    test('K11: saving stamps started_at, submitting stamps submitted_at; the funnel reads them', async () => {
        const SA = require('../../src/services/SelfAssessmentService');
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            // a locked campaign is current too: neutralise both
            await db.run(
                "UPDATE assessment_cycles SET status = 'closed' WHERE status IN ('open', 'locked')"
            );
            const c = await db.get(
                `INSERT INTO assessment_cycles (code, label, opened_at, closes_at, status, created_by)
                 VALUES (?, 'KPI campaign', now() - interval '10 days', now() + interval '10 days', 'open', ?)
                 RETURNING id`,
                [`KPI-${W.STAMP}`, F.adminId]
            );
            const cid = Number(c.id);
            for (const t of ['A', 'B', 'C', 'D', 'E']) {
                await db.run(
                    'INSERT INTO cycle_participants (cycle_id, employee_id, role_id, expected_skills) VALUES (?, ?, ?, 3)',
                    [cid, w[t], w.R]
                );
            }
            const read = (e) =>
                db.get(
                    'SELECT started_at AS "s", submitted_at AS "u" FROM cycle_participants WHERE cycle_id = ? AND employee_id = ?',
                    [cid, e]
                );
            await SA.createOrUpdateSelfAssessment(w.C, w.S1, 2, null);
            const afterSave = await read(w.C);
            await SA.createOrUpdateSelfAssessment(w.D, w.S1, 1, null);
            await db.run('UPDATE employees SET supervisor_id = NULL WHERE id = ?', [w.D]);
            await SA.submitSelfAssessment(w.D).catch(() => null);
            const afterSubmit = await read(w.D);
            const untouched = await read(w.E);
            const k11 = await K.k11CurrentCampaign(scopeOf(w));
            return { afterSave, afterSubmit, untouched, k11, cid };
        });
        expect(out.afterSave.s).toBeTruthy();
        expect(out.afterSave.u).toBeNull();
        expect(out.afterSubmit.s).toBeTruthy();
        expect(out.untouched.s).toBeNull();
        expect(out.k11.campaigns).toHaveLength(1);
        const c = out.k11.campaigns[0];
        expect(c.campaign.id).toBe(out.cid);
        expect(c.breakdown).toMatchObject({ invited: 5, validated: 0, stepsTracked: true });
        expect(c.breakdown.started).toBeGreaterThanOrEqual(2);
        expect(c.value).toBe(0); // 0 validated of 5 invited is a measured 0, not an absence
        expect(c.status).toBe('at_risk'); // half the window elapsed, nothing validated
    });

    test('K11 with no current campaign gives an explicit "no campaign", never 0 %', async () => {
        const r = await tx(async () => {
            await db.run(
                "UPDATE assessment_cycles SET status = 'closed' WHERE status IN ('open', 'locked')"
            );
            return K.k11CurrentCampaign({ viewer: F.SUPER });
        });
        expect(r.noCampaign).toBe(true);
        expect(r.value).toBeNull();
        expect(r.status).toBe('not_measured');
        expect(r.campaigns).toEqual([]);
    });

    test("today's dashboard figures equal K2 / K3 / K4: the metrics compared across a contract change are the same definitions", async () => {
        const DashboardModel = require('../../src/models/DashboardModel');
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            // A real erasure also sets is_active = false (DSRService): G is
            // erased the way the product erases. The "No site" person H is
            // outside both readings here (site scope); employees.site_id is
            // NOT NULL outside this rolled-back fixture.
            await db.run('UPDATE employees SET is_active = false WHERE id = ?', [w.G]);
            const site = { siteIds: [F.ORG.siteId] };
            return {
                legacy: await DashboardModel.getOverviewKPIs(site),
                m: await K.snapshotMetrics({ system: true, siteId: F.ORG.siteId }),
                w,
            };
        });
        const n = (v) => (v == null ? null : Number(v));
        expect(n(out.legacy.avgReadiness)).toBe(out.m.avgReadiness);
        expect(n(out.legacy.assessmentCoverage)).toBe(out.m.assessmentCoverage);
        expect(n(out.legacy.criticalCompliance)).toBe(out.m.criticalCompliance);
        expect(n(out.legacy.measuredEmployees)).toBe(out.m.measuredEmployees);
    });

    test('snapshot: migration 184 columns written from KpiService; a changed metric never crosses a contract', async () => {
        const KS = require('../../src/services/KpiSnapshotService');
        const out = await tx(async (q) => {
            await q.query(MIG_184);
            await q.query(MIG_184); // idempotent
            await W.world(db, F, q);
            await db.run(
                "DELETE FROM kpi_snapshots WHERE scope_type = 'org' AND scope_id = 0 AND snapshot_date > CURRENT_DATE - 400"
            );
            // a LEGACY row 30 days ago (kpi_contract NULL)
            await db.run(
                `INSERT INTO kpi_snapshots (scope_type, scope_id, snapshot_date, critical_compliance,
                                            measured_employees, role_ready_count)
                 VALUES ('org', 0, CURRENT_DATE - 30, 12.0, 70, 3)`
            );
            const m = await K.snapshotMetrics({ system: true });
            await KS.capture('org', 0, null, m);
            const row = await db.get(
                `SELECT role_ready_count AS "rr", not_ready_count AS "nr", partial_count AS "pc",
                        unassessed_count AS "uc", critical_unassessed AS "cu",
                        certs_expired AS "ce", safety_fit_pct AS "sf", kpi_contract AS "kc"
                   FROM kpi_snapshots WHERE scope_type = 'org' AND scope_id = 0 AND snapshot_date = CURRENT_DATE`
            );
            const k1 = await K.k1RoleReady({ viewer: F.SUPER });
            const d = await KS.deltas(m, 'org', 0, 28);
            // today's dashboard (no contract) reading the same history
            const legacy = await KS.deltas(
                { criticalCompliance: 20, measuredEmployees: 75, roleReadyCount: 9 },
                'org',
                0,
                28
            );
            return { m, row, k1, d, legacy };
        });
        expect(out.row.kc).toBe(K.CONTRACT_VERSION);
        // the snapshot of the day IS the indicator
        expect(Number(out.row.rr)).toBe(out.k1.breakdown.ready);
        expect(Number(out.row.nr)).toBe(out.k1.breakdown.notReady);
        expect(Number(out.row.pc)).toBe(out.k1.breakdown.partial);
        expect(Number(out.row.uc)).toBe(out.k1.breakdown.notAssessed);
        expect(out.row.cu).not.toBeNull();
        // no certification / gate configured in the world: NULL, never 0
        expect(out.row.sf).toBeNull();
        expect(out.row.ce).toBeNull();
        // the legacy row is a comparison point for the STABLE metrics only
        expect(out.d.since).not.toBeNull();
        expect(Object.keys(out.d.values).sort()).toEqual(
            Object.keys(out.d.values)
                .filter((k) => KS.CONTRACT_STABLE_METRICS.includes(k))
                .sort()
        );
        expect(out.d.values.roleReadyCount).toBeUndefined();
        // today's dashboard still compares with its own (legacy) rows, whole
        expect(out.legacy.values).toMatchObject({
            criticalCompliance: 8,
            measuredEmployees: 5,
            roleReadyCount: 6,
        });
    });
});
