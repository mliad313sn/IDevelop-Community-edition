'use strict';

/**
 * Two-factor policy (ASVS 4.3.1): fail closed, upgrade grace period.
 *   - mfaEnforcement: an unreadable MFA state or setting holds an admin on the
 *     setup page (it used to wave the admin through); grace countdown for
 *     admins (14 d) and password-signed-in managers (30 d), then hold; SSO
 *     manager sessions and employees are outside; a new install has no grace;
 *   - authPolicy ('mfa_required'): an unreadable MFA state holds (was: pass).
 */
const mockSettings = {};
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) => (k in mockSettings ? mockSettings[k] : d)),
}));
const mockMfa = {
    isActive: jest.fn(async () => false),
    mfaUserType: (u) => (u.userType === 'admin' || !u.userType ? 'admin' : 'employee'),
    hasFreshEnrolment: () => false,
    rememberEnrolment: () => {},
};
jest.mock('../../src/services/MfaService', () => mockMfa);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/AdminSsoService', () => ({
    isEnforced: () => false,
    passwordAllowedWhileEnforced: () => true,
}));
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(async () => []),
    run: jest.fn(),
}));

const { enforceMfaEnrollment } = require('../../src/middleware/mfaEnforcement');
const { enforceUserAuthPolicy } = require('../../src/middleware/authPolicy');

function fakeReq(user, extra = {}) {
    const flashes = [];
    return {
        req: {
            user,
            path: '/dashboard',
            ip: '192.0.2.9',
            isAuthenticated: () => true,
            session: { passport: { user: { id: user.id, userType: user.userType } } },
            flash: (t, m) => flashes.push([t, m]),
            get: () => '',
            ...extra,
        },
        flashes,
    };
}
function drive(mw, req) {
    return new Promise((resolve) => {
        const res = {
            locals: {},
            redirect: (to) => resolve({ to }),
            status: () => ({ json: () => resolve({ json: true }) }),
        };
        Promise.resolve(mw(req, res, () => resolve({ next: true, res }))).catch((e) =>
            resolve({ threw: e })
        );
    });
}
const DAY = 86400000;

beforeEach(() => {
    for (const k of Object.keys(mockSettings)) delete mockSettings[k];
    mockMfa.isActive.mockReset().mockResolvedValue(false);
});

describe('mfaEnforcement: fail closed', () => {
    test('an admin whose MFA state cannot be read is held on setup (was: waved through)', async () => {
        mockSettings.mfaRequiredForPrivileged = true;
        mockMfa.isActive.mockRejectedValue(new Error('db down'));
        const { req } = fakeReq({ id: 5, userType: 'admin', role: 'localadmin' });
        expect(await drive(enforceMfaEnrollment, req)).toEqual({ to: '/v2/uam/mfa/setup' });
    });

    test('settings unreadable: held too', async () => {
        const AppSettings = require('../../src/models/AppSettingsModel');
        AppSettings.getValue.mockRejectedValueOnce(new Error('db down'));
        const { req } = fakeReq({ id: 5, userType: 'admin', role: 'viewer' });
        expect(await drive(enforceMfaEnrollment, req)).toEqual({ to: '/v2/uam/mfa/setup' });
    });

    test('the MFA pages, sign-out and the password change stay reachable', async () => {
        mockSettings.mfaRequiredForPrivileged = true;
        for (const p of ['/v2/uam/mfa/setup', '/logout', '/change-password']) {
            const { req } = fakeReq({ id: 5, userType: 'admin', role: 'localadmin' }, { path: p });
            expect((await drive(enforceMfaEnrollment, req)).next).toBe(true);
        }
    });
});

describe('grace countdown, then enrolment forced', () => {
    test('admin inside the 14-day grace: passes, warned once per session, audited', async () => {
        mockSettings.mfaRequiredForPrivileged = 'true';
        mockSettings.mfaGraceStartedAt = new Date(Date.now() - 3 * DAY).toISOString();
        const { req, flashes } = fakeReq({ id: 5, userType: 'admin', role: 'localadmin' });
        const r1 = await drive(enforceMfaEnrollment, req);
        expect(r1.next).toBe(true);
        expect(r1.res.locals.mfaGrace.daysLeft).toBe(11);
        await drive(enforceMfaEnrollment, req);
        expect(flashes.filter(([t]) => t === 'warning')).toHaveLength(1);
        expect(require('../../src/services/LogService').log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'MFA_GRACE_PROMPT' })
        );
    });

    test('admin after the grace: held on setup', async () => {
        mockSettings.mfaRequiredForPrivileged = 'true';
        mockSettings.mfaGraceStartedAt = new Date(Date.now() - 15 * DAY).toISOString();
        const { req } = fakeReq({ id: 5, userType: 'admin', role: 'localadmin' });
        expect(await drive(enforceMfaEnrollment, req)).toEqual({ to: '/v2/uam/mfa/setup' });
    });

    test('new install (no grace start): held at once', async () => {
        mockSettings.mfaRequiredForPrivileged = 'true';
        mockSettings.mfaGraceStartedAt = '';
        const { req } = fakeReq({ id: 5, userType: 'admin', role: 'viewer' });
        expect(await drive(enforceMfaEnrollment, req)).toEqual({ to: '/v2/uam/mfa/setup' });
    });

    test('policy switched off by a SuperAdmin: a local admin passes', async () => {
        mockSettings.mfaRequiredForPrivileged = 'false';
        const { req } = fakeReq({ id: 5, userType: 'admin', role: 'localadmin' });
        expect((await drive(enforceMfaEnrollment, req)).next).toBe(true);
    });

    test('manager signed in by PASSWORD: 30-day grace (day 20 passes, day 31 held)', async () => {
        mockSettings.mfaRequiredForManagers = 'true';
        mockSettings.mfaGraceStartedAt = new Date(Date.now() - 20 * DAY).toISOString();
        const a = fakeReq({ id: 7, userType: 'manager' });
        expect((await drive(enforceMfaEnrollment, a.req)).next).toBe(true);
        mockSettings.mfaGraceStartedAt = new Date(Date.now() - 31 * DAY).toISOString();
        const b = fakeReq({ id: 7, userType: 'manager' });
        expect(await drive(enforceMfaEnrollment, b.req)).toEqual({ to: '/v2/uam/mfa/setup' });
    });

    test('manager session opened through SSO: IdP MFA, not held', async () => {
        mockSettings.mfaRequiredForManagers = 'true';
        const { req } = fakeReq({ id: 7, userType: 'manager' });
        req.session.passport.user.via = 'sso';
        expect((await drive(enforceMfaEnrollment, req)).next).toBe(true);
    });

    test('enrolled manager / plain employee: not held', async () => {
        mockSettings.mfaRequiredForManagers = 'true';
        mockMfa.isActive.mockResolvedValue(true);
        expect(
            (await drive(enforceMfaEnrollment, fakeReq({ id: 7, userType: 'manager' }).req)).next
        ).toBe(true);
        mockMfa.isActive.mockResolvedValue(false);
        expect(
            (await drive(enforceMfaEnrollment, fakeReq({ id: 8, userType: 'employee' }).req)).next
        ).toBe(true);
    });
});

describe('authPolicy mfa_required: fail closed', () => {
    test('MFA state unreadable: held on setup (was: waved through)', async () => {
        mockMfa.isActive.mockRejectedValue(new Error('db down'));
        const { req } = fakeReq({ id: 9, userType: 'employee', authPolicy: 'mfa_required' });
        expect(await drive(enforceUserAuthPolicy, req)).toEqual({ to: '/v2/uam/mfa/setup' });
    });

    test('an account without the policy is untouched', async () => {
        mockMfa.isActive.mockRejectedValue(new Error('db down'));
        const { req } = fakeReq({ id: 9, userType: 'employee' });
        expect((await drive(enforceUserAuthPolicy, req)).next).toBe(true);
    });
});
