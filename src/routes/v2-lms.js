'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireEmployeeOrManager, wantsJson } = require('../middleware/auth');
const LmsService = require('../services/LmsService');
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

const { listProviders } = require('../integrations/lms');
const db = require('../config/database');
const ah = require('../utils/asyncHandler');

// The admins(id) to record for whoever is acting — see utils/actorAdminId.
// The local version fell back to the built-in 'admin' account for anyone who
// was not an admin, so every act by a MANAGER was attributed to the system
// administrator. NULL beats a false name.
const { actorAdminId } = require('../utils/actorAdminId');

// True when the actor governs (or is) the target employee, per RBAC scope.
async function inScope(user, employeeId) {
    if (RBACService.isSuperAdmin && RBACService.isSuperAdmin(user)) return true;
    const emps = await RBACService.getFilteredEmployees(user);
    return emps.some((e) => Number(e.id) === Number(employeeId));
}

// Org-global LMS config (connector credentials, webhook secrets, course mappings,
// syncs) is an ADMIN function: require the configure_lms grant (or superadmin), NOT
// mere manager status. The router-level guard admits managers only so they can use
// the per-employee launch/assign actions; it must not let them alter org-wide config.
function requireConfigureLms(req, res, next) {
    if (RBACService.isSuperAdmin(req.user) || RBACService.hasPermission(req.user, 'configure_lms'))
        return next();
    return res.status(403).json({ ok: false, error: 'Requires the configure_lms permission' });
}

// ---- Admin config page -----------------------------------------------------
// The page is a pure org-config console (providers, course→skill mapping, sync,
// manual completion). Every control needs configure_lms, so gate the page itself —
// otherwise a plain manager lands on a screen where every button 403s.
router.get(
    '/',
    requireAuth,
    requireConfigureLms,
    ah(async (req, res) => {
        const integrations = await LmsService.listIntegrations();
        const courses = await LmsService.listCourses();
        const skills = await db.all('SELECT id, name FROM skills ORDER BY name');
        // the page had a bare "IDevelop" <title>.
        res.render('pages/lms/index', {
            integrations,
            courses,
            skills,
            providers: listProviders(),
            title: req.t ? req.t('chrome:pt_lms_hub') : 'Learning hub',
        });
    })
);

// ---- Integration config ----------------------------------------------------
router.post(
    '/integration',
    requireAuth,
    requireConfigureLms,
    ah(async (req, res) => {
        const provider = String(req.body.provider || '').toLowerCase();
        if (!listProviders().includes(provider))
            return res.status(400).json({ ok: false, error: 'unknown provider' });
        const row = await LmsService.upsertIntegration(provider, {
            name: req.body.name,
            baseUrl: req.body.baseUrl,
            authConfig: req.body.authConfig,
            syncSchedule: req.body.syncSchedule,
            webhookSecret: req.body.webhookSecret,
            enabled: req.body.enabled,
        });
        res.json({ ok: true, integration: row });
    })
);

router.post(
    '/integration/:provider/test',
    requireAuth,
    requireConfigureLms,
    ah(async (req, res) => {
        if (!listProviders().includes(String(req.params.provider).toLowerCase())) {
            return res.status(400).json({ ok: false, error: 'unknown provider' });
        }
        try {
            const { connector } = await LmsService._getConnectorFor(req.params.provider);
            res.json({ ok: true, result: await connector.testConnection() });
        } catch (e) {
            res.status(400).json({ ok: false, error: e.message });
        }
    })
);

router.post(
    '/integration/:provider/sync',
    requireAuth,
    requireConfigureLms,
    ah(async (req, res) => {
        if (!listProviders().includes(String(req.params.provider).toLowerCase())) {
            return res.status(400).json({ ok: false, error: 'unknown provider' });
        }
        const out = await LmsService.syncCatalog(req.params.provider);
        res.json({ ok: true, ...out });
    })
);

// ---- Catalog + mapping -----------------------------------------------------
router.get(
    '/courses',
    requireAuth,
    ah(async (req, res) => {
        res.json({ ok: true, list: await LmsService.listCourses(req.query.provider || null) });
    })
);

router.post(
    '/course',
    requireAuth,
    requireConfigureLms,
    ah(async (req, res) => {
        const provider = String(req.body.provider || '').toLowerCase();
        if (!provider || !req.body.externalId || !req.body.title) {
            return res
                .status(400)
                .json({ ok: false, error: 'provider, externalId, title required' });
        }
        const row = await LmsService.upsertCourse(provider, {
            externalId: req.body.externalId,
            title: req.body.title,
            url: req.body.url,
            type: req.body.type,
            durationMinutes: req.body.durationMinutes,
        });
        res.json({ ok: true, id: row.id });
    })
);

router.get(
    '/course/:id/mappings',
    requireAuth,
    ah(async (req, res) => {
        res.json({ ok: true, list: await LmsService.listMappings(Number(req.params.id)) });
    })
);

router.post(
    '/course/:id/map',
    requireAuth,
    requireConfigureLms,
    ah(async (req, res) => {
        const skillId = Number(req.body.skillId);
        if (!skillId) return res.status(400).json({ ok: false, error: 'skillId required' });
        const row = await LmsService.mapCourseSkill(
            Number(req.params.id),
            skillId,
            req.body.levelDelta,
            await actorAdminId(req.user)
        );
        res.json({ ok: true, id: row.id });
    })
);

// ---- Outbound assignment ---------------------------------------------------
router.post(
    '/assign',
    requireAuth,
    ah(async (req, res) => {
        const employeeId = Number(req.body.employeeId);
        const courseId = Number(req.body.courseId);
        if (!employeeId || !courseId)
            return res.status(400).json({ ok: false, error: 'employeeId and courseId required' });
        if (!(await inScope(req.user, employeeId)))
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        const row = await LmsService.assignCourse(employeeId, courseId, {
            assignedBy: await actorAdminId(req.user),
            sourceActionId: req.body.sourceActionId ? Number(req.body.sourceActionId) : null,
            dueAt: req.body.dueAt || null,
        });
        // The vendor push outcome travels back with the response: an assignment that
        // never reached the LMS is a half-done job, not a success.
        res.json({
            ok: true,
            id: row.id,
            status: row.status,
            dueAt: row.dueAt || null,
            pushState: row.pushState,
            pushError: row.pushError || null,
        });
    })
);

// ---- Curation queue: in-demand skills with no mapped course ----------------
router.get(
    '/curation',
    requireAuth,
    ah(async (req, res) => {
        res.json({ ok: true, list: await LmsService.curationQueue() });
    })
);

// ---- LTI launch initiation (redirect user to the Tool's OIDC login) --------
router.get(
    '/lti/:provider/launch',
    requireAuth,
    ah(async (req, res) => {
        // Resolve the launching person to a real employee identity. Admin accounts
        // are not learners, so block them (the LMS Tool can't resolve their `sub`).
        let employee = null;
        if (req.user.userType === 'manager') {
            const e = await db.get('SELECT id, email FROM employees WHERE id = ?', [
                Number(req.user.id),
            ]);
            if (e) employee = { id: e.id, email: e.email };
        } else if (req.query.employeeId) {
            // Launching on behalf of another employee requires scope over them —
            // otherwise a signed LTI id_token could impersonate any employee.
            if (!(await inScope(req.user, req.query.employeeId))) {
                return res.status(403).json({
                    ok: false,
                    error: 'Not authorized to launch on behalf of this employee',
                });
            }
            const e = await db.get('SELECT id, email FROM employees WHERE id = ?', [
                Number(req.query.employeeId),
            ]);
            if (e) employee = { id: e.id, email: e.email };
        }
        if (!employee || !employee.email) {
            return res.status(400).json({
                ok: false,
                error: 'an employee with an email is required to launch a course',
            });
        }
        const courseId = Number(req.query.courseId);
        const course = courseId
            ? await db.get('SELECT external_id FROM lms_courses WHERE id = ?', [courseId])
            : null;
        const courseRef = course ? course.externalId : req.query.courseRef || '';
        const { connector } = await LmsService._getConnectorFor(req.params.provider);
        const url =
            typeof connector.getLaunchUrl === 'function'
                ? connector.getLaunchUrl(employee, courseRef)
                : null;
        if (!url) return res.status(400).json({ ok: false, error: 'provider has no launch URL' });
        // Only ever redirect to an absolute http(s) URL — never a javascript:/data:/relative
        // target — even though the base comes from trusted provider config (defence in depth).
        try {
            const scheme = new URL(url).protocol;
            if (scheme !== 'http:' && scheme !== 'https:') throw new Error('bad scheme');
        } catch (_) {
            return res.status(400).json({ ok: false, error: 'invalid launch URL' });
        }
        // Launching IS evidence the learner started: assigned → in_progress.
        if (courseId) await LmsService.recordLaunch(employee.id, courseId).catch(() => null);
        res.redirect(url);
    })
);

// ---- Manual completion ingest (admin testing without a live LMS) -----------
// UPSERTs skill_assessments for the target employee, so it must be an ADMIN action
// (configure_lms). Real learner completions arrive via the provider-authenticated
// webhook (ingestWebhook); without this gate any manager could forge a completion
// and raise ANY employee's official skill level (IDOR).
router.post(
    '/completion',
    requireAuth,
    requireConfigureLms,
    ah(async (req, res) => {
        const provider = String(req.body.provider || '').toLowerCase();
        if (!provider) return res.status(400).json({ ok: false, error: 'provider required' });
        const out = await LmsService.ingestCompletion(provider, {
            externalRef: req.body.externalRef || 'manual|' + Date.now(),
            employeeId: req.body.employeeId ? Number(req.body.employeeId) : null,
            employeeEmail: req.body.employeeEmail || null,
            externalCourseId: req.body.externalCourseId || null,
            completedAt: req.body.completedAt || null,
            score: req.body.score != null ? Number(req.body.score) : null,
            raw: { source: 'manual', by: req.user && req.user.id },
        });
        res.json({ ok: true, ...out });
    })
);

// ---- Proposed skill uplifts awaiting a named decision ----------------------
// HR policy §10: a finished course is EVIDENCE, not an automatic elevation of
// the official level. Ingestion therefore parks the completion at
// `review_reason = 'awaiting_supervisor'` and these three routes are where a
// person who governs the employee turns it into a level, or refuses it.
//
// `requireAuth` only: a supervisor is an ordinary EMPLOYEE, so a permission
// slug would lock out exactly the people the rule asks to decide. The
// authority test is per-employee and lives in LmsService._mayDecide.
router.get(
    '/uplifts',
    requireAuth,
    ah(async (req, res) => {
        const uplifts = await LmsService.pendingUplifts(req.user);
        // The notification deep-links here, so a human must get a PAGE. Answering
        // JSON to a browser would hand the supervisor a wall of braces.
        if (wantsJson(req)) return res.json({ ok: true, uplifts });
        return res.render('pages/lms/uplifts', {
            uplifts,
            title: req.t ? req.t('chrome:pt_lms_uplifts') : 'Training completions to validate',
        });
    })
);

const decide = (decision) =>
    ah(async (req, res) => {
        try {
            const out = await LmsService.decideUplift(req.user, Number(req.params.id), decision);
            res.json({ ok: true, ...out });
        } catch (e) {
            const status = e && e.status ? e.status : 500;
            res.status(status).json({
                ok: false,
                error: status === 500 ? 'internal_error' : e.message,
            });
        }
    });
router.post('/uplifts/:id/accept', requireAuth, decide('accept'));
router.post('/uplifts/:id/decline', requireAuth, decide('decline'));

// ---- Learner surface (mounted at /employee, OUTSIDE the V2/admin gate) -----
// An employee was told "a training course was assigned to you", followed the
// link to /v2/lms and was refused — that router requires manager status or
// configure_lms, and only exists when V2_FEATURES=1. Meanwhile lms_courses.url
// was captured on every sync and never shown to anybody. This is the missing
// end of the loop: the learner's own list, with the link that actually opens
// the course.
//
// Every query is keyed on req.user.id. No employee id is ever accepted from the
// request, so there is no id to tamper with.
const learnerRouter = express.Router();

/** The signed-in person as a learner. Admin accounts are not learners. */
function learnerId(req) {
    return req.user && (req.user.userType === 'employee' || req.user.userType === 'manager')
        ? Number(req.user.id)
        : null;
}

learnerRouter.get(
    '/my-learning',
    requireEmployeeOrManager,
    ah(async (req, res) => {
        const items = await LmsService.listForEmployee(learnerId(req));
        // « Suggestions pour mes écarts » — the top three from
        // SkillsIntelligenceService.recommendLearning, for the signed-in person
        // only (never an id from the request). Never fails the page: an empty
        // list is the empty state.
        const suggestions = await require('../services/EmployeeGrowthService').learningSuggestions(
            learnerId(req),
            3
        );
        res.render('pages/employee/my-learning', {
            title: req.t ? req.t('lms:ml_title') : 'My learning',
            items,
            suggestions,
        });
    })
);

// Open the course at the provider. Goes through the platform so that opening it
// counts as evidence (assigned → in_progress) — the reason the status column
// stopped being a permanent 'assigned'.
learnerRouter.get(
    '/my-learning/:id/open',
    requireEmployeeOrManager,
    ah(async (req, res) => {
        const empId = learnerId(req);
        const enr = await LmsService.getOwnEnrollment(empId, req.params.id);
        // Not found vs not yours are the same answer: an enrolment that is not the
        // caller's own must not be probeable by id.
        if (!enr) {
            req.flash('error', req.t ? req.t('lms:ml_not_found') : 'Learning item not found');
            return res.redirect('/employee/my-learning');
        }
        let target = null;
        try {
            const u = new URL(String(enr.courseUrl || ''));
            if (u.protocol === 'http:' || u.protocol === 'https:') target = u.href;
        } catch (_) {
            target = null;
        }
        if (!target) {
            req.flash(
                'error',
                req.t
                    ? req.t('lms:ml_no_url_flash')
                    : 'This course has no link from the provider yet.'
            );
            return res.redirect('/employee/my-learning');
        }
        await LmsService.recordLaunch(empId, Number(enr.courseId)).catch(() => null);
        res.redirect(target);
    })
);

module.exports = router;
module.exports.learnerRouter = learnerRouter;
