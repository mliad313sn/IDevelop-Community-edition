'use strict';
/**
 * The employee's side of the development loop (4.0.0 port, wave 5) — pure and
 * mocked tests, invented data only.
 *
 *   - « My progress » compares VALIDATED levels only (an unreviewed draft is
 *     pending, never a movement);
 *   - « What changed »: validated uplifts, a measured gap reaching the required
 *     level is closed (a first measurement is not), actions and trainings done;
 *     hidden (null) when the validated levels cannot be read; an unread count is
 *     null, never 0; an unknown provenance is « other »;
 *   - the development step: loop kinds map to home keys, urgent ones flagged,
 *     an off-site link never followed, open measured gaps beat « nothing waits »;
 *     every step key has its FR/EN sentence and button, with no placeholder
 *     (the persona digest prints it as is);
 *   - the adapter answers null (never []) when the module is off or the loop
 *     fails;
 *   - « new in the role »: only a recorded date within the months, 0 = off;
 *   - the sync status: no English literal, no hex, labels from the page, docked,
 *     silent when locked;
 *   - the anti-anchoring rule holds inside the phone card layout.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
}));
jest.mock('../../src/models/SelfAssessmentModel', () => ({ listRounds: jest.fn() }));
jest.mock('../../src/services/LmsService', () => ({ listForEmployee: jest.fn(async () => []) }));

const SAM = require('../../src/models/SelfAssessmentModel');
const Lms = require('../../src/services/LmsService');

describe('« My progress » on validated levels only', () => {
    const { loadMeasures } = require('../../src/controllers/EmployeeProgressController');
    const round = (o) => ({
        id: o.id,
        skillId: 7,
        skillName: 'Plan reading',
        roundNo: o.no,
        selfRatedLevel: o.self,
        supervisorRatedLevel: o.sup == null ? null : o.sup,
        workflowState: o.state,
        createdAt: '2026-06-01',
        supersededAt: null,
    });

    test('a submitted 2 then a draft 4 is not a progression', async () => {
        SAM.listRounds.mockResolvedValueOnce([
            round({ id: 1, no: 1, self: 2, state: 'submitted' }),
            round({ id: 2, no: 2, self: 4, state: 'draft' }),
        ]);
        const m = await loadMeasures(41);
        expect(m.skills).toHaveLength(1);
        expect(m.skills[0].delta).toBeNull();
        expect(m.skills[0].rounds.every((r) => r.validatedLevel === null)).toBe(true);
        expect(m.skills[0].rounds.every((r) => r.pending)).toBe(true);
    });

    test('two approved rounds: the reviewer level wins over the self level', async () => {
        SAM.listRounds.mockResolvedValueOnce([
            round({ id: 1, no: 1, self: 3, sup: 1, state: 'approved' }),
            round({ id: 2, no: 2, self: 4, state: 'draft' }),
            round({ id: 3, no: 3, self: 3, sup: 3, state: 'approved' }),
        ]);
        const m = await loadMeasures(41);
        expect(m.skills[0].delta).toBe(2); // 1 → 3, the draft 4 ignored
        expect(m.skills[0].rounds.map((r) => r.validatedLevel)).toEqual([1, null, 3]);
        expect(m.skills[0].hasPending).toBe(true);
    });
});

describe('« What changed » since the anchor', () => {
    const Loop = require('../../src/services/EmployeeLoopAdapter');
    const EH = require('../../src/services/EmployeeHomeService');
    const anchor = { since: '2026-10-01T00:00:00Z', kind: 'digest', date: '2026-10-01' };
    const gapRows = [
        { skillId: 1, skillName: 'A', required: 3 },
        { skillId: 2, skillName: 'B', required: 2 },
        { skillId: 3, skillName: 'C', required: 4 },
    ];

    test('a measured gap reaching the required level is closed; a first measurement is not', async () => {
        jest.spyOn(Loop, 'validatedUpliftsSince').mockResolvedValueOnce([
            { skillId: 1, skillName: 'A', from: 1, to: 3, at: '2026-10-05', source: 'training' },
            { skillId: 2, skillName: 'B', from: null, to: 2, at: '2026-10-06', source: 'review' },
            { skillId: 3, skillName: 'C', from: 1, to: 2, at: '2026-10-07', source: 'observation' },
        ]);
        jest.spyOn(Loop, 'actionsDoneSince').mockResolvedValueOnce([{ id: 9 }, { id: 10 }]);
        Lms.listForEmployee.mockResolvedValueOnce([
            { status: 'completed', completedAt: '2026-10-03T10:00:00Z' },
            { status: 'completed', completedAt: '2026-09-03T10:00:00Z' },
            { status: 'in_progress', completedAt: null },
        ]);
        const c = await EH.changesSince(41, anchor, gapRows);
        expect(c.gapsClosed).toBe(1);
        expect(c.upliftsTotal).toBe(3);
        expect(c.actionsDone).toBe(2);
        expect(c.trainingsDone).toBe(1);
        expect(c.uplifts[0]).toMatchObject({ skillName: 'A', from: 1, to: 3, source: 'training' });
        expect(c.uplifts[1].from).toBeNull(); // a first level, never « from 0 »
    });

    test('the validated levels unreadable ⇒ null (block hidden, never « nothing new »)', async () => {
        jest.spyOn(Loop, 'validatedUpliftsSince').mockResolvedValueOnce(null);
        expect(await EH.changesSince(41, anchor, gapRows)).toBeNull();
        expect(await EH.changesSince(41, {}, gapRows)).toBeNull();
    });

    test('an unknown provenance is « other »; an unread count is null, never 0', async () => {
        jest.spyOn(Loop, 'validatedUpliftsSince').mockResolvedValueOnce([
            { skillId: 1, skillName: 'A', from: 1, to: 2, source: 'rumour' },
        ]);
        jest.spyOn(Loop, 'actionsDoneSince').mockResolvedValueOnce(null);
        Lms.listForEmployee.mockRejectedValueOnce(new Error('down'));
        const c = await EH.changesSince(41, anchor, gapRows);
        expect(c.uplifts[0].source).toBe('other');
        expect(c.actionsDone).toBeNull();
        expect(c.trainingsDone).toBeNull();
    });

    test('the uplift provenance is read from the history row, never guessed', () => {
        const { _upliftSourceOf: src } = require('../../src/services/DevelopmentLoopService');
        expect(src('manual', 'Set from a supervisor-validated training completion')).toBe(
            'training'
        );
        expect(src('action_uplift', 'auto: coaching observed level')).toBe('coaching');
        expect(src('action_uplift', 'auto: action close uplift')).toBe('observation');
        expect(src('supervisor_review', 'supervisor review')).toBe('review');
        expect(src('import', 'csv import')).toBe('other');
    });
});

describe('the development step', () => {
    const { devStepOf, STEPS, _safeHref } = require('../../src/services/EmployeeHomeService');

    test('loop kinds map to home keys, urgent ones flagged', () => {
        expect(
            devStepOf({
                kind: 'action_due',
                href: '/v2/idp/4#action-9',
                vars: { title: 'Shadowing', dueOn: '2026-10-20' },
            })
        ).toEqual({
            key: 'dev_action_due',
            href: '/v2/idp/4#action-9',
            extra: { title: 'Shadowing', date: '2026-10-20' },
            urgent: true,
        });
        expect(
            devStepOf({
                kind: 'training',
                href: '/employee/my-learning',
                vars: { title: 'Course' },
            }).urgent
        ).toBe(true);
        expect(
            devStepOf({
                kind: 'gap_no_plan',
                href: '/v2/idp/propose?skillId=5',
                vars: { skill: 'X' },
            })
        ).toMatchObject({
            key: 'dev_gap_no_plan',
            href: '/v2/idp/propose?skillId=5',
            extra: { title: 'X' },
            urgent: false,
        });
        expect(devStepOf({ kind: 'validate_wait', href: '/v2/idp/4#action-2' })).toMatchObject({
            key: 'dev_validate_wait',
            urgent: false,
        });
    });

    test('an off-site or crafted link is never followed', () => {
        for (const bad of [
            '//evil.example/x',
            'https://evil.example',
            '/v2/idp/4"onclick=x',
            'javascript:x',
            '/\\evil',
        ])
            expect(devStepOf({ kind: 'action_due', href: bad }).href).toBe(STEPS.dev_action_due);
        expect(_safeHref('/v2/idp/propose?skillId=5')).toBe('/v2/idp/propose?skillId=5');
        expect(_safeHref('/v2/idp/propose?skillId=5&x=1')).toBeNull();
    });

    test('without a loop step, open measured gaps beat « nothing waits for you »', () => {
        expect(devStepOf(null, 8)).toMatchObject({
            key: 'dev_gaps_open',
            href: '/employee/my-progress',
            extra: { count: 8 },
        });
        expect(devStepOf(null, 0)).toBeNull();
        expect(devStepOf({ kind: 'none' }, 0)).toBeNull();
    });

    test('every step key has a FR and EN sentence and button, with no placeholder', () => {
        for (const lang of ['fr', 'en']) {
            const t = JSON.parse(read(`locales/${lang}/employee.json`));
            for (const k of Object.keys(STEPS)) {
                expect([lang, k, typeof t['next_' + k]]).toEqual([lang, k, 'string']);
                expect([lang, k, typeof t['next_' + k + '_cta']]).toEqual([lang, k, 'string']);
                expect(t['next_' + k]).not.toMatch(/\{\{/); // the digest prints it raw
            }
        }
    });
});

describe('the adapter: null, never an empty answer, when it cannot know', () => {
    const Loop = require('../../src/services/EmployeeLoopAdapter');
    const ModuleService = require('../../src/services/ModuleService');
    const Dev = require('../../src/services/DevelopmentLoopService');

    test('the development module off: no actions done, no development step', async () => {
        jest.spyOn(ModuleService, 'isOn').mockResolvedValue(false);
        expect(await Loop.actionsDoneSince(41, '2026-10-01')).toBeNull();
        expect(await Loop.nextDevelopmentStep(41)).toBeNull();
    });

    test('the loop failing: null; « none »: null; a step: passed through', async () => {
        jest.spyOn(ModuleService, 'isOn').mockResolvedValue(true);
        jest.spyOn(Dev, 'validatedUpliftsSince').mockRejectedValueOnce(new Error('x'));
        expect(await Loop.validatedUpliftsSince(41, '2026-10-01')).toBeNull();
        jest.spyOn(Dev, 'nextDevelopmentStep').mockResolvedValueOnce({ kind: 'none' });
        expect(await Loop.nextDevelopmentStep(41)).toBeNull();
        jest.spyOn(Dev, 'nextDevelopmentStep').mockResolvedValueOnce({
            kind: 'training',
            href: '/employee/my-learning',
        });
        expect(await Loop.nextDevelopmentStep(41)).toMatchObject({ kind: 'training' });
        jest.spyOn(Dev, 'actionStates').mockResolvedValueOnce({ available: false });
        expect(await Loop.actionStates(41)).toEqual({
            available: false,
            open: [],
            awaitingValidation: null,
            overdue: null,
        });
    });
});

describe('« new in the role »', () => {
    const { isNewInRole, newInRoleIds, DEFAULT_MONTHS } = require('../../src/utils/newInRole');
    const today = new Date('2026-10-17T09:00:00Z');

    test('only a recorded date within the months counts; 0 months is off', () => {
        expect(DEFAULT_MONTHS).toBe(6);
        expect(isNewInRole('2026-09-01', 6, today)).toBe(true);
        expect(isNewInRole('2026-04-18', 6, today)).toBe(true);
        expect(isNewInRole('2026-04-17', 6, today)).toBe(false); // exactly 6 months: no longer new
        expect(isNewInRole('2025-01-01', 6, today)).toBe(false);
        expect(isNewInRole('2026-10-18', 6, today)).toBe(false); // a future start is not "new"
        expect(isNewInRole(null, 6, today)).toBe(false); // no date, no flag
        expect(isNewInRole('not a date', 6, today)).toBe(false);
        expect(isNewInRole('2026-09-01', 0, today)).toBe(false);
        expect(isNewInRole(new Date(2026, 8, 1), 6, today)).toBe(true); // a pg DATE
    });

    test('the batched lookup reads one query and keeps only the new ones', async () => {
        const db = require('../../src/config/database');
        db.all.mockResolvedValueOnce([
            { id: 1, start: '2026-09-01' },
            { id: 2, start: '2024-01-01' },
        ]);
        const ids = await newInRoleIds([1, 2, 3, 'x', -4], { months: 6, today });
        expect([...ids]).toEqual([1]);
        expect(db.all).toHaveBeenLastCalledWith(
            expect.stringContaining('role_start_date IS NOT NULL'),
            [[1, 2, 3]]
        );
        expect((await newInRoleIds([1], { months: 0, today })).size).toBe(0);
    });
});

describe('the sync status of the self-assessment page', () => {
    const js = read('public/js/sync-indicator.js');
    test('no English literal and no hex colour in the script', () => {
        expect(js).not.toMatch(
            /'✓ synced'|offline — |NOT saved — retry|`↻ syncing|setLabel\('online'/
        );
        expect(js).not.toMatch(/#[0-9a-fA-F]{6}\b/);
        expect(js).not.toMatch(/cssText/);
    });
    test('labels come from the page, docked in the bar, silent when locked', () => {
        expect(js).toMatch(/getElementById\('syncI18n'\)/);
        expect(js).toMatch(/getElementById\('saSyncSlot'\)/);
        expect(js).toMatch(/if \(T\.locked\) return;/);
        const view = read('views/pages/employee/self-assessment.ejs');
        expect(view).toMatch(/<script type="application\/json" id="syncI18n">/);
        expect(view).toMatch(/<span class="sa-sync-slot" id="saSyncSlot"><\/span>/);
    });
});

describe('the last validated level stays hidden on phones', () => {
    test('the phone card rule cannot re-show the current-level cell', () => {
        const css = read('public/css/self-assessment.css');
        const phone = css.slice(css.indexOf('@media (max-width: 780px)'));
        expect(phone).toMatch(
            /\.sa-section\[open\] \.sa-table td\.sa-col-current \{\s*display: none;/
        );
        expect(phone).toMatch(
            /body\.sa-show-current \.sa-section\[open\] \.sa-table td\.sa-col-current \{\s*display: block;/
        );
        expect(phone).not.toMatch(/\n {4}body\.sa-show-current \.sa-col-current \{/);
        // tokens only in the new rules
        expect(css.slice(css.indexOf('Rating on a phone'))).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    });
});
