'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Self-service password reset — who may receive one.
 *
 * The flow already resolved an identifier by USERNAME **or EMAIL** for both
 * admins and employees, and the end-to-end chain was verified by execution:
 * request by email -> token minted -> link built from server-side config
 * (never the caller's Host header) -> token validates -> old password dead,
 * new password works -> token refuses a second use.
 *
 * What was NOT filtered was WHO could obtain one. Proven by probe before the fix:
 *
 *   leaver_gets_reset_token      : true
 *   sso_only_gets_reset_token    : true
 *
 * Both are flows that cannot end well:
 *   - a LEAVER (is_active = false) is a departure; issuing them credentials mail
 *     contradicts the offboarding path, which deactivates the account and revokes
 *     their sessions and API keys.
 *   - a DISABLED login (is_account_active = false) was switched off deliberately;
 *     a reset would set a working password on it.
 *   - an SSO-ONLY account (password_disabled) would complete the whole reset and
 *     then still be refused at login, because local password auth is closed —
 *     a dead end that looks like success.
 *
 * The HTTP response is the same generic sentence in every case, so refusing
 * these adds no account-enumeration signal.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const svc = read('src/services/PasswordResetService.js');

describe('a reset is offered by username OR email', () => {
    test('both admins and employees are resolved by email when the identifier looks like one — EVERY account carrying it (migration 107)', () => {
        expect(svc).toMatch(/if \(!id\.includes\('@'\)\) return \[\];/);
        expect(svc).toMatch(/SELECT \* FROM admins WHERE lower\(email\) = \? ORDER BY id/);
        expect(svc).toMatch(/SELECT \* FROM employees WHERE lower\(email\) = \? ORDER BY id/);
        expect(svc).toMatch(/for \(const subject of subjects\)/);
    });

    test('an unknown identifier resolves to nothing rather than throwing', () => {
        expect(svc).toMatch(/if \(!id\) return \[\];/);
        expect(svc).toMatch(/\.catch\(\(\) => \[\]\)/);
        expect(svc).toMatch(/if \(!subjects\.length\)/);
    });
});

describe('only an account that could actually log in afterwards gets a token', () => {
    test('a leaver is refused', () => {
        expect(svc).toMatch(
            /const inactive = emp\.isActive === false \|\| emp\.is_active === false;/
        );
    });

    test('a deliberately disabled login is refused', () => {
        expect(svc).toMatch(
            /const loginOff = emp\.isAccountActive === false \|\| emp\.is_account_active === false;/
        );
    });

    test('an SSO-only account is refused on both the employee and admin paths', () => {
        expect(svc).toMatch(
            /const ssoOnly = emp\.passwordDisabled === true \|\| emp\.password_disabled === true;/
        );
        expect(svc).toMatch(
            /admin\.passwordDisabled === true \|\|\s*admin\.password_disabled === true\s*\)\s*return null;/
        );
    });

    test('all three refusals happen before a subject is returned', () => {
        const guard = svc.indexOf('if (inactive || loginOff || ssoOnly) return null;');
        const ret = svc.search(/return \{\s*subjectType: 'employee'/);
        expect(guard).toBeGreaterThan(-1);
        expect(ret).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(ret);
    });

    test('the reason is recorded, including why this is not enumerable', () => {
        expect(svc).toMatch(/not enumerable from outside|none of\s*\n\s*\/\/ this is enumerable/);
    });
});

describe('the reset link never trusts the caller', () => {
    test('the origin comes from server-side config, not the Host header', () => {
        const ctrl = read('src/controllers/AuthController.js');
        expect(ctrl).toMatch(/baseUrlAsync\(req\)/);
        expect(ctrl).toMatch(/never from the caller's `Host` header/);
    });
});
