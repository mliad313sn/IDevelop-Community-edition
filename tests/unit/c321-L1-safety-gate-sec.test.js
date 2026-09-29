'use strict';
/**
 * 3.23.21 lane L1 — SEC-1: the safety-gate CONFIGURATION is clearance-bound.
 *
 * Before: any admin holding `manage_compliance` — a local admin scoped to ONE
 * site — could point the outgoing webhook anywhere, add a site-less (global)
 * rule that blocks every site, deactivate another site's rule, and read the
 * delivery trail of the whole organisation.
 *
 * Now (fail closed, enforced in the SERVICE so no route can forget it):
 *   - settings (warning window + webhook)      → SuperAdmin only;
 *   - a site-less rule (add / deactivate / mode) → SuperAdmin only;
 *   - a site rule → only when RBACService.canAccessSite(actor, site);
 *   - recentDeliveries → the actor's scoped employees only.
 *
 * Behavioural: mocked database + RBAC; the real service and the real router.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockScoped = jest.fn();
jest.mock('../../src/utils/rbacScope', () => ({
    scopedEmployeeIds: (...a) => mockScoped(...a),
    scopeClause: () => '',
}));
const mockLog = jest.fn(async () => {});
jest.mock('../../src/services/LogService', () => ({ log: (...a) => mockLog(...a) }));
const mockCanAccessSite = jest.fn();
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => !!u && u.userType === 'admin' && u.role === 'superadmin',
    hasPermission: (u, slug) =>
        !!u &&
        u.userType === 'admin' &&
        (u.role === 'superadmin' || (u.permissions || []).includes(slug)),
    canAccessSite: (...a) => mockCanAccessSite(...a),
}));
jest.mock('../../src/services/NotificationService', () => ({ notify: jest.fn(async () => ({})) }));

const SG = require('../../src/services/SafetyGateService');

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const LOCAL = { id: 42, userType: 'admin', role: 'localadmin', permissions: ['manage_compliance'] };

beforeEach(() => {
    mockDb.get.mockReset().mockResolvedValue(null);
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({});
    mockScoped.mockReset().mockResolvedValue([]);
    mockLog.mockClear();
    mockCanAccessSite.mockReset().mockImplementation(async (_u, siteId) => Number(siteId) === 5);
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const writes = () =>
    [...mockDb.run.mock.calls, ...mockDb.get.mock.calls].filter(([sql]) =>
        /\b(INSERT|UPDATE)\b/i.test(sql)
    );

describe('settings (warning window + webhook) — SuperAdmin only', () => {
    test('a manage_compliance local admin is refused 403 and nothing is written', async () => {
        await expect(
            SG.updateSettings(
                { expiryWarningDays: 30, webhookUrl: '', webhookEnabled: false },
                LOCAL
            )
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
        expect(writes()).toHaveLength(0);
    });

    test('no actor at all is refused (fail closed)', async () => {
        await expect(
            SG.updateSettings({ expiryWarningDays: 30, webhookUrl: '' }, null)
        ).rejects.toMatchObject({ code: 'forbidden' });
    });

    test('the SuperAdmin still saves', async () => {
        await SG.updateSettings({ expiryWarningDays: 21, webhookUrl: '' }, SUPER);
        expect(
            mockDb.run.mock.calls.some(([sql]) => /INSERT INTO safety_gate_settings/.test(sql))
        ).toBe(true);
    });
});

describe('rules — global = SuperAdmin; a site rule needs clearance on that site', () => {
    test('a local admin cannot add a site-less (global) rule', async () => {
        await expect(
            SG.addRule({ roleId: 3, siteId: '', skillId: 9, minLevel: 2 }, LOCAL)
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
        expect(writes()).toHaveLength(0);
    });

    test('a local admin cannot add a rule on a site outside its clearance', async () => {
        await expect(
            SG.addRule({ roleId: 3, siteId: 6, skillId: 9, minLevel: 2 }, LOCAL)
        ).rejects.toMatchObject({ code: 'forbidden' });
        expect(mockCanAccessSite).toHaveBeenCalledWith(LOCAL, 6);
        expect(writes()).toHaveLength(0);
    });

    test('a local admin adds a rule on its own site; the SuperAdmin adds a global one', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /INSERT INTO safety_gate_rules/.test(sql) ? { id: 77 } : null
        );
        jest.spyOn(SG, 'recomputeForRole').mockResolvedValue([]);
        await expect(
            SG.addRule({ roleId: 3, siteId: 5, skillId: 9, minLevel: 2 }, LOCAL)
        ).resolves.toMatchObject({ id: 77 });
        await expect(
            SG.addRule({ roleId: 3, siteId: '', skillId: 9, minLevel: 2 }, SUPER)
        ).resolves.toMatchObject({ id: 77 });
    });

    test('deactivating a global rule / another site rule is refused before any UPDATE', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM safety_gate_rules WHERE id/.test(sql))
                return { id: 8, siteId: null, roleId: 3 };
            return null;
        });
        await expect(SG.deactivateRule(8, 'obsolete', LOCAL)).rejects.toMatchObject({
            code: 'forbidden',
        });
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM safety_gate_rules WHERE id/.test(sql)) return { id: 8, siteId: 6, roleId: 3 };
            return null;
        });
        await expect(SG.deactivateRule(8, 'obsolete', LOCAL)).rejects.toMatchObject({
            code: 'forbidden',
        });
        expect(writes()).toHaveLength(0);
    });

    test('deactivating a rule of its own site goes through', async () => {
        jest.spyOn(SG, 'recomputeForRole').mockResolvedValue([]);
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM safety_gate_rules WHERE id/.test(sql)) return { id: 8, siteId: 5, roleId: 3 };
            if (/UPDATE safety_gate_rules/.test(sql)) return { id: 8, roleId: 3 };
            return null;
        });
        await expect(SG.deactivateRule(8, 'obsolete', LOCAL)).resolves.toMatchObject({ id: 8 });
    });
});

describe('recentDeliveries — scoped to the actor', () => {
    test('a local admin only reads deliveries about employees in its scope', async () => {
        mockScoped.mockResolvedValue([11, 12]);
        await SG.recentDeliveries(15, LOCAL);
        const [sql, params] = mockDb.all.mock.calls[0];
        expect(sql).toMatch(/d\.employee_id IN \(\?,\?\)/);
        expect(params).toEqual([11, 12]);
    });

    test('an empty scope (or no actor) reads nothing at all', async () => {
        mockScoped.mockResolvedValue([]);
        await expect(SG.recentDeliveries(15, LOCAL)).resolves.toEqual([]);
        await expect(SG.recentDeliveries(15, null)).resolves.toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('the SuperAdmin reads the whole trail', async () => {
        mockScoped.mockResolvedValue(null);
        await SG.recentDeliveries(15, SUPER);
        expect(mockDb.all.mock.calls[0][0]).not.toMatch(/employee_id IN/);
    });
});

describe('the real page router carries the refusal to the user', () => {
    const http = require('http');
    const express = require('express');
    let server;
    let base;
    afterAll(() => server && new Promise((r) => server.close(r)));

    test('POST /config/settings by a local admin: flash error, no write', async () => {
        const { pageRouter } = require('../../src/routes/v2-safety-gate');
        const app = express();
        app.use(express.urlencoded({ extended: false }));
        const flashes = [];
        app.use((req, _res, next) => {
            req.user = LOCAL;
            req.isAuthenticated = () => true;
            req.flash = (type, msg) => flashes.push([type, msg]);
            req.t = (k) => k;
            next();
        });
        app.use('/safety-gate', pageRouter);
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
        const r = await fetch(`${base}/safety-gate/config/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'expiryWarningDays=30&webhookUrl=&webhookEnabled=1',
            redirect: 'manual',
        });
        expect(r.status).toBe(302);
        expect(flashes).toEqual([['error', 'safety:err_forbidden']]);
        expect(writes()).toHaveLength(0);
    });
});
