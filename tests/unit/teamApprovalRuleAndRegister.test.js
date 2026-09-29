'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * HR / employee-representative committee lot — the parts that need no database:
 *
 *   R1  the "agreed rating" rule behind "approve all agreed ratings for my team"
 *   R2  the roster helpers (chip, critical-gap count, next action) keep
 *       "not measured" apart from zero
 *   R3  the data categories of the register and of "what is recorded about me"
 *       are EXACTLY DSRService.export's keys; confidential ones carry no count
 *   R4  FR/EN key parity of the catalogues touched, and every key the new views
 *       use exists in both languages
 *   R5  route guards and the menu link
 */

const mockDb = {
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const WF = require('../../src/services/SelfAssessmentWorkflowService');
const Roster = require('../../src/services/TeamRosterService');
const Register = require('../../src/services/ComplianceRegisterService');
const DSR = require('../../src/services/DSRService');

describe('R1 — the agreed-rating rule', () => {
    const base = {
        workflowState: 'submitted',
        selfRatedLevel: 3,
        requiredLevel: 2,
        validatedLevel: null,
        supervisorRatedLevel: null,
        hasOpenChangeRequest: false,
    };
    const rule = (over) => WF.isAgreedRating({ ...base, ...over });

    test('self-rating at or above the requirement is agreed', () => {
        expect(rule({})).toEqual({ ok: true, reason: 'meets_requirement' });
        expect(rule({ selfRatedLevel: 2 }).ok).toBe(true);
    });
    test('below the requirement stays in the queue', () => {
        expect(rule({ selfRatedLevel: 1 })).toEqual({ ok: false, reason: 'below_requirement' });
    });
    test('equal to what the manager would keep is agreed even below the requirement', () => {
        expect(rule({ selfRatedLevel: 1, validatedLevel: 1 })).toEqual({
            ok: true,
            reason: 'matches_validated',
        });
        expect(rule({ selfRatedLevel: 1, supervisorRatedLevel: 1 })).toEqual({
            ok: true,
            reason: 'reviewer_agrees',
        });
        expect(rule({ requiredLevel: null, selfRatedLevel: 2, validatedLevel: 2 }).ok).toBe(true);
    });
    test('a modified rating is never swept', () => {
        expect(rule({ supervisorRatedLevel: 2 })).toEqual({ ok: false, reason: 'modified' });
        expect(rule({ hasOpenChangeRequest: true })).toEqual({
            ok: false,
            reason: 'change_request',
        });
        expect(rule({ hasOpenChangeRequest: 't' }).ok).toBe(false);
    });
    test('no rating, no requirement, or a state outside the reviewer queue', () => {
        expect(rule({ selfRatedLevel: null }).reason).toBe('no_rating');
        expect(rule({ requiredLevel: null }).reason).toBe('no_requirement');
        for (const s of ['arbitration', 'draft', 'changes_requested', 'approved', 'rejected'])
            expect(rule({ workflowState: s })).toEqual({ ok: false, reason: 'state' });
        for (const s of ['under_review', 'reviewed'])
            expect(rule({ workflowState: s }).ok).toBe(true);
    });
});

describe('R1b — the team sweep goes through the per-employee path only', () => {
    test('every person is re-authorised; a refusal skips them and approves nothing', async () => {
        const spyQueue = jest.spyOn(WF, 'reviewQueue').mockResolvedValue([
            { employeeId: 10, workflowState: 'submitted' },
            { employeeId: 10, workflowState: 'under_review' },
            { employeeId: 11, workflowState: 'submitted' },
            { employeeId: 12, workflowState: 'arbitration' }, // never swept
            { employeeId: 5, workflowState: 'submitted' }, // the reviewer themselves
        ]);
        const spyBulk = jest
            .spyOn(WF, 'bulkApproveForEmployee')
            .mockImplementation(async (id, user, req, opts) => {
                expect(opts).toEqual({ agreedOnly: true });
                if (id === 11) throw new Error('Not authorized');
                return { employeeId: id, approved: 2, total: 2, failed: [], held: [{ id: 1 }] };
            });
        const res = await WF.bulkApproveAgreedForTeam({ id: 5, userType: 'manager' }, null);
        expect(spyBulk.mock.calls.map((c) => c[0])).toEqual([10, 11]);
        expect(res).toMatchObject({
            employees: 2,
            approved: 2,
            held: 1,
            failed: 0,
            skippedEmployees: 1,
        });
        spyQueue.mockRestore();
        spyBulk.mockRestore();
    });
});

describe('R2 — roster helpers', () => {
    test('assessment chip, most urgent first', () => {
        expect(Roster.assessmentChip({})).toBe('not_started');
        expect(Roster.assessmentChip(undefined)).toBe('not_started');
        expect(Roster.assessmentChip({ draft: 2, approved: 1 })).toBe('in_progress');
        expect(Roster.assessmentChip({ changes_requested: 1, draft: 1 })).toBe('changes_requested');
        expect(Roster.assessmentChip({ submitted: 1, changes_requested: 1 })).toBe('to_review');
        expect(Roster.assessmentChip({ arbitration: 1 })).toBe('to_review');
        expect(Roster.assessmentChip({ approved: 3, rejected: 1 })).toBe('completed');
    });
    test('critical gaps count only measured requirements (or a lapsed certificate)', () => {
        expect(Roster.criticalGapCount(null)).toBe(0);
        expect(
            Roster.criticalGapCount({
                gaps: [
                    { isCritical: true, isAssessed: true },
                    { isCritical: true, isAssessed: false }, // unmeasured, not a gap
                    { isCritical: true, isAssessed: false, certLapsed: true },
                    { isCritical: false, isAssessed: true },
                ],
            })
        ).toBe(2);
    });
    test('one next action per row', () => {
        expect(Roster.nextAction({ state: 'to_review', criticalGaps: 3 }).key).toBe('review');
        expect(Roster.nextAction({ state: 'completed', criticalGaps: 1 }).key).toBe('coaching');
        expect(Roster.nextAction({ state: 'not_started', criticalGaps: 0 }).key).toBe('remind');
        expect(
            Roster.nextAction({ state: 'completed', criticalGaps: 0, readinessPercent: null }).key
        ).toBe('gaps');
        expect(
            Roster.nextAction({
                state: 'completed',
                criticalGaps: 0,
                readinessPercent: 90,
                employeeId: 42,
            })
        ).toEqual({ key: 'profile', href: '/employees/42' });
    });
});

describe('R3 — data categories are the DSR export', () => {
    test('the catalogue covers exactly the export keys', async () => {
        mockDb.get.mockResolvedValue({ id: 1 });
        mockDb.all.mockResolvedValue([]);
        const out = await DSR.export(1);
        const exported = Object.keys(out)
            .filter((k) => !Register.EXPORT_META_KEYS.includes(k))
            .sort();
        const listed = Register.DATA_CATEGORIES.map((c) => c.key).sort();
        expect(listed).toEqual(exported);
    });

    test('forEmployee counts from the export and withholds confidential counts', async () => {
        const spy = jest.spyOn(DSR, 'export').mockResolvedValue({
            employeeId: 7,
            generatedAt: 'x',
            profile: { id: 7 },
            skillAssessments: [{}, {}, {}],
            goals: { error: 'relation missing' },
            nineBox: [{}, {}],
            retentionRisk: [{}],
        });
        mockDb.get.mockResolvedValue({ code: 'SN', name: 'Sénégal', dsrSlaDays: 30 });
        const mine = await Register.forEmployee(7);
        const by = Object.fromEntries(mine.categories.map((c) => [c.key, c]));
        expect(spy).toHaveBeenCalledWith(7);
        expect(by.profile.count).toBe(1);
        expect(by.skillAssessments.count).toBe(3);
        expect(by.goals.count).toBeNull(); // unreadable = not measured, never 0
        expect(by.pips.count).toBe(0);
        for (const k of ['nineBox', 'retentionRisk', 'calibrationAdjustments']) {
            expect(by[k].withheld).toBe(true);
            expect(by[k].count).toBeNull();
        }
        expect(mine.retentionDays).toBe(30);
        spy.mockRestore();
    });
});

describe('R4 — catalogues', () => {
    for (const ns of ['compliance', 'talentx']) {
        test(`${ns}.json has the same keys in FR and EN`, () => {
            const fr = Object.keys(json(`locales/fr/${ns}.json`)).sort();
            const en = Object.keys(json(`locales/en/${ns}.json`)).sort();
            expect(fr).toEqual(en);
        });
    }

    test('every key the new surfaces use exists, including the generated ones', () => {
        const cat = {
            fr: { ...json('locales/fr/compliance.json') },
            en: { ...json('locales/en/compliance.json') },
        };
        const tx = { fr: json('locales/fr/talentx.json'), en: json('locales/en/talentx.json') };
        const need = { compliance: new Set(), talentx: new Set() };
        const views = [
            'views/pages/compliance/register.ejs',
            'views/pages/employee/my-data.ejs',
            'views/pages/supervisor/dashboard.ejs',
            'views/pages/supervisor/self-assessment-review.ejs',
            'views/partials/sidebar.ejs',
        ];
        for (const v of views) {
            for (const m of read(v).matchAll(/__\('(compliance|talentx):([a-z0-9_]+)'\s*[,)]/gi)) {
                need[m[1]].add(m[2]);
            }
        }
        for (const c of Register.DATA_CATEGORIES) {
            need.compliance.add(`cat_${c.key}`);
            need.compliance.add(`catgrp_${c.group}`);
            need.compliance.add(`reg_aud_${c.audience}`);
        }
        for (const m of ['core', 'v2', 'local_content']) need.compliance.add(`reg_mod_${m}`);
        for (const s of [
            'to_review',
            'changes_requested',
            'in_progress',
            'completed',
            'not_started',
        ])
            need.talentx.add(`team_st_${s}`);
        for (const k of ['review', 'coaching', 'remind', 'gaps', 'profile'])
            need.talentx.add(`team_next_${k}`);
        const missing = [];
        for (const lang of ['fr', 'en']) {
            for (const k of need.compliance)
                if (!(k in cat[lang])) missing.push(`${lang}:compliance:${k}`);
            for (const k of need.talentx)
                if (!(k in tx[lang])) missing.push(`${lang}:talentx:${k}`);
        }
        expect(missing).toEqual([]);
        expect(need.compliance.size).toBeGreaterThan(50);
    });

    test('the new views set no inline uppercase', () => {
        for (const v of [
            'views/pages/compliance/register.ejs',
            'views/pages/employee/my-data.ejs',
            'views/pages/supervisor/dashboard.ejs',
        ]) {
            expect(read(v)).not.toMatch(/text-transform\s*:\s*uppercase/i);
        }
    });
});

describe('R5 — guards and menu', () => {
    const routes = read('src/routes/index.js');
    test('the register is SuperAdmin-only', () => {
        expect(routes).toMatch(/router\.get\('\/compliance\/register',\s*requireSuperAdminPage,/);
    });
    test('"what is recorded about me" is the signed-in person only', () => {
        expect(routes).toMatch(/router\.get\('\/employee\/my-data',\s*requireEmployeeOrManager,/);
        const ctl = read('src/controllers/ComplianceController.js');
        const body = ctl.slice(ctl.indexOf('async myData('), ctl.indexOf('_wantsJson(req) {'));
        expect(body).toMatch(/forEmployee\(\s*req\.user\.id\s*\)/);
        expect(body).not.toMatch(/req\.(params|query|body)/);
    });
    test('team approve-all carries the same guard as the per-employee one', () => {
        expect(routes).toMatch(
            /'\/api\/self-assessment\/team\/approve-all',\s*requireManagerOrAnyPermission\('approve_assessments'\),/
        );
    });
    test('the employee menu links the page', () => {
        expect(read('views/partials/sidebar.ejs')).toMatch(/href="\/employee\/my-data"/);
    });
    test('the register is printable', () => {
        const v = read('views/pages/compliance/register.ejs');
        expect(v).toMatch(/@media print/);
        expect(v).toMatch(/window\.print\(\)/);
    });
});
