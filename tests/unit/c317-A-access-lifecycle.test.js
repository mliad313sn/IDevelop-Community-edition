'use strict';

/**
 * 3.23.17 — lane A-access, finding 2 (HIGH) + finding 7.
 *
 *  - LifecycleService.record ran `handle(kind, { employeeId: id, ...payload })`:
 *    a payload carrying `employeeId` OVERRODE the id the route had scope-checked,
 *    so a scoped admin recorded a mover/leaver cascade on anyone.
 *  - A Viewer (read-only) could record joiner/mover events.
 *  - Reinstating a departed person switched the LINKED ADMIN account back on,
 *    whatever the reinstating actor could grant.
 *  - RBACService's region look-ups ignored `revoked_at`.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const Lifecycle = require('../../src/services/LifecycleService');

beforeEach(() => {
    for (const k of ['get', 'all', 'run', 'runTransaction']) mockDb[k].mockReset();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockResolvedValue({ id: 77 });
    delete process.env.REDIS_URL;
});
afterEach(() => jest.restoreAllMocks());

describe('A-2 — the scope-checked id is the subject of the cascade', () => {
    test('PROBE: a payload naming ANOTHER employee is refused (400) and nothing is recorded', async () => {
        const handle = jest.spyOn(Lifecycle, 'handle').mockResolvedValue(null);
        await expect(
            Lifecycle.record('mover', 5, { payload: { employeeId: 9, fromRoleId: 1 } })
        ).rejects.toMatchObject({ status: 400, code: 'payload_employee_mismatch' });
        expect(handle).not.toHaveBeenCalled();
        expect(mockDb.get).not.toHaveBeenCalled(); // no INSERT
    });

    test('a legitimate payload runs the cascade on the checked id', async () => {
        const handle = jest.spyOn(Lifecycle, 'handle').mockResolvedValue(null);
        await Lifecycle.record('mover', 5, { payload: { fromRoleId: 1, toRoleId: 2 } });
        expect(handle).toHaveBeenCalledWith('mover', { fromRoleId: 1, toRoleId: 2, employeeId: 5 });
    });

    test('a payload repeating the SAME id is accepted', async () => {
        const handle = jest.spyOn(Lifecycle, 'handle').mockResolvedValue(null);
        await Lifecycle.record('joiner', 5, { payload: { employeeId: '5' } });
        expect(handle.mock.calls[0][1].employeeId).toBe(5);
    });
});

describe('A-2 — POST /v2/lifecycle/events', () => {
    const router = require('../../src/routes/v2-lifecycle');
    const layer = router.stack.find(
        (l) => l.route && l.route.path === '/events' && l.route.methods.post
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const call = async (user, body) => {
        const out = {};
        const res = {
            status(c) {
                out.status = c;
                return this;
            },
            json(j) {
                out.json = j;
                return this;
            },
        };
        await handler({ user, body, t: null, ip: '1', get: () => 'jest' }, res, (e) => {
            out.err = e;
        });
        return out;
    };

    test('a Viewer may not record a joiner/mover event', async () => {
        const rec = jest.spyOn(Lifecycle, 'record');
        const out = await call(
            { id: 7, userType: 'admin', role: 'viewer', permissions: ['view_employees'] },
            { employeeId: 5, kind: 'mover', payload: {} }
        );
        expect(out.status).toBe(403);
        expect(out.json.code).toBe('read_only_account');
        expect(rec).not.toHaveBeenCalled();
    });

    test('a payload.employeeId different from employeeId is a 400, before any scope check or write', async () => {
        const rec = jest.spyOn(Lifecycle, 'record');
        const out = await call(
            { id: 1, userType: 'admin', role: 'superadmin' },
            { employeeId: 5, kind: 'mover', payload: { employeeId: 9 } }
        );
        expect(out.status).toBe(400);
        expect(out.json.code).toBe('payload_employee_mismatch');
        expect(rec).not.toHaveBeenCalled();
    });
});

describe('A-2 — reinstating a person does not hand back a linked ADMIN account', () => {
    const leaverEvent = {
        id: 8,
        employeeId: 84,
        kind: 'leaver',
        revertedAt: null,
        occurredAt: '2026-01-10T00:00:00.000Z',
        payload: { revokedAdminIds: [12], revokedApiKeyIds: [77] },
    };
    const stub = () =>
        mockDb.get.mockImplementation(async (sql) =>
            /FROM lifecycle_events WHERE id/.test(sql) ? leaverEvent : null
        );
    const adminReactivations = () =>
        mockDb.run.mock.calls.filter(([sql]) => /UPDATE admins SET is_active = true/.test(sql));

    test('PROBE: a scoped admin reverting a leaver reinstates the person, NOT the admin account', async () => {
        stub();
        const s = await Lifecycle.revert(8, {
            adminId: 5,
            actor: {
                id: 5,
                userType: 'admin',
                role: 'localadmin',
                permissions: ['edit_employees'],
            },
        });
        expect(adminReactivations()).toHaveLength(0);
        expect(mockDb.all.mock.calls.some(([sql]) => /UPDATE api_keys/.test(sql))).toBe(false);
        expect(s.adminAccessDeferred).toBe(true);
        expect(s.reactivated).toBe(true);
    });

    test('a SuperAdmin reverting the same leaver restores the admin account too', async () => {
        stub();
        mockDb.all.mockResolvedValue([{ id: 77 }]);
        const s = await Lifecycle.revert(8, {
            adminId: 1,
            actor: { id: 1, userType: 'admin', role: 'superadmin' },
        });
        expect(adminReactivations()).toHaveLength(1);
        expect(s.adminAccountsReactivated).toBe(1);
        expect(s.adminAccessDeferred).toBeUndefined();
    });

    test('EmployeeController.reactivate names the actor (so the rule above applies)', async () => {
        const reinstate = jest.spyOn(Lifecycle, 'reinstate').mockResolvedValue({ via: 'revert' });
        const EmployeeModel = require('../../src/models/EmployeeModel');
        jest.spyOn(EmployeeModel, 'findById').mockResolvedValue({ id: 84, employeeNumber: 'E84' });
        const LogService = require('../../src/services/LogService');
        jest.spyOn(LogService, 'log').mockResolvedValue(null);
        const actor = { id: 5, userType: 'admin', role: 'localadmin' };
        const Ctrl = require('../../src/controllers/EmployeeController');
        await Ctrl.reactivate(
            { params: { id: '84' }, user: actor, ip: '1', get: () => 'j' },
            {
                json() {},
                status() {
                    return this;
                },
            }
        );
        expect(reinstate.mock.calls[0][1].actor).toBe(actor);
    });
});

describe('A-7 — a REVOKED region scope confers nothing', () => {
    test('canAccessSite region look-up filters revoked_at', async () => {
        const RBACService = require('../../src/services/RBACService');
        const AdminModel = require('../../src/models/AdminModel');
        const SiteModel = require('../../src/models/SiteModel');
        jest.spyOn(AdminModel, 'findWithScopes').mockResolvedValue({
            id: 5,
            scopes: [{ scopeType: 'region', regionId: 2 }],
        });
        jest.spyOn(SiteModel, 'findById').mockResolvedValue({ id: 11, countryId: 9 });
        // A db that honours the predicate it is sent: the only region row is revoked.
        mockDb.get.mockImplementation(async (sql) =>
            /revoked_at IS NULL/.test(sql) ? null : { ok: 1 }
        );
        expect(
            await RBACService.canAccessSite({ id: 5, userType: 'admin', role: 'localadmin' }, 11)
        ).toBe(false);
    });

    test('canAccessEmployeeData region look-up filters revoked_at', async () => {
        const RBACService = require('../../src/services/RBACService');
        const AdminModel = require('../../src/models/AdminModel');
        jest.spyOn(AdminModel, 'findWithScopes').mockResolvedValue({
            id: 5,
            scopes: [{ scopeType: 'region', regionId: 2 }],
        });
        mockDb.get.mockImplementation(async (sql) =>
            /revoked_at IS NULL/.test(sql) ? null : { ok: 1 }
        );
        expect(
            await RBACService.canAccessEmployeeData(
                { id: 5, userType: 'admin', role: 'localadmin' },
                { id: 3, siteId: 11 }
            )
        ).toBe(false);
    });
});
