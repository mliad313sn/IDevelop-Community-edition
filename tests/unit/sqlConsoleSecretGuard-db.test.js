'use strict';
/**
 * SQL console secret guard: the SuperAdmin SQL console refuses to read or write
 * sessions, second factors, tokens, hashes and stored secrets — by what the
 * statement REACHES (tokenised, quoted/qualified names, views, routine bodies,
 * dynamic SQL, file/role/extension doors), not by a naive regex — audits every
 * refusal, and masks secret cells of a top-level read it allows.
 *
 * Runs against the jest database (idevelop_test*): catalog reads + dry-run
 * SELECTs only, every transaction rolled back. Without it, the catalog-backed
 * cases degrade to the lexical guard and the DB-only cases are skipped.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

// Only ever the jest database; without it the catalog-backed cases degrade to
// the lexical guard (a stub pool that fails) and the DB-only cases are skipped.
const HAS_DB = /idevelop_test|idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
if (!HAS_DB) {
    jest.doMock('../../src/config/database', () => ({
        pool: {
            query: async () => Promise.reject(new Error('no db')),
            connect: async () => Promise.reject(new Error('no db')),
        },
        connect: async () => {},
        close: async () => {},
    }));
}
const LogService = require('../../src/services/LogService');
const db = require('../../src/config/database');
const svc = require('../../src/services/SqlConsoleService');

let dbUp = false;
beforeAll(async () => {
    if (!HAS_DB) return;
    try {
        await db.connect();
        await db.pool.query('SELECT 1');
        dbUp = true;
    } catch (_) {
        dbUp = false;
    }
});
afterAll(async () => {
    if (!HAS_DB) return;
    try {
        await db.close();
    } catch (_) {
        /* ignore */
    }
});

const verdict = async (sql) => svc._secretAccessViolation(svc._splitStatements(sql), {});

test('the jest database is reachable when configured (the DB cases below really run)', () => {
    expect(dbUp).toBe(HAS_DB);
});

describe('secret relations and columns are refused, read AND write', () => {
    test.each([
        ['the session store', 'SELECT sess FROM session'],
        ['quoted identifier', 'SELECT * FROM "session"'],
        ['schema-qualified, upper case', 'SELECT * FROM PUBLIC.SESSION'],
        ['comment in the middle', 'SELECT * FROM /* hi */ public./**/session'],
        ['a write', "DELETE FROM session WHERE sid = 'x'"],
        ['MFA secrets', 'SELECT secret_enc FROM mfa_secrets'],
        ['backup codes', 'SELECT count(*) FROM mfa_backup_codes'],
        ['enrolment codes', 'SELECT * FROM admin_mfa_enrol_codes'],
        ['reset tokens', 'SELECT token_hash FROM password_reset_tokens'],
        ['password history', 'SELECT 1 FROM password_history'],
        ['API key hashes', 'SELECT key_hash FROM api_keys'],
        ['a password hash', 'SELECT username, password_hash FROM admins'],
        ['a password hash write', "UPDATE admins SET password_hash = 'x' WHERE id = 1"],
        [
            'stored setting secrets',
            "SELECT setting_value FROM app_settings WHERE setting_key = 'smtpPassword'",
        ],
        [
            'setting secret write',
            "UPDATE app_settings SET setting_value = 'x' WHERE setting_key = 'copilotApiSecret'",
        ],
        ['webhook secrets', 'SELECT secret FROM webhook_subscriptions'],
        ['LMS credentials', 'SELECT auth_config FROM lms_integrations'],
        ['HRIS connector credentials', 'SELECT credentials FROM hris_connectors'],
        [
            'HRIS connector credentials write',
            "UPDATE hris_connectors SET credentials = 'x' WHERE provider = 'personio'",
        ],
        ['safety-gate webhook secret', 'SELECT webhook_secret FROM safety_gate_settings'],
        ['inside a CTE', 'WITH s AS (SELECT sid, sess FROM session) SELECT count(*) FROM s'],
        [
            'through a view defined in the same script',
            'CREATE TEMP VIEW v AS SELECT sid FROM session; SELECT * FROM v',
        ],
    ])('%s', async (_label, sql) => {
        const v = await verdict(sql);
        expect(v).not.toBeNull();
        expect(v.reason).toBeTruthy();
    });

    test.each([
        ['whole-row reference', 'SELECT a FROM admins a'],
        ['row_to_json of the row', 'SELECT row_to_json(e) FROM employees e'],
        ['* stored into a table', 'CREATE TABLE loot AS SELECT * FROM admins'],
        ['* copied into another table', 'INSERT INTO loot SELECT * FROM employees'],
        ['* in a subquery', 'SELECT x FROM (SELECT * FROM admins) x'],
        ['HRIS connector row as JSON', 'SELECT row_to_json(h) FROM hris_connectors h'],
        ['INSERT without column list', "INSERT INTO admins VALUES (99, 'x')"],
        ['renaming a secret-bearing table', 'ALTER TABLE admins RENAME TO innocent'],
        [
            'trigger on a secret-bearing table',
            'CREATE TRIGGER t AFTER INSERT ON employees FOR EACH ROW EXECUTE FUNCTION f()',
        ],
    ])('rows of a secret-bearing table cannot be carried off: %s', async (_l, sql) => {
        expect(await verdict(sql)).not.toBeNull();
    });

    test.each([
        ['server file read', "SELECT pg_read_file('.env')"],
        ['COPY from a server file (.env holds APP_KEY)', "COPY sites FROM '/opt/app/.env'"],
        ['large objects', "SELECT lo_import('C:/app/.env')"],
        ['dblink', "SELECT * FROM dblink('dbname=x', 'select sess from session') AS t(s text)"],
        ['query_to_xml', "SELECT query_to_xml('select * from ses' || 'sion', true, true, '')"],
        ['table_to_xml by name', "SELECT table_to_xml('admins', true, true, '')"],
        ['current_setting', "SELECT current_setting('data_directory')"],
        ['role switch', 'SET ROLE postgres'],
        ['session authorization', 'SET SESSION AUTHORIZATION postgres'],
        ['role management', "CREATE ROLE x LOGIN PASSWORD 'y'"],
        ['extension', 'CREATE EXTENSION dblink'],
        ['foreign server', 'CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw'],
        ['server-role grant', 'GRANT pg_read_server_files TO postgres'],
        ['DB role password hashes', 'SELECT rolpassword FROM pg_authid'],
        ['untrusted language', "CREATE FUNCTION f() RETURNS int LANGUAGE c AS 'x', 'y'"],
        ['Unicode-escaped name', 'SELECT * FROM U&"\\0073ession"'],
        ['computed dynamic SQL', "DO $$ BEGIN EXECUTE 'SELECT sess FROM ses' || 'sion'; END $$"],
        ['EXECUTE format()', "DO $$ BEGIN EXECUTE format('SELECT * FROM %I', 'session'); END $$"],
        ['a DO body', 'DO $$ BEGIN PERFORM count(*) FROM mfa_secrets; END $$'],
        [
            'a routine body',
            "CREATE FUNCTION f() RETURNS text LANGUAGE sql AS 'SELECT sess::text FROM session LIMIT 1'",
        ],
        [
            'a plpgsql body with a literal EXECUTE',
            "DO $$ BEGIN EXECUTE 'DELETE FROM session'; END $$",
        ],
    ])('doors to the same data are refused: %s', async (_l, sql) => {
        expect(await verdict(sql)).not.toBeNull();
    });

    test.each([
        'SELECT count(*) FROM employees',
        'SELECT id, first_name, last_name FROM employees WHERE is_active',
        'SELECT setting_key, category FROM app_settings',
        'SELECT label, scope, revoked_at FROM api_keys',
        'SELECT provider, enabled, last_success_at FROM hris_connectors',
        'UPDATE sites SET name = name WHERE id = -1',
        'SELECT 2 * 3',
        'SET SESSION statement_timeout = 5000',
        "INSERT INTO employees (first_name, last_name) SELECT 'a', 'b' WHERE false",
        "DO $$ BEGIN EXECUTE 'SELECT 1'; END $$",
        'SELECT * FROM sites',
        'COPY sites TO STDOUT',
    ])('ordinary maintenance still runs: %s', async (sql) => {
        expect(await verdict(sql)).toBeNull();
    });

    test('an existing routine is judged by its body and its return type', async () => {
        if (!dbUp) return;
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                "CREATE FUNCTION sqlc_guard_probe() RETURNS text LANGUAGE sql AS 'SELECT sess::text FROM session LIMIT 1'"
            );
            await client.query(
                'CREATE FUNCTION sqlc_guard_rows() RETURNS SETOF admins LANGUAGE sql AS $$SELECT * FROM admins$$'
            );
            // Same session: the catalog read goes through the pool, so emulate with the client.
            const spy = jest
                .spyOn(svc, '_catalogQuery')
                .mockImplementation(async (sql, params) => (await client.query(sql, params)).rows);
            svc._secretCtxCache = null;
            const a = await svc._secretAccessViolation(['SELECT sqlc_guard_probe()'], {});
            const b = await svc._secretAccessViolation(['SELECT sqlc_guard_rows()'], {});
            spy.mockRestore();
            expect(a && a.reason).toMatch(/sqlc_guard_probe/);
            expect(b && b.reason).toMatch(/returns whole rows of admins/);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});

describe('execute(): refusal is audited, allowed reads are masked', () => {
    test('a refused statement never runs and is logged as SQL_CONSOLE_SECRET_REFUSED', async () => {
        LogService.log.mockClear();
        const spy = jest.spyOn(svc, '_writeAnalysis');
        const r = await svc.execute('SELECT sid, sess FROM session', {
            dryRun: true,
            actor: { adminId: 42, ipAddress: '10.0.0.1', userAgent: 'jest' },
        });
        expect(r.ok).toBe(false);
        expect(r.errorCode).toBe('secret_refused');
        expect(r.statements).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
        expect(LogService.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'SQL_CONSOLE_SECRET_REFUSED',
                adminId: 42,
                ipAddress: '10.0.0.1',
            })
        );
        spy.mockRestore();
    });

    test('a top-level SELECT * of employees runs, with password_hash masked', async () => {
        if (!dbUp) return;
        const r = await svc.execute('SELECT * FROM employees LIMIT 5', { dryRun: true });
        // With the restricted role of migration 167 in place, PostgreSQL itself refuses
        // « * » over a table holding a secret column: a readable refusal, never the data.
        if (!r.ok) {
            expect(r.errorCode).toBe('column_privilege');
            return;
        }
        const st = r.statements[0];
        expect(st.fields).toContain('password_hash');
        for (const row of st.rows) {
            if (row.password_hash != null) expect(row.password_hash).toBe('[secret]');
        }
        expect(JSON.stringify(st.rows)).not.toMatch(/\$2[aby]\$/);
    });

    test('SELECT * FROM app_settings masks the secret keys only', () => {
        const rows = svc.maskSecretCells(
            ['setting_key', 'setting_value'],
            [
                { setting_key: 'smtpPassword', setting_value: 'enc:v2:app_settings:a:b:c' },
                { setting_key: 'copilotApiSecret', setting_value: 'legacy-clear-key' },
                { setting_key: 'backupKeep', setting_value: '14' },
            ]
        );
        expect(rows[0].setting_value).toBe('[secret]');
        expect(rows[1].setting_value).toBe('[secret]');
        expect(rows[2].setting_value).toBe('14');
    });

    test('HRIS connector credentials are masked by column name', () => {
        const rows = svc.maskSecretCells(
            ['provider', 'credentials'],
            [{ provider: 'personio', credentials: '{"clientSecret":"x"}' }]
        );
        expect(rows[0].credentials).toBe('[secret]');
        expect(rows[0].provider).toBe('personio');
    });
});
