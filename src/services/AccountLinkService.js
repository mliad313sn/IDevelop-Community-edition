'use strict';
/**
 * Account identity linking & privilege promotion (IDevelop).
 *
 * Two operator scenarios this service makes safe, audited and reversible:
 *
 *  1. MERGE a pre-existing LOCAL account with an incoming SSO/Entra identity.
 *     A person who signed up with a password (or was created by an admin) and now
 *     signs in with their AD / O365 account ends up with ONE account: the SSO
 *     identity (auth_provider + external_id) is attached to their existing local
 *     account, so future SSO logins resolve to it — no duplicate. See
 *     `linkSsoIdentity` and `mergeOnboardingRequest`.
 *
 *  2. PROMOTE an employee to an admin ("grant admin access") — and revoke it.
 *     A linked admin account is created for the person. It carries NO SSO identity
 *     (UNIQUE(sso_provider, sso_uid): the identity stays on the employee record);
 *     it is tracked by admins.linked_employee_id, which is also how an SSO sign-in
 *     reaches it (3.23.19: the account chooser « Continuer en tant que … », while
 *     SSO is enforced — see AdminSsoService). See `grantAdminAccess` /
 *     `revokeAdminAccess`.
 *
 * SECURITY: linking/merging an ADMIN account, and any privilege promotion, require
 * a SuperAdmin actor (mirrors the anti-takeover posture in SsoService — admins are
 * never linked/elevated by an unauthenticated email match). Linking an EMPLOYEE
 * identity requires the account-provisioning permission. Every mutation is audited.
 *
 * @module services/AccountLinkService
 */
const db = require('../config/database');
const AdminModel = require('../models/AdminModel');
const EmployeeModel = require('../models/EmployeeModel');
const OnboardingRequestModel = require('../models/OnboardingRequestModel');
const AdminPermissionModel = require('../models/AdminPermissionModel');
const AdminScopeModel = require('../models/AdminScopeModel');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');
const { isValidSlug, isWrite } = require('../config/permissions');

function _isSuper(actor) {
    return RBACService.isSuperAdmin(actor);
}
function _hasPerm(actor, slug) {
    if (_isSuper(actor)) return true;
    return Array.isArray(actor && actor.permissions) && actor.permissions.includes(slug);
}
function _norm(s) {
    return String(s == null ? '' : s).trim();
}
function _lower(s) {
    return _norm(s).toLowerCase();
}

/** The single account (admin or employee) currently holding a given SSO identity, or null. */
async function accountHoldingIdentity(provider, externalId) {
    const p = _norm(provider),
        x = _norm(externalId);
    if (!p || !x) return null;
    // Normalized table is the source of truth (a person may hold many identities).
    const m = await db.get(
        'SELECT subject_type, subject_id FROM user_identities WHERE sso_provider = ? AND sso_uid = ?',
        [p, x]
    );
    if (m) {
        const type = m.subjectType || m.subject_type;
        const id = Number(m.subjectId ?? m.subject_id);
        const tbl = type === 'admin' ? 'admins' : 'employees';
        const row = await db.get(`SELECT id, username FROM ${tbl} WHERE id = ?`, [id]);
        if (row) return { type, id: Number(row.id), username: row.username };
    }
    // Legacy inline fallback.
    const a = await db.get(
        'SELECT id, username FROM admins WHERE auth_provider = ? AND external_id = ?',
        [p, x]
    );
    if (a) return { type: 'admin', id: Number(a.id), username: a.username };
    const e = await db.get(
        'SELECT id, username FROM employees WHERE auth_provider = ? AND external_id = ?',
        [p, x]
    );
    if (e) return { type: 'employee', id: Number(e.id), username: e.username };
    return null;
}

/** All authentication identities linked to an account (newest first). */
async function listIdentities(subjectType, subjectId) {
    const rows = await db.all(
        `SELECT id, sso_provider, sso_uid, email, is_primary, linked_by, linked_at
         FROM user_identities WHERE subject_type = ? AND subject_id = ? ORDER BY linked_at DESC`,
        [subjectType, parseInt(subjectId, 10)]
    );
    return rows.map((r) => ({
        id: Number(r.id),
        provider: r.ssoProvider ?? r.sso_provider,
        uid: r.ssoUid ?? r.sso_uid,
        email: r.email,
        isPrimary: r.isPrimary ?? r.is_primary,
        linkedAt: r.linkedAt ?? r.linked_at,
    }));
}

/** Remove one linked identity by its row id (RBAC enforced by the caller/route). */
async function removeIdentity(identityId, actor) {
    const row = await db.get('SELECT * FROM user_identities WHERE id = ?', [
        parseInt(identityId, 10),
    ]);
    if (!row) return { ok: false, code: 'alk_identity_not_found', message: 'Identity not found.' };
    const subjectType = row.subjectType || row.subject_type;
    if (subjectType === 'admin' && !_isSuper(actor))
        return {
            ok: false,
            code: 'alk_super_only_remove_identity',
            message: 'Only a SuperAdmin can remove an admin identity.',
        };
    const provider = row.ssoProvider || row.sso_provider;
    const uid = row.ssoUid || row.sso_uid;
    const subjectId = Number(row.subjectId ?? row.subject_id);
    if (subjectType === 'employee' && !_isSuper(actor)) {
        const RBACService = require('./RBACService');
        if (!(await RBACService.canAccessEmployee(actor, subjectId))) {
            return {
                ok: false,
                code: 'alk_account_out_of_scope',
                message: 'That account is outside your administrative scope.',
            };
        }
    }
    await db.runTransaction(async () => {
        await db.run('DELETE FROM user_identities WHERE id = ?', [Number(row.id)]);
        // If the inline columns still mirror this identity, clear them too.
        const tbl = subjectType === 'admin' ? 'admins' : 'employees';
        await db.run(
            `UPDATE ${tbl} SET auth_provider = NULL, external_id = NULL WHERE id = ? AND auth_provider = ? AND external_id = ?`,
            [subjectId, provider, uid]
        );
    });
    await LogService.log({
        adminId: actor && actor.id,
        action: 'ACCOUNT_SSO_UNLINKED',
        entityType: subjectType,
        entityId: subjectId,
        details: `Removed ${provider} identity ${uid} from ${subjectType} #${subjectId}`,
    });
    return { ok: true, code: 'alk_identity_removed', message: 'Authentication method removed.' };
}

/**
 * Find existing local accounts that a pending SSO/onboarding identity could merge
 * into — matched by the (provider, external_id) OR by a shared email. Used to
 * surface "Merge into <account>" choices in the onboarding queue.
 * @returns {Promise<{admins:Array, employees:Array}>}
 */
async function findLinkCandidates({ email, externalId, provider } = {}) {
    const out = { admins: [], employees: [] };
    const em = _lower(email);
    const p = _norm(provider),
        x = _norm(externalId);
    const seen = { admin: new Set(), employee: new Set() };
    // NB: db.get/all return camelCase result keys (the layer translates snake→camel),
    // so read externalId / employeeNumber, not external_id / employee_number.
    const pushAdmin = (r) => {
        if (r && !seen.admin.has(Number(r.id))) {
            seen.admin.add(Number(r.id));
            out.admins.push({
                id: Number(r.id),
                username: r.username,
                email: r.email,
                role: r.role,
                hasIdentity: !!(r.externalId ?? r.external_id),
            });
        }
    };
    const pushEmp = (r) => {
        if (r && !seen.employee.has(Number(r.id))) {
            seen.employee.add(Number(r.id));
            out.employees.push({
                id: Number(r.id),
                username: r.username,
                email: r.email,
                employeeNumber: r.employeeNumber ?? r.employee_number,
                hasIdentity: !!(r.externalId ?? r.external_id),
            });
        }
    };

    if (p && x) {
        (
            await db.all(
                'SELECT id, username, email, role, external_id FROM admins WHERE auth_provider = ? AND external_id = ?',
                [p, x]
            )
        ).forEach(pushAdmin);
        (
            await db.all(
                'SELECT id, username, email, employee_number, external_id FROM employees WHERE auth_provider = ? AND external_id = ?',
                [p, x]
            )
        ).forEach(pushEmp);
    }
    if (em) {
        (
            await db.all(
                'SELECT id, username, email, role, external_id FROM admins WHERE lower(email) = ?',
                [em]
            )
        ).forEach(pushAdmin);
        (
            await db.all(
                'SELECT id, username, email, employee_number, external_id FROM employees WHERE lower(email) = ?',
                [em]
            )
        ).forEach(pushEmp);
    }
    return out;
}

/** Load + shallow-validate a link target. Returns { row } or throws a friendly error. */
async function _loadTarget(targetType, targetId) {
    const id = parseInt(targetId, 10);
    if (targetType === 'admin') {
        const row = await AdminModel.findById(id);
        if (!row) throw new Error('Admin account not found.');
        return row;
    }
    if (targetType === 'employee') {
        const row = await EmployeeModel.findById(id);
        if (!row) throw new Error('Employee not found.');
        return row;
    }
    throw new Error('Invalid account type.');
}

/**
 * Attach (or overwrite) an SSO identity on an existing local account — the "merge
 * my local account into my SSO account" primitive.
 * @param {{targetType:'admin'|'employee', targetId:number, provider:string, externalId:string}} p
 * @param {object} actor  the acting admin (req.user)
 * @returns {Promise<{ok:boolean, message?:string}>}
 */
async function linkSsoIdentity(
    { targetType, targetId, provider, externalId, linkMethod = null },
    actor
) {
    const p = _norm(provider),
        x = _norm(externalId);
    if (!p || !x)
        return {
            ok: false,
            code: 'alk_provider_and_id_required',
            message: 'Both a provider and an external identity id are required.',
        };
    // Authorization: linking to an ADMIN account is SuperAdmin-only; linking an
    // EMPLOYEE identity needs the account-provisioning permission.
    if (targetType === 'admin' && !_isSuper(actor))
        return {
            ok: false,
            code: 'alk_super_only_link_admin',
            message: 'Only a SuperAdmin can link an SSO identity to an admin account.',
        };
    if (
        targetType === 'employee' &&
        !_hasPerm(actor, 'manage_onboarding') &&
        !_hasPerm(actor, 'manage_admins')
    ) {
        return {
            ok: false,
            code: 'alk_link_denied',
            message: 'You do not have permission to link employee accounts.',
        };
    }
    let target;
    try {
        target = await _loadTarget(targetType, targetId);
    } catch (e) {
        return { ok: false, message: e.message };
    }
    // B1 (3.23.20): a SuperAdmin account never carries an SSO identity — it signs
    // in with the break-glass password + TOTP only. (An onboarding merge into a
    // SuperAdmin comes through here too, and is refused the same way.)
    if (targetType === 'admin' && target.role === 'superadmin') {
        try {
            await LogService.log({
                adminId: actor && actor.id,
                action: 'ACCOUNT_SSO_LINK_REFUSED',
                entityType: 'admin',
                entityId: Number(target.id),
                details: `superadmin_sso_forbidden: SSO identity ${p}:${x} not linked to SuperAdmin "${target.username}"`,
            });
        } catch (_) {
            /* audit best-effort */
        }
        return {
            ok: false,
            code: 'alk_superadmin_no_sso',
            message:
                'A SuperAdmin account never signs in through SSO: it uses its password and two-factor authentication only.',
        };
    }

    // Scope: a delegated (non-super) admin holding the permission may still only act on
    // employees WITHIN their RBAC scope — otherwise they could graft their own SSO
    // identity onto any employee org-wide and then sign in as that person.
    if (targetType === 'employee' && !_isSuper(actor)) {
        const RBACService = require('./RBACService');
        if (!(await RBACService.canAccessEmployeeData(actor, target))) {
            return {
                ok: false,
                code: 'alk_employee_out_of_scope',
                message: 'That employee is outside your administrative scope.',
            };
        }
    }

    // Uniqueness: this identity may not already belong to a DIFFERENT account.
    const holder = await accountHoldingIdentity(p, x);
    if (holder && !(holder.type === targetType && holder.id === Number(target.id))) {
        return {
            ok: false,
            code: 'alk_identity_taken',
            params: { type: holder.type, username: holder.username },
            message: `That SSO identity is already linked to another account (${holder.type} “${holder.username}”). Unlink it there first.`,
        };
    }

    const table = targetType === 'admin' ? 'admins' : 'employees';
    const prevExternal = target.externalId || target.external_id || null;
    // S4 (3.23.19): HOW this identity was linked. Only a SuperAdmin's link (or an
    // onboarding merge) can later open an ADMINISTRATOR account through SSO; a
    // delegate's link is recorded as such.
    // an onboarding merge is trusted only when a SuperAdmin performed it — a
    // delegated manage_onboarding admin's merge is a 'delegated_link'.
    const superActor = _isSuper(actor) && actor.isActive !== false && actor.is_active !== false;
    const method = !superActor
        ? 'delegated_link'
        : linkMethod === 'onboarding_merge'
          ? 'onboarding_merge'
          : 'superadmin_link';
    const email = _lower(target.email) || null;
    const MOVED = new Error('alk_identity_taken');
    try {
        await db.runTransaction(async () => {
            // Normalized identity row (source of truth; supports many per user).
            // C1b (3.23.20): a conflict may only REFRESH the row of the SAME
            // account — it never silently MOVES an identity to a new owner (the
            // holder check above can race). No row back → someone else holds it.
            const row = await db.get(
                `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid, email, is_primary, linked_by, link_method)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (sso_provider, sso_uid) DO UPDATE SET email = EXCLUDED.email, link_method = EXCLUDED.link_method
                  WHERE user_identities.subject_type = EXCLUDED.subject_type
                    AND user_identities.subject_id = EXCLUDED.subject_id
                 RETURNING id`,
                [
                    targetType,
                    Number(target.id),
                    p,
                    x,
                    email,
                    !prevExternal,
                    actor && actor.id,
                    method,
                ]
            );
            if (!row) throw MOVED;
            // Inline columns as the denormalized "primary" (legacy back-compat/display).
            await db.run(
                `UPDATE ${table} SET auth_provider = ?, external_id = ?, updated_at = now() WHERE id = ?`,
                [p, x, Number(target.id)]
            );
        });
    } catch (e) {
        if (e !== MOVED) throw e;
        return {
            ok: false,
            code: 'alk_identity_taken',
            params: { type: '?', username: '?' },
            message:
                'That SSO identity is already linked to another account. Unlink it there first.',
        };
    }
    await LogService.log({
        adminId: actor && actor.id,
        action: 'ACCOUNT_SSO_LINKED',
        entityType: targetType,
        entityId: Number(target.id),
        details: `Linked ${targetType} #${target.id} (${target.username}) to SSO identity ${p}:${x}`,
    });
    return {
        ok: true,
        code: 'alk_linked',
        params: { username: target.username, provider: p },
        message: `Linked ${target.username} to the ${p} identity. They can now sign in with SSO.`,
    };
}

/** Detach the SSO identity from an account (revert to local/password sign-in). */
async function unlinkSsoIdentity({ targetType, targetId }, actor) {
    if (targetType === 'admin' && !_isSuper(actor))
        return {
            ok: false,
            code: 'alk_super_only_unlink_admin',
            message: 'Only a SuperAdmin can unlink an admin account.',
        };
    if (
        targetType === 'employee' &&
        !_hasPerm(actor, 'manage_onboarding') &&
        !_hasPerm(actor, 'manage_admins')
    ) {
        return {
            ok: false,
            code: 'alk_unlink_denied',
            message: 'You do not have permission to unlink employee accounts.',
        };
    }
    let target;
    try {
        target = await _loadTarget(targetType, targetId);
    } catch (e) {
        return { ok: false, message: e.message };
    }
    if (targetType === 'employee' && !_isSuper(actor)) {
        const RBACService = require('./RBACService');
        if (!(await RBACService.canAccessEmployeeData(actor, target))) {
            return {
                ok: false,
                code: 'alk_employee_out_of_scope',
                message: 'That employee is outside your administrative scope.',
            };
        }
    }
    const table = targetType === 'admin' ? 'admins' : 'employees';
    const prev = `${target.authProvider || target.auth_provider || ''}:${target.externalId || target.external_id || ''}`;
    await db.runTransaction(async () => {
        await db.run('DELETE FROM user_identities WHERE subject_type = ? AND subject_id = ?', [
            targetType,
            Number(target.id),
        ]);
        await db.run(
            `UPDATE ${table} SET auth_provider = NULL, external_id = NULL, updated_at = now() WHERE id = ?`,
            [Number(target.id)]
        );
    });
    await LogService.log({
        adminId: actor && actor.id,
        action: 'ACCOUNT_SSO_UNLINKED',
        entityType: targetType,
        entityId: Number(target.id),
        details: `Unlinked ${targetType} #${target.id} (${target.username}) from SSO identity ${prev}`,
    });
    return {
        ok: true,
        code: 'alk_unlinked',
        params: { username: target.username },
        message: `Unlinked ${target.username}. They now sign in locally.`,
    };
}

/**
 * Resolve a pending onboarding request by MERGING it into an existing local
 * account instead of creating a new employee: the request's SSO identity is
 * attached to the chosen account and the request is closed. This is the fix for
 * the "an account with this email already exists" dead-end.
 * @param {{requestId:number, targetType:'admin'|'employee', targetId:number}} p
 * @param {object} actor
 */
async function mergeOnboardingRequest({ requestId, targetType, targetId }, actor) {
    if (!_hasPerm(actor, 'manage_onboarding'))
        return {
            ok: false,
            code: 'alk_onboarding_denied',
            message: 'You do not have permission to manage the onboarding queue.',
        };
    const reqRow = await OnboardingRequestModel.findById(parseInt(requestId, 10));
    if (!reqRow || reqRow.status !== 'pending')
        return {
            ok: false,
            code: 'alk_request_decided',
            message: 'Request not found or already decided.',
        };
    const provider = _norm(reqRow.authProvider || reqRow.auth_provider);
    const externalId = _norm(reqRow.externalId || reqRow.external_id);
    if (!provider || !externalId)
        return {
            ok: false,
            code: 'alk_no_identity_to_merge',
            message:
                'This request has no SSO identity to merge (it is a local signup — approve it as a new account instead).',
        };

    let target;
    try {
        target = await _loadTarget(targetType, targetId);
    } catch (e) {
        return { ok: false, message: e.message };
    }

    // Merging into an ADMIN account is SuperAdmin-only (privilege boundary).
    if (targetType === 'admin' && !_isSuper(actor))
        return {
            ok: false,
            code: 'alk_super_only_merge_admin',
            message: 'Only a SuperAdmin can merge an SSO sign-in into an admin account.',
        };
    // never into a SuperAdmin account (checked before the e-mail rules, so
    // the refusal says why).
    if (targetType === 'admin' && target.role === 'superadmin')
        return {
            ok: false,
            code: 'alk_superadmin_no_sso',
            message:
                'A SuperAdmin account never signs in through SSO: it uses its password and two-factor authentication only.',
        };

    // Safety: the email on the request must match the target account, so a queue
    // reviewer can't accidentally graft one person's SSO login onto another's
    // account. (Both were surfaced as candidates BY this email, but re-check.)
    const reqEmail = _lower(reqRow.email);
    const tgtEmail = _lower(target.email);
    // The guard must not evaporate when the TARGET has no e-mail: `reqEmail &&
    // tgtEmail && ...` meant that grafting an SSO identity onto any of the
    // employees without an address skipped the check entirely, and that person
    // could then sign in as them. Requiring a match means requiring an address to
    // match against.
    if (reqEmail && !tgtEmail) {
        return {
            ok: false,
            code: 'alk_merge_no_email',
            message:
                'The selected account has no email address to verify against. Add one first, then merge.',
        };
    }
    if (reqEmail && tgtEmail && reqEmail !== tgtEmail) {
        return {
            ok: false,
            code: 'alk_merge_email_mismatch',
            message: 'The request email does not match the selected account. Merge aborted.',
        };
    }

    const link = await linkSsoIdentity(
        {
            targetType,
            targetId: Number(target.id),
            provider,
            externalId,
            linkMethod: 'onboarding_merge',
        },
        actor
    );
    if (!link.ok) return link;

    await OnboardingRequestModel.update(reqRow.id, {
        status: 'approved',
        decidedBy: actor && actor.id,
        decidedAt: new Date().toISOString(),
    });
    await LogService.log({
        adminId: actor && actor.id,
        action: 'ONBOARDING_MERGED',
        entityType: 'onboarding',
        entityId: reqRow.id,
        details: `Merged onboarding request ${reqRow.email} into existing ${targetType} #${target.id} (${target.username})`,
    });
    return {
        ok: true,
        code: 'alk_merged',
        params: { email: reqRow.email, username: target.username },
        message: `Merged ${reqRow.email} into ${target.username}. They can now sign in with SSO using their existing account.`,
    };
}

/**
 * PROMOTE an employee to an admin ("grant admin access"). Creates an admin
 * account linked to the employee (admins.linked_employee_id — no SSO identity of
 * its own; while SSO is enforced the person reaches it through the SSO account
 * chooser), and optionally its permissions/scopes. SuperAdmin-only.
 * @param {{employeeId:number, role?:string, permissions?:string[], scopes?:Array, accessExpiresAt?:string}} p
 * @param {object} actor
 */
async function grantAdminAccess({ employeeId, role, permissions, scopes, accessExpiresAt }, actor) {
    if (!_isSuper(actor))
        return {
            ok: false,
            code: 'alk_super_only_grant',
            message: 'Only a SuperAdmin can grant admin access.',
        };
    const emp = await EmployeeModel.findById(parseInt(employeeId, 10));
    if (!emp) return { ok: false, code: 'alk_employee_not_found', message: 'Employee not found.' };

    // One linked admin per employee.
    const existing = await db.get(
        'SELECT id, username, is_active FROM admins WHERE linked_employee_id = ?',
        [Number(emp.id)]
    );
    if (existing)
        return {
            ok: false,
            code: 'alk_already_admin',
            params: { username: existing.username },
            message: `This employee already has a linked admin account (${existing.username}). Manage it from the Admins page.`,
        };

    const wantRole = ['localadmin', 'viewer', 'superadmin'].includes(role) ? role : 'localadmin';

    // A unique admin username. Start from the employee's username/email local-part.
    const base =
        (_norm(emp.username) || _lower(emp.email).split('@')[0] || `emp${emp.id}`).replace(
            /[^a-zA-Z0-9._-]/g,
            ''
        ) || `emp${emp.id}`;
    let username = base,
        n = 1;
    /* eslint-disable no-await-in-loop */
    while (await db.get('SELECT id FROM admins WHERE username = ?', [username])) {
        username = `${base}${n++}`;
    }
    /* eslint-enable no-await-in-loop */

    // A strong random password + force-change: an SSO-promoted admin never uses it
    // (they sign in via the carried identity), and a non-SSO one must set it.
    const bcrypt = require('bcrypt');
    const crypto = require('crypto');
    const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('base64') + 'Aa1!', 10);

    // Clamp granted permissions to the catalog (viewer never gets write slugs).
    const cleanPerms = (Array.isArray(permissions) ? permissions : [])
        .filter(isValidSlug)
        .filter((s) => !(wantRole === 'viewer' && isWrite(s)));

    const admin = await db.runTransaction(async () => {
        // The new admin carries NO SSO identity: the person's SSO identities stay
        // on their employee record (one identity, one row). With no SSO provider
        // the admin signs in with a password + MFA (force_password_change set);
        // while SSO is enforced (3.23.19) the password door is SuperAdmin-only and
        // the person reaches this account through the SSO account chooser via
        // linked_employee_id, then MFA (local, IdP-asserted, or forced enrolment).
        const row = await db.get(
            `INSERT INTO admins (username, email, password_hash, role, is_active, force_password_change,
                                 auth_provider, external_id, linked_employee_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, true, true, NULL, NULL, ?, now(), now())
             RETURNING id, username, role`,
            // C1c (3.23.20): a SuperAdmin has NO linked person — no SSO route
            // (the account chooser) can ever lead to it.
            [
                username,
                emp.email || null,
                passwordHash,
                wantRole,
                wantRole === 'superadmin' ? null : Number(emp.id),
            ]
        );
        if (wantRole !== 'superadmin' && cleanPerms.length) {
            await AdminPermissionModel.setForAdmin(row.id, cleanPerms, accessExpiresAt || null);
        }
        if (wantRole !== 'superadmin' && Array.isArray(scopes)) {
            for (const sc of scopes) {
                if (!sc || !sc.type || !sc.value) continue;
                const data = { adminId: row.id };
                if (sc.type === 'site') {
                    data.scopeType = 'site';
                    data.siteId = parseInt(sc.value, 10);
                } else if (sc.type === 'department') {
                    data.scopeType = 'department';
                    data.departmentId = parseInt(sc.value, 10);
                } else if (sc.type === 'service') {
                    data.scopeType = 'service';
                    data.serviceId = parseInt(sc.value, 10);
                } else if (sc.type === 'country') {
                    data.scopeType = 'country';
                    data.countryId = parseInt(sc.value, 10);
                }
                if (data.scopeType) {
                    data.expiresAt = accessExpiresAt || null;
                    await AdminScopeModel.create(data);
                }
            }
        }
        return row;
    });

    await LogService.log({
        adminId: actor && actor.id,
        action: 'ADMIN_ACCESS_GRANTED',
        entityType: 'admin',
        entityId: Number(admin.id),
        details: `Granted ${wantRole} access to employee #${emp.id} (${emp.username || emp.email}) → admin “${admin.username}” (password + MFA${wantRole === 'superadmin' ? '; SuperAdmin: not linked to the person, never reachable through SSO' : ''})`,
    });
    return {
        ok: true,
        admin,
        code: 'alk_granted',
        params: { person: emp.username || emp.email, role: wantRole, username: admin.username },
        message: `${emp.username || emp.email} now has ${wantRole} access as “${admin.username}”. Admins sign in with a password + MFA — set their admin password from the Admins page (they enrol MFA on first sign-in). Their SSO stays on their employee account.`,
    };
}

/**
 * Revoke a previously-granted admin account. Deactivates it (so the SSO account
 * chooser no longer offers it) and frees any SSO identity linked directly to it,
 * so sign-in reverts to the underlying employee. SuperAdmin-only. The row
 * is kept (deactivated) for audit; pass hardDelete to remove it entirely.
 * @param {{adminId:number, hardDelete?:boolean}} p
 * @param {object} actor
 */
async function revokeAdminAccess({ adminId, hardDelete, reason }, actor) {
    if (!_isSuper(actor))
        return {
            ok: false,
            code: 'superadmin_only',
            message: 'Only a SuperAdmin can revoke admin access.',
        };
    const id = parseInt(adminId, 10);
    const admin = await AdminModel.findById(id);
    if (!admin) return { ok: false, code: 'not_found', message: 'Admin account not found.' };
    if (admin.role === 'superadmin') {
        const supers = await db.get(
            "SELECT COUNT(*)::int AS cnt FROM admins WHERE role = 'superadmin' AND is_active = true"
        );
        if (Number(supers && supers.cnt) <= 1)
            return {
                ok: false,
                code: 'last_superadmin',
                message: 'Cannot revoke the last active SuperAdmin.',
            };
    }
    if (actor && Number(actor.id) === id)
        return { ok: false, code: 'self', message: 'You cannot revoke your own admin access.' };
    // a revocation is a STATE with a written reason,
    // like every other cancellation in this product.
    const why = _norm(reason);
    if (!why)
        return {
            ok: false,
            code: 'reason_required',
            message: 'A written reason is required to revoke admin access.',
        };

    let perms = [];
    let scopes = [];
    await db.runTransaction(async () => {
        if (hardDelete) {
            await AdminPermissionModel.deleteByAdminId(id);
            await AdminScopeModel.deleteByAdminId(id);
        } else {
            // this was the LAST perimeter-destroying path. Grants and scopes
            // are now REVOKED AND KEPT with the reason (the same models
            // AdminController._deactivateAdmin uses), so reactivating restores the
            // perimeter instead of leaving a login with a scope and no capability.
            perms = await AdminPermissionModel.revokeAllForAdmin(id, why);
            scopes = await AdminScopeModel.revokeAllForAdmin(id, why);
        }
        // Admin accounts don't carry SSO (they use password + MFA); drop any that
        // were manually linked so a stale identity can't resolve to a dead admin.
        await db.run('DELETE FROM user_identities WHERE subject_type = ? AND subject_id = ?', [
            'admin',
            id,
        ]);
        if (hardDelete) {
            await db.run('DELETE FROM admins WHERE id = ?', [id]);
        } else {
            await db.run(
                `UPDATE admins SET is_active = false, auth_provider = NULL, external_id = NULL,
                        deactivated_at = now(), deactivated_by = ?, deactivation_reason = ?, updated_at = now()
                  WHERE id = ?`,
                [actor && actor.id ? Number(actor.id) : null, why, id]
            );
        }
    });
    // Same ledger trail as a deactivation, so the access review reads truthfully.
    if (!hardDelete) {
        try {
            const AccessLedgerService = require('./AccessLedgerService');
            const common = { adminId: id, actorAdminId: actor && actor.id, reason: why };
            for (const p of perms)
                await AccessLedgerService.record({
                    ...common,
                    changeType: 'revoke',
                    slug: p.permission,
                });
            for (const sc of scopes)
                await AccessLedgerService.record({
                    ...common,
                    changeType: 'scope_removed',
                    scopeType: sc.scopeType,
                    scopeId: AdminScopeModel._scopeTargetId(sc),
                });
            await AccessLedgerService.record({ ...common, changeType: 'deactivated' });
        } catch (e) {
            console.error('[accountLink] ledger record failed:', e && e.message);
        }
    }
    await LogService.log({
        adminId: actor && actor.id,
        action: 'ADMIN_ACCESS_REVOKED',
        entityType: 'admin',
        entityId: id,
        details: `${hardDelete ? 'Deleted' : 'Deactivated'} admin account “${admin.username}”${admin.linkedEmployeeId || admin.linked_employee_id ? ` (was linked to employee #${admin.linkedEmployeeId || admin.linked_employee_id})` : ''}; reason: ${why}; ${perms.length} grant(s) and ${scopes.length} scope(s) kept and flagged revoked`,
    });
    return {
        ok: true,
        code: 'revoked',
        username: admin.username,
        perms: perms.length,
        scopes: scopes.length,
        message: `Revoked admin access for “${admin.username}”.`,
    };
}

/** The admin account promoted from a given employee, or null. */
async function linkedAdminForEmployee(employeeId) {
    const a = await db.get(
        'SELECT id, username, role, is_active FROM admins WHERE linked_employee_id = ?',
        [parseInt(employeeId, 10)]
    );
    return a
        ? {
              id: Number(a.id),
              username: a.username,
              role: a.role,
              isActive: a.isActive ?? a.is_active,
          }
        : null;
}

module.exports = {
    accountHoldingIdentity,
    findLinkCandidates,
    linkedAdminForEmployee,
    listIdentities,
    removeIdentity,
    linkSsoIdentity,
    unlinkSsoIdentity,
    mergeOnboardingRequest,
    grantAdminAccess,
    revokeAdminAccess,
};
