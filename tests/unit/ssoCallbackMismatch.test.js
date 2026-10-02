'use strict';
/**
 * SSO settings page: a SAML reply URL that is not <base>/auth/sso/saml/callback
 * (typically "…/login/auth/sso/saml/callback", from a base URL set to the sign-in
 * page) is named on the page, with the address to register instead.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const { _callbackMismatch: mismatch } = require('../../src/controllers/SsoSettingsController');

describe('callbackMismatch', () => {
    const base = 'https://hr.example.org';
    test('the canonical reply URL (any case, trailing slash) is not reported', () => {
        expect(mismatch('https://hr.example.org/auth/sso/saml/callback', base)).toBeNull();
        expect(mismatch('HTTPS://HR.example.org/auth/sso/saml/callback/', base + '/')).toBeNull();
    });
    test('nothing configured, or no base address: nothing to compare', () => {
        expect(mismatch('', base)).toBeNull();
        expect(mismatch(null, base)).toBeNull();
        expect(mismatch('https://x/auth/sso/saml/callback', '')).toBeNull();
    });
    test('a reply URL under /login is reported with the expected address', () => {
        expect(mismatch('https://hr.example.org/login/auth/sso/saml/callback', base)).toEqual({
            configured: 'https://hr.example.org/login/auth/sso/saml/callback',
            expected: 'https://hr.example.org/auth/sso/saml/callback',
        });
    });
});

describe('the warning on the page', () => {
    const view = fs.readFileSync(path.join(ROOT, 'views/pages/app-settings/sso.ejs'), 'utf8');
    test('is rendered only when there is a mismatch, escaped, in both languages', () => {
        const start = view.indexOf("<% if (typeof callbackMismatch !== 'undefined'");
        const end = view.indexOf('<% } %>', start) + '<% } %>'.length;
        const block = view.slice(start, end);
        const __ = (k, v) => `${k}|${v ? v.configured + '|' + v.expected : ''}`;
        const html = ejs.render(block, {
            __,
            callbackMismatch: { configured: 'https://h/<b>/x', expected: 'https://h/y' },
        });
        expect(html).toContain('data-sso-callback-mismatch');
        expect(html).toContain('https://h/&lt;b&gt;/x');
        expect(ejs.render(block, { __, callbackMismatch: null })).not.toContain('data-sso');
        for (const lng of ['fr', 'en']) {
            const j = JSON.parse(
                fs.readFileSync(path.join(ROOT, `locales/${lng}/admin.json`), 'utf8')
            );
            expect(j.ssof_callback_mismatch).toMatch(/\{\{configured\}\}.*\{\{expected\}\}/);
        }
    });
});
