'use strict';
/**
 * 3.23.18 lane S-entra-lib — Entra sign-in and API bearer tokens without
 * passport-azure-ad. Drives the REAL openid-client / jose against a mock
 * Entra tenant served from 127.0.0.1 (discovery, JWKS, token endpoint):
 *   - OIDC code flow + PKCE + state + nonce, end to end through passport;
 *   - refusals: unknown/replayed state, wrong nonce, audience, issuer, tenant,
 *     expired ID token, foreign signing key, IdP error;
 *   - bearer JWT accepted / refused (audience, issuer, tenant, expiry, key, alg).
 *
 * openid-client and jose are ES modules. Jest's CommonJS loader cannot evaluate
 * them, so both are handed to the module under test from Node's own loader
 * (require(esm), Node >= 20.19) — the same code path production uses.
 */
jest.mock('openid-client', () =>
    process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')(
        'openid-client'
    )
);
jest.mock('jose', () =>
    process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('jose')
);
jest.mock('../../src/config/database', () => ({ get: jest.fn(), run: jest.fn(), all: jest.fn() }));
jest.mock('../../src/models/AdminModel', () => ({ findWithScopes: jest.fn() }));
jest.mock('../../src/models/EmployeeModel', () => ({
    findByIdWithOrganization: jest.fn(),
    governanceOf: jest.fn(),
}));
jest.mock('../../src/services/SsoService', () => ({
    resolveIdentity: jest.fn(),
    enforceSsoOnly: jest.fn(),
    stampLastLogin: jest.fn(),
    stampIdentityUse: jest.fn(),
    primaryUid: jest.fn(() => null),
}));
jest.mock('../../src/services/OnboardingService', () => ({
    createFromSso: jest.fn(async () => null),
}));

const http = require('http');
const crypto = require('crypto');
const jose = require('jose');
const { Passport } = require('passport');
const SsoService = require('../../src/services/SsoService');
const EmployeeModel = require('../../src/models/EmployeeModel');
const sso = require('../../src/config/sso');

const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER_TENANT = '99999999-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const API_CLIENT_ID = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'test-secret-value';
const REDIRECT = 'http://app.localhost/auth/sso/entra/callback';

let server;
let base; // http://127.0.0.1:port
let issuer; // base/TENANT/v2.0
let signKey; // the tenant's key (published in the JWKS)
let rogueKey; // a key the tenant never published
const codes = new Map(); // code -> { challenge, idClaims, signWith }
const tokenCalls = [];

function b64url(buf) {
    return Buffer.from(buf).toString('base64url');
}

async function signJwt(claims, key = signKey, kid = 'k1') {
    return new jose.SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
        .sign(key.privateKey);
}

function readBody(req) {
    return new Promise((resolve) => {
        let s = '';
        req.on('data', (c) => (s += c));
        req.on('end', () => resolve(s));
    });
}

beforeAll(async () => {
    signKey = await jose.generateKeyPair('RS256', { extractable: true });
    rogueKey = await jose.generateKeyPair('RS256', { extractable: true });
    const pubJwk = {
        ...(await jose.exportJWK(signKey.publicKey)),
        kid: 'k1',
        alg: 'RS256',
        use: 'sig',
    };
    server = http.createServer(async (req, res) => {
        const url = new URL(req.url, base);
        const json = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (url.pathname === `/${TENANT}/v2.0/.well-known/openid-configuration`) {
            return json(200, {
                issuer,
                authorization_endpoint: `${base}/${TENANT}/oauth2/v2.0/authorize`,
                token_endpoint: `${base}/${TENANT}/oauth2/v2.0/token`,
                jwks_uri: `${base}/${TENANT}/discovery/v2.0/keys`,
                response_types_supported: ['code'],
                subject_types_supported: ['pairwise'],
                id_token_signing_alg_values_supported: ['RS256'],
                token_endpoint_auth_methods_supported: ['client_secret_post'],
            });
        }
        if (url.pathname === `/${TENANT}/discovery/v2.0/keys`) {
            return json(200, { keys: [pubJwk] });
        }
        if (url.pathname === `/${TENANT}/oauth2/v2.0/token` && req.method === 'POST') {
            const p = new URLSearchParams(await readBody(req));
            tokenCalls.push(Object.fromEntries(p.entries()));
            const entry = codes.get(p.get('code'));
            codes.delete(p.get('code'));
            const challenge = entry
                ? b64url(
                      crypto
                          .createHash('sha256')
                          .update(p.get('code_verifier') || '')
                          .digest()
                  )
                : null;
            if (
                !entry ||
                p.get('client_id') !== CLIENT_ID ||
                p.get('client_secret') !== SECRET ||
                p.get('redirect_uri') !== REDIRECT ||
                p.get('grant_type') !== 'authorization_code' ||
                challenge !== entry.challenge
            ) {
                return json(400, { error: 'invalid_grant' });
            }
            const id_token = await signJwt(entry.idClaims, entry.signWith || signKey);
            return json(200, {
                access_token: 'at',
                token_type: 'Bearer',
                expires_in: 3600,
                id_token,
            });
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    issuer = `${base}/${TENANT}/v2.0`;
    sso._setEntraAuthorityForTests(base);
});

afterAll(async () => {
    sso._setEntraAuthorityForTests(null);
    await new Promise((r) => server.close(r));
});

const ENV = {
    SSO_ENABLED: '1',
    AZURE_TENANT_ID: TENANT,
    AZURE_CLIENT_ID: CLIENT_ID,
    AZURE_CLIENT_SECRET: SECRET,
    SSO_ENTRA_REDIRECT_URL: REDIRECT,
    AZURE_API_CLIENT_ID: API_CLIENT_ID,
};
const saved = {};
let passport;

beforeEach(() => {
    for (const k of [...Object.keys(ENV), 'AZURE_API_AUDIENCE', 'AZURE_API_ISSUER']) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, ENV);
    passport = new Passport();
    expect(sso.configureSso(passport)).toEqual(['entra']);
    tokenCalls.length = 0;
    SsoService.resolveIdentity.mockResolvedValue({ kind: 'employee', id: 42 });
    EmployeeModel.findByIdWithOrganization.mockResolvedValue({ id: 42, firstName: 'Ada' });
    EmployeeModel.governanceOf.mockResolvedValue({
        governs: false,
        supervises: false,
        manages: false,
    });
});
afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

// Run a passport strategy exactly as SsoController does (custom callback) and
// report how it ended: redirect | success | fail | error.
function drive(req, options = {}) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            headers: {},
            setHeader(k, v) {
                this.headers[k.toLowerCase()] = v;
            },
            end() {
                resolve({ type: 'redirect', location: this.headers.location });
            },
        };
        passport.authenticate('sso-entra', options, (err, user, info) => {
            if (err) return resolve({ type: 'error', err });
            if (!user) return resolve({ type: 'fail', info });
            return resolve({ type: 'success', user });
        })(req, res, (e) => resolve({ type: 'next', err: e }));
    });
}

function callbackReq(session, query) {
    const qs = new URLSearchParams(query).toString();
    return { query, session, originalUrl: `/auth/sso/entra/callback?${qs}`, headers: {} };
}

// Initiate a sign-in; returns the session, the authorize parameters and a
// helper that makes the IdP issue a code for given ID-token claims.
async function initiate() {
    const session = {};
    const r = await drive(
        { query: {}, session, originalUrl: '/auth/sso/entra', headers: {} },
        {
            prompt: 'select_account',
        }
    );
    expect(r.type).toBe('redirect');
    const u = new URL(r.location);
    const q = Object.fromEntries(u.searchParams.entries());
    const issueCode = (claimsOverride = {}, signWith) => {
        const now = Math.floor(Date.now() / 1000);
        const code = 'code-' + crypto.randomBytes(6).toString('hex');
        codes.set(code, {
            challenge: q.code_challenge,
            signWith,
            idClaims: {
                iss: issuer,
                aud: CLIENT_ID,
                sub: 'sub-1',
                oid: 'oid-1',
                tid: TENANT,
                nonce: q.nonce,
                iat: now,
                nbf: now,
                exp: now + 3600,
                preferred_username: 'ada@corp.example',
                email: 'ada.mail@corp.example',
                email_verified: true,
                name: 'Ada Lovelace',
                given_name: 'Ada',
                family_name: 'Lovelace',
                employeeid: 'E-77',
                ...claimsOverride,
            },
        });
        return code;
    };
    return { session, url: u, q, issueCode };
}

describe('Entra interactive sign-in (openid-client, code flow + PKCE)', () => {
    test('authorize request carries PKCE S256, state, nonce, query response mode, prompt', async () => {
        const { url, q, session } = await initiate();
        expect(url.origin + url.pathname).toBe(`${base}/${TENANT}/oauth2/v2.0/authorize`);
        expect(q).toEqual(
            expect.objectContaining({
                client_id: CLIENT_ID,
                redirect_uri: REDIRECT,
                response_type: 'code',
                response_mode: 'query',
                scope: 'openid profile email',
                code_challenge_method: 'S256',
                prompt: 'select_account',
            })
        );
        expect(q.state).toBeTruthy();
        expect(q.nonce).toBeTruthy();
        expect(q.code_challenge).toBeTruthy();
        // The verifier stays server-side in the session, keyed by state.
        expect(Object.keys(session.entraOidcPending)).toEqual([q.state]);
    });

    test('successful callback signs the mapped identity in; the state is single-use', async () => {
        const { session, q, issueCode } = await initiate();
        const code = issueCode();
        const r = await drive(callbackReq(session, { code, state: q.state }));
        expect(r.type).toBe('success');
        expect(r.user).toEqual(expect.objectContaining({ id: 42, userType: 'employee' }));
        expect(SsoService.resolveIdentity).toHaveBeenCalledWith(
            'entra',
            expect.objectContaining({
                oid: 'oid-1',
                sub: 'sub-1',
                tid: TENANT,
                email: 'ada.mail@corp.example',
                upn: 'ada@corp.example',
                employeeId: 'E-77',
                emailVerified: true,
                name: 'Ada Lovelace',
                firstName: 'Ada',
                lastName: 'Lovelace',
                userType: null,
            }),
            // 3.23.19: resolveAndFinish asks HOW the account was found (D3b).
            expect.objectContaining({ trace: expect.any(Object) })
        );
        // D5: the mock IdP asserts no amr/acr → no IdP multi-factor on the user.
        expect(r.user._ssoContext).toEqual(
            expect.objectContaining({ provider: 'entra', mfaAsserted: false })
        );
        expect(SsoService.enforceSsoOnly).toHaveBeenCalled();
        expect(SsoService.stampIdentityUse).toHaveBeenCalled();
        // PKCE: the token call carried the verifier matching the challenge.
        expect(tokenCalls[0].code_verifier).toBeTruthy();
        // Replaying the same callback is refused (state consumed).
        SsoService.resolveIdentity.mockClear();
        const again = await drive(callbackReq(session, { code, state: q.state }));
        expect(again.type).toBe('fail');
        expect(again.info.code).toBe('sso_state');
        expect(SsoService.resolveIdentity).not.toHaveBeenCalled();
    });

    test('a state this session never issued is refused before any token call', async () => {
        const { session, issueCode } = await initiate();
        const code = issueCode();
        const r = await drive(callbackReq(session, { code, state: 'forged-state' }));
        expect(r.type).toBe('fail');
        expect(r.info.code).toBe('sso_state');
        expect(tokenCalls).toHaveLength(0);
        // …and a valid state from ANOTHER session does not work either.
        const other = await initiate();
        const r2 = await drive(callbackReq(session, { code, state: other.q.state }));
        expect(r2.type).toBe('fail');
    });

    test('a sign-in left pending more than 10 minutes is refused', async () => {
        const { session, q, issueCode } = await initiate();
        session.entraOidcPending[q.state].at -= 11 * 60 * 1000;
        const r = await drive(callbackReq(session, { code: issueCode(), state: q.state }));
        expect(r.type).toBe('fail');
        expect(r.info.code).toBe('sso_state');
        expect(tokenCalls).toHaveLength(0);
    });

    // [label, claim override (a function: `base` is only known once the IdP runs), cause]
    const refusals = [
        ['wrong nonce', () => ({ nonce: 'not-the-nonce' }), /nonce/i],
        ['wrong audience', () => ({ aud: 'someone-else' }), /aud/i],
        ['wrong issuer', () => ({ iss: `${base}/${OTHER_TENANT}/v2.0` }), /iss/i],
        ['expired ID token', () => ({ iat: 1000, nbf: 1000, exp: 2000 }), /exp|timestamp/i],
    ];
    test.each(refusals)('%s is refused and nobody is signed in', async (_l, override, cause) => {
        const { session, q, issueCode } = await initiate();
        const r = await drive(
            callbackReq(session, { code: issueCode(override()), state: q.state })
        );
        expect(r.type).toBe('fail');
        expect(r.info.code).toBe('sso_oidc_invalid');
        expect(r.info.message).toMatch(cause);
        expect(SsoService.resolveIdentity).not.toHaveBeenCalled();
    });

    test('a token from another tenant (tid) is refused', async () => {
        const { session, q, issueCode } = await initiate();
        const r = await drive(
            callbackReq(session, { code: issueCode({ tid: OTHER_TENANT }), state: q.state })
        );
        expect(r.type).toBe('fail');
        expect(r.info.code).toBe('sso_tenant');
        expect(SsoService.resolveIdentity).not.toHaveBeenCalled();
    });

    test('an ID token signed by a key the tenant never published is refused', async () => {
        const { session, q, issueCode } = await initiate();
        const r = await drive(
            callbackReq(session, { code: issueCode({}, rogueKey), state: q.state })
        );
        expect(r.type).toBe('fail');
        expect(r.info.message).toMatch(/signature|key/i);
        expect(SsoService.resolveIdentity).not.toHaveBeenCalled();
    });

    test('an IdP error response is a denial, not a crash', async () => {
        const { session, q } = await initiate();
        const r = await drive(
            callbackReq(session, {
                error: 'access_denied',
                error_description: 'no',
                state: q.state,
            })
        );
        expect(r.type).toBe('fail');
        expect(SsoService.resolveIdentity).not.toHaveBeenCalled();
    });

    test('a guest (acct=1) is flagged for SsoService', async () => {
        const { session, q, issueCode } = await initiate();
        await drive(callbackReq(session, { code: issueCode({ acct: 1 }), state: q.state }));
        expect(SsoService.resolveIdentity.mock.calls[0][1].userType).toBe('Guest');
    });

    test('an undecryptable DB secret disables the provider (no .env fallback)', async () => {
        const SsoSettingsService = require('../../src/services/SsoSettingsService');
        jest.spyOn(SsoSettingsService, 'getOverrides').mockResolvedValue({
            __undecryptable: ['AZURE_CLIENT_SECRET'],
        });
        // AZURE_CLIENT_SECRET is still in the environment — it must not be used.
        expect(await sso.reloadSso(new Passport())).toEqual([]);
        expect(sso.getProvider('entra')).toBeNull();
    });

    test('DB overrides (SsoSettingsService) configure the provider like .env does', async () => {
        const SsoSettingsService = require('../../src/services/SsoSettingsService');
        delete process.env.AZURE_CLIENT_SECRET;
        jest.spyOn(SsoSettingsService, 'getOverrides').mockResolvedValue({
            AZURE_CLIENT_SECRET: SECRET,
        });
        passport = new Passport();
        expect(await sso.reloadSso(passport)).toEqual(['entra']);
        const { session, q, issueCode } = await initiate();
        const r = await drive(callbackReq(session, { code: issueCode(), state: q.state }));
        expect(r.type).toBe('success');
    });
});

describe('Entra API bearer tokens (jose)', () => {
    async function apiToken(override = {}, key = signKey, alg = 'RS256') {
        const now = Math.floor(Date.now() / 1000);
        const claims = {
            iss: issuer,
            aud: API_CLIENT_ID,
            sub: 'svc-sub',
            oid: 'svc-oid',
            tid: TENANT,
            iat: now,
            nbf: now,
            exp: now + 600,
            upn: 'svc@corp.example',
            preferred_username: 'svc.pref@corp.example',
            ...override,
        };
        if (alg === 'HS256') {
            return new jose.SignJWT(claims)
                .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
                .sign(new TextEncoder().encode('x'.repeat(32)));
        }
        return signJwt(claims, key);
    }
    const bearerReq = (t) => ({ headers: { authorization: `Bearer ${t}` } });

    test('a valid token resolves to the local principal, never claiming a mapping', async () => {
        expect(sso.isEntraBearerEnabled()).toBe(true);
        const user = await sso.authenticateEntraBearer(bearerReq(await apiToken()));
        expect(user).toEqual(expect.objectContaining({ id: 42, _entraBearer: true }));
        expect(SsoService.resolveIdentity).toHaveBeenCalledWith(
            'entra',
            expect.objectContaining({
                oid: 'svc-oid',
                tid: TENANT,
                upn: 'svc@corp.example',
                email: 'svc.pref@corp.example',
            }),
            { allowClaim: false, trace: expect.any(Object) }
        );
    });

    test('3.23.19 D8/S4/S5/S7: a bearer resolving to an ADMIN needs the SSO checks, a trusted link on the stable id, and IdP MFA in the token', async () => {
        const AdminSso = require('../../src/services/AdminSsoService');
        const AdminModel = require('../../src/models/AdminModel');
        const spy = jest.spyOn(AdminSso, 'eligibility');
        AdminModel.findWithScopes.mockResolvedValue({ id: 3, username: 'ops', role: 'localadmin' }); // 3.23.20 (C1): never a SuperAdmin through a bearer
        // resolveIdentity fills the trace like the real one does.
        const asAdmin = (trace) =>
            SsoService.resolveIdentity.mockImplementationOnce(async (p, m, opts) => {
                Object.assign(opts.trace, trace);
                return { kind: 'admin', id: 3 };
            });
        const good = { linkMethod: 'superadmin_link', aliasMatch: false };
        const mfaToken = () => apiToken({ amr: ['pwd', 'mfa'] });
        // D8: ineligible → no principal
        asAdmin(good);
        spy.mockResolvedValueOnce({ ok: false, reason: 'admin_sso_disabled', admin: null });
        expect(await sso.authenticateEntraBearer(bearerReq(await mfaToken()))).toBeNull();
        // S4: untrusted link → none
        asAdmin({ linkMethod: 'sso_email', aliasMatch: false });
        spy.mockResolvedValueOnce({ ok: true, reason: null, admin: { id: 3 } });
        expect(await sso.authenticateEntraBearer(bearerReq(await mfaToken()))).toBeNull();
        // S5: alias → none
        asAdmin({ linkMethod: 'superadmin_link', aliasMatch: true });
        spy.mockResolvedValueOnce({ ok: true, reason: null, admin: { id: 3 } });
        expect(await sso.authenticateEntraBearer(bearerReq(await mfaToken()))).toBeNull();
        // S7: no MFA in the token (a single factor is not MFA) → none
        for (const amr of [undefined, ['pwd'], ['rsa']]) {
            asAdmin(good);
            spy.mockResolvedValueOnce({ ok: true, reason: null, admin: { id: 3 } });
            expect(
                await sso.authenticateEntraBearer(bearerReq(await apiToken(amr ? { amr } : {})))
            ).toBeNull();
        }
        // all good → the admin principal
        asAdmin(good);
        spy.mockResolvedValueOnce({ ok: true, reason: null, admin: { id: 3 } });
        const user = await sso.authenticateEntraBearer(bearerReq(await mfaToken()));
        expect(user).toEqual(
            expect.objectContaining({ id: 3, userType: 'admin', _entraBearer: true })
        );
        expect(spy).toHaveBeenCalledWith(3);
        spy.mockRestore();
    });

    test('the App ID URI audience (api://<client id>) is accepted too', async () => {
        const t = await apiToken({ aud: `api://${API_CLIENT_ID}` });
        expect(await sso.authenticateEntraBearer(bearerReq(t))).not.toBeNull();
    });

    const bad = [
        ['wrong audience', () => ({ aud: CLIENT_ID })],
        ['wrong issuer', () => ({ iss: `${base}/${OTHER_TENANT}/v2.0` })],
        ['other tenant (tid)', () => ({ tid: OTHER_TENANT })],
        ['expired', () => ({ iat: 1000, nbf: 1000, exp: 2000 })],
    ];
    test.each(bad)('%s is refused', async (_l, override) => {
        const t = await apiToken(override());
        expect(await sso.authenticateEntraBearer(bearerReq(t))).toBeNull();
        expect(SsoService.resolveIdentity).not.toHaveBeenCalled();
    });

    test('a token signed by an unpublished key, or with HS256, is refused', async () => {
        expect(
            await sso.authenticateEntraBearer(bearerReq(await apiToken({}, rogueKey)))
        ).toBeNull();
        expect(
            await sso.authenticateEntraBearer(bearerReq(await apiToken({}, signKey, 'HS256')))
        ).toBeNull();
        expect(SsoService.resolveIdentity).not.toHaveBeenCalled();
    });

    test('AZURE_API_AUDIENCE and a comma-separated AZURE_API_ISSUER are honoured', async () => {
        process.env.AZURE_API_AUDIENCE = 'api://custom-uri';
        process.env.AZURE_API_ISSUER = `https://sts.windows.net/${TENANT}/, ${issuer}`;
        sso.configureSso(passport);
        const t1 = await apiToken({
            aud: 'api://custom-uri',
            iss: `https://sts.windows.net/${TENANT}/`,
        });
        expect(await sso.authenticateEntraBearer(bearerReq(t1))).not.toBeNull();
        // The raw client id is no longer the audience once overridden…
        expect(await sso.authenticateEntraBearer(bearerReq(await apiToken()))).toBeNull();
    });

    test('the passport strategy name still authenticates a bearer request', async () => {
        const t = await apiToken();
        const out = await new Promise((resolve) =>
            passport.authenticate('sso-entra-bearer', { session: false }, (err, mapped) =>
                resolve({ err, mapped })
            )(bearerReq(t), {}, () => {})
        );
        expect(out.err).toBeNull();
        expect(out.mapped).toEqual(expect.objectContaining({ oid: 'svc-oid', tid: TENANT }));
    });
});
