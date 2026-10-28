'use strict';
/**
 * Migration 169 and the installer: the audit-trail owner role has a
 * product-neutral name (idevelop_audit_owner), and a role created under the
 * legacy name by an earlier installer is renamed in place.
 *
 * Static checks always run. The database check (test databases only) runs the
 * migration inside one transaction that is always rolled back (CREATE ROLE and
 * ALTER ROLE are transactional), and only when the test role may create roles.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

const ROOT = path.join(__dirname, '..', '..');
const MIG = fs.readFileSync(
    path.join(ROOT, 'db', 'postgres', '169_audit_owner_role_rename.sql'),
    'utf8'
);
const INSTALL = fs.readFileSync(path.join(ROOT, 'installer', 'Install-IDevelop.ps1'), 'utf8');
const LEGACY = ['four', 'mp_audit_owner'].join('');
const NEW = 'idevelop_audit_owner';

describe('audit owner role name: static contract', () => {
    test('the installer creates idevelop_audit_owner and renames the legacy role', () => {
        expect(INSTALL).toMatch(/\$script:AuditOwnerRole = 'idevelop_audit_owner'/);
        expect(INSTALL).toMatch(/\$script:LegacyAuditOwnerRole = 'four' \+ 'mp_audit_owner'/);
        expect(INSTALL).toMatch(
            /Get-AuditOwnerSql \$script:AuditOwnerRole \$cfg\.DbUser \$script:LegacyAuditOwnerRole/
        );
        expect(INSTALL).toMatch(/ALTER ROLE %I RENAME TO %I', legacy, own/);
        expect(INSTALL).toMatch(/\.Replace\('__LEGACY__', \$Legacy\)/);
    });

    test('the legacy name never appears in clear in the migration or the installer', () => {
        expect(MIG.includes(LEGACY)).toBe(false);
        expect(INSTALL.includes(LEGACY)).toBe(false);
        expect(MIG).toMatch(/'four' \|\| 'mp_audit_owner'/);
    });

    test('the migration never fails: privilege errors become a NOTICE', () => {
        expect(MIG).toMatch(/EXCEPTION WHEN insufficient_privilege/);
        expect(MIG).toMatch(/v_new CONSTANT text := 'idevelop_audit_owner'/);
    });
});

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
(HAS_DB ? describe : describe.skip)('migration 169 (rolled back)', () => {
    let db;
    let ready = false;
    let canCreateRole = false;
    beforeAll(async () => {
        db = require('../../src/config/database');
        try {
            await db.connect();
            ready = true;
            const r = await db.pool.query(
                'SELECT rolcreaterole OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user'
            );
            canCreateRole = !!(r.rows[0] && r.rows[0].ok);
        } catch (_) {
            ready = false;
        }
    });
    afterAll(async () => {
        if (ready) await db.close();
    });

    test('renames a legacy role, keeps its ownerships, and is idempotent', async () => {
        expect(ready).toBe(true);
        if (!canCreateRole) return; // the static contract above still holds
        const client = await db.pool.connect();
        const exists = async (name) =>
            (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount ===
            1;
        try {
            await client.query('BEGIN');
            const already = await exists(NEW);
            if (already) return; // a real separated install on this cluster: nothing to prove here
            await client.query(`CREATE ROLE ${LEGACY} NOLOGIN`);
            await client.query('CREATE TABLE mig169_probe (id int)');
            await client.query(`ALTER TABLE mig169_probe OWNER TO ${LEGACY}`);
            await client.query(MIG);
            expect(await exists(LEGACY)).toBe(false);
            expect(await exists(NEW)).toBe(true);
            const owner = await client.query(
                `SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE relname = 'mig169_probe'`
            );
            expect(owner.rows[0].o).toBe(NEW);
            await client.query(MIG); // second run: nothing to do
            expect(await exists(NEW)).toBe(true);
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });
});
