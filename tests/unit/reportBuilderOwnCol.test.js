'use strict';

/**
 * SA-19: ReportBuilderService maps client-supplied field names through OWN
 * properties only. Inherited names (`constructor`, `__proto__`, `toString`…)
 * are not columns and never reach the SQL text; an unknown data source is a
 * client error (status 400), not a server error.
 */
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 1 })),
}));

const RBS = require('../../src/services/ReportBuilderService');
const user = { id: 1, userType: 'admin', role: 'superadmin' };

describe('ownCol', () => {
    test('own string properties only', () => {
        const m = { firstName: 'e.firstName' };
        expect(RBS.ownCol(m, 'firstName')).toBe('e.firstName');
        expect(RBS.ownCol(m, 'constructor')).toBeNull();
        expect(RBS.ownCol(m, '__proto__')).toBeNull();
        expect(RBS.ownCol(m, 'toString')).toBeNull();
        expect(RBS.ownCol(m, 42)).toBeNull();
        expect(RBS.ownCol(null, 'firstName')).toBeNull();
    });
});

describe('ReportBuilderService never maps inherited names', () => {
    test('constructor / __proto__ / toString are dropped, never printed into SQL', async () => {
        const out = await RBS.buildQuery(
            {
                dataSource: 'employees',
                selectedFields: ['constructor', '__proto__', 'toString', 'firstName'],
                filters: {
                    logic: 'AND',
                    conditions: [{ field: 'constructor', operator: 'equals', value: 'x' }],
                },
                sorting: [{ field: 'hasOwnProperty', direction: 'asc' }],
                groupBy: ['valueOf'],
            },
            user
        );
        expect(out.query).not.toMatch(/function|native code|\[object/);
        expect(out.query).toMatch(/e\.firstName AS firstName/);
        expect(out.query).not.toMatch(/GROUP BY/);
        expect(out.query).not.toMatch(/ORDER BY/);
    });

    test('an unknown data source is a client error (status 400)', async () => {
        await expect(RBS.buildQuery({ dataSource: 'constructor' }, user)).rejects.toMatchObject({
            status: 400,
        });
    });
});
