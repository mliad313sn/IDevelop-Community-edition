'use strict';
/**
 * Migration 167 (SQL console read-only role).
 *
 * Static checks (always run):
 *   - 167 (or a later migration repeating its block) runs last, so the grants
 *     cover every table the migrations create;
 *   - its three lists (secret tables, secret columns, guarded tables) match
 *     SqlConsoleService, including hris_connectors.credentials.
 *
 * Database check (idevelop_test* / idevelop_fixtures only): the DO block runs
 * against a private schema holding look-alike tables, under a test-only role
 * name, inside one transaction that is always rolled back. Running it in a
 * private schema keeps the GRANT/REVOKE away from the tables the parallel
 * suites are using.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
jest.setTimeout(60000);
if (!HAS_DB) {
    // The static contract still runs without a database.
    jest.doMock('../../src/config/database', () => ({ pool: {} }));
}

const MIG_DIR = path.join(__dirname, '../../db/postgres');
const MIG = fs.readFileSync(path.join(MIG_DIR, '167_console_reader_role.sql'), 'utf8');
const MIG168 = fs.readFileSync(path.join(MIG_DIR, '168_console_reader_sync.sql'), 'utf8');
const SYNC_CALL = /^SELECT public\.fn_console_reader_sync\(\);\s*$/m;

function sqlArray(name, src = MIG) {
    const m = new RegExp(`${name} CONSTANT text\\[\\] := ARRAY\\[([^\\]]*)\\]`).exec(src);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
}
function sqlGuarded(src = MIG) {
    const m = /guarded CONSTANT jsonb := '(\{[\s\S]*?\})'::jsonb/.exec(src);
    return m ? JSON.parse(m[1]) : null;
}

describe('migration 167: static contract', () => {
    test('the grants cover every later table: the highest migration re-runs them', () => {
        const files = fs
            .readdirSync(MIG_DIR)
            .map((f) => ({ f, m: /^(\d+)_.*\.sql$/.exec(f) }))
            .filter((x) => x.m && !/_down\.sql$/.test(x.f))
            .map((x) => ({ f: x.f, n: Number(x.m[1]) }));
        const top = Math.max(...files.map((x) => x.n));
        expect(top).toBeGreaterThanOrEqual(168);
        for (const { f } of files.filter((x) => x.n === top)) {
            const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
            expect(body).toMatch(SYNC_CALL);
        }
    });

    test('every migration after 168 that adds a table or a column ends with the re-grant', () => {
        const offenders = fs
            .readdirSync(MIG_DIR)
            .filter((f) => /^\d+_.*\.sql$/.test(f) && !/_down\.sql$/.test(f))
            .filter((f) => Number(f.split('_')[0]) > 168)
            .filter((f) => {
                const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
                const ddl = /\bCREATE\s+(TABLE|VIEW|MATERIALIZED\s+VIEW)\b|\bADD\s+COLUMN\b/i.test(
                    body.replace(/--[^\n]*/g, '')
                );
                return ddl && !SYNC_CALL.test(body);
            });
        expect(offenders).toEqual([]);
    });

    test('its lists match SqlConsoleService (and guard hris_connectors.credentials)', () => {
        const Svc = require('../../src/services/SqlConsoleService').constructor;
        expect(sqlArray('secret_tables')).toEqual(Svc.SECRET_TABLES);
        expect(sqlArray('secret_cols')).toEqual(Svc.SECRET_COLUMNS);
        expect(sqlGuarded()).toEqual(Svc.GUARDED_TABLES);
        expect(sqlGuarded().hris_connectors).toEqual(['credentials']);
    });

    test('168 carries the same lists as 167 and SqlConsoleService', () => {
        const Svc = require('../../src/services/SqlConsoleService').constructor;
        expect(sqlArray('secret_tables', MIG168)).toEqual(Svc.SECRET_TABLES);
        expect(sqlArray('secret_cols', MIG168)).toEqual(Svc.SECRET_COLUMNS);
        expect(sqlGuarded(MIG168)).toEqual(Svc.GUARDED_TABLES);
    });

    test('168 is never SECURITY DEFINER and is not executable by PUBLIC', () => {
        expect(MIG168.replace(/--[^\n]*/g, '')).not.toMatch(/SECURITY\s+DEFINER/i);
        expect(MIG168).toMatch(
            /REVOKE ALL ON FUNCTION public\.fn_console_reader_sync\(text, text\) FROM PUBLIC;/
        );
    });
});

const suite = HAS_DB ? describe : describe.skip;

suite('migration 167: grants (private schema, rolled back)', () => {
    let db;
    let ready = false;
    beforeAll(async () => {
        db = require('../../src/config/database');
        try {
            await db.connect();
            ready = true;
        } catch (_) {
            ready = false;
        }
    });
    afterAll(async () => {
        if (ready) await db.close();
    });

    const SCHEMA = 'mig167_probe';
    const ROLE = 'mig167_probe_reader';
    const scoped = MIG.replace(/'sqlconsole_reader'/g, `'${ROLE}'`)
        .replace(/n\.nspname = 'public'/g, `n.nspname = '${SCHEMA}'`)
        .replace(/SCHEMA public/g, `SCHEMA ${SCHEMA}`)
        .replace(/TABLE public\.%I/g, `TABLE ${SCHEMA}.%I`);

    test('the role reads everything but the secrets', async () => {
        expect(ready).toBe(true);
        expect(scoped).not.toMatch(/'public'|public\.%I|SCHEMA public/);
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`CREATE SCHEMA ${SCHEMA}`);
            await client.query(`
                CREATE TABLE ${SCHEMA}.session (sid text, sess json);
                CREATE TABLE ${SCHEMA}.employees (id int, first_name text, password_hash text);
                CREATE TABLE ${SCHEMA}.hris_connectors (id int, provider text, credentials text);
                CREATE TABLE ${SCHEMA}.app_settings (setting_key text, setting_value text);
                CREATE TABLE ${SCHEMA}.feedback360_answers (response_id uuid, rating smallint);
                CREATE VIEW ${SCHEMA}.v_hris AS SELECT id, credentials FROM ${SCHEMA}.hris_connectors;
                CREATE VIEW ${SCHEMA}.v_hris_safe AS SELECT id, provider FROM ${SCHEMA}.hris_connectors;
                CREATE VIEW ${SCHEMA}.v_sess AS SELECT sid FROM ${SCHEMA}.session;
                CREATE VIEW ${SCHEMA}.v_over_v AS SELECT id FROM ${SCHEMA}.v_hris;`);
            await client.query(scoped);

            const can = async (rel, col) => {
                const r = col
                    ? await client.query('SELECT has_column_privilege($1, $2, $3, $4) AS ok', [
                          ROLE,
                          `${SCHEMA}.${rel}`,
                          col,
                          'SELECT',
                      ])
                    : await client.query('SELECT has_table_privilege($1, $2, $3) AS ok', [
                          ROLE,
                          `${SCHEMA}.${rel}`,
                          'SELECT',
                      ]);
                return r.rows[0].ok;
            };
            // Secret table: nothing.
            expect(await can('session')).toBe(false);
            expect(await can('session', 'sid')).toBe(false);
            // Secret-bearing tables: every column but the secret one.
            expect(await can('employees', 'first_name')).toBe(true);
            expect(await can('employees', 'password_hash')).toBe(false);
            expect(await can('employees')).toBe(false);
            expect(await can('hris_connectors', 'provider')).toBe(true);
            expect(await can('hris_connectors', 'credentials')).toBe(false);
            expect(await can('app_settings', 'setting_key')).toBe(true);
            expect(await can('app_settings', 'setting_value')).toBe(false);
            // Ordinary tables: readable.
            expect(await can('feedback360_answers')).toBe(true);
            // Views over a secret column, a secret table or a withheld view: nothing.
            expect(await can('v_hris')).toBe(false);
            expect(await can('v_sess')).toBe(false);
            expect(await can('v_over_v')).toBe(false);
            expect(await can('v_hris_safe')).toBe(true);

            // Re-running is idempotent.
            await client.query(scoped);
            expect(await can('hris_connectors', 'credentials')).toBe(false);
            expect(await can('hris_connectors', 'provider')).toBe(true);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

suite('migration 168: fn_console_reader_sync() (private schema, rolled back)', () => {
    let db;
    let ready = false;
    beforeAll(async () => {
        db = require('../../src/config/database');
        try {
            await db.connect();
            ready = true;
        } catch (_) {
            ready = false;
        }
    });
    afterAll(async () => {
        if (ready) await db.close();
    });

    const SCHEMA = 'mig168_probe';
    const ROLE = 'mig168_probe_reader';

    test('the function is installed, runs as its caller, and PUBLIC cannot execute it', async () => {
        expect(ready).toBe(true);
        const r = await db.pool.query(
            `SELECT p.prosecdef AS secdef,
                    has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_console_reader_sync'`
        );
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0].secdef).toBe(false);
        expect(r.rows[0].public_exec).toBe(false);
    });

    test('a table and a column added later become readable after one call; secrets never do', async () => {
        expect(ready).toBe(true);
        const client = await db.pool.connect();
        const can = async (rel, col) => {
            const r = col
                ? await client.query('SELECT has_column_privilege($1, $2, $3, $4) AS ok', [
                      ROLE,
                      `${SCHEMA}.${rel}`,
                      col,
                      'SELECT',
                  ])
                : await client.query('SELECT has_table_privilege($1, $2, $3) AS ok', [
                      ROLE,
                      `${SCHEMA}.${rel}`,
                      'SELECT',
                  ]);
            return r.rows[0].ok;
        };
        const sync = () =>
            client.query('SELECT public.fn_console_reader_sync($1, $2) AS s', [SCHEMA, ROLE]);
        try {
            await client.query('BEGIN');
            await client.query(`CREATE SCHEMA ${SCHEMA}`);
            await client.query(`
                CREATE TABLE ${SCHEMA}.employees (id int, first_name text, password_hash text);
                CREATE TABLE ${SCHEMA}.mfa_secrets (id int, secret_enc text);`);
            const first = await sync();
            expect(first.rows[0].s).toMatch(/ready/);
            expect(await can('employees', 'first_name')).toBe(true);
            expect(await can('employees', 'password_hash')).toBe(false);
            expect(await can('mfa_secrets')).toBe(false);

            // A later migration adds a table and a column on a column-granted table.
            await client.query(`
                CREATE TABLE ${SCHEMA}.later_table (id int, label text);
                ALTER TABLE ${SCHEMA}.employees ADD COLUMN later_col date;`);
            expect(await can('later_table')).toBe(false);
            expect(await can('employees', 'later_col')).toBe(false);
            await sync();
            expect(await can('later_table')).toBe(true);
            expect(await can('employees', 'later_col')).toBe(true);
            expect(await can('employees', 'password_hash')).toBe(false);
            expect(await can('mfa_secrets', 'id')).toBe(false);

            // Idempotent.
            await sync();
            expect(await can('later_table')).toBe(true);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});
