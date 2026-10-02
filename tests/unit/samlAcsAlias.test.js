'use strict';

/**
 * SAML reply URL (ACS).
 *
 * A reply URL saved on the SSO page as ".../auth/saml/saml/callback" (a typo
 * of the canonical ".../auth/sso/saml/callback") was registered in the IdP. The
 * SSO page then handed that wrong value back as the one to paste. It must
 * always show the canonical ACS.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));

const SamlMetadataService = require('../../src/services/SamlMetadataService');

test('the SSO page always shows the canonical reply URL to paste into the IdP', () => {
    const v = SamlMetadataService.spValues('https://app.example.com', {
        callbackUrl: 'https://app.example.com/auth/saml/saml/callback',
    });
    expect(v.acsUrl).toBe('https://app.example.com/auth/sso/saml/callback');
});

test('without a configured value the canonical ACS is shown too', () => {
    const v = SamlMetadataService.spValues('https://app.example.com/');
    expect(v.acsUrl).toBe('https://app.example.com/auth/sso/saml/callback');
});
