'use strict';
/**
 * LOT UAT3-3 — 9-box, disclosure and plans (HR rulebook 13/09/2026: A3, A4).
 *
 * Measured by execution on the development database BEFORE the fix (own server on :3153,
 * uat.admin / uat.manager / uat.employee):
 *   A4  an approved low/low placement on employee 138, UNDISCLOSED, and
 *       GET /employee/my-development as uat.employee rendered the cell name in
 *       the plan summary (`<dd>…« Concern »…</dd>`, line 517 of the response).
 *       Live rows: PIP #12 'Auto-initiated from 9-box placement "Underperformer"
 *       (low performance)…' and IDP objective #17 '… (from 9-box "High
 *       Performer")', with 0 of 37 placements disclosed.
 *   A4  POST /api/ninebox/:id/disclose with NO reason → 200, and the row carried
 *       no author, no date and no justification (the columns did not exist).
 *   A3  POST /api/ninebox/:id/approve on a low box → 1 PIP + 1 coaching plan
 *       created by the software, 0 manager tasks (no such table).
 *   R8  the only exits from an open PIP were "met" / "not met"; cancelling was a
 *       CancellationService request an ADMINISTRATOR decided.
 *
 * AFTER: 0 PIP + 1 task on approval; both disclosure directions and both task
 * exits refuse an empty reason (400); /employee/my-development contains no cell
 * label while undisclosed and shows it WITH its date and author after; the
 * manager withdraws the plan alone → 'cancelled', never 'closed_failure'.
 *
 * The last block FREEZES the 9-box behaviour that already works and must not
 * regress: unlimited re-placement, previous approvals archived, never deleted.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
const mockNotify = jest.fn().mockResolvedValue(null);
jest.mock('../../src/services/NotificationService', () => ({ notify: (...a) => mockNotify(...a) }));
jest.mock('../../src/services/MakerCheckerService', () => ({
    register: jest.fn(),
    submit: jest.fn(),
}));
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: () => false,
    isViewer: () => false,
    hasPermission: () => true,
    scopeFilter: async () => ({ clause: '', params: [] }),
    getFilteredEmployees: async () => [],
}));

const Confidentiality = require('../../src/services/TalentConfidentialityService');
const TalentTaskService = require('../../src/services/TalentTaskService');
const DevelopmentTriggerService = require('../../src/services/DevelopmentTriggerService');
const PipService = require('../../src/services/PipService');
const NineBoxService = require('../../src/services/NineBoxService');

const SRC = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const MANAGER = { id: 136, userType: 'manager' };

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockImplementation(async (fn) => fn());
});

// ---------------------------------------------------------------------------
describe('A4 — employee-facing prose never names an undisclosed 9-box cell', () => {
    test('recognises every cell label, the legacy labels and the grid itself', () => {
        for (const w of [
            'Diamond in the rough',
            'Shooting Star',
            'Gold Star',
            'Critical Contributor',
            'Emerging Star',
            'Essential Contributor',
            'Trusted Professional',
            'Underperformer',
            'Core Player',
            'Growth Employee',
            'High Performer',
            'Concern',
            'Dilemma',
            '9-box',
            'nine-box',
            'matrice 9 cases',
        ]) {
            expect(Confidentiality.mentionsCell(`texte ${w} texte`)).toBe(true);
        }
    });

    // The reason 'Concern' and 'Dilemma' are matched case-SENSITIVELY: French
    // prose on this very page reads "les plans qui vous concernent".
    test('does not fire on ordinary French or English prose', () => {
        for (const s of [
            'Les plans qui vous concernent : ce qui est attendu de vous.',
            'This does not concern the plan at all.',
            'Aucun plan de développement individuel ne vous concerne.',
        ]) {
            expect(Confidentiality.mentionsCell(s)).toBe(false);
        }
    });

    test('drops only the sentence that names the cell, keeping the manager’s own reasons', () => {
        const summary =
            'Suite au positionnement 9-box « Concern », plan d’amélioration. ' +
            'Deux objectifs de production non tenus sur le trimestre. ' +
            'Accompagnement convenu en entretien du 12/09.';
        const out = Confidentiality.redactForSubject(summary, {
            disclosed: false,
            fallback: 'NEUTRE',
        });
        expect(out.redacted).toBe(true);
        expect(Confidentiality.mentionsCell(out.text)).toBe(false);
        expect(out.text).toContain('Deux objectifs de production non tenus');
        expect(out.text).toContain('Accompagnement convenu');
    });

    test('a fully-redacted field falls back to a neutral sentence, never to blank', () => {
        const out = Confidentiality.redactForSubject('Positionnement 9-box « Underperformer »', {
            disclosed: false,
            fallback: 'Plan ouvert à la suite d’une revue de performance.',
        });
        expect(out.text).toBe('Plan ouvert à la suite d’une revue de performance.');
    });

    test('once the placement is DISCLOSED the same text passes through untouched', () => {
        const t = 'Suite au positionnement 9-box « Concern », plan d’amélioration.';
        expect(Confidentiality.redactForSubject(t, { disclosed: true }).text).toBe(t);
        expect(Confidentiality.redactForSubject(t, { disclosed: true }).redacted).toBe(false);
    });

    test('the exact live rows that leaked are neutralised', () => {
        const pip12 =
            'Auto-initiated from 9-box placement "Underperformer" (low performance). ' +
            'Improve performance through coaching/mentoring and close critical skill gaps.';
        const obj17 =
            'Develop "User Security Awareness" from level 2 to 3 (from 9-box "High Performer")';
        for (const t of [pip12, obj17]) {
            expect(Confidentiality.mentionsCell(t)).toBe(true);
            const out = Confidentiality.redactForSubject(t, {
                disclosed: false,
                fallback: 'NEUTRE',
            });
            expect(Confidentiality.mentionsCell(out.text)).toBe(false);
        }
    });

    // Wiring pins: the guard is useless if the reading surfaces do not call it.
    test('every employee-facing reading surface runs the guard', () => {
        expect(SRC('src/controllers/EmployeePortalController.js')).toMatch(
            /TalentConfidentialityService/
        );
        expect(SRC('src/controllers/EmployeePortalController.js')).toMatch(/redactForSubject/);
        expect(SRC('src/controllers/CoachingPlanController.js')).toMatch(/_safeForSubject/);
        expect(SRC('src/routes/v2-idp.js')).toMatch(/redactForSubject/);
    });

    test('the disclosed placement travels with its date and its author', () => {
        const view = SRC('views/pages/employee/my-development.ejs');
        expect(view).toMatch(/dev_placement_disclosed_by/);
        expect(view).toMatch(/dev_placement_disclosed_on/);
        expect(view).toMatch(/disclosedPlacement\.disclosedBy/);
        expect(view).toMatch(/disclosedPlacement\.disclosedOn/);
    });
});

// ---------------------------------------------------------------------------
describe('A4 — disclosure is deliberate AND traced', () => {
    const approved = { id: 7, employeeId: 138, status: 'approved', box: 1 };

    function authorise() {
        // resolveAuthority reads the employee; a manager of 138 may approve.
        jest.spyOn(NineBoxService, 'resolveAuthority').mockResolvedValue({
            isAdmin: false,
            isManager: true,
            isSupervisor: false,
            canApprove: true,
            canView: true,
        });
    }
    afterEach(() => jest.restoreAllMocks());

    test('refuses to disclose without a written reason (both directions)', async () => {
        authorise();
        mockDb.get.mockResolvedValue(approved);
        await expect(NineBoxService.setDisclosure(MANAGER, 7, true, '   ')).rejects.toThrow(
            /motif écrit est obligatoire/i
        );
        await expect(NineBoxService.setDisclosure(MANAGER, 7, false, null)).rejects.toThrow(
            /motif écrit est obligatoire/i
        );
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('records who, when and why on the placement itself', async () => {
        authorise();
        mockDb.get.mockResolvedValue(approved);
        await NineBoxService.setDisclosure(MANAGER, 7, true, 'Restitution en entretien du 13/09.');
        const update = mockDb.run.mock.calls.find((c) => /UPDATE nine_box_evaluations/.test(c[0]));
        expect(update).toBeTruthy();
        expect(update[0]).toMatch(/disclosed_at/);
        expect(update[0]).toMatch(/disclosed_by/);
        expect(update[0]).toMatch(/disclosed_by_type/);
        expect(update[0]).toMatch(/disclosure_reason/);
        expect(update[1]).toContain('Restitution en entretien du 13/09.');
        expect(update[1]).toContain('manager');
        // The reason is in the append-only event trail too.
        const event = mockDb.run.mock.calls.find((c) => /INSERT INTO nine_box_events/.test(c[0]));
        expect(JSON.stringify(event[1])).toMatch(/Restitution en entretien/);
    });

    test('the database refuses a disclosure with no author or no reason', () => {
        const sql = SRC('db/postgres/115_ninebox_disclosure_and_manager_tasks.sql');
        expect(sql).toMatch(/chk_ninebox_disclosure_complete/);
        expect(sql).toMatch(
            /disclosed_at IS NOT NULL AND length\(btrim\(COALESCE\(disclosure_reason/
        );
    });
});

// ---------------------------------------------------------------------------
describe('A3 — the software proposes, the manager decides', () => {
    // clearAllMocks keeps implementations: do not leak the reporting-line answer.
    afterEach(() => mockDb.all.mockReset());
    test('an approved low-performance placement creates NO plan and ONE task', async () => {
        // No open PIP for this person.
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM pips/.test(sql)) return null;
            if (/INSERT INTO talent_manager_tasks/.test(sql)) return { id: 42 };
            return null;
        });
        // ReportingLineService.linesFor: 138's ACTIVE supervisor is 136, no manager.
        mockDb.all.mockImplementation(async (sql) =>
            /LEFT JOIN employees sup/.test(sql)
                ? [{ employeeId: 138, employeeActive: true, supId: 136, supName: 'Test Manager' }]
                : []
        );
        const proposeDirect = jest.spyOn(PipService, 'proposeDirect');

        const out = await DevelopmentTriggerService.triggerForPlacement(MANAGER, {
            employeeId: 138,
            performance: 'low',
            potential: 'low',
            label: 'Concern',
        });

        expect(out.zone).toBe('red');
        expect(out.createdPip).toBe(false);
        expect(out.pipId).toBeNull();
        expect(out.createdTask).toBe(true);
        expect(out.taskId).toBe(42);
        expect(proposeDirect).not.toHaveBeenCalled();
        // The manager is told; the subject is NOT — nothing has been decided yet,
        // and telling them would disclose the placement A4 keeps closed.
        expect(mockNotify).toHaveBeenCalledTimes(1);
        expect(mockNotify.mock.calls[0][0].userId).toBe(136);
        proposeDirect.mockRestore();
    });

    test('the task carries no grid vocabulary — only provenance', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/INSERT INTO talent_manager_tasks/.test(sql)) return { id: 43 };
            return null;
        });
        mockDb.all.mockImplementation(async (sql) =>
            /LEFT JOIN employees sup/.test(sql)
                ? [{ employeeId: 138, employeeActive: true, supId: 136, supName: 'Test Manager' }]
                : []
        );
        await TalentTaskService.raisePipTask({ employeeId: 138, originEvaluationId: 3239 });
        const insert = mockDb.get.mock.calls.find((c) =>
            /INSERT INTO talent_manager_tasks/.test(c[0])
        );
        expect(Confidentiality.mentionsCell(JSON.stringify(insert[1]))).toBe(false);
        expect(insert[1]).toContain(3239);
    });

    test('re-placing the same person does not stack a second task', () => {
        const src = SRC('src/services/TalentTaskService.js');
        expect(src).toMatch(/ON CONFLICT \(employee_id, kind\) WHERE state = 'open' DO NOTHING/);
        expect(SRC('db/postgres/115_ninebox_disclosure_and_manager_tasks.sql')).toMatch(
            /uq_tmt_open_per_employee_kind/
        );
    });

    test('closing a task requires a written reason, whichever way it goes', async () => {
        for (const resolution of ['plan_opened', 'no_plan']) {
            await expect(
                TalentTaskService.resolve(9, MANAGER, { resolution, reason: '  ' })
            ).rejects.toThrow(/motif écrit est obligatoire/i);
        }
        expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('a resolved task names its author, its date and its reason', async () => {
        mockDb.get.mockResolvedValue({ id: 9, employeeId: 138 });
        await TalentTaskService.resolve(9, MANAGER, {
            resolution: 'plan_opened',
            reason: 'Deux objectifs non tenus.',
            targetId: 74,
        });
        const call = mockDb.get.mock.calls.find((c) => /UPDATE talent_manager_tasks/.test(c[0]));
        expect(call[0]).toMatch(/resolved_at = now\(\)/);
        expect(call[1]).toContain('Deux objectifs non tenus.');
        expect(call[1]).toContain(74);
    });

    test('the only route that turns a task into a plan demands a reason', () => {
        const src = SRC('src/routes/v2-pip.js');
        expect(src).toMatch(/\/tasks\/:id\/open-plan/);
        expect(src).toMatch(/\/tasks\/:id\/dismiss/);
        expect(src).toMatch(/pip_reason_required/);
    });
});

// ---------------------------------------------------------------------------
describe('Rule 8 — the owning manager closes their own plan, alone', () => {
    test('withdrawing refuses an empty reason', async () => {
        await expect(PipService.withdraw(74, '   ', MANAGER)).rejects.toThrow(
            /motif écrit est obligatoire/i
        );
        expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('withdrawing is a state plus a reason — never closed_failure', async () => {
        mockDb.get.mockResolvedValue({ id: 74, employeeId: 138 });
        const ok = await PipService.withdraw(
            74,
            'Objectifs tenus; le plan n’a plus d’objet.',
            MANAGER
        );
        expect(ok).toBe(true);
        const call = mockDb.get.mock.calls[0];
        expect(call[0]).toMatch(/state='cancelled'/);
        expect(call[0]).not.toMatch(/closed_failure/);
        // It closes a plan that never ran, not only an active one.
        expect(call[0]).toMatch(/state IN \('proposed','approved','active'\)/);
        expect(call[1][0]).toContain('Objectifs tenus');
    });

    test('an already-closed plan is reported as such, not silently re-closed', async () => {
        mockDb.get.mockResolvedValue(null);
        expect(await PipService.withdraw(74, 'motif', MANAGER)).toBe(false);
    });

    test('the route is on /v2/pip and needs no second person', () => {
        const src = SRC('src/routes/v2-pip.js');
        expect(src).toMatch(/router\.post\(\s*'\/:id\/withdraw'/);
        // canManage = super admin, admin scope, or the manager's own reports.
        expect(src).toMatch(/withdraw[\s\S]{0,600}canManage\(req\.user, pip\.employeeId\)/);
        expect(src).not.toMatch(/withdraw[\s\S]{0,400}MakerChecker/);
    });
});

// ---------------------------------------------------------------------------
// FROZEN — this already works and must not regress (rulebook §5).
describe('9-box: unlimited re-placement, approved placements archived not deleted', () => {
    test('approving supersedes the previous approval into archived, with an event', async () => {
        jest.spyOn(NineBoxService, 'resolveAuthority').mockResolvedValue({
            isAdmin: false,
            isManager: true,
            isSupervisor: false,
            canApprove: true,
            canView: true,
        });
        const ev = {
            id: 50,
            employeeId: 88,
            status: 'under_review',
            performance: 'low',
            potential: 'low',
        };
        mockDb.get.mockResolvedValue(ev);
        mockDb.all.mockResolvedValue([{ id: 49, employeeId: 88 }]);
        jest.spyOn(NineBoxService, '_mirrorContained').mockResolvedValue({});
        jest.spyOn(NineBoxService, '_triggerContained').mockResolvedValue({});

        await NineBoxService.approve(MANAGER, 50);

        const sqls = mockDb.run.mock.calls.map((c) => c[0]).join('\n');
        expect(sqls).toMatch(/SET status='archived'/);
        expect(sqls).not.toMatch(/DELETE FROM nine_box_evaluations/);
        const supersede = mockDb.run.mock.calls.find(
            (c) => /INSERT INTO nine_box_events/.test(c[0]) && String(c[1]).includes('supersede')
        );
        expect(supersede).toBeTruthy();
        jest.restoreAllMocks();
    });

    test('no code path deletes a placement, and there is no re-placement cap', () => {
        const src = SRC('src/services/NineBoxService.js');
        expect(src).not.toMatch(/DELETE FROM nine_box_evaluations/);
        expect(src).toMatch(/status='archived'/);
        // The trend/history read still includes archived rows — that is where the
        // history of a person's positions lives.
        expect(src).toMatch(/status IN \('approved','archived'\)/);
    });
});
