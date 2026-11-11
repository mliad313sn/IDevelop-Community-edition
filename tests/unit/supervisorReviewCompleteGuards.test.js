'use strict';
/**
 * SA-42: the former supervisor console, POST /supervisor/reviews/:id/complete,
 * decided a review with no guard. It completed reviews already decided, revived
 * cancelled or rejected rounds, overwrote disputed ones, accepted any integer
 * level and recorded from_state 'submitted' whatever the real state was.
 *
 * Now: review status 'pending' only; round 'submitted' or 'under_review' (an
 * atomic guard, like _setState guardFrom); level 0-4, otherwise 400; the real
 * from_state in the trail. Only a person GovernanceService.canReview accepts
 * may complete.
 */

const REVIEW_ID = 501;
const ROUND_ID = 9001;

let mockDb, mockReviews, mockSkill, mockGov, svc, ctrl;

function load({ review = {}, round = {}, advanced = 1, canReview = true } = {}) {
    jest.resetModules();
    const theRound =
        round === null
            ? null
            : {
                  id: ROUND_ID,
                  employeeId: 70,
                  skillId: 9,
                  selfRatedLevel: 2,
                  notes: null,
                  supersededAt: null,
                  workflowState: 'submitted',
                  ...round,
              };
    mockDb = {
        get: jest.fn(async (sql) => {
            if (/FROM self_assessment_rounds WHERE id = \?/.test(sql)) return theRound;
            if (/FROM admins WHERE username = 'admin'/.test(sql)) return { id: 1 };
            return undefined;
        }),
        all: jest.fn(async () => []),
        run: jest.fn(async (sql, params) => {
            if (/UPDATE self_assessment_rounds/.test(sql)) {
                // Honour the guard the way PostgreSQL would.
                const guarded = /workflow_state IN \('submitted', 'under_review'\)/.test(sql);
                const ok =
                    theRound &&
                    (!guarded || ['submitted', 'under_review'].includes(theRound.workflowState));
                return { changes: ok ? advanced : 0, params };
            }
            return { changes: 1 };
        }),
        runTransaction: jest.fn(async (fn) => fn()),
    };
    mockReviews = {
        findById: jest.fn(async () => ({
            id: REVIEW_ID,
            selfAssessmentId: ROUND_ID,
            employeeId: 70,
            skillId: 9,
            reviewedBy: 60,
            status: 'pending',
            ...review,
        })),
        update: jest.fn(async () => ({})),
    };
    mockSkill = { upsert: jest.fn(async () => ({})) };
    mockGov = { canReview: jest.fn(async () => canReview) };
    jest.doMock('../../src/config/database', () => mockDb);
    jest.doMock('../../src/models/SupervisorReviewModel', () => mockReviews);
    jest.doMock('../../src/models/SkillAssessmentModel', () => mockSkill);
    jest.doMock('../../src/services/GovernanceService', () => mockGov);
    jest.doMock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
    jest.doMock('../../src/services/NotificationService', () => ({
        notify: jest.fn(async () => {}),
    }));
    svc = require('../../src/services/SelfAssessmentService');
    ctrl = require('../../src/controllers/SupervisorReviewController');
}

function call(body, user = { id: 60, userType: 'employee' }) {
    const res = {
        statusCode: 200,
        body: null,
        status(c) {
            this.statusCode = c;
            return this;
        },
        json(b) {
            this.body = b;
            return this;
        },
    };
    const req = {
        params: { reviewId: String(REVIEW_ID) },
        body,
        user,
        t: (k) => k,
        ip: '::1',
        get: () => 'jest',
    };
    return ctrl.completeReview(req, res).then(() => res);
}

const writes = () => mockDb.run.mock.calls.filter(([sql]) => /INSERT|UPDATE/.test(sql));

describe('level must be on the 0-4 scale (400)', () => {
    test.each([[-1], [5], [7], [2.5], ['abc'], [''], [undefined]])(
        'level %p → 400, nothing written',
        async (lvl) => {
            load();
            const res = await call({ supervisorRatedLevel: lvl });
            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('assess:svr_err_level_range');
            expect(mockReviews.update).not.toHaveBeenCalled();
            expect(writes()).toHaveLength(0);
        }
    );
    test.each([[0], [4], ['3']])('level %p accepted', async (lvl) => {
        load();
        const res = await call({ supervisorRatedLevel: lvl });
        expect(res.statusCode).toBe(200);
    });
    test('the service refuses out-of-range by itself (defence in depth)', async () => {
        load();
        await expect(svc.completeSupervisorReview(REVIEW_ID, 9)).rejects.toMatchObject({
            status: 400,
        });
        expect(mockReviews.update).not.toHaveBeenCalled();
    });
});

describe('role matrix (who may complete)', () => {
    test('a person canReview accepts may complete → 200', async () => {
        load({ canReview: true });
        const res = await call({ supervisorRatedLevel: 3 });
        expect(res.statusCode).toBe(200);
        expect(mockGov.canReview).toHaveBeenCalledWith(expect.objectContaining({ id: 60 }), 70);
    });
    test.each([
        ['an unrelated employee', { id: 99, userType: 'employee' }],
        ['the employee themself', { id: 70, userType: 'employee' }],
        ['an admin outside clearance', { id: 5, userType: 'admin' }],
    ])('%s (canReview false) → 403, nothing written', async (_l, user) => {
        load({ canReview: false });
        const res = await call({ supervisorRatedLevel: 3 }, user);
        expect(res.statusCode).toBe(403);
        expect(writes()).toHaveLength(0);
        expect(mockReviews.update).not.toHaveBeenCalled();
    });
});

describe('only a pending review on a round awaiting review', () => {
    test.each(['completed', 'cancelled', 'disputed', 'rejected'])(
        'review status %s → 409, nothing written',
        async (st) => {
            load({ review: { status: st } });
            const res = await call({ supervisorRatedLevel: 3 });
            expect(res.statusCode).toBe(409);
            expect(res.body.error).toBe('assess:svr_err_review_not_pending');
            expect(writes()).toHaveLength(0);
            expect(mockSkill.upsert).not.toHaveBeenCalled();
        }
    );

    test.each([
        'cancelled',
        'rejected',
        'approved',
        'disputed',
        'draft',
        'reviewed',
        'changes_requested',
    ])('round in %s is never revived → 409, nothing written', async (ws) => {
        load({ round: { workflowState: ws } });
        const res = await call({ supervisorRatedLevel: 3 });
        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe('assess:svr_err_round_not_reviewable');
        expect(writes()).toHaveLength(0);
        expect(mockSkill.upsert).not.toHaveBeenCalled();
    });

    test('a stale concurrent completion (round moved in between) → 409 STALE_STATE, review untouched', async () => {
        load({ advanced: 0 });
        const res = await call({ supervisorRatedLevel: 3 });
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('STALE_STATE');
        expect(mockReviews.update).not.toHaveBeenCalled();
        expect(mockSkill.upsert).not.toHaveBeenCalled();
    });

    test('the round UPDATE carries the state guard', async () => {
        load();
        await call({ supervisorRatedLevel: 3 });
        const upd = mockDb.run.mock.calls.find(([sql]) =>
            /UPDATE self_assessment_rounds/.test(sql)
        );
        expect(upd[0]).toMatch(/AND workflow_state IN \('submitted', 'under_review'\)/);
    });

    test.each(['submitted', 'under_review'])(
        'from_state in the trail is the real one (%s)',
        async (ws) => {
            load({ round: { workflowState: ws } });
            const res = await call({ supervisorRatedLevel: 3 });
            expect(res.statusCode).toBe(200);
            const ev = mockDb.run.mock.calls.find(([sql]) =>
                /INSERT INTO self_assessment_events/.test(sql)
            );
            expect(ev[1][2]).toBe(ws);
        }
    );

    test('a missing round → 404 in words, not 500', async () => {
        load({ round: null });
        const res = await call({ supervisorRatedLevel: 3 });
        expect(res.statusCode).toBe(404);
    });
});
