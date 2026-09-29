'use strict';
/**
 * SSO identity resolution (IDevelop — Wave 2).
 *
 * Maps an external IdP profile (OIDC `sub` / SAML nameID + email) to an
 * existing local account. Security posture: **no JIT auto-provisioning** — only
 * a pre-linked identity (external_id), or an EMPLOYEE whose VERIFIED email matches
 * an existing active account, may sign in; everything else is denied. Admins are
 * NEVER auto-linked/elevated by email (anti-takeover); they must be pre-linked by
 * external_id (whether an admin may then actually sign in by SSO is decided by
 * AdminSsoService + SsoController, 3.23.19). On a verified first-time email match the external id is linked so
 * subsequent logins are id-based. The OIDC/SAML transport (redirect,
 * token validation) is wired separately and gated by SSO_ENABLED.
 *
 * @module services/SsoService
 */
const db = require('../config/database');

/** Whether SSO is switched on (transport wiring checks this before mounting). */
function isEnabled() {
    const v = String(process.env.SSO_ENABLED || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

const lc = (v) => (v == null ? '' : String(v).trim().toLowerCase());

/**
 * One linked-identity lookup: user_identities first, then the inline columns.
 * `meta.linkMethod` (3.23.19, S4) receives HOW the identity was linked
 * (user_identities.link_method; 'legacy' for the inline columns).
 */
async function _resolveLinked(provider, ext, meta = {}) {
    const m = await db.get(
        'SELECT subject_type, subject_id, link_method FROM user_identities WHERE sso_provider = ? AND sso_uid = ?',
        [provider, ext]
    );
    if (m) {
        meta.linkMethod = String(m.linkMethod ?? m.link_method ?? 'unknown');
        if (m.subjectType === 'admin' || m.subject_type === 'admin') {
            const a = await db.get(
                'SELECT id, username, role FROM admins WHERE id = ? AND is_active = true',
                [Number(m.subjectId ?? m.subject_id)]
            );
            if (a) return { kind: 'admin', id: Number(a.id), username: a.username, role: a.role };
        } else {
            const e = await db.get(
                'SELECT id, username FROM employees WHERE id = ? AND is_account_active = true',
                [Number(m.subjectId ?? m.subject_id)]
            );
            if (e) return { kind: 'employee', id: Number(e.id), username: e.username };
        }
    }
    // Legacy inline fallback (admins, then employees).
    meta.linkMethod = 'legacy';
    const a = await db.get(
        'SELECT id, username, role FROM admins WHERE auth_provider = ? AND external_id = ? AND is_active = true',
        [provider, ext]
    );
    if (a) return { kind: 'admin', id: Number(a.id), username: a.username, role: a.role };
    const e = await db.get(
        'SELECT id, username FROM employees WHERE auth_provider = ? AND external_id = ? AND is_account_active = true',
        [provider, ext]
    );
    if (e) return { kind: 'employee', id: Number(e.id), username: e.username };
    return null;
}

/**
 * The identifiers a sign-in may be recorded under, most stable first.
 *
 * Entra's `oid` (objectId) is immutable, never reused, and is what an admin can
 * export in advance. The OIDC `sub` is PAIRWISE per application (unknowable in
 * advance), and a SAML NameID defaults to the UPN, which changes on a rename. So
 * `oid` — lower-cased, being a GUID — is the key new links are written under,
 * and the older `sub` is still looked up so identities linked before this
 * change keep resolving.
 * @returns {string[]}
 */
function stableUids(profile) {
    const p = profile || {};
    const out = [];
    const push = (v) => {
        const s = v == null ? '' : String(v).trim();
        if (s && !out.includes(s)) out.push(s);
    };
    if (p.oid) push(lc(p.oid));
    push(p.sub);
    push(p.id);
    return out;
}

/** The identifier a NEW link is recorded under (see stableUids). */
function primaryUid(profile) {
    return stableUids(profile)[0] || null;
}

/** A guest (B2B) account: never matched onto an employee by a mapping. */
function isGuest(profile) {
    const upn = lc(profile && profile.upn);
    return upn.includes('#ext#') || lc(profile && profile.userType) === 'guest';
}

/**
 * The tenant a mapping may be claimed from. A claim carrying a DIFFERENT
 * tenant id is refused — the UPN and employee id are only meaningful inside
 * the organisation's own directory.
 */
function expectedTenant() {
    return lc(process.env.SSO_EXPECTED_TENANT_ID || process.env.AZURE_TENANT_ID || '');
}

/**
 * Claim a pending SSO-migration mapping (migration 144) for this sign-in.
 *
 * An admin pre-registered "employee X signs in as objectId / UPN / employeeId
 * Y" from the SSO-migration console. The first SIGNED assertion from the
 * configured tenant presenting a matching claim binds the real identity, once.
 * Refused (null) when: guest; wrong tenant; the matches point at more than one
 * employee; a mapping keyed on an objectId meets a DIFFERENT objectId (a UPN
 * that was reassigned to someone else); the identity is already held by
 * another account; the employee cannot sign in. Email is never a key here:
 * `mail` is editable in the directory and proves nothing.
 * @returns {Promise<{kind:'employee', id:number, username:string}|null>}
 */
async function claimPendingMapping(provider, profile, { dryRun = false } = {}) {
    const oid = lc(profile.oid);
    const upn = lc(profile.upn);
    const empId = lc(profile.employeeId);
    if (!oid && !upn && !empId) return null;
    if (isGuest(profile)) return null;
    const tenant = expectedTenant();
    if (tenant && profile.tid && lc(profile.tid) !== tenant) {
        console.warn(
            `[sso] ${provider}: sign-in from tenant ${profile.tid} ignored for SSO-migration mappings (expected ${tenant})`
        );
        return null;
    }

    const rows = await db
        .all(
            `SELECT id, employee_id, match_object_id, match_upn, match_employee_id, created_by
           FROM sso_pending_links
          WHERE provider = ? AND status = 'pending'
            AND ((match_object_id IS NOT NULL AND match_object_id = ?)
              OR (match_upn IS NOT NULL AND match_upn = ?)
              OR (match_employee_id IS NOT NULL AND match_employee_id = ?))`,
            [provider, oid || null, upn || null, empId || null]
        )
        .catch(() => []);
    // One matching key is not enough: EVERY key present on both sides must
    // agree. A mapping pinned to an objectId only ever matches THAT object (a
    // sign-in with no objectId cannot claim it either); a UPN or employee id that
    // disagrees means another person (a reused staff number, a reassigned UPN).
    const usable = (rows || []).filter((r) => {
        const mo = r.matchObjectId ?? r.match_object_id;
        const mu = r.matchUpn ?? r.match_upn;
        const me = r.matchEmployeeId ?? r.match_employee_id;
        if (mo && mo !== oid) return false;
        if (mu && upn && mu !== upn) return false;
        if (me && empId && me !== empId) return false;
        return true;
    });
    if (!usable.length) return null;
    const subjects = [...new Set(usable.map((r) => Number(r.employeeId ?? r.employee_id)))];
    if (subjects.length !== 1) {
        console.warn(
            `[sso] ${provider}: sign-in matches SSO-migration mappings of ${subjects.length} employees - refused, resolve in the console`
        );
        return null;
    }
    const pending = usable[0];
    const employeeId = subjects[0];
    const uid = primaryUid(profile);
    if (!uid) return null;

    // Same gate as SsoController: an account restricted to password sign-in is
    // refused SSO, so its mapping must not bind either.
    const e = await db.get(
        `SELECT id, username, email FROM employees
          WHERE id = ? AND is_account_active = true AND COALESCE(auth_policy, 'any') <> 'local_only'`,
        [employeeId]
    );
    if (!e) return null;
    const holder = await db.get(
        'SELECT subject_type, subject_id FROM user_identities WHERE sso_provider = ? AND sso_uid = ?',
        [provider, uid]
    );
    if (
        holder &&
        !(
            (holder.subjectType ?? holder.subject_type) === 'employee' &&
            Number(holder.subjectId ?? holder.subject_id) === employeeId
        )
    ) {
        console.warn(
            `[sso] ${provider}: SSO-migration mapping for employee #${employeeId} not claimed - identity already linked to another account`
        );
        return null;
    }

    // Test sign-in: report the match, write nothing.
    if (dryRun)
        return {
            kind: 'employee',
            id: employeeId,
            username: e.username,
            mappingId: Number(pending.id),
        };

    let bound = false;
    await db.runTransaction(async () => {
        // Consume the mapping first: `status = 'pending'` makes the claim one-time
        // even under two simultaneous first sign-ins.
        const r = await db.run(
            `UPDATE sso_pending_links SET status = 'bound', bound_uid = ?, bound_at = now()
              WHERE id = ? AND status = 'pending'`,
            [uid, Number(pending.id)]
        );
        if (!(r && (r.changes || r.rowCount))) return;
        await db.run(
            `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid, email, is_primary, linked_by, link_method)
             VALUES ('employee', ?, ?, ?, ?, true, ?, 'migration_mapping') ON CONFLICT (sso_provider, sso_uid) DO NOTHING`,
            [
                employeeId,
                provider,
                uid,
                lc(profile.email) || lc(e.email) || null,
                Number(pending.createdBy ?? pending.created_by) || null,
            ]
        );
        await db.run(
            `UPDATE employees SET auth_provider = ?, external_id = ?, updated_at = now()
              WHERE id = ? AND external_id IS NULL`,
            [provider, uid, employeeId]
        );
        // Anyone who tried SSO before being mapped is parked in onboarding: that
        // request is now answered by the existing account, never a new one.
        await db.run(
            `UPDATE onboarding_requests SET status = 'rejected', decided_at = now(),
                    decision_note = ?
              WHERE status = 'pending' AND source = 'sso'
                AND (external_id = ? OR (? <> '' AND lower(email) = ?))`,
            [
                `Resolved by the SSO migration: signed in as existing employee #${employeeId}.`,
                uid,
                lc(profile.email),
                lc(profile.email),
            ]
        );
        bound = true;
    });
    if (!bound) return null;
    try {
        await require('./LogService').log({
            action: 'SSO_REMAP_CLAIMED',
            entityType: 'employee',
            entityId: employeeId,
            details: `SSO-migration mapping #${pending.id} claimed at first sign-in: employee #${employeeId} (${e.username || ''}) is now linked to ${provider}:${uid}.`,
        });
    } catch (_) {
        /* audit best-effort */
    }
    return { kind: 'employee', id: employeeId, username: e.username };
}

/**
 * Resolve an external profile to a local principal, or null to deny.
 * @param {string} provider e.g. 'entra', 'okta'
 * @param {{sub?:string,oid?:string,id?:string,email?:string,upn?:string,employeeId?:string,tid?:string}} profile
 */
async function resolveIdentity(provider, profile, { allowClaim = true, trace = null } = {}) {
    if (!provider || !profile) return null;
    // `trace.via` tells the caller HOW the account was found: 'linked' (an identity
    // recorded before this sign-in), 'mapping' (an SSO-migration mapping claimed
    // now) or 'email' (a first-time verified e-mail match). Admin access through
    // the linked person (3.23.19, D3b) is offered for 'linked' only.
    const note = (via, principal) => {
        if (trace && principal) trace.via = via;
        return principal;
    };
    const uids = stableUids(profile);
    const email = String(profile.email || '')
        .toLowerCase()
        .trim();

    // 1) Already-linked external identity. A person may hold SEVERAL identities
    //    (e.g. O365 today, Okta later): the normalized user_identities table is
    //    the source of truth (migration 49). We consult it first, then fall back
    //    to the legacy inline auth_provider/external_id columns for any identity
    //    not yet represented there. Every stable id is tried, objectId first.
    for (const ext of uids) {
        const meta = {};
        const hit = await _resolveLinked(provider, ext, meta);
        if (hit) {
            // Linked under an older id (the pairwise OIDC `sub`): record the
            // objectId too, so a later change of `sub` cannot orphan it. NEVER when
            // the old id is a UPN/e-mail-like NameID: a UPN is reassigned when
            // someone leaves, and aliasing would bind the NEWCOMER's immutable
            // objectId to the leaver's account for good. Employees only. The new
            // row inherits the trust (link_method) of the row it aliases.
            if (ext !== uids[0] && hit.kind === 'employee' && !ext.includes('@')) {
                db.run(
                    `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid, email, link_method)
                        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sso_provider, sso_uid) DO NOTHING`,
                    [
                        hit.kind,
                        hit.id,
                        provider,
                        uids[0],
                        email || null,
                        meta.linkMethod || 'unknown',
                    ]
                ).catch(() => {});
            }
            if (trace) {
                trace.linkMethod = meta.linkMethod || 'unknown';
                // S5 (3.23.19): matched on an e-mail-like uid (a UPN / e-mail NameID,
                // reassignable) while the assertion carries a DIFFERENT stable id →
                // never good enough to open an administrator account.
                const oid = lc(profile.oid);
                const sub = profile.sub == null ? '' : String(profile.sub).trim();
                trace.aliasMatch =
                    ext.includes('@') && ((!!oid && oid !== lc(ext)) || (!!sub && sub !== ext));
                // S5 residual: a SAML match on an e-mail-format NameID with NO
                // immutable id in the assertion (no objectId, NameID not
                // persistent) — reassignable, so never enough for an admin.
                trace.unstableUid =
                    provider === 'saml' &&
                    ext.includes('@') &&
                    !oid &&
                    profile.nameIdPersistent !== true;
            }
            return note('linked', hit);
        }
    }

    // 1b) A mapping pre-registered from the SSO-migration console (migration 144).
    //     Interactive sign-ins only: a non-interactive API token never consumes one.
    const claimed = !allowClaim
        ? null
        : await claimPendingMapping(provider, profile).catch((e) => {
              console.warn(`[sso] ${provider}: SSO-migration mapping claim failed: ${e.message}`);
              return null;
          });
    if (claimed) return note('mapping', claimed);
    const ext = uids[0] || null;

    // 2) First-time email match → link the external id. HARDENED against
    //    account-takeover:
    //      - only when the IdP asserts a VERIFIED email (profile.emailVerified),
    //        so a permissive/misconfigured IdP can't impersonate by claiming an
    //        arbitrary address;
    //      - EMPLOYEES ONLY — an admin/SuperAdmin is NEVER auto-linked or elevated
    //        by email; privileged accounts must be pre-linked by external_id
    //        (step 1) out-of-band.
    if (email && profile.emailVerified === true) {
        // One address may belong to several accounts (migration 107). An
        // auto-link must never GUESS which one the IdP means: exactly one
        // active employee, or no link at all (pre-link by external_id instead).
        const { row: e, ambiguous } = await require('./EmailAccountsService').uniqueEmployeeByEmail(
            email,
            { activeLoginOnly: true }
        );
        if (ambiguous) {
            console.warn(
                `[sso] ${provider}: the verified e-mail belongs to several employee accounts - no auto-link; pre-link the intended account by external_id`
            );
            return null;
        }
        if (e) {
            if (ext) {
                // Record the identity in both the normalized table (source of truth)
                // and the inline columns (legacy back-compat). Best-effort.
                db.run(
                    `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid, email, link_method)
                        VALUES ('employee', ?, ?, ?, ?, 'sso_email') ON CONFLICT (sso_provider, sso_uid) DO NOTHING`,
                    [e.id, provider, ext, email]
                ).catch(() => {});
                db.run('UPDATE employees SET auth_provider = ?, external_id = ? WHERE id = ?', [
                    provider,
                    ext,
                    e.id,
                ]).catch(() => {});
            }
            return note('email', { kind: 'employee', id: Number(e.id), username: e.username });
        }
    }

    return null; // unknown / unverified / admin-by-email → deny (no silent link)
}

/**
 * SSO-only enforcement. When the org enables `ssoDisablesLocalPassword`, an account
 * that has just proven it can sign in via the corporate IdP has its LOCAL password
 * turned off (password_disabled = true) — so "where SSO is activated, local
 * credentials stop working". Called ONLY after a SUCCESSFUL SSO login (never on a
 * mere manual link), so a half-configured IdP can't strand anyone.
 *
 * SAFETY — ADMINISTRATORS ARE NEVER TOUCHED. Even since admins may use SSO
 * (3.23.19, opt-in `sso.adminSsoEnabled`), the admin password + MFA stays the
 * break-glass door: an IdP outage or a refused SSO check must never leave an
 * administrator with no way in. This also runs BEFORE SsoController's checks,
 * so disabling a password here would act on a sign-in that may yet be refused.
 * The same holds for an
 * employee restricted to password sign-in (auth policy 'local_only'), whom the
 * controller also refuses. (SuperAdmin break-glass is a special case of this.)
 * Best-effort: any failure here must not fail the successful login.
 */
async function enforceSsoOnly(principal) {
    try {
        if (!principal || principal.id == null) return;
        if (principal.kind !== 'employee') return;
        if (await _isLocalOnly(principal.id)) return;
        // EXC (3.23.21): a SuperAdmin-listed SSO exception keeps its password.
        if (await require('./AdminSsoService').hasSsoException(principal.id)) return;

        const AppSettingsModel = require('../models/AppSettingsModel');
        const on = await AppSettingsModel.getValue('ssoDisablesLocalPassword', false);
        if (!(on === true || on === 'true' || on === 1 || on === '1')) return;

        const table = 'employees';
        const r = await db.run(
            `UPDATE ${table} SET password_disabled = true WHERE id = ? AND COALESCE(password_disabled, false) = false`,
            [Number(principal.id)]
        );
        if (r && (r.changes || r.rowCount)) {
            try {
                await require('./LogService').log({
                    action: 'SSO_LOCAL_PASSWORD_DISABLED',
                    entityType: principal.kind,
                    entityId: Number(principal.id),
                    details: `Local password disabled — account is now SSO-only (${principal.username || principal.id}).`,
                });
            } catch (_) {
                /* audit best-effort */
            }
        }
    } catch (_) {
        /* never break a successful SSO login */
    }
}

/**
 * Stamp last_login_at after a SUCCESSFUL SSO sign-in. Only the
 * password path wrote it, so an SSO-only employee read as "never signed in"
 * on every account surface and was offered for (password) invitation. Called
 * from config/sso.js resolveAndFinish, next to enforceSsoOnly; best-effort —
 * a failed stamp must never fail the login. Admins keep their own trail.
 */
async function stampLastLogin(principal) {
    try {
        if (!principal || principal.id == null || principal.kind !== 'employee') return false;
        // A 'local_only' employee is refused by SsoController: not a sign-in.
        if (await _isLocalOnly(principal.id)) return false;
        await db.run('UPDATE employees SET last_login_at = now() WHERE id = ?', [
            Number(principal.id),
        ]);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Record that this identity was just USED to sign in (migration 144,
 * user_identities.last_used_at). The SSO-migration readiness view counts "signed
 * in via SSO" from this — a link that exists is not a sign-in that happened.
 * Same exclusions as stampLastLogin; best-effort.
 */
async function stampIdentityUse(provider, profile, principal) {
    try {
        if (!principal || principal.id == null || principal.kind !== 'employee') return false;
        if (await _isLocalOnly(principal.id)) return false;
        const uids = stableUids(profile);
        if (!uids.length) return false;
        const r = await db.run(
            `UPDATE user_identities SET last_used_at = now()
              WHERE sso_provider = ? AND subject_type = 'employee' AND subject_id = ?
                AND sso_uid IN (${uids.map(() => '?').join(', ')})`,
            [provider, Number(principal.id), ...uids]
        );
        return !!(r && r.changes);
    } catch (_) {
        return false;
    }
}

/**
 * The admin twin of stampIdentityUse (3.23.19, D9): called by SsoController only
 * AFTER an admin SSO sign-in passed every check — resolveAndFinish
 * cannot do it, because it runs before those checks. Only an identity linked
 * DIRECTLY to the admin is stamped; the linked-person route (D3b) stamps the
 * employee's own identity, which resolveAndFinish already did. Best-effort.
 */
async function stampAdminIdentityUse(provider, profile, adminId) {
    try {
        const uids = stableUids(profile);
        if (!uids.length || adminId == null) return false;
        const r = await db.run(
            `UPDATE user_identities SET last_used_at = now()
              WHERE sso_provider = ? AND subject_type = 'admin' AND subject_id = ?
                AND sso_uid IN (${uids.map(() => '?').join(', ')})`,
            [provider, Number(adminId), ...uids]
        );
        return !!(r && r.changes);
    } catch (_) {
        return false;
    }
}

async function _isLocalOnly(employeeId) {
    const row = await db.get('SELECT auth_policy FROM employees WHERE id = ?', [
        Number(employeeId),
    ]);
    return !!row && String(row.authPolicy ?? row.auth_policy ?? 'any') === 'local_only';
}

/**
 * READ-ONLY twin of resolveIdentity for the SSO "test sign-in": which account
 * this assertion WOULD open, and why — or why not. Writes nothing (no link, no
 * alias, no claimed mapping, no onboarding request).
 * @returns {Promise<{matchedBy:string|null, principal:object|null, refusal:string|null, guest:boolean, tenant:{expected:string, received:string|null, ok:boolean}}>}
 */
async function diagnose(provider, profile) {
    const out = { matchedBy: null, principal: null, refusal: null, guest: isGuest(profile) };
    const tenant = expectedTenant();
    out.tenant = {
        expected: tenant,
        received: profile.tid || null,
        ok: !tenant || !profile.tid || lc(profile.tid) === tenant,
    };
    for (const ext of stableUids(profile)) {
        const hit = await _resolveLinked(provider, ext);
        if (hit) {
            out.matchedBy = 'linked';
            out.principal = hit;
            break;
        }
    }
    if (!out.principal) {
        const m = await claimPendingMapping(provider, profile, { dryRun: true }).catch(() => null);
        if (m) {
            out.matchedBy = 'mapping';
            out.principal = m;
        }
    }
    const email = lc(profile.email);
    if (!out.principal && email && profile.emailVerified === true) {
        const { row, ambiguous } = await require('./EmailAccountsService').uniqueEmployeeByEmail(
            email,
            { activeLoginOnly: true }
        );
        if (ambiguous) out.refusal = 'email_ambiguous';
        else if (row) {
            out.matchedBy = 'email';
            out.principal = { kind: 'employee', id: Number(row.id), username: row.username };
        }
    }
    if (out.principal && out.principal.kind === 'admin') {
        // 3.23.19: refused unless the SuperAdmin switched admin SSO on AND
        // this admin passes the same checks as a real sign-in.
        const AdminSso = require('./AdminSsoService');
        // C1 (3.23.20): a SuperAdmin is refused FIRST, whatever the switch says.
        if (await AdminSso.isSuperadmin(out.principal.id)) out.refusal = 'superadmin_sso_forbidden';
        else if (!(await AdminSso.isAdminSsoEnabled())) out.refusal = 'admin_password_only';
        else if (!(await AdminSso.eligibility(out.principal.id)).ok)
            out.refusal = 'admin_ineligible';
    } else if (
        out.principal &&
        out.principal.kind === 'employee' &&
        (await _isLocalOnly(out.principal.id))
    )
        out.refusal = 'local_only';
    else if (!out.principal && !out.refusal) out.refusal = 'not_provisioned';
    return out;
}

module.exports = {
    diagnose,
    isEnabled,
    resolveIdentity,
    enforceSsoOnly,
    stampLastLogin,
    stampIdentityUse,
    stampAdminIdentityUse,
    stableUids,
    primaryUid,
    claimPendingMapping,
    isGuest,
};
