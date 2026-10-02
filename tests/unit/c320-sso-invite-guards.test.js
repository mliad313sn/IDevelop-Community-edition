'use strict';
/**
 * 3.23.20 — Amendment C3/C4 guards and C2c/C2f behaviours, database faked:
 *   - the SSO invitation content (compose): FR first, EN after; the only link is
 *     <base>/login; the company login when known; the admin block only for an
 *     admin; the security notice for an e-mail-matched first sign-in; « we will
 *     never ask for your password »;
 *   - issueAndSend is never reachable from the invitation path (source guard) and
 *     REFUSES a migrated account (behaviour); the console's « resend » on a
 *     migrated account re-queues the SSO invitation instead of a password;
 *   - SuperadminAlertService: every active SuperAdmin, category 'security',
 *     hourly de-duplication;
 *   - peer MFA reset: never your own; a SuperAdmin target raises the alert;
 *   - a SuperAdmin cannot switch its own MFA off.
 */
const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
const mockLogs = [];
jest.mock('../../src/services/LogService', () => ({
    log: jest.fn(async (e) => {
        mockLogs.push(e);
    }),
}));

beforeEach(() => {
    mockLogs.length = 0;
    mockDb.get.mockReset().mockResolvedValue(null);
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
});

describe('C3e — the invitation content', () => {
    const Inv = require('../../src/services/SsoInviteService');
    const base = {
        provider: 'Contoso',
        variant: 'standard',
        upn: 'awa.silva@contoso.example',
        contact: 'le support RH (poste 1234)',
        app: 'MonApp',
        url: 'https://app.example.test',
    };
    const emp = { type: 'employee', isAdmin: false, firstName: 'Awa', name: 'Awa Silva' };

    test('FR first, EN after; only a /login link; UPN; never-a-password line; contact', () => {
        const m = Inv.compose({ ...base, rec: emp });
        expect(m.subject).toBe(
            '[MonApp] Connectez-vous avec votre compte Contoso / Sign in with your Contoso account'
        );
        const links = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
        expect(links).toEqual(['https://app.example.test/login']);
        expect(m.text.indexOf('Bonjour Awa')).toBe(0);
        expect(m.text.indexOf('Hello Awa')).toBeGreaterThan(m.text.indexOf('Bonjour Awa'));
        expect(m.text).toMatch(
            /Saisissez votre identifiant d’entreprise : awa\.silva@contoso\.example/
        );
        expect(m.text).toMatch(/Nous ne vous demanderons jamais votre mot de passe par e-mail/);
        expect(m.text).toMatch(/We will never ask for your password by e-mail/);
        expect(m.text).toMatch(/Un problème \? Contactez le support RH \(poste 1234\)/);
        expect(m.text).toMatch(/Poste partagé/);
        expect(m.text).not.toMatch(/Compte administrateur/);
        expect(m.html).not.toMatch(/token|reset-password|mot de passe temporaire/i);
    });

    test('an admin gets the second-factor block; a first e-mail match gets the security notice', () => {
        const a = Inv.compose({ ...base, rec: { ...emp, type: 'admin', isAdmin: true } });
        // The local code is asked only when the company sign-in did not already
        // prove a second factor (AdminSsoService.mfaFromEvidence).
        expect(a.text).toMatch(
            /Compte administrateur : si votre connexion d’entreprise ne vous a pas déjà demandé une seconde vérification .*un code à 6 chiffres/
        );
        const s = Inv.compose({ ...base, variant: 'security_notice', rec: emp });
        expect(s.text).toMatch(/Si ce n’est pas vous, contactez immédiatement le support RH/);
    });

    test('no contact configured → « votre administrateur »; no UPN → the generic step', () => {
        const m = Inv.compose({ ...base, contact: null, upn: null, rec: emp });
        expect(m.text).toMatch(/Un problème \? Contactez votre administrateur\./);
        expect(m.text).toMatch(/Saisissez votre identifiant d’entreprise habituel/);
    });

    test('the FR and EN texts have the same keys (locale parity)', () => {
        const fr = require('../../locales/fr/auth.json');
        const en = require('../../locales/en/auth.json');
        const k = (o) =>
            Object.keys(o)
                .filter((x) => /^(ssoinv_|login_sso_first_help|login_sso_not_linked)/.test(x))
                .sort();
        expect(k(fr)).toEqual(k(en));
        expect(k(fr).length).toBeGreaterThan(20);
    });
});

describe('C3 — never a password for an SSO-migrated account', () => {
    test('source guard: the invitation path never reaches issueAndSend nor invited_at (code, comments stripped)', () => {
        const { flat } = require('../helpers/flatSource');
        const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        for (const f of ['src/services/SsoInviteService.js', 'src/jobs/sso-invites.js']) {
            const code = flat(strip(fs.readFileSync(path.join(__dirname, '../..', f), 'utf8')));
            expect(code).not.toMatch(
                /issueAndSend|OnboardingCredentialService|invited_at|invitedAt|passwordHash|password_hash/
            );
        }
    });

    test('issueAndSend REFUSES a migrated account — nothing hashed, nothing written, nothing sent', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        jest.doMock('../../src/services/SsoInviteService', () => ({
            isMigrated: jest.fn(async () => true),
        }));
        const update = jest.fn();
        jest.doMock('../../src/models/EmployeeModel', () => ({
            findById: jest.fn(async () => ({
                id: 9,
                isActive: true,
                isAccountActive: true,
                email: 'x@y.test',
                employeeNumber: 'E9',
            })),
            update,
        }));
        const send = jest.fn();
        jest.doMock('../../src/services/EmailService', () => ({ send }));
        const Cred = require('../../src/services/OnboardingCredentialService');
        const r = await Cred.issueAndSend(9, { id: 1, userType: 'admin' }, null, { welcome: true });
        expect(r).toEqual(
            expect.objectContaining({ success: false, code: 'sso_migrated_no_password' })
        );
        expect(update).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        jest.dontMock('../../src/services/SsoInviteService');
        jest.dontMock('../../src/models/EmployeeModel');
        jest.dontMock('../../src/services/EmailService');
    });

    test('the Accounts console « resend » on a migrated account re-queues the SSO invitation, never a password', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        const requeue = jest.fn(async () => ({ ok: true }));
        jest.doMock('../../src/services/SsoInviteService', () => ({
            isMigrated: jest.fn(async () => true),
            requeue,
        }));
        const issue = jest.fn();
        jest.doMock('../../src/services/OnboardingCredentialService', () => ({
            issueAndSend: issue,
        }));
        jest.doMock('../../src/models/EmployeeModel', () => ({
            findById: jest.fn(async () => ({ id: 9, isActive: true })),
        }));
        const Ctl = require('../../src/controllers/InvitationController');
        const req = {
            user: { id: 1, userType: 'admin', role: 'superadmin' },
            ip: '1',
            get: () => 'jest',
            id: null,
        };
        const r = await Ctl._apply('resend', 9, req, { welcome: true, policy: 'any' });
        expect(r).toEqual({ ok: true, ssoQueued: true });
        expect(requeue).toHaveBeenCalledWith('employee', 9, req.user);
        expect(issue).not.toHaveBeenCalled();
        jest.dontMock('../../src/services/SsoInviteService');
        jest.dontMock('../../src/services/OnboardingCredentialService');
        jest.dontMock('../../src/models/EmployeeModel');
    });
});

describe('C2f — SuperadminAlertService', () => {
    test('every active SuperAdmin, category security; a repeated refusal is raised once an hour', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        const notify = jest.fn(async () => ({ inapp: 'queued' }));
        jest.doMock('../../src/services/NotificationService', () => ({ notify }));
        let first = true;
        jest.doMock('../../src/jobs/reminders', () => ({
            claim: jest.fn(async () => {
                const r = first;
                first = false;
                return r;
            }),
        }));
        mockDb.all.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        const A = require('../../src/services/SuperadminAlertService');
        const n1 = await A.alert('security.superadmin_sso_refused', {
            targetAdminId: 8,
            hourly: true,
        });
        const n2 = await A.alert('security.superadmin_sso_refused', {
            targetAdminId: 8,
            hourly: true,
        });
        expect(n1).toBe(2);
        expect(n2).toBe(0);
        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                userType: 'admin',
                userId: 1,
                category: 'security',
                kind: 'security.superadmin_sso_refused',
            })
        );
        // an unknown kind is never sent
        expect(await A.alert('security.whatever', {})).toBe(0);
        // security Low 1: a ledger ERROR counts as a duplicate — nothing sent
        const R = require('../../src/jobs/reminders');
        R.claim.mockRejectedValueOnce(new Error('ledger down'));
        expect(
            await A.alert('security.superadmin_sso_refused', { targetAdminId: 9, hourly: true })
        ).toBe(0);
        expect(notify).toHaveBeenCalledTimes(2);
        jest.dontMock('../../src/services/NotificationService');
        jest.dontMock('../../src/jobs/reminders');
    });
});

describe('C2c — peer MFA reset; C2 — a SuperAdmin cannot switch MFA off', () => {
    function reqRes(user, id) {
        const req = {
            params: { id: String(id) },
            body: { reason: 'lost phone' },
            user,
            ip: '1',
            sessionID: 's',
            get: () => 'jest',
            flashes: [],
            flash(t, m) {
                this.flashes.push([t, m]);
            },
            t: null,
        };
        const res = {
            to: null,
            redirect(u) {
                this.to = u;
            },
        };
        return { req, res };
    }

    test('resetting your OWN MFA is refused; a peer SuperAdmin target is reset and alerted', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        const adminReset = jest.fn(async () => ({ hadSecret: true, backupCodesRemoved: 3 }));
        jest.doMock('../../src/services/MfaService', () => ({ adminReset }));
        const alert = jest.fn(async () => 1);
        jest.doMock('../../src/services/SuperadminAlertService', () => ({ alert }));
        jest.doMock('../../src/models/AdminModel', () => ({
            findById: jest.fn(async (id) => ({
                id: Number(id),
                username: `sa${id}`,
                role: 'superadmin',
            })),
        }));
        const AdminController = require('../../src/controllers/AdminController');
        const me = { id: 1, userType: 'admin', role: 'superadmin', username: 'sa1' };
        const self = reqRes(me, 1);
        await AdminController.resetMfa(self.req, self.res);
        expect(adminReset).not.toHaveBeenCalled();
        expect(mockLogs.some((l) => l.action === 'MFA_RESET_REFUSED')).toBe(true);
        const peer = reqRes(me, 2);
        await AdminController.resetMfa(peer.req, peer.res);
        expect(adminReset).toHaveBeenCalledWith({ userType: 'admin', userId: 2 });
        expect(alert).toHaveBeenCalledWith(
            'security.superadmin_mfa_changed',
            expect.objectContaining({ targetAdminId: 2 })
        );
        jest.dontMock('../../src/services/MfaService');
        jest.dontMock('../../src/services/SuperadminAlertService');
        jest.dontMock('../../src/models/AdminModel');
    });

    test('POST /v2/uam/mfa/disable is refused for a SuperAdmin (with or without SSO); a local admin may', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        const disable = jest.fn(async () => {});
        jest.doMock('../../src/services/MfaService', () => ({
            mfaUserType: () => 'admin',
            verifyAtLogin: jest.fn(async () => true),
            consumeBackupCode: jest.fn(async () => false),
            disable,
        }));
        jest.doMock('../../src/services/AdminSsoService', () => ({
            isEnforced: () => false,
            isActiveSuperadmin: (u) => !!u && u.userType === 'admin' && u.role === 'superadmin',
        }));
        const express = require('express');
        const request = require('supertest');
        const mk = (user) => {
            const app = express();
            app.use(express.urlencoded({ extended: false }));
            app.use((req, _res, next) => {
                req.user = user;
                req.isAuthenticated = () => true;
                req.session = {};
                req.flash = () => {};
                next();
            });
            app.use('/v2/uam', require('../../src/routes/v2-uam'));
            return app;
        };
        const sa = await request(
            mk({ id: 1, userType: 'admin', role: 'superadmin', username: 'root' })
        )
            .post('/v2/uam/mfa/disable')
            .type('form')
            .send({ code: '123456' });
        expect(sa.status).toBe(302);
        expect(disable).not.toHaveBeenCalled();
        const la = await request(
            mk({ id: 7, userType: 'admin', role: 'localadmin', username: 'ops' })
        )
            .post('/v2/uam/mfa/disable')
            .type('form')
            .send({ code: '123456' });
        expect(la.status).toBe(302);
        expect(disable).toHaveBeenCalledTimes(1);
        jest.dontMock('../../src/services/MfaService');
        jest.dontMock('../../src/services/AdminSsoService');
    });
});
