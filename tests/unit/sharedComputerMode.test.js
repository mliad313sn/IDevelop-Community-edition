'use strict';
/**
 * SHARED-COMPUTER (kiosk) mode, OFF by default, on the REAL stack: express + express-session (MemoryStore) + passport 0.6 + the app's
 * local strategy, serializers, AuthController.login/logout/verifyMfaChallenge and
 * middleware/sessionActivity. Nothing mocks req.logIn — only the database-facing
 * models and settings are faked.
 *
 *   - the login-form box survives passport's session regeneration inside logIn;
 *   - the SSO path (intent cookie from the login page, then a plain regenerate +
 *     logIn as the SSO callback does) and the MFA path (a second regeneration)
 *     arrive in shared-device mode too;
 *   - an address in kioskIpRanges is ALWAYS shared-device, box or not;
 *   - idle: kioskIdleMinutes applies, and only ever SHORTENS sessionIdleMinutes;
 *   - the tab-close beacon: per-session token (CSRF), same-origin only, and a
 *     page a navigation has already replaced never signs anyone out;
 *   - the keep-alive ping; the cookie is a browser-session cookie.
 */
const mockHash = require('bcrypt').hashSync('right-password', 10);
const mockSettings = {};
const mockMfa = { active: false };
const mockEmp = {
    id: 41,
    username: 'kiosk.user',
    firstName: 'K',
    lastName: 'User',
    employeeNumber: 'E41',
    isActive: true,
    isAccountActive: true,
    passwordHash: mockHash,
    authPolicy: 'any',
};

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/SuperadminAlertService', () => ({ alert: jest.fn(async () => 1) }));
jest.mock('../../src/config/sso', () => ({
    isConfigured: () => false,
    isSsoIntended: () => false,
    getProvider: () => null,
    getEnabledProviders: () => [],
}));
jest.mock('../../src/services/MfaService', () => ({
    isActive: jest.fn(async () => mockMfa.active),
    mfaUserType: (u) => (u && u.userType === 'admin' ? 'admin' : 'employee'),
    verifyAtLogin: jest.fn(async ({ code }) => code === '123456'),
    consumeBackupCode: jest.fn(async () => false),
}));
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) =>
        Object.prototype.hasOwnProperty.call(mockSettings, k) ? mockSettings[k] : d
    ),
}));
jest.mock('../../src/models/AdminModel', () => ({
    findByUsername: jest.fn(async () => null),
    findById: jest.fn(async () => null),
    findWithScopes: jest.fn(async () => null),
}));
jest.mock('../../src/models/EmployeeModel', () => ({
    findByUsername: jest.fn(async (u) => (u === 'kiosk.user' ? { ...mockEmp } : null)),
    findById: jest.fn(async (id) => (Number(id) === 41 ? { ...mockEmp } : null)),
    findByIdWithOrganization: jest.fn(async (id) => (Number(id) === 41 ? { ...mockEmp } : null)),
    governanceOf: jest.fn(async () => ({ governs: false, supervises: false, manages: false })),
    update: jest.fn(async () => ({})),
}));

const express = require('express');
const session = require('express-session');
const flash = require('../../src/middleware/flash');
const request = require('supertest');
const { passport } = require('../../src/middleware/auth');
const AuthController = require('../../src/controllers/AuthController');
const sessionActivity = require('../../src/middleware/sessionActivity');

const MIN = 60 * 1000;
let clock = Date.parse('2026-09-30T08:00:00Z');

function buildApp() {
    const app = express();
    app.set('trust proxy', true); // lets a test choose the client address (X-Forwarded-For)
    app.use(express.urlencoded({ extended: false }));
    app.use(
        session({
            secret: 'kiosk-test',
            resave: false,
            saveUninitialized: false,
            rolling: true,
            cookie: { maxAge: 12 * 60 * MIN },
        })
    );
    app.use(flash());
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(sessionActivity); // same place as server.js (after passport.session)
    app.get('/anon', (req, res) => {
        req.session.visited = true;
        res.json({ ok: true });
    });
    app.post('/login', AuthController.login);
    app.post('/login/mfa', AuthController.verifyMfaChallenge);
    app.post('/logout', AuthController.logout);
    // What the SSO callback does once the IdP answered: a regenerate + logIn and
    // NOTHING about the kiosk (the choice travels in the intent cookie).
    app.get('/sso-callback', (req, res) =>
        req.session.regenerate(() =>
            req.logIn({ ...mockEmp, userType: 'employee' }, () => res.redirect('/page'))
        )
    );
    app.get('/page', (req, res) =>
        res.json({
            auth: req.isAuthenticated(),
            shared: res.locals.sharedDevice || null,
        })
    );
    app.get('/flash', (req, res) => res.json({ error: req.flash('error') }));
    return app;
}

const nav = (agent, path) =>
    agent.get(path).set('Sec-Fetch-Mode', 'navigate').set('Sec-Fetch-Dest', 'document');

async function login(agent, extra = {}) {
    await agent.get('/anon');
    return agent
        .post('/login')
        .type('form')
        .send({ username: 'kiosk.user', password: 'right-password', ...extra });
}

const cookiesOf = (r) => (r.headers['set-cookie'] || []).join('\n');

beforeEach(() => {
    for (const k of Object.keys(mockSettings)) delete mockSettings[k];
    // The mode exists only behind the SuperAdmin switch (OFF by default);
    // these suites test it switched ON, the OFF default is tested at the end.
    mockSettings.kioskModeEnabled = 'true';
    mockMfa.active = false;
    clock = Date.parse('2026-09-30T08:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('« Shared computer » survives passport session regeneration', () => {
    test('the login-form box puts the FINAL session in shared-device mode', async () => {
        const agent = request.agent(buildApp());
        const r = await login(agent, { sharedDevice: '1' });
        expect(r.headers.location).toBe('/employee/dashboard');
        const p = (await nav(agent, '/page')).body;
        expect(p.auth).toBe(true);
        expect(p.shared).toMatchObject({ source: 'checkbox', idleMinutes: 5, draftOwner: '41' });
        expect(p.shared.beaconToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    });

    test('without the box: a normal session (no badge data, persistent cookie)', async () => {
        const agent = request.agent(buildApp());
        await login(agent);
        const r = await nav(agent, '/page');
        expect(r.body).toEqual({ auth: true, shared: null });
        expect(cookiesOf(r)).toMatch(/connect\.sid=[^\n]*Expires=/);
    });

    test('shared-device session cookie is a browser-session cookie (no Expires)', async () => {
        const agent = request.agent(buildApp());
        await login(agent, { sharedDevice: '1' });
        const r = await nav(agent, '/page');
        const sid = cookiesOf(r)
            .split('\n')
            .find((c) => c.startsWith('connect.sid='));
        expect(sid).toBeDefined();
        expect(sid).not.toMatch(/Expires=|Max-Age=/i);
    });

    test('SSO path: the intent cookie of the login page is honoured after the callback’s regenerate + logIn, then consumed', async () => {
        const agent = request.agent(buildApp());
        await agent.get('/anon');
        agent.jar.setCookie('app_kiosk=1; Path=/');
        await agent.get('/sso-callback');
        const r = await nav(agent, '/page');
        expect(r.body.shared).toMatchObject({ source: 'checkbox' });
        expect(cookiesOf(r)).toMatch(/app_kiosk=;/); // consumed
    });

    test('MFA path: the choice rides through the code step (a second regeneration)', async () => {
        mockMfa.active = true;
        const agent = request.agent(buildApp());
        const r1 = await login(agent, { sharedDevice: '1' });
        expect(r1.headers.location).toBe('/login/mfa');
        expect(cookiesOf(r1)).toMatch(/app_kiosk=1/);
        const r2 = await agent.post('/login/mfa').type('form').send({ code: '123456' });
        expect(r2.headers.location).toBe('/employee/dashboard');
        expect((await nav(agent, '/page')).body.shared).toMatchObject({ source: 'checkbox' });
    });

    test('an address in kioskIpRanges is ALWAYS shared-device, box or not', async () => {
        mockSettings.kioskIpRanges = '10.20.0.0/16, fd00::/8';
        const agent = request.agent(buildApp());
        await agent.get('/anon').set('X-Forwarded-For', '10.20.3.7');
        await agent
            .post('/login')
            .set('X-Forwarded-For', '10.20.3.7')
            .type('form')
            .send({ username: 'kiosk.user', password: 'right-password' });
        const p = await nav(agent, '/page').set('X-Forwarded-For', '10.20.3.7');
        expect(p.body.shared).toMatchObject({ source: 'ip' });
        // Another address, no box: normal.
        const other = request.agent(buildApp());
        await other.get('/anon').set('X-Forwarded-For', '10.21.0.1');
        await other
            .post('/login')
            .set('X-Forwarded-For', '10.21.0.1')
            .type('form')
            .send({ username: 'kiosk.user', password: 'right-password' });
        expect(
            (await nav(other, '/page').set('X-Forwarded-For', '10.21.0.1')).body.shared
        ).toBeNull();
    });
});

describe('idle window (kiosk only shortens it)', () => {
    test('shared-device: 6 min idle → signed out, with Clear-Site-Data; a normal session is not', async () => {
        const kiosk = request.agent(buildApp());
        await login(kiosk, { sharedDevice: '1' });
        await nav(kiosk, '/page');
        const normal = request.agent(buildApp());
        await login(normal);
        await nav(normal, '/page');
        clock += 6 * MIN;
        const k = await nav(kiosk, '/page');
        expect(k.status).toBe(302);
        expect(k.headers.location).toBe('/login?expired=1');
        expect(k.headers['clear-site-data']).toBe('"cache"');
        expect((await nav(normal, '/page')).body.auth).toBe(true);
    });

    test('kioskIdleMinutes larger than sessionIdleMinutes never lengthens the window', async () => {
        mockSettings.sessionIdleMinutes = 3;
        mockSettings.kioskIdleMinutes = 20;
        const agent = request.agent(buildApp());
        await login(agent, { sharedDevice: '1' });
        expect((await nav(agent, '/page')).body.shared.idleMinutes).toBe(3);
        clock += 4 * MIN;
        expect((await nav(agent, '/page')).headers.location).toBe('/login?expired=1');
    });

    test('kioskIdleMinutes is clamped to 1-30', async () => {
        mockSettings.kioskIdleMinutes = 999;
        expect(await sessionActivity.kioskIdleMinutes()).toBe(30);
        mockSettings.kioskIdleMinutes = 0;
        expect(await sessionActivity.kioskIdleMinutes()).toBe(5);
    });
});

describe('tab-close beacon', () => {
    async function kioskSession() {
        const agent = request.agent(buildApp());
        await login(agent, { sharedDevice: '1' });
        const shared = (await nav(agent, '/page')).body.shared;
        return { agent, shared };
    }
    const beacon = (agent, fields) =>
        agent
            .post('/logout-beacon')
            .set('Origin', 'http://127.0.0.1')
            .set('Host', '127.0.0.1')
            .type('form')
            .send(fields);

    test('closing the latest page ends the session', async () => {
        const { agent, shared } = await kioskSession();
        clock += 1000;
        const r = await beacon(agent, {
            token: shared.beaconToken,
            action: 'close',
            renderedAt: shared.renderAt,
        });
        expect(r.status).toBe(204);
        expect((await agent.get('/page')).body.auth).toBe(false);
    });

    test('the beacon of a page a navigation already replaced is ignored', async () => {
        const { agent, shared } = await kioskSession();
        clock += 1000;
        const next = (await nav(agent, '/page')).body.shared; // the next page, rendered first
        expect(next.renderAt).toBeGreaterThan(shared.renderAt);
        await beacon(agent, {
            token: shared.beaconToken,
            action: 'close',
            renderedAt: shared.renderAt,
        });
        expect((await agent.get('/page')).body.auth).toBe(true);
        // a JSON fetch from the page is not a render: closing that page still counts
        clock += 1000;
        await agent.get('/page').set('Sec-Fetch-Mode', 'cors').set('Sec-Fetch-Dest', 'empty');
        await beacon(agent, {
            token: next.beaconToken,
            action: 'close',
            renderedAt: next.renderAt,
        });
        expect((await agent.get('/page')).body.auth).toBe(false);
    });

    test('CSRF: a wrong / missing token or a foreign Origin is refused (403), session intact', async () => {
        const { agent, shared } = await kioskSession();
        const bad = await beacon(agent, { token: 'x'.repeat(32), renderedAt: shared.renderAt });
        expect(bad.status).toBe(403);
        expect((await beacon(agent, { renderedAt: shared.renderAt })).status).toBe(403);
        const foreign = await agent
            .post('/logout-beacon')
            .set('Origin', 'https://evil.example')
            .type('form')
            .send({ token: shared.beaconToken, renderedAt: shared.renderAt });
        expect(foreign.status).toBe(403);
        const site = await agent
            .post('/logout-beacon')
            .set('Sec-Fetch-Site', 'cross-site')
            .type('form')
            .send({ token: shared.beaconToken, renderedAt: shared.renderAt });
        expect(site.status).toBe(403);
        expect((await agent.get('/page')).body.auth).toBe(true);
    });

    test('a normal session ignores the endpoint', async () => {
        const agent = request.agent(buildApp());
        await login(agent);
        const r = await beacon(agent, { token: 'anything', renderedAt: String(clock + 1e9) });
        expect(r.status).toBe(204);
        expect((await agent.get('/page')).body.auth).toBe(true);
    });

    test('ping keeps an active (typing) person signed in; a lapsed session is not revived', async () => {
        const { agent, shared } = await kioskSession();
        clock += 4 * MIN;
        expect((await beacon(agent, { token: shared.beaconToken, action: 'ping' })).status).toBe(
            204
        );
        clock += 4 * MIN; // 8 min since the page, 4 since the ping
        expect((await agent.get('/page')).body.auth).toBe(true);
        clock += 6 * MIN;
        await beacon(agent, { token: shared.beaconToken, action: 'ping' });
        expect((await agent.get('/page')).body.auth).toBe(false);
    });
});

describe('logout of a shared device', () => {
    test('leaves the « Shared computer » intent for the next person; a normal logout does not', async () => {
        const kiosk = request.agent(buildApp());
        await login(kiosk, { sharedDevice: '1' });
        const r = await kiosk.post('/logout');
        expect(r.headers.location).toBe('/login?loggedout=1');
        expect(cookiesOf(r)).toMatch(/app_kiosk=1/);
        const normal = request.agent(buildApp());
        await login(normal);
        expect(cookiesOf(await normal.post('/logout'))).not.toMatch(/app_kiosk=1/);
    });

    test('every employee sign-out names the drafts to wipe (app_drafts_wipe, the numeric id)', async () => {
        const agent = request.agent(buildApp());
        await login(agent);
        const r = await agent.post('/logout');
        const c = cookiesOf(r)
            .split('\n')
            .find((x) => x.startsWith('app_drafts_wipe='));
        expect(c).toMatch(/^app_drafts_wipe=41;/);
        expect(c).toMatch(/Max-Age=600/);
        expect(c).not.toMatch(/HttpOnly/i); // draft-store.js reads it
    });
});

describe('kioskIpRanges parsing', () => {
    test('CIDR / single address / IPv4-mapped IPv6; invalid entries never match', () => {
        const R = '10.20.0.0/16 192.168.5.12, fd00::/8';
        expect(sessionActivity.ipInRanges('10.20.255.1', R)).toBe(true);
        expect(sessionActivity.ipInRanges('::ffff:10.20.1.1', R)).toBe(true);
        expect(sessionActivity.ipInRanges('192.168.5.12', R)).toBe(true);
        expect(sessionActivity.ipInRanges('192.168.5.13', R)).toBe(false);
        expect(sessionActivity.ipInRanges('fd12::1', R)).toBe(true);
        expect(sessionActivity.ipInRanges('10.21.0.1', R)).toBe(false);
        expect(sessionActivity.ipInRanges('10.0.0.1', '')).toBe(false);
        expect(sessionActivity.parseRangeToken('10.0.0.0/33')).toBeNull();
        expect(sessionActivity.parseRangeToken('not-an-ip')).toBeNull();
        expect(sessionActivity.parseRangeToken('10.0.0.0/8/1')).toBeNull();
    });
});

describe('master switch kioskModeEnabled (OFF by default)', () => {
    beforeEach(() => {
        delete mockSettings.kioskModeEnabled; // the shipped default: absent ⇒ OFF
    });

    test('OFF: the posted box is ignored — a normal session with a persistent cookie', async () => {
        const agent = request.agent(buildApp());
        await login(agent, { sharedDevice: '1' });
        const r = await nav(agent, '/page');
        expect(r.body).toEqual({ auth: true, shared: null });
        expect(cookiesOf(r)).toMatch(/connect\.sid=[^\n]*Expires=/);
    });

    test('OFF: the SSO intent cookie is ignored', async () => {
        const agent = request.agent(buildApp());
        await agent.get('/anon');
        agent.jar.setCookie('app_kiosk=1; Path=/');
        await agent.get('/sso-callback');
        expect((await nav(agent, '/page')).body.shared).toBeNull();
    });

    test('OFF: an address in kioskIpRanges is NOT forced into shared-device mode', async () => {
        mockSettings.kioskIpRanges = '10.20.0.0/16';
        const agent = request.agent(buildApp());
        await agent.get('/anon').set('X-Forwarded-For', '10.20.3.7');
        await agent
            .post('/login')
            .set('X-Forwarded-For', '10.20.3.7')
            .type('form')
            .send({ username: 'kiosk.user', password: 'right-password' });
        const p = await nav(agent, '/page').set('X-Forwarded-For', '10.20.3.7');
        expect(p.body.shared).toBeNull();
        expect(await sessionActivity.isKioskIp({ ip: '10.20.3.7' })).toBe(false);
    });

    test('the switch reads boolean-ish values', async () => {
        for (const v of ['true', '1', 'on', true]) {
            mockSettings.kioskModeEnabled = v;
            expect(await sessionActivity.kioskEnabled()).toBe(true);
        }
        for (const v of ['false', '0', '', 'off', false]) {
            mockSettings.kioskModeEnabled = v;
            expect(await sessionActivity.kioskEnabled()).toBe(false);
        }
    });
});
