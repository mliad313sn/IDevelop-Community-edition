'use strict';

// EntitlementService — the appliance-per-customer licensing layer. These lock the
// soft-enforcement contract: no license = unmanaged/unlimited, over-seat/expired
// only WARN, and the hard seat cap blocks new employees ONLY when explicitly on.
let settings;
const mockDb = { get: jest.fn() };
const mockSettings = { getValue: jest.fn((k, d) => (k in settings ? settings[k] : d)) };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const svc = require('../../src/services/EntitlementService');

function setSeatsUsed(n) {
    mockDb.get.mockResolvedValue({ n });
}

beforeEach(() => {
    settings = {};
    mockDb.get.mockReset();
    setSeatsUsed(0);
    svc.invalidate();
    delete process.env.LICENSE_JSON;
});

describe('EntitlementService', () => {
    test('no license → unmanaged, unlimited, no warning', async () => {
        const s = await svc.status(true);
        expect(s.unmanaged).toBe(true);
        expect(s.warn).toBe(false);
        expect(s.seats).toBeNull();
        await expect(svc.isFeatureEnabled('anything')).resolves.toBe(true);
    });

    test('seats exceeded → overSeat + warn (but still valid; soft)', async () => {
        settings.license = JSON.stringify({ customer: 'ACME', seats: 2, features: ['*'] });
        setSeatsUsed(3);
        const s = await svc.status(true);
        expect(s.overSeat).toBe(true);
        expect(s.warn).toBe(true);
        expect(s.seatsRemaining).toBe(0);
        expect(s.customer).toBe('ACME');
    });

    test('expired license → expired + warn', async () => {
        settings.license = JSON.stringify({
            customer: 'ACME',
            seats: 100,
            expiresOn: '2000-01-01',
        });
        const s = await svc.status(true);
        expect(s.expired).toBe(true);
        expect(s.warn).toBe(true);
        expect(s.valid).toBe(false);
    });

    test('feature gating: only listed modules enabled when not wildcard', async () => {
        settings.license = JSON.stringify({ customer: 'ACME', features: ['dashboard', 'reports'] });
        await expect(svc.isFeatureEnabled('dashboard')).resolves.toBe(true);
        await expect(svc.isFeatureEnabled('lms')).resolves.toBe(false);
    });

    test('canAddEmployee: at cap, soft (default) → allowed with warn', async () => {
        settings.license = JSON.stringify({ customer: 'ACME', seats: 2 });
        setSeatsUsed(2);
        const g = await svc.canAddEmployee();
        expect(g.ok).toBe(true);
    });

    test('canAddEmployee: at cap, hard cap on → blocked', async () => {
        settings.license = JSON.stringify({ customer: 'ACME', seats: 2 });
        settings.enforceSeatLimit = 'true';
        setSeatsUsed(2);
        const g = await svc.canAddEmployee();
        expect(g.ok).toBe(false);
        expect(g.reason).toMatch(/seat limit/i);
    });

    test('unmanaged never blocks employee creation even with hard cap flag', async () => {
        settings.enforceSeatLimit = 'true';
        setSeatsUsed(9999);
        await expect(svc.canAddEmployee()).resolves.toEqual({ ok: true });
    });

    test('malformed license JSON falls back to unmanaged (never wedges the appliance)', async () => {
        settings.license = '{ not valid json';
        const s = await svc.status(true);
        expect(s.unmanaged).toBe(true);
    });
});
