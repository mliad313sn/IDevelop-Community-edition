'use strict';
/**
 * ONE switch for everything about nationality: the optional localContent
 * module (setting featureLocalContent). There is no second setting.
 *
 * Behavioural, mocked database. The REAL utils/featureFlags and ModuleService
 * are exercised end to end: the switch is the `featureLocalContent` row served
 * by a mocked AppSettingsModel.getValue, flipped per test (OFF vs ON).
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

let mockLc = false;
let mockSettingsThrow = false;
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, fb) => {
        if (mockSettingsThrow) throw new Error('settings down');
        return k === 'featureLocalContent' ? mockLc : fb;
    }),
    setValue: jest.fn(),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(null) }));

const fs = require('fs');
const path = require('path');
const FF = require('../../src/utils/featureFlags');

beforeEach(() => {
    mockLc = false;
    mockSettingsThrow = false;
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
});

describe('utils/featureFlags — the localContent module, strict, fails closed', () => {
    test.each([true, 1, '1', 'true'])('%p reads ON', async (v) => {
        mockLc = v;
        await expect(FF.isNationalisationEnabled()).resolves.toBe(true);
    });
    test.each([false, 0, '0', 'false', '', null, 'maybe'])('%p reads OFF', async (v) => {
        mockLc = v;
        await expect(FF.isNationalisationEnabled()).resolves.toBe(false);
    });
    test('a settings failure reads OFF (fail closed)', async () => {
        mockLc = true;
        mockSettingsThrow = true;
        await expect(FF.isNationalisationEnabled()).resolves.toBe(false);
    });
    test('the helper asks ModuleService, not a second setting', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/utils/featureFlags.js'),
            'utf8'
        );
        expect(src).toMatch(/ModuleService'\)\.isOn\('localContent'\)/);
        expect(src).not.toMatch(/getValue\(/);
    });
});

describe('the switch is a SuperAdmin-only, security-class setting', () => {
    const S = require('../../src/utils/securitySettings');
    const LOCAL = { role: 'localadmin', userType: 'admin' };
    const SUPER = { role: 'superadmin', userType: 'admin' };
    test.each(['featureLocalContent', 'localContentHomeCountry'])('%s', (key) => {
        expect(S.isSecurityClassSetting(key, 'modules')).toBe(true);
        expect(S.canEditSetting(LOCAL, key, 'modules')).toBe(false);
        expect(S.canEditSetting(SUPER, key, 'modules')).toBe(true);
    });
    test('the helper names exactly those two keys', () => {
        expect(FF.NATIONALISATION_SETTING_KEYS).toEqual([
            'featureLocalContent',
            'localContentHomeCountry',
        ]);
    });
});

describe('DEIService — nationality only while the switch is on; data never cleared', () => {
    const DEI = require('../../src/services/DEIService');
    const HR = { userType: 'admin', role: 'superadmin', id: 1 };
    const insertParams = () =>
        mockDb.get.mock.calls.find((c) =>
            /INSERT INTO employee_demographics/.test(String(c[0]))
        )[1];
    const ledgerFields = () =>
        mockDb.get.mock.calls.find((c) => /INSERT INTO dei_consents/.test(String(c[0])))[1][1];
    function wireDeclare(heldNationality) {
        mockDb.get.mockImplementation(async (sql) => {
            if (/SELECT nationality FROM employee_demographics/.test(sql))
                return heldNationality === undefined ? null : { nationality: heldNationality };
            return { id: 9, employeeId: 4 };
        });
        mockDb.run.mockResolvedValue({ changes: 1 });
    }

    test('OFF: the nationality dimension does not exist (neutral refusal)', async () => {
        await expect(DEI.representation('nationality')).rejects.toMatchObject({
            code: 'dei_invalid_dimension',
        });
        expect(mockDb.all).not.toHaveBeenCalled();
    });
    test('ON: the nationality dimension is served', async () => {
        mockLc = true;
        mockDb.all.mockResolvedValue([]);
        await expect(DEI.representation('nationality')).resolves.toEqual([]);
    });

    test('OFF: a posted nationality is ignored and the held one is KEPT (never cleared)', async () => {
        wireDeclare('Held-A');
        await DEI.declare(4, { gender: 'female', nationality: 'Posted-B' }, { consent: true });
        expect(insertParams()[5]).toBe('Held-A');
        // The kept value stays covered by the consent ledger.
        expect(ledgerFields()).toEqual(['gender', 'nationality']);
    });
    test('OFF: nothing held → nothing written for nationality', async () => {
        wireDeclare(undefined);
        await DEI.declare(4, { gender: 'female', nationality: 'Posted-B' }, { consent: true });
        expect(insertParams()[5]).toBeNull();
        expect(ledgerFields()).toEqual(['gender']);
    });
    test('ON: the posted nationality is recorded', async () => {
        mockLc = true;
        wireDeclare('Held-A');
        await DEI.declare(4, { gender: 'female', nationality: 'Posted-B' }, { consent: true });
        expect(insertParams()[5]).toBe('Posted-B');
    });

    const ROW = { gender: 'female', ageBand: '35-44', nationality: 'Held-A', provenance: 'self' };
    test('OFF: the HR view OMITS the nationality field (absent, not null)', async () => {
        mockDb.get.mockResolvedValue(ROW);
        const out = await DEI.hrView(HR, 4);
        expect(out.gender).toBe('female');
        expect(Object.prototype.hasOwnProperty.call(out, 'nationality')).toBe(false);
    });
    test('ON: the HR view carries it', async () => {
        mockLc = true;
        mockDb.get.mockResolvedValue(ROW);
        expect((await DEI.hrView(HR, 4)).nationality).toBe('Held-A');
    });

    test('the review queue names the nationality field only while ON', async () => {
        mockDb.all.mockResolvedValue([{ employeeId: 4, hasGender: true, hasNationality: true }]);
        expect((await DEI.reviewQueue(null))[0].held).toEqual(['gender']);
        mockLc = true;
        expect((await DEI.reviewQueue(null))[0].held).toEqual(['gender', 'nationality']);
    });

    test('own view: the person still sees their own value; the input is flagged off', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /employee_demographics/.test(sql) ? ROW : null
        );
        const off = await DEI.mine(4);
        expect(off.nationalityEnabled).toBe(false);
        expect(off.values.nationality).toBe('Held-A');
        mockLc = true;
        expect((await DEI.mine(4)).nationalityEnabled).toBe(true);
    });
});

describe('the employee forms and controller follow the switch', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
    test('both forms render the field only while the module is on', () => {
        for (const v of ['views/pages/employees/create.ejs', 'views/pages/employees/edit.ejs']) {
            const src = read(v);
            const field = src.indexOf('name="nationality"');
            const gate = src.lastIndexOf('featureLocalContent', field);
            expect([v, field > 0 && gate > 0]).toEqual([v, true]);
        }
    });
    test('create and update ignore a posted nationality while it is off', () => {
        const src = read('src/controllers/EmployeeController.js');
        expect(src.match(/featureFlags'\)\.isNationalisationEnabled\(\)/g)).toHaveLength(2);
        expect(src).toMatch(/natOn && req\.body\.nationality/);
        expect(src).toMatch(/natOn && 'nationality' in req\.body/);
    });
});
