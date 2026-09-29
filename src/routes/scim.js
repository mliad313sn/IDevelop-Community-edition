'use strict';

/**
 * Minimal SCIM 2.0 Users endpoint (/scim/v2/Users) so an IdP (Entra/Okta) can
 * provision and — critically — DEPROVISION (leaver offboarding) automatically.
 * Authenticated by an API key (X-API-Key or Bearer). Read + deactivate; inbound
 * PROVISIONING (POST) enqueues an onboarding request for admin placement rather than
 * creating a fully-placed employee outright — so an IdP can push new joiners while
 * the site/department/service/role placement stays governed. Maps SCIM Users ↔ employees.
 */
const express = require('express');
const router = express.Router();
const { requireApiKey, apiKeyCanWrite } = require('../middleware/apiAuth');
const db = require('../config/database');
const ah = require('../utils/asyncHandler');
const RBACService = require('../services/RBACService');
const OnboardingService = require('../services/OnboardingService');

const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';

/**
 * A SCIM write needs a key whose scope GRANTS writing.
 *
 * Every mutating route here was gated on `requireApiKey` alone, so any valid
 * key could provision and deprovision people. A read-only integration key —
 * a Power BI reporting key, say — could PATCH `active:false` and switch off
 * accounts. Scope already limited WHICH people it reached (inScope /
 * scopeFilter); nothing limited whether it could write at all.
 *
 * The refusal is SCIM-shaped, because an IdP parses these bodies.
 */
const requireScimWrite = (req, res, next) => {
    if (apiKeyCanWrite(req)) return next();
    return res.status(403).json({
        schemas: [ERR],
        status: '403',
        scimType: 'noPermission',
        detail: 'This API key is read-only — its scope does not grant write access.',
    });
};

/**
 * What a SCIM PATCH asks for `active`: false (deprovision), true (reinstate)
 * or null (nothing about it). Covers the shapes the IdPs really send:
 *   Okta:  {"op":"replace","value":{"active":false}}
 *   Entra: {"op":"Replace","path":"active","value":false}
 *   Entra without the aadOptscim062020 flag: {"op":"Replace","path":"active","value":"False"}
 * The previous test (`o.value && (o.value.active === false || o.value === false)`)
 * short-circuited on `value: false` and never matched the string "False" —
 * so an Entra leaver was NEVER deprovisioned.
 */
function scimActiveIntent(ops) {
    const asBool = (v) => {
        if (v === true || v === false) return v;
        const s = String(v == null ? '' : v)
            .trim()
            .toLowerCase();
        if (s === 'true') return true;
        if (s === 'false') return false;
        return null;
    };
    let intent = null;
    for (const o of Array.isArray(ops) ? ops : []) {
        const op = String((o && o.op) || '').toLowerCase();
        if (op !== 'replace' && op !== 'add') continue;
        const path = String((o && o.path) || '')
            .trim()
            .toLowerCase();
        if (path === 'active') {
            const b = asBool(o.value);
            if (b !== null) intent = b;
        } else if (!path && o.value && typeof o.value === 'object' && 'active' in o.value) {
            const b = asBool(o.value.active);
            if (b !== null) intent = b;
        }
    }
    return intent;
}

// Provisioned-but-not-yet-placed users (an onboarding request) are addressable
// as "pending-<requestId>", so the IdP gets the `id` SCIM requires on create
// and can later withdraw the person (PATCH active=false / DELETE).
const PENDING_RE = /^pending-(\d+)$/;
async function pendingRequest(id) {
    const m = PENDING_RE.exec(String(id || ''));
    if (!m) return null;
    return db.get(
        'SELECT id, email, first_name, last_name, status, external_id, created_employee_id FROM onboarding_requests WHERE id = ?',
        [Number(m[1])]
    );
}
function pendingToScim(r, host) {
    return {
        schemas: [SCHEMA_USER],
        id: `pending-${r.id}`,
        externalId: r.externalId || undefined,
        userName: r.email,
        name: { givenName: r.firstName || '', familyName: r.lastName || '' },
        emails: r.email ? [{ value: r.email, primary: true }] : [],
        active: false, // awaiting placement by an administrator
        meta: { resourceType: 'User', location: `${host}/scim/v2/Users/pending-${r.id}` },
    };
}
/**
 * Once an administrator has PLACED the person (request approved → employee
 * created), the id the IdP keeps ("pending-N") must reach that employee — or a
 * later deprovisioning answers 200/204 while the account stays active.
 */
function approvedEmployeeId(r) {
    const eid = r && (r.createdEmployeeId ?? r.created_employee_id);
    return r && r.status === 'approved' && eid ? Number(eid) : null;
}
async function withdrawPending(r, req) {
    const u = await db.run(
        `UPDATE onboarding_requests SET status = 'rejected', decided_at = now(),
                decision_note = 'Withdrawn by the identity provider (SCIM).'
          WHERE id = ? AND status = 'pending'`,
        [Number(r.id)]
    );
    if (!(u && u.changes)) return; // nothing withdrawn: no audit row claiming one
    try {
        await require('../services/LogService').log({
            action: 'SCIM_PENDING_WITHDRAWN',
            entityType: 'onboarding_request',
            entityId: Number(r.id),
            details: `Provisioning request #${r.id} withdrawn by SCIM (key ${req.apiKey && req.apiKey.id ? req.apiKey.id : 'n/a'})`,
        });
    } catch (_) {
        /* audit best-effort */
    }
}
// Only an unrestricted (SuperAdmin-owned) key reaches onboarding requests: they
// have no site yet, so a scoped key cannot prove it may see them.
const canSeePending = (req) => RBACService.isSuperAdmin(req.user);

function toScim(e, host) {
    return {
        schemas: [SCHEMA_USER],
        id: String(e.id),
        userName: e.email || e.employeeNumber || String(e.id),
        name: { givenName: e.firstName || '', familyName: e.lastName || '' },
        displayName: `${e.firstName || ''} ${e.lastName || ''}`.trim(),
        emails: e.email ? [{ value: e.email, primary: true }] : [],
        active: !!e.isActive,
        meta: { resourceType: 'User', location: `${host}/scim/v2/Users/${e.id}` },
    };
}

router.get(
    '/scim/v2/Users',
    requireApiKey,
    ah(async (req, res) => {
        const host = `${req.protocol}://${req.get('host')}`;
        // Scope to the API key's principal — a scoped (per-profile) key must not be
        // able to enumerate the whole org. Ownerless/superadmin keys see everyone.
        const sc = await RBACService.scopeFilter(req.user, {
            empAlias: 'e',
            includeInactive: true,
        });
        // SCIM filter: userName eq "x" (IdP looks a user up before provisioning).
        const m = /userName eq "([^"]+)"/i.exec(req.query.filter || '');
        let rows, totalResults, startIndex;
        if (m) {
            rows = await db.all(
                `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.email, e.is_active FROM employees e WHERE (lower(e.email) = lower(?) OR e.employee_number = ?) ${sc.clause}`,
                [m[1], m[1], ...sc.params]
            );
            startIndex = 1;
            totalResults = rows.length;
        } else {
            // RFC 7644 pagination: honor startIndex (1-based) → OFFSET, and report
            // totalResults as the COUNT over the whole scoped set (NOT the page size),
            // else an IdP syncing a >200-employee directory silently truncates or loops.
            const limit = Math.min(200, Math.max(1, Number(req.query.count) || 100));
            startIndex = Math.max(1, Number(req.query.startIndex) || 1);
            const offset = startIndex - 1;
            const countRow = await db.get(
                `SELECT COUNT(*) AS total FROM employees e WHERE 1=1 ${sc.clause}`,
                [...sc.params]
            );
            totalResults = Number(countRow && countRow.total) || 0;
            rows = await db.all(
                `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.email, e.is_active FROM employees e WHERE 1=1 ${sc.clause} ORDER BY e.id LIMIT ? OFFSET ?`,
                [...sc.params, limit, offset]
            );
        }
        res.json({
            schemas: [SCHEMA_LIST],
            totalResults,
            startIndex,
            itemsPerPage: rows.length,
            Resources: rows.map((e) => toScim(e, host)),
        });
    })
);

router.get(
    '/scim/v2/Users/:id',
    requireApiKey,
    ah(async (req, res) => {
        if (PENDING_RE.test(req.params.id)) {
            const r = canSeePending(req) ? await pendingRequest(req.params.id) : null;
            if (!r)
                return res
                    .status(404)
                    .json({ schemas: [ERR], status: '404', detail: 'User not found' });
            const placed = approvedEmployeeId(r);
            if (!placed) return res.json(pendingToScim(r, `${req.protocol}://${req.get('host')}`));
            req.params.id = String(placed); // → the employee it became
        }
        const sc = await RBACService.scopeFilter(req.user, {
            empAlias: 'e',
            includeInactive: true,
        });
        const e = await db.get(
            `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.email, e.is_active FROM employees e WHERE e.id = ? ${sc.clause}`,
            [Number(req.params.id), ...sc.params]
        );
        if (!e)
            return res
                .status(404)
                .json({ schemas: [ERR], status: '404', detail: 'User not found' });
        res.json(toScim(e, `${req.protocol}://${req.get('host')}`));
    })
);

// Deprovision: PATCH active:false or DELETE → the SAME leaver cascade the JML
// module runs (LifecycleService.onLeaver): employee flags, every session bucket,
// linked admin accounts + their API keys, the PII-cleanup job. This used to flip
// two employee flags and stop — reproduced by rolled-back probe: after a SCIM
// deprovision the linked admin was still is_active=true, its API key unrevoked,
// both sessions alive, no pii_cleanup job. An IdP offboarding must not be a
// weaker gate than the JML screen.
//
// Re-activate on active:true → the leaver-revert path, which refuses an ERASED
// (GDPR) or VOIDED record: SCIM PATCH active:true used to resurrect "Erased 290"
// into the headcount and behind a login. All gated to the API key's RBAC scope.
async function setActiveState(id, active, req) {
    const LifecycleService = require('../services/LifecycleService');
    const actorRef = req && req.user ? `${req.user.userType || 'admin'}:${req.user.id}` : null;
    if (!active) return LifecycleService.deprovision(id, { source: 'scim', actorRef });
    return LifecycleService.reinstate(id, { source: 'scim', adminId: null });
}
// The target must be within the key's scope (also yields 404 when out of scope).
// Scope is clearance, not headcount: a deprovisioned (inactive) user must stay
// addressable so the IdP can re-enable them, hence includeInactive.
async function inScope(req, id) {
    if (RBACService.isSuperAdmin(req.user))
        return db.get('SELECT id FROM employees WHERE id = ?', [id]);
    const emps = await RBACService.getFilteredEmployees(req.user, { includeInactive: true });
    return emps.some((e) => Number(e.id) === Number(id)) ? { id } : null;
}
function refuseReinstate(res, e) {
    if (
        e &&
        (e.code === 'erased_record_cannot_be_reinstated' ||
            e.code === 'void_record_cannot_be_reinstated')
    ) {
        return res.status(409).json({
            schemas: [ERR],
            status: '409',
            scimType: 'invalidValue',
            detail:
                e.code === 'erased_record_cannot_be_reinstated'
                    ? 'This user was erased under a data-subject request and cannot be reactivated.'
                    : 'This record was voided (created in error) and cannot be reactivated.',
        });
    }
    throw e;
}
router.patch(
    '/scim/v2/Users/:id',
    requireApiKey,
    requireScimWrite,
    ah(async (req, res) => {
        // RFC 7644 §3.5.2: a PatchOp without Operations is malformed. Answering
        // 200 would tell the IdP a deprovisioning happened when nothing did.
        if (!req.body || !Array.isArray(req.body.Operations)) {
            return res.status(400).json({
                schemas: [ERR],
                status: '400',
                scimType: 'invalidSyntax',
                detail: 'A PATCH request must carry an Operations array.',
            });
        }
        const ops = req.body.Operations;
        if (PENDING_RE.test(req.params.id)) {
            const r = canSeePending(req) ? await pendingRequest(req.params.id) : null;
            if (!r)
                return res
                    .status(404)
                    .json({ schemas: [ERR], status: '404', detail: 'User not found' });
            const placed = approvedEmployeeId(r);
            if (!placed) {
                if (scimActiveIntent(ops) === false) await withdrawPending(r, req);
                return res.json(pendingToScim(r, `${req.protocol}://${req.get('host')}`));
            }
            req.params.id = String(placed); // → deprovision the employee it became
        }
        const id = Number(req.params.id);
        if (!(await inScope(req, id)))
            return res
                .status(404)
                .json({ schemas: [ERR], status: '404', detail: 'User not found' });
        const intent = scimActiveIntent(ops);
        const wantsDisable = intent === false;
        const wantsEnable = intent === true;
        try {
            if (wantsDisable) await setActiveState(id, false, req);
            else if (wantsEnable) await setActiveState(id, true, req);
        } catch (e) {
            return refuseReinstate(res, e);
        }
        const fresh = await db.get(
            'SELECT id, employee_number, first_name, last_name, email, is_active FROM employees WHERE id = ?',
            [id]
        );
        res.json(toScim(fresh, `${req.protocol}://${req.get('host')}`));
    })
);
router.delete(
    '/scim/v2/Users/:id',
    requireApiKey,
    requireScimWrite,
    ah(async (req, res) => {
        if (PENDING_RE.test(req.params.id)) {
            const r = canSeePending(req) ? await pendingRequest(req.params.id) : null;
            if (!r)
                return res
                    .status(404)
                    .json({ schemas: [ERR], status: '404', detail: 'User not found' });
            const placed = approvedEmployeeId(r);
            if (!placed) {
                await withdrawPending(r, req);
                return res.status(204).end();
            }
            req.params.id = String(placed); // → deprovision the employee it became
        }
        const id = Number(req.params.id);
        if (!(await inScope(req, id)))
            return res
                .status(404)
                .json({ schemas: [ERR], status: '404', detail: 'User not found' });
        await setActiveState(id, false, req);
        res.status(204).end();
    })
);

// Inbound provisioning: enqueue an onboarding request (pending admin placement).
// Requires Self-Service Onboarding (SSO) to be enabled and the email domain allowed.
router.post(
    '/scim/v2/Users',
    requireApiKey,
    requireScimWrite,
    ah(async (req, res) => {
        const b = req.body || {};
        const email = String(
            b.userName || (b.emails && b.emails[0] && b.emails[0].value) || ''
        ).trim();
        const name = b.name || {};
        if (!email)
            return res
                .status(400)
                .json({ schemas: [ERR], status: '400', detail: 'userName (email) is required.' });
        // Provisioning a user as inactive is a no-op create (nothing to place).
        if (b.active === false) {
            return res.status(201).json({
                schemas: [SCHEMA_USER],
                userName: email,
                active: false,
                meta: { resourceType: 'User' },
            });
        }
        // Already an employee: SCIM's answer is 409 "uniqueness" — the IdP then
        // matches the existing user (GET ?filter=userName eq …) instead of creating.
        const existing = await db.get(
            'SELECT id FROM employees WHERE lower(email) = lower(?) ORDER BY is_active DESC, id LIMIT 1',
            [email]
        );
        if (existing) {
            // 409 "uniqueness" CONFIRMS the address belongs to somebody. That is
            // the right answer for a person this key can already see (the IdP
            // then matches them with GET ?filter=), and an existence oracle for
            // everyone else: a site-scoped key could probe the whole directory
            // (3.23.17, B-7). Out of scope ⇒ the same generic refusal whatever
            // the reason, naming nobody.
            if (!(await inScope(req, Number(existing.id)))) {
                return res.status(403).json({
                    schemas: [ERR],
                    status: '403',
                    scimType: 'noPermission',
                    detail: 'This API key cannot provision this user.',
                });
            }
            return res.status(409).json({
                schemas: [ERR],
                status: '409',
                scimType: 'uniqueness',
                detail: 'A user with this userName already exists.',
            });
        }
        const r = await OnboardingService.createFromSso({
            provider: 'scim',
            email,
            externalId: b.externalId || null,
            firstName: name.givenName,
            lastName: name.familyName,
        });
        const pend =
            r && (r.created || r.alreadyPending)
                ? await db.get(
                      "SELECT id FROM onboarding_requests WHERE lower(email) = lower(?) AND status = 'pending' ORDER BY id DESC LIMIT 1",
                      [email]
                  )
                : null;
        if (r && r.created) {
            return res.status(201).json({
                schemas: [SCHEMA_USER],
                // SCIM requires the id on create (Entra tracks the user by it).
                id: pend ? `pending-${pend.id}` : undefined,
                userName: email,
                name: { givenName: name.givenName || '', familyName: name.familyName || '' },
                active: false, // pending placement — not an active employee yet
                meta: { resourceType: 'User' },
                detail: 'Queued for admin placement (pending onboarding).',
            });
        }
        if (r && r.alreadyPending) {
            return res.status(409).json({
                schemas: [ERR],
                status: '409',
                detail: 'A provisioning request for this user is already pending placement.',
            });
        }
        // Blocked: provisioning is off or the domain is not allowed (an existing
        // account was already answered with 409 "uniqueness" above).
        return res.status(501).json({
            schemas: [ERR],
            status: '501',
            detail: 'SCIM provisioning is disabled or the email domain is not allowed. Enable Self-Service Onboarding (SSO) and allowed domains in Settings.',
        });
    })
);

module.exports = router;
module.exports.scimActiveIntent = scimActiveIntent;
