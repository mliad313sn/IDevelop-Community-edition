'use strict';
/**
 * SA-42: the SuperAdmin "Reset the assessment" on the maintenance panel, on the
 * real test database, every case inside one rolled-back transaction.
 *
 * MaintenanceService.resetAssessment → SelfAssessmentWorkflowService.resetForRedo:
 *   - SuperAdmin only; reason mandatory; a whole-campaign reset needs the
 *     employee number typed again;
 *   - each resettable state goes back to the draft pair (status and
 *     workflow_state), approval and review stamps lifted, lock provisional;
 *   - the self-rating and notes are kept (prefill); the official level is
 *     unchanged;
 *   - the review row goes back to 'pending' with decision and rating cleared,
 *     the cleared values in the event detail;
 *   - an open dispute is closed 'resolved', named to the SuperAdmin, with the
 *     employee's words untouched; a pending change request is 'withdrawn'
 *     with decision_reason 'reset_by_superadmin';
 *   - one 'reset_for_redo' event per row, a MAINT_RESET_ASSESSMENT audit line
 *     and an 'assessment_reset' movement (migration 181);
 *   - a closed campaign is refused (409, the gate's sentence);
 *   - nothing is deleted.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

const mockLog = jest.fn(async () => {});
jest.mock('../../src/services/LogService', () => ({ log: (...a) => mockLog(...a) }));
const mockNotify = jest.fn(async () => {});
jest.mock('../../src/services/NotificationService', () => ({
    notify: (...a) => mockNotify(...a),
}));

const MIG_181 = fs.readFileSync(
    path.join(__dirname, '..', '..', 'db', 'postgres', '181_assessment_reset_movement_kind.sql'),
    'utf8'
);
const db = HAS_DB ? require('../../src/config/database') : null;
beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});
beforeEach(() => {
    mockLog.mockClear();
    mockNotify.mockClear();
});

async function inRolledBackTx(fn) {
    let result = null;
    let error = null;
    await db
        .runTransaction(async () => {
            try {
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

async function tryStep(fn) {
    try {
        await db.runInSavepoint(fn);
        return true;
    } catch (e) {
        return e.message;
    }
}

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const M = () => require('../../src/services/MaintenanceService');

let seq = 0;
/** A fresh person (copying the first employee's org placement). */
async function person() {
    const tpl = await db.get(
        'SELECT site_id, department_id, service_id, role_id FROM employees ORDER BY id LIMIT 1'
    );
    seq += 1;
    const num = `RST-${Date.now()}-${seq}`;
    const r = await db.get(
        `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                service_id, role_id, is_active)
         VALUES (?, 'Reset', ?, ?, ?, ?, ?, true) RETURNING id`,
        [num, `Fixture ${seq}`, tpl.siteId, tpl.departmentId, tpl.serviceId, tpl.roleId]
    );
    return { id: Number(r.id), num };
}
/** A fresh skill, so a round never collides with the seed's rows. */
async function skill() {
    const d = await db.get('SELECT id FROM domains ORDER BY id LIMIT 1');
    seq += 1;
    const r = await db.get(`INSERT INTO skills (domain_id, name) VALUES (?, ?) RETURNING id`, [
        d.id,
        `Reset fixture skill ${seq}`,
    ]);
    return Number(r.id);
}

const LEGACY = {
    submitted: 'submitted',
    under_review: 'submitted',
    reviewed: 'reviewed',
    approved: 'approved',
    rejected: 'rejected',
    changes_requested: 'draft',
    arbitration: 'submitted',
    draft: 'draft',
};

/**
 * Plant one current round in `state`, out of campaign unless `cycleId` is
 * given, with a review row and an official level.
 */
async function plant(state, { cycleId = null, who = null, dispute = false, cr = false } = {}) {
    const e = who || (await person());
    const s = await skill();
    const r = await db.get(
        `INSERT INTO self_assessment_rounds
             (employee_id, skill_id, self_rated_level, notes, status, workflow_state, cycle_id,
              submitted_at, approved_at, approved_by_ref, locked_state)
         VALUES (?, ?, 3, 'my note', ?::self_assessment_state, ?, ?, now(),
                 CASE WHEN ? = 'approved' THEN now() END,
                 CASE WHEN ? = 'approved' THEN 'admin:1' END,
                 (CASE WHEN ? = 'approved' THEN 'finalized' ELSE 'provisional' END)::locked_state)
         RETURNING id`,
        [e.id, s, LEGACY[state], state, cycleId, state, state, state]
    );
    const rev = await db.get(
        `INSERT INTO supervisor_reviews (self_assessment_id, employee_id, skill_id, supervisor_rated_level,
                                         gap, reviewed_by, status, decision, decided_at)
         VALUES (?, ?, ?, 2, -1, (SELECT id FROM employees ORDER BY id LIMIT 1), ?, 'approve', now())
         RETURNING id`,
        [r.id, e.id, s, dispute ? 'disputed' : 'completed']
    );
    await db.run(
        `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
         VALUES (?, ?, 2, 1, 'official')
         ON CONFLICT (employee_id, skill_id) DO UPDATE SET current_level = 2`,
        [e.id, s]
    );
    let disputeId = null;
    if (dispute) {
        const d = await db.get(
            `INSERT INTO assessment_disputes (supervisor_review_id, employee_id, level, state, reason)
             VALUES (?, ?, 'L0', 'open', 'I dispute this level') RETURNING id`,
            [rev.id, e.id]
        );
        disputeId = Number(d.id);
    }
    let crId = null;
    if (cr) {
        const c = await db.get(
            `INSERT INTO assessment_change_requests
                 (self_assessment_id, employee_id, requester_ref, requester_role, reason, target_state)
             VALUES (?, ?, ?, 'employee', 'please reopen it', ?) RETURNING id`,
            [r.id, e.id, `employee:${e.id}`, state]
        );
        crId = Number(c.id);
    }
    return {
        employeeId: e.id,
        num: e.num,
        skillId: s,
        id: Number(r.id),
        reviewId: Number(rev.id),
        disputeId,
        crId,
    };
}

const counts = async () =>
    db.get(`SELECT (SELECT count(*) FROM self_assessment_rounds)::int AS r,
                   (SELECT count(*) FROM supervisor_reviews)::int AS sr,
                   (SELECT count(*) FROM assessment_disputes)::int AS d,
                   (SELECT count(*) FROM assessment_change_requests)::int AS cr,
                   (SELECT count(*) FROM skill_assessments)::int AS sk`);

async function campaign(status) {
    seq += 1;
    const past = status === 'closed';
    return db.get(
        `INSERT INTO assessment_cycles (code, label, status, opened_at, closes_at, created_by)
         VALUES (?, ?, ?::cycle_status, now() - interval '60 days',
                 now() + (CASE WHEN ? THEN interval '-30 days' ELSE interval '30 days' END), 1)
         RETURNING id`,
        [`RST-${status}-${seq}`, `Reset campaign ${seq}`, status, past]
    );
}

suite('reset for redo: only the SuperAdmin', () => {
    test.each([
        ['a manager', { id: 50, userType: 'manager' }],
        ['an employee', { id: 70, userType: 'employee' }],
        ['a local admin', { id: 2, userType: 'admin', role: 'localadmin' }],
        ['a viewer', { id: 3, userType: 'admin', role: 'viewer' }],
    ])('%s is refused, nothing changes', async (_l, who) => {
        const out = await inRolledBackTx(async () => {
            const p = await plant('approved');
            const e = await M()
                .resetAssessment(who, { assessmentId: p.id, reason: 'x' })
                .catch((x) => x);
            const row = await db.get(
                'SELECT workflow_state FROM self_assessment_rounds WHERE id = ?',
                [p.id]
            );
            return { e, row };
        });
        expect(out.e).toBeInstanceOf(Error);
        expect(out.e.userMessage).toBe('maintenance_superadmin_only');
        expect(out.row.workflowState).toBe('approved');
    });
    test('no reason: refused', async () => {
        const out = await inRolledBackTx(async () => {
            const p = await plant('approved');
            return M()
                .resetAssessment(SUPER, { assessmentId: p.id, reason: '  ' })
                .catch((x) => x);
        });
        expect(out.userMessage).toBe('maintenance_reason_required');
    });
});

suite('reset for redo: every source state', () => {
    test.each([
        'submitted',
        'under_review',
        'reviewed',
        'approved',
        'rejected',
        'changes_requested',
        'arbitration',
    ])(
        '%s → draft pair, self-rating kept, official level unchanged, review pending, trail written, nothing deleted',
        async (state) => {
            const out = await inRolledBackTx(async () => {
                await db._client().query(MIG_181);
                const p = await plant(state);
                const before = await counts();
                const res = await M().resetAssessment(SUPER, {
                    assessmentId: p.id,
                    reason: 'entered against the wrong reading',
                });
                const row = await db.get(
                    `SELECT status::text AS status, workflow_state, self_rated_level, notes, approved_at,
                            approved_by_ref, submitted_at, locked_state::text AS locked
                       FROM self_assessment_rounds WHERE id = ?`,
                    [p.id]
                );
                const rev = await db.get(
                    'SELECT status, decision, supervisor_rated_level, gap, decided_at FROM supervisor_reviews WHERE id = ?',
                    [p.reviewId]
                );
                const off = await db.get(
                    'SELECT current_level FROM skill_assessments WHERE employee_id = ? AND skill_id = ?',
                    [p.employeeId, p.skillId]
                );
                const ev = await db.get(
                    `SELECT actor_type, from_state, to_state, detail FROM self_assessment_events
                      WHERE self_assessment_id = ? AND action = 'reset_for_redo'`,
                    [p.id]
                );
                const mv = await db.all(
                    `SELECT kind, to_label, note, source, actor_ref FROM employee_movements
                      WHERE employee_id = ? AND source = 'maintenance' ORDER BY id`,
                    [p.employeeId]
                );
                return { p, res, row, rev, off, ev, mv, before, after: await counts() };
            });
            expect(out.res.ok).toBe(true);
            expect(out.res.reset).toHaveLength(1);
            expect(out.row.status).toBe('draft');
            expect(out.row.workflowState).toBe('draft');
            expect(out.row.selfRatedLevel).toBe(3);
            expect(out.row.notes).toBe('my note');
            expect(out.row.approvedAt).toBeNull();
            expect(out.row.approvedByRef).toBeNull();
            expect(out.row.submittedAt).not.toBeNull(); // the first submission stays dated
            expect(out.row.locked).toBe('provisional');
            expect(out.rev.status).toBe('pending');
            expect(out.rev.decision).toBeNull();
            expect(out.rev.supervisorRatedLevel).toBeNull();
            expect(Number(out.off.currentLevel)).toBe(2); // official level untouched
            expect(out.ev.actorType).toBe('admin');
            expect(out.ev.fromState).toBe(state);
            expect(out.ev.toState).toBe('draft');
            const d = typeof out.ev.detail === 'string' ? JSON.parse(out.ev.detail) : out.ev.detail;
            expect(d).toEqual(
                expect.objectContaining({
                    superadminOverride: true,
                    reason: 'entered against the wrong reading',
                    officialLevelUnchanged: true,
                })
            );
            expect(d.priorReview).toEqual(
                expect.objectContaining({ supervisorRatedLevel: 2, decision: 'approve' })
            );
            expect(out.after).toEqual(out.before); // nothing inserted or deleted besides the trail
            expect(out.mv).toEqual([
                {
                    kind: 'assessment_reset',
                    toLabel: 'reset for redo',
                    note: 'entered against the wrong reading',
                    source: 'maintenance',
                    actorRef: 'admin:1',
                },
            ]);
            expect(mockLog).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'MAINT_RESET_ASSESSMENT', actorRef: 'admin:1' })
            );
            const audit = mockLog.mock.calls.find(
                ([a]) => a.action === 'MAINT_RESET_ASSESSMENT'
            )[0];
            expect(audit.details).not.toMatch(/Reset Fixture|Fixture \d/); // ids only
            // Neutral notices: no reason text in any payload.
            expect(mockNotify).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'sa.reset_for_redo', userId: out.p.employeeId })
            );
            for (const [n] of mockNotify.mock.calls)
                expect(JSON.stringify(n.payload)).not.toMatch(/wrong reading/);
        }
    );
    test('a draft is left as it is: nothing to reset', async () => {
        const out = await inRolledBackTx(async () => {
            const p = await plant('draft');
            return M()
                .resetAssessment(SUPER, { assessmentId: p.id, reason: 'x' })
                .catch((x) => x);
        });
        expect(out.userMessage).toBe('maintenance_reset_nothing');
    });
});

suite('reset for redo: disputes, change requests, campaigns', () => {
    test('an open dispute is closed and named to the SuperAdmin, the employee’s words untouched', async () => {
        const out = await inRolledBackTx(async () => {
            const p = await plant('arbitration', { dispute: true });
            await M().resetAssessment(SUPER, { assessmentId: p.id, reason: 'wrong campaign' });
            return db.get(
                `SELECT state::text AS state, reason, resolved_at, decided_by_admin_id
                   FROM assessment_disputes WHERE id = ?`,
                [p.disputeId]
            );
        });
        expect(out.state).toBe('resolved');
        expect(out.reason).toBe('I dispute this level');
        expect(out.resolvedAt).not.toBeNull();
        expect(Number(out.decidedByAdminId)).toBe(1);
    });
    test('a pending change request is withdrawn with reason reset_by_superadmin', async () => {
        const out = await inRolledBackTx(async () => {
            const p = await plant('approved', { cr: true });
            await M().resetAssessment(SUPER, { assessmentId: p.id, reason: 'wrong campaign' });
            return db.get(
                'SELECT status, decision_reason, decided_by_ref FROM assessment_change_requests WHERE id = ?',
                [p.crId]
            );
        });
        expect(out.status).toBe('withdrawn');
        expect(out.decisionReason).toBe('reset_by_superadmin');
        expect(out.decidedByRef).toBe('admin:1');
    });
    test('a closed campaign is refused 409 with the gate sentence, nothing written', async () => {
        const out = await inRolledBackTx(async () => {
            const c = await campaign('closed');
            const p = await plant('approved', { cycleId: c.id });
            const e = await M()
                .resetAssessment(SUPER, { assessmentId: p.id, reason: 'x' })
                .catch((x) => x);
            const row = await db.get(
                'SELECT workflow_state FROM self_assessment_rounds WHERE id = ?',
                [p.id]
            );
            return { e, row };
        });
        expect(out.e.status).toBe(409);
        expect(out.e.gate).toBeTruthy();
        expect(out.row.workflowState).toBe('approved');
    });
    test('whole campaign: the employee number is required, then every row resets and submitted_at is cleared', async () => {
        const out = await inRolledBackTx(async () => {
            const c = await campaign('open');
            const who = await person();
            const a = await plant('approved', { cycleId: c.id, who });
            const b = await plant('submitted', { cycleId: c.id, who });
            await db.run(
                `INSERT INTO cycle_participants (cycle_id, employee_id, started_at, submitted_at)
                 VALUES (?, ?, now(), now()) ON CONFLICT DO NOTHING`,
                [c.id, who.id]
            );
            const noNum = await M()
                .resetAssessment(SUPER, {
                    employeeId: who.id,
                    cycleId: c.id,
                    reason: 'campaign to redo',
                })
                .catch((x) => x);
            const res = await M().resetAssessment(SUPER, {
                employeeId: who.id,
                cycleId: c.id,
                reason: 'campaign to redo',
                confirmNumber: who.num,
            });
            const states = await db.all(
                'SELECT workflow_state FROM self_assessment_rounds WHERE id IN (?, ?) ORDER BY id',
                [a.id, b.id]
            );
            const cp = await db.get(
                'SELECT started_at, submitted_at FROM cycle_participants WHERE cycle_id = ? AND employee_id = ?',
                [c.id, who.id]
            );
            const cands = await M().resetCandidates(SUPER, { employeeId: who.id });
            return { noNum, res, states, cp, cands };
        });
        expect(out.noNum.userMessage).toBe('maintenance_reset_confirm_mismatch');
        expect(out.res.scope).toBe('campaign');
        expect(out.res.reset).toHaveLength(2);
        expect(out.states.every((s) => s.workflowState === 'draft')).toBe(true);
        expect(out.cp.submittedAt).toBeNull();
        expect(out.cp.startedAt).not.toBeNull();
        expect(out.cands).toEqual([
            expect.objectContaining({ rows: 2, resettable: 0, status: 'open' }),
        ]);
    });
});

suite('migration 181: the movement CHECK accepts assessment_reset and every former kind', () => {
    const OLD_KINDS = [
        'site',
        'department',
        'service',
        'role',
        'manager',
        'supervisor',
        'status',
        'plan_cancelled',
        'placement_cancelled',
        'assessment_cancelled',
        'account',
    ];
    test('idempotent, existing rows untouched, former kinds accepted, unknown kind refused', async () => {
        const out = await inRolledBackTx(async () => {
            const q =
                'SELECT kind, count(*)::int AS n FROM employee_movements GROUP BY kind ORDER BY kind';
            const before = await db.all(q);
            await db._client().query(MIG_181);
            await db._client().query(MIG_181); // a second run changes nothing
            const after = await db.all(q);
            const def = await db.get(
                `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
                  WHERE conrelid = 'public.employee_movements'::regclass
                    AND conname = 'employee_movements_kind_check'`
            );
            const emp = await db.get('SELECT id FROM employees ORDER BY id LIMIT 1');
            const ins = (kind) =>
                tryStep(() =>
                    db.run(
                        `INSERT INTO employee_movements (employee_id, kind, from_label, to_label, source)
                         VALUES (?, ?, 'a', 'b', 'maintenance')`,
                        [emp.id, kind]
                    )
                );
            const accepted = {};
            for (const k of [...OLD_KINDS, 'assessment_reset']) accepted[k] = await ins(k);
            const bogus = await ins('bogus_kind');
            return { before, after, def: def.d, accepted, bogus };
        });
        expect(out.after).toEqual(out.before);
        expect(out.def).toMatch(/assessment_reset/);
        for (const k of OLD_KINDS) expect([k, out.def.includes(`'${k}'`)]).toEqual([k, true]);
        for (const [k, ok] of Object.entries(out.accepted)) expect([k, ok]).toEqual([k, true]);
        expect(out.bogus).toMatch(/employee_movements_kind_check/);
    });
});
