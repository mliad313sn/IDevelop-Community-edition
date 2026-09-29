'use strict';

/**
 * A composite report could be scheduled, and then never arrived.
 *
 * The multi-section builder saves its templates with `dataSource: 'multi'`
 * (public/js/report-builder.js), and ReportController.saveTemplate defaults a
 * MISSING dataSource to 'multi' as well. `buildQuery` has no `multi` case, so
 * it throws "Invalid data source".
 *
 * createSchedule accepted such a template without complaint. The scheduler then
 * failed on every tick — for ever — writing `last_status = 'error: Invalid data
 * source'` and raising an ops alert, so the owner could discover it only after
 * the report they were counting on had already not arrived.
 *
 * Proved against idevelop by calling buildQuery directly: 'employees',
 * 'assessments', 'readiness', 'skills', 'roles' and 'organization' build a
 * query; 'multi', 'composite', null, undefined and '' all throw.
 *
 * The schedule is now refused at CREATION, where the person can still act on
 * it, and `canExecute` is asserted below against what buildQuery really does so
 * the whitelist cannot drift away from the switch it describes.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HAS_DB = !!process.env.DATABASE_URL;
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const Svc = require('../../src/services/ReportBuilderService');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

describe('canExecute describes the sources buildQuery supports', () => {
    test('the executable list is the six real sources', () => {
        expect([...Svc.EXECUTABLE_SOURCES].sort()).toEqual([
            'assessments',
            'employees',
            'organization',
            'readiness',
            'roles',
            'skills',
        ]);
    });

    test('what the composite builder and saveTemplate produce is NOT executable', () => {
        // report-builder.js posts dataSource:'multi'; saveTemplate stores
        // `dataSource || 'multi'`, so an absent value lands there too.
        expect(Svc.canExecute('multi')).toBe(false);
        for (const v of [null, undefined, '', 'composite']) expect(Svc.canExecute(v)).toBe(false);
    });
});

suite('canExecute agrees with what buildQuery actually does', () => {
    const user = { id: '1', role: 'superadmin', userType: 'admin' };
    const CASES = [
        'employees',
        'assessments',
        'readiness',
        'skills',
        'roles',
        'organization',
        'multi',
        'composite',
        '',
    ];

    test.each(CASES)('%s: the prediction matches reality', async (ds) => {
        let executes = false;
        try {
            await Svc.buildQuery(
                {
                    dataSource: ds,
                    selectedFields: ['employeeName'],
                    filters: [],
                    sorting: null,
                    groupBy: [],
                },
                user
            );
            executes = true;
        } catch (e) {
            // Only the source check may reject; a different error would mean
            // this test is measuring something else entirely.
            expect(e.message).toBe('Invalid data source');
        }
        expect(Svc.canExecute(ds)).toBe(executes);
    });
});

describe('createSchedule refuses a template it cannot run', () => {
    const ctrl = read('src/controllers/ReportController.js').replace(/\s+/g, ' ');

    test('the guard exists and runs before the INSERT', () => {
        expect(ctrl).toMatch(/if \(!ReportBuilderService\.canExecute\(tpl\.dataSource\)\)/);
        expect(ctrl.indexOf('ReportBuilderService.canExecute(tpl.dataSource)')).toBeLessThan(
            ctrl.indexOf('INSERT INTO report_schedules')
        );
    });

    test('the template lookup selects the column the guard reads', () => {
        // Selecting only `id` would make tpl.dataSource undefined — which
        // canExecute rejects, so EVERY schedule would be refused. The guard
        // must read a real value.
        expect(ctrl).toMatch(/SELECT id, dataSource FROM reportTemplates/);
    });

    test('the refusal is translated, not a hardcoded English string', () => {
        for (const lang of ['fr', 'en']) {
            const flash = JSON.parse(read(`locales/${lang}/flash.json`));
            expect(flash.report_schedule_not_schedulable).toBeTruthy();
        }
        expect(JSON.parse(read('locales/fr/flash.json')).report_schedule_not_schedulable).toMatch(
            /planifi/i
        );
    });
});
