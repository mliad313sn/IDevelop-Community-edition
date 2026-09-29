'use strict';

/**
 * Access profiles + access duration.
 *
 * Two failures are pinned here, both measured on the live install:
 *
 *  (a) `admin_permissions` held ZERO rows. 25 local admins and 7 viewers had a
 *      scope and no capability, because granting meant hand-ticking 29 boxes.
 *      Access profiles are the fix, so a profile that names a slug the catalogue
 *      does not define must be a BOOT failure, not a silently thinner grant.
 *
 *  (b) `_parseExpiry` returned null — which means PERMANENT — for an unreadable
 *      or already-past end date. Asking for a bounded delegation and typing a
 *      bad date therefore minted a never-expiring one. It must now fail closed.
 */

// Requiring the controller pulls in src/config/database, which refuses to load
// without a DATABASE_URL. Stub the driver rather than setting the env var: env
// changes leak across every suite sharing this jest worker, and the helpers
// under test are pure — they never touch a connection.
jest.mock('../../src/config/database', () => ({
    all: jest.fn(async () => []),
    get: jest.fn(async () => null),
    run: jest.fn(async () => ({ changes: 0 })),
    runTransaction: jest.fn(async (fn) => fn()),
    _client: jest.fn(),
}));

const accessProfiles = require('../../src/config/accessProfiles');
const { ALL_SLUGS, isWrite, isValidSlug } = require('../../src/config/permissions');
const { parseExpiry, EXPIRY_INVALID, resolveGrantedPermissions } =
    require('../../src/controllers/AdminController')._internals;

const EXPECTED_KEYS = [
    'site_hr',
    'dept_lead',
    'training_coord',
    'country_hrbp',
    'governance_read',
    'data_steward',
];

describe('access profiles — the primary granting control', () => {
    test('the six operating profiles exist, in a stable order', () => {
        expect(accessProfiles.PROFILE_KEYS).toEqual(EXPECTED_KEYS);
    });

    test.each(EXPECTED_KEYS)('%s only names slugs the catalogue defines', (key) => {
        const p = accessProfiles.byKey(key);
        expect(p).toBeTruthy();
        expect(p.slugs.length).toBeGreaterThan(0);
        for (const slug of p.slugs) {
            expect(isValidSlug(slug)).toBe(true);
            expect(ALL_SLUGS).toContain(slug);
        }
    });

    test.each(EXPECTED_KEYS)(
        '%s is fully specified (fr+en, role, scope grain, duration)',
        (key) => {
            const p = accessProfiles.byKey(key);
            expect(typeof p.label.fr).toBe('string');
            expect(typeof p.label.en).toBe('string');
            expect(typeof p.description.fr).toBe('string');
            expect(typeof p.description.en).toBe('string');
            expect(['localadmin', 'viewer']).toContain(p.role);
            expect(['site', 'department', 'service', 'country']).toContain(p.defaultScopeType);
            expect(p.defaultDays).toBeGreaterThan(0);
        }
    );

    test('a viewer profile never carries a write capability (the role cannot use one)', () => {
        for (const p of accessProfiles.ACCESS_PROFILES.filter((x) => x.role === 'viewer')) {
            const writes = p.slugs.filter(isWrite);
            expect(writes).toEqual([]);
        }
    });

    test('an unknown slug in a profile is a BOOT failure, not a thin grant', () => {
        jest.isolateModules(() => {
            jest.doMock('../../src/config/permissions', () => {
                const real = jest.requireActual('../../src/config/permissions');
                // Pretend the catalogue never defined `approve_assessments`.
                const gone = 'approve_assessments';
                return {
                    ...real,
                    ALL_SLUGS: real.ALL_SLUGS.filter((s) => s !== gone),
                    isValidSlug: (s) => s !== gone && real.isValidSlug(s),
                };
            });
            expect(() => require('../../src/config/accessProfiles')).toThrow(
                /unknown permission "approve_assessments"/
            );
        });
        jest.dontMock('../../src/config/permissions');
    });

    test('localize() clamps a profile to what the granter may actually grant', () => {
        const clamped = accessProfiles.localize('fr', ['view_roles', 'view_domains_skills']);
        const siteHr = clamped.find((p) => p.key === 'site_hr');
        expect(siteHr.slugs.sort()).toEqual(['view_domains_skills', 'view_roles']);
        expect(siteHr.partial).toBe(true);
        expect(siteHr.total).toBe(accessProfiles.byKey('site_hr').slugs.length);

        // A granter who holds none of a bundle is told so rather than shown an
        // option that would grant nothing.
        const none = accessProfiles.localize('fr', []).find((p) => p.key === 'country_hrbp');
        expect(none.unavailable).toBe(true);
    });

    test('localize() renders FR by default and EN on request', () => {
        expect(accessProfiles.localize('fr')[0].label).toBe('Chargé RH de site');
        expect(accessProfiles.localize('en')[0].label).toBe('Site HR officer');
        expect(accessProfiles.localize('de')[0].label).toBe('Chargé RH de site'); // FR is the fallback
    });

    test('"custom" is reserved and never resolves to a profile', () => {
        expect(accessProfiles.isProfileKey('custom')).toBe(false);
        expect(accessProfiles.byKey('custom')).toBeNull();
        expect(accessProfiles.slugsFor('custom')).toEqual([]);
        expect(accessProfiles.slugsFor('nope')).toEqual([]);
    });
});

describe('access duration — _parseExpiry fails closed', () => {
    const future = () => new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 16);

    test('an explicit "permanent" choice is permanent (null)', () => {
        expect(parseExpiry({ body: { accessDurationMode: 'permanent' } })).toBeNull();
        // …even if a stale date is still sitting in the disabled field.
        expect(
            parseExpiry({ body: { accessDurationMode: 'permanent', accessExpiresAt: future() } })
        ).toBeNull();
    });

    test('a valid future date becomes an ISO expiry', () => {
        const out = parseExpiry({
            body: { accessDurationMode: 'until', accessExpiresAt: future() },
        });
        expect(typeof out).toBe('string');
        expect(new Date(out).getTime()).toBeGreaterThan(Date.now());
    });

    test('an ALREADY-PAST date is refused, never read as permanent', () => {
        const past = new Date(Date.now() - 86400000).toISOString().slice(0, 16);
        expect(parseExpiry({ body: { accessDurationMode: 'until', accessExpiresAt: past } })).toBe(
            EXPIRY_INVALID
        );
        expect(parseExpiry({ body: { accessExpiresAt: past } })).toBe(EXPIRY_INVALID);
    });

    test('an unparseable date is refused, never read as permanent', () => {
        expect(
            parseExpiry({ body: { accessDurationMode: 'until', accessExpiresAt: 'demain' } })
        ).toBe(EXPIRY_INVALID);
        expect(parseExpiry({ body: { accessExpiresAt: '31/02/2027' } })).toBe(EXPIRY_INVALID);
    });

    test('"until" with no date typed is refused rather than silently permanent', () => {
        expect(parseExpiry({ body: { accessDurationMode: 'until', accessExpiresAt: '' } })).toBe(
            EXPIRY_INVALID
        );
        expect(parseExpiry({ body: { accessDurationMode: 'until' } })).toBe(EXPIRY_INVALID);
    });

    test('a body with no duration fields at all keeps the legacy blank = permanent reading', () => {
        expect(parseExpiry({ body: {} })).toBeNull();
        expect(parseExpiry({})).toBeNull();
    });
});

describe('profile application stores a snapshot through permissions[]', () => {
    const superadmin = { id: 1, role: 'superadmin', userType: 'admin' };

    test('the posted checkbox snapshot is what gets stored', () => {
        const r = resolveGrantedPermissions(superadmin, 'localadmin', {
            accessProfile: 'site_hr',
            apProfileApplied: '1',
            permissions: ['view_roles', 'export_data'],
        });
        expect(r.perms.sort()).toEqual(['export_data', 'view_roles']);
        expect(r.profileKey).toBe('site_hr');
        expect(r.expandedServerSide).toBe(false);
    });

    test('without the page script (no JS) the named profile is expanded server-side', () => {
        const r = resolveGrantedPermissions(superadmin, 'localadmin', {
            accessProfile: 'dept_lead',
        });
        expect(r.perms.sort()).toEqual([...accessProfiles.slugsFor('dept_lead')].sort());
        expect(r.expandedServerSide).toBe(true);
    });

    test('an unknown profile key is ignored, not trusted', () => {
        const r = resolveGrantedPermissions(superadmin, 'localadmin', {
            accessProfile: '../../etc/passwd',
        });
        expect(r.profileKey).toBeNull();
        expect(r.perms).toEqual([]);
    });

    test('a viewer never receives the write half of a profile', () => {
        const r = resolveGrantedPermissions(superadmin, 'viewer', { accessProfile: 'site_hr' });
        expect(r.perms.filter(isWrite)).toEqual([]);
        expect(r.perms).toContain('view_roles');
    });

    test('a delegate cannot exceed their own grants by naming a profile', () => {
        const delegate = {
            id: 2,
            role: 'localadmin',
            userType: 'admin',
            permissions: ['manage_admins', 'view_compliance'],
        };
        const r = resolveGrantedPermissions(delegate, 'localadmin', {
            accessProfile: 'country_hrbp',
        });
        expect(r.perms).toEqual(['view_compliance']);
    });
});
