'use strict';
/**
 * 3.23.19 — admin SSO against the REAL schema (idevelop_fixtures), inside ONE
 * transaction that is always rolled back: nothing written survives.
 * Proves the SQL of AdminSsoService (eligibility, linked-person candidates,
 * readiness report) on real columns. SSO enforcement is faked (config/sso).
 * Skipped (not failed) when the test database is not reachable.
 */
require('dotenv').config();

const mockSso = { enforced: true };
jest.mock('../../src/config/sso', () => ({ isConfigured: () => mockSso.enforced }));

const ROLLBACK = new Error('c319-rollback');
let db;
let ready = false;

beforeAll(async () => {
    if (!/idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''))) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        ready = Boolean(
            await db.get(
                `SELECT 1 AS ok FROM information_schema.columns
                  WHERE table_name = 'admins' AND column_name = 'linked_employee_id'`
            )
        );
    } catch (_) {
        ready = false;
    }
}, 30000);

afterAll(async () => {
    if (db) {
        try {
            await db.close();
        } catch (_) {
            /* already closed */
        }
    }
});

async function inRollback(fn) {
    try {
        await db.runTransaction(async () => {
            await fn();
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

test('eligibility, linked-person candidates and readiness on the real schema', async () => {
    if (!ready) return;
    const AdminSso = require('../../src/services/AdminSsoService');
    await inRollback(async () => {
        const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
        const emp = await db.get(
            `SELECT e.id FROM employees e WHERE e.is_account_active = true
               AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.linked_employee_id = e.id)
             ORDER BY e.id LIMIT 1`
        );
        if (!emp) return;
        const mk = async (name, linked) =>
            Number(
                (
                    await db.get(
                        `INSERT INTO admins (username, password_hash, role, is_active, linked_employee_id)
                         VALUES (?, 'x', 'localadmin', true, ?) RETURNING id`,
                        [`c319.${name}.${stamp}`, linked]
                    )
                ).id
            );
        const linked = await mk('linked', Number(emp.id));
        const lonely = await mk('lonely', null);

        // D4 on real columns.
        expect((await AdminSso.eligibility(linked)).ok).toBe(true);
        await db.run("UPDATE admins SET locked_until = now() + interval '1 hour' WHERE id = ?", [
            linked,
        ]);
        expect((await AdminSso.eligibility(linked)).reason).toBe('admin_locked');
        await db.run('UPDATE admins SET locked_until = NULL WHERE id = ?', [linked]);

        // D3b: the linked person is offered their admin account.
        const cands = await AdminSso.linkedAdminCandidates(Number(emp.id));
        expect(cands.map((c) => c.id)).toContain(linked);
        mockSso.enforced = false;
        expect(await AdminSso.linkedAdminCandidates(Number(emp.id))).toEqual([]);
        mockSso.enforced = true;

        // A5: the admin with no identity and no linked person is reported.
        const r = await AdminSso.readiness();
        expect(r.adminsWithoutSso.map((a) => a.id)).toContain(lonely);
        // S4: an identity of UNKNOWN origin (migration 152 default) is not a path:
        // the admin stays listed, and appears under « à confirmer ».
        const ident = Number(
            (
                await db.get(
                    `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid)
                     VALUES ('admin', ?, 'saml', ?) RETURNING id, link_method`,
                    [lonely, `c319-${stamp}`]
                )
            ).id
        );
        const r2 = await AdminSso.readiness();
        expect(r2.adminsWithoutSso.map((a) => a.id)).toContain(lonely);
        const unc = r2.adminsUnconfirmed.find((a) => a.id === lonely);
        expect(unc.identities.map((i) => i.id)).toEqual([ident]);
        expect(unc.identities[0].linkMethod).toBe('unknown');
        // A SuperAdmin confirms it → a trusted path, off the report.
        const ok = await AdminSso.confirmIdentityForAdmin(ident, {
            id: 1,
            userType: 'admin',
            role: 'superadmin',
        });
        expect(ok.ok).toBe(true);
        const r3 = await AdminSso.readiness();
        expect(r3.adminsWithoutSso.map((a) => a.id)).not.toContain(lonely);
        // S1: a fresh admin has no MFA → listed.
        expect(r3.adminsWithoutMfa.map((a) => a.id)).toContain(lonely);
        expect(typeof r3.employeesWithoutSso).toBe('number');

        // S1 on the real table: issue, wrong code counts, right code consumes once.
        const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
        expect((await AdminSso.issueEnrolCode(lonely, { ...SUPER, role: 'localadmin' })).ok).toBe(
            false
        );
        const issued = await AdminSso.issueEnrolCode(lonely, SUPER);
        expect(issued.ok).toBe(true);
        expect(issued.code).toMatch(/^[A-Z2-9]{10}$/);
        expect(await AdminSso.secondFactor(lonely, false, 'localadmin')).toBe('code');
        // 3.23.20 (C1a): the 'refuse-superadmin' branch is gone (a SuperAdmin is
        // refused by eligibility() before any second-factor question).
        expect((await AdminSso.consumeEnrolCode(lonely, 'WRONGCODE1')).reason).toBe('invalid');
        expect((await AdminSso.consumeEnrolCode(lonely, issued.code.toLowerCase())).ok).toBe(true);
        expect((await AdminSso.consumeEnrolCode(lonely, issued.code)).reason).toBe('none');
        expect(await AdminSso.secondFactor(lonely, false, 'localadmin')).toBe('refuse');
        const stored = await db.get(
            'SELECT code_hash, used_at, attempts FROM admin_mfa_enrol_codes WHERE admin_id = ? ORDER BY id DESC LIMIT 1',
            [lonely]
        );
        expect(String(stored.codeHash ?? stored.code_hash)).not.toContain(issued.code);
        expect(stored.usedAt ?? stored.used_at).toBeTruthy();
        // 5 wrong tries burn a code.
        const second = await AdminSso.issueEnrolCode(lonely, SUPER);
        for (let i = 0; i < 5; i++) await AdminSso.consumeEnrolCode(lonely, 'NOPE');
        expect((await AdminSso.consumeEnrolCode(lonely, second.code)).ok).toBe(false);
    });
}, 30000);
