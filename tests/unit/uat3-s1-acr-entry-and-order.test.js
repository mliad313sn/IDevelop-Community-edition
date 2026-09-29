'use strict';

/**
 * RACINE S1 — « un chantier livré sans porte d'entrée », second tour.
 *
 * Le lot de correction avait posé l'entrée de menu ; la vérification
 * indépendante du 15/09/2026 a montré que les deux constats n'étaient tenus
 * qu'à moitié, et AUCUN test ne gardait quoi que ce soit (0 fichier sous
 * tests/ mentionnant `nav_acr`, 0 couvrant `raisable().others`).
 *
 * Ce fichier garde EXACTEMENT ce qui a été mesuré manquant :
 *
 *   E-02.1  le SUJET d'une demande déposée par son superviseur ne recevait
 *           RIEN — mesuré en base sur la demande #35 : une seule notification,
 *           pour le décideur (employé 137) ; l'employé 138, sujet de la
 *           réouverture de SON évaluation validée, ne l'apprenait qu'en
 *           ouvrant le menu de lui-même ;
 *   E-02.2  l'entrée n'existait QUE dans la barre latérale : comptage de la
 *           chaîne `assessment-changes` = 1 sur les 14 écrans employé, c'est-à-
 *           dire le menu seul, alors que le lot demandait « une entrée de menu
 *           + un href sur les écrans porteurs » ;
 *   E-02.3  aucun test ne gardait l'entrée ;
 *   E-02.4  le commentaire HTML interne de `sidebar.ejs` racontait le défaut
 *           dans la source de CHAQUE page, servie à tous les utilisateurs ;
 *   M-01    le refus d'annuler une évaluation validée ordonnait « déposez une
 *           demande de modification » AVANT toute porte de campagne : sur le
 *           jeu du 15/09 la démarche ordonnée repartait en 409 « La campagne
 *           2026-Q3 est verrouillée ». Le produit ordonnait une démarche
 *           qu'aucun contrôle ne permettait d'accomplir.
 *
 * La base est simulée, comme dans `uat3-lot24-change-requests.test.js` : chaque
 * test pilote le service avec des lignes fabriquées.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockLog = jest.fn(async () => {});
jest.mock('../../src/services/LogService', () => ({ log: mockLog }));

const mockNotify = jest.fn(async () => ({ inapp: 'ok' }));
jest.mock('../../src/services/NotificationService', () => ({ notify: mockNotify }));

const mockFindById = jest.fn();
// See the note in uat3-lot24-change-requests.test.js: `governs` is the
// transitive sub-tree test; every subject here is a DIRECT report, so `false`
// preserves each case exactly as it was written.
jest.mock('../../src/models/EmployeeModel', () => ({
    findById: mockFindById,
    governs: jest.fn(async () => false),
}));

let mockGate = { writable: true, code: null, message: null };
const gateThrow = () => {
    const e = new Error(mockGate.message);
    e.code = mockGate.code;
    e.gate = mockGate;
    return e;
};
jest.mock('../../src/services/CycleService', () => ({
    assertCycleWritable: jest.fn(async () => {
        if (mockGate.writable) return mockGate;
        throw gateThrow();
    }),
    cycleWriteGate: jest.fn(async () => ({ ...mockGate })),
}));

jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'superadmin',
    isLocalAdmin: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'localadmin',
    isViewer: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'viewer',
    canAccessEmployeeData: async () => true,
    scopeFilter: async () => ({ clause: '', params: [] }),
}));

const WF = require('../../src/services/SelfAssessmentWorkflowService');
const ACR = require('../../src/services/AssessmentChangeRequestService');

const EMPLOYEE = { id: 138, userType: 'employee' };
const SUPERVISOR = { id: 136, userType: 'manager' };
/** La personne 138 : superviseur 136, manager 137 — comme sur `idevelop`. */
const SUBJECT = { id: 138, supervisorId: 136, managerId: 137, managerType: 'employee' };

const sql = (call) => String(call[0]).replace(/\s+/g, ' ').trim();
const runs = () => mockDb.run.mock.calls.map(sql);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

/** Une évaluation VALIDÉE de la personne 138, décidée hier, hors campagne. */
const APPROVED = {
    id: 223929,
    employeeId: 138,
    skillId: 300,
    workflowState: 'approved',
    status: 'approved',
    cycleId: null,
    approvedAt: daysAgo(1),
    reviewedAt: null,
    submittedAt: daysAgo(4),
    skillName: 'Ways of Working',
};

function answer({ round, openRequest = null, inserted = null }) {
    mockDb.get.mockImplementation(async (text) => {
        const s = sql([text]);
        if (/FROM self_assessment_rounds r/.test(s)) return round || null;
        if (/FROM self_assessments WHERE id/.test(s)) {
            return round
                ? {
                      id: round.id,
                      employeeId: round.employeeId,
                      skillId: round.skillId,
                      workflowState: round.workflowState,
                      status: round.status,
                      cycleId: round.cycleId,
                      selfRatedLevel: 2,
                  }
                : null;
        }
        if (/cycle_id AS "cycleId" FROM self_assessment_rounds WHERE id/.test(s)) {
            return round ? { cycleId: round.cycleId } : null;
        }
        if (/FROM assessment_change_requests WHERE self_assessment_id = \? AND status/.test(s))
            return openRequest;
        if (/INSERT INTO assessment_change_requests/.test(s)) return inserted || { id: 91 };
        return null;
    });
}

beforeEach(() => {
    [mockDb.get, mockDb.all, mockDb.run, mockLog, mockNotify, mockFindById].forEach((m) =>
        m.mockReset()
    );
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1, rowCount: 1, lastID: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockResolvedValue(null);
    mockLog.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue({ inapp: 'ok' });
    mockFindById.mockResolvedValue(SUBJECT);
    mockGate = { writable: true, code: null, message: null };
});

// =========================================================================
//  1. E-02 — LA PORTE D'ENTRÉE EXISTE, ET ELLE EST GARDÉE
// =========================================================================
describe('E-02 — la demande de modification est atteignable depuis les écrans', () => {
    test('la barre latérale porte l’entrée de menu et ses deux clés, FR et EN', () => {
        const sidebar = read('views/partials/sidebar.ejs');
        expect(sidebar).toContain('href="/assessment-changes"');
        expect(sidebar).toContain('chrome:nav_acr_title');
        for (const lg of ['fr', 'en']) {
            const chrome = json(`locales/${lg}/chrome.json`);
            expect(typeof chrome.nav_acr).toBe('string');
            expect(chrome.nav_acr.trim().length).toBeGreaterThan(0);
            expect(typeof chrome.nav_acr_title).toBe('string');
        }
    });

    test('LES DEUX ÉCRANS PORTEURS portent un href, pas seulement le menu', () => {
        // Mesuré avant correction : comptage = 1 partout, c'est-à-dire le menu
        // seul — aucun lien là où se lit précisément la décision contestée.
        for (const view of [
            'views/pages/employee/assessment-status.ejs',
            'views/pages/employee/supervisor-reviews.ejs',
        ]) {
            const src = read(view);
            expect(src).toContain('href="/assessment-changes"');
            expect(src).toContain('employee:loop_acr_link');
        }
        for (const lg of ['fr', 'en']) {
            const emp = json(`locales/${lg}/employee.json`);
            expect(typeof emp.loop_acr_note).toBe('string');
            expect(typeof emp.loop_acr_link).toBe('string');
            expect(emp.loop_acr_note.trim().length).toBeGreaterThan(0);
            expect(emp.loop_acr_link.trim().length).toBeGreaterThan(0);
        }
    });

    test('AUCUN commentaire HTML de la barre latérale ne NOMME un constat : il serait SERVI', () => {
        // Un commentaire `<!-- -->` part dans la source de CHAQUE page, pour tous
        // les utilisateurs. Celui qui racontait E-02/M-01 y était.
        // Portée de cette garde : les commentaires qui nomment un constat ou un
        // lot. `sidebar.ejs` en porte d'autres, antérieurs, qui racontent des
        // défauts passés sans les nommer — même classe d'hygiène, mais ils
        // appartiennent aux lots qui les ont écrits ; ils sont signalés, pas
        // réécrits ici (douze réparateurs travaillent sur ce fichier partagé).
        const served = read('views/partials/sidebar.ejs').match(/<!--[\s\S]*?-->/g) || [];
        const telling = served.filter((c) => /\b(E-0\d|M-0\d|LOT [A-Z0-9])\b|constat/i.test(c));
        expect(telling).toEqual([]);
    });
});

// =========================================================================
//  2. E-02 — LE SUJET EST PRÉVENU, PAS SEULEMENT LE DÉCIDEUR
// =========================================================================
describe('E-02 — la demande déposée par un tiers est poussée à la personne concernée', () => {
    test('le superviseur dépose : le décideur ET le sujet sont notifiés', async () => {
        answer({ round: APPROVED, inserted: { id: 91 } });
        await ACR.create(223929, SUPERVISOR, { reason: 'Niveau retenu à revoir.' });
        const sent = mockNotify.mock.calls.map((c) => c[0]);
        // Le décideur d'une évaluation VALIDÉE : le manager (137).
        expect(sent).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    userType: 'employee',
                    userId: 137,
                    kind: 'sa.change_request_raised',
                }),
            ])
        );
        // LE SUJET (138) — c'est ce qui manquait : mesuré sur la demande #35, la
        // seule notification écrite allait au décideur.
        const toSubject = sent.filter((n) => n.userId === 138);
        expect(toSubject).toHaveLength(1);
        expect(toSubject[0].kind).toBe('sa.change_request_raised_on_me');
        expect(Number(toSubject[0].payload.changeRequestId)).toBe(91);
        expect(toSubject[0].payload.link).toBe('/assessment-changes');
    });

    test('la personne qui dépose SA PROPRE demande ne se notifie pas elle-même', async () => {
        answer({
            round: {
                ...APPROVED,
                workflowState: 'submitted',
                status: 'submitted',
                approvedAt: null,
            },
            inserted: { id: 92 },
        });
        await ACR.create(223929, EMPLOYEE, { reason: 'Saisie erronée.' });
        const sent = mockNotify.mock.calls.map((c) => c[0]);
        expect(sent.some((n) => n.userId === 136 && n.kind === 'sa.change_request_raised')).toBe(
            true
        );
        expect(sent.some((n) => n.kind === 'sa.change_request_raised_on_me')).toBe(false);
        expect(sent.some((n) => n.userId === 138)).toBe(false);
    });

    test('le nouveau `kind` a son libellé dans le catalogue, différent de celui du décideur', () => {
        const N = jest.requireActual('../../src/services/NotificationService');
        const meta = N.KIND_META['sa.change_request_raised_on_me'];
        expect(meta).toBeTruthy();
        expect(meta.title.fr).toBeTruthy();
        expect(meta.title.en).toBeTruthy();
        // « attend VOTRE décision » serait faux pour le sujet : il ne décide rien.
        expect(meta.title.fr).not.toBe(N.KIND_META['sa.change_request_raised'].title.fr);
        expect(meta.link).toBe('/assessment-changes');
        expect(N.KIND_LABELS['sa.change_request_raised_on_me']).toBeTruthy();
        expect(N.KIND_MESSAGES['sa.change_request_raised_on_me'].fr).toBeTruthy();
        expect(N.KIND_MESSAGES['sa.change_request_raised_on_me'].en).toBeTruthy();
    });
});

// =========================================================================
//  3. M-01 — CE QUE LE PRODUIT ORDONNE EST CE QU'IL PERMET
// =========================================================================
describe('M-01 — le refus d’annuler une évaluation validée dit ce qui est possible', () => {
    const catch_ = async (fn) => {
        try {
            await fn();
            return null;
        } catch (e) {
            return e;
        }
    };

    test('demande RECEVABLE : la phrase de référence est conservée', async () => {
        answer({ round: APPROVED });
        const e = await catch_(() => WF.cancelByReviewer(223929, SUPERVISOR, 'motif'));
        expect(e.code).toBe('CHANGE_REQUEST_REQUIRED');
        expect(e.i18n.key).toBe('assess:acr_err_cancel_approved');
        expect(e.message).toMatch(/raise a request for change instead/i);
        expect(runs().some((s) => /UPDATE self_assessments/.test(s))).toBe(false);
    });

    test('CAMPAGNE VERROUILLÉE : le refus porte la campagne et sa date, plus la sienne', async () => {
        // Le cas RÉELLEMENT mesuré le 15/09 sur l'évaluation 222258.
        mockGate = {
            writable: false,
            code: 'cycle_write_locked',
            message:
                'La campagne 2026-Q3 est verrouillée (échéance du 2026-08-31) : les revues en cours se ' +
                'terminent, aucune nouvelle saisie n’est acceptée.',
        };
        answer({ round: { ...APPROVED, cycleId: 9 } });
        const e = await catch_(() => WF.cancelByReviewer(223929, SUPERVISOR, 'motif'));
        expect(e.code).toBe('CHANGE_REQUEST_REQUIRED');
        expect(e.blockedBy).toBe('cycle_write_locked');
        expect(e.i18n.key).toBe('assess:acr_err_cancel_approved_cycle');
        expect(e.i18n.vars.gate).toMatch(/2026-Q3/);
        expect(runs().some((s) => /UPDATE self_assessments/.test(s))).toBe(false);
    });

    test('DÉLAI A7 DÉPASSÉ : le refus donne la date de la décision et celle de l’expiration', async () => {
        answer({ round: { ...APPROVED, approvedAt: daysAgo(91) } });
        const e = await catch_(() => WF.cancelByReviewer(223929, SUPERVISOR, 'motif'));
        expect(e.blockedBy).toBe('contest_window_expired');
        expect(e.i18n.key).toBe('assess:acr_err_cancel_approved_window');
        expect(e.i18n.vars.days).toBe(30);
        expect(e.i18n.vars.decided).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
        expect(e.i18n.vars.until).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    });

    test('DEMANDE DÉJÀ OUVERTE : le refus renvoie à celle qui existe, et la nomme', async () => {
        answer({ round: APPROVED, openRequest: { id: 35 } });
        const e = await catch_(() => WF.cancelByReviewer(223929, SUPERVISOR, 'motif'));
        expect(e.blockedBy).toBe('already_pending');
        expect(e.i18n.key).toBe('assess:acr_err_cancel_approved_pending');
        expect(e.i18n.vars.requestId).toBe(35);
    });

    test('la lecture est SANS EFFET : aucune écriture, et un échec de lecture ne change pas le refus', async () => {
        answer({ round: APPROVED });
        // La sonde tombe : le refus retombe sur la phrase de référence, il ne
        // disparaît pas et il ne devient pas une faute technique.
        const spy = jest
            .spyOn(ACR, 'whyNotRaisable')
            .mockRejectedValue(new Error('base indisponible'));
        const e = await catch_(() => WF.cancelByReviewer(223929, SUPERVISOR, 'motif'));
        expect(e.code).toBe('CHANGE_REQUEST_REQUIRED');
        expect(e.i18n.key).toBe('assess:acr_err_cancel_approved');
        spy.mockRestore();
        expect(
            runs().some((s) => /^(UPDATE|INSERT|DELETE)/i.test(s) && /self_assessments/.test(s))
        ).toBe(false);
    });

    test('les quatre phrases existent dans les DEUX langues, avec les mêmes variables', () => {
        const KEYS = [
            'acr_err_cancel_approved',
            'acr_err_cancel_approved_cycle',
            'acr_err_cancel_approved_window',
            'acr_err_cancel_approved_pending',
        ];
        const fr = json('locales/fr/assess.json');
        const en = json('locales/en/assess.json');
        const vars = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort();
        for (const k of KEYS) {
            expect(typeof fr[k]).toBe('string');
            expect(typeof en[k]).toBe('string');
            expect(vars(fr[k])).toEqual(vars(en[k]));
        }
        expect(vars(fr.acr_err_cancel_approved_cycle)).toEqual(['{{gate}}']);
        expect(vars(fr.acr_err_cancel_approved_window)).toEqual(
            ['{{days}}', '{{decided}}', '{{until}}'].sort()
        );
        expect(vars(fr.acr_err_cancel_approved_pending)).toEqual(['{{requestId}}']);
    });
});

// =========================================================================
//  4. M-01 — LA SECTION DE DÉPÔT DU SUPERVISEUR : LA SOURCE ET LE RENDU
// =========================================================================
describe('M-01 — `raisable().others` et le rendu de la section', () => {
    test('une évaluation VALIDÉE du périmètre est déposable ; une demande ouverte, un délai passé ou une campagne fermée l’excluent', async () => {
        const row = (over) => ({
            id: 1,
            employeeId: 500,
            skillId: 7,
            workflowState: 'approved',
            cycleId: null,
            approvedAt: daysAgo(2),
            reviewedAt: null,
            skillName: 'Sécurité',
            firstName: 'A',
            lastName: 'B',
            hasOpenRequest: false,
            ...over,
        });
        mockDb.get.mockResolvedValue(null); // aucune campagne ouverte
        mockDb.all.mockResolvedValue([
            row({ id: 11 }),
            row({ id: 12, hasOpenRequest: true }), // une demande y est déjà ouverte
            row({ id: 13, approvedAt: daysAgo(91) }), // A7 dépassé
        ]);
        const out = await ACR.raisable(SUPERVISOR);
        expect(out.others.map((r) => Number(r.id))).toEqual([11]);
        // La requête ne ramasse QUE des évaluations validées, et jamais les siennes.
        const q = mockDb.all.mock.calls
            .map(sql)
            .find((s) => /r\.workflow_state = 'approved'/.test(s));
        expect(q).toBeTruthy();
        expect(q).toMatch(/r\.employee_id <> \?/);
    });

    test('la page rend le formulaire de dépôt dès qu’une ligne est recevable, et s’explique quand il n’y en a aucune', async () => {
        const render = (othersRows) =>
            ejs.renderFile(path.join(ROOT, 'views/pages/assessment-changes/index.ejs'), {
                __: (k) => k,
                lang: 'fr',
                colon: ' :',
                csrfToken: 't',
                mine: [],
                queue: [],
                lockedRows: [],
                cancellable: [],
                canDecide: true,
                meRef: 'employee:136',
                othersRows,
            });
        const withRow = await render([
            {
                id: 11,
                skillId: 7,
                skillName: 'Sécurité',
                workflowState: 'approved',
                firstName: 'Awa',
                lastName: 'Costé',
            },
        ]);
        expect(withRow).toContain('action="/assessment-changes/raise"');
        expect(withRow).toContain('name="assessmentId"');
        expect(withRow).toContain('Awa');
        const empty = await render([]);
        expect(empty).not.toContain('action="/assessment-changes/raise"');
        // Un vide qui s'explique, jamais une section muette.
        expect(empty).toContain('assess:acr_raise_other_none');
        for (const lg of ['fr', 'en']) {
            const a = json(`locales/${lg}/assess.json`);
            expect(typeof a.acr_raise_other_none).toBe('string');
            expect(a.acr_raise_other_none.trim().length).toBeGreaterThan(0);
        }
    });
});
