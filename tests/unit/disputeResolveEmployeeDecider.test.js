'use strict';
/**
 * L0/L1 dispute resolution was unusable for the very people who own it.
 *
 * `skill_assessments.assessed_by` is a foreign key onto `admins(id)`, but the
 * routes hand the service the ACTING USER:
 *
 *     POST /v2/slf/disputes/:id/resolve-l0 → resolveL0({ decidedBy: req.user.id })
 *     POST /v2/slf/disputes/:id/resolve-l1 → resolveL1({ decidedBy: req.user.id })
 *
 * and for a supervisor or a manager `req.user.id` is an EMPLOYEE id. The old
 * helper only fell back to a system attribution when `decidedBy` was null, so a
 * real employee id went straight into the FK column.
 *
 * Measured on idevelop (in-transaction probe, rolled back), decider = employee 136:
 *
 *   resolveL1({ decidedRating: 3 }) threw:
 *     insert or update on table "skill_assessments" violates foreign key
 *     constraint "skill_assessments_assessed_by_fkey"
 *   → the route answered HTTP 500 and the dispute was NOT resolved.
 *   The same call with decidedRating: null returned 200 { resolved: true } —
 *   it "worked" only when there was nothing to promote.
 *
 * views/pages/slf/disputes.ejs REQUIRES an integer 0–4 before it will submit, so
 * every "Resolve" click by a non-admin manager or supervisor took the failing
 * path: L0 and L1 resolution were dead from the UI.
 *
 * Same bug class as the L2 auto-finalisation fix ([[disputeAutoFinalizePromotes]]),
 * which only handled `decidedBy == null`. The rule these tests lock in: an id that
 * is not a real admin is treated exactly like no id at all — the OFFICIAL skill row
 * gets a valid admin attribution, while `assessment_disputes.decided_by` keeps
 * recording the real person who decided.
 *
 * DB mocked; the live behaviour is proven by the rolled-back probe above.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockSkill = { upsert: jest.fn() };
jest.mock('../../src/models/SkillAssessmentModel', () => mockSkill);
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(undefined),
}));

const DisputeServiceV2 = require('../../src/services/DisputeServiceV2');

const REVIEW_ID = 501;
const EMPLOYEE_ID = 900;
const SKILL_ID = 12;

/** Employee ids of the two people who actually decide L0/L1 — neither is an admin. */
const SUPERVISOR = 137;
const MANAGER = 136;

/** idevelop holds exactly these two admins. */
const REAL_ADMINS = [1, 68];

/**
 * Route db.get by SQL text (not call order), so a change in the number of
 * lookups cannot silently make these tests pass for the wrong reason.
 * `admins` is the set of ids that really exist in the admins table.
 */
function wireDb({ admins = REAL_ADMINS, changes = 1 } = {}) {
    const present = new Set(admins.map(Number));
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes });
    mockDb.get.mockImplementation(async (sql, params = []) => {
        if (
            /sr\.employee_id, sr\.skill_id, sa\.superseded_at\s+FROM supervisor_reviews sr/.test(
                sql
            )
        )
            return { employeeId: EMPLOYEE_ID, skillId: SKILL_ID, supersededAt: null };
        if (/FROM admins WHERE id = \?/.test(sql))
            return present.has(Number(params[0])) ? { id: Number(params[0]) } : undefined;
        if (/FROM admins WHERE username = 'admin'/.test(sql))
            return present.has(1) ? { id: 1 } : undefined;
        if (/FROM admins ORDER BY id/.test(sql))
            return present.size ? { id: Math.min(...present) } : undefined;
        if (/supervisor_review_id FROM assessment_disputes/.test(sql))
            return { supervisorReviewId: REVIEW_ID };
        if (/employee_id FROM assessment_disputes/.test(sql)) return { employeeId: EMPLOYEE_ID };
        return undefined;
    });
}

/** The parameters of the UPDATE that records the decision on the dispute row. */
function disputeUpdateParams() {
    const call = mockDb.run.mock.calls.find(([sql]) => /UPDATE assessment_disputes/.test(sql));
    return call ? call[1] : null;
}

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset();
    mockDb.runTransaction.mockReset();
    mockSkill.upsert.mockReset().mockResolvedValue({});
    wireDb();
});

describe('a manager resolving at L1 — the exact failing UI path', () => {
    test('a rated resolution succeeds instead of throwing the FK violation', async () => {
        await expect(
            DisputeServiceV2.resolveL1({
                disputeId: 7,
                decidedBy: MANAGER,
                decidedRating: 3,
                reason: 'Evidence reviewed with the supervisor.',
            })
        ).resolves.toEqual({ resolved: true });
    });

    test('the employee id NEVER reaches skill_assessments.assessed_by', async () => {
        await DisputeServiceV2.resolveL1({
            disputeId: 7,
            decidedBy: MANAGER,
            decidedRating: 3,
            reason: 'Evidence reviewed.',
        });
        expect(mockSkill.upsert).toHaveBeenCalledTimes(1);
        const arg = mockSkill.upsert.mock.calls[0][0];
        expect(arg.assessedBy).not.toBe(MANAGER);
        expect(REAL_ADMINS).toContain(arg.assessedBy);
    });

    test('the decided rating still lands on the official skill profile', async () => {
        await DisputeServiceV2.resolveL1({
            disputeId: 7,
            decidedBy: MANAGER,
            decidedRating: 3,
            reason: 'Evidence reviewed.',
        });
        expect(mockSkill.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                employeeId: EMPLOYEE_ID,
                skillId: SKILL_ID,
                currentLevel: 3,
            })
        );
    });

    test('rating 0 is a decision, not an absent one — it is promoted too', async () => {
        await DisputeServiceV2.resolveL1({
            disputeId: 7,
            decidedBy: MANAGER,
            decidedRating: 0,
            reason: 'Not yet demonstrated.',
        });
        expect(mockSkill.upsert).toHaveBeenCalledWith(expect.objectContaining({ currentLevel: 0 }));
    });

    test('the REAL decider is still recorded on the dispute row', async () => {
        await DisputeServiceV2.resolveL1({
            disputeId: 7,
            decidedBy: MANAGER,
            decidedRating: 3,
            reason: 'Evidence reviewed.',
        });
        // Substituting an admin for the FK must not launder away who decided.
        expect(disputeUpdateParams()).toEqual([MANAGER, 3, 'Evidence reviewed.', 7]);
    });
});

describe('a supervisor resolving at L0 — same path, one rung down', () => {
    test('a rated resolution succeeds and attributes to an admin', async () => {
        await expect(
            DisputeServiceV2.resolveL0({
                disputeId: 9,
                decidedBy: SUPERVISOR,
                decidedRating: 2,
                reason: 'Re-observed on shift.',
            })
        ).resolves.toEqual({ resolved: true });
        const arg = mockSkill.upsert.mock.calls[0][0];
        expect(arg.assessedBy).not.toBe(SUPERVISOR);
        expect(REAL_ADMINS).toContain(arg.assessedBy);
        expect(arg.currentLevel).toBe(2);
    });

    test('the real supervisor is what the dispute row records', async () => {
        await DisputeServiceV2.resolveL0({
            disputeId: 9,
            decidedBy: SUPERVISOR,
            decidedRating: 2,
            reason: 'Re-observed on shift.',
        });
        expect(disputeUpdateParams()).toEqual([SUPERVISOR, 2, 'Re-observed on shift.', 9]);
    });
});

describe('the attribution rule itself', () => {
    test('a decider who IS an admin keeps their own attribution', async () => {
        await DisputeServiceV2._applyDecidedRatingToSkill(REVIEW_ID, 4, 68);
        expect(mockSkill.upsert).toHaveBeenCalledWith(expect.objectContaining({ assessedBy: 68 }));
    });

    test('no decider at all (the automatic L2 path) still resolves a system admin', async () => {
        await DisputeServiceV2._applyDecidedRatingToSkill(REVIEW_ID, 1, null);
        expect(mockSkill.upsert).toHaveBeenCalledWith(expect.objectContaining({ assessedBy: 1 }));
    });

    test('an id that is not an admin is checked against admins(id), not guessed', async () => {
        await DisputeServiceV2._applyDecidedRatingToSkill(REVIEW_ID, 3, MANAGER);
        const probed = mockDb.get.mock.calls.some(
            ([sql, p]) => /FROM admins WHERE id = \?/.test(sql) && Number(p[0]) === MANAGER
        );
        expect(probed).toBe(true);
    });

    test('with no admins to attribute to, the promotion is skipped — never thrown', async () => {
        wireDb({ admins: [] });
        await expect(
            DisputeServiceV2._applyDecidedRatingToSkill(REVIEW_ID, 3, MANAGER)
        ).resolves.toBeUndefined();
        expect(mockSkill.upsert).not.toHaveBeenCalled();
    });

    test('no rating means nothing to promote (the case that always "worked")', async () => {
        await DisputeServiceV2._applyDecidedRatingToSkill(REVIEW_ID, null, MANAGER);
        expect(mockSkill.upsert).not.toHaveBeenCalled();
    });
});

describe('a resolution this call no longer owns promotes nothing', () => {
    test('an already-resolved / escalated dispute writes no skill row', async () => {
        wireDb({ changes: 0 });
        await expect(
            DisputeServiceV2.resolveL1({
                disputeId: 7,
                decidedBy: MANAGER,
                decidedRating: 3,
                reason: 'Evidence reviewed.',
            })
        ).resolves.toEqual({ resolved: false });
        expect(mockSkill.upsert).not.toHaveBeenCalled();
    });
});
