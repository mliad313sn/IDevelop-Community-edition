'use strict';
/**
 * A DB-backed suite (detected by its db.connect() call) holds the cross-worker
 * advisory lock for the whole file and gets a 60 s default per test instead of
 * jest's 5 s (tests/helpers/dbSuiteEnvironment.js, dbSuiteLockSetup.js).
 * Mutation: remove the jest.setTimeout line of dbSuiteLockSetup.js and the 6 s
 * test fails with "Exceeded timeout of 5000 ms".
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const { LOCK_KEY } = require('../helpers/dbSuiteEnvironment');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('DB suite lock and defaults', () => {
    test('the lock is held for this file', async () => {
        expect(globalThis.__dbSuiteLock.held()).toBe(true);
        const r = await db.get(
            `SELECT COUNT(*)::int AS n FROM pg_locks
              WHERE locktype = 'advisory' AND objid = $1 AND granted`,
            [LOCK_KEY]
        );
        expect(r.n).toBe(1);
    });
    test('a test may take longer than 5 s without a per-test timeout', async () => {
        await new Promise((r) => setTimeout(r, 6000));
        const r = await db.get('SELECT 1 AS one');
        expect(Number(r.one)).toBe(1);
    });
    test('the database is a test database', async () => {
        const r = await db.get('SELECT current_database() AS d');
        expect(isTestDatabaseUrl(`postgres://x@h/${r.d}`)).toBe(true);
    });
});

test('a unit suite without a test database sees an unlocked plain environment', () => {
    expect(typeof globalThis.__dbSuiteLock.acquire).toBe('function');
    expect(typeof globalThis.__nativeRequire).toBe('function');
});
