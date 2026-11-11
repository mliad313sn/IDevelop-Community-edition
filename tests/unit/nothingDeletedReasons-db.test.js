'use strict';
/**
 * SA-43: nothing is deleted, every decision says who, when and why. Migration
 * 180 over the real schema, every scenario inside one rolled-back transaction,
 * the migration applied twice inside it (idempotent).
 *
 *   - a successor is REMOVED (state, who, when, why), never deleted; the
 *     coverage view, the plan and the bench count ignore it; the automatic
 *     seed never revives it; a person naming them again does;
 *   - a coverage rule and a planned absence are deactivated with a reason,
 *     never deleted, and the lists skip them;
 *   - a declined uplift records who, when and why; without a reason it is
 *     refused;
 *   - a survey shows results only once closed, and a band while open;
 *   - erasure replaces the reasons written about the person ('[erased]'),
 *     keeps the actors, states and dates, and exports them first.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: async () => ({}),
    enqueueBulkInApp: async () => ({}),
}));
const mockLog = jest.fn(async () => {});
jest.mock('../../src/services/LogService', () => ({ log: (...a) => mockLog(...a) }));

const db = HAS_DB ? require('../../src/config/database') : null;
const MIG_180 = fs.readFileSync(
    path.join(__dirname, '..', '..', 'db', 'postgres', '180_review_fixes_modules.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});
beforeEach(() => {
    mockLog.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function inRolledBackTx(fn) {
    let result = null;
    let error = null;
    await db
        .runTransaction(async () => {
            try {
                await db._client().query(MIG_180);
                await db._client().query(MIG_180); // idempotent
                result = await fn();
            } catch (e) {
                error = e;
            }
            throw new Error('__ROLLBACK__');
        })
        .catch((e) => {
            if (!/__ROLLBACK__/.test(e.message)) throw e;
        });
    if (error) throw error;
    return result;
}
async function attempt(fn) {
    try {
        await db.runInSavepoint(fn);
        return null;
    } catch (e) {
        return e;
    }
}

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
let seq = 0;
async function person() {
    const tpl = await db.get(
        'SELECT site_id, department_id, service_id, role_id FROM employees ORDER BY id LIMIT 1'
    );
    seq += 1;
    const r = await db.get(
        `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                service_id, role_id, is_active)
         VALUES (?, 'Soft', ?, ?, ?, ?, ?, true) RETURNING id`,
        [
            `SFT-${Date.now()}-${seq}`,
            `State ${seq}`,
            tpl.siteId,
            tpl.departmentId,
            tpl.serviceId,
            tpl.roleId,
        ]
    );
    return Number(r.id);
}

suite('migration 180: soft states over the real schema', () => {
    test('a successor is removed, not deleted; view, plan and seed honour it; naming them again revives', async () => {
        const out = await inRolledBackTx(async () => {
            const Cont = require('../../src/services/ContinuityService');
            const cand = await person();
            const role = await db.get('SELECT id FROM roles ORDER BY id LIMIT 1');
            await db.run(
                `INSERT INTO role_criticality (role_id, criticality_score, vacancy_risk)
                 VALUES (?, 5, 'high') ON CONFLICT (role_id) DO UPDATE SET criticality_score = 5`,
                [role.id]
            );
            await db.run(
                `UPDATE succession_plans SET status = 'archived' WHERE position_role_id = ? AND status <> 'archived'`,
                [role.id]
            );
            const plan = await Cont.ensurePlan(Number(role.id), {});
            const s = await Cont.addSuccessor(Number(plan.id), cand, null);
            const benchBefore = await db.get(
                'SELECT bench_depth FROM v_continuity_coverage WHERE plan_id = ?',
                [plan.id]
            );
            const r = {};
            r.noReason = await attempt(() => Cont.removeSuccessor(Number(s.id), { reason: ' ' }));
            r.removed = await Cont.removeSuccessor(Number(s.id), {
                reason: 'Moved to another site',
                actorRef: 'admin:1',
            });
            r.row = await db.get(
                'SELECT state, removed_by AS "by", removed_reason AS "why", (removed_at IS NOT NULL) AS "at" FROM successors WHERE id = ?',
                [s.id]
            );
            r.again = await Cont.removeSuccessor(Number(s.id), { reason: 'x' });
            r.benchBefore = Number(benchBefore.benchDepth);
            r.benchAfter = Number(
                (
                    await db.get(
                        'SELECT bench_depth FROM v_continuity_coverage WHERE plan_id = ?',
                        [plan.id]
                    )
                ).benchDepth
            );
            r.planSuccessors = (await Cont.getPlan(Number(plan.id))).successors.length;
            r.listed = (await Cont.listPlans(null)).find((p) => Number(p.id) === Number(plan.id));
            r.top = await Cont.topSuccessorForRole(Number(role.id));
            r.dbGuard = await attempt(() =>
                db.run(
                    `UPDATE successors SET state = 'removed', removed_reason = NULL WHERE id = ?`,
                    [s.id]
                )
            );
            r.bandOnRemoved = await Cont.setSuccessorBand(Number(s.id), 'ready_now');
            await Cont.addSuccessor(Number(plan.id), cand, null);
            r.revived = await db.get(
                'SELECT state, removed_reason AS "why" FROM successors WHERE id = ?',
                [s.id]
            );
            r.count = Number(
                (await db.get('SELECT COUNT(*) AS n FROM successors WHERE id = ?', [s.id])).n
            );
            return r;
        });
        expect(out.noReason && out.noReason.code).toBe('reason_required');
        expect(out.removed).toMatchObject({ id: expect.anything() });
        expect(out.row).toEqual({
            state: 'removed',
            by: 'admin:1',
            why: 'Moved to another site',
            at: true,
        });
        expect(out.again).toBeNull(); // already removed: nothing matched
        expect(out.benchBefore).toBe(1);
        expect(out.benchAfter).toBe(0);
        expect(out.planSuccessors).toBe(0);
        expect(Number(out.listed.benchDepth)).toBe(0);
        expect(out.top).toBeNull();
        expect(out.dbGuard && out.dbGuard.message).toMatch(/chk_successor_removed/);
        expect(out.bandOnRemoved).toBeNull();
        expect(out.revived).toEqual({ state: 'active', why: null });
        expect(out.count).toBe(1);
    });

    test('a coverage rule and a planned absence are deactivated with a reason, never deleted', async () => {
        const out = await inRolledBackTx(async () => {
            const Cov = require('../../src/services/CoverageService');
            const emp = await db.get(
                'SELECT id, site_id AS "siteId" FROM employees WHERE is_active AND site_id IS NOT NULL ORDER BY id LIMIT 1'
            );
            const sk = await db.get('SELECT id FROM skills ORDER BY id LIMIT 1');
            const rule = await Cov.createRule(
                {
                    name: 'Soft state rule',
                    siteId: emp.siteId,
                    skillId: Number(sk.id),
                    minLevel: 2,
                    minHeadcount: 1,
                },
                1
            );
            const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
            const abs = await Cov.addAbsence(
                { employeeId: Number(emp.id), startsOn: day(1), endsOn: day(3) },
                1
            );
            const r = {};
            r.ruleNoReason = await attempt(() => Cov.deactivateRule(rule.id, ''));
            r.absNoReason = await attempt(() => Cov.deactivateAbsence(abs.id, null));
            r.listedBefore = (await Cov.listAbsences(null)).some(
                (a) => Number(a.id) === Number(abs.id)
            );
            await Cov.deactivateRule(rule.id, 'Duplicate rule', 'admin:1');
            await Cov.deactivateAbsence(abs.id, 'Leave cancelled', 'employee:5');
            r.rule = await db.get(
                'SELECT is_active AS "on", deactivated_reason AS "why", deactivated_by AS "by" FROM coverage_rules WHERE id = ?',
                [rule.id]
            );
            r.abs = await db.get(
                'SELECT is_active AS "on", deactivated_reason AS "why", deactivated_by AS "by" FROM planned_absences WHERE id = ?',
                [abs.id]
            );
            r.inStatus = (await Cov.status(null)).some((x) => Number(x.ruleId) === Number(rule.id));
            r.listedAfter = (await Cov.listAbsences(null)).some(
                (a) => Number(a.id) === Number(abs.id)
            );
            r.dbGuard = await attempt(() =>
                db.run(`UPDATE planned_absences SET deactivated_reason = ' ' WHERE id = ?`, [
                    abs.id,
                ])
            );
            return r;
        });
        expect(out.ruleNoReason && out.ruleNoReason.code).toBe('reason_required');
        expect(out.absNoReason && out.absNoReason.code).toBe('reason_required');
        expect(out.listedBefore).toBe(true);
        expect(out.rule).toEqual({ on: false, why: 'Duplicate rule', by: 'admin:1' });
        expect(out.abs).toEqual({ on: false, why: 'Leave cancelled', by: 'employee:5' });
        expect(out.inStatus).toBe(false);
        expect(out.listedAfter).toBe(false);
        expect(out.dbGuard && out.dbGuard.message).toMatch(/chk_absence_deactivated/);
    });

    test('a declined uplift records who, when and why; without a reason it is refused', async () => {
        const out = await inRolledBackTx(async () => {
            const Lms = require('../../src/services/LmsService');
            const emp = await person();
            const c = await db.get(
                `INSERT INTO lms_completions (provider, external_ref, employee_id, applied, review_reason)
                 VALUES ('manual', 'soft-state-' || floor(random() * 1e9)::text, ?, false, 'awaiting_supervisor')
                 RETURNING id`,
                [emp]
            );
            const r = {};
            const noWhy = await attempt(() => Lms.decideUplift(SUPER, Number(c.id), 'decline', {}));
            r.noWhy = noWhy && { status: noWhy.status, code: noWhy.code };
            await Lms.decideUplift(SUPER, Number(c.id), 'decline', {
                reason: 'Course outside the role',
            });
            r.row = await db.get(
                `SELECT review_reason AS "rr", decided_by_ref AS "by", (decided_at IS NOT NULL) AS "at",
                        decision_reason AS "why" FROM lms_completions WHERE id = ?`,
                [c.id]
            );
            r.audit = mockLog.mock.calls.map((x) => x[0].action);
            r.dbGuard = await attempt(() =>
                db.run('UPDATE lms_completions SET decision_reason = NULL WHERE id = ?', [c.id])
            );
            return r;
        });
        expect(out.noWhy).toEqual({ status: 400, code: 'upl_err_reason_required' });
        expect(out.row).toEqual({
            rr: 'declined_by_supervisor',
            by: 'admin:1',
            at: true,
            why: 'Course outside the role',
        });
        expect(out.audit).toContain('LMS_UPLIFT_DECLINED');
        expect(out.dbGuard && out.dbGuard.message).toMatch(/chk_lms_decline_reason/);
    });
});

suite('surveys: results only once closed, a band while open', () => {
    test('open: no results and no count, only the band; closed: the results', async () => {
        const out = await inRolledBackTx(async () => {
            const Sv = require('../../src/services/SurveyService');
            const s = await Sv.create({
                title: 'Soft state pulse',
                minResponses: 5,
                createdByAdminId: 1,
                questions: [{ text: 'How was the week?', qtype: 'scale' }],
            });
            const q = await db.get('SELECT id FROM survey_questions WHERE survey_id = ?', [s.id]);
            await db.run("UPDATE surveys SET state = 'open', opened_at = now() WHERE id = ?", [
                s.id,
            ]);
            const answer = (k) =>
                db.run(
                    `INSERT INTO survey_responses (survey_id, question_id, score, respondent_key)
                     VALUES (?, ?, 4, ?)`,
                    [s.id, q.id, `k${k}`]
                );
            for (let i = 0; i < 4; i++) await answer(i);
            const r = {};
            r.openUnder = await Sv.publishedResults(s.id);
            r.listUnder = (await Sv.list(null)).find((x) => Number(x.id) === Number(s.id));
            await answer(4);
            await answer(5);
            r.openAtLeast = await Sv.publishedResults(s.id);
            r.listAtLeast = (await Sv.list(null)).find((x) => Number(x.id) === Number(s.id));
            await db.run("UPDATE surveys SET state = 'closed' WHERE id = ?", [s.id]);
            r.closed = await Sv.publishedResults(s.id);
            r.listClosed = (await Sv.list(null)).find((x) => Number(x.id) === Number(s.id));
            return r;
        });
        expect(out.openUnder).toMatchObject({ closed: false, band: 'under', results: [] });
        expect(out.openUnder.threshold).toBeGreaterThanOrEqual(5);
        expect(out.listUnder).toMatchObject({ respondents: null, respondentsBand: 'under' });
        expect(out.openAtLeast).toMatchObject({ closed: false, results: [] });
        expect(out.listAtLeast.respondents).toBeNull(); // never a count while open
        expect(out.closed.closed).toBe(true);
        expect(Array.isArray(out.closed.results)).toBe(true);
        expect(out.closed.results.length).toBeGreaterThan(0);
        expect(Number(out.listClosed.respondents)).toBe(6);
    });
});

suite('erasure: the reasons written about the person are replaced, the decisions stay', () => {
    test('absence and uplift reasons read [erased] after export; a rule reason stays', async () => {
        const out = await inRolledBackTx(async () => {
            const DSR = require('../../src/services/DSRService');
            const Cov = require('../../src/services/CoverageService');
            const emp = await person();
            const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
            const abs = await Cov.addAbsence(
                { employeeId: emp, startsOn: day(1), endsOn: day(2) },
                1
            );
            await Cov.deactivateAbsence(abs.id, 'Personal matter of the person', 'admin:1');
            const c = await db.get(
                `INSERT INTO lms_completions (provider, external_ref, employee_id, applied, review_reason,
                                              decided_by_ref, decided_at, decision_reason)
                 VALUES ('manual', 'soft-erase-' || floor(random() * 1e9)::text, ?, false,
                         'declined_by_supervisor', 'admin:1', now(), 'Weak result on the course')
                 RETURNING id`,
                [emp]
            );
            const sk = await db.get('SELECT id FROM skills ORDER BY id LIMIT 1');
            const site = await db.get('SELECT site_id FROM employees WHERE id = ?', [emp]);
            const rule = await Cov.createRule(
                {
                    name: 'Erase rule',
                    siteId: site.siteId,
                    skillId: Number(sk.id),
                    minHeadcount: 1,
                },
                1
            );
            await Cov.deactivateRule(rule.id, 'Rule replaced by a site rule', 'admin:1');
            const exported = await DSR.export(emp);
            await DSR.erase(emp, 1, { reason: 'test erasure' });
            return {
                exported,
                abs: await db.get(
                    'SELECT is_active, deactivated_reason, deactivated_at FROM planned_absences WHERE id = ?',
                    [abs.id]
                ),
                lms: await db.get(
                    'SELECT decided_by_ref, decided_at, decision_reason FROM lms_completions WHERE id = ?',
                    [c.id]
                ),
                rule: await db.get('SELECT deactivated_reason FROM coverage_rules WHERE id = ?', [
                    rule.id,
                ]),
            };
        });
        expect(JSON.stringify(out.exported.plannedAbsences)).toContain(
            'Personal matter of the person'
        );
        expect(JSON.stringify(out.exported.lmsUpliftDecisions)).toContain(
            'Weak result on the course'
        );
        expect(out.abs.isActive).toBe(false);
        expect(out.abs.deactivatedReason).toBe('[erased]');
        expect(out.abs.deactivatedAt).not.toBeNull();
        expect(out.lms.decisionReason).toBe('[erased]');
        expect(out.lms.decidedByRef).toBe('admin:1');
        expect(out.lms.decidedAt).not.toBeNull();
        expect(out.rule.deactivatedReason).toBe('Rule replaced by a site rule');
    });
});
