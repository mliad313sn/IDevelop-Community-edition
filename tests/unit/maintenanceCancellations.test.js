'use strict';
/**
 * SuperAdmin maintenance cancellations.
 *
 * A record raised in error — an IDP on the wrong person, a PIP on a duplicate, a
 * 9-box position approved from bad data, an employee entered twice — had no way
 * back. The ordinary cancellation queue is two-person by design (requester can
 * never be the approver), which is right for a live plan and useless for fixing
 * data.
 *
 * So this path deliberately bypasses that control. The whole safety of the
 * feature is therefore in the CONDITIONS and the TRACE, and that is what these
 * tests pin:
 *
 *   - SuperAdmin only, re-checked in the service and not just on the route;
 *   - a written reason, always, or the action is refused;
 *   - nothing is ever DELETEd — a cancellation is a state plus a reason;
 *   - the override is LABELLED in the entity's own trail, so an auditor can list
 *     every bypass instead of having to know one happened;
 *   - the actor tag reaches the transaction, or the movement trigger would
 *     attribute a void to nobody;
 *   - voiding an employee is NOT erasing one, and restoring never silently
 *     returns somebody to the active headcount.
 *
 * DB mocked; the live behaviour is exercised by the rolled-back probe.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

const mockSessions = { revokeAllForUser: jest.fn() };
jest.mock('../../src/services/SessionService', () => mockSessions);

const mockNineBox = { _clearOrphanMirror: jest.fn() };
jest.mock('../../src/services/NineBoxService', () => mockNineBox);

const mockCancellation = { cascadePlanCancellation: jest.fn() };
jest.mock('../../src/services/CancellationService', () => mockCancellation);

const mockLog = { log: jest.fn() };
jest.mock('../../src/services/LogService', () => mockLog);

// The workflow service owns the assessment state machine; the panel delegates
// reopen + withdraw to it and must never write self_assessments for those.
const mockWF = { requestChanges: jest.fn(), withdrawReview: jest.fn() };
jest.mock('../../src/services/SelfAssessmentWorkflowService', () => mockWF);

const MaintenanceService = require('../../src/services/MaintenanceService');

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const LOCAL_ADMIN = { id: 68, userType: 'admin', role: 'admin', permissions: ['manage_mobility'] };
const MANAGER = { id: 137, userType: 'manager' };

/** Every SQL statement the call issued, upper-cased for matching. */
const sqlSeen = () =>
    mockDb.run.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' ').toUpperCase());
const ranMatching = (re) => sqlSeen().filter((s) => re.test(s));
/** The parameters of the first run() whose SQL matches. */
const paramsOf = (re) => {
    const c = mockDb.run.mock.calls.find(([s]) =>
        re.test(String(s).replace(/\s+/g, ' ').toUpperCase())
    );
    return c ? c[1] : null;
};

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockDb.runTransaction.mockReset().mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockReset().mockImplementation(async (fn) => fn());
    mockSessions.revokeAllForUser.mockReset().mockResolvedValue(0);
    mockNineBox._clearOrphanMirror.mockReset().mockResolvedValue(null);
    mockCancellation.cascadePlanCancellation
        .mockReset()
        .mockResolvedValue({ objectives: 0, actions: 0 });
    mockLog.log.mockReset().mockResolvedValue(undefined);
    mockWF.requestChanges
        .mockReset()
        .mockResolvedValue({ id: 42, workflowState: 'changes_requested' });
    mockWF.withdrawReview.mockReset().mockResolvedValue({ id: 43, workflowState: 'submitted' });
});

describe('who may run maintenance at all', () => {
    const calls = () => [
        [
            'cancelPlan',
            () =>
                MaintenanceService.cancelPlan(LOCAL_ADMIN, {
                    entityType: 'idp',
                    entityId: 1,
                    reason: 'x',
                }),
        ],
        [
            'cancelPlacement',
            () => MaintenanceService.cancelPlacement(LOCAL_ADMIN, { evaluationId: 1, reason: 'x' }),
        ],
        [
            'voidEmployee',
            () => MaintenanceService.voidEmployee(LOCAL_ADMIN, { employeeId: 1, reason: 'x' }),
        ],
        [
            'restoreEmployee',
            () => MaintenanceService.restoreEmployee(LOCAL_ADMIN, { employeeId: 1, reason: 'x' }),
        ],
    ];

    test.each(calls())('a local admin with manage_mobility cannot %s', async (_name, run) => {
        await expect(run()).rejects.toMatchObject({ userMessage: 'maintenance_superadmin_only' });
    });

    test('a manager cannot either', async () => {
        await expect(
            MaintenanceService.cancelPlan(MANAGER, { entityType: 'idp', entityId: 1, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_superadmin_only' });
    });

    test('the gate refuses BEFORE anything is read or written', async () => {
        await MaintenanceService.voidEmployee(LOCAL_ADMIN, { employeeId: 1, reason: 'x' }).catch(
            () => {}
        );
        expect(mockDb.run).not.toHaveBeenCalled();
        expect(mockDb.runTransaction).not.toHaveBeenCalled();
    });
});

describe('a reason is not optional', () => {
    test.each([[''], ['   '], [null], [undefined]])('reason %p is refused', async (reason) => {
        mockDb.get.mockResolvedValue({ id: 5, employeeId: 900, state: 'active' });
        await expect(
            MaintenanceService.cancelPlan(SUPER, { entityType: 'idp', entityId: 5, reason })
        ).rejects.toMatchObject({ userMessage: 'maintenance_reason_required' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });
});

describe('cancelling an IDP', () => {
    beforeEach(() => {
        mockDb.get.mockResolvedValue({ id: 87, employeeId: 142, state: 'active' });
    });

    test('the plan moves to cancelled and nothing is deleted', async () => {
        const out = await MaintenanceService.cancelPlan(SUPER, {
            entityType: 'idp',
            entityId: 87,
            reason: 'raised against the wrong employee',
        });
        expect(out).toMatchObject({
            ok: true,
            entityType: 'idp',
            entityId: 87,
            previousState: 'active',
        });
        expect(ranMatching(/UPDATE IDP_PLANS SET STATUS = 'CANCELLED'/)).toHaveLength(1);
        expect(ranMatching(/DELETE/)).toHaveLength(0);
    });

    test('the override is recorded with the SAME admin as requester and approver', async () => {
        await MaintenanceService.cancelPlan(SUPER, {
            entityType: 'idp',
            entityId: 87,
            reason: 'wrong employee',
        });
        const p = paramsOf(/INSERT INTO CANCELLATION_REQUESTS/);
        expect(p).not.toBeNull();
        // ..., requested_by_admin_id, decided_by_admin_id, decision_note
        expect(p).toContain(SUPER.id);
        expect(p.filter((v) => v === SUPER.id)).toHaveLength(2);
        expect(p).toContain(MaintenanceService.OVERRIDE_NOTE);
        expect(p).toContain('wrong employee');
        expect(p).toContain('active'); // previous_state preserved
    });

    test('the audit line names the bypass in words, not just a code', async () => {
        await MaintenanceService.cancelPlan(SUPER, {
            entityType: 'idp',
            entityId: 87,
            reason: 'wrong employee',
        });
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                // Lot D / L4-05: 'warn', not 'warning' — this was the only writer of a
                // second spelling, and its rows were invisible to "Problèmes uniquement".
                action: 'MAINT_CANCEL_IDP',
                adminId: SUPER.id,
                actorRef: 'admin:1',
                severity: 'warn',
                details: expect.stringContaining('two-person rule bypassed'),
            })
        );
        expect(mockLog.log.mock.calls[0][0].details).toContain('wrong employee');
    });

    test('it reaches the movement feed under its own kind', async () => {
        await MaintenanceService.cancelPlan(SUPER, {
            entityType: 'idp',
            entityId: 87,
            reason: 'wrong employee',
        });
        const p = paramsOf(/INSERT INTO EMPLOYEE_MOVEMENTS/);
        expect(p).toEqual([
            142,
            'plan_cancelled',
            'IDP active',
            'IDP cancelled',
            'admin:1',
            'wrong employee',
        ]);
    });

    test('a request already PENDING in the two-person queue is closed under the same override', async () => {
        // Committee finding: the override wrote its own approved row but left a
        // pre-existing pending request behind — still decidable against an
        // already-cancelled plan, and uq_cancel_one_pending then blocked any
        // future legitimate request for that plan.
        mockDb.run.mockImplementation(async (sql) =>
            /UPDATE cancellation_requests/.test(String(sql)) ? { changes: 1 } : { changes: 1 }
        );
        const out = await MaintenanceService.cancelPlan(SUPER, {
            entityType: 'idp',
            entityId: 87,
            reason: 'wrong employee',
        });
        const p = paramsOf(/UPDATE CANCELLATION_REQUESTS SET STATE = 'APPROVED'/);
        expect(p).toEqual([SUPER.id, MaintenanceService.OVERRIDE_NOTE, 'idp', 87]);
        expect(
            String(
                mockDb.run.mock.calls.find(([s]) =>
                    /UPDATE cancellation_requests/.test(String(s))
                )[0]
            )
        ).toContain("state = 'pending'");
        expect(out.supersededRequests).toBe(1);
        expect(mockLog.log.mock.calls[0][0].details).toContain(
            '1 pending cancellation request(s) closed'
        );
    });

    test('a cancelled IDP takes its open actions and objectives with it — through the SHARED cascade', async () => {
        // Committee finding: the plan read 'cancelled' while its idp_actions
        // stayed 'pending' — the Action Center kept listing work on a dead plan
        // and the completion denominator kept counting it. The two-person queue
        // and this override must cascade identically, so both call the one
        // CancellationService helper rather than each carrying its own SQL.
        mockCancellation.cascadePlanCancellation.mockResolvedValue({ objectives: 1, actions: 3 });
        const out = await MaintenanceService.cancelPlan(SUPER, {
            entityType: 'idp',
            entityId: 87,
            reason: 'wrong employee',
        });
        expect(mockDb.runInSavepoint).toHaveBeenCalledTimes(1);
        expect(mockCancellation.cascadePlanCancellation).toHaveBeenCalledWith('idp', 87);
        // No private copy of the cascade SQL may survive in this service.
        expect(ranMatching(/UPDATE IDP_(ACTIONS|OBJECTIVES)/)).toHaveLength(0);
        expect(out.cascadedActions).toBe(4);
        expect(mockLog.log.mock.calls[0][0].details).toContain(
            '4 open action(s)/objective(s) cancelled with it'
        );
    });

    test('a PIP has no action rows and does not run the cascade', async () => {
        mockDb.get.mockResolvedValue({ id: 9, employeeId: 142, state: 'active' });
        await MaintenanceService.cancelPlan(SUPER, {
            entityType: 'pip',
            entityId: 9,
            reason: 'duplicate',
        });
        expect(mockDb.runInSavepoint).not.toHaveBeenCalled();
        expect(mockCancellation.cascadePlanCancellation).not.toHaveBeenCalled();
    });

    test('a cascade failure is contained by the savepoint — the plan still ends cancelled', async () => {
        mockDb.runInSavepoint.mockImplementation(async () => {
            throw new Error('column shape changed');
        });
        const out = await MaintenanceService.cancelPlan(SUPER, {
            entityType: 'idp',
            entityId: 87,
            reason: 'wrong employee',
        });
        expect(out.ok).toBe(true);
        expect(ranMatching(/UPDATE IDP_PLANS SET STATUS = 'CANCELLED'/)).toHaveLength(1);
        expect(out.cascadedActions).toBe(0);
    });

    test('a PIP takes the same path with its own state column', async () => {
        mockDb.get.mockResolvedValue({ id: 9, employeeId: 142, state: 'active' });
        await MaintenanceService.cancelPlan(SUPER, {
            entityType: 'pip',
            entityId: 9,
            reason: 'duplicate',
        });
        expect(ranMatching(/UPDATE PIPS SET STATE = 'CANCELLED'/)).toHaveLength(1);
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'MAINT_CANCEL_PIP' })
        );
    });

    // The two state columns are DIFFERENT PostgreSQL enums: an IDP finishes
    // 'completed', a PIP finishes 'closed_success'. Each must be judged against
    // its own vocabulary — naming the other type's label is an error in SQL, not
    // an empty match, which is what made the panel's listing query throw.
    test.each([
        ['idp', 'completed'],
        ['idp', 'archived'],
        ['idp', 'cancelled'],
        ['pip', 'closed_success'],
        ['pip', 'closed_failure'],
        ['pip', 'cancelled'],
    ])('a %s already %s is refused rather than re-cancelled', async (entityType, state) => {
        mockDb.get.mockResolvedValue({ id: 87, employeeId: 142, state });
        await expect(
            MaintenanceService.cancelPlan(SUPER, { entityType, entityId: 87, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_plan_already_closed' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test.each([
        ['idp', 'draft'],
        ['idp', 'active'],
        ['pip', 'proposed'],
        ['pip', 'approved'],
        ['pip', 'active'],
    ])('a %s in %s is still cancellable', async (entityType, state) => {
        mockDb.get.mockResolvedValue({ id: 87, employeeId: 142, state });
        await expect(
            MaintenanceService.cancelPlan(SUPER, { entityType, entityId: 87, reason: 'x' })
        ).resolves.toMatchObject({ ok: true, previousState: state });
    });

    test('every terminal label belongs to that column own enum', () => {
        // Guards the bug directly: a label that is not in the enum turns the
        // listing query into a 22P02 at runtime, which no mocked test can see.
        expect(MaintenanceService.PLANS.idp.terminal).toEqual([
            'completed',
            'archived',
            'cancelled',
        ]);
        expect(MaintenanceService.PLANS.pip.terminal).toEqual([
            'closed_success',
            'closed_failure',
            'cancelled',
        ]);
        for (const spec of Object.values(MaintenanceService.PLANS)) {
            expect(spec.terminal).toContain('cancelled');
        }
    });

    test('coaching and mentoring are NOT reachable here — they keep the two-person queue', async () => {
        for (const entityType of ['coaching', 'mentoring']) {
            await expect(
                MaintenanceService.cancelPlan(SUPER, { entityType, entityId: 1, reason: 'x' })
            ).rejects.toMatchObject({ userMessage: 'maintenance_unknown_plan_type' });
        }
    });
});

describe('cancelling a self-assessment', () => {
    const SA = {
        id: 42,
        employeeId: 142,
        skillId: 301,
        status: 'approved',
        workflowState: 'approved',
        selfLevel: 3,
        skillName: 'Working at Height',
    };
    // get() order inside cancelAssessment: the assessment, the rejected-slot
    // clash check, then the official rating.
    const wire = ({ clash = undefined, official = undefined, sa = SA } = {}) => {
        mockDb.get
            .mockReset()
            .mockResolvedValueOnce(sa)
            .mockResolvedValueOnce(clash)
            .mockResolvedValueOnce(official);
    };

    test('it lands in "rejected" — NOT a new state that readers would miss', async () => {
        wire();
        const out = await MaintenanceService.cancelAssessment(SUPER, {
            assessmentId: 42,
            reason: 'recorded against the wrong skill',
        });
        expect(out).toMatchObject({ ok: true, assessmentId: 42, previousState: 'approved' });
        const sql = ranMatching(/UPDATE SELF_ASSESSMENTS/)[0];
        // Both halves of the dual state machine move together, or the row is
        // half-cancelled and each reader sees a different truth.
        expect(sql).toContain("STATUS = 'REJECTED'");
        expect(sql).toContain("WORKFLOW_STATE = 'REJECTED'");
        // A value outside the CHECK/enum would be rejected by the database and,
        // worse, would slip past `workflow_state <> 'rejected'` readers.
        expect(sql).not.toMatch(/'CANCELLED'/);
        expect(ranMatching(/DELETE/)).toHaveLength(0);
    });

    test('the official skill profile is REPORTED, never rewritten', async () => {
        wire({
            official: { level: 4, assessedBy: 1, notes: 'Set from supervisor-validated rating' },
        });
        const out = await MaintenanceService.cancelAssessment(SUPER, {
            assessmentId: 42,
            reason: 'wrong skill',
        });
        expect(out.officialRating).toEqual({
            level: 4,
            notes: 'Set from supervisor-validated rating',
        });
        // Rewriting it on a guess would corrupt readiness, gaps and the 9-box.
        expect(ranMatching(/UPDATE SKILL_ASSESSMENTS|DELETE FROM SKILL_ASSESSMENTS/)).toHaveLength(
            0
        );
        expect(mockLog.log.mock.calls[0][0].details).toContain('left UNCHANGED');
        expect(mockLog.log.mock.calls[0][0].details).toContain('still level 4');
    });

    test('with no official rating the audit says so rather than implying one', async () => {
        wire();
        const out = await MaintenanceService.cancelAssessment(SUPER, {
            assessmentId: 42,
            reason: 'wrong skill',
        });
        expect(out.officialRating).toBeNull();
        expect(mockLog.log.mock.calls[0][0].details).toContain('no official rating on file');
    });

    test('UNIQUE(employee, skill, status) is checked BEFORE the update', async () => {
        wire({ clash: { id: 99 } });
        await expect(
            MaintenanceService.cancelAssessment(SUPER, { assessmentId: 42, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_assessment_slot_taken' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a 23505 race is still translated, not leaked as a 500', async () => {
        wire();
        mockDb.runTransaction.mockImplementation(async () => {
            const e = new Error('duplicate key value violates unique constraint');
            e.code = '23505';
            throw e;
        });
        await expect(
            MaintenanceService.cancelAssessment(SUPER, { assessmentId: 42, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_assessment_slot_taken' });
    });

    test('any other database error is NOT disguised as a slot clash', async () => {
        wire();
        mockDb.runTransaction.mockImplementation(async () => {
            throw new Error('connection lost');
        });
        await expect(
            MaintenanceService.cancelAssessment(SUPER, { assessmentId: 42, reason: 'x' })
        ).rejects.toThrow('connection lost');
    });

    test('an already-rejected assessment is refused', async () => {
        wire({ sa: { ...SA, status: 'rejected' } });
        await expect(
            MaintenanceService.cancelAssessment(SUPER, { assessmentId: 42, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_assessment_already_cancelled' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('it reaches the movement feed under its own kind, with the actor', async () => {
        wire();
        await MaintenanceService.cancelAssessment(SUPER, {
            assessmentId: 42,
            reason: 'wrong skill',
        });
        expect(paramsOf(/INSERT INTO EMPLOYEE_MOVEMENTS/)).toEqual([
            142,
            'assessment_cancelled',
            'Working at Height approved',
            'cancelled',
            'admin:1',
            'wrong skill',
        ]);
    });

    test('a local admin cannot cancel an assessment either', async () => {
        await expect(
            MaintenanceService.cancelAssessment(LOCAL_ADMIN, { assessmentId: 42, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_superadmin_only' });
    });

    test('a reason is required here too', async () => {
        wire();
        await expect(
            MaintenanceService.cancelAssessment(SUPER, { assessmentId: 42, reason: '  ' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_reason_required' });
    });
});

describe('reopening an APPROVED self-assessment (request a change)', () => {
    const APPROVED = {
        id: 42,
        employeeId: 142,
        workflowState: 'approved',
        skillName: 'Working at Height',
    };

    test('a SuperAdmin can send an approved assessment back for changes, through the workflow service', async () => {
        mockDb.get.mockResolvedValue(APPROVED);
        const out = await MaintenanceService.reopenAssessment(SUPER, {
            assessmentId: 42,
            reason: 'approved on a wrong reading',
        });
        expect(out).toMatchObject({
            ok: true,
            assessmentId: 42,
            employeeId: 142,
            newState: 'changes_requested',
        });
        // The workflow service owns the dual state machine — the panel never
        // writes self_assessments itself.
        expect(mockWF.requestChanges).toHaveBeenCalledWith(
            42,
            SUPER,
            'approved on a wrong reading',
            null
        );
        expect(ranMatching(/UPDATE SELF_ASSESSMENTS/)).toHaveLength(0);
        expect(mockDb.runTransaction).toHaveBeenCalledWith(expect.any(Function), {
            actorRef: 'admin:1',
        });
    });

    test('the official skill profile is not touched by a reopen', async () => {
        mockDb.get.mockResolvedValue(APPROVED);
        await MaintenanceService.reopenAssessment(SUPER, {
            assessmentId: 42,
            reason: 'wrong reading',
        });
        expect(ranMatching(/SKILL_ASSESSMENTS/)).toHaveLength(0);
        expect(mockLog.log.mock.calls[0][0].details).toContain(
            'Official skill level left as promoted'
        );
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'MAINT_REOPEN_ASSESSMENT' })
        );
    });

    test('only an APPROVED assessment can be reopened — everything else goes through Cancel', async () => {
        mockDb.get.mockResolvedValue({ ...APPROVED, workflowState: 'submitted' });
        await expect(
            MaintenanceService.reopenAssessment(SUPER, { assessmentId: 42, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_assessment_not_approved' });
        expect(mockWF.requestChanges).not.toHaveBeenCalled();
    });

    test('a local admin cannot reopen, and a reason is mandatory', async () => {
        await expect(
            MaintenanceService.reopenAssessment(LOCAL_ADMIN, { assessmentId: 42, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_superadmin_only' });
        mockDb.get.mockResolvedValue(APPROVED);
        await expect(
            MaintenanceService.reopenAssessment(SUPER, { assessmentId: 42, reason: '  ' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_reason_required' });
        expect(mockWF.requestChanges).not.toHaveBeenCalled();
    });

    test('it reaches the movement feed as a reopen, with the actor', async () => {
        mockDb.get.mockResolvedValue(APPROVED);
        await MaintenanceService.reopenAssessment(SUPER, {
            assessmentId: 42,
            reason: 'wrong reading',
        });
        expect(paramsOf(/INSERT INTO EMPLOYEE_MOVEMENTS/)).toEqual([
            142,
            'assessment_cancelled',
            'Working at Height approved',
            'reopened for changes',
            'admin:1',
            'wrong reading',
        ]);
    });
});

describe('withdrawing a supervisor REVIEW ("remove a review")', () => {
    const REVIEWED = {
        id: 43,
        employeeId: 142,
        skillId: 7,
        workflowState: 'reviewed',
        skillName: 'Working at Height',
    };
    // First get = the assessment, second = the UNIQUE clash pre-check.
    const wire = (row, clash = undefined) =>
        mockDb.get.mockReset().mockResolvedValueOnce(row).mockResolvedValueOnce(clash);
    const call = (user = SUPER, reason = 'reviewed by the wrong supervisor') =>
        MaintenanceService.withdrawReview(user, { assessmentId: 43, reason });

    test('a SuperAdmin withdraws the review through the workflow service; the file goes back to submitted', async () => {
        wire(REVIEWED);
        const out = await call();
        expect(out).toEqual({
            ok: true,
            assessmentId: 43,
            employeeId: 142,
            previousState: 'reviewed',
            newState: 'submitted',
        });
        expect(mockWF.withdrawReview).toHaveBeenCalledWith(
            43,
            SUPER,
            'reviewed by the wrong supervisor',
            null
        );
        // The panel never touches the assessment, the review row or the profile itself.
        expect(
            ranMatching(/UPDATE SELF_ASSESSMENTS|UPDATE SUPERVISOR_REVIEWS|SKILL_ASSESSMENTS/)
        ).toHaveLength(0);
        expect(mockDb.runTransaction).toHaveBeenCalledWith(expect.any(Function), {
            actorRef: 'admin:1',
        });
        expect(paramsOf(/SET_CONFIG\('APP\.ACTOR_REF'/)).toEqual(['admin:1']);
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'MAINT_WITHDRAW_REVIEW',
                severity: 'warn',
                category: 'maintenance',
            })
        );
        expect(mockLog.log.mock.calls[0][0].details).toContain('two-person rule bypassed');
        expect(mockLog.log.mock.calls[0][0].details).toContain('official skill profile UNCHANGED');
        expect(paramsOf(/INSERT INTO EMPLOYEE_MOVEMENTS/)).toEqual([
            142,
            'assessment_cancelled',
            'Working at Height reviewed',
            'review withdrawn',
            'admin:1',
            'reviewed by the wrong supervisor',
        ]);
    });

    test.each(['under_review', 'changes_requested'])('%s is withdrawable too', async (state) => {
        wire({ ...REVIEWED, workflowState: state });
        await expect(call()).resolves.toMatchObject({
            ok: true,
            previousState: state,
            newState: 'submitted',
        });
    });

    test('approved → use Reopen; arbitration → the dispute ladder; submitted/draft/rejected → nothing to withdraw', async () => {
        const cases = [
            ['approved', 'maintenance_review_use_reopen'],
            ['arbitration', 'maintenance_review_in_arbitration'],
            ['submitted', 'maintenance_review_none'],
            ['draft', 'maintenance_review_none'],
            ['rejected', 'maintenance_review_none'],
        ];
        for (const [state, code] of cases) {
            wire({ ...REVIEWED, workflowState: state });
            await expect(call()).rejects.toMatchObject({ userMessage: code, status: 400 });
        }
        expect(mockWF.withdrawReview).not.toHaveBeenCalled();
        expect(mockDb.runTransaction).not.toHaveBeenCalled();
    });

    test('another submitted assessment for the same skill blocks it before any write (UNIQUE employee+skill+status)', async () => {
        wire(REVIEWED, { id: 99 });
        await expect(call()).rejects.toMatchObject({
            userMessage: 'maintenance_review_slot_taken',
        });
        expect(mockDb.get.mock.calls[1][1]).toEqual([142, 7, 43]);
        expect(mockWF.withdrawReview).not.toHaveBeenCalled();
        expect(mockDb.runTransaction).not.toHaveBeenCalled();
    });

    test('a review under dispute, a row that moved, and a late 23505 each come back as a sentence, not a 500', async () => {
        const cases = [
            [
                Object.assign(new Error('dispute'), { code: 'REVIEW_DISPUTED' }),
                'maintenance_review_disputed',
            ],
            [Object.assign(new Error('stale'), { code: 'STALE_STATE' }), 'maintenance_review_none'],
            [Object.assign(new Error('dup'), { code: '23505' }), 'maintenance_review_slot_taken'],
        ];
        for (const [err, code] of cases) {
            wire(REVIEWED);
            mockWF.withdrawReview.mockRejectedValueOnce(err);
            await expect(call()).rejects.toMatchObject({ userMessage: code, expose: true });
        }
        // A refused withdrawal leaves no trace claiming it happened.
        expect(mockLog.log).not.toHaveBeenCalled();
        expect(ranMatching(/INSERT INTO EMPLOYEE_MOVEMENTS/)).toHaveLength(0);
    });

    test('local admin and manager are refused; a reason is mandatory; an unknown id is a 400', async () => {
        await expect(call(LOCAL_ADMIN)).rejects.toMatchObject({
            userMessage: 'maintenance_superadmin_only',
        });
        await expect(call(MANAGER)).rejects.toMatchObject({
            userMessage: 'maintenance_superadmin_only',
        });
        wire(REVIEWED);
        await expect(call(SUPER, '   ')).rejects.toMatchObject({
            userMessage: 'maintenance_reason_required',
        });
        mockDb.get.mockReset().mockResolvedValue(undefined);
        await expect(call()).rejects.toMatchObject({
            userMessage: 'maintenance_assessment_not_found',
        });
        expect(mockWF.withdrawReview).not.toHaveBeenCalled();
    });
});

describe('cancelling a 9-box position', () => {
    const EV = {
        id: 55,
        employeeId: 142,
        cycleId: 7,
        status: 'approved',
        box: 9,
        boxLabel: 'Star',
    };

    test('the position is archived — the state every reader already excludes', async () => {
        mockDb.get.mockResolvedValueOnce(EV);
        const out = await MaintenanceService.cancelPlacement(SUPER, {
            evaluationId: 55,
            reason: 'bad data',
        });
        expect(out).toMatchObject({
            ok: true,
            previousStatus: 'approved',
            box: 9,
            clearedPlacement: false,
        });
        expect(ranMatching(/UPDATE NINE_BOX_EVALUATIONS SET STATUS = 'ARCHIVED'/)).toHaveLength(1);
    });

    test('the reason lands in nine_box_events as a cancel, not a supersede', async () => {
        mockDb.get.mockResolvedValueOnce(EV);
        await MaintenanceService.cancelPlacement(SUPER, { evaluationId: 55, reason: 'bad data' });
        const p = paramsOf(/INSERT INTO NINE_BOX_EVENTS/);
        expect(p.slice(0, 4)).toEqual([55, 142, SUPER.id, 'approved']);
        const detail = JSON.parse(p[4]);
        expect(detail).toMatchObject({
            reason: 'bad data',
            maintenance: true,
            box: 9,
            boxLabel: 'Star',
        });
        expect(detail.note).toContain('two-person rule bypassed');
    });

    test('the mirror is cleared by the 9-box service, by EMPLOYEE, never matched on cycle_id', async () => {
        // Committee finding (talent lot): every evaluation's cycle_id is NULL in
        // the data while the mirror's is not, so a cycle_id match NEVER hit and
        // the cancel left the calibration write-back standing for every consumer
        // that reads talent_placements. The 9-box service owns the resolution.
        mockDb.get.mockResolvedValueOnce(EV);
        mockNineBox._clearOrphanMirror.mockResolvedValue({
            cycleId: 9,
            box: 'high-high',
            tier: 'up',
            source: 'override',
        });
        const out = await MaintenanceService.cancelPlacement(SUPER, {
            evaluationId: 55,
            reason: 'bad data',
        });
        expect(mockNineBox._clearOrphanMirror).toHaveBeenCalledWith(142);
        expect(out.clearedPlacement).toBe(true);
        // no local cycle_id-matched lookup or delete may survive
        expect(mockDb.get.mock.calls.some(([s]) => /talent_placements/i.test(String(s)))).toBe(
            false
        );
        expect(ranMatching(/DELETE FROM TALENT_PLACEMENTS/)).toHaveLength(0);
    });

    test('the mirror is cleared AFTER the archive, inside the transaction, and copied into the trail', async () => {
        // The helper only clears when no approved evaluation remains, so it must
        // run after the status change; and talent_placements has no history of
        // its own, so the cleared row must land in the event detail.
        mockDb.get.mockResolvedValueOnce(EV);
        const order = [];
        mockDb.run.mockImplementation(async (sql) => {
            order.push(
                /UPDATE nine_box_evaluations/.test(sql)
                    ? 'archive'
                    : /INSERT INTO nine_box_events/.test(sql)
                      ? 'event'
                      : 'other'
            );
            return { changes: 1 };
        });
        mockNineBox._clearOrphanMirror.mockImplementation(async () => {
            order.push('clear');
            return { cycleId: 9, box: 'high-high', tier: 'up', source: 'override' };
        });
        await MaintenanceService.cancelPlacement(SUPER, { evaluationId: 55, reason: 'bad data' });
        expect(order.filter((x) => x !== 'other')).toEqual(['archive', 'clear', 'event']);
        const detail = JSON.parse(paramsOf(/INSERT INTO NINE_BOX_EVENTS/)[4]);
        expect(detail.clearedPlacement).toEqual({
            cycleId: 9,
            box: 'high-high',
            tier: 'up',
            source: 'override',
        });
        expect(mockLog.log.mock.calls[0][0].details).toContain('incl. calibration write-back');
    });

    test('an already-archived position is refused', async () => {
        mockDb.get.mockResolvedValueOnce({ ...EV, status: 'archived' });
        await expect(
            MaintenanceService.cancelPlacement(SUPER, { evaluationId: 55, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_placement_already_archived' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });
});

describe('voiding an employee record', () => {
    const EMP = {
        id: 142,
        firstName: 'Yao',
        lastName: 'KOUAME',
        isActive: true,
        cancelledAt: null,
    };

    test('it is a void with a reason, never an erase', async () => {
        mockDb.get.mockResolvedValue(EMP);
        const out = await MaintenanceService.voidEmployee(SUPER, {
            employeeId: 142,
            reason: 'duplicate of 118',
        });
        expect(out).toMatchObject({ ok: true, wasActive: true });
        const sql = ranMatching(/UPDATE EMPLOYEES/)[0];
        expect(sql).toContain('IS_ACTIVE = FALSE');
        expect(sql).toContain('CANCELLED_AT = NOW()');
        expect(sql).toContain('CANCEL_REASON');
        // Not a DSR erase: no personal field is touched.
        expect(sql).not.toMatch(/FIRST_NAME|LAST_NAME|EMAIL|PASSWORD/);
        expect(ranMatching(/DELETE/)).toHaveLength(0);
    });

    test('the actor tag reaches the transaction, so the trigger can attribute the change', async () => {
        mockDb.get.mockResolvedValue(EMP);
        await MaintenanceService.voidEmployee(SUPER, { employeeId: 142, reason: 'duplicate' });
        expect(mockDb.runTransaction).toHaveBeenCalledWith(expect.any(Function), {
            actorRef: 'admin:1',
        });
    });

    test('the tag is ALSO set inside the body, so a nested transaction cannot drop it', async () => {
        // Measured: runTransaction only applies { actorRef } when it OPENS the
        // transaction. Called from inside an outer one it returns fn() straight
        // away and the option is lost — which produced a status movement reading
        // "record voided by nobody". The in-body set_config is what fixes that.
        mockDb.get.mockResolvedValue(EMP);
        await MaintenanceService.voidEmployee(SUPER, { employeeId: 142, reason: 'duplicate' });
        const tag = mockDb.run.mock.calls.find(([s]) =>
            /set_config\('app\.actor_ref'/.test(String(s))
        );
        expect(tag).toBeDefined();
        expect(tag[1]).toEqual(['admin:1']);
        // and it must be transaction-LOCAL, or it leaks to the next request on
        // the pooled connection.
        expect(String(tag[0])).toContain('true');
    });

    test('every write path tags the actor, not just the employee one', async () => {
        const paths = [
            [
                'plan',
                { id: 87, employeeId: 142, state: 'active' },
                () =>
                    MaintenanceService.cancelPlan(SUPER, {
                        entityType: 'idp',
                        entityId: 87,
                        reason: 'r',
                    }),
            ],
            [
                'placement',
                {
                    id: 55,
                    employeeId: 142,
                    cycleId: 7,
                    status: 'approved',
                    box: 9,
                    boxLabel: 'Star',
                },
                () => MaintenanceService.cancelPlacement(SUPER, { evaluationId: 55, reason: 'r' }),
            ],
            [
                'restore',
                { id: 142, firstName: 'Y', lastName: 'K', cancelledAt: 'x', cancelReason: 'r' },
                () => MaintenanceService.restoreEmployee(SUPER, { employeeId: 142, reason: 'r' }),
            ],
        ];
        for (const [, row, run] of paths) {
            mockDb.run.mockClear();
            mockDb.get.mockReset().mockResolvedValue(row);
            await run();
            expect(
                mockDb.run.mock.calls.some(([s]) => /set_config\('app\.actor_ref'/.test(String(s)))
            ).toBe(true);
        }
    });

    test('an ALREADY INACTIVE record still gets its own feed row', async () => {
        mockDb.get.mockResolvedValue({ ...EMP, isActive: false });
        await MaintenanceService.voidEmployee(SUPER, { employeeId: 142, reason: 'duplicate' });
        expect(paramsOf(/INSERT INTO EMPLOYEE_MOVEMENTS/)).toEqual([
            142,
            'status',
            'Inactive',
            'Cancelled (record voided)',
            'admin:1',
            'duplicate',
        ]);
    });

    test('an ACTIVE record gets the explicit "voided" feed row too — a void must never read like a leaver', async () => {
        // Committee finding (people/org lane): the first version relied on the
        // is_active trigger for active records, whose row reads "active →
        // inactive, source db, note null" — byte-identical to an ordinary
        // departure. Nothing in the feed said the record should never have
        // existed, which is the one fact this feature exists to record.
        mockDb.get.mockResolvedValue(EMP);
        await MaintenanceService.voidEmployee(SUPER, { employeeId: 142, reason: 'duplicate' });
        expect(paramsOf(/INSERT INTO EMPLOYEE_MOVEMENTS/)).toEqual([
            142,
            'status',
            'Active',
            'Cancelled (record voided)',
            'admin:1',
            'duplicate',
        ]);
    });

    test('the void disables the LOGIN, not just the headcount flag', async () => {
        // Committee finding: is_active=false alone left the person's password
        // authenticating, stamping last_login_at and writing a login-success
        // audit row for a record that officially never existed.
        mockDb.get.mockResolvedValue(EMP);
        await MaintenanceService.voidEmployee(SUPER, { employeeId: 142, reason: 'duplicate' });
        const sql = ranMatching(/UPDATE EMPLOYEES/)[0];
        expect(sql).toContain('IS_ACTIVE = FALSE');
        expect(sql).toContain('IS_ACCOUNT_ACTIVE = FALSE');
    });

    test('live sessions are revoked in both employee buckets, like a leaver', async () => {
        mockDb.get.mockResolvedValue(EMP);
        const out = await MaintenanceService.voidEmployee(SUPER, {
            employeeId: 142,
            reason: 'duplicate',
        });
        expect(mockSessions.revokeAllForUser).toHaveBeenCalledWith(142, 'employee');
        expect(mockSessions.revokeAllForUser).toHaveBeenCalledWith(142, 'manager');
        expect(out).toMatchObject({ loginDisabled: true, sessionsRevoked: true });
    });

    test('a linked admin account and its API keys go with it', async () => {
        mockDb.get.mockResolvedValue(EMP);
        mockDb.all
            .mockResolvedValueOnce([{ id: 589 }]) // linked admins
            .mockResolvedValueOnce([{ id: 17 }, { id: 18 }]); // that admin's live keys
        const out = await MaintenanceService.voidEmployee(SUPER, {
            employeeId: 142,
            reason: 'duplicate',
        });
        expect(ranMatching(/UPDATE API_KEYS SET REVOKED_AT = NOW\(\)/)).toHaveLength(1);
        expect(paramsOf(/UPDATE ADMINS SET IS_ACTIVE = FALSE/)).toEqual([589]);
        expect(mockSessions.revokeAllForUser).toHaveBeenCalledWith(589, 'admin');
        expect(out.linkedAdminsDeactivated).toEqual([589]);
        expect(out.apiKeysRevoked).toEqual([17, 18]);
        expect(mockLog.log.mock.calls[0][0].details).toContain(
            'linked admin(s) 589 deactivated, 2 API key(s) revoked'
        );
    });

    test('a session-store hiccup never undoes the void itself', async () => {
        mockDb.get.mockResolvedValue(EMP);
        mockSessions.revokeAllForUser.mockRejectedValue(new Error('store down'));
        const out = await MaintenanceService.voidEmployee(SUPER, {
            employeeId: 142,
            reason: 'duplicate',
        });
        expect(out.ok).toBe(true);
        expect(out.sessionsRevoked).toBe(false);
        expect(ranMatching(/UPDATE EMPLOYEES/)).toHaveLength(1);
    });

    test('voiding somebody who still has ACTIVE reports is refused, naming the count', async () => {
        // Committee finding: voiding a supervisor orphaned 15 people onto a record
        // that cannot log in, and the governance-gap worklist could not see them.
        mockDb.get
            .mockReset()
            .mockResolvedValueOnce(EMP) // the employee
            .mockResolvedValueOnce({ n: 15 }); // active reports
        await expect(
            MaintenanceService.voidEmployee(SUPER, { employeeId: 142, reason: 'duplicate' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_employee_has_reports', count: 15 });
        expect(mockDb.run).not.toHaveBeenCalled();
        expect(mockDb.runTransaction).not.toHaveBeenCalled();
    });

    test('the reports check ignores the person themselves, voided rows and leavers', async () => {
        mockDb.get.mockResolvedValue(EMP);
        await MaintenanceService.voidEmployee(SUPER, { employeeId: 142, reason: 'duplicate' });
        const call = mockDb.get.mock.calls.find(([s]) => /supervisor_id = \?/.test(String(s)));
        expect(call).toBeDefined();
        const sql = String(call[0]).replace(/\s+/g, ' ');
        expect(sql).toContain('is_active = true');
        expect(sql).toContain('cancelled_at IS NULL');
        expect(sql).toContain('id <> ?');
        expect(call[1]).toEqual([142, 142, 142]);
    });

    test('voiding twice is refused', async () => {
        mockDb.get.mockResolvedValue({ ...EMP, cancelledAt: '2026-09-09T10:00:00Z' });
        await expect(
            MaintenanceService.voidEmployee(SUPER, { employeeId: 142, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_employee_already_void' });
    });
});

describe('restoring a voided employee', () => {
    const VOID = {
        id: 142,
        firstName: 'Yao',
        lastName: 'KOUAME',
        cancelledAt: '2026-09-09T10:00:00Z',
        cancelReason: 'duplicate of 118',
    };

    test('the void is lifted but the person does NOT return to the active headcount', async () => {
        mockDb.get.mockResolvedValue(VOID);
        const out = await MaintenanceService.restoreEmployee(SUPER, {
            employeeId: 142,
            reason: 'was not a duplicate',
        });
        expect(out).toMatchObject({ ok: true, stillInactive: true });
        const sql = ranMatching(/UPDATE EMPLOYEES/)[0];
        expect(sql).toContain('CANCELLED_AT = NULL');
        // Reactivating is a separate, deliberate decision — one click must not
        // put somebody back into every readiness denominator.
        expect(sql).not.toMatch(/IS_ACTIVE\s*=\s*TRUE/);
    });

    test('the original void reason survives into the restore audit line', async () => {
        mockDb.get.mockResolvedValue(VOID);
        await MaintenanceService.restoreEmployee(SUPER, {
            employeeId: 142,
            reason: 'was not a duplicate',
        });
        const details = mockLog.log.mock.calls[0][0].details;
        expect(details).toContain('duplicate of 118'); // why it was voided
        expect(details).toContain('was not a duplicate'); // why that was undone
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'MAINT_RESTORE_EMPLOYEE' })
        );
    });

    test('restoring a record that was never voided is refused', async () => {
        mockDb.get.mockResolvedValue({ ...VOID, cancelledAt: null });
        await expect(
            MaintenanceService.restoreEmployee(SUPER, { employeeId: 142, reason: 'x' })
        ).rejects.toMatchObject({ userMessage: 'maintenance_employee_not_void' });
    });
});

describe('the panel cannot grow into another /skill-matrix', () => {
    test('the employee picker is bounded and says so when it truncated', async () => {
        mockDb.all.mockResolvedValue(Array.from({ length: 501 }, (_, i) => ({ id: i + 1 })));
        const out = await MaintenanceService.candidateEmployees(500);
        expect(out.rows).toHaveLength(500);
        expect(out.truncated).toBe(true);
        // LIMIT is asked for one more than needed — that is how truncation is detected.
        expect(mockDb.all.mock.calls[0][1]).toEqual([501]);
    });

    test('a short list is not reported as truncated', async () => {
        mockDb.all.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        const out = await MaintenanceService.candidateEmployees(500);
        expect(out.truncated).toBe(false);
        expect(out.rows).toHaveLength(2);
    });
});
