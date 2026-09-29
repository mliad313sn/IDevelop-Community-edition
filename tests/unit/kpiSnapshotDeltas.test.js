'use strict';
/**
 * KpiSnapshotService — the ABSENT-NOT-ZERO contract.
 *
 * These are the tests that matter most in this module. The dashboard now prints
 * "82 % (+3 since last month)" on its KPI cards, and the whole value of that
 * depends on it NEVER inventing a movement. This install has almost no stored
 * history, so the common case is "no comparison exists" — which must render as
 * nothing at all, not as "+0".
 *
 * DB-free: src/config/database is mocked.
 */

jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn().mockResolvedValue({ changes: 1 }),
}));

const db = require('../../src/config/database');
const KpiSnapshotService = require('../../src/services/KpiSnapshotService');

describe('KpiSnapshotService.deltas — absent, never zero', () => {
    test('no prior snapshot → no deltas at all (not zeros)', async () => {
        db.get.mockResolvedValue(undefined);
        const out = await KpiSnapshotService.deltas({ avgReadiness: 82.1 }, 'org', 0, 28);
        expect(out.since).toBeNull();
        expect(out.values).toEqual({});
        // The specific failure mode we are guarding against:
        expect(out.values.avgReadiness).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(out.values, 'avgReadiness')).toBe(false);
    });

    test('prior exists → real signed delta, rounded to 1dp', async () => {
        db.get.mockResolvedValue({
            date: '2026-07-18',
            avgReadiness: 79.0,
            assessmentCoverage: 70.0,
            roleReadyCount: 40,
        });
        const out = await KpiSnapshotService.deltas(
            { avgReadiness: 82.1, assessmentCoverage: 74.4, roleReadyCount: 44 },
            'org',
            0,
            28
        );
        expect(out.since).toBe('2026-07-18');
        expect(out.values.avgReadiness).toBeCloseTo(3.1, 5);
        expect(out.values.assessmentCoverage).toBeCloseTo(4.4, 5);
        expect(out.values.roleReadyCount).toBe(4);
    });

    test('a NULL PRIOR value yields NO delta for that metric', async () => {
        // criticalCompliance was never measured at the earlier date. Treating
        // NULL as 0 would report a fabricated jump from zero.
        db.get.mockResolvedValue({
            date: '2026-07-18',
            avgReadiness: 79.0,
            criticalCompliance: null,
        });
        const out = await KpiSnapshotService.deltas(
            { avgReadiness: 82.1, criticalCompliance: 64.0 },
            'org',
            0,
            28
        );
        expect(out.values.avgReadiness).toBeCloseTo(3.1, 5);
        expect(Object.prototype.hasOwnProperty.call(out.values, 'criticalCompliance')).toBe(false);
    });

    test('a NULL CURRENT value yields NO delta for that metric', async () => {
        db.get.mockResolvedValue({ date: '2026-07-18', avgReadiness: 79.0 });
        const out = await KpiSnapshotService.deltas({ avgReadiness: null }, 'org', 0, 28);
        expect(Object.prototype.hasOwnProperty.call(out.values, 'avgReadiness')).toBe(false);
    });

    test('a genuine zero movement is reported as 0, and is distinguishable from absent', async () => {
        db.get.mockResolvedValue({ date: '2026-07-18', avgReadiness: 82.1 });
        const out = await KpiSnapshotService.deltas({ avgReadiness: 82.1 }, 'org', 0, 28);
        expect(out.values.avgReadiness).toBe(0);
        expect(Object.prototype.hasOwnProperty.call(out.values, 'avgReadiness')).toBe(true);
    });

    test('negative movement keeps its sign', async () => {
        db.get.mockResolvedValue({ date: '2026-07-18', avgReadiness: 85.0 });
        const out = await KpiSnapshotService.deltas({ avgReadiness: 82.1 }, 'org', 0, 28);
        expect(out.values.avgReadiness).toBeCloseTo(-2.9, 5);
    });
});

describe('KpiSnapshotService.capture — null preservation', () => {
    test('unmeasured metrics are written as NULL, never coerced to 0', async () => {
        db.run.mockClear();
        await KpiSnapshotService.capture('org', 0, null, {
            totalEmployees: 77,
            avgReadiness: null, // nobody measured
            criticalCompliance: undefined, // absent from the payload
            assessmentCoverage: '', // empty string from a loose caller
        });
        const params = db.run.mock.calls[0][1];
        // total_employees survives as a number; the three unmeasured ones are null.
        expect(params).toContain(77);
        expect(params.filter((p) => p === null).length).toBeGreaterThanOrEqual(3);
        expect(params).not.toContain(undefined);
        expect(params).not.toContain('');
    });

    test('scope_id defaults to 0 for org so the unique key needs no COALESCE', async () => {
        db.run.mockClear();
        await KpiSnapshotService.capture('org', 999, null, {});
        expect(db.run.mock.calls[0][1].slice(0, 2)).toEqual(['org', 0]);
    });

    test('an unknown scope type is coerced to org rather than written through', async () => {
        db.run.mockClear();
        await KpiSnapshotService.capture('team', 5, null, {});
        expect(db.run.mock.calls[0][1][0]).toBe('org');
    });
});

describe('KpiSnapshotService.series — unmeasured days stay null', () => {
    test('null readiness is preserved (the caller drops it; the service never zeroes it)', async () => {
        db.all.mockResolvedValue([
            { date: new Date('2026-07-18T00:00:00Z'), avgReadiness: null, assessmentCoverage: 70 },
            { date: '2026-08-22', avgReadiness: '82.1', assessmentCoverage: null },
        ]);
        const out = await KpiSnapshotService.series('org', 0, 400);
        expect(out[0].avgReadiness).toBeNull();
        expect(out[0].date).toBe('2026-07-18');
        expect(out[1].avgReadiness).toBe(82.1);
        expect(out[1].assessmentCoverage).toBeNull();
    });
});
