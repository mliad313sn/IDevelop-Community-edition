'use strict';
/**
 * CoverageService (migration 56) — rule input hardening, the scoped-visibility
 * contract (a scoped caller can never infer units outside their scope), and
 * evaluateAll()'s TRANSITION detection — the watermark that makes breach
 * alerts fire exactly once (ok→breach alerts; breach→breach stays silent;
 * breach→ok records recovery). DB mocked.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const CoverageService = require('../../src/services/CoverageService');

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset().mockResolvedValue({});
});

describe('createRule', () => {
    test('clamps level/headcount and falls back to critical severity', async () => {
        mockDb.get.mockResolvedValue({ id: 1 });
        await CoverageService.createRule(
            { name: ' R1 ', skillId: 5, minLevel: 99, minHeadcount: '0', severity: 'nonsense' },
            7
        );
        const params = mockDb.get.mock.calls[0][1];
        expect(params[0]).toBe('R1'); // trimmed
        // Clamped to 4, the top of the 0-4 competency scale. It used to clamp to 5,
        // which no assessment can ever reach: such a rule is a permanent,
        // unsatisfiable critical breach (AMDEC L3-13). The DB CHECK now agrees.
        expect(params[5]).toBe(4);
        expect(params[6]).toBe(1); // minHeadcount floor 1
        expect(params[8]).toBe('critical'); // invalid severity → critical
    });

    test('rejects a rule without name/skill/headcount', async () => {
        await expect(CoverageService.createRule({ name: 'x' }, 1)).rejects.toThrow(/required/);
    });
});

describe('_ruleVisible (scoped visibility)', () => {
    const units = { sites: new Set([1]), departments: new Set([10]), services: new Set([100]) };

    test('company-wide rule (no org filter) is hidden from scoped callers', () => {
        expect(
            CoverageService._ruleVisible(
                { siteId: null, departmentId: null, serviceId: null },
                units
            )
        ).toBe(false);
    });
    test('visible only when every named unit is inside the scope', () => {
        expect(
            CoverageService._ruleVisible({ siteId: 1, departmentId: 10, serviceId: null }, units)
        ).toBe(true);
        expect(
            CoverageService._ruleVisible({ siteId: 2, departmentId: null, serviceId: null }, units)
        ).toBe(false);
        expect(
            CoverageService._ruleVisible({ siteId: 1, departmentId: 11, serviceId: null }, units)
        ).toBe(false);
    });
});

describe('evaluateAll — exactly-once breach transitions', () => {
    function statusRow(overrides) {
        return {
            ruleId: 1,
            name: 'R',
            severity: 'critical',
            requireValidCert: false,
            qualifiedHeadcount: 0,
            satisfied: false,
            lastSatisfied: null,
            ...overrides,
        };
    }

    test('first evaluation of a failing rule → newlyBreached (lastSatisfied null)', async () => {
        mockDb.all.mockResolvedValue([statusRow({ satisfied: false, lastSatisfied: null })]);
        const r = await CoverageService.evaluateAll();
        expect(r.newlyBreached).toHaveLength(1);
        expect(r.recovered).toHaveLength(0);
    });

    test('ok → breach transitions exactly once; breach → breach stays silent', async () => {
        mockDb.all.mockResolvedValue([statusRow({ satisfied: false, lastSatisfied: true })]);
        const first = await CoverageService.evaluateAll();
        expect(first.newlyBreached).toHaveLength(1);

        // Next pass: the persisted watermark now says lastSatisfied=false.
        mockDb.all.mockResolvedValue([statusRow({ satisfied: false, lastSatisfied: false })]);
        const second = await CoverageService.evaluateAll();
        expect(second.newlyBreached).toHaveLength(0); // no re-alert
    });

    test('breach → ok is reported as recovered (and only from a real breach)', async () => {
        mockDb.all.mockResolvedValue([statusRow({ satisfied: true, lastSatisfied: false })]);
        const r = await CoverageService.evaluateAll();
        expect(r.recovered).toHaveLength(1);
        expect(r.newlyBreached).toHaveLength(0);

        mockDb.all.mockResolvedValue([statusRow({ satisfied: true, lastSatisfied: true })]);
        const quiet = await CoverageService.evaluateAll();
        expect(quiet.recovered).toHaveLength(0);
    });

    test('every evaluation persists the watermark onto the rule row', async () => {
        mockDb.all.mockResolvedValue([
            statusRow({ ruleId: 42, qualifiedHeadcount: 3, satisfied: true, lastSatisfied: true }),
        ]);
        await CoverageService.evaluateAll();
        const [sql, params] = mockDb.run.mock.calls[0];
        expect(sql).toMatch(/UPDATE coverage_rules/);
        expect(params).toEqual([3, true, true, 42]);
    });
});
