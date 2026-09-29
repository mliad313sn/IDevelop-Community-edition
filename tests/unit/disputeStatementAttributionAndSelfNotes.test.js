'use strict';
/**
 * WHO SAID WHAT — TWO SURFACES THAT ANSWERED THE QUESTION WRONG.
 *
 * (1) RÉSIDU P2-11 — the employee's own file, unreadable to its author.
 *     `assessment_disputes.reason` is NOT NULL and is written first by the
 *     EMPLOYEE, then extended under an internal marker with the DECIDER's note
 *     (appendResolutionNote). Keeping both is closed. Rendering them was not.
 *     Measured over HTTP on a development database (own server, port 3603, one
 *     open and one resolved dispute posed then undone in a finally):
 *
 *       <div class="text-muted" style="font-size:.85em">MOTIF-EMPLOYE… \n
 *       [resolution:L0] NOTE-DECIDEUR…</div>
 *
 *     under « Note finale : 2 ». Three defects in one line:
 *       (a) no label — the manager's sentence read as the employee's;
 *       (b) the separator is an HTML newline and nothing applied `white-space`,
 *           so the browser welded the two sentences into one continuous line;
 *       (c) `[resolution:L0]`, an internal marker, was served to the person the
 *           decision is about.
 *     And a FOURTH: the reason was rendered only in the 'resolved' branch, so
 *     while their dispute was still open the employee could not re-read their
 *     own motive at all (witness sentence absent from the page: false).
 *
 * (2) CONSTAT 4 (moitié restante) — « Aucune note fournie » over a justification
 *     that exists. `SupervisorReviewController.review` builds `selfAssessment`
 *     from `SelfAssessmentModel.findById`, i.e. from the VIEW `self_assessments`
 *     (= rounds NOT superseded), so for a review that judged a REPLACED round it
 *     is null and the page told the reviewer the employee had justified nothing.
 *     Measured on the same server, review 1023 / round 223929 replaced on
 *     2026-09-13: base and model both carried « UAT3 lot1 - tour 1 », the page
 *     printed « Aucune note fournie », and nothing on it mentioned that the round
 *     had been replaced. The model already joins the rounds TABLE and returns the
 *     note of the round actually judged.
 *
 * Both are proven here by RENDERING the real templates with the real catalogues:
 * a missing key in either language throws, so FR/EN parity is part of the test.
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'views');
const LOCALES = path.join(ROOT, 'locales');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'DisputeServiceV2.js'), 'utf8');

// ---------------------------------------------------------------------------
// The real catalogues. A key absent from FR or from EN throws, so a one-language
// label can never reach a screen through this suite.
// ---------------------------------------------------------------------------
function translator(lang) {
    const cache = {};
    return function __(key, opts) {
        const [ns, k] = String(key).split(':');
        if (!cache[ns])
            cache[ns] = JSON.parse(fs.readFileSync(path.join(LOCALES, lang, ns + '.json'), 'utf8'));
        const v = cache[ns][k];
        if (v === undefined) throw new Error(`clé absente du catalogue ${lang}: ${key}`);
        return opts
            ? String(v).replace(/\{\{(\w+)\}\}/g, (m, n) =>
                  opts[n] === undefined ? m : String(opts[n])
              )
            : v;
    };
}
const render = (view, locals, lang = 'fr') =>
    ejs.render(
        fs.readFileSync(path.join(VIEWS, 'pages', view), 'utf8'),
        Object.assign(
            { __: translator(lang), lang, csrfToken: 'x', assetVersion: '1', cspNonce: 'n' },
            locals
        ),
        { filename: path.join(VIEWS, 'pages', view) }
    );

// ---------------------------------------------------------------------------
// The separator, taken from the COMPOSER itself. If appendResolutionNote ever
// writes a different marker, these inputs change with it and the reader must
// keep up — composer and decomposer cannot drift apart unnoticed.
// ---------------------------------------------------------------------------
const SEP_TEMPLATE = (() => {
    const m = SRC.match(/return `reason = COALESCE\(reason, ''\) \|\| E'([^']*)' \|\| \?`;/);
    if (!m)
        throw new Error(
            'appendResolutionNote introuvable — le marqueur ne peut plus être lu depuis la source'
        );
    return m[1].replace(/\\\\n/g, '\n'); // E'\\n\\n…' → vrais sauts de ligne côté PostgreSQL
})();
const compose = (level, motive, note) => motive + SEP_TEMPLATE.replace('${level}', level) + note;

// The two machine annotations, also read from the source so a reworded one fails
// here rather than leaking into the sentence attributed to the employee.
const markOf = (name) => {
    const m = SRC.match(new RegExp('const ' + name + " = '([^']+)'"));
    if (!m) throw new Error('marqueur introuvable: ' + name);
    return m[1];
};
const AUTO_MARK = markOf('AUTO_FINALIZED_MARK');
const HR_MARK = markOf('HR_REQUIRED_MARK');

const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MOTIVE = 'ma preuve de formation n a pas ete lue';
const NOTE = 'niveau maintenu a 2,\npreuve jugee insuffisante';

// DisputeServiceV2 pulls the DB and the notifier at require time.
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
}));
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(undefined),
}));
const DisputeServiceV2 = require('../../src/services/DisputeServiceV2');

// ===========================================================================
describe('P2-11 résidu — le motif et la note sont deux déclarations distinctes', () => {
    test('un litige RÉSOLU se relit en deux morceaux, sans le marqueur interne', () => {
        const s = DisputeServiceV2.splitReason(compose('L0', MOTIVE, NOTE));
        expect(s.employeeReason).toBe(MOTIVE);
        expect(s.resolutionNote).toBe(NOTE);
        expect(s.resolutionLevel).toBe('L0');
        expect(s.systemNotes).toEqual([]);
        // Le découpage se fait sur le marqueur : il ne se lit pas.
        expect(s.employeeReason).not.toMatch(/\[resolution:/);
        expect(s.resolutionNote).not.toMatch(/\[resolution:/);
    });

    test.each(['L0', 'L1', 'L2'])('le niveau décideur %s est rendu, pas deviné', (level) => {
        expect(DisputeServiceV2.splitReason(compose(level, MOTIVE, NOTE)).resolutionLevel).toBe(
            level
        );
    });

    test('un litige OUVERT rend le motif de son auteur et aucune note', () => {
        const s = DisputeServiceV2.splitReason(MOTIVE);
        expect(s.employeeReason).toBe(MOTIVE);
        expect(s.resolutionNote).toBeNull();
        expect(s.resolutionLevel).toBeNull();
    });

    test('une clôture automatique ne se déguise jamais en phrase du collaborateur', () => {
        const s = DisputeServiceV2.splitReason(MOTIVE + ' ' + AUTO_MARK);
        expect(s.employeeReason).toBe(MOTIVE);
        expect(s.systemNotes).toEqual(['auto_finalized']);
        expect(s.employeeReason).not.toContain('auto-finalized');
    });

    test('un arbitrage RH demandé, puis tranché, laisse chaque phrase à son auteur', () => {
        const s = DisputeServiceV2.splitReason(compose('L2', MOTIVE + ' ' + HR_MARK, NOTE));
        expect(s.employeeReason).toBe(MOTIVE);
        expect(s.resolutionNote).toBe(NOTE);
        expect(s.systemNotes).toEqual(['hr_arbitration_required']);
    });

    test('les deux annotations machine sont écrites avec EXACTEMENT le texte que le lecteur retire', () => {
        // Elles sont composées en SQL et retirées en JS par leur texte exact :
        // une reformulation d'un seul côté les ferait passer pour la phrase du
        // collaborateur. Les deux orthographes sont comparées ici.
        const auto = SRC.match(/reason = COALESCE\(reason,''\) \|\| ' (\[auto-finalized:[^']*\])'/);
        expect(auto).not.toBeNull();
        expect(auto[1]).toBe(AUTO_MARK);
        // Celle-ci est déjà passée en paramètre depuis la constante : rien à comparer.
        expect(SRC).toMatch(/SET reason = COALESCE\(reason, ''\) \|\| ' ' \|\| \?/);
        expect(SRC).toMatch(/\[HR_REQUIRED_MARK, d\.id\]/);
        expect(DisputeServiceV2.splitReason('x ' + AUTO_MARK).systemNotes).toEqual([
            'auto_finalized',
        ]);
        expect(DisputeServiceV2.splitReason('x ' + HR_MARK).systemNotes).toEqual([
            'hr_arbitration_required',
        ]);
    });

    test('une colonne vide ou absente ne fabrique aucune déclaration', () => {
        for (const v of [null, undefined, '', '   ']) {
            const s = DisputeServiceV2.splitReason(v);
            expect(s.employeeReason).toBeNull();
            expect(s.resolutionNote).toBeNull();
            expect(s.systemNotes).toEqual([]);
        }
    });

    test('listForEmployee remet les morceaux séparés à la page', () => {
        const db = require('../../src/config/database');
        db.all.mockResolvedValue([
            { id: 7, state: 'resolved', reason: compose('L0', MOTIVE, NOTE), deciderName: 'A B' },
        ]);
        return DisputeServiceV2.listForEmployee(138).then((rows) => {
            expect(db.all.mock.calls[0][0]).toMatch(/AS decider_name/);
            expect(rows[0]).toEqual(
                expect.objectContaining({
                    employeeReason: MOTIVE,
                    resolutionNote: NOTE,
                    resolutionLevel: 'L0',
                    deciderName: 'A B',
                })
            );
        });
    });
});

// ===========================================================================
describe('P2-11 résidu — la page employé nomme qui parle, dans TOUS les états', () => {
    const row = (extra) =>
        Object.assign(
            {
                id: 7,
                skillName: 'Adoption',
                selfRatedLevel: 3,
                supervisorRatedLevel: 3,
                gap: 0,
                decidedRating: null,
                deciderName: null,
            },
            DisputeServiceV2.splitReason(extra.reason),
            extra
        );

    const page = (disputes, lang) =>
        render('employee/supervisor-reviews.ejs', { reviews: [], disputes }, lang);

    test('résolu : deux blocs étiquetés, le décideur est nommé, le marqueur a disparu', () => {
        const html = page([
            row({
                state: 'resolved',
                decidedRating: 2,
                deciderName: 'Clara NOVAK',
                reason: compose('L0', MOTIVE, NOTE),
            }),
        ]);
        expect(html).toContain('Votre motif :');
        expect(html).toContain('Note de Clara NOVAK :');
        expect(html).toContain(MOTIVE);
        expect(html).toContain('preuve jugee insuffisante');
        expect(html).not.toContain('[resolution:L0]');
        // Deux DÉCLARATIONS, donc deux blocs : plus jamais un seul paragraphe.
        const between = html.slice(html.indexOf(MOTIVE), html.indexOf('preuve jugee insuffisante'));
        expect(between).toMatch(/<\/div>/);
        // Le texte porte ses propres sauts de ligne — ils doivent rester visibles,
        // sur CHACUNE des deux déclarations : sans cette règle le navigateur
        // recollait les phrases en une seule ligne continue.
        const wrapped = (txt) => new RegExp('<span style="white-space:pre-wrap">' + rx(txt));
        expect(html).toMatch(wrapped(MOTIVE));
        expect(html).toMatch(wrapped(NOTE));
    });

    test.each([
        ['open', 'sr_open'],
        ['escalated', 'sr_escalated'],
    ])('état %s : le motif de la personne reste lisible pendant la procédure', (state) => {
        const html = page([row({ state, reason: 'MOTIF-OUVERT ' + MOTIVE })]);
        expect(html).toContain('Votre motif :');
        expect(html).toContain('MOTIF-OUVERT ' + MOTIVE);
    });

    test('une décision sans auteur (clôture SLA) est annoncée comme telle, sans emprunter un nom', () => {
        const html = page([
            row({
                state: 'auto_finalized',
                decidedRating: 3,
                reason: MOTIVE + ' ' + AUTO_MARK,
            }),
        ]);
        expect(html).toContain('Votre motif :');
        expect(html).toContain(translator('fr')('employee:sr_sysnote_auto_finalized'));
        // Aucun bloc « note du décideur » : personne n'a écrit cette note.
        expect(html).not.toContain(translator('fr')('employee:sr_reason_decider'));
        expect(html).not.toMatch(/<strong>Note de .+ :<\/strong>/);
        expect(html).not.toContain('auto-finalized:');
    });

    test('parité FR/EN : les mêmes étiquettes existent dans les deux langues', () => {
        const d = [
            row({
                state: 'resolved',
                decidedRating: 2,
                deciderName: 'A B',
                reason: compose('L1', MOTIVE, NOTE),
            }),
        ];
        const en = page(d, 'en');
        expect(en).toContain('Your reason:');
        expect(en).toContain('Note from A B:');
        expect(en).not.toContain('[resolution:L1]');
        expect(page(d, 'fr')).toContain('Votre motif :');
    });
});

// ===========================================================================
describe("constat 4 — la justification du tour JUGÉ, et le fait qu'il a été remplacé", () => {
    const REVIEW = {
        id: 1023,
        employeeId: 138,
        skillName: 'Adoption',
        domainName: '6. People Management',
        supervisorRatedLevel: null,
        gapReason: null,
        supervisorNotes: null,
        selfRatedLevel: 3,
        selfAssessmentNotes: 'UAT3 lot1 - tour 1',
        supersededAt: '2026-09-13T14:44:34.989Z',
        supersededBy: '223932',
    };
    const EMP = { firstName: 'Sarah', lastName: 'YA' };
    // Ce que le contrôleur passe réellement pour un tour remplacé : la VUE ne le
    // porte plus, donc SelfAssessmentModel.findById() rend null.
    const page = (review, selfAssessment = null, lang = 'fr') =>
        render('supervisor/review.ejs', { review, employee: EMP, selfAssessment }, lang);

    test('la note du tour jugé est affichée, et « Aucune note fournie » ne ment plus', () => {
        const html = page(REVIEW);
        expect(html).toContain('UAT3 lot1 - tour 1');
        expect(html).not.toContain('Aucune note fournie');
    });

    test('la page dit que le tour a été remplacé, avec sa date et son remplaçant', () => {
        const html = page(REVIEW);
        expect(html).toMatch(/remplacé le 13\/09\/2026/);
        expect(html).toContain('223932');
    });

    test('un tour NON remplacé ne porte aucune mention de remplacement', () => {
        const html = page(Object.assign({}, REVIEW, { supersededAt: null, supersededBy: null }));
        expect(html).not.toMatch(/remplacé/);
        expect(html).toContain('UAT3 lot1 - tour 1');
    });

    test('la vue reste prioritaire quand elle porte bien le tour courant', () => {
        const html = page(Object.assign({}, REVIEW, { supersededAt: null }), {
            selfRatedLevel: 2,
            notes: 'note du tour courant',
        });
        expect(html).toContain('note du tour courant');
        expect(html).not.toContain('UAT3 lot1 - tour 1');
    });

    test("une auto-évaluation ABSENTE n'est pas rendue comme un zéro", () => {
        const html = page(
            Object.assign({}, REVIEW, { selfRatedLevel: null, selfAssessmentNotes: null })
        );
        // Le script de la page ne doit plus calculer l'écart contre 0.
        expect(html).toMatch(/const selfRating = null;/);
        expect(html).not.toMatch(/const selfRating\s*=\s*0;/);
        // …et l'écart n'est pas calculé du tout dans ce cas.
        expect(html).toMatch(/selfRating === null/);
        // La case affiche l'absence, pas un chiffre.
        expect(html).toMatch(/<p class="rating-value">—<\/p>/);
        expect(html).toContain('Aucune note fournie');
    });

    test('une note réelle est bien rendue comme un nombre, pas comme null', () => {
        expect(page(REVIEW)).toMatch(/const selfRating = 3;/);
    });

    test('parité FR/EN de la mention de remplacement', () => {
        const en = page(REVIEW, null, 'en');
        expect(en).toMatch(/replaced on 13\/09\/2026/);
        expect(en).toContain('223932');
        expect(en).toContain('UAT3 lot1 - tour 1');
    });
});
