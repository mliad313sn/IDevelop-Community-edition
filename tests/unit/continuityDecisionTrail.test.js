'use strict';
/**
 * SA-43: /v2/continuity, role matrices over the real router with mocked
 * services.
 *   - flight risk (GET /retention, the incumbent's risk on the overview): the
 *     manager of the person, or view_retention_risk;
 *   - the incoming person of a handover must be in the caller's scope;
 *   - removing a successor needs a reason (state 'removed', audited); a band
 *     override, an archive and an incumbent change are audited.
 */
const path = require('path');
const express = require('express');
const DB_PATH = path.join(__dirname, '..', '..', 'src', 'config', 'database.js');
const pass = (req, res, next) => next();

function drive(router, user, method, url, body = {}) {
    return new Promise((resolve) => {
        const app = express.Router();
        app.use('/v2/continuity', router);
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            host: 'h',
        };
        const r = {
            method,
            url: '/v2/continuity' + url,
            originalUrl: '/v2/continuity' + url,
            headers,
            body,
            query: {},
            params: {},
            user,
            ip: '127.0.0.1',
            protocol: 'http',
            xhr: true,
            isAuthenticated: () => true,
            get: (h) => headers[String(h).toLowerCase()],
            flash: () => {},
            t: (k, o) => (o && o.defaultValue) || k,
        };
        const res = {
            _status: 200,
            status(s) {
                this._status = s;
                return this;
            },
            json(j) {
                resolve({ status: this._status, json: j });
            },
            render(v, locals) {
                resolve({ status: this._status, render: v, locals });
            },
            set() {
                return this;
            },
            setHeader() {},
        };
        app.handle(r, res, (err) => resolve({ status: 'next', err: err && (err.message || err) }));
    });
}

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const RISK_ADMIN = {
    id: 2,
    userType: 'admin',
    role: 'localadmin',
    permissions: ['view_retention_risk'],
};
const RISK_WRITER = {
    id: 3,
    userType: 'admin',
    role: 'localadmin',
    permissions: ['manage_retention_risk'],
};
const CONT_ADMIN = {
    id: 4,
    userType: 'admin',
    role: 'localadmin',
    permissions: ['view_continuity', 'manage_handover', 'manage_succession'],
};
const MANAGER = { id: 136, userType: 'manager' };

let db, Cont, Hand, Log, designated;
function load() {
    jest.resetModules();
    db = {
        get: jest.fn(async (sql) => {
            if (/FROM succession_plans WHERE id/.test(sql)) return { incumbentEmployeeId: 138 };
            if (/FROM successors WHERE id/.test(sql)) return { planId: 5 };
            if (/FROM handover_plans WHERE id/.test(sql)) return { outgoingEmployeeId: 138 };
            return undefined;
        }),
        all: jest.fn(async (sql) =>
            /FROM retention_risk/.test(sql) ? [{ employeeId: 138, flightRisk: 'high' }] : []
        ),
        run: jest.fn(async () => ({ changes: 1 })),
    };
    jest.doMock(DB_PATH, () => db);
    jest.doMock('../../src/middleware/auth', () => ({
        requireAuth: pass,
        requireManagerOrAnyPermission: () => pass,
    }));
    Cont = {
        listCoverage: jest.fn(async () => []),
        listPlans: jest.fn(async () => []),
        gettingStarted: jest.fn(async () => ({})),
        removeSuccessor: jest.fn(async () => ({ id: 9, planId: 5, candidateEmployeeId: 139 })),
        setSuccessorBand: jest.fn(async () => ({
            id: 9,
            planId: 5,
            candidateEmployeeId: 139,
            fromBand: 'ready_3y',
            toBand: 'ready_now',
        })),
        archivePlan: jest.fn(async () => ({ id: 5, fromStatus: 'active' })),
        setIncumbent: jest.fn(async () => ({ id: 5, fromIncumbent: 138, toIncumbent: 139 })),
    };
    jest.doMock('../../src/services/ContinuityService', () => Cont);
    jest.doMock('../../src/services/RetentionRiskService', () => ({}));
    Hand = {
        createManual: jest.fn(async () => ({ id: 77 })),
        setIncoming: jest.fn(async () => {}),
    };
    jest.doMock('../../src/services/HandoverService', () => Hand);
    Log = { log: jest.fn(async () => {}) };
    jest.doMock('../../src/services/LogService', () => Log);
    jest.doMock('../../src/services/GovernanceService', () => ({
        adminDesignatedEmployeeIds: jest.fn(async () => designated),
    }));
    jest.doMock('../../src/services/RBACService', () => ({
        isSuperAdmin: (u) => !!u && u.role === 'superadmin',
        hasPermission: (u, slug) =>
            !!u &&
            u.userType === 'admin' &&
            (u.role === 'superadmin' || (u.permissions || []).includes(slug)),
        getFilteredEmployees: jest.fn(async (u) =>
            u.role === 'superadmin'
                ? []
                : [
                      { id: 138, roleId: 7 },
                      { id: 139, roleId: 7 },
                  ]
        ),
        scopeFilter: jest.fn(async () => ({ clause: ' AND e.site_id IN (?)', params: [1] })),
    }));
    return require('../../src/routes/v2-continuity');
}
const retentionSql = () => db.all.mock.calls.filter(([s]) => /FROM retention_risk/.test(s));

beforeEach(() => {
    designated = [];
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('GET /retention — manager of the person OR view_retention_risk', () => {
    test.each([
        ['SuperAdmin', SUPER],
        ['admin with view_retention_risk', RISK_ADMIN],
        ['admin with manage_retention_risk', RISK_WRITER],
        ['manager (their governed line)', MANAGER],
    ])('%s reads the list (scope still applies)', async (_l, user) => {
        const router = load();
        const out = await drive(router, user, 'GET', '/retention');
        expect(out.status).toBe(200);
        expect(out.json.list).toHaveLength(1);
        expect(retentionSql()).toHaveLength(1);
        expect(retentionSql()[0][0]).not.toMatch(/e\.id IN \(/);
    });

    test('admin with view_continuity only (no designation) → empty list, risk table never read', async () => {
        const router = load();
        const out = await drive(router, CONT_ADMIN, 'GET', '/retention');
        expect(out.status).toBe(200);
        expect(out.json.list).toEqual([]);
        expect(retentionSql()).toHaveLength(0);
    });

    test('admin without the permission sees only the people it is directly named manager of', async () => {
        designated = [139];
        const router = load();
        await drive(router, CONT_ADMIN, 'GET', '/retention');
        expect(retentionSql()).toHaveLength(1);
        const [sql, params] = retentionSql()[0];
        expect(sql).toMatch(/AND e\.id IN \(\?\)/);
        expect(params).toEqual([1, 139]);
    });

    test('a plain employee account reads nothing', async () => {
        const router = load();
        const out = await drive(router, { id: 140, userType: 'employee' }, 'GET', '/retention');
        expect(out.json.list).toEqual([]);
        expect(retentionSql()).toHaveLength(0);
    });

    test.each([
        ['view_retention_risk admin → incumbent risk visible in its span', RISK_ADMIN, [138, 139]],
        ['manager → its governed line', MANAGER, [138, 139]],
        ['view_continuity-only admin → masked everywhere', CONT_ADMIN, []],
    ])('overview coverage: %s', async (_l, user, ids) => {
        const router = load();
        const out = await drive(router, user, 'GET', '/');
        expect(out.render).toBe('pages/continuity/index');
        expect(Cont.listCoverage.mock.calls[0][1].governedIds).toEqual(ids);
    });
});

describe('handover incoming person must be in scope', () => {
    test.each([
        [
            'POST /handover',
            'POST',
            '/handover',
            { outgoingEmployeeId: 138, incomingEmployeeId: 999 },
            'createManual',
        ],
        [
            'POST /handover/:id/incoming',
            'POST',
            '/handover/3/incoming',
            { incomingEmployeeId: 999 },
            'setIncoming',
        ],
    ])('%s with an out-of-scope incoming → 403, nothing written', async (_l, m, url, body, fn) => {
        const router = load();
        const out = await drive(router, MANAGER, m, url, body);
        expect(out.status).toBe(403);
        expect(Hand[fn]).not.toHaveBeenCalled();
    });

    test.each([
        ['manager, in scope', MANAGER, 139, 200],
        ['handover admin, in scope', CONT_ADMIN, 139, 200],
        ['SuperAdmin, anyone', SUPER, 999, 200],
        ['manager, garbage id', MANAGER, 'abc', 400],
    ])('POST /handover %s → %s', async (_l, user, incoming, status) => {
        const router = load();
        const out = await drive(router, user, 'POST', '/handover', {
            outgoingEmployeeId: 138,
            incomingEmployeeId: incoming,
        });
        expect(out.status).toBe(status);
        if (status === 200)
            expect(Hand.createManual.mock.calls[0][0].incomingEmployeeId).toBe(Number(incoming));
        else expect(Hand.createManual).not.toHaveBeenCalled();
    });

    test('clearing the incoming person stays allowed', async () => {
        const router = load();
        const out = await drive(router, MANAGER, 'POST', '/handover/3/incoming', {
            incomingEmployeeId: '',
        });
        expect(out.status).toBe(200);
        expect(Hand.setIncoming).toHaveBeenCalledWith(3, null);
    });
});

describe('successor removal / band / archive / incumbent are recorded', () => {
    test('remove without a reason → 400, nothing written', async () => {
        const router = load();
        const out = await drive(router, MANAGER, 'POST', '/successor/9/remove', { reason: '  ' });
        expect(out.status).toBe(400);
        expect(out.json.code).toBe('reason_required');
        expect(Cont.removeSuccessor).not.toHaveBeenCalled();
    });

    test('remove with a reason → state removed (who + why) and audited', async () => {
        const router = load();
        const out = await drive(router, MANAGER, 'POST', '/successor/9/remove', {
            reason: 'Left the company',
        });
        expect(out.status).toBe(200);
        expect(Cont.removeSuccessor).toHaveBeenCalledWith(9, {
            reason: 'Left the company',
            actorRef: 'employee:136',
        });
        expect(Log.log.mock.calls.map((c) => c[0].action)).toEqual(['successor_removed']);
        expect(Log.log.mock.calls[0][0].details).toMatch(/Left the company/);
    });

    test.each([
        [
            '/successor/9/band',
            { band: 'ready_now' },
            'successor_band_overridden',
            /ready_3y -> ready_now/,
        ],
        ['/plan/5/archive', {}, 'succession_plan_archived', /active -> archived/],
        [
            '/plan/5/incumbent',
            { incumbentEmployeeId: 139 },
            'succession_plan_incumbent_changed',
            /#138 -> #139/,
        ],
    ])('%s is audited', async (url, body, action, detail) => {
        const router = load();
        const out = await drive(router, SUPER, 'POST', url, body);
        expect(out.status).toBe(200);
        const calls = Log.log.mock.calls.map((c) => c[0]);
        expect(calls.map((c) => c.action)).toEqual([action]);
        expect(calls[0].details).toMatch(detail);
    });
});
