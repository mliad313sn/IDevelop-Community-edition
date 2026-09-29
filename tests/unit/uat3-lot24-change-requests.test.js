'use strict';

// LOT UAT3-24 (lots 2 + 4) — la demande de modification, l'annulation par le
// superviseur, la porte de campagne et la traçabilité.
// Référentiel RH du 13/09/2026 : §1 (les règles du propriétaire), §3 règles 2,
// 4, 5, 15 et 16, arbitrage A7 ; RULES-assessment-change.md ; HR1-15/16/17,
// HR4-10/12/15/25.
//
// La base est simulée : chaque test pilote le service avec des lignes fabriquées
// et vérifie le SQL émis, l'événement, la ligne d'audit et la valeur rendue.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

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
// `governs` is the transitive sub-tree test resolveAuthority consults when the
// actor is not the DIRECT supervisor/manager. Every subject in this file IS a
// direct report, so `false` keeps each case meaning exactly what it meant
// before the sub-tree fix (authority then rests on isSupervisor/isManager, as
// it always did here).
jest.mock('../../src/models/EmployeeModel', () => ({
    findById: mockFindById,
    governs: jest.fn(async () => false),
}));

let mockGate = { writable: true, code: null, message: null };
const mockAssertCycleWritable = jest.fn(async () => {
    if (mockGate.writable) return mockGate;
    const e = new Error(mockGate.message);
    e.code = mockGate.code;
    e.gate = mockGate;
    throw e;
});
jest.mock('../../src/services/CycleService', () => ({
    assertCycleWritable: mockAssertCycleWritable,
}));

// Clearance : la vraie logique, sans base. L'autorité sur la PERSONNE est ce que
// ces tests exercent ; le périmètre d'un administrateur a ses propres tests.
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'superadmin',
    isLocalAdmin: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'localadmin',
    isViewer: (u) => Boolean(u) && u.userType === 'admin' && u.role === 'viewer',
    canAccessEmployeeData: async () => true,
    scopeFilter: async () => ({ clause: '', params: [] }),
}));

const WF = require('../../src/services/SelfAssessmentWorkflowService');
const ACR = require('../../src/services/AssessmentChangeRequestService');
const DSR = require('../../src/services/DSRService');

const EMPLOYEE = { id: 138, userType: 'employee' };
const SUPERVISOR = { id: 136, userType: 'manager' };
const MANAGER = { id: 137, userType: 'manager' };
const ADMIN = { id: 666, userType: 'admin', role: 'superadmin', username: 'uat.admin' };

/** La personne 138 : superviseur 136, manager 137 — comme sur `idevelop`. */
const SUBJECT = { id: 138, supervisorId: 136, managerId: 137, managerType: 'employee' };

const sql = (call) => String(call[0]).replace(/\s+/g, ' ').trim();
const runs = () => mockDb.run.mock.calls.map(sql);
const audit = (action) =>
    mockLog.mock.calls
        .map((c) => c[0])
        .filter((a) => a.action === action)
        .pop();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

beforeEach(() => {
    [
        mockDb.get,
        mockDb.all,
        mockDb.run,
        mockLog,
        mockNotify,
        mockFindById,
        mockAssertCycleWritable,
    ].forEach((m) => m.mockReset());
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1, rowCount: 1, lastID: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockResolvedValue(null);
    mockLog.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue({ inapp: 'ok' });
    mockFindById.mockResolvedValue(SUBJECT);
    mockGate = { writable: true, code: null, message: null };
    mockAssertCycleWritable.mockImplementation(async () => {
        if (mockGate.writable) return mockGate;
        const e = new Error(mockGate.message);
        e.code = mockGate.code;
        e.gate = mockGate;
        throw e;
    });
});

/**
 * Répond aux `db.get` dans l'ordre où le service les émet, en choisissant sur le
 * texte du SQL plutôt que sur un rang : un test ne doit pas casser parce qu'une
 * lecture a été ajoutée ailleurs.
 */
function answer({ round, request, openRequest = null, inserted = null }) {
    mockDb.get.mockImplementation(async (text) => {
        const s = sql([text]);
        if (/FROM self_assessment_rounds r/.test(s)) return round || null;
        if (/FROM self_assessments WHERE id/.test(s)) return round ? viewRow(round) : null;
        if (/cycle_id AS "cycleId" FROM self_assessment_rounds WHERE id/.test(s)) {
            return round ? { cycleId: round.cycleId } : null;
        }
        if (/FROM assessment_change_requests WHERE id/.test(s)) return request || null;
        if (/FROM assessment_change_requests WHERE self_assessment_id = \? AND status/.test(s))
            return openRequest;
        if (/INSERT INTO assessment_change_requests/.test(s)) return inserted || { id: 77 };
        if (/FROM supervisor_reviews sr JOIN/.test(s)) return null;
        return null;
    });
}

/** La ligne telle que `getAssessment` (la vue) la rend, en camelCase. */
function viewRow(r) {
    return {
        id: r.id,
        employeeId: r.employeeId,
        skillId: r.skillId,
        workflowState: r.workflowState,
        status: r.status,
        cycleId: r.cycleId,
        selfRatedLevel: r.self != null ? r.self : 2,
    };
}

const ROUND = {
    id: 223930,
    employeeId: 138,
    skillId: 300,
    workflowState: 'submitted',
    status: 'submitted',
    cycleId: null,
    approvedAt: null,
    reviewedAt: null,
    submittedAt: daysAgo(1),
    skillName: 'Ways of Working',
};

// =========================================================================
//  1. LA DEMANDE DE MODIFICATION EXISTE, ET ELLE EST COMPLÈTE
//     (référentiel §3 règle 5 — elle n'existait NULLE PART : ni table, ni
//     route, ni code, ce qui rendait deux règles du propriétaire inapplicables)
// =========================================================================
describe('la demande de modification — un objet de premier rang', () => {
    test('le motif est OBLIGATOIRE', async () => {
        answer({ round: ROUND });
        await expect(ACR.create(223930, EMPLOYEE, { reason: '   ' })).rejects.toThrow(
            /motif est obligatoire/i
        );
        expect(runs().some((s) => /INSERT INTO assessment_change_requests/.test(s))).toBe(false);
    });

    test('elle enregistre le demandeur, la cible, SON ÉTAT au moment de la demande, et la campagne', async () => {
        answer({ round: ROUND, inserted: { id: 77, status: 'pending' } });
        const cr = await ACR.create(223930, EMPLOYEE, { reason: 'Niveau saisi par erreur.' });
        expect(Number(cr.id)).toBe(77);
        const insert = mockDb.get.mock.calls.find((c) =>
            /INSERT INTO assessment_change_requests/.test(sql(c))
        );
        expect(insert).toBeTruthy();
        const params = insert[1];
        expect(params[0]).toBe(223930); // la cible
        expect(params[1]).toBe(138); // la personne concernée
        expect(params[2]).toBeNull(); // la campagne (hors campagne ici)
        expect(params[3]).toBe('employee:138'); // QUI demande
        expect(params[4]).toBe('employee');
        expect(params[5]).toBe('Niveau saisi par erreur.'); // POURQUOI
        expect(params[6]).toBe('submitted'); // l'état de la cible AU MOMENT de la demande
        expect(params[7]).toBe('submitted');
    });

    test('la demande est elle-même une ligne du journal de l’évaluation, et une ligne d’audit', async () => {
        answer({ round: ROUND, inserted: { id: 77 } });
        await ACR.create(223930, EMPLOYEE, { reason: 'Motif écrit.' });
        expect(runs().some((s) => /INSERT INTO self_assessment_events/.test(s))).toBe(true);
        const ev = mockDb.run.mock.calls.find((c) =>
            /INSERT INTO self_assessment_events/.test(sql(c))
        );
        expect(ev[1]).toContain('change_request_raised');
        expect(audit('SA_CHANGE_REQUEST_RAISED')).toBeTruthy();
        expect(audit('SA_CHANGE_REQUEST_RAISED').details).toMatch(/Motif écrit/);
    });

    test('le décideur est prévenu, et la demande est visible des DEUX côtés', async () => {
        answer({ round: ROUND, inserted: { id: 77 } });
        await ACR.create(223930, EMPLOYEE, { reason: 'Motif écrit.' });
        // La demande de l'employé remonte à son superviseur.
        expect(mockNotify).toHaveBeenCalledWith(
            expect.objectContaining({
                userType: 'employee',
                userId: 136,
                kind: 'sa.change_request_raised',
            })
        );
        // Les deux lectures existent et visent la même table.
        mockDb.all.mockResolvedValue([]);
        await ACR.listMine(EMPLOYEE);
        await ACR.queue(SUPERVISOR);
        const reads = mockDb.all.mock.calls.map(sql);
        expect(reads.every((s) => /FROM assessment_change_requests cr/.test(s))).toBe(true);
        // Le demandeur voit les siennes ET celles déposées sur son évaluation.
        expect(reads[0]).toMatch(/cr\.requester_ref = \?/);
        expect(reads[0]).toMatch(/cr\.employee_id = \?/);
    });
});

// =========================================================================
//  2. LES RÈGLES D'ÉDITION (référentiel §1, RULES-assessment-change.md A et B)
// =========================================================================
describe('qui peut modifier quoi, et quand', () => {
    test('ce qui est encore un brouillon se modifie DIRECTEMENT — aucune demande', async () => {
        answer({ round: { ...ROUND, workflowState: 'draft', status: 'draft' } });
        await expect(ACR.create(223930, EMPLOYEE, { reason: 'x' })).rejects.toThrow(
            /modifiez-la directement/i
        );
    });

    test('une NOUVELLE CAMPAGNE rouvre le tour : la personne répond librement', async () => {
        mockDb.get.mockImplementation(async (text) => {
            const s = sql([text]);
            if (/FROM self_assessment_rounds r/.test(s)) return { ...ROUND, cycleId: 9 };
            if (/assessment_cycles WHERE status = 'open'/.test(s))
                return { id: 11, code: '2026-Q4' };
            return null;
        });
        await expect(ACR.create(223930, EMPLOYEE, { reason: 'x' })).rejects.toThrow(
            /2026-Q4[\s\S]*redemande/i
        );
    });

    test('soumise dans la MÊME campagne : la demande est la seule route', async () => {
        answer({ round: { ...ROUND, cycleId: 9 }, inserted: { id: 77 } });
        mockDb.get.mockImplementation(async (text) => {
            const s = sql([text]);
            if (/FROM self_assessment_rounds r/.test(s)) return { ...ROUND, cycleId: 9 };
            if (/assessment_cycles WHERE status = 'open'/.test(s))
                return { id: 9, code: '2026-Q3' };
            if (/INSERT INTO assessment_change_requests/.test(s)) return { id: 77 };
            return null;
        });
        const cr = await ACR.create(223930, EMPLOYEE, { reason: 'Je me suis trompé.' });
        expect(Number(cr.id)).toBe(77);
    });

    test('le superviseur ANNULE directement tant que ce n’est pas validé — pas de demande', async () => {
        answer({ round: ROUND });
        await expect(ACR.create(223930, SUPERVISOR, { reason: 'x' })).rejects.toThrow(
            /annulez-la directement/i
        );
    });

    test('une seule demande OUVERTE par évaluation', async () => {
        answer({
            round: {
                ...ROUND,
                workflowState: 'approved',
                status: 'approved',
                approvedAt: daysAgo(2),
            },
            openRequest: { id: 5 },
        });
        await expect(ACR.create(223930, EMPLOYEE, { reason: 'x' })).rejects.toThrow(
            /déjà en cours/i
        );
    });

    test('A7 — 30 jours pour contester une décision, et la phrase donne les deux dates', async () => {
        answer({
            round: {
                ...ROUND,
                workflowState: 'approved',
                status: 'approved',
                approvedAt: daysAgo(45),
            },
        });
        await expect(ACR.create(223930, EMPLOYEE, { reason: 'x' })).rejects.toThrow(
            /délai[\s\S]*30 jours/i
        );
        answer({
            round: {
                ...ROUND,
                workflowState: 'approved',
                status: 'approved',
                approvedAt: daysAgo(10),
            },
            inserted: { id: 78 },
        });
        await expect(ACR.create(223930, EMPLOYEE, { reason: 'x' })).resolves.toBeTruthy();
    });

    test('aucun délai ne court tant que RIEN n’a été décidé — une absence n’est pas une date', async () => {
        answer({ round: { ...ROUND, submittedAt: daysAgo(400) }, inserted: { id: 79 } });
        await expect(ACR.create(223930, EMPLOYEE, { reason: 'x' })).resolves.toBeTruthy();
    });
});

// =========================================================================
//  3. LA DÉCISION — nommée, datée, motivée sur un refus ; l'octroi ROUVRE
// =========================================================================
describe('la décision', () => {
    const PENDING = {
        id: 77,
        selfAssessmentId: 223930,
        employeeId: 138,
        cycleId: null,
        requesterRef: 'employee:138',
        requesterRole: 'employee',
        reason: 'Motif.',
        targetState: 'submitted',
        targetStatus: 'submitted',
        status: 'pending',
    };

    test('un REFUS sans motif est refusé', async () => {
        answer({ round: ROUND, request: PENDING });
        await expect(ACR.decide(77, SUPERVISOR, { decision: 'refused' })).rejects.toThrow(
            /motif est obligatoire/i
        );
        expect(runs().some((s) => /UPDATE assessment_change_requests/.test(s))).toBe(false);
    });

    test('un refus motivé NOMME son décideur et sa date, et ne touche pas la ligne', async () => {
        answer({ round: ROUND, request: PENDING });
        await ACR.decide(77, SUPERVISOR, { decision: 'refused', reason: 'Le niveau est le bon.' });
        const upd = mockDb.run.mock.calls.find((c) =>
            /UPDATE assessment_change_requests/.test(sql(c))
        );
        expect(upd[1][0]).toBe('refused');
        expect(upd[1][1]).toBe('employee:136');
        expect(upd[1][3]).toBe('Le niveau est le bon.');
        expect(sql(upd)).toMatch(/decided_at = now\(\)/);
        // rien n'est rouvert
        expect(runs().some((s) => /UPDATE self_assessments SET workflow_state/.test(s))).toBe(
            false
        );
        expect(audit('SA_CHANGE_REQUEST_REFUSED')).toBeTruthy();
    });

    test('L’OCTROI est la seule chose qui rend la ligne à la personne', async () => {
        answer({ round: ROUND, request: PENDING });
        await ACR.decide(77, SUPERVISOR, { decision: 'granted' });
        const set = mockDb.run.mock.calls.find((c) =>
            /UPDATE self_assessments SET workflow_state/.test(sql(c))
        );
        expect(set).toBeTruthy();
        expect(set[1][0]).toBe('changes_requested');
        // et le `status` historique suit, sinon la file de revue la garderait
        expect(set[1]).toContain('draft');
        const ev = mockDb.run.mock.calls.find((c) =>
            /INSERT INTO self_assessment_events/.test(sql(c))
        );
        expect(ev[1]).toContain('change_request_granted');
        expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ userId: 138 }));
    });

    test('accorder sur une ligne VALIDÉE lève le tampon d’approbation, jamais le niveau officiel', async () => {
        const approved = {
            ...ROUND,
            workflowState: 'approved',
            status: 'approved',
            approvedAt: daysAgo(3),
        };
        answer({ round: approved, request: { ...PENDING, targetState: 'approved' } });
        await ACR.decide(77, ADMIN, { decision: 'granted' });
        const set = mockDb.run.mock.calls.find((c) =>
            /UPDATE self_assessments SET workflow_state/.test(sql(c))
        );
        expect(sql(set)).toMatch(/approved_by = \?/);
        expect(sql(set)).toMatch(/approved_by_ref = \?/);
        expect(sql(set)).toMatch(/locked_state = \?/);
        expect(set[1]).toContain(null);
        expect(set[1]).toContain('provisional');
        // le profil officiel n'est PAS réécrit ici
        expect(runs().some((s) => /skill_assessments/i.test(s))).toBe(false);
    });

    test('personne ne décide sa PROPRE demande', async () => {
        answer({
            round: ROUND,
            request: { ...PENDING, requesterRef: 'employee:136', requesterRole: 'supervisor' },
        });
        await expect(ACR.decide(77, SUPERVISOR, { decision: 'granted' })).rejects.toThrow(
            /cannot decide your own request/i
        );
    });

    test('une ligne VALIDÉE ne se rouvre que par le manager ou un administrateur', async () => {
        const approved = {
            ...ROUND,
            workflowState: 'approved',
            status: 'approved',
            approvedAt: daysAgo(3),
        };
        // 136 est le SUPERVISEUR de 138 : il peut superviser, pas manager.
        answer({ round: approved, request: { ...PENDING, targetState: 'approved' } });
        await expect(ACR.decide(77, SUPERVISOR, { decision: 'granted' })).rejects.toThrow(
            /manager\/admin only/i
        );
        answer({ round: approved, request: { ...PENDING, targetState: 'approved' } });
        await expect(ACR.decide(77, MANAGER, { decision: 'granted' })).resolves.toBeTruthy();
    });

    test('une demande déjà traitée ne se re-décide pas', async () => {
        answer({ round: ROUND, request: { ...PENDING, status: 'granted' } });
        await expect(
            ACR.decide(77, SUPERVISOR, { decision: 'refused', reason: 'x' })
        ).rejects.toThrow(/déjà été traitée/i);
    });
});

// =========================================================================
//  4. LA PORTE DE CAMPAGNE — branchée en tête de `_setState`, seul point de
//     passage des 7 transitions (lot 5 §3). Règle produit (2026-09-21) : la
//     porte ne s'applique qu'à une évaluation DÉJÀ APPROUVÉE — un verdict
//     finalisé ne se rouvre/annule/re-décide que pendant une campagne ouverte.
//     Tant que ce n'est pas approuvé, la saisie reste corrigible hors campagne
//     (voir assessmentEditGatingByApproval.test.js pour la règle complète).
// =========================================================================
describe('la porte de campagne', () => {
    const closed = () => {
        mockGate = {
            writable: false,
            code: 'cycle_write_closed',
            message:
                'La campagne UAT-2026 a été clôturée le 2026-09-01 : plus aucune écriture n’y est possible.',
            cycle: { id: 2, code: 'UAT-2026' },
        };
    };

    test('`_setState` passe par la porte AVANT toute écriture (ligne approuvée)', async () => {
        closed();
        // La porte ne garde qu'un verdict APPROUVÉ : l'état courant doit l'être
        // pour que la clôture de campagne refuse la ré-écriture.
        mockDb.get.mockResolvedValue({ cycleId: 2, workflowState: 'approved' });
        await expect(WF._setState(223930, 'approved', {}, null)).rejects.toThrow(/UAT-2026/);
        expect(runs().some((s) => /UPDATE self_assessments/.test(s))).toBe(false);
    });

    test('une ligne NON approuvée reste modifiable même campagne close (règle 2026-09-21)', async () => {
        closed();
        mockDb.get.mockResolvedValue({ cycleId: 2, workflowState: 'submitted' });
        // La porte ne se déclenche pas : aucune erreur de campagne, l'écriture passe.
        await expect(
            WF._setState(223930, 'reviewed', { status: 'reviewed' }, null)
        ).resolves.toBeUndefined();
        expect(mockAssertCycleWritable).not.toHaveBeenCalled();
    });

    test('le refus porte 409 et la phrase qui nomme la campagne, jamais un code nu', async () => {
        closed();
        let caught = null;
        try {
            await WF._assertCycleWritable(2, 'approved', null);
        } catch (e) {
            caught = e;
        }
        expect(caught.status).toBe(409);
        expect(caught.expose).toBe(true);
        expect(caught.message).toContain('UAT-2026');
        expect(caught.code).toBe('cycle_write_closed');
    });

    test('une mesure HORS CAMPAGNE (A6) n’est jamais transformée en refus', async () => {
        closed();
        await expect(WF._assertCycleWritable(null, 'approved', null)).resolves.toBeNull();
        expect(mockAssertCycleWritable).not.toHaveBeenCalled();
    });

    test('une écriture de REVUE laisse finir les revues d’une campagne verrouillée, pas les saisies', async () => {
        // La porte ne s'applique qu'à un verdict approuvé : l'état courant l'est,
        // de sorte que le drapeau allowReview soit exercé sur chaque transition.
        mockDb.get.mockResolvedValue({ cycleId: 9, workflowState: 'approved' });
        await WF._setState(223930, 'approved', {}, null, { cycleId: 9 });
        expect(mockAssertCycleWritable).toHaveBeenLastCalledWith(
            9,
            expect.objectContaining({ allowReview: true })
        );
        await WF._setState(223930, 'changes_requested', {}, null, { cycleId: 9 });
        expect(mockAssertCycleWritable).toHaveBeenLastCalledWith(
            9,
            expect.objectContaining({ allowReview: false })
        );
        await WF._setState(223930, 'submitted', {}, null, { cycleId: 9 });
        expect(mockAssertCycleWritable).toHaveBeenLastCalledWith(
            9,
            expect.objectContaining({ allowReview: false })
        );
    });

    test('une demande ne peut être ni DÉPOSÉE ni ACCORDÉE dans une campagne close', async () => {
        closed();
        answer({ round: { ...ROUND, cycleId: 2 } });
        await expect(ACR.create(223930, EMPLOYEE, { reason: 'x' })).rejects.toThrow(/UAT-2026/);
        answer({
            round: { ...ROUND, cycleId: 2 },
            request: {
                id: 77,
                selfAssessmentId: 223930,
                employeeId: 138,
                cycleId: 2,
                requesterRef: 'employee:138',
                requesterRole: 'employee',
                reason: 'r',
                targetState: 'submitted',
                status: 'pending',
            },
        });
        await expect(ACR.decide(77, SUPERVISOR, { decision: 'granted' })).rejects.toThrow(
            /UAT-2026/
        );
    });

    test('l’octroi ne rouvre JAMAIS la campagne — seul CycleService.reopenClosed le fait', () => {
        // Le code, commentaires retirés : ni l'un ni l'autre service ne touche
        // une campagne. Rouvrir un dossier ne rouvre pas le résultat publié.
        const noComments = (p) =>
            fs
                .readFileSync(path.join(__dirname, p), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');
        const src =
            noComments('../../src/services/AssessmentChangeRequestService.js') +
            noComments('../../src/services/SelfAssessmentWorkflowService.js');
        expect(src).not.toMatch(/reopenClosed\s*\(/);
        expect(src).not.toMatch(/UPDATE\s+assessment_cycles/i);
    });

    test('`MaintenanceService.reopenAssessment` passe aussi par la porte', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/MaintenanceService.js'),
            'utf8'
        );
        const fn = src.slice(
            src.indexOf('async reopenAssessment('),
            src.indexOf('async withdrawReview(')
        );
        expect(fn).toMatch(/assertCycleWritable/);
    });
});

// =========================================================================
//  5. L'ANNULATION PAR LE SUPERVISEUR / LE MANAGER (règle B du propriétaire)
// =========================================================================
describe('l’annulation par le superviseur ou le manager', () => {
    test('un ÉTAT plus un MOTIF, nommant l’auteur — jamais une suppression', async () => {
        answer({ round: ROUND });
        await WF.cancelByReviewer(223930, SUPERVISOR, 'Ouverte sur la mauvaise personne.');
        const set = mockDb.run.mock.calls.find((c) =>
            /UPDATE self_assessments SET workflow_state/.test(sql(c))
        );
        expect(set[1][0]).toBe('rejected');
        expect(set[1]).toContain('Ouverte sur la mauvaise personne.');
        expect(set[1]).toContain('employee:136');
        expect(sql(set)).toMatch(/cancelled_at = \?/);
        // RIEN n'est supprimé, nulle part.
        expect(runs().some((s) => /^DELETE/i.test(s))).toBe(false);
        expect(audit('SA_CANCELLED_BY_REVIEWER')).toBeTruthy();
    });

    test('le motif est obligatoire', async () => {
        answer({ round: ROUND });
        await expect(WF.cancelByReviewer(223930, SUPERVISOR, '  ')).rejects.toThrow(
            /reason is required/i
        );
        expect(runs().some((s) => /UPDATE self_assessments/.test(s))).toBe(false);
    });

    test('APRÈS validation l’annulation est refusée, et la demande est exigée', async () => {
        answer({ round: { ...ROUND, workflowState: 'approved', status: 'approved' } });
        let caught = null;
        try {
            await WF.cancelByReviewer(223930, SUPERVISOR, 'motif');
        } catch (e) {
            caught = e;
        }
        expect(caught.code).toBe('CHANGE_REQUEST_REQUIRED');
        expect(caught.message).toMatch(/request for change/i);
        expect(runs().some((s) => /UPDATE self_assessments/.test(s))).toBe(false);
    });

    test('un BROUILLON que l’employé n’a pas soumis est à lui : personne ne l’annule', async () => {
        answer({ round: { ...ROUND, workflowState: 'draft', status: 'draft' } });
        await expect(WF.cancelByReviewer(223930, SUPERVISOR, 'motif')).rejects.toThrow(
            /Cannot cancel from 'draft'/
        );
    });

    test('la personne ne s’annule pas elle-même', async () => {
        answer({ round: ROUND });
        await expect(WF.cancelByReviewer(223930, EMPLOYEE, 'motif')).rejects.toThrow(
            /Not authorized/i
        );
    });

    test('une annulation n’invente AUCUNE mesure — la compétence reste non mesurée', async () => {
        answer({ round: ROUND });
        await WF.cancelByReviewer(223930, SUPERVISOR, 'motif');
        // `_finalizeSupervisorReview` retomberait sur la note de l'employé et
        // écrirait « superviseur N, écart 0 » sur un dossier annulé (HR1-11).
        expect(runs().some((s) => /UPDATE supervisor_reviews SET decision/.test(s))).toBe(false);
        expect(runs().some((s) => /supervisor_rated_level/.test(s))).toBe(false);
    });
});

// =========================================================================
//  6. TRAÇABILITÉ (lot 4) — toute validation nomme un humain
//     Mesuré sur idevelop le 13/09/2026 : 44 des 134 évaluations approuvées ne
//     nommaient personne, parce que `approved_by` est une clé étrangère vers
//     `employees` et qu'un administrateur n'est pas un employé.
// =========================================================================
describe('toute validation nomme un humain', () => {
    const submitted = { ...ROUND, workflowState: 'submitted', status: 'submitted', self: 2 };

    test('une validation par un ADMINISTRATEUR nomme l’administrateur', async () => {
        answer({ round: submitted });
        await WF.approve(223930, ADMIN, null, null, null);
        const set = mockDb.run.mock.calls.find((c) =>
            /UPDATE self_assessments SET workflow_state/.test(sql(c))
        );
        expect(sql(set)).toMatch(/approved_by_ref = \?/);
        expect(set[1]).toContain('admin:666');
        // la colonne historique reste NULL : elle ne PEUT pas nommer un admin
        const i = sql(set)
            .split(',')
            .findIndex((p) => /approved_by = \?/.test(p));
        expect(i).toBeGreaterThanOrEqual(0);
    });

    test('une validation par un superviseur nomme la personne', async () => {
        answer({ round: submitted });
        await WF.approve(223930, SUPERVISOR, null, null, null);
        const set = mockDb.run.mock.calls.find((c) =>
            /UPDATE self_assessments SET workflow_state/.test(sql(c))
        );
        expect(set[1]).toContain('employee:136');
    });

    test('la validation manager et l’arbitrage la nomment aussi', async () => {
        answer({ round: { ...ROUND, workflowState: 'reviewed', status: 'reviewed' } });
        await WF.managerValidate(223930, ADMIN, null);
        let set = mockDb.run.mock.calls.find((c) =>
            /UPDATE self_assessments SET workflow_state/.test(sql(c))
        );
        expect(set[1]).toContain('admin:666');

        mockDb.run.mockClear();
        answer({ round: { ...ROUND, workflowState: 'reviewed', status: 'reviewed' } });
        await WF.arbitrate(223930, ADMIN, { outcome: 'approve' }, null);
        set = mockDb.run.mock.calls.find((c) =>
            /UPDATE self_assessments SET workflow_state/.test(sql(c))
        );
        expect(set[1]).toContain('admin:666');
    });

    test('la référence d’acteur distingue un administrateur d’un employé', () => {
        expect(WF._actorRef({ isAdmin: true }, { id: 666 })).toBe('admin:666');
        expect(WF._actorRef({ isAdmin: false }, { id: 136 })).toBe('employee:136');
        expect(WF._actorRef({ isAdmin: false }, null)).toBeNull();
    });

    test('la migration 116 reprend les lignes existantes SANS jamais inventer un auteur', () => {
        const m = fs.readFileSync(
            path.join(
                __dirname,
                '../../db/postgres/116_assessment_attribution_and_append_only.sql'
            ),
            'utf8'
        );
        // l'auteur n'est retenu que s'il existe encore
        expect(m).toMatch(/EXISTS \(SELECT 1 FROM public\.admins/);
        expect(m).toMatch(/EXISTS \(SELECT 1 FROM public\.employees/);
        // et seulement depuis l'événement qui a réellement porté la ligne à « approuvé »
        expect(m).toMatch(/ev\.to_state = 'approved'/);
        // à défaut : dit explicitement qu'il est inconnu
        expect(m).toMatch(/'unknown'/);
        // et une approbation sans auteur n'est plus constructible
        expect(m).toMatch(/chk_sa_approval_named/);
    });
});

// =========================================================================
//  7. TRAÇABILITÉ — le journal d'événements est en AJOUT SEUL
// =========================================================================
describe('le journal d’événements en ajout seul', () => {
    test('la migration 116 pose les deux mêmes gardes que system_logs', () => {
        const m = fs.readFileSync(
            path.join(
                __dirname,
                '../../db/postgres/116_assessment_attribution_and_append_only.sql'
            ),
            'utf8'
        );
        expect(m).toMatch(
            /BEFORE DELETE OR UPDATE ON public\.self_assessment_events[\s\S]*block_mutation/
        );
        // TRUNCATE n'est pas un événement de ligne : il lui faut sa propre garde
        expect(m).toMatch(/BEFORE TRUNCATE ON public\.self_assessment_events[\s\S]*block_truncate/);
    });

    test('aucun chemin du produit ne modifie ni ne supprime une ligne du journal', () => {
        const dir = path.join(__dirname, '../../src');
        const files = [];
        (function walk(d) {
            for (const f of fs.readdirSync(d, { withFileTypes: true })) {
                if (f.isDirectory()) walk(path.join(d, f.name));
                else if (f.name.endsWith('.js')) files.push(path.join(d, f.name));
            }
        })(dir);
        const offenders = files.filter((f) => {
            const s = fs.readFileSync(f, 'utf8');
            return /(UPDATE|DELETE\s+FROM|TRUNCATE)\s+self_assessment_events/i.test(s);
        });
        expect(offenders).toEqual([]);
    });
});

// =========================================================================
//  8. TRAÇABILITÉ — l'export et l'effacement disent la MÊME chose
//     « On ne peut pas tenir qu'une note est la donnée personnelle du sujet
//       pour la DÉTRUIRE et pas pour la LUI MONTRER. » (HR4-10)
// =========================================================================
describe('export et effacement : la même liste', () => {
    const src = () =>
        fs.readFileSync(path.join(__dirname, '../../src/services/DSRService.js'), 'utf8');

    test('CHAQUE catégorie que l’effacement redacte est rendue par l’export', async () => {
        const calls = [];
        mockDb.all.mockImplementation(async (text) => {
            calls.push(sql([text]));
            return [];
        });
        // Intention conservée ; `db.get` est capturé lui aussi depuis que la liste
        // déclare la catégorie `profile` (table `employees`), lue par `export()`
        // via `db.get` et non `db.all` — sans cette capture le test ne verrait pas
        // la requête du dossier de la personne.
        mockDb.get.mockImplementation(async (text) => {
            calls.push(sql([text]));
            return { id: 138 };
        });
        const out = await DSR.export(138);
        for (const c of DSR.REDACTED_ON_ERASURE) {
            expect(Object.keys(out)).toContain(c.key);
            expect(calls.some((s) => s.includes(c.table))).toBe(true);
        }
    });

    test('et chaque catégorie ÉCRITE SUR la personne aussi : revue, litiges, demandes, cycle de vie', async () => {
        mockDb.all.mockResolvedValue([]);
        mockDb.get.mockResolvedValue({ id: 138 });
        const out = await DSR.export(138);
        for (const c of DSR.DISCLOSED_ABOUT_SUBJECT) expect(Object.keys(out)).toContain(c.key);
        expect(Object.keys(out)).toEqual(
            expect.arrayContaining([
                'supervisorReviews',
                'disputes',
                'nineBox',
                'calibrationAdjustments',
                'coachingSessions',
                'coachingPlans',
                'coachingGrow',
                'lifecycleEvents',
            ])
        );
    });

    test('l’effacement touche bien chaque table de la liste', () => {
        const erase = src().slice(src().indexOf('async erase('));
        for (const c of DSR.REDACTED_ON_ERASURE) expect(erase).toContain(c.table);
    });

    test('l’effacement atteint TOUS les tours, pas seulement la mesure courante', () => {
        // `self_assessments` est la vue du tour COURANT depuis la migration 113 :
        // l'effacement laissait donc les réponses antérieures lisibles.
        const erase = src().slice(src().indexOf('async erase('));
        expect(erase).toMatch(
            /UPDATE self_assessment_rounds SET notes = NULL, justification = NULL/
        );
        expect(erase).not.toMatch(/UPDATE self_assessments SET notes/);
    });

    test('l’export lit l’historique des tours, jamais la vue du tour courant', async () => {
        const calls = [];
        mockDb.all.mockImplementation(async (text) => {
            calls.push(sql([text]));
            return [];
        });
        mockDb.get.mockResolvedValue({ id: 138 });
        await DSR.export(138);
        const sa = calls.find((s) => /self_rated_level/.test(s) && /round_no/.test(s));
        expect(sa).toBeTruthy();
        expect(sa).toMatch(/FROM self_assessment_rounds/);
    });
});

// =========================================================================
//  9. TRAÇABILITÉ — l'acteur n'est jamais attribué à la mauvaise personne,
//     et un audit avalé n'avorte jamais la transaction de son appelant.
// =========================================================================
describe('l’acteur et l’audit', () => {
    test('un audit est écrit sous SAVEPOINT et porte toujours sa référence d’acteur', async () => {
        answer({ round: ROUND });
        const req = { user: SUPERVISOR, ip: '127.0.0.1', get: () => 'jest' };
        await WF.cancelByReviewer(223930, SUPERVISOR, 'motif', req);
        expect(mockDb.runInSavepoint).toHaveBeenCalled();
        const a = audit('SA_CANCELLED_BY_REVIEWER');
        expect(a.actorRef).toBe('employee:136');
        expect(a.adminId).toBe(136);
    });

    test('LogService refuse de ranger un employé dans `admin_id` (collision d’identifiants)', async () => {
        // Mesuré sur idevelop : l'administrateur #87 et l'employé #87 coexistent.
        // Sans cette règle, l'action de l'employé passait la clé étrangère et
        // était enregistrée en silence au nom de CET administrateur (HR4-25).
        jest.resetModules();
        const created = [];
        jest.doMock('../../src/models/SystemLogModel', () => ({
            create: async (r) => {
                created.push(r);
            },
        }));
        const Log = jest.requireActual('../../src/services/LogService');
        await Log.log({ action: 'X', adminId: 87, actorRef: 'employee:87' });
        await Log.log({ action: 'X', adminId: 87, actorRef: 'admin:87' });
        await Log.log({ action: 'X', adminId: 87 });
        expect(created).toHaveLength(3);
        expect(created[0].adminId).toBeNull();
        expect(created[0].actorRef).toBe('employee:87');
        expect(created[1].adminId).toBe(87);
        expect(created[2].adminId).toBe(87); // appelant muet : comportement inchangé
        jest.dontMock('../../src/models/SystemLogModel');
        jest.resetModules();
    });
});
