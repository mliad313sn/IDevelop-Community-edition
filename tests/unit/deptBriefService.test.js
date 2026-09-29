'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * DEPARTMENT BRIEF — the calculation core, and the rendering rules of §2.0.
 *
 * Those rules are the part of the brief that is easiest to get wrong, and every
 * one of them is here because a LIVE defect already got it wrong:
 *
 *   - dept-digest.js:132 paints the em dash AMBER, because `null >= 80` is
 *     `false` and the colour is chosen before the state;
 *   - dept-digest.js:163 does `(r.readinessCoveragePct || 0) >= 80`, which turns
 *     "unknown" into "bad";
 *   - v_department_matrix_completion published Riverside / Internal Audit at
 *     met_pct = 0,0 % with 0 of its 794 requirement cells ever evaluated;
 *   - DashboardModel.getReadinessByGroup('department') groups by NAME, and idevelop
 *     holds NINE departments called "IT" — they collapse into one 71-person row;
 *   - grouping the FACTS instead of the roster lost Riverside / Internal Audit
 *     entirely: 9 departments returned instead of 10.
 *
 * Measured on idevelop at the time of writing (all figures asserted below come
 * from that run): 10 departments, 9 of them named "IT"; Northfield/IT holds 1
 * person, Eastgate/IT 3, Westbrook/IT and Hillcrest/IT 4; 8 of the 20 live
 * (governor × department) couples hold 3 people or fewer; Riverside / Internal
 * Audit holds 5 people, 794 required cells and 0 assessed; a local admin (#3) is
 * authorised over exactly ONE person in a department of 36.
 */

const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    inTransaction: jest.fn(() => false),
};
jest.mock('../../src/config/database', () => mockDb);

const mockRbac = {
    scopeFilter: jest.fn(),
    getPermissions: jest.fn(async () => []),
    isSuperAdmin: jest.fn(() => false),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const S = require('../../src/services/DeptBriefService');
const SRC = fs.readFileSync(path.join(__dirname, '../../src/services/DeptBriefService.js'), 'utf8');

/**
 * The forbidden-identifier guards run against the CODE, not the comments: the
 * file NAMES every banned helper in prose, with the reason it is banned, and
 * that prose is the point — it is what stops the next contributor reaching for
 * `getReadinessByGroup` again.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
    mockDb.inTransaction.mockReturnValue(false);
    mockRbac.scopeFilter.mockReset();
    mockRbac.isSuperAdmin.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// R1 — four display states, never three
// ---------------------------------------------------------------------------

describe('R1 — cell() has FOUR states and decides the state before any threshold', () => {
    test('a null is NOT MEASURED: an em dash, grey, with an explicit tooltip', () => {
        const c = S.cell(null, { unit: 'pct' });
        expect(c.state).toBe('unmeasured');
        expect(c.text.fr).toBe('—');
        expect(c.text.en).toBe('—');
        expect(c.color).toBe('#64748b');
        expect(c.hint.fr).toMatch(/pas un niveau 0/);
        expect(c.hint.en).toMatch(/not a zero/);
    });

    test('a null NEVER takes a threshold colour — the live dept-digest defect', () => {
        // `null >= 80` is false, so a naive renderer paints the em dash amber.
        const c = S.cell(null, {
            unit: 'pct',
            thresholds: { good: 80, warn: 60, direction: 'higher' },
        });
        expect(c.color).toBe('#64748b');
        expect(c.color).not.toBe('#b45309');
        expect(c.color).not.toBe('#b91c1c');
    });

    test('a MEASURED ZERO is a result, and it is not an em dash', () => {
        const c = S.cell(0, { unit: 'count' });
        expect(c.state).toBe('zero');
        expect(c.text.fr).toBe('0');
        expect(c.text.fr).not.toBe('—');
    });

    test('"not measured" and "measured zero" are different states, not two spellings', () => {
        expect(S.cell(null, { unit: 'count' }).state).not.toBe(S.cell(0, { unit: 'count' }).state);
    });

    test('a measured, publishable value ships with its denominator', () => {
        const c = S.cell(972, { unit: 'ratio', denom: 1030, kind: 'ratio', population: 36 });
        expect(c.state).toBe('measured');
        expect(c.text.fr).toBe('972/1030 (94,4 %)');
        expect(c.text.en).toBe('972/1030 (94.4%)');
    });

    test('a ZERO numerator publishes the count and NOT a rate', () => {
        // Riverside / Internal Audit: 0 of 794 cells assessed. "0/794" is true;
        // "0/794 (0,0 %)" invites comparison with a real 94,4 %.
        const c = S.cell(0, { unit: 'ratio', denom: 794, kind: 'ratio', population: 5 });
        expect(c.text.fr).toBe('0/794');
        expect(c.text.fr).not.toMatch(/%/);
        expect(c.text.en).not.toMatch(/%/);
        expect(c.state).toBe('zero');
        expect(c.color).toBe(null);
    });

    test('FR and EN are both produced, and the French uses a decimal comma', () => {
        const c = S.cell(81.9, { unit: 'pct', kind: 'ratio', population: 36, denom: 36 });
        expect(c.text.fr).toBe('81,9 %');
        expect(c.text.en).toBe('81.9%');
    });
});

// ---------------------------------------------------------------------------
// R2 — one anonymity floor, at 5 (aligned with surveys, DEI and bias in 3.23.17)
// ---------------------------------------------------------------------------

describe('R2 — ONE anonymity floor, and it is 5', () => {
    test('the constant is 5, the same value as the rest of the product', () => {
        expect(S.MIN_PUBLISHABLE_OBSERVATIONS).toBe(5);
        expect(SRC).toMatch(/SurveyService\.minResponses/);
        expect(SRC).toMatch(/PIP_MIN_MEASURED_CLOSURES/);
    });

    test('a rate over fewer than 5 people is NOT PUBLISHABLE, in both languages', () => {
        const c = S.cell(100, { unit: 'pct', kind: 'ratio', denom: 3, population: 3 });
        expect(c.state).toBe('not_publishable');
        expect(c.text.fr).toBe('non publiable (effectif < 5)');
        expect(c.text.en).toBe('not publishable (headcount < 5)');
        expect(c.color).toBe('#64748b');
    });

    test('the floor is on PEOPLE, not on the raw denominator', () => {
        // Governor #123 governs exactly one person holding 44 requirement cells.
        // A denominator of 44 looks safe and publishes that ONE person's score.
        const c = S.cell(44, { unit: 'ratio', denom: 44, kind: 'ratio', population: 1 });
        expect(c.state).toBe('not_publishable');
        expect(c.text.fr).not.toMatch(/%/);
    });

    test('exactly 5 publishes; 4 does not', () => {
        expect(S.cell(2, { unit: 'ratio', denom: 5, kind: 'ratio', population: 5 }).state).toBe(
            'measured'
        );
        expect(S.cell(2, { unit: 'ratio', denom: 4, kind: 'ratio', population: 4 }).state).toBe(
            'not_publishable'
        );
    });

    test('a ZERO rate under the floor is suppressed too — suppressing only the non-zero ones would leak the very cases that matter', () => {
        const c = S.cell(0, { unit: 'ratio', denom: 1, kind: 'ratio', population: 1 });
        expect(c.state).toBe('not_publishable');
        expect(c.text.fr).not.toBe('0/1');
    });

    test('a RESTRICTED count is suppressed on the unit headcount', () => {
        // 9-box, flight risk: the source itself is restricted.
        expect(S.cell(2, { unit: 'count', kind: 'restricted', population: 4 }).state).toBe(
            'not_publishable'
        );
        expect(S.cell(2, { unit: 'count', kind: 'restricted', population: 5 }).state).toBe(
            'measured'
        );
    });

    test('a restricted figure with an UNKNOWN population fails CLOSED', () => {
        expect(S.cell(2, { unit: 'count', kind: 'restricted' }).state).toBe('not_publishable');
    });

    test('a WORK QUEUE the recipient already governs stays publishable below the floor', () => {
        // They already hold those objects. The RATE is suppressed, never the queue.
        const c = S.cell(3, { unit: 'count', kind: 'queue', population: 1 });
        expect(c.state).toBe('measured');
        expect(c.text.fr).toBe('3');
    });
});

// ---------------------------------------------------------------------------
// R3 — the label carries its population
// ---------------------------------------------------------------------------

describe('R3 — a unit label ALWAYS carries its population denominator', () => {
    const unit = { unitName: 'Riverside / IT', headcount: 1, totalHeadcount: 36 };

    test('an admin sees the share of the department they are actually allowed to see', () => {
        const l = S.unitLabel(unit, { type: 'admin' });
        expect(l.fr).toBe('Riverside / IT — votre périmètre : 1 personne sur 36');
        // UPDATED (UAT3 A-15): this line used to pin « 1 of 36 person ». The
        // intention of the test is unchanged — the label must carry its
        // DENOMINATOR — but the English noun is governed by that denominator,
        // not by the numerator, so 36 people it is. The French twin, which was
        // always right, is untouched.
        expect(l.en).toBe('Riverside / IT — your scope: 1 of 36 people');
        expect(l.fr).toMatch(/sur 36/);
    });

    test('a scope of one person in a department of one keeps the singular', () => {
        const l = S.unitLabel(
            { unitName: 'Northfield / IT', headcount: 1, totalHeadcount: 1 },
            { type: 'admin' }
        );
        expect(l.en).toBe('Northfield / IT — your scope: 1 of 1 person');
        expect(l.fr).toBe('Northfield / IT — votre périmètre : 1 personne sur 1');
    });

    test('a governing employee sees "your team in", with its headcount', () => {
        const l = S.unitLabel(
            { unitName: 'Eastgate / IT', headcount: 3, totalHeadcount: 3 },
            { type: 'employee' }
        );
        expect(l.fr).toBe('Votre équipe dans Eastgate / IT — 3 personnes');
        expect(l.en).toMatch(/^Your team in Eastgate \/ IT — 3 people$/);
    });

    test('no label is ever the bare unit name', () => {
        for (const type of ['admin', 'employee']) {
            const l = S.unitLabel(unit, { type });
            expect(l.fr).not.toBe('Riverside / IT');
            expect(l.fr).toMatch(/1/);
        }
    });
});

// ---------------------------------------------------------------------------
// R4 + R5 — grid by id, built from the roster
// ---------------------------------------------------------------------------

function wireRoster({ grid, totals, withReq }) {
    mockDb.all.mockImplementation(async (sql) => {
        if (sql.includes('FROM v_employee_details ed')) return grid;
        if (sql.includes('FROM v_employee_details WHERE is_active AND department_id'))
            return totals;
        if (
            sql.includes('FROM v_employee_assessment_coverage c') &&
            sql.includes('expected_skills > 0')
        )
            return withReq;
        return [];
    });
}

describe('R4 — the aggregation key is department_id, never the name', () => {
    test('two departments called "IT" on two sites stay two rows', async () => {
        wireRoster({
            grid: [
                {
                    departmentId: 11,
                    siteId: 1,
                    siteName: 'Riverside',
                    departmentName: 'IT',
                    headcount: 36,
                },
                {
                    departmentId: 15,
                    siteId: 5,
                    siteName: 'Northfield',
                    departmentName: 'IT',
                    headcount: 1,
                },
            ],
            totals: [
                { departmentId: 11, n: 36 },
                { departmentId: 15, n: 1 },
            ],
            withReq: [
                { departmentId: 11, n: 36 },
                { departmentId: 15, n: 1 },
            ],
        });
        const rows = await S.rosterGrid([1, 2, 3]);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.departmentId).sort()).toEqual([11, 15]);
        // idevelop holds NINE of these; getReadinessByGroup('department') returns ONE.
        expect(new Set(rows.map((r) => r.departmentName))).toEqual(new Set(['IT']));
        expect(rows[0].unitName).toBe('Riverside / IT');
        expect(rows[1].unitName).toBe('Northfield / IT');
    });

    test('the forbidden name-keyed helpers are never CALLED, and are named in prose so nobody reaches for them again', () => {
        for (const banned of [
            /getReadinessByGroup/, // groups by NAME: nine "IT" become one
            /avgReadinessAllRequirements/, // 0 with measuredEmployees = 0
            /getOverviewKPIs/, // departmentIds is an independent branch
            /kpi_snapshots/, // no department scope, and a leak if opened
            /v_department_matrix_completion/, // met_pct divided by ALL requirements
            /v_employee_cycle_progress/, // INNER JOIN: 1 employee out of a 76 roster
            /findSubordinates/, // direct reports; a different population
            /GovernanceService/, // LIVE_SCOPE ignores revoked_at
        ]) {
            expect(CODE).not.toMatch(banned);
            expect(SRC).toMatch(banned);
        }
    });
});

describe('R5 — the grid comes from the ROSTER, counters LEFT JOIN onto it', () => {
    test('a department with no facts at all still appears, with its gap stated', async () => {
        wireRoster({
            grid: [
                {
                    departmentId: 11,
                    siteId: 1,
                    siteName: 'Riverside',
                    departmentName: 'IT',
                    headcount: 36,
                },
                {
                    departmentId: 33,
                    siteId: 1,
                    siteName: 'Riverside',
                    departmentName: 'Internal Audit',
                    headcount: 5,
                },
            ],
            totals: [
                { departmentId: 11, n: 36 },
                { departmentId: 33, n: 5 },
            ],
            // Internal Audit is absent from the counter rows — exactly what makes
            // it vanish from a GROUP BY over the facts.
            withReq: [{ departmentId: 11, n: 36 }],
        });
        const rows = await S.rosterGrid([1]);
        expect(rows).toHaveLength(2);
        const ia = rows.find((r) => r.departmentId === 33);
        expect(ia).toBeDefined();
        expect(ia.headcount).toBe(5);
        expect(ia.withRequirements).toBe(0);
        expect(ia.withoutRequirements).toBe(5);
    });

    test('the roster query reads v_employee_details, not the requirement view', () => {
        expect(SRC).toMatch(/FROM v_employee_details ed/);
        // dept-digest.departmentStats derives its headcount from
        // v_employee_skill_gaps — i.e. from REQUIREMENTS, so a person with no
        // requirement is simply not counted.
        expect(SRC).toMatch(/withoutRequirements/);
    });

    test('wholeDepartment is false as soon as one person of the unit is out of scope', async () => {
        wireRoster({
            grid: [
                {
                    departmentId: 11,
                    siteId: 1,
                    siteName: 'Riverside',
                    departmentName: 'IT',
                    headcount: 1,
                },
            ],
            totals: [{ departmentId: 11, n: 36 }],
            withReq: [{ departmentId: 11, n: 1 }],
        });
        const [row] = await S.rosterGrid([125]);
        expect(row.headcount).toBe(1);
        expect(row.totalHeadcount).toBe(36);
        expect(row.wholeDepartment).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// R6 — scope, row by row
// ---------------------------------------------------------------------------

describe('R6 — the scope is applied row by row, through RBACService.scopeFilter', () => {
    test('scopeOf goes through scopeFilter and keeps its ids', async () => {
        mockRbac.scopeFilter.mockResolvedValue({
            clause: ' AND __scope.id = ANY(?)',
            params: [[125]],
        });
        const scope = await S.scopeOf({ type: 'admin', id: 3, role: 'localadmin' });
        expect(mockRbac.scopeFilter).toHaveBeenCalledTimes(1);
        expect(scope.ids).toEqual([125]);
        expect(scope.size).toBe(1);
        expect(scope.unrestricted).toBe(false);
    });

    test('a superadmin is unrestricted; an empty scope is NOTHING, never everything', async () => {
        mockRbac.scopeFilter.mockResolvedValue({ clause: '', params: [] });
        expect((await S.scopeOf({ type: 'admin', id: 1, role: 'superadmin' })).ids).toBe(null);

        mockRbac.scopeFilter.mockResolvedValue({ clause: ' AND 1=0', params: [] });
        const none = await S.scopeOf({ type: 'admin', id: 70, role: 'viewer' });
        expect(none.ids).toEqual([]);
        expect(none.filter('e').clause).toBe(' AND 1 = 0');
    });

    test('the emitted fragment is a row-level `= ANY(?)`, on the alias asked for', () => {
        const f = S.scopeClause([1, 2, 3], 'ed', 'employee_id');
        expect(f.clause).toBe(' AND ed.employee_id = ANY(?)');
        expect(f.params).toEqual([[1, 2, 3]]);
    });

    test('no query filters by org unit instead of by person', () => {
        // _buildFilterClause treats departmentIds as an independent branch, so a
        // department id in a filter returns the WHOLE department.
        expect(CODE).not.toMatch(/departmentIds/);
        expect(CODE).not.toMatch(/serviceIds/);
        expect(CODE).not.toMatch(/siteIds/);
    });

    test('A6 resolves permissions with getPermissions, never the session-bound hasPermission', () => {
        expect(SRC).toMatch(/RBACService\.getPermissions\(/);
        expect(SRC).not.toMatch(/\.hasPermission\(/);
        expect(SRC).toMatch(/user\.permissions.*SESSION|SESSION at login/s);
    });

    test('the named-people block resolves DIRECT reports, not the sub-tree', async () => {
        mockDb.all.mockResolvedValue([{ id: 5 }, { id: 6 }]);
        await S.directReportIds(137);
        const sql = mockDb.all.mock.calls[0][0];
        expect(sql).toMatch(/supervisor_id = \?/);
        expect(sql).toMatch(/manager_id = \? AND manager_type = 'employee'/);
        expect(sql).not.toMatch(/findGovernedIds/);
    });
});

// ---------------------------------------------------------------------------
// R7 — one clock
// ---------------------------------------------------------------------------

describe('R7 — one clock, and no wall-clock SQL', () => {
    test('the brief SQL never calls now(), current_date or date_trunc(.., now())', () => {
        const sql = SRC.match(/`[^`]*SELECT[^`]*`/g) || [];
        expect(sql.length).toBeGreaterThan(5);
        for (const q of sql) {
            expect(q).not.toMatch(/\bnow\(\)/i);
            expect(q).not.toMatch(/\bcurrent_date\b/i);
        }
    });

    test('the calculation pins the transaction to UTC', () => {
        expect(SRC).toMatch(/SET LOCAL TimeZone = 'UTC'/);
    });

    test('bounds travel as Date objects, never as formatted strings', () => {
        expect(SRC).not.toMatch(/toISOString\(\)\.slice/);
    });
});

// ---------------------------------------------------------------------------
// R8 / §5.4 — nothing to say means no section
// ---------------------------------------------------------------------------

describe('R8 — a section with nothing to say is omitted, never rendered as 0', () => {
    test('blocksA returns nothing when every queue is empty', async () => {
        mockRbac.scopeFilter.mockResolvedValue({
            clause: ' AND __scope.id = ANY(?)',
            params: [[1, 2, 3, 4, 5]],
        });
        mockDb.all.mockResolvedValue([]);
        mockDb.get.mockResolvedValue({ n: 0 });
        const scope = await S.scopeOf({ type: 'employee', id: 99 });
        const grid = [
            {
                departmentId: 11,
                unitName: 'Riverside / IT',
                headcount: 5,
                totalHeadcount: 5,
                wholeDepartment: true,
                withoutRequirements: 0,
            },
        ];
        const out = await S.blocksA({
            scope,
            grid,
            win: {
                periodEnd: new Date('2026-07-01T00:00:00Z'),
                horizonEnd: new Date('2026-09-29T00:00:00Z'),
                horizonDays: 90,
            },
            settings: { reviewSlaDays: 5, disputeSla: { L0: 5, L1: 7, L2: 7 } },
        });
        expect(out).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// §2.5 — the footer
// ---------------------------------------------------------------------------

describe('the measured footer never turns an absence into a score', () => {
    async function footerFor(units, cov, gaps) {
        mockRbac.scopeFilter.mockResolvedValue({
            clause: ' AND __scope.id = ANY(?)',
            params: [[1]],
        });
        mockDb.all.mockImplementation(async (sql) => {
            if (sql.includes('SUM(c.expected_skills)')) return cov;
            if (sql.includes('FROM v_employee_skill_gaps g')) return gaps;
            return [];
        });
        const scope = await S.scopeOf({ type: 'admin', id: 33, role: 'localadmin' });
        return S.footer({ scope, grid: units });
    }

    const INTERNAL_AUDIT = {
        departmentId: 33,
        unitName: 'Riverside / Internal Audit',
        headcount: 5,
        totalHeadcount: 5,
        wholeDepartment: true,
        withoutRequirements: 0,
    };

    test('a department with 794 requirements and 0 assessments reads "0/794" and "—", never 0 %', async () => {
        const f = await footerFor(
            [INTERNAL_AUDIT],
            [
                {
                    departmentId: 33,
                    expected: 794,
                    assessed: 0,
                    avgReadiness: null,
                    measuredPeople: 0,
                    scopedPeople: 5,
                    criticalExpected: 303,
                    criticalAssessed: 0,
                },
            ],
            [{ departmentId: 33, requiredCells: 794, assessedCells: 0, metCells: 0 }]
        );
        const u = f.units[0];
        expect(u.d1Coverage.text.fr).toBe('0/794 exigences évaluées');
        expect(u.d2Readiness.state).toBe('unmeasured');
        expect(u.d2Readiness.text.fr).toBe('—');
        expect(u.d3Met.state).toBe('unmeasured');
        expect(u.d4Critical.state).toBe('unmeasured');
        for (const key of [
            'd1Coverage',
            'd2Readiness',
            'd3Completion',
            'd3Met',
            'd4Critical',
            'd5MeasuredPeople',
        ]) {
            expect(u[key].text.fr).not.toMatch(/0(,0)?\s%/);
            // and nothing unmeasured is ever amber or red
            if (u[key].state === 'unmeasured' || u[key].state === 'not_publishable') {
                expect(u[key].color).toBe('#64748b');
            }
        }
    });

    test('readiness is the assessed-only average and states its cohort', async () => {
        const f = await footerFor(
            [
                {
                    departmentId: 11,
                    unitName: 'Riverside / IT',
                    headcount: 36,
                    totalHeadcount: 36,
                    wholeDepartment: true,
                    withoutRequirements: 0,
                },
            ],
            [
                {
                    departmentId: 11,
                    expected: 1030,
                    assessed: 972,
                    avgReadiness: 81.9,
                    measuredPeople: 36,
                    scopedPeople: 36,
                    criticalExpected: 0,
                    criticalAssessed: 0,
                },
            ],
            [{ departmentId: 11, requiredCells: 1030, assessedCells: 972, metCells: 746 }]
        );
        const u = f.units[0];
        expect(u.d2Readiness.text.fr).toBe('81,9 % (sur 36 personnes mesurées sur 36)');
        expect(u.d1Coverage.text.fr).toBe('972/1030 (94,4 %) exigences évaluées');
        // met% is computed over the ASSESSED cells, not over all requirements:
        // 746/972 = 76,7 %, not 746/1030 = 72,4 %.
        expect(u.d3Met.text.fr).toBe('746/972 (76,7 %)');
    });

    test('the overall chip is the AGGREGATE ratio, not a mean of department percentages', async () => {
        const f = await footerFor(
            [
                {
                    departmentId: 11,
                    unitName: 'Riverside / IT',
                    headcount: 36,
                    totalHeadcount: 36,
                    wholeDepartment: true,
                    withoutRequirements: 0,
                },
                {
                    departmentId: 15,
                    unitName: 'Northfield / IT',
                    headcount: 1,
                    totalHeadcount: 1,
                    wholeDepartment: true,
                    withoutRequirements: 0,
                },
            ],
            [
                {
                    departmentId: 11,
                    expected: 1030,
                    assessed: 972,
                    avgReadiness: 81.9,
                    measuredPeople: 36,
                    scopedPeople: 36,
                    criticalExpected: 0,
                    criticalAssessed: 0,
                },
                {
                    departmentId: 15,
                    expected: 44,
                    assessed: 44,
                    avgReadiness: 52.3,
                    measuredPeople: 1,
                    scopedPeople: 1,
                    criticalExpected: 0,
                    criticalAssessed: 0,
                },
            ],
            [
                { departmentId: 11, requiredCells: 1030, assessedCells: 972, metCells: 746 },
                { departmentId: 15, requiredCells: 44, assessedCells: 44, metCells: 23 },
            ]
        );
        // 1016/1074 = 94,6 %. A mean of the two department percentages would be
        // (94,4 + 100) / 2 = 97,2 %, letting a 1-person unit weigh as much as 36.
        expect(f.totals.coverage.text.fr).toBe('1016/1074 (94,6 %)');
        expect(f.totals.contributingDepartments).toBe(2);
        // and the 1-person unit publishes no rate of its own
        expect(f.units[1].d2Readiness.state).toBe('not_publishable');
    });
});

// ---------------------------------------------------------------------------
// §2.6 / §2.7 — deltas
// ---------------------------------------------------------------------------

describe('an evolution is published only when it can be computed honestly', () => {
    test('no previous figure means "first measure", never a 0 and never an arrow', () => {
        const d = S.deltaOf(12, null, { metric: 'measuredPeople' });
        expect(d.state).toBe('first_measure');
        expect(d.value).toBe(null);
        expect(d.direction).toBeUndefined();
    });

    test('a value that was measured and no longer is reads "measure lost"', () => {
        expect(S.deltaOf(null, 12, { metric: 'measuredPeople' }).state).toBe('measure_lost');
    });

    test('a previous window of 0 yields no percentage — never an infinite one', () => {
        const d = S.deltaOf(5, 0, { metric: 'flowActions' });
        expect(d.state).toBe('value');
        expect(d.pct).toBe(null);
        expect(d.value).toBe(5);
    });

    test('below the materiality threshold it is "stable", with no arrow', () => {
        const d = S.deltaOf(80.2, 80.0, {
            metric: 'assessmentCoverage',
            materiality: 0.5,
            unit: 'pts',
        });
        expect(d.state).toBe('stable');
        expect(d.direction).toBe(null);
        expect(d.color).toBe(null);
    });

    test('the COLOUR follows the metric, not the sign', () => {
        // More measured people is good; more sole holders is not. Both are rises.
        expect(S.deltaOf(20, 10, { metric: 'measuredPeople' }).color).toBe('#15803d');
        expect(S.deltaOf(20, 10, { metric: 'soleHolder' }).color).toBe('#b45309');
        expect(S.deltaOf(5, 10, { metric: 'certsExpiring' }).color).toBe('#15803d');
        expect(S.METRIC_DIRECTION.soleHolder).toBe('lower_is_better');
    });

    test('an import batch suppresses the delta rather than reporting a surge', () => {
        const d = S.deltaOf(2710, 4, { metric: 'flowActions', suppress: 'import_batch' });
        expect(d.state).toBe('suppressed');
        expect(d.value).toBe(null);
    });

    test('"the same number of days back" is banned — the comparison is calendar', () => {
        expect(SRC).not.toMatch(/beforeDays/);
        expect(SRC).toMatch(/prevStart/);
        expect(SRC).toMatch(/prevDays/);
    });
});

describe('the scope signature is what makes two briefs comparable', () => {
    test('it is order-independent and stable', () => {
        expect(S.scopeSignature([3, 1, 2])).toBe(S.scopeSignature([1, 2, 3]));
        expect(S.scopeSignature([1, 2, 3])).toHaveLength(64);
    });

    test('unrestricted is a literal, not a hash of nothing', () => {
        expect(S.scopeSignature(null)).toBe('unrestricted');
    });

    test('one extra person changes it — which is what suppresses the delta', () => {
        // Somebody joining mid-period would otherwise have their PREVIOUS
        // manager's activity counted in their new manager's "before"; on a team
        // of three the difference between two briefs isolates them individually.
        expect(S.scopeSignature([1, 2, 3])).not.toBe(S.scopeSignature([1, 2, 3, 4]));
    });
});

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

describe('structural guards the next contributor must not undo', () => {
    test('no `|| 0` anywhere a value is rendered', () => {
        // `(r.readinessCoveragePct || 0) >= 80` turns "unknown" into "bad".
        const rendering = SRC.slice(
            SRC.indexOf('function cell('),
            SRC.indexOf('function _colorFor')
        );
        expect(rendering).not.toMatch(/\|\|\s*0\b/);
        expect(SRC).toMatch(/\?\?\s*null|\?\?\s*0/);
    });

    test('the colour is chosen AFTER the two null-ish states have already returned', () => {
        expect(CODE.match(/_colorFor\(/g)).toHaveLength(2); // the definition + one call
        const call = CODE.indexOf('_colorFor(n, thresholds)');
        const notPublishable = CODE.indexOf('STATES.NOT_PUBLISHABLE');
        const unmeasured = CODE.indexOf('STATES.UNMEASURED');
        expect(unmeasured).toBeGreaterThan(-1);
        expect(notPublishable).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(unmeasured);
        expect(call).toBeGreaterThan(notPublishable);
    });

    test('no Promise.all — a tick may share ONE pg client', () => {
        expect(CODE).not.toMatch(/Promise\.all/);
    });

    test('the service performs no notification I/O at all', () => {
        expect(CODE).not.toMatch(/NotificationService/);
        expect(CODE).not.toMatch(/EmailService/);
        expect(CODE).not.toMatch(/\benqueue\(/);
        expect(CODE).not.toMatch(/WebhookService/);
    });

    test('skill_assessments is never queried as a flow source, and the reason is written down', () => {
        expect(CODE).not.toMatch(/FROM skill_assessments/);
        expect(CODE).not.toMatch(/assessed_at/);
        expect(SRC).toMatch(/FORBIDDEN as a\s+\*?\s*flow source/);
    });

    test('every scoped query uses `= ANY(?)`, never an N-placeholder IN list', () => {
        expect(CODE).toMatch(/= ANY\(\?\)/);
        expect(CODE).not.toMatch(/map\(\(\)\s*=>\s*'\?'\)\.join/);
    });

    test('the enum traps are documented, and no query names a state that does not exist', () => {
        // dispute_state is open|resolved|escalated|auto_finalized — no 'closed'.
        // pip_state is proposed|approved|active|closed_success|closed_failure|
        // cancelled — no 'closed' either. `IN (…,'closed')` raises 22P02.
        expect(SRC).toMatch(/There is NO 'closed'/);
        expect(SRC).toMatch(/closed_success \/ closed_failure/);
        expect(CODE).not.toMatch(/'closed'/);
    });
});

// ---------------------------------------------------------------------------
// §0 prerequisite and migration 118
// ---------------------------------------------------------------------------

describe('the governance prerequisite is in place', () => {
    test('findGovernedIds filters manager_type on the manager_id branch', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/models/EmployeeModel.js'),
            'utf8'
        );
        const fn = src.slice(
            src.indexOf('async findGovernedIds('),
            src.indexOf('async findGoverned(')
        );
        // Without it, an employee whose id equals an admin id used as manager_id
        // inherits that admin's people — and they would appear in an email.
        expect(fn).toMatch(/manager_id = ANY\(\?\) AND manager_type = 'employee'/);
    });
});

describe('migration 118', () => {
    const SQL = fs.readFileSync(
        path.join(__dirname, '../../db/postgres/118_dept_brief.sql'),
        'utf8'
    );

    test('the ledger and the archive are ONE table, uniquely keyed', () => {
        expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS public\.dept_briefs/);
        expect(SQL).toMatch(/UNIQUE \(cadence, period, recipient_type, recipient_id\)/);
        // reminder_log is purged at 180 days, which would re-send a YEARLY brief
        // six months after it went out.
        expect(SQL).toMatch(/JAMAIS PURG/);
    });

    test('the cadence preference table is its own table, not a re-key of digest_subscriptions', () => {
        expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS public\.dept_brief_prefs/);
        expect(SQL).toMatch(/UNIQUE \(recipient_type, recipient_id, cadence\)/);
        expect(SQL).toMatch(/digest_subscriptions/);
    });

    test('met_pct now divides by the ASSESSED cells, not by all requirements', () => {
        expect(SQL).toMatch(/SUM\(g\.is_met\)\s*\/ NULLIF\(SUM\(g\.is_assessed\), 0\)/);
        expect(SQL).not.toMatch(/SUM\(g\.is_met\)\s*\/ NULLIF\(COUNT\(\*\), 0\)/);
    });

    test('the view keeps site_id and gains unmeasured_cells, and the DROP is not CASCADE', () => {
        expect(SQL).toMatch(/DROP VIEW IF EXISTS public\.v_department_matrix_completion;/);
        expect(SQL).not.toMatch(/DROP VIEW[^\n]*CASCADE/);
        expect(SQL).toMatch(/g\.site_id/);
        expect(SQL).toMatch(/AS unmeasured_cells/);
    });

    test('it stamps schema_meta like every other migration', () => {
        expect(SQL).toMatch(
            /INSERT INTO schema_meta\(key, value\) VALUES \('118_dept_brief', 'applied'\)/
        );
        expect(SQL).toMatch(
            /ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, applied_at = now\(\);/
        );
    });
});
