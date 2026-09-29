'use strict';

/**
 * Re-audit J3 — coverage-check advanced the exactly-once alert watermark
 * (`last_satisfied` in evaluateAll, `predicted_breach_on` in predictAndPersist)
 * BEFORE it sent the alert, and the per-rule loop swallowed a failed send (it did
 * not even read notify()'s return). A dropped alert was therefore never re-fired:
 * exactly-once silently became zero-times, while the breach sat recorded-but-
 * unannounced.
 *
 * The fix: when a send does not go through (notify returns { inapp: 'error' } or
 * throws, or a whole batch reaches nobody), the job RE-OPENS the transition
 * (restores the prior watermark) so the next pass re-detects it and retries.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.NODE_ENV = 'test';
process.env.COVERAGE_ALERT_MAX = '50'; // stay on the per-rule path, not the batch

const mockDb = {
    all: jest.fn(async () => []),
    get: jest.fn(async () => null),
    run: jest.fn(async () => ({})),
};
jest.mock('../../src/config/database', () => mockDb);

const mockNotify = jest.fn(async () => ({ inapp: 'queued' }));
jest.mock('../../src/services/NotificationService', () => ({ notify: (...a) => mockNotify(...a) }));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => ({})) }));
jest.mock('../../src/services/RBACService', () => ({
    adminsWithPermission: jest.fn(async () => [1]),
}));

const mockCov = {
    evaluateAll: jest.fn(async () => ({ evaluated: 0, newlyBreached: [], recovered: [] })),
    predictAndPersist: jest.fn(async () => ({ predicted: 0, newlyPredicted: [] })),
    findRule: jest.fn(async (id) => ({ id, name: `R${id}`, createdBy: null })),
    alertAudienceFor: jest.fn(async () => [{ userType: 'employee', userId: 7, via: 'manager' }]),
    reopenTransition: jest.fn(async () => {}),
    reopenPrediction: jest.fn(async () => {}),
};
jest.mock('../../src/services/CoverageService', () => mockCov);

const tick = () => require('../../src/jobs/coverage-check').tick();
const BREACH = {
    ruleId: 1,
    name: 'R',
    severity: 'critical',
    qualifiedHeadcount: 0,
    minHeadcount: 2,
    minLevel: 2,
    skillName: 'S',
    requireValidCert: false,
    lastSatisfied: true,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockCov.evaluateAll.mockResolvedValue({ evaluated: 0, newlyBreached: [], recovered: [] });
    mockCov.predictAndPersist.mockResolvedValue({ predicted: 0, newlyPredicted: [] });
    mockCov.alertAudienceFor.mockResolvedValue([
        { userType: 'employee', userId: 7, via: 'manager' },
    ]);
});

describe('J3 — an undelivered coverage alert re-opens its transition for retry', () => {
    test('a soft notify failure re-opens the breach to its prior watermark', async () => {
        mockCov.evaluateAll.mockResolvedValue({
            evaluated: 1,
            newlyBreached: [BREACH],
            recovered: [],
        });
        mockNotify.mockResolvedValue({ inapp: 'error' }); // delivered nothing, did NOT throw
        await tick();
        expect(mockCov.reopenTransition).toHaveBeenCalledWith(1, true);
    });

    test('a thrown notify also re-opens the breach', async () => {
        mockCov.evaluateAll.mockResolvedValue({
            evaluated: 1,
            newlyBreached: [BREACH],
            recovered: [],
        });
        mockNotify.mockRejectedValue(new Error('bus down'));
        await tick();
        expect(mockCov.reopenTransition).toHaveBeenCalledWith(1, true);
    });

    test('a delivered breach alert is NOT re-opened (exactly-once holds)', async () => {
        mockCov.evaluateAll.mockResolvedValue({
            evaluated: 1,
            newlyBreached: [BREACH],
            recovered: [],
        });
        mockNotify.mockResolvedValue({ inapp: 'queued' });
        await tick();
        expect(mockCov.reopenTransition).not.toHaveBeenCalled();
    });

    test('an undelivered PREDICTED alert re-opens to its prior predicted date', async () => {
        mockCov.predictAndPersist.mockResolvedValue({
            predicted: 1,
            newlyPredicted: [
                {
                    id: 2,
                    name: 'P',
                    prev: '2026-09-10',
                    firstBreachOn: '2026-09-15',
                    worstQualified: 1,
                    minHeadcount: 3,
                    severity: 'warn',
                    createdBy: null,
                },
            ],
        });
        mockNotify.mockResolvedValue({ inapp: 'error' });
        await tick();
        expect(mockCov.reopenPrediction).toHaveBeenCalledWith(2, '2026-09-10');
    });
});
