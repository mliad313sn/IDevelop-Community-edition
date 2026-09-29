'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * UAT3 LOT 1 — one measurement per round (owner decision A1, HR-RULEBOOK 2026-09-13 §2).
 *
 * THE DEFECT, measured on idevelop before the change: 179 self-assessment rows,
 * exactly ONE per (employee, skill) — forced by UNIQUE (employee_id, skill_id,
 * status). A new campaign REWROTE that row (level, notes, campaign) and the
 * service DELETED any duplicate outright, so progression could not be shown and
 * the house rule "nothing is ever deleted" was broken.
 *
 * AFTER (measured, employee 138 / skill 299): 1 record → 2 records; round 1 kept
 * level 3, its notes, `approved`, approved_by 136 and its approval date, and was
 * marked superseded_by round 2; round 2 is a new dated draft at level 4 attached
 * to campaign 11. The employee portal and the supervisor queue rendered
 * byte-for-byte identically before and after for the current round.
 */

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

// ---------------------------------------------------------------------------
// 1) The service: a new round is a NEW record, and nothing is ever deleted.
// ---------------------------------------------------------------------------
const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
};
const mockModel = {
    findCurrentRound: jest.fn(),
    openRound: jest.fn(),
    create: jest.fn(),
    listRounds: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/SelfAssessmentModel', () => mockModel);

const svc = require('../../src/services/SelfAssessmentService');

const OPEN_CYCLE = { id: '11' };

beforeEach(() => {
    for (const f of Object.values(mockDb)) if (f.mockReset) f.mockReset();
    for (const f of Object.values(mockModel)) f.mockReset();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.all.mockResolvedValue([]);
});

/** Every statement the service issued, as one string — for "no DELETE" checks. */
const issued = () => mockDb.run.mock.calls.map((c) => String(c[0])).join('\n');

describe('A1 — a new campaign opens a NEW record instead of rewriting the old one', () => {
    test('first ever measurement opens round 1 and touches nothing else', async () => {
        mockDb.get.mockResolvedValueOnce(null); // no open campaign
        mockModel.findCurrentRound.mockResolvedValue(null);
        mockModel.openRound.mockResolvedValue({ id: '900', roundNo: 1 });

        const r = await svc.createOrUpdateSelfAssessment(138, 299, 3, 'first');

        expect(mockModel.openRound).toHaveBeenCalledWith(
            expect.objectContaining({
                employeeId: 138,
                skillId: 299,
                selfRatedLevel: 3,
                cycleId: null,
            })
        );
        expect(r.id).toBe('900');
        expect(issued()).not.toMatch(/DELETE/i);
    });

    test('the employee editing their own draft stays in the SAME round', async () => {
        mockDb.get.mockResolvedValueOnce(OPEN_CYCLE);
        mockModel.findCurrentRound.mockResolvedValue({
            id: '900',
            status: 'draft',
            workflowState: 'draft',
            cycleId: '11',
            roundNo: 1,
        });

        const r = await svc.createOrUpdateSelfAssessment(138, 299, 4, 'corrected');

        expect(r).toEqual({ id: 900 });
        expect(mockModel.openRound).not.toHaveBeenCalled();
        expect(issued()).toMatch(/UPDATE self_assessments/);
        expect(issued()).not.toMatch(/DELETE/i);
    });

    test('asked again by a DIFFERENT campaign: previous round superseded, new round opened', async () => {
        mockDb.get
            .mockResolvedValueOnce(OPEN_CYCLE) // the open campaign
            .mockResolvedValueOnce(null); // no open dispute
        mockModel.findCurrentRound.mockResolvedValue({
            id: '900',
            status: 'approved',
            workflowState: 'approved',
            cycleId: null,
            roundNo: 1,
        });
        mockModel.openRound.mockResolvedValue({ id: '901', roundNo: 2 });

        const r = await svc.createOrUpdateSelfAssessment(138, 299, 4, 'tour 2');

        expect(r).toMatchObject({
            id: 901,
            reopened: true,
            previousId: 900,
            round: 2,
            fromCycleId: null,
        });
        // The previous round is marked superseded — never rewritten.
        const sql = issued();
        expect(sql).toMatch(/UPDATE self_assessment_rounds SET superseded_at = now\(\)/);
        expect(sql).toMatch(/UPDATE self_assessment_rounds SET superseded_by = \?/);
        // Its level, notes, status and stamps are not in any UPDATE.
        expect(sql).not.toMatch(/SET self_rated_level/);
        expect(sql).not.toMatch(/submitted_at = NULL/);
        expect(sql).not.toMatch(/DELETE/i);
        // The new round carries the new campaign and the new level.
        expect(mockModel.openRound).toHaveBeenCalledWith(
            expect.objectContaining({ selfRatedLevel: 4, cycleId: '11', notes: 'tour 2' })
        );
        // Supersede + open + trail commit together.
        expect(mockDb.runTransaction).toHaveBeenCalled();
    });

    test('the handoff event names the new round so the trail is not broken', async () => {
        mockDb.get.mockResolvedValueOnce(OPEN_CYCLE).mockResolvedValueOnce(null);
        mockModel.findCurrentRound.mockResolvedValue({
            id: '900',
            status: 'approved',
            workflowState: 'approved',
            cycleId: '9',
            roundNo: 1,
        });
        mockModel.openRound.mockResolvedValue({ id: '901', roundNo: 2 });

        await svc.createOrUpdateSelfAssessment(138, 299, 4, null);

        const ev = mockDb.run.mock.calls.find((c) => /self_assessment_events/.test(String(c[0])));
        expect(ev).toBeTruthy();
        expect(String(ev[0])).toMatch(/'reopen_new_cycle'/);
        expect(ev[1][0]).toBe(900); // written on the PREVIOUS round
        const detail = JSON.parse(ev[1][3]);
        expect(detail).toMatchObject({
            fromCycleId: 9,
            toCycleId: 11,
            newAssessmentId: 901,
            round: 2,
        });
    });

    test('no open campaign: a decided measurement is refused, not re-measured', async () => {
        mockDb.get.mockResolvedValueOnce(null);
        mockModel.findCurrentRound.mockResolvedValue({
            id: '900',
            status: 'approved',
            workflowState: 'approved',
            cycleId: '9',
            roundNo: 1,
        });

        const r = await svc.createOrUpdateSelfAssessment(138, 299, 4, null);

        expect(r).toEqual({ id: 900, skipped: true, state: 'approved' });
        expect(mockModel.openRound).not.toHaveBeenCalled();
        expect(issued()).not.toMatch(/DELETE|superseded_at/i);
    });

    test('a measurement under an OPEN dispute is left exactly as it is', async () => {
        mockDb.get.mockResolvedValueOnce(OPEN_CYCLE).mockResolvedValueOnce({ x: 1 });
        mockModel.findCurrentRound.mockResolvedValue({
            id: '900',
            status: 'approved',
            workflowState: 'approved',
            cycleId: '9',
            roundNo: 1,
        });

        const r = await svc.createOrUpdateSelfAssessment(138, 299, 4, null);

        expect(r).toEqual({ id: 900, skipped: true, state: 'approved', reason: 'under_dispute' });
        expect(mockModel.openRound).not.toHaveBeenCalled();
        expect(issued()).not.toMatch(/superseded_at/);
    });

    test('an offline draft written for another campaign is still refused, never re-filed', async () => {
        mockDb.get.mockResolvedValueOnce(OPEN_CYCLE);
        const r = await svc.createOrUpdateSelfAssessment(138, 299, 2, null, '9');
        expect(r).toMatchObject({ skipped: true, reason: 'cycle_changed' });
        expect(mockModel.findCurrentRound).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 2) Source + migration pins — the two things that must never come back.
// ---------------------------------------------------------------------------
describe('Nothing is deleted, and the constraint that forced the rewrite is gone', () => {
    const service = read('src/services/SelfAssessmentService.js');
    const migration = read('db/postgres/113_self_assessment_rounds.sql');

    test('SelfAssessmentService issues no DELETE on self-assessments', () => {
        expect(service).not.toMatch(/DELETE\s+FROM\s+self_assessments/i);
        expect(service).not.toMatch(/DELETE\s+FROM\s+self_assessment_rounds/i);
    });

    test('migration 113 drops UNIQUE(employee_id, skill_id, status) explicitly', () => {
        expect(migration).toMatch(
            /DROP CONSTRAINT IF EXISTS self_assessments_employee_id_skill_id_status_key/
        );
    });

    test('migration 113 replaces it with ONE CURRENT round per (employee, skill)', () => {
        expect(migration).toMatch(
            /CREATE UNIQUE INDEX IF NOT EXISTS uq_sa_current_round[\s\S]*?WHERE superseded_at IS NULL/
        );
    });

    test('migration 113 keeps `self_assessments` as the CURRENT-round view', () => {
        expect(migration).toMatch(/CREATE OR REPLACE VIEW public\.self_assessments/);
        expect(migration).toMatch(
            /FROM public\.self_assessment_rounds\s*\n\s*WHERE superseded_at IS NULL/
        );
    });

    test('migration 113 deletes nothing and stamps schema_meta', () => {
        // (`ON DELETE SET NULL` on the superseded_by FK is a referential action,
        // not a statement — the carry-over itself removes nothing.)
        expect(migration).not.toMatch(/DELETE\s+FROM|\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
        expect(migration).toMatch(
            /INSERT INTO schema_meta\(key, value\) VALUES \('113_self_assessment_rounds', 'applied'\)/
        );
    });
});

// ---------------------------------------------------------------------------
// 3) The progression page reads the rounds — with their dates.
// ---------------------------------------------------------------------------
describe('The successive measurements are visible where progression is already shown', () => {
    const view = read('views/pages/employees/progress.ejs');

    test('the page renders a dated row per round, with the campaign or "off-campaign"', () => {
        expect(view).toMatch(/compliance:prog_meas_title/);
        expect(view).toMatch(/compliance:prog_meas_th_date/);
        expect(view).toMatch(/r\.cycleLabel \|\| __\('compliance:prog_meas_off_cycle'\)/);
        expect(view).toMatch(/fmtDate\(r\.measuredAt\)/);
    });

    test('an absence of a second measurement is said, never shown as 0', () => {
        expect(view).toMatch(/compliance:prog_meas_none/);
        expect(view).toMatch(/compliance:prog_meas_not_measured/);
    });

    test('both locales carry every new key', () => {
        const fr = JSON.parse(read('locales/fr/compliance.json'));
        const en = JSON.parse(read('locales/en/compliance.json'));
        const keys = [
            'prog_meas_title',
            'prog_meas_intro',
            'prog_meas_none',
            'prog_meas_count',
            'prog_meas_th_skill',
            'prog_meas_th_round',
            'prog_meas_th_date',
            'prog_meas_th_campaign',
            'prog_meas_th_self',
            'prog_meas_th_supervisor',
            'prog_meas_th_state',
            'prog_meas_off_cycle',
            'prog_meas_current',
            'prog_meas_evolution',
            'prog_meas_not_measured',
        ];
        for (const k of keys) {
            expect(typeof fr[k]).toBe('string');
            expect(typeof en[k]).toBe('string');
        }
    });

    test('loadProgress groups the rounds per competency and never invents a movement', async () => {
        jest.resetModules();
        const db2 = {
            get: jest.fn().mockResolvedValue(null),
            all: jest.fn().mockResolvedValue([]),
        };
        const model2 = {
            listRounds: jest.fn().mockResolvedValue([
                // measured twice → progression
                {
                    id: 1,
                    skillId: 299,
                    skillName: 'B skill',
                    domainName: 'D',
                    roundNo: 1,
                    selfRatedLevel: 2,
                    supervisorRatedLevel: 2,
                    status: 'approved',
                    workflowState: 'approved',
                    createdAt: '2026-06-01T00:00:00Z',
                    approvedAt: '2026-06-10T00:00:00Z',
                    supersededAt: '2026-09-01T00:00:00Z',
                    cycleId: 9,
                    cycleLabel: '2026-Q2',
                },
                {
                    id: 2,
                    skillId: 299,
                    skillName: 'B skill',
                    domainName: 'D',
                    roundNo: 2,
                    selfRatedLevel: 3,
                    supervisorRatedLevel: null,
                    status: 'draft',
                    workflowState: 'draft',
                    createdAt: '2026-09-01T00:00:00Z',
                    approvedAt: null,
                    supersededAt: null,
                    cycleId: null,
                    cycleLabel: null,
                },
                // measured once → not a progression, left out
                {
                    id: 3,
                    skillId: 300,
                    skillName: 'A skill',
                    domainName: 'D',
                    roundNo: 1,
                    selfRatedLevel: 1,
                    supervisorRatedLevel: null,
                    status: 'draft',
                    workflowState: 'draft',
                    createdAt: '2026-09-01T00:00:00Z',
                    approvedAt: null,
                    supersededAt: null,
                    cycleId: null,
                    cycleLabel: null,
                },
                // two rounds but NO level on either → unmeasured, never a 0 delta
                {
                    id: 4,
                    skillId: 301,
                    skillName: 'C skill',
                    domainName: 'D',
                    roundNo: 1,
                    selfRatedLevel: null,
                    supervisorRatedLevel: null,
                    status: 'draft',
                    workflowState: 'draft',
                    createdAt: '2026-06-01T00:00:00Z',
                    approvedAt: null,
                    supersededAt: '2026-09-01T00:00:00Z',
                    cycleId: 9,
                    cycleLabel: '2026-Q2',
                },
                {
                    id: 5,
                    skillId: 301,
                    skillName: 'C skill',
                    domainName: 'D',
                    roundNo: 2,
                    selfRatedLevel: null,
                    supervisorRatedLevel: null,
                    status: 'draft',
                    workflowState: 'draft',
                    createdAt: '2026-09-01T00:00:00Z',
                    approvedAt: null,
                    supersededAt: null,
                    cycleId: null,
                    cycleLabel: null,
                },
            ]),
        };
        jest.doMock('../../src/config/database', () => db2);
        jest.doMock('../../src/models/SelfAssessmentModel', () => model2);
        const ctrl = require('../../src/controllers/EmployeeProgressController');
        let payload;
        await ctrl.data(
            { params: { id: '138' } },
            {
                json: (p) => {
                    payload = p;
                },
            }
        );

        const m = payload.measures;
        expect(m.roundsTotal).toBe(5);
        expect(m.skills.map((s) => s.skillId)).toEqual([299, 301]); // 300 has one round only
        const b = m.skills.find((s) => s.skillId === 299);
        expect(b.rounds).toHaveLength(2);
        expect(b.rounds[0].measuredAt).toBe('2026-06-10T00:00:00Z'); // decided date
        expect(b.rounds[0].current).toBe(false);
        expect(b.rounds[1].current).toBe(true);
        expect(b.rounds[1].cycleLabel).toBeNull(); // off-campaign
        expect(b.delta).toBe(1);
        const c = m.skills.find((s) => s.skillId === 301);
        expect(c.delta).toBeNull(); // NOT 0
    });
});
