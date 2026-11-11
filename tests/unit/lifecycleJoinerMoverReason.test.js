'use strict';
/**
 * SA-43: joiner and mover events on /v2/lifecycle, over the real router with
 * mocked services. Recording one needs edit_employees (or SuperAdmin), a
 * reason and an audit line; a manager (or an admin without edit_employees)
 * may only REQUEST it, and an administrator decides.
 */
const path = require('path');
const express = require('express');
const DB_PATH = path.join(__dirname, '..', '..', 'src', 'config', 'database.js');
const pass = (req, res, next) => next();

function drive(mount, router, user, method, url, body = {}) {
    return new Promise((resolve) => {
        const app = express.Router();
        app.use(mount, router);
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            host: 'h',
        };
        const r = {
            method,
            url: mount + url,
            originalUrl: mount + url,
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
            set() {
                return this;
            },
            setHeader() {},
        };
        app.handle(r, res, (err) => resolve({ status: 'next', err: err && (err.message || err) }));
    });
}

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const HR = { id: 2, userType: 'admin', role: 'localadmin', permissions: ['edit_employees'] };
const PLAIN_ADMIN = {
    id: 3,
    userType: 'admin',
    role: 'localadmin',
    permissions: ['view_employees'],
};
const MANAGER = { id: 136, userType: 'manager' };
const VIEWER = { id: 4, userType: 'admin', role: 'viewer', permissions: [] };

const rbacMock = (inScopeIds) => ({
    isSuperAdmin: (u) => !!u && u.role === 'superadmin',
    isViewer: (u) => !!u && u.role === 'viewer',
    hasPermission: (u, slug) =>
        !!u &&
        u.userType === 'admin' &&
        (u.role === 'superadmin' || (u.permissions || []).includes(slug)),
    canAccessEmployee: async (u, id) => inScopeIds.includes(Number(id)),
    getFilteredEmployees: async () => inScopeIds.map((id) => ({ id })),
});

describe('joiner and mover on /v2/lifecycle', () => {
    let db, LC, Log;
    function load() {
        jest.resetModules();
        db = {
            get: jest.fn(async (sql) =>
                /INSERT INTO lifecycle_events/.test(sql) ? { id: 55 } : undefined
            ),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({})),
        };
        jest.doMock(DB_PATH, () => db);
        jest.doMock('../../src/middleware/auth', () => ({ requireAuth: pass }));
        LC = {
            actorRef: (u) => `${u.userType}:${u.id}`,
            record: jest.fn(async () => ({ id: 66, scheduled: false })),
            requestLeaver: jest.fn(async () => ({ id: 67 })),
            stateOf: () => 'done',
        };
        jest.doMock('../../src/services/LifecycleService', () => LC);
        Log = { log: jest.fn(async () => {}) };
        jest.doMock('../../src/services/LogService', () => Log);
        jest.doMock('../../src/services/RBACService', () => rbacMock([138]));
        return require('../../src/routes/v2-lifecycle');
    }
    const requests = () =>
        db.get.mock.calls.filter(([s]) => /INSERT INTO lifecycle_events/.test(s));
    beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
    afterEach(() => jest.restoreAllMocks());

    test.each(['joiner', 'mover'])('%s without a reason → 400, nothing recorded', async (kind) => {
        const router = load();
        const out = await drive('/v2/lifecycle', router, HR, 'POST', '/events', {
            employeeId: 138,
            kind,
        });
        expect(out.status).toBe(400);
        expect(out.json.code).toBe('lc_reason_required');
        expect(LC.record).not.toHaveBeenCalled();
        expect(requests()).toHaveLength(0);
    });

    test.each([
        ['SuperAdmin', SUPER, 'joiner'],
        ['admin holding edit_employees', HR, 'mover'],
    ])('%s RECORDS the %s, audited', async (_l, user, kind) => {
        const router = load();
        const out = await drive('/v2/lifecycle', router, user, 'POST', '/events', {
            employeeId: 138,
            kind,
            reason: 'Reorganisation',
        });
        expect(out.status).toBe(200);
        expect(LC.record).toHaveBeenCalledTimes(1);
        expect(requests()).toHaveLength(0);
        const a = Log.log.mock.calls.map((c) => c[0]);
        expect(a.map((x) => x.action)).toEqual([`LIFECYCLE_${kind.toUpperCase()}_RECORDED`]);
        expect(a[0].details).toMatch(/Reorganisation/);
    });

    test.each([
        ['manager', MANAGER, 'mover'],
        ['admin without edit_employees', PLAIN_ADMIN, 'joiner'],
    ])('%s may only REQUEST the %s (202, nothing executed, audited)', async (_l, user, kind) => {
        const router = load();
        const out = await drive('/v2/lifecycle', router, user, 'POST', '/events', {
            employeeId: 138,
            kind,
            reason: 'Changement de poste',
        });
        expect(out.status).toBe(202);
        expect(out.json).toMatchObject({ ok: true, requested: true, id: 55 });
        expect(LC.record).not.toHaveBeenCalled();
        const [sql, params] = requests()[0];
        expect(sql).toMatch(/requested_by/);
        expect(params[1]).toBe(kind);
        expect(params[4]).toBe(`${user.userType}:${user.id}`);
        expect(Log.log.mock.calls.map((c) => c[0].action)).toEqual([
            `LIFECYCLE_${kind.toUpperCase()}_REQUESTED`,
        ]);
    });

    test.each([
        ['viewer', VIEWER, 138, 403],
        ['admin out of scope', HR, 999, 403],
    ])('%s → refused, nothing written', async (_l, user, employeeId, status) => {
        const router = load();
        const out = await drive('/v2/lifecycle', router, user, 'POST', '/events', {
            employeeId,
            kind: 'mover',
            reason: 'x',
        });
        expect(out.status).toBe(status);
        expect(LC.record).not.toHaveBeenCalled();
        expect(requests()).toHaveLength(0);
    });
});
