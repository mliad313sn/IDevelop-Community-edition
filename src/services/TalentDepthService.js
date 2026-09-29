'use strict';

/**
 * TalentDepthService — calibration sessions, goal cascading (org objectives +
 * alignment), the integrated review summary, and merit recommendations. These
 * close the "performance-management-thin" gaps: a defensible calibration, an
 * overall rating that combines skills+goals+behaviors, and goal alignment.
 */
const db = require('../config/database');

// The calibration write-back goes THROUGH NineBoxService.applyCalibration (event,
// audit, mirror, auto-triggers) — the same path as a 9-box approval. Required
// lazily so the two services can be loaded in either order.
const NineBox = () => require('./NineBoxService');

// The mirror's scope columns, by calibration_sessions.scope_type. 'org' (or an
// unknown type) means no scope filter.
const SCOPE_COLUMN = { site: 'e.site_id', department: 'e.department_id', service: 'e.service_id' };

class TalentDepthService {
    // The 9 valid 9-box keys ('{potential}-{performance}'), matching BOX_DEFINITIONS.
    static VALID_BOXES = new Set([
        'high-high',
        'high-medium',
        'high-low',
        'medium-high',
        'medium-medium',
        'medium-low',
        'low-high',
        'low-medium',
        'low-low',
    ]);

    // ---- Calibration -------------------------------------------------------
    async createCalibration({
        cycleId = null,
        scopeType = 'org',
        scopeId = null,
        facilitatorAdminId = null,
        actorEmployeeId = null,
        targetDistribution = null,
    }) {
        return db.get(
            `INSERT INTO calibration_sessions (cycle_id, scope_type, scope_id, facilitator_admin_id, actor_employee_id, target_distribution)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
            [
                cycleId,
                scopeType,
                scopeId,
                facilitatorAdminId,
                actorEmployeeId,
                targetDistribution ? JSON.stringify(targetDistribution) : null,
            ]
        );
    }
    async listCalibrations() {
        return db.all(
            `SELECT cs.*, (SELECT COUNT(*) FROM calibration_adjustments a WHERE a.session_id = cs.id) AS adjustments
             FROM calibration_sessions cs WHERE cs.status <> 'cancelled' ORDER BY cs.created_at DESC`
        );
    }
    /** Record a placement adjustment (append-only, mandatory rationale). */
    async adjust(
        sessionId,
        { employeeId, fromBox, toBox, rationale, actorAdminId = null, actorEmployeeId = null }
    ) {
        if (!rationale) throw new Error('rationale is required for a calibration adjustment');
        // Validate the box vocabulary: to_box is written back to talent_placements.box
        // (consumed as '{potential}-{performance}' by bias/DEI/copilot), so a malformed
        // value would silently skew those. Reject anything outside the 9 valid boxes.
        if (!TalentDepthService.VALID_BOXES.has(String(toBox))) {
            throw new Error(
                `invalid box "${toBox}" (expected {low|medium|high}-{low|medium|high})`
            );
        }
        // Atomic: the status promotion and the append-only adjustment must commit
        // together (else the session shows 'in_progress' with no adjustment).
        return db.runTransaction(async () => {
            await db.run(
                "UPDATE calibration_sessions SET status='in_progress' WHERE id=? AND status='draft'",
                [sessionId]
            );
            return db.get(
                `INSERT INTO calibration_adjustments (session_id, employee_id, from_box, to_box, rationale, actor_admin_id, actor_employee_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
                [
                    sessionId,
                    employeeId,
                    fromBox || null,
                    toBox,
                    rationale,
                    actorAdminId,
                    actorEmployeeId,
                ]
            );
        });
    }
    async getCalibration(sessionId) {
        const s = await db.get('SELECT * FROM calibration_sessions WHERE id = ?', [sessionId]);
        if (!s) return null;
        s.adjustments = await db.all(
            `SELECT a.*, e.first_name, e.last_name FROM calibration_adjustments a
             JOIN employees e ON e.id = a.employee_id WHERE a.session_id = ? ORDER BY a.created_at`,
            [sessionId]
        );
        // Live distribution of the placements THIS session calibrates.
        s.distribution = await this.distributionFor(s);
        return s;
    }

    /**
     * Box distribution of the mirror (talent_placements) for a calibration session:
     * the session's OWN cycle (falling back to the latest mirrored cycle only when
     * the session has none) and the session's site/department/service scope.
     *
     * Before this, the facilitator's panel read (SELECT MAX(cycle_id) FROM
     * talent_placements) org-wide regardless of the session — a site-scoped session
     * on cycle 6 showed "low-low × 1" from cycle 9 while cycle 6 held high-high × 1
     * for that site. The route's clearance-scoped copy calls this too, with the
     * governed employee ids, so both panels compute the same thing.
     */
    async distributionFor(session, employeeIds = null) {
        const cycleId = session ? (session.cycleId ?? session.cycle_id ?? null) : null;
        const scopeType = session
            ? String(session.scopeType ?? session.scope_type ?? 'org')
            : 'org';
        const scopeId = session ? (session.scopeId ?? session.scope_id ?? null) : null;
        let where = 'tp.cycle_id = COALESCE(?, (SELECT MAX(cycle_id) FROM talent_placements))';
        const params = [cycleId != null ? Number(cycleId) : null];
        const col = SCOPE_COLUMN[scopeType];
        if (col && scopeId != null) {
            where += ` AND ${col} = ?`;
            params.push(Number(scopeId));
        }
        if (Array.isArray(employeeIds)) {
            if (!employeeIds.length) return [];
            where += ' AND tp.employee_id = ANY(?)';
            params.push(employeeIds.map(Number));
        }
        return db.all(
            `SELECT tp.box, COUNT(*) AS n
               FROM talent_placements tp JOIN employees e ON e.id = tp.employee_id
              WHERE ${where}
              GROUP BY tp.box ORDER BY tp.box`,
            params
        );
    }

    /**
     * Who the write-back is attributed to. The route does not pass the caller, so
     * the actor is the session's facilitator (admin row → its real role, so the
     * PIP/coaching triggers see a proper admin) or the manager who ran it.
     */
    async _finalizeActor(session, user) {
        if (user) return user;
        const adminId = session.facilitatorAdminId ?? session.facilitator_admin_id;
        if (adminId != null) {
            const a = await db.get('SELECT id, username, role FROM admins WHERE id = ?', [adminId]);
            if (a)
                return { id: Number(a.id), userType: 'admin', role: a.role, username: a.username };
        }
        const empId = session.actorEmployeeId ?? session.actor_employee_id;
        if (empId != null) return { id: Number(empId), userType: 'manager' };
        return null;
    }

    /**
     * Apply the session's moves. Each move goes through NineBoxService
     * .applyCalibration — the same path as a 9-box approval (event + audit +
     * mirror + PIP/IDP triggers, the last two savepoint-contained) — and counts as
     * APPLIED only when the employee holds an approved placement to move. An
     * employee with no approved evaluation has no position to calibrate, and
     * nothing is written for them.
     *
     * Before this, the evaluation UPDATE ran unconditionally before the `applied`
     * check: the route answered 409 no_placements_matched / applied 0 and the
     * session stayed in_progress, yet employee 89's APPROVED placement had silently
     * moved box 6 → 1 (no event, no PIP) because the transaction still committed.
     * Now the evaluation write IS the applied check — when applied is 0 no row has
     * been touched, and the session stays open so it can be corrected.
     */
    async finalizeCalibration(sessionId, { user = null, req = null } = {}) {
        return db.runTransaction(async () => {
            const s = await db.get(
                "SELECT id, cycle_id, facilitator_admin_id, actor_employee_id FROM calibration_sessions WHERE id=? AND status <> 'cancelled'",
                [sessionId]
            );
            if (!s) throw new Error('Calibration session not found or already cancelled');
            // Take the LATEST to_box per employee.
            const moves = await db.all(
                `SELECT DISTINCT ON (employee_id) employee_id, to_box, rationale
                   FROM calibration_adjustments WHERE session_id = ?
                  ORDER BY employee_id, created_at DESC`,
                [sessionId]
            );
            // HONEST OUTCOME: finalizing a session that has nothing to apply used to
            // return { ok: true, applied: 0 } and stamp the session 'finalized' — the
            // facilitator was told the calibration succeeded while the 9-box grid,
            // DEI analytics and copilot saw no change at all. A no-op finalize is
            // refused and named, and the session STAYS open so it can be fixed and
            // finalized for real.
            if (!moves.length) {
                return {
                    ok: false,
                    reason: 'no_adjustments',
                    applied: 0,
                    attempted: 0,
                    finalized: false,
                };
            }
            const actor = await this._finalizeActor(s, user);
            const results = [];
            const unmatched = [];
            for (const m of moves) {
                const out = await NineBox().applyCalibration(
                    actor,
                    {
                        employeeId: Number(m.employeeId),
                        toBox: m.toBox,
                        reason: m.rationale,
                        sessionId: Number(sessionId),
                        cycleId: s.cycleId ?? null,
                    },
                    req
                );
                if (out) results.push(out);
                else unmatched.push(Number(m.employeeId));
            }
            // Adjustments existed but none of the employees holds an APPROVED
            // placement (only drafts, or nothing). Same rule: say so, don't stamp
            // 'finalized' — and nothing has been written above.
            if (!results.length) {
                return {
                    ok: false,
                    reason: 'no_placements_matched',
                    applied: 0,
                    attempted: moves.length,
                    finalized: false,
                    unmatched,
                };
            }
            await db.run(
                "UPDATE calibration_sessions SET status='finalized', finalized_at=now() WHERE id=?",
                [sessionId]
            );
            return {
                ok: true,
                applied: results.length,
                attempted: moves.length,
                finalized: true,
                results,
                unmatched,
            };
        });
    }

    // ---- Goal cascading ----------------------------------------------------
    async createObjective({
        level,
        title,
        description,
        siteId = null,
        departmentId = null,
        ownerAdminId = null,
        actorEmployeeId = null,
        period = null,
    }) {
        return db.get(
            `INSERT INTO org_objectives (level, title, description, site_id, department_id, owner_admin_id, actor_employee_id, period)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            [
                level,
                title,
                description || null,
                siteId,
                departmentId,
                ownerAdminId,
                actorEmployeeId,
                period,
            ]
        );
    }
    async listObjectives() {
        return db.all(
            `SELECT o.*, (SELECT COUNT(*) FROM goal_alignment g WHERE g.org_objective_id = o.id) AS aligned_goals
             FROM org_objectives o WHERE o.status = 'active'
             ORDER BY CASE o.level WHEN 'company' THEN 0 WHEN 'site' THEN 1 WHEN 'department' THEN 2 ELSE 3 END, o.created_at DESC`
        );
    }
    /** Align an employee goal (cross-owner allowed, unlike the v1 same-owner rule). */
    async alignGoal(goalId, orgObjectiveId, weight = 1.0) {
        return db.get(
            `INSERT INTO goal_alignment (goal_id, org_objective_id, contribution_weight)
             VALUES (?, ?, ?) ON CONFLICT (goal_id, org_objective_id) DO UPDATE SET contribution_weight = EXCLUDED.contribution_weight
             RETURNING *`,
            [goalId, orgObjectiveId, weight]
        );
    }
    /** Roll-up: an objective with its contributing goals + progress. */
    async objectiveCascade(orgObjectiveId) {
        const obj = await db.get('SELECT * FROM org_objectives WHERE id = ?', [orgObjectiveId]);
        if (!obj) return null;
        obj.contributors = await db
            .all(
                `SELECT ga.goal_id, ga.contribution_weight, g.title, g.status,
                    g.current_value, g.target_value, e.first_name, e.last_name
             FROM goal_alignment ga
             JOIN goals g ON g.id = ga.goal_id
             LEFT JOIN employees e ON e.id = g.employee_id
             WHERE ga.org_objective_id = ?`,
                [orgObjectiveId]
            )
            .catch(() => []);
        const progress = (c) => {
            if (c.status === 'done') return 100;
            const t = Number(c.targetValue);
            const v = Number(c.currentValue);
            return t > 0 ? Math.max(0, Math.min(100, Math.round((v / t) * 100))) : 0;
        };
        (obj.contributors || []).forEach((c) => {
            c.progress = progress(c);
        });
        const progs = (obj.contributors || []).map(progress);
        obj.rollupProgress = progs.length
            ? Math.round(progs.reduce((a, b) => a + b, 0) / progs.length)
            : 0;
        return obj;
    }

    // ---- Integrated review summary + merit --------------------------------
    // A cycle is the dedup key for these upserts. cycle_id is nullable in the
    // schema, and Postgres treats NULLs as distinct — so ON CONFLICT would never
    // fire and rows would accumulate. Resolve a null cycle to the latest cycle so
    // the (cycle_id, employee_id) upsert is well-defined.
    async _resolveCycle(cycleId) {
        if (cycleId != null) return cycleId;
        const c = await db.get('SELECT id FROM assessment_cycles ORDER BY id DESC LIMIT 1');
        return c ? c.id : null;
    }
    async upsertReviewSummary({
        cycleId = null,
        employeeId,
        overallRating,
        goalScore,
        behaviorScore,
        narrative,
        signedByAdminId = null,
    }) {
        cycleId = await this._resolveCycle(cycleId);
        // Compute signed_at in JS (passing a bare param to `… IS NOT NULL` makes PG
        // fail to infer the type — "could not determine data type of parameter").
        const signedAt = signedByAdminId != null ? new Date().toISOString() : null;
        return db.get(
            `INSERT INTO review_summaries (cycle_id, employee_id, overall_rating, goal_score, behavior_score, narrative, signed_by_admin_id, signed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (cycle_id, employee_id) DO UPDATE SET
               overall_rating = EXCLUDED.overall_rating, goal_score = EXCLUDED.goal_score,
               behavior_score = EXCLUDED.behavior_score, narrative = EXCLUDED.narrative,
               signed_by_admin_id = EXCLUDED.signed_by_admin_id,
               signed_at = CASE WHEN EXCLUDED.signed_by_admin_id IS NOT NULL THEN now() ELSE review_summaries.signed_at END
             RETURNING *`,
            [
                cycleId,
                employeeId,
                overallRating || null,
                goalScore || null,
                behaviorScore || null,
                narrative || null,
                signedByAdminId,
                signedAt,
            ]
        );
    }
    async upsertMerit({ cycleId = null, employeeId, suggestedPct, managerPct, rationale }) {
        cycleId = await this._resolveCycle(cycleId);
        return db.get(
            `INSERT INTO merit_recommendations (cycle_id, employee_id, suggested_pct, manager_pct, rationale)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (cycle_id, employee_id) DO UPDATE SET
               suggested_pct = EXCLUDED.suggested_pct, manager_pct = EXCLUDED.manager_pct, rationale = EXCLUDED.rationale
             RETURNING *`,
            [cycleId, employeeId, suggestedPct ?? null, managerPct ?? null, rationale || null]
        );
    }
}

module.exports = new TalentDepthService();
