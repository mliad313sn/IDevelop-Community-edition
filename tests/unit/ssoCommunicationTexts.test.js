'use strict';
/**
 * The SSO migration communication (port item S2), database faked:
 *   1. the in-app notice is not empty: the announcement carries its date, the
 *      invitation its provider; it opens /account/sso-change (even a notice
 *      stored with '/login' before the change);
 *   3. the admin paragraph: the local 6-digit code only when the company sign-in
 *      did not already ask for a second verification;
 *   4. « le même que pour Windows ou Outlook » only for Microsoft (entra or a
 *      provider named Microsoft); SAML/OIDC/Google get the neutral sentence;
 *   5. the bare 'SSO' fallback never lands in a sentence;
 *   6. the benefits sentence no longer contradicts itself;
 *   7. the reminder prefixes BOTH halves of the subject;
 *   + the signed-in page shows the SAME sentences as the e-mail.
 */
const mockDb = {
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
// No provider registered: providerLabel falls back to the key map.
jest.mock('../../src/config/sso', () => ({
    getEnabledProviders: () => [],
    getTestProvider: () => null,
}));

const Inv = require('../../src/services/SsoInviteService');
const NotificationService = require('../../src/services/NotificationService');

const base = {
    variant: 'standard',
    upn: null,
    contact: 'le support RH',
    app: 'MonApp',
    url: 'https://app.example.test',
};
const emp = { type: 'employee', isAdmin: false, firstName: 'Sam', name: 'Sam Rivera' };
const admin = { ...emp, type: 'admin', isAdmin: true };
const split = (m) => m.text.split('\n\n----\n\n');
const GO = new Date(2026, 9, 12, 0, 0);

describe('4 — the Windows/Outlook sentence is Microsoft-only', () => {
    test('entra (Microsoft): FR and EN say Windows or Outlook', () => {
        const m = Inv.compose({ ...base, rec: emp, provider: 'Microsoft', providerKey: 'entra' });
        const [fr, en] = split(m);
        expect(fr).toMatch(
            /avec votre compte Microsoft, le même que pour Windows ou Outlook\. Votre ancien mot de passe MonApp ne sert plus\./
        );
        expect(en).toMatch(
            /with your Microsoft account, the same one you use for Windows or Outlook/
        );
    });
    test('a provider NAMED Microsoft on a SAML key is Microsoft too', () => {
        const m = Inv.compose({ ...base, rec: emp, provider: 'Microsoft', providerKey: 'saml' });
        expect(m.text).toMatch(/Windows ou Outlook/);
    });
    test.each([
        ['saml', 'Contoso'],
        ['oidc', 'Okta'],
        ['google', 'Google'],
    ])('%s (%s): the neutral sentence, never Windows', (key, name) => {
        const m = Inv.compose({ ...base, rec: emp, provider: name, providerKey: key });
        const [fr, en] = split(m);
        expect(m.text).not.toMatch(/Windows|Outlook/);
        expect(m.html).not.toMatch(/Windows|Outlook/);
        expect(fr).toMatch(
            new RegExp(
                `avec votre compte ${name}, celui que vous utilisez déjà pour vos autres outils de travail`
            )
        );
        expect(en).toMatch(
            new RegExp(
                `with your ${name} account, the one you already use for your other work tools`
            )
        );
    });
    test('the announcement follows the same rule', () => {
        const ms = Inv.composeAnnouncement({
            rec: emp,
            provider: 'Microsoft',
            providerKey: 'entra',
            goLiveAt: GO,
            contact: null,
            app: 'MonApp',
            url: 'https://app.example.test',
        });
        expect(ms.text).toMatch(
            /À partir du 12 octobre 2026, vous vous connecterez à MonApp avec votre compte Microsoft, le même que pour Windows ou Outlook\./
        );
        const g = Inv.composeAnnouncement({
            rec: emp,
            provider: 'Google',
            providerKey: 'google',
            goLiveAt: GO,
            contact: null,
            app: 'MonApp',
            url: 'https://app.example.test',
        });
        expect(g.text).not.toMatch(/Windows|Outlook/);
        expect(g.text).toMatch(/avec votre compte Google, celui que vous utilisez déjà/);
        // 8 — until the date nothing changes; whom to contact.
        expect(g.text).toMatch(/D’ici là, rien ne change\./);
        expect(g.text).toMatch(/Un problème \? Contactez votre administrateur\./);
    });
});

describe('5 — the bare « SSO » fallback never lands in a sentence', () => {
    test('invitation, announcement, security notice: « votre compte d’entreprise »', () => {
        const m = Inv.compose({
            ...base,
            rec: emp,
            variant: 'security_notice',
            provider: Inv.providerLabel('saml'), // 'SSO' — nothing configured
            providerKey: 'saml',
        });
        expect(Inv.providerLabel('saml')).toBe('SSO');
        const all = `${m.subject}\n${m.text}\n${m.html}`;
        expect(all).not.toMatch(/compte (d’entreprise )?SSO|SSO account|SSO company/);
        expect(m.subject).toBe(
            '[MonApp] Connectez-vous avec votre compte d’entreprise / Sign in with your company account'
        );
        expect(m.text).toMatch(/avec votre compte d’entreprise, celui que vous utilisez déjà/);
        expect(m.text).toMatch(/Lors d’une première connexion, votre compte d’entreprise vient/);
        // the button falls back to the organisation wording, not « Se connecter avec SSO »
        expect(m.text).toMatch(/Cliquez « Se connecter avec le compte de votre organisation »/);
        const a = Inv.composeAnnouncement({
            rec: emp,
            provider: 'SSO',
            providerKey: 'oidc',
            goLiveAt: GO,
            contact: null,
            app: 'MonApp',
            url: '',
        });
        expect(a.subject).toMatch(
            /connexion avec votre compte d’entreprise \/ .*sign in with your company account$/
        );
    });
});

describe('3 / 6 / 7 — admin paragraph, benefits, reminder subject', () => {
    test('3 — the admin paragraph: the local code only if no second verification was asked', () => {
        const [fr, en] = split(
            Inv.compose({ ...base, rec: admin, provider: 'Contoso', providerKey: 'saml' })
        );
        expect(fr).toMatch(
            /Compte administrateur : si votre connexion d’entreprise ne vous a pas déjà demandé une seconde vérification \(un code, ou une validation sur votre téléphone\), un code à 6 chiffres vous sera ensuite demandé/
        );
        expect(en).toMatch(
            /if your company sign-in did not already ask you for a second verification .*you will then be asked for a 6-digit code/
        );
        expect(fr).not.toMatch(/après la connexion Contoso, un code/);
    });
    test('6 — benefits: one password, the company one; no more app password', () => {
        const [fr, en] = split(Inv.compose({ ...base, rec: emp, provider: 'Contoso' }));
        expect(fr).toMatch(
            /^Avantages : Un seul mot de passe : celui de votre compte d’entreprise\. Plus de mot de passe MonApp à retenir ni à réinitialiser, et une connexion mieux protégée\.$/m
        );
        expect(fr).not.toMatch(/rien à retenir/);
        expect(en).toMatch(
            /^Benefits: One password only: your company account’s\. No MonApp password to remember or reset any more, and a better-protected sign-in\.$/m
        );
    });
    test('7 — the reminder prefixes both halves of the subject', () => {
        const m = Inv.compose({ ...base, rec: emp, provider: 'Contoso', reminder: true });
        expect(m.subject).toBe(
            'Rappel : [MonApp] Connectez-vous avec votre compte Contoso / Reminder: Sign in with your Contoso account'
        );
    });
});

describe('the page shows the same sentences as the e-mail', () => {
    test('invitation: every page sentence is in the e-mail text, in order, no sign-in button', () => {
        const m = Inv.compose({
            ...base,
            rec: admin,
            provider: 'Microsoft',
            providerKey: 'entra',
            upn: 'sam@corp.test',
        });
        for (const lang of ['fr', 'en']) {
            const p = m.page[lang];
            const txt = split(m)[lang === 'fr' ? 0 : 1];
            expect(txt.startsWith(p.hello)).toBe(true);
            const sentences = p.blocks.flatMap((b) => (b.t === 'steps' ? b.items : [b.text]));
            expect(sentences.length).toBeGreaterThan(8);
            let at = 0;
            for (const s of sentences) {
                const i = txt.indexOf(s, at);
                expect({ s, found: i >= 0 }).toEqual({ s, found: true });
                at = i;
            }
            expect(p.blocks.some((b) => b.t === 'cta')).toBe(false);
        }
        expect(m.page.fr.heading).toBe('Nouvelle connexion');
        expect(m.page.fr.blocks.find((b) => b.t === 'steps').items[2]).toBe(
            'Saisissez votre identifiant d’entreprise : sam@corp.test, puis votre mot de passe.'
        );
    });
    test('announcement: the page carries the date', () => {
        const m = Inv.composeAnnouncement({
            rec: emp,
            provider: 'Microsoft',
            providerKey: 'entra',
            goLiveAt: new Date(2026, 9, 1, 8, 30),
            contact: null,
            app: 'MonApp',
            url: 'https://app.example.test',
        });
        expect(m.page.fr.heading).toBe('Bientôt : nouvelle connexion');
        expect(m.page.fr.blocks[0].text).toBe(
            'À partir du 1er octobre 2026 à 08:30, vous vous connecterez à MonApp avec votre compte Microsoft, le même que pour Windows ou Outlook.'
        );
        expect(m.page.en.blocks[0].text).toMatch(/^From 1 October 2026 at 08:30, /);
    });
});

describe('1 — the in-app notice: subtitle + signed-in link', () => {
    const row = (payload) => ({ id: 1, kind: 'sso.migration_invite', payload, readAt: null });
    test('announcement → « à partir du <date> », locale-aware', () => {
        const p = {
            link: '/account/sso-change',
            provider: 'entra',
            variant: 'announce',
            goLiveAt: GO.toISOString(),
        };
        const fr = NotificationService.present(row(p), 'fr');
        expect(fr.title).toBe(
            'Connexion avec votre compte d’entreprise : ce qui change — à partir du 12 octobre 2026'
        );
        expect(NotificationService.present(row(p), 'en').title).toBe(
            'Signing in with your company account: what changes — from 12 October 2026'
        );
    });
    test('invitation → the provider name; the bare « SSO » fallback → no subtitle', () => {
        expect(
            NotificationService.present(row({ provider: 'entra', variant: 'standard' }), 'fr').title
        ).toBe('Connexion avec votre compte d’entreprise : ce qui change — Microsoft');
        expect(
            NotificationService.present(row({ provider: 'saml', variant: 'standard' }), 'fr').title
        ).toBe('Connexion avec votre compte d’entreprise : ce qui change');
    });
    test('opens /account/sso-change, also a notice stored with /login before the change', () => {
        const old = NotificationService.present(
            row({ link: '/login', provider: 'entra', variant: 'announce' }),
            'fr'
        );
        expect(old.link).toBe('/account/sso-change');
        expect(Inv.SSO_CHANGE_PATH).toBe('/account/sso-change');
    });
});
