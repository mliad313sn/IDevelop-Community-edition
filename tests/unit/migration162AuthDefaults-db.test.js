'use strict';
/**
 * Migration 162 (authentication security defaults) against the REAL schema,
 * inside one transaction that is always rolled back.
 *
 *   - new install: the policy switches ON, no grace start (enforced at once);
 *   - upgrade: grace start = the upgrade instant; the session defaults move
 *     only where the old default (60 min / 24 h) is untouched, and a value an
 *     administrator chose is kept; mfaRequiredForPrivileged 'false' becomes
 *     'true' (with the grace period);
 *   - a re-run changes nothing (the grace-start row is its own marker).
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = /idevelop_test|idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(60000);

const db = HAS_DB ? require('../../src/config/database') : null;
const MIG = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/162_auth_security_defaults.sql'),
    'utf8'
);
const KEYS = [
    'mfaRequiredForPrivileged',
    'mfaRequiredForManagers',
    'mfaGraceAdminDays',
    'mfaGraceManagerDays',
    'mfaGraceStartedAt',
    'sessionIdleMinutes',
    'sessionTimeout',
];

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

const ROLLBACK = new Error('__MIG162_ROLLBACK__');
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
async function values(q) {
    const r = await q.query(
        'SELECT setting_key, setting_value FROM app_settings WHERE setting_key = ANY($1)',
        [KEYS]
    );
    return Object.fromEntries(r.rows.map((x) => [x.setting_key, x.setting_value]));
}
/**
 * The migration tells a new install from an upgrade by the age of the oldest
 * schema_meta row. Rather than rewriting that shared table (other DB suites
 * run in parallel and a lock on every row deadlocks them), the age source is
 * substituted in the SQL: same logic, a chosen install date.
 */
const AGE_SOURCE = /FROM schema_meta\s+WHERE applied_at IS NOT NULL/;
function migrationInstalledAgo(hours) {
    if (!AGE_SOURCE.test(MIG)) throw new Error('migration 162 no longer reads schema_meta');
    return MIG.replace(
        AGE_SOURCE,
        `FROM (SELECT now() - interval '${Number(hours)} hours' AS applied_at) schema_meta WHERE applied_at IS NOT NULL`
    );
}
async function setState(q, { rows }) {
    await q.query('DELETE FROM app_settings WHERE setting_key = ANY($1)', [KEYS]);
    for (const [k, v] of Object.entries(rows || {}))
        await q.query(
            `INSERT INTO app_settings (setting_key, setting_value, setting_type, category)
             VALUES ($1, $2, $3, 'security')`,
            [k, v, /^mfaRequired/.test(k) ? 'boolean' : 'number']
        );
}

suite('migration 162: authentication security defaults', () => {
    test('new install: MFA required, no grace start, 30 min / 12 h', async () => {
        if (!ready) return;
        await inRolledBackTx(async (q) => {
            await setState(q, {});
            await q.query(migrationInstalledAgo(0));
            const v = await values(q);
            expect(v).toEqual({
                mfaRequiredForPrivileged: 'true',
                mfaRequiredForManagers: 'true',
                mfaGraceAdminDays: '14',
                mfaGraceManagerDays: '30',
                mfaGraceStartedAt: '',
                sessionIdleMinutes: '30',
                sessionTimeout: '12',
            });
        });
    });

    test('upgrade: grace starts now; untouched old defaults move, chosen values stay', async () => {
        if (!ready) return;
        await inRolledBackTx(async (q) => {
            await setState(q, {
                rows: {
                    mfaRequiredForPrivileged: 'false',
                    sessionIdleMinutes: '60', // the old default
                    sessionTimeout: '8', // an administrator's choice
                },
            });
            await q.query(migrationInstalledAgo(24 * 90));
            const v = await values(q);
            expect(v.mfaRequiredForPrivileged).toBe('true');
            expect(v.sessionIdleMinutes).toBe('30');
            expect(v.sessionTimeout).toBe('8');
            const started = new Date(v.mfaGraceStartedAt);
            expect(Number.isNaN(started.getTime())).toBe(false);
            expect(Math.abs(Date.now() - started.getTime())).toBeLessThan(5 * 60000);
        });
    });

    test('a re-run changes nothing, even a value set after the first run', async () => {
        if (!ready) return;
        await inRolledBackTx(async (q) => {
            await setState(q, { rows: { sessionTimeout: '24' } });
            const upgrade = migrationInstalledAgo(24 * 90);
            await q.query(upgrade);
            expect((await values(q)).sessionTimeout).toBe('12');
            await q.query(
                "UPDATE app_settings SET setting_value = '24' WHERE setting_key = 'sessionTimeout'"
            );
            await q.query(
                "UPDATE app_settings SET setting_value = 'false' WHERE setting_key = 'mfaRequiredForPrivileged'"
            );
            const before = await values(q);
            await q.query(upgrade);
            expect(await values(q)).toEqual(before);
        });
    });
});
