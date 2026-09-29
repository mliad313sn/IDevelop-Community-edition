'use strict';

/**
 * v2-capability — endpoints for the assessment-driven capability expansion:
 * calibration, goal cascading, internal mobility, engagement surveys, recognition
 * & feedback, DEI analytics, skills graph + learning recommendations, outbound
 * webhooks, and GDPR DSR. Mounted under /v2/cap (managers/admins) with selected
 * employee-facing actions.
 */
const express = require('express');
const router = express.Router();
const {
    requireAuth,
    requireManagerOrAdmin,
    requireManagerOrAnyPermission,
    requireSuperAdmin,
} = require('../middleware/auth');
const { writeActionLimiter } = require('../middleware/rateLimiter');
const ah = require('../utils/asyncHandler');
const db = require('../config/database');
const RBACService = require('../services/RBACService');
/**
 * M-02 — « Not authorized for this employee », la phrase de refus la plus
 * répandue de ce domaine, était un LITTÉRAL anglais rendu tel quel sur une page
 * française : treize lignes, cinq fichiers de routes et un contrôleur, et aucun
 * `say` ne pouvait les atteindre puisqu'elles ne LANCENT pas — elles répondent
 * directement. Le catalogue est partagé (`common:err_not_authorized_employee`)
 * et la phrase anglaise reste la référence par défaut.
 */
const { sayText } = require('../utils/apiErrors');
const notAuthorizedForEmployee = (req) =>
    sayText(req, 'common:err_not_authorized_employee', 'Not authorized for this employee');

const Calib = require('../services/TalentDepthService');
const Mob = require('../services/MobilityService');
const Sv = require('../services/SurveyService');
const Rec = require('../services/RecognitionService');
const DEI = require('../services/DEIService');
const SI = require('../services/SkillsIntelligenceService');
const Hook = require('../services/WebhookService');
const DSR = require('../services/DSRService');
const Copilot = require('../services/CopilotService');

// The acting ADMIN row id, or null when the actor is a manager/employee (rather
// than impersonating the built-in superadmin, which misattributed the audit
// trail and misrouted notifications). Pair with actorEmp so a manager's action
// still records WHO did it via actor_employee_id.
async function adminId(user) {
    if (user && user.userType === 'admin' && user.id != null) return Number(user.id);
    return null;
}
// The acting EMPLOYEE row id when the actor is a manager/employee, else null.
function actorEmp(user) {
    return user && (user.userType === 'manager' || user.userType === 'employee')
        ? Number(user.id)
        : null;
}
// The acting EMPLOYEE row id. Managers AND regular employees are employee rows;
// admins are not. (Previously this returned null for plain employees, which both
// broke self-service AND let the routes fall through to a spoofable body id.)
function empId(user) {
    return user && (user.userType === 'manager' || user.userType === 'employee')
        ? Number(user.id)
        : null;
}
// True when the actor governs (or is) the target employee, per RBAC scope.
async function inScope(user, employeeId) {
    if (!employeeId) return false;
    if (RBACService.isSuperAdmin && RBACService.isSuperAdmin(user)) return true;
    const emps = await RBACService.getFilteredEmployees(user);
    return emps.some((e) => Number(e.id) === Number(employeeId));
}
// Resolve the target employee for a self-service action: an employee/manager
// acts only on themselves; an admin may target a specific employee IN SCOPE.
async function selfOrScoped(req) {
    const me = empId(req.user);
    if (me) return me;
    const t = req.body.employeeId ? Number(req.body.employeeId) : null;
    return t && (await inScope(req.user, t)) ? t : null;
}
/** Ids of the ACTIVE-or-not employees the actor governs (SuperAdmin: everyone). */
async function scopeIds(user) {
    return (await RBACService.getFilteredEmployees(user)).map((e) => Number(e.id)).filter(Boolean);
}
/**
 * A service refusal (4xx + code, `expose`) answered in the page's language:
 * `talentx:err_<code>`, falling back to the code itself. Anything else is
 * re-thrown to asyncHandler (a genuine 500 stays a 500).
 */
function refusalJson(req, res, err) {
    const status = Number(err && err.status);
    if (err && err.expose && err.code && status >= 400 && status < 500) {
        res.status(status).json({
            ok: false,
            code: err.code,
            error: sayText(req, `talentx:err_${err.code}`, String(err.code)),
        });
        return true;
    }
    return false;
}
const guarded = (fn) =>
    ah(async (req, res, next) => {
        try {
            await fn(req, res, next);
        } catch (err) {
            if (!refusalJson(req, res, err)) throw err;
        }
    });
/** Is the actor the POSTER of this opportunity (admin row or manager row)? */
function isPosterOf(user, opp) {
    if (!user || !opp) return false;
    if (user.userType === 'admin')
        return Number(opp.postedByAdminId ?? opp.posted_by_admin_id) === Number(user.id);
    return Number(opp.actorEmployeeId ?? opp.actor_employee_id) === Number(user.id);
}
/**
 * Who is reading the recognition feed — see RecognitionService.feed. The
 * SuperAdmin reads every team item; an employee/manager reads the team items
 * around them (and a manager also those about the people they govern); a scoped
 * admin reads those about the people in their scope.
 */
async function feedViewer(user) {
    if (!user) return null;
    if (RBACService.isSuperAdmin && RBACService.isSuperAdmin(user)) return { all: true };
    const me = empId(user);
    if (user.userType === 'employee') return { employeeId: me };
    return { employeeId: me, scopeIds: await scopeIds(user) };
}
function ownerFilter(user) {
    return user.userType === 'admin'
        ? { adminId: Number(user.id) }
        : { employeeId: Number(user.id) };
}

// ===================== Hub page (managers/admins) ===========================
router.get(
    '/',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        // Org-wide DEI representation is SuperAdmin-only (same gate as the /dei/* JSON
        // routes) — a scoped manager/local-admin must not read whole-org demographics
        // from the hub page. Non-supers get an empty deiRep (the DEI panel hides itself).
        const isSuper = RBACService.isSuperAdmin(req.user);
        // The opportunity and survey lists were org-wide for every manager/admin:
        // anyone saw everyone's postings and surveys (and their respondent counts).
        // A non-SuperAdmin now sees the ones they own, plus — for opportunities —
        // those with an applicant inside their scope (whom they may decide).
        const oppVisibility = isSuper
            ? null
            : { ...ownerFilter(req.user), scopeIds: await scopeIds(req.user) };
        const [calibrations, objectives, opportunities, surveys, deiRep] = await Promise.all([
            Calib.listCalibrations(),
            Calib.listObjectives(),
            Mob.listOpportunities('open', { includeExpired: true, visibleTo: oppVisibility }),
            Sv.list(isSuper ? null : ownerFilter(req.user)),
            isSuper ? DEI.representation('gender').catch(() => []) : Promise.resolve([]),
        ]);
        // Close / fill belong to the poster (or the SuperAdmin) only.
        (opportunities || []).forEach((o) => {
            o.canClose = isSuper || isPosterOf(req.user, o);
        });
        const recognitions = await Rec.feed({ limit: 12, viewer: await feedViewer(req.user) });
        // the page had a bare "IDevelop" <title>.
        res.render('pages/capability/index', {
            calibrations,
            objectives,
            opportunities,
            surveys,
            surveyTemplates: Sv.templates(req.language),
            deiRep,
            recognitions,
            title: req.t ? req.t('chrome:pt_talent_suite') : 'Talent suite',
        });
    })
);

// ===================== Calibration ==========================================
router.post(
    '/calibration',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    ah(async (req, res) => {
        const row = await Calib.createCalibration({
            cycleId: req.body.cycleId || null,
            scopeType: req.body.scopeType || 'org',
            scopeId: req.body.scopeId || null,
            facilitatorAdminId: await adminId(req.user),
            actorEmployeeId: actorEmp(req.user),
        });
        res.json({ ok: true, id: row.id });
    })
);
router.get(
    '/calibration/:id',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const s = await Calib.getCalibration(Number(req.params.id));
        if (!s) return res.status(404).json({ ok: false, error: 'not found' });
        // Clearance-fit: the write path (/adjust) already checks inScope, but this
        // read returned every session's confidential per-employee box moves + an
        // org-wide distribution to any manager/admin who guessed an id. Scope both to
        // the caller's governed span (superadmin unfiltered): filter adjustments to
        // governed employees and recompute the distribution over that same set.
        if (!RBACService.isSuperAdmin(req.user)) {
            const gov = new Set(
                (await RBACService.getFilteredEmployees(req.user)).map((e) => Number(e.id))
            );
            // The row mapper returns camelCase, so `a.employee_id` was always
            // undefined -> Number(undefined) is NaN -> gov.has(NaN) is false -> EVERY
            // adjustment was filtered out. A scoped facilitator opened their own
            // calibration session and saw zero adjustments, including ones they had
            // just entered, and would reasonably re-enter them. The sibling check
            // further down in this same file reads it correctly.
            s.adjustments = (s.adjustments || []).filter((a) =>
                gov.has(Number(a.employeeId ?? a.employee_id))
            );
            // Same query as the unscoped panel (the session's OWN cycle + scope, not the
            // org-wide MAX cycle), further restricted to the governed employees.
            s.distribution = await Calib.distributionFor(s, [...gov]);
        }
        res.json({ ok: true, session: s });
    })
);
router.post(
    '/calibration/:id/adjust',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    ah(async (req, res) => {
        if (!req.body.rationale)
            return res.status(400).json({ ok: false, error: 'rationale required' });
        // Scope: a calibration adjustment writes a confidential talent record about an
        // employee — only for someone in the actor's span (every sibling talent route does
        // this; this one was missing it → cross-scope write via a guessed employeeId).
        const empId = Number(req.body.employeeId);
        if (!empId || !(await inScope(req.user, empId)))
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        const row = await Calib.adjust(Number(req.params.id), {
            employeeId: empId,
            fromBox: req.body.fromBox,
            toBox: req.body.toBox,
            rationale: req.body.rationale,
            actorAdminId: await adminId(req.user),
            actorEmployeeId: actorEmp(req.user),
        });
        res.json({ ok: true, id: row.id });
    })
);
router.post(
    '/calibration/:id/finalize',
    requireManagerOrAnyPermission('manage_talent_reviews'),
    ah(async (req, res) => {
        // Finalize commits EVERY adjustment in the session to talent_placements —
        // guard it like the read/adjust siblings (it was the one unguarded write:
        // any manager org-wide could finalize/sabotage any session, IDOR). Allowed:
        // superadmin, the session's facilitator admin, or an actor whose RBAC span
        // covers every adjusted employee.
        const sid = Number(req.params.id);
        if (!RBACService.isSuperAdmin(req.user)) {
            const s = await db.get(
                'SELECT id, facilitator_admin_id FROM calibration_sessions WHERE id = ?',
                [sid]
            );
            if (!s) return res.status(404).json({ ok: false, error: 'not found' });
            const isFacilitator =
                req.user.userType === 'admin' &&
                Number(s.facilitatorAdminId ?? s.facilitator_admin_id) === Number(req.user.id);
            if (!isFacilitator) {
                const adjusted = await db.all(
                    'SELECT DISTINCT employee_id FROM calibration_adjustments WHERE session_id = ?',
                    [sid]
                );
                const gov = new Set(
                    (await RBACService.getFilteredEmployees(req.user)).map((e) => Number(e.id))
                );
                const allInSpan =
                    adjusted.length > 0 &&
                    adjusted.every((a) => gov.has(Number(a.employeeId ?? a.employee_id)));
                if (!allInSpan)
                    return res
                        .status(403)
                        .json({ ok: false, error: 'not authorized to finalize this session' });
            }
        }
        // finalizeCalibration now reports an honest no-op: a session with no
        // adjustments (or whose adjustments matched no placement row) changes NOTHING,
        // so it must not answer 200/ok — the facilitator has to be told, and the
        // session stays open so it can be corrected and finalized for real.
        // Pass the caller: the write-back, its 9-box events and the PIP/IDP
        // triggers are then attributed to the person who clicked Finalize, not to
        // the session's facilitator by default (and the audit row gets ip/request).
        const r = await Calib.finalizeCalibration(sid, { user: req.user, req });
        if (!r || r.ok === false) {
            return res.status(409).json({
                ok: false,
                error: (r && r.reason) || 'not_applied',
                applied: 0,
                attempted: (r && r.attempted) || 0,
            });
        }
        res.json({ ok: true, applied: r.applied });
    })
);

// ===================== Goal cascading =======================================
// Objectives are org-unit goals (site / department): a WRITE, gated on the
// organisation slug so WRITE_SLUGS excludes read-only viewers (requireManagerOrAdmin
// admitted them org-wide). Managers keep access for their own cascade.
router.post(
    '/objective',
    requireManagerOrAnyPermission('manage_organization'),
    ah(async (req, res) => {
        if (!req.body.title || !req.body.level)
            return res.status(400).json({ ok: false, error: 'level and title required' });
        const row = await Calib.createObjective({
            level: req.body.level,
            title: req.body.title,
            description: req.body.description,
            siteId: req.body.siteId || null,
            departmentId: req.body.departmentId || null,
            ownerAdminId: await adminId(req.user),
            actorEmployeeId: actorEmp(req.user),
            period: req.body.period,
        });
        res.json({ ok: true, id: row.id });
    })
);
// Active org objectives, for the "align this goal" control on the employee OKR panel.
router.get(
    '/objectives',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const list = await Calib.listObjectives();
        res.json({
            ok: true,
            objectives: (list || []).map((o) => ({
                id: Number(o.id),
                level: o.level,
                title: o.title,
                period: o.period || null,
            })),
        });
    })
);
router.post(
    '/objective/:id/align',
    requireManagerOrAnyPermission('manage_organization'),
    ah(async (req, res) => {
        // The goal id came straight from the body and was never checked: any manager
        // could attach ANY employee's goal (and so expose its title and progress in
        // the cascade roll-up) to an objective. The goal must exist and belong to an
        // employee the actor governs; the objective must exist and be active.
        const goalId = Number(req.body.goalId);
        const objId = Number(req.params.id);
        if (!Number.isInteger(goalId) || goalId <= 0 || !Number.isInteger(objId) || objId <= 0) {
            return res.status(400).json({
                ok: false,
                error: sayText(
                    req,
                    'talentx:err_align_invalid',
                    'goalId and objective id required'
                ),
            });
        }
        const goal = await db.get('SELECT id, employee_id FROM goals WHERE id = ?', [goalId]);
        if (!goal)
            return res.status(404).json({
                ok: false,
                error: sayText(req, 'talentx:err_goal_not_found', 'goal not found'),
            });
        if (!(await inScope(req.user, Number(goal.employeeId ?? goal.employee_id)))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        const obj = await db.get(
            "SELECT id FROM org_objectives WHERE id = ? AND status = 'active'",
            [objId]
        );
        if (!obj)
            return res.status(404).json({
                ok: false,
                error: sayText(req, 'talentx:err_objective_not_found', 'objective not found'),
            });
        const w = Number(req.body.weight);
        const weight = Number.isFinite(w) && w > 0 && w <= 10 ? w : 1.0;
        const row = await Calib.alignGoal(goalId, objId, weight);
        res.json({ ok: true, id: row.id });
    })
);
router.get(
    '/objective/:id/cascade',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const obj = await Calib.objectiveCascade(Number(req.params.id));
        // The roll-up names every contributing employee with their goal progress:
        // a non-SuperAdmin sees only the contributors they govern.
        if (obj && !RBACService.isSuperAdmin(req.user)) {
            const gov = new Set(await scopeIds(req.user));
            const ids = await db.all(
                'SELECT ga.goal_id, g.employee_id FROM goal_alignment ga JOIN goals g ON g.id = ga.goal_id WHERE ga.org_objective_id = ?',
                [Number(req.params.id)]
            );
            const allowed = new Set(
                ids
                    .filter((r) => gov.has(Number(r.employeeId ?? r.employee_id)))
                    .map((r) => Number(r.goalId ?? r.goal_id))
            );
            obj.contributors = (obj.contributors || []).filter((c) =>
                allowed.has(Number(c.goalId ?? c.goal_id))
            );
            const progs = obj.contributors.map((c) => Number(c.progress)).filter(Number.isFinite);
            // Roll-up over what the caller may see; null (not 0) when nothing is visible.
            obj.rollupProgress = progs.length
                ? Math.round(progs.reduce((a, b) => a + b, 0) / progs.length)
                : null;
        }
        res.json({ ok: true, objective: obj });
    })
);

// ===================== Internal mobility ====================================
router.post(
    '/opportunity',
    requireManagerOrAnyPermission('manage_mobility'),
    ah(async (req, res) => {
        const title = String(req.body.title || '')
            .trim()
            .slice(0, 200);
        if (!title)
            return res.status(400).json({
                ok: false,
                error: sayText(req, 'talentx:cap_need_title', 'title required'),
            });
        const closesOn =
            req.body.closesOn && /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.closesOn))
                ? String(req.body.closesOn)
                : null;
        // The "new opportunity" notification goes to the POSTER's scope only.
        const row = await Mob.postOpportunity({
            kind: req.body.kind,
            title,
            description: req.body.description,
            roleId: req.body.roleId || null,
            skillsSought: req.body.skillsSought || [],
            postedByAdminId: await adminId(req.user),
            actorEmployeeId: actorEmp(req.user),
            closesOn,
            audiencePool: await scopeIds(req.user),
        });
        res.json({ ok: true, id: row.id });
    })
);
router.get(
    '/opportunity/:id/match',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const pool = (await RBACService.getFilteredEmployees(req.user)).map((e) => Number(e.id));
        res.json({ ok: true, candidates: await Mob.matchCandidates(Number(req.params.id), pool) });
    })
);
// Applicants of one opportunity (name, fit, date, status). The poster and the
// SuperAdmin see all of them; anyone else only the applicants they govern —
// and is refused when that is nobody.
router.get(
    '/opportunity/:id/applicants',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        const opp = await Mob.getOpportunity(Number(req.params.id));
        if (!opp)
            return res.status(404).json({
                ok: false,
                error: sayText(req, 'talentx:err_opportunity_not_found', 'not found'),
            });
        const full = RBACService.isSuperAdmin(req.user) || isPosterOf(req.user, opp);
        const applicants = await Mob.listApplicants(opp.id, {
            scopeIds: full ? null : await scopeIds(req.user),
        });
        if (!full && !applicants.length)
            return res.status(403).json({
                ok: false,
                error: sayText(
                    req,
                    'talentx:err_not_authorized_opportunity',
                    'not authorized for this opportunity'
                ),
            });
        res.json({ ok: true, applicants });
    })
);
// Close / fill an open opportunity, with a reason (recorded, never deleted).
// Poster or SuperAdmin only — fail closed for everyone else.
router.post(
    '/opportunity/:id/state',
    requireManagerOrAnyPermission('manage_mobility'),
    guarded(async (req, res) => {
        const opp = await Mob.getOpportunity(Number(req.params.id));
        if (!opp)
            return res.status(404).json({
                ok: false,
                error: sayText(req, 'talentx:err_opportunity_not_found', 'not found'),
            });
        if (!RBACService.isSuperAdmin(req.user) && !isPosterOf(req.user, opp)) {
            return res.status(403).json({
                ok: false,
                error: sayText(
                    req,
                    'talentx:err_not_authorized_opportunity',
                    'not authorized for this opportunity'
                ),
            });
        }
        res.json(
            await Mob.setOpportunityState(opp.id, {
                state: req.body.state,
                reason: req.body.reason,
                adminId: await adminId(req.user),
                employeeId: actorEmp(req.user),
            })
        );
    })
);
router.post(
    '/opportunity/:id/apply',
    requireAuth,
    guarded(async (req, res) => {
        const me = empId(req.user);
        if (!me) return res.status(403).json({ ok: false, error: 'only employees can apply' });
        await Mob.apply(
            Number(req.params.id),
            me,
            req.body.note ? String(req.body.note).slice(0, 2000) : null
        );
        res.json({ ok: true });
    })
);
// Self-service withdraw while the application is still undecided.
router.post(
    '/opportunity/:id/withdraw',
    requireAuth,
    ah(async (req, res) => {
        const me = empId(req.user);
        if (!me) return res.status(403).json({ ok: false, error: 'only employees can withdraw' });
        res.json(await Mob.withdraw(Number(req.params.id), me));
    })
);
// Poster/admin decides an application (accept/decline) — notifies the applicant.
router.post(
    '/opportunity/application/:id/decide',
    requireManagerOrAnyPermission('manage_mobility'),
    guarded(async (req, res) => {
        // Scope guard (was the one unguarded decision write — any manager org-wide
        // could accept/decline any application by iterating ids, IDOR). Allowed:
        // superadmin, the poster of the opportunity (admin OR manager), or an actor
        // who governs the applicant per RBAC scope — mirrors suggestionInScope below.
        if (!RBACService.isSuperAdmin(req.user)) {
            const app = await db.get(
                `SELECT a.employee_id, o.posted_by_admin_id, o.actor_employee_id
               FROM opportunity_applications a JOIN opportunities o ON o.id = a.opportunity_id
              WHERE a.id = ?`,
                [Number(req.params.id)]
            );
            if (!app) return res.status(404).json({ ok: false, error: 'not found' });
            const isPoster = isPosterOf(req.user, app);
            if (
                !isPoster &&
                !(await inScope(req.user, Number(app.employeeId ?? app.employee_id)))
            ) {
                return res
                    .status(403)
                    .json({ ok: false, error: 'not authorized for this application' });
            }
        }
        const r = await Mob.decideApplication(Number(req.params.id), {
            decidedByAdminId: await adminId(req.user),
            actorEmployeeId: actorEmp(req.user),
            decision: req.body.decision,
            note: req.body.note || null,
        });
        res.json(r);
    })
);
router.post(
    '/aspirations',
    requireAuth,
    ah(async (req, res) => {
        const me = await selfOrScoped(req);
        if (!me)
            return res.status(403).json({ ok: false, error: 'not authorized for this employee' });
        await Mob.setAspirations(me, {
            targetRoleId: req.body.targetRoleId || null,
            interests: req.body.interests,
            openToMobility: req.body.openToMobility,
        });
        res.json({ ok: true });
    })
);

// ===================== Surveys ==============================================
router.post(
    '/survey',
    requireManagerOrAnyPermission('manage_surveys'),
    guarded(async (req, res) => {
        const common = {
            anonymous: req.body.anonymous,
            minResponses: req.body.minResponses,
            createdByAdminId: await adminId(req.user),
            actorEmployeeId: actorEmp(req.user),
        };
        const hasQuestions = Array.isArray(req.body.questions) && req.body.questions.length > 0;
        // A template id with no question list: take the template's questions as
        // they are. With a (possibly edited) question list, the list wins.
        const s =
            req.body.templateId && !hasQuestions
                ? await Sv.createFromTemplate(req.body.templateId, {
                      ...common,
                      lang: req.language,
                      title: req.body.title,
                  })
                : await Sv.create({
                      ...common,
                      kind: req.body.kind,
                      title: req.body.title,
                      questions: req.body.questions || [],
                  });
        res.json({ ok: true, id: s.id, minResponses: Number(s.minResponses ?? s.min_responses) });
    })
);
/** The survey templates, in the reader's language. */
router.get(
    '/survey/templates',
    requireManagerOrAnyPermission('manage_surveys'),
    ah(async (req, res) => {
        res.json({ ok: true, templates: Sv.templates(req.language) });
    })
);
/**
 * Owner guard for open / close / results — these three had none: any holder
 * of manage_surveys could open, close or read anybody's survey. SuperAdmin,
 * or the admin / manager who created it.
 */
async function ownedSurvey(req, res) {
    const s = await Sv.get(Number(req.params.id));
    if (!s) {
        res.status(404).json({
            ok: false,
            error: sayText(req, 'talentx:err_survey_not_found', 'not found'),
        });
        return null;
    }
    if (!Sv.canManage(req.user, s)) {
        res.status(403).json({
            ok: false,
            error: sayText(
                req,
                'talentx:err_not_authorized_survey',
                'not authorized for this survey'
            ),
        });
        return null;
    }
    return s;
}
router.post(
    '/survey/:id/open',
    requireManagerOrAnyPermission('manage_surveys'),
    guarded(async (req, res) => {
        const s = await ownedSurvey(req, res);
        if (!s) return;
        // Audience = the OPENER's scope (SuperAdmin: the organisation).
        res.json(await Sv.open(s.id, { audienceIds: await scopeIds(req.user) }));
    })
);
router.post(
    '/survey/:id/close',
    requireManagerOrAnyPermission('manage_surveys'),
    guarded(async (req, res) => {
        const s = await ownedSurvey(req, res);
        if (!s) return;
        res.json(await Sv.close(s.id));
    })
);
router.get(
    '/survey/:id/results',
    requireManagerOrAnyPermission('manage_surveys'),
    guarded(async (req, res) => {
        const s = await ownedSurvey(req, res);
        if (!s) return;
        res.json({ ok: true, results: await Sv.results(s.id) });
    })
);
/**
 * SEC-5 (3.23.21): the questions of a survey are read by its AUDIENCE (an
 * employee invited to it) or by someone who may manage it (owner / SuperAdmin).
 * Anyone signed in used to read any survey's questions by id, drafts included.
 * Unknown and not-yours answer the same 404 — never confirm existence.
 */
router.get(
    '/survey/:id/questions',
    requireAuth,
    ah(async (req, res) => {
        const id = Number(req.params.id);
        const notFound = () =>
            res.status(404).json({
                ok: false,
                error: sayText(req, 'talentx:err_survey_not_found', 'not found'),
            });
        if (!Number.isInteger(id) || id <= 0) return notFound();
        const s = await Sv.get(id);
        if (!s) return notFound();
        if (!(await Sv.canReadQuestions(req.user, s))) return notFound();
        res.json({ ok: true, questions: await Sv.questions(id) });
    })
);
/**
 * SEC-3 (3.23.21): an answer is given by the employee THEMSELVES. The admin
 * branch (answer « for » an in-scope employee by body.employeeId) let an admin
 * put words in somebody's mouth on a survey that is, by default, anonymous.
 */
router.post(
    '/survey/:id/respond',
    requireAuth,
    writeActionLimiter,
    guarded(async (req, res) => {
        const me = empId(req.user);
        if (!me) return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        res.json({
            ok: true,
            ...(await Sv.respond(Number(req.params.id), me, req.body.answers || [])),
        });
    })
);

// ===================== Recognition & feedback ===============================
router.get(
    '/recognition/feed',
    requireAuth,
    ah(async (req, res) => {
        res.json({
            ok: true,
            feed: await Rec.feed({ limit: 30, viewer: await feedViewer(req.user) }),
        });
    })
);
router.post(
    '/recognition',
    requireAuth,
    writeActionLimiter,
    ah(async (req, res) => {
        const to = Number(req.body.toEmployeeId);
        const message = String(req.body.message || '').trim();
        if (!to || !message)
            return res.status(400).json({
                ok: false,
                code: 'recognition_required',
                error: sayText(
                    req,
                    'growth:thank_err_required',
                    'Choose a colleague and write a message.'
                ),
            });
        if (message.length > 1000)
            return res.status(400).json({
                ok: false,
                code: 'recognition_too_long',
                error: sayText(
                    req,
                    'growth:thank_err_too_long',
                    'Your message is too long (1,000 characters maximum).'
                ),
            });
        if (empId(req.user) && empId(req.user) === to)
            return res.status(400).json({
                ok: false,
                code: 'recognition_self',
                error: sayText(req, 'growth:thank_err_self', 'You cannot thank yourself.'),
            });
        const row = await Rec.give({
            fromEmployeeId: empId(req.user),
            toEmployeeId: to,
            valueTag: req.body.valueTag
                ? String(req.body.valueTag).trim().slice(0, 60) || null
                : null,
            message,
            visibility: req.body.visibility || undefined,
        });
        res.json({ ok: true, id: row.id });
    })
);
router.post(
    '/feedback',
    requireAuth,
    writeActionLimiter,
    ah(async (req, res) => {
        const about = Number(req.body.aboutEmployeeId);
        if (!about) return res.status(400).json({ ok: false, error: 'aboutEmployeeId required' });
        // Prevent writing (manager-visible) feedback about an arbitrary employee:
        // the author must be the subject themselves or govern them via RBAC scope.
        if (empId(req.user) !== about && !(await inScope(req.user, about))) {
            return res.status(403).json({ ok: false, error: 'not authorized for this employee' });
        }
        const row = await Rec.addFeedback({
            aboutEmployeeId: about,
            authorEmployeeId: empId(req.user),
            authorAdminId: req.user.userType === 'admin' ? await adminId(req.user) : null,
            kind: req.body.kind,
            body: req.body.body,
            visibility: req.body.visibility,
        });
        res.json({ ok: true, id: row.id });
    })
);

// ===================== DEI analytics (admins) ===============================
router.post(
    '/dei/:employeeId',
    requireManagerOrAdmin,
    guarded(async (req, res) => {
        // Sensitive demographic data — only for employees the actor governs.
        if (!(await inScope(req.user, Number(req.params.employeeId))))
            return res.status(403).json({ ok: false, error: 'out of scope' });
        await DEI.setDemographics(Number(req.params.employeeId), req.body || {});
        res.json({ ok: true });
    })
);
// These aggregate across the WHOLE org (no scope param), so a scoped local
// admin must not read them — restrict to SuperAdmin. Group counts are still
// suppressed below the minimum in the service.
const superOnly = (req, res, next) =>
    req.user && req.user.role === 'superadmin'
        ? next()
        : res.status(403).json({ ok: false, error: 'org-wide DEI analytics require superadmin' });
router.get(
    '/dei/representation',
    requireManagerOrAdmin,
    superOnly,
    ah(async (req, res) => {
        res.json({ ok: true, data: await DEI.representation(req.query.dim || 'gender') });
    })
);
router.get(
    '/dei/ninebox',
    requireManagerOrAdmin,
    superOnly,
    ah(async (req, res) => {
        res.json({ ok: true, data: await DEI.nineBoxByGroup(req.query.dim || 'gender') });
    })
);
router.get(
    '/dei/piprate',
    requireManagerOrAdmin,
    superOnly,
    ah(async (req, res) => {
        res.json({ ok: true, data: await DEI.pipRateByGroup(req.query.dim || 'gender') });
    })
);

// ===================== Skills graph + learning recs =========================
// The skills graph is catalogue maintenance → manage_domains_skills / manage_roles (write slugs; no viewer).
router.post(
    '/skills/relate',
    requireManagerOrAnyPermission('manage_domains_skills', 'manage_roles'),
    ah(async (req, res) => {
        const r = await SI.relate(
            Number(req.body.skillA),
            Number(req.body.skillB),
            req.body.relation,
            req.body.weight
        );
        res.json({ ok: true, id: r.id });
    })
);
router.get(
    '/skills/:id/adjacent',
    requireAuth,
    ah(async (req, res) => {
        res.json({ ok: true, adjacent: await SI.adjacent(Number(req.params.id)) });
    })
);
router.get(
    '/learning/recommend/:employeeId',
    requireAuth,
    ah(async (req, res) => {
        const target = Number(req.params.employeeId);
        // Reveals the employee's role gaps — self-service, or for someone in scope.
        if (empId(req.user) !== target && !(await inScope(req.user, target)))
            return res.status(403).json({ ok: false, error: 'not authorized for this employee' });
        res.json({ ok: true, recommendations: await SI.recommendLearning(target) });
    })
);

// Skills inference (on-prem, no LLM): infer+upsert, list, accept, dismiss.
router.post(
    '/skills/infer/:employeeId',
    requireManagerOrAdmin,
    writeActionLimiter,
    ah(async (req, res) => {
        if (!(await inScope(req.user, Number(req.params.employeeId))))
            return res.status(403).json({ ok: false, error: 'out of scope' });
        res.json({ ok: true, suggestions: await SI.inferSkills(Number(req.params.employeeId)) });
    })
);
router.get(
    '/skills/suggestions/:employeeId',
    requireManagerOrAdmin,
    ah(async (req, res) => {
        if (!(await inScope(req.user, Number(req.params.employeeId))))
            return res.status(403).json({ ok: false, error: 'out of scope' });
        res.json({
            ok: true,
            suggestions: await SI.listSuggestions(Number(req.params.employeeId)),
        });
    })
);
// A suggestion carries no employee id in the URL, so guard by resolving the
// subject and checking scope — otherwise a scoped admin could accept/dismiss
// suggestions for out-of-scope employees by iterating ids (IDOR).
async function suggestionInScope(req) {
    const emp = await SI.suggestionEmployeeId(Number(req.params.id));
    return emp != null && (await inScope(req.user, emp));
}
// Accepting a suggestion RECORDS a skill assessment; dismissing decides one → manage_assessments (write slug; no viewer).
router.post(
    '/skills/suggestion/:id/accept',
    requireManagerOrAnyPermission('manage_assessments'),
    ah(async (req, res) => {
        if (!(await suggestionInScope(req)))
            return res.status(403).json({ ok: false, error: 'not authorized for this employee' });
        res.json({
            ok: true,
            ...(await SI.acceptSuggestion(Number(req.params.id), {
                level: req.body.level,
                adminId: await adminId(req.user),
            })),
        });
    })
);
router.post(
    '/skills/suggestion/:id/dismiss',
    requireManagerOrAnyPermission('manage_assessments'),
    ah(async (req, res) => {
        if (!(await suggestionInScope(req)))
            return res.status(403).json({ ok: false, error: 'not authorized for this employee' });
        res.json({
            ok: true,
            ...(await SI.dismissSuggestion(Number(req.params.id), await adminId(req.user))),
        });
    })
);

// ===================== Outbound webhooks (superadmin) =======================
router.get(
    '/webhooks',
    requireSuperAdmin,
    ah(async (req, res) => {
        res.json({ ok: true, list: await Hook.list() });
    })
);
router.post(
    '/webhooks',
    requireSuperAdmin,
    ah(async (req, res) => {
        const r = await Hook.subscribe({
            label: req.body.label,
            url: req.body.url,
            secret: req.body.secret,
            events: req.body.events || ['*'],
            format: req.body.format || 'json',
            createdByAdminId: await adminId(req.user),
        });
        res.json({ ok: true, id: r.id });
    })
);
router.post(
    '/webhooks/:id/toggle',
    requireSuperAdmin,
    ah(async (req, res) => {
        await Hook.setEnabled(
            Number(req.params.id),
            req.body.enabled === true || req.body.enabled === 'true'
        );
        res.json({ ok: true });
    })
);
router.post(
    '/webhooks/:id/remove',
    requireSuperAdmin,
    ah(async (req, res) => {
        await Hook.remove(Number(req.params.id));
        res.json({ ok: true });
    })
);
router.post(
    '/webhooks/test',
    requireSuperAdmin,
    ah(async (req, res) => {
        res.json({ ok: true, ...(await Hook.emit('test.ping', { by: req.user.username })) });
    })
);

// ===================== GDPR DSR (superadmin) ================================
router.get(
    '/dsr/:employeeId/export',
    requireSuperAdmin,
    ah(async (req, res) => {
        const empId = Number(req.params.employeeId);
        const data = await DSR.export(empId);
        // GDPR accountability (Art. 5(2)/30): a subject-data EXPORT is a sensitive PII read
        // and must leave an audit record of WHO accessed WHOSE data — the mutation-only
        // activity trail skips GETs, so log it explicitly to the append-only store.
        try {
            await require('../services/LogService').log({
                adminId: req.user && req.user.id,
                action: 'GDPR_DSR_EXPORT',
                entityType: 'employee',
                entityId: empId,
                details: `Data-subject export generated for employee #${empId}`,
                ipAddress: req.ip,
                userAgent: req.get && req.get('user-agent'),
            });
        } catch (_) {
            /* audit best-effort */
        }
        res.json({ ok: true, export: data });
    })
);
router.post(
    '/dsr/:employeeId/erase',
    requireSuperAdmin,
    ah(async (req, res) => {
        if (req.body.confirm !== 'ERASE')
            return res.status(400).json({ ok: false, error: 'set confirm=ERASE' });
        res.json({
            ok: true,
            ...(await DSR.erase(Number(req.params.employeeId), await adminId(req.user))),
        });
    })
);
router.get(
    '/dsr/retention/due',
    requireSuperAdmin,
    ah(async (req, res) => {
        res.json({ ok: true, due: await DSR.dueForRetention() });
    })
);

// ---- Retention purge + erasure tombstones (S-07, 3.23.18) -------------------
// A refusal from the retention service, answered in the page's language.
const retRefusal = (req, res, err) => {
    const status = Number(err && err.status);
    if (err && err.expose && err.code && status >= 400 && status < 500) {
        res.status(status).json({
            ok: false,
            code: err.code,
            error: sayText(req, `admin:ret_err_${err.code}`, String(err.code)),
        });
        return true;
    }
    return false;
};
const retActor = (user) =>
    user && user.id != null ? `${user.userType || 'admin'}:${user.id}` : null;

router.get(
    '/dsr/retention/status',
    requireSuperAdmin,
    ah(async (req, res) => {
        res.json({ ok: true, ...(await DSR.retentionStatus()) });
    })
);
// 'report' ⇄ 'apply'. Reason mandatory: switching the purge on is the moment
// personal data starts being erased on a clock, and the audit must say why.
router.post(
    '/dsr/retention/mode',
    requireSuperAdmin,
    ah(async (req, res) => {
        const mode = String((req.body && req.body.mode) || '');
        const reason = String((req.body && req.body.reason) || '').trim();
        if (mode !== 'report' && mode !== 'apply')
            return retRefusal(req, res, { status: 400, code: 'bad_mode', expose: true });
        if (!reason)
            return retRefusal(req, res, { status: 400, code: 'reason_required', expose: true });
        const AppSettingsModel = require('../models/AppSettingsModel');
        await AppSettingsModel.setValue(
            'retentionPurgeMode',
            mode,
            'string',
            "Retention purge: 'report' lists, 'apply' pseudonymises (set from the Retention panel).",
            'jobs',
            await adminId(req.user)
        );
        try {
            await require('../services/LogService').log({
                adminId: await adminId(req.user),
                action: 'RETENTION_MODE_CHANGED',
                entityType: 'setting',
                entityId: null,
                details: `retentionPurgeMode set to '${mode}' — reason: ${reason}`,
                severity: 'warning',
                category: 'maintenance',
                actorRef: retActor(req.user),
            });
        } catch (_) {
            /* audit best-effort */
        }
        res.json({ ok: true, mode });
    })
);
// Run the pass now, in the CONFIGURED mode (the button never escalates to apply).
router.post(
    '/dsr/retention/run',
    requireSuperAdmin,
    writeActionLimiter,
    ah(async (req, res) => {
        const r = await require('../jobs/retention-purge').tick({
            force: true,
            actorRef: retActor(req.user),
        });
        res.json({ ok: true, ...r });
    })
);
// After an SQL / pg_dump restore (the snapshot restore does it by itself).
router.post(
    '/dsr/retention/reapply-erasures',
    requireSuperAdmin,
    writeActionLimiter,
    ah(async (req, res) => {
        const r = await DSR.reapplyTombstones({
            actorAdminId: await adminId(req.user),
            source: 'manual re-application',
        });
        res.json({ ok: r.failed.length === 0, ...r });
    })
);
router.post(
    '/dsr/:employeeId/legal-hold',
    requireSuperAdmin,
    ah(async (req, res) => {
        const id = Number(req.params.employeeId);
        if (!Number.isInteger(id) || id <= 0)
            return retRefusal(req, res, { status: 400, code: 'bad_employee', expose: true });
        const hold = req.body && (req.body.hold === true || req.body.hold === 'true');
        try {
            res.json(
                await DSR.setLegalHold(id, {
                    hold,
                    reason: req.body && req.body.reason,
                    actorRef: retActor(req.user),
                })
            );
        } catch (err) {
            if (!retRefusal(req, res, err)) throw err;
        }
    })
);

// ===================== Sovereign AI copilot (RBAC-scoped) ===================
// Rate-limited: each ask fans out to ~9 aggregate queries plus (optionally) a
// bounded outbound LLM call, so cap it like the other expensive write endpoints.
router.post(
    '/copilot/ask',
    requireManagerOrAdmin,
    writeActionLimiter,
    ah(async (req, res) => {
        const q = String(req.body.question || '').slice(0, 500);
        if (!q) return res.status(400).json({ ok: false, error: 'question required' });
        const out = await Copilot.ask(req.user, q);
        // Transparency label, in the session language (EU AI Act): every answer
        // carries it, the UI shows it next to the answer.
        if (out.disclaimerKey && typeof req.t === 'function') {
            out.disclaimer = req.t(out.disclaimerKey, { defaultValue: out.disclaimer });
        }
        res.json({ ok: true, ...out });
    })
);
router.get(
    '/copilot/status',
    requireSuperAdmin,
    ah(async (req, res) => {
        res.json({ ok: true, ...(await Copilot.llmStatus()) });
    })
);

// ===================== Audit chain integrity (superadmin) ===================
router.get(
    '/audit/verify',
    requireSuperAdmin,
    ah(async (req, res) => {
        // Recompute each hashed row from the prior row's hash + payload; any mismatch
        // = the append-only audit log was tampered with (even via direct DB access).
        const bad = await db.all(
            `WITH chk AS (
           SELECT id,
             row_hash, prev_hash,
             LAG(row_hash) OVER (ORDER BY id) AS expected_prev,
             encode(digest(
               coalesce(LAG(row_hash) OVER (ORDER BY id), '') || '|' ||
               coalesce(admin_id::text, '') || '|' || coalesce(action, '') || '|' ||
               coalesce(entity_type, '') || '|' || coalesce(entity_id::text, '') || '|' ||
               coalesce(details::text, '') || '|' || coalesce(created_at::text, ''), 'sha256'), 'hex') AS recomputed
           FROM system_logs WHERE row_hash IS NOT NULL
         )
         SELECT id FROM chk
         WHERE row_hash <> recomputed OR (prev_hash IS DISTINCT FROM expected_prev AND id <> (SELECT MIN(id) FROM system_logs WHERE row_hash IS NOT NULL))
         ORDER BY id LIMIT 10`
        );
        const total = await db.get(
            'SELECT COUNT(*) AS n FROM system_logs WHERE row_hash IS NOT NULL'
        );
        res.json({
            ok: true,
            hashedRows: Number(total.n),
            intact: bad.length === 0,
            brokenAt: bad.map((r) => Number(r.id)),
        });
    })
);

module.exports = router;
