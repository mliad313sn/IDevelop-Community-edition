'use strict';
/**
 * 3.23.17 lane D — CQ-14: migrations ran at boot with no lock, so two processes
 * starting together (service restart + a manual db:migrate:all, or two nodes on
 * one database) could apply the same file concurrently. migrate() now holds a
 * PostgreSQL session advisory lock on a DEDICATED connection around the run.
 *
 * Mocked pool: every query is recorded on a single ordered timeline, tagged with
 * the connection that ran it, so the ORDER (lock -> migrations -> unlock) and the
 * connection separation are asserted, not assumed.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const os = require('os');
const path = require('path');
const PostgresDatabase = require('../../src/database/PostgresDatabase');

let dir;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-lock-'));
    fs.writeFileSync(path.join(dir, '01_schema.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, '300_a.sql'), 'CREATE TABLE IF NOT EXISTS t300 (a int);');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
});

function fakeDb({ failBody = false, failUnlock = false, max = 25 } = {}) {
    const timeline = [];
    const meta = [];
    let n = 0;
    const clients = [];
    function mkClient() {
        const id = ++n;
        const c = {
            id,
            query: jest.fn(async (sql, params) => {
                timeline.push({ conn: id, sql: String(sql).slice(0, 60), params });
                if (/pg_advisory_unlock/.test(sql) && failUnlock)
                    throw new Error('connection lost');
                if (/pg_advisory/.test(sql)) return { rows: [{}] };
                if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
                if (/INSERT INTO schema_meta/.test(sql)) {
                    meta.push({ key: params[0], value: 'applied' });
                    return { rows: [] };
                }
                if (/FROM schema_meta/.test(sql)) return { rows: meta };
                if (failBody) throw Object.assign(new Error('syntax error'), { code: '42601' });
                return { rows: [] };
            }),
            release: jest.fn(),
        };
        clients.push(c);
        return c;
    }
    const db = Object.create(PostgresDatabase.prototype);
    const poolClient = mkClient(); // what _client() returns (the pool itself)
    db.pool = { options: { max }, connect: jest.fn(async () => mkClient()) };
    db._client = () => poolClient;
    db.get = async () => ({ value: '01-base' });
    return { db, timeline, clients, meta };
}

const idx = (tl, re) => tl.findIndex((e) => re.test(e.sql));

test('lock is taken BEFORE the first migration statement and released AFTER the last, on its own connection', async () => {
    const { db, timeline, clients } = fakeDb();
    await db.migrate({ dir });
    const lock = idx(timeline, /pg_advisory_lock\(/);
    const unlock = idx(timeline, /pg_advisory_unlock\(/);
    const begin = idx(timeline, /^BEGIN/);
    const readMeta = idx(timeline, /SELECT key FROM schema_meta/);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(readMeta); // pending set is read UNDER the lock
    expect(lock).toBeLessThan(begin);
    expect(unlock).toBeGreaterThan(idx(timeline, /^COMMIT/));
    expect(unlock).toBe(timeline.length - 1);
    // same key, same dedicated connection, distinct from the migration connection
    expect(timeline[lock].params).toEqual(timeline[unlock].params);
    expect(timeline[lock].conn).toBe(timeline[unlock].conn);
    expect(timeline[begin].conn).not.toBe(timeline[lock].conn);
    const lockConn = clients.find((c) => c.id === timeline[lock].conn);
    expect(lockConn.release).toHaveBeenCalledTimes(1);
    expect(lockConn.release.mock.calls[0][0]).toBeFalsy(); // returned to the pool, not destroyed
});

test('a failing migration still releases the lock (finally) and the error propagates', async () => {
    const { db, timeline } = fakeDb({ failBody: true });
    await expect(db.migrate({ dir })).rejects.toThrow(/syntax error/);
    expect(idx(timeline, /pg_advisory_unlock\(/)).toBe(timeline.length - 1);
});

test('an unlock that fails destroys the connection (server drops the session lock)', async () => {
    const { db, timeline, clients } = fakeDb({ failUnlock: true });
    await db.migrate({ dir });
    const lockConn = clients.find(
        (c) => c.id === timeline[idx(timeline, /pg_advisory_lock\(/)].conn
    );
    expect(lockConn.release).toHaveBeenCalledWith(true);
});

test('a pool of size 1 runs unlocked (holding the lock would starve the migration connection)', async () => {
    const { db, timeline } = fakeDb({ max: 1 });
    await db.migrate({ dir });
    expect(idx(timeline, /pg_advisory/)).toBe(-1);
    expect(idx(timeline, /^COMMIT/)).toBeGreaterThanOrEqual(0);
});
