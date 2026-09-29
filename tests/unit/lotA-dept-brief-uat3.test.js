'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * SECTION campaigns — the UAT3 findings on the DEPARTMENT BRIEF: accuracy, links, resend.
 *
 * Each block below pins one finding of `docs/committee/UAT3-BOARD-passe1.md`,
 * with the number that was actually measured on idevelop before the fix:
 *
 *   M-08 / A-02  the age of a queue was measured against `win.periodEnd`
 *                instead of the day of computation — 7 of 7 monthly briefs
 *                carrying an A1 section published « Le plus ancien : -13 jour »,
 *                and anything submitted inside [periodEnd, computedAt] escaped
 *                its SLA. The same anchor was reused SIX more times.
 *   A-01 / M-09  a suppressed Δ printed « lot d'import détecté » whatever the
 *                reason — 45 archived briefs carry `partial_period`, 0 carry an
 *                import suppression — and the « période partielle » mention
 *                SPEC §2.1 makes mandatory appeared only in the e-mail.
 *   A-03         `scopeOf()` returns `size: null` for an unrestricted scope and
 *                the job wrote `Number(null) || 0` into a NOT NULL column:
 *                3 unrestricted briefs out of 3 read « Effectif retenu 0 » on a
 *                page whose own footer said « Ensemble 76 ».
 *   M-11         3 of the 6 deep links pointed at routes that are not mounted,
 *                including the brief's ONLY call to action.
 *   A-13         the manual resend delivered without superseding, leaving two
 *                unread bell lines for the same brief.
 *   A-07         `action_type` was interpolated raw into both languages.
 *   A-09 / M-14  the third certification bucket was « 31–30 j » (monthly) and
 *                « 31–14 j » (weekly) — 45 briefs out of 45 — and its SQL froze
 *                30 on both sides, so the column was empty by construction.
 *   A-15         plurals: « -13 jour », « 1 of 36 person », « 1 postes occupés ».
 *   A-11         French colon spacing on the ENGLISH page (40 occurrences).
 *   A-17         « constaté le jour d'envoi » never carried its date.
 *   M-10         the three em dashes of the « Ensemble » row had no tooltip of
 *                their own and could not be told from « jamais mesuré ».
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
    // The admin-only block A6 resolves permissions FRESHLY (never `hasPermission`,
    // which reads the session): both are needed for a full buildPayload.
    getPermissions: jest.fn(async () => []),
    isSuperAdmin: jest.fn(() => false),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

// CoverageService and KeyPersonRiskService are real services with their own
// queries; block C only needs their SHAPE here.
const mockCoverage = { status: jest.fn(async () => []) };
jest.mock('../../src/services/CoverageService', () => mockCoverage);
const mockKeyPerson = { sweep: jest.fn(async () => null) };
jest.mock('../../src/services/KeyPersonRiskService', () => mockKeyPerson);

const S = require('../../src/services/DeptBriefService');
const { windowFor } = require('../../src/utils/periodWindow');

const SRC = fs.readFileSync(path.join(ROOT, 'src/services/DeptBriefService.js'), 'utf8');
const JOB_SRC = fs.readFileSync(path.join(ROOT, 'src/jobs/dept-brief.js'), 'utf8');
const SHOW_EJS = fs.readFileSync(
    path.join(ROOT, 'views/pages/reports/dept-brief-show.ejs'),
    'utf8'
);
const CTRL_SRC = fs.readFileSync(path.join(ROOT, 'src/controllers/DeptBriefController.js'), 'utf8');
const ROUTES = fs.readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8');
const EXEC_ROUTES = fs.readFileSync(path.join(ROOT, 'src/routes/exec.js'), 'utf8');
const FR = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/fr/reports.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en/reports.json'), 'utf8'));

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

beforeEach(() => {
    mockDb.all.mockReset();
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockReset();
    mockDb.get.mockResolvedValue(undefined);
    mockDb.run.mockReset();
    mockDb.run.mockResolvedValue({ changes: 0 });
    mockCoverage.status.mockReset();
    mockCoverage.status.mockResolvedValue([]);
    mockKeyPerson.sweep.mockReset();
    mockKeyPerson.sweep.mockResolvedValue(null);
});

// ===========================================================================
describe('M-08 / A-02 — a queue is aged against the DAY OF COMPUTATION, not the period end', () => {
    /** One A1 row whose oldest item was submitted `daysAgo` before `observedAt`. */
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

    test('an item submitted AFTER the period closed has a POSITIVE age, not a negative one', async () => {
        // The exact shape of brief 325: period_end 01/09, computed_at 14/09,
        // submitted_at 13/09 → the page published « -13 jour ».
        const l = await a1({
            observedAt: new Date('2026-09-14T08:19:00Z'),
            submittedAt: new Date('2026-09-13T14:42:21Z'),
        });
        expect(l.count.value).toBe(1);
        expect(l.oldestAge.value).toBe(0);
        expect(l.oldestAge.value).toBeGreaterThanOrEqual(0);
        expect(l.oldestAge.text.fr).not.toMatch(/^-/);
    });

    test('the SLA flag is NOT dead: a 19-day file is flagged, a 2-day file is not', async () => {
        const observedAt = new Date('2026-09-14T08:19:00Z');
        const overdue = await a1({ observedAt, submittedAt: new Date('2026-08-26T08:00:00Z') });
        expect(overdue.oldestAge.value).toBe(19);
        expect(overdue.overdue).toBe(true); // SLA = 5 days
        const fresh = await a1({ observedAt, submittedAt: new Date('2026-09-12T08:00:00Z') });
        expect(fresh.oldestAge.value).toBe(2);
        expect(fresh.overdue).toBe(false);
    });

    test('the blind spot is closed: an item inside [periodEnd, computedAt] can now be overdue', async () => {
        // 19 days old, but submitted AFTER the period closed. Against periodEnd
        // its age was −12 and `-12 > 5` is false: the file never raised a flag,
        // for the whole catch-up window (20 d monthly, 60 d yearly).
        const l = await a1({
            observedAt: new Date('2026-09-20T00:00:00Z'),
            submittedAt: new Date('2026-09-01T00:00:00Z'),
        });
        expect(Math.floor((WIN.periodEnd - new Date('2026-09-01T00:00:00Z')) / 86400000)).toBe(0);
        expect(l.oldestAge.value).toBe(19);
        expect(l.overdue).toBe(true);
    });

    test('block B ages and thresholds use the same anchor', async () => {
        const observedAt = new Date('2026-09-20T00:00:00Z');
        const seen = [];
        mockDb.all.mockImplementation(async (sql, params) => {
            if (/FROM coaching_plans c/i.test(sql)) {
                seen.push(['coaching', params[0]]);
                return [];
            }
            if (/FROM lms_enrollments l/i.test(sql)) {
                seen.push(['lms', params[0]]);
                return [];
            }
            if (/FROM idp_actions a/i.test(sql)) return [];
            return [];
        });
        await S.blocksB({
            scope: scopeStub(),
            grid: GRID,
            win: WIN,
            settings: SETTINGS,
            observedAt,
        });
        const coaching = seen.find((x) => x[0] === 'coaching');
        const lms = seen.find((x) => x[0] === 'lms');
        // 21 days before the OBSERVATION day, and "overdue" measured today.
        expect(new Date(coaching[1]).toISOString()).toBe('2026-08-30T00:00:00.000Z');
        expect(new Date(lms[1]).toISOString()).toBe(observedAt.toISOString());
        expect(new Date(lms[1]).getTime()).not.toBe(WIN.periodEnd.getTime());
    });

    test('C2 states how long a coverage rule has been breached, counted from today', async () => {
        const observedAt = new Date('2026-09-20T00:00:00Z');
        mockCoverage.status.mockResolvedValue([
            {
                departmentId: 11,
                satisfied: false,
                breachedSince: '2026-08-21T00:00:00Z',
                predictedBreachOn: null,
            },
        ]);
        const out = await S.blocksC({
            scope: scopeStub(),
            grid: GRID,
            win: WIN,
            settings: SETTINGS,
            observedAt,
            namesAllowed: false,
        });
        const c2 = out.find((x) => x.id === 'C2');
        // 30 days counted from the observation day; only 11 from the period end.
        expect(c2.lines[0].oldestBreachDays).toBe(30);
        expect(c2.lines[0].oldestBreachDays).not.toBe(
            Math.floor((WIN.periodEnd - new Date('2026-08-21T00:00:00Z')) / 86400000)
        );
    });

    test('NO age in the source is anchored on win.periodEnd any more', () => {
        // The CLASS, not the one observable line: :474, :483, :516, :524, :554,
        // :883, :927, :975, :1206 all read the same wrong anchor.
        expect(SRC).not.toMatch(/win\.periodEnd\s*-\s*new Date\(/);
        expect(SRC).not.toMatch(/win\.periodEnd\.getTime\(\)\s*-\s*21/);
        const windowBounded = SRC.match(/\[win\.periodStart, win\.periodEnd/g) || [];
        // The FLUX counters keep their calendar window — that one is right.
        expect(windowBounded.length).toBeGreaterThanOrEqual(4);
        // …and no QUEUE query is bounded by periodEnd alone any more.
        expect(SRC).not.toMatch(/GROUP BY 1`, \[win\.periodEnd,/);
    });

    test('the observation instant IS the brief identity — one clock, printed once', () => {
        expect(SRC).toMatch(/computedAt: observedAt/);
        expect(SRC).not.toMatch(/computedAt: new Date\(\)/);
    });
});

// ===========================================================================
describe('A-03 — an unrestricted brief publishes its real population, never 0', () => {
    test('buildPayload resolves the null scope size to the roster population', async () => {
        mockRbac.scopeFilter.mockResolvedValue({ clause: '', params: [] }); // superadmin
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM v_employee_details ed/i.test(sql)) {
                return [
                    {
                        departmentId: 11,
                        siteId: 1,
                        siteName: 'Riverside',
                        departmentName: 'IT',
                        headcount: 36,
                    },
                    {
                        departmentId: 15,
                        siteId: 2,
                        siteName: 'Northfield',
                        departmentName: 'IT',
                        headcount: 40,
                    },
                ];
            }
            if (/FROM v_employee_details WHERE is_active AND department_id/i.test(sql)) {
                return [
                    { departmentId: 11, n: 36 },
                    { departmentId: 15, n: 40 },
                ];
            }
            return [];
        });
        const p = await S.buildPayload(
            { type: 'admin', id: 666, role: 'superadmin' },
            'monthly',
            WIN,
            { settings: SETTINGS }
        );
        expect(p.scopeSignature).toBe('unrestricted');
        expect(p.scopeSize).toBe(76);
        expect(p.scopeSize).not.toBe(0);
    });

    test('the job archives the payload headcount and no longer coerces null to 0', () => {
        expect(JOB_SRC).toMatch(/scopeSize: payload\.scopeSize/);
        expect(JOB_SRC).not.toMatch(/built\.scope\.size \|\| 0/);
        expect(JOB_SRC).not.toMatch(/Number\(built\.scope\.size\) \|\| 0/);
    });

    test('the PAGE decides on the FROZEN signature, never on the reader live scope', () => {
        // Using the controller's `unrestricted` (the READER's scope) would print
        // « non restreint » on brief 349, which was computed over 41 people.
        expect(SHOW_EJS).toMatch(/brief\.scopeSignature\) === 'unrestricted'/);
        expect(SHOW_EJS).toMatch(/db_scope_size_unrestricted/);
        const identity = SHOW_EJS.slice(
            SHOW_EJS.indexOf('db_identity_title'),
            SHOW_EJS.indexOf('db_scope_signature')
        );
        expect(identity).not.toMatch(/\bunrestricted\s*\?/); // not the local passed by the controller
    });
});

// ===========================================================================
describe('A-01 / M-09 — a suppressed Δ says its REAL reason, and a partial period is stated', () => {
    test('the page reads d.reason instead of assuming an import', () => {
        expect(SHOW_EJS).toMatch(/d\.reason === 'partial_period'/);
        expect(SHOW_EJS).toMatch(/d\.reason === 'import_batch'/);
        expect(SHOW_EJS).toMatch(/db_delta_suppressed_partial/);
        expect(SHOW_EJS).toMatch(/db_delta_suppressed_plain/);
    });

    test('the mandatory « période partielle » mention of SPEC §2.1 is rendered', () => {
        expect(SHOW_EJS).toMatch(/payload\.partialPeriod && payload\.partialPeriod\.since/);
        expect(SHOW_EJS).toMatch(/db_partial_period/);
        expect(FR.db_partial_period).toMatch(/[Pp]ériode partielle/);
        expect(EN.db_partial_period).toMatch(/[Pp]artial period/);
        // …and it carries the date the e-mail already published.
        expect(FR.db_partial_period).toMatch(/\{\{date\}\}/);
        expect(EN.db_partial_period).toMatch(/\{\{date\}\}/);
    });

    test('no sentence mixes the two languages', () => {
        for (const k of [
            'db_partial_period',
            'db_delta_suppressed_partial',
            'db_delta_suppressed_plain',
        ]) {
            expect(FR[k]).toBeTruthy();
            expect(EN[k]).toBeTruthy();
            expect(FR[k]).not.toBe(EN[k]);
        }
        expect(EN.db_delta_suppressed_partial).not.toMatch(/période/);
        expect(FR.db_delta_suppressed_partial).not.toMatch(/period\b/);
    });
});

// ===========================================================================
describe('M-11 — every deep link points at a route that is really mounted', () => {
    test('the three invented targets are gone from the service', () => {
        // They survive in ONE place only: the alias table that repairs the
        // payloads already archived under those names.
        const alias = SRC.slice(
            SRC.indexOf('const LEGACY_LINK_ALIAS'),
            SRC.indexOf('function _readerLink')
        );
        const rest = SRC.replace(alias, '');
        expect(rest).not.toMatch(/'\/talent\/key-person-risk'/);
        expect(rest).not.toMatch(/link: '\/continuity'/);
        expect(rest).not.toMatch(/'\/talent\/retention'/);
        expect(alias).toMatch(/'\/talent\/key-person-risk'/);
        // S10 — the table grew: the same rule applied to the five links the
        // first pass had not opened, and the retention target moved off the JSON
        // endpoint onto the page that shows it.
        expect(S.LINK).toEqual({
            keyPerson: '/exec/key-person',
            continuity: '/v2/continuity',
            retention: '/v2/continuity#ret-table',
            disputes: '/v2/slf/disputes',
            lmsHub: '/v2/lms',
            myLearning: '/employee/my-learning',
            accountRequests: '/admin/accounts',
            mobility: '/v2/cap',
            makerChecker: '/v2/uam/maker-checker/queue',
        });
    });

    test('the three real routes are mounted', () => {
        expect(EXEC_ROUTES).toMatch(/router\.get\(\s*'\/key-person'/);
        expect(ROUTES).toMatch(/router\.use\(\s*'\/exec'/);
        expect(ROUTES).toMatch(/router\.use\(\s*'\/v2\/continuity'/);
        const cont = fs.readFileSync(path.join(ROOT, 'src/routes/v2-continuity.js'), 'utf8');
        expect(cont).toMatch(/router\.get\(\s*'\/',/);
        expect(cont).toMatch(/router\.get\(\s*'\/retention',/);
        // …and `/talent` mounts none of the three.
        expect(ROUTES).not.toMatch(/'\/talent\/key-person-risk'/);
        expect(ROUTES).not.toMatch(/'\/talent\/retention'/);
    });

    test('an ALREADY ARCHIVED payload is repaired at render time, never rewritten', () => {
        expect(S.resolveLink('/talent/key-person-risk')).toBe('/exec/key-person');
        expect(S.resolveLink('/continuity')).toBe('/v2/continuity');
        expect(S.resolveLink('/talent/retention')).toBe('/v2/continuity#ret-table');
        // Anything already correct passes through untouched.
        expect(S.resolveLink('/v2/pip')).toBe('/v2/pip');
        expect(S.resolveLink(null)).toBe(null);
        expect(CTRL_SRC).toMatch(
            /linkOf: \(l\) => DeptBriefService\.resolveLink\(l, readerOf\(req\)\)/
        );
        expect(SHOW_EJS).toMatch(/href\(s\.link\)/);
        // The archive itself is never updated by the read path.
        expect(CTRL_SRC).not.toMatch(/UPDATE dept_briefs/);
    });

    test('the section CTA — the brief ONE call to action — goes through the alias', () => {
        const cta = SHOW_EJS.slice(
            SHOW_EJS.indexOf('if (l.cta)'),
            SHOW_EJS.indexOf('if (l.cta)') + 240
        );
        expect(cta).toMatch(/href\(s\.link\)/);
        expect(cta).not.toMatch(/href="<%= s\.link \|\|/);
    });
});

// ===========================================================================
describe('A-13 — the manual resend supersedes the previous bell lines', () => {
    test('_resendOne marks the previous unread lines read BEFORE delivering', () => {
        const fn = JOB_SRC.slice(
            JOB_SRC.indexOf('async function _resendOne'),
            JOB_SRC.indexOf('/** Branding for the email')
        );
        const sup = fn.indexOf('supersede(recipient)');
        const del = fn.indexOf('await deliver(');
        expect(sup).toBeGreaterThan(-1);
        expect(del).toBeGreaterThan(-1);
        expect(sup).toBeLessThan(del); // §5.1: BEFORE the insert
        expect(fn).toMatch(/result\.superseded \+= await supersede\(recipient\)/);
    });

    test('and it is the SAME supersede the nominal loop uses — one statement, one rule', () => {
        expect(JOB_SRC.match(/await supersede\(recipient\)/g) || []).toHaveLength(2);
        expect(JOB_SRC).toMatch(
            /UPDATE notifications SET read_at = now\(\)[\s\S]*kind = 'dept_brief' AND read_at IS NULL/
        );
    });

    test('a resend RUN issues the UPDATE, reports the count, and still never recomputes', async () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/services/NotificationService', () => ({
                notify: jest.fn(async () => ({ inapp: 'queued', email: 'sent' })),
                enqueue: jest.fn(async () => ({ state: 'queued' })),
            }));
            jest.doMock('../../src/services/EmailService', () => ({
                isCategoryEnabled: async () => true,
            }));
            jest.doMock('../../src/services/EmailAccountsService', () => ({
                accountsWithEmail: async () => [],
            }));
            jest.doMock('../../src/models/AppSettingsModel', () => ({
                getValue: async (k, d) => d,
                setValue: async () => {},
            }));
            jest.doMock('../../src/utils/branding', () => ({
                getBranding: async () => ({ appName: 'ACME', accent: '#123' }),
            }));
        });
        // eslint-disable-next-line global-require
        const jobMod = require('../../src/jobs/dept-brief');
        const archived = {
            version: 1,
            cadence: 'monthly',
            period: '2026-08',
            periodStart: new Date(Date.UTC(2026, 7, 1)),
            periodEnd: new Date(Date.UTC(2026, 8, 1)),
            displayEnd: new Date(Date.UTC(2026, 7, 31)),
            days: 31,
            horizonDays: 30,
            computedAt: new Date(Date.UTC(2026, 8, 14, 8)),
            scopeSignature: 'unrestricted',
            scopeSize: 76,
            recipient: { type: 'admin', id: 666 },
            units: [],
            blocks: { A: [], B: [], C: [] },
            footer: { units: [], totals: null },
            flow: { window: {}, lines: [] },
            deltas: { basis: 'first_measure', seriesStart: null, d1: null, d5: null },
            isEmpty: false,
            disclaimer: { fr: 'd', en: 'd' },
            natureOfFigures: { fr: 'n', en: 'n' },
        };
        const seen = [];
        mockDb.get.mockImplementation(async (sql) => {
            if (/FROM dept_briefs\s+WHERE cadence/i.test(sql)) {
                return { id: 351, payload: JSON.stringify(archived), isEmpty: false };
            }
            return undefined;
        });
        mockDb.run.mockImplementation(async (sql) => {
            if (/UPDATE notifications SET read_at/i.test(sql)) {
                seen.push('supersede');
                return { changes: 2 };
            }
            seen.push('other');
            return { changes: 1 };
        });
        const buildSpy = jest.spyOn(S, 'buildPayload');
        const r = await jobMod.tick({
            resend: {
                cadence: 'monthly',
                period: '2026-08',
                only: { userType: 'admin', userId: 666 },
            },
        });
        expect(r.resent).toBe(true);
        expect(seen).toContain('supersede');
        expect(r.superseded).toBe(2); // was 0 on every resend before the fix
        expect(buildSpy).not.toHaveBeenCalled();
        buildSpy.mockRestore();
    });
});

// ===========================================================================
describe('A-07 — no database token ever reaches a label', () => {
    test('each action type has a bilingual, agreeing title', () => {
        expect(S.flowActionTitle('self_assessment')).toEqual({
            fr: 'Auto-évaluations ouvertes',
            en: 'Self-assessments opened',
        });
        for (const t of ['coaching', 'idp', 'mentoring', 'pip', 'self_assessment']) {
            const title = S.flowActionTitle(t);
            expect(title.fr).not.toMatch(/_/);
            expect(title.en).not.toMatch(/_/);
            expect(title.fr).not.toBe(title.en);
            // §2.6 — the wording stays "opened", never "successful".
            expect(title.fr).toMatch(/ouvert/);
            expect(title.en).toMatch(/opened/);
        }
    });

    test('an unknown future type is humanised, never printed raw', () => {
        expect(S.flowActionTitle('some_new_type').fr).not.toMatch(/some_new_type/);
    });

    test('the raw interpolation is gone from the source', () => {
        expect(SRC).not.toMatch(/\$\{r\.actionType\} ouverts/);
        expect(SRC).not.toMatch(/\$\{r\.actionType\} opened/);
        expect(SRC).toMatch(/title: flowActionTitle\(r\.actionType\)/);
    });
});

// ===========================================================================
describe('A-09 / M-14 — the certification buckets can always be filled', () => {
    async function c1For(cadence) {
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM v_certification_current v/i.test(sql)) {
                return [{ departmentId: 11, expired: 1, soon: 2, later: 3, registered: 6 }];
            }
            return [];
        });
        const win = windowFor(cadence, new Date('2026-09-14T08:00:00Z'));
        const out = await S.blocksC({
            scope: scopeStub(),
            grid: GRID,
            win,
            settings: SETTINGS,
            observedAt: new Date('2026-09-14T08:00:00Z'),
            namesAllowed: false,
        });
        return { section: out.find((x) => x.id === 'C1'), win };
    }

    test('a horizon of 14 or 30 days OMITS the third bucket instead of showing an unfillable 0', async () => {
        for (const cadence of ['weekly', 'monthly']) {
            const { section, win } = await c1For(cadence);
            expect(section.buckets).toEqual({ soonMax: win.horizonDays, laterMax: null });
            expect(section.lines[0].expiringLater).toBeUndefined();
            expect(section.rule.fr).not.toMatch(/31–30|31–14/);
            expect(section.rule.en).not.toMatch(/31-30|31–30|31–14/);
            expect(section.rule.fr).toContain(`0–${win.horizonDays} j`);
        }
    });

    test('a wider horizon keeps the three buckets, with a possible interval', async () => {
        for (const cadence of ['quarterly', 'yearly']) {
            const { section, win } = await c1For(cadence);
            expect(section.buckets).toEqual({ soonMax: 30, laterMax: win.horizonDays });
            expect(section.lines[0].expiringLater.value).toBe(3);
            expect(section.rule.fr).toContain(`31–${win.horizonDays} j`);
        }
    });

    test('the SQL no longer freezes 30 on either side of the near bucket', () => {
        expect(SRC).not.toMatch(/days_to_expiry BETWEEN 0 AND 30/);
        expect(SRC).not.toMatch(/days_to_expiry > 30 AND/);
        expect(SRC).toMatch(/const soonMax = Math\.min\(30, horizon\)/);
    });

    test('the page and the e-mail name the buckets with the bounds that were used', () => {
        expect(SHOW_EJS).toMatch(/db_c1_within/);
        expect(SHOW_EJS).toMatch(/db_c1_beyond/);
        expect(FR.db_c1_within).toMatch(/\{\{n\}\}/);
        expect(EN.db_c1_within).toMatch(/\{\{n\}\}/);
        expect(JOB_SRC).toMatch(/function _fieldLabel\(key, section\)/);
        expect(JOB_SRC).toMatch(/0-\$\{b\.soonMax\} j/);
    });
});

// ===========================================================================
describe('A-15 — agreement and plurals', () => {
    test('a day count agrees in both languages, for 0 and for negative values', () => {
        const t = (n) => S.cell(n, { unit: 'days', kind: 'queue' }).text;
        expect(t(-13)).toEqual({ fr: '-13 jours', en: '-13 days' });
        expect(t(-1)).toEqual({ fr: '-1 jour', en: '-1 day' });
        expect(t(0)).toEqual({ fr: '0 jour', en: '0 days' });
        expect(t(1)).toEqual({ fr: '1 jour', en: '1 day' });
        expect(t(2)).toEqual({ fr: '2 jours', en: '2 days' });
    });

    test('the English scope label agrees with its DENOMINATOR', () => {
        expect(
            S.unitLabel(
                { unitName: 'Riverside / IT', headcount: 1, totalHeadcount: 36 },
                { type: 'admin' }
            ).en
        ).toBe('Riverside / IT — your scope: 1 of 36 people');
        expect(
            S.unitLabel(
                { unitName: 'Northfield / IT', headcount: 1, totalHeadcount: 1 },
                { type: 'admin' }
            ).en
        ).toBe('Northfield / IT — your scope: 1 of 1 person');
    });

    test('« n postes occupés » agrees, and the sentence stays the one SPEC §2.4 C3 prescribes', async () => {
        async function c3(nRoles) {
            mockDb.all.mockImplementation(async (sql) => {
                if (/SELECT DISTINCT e\.role_id/i.test(sql)) {
                    return Array.from({ length: nRoles }, (_, i) => ({ roleId: i + 1 }));
                }
                if (/FROM v_continuity_coverage/i.test(sql)) return []; // nothing rated
                return [];
            });
            const out = await S.blocksC({
                scope: scopeStub(),
                grid: GRID,
                win: WIN,
                settings: SETTINGS,
                observedAt: new Date('2026-09-14T08:00:00Z'),
                namesAllowed: false,
            });
            return out.find((x) => x.id === 'C3').lines[0].note;
        }
        expect(await c3(1)).toEqual({
            fr: 'criticité des postes non renseignée : 1 poste occupé, 0 coté',
            en: 'role criticality not filled in: 1 role occupied, 0 rated',
        });
        expect(await c3(11)).toEqual({
            fr: 'criticité des postes non renseignée : 11 postes occupés, 0 coté',
            en: 'role criticality not filled in: 11 roles occupied, 0 rated',
        });
    });
});

// ===========================================================================
// A-09 / M-14 and A-15, the ARCHIVED half.
//
// The four tests above measure the PRODUCER. They call blocksC and grep the
// source; none of them opens a brief that was computed and sent BEFORE the fix,
// which is why the whole defect went on being served on 45 briefs out of 45
// while the producer tests were green. These tests open one — a payload frozen
// in the faulty shape, with the exact sentences the board quotes — and render
// the real page with it.
// ===========================================================================
describe('A-09 / M-14 + A-15 — the 45 ALREADY ARCHIVED briefs are repaired at render time', () => {
    const ejs = require('ejs');

    /** i18next-like `__`, on the real catalogues. */
    const translator = (lang) => {
        const cat = lang === 'en' ? EN : FR;
        return (key, opts) => {
            const k = String(key).split(':')[1] || String(key);
            let s = cat[k];
            if (s === undefined)
                return (opts && opts.defaultValue) !== undefined ? opts.defaultValue : key;
            if (opts)
                for (const [n, v] of Object.entries(opts)) s = s.split(`{{${n}}}`).join(String(v));
            return s;
        };
    };

    const measured = (n) => ({
        value: n,
        denom: null,
        population: null,
        unit: 'count',
        kind: 'queue',
        source: 'v_certification_current',
        rule: null,
        link: '/compliance',
        state: n === 0 ? 'zero' : 'measured',
        text: { fr: String(n), en: String(n) },
        color: null,
        hint: null,
    });

    /**
     * ONE archived monthly brief, in the shape the job really wrote before the
     * producer was corrected: no `buckets`, an impossible « 31–30 j » rule, a
     * third bucket column that no data could fill, and the three A-15 agreement
     * faults. Every string here is copied from a payload read on idevelop.
     */
    const archived = () => ({
        horizonDays: 30,
        cadence: 'monthly',
        period: '2026-08',
        isEmpty: false,
        periodStart: '2026-08-01T00:00:00.000Z',
        periodEnd: '2026-09-01T00:00:00.000Z',
        computedAt: '2026-09-13T06:00:00.000Z',
        natureOfFigures: { fr: 'Chiffres figés.', en: 'Frozen figures.' },
        partialPeriod: null,
        flow: null,
        deltas: null,
        disclaimer: null,
        units: [
            {
                departmentId: 11,
                label: {
                    fr: 'Riverside / IT — votre périmètre : 1 personne sur 36',
                    en: 'Riverside / IT — your scope: 1 of 36 person',
                },
            },
        ],
        blocks: {
            A: [
                {
                    id: 'A1',
                    title: { fr: 'Revues à approuver', en: 'Reviews to approve' },
                    severity: 'action',
                    source: 'supervisor_reviews',
                    link: '/reviews',
                    rule: { fr: 'status = submitted', en: 'status = submitted' },
                    lines: [
                        {
                            unitId: 11,
                            label: {
                                fr: 'Riverside / IT — votre périmètre : 1 personne sur 36',
                                en: 'Riverside / IT — your scope: 1 of 36 person',
                            },
                            oldestAge: {
                                value: -13,
                                denom: null,
                                population: null,
                                unit: 'days',
                                kind: 'queue',
                                source: null,
                                rule: null,
                                link: null,
                                state: 'measured',
                                text: { fr: '-13 jour', en: '-13 day' },
                                color: null,
                                hint: null,
                            },
                        },
                        {
                            // The OTHER frozen day fault, and the one M-08 does not
                            // absorb: « 0 day » in English (« 0 jour » is right in
                            // French). 3 of the 45 archived briefs carry it.
                            unitId: 33,
                            label: {
                                fr: 'Riverside / Internal Audit — votre périmètre : 5 personnes sur 5',
                                en: 'Riverside / Internal Audit — your scope: 5 of 5 people',
                            },
                            oldestAge: {
                                value: 0,
                                denom: null,
                                population: null,
                                unit: 'days',
                                kind: 'queue',
                                source: null,
                                rule: null,
                                link: null,
                                state: 'zero',
                                text: { fr: '0 jour', en: '0 day' },
                                color: null,
                                hint: null,
                            },
                        },
                        {
                            // A day cell the archive already said correctly: the repair
                            // must leave its NUMBER and its words exactly as they are.
                            unitId: 44,
                            label: {
                                fr: 'Northfield / IT — votre périmètre : 1 personne sur 1',
                                en: 'Northfield / IT — your scope: 1 of 1 person',
                            },
                            oldestAge: {
                                value: 19,
                                denom: null,
                                population: null,
                                unit: 'days',
                                kind: 'queue',
                                source: null,
                                rule: null,
                                link: null,
                                state: 'measured',
                                text: { fr: '19 jours', en: '19 days' },
                                color: null,
                                hint: null,
                            },
                        },
                    ],
                },
            ],
            B: [],
            C: [
                {
                    id: 'C1',
                    title: { fr: 'Certifications qui expirent', en: 'Certifications expiring' },
                    severity: 'action',
                    source: 'v_certification_current',
                    link: '/compliance',
                    rule: {
                        fr: 'expirée (< 0 j), 0–30 j, 31–30 j ; aucun registre ⇒ « — », jamais 0',
                        en: 'expired (< 0 d), 0–30 d, 31–30 d; no register ⇒ "—", never 0',
                    },
                    lines: [
                        {
                            unitId: 13,
                            registered: 1,
                            label: {
                                fr: 'Exploration / IT — votre périmètre : 5 personnes sur 5',
                                en: 'Exploration / IT — your scope: 5 of 5 people',
                            },
                            expired: measured(0),
                            expiringSoon: measured(1),
                            expiringLater: measured(0),
                        },
                    ],
                },
                {
                    id: 'C3',
                    title: { fr: 'Postes sans relève', en: 'Critical roles without a successor' },
                    severity: 'info',
                    source: 'v_continuity_coverage',
                    link: '/v2/continuity',
                    rule: { fr: 'rôles OCCUPÉS', en: 'roles OCCUPIED' },
                    lines: [
                        {
                            unitId: null,
                            occupiedRoles: 1,
                            ratedRoles: 0,
                            note: {
                                fr: 'criticité des postes non renseignée : 1 postes occupés, 0 coté',
                                en: 'role criticality not filled in: 1 roles occupied, 0 rated',
                            },
                            cta: {
                                fr: 'Coter la criticité des postes',
                                en: 'Rate role criticality',
                            },
                        },
                    ],
                },
            ],
        },
        footer: {
            units: [
                {
                    departmentId: 11,
                    headcount: 36,
                    label: {
                        fr: 'Riverside / IT — votre périmètre : 1 personne sur 36',
                        en: 'Riverside / IT — your scope: 1 of 36 person',
                    },
                },
            ],
            totals: null,
        },
    });

    const render = (payload, lang) =>
        ejs.render(SHOW_EJS, {
            __: translator(lang),
            lang,
            brief: {
                id: 351,
                cadence: 'monthly',
                period: '2026-08',
                periodStart: '2026-08-01T00:00:00.000Z',
                periodEnd: '2026-09-01T00:00:00.000Z',
                computedAt: '2026-09-13T06:00:00.000Z',
                scopeSignature: 'unrestricted',
                scopeSize: 76,
            },
            payload,
            names: null,
            today: null,
            canRecompute: false,
            scopeSize: null,
            unrestricted: true,
            linkOf: S.resolveLink,
            csrfToken: 'c',
            // Published by the app on res.locals, beside `__` (A-11).
            colon: lang === 'en' ? ':' : ' :',
            fmtPeriodBound: require('../../src/utils/dateFormat').fmtPeriodBound,
            fmtDateTime: require('../../src/utils/dateFormat').fmtDateTime,
        });

    // ---- the reproduction, on the page the tester opened --------------------
    test('served UNREPAIRED, the frozen brief reproduces the three defects word for word', () => {
        const fr = render(archived(), 'fr');
        expect(fr).toContain('31–30 j'); // A-09 / M-14
        expect(fr).toContain('Au-delà de 30 jours'); // the column empty by construction
        expect(fr).toContain('1 postes occupés'); // A-15(1)
        expect(fr).toContain('-13 jour<'); // A-15(3)
        expect(render(archived(), 'en')).toContain('1 of 36 person<'); // A-15(2)
    });

    // ---- and repaired ------------------------------------------------------
    test('A-09 / M-14 — the impossible interval and its unfillable column are gone', () => {
        const p = S.repairFrozenPayload(archived());
        const c1 = p.blocks.C.find((s) => s.id === 'C1');
        expect(c1.buckets).toEqual({ soonMax: 30, laterMax: null });
        expect(c1.rule.fr).not.toMatch(/31–/);
        expect(c1.rule.en).not.toMatch(/31–/);
        expect(c1.rule.fr).toContain('0–30 j');
        expect(c1.lines[0].expiringLater).toBeUndefined();

        const fr = render(p, 'fr');
        expect(fr).not.toContain('31–30 j');
        expect(fr).not.toMatch(/Au-delà de \d+ jours/);
        expect(render(p, 'en')).not.toMatch(/Beyond \d+ days/);
        // The two buckets that WERE measured keep their numbers and are named
        // with the bound the archived SQL really used.
        expect(fr).toContain('Sous 30 jours');
        expect(c1.lines[0].expiringSoon.value).toBe(1);
        expect(c1.lines[0].expired.value).toBe(0);
    });

    test('a horizon that leaves room keeps its third bucket, untouched', () => {
        const q = archived();
        q.horizonDays = 90; // quarterly
        q.blocks.C[0].rule = {
            fr: 'expirée (< 0 j), 0–30 j, 31–90 j ; aucun registre ⇒ « — », jamais 0',
            en: 'expired (< 0 d), 0–30 d, 31–90 d; no register ⇒ "—", never 0',
        };
        const p = S.repairFrozenPayload(q);
        const c1 = p.blocks.C.find((s) => s.id === 'C1');
        expect(c1.buckets).toEqual({ soonMax: 30, laterMax: 90 });
        expect(c1.lines[0].expiringLater.value).toBe(0); // measured, not phantom
        expect(c1.rule).toEqual(q.blocks.C[0].rule); // the frozen sentence was already true
    });

    test('A-15 — the three agreements, on the page and in every frozen label', () => {
        const p = S.repairFrozenPayload(archived());
        expect(p.blocks.C.find((s) => s.id === 'C3').lines[0].note).toEqual({
            fr: 'criticité des postes non renseignée : 1 poste occupé, 0 coté',
            en: 'role criticality not filled in: 1 role occupied, 0 rated',
        });
        // A-15(3). « 0 jour » is right in French and « 0 day » is wrong in
        // English — the two languages do not share the rule. (The NEGATIVE age
        // of line 0 is a different finding: M-08 voids an arithmetically
        // impossible value instead of publishing it with a better plural, so
        // « -13 jour » disappears rather than becoming « -13 jours ». Both
        // outcomes are asserted below; neither leaves the fault on the page.)
        expect(p.blocks.A[0].lines[1].oldestAge.text).toEqual({ fr: '0 jour', en: '0 days' });
        // THE THREE places a unit label is frozen — the identity card, the
        // section lines and the footer — not just the one the page shows first.
        for (const en of [
            p.units[0].label.en,
            p.blocks.A[0].lines[0].label.en,
            p.footer.units[0].label.en,
        ]) {
            expect(en).toBe('Riverside / IT — your scope: 1 of 36 people');
        }
        const fr = render(p, 'fr');
        expect(fr).toContain('1 poste occupé, 0 coté');
        expect(fr).not.toContain('1 postes occupés');
        expect(fr).not.toContain('-13 jour<'); // the frozen singular is gone
        expect(fr).toContain('0 jour');
        const en = render(p, 'en');
        expect(en).not.toContain('1 of 36 person<');
        expect(en).not.toContain('-13 day<');
        expect(en).toContain('0 days');
        expect(en).not.toMatch(/>0 day</);
    });

    test('a singular denominator stays singular, and a French 0 stays « 0 jour »', () => {
        expect(S.daysText(0)).toEqual({ fr: '0 jour', en: '0 days' });
        expect(S.daysText(-1)).toEqual({ fr: '-1 jour', en: '-1 day' });
        const q = archived();
        q.units[0].label.en = 'Northfield / IT — your scope: 1 of 1 people';
        q.blocks.A[0].lines[0].oldestAge = {
            ...q.blocks.A[0].lines[0].oldestAge,
            value: 0,
            state: 'zero',
            text: { fr: '0 jours', en: '0 day' },
        };
        const p = S.repairFrozenPayload(q);
        expect(p.units[0].label.en).toBe('Northfield / IT — your scope: 1 of 1 person');
        expect(p.blocks.A[0].lines[0].oldestAge.text).toEqual({ fr: '0 jour', en: '0 days' });
    });

    test('NO FIGURE MOVES, the archive object is not touched, and the repair is idempotent', () => {
        const original = archived();
        const frozen = JSON.stringify(original);
        const once = S.repairFrozenPayload(original);
        expect(JSON.stringify(original)).toBe(frozen); // the stored object is untouched
        expect(JSON.stringify(S.repairFrozenPayload(once))).toBe(JSON.stringify(once));

        const values = (p) =>
            JSON.stringify([
                p.blocks.A[0].lines[1].oldestAge.value,
                p.blocks.A[0].lines[1].oldestAge.state,
                p.blocks.A[0].lines[2].oldestAge.value,
                p.blocks.A[0].lines[2].oldestAge.state,
                p.blocks.A[0].lines[2].oldestAge.text.fr,
                p.blocks.C[0].lines[0].expired.value,
                p.blocks.C[0].lines[0].expiringSoon.value,
                p.blocks.C[0].lines[0].registered,
                p.blocks.C[1].lines[0].occupiedRoles,
                p.blocks.C[1].lines[0].ratedRoles,
                p.footer.units[0].headcount,
            ]);
        expect(values(once)).toBe(values(original));
    });

    test('a payload computed AFTER the producer fix is returned unchanged', () => {
        const fresh = archived();
        fresh.blocks.C[0].buckets = { soonMax: 30, laterMax: null };
        fresh.blocks.C[0].rule = c1RuleOf(30, 30, false);
        delete fresh.blocks.C[0].lines[0].expiringLater;
        fresh.blocks.C[1].lines[0].note = S.c3Note(1);
        // A payload computed after the fix carries no impossible age either
        // (M-08): the producer anchors on the day of computation.
        fresh.blocks.A[0].lines[0].oldestAge = {
            ...fresh.blocks.A[0].lines[0].oldestAge,
            value: 19,
            state: 'measured',
            text: S.daysText(19),
        };
        fresh.blocks.A[0].lines[1].oldestAge.text = S.daysText(0);
        for (const l of [
            fresh.units[0].label,
            fresh.blocks.A[0].lines[0].label,
            fresh.footer.units[0].label,
        ]) {
            l.en = 'Riverside / IT — your scope: 1 of 36 people';
        }
        fresh.blocks.C[0].lines[0].label.en = 'Exploration / IT — your scope: 5 of 5 people';
        expect(JSON.stringify(S.repairFrozenPayload(fresh))).toBe(JSON.stringify(fresh));
    });

    test('a FRESH weekly brief keeps ITS OWN bounds — the repair never re-narrates a correct payload', () => {
        // The one case where the `buckets` guard earns its keep. A weekly brief
        // computed after the producer fix counted 0–14 days (horizon 14); the
        // ARCHIVED semantics the repair assumes are 0–30. Rewriting the sentence
        // here would make a correct brief lie about what it measured.
        const weekly = archived();
        weekly.horizonDays = 14;
        weekly.cadence = 'weekly';
        weekly.blocks.C[0].buckets = { soonMax: 14, laterMax: null };
        weekly.blocks.C[0].rule = c1RuleOf(14, 14, false);
        delete weekly.blocks.C[0].lines[0].expiringLater;
        const out = S.repairFrozenPayload(weekly);
        expect(out.blocks.C[0].buckets).toEqual({ soonMax: 14, laterMax: null });
        expect(out.blocks.C[0].rule.fr).toContain('0–14 j');
        expect(out.blocks.C[0].rule.fr).not.toContain('0–30 j');
        expect(out.blocks.C[0].rule.en).toContain('0–14 d');
        // …and it IS the cadence horizon here, so the sentence says so.
        expect(out.blocks.C[0].rule.fr).toContain('(horizon de la cadence)');
    });

    test('a repaired WEEKLY brief does not claim 30 days was its cadence horizon', () => {
        // The archived SQL counted 0–30 whatever the cadence. Saying « 0–30 j
        // (horizon de la cadence) » on a brief whose horizon was 14 would be a
        // false statement about a frozen figure — 12 of the 45 are weekly.
        const weekly = archived();
        weekly.horizonDays = 14;
        weekly.cadence = 'weekly';
        weekly.blocks.C[0].rule = {
            fr: 'expirée (< 0 j), 0–30 j, 31–14 j ; aucun registre ⇒ « — », jamais 0',
            en: 'expired (< 0 d), 0–30 d, 31–14 d; no register ⇒ "—", never 0',
        };
        const c1 = S.repairFrozenPayload(weekly).blocks.C[0];
        expect(c1.rule.fr).toBe('expirée (< 0 j), 0–30 j ; aucun registre ⇒ « — », jamais 0');
        expect(c1.rule.en).toBe('expired (< 0 d), 0–30 d; no register ⇒ "—", never 0');
        expect(c1.rule.fr).not.toContain('horizon de la cadence');
        expect(c1.rule.en).not.toContain('cadence horizon');
        expect(c1.rule.fr).not.toContain('31–14');
        expect(c1.buckets).toEqual({ soonMax: 30, laterMax: null });
        expect(c1.lines[0].expiringLater).toBeUndefined();
    });

    test('the repair is WIRED — the controller runs it on the way out, once, on every read path', () => {
        const ctrl = fs.readFileSync(
            path.join(ROOT, 'src/controllers/DeptBriefController.js'),
            'utf8'
        );
        expect(ctrl).toMatch(
            /DeptBriefService\.repairFrozenPayload\(parsePayload\(row\.payload\)\)/
        );
        // loadForReader is the ONE door: show() and recompute() both go through it.
        expect(ctrl.match(/parsePayload\(row\.payload\)/g)).toHaveLength(1);
        // The producer and the repair share their sentence builders — a second
        // copy of the rule is a second place for it to be wrong.
        expect(SRC).toMatch(/rule: c1Rule\(soonMax, horizon, hasLater\)/);
        expect(SRC).toMatch(/note: rated\.length \? null : c3Note\(roleIds\.length\)/);
        expect(SRC).toMatch(/\(\{ fr, en \} = daysText\(n\)\)/);
    });

    /** The producer's own builder, used to forge an "already correct" payload. */
    function c1RuleOf(soonMax, horizon, hasLater) {
        return S.c1Rule(soonMax, horizon, hasLater);
    }
});

// ===========================================================================
describe('A-11 — colon typography follows the language', () => {
    test('the separator comes from the catalogue, not from the template', () => {
        expect(FR.db_colon).toBe(' :');
        expect(EN.db_colon).toBe(':');
        // The separator is now a SHARED view helper — `res.locals.colon`, built by
        // src/utils/colon.js from `common:colon`. A constant local to this one
        // template is exactly what left eleven OTHER templates printing « Opens : »
        // and « Last activity : » on the English page.
        const { colon } = require('../../src/utils/colon');
        const t = (lang) => (key, opts) => {
            const cat =
                lang === 'en'
                    ? require('../../locales/en/common.json')
                    : require('../../locales/fr/common.json');
            const k = String(key).split(':')[1] || String(key);
            return cat[k] !== undefined ? cat[k] : opts && opts.defaultValue;
        };
        expect(colon(t('fr'), 'fr')).toBe(' :');
        expect(colon(t('en'), 'en')).toBe(':');
        // No translator at all (i18next absent): still never a raw key on screen.
        expect(colon(null, 'fr')).toBe(' :');
        expect(colon(null, 'en')).toBe(':');
        expect(colon((k) => k, 'en')).toBe(':');
        expect(SHOW_EJS).not.toMatch(/const colon = /);
    });

    test('no hard-coded French colon is left in the template', () => {
        const body = SHOW_EJS.slice(SHOW_EJS.indexOf('<div class="page-header">'));
        expect(body).not.toMatch(/%>\s:/);
        expect(body).toMatch(/<%= colon %>/);
    });

    test('and none is left in ANY template — the class, not the one page', () => {
        // The board counted the CLASS itself: 25 occurrences of `%> :` in 12
        // templates. Two of them were served on the ENGLISH page (/cycles/9 →
        // « Opens : », /admin/access-review → « Last activity : » ×25).
        const walk = (dir) =>
            fs
                .readdirSync(dir, { withFileTypes: true })
                .flatMap((d) =>
                    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]
                );
        // …and the SAME defect written another way: `label + ' : ' + value`,
        // which served « Service : » 24 times on the English /admins.
        const HARD_CODED = /%>\s:|\+\s*['"]\s+:\s*['"]\s*\+/;
        const offenders = walk(path.join(ROOT, 'views'))
            .filter((f) => f.endsWith('.ejs'))
            .filter((f) =>
                HARD_CODED.test(fs.readFileSync(f, 'utf8').replace(/<%#[\s\S]*?%>/g, ''))
            )
            .map((f) => path.relative(ROOT, f));
        expect(offenders).toEqual([]);
    });

    test('the shared helper is published beside `__` and `enumLabel`', () => {
        const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        expect(server).toMatch(
            /res\.locals\.colon = require\('\.\/src\/utils\/colon'\)\.colon\(req\.t, res\.locals\.lang\)/
        );
    });
});

// ===========================================================================
// A-07, the ARCHIVED half — the same lesson as M-11's deep links.
//
// The producer was fixed and its test is green above, but a brief is NEVER
// recomputed when it is opened: twelve archived payloads (310, 311, 329, 334,
// 335, 344, 345, 348, 349, 350, 351, 454) still carry the raw token frozen in
// `flow.lines[].title`, and went on publishing it on the page AND in the e-mail.
// ===========================================================================
describe('A-07 — a FROZEN flow title is repaired at render time', () => {
    const frozenLine = () => ({
        metric: 'opened.self_assessment',
        title: { fr: 'self_assessment ouverts', en: 'self_assessment opened' },
        table: 'v_perf_actions',
        now: 44,
        before: 1,
    });

    test('the archived token is replaced, in BOTH languages', () => {
        expect(S.resolveFlowTitle(frozenLine())).toEqual({
            fr: 'Auto-évaluations ouvertes',
            en: 'Self-assessments opened',
        });
    });

    test('every action type is covered, and the raw value never survives', () => {
        for (const t of ['coaching', 'idp', 'mentoring', 'pip', 'self_assessment']) {
            const frozen = { fr: `${t} ouverts`, en: `${t} opened` };
            const got = S.resolveFlowTitle({ metric: `opened.${t}`, title: frozen });
            // Never the frozen token sentence, and never a raw column value
            // (an underscore is the signature of one).
            expect(got.fr).not.toBe(frozen.fr);
            expect(got.en).not.toBe(frozen.en);
            expect(got.fr).not.toMatch(/_/);
            expect(got.en).not.toMatch(/_/);
            expect(got).toEqual(S.flowActionTitle(t));
        }
    });

    test('a line that is NOT an action count keeps the title it froze', () => {
        const l = {
            metric: 'reviewsClosed',
            title: { fr: 'Revues clôturées', en: 'Reviews closed' },
        };
        expect(S.resolveFlowTitle(l)).toBe(l.title);
    });

    test('nothing in the archive is rewritten', () => {
        const l = frozenLine();
        const before = JSON.stringify(l);
        S.resolveFlowTitle(l);
        expect(JSON.stringify(l)).toBe(before);
    });

    test('the page and the e-mail BOTH go through it — neither keeps its own copy', () => {
        expect(SHOW_EJS).toMatch(/<%= L\(flowTitle\(f\)\) %>/);
        expect(SHOW_EJS).toMatch(/flowTitleOf\(f\)/);
        const ctrl = fs.readFileSync(
            path.join(ROOT, 'src/controllers/DeptBriefController.js'),
            'utf8'
        );
        expect((ctrl.match(/flowTitleOf: DeptBriefService\.resolveFlowTitle/g) || []).length).toBe(
            2
        );
        const job = fs.readFileSync(path.join(ROOT, 'src/jobs/dept-brief.js'), 'utf8');
        expect(job).toMatch(/text: resolveFlowTitle\(l\)\.fr/);
        expect(job).not.toMatch(/text: l\.title\.fr/);
    });
});

// ===========================================================================
describe('A-17 — « constaté le … » carries the date it was observed on', () => {
    test('the sentence substitutes the computation day, in both languages', async () => {
        mockRbac.scopeFilter.mockResolvedValue({
            clause: ' AND __scope.id = ANY(?)',
            params: [[1, 2, 3]],
        });
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM v_employee_details ed/i.test(sql)) {
                return [
                    {
                        departmentId: 11,
                        siteId: 1,
                        siteName: 'Riverside',
                        departmentName: 'IT',
                        headcount: 3,
                    },
                ];
            }
            return [];
        });
        const observedAt = new Date('2026-09-14T08:19:00Z');
        const p = await S.buildPayload({ type: 'employee', id: 136 }, 'monthly', WIN, {
            settings: SETTINGS,
            observedAt,
        });
        expect(p.natureOfFigures.fr).toContain('constaté le 14/09/2026');
        expect(p.natureOfFigures.en).toContain('as observed on 14/09/2026');
        expect(p.natureOfFigures.fr).not.toContain('constaté le jour d’envoi');
        // …and it is the SAME instant the identity block prints.
        expect(p.computedAt).toBe(observedAt);
    });
});

// ===========================================================================
describe('M-10 — the « Ensemble » em dashes get their own tooltip, and NO fifth state', () => {
    test('the three not-aggregated cells carry a distinctive title', () => {
        const totals = SHOW_EJS.slice(
            SHOW_EJS.indexOf('db_totals'),
            SHOW_EJS.indexOf('db_departments')
        );
        expect(totals.match(/title="<%= notAggregated %>"/g) || []).toHaveLength(3);
        expect(FR.db_totals_not_aggregated).toMatch(/[Nn]on agrégé/);
        expect(EN.db_totals_not_aggregated).toMatch(/[Nn]ot aggregated/);
        // It must NOT read like « jamais mesuré » — that is the other silence.
        expect(FR.db_totals_not_aggregated).toMatch(/pas une absence de mesure/);
    });

    test('the cell state machine still has FOUR states — the tooltip is not a fifth', () => {
        expect(Object.values(S.STATES).sort()).toEqual(
            ['measured', 'not_publishable', 'unmeasured', 'zero'].sort()
        );
        // The « Ensemble » dashes are literal text in the template, not a cell:
        // no new state token was invented for them, in the service or the view.
        expect(SRC).not.toMatch(/not_aggregated/);
        expect(SHOW_EJS).not.toMatch(/state === 'not_aggregated'/);
    });
});

// ===========================================================================
describe('the house rules this lot must not break', () => {
    test('no absence is ever published as a 0', () => {
        expect(S.cell(null, { unit: 'count', kind: 'queue' }).text.fr).toBe('—');
        expect(S.cell(null, { unit: 'count', kind: 'queue' }).state).toBe(S.STATES.UNMEASURED);
        expect(SHOW_EJS).not.toMatch(/\.value\s*\|\|\s*0/);
    });

    test('every new reports:db_* key exists in BOTH locales', () => {
        const added = [
            'db_colon',
            'db_partial_period',
            'db_delta_suppressed_partial',
            'db_delta_suppressed_plain',
            'db_scope_size_unrestricted',
            'db_scope_size_unrestricted_unknown',
            'db_totals_not_aggregated',
            'db_c1_within',
            'db_c1_beyond',
        ];
        for (const k of added) {
            expect(typeof FR[k]).toBe('string');
            expect(typeof EN[k]).toBe('string');
        }
        expect(
            Object.keys(FR)
                .filter((k) => k.startsWith('db_'))
                .sort()
        ).toEqual(
            Object.keys(EN)
                .filter((k) => k.startsWith('db_'))
                .sort()
        );
    });

    test('the page still renders the FROZEN payload and never recomputes on read', () => {
        expect(SHOW_EJS).toMatch(/L\(v\.text\)/);
        expect(CTRL_SRC).not.toMatch(/UPDATE dept_briefs/);
    });
});
