'use strict';

/**
 * Admin setting `nineBoxVisibleToEmployees` — an organisation may hide the
 * 9-box from employees entirely. Default: visible (the historical behaviour).
 */

const fs = require('fs');
const path = require('path');

jest.mock('../../src/config/database', () => ({}));
jest.mock('../../src/models/AppSettingsModel', () => ({ getValue: jest.fn() }));

const AppSettingsModel = require('../../src/models/AppSettingsModel');
const TC = require('../../src/services/TalentConfidentialityService');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('TalentConfidentialityService.nineBoxVisibleToEmployees', () => {
    test('absent setting → visible (default preserves current behaviour)', async () => {
        AppSettingsModel.getValue.mockImplementation(async (_k, dflt) => dflt);
        await expect(TC.nineBoxVisibleToEmployees()).resolves.toBe(true);
        expect(AppSettingsModel.getValue).toHaveBeenCalledWith('nineBoxVisibleToEmployees', true);
    });

    test('switched off → hidden', async () => {
        AppSettingsModel.getValue.mockResolvedValue(false);
        await expect(TC.nineBoxVisibleToEmployees()).resolves.toBe(false);
    });

    test('an unreadable setting keeps the default', async () => {
        AppSettingsModel.getValue.mockRejectedValue(new Error('db down'));
        await expect(TC.nineBoxVisibleToEmployees()).resolves.toBe(true);
    });
});

describe('the setting is wired where employees see the 9-box', () => {
    test('it is a declared boolean with a default row and labels in both languages', () => {
        const model = read('src/models/AppSettingsModel.js');
        expect(model).toMatch(/nineBoxVisibleToEmployees: \{ type: 'boolean' \}/);
        expect(model).toMatch(
            /key: 'nineBoxVisibleToEmployees',\s*value: 'true',\s*type: 'boolean'/
        );
        for (const lang of ['fr', 'en']) {
            const admin = JSON.parse(read(`locales/${lang}/admin.json`));
            expect(admin.set_name_nineBoxVisibleToEmployees).toBeTruthy();
            expect(admin.set_desc_nineBoxVisibleToEmployees).toBeTruthy();
        }
    });

    test('dashboard, my-development and the subject timeline all consult it', () => {
        const portal = read('src/controllers/EmployeePortalController.js');
        expect(portal.match(/nineBoxVisibleToEmployees\(\)/g)).toHaveLength(2);
        expect(read('src/controllers/TalentActionsController.js')).toMatch(
            /nineBoxVisibleToEmployees\(\)/
        );
        const view = read('views/pages/employee/dashboard.ejs');
        expect(view).toMatch(/const nbVisible = snapshot\.nineBoxVisible !== false;/);
        // both the stat tile and the grid card sit behind the flag
        expect(view.match(/<% if \(nbVisible\) \{ %>/g)).toHaveLength(2);
    });

    test('the explainer answers the three questions', () => {
        const view = read('views/pages/employee/dashboard.ejs');
        for (const k of ['nb_explain_what', 'nb_explain_how', 'nb_explain_talk']) {
            expect(view).toContain(`employee:${k}`);
        }
    });
});
