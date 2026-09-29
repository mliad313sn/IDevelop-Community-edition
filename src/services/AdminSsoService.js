'use strict';
/**
 * Single sign-on for ADMINISTRATOR accounts.
 *
 * Until 3.23.18 an SSO identity that resolved to an admin was refused outright:
 * the second factor could not be guaranteed on the IdP redirect. This module
 * holds every rule that now decides whether it may pass, so the controller, the
 * API bearer path and the SSO test page all apply the SAME rules:
 *
 *   - A1/A2/S12  SSO is ENFORCED whenever the SSO switch is on (even with no
 *         working provider); admin SSO is then allowed and a password opens only
 *         an active SuperAdmin account (break-glass);
 *   - D3/S4/S5  only two explicit routes reach an admin: an identity linked
 *         DIRECTLY to the admin, or the linked person (admins.linked_employee_id)
 *         of the employee the identity resolves to — the identity linked by a
 *         SuperAdmin or an onboarding merge, matched on its stable id;
 *   - D4/S2  the admin is re-checked: active, access not expired, not explicitly
 *         locked (never the password-attempt counter), auth policy other than
 *         'local_only' (A3: that policy binds only a SuperAdmin while enforced);
 *   - D5/S1/S6  a second factor: local MFA (the /login/mfa challenge), MFA
 *         asserted by the IdP (one rule, see mfaFromEvidence), or a ONE-TIME
 *         enrolment code issued by a SuperAdmin — otherwise refused;
 *   - A5  the readiness report (no SSO path, unconfirmed identities, no MFA).
 *   - B1 (3.23.20)  a SuperAdmin NEVER signs in through SSO (reason
 *         superadmin_sso_forbidden): eligibility refuses it for every route;
 *         the break-glass password + TOTP is its only door.
 *
 * Nothing here signs anyone in; it answers questions.
 *
 * @module services/AdminSsoService
 */
const db = require('../config/database');

/**
 * AMENDMENT A1 + S12 — SSO ENFORCEMENT follows the SSO master switch INTENT
 * (SSO enabled in the settings or .env), not the health of provider
 * registration: an SSO switched on whose providers failed to register
 * (undecryptable secret, DB error) stays ENFORCED — only the SuperAdmin
 * break-glass password works, and the login page says so. While enforced a
 * password sign-in is accepted only for an active SuperAdmin; everyone else
 * signs in through SSO. Switching SSO off is how enforcement ends.
 */
function isEnforced() {
    try {
        const sso = require('../config/sso');
        if (typeof sso.isSsoIntended === 'function') return sso.isSsoIntended() === true;
        return sso.isConfigured() === true;
    } catch (_) {
        return false;
    }
}

/**
 * administrators may use SSO exactly while enforcement is on (local admins
 * have no other way in). With SSO off nothing changes. Kept async: callers
 * await it and a future setting could make it so.
 */
async function isAdminSsoEnabled() {
    return isEnforced();
}

/** An ACTIVE SuperAdmin — the only account a password may open while enforced. */
function isActiveSuperadmin(u) {
    return (
        !!u &&
        u.userType === 'admin' &&
        u.role === 'superadmin' &&
        u.isActive !== false &&
        u.is_active !== false
    );
}

// ---------------------------------------------------------------------------
// EXC (3.23.21, PO decision) — SSO EXCEPTIONS for EMPLOYEES explicitly listed by
// a SuperAdmin (migration 156: employees.sso_exception_at/_by/_reason). While
// SSO is enforced such an employee keeps password sign-in (and password reset);
// no SSO invitation or announcement is sent to them. Never an admin account: the
// SuperAdmin break-glass rule is unchanged and a local admin stays SSO-only.
// ---------------------------------------------------------------------------

/** An EMPLOYEE principal (row or req.user) carrying an SSO exception, active. */
function isSsoExcepted(u) {
    if (!u || u.userType === 'admin') return false;
    const at = u.ssoExceptionAt ?? u.sso_exception_at;
    const by = u.ssoExceptionBy ?? u.sso_exception_by;
    if (!at || by == null) return false;
    return (
        u.isActive !== false &&
        u.is_active !== false &&
        u.isAccountActive !== false &&
        u.is_account_active !== false
    );
}

/** A1 + EXC: may a PASSWORD open this account while SSO is enforced? */
function passwordAllowedWhileEnforced(u) {
    return isActiveSuperadmin(u) || isSsoExcepted(u);
}

/** EXC read from the database (an employee id). False on any error (fail closed). */
async function hasSsoException(employeeId) {
    try {
        const r = await db.get(
            `SELECT id, sso_exception_at, sso_exception_by, is_active, is_account_active
               FROM employees WHERE id = ?`,
            [Number(employeeId)]
        );
        return isSsoExcepted(r);
    } catch (_) {
        return false;
    }
}

/**
 * EXC — set or clear an employee's SSO exception. SuperAdmin ONLY (checked on
 * the actor's database role at write time, fail closed), employees only,
 * audited (EMPLOYEE_SSO_EXCEPTION_SET / _CLEARED). A reason is mandatory to set.
 * Clearing re-queues the SSO invitation that the exception had held back.
 * @returns {Promise<{ok:boolean, code:string}>}
 */
async function setSsoException(employeeId, { on, reason } = {}, actor = null) {
    const id = Number(employeeId);
    // Fail closed: an ACTIVE SuperAdmin, read from the database now.
    const a = actor && actor.userType === 'admin' ? await adminRow(actor.id) : null;
    if (!a || a.role !== 'superadmin' || (a.isActive ?? a.is_active) === false)
        return { ok: false, code: 'superadmin_only' };
    if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 'not_found' };
    const emp = await db.get(
        'SELECT id, employee_number, first_name, last_name, sso_exception_at FROM employees WHERE id = ?',
        [id]
    );
    if (!emp) return { ok: false, code: 'not_found' };
    const who =
        `${emp.firstName ?? emp.first_name ?? ''} ${emp.lastName ?? emp.last_name ?? ''}`.trim();
    if (on) {
        const why = String(reason == null ? '' : reason)
            .replace(/[\u0000-\u001F\u007F]+/g, ' ') // eslint-disable-line no-control-regex
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300);
        if (!why) return { ok: false, code: 'reason_required' };
        // The exception IS password sign-in: a password an earlier SSO sign-in
        // switched off (ssoDisablesLocalPassword) is switched back on.
        await db.run(
            `UPDATE employees SET sso_exception_at = now(), sso_exception_by = ?, sso_exception_reason = ?,
                    password_disabled = false
              WHERE id = ?`,
            [Number(actor.id), why, id]
        );
        await auditException(
            actor,
            id,
            'EMPLOYEE_SSO_EXCEPTION_SET',
            `SSO exception granted to employee #${id} (${who}) — password sign-in allowed while SSO is enforced. Reason: ${why}`
        );
        return { ok: true, code: 'set' };
    }
    if (!(emp.ssoExceptionAt ?? emp.sso_exception_at)) return { ok: true, code: 'unchanged' };
    await db.run(
        `UPDATE employees SET sso_exception_at = NULL, sso_exception_by = NULL, sso_exception_reason = NULL
          WHERE id = ?`,
        [id]
    );
    try {
        await require('./SsoInviteService').requeueAfterException(id);
    } catch (_) {
        /* the Accounts console can still re-queue it */
    }
    await auditException(
        actor,
        id,
        'EMPLOYEE_SSO_EXCEPTION_CLEARED',
        `SSO exception removed from employee #${id} (${who}) — SSO only from now on while SSO is enforced`
    );
    return { ok: true, code: 'cleared' };
}

/** How many active employees hold an SSO exception (0 on any error). */
async function countSsoExceptions() {
    try {
        const r = await db.get(
            `SELECT COUNT(*)::int AS n FROM employees
              WHERE sso_exception_at IS NOT NULL AND sso_exception_by IS NOT NULL
                AND is_active IS DISTINCT FROM false AND is_account_active IS DISTINCT FROM false`
        );
        return Number((r && r.n) || 0);
    } catch (_) {
        return 0;
    }
}

async function auditException(actor, employeeId, action, details) {
    try {
        await require('./LogService').log({
            adminId: Number(actor.id),
            action,
            entityType: 'employee',
            entityId: Number(employeeId),
            category: 'security',
            details,
        });
    } catch (_) {
        /* audit best-effort */
    }
}

// ---------------------------------------------------------------------------
// IdP-asserted multi-factor (D5, as tightened by S6). The strategies collect
// the raw EVIDENCE ({ amr: [...], acr: [...] }); one rule decides.
//   MFA when: amr has 'mfa' or 'mca'; OR amr covers at least TWO distinct
//   factor classes (knowledge / possession / inherence); OR an acr /
//   AuthnContextClassRef value is a built-in multi-factor value or one listed
//   by the operator in `sso.mfaAcrValues`. One factor alone (sms, otp, rsa…)
//   is NOT multi-factor.
// ---------------------------------------------------------------------------

const AMR_CLASS = {
    pwd: 'knowledge',
    kba: 'knowledge',
    otp: 'possession',
    sms: 'possession',
    tel: 'possession',
    hwk: 'possession',
    swk: 'possession',
    pop: 'possession',
    face: 'inherence',
    fpt: 'inherence',
    iris: 'inherence',
    retina: 'inherence',
    vbm: 'inherence',
};
// Entra `multipleauthn`, the SAML / PAPE « MultiFactor » class refs, the REFEDS
// MFA profile. Entra v1 `acr: "1"` means "not anonymous": never matched.
const BUILTIN_MFA_ACR = [
    /multipleauthn/i,
    /multi-?factor/i,
    /^https:\/\/refeds\.org\/profile\/mfa$/i,
];

const asList = (v) =>
    v == null
        ? []
        : (Array.isArray(v) ? v : [v])
              .map((x) => String(x == null ? '' : x).trim())
              .filter(Boolean);

/** The one rule. `extraAcr` = the operator's list (exact, case-insensitive). */
function mfaFromEvidence(evidence, extraAcr = []) {
    const ev = evidence || {};
    const amr = asList(ev.amr).map((m) => m.toLowerCase());
    if (amr.includes('mfa') || amr.includes('mca')) return true;
    const classes = new Set(amr.map((m) => AMR_CLASS[m]).filter(Boolean));
    if (classes.size >= 2) return true;
    // a bare number is never an MFA marker (Entra v1 sends acr "1" on every
    // sign-in), even if one reached the setting some other way.
    const extra = asList(extraAcr)
        .filter((x) => !isWeakAcrValue(x))
        .map((x) => x.toLowerCase());
    return asList(ev.acr).some(
        (a) => BUILTIN_MFA_ACR.some((re) => re.test(a)) || extra.includes(a.toLowerCase())
    );
}

/**
 * values that can never mark multi-factor: digits only ('0'…'9', '1'…),
 * and password class refs (SAML PasswordProtectedTransport / Password, OIDC/Entra
 * 'pwd', any '…password…' URI).
 */
function isWeakAcrValue(s) {
    const v = String(s || '').trim();
    return /^\d+$/.test(v) || /password/i.test(v) || /(^|[:/#])pwd$/i.test(v);
}

/** The operator's extra acr list (App Setting `sso.mfaAcrValues`, comma list). */
async function operatorAcrValues() {
    try {
        const v = await require('../models/AppSettingsModel').getValue('sso.mfaAcrValues', '');
        // F1 (3.23.19): validated AGAIN on read, whatever wrote the row — a bare
        // number (Entra v1 acr "1" is on every sign-in) or a password class ref
        // is never an MFA marker.
        return String(v || '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s && !isWeakAcrValue(s));
    } catch (_) {
        return [];
    }
}

/** Did the IdP perform MFA? (evidence + the operator's configured values) */
async function mfaAsserted(evidence) {
    if (!evidence) return false;
    return mfaFromEvidence(evidence, await operatorAcrValues());
}

/** OIDC / Entra claims → evidence. */
function oidcEvidence(claims) {
    const c = claims || {};
    return { amr: asList(c.amr), acr: asList(c.acr) };
}

/** passport-openidconnect's `context` ({ class: acr, methods: amr }) → evidence. */
function oidcContextEvidence(context) {
    const c = context || {};
    return { amr: asList(c.methods), acr: asList(c.class) };
}

// Every string found under a key named `name` anywhere in an xml2js tree.
function collect(node, name, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return out;
    for (const [k, v] of Object.entries(node)) {
        if (k === name) {
            for (const x of Array.isArray(v) ? v : [v]) {
                if (typeof x === 'string') out.push(x);
                else if (x && typeof x._ === 'string') out.push(x._);
            }
        } else if (v && typeof v === 'object') {
            collect(v, name, out, depth + 1);
        }
    }
    return out;
}

/**
 * SAML (node-saml profile) → evidence: the SIGNED assertion's
 * AuthnContextClassRef, and Entra's `authnmethodsreferences` attribute
 * (http://schemas.microsoft.com/claims/multipleauthn when MFA was performed).
 */
function samlEvidence(profile) {
    const pf = profile || {};
    const acr = [];
    try {
        const parsed = typeof pf.getAssertion === 'function' ? pf.getAssertion() : null;
        collect(parsed, 'AuthnContextClassRef', acr);
    } catch (_) {
        /* no parsed assertion — nothing asserted */
    }
    for (const [k, v] of Object.entries(pf)) {
        if (typeof v === 'function') continue;
        if (/(^|\/)authnmethodsreferences$/i.test(k)) acr.push(...asList(v));
    }
    return { amr: [], acr: asList(acr) };
}

// Synchronous conveniences (built-in values only) — kept for callers and tests.
function mfaFromOidcClaims(claims, extraAcr = []) {
    return mfaFromEvidence(oidcEvidence(claims), extraAcr);
}
function mfaFromOidcContext(context, extraAcr = []) {
    return mfaFromEvidence(oidcContextEvidence(context), extraAcr);
}
function mfaFromSamlProfile(profile, extraAcr = []) {
    return mfaFromEvidence(samlEvidence(profile), extraAcr);
}

// ---------------------------------------------------------------------------
// admin eligibility, re-checked at every SSO use.
// ---------------------------------------------------------------------------

async function adminRow(adminId) {
    return db.get(
        `SELECT id, username, role, is_active, locked_until, auth_policy, linked_employee_id
           FROM admins WHERE id = ?`,
        [Number(adminId)]
    );
}

/**
 * C1a (3.23.20) — the invariant « a SuperAdmin never signs in through SSO ».
 * Takes an admin id (the role is then read from the database NOW) or a row
 * just read from it. A read failure propagates: every caller fails closed.
 * @returns {Promise<{ok:boolean, reason:string|null}>}
 */
async function assertNotSuperadmin(adminOrId) {
    const a = adminOrId && typeof adminOrId === 'object' ? adminOrId : await adminRow(adminOrId);
    if (a && String(a.role) === 'superadmin')
        return { ok: false, reason: 'superadmin_sso_forbidden' };
    return { ok: true, reason: null };
}

/** True when this admin id is a SuperAdmin right now (read from the database). */
async function isSuperadmin(adminId) {
    return !(await assertNotSuperadmin(adminId)).ok;
}

/**
 * May this admin sign in through SSO right now?
 * @returns {Promise<{ok:boolean, reason:string|null, admin:object|null}>}
 *   reason ∈ superadmin_sso_forbidden | admin_sso_disabled | admin_inactive |
 *            admin_expired | admin_locked | admin_local_only
 */
async function eligibility(adminId, { skipSwitch = false } = {}) {
    const a = await adminRow(adminId);
    // C1a (3.23.20): a SuperAdmin NEVER signs in through SSO — whatever the route
    // (identity on the account, linked person, API bearer, enrolment code, test
    // sign-in). Checked FIRST, on the role read from the database now.
    const sa = await assertNotSuperadmin(a);
    if (!sa.ok) return { ok: false, reason: sa.reason, admin: a };
    if (!skipSwitch && !(await isAdminSsoEnabled()))
        return { ok: false, reason: 'admin_sso_disabled', admin: null };
    if (!a || a.isActive === false || a.is_active === false)
        return { ok: false, reason: 'admin_inactive', admin: a || null };
    const policy = String(a.authPolicy ?? a.auth_policy ?? 'any');
    // while SSO is enforced a NON-superadmin has no password door left, so
    // 'local_only' cannot be honoured (it would lock them out): treated as 'any'
    // and listed in the readiness report. (A SuperAdmin never reaches this line.)
    if (policy === 'local_only' && !isEnforced())
        return { ok: false, reason: 'admin_local_only', admin: a };
    const lockedUntil = a.lockedUntil ?? a.locked_until;
    if (lockedUntil && new Date(lockedUntil) > new Date())
        return { ok: false, reason: 'admin_locked', admin: a };
    // S2 (3.23.19): ONLY the explicit lock fields count. The password-attempt
    // counter is NOT consulted: anyone can type wrong passwords against a
    // username, and that must never lock its owner out of SSO.
    try {
        const AdminPermissionModel = require('../models/AdminPermissionModel');
        const exp = await AdminPermissionModel.getExpiryStateForAdmin(a.id);
        if (exp && exp.expired) return { ok: false, reason: 'admin_expired', admin: a };
    } catch (_) {
        /* no grant table → nothing has expired */
    }
    return { ok: true, reason: null, admin: a };
}

/**
 * D3(b) — the ACTIVE admin accounts whose linked person is this employee, each
 * passing D4. (Ineligible ones are simply not offered: the person still signs
 * in as themselves.)
 * @returns {Promise<Array<{id:number, username:string, role:string}>>}
 */
async function linkedAdminCandidates(employeeId) {
    if (!(await isAdminSsoEnabled())) return [];
    // C1a: a SuperAdmin is never offered (filtered here AND refused by eligibility).
    const rows = await db.all(
        `SELECT id FROM admins WHERE linked_employee_id = ? AND is_active = true AND role <> 'superadmin' ORDER BY id`,
        [Number(employeeId)]
    );
    const out = [];
    for (const r of rows || []) {
        // eslint-disable-next-line no-await-in-loop
        const e = await eligibility(r.id, { skipSwitch: true });
        if (e.ok)
            out.push({ id: Number(e.admin.id), username: e.admin.username, role: e.admin.role });
    }
    return out;
}

/**
 * D5 as decided by design review — how this admin's second factor
 * is satisfied on an SSO sign-in:
 * @returns {Promise<'local'|'idp'|'code'|'refuse'>}
 *   local  → run the /login/mfa challenge (the SSO proved the first factor only)
 *   idp    → the IdP asserted MFA (S6 rule): accepted
 *   code   → no second factor, but a SuperAdmin issued a live ONE-TIME enrolment
 *            code for this admin: it must be typed before TOTP setup opens
 *   refuse → none of the three.
 * (C1a, 3.23.20: a SuperAdmin never gets here — eligibility refuses it first;
 * the former 'refuse-superadmin' branch was a dead path and is gone. An enrolment
 * code is never issued to a SuperAdmin, so one would end in 'refuse' anyway.)
 */
async function secondFactor(adminId, mfaAsserted) {
    let local = false;
    try {
        local = await require('./MfaService').isActive({
            userType: 'admin',
            userId: Number(adminId),
        });
    } catch (_) {
        local = false;
    }
    if (local) return 'local';
    if (mfaAsserted === true) return 'idp';
    let exists = false;
    try {
        exists = !!(await adminRow(adminId));
    } catch (_) {
        exists = false;
    }
    if (!exists) return 'refuse';
    return (await hasLiveEnrolCode(adminId)) ? 'code' : 'refuse';
}

// ---------------------------------------------------------------------------
// ONE-TIME MFA enrolment codes (migration 152, admin_mfa_enrol_codes).
// 10 characters from an unambiguous alphabet, shown ONCE to the issuing
// SuperAdmin, stored as a SHA-256 hash, 24 h, single use, 5 wrong tries.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const ENROL_CODE_TTL_H = 24;
const ENROL_CODE_MAX_TRIES = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normCode = (s) =>
    String(s || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

async function liveEnrolCode(adminId) {
    return db.get(
        `SELECT id, code_hash, attempts FROM admin_mfa_enrol_codes
          WHERE admin_id = ? AND used_at IS NULL AND revoked_at IS NULL
            AND expires_at > now() AND attempts < ?
          ORDER BY id DESC LIMIT 1`,
        [Number(adminId), ENROL_CODE_MAX_TRIES]
    );
}

async function hasLiveEnrolCode(adminId) {
    try {
        return !!(await liveEnrolCode(adminId));
    } catch (_) {
        return false; // table absent → no code → refused (fail closed)
    }
}

/**
 * Issue a code for a NON-superadmin admin (SuperAdmin actor only — the route
 * guards it too). Any earlier live code is revoked. Returns the clear code ONCE.
 */
async function issueEnrolCode(adminId, actor) {
    if (!actor || actor.userType !== 'admin' || actor.role !== 'superadmin')
        return { ok: false, code: 'superadmin_only' };
    const a = await db.get('SELECT id, username, role, is_active FROM admins WHERE id = ?', [
        Number(adminId),
    ]);
    if (!a || (a.isActive ?? a.is_active) === false) return { ok: false, code: 'not_found' };
    if (a.role === 'superadmin') return { ok: false, code: 'superadmin_target' };
    const bytes = crypto.randomBytes(10);
    const clear = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    await db.runTransaction(async () => {
        await db.run(
            `UPDATE admin_mfa_enrol_codes SET revoked_at = now()
              WHERE admin_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
            [Number(a.id)]
        );
        await db.run(
            `INSERT INTO admin_mfa_enrol_codes (admin_id, code_hash, expires_at, created_by)
             VALUES (?, ?, now() + (? * interval '1 hour'), ?)`,
            [Number(a.id), sha256(clear), ENROL_CODE_TTL_H, Number(actor.id)]
        );
    });
    try {
        await require('./LogService').log({
            adminId: Number(actor.id),
            action: 'ADMIN_MFA_ENROL_CODE_ISSUED',
            entityType: 'admin',
            entityId: Number(a.id),
            details: `One-time MFA enrolment code issued for admin "${a.username}" (valid ${ENROL_CODE_TTL_H} h, single use)`,
        });
    } catch (_) {
        /* audit best-effort */
    }
    return { ok: true, code: clear, username: a.username, ttlHours: ENROL_CODE_TTL_H };
}

/**
 * Check (and on success CONSUME) the code an admin typed after SSO.
 * @returns {Promise<{ok:boolean, reason?:'none'|'invalid'|'locked'}>}
 */
async function consumeEnrolCode(adminId, typed) {
    const row = await liveEnrolCode(adminId);
    if (!row) return { ok: false, reason: 'none' };
    const want = Buffer.from(String(row.codeHash ?? row.code_hash));
    const got = Buffer.from(sha256(normCode(typed)));
    const match = want.length === got.length && crypto.timingSafeEqual(want, got);
    if (!match) {
        // Atomic: two concurrent wrong entries can never both read the same
        // count (attempts = attempts + 1 … RETURNING).
        const upd = await db.get(
            `UPDATE admin_mfa_enrol_codes
                SET attempts = attempts + 1,
                    revoked_at = CASE WHEN attempts + 1 >= ? THEN now() ELSE revoked_at END
              WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL
          RETURNING attempts`,
            [ENROL_CODE_MAX_TRIES, Number(row.id)]
        );
        const tries = upd ? Number(upd.attempts) : ENROL_CODE_MAX_TRIES;
        return { ok: false, reason: tries >= ENROL_CODE_MAX_TRIES ? 'locked' : 'invalid' };
    }
    const r = await db.run(
        'UPDATE admin_mfa_enrol_codes SET used_at = now() WHERE id = ? AND used_at IS NULL',
        [Number(row.id)]
    );
    if (!(r && (r.changes || r.rowCount))) return { ok: false, reason: 'none' };
    return { ok: true };
}

// ---------------------------------------------------------------------------
// only these link methods may open an ADMINISTRATOR account through SSO.
// ---------------------------------------------------------------------------
const TRUSTED_LINK_METHODS = new Set(['superadmin_link', 'onboarding_merge']);
function isTrustedLinkMethod(m) {
    return TRUSTED_LINK_METHODS.has(String(m || ''));
}

/**
 * a SuperAdmin confirms an identity for administrator access
 * (« Confirmer cette identité pour l'accès administrateur »): link_method
 * becomes 'superadmin_link'. Audited.
 */
async function confirmIdentityForAdmin(identityId, actor) {
    if (!actor || actor.userType !== 'admin' || actor.role !== 'superadmin')
        return { ok: false, code: 'superadmin_only' };
    const row = await db.get(
        'SELECT id, subject_type, subject_id, sso_provider, sso_uid, link_method FROM user_identities WHERE id = ?',
        [Number(identityId)]
    );
    if (!row) return { ok: false, code: 'not_found' };
    // never confirm an identity FOR a SuperAdmin — on the SuperAdmin account
    // itself, or on an employee whose only administrator accounts are SuperAdmins.
    const sType = row.subjectType ?? row.subject_type;
    const sId = Number(row.subjectId ?? row.subject_id);
    const targets =
        sType === 'admin'
            ? await db.all('SELECT id, role FROM admins WHERE id = ?', [sId])
            : await db.all(
                  'SELECT id, role FROM admins WHERE linked_employee_id = ? AND is_active = true',
                  [sId]
              );
    const list = targets || [];
    if (list.length && list.every((t) => t.role === 'superadmin')) {
        try {
            await require('./LogService').log({
                adminId: Number(actor.id),
                action: 'SSO_IDENTITY_CONFIRM_REFUSED',
                entityType: sType,
                entityId: sId,
                details: `superadmin_sso_forbidden: identity #${row.id} not confirmed — a SuperAdmin account never signs in through SSO`,
            });
        } catch (_) {
            /* audit best-effort */
        }
        return { ok: false, code: 'superadmin_target' };
    }
    const before = row.linkMethod ?? row.link_method ?? 'unknown';
    await db.run("UPDATE user_identities SET link_method = 'superadmin_link' WHERE id = ?", [
        Number(row.id),
    ]);
    try {
        await require('./LogService').log({
            adminId: Number(actor.id),
            action: 'SSO_IDENTITY_CONFIRMED_FOR_ADMIN',
            entityType: row.subjectType ?? row.subject_type,
            entityId: Number(row.subjectId ?? row.subject_id),
            details: `Identity ${row.ssoProvider ?? row.sso_provider}:${row.ssoUid ?? row.sso_uid} confirmed for administrator access (link method ${before} → superadmin_link)`,
        });
    } catch (_) {
        /* audit best-effort */
    }
    return { ok: true };
}

/**
 * the READINESS REPORT:
 *   adminsWithoutSso   active non-superadmin admins with NO usable SSO path: no
 *                      TRUSTED identity on the admin itself nor on its linked
 *                      employee. Pending mappings / e-mail links do not count.
 *   adminsUnconfirmed  admins whose own or linked employee's identities exist but
 *                      none was linked by a trusted method — each identity can be
 *                      confirmed by a SuperAdmin.
 *   adminsLocalOnly    'local_only' non-superadmins (A3: not honoured while enforced).
 *   adminsWithoutMfa   active admins with no confirmed local MFA: they need
 *                      IdP-asserted MFA or a one-time enrolment code.
 *   employeesWithoutSso active accounts with no identity and no pending mapping.
 */
async function readiness() {
    const trusted = "('superadmin_link', 'onboarding_merge')";
    const admins = await db.all(
        `SELECT a.id, a.username, a.role, a.linked_employee_id,
                COALESCE(a.auth_policy, 'any') AS auth_policy,
                EXISTS (SELECT 1 FROM user_identities ui
                         WHERE ((ui.subject_type = 'admin' AND ui.subject_id = a.id)
                             OR (ui.subject_type = 'employee' AND ui.subject_id = a.linked_employee_id))
                           AND ui.link_method IN ${trusted}) AS has_path,
                EXISTS (SELECT 1 FROM mfa_secrets ms
                         WHERE ms.user_type = 'admin' AND ms.user_id = a.id
                           AND ms.confirmed_at IS NOT NULL) AS has_mfa
           FROM admins a
          WHERE a.is_active = true
          ORDER BY a.username`
    );
    const idents = await db.all(
        `SELECT ui.id, ui.subject_type, ui.subject_id, ui.sso_provider, ui.sso_uid, ui.link_method, a.id AS admin_id
           FROM admins a
           JOIN user_identities ui
             ON ((ui.subject_type = 'admin' AND ui.subject_id = a.id)
              OR (ui.subject_type = 'employee' AND ui.subject_id = a.linked_employee_id))
          WHERE a.is_active = true AND a.role <> 'superadmin'
            AND ui.link_method NOT IN ${trusted}
          ORDER BY ui.id`
    );
    const byAdmin = new Map();
    for (const i of idents || []) {
        const k = Number(i.adminId ?? i.admin_id);
        if (!byAdmin.has(k)) byAdmin.set(k, []);
        byAdmin.get(k).push({
            id: Number(i.id),
            subjectType: i.subjectType ?? i.subject_type,
            provider: i.ssoProvider ?? i.sso_provider,
            uid: i.ssoUid ?? i.sso_uid,
            linkMethod: i.linkMethod ?? i.link_method,
        });
    }
    const noPath = [];
    const unconfirmed = [];
    const localOnly = [];
    const noMfa = [];
    for (const r of admins || []) {
        const row = { id: Number(r.id), username: r.username, role: r.role };
        const isSuper = r.role === 'superadmin';
        if (!(r.hasMfa === true || r.has_mfa === true)) noMfa.push(row);
        if (isSuper) continue;
        if (!(r.hasPath === true || r.has_path === true)) {
            noPath.push(row);
            if (byAdmin.has(row.id)) unconfirmed.push({ ...row, identities: byAdmin.get(row.id) });
        }
        if (String(r.authPolicy ?? r.auth_policy) === 'local_only') localOnly.push(row);
    }
    // EXC (3.23.21): an employee a SuperAdmin listed as an SSO exception keeps
    // password sign-in — not a gap; listed separately below.
    let excepted = [];
    let exceptionsReadable = true;
    try {
        excepted = (
            (await db.all(
                `SELECT e.id, e.first_name, e.last_name, e.employee_number, e.sso_exception_at,
                        e.sso_exception_reason, a.username AS set_by
                   FROM employees e LEFT JOIN admins a ON a.id = e.sso_exception_by
                  WHERE e.is_account_active = true AND e.sso_exception_at IS NOT NULL
                    AND e.sso_exception_by IS NOT NULL
                  ORDER BY e.last_name, e.first_name, e.id`
            )) || []
        ).map((r) => ({
            id: Number(r.id),
            name: `${r.firstName ?? r.first_name ?? ''} ${r.lastName ?? r.last_name ?? ''}`.trim(),
            employeeNumber: r.employeeNumber ?? r.employee_number ?? null,
            at: r.ssoExceptionAt ?? r.sso_exception_at ?? null,
            reason: r.ssoExceptionReason ?? r.sso_exception_reason ?? null,
            setBy: r.setBy ?? r.set_by ?? null,
        }));
    } catch (_) {
        excepted = []; // columns absent before migration 156
        exceptionsReadable = false;
    }
    const e = await db.get(
        `SELECT COUNT(*)::int AS n FROM employees e
          WHERE e.is_account_active = true
            AND NOT EXISTS (SELECT 1 FROM user_identities ui WHERE ui.subject_type = 'employee' AND ui.subject_id = e.id)
            AND e.external_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM sso_pending_links pl WHERE pl.employee_id = e.id AND pl.status = 'pending')
            ${exceptionsReadable ? 'AND NOT (e.sso_exception_at IS NOT NULL AND e.sso_exception_by IS NOT NULL)' : ''}`
    );
    const nEmp = Number((e && e.n) || 0);
    // B1/B2 (3.23.20): SuperAdmins sign in with the break-glass password + TOTP
    // only. One without confirmed MFA is a RED item; any SSO identity still
    // recorded on a SuperAdmin account is IGNORED at sign-in (never deleted) and
    // listed so a SuperAdmin can unlink it.
    const superNoMfa = noMfa.filter((r) => r.role === 'superadmin');
    // C2e: fewer than TWO active SuperAdmins with MFA is a red item (not
    // blocking): with one, a lost authenticator has no peer to reset it.
    const superWithMfa = (admins || []).filter(
        (r) => r.role === 'superadmin' && (r.hasMfa === true || r.has_mfa === true)
    ).length;
    // C1e: an admin demoted FROM SuperAdmin that has an SSO path again.
    let demotedWithSso = [];
    try {
        demotedWithSso = (
            (await db.all(
                `SELECT a.id, a.username, a.role FROM admins a
                  WHERE a.is_active = true AND a.role <> 'superadmin'
                    AND a.demoted_from_superadmin_at IS NOT NULL
                    AND EXISTS (SELECT 1 FROM user_identities ui
                                 WHERE ((ui.subject_type = 'admin' AND ui.subject_id = a.id)
                                     OR (ui.subject_type = 'employee' AND ui.subject_id = a.linked_employee_id))
                                   AND ui.link_method IN ${trusted})
                  ORDER BY a.username`
            )) || []
        ).map((r) => ({ id: Number(r.id), username: r.username, role: r.role }));
    } catch (_) {
        demotedWithSso = []; // column absent before migration 153
    }
    const superIdents = await db.all(
        `SELECT ui.id, ui.sso_provider AS provider, ui.sso_uid AS uid, ui.link_method, a.id AS admin_id, a.username
           FROM admins a
           JOIN user_identities ui ON ui.subject_type = 'admin' AND ui.subject_id = a.id
          WHERE a.role = 'superadmin'
         UNION ALL
         SELECT NULL, a.auth_provider, a.external_id, 'legacy', a.id, a.username
           FROM admins a
          WHERE a.role = 'superadmin' AND a.external_id IS NOT NULL
          ORDER BY 5, 1`
    );
    const superadminIdentities = (superIdents || []).map((i) => ({
        id: i.id == null ? null : Number(i.id),
        adminId: Number(i.adminId ?? i.admin_id),
        username: i.username,
        provider: i.provider,
        uid: i.uid,
        linkMethod: i.linkMethod ?? i.link_method,
    }));
    return {
        enforced: isEnforced(),
        adminsWithoutSso: noPath,
        adminsUnconfirmed: unconfirmed,
        adminsLocalOnly: localOnly,
        adminsWithoutMfa: noMfa,
        superadminsWithoutMfa: superNoMfa,
        superadminsWithMfa: superWithMfa,
        superadminMfaShortfall: superWithMfa < 2,
        superadminIdentities,
        demotedWithSso,
        employeesWithoutSso: nEmp,
        // EXC: listed, never counted as a gap.
        employeesExcepted: excepted,
        // UX-1: « {{n}} compte(s) n'ont aucun accès SSO » — the activation
        // confirmation. Admins with no SSO path + employees with neither an
        // identity nor a mapping; SSO exceptions excluded.
        noSsoAccessCount: noPath.length + nEmp,
        hasGaps:
            noPath.length > 0 ||
            localOnly.length > 0 ||
            noMfa.length > 0 ||
            superWithMfa < 2 ||
            superadminIdentities.length > 0 ||
            demotedWithSso.length > 0 ||
            nEmp > 0,
    };
}

module.exports = {
    isEnforced,
    isAdminSsoEnabled,
    isActiveSuperadmin,
    isSsoExcepted,
    passwordAllowedWhileEnforced,
    hasSsoException,
    setSsoException,
    countSsoExceptions,
    assertNotSuperadmin,
    isSuperadmin,
    readiness,
    eligibility,
    linkedAdminCandidates,
    secondFactor,
    issueEnrolCode,
    consumeEnrolCode,
    hasLiveEnrolCode,
    confirmIdentityForAdmin,
    isTrustedLinkMethod,
    TRUSTED_LINK_METHODS,
    mfaFromEvidence,
    mfaAsserted,
    oidcEvidence,
    oidcContextEvidence,
    samlEvidence,
    mfaFromOidcClaims,
    mfaFromOidcContext,
    mfaFromSamlProfile,
    AMR_CLASS,
    isWeakAcrValue,
    operatorAcrValues,
    ENROL_CODE_MAX_TRIES,
};
