const AdminModel = require('../models/AdminModel');
const AdminScopeModel = require('../models/AdminScopeModel');
const AdminPermissionModel = require('../models/AdminPermissionModel');
const SiteModel = require('../models/SiteModel');
const DepartmentModel = require('../models/DepartmentModel');
const ServiceModel = require('../models/ServiceModel');
const AuthService = require('../services/AuthService');
const RBACService = require('../services/RBACService');
const {
    PERMISSIONS,
    GROUPS,
    GROUP_LABELS,
    ALL_SLUGS,
    isValidSlug,
    isWrite,
} = require('../config/permissions');
const accessProfiles = require('../config/accessProfiles');
const LogService = require('../services/LogService');
const DatabaseCleanupService = require('../services/DatabaseCleanupService');
const BulkDataService = require('../services/BulkDataService');
const UnifiedImportService = require('../services/UnifiedImportService');
const UnifiedExportService = require('../services/UnifiedExportService');
const UnifiedJsonService = require('../services/UnifiedJsonService');
const ExcelJS = require('exceljs');
// `emailHasNoPublicDomain` is the SAME predicate the validator splits on,
// handed to the two admin forms so the sentence they show and the rule that
// accepts the address can never drift apart.
const { adminValidation, keepDraft, emailHasNoPublicDomain } = require('../utils/validators');
const { missingReadImplications } = require('../config/permissions');
const { parsePage, buildPager, sortClause, sortLinks, csvResponse } = require('../utils/listTools');

/**
 * an employee-acting write granted without
 * view_employees still WORKS (the catalogue implies the read), but the granter
 * should know the account can now read staff in scope — say so as an advisory.
 */
function _warnImpliedReads(req, grantedPerms) {
    const implied = missingReadImplications(grantedPerms);
    if (!implied.length) return;
    const names = implied.map((s) => (req.t ? req.t(`admin:perm.${s}.label`) : s)).join(', ');
    req.flash(
        'warning',
        req.t
            ? req.t('admin:perm_read_implied_warning', { perms: names })
            : `The capabilities ${names} act on employee records and also grant "View employees" (within scope).`
    );
}

// --- Delegated-administration helpers (module-level so they don't depend on
// `this`, since controller methods are passed to Express as bare references) ---
// Admin management is reachable by a SuperAdmin OR a local admin who holds the
// `manage_admins` grant. The route guard enforces reachability; these helpers
// add the anti-escalation rules a delegate must obey.

/** Can this user reach the admin-management module at all? */
function _canManage(user) {
    return RBACService.isSuperAdmin(user) || RBACService.hasPermission(user, 'manage_admins');
}

/** Localised message with an English fallback (probes and API callers have no req.t). */
function _t(req, key, params, fallback) {
    return req && typeof req.t === 'function' ? req.t(key, params) : fallback;
}

/**
 * Does this identifier already name a PERSON?
 *
 * One login, one identity. `admins.username` and `employees.username` sit in two
 * tables that no constraint relates; the employee side already refuses a login
 * held by an administration account (EmployeeController.setupAccount) and the
 * reciprocal check was missing here, so a homonymous administration account
 * could be created — and the sign-in then answered with THAT account instead of
 * the person, erasing their reporting line with unchanged credentials.
 *
 * `exceptEmployeeId` is the person an account already NAMES
 * (admins.linked_employee_id): that account is the legitimate case — the two
 * accounts are declared to be the same human — so its own login is not a
 * collision with itself.
 */
async function _employeeLoginExists(username, exceptEmployeeId = null) {
    if (!username) return false;
    try {
        const EmployeeModel = require('../models/EmployeeModel');
        const person = await EmployeeModel.findByUsername(String(username).trim());
        if (!person) return false;
        if (exceptEmployeeId != null && Number(person.id) === Number(exceptEmployeeId))
            return false;
        return true;
    } catch (_) {
        // Fails OPEN on a lookup error: this guard exists to prevent a new
        // collision, never to block administration when the model is unavailable.
        return false;
    }
}

/**
 * Revoke every live API key OWNED by an admin who has just been deactivated.
 * An owned key impersonates its owner (see middleware/apiAuth), so
 * de-authorizing the account without killing its keys leaves the exact hole the
 * deactivation was meant to close. Best-effort: it must never turn a successful
 * deactivation into a 500 — ApiKeyService.validate also fails closed on its own.
 * @returns {Promise<number>} number of keys revoked (0 on any failure)
 */
async function _revokeOwnedApiKeys(adminId) {
    try {
        return await require('../services/ApiKeyService').revokeByOwner(adminId);
    } catch (e) {
        console.error('API key cascade revoke failed for admin', adminId, e && e.message);
        return 0;
    }
}

/** Sign an admin out of every device. Best-effort; returns the number of sessions killed. */
async function _revokeSessions(adminId, exceptSid = null) {
    try {
        const SessionService = require('../services/SessionService');
        return await SessionService.revokeAllForUser(adminId, 'admin', exceptSid);
    } catch (e) {
        console.error('Session revoke failed for admin', adminId, e && e.message);
        return 0;
    }
}

/** Slugs the granter is allowed to hand out (a delegate cannot grant beyond their own). */
function _assignableSlugs(granter) {
    if (RBACService.isSuperAdmin(granter)) return [...ALL_SLUGS];
    return (Array.isArray(granter.permissions) ? granter.permissions : []).filter(isValidSlug);
}

/** Normalize submitted permissions → a clean, authorized slug list for the target role. */
function _sanitizePermissions(granter, role, submitted) {
    if (role !== 'localadmin' && role !== 'viewer') return [];
    let list = submitted;
    if (!Array.isArray(list)) list = list ? [list] : [];
    const assignable = new Set(_assignableSlugs(granter));
    return (
        [...new Set(list)]
            .filter((s) => isValidSlug(s) && assignable.has(s))
            // a Viewer can never exercise a write grant, so don't store one
            .filter((s) => !(role === 'viewer' && isWrite(s)))
    );
}

/**
 * Anti-escalation: a non-superadmin granter may only assign a scope that is
 * WITHIN their own clearance. Without this, a scoped local admin holding
 * `manage_admins` could grant a peer scope over units they themselves cannot
 * access. Mirrors the `_assignableSlugs` clamp that already guards permission
 * slugs. Region follows the country rule: a delegate may hand out a
 * region only if they hold that very region themselves.
 */
async function _granterCanAssignScope(granter, scope) {
    if (RBACService.isSuperAdmin(granter)) return true;
    const id = parseInt(scope.value, 10);
    if (!id) return false;
    if (scope.type === 'site') return RBACService.canAccessSite(granter, id);
    if (scope.type === 'department') return RBACService.canAccessDepartment(granter, id);
    if (scope.type === 'service') return RBACService.canAccessService(granter, id);
    if (scope.type === 'country') return RBACService.canAccessCountry(granter, id);
    if (scope.type === 'region')
        return (await _assignableRegions(granter)).some((r) => Number(r.id) === id);
    return false;
}

/**
 * Employee-set containment: may an actor with scope `mine` administer an
 * account with scope `theirs`? Pure so the list page can apply it to every row
 * from ONE resolution of the actor's scope (see _manageableIds).
 */
function _containsScope(mine, theirs) {
    if (!mine || !theirs) return false;
    if (mine.unrestricted) return true;
    if (theirs.unrestricted) return false; // they see all, you do not
    if (!Array.isArray(mine.employeeIds)) return false;
    // A scope type the resolver could not expand contributes an EMPTY set —
    // which must not read as "governs nobody", so it is never contained.
    if (Array.isArray(theirs.unknownScopeTypes) && theirs.unknownScopeTypes.length) return false;
    const govern = new Set(mine.employeeIds.map(Number));
    return (theirs.employeeIds || []).every((id) => govern.has(Number(id)));
}

/**
 * May `actor` administer the admin account `targetId`?
 *
 * CLOSES A LATERAL PRIVILEGE ESCALATION. `_granterCanAssignScope` above already
 * stops a scoped delegate GRANTING a peer authority wider than their own — the
 * codebase knew about this vector. But every admin-on-admin verb (reset the
 * password, unlock, force a change, extend access, edit, delete, revoke, link an
 * SSO identity) gated only on the `manage_admins` CAPABILITY plus "the target is
 * not a SuperAdmin". None checked what the TARGET governs.
 *
 * So the guard was bypassable by going around it: a Site-A local admin holding
 * `manage_admins` opens the country-scoped peer they are forbidden from creating,
 * resets that account's password to one they choose, and signs in as it —
 * acquiring exactly the country-wide authority the assignment guard denied them.
 * One request, no race.
 *
 * The rule enforced here: you may administer an account only if it governs
 * NOBODY you do not already govern. Expressed as employee-set containment, so it
 * holds uniformly for every scope type — region, country, site, department,
 * service — instead of needing a branch per type that can drift out of date.
 *
 * FAILS CLOSED: any error resolving either side denies the action.
 *
 * 3.23.17 (finding A-1, CRITICAL): the target is judged on its FULL perimeter —
 * revoked and expired scope rows and grants included — because that is exactly
 * what "Réactiver" / "Prolonger" put back in force. Judging only the LIVE set
 * let a deactivated country-wide admin (every row revoked → empty set) pass the
 * `every` vacuously: a one-service delegate reset its password, reactivated
 * it and signed in with country-wide reach. Now, for a non-SuperAdmin actor:
 *   - a target with NO scope row at all (or an unexpandable one) → SuperAdmin only;
 *   - every target scope row must be one the actor could GRANT (same rule as
 *     creation, `_granterCanAssignScope`) AND the target's people ⊆ the actor's;
 *   - every permission slug the target holds or could get back ⊆ the actor's.
 * `mineCache` lets the list page resolve the actor's scope once.
 */
async function _canManageTargetAdmin(actor, targetId, mineCache = null) {
    try {
        if (RBACService.isSuperAdmin(actor)) return true;
        if (Number(actor.id) === Number(targetId)) return true; // self-service is guarded separately

        const target = await AdminModel.findById(targetId);
        if (!target) return false;
        // A delegate may never administer a SuperAdmin (also checked at each call
        // site; kept here so this helper is safe used on its own).
        if (target.role === 'superadmin') return false;

        const { resolveAdminScope } = require('../utils/adminScope');
        const [mine, theirs] = await Promise.all([
            mineCache || resolveAdminScope(actor),
            resolveAdminScope(
                { id: Number(targetId), userType: 'admin', role: target.role },
                { includeInactive: true }
            ),
        ]);
        // No perimeter at all is not "governs nobody": it is unknown → SuperAdmin only.
        if (!theirs || !Number(theirs.scopeRowCount)) return false;
        if (!_containsScope(mine, theirs)) return false;

        // Structural containment: each (restorable) scope row must be one the
        // actor could hand out. Catches perimeters that hold no employee YET.
        const rows = await AdminScopeModel.findAllByAdminId(Number(targetId));
        if (!rows || !rows.length) return false;
        for (const r of rows) {
            const value = AdminScopeModel._scopeTargetId(r);
            if (!(await _granterCanAssignScope(actor, { type: r.scopeType, value }))) return false;
        }

        // Capability containment over every grant row, revoked/expired included.
        const db = require('../config/database');
        const theirPerms = await db.all(
            'SELECT permission FROM admin_permissions WHERE admin_id = ?',
            [Number(targetId)]
        );
        const held = new Set(await RBACService.getPermissions(actor));
        return (theirPerms || []).every((p) => held.has(p.permission));
    } catch (_) {
        return false;
    }
}

/**
 * The subset of `rows` (admin list rows: id, role) the actor may administer —
 * `null` for a SuperAdmin (everyone). The actor's scope is resolved ONCE; each
 * row costs one resolution of the target (a 20-admin estate, not 4000 people).
 * Rows the actor may not manage are still LISTED, but carry no action link
 * (rule: never an unreachable link) and are left out of the scoped export.
 */
async function _manageableIds(actor, rows) {
    if (RBACService.isSuperAdmin(actor)) return null;
    const out = new Set();
    try {
        const { resolveAdminScope } = require('../utils/adminScope');
        const mine = await resolveAdminScope(actor);
        for (const r of rows) {
            if (Number(r.id) === Number(actor.id)) {
                out.add(Number(r.id));
                continue;
            }
            if (r.role === 'superadmin') continue;
            // Same judgement as every admin-on-admin verb (full restorable
            // perimeter + capabilities), so the list never offers an action link
            // the verb would then refuse — nor hides the reverse.
            if (await _canManageTargetAdmin(actor, r.id, mine)) out.add(Number(r.id));
        }
    } catch (_) {
        /* fail closed: whatever was resolved so far */
    }
    return out;
}

/** Guard body shared by the admin-on-admin verbs. Returns true if it handled the denial. */
async function _denyIfOutOfScope(req, res, targetId, redirectTo = '/admins') {
    if (await _canManageTargetAdmin(req.user, targetId)) return false;
    req.flash(
        'error',
        _t(
            req,
            'flash:admin_target_out_of_scope',
            {},
            'This administrator governs people outside your scope: you cannot act on their account.'
        )
    );
    res.redirect(redirectTo);
    return true;
}

/**
 * The mandatory reason of a state change (rule 3: states + reasons, never
 * deletes). Returns the trimmed reason, or null after flashing + redirecting.
 */
function _requireReason(req, res, redirectTo) {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason) return reason.slice(0, 1000);
    req.flash(
        'error',
        _t(
            req,
            'flash:adm_reason_required',
            {},
            'A reason is required for this action. Nothing was changed.'
        )
    );
    res.redirect(redirectTo);
    return null;
}

/** Where a row-level action should land: back on the list when it came from there. */
function _returnTo(req, id) {
    return req.body && req.body.returnTo === 'list' ? '/admins' : `/admins/${id}`;
}

/**
 * Sentinel returned by `_parseExpiry` when the submitted access duration cannot
 * be honoured. It is NOT a value any caller may pass through to the models —
 * every write path must turn it into a flash error + redirect.
 */
const EXPIRY_INVALID = Symbol('accessExpiry:invalid');

/**
 * Parse the "Durée de l'accès" group into an ISO expiry (or null = permanent).
 *
 * FAILS CLOSED. The previous version returned `null` for an unparseable or PAST
 * date, and `null` means PERMANENT — so a typo'd or stale date silently minted a
 * never-expiring delegation, the exact opposite of what the operator asked for.
 * Now anything we cannot honour returns EXPIRY_INVALID and the caller refuses
 * the whole write.
 *
 * `accessDurationMode` ('until' | 'permanent') is the radio group; a body with
 * no mode at all (legacy form, API caller) keeps the old blank = permanent
 * reading, because there a blank field genuinely means "no end date".
 */
function _parseExpiry(req) {
    const body = req.body || {};
    const mode = typeof body.accessDurationMode === 'string' ? body.accessDurationMode.trim() : '';
    if (mode === 'permanent') return null;

    const raw = body.accessExpiresAt;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        // "Jusqu'au …" chosen but no date typed → the operator asked for a
        // bounded grant and did not say when. Refuse rather than guess forever.
        return mode === 'until' ? EXPIRY_INVALID : null;
    }
    const d = new Date(String(raw).trim());
    if (isNaN(d.getTime())) return EXPIRY_INVALID; // unparseable
    if (d.getTime() <= Date.now()) return EXPIRY_INVALID; // already in the past
    return d.toISOString();
}

/** Localized message for a refused access duration (FR-first, EN mirror). */
function _expiryError(req) {
    return _t(
        req,
        'admin:ap_expiry_invalid',
        {},
        'The access end date is missing, unreadable or already past. Pick a future date, or choose permanent access.'
    );
}

/**
 * Resolve the permission snapshot to store, honouring the access profile.
 *
 * The profile select is the PRIMARY control but stores nothing of its own: the
 * page ticks the bundle into the existing `permissions[]` checkboxes and posts
 * that snapshot, so what lands in `admin_permissions` is exactly what the
 * reviewer saw. `apProfileApplied=1` is the page's proof that its script ran;
 * without it (JavaScript off, or a form posted by a script) we expand the named
 * profile server-side so choosing a profile is never a silent no-op. Either way
 * the result goes through `_sanitizePermissions`, which keeps the granter clamp
 * and the viewer write-filter in force.
 *
 * @returns {{perms: string[], profileKey: string|null, expandedServerSide: boolean}}
 */
function _resolveGrantedPermissions(granter, role, body) {
    const rawKey = body && typeof body.accessProfile === 'string' ? body.accessProfile.trim() : '';
    const profileKey = accessProfiles.isProfileKey(rawKey) ? rawKey : null;
    const applied = body && String(body.apProfileApplied || '') === '1';

    let submitted = body ? body.permissions : undefined;
    let expandedServerSide = false;
    if (profileKey && !applied) {
        submitted = accessProfiles.slugsFor(profileKey);
        expandedServerSide = true;
    }
    return {
        perms: _sanitizePermissions(granter, role, submitted),
        profileKey,
        expandedServerSide,
    };
}

/** Audit suffix naming the profile a grant came from (or an explicit custom set). */
function _profileAuditNote(profileKey, expandedServerSide) {
    if (!profileKey) return 'profile: custom';
    return `profile: ${profileKey}${expandedServerSide ? ' (expanded server-side, no JS)' : ''}`;
}

/**
 * Provenance handed to `AdminPermissionModel.setForAdmin` so the access ledger
 * records WHO granted this and from WHICH named profile — the two questions an
 * access review asks that `admin_permissions` alone cannot answer.
 */
function _grantOpts(req, resolved) {
    return {
        actorAdminId: req.user && req.user.id,
        profileKey: (resolved && resolved.profileKey) || undefined,
    };
}

/** Countries the granter may assign as a scope: all for a super admin; only those
 *  the granter themselves holds country-scope over for a delegate. */
async function _assignableCountries(granter) {
    const db = require('../config/database');
    let rows = [];
    try {
        rows = await db.all('SELECT id, name FROM countries ORDER BY name');
    } catch (_) {
        return [];
    }
    if (RBACService.isSuperAdmin(granter)) return rows;
    // Fetch the granter's scopes ONCE and filter in memory (was: one
    // getAdminWithScopes DB call per country — an N+1 on the admin form).
    const aws = await RBACService.getAdminWithScopes(granter.id);
    const allowed = new Set(
        ((aws && aws.scopes) || [])
            .filter((s) => s.scopeType === 'country')
            .map((s) => Number(s.countryId))
    );
    return rows.filter((c) => allowed.has(Number(c.id)));
}

/** Regions the granter may assign: all for a super admin, own regions for a delegate. */
async function _assignableRegions(granter) {
    const db = require('../config/database');
    let rows = [];
    try {
        rows = await db.all(
            'SELECT id, name FROM regions WHERE COALESCE(is_active, true) = true ORDER BY name'
        );
    } catch (_) {
        return [];
    }
    if (RBACService.isSuperAdmin(granter)) return rows;
    const aws = await RBACService.getAdminWithScopes(granter.id);
    const allowed = new Set(
        ((aws && aws.scopes) || [])
            .filter((s) => s.scopeType === 'region')
            .map((s) => Number(s.regionId))
    );
    return rows.filter((r) => allowed.has(Number(r.id)));
}

/** The five scope axes and the column each one fills. */
const SCOPE_COLUMN = Object.freeze({
    site: 'siteId',
    department: 'departmentId',
    service: 'serviceId',
    country: 'countryId',
    region: 'regionId',
});

/**
 * Normalise the posted `scopes` group (array, numeric-keyed object, or a single
 * entry) into clean rows: `[{ type, value, scopeType, <axis>Id }]`. Unknown
 * types and empty values are dropped here, so every caller shares one reading.
 */
function _scopeRowsFromBody(body) {
    let scopes = body && body.scopes;
    if (!scopes) return [];
    if (!Array.isArray(scopes)) {
        scopes = typeof scopes === 'object' ? Object.values(scopes) : [scopes];
    }
    const seen = new Set();
    const out = [];
    for (const s of scopes) {
        if (!s || !s.type || !s.value) continue;
        const col = SCOPE_COLUMN[s.type];
        const id = parseInt(s.value, 10);
        if (!col || !id) continue;
        const key = `${s.type}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: s.type, value: String(id), scopeType: s.type, [col]: id, key });
    }
    return out;
}

/**
 * Diff-based scope update: only the rows that actually changed are
 * touched. A plain re-save of an unchanged account used to delete and recreate
 * every scope row (new ids, new created_at, a remove+add pair per scope in the
 * ledger) — and, because expired rows were hidden from the form, silently
 * deleted them. Now:
 *   - posted & absent   → created (within the granter's clearance)
 *   - present & unposted → removed, but ONLY if the granter could have assigned
 *                          it (a row outside their clearance is invisible to
 *                          them and must not be dropped by their re-save)
 *   - present & posted  → kept; `expires_at` re-stamped when the form's
 *                          duration differs (a renewal, not churn)
 * @returns {Promise<{added:number, removed:number, kept:number}>}
 */
async function _syncScopes(req, adminId, desired, accessExpiry) {
    const db = require('../config/database');
    const existing = await AdminScopeModel.findByAdminId(adminId);
    const byKey = new Map(existing.map((r) => [AdminScopeModel.scopeKey(r), r]));
    const wanted = new Map(desired.map((d) => [d.key, d]));
    const opts = { actorAdminId: req.user && req.user.id };
    let added = 0;
    let removed = 0;
    let kept = 0;

    for (const d of desired) {
        if (byKey.has(d.key)) continue;
        if (!(await _granterCanAssignScope(req.user, d))) continue; // anti-escalation
        const row = { adminId: Number(adminId), scopeType: d.scopeType, expiresAt: accessExpiry };
        row[SCOPE_COLUMN[d.scopeType]] = d[SCOPE_COLUMN[d.scopeType]];
        await AdminScopeModel.create(row, opts);
        added++;
    }
    for (const r of existing) {
        const key = AdminScopeModel.scopeKey(r);
        if (wanted.has(key)) {
            kept++;
            const cur = r.expiresAt ? new Date(r.expiresAt).toISOString() : null;
            if (cur !== (accessExpiry || null)) {
                await db.run('UPDATE admin_scopes SET expires_at = ? WHERE id = ?', [
                    accessExpiry || null,
                    r.id,
                ]);
            }
            continue;
        }
        const asScope = { type: r.scopeType, value: String(AdminScopeModel._scopeTargetId(r)) };
        if (!(await _granterCanAssignScope(req.user, asScope))) {
            kept++;
            continue;
        }
        await AdminScopeModel.removeOne(r, opts);
        removed++;
    }
    return { added, removed, kept };
}

/**
 * Localize one catalogue entry. The catalogue in src/config/permissions.js is
 * structure-only English; the displayed strings come from `admin:perm.<slug>.*`,
 * with the catalogue's own label/description as the defaultValue fallback so a
 * brand-new slug still renders (in English) before its keys are translated.
 */
function _localizePermission(p, t) {
    if (typeof t !== 'function') return p;
    return {
        ...p,
        label: t(`admin:perm.${p.slug}.label`, { defaultValue: p.label }),
        description: t(`admin:perm.${p.slug}.desc`, { defaultValue: p.description }),
    };
}

/** The flat catalogue, localized — for surfaces that render slug → label badges. */
function _permissionCatalogFor(t) {
    return PERMISSIONS.map((p) => _localizePermission(p, t));
}

/** Display language for the access-profile labels (i18next attaches req.language). */
function _lng(req) {
    const l = (req && (req.language || (req.i18n && req.i18n.language))) || 'fr';
    return String(l).toLowerCase().startsWith('en') ? 'en' : 'fr';
}

/**
 * Access profiles offered on the admin form, clamped to what the granter may
 * actually hand out — so a delegate is never shown a bundle that would land
 * half-applied once `_sanitizePermissions` runs.
 */
function _accessProfilesFor(req, granter) {
    return accessProfiles.localize(_lng(req), _assignableSlugs(granter));
}

/**
 * Catalog grouped for the form, flagged with what the granter may assign, and
 * localized for the caller's language. Pass `req.t`; omitting it yields the raw
 * English catalogue (kept so non-request callers and tests still work).
 */
function _permissionGroupsFor(granter, t) {
    const assignable = new Set(_assignableSlugs(granter));
    const groupTitle = (key) =>
        typeof t === 'function'
            ? t(`admin:permgroup.${key}`, { defaultValue: GROUP_LABELS[key] || key })
            : GROUP_LABELS[key] || key;
    return GROUPS.map((g) => ({
        key: g,
        group: groupTitle(g),
        items: PERMISSIONS.filter((p) => p.group === g).map((p) => ({
            ..._localizePermission(p, t),
            assignable: assignable.has(p.slug),
        })),
    })).filter((g) => g.items.length);
}

/**
 * "Désactiver": ONE state change with ONE set of side
 * effects, whichever control triggered it (the row button, the detail page,
 * the edit form's Active box, the bulk action). Grants and scopes are KEPT and
 * flagged revoked with the reason — never deleted — so "Réactiver" restores
 * the previous perimeter; the ledger gets one `revoke` per capability, one
 * `scope_removed` per scope and one `deactivated` event, all carrying the
 * reason; live sessions and owned API keys die immediately.
 * Runs in ONE transaction: a half-deactivated account is worse than either state.
 */
async function _deactivateAdmin(req, admin, reason) {
    const db = require('../config/database');
    const AccessLedgerService = require('../services/AccessLedgerService');
    const id = Number(admin.id);
    let perms = [];
    let scopes = [];
    await db.runTransaction(async () => {
        await AdminModel.update(id, {
            isActive: 0,
            deactivatedAt: new Date().toISOString(),
            deactivatedBy: req.user && req.user.id ? Number(req.user.id) : null,
            deactivationReason: reason,
        });
        perms = await AdminPermissionModel.revokeAllForAdmin(id, reason);
        scopes = await AdminScopeModel.revokeAllForAdmin(id, reason);
    });
    const common = { adminId: id, actorAdminId: req.user && req.user.id, reason };
    for (const p of perms)
        await AccessLedgerService.record({ ...common, changeType: 'revoke', slug: p.permission });
    for (const s of scopes)
        await AccessLedgerService.record({
            ...common,
            changeType: 'scope_removed',
            scopeType: s.scopeType,
            scopeId: AdminScopeModel._scopeTargetId(s),
        });
    await AccessLedgerService.record({ ...common, changeType: 'deactivated' });

    const sessions = await _revokeSessions(id);
    const keys = await _revokeOwnedApiKeys(id);
    await LogService.log({
        adminId: req.user.id,
        action: 'ADMIN_DEACTIVATED',
        entityType: 'admin',
        entityId: id,
        details: `Deactivated admin: ${admin.username} (${admin.role}); reason: ${reason}; ${perms.length} grant(s) and ${scopes.length} scope(s) kept and flagged revoked; ${sessions} session(s) revoked; ${keys} API key(s) revoked`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
    });
    return { perms: perms.length, scopes: scopes.length, sessions, keys };
}

/**
 * "Réactiver": the explicit inverse of _deactivateAdmin. The perimeter the
 * account held when it was switched off comes back exactly (expired rows come
 * back expired — "Prolonger" renews them), the ledger gets the mirror events,
 * and the person must set a new password: nobody vouched for the old one
 * while the account was off.
 */
async function _reactivateAdmin(req, admin, reason) {
    const db = require('../config/database');
    const AccessLedgerService = require('../services/AccessLedgerService');
    const id = Number(admin.id);
    let perms = [];
    let scopes = [];
    await db.runTransaction(async () => {
        await AdminModel.update(id, {
            isActive: 1,
            deactivatedAt: null,
            deactivatedBy: null,
            deactivationReason: null,
            forcePasswordChange: true,
        });
        perms = await AdminPermissionModel.restoreAllForAdmin(id);
        scopes = await AdminScopeModel.restoreAllForAdmin(id);
    });
    const common = { adminId: id, actorAdminId: req.user && req.user.id, reason };
    for (const p of perms)
        await AccessLedgerService.record({
            ...common,
            changeType: 'grant',
            slug: p.permission,
            effectiveTo: p.expiresAt || null,
        });
    for (const s of scopes)
        await AccessLedgerService.record({
            ...common,
            changeType: 'scope_added',
            scopeType: s.scopeType,
            scopeId: AdminScopeModel._scopeTargetId(s),
            effectiveTo: s.expiresAt || null,
        });
    await AccessLedgerService.record({ ...common, changeType: 'reactivated' });
    await LogService.log({
        adminId: req.user.id,
        action: 'ADMIN_REACTIVATED',
        entityType: 'admin',
        entityId: id,
        details: `Reactivated admin: ${admin.username} (${admin.role}); reason: ${reason}; ${perms.length} grant(s) and ${scopes.length} scope(s) restored; password change forced at next login`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
    });
    return { perms: perms.length, scopes: scopes.length };
}

/** Accent/case-insensitive "contains" for the free-text filter. */
function _fold(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

/** Sort keys the console accepts. Anything else falls back to the default order. */
const LIST_SORT = Object.freeze({
    username: 'username',
    role: 'role',
    profile: 'accessProfileName',
    lastLogin: 'lastLoginAt',
    expires: 'expiresAt',
    status: 'isActive',
});

class AdminController {
    /**
     * The rows of the admin console: ONE aggregate query (no N+1) enriched
     * with the states a weekly access review asks for, then filtered / sorted
     * in memory (an admin estate is tens of rows, never thousands). Shared by
     * `index` and `exportCsv` so the file always equals the screen.
     */
    async _listRows(req) {
        const db = require('../config/database');
        const AccessReviewService = require('../services/AccessReviewService');
        const { lockoutPolicy } = require('../middleware/rateLimiter');
        const policy = await lockoutPolicy();
        const profileExpr = await AccessReviewService.accessProfileExpr();
        // `admins.access_profile` (migration 69) is REPORTING ONLY — it names
        // what the account was provisioned from and is never an authorization
        // input. Expired and revoked rows are excluded from the LIVE counts
        // exactly as the RBAC read path excludes them, and reported separately
        // (last_expired_at, revoked_count) so an expired delegation reads as
        // "expired", never as "never provisioned".
        const rows = await db.all(
            `
            SELECT ${profileExpr} AS access_profile,
                   a.id,
                   a.username,
                   a.email,
                   a.role,
                   a.is_active,
                   a.auth_provider,
                   a.deactivated_at,
                   a.deactivation_reason,
                   a.force_password_change,
                   (SELECT COUNT(*) FROM admin_permissions ap
                      WHERE ap.admin_id = a.id AND ap.revoked_at IS NULL
                        AND (ap.expires_at IS NULL OR ap.expires_at > now())) AS perm_count,
                   (SELECT string_agg(ap.permission, ',' ORDER BY ap.permission) FROM admin_permissions ap
                      WHERE ap.admin_id = a.id AND ap.revoked_at IS NULL
                        AND (ap.expires_at IS NULL OR ap.expires_at > now())) AS permissions,
                   (SELECT COUNT(*) FROM admin_scopes acs
                      WHERE acs.admin_id = a.id AND acs.revoked_at IS NULL
                        AND (acs.expires_at IS NULL OR acs.expires_at > now())) AS scope_count,
                   (SELECT COUNT(*) FROM admin_permissions ap WHERE ap.admin_id = a.id AND ap.revoked_at IS NOT NULL)
                 + (SELECT COUNT(*) FROM admin_scopes acs WHERE acs.admin_id = a.id AND acs.revoked_at IS NOT NULL) AS revoked_count,
                   (SELECT json_agg(json_build_object(
                               'type', acs.scope_type,
                               'name', COALESCE(s.name, d.name, sv.name, c.name, rg.name),
                               'unitInactive', (COALESCE(s.is_active, ds.is_active, svs.is_active, true) = false)
                           ) ORDER BY acs.scope_type)
                      FROM admin_scopes acs
                      LEFT JOIN sites       s   ON acs.scope_type = 'site'       AND acs.site_id       = s.id
                      LEFT JOIN departments d   ON acs.scope_type = 'department' AND acs.department_id = d.id
                      LEFT JOIN sites       ds  ON d.site_id = ds.id
                      LEFT JOIN services    sv  ON acs.scope_type = 'service'    AND acs.service_id    = sv.id
                      LEFT JOIN departments svd ON sv.department_id = svd.id
                      LEFT JOIN sites       svs ON svd.site_id = svs.id
                      LEFT JOIN countries   c   ON acs.scope_type = 'country'    AND acs.country_id    = c.id
                      LEFT JOIN regions     rg  ON acs.scope_type = 'region'     AND acs.region_id     = rg.id
                     WHERE acs.admin_id = a.id AND acs.revoked_at IS NULL
                       AND (acs.expires_at IS NULL OR acs.expires_at > now())) AS scopes,
                   (SELECT array_agg(DISTINCT x.sid) FROM (
                        SELECT acs.site_id AS sid FROM admin_scopes acs WHERE acs.admin_id = a.id AND acs.scope_type = 'site' AND acs.revoked_at IS NULL
                        UNION SELECT d.site_id FROM admin_scopes acs JOIN departments d ON d.id = acs.department_id WHERE acs.admin_id = a.id AND acs.scope_type = 'department' AND acs.revoked_at IS NULL
                        UNION SELECT sd.site_id FROM admin_scopes acs JOIN services sv ON sv.id = acs.service_id JOIN departments sd ON sd.id = sv.department_id WHERE acs.admin_id = a.id AND acs.scope_type = 'service' AND acs.revoked_at IS NULL
                        UNION SELECT s.id FROM admin_scopes acs JOIN sites s ON s.country_id = acs.country_id WHERE acs.admin_id = a.id AND acs.scope_type = 'country' AND acs.revoked_at IS NULL
                        UNION SELECT s.id FROM admin_scopes acs JOIN countries c ON c.region_id = acs.region_id JOIN sites s ON s.country_id = c.id WHERE acs.admin_id = a.id AND acs.scope_type = 'region' AND acs.revoked_at IS NULL
                   ) x WHERE x.sid IS NOT NULL) AS site_ids,
                   LEAST(
                       (SELECT MIN(ap.expires_at) FROM admin_permissions ap
                          WHERE ap.admin_id = a.id AND ap.revoked_at IS NULL AND ap.expires_at > now()),
                       (SELECT MIN(acs.expires_at) FROM admin_scopes acs
                          WHERE acs.admin_id = a.id AND acs.revoked_at IS NULL AND acs.expires_at > now())
                   ) AS soonest_expires_at,
                   GREATEST(
                       (SELECT MAX(ap.expires_at) FROM admin_permissions ap
                          WHERE ap.admin_id = a.id AND ap.revoked_at IS NULL AND ap.expires_at <= now()),
                       (SELECT MAX(acs.expires_at) FROM admin_scopes acs
                          WHERE acs.admin_id = a.id AND acs.revoked_at IS NULL AND acs.expires_at <= now())
                   ) AS last_expired_at,
                   EXISTS (SELECT 1 FROM mfa_secrets m
                             WHERE m.user_type = 'admin' AND m.user_id = a.id
                               AND m.confirmed_at IS NOT NULL) AS mfa_enrolled,
                   GREATEST(
                       (SELECT MAX(sl.created_at) FROM system_logs sl
                          WHERE sl.admin_id = a.id AND sl.action = 'LOGIN_SUCCESS'),
                       (SELECT MAX(la.attempted_at) FROM login_attempts la
                          WHERE lower(la.username::text) = lower(a.username::text) AND la.successful = true)
                   ) AS last_login_at,
                   (SELECT COUNT(*) FROM login_attempts la
                      WHERE lower(la.username::text) = lower(a.username::text) AND la.successful = false
                        AND la.attempted_at > now() - (? * interval '1 minute')) AS failed_attempts
              FROM admins a
             ORDER BY (a.role = 'superadmin') DESC, a.username ASC
        `,
            [policy.lockoutMinutes]
        );

        const now = Date.now();
        const expiringMs = AccessReviewService.EXPIRING_DAYS * 24 * 60 * 60 * 1000;
        const lng = _lng(req);
        const profileNameOf = (key) => {
            const p = accessProfiles.byKey(key);
            return p ? p.label[lng] : null;
        };
        const manageable = await _manageableIds(req.user, rows);

        const admins = rows.map((r) => {
            const superadmin = r.role === 'superadmin';
            const permissions = superadmin
                ? [...ALL_SLUGS]
                : String(r.permissions || '')
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
            const permCount = superadmin ? null : permissions.length;
            const scopeCount = superadmin ? null : Number(r.scopeCount || 0);
            const expiresAt = r.soonestExpiresAt ? new Date(r.soonestExpiresAt) : null;
            const lastExpiredAt = r.lastExpiredAt ? new Date(r.lastExpiredAt) : null;
            const storedProfile = accessProfiles.isProfileKey(r.accessProfile)
                ? r.accessProfile
                : null;
            const derivedProfile = superadmin
                ? null
                : AccessReviewService.matchAccessProfile(permissions);
            const profileKey = superadmin ? null : storedProfile || derivedProfile;
            const scopes = Array.isArray(r.scopes) ? r.scopes.filter((s) => s && s.name) : [];
            const failed = Number(r.failedAttempts || 0);
            return {
                ...r,
                superadmin,
                permissions,
                permCount,
                scopeCount,
                scopes,
                siteIds: Array.isArray(r.siteIds) ? r.siteIds.map(Number) : [],
                expiresAt: expiresAt ? expiresAt.toISOString() : null,
                expiringSoon: Boolean(expiresAt && expiresAt.getTime() - now <= expiringMs),
                // "Expiré le …": nothing live any more, but something WAS granted.
                lastExpiredAt: lastExpiredAt ? lastExpiredAt.toISOString() : null,
                expired: Boolean(!superadmin && !expiresAt && lastExpiredAt && permCount === 0),
                // Locked = the login guard's own rule, same policy object.
                locked: failed >= policy.maxAttempts,
                failedAttempts: failed,
                mfaEnrolled: Boolean(r.mfaEnrolled),
                lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt).toISOString() : null,
                siteInactive: scopes.some((s) => s.unitInactive),
                revokedCount: Number(r.revokedCount || 0),
                // Provisioned-from name, falling back to the bundle the live
                // grants actually match. Same rule as the access review.
                accessProfile: profileKey,
                accessProfileName: profileNameOf(profileKey),
                accessProfileDrift: Boolean(
                    !superadmin && storedProfile && derivedProfile !== storedProfile
                ),
                // The defect this page exists to surface: a perimeter with no
                // capability at all — the holder can reach nothing.
                scopedButPowerless:
                    !superadmin && permCount === 0 && scopeCount > 0 && !lastExpiredAt,
                // A delegate sees every account but may only act inside containment.
                outOfScope: manageable ? !manageable.has(Number(r.id)) : false,
            };
        });

        const summary = {
            total: admins.length,
            powerless: admins.filter(
                (a) => a.isActive && !a.superadmin && a.permCount === 0 && !a.expired
            ).length,
            scopedButPowerless: admins.filter((a) => a.isActive && a.scopedButPowerless).length,
            noScope: admins.filter(
                (a) => a.isActive && !a.superadmin && a.scopeCount === 0 && !a.expired
            ).length,
            expiring: admins.filter((a) => a.isActive && a.expiringSoon).length,
            expired: admins.filter((a) => a.isActive && a.expired).length,
            locked: admins.filter((a) => a.isActive && a.locked).length,
            noMfa: admins.filter((a) => a.isActive && !a.mfaEnrolled).length,
            siteInactive: admins.filter((a) => a.isActive && a.siteInactive).length,
            inactive: admins.filter((a) => !a.isActive).length,
            expiringDays: AccessReviewService.EXPIRING_DAYS,
            lockoutMinutes: policy.lockoutMinutes,
            maxAttempts: policy.maxAttempts,
        };

        // ---- filters — every one server-side, all composable -------------
        const q = req.query || {};
        const filters = {
            q: String(q.q || '').trim(),
            role: ['superadmin', 'localadmin', 'viewer'].includes(q.role) ? q.role : '',
            siteId: parseInt(q.siteId, 10) || '',
            profile: typeof q.profile === 'string' ? q.profile.trim() : '',
            state: typeof q.state === 'string' ? q.state.trim() : '',
        };
        const stateOf = (a) => ({
            '~powerless': a.isActive && !a.superadmin && a.permCount === 0 && !a.expired,
            '~noscope': a.isActive && !a.superadmin && a.scopeCount === 0 && !a.expired,
            '~expiring': a.isActive && a.expiringSoon,
            '~expired': a.isActive && a.expired,
            '~locked': a.isActive && a.locked,
            '~nomfa': a.isActive && !a.mfaEnrolled,
            '~siteinactive': a.isActive && a.siteInactive,
            '~inactive': !a.isActive,
        });
        let list = admins;
        if (filters.q) {
            const needle = _fold(filters.q);
            list = list.filter((a) => _fold(`${a.username} ${a.email || ''}`).includes(needle));
        }
        if (filters.role) list = list.filter((a) => a.role === filters.role);
        if (filters.siteId)
            list = list.filter((a) => a.superadmin || a.siteIds.includes(filters.siteId));
        if (filters.profile) {
            list = list.filter(
                (a) =>
                    !a.superadmin &&
                    (filters.profile === 'custom'
                        ? !a.accessProfile && a.permCount > 0
                        : a.accessProfile === filters.profile)
            );
        }
        if (filters.state) list = list.filter((a) => Boolean(stateOf(a)[filters.state]));

        // ---- sort (whitelist only) -------------------------------------------------
        const sort = sortClause(q, LIST_SORT, 'username');
        if (!sort.isDefault) {
            const prop = LIST_SORT[sort.key];
            const dir = sort.dir === 'desc' ? -1 : 1;
            const val = (a) => {
                const v = a[prop];
                if (v == null) return null;
                return typeof v === 'boolean'
                    ? Number(v)
                    : typeof v === 'string' && /^\d{4}-/.test(v)
                      ? Date.parse(v)
                      : _fold(v);
            };
            list = [...list].sort((x, y) => {
                const a = val(x);
                const b = val(y);
                if (a == null && b == null) return 0;
                if (a == null) return 1; // absent values last, both directions
                if (b == null) return -1;
                return (a < b ? -1 : a > b ? 1 : 0) * dir;
            });
        }
        return { admins: list, all: admins, summary, filters, sort, manageable, policy };
    }

    async index(req, res) {
        try {
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_manage_denied',
                        {},
                        'You do not have permission to manage admins'
                    )
                );
                return res.redirect('/dashboard');
            }
            const { admins, summary, filters, sort } = await this._listRows(req);
            const { page, perPage } = parsePage(req.query, {
                perPageOptions: [20, 50, 100, 200],
                defaultPerPage: 50,
            });
            const pager = buildPager(req.query, {
                page,
                total: admins.length,
                perPage,
                basePath: '/admins',
            });
            const items = admins.slice((pager.page - 1) * perPage, pager.page * perPage);
            // 3.23.20 (C3g): the SSO migration invitation state, as on the Accounts console.
            try {
                const inv = await require('../services/SsoInviteService').statusFor(
                    'admin',
                    items.map((a) => a.id)
                );
                for (const a of items) a.ssoInvite = inv.get(Number(a.id)) || null;
            } catch (_) {
                /* never blocks the list */
            }

            const sites = await SiteModel.findAll({}, 'name ASC');
            // 3.23.19: SuperAdmin banner — admins with no way to sign in by SSO.
            let ssoGaps = null;
            if (RBACService.isSuperAdmin(req.user)) {
                try {
                    const rd = await require('../services/AdminSsoService').readiness();
                    const n = rd.adminsWithoutSso.length + rd.adminsLocalOnly.length;
                    ssoGaps = n > 0 ? { n, enforced: rd.enforced } : null;
                } catch (_) {
                    ssoGaps = null;
                }
            }
            res.render('pages/admins/index', {
                title: _t(req, 'chrome:pt_admin_management', {}, 'Admin Management'),
                ssoGaps,
                admins: items,
                summary,
                filters,
                sort,
                sortCols: sortLinks(req.query, LIST_SORT, sort, { basePath: '/admins' }),
                pager,
                sites,
                profiles: accessProfiles.localize(_lng(req), [...ALL_SLUGS]),
                isSuper: RBACService.isSuperAdmin(req.user),
                permissionCatalog: _permissionCatalogFor(req.t),
            });
        } catch (error) {
            console.error('Admin index error:', error);
            req.flash('error', _t(req, 'flash:admin_list_load_error', {}, 'Error loading admins'));
            res.redirect('/dashboard');
        }
    }

    /**
     * CSV of the filtered console. A `manage_admins` delegate gets the
     * rows they may administer — containment, the same rule as every verb —
     * so an export can never reveal an account the screen offers no action on.
     */
    async exportCsv(req, res) {
        try {
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_manage_denied',
                        {},
                        'You do not have permission to manage admins'
                    )
                );
                return res.redirect('/dashboard');
            }
            const { admins } = await this._listRows(req);
            const rows = admins.filter((a) => !a.outOfScope);
            const T = (k, fb) => _t(req, `admin:${k}`, { defaultValue: fb }, fb);
            const yes = T('tri_yes', 'oui');
            const no = T('tri_no', 'non');
            const never = T('tri_never', 'jamais');
            const bool = (v) => (v ? yes : no);
            const date = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
            const headers = [
                T('tri_csv_account', 'Compte'),
                T('tri_csv_email', 'E-mail'),
                T('tri_csv_role', 'Rôle'),
                T('tri_csv_profile', 'Profil d’accès'),
                T('tri_csv_active', 'Actif'),
                T('adm_csv_locked', 'Verrouillé'),
                T('tri_csv_mfa', 'MFA activée'),
                T('tri_csv_perm_count', 'Nb capacités'),
                T('tri_csv_perms', 'Capacités'),
                T('tri_csv_scope_count', 'Nb périmètres'),
                T('tri_csv_scope', 'Périmètre'),
                T('tri_csv_expires', 'Expire le'),
                T('adm_csv_expired_on', 'Expiré le'),
                T('adm_csv_last_login', 'Dernière connexion'),
                T('adm_csv_deactivated', 'Désactivé le'),
                T('adm_csv_deactivation_reason', 'Motif de désactivation'),
            ];
            const catalog = new Map(_permissionCatalogFor(req.t).map((p) => [p.slug, p.label]));
            const body = rows.map((a) => [
                a.username,
                a.email || '',
                _t(req, `admin:enum_admin_role_${a.role}`, { defaultValue: a.role }, a.role),
                a.superadmin ? '' : a.accessProfileName || T('tri_profile_custom', 'Personnalisé'),
                bool(a.isActive),
                bool(a.locked),
                bool(a.mfaEnrolled),
                a.superadmin ? '' : String(a.permCount),
                a.superadmin
                    ? T('tri_all_perms', 'TOUTES (SuperAdmin)')
                    : a.permissions.map((s) => catalog.get(s) || s).join(' | '),
                a.superadmin ? '' : String(a.scopeCount),
                a.superadmin
                    ? T('tri_scope_org', 'Toute l’organisation')
                    : a.scopes.map((s) => s.name).join(' | '),
                date(a.expiresAt),
                date(a.lastExpiredAt),
                a.lastLoginAt ? new Date(a.lastLoginAt).toISOString() : never,
                date(a.deactivatedAt),
                a.deactivationReason || '',
            ]);
            return csvResponse(
                res,
                `admins-${new Date().toISOString().slice(0, 10)}.csv`,
                headers,
                body
            );
        } catch (error) {
            console.error('Admin export error:', error);
            req.flash('error', _t(req, 'flash:admin_list_load_error', {}, 'Error loading admins'));
            res.redirect('/admins');
        }
    }

    async show(req, res) {
        try {
            const { id } = req.params;
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_view_denied',
                        {},
                        'You do not have permission to view admin details'
                    )
                );
                return res.redirect('/dashboard');
            }

            // Every scope row, flagged (expired / revoked / inactive unit) — the
            // authority-only reader hides those and a re-save used to lose them.
            const admin = await AdminModel.findWithScopeHistory(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }

            const isSuper = RBACService.isSuperAdmin(req.user);
            // A delegate (non-superadmin) may not view or edit a SuperAdmin account.
            if (!isSuper && admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_manage',
                        {},
                        'Only SuperAdmins can manage SuperAdmin accounts'
                    )
                );
                return res.redirect('/admins');
            }
            // Containment: the form is not even OFFERED for an account the
            // delegate may not administer — the same refusal as every verb.
            if (await _denyIfOutOfScope(req, res, id)) return;

            const isSelf = Number(id) === Number(req.user.id);
            admin.permissions =
                admin.role === 'superadmin'
                    ? [...ALL_SLUGS]
                    : await AdminPermissionModel.findSlugsByAdminId(admin.id);

            // Scope dropdowns: SuperAdmin sees the whole org; a delegate can only
            // assign scopes within their own clearance. A DEACTIVATED site that is
            // already assigned stays selectable, flagged: the option used
            // to vanish, the row posted empty, and the save dropped the scope.
            const sites = isSuper
                ? await SiteModel.findAll({}, 'name ASC')
                : await RBACService.getFilteredSites(req.user);
            const siteIds = new Set(sites.map((s) => Number(s.id)));
            for (const sc of admin.scopes) {
                if (sc.scopeType === 'site' && sc.siteId && !siteIds.has(Number(sc.siteId))) {
                    const s = await SiteModel.findById(sc.siteId);
                    if (s) {
                        sites.push(s);
                        siteIds.add(Number(s.id));
                    }
                }
            }
            const departments = isSuper
                ? await DepartmentModel.findWithSite()
                : await RBACService.getFilteredDepartments(req.user);
            const services = isSuper
                ? await ServiceModel.findWithDepartment()
                : await RBACService.getFilteredServices(req.user);
            const countries = await _assignableCountries(req.user);
            const regions = await _assignableRegions(req.user);
            const expiry =
                admin.role === 'superadmin'
                    ? { expiresAt: null, lastExpiredAt: null, expired: false }
                    : await AdminPermissionModel.getExpiryStateForAdmin(admin.id);

            // Lock state from the login guard's own rule with the
            // exact release time, so the helpdesk can answer "until when?".
            const { lockStateFor } = require('../middleware/rateLimiter');
            const lock = await lockStateFor(admin.username);

            // MFA enrolment, sessions, access history.
            const MfaService = require('../services/MfaService');
            let mfa = { enrolled: false, confirmed: false, backupCodesLeft: 0 };
            try {
                mfa = await MfaService.status({ userType: 'admin', userId: admin.id });
            } catch (_) {
                /* table absent on old installs */
            }
            let sessions = [];
            try {
                sessions = await require('../services/SessionService').listForUser(
                    admin.id,
                    'admin'
                );
            } catch (_) {
                sessions = [];
            }
            const history = await require('../services/AccessLedgerService').history(admin.id, 40);

            // Workspace-component visibility (dashboard tabs + sidebar sections) for
            // the edit panel. Compute defaults against the admin's EXPANDED grants so
            // the shown default matches what they'll actually see at runtime.
            const workspaceComponents = require('../config/workspaceComponents');
            const { expandSlugs } = require('../config/permissions');
            const wsAdmin = {
                userType: 'admin',
                role: admin.role,
                permissions:
                    admin.role === 'superadmin' ? [...ALL_SLUGS] : expandSlugs(admin.permissions),
                workspacePrefs: admin.workspacePrefs || admin.workspace_prefs || {},
            };
            const wsComponents = workspaceComponents.describeFor(wsAdmin);

            // If this admin was promoted from an employee, surface the source record.
            let linkedEmployee = null;
            const linkedEmpId = admin.linkedEmployeeId || admin.linked_employee_id;
            if (linkedEmpId) {
                const EmployeeModel = require('../models/EmployeeModel');
                const e = await EmployeeModel.findById(linkedEmpId);
                if (e)
                    linkedEmployee = {
                        id: e.id,
                        name: `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.username,
                        username: e.username,
                    };
            }

            // A generated one-time password travels through its own flash slot
            //.
            const generatedPassword = (req.flash('adm_generated_pw') || [])[0] || null;

            res.render('pages/admins/show', {
                title: _t(
                    req,
                    'chrome:pt_admin_detail',
                    { name: admin.username },
                    `Admin: ${admin.username}`
                ),
                admin,
                isSelf,
                sites,
                departments,
                services,
                countries,
                regions,
                accessExpiresAt: expiry.expiresAt || expiry.lastExpiredAt,
                accessExpired: expiry.expired,
                lock,
                mfa,
                sessions,
                history,
                generatedPassword,
                linkedEmployee,
                permissionGroups: _permissionGroupsFor(req.user, req.t),
                accessProfileList: _accessProfilesFor(req, req.user),
                uiLang: _lng(req),
                granterIsSuper: isSuper,
                emailHasNoPublicDomain,
                wsComponents,
            });
        } catch (error) {
            console.error('Admin show error:', error);
            req.flash('error', _t(req, 'flash:admin_load_error', {}, 'Error loading admin'));
            res.redirect('/admins');
        }
    }

    async createForm(req, res) {
        try {
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_create_denied',
                        {},
                        'You do not have permission to create admins'
                    )
                );
                return res.redirect('/admins');
            }

            const isSuper = RBACService.isSuperAdmin(req.user);
            const sites = isSuper
                ? await SiteModel.findAll({ isActive: 1 }, 'name ASC')
                : await RBACService.getFilteredSites(req.user);
            const departments = isSuper
                ? await DepartmentModel.findWithSite()
                : await RBACService.getFilteredDepartments(req.user);
            const services = isSuper
                ? await ServiceModel.findWithDepartment()
                : await RBACService.getFilteredServices(req.user);
            const countries = await _assignableCountries(req.user);
            const regions = await _assignableRegions(req.user);

            res.render('pages/admins/create', {
                title: _t(req, 'chrome:pt_create_admin', {}, 'Create Admin'),
                sites,
                departments,
                services,
                countries,
                regions,
                permissionGroups: _permissionGroupsFor(req.user, req.t),
                accessProfileList: _accessProfilesFor(req, req.user),
                emailHasNoPublicDomain,
                granterIsSuper: isSuper,
            });
        } catch (error) {
            console.error('Admin create form error:', error);
            req.flash('error', _t(req, 'flash:form_load_error', {}, 'Error loading form'));
            res.redirect('/admins');
        }
    }

    async create(req, res) {
        try {
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_create_denied',
                        {},
                        'You do not have permission to create admins'
                    )
                );
                return res.redirect('/admins');
            }

            // Anti-escalation: only a SuperAdmin can mint another SuperAdmin.
            const isSuper = RBACService.isSuperAdmin(req.user);
            if (req.body.role === 'superadmin' && !isSuper) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_create',
                        {},
                        'Only SuperAdmins can create SuperAdmin accounts'
                    )
                );
                return res.redirect(keepDraft(req, '/admins/create'));
            }
            // Permissions the granter is actually allowed to hand to this role,
            // resolved through the chosen access profile.
            const resolved = _resolveGrantedPermissions(req.user, req.body.role, req.body);
            const grantedPerms = resolved.perms;
            const profileNote = _profileAuditNote(resolved.profileKey, resolved.expandedServerSide);

            // Access duration is parsed ONCE, before anything is written, and
            // fails closed: an unreadable or past end date aborts the create
            // instead of quietly becoming a permanent delegation.
            const accessExpiry = _parseExpiry(req);
            if (accessExpiry === EXPIRY_INVALID) {
                req.flash('error', _expiryError(req));
                return res.redirect(keepDraft(req, '/admins/create'));
            }

            const username = req.body.username.trim();
            const email = req.body.email?.trim();
            // A shared e-mail address is allowed (a person may hold several
            // accounts — migration 107): advise, never refuse.
            const emailAdvisory = email
                ? await require('../services/EmailAccountsService').advisory(req, email)
                : null;

            // An existing username is refused whether the account is active or
            // not: "create" used to REACTIVATE an inactive account with
            // whatever the form held, silently replacing its former perimeter.
            // Bringing an account back is the explicit "Réactiver" action.
            const existingUsername = await AdminModel.findByUsername(username);
            if (existingUsername) {
                req.flash(
                    'error',
                    existingUsername.isActive
                        ? _t(req, 'flash:username_exists', {}, 'Username already exists')
                        : _t(
                              req,
                              'flash:adm_username_exists_inactive',
                              { username },
                              `"${username}" already exists as a deactivated account. Open it and use "Reactivate" instead of creating it again.`
                          )
                );
                return res.redirect(keepDraft(req, '/admins/create'));
            }

            // ... nor an identifier that already names a PERSON. The employee side
            // already refuses a login taken by an administration account
            // (EmployeeController.setupAccount); the reciprocal check was missing,
            // so an administration account homonymous with an employee login could
            // be created — and the sign-in then answered with that account instead
            // of the person, erasing their reporting line with UNCHANGED
            // credentials (measured on a development database: a manager's review
            // queue went from their own two reports to two strangers, with 403 on
            // the detail of their own team). Giving an existing person an
            // administration access is "Grant admin access", which LINKS the two
            // accounts (admins.linked_employee_id) instead of shadowing one.
            if (await _employeeLoginExists(username)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:adm_username_is_employee_login',
                        { username },
                        `"${username}" is already an employee login. Use “Grant admin access” on that person's record instead of creating a second, unlinked account.`
                    )
                );
                return res.redirect(keepDraft(req, '/admins/create'));
            }

            // Validate password confirmation
            if (req.body.password !== req.body.passwordConfirm) {
                req.flash('error', _t(req, 'flash:pw_no_match', {}, 'Passwords do not match'));
                return res.redirect(keepDraft(req, '/admins/create'));
            }

            const result = await AuthService.createAdmin({
                username,
                email: email || null,
                password: req.body.password,
                role: req.body.role,
            });

            if (!result.success) {
                req.flash('error', result.message);
                return res.redirect(keepDraft(req, '/admins/create'));
            }

            // Scopes for a localadmin or viewer (region/country/site/department/service).
            if (req.body.role === 'localadmin' || req.body.role === 'viewer') {
                await _syncScopes(req, result.admin.id, _scopeRowsFromBody(req.body), accessExpiry);
            }

            // Persist granular permission grants (empty for superadmin/no-grants).
            await AdminPermissionModel.setForAdmin(
                result.admin.id,
                grantedPerms,
                accessExpiry,
                _grantOpts(req, resolved)
            );

            await LogService.log({
                adminId: req.user.id,
                action: 'ADMIN_CREATED',
                entityType: 'admin',
                entityId: result.admin.id,
                details: `Created admin: ${req.body.username} [${req.body.role}; ${profileNote}; perms: ${grantedPerms.join(', ') || 'none'}; expires: ${accessExpiry || 'never'}]`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            if (emailAdvisory) req.flash('warning', emailAdvisory);
            _warnImpliedReads(req, grantedPerms);
            req.flash('success', _t(req, 'flash:admin_created', {}, 'Admin created successfully'));
            res.redirect('/admins');
        } catch (error) {
            console.error('Admin create error:', error);
            let errorMessage = _t(req, 'flash:adm_create_error', {}, 'Error creating admin');
            if (
                error.code === '23505' ||
                (error.message && /duplicate key|unique constraint/i.test(error.message))
            ) {
                errorMessage = _t(req, 'flash:username_exists', {}, 'Username already exists');
            }
            req.flash('error', errorMessage);
            res.redirect(keepDraft(req, '/admins/create'));
        }
    }

    async update(req, res) {
        try {
            const { id } = req.params;
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_update_denied',
                        {},
                        'You do not have permission to update admins'
                    )
                );
                return res.redirect('/admins');
            }

            // Don't allow changing own role
            if (Number(id) === Number(req.user.id) && req.body.role !== req.user.role) {
                req.flash(
                    'error',
                    _t(req, 'flash:admin_own_role', {}, 'You cannot change your own role')
                );
                return res.redirect('/admins');
            }

            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }

            // Anti-escalation guards for delegated (non-superadmin) managers:
            //  - cannot modify an existing SuperAdmin
            //  - cannot promote anyone to SuperAdmin
            //  - cannot edit an account governing people outside their own scope
            //
            const isSuper = RBACService.isSuperAdmin(req.user);
            if (!isSuper && admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_modify',
                        {},
                        'Only SuperAdmins can modify SuperAdmin accounts'
                    )
                );
                return res.redirect('/admins');
            }
            if (!isSuper && req.body.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_assign',
                        {},
                        'Only SuperAdmins can assign the SuperAdmin role'
                    )
                );
                return res.redirect(keepDraft(req, `/admins/${id}`));
            }
            if (await _denyIfOutOfScope(req, res, id)) return;

            // Self-edit is limited to CONTACT fields. Time-bounding only
            // means something if the holder cannot move their own end date, and a
            // delegate must not widen their own grants or toggle their own state:
            // those are another administrator's decision. Anything else posted is
            // ignored and the operator is told so.
            const isSelf = Number(id) === Number(req.user.id);
            const accessEditable = !isSelf;

            const resolved = accessEditable
                ? _resolveGrantedPermissions(req.user, req.body.role, req.body)
                : null;
            const grantedPerms = resolved ? resolved.perms : null;
            const profileNote = resolved
                ? _profileAuditNote(resolved.profileKey, resolved.expandedServerSide)
                : 'self-edit: contact fields only';

            // Access duration, parsed once and fail-closed (see _parseExpiry):
            // a bad end date must never silently become a permanent grant.
            const accessExpiry = accessEditable ? _parseExpiry(req) : null;
            if (accessExpiry === EXPIRY_INVALID) {
                req.flash('error', _expiryError(req));
                return res.redirect(keepDraft(req, `/admins/${id}`));
            }

            // A shared e-mail address is allowed (a person may hold several
            // accounts — migration 107): advise when it changed to one in use.
            const email = req.body.email?.trim();
            const emailAdvisory =
                email && email !== (admin.email || '')
                    ? await require('../services/EmailAccountsService').advisory(req, email, {
                          excludeAdminId: id,
                      })
                    : null;

            // Check username uniqueness if changed
            if (req.body.username && req.body.username.trim() !== admin.username) {
                const existingUsername = await AdminModel.findByUsername(req.body.username.trim());
                if (existingUsername && Number(existingUsername.id) !== Number(id)) {
                    req.flash(
                        'error',
                        _t(req, 'flash:username_exists', {}, 'Username already exists')
                    );
                    return res.redirect(keepDraft(req, `/admins/${id}`));
                }
                // Renaming INTO a person's login opens the same hole as creating
                // one there (see create): refuse it at both doors. An account that
                // already NAMES that person (linked_employee_id) is the legitimate
                // case and keeps its own username.
                const wanted = req.body.username.trim();
                const linkedTo = admin.linkedEmployeeId || admin.linked_employee_id || null;
                if (await _employeeLoginExists(wanted, linkedTo)) {
                    req.flash(
                        'error',
                        _t(
                            req,
                            'flash:adm_username_is_employee_login',
                            { username: wanted },
                            `"${wanted}" is already an employee login. Use “Grant admin access” on that person's record instead of creating a second, unlinked account.`
                        )
                    );
                    return res.redirect(keepDraft(req, `/admins/${id}`));
                }
            }

            // Prepare update data. `isActive` is NOT written here: the account
            // state changes only through the reasoned deactivate/reactivate
            // path below.
            const updateData = {
                username: req.body.username.trim(),
                email: email || null,
            };
            if (accessEditable) updateData.role = req.body.role;

            // A state change requested through the edit form's "Actif" box goes
            // through the same reasoned path as the buttons. It needs a reason.
            const wantsActive = req.body.isActive === 'on';
            const wasActive = admin.isActive !== false && admin.isActive !== 0;
            const stateChange =
                accessEditable &&
                ('isActive' in req.body || wasActive) &&
                wantsActive !== wasActive;
            let reason = null;
            if (stateChange) {
                reason = _requireReason(req, res, keepDraft(req, `/admins/${id}`));
                if (!reason) return;
            }

            // Handle password change if provided
            let passwordChanged = false;
            if (req.body.newPassword && req.body.newPassword.trim() !== '') {
                // Validate password confirmation
                if (req.body.newPassword !== req.body.newPasswordConfirm) {
                    req.flash('error', _t(req, 'flash:pw_no_match', {}, 'Passwords do not match'));
                    return res.redirect(keepDraft(req, `/admins/${id}`));
                }

                // Validate password
                const passwordValidator = require('../utils/passwordValidator');
                const validation = passwordValidator.validate(req.body.newPassword);
                if (!validation.valid) {
                    req.flash('error', validation.errors.join(', '));
                    return res.redirect(keepDraft(req, `/admins/${id}`));
                }

                // Additional check: password should not contain username
                if (
                    req.body.newPassword
                        .toLowerCase()
                        .includes(req.body.username.trim().toLowerCase())
                ) {
                    req.flash(
                        'error',
                        _t(
                            req,
                            'flash:admin_pw_username',
                            {},
                            'Password must not contain the username'
                        )
                    );
                    return res.redirect(keepDraft(req, `/admins/${id}`));
                }

                // Hash new password
                const bcrypt = require('bcrypt');
                const passwordHash = await bcrypt.hash(req.body.newPassword, 10);

                updateData.passwordHash = passwordHash;
                updateData.passwordChangedAt = new Date().toISOString();
                // A password set by SOMEONE ELSE is not the holder's own: they
                // must choose theirs at next login, exactly like the reset button.
                if (!isSelf) updateData.forcePasswordChange = true;
                passwordChanged = true;

                // Add to password history
                const PasswordHistoryModel = require('../models/PasswordHistoryModel');
                await PasswordHistoryModel.addPassword(id, passwordHash);
            }

            await AdminModel.update(id, updateData);

            // C1c (3.23.20): promoted TO SuperAdmin → the account loses its linked
            // person (no SSO route can ever reach it through the chooser) and every
            // live session of it ends (an SSO-opened one included). The database
            // trigger of migration 153 nulls the link too (defence in depth).
            const promotedToSuper =
                accessEditable && req.body.role === 'superadmin' && admin.role !== 'superadmin';
            let promotedSessions = 0;
            if (promotedToSuper) {
                await require('../config/database').run(
                    'UPDATE admins SET linked_employee_id = NULL WHERE id = ?',
                    [Number(id)]
                );
                promotedSessions = await _revokeSessions(id, null);
            }

            // Either password path invalidates the target's other sessions at once
            //: a device still holding the old session is a device the
            // password change was meant to lock out.
            let killedSessions = promotedSessions;
            if (passwordChanged && !promotedToSuper)
                killedSessions = await _revokeSessions(id, isSelf ? req.sessionID : null);

            let scopeDelta = null;
            if (accessEditable) {
                // Scopes for a localadmin or viewer, diff-based (see _syncScopes);
                // a superadmin holds everything implicitly and keeps no scope rows.
                if (req.body.role === 'localadmin' || req.body.role === 'viewer') {
                    scopeDelta = await _syncScopes(
                        req,
                        id,
                        _scopeRowsFromBody(req.body),
                        accessExpiry
                    );
                } else {
                    await AdminScopeModel.deleteByAdminId(id, { actorAdminId: req.user.id });
                }

                // Replace permission grants. For superadmin this clears the table
                // (they hold everything implicitly); otherwise store the sanitized set.
                await AdminPermissionModel.setForAdmin(
                    id,
                    grantedPerms,
                    accessExpiry,
                    _grantOpts(req, resolved)
                );
            }

            let stateNote = '';
            if (stateChange) {
                const fresh = await AdminModel.findById(id);
                if (wantsActive) {
                    const r = await _reactivateAdmin(req, fresh, reason);
                    stateNote = `; reactivated (${r.perms} grant(s), ${r.scopes} scope(s) restored)`;
                } else {
                    const r = await _deactivateAdmin(req, fresh, reason);
                    stateNote = `; deactivated (${r.perms} grant(s), ${r.scopes} scope(s) flagged; ${r.sessions} session(s), ${r.keys} API key(s) revoked)`;
                }
            }

            await LogService.log({
                adminId: req.user.id,
                action: 'ADMIN_UPDATED',
                entityType: 'admin',
                entityId: id,
                details: `Updated admin: ${req.body.username} [${accessEditable ? req.body.role : admin.role}; ${profileNote}; perms: ${grantedPerms ? grantedPerms.join(', ') || 'none' : 'unchanged'}; expires: ${accessEditable ? accessExpiry || 'never' : 'unchanged'}${scopeDelta ? `; scopes +${scopeDelta.added}/-${scopeDelta.removed}/=${scopeDelta.kept}` : ''}${passwordChanged ? `; password changed, ${killedSessions} session(s) revoked` : ''}${promotedToSuper ? `; promoted to SuperAdmin: linked person removed, ${promotedSessions} session(s) revoked` : ''}${stateNote}]`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            if (emailAdvisory) req.flash('warning', emailAdvisory);
            if (
                isSelf &&
                (req.body.permissions ||
                    req.body.scopes ||
                    req.body.accessDurationMode ||
                    'isActive' in req.body)
            ) {
                req.flash(
                    'warning',
                    _t(
                        req,
                        'flash:adm_self_edit_limited',
                        {},
                        'Only your username, e-mail and password were saved. Your role, scope, capabilities, access duration and state can only be changed by another administrator.'
                    )
                );
            }
            if (grantedPerms) _warnImpliedReads(req, grantedPerms);
            req.flash('success', _t(req, 'flash:admin_updated', {}, 'Admin updated successfully'));
            res.redirect('/admins');
        } catch (error) {
            console.error('Admin update error:', error);
            req.flash('error', _t(req, 'flash:admin_update_error', {}, 'Error updating admin'));
            res.redirect('/admins');
        }
    }

    async resetPassword(req, res) {
        try {
            const { id } = req.params;
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_pw_reset_denied',
                        {},
                        'You do not have permission to reset admin passwords'
                    )
                );
                return res.redirect('/admins');
            }

            // Don't allow resetting own password this way
            if (Number(id) === Number(req.user.id)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_pw_reset_self',
                        {},
                        'You cannot reset your own password. Please use Change Password instead.'
                    )
                );
                return res.redirect(`/admins/${id}`);
            }

            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }

            // A delegate cannot reset a SuperAdmin's password.
            if (!RBACService.isSuperAdmin(req.user) && admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_pw_reset',
                        {},
                        'Only SuperAdmins can reset a SuperAdmin password'
                    )
                );
                return res.redirect('/admins');
            }

            // Containment check — see _canManageTargetAdmin. Capability alone let a
            // scoped delegate take over a WIDER-scoped peer's account and inherit its reach.
            if (await _denyIfOutOfScope(req, res, id)) return;

            // The SuperAdmin may CHOOSE the new password (validated against the
            // password policy); if left blank, a strong random one is generated.
            const chosen = (req.body.newPassword || '').trim();
            let securePassword;
            let wasChosen = false;
            if (chosen) {
                const passwordValidator = require('../utils/passwordValidator');
                const v = passwordValidator.validate(chosen);
                if (!v.valid) {
                    req.flash(
                        'error',
                        _t(
                            req,
                            'flash:admin_pw_policy',
                            { errors: v.errors.join('; ') },
                            'Password does not meet policy: ' + v.errors.join('; ')
                        )
                    );
                    return res.redirect(`/admins/${id}`);
                }
                securePassword = chosen;
                wasChosen = true;
            } else {
                const crypto = require('crypto');
                const randomPassword = crypto.randomBytes(12).toString('base64').slice(0, 16);
                securePassword = `${randomPassword}Aa1!`; // satisfies complexity
            }

            // Hash the password
            const bcrypt = require('bcrypt');
            const passwordHash = await bcrypt.hash(securePassword, 10);

            // Update admin password and force a change at next login (the target
            // did not choose this password themselves).
            await AdminModel.update(id, {
                passwordHash,
                passwordChangedAt: new Date().toISOString(),
                forcePasswordChange: true,
            });

            // Add to password history
            const PasswordHistoryModel = require('../models/PasswordHistoryModel');
            await PasswordHistoryModel.addPassword(id, passwordHash);

            // Force the target admin off every device — their old password is dead.
            const killed = await _revokeSessions(id);

            await LogService.log({
                adminId: req.user.id,
                action: 'ADMIN_PASSWORD_RESET',
                entityType: 'admin',
                entityId: id,
                details: `Reset password for admin: ${admin.username} (${wasChosen ? 'chosen by superadmin' : 'random'}); ${killed} active session(s) revoked`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            if (wasChosen) {
                req.flash(
                    'success',
                    _t(
                        req,
                        'flash:admin_pw_updated',
                        { username: admin.username },
                        `Password updated for ${admin.username}. They will be required to change it at next login.`
                    )
                );
            } else {
                // The one-time password is shown ONCE, in a copyable field on the
                // detail page (its own flash slot), never inside an escaped HTML flash.
                req.flash(
                    'success',
                    _t(
                        req,
                        'flash:adm_pw_generated',
                        { username: admin.username },
                        `Password reset for ${admin.username}. Hand over the one-time password shown below securely; they must change it at next login.`
                    )
                );
                req.flash('adm_generated_pw', securePassword);
            }
            res.redirect(`/admins/${id}`);
        } catch (error) {
            console.error('Admin password reset error:', error);
            req.flash(
                'error',
                _t(req, 'flash:admin_pw_reset_error', {}, 'Error resetting password')
            );
            res.redirect('/admins');
        }
    }

    /**
     * Unlock a locked admin account. The lockout is count-based (failed rows in
     * login_attempts within the lockout window, enforced by checkAccountLockout);
     * clearing those rows lets the admin sign in immediately. Also nulls any legacy
     * locked_until timestamp. Same guards as resetPassword (manage_admins, and only
     * a SuperAdmin may act on a SuperAdmin). Reachable from the list row.
     */
    async unlockAccount(req, res) {
        try {
            const { id } = req.params;
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_manage_denied',
                        {},
                        'You do not have permission to manage admin accounts'
                    )
                );
                return res.redirect('/admins');
            }
            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }
            if (!RBACService.isSuperAdmin(req.user) && admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_manage',
                        {},
                        'Only SuperAdmins can manage a SuperAdmin account'
                    )
                );
                return res.redirect('/admins');
            }

            // Containment check — see _canManageTargetAdmin. Capability alone let a
            // scoped delegate take over a WIDER-scoped peer's account and inherit its reach.
            if (await _denyIfOutOfScope(req, res, id)) return;

            const LoginAttemptModel = require('../models/LoginAttemptModel');
            // Failed-attempt rows are stored under the canonical lowercased username
            // (canonicalLoginKey), so an admin whose username has uppercase letters
            // (e.g. "Jdoe") would otherwise not be matched and stay locked. Lowercase
            // to hit the stored rows.
            try {
                await LoginAttemptModel.clearFailedAttempts(String(admin.username).toLowerCase());
            } catch (e) {
                console.error('clearFailedAttempts failed:', e.message);
            }
            // Clear any legacy timed lock as well.
            if (admin.lockedUntil) {
                await AdminModel.update(id, { lockedUntil: null });
            }

            await LogService.log({
                adminId: req.user.id,
                action: 'ADMIN_ACCOUNT_UNLOCKED',
                entityType: 'admin',
                entityId: id,
                details: `Unlocked admin account: ${admin.username} (cleared failed-login lockout)`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash(
                'success',
                _t(
                    req,
                    'flash:admin_unlocked',
                    { username: admin.username },
                    `Account unlocked for ${admin.username}. They can sign in now.`
                )
            );
            res.redirect(_returnTo(req, id));
        } catch (error) {
            console.error('Admin unlock error:', error);
            req.flash(
                'error',
                _t(req, 'flash:admin_unlock_error', {}, 'Error unlocking the account')
            );
            res.redirect('/admins');
        }
    }

    /**
     * Flag the target admin to set a NEW password at their next login
     * (force_password_change) WITHOUT changing their current password, and revoke
     * their sessions so the flag takes effect immediately. Cannot target self here
     * (use Change Password). Same guards as resetPassword.
     */
    async forcePasswordChange(req, res) {
        try {
            const { id } = req.params;
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_manage_denied',
                        {},
                        'You do not have permission to manage admin accounts'
                    )
                );
                return res.redirect('/admins');
            }
            if (Number(id) === Number(req.user.id)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_force_pw_self',
                        {},
                        'You cannot force a password change on your own account here. Use Change Password instead.'
                    )
                );
                return res.redirect(`/admins/${id}`);
            }
            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }
            if (!RBACService.isSuperAdmin(req.user) && admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_manage',
                        {},
                        'Only SuperAdmins can manage a SuperAdmin account'
                    )
                );
                return res.redirect('/admins');
            }

            // Containment check — see _canManageTargetAdmin. Capability alone let a
            // scoped delegate take over a WIDER-scoped peer's account and inherit its reach.
            if (await _denyIfOutOfScope(req, res, id)) return;

            await AdminModel.update(id, { forcePasswordChange: true });
            // Sign them out everywhere so the flag is enforced on their next login.
            const killed = await _revokeSessions(id);

            await LogService.log({
                adminId: req.user.id,
                action: 'ADMIN_FORCE_PASSWORD_CHANGE',
                entityType: 'admin',
                entityId: id,
                details: `Flagged admin for forced password change: ${admin.username}; ${killed} active session(s) revoked`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash(
                'success',
                _t(
                    req,
                    'flash:admin_force_pw_set',
                    { username: admin.username },
                    `${admin.username} will be required to set a new password at next login.`
                )
            );
            res.redirect(`/admins/${id}`);
        } catch (error) {
            console.error('Admin force-password-change error:', error);
            req.flash(
                'error',
                _t(req, 'flash:admin_force_pw_error', {}, 'Error updating the account')
            );
            res.redirect('/admins');
        }
    }

    /**
     * Set which workspace components (dashboard tabs + sidebar sections) a given
     * admin sees. SuperAdmin-only. Stores a JSONB deviation map on the admin; absent
     * keys fall back to the permission-aware default. Does not change permissions.
     */
    async updateWorkspace(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.isSuperAdmin(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_ws_denied',
                        {},
                        'Only SuperAdmins can configure an admin workspace'
                    )
                );
                return res.redirect(`/admins/${id}`);
            }
            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }

            const workspaceComponents = require('../config/workspaceComponents');
            const prefs = workspaceComponents.buildPrefsFromForm(req.body.ws || {});
            const db = require('../config/database');
            // Explicit ::jsonb cast + JSON string — avoids the camelCase/JSONB param
            // ambiguity in the generic query translator.
            await db
                ._client()
                .query('UPDATE admins SET workspace_prefs = $1::jsonb WHERE id = $2', [
                    JSON.stringify(prefs),
                    Number(id),
                ]);

            await LogService.log({
                adminId: req.user.id,
                action: 'ADMIN_WORKSPACE_UPDATED',
                entityType: 'admin',
                entityId: id,
                details: `Updated workspace components for ${admin.username}: ${Object.keys(prefs).length} explicit override(s)`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash(
                'success',
                _t(
                    req,
                    'flash:admin_ws_updated',
                    { username: admin.username },
                    `Workspace components updated for ${admin.username}. They apply the next time they load their workspace.`
                )
            );
            res.redirect(`/admins/${id}`);
        } catch (error) {
            console.error('Admin workspace update error:', error);
            req.flash(
                'error',
                _t(req, 'flash:admin_ws_error', {}, 'Error updating workspace components')
            );
            res.redirect('/admins');
        }
    }

    /**
     * "Prolonger de 12 mois" — one-click re-certification of a delegated account.
     *
     * Access is deliberately time-bound, which means every delegation eventually
     * lapses and someone must renew it. Doing that through the edit form means
     * re-submitting the whole account (role, scopes, 29 checkboxes) just to move a
     * date — the kind of friction that makes operators grant permanent access
     * instead. This action moves ONLY the end date.
     *
     * Capability and scope are re-stamped in ONE transaction: renewing grants but
     * not scopes (or vice-versa) leaves an account that is neither live nor
     * revoked, and a partial failure here would be invisible until someone
     * complained they could not work.
     */
    async extendAccess(req, res) {
        const EXTEND_MONTHS = 12;
        try {
            const { id } = req.params;
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_manage_denied',
                        {},
                        'You do not have permission to manage admin accounts'
                    )
                );
                return res.redirect('/admins');
            }
            // No self-renewal. Time-bounding delegated access only means anything
            // if the holder cannot keep pushing their own end date out; renewal is
            // someone else's decision, exactly like a password reset here.
            if (Number(id) === Number(req.user.id)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'admin:ap_extend_self',
                        {},
                        'You cannot extend your own access. Ask another administrator to re-certify it.'
                    )
                );
                return res.redirect(`/admins/${id}`);
            }
            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }
            if (!RBACService.isSuperAdmin(req.user) && admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_manage',
                        {},
                        'Only SuperAdmins can manage a SuperAdmin account'
                    )
                );
                return res.redirect('/admins');
            }

            // Containment check — see _canManageTargetAdmin. Capability alone let a
            // scoped delegate take over a WIDER-scoped peer's account and inherit its reach.
            if (await _denyIfOutOfScope(req, res, id)) return;
            // A SuperAdmin holds everything implicitly and is stored in neither
            // table — there is no window to extend.
            if (admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'admin:ap_extend_not_applicable',
                        {},
                        'A SuperAdmin account holds every permission implicitly — it has no access duration to extend.'
                    )
                );
                return res.redirect(`/admins/${id}`);
            }

            const r = await this._extendOne(req, admin, EXTEND_MONTHS);
            if (r.permRows === 0 && r.scopeRows === 0) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'admin:ap_extend_nothing',
                        {},
                        'This account holds no permission or scope to extend. Grant it an access profile first.'
                    )
                );
                return res.redirect(_returnTo(req, id));
            }

            req.flash(
                'success',
                _t(
                    req,
                    'admin:ap_extend_done',
                    {
                        username: admin.username,
                        date: r.shown,
                        perms: r.permRows,
                        scopes: r.scopeRows,
                    },
                    `Access for ${admin.username} now runs until ${r.shown} (${r.permRows} permission(s), ${r.scopeRows} scope(s)).`
                )
            );
            res.redirect(_returnTo(req, id));
        } catch (error) {
            console.error('Admin extend-access error:', error);
            req.flash(
                'error',
                _t(req, 'admin:ap_extend_error', {}, 'Error extending the access duration')
            );
            res.redirect(`/admins/${req.params.id}`);
        }
    }

    /** The write half of extendAccess, shared with the bulk action. */
    async _extendOne(req, admin, months) {
        const until = new Date();
        until.setMonth(until.getMonth() + months);
        const iso = until.toISOString();
        const db = require('../config/database');
        let permRows = 0;
        let scopeRows = 0;
        await db.runTransaction(async () => {
            permRows = await AdminPermissionModel.setExpiryForAdmin(admin.id, iso);
            scopeRows = await AdminScopeModel.setExpiryForAdmin(admin.id, iso);
        });
        if (permRows || scopeRows) {
            // Provenance: one ledger event for the account, not one per row.
            const AccessLedgerService = require('../services/AccessLedgerService');
            await AccessLedgerService.record({
                adminId: Number(admin.id),
                changeType: 'expiry_extended',
                effectiveTo: iso,
                actorAdminId: req.user.id,
                reason: `Re-certified for ${months} months`,
            });
            await LogService.log({
                adminId: req.user.id,
                action: 'ADMIN_ACCESS_EXTENDED',
                entityType: 'admin',
                entityId: admin.id,
                details: `Extended access for ${admin.username} by ${months} months → ${iso} (${permRows} grant row(s), ${scopeRows} scope row(s))`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        }
        const shown = until.toLocaleDateString(_lng(req) === 'en' ? 'en-GB' : 'fr-FR', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        return { permRows, scopeRows, iso, shown };
    }

    /**
     * "Désactiver" with a mandatory reason. Replaces "Supprimer":
     * grants and scopes are kept and flagged, sessions and API keys revoked,
     * ledger events written with the reason — see _deactivateAdmin.
     */
    async deactivate(req, res) {
        try {
            const { id } = req.params;
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_delete_denied',
                        {},
                        'You do not have permission to deactivate admins'
                    )
                );
                return res.redirect('/admins');
            }
            if (Number(id) === Number(req.user.id)) {
                req.flash(
                    'error',
                    _t(req, 'flash:admin_delete_self', {}, 'You cannot deactivate your own account')
                );
                return res.redirect('/admins');
            }
            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }
            if (!RBACService.isSuperAdmin(req.user) && admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_delete',
                        {},
                        'Only SuperAdmins can deactivate a SuperAdmin'
                    )
                );
                return res.redirect('/admins');
            }
            if (await _denyIfOutOfScope(req, res, id)) return;
            if (admin.isActive === false || admin.isActive === 0) {
                req.flash(
                    'warning',
                    _t(
                        req,
                        'flash:adm_already_inactive',
                        { username: admin.username },
                        `${admin.username} is already deactivated.`
                    )
                );
                return res.redirect(_returnTo(req, id));
            }
            const reason = _requireReason(req, res, _returnTo(req, id));
            if (!reason) return;

            const r = await _deactivateAdmin(req, admin, reason);
            req.flash(
                'success',
                _t(
                    req,
                    'flash:adm_deactivated',
                    {
                        username: admin.username,
                        perms: r.perms,
                        scopes: r.scopes,
                        sessions: r.sessions,
                    },
                    `${admin.username} deactivated: ${r.perms} capability(ies) and ${r.scopes} scope(s) kept for reactivation, ${r.sessions} session(s) closed.`
                )
            );
            res.redirect('/admins');
        } catch (error) {
            console.error('Admin deactivate error:', error);
            req.flash('error', _t(req, 'flash:admin_delete_error', {}, 'Error deactivating admin'));
            res.redirect('/admins');
        }
    }

    /** Legacy route name (`/admins/:id/delete`) — the action IS a deactivation. */
    async delete(req, res) {
        return this.deactivate(req, res);
    }

    /** "Réactiver": explicit, reasoned, restores the former perimeter, forces a password change. */
    async reactivate(req, res) {
        try {
            const { id } = req.params;
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_manage_denied',
                        {},
                        'You do not have permission to manage admin accounts'
                    )
                );
                return res.redirect('/admins');
            }
            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }
            if (!RBACService.isSuperAdmin(req.user) && admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_manage',
                        {},
                        'Only SuperAdmins can manage a SuperAdmin account'
                    )
                );
                return res.redirect('/admins');
            }
            if (await _denyIfOutOfScope(req, res, id)) return;
            if (admin.isActive !== false && admin.isActive !== 0) {
                req.flash(
                    'warning',
                    _t(
                        req,
                        'flash:adm_already_active',
                        { username: admin.username },
                        `${admin.username} is already active.`
                    )
                );
                return res.redirect(_returnTo(req, id));
            }
            const reason = _requireReason(req, res, _returnTo(req, id));
            if (!reason) return;

            const r = await _reactivateAdmin(req, admin, reason);
            req.flash(
                'success',
                _t(
                    req,
                    'flash:adm_reactivated',
                    { username: admin.username, perms: r.perms, scopes: r.scopes },
                    `${admin.username} reactivated: ${r.perms} capability(ies) and ${r.scopes} scope(s) restored. A new password is required at next login.`
                )
            );
            res.redirect(`/admins/${id}`);
        } catch (error) {
            console.error('Admin reactivate error:', error);
            req.flash('error', _t(req, 'flash:admin_update_error', {}, 'Error updating admin'));
            res.redirect('/admins');
        }
    }

    /**
     * MFA reset — SuperAdmin only, mandatory reason, audited, sessions
     * revoked. The self-service "disable" demands a valid code, which is exactly
     * what a person who lost their phone and backup codes cannot produce.
     */
    async resetMfa(req, res) {
        try {
            const { id } = req.params;
            if (!RBACService.isSuperAdmin(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:adm_mfa_reset_denied',
                        {},
                        'Only a SuperAdmin can reset another administrator’s two-factor authentication.'
                    )
                );
                return res.redirect(`/admins/${id}`);
            }
            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }
            // C2c (3.23.20): a SuperAdmin may reset ANOTHER SuperAdmin's MFA
            // (peer reset, audited, alerted) — never their own: that would let a
            // stolen session strip the second factor of the account it rides.
            if (Number(id) === Number(req.user.id)) {
                await LogService.log({
                    adminId: req.user.id,
                    action: 'MFA_RESET_REFUSED',
                    entityType: 'admin',
                    entityId: id,
                    category: 'security',
                    details:
                        'self_reset_forbidden: an administrator cannot reset their own two-factor authentication',
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                }).catch(() => {});
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:adm_mfa_reset_self',
                        {},
                        'Vous ne pouvez pas réinitialiser votre propre double authentification : demandez-le à un autre super administrateur.'
                    )
                );
                return res.redirect(`/admins/${id}`);
            }
            const reason = _requireReason(req, res, `/admins/${id}`);
            if (!reason) return;

            const MfaService = require('../services/MfaService');
            const r = await MfaService.adminReset({ userType: 'admin', userId: Number(id) });
            if (admin.role === 'superadmin')
                require('../services/SuperadminAlertService')
                    .alert('security.superadmin_mfa_changed', {
                        targetAdminId: Number(id),
                        username: admin.username,
                        detail: `reset by SuperAdmin ${req.user.username || req.user.id} (peer reset)`,
                    })
                    .catch(() => {});
            const killed = await _revokeSessions(
                id,
                Number(id) === Number(req.user.id) ? req.sessionID : null
            );
            await LogService.log({
                adminId: req.user.id,
                action: 'MFA_RESET_BY_ADMIN',
                entityType: 'admin',
                entityId: id,
                category: 'security',
                details: `MFA reset for admin ${admin.username} by SuperAdmin; reason: ${reason}; secret ${r.hadSecret ? 'removed' : 'absent'}, ${r.backupCodesRemoved} backup code(s) removed, ${killed} session(s) revoked; re-enrolment required`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash(
                'success',
                _t(
                    req,
                    'flash:adm_mfa_reset_done',
                    { username: admin.username },
                    `Two-factor authentication reset for ${admin.username}: they will enrol again at their next sign-in.`
                )
            );
            res.redirect(`/admins/${id}`);
        } catch (error) {
            console.error('Admin MFA reset error:', error);
            req.flash('error', _t(req, 'flash:admin_update_error', {}, 'Error updating admin'));
            res.redirect(`/admins/${req.params.id}`);
        }
    }

    /** Close every session of one admin — incident response in one click. */
    async revokeSessions(req, res) {
        try {
            const { id } = req.params;
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_manage_denied',
                        {},
                        'You do not have permission to manage admin accounts'
                    )
                );
                return res.redirect('/admins');
            }
            const admin = await AdminModel.findById(id);
            if (!admin) {
                req.flash('error', _t(req, 'flash:admin_not_found', {}, 'Admin not found'));
                return res.redirect('/admins');
            }
            if (!RBACService.isSuperAdmin(req.user) && admin.role === 'superadmin') {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_sa_manage',
                        {},
                        'Only SuperAdmins can manage a SuperAdmin account'
                    )
                );
                return res.redirect('/admins');
            }
            if (await _denyIfOutOfScope(req, res, id)) return;

            const isSelf = Number(id) === Number(req.user.id);
            const killed = await _revokeSessions(id, isSelf ? req.sessionID : null);
            await LogService.log({
                adminId: req.user.id,
                action: 'ADMIN_SESSIONS_REVOKED',
                entityType: 'admin',
                entityId: id,
                category: 'security',
                details: `Closed ${killed} session(s) of admin ${admin.username}${isSelf ? ' (own other devices)' : ''}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash(
                'success',
                _t(
                    req,
                    'flash:adm_sessions_revoked',
                    { username: admin.username, n: killed },
                    `${killed} session(s) of ${admin.username} closed.`
                )
            );
            res.redirect(`/admins/${id}`);
        } catch (error) {
            console.error('Admin revoke sessions error:', error);
            req.flash(
                'error',
                _t(req, 'flash:auth_sessions_signout_error', {}, 'Could not close those sessions')
            );
            res.redirect(`/admins/${req.params.id}`);
        }
    }

    /**
     * Bulk action on the selected rows: extend by 12 months, apply an
     * access profile, or deactivate — one confirmed batch, every account
     * guarded and audited individually (containment, SuperAdmin rule, self).
     * Accounts that fail a guard are skipped and named in the flash.
     */
    async bulk(req, res) {
        try {
            if (!_canManage(req.user)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:admin_manage_denied',
                        {},
                        'You do not have permission to manage admin accounts'
                    )
                );
                return res.redirect('/admins');
            }
            const action = String(req.body.action || '');
            let ids = req.body.ids;
            if (!Array.isArray(ids)) ids = ids ? [ids] : [];
            ids = [...new Set(ids.map((x) => parseInt(x, 10)).filter(Boolean))];
            if (!ids.length || !['extend', 'deactivate', 'profile'].includes(action)) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:adm_bulk_nothing',
                        {},
                        'Select at least one account and an action.'
                    )
                );
                return res.redirect('/admins');
            }
            let reason = null;
            if (action === 'deactivate') {
                reason = _requireReason(req, res, '/admins');
                if (!reason) return;
            }
            const profileKey =
                action === 'profile' &&
                accessProfiles.isProfileKey(String(req.body.profileKey || ''))
                    ? String(req.body.profileKey)
                    : null;
            if (action === 'profile' && !profileKey) {
                req.flash(
                    'error',
                    _t(
                        req,
                        'flash:adm_bulk_nothing',
                        {},
                        'Select at least one account and an action.'
                    )
                );
                return res.redirect('/admins');
            }

            const done = [];
            const skipped = [];
            for (const id of ids) {
                const admin = await AdminModel.findById(id);
                if (!admin) continue;
                const self = Number(id) === Number(req.user.id);
                const superTarget = admin.role === 'superadmin';
                if (self || superTarget || !(await _canManageTargetAdmin(req.user, id))) {
                    skipped.push(admin.username);
                    continue;
                }
                if (action === 'extend') {
                    const r = await this._extendOne(req, admin, 12);
                    if (r.permRows || r.scopeRows) done.push(admin.username);
                    else skipped.push(admin.username);
                } else if (action === 'deactivate') {
                    if (admin.isActive === false || admin.isActive === 0) {
                        skipped.push(admin.username);
                        continue;
                    }
                    await _deactivateAdmin(req, admin, reason);
                    done.push(admin.username);
                } else {
                    const profile = accessProfiles.byKey(profileKey);
                    if (!profile || admin.role !== profile.role) {
                        skipped.push(admin.username);
                        continue;
                    }
                    const perms = _sanitizePermissions(
                        req.user,
                        admin.role,
                        accessProfiles.slugsFor(profileKey)
                    );
                    const expiry = await AdminPermissionModel.getExpiryForAdmin(admin.id);
                    await AdminPermissionModel.setForAdmin(admin.id, perms, expiry, {
                        actorAdminId: req.user.id,
                        profileKey,
                        reason: 'bulk profile',
                    });
                    await LogService.log({
                        adminId: req.user.id,
                        action: 'ADMIN_UPDATED',
                        entityType: 'admin',
                        entityId: admin.id,
                        details: `Applied access profile ${profileKey} to ${admin.username} (bulk); perms: ${perms.join(', ') || 'none'}`,
                        ipAddress: req.ip,
                        userAgent: req.get('user-agent'),
                    });
                    done.push(admin.username);
                }
            }
            if (done.length)
                req.flash(
                    'success',
                    _t(
                        req,
                        `flash:adm_bulk_${action}_done`,
                        { n: done.length, who: done.join(', ') },
                        `${action}: ${done.length} account(s) processed (${done.join(', ')}).`
                    )
                );
            if (skipped.length)
                req.flash(
                    'warning',
                    _t(
                        req,
                        'flash:adm_bulk_skipped',
                        { n: skipped.length, who: skipped.join(', ') },
                        `${skipped.length} account(s) skipped (self, SuperAdmin, out of scope or nothing to do): ${skipped.join(', ')}.`
                    )
                );
            res.redirect('/admins');
        } catch (error) {
            console.error('Admin bulk action error:', error);
            req.flash('error', _t(req, 'flash:admin_update_error', {}, 'Error updating admin'));
            res.redirect('/admins');
        }
    }

    // ---- Access & identity (SSO link / revoke promoted access) -------------
    async linkSso(req, res) {
        const AccountLinkService = require('../services/AccountLinkService');
        const result = await AccountLinkService.linkSsoIdentity(
            {
                targetType: 'admin',
                targetId: parseInt(req.params.id, 10),
                provider: req.body.provider,
                externalId: req.body.externalId,
            },
            req.user
        );
        req.flash(
            result.ok ? 'success' : 'error',
            // Le service rend un CODE stable + ses parametres ; `message` n'est que
            // le dernier recours anglais d'un appelant sans traducteur.
            result.code && req.t
                ? req.t(`admin:${result.code}`, result.params || {})
                : result.message
        );
        res.redirect(`/admins/${req.params.id}`);
    }

    async unlinkSso(req, res) {
        const AccountLinkService = require('../services/AccountLinkService');
        const result = await AccountLinkService.unlinkSsoIdentity(
            { targetType: 'admin', targetId: parseInt(req.params.id, 10) },
            req.user
        );
        req.flash(
            result.ok ? 'success' : 'error',
            // Le service rend un CODE stable + ses parametres ; `message` n'est que
            // le dernier recours anglais d'un appelant sans traducteur.
            result.code && req.t
                ? req.t(`admin:${result.code}`, result.params || {})
                : result.message
        );
        res.redirect(`/admins/${req.params.id}`);
    }

    /**
     * Revoke a promoted admin's access. this used to
     * HARD-DELETE the grant and scope rows. It now goes through the same
     * revoke-and-keep path as a deactivation, and a written reason is mandatory —
     * both buttons that call it (here and on the employee page) post one.
     */
    async revokeAccess(req, res) {
        const AccountLinkService = require('../services/AccountLinkService');
        const reason = String((req.body && req.body.reason) || '').trim();
        const back = _returnTo(req, req.params.id);
        const result = await AccountLinkService.revokeAdminAccess(
            { adminId: parseInt(req.params.id, 10), hardDelete: false, reason },
            req.user
        );
        const key = `flash:adm_revoke_${result.code || (result.ok ? 'revoked' : 'failed')}`;
        req.flash(
            result.ok ? 'success' : 'error',
            _t(
                req,
                key,
                {
                    username: result.username || '',
                    perms: result.perms || 0,
                    scopes: result.scopes || 0,
                },
                result.message
            )
        );
        res.redirect(result.ok ? '/admins' : back);
    }
}

const controller = new AdminController();
// Express receives bare method references; bind the ones that call sibling
// methods through `this` (the shared _listRows / _extendOne helpers).
for (const m of ['index', 'exportCsv', 'extendAccess', 'bulk', 'delete', 'deactivate'])
    controller[m] = controller[m].bind(controller);

module.exports = controller;

// Test seam. These helpers are pure and decide whether a delegation is bounded
// or permanent, or whether a delegate may touch an account — the kind of rule
// that must be pinned by a test rather than re-derived by reading four call
// sites. Not part of the controller's HTTP API.
module.exports._internals = {
    parseExpiry: _parseExpiry,
    EXPIRY_INVALID,
    resolveGrantedPermissions: _resolveGrantedPermissions,
    scopeRowsFromBody: _scopeRowsFromBody,
    containsScope: _containsScope,
    canManageTargetAdmin: _canManageTargetAdmin,
    employeeLoginExists: _employeeLoginExists,
    LIST_SORT,
};
