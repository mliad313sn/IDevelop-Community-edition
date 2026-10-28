'use strict';
/**
 * A refused SAML response is classified (signature, audience, issuer, clock,
 * InResponseTo) and each class names the next step on the test sign-in page and
 * in the SSO_ERROR audit line, in French and English. The test-result page reads
 * admin:ssof_fail_<code>.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));

const fs = require('fs');
const path = require('path');
const ctrl = require('../../src/controllers/SsoController');
const fr = require('../../locales/fr/admin.json');
const en = require('../../locales/en/admin.json');

test.each([
    ['Invalid signature', 'sso_saml_signature'],
    ['Invalid document signature', 'sso_saml_signature'],
    ['SAML assertion audience mismatch', 'sso_saml_audience'],
    ['Unknown SAML issuer. Expected: x Received: y', 'sso_issuer'],
    ['SAML assertion expired: clocks skewed too much', 'sso_saml_clock'],
    ['NotBefore / NotOnOrAfter', 'sso_saml_clock'],
    ['InResponseTo is not valid', 'sso_saml_inresponseto'],
    ['something else', 'sso_saml_invalid'],
    ['SAML assertion not yet valid', 'sso_saml_clock'],
    ['SAML assertion expired: assertion too old', 'sso_saml_clock'],
    [
        'No valid subject confirmation found among those available in the SAML assertion',
        'sso_saml_clock',
    ],
    ['SubjectInResponseTo is not valid', 'sso_saml_inresponseto'],
    ['InResponseTo does not match subjectInResponseTo', 'sso_saml_inresponseto'],
    ["Error parsing NotBefore: 'x' is not a valid date", 'sso_saml_invalid'],
])('%s → %s', (msg, code) => {
    expect(ctrl._samlRefusalCode(new Error(msg))).toBe(code);
});

test('every code has an explanation in both languages; the signing option is named', () => {
    for (const code of [
        'sso_saml_signature',
        'sso_saml_audience',
        'sso_issuer',
        'sso_saml_clock',
        'sso_saml_inresponseto',
        'sso_saml_invalid',
    ]) {
        expect(fr[`ssof_fail_${code}`]).toBeTruthy();
        expect(en[`ssof_fail_${code}`]).toBeTruthy();
    }
    expect(en.ssof_fail_sso_saml_signature).toMatch(/Sign SAML response and assertion/);
    expect(fr.ssof_fail_sso_saml_signature).toMatch(/Signer la réponse et l’assertion SAML/);
});

test('the test sign-in and the SSO_ERROR audit line both use the classified cause', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/controllers/SsoController.js'),
        'utf8'
    );
    expect(src).toMatch(/code: samlRefusalCode\(err\),/);
    expect(src).toMatch(/\[\$\{samlRefusalCode\(err\)\}\]`/);
    expect(src).not.toMatch(/code: 'sso_saml_invalid',/);
});
