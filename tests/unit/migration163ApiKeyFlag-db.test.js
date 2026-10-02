'use strict';
/**
 * Migration 163 (per-key "allow query-string" flag) against the REAL schema,
 * inside one transaction that is always rolled back:
 *   - the column exists, NOT NULL, default false: a NEW key is header-only;
 *   - re-running the file never re-opens a key a SuperAdmin closed;
 *   - ApiKeyService reads and writes the flag.
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
    path.join(__dirname, '../../db/postgres/163_api_key_query_string_flag.sql'),
    'utf8'
);

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

const ROLLBACK = new Error('__MIG163_ROLLBACK__');
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

suite('migration 163: api_keys.allow_query_key', () => {
    test('a new key is header-only; a re-run never re-opens a closed key', async () => {
        if (!ready) return;
        await inRolledBackTx(async (q) => {
            const col = await q.query(
                `SELECT is_nullable, column_default FROM information_schema.columns
                  WHERE table_name = 'api_keys' AND column_name = 'allow_query_key'`
            );
            expect(col.rows).toHaveLength(1);
            expect(col.rows[0].is_nullable).toBe('NO');
            expect(String(col.rows[0].column_default)).toMatch(/false/);

            const admin = await q.query('SELECT id FROM admins ORDER BY id LIMIT 1');
            const ApiKeyService = require('../../src/services/ApiKeyService');
            const k = await ApiKeyService.generate({
                label: 'mig163-test',
                createdBy: Number(admin.rows[0].id),
            });
            expect((await ApiKeyService.validate(k.key)).allowQueryKey).toBe(false);

            expect(await ApiKeyService.setQueryKeyAllowed(k.id, true)).toBe(1);
            expect((await ApiKeyService.validate(k.key)).allowQueryKey).toBe(true);
            expect(await ApiKeyService.setQueryKeyAllowed(k.id, false)).toBe(1);

            await q.query(MIG); // idempotent: the backfill ran only when the column was created
            expect((await ApiKeyService.validate(k.key)).allowQueryKey).toBe(false);
        });
    });
});
