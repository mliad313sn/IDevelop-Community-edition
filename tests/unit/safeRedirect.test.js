'use strict';
const { safeBackUrl } = require('../../src/utils/safeRedirect');

// Minimal req stub: get('Referer')/get('host').
const req = (referer, host = 'app.example.com') => ({
    get: (h) => (h === 'host' ? host : h === 'Referer' ? referer : undefined),
});

describe('safeBackUrl — open-redirect guard (CWE-601)', () => {
    test('same-origin Referer → relative path only (host stripped)', () => {
        expect(safeBackUrl(req('https://app.example.com/employees?page=2'))).toBe(
            '/employees?page=2'
        );
    });

    test('cross-origin Referer → fallback, never the attacker URL', () => {
        expect(safeBackUrl(req('https://evil.com/phish'))).toBe('/dashboard');
    });

    test('look-alike host (suffix trick) → fallback', () => {
        expect(safeBackUrl(req('https://app.example.com.evil.com/x'))).toBe('/dashboard');
    });

    test('missing Referer → fallback', () => {
        expect(safeBackUrl(req(undefined))).toBe('/dashboard');
    });

    test('malformed Referer → fallback', () => {
        expect(safeBackUrl(req('http://['))).toBe('/dashboard');
    });

    test('custom fallback is honored', () => {
        expect(safeBackUrl(req(undefined), '/')).toBe('/');
    });

    test('protocol-relative // is not treated as same-origin', () => {
        // new URL('//evil.com') throws without a base → fallback (never bounces off-site)
        expect(safeBackUrl(req('//evil.com/x'))).toBe('/dashboard');
    });
});
