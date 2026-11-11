'use strict';
/**
 * Security-class App Settings are read-only for a non-SuperAdmin, refused
 * SERVER-SIDE in AppSettingsController.update (not only hidden in the view):
 * authentication, session, MFA, SSO, onboarding, retention, AI/copilot, API,
 * backup, the public base URL, the outgoing mail server and HRIS.
 */
const mockSettings = [
    {
        id: 1,
        settingKey: 'sessionIdleMinutes',
        settingValue: '30',
        settingType: 'number',
        category: 'security',
    },
    {
        id: 2,
        settingKey: 'readinessThreshold',
        settingValue: '80',
        settingType: 'number',
        category: 'readiness',
    },
    { id: 3, settingKey: 'backupKeep', settingValue: '7', settingType: 'number', category: 'jobs' },
    {
        id: 4,
        settingKey: 'perfEventsRetentionDays',
        settingValue: '30',
        settingType: 'number',
        category: 'jobs',
    },
    { id: 5, settingKey: 'digestHour', settingValue: '7', settingType: 'number', category: 'jobs' },
    {
        id: 6,
        settingKey: 'copilotUrl',
        settingValue: '',
        settingType: 'string',
        category: 'copilot',
    },
    {
        id: 7,
        settingKey: 'appBaseUrl',
        settingValue: '',
        settingType: 'string',
        category: 'general',
    },
    {
        id: 8,
        settingKey: 'smtpHost',
        settingValue: '',
        settingType: 'string',
        category: 'email',
    },
    {
        id: 9,
        settingKey: 'hris.scimAutoPlace',
        settingValue: 'false',
        settingType: 'boolean',
        category: 'onboarding',
    },
];
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/EmailService', () => ({ invalidate: jest.fn() }));
jest.mock('../../src/services/CopilotService', () => ({
    invalidate: jest.fn(),
    presets: () => [],
}));
jest.mock('../../src/services/RBACService', () => ({ hasPermission: jest.fn(() => true) }));
jest.mock('../../src/models/AppSettingsModel', () => ({
    findAll: jest.fn(async () => mockSettings.map((s) => ({ ...s }))),
    isReadOnly: () => false,
    ruleFor: () => ({}),
    validate: (k, t, v) => ({ ok: true, value: v }),
    isSecretKey: () => false,
    update: jest.fn(async () => ({})),
    initializeDefaults: jest.fn(async () => {}),
}));
jest.mock('express-validator', () => ({ validationResult: () => ({ isEmpty: () => true }) }));

const AppSettingsModel = require('../../src/models/AppSettingsModel');
const LogService = require('../../src/services/LogService');
const controller = require('../../src/controllers/AppSettingsController');
const { isSecurityClassSetting, canEditSetting } = require('../../src/utils/securitySettings');

function fakeReqRes(user, body) {
    const flashes = [];
    const req = {
        user,
        body,
        ip: '192.0.2.1',
        get: () => 'jest',
        flash: (k, v) => {
            if (v === undefined) return [];
            flashes.push([k, v]);
            return flashes.length;
        },
    };
    const res = {
        redirectedTo: null,
        redirect(u) {
            this.redirectedTo = u;
        },
    };
    return { req, res, flashes };
}

const localAdmin = { id: 5, userType: 'admin', role: 'admin', username: 'site.admin' };
const superAdmin = { id: 1, userType: 'admin', role: 'superadmin', username: 'root' };

describe('security-class settings are SuperAdmin-only, server-side', () => {
    beforeEach(() => {
        AppSettingsModel.update.mockClear();
        LogService.log.mockClear();
    });
    test.each([
        [1, 'sessionIdleMinutes'],
        [3, 'backupKeep'],
        [4, 'perfEventsRetentionDays'],
        [6, 'copilotUrl'],
        [7, 'appBaseUrl'],
        [8, 'smtpHost'],
        [9, 'hris.scimAutoPlace'],
    ])('a local admin posting setting #%s (%s) is refused, nothing written', async (id, key) => {
        const { req, res, flashes } = fakeReqRes(localAdmin, {
            id: String(id),
            settingValue: '99',
        });
        await controller.update(req, res);
        expect(AppSettingsModel.update).not.toHaveBeenCalled();
        expect(res.redirectedTo).toBe('/app-settings');
        const refusal = flashes.find(([k]) => k === 'settingError');
        expect(refusal).toBeTruthy();
        expect(JSON.parse(refusal[1]).key).toBe(key);
        expect(LogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'APP_SETTING_UPDATE_REFUSED' })
        );
    });
    test.each([
        [2, 'readinessThreshold'],
        [5, 'digestHour'],
    ])('a local admin may still change operational setting #%s (%s)', async (id) => {
        const { req, res } = fakeReqRes(localAdmin, { id: String(id), settingValue: '9' });
        await controller.update(req, res);
        expect(AppSettingsModel.update).toHaveBeenCalledTimes(1);
    });
    test('a SuperAdmin changes a security setting', async () => {
        const { req, res } = fakeReqRes(superAdmin, { id: '1', settingValue: '20' });
        await controller.update(req, res);
        expect(AppSettingsModel.update).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1, settingValue: '20' })
        );
    });
});

describe('the classifier', () => {
    test('operational vs security-class', () => {
        expect(isSecurityClassSetting('retentionRecomputeHour', 'jobs')).toBe(false);
        expect(isSecurityClassSetting('notificationRetentionDays', 'jobs')).toBe(true);
        expect(isSecurityClassSetting('maxLoginAttempts', 'general')).toBe(true);
        expect(isSecurityClassSetting('mfaRequiredForPrivileged', 'general')).toBe(true);
        expect(isSecurityClassSetting('smtpPassword', 'email')).toBe(true);
        expect(isSecurityClassSetting('emailOnCoaching', 'emailEvents')).toBe(false);
        expect(isSecurityClassSetting('brandAccentColor', 'branding')).toBe(false);
    });
    test('canEditSetting: SuperAdmin all, others not security-class', () => {
        expect(canEditSetting(superAdmin, 'sessionTimeout', 'security')).toBe(true);
        expect(canEditSetting(localAdmin, 'sessionTimeout', 'security')).toBe(false);
        expect(canEditSetting(localAdmin, 'readinessThreshold', 'readiness')).toBe(true);
        expect(canEditSetting(null, 'readinessThreshold', 'readiness')).toBe(true);
    });
    test('the refusal message exists in both languages', () => {
        for (const lang of ['en', 'fr']) {
            const admin = require(`../../locales/${lang}/admin.json`);
            expect(typeof admin.set_err_security_superadmin).toBe('string');
            expect(admin.set_err_security_superadmin).toMatch(/\{\{key\}\}/);
        }
    });
});
