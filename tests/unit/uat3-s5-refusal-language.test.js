'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * UAT3 S5 — M-02, le RÉSIDUEL : un refus se lit dans la langue de la page.
 *
 * Le lot précédent a câblé la traduction dans UN contrôleur
 * (`AssessmentChangeRequestController`). Mesuré ensuite sur le serveur du lot, en
 * session FR (`<html lang="fr">` vérifié), trois refus se reproduisaient mot pour
 * mot parce que `SelfAssessmentWorkflowController` prend `makeHandle` sans
 * résolution de `e.i18n` — les `say()` posés dans le service étaient MORTS sur
 * ses routes :
 *   POST /api/self-assessment/223930/request-changes {comment:''}
 *        → 400 « Please explain what the employee needs to change. »
 *   POST /api/self-assessment/223930/open-review (uat.employee)
 *        → 403 « Not authorized: supervisor/admin only »
 *   GET  /api/talent/career-path?employeeId=87&targetRoleId=1 (uat.manager)
 *        → 403 « Not authorized for this employee »
 * et la CLASSE « valeur d'énumération brute en anglais » survivait sur les mêmes
 * routes : 409 « Cannot open review from state 'draft' », « Cannot approve from
 * 'draft' », « Cannot validate from 'submitted' », « Cannot arbitrate from state
 * 'approved' », 400 « Please provide a reason for rejecting this assessment. ».
 *
 * Après correction, mesuré sur :3215 (idevelop), mêmes requêtes, mêmes comptes :
 *   FR 400 « Expliquez ce que la personne doit modifier : le commentaire est
 *           obligatoire. » · 403 « Réservé au superviseur de la personne ou à un
 *           administrateur. » · 403 « Vous n'êtes pas autorisé à agir sur ce
 *           collaborateur. » · 409 « Une évaluation dans l'état « Brouillon » ne
 *           s'ouvre pas en revue. » …
 *   EN 400 "Explain what the person needs to change: the comment is mandatory."
 *      · 403 "Restricted to the person's supervisor or an administrator."
 *      · 409 "An assessment in the “Draft” state cannot be opened for review." …
 * Les STATUTS sont inchangés (400/403/409) : ils sont lus sur la phrase de
 * référence ANGLAISE, avant traduction.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const locale = (lang, ns) => JSON.parse(read(path.join('locales', lang, `${ns}.json`)));

const { sayError, sayText, toResponse, domainStatus } = require('../../src/utils/apiErrors');

/** Un `req.t` qui se comporte comme i18next sur les VRAIS catalogues. */
function reqFor(lang) {
    const cache = {};
    return {
        t: (key, opts) => {
            const [ns, k] = String(key).split(':');
            if (!k) return (opts && opts.defaultValue) !== undefined ? opts.defaultValue : key;
            try {
                cache[ns] = cache[ns] || locale(lang, ns);
            } catch (_) {
                cache[ns] = {};
            }
            let s = cache[ns][k];
            if (s === undefined)
                return (opts && opts.defaultValue) !== undefined ? opts.defaultValue : key;
            if (opts)
                for (const [n, v] of Object.entries(opts)) s = s.split(`{{${n}}}`).join(String(v));
            return s;
        },
    };
}

const SERVICE_SRC = read('src/services/SelfAssessmentWorkflowService.js');
/** Source moins ses commentaires — un défaut corrigé peut être NOMMÉ sans revenir. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// 1. La traduction appartient au FILTRE PARTAGÉ, pas à un contrôleur
// ---------------------------------------------------------------------------
describe('M-02 — la résolution de `e.i18n` vit dans utils/apiErrors', () => {
    const withKey = (msg, key, vars) =>
        Object.assign(new Error(msg), { i18n: vars ? { key, vars } : { key } });

    test('un refus marqué est rendu dans la langue lue, des DEUX côtés', () => {
        const e = withKey(
            'Not authorized: supervisor/admin only',
            'assess:acr_err_not_authorized_supervisor'
        );
        expect(sayError(reqFor('fr'), e)).toBe(
            'Réservé au superviseur de la personne ou à un administrateur.'
        );
        expect(sayError(reqFor('en'), e)).toBe(
            "Restricted to the person's supervisor or an administrator."
        );
    });

    test('une valeur d’énumération passe par le dictionnaire, jamais brute', () => {
        const e = withKey(
            "Cannot open review from state 'draft'",
            'assess:saw_err_cannot_open_review',
            { stateRaw: 'draft' }
        );
        const fr = sayError(reqFor('fr'), e);
        const en = sayError(reqFor('en'), e);
        expect(fr).toContain('Brouillon');
        expect(en).toContain('Draft');
        for (const s of [fr, en]) {
            expect(s).not.toContain("'draft'");
            expect(s).not.toMatch(/\bdraft\b/);
        }
    });

    test('sans traducteur, ou sans clé, la phrase de RÉFÉRENCE tient', () => {
        const e = withKey(
            'Please explain what the employee needs to change.',
            'assess:acr_err_request_changes_comment'
        );
        expect(sayError(null, e)).toBe('Please explain what the employee needs to change.');
        expect(sayError(reqFor('fr'), new Error('Boom'))).toBe('Boom');
    });

    test('une clé absente du catalogue dégrade vers la phrase, jamais vers la clé', () => {
        const e = withKey('Reference sentence.', 'assess:saw_err_this_key_does_not_exist');
        expect(sayError(reqFor('fr'), e)).toBe('Reference sentence.');
        expect(sayError(reqFor('en'), e)).toBe('Reference sentence.');
    });

    test('le STATUT est lu sur l’anglais AVANT traduction (400/403/404/409)', () => {
        const cases = [
            [
                'Not authorized: supervisor/admin only',
                'assess:acr_err_not_authorized_supervisor',
                null,
                403,
            ],
            ['Self-assessment not found', 'assess:acr_err_sa_not_found', null, 404],
            [
                "Cannot approve from 'draft'",
                'assess:saw_err_cannot_approve',
                { stateRaw: 'draft' },
                409,
            ],
            [
                'Please provide a reason for rejecting this assessment.',
                'assess:saw_err_reject_reason_required',
                null,
                400,
            ],
        ];
        for (const [msg, key, vars, status] of cases) {
            const r = toResponse(withKey(msg, key, vars), reqFor('fr'), 'test');
            expect(r.status).toBe(status);
            expect(r.body.success).toBe(false);
            // …et la phrase servie est bien la française, pas la référence.
            expect(r.body.error).not.toBe(msg);
            expect(domainStatus(msg)).toBe(status);
        }
    });

    test('une faute technique reste la phrase générique + l’identifiant de requête', () => {
        const pg = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
            code: '23505',
        });
        const r = toResponse(pg, { id: 'req-1' }, 'test');
        expect(r.status).toBe(500);
        expect(r.body.error).toMatch(/erreur technique/i);
        expect(r.body.requestId).toBe('req-1');
    });

    test('le contrôleur des demandes ne garde PLUS sa copie privée', () => {
        const ctrl = read('src/controllers/AssessmentChangeRequestController.js');
        expect(ctrl).toMatch(/sayError/);
        // La traduction ne se fait plus dans le wrapper local : c'est ce qui
        // laissait les autres contrôleurs en anglais.
        expect(code(ctrl)).not.toMatch(/e\.message = AssessmentChangeRequestController\._say/);
        expect(code(ctrl)).not.toMatch(/enumLabel\('sa_state'/);
    });

    test('le contrôleur du workflow traverse le même filtre, SANS rien de local', () => {
        const ctrl = read('src/controllers/SelfAssessmentWorkflowController.js');
        // Il prend `makeHandle` DIRECTEMENT : c'était le cœur du résiduel, et
        // c'est maintenant suffisant puisque la traduction est dans le filtre.
        expect(ctrl).toMatch(/const handle = makeHandle\('SelfAssessmentWorkflowController'\)/);
        expect(code(ctrl)).not.toMatch(/\.i18n/);
        expect(code(ctrl)).not.toMatch(/enumLabel/);
    });
});

// ---------------------------------------------------------------------------
// 2. La CLASSE : plus un seul refus non marqué dans le service
// ---------------------------------------------------------------------------
describe('M-02 — chaque refus du service porte sa clé', () => {
    test('aucun refus nu : chaque `new Error` du service porte une clé', () => {
        // Le marquage n'est pas toujours sur la MÊME ligne (`const e = new
        // Error(…) … throw say(e, clé)`), donc on regarde l'instruction entière.
        const src = code(SERVICE_SRC);
        const bare = [];
        // Fenêtre élargie à 900 caractères : prettier met chaque argument sur sa
        // propre ligne, si bien que le `say(e, …)` qui MARQUE un refus peut se
        // retrouver bien plus bas que l'ancienne fenêtre de 500. Mesuré sur
        // `acr_err_cancel_approved` (l.722-732) : l'erreur est marquée deux fois,
        // et le test la déclarait pourtant « nue ». On élargit la fenêtre ; on ne
        // relâche pas la règle.
        for (const m of src.matchAll(/new Error\(/g)) {
            const window = src.slice(Math.max(0, m.index - 200), m.index + 900);
            if (!/say\(/.test(window)) bare.push(src.slice(m.index, m.index + 70).split('\n')[0]);
        }
        // Le seul toléré : `_setState` n'est atteignable par aucune route — c'est
        // un invariant de programmation, classé faute technique par `apiErrors`.
        expect(bare).toEqual([expect.stringContaining("'Invalid workflow_state: '")]);
    });

    test('les six phrases citées par le tableau portent toutes une clé', () => {
        for (const [msg, key] of [
            [
                'A reason is required to cancel an assessment.',
                'assess:acr_err_cancel_reason_required',
            ],
            ["Cannot cancel from '${sa.workflowState}'", 'assess:acr_err_cancel_state'],
            [
                'Please explain what the employee needs to change.',
                'assess:acr_err_request_changes_comment',
            ],
            ['Not authorized: supervisor/admin only', 'assess:acr_err_not_authorized_supervisor'],
        ]) {
            expect(SERVICE_SRC).toContain(msg);
            expect(SERVICE_SRC).toContain(key);
        }
    });

    test('les cinq refus « état brut » de la CLASSE portent `stateRaw`', () => {
        for (const key of [
            'saw_err_cannot_open_review',
            'saw_err_cannot_approve',
            'saw_err_cannot_validate',
            'saw_err_cannot_arbitrate',
            'saw_err_cannot_reject',
            'saw_err_cannot_request_changes',
            'saw_err_cannot_reopen',
            'saw_err_cannot_withdraw_review',
        ]) {
            // \s* entre les jetons : prettier met chaque argument de say() sur sa
            // propre ligne dès qu'il déborde, et une assertion qui épingle la MISE
            // EN PAGE vire au rouge sur un reformatage qui n'a rien changé.
            const re = new RegExp(
                `'assess:${key}',\\s*\\{\\s*stateRaw: sa\\.workflowState,?\\s*\\}`
            );
            expect(SERVICE_SRC).toMatch(re);
        }
    });

    test('chaque clé posée par le service existe dans LES DEUX catalogues', () => {
        const fr = locale('fr', 'assess');
        const en = locale('en', 'assess');
        const keys = [...SERVICE_SRC.matchAll(/'assess:([a-z0-9_]+)'/g)].map((m) => m[1]);
        expect(keys.length).toBeGreaterThanOrEqual(30);
        for (const k of new Set(keys)) {
            expect(Object.prototype.hasOwnProperty.call(fr, k)).toBe(true);
            expect(Object.prototype.hasOwnProperty.call(en, k)).toBe(true);
            expect(String(fr[k]).trim()).not.toBe('');
            expect(String(en[k]).trim()).not.toBe('');
            expect(fr[k]).not.toBe(en[k]); // parité MUETTE : pas de français dans l'anglais
        }
    });

    test('chaque phrase à variable interpole la MÊME variable des deux côtés', () => {
        const fr = locale('fr', 'assess');
        const en = locale('en', 'assess');
        const vars = (s) => [...String(s).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
        for (const k of Object.keys(fr)) {
            if (!/^saw_err_|^acr_err_/.test(k)) continue;
            expect(vars(fr[k])).toEqual(vars(en[k]));
        }
    });
});

// ---------------------------------------------------------------------------
// 3. Le refus le plus répandu du domaine : « Not authorized for this employee »
// ---------------------------------------------------------------------------
describe('M-02 — « Not authorized for this employee » n’est plus un littéral', () => {
    const SITES = [
        'src/controllers/TalentActionsController.js',
        'src/routes/v2-capability.js',
        'src/routes/v2-coaching.js',
        'src/routes/v2-lms.js',
        'src/routes/v2-pip.js',
        'src/routes/v2-talent.js',
    ];

    test('les treize réponses passent par le catalogue partagé', () => {
        for (const p of SITES) {
            const src = read(p);
            // La phrase anglaise ne subsiste QUE comme référence par défaut.
            const literals = [...src.matchAll(/'Not authorized for this employee'/g)];
            expect(literals.length).toBe(1);
            expect(src).toMatch(
                /sayText\(req, 'common:err_not_authorized_employee', 'Not authorized for this employee'\)/
            );
            expect(src).toMatch(/notAuthorizedForEmployee\(req\)/);
        }
    });

    test('la clé existe dans les deux langues et ne se répète pas', () => {
        const fr = locale('fr', 'common');
        const en = locale('en', 'common');
        expect(fr.err_not_authorized_employee).toBe(
            "Vous n'êtes pas autorisé à agir sur ce collaborateur."
        );
        expect(en.err_not_authorized_employee).toBe(
            'You are not authorized to act on this employee.'
        );
        expect(
            sayText(
                reqFor('fr'),
                'common:err_not_authorized_employee',
                'Not authorized for this employee'
            )
        ).toBe(fr.err_not_authorized_employee);
        expect(
            sayText(
                reqFor('en'),
                'common:err_not_authorized_employee',
                'Not authorized for this employee'
            )
        ).toBe(en.err_not_authorized_employee);
        // Sans traducteur : la référence anglaise, jamais la clé.
        expect(
            sayText(null, 'common:err_not_authorized_employee', 'Not authorized for this employee')
        ).toBe('Not authorized for this employee');
        expect(
            sayText(
                { t: (k) => k },
                'common:err_not_authorized_employee',
                'Not authorized for this employee'
            )
        ).toBe('Not authorized for this employee');
    });
});
