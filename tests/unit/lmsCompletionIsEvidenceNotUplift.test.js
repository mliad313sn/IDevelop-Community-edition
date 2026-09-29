'use strict';
/**
 * CODE-REVIEW-2026-09-17 [BLOQUANT/correctness] — RULEBOOK §10:
 * « Une formation terminée est une preuve, pas une élévation automatique du
 * niveau officiel. »
 *
 * LmsService._applyToSkills wrote `skill_assessments.current_level =
 * level_delta` on every ingested completion, attributed to the system 'admin'
 * account, note "LMS completion: auto skill uplift". Measured on a rolled-back
 * probe: employee 138 / skill 331 went 1 → 3, official readiness 55.9 % →
 * 61.8 %, one more skill counted as "met", succession benches recomputed on the
 * new value — with no human involved and nobody's name against it.
 *
 * Its one guard read the LAST row of assessment_history and skipped when that
 * row was a supervisor decision. A later 'manual' row hid the supervisor's, so
 * employee 152 / skill 300 went 2 → 4 straight through a review that existed.
 * A guard a subsequent write can hide is not a guard.
 *
 * Now: ingestion PROPOSES. The completion parks at
 * `review_reason = 'awaiting_supervisor'`, the people who govern the employee
 * are notified, and `decideUplift` is the only path that reaches
 * skill_assessments.
 *
 * Verified end-to-end on the dev database in a rolled-back transaction
 * (scratchpad/probe-lms-uplift.js, 14/14): ingestion leaves the level at 1 and
 * parks the row; accepting as a named superadmin moves it to 3, attributed to
 * THAT admin with the note "Set from a supervisor-validated training
 * completion". Mutation — reinstating the auto-apply — reddens exactly the
 * three assertions that say the level must not move.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    withActor: jest.fn(async (_w, fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(undefined),
}));

const LmsService = require('../../src/services/LmsService');
const NotificationService = require('../../src/services/NotificationService');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

const EMP = 138;
const SKILL = 331;
const COURSE = 9;
const COMPLETION = 500;

const ranSql = () => mockDb.run.mock.calls.map((c) => String(c[0]));
const wrote = (re) => ranSql().filter((s) => re.test(s));

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.withActor.mockImplementation(async (_w, fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
    // course maps the skill at level 3; the employee sits at 1
    mockDb.all.mockImplementation(async (sql) =>
        /FROM course_skill_map/.test(sql)
            ? [{ skillId: SKILL, levelDelta: 3, skillName: 'Probe skill' }]
            : []
    );
    mockDb.get.mockImplementation(async (sql) => {
        if (/FROM skill_assessments/.test(sql)) return { currentLevel: 1 };
        if (/FROM lms_completions/.test(sql)) {
            return {
                id: COMPLETION,
                employeeId: EMP,
                courseId: COURSE,
                applied: false,
                reviewReason: 'awaiting_supervisor',
            };
        }
        if (/supervisor_id/.test(sql)) return { sid: 77, mid: null };
        if (/FROM admins/.test(sql)) return { id: 1 };
        return null;
    });
});

describe('an ingested completion never moves the official level', () => {
    test('nothing is written to skill_assessments', async () => {
        await LmsService._proposeSkillUplifts(COMPLETION, EMP, COURSE);
        expect(wrote(/INSERT INTO skill_assessments/)).toHaveLength(0);
        expect(wrote(/UPDATE skill_assessments/)).toHaveLength(0);
    });

    test('the completion is parked awaiting a named decision', async () => {
        const out = await LmsService._proposeSkillUplifts(COMPLETION, EMP, COURSE);
        expect(out.applied).toBe(false);
        expect(out.reason).toBe('awaiting_supervisor');
        const parked = mockDb.run.mock.calls.find((c) =>
            /UPDATE lms_completions SET applied = false, review_reason = 'awaiting_supervisor'/.test(
                String(c[0])
            )
        );
        expect(parked).toBeDefined();
    });

    test('it reports the proposal, and does NOT claim to have raised anything', async () => {
        const out = await LmsService._proposeSkillUplifts(COMPLETION, EMP, COURSE);
        expect(out.proposedSkills).toEqual([{ skillId: SKILL, from: 1, to: 3 }]);
        // A caller reading raisedSkills must never be told a level moved.
        expect(out.raisedSkills).toEqual([]);
    });

    test('the people who may decide are told', async () => {
        await LmsService._proposeSkillUplifts(COMPLETION, EMP, COURSE);
        expect(NotificationService.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'lms.uplift_proposed',
                userType: 'employee',
                userId: 77,
            })
        );
    });

    test('a level already met proposes nothing and notifies nobody', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM skill_assessments/.test(sql) ? { currentLevel: 4 } : null
        );
        const out = await LmsService._proposeSkillUplifts(COMPLETION, EMP, COURSE);
        expect(out.reason).toBe('already_met');
        expect(out.proposedSkills).toEqual([]);
        expect(NotificationService.notify).not.toHaveBeenCalled();
    });

    test('an out-of-range mapped level is ignored, never written', async () => {
        mockDb.all.mockImplementation(async (sql) =>
            /FROM course_skill_map/.test(sql) ? [{ skillId: SKILL, levelDelta: 9 }] : []
        );
        const out = await LmsService._proposeSkillUplifts(COMPLETION, EMP, COURSE);
        expect(out.reason).toBe('already_met'); // nothing proposable
        expect(wrote(/INSERT INTO skill_assessments/)).toHaveLength(0);
    });
});

describe('the decision is the only door to the official level', () => {
    const superadmin = { id: 4, userType: 'admin', role: 'superadmin' };

    test('accepting writes the level, attributed to the DECIDER', async () => {
        const out = await LmsService.decideUplift(superadmin, COMPLETION, 'accept');
        const write = mockDb.run.mock.calls.find((c) =>
            /INSERT INTO skill_assessments/.test(String(c[0]))
        );
        expect(write).toBeDefined();
        // [employeeId, skillId, level, assessedBy]
        expect(write[1]).toEqual([EMP, SKILL, 3, superadmin.id]);
        // …and never the system admin the old code used.
        expect(write[1][3]).not.toBe(1);
        expect(String(write[0])).toMatch(/supervisor-validated training completion/);
        expect(out.raisedSkills).toHaveLength(1);
    });

    test('the real actor travels with the write, for the history trigger', async () => {
        await LmsService.decideUplift(superadmin, COMPLETION, 'accept');
        expect(mockDb.withActor).toHaveBeenCalled();
        expect(mockDb.withActor.mock.calls[0][0]).toBe(superadmin);
    });

    test('declining writes no level and says why', async () => {
        const out = await LmsService.decideUplift(superadmin, COMPLETION, 'decline');
        expect(wrote(/INSERT INTO skill_assessments/)).toHaveLength(0);
        expect(out.decision).toBe('decline');
        expect(
            wrote(
                /UPDATE lms_completions SET applied = false, review_reason = 'declined_by_supervisor'/
            )
        ).toHaveLength(1);
    });

    test('someone with no authority over the employee is refused', async () => {
        const stranger = { id: 900, userType: 'employee' };
        jest.spyOn(LmsService, '_mayDecide').mockResolvedValue(false);
        await expect(LmsService.decideUplift(stranger, COMPLETION, 'accept')).rejects.toMatchObject(
            {
                status: 403,
            }
        );
        expect(wrote(/INSERT INTO skill_assessments/)).toHaveLength(0);
        LmsService._mayDecide.mockRestore();
    });

    test('a completion that is not awaiting a decision is refused, not re-applied', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM lms_completions/.test(sql)
                ? {
                      id: COMPLETION,
                      employeeId: EMP,
                      courseId: COURSE,
                      applied: true,
                      reviewReason: null,
                  }
                : null
        );
        await expect(
            LmsService.decideUplift(superadmin, COMPLETION, 'accept')
        ).rejects.toMatchObject({
            status: 409,
        });
        expect(wrote(/INSERT INTO skill_assessments/)).toHaveLength(0);
    });

    test('an unknown decision verb is refused before anything is read', async () => {
        await expect(
            LmsService.decideUplift(superadmin, COMPLETION, 'maybe')
        ).rejects.toMatchObject({
            status: 400,
        });
    });
});

describe('the surfaces exist and say what the rule is', () => {
    const routes = read('src/routes/v2-lms.js');

    test('the three routes are mounted behind authentication', () => {
        expect(routes).toMatch(/router\.get\(\s*'\/uplifts',\s*requireAuth/);
        expect(routes).toMatch(/router\.post\(\s*'\/uplifts\/:id\/accept',\s*requireAuth/);
        expect(routes).toMatch(/router\.post\(\s*'\/uplifts\/:id\/decline',\s*requireAuth/);
    });

    test('the notification deep-links to a PAGE, not to raw JSON', () => {
        const svc = read('src/services/NotificationService.js');
        expect(svc).toMatch(
            /'lms\.uplift_proposed':\s*\{[\s\S]{0,200}?link:\s*'\/v2\/lms\/uplifts'/
        );
        expect(routes).toMatch(/if \(wantsJson\(req\)\) return res\.json/);
        expect(routes).toMatch(/res\.render\(\s*'pages\/lms\/uplifts'/);
    });

    test('the page states the rule, in both languages, and handles the empty case', () => {
        const view = read('views/pages/lms/uplifts.ejs');
        expect(view).toMatch(/lms:upl_intro/);
        expect(view).toMatch(/lms:upl_none/);
        for (const lang of ['fr', 'en']) {
            const lms = JSON.parse(read(`locales/${lang}/lms.json`));
            for (const k of ['upl_title', 'upl_intro', 'upl_none', 'upl_accept', 'upl_decline']) {
                expect(typeof lms[k]).toBe('string');
                expect(lms[k].length).toBeGreaterThan(0);
            }
        }
        const fr = JSON.parse(read('locales/fr/lms.json'));
        const en = JSON.parse(read('locales/en/lms.json'));
        expect(fr.upl_intro).not.toBe(en.upl_intro);
    });

    test('the page uses the house dialog, never a native confirm', () => {
        const view = read('views/pages/lms/uplifts.ejs');
        expect(view).not.toMatch(/window\.confirm\(/);
        expect(view).toMatch(/window\.confirmDialog/);
    });
});
