'use strict';
/**
 * LOT « revue-litige » — five findings on the contest path, each reproduced by
 * execution on a development database inside a rolled-back transaction before
 * the fix and replayed after it (numbers are the live fixture's):
 *
 * Z-litige-1  DisputeServiceV2.open opened a dispute with NO 30-day window and
 *             NO campaign gate. Decision 45 days old → dispute #124 opened while
 *             the request-for-change path refused `contest_window_expired` on the
 *             SAME round; campaign 73 closed 2026-09-15 → dispute #125 opened.
 *             After: 409 contest_window_expired « …la décision date du 03/08/2026
 *             et le délai de 30 jours a expiré le 02/09/2026 » ; 409
 *             cycle_write_closed « La campagne UAT3C-CLOSURE a été clôturée le
 *             15/09/2026… » ; and a replaced round is refused up front
 *             (DISPUTE_ROUND_SUPERSEDED).
 * Z-litige-2  managerValidate rewrote supervisor_reviews.reviewed_by with the
 *             manager's id on a row the SUPERVISOR had completed (level and gap
 *             reason untouched): {reviewed_by:136} → validate by 137 →
 *             {reviewed_by:137}, and _reviewerOf → 137, so a dispute would have
 *             notified the wrong human. After: reviewed_by stays 136,
 *             approved_by_ref 'employee:137' names the validation.
 * Z-litige-3  A dispute resolved on a REPLACED round promoted its rating into
 *             skill_assessments: (138,299) 4 → 1, the CURRENT round's official
 *             level erased by a decision about an older one. After: 4 stays 4,
 *             the review carries the decided 1, the dispute carries the machine
 *             note `promotion_withheld_superseded`, system_logs
 *             DISPUTE_PROMOTION_WITHHELD.
 * Z-litige-4  AssessmentChangeRequestService.decide reopened the assessment,
 *             wrote the append-only event and notified « accordée » AFTER a
 *             concurrent refusal — its UPDATE ... WHERE status='pending' matched
 *             zero rows and nobody read `changes`. After: 409 already_decided,
 *             round untouched, no event.
 * Z-litige-6  reject() accepted a never-submitted DRAFT and a row handed back to
 *             the employee: both went 'rejected'/'rejected' (terminal). After:
 *             refused with assess:saw_err_cannot_reject; 'submitted' still rejects.
 *
 * DB mocked here (routing by SQL text, never by call order); the live behaviour
 * is the probe above.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockLog = jest.fn(async () => {});
jest.mock('../../src/services/LogService', () => ({ log: mockLog }));
const mockNotify = jest.fn(async () => ({ inapp: 'ok' }));
jest.mock('../../src/services/NotificationService', () => ({ notify: mockNotify }));
const mockSkill = { upsert: jest.fn(async () => ({})) };
jest.mock('../../src/models/SkillAssessmentModel', () => mockSkill);
const mockFindById = jest.fn();
jest.mock('../../src/models/EmployeeModel', () => ({
    findById: mockFindById,
    governs: jest.fn(async () => false),
}));
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (key, def) => def),
}));

/** The campaign gate as CycleService really answers it: `{ writable }`, or a throw carrying `e.gate`. */
let mockGate = { writable: true, code: null, message: null };
const mockAssertCycleWritable = jest.fn(async () => {
    if (mockGate.writable) return mockGate;
    const e = new Error(mockGate.message);
    e.code = mockGate.code;
    e.gate = mockGate;
    throw e;
});
jest.mock('../../src/services/CycleService', () => ({
    assertCycleWritable: mockAssertCycleWritable,
}));

jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'superadmin',
    isLocalAdmin: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'localadmin',
    isViewer: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'viewer',
    canAccessEmployeeData: async () => true,
    scopeFilter: async () => ({ clause: '', params: [] }),
    hasPermission: () => false,
}));

const WF = require('../../src/services/SelfAssessmentWorkflowService');
const ACR = require('../../src/services/AssessmentChangeRequestService');
const Dispute = require('../../src/services/DisputeServiceV2');

const EMPLOYEE = { id: 138, userType: 'employee' };
const SUPERVISOR = { id: 136, userType: 'manager' };
const MANAGER = { id: 137, userType: 'manager' };
const SUBJECT = { id: 138, supervisorId: 136, managerId: 137, managerType: 'employee' };
const REVIEW = 1023;
const ROUND = 223929;

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const runs = (re) => mockDb.run.mock.calls.filter(([sql]) => re.test(norm(sql)));

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockDb.runTransaction.mockClear();
    mockSkill.upsert.mockClear();
    mockNotify.mockClear();
    mockLog.mockClear();
    mockAssertCycleWritable.mockClear();
    mockGate = { writable: true, code: null, message: null };
    mockFindById.mockReset().mockResolvedValue(SUBJECT);
});

// ---------------------------------------------------------------------------
// Z-litige-1 — open() reads the round and applies the three contest gates
// ---------------------------------------------------------------------------
function wireOpen({
    status = 'completed',
    decidedAt = daysAgo(3),
    cycleId = 11,
    supersededAt = null,
} = {}) {
    mockDb.get.mockImplementation(async (sql) => {
        const q = norm(sql);
        if (
            /SELECT sr\.employee_id, sr\.status, sr\.decided_at, sr\.reviewed_at, sa\.cycle_id, sa\.approved_at, sa\.reviewed_at AS round_reviewed_at, sa\.superseded_at FROM supervisor_reviews sr LEFT JOIN self_assessment_rounds sa ON sa\.id = sr\.self_assessment_id WHERE sr\.id = \?/.test(
                q
            )
        )
            return {
                employeeId: 138,
                status,
                decidedAt,
                reviewedAt: decidedAt,
                cycleId,
                approvedAt: null,
                roundReviewedAt: null,
                supersededAt,
            };
        if (/reviewed_by FROM supervisor_reviews/.test(q)) return { reviewedBy: 136 };
        return undefined;
    });
    mockDb.run.mockImplementation(async (sql) =>
        /INSERT INTO assessment_disputes/.test(sql) ? { lastID: 900, changes: 1 } : { changes: 1 }
    );
}

describe('Z-litige-1 — a dispute obeys the same contest rules as a request for change', () => {
    test('a decision older than 30 days is refused with the dated sentence, and nothing is written', async () => {
        wireOpen({ decidedAt: daysAgo(45) });
        const err = await Dispute.open({
            supervisorReviewId: REVIEW,
            employeeId: 138,
            reason: 'trop tard',
        }).catch((e) => e);
        expect(err).toMatchObject({ status: 409, code: 'contest_window_expired' });
        expect(err.i18n).toMatchObject({
            key: 'assess:acr_err_contest_window',
            vars: expect.objectContaining({ days: 30 }),
        });
        expect(err.i18n.vars.decided).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
        expect(err.i18n.vars.until).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
        expect(runs(/INSERT INTO assessment_disputes/)).toHaveLength(0);
        expect(runs(/UPDATE supervisor_reviews SET status = 'disputed'/)).toHaveLength(0);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('the window is the ONE shared definition (30 days, AssessmentChangeRequestService)', async () => {
        wireOpen({ decidedAt: daysAgo(ACR.constructor.CONTEST_WINDOW_DAYS + 1) });
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: 138, reason: 'x' })
        ).rejects.toMatchObject({ code: 'contest_window_expired' });
        wireOpen({ decidedAt: daysAgo(ACR.constructor.CONTEST_WINDOW_DAYS - 1) });
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: 138, reason: 'x' })
        ).resolves.toBe(900);
    });

    test('a CLOSED campaign refuses with the gate sentence (campaign + date), status 409', async () => {
        wireOpen({ cycleId: 73 });
        mockGate = {
            writable: false,
            code: 'cycle_write_closed',
            message:
                'La campagne UAT3C-CLOSURE a été clôturée le 15/09/2026 : plus aucune écriture n’y est possible.',
        };
        const err = await Dispute.open({
            supervisorReviewId: REVIEW,
            employeeId: 138,
            reason: 'x',
        }).catch((e) => e);
        expect(err).toMatchObject({ status: 409, code: 'cycle_write_closed' });
        expect(err.message).toMatch(/UAT3C-CLOSURE.*15\/09\/2026/);
        // The gate is asked for the round's OWN campaign, as a review write
        // (a locked campaign still lets a person contest what was decided in it).
        expect(mockAssertCycleWritable).toHaveBeenCalledWith(
            73,
            expect.objectContaining({ allowReview: true })
        );
        expect(runs(/INSERT INTO assessment_disputes/)).toHaveLength(0);
    });

    test('the reader’s translator reaches the gate when the caller hands one', async () => {
        wireOpen({ cycleId: 73 });
        const t = jest.fn((k, o) => (o && o.defaultValue) || k);
        await Dispute.open({ supervisorReviewId: REVIEW, employeeId: 138, reason: 'x', t });
        expect(mockAssertCycleWritable).toHaveBeenCalledWith(73, expect.objectContaining({ t }));
    });

    test('off-campaign (cycle_id NULL) is never a refusal — A6', async () => {
        wireOpen({ cycleId: null });
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: 138, reason: 'x' })
        ).resolves.toBe(900);
        expect(mockAssertCycleWritable).not.toHaveBeenCalled();
    });

    test('a review on a REPLACED round is refused up front: the current round is what to contest', async () => {
        wireOpen({ supersededAt: daysAgo(4) });
        const err = await Dispute.open({
            supervisorReviewId: REVIEW,
            employeeId: 138,
            reason: 'x',
        }).catch((e) => e);
        expect(err).toMatchObject({
            status: 409,
            code: 'DISPUTE_ROUND_SUPERSEDED',
            i18n: { key: 'employee:sr_err_round_superseded' },
        });
        expect(runs(/INSERT INTO assessment_disputes/)).toHaveLength(0);
    });

    test('the legitimate path is intact: fresh decision, open campaign, current round → opened + reviewer told', async () => {
        wireOpen();
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: 138, reason: 'ma preuve' })
        ).resolves.toBe(900);
        expect(runs(/INSERT INTO assessment_disputes/)).toHaveLength(1);
        expect(mockNotify).toHaveBeenCalledWith(
            expect.objectContaining({ userType: 'employee', userId: 136, kind: 'dispute.opened' })
        );
    });

    test('the order of the gates: ownership and state first, then round, campaign, window', async () => {
        wireOpen({ status: 'pending', decidedAt: daysAgo(90), supersededAt: daysAgo(1) });
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: 138, reason: 'x' })
        ).rejects.toMatchObject({ code: 'DISPUTE_NOT_DISPUTABLE' });
        wireOpen({ decidedAt: daysAgo(90) });
        await expect(
            Dispute.open({ supervisorReviewId: REVIEW, employeeId: 84, reason: 'x' })
        ).rejects.toMatchObject({ code: 'DISPUTE_NOT_OWNER' });
    });

    test('both languages carry the two new sentences', () => {
        const fr = require('../../locales/fr/employee.json');
        const en = require('../../locales/en/employee.json');
        for (const k of ['sr_err_round_superseded', 'sr_sysnote_promotion_withheld_superseded']) {
            expect(typeof fr[k]).toBe('string');
            expect(typeof en[k]).toBe('string');
            expect(fr[k]).not.toBe(en[k]);
        }
        // The route maps the new code onto that catalogue entry.
        const route = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/routes/v2-slf.js'),
            'utf8'
        );
        expect(route).toMatch(/DISPUTE_ROUND_SUPERSEDED:\s*'employee:sr_err_round_superseded'/);
    });
});

// ---------------------------------------------------------------------------
// Z-litige-3 — a replaced round never overwrites the current official level
// ---------------------------------------------------------------------------
function wirePromotion({ supersededAt }) {
    mockDb.get.mockImplementation(async (sql, params = []) => {
        const q = norm(sql);
        if (
            /sr\.employee_id, sr\.skill_id, sa\.superseded_at FROM supervisor_reviews sr LEFT JOIN self_assessment_rounds sa/.test(
                q
            )
        )
            return { employeeId: 138, skillId: 299, supersededAt };
        if (/FROM admins WHERE id = \?/.test(q))
            return Number(params[0]) === 1 ? { id: 1 } : undefined;
        if (/FROM admins WHERE username = 'admin'/.test(q)) return { id: 1 };
        return undefined;
    });
}

describe('Z-litige-3 — a dispute decided on a replaced round keeps its rating on the review only', () => {
    test('replaced round: no skill upsert, the dispute is annotated ONCE, the withholding is logged', async () => {
        wirePromotion({ supersededAt: daysAgo(4) });
        await expect(
            Dispute._applyDecidedRatingToSkill(REVIEW, 1, 136, 75)
        ).resolves.toBeUndefined();
        expect(mockSkill.upsert).not.toHaveBeenCalled();
        const mark = runs(
            /UPDATE assessment_disputes SET reason = COALESCE\(reason, ''\) \|\| ' ' \|\| \?/
        );
        expect(mark).toHaveLength(1);
        const [sql, params] = mark[0];
        expect(norm(sql)).toMatch(
            /WHERE id = \? AND COALESCE\(reason, ''\) NOT LIKE '%' \|\| \? \|\| '%'/
        );
        expect(params).toEqual([
            '[promotion_withheld: replaced round]',
            75,
            '[promotion_withheld: replaced round]',
        ]);
        expect(mockLog).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'DISPUTE_PROMOTION_WITHHELD', entityId: REVIEW })
        );
    });

    test('the annotation is a SYSTEM note the employee page can name, never part of anyone’s words', () => {
        const split = Dispute.splitReason(
            'ma preuve\n\n[resolution:L0] niveau 1 maintenu [promotion_withheld: replaced round]'
        );
        expect(split.systemNotes).toEqual(['promotion_withheld_superseded']);
        expect(split.employeeReason).toBe('ma preuve');
        expect(split.resolutionNote).toBe('niveau 1 maintenu');
    });

    test('current round: the promotion still flows to the official profile', async () => {
        wirePromotion({ supersededAt: null });
        await Dispute._applyDecidedRatingToSkill(REVIEW, 2, 1, 75);
        expect(mockSkill.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                employeeId: 138,
                skillId: 299,
                currentLevel: 2,
                assessedBy: 1,
            })
        );
        expect(runs(/promotion_withheld/)).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Z-litige-2 / Z-litige-6 — SelfAssessmentWorkflowService
// ---------------------------------------------------------------------------
function wireWorkflow({ state, selfLevel = 1, reviewLevel = null, cycleId = 11 } = {}) {
    mockDb.get.mockImplementation(async (sql) => {
        const q = norm(sql);
        if (/SELECT \* FROM self_assessments WHERE id = \?/.test(q))
            return {
                id: ROUND,
                employeeId: 138,
                skillId: 299,
                workflowState: state,
                selfRatedLevel: selfLevel,
                cycleId,
            };
        if (/FROM supervisor_reviews sr JOIN self_assessment_rounds sa/.test(q))
            return { currentLevel: reviewLevel, selfLevel };
        if (/supervisor_rated_level AS "lvl"/.test(q))
            return reviewLevel != null ? { lvl: reviewLevel } : undefined;
        if (/FROM admins WHERE username = 'admin'/.test(q)) return { id: 1 };
        if (/INSERT INTO self_assessment_comments/.test(q)) return { id: 77 };
        return undefined;
    });
}
const finalisation = () =>
    runs(/UPDATE supervisor_reviews SET decision = \?, recommendation = \?, status = 'completed'/);
const stateUpdate = () => runs(/UPDATE self_assessments SET workflow_state/);

describe('Z-litige-2 — who rated is not who validated', () => {
    test('managerValidate keeps a reviewer who already COMPLETED the row; the validation is named on the round', async () => {
        wireWorkflow({ state: 'reviewed', reviewLevel: 1 });
        await WF.managerValidate(ROUND, MANAGER);
        const fin = finalisation();
        expect(fin).toHaveLength(1);
        const [sql, params] = fin[0];
        // The rule is in the statement: the existing reviewer survives only when
        // the row is no longer pending AND this decision confirms it.
        expect(norm(sql)).toMatch(
            /reviewed_by = CASE WHEN reviewed_by IS NOT NULL AND status <> 'pending' AND \?::text = 'approve' THEN reviewed_by ELSE \? END/
        );
        expect(params).toEqual(['approve', null, 1, 0, 'approve', 137, ROUND]);
        const [, stateParams] = stateUpdate()[0];
        expect(stateParams).toEqual(expect.arrayContaining([137, 'employee:137']));
    });

    test('a REJECTION overturns the reviewer’s decision, so it is attributed to the person rejecting', async () => {
        wireWorkflow({ state: 'reviewed', reviewLevel: 1 });
        await WF.reject(ROUND, MANAGER, 'pas de preuve');
        const [sql, params] = finalisation()[0];
        expect(norm(sql)).toMatch(/\?::text = 'approve' THEN reviewed_by ELSE \? END/);
        expect(params.slice(0, 1)).toEqual(['reject']);
        expect(params.slice(-3)).toEqual(['reject', 137, ROUND]);
    });

    test('an administrator never writes the employee-FK column at all', async () => {
        wireWorkflow({ state: 'reviewed', reviewLevel: 1 });
        await WF.managerValidate(ROUND, { id: 666, userType: 'admin', role: 'superadmin' });
        const [sql, params] = finalisation()[0];
        expect(norm(sql)).not.toMatch(/reviewed_by/);
        expect(params).toEqual(['approve', null, 1, 0, ROUND]);
    });
});

describe('Z-litige-6 — a reviewer can only refuse what was handed to a reviewer', () => {
    test.each(['draft', 'changes_requested'])(
        '%s belongs to the employee: refused with the catalogue key, nothing written',
        async (state) => {
            wireWorkflow({ state });
            const err = await WF.reject(ROUND, SUPERVISOR, 'motif').catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err.i18n).toEqual({
                key: 'assess:saw_err_cannot_reject',
                vars: { stateRaw: state },
            });
            expect(stateUpdate()).toHaveLength(0);
            expect(finalisation()).toHaveLength(0);
            expect(mockNotify).not.toHaveBeenCalled();
        }
    );

    test.each(['submitted', 'under_review', 'reviewed', 'arbitration'])(
        '%s is rejectable, with the same four-state stale guard',
        async (state) => {
            wireWorkflow({ state });
            await WF.reject(ROUND, SUPERVISOR, 'motif');
            const [sql, params] = stateUpdate()[0];
            expect(norm(sql)).toMatch(/AND workflow_state IN \(\?,\?,\?,\?\)/);
            expect(params.slice(-4)).toEqual([
                'submitted',
                'under_review',
                'reviewed',
                'arbitration',
            ]);
            expect(mockNotify).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'sa.rejected' })
            );
        }
    );

    test.each(['approved', 'rejected'])('%s is terminal — still refused', async (state) => {
        wireWorkflow({ state });
        await expect(WF.reject(ROUND, SUPERVISOR, 'motif')).rejects.toMatchObject({
            i18n: { key: 'assess:saw_err_cannot_reject', vars: { stateRaw: state } },
        });
    });
});

// ---------------------------------------------------------------------------
// Z-litige-4 — the decision is written first and its rowcount is read
// ---------------------------------------------------------------------------
const PENDING = {
    id: 83,
    selfAssessmentId: ROUND,
    employeeId: 138,
    cycleId: 11,
    requesterRef: 'employee:138',
    requesterRole: 'employee',
    reason: 'probe',
    targetState: 'reviewed',
    targetStatus: 'reviewed',
    status: 'pending',
    decidedByRef: null,
};
function wireDecide({ raceOutcome = 'refused', decisionChanges = 0 } = {}) {
    let reads = 0;
    mockDb.get.mockImplementation(async (sql) => {
        const q = norm(sql);
        if (/FROM assessment_change_requests WHERE id = \?/.test(q)) {
            reads += 1;
            // First read: what decide() pre-reads (pending). Any later read: what
            // the concurrent decider left behind.
            return reads === 1
                ? PENDING
                : { ...PENDING, status: raceOutcome, decidedByRef: 'employee:137' };
        }
        if (/FROM self_assessment_rounds r/.test(q))
            return {
                id: ROUND,
                employeeId: 138,
                skillId: 299,
                workflowState: 'reviewed',
                status: 'reviewed',
                cycleId: 11,
                approvedAt: null,
                reviewedAt: daysAgo(2),
            };
        return undefined;
    });
    mockDb.run.mockImplementation(async (sql) =>
        /UPDATE assessment_change_requests/.test(sql)
            ? { changes: decisionChanges }
            : { changes: 1 }
    );
}

describe('Z-litige-4 — a decision that lands on no row grants nothing', () => {
    let apply;
    beforeEach(() => {
        apply = jest.spyOn(WF, 'applyGrantedChangeRequest').mockResolvedValue({});
    });
    afterEach(() => apply.mockRestore());

    test('after a concurrent refusal, an octroi is 409 already_decided; the assessment is not reopened, nothing is logged or notified', async () => {
        wireDecide({ decisionChanges: 0 });
        const err = await ACR.decide(83, SUPERVISOR, { decision: 'granted', reason: 'ok' }).catch(
            (e) => e
        );
        expect(err).toMatchObject({ code: 'already_decided', status: 409 });
        expect(err.i18n).toEqual({
            key: 'assess:acr_err_already_decided',
            vars: { outcomeRaw: 'refused' },
        });
        expect(apply).not.toHaveBeenCalled();
        expect(mockLog).not.toHaveBeenCalled();
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('when the row is still pending, the UPDATE comes FIRST and the reopening follows in the same transaction', async () => {
        wireDecide({ decisionChanges: 1 });
        const order = [];
        mockDb.run.mockImplementation(async (sql) => {
            if (/UPDATE assessment_change_requests/.test(sql)) order.push('decision');
            return { changes: 1 };
        });
        apply.mockImplementation(async () => {
            order.push('reopen');
            return {};
        });
        await ACR.decide(83, SUPERVISOR, { decision: 'granted', reason: 'ok' });
        expect(order).toEqual(['decision', 'reopen']);
        expect(mockDb.runTransaction).toHaveBeenCalled();
        expect(mockNotify).toHaveBeenCalled();
    });

    test('the campaign gate is still read before anything is written', async () => {
        wireDecide({ decisionChanges: 1 });
        mockGate = {
            writable: false,
            code: 'cycle_write_closed',
            message:
                'La campagne X a été clôturée le 01/09/2026 : plus aucune écriture n’y est possible.',
        };
        await expect(
            ACR.decide(83, SUPERVISOR, { decision: 'granted', reason: 'ok' })
        ).rejects.toMatchObject({ code: 'cycle_write_closed' });
        expect(runs(/UPDATE assessment_change_requests/)).toHaveLength(0);
        expect(apply).not.toHaveBeenCalled();
    });

    test('withdraw has the same guard: decided meanwhile → 409, no audit of a withdrawal that did not happen', async () => {
        wireDecide({ raceOutcome: 'granted', decisionChanges: 0 });
        await expect(ACR.withdraw(83, EMPLOYEE)).rejects.toMatchObject({
            code: 'already_decided',
            status: 409,
        });
        expect(mockLog).not.toHaveBeenCalled();
    });
});
