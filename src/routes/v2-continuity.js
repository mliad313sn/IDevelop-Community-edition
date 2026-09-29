'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireManagerOrAnyPermission } = require('../middleware/auth');
const ContinuityService = require('../services/ContinuityService');
const RetentionRiskService = require('../services/RetentionRiskService');
const HandoverService = require('../services/HandoverService');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');
const db = require('../config/database');
const ah = require('../utils/asyncHandler');

// The /v2/continuity mount is gated to manager/admin in routes/index.js.
// Continuity (succession + risk-of-loss) is the most sensitive data we hold, so
// we add a self-governance lockout on top of RBAC scoping.

function isAdmin(user) {
    return user && user.userType === 'admin';
}
function actorEmployeeId(user) {
    // Managers ARE employees; an admin is not an employee row.
    return user && user.userType === 'manager' ? Number(user.id) : null;
}
// The admins(id) to record for whoever is acting — see utils/actorAdminId.
// This fell back to the built-in 'admin' account for anyone who was not an
// admin, so every succession act performed by a MANAGER came back attributed
// to the system administrator: owner, nominator, reviewer. NULL beats a false
// name, and LogService still records the real actor on every one of these
// routes.
const { actorAdminId } = require('../utils/actorAdminId');

const RISK_LEVELS = ['low', 'medium', 'high'];

// ---------------------------------------------------------------------------
// WRITE GUARDS — closing a read-grant-writes bypass.
//
// The module mount in routes/index.js is an OR:
//     requireManagerOrAnyPermission('view_continuity', 'manage_succession',
//                                   'view_retention_risk', 'manage_handover')
// so `view_continuity` ALONE — declared write:false in config/permissions.js —
// was enough to get in, and every POST below then carried only requireAuth.
// A view-only continuity delegate could therefore designate critical roles,
// open succession plans and override another person's risk-of-loss rating.
// `manage_succession` was defined and never enforced anywhere.
//
// These guards enforce the WRITE slugs the catalogue already declares. Managers
// still pass unconditionally (they only ever reach their own reports, and every
// route keeps its object-level scope check on top); a local admin now needs the
// matching write grant, and a `viewer`-role admin is refused outright because
// requireManagerOrAnyPermission rejects viewers holding a write slug.
// ---------------------------------------------------------------------------
const requireSuccessionWrite = requireManagerOrAnyPermission('manage_succession');
const requireRetentionWrite = requireManagerOrAnyPermission('manage_retention_risk');
const requireHandoverWrite = requireManagerOrAnyPermission('manage_handover');

/**
 * Scope guard for a ROLE id (fixes the missing check on /criticality): a
 * non-superadmin may only designate a role that at least one person they
 * govern actually occupies. Without this, any admitted caller could re-score
 * the criticality of any role in the organisation, including roles in sites
 * they have no clearance for.
 */
async function canAccessRole(user, roleId) {
    if (RBACService.isSuperAdmin && RBACService.isSuperAdmin(user)) return true;
    const emps = await RBACService.getFilteredEmployees(user);
    return emps.some((e) => Number(e.roleId) === Number(roleId));
}

// pg hands a `date` column back as a JS Date — normalise to YYYY-MM-DD.
function ymd(v) {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    try {
        return new Date(v).toISOString().slice(0, 10);
    } catch (_) {
        return null;
    }
}

// Scope guard (fixes IDOR): a non-superadmin may only act on a plan whose
// incumbent is within their RBAC-governed set. Plans with no incumbent are
// restricted to admins. Returns true when the actor may touch the plan.
async function canAccessPlan(user, planId) {
    if (RBACService.isSuperAdmin && RBACService.isSuperAdmin(user)) return true;
    const plan = await db.get('SELECT incumbent_employee_id FROM succession_plans WHERE id = ?', [
        Number(planId),
    ]);
    if (!plan) return false;
    if (plan.incumbentEmployeeId == null) return isAdmin(user); // no incumbent → admins only
    const emps = await RBACService.getFilteredEmployees(user);
    return emps.some((e) => Number(e.id) === Number(plan.incumbentEmployeeId));
}
async function canAccessPlanBySuccessor(user, successorId) {
    const s = await db.get('SELECT plan_id FROM successors WHERE id = ?', [Number(successorId)]);
    if (!s) return false;
    return canAccessPlan(user, s.planId);
}
async function canAccessHandover(user, handoverId) {
    if (RBACService.isSuperAdmin && RBACService.isSuperAdmin(user)) return true;
    const h = await db.get('SELECT outgoing_employee_id FROM handover_plans WHERE id = ?', [
        Number(handoverId),
    ]);
    if (!h) return false;
    const emps = await RBACService.getFilteredEmployees(user);
    return emps.some((e) => Number(e.id) === Number(h.outgoingEmployeeId));
}
async function canAccessHandoverItem(user, itemId) {
    const it = await db.get('SELECT handover_id FROM handover_items WHERE id = ?', [
        Number(itemId),
    ]);
    if (!it) return false;
    return canAccessHandover(user, it.handoverId);
}
async function inScope(user, employeeId) {
    if (RBACService.isSuperAdmin && RBACService.isSuperAdmin(user)) return true;
    const emps = await RBACService.getFilteredEmployees(user);
    return emps.some((e) => Number(e.id) === Number(employeeId));
}
function deny(res) {
    return res.status(403).json({ ok: false, error: 'Not authorized for this record' });
}

// ---- Overview --------------------------------------------------------------
router.get(
    '/',
    requireAuth,
    ah(async (req, res) => {
        // Clearance-fit: succession is the most sensitive data we hold, so a scoped
        // manager/local-admin sees ONLY the coverage + plans for their governed span
        // (superadmin unfiltered). Coverage is role-centric → scoped by the roles the
        // caller's people occupy; plans are keyed by incumbent → scoped by governed ids.
        const isSuper = RBACService.isSuperAdmin && RBACService.isSuperAdmin(req.user);
        const governed = await RBACService.getFilteredEmployees(req.user);
        const govIds = governed.map((e) => Number(e.id)).filter(Boolean);
        const govRoleIds = [...new Set(governed.map((e) => Number(e.roleId)).filter(Boolean))];
        // The coverage view is role-scoped but carries the INCUMBENT's confidential
        // retention risk; the service masks it for any incumbent outside the caller's
        // governed set and always for the caller themselves (a manager must not read
        // their own flight-risk through a role one of their reports holds). Without
        // the span it fails closed and masks every incumbent, in-span ones included.
        const coverage = await ContinuityService.listCoverage(
            isSuper ? null : govRoleIds,
            isSuper
                ? null
                : {
                      governedIds: govIds,
                      callerEmployeeId: req.user.userType !== 'admin' ? Number(req.user.id) : null,
                  }
        );
        const plans = await ContinuityService.listPlans(isSuper ? null : govIds);
        // The role pickers must offer only roles the caller may actually act on.
        // This used to be an unscoped `SELECT id, name FROM roles`, which listed
        // every role in the organisation; now that POST /criticality enforces
        // canAccessRole, an unscoped dropdown would hand a scoped manager a list of
        // choices that all answer 403.
        const roles = isSuper
            ? await db.all('SELECT id, name FROM roles ORDER BY name')
            : govRoleIds.length
              ? await db.all(
                    `SELECT id, name FROM roles WHERE id IN (${govRoleIds.map(() => '?').join(',')}) ORDER BY name`,
                    govRoleIds
                )
              : [];
        const employees = governed.map((e) => ({
            id: Number(e.id),
            name: `${e.firstName} ${e.lastName}`,
            number: e.employeeNumber || '',
        }));
        // « Commencer » queue — succession stays at zero unless something prompts a
        // leader: unscored roles, critical roles with an empty bench, plans due.
        const startHere = await ContinuityService.gettingStarted(req.user, {
            isSuper,
            govIds,
            govRoleIds,
        });
        // the page had a bare "IDevelop" <title>.
        res.render('pages/continuity/index', {
            coverage,
            plans,
            roles,
            employees,
            startHere,
            isAdmin: isAdmin(req.user),
            title: req.t ? req.t('chrome:pt_continuity') : 'Continuity & succession',
        });
    })
);

// Plans whose review date has come round (same scoping as the page).
router.get(
    '/plans-due',
    requireAuth,
    ah(async (req, res) => {
        res.json({ ok: true, list: await ContinuityService.plansDueForReview(req.user) });
    })
);

// Mark a plan reviewed: stamps who/when and moves review_due forward.
router.post(
    '/plan/:id/review',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        if (!(await canAccessPlan(req.user, req.params.id))) return deny(res);
        const row = await ContinuityService.markPlanReviewed(
            Number(req.params.id),
            await actorAdminId(req.user)
        );
        if (!row) return res.status(404).json({ ok: false, error: 'Plan not found or archived' });
        const nextDue = ymd(row.reviewDue);
        await LogService.log({
            adminId: isAdmin(req.user) ? Number(req.user.id) : null,
            action: 'succession_plan_reviewed',
            entityType: 'succession_plan',
            entityId: Number(req.params.id),
            details: `review_due -> ${nextDue || '—'}`,
            actorRef: isAdmin(req.user) ? null : `employee#${req.user && req.user.id}`,
            category: 'continuity',
        });
        res.json({ ok: true, id: row.id, reviewDue: nextDue });
    })
);

// ---- Critical-role designation --------------------------------------------
router.post(
    '/criticality',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        const roleId = Number(req.body.roleId);
        if (!roleId) return res.status(400).json({ ok: false, error: 'roleId required' });
        if (req.body.vacancyRisk && !RISK_LEVELS.includes(String(req.body.vacancyRisk))) {
            return res
                .status(400)
                .json({ ok: false, error: 'vacancyRisk must be low, medium or high' });
        }
        // Object-level authz: this route had NO scope check at all, so any caller the
        // module admitted could re-score any role in the organisation.
        if (!(await canAccessRole(req.user, roleId))) return deny(res);
        const row = await ContinuityService.setCriticality(
            roleId,
            {
                score: req.body.score,
                businessImpact: req.body.businessImpact,
                vacancyRisk: req.body.vacancyRisk,
                timeToFillDays: req.body.timeToFillDays,
                rationale: req.body.rationale,
            },
            await actorAdminId(req.user)
        );
        res.json({ ok: true, roleId: row.roleId });
    })
);

// ---- Plans -----------------------------------------------------------------
router.post(
    '/plan',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        const roleId = Number(req.body.roleId);
        if (!roleId) return res.status(400).json({ ok: false, error: 'roleId required' });
        const incumbentEmployeeId = req.body.incumbentEmployeeId
            ? Number(req.body.incumbentEmployeeId)
            : null;
        // Self-succession lockout: a manager may not own the plan for their own seat.
        if (
            !isAdmin(req.user) &&
            incumbentEmployeeId &&
            incumbentEmployeeId === actorEmployeeId(req.user)
        ) {
            return res.status(403).json({
                ok: false,
                error: 'You cannot own the succession plan for your own position — this rolls up to a senior admin.',
            });
        }
        if (incumbentEmployeeId && !(await inScope(req.user, incumbentEmployeeId)))
            return deny(res);
        const plan = await ContinuityService.ensurePlan(roleId, {
            incumbentEmployeeId,
            ownerAdminId: await actorAdminId(req.user),
        });
        res.json({ ok: true, id: plan.id });
    })
);

router.post(
    '/plan/:id/incumbent',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        const incumbentEmployeeId = req.body.incumbentEmployeeId
            ? Number(req.body.incumbentEmployeeId)
            : null;
        if (
            !isAdmin(req.user) &&
            incumbentEmployeeId &&
            incumbentEmployeeId === actorEmployeeId(req.user)
        ) {
            return res.status(403).json({
                ok: false,
                error: 'You cannot set yourself as the incumbent of a plan you manage.',
            });
        }
        if (!(await canAccessPlan(req.user, req.params.id))) return deny(res);
        // A new incumbent must be within the caller's scope too — otherwise a
        // scoped caller could move a plan onto (and then read) anyone's seat.
        // Clearing the incumbent (null) stays allowed.
        if (incumbentEmployeeId && !(await inScope(req.user, incumbentEmployeeId)))
            return deny(res);
        await ContinuityService.setIncumbent(Number(req.params.id), incumbentEmployeeId);
        res.json({ ok: true });
    })
);

router.post(
    '/plan/:id/archive',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        if (!(await canAccessPlan(req.user, req.params.id))) return deny(res);
        await ContinuityService.archivePlan(Number(req.params.id));
        res.json({ ok: true });
    })
);

router.get(
    '/plan/:id',
    requireAuth,
    ah(async (req, res) => {
        if (!(await canAccessPlan(req.user, req.params.id))) return deny(res);
        const plan = await ContinuityService.getPlan(Number(req.params.id));
        if (!plan) return res.status(404).json({ ok: false, error: 'Plan not found' });
        res.json({ ok: true, plan });
    })
);

// ---- Bench / successors ----------------------------------------------------
router.post(
    '/plan/:id/seed',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        if (!(await canAccessPlan(req.user, req.params.id))) return deny(res);
        // Candidate pool = the acting user's RBAC-governed employees.
        const pool = (await RBACService.getFilteredEmployees(req.user)).map((e) => Number(e.id));
        const out = await ContinuityService.seedSuccessors(Number(req.params.id), pool, {
            floorPct: req.body.floorPct != null ? Number(req.body.floorPct) : 50,
            nominatedBy: await actorAdminId(req.user),
        });
        res.json({ ok: true, added: out.added });
    })
);

router.post(
    '/plan/:id/successor',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        const employeeId = Number(req.body.employeeId);
        if (!employeeId) return res.status(400).json({ ok: false, error: 'employeeId required' });
        if (!(await canAccessPlan(req.user, req.params.id))) return deny(res);
        // The candidate too must be someone the caller governs (3.23.17, B-6):
        // the plan check alone let a scoped caller put anyone in the
        // organisation on their bench — and read back their readiness band.
        if (!(await inScope(req.user, employeeId))) return deny(res);
        const row = await ContinuityService.addSuccessor(
            Number(req.params.id),
            employeeId,
            await actorAdminId(req.user)
        );
        res.json({ ok: true, id: row.id, readinessBand: row.readinessBand });
    })
);

router.post(
    '/successor/:id/band',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        const band = String(req.body.band || '');
        if (!['ready_now', 'ready_1_2y', 'ready_3y', 'emergency'].includes(band)) {
            return res.status(400).json({ ok: false, error: 'invalid readiness band' });
        }
        if (!(await canAccessPlanBySuccessor(req.user, req.params.id))) return deny(res);
        await ContinuityService.setSuccessorBand(Number(req.params.id), band);
        res.json({ ok: true });
    })
);

router.post(
    '/successor/:id/remove',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        if (!(await canAccessPlanBySuccessor(req.user, req.params.id))) return deny(res);
        await ContinuityService.removeSuccessor(Number(req.params.id));
        res.json({ ok: true });
    })
);

router.post(
    '/plan/:id/emergency-cover',
    requireAuth,
    requireSuccessionWrite,
    ah(async (req, res) => {
        const employeeId = Number(req.body.employeeId);
        if (!employeeId) return res.status(400).json({ ok: false, error: 'employeeId required' });
        if (!(await canAccessPlan(req.user, req.params.id))) return deny(res);
        if (!(await inScope(req.user, employeeId))) return deny(res);
        const row = await ContinuityService.setEmergencyCover(
            Number(req.params.id),
            employeeId,
            req.body.note,
            await actorAdminId(req.user)
        );
        res.json({ ok: true, id: row.id });
    })
);

// ---- Retention / risk-of-loss ---------------------------------------------
router.get(
    '/retention',
    requireAuth,
    ah(async (req, res) => {
        const sc = await RBACService.scopeFilter(req.user, { empAlias: 'e' });
        // Self-view lockout: a manager never sees their own risk record.
        const selfId = actorEmployeeId(req.user);
        // NOT `rr.*`. `RetentionRiskService` stores the employee's exact 9-box position
        // in `risk_factors.nineBox` as an input to the impact score, and this endpoint
        // is scoped to the manager's SUB-TREE while NineBoxService only lets a manager
        // see their DIRECT reports — and only once `disclosed_to_employee` allows it.
        // Serving the raw column handed an N+2 manager a confidential placement they
        // are refused everywhere else. The key is dropped here rather than at the write
        // so the score stays reconstructible for audit.
        const list = await db.all(
            `SELECT rr.employee_id, rr.flight_risk, rr.impact_of_loss, rr.computed_score,
                rr.manual_override, rr.confidentiality, rr.owner_admin_id,
                rr.last_reviewed, rr.updated_at,
                (rr.risk_factors - 'nineBox') AS risk_factors,
                e.first_name, e.last_name, e.employee_number
         FROM retention_risk rr JOIN employees e ON e.id = rr.employee_id
         WHERE 1=1 ${sc.clause} ${selfId ? 'AND e.id <> ?' : ''}
         ORDER BY CASE rr.flight_risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                  rr.computed_score DESC NULLS LAST`,
            selfId ? [...sc.params, selfId] : sc.params
        );
        res.json({ ok: true, list });
    })
);

// Recompute PERSISTS: RetentionRiskService.computeFor does an
// INSERT ... ON CONFLICT DO UPDATE on retention_risk, refreshing the computed
// score and the review timestamps. It is therefore a write and carries the same
// guard as /override — a read-only continuity delegate must not be able to
// rewrite another person's risk-of-loss record, even via the "just refresh it"
// door. (Manual override bands are preserved by the service, but the computed
// trail and last_reviewed are not.)
router.post(
    '/retention/:employeeId/recompute',
    requireAuth,
    requireRetentionWrite,
    ah(async (req, res) => {
        const employeeId = Number(req.params.employeeId);
        if (!isAdmin(req.user) && employeeId === actorEmployeeId(req.user)) {
            return res.status(403).json({
                ok: false,
                error: 'You cannot view or recompute your own retention risk.',
            });
        }
        if (!(await inScope(req.user, employeeId))) return deny(res);
        const row = await RetentionRiskService.computeFor(employeeId, await actorAdminId(req.user));
        res.json({
            ok: true,
            flightRisk: row.flightRisk,
            impactOfLoss: row.impactOfLoss,
            computedScore: row.computedScore,
        });
    })
);

router.post(
    '/retention/:employeeId/override',
    requireAuth,
    requireRetentionWrite,
    ah(async (req, res) => {
        const employeeId = Number(req.params.employeeId);
        if (!isAdmin(req.user) && employeeId === actorEmployeeId(req.user)) {
            return res
                .status(403)
                .json({ ok: false, error: 'You cannot override your own retention risk.' });
        }
        if (
            (req.body.flightRisk && !RISK_LEVELS.includes(String(req.body.flightRisk))) ||
            (req.body.impactOfLoss && !RISK_LEVELS.includes(String(req.body.impactOfLoss)))
        ) {
            return res
                .status(400)
                .json({ ok: false, error: 'flightRisk/impactOfLoss must be low, medium or high' });
        }
        if (!(await inScope(req.user, employeeId))) return deny(res);
        const row = await RetentionRiskService.setOverride(employeeId, {
            flightRisk: req.body.flightRisk,
            impactOfLoss: req.body.impactOfLoss,
            ownerAdminId: await actorAdminId(req.user),
        });
        res.json({ ok: true, flightRisk: row.flightRisk, impactOfLoss: row.impactOfLoss });
    })
);

// ---- Knowledge handover (Phase 2) -----------------------------------------
router.get(
    '/handover',
    requireAuth,
    ah(async (req, res) => {
        let list = await HandoverService.list();
        // Scope: only handovers whose outgoing employee is in the caller's set.
        if (!(RBACService.isSuperAdmin && RBACService.isSuperAdmin(req.user))) {
            const ids = new Set(
                (await RBACService.getFilteredEmployees(req.user)).map((e) => Number(e.id))
            );
            list = list.filter((h) => ids.has(Number(h.outgoingEmployeeId)));
        }
        res.json({ ok: true, list });
    })
);

router.get(
    '/handover/:id',
    requireAuth,
    ah(async (req, res) => {
        if (!(await canAccessHandover(req.user, req.params.id))) return deny(res);
        const plan = await HandoverService.get(Number(req.params.id));
        if (!plan) return res.status(404).json({ ok: false, error: 'Handover not found' });
        res.json({ ok: true, plan });
    })
);

router.post(
    '/handover',
    requireAuth,
    requireHandoverWrite,
    ah(async (req, res) => {
        const outgoingEmployeeId = Number(req.body.outgoingEmployeeId);
        if (!outgoingEmployeeId)
            return res.status(400).json({ ok: false, error: 'outgoingEmployeeId required' });
        if (!(await inScope(req.user, outgoingEmployeeId))) return deny(res);
        const plan = await HandoverService.createManual({
            outgoingEmployeeId,
            incomingEmployeeId: req.body.incomingEmployeeId
                ? Number(req.body.incomingEmployeeId)
                : null,
            dueDate: req.body.dueDate || null,
            ownerAdminId: await actorAdminId(req.user),
        });
        res.json({ ok: true, id: plan.id });
    })
);

router.post(
    '/handover/:id/incoming',
    requireAuth,
    requireHandoverWrite,
    ah(async (req, res) => {
        if (!(await canAccessHandover(req.user, req.params.id))) return deny(res);
        await HandoverService.setIncoming(
            Number(req.params.id),
            req.body.incomingEmployeeId ? Number(req.body.incomingEmployeeId) : null
        );
        res.json({ ok: true });
    })
);

router.post(
    '/handover/:id/item',
    requireAuth,
    requireHandoverWrite,
    ah(async (req, res) => {
        if (!(await canAccessHandover(req.user, req.params.id))) return deny(res);
        const row = await HandoverService.addItem(Number(req.params.id), {
            title: req.body.title,
            detail: req.body.detail,
            kind: req.body.kind || 'knowledge',
        });
        res.json({ ok: true, id: row.id });
    })
);

router.post(
    '/handover/item/:id/status',
    requireAuth,
    requireHandoverWrite,
    ah(async (req, res) => {
        const status = String(req.body.status || '');
        if (!['open', 'in_progress', 'completed', 'cancelled'].includes(status)) {
            return res.status(400).json({ ok: false, error: 'invalid status' });
        }
        if (!(await canAccessHandoverItem(req.user, req.params.id))) return deny(res);
        await HandoverService.setItemStatus(Number(req.params.id), status);
        res.json({ ok: true });
    })
);

router.post(
    '/handover/:id/status',
    requireAuth,
    requireHandoverWrite,
    ah(async (req, res) => {
        const status = String(req.body.status || '');
        if (!['open', 'in_progress', 'completed', 'cancelled'].includes(status)) {
            return res.status(400).json({ ok: false, error: 'invalid status' });
        }
        if (!(await canAccessHandover(req.user, req.params.id))) return deny(res);
        // A handover may only be COMPLETED once its knowledge items are settled.
        // Accepting it regardless dropped the plan out of listDue, so the weekly tick
        // never chased it again and the knowledge left with the person.
        const r = await HandoverService.setStatus(Number(req.params.id), status);
        if (r && r.ok === false) {
            return res.status(409).json({
                ok: false,
                error: `${r.openItems} knowledge item(s) are still open — close or cancel them before completing this handover.`,
                openItems: r.openItems,
            });
        }
        res.json({ ok: true });
    })
);

module.exports = router;
