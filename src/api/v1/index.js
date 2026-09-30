'use strict';
/**
 * IDevelop — Wave 1 versioned read API (/api/v1).
 *
 * Additive, non-breaking seam alongside the EJS app (strangler-fig). It reuses
 * the same session auth + RBAC and the typed repositories. CSRF is already
 * skipped for /api/* and an API rate limiter is applied globally (server.js).
 *
 * @module api/v1
 */
const express = require('express');
const router = express.Router();
const RBACService = require('../../services/RBACService');
const appConfig = require('../../config/app');
const ApiKeyService = require('../../services/ApiKeyService');
const AdminModel = require('../../models/AdminModel');
const sso = require('../../config/sso');
const {
    SkillsRepository,
    ReadinessRepository,
    EmployeesRepository,
    TalentRepository,
    DevelopmentRepository,
    GoalsRepository,
    CheckInsRepository,
} = require('./repository');
const openapi = require('./openapi');

// Errors leave through the SAME classifier the rest of the product uses.
//
// This used to answer `{ error: 'internal_error', message: e.message }` with no
// environment gate at all, so the PostgreSQL driver's own text went straight to
// the caller: "invalid input syntax for type bigint", constraint names, relation
// names — the exact disclosure errorHandler's env gate exists to prevent, on the
// one surface that is reachable with nothing but an API key. utils/apiErrors
// already knows an internal fault from a deliberate domain refusal: internal
// becomes a generic sentence plus the request id, while a domain error keeps its
// exact wording and status, which the clients depend on.
const { toResponse, requireId } = require('../../utils/apiErrors');
const asyncH = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((e) => {
        const { status, body } = toResponse(e, req, 'api/v1');
        res.status(status).json(body);
    });

// Establish the principal. Order: (1) logged-in session; (2) a per-client API
// key from the api_keys table (hashed, revocable, scoped); (3) the legacy
// shared static key (backward compat for existing Power BI feeds). API keys
// authenticate a trusted service account (read scope). Returns JSON 401 when
// none match (never an HTML redirect).
// Constant-time compare for the legacy shared key (avoids a timing oracle).
function _safeEqual(a, b) {
    const crypto = require('crypto');
    const ab = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    if (ab.length === 0 || bb.length === 0 || ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}
const apiAuth = async (req, res, next) => {
    if (req.isAuthenticated && req.isAuthenticated() && req.user) return next();
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

    // (2a) Entra (Azure AD) JWT access token — a non-interactive auth measure via
    // passport-azure-ad. Only a JWT-shaped bearer is considered here; opaque
    // bearers fall through to the API-key path below. When Entra bearer auth is
    // not configured this whole block is skipped (isEntraBearerEnabled → false).
    if (bearer && sso.looksLikeJwt(bearer) && sso.isEntraBearerEnabled()) {
        const principal = await sso.authenticateEntraBearer(req);
        if (principal) {
            req.user = principal;
            return next();
        }
        // A JWT was presented but rejected/unlinked — it is NOT an API key, so
        // don't retry it as one; fail explicitly.
        return res.status(401).json({
            error: 'invalid_token',
            hint: 'Entra bearer token was rejected or is not linked to a IDevelop account',
        });
    }

    const key = req.headers['x-api-key'] || bearer || req.query.apiKey;
    if (key) {
        try {
            const principal = await ApiKeyService.validate(key);
            if (principal) {
                // 3.23.21 (SEC-2): a key only opens the feed its scope was issued
                // for — a safety.read (permit-to-work) key never reads /api/v1.
                const { feedScopeAllowed } = require('../../middleware/apiAuth');
                if (!feedScopeAllowed('v1', principal.scope))
                    return res.status(403).json({ error: 'insufficient_scope' });
                if (principal.ownerAdminId != null) {
                    // Per-profile key: run AS the owning admin so this read API
                    // (RBAC-scoped, like the EJS app) returns ONLY that profile's
                    // clearance. Without this the key would read the whole org.
                    const admin = await AdminModel.findWithScopes(principal.ownerAdminId);
                    if (!admin)
                        return res.status(403).json({ error: 'api key owner no longer exists' });
                    admin.userType = 'admin';
                    admin._apiKey = true;
                    admin.apiScope = principal.scope;
                    admin.isSystemApiKey = true;
                    req.user = admin;
                } else {
                    // Ownerless key = full-org system principal (legacy behaviour).
                    req.user = {
                        id: 0,
                        userType: 'admin',
                        role: 'superadmin',
                        username: 'apikey:' + principal.label,
                        _apiKey: true,
                        apiScope: principal.scope,
                    };
                }
                return next();
            }
        } catch (e) {
            /* fall through to legacy / 401 */
        }
        if (appConfig.apiKey && _safeEqual(key, appConfig.apiKey)) {
            req.user = {
                id: 0,
                userType: 'admin',
                role: 'superadmin',
                username: 'api-service',
                _apiKey: true,
                apiScope: 'legacy.shared',
            };
            return next();
        }
    }
    return res.status(401).json({
        error: 'unauthenticated',
        hint: 'use a session cookie, or X-API-Key / Authorization: Bearer <key>',
    });
};
const apiManagerOrAdmin = (req, res, next) =>
    apiAuth(req, res, () => {
        const u = req.user;
        if (u.userType === 'admin' || u.userType === 'manager') return next();
        return res.status(403).json({ error: 'forbidden' });
    });
const apiEmployeeAccess = (req, res, next) =>
    apiAuth(req, res, async () => {
        try {
            // Reject a malformed identifier BEFORE it reaches the database.
            // `parseInt('abc', 10)` is NaN, and NaN travelled all the way into a
            // bigint column, where Postgres answered "invalid input syntax for
            // type bigint" — which the wrapper above then handed to the caller.
            // The two halves were one defect; this closes the near end.
            const id = requireId(req.params.id, 'id');
            const ok = await RBACService.canAccessEmployee(req.user, id);
            if (!ok) return res.status(403).json({ error: 'forbidden' });
            return next();
        } catch (e) {
            // A deliberate refusal keeps its own status and sentence — blanket
            // 500 here would turn the new 400 "identifiant invalide" into a
            // server fault and hide the caller's own mistake from them.
            const { status, body } = toResponse(e, req, 'api/v1');
            return res.status(status).json(body);
        }
    });
// Per-key write authorization. Session users are governed by RBAC (this gate is
// a no-op for them); an API-KEY principal may WRITE only if its scope grants it.
// Read scopes (e.g. 'powerbi.read', the legacy shared key) are reject-on-write,
// so a read-only integration key can never mutate data.
// ONE definition of "may this key write", shared with the SCIM router — see
// middleware/apiAuth. It reads the scope from both principal shapes, because
// this router marks the user and that middleware marks the request.
const { apiKeyCanWrite } = require('../../middleware/apiAuth');
const apiRequireWrite = (req, res, next) =>
    apiAuth(req, res, () => {
        // A read-only Viewer never writes — through a session OR through a key that
        // borrows a viewer's clearance. This gate was a no-op for session principals
        // and the downstream check (canAccessEmployee) is clearance-only, so a scoped
        // Viewer could POST goals and check-ins.
        if (RBACService.isViewer(req.user)) {
            return res
                .status(403)
                .json({ error: 'forbidden', hint: 'read-only viewer accounts cannot write' });
        }
        if (apiKeyCanWrite(req)) return next();
        return res.status(403).json({
            error: 'forbidden',
            hint: 'this API key is read-only — its scope does not grant write access',
        });
    });

// Management endpoints require a real SUPERADMIN SESSION — never an API-key
// principal (minting keys with a key would be privilege escalation).
const apiSuperadminSession = (req, res, next) => {
    const u = req.user;
    if (
        req.isAuthenticated &&
        req.isAuthenticated() &&
        u &&
        !u._apiKey &&
        u.userType === 'admin' &&
        u.role === 'superadmin'
    )
        return next();
    return res.status(403).json({ error: 'forbidden', hint: 'superadmin session required' });
};

// ---- Discovery (public) ----------------------------------------------------
router.get('/openapi.json', (req, res) => res.json(openapi));
router.get('/', (req, res) =>
    res.json({
        name: 'IDevelop API',
        version: openapi.info.version,
        status: 'ok',
        auth: 'session cookie (same-origin); RBAC-scoped',
        openapi: '/api/v1/openapi.json',
        endpoints: [
            'GET /api/v1/skills',
            'GET /api/v1/employees',
            'GET /api/v1/readiness',
            'GET /api/v1/employees/:id/readiness',
            'GET /api/v1/employees/:id/development',
            'GET /api/v1/employees/:id/goals',
            'POST /api/v1/goals',
            'PATCH /api/v1/goals/:id/progress',
            'GET /api/v1/employees/:id/check-ins',
            'POST /api/v1/check-ins',
            'PATCH /api/v1/check-ins/:id',
            'POST /api/v1/check-ins/:id/items',
            'PATCH /api/v1/check-in-items/:id',
            'GET /api/v1/talent/ninebox',
            'GET /api/v1/certifications',
            'GET /api/v1/employees/:id/certifications',
        ],
    })
);

// ---- Resources -------------------------------------------------------------
// page: standard paginated envelope. `count` = rows in THIS page (kept for
// back-compat); `total` = full result-set size; `hasMore` lets a client page
// without the ambiguous "short page = done" heuristic.
const page = (req, data, total) => {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    return { data, count: data.length, total, offset, hasMore: offset + data.length < total };
};

router.get(
    '/skills',
    apiAuth,
    asyncH(async (req, res) => {
        // Retired skills are excluded by default, matching the JSON export. The same
        // flag drives list and count so the page contents and the reported total
        // always describe the same population.
        const includeInactive = String(req.query.includeInactive || '').toLowerCase() === 'true';
        const [data, total] = await Promise.all([
            SkillsRepository.list({
                limit: req.query.limit,
                offset: req.query.offset,
                includeInactive,
            }),
            SkillsRepository.count({ includeInactive }),
        ]);
        res.json(page(req, data, total));
    })
);

router.get(
    '/employees',
    apiManagerOrAdmin,
    asyncH(async (req, res) => {
        const [data, total] = await Promise.all([
            EmployeesRepository.list(req.user, {
                limit: req.query.limit,
                offset: req.query.offset,
            }),
            EmployeesRepository.count(req.user),
        ]);
        res.json(page(req, data, total));
    })
);

router.get(
    '/readiness',
    apiManagerOrAdmin,
    asyncH(async (req, res) => {
        const [data, total] = await Promise.all([
            ReadinessRepository.list(req.user, {
                limit: req.query.limit,
                offset: req.query.offset,
            }),
            ReadinessRepository.count(req.user),
        ]);
        res.json(page(req, data, total));
    })
);

router.get(
    '/talent/ninebox',
    apiManagerOrAdmin,
    asyncH(async (req, res) => {
        const [data, total] = await Promise.all([
            TalentRepository.nineBox(req.user, {
                limit: req.query.limit,
                offset: req.query.offset,
            }),
            TalentRepository.nineBoxCount(req.user),
        ]);
        res.json(page(req, data, total));
    })
);

// ---- Certifications / VOC (migration 56) — scoped like every other feed ----
router.get(
    '/certifications',
    apiManagerOrAdmin,
    asyncH(async (req, res) => {
        const db = require('../../config/database');
        const { scopedEmployeeIds, scopeClause } = require('../../utils/rbacScope');
        const ids = await scopedEmployeeIds(req.user);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        const status = ['valid', 'expiring', 'expired', 'no_expiry'].includes(req.query.status)
            ? req.query.status
            : null;
        const params = [];
        let where = '1 = 1';
        if (status) {
            where += ' AND cc.cert_status = ?';
            params.push(status);
        }
        where += scopeClause(ids, params, 'cc.employee_id');
        const [data, totalRow] = await Promise.all([
            db.all(
                `SELECT cc.certification_id AS "certificationId", cc.employee_id AS "employeeId", cc.full_name AS "employeeName",
                    cc.department_name AS "department", cc.skill_id AS "skillId", cc.skill_name AS "skillName",
                    cc.cert_number AS "certNumber", cc.issued_on AS "issuedOn", cc.expires_on AS "expiresOn",
                    cc.days_to_expiry AS "daysToExpiry", cc.cert_status AS "status"
               FROM v_certification_current cc WHERE ${where}
              ORDER BY cc.expires_on ASC NULLS LAST LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            ),
            db.get(
                `SELECT COUNT(*)::int AS n FROM v_certification_current cc WHERE ${where}`,
                params
            ),
        ]);
        res.json(page(req, data, totalRow.n));
    })
);
router.get(
    '/employees/:id/certifications',
    apiEmployeeAccess,
    asyncH(async (req, res) => {
        const db = require('../../config/database');
        const employeeId = parseInt(req.params.id, 10);
        const [current, history] = await Promise.all([
            db.all(
                'SELECT * FROM v_certification_current WHERE employee_id = ? ORDER BY expires_on ASC NULLS LAST',
                [employeeId]
            ),
            db.all(
                `SELECT id, skill_id AS "skillId", cert_number AS "certNumber", issued_on AS "issuedOn",
                    expires_on AS "expiresOn", is_revoked AS "isRevoked", created_at AS "createdAt"
               FROM employee_certifications WHERE employee_id = ? ORDER BY issued_on DESC`,
                [employeeId]
            ),
        ]);
        res.json({ current, history });
    })
);

router.get(
    '/employees/:id/readiness',
    apiEmployeeAccess,
    asyncH(async (req, res) => {
        const row = await ReadinessRepository.forEmployee(parseInt(req.params.id, 10));
        if (!row) return res.status(404).json({ error: 'not_found' });
        res.json({ data: row });
    })
);

router.get(
    '/employees/:id/development',
    apiEmployeeAccess,
    asyncH(async (req, res) => {
        const data = await DevelopmentRepository.forEmployee(parseInt(req.params.id, 10));
        res.json({ data });
    })
);

// ---- OKR / Goals (Wave 3) --------------------------------------------------
router.get(
    '/employees/:id/goals',
    apiEmployeeAccess,
    asyncH(async (req, res) => {
        const data = await GoalsRepository.listForEmployee(parseInt(req.params.id, 10));
        res.json({ data, count: data.length });
    })
);

router.post(
    '/goals',
    apiRequireWrite,
    asyncH(async (req, res) => {
        const b = req.body || {};
        const employeeId = parseInt(b.employeeId, 10);
        if (!employeeId || !b.title || !String(b.title).trim())
            return res.status(400).json({ error: 'employeeId and title are required' });
        const kind = b.kind || 'objective';
        if (!['objective', 'key_result'].includes(kind))
            return res.status(400).json({ error: 'invalid kind' });
        if (b.targetValue != null && !Number.isFinite(Number(b.targetValue)))
            return res.status(400).json({ error: 'targetValue must be a number' });
        if (!(await RBACService.canAccessEmployee(req.user, employeeId)))
            return res.status(403).json({ error: 'forbidden' });
        // A key result must hang off one of THIS employee's objectives — never another
        // employee's goal (FK alone doesn't enforce ownership → cross-tenant tree).
        let parentId = null;
        if (b.parentId != null) {
            parentId = parseInt(b.parentId, 10);
            const parent = await GoalsRepository.get(parentId);
            if (!parent) return res.status(400).json({ error: 'parent goal not found' });
            if (parent.employeeId !== employeeId)
                return res
                    .status(400)
                    .json({ error: 'parent goal belongs to a different employee' });
            if (parent.kind !== 'objective')
                return res.status(400).json({ error: 'parent must be an objective' });
        }
        if (kind === 'key_result' && parentId == null)
            return res.status(400).json({ error: 'a key result requires a parent objective' });
        const goal = await GoalsRepository.create({
            ...b,
            employeeId,
            kind,
            parentId,
            title: String(b.title).trim(),
            createdBy: req.user.id || null,
        });
        res.status(201).json({ data: goal });
    })
);

router.patch(
    '/goals/:id/progress',
    apiRequireWrite,
    asyncH(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const goal = await GoalsRepository.get(id);
        if (!goal) return res.status(404).json({ error: 'not_found' });
        if (!(await RBACService.canAccessEmployee(req.user, goal.employeeId)))
            return res.status(403).json({ error: 'forbidden' });
        const { currentValue, status } = req.body || {};
        if (currentValue == null && !status)
            return res.status(400).json({ error: 'currentValue or status required' });
        if (currentValue != null && !Number.isFinite(Number(currentValue)))
            return res.status(400).json({ error: 'currentValue must be a number' });
        if (status && !['active', 'at_risk', 'done', 'cancelled'].includes(status))
            return res.status(400).json({ error: 'invalid status' });
        const updated = await GoalsRepository.updateProgress(
            id,
            currentValue != null ? Number(currentValue) : goal.currentValue,
            status
        );
        res.json({ data: updated });
    })
);

// ---- Check-ins / 1-on-1s (Wave 3) -----------------------------------------
router.get(
    '/employees/:id/check-ins',
    apiEmployeeAccess,
    asyncH(async (req, res) => {
        const data = await CheckInsRepository.listForEmployee(parseInt(req.params.id, 10));
        res.json({ data, count: data.length });
    })
);

router.post(
    '/check-ins',
    apiRequireWrite,
    asyncH(async (req, res) => {
        const b = req.body || {};
        const employeeId = parseInt(b.employeeId, 10);
        if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });
        if (b.kind && !['one_on_one', 'feedback', 'pulse'].includes(b.kind))
            return res.status(400).json({ error: 'invalid kind' });
        if (b.status && !['scheduled', 'completed', 'cancelled'].includes(b.status))
            return res.status(400).json({ error: 'invalid status' });
        if (
            b.sentiment != null &&
            !(
                Number.isInteger(Number(b.sentiment)) &&
                Number(b.sentiment) >= 1 &&
                Number(b.sentiment) <= 5
            )
        )
            return res.status(400).json({ error: 'sentiment must be an integer 1..5' });
        if (!(await RBACService.canAccessEmployee(req.user, employeeId)))
            return res.status(403).json({ error: 'forbidden' });
        // Record who the 1:1 is WITH: when a manager/supervisor (an employee-typed
        // user) schedules it for one of their reports, they are the other party.
        let managerId = b.managerId != null ? parseInt(b.managerId, 10) : null;
        if (
            managerId == null &&
            req.user.userType === 'manager' &&
            Number(req.user.id) !== employeeId
        ) {
            managerId = Number(req.user.id);
        }
        const ci = await CheckInsRepository.create({
            ...b,
            employeeId,
            managerId,
            createdBy: req.user.id || null,
        });
        res.status(201).json({ data: ci });
    })
);

router.patch(
    '/check-ins/:id',
    apiRequireWrite,
    asyncH(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const ci = await CheckInsRepository.get(id);
        if (!ci) return res.status(404).json({ error: 'not_found' });
        if (!(await RBACService.canAccessEmployee(req.user, ci.employeeId)))
            return res.status(403).json({ error: 'forbidden' });
        const b = req.body || {};
        if (b.status && !['scheduled', 'completed', 'cancelled'].includes(b.status))
            return res.status(400).json({ error: 'invalid status' });
        if (
            b.sentiment != null &&
            !(
                Number.isInteger(Number(b.sentiment)) &&
                Number(b.sentiment) >= 1 &&
                Number(b.sentiment) <= 5
            )
        )
            return res.status(400).json({ error: 'sentiment must be an integer 1..5' });
        const updated = await CheckInsRepository.update(id, b);
        res.json({ data: updated });
    })
);

router.get(
    '/check-ins/:id/items',
    apiAuth,
    asyncH(async (req, res) => {
        const ci = await CheckInsRepository.get(parseInt(req.params.id, 10));
        if (!ci) return res.status(404).json({ error: 'not_found' });
        if (!(await RBACService.canAccessEmployee(req.user, ci.employeeId)))
            return res.status(403).json({ error: 'forbidden' });
        const data = await CheckInsRepository.listItems(ci.id);
        res.json({ data, count: data.length });
    })
);

router.post(
    '/check-ins/:id/items',
    apiRequireWrite,
    asyncH(async (req, res) => {
        const ci = await CheckInsRepository.get(parseInt(req.params.id, 10));
        if (!ci) return res.status(404).json({ error: 'not_found' });
        if (!(await RBACService.canAccessEmployee(req.user, ci.employeeId)))
            return res.status(403).json({ error: 'forbidden' });
        const b = req.body || {};
        if (!b.body || !String(b.body).trim())
            return res.status(400).json({ error: 'body is required' });
        const item = await CheckInsRepository.addItem(ci.id, {
            body: String(b.body).trim(),
            isAction: b.isAction,
            position: parseInt(b.position, 10),
        });
        res.status(201).json({ data: item });
    })
);

router.patch(
    '/check-in-items/:id',
    apiRequireWrite,
    asyncH(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const item = await CheckInsRepository.getItem(id);
        if (!item) return res.status(404).json({ error: 'not_found' });
        const parent = await CheckInsRepository.get(item.checkInId);
        if (!parent || !(await RBACService.canAccessEmployee(req.user, parent.employeeId)))
            return res.status(403).json({ error: 'forbidden' });
        const { done } = req.body || {};
        if (done == null) return res.status(400).json({ error: 'done (boolean) required' });
        const updated = await CheckInsRepository.setItemDone(id, !!done);
        res.json({ data: updated });
    })
);

// ---- API key management (superadmin session only) -------------------------
router.get(
    '/admin/api-keys',
    apiSuperadminSession,
    asyncH(async (req, res) => {
        const data = await ApiKeyService.list();
        res.json({ data, count: data.length });
    })
);

router.post(
    '/admin/api-keys',
    apiSuperadminSession,
    // ASVS 3.7.1: a recent sign-in or the current password (`currentPassword`).
    require('../../middleware/recentAuth').requireRecentAuth({ action: 'API key creation' }),
    asyncH(async (req, res) => {
        const { label, scope } = req.body || {};
        if (!label || !String(label).trim())
            return res.status(400).json({ error: 'label_required' });
        // SEC-2 (3.23.21): the SAME issuable list as the admin page — this endpoint
        // used to store any string, e.g. 'full', which then wrote through every
        // key-gated surface. No scope → the historical default ('powerbi.read').
        const { issuableScope } = require('../../middleware/apiAuth');
        const asked = scope == null ? '' : String(scope).trim();
        const granted = asked ? issuableScope(asked) : 'powerbi.read';
        if (!granted) return res.status(400).json({ error: 'bad_scope' });
        const k = await ApiKeyService.generate(
            {
                label: String(label).trim(),
                scope: granted,
                createdBy: req.user.id,
            },
            req
        );
        res.status(201).json({
            data: k,
            note: 'Store this key now — it is shown only once and cannot be retrieved later.',
        });
    })
);

router.delete(
    '/admin/api-keys/:id',
    apiSuperadminSession,
    asyncH(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
        await ApiKeyService.revoke(id, req);
        res.json({ status: 'revoked', id });
    })
);

module.exports = router;
module.exports.apiKeyCanWrite = apiKeyCanWrite; // exported for unit tests
