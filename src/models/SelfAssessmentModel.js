const BaseModel = require('./BaseModel');
const db = require('../config/database');

class SelfAssessmentModel extends BaseModel {
    constructor() {
        super('selfAssessments');
    }

    async findByEmployeeId(employeeId, status = null) {
        let sql = `
            SELECT sa.*, s.name as skillName, d.name as domainName
            FROM selfAssessments sa
            INNER JOIN skills s ON sa.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE sa.employeeId = ?
        `;
        const params = [employeeId];

        if (status) {
            sql += ` AND sa.status = ?`;
            params.push(status);
        }

        sql += ` ORDER BY d.name, s.name`;

        return await db.all(sql, params);
    }

    async findByEmployeeIdAndSkillId(employeeId, skillId, status = null) {
        let sql = `
            SELECT * FROM selfAssessments 
            WHERE employeeId = ? AND skillId = ?
        `;
        const params = [employeeId, skillId];

        if (status) {
            sql += ` AND status = ?`;
            params.push(status);
        }

        sql += ` ORDER BY createdAt DESC LIMIT 1`;

        return await db.get(sql, params);
    }

    async submitAssessment(employeeId) {
        // Only RATED drafts are submitted. A draft with no self_rated_level is a
        // seeded worksheet row the employee has not answered — the joiner shells
        // are created exactly that way — and submitting it would file "no answer"
        // as an answer, then raise a supervisor review for a competency nobody
        // assessed. An unrated row simply stays a draft, which is what it is.
        //
        // Keep BOTH state machines in sync: the legacy `status` drives the V1
        // supervisor-review tables, while `workflow_state` drives the V2 review
        // queue (reviewQueue filters workflow_state <> 'draft'). Without the
        // second SET, submissions never appear in the manager's queue.
        return await db.run(
            `
            UPDATE selfAssessments
            SET status = 'submitted', submittedAt = CURRENT_TIMESTAMP,
                workflow_state = CASE WHEN workflow_state IN ('draft', 'changes_requested')
                                      THEN 'submitted' ELSE workflow_state END
            WHERE employeeId = ? AND status = 'draft' AND selfRatedLevel IS NOT NULL
        `,
            [employeeId]
        );
    }

    // ---- Measurement ROUNDS ---------------
    // `selfAssessments` (the view) is the CURRENT measurement of each
    // (employee, skill). Every round ever measured lives in
    // `self_assessment_rounds`; earlier rounds carry `superseded_at` and are
    // never modified or deleted. These three helpers are the only places that
    // address the rounds table by name.

    /** The CURRENT round of one (employee, skill), with its round number. */
    async findCurrentRound(employeeId, skillId) {
        return await db.get(
            `SELECT id, employee_id AS "employeeId", skill_id AS "skillId",
                    self_rated_level AS "selfRatedLevel", status,
                    workflow_state AS "workflowState", cycle_id AS "cycleId",
                    round_no AS "roundNo", notes
               FROM self_assessment_rounds
              WHERE employee_id = ? AND skill_id = ? AND superseded_at IS NULL`,
            [employeeId, skillId]
        );
    }

    /**
     * Open a NEW measurement round for one (employee, skill).
     * The round number is computed in SQL from the rounds already on file, so a
     * concurrent caller cannot hand out the same number twice, and a pair whose
     * current round was superseded by hand still numbers correctly.
     * `cycleId` NULL means the measurement was taken OFF-CAMPAIGN — dated and
     * marked as such, never counted in a campaign's completion rate.
     */
    async openRound({ employeeId, skillId, selfRatedLevel, notes = null, cycleId = null }) {
        return await db.get(
            `INSERT INTO self_assessment_rounds
                 (employee_id, skill_id, self_rated_level, notes, status, workflow_state,
                  cycle_id, locked_state, round_no)
             SELECT ?, ?, ?, ?, 'draft', 'draft', ?, 'provisional',
                    (COALESCE(MAX(r.round_no), 0) + 1)::smallint
               FROM self_assessment_rounds r
              WHERE r.employee_id = ? AND r.skill_id = ?
             RETURNING *`,
            [employeeId, skillId, selfRatedLevel, notes, cycleId, employeeId, skillId]
        );
    }

    /**
     * Every measurement round of one person, oldest first — the data behind the
     * progression page. Reads the rounds table directly (the view would only
     * ever return the current round, which is the whole point of it).
     */
    async listRounds(employeeId) {
        return await db.all(
            `SELECT r.id, r.skill_id AS "skillId", sk.name AS "skillName",
                    dom.name AS "domainName",
                    r.round_no AS "roundNo", r.self_rated_level AS "selfRatedLevel",
                    r.status::text AS status, r.workflow_state AS "workflowState",
                    r.created_at AS "createdAt", r.submitted_at AS "submittedAt",
                    r.approved_at AS "approvedAt", r.superseded_at AS "supersededAt",
                    r.cycle_id AS "cycleId", c.label AS "cycleLabel", c.code AS "cycleCode",
                    sr.supervisor_rated_level AS "supervisorRatedLevel"
               FROM self_assessment_rounds r
               JOIN skills sk ON sk.id = r.skill_id
               LEFT JOIN domains dom ON dom.id = sk.domain_id
               LEFT JOIN assessment_cycles c ON c.id = r.cycle_id
               LEFT JOIN supervisor_reviews sr ON sr.self_assessment_id = r.id
              WHERE r.employee_id = ?
              ORDER BY sk.name ASC, r.round_no ASC, r.id ASC`,
            [employeeId]
        );
    }

    async findByStatus(status) {
        return await db.all(
            `
            SELECT sa.*, 
                   e.firstName || ' ' || e.lastName as employeeName,
                   e.employeeNumber,
                   s.name as skillName,
                   d.name as domainName
            FROM selfAssessments sa
            INNER JOIN employees e ON sa.employeeId = e.id
            INNER JOIN skills s ON sa.skillId = s.id
            INNER JOIN domains d ON s.domainId = d.id
            WHERE sa.status = ?
            ORDER BY sa.submittedAt DESC
        `,
            [status]
        );
    }
}

module.exports = new SelfAssessmentModel();
