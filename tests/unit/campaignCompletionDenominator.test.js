'use strict';
/**
 * Campaign completion must be computed from the PARTICIPANT ROSTER
 * (migration 70), never from self_assessments.
 *
 * A self_assessments row only exists once somebody has ACTED, so a denominator
 * taken from that table counts only the people who already engaged: with 5 of
 * 78 submitted, the Executive strip and the manager digest both read
 * "100 % complete" while 73 people had not touched the campaign. These tests
 * lock the honest denominator and the empty case in place.
 *
 * DB mocked; the live-data behaviour is exercised by the rolled-back probe.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const DashboardService = require('../../src/services/DashboardService');

const CYCLE = { id: 42, code: '2026-Q3', label: '2026-Q3', closesAt: '2999-01-01T00:00:00.000Z' };

/** One aggregate row shaped like the v_cycle_participant_status rollup. */
const roster = (o = {}) => ({
    total: 0,
    excluded: 0,
    notStarted: 0,
    inProgress: 0,
    inReview: 0,
    approved: 0,
    ...o,
});

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({});
});

describe('DashboardService.getCampaignFunnel — the denominator', () => {
    test('no open cycle at all → null', async () => {
        mockDb.get.mockResolvedValueOnce(undefined);
        await expect(DashboardService.getCampaignFunnel(null)).resolves.toBeNull();
    });

    test('open cycle with nobody enrolled reads "not launched", NEVER 100 %', async () => {
        mockDb.get.mockResolvedValueOnce(roster());
        const f = await DashboardService.getCampaignFunnel(null, CYCLE);
        expect(f.launched).toBe(false);
        expect(f.completionPct).toBeNull();
        expect(f.enrolled).toBe(0);
    });

    test('people have acted but nobody is enrolled → still "not launched"', async () => {
        // This is the exact shape the old formula turned into 100 %: rows exist
        // for the 5 who submitted, and for nobody else.
        mockDb.get.mockResolvedValueOnce(roster());
        const f = await DashboardService.getCampaignFunnel(null, CYCLE);
        expect(f.completionPct).not.toBe(100);
        expect(f.completionPct).toBeNull();
    });

    test('5 of 78 submitted → 6 %, with the 73 non-starters in the denominator', async () => {
        mockDb.get.mockResolvedValueOnce(roster({ total: 78, notStarted: 73, inReview: 5 }));
        const f = await DashboardService.getCampaignFunnel(null, CYCLE);
        expect(f.enrolled).toBe(78);
        expect(f.submitted).toBe(5);
        expect(f.notStarted).toBe(73);
        expect(f.unsubmitted).toBe(73);
        expect(f.completionPct).toBe(6);
        expect(f.launched).toBe(true);
    });

    test('in-progress counts as started but NOT as submitted', async () => {
        mockDb.get.mockResolvedValueOnce(
            roster({ total: 10, notStarted: 4, inProgress: 3, inReview: 2, approved: 1 })
        );
        const f = await DashboardService.getCampaignFunnel(null, CYCLE);
        expect(f.submitted).toBe(3); // in_review + approved
        expect(f.unsubmitted).toBe(7); // not_started + in_progress
        expect(f.completionPct).toBe(30);
        expect(f.startedPct).toBe(60);
        expect(f.approvedPct).toBe(10);
    });

    test('PERSON-level exclusions leave the denominator (never a skill subset)', async () => {
        mockDb.get.mockResolvedValueOnce(
            roster({ total: 80, excluded: 5, notStarted: 70, inReview: 5 })
        );
        const f = await DashboardService.getCampaignFunnel(null, CYCLE);
        expect(f.excluded).toBe(5);
        expect(f.enrolled).toBe(75);
        expect(f.completionPct).toBe(Math.round((100 * 5) / 75));
        expect(f.notStarted + f.inProgress + f.inReview + f.approved).toBe(f.enrolled);
    });

    test('reads the roster view, never self_assessments, and scopes before aggregating', async () => {
        mockDb.get.mockResolvedValueOnce(roster({ total: 3, notStarted: 3 }));
        await DashboardService.getCampaignFunnel([7, 8, 9], CYCLE);
        const [sql, params] = mockDb.get.mock.calls[0];
        expect(sql).toContain('v_cycle_participant_status');
        expect(sql).not.toContain('self_assessments');
        expect(sql).toContain('v.employee_id IN (?,?,?)');
        expect(params).toEqual([42, 7, 8, 9]);
    });

    test('an empty scope yields "not launched", not a fabricated 100 %', async () => {
        mockDb.get.mockResolvedValueOnce(roster());
        const f = await DashboardService.getCampaignFunnel([], CYCLE);
        expect(mockDb.get.mock.calls[0][0]).toContain('AND 1 = 0');
        expect(f.launched).toBe(false);
        expect(f.completionPct).toBeNull();
    });

    test('roster view unavailable → says so, never invents a percentage', async () => {
        mockDb.get.mockRejectedValueOnce(
            new Error('relation "v_cycle_participant_status" does not exist')
        );
        const f = await DashboardService.getCampaignFunnel(null, CYCLE);
        expect(f.rosterAvailable).toBe(false);
        expect(f.completionPct).toBeNull();
        expect(f.launched).toBe(false);
    });
});
