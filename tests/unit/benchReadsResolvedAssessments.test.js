'use strict';

/**
 * The succession bench could not see approved self-assessments.
 *
 * `readinessForRole`, `seedSuccessors` and `getRoleCandidates` all joined the
 * raw `skill_assessments` table, while every other readiness surface reads
 * `v_resolved_assessments` — the UNION of supervisor-validated rows AND
 * approved self-assessments, latest per (employee, skill). ReadinessService's
 * own header documents that migration as "One source, one answer".
 *
 * So the bench computed a different denominator, a different coverage, a
 * different pct and a different gap list from the rest of the product — and
 * the coverage floor, the one guard that stops thin measurement being called
 * Ready-Now, was computed from the wrong denominator.
 *
 * `getRoleCandidates` had a second instance: its EXISTS perf guard also read
 * the raw table, so a candidate whose every measurement came through the
 * self-assessment workflow failed the test and never appeared as a candidate
 * at all.
 *
 * Latent on the dev dataset — all 136 approved self-assessments there are
 * superseded by a more recent validated row for the same (employee, skill), so
 * the view and the table agree exactly today (2714 rows each, 0 differing).
 * Proved instead by injecting five approved self-assessments inside a
 * rolled-back transaction, on requirements employee 158 had never been
 * measured on:
 *
 *   before  bench 51/63 assessed, 81 % coverage   canonical 51, 81 %
 *   after   bench 56/63 assessed, 88.9 % coverage canonical 56, 88.9 %
 *
 * Before the fix the bench stayed at 51 / 81 % while the canonical view moved.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const ContinuityService = HAS_DB ? require('../../src/services/ContinuityService') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

describe('no succession query reads the raw assessments table', () => {
    const cont = read('src/services/ContinuityService.js').replace(/\s+/g, ' ');
    const bench = read('src/models/BenchmarkModel.js').replace(/\s+/g, ' ');

    test('every join goes through v_resolved_assessments', () => {
        expect(cont).not.toMatch(/LEFT JOIN skill_assessments sa/);
        expect(bench).not.toMatch(/LEFT JOIN skill_assessments sa/);
        expect((cont.match(/LEFT JOIN v_resolved_assessments sa/g) || []).length).toBe(2);
        expect((bench.match(/LEFT JOIN v_resolved_assessments sa/g) || []).length).toBe(1);
    });

    test('the candidate EXISTS guard does too', () => {
        // Over the raw table this silently dropped anyone measured only via
        // the self-assessment workflow, before any scoring happened.
        expect(bench).toMatch(/EXISTS \(SELECT 1 FROM v_resolved_assessments x/);
        expect(bench).not.toMatch(/EXISTS \(SELECT 1 FROM skill_assessments x/);
    });

    test("the column is the view's, not the table's", () => {
        // v_resolved_assessments exposes `level`; skill_assessments has
        // `current_level`. Joining the view and reading the old column name
        // would be a hard error, but only at run time.
        expect(bench).not.toMatch(/sa\.current_level/);
        expect(cont).not.toMatch(/sa\.current_level/);
    });
});

suite('the bench agrees with the canonical view', () => {
    const EMP = 158;
    const ROLE = 87;

    const snap = async () => {
        const c = await ContinuityService.readinessForRole(EMP, ROLE);
        const v = await db.get(
            `SELECT assessed_skills AS a, coverage AS c
               FROM v_employee_assessment_coverage WHERE employee_id = ?`,
            [EMP]
        );
        return {
            benchAssessed: Number(c.assessed),
            benchCov: Number(c.coveragePct),
            canonAssessed: Number(v.a),
            canonCov: Number(v.c),
        };
    };

    test('they already agree on the committed data', async () => {
        const s = await snap();
        expect(s.benchAssessed).toBe(s.canonAssessed);
        expect(s.benchCov).toBeCloseTo(s.canonCov, 1);
    });

    test('they still agree once an approved self-assessment exists', async () => {
        const before = await snap();
        let inside = null;
        try {
            await db.runTransaction(async () => {
                const targets = await db.all(
                    `SELECT rsr.skill_id, rsr.required_level
                       FROM role_skill_requirements rsr
                      WHERE rsr.role_id = ? AND rsr.required_level > 0
                        AND NOT EXISTS (SELECT 1 FROM skill_assessments sa
                                         WHERE sa.employee_id = ? AND sa.skill_id = rsr.skill_id)
                      LIMIT 5`,
                    [ROLE, EMP]
                );
                expect(targets.length).toBeGreaterThan(0); // else this proves nothing
                for (const t of targets) {
                    await db.run(
                        `INSERT INTO self_assessments
                           (employee_id, skill_id, self_rated_level, status, workflow_state,
                            submitted_at, approved_at, approved_by, approved_by_ref)
                         VALUES (?, ?, ?, 'approved', 'approved', now(), now(), ?, ?)`,
                        [EMP, t.skillId, t.requiredLevel, 136, 'employee:136']
                    );
                }
                inside = await snap();
                throw new Error('__ROLLBACK__');
            });
        } catch (e) {
            if (!String(e.message).includes('__ROLLBACK__')) throw e;
        }

        // the measurement channel became visible to BOTH
        expect(inside.canonAssessed).toBeGreaterThan(before.canonAssessed);
        expect(inside.benchAssessed).toBe(inside.canonAssessed);
        expect(inside.benchCov).toBeCloseTo(inside.canonCov, 1);
        // and specifically: the bench did NOT stay where it was
        expect(inside.benchAssessed).toBeGreaterThan(before.benchAssessed);

        const after = await snap();
        expect(after).toEqual(before); // nothing survived the rollback
    });
});
