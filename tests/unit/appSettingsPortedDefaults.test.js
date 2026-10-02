'use strict';
/**
 * The settings the upload, privacy and erasure port reads are App Settings now,
 * with defaults and server-side validation:
 *
 *   requireMalwareScan               'auto' | 'true' | 'false' (default auto)
 *   privacySelfExportPerHour         1-100 (default 5)
 *   unreadNotificationRetentionDays  blank = follow the read window; 0-3650
 *   onboardingRejectedRetentionDays  0-3650 (default 180)
 *
 * Each is seeded only when absent (an operator's value is never overwritten),
 * none is a boolean (so the seeded-off rule does not apply), every one is
 * security-class (SuperAdmin only), and the readers keep their meaning.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

jest.mock('../../src/config/database', () => {
    const rows = new Map();
    return {
        __rows: rows,
        get: jest.fn(async (_sql, params) => {
            const v = rows.get(params && params[0]);
            return v
                ? {
                      settingKey: params[0],
                      settingValue: v.value,
                      settingType: v.type,
                      category: v.category,
                  }
                : undefined;
        }),
        all: jest.fn(async () => []),
        run: jest.fn(async (sql, params) => {
            if (/^INSERT/.test(sql))
                rows.set(params[0], { value: params[1], type: params[2], category: params[4] });
            else rows.set(params[5], { value: params[0], type: params[1] });
            return {};
        }),
    };
});

const db = require('../../src/config/database');
const Model = require('../../src/models/AppSettingsModel');
const { isSecurityClassSetting, canEditSetting } = require('../../src/utils/securitySettings');
const EN = require('../../locales/en/admin.json');
const FR = require('../../locales/fr/admin.json');

const KEYS = {
    requireMalwareScan: { value: 'auto', type: 'string', category: 'security' },
    privacySelfExportPerHour: { value: '5', type: 'number', category: 'security' },
    unreadNotificationRetentionDays: { value: '', type: 'number', category: 'jobs' },
    onboardingRejectedRetentionDays: { value: '180', type: 'number', category: 'jobs' },
};

describe('fresh install', () => {
    beforeAll(async () => {
        db.__rows.clear();
        await Model.initializeDefaults();
    });
    test.each(Object.keys(KEYS))('%s is seeded with its documented default', (key) => {
        const row = db.__rows.get(key);
        expect(row).toBeDefined();
        expect({ value: row.value, type: row.type, category: row.category }).toEqual(KEYS[key]);
    });
    test('none of them is a boolean (the seeded-off rule does not apply)', () => {
        for (const key of Object.keys(KEYS)) expect(db.__rows.get(key).type).not.toBe('boolean');
    });
    test('an existing value is never overwritten', async () => {
        db.__rows.set('requireMalwareScan', { value: 'true', type: 'string' });
        db.__rows.set('privacySelfExportPerHour', { value: '12', type: 'number' });
        await Model.initializeDefaults();
        expect(db.__rows.get('requireMalwareScan').value).toBe('true');
        expect(db.__rows.get('privacySelfExportPerHour').value).toBe('12');
    });
});

describe('validation', () => {
    const ok = (k, t, v) => Model.validate(k, t, v);
    test('requireMalwareScan: auto, true or false only', () => {
        for (const v of ['auto', 'true', 'false'])
            expect(ok('requireMalwareScan', 'string', v)).toEqual({ ok: true, value: v });
        expect(ok('requireMalwareScan', 'string', 'yes').code).toBe('enum');
        expect(ok('requireMalwareScan', 'string', '').code).toBe('enum');
    });
    test('privacySelfExportPerHour: an integer from 1 to 100', () => {
        expect(ok('privacySelfExportPerHour', 'number', '5')).toEqual({ ok: true, value: '5' });
        expect(ok('privacySelfExportPerHour', 'number', '0').code).toBe('range');
        expect(ok('privacySelfExportPerHour', 'number', '101').code).toBe('range');
        expect(ok('privacySelfExportPerHour', 'number', '2.5').code).toBe('integer');
        expect(ok('privacySelfExportPerHour', 'number', '').code).toBe('number');
    });
    test('unreadNotificationRetentionDays: blank allowed, otherwise 0-3650', () => {
        expect(ok('unreadNotificationRetentionDays', 'number', '')).toEqual({
            ok: true,
            value: '',
        });
        expect(ok('unreadNotificationRetentionDays', 'number', '0')).toEqual({
            ok: true,
            value: '0',
        });
        expect(ok('unreadNotificationRetentionDays', 'number', '-1').code).toBe('range');
        expect(ok('unreadNotificationRetentionDays', 'number', '4000').code).toBe('range');
    });
    test('onboardingRejectedRetentionDays: 0-3650, never blank', () => {
        expect(ok('onboardingRejectedRetentionDays', 'number', '90')).toEqual({
            ok: true,
            value: '90',
        });
        expect(ok('onboardingRejectedRetentionDays', 'number', '').code).toBe('number');
        expect(ok('onboardingRejectedRetentionDays', 'number', '-5').code).toBe('range');
    });
});

describe('readers keep their meaning', () => {
    test('a blank unread window reads as null (telemetry-prune then follows the read window)', async () => {
        db.__rows.set('unreadNotificationRetentionDays', { value: '', type: 'number' });
        expect(await Model.getValue('unreadNotificationRetentionDays', null)).toBeNull();
    });
    test("requireMalwareScan 'auto' follows the scanner; true/false win", async () => {
        const Malware = require('../../src/services/MalwareScanService');
        const spy = jest.spyOn(Model, 'getValue');
        const prev = process.env.REQUIRE_MALWARE_SCAN;
        delete process.env.REQUIRE_MALWARE_SCAN;
        try {
            spy.mockResolvedValue('true');
            expect(await Malware.requireScan()).toBe(true);
            spy.mockResolvedValue('false');
            expect(await Malware.requireScan()).toBe(false);
            spy.mockResolvedValue('auto');
            const detected = Boolean((await Malware.detect()).engine);
            expect(await Malware.requireScan()).toBe(detected);
        } finally {
            spy.mockRestore();
            if (prev !== undefined) process.env.REQUIRE_MALWARE_SCAN = prev;
        }
    });
});

describe('who may change them, and how they are labelled', () => {
    test.each(Object.keys(KEYS))('%s is security-class: SuperAdmin only', (key) => {
        expect(isSecurityClassSetting(key, KEYS[key].category)).toBe(true);
        expect(canEditSetting({ role: 'admin' }, key, KEYS[key].category)).toBe(false);
        expect(canEditSetting({ role: 'superadmin' }, key, KEYS[key].category)).toBe(true);
    });
    test.each(Object.keys(KEYS))('%s has a name and a description in FR and EN', (key) => {
        for (const cat of [FR, EN]) {
            expect(cat[`set_name_${key}`]).toBeTruthy();
            expect(cat[`set_desc_${key}`]).toBeTruthy();
        }
    });
    test('the settings page lists both categories', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '..', '..', 'views/pages/app-settings/index.ejs'),
            'utf8'
        );
        expect(src).toMatch(/'security' : \{ name/);
        expect(src).toMatch(/'jobs'\s*: \{ name/);
    });
});
