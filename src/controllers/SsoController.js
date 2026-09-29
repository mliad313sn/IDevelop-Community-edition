'use strict';
/**
 * Multi-provider SSO sign-in endpoints.
 *   GET       /auth/sso/:provider           → redirect to the IdP to authenticate
 *   GET|POST  /auth/sso/:provider/callback   → IdP returns here; establish session
 *
 * :provider is one of the keys registered in config/sso.js (entra | oidc | saml
 * | google). Mirrors the local-login flow in AuthController: on success we
 * rotate the session id (anti-fixation) before establishing the session, and
 * audit the outcome. Authorization is unchanged — req.user is the same shape a
 * password login produces.
 *
 * Administrators (3.23.19): refused exactly as before unless SSO is enforced
 * (AdminSsoService.isEnforced); then an admin is reached only by an identity
 * linked directly to it, or — through the account chooser GET|POST
 * /auth/sso/choose — as the linked person of the employee the identity resolves
 * to; either identity must have been linked by a SuperAdmin or an onboarding
 * merge and matched on the stable id. Every admin sign-in is re-checked
 * (AdminSsoService.eligibility) and needs a second factor: local MFA (/login/mfa),
 * MFA asserted by the IdP, or a one-time enrolment code issued by a
 * SuperAdmin (/auth/sso/enrol-code, S1) — otherwise it is refused. The SuperAdmin
 * password + MFA stays the break-glass.
 */
const PRODUCT = require('../config/product');
const crypto = require('crypto');
const passport = require('passport');
const sso = require('../config/sso');
const AdminSso = require('../services/AdminSsoService');
const SsoService = require('../services/SsoService');
const LogService = require('../services/LogService');
const SsoTest = require('../services/SsoTestService');
const { safeRelayPath } = require('../services/SamlSecurityService');

function homeFor(userType) {
    if (userType === 'employee') return '/employee/dashboard';
    if (userType === 'manager') return '/supervisor/dashboard';
    return '/dashboard';
}

function authAudit(req, action, details, adminId = null) {
    try {
        LogService.log({
            adminId,
            action,
            entityType: 'auth',
            details,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
    } catch (_) {
        /* logging must never break auth */
    }
}

class SsoController {
    /** Kick off the chosen provider's redirect. */
    initiate(req, res, next) {
        const relay = (req.query && req.query.RelayState) || null;
        const isTest = SsoTest.isTestRelayState(relay);
        // UX-1 (3.23.21): a SuperAdmin test sign-in may use a saved connection
        // while the SSO switch is still off (registered for the test only).
        const provider = isTest
            ? sso.getTestProvider(req.params.provider)
            : sso.getProvider(req.params.provider);
        if (!provider) {
            req.flash(
                'error',
                req.t
                    ? req.t('flash:sso_method_unavailable')
                    : 'That sign-in method is not available.'
            );
            return res.redirect('/login');
        }
        if (isTest && !SsoTest.fromRelayState(relay, provider.key)) {
            req.flash(
                'error',
                req.t
                    ? req.t('admin:ssof_test_expired')
                    : 'This test sign-in has expired. Start it again.'
            );
            return res.redirect('/app-settings/sso');
        }
        if (!isTest && req.isAuthenticated && req.isAuthenticated()) {
            return res.redirect(homeFor(req.user && req.user.userType));
        }
        authAudit(req, 'SSO_INITIATE', `Single sign-on requested via ${provider.key}`);
        passport.authenticate(provider.strategyName, provider.authOptions)(req, res, next);
    }

    /** Handle the provider's callback and establish the session. */
    callback(req, res, next) {
        const cbRelay =
            (req.body && req.body.RelayState) || (req.query && req.query.RelayState) || null;
        // UX-1: only a TEST response may reach a test-only (switch off) provider.
        const provider =
            sso.getProvider(req.params.provider) ||
            (SsoTest.isTestRelayState(cbRelay) ? sso.getTestProvider(req.params.provider) : null);
        if (!provider) return res.redirect('/login');
        passport.authenticate(provider.strategyName, (err, user, info) => {
            if (err) {
                console.error(`SSO callback error [${provider.key}]:`, err);
                const relay = req.body && req.body.RelayState;
                const t = SsoTest.isTestRelayState(relay)
                    ? SsoTest.fromRelayState(relay, provider.key)
                    : null;
                if (t) {
                    SsoTest.setResult(t.nonce, {
                        ok: false,
                        code: 'sso_saml_invalid',
                        detail: String(err.message || err),
                    });
                    authAudit(
                        req,
                        'SSO_TEST_SIGNIN',
                        `${provider.key}: test sign-in refused (${err.message || err})`
                    );
                    return res.redirect(
                        `/app-settings/sso/test-result/${encodeURIComponent(t.nonce)}`
                    );
                }
                authAudit(
                    req,
                    'SSO_ERROR',
                    `SSO sign-in error via ${provider.key}: ${err.message || err}`
                );
                return flashAndLogin(req, res, 'flash:sso_failed', FB_FAILED);
            }
            if (!user) {
                // A test sign-in from the SSO settings: show the diagnostic, never log in.
                if (info && info.test) {
                    authAudit(
                        req,
                        'SSO_TEST_SIGNIN',
                        `${provider.key}: test sign-in completed (no session created)`
                    );
                    return res.redirect(
                        `/app-settings/sso/test-result/${encodeURIComponent(info.test)}`
                    );
                }
                // Auto-onboarded: an unknown identity that we parked as a pending
                // request — send to the holding page, not a denial.
                if (info && info.onboarding) {
                    authAudit(
                        req,
                        'SSO_ONBOARDING',
                        `${provider.key}: identity parked for onboarding`
                    );
                    return res.redirect('/onboarding/pending');
                }
                // The user sees ONE generic message — the specific reason (replay,
                // wrong destination, not provisioned…) goes to the audit trail
                // only, so the sign-in page never tells a stranger which accounts
                // exist. (The old expression `(info && info.message) || req.t ? … : …`
                // parsed as `((info && info.message) || req.t) ? …`: it always
                // dropped the reason, and called req.t when it was undefined.)
                const reason = (info && (info.code || info.message)) || 'unknown';
                authAudit(req, 'SSO_DENIED', `${provider.key}: ${reason}`);
                if (reason === 'superadmin_sso_forbidden')
                    alertSuperadminSso(info && info.adminId, `${provider.key}: ${reason}`);
                if (reason === 'sso_not_linked') {
                    // C3h: the IdP vouched for this person; say what to do next.
                    return notLinkedMessage(req, provider)
                        .catch(() => T(req, GENERIC_DENY[0], GENERIC_DENY[1], FALLBACK_VARS))
                        .then((m) => {
                            req.flash('error', m);
                            res.redirect('/login');
                        });
                }
                // UX-4: ONE generic refusal whatever the reason (anti-enumeration).
                return flashAndLogin(req, res, GENERIC_DENY[0], GENERIC_DENY[1]);
            }
            const ctx = user._ssoContext || {
                provider: provider.key,
                mfaAsserted: false,
                via: null,
                mapped: {},
            };
            // Deep link (SP-initiated ?RelayState=/path, or the IdP portal's
            // RelayState): only ever one of our own pages.
            const relay = safeRelayPath(
                (req.body && req.body.RelayState) || (req.query && req.query.RelayState)
            );
            // An identity linked DIRECTLY to an admin (D3a). Refused exactly as
            // before 3.23.19 unless the SuperAdmin switched admin SSO on; then
            // the admin is re-checked and must present a second factor.
            if (user.userType === 'admin') {
                return adminDirect(req, res, provider.key, user, ctx, relay).catch((e) =>
                    failed(req, res, provider.key, e)
                );
            }
            // Per-user authentication policy (migration 55): 'local_only'
            // refuses SSO for this account even though the identity resolves.
            if (String(user.authPolicy || user.auth_policy || 'any') === 'local_only') {
                authAudit(
                    req,
                    'SSO_DENIED',
                    `${provider.key}: account "${user.username || user.employeeNumber}" is restricted to local password sign-in (auth policy local_only)`
                );
                // UX-3 / EXC (3.23.21): while SSO is enforced a password is open
                // only to an employee a SuperAdmin listed as an SSO exception —
                // anyone else gets the generic refusal (whom to contact), never
                // advice to use a door that is closed to them.
                if (AdminSso.isEnforced() && !AdminSso.isSsoExcepted(user))
                    return flashAndLogin(req, res, GENERIC_DENY[0], GENERIC_DENY[1]);
                req.flash(
                    'error',
                    T(
                        req,
                        'flash:sso_local_only',
                        'Votre compte se connecte par identifiant et mot de passe, pas par SSO.'
                    )
                );
                return res.redirect(AdminSso.isEnforced() ? '/login?breakglass=1' : '/login');
            }
            // D3(b): the person behind this identity is also the linked person of
            // one or more administrator accounts → let them CHOOSE which account
            // to open. Only for an identity recorded before this sign-in (never a
            // first-time e-mail match or a migration mapping claimed just now),
            // linked by a TRUSTED method (S4: a SuperAdmin link or an onboarding
            // merge), and matched on the stable id, not an e-mail alias.
            return (async () => {
                let candidates = [];
                if (ctx.via === 'linked') {
                    try {
                        candidates = await AdminSso.linkedAdminCandidates(user.id);
                    } catch (e) {
                        // The employee sign-in itself must not fail on this lookup.
                        console.error('SSO linked-admin lookup error:', e);
                        candidates = [];
                    }
                }
                if (candidates.length) {
                    const why = ctx.aliasMatch
                        ? 'admin_uid_alias'
                        : ctx.unstableUid
                          ? 'admin_uid_unstable'
                          : !AdminSso.isTrustedLinkMethod(ctx.linkMethod)
                            ? 'admin_link_untrusted'
                            : null;
                    if (why) {
                        // Not offered; the person still signs in as themselves.
                        authAudit(
                            req,
                            'SSO_DENIED',
                            `${provider.key}: ${why} — employee #${user.id} not offered admin account(s) #${candidates.map((c) => c.id).join(', #')} (link method ${ctx.linkMethod || 'unknown'})`
                        );
                        candidates = [];
                    }
                }
                if (!candidates.length) {
                    return establish(req, res, user, {
                        relay,
                        audits: [
                            [
                                'LOGIN_SUCCESS',
                                `${user.userType} "${user.username || user.employeeNumber}" signed in via SSO (${provider.key})`,
                                null,
                            ],
                        ],
                    });
                }
                return startChoice(req, res, {
                    employeeId: Number(user.id),
                    adminIds: candidates.map((c) => c.id),
                    provider: provider.key,
                    mfaAsserted: ctx.mfaAsserted === true,
                    relay,
                    mapped: identityKeys(ctx.mapped),
                });
            })().catch((e) => failed(req, res, provider.key, e));
        })(req, res, next);
    }

    /** GET /auth/sso/choose — « Continuer en tant que … » (D3b / D6). */
    async showChoice(req, res) {
        try {
            if (req.isAuthenticated && req.isAuthenticated())
                return res.redirect(homeFor(req.user && req.user.userType));
            const c = req.session && req.session.ssoChoice;
            if (!c || Date.now() - Number(c.at || 0) > CHOICE_TTL_MS) {
                if (req.session) delete req.session.ssoChoice;
                return deny(
                    req,
                    res,
                    c ? c.provider : 'sso',
                    c ? 'chooser_expired' : 'chooser_invalid'
                );
            }
            const EmployeeModel = require('../models/EmployeeModel');
            const emp = await EmployeeModel.findById(c.employeeId);
            const db = require('../config/database');
            const admins = [];
            for (const id of c.adminIds || []) {
                // eslint-disable-next-line no-await-in-loop
                const a = await db.get('SELECT id, username, role FROM admins WHERE id = ?', [id]);
                if (a) admins.push({ id: Number(a.id), username: a.username, role: a.role });
            }
            const name = emp
                ? `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.username
                : '';
            return res.render('pages/auth/sso-choose-account', {
                layout: false,
                title: T(req, 'auth:sso_choose_title', 'Choisissez votre compte'),
                nonce: c.nonce,
                personName: name,
                admins,
            });
        } catch (e) {
            return failed(req, res, 'sso', e);
        }
    }

    /** POST /auth/sso/choose — single-use, CSRF-protected, re-validated. */
    async submitChoice(req, res) {
        const c = req.session && req.session.ssoChoice;
        // Single use: whatever happens next, this choice is spent.
        if (req.session) delete req.session.ssoChoice;
        try {
            if (!c) return deny(req, res, 'sso', 'chooser_invalid', 'no pending choice (replay?)');
            if (Date.now() - Number(c.at || 0) > CHOICE_TTL_MS)
                return deny(req, res, c.provider, 'chooser_expired');
            if (!sameNonce(req.body && req.body.nonce, c.nonce))
                return deny(req, res, c.provider, 'chooser_invalid', 'nonce mismatch');
            const choice = String((req.body && req.body.choice) || '');
            if (choice === 'employee') {
                const user = await sso.hydratePrincipal({ kind: 'employee', id: c.employeeId });
                const off =
                    !user ||
                    user.isActive === false ||
                    user.isAccountActive === false ||
                    String(user.authPolicy || user.auth_policy || 'any') === 'local_only';
                if (off)
                    return deny(
                        req,
                        res,
                        c.provider,
                        'chooser_invalid',
                        'employee no longer eligible'
                    );
                return establish(req, res, user, {
                    relay: c.relay,
                    audits: [
                        [
                            'LOGIN_SUCCESS',
                            `${user.userType} "${user.username || user.employeeNumber}" signed in via SSO (${c.provider}) — chose the employee account`,
                            null,
                        ],
                    ],
                });
            }
            const m = /^admin:(\d+)$/.exec(choice);
            const adminId = m ? Number(m[1]) : NaN;
            if (!m || !(c.adminIds || []).map(Number).includes(adminId))
                return deny(
                    req,
                    res,
                    c.provider,
                    'chooser_invalid',
                    `unoffered choice "${choice.slice(0, 40)}"`
                );
            // Re-validate at POST time: still the linked person (D3b), still eligible.
            const el = await AdminSso.eligibility(adminId);
            if (!el.ok) return deny(req, res, c.provider, el.reason, `admin #${adminId}`, adminId);
            const linked = Number(el.admin.linkedEmployeeId ?? el.admin.linked_employee_id);
            if (linked !== Number(c.employeeId))
                return deny(
                    req,
                    res,
                    c.provider,
                    'chooser_invalid',
                    `admin #${adminId} no longer linked to employee #${c.employeeId}`,
                    adminId
                );
            const admin = await sso.hydratePrincipal({ kind: 'admin', id: adminId });
            if (!admin)
                return deny(req, res, c.provider, 'admin_inactive', `admin #${adminId}`, adminId);
            return finishAdmin(req, res, {
                admin,
                provider: c.provider,
                method: 'linked-person',
                mfaAsserted: c.mfaAsserted === true,
                relay: c.relay,
                mapped: c.mapped || {},
                employeeId: c.employeeId,
            });
        } catch (e) {
            return failed(req, res, (c && c.provider) || 'sso', e);
        }
    }
}

// ---------------------------------------------------------------------------
// Admin SSO (3.23.19) — helpers shared by the callback, the chooser and
// AuthController.verifyMfaChallenge.
// ---------------------------------------------------------------------------

// A pending account choice lives this long, like a pending MFA code.
const CHOICE_TTL_MS = 5 * 60 * 1000;

function T(req, key, fallback, vars) {
    return req && typeof req.t === 'function'
        ? req.t(key, Object.assign({ defaultValue: fallback }, vars || {}))
        : String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
              vars && vars[k] != null ? String(vars[k]) : m
          );
}

// What the person reads for each refusal. The precise reason goes to the audit
// trail only (D4: a generic message — it must not reveal account state).
const DENY_MESSAGES = {
    admin_sso_disabled: [
        'flash:sso_admin_password_only',
        'Les comptes d’administration se connectent avec un mot de passe et une double authentification, pas par authentification unique.',
    ],
    chooser_expired: ['flash:sso_choice_expired', 'Le choix du compte a expiré. Reconnectez-vous.'],
    // said plainly — the person must know what to ask for.
    admin_mfa_required: [
        'flash:sso_admin_mfa_needed',
        'Connexion administrateur refusée : aucune double authentification n’est active. Demandez un code d’enrôlement à un super administrateur, puis reconnectez-vous.',
    ],
    enrol_code_expired: [
        'flash:sso_enrol_expired',
        'L’étape du code d’enrôlement a expiré. Reconnectez-vous.',
    ],
};
// UX-4 (3.23.21): the ONE generic refusal — it names nothing about the account
// (anti-enumeration) but says what to do: whom to contact, with the time.
const GENERIC_DENY = [
    'flash:sso_not_successful',
    'La connexion n’a pas abouti. Votre accès n’est peut-être pas (ou plus) ouvert dans {{app}}. Contactez {{contact}} en indiquant l’heure de la tentative.',
];
// UX-3: a technical failure (IdP error, session error).
const FB_FAILED =
    'La connexion n’a pas abouti. Réessayez dans un instant ; si cela persiste, contactez {{contact}}.';
const FALLBACK_VARS = { app: PRODUCT.name, contact: 'votre administrateur' };

/** {app, contact} for the sign-in messages (branding + setting sso.helpContact). */
async function messageVars(req) {
    let app = PRODUCT.name;
    try {
        const b = await require('../utils/branding').getBranding();
        if (b && b.appName) app = String(b.appName);
    } catch (_) {
        /* stock name */
    }
    let contact = null;
    try {
        contact = await require('../services/SsoInviteService').helpContact();
    } catch (_) {
        contact = null;
    }
    return {
        app,
        contact: contact || T(req, 'auth:ssoinv_contact_default', 'votre administrateur'),
    };
}

/** Flash one sign-in message (with {{app}}/{{contact}}) and go back to /login. */
function flashAndLogin(req, res, key, fallback, to = '/login') {
    return messageVars(req)
        .catch(() => FALLBACK_VARS)
        .then((v) => {
            req.flash('error', T(req, key, fallback, v));
            res.redirect(to);
        });
}

function deny(req, res, providerKey, reason, detail = '', adminId = null) {
    authAudit(
        req,
        'SSO_DENIED',
        `${providerKey}: ${reason}${detail ? ` — ${detail}` : ''}`,
        adminId
    );
    // C2f (3.23.20): every SuperAdmin hears of an SSO route that reached a
    // SuperAdmin account (at most once an hour per account). Never blocks.
    if (reason === 'superadmin_sso_forbidden')
        alertSuperadminSso(adminId, `${providerKey}: ${detail || reason}`);
    const [key, fb] = DENY_MESSAGES[reason] || GENERIC_DENY;
    return flashAndLogin(req, res, key, fb);
}

/** C3h — « Votre compte {Fournisseur} est reconnu, mais … Contactez {contact} … ». */
async function notLinkedMessage(req, provider) {
    const Inv = require('../services/SsoInviteService');
    const contact =
        (await Inv.helpContact()) || T(req, 'auth:ssoinv_contact_default', 'votre administrateur');
    let app = PRODUCT.name;
    try {
        const b = await require('../utils/branding').getBranding();
        if (b && b.appName) app = b.appName;
    } catch (_) {
        /* stock name */
    }
    const label = (provider && provider.label) || Inv.providerLabel(provider && provider.key);
    return T(
        req,
        'auth:login_sso_not_linked',
        `Votre compte ${label} est reconnu, mais il n’est pas encore relié à ${app}. Contactez ${contact} en indiquant votre matricule.`,
        { provider: label, app, contact }
    );
}

function alertSuperadminSso(adminId, detail) {
    try {
        require('../services/SuperadminAlertService')
            .alert('security.superadmin_sso_refused', {
                targetAdminId: adminId,
                detail,
                hourly: true,
            })
            .catch(() => {});
    } catch (_) {
        /* alerts never break auth */
    }
}

function failed(req, res, providerKey, err) {
    console.error(`SSO sign-in error [${providerKey}]:`, err);
    authAudit(
        req,
        'SSO_ERROR',
        `SSO sign-in error via ${providerKey}: ${(err && err.message) || err}`
    );
    return flashAndLogin(req, res, 'flash:sso_failed', FB_FAILED);
}

// The identifiers stampAdminIdentityUse needs — never the whole profile in the session.
function identityKeys(mapped) {
    const m = mapped || {};
    return { oid: m.oid || null, sub: m.sub || null, id: m.id || null };
}

function sameNonce(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Rotate the session id (anti-fixation), then log in, audit and go home.
 * `init(session)` runs on the FINAL session, INSIDE the logIn callback and
 * BEFORE the response: passport 0.6 regenerates the session again in logIn and
 * copies nothing across (N1 — a flag set before logIn was silently wiped), so a
 * hold flag set here is the one that is saved. The session is marked as opened
 * by SSO — with the linked person's id for the D3b route.
 */
function establish(
    req,
    res,
    user,
    { relay, audits = [], after = null, init = null, viaEmployeeId = null }
) {
    markSso(user, viaEmployeeId);
    return new Promise((resolve) => {
        req.session.regenerate((rerr) => {
            if (rerr) console.error('Session regenerate error (SSO):', rerr);
            req.logIn(user, (lerr) => {
                if (lerr) {
                    console.error('SSO login session error:', lerr);
                    req.flash(
                        'error',
                        T(req, 'flash:sso_session_error', 'Failed to create session')
                    );
                    res.redirect('/login');
                    return resolve();
                }
                if (init) init(req.session);
                for (const [action, details, adminId] of audits)
                    authAudit(req, action, details, adminId);
                Promise.resolve(after && after())
                    .catch(() => {})
                    .then(() => {
                        res.redirect(relay || homeFor(user.userType));
                        resolve();
                    });
            });
        });
    });
}

/** S3/S11: tag the user so serializeUser records `via: 'sso'` (+ the linked person). */
function markSso(user, viaEmployeeId = null) {
    Object.defineProperty(user, '_sessionVia', {
        value: { via: 'sso', viaEmployeeId: viaEmployeeId == null ? null : Number(viaEmployeeId) },
        enumerable: false,
        configurable: true,
    });
    return user;
}

/** Park the D3(b) choice server-side and show the chooser. */
function startChoice(req, res, data) {
    return new Promise((resolve) => {
        // Rotate at the IdP → chooser boundary too, like password → MFA.
        req.session.regenerate((rerr) => {
            if (rerr) console.error('Session regenerate (SSO chooser) error:', rerr);
            req.session.ssoChoice = {
                ...data,
                nonce: crypto.randomBytes(24).toString('base64url'),
                at: Date.now(),
            };
            authAudit(
                req,
                'SSO_CHOOSER',
                `${data.provider}: employee #${data.employeeId} is the linked person of admin account(s) #${data.adminIds.join(', #')} — account choice offered`
            );
            req.session.save(() => {
                res.redirect('/auth/sso/choose');
                resolve();
            });
        });
    });
}

/** D3(a): an identity linked directly to an admin account. */
async function adminDirect(req, res, providerKey, user, ctx, relay) {
    if (!(await AdminSso.isAdminSsoEnabled())) {
        // Exactly the pre-3.23.19 refusal (same message), plus a reason code.
        return deny(
            req,
            res,
            providerKey,
            'admin_sso_disabled',
            `admin account "${user.username}" attempted SSO — admins must use password + MFA`,
            user.id
        );
    }
    const el = await AdminSso.eligibility(user.id, { skipSwitch: true });
    if (!el.ok) return deny(req, res, providerKey, el.reason, `admin "${user.username}"`, user.id);
    // never on an e-mail-like alias when the assertion carries another stable
    // id; S4: only an identity a SuperAdmin linked (or an onboarding merge).
    if (ctx.aliasMatch === true)
        return deny(req, res, providerKey, 'admin_uid_alias', `admin "${user.username}"`, user.id);
    if (ctx.unstableUid === true)
        return deny(
            req,
            res,
            providerKey,
            'admin_uid_unstable',
            `admin "${user.username}"`,
            user.id
        );
    if (!AdminSso.isTrustedLinkMethod(ctx.linkMethod))
        return deny(
            req,
            res,
            providerKey,
            'admin_link_untrusted',
            `admin "${user.username}" (link method ${ctx.linkMethod || 'unknown'})`,
            user.id
        );
    return finishAdmin(req, res, {
        admin: user,
        provider: providerKey,
        method: 'direct',
        mfaAsserted: ctx.mfaAsserted === true,
        relay,
        mapped: identityKeys(ctx.mapped),
    });
}

/**
 * D5 as decided by design review — the second factor, then the
 * session:
 *   local  → the SAME /login/mfa challenge as the password path (the SSO proved
 *            the first factor only);
 *   idp    → the IdP asserted MFA (S6 rule): signed in;
 *   code   → a SuperAdmin issued a one-time enrolment code: it must be typed
 *            (/auth/sso/enrol-code) BEFORE the session opens, which then stays
 *            held on TOTP enrolment until a code is verified in it;
 *   refuse → nothing of the above (and never 'code' for a SuperAdmin).
 */
async function finishAdmin(
    req,
    res,
    { admin, provider, method, mfaAsserted, relay, mapped, employeeId = null }
) {
    // C1a: re-assert on the database role at the last step (fail closed).
    const sa = await AdminSso.assertNotSuperadmin(admin.id);
    if (!sa.ok)
        return deny(
            req,
            res,
            provider,
            sa.reason,
            `admin "${admin.username}" (${method})`,
            admin.id
        );
    const mode = await AdminSso.secondFactor(admin.id, mfaAsserted);
    const viaEmployeeId = method === 'linked-person' ? employeeId : null;
    if (mode === 'local' || mode === 'code') {
        authAudit(
            req,
            mode === 'local' ? 'MFA_CHALLENGE' : 'MFA_ENROL_CODE_REQUESTED',
            `${mode === 'local' ? 'MFA code' : 'One-time enrolment code'} requested for admin "${admin.username}" (first factor: SSO via ${provider}, ${method})`,
            admin.id
        );
        const pending = {
            id: Number(admin.id),
            userType: 'admin',
            at: Date.now(),
            via: 'sso',
            provider,
            method,
            employeeId: employeeId == null ? null : Number(employeeId),
            relay: relay || null,
            mapped: mapped || {},
        };
        return new Promise((resolve) => {
            req.session.regenerate((rerr) => {
                if (rerr) console.error('Session regenerate (SSO pre-MFA) error:', rerr);
                if (mode === 'local') req.session.mfaPending = pending;
                else req.session.ssoEnrolPending = { ...pending, fails: 0 };
                req.session.save(() => {
                    res.redirect(mode === 'local' ? '/login/mfa' : '/auth/sso/enrol-code');
                    resolve();
                });
            });
        });
    }
    if (mode === 'refuse') {
        return deny(
            req,
            res,
            provider,
            'admin_mfa_required',
            `admin "${admin.username}" (${method}): no local MFA, no IdP-asserted MFA, no enrolment code`,
            admin.id
        );
    }
    return establish(req, res, admin, {
        relay,
        viaEmployeeId,
        // the IdP proved the second factor for THIS session.
        init: (s) => {
            s.mfaVerifiedInSession = true;
        },
        audits: ssoAdminAudits(admin, provider, method, 'idp'),
        after: () =>
            method === 'direct'
                ? SsoService.stampAdminIdentityUse(provider, mapped, admin.id)
                : null,
    });
}

// A pending enrolment-code step lives as long as a pending MFA code.
const ENROL_PENDING_TTL_MS = 5 * 60 * 1000;

/** GET /auth/sso/enrol-code — the one-time code screen. */
async function showEnrolCode(req, res) {
    const p = req.session && req.session.ssoEnrolPending;
    if (!p || Date.now() - Number(p.at || 0) > ENROL_PENDING_TTL_MS) {
        if (req.session) delete req.session.ssoEnrolPending;
        return deny(req, res, p ? p.provider : 'sso', 'enrol_code_expired');
    }
    return res.render('pages/auth/sso-enrol-code', {
        layout: false,
        title: T(req, 'auth:sso_enrol_title', 'Code d’enrôlement à usage unique'),
    });
}

/**
 * POST /auth/sso/enrol-code — check and CONSUME the SuperAdmin's code, then open
 * the session HELD on TOTP enrolment (the hold is set on the new session before
 * logIn, S10). 5 wrong codes end the pending step (and the code itself, S1).
 */
async function submitEnrolCode(req, res) {
    const p = req.session && req.session.ssoEnrolPending;
    try {
        if (!p || Date.now() - Number(p.at || 0) > ENROL_PENDING_TTL_MS) {
            if (req.session) delete req.session.ssoEnrolPending;
            return deny(req, res, p ? p.provider : 'sso', 'enrol_code_expired');
        }
        // Re-check the admin (D4 + S4 link still valid for the linked-person route).
        const el = await AdminSso.eligibility(p.id);
        const linked = el.admin
            ? Number(el.admin.linkedEmployeeId ?? el.admin.linked_employee_id)
            : NaN;
        const reason = !el.ok
            ? el.reason
            : p.method === 'linked-person' && linked !== Number(p.employeeId)
              ? 'chooser_invalid'
              : null;
        if (reason) {
            delete req.session.ssoEnrolPending;
            return deny(
                req,
                res,
                p.provider,
                reason,
                `admin #${p.id} at the enrolment-code step`,
                p.id
            );
        }
        const r = await AdminSso.consumeEnrolCode(p.id, req.body && req.body.code);
        if (!r.ok) {
            p.fails = Number(p.fails || 0) + 1;
            authAudit(
                req,
                'MFA_ENROL_CODE_FAILED',
                `Wrong enrolment code for admin #${p.id} (${r.reason})`,
                p.id
            );
            if (r.reason !== 'invalid' || p.fails >= AdminSso.ENROL_CODE_MAX_TRIES) {
                delete req.session.ssoEnrolPending;
                return deny(
                    req,
                    res,
                    p.provider,
                    'enrol_code_refused',
                    `admin #${p.id}: ${r.reason}`,
                    p.id
                );
            }
            req.session.ssoEnrolPending = p;
            req.flash(
                'error',
                T(req, 'flash:sso_enrol_code_invalid', 'Code incorrect. Vérifiez-le et réessayez.')
            );
            return res.redirect('/auth/sso/enrol-code');
        }
        delete req.session.ssoEnrolPending;
        const admin = await sso.hydratePrincipal({ kind: 'admin', id: p.id });
        if (!admin) return deny(req, res, p.provider, 'admin_inactive', `admin #${p.id}`, p.id);
        return establish(req, res, admin, {
            relay: '/v2/uam/mfa/setup',
            viaEmployeeId: p.method === 'linked-person' ? p.employeeId : null,
            init: (s) => {
                s.mfaEnrolRequired = true;
            },
            audits: ssoAdminAudits(admin, p.provider, p.method, 'enrol-code'),
            after: () => {
                req.flash(
                    'warning',
                    T(
                        req,
                        'flash:sso_admin_mfa_enrol',
                        'Compte administrateur : configurez la double authentification pour continuer.'
                    )
                );
                return p.method === 'direct'
                    ? SsoService.stampAdminIdentityUse(p.provider, p.mapped, admin.id)
                    : null;
            },
        });
    } catch (e) {
        return failed(req, res, (p && p.provider) || 'sso', e);
    }
}

/**
 * the audit rows of an admin SSO sign-in: SSO_LOGIN (how: provider, method,
 * mfa), and LOGIN_SUCCESS, which is what an admin's "last sign-in" and the
 * access review read (admins carry no last_login column — that row IS the stamp).
 */
function ssoAdminAudits(admin, provider, method, mfa) {
    return [
        [
            'SSO_LOGIN',
            `admin "${admin.username}" signed in via SSO — provider=${provider} method=${method} mfa=${mfa}`,
            Number(admin.id),
        ],
        [
            'LOGIN_SUCCESS',
            `admin "${admin.username}" signed in via SSO (${provider})`,
            Number(admin.id),
        ],
    ];
}

const controller = new SsoController();
// AuthController.verifyMfaChallenge writes the same D9 rows after an SSO-first
// admin passes the local MFA code; tests read the TTL.
controller._internals = { CHOICE_TTL_MS, ssoAdminAudits, markSso };
// the one-time enrolment-code step (pre-auth, like the chooser).
controller.showEnrolCode = showEnrolCode;
controller.submitEnrolCode = submitEnrolCode;

/**
 * POST /admins/:id/mfa-enrol-code (SuperAdmin; the route guards it too) —
 * « Autoriser l'enrôlement MFA ». N6: the clear code is rendered ONCE directly
 * in this response — never put in a flash or the session; the database keeps
 * only its hash; the page is not cached.
 */
controller.issueEnrolCode = async function issueEnrolCode(req, res) {
    const r = await AdminSso.issueEnrolCode(req.params.id, req.user);
    if (r.ok) {
        res.set('Cache-Control', 'no-store');
        return res.render('pages/admins/enrol-code-issued', {
            title: T(req, 'admin:adm_mfa_enrol_code_label', 'Code d’enrôlement'),
            code: r.code,
            username: r.username,
            adminId: Number(req.params.id),
        });
    }
    req.flash('error', T(req, `flash:adm_enrol_code_${r.code}`, 'Code d’enrôlement non émis.'));
    return res.redirect(`/admins/${Number(req.params.id)}`);
};
module.exports = controller;
