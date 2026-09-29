'use strict';
/**
 * 3.23.17 — closing an IDP action on a skill that was NEVER assessed has no
 * "before" level. It was stored as 0, so the whole post-rating was reported as
 * a measured gain. The pre-rating and uplift are now NULL (migration 148).
 */
const mockDb = {
    get: jest.fn(),
    run: jest.fn(async () => ({ changes: 1 })),
};
jest.mock('../../src/config/database', () => mockDb);
const AES = require('../../src/services/ActionEffectivenessService');

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.run.mockClear();
});

const effectivenessInsert = () =>
    mockDb.run.mock.calls.find((c) => /INSERT INTO action_effectiveness/.test(c[0]));

test('never assessed: pre and uplift are NULL (not measured), never 0 / a fake gain', async () => {
    mockDb.get.mockResolvedValueOnce({ skillId: 7 }).mockResolvedValueOnce(undefined);
    const out = await AES.onActionClose({ actionId: 1, postRating: 3, employeeId: 84 });
    expect(out.ratingPre).toBeNull();
    expect(out.uplift).toBeNull();
    expect(effectivenessInsert()[1]).toEqual([1, null, 3, null]);
});

test('assessed at 0 is a real measurement: uplift is post − 0', async () => {
    mockDb.get.mockResolvedValueOnce({ skillId: 7 }).mockResolvedValueOnce({ currentLevel: 0 });
    const out = await AES.onActionClose({ actionId: 1, postRating: 2, employeeId: 84 });
    expect(out).toMatchObject({ ratingPre: 0, uplift: 2 });
});

test('an authorised close may set the FIRST official level on a never-assessed skill', async () => {
    mockDb.get.mockResolvedValueOnce({ skillId: 7 }).mockResolvedValueOnce(undefined);
    const out = await AES.onActionClose({
        actionId: 1,
        postRating: 2,
        employeeId: 84,
        updateOfficial: true,
        assessedByAdminId: 1,
    });
    expect(out.officialUpdated).toBe(true);
    expect(mockDb.run.mock.calls.some((c) => /INSERT INTO skill_assessments/.test(c[0]))).toBe(
        true
    );
});

test('migration 148 lets rating_pre and uplift be NULL', () => {
    const sql = require('fs').readFileSync(
        require('path').join(
            __dirname,
            '..',
            '..',
            'db',
            'postgres',
            '148_action_effectiveness_unmeasured_pre.sql'
        ),
        'utf8'
    );
    expect(sql).toMatch(/ALTER COLUMN rating_pre DROP NOT NULL/);
    expect(sql).toMatch(/ALTER COLUMN uplift DROP NOT NULL/);
});
