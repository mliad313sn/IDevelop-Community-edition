'use strict';
/**
 * NineBoxService.suggestPosition — the suggested tier must come from the
 * CANONICAL, coverage-aware readiness, and low coverage must read as
 * "non mesuré", never as "sous-performant".
 *
 * WHY THIS MATTERS MORE THAN A DASHBOARD CARD
 *   suggestPosition used to compute a fourth, stricter definition of its own:
 *   count-of-met over `skill_assessments`, with COALESCE(current_level, 0)
 *   turning every never-rated requirement into a failed one and ignoring
 *   approved self-assessments entirely. Tier 3 (lower) is the tier that
 *   auto-triggers a PIP, and it also feeds the DEI placement statistics — so
 *   somebody assessed on 3 of 47 skills was steered toward a performance plan
 *   by missing data.
 *
 * HARD CONSTRAINT: expectedSkills is the FULL department-designed requirement
 * count. Nothing here reduces, samples or filters the skills a role requires.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/EmployeeModel', () => ({
    findById: jest.fn(async (id) => ({ id, supervisorId: null, managerId: null })),
}));
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: () => true,
    isLocalAdmin: () => false,
    isViewer: () => false,
    canAccessEmployeeData: jest.fn(async () => true),
}));

const NineBoxService = require('../../src/services/NineBoxService');
const USER = { id: 1, userType: 'admin', role: 'superadmin' };

/** One row shaped like v_employee_assessment_coverage. */
const coverageRow = (o = {}) => ({
    readinessAssessedOnly: null,
    assessedSkills: 0,
    expectedSkills: 47,
    neverAssessedSkills: 47,
    coveragePct: 0,
    ...o,
});

/**
 * Wire db.get BY SQL TEXT, never by call order.
 *
 * This used to be two `mockResolvedValueOnce` calls, which silently bound the
 * coverage row to "whatever query runs first". The moment the service grew an
 * extra lookup ahead of them, the coverage row went to that one and every
 * assertion here read a default: expectedSkills 47 -> 0, readinessPct 81.8 ->
 * null, tier 3 -> 2. The test failed loudly, which was lucky; the same shape
 * can just as easily make a test PASS on the wrong row. Routing by SQL means
 * the number of lookups cannot change the answer.
 */
const arrange = (cov, delta = 0) => {
    mockDb.get.mockReset();
    mockDb.get.mockImplementation(async (sql) => {
        const s = String(sql);
        if (/v_employee_assessment_coverage/.test(s)) return cov;
        if (/assessment_history/.test(s)) return { delta };
        return undefined;
    });
};

/** The coverage query, wherever it landed among the calls. */
const coverageSql = () => {
    const call = mockDb.get.mock.calls.find((c) =>
        /v_employee_assessment_coverage/.test(String(c[0]))
    );
    expect(call).toBeDefined();
    return String(call[0]);
};

beforeEach(() => {
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({});
});

// ---------------------------------------------------------------------------
describe('NineBoxService.suggestPosition — low coverage is not under-performance', () => {
    test('nothing assessed → neutral middle tier, measured:false, "non mesuré"', async () => {
        arrange(coverageRow({}), 0);
        const s = await NineBoxService.suggestPosition(9, USER);
        // Tier 3 is the tier that opens a PIP. Missing data must never land there.
        expect(s.tier).toBe(2);
        expect(s.measured).toBe(false);
        expect(s.readinessPct).toBeNull();
        expect(s.rationale).toMatch(/Non mesuré/);
        expect(s.rationale).not.toMatch(/Tier 3/);
        // The department-designed count is reported WHOLE.
        expect(s.expectedSkills).toBe(47);
    });

    test('thin but real coverage → tier from the canonical readiness, flagged', async () => {
        arrange(
            coverageRow({
                readinessAssessedOnly: 81.8,
                assessedSkills: 5,
                expectedSkills: 44,
                neverAssessedSkills: 39,
                coveragePct: 11.4,
            }),
            2
        );
        const s = await NineBoxService.suggestPosition(9, USER);
        expect(s.readinessPct).toBe(81.8);
        expect(s.tier).toBe(1);
        expect(s.measured).toBe(true);
        expect(s.lowCoverage).toBe(true);
        expect(s.rationale).toMatch(/5 \/ 44 exigences évaluées/);
        expect(s.rationale).toMatch(/Couverture faible/);
    });

    test('full coverage, weak performance → lower tier, unflagged', async () => {
        arrange(
            coverageRow({
                readinessAssessedOnly: 20,
                assessedSkills: 44,
                expectedSkills: 44,
                neverAssessedSkills: 0,
                coveragePct: 100,
            }),
            -3
        );
        const s = await NineBoxService.suggestPosition(9, USER);
        expect(s.tier).toBe(3);
        expect(s.measured).toBe(true);
        expect(s.lowCoverage).toBe(false);
        expect(s.trend).toBe('down');
    });

    test('it no longer derives its own readiness from skill_assessments', async () => {
        arrange(coverageRow({}), 0);
        await NineBoxService.suggestPosition(9, USER);
        const sql = coverageSql();
        expect(sql).toMatch(/FROM v_employee_assessment_coverage/);
        expect(sql).not.toMatch(/skill_assessments/);
    });
});
