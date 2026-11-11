'use strict';
/**
 * Migration 190 (9-box four eyes, authority ladder mode) against the REAL
 * schema, inside one transaction that is always rolled back.
 *
 *   - new install: nineBoxFourEyes 'true', no notice;
 *   - upgrade: nineBoxFourEyes 'false' and one in-app notice per active
 *     SuperAdmin (kind ninebox.four_eyes_off); a row the application's
 *     defaults wrote before the migration (updated_by NULL) follows the
 *     upgrade rule, a value an administrator chose is kept;
 *   - authority.ladder is 'strict' in both cases;
 *   - a re-run changes nothing and never sends the notice twice.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(60000);

const db = HAS_DB ? require('../../src/config/database') : null;
const MIG = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/190_nine_box_four_eyes.sql'),
    'utf8'
);
const KEYS = ['nineBoxFourEyes', 'authority.ladder'];
const KIND = 'ninebox.four_eyes_off';

let ready = false;
beforeAll(async () => {
    if (!HAS_DB) return;
    try {
        await db.connect();
        ready = true;
    } catch (_) {
        ready = false;
    }
});
afterAll(async () => {
    if (HAS_DB && ready) await db.close();
});

const ROLLBACK = new Error('__MIG190_ROLLBACK__');
async function inRolledBackTx(fn) {
    try {
        await db.runTransaction(async () => {
            await fn(db._txStore.getStore());
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
}

/**
 * The migration tells a new install from an upgrade by the age of the oldest
 * schema_meta row. The age source is substituted in the SQL (same logic, a
 * chosen install date) rather than rewriting that shared table.
 */
const AGE_SOURCE = /FROM schema_meta\s+WHERE applied_at IS NOT NULL/;
function migrationInstalledAgo(hours) {
    if (!AGE_SOURCE.test(MIG)) throw new Error('migration 190 no longer reads schema_meta');
    return MIG.replace(
        AGE_SOURCE,
        `FROM (SELECT now() - interval '${Number(hours)} hours' AS applied_at) schema_meta WHERE applied_at IS NOT NULL`
    );
}

async function values(q) {
    const r = await q.query(
        'SELECT setting_key, setting_value FROM app_settings WHERE setting_key = ANY($1)',
        [KEYS]
    );
    return Object.fromEntries(r.rows.map((x) => [x.setting_key, x.setting_value]));
}
async function notices(q) {
    const r = await q.query(
        `SELECT n.user_id, n.channel::text AS channel, n.state::text AS state, n.payload
           FROM notifications n WHERE n.kind = $1 AND n.user_type = 'admin' ORDER BY n.user_id`,
        [KIND]
    );
    return r.rows;
}
async function activeSuperAdmins(q) {
    const r = await q.query(
        "SELECT id FROM admins WHERE role = 'superadmin' AND is_active = true ORDER BY id"
    );
    return r.rows.map((x) => Number(x.id));
}
async function clean(q) {
    await q.query('DELETE FROM app_settings WHERE setting_key = ANY($1)', [KEYS]);
    await q.query('DELETE FROM notifications WHERE kind = $1', [KIND]);
}

suite('migration 190: 9-box four eyes on a new install, off on an upgrade', () => {
    test('the file ends with the console reader sync', () => {
        expect(MIG.trim().endsWith('SELECT public.fn_console_reader_sync();')).toBe(true);
    });

    test('new install: four eyes on, strict ladder, no notice', async () => {
        if (!ready) return;
        let out;
        await inRolledBackTx(async (q) => {
            await clean(q);
            await q.query(migrationInstalledAgo(0));
            out = { v: await values(q), n: await notices(q) };
        });
        expect(out.v).toEqual({ nineBoxFourEyes: 'true', 'authority.ladder': 'strict' });
        expect(out.n).toEqual([]);
    });

    test('upgrade: four eyes off, one in-app notice per active SuperAdmin, once', async () => {
        if (!ready) return;
        let out;
        await inRolledBackTx(async (q) => {
            await clean(q);
            await q.query(migrationInstalledAgo(24 * 90));
            const first = { v: await values(q), n: await notices(q) };
            await q.query(migrationInstalledAgo(24 * 90));
            out = { first, again: await notices(q), supers: await activeSuperAdmins(q) };
        });
        expect(out.first.v).toEqual({ nineBoxFourEyes: 'false', 'authority.ladder': 'strict' });
        expect(out.supers.length).toBeGreaterThan(0);
        expect(out.first.n.map((r) => Number(r.user_id))).toEqual(out.supers);
        for (const r of out.first.n) {
            expect(r.channel).toBe('inapp');
            expect(r.state).toBe('queued');
            expect(r.payload).toEqual({ link: '/app-settings' });
        }
        expect(out.again.length).toBe(out.first.n.length);
    });

    test("upgrade: a defaults row is set off; an administrator's choice is kept", async () => {
        if (!ready) return;
        let out;
        await inRolledBackTx(async (q) => {
            const admin = (await activeSuperAdmins(q))[0];
            await clean(q);
            // Written by AppSettingsModel.initializeDefaults before the migration ran.
            await q.query(
                `INSERT INTO app_settings (setting_key, setting_value, setting_type, category)
                 VALUES ('nineBoxFourEyes', 'true', 'boolean', 'security')`
            );
            await q.query(migrationInstalledAgo(24 * 90));
            const defaults = await values(q);
            // A SuperAdmin switches it on afterwards; a re-run keeps that choice.
            await q.query(
                `UPDATE app_settings SET setting_value = 'true', updated_by = $1
                  WHERE setting_key = 'nineBoxFourEyes'`,
                [admin]
            );
            await q.query('DELETE FROM notifications WHERE kind = $1', [KIND]);
            await q.query(migrationInstalledAgo(24 * 90));
            out = { defaults, chosen: await values(q), n: await notices(q) };
        });
        expect(out.defaults.nineBoxFourEyes).toBe('false');
        expect(out.chosen.nineBoxFourEyes).toBe('true');
        // Four eyes is on: no notice about it being off.
        expect(out.n).toEqual([]);
    });

    test('the notice kind is declared, and both settings are SuperAdmin-only', () => {
        const catalogue = require('../../src/services/notificationCatalogue');
        expect(catalogue.isDeclared(KIND)).toBe(true);
        const { canEditSetting } = require('../../src/utils/securitySettings');
        for (const k of KEYS) {
            expect(canEditSetting({ role: 'localadmin' }, k, 'security')).toBe(false);
            expect(canEditSetting({ role: 'localadmin' }, k, 'readiness')).toBe(false);
            expect(canEditSetting({ role: 'superadmin' }, k, 'security')).toBe(true);
        }
    });
});
