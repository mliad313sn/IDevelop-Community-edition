'use strict';

/**
 * EmployeeProgressController — an employee's assessment-cycle history and
 * progression over time (migration 57).
 *
 *   GET /employees/:id/progress            page (managers/admins, RBAC via
 *                                          checkEmployeeAccess on the route)
 *   GET /api/employees/:id/cycle-progress  JSON (same guard)
 *   GET /employee/my-progress              the signed-in person's own view
 *
 * Data: v_employee_cycle_progress (one row per campaign: participation,
 * avg self-rated vs confirmed level, net movement, readiness snapshot) +
 * v_employee_level_timeline (monthly confirmed-level trend between
 * campaigns) + self_assessment_rounds (the successive measurements of each
 * competency, with their dates — migration 113 / product decision).
 */

const db = require('../config/database');
const SelfAssessmentModel = require('../models/SelfAssessmentModel');

/**
 * The successive MEASUREMENTS of one competency, with their dates (QA lot 1,
 * product decision). Until migration 113 the product kept one row per
 * (employee, skill) and rewrote it at every new campaign, so there was never a
 * second measurement to show: this page could only ever draw campaign averages.
 * Each round is now its own dated record, so the same page can answer "level 2
 * in June, level 3 in September" per competency.
 *
 * This is NOT a second history system: it reads the very rows the assessment
 * module writes (self_assessment_rounds), the same way the campaign table above
 * reads v_employee_cycle_progress.
 *
 * Only competencies measured MORE THAN ONCE are listed — a single measurement
 * is a state, not a progression — and a competency whose rounds carry no level
 * is reported as unmeasured, never as 0.
 */
async function loadMeasures(employeeId) {
    let rounds = [];
    try {
        rounds = await SelfAssessmentModel.listRounds(employeeId);
    } catch (_) {
        return { skills: [], roundsTotal: 0 }; // pre-113 schema: page still renders
    }
    const bySkill = new Map();
    for (const r of rounds) {
        const key = String(r.skillId);
        if (!bySkill.has(key)) {
            bySkill.set(key, {
                skillId: Number(r.skillId),
                skillName: r.skillName,
                domainName: r.domainName,
                rounds: [],
            });
        }
        bySkill.get(key).rounds.push({
            id: Number(r.id),
            roundNo: Number(r.roundNo),
            // The DATE of the measurement: when it was decided, else when it was
            // submitted, else when the round was opened. All three are written
            // once and never rewritten — superseding a round does not touch them.
            measuredAt: r.approvedAt || r.submittedAt || r.createdAt,
            selfRatedLevel: r.selfRatedLevel == null ? null : Number(r.selfRatedLevel),
            supervisorRatedLevel:
                r.supervisorRatedLevel == null ? null : Number(r.supervisorRatedLevel),
            state: r.workflowState || r.status,
            cycleId: r.cycleId == null ? null : Number(r.cycleId),
            cycleLabel: r.cycleLabel || r.cycleCode || null, // null ⇒ off-campaign
            current: r.supersededAt == null,
        });
    }
    const skills = [];
    for (const s of bySkill.values()) {
        if (s.rounds.length < 2) continue;
        const measured = s.rounds.filter((x) => x.selfRatedLevel != null);
        // An absence of measurement is never a movement of 0: with fewer than
        // two measured rounds the delta is simply not available.
        s.delta =
            measured.length >= 2
                ? measured[measured.length - 1].selfRatedLevel - measured[0].selfRatedLevel
                : null;
        skills.push(s);
    }
    skills.sort((a, b) => String(a.skillName).localeCompare(String(b.skillName)));
    return { skills, roundsTotal: rounds.length };
}

/**
 * @param {number} employeeId
 *
 * v_employee_cycle_progress lists a campaign only once the person has at least
 * one self_assessments row filed in it. Somebody ENROLLED in a campaign
 * (cycle_participants, roster view) who has not started it therefore fell out
 * of the history entirely — "0 campagnes / aucune participation" on
 * /employee/my-progress while /employee/assessment-status showed them enrolled
 * in 2026-Q3 as "not started". Enrolled campaigns the view does not know about
 * are merged in here with `participation: 'not_started'`, their department-
 * designed expected_skills as the skill count, and every measurement NULL — a
 * campaign that was never started has no average and no readiness to report.
 * Draft campaigns are not enrolments the person can see yet, so they stay out.
 */
async function loadProgress(employeeId) {
    const [cycles, timeline, employee] = await Promise.all([
        db.all(
            `SELECT cycle_id AS "cycleId", cycle_code AS "cycleCode", cycle_label AS "cycleLabel",
                    opened_at AS "openedAt", closes_at AS "closesAt", cycle_status AS "cycleStatus",
                    skills_in_cycle AS "skillsInCycle", approved, in_review AS "inReview",
                    unsubmitted, rejected,
                    avg_self_rated::float AS "avgSelfRated", avg_confirmed::float AS "avgConfirmed",
                    moves, net_movement AS "netMovement",
                    readiness_pct::float AS "readinessPct", is_ready AS "isReady"
               FROM v_employee_cycle_progress
              WHERE employee_id = ?
              ORDER BY opened_at ASC`,
            [employeeId]
        ),
        db.all(
            `SELECT month, avg_level::float AS "avgLevel", assessments
               FROM v_employee_level_timeline
              WHERE employee_id = ?
              ORDER BY month ASC`,
            [employeeId]
        ),
        db.get(
            `SELECT employee_id AS id, full_name AS "fullName", department_name AS "departmentName",
                    role_name AS "roleName"
               FROM v_employee_details WHERE employee_id = ?`,
            [employeeId]
        ),
    ]);
    for (const c of cycles) c.participation = 'active';

    try {
        const enrolled = await db.all(
            `SELECT c.id AS "cycleId", c.code AS "cycleCode", c.label AS "cycleLabel",
                    c.opened_at AS "openedAt", c.closes_at AS "closesAt", c.status AS "cycleStatus",
                    s.expected_skills AS "expectedSkills"
               FROM v_cycle_participant_status s
               JOIN assessment_cycles c ON c.id = s.cycle_id
              WHERE s.employee_id = ? AND s.excluded_at IS NULL
                AND c.status <> 'draft'`,
            [employeeId]
        );
        const known = new Set(cycles.map((c) => String(c.cycleId)));
        for (const e of enrolled) {
            if (known.has(String(e.cycleId))) continue;
            const expected = Number(e.expectedSkills) || 0;
            cycles.push({
                cycleId: e.cycleId,
                cycleCode: e.cycleCode,
                cycleLabel: e.cycleLabel,
                openedAt: e.openedAt,
                closesAt: e.closesAt,
                // Raw campaign status, like every other row: the view translates
                // it (admin:cyc_status_*) and appends its own "not started" marker
                // from `participation`, so the JSON API never carries a pre-baked
                // label in one language.
                cycleStatus: e.cycleStatus,
                cycleStatusRaw: e.cycleStatus,
                participation: 'not_started',
                skillsInCycle: expected,
                approved: 0,
                inReview: 0,
                unsubmitted: expected,
                rejected: 0,
                avgSelfRated: null,
                avgConfirmed: null,
                moves: 0,
                netMovement: null,
                readinessPct: null,
                isReady: null,
            });
        }
        cycles.sort(
            (a, b) =>
                new Date(a.openedAt) - new Date(b.openedAt) || Number(a.cycleId) - Number(b.cycleId)
        );
    } catch (_) {
        // The roster view is optional (older schemas): history must still render.
    }

    // Cycle-over-cycle deltas (progression, not just state).
    for (let i = 0; i < cycles.length; i++) {
        const prev = i > 0 ? cycles[i - 1] : null;
        cycles[i].deltaAvgConfirmed =
            prev && prev.avgConfirmed != null && cycles[i].avgConfirmed != null
                ? Math.round((cycles[i].avgConfirmed - prev.avgConfirmed) * 100) / 100
                : null;
        cycles[i].deltaReadiness =
            prev && prev.readinessPct != null && cycles[i].readinessPct != null
                ? Math.round((cycles[i].readinessPct - prev.readinessPct) * 10) / 10
                : null;
    }
    const measures = await loadMeasures(employeeId);
    return { employee, cycles, timeline, measures };
}

class EmployeeProgressController {
    /** Manager/admin view of one employee (route guard: checkEmployeeAccess). */
    async page(req, res) {
        const data = await loadProgress(require('../middleware/rbac').parseStrictId(req.params.id));
        if (!data.employee) {
            req.flash('error', req.t ? req.t('flash:emp_not_found') : 'Employee not found');
            return res.redirect('/employees');
        }
        res.render('pages/employees/progress', {
            title: req.t ? req.t('chrome:pt_assessment_progression') : 'Assessment Progression',
            ...data,
            selfView: false,
        });
    }

    async data(req, res) {
        // The SAME strict parse the access guard used (A-5): the id that was
        // authorised is the id that is read, or nothing is read at all.
        const id = require('../middleware/rbac').parseStrictId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Employee ID required' });
        res.json(await loadProgress(id));
    }

    /** The signed-in employee's own progression. */
    async myPage(req, res) {
        const data = await loadProgress(Number(req.user.id));
        res.render('pages/employees/progress', {
            title: req.t ? req.t('chrome:pt_my_progression') : 'My Progression',
            ...data,
            employee: data.employee || { id: req.user.id, fullName: req.user.username || 'Me' },
            selfView: true,
        });
    }
}

module.exports = new EmployeeProgressController();
