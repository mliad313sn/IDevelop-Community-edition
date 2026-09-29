'use strict';

// Invariant "core never gated": the core talent workflows (framework, assessment,
// readiness, 9-box, succession, IDP, SSO, reports) must never be behind an
// entitlement check, whatever the licence says. Entitlement may gate add-ons only.
let settings;
const mockDb = { get: jest.fn() };
const mockSettings = { getValue: jest.fn((k, d) => (k in settings ? settings[k] : d)) };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const svc = require('../../src/services/EntitlementService');

const EXPECTED_CORE = [
    'framework',
    'assessment',
    'readiness',
    'nine_box',
    'succession',
    'idp',
    'sso',
    'reports',
];

beforeEach(() => {
    settings = {};
    mockDb.get.mockReset();
    mockDb.get.mockResolvedValue({ n: 0 });
    svc.invalidate();
    delete process.env.LICENSE_JSON;
});

describe('EntitlementService — core never gated', () => {
    test('the service declares every core workflow as core', () => {
        expect(Array.isArray(svc.CORE_FEATURES)).toBe(true);
        expect(Object.isFrozen(svc.CORE_FEATURES)).toBe(true);
        for (const slug of EXPECTED_CORE) {
            expect(svc.CORE_FEATURES).toContain(slug);
            expect(svc.isCoreFeature(slug)).toBe(true);
            expect(svc.isCoreFeature(slug.toUpperCase())).toBe(true);
        }
    });

    test('a licence listing only an add-on still enables every core workflow', async () => {
        settings.license = JSON.stringify({ customer: 'ACME', seats: 5, features: ['addon_x'] });
        for (const slug of EXPECTED_CORE) {
            await expect(svc.isFeatureEnabled(slug)).resolves.toBe(true);
        }
        // …while an unlisted add-on IS gated — proof the licence was really applied.
        await expect(svc.isFeatureEnabled('addon_y')).resolves.toBe(false);
        await expect(svc.isFeatureEnabled('addon_x')).resolves.toBe(true);
    });

    test('an expired, over-seat licence still enables every core workflow', async () => {
        settings.license = JSON.stringify({
            customer: 'ACME',
            seats: 1,
            features: ['addon_x'],
            expiresOn: '2000-01-01',
        });
        mockDb.get.mockResolvedValue({ n: 50 });
        const s = await svc.status(true);
        expect(s.expired).toBe(true);
        expect(s.overSeat).toBe(true);
        for (const slug of EXPECTED_CORE) {
            await expect(svc.isFeatureEnabled(slug)).resolves.toBe(true);
        }
    });

    test('core answers without reading the licence at all', async () => {
        mockSettings.getValue.mockClear();
        mockDb.get.mockClear();
        await svc.isFeatureEnabled('succession');
        expect(mockSettings.getValue).not.toHaveBeenCalled();
        expect(mockDb.get).not.toHaveBeenCalled();
    });
});
