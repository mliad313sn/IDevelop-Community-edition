'use strict';

const db = require('../config/database');

/**
 *   CycleService — assessment cycle lifecycle + the campaign console read/write side.
 *
 *   draft → open → locked → closed, plus:
 *     cancelled : a draft raised in error (reason mandatory, never a delete)
 *     locked → open again through reopen ("one more week", SuperAdmin, audited)
 *
 *   open: cycle becomes available for self-assessment (roster enrolled, launch announced).
 *   lock: no new self-assessment submissions; supervisors finish reviews.
 *   close: finalises uncontested rows; provisional rows remain pending
 *            dispute resolution; emits BullMQ 'cycle.closed' event so
 *            IDPService.generateDrafts(cycleId) runs.
 *
 *   HARD CONSTRAINT: nothing here subsets, samples, waves or tiers SKILLS.
 *   expected_skills is always the FULL department-designed count; the only
 *   exclusion offered is PERSON-level (excludeParticipant / excludeBulk).
 */

/** Operator-chosen exclusion categories. The two system ones are written by reconcile. */
const USER_CATEGORIES = ['long_leave', 'departure', 'transfer', 'other'];
const SYSTEM_CATEGORIES = ['deactivated', 'erased'];
/** French wording for the audit trail (product rule: audit lines stay FR; the UI translates the code). */
const CATEGORY_FR = {
    long_leave: 'absence longue durée',
    departure: 'départ',
    transfer: 'mutation',
    other: 'autre motif',
    deactivated: 'compte désactivé',
    erased: 'sujet effacé',
};
const RUNNING = ['open', 'locked'];
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * une campagne CLOSE ne se rouvre que par un
 * SuperAdmin, dans les 30 jours suivant la clôture, avec un motif obligatoire,
 * et la réouverture est tracée comme une DÉROGATION. Au-delà : refus explicite.
 */
const REOPEN_CLOSED_WINDOW_DAYS = 30;

/** A6 — le marqueur d'une mesure prise hors de toute campagne (cycle_id IS NULL). */
const OFF_CAMPAIGN_SCOPE = 'hors_campagne';

/** A8 — jours de retard avant qu'une clôture soit PROPOSÉE (jamais automatique). */
const CLOSURE_PROPOSAL_DEFAULT_DAYS = 21;

/**
 * A5 / HR3-02 — LA PORTE D'ÉCRITURE D'UNE CAMPAGNE.
 *
 * Un seul endroit dit si une campagne accepte une écriture, et la phrase de refus
 * nomme toujours la campagne et sa date de clôture. Les états qui refusent :
 *   closed     la campagne est un résultat publié ;
 *   cancelled  la campagne n'a jamais eu lieu ;
 *   draft      la campagne n'est pas lancée ;
 *   locked     plus de saisie ; seules les revues en cours se terminent, donc la
 *              porte reste ouverte aux écritures de REVUE (`allowReview: true`).
 */
const WRITE_GATE_CODES = {
    closed: 'cycle_write_closed',
    cancelled: 'cycle_write_cancelled',
    draft: 'cycle_write_draft',
    locked: 'cycle_write_locked',
};

/** Erased subjects never appear in a campaign roster or count. */
const NOT_ERASED = ' AND e.erased_at IS NULL';

/** Live reviewer of an employee row `e` — the same rule enrolment snapshots. */
const LIVE_REVIEWER =
    "COALESCE(e.supervisor_id, CASE WHEN e.manager_type = 'employee' THEN e.manager_id END)";

/**
 * WHO HOLDS THE REVIEW NOW — one rule for every reminder (3.23.17, F2).
 *
 * A LEFT JOIN LATERAL fragment, over a participant row `p` (may be NULL) and
 * the employee row `e`, yielding `rv.target_type` ('employee' | 'admin') and
 * `rv.target_id`. First match wins:
 *   1-2. an EXPLICIT assignment made on the campaign console
 *        (p.reviewer_assigned_at set): the admin named, else the employee named
 *        — the same person resolveAuthority now lets review;
 *   3-5. the LIVE reporting line: supervisor, employee manager, admin manager;
 *   6-7. the launch-time snapshot (supervisor, then admin), as a last resort
 *        so a person whose line is now empty is still chased by someone.
 * Every candidate must be active; an employee candidate is never the subject.
 * The launch snapshot used to come FIRST, so after a manager change mid-
 * campaign the reminders went to the previous reviewer, who no longer holds
 * the review.
 */
const REVIEWER_TARGET_LATERAL = `LEFT JOIN LATERAL (
        SELECT c.target_type, c.target_id FROM (
            SELECT 1 AS prio, 'admin' AS target_type, a.id AS target_id FROM admins a
             WHERE p.reviewer_assigned_at IS NOT NULL AND a.id = p.reviewer_admin_id AND COALESCE(a.is_active, true)
            UNION ALL
            SELECT 2, 'employee', x.id FROM employees x
             WHERE p.reviewer_assigned_at IS NOT NULL AND p.reviewer_admin_id IS NULL
               AND x.id = p.supervisor_id AND x.is_active AND x.erased_at IS NULL
            UNION ALL
            SELECT 3, 'employee', x.id FROM employees x
             WHERE x.id = e.supervisor_id AND x.is_active AND x.erased_at IS NULL
            UNION ALL
            SELECT 4, 'employee', x.id FROM employees x
             WHERE e.manager_type = 'employee' AND x.id = e.manager_id AND x.is_active AND x.erased_at IS NULL
            UNION ALL
            SELECT 5, 'admin', a.id FROM admins a
             WHERE e.manager_type = 'admin' AND a.id = e.manager_id AND COALESCE(a.is_active, true)
            UNION ALL
            SELECT 6, 'employee', x.id FROM employees x
             WHERE x.id = p.supervisor_id AND x.is_active AND x.erased_at IS NULL
            UNION ALL
            SELECT 7, 'admin', a.id FROM admins a
             WHERE a.id = p.reviewer_admin_id AND COALESCE(a.is_active, true)
        ) c
        WHERE c.target_type = 'admin' OR c.target_id <> e.id
        ORDER BY c.prio
        LIMIT 1
    ) rv ON true`;

/**
 * THE "RESPONSABLE" OF A ROSTER ROW, NOW — 3.23.18.
 *
 * LEFT JOIN LATERAL over the participant row `p` and the employee row `e`,
 * yielding `rsp.kind` ('employee' | 'admin' | NULL) and `rsp.id`:
 *   1-2. an EXPLICIT assignment made on the campaign console (the admin named,
 *        else the employee named) — resolveAuthority lets that person review;
 *   then THE LIVE REPORTING LINE, exactly as GovernanceService states it:
 *        live supervisor, else live employee manager, else live admin manager.
 * Every candidate is live; an employee is never their own responsable. NO
 * launch-snapshot fallback here: a row with nobody on its line lands in the
 * "no responsable" group, which is what it is.
 *
 * The console's "Responsable" grouping, its filter and the "transferred" flag
 * used the launch snapshot for the group and a NON-activity-checked COALESCE
 * for the comparison — so a departed supervisor still headed a group, an
 * admin-managed person was filed under "no manager", and "transferred" fired
 * or stayed silent depending on which side had checked activity.
 */
// Built on first use (GovernanceService is required lazily: several suites
// mock it with a partial factory while loading this module).
let _responsibleLateral = null;
function responsibleLateral() {
    if (_responsibleLateral) return _responsibleLateral;
    const G = require('./GovernanceService');
    _responsibleLateral = `LEFT JOIN LATERAL (
        SELECT c.kind, c.id FROM (
            SELECT 1 AS prio, 'admin' AS kind, ra.id AS id FROM admins ra
             WHERE p.reviewer_assigned_at IS NOT NULL AND ra.id = p.reviewer_admin_id AND ra.is_active = true
            UNION ALL
            SELECT 2, 'employee', rx.id FROM employees rx
             WHERE p.reviewer_assigned_at IS NOT NULL AND p.reviewer_admin_id IS NULL
               AND rx.id = p.supervisor_id AND rx.id <> e.id AND ${G.activePersonSql('rx')}
            UNION ALL
            ${G.reportingLineCandidatesSql('e')}
        ) c
        ORDER BY c.prio
        LIMIT 1
    ) rsp ON true`;
    return _responsibleLateral;
}

/**
 * WHO THE ROSTER RECORDED, activity-checked the same way — the other side of
 * the "transferred" comparison (like with like). Same explicit-assignment
 * rows first, then the launch snapshot (supervisor, then admin reviewer).
 */
let _recordedLateral = null;
function recordedLateral() {
    if (_recordedLateral) return _recordedLateral;
    const { activePersonSql } = require('./GovernanceService');
    _recordedLateral = `LEFT JOIN LATERAL (
        SELECT c.kind, c.id FROM (
            SELECT 1 AS prio, 'admin' AS kind, ra.id AS id FROM admins ra
             WHERE p.reviewer_assigned_at IS NOT NULL AND ra.id = p.reviewer_admin_id AND ra.is_active = true
            UNION ALL
            SELECT 2, 'employee', rx.id FROM employees rx
             WHERE p.reviewer_assigned_at IS NOT NULL AND p.reviewer_admin_id IS NULL
               AND rx.id = p.supervisor_id AND rx.id <> e.id AND ${activePersonSql('rx')}
            UNION ALL
            SELECT 3, 'employee', sx.id FROM employees sx
             WHERE sx.id = p.supervisor_id AND sx.id <> e.id AND ${activePersonSql('sx')}
            UNION ALL
            SELECT 4, 'admin', sa.id FROM admins sa
             WHERE sa.id = p.reviewer_admin_id AND sa.is_active = true
        ) c
        ORDER BY c.prio
        LIMIT 1
    ) rec ON true`;
    return _recordedLateral;
}

/** Names of `rsp` (employee → the person; admin → the linked person, else the login). */
const RESPONSIBLE_NAME_JOINS = `LEFT JOIN employees rspe ON rsp.kind = 'employee' AND rspe.id = rsp.id
               LEFT JOIN admins rspa ON rsp.kind = 'admin' AND rspa.id = rsp.id
               LEFT JOIN employees rspae ON rspae.id = rspa.linked_employee_id`;
const RESPONSIBLE_LABEL = `CASE WHEN rsp.kind = 'admin'
                  THEN COALESCE(NULLIF(TRIM(COALESCE(rspae.first_name, '') || ' ' || COALESCE(rspae.last_name, '')), ''), rspa.username::text)
                  ELSE NULLIF(TRIM(COALESCE(rspe.first_name, '') || ' ' || COALESCE(rspe.last_name, '')), '') END`;

/**
 * Responsable tokens of the roster filter: an employee id ("12") or an admin
 * account ("admin:3" — the two id spaces overlap, so an admin is never a bare
 * number). Returns { empIds, adminIds }.
 */
function splitResponsibleTokens(list) {
    const empIds = [];
    const adminIds = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const s = String(raw == null ? '' : raw).trim();
        const m = /^admin:(\d+)$/i.exec(s);
        if (m) {
            const n = Number(m[1]);
            if (n > 0 && !adminIds.includes(n)) adminIds.push(n);
        } else if (/^\d+$/.test(s)) {
            const n = Number(s);
            if (n > 0 && !empIds.includes(n)) empIds.push(n);
        }
    }
    return { empIds, adminIds };
}

const STATE_ORDER = `CASE v.participant_state
                           WHEN 'not_started' THEN 0
                           WHEN 'in_review'   THEN 1
                           WHEN 'in_progress' THEN 2
                           WHEN 'approved'    THEN 3
                           ELSE 4 END`;

/** Roster sort whitelist — resolved ONLY through utils/listTools.sortClause. */
const SORT_COLUMNS = {
    state: STATE_ORDER,
    name: 'e.last_name',
    site: 's.name',
    department: 'd.name',
    manager: 'sup.last_name',
    progress: '(v.approved_skills::float / NULLIF(v.expected_skills, 0))',
    nudge: '"lastNudgeAt"',
};

// yyyy-MM-dd, or null. The driver hands back `closes_at` as a JS Date, and
// String(date).slice(0, 10) yields "Sat Oct 31" — an English weekday that then
// travelled into FR audit lines and notification payloads. Normalise a
// Date through its ISO form first; plain strings keep the validating path used
// on posted dates.
function ymd(v) {
    if (v == null || v === '') return null;
    const s =
        v instanceof Date
            ? Number.isNaN(v.getTime())
                ? ''
                : v.toISOString().slice(0, 10)
            : String(v).slice(0, 10);
    return DATE_RE.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}
function today() {
    return new Date().toISOString().slice(0, 10);
}
function toIdList(v) {
    const arr = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
    return [...new Set(arr.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
}
function actorId(actor) {
    return actor && actor.userType === 'admin' && actor.id ? Number(actor.id) : null;
}
/** "type:id" of any actor — what an admin-only FK column cannot name. */
function actorRef(actor) {
    return actor && actor.id != null ? `${actor.userType || 'user'}:${actor.id}` : null;
}
function actorLabel(actor) {
    if (!actor) return 'système';
    const who =
        actor.username ||
        actor.displayName ||
        [actor.firstName, actor.lastName].filter(Boolean).join(' ') ||
        `#${actor.id}`;
    return actor.userType === 'admin'
        ? `admin ${who}`
        : `${actor.userType || 'utilisateur'} ${who}`;
}
async function audit(entry) {
    try {
        await require('./LogService').log({ category: 'audit', ...entry });
    } catch (_) {
        /* the trail is best-effort here; the row change itself is the record of truth */
    }
}
function err(code) {
    const e = new Error(code);
    e.code = code;
    return e;
}

class CycleService {
    static get USER_CATEGORIES() {
        return USER_CATEGORIES;
    }
    static get SYSTEM_CATEGORIES() {
        return SYSTEM_CATEGORIES;
    }
    static get CATEGORY_FR() {
        return CATEGORY_FR;
    }
    static get SORT_COLUMNS() {
        return SORT_COLUMNS;
    }
    /** A5 — fenêtre de réouverture d'une campagne close, en jours. */
    static get REOPEN_CLOSED_WINDOW_DAYS() {
        return REOPEN_CLOSED_WINDOW_DAYS;
    }
    /** A6 — le libellé de la mesure prise hors de toute campagne. */
    static get OFF_CAMPAIGN_SCOPE() {
        return OFF_CAMPAIGN_SCOPE;
    }
    /** A8 — retard par défaut avant qu'une clôture soit PROPOSÉE. */
    static get CLOSURE_PROPOSAL_DEFAULT_DAYS() {
        return CLOSURE_PROPOSAL_DEFAULT_DAYS;
    }

    static async findActive() {
        return db.get(
            `SELECT * FROM assessment_cycles WHERE status = 'open' ORDER BY closes_at LIMIT 1`
        );
    }

    /**
     * The campaign every dashboard/digest/burndown follows: an OPEN one first, else
     * the most recent LOCKED one — the review phase is still the campaign.
     */
    static async findCurrent() {
        return db.get(
            `SELECT id, code, label, status, opened_at AS "openedAt", closes_at AS "closesAt"
               FROM assessment_cycles
              WHERE status IN ('open', 'locked')
              ORDER BY (status = 'open') DESC, closes_at DESC, id DESC
              LIMIT 1`
        );
    }

    /**
     * Campaign list. `status`: running | draft | closed | cancelled | all;
     * default = everything but cancelled, running campaigns first.
     */
    static async list({ status } = {}) {
        const where =
            status === 'running'
                ? `WHERE status IN ('open', 'locked')`
                : status === 'draft'
                  ? `WHERE status = 'draft'`
                  : status === 'closed'
                    ? `WHERE status = 'closed'`
                    : status === 'cancelled'
                      ? `WHERE status = 'cancelled'`
                      : status === 'all'
                        ? ''
                        : `WHERE status <> 'cancelled'`;
        return db.all(
            `SELECT id, code, label, status, opened_at, closes_at, created_at,
                    cancelled_at, cancel_reason, reopened_at, reopen_count,
                    closed_at, reopen_override_at, reopen_override_count
               FROM assessment_cycles ${where}
              ORDER BY (status IN ('open', 'locked')) DESC, (status = 'draft') DESC,
                       COALESCE(opened_at, created_at) DESC, id DESC`
        );
    }

    /** Running campaigns (open first) — for pickers such as the review-queue cycle filter. */
    static async listRunning() {
        return db.all(
            `SELECT id, code, label, status, closes_at AS "closesAt"
               FROM assessment_cycles WHERE status IN ('open', 'locked')
              ORDER BY (status = 'open') DESC, closes_at DESC, id DESC`
        );
    }

    /** Validate + normalise the create/edit form. Throws a stable code. */
    static _validateHeader({ code, label, opensAt, closesAt }, { requireCode = true } = {}) {
        const c = (code == null ? '' : String(code)).trim();
        if (requireCode && !c) throw err('cycle_code_required');
        if (c && !CODE_RE.test(c)) throw err('cycle_code_invalid');
        const o = ymd(opensAt);
        const k = ymd(closesAt);
        if (!o || !k) throw err('cycle_dates_required');
        if (k < o) throw err('cycle_dates_invalid');
        return {
            code: c,
            label: (label == null ? '' : String(label)).trim().slice(0, 200) || null,
            opensAt: o,
            closesAt: k,
        };
    }

    static async _codeTaken(code, exceptId) {
        const row = await db.get(
            `SELECT id FROM assessment_cycles WHERE lower(code) = lower(?)${exceptId ? ' AND id <> ?' : ''}`,
            exceptId ? [code, Number(exceptId)] : [code]
        );
        return !!row;
    }

    static async create({ code, label, opensAt, closesAt, createdBy }) {
        const v = CycleService._validateHeader({ code, label, opensAt, closesAt });
        if (await CycleService._codeTaken(v.code)) throw err('cycle_code_taken');
        const { lastID } = await db.run(
            `INSERT INTO assessment_cycles (code, label, opened_at, closes_at, status, created_by)
             VALUES (?, ?, ?, ?, 'draft', ?)`,
            [v.code, v.label, v.opensAt, v.closesAt, createdBy]
        );
        await audit({
            adminId: createdBy || null,
            action: 'cycle_created',
            entityType: 'assessment_cycle',
            entityId: Number(lastID),
            details: `Campagne #${lastID} (${v.code}) créée en brouillon — ${v.opensAt} → ${v.closesAt}`,
        });
        return lastID;
    }

    /** Edit code / label / dates — DRAFT only; a running campaign changes its deadline through extend/reopen. */
    static async update(cycleId, { code, label, opensAt, closesAt }, actor) {
        const id = Number(cycleId);
        const cycle = await CycleService.findById(id);
        if (!cycle) throw err('cycle_not_found');
        if (cycle.status !== 'draft') throw err('cycle_not_draft');
        const v = CycleService._validateHeader({ code, label, opensAt, closesAt });
        if (await CycleService._codeTaken(v.code, id)) throw err('cycle_code_taken');
        await db.run(
            `UPDATE assessment_cycles SET code = ?, label = ?, opened_at = ?, closes_at = ? WHERE id = ? AND status = 'draft'`,
            [v.code, v.label, v.opensAt, v.closesAt, id]
        );
        await audit({
            adminId: actorId(actor),
            action: 'cycle_updated',
            entityType: 'assessment_cycle',
            entityId: id,
            details: `Campagne #${id} (${v.code}) modifiée par ${actorLabel(actor)} — ${v.opensAt} → ${v.closesAt}`,
        });
        return { updated: true };
    }

    /**
     * Enrol the participant roster for a cycle — every ACTIVE employee whose role
     * carries at least one requirement. Org placement and the FULL department-designed
     * requirement count are SNAPSHOTTED here so a mid-cycle transfer cannot rewrite
     * history. Idempotent (ON CONFLICT DO NOTHING) so it is safe to re-run.
     *
     * This is what makes a non-starter addressable: enrolment is stamped from the
     * employee population at launch, NOT derived from self_assessments rows that
     * only exist once somebody has already acted. An employee managed by an ADMIN
     * (manager_type = 'admin') gets that admin snapshotted as reviewer.
     */
    static async enrolParticipants(cycleId) {
        const res = await db.run(
            `INSERT INTO cycle_participants
                 (cycle_id, employee_id, role_id, site_id, department_id, service_id, supervisor_id, reviewer_admin_id, expected_skills)
             SELECT ?, e.id, e.role_id, e.site_id, e.department_id, e.service_id,
                    ${LIVE_REVIEWER},
                    CASE WHEN e.supervisor_id IS NULL AND e.manager_type = 'admin' THEN e.manager_id END,
                    (SELECT COUNT(*) FROM role_skill_requirements r
                      WHERE r.role_id = e.role_id AND COALESCE(r.required_level, 0) > 0)
               FROM employees e
              WHERE e.is_active AND e.erased_at IS NULL
                AND EXISTS (SELECT 1 FROM role_skill_requirements r WHERE r.role_id = e.role_id)
             ON CONFLICT (cycle_id, employee_id) DO NOTHING`,
            [cycleId]
        );
        return res && res.changes != null ? res.changes : 0;
    }

    /**
     * Self-heal the roster of a RUNNING campaign: enrol joiners (open cycles only —
     * a locked campaign cannot be submitted to, ), excuse deactivated / erased
     * people with a SYSTEM category on open AND locked cycles, and put back
     * whoever's time-boxed exclusion has expired. No-op on any other state.
     */
    static async reconcileParticipants(cycleId) {
        const id = Number(cycleId);
        const cycle = await CycleService.findById(id);
        if (!cycle || !RUNNING.includes(cycle.status))
            return { added: 0, excluded: 0, reincluded: 0, skipped: 'cycle_not_running' };
        const added = cycle.status === 'open' ? await CycleService.enrolParticipants(id) : 0;
        const gone = await db.run(
            `UPDATE cycle_participants p
                SET excluded_at = now(),
                    exclusion_category = CASE WHEN e.erased_at IS NOT NULL THEN 'erased' ELSE 'deactivated' END,
                    exclusion_reason = COALESCE(p.exclusion_reason,
                                                CASE WHEN e.erased_at IS NOT NULL THEN 'erased' ELSE 'deactivated' END),
                    excluded_by_admin_id = NULL
               FROM employees e
              WHERE e.id = p.employee_id AND p.cycle_id = ?
                AND p.excluded_at IS NULL AND (e.is_active = false OR e.erased_at IS NOT NULL)`,
            [id]
        );
        const excluded = gone && gone.changes ? gone.changes : 0;
        if (excluded) {
            await audit({
                adminId: null,
                action: 'cycle_participants_auto_excluded',
                entityType: 'assessment_cycle',
                entityId: id,
                details: `Cycle #${id} — ${excluded} participant(s) excusé(s) automatiquement (compte désactivé / sujet effacé)`,
            });
        }
        const reincluded = await CycleService.reincludeExpired(id);
        return { added, excluded, reincluded };
    }

    /** Time-boxed exclusions past their date come back automatically, audited, history kept. */
    static async reincludeExpired(cycleId) {
        const rows = await db.all(
            `UPDATE cycle_participants p
                SET last_excluded_at = p.excluded_at, last_exclusion_reason = p.exclusion_reason,
                    last_exclusion_category = p.exclusion_category, last_excluded_by_admin_id = p.excluded_by_admin_id,
                    excluded_at = NULL, exclusion_reason = NULL, exclusion_category = NULL,
                    excluded_until = NULL, excluded_by_admin_id = NULL,
                    included_at = now(), included_by_admin_id = NULL
               FROM employees e
              WHERE e.id = p.employee_id AND p.cycle_id = ?
                AND p.excluded_at IS NOT NULL AND p.excluded_until IS NOT NULL AND p.excluded_until < CURRENT_DATE
                AND e.is_active AND e.erased_at IS NULL
                AND COALESCE(p.exclusion_category, '') NOT IN ('deactivated', 'erased')
              RETURNING p.employee_id AS "employeeId"`,
            [Number(cycleId)]
        );
        for (const r of rows || []) {
            await audit({
                adminId: null,
                action: 'cycle_participant_included',
                entityType: 'cycle_participant',
                entityId: Number(r.employeeId),
                details: `Cycle #${cycleId} — participant #${r.employeeId} réintégré automatiquement (fin de la période d'exclusion)`,
            });
        }
        return rows ? rows.length : 0;
    }

    /** draft → open: enrol the roster, announce the launch to it, audit. */
    static async open(cycleId, actor) {
        const id = Number(cycleId);
        const { changes } = await db.run(
            `UPDATE assessment_cycles SET status = 'open' WHERE id = ? AND status = 'draft'`,
            [id]
        );
        if (!changes) return { opened: false, enrolled: 0, notified: 0 };
        // Enrol the roster FIRST — the launch announcement is addressed from it.
        let enrolled = 0;
        try {
            enrolled = await CycleService.enrolParticipants(id);
        } catch (e) {
            console.error('[cycle] enrolParticipants failed:', e.message);
        }

        // Campaign launch push. The audience used to be
        // `SELECT DISTINCT employee_id FROM self_assessments WHERE cycle_id = ?`,
        // which is EMPTY at open — so the announcement silently reached nobody
        // and the campaign began in total silence. Address the roster instead.
        const notified = await CycleService._announce(id, 'cycle.opened').catch(() => 0);
        const cycle = await CycleService.findById(id);
        await audit({
            adminId: actorId(actor),
            action: 'cycle_opened',
            entityType: 'assessment_cycle',
            entityId: id,
            details: `Campagne #${id} (${(cycle && cycle.code) || ''}) lancée par ${actorLabel(actor)} — ${enrolled} personne(s) enrôlée(s), ${notified} notifiée(s)`,
        });
        return { opened: true, enrolled, notified };
    }

    /** In-app announcement to every ACTIVE, not-yet-approved participant. Returns the count. */
    static async _announce(cycleId, kind) {
        const cycle = await db.get(
            'SELECT code, label, closes_at AS "closesAt" FROM assessment_cycles WHERE id = ?',
            [cycleId]
        );
        const rows = await db.all(
            `SELECT v.employee_id AS "employeeId"
               FROM v_cycle_participant_status v
               JOIN employees e ON e.id = v.employee_id AND e.is_active AND e.erased_at IS NULL
              WHERE v.cycle_id = ? AND v.excluded_at IS NULL AND v.participant_state <> 'approved'`,
            [cycleId]
        );
        if (!rows.length) return 0;
        return require('./NotificationService').enqueueBulkInApp({
            userType: 'employee',
            userIds: rows.map((r) => Number(r.employeeId)),
            kind,
            payload: {
                cycleId: Number(cycleId),
                cycle: cycle && cycle.code,
                cycleLabel: cycle && cycle.label,
                closesOn: cycle && cycle.closesAt,
                link: '/employee/self-assessment',
            },
        });
    }

    /** open → locked (the deadline job's step 1, or a manual lock from the console). */
    static async lock(cycleId, actor) {
        const id = Number(cycleId);
        const { changes } = await db.run(
            `UPDATE assessment_cycles SET status = 'locked' WHERE id = ? AND status = 'open'`,
            [id]
        );
        if (changes && actor) {
            await audit({
                adminId: actorId(actor),
                action: 'cycle_locked',
                entityType: 'assessment_cycle',
                entityId: id,
                details: `Campagne #${id} verrouillée manuellement par ${actorLabel(actor)} — plus de soumission, les revues continuent`,
            });
        }
        return { locked: !!changes };
    }

    /** Forget the one-shot auto-lock announcement so the next deadline is announced again. */
    static async _releaseAutolockClaim(cycleId) {
        await db.run(
            `DELETE FROM reminder_log WHERE kind = 'cycle.autolock' AND ref_id = ? AND period = ?`,
            [Number(cycleId), `cycle:${Number(cycleId)}`]
        );
    }

    /**
     * locked → open with a NEW deadline.
     * SuperAdmin-only at the route; audited; the auto-lock claim is released; the
     * people still expected are told the window is open again.
     */
    static async reopen(cycleId, closesAt, actor) {
        const id = Number(cycleId);
        const cycle = await CycleService.findById(id);
        if (!cycle) throw err('cycle_not_found');
        if (cycle.status !== 'locked') throw err('cycle_not_locked');
        const k = ymd(closesAt);
        if (!k) throw err('cycle_dates_required');
        if (k < today()) throw err('cycle_deadline_past');
        const { changes } = await db.run(
            `UPDATE assessment_cycles
                SET status = 'open', closes_at = ?, reopened_at = now(), reopen_count = reopen_count + 1
              WHERE id = ? AND status = 'locked'`,
            [k, id]
        );
        if (!changes) throw err('cycle_not_locked');
        await CycleService._releaseAutolockClaim(id);
        const notified = await CycleService._announce(id, 'cycle.opened').catch(() => 0);
        await audit({
            adminId: actorId(actor),
            action: 'cycle_reopened',
            entityType: 'assessment_cycle',
            entityId: id,
            details: `Campagne #${id} (${cycle.code || ''}) rouverte par ${actorLabel(actor)} — nouvelle échéance ${k} (précédente ${ymd(cycle.closesAt) || '—'}), ${notified} personne(s) prévenue(s)`,
        });
        return { reopened: true, closesAt: k, notified };
    }

    /** Extend the deadline of an OPEN campaign (audited; the auto-lock claim is released). */
    static async extendDeadline(cycleId, closesAt, actor) {
        const id = Number(cycleId);
        const cycle = await CycleService.findById(id);
        if (!cycle) throw err('cycle_not_found');
        if (cycle.status !== 'open') throw err('cycle_not_open');
        const k = ymd(closesAt);
        if (!k) throw err('cycle_dates_required');
        if (k < today()) throw err('cycle_deadline_past');
        await db.run(
            `UPDATE assessment_cycles SET closes_at = ? WHERE id = ? AND status = 'open'`,
            [k, id]
        );
        await CycleService._releaseAutolockClaim(id);
        await audit({
            adminId: actorId(actor),
            action: 'cycle_deadline_extended',
            entityType: 'assessment_cycle',
            entityId: id,
            details: `Campagne #${id} (${cycle.code || ''}) — échéance déplacée au ${k} (précédente ${ymd(cycle.closesAt) || '—'}) par ${actorLabel(actor)}`,
        });
        return { extended: true, closesAt: k };
    }

    /** draft → cancelled with a mandatory reason. */
    static async cancel(cycleId, reason, actor) {
        const id = Number(cycleId);
        const why = (reason == null ? '' : String(reason)).trim();
        if (!why) throw err('cancel_reason_required');
        const cycle = await CycleService.findById(id);
        if (!cycle) throw err('cycle_not_found');
        if (cycle.status !== 'draft') throw err('cycle_not_draft');
        const { changes } = await db.run(
            `UPDATE assessment_cycles
                SET status = 'cancelled', cancelled_at = now(), cancel_reason = ?, cancelled_by_admin_id = ?
              WHERE id = ? AND status = 'draft'`,
            [why.slice(0, 500), actorId(actor), id]
        );
        if (!changes) throw err('cycle_not_draft');
        await audit({
            adminId: actorId(actor),
            action: 'cycle_cancelled',
            entityType: 'assessment_cycle',
            entityId: id,
            details: `Campagne #${id} (${cycle.code || ''}) annulée (brouillon) par ${actorLabel(actor)} : ${why.slice(0, 200)}`,
        });
        return { cancelled: true };
    }

    static async close(cycleId, { emit } = {}) {
        let transitioned = false;
        await db.runTransaction(async () => {
            // finalise rows that are NOT under dispute — and that were actually
            // SUBMITTED. A draft, or a row sent back for changes, was never
            // decided by anyone; stamping it 'finalized' presented an unsubmitted
            // worksheet as a closed result.
            //
            // SUBMITTED IS NOT REVIEWED (3.23.17, F9). A row still 'submitted' or
            // 'under_review' when the campaign closes was never decided either:
            // it used to be stamped 'finalized' too — the very value the IDP
            // generator reads as "validated". It is locked, but as
            // 'closed_unreviewed' (migration 146), which no reader treats as a
            // validated result.
            const NOT_DISPUTED = `NOT EXISTS (
                       SELECT 1 FROM supervisor_reviews sr
                       JOIN assessment_disputes d ON d.supervisor_review_id = sr.id
                       WHERE sr.self_assessment_id = sa.id AND d.state IN ('open','escalated')
                   )`;
            await db.run(
                `UPDATE self_assessments sa
                 SET locked_state = 'finalized'
                 WHERE sa.cycle_id = ?
                   AND sa.workflow_state NOT IN ('draft', 'changes_requested')
                   AND sa.workflow_state NOT IN ('submitted', 'under_review')
                   AND ${NOT_DISPUTED}`,
                [cycleId]
            );
            await db.run(
                `UPDATE self_assessments sa
                 SET locked_state = 'closed_unreviewed'
                 WHERE sa.cycle_id = ?
                   AND sa.workflow_state IN ('submitted', 'under_review')
                   AND ${NOT_DISPUTED}`,
                [cycleId]
            );
            const { changes } = await db.run(
                `UPDATE assessment_cycles SET status = 'closed' WHERE id = ? AND status IN ('open','locked')`,
                [cycleId]
            );
            transitioned = changes > 0;
        });
        // Only fire the event when this call actually closed the cycle, so a re-close
        // of an already-closed cycle stays a no-op (belt-and-braces; generateDrafts is
        // itself idempotent).
        if (emit && transitioned) await emit('cycle.closed', { cycleId });
    }

    // =====================================================================
    //  CAMPAIGN CONSOLE — read side.
    //
    //  Everything below reads the ROSTER (cycle_participants /
    //  v_cycle_participant_status), never self_assessments, so the person who
    //  never opened the page is counted, named and reachable.
    //
    //  Scoping: the roster snapshots site/department/service AT LAUNCH, and the
    //  breakdowns GROUP BY those snapshot columns so a mid-cycle transfer cannot
    //  silently move a laggard out of the site that was accountable for them.
    //  Clearance itself stays on the single canonical gate — RBACService
    //  .scopeFilter over the joined employees row — resolved ONCE per request
    // and INCLUDING inactive people: the
    //  roster is history, and an excused leaver must stay visible to the site
    //  admin who manages that site. Erased subjects are never listed.
    // =====================================================================

    /** The "who holds the review now" fragment, shared with jobs/cycle-nudge.js. */
    static get REVIEWER_TARGET_LATERAL() {
        return REVIEWER_TARGET_LATERAL;
    }

    static get STATES() {
        return ['not_started', 'in_progress', 'in_review', 'approved', 'excluded'];
    }

    /** One cycle header row (code/label/status/dates) — for the console page. */
    static async findById(cycleId) {
        return db.get(
            `SELECT id, code, label, status, opened_at, closes_at, created_at,
                    cancelled_at, cancel_reason, reopened_at, reopen_count,
                    closed_at, reopen_override_at, reopen_override_reason, reopen_override_count
               FROM assessment_cycles WHERE id = ?`,
            [Number(cycleId)]
        );
    }

    /** Clearance fragment over the joined employees alias `e` (resolved once when `pre` is given). */
    static async _scope(user, pre) {
        if (pre && typeof pre.clause === 'string') return pre;
        return require('./RBACService').scopeFilter(user, { empAlias: 'e', includeInactive: true });
    }

    /** Resolve the caller's clearance once for a whole console request. */
    static async resolveScope(user) {
        return CycleService._scope(user);
    }

    static _emptyBucket() {
        return { count: 0, expected: 0, rated: 0, submitted: 0, approved: 0, rejected: 0 };
    }

    /** null — never 0 — when nothing is measured. */
    static _pct(n, d) {
        const den = Number(d || 0);
        if (!den) return null;
        return Math.round((Number(n || 0) / den) * 100);
    }

    static async _assertRunning(cycleId) {
        const cycle = await CycleService.findById(cycleId);
        if (!cycle) throw err('cycle_not_found');
        // A5 / HR3-02 : le refus nomme la campagne et sa date de clôture au lieu
        // d'un code nu — c'est la MÊME phrase partout (cf. cycleWriteGate).
        if (!RUNNING.includes(cycle.status))
            throw CycleService._gateError(CycleService._gate(cycle));
        return cycle;
    }

    // =====================================================================
    //  A5 / HR3-02 — la porte d'écriture d'une campagne.
    //
    //  `cycleWriteGate(cycleId, opts)` répond « cette campagne accepte-t-elle une
    //  écriture ? » et, si non, donne la phrase française qui nomme la campagne et
    //  sa date de clôture. `assertCycleWritable` lève la même chose.
    //  Les autres lots BRANCHENT leurs transitions d'état ici (voir REPORT.md) ;
    //  il n'y a pas d'autre définition de « fermée » dans le produit.
    // =====================================================================

    /** Ce que la campagne permet, sans texte — utilisable sans `req`. */
    static _gate(cycle, { allowReview = false } = {}) {
        if (!cycle) {
            // Pas de campagne du tout = mesure HORS CAMPAGNE : autorisée.
            return {
                writable: true,
                status: null,
                code: null,
                scope: OFF_CAMPAIGN_SCOPE,
                cycle: null,
            };
        }
        const status = String(cycle.status || '');
        const writable = status === 'open' || (status === 'locked' && allowReview === true);
        return {
            writable,
            status,
            code: writable ? null : WRITE_GATE_CODES[status] || 'cycle_write_refused',
            scope: 'campagne',
            cycle: {
                id: Number(cycle.id),
                code: cycle.code || null,
                label: cycle.label || null,
                status,
                closesAt: ymd(cycle.closesAt),
                closedAt: ymd(cycle.closedAt),
                cancelledAt: ymd(cycle.cancelledAt),
            },
        };
    }

    /**
     * La phrase de refus. FR par défaut ; `t` (i18next) donne l'anglais avec les
     * mêmes variables. Elle nomme TOUJOURS la campagne et la date qui compte.
     */
    static gateMessage(gate, { t } = {}) {
        if (!gate || gate.writable) return null;
        const c = gate.cycle || {};
        const name = c.code || `#${c.id}`;
        // Chaque état a SA date, et on ne substitue jamais une autre date à celle
        // qui manque : une campagne close dont la date de clôture n'a pas été
        // enregistrée le DIT (l'échéance n'est pas une date de clôture).
        const own =
            gate.code === 'cycle_write_closed'
                ? c.closedAt
                : gate.code === 'cycle_write_cancelled'
                  ? c.cancelledAt
                  : gate.code === 'cycle_write_locked'
                    ? c.closesAt
                    : null;
        const undated =
            (gate.code === 'cycle_write_closed' || gate.code === 'cycle_write_cancelled') && !own;
        const key = undated ? `${gate.code}_undated` : gate.code;
        // la PHRASE porte la date du lecteur
        // (dd/MM/aaaa, la même que « clôture le 31/08/2026 » de
        // /employee/assessment-status), jamais l'ISO. `gate.cycle.*` garde l'ISO :
        // c'est le contrat machine, lu par les appelants JSON.
        const { fmtPeriodBound } = require('../utils/dateFormat');
        const vars = { cycle: name, date: own ? fmtPeriodBound(own) : '—' };
        const FR = {
            cycle_write_closed: `La campagne ${name} a été clôturée le ${vars.date} : plus aucune écriture n’y est possible.`,
            cycle_write_closed_undated: `La campagne ${name} a été clôturée (date de clôture non enregistrée) : plus aucune écriture n’y est possible.`,
            cycle_write_cancelled: `La campagne ${name} a été annulée le ${vars.date} : plus aucune écriture n’y est possible.`,
            cycle_write_cancelled_undated: `La campagne ${name} a été annulée (date d’annulation non enregistrée) : plus aucune écriture n’y est possible.`,
            cycle_write_draft: `La campagne ${name} n’est pas encore lancée : aucune écriture n’y est possible.`,
            cycle_write_locked: `La campagne ${name} est verrouillée (échéance du ${vars.date}) : les revues en cours se terminent, aucune nouvelle saisie n’est acceptée.`,
            cycle_write_refused: `La campagne ${name} n’accepte plus d’écriture.`,
        };
        const fallback = FR[key] || FR.cycle_write_refused;
        if (typeof t === 'function')
            return t(`admin:cyc_err_${key}`, { defaultValue: fallback, ...vars });
        return fallback;
    }

    /** L'erreur portée par la porte : code stable + phrase déjà rédigée. */
    static _gateError(gate, opts) {
        const e = err(gate.code || 'cycle_write_refused');
        e.gate = gate;
        e.message = CycleService.gateMessage(gate, opts) || e.code;
        return e;
    }

    /**
     * LA fonction que les autres lots appellent.
     *   `cycleId`      l'id de campagne porté par la ligne (NULL = hors campagne).
     *   `allowReview`  true pour une écriture de REVUE (une campagne verrouillée
     *                  laisse les revues se terminer, pas les saisies).
     *   `t`            le traducteur i18next de la requête (facultatif ; FR sinon).
     * Retourne { writable, status, code, scope, cycle, message } — jamais de throw
     * pour une campagne absente : « hors campagne » est un cas autorisé.
     */
    static async cycleWriteGate(cycleId, { allowReview = false, t } = {}) {
        const id = Number(cycleId);
        const cycle = Number.isInteger(id) && id > 0 ? await CycleService.findById(id) : null;
        // Un id fourni mais introuvable n'est PAS « hors campagne » : c'est une erreur.
        if (Number.isInteger(id) && id > 0 && !cycle) throw err('cycle_not_found');
        const gate = CycleService._gate(cycle, { allowReview });
        return { ...gate, message: CycleService.gateMessage(gate, { t }) };
    }

    /** Même porte, en version « lève si refusé ». */
    static async assertCycleWritable(cycleId, opts = {}) {
        const gate = await CycleService.cycleWriteGate(cycleId, opts);
        if (!gate.writable) throw CycleService._gateError(gate, opts);
        return gate;
    }

    /**
     * REOUVERTURE D'UNE CAMPAGNE CLOSE (dérogation).
     *
     * SuperAdmin (imposé par la route), dans les 30 jours suivant la clôture,
     * motif obligatoire, tracée comme dérogation dans trois endroits : les colonnes
     * `reopen_override_*`, la ligne d'audit `cycle_reopened_override`, et le bandeau
     * de la console. Rien n'est dé-approuvé : le travail déjà approuvé reste approuvé.
     *
     * Une campagne close dont la date de clôture n'a jamais été enregistrée est
     * REFUSÉE : le délai de 30 jours ne peut pas être vérifié et on n'invente pas
     * une date (migration 117 ne reprend que ce que le journal d'audit prouve).
     */
    static async reopenClosed(cycleId, { closesAt, reason } = {}, actor) {
        const id = Number(cycleId);
        const cycle = await CycleService.findById(id);
        if (!cycle) throw err('cycle_not_found');
        if (cycle.status !== 'closed') throw err('cycle_not_closed');
        const why = (reason == null ? '' : String(reason)).trim();
        if (!why) throw err('reopen_reason_required');
        // UN SEUL ENDROIT DÉCIDE : la même fonction que la console
        // affiche. Le refus d'écran et le refus de serveur ne peuvent plus diverger.
        const w = CycleService.reopenWindow(cycle);
        const closedOn = w.closedOn;
        const days = w.daysSinceClose;
        if (!closedOn) throw err('cycle_closed_at_unknown');
        if (!w.canReopen) {
            const e = err('cycle_reopen_window_expired');
            e.days = days;
            e.closedAt = closedOn;
            e.windowDays = w.windowDays;
            throw e;
        }
        const k = ymd(closesAt);
        if (!k) throw err('cycle_dates_required');
        if (k < today()) throw err('cycle_deadline_past');

        const { changes } = await db.run(
            `UPDATE assessment_cycles
                SET status = 'open', closes_at = ?, reopened_at = now(), reopen_count = reopen_count + 1,
                    reopen_override_at = now(), reopen_override_by_admin_id = ?, reopen_override_reason = ?,
                    reopen_override_count = reopen_override_count + 1
              WHERE id = ? AND status = 'closed'`,
            [k, actorId(actor), why.slice(0, 500), id]
        );
        if (!changes) throw err('cycle_not_closed');
        await CycleService._releaseAutolockClaim(id);
        // Une proposition de clôture encore ouverte n'a plus d'objet : elle est
        // classée « déclinée » avec le motif de la dérogation, jamais supprimée.
        await db.run(
            `UPDATE cycle_closure_proposals
                SET state = 'declined', decided_at = now(), decided_by_admin_id = ?,
                    decision_reason = ?
              WHERE cycle_id = ? AND state = 'open'`,
            [actorId(actor), `Réouverture par dérogation : ${why.slice(0, 200)}`, id]
        );
        const notified = await CycleService._announce(id, 'cycle.opened').catch(() => 0);
        await audit({
            adminId: actorId(actor),
            action: 'cycle_reopened_override',
            entityType: 'assessment_cycle',
            entityId: id,
            details:
                `DÉROGATION — campagne CLOSE #${id} (${cycle.code || ''}) rouverte par ${actorLabel(actor)} ` +
                `${days} jour(s) après sa clôture du ${closedOn} (délai autorisé : ${REOPEN_CLOSED_WINDOW_DAYS} jours) — ` +
                `nouvelle échéance ${k}, ${notified} personne(s) prévenue(s). Motif : ${why.slice(0, 200)}`,
        });
        return {
            reopened: true,
            override: true,
            closesAt: k,
            notified,
            closedAt: closedOn,
            daysSinceClose: days,
            windowDays: REOPEN_CLOSED_WINDOW_DAYS,
            reason: why.slice(0, 500),
        };
    }

    /**
     * LA SEULE DÉCISION sur la fenêtre de réouverture d'une campagne close.
     *
     * QA la règle des 30 jours était calculée DEUX fois. Le serveur
     * comptait des jours CALENDAIRES UTC (`daysSince(ymd(closedAt))`, refus au
     * delà de 30) ; la console, elle, comptait des MILLISECONDES
     * (`Math.floor((Date.now - closedAt) / 86400000)`) et en déduisait un
     * « jours restants » qui tombait à 0 un jour trop tôt : à J+30 elle retirait
     * le bouton — le seul point d'entrée de l'acte — alors que le serveur
     * acceptait encore la dérogation (mesuré : `{reopened:true, daysSinceClose:30}`),
     * et à J+29h23 elle annonçait « encore 1 jour » quand le compte calendaire
     * valait déjà 30. Deux horloges pour une règle : le décompte était faux d'un
     * jour dans les deux sens.
     *
     * Désormais `reopenClosed` ET l'écran lisent CETTE fonction. Le contrat :
     *   closedOn        date de clôture yyyy-MM-dd, ou null (jamais enregistrée)
     *   daysSinceClose  jours calendaires pleins écoulés, ou null
     *   windowDays      la fenêtre (30)
     *   daysLeft        jours pleins restants APRÈS aujourd'hui (0 le dernier jour)
     *   lastDay         aujourd'hui est le dernier jour où la dérogation passe
     *   canReopen       LA décision — exactement celle que `reopenClosed` applique
     *   refusal         le code de refus, à afficher tel quel, ou null
     *
     * A5 met le 30e jour DANS la fenêtre : la borne
     * est `days <= windowDays`, et rien d'autre ne doit la ré-écrire ailleurs.
     */
    static reopenWindow(cycle) {
        const windowDays = REOPEN_CLOSED_WINDOW_DAYS;
        const base = {
            applicable: false,
            closedOn: null,
            daysSinceClose: null,
            windowDays,
            daysLeft: null,
            lastDay: false,
            canReopen: false,
            refusal: null,
        };
        if (!cycle || String(cycle.status || '') !== 'closed')
            return { ...base, refusal: 'cycle_not_closed' };
        const closedOn = ymd(cycle.closedAt != null ? cycle.closedAt : cycle.closed_at);
        // Une clôture sans date n'est PAS « il y a 0 jour » : le délai n'est pas
        // vérifiable et la réouverture est refusée (règle maison : jamais un zéro
        // à la place d'une absence de mesure).
        if (!closedOn) return { ...base, applicable: true, refusal: 'cycle_closed_at_unknown' };
        const days = CycleService.daysSince(closedOn);
        if (days == null)
            return { ...base, applicable: true, closedOn, refusal: 'cycle_closed_at_unknown' };
        const canReopen = days <= windowDays;
        return {
            applicable: true,
            closedOn,
            daysSinceClose: days,
            windowDays,
            daysLeft: Math.max(0, windowDays - days),
            lastDay: canReopen && days >= windowDays,
            canReopen,
            refusal: canReopen ? null : 'cycle_reopen_window_expired',
        };
    }

    /** Jours pleins écoulés depuis une date yyyy-MM-dd (UTC), jamais négatif. */
    static daysSince(ymdStr) {
        const t = Date.parse(`${ymdStr}T00:00:00Z`);
        if (Number.isNaN(t)) return null;
        const now = Date.parse(`${today()}T00:00:00Z`);
        return Math.max(0, Math.round((now - t) / 86400000));
    }

    /** Jours de retard d'une campagne sur son échéance, ou null. */
    static overdueDays(cycle) {
        if (!cycle || !RUNNING.includes(String(cycle.status || ''))) return null;
        const k = ymd(cycle.closesAt);
        if (!k) return null;
        const d = CycleService.daysSince(k);
        return d && d > 0 ? d : null;
    }

    /**
     * Funnel counts by participant_state + roster totals, RBAC-scoped.
     * Returns every state key even when zero, so the console tiles never
     * silently drop "Non démarré" just because the query returned no rows.
     */
    static async progress(cycleId, user, { scope: pre } = {}) {
        const scope = await CycleService._scope(user, pre);
        const rows = await db.all(
            `SELECT v.participant_state AS state,
                    COUNT(*)::int                            AS n,
                    COALESCE(SUM(v.expected_skills), 0)::int AS expected,
                    COALESCE(SUM(v.rated_skills), 0)::int    AS rated,
                    COALESCE(SUM(v.submitted_skills), 0)::int AS submitted,
                    COALESCE(SUM(v.approved_skills), 0)::int AS approved,
                    COALESCE(SUM(v.rejected_skills), 0)::int AS rejected
               FROM v_cycle_participant_status v
               JOIN employees e ON e.id = v.employee_id
              WHERE v.cycle_id = ?${scope.clause}${NOT_ERASED}
              GROUP BY v.participant_state`,
            [Number(cycleId), ...scope.params]
        );

        const states = {};
        CycleService.STATES.forEach((s) => {
            states[s] = CycleService._emptyBucket();
        });
        rows.forEach((r) => {
            const key = String(r.state || 'not_started');
            if (!states[key]) states[key] = CycleService._emptyBucket();
            states[key] = {
                count: Number(r.n || 0),
                expected: Number(r.expected || 0),
                rated: Number(r.rated || 0),
                // submitted = every skill sitting with MANAGEMENT (submitted,
                // under_review, reviewed, arbitration) — migration 105; rejected
                // is its own bucket, never folded into "in progress".
                submitted: Number(r.submitted || 0),
                approved: Number(r.approved || 0),
                rejected: Number(r.rejected || 0),
            };
        });

        const roster = CycleService.STATES.reduce((a, s) => a + states[s].count, 0);
        const excluded = states.excluded.count;
        const active = roster - excluded;
        // Skill totals count the people actually being ASKED (excluded people are
        // not being asked), so the denominator and the numerator agree.
        const sum = (f) =>
            CycleService.STATES.filter((s) => s !== 'excluded').reduce(
                (a, s) => a + states[s][f],
                0
            );
        const expectedSkills = sum('expected');

        return {
            cycleId: Number(cycleId),
            states,
            totals: {
                participants: roster,
                active,
                excluded,
                expectedSkills,
                ratedSkills: sum('rated'),
                submittedSkills: sum('submitted'),
                approvedSkills: sum('approved'),
                rejectedSkills: sum('rejected'),
            },
            pct: {
                // Honest denominators: share of the people who are actually asked.
                started: CycleService._pct(active - states.not_started.count, active),
                inReview: CycleService._pct(states.in_review.count, active),
                approved: CycleService._pct(states.approved.count, active),
                skillsApproved: CycleService._pct(sum('approved'), expectedSkills),
            },
        };
    }

    /**
     * One compact funnel row per cycle, RBAC-scoped (optionally to one snapshotted
     * site) — powers the progress bar on the /cycles list without an N+1 of
     * progress calls. Cycles with no roster yet simply have no row (the caller
     * shows "non lancée").
     */
    static async progressSummaryAll(user, { siteId, scope: pre } = {}) {
        const scope = await CycleService._scope(user, pre);
        const site = Number(siteId) > 0 ? ' AND v.site_id = ?' : '';
        const rows = await db.all(
            `SELECT v.cycle_id AS "cycleId",
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE v.participant_state = 'excluded')::int    AS excluded,
                    COUNT(*) FILTER (WHERE v.participant_state = 'not_started')::int AS "notStarted",
                    COUNT(*) FILTER (WHERE v.participant_state = 'in_progress')::int AS "inProgress",
                    COUNT(*) FILTER (WHERE v.participant_state = 'in_review')::int   AS "inReview",
                    COUNT(*) FILTER (WHERE v.participant_state = 'approved')::int    AS approved
               FROM v_cycle_participant_status v
               JOIN employees e ON e.id = v.employee_id
              WHERE 1 = 1${scope.clause}${NOT_ERASED}${site}
              GROUP BY v.cycle_id`,
            [...scope.params, ...(site ? [Number(siteId)] : [])]
        );
        const out = {};
        rows.forEach((r) => {
            const total = Number(r.total || 0);
            const excluded = Number(r.excluded || 0);
            const active = total - excluded;
            out[Number(r.cycleId)] = {
                total,
                active,
                excluded,
                notStarted: Number(r.notStarted || 0),
                inProgress: Number(r.inProgress || 0),
                inReview: Number(r.inReview || 0),
                approved: Number(r.approved || 0),
                pctApproved: CycleService._pct(r.approved, active),
                pctInReview: CycleService._pct(r.inReview, active),
                pctInProgress: CycleService._pct(r.inProgress, active),
                pctNotStarted: CycleService._pct(r.notStarted, active),
            };
        });
        return out;
    }

    static get GROUPINGS() {
        return ['site', 'department', 'service', 'manager'];
    }

    /**
     * Shared grouped funnel. `by` selects the SNAPSHOTTED roster column used to
     * group — never the employee's live placement (site | department | service | manager).
     */
    static async _progressGrouped(cycleId, user, by, { scope: pre } = {}) {
        const scope = await CycleService._scope(user, pre);
        // Department and service names legitimately repeat across sites (three
        // "IT" on a development database), so those labels carry the site.
        const cfg =
            {
                site: {
                    col: 'v.site_id',
                    join: 'LEFT JOIN sites g ON g.id = v.site_id',
                    cols: 'g.name AS "labelA"',
                    group: 'v.site_id, g.name',
                },
                department: {
                    col: 'v.department_id',
                    join: 'LEFT JOIN departments g ON g.id = v.department_id LEFT JOIN sites gs ON gs.id = g.site_id',
                    cols: 'g.name AS "labelA", gs.name AS "labelB"',
                    group: 'v.department_id, g.name, gs.name',
                },
                service: {
                    col: 'v.service_id',
                    join: 'LEFT JOIN services g ON g.id = v.service_id LEFT JOIN departments gd ON gd.id = g.department_id LEFT JOIN sites gs ON gs.id = gd.site_id',
                    cols: 'g.name AS "labelA", gs.name AS "labelB"',
                    group: 'v.service_id, g.name, gs.name',
                },
                // 3.23.18: the LIVE responsable (explicit assignment, else the
                // live reporting line), typed — an admin-managed person gets their
                // admin's group, never "no manager" and never an employee who
                // happens to carry the admin's number. Labels are aggregated with
                // MAX so GROUP BY stays (kind, id): the UNION inside the lateral
                // switches the compat layer's GROUP BY expansion off.
                manager: {
                    col: 'rsp.id',
                    get join() {
                        return `JOIN cycle_participants p ON p.cycle_id = v.cycle_id AND p.employee_id = v.employee_id
                           ${responsibleLateral()}
                           ${RESPONSIBLE_NAME_JOINS}`;
                    },
                    cols: `rsp.kind AS "groupKind", MAX(${RESPONSIBLE_LABEL}) AS "labelA"`,
                    group: 'rsp.kind, rsp.id',
                },
            }[by] || null;
        if (!cfg) throw err('grouping_unknown');
        // NB: no `NULL AS ...` filler here — the compat layer's GROUP BY expansion
        // would append the constant to GROUP BY and PG rejects a non-integer
        // constant there. Each branch selects only the columns it groups on.
        const rows = await db.all(
            `SELECT ${cfg.col} AS "groupId",
                    ${cfg.cols},
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE v.participant_state = 'not_started')::int AS "notStarted",
                    COUNT(*) FILTER (WHERE v.participant_state = 'in_progress')::int AS "inProgress",
                    COUNT(*) FILTER (WHERE v.participant_state = 'in_review')::int  AS "inReview",
                    COUNT(*) FILTER (WHERE v.participant_state = 'approved')::int   AS approved,
                    COUNT(*) FILTER (WHERE v.participant_state = 'excluded')::int   AS excluded,
                    COALESCE(SUM(v.expected_skills), 0)::int AS "expectedSkills",
                    COALESCE(SUM(v.approved_skills), 0)::int AS "approvedSkills"
               FROM v_cycle_participant_status v
               JOIN employees e ON e.id = v.employee_id
               ${cfg.join}
              WHERE v.cycle_id = ?${scope.clause}${NOT_ERASED}
              GROUP BY ${cfg.group}
              ORDER BY COUNT(*) FILTER (WHERE v.participant_state IN ('not_started','in_review')) DESC,
                       COUNT(*) DESC`,
            [Number(cycleId), ...scope.params]
        );

        return rows.map((r) => {
            const total = Number(r.total || 0);
            const excluded = Number(r.excluded || 0);
            const active = total - excluded;
            const label =
                by === 'manager'
                    ? [r.labelA, r.labelB].filter(Boolean).join(' ') || null
                    : by === 'site'
                      ? r.labelA || null
                      : r.labelA
                        ? r.labelB
                            ? `${r.labelA} (${r.labelB})`
                            : r.labelA
                        : null;
            // An admin responsable is `admin:<id>` — never a bare number, which
            // the console would read as an EMPLOYEE id (the id spaces overlap).
            const isAdminGroup = by === 'manager' && r.groupKind === 'admin' && r.groupId != null;
            return {
                id:
                    r.groupId == null
                        ? null
                        : isAdminGroup
                          ? `admin:${r.groupId}`
                          : Number(r.groupId),
                ...(by === 'manager'
                    ? { kind: r.groupId == null ? null : isAdminGroup ? 'admin' : 'employee' }
                    : {}),
                label,
                total,
                active,
                notStarted: Number(r.notStarted || 0),
                inProgress: Number(r.inProgress || 0),
                inReview: Number(r.inReview || 0),
                approved: Number(r.approved || 0),
                excluded,
                expectedSkills: Number(r.expectedSkills || 0),
                approvedSkills: Number(r.approvedSkills || 0),
                pctApproved: CycleService._pct(r.approved, active),
                pctNotStarted: CycleService._pct(r.notStarted, active),
                pctInReview: CycleService._pct(r.inReview, active),
            };
        });
    }

    /** Funnel grouped by the roster's snapshotted site. */
    static async progressBySite(cycleId, user, opts) {
        return CycleService._progressGrouped(cycleId, user, 'site', opts);
    }

    /** Funnel grouped by a snapshotted org column: site | department | service | manager. */
    static async progressBy(by, cycleId, user, opts) {
        return CycleService._progressGrouped(cycleId, user, by, opts);
    }

    /**
     * Funnel grouped by the LIVE responsable (explicit console assignment, else
     * the live reporting line — 3.23.18, R1) — this is the view that names the
     * person who is sitting on submissions (high "En revue"). Admin responsables
     * form their own groups (`id: 'admin:<id>'`, `kind: 'admin'`).
     */
    static async progressByManager(cycleId, user, opts) {
        return CycleService._progressGrouped(cycleId, user, 'manager', opts);
    }

    /** Option lists for the roster filters, read from the ROSTER itself (so a scoped admin only sees their own). */
    static async filterOptions(cycleId, user, { scope: pre } = {}) {
        const scope = await CycleService._scope(user, pre);
        const base = (col, join, label, order) =>
            db.all(
                `SELECT DISTINCT ${col} AS id, ${label} AS label
               FROM v_cycle_participant_status v
               JOIN employees e ON e.id = v.employee_id
               ${join}
              WHERE v.cycle_id = ?${scope.clause}${NOT_ERASED} AND ${col} IS NOT NULL
              ORDER BY ${order || 'label'}`,
                [Number(cycleId), ...scope.params]
            );
        const [sites, departments, services, roles, supervisors, none] = await Promise.all([
            base('v.site_id', 'LEFT JOIN sites g ON g.id = v.site_id', 'g.name'),
            base(
                'v.department_id',
                'LEFT JOIN departments g ON g.id = v.department_id LEFT JOIN sites gs ON gs.id = g.site_id',
                "g.name || ' (' || COALESCE(gs.name, '') || ')'"
            ),
            base(
                'v.service_id',
                'LEFT JOIN services g ON g.id = v.service_id LEFT JOIN departments gd ON gd.id = g.department_id LEFT JOIN sites gs ON gs.id = gd.site_id',
                "g.name || ' (' || COALESCE(gs.name, '') || ')'"
            ),
            db.all(
                `SELECT DISTINCT p.role_id AS id, g.name AS label
                   FROM cycle_participants p
                   JOIN employees e ON e.id = p.employee_id
                   LEFT JOIN roles g ON g.id = p.role_id
                  WHERE p.cycle_id = ?${scope.clause}${NOT_ERASED} AND p.role_id IS NOT NULL
                  ORDER BY label`,
                [Number(cycleId), ...scope.params]
            ),
            // this was the ONE place in src/ that concatenated last_name
            // BEFORE first_name, so the same person was « Clara Beatrice NOVAK » in
            // the roster (:1119) and « Beatrice NOVAK Clara » in this page's own
            // filter — and the label no longer matched the order the search on the
            // same page indexes (:1008). One order everywhere: given name, then family name.
            // 3.23.18: the responsables offered are the LIVE ones — the same
            // rule as the grouping and the filter they drive — typed, so an admin
            // responsable is offered as `admin:<id>`.
            db.all(
                `SELECT DISTINCT rsp.kind AS kind, rsp.id AS id, ${RESPONSIBLE_LABEL} AS label
                   FROM v_cycle_participant_status v
                   JOIN employees e ON e.id = v.employee_id
                   JOIN cycle_participants p ON p.cycle_id = v.cycle_id AND p.employee_id = v.employee_id
                   ${responsibleLateral()}
                   ${RESPONSIBLE_NAME_JOINS}
                  WHERE v.cycle_id = ?${scope.clause}${NOT_ERASED} AND rsp.id IS NOT NULL
                  ORDER BY label`,
                [Number(cycleId), ...scope.params]
            ),
            db.get(
                `SELECT COUNT(*)::int AS n
                   FROM cycle_participants p
                   JOIN employees e ON e.id = p.employee_id
                   ${responsibleLateral()}
                  WHERE p.cycle_id = ?${scope.clause}${NOT_ERASED}
                    AND rsp.id IS NULL`,
                [Number(cycleId), ...scope.params]
            ),
        ]);
        const norm = (rows) =>
            (rows || []).map((r) => ({
                id: r.kind === 'admin' ? `admin:${Number(r.id)}` : Number(r.id),
                ...(r.kind ? { kind: r.kind } : {}),
                label: String(r.label || '').trim() || `#${r.id}`,
            }));
        // `supervisors` stays EMPLOYEES only: the console also feeds it to the
        // "assign a reviewer" dialog as `employee:<id>`. Admin responsables are
        // offered separately, as `admin:<id>` filter tokens.
        const responsibles = supervisors || [];
        const empResponsibles = responsibles.filter((r) => r.kind !== 'admin');
        const adminResponsibles = responsibles.filter((r) => r.kind === 'admin');
        return {
            sites: norm(sites),
            departments: norm(departments),
            services: norm(services),
            roles: norm(roles),
            supervisors: norm(empResponsibles),
            adminResponsibles: norm(adminResponsibles),
            noSupervisor: Number((none && none.n) || 0),
        };
    }

    /** Parse the console's roster filters from a query object (arrays or scalars; "none" = no reviewer). */
    static parseFilters(query = {}) {
        const q = query || {};
        const sup = Array.isArray(q.supervisorId)
            ? q.supervisorId
            : q.supervisorId == null || q.supervisorId === ''
              ? []
              : [q.supervisorId];
        return {
            state: CycleService.STATES.includes(String(q.state || '')) ? String(q.state) : '',
            badState: !!(q.state && !CycleService.STATES.includes(String(q.state))),
            q: String(q.q || '').trim(),
            siteId: toIdList(q.siteId),
            departmentId: toIdList(q.departmentId),
            serviceId: toIdList(q.serviceId),
            roleId: toIdList(q.roleId),
            // Employee ids as numbers, admin responsables as `admin:<id>` tokens
            // (3.23.18, R1) — kept in ONE list so the console's query string
            // round-trips both; _rosterWhere splits them.
            supervisorId: (() => {
                const t = splitResponsibleTokens(sup);
                return [...t.empIds, ...t.adminIds.map((n) => `admin:${n}`)];
            })(),
            noSupervisor: sup.some((v) => String(v) === 'none'),
        };
    }

    /** WHERE fragments + params for the roster filters (shared by list, count, export, bulk-by-filter). */
    static _rosterWhere(f, params) {
        const where = [];
        if (f.state) {
            where.push(' AND v.participant_state = ?');
            params.push(f.state);
        }
        if (f.siteId && f.siteId.length) {
            where.push(' AND v.site_id = ANY(?)');
            params.push(f.siteId);
        }
        if (f.departmentId && f.departmentId.length) {
            where.push(' AND v.department_id = ANY(?)');
            params.push(f.departmentId);
        }
        if (f.serviceId && f.serviceId.length) {
            where.push(' AND v.service_id = ANY(?)');
            params.push(f.serviceId);
        }
        if (f.roleId && f.roleId.length) {
            where.push(' AND p.role_id = ANY(?)');
            params.push(f.roleId);
        }
        // "Responsable" (3.23.18, R1): the LIVE responsable — `rsp`, joined by
        // ROSTER_JOINS — typed, the same rule the grouping and the options use.
        // It filtered the launch snapshot, so clicking a group (live) and the
        // filter it set (snapshot) could list two different populations.
        {
            const t = splitResponsibleTokens(f.supervisorId);
            const any = [];
            if (t.empIds.length) {
                any.push("(rsp.kind = 'employee' AND rsp.id = ANY(?))");
                params.push(t.empIds);
            }
            if (t.adminIds.length) {
                any.push("(rsp.kind = 'admin' AND rsp.id = ANY(?))");
                params.push(t.adminIds);
            }
            if (f.noSupervisor) any.push('rsp.id IS NULL');
            if (any.length) where.push(` AND (${any.join(' OR ')})`);
        }
        const term = (f.q == null ? '' : String(f.q)).trim();
        if (term) {
            // `q` also matches the snapshotted site / department / manager names.
            const { ilike } = require('../utils/searchSql');
            where.push(
                ` AND ${ilike("(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'') || ' ' || COALESCE(e.employee_number,'') || ' ' || COALESCE(s.name,'') || ' ' || COALESCE(d.name,'') || ' ' || COALESCE(sup.first_name,'') || ' ' || COALESCE(sup.last_name,''))")}`
            );
            params.push(`%${term}%`);
        }
        return where.join('');
    }

    static get ROSTER_JOINS() {
        // `rsp` = the live responsable (see responsibleLateral) — a LEFT JOIN
        // LATERAL ... LIMIT 1, so it adds and removes no roster row.
        return `FROM v_cycle_participant_status v
               JOIN employees e ON e.id = v.employee_id
               JOIN cycle_participants p ON p.cycle_id = v.cycle_id AND p.employee_id = v.employee_id
               LEFT JOIN sites s       ON s.id = v.site_id
               LEFT JOIN departments d ON d.id = v.department_id
               LEFT JOIN employees sup ON sup.id = v.supervisor_id
               ${responsibleLateral()}`;
    }

    /**
     * Roster list: one row per PERSON with their state and their FULL expected
     * skill count. Filters and sort change the VIEW only — they never change what
     * anybody is asked to assess.
     *
     * opts: { state, q, siteId[], departmentId[], serviceId[], roleId[], supervisorId[],
     *         noSupervisor, sort, dir, limit, offset, scope }
     *
     * `roleChanged` / `liveRoleName` / `liveExpectedSkills` (SECTION campaign-rules, règle 12,
     * HR3-11): the person is counted on the role they held AT ENROLMENT —
     * expected_skills is frozen at launch and is NEVER reduced. The live role and
     * its own skill count are returned beside it so a mid-campaign role change is
     * VISIBLE instead of silent.
     */
    static async participants(cycleId, user, opts = {}) {
        const scope = await CycleService._scope(user, opts.scope);
        const { sortClause } = require('../utils/listTools');
        const f = CycleService.parseFilters(opts);
        if (opts.noSupervisor === true) f.noSupervisor = true;
        const params = [Number(cycleId), ...scope.params];
        const filter = CycleService._rosterWhere(f, params);
        const sort = sortClause({ sort: opts.sort, dir: opts.dir }, SORT_COLUMNS, 'state', {
            tiebreak: 'e.last_name ASC, e.first_name ASC',
        });

        const lim = Math.max(1, Math.min(5000, Number(opts.limit) || 50));
        const off = Math.max(0, Number(opts.offset) || 0);

        const rows = await db.all(
            `SELECT v.employee_id           AS "employeeId",
                    e.first_name            AS "firstName",
                    e.last_name             AS "lastName",
                    e.employee_number       AS "employeeNumber",
                    e.is_active             AS "isActive",
                    v.participant_state     AS state,
                    v.expected_skills       AS "expectedSkills",
                    v.rated_skills          AS "ratedSkills",
                    v.submitted_skills      AS "submittedSkills",
                    v.approved_skills       AS "approvedSkills",
                    v.rejected_skills       AS "rejectedSkills",
                    v.excluded_at           AS "excludedAt",
                    p.exclusion_reason      AS "exclusionReason",
                    p.exclusion_category    AS "exclusionCategory",
                    p.excluded_until        AS "excludedUntil",
                    p.included_at           AS "includedAt",
                    p.last_excluded_at      AS "lastExcludedAt",
                    p.last_exclusion_reason AS "lastExclusionReason",
                    p.last_exclusion_category AS "lastExclusionCategory",
                    exb.username            AS "excludedBy",
                    inb.username            AS "includedBy",
                    p.reviewer_admin_id     AS "reviewerAdminId",
                    rva.username            AS "reviewerAdmin",
                    v.site_id               AS "siteId",
                    s.name                  AS "siteName",
                    v.department_id         AS "departmentId",
                    d.name                  AS "departmentName",
                    sv.name                 AS "serviceName",
                    rl.name                 AS "roleName",
                    (p.role_id IS DISTINCT FROM e.role_id) AS "roleChanged",
                    lrl.name                AS "liveRoleName",
                    (SELECT COUNT(*)::int FROM role_skill_requirements rr
                      WHERE rr.role_id = e.role_id AND COALESCE(rr.required_level, 0) > 0) AS "liveExpectedSkills",
                    v.supervisor_id         AS "supervisorId",
                    sup.first_name          AS "supFirstName",
                    sup.last_name           AS "supLastName",
                    sup.is_active           AS "supActive",
                    rsp.kind                AS "responsibleKind",
                    rsp.id                  AS "responsibleId",
                    (rsp.kind IS DISTINCT FROM rec.kind OR rsp.id IS DISTINCT FROM rec.id) AS "transferred",
                    (SELECT MAX(x.sent_at) FROM (
                        SELECT rl2.sent_at FROM reminder_log rl2
                         WHERE rl2.target_type = 'employee' AND rl2.target_id = v.employee_id AND rl2.ref_id = v.cycle_id
                           AND rl2.kind IN ('cycle.not_started', 'cycle.manual_nudge')
                        UNION ALL
                        SELECT nl.sent_at FROM nudge_log nl
                         WHERE nl.target_type = 'employee' AND nl.target_id = v.employee_id AND nl.cycle_id = v.cycle_id
                    ) x)                    AS "lastNudgeAt"
               ${CycleService.ROSTER_JOINS}
               ${recordedLateral()}
               LEFT JOIN services sv ON sv.id = v.service_id
               LEFT JOIN roles rl ON rl.id = p.role_id
               LEFT JOIN roles lrl ON lrl.id = e.role_id
               LEFT JOIN admins exb ON exb.id = p.excluded_by_admin_id
               LEFT JOIN admins inb ON inb.id = p.included_by_admin_id
               LEFT JOIN admins rva ON rva.id = p.reviewer_admin_id
              WHERE v.cycle_id = ?${scope.clause}${NOT_ERASED}${filter}
              ORDER BY ${sort.orderBy}
              LIMIT ? OFFSET ?`,
            [...params, lim, off]
        );

        const totalRow = await db.get(
            `SELECT COUNT(*)::int AS n
               ${CycleService.ROSTER_JOINS}
              WHERE v.cycle_id = ?${scope.clause}${NOT_ERASED}${filter}`,
            params
        );

        return {
            rows: rows.map((r) => ({
                ...r,
                fullName: [r.firstName, r.lastName].filter(Boolean).join(' '),
                supervisorName: [r.supFirstName, r.supLastName].filter(Boolean).join(' ') || null,
                transferred: r.transferred === true || r.transferred === 't',
                roleChanged: r.roleChanged === true || r.roleChanged === 't',
                liveExpectedSkills:
                    r.liveExpectedSkills == null ? null : Number(r.liveExpectedSkills),
                expectedSkills: Number(r.expectedSkills || 0),
                ratedSkills: Number(r.ratedSkills || 0),
                submittedSkills: Number(r.submittedSkills || 0),
                approvedSkills: Number(r.approvedSkills || 0),
                rejectedSkills: Number(r.rejectedSkills || 0),
                pct: CycleService._pct(r.approvedSkills, r.expectedSkills),
            })),
            total: Number((totalRow && totalRow.n) || 0),
            limit: lim,
            offset: off,
            state: f.state || null,
            q: f.q || null,
            sort: { key: sort.key, dir: sort.dir },
        };
    }

    /** Every employee id matching the filters (for "excuse / chase the whole filter"). */
    static async participantIds(cycleId, user, opts = {}) {
        const scope = await CycleService._scope(user, opts.scope);
        const f = CycleService.parseFilters(opts);
        if (opts.noSupervisor === true) f.noSupervisor = true;
        const params = [Number(cycleId), ...scope.params];
        const filter = CycleService._rosterWhere(f, params);
        const rows = await db.all(
            `SELECT v.employee_id AS "employeeId"
               ${CycleService.ROSTER_JOINS}
              WHERE v.cycle_id = ?${scope.clause}${NOT_ERASED}${filter}
              LIMIT 5000`,
            params
        );
        return rows.map((r) => Number(r.employeeId));
    }

    // ---- Roster write side (PERSON-level only) ---------------------------

    /** True when `employeeId` is on this cycle's roster AND inside the actor's clearance. */
    static async _rosterInScope(cycleId, employeeId, user, pre) {
        const scope = await CycleService._scope(user, pre);
        const row = await db.get(
            `SELECT 1 AS ok
               FROM cycle_participants p
               JOIN employees e ON e.id = p.employee_id
              WHERE p.cycle_id = ? AND p.employee_id = ?${scope.clause}`,
            [Number(cycleId), Number(employeeId), ...scope.params]
        );
        return Boolean(row && row.ok);
    }

    /** Roster ids inside the actor's clearance among `employeeIds` (one query, not N). */
    static async _rosterIdsInScope(cycleId, employeeIds, user, pre) {
        const ids = toIdList(employeeIds);
        if (!ids.length) return [];
        const scope = await CycleService._scope(user, pre);
        const rows = await db.all(
            `SELECT p.employee_id AS "employeeId"
               FROM cycle_participants p
               JOIN employees e ON e.id = p.employee_id
              WHERE p.cycle_id = ? AND p.employee_id = ANY(?)${scope.clause}${NOT_ERASED}`,
            [Number(cycleId), ids, ...scope.params]
        );
        return rows.map((r) => Number(r.employeeId));
    }

    static _normaliseExclusion(input) {
        const o = input && typeof input === 'object' ? input : { reason: input };
        const why = (o.reason == null ? '' : String(o.reason)).trim();
        if (!why) throw err('exclusion_reason_required');
        const category = o.category == null || o.category === '' ? 'other' : String(o.category);
        if (!USER_CATEGORIES.includes(category)) throw err('exclusion_category_invalid');
        let until = null;
        if (o.until != null && o.until !== '') {
            until = ymd(o.until);
            if (!until) throw err('exclusion_until_invalid');
            if (until < today()) throw err('exclusion_until_past');
        }
        return { reason: why.slice(0, 500), category, until };
    }

    static async _names(ids) {
        if (!ids.length) return new Map();
        const rows = await db.all(
            'SELECT id, first_name AS "firstName", last_name AS "lastName" FROM employees WHERE id = ANY(?)',
            [ids]
        );
        return new Map(
            rows.map((r) => [Number(r.id), [r.firstName, r.lastName].filter(Boolean).join(' ')])
        );
    }

    /**
     * Take ONE PERSON off the campaign (long-term absence, departure, transfer
     * out) with a written reason + category, optionally until a date. This is the
     * ONLY exclusion the campaign console offers: a person can be excused, a SKILL
     * never can — the number of skills a role is assessed on is the department's
     * design and is not negotiable here. Only while the campaign RUNS.
     */
    static async excludeParticipant(cycleId, employeeId, reasonOrOpts, actor, { scope } = {}) {
        const x = CycleService._normaliseExclusion(reasonOrOpts);
        const cycle = await CycleService._assertRunning(cycleId);
        if (!(await CycleService._rosterInScope(cycleId, employeeId, actor, scope))) {
            throw err('participant_not_in_scope');
        }
        const res = await db.run(
            `UPDATE cycle_participants
                SET excluded_at = now(), exclusion_reason = ?, exclusion_category = ?, excluded_until = ?,
                    excluded_by_admin_id = ?
              WHERE cycle_id = ? AND employee_id = ? AND excluded_at IS NULL`,
            [x.reason, x.category, x.until, actorId(actor), Number(cycleId), Number(employeeId)]
        );
        const changed = res && res.changes ? res.changes : 0;
        if (changed) {
            const names = await CycleService._names([Number(employeeId)]);
            await audit({
                adminId: actorId(actor),
                action: 'cycle_participant_excluded',
                entityType: 'cycle_participant',
                entityId: Number(employeeId),
                details: CycleService._excludeLine(
                    cycle,
                    Number(employeeId),
                    names.get(Number(employeeId)),
                    x,
                    actor
                ),
            });
        }
        return { changed };
    }

    static _excludeLine(cycle, employeeId, name, x, actor) {
        return (
            `Cycle #${cycle.id} (${cycle.code || ''}) — ${name || 'participant'} (#${employeeId}) excusé(e) (personne) : ` +
            `${CATEGORY_FR[x.category] || x.category} — ${x.reason.slice(0, 200)}` +
            (x.until ? ` — jusqu'au ${x.until}` : '') +
            ` — par ${actorLabel(actor)}`
        );
    }

    /**
     * Excuse MANY people in ONE transaction with ONE reason: one
     * audit line per person, actor + date on every row. `employeeIds` or a roster
     * `filter` ("everyone matching the current filter"). People outside the actor's
     * clearance or already excused are reported, never silently dropped.
     */
    static async excludeBulk(
        cycleId,
        { employeeIds, filter } = {},
        reasonOrOpts,
        actor,
        { scope: pre } = {}
    ) {
        const x = CycleService._normaliseExclusion(reasonOrOpts);
        const cycle = await CycleService._assertRunning(cycleId);
        const scope = await CycleService._scope(actor, pre);
        const wanted = filter
            ? await CycleService.participantIds(cycleId, actor, { ...filter, scope })
            : toIdList(employeeIds);
        if (!wanted.length) throw err('exclusion_selection_empty');
        const inScope = await CycleService._rosterIdsInScope(cycleId, wanted, actor, scope);
        const outOfScope = wanted.filter((id) => !inScope.includes(id));
        let changed = 0;
        const done = [];
        await db.runTransaction(async () => {
            if (inScope.length) {
                const rows = await db.all(
                    `UPDATE cycle_participants
                        SET excluded_at = now(), exclusion_reason = ?, exclusion_category = ?, excluded_until = ?,
                            excluded_by_admin_id = ?
                      WHERE cycle_id = ? AND employee_id = ANY(?) AND excluded_at IS NULL
                      RETURNING employee_id AS "employeeId"`,
                    [x.reason, x.category, x.until, actorId(actor), Number(cycleId), inScope]
                );
                (rows || []).forEach((r) => done.push(Number(r.employeeId)));
                changed = done.length;
            }
            const names = await CycleService._names(done);
            for (const eid of done) {
                await audit({
                    adminId: actorId(actor),
                    action: 'cycle_participant_excluded',
                    entityType: 'cycle_participant',
                    entityId: eid,
                    details: CycleService._excludeLine(cycle, eid, names.get(eid), x, actor),
                });
            }
        });
        return {
            requested: wanted.length,
            changed,
            alreadyExcluded: inScope.length - changed,
            outOfScope: outOfScope.length,
        };
    }

    /** Put an excused person back on the campaign (person-level, audited, history kept). */
    static async includeParticipant(cycleId, employeeId, actor, { scope } = {}) {
        const cycle = await CycleService._assertRunning(cycleId);
        if (!(await CycleService._rosterInScope(cycleId, employeeId, actor, scope))) {
            throw err('participant_not_in_scope');
        }
        const cur = await db.get(
            `SELECT p.exclusion_category AS category, e.is_active AS "isActive", e.erased_at AS "erasedAt"
               FROM cycle_participants p JOIN employees e ON e.id = p.employee_id
              WHERE p.cycle_id = ? AND p.employee_id = ?`,
            [Number(cycleId), Number(employeeId)]
        );
        // An erased subject never comes back; a deactivated one only once reactivated.
        if (cur && (cur.category === 'erased' || cur.erasedAt)) throw err('participant_erased');
        if (cur && cur.isActive === false) throw err('participant_inactive');
        const res = await db.run(
            `UPDATE cycle_participants
                SET last_excluded_at = excluded_at, last_exclusion_reason = exclusion_reason,
                    last_exclusion_category = exclusion_category, last_excluded_by_admin_id = excluded_by_admin_id,
                    excluded_at = NULL, exclusion_reason = NULL, exclusion_category = NULL,
                    excluded_until = NULL, excluded_by_admin_id = NULL,
                    included_at = now(), included_by_admin_id = ?
              WHERE cycle_id = ? AND employee_id = ? AND excluded_at IS NOT NULL`,
            [actorId(actor), Number(cycleId), Number(employeeId)]
        );
        const changed = res && res.changes ? res.changes : 0;
        if (changed) {
            const names = await CycleService._names([Number(employeeId)]);
            await audit({
                adminId: actorId(actor),
                action: 'cycle_participant_included',
                entityType: 'cycle_participant',
                entityId: Number(employeeId),
                details: `Cycle #${cycle.id} (${cycle.code || ''}) — ${names.get(Number(employeeId)) || 'participant'} (#${employeeId}) réintégré(e) à la campagne par ${actorLabel(actor)}`,
            });
        }
        return { changed };
    }

    /**
     * Name a reviewer for a participant: an active employee supervisor
     * or an admin. Audited; scope-checked.
     *
     * EXPLICIT, AND SAID SO (3.23.17, F1/F2). The choice lands in the same
     * columns the launch snapshot fills, so `reviewer_assigned_at/_by_*`
     * (migration 146) mark it as a deliberate assignment. From then on:
     *   - SelfAssessmentWorkflowService.resolveAuthority lets that person review
     *     this employee's self-assessments OF THIS CYCLE (never their own), and
     *     the review queue lists them;
     *   - every reminder goes to them (REVIEWER_TARGET_LATERAL), not to the
     *     launch-time reviewer and not to a later line change.
     * An employee assignment is `supervisor_id` with `reviewer_admin_id` NULL; an
     * admin assignment is `reviewer_admin_id` (the snapshot supervisor is kept
     * for the console's history).
     */
    static async assignReviewer(
        cycleId,
        employeeId,
        { supervisorId, adminId },
        actor,
        { scope } = {}
    ) {
        const cycle = await CycleService._assertRunning(cycleId);
        if (!(await CycleService._rosterInScope(cycleId, employeeId, actor, scope)))
            throw err('participant_not_in_scope');
        let line;
        if (Number(supervisorId) > 0) {
            const sup = await db.get(
                'SELECT id, first_name AS "firstName", last_name AS "lastName" FROM employees WHERE id = ? AND is_active AND erased_at IS NULL',
                [Number(supervisorId)]
            );
            if (!sup || Number(sup.id) === Number(employeeId)) throw err('reviewer_invalid');
            await db.run(
                `UPDATE cycle_participants
                    SET supervisor_id = ?, reviewer_admin_id = NULL,
                        reviewer_assigned_at = now(), reviewer_assigned_by_admin_id = ?, reviewer_assigned_by_ref = ?
                  WHERE cycle_id = ? AND employee_id = ?`,
                [
                    Number(supervisorId),
                    actorId(actor),
                    actorRef(actor),
                    Number(cycleId),
                    Number(employeeId),
                ]
            );
            line = `${[sup.firstName, sup.lastName].filter(Boolean).join(' ')} (#${sup.id})`;
        } else if (Number(adminId) > 0) {
            const adm = await db.get(
                'SELECT id, username FROM admins WHERE id = ? AND COALESCE(is_active, true) = true',
                [Number(adminId)]
            );
            if (!adm) throw err('reviewer_invalid');
            await db.run(
                `UPDATE cycle_participants
                    SET reviewer_admin_id = ?,
                        reviewer_assigned_at = now(), reviewer_assigned_by_admin_id = ?, reviewer_assigned_by_ref = ?
                  WHERE cycle_id = ? AND employee_id = ?`,
                [
                    Number(adminId),
                    actorId(actor),
                    actorRef(actor),
                    Number(cycleId),
                    Number(employeeId),
                ]
            );
            line = `admin ${adm.username} (#${adm.id})`;
        } else {
            throw err('reviewer_invalid');
        }
        await audit({
            adminId: actorId(actor),
            action: 'cycle_reviewer_assigned',
            entityType: 'cycle_participant',
            entityId: Number(employeeId),
            details: `Cycle #${cycle.id} (${cycle.code || ''}) — réviseur de #${employeeId} assigné : ${line} — par ${actorLabel(actor)}`,
        });
        return { assigned: true };
    }

    /**
     * Manual chase. Targets: `employeeIds`, or `all` = every
     * not-yet-approved person in the actor's clearance (a manager: their reports),
     * optionally narrowed by `supervisorId` / `siteId`.
     *   - not_started / in_progress → the PERSON (only while the campaign is OPEN;
     *     a locked campaign cannot be submitted to);
     *   - in_review → whoever HOLDS the review now (REVIEWER_TARGET_LATERAL:
     *     explicit console assignment, else the live line, else the launch
     *     snapshot), once per reviewer.
     * Claim-before-send on reminder_log, kind 'cycle.manual_nudge', one per target
     * and day — a second click the same day answers "déjà relancé aujourd'hui".
     */
    static async nudge(
        cycleId,
        { employeeIds, all, supervisorId, siteId, states } = {},
        actor,
        { scope: pre } = {}
    ) {
        const cycle = await CycleService._assertRunning(cycleId);
        const scope = await CycleService._scope(actor, pre);
        const params = [Number(cycleId), ...scope.params];
        let sel = '';
        if (!all) {
            const ids = toIdList(employeeIds);
            if (!ids.length) throw err('nudge_selection_empty');
            sel += ' AND v.employee_id = ANY(?)';
            params.push(ids);
        }
        // "Relancer" on a Responsable group (3.23.18, R1): the group is the LIVE
        // responsable, so the chase selects the same people — `rsp`, typed
        // (`12` = an employee, `admin:3` = an admin account). It selected the
        // launch snapshot, i.e. not the people the row it sits on counted.
        let sup = null;
        if (supervisorId != null && supervisorId !== '') {
            const t = splitResponsibleTokens([supervisorId]);
            if (t.empIds.length) sup = { kind: 'employee', id: t.empIds[0] };
            else if (t.adminIds.length) sup = { kind: 'admin', id: t.adminIds[0] };
            // A responsable was NAMED but is unreadable: refuse, never widen to
            // "everyone" by dropping the filter.
            else throw err('nudge_selection_empty');
        }
        if (sup) {
            sel += ' AND rsp.kind = ? AND rsp.id = ?';
            params.push(sup.kind, sup.id);
        }
        if (Number(siteId) > 0) {
            sel += ' AND v.site_id = ?';
            params.push(Number(siteId));
        }
        const wantedStates = (Array.isArray(states) ? states : []).filter((s) =>
            ['not_started', 'in_progress', 'in_review'].includes(s)
        );
        if (wantedStates.length) {
            sel += ' AND v.participant_state = ANY(?)';
            params.push(wantedStates);
        }
        const rows = await db.all(
            `SELECT v.employee_id AS "employeeId", v.participant_state AS state, v.expected_skills AS expected,
                    e.first_name AS "firstName",
                    CASE WHEN rv.target_type = 'employee' THEN rv.target_id END AS "reviewerId",
                    CASE WHEN rv.target_type = 'admin' THEN rv.target_id END AS "reviewerAdminId"
               FROM v_cycle_participant_status v
               JOIN employees e ON e.id = v.employee_id AND e.is_active
               JOIN cycle_participants p ON p.cycle_id = v.cycle_id AND p.employee_id = v.employee_id
               ${REVIEWER_TARGET_LATERAL}
               ${sup ? responsibleLateral() : ''}
              WHERE v.cycle_id = ?${scope.clause}${NOT_ERASED} AND v.excluded_at IS NULL
                AND v.participant_state IN ('not_started', 'in_progress', 'in_review')${sel}`,
            params
        );
        const N = require('./NotificationService');
        const { claim, release } = require('../jobs/reminders');
        const day = today();
        const closesOn = ymd(cycle.closesAt || cycle.closes_at) || '';
        const out = {
            targets: rows.length,
            sent: 0,
            reviewersNotified: 0,
            alreadyToday: 0,
            lockedSkipped: 0,
            noReviewer: 0,
        };
        const reviewers = new Map();
        for (const r of rows) {
            if (r.state === 'in_review') {
                const key = r.reviewerId
                    ? `employee:${r.reviewerId}`
                    : r.reviewerAdminId
                      ? `admin:${r.reviewerAdminId}`
                      : null;
                if (!key) {
                    out.noReviewer++;
                    continue;
                }
                reviewers.set(key, (reviewers.get(key) || 0) + 1);
                continue;
            }
            if (cycle.status !== 'open') {
                out.lockedSkipped++;
                continue;
            }
            if (!(await claim('cycle.manual_nudge', 'employee', r.employeeId, cycle.id, day))) {
                out.alreadyToday++;
                continue;
            }
            const res = await N.notify({
                userType: 'employee',
                userId: Number(r.employeeId),
                kind: 'cycle.reminder',
                category: 'workflow',
                payload: {
                    cycleId: Number(cycle.id),
                    cycle: cycle.code,
                    closesOn,
                    expected: Number(r.expected || 0),
                    stage: 'manual',
                    link: '/employee/self-assessment',
                },
            });
            if (!res || res.inapp === 'error') {
                await release('cycle.manual_nudge', 'employee', r.employeeId, cycle.id, day);
                continue;
            }
            out.sent++;
        }
        for (const [key, pending] of reviewers) {
            const [type, id] = key.split(':');
            if (!(await claim('cycle.manual_nudge', type, Number(id), cycle.id, day))) {
                out.alreadyToday++;
                continue;
            }
            const res = await N.notify({
                userType: type,
                userId: Number(id),
                kind: 'cycle.escalation',
                category: 'workflow',
                payload: {
                    cycleId: Number(cycle.id),
                    cycle: cycle.code,
                    closesOn,
                    pending,
                    stage: 'manual',
                    link: `/supervisor/self-assessment-reviews?cycleId=${cycle.id}`,
                },
            });
            if (!res || res.inapp === 'error') {
                await release('cycle.manual_nudge', type, Number(id), cycle.id, day);
                continue;
            }
            out.reviewersNotified++;
        }
        await audit({
            adminId: actorId(actor),
            action: 'cycle_manual_nudge',
            entityType: 'assessment_cycle',
            entityId: Number(cycle.id),
            actorRef: actor && actor.userType !== 'admin' ? `${actor.userType}:${actor.id}` : null,
            details:
                `Cycle #${cycle.id} (${cycle.code || ''}) — relance manuelle par ${actorLabel(actor)} : ${out.sent} personne(s), ${out.reviewersNotified} responsable(s)` +
                (out.alreadyToday ? `, ${out.alreadyToday} déjà relancé(s) aujourd'hui` : '') +
                (out.lockedSkipped
                    ? `, ${out.lockedSkipped} non relancé(s) (campagne verrouillée)`
                    : ''),
        });
        return out;
    }

    /**
     * HONEST close. close alone flips a status and finalises rows; it says
     * nothing about how much of the campaign actually happened, so a cycle that
     * reached 41% closed exactly like one that reached 100%.
     *
     * This WRAPS close (behaviour and 'cycle.closed' emission untouched) and:
     *   0. reconciles the roster first, so a deactivated or erased subject is never
     *      written into the closing line as "jamais démarré";
     *   1. stamps completed_at on the participants who genuinely finished
     *      (state = approved) — the rest are deliberately LEFT UNSTAMPED, because
     *      pretending an unfinished participant completed is the dishonesty this
     *      method exists to prevent;
     *   2. writes an audit line that names the shortfall in plain French.
     *
     * The disposition is computed cycle-WIDE (not through the actor's scope):
     * closing is a whole-campaign act, so the recorded truth must be the whole
     * campaign's truth.
     */
    static async closeWithDisposition(cycleId, actor, { emit } = {}) {
        const id = Number(cycleId);
        try {
            await CycleService.reconcileParticipants(id);
        } catch (e) {
            console.error('[cycle] reconcile before close failed:', e.message);
        }
        // Cycle-wide funnel: pass a synthetic superadmin so scopeFilter is a no-op.
        const before = await CycleService.progress(id, { userType: 'admin', role: 'superadmin' });

        const stamped = await db.run(
            `UPDATE cycle_participants p
                SET completed_at = now()
               FROM v_cycle_participant_status v
              WHERE v.cycle_id = p.cycle_id
                AND v.employee_id = p.employee_id
                AND p.cycle_id = ?
                AND p.completed_at IS NULL
                AND v.participant_state = 'approved'`,
            [id]
        );

        await CycleService.close(id, { emit });

        const disposition = {
            cycleId: id,
            participants: before.totals.participants,
            active: before.totals.active,
            excluded: before.totals.excluded,
            neverStarted: before.states.not_started.count,
            inProgress: before.states.in_progress.count,
            inReview: before.states.in_review.count,
            approved: before.states.approved.count,
            completedStamped: stamped && stamped.changes ? stamped.changes : 0,
            pctApproved: before.pct.approved,
        };

        await audit({
            adminId: actorId(actor),
            action: 'cycle_closed_with_disposition',
            entityType: 'assessment_cycle',
            entityId: id,
            details:
                `Cycle #${id} clôturé à ${disposition.pctApproved == null ? '—' : disposition.pctApproved + '%'} — ` +
                `${disposition.neverStarted} jamais démarré, ` +
                `${disposition.inProgress} en cours, ` +
                `${disposition.inReview} en revue, ` +
                `${disposition.approved} approuvé(s) sur ${disposition.active} attendu(s)` +
                (disposition.excluded ? `, ${disposition.excluded} exclu(s)` : '') +
                ` — par ${actorLabel(actor)}`,
        });

        return disposition;
    }

    // =====================================================================
    //  LA MESURE HORS CAMPAGNE.
    //
    //  Elle est autorisée (un arrivant, une personne qui vient de changer de
    //  rôle doivent pouvoir être mesurés entre deux campagnes), elle est DATÉE,
    //  elle est MARQUÉE « hors campagne » — le marqueur durable est
    //  `self_assessments.cycle_id IS NULL` (commentaire de colonne, migration 117) —
    //  et elle n'entre JAMAIS dans un taux de complétion : v_cycle_participant_status
    //  joint sur `sa.cycle_id = p.cycle_id`, et un NULL ne joint jamais. Les
    //  lectures ci-dessous existent pour la RENDRE VISIBLE, pas pour la compter.
    // =====================================================================

    /** Combien de mesures hors campagne, sur combien de personnes, et depuis quand. */
    static async offCampaignSummary(user, { scope: pre } = {}) {
        const scope = await CycleService._scope(user, pre);
        const row = await db.get(
            `SELECT COUNT(*)::int                       AS "measurements",
                    COUNT(DISTINCT sa.employee_id)::int AS people,
                    MIN(COALESCE(sa.updated_at, sa.created_at)) AS "firstAt",
                    MAX(COALESCE(sa.updated_at, sa.created_at)) AS "lastAt"
               FROM self_assessments sa
               JOIN employees e ON e.id = sa.employee_id
              WHERE sa.cycle_id IS NULL${scope.clause}${NOT_ERASED}`,
            scope.params
        );
        return {
            scope: OFF_CAMPAIGN_SCOPE,
            measurements: Number((row && row.measurements) || 0),
            people: Number((row && row.people) || 0),
            firstAt: (row && row.firstAt) || null,
            lastAt: (row && row.lastAt) || null,
            // Dit explicitement ce que ce chiffre N'EST PAS : un taux.
            countedInCompletionRate: false,
        };
    }

    /** Le détail, daté et marqué, pour la page qui l'affiche (jamais un taux). */
    static async offCampaignMeasurements(user, { employeeId, limit = 200, scope: pre } = {}) {
        const scope = await CycleService._scope(user, pre);
        const emp = Number(employeeId) > 0 ? ' AND sa.employee_id = ?' : '';
        const rows = await db.all(
            `SELECT sa.id                     AS "selfAssessmentId",
                    sa.employee_id            AS "employeeId",
                    e.first_name              AS "firstName",
                    e.last_name               AS "lastName",
                    sk.name                   AS "skillName",
                    sa.self_rated_level       AS "selfRatedLevel",
                    sa.workflow_state         AS "workflowState",
                    COALESCE(sa.updated_at, sa.created_at) AS "measuredAt"
               FROM self_assessments sa
               JOIN employees e ON e.id = sa.employee_id
               LEFT JOIN skills sk ON sk.id = sa.skill_id
              WHERE sa.cycle_id IS NULL${scope.clause}${NOT_ERASED}${emp}
              ORDER BY COALESCE(sa.updated_at, sa.created_at) DESC, sa.id DESC
              LIMIT ?`,
            [
                ...scope.params,
                ...(emp ? [Number(employeeId)] : []),
                Math.max(1, Math.min(1000, Number(limit) || 200)),
            ]
        );
        return rows.map((r) => ({
            ...r,
            fullName: [r.firstName, r.lastName].filter(Boolean).join(' '),
            scope: OFF_CAMPAIGN_SCOPE,
            // Jamais 0 pour une absence de mesure : une ligne sans niveau reste nulle.
            selfRatedLevel: r.selfRatedLevel == null ? null : Number(r.selfRatedLevel),
        }));
    }

    // =====================================================================
    //  LA CAMPAGNE EN RETARD EST SIGNALÉE ET *PROPOSÉE* À LA CLÔTURE.
    //
    //  Jamais fermée d'office. Le job ouvre une proposition après
    //  `cycleClosureProposalDays` jours de retard (21 par défaut) et la rappelle
    //  chaque semaine ; un SuperAdmin l'ACCEPTE (la campagne se clôture par le
    //  chemin honnête, closeWithDisposition) ou la DÉCLINE avec un motif. Une
    //  proposition déclinée reste : rien ne se supprime.
    // =====================================================================

    /** Le délai de proposition effectif (réglage, repli sur l'ancien, puis 21). */
    static async closureProposalDays() {
        const AppSettingsModel = require('../models/AppSettingsModel');
        // Number(null) === 0, and a 0-day threshold would propose a closure the
        // morning after the deadline. An ABSENT setting must fall through to the
        // next source, never to zero.
        const num = (v) => {
            if (v === null || v === undefined || v === '') return NaN;
            const n = Number(v);
            return Number.isFinite(n) ? n : NaN;
        };
        let n = NaN;
        try {
            n = num(await AppSettingsModel.getValue('cycleClosureProposalDays', null));
        } catch (_) {
            n = NaN;
        }
        if (!Number.isFinite(n)) {
            // Repli : l'ancien réglage d'auto-clôture ne ferme plus rien mais
            // une valeur déjà saisie par le client reste un délai voulu.
            try {
                n = num(await AppSettingsModel.getValue('cycleAutoCloseGraceDays', null));
            } catch (_) {
                n = NaN;
            }
        }
        return Number.isFinite(n) ? n : CLOSURE_PROPOSAL_DEFAULT_DAYS;
    }

    /** La proposition OUVERTE d'une campagne, ou null. */
    static async openClosureProposal(cycleId) {
        return db.get(
            `SELECT id, cycle_id AS "cycleId", proposed_at AS "proposedAt", overdue_days AS "overdueDays",
                    proposal_days AS "proposalDays", snapshot, state, last_reminded_at AS "lastRemindedAt"
               FROM cycle_closure_proposals
              WHERE cycle_id = ? AND state = 'open'
              ORDER BY id DESC LIMIT 1`,
            [Number(cycleId)]
        );
    }

    /** Toutes les propositions d'une campagne, décidées comprises (trace). */
    static async closureProposals(cycleId) {
        return db.all(
            `SELECT p.id, p.proposed_at AS "proposedAt", p.overdue_days AS "overdueDays",
                    p.proposal_days AS "proposalDays", p.state, p.decided_at AS "decidedAt",
                    p.decision_reason AS "decisionReason", a.username AS "decidedBy"
               FROM cycle_closure_proposals p
               LEFT JOIN admins a ON a.id = p.decided_by_admin_id
              WHERE p.cycle_id = ?
              ORDER BY p.id DESC`,
            [Number(cycleId)]
        );
    }

    /** Les campagnes qui portent une proposition ouverte — pour la liste. */
    static async openClosureProposalsByCycle() {
        const rows = await db.all(
            `SELECT cycle_id AS "cycleId", id, overdue_days AS "overdueDays", proposed_at AS "proposedAt"
               FROM cycle_closure_proposals WHERE state = 'open'`
        );
        const out = {};
        (rows || []).forEach((r) => {
            out[Number(r.cycleId)] = {
                id: Number(r.id),
                overdueDays: Number(r.overdueDays),
                proposedAt: r.proposedAt,
            };
        });
        return out;
    }

    /**
     * Ouvre (ou rafraîchit) la proposition de clôture d'une campagne en retard.
     * Ne ferme RIEN. Idempotent : l'index unique partiel garantit une seule
     * proposition ouverte par campagne ; un second passage met seulement le
     * retard et l'instantané à jour.
     */
    static async proposeClosure(cycleId, { proposalDays } = {}) {
        const id = Number(cycleId);
        const cycle = await CycleService.findById(id);
        if (!cycle) throw err('cycle_not_found');
        if (!RUNNING.includes(cycle.status)) throw err('cycle_not_running');
        const overdue = CycleService.overdueDays(cycle);
        if (!overdue) return { proposed: false, reason: 'not_overdue' };
        const days = Number.isFinite(Number(proposalDays))
            ? Number(proposalDays)
            : await CycleService.closureProposalDays();
        if (days < 0 || overdue < days)
            return {
                proposed: false,
                reason: 'too_early',
                overdueDays: overdue,
                proposalDays: days,
            };

        // Instantané cycle-WIDE : une proposition relue dans un an doit dire sur
        // quoi elle portait. Les pourcentages restent null quand rien n'est mesuré.
        const p = await CycleService.progress(id, { userType: 'admin', role: 'superadmin' });
        const snapshot = {
            active: p.totals.active,
            excluded: p.totals.excluded,
            neverStarted: p.states.not_started.count,
            inProgress: p.states.in_progress.count,
            inReview: p.states.in_review.count,
            approved: p.states.approved.count,
            pctApproved: p.pct.approved,
        };
        const existing = await CycleService.openClosureProposal(id);
        if (existing) {
            await db.run(
                `UPDATE cycle_closure_proposals
                    SET overdue_days = ?, proposal_days = ?, snapshot = ?, last_reminded_at = now()
                  WHERE id = ?`,
                [overdue, days, JSON.stringify(snapshot), Number(existing.id)]
            );
            return {
                proposed: false,
                refreshed: true,
                proposalId: Number(existing.id),
                overdueDays: overdue,
                proposalDays: days,
                snapshot,
            };
        }
        const { lastID } = await db.run(
            `INSERT INTO cycle_closure_proposals (cycle_id, overdue_days, proposal_days, snapshot, last_reminded_at)
             VALUES (?, ?, ?, ?, now())`,
            [id, overdue, days, JSON.stringify(snapshot)]
        );
        await audit({
            adminId: null,
            action: 'cycle_closure_proposed',
            entityType: 'assessment_cycle',
            entityId: id,
            details:
                `Campagne #${id} (${cycle.code || ''}) en retard de ${overdue} jour(s) sur son échéance du ${ymd(cycle.closesAt) || '—'} — ` +
                `clôture PROPOSÉE (seuil ${days} jours) : ${snapshot.neverStarted} jamais démarré, ${snapshot.inProgress} en cours, ` +
                `${snapshot.inReview} en revue, ${snapshot.approved} approuvé(s) sur ${snapshot.active} attendu(s). ` +
                `Aucune clôture automatique : un super-administrateur décide.`,
        });
        return {
            proposed: true,
            proposalId: Number(lastID),
            overdueDays: overdue,
            proposalDays: days,
            snapshot,
        };
    }

    /**
     * Décision sur une proposition : 'accepted' → la campagne se clôture par le
     * chemin honnête ; 'declined' → la proposition est classée avec son motif et
     * la campagne continue. Motif obligatoire dans les deux cas.
     */
    static async decideClosureProposal(cycleId, { decision, reason } = {}, actor, { emit } = {}) {
        const id = Number(cycleId);
        const d = String(decision || '').trim();
        if (!['accepted', 'declined'].includes(d)) throw err('proposal_decision_invalid');
        const why = (reason == null ? '' : String(reason)).trim();
        if (!why) throw err('proposal_reason_required');
        const proposal = await CycleService.openClosureProposal(id);
        if (!proposal) throw err('proposal_not_found');
        const cycle = await CycleService.findById(id);
        if (!cycle) throw err('cycle_not_found');

        let disposition = null;
        if (d === 'accepted') {
            if (!RUNNING.includes(cycle.status))
                throw CycleService._gateError(CycleService._gate(cycle));
            disposition = await CycleService.closeWithDisposition(id, actor, { emit });
        }
        await db.run(
            `UPDATE cycle_closure_proposals
                SET state = ?, decided_at = now(), decided_by_admin_id = ?, decision_reason = ?
              WHERE id = ? AND state = 'open'`,
            [d, actorId(actor), why.slice(0, 500), Number(proposal.id)]
        );
        await audit({
            adminId: actorId(actor),
            action: `cycle_closure_proposal_${d}`,
            entityType: 'assessment_cycle',
            entityId: id,
            details:
                `Campagne #${id} (${cycle.code || ''}) — proposition de clôture #${proposal.id} ` +
                `${d === 'accepted' ? 'ACCEPTÉE (campagne clôturée)' : 'DÉCLINÉE (la campagne continue)'} ` +
                `par ${actorLabel(actor)} : ${why.slice(0, 200)}`,
        });
        return {
            decided: d,
            proposalId: Number(proposal.id),
            reason: why.slice(0, 500),
            disposition,
        };
    }

    // =====================================================================
    //  Règle 12 — le nombre de compétences conçu par le département ne se réduit
    //  JAMAIS silencieusement, changement de rôle compris.
    //
    //  Ce que devient une mesure prise contre l'ANCIEN rôle : elle est conservée,
    //  datée, rattachée à sa campagne, et comptée sur le rôle occupé à
    //  l'inscription — `cycle_participants.expected_skills` est figé au lancement
    //  et n'est jamais réduit. La personne est re-mesurée sur son NOUVEAU rôle à
    //  la campagne suivante. Le compteur ci-dessous rend l'écart visible pendant
    //  la campagne, au lieu de le laisser silencieux (HR3-11).
    // =====================================================================
    static async roleChanges(cycleId, user, { scope: pre } = {}) {
        const scope = await CycleService._scope(user, pre);
        const row = await db.get(
            `SELECT COUNT(*)::int AS n,
                    COALESCE(SUM(p.expected_skills), 0)::int AS "expectedAtEnrolment",
                    COALESCE(SUM((SELECT COUNT(*) FROM role_skill_requirements rr
                                   WHERE rr.role_id = e.role_id AND COALESCE(rr.required_level, 0) > 0)), 0)::int AS "expectedLive"
               FROM cycle_participants p
               JOIN employees e ON e.id = p.employee_id
              WHERE p.cycle_id = ? AND p.role_id IS DISTINCT FROM e.role_id${scope.clause}${NOT_ERASED}`,
            [Number(cycleId), ...scope.params]
        );
        const n = Number((row && row.n) || 0);
        return {
            count: n,
            expectedAtEnrolment: Number((row && row.expectedAtEnrolment) || 0),
            expectedLive: Number((row && row.expectedLive) || 0),
            // Le nombre attendu N'EST PAS recalculé : la campagne reste comptée sur
            // le rôle d'inscription. Cette propriété est là pour que le test le pin.
            expectedSkillsReduced: false,
        };
    }
}

module.exports = CycleService;
