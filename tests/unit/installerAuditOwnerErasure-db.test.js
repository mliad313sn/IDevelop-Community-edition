'use strict';
/**
 * Audit-trail owner separation ON: a GDPR erasure still works.
 *
 * With the installer's AuditOwnerSeparation on, system_logs and its guard
 * functions belong to the NOLOGIN role idevelop_audit_owner, and the app role
 * keeps SELECT + INSERT. fn_system_logs_redact and fn_system_logs_purge
 * (migration 170) are SECURITY DEFINER, so they run AS that owner role and read
 * tables it does not own (employees, admins, pii_cleanup_jobs). Without SELECT
 * on them every erasure failed with "permission denied for table employees".
 *
 * Static part (always): the SQL of Get-AuditOwnerSql re-owns every function of
 * migration 170 that guards or rewrites system_logs, and grants SELECT on every
 * table the SECURITY DEFINER functions read.
 *
 * Database part (test databases only, superuser connection only): a THROWAWAY
 * database and throwaway roles, dropped afterwards. The real migration 170 runs
 * as the app role (as the installer does), then the SQL of Get-AuditOwnerSql is
 * applied as superuser (twice: idempotent). Then, connected AS THE APP ROLE: a
 * redaction for an erased employee, a seal, a sealed purge with a person under
 * legal hold, and the verifier. The SQL is read from the here-string of
 * Install-IDevelop.ps1 as text, so this runs without PowerShell.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

const ROOT = path.join(__dirname, '..', '..');
const INSTALL = fs.readFileSync(path.join(ROOT, 'installer', 'Install-IDevelop.ps1'), 'utf8');
const MIG170 = fs.readFileSync(
    path.join(ROOT, 'db', 'postgres', '170_audit_log_redaction_seals_retention.sql'),
    'utf8'
);
const tag = crypto.randomBytes(4).toString('hex');
const APP = `ao_app_${tag}`;
const OWNER = `ao_audit_${tag}`;
const DB = `idevelop_test_ao_${tag}`;
const APP_PW = crypto.randomBytes(12).toString('hex');

/** The SQL Get-AuditOwnerSql returns, with its placeholders replaced. */
function auditOwnerSql(owner, app, legacy = '') {
    const fn = INSTALL.slice(INSTALL.indexOf('function Get-AuditOwnerSql'));
    const m = /\$sql = @'\r?\n([\s\S]*?)\r?\n'@/.exec(fn);
    if (!m) throw new Error('Get-AuditOwnerSql here-string not found');
    return m[1]
        .replace(/\r\n/g, '\n')
        .split('__OWNER__')
        .join(owner)
        .split('__APP__')
        .join(app)
        .split('__LEGACY__')
        .join(legacy);
}

/** Bodies of the SECURITY DEFINER functions of migration 170 (name -> body). */
function definerBodies(sql) {
    const out = {};
    const re =
        /CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?SECURITY DEFINER[\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/g;
    let m;
    while ((m = re.exec(sql))) {
        // A match may run across two functions when the first is not a definer:
        // keep only the part after the LAST function header.
        const name = m[1];
        const head = m[0].lastIndexOf('CREATE OR REPLACE FUNCTION public.');
        const tail = m[0].slice(head);
        const real = /^CREATE OR REPLACE FUNCTION public\.(\w+)/.exec(tail)[1];
        if (/SECURITY DEFINER/.test(tail)) out[real || name] = m[2];
    }
    return out;
}

describe('Get-AuditOwnerSql covers what migration 170 needs (static)', () => {
    const sql = auditOwnerSql('own_x', 'app_x');

    test('every function that guards or rewrites system_logs is re-owned', () => {
        const list = /p\.proname IN \(([\s\S]*?)\) LOOP/.exec(sql)[1];
        for (const f of [
            'block_mutation',
            'block_truncate',
            'fn_system_logs_hashchain',
            'fn_system_logs_redact',
            '_fn_system_logs_redact_flush',
            'fn_system_logs_purge',
            'fn_system_logs_seal',
            'fn_system_logs_mutation_allowed',
            'fn_system_logs_rowhash',
        ])
            expect(list).toContain(`'${f}'`);
    });

    test('SELECT is granted on every table the SECURITY DEFINER functions read', () => {
        const granted = /FOREACH t IN ARRAY ARRAY\[([^\]]*)\]/
            .exec(sql)[1]
            .split(',')
            .map((s) => s.trim().replace(/'/g, ''));
        const bodies = definerBodies(MIG170);
        expect(Object.keys(bodies).sort()).toEqual(
            ['_fn_system_logs_redact_flush', 'fn_system_logs_purge', 'fn_system_logs_redact'].sort()
        );
        // + what the trigger-side helper reads while a definer function runs.
        const helper = /FUNCTION public\.fn_system_logs_mutation_allowed\([\s\S]*?\$fn\$;/.exec(
            MIG170
        )[0];
        const read = new Set();
        for (const body of [...Object.values(bodies), helper]) {
            for (const m of body.matchAll(
                /(?<!DISTINCT\s)\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_]+)/gi
            ))
                read.add(m[1].toLowerCase());
        }
        // Owned by the audit owner itself, a temp table, or a set-returning function.
        for (const own of [
            'system_logs',
            '_audit_purge_ids',
            'jsonb_array_elements',
            'jsonb_object_keys',
            'unnest',
        ])
            read.delete(own);
        expect([...read].sort()).toEqual([...granted].sort());
    });

    test('the app keeps EXECUTE on the writing functions after the change of owner', () => {
        // ALTER ... OWNER hands the old owner's privileges to the new owner;
        // migration 170 had revoked EXECUTE from PUBLIC on these.
        const m =
            /proname IN \(([^)]*)\) LOOP\s+EXECUTE format\('GRANT EXECUTE ON FUNCTION %s TO %I', r\.sig, app\)/.exec(
                sql
            );
        expect(m).not.toBeNull();
        for (const f of ['fn_system_logs_redact', 'fn_system_logs_purge', 'fn_system_logs_seal'])
            expect(m[1]).toContain(`'${f}'`);
        expect(m[1]).not.toContain('_fn_system_logs_redact_flush');
    });

    test('the owner role is only granted SELECT (never write) on those tables', () => {
        expect(sql).toMatch(/GRANT SELECT ON TABLE public\.%I TO %I', t, own/);
        expect(sql).not.toMatch(/GRANT (?:ALL|UPDATE|DELETE|INSERT)[^;]*own\)/);
    });
});

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);

// What the schema holds before migration 170 (only the columns 170 touches).
const FIXTURE = (app) => `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.app_settings (id serial PRIMARY KEY, setting_key text UNIQUE, setting_value text,
  setting_type text, description text, category text);
CREATE TABLE public.employees (id serial PRIMARY KEY, name text, email text,
  erased_at timestamptz, legal_hold_at timestamptz);
CREATE TABLE public.admins (id serial PRIMARY KEY, username text, linked_employee_id bigint);
CREATE TABLE public.pii_cleanup_jobs (id serial PRIMARY KEY, employee_id bigint,
  legal_hold_at timestamptz, completed_at timestamptz);
CREATE TABLE public.system_logs (id serial PRIMARY KEY, admin_id bigint, action text,
  entity_type text, entity_id bigint, details jsonb, created_at timestamptz DEFAULT now(),
  actor_ref text, ip_address text, user_agent text, request_id text, severity text,
  category text, prev_hash text, row_hash text);
CREATE FUNCTION public.block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_TABLE'; END $$;
CREATE FUNCTION public.block_truncate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_TABLE (TRUNCATE)'; END $$;
CREATE FUNCTION public.fn_system_logs_hashchain() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_system_logs_hashchain BEFORE INSERT ON public.system_logs FOR EACH ROW EXECUTE FUNCTION public.fn_system_logs_hashchain();
CREATE TRIGGER trg_system_logs_immutable BEFORE UPDATE OR DELETE ON public.system_logs FOR EACH ROW EXECUTE FUNCTION public.block_mutation();
CREATE TRIGGER trg_system_logs_no_truncate BEFORE TRUNCATE ON public.system_logs FOR EACH STATEMENT EXECUTE FUNCTION public.block_truncate();
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO %I', r.tablename, '${app}'); END LOOP;
END $$;
ALTER FUNCTION public.block_mutation() OWNER TO ${app};
ALTER FUNCTION public.block_truncate() OWNER TO ${app};
ALTER FUNCTION public.fn_system_logs_hashchain() OWNER TO ${app};
GRANT ALL ON ALL TABLES IN SCHEMA public TO ${app};
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${app};
`;

(HAS_DB ? describe : describe.skip)(
    'separation ON: erasure, seal, purge, verify (scratch database)',
    () => {
        let base = null; // connection settings of DATABASE_URL (a superuser)
        let skipReason = null;
        let created = false;

        const conn = (database, user, password) => ({ ...base, database, user, password });
        async function withClient(cfg, fn) {
            const c = new Client(cfg);
            await c.connect();
            try {
                return await fn(c);
            } finally {
                await c.end().catch(() => {});
            }
        }
        const asSuper = (fn) => withClient(conn(DB, base.user, base.password), fn);
        const asApp = (fn) => withClient(conn(DB, APP, APP_PW), fn);

        beforeAll(async () => {
            const u = new URL(process.env.DATABASE_URL);
            base = {
                host: u.hostname,
                port: Number(u.port || 5432),
                user: decodeURIComponent(u.username),
                password: decodeURIComponent(u.password),
            };
            try {
                await withClient(
                    conn(decodeURIComponent(u.pathname.slice(1)), base.user, base.password),
                    async (c) => {
                        const r = await c.query(
                            'SELECT rolsuper FROM pg_roles WHERE rolname = current_user'
                        );
                        if (!r.rows[0] || !r.rows[0].rolsuper)
                            throw new Error('the test role is not a superuser');
                        await c.query(`CREATE ROLE ${APP} LOGIN NOSUPERUSER PASSWORD '${APP_PW}'`);
                        await c.query(`CREATE DATABASE ${DB} OWNER ${APP}`);
                        created = true;
                    }
                );
            } catch (e) {
                skipReason = `no superuser connection to create a scratch database (${e.message})`;
                return;
            }
            await asSuper((c) => c.query(FIXTURE(APP)));
            // The migrations run as the app role, which owns everything at that point.
            await asApp((c) => c.query(MIG170));
            const sql = auditOwnerSql(OWNER, APP);
            await asSuper(async (c) => {
                await c.query(sql);
                await c.query(sql); // idempotent: every Patch runs it again
            });
        }, 180000);

        afterAll(async () => {
            if (!base) return;
            const u = new URL(process.env.DATABASE_URL);
            await withClient(
                conn(decodeURIComponent(u.pathname.slice(1)), base.user, base.password),
                async (c) => {
                    if (created) await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
                    await c.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
                    await c.query(`DROP ROLE IF EXISTS ${APP}`).catch(() => {});
                }
            ).catch(() => {});
        }, 60000);

        const t = (name, fn) =>
            test(
                name,
                async () => {
                    if (skipReason) {
                        // eslint-disable-next-line no-console
                        console.warn(`installerAuditOwnerErasure SKIPPED: ${skipReason}`);
                        return;
                    }
                    await fn();
                },
                120000
            );

        t(
            'the separation is really on (system_logs and the definer functions owned by the NOLOGIN role)',
            async () => {
                await asApp(async (c) => {
                    const r = await c.query(
                        `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'system_logs'`
                    );
                    expect(r.rows[0].tableowner).toBe(OWNER);
                    const f = await c.query(
                        `SELECT p.proname, r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.proname IN ('fn_system_logs_redact', '_fn_system_logs_redact_flush', 'fn_system_logs_purge',
                                      'fn_system_logs_mutation_allowed', 'fn_system_logs_rowhash', 'fn_system_logs_seal')
                  ORDER BY 1`
                    );
                    expect(f.rows).toHaveLength(6);
                    expect(f.rows.every((x) => x.rolname === OWNER)).toBe(true);
                    const u = await c
                        .query(`UPDATE public.system_logs SET details = '{}'::jsonb`)
                        .then(
                            () => 'ACCEPTED',
                            (e) => e.message
                        );
                    expect(u).toMatch(/permission denied/);
                    // The owner reads the three tables, never writes them.
                    const g = await c.query(
                        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
                  WHERE grantee = $1 ORDER BY 1, 2`,
                        [OWNER]
                    );
                    expect(g.rows).toEqual([
                        { table_name: 'admins', privilege_type: 'SELECT' },
                        { table_name: 'employees', privilege_type: 'SELECT' },
                        { table_name: 'pii_cleanup_jobs', privilege_type: 'SELECT' },
                    ]);
                });
            }
        );

        t(
            'redaction for an erased person, seal, sealed purge with a legal hold, verify: all succeed as the app role',
            async () => {
                await asApp(async (c) => {
                    const e1 = await c.query(
                        `INSERT INTO public.employees (name, email) VALUES ('Quentin Example', 'quentin.example@example.test') RETURNING id`
                    );
                    const e2 = await c.query(
                        `INSERT INTO public.employees (name, legal_hold_at) VALUES ('Held Person', now()) RETURNING id`
                    );
                    const erased = e1.rows[0].id;
                    const held = e2.rows[0].id;
                    await c.query(
                        `INSERT INTO public.admins (username, linked_employee_id) VALUES ('held.admin', $1)`,
                        [held]
                    );
                    await c.query(`INSERT INTO public.pii_cleanup_jobs (employee_id) VALUES ($1)`, [
                        erased,
                    ]);
                    await c.query(
                        `INSERT INTO public.system_logs (action, entity_type, entity_id, details, actor_ref)
                 VALUES ('UPDATE_EMPLOYEE', 'employee', $1, jsonb_build_object('msg', 'updated Quentin Example (quentin.example@example.test)'), 'admin:999'),
                        ('UPDATE_EMPLOYEE', 'employee', $2, jsonb_build_object('msg', 'held row'), 'admin:999'),
                        ('LOGIN', 'admin', 999, jsonb_build_object('msg', 'plain'), 'admin:999')`,
                        [erased, held]
                    );
                    await c.query(
                        `UPDATE public.employees SET erased_at = now(), name = 'erased' WHERE id = $1`,
                        [erased]
                    );

                    const red = await c.query(
                        `SELECT public.fn_system_logs_redact($1, ARRAY['Quentin Example', 'quentin.example@example.test'], 'admin:1', 'erasure') AS r`,
                        [erased]
                    );
                    expect(red.rows[0].r.rows).toBe(1);
                    const after = await c.query(
                        `SELECT details->>'msg' AS msg FROM public.system_logs WHERE action = 'UPDATE_EMPLOYEE' AND entity_id = $1`,
                        [erased]
                    );
                    expect(after.rows[0].msg).not.toMatch(/Quentin|quentin/);
                    expect(after.rows[0].msg).toContain(`employee:${erased}`);

                    const v1 = await c.query('SELECT public.fn_system_logs_verify() AS v');
                    expect(v1.rows[0].v.intact).toBe(true);

                    const sealed = await c.query(
                        `SELECT public.fn_system_logs_seal(now() + interval '20 years') AS n`
                    );
                    expect(sealed.rows[0].n).toBeGreaterThanOrEqual(1);
                    const pur = await c.query(
                        `SELECT public.fn_system_logs_purge(1, 'system:test', now() + interval '20 years') AS p`
                    );
                    const p = pur.rows[0].p;
                    // The redacted row and the plain one go; the held person's row stays.
                    expect(p.deleted).toBe(2);
                    expect(p.heldEmployees).toBe(1);
                    const keptHeld = await c.query(
                        `SELECT count(*)::int AS n FROM public.system_logs WHERE entity_type = 'employee' AND entity_id = $1`,
                        [held]
                    );
                    expect(keptHeld.rows[0].n).toBe(1);

                    const v2 = await c.query('SELECT public.fn_system_logs_verify() AS v');
                    expect(v2.rows[0].v.intact).toBe(true);
                });
            }
        );

        t('a redaction for a person who is NOT erased is still refused', async () => {
            await asApp(async (c) => {
                const e = await c.query(
                    `INSERT INTO public.employees (name) VALUES ('Still Here') RETURNING id`
                );
                const r = await c
                    .query(
                        `SELECT public.fn_system_logs_redact($1, ARRAY['Still Here'], 'admin:1', 'erasure')`,
                        [e.rows[0].id]
                    )
                    .then(
                        () => 'ACCEPTED',
                        (err) => err.message
                    );
                expect(r).toMatch(/AUDIT_REDACTION_REFUSED/);
            });
        });
    }
);
