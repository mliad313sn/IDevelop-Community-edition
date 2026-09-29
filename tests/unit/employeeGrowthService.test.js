'use strict';

/**
 * Employee growth — the pure logic behind "my gap against my target role",
 * "roles I'm closest to" and "suggested learning for my gaps".
 *
 * The rule under test everywhere: an UNMEASURED requirement is neither a level
 * 0 nor a gap. Readiness is over the measured requirements only (null when none
 * is measured) and the denominators travel with it.
 */

jest.mock('../../src/config/database', () => ({}));

const {
    summariseRoleGap,
    rankClosestRoles,
    learningSuggestions,
    safeUrl,
    THIN_EVIDENCE_COVERAGE,
} = require('../../src/services/EmployeeGrowthService');

const row = (skillName, required, current, { assessed = true, critical = false } = {}) => ({
    skillName,
    domainName: 'D',
    required,
    current: assessed ? current : null,
    isAssessed: assessed ? 1 : 0,
    isCritical: critical ? 1 : 0,
});

describe('summariseRoleGap — my gap against my target role', () => {
    test('splits met, to grow and not measured; never shows unmeasured as 0', () => {
        const s = summariseRoleGap([
            row('Welding', 3, 3),
            row('Safety', 4, 2, { critical: true }),
            row('Blueprints', 2, 1),
            row('Rigging', 3, null, { assessed: false }),
            row('Crane', 2, null, { assessed: false, critical: true }),
        ]);
        expect(s.total).toBe(5);
        expect(s.measured).toBe(3);
        expect(s.unmeasured).toBe(2);
        expect(s.metRows.map((r) => r.skillName)).toEqual(['Welding']);
        // critical first, then the widest gap
        expect(s.growRows.map((r) => r.skillName)).toEqual(['Safety', 'Blueprints']);
        expect(s.growRows[0].gap).toBe(2);
        expect(s.unmeasuredRows.map((r) => r.skillName)).toEqual(['Rigging', 'Crane']);
        for (const r of s.unmeasuredRows) {
            expect(r.current).toBeNull();
            expect(r.gap).toBeNull();
            expect(r.met).toBe(false);
        }
        expect(s.gaps).toBe(2);
        expect(s.criticalGaps).toBe(1); // the unmeasured critical skill is not a gap
        // readiness over the MEASURED requirements: 1 met of 3 measured
        expect(s.readiness).toBe(33);
        expect(s.coverage).toBe(60);
    });

    test('nothing measured → readiness null (not 0), coverage 0', () => {
        const s = summariseRoleGap([
            row('A', 2, null, { assessed: false }),
            row('B', 3, null, { assessed: false }),
        ]);
        expect(s.readiness).toBeNull();
        expect(s.coverage).toBe(0);
        expect(s.gaps).toBe(0);
        expect(s.metRows).toEqual([]);
        expect(s.growRows).toEqual([]);
    });

    test('a role with no requirement has no readiness and no coverage', () => {
        const s = summariseRoleGap([]);
        expect(s.total).toBe(0);
        expect(s.readiness).toBeNull();
        expect(s.coverage).toBeNull();
    });

    test('required level 0 means NOT REQUIRED and leaves the denominator', () => {
        const s = summariseRoleGap([row('A', 0, 0), row('B', 2, 2)]);
        expect(s.total).toBe(1);
        expect(s.readiness).toBe(100);
    });

    test('an assessed level above the requirement is met with gap 0', () => {
        const s = summariseRoleGap([row('A', 2, 4)]);
        expect(s.metRows[0]).toMatchObject({ met: true, gap: 0, current: 4 });
    });

    test('a measured 0 is a real level (assessed), unlike a missing row', () => {
        const s = summariseRoleGap([row('A', 2, 0)]);
        expect(s.measured).toBe(1);
        expect(s.growRows[0]).toMatchObject({ current: 0, gap: 2, assessed: true });
    });
});

describe('rankClosestRoles — roles I am closest to', () => {
    // Shaped like ReadinessService._calculateSingleReadiness output. The
    // points-based readinessPercent is deliberately NOT what ranks: readiness
    // here is requirements met / requirements measured, like the target gap.
    const res = (roleId, roleName, { total, assessed, measuredGaps = 0 }) => ({
        roleId,
        roleName,
        totalRequired: total,
        assessedRequired: assessed,
        readinessPercent: assessed ? 12.3 : null,
        coveragePercent: total ? Math.round((assessed / total) * 1000) / 10 : null,
        gaps: [
            ...Array.from({ length: measuredGaps }, () => ({ isAssessed: true })),
            ...Array.from({ length: total - assessed }, () => ({ isAssessed: false })),
        ],
    });

    test('ranks by met / measured with the measured denominator attached', () => {
        const out = rankClosestRoles([
            res(1, 'Welder', { total: 10, assessed: 10, measuredGaps: 3 }),
            res(2, 'Foreman', { total: 8, assessed: 6, measuredGaps: 1 }),
        ]);
        expect(out.map((r) => r.roleName)).toEqual(['Foreman', 'Welder']);
        expect(out[0]).toMatchObject({
            roleId: 2,
            readiness: 83, // 5 met of 6 measured
            total: 8,
            measured: 6,
            unmeasured: 2,
            met: 5,
            gaps: 1,
            coverage: 75,
            thinEvidence: false,
        });
        expect(out[1].readiness).toBe(70);
    });

    test('agrees with summariseRoleGap on the same requirements', () => {
        const gap = summariseRoleGap([
            row('A', 3, 3),
            row('B', 3, 1),
            row('C', 2, null, { assessed: false }),
        ]);
        const [ranked] = rankClosestRoles([
            res(9, 'Target', { total: 3, assessed: 2, measuredGaps: 1 }),
        ]);
        expect(ranked.readiness).toBe(gap.readiness);
        expect(ranked.met).toBe(gap.met);
        expect(ranked.measured).toBe(gap.measured);
    });

    test('a role with nothing measured is left out, never ranked at 0', () => {
        const out = rankClosestRoles([
            res(1, 'Welder', { total: 10, assessed: 0 }),
            res(2, 'Foreman', { total: 4, assessed: 4, measuredGaps: 2 }),
        ]);
        expect(out.map((r) => r.roleId)).toEqual([2]);
    });

    test('thin evidence ranks after well-measured roles, whatever its score', () => {
        const out = rankClosestRoles([
            res(1, 'Thin', { total: 20, assessed: 1 }),
            res(2, 'Solid', { total: 20, assessed: 18, measuredGaps: 3 }),
        ]);
        expect(out.map((r) => r.roleName)).toEqual(['Solid', 'Thin']);
        expect(out[1].readiness).toBe(100);
        expect(out[1].thinEvidence).toBe(true);
        expect(out[1].coverage).toBeLessThan(THIN_EVIDENCE_COVERAGE);
    });

    test('excludes the current role, roles without requirements, and honours the limit', () => {
        const all = [
            res(1, 'Current', { total: 5, assessed: 5 }),
            res(2, 'Empty', { total: 0, assessed: 0 }),
            ...[3, 4, 5, 6, 7, 8].map((id) =>
                res(id, `R${id}`, { total: 10, assessed: 10, measuredGaps: 10 - id })
            ),
        ];
        const out = rankClosestRoles(all, { excludeRoleIds: [1], limit: 3 });
        expect(out.map((r) => r.roleId)).toEqual([8, 7, 6]);
    });

    test('ties break on the larger measured base, then on the name', () => {
        const out = rankClosestRoles([
            res(1, 'B', { total: 10, assessed: 5, measuredGaps: 1 }),
            res(2, 'A', { total: 10, assessed: 10, measuredGaps: 2 }),
            res(3, 'C', { total: 10, assessed: 10, measuredGaps: 2 }),
        ]);
        expect(out.map((r) => r.roleName)).toEqual(['A', 'C', 'B']);
    });
});

describe('learningSuggestions — suggested learning for my gaps', () => {
    const SI = require('../../src/services/SkillsIntelligenceService');

    test('top three, measured gaps with a course first, never throws', async () => {
        jest.spyOn(SI, 'recommendLearning').mockResolvedValue([
            {
                skillId: 1,
                skillName: 'NoCourse',
                status: 'gap',
                required: 3,
                current: 1,
                gap: 2,
                course: null,
            },
            {
                skillId: 2,
                skillName: 'WithCourse',
                status: 'gap',
                required: 3,
                current: 2,
                gap: 1,
                course: { id: 9, title: 'Course', provider: 'x', url: 'https://lms.example/c/9' },
            },
            {
                skillId: 3,
                skillName: 'Unmeasured',
                status: 'not_assessed',
                required: 2,
                current: null,
                gap: null,
                course: null,
            },
            {
                skillId: 4,
                skillName: 'Unmeasured2',
                status: 'not_assessed',
                required: 2,
                current: null,
                gap: null,
                course: null,
            },
        ]);
        const out = await learningSuggestions(42, 3);
        expect(SI.recommendLearning).toHaveBeenCalledWith(42, 10);
        expect(out.map((s) => s.skillName)).toEqual(['WithCourse', 'NoCourse', 'Unmeasured']);
        expect(out[2].current).toBeNull();
    });

    test('a failing recommender is the empty state, not an error', async () => {
        jest.spyOn(SI, 'recommendLearning').mockRejectedValue(new Error('db down'));
        await expect(learningSuggestions(42)).resolves.toEqual([]);
    });

    test('a course URL that is not http(s) is never rendered as a link', async () => {
        jest.spyOn(SI, 'recommendLearning').mockResolvedValue([
            {
                skillId: 1,
                skillName: 'X',
                status: 'gap',
                required: 2,
                current: 1,
                gap: 1,
                course: { id: 1, title: 'Bad', provider: 'p', url: 'javascript:alert(1)' },
            },
        ]);
        const out = await learningSuggestions(1);
        expect(out[0].course.url).toBeNull();
    });

    test('safeUrl keeps http(s) only', () => {
        expect(safeUrl('https://a.example/x')).toBe('https://a.example/x');
        expect(safeUrl('http://a.example/')).toBe('http://a.example/');
        expect(safeUrl('data:text/html,hi')).toBeNull();
        expect(safeUrl('/relative')).toBeNull();
        expect(safeUrl(null)).toBeNull();
    });
});
