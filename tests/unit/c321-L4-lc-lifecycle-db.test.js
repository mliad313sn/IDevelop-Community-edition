'use strict';
/**
 * 3.23.21 lane L4 — F2 (nationalisation plans on leaver/mover), F3 (exact figures
 * in the PUBLISHED pack by recorded choice), F4 (unspecified nationality share,
 * publish block, « non mesuré » rows) and F11 (leaver notice leftovers, legal
 * hold before departure). Executed on idevelop_fixtures inside ONE transaction that
 * also applies migrations 149 + 157 (idempotent) and is always rolled back.
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
    KIND_META: { 'lifecycle.reports_to_reassign': {} },
}));
const db = HAS_DB ? require('../../src/config/database') : null;
const Nat = HAS_DB ? require('../../src/services/NationalisationService') : null;
const Reports = HAS_DB ? require('../../src/services/LocalContentReportService') : null;
const L = HAS_DB ? require('../../src/services/LifecycleService') : null;
const N = require('../../src/services/NotificationService');
const MIG = ['149_local_content_nationalisation.sql', '157_employee_legal_hold.sql'].map((f) =>
    fs.readFileSync(path.join(__dirname, '../../db/postgres', f), 'utf8')
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ROLLBACK = new Error('__L4_ROLLBACK__');
async function inRolledBackTx(fn) {
    try {
        await db.runTransaction(async () => {
            for (const m of MIG) await db._txStore.getStore().query(m);
            await fn();
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
}

const CI = `(SELECT id FROM countries WHERE code = 'CI')`;
async function pick(where, notIn = []) {
    const r = await db.get(
        `SELECT e.id FROM employees e JOIN sites s ON s.id = e.site_id
          WHERE e.is_active = true AND e.role_id IS NOT NULL AND s.country_id = ${CI} AND ${where}
            ${notIn.length ? `AND e.id NOT IN (${notIn.map(Number).join(',')})` : ''}
          ORDER BY e.id LIMIT 1`
    );
    return r ? Number(r.id) : null;
}

suite('L4 — local content + leaver cascade on the real schema (rolled back)', () => {
    let SUPER;
    beforeAll(async () => {
        const a = await db.get(
            `SELECT id FROM admins WHERE role = 'superadmin' ORDER BY id LIMIT 1`
        );
        SUPER = { userType: 'admin', role: 'superadmin', id: Number(a.id) };
    });

    test('F2: a successor who left is never counted; leaver / mover flag the plan for a decision', async () => {
        await inRolledBackTx(async () => {
            const expat = await pick(`e.nationality = 'France'`);
            const nat1 = await pick(`e.nationality = 'Ivory Coast'`, [expat]);
            const nat2 = await pick(`e.nationality = 'Ivory Coast'`, [expat, nat1]);
            const { id: planId } = await Nat.createPlan(SUPER, {
                incumbentEmployeeId: expat,
                targetDate: '2028-06-30',
            });
            await Nat.addSuccessor(SUPER, planId, nat1);
            await Nat.addSuccessor(SUPER, planId, nat2);
            const get = async () =>
                (await Nat.listPlans(SUPER, { today: '2026-09-29' })).find((p) => p.id === planId);
            let plan = await get();
            expect(plan.activeSuccessorCount).toBe(2);
            expect(plan.flags).toEqual([]);

            // nat1 leaves (a real departure through the lifecycle).
            await L.record('leaver', nat1, { actorRef: `admin:${SUPER.id}` });
            plan = await get();
            expect(plan.activeSuccessorCount).toBe(1);
            const s1 = plan.successors.find((s) => s.employeeId === nat1);
            expect(s1).toMatchObject({ state: 'active', left: true, counted: false });
            expect(s1.readinessPercent).toBeNull();
            expect(plan.flags).toContain('successor_left');
            expect(plan.needsDecision).toBe(true);
            let ev = await Nat.events(SUPER, planId);
            expect(ev.map((e) => [e.action, e.reason])).toContainEqual([
                'plan.flagged',
                'successor_left',
            ]);

            // The regulator pack never counts the departed successor either.
            const cid = Number((await db.get(`SELECT id FROM countries WHERE code = 'CI'`)).id);
            const { id: packId } = await Reports.generateDraft(SUPER, {
                countryId: cid,
                periodType: 'quarter',
                periodLabel: '2026-Q3',
            });
            const row = (await Reports.get(SUPER, packId)).snapshot.plans.rows.find(
                (r) => r.planId === planId
            );
            expect(row).toMatchObject({ successorCount: 1, needsDecision: true });

            // The incumbent changes role → flagged (journal + live flag).
            const other = await db.get(
                `SELECT id FROM roles WHERE id <> (SELECT role_id FROM employees WHERE id = ?) ORDER BY id LIMIT 1`,
                [expat]
            );
            const from = (await db.get('SELECT role_id FROM employees WHERE id = ?', [expat]))
                .roleId;
            await db.run('UPDATE employees SET role_id = ? WHERE id = ?', [other.id, expat]);
            await L.onMover({ employeeId: expat, fromRoleId: from, toRoleId: other.id });
            plan = await get();
            expect(plan.flags).toEqual(
                expect.arrayContaining(['incumbent_role_changed', 'successor_left'])
            );
            ev = await Nat.events(SUPER, planId);
            expect(ev.map((e) => e.reason)).toContain('incumbent_role_changed');
            // A departed successor cannot get an IDP.
            await expect(Nat.linkIdp(SUPER, s1.id)).rejects.toMatchObject({
                code: 'LC_SUCCESSOR_LEFT',
            });
        });
    });

    test('F3/F4: exact figures only in the PUBLISHED pack by explicit choice; unspecified share blocks above 10 %', async () => {
        await inRolledBackTx(async () => {
            const bf = Number((await db.get(`SELECT id FROM countries WHERE code = 'BF'`)).id);
            const ci = Number((await db.get(`SELECT id FROM countries WHERE code = 'CI'`)).id);
            const t = (k, o) => (o ? `${k}:${JSON.stringify(o)}` : k);

            // BF: > 10 % unrecorded nationality → refused without acknowledgement.
            const { id: bfPack } = await Reports.generateDraft(SUPER, {
                countryId: bf,
                periodType: 'year',
                periodLabel: '2026',
            });
            const q = Reports.viewModel(await Reports.get(SUPER, bfPack), t).quality;
            expect(q.level).toBe('block');
            expect(q.pct).toBeGreaterThan(10);
            await expect(
                Reports.publish(SUPER, bfPack, { exactFigures: true })
            ).rejects.toMatchObject({
                code: 'LC_UNSPECIFIED_TOO_HIGH',
            });
            expect((await Reports.get(SUPER, bfPack)).state).toBe('draft');
            await Reports.publish(SUPER, bfPack, {
                exactFigures: true,
                acknowledgeUnspecified: true,
            });
            const bfPub = await Reports.get(SUPER, bfPack);
            expect(bfPub.snapshot.meta.publication).toMatchObject({
                exactFigures: true,
                unspecifiedAcknowledged: true,
                decidedByRef: `admin:${SUPER.id}`,
            });

            // CI draft: masked; published WITHOUT the choice: still masked;
            // a new version published WITH the choice: exact.
            const { id: v1 } = await Reports.generateDraft(SUPER, {
                countryId: ci,
                periodType: 'quarter',
                periodLabel: '2026-Q3',
            });
            const draft = await Reports.get(SUPER, v1);
            const masked = (vm) =>
                JSON.stringify(vm.workforce).includes('"< 5"') ||
                JSON.stringify(vm.training).includes('"< 5"');
            const dvm = Reports.viewModel(draft, t);
            expect(dvm.exactFigures).toBe(false);
            expect(masked(dvm)).toBe(true); // the CI fixture has groups of 1-4
            expect(dvm.notMeasured.map((r) => [r.key, r.value])).toEqual([
                ['wage_bill_share', 'localcontent:nm_value'],
                ['training_spend', 'localcontent:nm_value'],
            ]);
            expect(['warn', 'ok']).toContain(dvm.quality.level);

            const r1 = await Reports.publish(SUPER, v1, {});
            expect(r1.exactFigures).toBe(false);
            expect(masked(Reports.viewModel(await Reports.get(SUPER, v1), t))).toBe(true);

            const { id: v2 } = await Reports.generateDraft(SUPER, {
                countryId: ci,
                periodType: 'quarter',
                periodLabel: '2026-Q3',
            });
            await Reports.publish(SUPER, v2, { exactFigures: true });
            const vm2 = Reports.viewModel(await Reports.get(SUPER, v2), t);
            expect(vm2.exactFigures).toBe(true);
            expect(masked(vm2)).toBe(false);
            const snap = (await Reports.get(SUPER, v2)).snapshot;
            expect(vm2.workforce.total.headcount).toBe(snap.workforce.total.headcount);
            const list = await Reports.list(SUPER);
            expect(list.find((p) => Number(p.id) === v2)).toMatchObject({ exactFigures: true });
            expect(list.find((p) => Number(p.id) === v2).snapshot).toBeUndefined();
            // XLSX renders from the same view model.
            expect(
                (await Reports.toXlsx(await Reports.get(SUPER, v2), t)).byteLength
            ).toBeGreaterThan(1000);
        });
    });

    test('F11: the leaver notice names OKRs, authored postings and reviewer assignments; a pre-departure legal hold reaches the retention job', async () => {
        await inRolledBackTx(async () => {
            N.notify.mockClear();
            const X = await pick(`e.supervisor_id IS NOT NULL AND e.nationality IS NOT NULL`);
            const other = await pick('true', [X]);
            const goal = Number(
                (
                    await db.get(
                        `INSERT INTO goals (employee_id, kind, title, status) VALUES (?, 'objective', 'Réduire les arrêts', 'active') RETURNING id`,
                        [X]
                    )
                ).id
            );
            const opp = Number(
                (
                    await db.get(
                        `INSERT INTO opportunities (title, actor_employee_id) VALUES ('Mission audit', ?) RETURNING id`,
                        [X]
                    )
                ).id
            );
            const skill = await db.get('SELECT id FROM skills ORDER BY id LIMIT 1');
            await db.run(
                `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, current_reviewer_id)
                 VALUES (?, ?, 2, 'submitted', 'submitted', ?)`,
                [other, skill.id, X]
            );

            const lo = await L.leaverLeftovers(X);
            expect(lo.okrs.map((g) => g.id)).toContain(goal);
            expect(lo.postings.map((o) => o.id)).toContain(opp);
            expect(lo.reviewerAssignments.pendingReviews).toContainEqual({
                employeeId: other,
                count: 1,
            });

            // Legal hold BEFORE departure, on the employee.
            await expect(
                L.setEmployeeLegalHold(X, { hold: true, reason: '' })
            ).rejects.toMatchObject({
                code: 'reason_required',
            });
            await L.setEmployeeLegalHold(X, {
                hold: true,
                reason: 'Contentieux prud’homal',
                actorRef: `admin:${SUPER.id}`,
            });

            await L.record('leaver', X, { actorRef: `admin:${SUPER.id}` });

            const job = await db.get(
                'SELECT legal_hold_at, legal_hold_reason FROM pii_cleanup_jobs WHERE employee_id = ?',
                [X]
            );
            expect(job).not.toBeNull();
            expect(job.legalHoldAt).not.toBeNull();
            expect(job.legalHoldReason).toBe('Contentieux prud’homal');

            const ev = await db.get(
                `SELECT payload FROM lifecycle_events WHERE employee_id = ? AND kind = 'leaver' ORDER BY id DESC LIMIT 1`,
                [X]
            );
            expect(ev.payload.leftovers.okrs.map((g) => g.id)).toContain(goal);
            const sent = N.notify.mock.calls
                .map((c) => c[0])
                .filter((n) => n.payload && n.payload.leftovers);
            expect(sent.length).toBeGreaterThan(0);
            expect(sent[0].payload.leftovers).toMatchObject({
                okrIds: expect.arrayContaining([goal]),
                postingIds: expect.arrayContaining([opp]),
            });
            expect(sent[0].payload.leftovers.counts.reviews).toBeGreaterThanOrEqual(1);
            expect(sent[0].payload.reason).toMatch(/OKR/);
        });
    });
});

describe('L4 — pure helpers', () => {
    const R = require('../../src/services/LocalContentReportService');
    test('unspecified share thresholds (2 % warn, 10 % block)', () => {
        expect(R.unspecifiedShare({ headcount: 100, unspecified: 2 }).level).toBe('ok');
        expect(R.unspecifiedShare({ headcount: 100, unspecified: 3 }).level).toBe('warn');
        expect(R.unspecifiedShare({ headcount: 100, unspecified: 10 }).level).toBe('warn');
        expect(R.unspecifiedShare({ headcount: 100, unspecified: 11 })).toMatchObject({
            level: 'block',
            pct: 11,
        });
        expect(R.unspecifiedShare({ headcount: 0, unspecified: 0 })).toMatchObject({
            level: 'empty',
            pct: null,
        });
    });
    test('exact figures only for a published/superseded pack whose publication says so', () => {
        const snap = (pub) => ({ meta: { publication: pub } });
        expect(R.isExactFigures({ state: 'draft' }, snap({ exactFigures: true }))).toBe(false);
        expect(R.isExactFigures({ state: 'published' }, snap({ exactFigures: false }))).toBe(false);
        expect(R.isExactFigures({ state: 'published' }, snap(undefined))).toBe(false);
        expect(R.isExactFigures({ state: 'published' }, snap({ exactFigures: true }))).toBe(true);
        expect(R.isExactFigures({ state: 'superseded' }, snap({ exactFigures: true }))).toBe(true);
    });
});
