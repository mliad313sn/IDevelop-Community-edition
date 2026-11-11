'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * UAT3 passe 2 — LOT « parité » : P2-02, P2-03, P2-16, P2-17.
 * =========================================================================
 * CE QUI ÉTAIT CASSÉ, ET CE QUE CHAQUE TEST EMPÊCHE DE REVENIR.
 *
 * Le fil commun des quatre constats n'est pas « une traduction manque ». C'est
 * qu'une page française servait de l'ANGLAIS, ou pire une CLÉ NUE, sur des
 * écrans où la phrase est l'information elle-même. Mesuré avant correction, en
 * rendant les gabarits hors ligne avec un vrai traducteur i18next :
 *
 *  P2-02  L'écran que la divulgation 9-box existe pour servir écrivait
 *         « Perf: low · Pot: high » et « Positionné le 15/09/2026. Performance
 *         low, potentiel high. » sur la page FRANÇAISE. Le NOM DE CASE, lui,
 *         était traduit (« Diamant brut ») : le contraste était dans la MÊME
 *         phrase. La sous-ligne était byte-identique en FR et en EN. La règle
 *         interne existait déjà ailleurs (NineBoxController : « Jamais une
 *         valeur d'énumération dans une phrase »).
 *         → `nbBand()` traduit les trois bandes ; une valeur hors dictionnaire
 *           se rend telle quelle plutôt que de disparaître.
 *
 *  P2-03  Le plan de coaching que le produit crée AVEC le PIP était rédigé en
 *         anglais seul — titre, objectif ET les cinq actions que le
 *         collaborateur coche — quelle que soit la locale. Ce n'était pas un
 *         repli sur clé manquante : `grep` sur locales/ → 0 clé. Le texte est
 *         désormais pris dans `COACHING_PIP_TEMPLATES`, indexé par locale, et
 *         écrit dans la langue de la personne AU MOMENT DE LA CRÉATION (même
 *         patron que `IDPService.SMART_TEMPLATES`). Conséquence assumée : un
 *         plan écrit en français reste en français — c'est un document daté que
 *         la personne et son manager ont déjà lu, et son texte est éditable.
 *
 *  P2-16  `/v2/uam/mfa/manage` et la page des codes de secours étaient
 *         ENTIÈREMENT en anglais sous `<html lang="fr">` : 2 appels `__()` sur
 *         la première (deux attributs `data-confirm`, zéro texte visible) et 0
 *         sur la seconde, alerte JavaScript comprise. Aggravant : quand
 *         `mfaRequiredForPrivileged` est actif, tout administrateur privilégié
 *         est entonné sur cette page et ne peut aller nulle part ailleurs — la
 *         localisation manquait donc sur un chemin BLOQUANT.
 *
 *  P2-17  `POST /admin/api-keys {"expiresAt":"2020-01-01"}` répondait
 *         `{"code":"past_expiry","error":"ops_apikey_past_expiry"}` — la CLÉ de
 *         traduction nue, identique en FR et en EN, affichée telle quelle par
 *         l'`alert()` de la page. Les deux clés n'existaient dans AUCUN fichier
 *         de locales, et `src/config/i18n.js` n'installe pas de
 *         `parseMissingKeyHandler` : i18next rend alors la clé, et le repli
 *         anglais du ternaire n'est jamais atteint. Corrigé par les clés
 *         elles-mêmes + un helper qui DÉTECTE l'écho de clé au lieu de le servir.
 *
 * Les tests ci-dessous rendent les vrais gabarits avec un vrai traducteur : un
 * test qui n'inspecterait que la présence d'une clé dans un JSON ne verrait
 * aucun des quatre défauts (la clé de case ÉTAIT présente pour P2-02).
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const NS = ['common', 'chrome', 'employee', 'admin', 'talentx', 'coaching'];

let T; // { fr: __, en: __ }

beforeAll(async () => {
    const inst = i18next.createInstance();
    await inst.use(Backend).init({
        fallbackLng: 'fr',
        supportedLngs: ['fr', 'en'],
        preload: ['fr', 'en'],
        ns: NS,
        defaultNS: 'common',
        initImmediate: false,
        backend: { loadPath: path.join(ROOT, 'locales', '{{lng}}/{{ns}}.json') },
        interpolation: { escapeValue: false },
    });
    T = {
        fr: (k, o) => inst.getFixedT('fr')(k, o),
        en: (k, o) => inst.getFixedT('en')(k, o),
    };
});

/** Rend un gabarit et rabat le HTML sur du texte lisible. */
function renderText(tpl, locals) {
    const html = ejs.render(read(tpl), locals, { filename: path.join(ROOT, tpl) });
    return html
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// =========================================================================
// P2-02 — l'écran de la divulgation
// =========================================================================
describe('P2-02 — le positionnement 9-box se lit dans la langue de la page', () => {
    const snapshotFor = (perf, pot) => ({
        gapRows: [],
        total: 5,
        met: 2,
        gaps: 1,
        unmeasured: 1,
        criticalGaps: 0,
        readiness: 80,
        stateRows: [{ state: 'approved', n: 1 }],
        nineBox: {
            performance: perf,
            potential: pot,
            boxLabel: 'Diamond in the rough',
            approvedAt: '2026-09-15T10:00:00Z',
        },
    });
    const dash = (lng, perf, pot) =>
        renderText('views/pages/employee/dashboard.ejs', {
            __: T[lng],
            snapshot: snapshotFor(perf, pot),
            employee: { roleName: 'R' },
            user: { firstName: 'S', username: 'u' },
            lang: lng,
        });

    test('la tuile et la phrase rendent des libellés, jamais les jetons bruts', () => {
        const fr = dash('fr', 'low', 'high');
        expect(fr).toContain('Perf: Faible · Pot: Élevé');
        expect(fr).toContain('Performance Faible , potentiel Élevé');
        // Le défaut exact du constat : la valeur d'énumération dans la phrase.
        expect(fr).not.toMatch(/Performance low|potentiel high|Perf: low|Pot: high/);
    });

    test('les deux langues ne sont plus byte-identiques sur cette sous-ligne', () => {
        const fr = dash('fr', 'low', 'high');
        const en = dash('en', 'low', 'high');
        expect(en).toContain('Perf: Low · Pot: High');
        expect(fr.match(/Perf:[^·]+· Pot: \S+/)[0]).not.toBe(en.match(/Perf:[^·]+· Pot: \S+/)[0]);
    });

    test('les 9 couples possibles se rendent sans laisser passer un jeton brut', () => {
        for (const perf of ['low', 'medium', 'high']) {
            for (const pot of ['low', 'medium', 'high']) {
                const fr = dash('fr', perf, pot);
                expect(fr).not.toMatch(new RegExp(`Perf: ${perf}\\b`));
                expect(fr).not.toMatch(new RegExp(`Pot: ${pot}\\b`));
            }
        }
    });

    test('les trois bandes existent en FR et en EN, et diffèrent', () => {
        for (const b of ['low', 'medium', 'high']) {
            const fr = T.fr(`talentx:nb_band_${b}`);
            const en = T.en(`talentx:nb_band_${b}`);
            expect(fr).not.toBe(`nb_band_${b}`); // pas une clé nue
            expect(en).not.toBe(`nb_band_${b}`);
            expect(fr).not.toBe(en);
        }
    });
});

// =========================================================================
// P2-03 — le plan de coaching écrit par le produit
// =========================================================================
describe('P2-03 — le plan créé avec le PIP est écrit dans la langue de la personne', () => {
    const src = read('src/services/DevelopmentTriggerService.js');
    const TPL = new Function(
        // eslint-disable-line no-new-func
        `${src.slice(src.indexOf('const COACHING_PIP_TEMPLATES'), src.indexOf('function planLocale'))}; return COACHING_PIP_TEMPLATES;`
    )();
    const localeOf = new Function(
        // eslint-disable-line no-new-func
        `${src.slice(src.indexOf('function planLocale'), src.indexOf('class DevelopmentTriggerService'))}; return planLocale;`
    )();

    test('les trois textes existent dans les deux langues et ne sont pas les mêmes', () => {
        for (const field of ['title', 'objective']) {
            expect(TPL.fr[field]).toBeTruthy();
            expect(TPL.en[field]).toBeTruthy();
            expect(TPL.fr[field]).not.toBe(TPL.en[field]);
        }
        const g = { skillName: 'Sécurité', current: 1, required: 4 };
        expect(TPL.fr.action(g)).not.toBe(TPL.en.action(g));
    });

    test('la version française ne laisse traîner aucun mot du gabarit anglais', () => {
        const frAll = [
            TPL.fr.title,
            TPL.fr.objective,
            TPL.fr.action({ skillName: 'X', current: 1, required: 2 }),
            TPL.fr.action({ skillName: 'X', current: null, required: 2 }),
        ].join(' | ');
        expect(frAll).not.toMatch(
            /Coaching to support PIP|Improve performance|skill gaps|Develop "|from level|Reach level/
        );
    });

    test('la locale est celle de la requête, et le produit retombe en FRANÇAIS, jamais en anglais', () => {
        expect(localeOf({ language: 'en' })).toBe('en');
        expect(localeOf({ language: 'en-GB' })).toBe('en');
        expect(localeOf({ language: 'fr' })).toBe('fr');
        expect(localeOf({ i18n: { language: 'en' } })).toBe('en');
        expect(localeOf(null)).toBe('fr'); // tâche de fond, aucune requête
        expect(localeOf({})).toBe('fr');
        expect(localeOf({ language: 'de' })).toBe('fr');
    });

    test('le service ne contient plus de littéral de plan codé en dur', () => {
        const body = src.slice(
            src.indexOf('async createSupportCoaching'),
            src.indexOf('async _triggerBlue')
        );
        expect(body).not.toMatch(/'Coaching to support PIP'/);
        expect(body).not.toMatch(/Improve performance and close the skill gaps/);
        expect(body).toMatch(/COACHING_PIP_TEMPLATES\[planLocale\(req\)\]/);
    });

    test('la migration 121 ne réécrit que les littéraux de la machine, et ne supprime rien', () => {
        const m = read('db/postgres/121_coaching_pip_plan_language.sql');
        expect(m).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
        // Ancrée sur la forme exacte : une ligne retouchée par un humain ne matche pas.
        expect(m).toMatch(/\^Develop "\.\+" from level \\d\+ to \\d\+\$/);
        expect(m).toMatch(/AND p\.title = 'Coaching to support PIP'/);
        // Une absence de mesure ne devient jamais « du niveau null » : la branche
        // « from level null » produit la forme NON MESURÉE. Contrôlé sur le SQL
        // exécutable seul, commentaires retirés (le commentaire dit la règle,
        // c'est l'instruction qui doit la tenir).
        const sql = m
            .split('\n')
            .filter((l) => !l.trim().startsWith('--'))
            .join('\n');
        expect(sql).toMatch(/from level null/);
        const nullBranch = sql.slice(
            sql.indexOf('UPDATE coaching_plan_actions'),
            sql.indexOf('-- 1b') > 0 ? sql.indexOf('-- 1b') : sql.indexOf('from level \\d+ to \\d+')
        );
        expect(nullBranch).toMatch(/niveau actuel non évalué/);
        expect(nullBranch).not.toMatch(/du niveau/);
    });
});

// =========================================================================
// P2-16 — double authentification et codes de secours
// =========================================================================
describe('P2-16 — les deux écrans MFA se lisent dans la langue de la session', () => {
    const manage = (lng, confirmed) =>
        renderText('views/pages/auth/mfa-manage.ejs', {
            __: T[lng],
            status: { confirmed, backupCodesLeft: 8 },
            recommended: true,
            csrfToken: 'x',
        });
    const backup = (lng) =>
        renderText('views/pages/auth/mfa-backup-codes.ejs', {
            __: T[lng],
            codes: ['AAA-111'],
            cspNonce: 'n',
        });

    test('la page de gestion est française en FR, pour les deux états', () => {
        for (const confirmed of [false, true]) {
            const fr = manage('fr', confirmed);
            expect(fr).toContain('Double authentification'); // 3.23.21 UX-9: one term everywhere
            expect(fr).not.toMatch(
                /Two-Factor Authentication|NOT ACTIVE|Your account is protected|Deactivate 2FA/
            );
        }
        expect(manage('fr', false)).toContain('Votre rôle est privilégié');
    });

    test('la page des codes de secours est française en FR, alerte JavaScript comprise', () => {
        const fr = backup('fr');
        expect(fr).toContain('Codes de secours');
        expect(fr).not.toMatch(/Backup Codes|Store these single-use|Copy codes/);
        const raw = ejs.render(read('views/pages/auth/mfa-backup-codes.ejs'), {
            __: T.fr,
            codes: ['A'],
            cspNonce: 'n',
        });
        expect(raw).toContain('Codes de secours copiés dans le presse-papiers.');
        expect(raw).not.toContain("alert('Backup codes copied to clipboard.')");
    });

    test('les deux pages ne sont plus invariantes par langue', () => {
        expect(manage('fr', false)).not.toBe(manage('en', false));
        expect(manage('fr', true)).not.toBe(manage('en', true));
        expect(backup('fr')).not.toBe(backup('en'));
    });

    test('la version anglaise conserve les phrases d origine', () => {
        expect(manage('en', false)).toContain('Your account is protected by password only');
        expect(backup('en')).toContain('Backup Codes');
    });

    test('plus aucun texte visible codé en dur dans le MARQUAGE des deux gabarits', () => {
        for (const v of [
            'views/pages/auth/mfa-manage.ejs',
            'views/pages/auth/mfa-backup-codes.ejs',
        ]) {
            // Le bloc d'en-tête `<% /* … */ %>` CITE les phrases anglaises du
            // constat pour expliquer ce qui était cassé : on l'écarte et on lit
            // le marquage servi.
            const body = read(v).replace(/^<%[\s\S]*?%>/, '');
            expect(body).not.toMatch(
                /Two-Factor Authentication|NOT ACTIVE|Deactivate 2FA|Backup Codes|Copy codes|Your account is protected/
            );
            // Chaque texte visible passe par le traducteur.
            expect(body.match(/__\(/g).length).toBeGreaterThanOrEqual(5);
        }
    });
});

// =========================================================================
// P2-17 — les refus de la création de clé d'API
// =========================================================================
describe('P2-17 — un refus de clé d API est une phrase, jamais une clé', () => {
    const KEYS = [
        'ops_apikey_bad_expiry',
        'ops_apikey_past_expiry',
        'ops_apikey_label_required',
        'ops_apikey_unknown_owner',
    ];

    test('les quatre clés existent en FR et en EN et rendent une phrase', () => {
        for (const k of KEYS) {
            for (const lng of ['fr', 'en']) {
                const s = T[lng](`admin:${k}`);
                expect(s).not.toBe(k); // l écho de clé nue
                expect(s).not.toBe(`admin:${k}`);
                expect(s.length).toBeGreaterThan(10);
                expect(s).toMatch(/[.:]$/); // une phrase, pas un slug
            }
            expect(T.fr(`admin:${k}`)).not.toBe(T.en(`admin:${k}`));
        }
    });

    test('les quatre clés sont bien dans les DEUX fichiers de locales', () => {
        const fr = JSON.parse(read('locales/fr/admin.json'));
        const en = JSON.parse(read('locales/en/admin.json'));
        for (const k of KEYS) {
            expect(Object.prototype.hasOwnProperty.call(fr, k)).toBe(true);
            expect(Object.prototype.hasOwnProperty.call(en, k)).toBe(true);
        }
    });

    // Les bornes sont repérées par EXPRESSION, pas par une graphie sur une
    // seule ligne : prettier renvoie le chemin à la ligne dès que la liste des
    // gardes déborde, `indexOf` rend alors -1, et `slice(-1, …)` découpe un
    // bloc qui n'est pas celui qu'on croit — les assertions passaient ou
    // échouaient sur du texte sans rapport.
    const at = (src, re) => {
        const i = src.search(re);
        expect(i).toBeGreaterThan(-1);
        return i;
    };
    const POST_KEYS = /router\.post\(\s*'\/admin\/api-keys'/;
    const POST_REVOKE = /router\.post\(\s*'\/admin\/api-keys\/:id\/revoke'/;

    test('la route sert la phrase, et détecte un écho de clé au lieu de le servir', () => {
        const src = read('src/routes/index.js');
        const block = src.slice(at(src, /const _akT =/), at(src, POST_REVOKE));
        // Les deux anglais codés en dur du constat ont disparu de la route.
        expect(block).not.toMatch(/error: 'label required'/);
        expect(block).not.toMatch(/error: 'unknown owner profile'/);
        for (const k of KEYS) expect(block).toContain(k);
        // Le helper : un t() qui renvoie la clé retombe sur la phrase de référence.
        const _akT = new Function(
            // eslint-disable-line no-new-func
            `${src.slice(at(src, /const _akT =/), at(src, POST_KEYS))}; return _akT;`
        )();
        expect(_akT({ t: (x) => x }, 'ops_apikey_past_expiry', 'FALLBACK')).toBe('FALLBACK');
        expect(_akT(null, 'ops_apikey_past_expiry', 'FALLBACK')).toBe('FALLBACK');
        expect(
            _akT(
                { t: () => 'L’échéance doit être une date future.' },
                'ops_apikey_past_expiry',
                'FALLBACK'
            )
        ).toBe('L’échéance doit être une date future.');
    });

    test('chaque refus garde un code stable, lisible par la machine', () => {
        const src = read('src/routes/index.js');
        const block = src.slice(at(src, POST_KEYS), at(src, POST_REVOKE));
        for (const c of ['label_required', 'unknown_owner', 'bad_expiry', 'past_expiry']) {
            expect(block).toContain(`code: '${c}'`);
        }
    });
});
