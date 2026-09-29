'use strict';
/**
 * Regression: boolean settings whose default is OFF were seeded ON.
 * setValue tested the STRING default for truthiness ('false' and '0' are
 * truthy), so a fresh install opened public self-signup to any domain and let
 * the AI copilot rank named people. Migration 159 repairs untouched rows.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

jest.mock('../../src/config/database', () => {
    const rows = new Map();
    return {
        __rows: rows,
        get: jest.fn(async (_sql, params) => {
            const v = rows.get(params && params[0]);
            return v
                ? { settingKey: params[0], settingValue: v.value, settingType: v.type }
                : undefined;
        }),
        all: jest.fn(async () => []),
        run: jest.fn(async (sql, params) => {
            if (/^INSERT/.test(sql)) rows.set(params[0], { value: params[1], type: params[2] });
            else rows.set(params[5], { value: params[0], type: params[1] });
            return {};
        }),
    };
});

const db = require('../../src/config/database');
const Model = require('../../src/models/AppSettingsModel');
const SRC = fs.readFileSync(path.join(__dirname, '../../src/models/AppSettingsModel.js'), 'utf8');

function booleanDefaults() {
    const out = [];
    const re = /key: '([^']+)',\s*value: '([^']*)',\s*type: 'boolean'/g;
    let m;
    while ((m = re.exec(SRC))) out.push([m[1], m[2]]);
    return out;
}

describe('boolean setting serialisation', () => {
    test.each([
        ['false', 'false'],
        ['0', 'false'],
        ['', 'false'],
        ['off', 'false'],
        [false, 'false'],
        [0, 'false'],
        [null, 'false'],
        ['true', 'true'],
        ['1', 'true'],
        ['on', 'true'],
        [true, 'true'],
        [1, 'true'],
    ])('%p is stored as %s', async (input, stored) => {
        await Model.setValue('t.bool', input, 'boolean');
        expect(db.__rows.get('t.bool').value).toBe(stored);
    });
});

describe('fresh install', () => {
    test('every boolean default is seeded with its documented value', async () => {
        db.__rows.clear();
        await Model.initializeDefaults();
        const defaults = booleanDefaults();
        expect(defaults.length).toBeGreaterThan(5);
        for (const [key, value] of defaults) {
            const expected = ['true', '1'].includes(value) ? 'true' : 'false';
            expect([key, db.__rows.get(key).value]).toEqual([key, expected]);
        }
    });

    test('open signup and named AI ranking are OFF out of the box', async () => {
        db.__rows.clear();
        await Model.initializeDefaults();
        for (const k of [
            'onboarding.allowOpenSignup',
            'onboarding.allowSignup',
            'onboarding.enabled',
            'copilot.allow_named_person_ranking',
        ]) {
            expect([k, db.__rows.get(k).value]).toEqual([k, 'false']);
        }
    });
});

describe('migration 159 repairs untouched rows only', () => {
    const sql = fs.readFileSync(
        path.join(__dirname, '../../db/postgres/159_boolean_settings_repair.sql'),
        'utf8'
    );
    test('it covers every boolean default that is OFF, and keeps admin choices', () => {
        const off = booleanDefaults()
            .filter(([, v]) => !['true', '1'].includes(v))
            .map(([k]) => k)
            .filter((k) => !['smtpSecure', 'emailOnAuth'].includes(k));
        for (const k of off) expect([k, sql.includes(`'${k}'`)]).toEqual([k, true]);
        expect(sql).toMatch(/updated_by IS NULL/);
    });
});
