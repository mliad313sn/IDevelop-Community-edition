'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L3-4 (criticality 360, gravity 10) — a leaver kept their admin access.
 *
 * `onLeaver` deactivated the `employees` row and revoked the employee/manager
 * session buckets, and stopped there. An employee who had been promoted to admin
 * has a SECOND account (`admins.linked_employee_id`), and nothing touched it:
 *
 *   * `deserializeUser` gates on `admins.is_active`, which stayed true — so the
 *     departed person kept a fully valid admin login with full HR reach;
 *   * `ApiKeyService.validate` tests the OWNING ADMIN's `is_active`, so their
 *     `/api/v1` keys kept resolving too — access that survives a browser session
 *     entirely.
 *
 * Proven by probe (rolled back): after onLeaver, employee is_active=false and
 * admin is_active=true. After the fix the admin is disabled, the API keys carry a
 * revoked_at, and the admin session bucket is revoked.
 *
 * Scoring rationale: G=10 (a departed person retaining HR-wide administrative
 * access is the most serious failure in this product), O=4 (only leavers who were
 * also admins), D=9 (nothing reports it — the offboarding screen says done).
 *
 * AdminController already performs this cascade when an admin is DELETED. A
 * departure must not be a weaker gate than an admin deletion.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const svc = read('src/services/LifecycleService.js');

describe('processing a leaver closes every door, not just the employee one', () => {
    test('linked admin accounts are found by linked_employee_id', () => {
        expect(svc).toMatch(
            /SELECT id FROM admins WHERE linked_employee_id = \? AND is_active = true/
        );
    });

    test('the linked admin account is deactivated', () => {
        expect(svc).toMatch(/UPDATE admins SET is_active = false WHERE id = \?/);
    });

    test('their API keys are revoked — those outlive any session', () => {
        expect(svc).toMatch(/require\('\.\/ApiKeyService'\)\.revokeByOwner\(Number\(a\.id\)\)/);
    });

    test('their admin session bucket is revoked too', () => {
        expect(svc).toMatch(/SessionService\.revokeAllForUser\(Number\(a\.id\), 'admin'\)/);
        // The employee and manager buckets were already handled; all three must be.
        expect(svc).toMatch(/revokeAllForUser\(employeeId, 'employee'\)/);
        expect(svc).toMatch(/revokeAllForUser\(employeeId, 'manager'\)/);
    });

    test('the revocation is audited', () => {
        expect(svc).toMatch(/action: 'lifecycle\.leaver\.admin_revoked'/);
    });

    test('a failure here is logged loudly rather than swallowed silently', () => {
        // Everything else in the JML path is deliberately best-effort. A leaver
        // keeping admin access is a standing privilege, not a missed notification.
        expect(svc).toMatch(/leaver admin-account revoke FAILED for employee/);
    });

    test('the revocation happens before the event is marked processed', () => {
        const revoke = svc.indexOf('SELECT id FROM admins WHERE linked_employee_id');
        const processed = svc.indexOf("kind = 'leaver' AND processed_at IS NULL");
        expect(revoke).toBeGreaterThan(-1);
        expect(processed).toBeGreaterThan(-1);
        expect(revoke).toBeLessThan(processed);
    });
});
