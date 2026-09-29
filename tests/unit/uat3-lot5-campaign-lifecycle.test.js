'use strict';

// SECTION campaign-rules — cycle de vie des campagnes : A5, A6, A8 et la règle 12
// (référentiel RH du 13/09/2026).
//
//   A5  Une campagne CLOSE ne se rouvre que par un SuperAdmin, dans les 30 jours
//       suivant la clôture, avec un motif obligatoire, tracée comme dérogation.
//   A6  La mesure hors campagne est autorisée, datée, marquée « hors campagne »
//       et n'entre JAMAIS dans un taux de complétion.
//   A8  Une campagne en retard est SIGNALÉE et sa clôture PROPOSÉE après 21 jours.
//       Elle n'est jamais fermée d'office.
//   R12 Un changement de rôle ne réduit jamais silencieusement le nombre de
//       compétences conçu par le département.
//
// La base est simulée : chaque test pilote le service avec des lignes fabriquées
// et vérifie le SQL émis, la ligne d'audit et la valeur rendue.
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

const mockEnqueue = jest.fn(async () => 0);
const mockNotify = jest.fn(async () => ({ inapp: 'ok' }));
jest.mock('../../src/services/NotificationService', () => ({
    notify: mockNotify,
    enqueueBulkInApp: mockEnqueue,
}));

let mockSettings = {};
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) =>
        Object.prototype.hasOwnProperty.call(mockSettings, k) ? mockSettings[k] : d
    ),
}));

const CycleService = require('../../src/services/CycleService');

const SUPER = { userType: 'admin', role: 'superadmin', id: 666, username: 'uat.admin' };
const auditFor = (action) =>
    mockLog.mock.calls
        .map((c) => c[0])
        .filter((a) => a.action === action)
        .pop();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

beforeEach(() => {
    [mockDb.get, mockDb.all, mockDb.run, mockLog, mockNotify, mockEnqueue].forEach((m) =>
        m.mockReset()
    );
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
    mockLog.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue({ inapp: 'ok' });
    mockEnqueue.mockResolvedValue(0);
    mockDb.run.mockResolvedValue({ changes: 1, lastID: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockResolvedValue(null);
    mockSettings = {};
});

// =========================================================================
//  A5 — la porte d'écriture : une campagne fermée refuse toute écriture, et le
//  refus NOMME la campagne et sa date de clôture.
// =========================================================================
describe('A5 — la porte d’écriture d’une campagne', () => {
    test('une campagne CLOSE refuse l’écriture et la phrase nomme la campagne et sa date', async () => {
        mockDb.get.mockResolvedValue({
            id: 2,
            code: 'UAT-2026',
            status: 'closed',
            closedAt: new Date('2026-09-01T10:00:00Z'),
        });
        const gate = await CycleService.cycleWriteGate(2);
        expect(gate.writable).toBe(false);
        expect(gate.code).toBe('cycle_write_closed');
        expect(gate.message).toContain('UAT-2026');
        // CLÔTURE UAT3 — intention inchangée (la phrase NOMME la date de clôture) ;
        // seule la GRAPHIE change : dd/MM/aaaa comme partout ailleurs dans le produit,
        // jamais l'ISO d'une phrase française (classe E-13). Le contrat machine, lui,
        // garde l'ISO — c'est `gate.cycle.closedAt`, vérifié juste en dessous.
        expect(gate.message).toContain('01/09/2026');
        expect(gate.message).not.toContain('2026-09-01');
        expect(gate.cycle.closedAt).toBe('2026-09-01');
        expect(gate.message).toMatch(/clôturée/);
        // jamais un jour anglais issu de String(Date) (piège L6-11)
        expect(gate.message).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
    });

    test('une campagne VERROUILLÉE refuse la saisie mais laisse finir une revue', async () => {
        mockDb.get.mockResolvedValue({
            id: 9,
            code: '2026-Q3',
            status: 'locked',
            closesAt: new Date('2026-08-31T00:00:00Z'),
        });
        const write = await CycleService.cycleWriteGate(9);
        expect(write.writable).toBe(false);
        expect(write.code).toBe('cycle_write_locked');
        expect(write.message).toContain('2026-Q3');
        // même intention, graphie du lecteur (cf. A5 ci-dessus)
        expect(write.message).toContain('31/08/2026');
        expect(write.message).not.toContain('2026-08-31');
        expect(write.cycle.closesAt).toBe('2026-08-31');
        const review = await CycleService.cycleWriteGate(9, { allowReview: true });
        expect(review.writable).toBe(true);
        expect(review.code).toBeNull();
    });

    test('une campagne close SANS date de clôture enregistrée le dit — l’échéance n’est pas une date de clôture', async () => {
        // Le piège : substituer closes_at à closed_at faisait dire « clôturée le
        // 2026-09-30 » à une campagne dont la date de clôture n'a jamais été écrite.
        mockDb.get.mockResolvedValue({
            id: 2,
            code: 'UAT-2026',
            status: 'closed',
            closedAt: null,
            closesAt: new Date('2026-09-30T00:00:00Z'),
        });
        const g = await CycleService.cycleWriteGate(2);
        expect(g.code).toBe('cycle_write_closed');
        expect(g.message).toMatch(/date de clôture non enregistrée/);
        expect(g.message).not.toContain('2026-09-30');
        expect(g.message).not.toContain('30/09/2026');
    });

    test('un brouillon et une campagne annulée refusent aussi, chacun avec sa phrase', async () => {
        mockDb.get.mockResolvedValue({ id: 11, code: 'BROUILLON', status: 'draft' });
        expect((await CycleService.cycleWriteGate(11)).code).toBe('cycle_write_draft');
        mockDb.get.mockResolvedValue({
            id: 12,
            code: 'ANNUL',
            status: 'cancelled',
            cancelledAt: new Date('2026-07-09T00:00:00Z'),
        });
        const g = await CycleService.cycleWriteGate(12);
        expect(g.code).toBe('cycle_write_cancelled');
        expect(g.message).toContain('09/07/2026');
        expect(g.message).not.toContain('2026-07-09');
    });

    test('une campagne OUVERTE accepte l’écriture', async () => {
        mockDb.get.mockResolvedValue({
            id: 9,
            code: '2026-Q3',
            status: 'open',
            closesAt: new Date('2026-12-31T00:00:00Z'),
        });
        const g = await CycleService.cycleWriteGate(9);
        expect(g.writable).toBe(true);
        expect(g.message).toBeNull();
    });

    test('A6 — l’absence de campagne N’EST PAS un refus : c’est « hors campagne »', async () => {
        const g = await CycleService.cycleWriteGate(null);
        expect(g.writable).toBe(true);
        expect(g.scope).toBe(CycleService.OFF_CAMPAIGN_SCOPE);
        expect(g.cycle).toBeNull();
        expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('assertCycleWritable lève une erreur qui porte le code ET la phrase', async () => {
        mockDb.get.mockResolvedValue({
            id: 2,
            code: 'UAT-2026',
            status: 'closed',
            closedAt: new Date('2026-09-01T10:00:00Z'),
        });
        await expect(CycleService.assertCycleWritable(2)).rejects.toMatchObject({
            code: 'cycle_write_closed',
        });
        const e = await CycleService.assertCycleWritable(2).catch((x) => x);
        expect(e.message).toContain('UAT-2026');
        expect(e.gate.cycle.closedAt).toBe('2026-09-01');
    });

    test('le traducteur de la requête est utilisé quand il est fourni (parité FR/EN)', async () => {
        mockDb.get.mockResolvedValue({
            id: 2,
            code: 'UAT-2026',
            status: 'closed',
            closedAt: new Date('2026-09-01T10:00:00Z'),
        });
        const seen = [];
        const t = (key, vars) => {
            seen.push({ key, vars });
            return `EN ${vars.cycle} ${vars.date}`;
        };
        const g = await CycleService.cycleWriteGate(2, { t });
        expect(seen[0].key).toBe('admin:cyc_err_cycle_write_closed');
        // CLÔTURE UAT3 : la variable passée au traducteur est la date TELLE QU'ELLE
        // S'AFFICHE (dd/MM/aaaa) — les deux langues impriment donc la même graphie,
        // ce que la parité exige. L'ISO reste dans `gate.cycle.*` (contrat machine).
        expect(seen[0].vars).toMatchObject({ cycle: 'UAT-2026', date: '01/09/2026' });
        expect(g.message).toBe('EN UAT-2026 01/09/2026');
        expect(g.cycle.closedAt).toBe('2026-09-01');
    });

    test('_assertRunning refuse avec la MÊME phrase (excuser / relancer dans une campagne close)', async () => {
        mockDb.get.mockResolvedValue({
            id: 2,
            code: 'UAT-2026',
            status: 'closed',
            closedAt: new Date('2026-09-01T10:00:00Z'),
        });
        const e = await CycleService._assertRunning(2).catch((x) => x);
        expect(e.code).toBe('cycle_write_closed');
        expect(e.message).toContain('UAT-2026');
    });
});

// =========================================================================
//  A5 — réouverture d'une campagne close : 30 jours, motif, dérogation tracée.
// =========================================================================
describe('A5 — réouverture d’une campagne close', () => {
    const closed = (days) => ({
        id: 6,
        code: 'UAT-RERUN',
        status: 'closed',
        closedAt: new Date(`${daysAgo(days)}T09:00:00Z`),
        closesAt: new Date('2026-12-31T00:00:00Z'),
    });

    test('dans les 30 jours, avec un motif → acceptée et tracée comme dérogation', async () => {
        mockDb.get.mockResolvedValue(closed(5));
        const r = await CycleService.reopenClosed(
            6,
            { closesAt: inDays(20), reason: 'Clôture prononcée par erreur.' },
            SUPER
        );
        expect(r).toMatchObject({
            reopened: true,
            override: true,
            daysSinceClose: 5,
            windowDays: 30,
        });

        const sql = mockDb.run.mock.calls.map((c) => String(c[0])).join(' ');
        expect(sql).toMatch(/reopen_override_at\s*=\s*now\(\)/);
        expect(sql).toMatch(/reopen_override_count\s*=\s*reopen_override_count\s*\+\s*1/);
        expect(sql).toMatch(/status\s*=\s*'open'/);
        // La proposition de clôture encore ouverte est CLASSÉE, jamais supprimée.
        expect(sql).toMatch(/UPDATE cycle_closure_proposals[\s\S]*state\s*=\s*'declined'/);
        expect(sql).not.toMatch(/DELETE\s+FROM\s+cycle_closure_proposals/i);

        const a = auditFor('cycle_reopened_override');
        expect(a.details).toContain('DÉROGATION');
        expect(a.details).toContain('Clôture prononcée par erreur.');
        expect(a.details).toContain(daysAgo(5));
        expect(a.details).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
    });

    test('le 30e jour passe encore, le 31e est refusé avec le nombre de jours', async () => {
        mockDb.get.mockResolvedValue(closed(30));
        await expect(
            CycleService.reopenClosed(6, { closesAt: inDays(20), reason: 'jour 30' }, SUPER)
        ).resolves.toMatchObject({ reopened: true, daysSinceClose: 30 });

        mockDb.run.mockClear();
        mockDb.get.mockResolvedValue(closed(31));
        const e = await CycleService.reopenClosed(
            6,
            { closesAt: inDays(20), reason: 'jour 31' },
            SUPER
        ).catch((x) => x);
        expect(e.code).toBe('cycle_reopen_window_expired');
        expect(e.days).toBe(31);
        expect(e.windowDays).toBe(30);
        // rien n'a été écrit
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('sans motif → refus (le motif est obligatoire, comme partout ailleurs)', async () => {
        mockDb.get.mockResolvedValue(closed(3));
        await expect(
            CycleService.reopenClosed(6, { closesAt: inDays(20), reason: '   ' }, SUPER)
        ).rejects.toMatchObject({ code: 'reopen_reason_required' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('une date de clôture NON ENREGISTRÉE est refusée — on n’invente pas une date', async () => {
        mockDb.get.mockResolvedValue({ id: 2, code: 'UAT-2026', status: 'closed', closedAt: null });
        await expect(
            CycleService.reopenClosed(2, { closesAt: inDays(20), reason: 'erreur' }, SUPER)
        ).rejects.toMatchObject({ code: 'cycle_closed_at_unknown' });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('une campagne qui n’est pas close ne passe pas par cette porte', async () => {
        mockDb.get.mockResolvedValue({ id: 9, code: '2026-Q3', status: 'locked' });
        await expect(
            CycleService.reopenClosed(9, { closesAt: inDays(20), reason: 'x' }, SUPER)
        ).rejects.toMatchObject({ code: 'cycle_not_closed' });
    });

    test('une nouvelle échéance dans le passé est refusée', async () => {
        mockDb.get.mockResolvedValue(closed(2));
        await expect(
            CycleService.reopenClosed(6, { closesAt: daysAgo(1), reason: 'x' }, SUPER)
        ).rejects.toMatchObject({ code: 'cycle_deadline_past' });
    });
});

// =========================================================================
//  A8 — la campagne en retard est signalée et PROPOSÉE, jamais fermée d'office.
// =========================================================================
describe('A8 — proposition de clôture', () => {
    const overdue = (days) => ({
        id: 9,
        code: '2026-Q3',
        status: 'locked',
        closesAt: new Date(`${daysAgo(days)}T00:00:00Z`),
    });

    const funnel = () => [
        {
            state: 'not_started',
            n: 75,
            expected: 3200,
            rated: 0,
            submitted: 0,
            approved: 0,
            rejected: 0,
        },
        {
            state: 'in_progress',
            n: 1,
            expected: 83,
            rated: 45,
            submitted: 0,
            approved: 0,
            rejected: 0,
        },
    ];

    test('le délai par défaut est 21 jours', async () => {
        expect(CycleService.CLOSURE_PROPOSAL_DEFAULT_DAYS).toBe(21);
        expect(await CycleService.closureProposalDays()).toBe(21);
    });

    test('le réglage cycleClosureProposalDays l’emporte, l’ancien cycleAutoCloseGraceDays sert de repli', async () => {
        mockSettings = { cycleClosureProposalDays: 14 };
        expect(await CycleService.closureProposalDays()).toBe(14);
        mockSettings = { cycleAutoCloseGraceDays: 7 };
        expect(await CycleService.closureProposalDays()).toBe(7);
    });

    test('avant le seuil : rien n’est proposé', async () => {
        mockDb.get.mockResolvedValue(overdue(13));
        mockSettings = { cycleClosureProposalDays: 21 };
        const r = await CycleService.proposeClosure(9);
        expect(r).toMatchObject({
            proposed: false,
            reason: 'too_early',
            overdueDays: 13,
            proposalDays: 21,
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('au-delà du seuil : une proposition est ouverte avec l’instantané du reste à faire — et RIEN n’est clôturé', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM cycle_closure_proposals/i.test(String(sql))) return null;
            return overdue(25);
        });
        mockDb.all.mockResolvedValue(funnel());
        mockSettings = { cycleClosureProposalDays: 21 };
        const r = await CycleService.proposeClosure(9);
        expect(r.proposed).toBe(true);
        expect(r.overdueDays).toBe(25);
        expect(r.snapshot).toMatchObject({ neverStarted: 75, inProgress: 1, active: 76 });

        const sql = mockDb.run.mock.calls.map((c) => String(c[0])).join(' ');
        expect(sql).toMatch(/INSERT INTO cycle_closure_proposals/i);
        // La preuve A8 : aucune transition de statut n'est écrite par la proposition.
        expect(sql).not.toMatch(/UPDATE assessment_cycles[\s\S]*status\s*=\s*'closed'/i);

        const a = auditFor('cycle_closure_proposed');
        expect(a.details).toContain('PROPOSÉE');
        expect(a.details).toContain('Aucune clôture automatique');
    });

    test('un second passage ne réempile pas une proposition : il rafraîchit celle qui est ouverte', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM cycle_closure_proposals/i.test(String(sql)))
                return { id: 1, cycleId: 9, state: 'open' };
            return overdue(25);
        });
        mockDb.all.mockResolvedValue(funnel());
        mockSettings = { cycleClosureProposalDays: 21 };
        const r = await CycleService.proposeClosure(9);
        expect(r).toMatchObject({ proposed: false, refreshed: true });
        const sql = mockDb.run.mock.calls.map((c) => String(c[0])).join(' ');
        expect(sql).not.toMatch(/INSERT INTO cycle_closure_proposals/i);
    });

    test('un seuil négatif = « ne jamais proposer » (et toujours jamais clôturer)', async () => {
        mockDb.get.mockResolvedValue(overdue(60));
        mockSettings = { cycleClosureProposalDays: -1 };
        const r = await CycleService.proposeClosure(9);
        expect(r.proposed).toBe(false);
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('décliner : la campagne continue et la proposition RESTE avec son motif', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM cycle_closure_proposals/i.test(String(sql)))
                return { id: 4, cycleId: 9, state: 'open' };
            return overdue(25);
        });
        const r = await CycleService.decideClosureProposal(
            9,
            { decision: 'declined', reason: 'Les revues finissent cette semaine.' },
            SUPER
        );
        expect(r.decided).toBe('declined');
        const sql = mockDb.run.mock.calls.map((c) => String(c[0])).join(' ');
        expect(sql).toMatch(/UPDATE cycle_closure_proposals/i);
        expect(sql).not.toMatch(/DELETE/i);
        expect(sql).not.toMatch(/UPDATE assessment_cycles[\s\S]*status\s*=\s*'closed'/i);
        expect(auditFor('cycle_closure_proposal_declined').details).toContain('DÉCLINÉE');
    });

    test('décider sans motif, ou avec une décision inconnue, est refusé', async () => {
        await expect(
            CycleService.decideClosureProposal(9, { decision: 'accepted' }, SUPER)
        ).rejects.toMatchObject({ code: 'proposal_reason_required' });
        await expect(
            CycleService.decideClosureProposal(9, { decision: 'peut-être', reason: 'x' }, SUPER)
        ).rejects.toMatchObject({ code: 'proposal_decision_invalid' });
    });

    test('sans proposition ouverte, il n’y a rien à décider', async () => {
        mockDb.get.mockResolvedValue(null);
        await expect(
            CycleService.decideClosureProposal(9, { decision: 'accepted', reason: 'x' }, SUPER)
        ).rejects.toMatchObject({ code: 'proposal_not_found' });
    });
});

// =========================================================================
//  A8 — le job ne ferme plus rien : il signale chaque semaine et propose.
// =========================================================================
describe('A8 — le job cycle-deadline ne clôture JAMAIS d’office', () => {
    test('le code source ne contient plus aucun appel de clôture', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/jobs/cycle-deadline.js'),
            'utf8'
        );
        expect(src).not.toMatch(/closeWithDisposition\s*\(/);
        expect(src).not.toMatch(/CycleService\.close\s*\(/);
        expect(src).toMatch(/proposeClosure/);
        // le rappel hebdomadaire du retard
        expect(src).toMatch(/weekBucket/);
        expect(src).toMatch(/'cycle\.overdue'/);
    });

    test('le planificateur décrit le job sans promettre une clôture automatique', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/jobs/index.js'), 'utf8');
        // The tick ENTRY (up to its trailing comment), not one physical line:
        // prettier moves the comment after the entry's closing brace.
        const at = src.indexOf("require('./cycle-deadline')");
        expect(at).toBeGreaterThan(-1);
        const entry = src.slice(at, src.indexOf('\n', src.indexOf('}', at) + 1));
        expect(entry).toMatch(/never closes a campaign itself|PROPOSES/i);
    });
});

// =========================================================================
//  A6 — la mesure hors campagne : marquée, datée, hors de tout taux.
// =========================================================================
describe('A6 — mesure hors campagne', () => {
    test('le résumé est marqué « hors campagne » et dit qu’il n’entre dans aucun taux', async () => {
        mockDb.get.mockResolvedValue({
            measurements: 132,
            people: 4,
            firstAt: new Date('2026-06-01T00:00:00Z'),
            lastAt: new Date('2026-09-13T00:00:00Z'),
        });
        const s = await CycleService.offCampaignSummary(SUPER);
        expect(s.scope).toBe('hors_campagne');
        expect(s.measurements).toBe(132);
        expect(s.countedInCompletionRate).toBe(false);
        // la lecture cible bien les lignes SANS campagne
        expect(String(mockDb.get.mock.calls[0][0])).toMatch(/sa\.cycle_id IS NULL/);
    });

    test('chaque ligne porte le marqueur et sa date, et un niveau absent reste null (jamais 0)', async () => {
        mockDb.all.mockResolvedValue([
            {
                selfAssessmentId: 1,
                employeeId: 138,
                firstName: 'A',
                lastName: 'B',
                skillName: 'S',
                selfRatedLevel: null,
                measuredAt: new Date('2026-09-13T00:00:00Z'),
            },
        ]);
        const rows = await CycleService.offCampaignMeasurements(SUPER, {});
        expect(rows[0].scope).toBe('hors_campagne');
        expect(rows[0].selfRatedLevel).toBeNull();
        expect(rows[0].measuredAt).toBeInstanceOf(Date);
    });

    test('aucune lecture de taux ne peut ramasser une mesure hors campagne', () => {
        // La garantie est structurelle : la vue du roster joint sur cycle_id, et un
        // NULL ne joint jamais. On épingle que progress/progressSummaryAll lisent
        // cette vue et RIEN d'autre côté mesures.
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/CycleService.js'),
            'utf8'
        );
        const progress = src.slice(
            src.indexOf('static async progress('),
            src.indexOf('static get GROUPINGS')
        );
        expect(progress).toMatch(/FROM v_cycle_participant_status v/);
        expect(progress).not.toMatch(/FROM self_assessments/);
    });
});

// =========================================================================
//  Règle 12 — le nombre de compétences ne se réduit jamais silencieusement.
// =========================================================================
describe('Règle 12 — changement de rôle en cours de campagne', () => {
    test('le roster expose le changement, les deux rôles et les deux comptes', async () => {
        mockDb.all.mockResolvedValue([
            {
                employeeId: 286,
                firstName: 'X',
                lastName: 'Y',
                state: 'not_started',
                expectedSkills: 161,
                ratedSkills: 0,
                submittedSkills: 0,
                approvedSkills: 0,
                rejectedSkills: 0,
                roleName: 'Ancien rôle',
                roleChanged: true,
                liveRoleName: 'Nouveau rôle',
                liveExpectedSkills: 6,
            },
        ]);
        mockDb.get.mockResolvedValue({ n: 1 });
        const r = await CycleService.participants(9, SUPER, { limit: 10 });
        expect(r.rows[0]).toMatchObject({
            roleChanged: true,
            expectedSkills: 161,
            liveExpectedSkills: 6,
            liveRoleName: 'Nouveau rôle',
        });
        // Le compte de la campagne reste celui de l'inscription : jamais réduit.
        expect(r.rows[0].expectedSkills).toBe(161);
    });

    test('la requête compare le rôle SNAPSHOTTÉ au rôle vivant, et ne réécrit jamais expected_skills', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/services/CycleService.js'),
            'utf8'
        );
        expect(src).toMatch(/\(p\.role_id IS DISTINCT FROM e\.role_id\) AS "roleChanged"/);
        // aucun chemin ne met à jour expected_skills après l'enrôlement
        expect(src).not.toMatch(/SET[\s\S]{0,80}expected_skills\s*=/);
    });

    test('roleChanges() compte les personnes et affirme que le compte n’est pas réduit', async () => {
        mockDb.get.mockResolvedValue({ n: 3, expectedAtEnrolment: 300, expectedLive: 18 });
        const rc = await CycleService.roleChanges(9, SUPER);
        expect(rc).toMatchObject({
            count: 3,
            expectedAtEnrolment: 300,
            expectedLive: 18,
            expectedSkillsReduced: false,
        });
    });
});

// =========================================================================
//  Traçabilité : rien ne se supprime, la migration 117 est complète.
// =========================================================================
describe('Migration 117 — trace et invariants', () => {
    const sql = fs.readFileSync(
        path.join(__dirname, '../../db/postgres/117_campaign_lifecycle_a5_a6_a8.sql'),
        'utf8'
    );

    test('elle est idempotente et estampille schema_meta', () => {
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS closed_at/);
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS cycle_closure_proposals/);
        expect(sql).toMatch(
            /INSERT INTO schema_meta\(key, value\) VALUES \('117_campaign_lifecycle_a5_a6_a8', 'applied'\)/
        );
    });

    test('closed_at est posé par un TRIGGER, pas par un chemin de code faillible', () => {
        // La forme EXACTE : renommer ou débrancher le trigger doit faire rougir ce test.
        expect(sql).toMatch(
            /CREATE TRIGGER trg_assessment_cycles_closed_at\s+BEFORE UPDATE ON assessment_cycles\s+FOR EACH ROW EXECUTE FUNCTION set_cycle_closed_at\(\);/
        );
        expect(sql).toMatch(/NEW\.status = 'closed' AND OLD\.status IS DISTINCT FROM 'closed'/);
    });

    test('la reprise ne s’appuie que sur le journal d’audit — aucune date inventée', () => {
        expect(sql).toMatch(/FROM system_logs/);
        expect(sql).toMatch(/c\.status = 'closed' AND c\.closed_at IS NULL/);
    });

    test('rien n’est supprimé : ni DROP TABLE, ni DELETE', () => {
        expect(sql).not.toMatch(/DROP\s+TABLE/i);
        expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    });

    test('une seule proposition OUVERTE par campagne, les décidées restent', () => {
        expect(sql).toMatch(
            /CREATE UNIQUE INDEX IF NOT EXISTS ux_cycle_closure_proposal_open[\s\S]*WHERE state = 'open'/
        );
    });
});

// =========================================================================
//  Parité FR/EN de chaque phrase visible ajoutée par ce lot.
// =========================================================================
describe('Parité FR/EN des phrases du lot', () => {
    const fr = require('../../locales/fr/admin.json');
    const en = require('../../locales/en/admin.json');
    const KEYS = [
        'cyc_err_cycle_write_closed',
        'cyc_err_cycle_write_closed_undated',
        'cyc_err_cycle_write_cancelled',
        'cyc_err_cycle_write_cancelled_undated',
        'cyc_err_cycle_write_draft',
        'cyc_err_cycle_write_locked',
        'cyc_err_cycle_write_refused',
        'cyc_err_cycle_not_closed',
        'cyc_err_reopen_reason_required',
        'cyc_err_cycle_closed_at_unknown',
        'cyc_err_cycle_reopen_window_expired',
        'cyc_reopen_closed',
        'cyc_reopen_window_left',
        'cyc_reopen_window_none',
        'cyc_reopen_window_unknown',
        'cyc_override_line',
        'cyc_proposal_title',
        'cyc_proposal_line',
        'cyc_proposal_snapshot',
        'cyc_proposal_accept',
        'cyc_proposal_decline',
        'cyc_never_auto_closed',
        'cyc_err_proposal_not_found',
        'cyc_err_proposal_decision_invalid',
        'cyc_err_proposal_reason_required',
        'cyc_off_campaign',
        'cyc_off_campaign_n',
        'cyc_off_campaign_help',
        'cyc_off_campaign_none',
        'cyc_role_changed',
        'cyc_role_changed_n',
        'cyc_role_changed_help',
        'cyc_role_at_enrolment',
        'cyc_role_live',
    ];

    test('chaque clé existe des deux côtés et n’est jamais vide', () => {
        const missing = KEYS.filter((k) => !fr[k] || !en[k]);
        expect(missing).toEqual([]);
    });

    test('les deux langues portent les mêmes variables', () => {
        const vars = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort().join(',');
        const differing = KEYS.filter((k) => vars(fr[k]) !== vars(en[k]));
        expect(differing).toEqual([]);
    });

    test('aucune phrase FR ne contient de code brut ni d’anglais recopié', () => {
        KEYS.forEach((k) => {
            expect(fr[k]).not.toMatch(/cycle_write_|hors_campagne|_required\b/);
            expect(fr[k]).not.toBe(en[k]);
        });
    });
});
