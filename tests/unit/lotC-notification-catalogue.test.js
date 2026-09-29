'use strict';
/**
 * SECTION access — UAT3 E-03 / M-05 : le catalogue de notifications.
 *
 * Mesuré avant correction, par exécution, sur idevelop (serveur :3183) :
 *   - `/notifications` en session `uat.employee` rendait
 *     <span class="notif-title">sa.cancelled</span> et
 *     « sa.change_request_granted », À L'IDENTIQUE en FR et en EN — absence de
 *     libellé, pas trou de traduction ;
 *   - en session `uat.manager`, « sa.change_request_raised » ×6 et
 *     « talent.task.created » ×3 à côté de titres traduits ;
 *   - le motif « Saisie faite sur le mauvais collaborateur. », présent dans le
 *     payload de la notification 1299, n'apparaissait dans AUCUNE des deux
 *     langues (reasonInHtml=false) ;
 *   - le sélecteur de famille affichait « ninebox (5) » brut au milieu de
 *     familles traduites.
 *
 * Les tests ci-dessous épinglent la correction sur des lignes SYNTHÉTIQUES
 * (payload vide, puis payload portant un motif) : c'est ainsi que le comité a
 * prouvé que la retombée venait du catalogue et non des données.
 *
 * Sans base : le module de base de données exige que DATABASE_URL soit DÉFINIE,
 * jamais joignable (même procédé que notificationKinds.test.js).
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/lotc_catalogue_test';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const N = require('../../src/services/NotificationService');

const FR = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../locales/fr/chrome.json'), 'utf8')
);
const EN = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../locales/en/chrome.json'), 'utf8')
);

// Les cinq `kind` livrés sans entrée de catalogue (E-03 + M-05).
const SHIPPED = [
    'sa.cancelled',
    'sa.change_request_granted',
    'sa.change_request_raised',
    'sa.change_request_refused',
    'talent.task.created',
];

const row = (kind, payload) => ({
    id: 0,
    kind,
    payload: JSON.stringify(payload || {}),
    read_at: null,
    created_at: new Date('2026-09-14T08:00:00Z'),
});

describe('E-03 / M-05 — les cinq kind livrés ont une entrée de catalogue', () => {
    test.each(SHIPPED)('%s : META + LABEL + MESSAGE', (kind) => {
        expect(N.KIND_META[kind]).toBeDefined();
        expect(N.KIND_LABELS[kind]).toBeDefined();
        expect(N.KIND_MESSAGES[kind]).toBeDefined();
        expect(N.KIND_MESSAGES[kind].fr).toBeTruthy();
        expect(N.KIND_MESSAGES[kind].en).toBeTruthy();
    });

    // LA preuve du comité : une ligne SYNTHÉTIQUE, payload VIDE. Si le titre
    // revient au slug ici, c'est le catalogue qui manque, pas la donnée.
    test.each(SHIPPED)(
        "%s : sur une ligne synthétique (payload vide), le titre n'est PAS le slug",
        (kind) => {
            const fr = N.present(row(kind), 'fr');
            const en = N.present(row(kind), 'en');
            expect(fr.title).not.toBe(kind);
            expect(en.title).not.toBe(kind);
            expect(fr.title).not.toMatch(/^[a-z_]+\.[a-z_.]+$/); // aucune forme de slug
            // FR et EN DIFFÈRENT : le défaut d'origine rendait la même chaîne des
            // deux côtés (absence de libellé), ce qu'un simple trou de traduction
            // n'aurait pas fait.
            expect(fr.title).not.toBe(en.title);
            expect(fr.body).toBeNull(); // pas de motif → pas de corps
        }
    );

    test.each(SHIPPED)('%s : icône et lien propres, pas les valeurs de repli', (kind) => {
        const p = N.present(row(kind), 'fr');
        expect(p.icon).not.toBe('fa-bell'); // repli générique mesuré avant
        expect(p.link).not.toBe('/dashboard'); // repli de lien mesuré avant
        expect(p.link.startsWith('/')).toBe(true);
    });

    test("le sujet d'e-mail des cinq kind est bilingue et ne porte jamais le slug", () => {
        for (const kind of SHIPPED) {
            const fr = N._subjectFor(kind, 'fr', 'ACME');
            const en = N._subjectFor(kind, 'en', 'ACME');
            expect(fr).not.toContain(kind);
            expect(en).not.toContain(kind);
            expect(fr).not.toBe(en);
        }
    });
});

describe('E-03 — le motif du payload est RENDU', () => {
    const REASON = 'Saisie faite sur le mauvais collaborateur.';

    test("la notification 1299 (reproduite à l'identique) montre le motif, dans les deux langues", () => {
        const r = row('sa.cancelled', { reason: REASON, skillId: '300' });
        const fr = N.present(r, 'fr');
        const en = N.present(r, 'en');
        expect(fr.title).toContain(REASON);
        expect(en.title).toContain(REASON);
        expect(fr.body).toBe(REASON);
        expect(fr.title.startsWith('Votre auto-évaluation a été annulée')).toBe(true);
    });

    test.each(SHIPPED)('%s : un motif porté par le payload ressort', (kind) => {
        const p = N.present(row(kind, { reason: 'Motif écrit par le décideur.' }), 'fr');
        expect(p.body).toBe('Motif écrit par le décideur.');
        expect(p.title).toContain('Motif écrit par le décideur.');
    });

    // Le motif est le TEXTE de quelqu'un : il ne doit être ni tronqué de ses
    // lettres, ni ré-échappé. Un ancien correctif remplaçait chaque « s » par une
    // espace (« sera restaurée » → «  era re taurée ») : ce test l'attrape.
    test('le motif est rendu mot pour mot, seuls les blancs sont repliés', () => {
        const messy = 'UAT3 lane M — annulation de test,\n\tsera restaurée & suite';
        const p = N.present(row('sa.cancelled', { reason: messy }), 'fr');
        expect(p.body).toBe('UAT3 lane M — annulation de test, sera restaurée & suite');
        expect(p.body).toContain('sera restaurée');
        expect(p.body).not.toContain('&amp;'); // l'échappement est l'affaire des vues
        expect(p.body).not.toMatch(/[\n\t]/); // une seule ligne
    });

    test('pas de motif dans le payload → titre nu et corps nul (jamais un tiret orphelin)', () => {
        const p = N.present(
            row('sa.change_request_raised', { link: '/assessment-changes', changeRequestId: 31 }),
            'fr'
        );
        expect(p.body).toBeNull();
        expect(p.title).toBe('Une demande de modification attend votre décision');
        expect(p.title).not.toContain('—');
    });

    test("un motif vide ou blanc n'ajoute rien", () => {
        for (const reason of ['', '   ', '\n\t']) {
            const p = N.present(row('sa.cancelled', { reason }), 'fr');
            expect(p.body).toBeNull();
            expect(p.title).toBe('Votre auto-évaluation a été annulée');
        }
    });

    test('un motif très long est borné (une ligne de titre, pas un paragraphe)', () => {
        const p = N.present(row('sa.cancelled', { reason: 'x'.repeat(400) }), 'fr');
        expect(p.body.length).toBe(160);
        expect(p.body.endsWith('…')).toBe(true);
    });

    // Règle de confidentialité écrite au-dessus de KIND_MESSAGES : ni motif, ni
    // commentaire, ni note ne quitte l'application par e-mail. Le récapitulatif
    // quotidien compose ses lignes avec present().
    test('withReason:false (récapitulatif e-mail) ne laisse PAS passer le motif', () => {
        const p = N.present(row('sa.cancelled', { reason: REASON }), 'fr', { withReason: false });
        expect(p.title).toBe('Votre auto-évaluation a été annulée');
        expect(p.title).not.toContain(REASON);
        expect(JSON.stringify(p.title)).not.toContain('Saisie');
    });
});

describe("M-05 — la famille n'apparaît jamais en brut dans le sélecteur", () => {
    // views/pages/notifications/index.ejs:27 fait
    // __('chrome:notif_family_' + f.family, { defaultValue: f.family }) :
    // une clé absente et c'est le slug qui s'affiche (« ninebox (5) », mesuré).
    test('ninebox a un libellé dans les DEUX locales', () => {
        expect(FR.notif_family_ninebox).toBeTruthy();
        expect(EN.notif_family_ninebox).toBeTruthy();
        expect(FR.notif_family_ninebox).not.toBe('ninebox');
        expect(EN.notif_family_ninebox).not.toBe('ninebox');
    });

    test("AUCUNE famille de KIND_META n'est sans libellé, des deux côtés", () => {
        const families = [...new Set(Object.keys(N.KIND_META).map((k) => k.split('.')[0]))].sort();
        const missing = families.filter(
            (f) => !FR[`notif_family_${f}`] || !EN[`notif_family_${f}`]
        );
        expect(missing).toEqual([]);
        expect(families.length).toBeGreaterThan(20); // garde anti-test vide
    });

    test('les jeux de clés notif_family_* sont identiques FR / EN', () => {
        const keys = (o) =>
            Object.keys(o)
                .filter((k) => k.startsWith('notif_family_'))
                .sort();
        expect(keys(FR)).toEqual(keys(EN));
    });
});

describe("le motif ne quitte pas l'application par e-mail", () => {
    // Le récapitulatif quotidien compose ses lignes avec present(). Mesuré avant
    // correction : « Votre auto-évaluation a été annulée — Saisie faite sur le
    // mauvais collaborateur. » partait dans le HTML ET dans le texte de l'e-mail,
    // alors que la règle écrite au-dessus de KIND_MESSAGES l'interdit.
    const REASON = 'Saisie faite sur le mauvais collaborateur.';

    test('sendDigest compose la ligne SANS le motif', async () => {
        const EmailService = require('../../src/services/EmailService');
        const saved = {
            isCategoryEnabled: EmailService.isCategoryEnabled,
            send: EmailService.send,
            listInApp: N.listInApp,
            resolve: N._resolveRecipient,
            allowed: N._userEmailAllowed,
            brand: N._brand,
        };
        let sent = null;
        try {
            EmailService.isCategoryEnabled = async () => true;
            EmailService.send = async (m) => {
                sent = m;
                return { sent: true };
            };
            N.listInApp = async () => [
                {
                    id: 1299,
                    kind: 'sa.cancelled',
                    payload: JSON.stringify({ reason: REASON }),
                    read_at: null,
                    created_at: new Date(),
                    locale: 'fr',
                },
            ];
            N._resolveRecipient = async () => ({ email: 'probe@example.invalid', name: 'Probe' });
            N._userEmailAllowed = async () => true;
            N._brand = async () => ({
                appName: 'IDevelop',
                accent: '#5140D9',
                ink: '#0E1116',
                logo: '',
            });

            const r = await N.sendDigest({ userType: 'employee', userId: 138, locale: 'fr' });
            expect(r.sent).toBe(true);
            expect(sent.html).toContain('Votre auto-évaluation a été annulée');
            expect(sent.html).not.toContain(REASON);
            expect(sent.text).not.toContain(REASON);
            expect(sent.subject).not.toContain(REASON);
        } finally {
            EmailService.isCategoryEnabled = saved.isCategoryEnabled;
            EmailService.send = saved.send;
            N.listInApp = saved.listInApp;
            N._resolveRecipient = saved.resolve;
            N._userEmailAllowed = saved.allowed;
            N._brand = saved.brand;
        }
    });
});

describe('la même classe de défaut, sur les kind trouvés par balayage', () => {
    // Relevés en comparant TOUS les kind émis dans src/ et tous ceux déjà
    // stockés dans `notifications` (idevelop) au catalogue :
    //   certification.revoked — émis par CertificationService, 0 ligne aujourd'hui
    //   review.due            — plus d'émetteur, 1 ligne vivante (notification #1)
    test.each(['certification.revoked', 'review.due'])('%s a une entrée complète', (kind) => {
        expect(N.KIND_META[kind]).toBeDefined();
        expect(N.KIND_LABELS[kind]).toBeDefined();
        expect(N.KIND_MESSAGES[kind]).toBeDefined();
        const fr = N.present(row(kind), 'fr');
        const en = N.present(row(kind), 'en');
        expect(fr.title).not.toBe(kind);
        expect(fr.title).not.toBe(en.title);
        expect(fr.icon).not.toBe('fa-bell');
    });

    test('certification.revoked montre le motif du retrait, jamais la compétence', () => {
        // payload réel de CertificationService: { skill, reason, link }
        const p = N.present(
            row('certification.revoked', {
                skill: 'Travail en hauteur',
                reason: 'Recyclage non suivi dans les délais.',
                link: '/employee/dashboard',
            }),
            'fr'
        );
        expect(p.body).toBe('Recyclage non suivi dans les délais.');
        expect(p.title).toContain('Recyclage non suivi dans les délais.');
        expect(p.title).not.toContain('Travail en hauteur');
        expect(p.link).toBe('/employee/dashboard'); // le payload gagne sur le repli
    });
});
