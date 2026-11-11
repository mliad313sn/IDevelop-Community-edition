'use strict';
/**
 * SA-42: who may act on a performance improvement plan.
 *
 * PIP actions used to be open to the whole governed sub-tree, supervisors
 * included. The plan authority is now the direct manager (an employee manager
 * or the admin account named as manager), a SuperAdmin, or an administrator
 * whose clearance covers the person. Supervisors, managers higher up the line,
 * read-only delegates and the person themselves are refused. Fail closed.
 *
 * Also: a verdict only closes an active plan, and activation is journaled with
 * its actor.
 *
 * Org used below, employee 70:
 *   supervisor 60, manager (employee) 50, manager-of-manager 40
 *   SuperAdmin admin 1, clearance admin 2, out-of-clearance admin 3
 *   admin 4 = linked account of manager 50, viewer admin 5
 * Employee 71: manager_type 'admin', manager_id 9 (admin account 9).
 */
const express = require('express');
const request = require('supertest');

const EMP = {
    70: { id: 70, supervisorId: 60, managerId: 50, managerType: 'employee' },
    71: { id: 71, supervisorId: null, managerId: 9, managerType: 'admin' },
};
const LINKED = { 4: 50 };

let mockDb, mockRbac, mockLog, mockNotify;

function load() {
    jest.resetModules();
    mockDb = {
        get: jest.fn(async (sql, params) => {
            if (/SELECT employee_id(, state)? FROM pips WHERE id = \?/.test(sql))
                return { employeeId: 70, state: 'active' };
            if (/SELECT state FROM pips WHERE id = \?/.test(sql)) return mockDb._state;
            if (/UPDATE pips SET state='active'/.test(sql))
                return mockDb._activate ? { id: params[0], employeeId: 70 } : undefined;
            if (/UPDATE pips SET state=\?, outcome=\?/.test(sql)) return mockDb._close;
            if (/FROM admins WHERE username = 'admin'/.test(sql)) return { id: 1 };
            if (/SELECT id FROM pips WHERE employee_id = \? AND state IN/.test(sql))
                return undefined;
            if (/INSERT INTO pips/.test(sql)) return { id: 900 };
            return undefined;
        }),
        all: jest.fn(async () => []),
        run: jest.fn(async () => ({ changes: 1 })),
        runInSavepoint: jest.fn(async (fn) => fn()),
        runTransaction: jest.fn(async (fn) => fn()),
        _state: null,
        _activate: true,
        _close: undefined,
    };
    mockRbac = {
        isViewer: (u) => u && u.role === 'viewer',
        isSuperAdmin: (u) => u && u.userType === 'admin' && u.role === 'superadmin',
        canAccessEmployeeData: jest.fn(async (u) => u && u.userType === 'admin' && u.id === 2),
        getFilteredEmployees: jest.fn(async () => [{ id: 70 }, { id: 71 }]), // what the former sub-tree predicate read
        scopeFilter: jest.fn(async () => ({ clause: '', params: [] })),
    };
    mockLog = { log: jest.fn(async () => {}) };
    mockNotify = { notify: jest.fn(async () => {}) };
    jest.doMock('../../src/config/database', () => mockDb);
    jest.doMock('../../src/services/RBACService', () => mockRbac);
    jest.doMock('../../src/services/LogService', () => mockLog);
    jest.doMock('../../src/services/NotificationService', () => mockNotify);
    jest.doMock('../../src/services/MakerCheckerService', () => ({ register: () => {} }));
    jest.doMock('../../src/services/TalentTaskService', () => ({ listOpen: async () => [] }));
    jest.doMock('../../src/middleware/auth', () => ({ requireAuth: (q, s, n) => n() }));
    jest.doMock('../../src/models/EmployeeModel', () => ({
        findById: jest.fn(async (id) => EMP[id] || null),
    }));
    jest.doMock('../../src/services/GovernanceService', () => ({
        actingPersonId: async (u) =>
            !u ? null : u.userType === 'admin' ? (LINKED[u.id] ?? null) : Number(u.id),
        lineAuthorityEmployeeIds: async () => [70, 71],
    }));
}

function app(user) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
        req.user = user;
        req.t = (k, o) => (o && o.defaultValue) || k;
        next();
    });
    a.use('/v2/pip', require('../../src/routes/v2-pip'));
    return a;
}

const U = {
    supervisor: { id: 60, userType: 'employee' },
    manager: { id: 50, userType: 'manager' },
    nPlus2: { id: 40, userType: 'manager' },
    subject: { id: 70, userType: 'employee' },
    stranger: { id: 99, userType: 'manager' },
    superAdmin: { id: 1, userType: 'admin', role: 'superadmin' },
    clearanceAdmin: { id: 2, userType: 'admin', role: 'localadmin' },
    outOfClearanceAdmin: { id: 3, userType: 'admin', role: 'localadmin' },
    linkedManagerAccount: { id: 4, userType: 'admin', role: 'localadmin' },
    viewer: { id: 5, userType: 'admin', role: 'viewer' },
};

describe('PipService.actingAuthority role matrix', () => {
    beforeEach(load);
    test.each([
        ['manager', true],
        ['superAdmin', true],
        ['clearanceAdmin', true],
        ['linkedManagerAccount', true],
        ['supervisor', false],
        ['nPlus2', false],
        ['subject', false],
        ['stranger', false],
        ['outOfClearanceAdmin', false],
        ['viewer', false],
    ])('%s → canAct %p (employee 70)', async (who, may) => {
        const PipService = require('../../src/services/PipService');
        const a = await PipService.actingAuthority(U[who], 70);
        expect(a.canAct).toBe(may);
    });

    test('the admin account NAMED manager acts (manager_type admin); its employee homonym does not', async () => {
        const PipService = require('../../src/services/PipService');
        expect(
            (await PipService.actingAuthority({ id: 9, userType: 'admin', role: 'localadmin' }, 71))
                .canAct
        ).toBe(true);
        expect((await PipService.actingAuthority({ id: 9, userType: 'employee' }, 71)).canAct).toBe(
            false
        );
    });

    test('fails closed when a lookup throws', async () => {
        const PipService = require('../../src/services/PipService');
        require('../../src/models/EmployeeModel').findById.mockRejectedValueOnce(
            new Error('db down')
        );
        expect((await PipService.actingAuthority(U.manager, 70)).canAct).toBe(false);
    });
});

describe('the routes apply it (propose, activate, close, withdraw)', () => {
    beforeEach(load);
    const writes = [
        ['POST', '/v2/pip/propose', { employeeId: 70 }],
        ['POST', '/v2/pip/5/activate', {}],
        ['POST', '/v2/pip/5/close', { success: true }],
        ['POST', '/v2/pip/5/withdraw', { reason: 'not needed after all' }],
    ];
    for (const [m, url, body] of writes) {
        test.each(['supervisor', 'nPlus2', 'subject', 'viewer', 'outOfClearanceAdmin'])(
            `${m} ${url} — %s refused 403, nothing written`,
            async (who) => {
                const r = await request(app(U[who]))[m.toLowerCase()](url).send(body);
                expect(r.status).toBe(403);
                const wrote = mockDb.get.mock.calls
                    .concat(mockDb.run.mock.calls)
                    .filter(([sql]) => /INSERT INTO pips|UPDATE pips/.test(sql));
                expect(wrote).toHaveLength(0);
            }
        );
    }
    test('the direct manager may propose', async () => {
        const r = await request(app(U.manager)).post('/v2/pip/propose').send({ employeeId: 70 });
        expect(r.status).toBe(200);
    });
    test('a SuperAdmin may activate', async () => {
        const r = await request(app(U.superAdmin)).post('/v2/pip/5/activate').send({});
        expect(r.status).toBe(200);
    });
});

describe('activation is journaled with its actor', () => {
    beforeEach(load);
    test('PIP_ACTIVATED with actor_ref of the manager', async () => {
        const r = await request(app(U.manager)).post('/v2/pip/5/activate').send({});
        expect(r.status).toBe(200);
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'PIP_ACTIVATED',
                actorRef: 'employee:50',
                entityId: 5,
            })
        );
    });
    test('nothing journaled when nothing was activated', async () => {
        mockDb._activate = false;
        const r = await request(app(U.manager)).post('/v2/pip/5/activate').send({});
        expect(r.status).toBe(409);
        expect(mockLog.log).not.toHaveBeenCalled();
    });
});

describe('a verdict only on a plan that ran', () => {
    beforeEach(load);
    test('the close UPDATE only matches state active', async () => {
        const PipService = require('../../src/services/PipService');
        mockDb._close = { id: 5, employeeId: 70, prevState: 'active' };
        await PipService.close(5, true, null, U.manager);
        const upd = mockDb.get.mock.calls.find(([sql]) =>
            /UPDATE pips SET state=\?, outcome=\?/.test(sql)
        );
        expect(upd[0]).toMatch(/state = 'active'/);
        expect(upd[0]).not.toMatch(/'proposed'/);
    });
    test.each(['proposed', 'approved'])(
        'closing a %s plan → 409 PIP_NOT_ACTIVE (withdraw instead)',
        async (st) => {
            mockDb._close = undefined;
            mockDb._state = { state: st };
            const r = await request(app(U.manager)).post('/v2/pip/5/close').send({ success: true });
            expect(r.status).toBe(409);
            expect(r.body.code).toBe('PIP_NOT_ACTIVE');
        }
    );
    test('an already-closed plan stays the old 409', async () => {
        mockDb._close = undefined;
        mockDb._state = { state: 'closed_success' };
        const r = await request(app(U.manager)).post('/v2/pip/5/close').send({ success: true });
        expect(r.status).toBe(409);
        expect(r.body.code).toBeUndefined();
    });
});
