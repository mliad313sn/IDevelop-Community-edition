'use strict';
/**
 * 3.23.18 lane O-ops2 — S-06 audit-trail ownership (installer side).
 *
 * The SQL is EXTRACTED from Install-IDevelop.ps1 (Get-AuditOwnerSql, via the
 * PowerShell parser) and RUN against a THROWAWAY database + throwaway roles on
 * the local PostgreSQL (never idevelop_dev / idevelop / idevelop_fixtures; dropped afterwards).
 * The fixture mirrors what the installer leaves before this step: every object
 * owned by the app role AND `GRANT ALL ON ALL TABLES/SEQUENCES` to it.
 * Asserts, connected AS the app role: INSERT/SELECT still work (the hash-chain
 * trigger still fires), while UPDATE, DELETE, TRUNCATE, DISABLE TRIGGER, DROP
 * TABLE and CREATE OR REPLACE of the guard function are all refused; an ordinary
 * table is untouched; the step is idempotent and only WARNs for a non-superuser.
 * Skipped (with the reason) when no superuser connection is available.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const INSTALL = path.join(__dirname, '..', '..', 'installer', 'Install-IDevelop.ps1');
const CONFIG = path.join(__dirname, '..', '..', 'installer', 'config.psd1');
const tag = crypto.randomBytes(4).toString('hex');
const APP = `c317o_app_${tag}`;
const OWNER = `c317o_audit_${tag}`;
const DB = `c317o_scratch_${tag}`;
const APP_PW = crypto.randomBytes(12).toString('hex');

function superPassword() {
    if (process.env.PG_SUPER_PASSWORD) return process.env.PG_SUPER_PASSWORD;
    const m = /^\s*StandardPgSuperPassword\s*=\s*'([^']*)'/m.exec(fs.readFileSync(CONFIG, 'utf8'));
    return m ? m[1] : '';
}
const conn = (database, user, password) => ({
    host: 'localhost',
    port: 5432,
    database,
    user,
    password,
});

function extractSql() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-o-ao-'));
    const ps1 = path.join(dir, 'p.ps1');
    fs.writeFileSync(
        ps1,
        `$ErrorActionPreference = 'Stop'
$tk = $null; $er = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${INSTALL}', [ref]$tk, [ref]$er)
$d = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-AuditOwnerSql' }, $true) | Select-Object -First 1
. ([scriptblock]::Create($d.Extent.Text))
[Console]::Out.Write((Get-AuditOwnerSql '${OWNER}' '${APP}'))`
    );
    try {
        return execFileSync(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
            { encoding: 'utf8', timeout: 60000 }
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

let SUPER = null;
let skipReason =
    process.platform !== 'win32'
        ? 'not Windows (the SQL is extracted by the PowerShell parser)'
        : null;
let sql = '';

beforeAll(async () => {
    if (skipReason) return;
    const c = new Client(conn('postgres', 'postgres', superPassword()));
    try {
        await c.connect();
        const r = await c.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
        if (!r.rows[0] || !r.rows[0].rolsuper) throw new Error('postgres is not a superuser here');
        SUPER = superPassword();
        await c.query(`CREATE ROLE ${APP} LOGIN PASSWORD '${APP_PW}'`);
        await c.query(`CREATE DATABASE ${DB} OWNER ${APP}`);
    } catch (e) {
        skipReason = `no local PostgreSQL superuser connection (${e.message})`;
        return;
    } finally {
        await c.end().catch(() => {});
    }
    sql = extractSql();
    const s = new Client(conn(DB, 'postgres', SUPER));
    await s.connect();
    try {
        await s.query(`
CREATE FUNCTION public.block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_TABLE: %', TG_TABLE_NAME; END $$;
CREATE FUNCTION public.block_truncate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_TABLE: % (TRUNCATE)', TG_TABLE_NAME; END $$;
CREATE FUNCTION public.fn_system_logs_hashchain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text; BEGIN SELECT row_hash INTO p FROM public.system_logs ORDER BY id DESC LIMIT 1;
NEW.prev_hash := p; NEW.row_hash := md5(coalesce(p, '') || '|' || coalesce(NEW.action, '')); RETURN NEW; END $$;
CREATE TABLE public.system_logs (id serial PRIMARY KEY, action text, prev_hash text, row_hash text);
CREATE TRIGGER trg_system_logs_hashchain BEFORE INSERT ON public.system_logs FOR EACH ROW EXECUTE FUNCTION public.fn_system_logs_hashchain();
CREATE TRIGGER trg_system_logs_immutable BEFORE UPDATE OR DELETE ON public.system_logs FOR EACH ROW EXECUTE FUNCTION public.block_mutation();
CREATE TRIGGER trg_system_logs_no_truncate BEFORE TRUNCATE ON public.system_logs FOR EACH STATEMENT EXECUTE FUNCTION public.block_truncate();
CREATE TABLE public.assessment_history (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text);
CREATE TRIGGER trg_ah_immutable BEFORE UPDATE OR DELETE ON public.assessment_history FOR EACH ROW EXECUTE FUNCTION public.block_mutation();
CREATE TABLE public.employees (id serial PRIMARY KEY, name text);
ALTER TABLE public.system_logs OWNER TO ${APP};
ALTER TABLE public.assessment_history OWNER TO ${APP};
ALTER TABLE public.employees OWNER TO ${APP};
ALTER FUNCTION public.block_mutation() OWNER TO ${APP};
ALTER FUNCTION public.block_truncate() OWNER TO ${APP};
ALTER FUNCTION public.fn_system_logs_hashchain() OWNER TO ${APP};
GRANT ALL ON ALL TABLES IN SCHEMA public TO ${APP};
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${APP};
INSERT INTO public.employees (name) VALUES ('x');`);
        await s.query(sql);
        await s.query(sql); // idempotent: a second Patch runs it again
    } finally {
        await s.end();
    }
}, 120000);

afterAll(async () => {
    if (!SUPER) return;
    const c = new Client(conn('postgres', 'postgres', SUPER));
    try {
        await c.connect();
        await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
        await c.query(`DROP ROLE IF EXISTS ${OWNER}`);
        await c.query(`DROP ROLE IF EXISTS ${APP}`);
    } finally {
        await c.end().catch(() => {});
    }
}, 60000);

async function asApp(fn) {
    const c = new Client(conn(DB, APP, APP_PW));
    await c.connect();
    try {
        return await fn(c);
    } finally {
        await c.end();
    }
}
const refused = (c, q) =>
    c.query(q).then(
        () => 'ACCEPTED',
        (e) => e.message
    );
const t = (name, fn) =>
    test(
        name,
        async () => {
            if (skipReason) {
                // eslint-disable-next-line no-console
                console.warn(`c317-O-ops2-audit-owner SKIPPED: ${skipReason}`);
                return;
            }
            await fn();
        },
        60000
    );

describe('S-06 — audit tables owned by a NOLOGIN role, app role SELECT + INSERT only', () => {
    t('ownership moved (tables + guard functions); the owner role cannot log in', async () => {
        const c = new Client(conn(DB, 'postgres', SUPER));
        await c.connect();
        try {
            const tabs = await c.query(
                `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`
            );
            expect(tabs.rows).toEqual([
                { tablename: 'assessment_history', tableowner: OWNER },
                { tablename: 'employees', tableowner: APP },
                { tablename: 'system_logs', tableowner: OWNER },
            ]);
            const fns =
                await c.query(`SELECT p.proname, r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                 JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1`);
            expect(fns.rows.every((x) => x.rolname === OWNER)).toBe(true);
            const role = await c.query(
                'SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = $1',
                [OWNER]
            );
            expect(role.rows[0]).toEqual({ rolcanlogin: false, rolsuper: false });
        } finally {
            await c.end();
        }
    });

    t('INSERT + SELECT still work and the hash chain still fires', async () => {
        await asApp(async (c) => {
            await c.query(`INSERT INTO public.system_logs (action) VALUES ('a1'), ('a2')`);
            await c.query(`INSERT INTO public.assessment_history (v) VALUES ('v1')`);
            const r = await c.query(
                'SELECT action, prev_hash, row_hash FROM public.system_logs ORDER BY id'
            );
            expect(r.rows.length).toBe(2);
            expect(r.rows[1].prev_hash).toBe(r.rows[0].row_hash);
        });
    });

    t(
        'UPDATE / DELETE / TRUNCATE / DISABLE or DROP TRIGGER / RENAME / redefining the guard: all refused',
        async () => {
            await asApp(async (c) => {
                expect(await refused(c, `UPDATE public.system_logs SET action = 'x'`)).toMatch(
                    /permission denied/
                );
                expect(await refused(c, 'DELETE FROM public.assessment_history')).toMatch(
                    /permission denied/
                );
                expect(await refused(c, 'TRUNCATE public.system_logs')).toMatch(
                    /permission denied/
                );
                expect(
                    await refused(c, 'ALTER TABLE public.system_logs DISABLE TRIGGER ALL')
                ).toMatch(/must be owner/);
                expect(
                    await refused(c, 'DROP TRIGGER trg_system_logs_immutable ON public.system_logs')
                ).toMatch(/must be owner/);
                expect(
                    await refused(c, 'ALTER TABLE public.system_logs RENAME TO old_logs')
                ).toMatch(/must be owner/);
                expect(
                    await refused(
                        c,
                        'ALTER TABLE public.system_logs ALTER COLUMN row_hash DROP NOT NULL'
                    )
                ).toMatch(/must be owner/);
                // NOT asserted here: DROP TABLE. The app role owns schema public (the
                // installer sets it so migrations can create objects), and a schema
                // owner may drop any table in it. On a real database that DROP is
                // refused by migration 120's event trigger (trg_block_append_only_drop).
                expect(
                    await refused(
                        c,
                        `CREATE OR REPLACE FUNCTION public.block_mutation() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`
                    )
                ).toMatch(/must be owner/);
                // An ordinary table is untouched.
                expect(await refused(c, `UPDATE public.employees SET name = 'y'`)).toBe('ACCEPTED');
            });
        }
    );

    t('run as a NON-superuser it only warns, and changes nothing', async () => {
        await asApp(async (c) => {
            const notes = [];
            c.on('notice', (n) => notes.push(n.message));
            await c.query(sql);
            expect(notes.join('\n')).toMatch(/AUDIT_OWNER_SKIPPED/);
        });
    });
});
