'use strict';

const express = require('express');
const router = express.Router();
const {
    requireAuth,
    requireEmployee,
    requireManager,
    requireManagerOrAdmin,
} = require('../middleware/auth');
const IDPService = require('../services/IDPService');
const ActionEffectivenessService = require('../services/ActionEffectivenessService');
const EmployeeModel = require('../models/EmployeeModel');
const RBACService = require('../services/RBACService');
const db = require('../config/database');
const ah = require('../utils/asyncHandler');

// The reporting line of the PERSON behind an administration account
// (admins.linked_employee_id): a manager signed in on their linked admin
// account was listed their team by scopeFilter (which unions this very set)
// and refused every one of them by the two guards below, which only knew the
// clearance. Same union, same source — GovernanceService.lineAuthorityEmployeeIds.
async function adminLineCovers(user, employeeId) {
    const line = await require('../services/GovernanceService').lineAuthorityEmployeeIds(user);
    return line.some((id) => Number(id) === Number(employeeId));
}

// An IDP is confidential to the subject + their governing chain. Without this,
// any authenticated user could read/sign any plan by id (IDOR).
async function canAccessIdp(user, plan) {
    if (!plan) return false;
    if (
        (user.userType === 'employee' || user.userType === 'manager') &&
        Number(user.id) === Number(plan.employeeId)
    ) {
        return true; // own development plan
    }
    const emp = await EmployeeModel.findById(plan.employeeId);
    if (!emp) return false;
    if (user.userType === 'admin') {
        return (
            (await RBACService.canAccessEmployeeData(user, emp)) || adminLineCovers(user, emp.id)
        );
    }
    // Sub-tree, matching the IDP console list (which uses findGoverned): the list
    // showed an N+2 manager plans they were then refused on opening.
    // `manager_type` qualifies the manager link: manager_id is polymorphic and
    // the employee/admin id spaces overlap.
    if (
        (emp.supervisorId && Number(emp.supervisorId) === Number(user.id)) ||
        (emp.managerId &&
            emp.managerType === 'employee' &&
            Number(emp.managerId) === Number(user.id))
    )
        return true;
    return EmployeeModel.governs(user.id, emp.id);
}

router.get(
    '/',
    requireAuth,
    ah(async (req, res) => {
        // "My plans" is an EMPLOYEE notion. Admin ids and employee ids overlap
        // (admin 87 is employee 87 today), so keying on req.user.id alone handed an
        // admin the confidential plans of whichever employee shares their number.
        const isEmployeeSide = req.user.userType === 'employee' || req.user.userType === 'manager';
        // An admin has no "my plans": send them to the team console instead of an
        // empty table that looked like "no IDPs exist".
        if (!isEmployeeSide) return res.redirect('/v2/idp/manage');
        const myPlans = await db.all(
            `SELECT * FROM idp_plans WHERE employee_id = ? ORDER BY created_at DESC`,
            [req.user.id]
        );
        res.render('pages/idp/index', {
            plans: myPlans,
            title: req.t ? req.t('idp:my_title') : 'My development plans',
        });
    })
);

// Manager/admin console: the team's IDPs in one place, so the blue-box arm of
// the talent loop no longer dead-ends. Scoped to the caller's governed people
// (super admin → all; local admin → scope; manager → reports). MUST be declared
// before '/:id' so 'manage' isn't captured as an id.
router.get(
    '/manage',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const sc = await RBACService.scopeFilter(req.user, { empAlias: 'e' });
        const list = await db.all(
            `SELECT p.*, e.first_name, e.last_name, e.employee_number,
                s.name AS site_name, d.name AS department_name,
                (SELECT COUNT(*) FROM idp_objectives o WHERE o.idp_id = p.id)::int AS objective_count,
                (SELECT COUNT(*) FROM idp_actions a WHERE a.idp_id = p.id)::int AS action_count,
                (SELECT COUNT(*) FROM idp_actions a WHERE a.idp_id = p.id AND a.status NOT IN ('completed','cancelled'))::int AS open_action_count
         FROM idp_plans p
         JOIN employees e ON e.id = p.employee_id
         LEFT JOIN sites s ON s.id = e.site_id
         LEFT JOIN departments d ON d.id = e.department_id
         WHERE 1=1 ${sc.clause}
         ORDER BY (p.status = 'draft') DESC, p.created_at DESC`,
            sc.params
        );
        const counts = list.reduce((a, p) => {
            a[p.status] = (a[p.status] || 0) + 1;
            return a;
        }, {});
        res.render('pages/idp/manage', {
            list,
            counts,
            title: req.t ? req.t('idp:manage_heading') : 'Team development plans',
        });
    })
);

// Can this manager/admin start an IDP for this employee? (manager → own reports)
//
// A VIEWER NEVER ACTS. requireManagerOrAdmin on POST /new is a guard by the
// SHAPE of the role and let a read-only delegation through: measured, viewer
// 1035 POST /v2/idp/new {employeeId:87} -> 302 /v2/idp/73, idp_plans 0 -> 1.
//
// 3.23.18: the ACTING rule — the same one IDPService.planAuthority applies
// to the plan lifecycle. The DIRECT line acts: the person's supervisor, their
// employee manager, or the admin account named their manager; so does an admin
// whose clearance covers them. The rest of the reporting sub-tree only READS
// (canAccessIdp). This used to accept `EmployeeModel.governs` (the whole
// sub-tree) and, for an admin account, the linked person's whole sub-tree
// (adminLineCovers), so an N+2 manager could create, sign and officially rate
// plans that self-assessment, 9-box and coaching only let them read. The
// subject never acts on their own plan, by either of their accounts.
async function canManageEmployee(user, emp) {
    if (!emp || !user) return false;
    if (RBACService.isViewer(user)) return false;
    const GovernanceService = require('../services/GovernanceService');
    const personId = await GovernanceService.actingPersonId(user);
    if (personId != null && Number(personId) === Number(emp.id)) return false; // the subject
    if (user.userType === 'admin') {
        if (RBACService.isSuperAdmin(user)) return true;
        if (await RBACService.canAccessEmployeeData(user, emp)) return true;
        if (emp.managerType === 'admin' && Number(emp.managerId) === Number(user.id)) return true;
    }
    if (personId == null) return false;
    const pid = Number(personId);
    return Boolean(
        (emp.supervisorId != null && Number(emp.supervisorId) === pid) ||
        (emp.managerType === 'employee' && emp.managerId != null && Number(emp.managerId) === pid)
    );
}

// Manager-initiated IDP: pick an employee (or arrive pre-filled from a gap) and
// seed objectives from their skill gaps. MUST precede '/:id'.
router.get(
    '/new',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const sc = await RBACService.scopeFilter(req.user, { empAlias: 'e' });
        const employees = await db.all(
            `SELECT e.id, e.first_name, e.last_name, e.employee_number, r.name AS role_name
         FROM employees e LEFT JOIN roles r ON r.id = e.role_id
         WHERE e.is_active = true ${sc.clause}
         ORDER BY e.last_name, e.first_name`,
            sc.params
        );
        const preEmpId = req.query.employeeId ? Number(req.query.employeeId) : null;
        const preSkillId = req.query.skillId ? Number(req.query.skillId) : null;
        let gaps = [];
        let target = null;
        if (preEmpId) {
            target = await EmployeeModel.findById(preEmpId);
            if (target && (await canManageEmployee(req.user, target))) {
                const DevelopmentTriggerService = require('../services/DevelopmentTriggerService');
                gaps = await DevelopmentTriggerService._topGaps(preEmpId, 25);
            } else {
                target = null; // out of scope → treat as no pre-fill
            }
        }
        res.render('pages/idp/new', {
            employees,
            target,
            gaps,
            preSkillId,
            title: req.t ? req.t('idp:new_heading') : 'New development plan',
        });
    })
);

router.post(
    '/new',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const employeeId = Number(req.body.employeeId);
        if (!employeeId) {
            req.flash(
                'error',
                req.t ? req.t('flash:idp_choose_employee') : 'Please choose an employee'
            );
            return res.redirect('/v2/idp/new');
        }
        const emp = await EmployeeModel.findById(employeeId);
        if (!emp || !(await canManageEmployee(req.user, emp))) {
            return res.status(403).render('pages/error', {
                message: 'Not authorized to create an IDP for this employee',
                title: req.t ? req.t('chrome:pt_forbidden') : 'Forbidden',
            });
        }
        let skillIds = req.body.skillIds || [];
        if (!Array.isArray(skillIds)) skillIds = [skillIds];
        const priority = req.body.priority || 'medium';
        let idpId;
        try {
            ({ idpId } = await IDPService.createManualPlan({
                employeeId,
                priority,
                skillIds,
                locale: req.getLocale ? req.getLocale() : 'fr',
            }));
        } catch (e) {
            // One open plan per person (uq_idp_open_per_employee): a 409 with a
            // sentence, never the raw unique-violation text as a 500.
            if (e && e.code === 'IDP_OPEN_EXISTS') {
                const message = req.t
                    ? req.t('flash:idp_open_plan_exists', { defaultValue: e.message })
                    : e.message;
                return res.status(409).render('pages/error', {
                    message: e.existingId ? `${message} (IDP #${e.existingId})` : message,
                    title: req.t
                        ? req.t('chrome:error_status_title', { status: 409, defaultValue: '409' })
                        : '409',
                });
            }
            throw e;
        }
        req.flash(
            'success',
            req.t
                ? req.t('flash:idp_draft_created')
                : 'Draft IDP created — add objectives and route for sign-off.'
        );
        res.redirect('/v2/idp/' + idpId);
    })
);

router.get(
    '/:id',
    requireAuth,
    ah(async (req, res) => {
        const plan = await db.get(`SELECT * FROM idp_plans WHERE id = ?`, [req.params.id]);
        if (!plan)
            return res.status(404).render('pages/error', {
                message: 'IDP not found',
                title: req.t ? req.t('chrome:pt_not_found') : 'Not found',
            });
        if (!(await canAccessIdp(req.user, plan))) {
            return res.status(403).render('pages/error', {
                message: 'Not authorized to view this IDP',
                title: req.t ? req.t('chrome:pt_forbidden') : 'Forbidden',
            });
        }
        let objectives = await db.all(`SELECT * FROM idp_objectives WHERE idp_id = ?`, [plan.id]);
        let actions = await db.all(`SELECT * FROM idp_actions WHERE idp_id = ?`, [plan.id]);
        // ---- — confidentiality guard for the SUBJECT --------------
        // The employee reaches their OWN plan here (canAccessIdp lets them), and an
        // objective is free text: IDP objective #17 in a test instance read
        // '… (from 9-box "High Performer")' on the very plan its subject is asked to
        // sign, with the placement undisclosed. Admins are not employee rows, so they
        // are never "the subject"; a manager viewing a report is unaffected.
        const viewerIsSubject =
            req.user &&
            req.user.userType !== 'admin' &&
            Number(req.user.id) === Number(plan.employeeId);
        if (viewerIsSubject) {
            const conf = require('../services/TalentConfidentialityService');
            const disclosed = Boolean(await conf.disclosedPlacement(plan.employeeId));
            const safe = (t) => conf.redactForSubject(t, { disclosed }).text;
            objectives = objectives.map((o) => ({ ...o, smartText: safe(o.smartText || '') }));
            actions = actions.map((a) => ({
                ...a,
                title: safe(a.title || ''),
                description: safe(a.description || ''),
            }));
        }
        // ---- ------------------------------------------------------
        // 3.23.17: the complete / archive / objective buttons show only to someone
        // the lifecycle routes would accept (same rule, fail closed on error).
        let canManagePlan = false;
        try {
            canManagePlan = Boolean((await IDPService.planAuthority(req.user, plan)).canAct);
        } catch (_) {
            canManagePlan = false;
        }
        res.render('pages/idp/detail', {
            plan,
            objectives,
            actions,
            canManagePlan,
            title: (req.t ? req.t('idp:title') : 'Individual Development Plans') + ' #' + plan.id,
        });
    })
);

router.post(
    '/:id/sign',
    requireAuth,
    ah(async (req, res) => {
        const plan = await db.get(`SELECT * FROM idp_plans WHERE id = ?`, [Number(req.params.id)]);
        if (!plan) return res.status(404).json({ ok: false, error: 'IDP not found' });
        // A viewer may read the plan (canAccessIdp) but never signs it.
        if (RBACService.isViewer(req.user) || !(await canAccessIdp(req.user, plan))) {
            return res.status(403).json({ ok: false, error: 'Not authorized to sign this IDP' });
        }
        // Derive the slot from the actual relationship to the plan — a manager signing
        // their OWN plan is the 'employee' party, not the supervisor.
        // Qualified on userType: an ADMIN whose id equals the employee's is never the
        // employee party (id spaces overlap), so they sign the supervisor slot only.
        const isEmployeeSide = req.user.userType === 'employee' || req.user.userType === 'manager';
        const role =
            isEmployeeSide && Number(req.user.id) === Number(plan.employeeId)
                ? 'employee'
                : 'supervisor';
        // 3.23.18: the SUPERVISOR slot is an act of governance — it takes
        // the direct line or an in-scope admin (planAuthority), not merely a
        // reader of the plan. An indirect manager reads the plan; they used to be
        // able to activate it by signing in the direct supervisor's place. The
        // same rule keeps the subject's own admin account out of that slot.
        if (role === 'supervisor') {
            const subject = await EmployeeModel.findById(plan.employeeId);
            if (!(await canManageEmployee(req.user, subject))) {
                return res
                    .status(403)
                    .json({ ok: false, error: 'Not authorized to sign this IDP' });
            }
        }
        const result = await IDPService.signOff({
            idpId: Number(req.params.id),
            role,
            userId: req.user.id,
            userType: req.user.userType,
            ip: req.ip,
            ua: req.get('user-agent'),
        });
        // detail.ejs posts a plain HTML form, so an API JSON body dead-ended the user
        // on a raw {"ok":true} page. Redirect back to the plan with a flash for HTML
        // callers; keep JSON for XHR/API clients.
        const wantsJson = req.xhr || (req.headers.accept || '').indexOf('json') > -1;
        if (wantsJson) return res.json({ ok: true, ...result });
        const key = result && result.activated ? 'flash:idp_activated' : 'flash:idp_signed_waiting';
        const fallback =
            result && result.activated
                ? 'Plan de développement activé — les deux signatures sont enregistrées.'
                : 'Signature enregistrée — en attente de la signature de l’autre partie.';
        req.flash('success', req.t ? req.t(key, { defaultValue: fallback }) : fallback);
        return res.redirect('/v2/idp/' + Number(req.params.id));
    })
);

router.post(
    '/actions/:id/close',
    requireManager,
    ah(async (req, res) => {
        const actionId = Number(req.params.id);
        // Derive the subject employee from the action's own IDP — never trust a
        // body-supplied employeeId (it would let a manager overwrite an arbitrary
        // employee's official skill level / close another team's action).
        const plan = await db.get(
            `SELECT i.id, i.employee_id AS "employeeId" FROM idp_actions a
         JOIN idp_plans i ON i.id = a.idp_id WHERE a.id = ?`,
            [actionId]
        );
        if (!plan) return res.status(404).json({ ok: false, error: 'Action not found' });
        if (!(await canAccessIdp(req.user, plan))) {
            return res.status(403).json({ ok: false, error: 'Not authorized for this action' });
        }
        const postRating = Number(req.body.postRating);
        if (!Number.isInteger(postRating) || postRating < 0 || postRating > 4) {
            return res.status(400).json({ ok: false, error: 'postRating must be an integer 0-4' });
        }
        // canAccessIdp lets the SUBJECT reach their own plan, and the close used
        // to write the post-rating as the OFFICIAL skill level: a manager closing
        // an action on their own IDP raised their own level (3.23.17, B-1). The
        // official level moves only when the closer is not the subject — by
        // either of their accounts — and has authority over them; otherwise the
        // rating is kept as evidence only (action_effectiveness).
        const { personIdOf } = require('../utils/personIdentity');
        const closer = await personIdOf(req.user);
        const isSubject = closer != null && closer === Number(plan.employeeId);
        let updateOfficial = false;
        if (!isSubject) {
            const emp = await EmployeeModel.findById(plan.employeeId);
            updateOfficial = Boolean(emp && (await canManageEmployee(req.user, emp)));
            // 3.23.18: closing somebody else's action is an ACT. The
            // indirect line reads the plan (canAccessIdp above) but does not
            // close its actions — same rule as sign / create / lifecycle.
            if (!updateOfficial) {
                return res.status(403).json({ ok: false, error: 'Not authorized for this action' });
            }
        }
        let assessedByAdminId = null;
        if (updateOfficial) {
            const { actorAdminId } = require('../utils/actorAdminId');
            assessedByAdminId = await actorAdminId(req.user);
            if (assessedByAdminId == null) {
                // skill_assessments.assessed_by is a NOT NULL FK onto admins(id):
                // same convention as LmsService.decideUplift — the system account
                // holds the FK, the real actor is carried by db.withActor.
                const sys = await db.get("SELECT id FROM admins WHERE username = 'admin'");
                assessedByAdminId = sys ? Number(sys.id) : null;
            }
        }
        const result = await ActionEffectivenessService.onActionClose({
            actionId,
            postRating,
            employeeId: plan.employeeId,
            actor: req.user,
            assessedByAdminId,
            updateOfficial,
        });
        res.json({ ok: true, ...result });
    })
);

module.exports = router;
