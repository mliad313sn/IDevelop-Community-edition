'use strict';
/**
 * 3.23.18 lane I2 — the safety-gate READ API for permit-to-work systems.
 *
 * Driven over real HTTP against an express app carrying the real router and the
 * real API-key middleware (middleware/apiAuth); only the key store, the SSO
 * bearer check and the database are stubbed.
 *
 *   - no credential → 401;
 *   - a VALID key whose scope is another feed's read scope → 403 insufficient_scope;
 *   - a safety.read key → 200, status + reason codes, never a score;
 *   - an out-of-scope / unknown number → 404 (existence never confirmed);
 *   - an employee session → 403.
 */

jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(async () => []),
    run: jest.fn(),
}));
jest.mock('../../src/config/sso', () => ({
    looksLikeJwt: () => false,
    isEntraBearerEnabled: () => false,
    authenticateEntraBearer: async () => null,
}));
const mockValidate = jest.fn();
jest.mock('../../src/services/ApiKeyService', () => ({ validate: (...a) => mockValidate(...a) }));
const mockFindWithScopes = jest.fn();
jest.mock('../../src/models/AdminModel', () => ({
    findWithScopes: (...a) => mockFindWithScopes(...a),
}));
jest.mock('../../src/middleware/auth', () => {
    const pass = () => (req, res, next) => next();
    return { requireManagerOrAnyPermission: pass, requirePermission: pass };
});

const http = require('http');
const express = require('express');
const SG = require('../../src/services/SafetyGateService');
const { apiRouter } = require('../../src/routes/v2-safety-gate');

let server;
let base;
beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
        const u = req.headers['x-test-session'];
        req.user = u ? JSON.parse(u) : undefined;
        req.isAuthenticated = () => !!u;
        next();
    });
    app.use('/', apiRouter);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const ROW = {
    employeeId: 7,
    employeeNumber: 'E7',
    name: 'A',
    status: 'BLOCKED',
    evaluatedAt: '2026-09-26T00:00:00Z',
    nextExpiry: null,
    reasons: [
        {
            code: 'level_below_min',
            blocking: true,
            skillId: 1,
            skillName: 'Consignation',
            level: 1,
            requiredLevel: 3,
        },
    ],
};

beforeEach(() => {
    mockValidate.mockReset().mockResolvedValue(null);
    mockFindWithScopes
        .mockReset()
        .mockResolvedValue({ id: 42, role: 'site_admin', isActive: true });
    jest.spyOn(SG, 'statusByEmployeeNumber').mockResolvedValue(ROW);
    jest.spyOn(SG, 'statusBulk').mockResolvedValue([ROW]);
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const get = (path, headers = {}) =>
    fetch(base + path, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('no credential → 401', async () => {
    const r = await get('/v2/safety-gate/status/E7');
    expect(r.status).toBe(401);
    expect(SG.statusByEmployeeNumber).not.toHaveBeenCalled();
});

test('a valid key with a read scope of ANOTHER feed is refused 403 insufficient_scope', async () => {
    mockValidate.mockResolvedValue({
        id: 1,
        label: 'pbi',
        scope: 'powerbi.read',
        ownerAdminId: null,
    });
    const r = await get('/v2/safety-gate/status/E7', { 'X-API-Key': 'k-pbi' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('insufficient_scope');
    expect(SG.statusByEmployeeNumber).not.toHaveBeenCalled();

    const bulk = await get('/v2/safety-gate/status?site=Mine', { 'X-API-Key': 'k-pbi' });
    expect(bulk.status).toBe(403);
    expect(SG.statusBulk).not.toHaveBeenCalled();
});

test('a safety.read key owned by a profile reads AS that profile, and gets no score', async () => {
    mockValidate.mockResolvedValue({ id: 2, label: 'ptw', scope: 'safety.read', ownerAdminId: 42 });
    const r = await get('/v2/safety-gate/status/E7', { 'X-API-Key': 'k-ptw' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ employeeNumber: 'E7', status: 'BLOCKED', cleared: false });
    expect(r.body.data.reasons).toEqual([
        { code: 'level_below_min', blocking: true, skillId: 1, skillName: 'Consignation' },
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/"level"|"requiredLevel"/);
    const principal = SG.statusByEmployeeNumber.mock.calls[0][0];
    expect(principal.id).toBe(42); // clearance of the owning profile, not the whole org
});

test('bulk by site passes the filter through and returns the API shape', async () => {
    mockValidate.mockResolvedValue({
        id: 2,
        label: 'ptw',
        scope: 'safety.read',
        ownerAdminId: null,
    });
    const r = await get('/v2/safety-gate/status?site=Mine%20Nord&status=blocked', {
        Authorization: 'Bearer k-ptw',
    });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect(SG.statusBulk.mock.calls[0][1]).toMatchObject({ site: 'Mine Nord', status: 'blocked' });
});

test('unknown or out-of-scope employee → 404, never a hint of existence', async () => {
    mockValidate.mockResolvedValue({
        id: 2,
        label: 'ptw',
        scope: 'safety.read',
        ownerAdminId: null,
    });
    SG.statusByEmployeeNumber.mockResolvedValue(null);
    const r = await get('/v2/safety-gate/status/NOPE', { 'X-API-Key': 'k-ptw' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not_found' });
});

test('an employee session is refused; a manager session reads', async () => {
    const emp = await get('/v2/safety-gate/status/E7', {
        'x-test-session': JSON.stringify({ id: 9, userType: 'employee' }),
    });
    expect(emp.status).toBe(403);
    const mgr = await get('/v2/safety-gate/status/E7', {
        'x-test-session': JSON.stringify({ id: 5, userType: 'manager' }),
    });
    expect(mgr.status).toBe(200);
});
