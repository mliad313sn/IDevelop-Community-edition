'use strict';
/**
 * Multi-provider single sign-on transport.
 *
 * Wires one or more external IdP strategies onto the existing session-based
 * Passport setup. The whole subsystem is gated by SSO_ENABLED (see
 * {@link module:services/SsoService}); each provider is then independently
 * activated by supplying its own credentials. Supported methods:
 *
 *   • entra  — Microsoft Entra ID / Azure AD (OIDC code flow + PKCE via
 *              openid-client; API bearer JWTs verified with jose)
 *   • oidc   — any generic OpenID Connect IdP (passport-openidconnect):
 *              Okta, Auth0, Keycloak, OneLogin, Ping, Google (via OIDC), …
 *   • saml   — SAML 2.0 IdP (@node-saml/passport-saml): ADFS, Shibboleth, …
 *   • google — Google Workspace OAuth 2.0 (passport-google-oauth20)
 *
 * Every provider's verify callback funnels through SsoService.resolveIdentity,
 * which maps the external identity to an EXISTING local account (admin or
 * employee) — there is NO just-in-time provisioning. On success we hydrate the
 * same `req.user` shape passport.deserializeUser builds, so RBAC, the MFA policy
 * gate, and the views behave identically regardless of how the user signed in.
 *
 * Routes are generic: GET /auth/sso/:provider (initiate) and
 * GET|POST /auth/sso/:provider/callback (handled in SsoController).
 *
 * @module config/sso
 */
const SsoService = require('../services/SsoService');
const AdminSso = require('../services/AdminSsoService');
const AdminModel = require('../models/AdminModel');
const EmployeeModel = require('../models/EmployeeModel');
const permissions = require('./permissions');

// provider key -> { key, label, icon, strategyName, authOptions }
const _enabled = new Map();
// UX-1 (3.23.21): providers registered for the pre-activation TEST sign-in only
// (SSO master switch off). Never listed, never enforced, never sign anyone in.
const _testOnly = new Map();

// Runtime config overrides (from the DB / Settings UI) keyed by the SAME env-var
// names the registrars use. A non-empty override wins over process.env, so SSO
// can be managed in-app without editing .env. Populated by reloadSso.
let _overrides = {};
function setOverrides(o) {
    _overrides = o || {};
}

// Effective value for a config name: DB override (if non-empty) else env.
function env(name) {
    // A secret stored in the DB that can no longer be decrypted (APP_KEY changed
    // without rotate-app-key) must NOT fall back to an older value in .env: the
    // provider stays unconfigured until an administrator re-enters it.
    if (Array.isArray(_overrides.__undecryptable) && _overrides.__undecryptable.includes(name))
        return '';
    const o = _overrides[name];
    if (o != null && String(o).trim() !== '') return String(o).trim();
    return (process.env[name] || '').trim();
}

// Master switch from the merged config (DB override of SSO_ENABLED wins).
function isSsoEnabled() {
    const v = env('SSO_ENABLED').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

// Every strategy name this module may register (for clean unregister on reload).
// 'sso-entra-bearer' is the Entra JWT bearer strategy (jose) used to authenticate
// API requests carrying an Entra-issued JWT access token (a NON-interactive auth
// measure, complementary to the redirect-based 'sso-entra' login strategy).
const STRATEGY_NAMES = ['sso-entra', 'sso-oidc', 'sso-saml', 'sso-google', 'sso-entra-bearer'];

// The passport instance (captured at register time) and whether the Entra API
// bearer strategy is currently active — used by authenticateEntraBearer.
let _passport = null;
let _entraBearerReady = false;
let _entraBearer = null; // the EntraBearerStrategy instance currently registered

// A bearer token that is shaped like a JWT (three base64url segments). Opaque
// API keys never match this, so we can safely route JWT-shaped bearers to Entra
// token validation and leave everything else to the API-key path.
function looksLikeJwt(s) {
    return typeof s === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
}

// Build the full req.user object exactly like passport.deserializeUser does, so
// an SSO login lands with the same permissions/scope context as a local login.
async function hydratePrincipal(principal) {
    if (principal.kind === 'employee') {
        const employee = await EmployeeModel.findByIdWithOrganization(principal.id);
        if (!employee) return null;
        // `governsAnyone` is the canonical test used by deserializeUser: it counts
        // supervisor_id OR (manager_id + manager_type='employee'). `findSubordinates`
        // only looks at supervisor_id, so 10 of the 20 real managers here signed in
        // through SSO typed as plain employees — landing on the employee dashboard,
        // and stamping their SESSION as 'employee' for its whole life, which then
        // broke session listing and revocation for them.
        const gov = await EmployeeModel.governanceOf(principal.id);
        const isManager = gov.governs;
        employee.userType = isManager ? 'manager' : 'employee';
        employee.isManager = isManager;
        employee.isSupervisorOf = gov.supervises;
        employee.isPeopleManager = gov.manages;
        return employee;
    }
    const admin = await AdminModel.findWithScopes(principal.id);
    if (!admin) return null;
    admin.userType = 'admin';
    try {
        if (admin.role === 'superadmin') {
            admin.permissions = [...permissions.ALL_SLUGS];
        } else {
            const AdminPermissionModel = require('../models/AdminPermissionModel');
            // expandSlugs, exactly as deserializeUser does. Without it a broad grant
            // (manage_employees) no longer satisfies a finer guard (view_employees),
            // so an admin arriving on the Entra bearer path got 403 "missing
            // capability" for a capability they had actually been granted.
            admin.permissions = permissions.expandSlugs(
                await AdminPermissionModel.findSlugsByAdminId(admin.id)
            );
        }
    } catch (_) {
        admin.permissions = [];
    }
    return admin;
}

// Shared tail: resolve the mapped {sub/oid/id,email} profile to a local account
// and hand passport either the user or a deny reason.
//
// `extra.mfaEvidence` (3.23.19, D5/S6): what the IdP said about HOW it
// authenticated ({ amr, acr } — OIDC amr/acr, SAML AuthnContextClassRef). A
// provider that cannot say passes nothing → not multi-factor. It travels to SsoController on the user
// object as a NON-enumerable `_ssoContext` ({ provider, mfaAsserted, via, mapped }),
// so it can never leak into the serialized session or a JSON rendering.
async function resolveAndFinish(providerKey, mapped, done, extra = {}) {
    try {
        const trace = {};
        const principal = await SsoService.resolveIdentity(providerKey, mapped, { trace });
        if (!principal) {
            // Unknown identity. If self-onboarding via SSO is enabled, park a
            // pending request and send the user to the "awaiting placement" page
            // instead of a hard denial.
            try {
                const OnboardingService = require('../services/OnboardingService');
                const r = await OnboardingService.createFromSso({
                    provider: providerKey,
                    email: mapped.email,
                    externalId: SsoService.primaryUid(mapped),
                    name: mapped.name || null,
                    firstName: mapped.firstName || null,
                    lastName: mapped.lastName || null,
                });
                if (r && (r.created || r.alreadyPending)) {
                    return done(null, false, {
                        onboarding: true,
                        message: 'Your account is awaiting setup by an administrator.',
                    });
                }
            } catch (_) {
                /* fall through to the standard denial */
            }
            // C3h (3.23.20): a SUCCESSFUL, validated IdP sign-in that matches no
            // account (and no onboarding) — the controller tells the person whom
            // to contact. Replay / invalid assertions never reach this line.
            return done(null, false, {
                code: 'sso_not_linked',
                message:
                    'Your account is not provisioned for single sign-on. Please contact your administrator.',
            });
        }
        // B1 (3.23.20): an identity that resolves to a SuperAdmin account is
        // refused BEFORE any side-effect (no stamp, no session): a SuperAdmin
        // signs in only with the break-glass password + TOTP. The identity row
        // is left in place (listed by the readiness report), never deleted.
        if (principal.kind === 'admin' && principal.role === 'superadmin') {
            return done(null, false, { code: 'superadmin_sso_forbidden', adminId: principal.id });
        }
        // Successful SSO sign-in for a known account → optionally turn off its local
        // password (SSO-only), per the ssoDisablesLocalPassword policy. Best-effort,
        // admin-exempt (break-glass, D7); never blocks the login.
        await SsoService.enforceSsoOnly(principal);
        // an SSO sign-in is a sign-in — last_login_at feeds the
        // "never signed in" state on the accounts console and the roster.
        // (Employees only: an ADMIN principal is stamped by SsoController once
        // it has passed the admin checks — it may still be refused.)
        await SsoService.stampLastLogin(principal);
        // Migration 144: "signed in via SSO" is measured on the identity itself.
        await SsoService.stampIdentityUse(providerKey, mapped, principal);
        const user = await hydratePrincipal(principal);
        if (!user) return done(null, false, { message: 'Linked account no longer exists.' });
        Object.defineProperty(user, '_ssoContext', {
            value: {
                provider: providerKey,
                // the IdP's evidence judged by ONE rule (built-in values plus
                // the operator's `sso.mfaAcrValues`); no evidence → false.
                mfaAsserted: await AdminSso.mfaAsserted(extra && extra.mfaEvidence),
                via: trace.via || null,
                // how the matched identity was linked; S5: matched on an
                // e-mail-like alias while the assertion carries another stable id.
                linkMethod: trace.linkMethod || null,
                aliasMatch: trace.aliasMatch === true,
                unstableUid: trace.unstableUid === true,
                mapped,
            },
            enumerable: false,
            configurable: true,
        });
        return done(null, user);
    } catch (err) {
        return done(err);
    }
}

// SAML claim URIs read for the SSO migration (Microsoft Entra names first; the
// short names cover other IdPs and a custom Entra claim name).
const SAML_CLAIMS = {
    oid: [
        'http://schemas.microsoft.com/identity/claims/objectidentifier',
        'objectidentifier',
        'oid',
    ],
    tid: ['http://schemas.microsoft.com/identity/claims/tenantid', 'tenantid', 'tid'],
    upn: [
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
        'upn',
        'userprincipalname',
    ],
    employeeId: [
        'employeeid',
        'employeeId',
        'employee_id',
        'http://schemas.microsoft.com/identity/claims/employeeid',
    ],
};

// First non-empty value of any of the claim names (a multi-valued attribute
// yields its first value). Custom claims may carry any namespace: a claim whose
// URI ends in "/<name>" also counts.
function samlClaim(profile, names) {
    const pf = profile || {};
    const pick = (v) => (Array.isArray(v) ? v[0] : v);
    for (const n of names) {
        const v = pick(pf[n]);
        if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    const tails = names.filter((n) => !n.includes('/')).map((n) => '/' + n.toLowerCase());
    for (const k of Object.keys(pf)) {
        const lk = k.toLowerCase();
        if (tails.some((t) => lk.endsWith(t))) {
            const v = pick(pf[k]);
            if (v != null && String(v).trim() !== '') return String(v).trim();
        }
    }
    return null;
}

// What the SSO test shows the SuperAdmin: every attribute the IdP released
// (values as sent — none of them is a secret) and the NameID.
function testClaims(pf) {
    const out = {};
    for (const [k, v] of Object.entries(pf || {})) {
        if (
            ['getAssertionXml', 'getAssertion', 'getSamlResponseXml'].includes(k) ||
            typeof v === 'function'
        )
            continue;
        if (v && typeof v === 'object' && !Array.isArray(v)) continue;
        out[k] = Array.isArray(v) ? v.map(String).join(', ') : String(v);
    }
    return out;
}
function publicMapped(m) {
    const { oid, tid, upn, employeeId, email, emailVerified, sub, name } = m || {};
    return { oid, tid, upn, employeeId, email, emailVerified, sub, name };
}

// NameID format requested from the IdP. Default unchanged (emailAddress, which
// the verified-email rule relies on); SAML_NAMEID_FORMAT=persistent|unspecified
// lets an Entra tenant emit its objectId as NameID, and "none" sends no policy.
function samlNameIdFormat() {
    const v = String(env('SAML_NAMEID_FORMAT') || 'email').toLowerCase();
    if (v === 'none') return null;
    if (v === 'persistent') return 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
    if (v === 'unspecified') return 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';
    return 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
}

// Pull the first non-empty email-ish value out of a SAML attribute bag.
function samlEmail(profile) {
    const claims = [
        'email',
        'mail',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        'urn:oid:0.9.2342.19200300.100.1.3',
    ];
    for (const c of claims) {
        if (profile[c]) return String(profile[c]);
    }
    // nameID is often the email when the format is emailAddress.
    if (profile.nameID && /@/.test(profile.nameID)) return String(profile.nameID);
    return null;
}

// ---------------------------------------------------------------------------
// Per-provider registration. Each returns the descriptor on success, or null
// when its credentials are absent / the package isn't installed. None throws.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Microsoft Entra ID — OIDC sign-in (openid-client) and API bearer JWTs (jose).
// Both libraries are ES modules: they are required lazily (Node ≥ 20.19 loads
// them through require(esm)), so the registry itself stays synchronous.
// ---------------------------------------------------------------------------

const ENTRA_AUTHORITY = 'https://login.microsoftonline.com';
// A pending sign-in (state/nonce/PKCE verifier) lives this long in the session,
// and at most this many may be pending at once (several tabs) — the same bounds
// the previous library used (nonceLifetime 600 s, nonceMaxAmount 10).
const ENTRA_PENDING_TTL_MS = 10 * 60 * 1000;
const ENTRA_PENDING_MAX = 10;
// Accepted clock difference with Entra, seconds (the previous library's default).
const ENTRA_CLOCK_TOLERANCE_S = 300;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Test seam ONLY: point the Entra authority at a local mock IdP. Refused outside
// NODE_ENV=test, so production always talks to login.microsoftonline.com over TLS.
let _testAuthority = null;
function _setEntraAuthorityForTests(url) {
    if (process.env.NODE_ENV !== 'test') throw new Error('test-only seam');
    _testAuthority = url ? String(url).replace(/\/+$/, '') : null;
}
function entraAuthority(tenant) {
    const base =
        process.env.NODE_ENV === 'test' && _testAuthority ? _testAuthority : ENTRA_AUTHORITY;
    return `${base}/${tenant}`;
}
function insecureTestAuthority(authority) {
    return process.env.NODE_ENV === 'test' && /^http:\/\//i.test(authority);
}

function libInstalled(name) {
    try {
        require.resolve(name);
        return true;
    } catch (_) {
        return false;
    }
}

function ssoDebug(msg) {
    const lvl = String(env('SSO_LOG_LEVEL') || 'warn').toLowerCase();
    if (lvl === 'info' || lvl === 'debug') console.log(`[sso] ${msg}`);
}

// Entra ID-token / access-token claims → the normalized identity SsoService
// resolves. Same keys, same precedence as before the library change.
function mapEntraClaims(c) {
    const j = c || {};
    return {
        oid: j.oid || null,
        sub: j.sub || null,
        email: j.email || j.preferred_username || j.upn || j.unique_name || null,
        // SSO-migration claim keys (SsoService.claimPendingMapping).
        upn: j.preferred_username || j.upn || null,
        employeeId: j.employeeid || j.employeeId || j.employee_id || null,
        tid: j.tid || null,
        // Optional claim `acct`: 1 = guest (B2B). A guest's preferred_username
        // is its HOME-tenant UPN, so the #EXT# test alone cannot see it.
        userType: String(j.acct) === '1' ? 'Guest' : null,
        // Entra signals verified email via email_verified or xms_edov
        // (email-domain-owner-verified). Required before any email match.
        emailVerified:
            j.email_verified === true || j.xms_edov === true || String(j.xms_edov) === '1',
        name: j.name || null,
        firstName: j.given_name || null,
        lastName: j.family_name || null,
    };
}

// Access-token claims (API bearer) → identity. Kept exactly as the bearer path
// always mapped them (upn before preferred_username; no guest flag).
function mapEntraBearerClaims(t) {
    const c = t || {};
    return {
        oid: c.oid || null,
        sub: c.sub || null,
        email: c.email || c.preferred_username || c.upn || c.unique_name || null,
        upn: c.upn || c.preferred_username || null,
        employeeId: c.employeeid || c.employee_id || null,
        tid: c.tid || null,
        emailVerified:
            c.email_verified === true || c.xms_edov === true || String(c.xms_edov) === '1',
        name: c.name || null,
        firstName: c.given_name || null,
        lastName: c.family_name || null,
    };
}

// A tenant configured by its GUID pins the token's `tid` (a domain-name tenant is
// bound by the issuer check alone).
function tenantMismatch(tenant, tid) {
    return GUID_RE.test(tenant) && String(tid || '').toLowerCase() !== tenant.toLowerCase();
}

// openid-client / oauth4webapi protocol refusals (bad state, nonce, issuer,
// audience, signature, expiry, IdP error) → a DENIAL; anything else (network,
// discovery) → an error.
const OIDC_REFUSALS = new Set([
    'ClientError',
    'AuthorizationResponseError',
    'ResponseBodyError',
    'WWWAuthenticateChallengeError',
    'OperationProcessingError',
]);

const PassportStrategy = require('passport').Strategy;

/**
 * Entra OIDC authorization-code flow with PKCE (S256), state and nonce.
 * response_mode=query on purpose: the session cookie is sameSite=lax, which a
 * browser does NOT send on the cross-site POST of form_post — the state kept in
 * the session would be missing. A top-level GET redirect carries it.
 */
class EntraOidcStrategy extends PassportStrategy {
    constructor(opts, verify) {
        super();
        this.name = 'sso-entra';
        this._opts = opts;
        this._verify = verify;
        this._config = null;
    }

    _configuration() {
        if (!this._config) {
            const client = require('openid-client');
            const { authority, clientID, clientSecret } = this._opts;
            const execute = insecureTestAuthority(authority) ? [client.allowInsecureRequests] : [];
            this._config = client
                .discovery(
                    new URL(`${authority}/v2.0`),
                    clientID,
                    { [client.clockTolerance]: ENTRA_CLOCK_TOLERANCE_S },
                    client.ClientSecretPost(clientSecret),
                    { execute, timeout: 15 }
                )
                .then((cfg) => {
                    // Verify the ID token's signature against the tenant JWKS too
                    // (defence in depth on top of the TLS-authenticated token call).
                    client.enableNonRepudiationChecks(cfg);
                    return cfg;
                })
                .catch((e) => {
                    this._config = null; // retry discovery on the next attempt
                    throw e;
                });
        }
        return this._config;
    }

    authenticate(req, options) {
        this._run(req, options || {}).catch((e) => this.error(e));
    }

    async _run(req, options) {
        if (!req.session) return this.error(new Error('Entra sign-in requires a session'));
        const q = req.query || {};
        const isCallback = q.code != null || q.error != null || q.state != null;
        const store = (req.session.entraOidcPending = pruned(req.session.entraOidcPending));
        const client = require('openid-client');

        if (!isCallback) {
            const cfg = await this._configuration();
            const state = client.randomState();
            const nonce = client.randomNonce();
            const verifier = client.randomPKCECodeVerifier();
            const params = {
                redirect_uri: this._opts.redirectUrl,
                response_type: 'code',
                response_mode: 'query',
                scope: 'openid profile email',
                state,
                nonce,
                code_challenge: await client.calculatePKCECodeChallenge(verifier),
                code_challenge_method: 'S256',
            };
            if (options.prompt) params.prompt = options.prompt;
            const keys = Object.keys(store);
            while (keys.length >= ENTRA_PENDING_MAX) delete store[keys.shift()];
            store[state] = { nonce, verifier, at: Date.now() };
            return this.redirect(client.buildAuthorizationUrl(cfg, params).href);
        }

        // Callback: the state must be one THIS session started — single use.
        const state = typeof q.state === 'string' ? q.state : '';
        const pending = state && Object.hasOwn(store, state) ? store[state] : null;
        if (state) delete store[state];
        if (!pending) {
            return this.fail({
                code: 'sso_state',
                message: 'OIDC state missing, unknown or expired',
            });
        }
        const cfg = await this._configuration();
        // The redirect URI is the CONFIGURED one — never derived from the Host header.
        const currentUrl = new URL(this._opts.redirectUrl);
        const raw = String(req.originalUrl || req.url || '');
        currentUrl.search = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
        let claims;
        try {
            const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
                pkceCodeVerifier: pending.verifier,
                expectedState: state,
                expectedNonce: pending.nonce,
                idTokenExpected: true,
            });
            claims = tokens.claims();
        } catch (e) {
            if (e && OIDC_REFUSALS.has(e.name)) {
                // The audit trail gets the precise cause (which claim, which check).
                const c = e.cause || {};
                const detail = [c.claim && `claim ${c.claim}`, c.message || c.error]
                    .filter(Boolean)
                    .join(', ');
                const message = `${e.code || e.name}: ${e.message}${detail ? ` (${detail})` : ''}`;
                ssoDebug(`entra: sign-in refused — ${message}`);
                return this.fail({ code: 'sso_oidc_invalid', message });
            }
            throw e;
        }
        if (!claims) return this.fail({ code: 'sso_oidc_invalid', message: 'no ID token' });
        if (tenantMismatch(this._opts.tenant, claims.tid)) {
            return this.fail({ code: 'sso_tenant', message: `token tenant ${claims.tid} refused` });
        }
        this._verify(claims, (err, user, info) => {
            if (err) return this.error(err);
            if (!user) return this.fail(info);
            return this.success(user, info);
        });
    }
}

// Drop expired pending sign-ins; always returns a plain object.
function pruned(store) {
    const out = {};
    if (!store || typeof store !== 'object') return out;
    const now = Date.now();
    for (const [k, v] of Object.entries(store)) {
        if (v && typeof v.at === 'number' && now - v.at <= ENTRA_PENDING_TTL_MS) out[k] = v;
    }
    return out;
}

/**
 * Entra-issued API access token validator: signature against the tenant JWKS
 * (RS256 only), issuer, audience (client id or api://client id), expiry with a
 * 300 s clock tolerance, and `tid` when the tenant is configured by GUID.
 */
class EntraBearerStrategy extends PassportStrategy {
    constructor(opts) {
        super();
        this.name = 'sso-entra-bearer';
        this._opts = opts;
        this._jwks = null;
    }

    _keys() {
        if (!this._jwks) {
            const jose = require('jose');
            this._jwks = jose.createRemoteJWKSet(new URL(this._opts.jwksUri), {
                timeoutDuration: 10000,
                cooldownDuration: 30000,
                cacheMaxAge: 10 * 60 * 1000,
            });
        }
        return this._jwks;
    }

    /** Verified, mapped identity for a bearer JWT, or null. Never throws. */
    async verifyToken(token) {
        if (!looksLikeJwt(token)) return null;
        try {
            const jose = require('jose');
            const { payload } = await jose.jwtVerify(token, this._keys(), {
                issuer: this._opts.issuers,
                audience: this._opts.audiences,
                algorithms: ['RS256'],
                clockTolerance: ENTRA_CLOCK_TOLERANCE_S,
                requiredClaims: ['exp'],
            });
            if (tenantMismatch(this._opts.tenant, payload.tid)) {
                ssoDebug(`entra bearer: token tenant ${payload.tid} refused`);
                return null;
            }
            const mapped = mapEntraBearerClaims(payload);
            // the token's own amr/acr, kept out of the mapped identity's keys.
            Object.defineProperty(mapped, '_mfaEvidence', {
                value: AdminSso.oidcEvidence(payload),
                enumerable: false,
            });
            return mapped;
        } catch (e) {
            ssoDebug(`entra bearer: token refused (${(e && (e.code || e.name)) || e})`);
            return null;
        }
    }

    authenticate(req) {
        const authz = (req.headers && req.headers.authorization) || '';
        const bearer = authz.replace(/^Bearer\s+/i, '');
        this.verifyToken(bearer).then(
            (mapped) => (mapped ? this.success(mapped) : this.fail(401)),
            (e) => this.error(e)
        );
    }
}

function registerEntra(passport) {
    const tenant = env('AZURE_TENANT_ID');
    const clientID = env('AZURE_CLIENT_ID');
    const clientSecret = env('AZURE_CLIENT_SECRET');
    const redirectUrl = env('SSO_ENTRA_REDIRECT_URL') || env('SSO_REDIRECT_URL');
    if (!(tenant && clientID && clientSecret && redirectUrl)) return null;
    if (!libInstalled('openid-client')) {
        console.warn('⚠️  openid-client not installed — Entra SSO skipped.');
        return null;
    }

    const strategyName = 'sso-entra';
    passport.use(
        strategyName,
        new EntraOidcStrategy(
            { tenant, clientID, clientSecret, redirectUrl, authority: entraAuthority(tenant) },
            (claims, done) =>
                resolveAndFinish('entra', mapEntraClaims(claims), done, {
                    mfaEvidence: AdminSso.oidcEvidence(claims),
                })
        )
    );
    const custom = env('SSO_ENTRA_LABEL') || env('SSO_BUTTON_LABEL');
    return {
        key: 'entra',
        name: 'Microsoft',
        customLabel: !!custom,
        label: custom || 'Sign in with Microsoft',
        icon: 'fab fa-microsoft',
        strategyName,
        authOptions: { prompt: 'select_account', failureRedirect: '/login' },
    };
}

function registerOidc(passport) {
    const issuer = env('OIDC_ISSUER');
    const clientID = env('OIDC_CLIENT_ID');
    const clientSecret = env('OIDC_CLIENT_SECRET');
    const authorizationURL = env('OIDC_AUTH_URL');
    const tokenURL = env('OIDC_TOKEN_URL');
    const userInfoURL = env('OIDC_USERINFO_URL');
    const callbackURL = env('OIDC_REDIRECT_URL');
    if (!(
        issuer &&
        clientID &&
        clientSecret &&
        authorizationURL &&
        tokenURL &&
        userInfoURL &&
        callbackURL
    )) {
        return null;
    }

    let Strategy;
    try {
        Strategy = require('passport-openidconnect').Strategy;
    } catch (_) {
        console.warn('⚠️  passport-openidconnect not installed — generic OIDC SSO skipped.');
        return null;
    }

    const strategyName = 'sso-oidc';
    passport.use(
        strategyName,
        new Strategy(
            {
                issuer,
                authorizationURL,
                tokenURL,
                userInfoURL,
                clientID,
                clientSecret,
                callbackURL,
                scope: (env('OIDC_SCOPE') || 'openid profile email').split(/\s+/),
            },
            // Arity 4: passport-openidconnect then also passes the ID-token
            // `context` ({ class: acr, methods: amr }) — read for D5.
            (iss, profile, context, done) => {
                const j = (profile && profile._json) || {};
                const email =
                    j.email ||
                    j.preferred_username ||
                    (profile && Array.isArray(profile.emails) && profile.emails.length
                        ? profile.emails[0].value
                        : null);
                const mapped = {
                    sub: (profile && profile.id) || j.sub || null,
                    email: email ? String(email) : null,
                    name: (profile && profile.displayName) || j.name || null,
                    firstName:
                        j.given_name || (profile && profile.name && profile.name.givenName) || null,
                    lastName:
                        j.family_name ||
                        (profile && profile.name && profile.name.familyName) ||
                        null,
                    emailVerified: j.email_verified === true || String(j.email_verified) === 'true',
                };
                resolveAndFinish('oidc', mapped, done, {
                    mfaEvidence: AdminSso.oidcContextEvidence(context),
                });
            }
        )
    );
    return {
        key: 'oidc',
        name: null,
        customLabel: !!env('OIDC_LABEL'),
        label: env('OIDC_LABEL') || 'Sign in with SSO',
        icon: 'fab fa-openid',
        strategyName,
        authOptions: { failureRedirect: '/login' },
    };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.testOnly] UX-1 (3.23.21): the SSO master switch is OFF
 *   but the connection is saved — registered ONLY so a SuperAdmin can run the
 *   no-session test sign-in before activation. Every response that is not a test
 *   sign-in is refused (fail closed): nobody can sign in while the switch is off.
 */
function registerSaml(passport, opts = {}) {
    const testOnly = opts && opts.testOnly === true;
    const entryPoint = env('SAML_ENTRY_POINT');
    const issuer = env('SAML_ISSUER');
    const callbackUrl = env('SAML_CALLBACK_URL');
    // The IdP signing certificate (PEM body). Accept either an inline value or a
    // file path so secrets can live outside .env.
    let idpCert = env('SAML_IDP_CERT');
    if (!idpCert && env('SAML_IDP_CERT_FILE')) {
        try {
            idpCert = require('fs').readFileSync(env('SAML_IDP_CERT_FILE'), 'utf8');
        } catch (e) {
            console.warn(`⚠️  SAML_IDP_CERT_FILE unreadable: ${e.message}`);
        }
    }
    if (!(entryPoint && issuer && callbackUrl && idpCert)) return null;
    // Several PEM blocks (the metadata import stores every signing certificate
    // the IdP publishes) → an array, so an IdP certificate rotation does not
    // break sign-in on the day it happens.
    const Md = require('../services/SamlMetadataService');
    const idpCerts = Md.splitCerts(idpCert).map(Md.toPem);
    const SamlSec = require('../services/SamlSecurityService');
    const idpInitiated = /^(1|true|yes|on)$/i.test(String(env('SAML_IDP_INITIATED') || ''));

    let SamlStrategy;
    try {
        SamlStrategy = require('@node-saml/passport-saml').Strategy;
    } catch (_) {
        console.warn('⚠️  @node-saml/passport-saml not installed — SAML SSO skipped.');
        return null;
    }

    const strategyName = 'sso-saml';
    passport.use(
        strategyName,
        new SamlStrategy(
            {
                entryPoint,
                issuer,
                callbackUrl,
                idpCert: idpCerts.length > 1 ? idpCerts : idpCerts[0],
                // The IdP's entity ID, when known (the metadata import sets it).
                idpIssuer: env('SAML_IDP_ISSUER') || undefined,
                audience: issuer,
                acceptedClockSkewMs: 3 * 60 * 1000,
                maxAssertionAgeMs: 5 * 60 * 1000,
                // A response must answer a request WE sent — unless the admin allows
                // sign-in launched from the IdP portal, where only unsolicited
                // responses skip it. The request ids live in the database, so a
                // restart does not reopen the window.
                validateInResponseTo: idpInitiated ? 'ifPresent' : 'always',
                requestIdExpirationPeriodMs: 10 * 60 * 1000,
                cacheProvider: SamlSec.requestCache,
                passReqToCallback: true,
                wantAssertionsSigned: true,
                // Default to requiring the whole SAML response signed (defence-in-depth);
                // set SAML_WANT_RESPONSE_SIGNED=0 only for an IdP that signs the assertion
                // but not the response envelope.
                wantAuthnResponseSigned: env('SAML_WANT_RESPONSE_SIGNED') !== '0',
                disableRequestedAuthnContext: true,
                signatureAlgorithm: 'sha256',
                identifierFormat: samlNameIdFormat(),
            },
            // verify (login)
            async (req, profile, done) => {
                const pf = profile || {};
                const body = (req && req.body) || {};
                // A test sign-in from the SSO settings must explain a REFUSAL too —
                // wrong issuer, destination, replay — not only a success: those are
                // exactly the mistakes the test exists to diagnose.
                const SsoTest = require('../services/SsoTestService');
                const testTok = SsoTest.isTestRelayState(body.RelayState)
                    ? SsoTest.fromRelayState(body.RelayState, 'saml')
                    : null;
                // UX-1: registered for the pre-activation TEST only — a real (or
                // IdP-initiated, or expired-test) response never signs anyone in.
                if (testOnly && !testTok)
                    return done(null, false, {
                        code: 'sso_switch_off',
                        message: 'SSO is switched off: only a test sign-in is accepted',
                    });
                const refuse = (code, message) => {
                    if (testTok) {
                        SsoTest.setResult(testTok.nonce, {
                            ok: false,
                            code,
                            detail: message,
                            claims: testClaims(pf),
                        });
                        return done(null, false, { test: testTok.nonce });
                    }
                    return done(null, false, { code, message });
                };
                // The IdP issuer: node-saml's `idpIssuer` option is only enforced on
                // LOGOUT messages, never on the sign-in assertion (measured: a response
                // signed with a trusted key but naming another issuer signed the user
                // in). A certificate can be shared across entities — check it here.
                const expectedIdp = env('SAML_IDP_ISSUER');
                if (expectedIdp && pf.issuer !== expectedIdp) {
                    return refuse(
                        'sso_issuer',
                        `SAML issuer ${pf.issuer} is not the configured ${expectedIdp}`
                    );
                }
                // Destination must be OUR ACS, and an assertion is accepted once.
                const seen = SamlSec.inspectResponse(body.SAMLResponse);
                // Fail CLOSED: a response we cannot read cannot be checked for its
                // Destination — refused (round 2: a comment holding "<!DOCTYPE"
                // appended OUTSIDE the signed element made this read null, and the
                // old `seen && …` then skipped both the destination and replay checks).
                if (!seen) return refuse('sso_unparseable', 'SAML response could not be inspected');
                if (!SamlSec.destinationOk(seen.destination, callbackUrl)) {
                    return refuse(
                        'sso_destination',
                        `SAML response addressed to ${seen.destination}`
                    );
                }
                try {
                    // The replay key: the ID of the assertion node-saml verified.
                    const verifiedId = SamlSec.verifiedAssertionId(
                        typeof pf.getAssertionXml === 'function' ? pf.getAssertionXml() : null
                    );
                    const fresh = await SamlSec.recordAssertion({
                        issuer: pf.issuer,
                        assertionId: verifiedId,
                        notOnOrAfter: seen.notOnOrAfter,
                    });
                    if (!fresh)
                        return refuse('sso_replay', 'SAML assertion already used (replay refused)');
                } catch (e) {
                    return done(e);
                }
                const email = samlEmail(pf);
                // Trust the email as verified only when it IS the (signed) emailAddress
                // NameID — not an arbitrary IdP-asserted attribute — so a permissive IdP
                // can't impersonate by claiming someone else's address.
                const fmt = String(pf.nameIDFormat || '');
                const emailVerified = !!(
                    email &&
                    pf.nameID &&
                    String(pf.nameID).toLowerCase() === String(email).toLowerCase() &&
                    /emailAddress/i.test(fmt || 'emailAddress')
                );
                const mapped = {
                    // The NameID only. `pf.ID` is the Response ID — random on every
                    // login — so a link recorded under it could never match again.
                    sub: pf.nameID || null,
                    // Entra emits the immutable objectId in every SAML token: it is the
                    // key a link is recorded under (SsoService.stableUids).
                    oid: samlClaim(pf, SAML_CLAIMS.oid),
                    tid: samlClaim(pf, SAML_CLAIMS.tid),
                    upn: samlClaim(pf, SAML_CLAIMS.upn),
                    employeeId: samlClaim(pf, SAML_CLAIMS.employeeId),
                    email,
                    emailVerified,
                    name:
                        pf.displayName ||
                        pf.cn ||
                        pf['http://schemas.microsoft.com/identity/claims/displayname'] ||
                        null,
                    firstName:
                        pf.givenName ||
                        pf.firstName ||
                        pf['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'] ||
                        null,
                    lastName:
                        pf.sn ||
                        pf.surname ||
                        pf.lastName ||
                        pf['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'] ||
                        null,
                };
                // S5 residual (3.23.19): is the NameID an immutable (persistent) id?
                // Kept off the mapped keys (non-enumerable).
                Object.defineProperty(mapped, 'nameIdPersistent', {
                    value: /:nameid-format:persistent$/i.test(fmt),
                    enumerable: false,
                });
                // Test sign-in from the SSO settings: report, never sign in.
                if (SsoTest.isTestRelayState(body.RelayState)) {
                    const t = testTok;
                    if (!t)
                        return done(null, false, {
                            code: 'sso_test_expired',
                            message: 'Test sign-in token expired or unknown',
                        });
                    try {
                        const d = await SsoService.diagnose('saml', mapped);
                        SsoTest.setResult(t.nonce, {
                            ok: true,
                            claims: testClaims(pf),
                            mapped: publicMapped(mapped),
                            diagnosis: d,
                        });
                    } catch (e) {
                        SsoTest.setResult(t.nonce, { ok: false, error: e.message });
                    }
                    return done(null, false, { test: t.nonce });
                }
                // Defence in depth (UX-1): never reached in test-only mode.
                if (testOnly)
                    return done(null, false, {
                        code: 'sso_switch_off',
                        message: 'SSO is switched off: only a test sign-in is accepted',
                    });
                resolveAndFinish('saml', mapped, done, {
                    mfaEvidence: AdminSso.samlEvidence(pf),
                });
            },
            // logout verify (required by v5 signature; we don't do SLO state here)
            (req, profile, done) => done(null, profile)
        )
    );
    return {
        key: 'saml',
        name: null,
        customLabel: !!env('SAML_LABEL'),
        label: env('SAML_LABEL') || 'Sign in with SAML',
        icon: 'fas fa-key',
        strategyName,
        authOptions: { failureRedirect: '/login' },
    };
}

function registerGoogle(passport) {
    const clientID = env('GOOGLE_CLIENT_ID');
    const clientSecret = env('GOOGLE_CLIENT_SECRET');
    const callbackURL = env('GOOGLE_REDIRECT_URL');
    if (!(clientID && clientSecret && callbackURL)) return null;

    let GoogleStrategy;
    try {
        GoogleStrategy = require('passport-google-oauth20').Strategy;
    } catch (_) {
        console.warn('⚠️  passport-google-oauth20 not installed — Google SSO skipped.');
        return null;
    }

    const hostedDomain = env('GOOGLE_HD'); // optional: restrict to a Workspace domain
    const strategyName = 'sso-google';
    passport.use(
        strategyName,
        new GoogleStrategy(
            { clientID, clientSecret, callbackURL },
            (accessToken, refreshToken, profile, done) => {
                const j = (profile && profile._json) || {};
                // Enforce the hosted-domain restriction (defence-in-depth on top of
                // the resolve-to-existing-account policy).
                if (hostedDomain && j.hd && j.hd !== hostedDomain) {
                    return done(null, false, {
                        message: 'This Google account is not part of the permitted organization.',
                    });
                }
                const email =
                    (profile && Array.isArray(profile.emails) && profile.emails.length
                        ? profile.emails[0].value
                        : null) ||
                    j.email ||
                    null;
                const mapped = {
                    sub: (profile && profile.id) || j.sub || null,
                    email: email ? String(email) : null,
                    name: (profile && profile.displayName) || j.name || null,
                    firstName:
                        j.given_name || (profile && profile.name && profile.name.givenName) || null,
                    lastName:
                        j.family_name ||
                        (profile && profile.name && profile.name.familyName) ||
                        null,
                    emailVerified: j.email_verified === true || String(j.email_verified) === 'true',
                };
                resolveAndFinish('google', mapped, done);
            }
        )
    );
    return {
        key: 'google',
        name: 'Google',
        customLabel: !!env('GOOGLE_LABEL'),
        label: env('GOOGLE_LABEL') || 'Sign in with Google',
        icon: 'fab fa-google',
        strategyName,
        authOptions: {
            scope: ['profile', 'email'],
            prompt: 'select_account',
            failureRedirect: '/login',
            ...(hostedDomain ? { hd: hostedDomain } : {}),
        },
    };
}

// Azure AD / Entra JWT BEARER strategy — a non-interactive authentication measure
// for the API surface. A trusted caller (Power BI, a service, a script) presents an
// Entra-issued access token as `Authorization: Bearer <jwt>`; jose validates
// the signature (JWKS from the tenant), issuer, audience, expiry and tenant, and
// the verified claims are then resolved to a LOCAL account via SsoService — same
// anti-takeover posture as interactive SSO (pre-linked by Entra oid/external_id, or
// a verified-email employee match; admins are never linked by email). Returns a
// descriptor on success or null (creds absent / package missing / not enabled).
// Reads its own AZURE_API_* config but falls back to the interactive Entra app's
// client id so a single app-registration setup works with no extra config.
function registerEntraBearer(passport) {
    const tenant = env('AZURE_TENANT_ID');
    // EXPLICIT opt-in: the API bearer path activates only when AZURE_API_CLIENT_ID
    // is set. Configuring interactive Entra login (AZURE_CLIENT_ID) alone does NOT
    // silently open this additional, non-interactive auth surface — accepting API
    // tokens is a deliberate operator decision. (Point it at the same client id as
    // the login app if you want one app registration to serve both.)
    const clientID = env('AZURE_API_CLIENT_ID');
    if (!(tenant && clientID)) return null;
    // Expected token audience. v2.0 access tokens carry either the raw client id
    // or the App ID URI (api://<clientId>); allow both, and an explicit override.
    const audience = env('AZURE_API_AUDIENCE') || clientID;
    if (!libInstalled('jose')) {
        console.warn('⚠️  jose not installed — Entra API bearer auth skipped.');
        return null;
    }
    const authority = entraAuthority(tenant);
    // AZURE_API_ISSUER may list several issuers separated by commas (e.g. the v1
    // https://sts.windows.net/<tenant>/ issuer next to the v2.0 one).
    const issuers = (env('AZURE_API_ISSUER') || `${authority}/v2.0`)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const strategyName = 'sso-entra-bearer';
    _entraBearer = new EntraBearerStrategy({
        tenant,
        clientID,
        audiences: [...new Set([audience, `api://${clientID}`])],
        issuers,
        jwksUri: `${authority}/discovery/v2.0/keys`,
    });
    passport.use(strategyName, _entraBearer);
    return { key: 'entra-bearer', strategyName, transport: 'bearer' };
}

/** True when the Entra API bearer strategy is registered and ready. */
function isEntraBearerEnabled() {
    return _entraBearerReady === true && _passport != null;
}

/**
 * Validate an inbound `Authorization: Bearer <jwt>` as an Entra access token and
 * resolve it to a fully-hydrated local principal (admin/employee), or null if the
 * token is absent/invalid/unmatched. Never throws, never touches `res` (uses a
 * custom passport callback), and is a no-op when the bearer strategy is disabled.
 * The returned user is tagged `_entraBearer` (RBAC still governs, like a session).
 * @param {import('express').Request} req
 * @returns {Promise<object|null>}
 */
async function authenticateEntraBearer(req) {
    if (!isEntraBearerEnabled() || !_entraBearer) return null;
    const authz = (req && req.headers && req.headers.authorization) || '';
    const bearer = authz.replace(/^Bearer\s+/i, '');
    if (!looksLikeJwt(bearer)) return null;
    try {
        const mapped = await _entraBearer.verifyToken(bearer);
        if (!mapped) return null;
        // An API token never consumes an SSO-migration mapping.
        const trace = {};
        const principal = await SsoService.resolveIdentity('entra', mapped, {
            allowClaim: false,
            trace,
        });
        if (!principal) return null;
        if (principal.kind === 'admin') {
            // D8 (3.23.19): an admin principal from a bearer only when admin SSO
            // is on AND the admin passes the sign-in checks (active, not expired,
            // not locked, not 'local_only'); S4/S5: through a TRUSTED link on the
            // stable id, never an e-mail-like alias; S7: and the token itself
            // must carry IdP-asserted MFA (an API call has no /login/mfa step).
            const el = await AdminSso.eligibility(principal.id);
            if (!el.ok) {
                // C2f: a bearer that reached a SuperAdmin is reported (hourly).
                if (el.reason === 'superadmin_sso_forbidden')
                    require('../services/SuperadminAlertService')
                        .alert('security.superadmin_sso_refused', {
                            targetAdminId: principal.id,
                            detail: 'entra bearer: superadmin_sso_forbidden',
                            hourly: true,
                        })
                        .catch(() => {});
                return null;
            }
            if (!AdminSso.isTrustedLinkMethod(trace.linkMethod) || trace.aliasMatch === true)
                return null;
            if (!(await AdminSso.mfaAsserted(mapped._mfaEvidence))) return null;
        }
        const user = await hydratePrincipal(principal);
        if (!user) return null;
        // never a SuperAdmin principal from a bearer (belt and braces over
        // eligibility, which refuses it too).
        if (user.userType === 'admin' && user.role === 'superadmin') return null;
        user._entraBearer = true;
        user.apiScope = user.apiScope || 'entra.bearer';
        return user;
    } catch (_) {
        return null;
    }
}

const REGISTRARS = [registerEntra, registerOidc, registerSaml, registerGoogle];

/**
 * Register every configured SSO provider on the given passport instance.
 * Safe to call unconditionally at boot: no-ops when SSO is off, and skips any
 * provider whose credentials are missing or whose package isn't installed.
 * @param {import('passport').PassportStatic} passport
 * @returns {string[]} the keys of the providers that were activated
 */
// Core (re)registration against whatever _overrides + env currently say.
function _register(passport) {
    _passport = passport;
    _entraBearerReady = false;
    _entraBearer = null;
    for (const name of STRATEGY_NAMES) {
        try {
            passport.unuse(name);
        } catch (_) {
            /* not registered */
        }
    }
    _enabled.clear();
    _testOnly.clear();
    if (!isSsoEnabled()) {
        console.log(
            '• SSO disabled (set SSO_ENABLED=1 / enable it in Settings to activate single sign-on)'
        );
        // UX-1 (3.23.21): a saved SAML connection is registered for the
        // SuperAdmin's pre-activation TEST sign-in only. It is NOT an enabled
        // provider: no login button, no enforcement, no sign-in (registerSaml
        // refuses every non-test response in this mode).
        try {
            const d = registerSaml(passport, { testOnly: true });
            if (d) _testOnly.set(d.key, { ...d, testOnly: true });
        } catch (e) {
            console.warn(`⚠️  SAML test-only registration failed: ${e.message}`);
        }
        return [];
    }
    for (const register of REGISTRARS) {
        try {
            const descriptor = register(passport);
            if (descriptor) _enabled.set(descriptor.key, descriptor);
        } catch (e) {
            console.warn(`⚠️  SSO provider registration failed: ${e.message}`);
        }
    }
    // The Entra API bearer strategy is registered separately: it is NOT an
    // interactive login button, so it stays out of `_enabled` (which drives the
    // /login provider list) but is tracked for authenticateEntraBearer.
    try {
        if (registerEntraBearer(passport)) {
            _entraBearerReady = true;
            console.log(
                '✓ SSO Entra API bearer auth active (Authorization: Bearer <Entra JWT> accepted on /api/*)'
            );
        }
    } catch (e) {
        console.warn(`⚠️  Entra API bearer registration failed: ${e.message}`);
    }
    if (_enabled.size === 0) {
        if (interactiveIntended()) {
            // S12/N4 (3.23.19): SSO is switched ON and an interactive provider is
            // configured, but none could be registered (undecryptable secret, bad
            // certificate, DB error). Enforcement stays ON: every account but the
            // SuperAdmin break-glass is locked out until this is fixed — say it loudly.
            console.error(
                '[CRITICAL] SSO is enabled with an interactive provider configured, but NONE is registered — SSO stays ENFORCED: only the SuperAdmin break-glass password (/login?breakglass=1) can sign in. Fix Settings → Single Sign-On, or switch SSO off.'
            );
        } else if (!_entraBearerReady) {
            console.warn(
                '⚠️  SSO is enabled but no provider is configured — sign-in stays on passwords. See Settings → Single Sign-On (or .env.example).'
            );
        }
        if (!_entraBearerReady) return [];
    }
    if (_enabled.size) console.log(`✓ SSO active: ${[..._enabled.keys()].join(', ')}`);
    return [..._enabled.keys()];
}

// Synchronous, env-only configuration (no DB read). Used as a safe fallback and
// by unit tests; the live app uses reloadSso once the DB is connected.
function configureSso(passport) {
    setOverrides({});
    return _register(passport);
}

// Configure from the merged DB(Settings)+env config. Call after db.connect, and
// again whenever the SSO settings change in the UI — re-registers strategies live
// (no restart). Falls back to env-only if the settings can't be read.
async function reloadSso(passport) {
    let readOk = false;
    try {
        const SsoSettingsService = require('../services/SsoSettingsService');
        setOverrides(await SsoSettingsService.getOverrides());
        _settingsUnreadable = false;
        readOk = true;
    } catch (e) {
        console.warn(`⚠️  Could not load SSO settings from DB (${e.message}); using .env only.`);
        setOverrides({});
        // keep the last known SSO intent (enforcement never fails open).
        _settingsUnreadable = true;
        if (_lastIntent)
            console.error(
                '[CRITICAL] SSO settings unreadable — SSO enforcement kept from the last known configuration.'
            );
    }
    const keys = _register(passport);
    // The intent is recorded AFTER registration (a registered provider counts).
    if (readOk) _lastIntent = isSsoEnabled() && interactiveIntended();
    return keys;
}

/**
 * Provider descriptors for the login UI: [{ key, label, icon, name, customLabel }].
 * `name` ('Microsoft', 'Google', or null for a generic OIDC/SAML organisation IdP)
 * lets the page say « Se connecter avec Microsoft » in the reader's language;
 * `customLabel` = the operator configured a label of their own (shown verbatim).
 */
function getEnabledProviders() {
    return [..._enabled.values()].map((p) => ({
        key: p.key,
        label: p.label,
        icon: p.icon,
        name: p.name || null,
        customLabel: p.customLabel === true,
    }));
}

/** Full descriptor (incl. strategyName + authOptions) for a provider, or null. */
function getProvider(key) {
    return _enabled.get(key) || null;
}

/**
 * UX-1 (3.23.21): the provider a SuperAdmin TEST sign-in may use — an enabled
 * one, or a saved connection registered for the test only while the SSO master
 * switch is off. Callers must only use it for a test RelayState.
 */
function getTestProvider(key) {
    return _enabled.get(key) || _testOnly.get(key) || null;
}

/** True when at least one SSO provider is active. */
function isConfigured() {
    return _enabled.size > 0;
}

// The last SSO switch value read successfully from the settings.
let _lastIntent = false;
let _settingsUnreadable = false;

/**
 * S12 (3.23.19) — SSO ENFORCEMENT follows the master switch INTENT (settings or
 * .env), not provider health. When the settings could not be read, the last
 * known intent is kept (fail closed): a DB hiccup must not reopen the password
 * door for everyone.
 */
function isSsoIntended() {
    if (isSsoEnabled() && interactiveIntended()) return true;
    return _settingsUnreadable && _lastIntent;
}

/**
 * N4 (3.23.19): is an INTERACTIVE sign-in provider meant to be in use — one that
 * registered, or one whose credentials are configured even if it currently fails
 * (a secret that cannot be decrypted counts as configured)? The Entra API bearer
 * (AZURE_API_CLIENT_ID, e.g. Power BI) is NOT interactive: a bearer-only site is
 * not enforced. Boot: when the very first settings read fails, the decision is
 * made from .env alone (an interactive provider configured there → enforced);
 * after one successful read, the last known decision is kept while the settings
 * stay unreadable (fail closed). The last known decision is not persisted across
 * a restart.
 */
const INTERACTIVE_MARKERS = [
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'SAML_ENTRY_POINT',
    'SAML_IDP_CERT',
    'SAML_IDP_CERT_FILE',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
];
function interactiveIntended() {
    if (_enabled.size > 0) return true;
    const undecryptable = Array.isArray(_overrides.__undecryptable)
        ? _overrides.__undecryptable
        : [];
    return INTERACTIVE_MARKERS.some((n) => !!env(n) || undecryptable.includes(n));
}

/** True when SSO is intended but no interactive provider is registered (login-page alert). */
function isDegraded() {
    return isSsoIntended() && _enabled.size === 0;
}

module.exports = {
    configureSso,
    reloadSso,
    getEnabledProviders,
    getProvider,
    getTestProvider,
    isConfigured,
    // enforcement follows the SSO switch intent; degraded = no provider.
    isSsoIntended,
    isDegraded,
    // The req.user builder (SsoController's account chooser re-hydrates with it).
    hydratePrincipal,
    // Entra API bearer authentication (jose JWT verification).
    isEntraBearerEnabled,
    authenticateEntraBearer,
    looksLikeJwt,
    // Entra claim mapping (unit-tested) + the NODE_ENV=test-only mock-IdP seam.
    mapEntraClaims,
    mapEntraBearerClaims,
    _setEntraAuthorityForTests,
    // SSO-migration claim helpers (unit-tested).
    samlClaim,
    SAML_CLAIMS,
    // B1 (3.23.20): the shared strategy tail, exercised directly by the tests.
    _resolveAndFinishForTests: resolveAndFinish,
};
