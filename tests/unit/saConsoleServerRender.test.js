'use strict';
/**
 * LA CONSOLE DU SUPERVISEUR DOIT RENDRE SES LIGNES CÔTÉ SERVEUR.
 *
 * CE QUI ÉTAIT CASSÉ (mesuré le 2026-09-15) : `GET /supervisor/self-assessment-reviews`
 * servait 85 420 octets dont la zone utile valait exactement
 *   <div id="sa-people"><div class="card" style="padding:1rem">Chargement…</div>
 * — aucune donnée. Le contrôleur ne passait AUCUN modèle à la vue :
 *   reviewConsolePage = (req, res) => res.render('pages/supervisor/self-assessment-review', { title });
 * Six lignes plus bas, `myStatusPage` faisait l'inverse, avec ce commentaire :
 * « Server-render the initial rows so the page is usable WITHOUT JS (slow/flaky
 * mine-site browsers) instead of a permanent "Chargement…" ». Le correctif avait
 * été appliqué à l'écran de l'employé et pas à la console du réviseur.
 *
 * Conséquence : sur un poste de site au navigateur ancien ou avec une extension
 * bloquante, le réviseur ne voyait RIEN — et c'est aussi ce qui rendait tous les
 * refus invisibles, la page n'ayant aucun contenu de repli.
 *
 * CE QUE CES TESTS EMPÊCHENT :
 *  1. que la console reparte sans modèle ;
 *  2. qu'elle se filtre sur une campagne au rendu serveur (le filtre est une
 *     commande de l'utilisateur, jamais un défaut) ;
 *  3. qu'un ÉCHEC de lecture soit rendu comme une file VIDE — une absence de
 *     mesure présentée comme un zéro. En cas d'erreur le modèle vaut `null`, et la
 *     vue retombe sur le chemin JS, qui dit ce qui s'est passé.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const R = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

jest.mock('../../src/services/SelfAssessmentWorkflowService', () => ({
    reviewQueueByEmployee: jest.fn(),
    listForEmployee: jest.fn(),
}));
const svc = require('../../src/services/SelfAssessmentWorkflowService');
const controller = require('../../src/controllers/SelfAssessmentWorkflowController');

const QUEUE = [
    {
        employeeId: 138,
        firstName: 'Ada',
        lastName: 'LOVELACE',
        total: 2,
        pending: 1,
        counts: { submitted: 1, approved: 1 },
        cycles: [{ id: null, code: null }],
        items: [
            {
                id: 1,
                skillId: 7,
                skillName: 'Analyse de données',
                requiredLevel: 3,
                selfRatedLevel: 4,
                validatedLevel: 2,
                employeeNotes: 'ma justification',
                workflowState: 'submitted',
                commentCount: 0,
            },
            {
                id: 2,
                skillId: 8,
                skillName: 'Sécurité',
                requiredLevel: null,
                selfRatedLevel: null,
                validatedLevel: null,
                employeeNotes: '',
                workflowState: 'approved',
                commentCount: 0,
            },
        ],
    },
];

function res() {
    return {
        rendered: null,
        render(view, model) {
            this.rendered = { view, model };
        },
    };
}
const req = { user: { id: 136, userType: 'manager' }, t: (k) => k };

describe('le contrôleur passe la file à la vue', () => {
    test('la console rend les lignes du réviseur, sans filtre de campagne', async () => {
        svc.reviewQueueByEmployee.mockResolvedValue(QUEUE);
        const r = res();
        await controller.reviewConsolePage(req, r);
        expect(svc.reviewQueueByEmployee).toHaveBeenCalledWith(req.user, {});
        expect(r.rendered.view).toBe('pages/supervisor/self-assessment-review');
        expect(r.rendered.model.employees).toEqual(QUEUE);
    });

    test('une erreur de lecture rend NULL, jamais une liste vide', async () => {
        // [] afficherait « Rien en attente de votre revue » : une panne présentée
        // comme un résultat. null = « le serveur n'a pas pu répondre ».
        svc.reviewQueueByEmployee.mockRejectedValue(new Error('boom'));
        const r = res();
        await expect(controller.reviewConsolePage(req, r)).resolves.toBeUndefined();
        expect(r.rendered.model.employees).toBeNull();
    });
});

describe('la vue rend vraiment ces lignes', () => {
    const templatePath = path.join(
        ROOT,
        'views',
        'pages',
        'supervisor',
        'self-assessment-review.ejs'
    );
    const template = R('views', 'pages', 'supervisor', 'self-assessment-review.ejs');
    const FR = {
        'talentx:loading': 'Chargement…',
        'talentx:sar_nothing_awaiting': 'Rien en attente de votre revue.',
        'talentx:sar_server_rendered': 'Liste rendue par le serveur.',
        'talentx:sar_skills_pending': '{total} compétence(s) · {pending} en attente',
        'talentx:rvx_no_justification': 'Sans justification',
        'talentx:sar_st_submitted': 'Soumise',
        'talentx:sar_st_approved': 'Approuvée',
    };
    // `filename` so ejs can resolve an include(): this page now pulls in
    // views/partials/json-script.ejs, which escapes `<` so a reflected value
    // carrying `</script>` cannot break out of an inline block.
    const render = (employees) =>
        ejs.render(
            template,
            {
                __: (k) => (FR[k] !== undefined ? FR[k] : k),
                enumLabel: (ns, v) => String(v),
                cspNonce: 'n0nce',
                assetVersion: '1',
                lang: 'fr',
                employees,
            },
            { filename: templatePath }
        );

    test('les compétences, les niveaux et la justification sont dans le HTML servi', () => {
        const html = render(QUEUE);
        expect(html).toContain('Ada LOVELACE');
        expect(html).toContain('Analyse de données');
        expect(html).toContain('ma justification');
        expect(html).toContain('2 compétence(s) · 1 en attente');
        // et la zone ne se contente plus de son libellé d'attente
        expect(html).not.toMatch(/<div id="sa-people">\s*<div class="card"[^>]*>Chargement…/);
    });

    test("une absence de mesure s'écrit « — », jamais 0", () => {
        const html = render(QUEUE);
        // The whole row (3.23.21: the skill cell now also carries the « Qu'est-ce
        // que c'est ? » panel, so a fixed 400-character window no longer reaches
        // the level cells).
        const at = html.indexOf('Sécurité');
        const row = html.slice(at, html.indexOf('</tr>', at));
        expect(row).toContain('—');
        expect(row).not.toMatch(/sa-num">0</);
        expect(row).toContain('Sans justification');
    });

    test('file vide = « rien en attente » ; modèle absent = le chemin JS reprend la main', () => {
        expect(render([])).toContain('Rien en attente de votre revue.');
        expect(render(null)).toMatch(/<div id="sa-people">[\s\S]{0,120}Chargement…/);
    });

    test("aucun état de base ne fuit à l'écran : les libellés passent par le catalogue", () => {
        const html = render(QUEUE);
        expect(html).toContain('>Soumise<');
        expect(html).not.toMatch(/<td>\s*submitted\s*<\/td>/);
    });
});
