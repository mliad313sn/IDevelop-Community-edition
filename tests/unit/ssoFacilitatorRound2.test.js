/**
 * SSO facilitator — committee review round 2 (2026-09-24). Every finding below
 * was reproduced with a probe (genuine signed SAML responses, real API keys,
 * rows re-read in the database) before it was fixed; these tests pin the fixes.
 *
 *   F1  a comment holding "<!DOCTYPE" appended OUTSIDE the signed element made
 *       the response inspector return null, and `seen && …` then skipped the
 *       Destination and replay checks — one captured response replayed at will.
 *   F2  Apply re-fetched the metadata: the certificate trusted was not
 *       necessarily the one the admin confirmed in the preview.
 *   F3  a stored secret that no longer decrypts fell back to an older value in
 *       .env instead of disabling the provider.
 *   F4  Node >= 22 calls the pinned lookup with {all:true}: every URL import failed.
 *   F5  IPv4-compatible / NAT64 / 6to4 / site-local forms escaped the SSRF check.
 *   D1  a SCIM "pending-N" id kept by the IdP never reached the employee it
 *       became once placed: deprovisioning answered 204 and changed nothing.
 *   SCIM transport (found by the parallel SSO committee, extended here): Entra
 *       and Okta send `Authorization: Bearer <key>` (read only as X-API-Key → 401)
 *       and `application/scim+json` (CSRF 403 + unparsed body) — no real IdP could
 *       deprovision anyone.
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

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p) =>
    read(p)
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

beforeEach(() => jest.clearAllMocks());

describe('F1 — replay / destination checks fail CLOSED', () => {
    test('no assertion id → refused (was: accepted, nothing recorded)', async () => {
        expect(await Sec.recordAssertion({ issuer: 'i', assertionId: null })).toBe(false);
        expect(db.run.mock.calls.some((c) => /INSERT INTO saml_assertion_seen/.test(c[0]))).toBe(
            false
        );
    });
    test('the replay key is read from the VERIFIED assertion XML, root element only', () => {
        expect(
            Sec.verifiedAssertionId(
                '<saml:Assertion xmlns:saml="x" ID="_a1" Version="2.0"><x/></saml:Assertion>'
            )
        ).toBe('_a1');
        expect(Sec.verifiedAssertionId('<?xml version="1.0"?><Assertion ID="_b"/>')).toBe('_b');
        expect(
            Sec.verifiedAssertionId('<Response ID="_r"><Assertion ID="_a"/></Response>')
        ).toBeNull();
        expect(Sec.verifiedAssertionId(null)).toBeNull();
    });
    test('the verify step refuses an uninspectable response and keys replay on the verified id', () => {
        const sso = code('src/config/sso.js');
        expect(sso).toMatch(/if \(!seen\) return refuse\('sso_unparseable'/);
        expect(sso).not.toMatch(/if \(seen && !SamlSec\.destinationOk/);
        expect(sso).toMatch(
            /SamlSec\.verifiedAssertionId\(\s*typeof pf\.getAssertionXml === 'function'/
        );
    });
});

describe('F2 — Apply is bound to the fingerprints the preview showed', () => {
    test('server compares the confirmed set with the certificates it would add now', () => {
        const ctl = code('src/controllers/SsoSettingsController.js');
        expect(ctl).toMatch(/Array\.isArray\(req\.body && req\.body\.confirmCerts\)/);
        expect(ctl).toMatch(/sameSet\(\s*confirmed,\s*diff\.added\.map\(\(c\) => c\.sha256\)\s*\)/);
        expect(ctl).not.toMatch(/confirmCerts === true/);
    });
    test('the page sends the fingerprints, never a bare "yes"', () => {
        expect(read('views/pages/app-settings/sso.ejs')).toMatch(
            /body\.confirmCerts = confirmBox && confirmBox\.checked \? j\.added\.map/
        );
    });
});

describe('F3 — an undecryptable stored secret never falls back to .env', () => {
    const OLD = process.env.APP_KEY;
    afterEach(() => {
        process.env.APP_KEY = OLD;
        jest.resetModules();
    });
    test('getOverrides flags it and env() then returns nothing', async () => {
        process.env.APP_KEY = 'key-one-key-one-key-one-key-one-!';
        const secretBox = require('../../src/utils/secretBox');
        const stored = secretBox.encrypt('-----BEGIN CERTIFICATE-----AAA-----END CERTIFICATE-----');
        process.env.APP_KEY = 'a-different-key-a-different-key-!!';
        jest.doMock('../../src/models/AppSettingsModel', () => ({
            getValue: jest.fn(async (k) => (k === 'sso.saml.idpCert' ? stored : null)),
        }));
        const Svc = require('../../src/services/SsoSettingsService');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const ov = await Svc.getOverrides();
        expect(ov.__undecryptable).toContain('SAML_IDP_CERT');
        expect(ov.SAML_IDP_CERT).toBeUndefined();
        expect(warn.mock.calls.some((c) => /sso\.saml\.idpCert/.test(String(c[0])))).toBe(true);
        warn.mockRestore();
        expect(code('src/config/sso.js')).toMatch(
            /_overrides\.__undecryptable\.includes\(name\)\)\s*return '';/
        );
    });
});

describe('F4 / F5 — metadata fetch', () => {
    test('the pinned lookup answers the {all:true} form Node >= 22 uses', () => {
        expect(read('src/services/SamlMetadataService.js')).toMatch(
            /opts && opts\.all\s*\?\s*cb\(null, \[\{ address: pinned\.address, family: pinned\.family \}\]\)/
        );
    });
    test('special-purpose IPv4/IPv6 forms are private; public addresses are not', () => {
        for (const a of [
            '::7f00:1',
            '::127.0.0.1',
            'fec0::1',
            '64:ff9b::a9fe:a9fe',
            '2002::1',
            '100::1',
            '198.18.0.1',
            '0:0:0:0:0:ffff:7f00:1',
            '::ffff:10.0.0.1',
            // 3.23.18: the embedded-IPv4 pattern had lost its backslashes; these
            // are now judged by the IPv4 they carry.
            '::ffff:169.254.169.254',
            '::ffff:127.0.0.1',
        ]) {
            expect([a, Md.isPrivateAddress(a)]).toEqual([a, true]);
        }
        for (const a of [
            '8.8.8.8',
            '20.190.160.1',
            '40.126.0.1',
            '2001:4860:4860::8888',
            '2603:1006::1',
            '::ffff:8.8.8.8', // an IPv4-mapped PUBLIC address is public
        ]) {
            expect([a, Md.isPrivateAddress(a)]).toEqual([a, false]);
        }
    });
});

describe('SCIM — reachable by a real identity provider', () => {
    test('an opaque Bearer token is accepted as an API key (JWTs stay for Entra)', () => {
        // One resolver, presentedApiKey: header, then an OPAQUE bearer, then
        // ?apiKey= (reported as 'query', honoured only for flagged keys, migration 163).
        const m = code('src/middleware/apiAuth.js');
        expect(m).toMatch(/function presentedApiKey/);
        const { presentedApiKey } = require('../../src/middleware/apiAuth');
        expect(presentedApiKey({ headers: { authorization: 'Bearer opaque-scim-token' } })).toEqual(
            { key: 'opaque-scim-token', source: 'bearer' }
        );
        expect(
            presentedApiKey({ headers: { authorization: 'Bearer aaa.bbb.ccc' }, query: {} })
        ).toBeNull();
        expect(presentedApiKey({ headers: {}, query: { apiKey: 'k' } })).toEqual({
            key: 'k',
            source: 'query',
        });
    });
    test('application/scim+json is JSON for the parser, the origin guard and the CSRF skip', () => {
        // The JSON media types and the predicate moved to
        // src/middleware/httpHardening.js, shared by the parser (server.js), the
        // origin guard and the CSRF skip; the predicate is now anchored on the
        // MIME essence.
        const s = read('server.js');
        const H = require('../../src/middleware/httpHardening');
        expect(H.JSON_TYPES).toEqual(['application/json', 'application/*+json']);
        expect(s).toMatch(/const _JSON_TYPES = \[\.\.\.httpHardening\.JSON_TYPES\];/);
        expect(s).toMatch(/express\.json\(\{[^}]*type: _JSON_TYPES/);
        expect(H.isJsonType('application/scim+json; charset=utf-8')).toBe(true);
        expect(H.isJsonType('application/json')).toBe(true);
        expect(H.isJsonType('application/x-www-form-urlencoded')).toBe(false);
        const hh = read('src/middleware/httpHardening.js');
        expect(
            (
                hh.match(
                    /isJsonType\(req\.headers(\['content-type'\]| && req\.headers\['content-type'\])\)/g
                ) || []
            ).length
        ).toBe(2);
    });
    test('a PATCH without Operations is 400 invalidSyntax, never a silent 200', () => {
        expect(code('src/routes/scim.js')).toMatch(
            /if \(!req\.body \|\| !Array\.isArray\(req\.body\.Operations\)\)[\s\S]{0,120}status\(400\)[\s\S]{0,120}invalidSyntax/
        );
    });
    test('an approved pending-N id reaches the employee it became (GET, PATCH, DELETE)', () => {
        const s = code('src/routes/scim.js');
        expect(s).toMatch(/r\.status === 'approved' && eid \? Number\(eid\) : null/);
        expect((s.match(/req\.params\.id = String\(placed\);/g) || []).length).toBe(3);
        expect(s).toMatch(/if \(!\(u && u\.changes\)\) return;/);
    });
});

describe('Test sign-in explains refusals too', () => {
    test('issuer / destination / replay / unparseable refusals go to the diagnostic when testing', () => {
        const s = code('src/config/sso.js');
        for (const c of ['sso_issuer', 'sso_unparseable', 'sso_destination', 'sso_replay']) {
            expect(s).toMatch(new RegExp(`refuse\\(\\s*'${c}'`));
        }
        expect(s).toMatch(/SsoTest\.setResult\(testTok\.nonce, \{\s*ok: false,\s*code/);
    });
    test('a library-level rejection (signature, InResponseTo) during a test is reported too', () => {
        expect(code('src/controllers/SsoController.js')).toMatch(/code: 'sso_saml_invalid'/);
    });
    test('every refusal code has a translated explanation', () => {
        for (const lng of ['fr', 'en']) {
            const j = JSON.parse(read(`locales/${lng}/admin.json`));
            for (const c of [
                'sso_issuer',
                'sso_destination',
                'sso_replay',
                'sso_unparseable',
                'sso_saml_invalid',
                'unknown',
            ]) {
                expect(j['ssof_fail_' + c]).toBeTruthy();
            }
        }
    });
});

describe('Installer — the install directory is exactly the release', () => {
    test('the four stale views found on the live instance are retired', () => {
        const ps = read('installer/Install-IDevelop.ps1');
        for (const p of [
            'views\\pages\\admins\\invitations.ejs',
            'views\\pages\\coaching\\index.ejs',
            'views\\pages\\slf\\cycles.ejs',
            'views\\pages\\talent\\9box-grid.ejs',
        ]) {
            expect(ps).toContain(`p = '${p}'`);
        }
    });
});
