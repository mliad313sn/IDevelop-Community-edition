'use strict';
/**
 * 3.23.18 — lane I1 (local content), executed on idevelop_fixtures.
 *
 * Every scenario runs inside ONE transaction that also applies migration 149
 * (idempotent DDL) and is rolled back: nothing persists. It proves the SQL the
 * two new services emit against the real schema, the national rule on real
 * nationalities, the IDP create-or-link through IDPService, and the database
 * triggers that make a published pack and the event journal immutable.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = !!process.env.DATABASE_URL && /idevelop_fixtures/.test(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(undefined),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
}));
const db = HAS_DB ? require('../../src/config/database') : null;
const Nat = HAS_DB ? require('../../src/services/NationalisationService') : null;
const Reports = HAS_DB ? require('../../src/services/LocalContentReportService') : null;
const MIG = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/149_local_content_nationalisation.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

async function inRolledBackTx(fn) {
    try {
        await db.runTransaction(async () => {
            await db._txStore.getStore().query(MIG);
            await fn();
            throw new Error('__ROLLBACK__');
        });
    } catch (err) {
        if (!String(err.message).includes('__ROLLBACK__')) throw err;
    }
}

/** A statement that must fail, run inside a savepoint so the tx survives. */
async function expectRefused(sql, params, pattern) {
    let msg = null;
    try {
        await db.runInSavepoint(() => db.run(sql, params));
    } catch (e) {
        msg = String(e.message);
    }
    expect(msg).toMatch(pattern);
}

const CI = `(SELECT id FROM countries WHERE code = 'CI')`;
async function pick(where) {
    const r = await db.get(
        `SELECT e.id FROM employees e JOIN sites s ON s.id = e.site_id
          WHERE e.is_active = true AND e.role_id IS NOT NULL AND s.country_id = ${CI} AND ${where}
          ORDER BY e.id LIMIT 1`
    );
    return r ? Number(r.id) : null;
}

suite('nationalisation plan + regulator pack on the real schema (rolled back)', () => {
    let SUPER;
    beforeAll(async () => {
        const a = await db.get(
            `SELECT id FROM admins WHERE role = 'superadmin' ORDER BY id LIMIT 1`
        );
        SUPER = { userType: 'admin', role: 'superadmin', id: Number(a.id) };
    });

    test('plan lifecycle: expatriate only, national successors only, readiness not measured ≠ 0, IDP create-or-link, journal append-only', async () => {
        await inRolledBackTx(async () => {
            const expat = await pick(`e.nationality = 'France'`);
            const otherExpat = await pick(`e.nationality = 'South Africa'`);
            const nationalUnassessed = await pick(
                `e.nationality = 'Ivory Coast' AND NOT EXISTS (SELECT 1 FROM v_resolved_assessments v WHERE v.employee_id = e.id)
                 AND NOT EXISTS (SELECT 1 FROM idp_plans i WHERE i.employee_id = e.id AND i.status IN ('draft','active'))`
            );
            const nationalWithOpenIdp = await pick(
                `e.nationality = 'Ivory Coast' AND EXISTS (SELECT 1 FROM idp_plans i WHERE i.employee_id = e.id AND i.status IN ('draft','active'))`
            );
            expect(
                [expat, otherExpat, nationalUnassessed, nationalWithOpenIdp].every(Boolean)
            ).toBe(true);

            // The national rule, on real free-text nationalities.
            expect(Number((await Nat.classify(expat)).isNational)).toBe(0);
            expect(Number((await Nat.classify(nationalUnassessed)).isNational)).toBe(1);

            // A national-held position cannot be "nationalised".
            await expect(
                Nat.createPlan(SUPER, {
                    incumbentEmployeeId: nationalUnassessed,
                    targetDate: '2027-06-30',
                })
            ).rejects.toMatchObject({ code: 'LC_NOT_EXPATRIATE' });

            const { id: planId } = await Nat.createPlan(SUPER, {
                incumbentEmployeeId: expat,
                targetDate: '2027-01-15',
            });
            await expect(
                Nat.createPlan(SUPER, { incumbentEmployeeId: expat, targetDate: '2028-01-01' })
            ).rejects.toMatchObject({ code: 'LC_PLAN_EXISTS', status: 409 });

            // Nobody named yet → at risk.
            let [plan] = (await Nat.listPlans(SUPER, { today: '2026-09-26' })).filter(
                (p) => p.id === planId
            );
            expect(plan).toMatchObject({
                status: 'at_risk',
                statusReason: 'no_successor',
                countryId: expect.any(Number),
            });

            // An expatriate successor is refused; a national is accepted.
            await expect(Nat.addSuccessor(SUPER, planId, otherExpat)).rejects.toMatchObject({
                code: 'LC_SUCCESSOR_NOT_NATIONAL',
            });
            const { id: s1 } = await Nat.addSuccessor(SUPER, planId, nationalUnassessed);
            await expect(Nat.addSuccessor(SUPER, planId, nationalUnassessed)).rejects.toMatchObject(
                {
                    code: 'LC_SUCCESSOR_EXISTS',
                }
            );
            const cands = await Nat.candidateSuccessors(SUPER, planId);
            expect(cands.map((c) => Number(c.id))).not.toContain(nationalUnassessed);
            expect(cands.map((c) => Number(c.id))).not.toContain(otherExpat);

            [plan] = (await Nat.listPlans(SUPER, { today: '2026-09-26' })).filter(
                (p) => p.id === planId
            );
            const s = plan.successors.find((x) => x.id === s1);
            // Never assessed → readiness NULL ("not measured"), never 0 %.
            expect(s.readinessPercent).toBeNull();
            expect(plan.bestReadinessPercent).toBeNull();
            expect(plan).toMatchObject({
                status: 'at_risk',
                statusReason: 'readiness_not_measured',
            });

            // IDP: created through IDPService, then kept on a second call.
            const first = await Nat.linkIdp(SUPER, s1);
            expect(first.created).toBe(true);
            const idp = await db.get(
                'SELECT employee_id, status::text AS status FROM idp_plans WHERE id = ?',
                [first.idpId]
            );
            expect(Number(idp.employeeId)).toBe(nationalUnassessed);
            const again = await Nat.linkIdp(SUPER, s1);
            expect(again).toEqual({ idpId: first.idpId, created: false, linked: false });

            // A successor who already has an open IDP gets it LINKED.
            const { id: s2 } = await Nat.addSuccessor(SUPER, planId, nationalWithOpenIdp);
            const open = await db.get(
                `SELECT id FROM idp_plans WHERE employee_id = ? AND status IN ('draft','active') ORDER BY id DESC LIMIT 1`,
                [nationalWithOpenIdp]
            );
            await expect(Nat.linkIdp(SUPER, s2)).resolves.toEqual({
                idpId: Number(open.id),
                created: false,
                linked: true,
            });

            // Withdraw needs a reason; the row stays.
            await expect(Nat.withdrawSuccessor(SUPER, s2, '')).rejects.toMatchObject({
                code: 'LC_REASON_REQUIRED',
            });
            await Nat.withdrawSuccessor(SUPER, s2, 'Mutation interne');
            const w = await db.get(
                'SELECT state, state_reason FROM lc_nationalisation_successors WHERE id = ?',
                [s2]
            );
            expect(w).toMatchObject({ state: 'withdrawn', stateReason: 'Mutation interne' });

            await Nat.setTargetDate(SUPER, planId, '2028-12-31', 'Recrutement décalé');
            await Nat.closePlan(SUPER, planId, 'achieved', 'Poste repris par un national');
            await expect(Nat.closePlan(SUPER, planId, 'cancelled', 'x')).rejects.toMatchObject({
                code: 'LC_PLAN_CLOSED',
            });

            const events = await Nat.events(SUPER, planId);
            expect(events.map((e) => e.action)).toEqual([
                'plan.created',
                'successor.added',
                'successor.idp_created',
                'successor.added',
                'successor.idp_linked',
                'successor.withdrawn',
                'plan.target_moved',
                'plan.achieved',
            ]);
            expect(events.every((e) => e.actorRef === `admin:${SUPER.id}`)).toBe(true);

            // The journal cannot be rewritten or erased; plans cannot lose their reason.
            await expectRefused(
                'UPDATE lc_nationalisation_events SET reason = ? WHERE plan_id = ?',
                ['x', planId],
                /append-only/
            );
            await expectRefused(
                'DELETE FROM lc_nationalisation_events WHERE plan_id = ?',
                [planId],
                /append-only/
            );
            await expectRefused(
                `UPDATE lc_nationalisation_plans SET state = 'cancelled', state_reason = NULL WHERE id = ?`,
                [planId],
                /ck_lc_nat_plan_reason/
            );
        });
    });

    test('scope: a manager cannot plan a position outside the people they govern', async () => {
        await inRolledBackTx(async () => {
            const expat = await pick(`e.nationality = 'France'`);
            const mgr = await db.get(
                `SELECT m.id FROM employees m
                  WHERE m.is_active = true
                    AND NOT EXISTS (SELECT 1 FROM employees r WHERE r.supervisor_id = m.id OR r.manager_id = m.id)
                  ORDER BY m.id LIMIT 1`
            );
            await expect(
                Nat.createPlan(
                    { userType: 'manager', id: Number(mgr.id) },
                    { incumbentEmployeeId: expat, targetDate: '2027-06-30' }
                )
            ).rejects.toMatchObject({ code: 'LC_FORBIDDEN' });
        });
    });

    test('regulator pack: snapshot adds up, draft → published is frozen, a new version supersedes, nothing is deleted', async () => {
        await inRolledBackTx(async () => {
            const cid = Number((await db.get(`SELECT id FROM countries WHERE code = 'CI'`)).id);
            const { id: v1 } = await Reports.generateDraft(SUPER, {
                countryId: cid,
                periodType: 'quarter',
                periodLabel: '2026-Q3',
            });
            // Regenerating a draft refreshes the SAME row.
            const again = await Reports.generateDraft(SUPER, {
                countryId: cid,
                periodType: 'quarter',
                periodLabel: '2026-q3',
            });
            expect(again.id).toBe(v1);

            const pack = await Reports.get(SUPER, v1);
            expect(pack).toMatchObject({
                state: 'draft',
                version: 1,
                templateCode: 'CI',
                periodLabel: '2026-Q3',
            });
            const w = pack.snapshot.workforce;
            const direct = await db.get(
                `SELECT count(*)::int AS n,
                        count(*) FILTER (WHERE btrim(COALESCE(e.nationality, '')) = '')::int AS blank,
                        count(*) FILTER (WHERE e.nationality = 'Ivory Coast')::int AS ivorian
                   FROM employees e JOIN sites s ON s.id = e.site_id
                  WHERE e.is_active = true AND s.country_id = ?`,
                [cid]
            );
            expect(w.total.headcount).toBe(direct.n);
            expect(w.total.nationals + w.total.expats + w.total.unspecified).toBe(direct.n);
            expect(w.total.unspecified).toBe(direct.blank);
            expect(w.total.nationals).toBe(direct.ivorian);
            const levelSum = w.byLevel.reduce((a, r) => a + r.headcount, 0);
            expect(levelSum).toBe(direct.n);
            expect(pack.snapshot.meta).toMatchObject({
                countryCode: 'CI',
                periodStart: '2026-07-01',
                periodEnd: '2026-10-01',
            });

            await Reports.publish(SUPER, v1);
            await expect(Reports.publish(SUPER, v1)).rejects.toMatchObject({
                code: 'LC_PACK_NOT_DRAFT',
            });
            // Frozen: the database itself refuses a content change or a deletion.
            await expectRefused(
                `UPDATE lc_regulatory_packs SET snapshot = '{}'::jsonb WHERE id = ?`,
                [v1],
                /immutable/
            );
            await expectRefused(
                `DELETE FROM lc_regulatory_packs WHERE id = ?`,
                [v1],
                /never deleted/
            );

            // A new version: draft v2, published → v1 superseded, pointing at v2.
            const { id: v2 } = await Reports.generateDraft(SUPER, {
                countryId: cid,
                periodType: 'quarter',
                periodLabel: '2026-Q3',
            });
            expect(v2).not.toBe(v1);
            await Reports.publish(SUPER, v2);
            const rows = await db.all(
                `SELECT id, version, state, superseded_by_pack_id FROM lc_regulatory_packs
                  WHERE country_id = ? AND period_label = '2026-Q3' ORDER BY version`,
                [cid]
            );
            expect(rows.map((r) => [Number(r.version), r.state])).toEqual([
                [1, 'superseded'],
                [2, 'published'],
            ]);
            expect(Number(rows[0].supersededByPackId)).toBe(v2);
            await expectRefused(
                `UPDATE lc_regulatory_packs SET state = 'published' WHERE id = ?`,
                [v1],
                /final/
            );

            // A draft may be discarded — with a reason — and stays on record.
            const { id: v3 } = await Reports.generateDraft(SUPER, {
                countryId: cid,
                periodType: 'quarter',
                periodLabel: '2026-Q3',
            });
            await Reports.discard(SUPER, v3, 'Erreur de période');
            expect((await Reports.get(SUPER, v3)).state).toBe('discarded');

            // The exports render from the stored snapshot.
            const buf = await Reports.toXlsx(await Reports.get(SUPER, v2), (k) => k);
            expect(buf.byteLength).toBeGreaterThan(1000);
        });
    });

    test('regulator pack: a site-scoped or manager account cannot produce a country pack', async () => {
        await inRolledBackTx(async () => {
            const cid = Number((await db.get(`SELECT id FROM countries WHERE code = 'CI'`)).id);
            await expect(
                Reports.generateDraft(
                    { userType: 'manager', id: 1 },
                    { countryId: cid, periodType: 'year', periodLabel: '2026' }
                )
            ).rejects.toMatchObject({ code: 'LC_FORBIDDEN' });
            const local = await db.get(
                `SELECT a.id FROM admins a
                  WHERE a.role = 'localadmin'
                    AND NOT EXISTS (SELECT 1 FROM admin_scopes s WHERE s.admin_id = a.id AND s.scope_type = 'country')
                  ORDER BY a.id LIMIT 1`
            );
            if (local) {
                await expect(
                    Reports.generateDraft(
                        {
                            userType: 'admin',
                            role: 'localadmin',
                            id: Number(local.id),
                            permissions: ['manage_compliance'],
                        },
                        { countryId: cid, periodType: 'year', periodLabel: '2026' }
                    )
                ).rejects.toMatchObject({ code: 'LC_FORBIDDEN' });
            }
        });
    });
});
