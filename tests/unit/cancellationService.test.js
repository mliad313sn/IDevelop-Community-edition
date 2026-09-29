'use strict';
/**
 * CancellationService — cancelling a coaching, mentoring, PIP or IDP plan
 * under a local admin's approval, with the trail preserved.
 *
 * The rules that define the module, all asserted here:
 *   - an explanation is mandatory,
 *   - a manager may REQUEST but never DECIDE,
 *   - the requester can never approve their own request (two-person rule),
 *   - approval marks the plan cancelled — it never DELETEs,
 *   - the state before cancelling is captured for the trail.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const mockCanReview = jest.fn();
const mockReviewableIds = jest.fn();
jest.mock('../../src/services/GovernanceService', () => ({
    canReview: (...a) => mockCanReview(...a),
    reviewableEmployeeIds: (...a) => mockReviewableIds(...a),
}));

const Svc = require('../../src/services/CancellationService');

const ADMIN = { id: 1, userType: 'admin', role: 'superadmin' };
// Deciding a cancellation is now a CATALOGUE right (manage_mobility), not a
// role shape — a local admin must actually hold the grant. A zero-permission
// admin is refused (see the dedicated test below), which is the whole point of
// closing the role-shape bypass.
const ADMIN2 = { id: 2, userType: 'admin', role: 'localadmin', permissions: ['manage_mobility'] };
const ADMIN_NO_RIGHTS = { id: 3, userType: 'admin', role: 'localadmin', permissions: [] };
const VIEWER = { id: 4, userType: 'admin', role: 'viewer', permissions: ['manage_mobility'] };
const MANAGER = { id: 20, userType: 'manager', role: 'manager' };
const PLAN = { id: 9, employeeId: 84, state: 'active' };

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ lastID: 55, changes: 1 });
    mockDb.runTransaction.mockReset().mockImplementation((fn) => fn());
    mockCanReview.mockReset().mockResolvedValue(true);
    mockReviewableIds.mockReset().mockResolvedValue(null);
});

describe('request', () => {
    test.each([['coaching'], ['mentoring'], ['pip'], ['idp']])('accepts %s plans', async (type) => {
        mockDb.get.mockResolvedValueOnce(PLAN).mockResolvedValueOnce(null);
        await expect(
            Svc.request(ADMIN, { entityType: type, entityId: 9, reason: 'r' })
        ).resolves.toBeTruthy();
    });

    test('refuses an unknown plan type', async () => {
        await expect(
            Svc.request(ADMIN, { entityType: 'payroll', entityId: 1, reason: 'r' })
        ).rejects.toMatchObject({ userMessage: 'unknown_entity_type' });
    });

    test('an explanation is mandatory', async () => {
        await expect(
            Svc.request(ADMIN, { entityType: 'pip', entityId: 9, reason: '   ' })
        ).rejects.toMatchObject({ userMessage: 'reason_required' });
    });

    test('a plain employee may not request', async () => {
        await expect(
            Svc.request(
                { id: 5, userType: 'employee', role: 'employee' },
                { entityType: 'pip', entityId: 9, reason: 'r' }
            )
        ).rejects.toMatchObject({ userMessage: 'not_allowed' });
    });

    test('a MANAGER may request', async () => {
        mockDb.get.mockResolvedValueOnce(PLAN).mockResolvedValueOnce(null);
        await Svc.request(MANAGER, { entityType: 'coaching', entityId: 9, reason: 'moved site' });
        const params = mockDb.run.mock.calls[0][1];
        expect(params[5]).toBe(MANAGER.id); // requested_by_employee_id
        expect(params[6]).toBeNull(); // requested_by_admin_id
    });

    test.each([['cancelled'], ['completed'], ['archived'], ['closed_success']])(
        'refuses a plan already %s',
        async (state) => {
            mockDb.get.mockResolvedValueOnce({ ...PLAN, state });
            await expect(
                Svc.request(ADMIN, { entityType: 'pip', entityId: 9, reason: 'r' })
            ).rejects.toMatchObject({ userMessage: 'already_closed' });
        }
    );

    test('refuses a plan outside the requester scope', async () => {
        mockDb.get.mockResolvedValueOnce(PLAN);
        mockCanReview.mockResolvedValue(false);
        await expect(
            Svc.request(MANAGER, { entityType: 'idp', entityId: 9, reason: 'r' })
        ).rejects.toMatchObject({ userMessage: 'out_of_scope' });
    });

    test('captures the state BEFORE cancelling, for the trail', async () => {
        mockDb.get.mockResolvedValueOnce({ ...PLAN, state: 'active' }).mockResolvedValueOnce(null);
        await Svc.request(ADMIN, { entityType: 'coaching', entityId: 9, reason: ' too costly ' });
        const params = mockDb.run.mock.calls[0][1];
        expect(params[4]).toBe('active'); // previous_state
        expect(params[3]).toBe('too costly'); // reason trimmed
    });

    test('refuses a second pending request on the same plan', async () => {
        mockDb.get.mockResolvedValueOnce(PLAN).mockResolvedValueOnce({ id: 77 });
        await expect(
            Svc.request(ADMIN, { entityType: 'coaching', entityId: 9, reason: 'r' })
        ).rejects.toMatchObject({ userMessage: 'already_pending' });
    });
});

describe('decide — admin only, never the requester', () => {
    const pending = {
        id: 55,
        entityType: 'coaching',
        entityId: 9,
        employeeId: 84,
        state: 'pending',
        byAdmin: null,
        byEmployee: 20,
    };

    test('a manager may not decide', async () => {
        await expect(Svc.decide(MANAGER, 55, true, null)).rejects.toMatchObject({
            userMessage: 'admin_only',
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('the requesting admin cannot approve their own request', async () => {
        mockDb.get.mockResolvedValueOnce({ ...pending, byAdmin: ADMIN.id, byEmployee: null });
        await expect(Svc.decide(ADMIN, 55, true, null)).rejects.toMatchObject({
            userMessage: 'requester_cannot_approve',
        });
    });

    test('a different admin CAN approve, and the plan is marked cancelled — not deleted', async () => {
        mockDb.get
            .mockResolvedValueOnce({ ...pending, byAdmin: ADMIN.id, byEmployee: null })
            // decide() now re-reads the plan's CURRENT state inside the transaction
            .mockResolvedValueOnce({ id: 9, state: 'active' });
        await Svc.decide(ADMIN2, 55, true, 'confirmed');

        const sqls = mockDb.run.mock.calls.map((c) => c[0]);
        expect(sqls[0]).toMatch(/UPDATE cancellation_requests/i);
        expect(mockDb.run.mock.calls[0][1][0]).toBe('approved');
        expect(mockDb.run.mock.calls[0][1][1]).toBe(ADMIN2.id);
        expect(sqls[1]).toMatch(/UPDATE coaching_plans SET state/i);
        // The whole point: never a DELETE.
        sqls.forEach((s) => expect(s).not.toMatch(/DELETE/i));
    });

    test('rejecting leaves the plan untouched', async () => {
        mockDb.get.mockResolvedValueOnce({ ...pending, byAdmin: ADMIN.id, byEmployee: null });
        await Svc.decide(ADMIN2, 55, false, 'not justified');
        expect(mockDb.run).toHaveBeenCalledTimes(1);
        expect(mockDb.run.mock.calls[0][1][0]).toBe('rejected');
    });

    test('an already-decided request cannot be decided again', async () => {
        mockDb.get.mockResolvedValueOnce({ ...pending, state: 'approved' });
        await expect(Svc.decide(ADMIN2, 55, true, null)).rejects.toMatchObject({
            userMessage: 'already_decided',
        });
    });

    test('a concurrent decision loses on the rowcount guard', async () => {
        mockDb.get.mockResolvedValueOnce({ ...pending, byAdmin: ADMIN.id, byEmployee: null });
        mockDb.run.mockResolvedValueOnce({ changes: 0 }); // somebody else got there first
        await expect(Svc.decide(ADMIN2, 55, true, null)).rejects.toMatchObject({
            userMessage: 'already_decided',
        });
    });

    test('refuses an admin acting outside their scope', async () => {
        mockDb.get.mockResolvedValueOnce({ ...pending, byAdmin: ADMIN.id, byEmployee: null });
        mockCanReview.mockResolvedValue(false);
        await expect(Svc.decide(ADMIN2, 55, true, null)).rejects.toMatchObject({
            userMessage: 'out_of_scope',
        });
    });

    // --- the role-shape bypass, pinned shut -------------------------------
    // Before the access-scalability fix these two principals were accepted here
    // purely because `userType === 'admin'` / the role name was in an OR-list.
    test('a local admin WITHOUT manage_mobility cannot decide (role shape is not authority)', async () => {
        mockDb.get.mockResolvedValueOnce({ ...pending, byAdmin: ADMIN.id, byEmployee: null });
        mockCanReview.mockResolvedValue(true);
        await expect(Svc.decide(ADMIN_NO_RIGHTS, 55, true, null)).rejects.toMatchObject({
            userMessage: 'admin_only',
        });
    });

    test('a read-only viewer cannot decide even if the write slug is present', async () => {
        mockDb.get.mockResolvedValueOnce({ ...pending, byAdmin: ADMIN.id, byEmployee: null });
        mockCanReview.mockResolvedValue(true);
        await expect(Svc.decide(VIEWER, 55, true, null)).rejects.toMatchObject({
            userMessage: 'admin_only',
        });
    });

    test('each plan type updates its own table and column', async () => {
        for (const [type, table, col] of [
            ['pip', 'pips', 'state'],
            ['idp', 'idp_plans', 'status'],
            ['mentoring', 'coaching_plans', 'state'],
        ]) {
            mockDb.run.mockClear();
            mockDb.get
                .mockResolvedValueOnce({
                    ...pending,
                    entityType: type,
                    byAdmin: ADMIN.id,
                    byEmployee: null,
                })
                .mockResolvedValueOnce({ id: 9, state: 'active' }); // the plan re-read in decide()
            await Svc.decide(ADMIN2, 55, true, null);
            expect(mockDb.run.mock.calls[1][0]).toMatch(
                new RegExp(`UPDATE ${table} SET ${col}`, 'i')
            );
        }
    });
});

describe('list (scoped)', () => {
    test('a caller governing nobody sees an empty queue and never queries', async () => {
        mockReviewableIds.mockResolvedValue([]);
        await expect(Svc.list(MANAGER, {})).resolves.toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});
