'use strict';
/**
 * GET /api/analytics/campaign-burndown?cycleId=<not a number> used to bind NaN
 * into the query and answer 500. A malformed ?cycleId= is now a 400 before any
 * query runs; a valid one still reaches the campaign lookup, and an absent one
 * follows the current campaign.
 */
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
}));
jest.mock('../../src/utils/rbacScope', () => ({
    scopedEmployeeIds: jest.fn(async () => null),
    scopeClause: () => '',
}));
jest.mock('../../src/services/CycleService', () => ({ findCurrent: jest.fn(async () => null) }));

const db = require('../../src/config/database');
const CycleService = require('../../src/services/CycleService');
const C = require('../../src/controllers/DeptAnalyticsController');

async function call(query) {
    const res = {
        statusCode: 200,
        body: null,
        status(c) {
            this.statusCode = c;
            return this;
        },
        json(b) {
            this.body = b;
            return this;
        },
    };
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        await C.campaignBurndown({ query, user: { userType: 'admin', role: 'superadmin' } }, res);
    } finally {
        err.mockRestore();
    }
    return res;
}

describe('campaign burndown: a malformed ?cycleId= is a 400, never a 500', () => {
    test.each([
        ['abc'],
        ['<i data-probe>m</i>&"\''],
        ['1.5'],
        ['-3'],
        ['0'],
        ['1e3'],
        [' 4'],
        ['9'.repeat(40)],
        [['1', '2']],
        [{ a: '1' }],
    ])('cycleId=%p: 400 and no query', async (v) => {
        const res = await call({ cycleId: v });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'invalid cycleId' });
        expect(db.get).not.toHaveBeenCalled();
        expect(db.all).not.toHaveBeenCalled();
    });

    test('a valid cycleId reaches the campaign lookup (unknown campaign: empty answer)', async () => {
        const res = await call({ cycleId: '42' });
        expect(res.statusCode).toBe(200);
        expect(db.get).toHaveBeenCalledWith(
            expect.stringContaining('FROM assessment_cycles'),
            [42]
        );
        expect(res.body).toEqual({ cycle: null, departments: [] });
    });

    test('no cycleId follows the current campaign', async () => {
        const res = await call({});
        expect(res.statusCode).toBe(200);
        expect(CycleService.findCurrent).toHaveBeenCalled();
        expect(db.get).not.toHaveBeenCalled();
    });
});
