'use strict';

/**
 * Re-audit J11 — certsExpiring90d wrote 0 for a scope that tracks NO certificates
 * at all. 0 reads as "a clean bill of health", and the value is delta-eligible,
 * so the phantom 0 would later drive a spurious "improvement".
 *
 * The snapshot now takes K8 from the KPI module: a scope where no certification
 * is REQUIRED is "not configured" and its two certificate columns are null
 * (unknown); a scope with required certificates and none expiring is a real 0.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

let mockRequired = [];
const mockAll = jest.fn(async (sql) => {
    if (/FROM employees e\s+LEFT JOIN sites/.test(sql))
        return [{ id: 1, siteId: 1, siteName: 'North', departmentId: 1, roleId: 1 }];
    if (/WITH pop AS/.test(sql)) return mockRequired;
    return [];
});
const mockGet = jest.fn(async (sql) => {
    if (/app_readiness_threshold/.test(sql)) return { t: 80 };
    if (/CURRENT_DATE, 'YYYY-MM-DD'/.test(sql)) return { d: '2026-10-15' };
    return { events: 0, firstMeasurements: 0 };
});
jest.mock('../../src/config/database', () => ({
    get: (...a) => mockGet(...a),
    all: (...a) => mockAll(...a),
    run: jest.fn(async () => ({})),
}));
jest.mock('../../src/services/SafetyGateService', () => ({ computeFor: jest.fn(async () => []) }));

const K = require('../../src/services/KpiService');

beforeEach(() => {
    mockRequired = [];
});

describe('J11 — no required certificate is unknown, not zero', () => {
    test('no certification required in scope → K8 not configured, value null', async () => {
        const r = await K.k8Certifications({ system: true });
        expect(r.status).toBe('not_configured');
        expect(r.value).toBeNull();
    });

    test('the snapshot writes null for both certificate columns, never 0', async () => {
        const m = await K.snapshotMetrics({ system: true });
        expect(m.certsExpiring90d).toBeNull();
        expect(m.certsExpired).toBeNull();
    });

    test('required certificates, none expiring within 90 days → a real 0', async () => {
        mockRequired = [{ employeeId: 1, skillId: 7, certId: 3, expiresOn: '2027-12-31' }];
        const m = await K.snapshotMetrics({ system: true });
        expect(m.certsExpiring90d).toBe(0);
        expect(m.certsExpired).toBe(0);
    });

    test('one expiring within 90 days → the count of PEOPLE', async () => {
        mockRequired = [
            { employeeId: 1, skillId: 7, certId: 3, expiresOn: '2026-11-01' },
            { employeeId: 1, skillId: 8, certId: 4, expiresOn: '2026-11-20' },
        ];
        const r = await K.k8Certifications({ system: true });
        expect(r.breakdown.expiringPeople).toBe(1);
        expect(r.breakdown.expiringCerts).toBe(2);
    });
});
