'use strict';
/**
 * COMMITTEE — LOT P (development plans), part 1: the cancellation queue and
 * the coaching plan lifecycle.
 *
 * Reproduced by execution against the dev database (rolled back) before the fix:
 *   F1  a PIP closed_success (outcome kept) → decide(approve) on a STALE pending
 *       request → state 'cancelled', outcome still 'objectives met'.
 *   F2  coaching plan 22 (cancelled, progress 0) → validateCompletion → completed,
 *       progress 100.
 *   F3  cancelPlan on plan 26 (completed) → cancelled; on plan 29 (active) →
 *       cancelled with cancellation_requests 0 → 0; no reason needed.
 *   F5  IDP 16 cancelled through the queue → its 3 actions still 'pending',
 *       Action Center for employee 68963 still 3.
 *   F7  withdraw by a manage_mobility admin with canReview=false → withdrawn;
 *       CANCELLATION_WITHDRAWN rows 0 → 0.
 * After the fix, same probe: F1 already_closed and closed_success kept; F2
 * "Cannot validate from 'cancelled'"; F3 "Cannot cancel from 'completed'",
 * active plan untouched + 1 pending request, reason mandatory; F5 actions and
 * objectives 'cancelled', Action Center 0; F7 out_of_scope, rows 0 → 1.
 *
 * DB mocked here; the enum discipline (per-table terminal labels in SQL) is
 * asserted on the statements themselves.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);
const mockLog = { log: jest.fn() };
jest.mock('../../src/services/LogService', () => mockLog);
const mockCanReview = jest.fn();
jest.mock('../../src/services/GovernanceService', () => ({
    canReview: (...a) => mockCanReview(...a),
    reviewableEmployeeIds: jest.fn().mockResolvedValue(null),
    // The PERSON behind the account: an employee is themselves, an administration
    // account resolves through admins.linked_employee_id. resolveAuthority calls
    // it before testing the reporting line, so a partial mock here fails with
    // "actingPersonId is not a function" — a missing stub, not a defect in the
    // service. These cases all act as the employee themselves.
    actingPersonId: jest.fn(async (user) => (user && user.id != null ? Number(user.id) : null)),
}));
const mockNotify = jest.fn();
jest.mock('../../src/services/NotificationService', () => ({ notify: (...a) => mockNotify(...a) }));
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'localadmin'),
    isViewer: () => false,
    hasPermission: (u, slug) =>
        Boolean(
            u &&
            u.userType === 'admin' &&
            (u.role === 'superadmin' || (u.permissions || []).includes(slug))
        ),
    canAccessEmployeeData: async () => true,
    scopeFilter: async () => ({ clause: '', params: [] }),
    getFilteredEmployees: async () => [],
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    findById: jest.fn(async (id) => ({ id: Number(id), supervisorId: 20, managerId: null })),
    governs: jest.fn().mockResolvedValue(false),
}));

const Cx = require('../../src/services/CancellationService');
const Coach = require('../../src/services/CoachingPlanService');

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const SUPER2 = { id: 68, userType: 'admin', role: 'superadmin' };
const LOCAL = { id: 2, userType: 'admin', role: 'localadmin', permissions: ['manage_mobility'] };
const MANAGER = { id: 20, userType: 'manager', role: 'manager' };

const norm = (s) => String(s).replace(/\s+/g, ' ');
const runs = () => mockDb.run.mock.calls.map(([s, p]) => [norm(s), p]);
const runsMatching = (re) => runs().filter(([s]) => re.test(s));

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ lastID: 55, changes: 1 });
    mockDb.runTransaction.mockReset().mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockReset().mockImplementation(async (fn) => fn());
    mockLog.log.mockReset().mockResolvedValue(undefined);
    mockNotify.mockReset().mockResolvedValue(null);
    mockCanReview.mockReset().mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// F1 — decide() re-checks the plan's CURRENT state inside the transaction
// ---------------------------------------------------------------------------
describe('F1 decide(): a finished plan is never overwritten by a stale request', () => {
    const pending = (entityType) => ({
        id: 55,
        entityType,
        entityId: 9,
        employeeId: 84,
        state: 'pending',
        byAdmin: SUPER2.id,
        byEmployee: null,
    });

    test.each([
        ['pip', 'closed_success'],
        ['pip', 'closed_failure'],
        ['pip', 'cancelled'],
        ['idp', 'completed'],
        ['idp', 'archived'],
        ['idp', 'cancelled'],
        ['coaching', 'completed'],
        ['mentoring', 'cancelled'],
    ])(
        'approving a request on a %s plan now %s is refused (already_closed) and the plan is not touched',
        async (type, state) => {
            mockDb.get.mockResolvedValueOnce(pending(type)).mockResolvedValueOnce({ id: 9, state });
            await expect(Cx.decide(SUPER, 55, true, 'stale')).rejects.toMatchObject({
                userMessage: 'already_closed',
            });
            expect(runsMatching(/UPDATE (pips|idp_plans|coaching_plans)/i)).toHaveLength(0);
        }
    );

    test('the plan is re-read INSIDE the transaction and locked (FOR UPDATE)', async () => {
        mockDb.get
            .mockResolvedValueOnce(pending('pip'))
            .mockResolvedValueOnce({ id: 9, state: 'active' });
        await Cx.decide(SUPER, 55, true, 'ok');
        const reload = mockDb.get.mock.calls[1][0];
        expect(norm(reload)).toMatch(/FROM pips WHERE id = \? FOR UPDATE/i);
        // ordering: the transaction opened before the plan was re-read
        expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
    });

    test('a live plan IS cancelled, through a state-guarded UPDATE with its OWN enum labels', async () => {
        for (const [type, table, col, terminal] of [
            ['pip', 'pips', 'state', ['closed_success', 'closed_failure', 'cancelled']],
            ['idp', 'idp_plans', 'status', ['completed', 'archived', 'cancelled']],
            ['coaching', 'coaching_plans', 'state', ['completed', 'cancelled']],
            ['mentoring', 'coaching_plans', 'state', ['completed', 'cancelled']],
        ]) {
            mockDb.run.mockClear();
            mockDb.get
                .mockReset()
                .mockResolvedValueOnce(pending(type))
                .mockResolvedValueOnce({ id: 9, state: 'active' });
            await expect(Cx.decide(SUPER, 55, true, 'ok')).resolves.toBe(true);
            const [[sql, params]] = runsMatching(new RegExp(`UPDATE ${table} SET ${col}`, 'i'));
            expect(sql).toMatch(
                new RegExp(
                    `WHERE id = \\? AND ${col} NOT IN \\(${terminal.map(() => '\\?').join(',')}\\)`,
                    'i'
                )
            );
            expect(params).toEqual(['cancelled', 9, ...terminal]);
            // enum discipline: never a label from the OTHER type in this table's guard
            const foreign =
                type === 'pip' ? ['completed', 'archived'] : ['closed_success', 'closed_failure'];
            foreign.forEach((f) => expect(params.slice(2)).not.toContain(f));
        }
    });

    test('a plan that slipped to terminal between the read and the UPDATE loses on the rowcount', async () => {
        mockDb.get
            .mockResolvedValueOnce(pending('pip'))
            .mockResolvedValueOnce({ id: 9, state: 'active' });
        mockDb.run
            .mockResolvedValueOnce({ changes: 1 }) // request row
            .mockResolvedValueOnce({ changes: 0 }); // plan row — already closed by somebody else
        await expect(Cx.decide(SUPER, 55, true, 'ok')).rejects.toMatchObject({
            userMessage: 'already_closed',
        });
    });

    test('REJECTING a request on a finished plan still works (nothing to protect)', async () => {
        mockDb.get.mockResolvedValueOnce(pending('pip'));
        await expect(Cx.decide(SUPER, 55, false, 'moot')).resolves.toBe(true);
        expect(mockDb.get).toHaveBeenCalledTimes(1); // no plan re-read needed
        expect(runs()).toHaveLength(1);
    });

    test('the two-person rule and the request rowcount guard are unchanged', async () => {
        mockDb.get.mockResolvedValueOnce(pending('pip'));
        await expect(Cx.decide(SUPER2, 55, true, null)).rejects.toMatchObject({
            userMessage: 'requester_cannot_approve',
        });
        mockDb.get.mockReset().mockResolvedValueOnce(pending('pip'));
        mockDb.run.mockResolvedValueOnce({ changes: 0 });
        await expect(Cx.decide(SUPER, 55, true, null)).rejects.toMatchObject({
            userMessage: 'already_decided',
        });
    });
});

// ---------------------------------------------------------------------------
// F5 — cascade to open objectives / actions
// ---------------------------------------------------------------------------
describe('F5 cascadePlanCancellation: a cancelled IDP leaves no live work items behind', () => {
    test('is exported (so the maintenance override can use the same cascade)', () => {
        expect(typeof Cx.cascadePlanCancellation).toBe('function');
    });

    test('idp: OPEN objectives and actions move to cancelled; finished ones are left alone', async () => {
        mockDb.run.mockResolvedValueOnce({ changes: 2 }).mockResolvedValueOnce({ changes: 3 });
        await expect(Cx.cascadePlanCancellation('idp', 16)).resolves.toEqual({
            objectives: 2,
            actions: 3,
        });
        const [obj, act] = runs();
        expect(obj[0]).toMatch(
            /UPDATE idp_objectives SET state = 'cancelled'.*WHERE idp_id = \? AND state IN \('pending', 'in_progress'\)/i
        );
        expect(act[0]).toMatch(
            /UPDATE idp_actions SET status = 'cancelled'.*WHERE idp_id = \? AND status IN \('pending', 'in_progress'\)/i
        );
        expect(obj[1]).toEqual([16]);
        expect(act[1]).toEqual([16]);
        runs().forEach(([s]) => expect(s).not.toMatch(/DELETE/i));
    });

    test.each([['pip'], ['coaching'], ['mentoring']])(
        '%s: nothing to cascade, no statement issued',
        async (type) => {
            await expect(Cx.cascadePlanCancellation(type, 9)).resolves.toEqual({
                objectives: 0,
                actions: 0,
            });
            expect(mockDb.run).not.toHaveBeenCalled();
        }
    );

    test('decide(approve) on an IDP runs the cascade inside the same transaction', async () => {
        mockDb.get
            .mockResolvedValueOnce({
                id: 55,
                entityType: 'idp',
                entityId: 16,
                employeeId: 84,
                state: 'pending',
                byAdmin: SUPER2.id,
                byEmployee: null,
            })
            .mockResolvedValueOnce({ id: 16, state: 'draft' });
        await Cx.decide(SUPER, 55, true, 'ok');
        const sqls = runs().map(([s]) => s);
        expect(sqls[1]).toMatch(/UPDATE idp_plans SET status/i);
        expect(sqls[2]).toMatch(/UPDATE idp_objectives/i);
        expect(sqls[3]).toMatch(/UPDATE idp_actions/i);
    });
});

// ---------------------------------------------------------------------------
// F7 — withdraw: scope + audit
// ---------------------------------------------------------------------------
describe('F7 withdraw(): scope-checked and audited', () => {
    const row = (over = {}) => ({
        id: 55,
        entityType: 'coaching',
        entityId: 29,
        employeeId: 87,
        state: 'pending',
        byAdmin: SUPER2.id,
        byEmployee: null,
        ...over,
    });

    test('an admin outside the employee scope cannot withdraw (out_of_scope), nothing written', async () => {
        mockDb.get.mockResolvedValueOnce(row());
        mockCanReview.mockResolvedValue(false);
        await expect(Cx.withdraw(LOCAL, 55)).rejects.toMatchObject({ userMessage: 'out_of_scope' });
        expect(mockCanReview).toHaveBeenCalledWith(LOCAL, 87);
        expect(mockDb.run).not.toHaveBeenCalled();
        expect(mockLog.log).not.toHaveBeenCalled();
    });

    test("an in-scope admin may withdraw somebody else's request, and it is audited", async () => {
        mockDb.get.mockResolvedValueOnce(row());
        mockCanReview.mockResolvedValue(true);
        await expect(Cx.withdraw(LOCAL, 55)).resolves.toBe(true);
        expect(runs()[0][0]).toMatch(/SET state = 'withdrawn' WHERE id = \? AND state = \?/i);
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'CANCELLATION_WITHDRAWN',
                adminId: LOCAL.id,
                entityType: 'coaching',
                entityId: 29,
            })
        );
        expect(JSON.parse(mockLog.log.mock.calls[0][0].details)).toMatchObject({
            requestId: 55,
            byRequester: false,
        });
    });

    test('the requester withdraws their own request without any scope lookup, audited as byRequester', async () => {
        mockDb.get.mockResolvedValueOnce(row());
        await expect(Cx.withdraw(SUPER2, 55)).resolves.toBe(true);
        expect(mockCanReview).not.toHaveBeenCalled();
        expect(JSON.parse(mockLog.log.mock.calls[0][0].details)).toMatchObject({
            requestId: 55,
            byRequester: true,
        });
    });

    test('a manager who did not raise the request is refused (not_yours)', async () => {
        mockDb.get.mockResolvedValueOnce(row({ byAdmin: null, byEmployee: 30 }));
        await expect(Cx.withdraw(MANAGER, 55)).rejects.toMatchObject({ userMessage: 'not_yours' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a concurrent decision beats the withdraw on the rowcount', async () => {
        mockDb.get.mockResolvedValueOnce(row());
        mockDb.run.mockResolvedValueOnce({ changes: 0 });
        await expect(Cx.withdraw(SUPER2, 55)).rejects.toMatchObject({
            userMessage: 'already_decided',
        });
        expect(mockLog.log).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// F2 / F3 — coaching plan lifecycle
// ---------------------------------------------------------------------------
describe('F2 validateCompletion(): only an ACTIVE plan can be validated', () => {
    const plan = (state) => ({ id: 22, employeeId: 88, state, kind: 'coaching', progress: 0 });

    test.each([['cancelled'], ['completed'], ['draft']])(
        'a %s plan is refused and not written',
        async (state) => {
            mockDb.get.mockResolvedValueOnce(plan(state));
            await expect(Coach.validateCompletion(SUPER, 22)).rejects.toThrow(
                `Cannot validate from '${state}'`
            );
            expect(mockDb.run).not.toHaveBeenCalled();
        }
    );

    test('an active plan is validated as before', async () => {
        mockDb.get.mockResolvedValueOnce(plan('active')).mockResolvedValue(plan('completed'));
        await Coach.validateCompletion(SUPER, 22);
        expect(runs()[0][0]).toMatch(/UPDATE coaching_plans SET state = \?, progress = 100/i);
    });
});

describe('F3 cancelPlan(): files a two-person cancellation request, never flips the state itself', () => {
    const plan = (over = {}) => ({
        id: 29,
        employeeId: 87,
        state: 'active',
        kind: 'coaching',
        progress: 0,
        contextType: null,
        ...over,
    });
    /** db.get keyed on the SQL: plan lookups, then "no pending request yet". */
    const wireGet = (p, pendingExisting = null) =>
        mockDb.get.mockImplementation(async (sql) => {
            const s = norm(sql);
            if (/FROM coaching_plans WHERE id/i.test(s)) return p;
            if (/FROM cancellation_requests WHERE entity_type/i.test(s)) return pendingExisting;
            return null;
        });

    test('an active plan: one cancellation_requests row with the reason, NO UPDATE on coaching_plans', async () => {
        wireGet(plan());
        const out = await Coach.cancelPlan(SUPER, 29, {
            body: { reason: '  moved site  ' },
            ip: '1.1.1.1',
            get: () => 'ua',
        });
        expect(runsMatching(/UPDATE coaching_plans/i)).toHaveLength(0);
        const [[sql, params]] = runsMatching(/INSERT INTO cancellation_requests/i);
        expect(sql).toMatch(/INSERT INTO cancellation_requests/i);
        expect(params[0]).toBe('coaching');
        expect(params[1]).toBe(29);
        expect(params[3]).toBe('moved site');
        expect(params[6]).toBe(SUPER.id); // requested_by_admin_id
        expect(out.state).toBe('active');
        expect(out.cancellationRequest).toEqual({ id: 55, state: 'pending' });
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'CANCELLATION_REQUESTED' })
        );
    });

    test('a mentoring plan files a mentoring request', async () => {
        wireGet(plan({ kind: 'mentoring' }));
        await Coach.cancelPlan(SUPER, 29, { reason: 'x' });
        expect(runsMatching(/INSERT INTO cancellation_requests/i)[0][1][0]).toBe('mentoring');
    });

    test('a MANAGER supervising the employee may file the request (as employee requester)', async () => {
        wireGet(plan());
        await Coach.cancelPlan(MANAGER, 29, { body: { reason: 'left the team' } });
        const params = runsMatching(/INSERT INTO cancellation_requests/i)[0][1];
        expect(params[5]).toBe(MANAGER.id); // requested_by_employee_id
        expect(params[6]).toBeNull();
    });

    test.each([['completed'], ['cancelled']])(
        'a %s plan cannot be cancelled (409 shape), nothing written',
        async (state) => {
            wireGet(plan({ state }));
            await expect(Coach.cancelPlan(SUPER, 29, { body: { reason: 'x' } })).rejects.toThrow(
                `Cannot cancel from '${state}'`
            );
            expect(mockDb.run).not.toHaveBeenCalled();
        }
    );

    test('a reason is mandatory', async () => {
        wireGet(plan());
        await expect(Coach.cancelPlan(SUPER, 29, { body: {} })).rejects.toThrow(
            /reason is required/i
        );
        await expect(Coach.cancelPlan(SUPER, 29, null)).rejects.toThrow(/reason is required/i);
        await expect(Coach.cancelPlan(SUPER, 29, { body: { reason: '   ' } })).rejects.toThrow(
            /reason is required/i
        );
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a second request while one is pending is refused', async () => {
        wireGet(plan(), { id: 77 });
        await expect(Coach.cancelPlan(SUPER, 29, { body: { reason: 'x' } })).rejects.toThrow(
            /already pending/i
        );
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('out of the requester scope → "Not authorized" (403 shape)', async () => {
        wireGet(plan());
        mockCanReview.mockResolvedValue(false);
        await expect(Coach.cancelPlan(MANAGER, 29, { body: { reason: 'x' } })).rejects.toThrow(
            /Not authorized/
        );
        expect(mockDb.run).not.toHaveBeenCalled();
    });
});
