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

const HAS_DB = /idevelop_test|idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
jest.setTimeout(60000);
if (!HAS_DB) {
    // The static contract still runs without a database.
    jest.doMock('../../src/config/database', () => ({ pool: {} }));
}

const MIG_DIR = path.join(__dirname, '../../db/postgres');
const MIG = fs.readFileSync(path.join(MIG_DIR, '167_console_reader_role.sql'), 'utf8');

function sqlArray(name) {
    const m = new RegExp(`${name} CONSTANT text\\[\\] := ARRAY\\[([^\\]]*)\\]`).exec(MIG);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
}
function sqlGuarded() {
    const m = /guarded CONSTANT jsonb := '(\{[\s\S]*?\})'::jsonb/.exec(MIG);
    return m ? JSON.parse(m[1]) : null;
}

describe('migration 167: static contract', () => {
    test('the grant block runs last: 167 is the highest, or the highest repeats it', () => {
        const files = fs
            .readdirSync(MIG_DIR)
            .map((f) => ({ f, m: /^(\d+)_.*\.sql$/.exec(f) }))
            .filter((x) => x.m && !/_down\.sql$/.test(x.f))
            .map((x) => ({ f: x.f, n: Number(x.m[1]) }));
        const top = Math.max(...files.map((x) => x.n));
        expect(top).toBeGreaterThanOrEqual(167);
        for (const { f } of files.filter((x) => x.n === top)) {
            const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
            expect(body).toMatch(/DO \$console_reader\$/);
        }
    });

    test('its lists match SqlConsoleService (and guard hris_connectors.credentials)', () => {
        const Svc = require('../../src/services/SqlConsoleService').constructor;
        expect(sqlArray('secret_tables')).toEqual(Svc.SECRET_TABLES);
        expect(sqlArray('secret_cols')).toEqual(Svc.SECRET_COLUMNS);
        expect(sqlGuarded()).toEqual(Svc.GUARDED_TABLES);
        expect(sqlGuarded().hris_connectors).toEqual(['credentials']);
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
