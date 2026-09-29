'use strict';
/**
 * KeyPersonRiskService — the sole-holder sweep.
 *
 * The contract under test:
 *   1. NEVER-MEASURED IS NOT A GAP. A (skill, unit) cell nobody has been
 *      assessed on is 'never_measured' and is counted separately from the two
 *      risk bands. On this dev instance ALL critical requirements sit in that
 *      state, so a sweep that folded them into "0 qualified" would manufacture
 *      136 site-level crises out of an absence of measurement.
 *   2. SCOPE BEFORE AGGREGATE. Both the demand side and the holder side are
 *      restricted to scopedEmployeeIds, so the sweep can never name someone the
 *      caller may not see, and an empty scope returns nothing rather than
 *      falling back to an unscoped query.
 *   3. The full department-designed requirement set is read; nothing subsets it.
 *
 * DB-free: database and rbacScope are mocked.
 */

jest.mock('../../src/config/database', () => ({ all: jest.fn(), get: jest.fn() }));
jest.mock('../../src/utils/rbacScope', () => ({
    scopedEmployeeIds: jest.fn(),
    scopeClause: jest.requireActual('../../src/utils/rbacScope').scopeClause,
}));

const db = require('../../src/config/database');
const { scopedEmployeeIds } = require('../../src/utils/rbacScope');
const KeyPersonRiskService = require('../../src/services/KeyPersonRiskService');

const SUPER = { userType: 'admin', role: 'superadmin', id: 1 };

beforeEach(() => {
    db.all.mockReset();
    db.get.mockReset();
    scopedEmployeeIds.mockReset();
});

describe('band classification', () => {
    // The band expression lives in SQL, so these tests drive the SQL result
    // through _shape/_summarise, which is where the JS half of the contract is.
    test('_summarise keeps never_measured out of the risk counts', () => {
        const s = KeyPersonRiskService._summarise([
            { band: 'sole_holder', isCritical: true, n: 3 },
            { band: 'sole_holder', isCritical: false, n: 5 },
            { band: 'no_qualified', isCritical: false, n: 7 },
            { band: 'never_measured', isCritical: true, n: 136 },
            { band: 'covered', isCritical: false, n: 11 },
        ]);
        expect(s.soleHolder).toBe(8);
        expect(s.criticalSoleHolder).toBe(3);
        expect(s.noQualified).toBe(7);
        // The 136 unmeasured critical cells are their OWN number...
        expect(s.neverMeasured).toBe(136);
        expect(s.criticalNeverMeasured).toBe(136);
        // ...and are not added to either risk band.
        expect(s.soleHolder + s.noQualified).toBe(15);
        expect(s.total).toBe(162);
    });

    test('_shape pairs holder names with ids and roles positionally', () => {
        const r = KeyPersonRiskService._shape({
            skillId: '7',
            skillName: 'Soudure',
            domainName: 'Maintenance',
            unitId: '11',
            unitName: 'Riverside',
            requiredLevel: '3',
            isCritical: true,
            requiredOf: '5',
            roleCriticality: '4',
            measured: '9',
            qualified: '1',
            blockedByCert: '2',
            band: 'sole_holder',
            holderNames: ['Amina Silva'],
            holderIds: ['155'],
            holderRoles: ['Soudeur'],
        });
        expect(r.holders).toEqual([{ id: 155, name: 'Amina Silva', roleName: 'Soudeur' }]);
        expect(r.qualified).toBe(1);
        expect(r.blockedByCert).toBe(2);
        expect(r.isCritical).toBe(true);
        expect(r.band).toBe('sole_holder');
    });

    test('_shape tolerates a never-measured row with no holder arrays at all', () => {
        const r = KeyPersonRiskService._shape({
            skillId: 9,
            skillName: 'X',
            unitId: 1,
            unitName: 'S',
            requiredLevel: 4,
            isCritical: true,
            requiredOf: 5,
            measured: 0,
            qualified: 0,
            band: 'never_measured',
            holderNames: null,
            holderIds: null,
            holderRoles: null,
        });
        expect(r.holders).toEqual([]);
        expect(r.measured).toBe(0);
        // measured 0 => the view prints a dash, not "0 qualified".
        expect(r.band).toBe('never_measured');
    });
});

describe('RBAC scoping', () => {
    test('an empty scope returns nothing and issues NO query', async () => {
        scopedEmployeeIds.mockResolvedValue([]);
        const out = await KeyPersonRiskService.sweep({ userType: 'manager', id: 5 }, {});
        expect(out.rows).toEqual([]);
        expect(out.summary.total).toBe(0);
        expect(out.scope.employeeCount).toBe(0);
        expect(db.all).not.toHaveBeenCalled();
    });

    test('a scoped caller binds their employee ids to BOTH demand and holder sides', async () => {
        scopedEmployeeIds.mockResolvedValue([7, 8]);
        db.all.mockResolvedValue([]);
        await KeyPersonRiskService.sweep({ userType: 'manager', id: 5 }, { band: 'sole_holder' });

        const [sql, params] = db.all.mock.calls[0];
        // Two IN lists: one for the demand CTE, one for the holder CTE.
        expect(sql).toMatch(/ed\.employee_id IN/);
        expect(sql).toMatch(/ed2\.employee_id IN/);
        expect(params.filter((p) => p === 7).length).toBe(2);
        expect(params.filter((p) => p === 8).length).toBe(2);
    });

    test('a superadmin is unrestricted and binds no employee ids', async () => {
        scopedEmployeeIds.mockResolvedValue(null);
        db.all.mockResolvedValue([]);
        const out = await KeyPersonRiskService.sweep(SUPER, { band: 'all' });
        expect(out.scope.unrestricted).toBe(true);
        const [sql] = db.all.mock.calls[0];
        expect(sql).not.toMatch(/employee_id IN/);
    });
});

describe('input handling', () => {
    beforeEach(() => {
        scopedEmployeeIds.mockResolvedValue(null);
        db.all.mockResolvedValue([]);
    });

    // sweep() issues TWO queries: [0] the band summary over every cell in scope,
    // [1] the filtered/limited row list. Assertions about the band filter and
    // LIMIT belong to the second.
    const summaryQuery = () => db.all.mock.calls[0];
    const rowsQuery = () => db.all.mock.calls[1];

    test('an unknown unit falls back to site rather than interpolating it into SQL', async () => {
        await KeyPersonRiskService.sweep(SUPER, { unit: 'employees; DROP TABLE x' });
        const [sql] = rowsQuery();
        expect(sql).toMatch(/ed\.site_id/);
        expect(sql).not.toMatch(/DROP TABLE/);
    });

    // REGRESSION: `UNITS[key]` is a truthiness test, and a plain object inherits
    // Object.prototype — so 'constructor', '__proto__' and friends passed the
    // guard and resolved to a FUNCTION, whose .id is undefined. That reached the
    // query as the identifier `ed.undefined`, turning
    // /exec/key-person?unit=constructor into a 500 for any manager. Own-property
    // resolution only.
    test.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
        'inherited key %p never reaches the SQL identifier slot',
        async (key) => {
            expect(KeyPersonRiskService.resolveUnitKey(key)).toBe('site');
            await KeyPersonRiskService.sweep(SUPER, { unit: key });
            const [sql] = rowsQuery();
            expect(sql).toMatch(/ed\.site_id/);
            expect(sql).not.toMatch(/ed\.undefined/);
            expect(sql).not.toMatch(/undefined/);
        }
    );

    test('an unknown band falls back to sole_holder', async () => {
        await KeyPersonRiskService.sweep(SUPER, { band: 'nonsense' });
        const params = rowsQuery()[1];
        expect(params[params.length - 1]).toBe('sole_holder');
    });

    test("band 'all' applies no band filter", async () => {
        await KeyPersonRiskService.sweep(SUPER, { band: 'all' });
        const [, params] = rowsQuery();
        expect(params).not.toContain('sole_holder');
    });

    test('the summary is computed over every cell, unfiltered by band', async () => {
        await KeyPersonRiskService.sweep(SUPER, { band: 'sole_holder' });
        const [sql, params] = summaryQuery();
        expect(sql).toMatch(/GROUP BY 1, 2/);
        expect(params).not.toContain('sole_holder');
    });

    test('limit is clamped and inlined only as a validated number', async () => {
        await KeyPersonRiskService.sweep(SUPER, { limit: '999999; DROP TABLE x' });
        const [sql] = rowsQuery();
        expect(sql).toMatch(/LIMIT 200/); // NaN → default
        expect(sql).not.toMatch(/DROP TABLE/);
    });

    test('an out-of-range limit is clamped to the maximum', async () => {
        await KeyPersonRiskService.sweep(SUPER, { limit: 99999 });
        expect(rowsQuery()[0]).toMatch(/LIMIT 1000/);
    });

    test('the sweep reads role requirements whole — no sampling of a role’s skill set', async () => {
        await KeyPersonRiskService.sweep(SUPER, {});
        const [sql] = rowsQuery();
        // Only requirements with a real required level are excluded; nothing
        // limits how many skills a role contributes.
        expect(sql).toMatch(/role_skill_requirements rsr/);
        expect(sql).toMatch(/rsr\.required_level > 0/);
        expect(sql).not.toMatch(/rsr\.[a-z_]*\s+LIMIT/i);
    });

    test('qualification requires a non-null assessed level (no coalesce-to-zero)', async () => {
        await KeyPersonRiskService.sweep(SUPER, {});
        const [sql] = rowsQuery();
        expect(sql).toMatch(/ra\.level IS NOT NULL/);
        expect(sql).not.toMatch(/COALESCE\(ra\.level, ?0\)/);
    });

    test('a lapsed certificate demotes a holder out of the qualified set', async () => {
        await KeyPersonRiskService.sweep(SUPER, {});
        const [sql] = rowsQuery();
        expect(sql).toMatch(/v_certification_lapsed/);
        expect(sql).toMatch(/cl\.employee_id IS NULL/);
    });
});

describe('exposureByUnit', () => {
    test('rolls the sweep up per unit, keeping never_measured separate', async () => {
        scopedEmployeeIds.mockResolvedValue(null);
        jest.spyOn(KeyPersonRiskService, 'sweep').mockResolvedValue({
            rows: [
                { unitId: 1, unitName: 'Westbrook', band: 'sole_holder', isCritical: true },
                { unitId: 1, unitName: 'Westbrook', band: 'never_measured', isCritical: true },
                { unitId: 1, unitName: 'Westbrook', band: 'covered', isCritical: false },
                { unitId: 2, unitName: 'Lakeside', band: 'no_qualified', isCritical: false },
            ],
            summary: {},
            scope: {},
        });
        const out = await KeyPersonRiskService.exposureByUnit(SUPER, { unit: 'site' });
        const mana = out.find((u) => u.unitName === 'Westbrook');
        expect(mana.soleHolder).toBe(1);
        expect(mana.criticalSoleHolder).toBe(1);
        expect(mana.neverMeasured).toBe(1);
        expect(mana.covered).toBe(1);
        expect(mana.noQualified).toBe(0);
        // Alphabetical by unit name.
        expect(out.map((u) => u.unitName)).toEqual(['Lakeside', 'Westbrook']);
        KeyPersonRiskService.sweep.mockRestore();
    });
});
