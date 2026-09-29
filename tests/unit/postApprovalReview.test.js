'use strict';
/**
 * PostApprovalReviewService (migration 61) — the authorization contract of the
 * supervisor re-review, which is the whole point of the module:
 *
 *   - only an ALREADY APPROVED score can be contested (anything earlier keeps
 *     its normal review/dispute route),
 *   - a manager or supervisor may RAISE a case but must never DECIDE one,
 *     because the score already carries a manager's approval,
 *   - the proficiency scale is 0..4 — a wider range would create a case that
 *     cannot be applied when an admin approves it,
 *   - approving rewrites the confirmed supervisor level.
 *
 * DB mocked; the database's own CHECK constraint is verified separately
 * against the live schema.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const mockScopedEmployeeIds = jest.fn();
jest.mock('../../src/utils/rbacScope', () => ({
    scopedEmployeeIds: (...a) => mockScopedEmployeeIds(...a),
}));

const Svc = require('../../src/services/PostApprovalReviewService');

const ADMIN = { id: 1, userType: 'admin', role: 'superadmin' };
const MANAGER = { id: 20, userType: 'manager', role: 'manager' };
const APPROVED_SA = { id: 9, employeeId: 84, skillId: 5, status: 'approved', workflowState: null };

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ lastID: 77 });
    mockDb.runTransaction.mockReset().mockImplementation((fn) => fn());
    mockScopedEmployeeIds.mockReset().mockResolvedValue(null); // null = unrestricted
});

describe('raise', () => {
    test('refuses a score that is not approved yet', async () => {
        mockDb.get.mockResolvedValueOnce({ ...APPROVED_SA, status: 'submitted' });
        await expect(
            Svc.raise(ADMIN, { selfAssessmentId: 9, proposedLevel: 4, reason: 'r' })
        ).rejects.toMatchObject({ userMessage: 'not_approved_yet' });
    });

    test.each([[-1], [5], [9], ['abc']])('refuses level %p (scale is 0..4)', async (lvl) => {
        await expect(
            Svc.raise(ADMIN, { selfAssessmentId: 9, proposedLevel: lvl, reason: 'r' })
        ).rejects.toMatchObject({ userMessage: 'invalid_level' });
    });

    test('requires a reason', async () => {
        await expect(
            Svc.raise(ADMIN, { selfAssessmentId: 9, proposedLevel: 4, reason: '   ' })
        ).rejects.toMatchObject({ userMessage: 'reason_required' });
    });

    test('refuses an employee outside the raiser scope', async () => {
        mockScopedEmployeeIds.mockResolvedValue([1, 2, 3]); // 84 not included
        mockDb.get.mockResolvedValueOnce(APPROVED_SA);
        await expect(
            Svc.raise(MANAGER, { selfAssessmentId: 9, proposedLevel: 4, reason: 'r' })
        ).rejects.toMatchObject({ userMessage: 'out_of_scope' });
    });

    test('refuses a second pending case on the same assessment', async () => {
        mockDb.get
            .mockResolvedValueOnce(APPROVED_SA) // the assessment
            .mockResolvedValueOnce({ level: 3 }) // current confirmed level
            .mockResolvedValueOnce({ id: 42 }); // an existing pending case
        await expect(
            Svc.raise(ADMIN, { selfAssessmentId: 9, proposedLevel: 4, reason: 'r' })
        ).rejects.toMatchObject({ userMessage: 'already_pending' });
    });

    test('records the level as approved at the time of contest', async () => {
        mockDb.get
            .mockResolvedValueOnce(APPROVED_SA)
            .mockResolvedValueOnce({ level: 2 })
            .mockResolvedValueOnce(null);
        await Svc.raise(MANAGER, { selfAssessmentId: 9, proposedLevel: 4, reason: ' too low ' });
        const params = mockDb.run.mock.calls[0][1];
        expect(params[3]).toBe(2); // approved_level snapshotted
        expect(params[4]).toBe(4); // proposed_level
        expect(params[5]).toBe('too low'); // reason trimmed
        expect(params[6]).toBe(MANAGER.id); // raised_by = the manager
        expect(params[7]).toBeNull(); // raised_by_admin_id
    });
});

describe('decide — administrators only', () => {
    test.each([
        ['manager', MANAGER],
        ['supervisor/employee', { id: 30, userType: 'employee', role: 'employee' }],
    ])('refuses a %s even inside their scope', async (_label, user) => {
        await expect(Svc.decide(user, 77, true, 'note')).rejects.toMatchObject({
            userMessage: 'admin_only',
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('refuses a case that was already decided', async () => {
        mockDb.get.mockResolvedValueOnce({
            id: 77,
            state: 'approved',
            employeeId: 84,
            proposedLevel: 4,
        });
        await expect(Svc.decide(ADMIN, 77, true, null)).rejects.toMatchObject({
            userMessage: 'already_decided',
        });
    });

    test('approving stamps the admin and rewrites the confirmed level', async () => {
        mockDb.get.mockResolvedValueOnce({
            id: 77,
            selfAssessmentId: 9,
            employeeId: 84,
            skillId: 5,
            proposedLevel: 4,
            state: 'pending',
        });
        await Svc.decide(ADMIN, 77, true, 'evidence accepted');

        const [updateSql, updateParams] = mockDb.run.mock.calls[0];
        expect(updateSql).toMatch(/UPDATE post_approval_reviews/i);
        expect(updateParams[0]).toBe('approved');
        expect(updateParams[1]).toBe(ADMIN.id); // decided_by_admin_id

        const [levelSql, levelParams] = mockDb.run.mock.calls[1];
        expect(levelSql).toMatch(/UPDATE supervisor_reviews/i);
        expect(levelParams[0]).toBe(4); // confirmed level becomes the proposal
    });

    test('rejecting does NOT touch the confirmed level', async () => {
        mockDb.get.mockResolvedValueOnce({
            id: 77,
            selfAssessmentId: 9,
            employeeId: 84,
            skillId: 5,
            proposedLevel: 4,
            state: 'pending',
        });
        await Svc.decide(ADMIN, 77, false, 'not persuaded');
        expect(mockDb.run).toHaveBeenCalledTimes(1);
        expect(mockDb.run.mock.calls[0][1][0]).toBe('rejected');
    });

    test('refuses an admin acting outside their scope', async () => {
        mockScopedEmployeeIds.mockResolvedValue([1, 2]); // 84 not included
        mockDb.get.mockResolvedValueOnce({
            id: 77,
            selfAssessmentId: 9,
            employeeId: 84,
            skillId: 5,
            proposedLevel: 4,
            state: 'pending',
        });
        await expect(
            Svc.decide(
                {
                    id: 5,
                    userType: 'admin',
                    role: 'localadmin',
                    permissions: ['approve_assessments'],
                },
                77,
                true,
                null
            )
        ).rejects.toMatchObject({ userMessage: 'out_of_scope' });
    });
});

describe('list (scoped)', () => {
    test('a caller governing nobody sees an empty queue and never queries', async () => {
        mockScopedEmployeeIds.mockResolvedValue([]);
        await expect(Svc.list(MANAGER, {})).resolves.toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});
