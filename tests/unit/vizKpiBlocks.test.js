'use strict';
/**
 * The dashboard building blocks are module-aware like the indicators they
 * detail: each block belongs to its indicator's module, an off module omits
 * it (never "not measured"), and a block's list link is a navigation entry.
 * The group-by is a closed list: a caller's value never reaches the SQL text.
 */
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));
const K = require('../../src/services/KpiService');
const { CATALOGUE } = require('../../src/config/navigation');

describe('building blocks', () => {
    test('each block belongs to the module of the indicator it details', () => {
        for (const [name, b] of Object.entries(K.BLOCKS)) {
            expect([name, b.module]).toEqual([name, K.moduleOf(b.kpi)]);
        }
    });
    test('availability follows the module flags', () => {
        expect(K.availableBlocks({})).toEqual(
            Object.keys(K.BLOCKS).filter((n) => K.BLOCKS[n].module === null)
        );
        expect(K.isBlockAvailable('unknown', {})).toBe(false);
        expect(K.isBlockAvailable('__proto__', {})).toBe(false);
        expect(K.isBlockAvailable('criticalSkillCoverage', {})).toBe(true);
    });
    test('a list link is a navigation entry', () => {
        const ids = new Set(Object.keys(CATALOGUE));
        for (const b of Object.values(K.BLOCKS))
            if (b.list) expect([b.list, ids.has(b.list)]).toEqual([b.list, true]);
    });
    test('the group-by is a closed list', async () => {
        expect(Object.keys(K.GROUP_COLUMNS)).toEqual(['site', 'department', 'service', 'role']);
        await expect(K.k1ByGroup({ viewer: { id: 1 } }, 'site; --')).rejects.toThrow(
            'unknown group'
        );
    });
    test('the distribution buckets cover 0 to 100 by 20 points', () => {
        expect(K.DISTRIBUTION_BINS).toEqual([0, 20, 40, 60, 80, 100]);
        expect(K.FRESHNESS_MONTHS).toBe(12);
    });
});
