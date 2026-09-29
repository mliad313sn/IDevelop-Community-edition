'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * UAT3 M-08 / A-02 — THE ARCHIVED HALF of the swapped anchor.
 *
 * The producer was corrected (a queue is aged on `observedAt`, R10), and the
 * unit tests of that half live in `lotA-dept-brief-uat3.test.js`. This file pins
 * what the correction could NOT reach and what the second reading found still
 * standing on the running server:
 *
 *   measured on :3218 before this fix, session uat.admin, idevelop —
 *   GET /reports/dept-brief/325 → 200, « Le plus ancien : -13 jours » ×1;
 *   the same sentence on 329, 334, 344, 348, 349 and 351 (7 payloads out of the
 *   45 archived, exactly the 7 the board names), each carrying
 *   `A1.oldestAge = {value:-13, state:"measured"}`.
 *
 * Two rules are pinned here, and they are not the same rule:
 *
 *  1. AT RENDER TIME — a negative queue age is arithmetically impossible (the
 *     oldest item of a queue cannot post-date the instant the queue was looked
 *     at), so it is VOIDED and EXPLAINED instead of being published. No
 *     replacement figure is invented: the frozen number is a floor, the original
 *     instant is only known to within a day, and an opposable document does not
 *     print an estimate as a measurement. Nothing is written back.
 *  2. AT PRODUCTION TIME — the age arithmetic itself can no longer mint a
 *     negative value. `observedAt` is captured once, the queue queries carry no
 *     upper bound on the event date, so an item landing during the run (or a row
 *     dated in the future by an import) floored to −1 and archived « -1 jour »
 *     on a payload nothing can recompute afterwards.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

// ---------------------------------------------------------------------------
// Mocks — `mock`-prefixed so jest.mock's factory may close over them.
// ---------------------------------------------------------------------------

const mockDb = {
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
    inTransaction: jest.fn(() => false),
};
jest.mock('../../src/config/database', () => mockDb);

const mockRbac = {
    scopeFilter: jest.fn(async () => ({ clause: '', params: [] })),
    getPermissions: jest.fn(async () => []),
    isSuperAdmin: jest.fn(() => false),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const mockCoverage = { status: jest.fn(async () => []) };
jest.mock('../../src/services/CoverageService', () => mockCoverage);
const mockKeyPerson = { sweep: jest.fn(async () => null) };
jest.mock('../../src/services/KeyPersonRiskService', () => mockKeyPerson);

const S = require('../../src/services/DeptBriefService');
const { windowFor } = require('../../src/utils/periodWindow');

const JOB_SRC = fs.readFileSync(path.join(ROOT, 'src/jobs/dept-brief.js'), 'utf8');
const SHOW_EJS = fs.readFileSync(
    path.join(ROOT, 'views/pages/reports/dept-brief-show.ejs'),
    'utf8'
);
const CTRL_SRC = fs.readFileSync(path.join(ROOT, 'src/controllers/DeptBriefController.js'), 'utf8');

const WIN = windowFor('monthly', new Date('2026-09-14T08:19:00Z')); // period 2026-08
const GRID = [
    {
        departmentId: 11,
        siteId: 1,
        siteName: 'Riverside',
        departmentName: 'IT',
        unitName: 'Riverside / IT',
        headcount: 15,
        totalHeadcount: 36,
        wholeDepartment: false,
        withRequirements: 15,
        withoutRequirements: 0,
    },
];
const SETTINGS = { reviewSlaDays: 5, disputeSla: { L0: 5, L1: 7, L2: 7 }, maxLines: 7 };

function scopeStub() {
    return {
        type: 'employee',
        id: 136,
        role: null,
        ids: [1, 2, 3],
        unrestricted: false,
        size: 3,
        principal: null,
        filter: () => ({ clause: ' AND e.id = ANY(?)', params: [[1, 2, 3]] }),
    };
}

/** The A1 line of brief 351, exactly as `dept_briefs.payload` holds it. */
function archivedBrief(ageValue = -13) {
    return {
        version: 1,
        cadence: 'monthly',
        period: '2026-08',
        horizonDays: 30,
        periodStart: '2026-08-01T00:00:00.000Z',
        periodEnd: '2026-09-01T00:00:00.000Z',
        computedAt: '2026-09-14T08:19:12.774Z',
        units: [],
        footer: { units: [] },
        blocks: {
            A: [
                {
                    id: 'A1',
                    title: { fr: 'Auto-évaluations à valider', en: 'Self-assessments to review' },
                    source: 'self_assessments',
                    lines: [
                        {
                            unitId: 11,
                            label: { fr: 'Riverside / IT', en: 'Riverside / IT' },
                            count: {
                                state: 'measured',
                                unit: 'count',
                                kind: 'queue',
                                value: 1,
                                text: { fr: '1', en: '1' },
                                color: null,
                                hint: null,
                            },
                            oldestAge: {
                                state: 'measured',
                                unit: 'days',
                                kind: 'queue',
                                value: ageValue,
                                text: { fr: `${ageValue} jour`, en: `${ageValue} day` },
                                color: null,
                                hint: null,
                            },
                            overdue: false,
                        },
                    ],
                },
            ],
            B: [],
            C: [],
        },
    };
}

beforeEach(() => {
    mockDb.all.mockReset();
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockReset();
    mockDb.get.mockResolvedValue(undefined);
});

// ===========================================================================
describe('M-08 — the IMPOSSIBLE age of an already-archived brief is voided at render time', () => {
    const lineOf = (p) => p.blocks.A[0].lines[0];

    test('« -13 jour » / « -13 day » is never published again, in either language', () => {
        const p = S.repairFrozenPayload(archivedBrief(-13));
        const age = lineOf(p).oldestAge;
        expect(age.state).toBe(S.STATES.UNMEASURED);
        expect(age.value).toBeNull();
        expect(age.text.fr).toBe('non restituable');
        expect(age.text.en).toBe('not restorable');
        expect(age.text.fr).not.toMatch(/-13/);
        expect(age.text.en).not.toMatch(/-13/);
        expect(age.voided).toBe(S.VOIDED_AGE);
        // The archived number is kept on the cell — traceable, never printed.
        expect(age.archivedValue).toBe(-13);
    });

    test('the page is told WHY, in both languages, with the two instants that contradict', () => {
        const l = lineOf(S.repairFrozenPayload(archivedBrief(-13)));
        for (const lang of ['fr', 'en']) {
            expect(l.note[lang]).toBe(l.oldestAge.hint[lang]); // one sentence, one place
            expect(l.note[lang]).toContain('01/09/2026'); // period end — the wrong anchor
            expect(l.note[lang]).toContain('14/09/2026'); // day of computation — the right one
            expect(l.note[lang]).toMatch(/-13/); // what the archive said
        }
        expect(l.note.fr).toMatch(/non restituable/);
        expect(l.note.en).toMatch(/not restorable/);
        expect(
            S.impossibleAgeNote(-13, {
                periodEnd: '2026-09-01T00:00:00.000Z',
                computedAt: '2026-09-14T08:19:12.774Z',
            })
        ).toEqual(l.note);
    });

    test('NOTHING else on the line moves: the count, taken on the day of computation, is intact', () => {
        const l = lineOf(S.repairFrozenPayload(archivedBrief(-13)));
        expect(l.count.value).toBe(1);
        expect(l.count.state).toBe('measured');
        expect(l.count.text).toEqual({ fr: '1', en: '1' });
        // No claim is added that the repair cannot support: `overdue` keeps the
        // value it was sent with.
        expect(l.overdue).toBe(false);
    });

    test('the ARCHIVE is untouched and the repair is idempotent', () => {
        const archived = archivedBrief(-13);
        const once = S.repairFrozenPayload(archived);
        expect(archived.blocks.A[0].lines[0].oldestAge.value).toBe(-13); // the row object never moves
        expect(archived.blocks.A[0].lines[0].note).toBeUndefined();
        expect(JSON.stringify(S.repairFrozenPayload(once))).toBe(JSON.stringify(once));
        expect(CTRL_SRC).not.toMatch(/UPDATE dept_briefs/);
    });

    test('a MEASURED age is published as it was archived — the guard is not a blanket', () => {
        for (const v of [0, 1, 19]) {
            const l = lineOf(S.repairFrozenPayload(archivedBrief(v)));
            expect(l.oldestAge.state).toBe('measured');
            expect(l.oldestAge.value).toBe(v);
            expect(l.oldestAge.voided).toBeUndefined();
            expect(l.note).toBeUndefined();
            expect(l.oldestAge.text).toEqual(S.daysText(v)); // A-15 still owns the wording
        }
    });

    test('the NEIGHBOURING cases of the same class are covered, not just A1', () => {
        // A2 (disputes) names the cell `age`, C2 carries the age as a raw
        // attribute (« rompue depuis n jour(s) ») — same impossibility.
        const p = archivedBrief(-13);
        p.blocks.A.push({
            id: 'A2',
            title: { fr: 'Litiges', en: 'Disputes' },
            lines: [
                {
                    unitId: 11,
                    level: 'L0',
                    label: { fr: 'u', en: 'u' },
                    age: {
                        state: 'measured',
                        unit: 'days',
                        kind: 'queue',
                        value: -1,
                        text: { fr: '-1 jour', en: '-1 day' },
                        color: null,
                        hint: null,
                    },
                    overdue: false,
                },
            ],
        });
        p.blocks.C.push({
            id: 'C2',
            title: { fr: 'Ruptures', en: 'Breaches' },
            lines: [{ unitId: 11, label: { fr: 'u', en: 'u' }, rules: 2, oldestBreachDays: -3 }],
        });
        const out = S.repairFrozenPayload(p);
        const a2 = out.blocks.A[1].lines[0];
        expect(a2.age.state).toBe(S.STATES.UNMEASURED);
        expect(a2.age.archivedValue).toBe(-1);
        expect(a2.note.fr).toMatch(/non restituable/);
        const c2 = out.blocks.C[0].lines[0];
        expect(c2.oldestBreachDays).toBeUndefined(); // « rompue depuis -3 jour(s) » is never printed
        expect(c2.voidedBreachAge).toBe(-3);
        expect(c2.rules).toBe(2);
        // A positive breach age is left exactly where it was.
        const kept = S.repairFrozenPayload({
            ...archivedBrief(1),
            blocks: {
                A: [],
                B: [],
                C: [{ id: 'C2', lines: [{ unitId: 11, oldestBreachDays: 34 }] }],
            },
        });
        expect(kept.blocks.C[0].lines[0].oldestBreachDays).toBe(34);
    });

    test('the page prints the voided cell and its reason — no template change needed', () => {
        expect(SHOW_EJS).toMatch(/L\(v\.text\)/); // the cell text, verbatim
        expect(SHOW_EJS).toMatch(/title="<%= L\(v\.hint\) %>"/); // the reason, on hover
        expect(SHOW_EJS).toMatch(/if \(l\.note\)/); // …and on the line itself
    });

    test('the REPLAY goes through the same repair — a resend cannot re-publish the -13', () => {
        const fn = JOB_SRC.slice(
            JOB_SRC.indexOf('async function _resendOne'),
            JOB_SRC.indexOf('/** Branding for the email')
        );
        expect(fn).toMatch(/repairFrozenPayload\(/);
        expect(fn).not.toMatch(/buildPayload/); // still no recomputation
        expect(CTRL_SRC).toMatch(/DeptBriefService\.repairFrozenPayload\(/);
    });
});

// ===========================================================================
describe('M-08 — the producer can no longer MINT a negative age', () => {
    async function a1({ observedAt, submittedAt }) {
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM self_assessments sa/i.test(sql)) {
                return [{ departmentId: 11, n: 1, oldest: submittedAt.toISOString() }];
            }
            return [];
        });
        const out = await S.blocksA({
            scope: scopeStub(),
            grid: GRID,
            win: WIN,
            settings: SETTINGS,
            observedAt,
        });
        const s = out.find((x) => x.id === 'A1');
        return s ? s.lines[0] : null;
    }

    test('an item that lands DURING the run is 0 day old, never -1', async () => {
        // `observedAt` is captured once, at the start of the build; the queue
        // query has no upper bound, so the row can be newer than the instant.
        const l = await a1({
            observedAt: new Date('2026-09-14T08:19:00Z'),
            submittedAt: new Date('2026-09-14T08:19:07Z'),
        });
        expect(l.count.value).toBe(1);
        expect(l.oldestAge.value).toBe(0);
        expect(l.oldestAge.text.fr).toBe('0 jour');
        expect(l.overdue).toBe(false);
    });

    test('a row dated in the FUTURE (an import) does not archive a negative age either', async () => {
        const l = await a1({
            observedAt: new Date('2026-09-14T08:19:00Z'),
            submittedAt: new Date('2026-10-01T00:00:00Z'),
        });
        expect(l.oldestAge.value).toBe(0);
        expect(l.oldestAge.value).toBeGreaterThanOrEqual(0);
    });

    test('and the clamp hides nothing: a real age is still the real age, flag included', async () => {
        const observedAt = new Date('2026-09-14T08:19:00Z');
        const old = await a1({ observedAt, submittedAt: new Date('2026-08-26T08:00:00Z') });
        expect(old.oldestAge.value).toBe(19);
        expect(old.overdue).toBe(true); // SLA = 5 days
        const fresh = await a1({ observedAt, submittedAt: new Date('2026-09-12T08:00:00Z') });
        expect(fresh.oldestAge.value).toBe(2);
        expect(fresh.overdue).toBe(false);
    });
});
