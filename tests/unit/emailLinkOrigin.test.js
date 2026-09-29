'use strict';

/**
 * Regression tests for the origin of absolute links in outgoing email.
 *
 * Found by a Semgrep pass (raw-html-format on the password-reset mail), which
 * led to the real defect: the reset link was built from `req.get('host')`.
 * That header is supplied by whoever made the request, so an attacker could
 * POST a reset for a VICTIM's account with `Host: evil.test` and the platform
 * would mail the victim a genuine link pointing at the attacker — clicking it
 * hands over a valid single-use reset token.
 *
 * These tests pin the fix: the Host header is only ever honoured when it is on
 * an explicit allowlist, and both documented env names resolve.
 */

// absUrl is a pure string function, but NotificationService pulls the DB config
// in transitively — mock it out the way the other unit suites do.
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
}));

const T = require('../../src/utils/emailTemplate');

/** Minimal express-request stand-in: only protocol + get('host') are read. */
function fakeReq(host, protocol = 'http') {
    return { protocol, get: (h) => (String(h).toLowerCase() === 'host' ? host : undefined) };
}

describe('email link origin (host-header injection)', () => {
    const saved = {};
    const VARS = ['APP_BASE_URL', 'BASE_URL', 'TRUSTED_HOSTS', 'PORT'];

    beforeEach(() => {
        VARS.forEach((k) => {
            saved[k] = process.env[k];
            delete process.env[k];
        });
    });
    afterEach(() => {
        VARS.forEach((k) => {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        });
    });

    test('an attacker-supplied Host header is NEVER used as the link origin', () => {
        const url = T.baseUrl(fakeReq('evil.test'));
        expect(url).not.toContain('evil.test');
    });

    test('a poisoned Host cannot override an explicitly configured base URL', () => {
        process.env.APP_BASE_URL = 'https://hr.company.local';
        expect(T.baseUrl(fakeReq('evil.test'))).toBe('https://hr.company.local');
    });

    test('X-Forwarded-Host style takeover via Host is refused even with an allowlist set', () => {
        process.env.TRUSTED_HOSTS = 'hr.company.local';
        expect(T.baseUrl(fakeReq('evil.test'))).not.toContain('evil.test');
    });

    test('an allowlisted host IS honoured, preserving multi-hostname installs', () => {
        process.env.TRUSTED_HOSTS = 'hr.company.local,hr2.company.local:3000';
        expect(T.baseUrl(fakeReq('hr.company.local', 'https'))).toBe('https://hr.company.local');
        expect(T.baseUrl(fakeReq('hr2.company.local:3000'))).toBe('http://hr2.company.local:3000');
    });

    test('allowlist matching is exact — a lookalike suffix does not match', () => {
        process.env.TRUSTED_HOSTS = 'company.local';
        // 'evil-company.local' merely ENDS WITH the trusted value.
        expect(T.baseUrl(fakeReq('evil-company.local'))).not.toContain('evil-company.local');
    });

    test('APP_BASE_URL and BASE_URL both resolve (the two names were split)', () => {
        process.env.APP_BASE_URL = 'https://a.example';
        expect(T.baseUrl()).toBe('https://a.example');
        delete process.env.APP_BASE_URL;
        process.env.BASE_URL = 'https://b.example';
        expect(T.baseUrl()).toBe('https://b.example');
    });

    test('a trailing slash never produces a double slash in the final link', () => {
        process.env.APP_BASE_URL = 'https://hr.company.local///';
        expect(`${T.baseUrl()}/reset-password`).toBe('https://hr.company.local/reset-password');
    });

    test('with nothing configured the origin is still absolute (clickable in mail)', () => {
        expect(T.baseUrl()).toMatch(/^https?:\/\/.+/);
    });

    test('NotificationService.absUrl honours the documented APP_BASE_URL', () => {
        // It previously read only BASE_URL, so an admin who set the documented
        // name got a bare relative path — unclickable in an email client.
        process.env.APP_BASE_URL = 'https://hr.company.local';
        const NotificationService = require('../../src/services/NotificationService');
        expect(NotificationService.absUrl('/cycles')).toBe('https://hr.company.local/cycles');
    });

    test('absUrl leaves an already-absolute link untouched', () => {
        process.env.APP_BASE_URL = 'https://hr.company.local';
        const NotificationService = require('../../src/services/NotificationService');
        expect(NotificationService.absUrl('https://elsewhere.example/x')).toBe(
            'https://elsewhere.example/x'
        );
    });
});

describe('AES-GCM auth tag length is pinned', () => {
    const crypto = require('crypto');

    test('secretBox rejects a truncated auth tag instead of decrypting', () => {
        const saved = process.env.APP_KEY;
        process.env.APP_KEY = 'x'.repeat(48);
        jest.resetModules();
        const secretBox = require('../../src/utils/secretBox');
        const enc = secretBox.encrypt('super-secret-value');
        expect(secretBox.decrypt(enc)).toBe('super-secret-value');

        // Truncate the tag segment: unpinned, Node would accept a short GCM tag.
        const [prefixIv, tagB, ctB] = [enc.split(':')[2], enc.split(':')[3], enc.split(':')[4]];
        const shortTag = crypto.randomBytes(8).toString('base64');
        const tampered = `enc:v1:${prefixIv}:${shortTag}:${ctB}`;
        expect(() => secretBox.decrypt(tampered)).toThrow();
        expect(tagB).toBeTruthy();

        if (saved === undefined) delete process.env.APP_KEY;
        else process.env.APP_KEY = saved;
        jest.resetModules();
    });
});
