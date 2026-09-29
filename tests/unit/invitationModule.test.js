'use strict';
/**
 * Invitation module v2 (migration 59) — the three guarantees that matter:
 *   1. EXPIRY: an invitation credential that was never used is refused after
 *      invitationExpiryDays; a used account or fresh invite still signs in.
 *   2. CREDENTIALS SHEET: the temp password is returned ONLY when the email
 *      did not go out (never alongside a delivered email).
 *   3. SEND GUARDS: scope filtering, already-active protection, batch cap.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = { getValue: jest.fn(), setValue: jest.fn(), findByKey: jest.fn() };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const mockEmployeeModel = {
    findById: jest.fn(),
    findByUsername: jest.fn(),
    update: jest.fn(),
    findByEmail: jest.fn(),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmployeeModel);

const mockEmail = { send: jest.fn() };
jest.mock('../../src/services/EmailService', () => mockEmail);
// 3.23.20 (C3): these accounts are NOT migrated to SSO (the migrated path has its own tests, c320-sso-invite-guards).
jest.mock('../../src/services/SsoInviteService', () => ({
    isMigrated: jest.fn(async () => false),
    requeue: jest.fn(),
    statusFor: jest.fn(async () => new Map()),
}));

jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/utils/branding', () => ({ getBranding: jest.fn().mockResolvedValue(null) }));

const mockScope = { scopedEmployeeIds: jest.fn(), scopeClause: jest.fn(() => '') };
jest.mock('../../src/utils/rbacScope', () => mockScope);

jest.mock('bcrypt', () => ({ hash: jest.fn(), compare: jest.fn() }));
const bcrypt = require('bcrypt');

beforeEach(() => {
    jest.clearAllMocks();
    bcrypt.hash.mockResolvedValue('$2b$fakehash');
    bcrypt.compare.mockResolvedValue(true);
});

describe('invitation expiry at login (EmployeeAuthService)', () => {
    const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const req = { ip: '127.0.0.1', get: () => 'jest' };

    function wireEmployee(overrides) {
        mockEmployeeModel.findByUsername.mockResolvedValue({
            id: 7,
            isAccountActive: true,
            passwordHash: '$2b$x',
            firstName: 'A',
            lastName: 'B',
            forcePasswordChange: true,
            invitedAt: daysAgo(20),
            lastLoginAt: null,
            ...overrides,
        });
        bcrypt.compare.mockResolvedValue(true);
        mockSettings.getValue.mockImplementation(async (key, fb) =>
            key === 'invitationExpiryDays' ? '14' : fb
        );
    }

    test('never-used invitation older than the expiry is refused', async () => {
        wireEmployee({ invitedAt: daysAgo(20) });
        const r = await EmployeeAuthService.login('a.b', 'Temp#123', req);
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/expired|expiré/i);
    });

    test('fresh invitation still signs in', async () => {
        wireEmployee({ invitedAt: daysAgo(3) });
        mockEmployeeModel.update.mockResolvedValue({});
        const r = await EmployeeAuthService.login('a.b', 'Temp#123', req);
        expect(r.success).toBe(true);
    });

    test('an account that HAS logged in before is never expiry-blocked', async () => {
        wireEmployee({ invitedAt: daysAgo(100), lastLoginAt: daysAgo(50) });
        mockEmployeeModel.update.mockResolvedValue({});
        const r = await EmployeeAuthService.login('a.b', 'Temp#123', req);
        expect(r.success).toBe(true);
    });

    test('expiryDays = 0 disables expiry entirely', async () => {
        wireEmployee({ invitedAt: daysAgo(400) });
        mockSettings.getValue.mockImplementation(async (key, fb) =>
            key === 'invitationExpiryDays' ? '0' : fb
        );
        mockEmployeeModel.update.mockResolvedValue({});
        const r = await EmployeeAuthService.login('a.b', 'Temp#123', req);
        expect(r.success).toBe(true);
    });
});

describe('credentials-sheet contract (OnboardingCredentialService)', () => {
    const OCS = require('../../src/services/OnboardingCredentialService');

    function wireIssue() {
        mockEmployeeModel.findById.mockResolvedValue({
            id: 5,
            email: 'a@b.co',
            username: 'a.b',
            firstName: 'A',
            lastName: 'B',
            employeeNumber: 'E5',
        });
        mockEmployeeModel.update.mockResolvedValue({});
        mockDb.get.mockResolvedValue(null); // welcome-email lookups: none needed for short mail
    }

    test('email delivered → NO tempPassword in the result', async () => {
        wireIssue();
        mockEmail.send.mockResolvedValue({ sent: true });
        const r = await OCS.issueAndSend(5, { userType: 'admin', id: 1 }, null);
        expect(r.emailed).toBe(true);
        expect(r.tempPassword).toBeUndefined();
    });

    test('email NOT delivered → tempPassword returned once for the sheet', async () => {
        wireIssue();
        mockEmail.send.mockResolvedValue({ sent: false, skipped: 'disabled' });
        const r = await OCS.issueAndSend(5, { userType: 'admin', id: 1 }, null);
        expect(r.emailed).toBe(false);
        expect(typeof r.tempPassword).toBe('string');
        expect(r.tempPassword.length).toBeGreaterThanOrEqual(12);
    });

    test('invitation stamps invited_at / invited_by', async () => {
        wireIssue();
        mockEmail.send.mockResolvedValue({ sent: true });
        await OCS.issueAndSend(5, { userType: 'admin', id: 42 }, null);
        const updateArg = mockEmployeeModel.update.mock.calls[0][1];
        expect(updateArg.invitedBy).toBe(42);
        expect(updateArg.invitedAt).toBeTruthy();
        expect(updateArg.forcePasswordChange).toBe(true);
    });
});

describe('send guards (InvitationController)', () => {
    const InvitationController = require('../../src/controllers/InvitationController');
    const res = () => {
        const r = { statusCode: 200 };
        r.status = (c) => {
            r.statusCode = c;
            return r;
        };
        r.json = (b) => {
            r.body = b;
            return r;
        };
        return r;
    };
    const req = (body) => ({
        body,
        user: { id: 1, userType: 'admin', role: 'localadmin' },
        ip: '::1',
        get: () => 'jest',
    });

    test('rejects empty and oversized batches', async () => {
        let r = res();
        await InvitationController.send(req({ employeeIds: [] }), r);
        expect(r.statusCode).toBe(400);
        r = res();
        await InvitationController.send(
            req({ employeeIds: Array.from({ length: 501 }, (_, i) => i + 1) }),
            r
        );
        expect(r.statusCode).toBe(400);
    });

    test('out-of-scope ids are filtered, counted, and never processed', async () => {
        mockScope.scopedEmployeeIds.mockResolvedValue([10, 11]); // delegate's scope
        const OCS = require('../../src/services/OnboardingCredentialService');
        const spy = jest
            .spyOn(OCS, 'issueAndSend')
            .mockResolvedValue({ success: true, username: 'x', emailed: true });
        mockDb.get.mockResolvedValue({ active: false });
        const r = res();
        await InvitationController.send(req({ employeeIds: [10, 11, 99] }), r);
        expect(r.body.results.outOfScope).toBe(1);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls.map((c) => c[0])).toEqual([10, 11]);
        spy.mockRestore();
    });

    test('already-signed-in accounts are skipped unless includeActive', async () => {
        mockScope.scopedEmployeeIds.mockResolvedValue(null); // superadmin
        const OCS = require('../../src/services/OnboardingCredentialService');
        const spy = jest
            .spyOn(OCS, 'issueAndSend')
            .mockResolvedValue({ success: true, username: 'x', emailed: true });
        mockDb.get.mockImplementation(async (sql) =>
            /last_login_at IS NOT NULL/.test(sql) ? { active: true } : null
        );
        const r = res();
        await InvitationController.send(req({ employeeIds: [1, 2] }), r);
        expect(r.body.results.skippedActive).toBe(2);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
