'use strict';
/**
 * Web security baseline of server.js, pinned so that the About page's
 * "Web application protection" claims stay true:
 *  - a fresh CSP nonce per request, and no 'unsafe-inline' for scripts;
 *  - objects blocked, base-uri and form-action locked, anti-clickjacking;
 *  - httpOnly, SameSite session cookies with a bounded lifetime;
 *  - bounded request bodies;
 *  - CSRF synchroniser tokens that refuse a forged request with 403;
 *  - proxies not trusted unless the operator says so.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
const directive = (name) => {
    const m = SRC.match(new RegExp(`${name}:\\s*\\[([^\\]]*)\\]`));
    return m ? m[1] : null;
};

describe('Content Security Policy', () => {
    test('a new 128-bit nonce is minted for every request', () => {
        expect(SRC).toMatch(/res\.locals\.cspNonce\s*=\s*crypto\.randomBytes\(16\)/);
    });
    test('scripts need the nonce; inline <script> without it never runs', () => {
        const s = directive('scriptSrc');
        expect(s).toMatch(/'nonce-\$\{res\.locals\.cspNonce\}'/);
        expect(s).not.toMatch(/unsafe-inline|unsafe-eval/);
    });
    test('objects blocked, base-uri, form-action and framing locked to self', () => {
        expect(directive('objectSrc')).toMatch(/'none'/);
        expect(directive('baseUri')).toMatch(/^\s*"'self'"\s*$/);
        expect(directive('formAction')).toMatch(/^\s*"'self'"\s*$/);
        expect(directive('frameAncestors')).toMatch(/^\s*"'self'"\s*$/);
        expect(directive('defaultSrc')).toMatch(/^\s*"'self'"\s*$/);
    });
    test('no third-party origin unless external fonts are explicitly enabled', () => {
        expect(directive('connectSrc')).toMatch(/^\s*"'self'"\s*$/);
        expect(SRC).toMatch(/ENABLE_EXTERNAL_FONTS === '1'/);
    });
});

describe('session cookie', () => {
    test('httpOnly, SameSite and a bounded lifetime', () => {
        const cookie = SRC.slice(SRC.indexOf('cookie: {'), SRC.indexOf('cookie: {') + 400);
        expect(cookie).toMatch(/httpOnly:\s*true/);
        expect(cookie).toMatch(/sameSite:\s*'(lax|strict)'/);
        expect(cookie).toMatch(/maxAge:\s*Number\(process\.env\.SESSION_MAX_HOURS \|\| 24\)/);
    });
    test('proxies are not trusted by default', () => {
        expect(SRC).toMatch(/app\.set\('trust proxy', false\)/);
    });
});

describe('request bodies and CSRF', () => {
    test('JSON and form bodies are capped', () => {
        expect(SRC).toMatch(
            /express\.json\(\{\s*limit:\s*process\.env\.JSON_BODY_LIMIT \|\| '1mb'/
        );
        expect(SRC).toMatch(
            /express\.urlencoded\(\{[^}]*limit:\s*process\.env\.FORM_BODY_LIMIT \|\| '1mb'/
        );
    });
    test('state-changing requests carry a synchroniser token or get 403', () => {
        expect(SRC).toMatch(/csrfSync\(/);
        expect(SRC).toMatch(/req\.body\._csrf\)\s*\|\|\s*req\.headers\['x-csrf-token'\]/);
        expect(SRC).toMatch(/status\(403\)\.send\('Invalid CSRF token'\)/);
    });
});
