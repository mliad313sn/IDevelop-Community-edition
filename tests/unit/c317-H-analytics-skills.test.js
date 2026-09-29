'use strict';
/**
 * 3.23.17 lane H — SkillsIntelligenceService.
 *
 *  1. recommendLearning treated a skill with NO assessment as current level 0,
 *     i.e. a full-size gap to train — "not measured" rendered as a measured
 *     bad result. It must come back as "not assessed → assess it".
 *  2. inferSkills ignored the certification register, the strongest evidence
 *     the product holds. A CURRENT certificate must produce a (pending,
 *     human-reviewed) suggestion; it must never write an official level.
 *
 * The fake database below answers from an in-memory model of the tables, with
 * the SQL semantics of each shape of query (LEFT JOIN + COALESCE vs inner join
 * vs NOT EXISTS), so the assertions are on behaviour, not on SQL text.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const SI = require('../../src/services/SkillsIntelligenceService');

const SKILLS = { 10: 'Blasting', 11: 'Drilling', 12: 'Surveying', 13: 'First aid' };

function wireRecommend({ requirements, assessments }) {
    // requirements: [{skillId, required, critical}], assessments: {skillId: level}
    mockDb.all.mockImplementation(async (sql) => {
        if (/NOT EXISTS/.test(sql)) {
            return requirements
                .filter((r) => r.required > 0 && !(r.skillId in assessments))
                .map((r) => ({
                    skillId: r.skillId,
                    skillName: SKILLS[r.skillId],
                    required: r.required,
                }));
        }
        if (/role_skill_requirements/.test(sql)) {
            const leftJoin = /LEFT JOIN skill_assessments/.test(sql);
            return requirements
                .filter((r) => leftJoin || r.skillId in assessments)
                .map((r) => ({
                    r,
                    cur: r.skillId in assessments ? assessments[r.skillId] : leftJoin ? 0 : null,
                }))
                .filter(({ r, cur }) => r.required > cur)
                .map(({ r, cur }) => ({
                    skillId: r.skillId,
                    skillName: SKILLS[r.skillId],
                    required: r.required,
                    current: cur,
                }));
        }
        return [];
    });
    mockDb.get.mockResolvedValue(null); // no mapped course
}

beforeEach(() => {
    mockDb.all.mockReset();
    mockDb.get.mockReset();
    mockDb.run.mockReset();
});

describe('recommendLearning', () => {
    test('an unassessed required skill is "not assessed", never a gap of size `required`', async () => {
        wireRecommend({
            requirements: [
                { skillId: 10, required: 3 },
                { skillId: 11, required: 3 },
            ],
            assessments: { 10: 1 }, // 11 never assessed
        });
        const out = await SI.recommendLearning(1);
        const measured = out.find((x) => x.skillId === 10);
        const unknown = out.find((x) => x.skillId === 11);
        expect(measured).toMatchObject({ status: 'gap', gap: 2, recommendedAction: 'training' });
        expect(unknown).toMatchObject({
            status: 'not_assessed',
            gap: null,
            current: null,
            recommendedAction: 'assessment',
            course: null,
        });
    });

    test('a measured level of 0 is a real gap', async () => {
        wireRecommend({ requirements: [{ skillId: 12, required: 2 }], assessments: { 12: 0 } });
        const out = await SI.recommendLearning(1);
        expect(out).toEqual([expect.objectContaining({ skillId: 12, status: 'gap', gap: 2 })]);
    });
});

describe('inferSkills — certification register', () => {
    function wireInfer({ certs = [], assessed = [] } = {}) {
        mockDb.all.mockImplementation(async (sql) => {
            if (/v_certification_current/.test(sql)) return certs.map((skillId) => ({ skillId }));
            if (/FROM skill_assessments/.test(sql) && /current_level > 0/.test(sql))
                return assessed.map((skillId) => ({ skillId }));
            return [];
        });
        mockDb.get.mockImplementation(async (sql, p) =>
            /FROM skills/.test(sql) ? { name: SKILLS[p[0]] } : null
        );
        mockDb.run.mockResolvedValue({ changes: 1 });
    }

    test('a current certification becomes the strongest pending suggestion', async () => {
        wireInfer({ certs: [13] });
        const out = await SI.inferSkills(1);
        expect(out[0]).toMatchObject({ skillId: 13, source: 'certification' });
        expect(out[0].confidence).toBeGreaterThanOrEqual(0.95);
        // suggest-then-review: a pending suggestion, never an official level
        const writes = mockDb.run.mock.calls.map(([sql]) => sql);
        expect(
            writes.some((s) => /INSERT INTO skill_suggestions/.test(s) && /'pending'/.test(s))
        ).toBe(true);
        expect(writes.some((s) => /skill_assessments/.test(s))).toBe(false);
    });

    test('an already-assessed skill is not re-suggested even when certified', async () => {
        wireInfer({ certs: [13], assessed: [13] });
        expect(await SI.inferSkills(1)).toEqual([]);
    });
});
