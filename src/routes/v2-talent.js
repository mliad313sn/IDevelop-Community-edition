'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { writeActionLimiter } = require('../middleware/rateLimiter');
const TalentService = require('../services/TalentService');
const DevelopmentTriggerService = require('../services/DevelopmentTriggerService');
const BiasDetectionService = require('../services/BiasDetectionService');
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

const { BOX_DEFINITIONS, RECOMMENDATIONS, titleForBox } = require('../services/TalentDefinitions');
const db = require('../config/database');
const ah = require('../utils/asyncHandler');

// Helper — resolve the cycle for a mutating call: an explicit valid cycleId
// wins, otherwise fall back to the open cycle. Returns null when neither
// exists so callers can 400 instead of sending NaN to a bigint column.
async function resolveCycleId(req) {
    const n = Number(req.body?.cycleId ?? req.query?.cycle);
    if (Number.isFinite(n) && n > 0) return n;
    const open = await db.get(
        `SELECT id FROM assessment_cycles WHERE status = 'open' ORDER BY closes_at LIMIT 1`
    );
    return open ? Number(open.id) : null;
}

// Confidential talent data: a user may only rate/place employees within their
// span of control (super → all; local admin → scope; manager → reports).
// A VIEWER NEVER ACTS (the mount is requireManagerOrAdmin — a guard by the shape
// of the role). The line of the person behind an admin account counts, as in
// RBACService.scopeFilter.
async function canManageEmployee(user, employeeId) {
    if (RBACService.isViewer(user)) return false;
    if (RBACService.isSuperAdmin(user)) return true;
    const emps = await RBACService.getFilteredEmployees(user);
    if (emps.some((e) => Number(e.id) === Number(employeeId))) return true;
    if (user && user.userType === 'admin') {
        const line = await require('../services/GovernanceService').lineAuthorityEmployeeIds(user);
        return line.some((id) => Number(id) === Number(employeeId));
    }
    return false;
}

// talent_ratings.reviewer_id is a foreign key to EMPLOYEES and
// talent_placements.placed_by to ADMINS: the two id spaces overlap, so
// `req.user.id` written blindly named a stranger or failed the FK. The reviewer
// is the person behind the account; the placer is the admin account, or nobody.
const reviewerIdFor = (user) => require('../services/GovernanceService').actingPersonId(user);
const placedByFor = (user) =>
    user && user.userType === 'admin' && user.id != null ? user.id : null;

// Helper — assemble the full grid payload used by the page + JSON API.
// Scoped to the viewer's span of control (super → all; manager → reports;
// local admin → their scope) so confidential talent data isn't over-shared.
async function buildGridState(cycleId, user) {
    const cycle = cycleId
        ? await db.get(`SELECT id, code, label, status FROM assessment_cycles WHERE id = ?`, [
              cycleId,
          ])
        : await db.get(
              `SELECT id, code, label, status FROM assessment_cycles WHERE status = 'open' ORDER BY closes_at LIMIT 1`
          );
    const activeCycleId = cycle ? cycle.id : null;

    const sc = user
        ? await RBACService.scopeFilter(user, { empAlias: 'e' })
        : { clause: '', params: [] };
    const employees = await db.all(
        `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.role_id, e.department_id,
                r.name AS role_name, d.name AS department_name
         FROM employees e
         LEFT JOIN roles r       ON r.id = e.role_id
         LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.is_active = true ${sc.clause}
         ORDER BY e.last_name, e.first_name`,
        sc.params
    );

    // Confidential ratings/placements must be constrained to the SAME scoped employee
    // set as `employees` above — otherwise a scoped manager/local-admin reading /state
    // sees performance/potential/box/tier/override_reason for the whole org (IDOR).
    const scopedIds = employees.map((e) => Number(e.id));
    const ratings =
        activeCycleId && scopedIds.length
            ? await db.all(
                  `SELECT id, employee_id, reviewer_id, reviewer_role, performance, potential, created_at
             FROM talent_ratings WHERE cycle_id = ? AND employee_id = ANY(?) ORDER BY created_at DESC`,
                  [activeCycleId, scopedIds]
              )
            : [];

    const placements =
        activeCycleId && scopedIds.length
            ? await db.all(
                  `SELECT employee_id, cycle_id, box, tier, confidence, source, override_reason
             FROM talent_placements WHERE cycle_id = ? AND employee_id = ANY(?)`,
                  [activeCycleId, scopedIds]
              )
            : [];

    return { cycle, employees, ratings, placements };
}

// ---- Pages ----
// Consolidated: the 9-box is the V1 workflow grid (/talent/nine-box) — the one
// with draft→approve + PIP/IDP auto-triggers. This legacy V2 page now redirects
// there so there is a single 9-box in the app. (The /state + APIs below remain
// for any programmatic callers but are no longer surfaced in the UI.)
router.get('/9box-grid', requireAuth, (req, res) => res.redirect('/talent/nine-box'));

// ---- Data APIs ----
router.get(
    '/state',
    requireAuth,
    ah(async (req, res) => {
        res.json(await buildGridState(req.query.cycle ? Number(req.query.cycle) : null, req.user));
    })
);

router.get(
    '/recommendations',
    requireAuth,
    ah(async (req, res) => {
        res.json({ boxDefinitions: BOX_DEFINITIONS, recommendations: RECOMMENDATIONS });
    })
);

router.post(
    '/ratings',
    requireAuth,
    ah(async (req, res) => {
        if (!(await canManageEmployee(req.user, Number(req.body.employeeId)))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        const reviewerId = await reviewerIdFor(req.user);
        if (reviewerId == null) {
            return res.status(400).json({
                ok: false,
                error: 'Only a person can rate: this administration account is linked to no employee.',
            });
        }
        const id = await TalentService.recordRating({
            employeeId: Number(req.body.employeeId),
            reviewerId,
            reviewerRole: req.body.reviewerRole,
            performance: req.body.performance,
            potential: req.body.potential,
            cycleId: req.body.cycleId ? Number(req.body.cycleId) : null,
        });
        if (req.body.cycleId) {
            try {
                await TalentService.computePlacement({
                    employeeId: Number(req.body.employeeId),
                    cycleId: Number(req.body.cycleId),
                });
            } catch (_) {
                /* recompute is best-effort */
            }
        }
        res.json({ ok: true, id });
    })
);

router.post(
    '/placements/:employeeId/compute',
    requireAuth,
    ah(async (req, res) => {
        if (!(await canManageEmployee(req.user, Number(req.params.employeeId)))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        const cycleId = await resolveCycleId(req);
        if (!cycleId)
            return res
                .status(400)
                .json({ ok: false, error: 'cycleId required (no open assessment cycle found)' });
        const placement = await TalentService.computePlacement({
            employeeId: Number(req.params.employeeId),
            cycleId,
        });
        res.json({ ok: true, placement });
    })
);

router.post(
    '/placements/:employeeId/override',
    requireAuth,
    writeActionLimiter,
    ah(async (req, res) => {
        if (!(await canManageEmployee(req.user, Number(req.params.employeeId)))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        const cycleId = await resolveCycleId(req);
        if (!cycleId)
            return res
                .status(400)
                .json({ ok: false, error: 'cycleId required (no open assessment cycle found)' });
        await TalentService.override({
            employeeId: Number(req.params.employeeId),
            cycleId,
            box: req.body.box,
            tier: req.body.tier,
            reason: req.body.reason,
            placedBy: placedByFor(req.user),
        });
        // Red ⇒ PIP + coaching; blue ⇒ IDP proposal. Best-effort: never block placement.
        let autoTrigger = null;
        try {
            const { performance, potential } = DevelopmentTriggerService.levelsFromBox(
                req.body.box
            );
            autoTrigger = await DevelopmentTriggerService.triggerForPlacement(
                req.user,
                {
                    employeeId: Number(req.params.employeeId),
                    performance,
                    potential,
                    label: req.body.box,
                },
                req
            );
        } catch (e) {
            autoTrigger = { error: e && e.message ? e.message : 'auto-trigger failed' };
            // A mandated PIP/IDP that failed to create must NOT be silent — surface it in
            // the response (autoTrigger.error) AND log at warn so ops can see the gap.
            console.warn(
                `[9box] development auto-trigger failed for employee ${req.params.employeeId} (box ${req.body.box}): ${autoTrigger.error}`
            );
        }
        res.json({ ok: true, autoTrigger });
    })
);

// Criteria-based automated placement (4 sliders 0..100) — mirrors nine-box-tool-enhanced.html
router.post(
    '/placements/:employeeId/from-criteria',
    requireAuth,
    ah(async (req, res) => {
        if (!(await canManageEmployee(req.user, Number(req.params.employeeId)))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        const onduty = Number(req.body.onduty || 0);
        const teamwork = Number(req.body.teamwork || 0);
        const learning = Number(req.body.learning || 0);
        const leadership = Number(req.body.leadership || 0);
        const perfScore = (onduty + teamwork) / 2;
        const potScore = (learning + leadership) / 2;
        const perf = perfScore >= 70 ? 'high' : perfScore >= 40 ? 'medium' : 'low';
        const pot = potScore >= 70 ? 'high' : potScore >= 40 ? 'medium' : 'low';
        const box = `${pot}-${perf}`;
        const tier =
            perfScore + potScore >= 140 ? 'up' : perfScore + potScore >= 80 ? 'mid' : 'low';
        const cycleId = await resolveCycleId(req);
        if (!cycleId)
            return res
                .status(400)
                .json({ ok: false, error: 'cycleId required (no open assessment cycle found)' });
        await TalentService.override({
            employeeId: Number(req.params.employeeId),
            cycleId,
            box,
            tier,
            reason: `Criteria placement (onduty=${onduty}, teamwork=${teamwork}, learning=${learning}, leadership=${leadership})`,
            placedBy: placedByFor(req.user),
        });
        let autoTrigger = null;
        try {
            autoTrigger = await DevelopmentTriggerService.triggerForPlacement(
                req.user,
                {
                    employeeId: Number(req.params.employeeId),
                    performance: perf,
                    potential: pot,
                    label: box,
                },
                req
            );
        } catch (e) {
            autoTrigger = { error: e && e.message ? e.message : 'auto-trigger failed' };
            // A mandated PIP/IDP that failed to create must NOT be silent — surface it in
            // the response (autoTrigger.error) AND log at warn so ops can see the gap.
            console.warn(
                `[9box] development auto-trigger failed for employee ${req.params.employeeId} (box ${req.body.box}): ${autoTrigger.error}`
            );
        }
        res.json({ ok: true, box, tier, perf, pot, perfScore, potScore, autoTrigger });
    })
);

router.post(
    '/bias/scan',
    requireAuth,
    writeActionLimiter,
    ah(async (req, res) => {
        // The scan is ORG-WIDE: it compares every site, department and group of
        // the cycle's placements and returns their z-scores. Any manager could
        // run it and read the talent distribution of units they have no
        // clearance for (3.23.17, B-7). Unrestricted callers only.
        if (!RBACService.isSuperAdmin(req.user)) {
            return res.status(403).json({
                ok: false,
                error: 'Not authorized: the bias scan covers the whole organisation (SuperAdmin only)',
            });
        }
        const cycleId = await resolveCycleId(req);
        if (!cycleId)
            return res
                .status(400)
                .json({ ok: false, error: 'cycleId required (no open assessment cycle found)' });
        const out = await BiasDetectionService.runForCycle(cycleId);
        res.json({ ok: true, ...out });
    })
);

// Per-employee 9-box report (drives the export / preview panel)
router.get(
    '/employees/:id/report',
    requireAuth,
    ah(async (req, res) => {
        const empId = Number(req.params.id);
        // Confidential 9-box data — only within the caller's span of control
        // (sibling rate/place routes all check this; this read must too).
        if (!(await canManageEmployee(req.user, empId))) {
            return res.status(403).json({ ok: false, error: notAuthorizedForEmployee(req) });
        }
        const cycleId = req.query.cycle
            ? Number(req.query.cycle)
            : (
                  await db.get(
                      `SELECT id FROM assessment_cycles WHERE status='open' ORDER BY closes_at LIMIT 1`
                  )
              )?.id;
        const employee = await db.get(
            `SELECT e.id, e.first_name, e.last_name, e.employee_number,
                r.name AS role_name, d.name AS department_name, s.name AS site_name
         FROM employees e
         LEFT JOIN roles r       ON r.id = e.role_id
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN sites s       ON s.id = e.site_id
         WHERE e.id = ?`,
            [empId]
        );
        // No "? IS NULL" here: with a null param PG cannot infer $n's type and
        // errors — branch in JS instead when no cycle is open/selected.
        const ratings = cycleId
            ? await db.all(
                  `SELECT reviewer_role, performance, potential, created_at
             FROM talent_ratings
             WHERE employee_id = ? AND cycle_id = ?
             ORDER BY created_at DESC`,
                  [empId, cycleId]
              )
            : await db.all(
                  `SELECT reviewer_role, performance, potential, created_at
             FROM talent_ratings
             WHERE employee_id = ?
             ORDER BY created_at DESC`,
                  [empId]
              );
        const placement = await db.get(
            `SELECT box, tier, confidence, source, override_reason
         FROM talent_placements WHERE employee_id = ? AND cycle_id = ?`,
            [empId, cycleId]
        );
        const box = placement ? titleForBox(placement.box) : null;
        const recs = box ? RECOMMENDATIONS[box.title] || [] : [];
        res.json({ employee, ratings, placement, box, recommendations: recs });
    })
);

module.exports = router;
