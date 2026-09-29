'use strict';
/**
 * SECTION accounts — B1 + B2. A REFUSED self-assessment must be refusable at all, and must
 * not leave a fabricated measurement behind.
 *
 * B1 — the whole V2 rejection path was dead code. `self_assessments` carries two
 * state machines: `workflow_state` (TEXT + CHECK, always allowed 'rejected') and
 * the legacy `status` enum `self_assessment_state`, which did not. Both are
 * written together, so every rejection died on the enum. Probed:
 *
 *   ENUM self_assessment_state = draft,submitted,reviewed,approved
 *   reject() THREW: 22P02 invalid input value for enum
 *                   self_assessment_state: "rejected"
 *
 * B2 — latent behind B1. With the enum fixed, `_finalizeSupervisorReview` fell
 * through to the self-rating on a rejection, exactly as it does on an agreement:
 *
 *   after reject, supervisor_reviews -> {"status":"completed","decision":"reject","lvl":1,"gap":0}
 *   IDPService.generateDrafts -> {"plans":1,"gaps":1}
 *   objective: "D'ici le 30/11/2026, monter Basic Cybersecurity du niveau 1 au
 *               niveau 3, validé par le superviseur…"
 *
 * A level nobody validated, on an assessment that was thrown out, printed on a
 * document the employee signs. After the fix the same probe reads
 * {"decision":"reject","lvl":null,"gap":null} and generateDrafts -> {"plans":0,"gaps":0},
 * while the approve path is untouched (agreement 1/gap 0, override 4/gap 3).
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/EmployeeModel', () => ({ findById: jest.fn() }));

const EmployeeModel = require('../../src/models/EmployeeModel');
const svc = require('../../src/services/SelfAssessmentWorkflowService');

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };

/**
 * Drive one workflow action against a mocked database and hand back every
 * `UPDATE supervisor_reviews … SET decision` call it made, with its parameters.
 *
 * `recordedSupervisorLevel` is what a supervisor had already validated on the
 * review row before this action (null = nobody ever entered a level).
 */
async function runAction(action, { selfLevel = 1, recordedSupervisorLevel = null } = {}) {
    EmployeeModel.findById.mockResolvedValue({ id: 7, supervisorId: null, managerId: null });
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.all.mockResolvedValue([]);
    mockDb.run.mockResolvedValue({ changes: 1, rowCount: 1 });
    mockDb.get.mockImplementation(async (sql) => {
        if (/FROM self_assessments WHERE id/.test(sql))
            return {
                id: 55,
                employeeId: 7,
                skillId: 9,
                selfRatedLevel: selfLevel,
                workflowState: 'submitted',
            };
        if (/FROM supervisor_reviews sr/.test(sql))
            return { currentLevel: recordedSupervisorLevel, selfLevel };
        if (/INSERT INTO self_assessment_comments/.test(sql)) return { id: 1 };
        if (/supervisor_rated_level AS "lvl" FROM supervisor_reviews/.test(sql)) return null;
        if (/FROM admins/.test(sql)) return { id: 1 };
        return null;
    });

    await action(svc);

    return mockDb.run.mock.calls
        .filter(([sql]) => /UPDATE supervisor_reviews/.test(sql) && /SET decision/.test(sql))
        .map(([sql, params]) => {
            // `SET decision = ?, recommendation = ?, status = 'completed', decided_at = now(),
            //   supervisor_rated_level = ?, gap = ?, …`
            const [decision, , level, gap] = params;
            return { sql, decision, level, gap };
        });
}

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
    mockDb.runTransaction.mockReset();
});

describe('B1 — the enum can hold a rejection at all', () => {
    // Comments are stripped first: an earlier draft of this test matched the word
    // "IF NOT EXISTS" inside the file's own explanatory header and went green
    // while the STATEMENT had been mutated. A test that can only see prose is
    // not a test.
    const statements = fs
        .readFileSync(
            path.join(__dirname, '../../db/postgres/93_self_assessment_state_rejected.sql'),
            'utf8'
        )
        .split('\n')
        .filter((l) => !/^\s*--/.test(l))
        .join('\n');

    test("migration 93 adds 'rejected' to self_assessment_state", () => {
        expect(statements).toMatch(
            /ALTER TYPE\s+public\.self_assessment_state\s+ADD VALUE[^;]*'rejected'/i
        );
    });

    test('it is idempotent, so re-running migrations never fails', () => {
        expect(statements).toMatch(/ADD VALUE IF NOT EXISTS\s+'rejected'/i);
    });

    test('reject() still writes BOTH state machines in lockstep', async () => {
        await runAction((s) => s.reject(55, SUPER, 'no evidence'));
        const setState = mockDb.run.mock.calls.find(([q]) =>
            /UPDATE self_assessments SET workflow_state/.test(q)
        );
        expect(setState).toBeDefined();
        expect(setState[0]).toMatch(/status = \?/);
        expect(setState[1]).toEqual(expect.arrayContaining(['rejected', 'rejected']));
    });
});

describe('B2 — a rejection records no measurement it did not make', () => {
    test('rejecting leaves supervisor_rated_level and gap NULL', async () => {
        const [w] = await runAction((s) => s.reject(55, SUPER, 'no evidence'), { selfLevel: 1 });
        expect(w.decision).toBe('reject');
        expect(w.level).toBeNull();
        expect(w.gap).toBeNull();
    });

    test('rejecting never copies the self-rating into the supervisor column', async () => {
        const [w] = await runAction((s) => s.reject(55, SUPER, 'no evidence'), { selfLevel: 3 });
        expect(w.level).not.toBe(3);
        expect(w.gap).not.toBe(0);
    });

    test('a level a supervisor genuinely recorded earlier is preserved, not erased', async () => {
        const [w] = await runAction((s) => s.reject(55, SUPER, 'no evidence'), {
            selfLevel: 1,
            recordedSupervisorLevel: 4,
        });
        expect(w.level).toBe(4);
        expect(w.gap).toBe(3);
    });
});

describe('B2 — the approve path is NOT collateral damage', () => {
    test('agreement (no level entered) still resolves to the self-rating, gap 0', async () => {
        const [w] = await runAction((s) => s.approve(55, SUPER, null, null, null), {
            selfLevel: 1,
        });
        expect(w.decision).toBe('approve');
        expect(w.level).toBe(1);
        expect(w.gap).toBe(0);
    });

    test('an override still records the reviewer level and the real gap', async () => {
        const [w] = await runAction(
            (s) => s.approve(55, SUPER, { gapReason: 'evidence insufficient' }, null, 4),
            { selfLevel: 1 }
        );
        expect(w.level).toBe(4);
        expect(w.gap).toBe(3);
    });
});

describe('B2 — a refused assessment seeds no development plan', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/services/IDPService.js'), 'utf8');
    const query = src.slice(
        src.indexOf('const gaps = await db.all'),
        src.indexOf('const idpByEmp')
    );

    test('generateDrafts excludes rejected assessments by workflow state', () => {
        expect(query).toMatch(/sa\.workflow_state <> 'rejected'/);
    });

    test('and by the review decision, for rows decided outside the V2 states', () => {
        expect(query).toMatch(/sr\.decision IS DISTINCT FROM 'reject'/);
    });

    test('IS DISTINCT FROM is used so legacy NULL decisions are still selected', () => {
        expect(query).not.toMatch(/sr\.decision <> 'reject'/);
    });
});
