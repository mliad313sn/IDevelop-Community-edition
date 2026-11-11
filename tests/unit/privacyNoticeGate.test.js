'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://t:t@127.0.0.1:5432/privacy_gate_unit_test';

/**
 * The privacy-notice gate (src/middleware/privacyNotice.js, GDPR art. 13/14).
 * Behavioural, DB-free: PrivacyService is mocked.
 */

process.env.NODE_ENV = 'test';

const mockPrivacy = {
    currentVersion: jest.fn(),
    hasAcknowledged: jest.fn(),
    identityOf: jest.requireActual('../../src/services/PrivacyService').identityOf,
};
jest.mock('../../src/services/PrivacyService', () => mockPrivacy);

const { privacyNotice } = require('../../src/middleware/privacyNotice');

function run({ path = '/dashboard', method = 'GET', user, session = {}, headers = {} } = {}) {
    const req = {
        path,
        method,
        originalUrl: path,
        user,
        session,
        headers,
        get: (h) => headers[String(h).toLowerCase()],
        xhr: false,
        isAuthenticated: () => !!user,
    };
    const res = {
        statusCode: 200,
        redirected: null,
        body: null,
        status(c) {
            this.statusCode = c;
            return this;
        },
        json(b) {
            this.body = b;
            return this;
        },
        redirect(u) {
            this.redirected = u;
            return this;
        },
    };
    return new Promise((resolve) => {
        const next = () => resolve({ req, res, passed: true });
        Promise.resolve(privacyNotice(req, res, next)).then(() => {
            if (res.redirected || res.body) resolve({ req, res, passed: false });
        });
    });
}

const EMP = { id: 42, userType: 'employee' };
const ADMIN = { id: 42, userType: 'admin', role: 'admin' };

beforeEach(() => {
    mockPrivacy.currentVersion.mockReset();
    mockPrivacy.hasAcknowledged.mockReset();
});

describe('privacy notice gate', () => {
    test('inactive until a version is published (template never shown by itself)', async () => {
        mockPrivacy.currentVersion.mockResolvedValue(null);
        const r = await run({ user: EMP });
        expect(r.passed).toBe(true);
        expect(mockPrivacy.hasAcknowledged).not.toHaveBeenCalled();
    });

    test('holds a signed-in person who has not acknowledged the version in force', async () => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 3 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(false);
        const r = await run({ user: EMP, path: '/employee/dashboard' });
        expect(r.passed).toBe(false);
        expect(r.res.redirected).toBe('/privacy/notice');
        expect(r.req.session.privacyReturnTo).toBe('/employee/dashboard');
        expect(mockPrivacy.hasAcknowledged).toHaveBeenCalledWith({ type: 'employee', id: 42 }, 3);
    });

    test('administrators are held too', async () => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 1 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(false);
        const r = await run({ user: ADMIN });
        expect(r.res.redirected).toBe('/privacy/notice');
        expect(mockPrivacy.hasAcknowledged).toHaveBeenCalledWith({ type: 'admin', id: 42 }, 1);
    });

    test('a JSON caller gets a 403 it can read, never a redirect', async () => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 1 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(false);
        const r = await run({ user: EMP, path: '/api/self-assessment/mine' });
        expect(r.res.statusCode).toBe(403);
        expect(r.res.body).toMatchObject({
            privacyNoticeRequired: true,
            redirect: '/privacy/notice',
        });
    });

    test('the notice page chrome (bell, action centre) is not refused', async () => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 1 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(false);
        for (const path of ['/api/notifications/count', '/api/my-actions']) {
            const r = await run({ user: EMP, path });
            expect(r.res.statusCode).not.toBe(403);
            expect(r.res.redirected).toBeFalsy();
        }
    });

    test('lets an acknowledged person through and memoises per identity + version', async () => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 2 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(true);
        const session = {};
        const r = await run({ user: EMP, session });
        expect(r.passed).toBe(true);
        expect(session.privacyAck).toEqual({ t: 'employee', id: 42, v: 2 });
        mockPrivacy.hasAcknowledged.mockClear();
        expect((await run({ user: EMP, session })).passed).toBe(true);
        expect(mockPrivacy.hasAcknowledged).not.toHaveBeenCalled();
    });

    test('kiosk: the memo of one person never lets the next one through', async () => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 2 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(false);
        const session = { privacyAck: { t: 'employee', id: 7, v: 2 } };
        const r = await run({ user: EMP, session });
        expect(r.res.redirected).toBe('/privacy/notice');
    });

    test('a new version invalidates the memo', async () => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 3 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(false);
        const session = { privacyAck: { t: 'employee', id: 42, v: 2 } };
        expect((await run({ user: EMP, session })).res.redirected).toBe('/privacy/notice');
    });

    test('FAILS CLOSED when the version or the acknowledgement cannot be read', async () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockPrivacy.currentVersion.mockRejectedValue(
            Object.assign(new Error('boom'), { code: '57P01' })
        );
        expect((await run({ user: EMP })).res.redirected).toBe('/privacy/notice');
        mockPrivacy.currentVersion.mockResolvedValue({ version: 1 });
        mockPrivacy.hasAcknowledged.mockRejectedValue(new Error('down'));
        expect((await run({ user: EMP })).res.redirected).toBe('/privacy/notice');
        spy.mockRestore();
    });

    test.each([
        '/login',
        '/login/mfa',
        '/logout',
        '/auth/sso/oidc/callback',
        '/v2/uam/mfa/setup',
        '/change-password',
        '/privacy/notice',
        '/privacy/notice/acknowledge',
        '/lang/en',
        '/css/app.css',
        '/js/main.js',
        '/health',
        '/scim/v2/Users',
        '/api/v1/employees',
    ])('never holds %s', async (p) => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 1 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(false);
        expect((await run({ user: EMP, path: p })).passed).toBe(true);
    });

    test('API-key principals (BI tools, integrations) and anonymous requests pass', async () => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 1 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(false);
        expect(
            (
                await run({
                    user: { id: 5, userType: 'admin', _apiKey: true },
                    path: '/v2/safety-gate/status',
                })
            ).passed
        ).toBe(true);
        expect((await run({ user: null })).passed).toBe(true);
    });

    test('a protocol-relative return target is never stored', async () => {
        mockPrivacy.currentVersion.mockResolvedValue({ version: 1 });
        mockPrivacy.hasAcknowledged.mockResolvedValue(false);
        const r = await run({ user: EMP, path: '//evil.example/x' });
        expect(r.res.redirected).toBe('/privacy/notice');
        expect(r.req.session.privacyReturnTo).toBeUndefined();
    });
});

test('the gate is mounted in server.js after the MFA and auth-policy holds, before the routes', () => {
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '../../server.js'),
        'utf8'
    );
    const gate = src.indexOf("require('./src/middleware/privacyNotice').privacyNotice");
    expect(gate).toBeGreaterThan(src.indexOf('app.use(enforceUserAuthPolicy)'));
    expect(gate).toBeLessThan(src.indexOf("app.use('/', routes)"));
});
