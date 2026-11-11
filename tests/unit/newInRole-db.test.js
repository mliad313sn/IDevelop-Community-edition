'use strict';
/**
 * « New in the role » (src/utils/newInRole.js, setting newInRoleMonths of
 * migration 193) on the REAL schema, rolled back, invented people only:
 *   - a recorded role start date within the months flags the person on the
 *     9-box roster; an older one, or none, does not;
 *   - newInRoleMonths = 0 switches it off; an unreadable value reads as 6.
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/dashWorld');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/LogService', () => {
    const real = jest.requireActual('../../src/services/LogService');
    real.log = async () => null;
    return real;
});

let db;
suite('new in the role (real schema, rolled back)', () => {
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
    });
    afterAll(async () => {
        await db.close();
    });

    test('the 9-box roster flags a recorded recent start only, and the setting switches it', async () => {
        const NIR = require('../../src/utils/newInRole');
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const [recent, old] = w.people.N;
            await db.run('UPDATE employees SET role_start_date = CURRENT_DATE - 20 WHERE id = ?', [
                recent,
            ]);
            await db.run('UPDATE employees SET role_start_date = CURRENT_DATE - 400 WHERE id = ?', [
                old,
            ]);
            const sa = await db.get(
                "SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1"
            );
            const roster = await require('../../src/services/NineBoxService').roster({
                id: Number(sa.id),
                userType: 'admin',
                role: 'superadmin',
            });
            const flag = (id) => (roster.find((r) => r.employeeId === id) || {}).newInRole;
            const ids = await NIR.newInRoleIds([recent, old, w.people.N[2]]);
            const off = await NIR.newInRoleIds([recent], { months: 0 });
            // switched off through the model (which also drops its read cache)
            await require('../../src/models/AppSettingsModel').setValue(
                'newInRoleMonths',
                '0',
                'number',
                null,
                'readiness'
            );
            const offRoster = await require('../../src/services/NineBoxService').roster({
                id: Number(sa.id),
                userType: 'admin',
                role: 'superadmin',
            });
            const months = await NIR.newInRoleMonths();
            return {
                recent: flag(recent),
                old: flag(old),
                none: flag(w.people.N[2]),
                ids: [...ids],
                off: off.size,
                recentId: recent,
                months,
                offFlag: (offRoster.find((r) => r.employeeId === recent) || {}).newInRole,
            };
        });
        expect(out.recent).toBe(true);
        expect(out.old).toBe(false);
        expect(out.none).toBe(false);
        expect(out.ids).toEqual([out.recentId]);
        expect(out.off).toBe(0);
        expect(out.months).toBe(0);
        expect(out.offFlag).toBe(false);
    });
});
