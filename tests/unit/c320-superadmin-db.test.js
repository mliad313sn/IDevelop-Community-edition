'use strict';
/**
 * 3.23.20 — Amendment C1/C2e against the REAL schema (idevelop_fixtures, migration
 * 153), inside ONE transaction that is always rolled back: nothing survives.
 *   - migration 153 guards: an identity can never be written onto a SuperAdmin;
 *     a SuperAdmin never keeps a linked person; a demotion is stamped;
 *   - linkSsoIdentity / onboarding merge into a SuperAdmin → refused, no row;
 *   - a conflicting link never MOVES an identity to another owner (C1b);
 *   - readiness « confirm » for a SuperAdmin → refused, link method unchanged;
 *   - eligibility / linked-person candidates never yield a SuperAdmin;
 *   - readiness: SuperAdmins without MFA (red), fewer than 2 SuperAdmins with
 *     MFA (red), identities left on SuperAdmin accounts (ignored, not deleted),
 *     demoted admins with an SSO path again (flagged).
 * SSO enforcement is faked (config/sso). Skipped when the test DB is unreachable.
 */
require('dotenv').config();

const mockSso = { enforced: true };
jest.mock('../../src/config/sso', () => ({ isConfigured: () => mockSso.enforced }));

const ROLLBACK = new Error('c320-rollback');
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
                  WHERE table_name = 'admins' AND column_name = 'demoted_from_superadmin_at'`
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

test('the migration really is on the test database (the DB tests below are not vacuous)', () => {
    if (!/idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''))) return;
    expect(ready).toBe(true);
});

test('C2d — the OS-admin recovery CLI: elevated only, SuperAdmin only, clears MFA, audited', async () => {
    if (!ready) return;
    const { resetSuperadminMfa } = require('../../scripts/reset-superadmin-mfa');
    await inRollback(async () => {
        const s = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
        const sup = Number(
            (
                await db.get(
                    `INSERT INTO admins (username, password_hash, role, is_active)
                     VALUES (?, 'x', 'superadmin', true) RETURNING id`,
                    [`c320.cli.${s}`]
                )
            ).id
        );
        const loc = Number(
            (
                await db.get(
                    `INSERT INTO admins (username, password_hash, role, is_active)
                     VALUES (?, 'x', 'localadmin', true) RETURNING id`,
                    [`c320.cli.loc.${s}`]
                )
            ).id
        );
        await db.run(
            `INSERT INTO mfa_secrets (user_type, user_id, secret_enc, confirmed_at)
             VALUES ('admin', ?, 'x', now())`,
            [sup]
        );
        const base = { osUser: 'HOST\\ops', host: 'SRV-1' };
        expect(
            (await resetSuperadminMfa({ ...base, username: `c320.cli.${s}`, elevated: false })).code
        ).toBe('not_elevated');
        expect(
            (await resetSuperadminMfa({ ...base, username: `c320.cli.loc.${s}`, elevated: true }))
                .code
        ).toBe('not_superadmin');
        expect(loc).toBeGreaterThan(0);
        const r = await resetSuperadminMfa({ ...base, username: `c320.cli.${s}`, elevated: true });
        expect(r.ok).toBe(true);
        expect(r.hadSecret).toBe(true);
        expect(
            await db.get(
                "SELECT 1 AS x FROM mfa_secrets WHERE user_type = 'admin' AND user_id = ?",
                [sup]
            )
        ).toBeFalsy();
        const log = await db.get(
            "SELECT details FROM system_logs WHERE action = 'MFA_RESET_BY_OS_ADMIN' AND entity_id = ? ORDER BY id DESC LIMIT 1",
            [String(sup)]
        );
        expect(String(log && log.details)).toMatch(/HOST\\ops on SRV-1/);
    });
}, 30000);

test('C1 — no SSO path of any kind reaches a SuperAdmin; readiness reports the gaps', async () => {
    if (!ready) return;
    const AdminSso = require('../../src/services/AdminSsoService');
    const AccountLinkService = require('../../src/services/AccountLinkService');
    await inRollback(async () => {
        const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
        const emp = await db.get(
            `SELECT e.id FROM employees e WHERE e.is_account_active = true
               AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.linked_employee_id = e.id)
             ORDER BY e.id LIMIT 1`
        );
        if (!emp) return;
        const email = `c320.${stamp}@example.test`;
        // A local admin, linked to a person, with an identity on it — then PROMOTED.
        const sup = Number(
            (
                await db.get(
                    `INSERT INTO admins (username, email, password_hash, role, is_active, linked_employee_id)
                     VALUES (?, ?, 'x', 'localadmin', true, ?) RETURNING id`,
                    [`c320.root.${stamp}`, email, Number(emp.id)]
                )
            ).id
        );
        const own = Number(
            (
                await db.get(
                    `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid)
                     VALUES ('admin', ?, 'saml', ?) RETURNING id`,
                    [sup, `c320-own-${stamp}`]
                )
            ).id
        );
        await db.run("UPDATE admins SET role = 'superadmin' WHERE id = ?", [sup]);
        const promoted = await db.get(
            'SELECT (linked_employee_id IS NULL) AS unlinked FROM admins WHERE id = ?',
            [sup]
        );
        // C1c/C1e: a SuperAdmin keeps no linked person.
        expect(promoted.unlinked).toBe(true);
        const actor = { id: sup, userType: 'admin', role: 'superadmin', isActive: true };

        // C1e: the database refuses a NEW identity on a SuperAdmin.
        await expect(
            db.runInSavepoint(() =>
                db.run(
                    `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid)
                     VALUES ('admin', ?, 'saml', ?)`,
                    [sup, `c320-direct-${stamp}`]
                )
            )
        ).rejects.toThrow(/superadmin_sso_forbidden/);

        // C1a: eligibility + chooser
        expect((await AdminSso.eligibility(sup)).reason).toBe('superadmin_sso_forbidden');
        expect((await AdminSso.eligibility(sup, { skipSwitch: true })).reason).toBe(
            'superadmin_sso_forbidden'
        );
        mockSso.enforced = false;
        expect((await AdminSso.eligibility(sup)).reason).toBe('superadmin_sso_forbidden');
        mockSso.enforced = true;
        expect(await AdminSso.linkedAdminCandidates(Number(emp.id))).toEqual([]);

        // C1b: linkSsoIdentity → refused, nothing written
        const link = await AccountLinkService.linkSsoIdentity(
            { targetType: 'admin', targetId: sup, provider: 'saml', externalId: `c320-${stamp}` },
            actor
        );
        expect(link.ok).toBe(false);
        expect(link.code).toBe('alk_superadmin_no_sso');
        expect(
            await db.get('SELECT id FROM user_identities WHERE sso_uid = ?', [`c320-${stamp}`])
        ).toBeFalsy();

        // C1b: onboarding merge into the SuperAdmin → refused, request still pending
        const reqRow = await db.get(
            `INSERT INTO onboarding_requests (email, source, auth_provider, external_id, status)
             VALUES (?, 'sso', 'saml', ?, 'pending') RETURNING id`,
            [email, `c320-merge-${stamp}`]
        );
        const merge = await AccountLinkService.mergeOnboardingRequest(
            { requestId: Number(reqRow.id), targetType: 'admin', targetId: sup },
            actor
        );
        expect(merge.code).toBe('alk_superadmin_no_sso');
        const after = await db.get('SELECT status FROM onboarding_requests WHERE id = ?', [
            Number(reqRow.id),
        ]);
        expect(after.status).toBe('pending');

        // C1b: confirm the (pre-promotion) identity FOR the SuperAdmin → refused
        const c1 = await AdminSso.confirmIdentityForAdmin(own, actor);
        expect(c1).toEqual({ ok: false, code: 'superadmin_target' });
        const m = await db.get('SELECT link_method FROM user_identities WHERE id = ?', [own]);
        expect(m.linkMethod ?? m.link_method).toBe('unknown');

        // C1b: a conflicting link never MOVES an identity to another owner.
        const other = Number(
            (
                await db.get(
                    `INSERT INTO admins (username, password_hash, role, is_active)
                     VALUES (?, 'x', 'localadmin', true) RETURNING id`,
                    [`c320.other.${stamp}`]
                )
            ).id
        );
        const moved = await AccountLinkService.linkSsoIdentity(
            {
                targetType: 'admin',
                targetId: other,
                provider: 'saml',
                externalId: `c320-own-${stamp}`,
            },
            actor
        );
        expect(moved.ok).toBe(false);
        const still = await db.get('SELECT subject_id FROM user_identities WHERE id = ?', [own]);
        expect(Number(still.subjectId ?? still.subject_id)).toBe(sup);

        // readiness (C1e, C2e)
        const r = await AdminSso.readiness();
        expect(r.superadminsWithoutMfa.map((a) => a.id)).toContain(sup);
        expect(r.superadminIdentities.filter((i) => i.adminId === sup).map((i) => i.id)).toEqual([
            own,
        ]);
        expect(typeof r.superadminsWithMfa).toBe('number');
        expect(r.superadminMfaShortfall).toBe(r.superadminsWithMfa < 2);
        expect(r.hasGaps).toBe(true);
        // identity rows are ignored, never deleted
        expect(await db.get('SELECT id FROM user_identities WHERE id = ?', [own])).toBeTruthy();

        // C1e: a DEMOTED admin that has an SSO path again is flagged.
        await db.run("UPDATE admins SET role = 'localadmin' WHERE id = ?", [sup]);
        const d = await db.get('SELECT demoted_from_superadmin_at FROM admins WHERE id = ?', [sup]);
        expect(d.demotedFromSuperadminAt ?? d.demoted_from_superadmin_at).toBeTruthy();
        await db.run("UPDATE user_identities SET link_method = 'superadmin_link' WHERE id = ?", [
            own,
        ]);
        const r2 = await AdminSso.readiness();
        expect(r2.demotedWithSso.map((a) => a.id)).toContain(sup);
    });
}, 30000);
