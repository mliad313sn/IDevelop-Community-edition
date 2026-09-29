'use strict';
/** Unit tests for SSO identity resolution (DB-mocked, no JIT provisioning). */
// The verified-e-mail match goes through EmailAccountsService (db.all): one
// address may belong to several accounts since migration 107.
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(() => Promise.resolve([])),
    run: jest.fn(() => Promise.resolve()),
}));
const db = require('../../src/config/database');
const Sso = require('../../src/services/SsoService');

describe('SsoService.resolveIdentity', () => {
    beforeEach(() => {
        db.get.mockReset();
        db.all.mockReset();
        db.all.mockResolvedValue([]);
        db.run.mockReset();
        db.run.mockResolvedValue();
    });

    test('a verified e-mail shared by several employees is NEVER auto-linked (no guess, no write)', async () => {
        db.get.mockResolvedValue(null);
        db.all.mockResolvedValue([
            { id: '88', username: 'emp88' },
            { id: '89', username: 'emp89' },
        ]);
        const p = await Sso.resolveIdentity('okta', {
            sub: 's88',
            email: 'emp@x.io',
            emailVerified: true,
        });
        expect(p).toBeNull();
        expect(db.run).not.toHaveBeenCalled();
    });

    test('denies when provider or profile missing', async () => {
        expect(await Sso.resolveIdentity(null, { email: 'a@x.io' })).toBeNull();
        expect(await Sso.resolveIdentity('entra', null)).toBeNull();
    });

    test('resolves via the normalized user_identities table first', async () => {
        // user_identities hit → then load the admin by id.
        db.get
            .mockResolvedValueOnce({ subject_type: 'admin', subject_id: '1' })
            .mockResolvedValueOnce({ id: '1', username: 'admin', role: 'superadmin' });
        const p = await Sso.resolveIdentity('entra', { sub: 'abc', email: 'admin@x.io' });
        expect(p).toEqual({ kind: 'admin', id: 1, username: 'admin', role: 'superadmin' });
        expect(db.run).not.toHaveBeenCalled(); // no relink needed
    });

    test('falls back to the legacy inline external_id column', async () => {
        // user_identities miss → inline admin hit.
        db.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: '1', username: 'admin', role: 'superadmin' });
        const p = await Sso.resolveIdentity('entra', { sub: 'abc', email: 'admin@x.io' });
        expect(p).toEqual({ kind: 'admin', id: 1, username: 'admin', role: 'superadmin' });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('NEVER matches an admin by email, even verified (anti-takeover)', async () => {
        db.get.mockResolvedValue(null); // ext lookups + employee-by-email all miss
        const p = await Sso.resolveIdentity('entra', {
            sub: 'xyz',
            email: 'Eapps@X.io',
            emailVerified: true,
        });
        expect(p).toBeNull();
        expect(db.run).not.toHaveBeenCalled();
    });

    test('matches an existing employee by VERIFIED email and links the external id', async () => {
        // user_identities (null), inline-admin (null), inline-employee (null); the
        // employee-by-verified-email match is a db.all (exactly ONE row → linked)
        db.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        db.all.mockResolvedValue([{ id: '88', username: 'emp88', email: 'emp@x.io' }]);
        const p = await Sso.resolveIdentity('okta', {
            sub: 's88',
            email: 'emp@x.io',
            emailVerified: true,
        });
        expect(p).toEqual({ kind: 'employee', id: 88, username: 'emp88' });
        // Records the identity in both the normalized table and the inline column.
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('user_identities'),
            expect.arrayContaining(['okta', 's88'])
        );
        expect(db.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE employees'), [
            'okta',
            's88',
            '88',
        ]);
    });

    test('denies an employee email match when the email is NOT verified', async () => {
        db.get.mockResolvedValue(null);
        const p = await Sso.resolveIdentity('okta', { sub: 's99', email: 'emp@x.io' }); // no emailVerified
        expect(p).toBeNull();
    });

    test('denies an unknown identity (no JIT provisioning)', async () => {
        db.get.mockResolvedValue(null);
        expect(await Sso.resolveIdentity('entra', { sub: 'none', email: 'ghost@x.io' })).toBeNull();
        expect(db.run).not.toHaveBeenCalled();
    });

    test('isEnabled reflects SSO_ENABLED', () => {
        const prev = process.env.SSO_ENABLED;
        process.env.SSO_ENABLED = '1';
        expect(Sso.isEnabled()).toBe(true);
        process.env.SSO_ENABLED = 'false';
        expect(Sso.isEnabled()).toBe(false);
        delete process.env.SSO_ENABLED;
        expect(Sso.isEnabled()).toBe(false);
        if (prev !== undefined) process.env.SSO_ENABLED = prev;
    });
});
