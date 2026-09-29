'use strict';

/**
 * Re-audit J11 — certsExpiring90d wrote 0 for a scope that tracks NO certificates
 * at all. COUNT(*) over an empty register is 0, and the docstring promises null
 * (unknown) there — 0 reads as "a clean bill of health", and the value is
 * delta-eligible, so the phantom 0 would later drive a spurious "improvement".
 * Now: an empty register is null; a register with rows but none expiring is a
 * real 0.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockGet = jest.fn();
jest.mock('../../src/config/database', () => ({
    get: (...a) => mockGet(...a),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
}));

const { safeCertExpiring } = require('../../src/jobs/kpi-snapshot').__test;

beforeEach(() => mockGet.mockReset());

describe('J11 — an empty certificate register is unknown, not zero', () => {
    test('no certificates tracked in scope → null (unknown)', async () => {
        mockGet.mockResolvedValue({ expiring: null, total: 0 });
        expect(await safeCertExpiring({}, null)).toBeNull();
    });

    test('register has rows but none expiring in 90 days → a real 0', async () => {
        mockGet.mockResolvedValue({ expiring: 0, total: 42 });
        expect(await safeCertExpiring({}, null)).toBe(0);
    });

    test('some expiring → the count', async () => {
        mockGet.mockResolvedValue({ expiring: 7, total: 42 });
        expect(await safeCertExpiring({}, 3)).toBe(7);
    });

    test('a query error is unknown, never a fabricated 0', async () => {
        mockGet.mockRejectedValue(new Error('view missing'));
        expect(await safeCertExpiring({}, null)).toBeNull();
    });

    test('the query counts the whole register, not only certs with an expiry date', async () => {
        mockGet.mockResolvedValue({ expiring: 0, total: 5 });
        await safeCertExpiring({}, null);
        const sql = mockGet.mock.calls[0][0];
        // total = COUNT(*) with no days_to_expiry filter in the WHERE
        expect(sql).toMatch(/COUNT\(\*\) AS total/);
        expect(sql).not.toMatch(/WHERE c\.days_to_expiry IS NOT NULL/);
    });
});
