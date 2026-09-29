'use strict';

/**
 * TeamRosterService — the "My team" roster on the manager dashboard.
 *
 * ONE ROW PER DIRECT REPORT, and only direct reports: the population is the
 * reporting line itself (`supervisor_id`, or `manager_id` with
 * `manager_type = 'employee'` — the same discriminated pair
 * EmployeeModel.governsAnyone / findGovernedIds read), resolved for the PERSON
 * behind the account (GovernanceService.actingPersonId). An N+2 report, a
 * stranger whose employee id happens to equal an admin id, a leaver: none of
 * them appears. Nobody is their own report.
 *
 * Every figure keeps "not measured" apart from zero:
 *   - readiness is ReadinessService's canonical assessed-only percentage, with
 *     its measured denominator (assessed / required). No requirement measured →
 *     `readinessPercent: null`, which the page prints as "not measured", never 0;
 *   - critical gaps count only MEASURED critical requirements (or a lapsed
 *     certificate) — a requirement nobody rated is not a gap, it is unmeasured;
 *   - the last one-to-one is null when none was ever held, and the whole
 *     column is `oneOnOneMeasured: false` if check-ins could not be read.
 */

const db = require('../config/database');
const GovernanceService = require('./GovernanceService');
const ReadinessService = require('./ReadinessService');

const REVIEW_STATES = ['submitted', 'under_review', 'reviewed', 'arbitration'];

/**
 * Collapse the person's self-assessment rows (counts by workflow state) into
 * ONE chip, most urgent first.
 *   to_review          something is waiting for the reviewer
 *   changes_requested  the reviewer asked the employee for changes
 *   in_progress        the employee has drafts
 *   completed          everything is decided (approved / rejected)
 *   not_started        no self-assessment at all
 */
function assessmentChip(counts) {
    const c = counts || {};
    const n = (k) => Number(c[k] || 0);
    if (REVIEW_STATES.some((s) => n(s) > 0)) return 'to_review';
    if (n('changes_requested') > 0) return 'changes_requested';
    if (n('draft') > 0) return 'in_progress';
    const total = Object.keys(c).reduce((a, k) => a + n(k), 0);
    return total > 0 ? 'completed' : 'not_started';
}

/** Critical gaps that were actually MEASURED (or degraded by a lapsed certificate). */
function criticalGapCount(readiness) {
    if (!readiness || !Array.isArray(readiness.gaps)) return 0;
    return readiness.gaps.filter((g) => g.isCritical && (g.isAssessed || g.certLapsed)).length;
}

/**
 * The ONE next action for a row, most useful first. Each points at a page the
 * manager can open (all manager-reachable routes).
 */
function nextAction(row) {
    if (row.state === 'to_review')
        return { key: 'review', href: '/supervisor/self-assessment-reviews' };
    if (row.criticalGaps > 0) return { key: 'coaching', href: '/coaching/plans' };
    if (row.state === 'not_started' || row.state === 'in_progress')
        return { key: 'remind', href: '/supervisor/self-assessment-reviews' };
    if (row.readinessPercent === null || row.readinessPercent === undefined)
        return { key: 'gaps', href: '/supervisor/gap-analysis' };
    return { key: 'profile', href: `/employees/${Number(row.employeeId)}` };
}

class TeamRosterService {
    /** Active direct reports of the person behind `user` (never themselves). */
    async directReports(user) {
        const personId = await GovernanceService.actingPersonId(user);
        if (personId == null) return [];
        return db.all(
            `SELECT id, employee_number, first_name, last_name, role_id
               FROM employees
              WHERE is_active = true AND id <> ?
                AND (supervisor_id = ? OR (manager_id = ? AND manager_type = 'employee'))
              ORDER BY last_name, first_name, id`,
            [personId, personId, personId]
        );
    }

    /** The roster rows for the manager dashboard. */
    async forManager(user) {
        const reports = await this.directReports(user);
        if (!reports.length) return { rows: [], oneOnOneMeasured: true };
        const ids = reports.map((r) => Number(r.id));

        const readiness = await ReadinessService.calculateReadinessMap(
            reports.map((r) => ({ id: Number(r.id), roleId: r.roleId }))
        );

        const stateRows = await db.all(
            `SELECT employee_id, workflow_state, COUNT(*)::int AS n
               FROM self_assessments
              WHERE employee_id = ANY(?)
              GROUP BY employee_id, workflow_state`,
            [ids]
        );
        const counts = {};
        for (const s of stateRows) {
            const k = Number(s.employeeId);
            (counts[k] = counts[k] || {})[s.workflowState] = Number(s.n);
        }

        // Last one-to-one actually HELD. feedback_notes has no one-to-one kind,
        // so check_ins (kind 'one_on_one', status 'completed') is the record.
        let lastOneOnOne = {};
        let oneOnOneMeasured = true;
        try {
            const rows = await db.runInSavepoint(() =>
                db.all(
                    `SELECT employee_id, MAX(COALESCE(occurred_at, scheduled_at)) AS at
                       FROM check_ins
                      WHERE employee_id = ANY(?) AND kind = 'one_on_one' AND status = 'completed'
                      GROUP BY employee_id`,
                    [ids]
                )
            );
            for (const r of rows) lastOneOnOne[Number(r.employeeId)] = r.at;
        } catch (_) {
            lastOneOnOne = {};
            oneOnOneMeasured = false;
        }

        const rows = reports.map((r) => {
            const id = Number(r.id);
            const rd = readiness[id] || null;
            const row = {
                employeeId: id,
                employeeNumber: r.employeeNumber,
                firstName: r.firstName,
                lastName: r.lastName,
                state: assessmentChip(counts[id]),
                pendingReview: REVIEW_STATES.reduce(
                    (a, s) => a + Number((counts[id] || {})[s] || 0),
                    0
                ),
                readinessPercent:
                    rd && rd.readinessPercent !== null && rd.readinessPercent !== undefined
                        ? Number(rd.readinessPercent)
                        : null,
                assessedRequired: rd ? Number(rd.assessedRequired || 0) : 0,
                totalRequired: rd ? Number(rd.totalRequired || 0) : 0,
                criticalGaps: criticalGapCount(rd),
                lastOneOnOne: oneOnOneMeasured ? lastOneOnOne[id] || null : null,
            };
            row.next = nextAction(row);
            return row;
        });
        return { rows, oneOnOneMeasured };
    }
}

const service = new TeamRosterService();
service.assessmentChip = assessmentChip;
service.criticalGapCount = criticalGapCount;
service.nextAction = nextAction;
module.exports = service;
