'use strict';
/**
 * Product-readiness committee — LOT T (talent workflow).
 *
 * Migration 95's rule: a placement is what has been APPROVED. nine_box_evaluations
 * is the source of truth; talent_placements is a MIRROR of the approved position
 * that DEI, bias detection, the copilot, the Report Builder and Power BI read,
 * every one of them through (SELECT MAX(cycle_id) FROM talent_placements).
 *
 * Five findings, each reproduced by execution on idevelop inside a rolled-back
 * transaction before the fix and re-proved after it:
 *
 *   F1  finalizeCalibration answered 409 no_placements_matched / applied 0 and left
 *       the session in_progress, yet employee 89's APPROVED placement had silently
 *       moved box 6 → 1 (no event, no PIP) — the evaluation UPDATE ran before the
 *       applied check and the transaction committed anyway.
 *   F2  the calibration write-back bypassed the 9-box workflow: no nine_box_events
 *       row, no audit, no DevelopmentTriggerService.triggerForPlacement — a move
 *       into the RED zone opened no PIP/coaching (68963 low-low → high-low).
 *   F3  archive() / reject() dropped the placement from the grid but left the
 *       talent_placements mirror behind, so every consumer kept counting the box.
 *   F4  with no open cycle the mirror fell back to ORDER BY opened_at DESC LIMIT 1
 *       with no status filter and no tie-break: six cycles sharing one opened_at
 *       put a fresh approval into CLOSED cycle 6 while consumers read MAX = 9.
 *   F5  the facilitator's distribution read the org-wide MAX cycle instead of the
 *       session's own cycle_id and site/department scope.
 *
 * DB mocked (the live behaviour is exercised by the rolled-back probe).
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);

const mockLog = { log: jest.fn() };
jest.mock('../../src/services/LogService', () => mockLog);

const mockTrigger = { triggerForPlacement: jest.fn() };
jest.mock('../../src/services/DevelopmentTriggerService', () => mockTrigger);

const mockEmployees = { findById: jest.fn(), governs: jest.fn() };
jest.mock('../../src/models/EmployeeModel', () => mockEmployees);

const mockRbac = {
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: () => false,
    isViewer: () => false,
    canAccessEmployeeData: jest.fn(async () => true),
    getFilteredEmployees: jest.fn(async () => []),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

const NineBox = require('../../src/services/NineBoxService');
const Calib = require('../../src/services/TalentDepthService');

const SUPER = { id: 1, userType: 'admin', role: 'superadmin', username: 'admin' };

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
/** Every run() call as [normalised SQL, params]. */
const runs = () => mockDb.run.mock.calls.map(([s, p]) => [norm(s), p]);
const runsMatching = (re) => runs().filter(([s]) => re.test(s));
const gets = () => mockDb.get.mock.calls.map(([s, p]) => [norm(s), p]);

/** Route db.get by SQL fragment: [[/regex/, value-or-fn], ...]; unmatched → undefined. */
const routeGet = (table) =>
    mockDb.get.mockImplementation(async (sql, params) => {
        const s = norm(sql);
        for (const [re, v] of table) if (re.test(s)) return typeof v === 'function' ? v(params) : v;
        return undefined;
    });

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockDb.runTransaction.mockReset().mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockReset().mockImplementation(async (fn) => fn());
    mockLog.log.mockReset().mockResolvedValue(undefined);
    mockTrigger.triggerForPlacement.mockReset().mockResolvedValue(null);
    mockEmployees.findById
        .mockReset()
        .mockResolvedValue({ id: 68963, supervisorId: null, managerId: null });
    mockEmployees.governs.mockReset().mockResolvedValue(false);
});

// ---------------------------------------------------------------------------
// F1 / F2 — the calibration write-back is the 9-box path, and "applied" means it
// ---------------------------------------------------------------------------
describe('F1: finalizeCalibration writes nothing when nothing applies', () => {
    const session = { id: 11, cycleId: 9, facilitatorAdminId: 1, actorEmployeeId: null };

    test('applied 0 → no_placements_matched, session stays open, and no evaluation/mirror UPDATE was issued', async () => {
        routeGet([
            [/FROM calibration_sessions/, session],
            [/FROM admins WHERE id/, { id: 1, username: 'admin', role: 'superadmin' }],
            // applyCalibration's lookup: NO approved evaluation for this employee
            [/FROM nine_box_evaluations WHERE employee_id = \? AND status = 'approved'/, undefined],
        ]);
        mockDb.all.mockResolvedValue([{ employeeId: 89, toBox: 'low-low', rationale: 'r' }]);

        const r = await Calib.finalizeCalibration(11);
        expect(r).toMatchObject({
            ok: false,
            reason: 'no_placements_matched',
            applied: 0,
            attempted: 1,
            finalized: false,
            unmatched: [89],
        });
        // The approved row must be untouched: no write of any kind happened.
        expect(runsMatching(/UPDATE NINE_BOX_EVALUATIONS/i)).toHaveLength(0);
        expect(runsMatching(/TALENT_PLACEMENTS/i)).toHaveLength(0);
        expect(runsMatching(/INSERT INTO NINE_BOX_EVENTS/i)).toHaveLength(0);
        expect(runsMatching(/SET STATUS='FINALIZED'/i)).toHaveLength(0);
        expect(mockTrigger.triggerForPlacement).not.toHaveBeenCalled();
    });

    test('TalentDepthService itself no longer touches either system of record — the write is applyCalibration', () => {
        const src = read('src/services/TalentDepthService.js');
        expect(src).not.toMatch(/UPDATE nine_box_evaluations/);
        expect(src).not.toMatch(/UPDATE talent_placements/);
        expect(src).toMatch(/NineBox\(\)\s*\.applyCalibration\(\s*actor,\s*\{/);
    });

    test('a session with no adjustments is refused and named', async () => {
        routeGet([[/FROM calibration_sessions/, session]]);
        mockDb.all.mockResolvedValue([]);
        const r = await Calib.finalizeCalibration(11);
        expect(r).toMatchObject({
            ok: false,
            reason: 'no_adjustments',
            applied: 0,
            attempted: 0,
            finalized: false,
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });
});

describe('F2: every calibration move goes through the 9-box path', () => {
    const session = { id: 13, cycleId: 9, facilitatorAdminId: 1, actorEmployeeId: null };
    const approvedEv = {
        id: 51,
        employeeId: 68963,
        status: 'approved',
        potential: 'low',
        performance: 'low',
        box: 1,
        boxLabel: 'Concern',
        cellTier: 1,
        positionSource: 'system',
        comments: null,
    };

    const wire = () =>
        routeGet([
            [/FROM calibration_sessions/, session],
            [/FROM admins WHERE id/, { id: 1, username: 'admin', role: 'superadmin' }],
            [
                /FROM nine_box_evaluations WHERE employee_id = \? AND status = 'approved'/,
                approvedEv,
            ],
            [
                /SELECT \* FROM nine_box_evaluations WHERE id = \?/,
                {
                    ...approvedEv,
                    potential: 'high',
                    performance: 'low',
                    box: 7,
                    boxLabel: 'Diamond in the rough',
                },
            ],
            [/SELECT MAX\(cycle_id\) AS m FROM talent_placements/, { m: 9 }],
        ]);

    test('the facilitator is the actor, and applyCalibration receives session, cycle, box and rationale', async () => {
        wire();
        mockDb.all.mockResolvedValue([
            { employeeId: 68963, toBox: 'high-low', rationale: 'committee decision' },
        ]);
        const spy = jest.spyOn(NineBox, 'applyCalibration');
        const r = await Calib.finalizeCalibration(13);
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1, userType: 'admin', role: 'superadmin' }),
            {
                employeeId: 68963,
                toBox: 'high-low',
                reason: 'committee decision',
                sessionId: 13,
                cycleId: 9,
            },
            null
        );
        expect(r).toMatchObject({
            ok: true,
            applied: 1,
            attempted: 1,
            finalized: true,
            unmatched: [],
        });
        expect(runsMatching(/SET STATUS='FINALIZED'/i)).toHaveLength(1);
        spy.mockRestore();
    });

    test('applyCalibration: approved row updated → calibrate event → mirror → triggerForPlacement, in that order', async () => {
        wire();
        mockTrigger.triggerForPlacement.mockResolvedValue({
            zone: 'red',
            pipId: 65,
            createdPip: true,
        });

        const out = await NineBox.applyCalibration(SUPER, {
            employeeId: 68963,
            toBox: 'high-low',
            reason: 'committee decision',
            sessionId: 13,
            cycleId: 9,
        });

        expect(out).toMatchObject({
            evaluationId: 51,
            employeeId: 68963,
            fromBox: 'low-low',
            toBox: 'high-low',
            changed: true,
            mirror: { cycleId: 9, box: 'high-low', visibleToConsumers: true },
            autoTrigger: { zone: 'red', pipId: 65 },
        });

        const seq = runs().map(([s]) => s);
        const iUpd = seq.findIndex((s) =>
            /^UPDATE nine_box_evaluations SET potential = \?, performance = \?, box = \?, box_label = \?, calibration_notes = \?/.test(
                s
            )
        );
        const iEvt = seq.findIndex((s) => /INSERT INTO nine_box_events/.test(s));
        const iMir = seq.findIndex((s) => /INSERT INTO talent_placements/.test(s));
        expect(iUpd).toBeGreaterThan(-1);
        expect(iEvt).toBeGreaterThan(iUpd);
        expect(iMir).toBeGreaterThan(iEvt);

        // The UPDATE writes the calibrated levels + computeBox's index/label, on the approved row only.
        expect(runs()[iUpd][1]).toEqual([
            'high',
            'low',
            7,
            'Diamond in the rough',
            'Calibration: committee decision',
            51,
        ]);
        expect(seq[iUpd]).toMatch(/WHERE id = \? AND status = 'approved'/);

        // The event names the move: action 'calibrate', approved → approved, with from/to and the session.
        const evtParams = runs()[iEvt][1];
        expect(evtParams.slice(0, 7)).toEqual([
            51,
            68963,
            1,
            'admin',
            'calibrate',
            'approved',
            'approved',
        ]);
        expect(JSON.parse(evtParams[7])).toMatchObject({
            fromBox: 'low-low',
            toBox: 'high-low',
            from: 1,
            to: 7,
            sessionId: 13,
            reason: 'committee decision',
        });

        // The mirror lands in the session's cycle with the consumer vocabulary, as an override.
        expect(runs()[iMir][1].slice(0, 5)).toEqual([68963, 9, 'high-low', 'up', 'override']);

        // The auto-trigger receives the calibrated levels AND the exact evaluation id.
        expect(mockTrigger.triggerForPlacement).toHaveBeenCalledWith(
            SUPER,
            expect.objectContaining({
                employeeId: 68963,
                performance: 'low',
                potential: 'high',
                evaluationId: 51,
            }),
            null
        );
        // Every best-effort step ran under a savepoint: the placement mirror, the
        // auto-trigger, and — since 2026-09-18 — each of the two audit writes
        // asserted just below (NINEBOX_CALIBRATE and NINEBOX_AUTO_TRIGGER). The
        // audit joined them because it writes adminId = user.id, which for an
        // EMPLOYEE manager violates the FK to admins: the try/catch swallowed the
        // error while the surrounding transaction stayed aborted (25P02), so every
        // 9-box act by an employee-manager returned 500. Two steps + two audits.
        expect(mockDb.runInSavepoint).toHaveBeenCalledTimes(4);
        // Audited like an approval.
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'NINEBOX_CALIBRATE', entityId: 51 })
        );
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'NINEBOX_AUTO_TRIGGER', entityId: 51 })
        );
    });

    test('a trigger failure is contained — the calibration stands and the result names the error', async () => {
        wire();
        mockTrigger.triggerForPlacement.mockRejectedValue(new Error('coaching authority'));
        const out = await NineBox.applyCalibration(SUPER, {
            employeeId: 68963,
            toBox: 'high-low',
            reason: 'r',
            sessionId: 13,
            cycleId: 9,
        });
        expect(out.autoTrigger).toEqual({ error: 'coaching authority' });
        expect(runsMatching(/UPDATE nine_box_evaluations/)).toHaveLength(1);
        expect(runsMatching(/INSERT INTO nine_box_events/)).toHaveLength(1);
        expect(runsMatching(/INSERT INTO talent_placements/)).toHaveLength(1);
    });

    test('no approved evaluation → null, and NOTHING is written or triggered', async () => {
        routeGet([[/status = 'approved'/, undefined]]);
        const out = await NineBox.applyCalibration(SUPER, {
            employeeId: 87,
            toBox: 'low-low',
            reason: 'r',
            sessionId: 1,
            cycleId: 9,
        });
        expect(out).toBeNull();
        expect(mockDb.run).not.toHaveBeenCalled();
        expect(mockTrigger.triggerForPlacement).not.toHaveBeenCalled();
    });

    test('a box outside the vocabulary is rejected before any read or write', async () => {
        await expect(
            NineBox.applyCalibration(SUPER, { employeeId: 1, toBox: '4', reason: 'r' })
        ).rejects.toThrow(/performance\/potential must be low\|medium\|high/);
        expect(mockDb.get).not.toHaveBeenCalled();
        expect(mockDb.run).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// F3 — archive / reject clear the orphaned mirror in the same transaction
// ---------------------------------------------------------------------------
describe('F3: archive() and reject() do not leave the talent_placements mirror behind', () => {
    const approved = { id: 51, employeeId: 68963, status: 'approved', box: 1, boxLabel: 'Concern' };
    const draft = {
        id: 48,
        employeeId: 87,
        status: 'draft',
        box: 5,
        boxLabel: 'Critical Contributor',
    };
    const mirrorRow = { cycleId: 9, box: 'low-low', tier: 'up', source: 'auto' };

    const wire = (ev, stillApproved, mirror) =>
        routeGet([
            [/SELECT \* FROM nine_box_evaluations WHERE id = \?/, ev],
            [
                /SELECT id FROM nine_box_evaluations WHERE employee_id = \? AND status = 'approved' LIMIT 1/,
                stillApproved,
            ],
            [
                /FROM talent_placements WHERE employee_id = \? ORDER BY cycle_id DESC LIMIT 1/,
                mirror,
            ],
        ]);

    test('archiving the approved placement deletes its mirror row and copies the old box into the event detail', async () => {
        wire(approved, undefined, mirrorRow);
        await NineBox.archive(SUPER, 51, null);

        expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
        const del = runsMatching(
            /DELETE FROM talent_placements WHERE employee_id = \? AND cycle_id = \?/
        );
        expect(del).toHaveLength(1);
        expect(del[0][1]).toEqual([68963, 9]);

        const evt = runsMatching(/INSERT INTO nine_box_events/)[0];
        expect(evt[1].slice(4, 7)).toEqual(['archive', 'approved', 'archived']);
        expect(JSON.parse(evt[1][7])).toEqual({
            box: 1,
            boxLabel: 'Concern',
            clearedPlacement: { cycleId: 9, box: 'low-low', tier: 'up', source: 'auto' },
        });
        // The status change happens BEFORE the orphan check, inside the same transaction.
        const seq = runs().map(([s]) => s);
        expect(seq.findIndex((s) => /SET status='archived'/.test(s))).toBeLessThan(
            seq.findIndex((s) => /DELETE FROM talent_placements/.test(s))
        );
    });

    test('archiving leaves the mirror alone while another approval still stands', async () => {
        wire({ ...approved, id: 40, status: 'archived' }, { id: 51 }, mirrorRow);
        await NineBox.archive(SUPER, 40, null);
        expect(runsMatching(/DELETE FROM talent_placements/)).toHaveLength(0);
        expect(runsMatching(/INSERT INTO nine_box_events/)[0][1][7]).toBeNull();
    });

    test('rejecting a proposal clears an ORPHAN mirror (no approved position left) and records it', async () => {
        mockEmployees.findById.mockResolvedValue({ id: 87, supervisorId: null, managerId: null });
        wire(draft, undefined, {
            cycleId: 9,
            box: 'medium-medium',
            tier: 'mid',
            source: 'override',
        });
        await NineBox.reject(SUPER, 48, 'not supported by evidence', null);

        expect(mockDb.runTransaction).toHaveBeenCalledTimes(1);
        expect(runsMatching(/DELETE FROM talent_placements/)[0][1]).toEqual([87, 9]);
        const evt = runsMatching(/INSERT INTO nine_box_events/)[0];
        expect(evt[1].slice(4, 7)).toEqual(['reject', 'draft', 'rejected']);
        expect(JSON.parse(evt[1][7])).toEqual({
            reason: 'not supported by evidence',
            clearedPlacement: { cycleId: 9, box: 'medium-medium', tier: 'mid', source: 'override' },
        });
    });

    test('rejecting a proposal never touches a mirror backed by a standing approval', async () => {
        mockEmployees.findById.mockResolvedValue({ id: 87, supervisorId: null, managerId: null });
        wire(draft, { id: 99 }, mirrorRow);
        await NineBox.reject(SUPER, 48, 'reason', null);
        expect(runsMatching(/DELETE FROM talent_placements/)).toHaveLength(0);
        expect(JSON.parse(runsMatching(/INSERT INTO nine_box_events/)[0][1][7])).toEqual({
            reason: 'reason',
        });
    });
});

// ---------------------------------------------------------------------------
// F4 — the mirror cycle is deterministic and never a closed one
// ---------------------------------------------------------------------------
describe('F4: where the mirror lands when no cycle is open', () => {
    test('an open cycle (closing soonest) wins', async () => {
        routeGet([
            [/WHERE status = 'open' ORDER BY closes_at LIMIT 1/, { id: 14, status: 'open' }],
        ]);
        expect(await NineBox._resolveMirrorCycle()).toEqual({ id: 14, status: 'open' });
        expect(gets()).toHaveLength(1);
    });

    test('otherwise a NON-closed cycle, locked before draft, newest first, id DESC as the tie-break', async () => {
        routeGet([
            [/WHERE status = 'open'/, undefined],
            [/FROM assessment_cycles WHERE status <> 'closed'/, { id: 9, status: 'locked' }],
        ]);
        expect(await NineBox._resolveMirrorCycle()).toEqual({ id: 9, status: 'locked' });
        const fallback = gets()[1][0];
        expect(fallback).toMatch(/WHERE status <> 'closed'/);
        expect(fallback).toMatch(
            /ORDER BY CASE WHEN status = 'locked' THEN 0 ELSE 1 END, COALESCE\(opened_at, created_at\) DESC, id DESC LIMIT 1/
        );
    });

    test('only closed cycles → no mirror at all, reported as no_active_cycle (never back-dated into a closed campaign)', async () => {
        routeGet([[/assessment_cycles/, undefined]]);
        const out = await NineBox._mirrorApproved({
            employeeId: 87,
            potential: 'medium',
            performance: 'medium',
            cellTier: 2,
        });
        expect(out).toEqual({ skipped: 'no_active_cycle' });
        expect(runsMatching(/INSERT INTO talent_placements/)).toHaveLength(0);
    });

    test('the mirror reports whether MAX(cycle_id) consumers can see it', async () => {
        routeGet([
            [/WHERE status = 'open'/, undefined],
            [/status <> 'closed'/, { id: 6, status: 'draft' }],
            [/SELECT MAX\(cycle_id\) AS m FROM talent_placements/, { m: 9 }],
        ]);
        const out = await NineBox._mirrorApproved({
            employeeId: 87,
            potential: 'medium',
            performance: 'medium',
            cellTier: 2,
            positionSource: 'manager',
        });
        expect(out).toEqual({
            cycleId: 6,
            cycleStatus: 'draft',
            box: 'medium-medium',
            visibleToConsumers: false,
        });
        expect(runsMatching(/INSERT INTO talent_placements/)[0][1].slice(0, 5)).toEqual([
            87,
            6,
            'medium-medium',
            'mid',
            'override',
        ]);
    });

    test('approve() attaches the mirror marker and uses the shared resolver (no ad-hoc ORDER BY opened_at fallback left)', () => {
        const nb = read('src/services/NineBoxService.js');
        expect(nb).not.toMatch(/ORDER BY COALESCE\(opened_at, created_at\) DESC LIMIT 1'/);
        expect(nb).toMatch(
            /approved\.mirror = await this\._mirrorContained\(\s*approved,\s*\{\s*placedBy: auth\.isAdmin \? user\.id : null,?\s*\}\s*,?\s*\)/
        );
    });
});

// ---------------------------------------------------------------------------
// F5 — the facilitator's distribution is the session's cycle + scope
// ---------------------------------------------------------------------------
describe('F5: distributionFor reads the session, not the org-wide MAX cycle', () => {
    test('site-scoped session on cycle 6 → cycle 6 AND e.site_id', async () => {
        mockDb.all.mockResolvedValue([{ box: 'high-high', n: 1 }]);
        const rows = await Calib.distributionFor({
            id: 1,
            cycleId: 6,
            scopeType: 'site',
            scopeId: 13,
        });
        expect(rows).toEqual([{ box: 'high-high', n: 1 }]);
        const [sql, params] = mockDb.all.mock.calls[0];
        expect(norm(sql)).toMatch(
            /FROM talent_placements tp JOIN employees e ON e\.id = tp\.employee_id/
        );
        expect(norm(sql)).toMatch(
            /tp\.cycle_id = COALESCE\(\?, \(SELECT MAX\(cycle_id\) FROM talent_placements\)\) AND e\.site_id = \?/
        );
        expect(params).toEqual([6, 13]);
    });

    test.each([
        ['department', 'e.department_id'],
        ['service', 'e.service_id'],
    ])('%s scope filters on %s', async (type, col) => {
        await Calib.distributionFor({ cycleId: 2, scopeType: type, scopeId: 7 });
        const [sql, params] = mockDb.all.mock.calls[0];
        expect(norm(sql)).toContain(`${col} = ?`);
        expect(params).toEqual([2, 7]);
    });

    test('org scope adds no filter; a session with no cycle falls back to the latest mirrored cycle', async () => {
        await Calib.distributionFor({ cycleId: null, scopeType: 'org', scopeId: null });
        const [sql, params] = mockDb.all.mock.calls[0];
        expect(norm(sql)).not.toMatch(/e\.(site|department|service)_id/);
        expect(params).toEqual([null]);
    });

    test('a governed-employee list restricts further, and an empty list short-circuits to [] without a query', async () => {
        await Calib.distributionFor({ cycleId: 6, scopeType: 'site', scopeId: 13 }, [89, 90]);
        const [sql, params] = mockDb.all.mock.calls[0];
        expect(norm(sql)).toMatch(/AND tp\.employee_id = ANY\(\?\)/);
        expect(params).toEqual([6, 13, [89, 90]]);

        mockDb.all.mockClear();
        expect(
            await Calib.distributionFor({ cycleId: 6, scopeType: 'site', scopeId: 13 }, [])
        ).toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('getCalibration and the clearance-scoped route both use it (the org-wide MAX query is gone)', async () => {
        routeGet([
            [/FROM calibration_sessions/, { id: 5, cycleId: 6, scopeType: 'site', scopeId: 13 }],
        ]);
        mockDb.all.mockResolvedValueOnce([]).mockResolvedValueOnce([{ box: 'high-high', n: 1 }]);
        const s = await Calib.getCalibration(5);
        expect(s.distribution).toEqual([{ box: 'high-high', n: 1 }]);
        const [sql, params] = mockDb.all.mock.calls[1];
        expect(norm(sql)).toMatch(/e\.site_id = \?/);
        expect(params).toEqual([6, 13]);

        const route = read('src/routes/v2-capability.js');
        expect(route).toMatch(/s\.distribution = await Calib\.distributionFor\(s, \[\.\.\.gov\]\)/);
        expect(route).not.toMatch(
            /WHERE cycle_id = \(SELECT MAX\(cycle_id\) FROM talent_placements\)\s+AND employee_id = ANY/
        );
    });
});
