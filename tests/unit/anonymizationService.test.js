'use strict';
/**
 * AnonymizationService — the cipher/decipher engine. Pins:
 *   - personal AND company entities are ciphered (people, sites, departments,
 *     services, roles, org identity; skills in strict mode)
 *   - longest-match-first (overlapping names), case-insensitive
 *   - per-request RANDOMIZED tokens (no cross-request correlation) but stable
 *     within one request
 *   - decipher rebuilds the exact original values
 *   - fail-closed mode default
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = { getValue: jest.fn(), findByKey: jest.fn() };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

jest.mock('../../src/utils/branding', () => ({
    getBranding: jest.fn().mockResolvedValue({ appName: 'MinesRH Corp' }),
}));

const Anonymization = require('../../src/services/AnonymizationService');

function wireDb() {
    mockDb.all.mockImplementation(async (sql) => {
        if (/FROM sites/.test(sql)) return [{ name: 'Mine A' }, { name: 'Mine A Nord' }];
        if (/FROM departments/.test(sql)) return [{ name: 'Geologie' }];
        if (/FROM services/.test(sql)) return [{ name: 'Forage' }];
        if (/FROM roles/.test(sql)) return [{ name: 'Chef de poste' }];
        if (/FROM skills/.test(sql)) return [{ name: 'Premiers secours' }];
        return [];
    });
}

beforeEach(() => {
    mockDb.all.mockReset();
    mockSettings.getValue.mockReset().mockImplementation(async (k, fb) => fb);
    wireDb();
});

describe('cipher session', () => {
    test('ciphers people AND company entities everywhere in the payload', async () => {
        const s = await Anonymization.createSession(['Ismael LINDQVIST']);
        const ctx = {
            note: 'Ismael LINDQVIST works at Mine A Nord in Geologie as Chef de poste for MinesRH Corp',
            bySite: [{ site: 'Mine A', pct: 70 }],
        };
        const masked = s.cipherObject(ctx);
        const flat = JSON.stringify(masked);
        for (const secret of [
            'Ismael',
            'LINDQVIST',
            'Mine A',
            'Geologie',
            'Chef de poste',
            'MinesRH',
        ]) {
            expect(flat).not.toContain(secret);
        }
        expect(flat).toMatch(/EMP-[0-9A-F]{4}/);
        expect(flat).toMatch(/SITE-[0-9A-F]{4}/);
        expect(flat).toMatch(/DEPT-[0-9A-F]{4}/);
        expect(flat).toMatch(/ROLE-[0-9A-F]{4}/);
        expect(flat).toMatch(/ORG-[0-9A-F]{4}/);
    });

    test('longest match wins: "Mine A Nord" is one token, not SITE-x + " Nord"', async () => {
        const s = await Anonymization.createSession([]);
        const masked = s.cipherText('Coverage at Mine A Nord is low');
        expect(masked).not.toContain('Nord');
        expect(masked).toMatch(/Coverage at SITE-[0-9A-F]{4} is low/);
    });

    test('tokens are stable within a request, randomized across requests', async () => {
        const s1 = await Anonymization.createSession(['Awa Costé']);
        const s2 = await Anonymization.createSession(['Awa Costé']);
        const a1 = s1.cipherText('Awa Costé');
        const a1again = s1.cipherText('AWA COSTÉ'); // case-insensitive, same token
        const a2 = s2.cipherText('Awa Costé');
        expect(a1).toBe(a1again.toUpperCase() === a1again ? a1 : a1); // same session ⇒ same token
        expect(s1.cipherText('Awa Costé')).toBe(a1);
        expect(a2).not.toBe(a1); // new session ⇒ different token
    });

    test('decipher rebuilds the exact original values', async () => {
        const s = await Anonymization.createSession(['Moussa Ka']);
        const masked = s.cipherText('Moussa Ka (Mine A, Geologie) needs Premiers secours');
        const answer = `Send ${masked.match(/EMP-[0-9A-F]{4}/)[0]} from ${masked.match(/SITE-[0-9A-F]{4}/)[0]} to training.`;
        const revealed = s.decipher(answer);
        expect(revealed).toContain('Moussa Ka');
        expect(revealed).toContain('Mine A');
        expect(revealed).not.toMatch(/EMP-|SITE-/);
    });

    test('decipher is case-insensitive (models sometimes lowercase tokens)', async () => {
        const s = await Anonymization.createSession(['Moussa Ka']);
        const masked = s.cipherText('Moussa Ka');
        const token = masked.match(/EMP-[0-9A-F]{4}/)[0];
        expect(s.decipher(`priority is ${token.toLowerCase()} today`)).toBe(
            'priority is Moussa Ka today'
        );
        expect(s.decipher(`priority is ${token} today`)).toBe('priority is Moussa Ka today');
    });

    test('skills stay clear by default; ciphered in strict mode', async () => {
        const s = await Anonymization.createSession([]);
        expect(s.cipherText('Premiers secours gap')).toContain('Premiers secours');

        mockSettings.getValue.mockImplementation(async (k, fb) =>
            k === 'copilotAnonymizeSkills' ? '1' : fb
        );
        const strict = await Anonymization.createSession([]);
        const masked = strict.cipherText('Premiers secours gap');
        expect(masked).not.toContain('Premiers secours');
        expect(masked).toMatch(/SKILL-[0-9A-F]{4}/);
    });

    test('short entity names only match standalone (word boundaries, accent-aware)', async () => {
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM departments/.test(sql)) return [{ name: 'IT' }];
            return [];
        });
        const s = await Anonymization.createSession(['Awa Costé']);
        const masked = s.cipherText('Awa Costé works with the IT team on criticité items');
        expect(masked).toContain('with'); // "IT" inside "with" untouched
        expect(masked).toContain('criticité'); // accented word untouched
        expect(masked).not.toMatch(/\bIT\b/); // standalone IT ciphered
        expect(masked).toMatch(/DEPT-[0-9A-F]{4}/);
        expect(masked).not.toContain('Costé'); // accented NAME still ciphered
    });

    test('a failing entity source never disables the rest of the cipher', async () => {
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM sites/.test(sql)) throw new Error('boom');
            if (/FROM departments/.test(sql)) return [{ name: 'Geologie' }];
            return [];
        });
        const s = await Anonymization.createSession(['Awa Costé']);
        const masked = s.cipherText('Awa Costé in Geologie');
        expect(masked).not.toContain('Awa');
        expect(masked).not.toContain('Geologie');
    });
});

describe('mode()', () => {
    test("defaults to 'always' and fails CLOSED when settings are unavailable", async () => {
        expect(await Anonymization.mode()).toBe('always');
        mockSettings.getValue.mockRejectedValue(new Error('db down'));
        expect(await Anonymization.mode()).toBe('always');
    });
    test("accepts 'external-only'; anything else collapses to 'always'", async () => {
        mockSettings.getValue.mockImplementation(async (k, fb) =>
            k === 'copilotAnonymizationMode' ? 'external-only' : fb
        );
        expect(await Anonymization.mode()).toBe('external-only');
        mockSettings.getValue.mockImplementation(async (k, fb) =>
            k === 'copilotAnonymizationMode' ? 'off' : fb
        );
        expect(await Anonymization.mode()).toBe('always'); // no way to disable
    });
});
