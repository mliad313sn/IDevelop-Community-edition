'use strict';
/**
 * ReviewRecordService — the end-of-campaign record (4.0.0 port, wave 5).
 *
 * Once a campaign is LOCKED or CLOSED, the person who had ratings in it can
 * read, per skill: their own rating, the validated level (only once the round
 * was approved — never a pending rating shown as validated), whether the
 * validated level differs from theirs and, if so, the reason the reviewer
 * wrote, and whether a dispute is still open; then their development plans.
 *
 * They can say « I have read it » — a reading, never an agreement — and add a
 * comment they may change later. The acknowledgement freezes what was shown in
 * review_records (migration 193) with the date.
 *
 * What is frozen (owner decision 8): ids, levels, states and dates only. The
 * skill names, the domains and the reviewer's reason are read LIVE when the
 * record is shown, so the erasure of a person or of a reason leaves nothing
 * behind in the snapshot. The only free text stored is the person's comment,
 * which the erasure redacts.
 *
 * A person reads and acknowledges their own records only: every function takes
 * the signed-in person's id, and no other id ever reaches a query.
 */
const db = require('../config/database');

const READABLE = Object.freeze(['locked', 'closed']);
const COMMENT_MAX = 4000;
const SNAPSHOT_VERSION = 1;

function refuse(status, code) {
    const e = new Error(code);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}

function idOf(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function isoInstant(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A reason that was erased reads as no reason (the page then says nothing). */
function liveReason(text) {
    if (text == null) return null;
    const t = String(text).trim();
    if (!t || t === '[erased]') return null;
    return t;
}

/** Pure: the level a round VALIDATED (approved rounds only), else null. */
function validatedLevel(row) {
    if (!row || row.workflowState !== 'approved') return null;
    if (row.supervisorRatedLevel != null) return Number(row.supervisorRatedLevel);
    return row.selfRatedLevel == null ? null : Number(row.selfRatedLevel);
}

/** Pure: one snapshot line per skill from the latest round of each skill. */
function snapshotLines(rows) {
    return (rows || [])
        .map((r) => {
            const self = r.selfRatedLevel == null ? null : Number(r.selfRatedLevel);
            const validated = validatedLevel(r);
            return {
                skillId: Number(r.skillId),
                roundId: Number(r.roundId),
                reviewId: r.reviewId == null ? null : Number(r.reviewId),
                self,
                validated,
                adjusted: validated !== null && self !== null && validated !== self,
                pending: validated === null && !['rejected'].includes(r.workflowState),
                disputeOpen: r.disputeOpen === true,
            };
        })
        .sort((a, b) => a.skillId - b.skillId);
}

function countsOf(skills) {
    return {
        skills: skills.length,
        validated: skills.filter((s) => s.validated !== null).length,
        adjusted: skills.filter((s) => s.adjusted).length,
        pending: skills.filter((s) => s.pending).length,
        disputes: skills.filter((s) => s.disputeOpen).length,
    };
}

const ReviewRecordService = {
    READABLE,
    COMMENT_MAX,
    _validatedLevel: validatedLevel,
    _snapshotLines: snapshotLines,

    /** The locked / closed campaigns the person has rounds in, newest first, with the record state. */
    async listForEmployee(employeeId) {
        const me = idOf(employeeId);
        if (!me) return [];
        const rows = await db.all(
            `SELECT c.id, c.label, c.code, c.status::text AS "status",
                    c.closed_at AS "closedAt", c.closes_at AS "closesAt",
                    rr.acknowledged_at AS "acknowledgedAt",
                    (rr.employee_comment IS NOT NULL) AS "hasComment"
               FROM assessment_cycles c
               LEFT JOIN review_records rr ON rr.cycle_id = c.id AND rr.employee_id = ?
              WHERE c.status::text IN ('locked', 'closed')
                AND EXISTS (SELECT 1 FROM self_assessment_rounds r
                             WHERE r.cycle_id = c.id AND r.employee_id = ? AND r.cancelled_at IS NULL)
              ORDER BY COALESCE(c.closed_at, c.closes_at, c.created_at) DESC, c.id DESC`,
            [me, me]
        );
        return (rows || []).map((r) => ({
            id: Number(r.id),
            label: r.label || r.code || null,
            status: r.status,
            closedAt: isoInstant(r.closedAt || r.closesAt),
            acknowledgedAt: isoInstant(r.acknowledgedAt),
            hasComment: r.hasComment === true,
        }));
    },

    /** The campaign, if the person took part and it is readable; else a refusal. */
    async _cycle(me, cycleId) {
        const cid = idOf(cycleId);
        if (!me || !cid) throw refuse(404, 'RR_NOT_FOUND');
        const c = await db.get(
            `SELECT c.id, c.label, c.code, c.status::text AS "status"
               FROM assessment_cycles c
              WHERE c.id = ?
                AND EXISTS (SELECT 1 FROM self_assessment_rounds r
                             WHERE r.cycle_id = c.id AND r.employee_id = ? AND r.cancelled_at IS NULL)`,
            [cid, me]
        );
        // Another person's campaign, or one the person had no rating in, is
        // "not found" — never "forbidden", which would say it exists.
        if (!c) throw refuse(404, 'RR_NOT_FOUND');
        if (!READABLE.includes(c.status)) throw refuse(409, 'RR_NOT_CLOSED');
        return { id: Number(c.id), label: c.label || c.code || null, status: c.status };
    },

    /**
     * The record AS IT STANDS NOW: what an acknowledgement would freeze.
     * ids, levels, states and dates only (no names, no free text).
     */
    async build(employeeId, cycleId) {
        const me = idOf(employeeId);
        const c = await this._cycle(me, cycleId);
        const rows = await db.all(
            `SELECT DISTINCT ON (r.skill_id)
                    r.skill_id AS "skillId", r.id AS "roundId",
                    r.self_rated_level AS "selfRatedLevel", r.workflow_state AS "workflowState",
                    sr.id AS "reviewId", sr.supervisor_rated_level AS "supervisorRatedLevel",
                    EXISTS (SELECT 1 FROM assessment_disputes ad
                             WHERE ad.supervisor_review_id = sr.id
                               AND ad.state::text IN ('open', 'escalated')) AS "disputeOpen"
               FROM self_assessment_rounds r
               LEFT JOIN LATERAL (
                    SELECT s.id, s.supervisor_rated_level
                      FROM supervisor_reviews s
                     WHERE s.self_assessment_id = r.id AND s.employee_id = r.employee_id
                     ORDER BY s.id DESC LIMIT 1) sr ON true
              WHERE r.employee_id = ? AND r.cycle_id = ? AND r.cancelled_at IS NULL
              ORDER BY r.skill_id, r.round_no DESC, r.id DESC`,
            [me, c.id]
        );
        const skills = snapshotLines(rows);
        const plans = await db.all(
            `SELECT p.id, p.status::text AS "status", to_char(p.ends_on, 'YYYY-MM-DD') AS "endsOn",
                    (SELECT COUNT(*)::int FROM idp_objectives o WHERE o.idp_id = p.id) AS "objectives",
                    (SELECT COUNT(*)::int FROM idp_actions a WHERE a.idp_id = p.id) AS "actions"
               FROM idp_plans p
              WHERE p.employee_id = ? AND p.status::text IN ('draft', 'active')
              ORDER BY p.id DESC`,
            [me]
        );
        return {
            v: SNAPSHOT_VERSION,
            cycleId: c.id,
            cycleStatus: c.status,
            builtAt: new Date().toISOString(),
            skills,
            plans: (plans || []).map((p) => ({
                id: Number(p.id),
                status: p.status,
                endsOn: p.endsOn || null,
                objectives: Number(p.objectives) || 0,
                actions: Number(p.actions) || 0,
            })),
            counts: countsOf(skills),
        };
    },

    /** The stored record of one campaign, or null. */
    async get(employeeId, cycleId) {
        const me = idOf(employeeId);
        const cid = idOf(cycleId);
        if (!me || !cid) return null;
        const r = await db.get(
            `SELECT id, snapshot, acknowledged_at AS "acknowledgedAt",
                    employee_comment AS "comment", comment_at AS "commentAt"
               FROM review_records WHERE employee_id = ? AND cycle_id = ?`,
            [me, cid]
        );
        if (!r) return null;
        let snap = r.snapshot;
        if (typeof snap === 'string') {
            try {
                snap = JSON.parse(snap);
            } catch (_) {
                snap = null;
            }
        }
        return {
            id: Number(r.id),
            snapshot: snap && typeof snap === 'object' ? snap : null,
            acknowledgedAt: isoInstant(r.acknowledgedAt),
            comment: r.comment == null || r.comment === '[erased]' ? null : r.comment,
            commentAt: isoInstant(r.commentAt),
        };
    },

    /**
     * What the page shows: the frozen snapshot once acknowledged, else the
     * live one; each line completed with the LIVE skill name, domain and, for
     * an adjusted level, the reviewer's reason (read now, never stored).
     */
    async view(employeeId, cycleId) {
        const me = idOf(employeeId);
        const cycle = await this._cycle(me, cycleId);
        const record = await this.get(me, cycle.id);
        const snap = record && record.snapshot ? record.snapshot : await this.build(me, cycle.id);
        const lines = Array.isArray(snap.skills) ? snap.skills : [];
        const skillIds = [...new Set(lines.map((l) => Number(l.skillId)).filter(Boolean))];
        const names = skillIds.length
            ? await db.all(
                  `SELECT s.id, s.name, d.name AS "domainName"
                     FROM skills s LEFT JOIN domains d ON d.id = s.domain_id
                    WHERE s.id = ANY(?)`,
                  [skillIds]
              )
            : [];
        const nameOf = new Map((names || []).map((n) => [Number(n.id), n]));
        const reviewIds = lines
            .filter((l) => l.adjusted && l.reviewId != null)
            .map((l) => Number(l.reviewId));
        // The reason is read on the person's OWN reviews only.
        const reasons = reviewIds.length
            ? await db.all(
                  `SELECT id, gap_reason AS "reason" FROM supervisor_reviews
                    WHERE id = ANY(?) AND employee_id = ?`,
                  [reviewIds, me]
              )
            : [];
        const reasonOf = new Map((reasons || []).map((r) => [Number(r.id), liveReason(r.reason)]));
        const skills = lines
            .map((l) => {
                const n = nameOf.get(Number(l.skillId));
                return {
                    skillId: Number(l.skillId),
                    skillName: n ? n.name : null,
                    domainName: n ? n.domainName || null : null,
                    self: l.self == null ? null : Number(l.self),
                    validated: l.validated == null ? null : Number(l.validated),
                    adjusted: l.adjusted === true,
                    pending: l.pending === true,
                    disputeOpen: l.disputeOpen === true,
                    reason:
                        l.adjusted && l.reviewId != null
                            ? reasonOf.get(Number(l.reviewId)) || null
                            : null,
                };
            })
            .sort(
                (a, b) =>
                    String(a.domainName || '~').localeCompare(String(b.domainName || '~')) ||
                    String(a.skillName || '').localeCompare(String(b.skillName || ''))
            );
        return {
            cycle,
            acknowledged: !!record,
            acknowledgedAt: record ? record.acknowledgedAt : null,
            comment: record ? record.comment : null,
            commentAt: record ? record.commentAt : null,
            builtAt: snap.builtAt || null,
            skills,
            plans: Array.isArray(snap.plans) ? snap.plans : [],
            counts: snap.counts || countsOf(skills),
        };
    },

    /** « I have read it »: freezes what is shown now, with the date. Idempotent. */
    async acknowledge(employeeId, cycleId, comment = null) {
        const me = idOf(employeeId);
        const snap = await this.build(me, cycleId);
        const text = comment == null ? null : String(comment).trim() || null;
        if (text && text.length > COMMENT_MAX) throw refuse(400, 'RR_TEXT_TOO_LONG');
        const row = await db.get(
            `INSERT INTO review_records (employee_id, cycle_id, snapshot, employee_comment, comment_at)
             VALUES (?, ?, ?::jsonb, ?, CASE WHEN ?::text IS NULL THEN NULL ELSE now() END)
             ON CONFLICT (employee_id, cycle_id) DO NOTHING
             RETURNING id`,
            [me, snap.cycleId, JSON.stringify(snap), text, text]
        );
        if (row) {
            try {
                await require('./LogService').log({
                    category: 'audit',
                    action: 'REVIEW_RECORD_ACKNOWLEDGED',
                    actorRef: `employee:${me}`,
                    entityType: 'review_record',
                    entityId: Number(row.id),
                    details: `campaign ${Number(snap.cycleId)}: record read and acknowledged (not an agreement)`,
                });
            } catch (_) {
                /* the audit line never costs the acknowledgement */
            }
        }
        return { created: Boolean(row) };
    },

    /** The person's comment on an acknowledged record (may be changed later). */
    async comment(employeeId, cycleId, text) {
        const me = idOf(employeeId);
        const c = await this._cycle(me, cycleId);
        const t = text == null ? '' : String(text).trim();
        if (!t) throw refuse(400, 'RR_TEXT_REQUIRED');
        if (t.length > COMMENT_MAX) throw refuse(400, 'RR_TEXT_TOO_LONG');
        const row = await db.get(
            `UPDATE review_records SET employee_comment = ?, comment_at = now()
              WHERE employee_id = ? AND cycle_id = ? RETURNING id`,
            [t, me, c.id]
        );
        if (!row) throw refuse(409, 'RR_NOT_ACKNOWLEDGED');
        try {
            await require('./LogService').log({
                category: 'audit',
                action: 'REVIEW_RECORD_COMMENTED',
                actorRef: `employee:${me}`,
                entityType: 'review_record',
                entityId: Number(row.id),
                details: `campaign ${Number(c.id)}: comment saved`,
            });
        } catch (_) {
            /* best-effort */
        }
        return { saved: true };
    },
};

module.exports = ReviewRecordService;
