'use strict';
/**
 * 3.23.17 lane H — the bias scan must be able to fire.
 *
 * It divided (groupMean − mean) by the standard deviation of INDIVIDUAL scores,
 * so a site whose ten people were all placed one full band below everybody else
 * (a textbook disparity) scored |z| ≈ 1.3 and raised nothing. The test statistic
 * of a group mean is its difference over the standard error σ/√n.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (_k, fb) => fb),
}));

const Bias = require('../../src/services/BiasDetectionService');

// score → a box string with that score (pot+perf, low=1 medium=2 high=3)
const BOX = { 2: 'low-low', 3: 'low-medium', 4: 'medium-medium', 5: 'high-medium', 6: 'high-high' };

let nextId;
function placement(score, over = {}) {
    nextId++;
    return {
        employeeId: nextId,
        box: BOX[score],
        siteId: 1,
        departmentId: 1,
        gender: null,
        ...over,
    };
}

function wire(placements, { nationality = [] } = {}) {
    mockDb.all.mockImplementation(async (sql) => {
        if (/is_national/.test(sql)) return nationality;
        if (/FROM talent_placements/.test(sql)) return placements;
        return [];
    });
    mockDb.get.mockResolvedValue(null); // no existing alert, no home country
    mockDb.run.mockResolvedValue({ changes: 1 });
}

function inserted() {
    return mockDb.run.mock.calls
        .filter(([sql]) => /INSERT INTO bias_alerts/.test(sql))
        .map(([, p]) => ({ dim: p[1], value: p[2], z: p[3] }));
}

beforeEach(() => {
    nextId = 0;
    mockDb.all.mockReset();
    mockDb.get.mockReset();
    mockDb.run.mockReset();
});

describe('BiasDetectionService.runForCycle', () => {
    test('a site placed one band below the rest is flagged (standard error, not σ)', async () => {
        // site 2: ten people at 3; everyone else (site 1): ten each at 4, 5, 6.
        // mean 4.5, σ ≈ 1.118 → old z = −1.34 (silent); SE-based z ≈ −4.8.
        const rows = [
            ...Array.from({ length: 10 }, () => placement(3, { siteId: 2 })),
            ...Array.from({ length: 10 }, () => placement(4)),
            ...Array.from({ length: 10 }, () => placement(5)),
            ...Array.from({ length: 10 }, () => placement(6)),
        ];
        wire(rows);
        const out = await Bias.runForCycle(7);
        const site2 = inserted().find((a) => a.dim === 'site' && a.value === '2');
        expect(site2).toBeDefined();
        expect(site2.z).toBeLessThan(-4);
        expect(out.alerts).toBeGreaterThanOrEqual(1);
        // department 1 is the whole cycle — nothing to compare it with, never flagged
        expect(inserted().some((a) => a.dim === 'department')).toBe(false);
    });

    test('a group under 5 people is insufficient data, never an alert', async () => {
        const rows = [
            ...Array.from({ length: 4 }, () => placement(2, { siteId: 9 })),
            ...Array.from({ length: 20 }, () => placement(6)),
        ];
        wire(rows);
        const out = await Bias.runForCycle(7);
        expect(inserted().some((a) => a.value === '9')).toBe(false);
        expect(out.dimensions.site.groupsInsufficient).toBe(1);
    });

    test('no spread (σ = 0) flags nothing', async () => {
        wire(Array.from({ length: 12 }, (_, i) => placement(4, { siteId: i < 6 ? 1 : 2 })));
        const out = await Bias.runForCycle(7);
        expect(inserted()).toEqual([]);
        expect(out.noVariance).toBe(true);
    });

    test('fewer than 5 readable placements is "insufficient data", not 0 alerts', async () => {
        wire([
            placement(4),
            placement(5),
            { employeeId: 99, box: '4', siteId: 1, departmentId: 1 },
        ]);
        const out = await Bias.runForCycle(7);
        expect(out.alerts).toBeNull();
        expect(out.insufficientData).toBe(true);
        expect(out.unreadable).toBe(1);
    });

    test('an unreadable box is left out, not scored 0', () => {
        expect(Bias.boxScore('4')).toBeNull();
        expect(Bias.boxScore(null)).toBeNull();
        expect(Bias.boxScore('high-medium')).toBe(5);
    });

    test('nationality axis: expatriates placed lower are flagged; unspecified is not a group', async () => {
        const rows = [
            ...Array.from({ length: 8 }, () => placement(3)),
            ...Array.from({ length: 24 }, () => placement(5)),
            ...Array.from({ length: 6 }, () => placement(5)), // nationality unknown
        ];
        const nationality = [
            ...rows.slice(0, 8).map((r) => ({ employeeId: r.employeeId, isNational: 0 })),
            ...rows.slice(8, 32).map((r) => ({ employeeId: r.employeeId, isNational: 1 })),
            ...rows.slice(32).map((r) => ({ employeeId: r.employeeId, isNational: null })),
        ];
        wire(rows, { nationality });
        const out = await Bias.runForCycle(7);
        const a = inserted().find((x) => x.dim === 'nationality' && x.value === 'expatriate');
        expect(a).toBeDefined();
        expect(a.z).toBeLessThan(-2);
        expect(out.dimensions.nationality.unspecified).toBe(6);
    });

    test('gender axis: analysed from employee_demographics, small groups suppressed', async () => {
        const rows = [
            ...Array.from({ length: 8 }, () => placement(3, { gender: 'F' })),
            ...Array.from({ length: 24 }, () => placement(5, { gender: 'M' })),
            ...Array.from({ length: 3 }, () => placement(2, { gender: 'X' })),
        ];
        wire(rows);
        const out = await Bias.runForCycle(7);
        expect(inserted().some((x) => x.dim === 'gender' && x.value === 'F')).toBe(true);
        expect(inserted().some((x) => x.dim === 'gender' && x.value === 'X')).toBe(false);
        expect(out.dimensions.gender.groupsInsufficient).toBe(1);
    });

    test('nationality unavailable (older schema) is reported, the scan still runs', async () => {
        const rows = [
            ...Array.from({ length: 10 }, () => placement(3, { siteId: 2 })),
            ...Array.from({ length: 30 }, () => placement(5)),
        ];
        mockDb.all.mockImplementation(async (sql) => {
            if (/is_national/.test(sql))
                throw new Error('relation "country_aliases" does not exist');
            return rows;
        });
        mockDb.get.mockResolvedValue(null);
        const out = await Bias.runForCycle(7);
        expect(out.dimensions.nationality.unavailable).toBe(true);
        expect(inserted().some((a) => a.dim === 'site' && a.value === '2')).toBe(true);
    });
});
