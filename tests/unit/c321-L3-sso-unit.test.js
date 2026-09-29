'use strict';
/**
 * 3.23.21 lane L3 — behavioural unit tests (mocked database):
 *   UX-1  a saved SAML connection is registered for the TEST sign-in while the
 *         master switch is off — never listed, never enforced, and its verify
 *         refuses every non-test response; the SSO page save refuses switching
 *         SSO on without the readiness confirmation;
 *   UX-3/UX-4  the sign-in refusals say whom to contact;
 *   UX-11 the invitation: EN plain text uses ':' (FR ' :'), the step quotes the
 *         button's own text, « Un problème ? Contactez … »;
 *   ANN   go-live parsing and the 48 h default lead (24-168);
 *   F10   during an SSO migration, a request matching an existing account is
 *         attached by default — creating a new account needs an explicit tick.
 */
const mockSettings = {};
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) =>
        Object.prototype.hasOwnProperty.call(mockSettings, k) ? mockSettings[k] : d
    ),
    setValue: jest.fn(async (k, v) => {
        mockSettings[k] = v;
    }),
}));

const SAML_ENV = {
    SAML_ENTRY_POINT: 'https://idp.example.test/sso',
    SAML_ISSUER: 'https://sp.example.test',
    SAML_CALLBACK_URL: 'https://sp.example.test/auth/sso/saml/callback',
    SAML_IDP_CERT: 'MIIBszCCAVmgAwIBAgIJAKx',
};

beforeEach(() => {
    for (const k of Object.keys(mockSettings)) delete mockSettings[k];
});

describe('UX-1 — test sign-in before activation', () => {
    const passport = require('passport');
    const sso = require('../../src/config/sso');
    const saved = {};
    beforeAll(() => {
        for (const [k, v] of Object.entries({ ...SAML_ENV, SSO_ENABLED: '0' })) {
            saved[k] = process.env[k];
            process.env[k] = v;
        }
    });
    afterAll(() => {
        for (const [k, v] of Object.entries(saved))
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        sso.configureSso(passport);
    });

    test('switch OFF: the saved connection is test-only — no button, not enforced, not a sign-in provider', () => {
        process.env.SSO_ENABLED = '0';
        expect(sso.configureSso(passport)).toEqual([]);
        expect(sso.getEnabledProviders()).toEqual([]);
        expect(sso.getProvider('saml')).toBeNull();
        expect(sso.getTestProvider('saml')).toMatchObject({ key: 'saml', testOnly: true });
        expect(sso.isSsoIntended()).toBe(false);
    });

    test('switch OFF: its verify refuses ANY response that is not a test sign-in (before any check)', async () => {
        process.env.SSO_ENABLED = '0';
        sso.configureSso(passport);
        const st = passport._strategy('sso-saml');
        for (const body of [{}, { RelayState: '/dashboard' }]) {
            const out = await new Promise((resolve) =>
                st._signonVerify({ body }, { nameID: 'a@b.test', issuer: 'x' }, (e, u, i) =>
                    resolve([e, u, i])
                )
            );
            expect(out[0]).toBeNull();
            expect(out[1]).toBe(false);
            expect(out[2].code).toBe('sso_switch_off');
        }
    });

    test('switch ON: a normal provider again (the test-only mode is gone)', () => {
        process.env.SSO_ENABLED = '1';
        expect(sso.configureSso(passport)).toEqual(['saml']);
        expect(sso.getProvider('saml')).toBeTruthy();
        expect(sso.getProvider('saml').testOnly).toBeUndefined();
    });

    test('the callback never routes a NON-test response to the test-only provider', () => {
        process.env.SSO_ENABLED = '0';
        sso.configureSso(passport);
        const SsoController = require('../../src/controllers/SsoController');
        const spy = jest.spyOn(passport, 'authenticate');
        const res = { redirect: jest.fn() };
        SsoController.callback(
            { params: { provider: 'saml' }, body: { RelayState: '/dashboard' }, query: {} },
            res,
            jest.fn()
        );
        expect(res.redirect).toHaveBeenCalledWith('/login');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('saving the SSO page with the switch turned ON requires the readiness confirmation', async () => {
        const S = require('../../src/services/SsoSettingsService');
        mockSettings['sso.enabled'] = false;
        await expect(S.save({ enabled: '1', enforceGate: '1' }, 1)).rejects.toMatchObject({
            code: 'sso_enable_confirm_required',
        });
        expect(mockSettings['sso.enabled']).toBe(false); // nothing written
        await S.save({ enabled: '1', enforceGate: '1', confirmEnforce: '1' }, 1);
        expect(mockSettings['sso.enabled']).toBe(true);
        // already on → no confirmation asked again
        await S.save({ enabled: '1', enforceGate: '1' }, 1);
        expect(mockSettings['sso.enabled']).toBe(true);
    });

    test('the confirmation is required on EVERY path, not only when the page marks its form', async () => {
        const S = require('../../src/services/SsoSettingsService');
        mockSettings['sso.enabled'] = false;
        await expect(S.save({ enabled: '1' }, 1)).rejects.toMatchObject({
            code: 'sso_enable_confirm_required',
        });
        expect(mockSettings['sso.enabled']).toBe(false);
    });

    test('ANN — the go-live date is validated before anything is written; the lead is clamped', async () => {
        const S = require('../../src/services/SsoSettingsService');
        await expect(S.save({ goLiveAt: '2026-02-31T08:00' }, 1)).rejects.toMatchObject({
            code: 'sso_golive_invalid',
        });
        expect(mockSettings['sso.enabled']).toBeUndefined();
        await S.save({ goLiveAt: '2026-10-12 08:30', announceLeadHours: '500' }, 1);
        expect(mockSettings['sso.goLiveAt']).toBe('2026-10-12T08:30');
        expect(mockSettings['sso.announceLeadHours']).toBe(168);
        expect(mockSettings.ssoDisablesLocalPassword).toBeUndefined(); // UX-2: no longer written
    });
});

describe('ANN — planning', () => {
    const Inv = require('../../src/services/SsoInviteService');
    test('48 h by default, 24-168', async () => {
        expect(Inv.clampLeadHours(undefined)).toBe(48);
        expect(Inv.clampLeadHours('3')).toBe(24);
        expect(Inv.clampLeadHours(1000)).toBe(168);
        mockSettings['sso.goLiveAt'] = '2026-10-12T08:00';
        const p = await Inv.announcementPlan();
        expect(p.leadHours).toBe(48);
        expect(p.goLiveAt.getTime() - p.dueAt.getTime()).toBe(48 * 3600 * 1000);
    });
    test('the notice: FR first, the date, the provider, only a /login link, never a password', () => {
        const m = Inv.composeAnnouncement({
            rec: { firstName: 'Awa' },
            provider: 'Contoso',
            goLiveAt: new Date(2026, 9, 12, 0, 0),
            contact: 'le support RH',
            app: 'MonApp',
            url: 'https://app.example.test',
        });
        expect(m.subject).toBe(
            '[MonApp] À partir du 12 octobre 2026 : connexion avec votre compte Contoso / [MonApp] From 12 October 2026: sign in with your Contoso account'
        );
        expect(m.text.indexOf('Bonjour Awa')).toBe(0);
        expect(m.text).toMatch(
            /À partir du 12 octobre 2026, vous vous connecterez à MonApp avec votre compte Contoso/
        );
        expect(m.text).toMatch(/Un problème \? Contactez le support RH\./);
        const links = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
        expect(links).toEqual(['https://app.example.test/login']);
        expect(m.html).not.toMatch(/token|reset-password/i);
    });
});

describe('UX-11 — the invitation text', () => {
    const Inv = require('../../src/services/SsoInviteService');
    const m = Inv.compose({
        rec: { type: 'employee', isAdmin: false, firstName: 'Awa' },
        provider: 'Contoso',
        variant: 'standard',
        upn: null,
        contact: null,
        app: 'MonApp',
        url: 'https://app.example.test',
        buttons: { fr: 'Se connecter avec Contoso', en: 'Sign in with Contoso' },
    });
    const [fr, en] = m.text.split('\n\n----\n\n');
    test("EN uses ':' with no space before it; FR keeps ' :'", () => {
        expect(fr).toMatch(/^Avantages : /m);
        expect(fr).toMatch(/^Comment faire :$/m);
        expect(en).toMatch(/^Benefits: /m);
        expect(en).toMatch(/^How to sign in:$/m);
        expect(en).not.toMatch(/ :/);
    });
    test('step 2 quotes the button text itself (never « Se connecter avec Sign in with … »)', () => {
        expect(fr).toMatch(/2\. Cliquez « Se connecter avec Contoso »\./);
        expect(en).toMatch(/2\. Click “Sign in with Contoso”\./);
        expect(m.text).not.toMatch(/with Sign in with|avec Sign in/);
    });
    test('the help line says « Contactez »', () => {
        expect(fr).toMatch(/Un problème \? Contactez votre administrateur\./);
        expect(en).toMatch(/A problem\? Contact your administrator\./);
    });
    test('providerLabel reduces a button phrase to the name', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/config/sso', () => ({
                getEnabledProviders: () => [{ key: 'saml', label: 'Sign in with Contoso' }],
                getTestProvider: () => null,
            }));
            const I = require('../../src/services/SsoInviteService');
            expect(I.providerLabel('saml')).toBe('Contoso');
        });
    });
});

describe('UX-3 / UX-4 — the sign-in refusals say whom to contact', () => {
    test('generic refusal and technical failure carry {{app}} and {{contact}}', async () => {
        mockSettings['sso.helpContact'] = 'le support RH (poste 1234)';
        const SsoController = require('../../src/controllers/SsoController');
        const flashes = [];
        const req = { flash: (t, m) => flashes.push([t, m]), session: {}, get: () => '', ip: '1' };
        const res = { redirect: jest.fn() };
        // an expired chooser → the generic refusal path (deny)
        await SsoController.submitChoice(req, res);
        expect(res.redirect).toHaveBeenCalledWith('/login');
        expect(flashes[0][1]).toMatch(
            /^La connexion n’a pas abouti\. Votre accès n’est peut-être pas \(ou plus\) ouvert dans .+\. Contactez le support RH \(poste 1234\) en indiquant l’heure de la tentative\.$/
        );
    });
});

describe('F10 — onboarding during an SSO migration: attach by default', () => {
    test('a request matching an existing account is NOT turned into a new account without the explicit tick', async () => {
        jest.isolateModules(() => {});
        const OnboardingService = require('../../src/services/OnboardingService');
        const AccountLinkService = require('../../src/services/AccountLinkService');
        const Req = require('../../src/models/OnboardingRequestModel');
        const RBAC = require('../../src/services/RBACService');
        jest.spyOn(OnboardingService, 'isSsoMigrationRunning').mockResolvedValue(true);
        const approve = jest.spyOn(OnboardingService, 'approve').mockResolvedValue({ ok: true });
        jest.spyOn(Req, 'findById').mockResolvedValue({
            id: 5,
            source: 'sso',
            email: 'a@corp.test',
            authProvider: 'saml',
            externalId: 'x',
        });
        jest.spyOn(AccountLinkService, 'findLinkCandidates').mockResolvedValue({
            admins: [],
            employees: [{ id: 9 }],
        });
        jest.spyOn(RBAC, 'isSuperAdmin').mockReturnValue(true);
        const C = require('../../src/controllers/OnboardingController');
        const flashes = [];
        const mk = (body) => ({
            params: { id: '5' },
            body: { siteId: '1', departmentId: '1', serviceId: '1', roleId: '1', ...body },
            user: { id: 1, role: 'superadmin', userType: 'admin' },
            session: {},
            flash: (t, m) => flashes.push([t, m]),
        });
        const res = { redirect: jest.fn() };
        await C.approve(mk({}), res);
        expect(approve).not.toHaveBeenCalled();
        expect(flashes[0][0]).toBe('error');
        await C.approve(mk({ createAnyway: '1' }), res);
        expect(approve).toHaveBeenCalledTimes(1);
    });
});
