'use strict';
/**
 * ASVS 3.7.1 / 4.3.3 — sensitive actions need a recent sign-in or the current
 * password (src/middleware/recentAuth.js), and the gate is wired in front of
 * API key creation and SuperAdmin grants. Also pins V3 session facts the
 * assessment relies on: logout is POST-only.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const mockHash = require('bcrypt').hashSync('the-right-password', 4);
const mockLogs = [];
jest.mock('../../src/services/LogService', () => ({
    log: jest.fn(async (row) => {
        mockLogs.push(row);
    }),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findById: jest.fn(async (id) =>
        id === 1
            ? { id: 1, username: 'root', role: 'superadmin', passwordHash: mockHash }
            : id === 2
              ? { id: 2, username: 'sso-only', role: 'superadmin', passwordHash: null }
              : null
    ),
}));

const recentAuth = require('../../src/middleware/recentAuth');

const MIN = 60 * 1000;

function appWith({ user = { id: 1, userType: 'admin' }, loginAgoMin = 60, opts = {} } = {}) {
    const session = { meta: { loginAt: Date.now() - loginAgoMin * MIN } };
    const a = express();
    a.use(express.json());
    a.use(express.urlencoded({ extended: false }));
    const flashes = [];
    a.use((req, res, next) => {
        req.user = user;
        req.session = session;
        if (req.get('x-html')) req.flash = (type, msg) => flashes.push([type, msg]);
        next();
    });
    a.post('/sensitive', recentAuth.requireRecentAuth(opts), (req, res) =>
        res.json({ ok: true, body: req.body })
    );
    return { app: a, session, flashes };
}

beforeEach(() => {
    mockLogs.length = 0;
    recentAuth._reset();
});

describe('requireRecentAuth', () => {
    test('a sign-in within the window passes without a password', async () => {
        const { app } = appWith({ loginAgoMin: 5 });
        const r = await request(app).post('/sensitive').send({ label: 'x' });
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
    });

    test('an older sign-in without a password is refused and audited', async () => {
        const { app } = appWith({ loginAgoMin: 16 });
        const r = await request(app).post('/sensitive').send({ label: 'x' });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('reauth_required');
        expect(mockLogs.map((l) => l.action)).toEqual(['REAUTH_REQUIRED']);
    });

    test('a wrong current password is refused, audited, and never logged', async () => {
        const { app } = appWith();
        const r = await request(app)
            .post('/sensitive')
            .send({ label: 'x', currentPassword: 'guess-123456' });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('reauth_failed');
        expect(mockLogs.map((l) => l.action)).toEqual(['REAUTH_FAILED']);
        expect(JSON.stringify(mockLogs)).not.toContain('guess-123456');
    });

    test('the right password passes, refreshes the window, and is stripped from the body', async () => {
        const { app, session } = appWith();
        const r = await request(app)
            .post('/sensitive')
            .send({ label: 'x', currentPassword: 'the-right-password' });
        expect(r.status).toBe(200);
        expect(r.body.body).toEqual({ label: 'x' });
        expect(Date.now() - session.reauthAt).toBeLessThan(5000);
        expect(mockLogs.map((l) => l.action)).toEqual(['REAUTH_CONFIRMED']);
        expect(JSON.stringify(mockLogs)).not.toContain('the-right-password');
        // …and the next sensitive action in the window needs nothing.
        const again = await request(app).post('/sensitive').send({ label: 'y' });
        expect(again.status).toBe(200);
    });

    test('the password is also stripped when the sign-in is recent', async () => {
        const { app } = appWith({ loginAgoMin: 1 });
        const r = await request(app)
            .post('/sensitive')
            .send({ label: 'x', currentPassword: 'anything' });
        expect(r.body.body).toEqual({ label: 'x' });
    });

    test('five wrong passwords lock the gate, even for the right one', async () => {
        const { app } = appWith();
        for (let i = 0; i < 5; i++)
            await request(app)
                .post('/sensitive')
                .send({ currentPassword: `wrong-${i}` });
        const r = await request(app)
            .post('/sensitive')
            .send({ currentPassword: 'the-right-password' });
        expect(r.status).toBe(403);
        expect(mockLogs.map((l) => l.action)).toContain('REAUTH_LOCKED');
    });

    test('an SSO-only account is asked to sign in again', async () => {
        const { app } = appWith({ user: { id: 2, userType: 'admin' } });
        const r = await request(app).post('/sensitive').send({ currentPassword: 'x' });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('reauth_required');
    });

    test('`when` limits the gate to the sensitive case', async () => {
        const { app } = appWith({ opts: { when: async (req) => req.body.role === 'superadmin' } });
        expect((await request(app).post('/sensitive').send({ role: 'viewer' })).status).toBe(200);
        expect((await request(app).post('/sensitive').send({ role: 'superadmin' })).status).toBe(
            403
        );
    });

    test('an HTML form gets a flash message and a redirect', async () => {
        const { app, flashes } = appWith({ opts: { redirectTo: '/admins/create' } });
        const r = await request(app)
            .post('/sensitive')
            .set('x-html', '1')
            .set('Accept', 'text/html')
            .type('form')
            .send({ role: 'superadmin' });
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe('/admins/create');
        expect(flashes[0][0]).toBe('error');
    });

    test('the window is 15 minutes by default', () => {
        expect(recentAuth.WINDOW_MINUTES).toBe(15);
        const now = Date.now();
        expect(recentAuth.isRecent({ session: { meta: { loginAt: now - 14 * MIN } } }, now)).toBe(
            true
        );
        expect(recentAuth.isRecent({ session: { meta: { loginAt: now - 16 * MIN } } }, now)).toBe(
            false
        );
        expect(recentAuth.isRecent({ session: {} }, now)).toBe(false);
    });
});

describe('wiring', () => {
    const ROUTES = fs.readFileSync(path.join(__dirname, '../../src/routes/index.js'), 'utf8');
    const API = fs.readFileSync(path.join(__dirname, '../../src/api/v1/index.js'), 'utf8');

    test('API key creation (admin page and /api/v1) sits behind the gate', () => {
        expect(ROUTES).toMatch(
            /'\/admin\/api-keys',\s*requireSuperAdmin,\s*requireRecentAuth\(\{ action: 'API key creation' \}\)/
        );
        expect(API).toMatch(
            /'\/admin\/api-keys',\s*apiSuperadminSession,[\s\S]{0,300}requireRecentAuth\(\{ action: 'API key creation' \}\)/
        );
    });

    test('creating or promoting a SuperAdmin sits behind the gate', () => {
        expect(ROUTES).toMatch(
            /'\/admins',\s*requirePermission\('manage_admins'\),\s*_superadminGrantReauth,/
        );
        expect(ROUTES).toMatch(
            /'\/admins\/:id\(\\\\d\+\)',\s*requirePermission\('manage_admins'\),\s*_superadminGrantReauth,/
        );
        expect(ROUTES).toMatch(/req\.body\.role !== 'superadmin'/);
    });

    test('logout is POST-only', () => {
        expect(ROUTES).toMatch(/router\.post\('\/logout', requireAuth, AuthController\.logout\)/);
        expect(ROUTES).not.toMatch(/router\.(get|all)\('\/logout'/);
    });

    test('own password change, e-mail change and MFA deactivation already re-authenticate', () => {
        const auth = fs.readFileSync(
            path.join(__dirname, '../../src/controllers/AuthController.js'),
            'utf8'
        );
        expect(auth).toMatch(/ownPasswordCheck\(me, req\.body\.currentPassword\)/);
        const uam = fs.readFileSync(path.join(__dirname, '../../src/routes/v2-uam.js'), 'utf8');
        expect(uam).toMatch(/'\/mfa\/disable'[\s\S]{0,2000}verifyAtLogin/);
    });
});
