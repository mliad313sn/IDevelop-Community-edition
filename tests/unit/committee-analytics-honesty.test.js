'use strict';
/**
 * Committee SECTION campaigns (analytics) — THE product rule: an ABSENCE OF MEASUREMENT is
 * never presented as a RESULT. Each block guards one finding, in the canonical
 * pattern the codebase already uses (ReadinessService: readinessPercent = null
 * when nothing was assessed + a separate never-assessed bucket;
 * v_employee_assessment_coverage.readiness_assessed_only; BenchmarkModel
 * occupants gated on is_assessed; dash:rd_not_measured for the UI).
 *
 *   F1  BenchmarkModel.getRoleCandidates    fit over assessed requirements only, NULL when none
 *   F2  CopilotService                      canonical readiness; nobody NAMED weakest on zero measurement
 *   F3  ContinuityService.readinessForRole  assessed-only pct, gap current: null, unmeasured count, coverage-floored band
 *   F5  DevelopmentTriggerService           coaching action never says "from level null"
 *   F6  DeptAnalyticsController burndown    the launch-stamped roster is the denominator
 *   F8  ReportController.getReadinessCategory  null → 'Not measured', never 'Very Poor'
 *   F9  DeptAnalyticsController completion  met% over ASSESSED cells; unmeasured cells are their own series
 *   F12 DashboardModel rolesAtRisk          a role nobody measured is unmeasured, not at risk
 *   F14 ReportController.generateGapsCSV    no '0.00' average on zero affected; never-assessed column
 *
 * DB mocked throughout; the live before/after numbers are in the rolled-back
 * probe recorded with the fix.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockRbac = {
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'localadmin'),
    isViewer: () => false,
    hasPermission: (u, slug) =>
        Boolean(
            u &&
            u.userType === 'admin' &&
            (u.role === 'superadmin' || (u.permissions || []).includes(slug))
        ),
    getFilteredEmployees: jest.fn(async () => []),
    canAccessEmployeeData: async () => true,
};
jest.mock('../../src/services/RBACService', () => mockRbac);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn() }));

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const lastSql = (fn) => String(fn.mock.calls[fn.mock.calls.length - 1][0]);
const mockRes = () => {
    const r = { code: 200 };
    r.status = (c) => {
        r.code = c;
        return r;
    };
    r.json = (b) => {
        r.body = b;
        return r;
    };
    return r;
};

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockRbac.getFilteredEmployees.mockReset().mockResolvedValue([]);
});

// ===========================================================================
// F1 — BenchmarkModel.getRoleCandidates
// ===========================================================================
describe('F1 getRoleCandidates: fit is over ASSESSED requirements, NULL when none', () => {
    const BenchmarkModel = require('../../src/models/BenchmarkModel');

    test('the fit numerator and denominator are both gated on the resolved level IS NOT NULL', async () => {
        await BenchmarkModel.getRoleCandidates(162, {}, 5);
        const sql = lastSql(mockDb.all);
        // numerator: only assessed rows contribute LEAST(effective, required)
        expect(sql).toMatch(/SUM\(CASE WHEN sa\.level IS NOT NULL\s+THEN LEAST\(/);
        // denominator: only the assessed requirements' points, NULL (not 0) when none
        expect(sql).toMatch(
            /NULLIF\(SUM\(CASE WHEN sa\.level IS NOT NULL THEN req\.required_level END\), 0\)/
        );
        // the fabrication: an absent level folded in as 0 over the FULL requirement set
        expect(sql).not.toMatch(/COALESCE\(sa\.(current_)?level, 0\)/);
        // and it reads the RESOLVED view, so approved self-assessments count
        expect(sql).toMatch(/v_resolved_assessments sa/);
    });

    test('gap_skills and crit_gap_skills count MEASURED shortfalls only', async () => {
        await BenchmarkModel.getRoleCandidates(162, {}, 5);
        const sql = lastSql(mockDb.all);
        const gapFilters = sql.match(/COUNT\(\*\) FILTER \(WHERE[^)]*sa\.level IS NOT NULL/g) || [];
        expect(gapFilters.length).toBeGreaterThanOrEqual(2);
        expect(sql).toMatch(/AS gap_skills/);
        expect(sql).toMatch(/AS crit_gap_skills/);
    });

    test('coverage travels with the fit; the department-designed count is untouched', async () => {
        await BenchmarkModel.getRoleCandidates(162, {}, 5);
        const sql = lastSql(mockDb.all);
        expect(sql).toMatch(/COUNT\(\*\)::int AS req_skills/);
        expect(sql).toMatch(/AS assessed_skills/);
        expect(sql).toMatch(/AS unmeasured_skills/);
        expect(sql).toMatch(/AS coverage/);
        // still the full requirement set — nothing sampled
        expect(sql).toMatch(/rsr\.required_level > 0/);
    });

    test('the drill-through says "not measured" instead of a red 1 % bar, with the coverage beside the fit', () => {
        const view = read('views/pages/benchmark/role.ejs');
        expect(view).toMatch(
            /if \(v==null\) \{ %><span class="bm-nodata" title="<%= __\('dash:rd_not_measured_title'\) %>"><%= __\('dash:rd_not_measured'\) %><\/span>/
        );
        expect(view).toMatch(
            /<%= cAssessed %> \/ <%= cReq %> <%= __\('dash:bm_cand_coverage_suffix'\) %>/
        );
        // the old always-drawn bar (width 0 for null) is gone
        expect(view).not.toMatch(/style="width:<%= v==null\?0:v %>%;"/);
        for (const lang of ['fr', 'en']) {
            const bag = JSON.parse(read(`locales/${lang}/dash.json`));
            expect(bag.bm_cand_coverage_suffix).toBeTruthy();
            expect(bag.bm_cand_gaps_measured_title).toBeTruthy();
        }
    });
});

// ===========================================================================
// F2 — CopilotService
// ===========================================================================
describe('F2 CopilotService: canonical readiness, coverage in every answer, no name on zero measurement', () => {
    let CopilotService;
    const people = [
        { id: 1, firstName: 'Never', lastName: 'Assessed' },
        { id: 2, firstName: 'Low', lastName: 'Measured' },
        { id: 3, firstName: 'High', lastName: 'Measured' },
    ];
    beforeEach(() => {
        CopilotService = require('../../src/services/CopilotService');
        mockRbac.getFilteredEmployees.mockResolvedValue(people);
        mockDb.all.mockImplementation(async (sql) => {
            const s = String(sql);
            if (/readiness_assessed_only AS pct/.test(s)) {
                // ORDER BY … ASC NULLS LAST — the unmeasured person is LAST, pct null
                return [
                    { fullName: 'Low Measured', pct: 40, assessed: 4, expected: 10, coverage: 40 },
                    {
                        fullName: 'High Measured',
                        pct: 90,
                        assessed: 10,
                        expected: 10,
                        coverage: 100,
                    },
                    {
                        fullName: 'Never Assessed',
                        pct: null,
                        assessed: 0,
                        expected: 10,
                        coverage: 0,
                    },
                ];
            }
            if (/AS shortfall/.test(s)) return [{ skill: 'Blasting', shortfall: 2, unmeasured: 1 }];
            if (/NOT EXISTS \(SELECT 1 FROM skill_assessments/.test(s)) return [{ n: 1 }];
            if (/GROUP BY st\.name/.test(s))
                return [{ site: 'Westbrook', pct: 65, people: 3, measured: 2, coverage: 47 }];
            return [];
        });
    });

    test('readiness is read from v_employee_assessment_coverage.readiness_assessed_only, not recomputed over the full set', async () => {
        await CopilotService.buildContext(SUPER);
        const sqls = mockDb.all.mock.calls.map((c) => String(c[0]));
        expect(
            sqls.some(
                (s) =>
                    /readiness_assessed_only AS pct/.test(s) &&
                    /v_employee_assessment_coverage/.test(s)
            )
        ).toBe(true);
        // the fabrication is gone from every readiness query
        expect(
            sqls.some((s) => /COALESCE\(sa\.current_level,0\) >= rsr\.required_level/.test(s))
        ).toBe(false);
    });

    test('the average is over MEASURED people, the never-assessed are their own count', async () => {
        const ctx = await CopilotService.buildContext(SUPER);
        expect(ctx.avgReadinessPct).toBe(65); // (40 + 90) / 2, NOT (40 + 90 + 0) / 3
        expect(ctx.measuredCount).toBe(2);
        expect(ctx.neverAssessed).toBe(1);
        expect(ctx.coverage).toEqual({ assessed: 14, expected: 30, pct: 46.7 });
    });

    test('nobody is NAMED weakest on zero measurement, and every name carries its coverage', async () => {
        const ctx = await CopilotService.buildContext(SUPER);
        const named = ctx.lowestReadiness.map((r) => r.name);
        expect(named).not.toContain('Never Assessed');
        expect(ctx.lowestReadiness[0]).toEqual({
            name: 'Low Measured',
            pct: 40,
            assessed: 4,
            expected: 10,
            coveragePct: 40,
        });
        for (const q of ['who needs development first?', 'readiness']) {
            // Named answers are opt-in (copilot.allow_named_person_ranking); this
            // test is about HOW names are shown when they are allowed.
            const a = CopilotService._deterministic(q, ctx, { allowNamedPersonRanking: true });
            expect(a).not.toMatch(/Never Assessed/);
            expect(a).toMatch(/4\/10 assessed/);
            expect(a).toMatch(/1 of your 3 people have no assessed requirement/);
        }
    });

    test('nothing measured at all → no average, no names, said plainly', async () => {
        mockDb.all.mockImplementation(async (sql) =>
            /readiness_assessed_only AS pct/.test(String(sql))
                ? [
                      {
                          fullName: 'Never Assessed',
                          pct: null,
                          assessed: 0,
                          expected: 10,
                          coverage: 0,
                      },
                  ]
                : []
        );
        const ctx = await CopilotService.buildContext(SUPER);
        expect(ctx.avgReadinessPct).toBeNull();
        expect(ctx.lowestReadiness).toEqual([]);
        expect(CopilotService._deterministic('who needs development first?', ctx)).toMatch(
            /No readiness data yet/
        );
    });

    test('top gaps are MEASURED shortfalls with the unmeasured count beside them; by-site carries measured/coverage', async () => {
        const ctx = await CopilotService.buildContext(SUPER);
        const gapSql = mockDb.all.mock.calls
            .map((c) => String(c[0]))
            .find((s) => /AS shortfall/.test(s));
        expect(gapSql).toMatch(
            /sa\.current_level IS NOT NULL AND rsr\.required_level > sa\.current_level/
        );
        expect(gapSql).toMatch(
            /COUNT\(\*\) FILTER \(WHERE sa\.current_level IS NULL\) AS unmeasured/
        );
        expect(gapSql).not.toMatch(/COALESCE\(sa\.current_level,0\)/);
        expect(CopilotService._deterministic('top skill gaps', ctx)).toMatch(
            /Blasting \(2 measured short, 1 not measured\)/
        );
        expect(ctx.bySite[0]).toEqual({
            site: 'Westbrook',
            pct: 65,
            people: 3,
            measured: 2,
            coveragePct: 47,
        });
        expect(CopilotService._deterministic('readiness by site', ctx)).toMatch(
            /Westbrook 65% \(2 of 3 measured, coverage 47%\)/
        );
    });
});

// ===========================================================================
// F3 — ContinuityService readiness against a target role
// ===========================================================================
describe('F3 ContinuityService.readinessForRole / seedSuccessors: assessed-only, null when unmeasured', () => {
    const ContinuityService = require('../../src/services/ContinuityService');
    // 4 requirements: two met, one measured gap, one NEVER assessed.
    const rows = [
        { skillId: 1, skillName: 'A', required: 3, assessedLevel: 3, current: 3 },
        { skillId: 2, skillName: 'B', required: 2, assessedLevel: 2, current: 2 },
        { skillId: 3, skillName: 'C', required: 4, assessedLevel: 2, current: 2 },
        { skillId: 4, skillName: 'D', required: 4, assessedLevel: null, current: null },
    ];

    test('pct is over the ASSESSED requirements only; the unmeasured one is a current:null gap and its own count', async () => {
        mockDb.all.mockResolvedValue(rows);
        const r = await ContinuityService.readinessForRole(158, 87);
        expect(r.pct).toBe(78); // (3+2+2)/(3+2+4) = 7/9 → 78, NOT (7)/(13) = 54
        expect(r.assessed).toBe(3);
        expect(r.unmeasured).toBe(1);
        expect(r.required).toBe(4); // the department-designed count, whole
        expect(r.coveragePct).toBe(75);
        expect(r.gaps).toEqual([
            { skillId: 3, skillName: 'C', required: 4, current: 2 },
            { skillId: 4, skillName: 'D', required: 4, current: null }, // never 0
        ]);
        expect(r.gaps.some((g) => g.current === 0)).toBe(false);
    });

    test('nothing assessed → pct null (not 0), every requirement listed as current:null', async () => {
        mockDb.all.mockResolvedValue(
            rows.map((x) => ({ ...x, assessedLevel: null, current: null }))
        );
        const r = await ContinuityService.readinessForRole(286, 87);
        expect(r.pct).toBeNull();
        expect(r.unmeasured).toBe(4);
        expect(r.gaps).toHaveLength(4);
        expect(r.gaps.every((g) => g.current === null)).toBe(true);
    });

    test('the SQL reads the raw assessment as assessed_level and no longer coalesces an absent level to 0', async () => {
        mockDb.all.mockResolvedValue([]);
        await ContinuityService.readinessForRole(1, 2);
        const sql = lastSql(mockDb.all);
        expect(sql).toMatch(/sa\.level AS assessed_level/);
        expect(sql).not.toMatch(/COALESCE\(sa\.(current_)?level, 0\)/);
        expect(sql).toMatch(/rsr\.required_level > 0/);
        // the RESOLVED view, so an approved self-assessment is visible here
        expect(sql).toMatch(/v_resolved_assessments sa/);
    });

    test('a lapsed certificate degrades the LEVEL, not the fact of measurement', async () => {
        mockDb.all.mockResolvedValue([
            { skillId: 9, skillName: 'Ticket', required: 3, assessedLevel: 3, current: 0 },
        ]);
        const r = await ContinuityService.readinessForRole(1, 2);
        expect(r.assessed).toBe(1);
        expect(r.pct).toBe(0); // measured and failing — a REAL 0
        expect(r.gaps).toEqual([{ skillId: 9, skillName: 'Ticket', required: 3, current: 0 }]);
    });

    test('band comes from the assessed-only readiness with a coverage floor for Ready-Now', () => {
        expect(ContinuityService.bandFromReadiness(91, 81)).toBe('ready_now'); // the live case (emp 158)
        // T2: both ready bands now need coverage. 100 % on 20 % coverage is below
        // the ready_1_2y floor (50 %) too, so it drops to ready_3y, not ready_1_2y.
        expect(ContinuityService.bandFromReadiness(100, 20)).toBe('ready_3y');
        expect(ContinuityService.bandFromReadiness(74, 100)).toBe('ready_1_2y');
        expect(ContinuityService.bandFromReadiness(null)).toBe('ready_3y');
        expect(ContinuityService.READY_NOW_COVERAGE_FLOOR).toBe(80);
    });

    test('seedSuccessors never benches a candidate on zero measurement and writes current:null for the unmeasured', async () => {
        mockDb.get.mockResolvedValue({ positionRoleId: 87, incumbentEmployeeId: 9999 });
        mockDb.all.mockResolvedValue([
            // candidate 158: 3 assessed of 4 → 78 %
            ...rows.map((x) => ({ employeeId: 158, ...x })),
            // candidate 286: nothing assessed
            ...rows.map((x) => ({ employeeId: 286, ...x, assessedLevel: null, current: null })),
        ]);
        const inserted = [];
        mockDb.run.mockImplementation(async (_sql, p) => {
            inserted.push(p);
        });
        const out = await ContinuityService.seedSuccessors(1, [158, 286], {
            floorPct: 0,
            limit: 10,
        });
        expect(out).toEqual({ added: 1, unmeasuredCandidates: 1 });
        expect(inserted).toHaveLength(1);
        const [, empId, band, rank, confidence, gapSummary] = inserted[0];
        expect(empId).toBe(158);
        expect(band).toBe('ready_1_2y');
        expect(rank).toBe(1);
        // T6: confidence is fit × coverage, not fit alone. 78 % on 3-of-4 (75 %
        // coverage) → 0.78 × 0.75 = 0.585, not the old 0.780.
        expect(confidence).toBe('0.585');
        const gaps = JSON.parse(gapSummary);
        expect(gaps.find((g) => g.skillId === 4)).toEqual({
            skillId: 4,
            skillName: 'D',
            required: 4,
            current: null,
        });
        expect(gaps.some((g) => g.current === 0)).toBe(false);
        const sql = lastSql(mockDb.all);
        expect(sql).toMatch(/sa\.level AS assessed_level/);
        expect(sql).not.toMatch(/COALESCE\(sa\.(current_)?level, 0\)/);
        expect(sql).toMatch(/v_resolved_assessments sa/);
    });

    test('a manual nomination of a never-assessed candidate stores confidence NULL, never "0.000"', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM succession_plans/.test(String(sql)) ? { positionRoleId: 87 } : { id: 5 }
        );
        mockDb.all.mockResolvedValue(
            rows.map((x) => ({ ...x, assessedLevel: null, current: null }))
        );
        await ContinuityService.addSuccessor(1, 286, null);
        const insert = mockDb.get.mock.calls.find((c) =>
            /INSERT INTO successors/.test(String(c[0]))
        );
        expect(insert).toBeTruthy();
        const [, , band, confidence] = insert[1];
        expect(band).toBe('ready_3y');
        expect(confidence).toBeNull();
    });
});

// ===========================================================================
// F5 — coaching action wording
// ===========================================================================
describe('F5 DevelopmentTriggerService: a coaching action never says "from level null"', () => {
    // MIS À JOUR (UAT3 passe 2, P2-03) — INTENTION INCHANGÉE.
    // Ce bloc épinglait les littéraux ANGLAIS écrits en dur dans
    // `createSupportCoaching`. Ces littéraux étaient précisément le défaut :
    // le plan de coaching créé avec le PIP arrivait en anglais sur une session
    // française, et `/api/coaching/mine` rendait des octets identiques en FR et
    // en EN. Le texte vient désormais de `COACHING_PIP_TEMPLATES`, indexé par
    // locale. La garde F5 est donc vérifiée sur les DEUX gabarits, par exécution
    // du vrai constructeur d'action plutôt que par regex sur un littéral : une
    // absence de mesure ne se rend jamais « from level null » / « du niveau null ».
    const DTS = require('../../src/services/DevelopmentTriggerService');
    const src = read('src/services/DevelopmentTriggerService.js');
    const tplSrc = src.slice(
        src.indexOf('const COACHING_PIP_TEMPLATES'),
        src.indexOf('function planLocale')
    );
    const coaching = src.slice(
        src.indexOf('const tpl = COACHING_PIP_TEMPLATES'),
        src.indexOf('coachingPlanId = plan.id')
    );

    // Le module n'exporte pas les gabarits : on les relit depuis la source, de la
    // même manière que ce fichier lit déjà le service.
    const TPL = new Function(`${tplSrc}; return COACHING_PIP_TEMPLATES;`)(); // eslint-disable-line no-new-func

    test('an unmeasured starting point is stated as unmeasured, in BOTH languages', () => {
        expect(TPL.en.action({ skillName: 'X', current: null, required: 2 })).toBe(
            'Reach level 2 in "X" (current level not assessed)'
        );
        expect(TPL.fr.action({ skillName: 'X', current: null, required: 2 })).toBe(
            'Atteindre le niveau 2 en « X » (niveau actuel non évalué)'
        );
        for (const lng of ['fr', 'en']) {
            expect(TPL[lng].action({ skillName: 'X', current: null, required: 2 })).not.toMatch(
                /null/
            );
            expect(TPL[lng].action({ skillName: 'X', current: null, required: 2 })).not.toMatch(
                /level 0|niveau 0/
            );
        }
    });

    test('a measured starting point still carries the two real levels', () => {
        expect(TPL.en.action({ skillName: 'X', current: 1, required: 2 })).toBe(
            'Develop "X" from level 1 to 2'
        );
        expect(TPL.fr.action({ skillName: 'X', current: 1, required: 2 })).toBe(
            'Développer « X » du niveau 1 au niveau 2'
        );
    });

    test('measured gaps are ordered first', () => {
        expect(coaching).toMatch(
            /\.sort\(\(a, b\) => \(a\.current == null \? 1 : 0\) - \(b\.current == null \? 1 : 0\)\)/
        );
    });

    test('the plan text is taken from the locale-keyed template, not a hard-coded literal', () => {
        expect(coaching).toMatch(/title: tpl\.title/);
        expect(coaching).toMatch(/objective: tpl\.objective/);
        expect(coaching).toMatch(/description: tpl\.action\(g\)/);
        expect(typeof DTS.createSupportCoaching).toBe('function');
    });
});

// ===========================================================================
// F6 + F9 — DeptAnalyticsController
// ===========================================================================
describe('F6 campaignBurndown: the launch-stamped roster is the denominator', () => {
    const DA = require('../../src/controllers/DeptAnalyticsController');

    test('it aggregates v_cycle_participant_status LEFT-joined to departments, never self_assessments rows', async () => {
        mockDb.get.mockResolvedValue({
            id: 9,
            code: '2026-Q3',
            label: '2026-Q3',
            closesAt: '2999-01-01',
            status: 'locked',
        });
        mockDb.all.mockResolvedValue([
            {
                siteName: 'Riverside',
                departmentId: 1,
                departmentName: 'Internal Audit',
                enrolled: 5,
                participants: 5,
                excluded: 0,
                approved: 0,
                inReview: 0,
                inProgress: 0,
                notStarted: 5,
                unsubmitted: 5,
                completionPct: 0,
            },
            {
                siteName: 'Riverside',
                departmentId: 2,
                departmentName: 'Finance',
                enrolled: 0,
                participants: 0,
                excluded: 0,
                approved: 0,
                inReview: 0,
                inProgress: 0,
                notStarted: 0,
                unsubmitted: 0,
                completionPct: null,
            },
        ]);
        const res = mockRes();
        await DA.campaignBurndown({ user: SUPER, query: { cycleId: '9' } }, res);
        const sql = lastSql(mockDb.all);
        expect(sql).toMatch(/FROM departments d/);
        expect(sql).toMatch(/LEFT JOIN v_cycle_participant_status v/);
        expect(sql).not.toMatch(/FROM self_assessments/);
        // completion = submitted people / enrolled people, NULL when nobody is enrolled
        expect(sql).toMatch(
            /participant_state IN \('in_review','approved'\)\)\s*\/ NULLIF\(COUNT\(v\.employee_id\) FILTER \(WHERE v\.participant_state <> 'excluded'\), 0\)/
        );
        // a department nobody moved in is 0 %; one never launched says so
        const [audit, finance] = res.body.departments;
        expect(audit.completionPct).toBe(0);
        expect(audit.launched).toBe(true);
        expect(finance.completionPct).toBeNull();
        expect(finance.launched).toBe(false);
    });

    test('a scoped caller only sees the departments of the people they govern', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        jest.doMock('../../src/models/EmployeeModel', () => ({
            findGovernedIds: async () => [11, 12],
        }));
        const Scoped = require('../../src/controllers/DeptAnalyticsController');
        mockDb.get.mockResolvedValue({ id: 9, closesAt: '2999-01-01' });
        await Scoped.campaignBurndown(
            { user: { id: 137, userType: 'manager' }, query: {} },
            mockRes()
        );
        const [sql, params] = mockDb.all.mock.calls[mockDb.all.mock.calls.length - 1];
        expect(sql).toMatch(
            /d\.id IN \(SELECT ed\.department_id FROM v_employee_details ed WHERE 1 = 1 AND ed\.employee_id IN \(\?,\?\)\)/
        );
        expect(sql).toMatch(/v\.cycle_id = \? AND v\.employee_id IN \(\?,\?\)/);
        expect(params).toEqual([11, 12, 9, 11, 12]);
    });

    test('the burndown tooltip says "not launched" for a NULL completion instead of a dash or a percentage', () => {
        const view = read('views/pages/reports/dept-analytics.ejs');
        expect(view).toMatch(
            /if \(d\.launched === false \|\| d\.completionPct == null\) return T\.notLaunched;/
        );
        expect(view).toMatch(
            /notLaunched: <%- JSON\.stringify\(__\('compliance:da_c_not_launched'\)\) %>/
        );
        for (const lang of ['fr', 'en']) {
            const bag = JSON.parse(read(`locales/${lang}/compliance.json`));
            expect(bag.da_c_not_launched).toBeTruthy();
            expect(bag.da_c_not_started).toBeTruthy();
            expect(bag.da_c_enrolled).toBeTruthy();
        }
    });
});

describe('F9 departmentCompletion: met % over ASSESSED cells; unmeasured cells are their own series', () => {
    const DA = require('../../src/controllers/DeptAnalyticsController');

    test('metPct divides by the assessed cells (NULL when none) and the unmeasured cells are returned', async () => {
        await DA.departmentCompletion({ user: SUPER, query: {} }, mockRes());
        const sql = lastSql(mockDb.all);
        expect(sql).toMatch(
            /SUM\(g\.is_met\)\s+\/ NULLIF\(SUM\(g\.is_assessed\), 0\), 1\)::float AS "metPct"/
        );
        expect(sql).not.toMatch(/SUM\(g\.is_met\)\s+\/ NULLIF\(COUNT\(\*\), 0\)/);
        expect(sql).toMatch(/\(COUNT\(\*\) - SUM\(g\.is_assessed\)\)::int AS "unmeasuredCells"/);
        expect(sql).toMatch(/AS "unmeasuredPct"/);
    });

    test('the chart plots the unmeasured share as its own dataset labelled dash:rd_not_measured and skips a NULL met bar', () => {
        const view = read('views/pages/reports/dept-analytics.ejs');
        expect(view).toMatch(/notMeasured: <%- JSON\.stringify\(__\('dash:rd_not_measured'\)\) %>/);
        expect(view).toMatch(
            /\{ label: T\.notMeasured, data: data\.departments\.map\(d => d\.unmeasuredPct\)/
        );
        expect(view).toMatch(
            /data: data\.departments\.map\(d => \(d\.metPct == null \? null : d\.metPct\)\)/
        );
    });
});

// ===========================================================================
// F8 + F14 — ReportController
// ===========================================================================
describe('F8 / F14 ReportController: Power BI bands and the gap CSV', () => {
    let ReportController;
    const mockReadiness = { getOrganizationalReadiness: jest.fn() };
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        jest.doMock('../../src/services/RBACService', () => mockRbac);
        jest.doMock('../../src/services/ReadinessService', () => mockReadiness);
        jest.doMock('../../src/models/EmployeeModel', () => ({}));
        jest.doMock('../../src/services/ReportBuilderService', () => ({ excelCsv: (b) => b }));
        jest.doMock('../../src/services/ReportDataService', () => ({}));
        ReportController = require('../../src/controllers/ReportController');
    });

    test('getReadinessCategory(null) is a distinct "Not measured", never the bottom band', () => {
        expect(ReportController.getReadinessCategory(null)).toBe('Not measured');
        expect(ReportController.getReadinessCategory(undefined)).toBe('Not measured');
        expect(ReportController.getReadinessCategory(0)).toBe('Very Poor (0-20%)'); // a REAL measured 0 keeps its band
        expect(ReportController.getReadinessCategory(85)).toBe('Excellent (80-100%)');
    });

    test('the Power BI feed emits SkillsNotMet NULL and "Not measured" for a never-assessed employee', async () => {
        const emp = {
            id: 7,
            employeeNumber: 'E7',
            firstName: 'Never',
            lastName: 'Assessed',
            roleName: 'Auditor',
        };
        mockReadiness.getOrganizationalReadiness.mockResolvedValue({
            readinessData: [
                {
                    employee: emp,
                    totalRequired: 152,
                    skillsMet: 0,
                    skillsNotMet: 152,
                    criticalSkillsMet: 0,
                    criticalSkillsTotal: 40,
                    readinessPercent: null,
                    assessedRequired: 0,
                    neverAssessedRequired: 152,
                    coveragePercent: 0,
                    isReady: false,
                },
                {
                    employee: { ...emp, id: 8 },
                    totalRequired: 10,
                    skillsMet: 9,
                    skillsNotMet: 1,
                    criticalSkillsMet: 2,
                    criticalSkillsTotal: 2,
                    readinessPercent: 92.5,
                    assessedRequired: 10,
                    neverAssessedRequired: 0,
                    coveragePercent: 100,
                    isReady: true,
                },
            ],
        });
        const res = mockRes();
        await ReportController.powerbIReadiness(
            { user: SUPER, protocol: 'http', get: () => 'h' },
            res
        );
        const [never, measured] = res.body.value;
        expect(never.ReadinessCategory).toBe('Not measured');
        expect(never.ReadinessStatus).toBe('Not measured');
        expect(never.SkillsNotMet).toBeNull();
        expect(never.SkillsMet).toBeNull();
        expect(never.IsReady).toBeNull();
        expect(never.NeverAssessedSkills).toBe(152);
        expect(never.TotalRequiredSkills).toBe(152); // the requirement count is never hidden
        expect(measured.ReadinessCategory).toBe('Excellent (80-100%)');
        expect(measured.SkillsNotMet).toBe(1);
        expect(measured.IsReady).toBe(true);
    });

    test('the gap CSV leaves the average blank on zero affected and adds the never-assessed column', () => {
        const gap = {
            skillId: 3,
            skillName: 'Blasting',
            domainName: 'Ops',
            requiredLevel: 3,
            isCritical: true,
            employeesAffected: 0,
            totalGap: 0,
        };
        const readinessData = [
            { gaps: [{ skillId: 3, requiredLevel: 3, isCritical: true, isAssessed: false }] },
            { gaps: [{ skillId: 3, requiredLevel: 3, isCritical: true, isAssessed: false }] },
            {
                gaps: [
                    { skillId: 3, requiredLevel: 3, isCritical: true, isAssessed: true, gap: 1 },
                ],
            },
        ];
        const csv = ReportController.generateGapsCSV([gap], readinessData);
        const [header, row] = csv.split('\n');
        expect(header).toMatch(/"Employees Never Assessed"$/);
        expect(row).toBe('"Blasting","Ops","3","Yes","0","","2"');
        expect(row).not.toMatch(/0\.00/);
        // a measured gap still averages
        const row2 = ReportController.generateGapsCSV(
            [{ ...gap, employeesAffected: 2, totalGap: 3 }],
            []
        ).split('\n')[1];
        expect(row2).toBe('"Blasting","Ops","3","Yes","2","1.50","0"');
    });
});

// ===========================================================================
// F12 — DashboardModel roles at risk
// ===========================================================================
describe('F12 DashboardModel: a role nobody measured is unmeasured, not at risk', () => {
    const DashboardModel = require('../../src/models/DashboardModel');

    test('roles_at_risk requires at least one measured occupant; the unmeasured roles are their own count', async () => {
        mockDb.get.mockResolvedValue({});
        await DashboardModel.getOverviewKPIs({});
        const sql = lastSql(mockDb.get);
        expect(sql).toMatch(
            /HAVING SUM\(CASE WHEN is_role_ready = 1 THEN 1 ELSE 0 END\) <= 1\s+AND COUNT\(readiness_assessed_only\) > 0/
        );
        expect(sql).toMatch(
            /roles_unmeasured AS \(\s*SELECT role_name\s+FROM base\s+GROUP BY role_name\s+HAVING COUNT\(readiness_assessed_only\) = 0/
        );
        expect(sql).toMatch(/\(SELECT COUNT\(\*\) FROM roles_unmeasured\) as rolesUnmeasured/);
    });

    test('the staffing table gives an unmeasured role isRisk 0 and isUnmeasured 1', async () => {
        await DashboardModel.getRoleStaffing({});
        const sql = lastSql(mockDb.all);
        expect(sql).toMatch(
            /CASE WHEN COUNT\(c\.readiness_assessed_only\) = 0 THEN 0\s+WHEN SUM\(CASE WHEN c\.readiness_assessed_only >= 80 THEN 1 ELSE 0 END\) <= 1 THEN 1 ELSE 0 END as isRisk/
        );
        expect(sql).toMatch(
            /CASE WHEN COUNT\(c\.readiness_assessed_only\) = 0 THEN 1 ELSE 0 END as isUnmeasured/
        );
    });

    test('the KPI card renders the unmeasured roles with dash:rd_not_measured, outside the risk count', () => {
        const js = read('public/js/dashboard.js');
        // A8: the card now prefers the KPI-query rolesAtRisk (is_role_ready, measured
        // occupants — the same value persisted to the trend), and only falls back to
        // the staffing derivation, which likewise excludes the unmeasured roles.
        const jsFlat = js.replace(/\s+/g, ' ');
        expect(jsFlat).toMatch(
            /const riskCount = kpis\.rolesAtRisk != null \? num\(kpis\.rolesAtRisk, 0\) : staffing\.filter\(\(r\) => r\.isRisk && !r\.isUnmeasured\)\.length;/
        );
        const card = js.slice(
            js.indexOf("I18N.kpiRolesAtRisk || 'Roles at Risk'"),
            js.indexOf("I18N.kpiRolesAtRisk || 'Roles at Risk'") + 900
        );
        expect(card).toMatch(/I18N\.rdNotMeasured \|\| 'Not measured'/);
        expect(card).toMatch(/I18N\.rdNotMeasuredTitle/);
        expect(card).toMatch(/unmeasuredRoles > 0/);
        // and the staffing table's Risk column says "not measured" instead of a ✓
        expect(js).toMatch(
            /row && row\.isUnmeasured\s*\?[\s\S]*I18N\.rdNotMeasured \|\| 'Not measured'/
        );
    });
});
