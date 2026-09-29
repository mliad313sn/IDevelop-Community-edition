'use strict';

/**
 * Lot C — the admin console verbs (L1-01/02/07/08/11/21, L6-07).
 *
 * The lateral takeover this pins: a site-scoped delegate holding
 * `manage_admins` could open a peer whose reach is WIDER than their own and
 * reset its password — acquiring, in one request, the authority the assignment
 * guard refuses to grant them. Containment (`you may administer an account only
 * if it governs nobody you do not already govern`) is now checked on `show` and
 * on every write, and the same rule decides which rows the CSV contains.
 */

const mockDb = {
    all: jest.fn(async () => []),
    get: jest.fn(async () => null),
    run: jest.fn(async () => ({ changes: 0 })),
    runTransaction: jest.fn(async (fn) => fn()),
    _client: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

const AdminController = require('../../src/controllers/AdminController');
const { containsScope, LIST_SORT } = AdminController._internals;

const SCOPE_SITE11 = { unrestricted: false, employeeIds: [1, 2, 3] };
const SCOPE_COUNTRY = { unrestricted: false, employeeIds: [1, 2, 3, 4, 5] };
const SCOPE_ALL = { unrestricted: true, employeeIds: null };

function req(user, { body = {}, params = {}, query = {} } = {}) {
    const flashes = [];
    return {
        user,
        body,
        params,
        query,
        ip: '127.0.0.1',
        sessionID: 'sid',
        language: 'fr',
        get: () => 'test',
        t: (k, o) => (o && o.defaultValue) || k,
        flash(k, m) {
            if (m === undefined) return flashes.filter((f) => f.k === k).map((f) => f.m);
            flashes.push({ k, m });
        },
        _flashes: flashes,
    };
}
function res() {
    const o = { redirects: [], renders: [], headers: {}, sent: null, status: 200 };
    return {
        o,
        redirect: (u) => o.redirects.push(u),
        render: (v, d) => o.renders.push({ v, d }),
        status(c) {
            o.status = c;
            return this;
        },
        setHeader: (k, v) => {
            o.headers[k] = v;
        },
        send: (b) => {
            o.sent = b;
        },
        json: (j) => {
            o.sent = j;
        },
    };
}
const flashOf = (r) => r._flashes.map((f) => `${f.k}:${f.m}`);

describe('Lot C — containment (the rolled-back lateral-takeover probe)', () => {
    test('a site delegate does NOT contain a country-wide peer', () => {
        expect(containsScope(SCOPE_SITE11, SCOPE_COUNTRY)).toBe(false);
    });

    test('a wider actor contains a narrower target', () => {
        expect(containsScope(SCOPE_COUNTRY, SCOPE_SITE11)).toBe(true);
    });

    test('nobody scoped contains an unrestricted account; a SuperAdmin contains everyone', () => {
        expect(containsScope(SCOPE_COUNTRY, SCOPE_ALL)).toBe(false);
        expect(containsScope(SCOPE_ALL, SCOPE_COUNTRY)).toBe(true);
    });

    test('an unresolvable scope denies (fails closed)', () => {
        expect(containsScope(null, SCOPE_SITE11)).toBe(false);
        expect(containsScope(SCOPE_SITE11, null)).toBe(false);
        expect(containsScope({ unrestricted: false, employeeIds: null }, SCOPE_SITE11)).toBe(false);
    });

    test('show() and every admin-on-admin write go through the same guard', () => {
        const src = require('fs').readFileSync(
            require.resolve('../../src/controllers/AdminController'),
            'utf8'
        );
        for (const verb of [
            'async show(',
            'async update(',
            'async resetPassword(',
            'async unlockAccount(',
            'async forcePasswordChange(',
            'async extendAccess(',
            'async deactivate(',
            'async reactivate(',
            'async revokeSessions(',
        ]) {
            const start = src.indexOf(verb);
            expect(start).toBeGreaterThan(0);
            const next = src.indexOf('\n    async ', start + 10);
            const body = src.slice(start, next > 0 ? next : src.length);
            expect(body).toMatch(/_denyIfOutOfScope/);
        }
    });

    test('the three identity verbs need no containment check — the service refuses non-SuperAdmins outright', () => {
        // linkSso / unlinkSso / revokeAccess delegate to AccountLinkService, which
        // fails closed on an ADMIN target for anyone but a SuperAdmin — and a
        // SuperAdmin contains every scope by definition.
        const svc = require('fs').readFileSync(
            require.resolve('../../src/services/AccountLinkService'),
            'utf8'
        );
        for (const fn of [
            'async function linkSsoIdentity',
            'async function unlinkSsoIdentity',
            'async function revokeAdminAccess',
        ]) {
            const start = svc.indexOf(fn);
            expect(start).toBeGreaterThan(0);
            expect(svc.slice(start, start + 700)).toMatch(/!_isSuper\(actor\)/);
        }
    });

    test('the refusal is a translated sentence, never a 500 or a blank page', () => {
        const fr = require('../../locales/fr/flash.json');
        const en = require('../../locales/en/flash.json');
        expect(fr.admin_target_out_of_scope).toMatch(/périmètre/);
        expect(en.admin_target_out_of_scope).toMatch(/scope/);
    });
});

describe('Lot C — the console list contract', () => {
    test('sort keys are a closed whitelist (an unknown ?sort falls back)', () => {
        expect(Object.keys(LIST_SORT).sort()).toEqual([
            'expires',
            'lastLogin',
            'profile',
            'role',
            'status',
            'username',
        ]);
        expect(LIST_SORT.lastLogin).toBe('lastLoginAt');
        expect(LIST_SORT.DROP).toBeUndefined();
    });

    test('the export is the screen, scoped: out-of-scope rows are left out', async () => {
        const rows = [
            {
                id: 1,
                username: 'in.scope',
                email: 'a@b.c',
                role: 'localadmin',
                isActive: true,
                locked: false,
                mfaEnrolled: true,
                permCount: 2,
                permissions: ['manage_cycles', 'view_employees'],
                scopeCount: 1,
                scopes: [{ name: 'Site 11' }],
                expiresAt: '2026-12-01T00:00:00.000Z',
                lastExpiredAt: null,
                lastLoginAt: '2026-09-01T08:00:00.000Z',
                deactivatedAt: null,
                deactivationReason: null,
                outOfScope: false,
            },
            {
                id: 2,
                username: 'out.of.scope',
                email: '',
                role: 'localadmin',
                isActive: true,
                locked: true,
                mfaEnrolled: false,
                permCount: 1,
                permissions: ['manage_admins'],
                scopeCount: 1,
                scopes: [{ name: 'Pays' }],
                expiresAt: null,
                lastExpiredAt: null,
                lastLoginAt: null,
                deactivatedAt: null,
                deactivationReason: null,
                outOfScope: true,
            },
        ];
        const r = req({
            id: 631,
            userType: 'admin',
            role: 'localadmin',
            permissions: ['manage_admins'],
        });
        const s = res();
        // exportCsv is pre-bound to the controller singleton, so the list has to
        // be stubbed on the instance, not through `.call()`.
        jest.spyOn(AdminController, '_listRows').mockResolvedValue({ admins: rows });
        await AdminController.exportCsv(r, s);
        const csv = String(s.o.sent);
        expect(csv).toMatch(/in\.scope/);
        expect(csv).not.toMatch(/out\.of\.scope/);
        expect(csv.split(/\r?\n/)[0]).toMatch(/^\uFEFFsep=,/); // Excel-friendly, as every other export
        expect(s.o.headers['Content-Disposition']).toMatch(/admins-\d{4}-\d{2}-\d{2}\.csv/);
    });

    test('the export carries the governance columns the review asks for', async () => {
        const r = req({ id: 1, userType: 'admin', role: 'superadmin' });
        const s = res();
        jest.spyOn(AdminController, '_listRows').mockResolvedValue({ admins: [] });
        await AdminController.exportCsv(r, s);
        const header = String(s.o.sent).split(/\r?\n/)[1];
        // Attestation columns — the fallbacks the controller passes are the FR labels.
        for (const label of [
            'Verrouillé',
            'Expiré le',
            'Dernière connexion',
            'Désactivé le',
            'Motif de désactivation',
        ]) {
            expect(header).toContain(label);
        }
        const fr = require('../../locales/fr/admin.json');
        const en = require('../../locales/en/admin.json');
        for (const key of [
            'adm_csv_locked',
            'adm_csv_expired_on',
            'adm_csv_last_login',
            'adm_csv_deactivated',
            'adm_csv_deactivation_reason',
        ]) {
            expect(typeof fr[key]).toBe('string');
            expect(typeof en[key]).toBe('string');
        }
    });

    test('a caller without manage_admins is refused with a sentence', async () => {
        const r = req({ id: 9, userType: 'admin', role: 'viewer', permissions: [] });
        const s = res();
        await AdminController.exportCsv(r, s);
        expect(s.o.redirects).toEqual(['/dashboard']);
        expect(flashOf(r).join()).toMatch(/admin_manage_denied/);
    });
});

describe('Lot C — "Désactiver" / "Réactiver" demand a reason and keep the grants', () => {
    const superU = { id: 1, userType: 'admin', role: 'superadmin', permissions: [] };
    let AdminModel;
    let AdminPermissionModel;
    let AdminScopeModel;

    beforeEach(() => {
        AdminModel = require('../../src/models/AdminModel');
        AdminPermissionModel = require('../../src/models/AdminPermissionModel');
        AdminScopeModel = require('../../src/models/AdminScopeModel');
        jest.spyOn(AdminModel, 'findById').mockResolvedValue({
            id: 631,
            username: 'qa.local',
            role: 'localadmin',
            isActive: true,
        });
        jest.spyOn(AdminModel, 'update').mockResolvedValue({ changes: 1 });
        jest.spyOn(AdminPermissionModel, 'revokeAllForAdmin').mockResolvedValue([
            { permission: 'manage_cycles' },
            { permission: 'approve_assessments' },
        ]);
        jest.spyOn(AdminScopeModel, 'revokeAllForAdmin').mockResolvedValue([
            { adminId: 631, scopeType: 'site', siteId: 11 },
        ]);
    });

    test('no reason → refused, nothing written', async () => {
        const r = req(superU, { params: { id: '631' }, body: {} });
        const s = res();
        await AdminController.deactivate(r, s);
        expect(flashOf(r).join()).toMatch(/adm_reason_required/);
        expect(AdminPermissionModel.revokeAllForAdmin).not.toHaveBeenCalled();
        expect(AdminModel.update).not.toHaveBeenCalled();
    });

    test('with a reason → rows flagged (not deleted), sessions closed, ledger written', async () => {
        const ledger = require('../../src/services/AccessLedgerService');
        const spy = jest.spyOn(ledger, 'record').mockResolvedValue({ ok: true });
        mockDb.run.mockResolvedValue({ changes: 3 });
        const r = req(superU, {
            params: { id: '631' },
            body: { reason: 'Départ en congé longue durée' },
        });
        const s = res();
        await AdminController.deactivate(r, s);

        expect(AdminPermissionModel.revokeAllForAdmin).toHaveBeenCalledWith(
            631,
            'Départ en congé longue durée'
        );
        expect(AdminModel.update).toHaveBeenCalledWith(
            631,
            expect.objectContaining({
                isActive: 0,
                deactivationReason: 'Départ en congé longue durée',
            })
        );
        const types = spy.mock.calls.map((c) => c[0].changeType);
        expect(types).toEqual(['revoke', 'revoke', 'scope_removed', 'deactivated']);
        expect(spy.mock.calls.every((c) => c[0].reason === 'Départ en congé longue durée')).toBe(
            true
        );
        expect(String(mockDb.run.mock.calls.map((c) => c[0]).join(' '))).toMatch(/session/i); // sessions revoked
        expect(flashOf(r).join()).toMatch(/adm_deactivated/);
        spy.mockRestore();
    });

    test('deactivating your own account is refused', async () => {
        const r = req({ ...superU, id: 631 }, { params: { id: '631' }, body: { reason: 'x' } });
        const s = res();
        await AdminController.deactivate(r, s);
        expect(flashOf(r).join()).toMatch(/admin_delete_self/);
    });

    test('/admins/:id/delete is the SAME action (no hard delete left)', async () => {
        const spy = jest.spyOn(AdminController, 'deactivate').mockResolvedValue(undefined);
        const r = req(superU, { params: { id: '631' }, body: { reason: 'x' } });
        await AdminController.delete(r, res());
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('Lot C — MFA reset is SuperAdmin-only, reasoned and audited', () => {
    test('a localadmin holding manage_admins is refused', async () => {
        const r = req(
            { id: 631, userType: 'admin', role: 'localadmin', permissions: ['manage_admins'] },
            { params: { id: '69' }, body: { reason: 'lost phone' } }
        );
        const s = res();
        await AdminController.resetMfa(r, s);
        expect(flashOf(r).join()).toMatch(/adm_mfa_reset_denied/);
        expect(s.o.redirects).toEqual(['/admins/69']);
    });

    test('a SuperAdmin without a reason is refused too', async () => {
        const AdminModel = require('../../src/models/AdminModel');
        jest.spyOn(AdminModel, 'findById').mockResolvedValue({
            id: 69,
            username: 'peer',
            role: 'localadmin',
            isActive: true,
        });
        const MfaService = require('../../src/services/MfaService');
        const spy = jest
            .spyOn(MfaService, 'adminReset')
            .mockResolvedValue({ hadSecret: true, backupCodesRemoved: 0 });
        const r = req(
            { id: 1, userType: 'admin', role: 'superadmin' },
            { params: { id: '69' }, body: {} }
        );
        await AdminController.resetMfa(r, res());
        expect(flashOf(r).join()).toMatch(/adm_reason_required/);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
