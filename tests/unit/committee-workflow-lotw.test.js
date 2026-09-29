'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Product-readiness committee — LOT W (assessment workflow), service layer.
 *
 * Every finding below was reproduced against the dev database inside a rolled-back
 * transaction before the fix and re-proven after it. The DB is mocked here; the
 * tests lock the CONTRACT each fix established.
 *
 *  F1  DisputeServiceV2.open(): the caller must be the employee the REVIEW is
 *      about, and the review must be decided ('completed'). employeeFor()
 *      resolves the subject from the review, never from the dispute row.
 *      (measured: attacker 84 opened a dispute on employee 98's review;
 *      employeeFor() = 84; the victim's own open then hit uq_dispute_open_per_review)
 *  F3  arbitrate(approve|reject) finalises supervisor_reviews like every sibling.
 *      (measured: review stayed {"status":"pending","decision":null,"lvl":null})
 *  F4  resolveL0 sets status='completed' (L1/L2 already did).
 *  F5  all three resolve paths recompute gap = decided - self (was "Écart 0").
 *  F6  the L2 SLA never finalises a review with NO rating; it raises HR once.
 *      (measured: 'completed' with lvl null, 'auto_finalized', employee notified)
 *  F8  managerValidate / requestChanges / reject carry guardFrom → STALE_STATE.
 *      (measured: rejected → approved + promoted; approved → changes_requested;
 *       approved → rejected)
 *  F9  'arbitration' may be approved by canManage only; bulk approve skips it.
 * F10  a resolution requires a rating (null → 400).
 * F11  CycleService.close() leaves draft / changes_requested unfinalised.
 * F12  the rating is range-checked (7, "abc", 2.5 → 400, not a driver error).
 *  F2  a row decided in cycle N is editable again when cycle N+1 is open.
 *  F7  migration 105 widens the roster view's "submitted" bucket.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

const mockSkill = { upsert: jest.fn() };
jest.mock('../../src/models/SkillAssessmentModel', () => mockSkill);
// `governs` is the transitive sub-tree test resolveAuthority consults when the
// actor is not the DIRECT supervisor/manager. These cases are all direct links,
// so `false` keeps them testing what they were written to test.
const mockEmployee = { findById: jest.fn(), governs: jest.fn(async () => false) };
jest.mock('../../src/models/EmployeeModel', () => mockEmployee);
const mockSaModel = {
    create: jest.fn(),
    submitAssessment: jest.fn(),
    findByEmployeeId: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(),
    // UAT3 lot 1: the measurement-round accessors (migration 113).
    findCurrentRound: jest.fn(),
    openRound: jest.fn(),
    listRounds: jest.fn(),
};
jest.mock('../../src/models/SelfAssessmentModel', () => mockSaModel);
jest.mock('../../src/models/SupervisorReviewModel', () => ({
    findById: jest.fn(),
    update: jest.fn(),
}));
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (key, def) => def),
}));
const mockNotify = { notify: jest.fn(async () => {}), enqueueBulkInApp: jest.fn(async () => {}) };
jest.mock('../../src/services/NotificationService', () => mockNotify);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
const mockRbac = {
    isSuperAdmin: jest.fn(() => false),
    isLocalAdmin: jest.fn(() => false),
    isViewer: jest.fn(() => false),
    canAccessEmployeeData: jest.fn(async () => true),
    scopeFilter: jest.fn(async () => ({ clause: '', params: [] })),
    adminsWithPermission: jest.fn(async () => [1, 68]),
    getFilteredEmployees: jest.fn(async () => []),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

const Dispute = require('../../src/services/DisputeServiceV2');
const WF = require('../../src/services/SelfAssessmentWorkflowService');
const SAS = require('../../src/services/SelfAssessmentService');
const CycleService = require('../../src/services/CycleService');

const EMP = 98,
    SUP = 90,
    MGR = 136,
    ATTACKER = 84,
    REVIEW = 974,
    SKILL = 318;
const supUser = { id: SUP, userType: 'employee' };
const mgrUser = { id: MGR, userType: 'manager' };

const runCalls = (re) => mockDb.run.mock.calls.filter(([sql]) => re.test(sql));

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockDb.runTransaction.mockReset().mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockReset().mockImplementation(async (fn) => fn());
    mockSkill.upsert.mockReset().mockResolvedValue({});
    mockNotify.notify.mockClear();
    mockRbac.adminsWithPermission.mockClear();
    // `managerType` is part of the real row, not decoration: `manager_id` is
    // polymorphic (employee or admin) and resolveAuthority now reads the
    // discriminator before granting manager authority. The database enforces the
    // pair (chk_employees_manager_pair), so a fixture without it was never a state
    // production can be in.
    mockEmployee.findById
        .mockReset()
        .mockResolvedValue({ id: EMP, supervisorId: SUP, managerId: MGR, managerType: 'employee' });
});

// ---------------------------------------------------------------------------
// DisputeServiceV2
// ---------------------------------------------------------------------------
/** Route db.get by SQL text so the number of lookups cannot make a test pass by accident. */
function wireDispute({
    reviewEmployee = EMP,
    reviewStatus = 'completed',
    reviewLevel = 1,
    reason = 'probe',
} = {}) {
    mockDb.get.mockImplementation(async (sql, params = []) => {
        // open() reads the review WITH the round it judged (campaign, decision
        // dates, superseded_at) — no campaign and no dates here: off-campaign,
        // never decided-too-long-ago, current round.
        if (/SELECT sr\.employee_id, sr\.status, sr\.decided_at, sr\.reviewed_at,/.test(sql))
            return {
                employeeId: reviewEmployee,
                status: reviewStatus,
                cycleId: null,
                supersededAt: null,
            };
        if (
            /sr\.employee_id, sr\.skill_id, sa\.superseded_at\s+FROM supervisor_reviews sr/.test(
                sql
            )
        )
            return { employeeId: EMP, skillId: SKILL, supersededAt: null };
        if (/FROM admins WHERE id = \?/.test(sql))
            return [1, 68].includes(Number(params[0])) ? { id: Number(params[0]) } : undefined;
        if (/FROM admins WHERE username = 'admin'/.test(sql)) return { id: 1 };
        if (/supervisor_review_id, sr\.supervisor_rated_level, ad\.reason/.test(sql))
            return { supervisorReviewId: REVIEW, supervisorRatedLevel: reviewLevel, reason };
        if (/supervisor_review_id FROM assessment_disputes/.test(sql))
            return { supervisorReviewId: REVIEW };
        if (/employee_id FROM assessment_disputes/.test(sql)) return { employeeId: EMP };
        if (/reviewed_by FROM supervisor_reviews/.test(sql)) return { reviewedBy: SUP };
        return undefined;
    });
}

describe('F1 — a dispute can only be opened by the employee the review is about', () => {
    test('another employee is refused with 403 and nothing is written', async () => {
        wireDispute({ reviewEmployee: EMP });
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: ATTACKER, reason: 'not mine' })
        ).rejects.toMatchObject({ status: 403, code: 'DISPUTE_NOT_OWNER' });
        expect(runCalls(/INSERT INTO assessment_disputes/)).toHaveLength(0);
        expect(runCalls(/UPDATE supervisor_reviews SET status = 'disputed'/)).toHaveLength(0);
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });

    test('a review nobody has decided yet (pending) is not disputable — 409', async () => {
        wireDispute({ reviewStatus: 'pending' });
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: EMP, reason: 'x' })
        ).rejects.toMatchObject({ status: 409, code: 'DISPUTE_NOT_DISPUTABLE' });
        expect(runCalls(/INSERT INTO assessment_disputes/)).toHaveLength(0);
    });

    test('a review already under dispute cannot be disputed again', async () => {
        wireDispute({ reviewStatus: 'disputed' });
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: EMP, reason: 'x' })
        ).rejects.toMatchObject({ status: 409, code: 'DISPUTE_NOT_DISPUTABLE' });
    });

    test('an unknown review is 404, a blank reason is 400', async () => {
        mockDb.get.mockResolvedValue(undefined);
        await expect(
            Dispute.open({ supervisorReviewId: 999999, employeeId: EMP, reason: 'x' })
        ).rejects.toMatchObject({ status: 404, code: 'DISPUTE_REVIEW_NOT_FOUND' });
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: EMP, reason: '   ' })
        ).rejects.toMatchObject({ status: 400, code: 'DISPUTE_REASON_REQUIRED' });
        expect(runCalls(/INSERT INTO assessment_disputes/)).toHaveLength(0);
    });

    test('the owner, on a decided review, still opens it (the legitimate path is intact)', async () => {
        wireDispute();
        mockDb.run.mockResolvedValue({ changes: 1, lastID: 30 });
        await expect(
            Dispute.open({ supervisorReviewId: String(REVIEW), employeeId: EMP, reason: ' mine ' })
        ).resolves.toBe(30);
        const [sql, params] = runCalls(/INSERT INTO assessment_disputes/)[0];
        expect(sql).toMatch(/'L0', 'open'/);
        expect(params).toEqual([REVIEW, EMP, 'mine']);
        expect(runCalls(/UPDATE supervisor_reviews SET status = 'disputed'/)[0][1]).toEqual([
            REVIEW,
        ]);
        expect(mockNotify.notify).toHaveBeenCalledWith(
            expect.objectContaining({ userId: SUP, kind: 'dispute.opened' })
        );
    });

    test('employeeFor() resolves the subject from the REVIEW, not the dispute row', async () => {
        mockDb.get.mockResolvedValue({ employeeId: EMP });
        await expect(Dispute.employeeFor(30)).resolves.toBe(EMP);
        const [sql] = mockDb.get.mock.calls[0];
        expect(sql).toMatch(/SELECT sr\.employee_id FROM assessment_disputes ad/);
        expect(sql).toMatch(/JOIN supervisor_reviews sr ON sr\.id = ad\.supervisor_review_id/);
    });
});

describe('F4/F5 — every resolution completes the review and recomputes the gap', () => {
    const cases = [
        ['resolveL0', { decidedBy: SUP }],
        ['resolveL1', { decidedBy: MGR }],
        ['resolveL2', { decidedByAdminId: 1 }],
    ];
    test.each(cases)(
        '%s writes level, gap = decided - self, status completed in ONE update',
        async (fn, who) => {
            wireDispute();
            await expect(
                Dispute[fn]({ disputeId: 7, decidedRating: 3, reason: 'decided', ...who })
            ).resolves.toEqual({ resolved: true });
            const upd = runCalls(/UPDATE supervisor_reviews sr/);
            expect(upd).toHaveLength(1);
            const [sql, params] = upd[0];
            expect(sql).toMatch(
                /SET supervisor_rated_level = \?, gap = \? - sa\.self_rated_level, status = 'completed'/
            );
            // The ROUNDS TABLE, not the `self_assessments` view. This assertion used
            // to pin `FROM self_assessments sa` — which, since migration 113, is the
            // CURRENT round only, while `supervisor_reviews.self_assessment_id`
            // points at ONE round. The decision therefore wrote ZERO rows for any
            // employee who had been asked again: dispute 'resolved' with its rating,
            // official skill level changed, and the review left 'disputed' at the
            // pre-dispute level. See [[disputeSupersededRoundAndReason]].
            expect(sql).toMatch(/FROM self_assessment_rounds sa/);
            expect(sql).toMatch(/WHERE sa\.id = sr\.self_assessment_id AND sr\.id = \?/);
            expect(params).toEqual([3, 3, REVIEW]);
            // and the official profile still gets the decided rating
            expect(mockSkill.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ employeeId: EMP, skillId: SKILL, currentLevel: 3 })
            );
        }
    );

    test('the legacy per-path UPDATE (level only / no gap) is gone', () => {
        const svc = read('src/services/DisputeServiceV2.js');
        expect(svc).not.toMatch(
            /UPDATE supervisor_reviews SET supervisor_rated_level = \? WHERE id = \?/
        );
        expect(svc).not.toMatch(
            /UPDATE supervisor_reviews SET supervisor_rated_level = \?, status = 'completed' WHERE id = \?/
        );
    });
});

describe('F10/F12 — a resolution carries an integer 0-4 rating, refused server-side as 400', () => {
    const paths = [
        ['resolveL0', { decidedBy: SUP }],
        ['resolveL1', { decidedBy: MGR }],
        ['resolveL2', { decidedByAdminId: 1 }],
    ];
    test.each(paths)(
        '%s: null / undefined / "" → DISPUTE_RATING_REQUIRED, nothing written',
        async (fn, who) => {
            wireDispute();
            for (const bad of [null, undefined, '']) {
                await expect(
                    Dispute[fn]({ disputeId: 7, decidedRating: bad, reason: 'r', ...who })
                ).rejects.toMatchObject({ status: 400, code: 'DISPUTE_RATING_REQUIRED' });
            }
            expect(mockDb.run).not.toHaveBeenCalled();
            expect(mockSkill.upsert).not.toHaveBeenCalled();
        }
    );

    test.each(paths)(
        '%s: 7 / -1 / 2.5 / "abc" → DISPUTE_RATING_RANGE before any SQL',
        async (fn, who) => {
            wireDispute();
            for (const bad of [7, -1, 2.5, 'abc', '4.0.1']) {
                await expect(
                    Dispute[fn]({ disputeId: 7, decidedRating: bad, reason: 'r', ...who })
                ).rejects.toMatchObject({ status: 400, code: 'DISPUTE_RATING_RANGE' });
            }
            expect(mockDb.run).not.toHaveBeenCalled();
        }
    );

    test('a numeric string from the form ("3") and a genuine 0 are accepted as ratings', async () => {
        wireDispute();
        await expect(
            Dispute.resolveL1({ disputeId: 7, decidedBy: MGR, decidedRating: '3', reason: 'r' })
        ).resolves.toEqual({ resolved: true });
        expect(runCalls(/UPDATE assessment_disputes/)[0][1]).toEqual([MGR, 3, 'r', 7]);
        mockDb.run.mockClear();
        await expect(
            Dispute.resolveL0({ disputeId: 9, decidedBy: SUP, decidedRating: 0, reason: 'r' })
        ).resolves.toEqual({ resolved: true });
        expect(runCalls(/UPDATE supervisor_reviews sr/)[0][1]).toEqual([0, 0, REVIEW]);
    });

    test('the reason guard still stands, and is a 400 too', async () => {
        wireDispute();
        await expect(
            Dispute.resolveL2({ disputeId: 7, decidedByAdminId: 1, decidedRating: 2, reason: '' })
        ).rejects.toMatchObject({
            status: 400,
            code: 'DISPUTE_REASON_REQUIRED',
            message: 'A resolution note is required.',
        });
    });
});

describe('F6 — the L2 SLA cannot finalise an absence of measurement', () => {
    const MARK = '[hr_arbitration_required: no supervisor rating to finalise]';

    test('a NULL supervisor rating is NOT finalised: HR is raised once, marker recorded, 0 finalised', async () => {
        mockDb.all.mockResolvedValue([{ id: 5 }]);
        wireDispute({ reviewLevel: null, reason: 'probe' });
        await expect(Dispute.autoFinalizeOverdueL2()).resolves.toBe(0);
        expect(runCalls(/auto_finalized/)).toHaveLength(0);
        expect(runCalls(/UPDATE supervisor_reviews/)).toHaveLength(0);
        expect(runCalls(/locked_state = 'finalized'/)).toHaveLength(0);
        expect(mockSkill.upsert).not.toHaveBeenCalled();
        const mark = runCalls(/UPDATE assessment_disputes/);
        expect(mark).toHaveLength(1);
        expect(mark[0][0]).toMatch(/SET reason = COALESCE\(reason, ''\) \|\| ' ' \|\| \?/);
        expect(mark[0][0]).toMatch(
            /WHERE id = \? AND level = 'L2' AND state IN \('escalated','open'\)/
        );
        expect(mark[0][1]).toEqual([MARK, 5]);
        // HR (arbitrate_disputes holders) told, the employee NOT told a decision was taken
        expect(mockRbac.adminsWithPermission).toHaveBeenCalledWith('arbitrate_disputes');
        const kinds = mockNotify.notify.mock.calls.map(
            ([a]) => `${a.userType}:${a.userId}:${a.kind}`
        );
        expect(kinds).toEqual(
            expect.arrayContaining(['admin:1:dispute.escalated', 'admin:68:dispute.escalated'])
        );
        expect(kinds.some((k) => k.startsWith('employee:'))).toBe(false);
    });

    test('a dispute already raised (marker on the row) is left alone on the next tick — no loop', async () => {
        mockDb.all.mockResolvedValue([{ id: 5 }]);
        wireDispute({ reviewLevel: null, reason: 'probe ' + MARK });
        await expect(Dispute.autoFinalizeOverdueL2()).resolves.toBe(0);
        expect(mockDb.run).not.toHaveBeenCalled();
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });

    test('a review WITH a rating is still finalised, through the shared review helper', async () => {
        mockDb.all.mockResolvedValue([{ id: 5 }]);
        wireDispute({ reviewLevel: 2 });
        await expect(Dispute.autoFinalizeOverdueL2()).resolves.toBe(1);
        expect(runCalls(/auto_finalized/)[0][1]).toEqual([2, 5]);
        const upd = runCalls(/UPDATE supervisor_reviews sr/);
        expect(upd).toHaveLength(1);
        expect(upd[0][1]).toEqual([2, 2, REVIEW]);
        expect(mockSkill.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ currentLevel: 2, assessedBy: 1 })
        );
        expect(mockNotify.notify).toHaveBeenCalledWith(
            expect.objectContaining({ userType: 'employee', userId: EMP, kind: 'dispute.resolved' })
        );
    });
});

// ---------------------------------------------------------------------------
// SelfAssessmentWorkflowService
// ---------------------------------------------------------------------------
function wireWorkflow({ state, selfLevel = 1, reviewLevel = null, updateChanges = 1 } = {}) {
    mockDb.get.mockImplementation(async (sql) => {
        if (/SELECT \* FROM self_assessments WHERE id = \?/.test(sql))
            return {
                id: 555,
                employeeId: EMP,
                skillId: SKILL,
                workflowState: state,
                selfRatedLevel: selfLevel,
            };
        // MOCK COMPLETED, PRODUCTION CODE UNCHANGED: _finalizeSupervisorReview
        // now joins `self_assessment_rounds` — the round the review actually
        // judged — because on the `self_assessments` view this lookup returned
        // nothing for a replaced round and the `if (!row) return` below it read
        // that as "no review row to finalise": a silent no-op on a decision that
        // had just been taken. Accept both spellings so the routing pins the
        // shape of the query, not one table name.
        if (/FROM supervisor_reviews sr\s+JOIN self_assessment(s|_rounds) sa/.test(sql))
            return { currentLevel: reviewLevel, selfLevel };
        if (/supervisor_rated_level AS "lvl"/.test(sql))
            return reviewLevel != null ? { lvl: reviewLevel } : undefined;
        if (/FROM admins WHERE username = 'admin'/.test(sql)) return { id: 1 };
        if (/INSERT INTO self_assessment_comments/.test(sql)) return { id: 77 };
        return undefined;
    });
    mockDb.run.mockImplementation(async (sql) => ({
        changes: /UPDATE self_assessments SET workflow_state/.test(sql) ? updateChanges : 1,
    }));
}
const reviewFinalisation = () =>
    runCalls(
        /UPDATE supervisor_reviews\s+SET decision = \?, recommendation = \?, status = 'completed'/
    );
const stateUpdate = () => runCalls(/UPDATE self_assessments SET workflow_state/)[0];

describe('F3 — a terminal arbitration finalises the supervisor review', () => {
    test('arbitrate(approve) records decision=approve, status completed, then promotes', async () => {
        wireWorkflow({ state: 'arbitration', selfLevel: 1 });
        await WF.arbitrate(555, mgrUser, { outcome: 'approve', note: 'arbitrated' });
        const fin = reviewFinalisation();
        expect(fin).toHaveLength(1);
        // decision, recommendation, level (self-rating stands = agreement), gap 0,
        // then the reviewer attribution pair (decision again, actor) — the actor
        // becomes reviewed_by only when no human has completed the row already
        // (Z-litige-2), then id
        expect(fin[0][1]).toEqual(['approve', null, 1, 0, 'approve', MGR, 555]);
        expect(mockSkill.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ employeeId: EMP, skillId: SKILL, currentLevel: 1 })
        );
        // the review is decided BEFORE the promotion (both inside the same transaction)
        const order = mockDb.run.mock.calls.map(([sql]) => sql);
        const iFin = order.findIndex((s) => /SET decision = \?/.test(s));
        const iState = order.findIndex((s) => /UPDATE self_assessments SET workflow_state/.test(s));
        expect(iState).toBeLessThan(iFin);
    });

    test('arbitrate(reject) records decision=reject and does NOT promote', async () => {
        wireWorkflow({ state: 'arbitration', selfLevel: 1 });
        await WF.arbitrate(555, mgrUser, { outcome: 'reject', note: 'no evidence' });
        const fin = reviewFinalisation();
        expect(fin).toHaveLength(1);
        expect(fin[0][1][0]).toBe('reject');
        expect(fin[0][1][2]).toBeNull(); // a rejection is not a measurement
        expect(mockSkill.upsert).not.toHaveBeenCalled();
    });

    test('a plain hold (no outcome → arbitration) decides nothing on the review', async () => {
        wireWorkflow({ state: 'submitted' });
        await WF.arbitrate(555, mgrUser, { note: 'looking into it' });
        expect(reviewFinalisation()).toHaveLength(0);
        expect(mockSkill.upsert).not.toHaveBeenCalled();
    });
});

describe('SuperAdmin withdraws a supervisor review (maintenance: "remove a review")', () => {
    const superUser = { id: 1, userType: 'admin', role: 'superadmin' };
    const withdrawSql = () =>
        runCalls(/UPDATE supervisor_reviews\s+SET status = 'pending', decision = NULL/);
    const eventRows = () => runCalls(/INSERT INTO self_assessment_events/);
    beforeEach(() => {
        mockRbac.isSuperAdmin.mockImplementation((u) => Boolean(u && u.role === 'superadmin'));
    });
    afterEach(() => {
        mockRbac.isSuperAdmin.mockImplementation(() => false);
    });
    /** Layer the prior-review lookup over wireWorkflow's routing. */
    const withPrior = (prior) => {
        const base = mockDb.get.getMockImplementation();
        mockDb.get.mockImplementation(async (sql, p) =>
            /FROM supervisor_reviews WHERE self_assessment_id = \?/.test(sql) ? prior : base(sql, p)
        );
    };

    test('reviewed → submitted: both state fields move under guard, the review row returns to pending, the withdrawn decision rides the event', async () => {
        wireWorkflow({ state: 'reviewed', selfLevel: 2 });
        withPrior({
            status: 'completed',
            decision: 'approve',
            supervisorRatedLevel: 3,
            gap: 1,
            reviewedBy: SUP,
        });
        await WF.withdrawReview(555, superUser, 'reviewed by the wrong supervisor');
        const [sql, params] = stateUpdate();
        expect(sql).toMatch(/SET workflow_state = \?, status = \?/);
        expect(params.slice(0, 2)).toEqual(['submitted', 'submitted']);
        expect(sql).toMatch(/AND workflow_state IN \(\?,\?,\?\)/);
        expect(params.slice(-3)).toEqual(['under_review', 'changes_requested', 'reviewed']);
        expect(withdrawSql()).toHaveLength(1);
        expect(withdrawSql()[0][1]).toEqual([555]);
        expect(withdrawSql()[0][0]).toMatch(
            /supervisor_rated_level = NULL, gap = NULL, gap_reason = NULL, reviewed_at = NULL/
        );
        const ev = eventRows();
        expect(ev).toHaveLength(1);
        // [self_assessment_id, actor_id, actor_type, action, from, to, detail]
        expect(ev[0][1].slice(1, 6)).toEqual([
            1,
            'admin',
            'review_withdrawn',
            'reviewed',
            'submitted',
        ]);
        expect(JSON.parse(ev[0][1][6])).toMatchObject({
            superadminOverride: true,
            reason: 'reviewed by the wrong supervisor',
            priorReview: { decision: 'approve', supervisorRatedLevel: 3, gap: 1 },
        });
        // Nothing promoted, nothing finalised, nobody notified: the file simply waits for a fresh review.
        expect(mockSkill.upsert).not.toHaveBeenCalled();
        expect(reviewFinalisation()).toHaveLength(0);
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });

    test('a supervisor or a manager cannot withdraw — and nothing is written', async () => {
        wireWorkflow({ state: 'reviewed' });
        await expect(WF.withdrawReview(555, supUser, 'x')).rejects.toThrow(/SuperAdmin only/);
        await expect(WF.withdrawReview(555, mgrUser, 'x')).rejects.toThrow(/SuperAdmin only/);
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each(['approved', 'arbitration', 'submitted', 'draft', 'rejected'])(
        '%s is refused before any write',
        async (state) => {
            wireWorkflow({ state });
            await expect(WF.withdrawReview(555, superUser, 'x')).rejects.toThrow(
                `Cannot withdraw a review from '${state}'`
            );
            expect(mockDb.run).not.toHaveBeenCalled();
        }
    );

    test('a review under dispute is refused (REVIEW_DISPUTED): the dispute ladder owns it', async () => {
        wireWorkflow({ state: 'reviewed' });
        withPrior({ status: 'disputed', decision: 'approve' });
        await expect(WF.withdrawReview(555, superUser, 'x')).rejects.toMatchObject({
            code: 'REVIEW_DISPUTED',
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a blank reason is refused; a row that moved meanwhile is STALE_STATE and the review row is left alone', async () => {
        wireWorkflow({ state: 'under_review' });
        await expect(WF.withdrawReview(555, superUser, '  ')).rejects.toThrow(/reason is required/);
        expect(mockDb.run).not.toHaveBeenCalled();
        wireWorkflow({ state: 'under_review', updateChanges: 0 });
        await expect(WF.withdrawReview(555, superUser, 'x')).rejects.toMatchObject({
            code: 'STALE_STATE',
        });
        expect(withdrawSql()).toHaveLength(0);
        expect(eventRows()).toHaveLength(0);
    });
});

describe('F8 — a stale decision raises STALE_STATE instead of overwriting a committed one', () => {
    test('managerValidate guards on reviewed|arbitration and refuses when the row moved', async () => {
        wireWorkflow({ state: 'reviewed', updateChanges: 0 });
        await expect(WF.managerValidate(555, mgrUser)).rejects.toMatchObject({
            code: 'STALE_STATE',
        });
        const [sql, params] = stateUpdate();
        expect(sql).toMatch(/AND workflow_state IN \(\?,\?\)/);
        expect(params.slice(-2)).toEqual(['reviewed', 'arbitration']);
        expect(mockSkill.upsert).not.toHaveBeenCalled();
        expect(reviewFinalisation()).toHaveLength(0);
    });

    test('requestChanges guards on under_review|submitted', async () => {
        wireWorkflow({ state: 'under_review', updateChanges: 0 });
        await expect(WF.requestChanges(555, supUser, 'please revise')).rejects.toMatchObject({
            code: 'STALE_STATE',
        });
        const [sql, params] = stateUpdate();
        expect(sql).toMatch(/AND workflow_state IN \(\?,\?\)/);
        expect(params.slice(-2)).toEqual(['under_review', 'submitted']);
        expect(runCalls(/decision='request_changes'/)).toHaveLength(0);
    });

    test('reject guards on every REVIEWABLE state (never approved|rejected, never the employee-owned draft)', async () => {
        wireWorkflow({ state: 'submitted', updateChanges: 0 });
        await expect(WF.reject(555, supUser, 'no evidence')).rejects.toMatchObject({
            code: 'STALE_STATE',
        });
        const [sql, params] = stateUpdate();
        // Z-litige-6: 'draft' and 'changes_requested' belong to the employee and
        // are refused BEFORE the update — the guard is the four reviewable states.
        expect(sql).toMatch(/AND workflow_state IN \(\?,\?,\?,\?\)/);
        const guard = params.slice(-4);
        expect(guard).toEqual(['submitted', 'under_review', 'reviewed', 'arbitration']);
        expect(guard).not.toContain('approved');
        expect(guard).not.toContain('rejected');
        expect(guard).not.toContain('draft');
        expect(guard).not.toContain('changes_requested');
        expect(reviewFinalisation()).toHaveLength(0);
    });

    test('the happy path is unchanged: managerValidate on a live reviewed row approves + promotes', async () => {
        wireWorkflow({ state: 'reviewed', selfLevel: 1, reviewLevel: 4 });
        await WF.managerValidate(555, mgrUser);
        expect(reviewFinalisation()).toHaveLength(1);
        expect(mockSkill.upsert).toHaveBeenCalledWith(expect.objectContaining({ currentLevel: 4 }));
    });
});

describe('F9 — an escalation is closed by management, never by the supervisor being arbitrated', () => {
    test('a supervisor cannot approve from arbitration', async () => {
        wireWorkflow({ state: 'arbitration' });
        await expect(WF.approve(555, supUser)).rejects.toThrow(
            /Cannot approve from 'arbitration': manager\/admin only/
        );
        expect(stateUpdate()).toBeUndefined();
        expect(mockSkill.upsert).not.toHaveBeenCalled();
    });

    test('the manager (canManage) still can', async () => {
        wireWorkflow({ state: 'arbitration' });
        await expect(WF.approve(555, mgrUser)).resolves.toBeDefined();
        expect(stateUpdate()[1]).toContain('approved');
        expect(mockSkill.upsert).toHaveBeenCalled();
    });

    test('a supervisor still approves the ordinary states', async () => {
        for (const state of ['submitted', 'under_review', 'reviewed']) {
            mockDb.run.mockClear();
            wireWorkflow({ state });
            await expect(WF.approve(555, supUser)).resolves.toBeDefined();
            expect(stateUpdate()).toBeDefined();
        }
    });

    test('bulk approve never sweeps arbitration rows', async () => {
        mockDb.all.mockResolvedValue([]);
        await WF.bulkApproveForEmployee(EMP, supUser);
        const [sql] = mockDb.all.mock.calls[0];
        expect(sql).toMatch(/workflow_state IN \('submitted','under_review','reviewed'\)/);
        expect(sql).not.toMatch(/arbitration/);
    });
});

// ---------------------------------------------------------------------------
// SelfAssessmentService — F2
// ---------------------------------------------------------------------------
function wireReenrolment({
    openCycle = 11,
    rowCycle = 9,
    state = 'approved',
    disputed = false,
} = {}) {
    mockDb.get.mockImplementation(async (sql) => {
        if (/FROM assessment_cycles WHERE status = 'open'/.test(sql))
            return openCycle == null ? undefined : { id: openCycle };
        if (/FROM assessment_disputes d/.test(sql)) return disputed ? { x: 1 } : undefined;
        return undefined;
    });
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    // UAT3 lot 1: the current measurement ROUND, not "the" row.
    mockSaModel.findCurrentRound.mockResolvedValue({
        id: 70,
        status: state,
        workflowState: state,
        cycleId: rowCycle,
        roundNo: 1,
    });
    mockSaModel.openRound.mockResolvedValue({ id: 71, roundNo: 2 });
    mockDb.all.mockResolvedValue([{ id: 70 }]);
}

describe('F2 — a skill decided in campaign N can be rated again in campaign N+1', () => {
    // UAT3 lot 1 / owner decision A1 (2026-09-13) changed HOW this is done: the
    // decided row is no longer rewritten into a draft of the new campaign. It is
    // kept, whole, as measurement round 1, and a NEW round is opened for the new
    // campaign. The rule this test protects is unchanged — being asked again by a
    // new campaign is free, needs no request for change, and is on the trail.
    test('approved in cycle 9, cycle 11 open → a NEW round is opened and round 1 is left intact', async () => {
        wireReenrolment({ openCycle: 11, rowCycle: 9 });
        const r = await SAS.createOrUpdateSelfAssessment(EMP, SKILL, 2, 'cycle 2 rating');
        expect(r).toMatchObject({
            id: 71,
            reopened: true,
            fromCycleId: 9,
            cycleId: 11,
            previousId: 70,
            round: 2,
        });
        // the handoff is on the audit trail, on the round it left…
        const ev = runCalls(/INSERT INTO self_assessment_events/);
        expect(ev).toHaveLength(1);
        expect(ev[0][1].slice(0, 3)).toEqual([70, EMP, 'approved']);
        expect(JSON.parse(ev[0][1][3])).toEqual({
            fromCycleId: 9,
            toCycleId: 11,
            newAssessmentId: 71,
            round: 2,
        });
        // …round 1 is superseded, never rewritten: no level, no stamp is touched…
        expect(runCalls(/SET superseded_at = now\(\)/)).toHaveLength(1);
        expect(
            runCalls(/submitted_at = NULL, reviewed_at = NULL, reviewed_by = NULL/)
        ).toHaveLength(0);
        expect(runCalls(/SET self_rated_level = \?, notes = \?/)).toHaveLength(0);
        // …and the new round carries the new campaign and the new rating.
        expect(mockSaModel.openRound).toHaveBeenCalledWith(
            expect.objectContaining({ selfRatedLevel: 2, notes: 'cycle 2 rating', cycleId: 11 })
        );
        expect(mockSaModel.create).not.toHaveBeenCalled();
        expect(runCalls(/DELETE/i)).toHaveLength(0);
    });

    test('approved in the cycle that is STILL open → untouched, reported as skipped', async () => {
        wireReenrolment({ openCycle: 11, rowCycle: 11 });
        await expect(SAS.createOrUpdateSelfAssessment(EMP, SKILL, 2)).resolves.toEqual({
            id: 70,
            skipped: true,
            state: 'approved',
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('no campaign open → a decided row stays decided', async () => {
        wireReenrolment({ openCycle: null, rowCycle: 9 });
        await expect(SAS.createOrUpdateSelfAssessment(EMP, SKILL, 2)).resolves.toEqual({
            id: 70,
            skipped: true,
            state: 'approved',
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a row whose review is under an OPEN dispute is never reopened', async () => {
        wireReenrolment({ openCycle: 11, rowCycle: 9, state: 'reviewed', disputed: true });
        await expect(SAS.createOrUpdateSelfAssessment(EMP, SKILL, 2)).resolves.toEqual({
            id: 70,
            skipped: true,
            state: 'reviewed',
            reason: 'under_dispute',
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a draft / changes_requested row is edited in place exactly as before', async () => {
        wireReenrolment({ openCycle: 11, rowCycle: 11, state: 'changes_requested' });
        await expect(SAS.createOrUpdateSelfAssessment(EMP, SKILL, 3)).resolves.toEqual({ id: 70 });
        expect(runCalls(/INSERT INTO self_assessment_events/)).toHaveLength(0);
        expect(runCalls(/status = 'draft', workflow_state = 'draft'/)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// CycleService — F11 + F7 readers
// ---------------------------------------------------------------------------
describe('F11 — closing a cycle finalises decided rows only', () => {
    test('draft and changes_requested are excluded from the finalisation UPDATE', async () => {
        await CycleService.close(11);
        const [sql] = runCalls(/SET locked_state = 'finalized'/)[0];
        expect(sql).toMatch(/AND sa\.workflow_state NOT IN \('draft', 'changes_requested'\)/);
        expect(sql).toMatch(/d\.state IN \('open','escalated'\)/); // the dispute exclusion is still there
    });
});

describe('F7 — the roster view counts the management backlog (migration 105)', () => {
    const mig = read('db/postgres/105_roster_view_management_backlog.sql');

    test('CREATE OR REPLACE, never DROP: existing readers keep their columns', () => {
        expect(mig).toMatch(/CREATE OR REPLACE VIEW v_cycle_participant_status AS/);
        expect(mig).not.toMatch(/DROP VIEW/i);
    });

    test('"submitted" = every state with management; rejected has its own bucket', () => {
        expect(mig).toMatch(
            /COUNT\(\*\) FILTER \(WHERE workflow_state IN \('submitted','under_review','reviewed','arbitration'\)\)::int AS submitted/
        );
        expect(mig).toMatch(
            /COUNT\(\*\) FILTER \(WHERE workflow_state = 'rejected'\)::int\s+AS rejected/
        );
        expect(mig).not.toMatch(/IN \('submitted','under_review'\)\)/);
    });

    test('the new column is appended LAST (CREATE OR REPLACE VIEW requires it)', () => {
        const iState = mig.indexOf('END AS participant_state');
        const iRejected = mig.indexOf('AS rejected_skills');
        expect(iState).toBeGreaterThan(-1);
        expect(iRejected).toBeGreaterThan(iState);
        expect(mig.slice(iRejected, mig.indexOf('FROM cycle_participants'))).not.toMatch(
            /,\s*\n\s*\w+/
        );
    });

    test('participant_state keeps its five values (the STATES lists are closed)', () => {
        for (const s of ['excluded', 'not_started', 'approved', 'in_review', 'in_progress'])
            expect(mig).toContain(`'${s}'`);
        expect(mig).not.toMatch(/THEN 'rejected'/);
        expect(CycleService.STATES).toEqual([
            'not_started',
            'in_progress',
            'in_review',
            'approved',
            'excluded',
        ]);
    });

    test('CycleService.progress reads the rejected bucket and still sums the others', async () => {
        mockDb.all.mockResolvedValue([
            {
                state: 'in_review',
                n: 2,
                expected: 64,
                rated: 40,
                submitted: 30,
                approved: 5,
                rejected: 3,
            },
            {
                state: 'not_started',
                n: 1,
                expected: 32,
                rated: 0,
                submitted: 0,
                approved: 0,
                rejected: 0,
            },
        ]);
        const p = await CycleService.progress(11, { userType: 'admin', role: 'superadmin' });
        expect(mockDb.all.mock.calls[0][0]).toMatch(/SUM\(v\.rejected_skills\)/);
        expect(p.states.in_review).toEqual({
            count: 2,
            expected: 64,
            rated: 40,
            submitted: 30,
            approved: 5,
            rejected: 3,
        });
        expect(p.totals).toEqual(
            expect.objectContaining({
                participants: 3,
                active: 3,
                expectedSkills: 96,
                submittedSkills: 30,
                approvedSkills: 5,
                rejectedSkills: 3,
            })
        );
        expect(p.pct.inReview).toBe(67);
    });

    test('DashboardService.getCampaignFunnel needs no change: submitted = in_review + approved', () => {
        // Not this lot's file — read only. Its arithmetic is over participant_state,
        // which the migration leaves with the same five values.
        const ds = read('src/services/DashboardService.js');
        expect(ds).toMatch(/const submitted = inReview \+ approved;/);
        expect(ds).not.toMatch(/submitted_skills/);
    });
});

// ---------------------------------------------------------------------------
// Routes — the refusals reach the browser as 4xx with the localized text
// ---------------------------------------------------------------------------
describe('routes/v2-slf.js answers a service refusal as the 4xx it is', () => {
    const routes = read('src/routes/v2-slf.js');

    test('every dispute mutation catches the refusal', () => {
        for (const p of ['resolveL0', 'resolveL1', 'resolveL2', 'open']) {
            expect(routes).toMatch(
                new RegExp(
                    `await DisputeServiceV2\\.${p}\\([\\s\\S]{0,300}?\\}\\);\\s*\\} catch \\(e\\) \\{\\s*if \\(sendDisputeRefusal\\(req, res, e\\)\\) return;\\s*throw e;`
                )
            );
        }
    });

    test('the refusal maps to the same localized keys in both languages', () => {
        const keys = [...routes.matchAll(/'(talentx|employee):([a-z_]+)'/g)].map((m) => [
            m[1],
            m[2],
        ]);
        expect(keys.length).toBeGreaterThanOrEqual(6);
        for (const lang of ['fr', 'en']) {
            const talentx = JSON.parse(read(`locales/${lang}/talentx.json`));
            const employee = JSON.parse(read(`locales/${lang}/employee.json`));
            for (const [ns, key] of keys) {
                const dict = ns === 'talentx' ? talentx : employee;
                expect(typeof dict[key]).toBe('string');
                expect(dict[key].length).toBeGreaterThan(0);
            }
        }
    });

    test('scope is resolved through employeeFor (the review), and 4xx only', () => {
        expect(routes).toMatch(
            /const empId = await DisputeServiceV2\.employeeFor\(Number\(req\.params\.id\)\);/
        );
        expect(routes).toMatch(/e\.status < 400 \|\| e\.status > 499\) return false;/);
    });
});
