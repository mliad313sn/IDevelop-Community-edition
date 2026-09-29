'use strict';

/*
 * LOT « amorçage » — P2-18 : le produit refusait sa propre valeur d'amorçage.
 *
 * CE QUI ÉTAIT CASSÉ, mesuré par exécution avant correction :
 *   GET  /admins/1 → 200, le formulaire pré-remplit lui-même
 *                    username="admin", email="admin@localhost".
 *   POST /admins/1 de CES valeurs exactes → 302 /admins/1,
 *                    « Une adresse e-mail valide est requise », rien n'est écrit
 *                    (admins.updated_at reste 2026-09-11T16:01:58.931Z).
 *   Cause : `body('email').isEmail()` prend `require_tld: true` par défaut, et
 *   `admin@localhost` n'a pas de domaine public. Or c'est EXACTEMENT l'adresse
 *   que le produit écrit lui-même sur ses DEUX chemins d'amorçage
 *   (`PostgresDatabase.seed`, `AuthService`) et que l'installateur normalise.
 *   Le super-administrateur par défaut ne pouvait donc jamais enregistrer sa
 *   propre fiche, et le message ne disait pas ce qui manquait.
 *
 * CE QUE CES TESTS EMPÊCHENT :
 *   1. qu'on reserre la règle au point de re-refuser la valeur d'amorçage — le
 *      test 2 lit le littéral SEMÉ DANS LES DEUX SOURCES et le fait passer par
 *      la vraie chaîne : changer l'un sans l'autre vire au rouge ;
 *   2. qu'on « répare » en désactivant la validation — les tests 3 et 4 exigent
 *      que tout ce qui était refusé avec un domaine pointé le reste, message
 *      `validation:email_invalid` compris, en FR comme en EN ;
 *   3. qu'on accepte l'adresse en silence — le test 5 exige la phrase qui dit
 *      ce qui manque et pourquoi, présente en FR et en EN, rendue par le
 *      SERVEUR dans les deux formulaires (donc lisible sans JavaScript).
 */

const fs = require('fs');
const path = require('path');
const V = require('../../src/utils/validators');

const frValidation = require('../../locales/fr/validation.json');
const enValidation = require('../../locales/en/validation.json');
const frAdmin = require('../../locales/fr/admin.json');
const enAdmin = require('../../locales/en/admin.json');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Un req/res minimal, comme le middleware les voit (cf. lot0-validators). */
function mockReq({ path: p = '/admins/1', body = {}, lang = 'fr' } = {}) {
    const flashes = {};
    return {
        path: p,
        body,
        xhr: false,
        headers: {},
        get: () => undefined,
        t: (key) => {
            const [ns, k] = key.split(':');
            if (ns !== 'validation') return key;
            const dict = lang === 'fr' ? frValidation : enValidation;
            return dict[k] || key;
        },
        flash: (k, v) => {
            (flashes[k] = flashes[k] || []).push(v);
        },
        _flashes: flashes,
    };
}
function mockRes() {
    const res = { statusCode: 200, redirectedTo: null, jsonBody: null };
    res.status = (c) => {
        res.statusCode = c;
        return res;
    };
    res.json = (b) => {
        res.jsonBody = b;
        return res;
    };
    res.redirect = (to) => {
        res.redirectedTo = to;
        return res;
    };
    return res;
}
/** Joue une chaîne express-validator puis son handler ; rend true si elle passe. */
async function runChain(chain, req, res) {
    for (const mw of chain.slice(0, -1)) await mw.run(req);
    let nexted = false;
    chain[chain.length - 1](req, res, () => {
        nexted = true;
    });
    return nexted;
}
const updateBody = (email) => ({ username: 'admin', email, role: 'superadmin' });
const createBody = (email) => ({
    username: 'zz.amorcage',
    email,
    role: 'viewer',
    password: 'Qa-Committee-2026!',
    passwordConfirm: 'Qa-Committee-2026!',
});

describe('P2-18 — la fiche administrateur accepte la valeur d’amorçage du produit', () => {
    test('1. `emailHasNoPublicDomain` ne reconnaît QUE la forme « hôte nu »', () => {
        // Vrai : un hôte sans point — c'est la forme que le produit sème.
        ['admin@localhost', 'helpdesk@srv01', 'a@b'].forEach((v) =>
            expect({ v, r: V.emailHasNoPublicDomain(v) }).toEqual({ v, r: true })
        );
        // Faux : un domaine pointé, un hôte mal formé, ou rien du tout — ces
        // cas doivent continuer à passer par la règle stricte, intacte.
        [
            'admin@example.com',
            'uat.admin@uat.local',
            'admin@localhost.',
            'admin@-bad',
            'pasunmail',
            '',
            null,
            undefined,
            'admin@',
        ].forEach((v) => expect({ v, r: V.emailHasNoPublicDomain(v) }).toEqual({ v, r: false }));
    });

    test('2. l’adresse semée par les DEUX chemins d’amorçage franchit les deux chaînes', async () => {
        // Le littéral n'est pas recopié ici : il est LU dans les deux sources.
        // Si quelqu'un change la semence, ce test la remet à l'épreuve.
        const seeds = [
            (read('src/database/PostgresDatabase.js').match(/'admin',\s*'([^']+)',\s*hash/) ||
                [])[1],
            (read('src/services/AuthService.js').match(
                /username:\s*'admin',\s*\n\s*email:\s*'([^']+)'/
            ) || [])[1],
        ];
        expect(seeds.filter(Boolean)).toHaveLength(2);
        expect(new Set(seeds).size).toBe(1); // les deux chemins sèment la MÊME adresse

        for (const seed of seeds) {
            const rq = mockReq({ body: updateBody(seed) });
            const rs = mockRes();
            expect({ seed, passe: await runChain(V.adminUpdateValidation, rq, rs) }).toEqual({
                seed,
                passe: true,
            });
            expect(rq._flashes.error).toBeUndefined();
            expect(rs.redirectedTo).toBeNull();

            const rq2 = mockReq({ path: '/admins', body: createBody(seed) });
            const rs2 = mockRes();
            expect({ seed, passe: await runChain(V.adminValidation, rq2, rs2) }).toEqual({
                seed,
                passe: true,
            });
            expect(rq2._flashes.error).toBeUndefined();
        }
    });

    test('3. la validation n’est PAS désactivée : tout ce qui était refusé le reste', async () => {
        const refuses = [
            'pasunmail',
            'admin@localhost.',
            'admin@-bad',
            'admin@ex_ample.com',
            'a b@c.com',
            'admin@@localhost',
            '@localhost',
            'admin@',
        ];
        for (const email of refuses) {
            const rq = mockReq({ body: updateBody(email) });
            const rs = mockRes();
            const passe = await runChain(V.adminUpdateValidation, rq, rs);
            expect({ email, passe }).toEqual({ email, passe: false });
            expect(rq._flashes.error).toEqual(['Une adresse e-mail valide est requise']);
            expect(rs.redirectedTo).toBe('/admins/1'); // la saisie revient sur SON formulaire
            expect(JSON.parse(rq._flashes['draft:/admins/1'][0]).email).toBe(email); // et elle est conservée
        }
    });

    test('4. une adresse ordinaire reste acceptée, et le refus parle anglais en session EN', async () => {
        const ok = mockReq({ body: updateBody('admin@example.com') });
        expect(await runChain(V.adminUpdateValidation, ok, mockRes())).toBe(true);

        const en = mockReq({ body: updateBody('pasunmail'), lang: 'en' });
        await runChain(V.adminUpdateValidation, en, mockRes());
        expect(en._flashes.error).toEqual(['A valid e-mail address is required']);
    });

    test('5. le formulaire EXPLIQUE l’adresse sans domaine, en une phrase, FR et EN, rendue par le serveur', () => {
        // La phrase existe dans les deux langues et dit ce qui manque (le
        // domaine) ET pourquoi ça compte (rien n'est remis).
        expect(frAdmin.adm_email_no_domain_note).toBeTruthy();
        expect(enAdmin.adm_email_no_domain_note).toBeTruthy();
        expect(frAdmin.adm_email_no_domain_note).toMatch(/domaine/i);
        expect(enAdmin.adm_email_no_domain_note).toMatch(/domain/i);
        expect(Object.keys(frAdmin).sort()).toEqual(Object.keys(enAdmin).sort());

        // Les DEUX formulaires la rendent, côté serveur, sous condition — pas un
        // bandeau permanent, et pas du JavaScript.
        ['admins/show.ejs', 'admins/create.ejs'].forEach((v) => {
            const view = read(path.join('views/pages', v));
            expect(view).toMatch(/emailHasNoPublicDomain/);
            expect(view).toMatch(/admin:adm_email_no_domain_note/);
            expect(view).toMatch(/id="admEmailNoDomain"/);
        });
        // La phrase et la règle partagent le MÊME prédicat : le contrôleur passe
        // celui du validateur aux vues, elles ne peuvent pas diverger.
        const ctrl = read('src/controllers/AdminController.js');
        expect(ctrl).toMatch(
            /emailHasNoPublicDomain\s*}\s*=\s*require\('\.\.\/utils\/validators'\)/
        );
        expect((ctrl.match(/^\s*emailHasNoPublicDomain,$/gm) || []).length).toBe(2); // show + create
    });

    test('6. la règle assouplie ne touche QUE les comptes administrateurs', () => {
        // La fiche employé garde sa règle d'origine : hors périmètre de ce lot,
        // et un changement silencieux là-bas doit se voir.
        const src = read('src/utils/validators.js');
        const employee = src.slice(
            src.indexOf('const employeeValidation'),
            src.indexOf('const siteValidation')
        );
        expect(employee).toMatch(
            /body\('email'\)\.optional\(\{ checkFalsy: true \}\)\.isEmail\(\)\.withMessage\('validation:email_invalid'\)/
        );
        expect(employee).not.toMatch(/require_tld/);
    });
});
