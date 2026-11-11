'use strict';
/**
 * SA-42: self-assessment workflow.
 *   - arbitrate: a rejection needs a reason; the employee is notified on
 *     approval and rejection.
 *   - arbitrate: the neutral outcome (to 'arbitration') needs an open dispute.
 *   - requestChanges and withdrawReview: their writes commit in one transaction.
 *   - _promoteToSkillAssessment: the best-effort blocks run in a SAVEPOINT.
 *   - SelfAssessmentModel.submitAssessment keeps the first submittedAt.
 */

let mockDb, mockNotify, svc;

function load({ sa = {}, dispute = null } = {}) {
    jest.resetModules();
    const row = {
        id: 11,
        employeeId: 70,
        skillId: 9,
        cycleId: null,
        workflowState: 'reviewed',
        selfRatedLevel: 2,
        ...sa,
    };
    mockDb = {
        inTx: 0,
        get: jest.fn(async (sql) => {
            if (/SELECT \* FROM self_assessments WHERE id = \?/.test(sql)) return row;
            if (/FROM assessment_disputes ad/.test(sql)) return dispute;
            if (/SELECT cycle_id AS "cycleId", workflow_state/.test(sql))
                return { cycleId: null, workflowState: row.workflowState };
            if (/FROM supervisor_reviews WHERE self_assessment_id/.test(sql))
                return { status: 'completed' };
            return undefined;
        }),
        all: jest.fn(async () => []),
        run: jest.fn(async () => ({ changes: 1 })),
        runTransaction: jest.fn(async (fn) => {
            mockDb.inTx++;
            try {
                return await fn();
            } finally {
                mockDb.inTx--;
            }
        }),
        runInSavepoint: jest.fn(async (fn) => fn()),
    };
    // Record whether each write ran inside the transaction.
    const run = mockDb.run;
    mockDb.run = jest.fn(async (sql, p) => {
        mockDb.run.txFlags = mockDb.run.txFlags || [];
        mockDb.run.txFlags.push([sql, mockDb.inTx > 0]);
        return run(sql, p);
    });
    mockNotify = { notify: jest.fn(async () => {}) };
    jest.doMock('../../src/config/database', () => mockDb);
    jest.doMock('../../src/services/NotificationService', () => mockNotify);
    jest.doMock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
    jest.doMock('../../src/services/RBACService', () => ({
        isSuperAdmin: (u) => u && u.role === 'superadmin',
        isViewer: () => false,
    }));
    svc = require('../../src/services/SelfAssessmentWorkflowService');
    jest.spyOn(svc, '_auth').mockResolvedValue({
        canManage: true,
        canSupervise: true,
        isSelf: false,
        isAdmin: false,
        actorType: 'manager',
        _userId: 50,
    });
    jest.spyOn(svc, '_finalizeSupervisorReview').mockResolvedValue();
    jest.spyOn(svc, '_promoteToSkillAssessment').mockResolvedValue();
    jest.spyOn(svc, 'addComment').mockResolvedValue({ id: 1 });
    return row;
}
const MGR = { id: 50, userType: 'manager' };
const states = () =>
    mockDb.run.mock.calls.filter(([s]) => /UPDATE self_assessments SET workflow_state/.test(s));

describe('an arbitrated rejection carries its reason and the employee is told', () => {
    test.each([[undefined], [''], ['   ']])(
        'reject with note %p → refused, nothing written',
        async (note) => {
            load();
            await expect(svc.arbitrate(11, MGR, { outcome: 'reject', note })).rejects.toMatchObject(
                {
                    i18n: { key: 'assess:saw_err_arbitrate_reject_reason' },
                }
            );
            expect(states()).toHaveLength(0);
            expect(mockNotify.notify).not.toHaveBeenCalled();
        }
    );
    test('reject with a reason → rejected, employee notified sa.rejected with the reason', async () => {
        load();
        await svc.arbitrate(11, MGR, { outcome: 'reject', note: 'The evidence is not sufficient' });
        expect(states()[0][1][0]).toBe('rejected');
        expect(mockNotify.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 70,
                kind: 'sa.rejected',
                payload: expect.objectContaining({ reason: 'The evidence is not sufficient' }),
            })
        );
    });
    test('approve → employee notified sa.approved', async () => {
        load();
        await svc.arbitrate(11, MGR, { outcome: 'approve' });
        expect(mockNotify.notify).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 70, kind: 'sa.approved' })
        );
    });
});

describe('the neutral outcome needs an open dispute', () => {
    test('no open dispute → refused as a 409 ("cannot … from"), nothing written', async () => {
        load({ dispute: null });
        const e = await svc.arbitrate(11, MGR, {}).catch((x) => x);
        expect(e.i18n.key).toBe('assess:saw_err_arbitrate_no_dispute');
        expect(require('../../src/utils/apiErrors').domainStatus(e.message)).toBe(409);
        expect(states()).toHaveLength(0);
    });
    test('an open dispute → moves to arbitration, no employee notice', async () => {
        load({ dispute: { id: 3 } });
        await svc.arbitrate(11, MGR, { note: 'to settle' });
        expect(states()[0][1][0]).toBe('arbitration');
        const q = mockDb.get.mock.calls.find(([s]) => /assessment_disputes/.test(s))[0];
        expect(q).toMatch(/ad\.state IN \('open', 'escalated'\)/);
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });
});

describe('requestChanges and withdrawReview commit as one', () => {
    test('requestChanges: state, review row and event all inside the transaction', async () => {
        load({ sa: { workflowState: 'submitted' } });
        await svc.requestChanges(11, MGR, 'Please add the evidence');
        const flags = mockDb.run.txFlags.filter(([s]) =>
            /UPDATE self_assessments|UPDATE supervisor_reviews|INSERT INTO self_assessment_events/.test(
                s
            )
        );
        expect(flags.length).toBeGreaterThanOrEqual(3);
        expect(flags.every(([, inTx]) => inTx)).toBe(true);
    });
    test('withdrawReview: state, review reset and event all inside the transaction', async () => {
        load({ sa: { workflowState: 'reviewed' } });
        await svc.withdrawReview(
            11,
            { id: 1, userType: 'admin', role: 'superadmin' },
            'wrong reviewer'
        );
        const flags = mockDb.run.txFlags.filter(([s]) =>
            /UPDATE self_assessments|UPDATE supervisor_reviews|INSERT INTO self_assessment_events/.test(
                s
            )
        );
        expect(flags.length).toBeGreaterThanOrEqual(3);
        expect(flags.every(([, inTx]) => inTx)).toBe(true);
    });
});

describe('the promotion is contained in savepoints', () => {
    test('both best-effort blocks go through runInSavepoint', async () => {
        load();
        svc._promoteToSkillAssessment.mockRestore();
        jest.doMock('../../src/models/SkillAssessmentModel', () => ({
            upsert: jest.fn(async () => ({})),
        }));
        await svc._promoteToSkillAssessment(
            { id: 11, employeeId: 70, skillId: 9, selfRatedLevel: 2 },
            MGR,
            { isAdmin: false }
        );
        expect(mockDb.runInSavepoint).toHaveBeenCalledTimes(2);
    });
});

describe('the first submission date is kept', () => {
    test('submitAssessment COALESCEs submittedAt', async () => {
        load();
        const M = require('../../src/models/SelfAssessmentModel');
        await M.submitAssessment(70);
        const sql = mockDb.run.mock.calls.find(([s]) => /UPDATE selfAssessments/.test(s))[0];
        expect(sql).toMatch(/submittedAt = COALESCE\(submittedAt, CURRENT_TIMESTAMP\)/);
    });
});
