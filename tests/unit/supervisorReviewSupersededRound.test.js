'use strict';
/**
 * A SUPERVISOR REVIEW BELONGS TO THE ROUND IT JUDGED — NOT TO "THE CURRENT ONE".
 *
 * WHAT BROKE. Migration 113 turned `self_assessments` from a table into a VIEW:
 *
 *     SELECT … FROM self_assessment_rounds WHERE superseded_at IS NULL
 *
 * i.e. the CURRENT measurement of each (employee, skill). Its header promised
 * "every existing reader and writer therefore keeps meaning exactly what it
 * meant before". That is false for any reader joined to a row that is itself a
 * ROUND: `supervisor_reviews.self_assessment_id` is a foreign key onto ONE
 * round, so the moment a new campaign asked the person again — the only code
 * path that sets `superseded_at`, SelfAssessmentService.createOrUpdateSelfAssessment —
 * every one of those joins lost the row.
 *
 * Measured by execution on a development database, review 1023 / round 223929
 * (replaced 2026-09-13, self_rated_level = 3, notes "UAT3 lot1 - tour 1"),
 * supervisor uat.manager (employee 136):
 *
 *   BEFORE the fix                                    AFTER
 *   findForReviewer(136) .............. 0 rows        1 row
 *   findByEmployeeId(138) ............. 0 rows        1 row   ← the employee's
 *                                                              only "Contester"
 *                                                              button lives here,
 *                                                              so the 30-day right
 *                                                              of appeal became
 *                                                              unreachable
 *   findByIdWithSkill(1023) ........... selfRatedLevel null    3
 *   GET /supervisor/reviews/1023 ...... "const selfRating = 0" "const selfRating = 3"
 *   POST …/1023/complete .............. HTTP 500              HTTP 200
 *                                       (TypeError: Cannot read properties of
 *                                        undefined (reading 'selfRatedLevel'))
 *
 * The 500 is the worst of them: the controller answers "Could not complete the
 * review. Please try again." — a retry that can NEVER succeed. The review stayed
 * 'pending' for ever, invisible in the queue and impossible to decide.
 *
 * The zero is the second worst. The page fell back to `0` for a missing
 * self-rating, so a reviewer entering 3 against a real 3 was shown a gap of +3
 * ("well above"). House rule 11, inverted: an existing measurement rendered as
 * an absent one — and then arithmetic done on the absence.
 *
 * WHAT THESE TESTS PREVENT.
 *   1. Any read of a REVIEW silently going back to the `self_assessments` view.
 *   2. `completeSupervisorReview` dereferencing a missing round (the TypeError),
 *      or reporting success on an UPDATE that touched no row.
 *   3. A replaced round's decision being promoted over the newer official level.
 *   4. Queues of MEASUREMENTS (reviewQueue, bulkApprove, completionStats) being
 *      "fixed" the same way — they legitimately mean the current round, and
 *      resurrecting history there would show two lines for one competency.
 */

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

// ---------------------------------------------------------------------------
// 1. Every REVIEW read addresses the rounds TABLE
// ---------------------------------------------------------------------------
describe('SupervisorReviewModel — the join is on the round that was judged', () => {
    const src = read('src/models/SupervisorReviewModel.js');
    // Statement bodies only: the file's header comment explains the view on
    // purpose, and must not be mistaken for a query.
    const sql = src.replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/.*)$/gm, '');

    test('no query joins the self_assessments VIEW any more', () => {
        expect(sql).not.toMatch(/JOIN\s+selfAssessments\b/i);
        expect(sql).not.toMatch(/JOIN\s+self_assessments\b/i);
    });

    test('all seven reads join self_assessment_rounds', () => {
        const joins =
            sql.match(
                /JOIN\s+self_assessment_rounds\s+sa\s+ON\s+sr\.selfAssessmentId\s*=\s*sa\.id/gi
            ) || [];
        expect(joins.length).toBe(7);
    });

    test('the join key is the rounds PRIMARY KEY, so no row can fan out', () => {
        // sr.self_assessment_id → sa.id. If this ever became a (employee, skill)
        // join the queue would show one line per round of the same competency.
        expect(sql).not.toMatch(/JOIN\s+self_assessment_rounds[\s\S]{0,120}?sa\.employee_id\s*=/i);
    });

    test('each read carries superseded_at, so a surface can SAY the round was replaced', () => {
        // The house rule is that nothing disappears — it changes state and says so.
        const carried = (sql.match(/sa\.superseded_at/g) || []).length;
        expect(carried).toBeGreaterThanOrEqual(7);
    });

    test('the pending queue carries the employee name the template actually reads', () => {
        // views/pages/supervisor/reviews.ejs renders r.firstName + ' ' + r.lastName;
        // the projection only had `employeeName`, so the name cell was blank.
        expect(sql).toMatch(/e\.firstName,\s*e\.lastName/);
    });
});

// ---------------------------------------------------------------------------
// 2. Queues of MEASUREMENTS deliberately keep the view
// ---------------------------------------------------------------------------
describe('SelfAssessmentWorkflowService — current round vs judged round, decided one by one', () => {
    const src = read('src/services/SelfAssessmentWorkflowService.js');

    test('the review QUEUE still reads the view (it lists current measurements)', () => {
        const queue = src.slice(
            src.indexOf('async reviewQueue('),
            src.indexOf('async reviewQueueByEmployee(')
        );
        expect(queue).toMatch(/FROM self_assessments sa/);
        expect(queue).not.toMatch(/FROM self_assessment_rounds sa\b/);
    });

    test('the FINALISATION reads the round that was judged', () => {
        const fin = src.slice(
            src.indexOf('async _finalizeSupervisorReview('),
            src.indexOf('// ---- transitions')
        );
        expect(fin).toMatch(/JOIN self_assessment_rounds sa ON sa\.id = sr\.self_assessment_id/);
        expect(fin).not.toMatch(/JOIN self_assessments sa ON sa\.id = sr\.self_assessment_id/);
    });
});

// ---------------------------------------------------------------------------
// 3. Completing a review — behaviour, with the database mocked
// ---------------------------------------------------------------------------
describe('SelfAssessmentService.completeSupervisorReview', () => {
    const REVIEW_ID = 1023;
    const ROUND_ID = 223929;
    const EMPLOYEE = 138;
    const SKILL = 299;

    let mockDb, mockReviews, mockSkill, svc;

    /**
     * @param round  the row `self_assessment_rounds` returns for ROUND_ID
     *               (null = the round is genuinely gone)
     * @param advanced  rows touched by the UPDATE of the round
     */
    function load({ round, advanced = 1 } = {}) {
        jest.resetModules();

        mockDb = {
            get: jest.fn(async (sql, params = []) => {
                if (/FROM self_assessment_rounds WHERE id = \?/.test(sql)) return round;
                if (/FROM admins WHERE username = 'admin'/.test(sql)) return { id: 1 };
                return undefined;
            }),
            all: jest.fn(async () => []),
            run: jest.fn(async (sql) =>
                /UPDATE self_assessment_rounds/.test(sql) ? { changes: advanced } : { changes: 1 }
            ),
            runTransaction: jest.fn(async (fn) => fn()),
        };
        mockReviews = {
            findById: jest.fn(async () => ({
                id: REVIEW_ID,
                selfAssessmentId: ROUND_ID,
                employeeId: EMPLOYEE,
                skillId: SKILL,
                reviewedBy: 136,
            })),
            update: jest.fn(async () => ({})),
        };
        mockSkill = { upsert: jest.fn(async () => ({})) };

        jest.doMock('../../src/config/database', () => mockDb);
        jest.doMock('../../src/models/SupervisorReviewModel', () => mockReviews);
        jest.doMock('../../src/models/SkillAssessmentModel', () => mockSkill);
        jest.doMock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
        jest.doMock('../../src/services/NotificationService', () => ({
            notify: jest.fn(async () => {}),
        }));

        svc = require('../../src/services/SelfAssessmentService');
    }

    const currentRound = {
        id: ROUND_ID,
        employeeId: EMPLOYEE,
        skillId: SKILL,
        selfRatedLevel: 3,
        notes: 'x',
        supersededAt: null,
    };
    const replacedRound = { ...currentRound, supersededAt: '2026-09-13T14:44:34.989Z' };

    test('the round is read from the TABLE, never from the view', async () => {
        load({ round: currentRound });
        await svc.completeSupervisorReview(REVIEW_ID, 3, null, null, null);
        const reads = mockDb.get.mock.calls.map(([sql]) => sql).join('\n');
        expect(reads).toMatch(/FROM self_assessment_rounds WHERE id = \?/);
        expect(reads).not.toMatch(/FROM self_assessments\b/);
    });

    test('a REPLACED round completes instead of throwing (the HTTP 500)', async () => {
        load({ round: replacedRound });
        await expect(
            svc.completeSupervisorReview(REVIEW_ID, 3, null, null, null)
        ).resolves.toBeDefined();
        expect(mockReviews.update).toHaveBeenCalledWith(
            REVIEW_ID,
            expect.objectContaining({ status: 'completed', supervisorRatedLevel: 3 })
        );
    });

    test('the gap is computed against the level of the round that was judged', async () => {
        load({ round: replacedRound }); // employee said 3 in that round
        await svc.completeSupervisorReview(REVIEW_ID, 1, null, null, null);
        expect(mockReviews.update).toHaveBeenCalledWith(
            REVIEW_ID,
            expect.objectContaining({ gap: -2 })
        );
    });

    test('a round that is really gone is REFUSED in words, never as a TypeError', async () => {
        load({ round: null });
        await expect(svc.completeSupervisorReview(REVIEW_ID, 3, null, null, null)).rejects.toThrow(
            /no longer exists/i
        );
        // and nothing was written on the way out
        expect(mockReviews.update).not.toHaveBeenCalled();
        expect(mockSkill.upsert).not.toHaveBeenCalled();
    });

    test('the state advance targets the ROUND, not the view', async () => {
        load({ round: currentRound });
        await svc.completeSupervisorReview(REVIEW_ID, 3, null, null, null);
        const writes = mockDb.run.mock.calls.map(([sql]) => sql).join('\n');
        expect(writes).toMatch(/UPDATE self_assessment_rounds[\s\S]*workflow_state = 'reviewed'/);
        expect(writes).not.toMatch(/UPDATE self_assessments\b/);
    });

    test('an advance that touches NO row is a refusal, not a silent success', async () => {
        // This is what the view did for every replaced round: 0 rows, no error,
        // review 'completed' while the measurement stayed 'submitted'.
        load({ round: currentRound, advanced: 0 });
        await expect(svc.completeSupervisorReview(REVIEW_ID, 3, null, null, null)).rejects.toThrow(
            /could not be updated/i
        );
    });

    test('a CURRENT round promotes the validated level to the official profile', async () => {
        load({ round: currentRound });
        await svc.completeSupervisorReview(REVIEW_ID, 2, null, null, null);
        expect(mockSkill.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                employeeId: EMPLOYEE,
                skillId: SKILL,
                currentLevel: 2,
            })
        );
    });

    test('a REPLACED round does NOT overwrite the newer official level', async () => {
        // A later round exists and may already have been decided at another
        // level; promoting the older decision would regress the profile in
        // silence. The review still closes — only the promotion is withheld.
        load({ round: replacedRound });
        await svc.completeSupervisorReview(REVIEW_ID, 2, null, null, null);
        expect(mockSkill.upsert).not.toHaveBeenCalled();
        expect(mockReviews.update).toHaveBeenCalled();
    });

    // -- house rule 11, on the same path -------------------------------------
    // `supervisorRatedLevel - null` is `supervisorRatedLevel` in JavaScript, so
    // a round the employee never rated was written as "Écart +3" under a
    // validated 3: an ABSENCE of measurement rendered as a level 0 nobody gave.
    // The V2 path (SelfAssessmentWorkflowService._finalizeSupervisorReview)
    // already answers null here; this is the V1 console catching up.
    const unrated = { ...currentRound, selfRatedLevel: null };

    test('no self-rating on the judged round means NO GAP, not the reviewer’s level', async () => {
        load({ round: unrated });
        await svc.completeSupervisorReview(REVIEW_ID, 3, null, null, null);
        expect(mockReviews.update).toHaveBeenCalledWith(
            REVIEW_ID,
            expect.objectContaining({ gap: null })
        );
    });

    test('an unmeasured gap is never printed as a number in the official note', async () => {
        load({ round: unrated });
        await svc.completeSupervisorReview(REVIEW_ID, 3, null, null, null);
        const notes = mockSkill.upsert.mock.calls[0][0].notes;
        expect(notes).not.toMatch(/Gap:/);
        expect(notes).toMatch(/no self-rating/i);
    });

    test('a genuine gap of 0 is still a measurement, and still says so', async () => {
        load({ round: currentRound }); // employee said 3
        await svc.completeSupervisorReview(REVIEW_ID, 3, null, null, null);
        expect(mockReviews.update).toHaveBeenCalledWith(
            REVIEW_ID,
            expect.objectContaining({ gap: 0 })
        );
        expect(mockSkill.upsert.mock.calls[0][0].notes).toMatch(/confirmed self-rating/);
    });

    test('the trail records WHICH round was judged and whether it was current', async () => {
        load({ round: replacedRound });
        await svc.completeSupervisorReview(REVIEW_ID, 2, null, null, null);
        const ev = mockDb.run.mock.calls.find(([sql]) =>
            /INSERT INTO self_assessment_events/.test(sql)
        );
        expect(ev).toBeDefined();
        expect(JSON.parse(ev[1][2])).toEqual(expect.objectContaining({ supersededRound: true }));
    });
});
