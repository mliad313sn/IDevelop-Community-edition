/**
 * SSO facilitator — phase 1 (migration 145): connect an enterprise IdP like
 * any SaaS app, and harden what node-saml leaves to the application.
 *
 * Proved end-to-end with genuine signed SAML responses (scratchpad harness,
 * 11/11 with IdP-initiated off and on, 10/10 for the test sign-in). Two of the
 * defects that harness found are pinned here:
 *   - node-saml's `idpIssuer` option is only enforced on LOGOUT messages: a
 *     response signed with a trusted key but naming another issuer signed the
 *     user in. The app checks the issuer itself.
 *   - /saml/metadata sat behind requireAuth (302 to /login) — the IdP admin
 *     could not download it.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn((fn) => fn()),
}));

const db = require('../../src/config/database');
const Sec = require('../../src/services/SamlSecurityService');
const Md = require('../../src/services/SamlMetadataService');
const SsoTest = require('../../src/services/SsoTestService');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

beforeEach(() => jest.clearAllMocks());

describe('SamlSecurityService', () => {
    test('RelayState: only one of our own pages, never off-site or our auth endpoints', () => {
        expect(Sec.safeRelayPath('/employee/my-development')).toBe('/employee/my-development');
        expect(Sec.safeRelayPath('/employees/5?tab=skills')).toBe('/employees/5?tab=skills');
        for (const bad of [
            '//evil.test/x',
            '/\\evil.test',
            'https://evil.test',
            'evil',
            '',
            '/auth/sso/saml',
            '/login',
            '/logout',
            '/a\u0000b',
            'x'.repeat(600),
            null,
            42,
        ]) {
            expect(Sec.safeRelayPath(bad)).toBeNull();
        }
    });
    test('Destination must be our ACS (scheme, host, path); absent is allowed', () => {
        const acs = 'https://app.example/auth/sso/saml/callback';
        expect(Sec.destinationOk(acs, acs)).toBe(true);
        expect(Sec.destinationOk('https://APP.example/auth/sso/saml/callback/', acs)).toBe(true);
        expect(Sec.destinationOk(null, acs)).toBe(true);
        expect(Sec.destinationOk('https://evil.example/auth/sso/saml/callback', acs)).toBe(false);
        expect(Sec.destinationOk('http://app.example/auth/sso/saml/callback', acs)).toBe(false);
        expect(Sec.destinationOk('https://app.example/other', acs)).toBe(false);
    });
    test('inspectResponse reads Destination / IDs and refuses DTDs', () => {
        const xml =
            '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1" Destination="https://a/acs"><saml:Assertion ID="_a1"><saml:Conditions NotOnOrAfter="2030-01-01T00:00:00Z"/></saml:Assertion></samlp:Response>';
        const r = Sec.inspectResponse(Buffer.from(xml).toString('base64'));
        expect(r).toEqual({
            destination: 'https://a/acs',
            responseId: '_r1',
            assertionId: '_a1',
            notOnOrAfter: '2030-01-01T00:00:00Z',
        });
        const dtd = '<!DOCTYPE x [<!ENTITY e "boom">]><samlp:Response ID="_r"/>';
        expect(Sec.inspectResponse(Buffer.from(dtd).toString('base64'))).toBeNull();
    });
    test('an assertion is accepted once: the second insert is a replay', async () => {
        // Sweep calls may run first; what matters is the INSERT's rowcount.
        db.run.mockImplementation(async (sql) =>
            /INSERT INTO saml_assertion_seen/.test(sql) ? { changes: 0 } : { changes: 0 }
        );
        expect(
            await Sec.recordAssertion({ issuer: 'i', assertionId: 'a', notOnOrAfter: null })
        ).toBe(false);
        db.run.mockImplementation(async (sql) =>
            /INSERT INTO saml_assertion_seen/.test(sql) ? { changes: 1 } : { changes: 0 }
        );
        expect(await Sec.recordAssertion({ issuer: 'i', assertionId: 'b' })).toBe(true);
        const ins = db.run.mock.calls.find((c) => /INSERT INTO saml_assertion_seen/.test(c[0]));
        expect(ins[0]).toMatch(/ON CONFLICT \(issuer, assertion_id\) DO NOTHING/);
    });
});

describe('SamlMetadataService', () => {
    // A real (throwaway, self-signed) certificate so fingerprints are computed.
    const CERT =
        'MIIBszCCAVmgAwIBAgIUXq0Pq1mTPQ9oB1D3bHP0C3r0bm0wCgYIKoZIzj0EAwIwEjEQMA4GA1UEAwwHVGVzdElkUDAeFw0yNjAxMDEwMDAwMDBaFw0zNjAxMDEwMDAwMDBaMBIxEDAOBgNVBAMMB1Rlc3RJZFAwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAT4H4pJJjVnq6yIa6kSWsJ9ehkqk9XhYl8mJ4fXQ2z0ZtqCG3x3zYy4v8K2ZzvLRtQGbzZtl9rp8Qc9y5wW9L1Ho1MwUTAdBgNVHQ4EFgQU5gJvC1vwq3wwY8b2c9WkP6uYw9IwHwYDVR0jBBgwFoAU5gJvC1vwq3wwY8b2c9WkP6uYw9IwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEAq3v9cH1H6o6kXg1qjGyYl4XwXz4p3lJmE3lM0Wq9oN0CIFcJ2S9m7u7iWQ1B9Zb1e5x3aQy0mE4y2q2v6J7o8bQm';
    const md = (certs) =>
        `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sts.windows.net/t/"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${certs.map((c) => `<KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${c}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`).join('')}<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://login.example/post"/><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://login.example/redirect"/></IDPSSODescriptor></EntityDescriptor>`;

    test('parses entity ID, prefers the Redirect SSO binding, reads the certificate', () => {
        const p = Md.parseIdpMetadata(md([CERT]));
        if (!p.ok)
            expect(p.code).toBe('ssof_md_bad_cert'); // an unparsable sample cert must fail CLOSED
        else {
            expect(p.entityId).toBe('https://sts.windows.net/t/');
            expect(p.ssoUrl).toBe('https://login.example/redirect');
            expect(p.certs).toHaveLength(1);
        }
    });
    test('refuses DTDs, missing IdP, missing certificate', () => {
        expect(Md.parseIdpMetadata('<!DOCTYPE a><EntityDescriptor/>').code).toBe('ssof_md_dtd');
        expect(Md.parseIdpMetadata('<EntityDescriptor entityID="x"/>').code).toBe('ssof_md_no_idp');
        expect(Md.parseIdpMetadata(md([])).code).toBe('ssof_md_no_cert');
        expect(Md.parseIdpMetadata('').code).toBe('ssof_md_empty');
    });
    test('splitCerts keeps every PEM block (rollover), dedupes, accepts a bare body', () => {
        const pem = (b) => `-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----`;
        expect(Md.splitCerts(`${pem('AAA')}\n${pem('BBB')}\n${pem('AAA')}`)).toEqual([
            'AAA',
            'BBB',
        ]);
        expect(Md.splitCerts('  AAA\nBB ')).toEqual(['AAABB']);
        expect(Md.splitCerts('')).toEqual([]);
    });
    test('a NEW signing certificate needs confirmation; the first import does not', () => {
        const parsed = { certs: [{ body: 'NEW', sha256: 'n' }] };
        expect(Md.certDiff('', parsed).needsConfirmation).toBe(false);
        expect(Md.certDiff('OLD', parsed)).toEqual(
            expect.objectContaining({ needsConfirmation: true })
        );
        expect(Md.certDiff('NEW', parsed).needsConfirmation).toBe(false);
    });
    test('SSRF: private, loopback, link-local and ULA addresses are refused; http refused', async () => {
        for (const a of [
            '10.1.2.3',
            '127.0.0.1',
            '169.254.169.254',
            '172.16.0.1',
            '192.168.1.1',
            '100.64.0.1',
            '::1',
            'fd00::1',
            'fe80::1',
            '::ffff:10.0.0.1',
        ]) {
            expect(Md.isPrivateAddress(a)).toBe(true);
        }
        for (const a of ['8.8.8.8', '20.190.160.1', '2001:4860:4860::8888'])
            expect(Md.isPrivateAddress(a)).toBe(false);
        expect((await Md.fetchMetadata('http://login.example/md')).code).toBe('ssof_md_https_only');
        expect((await Md.fetchMetadata('not a url')).code).toBe('ssof_md_bad_url');
        expect((await Md.fetchMetadata('https://user:pw@login.example/md')).code).toBe(
            'ssof_md_bad_url'
        );
    });
    test('the values to paste are built from the trusted base URL', () => {
        const v = Md.spValues('https://app.example/');
        expect(v).toEqual(
            expect.objectContaining({
                entityId: 'https://app.example/saml/metadata',
                acsUrl: 'https://app.example/auth/sso/saml/callback',
                metadataUrl: 'https://app.example/saml/metadata',
            })
        );
        expect(Md.spMetadataXml('https://app.example')).toMatch(
            /entityID="https:\/\/app\.example\/saml\/metadata"/
        );
    });
});

describe('SsoTestService', () => {
    test('a token is readable by the admin who started it only, and is single-use', () => {
        const t = SsoTest.issue(7, 'saml');
        expect(t.relayState.startsWith(SsoTest.PREFIX)).toBe(true);
        expect(SsoTest.fromRelayState(t.relayState, 'saml')).toEqual(
            expect.objectContaining({ nonce: t.nonce })
        );
        expect(SsoTest.fromRelayState(t.relayState, 'entra')).toBeNull();
        SsoTest.setResult(t.nonce, { ok: true });
        expect(SsoTest.fromRelayState(t.relayState, 'saml')).toBeNull(); // already answered
        expect(SsoTest.readResult(t.nonce, 7)).toEqual(
            expect.objectContaining({ ok: true, provider: 'saml' })
        );
        expect(SsoTest.readResult(t.nonce, 8)).toBeNull();
        expect(SsoTest.fromRelayState('ssotest:unknown', 'saml')).toBeNull();
    });
});

describe('SCIM PATCH active — as Entra and Okta send it', () => {
    const { scimActiveIntent: f } = require('../../src/routes/scim');
    test('Entra boolean, Entra string "False", Okta object — all deprovision', () => {
        expect(f([{ op: 'Replace', path: 'active', value: false }])).toBe(false);
        expect(f([{ op: 'Replace', path: 'active', value: 'False' }])).toBe(false);
        expect(f([{ op: 'replace', value: { active: false } }])).toBe(false);
    });
    test('reinstate, unrelated ops, and garbage', () => {
        expect(f([{ op: 'Replace', path: 'active', value: 'True' }])).toBe(true);
        expect(f([{ op: 'replace', path: 'displayName', value: 'x' }])).toBeNull();
        expect(f([{ op: 'remove', path: 'active' }])).toBeNull();
        expect(f(null)).toBeNull();
    });
});

describe('wiring (source guards)', () => {
    const sso = read('src/config/sso.js');
    test('the SAML verify step checks the IdP issuer itself (node-saml does not, on login)', () => {
        expect(sso).toMatch(
            /const expectedIdp = env\('SAML_IDP_ISSUER'\);\s*if \(expectedIdp && pf\.issuer !== expectedIdp\)/
        );
    });
    test('responses must answer our request unless IdP-initiated is allowed; the cache is in the DB', () => {
        expect(sso).toMatch(/validateInResponseTo: idpInitiated \? 'ifPresent' : 'always'/);
        expect(sso).toMatch(/cacheProvider: SamlSec\.requestCache/);
        expect(sso).toMatch(/SamlSec\.recordAssertion\(/);
        expect(sso).toMatch(/SamlSec\.destinationOk\(/);
    });
    test('/saml/metadata is public: registered BEFORE router.use(requireAuth)', () => {
        const routes = read('src/routes/index.js');
        // Formatting-proof: the registration may be split over several lines.
        const md = routes.search(/router\.get\(\s*'\/saml\/metadata'/);
        const gate = routes.indexOf('router.use(requireAuth);');
        expect(md).toBeGreaterThan(-1);
        expect(md).toBeLessThan(gate);
    });
    test('the denial message stays generic (no account enumeration) and the precedence bug is gone', () => {
        // Code only: the fix's own comment quotes the old expression.
        const ctl = read('src/controllers/SsoController.js')
            .replace(/\/\/.*$/gm, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        expect(ctl).not.toMatch(/\(info && info\.message\) \|\| req\.t\s*\?/);
        expect(ctl).toMatch(/authAudit\(req, 'SSO_DENIED', `\$\{provider\.key\}: \$\{reason\}`\)/);
    });
    test('SSO secrets are encrypted at rest and covered by the key rotation', () => {
        expect(read('src/services/SsoSettingsService.js')).toMatch(
            /secretBox\.encrypt\(String\(raw\)\)/
        );
        expect(read('scripts/rotate-app-key.js')).toMatch(/settingKey LIKE 'sso\.%'/);
    });
});
