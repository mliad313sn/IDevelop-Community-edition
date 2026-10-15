'use strict';
/**
 * Found by the query-parameter matrix (queryParamMatrix-db.test.js): four JSON
 * endpoints answered 500 on a malformed filter. They answer 400 now, before any
 * query runs, and keep working with valid or absent values.
 *   /api/dashboard/readiness-by-group  ?groupBy=<unknown>
 *   /api/dashboard/domain-heatmap      ?groupBy=<unknown>
 *   /api/dashboard/employee-list       ?supervisorId= / ?roleId= not a whole number
 *   /api/benchmark/fit                 ?subDomainId= / ?roleFamilyId= / ?minLevel= malformed
 */
jest.mock('../../src/services/DashboardService', () => ({
    getReadinessByGroup: jest.fn(async () => []),
    getCapabilityMapData: jest.fn(async () => ({ heatmap: [] })),
    getEmployeeList: jest.fn(async () => ({ rows: [] })),
}));
jest.mock('../../src/models/BenchmarkModel', () => ({ getFit: jest.fn(async () => []) }));
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
}));

const DashboardService = require('../../src/services/DashboardService');
const BenchmarkModel = require('../../src/models/BenchmarkModel');
const DashboardController = require('../../src/controllers/DashboardController');
const Benchmark = require('../../src/controllers/BenchmarkController');
const { queryId, queryEnum, queryNumber, isAbsent } = require('../../src/utils/queryParams');

const ctrl = new DashboardController();
const BAD = ['<i data-probe>m</i>', 'abc', '1.5', '-2', '0', '9'.repeat(20)];

async function call(fn, query) {
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
    await fn({ query, scope: {}, user: { userType: 'admin', role: 'superadmin' } }, res);
    return res;
}

describe('utils/queryParams', () => {
    test('queryId: absent is null, a positive whole number is a number, anything else is refused', () => {
        for (const v of [undefined, null, '', 'null'])
            expect(queryId(v)).toEqual({ ok: true, value: null });
        expect(queryId('42')).toEqual({ ok: true, value: 42 });
        for (const v of [...BAD, ['1'], { a: 1 }, 7]) expect(queryId(v)).toEqual({ ok: false });
        expect(isAbsent('null')).toBe(true);
    });
    test('queryEnum and queryNumber', () => {
        expect(queryEnum(undefined, ['a'], 'a')).toEqual({ ok: true, value: 'a' });
        expect(queryEnum('b', ['a', 'b'])).toEqual({ ok: true, value: 'b' });
        expect(queryEnum('c', ['a', 'b'])).toEqual({ ok: false });
        expect(queryEnum(['a'], ['a'])).toEqual({ ok: false });
        expect(queryNumber('2.5', { min: 0, max: 5 })).toEqual({ ok: true, value: 2.5 });
        expect(queryNumber('2.5', { integer: true })).toEqual({ ok: false });
        expect(queryNumber('NaN')).toEqual({ ok: false });
        expect(queryNumber('9', { max: 5 })).toEqual({ ok: false });
        expect(queryNumber('')).toEqual({ ok: true, value: null });
    });
});

describe('dashboard JSON endpoints: a malformed filter is a 400', () => {
    test.each([
        ['getReadinessByGroup', 'groupBy'],
        ['getDomainHeatmap', 'groupBy'],
        ['getEmployeeList', 'supervisorId'],
        ['getEmployeeList', 'roleId'],
    ])('%s ?%s=<malformed>: 400, the service is not called', async (method, key) => {
        for (const v of BAD) {
            const res = await call(ctrl[method].bind(ctrl), { [key]: v });
            expect(res.statusCode).toBe(400);
        }
        expect(DashboardService.getReadinessByGroup).not.toHaveBeenCalled();
        expect(DashboardService.getCapabilityMapData).not.toHaveBeenCalled();
        expect(DashboardService.getEmployeeList).not.toHaveBeenCalled();
    });

    test('valid and absent values still reach the service', async () => {
        expect((await call(ctrl.getReadinessByGroup.bind(ctrl), {})).statusCode).toBe(200);
        expect(DashboardService.getReadinessByGroup).toHaveBeenCalledWith('site', {});
        await call(ctrl.getReadinessByGroup.bind(ctrl), { groupBy: 'role' });
        expect(DashboardService.getReadinessByGroup).toHaveBeenLastCalledWith('role', {});
        expect((await call(ctrl.getDomainHeatmap.bind(ctrl), { groupBy: 'service' })).body).toEqual(
            []
        );
        await call(ctrl.getEmployeeList.bind(ctrl), { supervisorId: '7', roleId: '3' });
        expect(DashboardService.getEmployeeList.mock.calls[0][1]).toMatchObject({
            supervisorId: 7,
            roleId: 3,
        });
    });
});

describe('benchmark fit: a malformed id or level is a 400', () => {
    test.each(['subDomainId', 'roleFamilyId', 'minLevel'])('?%s=<malformed>: 400', async (key) => {
        const res = await call(Benchmark.getFit.bind(Benchmark), { [key]: 'abc' });
        expect(res.statusCode).toBe(400);
        expect(BenchmarkModel.getFit).not.toHaveBeenCalled();
    });

    test('valid values reach the model as numbers; the page filters ignore a malformed one', async () => {
        const res = await call(Benchmark.getFit.bind(Benchmark), {
            subDomainId: '4',
            roleFamilyId: '2',
            minLevel: '3',
        });
        expect(res.statusCode).toBe(200);
        expect(BenchmarkModel.getFit).toHaveBeenCalledWith(
            expect.objectContaining({ subDomainId: 4, roleFamilyId: 2, minLevel: 3 })
        );
        const f = Benchmark._buildFilters({
            query: { subDomainId: 'x', minLevel: '2' },
            scope: {},
        });
        expect(f.subDomainId).toBeUndefined();
        expect(f.minLevel).toBe(2);
        expect(f.malformed).toBe(true);
        expect(Object.keys(f)).not.toContain('malformed');
    });
});
