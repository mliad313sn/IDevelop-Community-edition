'use strict';

/**
 * Re-audit J8 — the KPI delta caveated a movement only when the measured HEAD
 * COUNT changed, and only in a hover title. But an average can move because WHO
 * is averaged changed: five below-average leavers replaced by five joiners moves
 * no count at all, so "+0.6 pts" read as pure capability improvement. Each
 * snapshot now stores a fingerprint of the measured employee-id SET (migration
 * 143), so deltas() reports populationChanged when the count moved OR the cohort
 * differs — and the card shows a VISIBLE marker.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockGet = jest.fn();
jest.mock('../../src/config/database', () => ({
    get: (...a) => mockGet(...a),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
}));

const KpiSnapshotService = require('../../src/services/KpiSnapshotService');

function priorRow(over = {}) {
    return {
        date: '2026-08-22',
        measuredEmployees: 40,
        avgReadiness: 70.0,
        measuredSignature: 'PRIORSIG',
        ...over,
    };
}

describe('J8 — a delta says when it compared a different measured population', () => {
    test('net-zero head change but a different cohort → populationChanged', async () => {
        mockGet.mockResolvedValue(priorRow());
        const d = await KpiSnapshotService.deltas({
            measuredEmployees: 40,
            avgReadiness: 72.0,
            measuredSignature: 'NEWSIG',
        });
        expect(d.values.measuredEmployees).toBe(0); // count did not move
        expect(d.populationChanged).toBe(true); // …but the people did
    });

    test('same count and same cohort → not flagged', async () => {
        mockGet.mockResolvedValue(priorRow());
        const d = await KpiSnapshotService.deltas({
            measuredEmployees: 40,
            avgReadiness: 72.0,
            measuredSignature: 'PRIORSIG',
        });
        expect(d.populationChanged).toBe(false);
    });

    test('a net head-count change is still flagged even without fingerprints', async () => {
        mockGet.mockResolvedValue(priorRow({ measuredSignature: null }));
        const d = await KpiSnapshotService.deltas({
            measuredEmployees: 43,
            avgReadiness: 72.0,
            measuredSignature: null,
        });
        expect(d.populationChanged).toBe(true);
    });

    test('a legacy prior with no fingerprint cannot claim a cohort change', async () => {
        mockGet.mockResolvedValue(priorRow({ measuredSignature: null }));
        const d = await KpiSnapshotService.deltas({
            measuredEmployees: 40, // same count
            avgReadiness: 72.0,
            measuredSignature: 'X',
        });
        expect(d.populationChanged).toBe(false); // unknown, not asserted
    });

    test('no prior snapshot → empty, populationChanged false', async () => {
        mockGet.mockResolvedValue(null);
        const d = await KpiSnapshotService.deltas({ avgReadiness: 72.0, measuredSignature: 'X' });
        expect(d).toEqual({ since: null, values: {}, populationChanged: false });
    });

    test('capture writes the fingerprint column', async () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/KpiSnapshotService.js'),
            'utf8'
        );
        expect(src).toMatch(/measured_signature/);
        expect(src).toMatch(/measured_signature\s+AS "measuredSignature"/);
    });
});
