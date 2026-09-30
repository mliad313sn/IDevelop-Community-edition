'use strict';
/**
 * HRIS admin routes — authorisation (SuperAdmin only on EVERY route, re-auth
 * for saving credentials) — and the SCIM POST placement branch. The route
 * handlers are taken from the REAL router stack and mounted on a small app
 * with a fake session; the service is mocked, so no database is needed.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const express = require('express');
const request = require('supertest');

const mockHris = {
    PROVIDERS: ['csv', 'personio', 'lucca'],
    saveConnector: jest.fn().mockResolvedValue({ changedCredentials: [] }),
    testConnection: jest.fn().mockResolvedValue({ ok: true, sample: 3 }),
    dryRun: jest.fn().mockResolvedValue({ runId: 7, status: 'planned', plan: {} }),
    apply: jest.fn().mockResolvedValue({ runId: 8, status: 'applied', errors: [] }),
    addMapping: jest.fn().mockResolvedValue({}),
    deleteMapping: jest.fn().mockResolvedValue(true),
    scimPlace: jest.fn(),
};
jest.mock('../../src/services/HrisSyncService', () => mockHris);
const mockLog = { log: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../src/services/LogService', () => mockLog);

let stack;
beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.isolateModules(() => {
        stack = require('../../src/routes/index').stack;
    });
});

const hrisLayers = () =>
    stack.filter((l) => l.route && /^\/admin\/integrations\/hris/.test(l.route.path));

/** A mini app: fake session + the real handlers of every HRIS route. */
function app(user, { loginAt = Date.now() } = {}) {
    const a = express();
    a.use(express.urlencoded({ extended: true }));
    a.use((req, res, next) => {
        req.user = user;
        req.isAuthenticated = () => Boolean(user);
        req.session = { meta: { loginAt } };
        req.flash = () => {};
        next();
    });
    for (const l of hrisLayers()) {
        for (const method of Object.keys(l.route.methods)) {
            a[method](l.route.path, ...l.route.stack.map((s) => s.handle));
        }
    }
    return a;
}

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const LOCAL = { id: 2, userType: 'admin', role: 'localadmin', permissions: ['*'] };
const EMP = { id: 3, userType: 'employee' };

describe('HRIS admin routes — authorisation', () => {
    test('the routes are mounted, and every one starts with requireSuperAdmin', () => {
        const layers = hrisLayers();
        const paths = layers.map(
            (l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`
        );
        expect(paths).toEqual(
            expect.arrayContaining([
                'GET /admin/integrations/hris',
                'GET /admin/integrations/hris/template.csv',
                'POST /admin/integrations/hris/connector',
                'POST /admin/integrations/hris/scim',
                'POST /admin/integrations/hris/test',
                'POST /admin/integrations/hris/dry-run',
                'POST /admin/integrations/hris/upload',
                'POST /admin/integrations/hris/runs/:id(\\d+)/apply',
                'POST /admin/integrations/hris/mappings',
                'POST /admin/integrations/hris/mappings/:id(\\d+)/delete',
            ])
        );
        // The router was loaded in an isolated registry: compare the guard by name.
        for (const l of layers) expect(l.route.stack[0].handle.name).toBe('requireSuperAdmin');
        const connector = layers.find((l) => l.route.path === '/admin/integrations/hris/connector');
        expect(connector.route.stack.map((s) => s.handle.name)).toContain('recentAuth');
    });

    test.each([
        ['get', '/admin/integrations/hris'],
        ['get', '/admin/integrations/hris/template.csv'],
        ['post', '/admin/integrations/hris/connector'],
        ['post', '/admin/integrations/hris/test'],
        ['post', '/admin/integrations/hris/dry-run'],
        ['post', '/admin/integrations/hris/upload'],
        ['post', '/admin/integrations/hris/runs/5/apply'],
        ['post', '/admin/integrations/hris/mappings'],
        ['post', '/admin/integrations/hris/mappings/5/delete'],
        ['post', '/admin/integrations/hris/scim'],
    ])('%s %s: a local admin (even with every grant) and an employee are refused', async (m, p) => {
        for (const who of [LOCAL, EMP]) {
            const r = await request(app(who))[m](p).set('Accept', 'application/json');
            expect(`${who.userType}/${who.role}:${r.status}`).toBe(
                `${who.userType}/${who.role}:403`
            );
        }
        const anon = await request(app(null))[m](p).set('Accept', 'application/json');
        expect(anon.status).toBe(401);
        expect(mockHris.saveConnector).not.toHaveBeenCalled();
        expect(mockHris.apply).not.toHaveBeenCalled();
        expect(mockHris.dryRun).not.toHaveBeenCalled();
    });

    test('a SuperAdmin reaches the actions', async () => {
        const r = await request(app(SUPER))
            .post('/admin/integrations/hris/dry-run')
            .type('form')
            .send({ provider: 'csv' });
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe('/admin/integrations/hris?provider=csv&run=7');
        expect(mockHris.dryRun).toHaveBeenCalledWith('csv', {
            trigger: 'manual',
            actorRef: 'admin:1',
        });
        const t = await request(app(SUPER)).get('/admin/integrations/hris/template.csv');
        expect(t.status).toBe(200);
        expect(t.text).toContain('external_id,employee_number,first_name,last_name');
    });

    test('saving CREDENTIALS needs a recent sign-in or the current password', async () => {
        require('../../src/middleware/recentAuth')._reset();
        const stale = Date.now() - 60 * 60 * 1000;
        const withCreds = { provider: 'personio', 'credentials[client_secret]': 'x' };
        const refused = await request(app(SUPER, { loginAt: stale }))
            .post('/admin/integrations/hris/connector')
            .set('Accept', 'application/json')
            .type('form')
            .send(withCreds);
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe('reauth_required');
        expect(mockHris.saveConnector).not.toHaveBeenCalled();

        // Settings without credentials: no re-authentication needed.
        const plain = await request(app(SUPER, { loginAt: stale }))
            .post('/admin/integrations/hris/connector')
            .type('form')
            .send({ provider: 'personio', leaverGuardPct: '10' });
        expect(plain.status).toBe(302);
        expect(mockHris.saveConnector).toHaveBeenCalledTimes(1);

        // A fresh sign-in passes, and the secret reaches the service.
        const ok = await request(app(SUPER))
            .post('/admin/integrations/hris/connector')
            .type('form')
            .send(withCreds);
        expect(ok.status).toBe(302);
        expect(mockHris.saveConnector.mock.calls[1][1].credentials).toEqual({ client_secret: 'x' });
    });
});

describe('SCIM POST — placement through the HRIS mapping rules', () => {
    const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
    const createFromSso = jest.fn();
    let scimApp;

    beforeAll(() => {
        jest.isolateModules(() => {
            jest.doMock('../../src/config/database', () => mockDb);
            jest.doMock('../../src/middleware/apiAuth', () => ({
                requireApiKey: (req, res, next) => {
                    req.user = req.headers['x-test-scoped'] ? { ...LOCAL } : { ...SUPER };
                    next();
                },
                apiKeyCanWrite: () => true,
            }));
            jest.doMock('../../src/services/OnboardingService', () => ({ createFromSso }));
            const router = require('../../src/routes/scim');
            scimApp = express();
            scimApp.use(express.json({ type: ['application/json', 'application/scim+json'] }));
            scimApp.use(router);
        });
    });
    beforeEach(() => {
        mockDb.get.mockReset();
        createFromSso.mockReset();
        mockHris.scimPlace.mockReset();
    });

    const body = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'awa.diallo@acme.test',
        externalId: 'entra-123',
        name: { givenName: 'Awa', familyName: 'Diallo' },
        title: 'Welder',
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
            employeeNumber: 'E-77',
            department: 'Mining',
            manager: { value: '2' },
        },
    };

    test('every value maps → the employee is created and returned active (201)', async () => {
        mockDb.get
            .mockResolvedValueOnce(undefined) // no existing employee with this e-mail
            .mockResolvedValueOnce({
                id: 91,
                employeeNumber: 'E-77',
                firstName: 'Awa',
                lastName: 'Diallo',
                email: 'awa.diallo@acme.test',
                isActive: true,
            });
        mockHris.scimPlace.mockResolvedValue({ placed: true, employeeId: 91 });
        const r = await request(scimApp).post('/scim/v2/Users').send(body);
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ id: '91', active: true, userName: 'awa.diallo@acme.test' });
        expect(mockHris.scimPlace).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Welder', externalId: 'entra-123' }),
            { actorRef: 'admin:1' }
        );
        expect(createFromSso).not.toHaveBeenCalled();
    });

    test('a value that does not map → the existing onboarding queue, unchanged', async () => {
        mockDb.get.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 12 });
        mockHris.scimPlace.mockResolvedValue({ placed: false, reasons: ['unmapped_department'] });
        createFromSso.mockResolvedValue({ created: true });
        const r = await request(scimApp).post('/scim/v2/Users').send(body);
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ id: 'pending-12', active: false });
        expect(createFromSso).toHaveBeenCalledTimes(1);
    });

    test('a scoped key never places anybody (org-wide placement) → queue', async () => {
        mockDb.get.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 13 });
        createFromSso.mockResolvedValue({ created: true });
        const r = await request(scimApp)
            .post('/scim/v2/Users')
            .set('x-test-scoped', '1')
            .send(body);
        expect(r.status).toBe(201);
        expect(mockHris.scimPlace).not.toHaveBeenCalled();
        expect(createFromSso).toHaveBeenCalledTimes(1);
    });
});
