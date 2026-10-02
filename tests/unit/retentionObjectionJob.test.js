'use strict';

/**
 * Objection to profiling (GDPR art. 21): the retention-risk sweep skips people
 * who objected, and FAILS CLOSED when objections cannot be read.
 * DB-free: database, settings, ledger and services are mocked.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://t:t@127.0.0.1:5432/retention_objection_job_test';
process.env.NODE_ENV = 'test';

const mockPopulation = [];
jest.mock('../../src/config/database', () => ({
    all: (sql) => Promise.resolve(/FROM employees e/.test(sql) ? mockPopulation : []),
    get: () => Promise.resolve(null),
    run: () => Promise.resolve({ changes: 0 }),
}));
jest.mock('../../src/jobs/reminders', () => ({
    claim: jest.fn(async () => true),
    release: jest.fn(async () => true),
    monthBucket: () => '2026-10',
}));
const mockSetValue = jest.fn(async () => true);
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) =>
        k === 'retentionRecomputeHour' ? 0 : d === undefined ? null : d
    ),
    setValue: (...a) => mockSetValue(...a),
}));
const mockComputeFor = jest.fn(async () => ({ flightRisk: 'low' }));
const mockSuppress = jest.fn(async () => null);
jest.mock('../../src/services/RetentionRiskService', () => ({
    computeFor: (...a) => mockComputeFor(...a),
    suppressForObjection: (...a) => mockSuppress(...a),
}));
jest.mock('../../src/services/ReportingLineService', () => ({
    effectiveReviewerJoinSql: () => '',
}));
jest.mock('../../src/services/NotificationService', () => ({ enqueue: jest.fn(async () => ({})) }));
const mockObjectors = jest.fn();
jest.mock('../../src/services/PrivacyService', () => ({
    activeObjectorIds: (...a) => mockObjectors(...a),
}));

const job = require('../../src/jobs/retention-recompute');

beforeEach(() => {
    mockPopulation.length = 0;
    mockComputeFor.mockClear();
    mockSuppress.mockClear();
    mockSetValue.mockClear();
    mockObjectors.mockReset();
});

test('objectors are never scored; their verdict stays withdrawn', async () => {
    mockPopulation.push({ id: 1 }, { id: 2 }, { id: 3 });
    mockObjectors.mockResolvedValue(new Set([2]));
    const out = await job.tick();
    expect(mockComputeFor.mock.calls.map((c) => c[0])).toEqual([1, 3]);
    expect(mockSuppress).toHaveBeenCalledWith(2);
    expect(out.skippedObjection).toBe(1);
    expect(out.computed).toBe(2);
    expect(mockSetValue).toHaveBeenCalled(); // day claimed after a complete sweep
});

test('FAILS CLOSED: unreadable objections abort the sweep and the day is NOT claimed', async () => {
    mockPopulation.push({ id: 1 });
    mockObjectors.mockRejectedValue(new Error('connection lost'));
    await expect(job.tick()).rejects.toThrow('connection lost');
    expect(mockComputeFor).not.toHaveBeenCalled();
    expect(mockSetValue).not.toHaveBeenCalled(); // retried at the next hourly tick
});
