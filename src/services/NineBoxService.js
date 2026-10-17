'use strict';
/**
 * NineBoxService — Phase 4: 9-Box Talent Management (NEW module).
 *
 * Manager-driven, MANUAL placement (Performance x Potential, Low/Med/High),
 * mirroring nine-box-tool-enhanced.html. Strictly INDEPENDENT of the
 * Skill-Matrix / readiness modules — there is NO auto-generation from
 * assessments. Placements are entered directly by authorized users.
 *
 * RBAC:
 *   - Supervisors may DRAFT / propose / add evidence & comments (no approval).
 *   - Managers (only) approve / reject / archive / publish; admins inherit.
 *   - Confidential: only supervisor(creator)/manager/admin may view; the
 *     subject employee may NOT view their own 9-box. All views/exports audited.
 */
const db = require('../config/database');
const EmployeeModel = require('../models/EmployeeModel');
const LogService = require('./LogService');
const RBACService = require('./RBACService');
const GovernanceService = require('./GovernanceService');
const AuthorityService = require('./AuthorityService');
const DevelopmentTriggerService = require('./DevelopmentTriggerService');
const { agoBucket, daysBetween } = require('../utils/agoBucket');

const BAND = { low: 0, medium: 1, high: 2 };
// Labels + colour categories keyed by `${potential}-${performance}` (see the
// standard colour-coded 9-box). category → Needs Development / Core Performer /
// High Potential / Top Talent.
const BOX_LABELS = {
    'high-low': 'Diamond in the rough',
    'high-medium': 'Shooting Star',
    'high-high': 'Gold Star',
    'medium-low': 'Dilemma',
    'medium-medium': 'Critical Contributor',
    'medium-high': 'Emerging Star',
    'low-low': 'Concern',
    'low-medium': 'Essential Contributor',
    'low-high': 'Trusted Professional',
};
// Default re-assessment cadence (months). The 9-box should be revisited at least
// this often; managers may re-assess any time (monthly).
const REASSESS_MONTHS = 3;

// ONE PERSON, ONE POSITION
// ------------------------------------------------
// A placement is what has been APPROVED. A draft is a PROPOSAL, never a position.
//
//   * LIVE statuses are the two that can be the current answer for a person:
//     an approved placement, or an open proposal when there is no approval yet.
//     'rejected' and 'archived' are neither, and never reach the grid.
//   * OPEN statuses are the single proposal in flight. Migration 95 puts a partial
//     unique index on each of the two sets, so an employee can hold at most one
//     open proposal and at most one approved placement.
//   * CURRENT_ORDER is the precedence every read uses, so the grid, the roster
//     badge, the employee dashboard tile and the API all resolve the SAME row.
//     It must stay in sync with the two indexes: approval wins over proposal.
const LIVE_STATUSES = ['draft', 'under_review', 'approved'];
const OPEN_STATUSES = ['draft', 'under_review'];
const currentOrder = (t) =>
    `CASE ${t}status WHEN 'approved' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,
     COALESCE(${t}approved_at, ${t}updated_at, ${t}created_at) DESC, ${t}id DESC`;

/**
 * ATTACHER LE CATALOGUE À UN REFUS (constat M-06, deuxième geste — même classe
 * que M-02).
 *
 * Les refus de ce service sont rédigés en anglais : ils sont la phrase de
 * RÉFÉRENCE (les journaux la citent, `utils/apiErrors.domainStatus` en déduit le
 * statut, des suites l'épinglent). La console 9-box les affichait TELS QUELS —
 * `alert(j.error)` — sur une page dont le `<html lang>` vaut « fr », dont
 * « Cannot approve from 'approved' » qui expose une valeur d'énumération brute.
 * Deux d'entre eux étaient au contraire écrits en français et apparaissaient sur
 * la page anglaise (divulgation sans motif) : le défaut va dans les deux sens.
 *
 * `say` ajoute, sans rien changer à `e.message`, la clé du catalogue et ses
 * variables ; `NineBoxController` la rend dans la langue lue. Même forme que
 * `SelfAssessmentWorkflowService.say`.
 */
function say(e, key, vars = null) {
    e.i18n = vars ? { key, vars } : { key };
    return e;
}

// MOVEMENT (migration 175) — from the person's previous APPROVED placement to
// the new one. A change of box must be justified in writing, at least this long.
const MOVEMENT_MIN_JUSTIFICATION = 20;
// Directions that change the box, hence require a justification.
const MOVING = new Set(['up', 'down', 'lateral']);
// A placement cancelled by the maintenance panel was a mistake, never a position
// someone held: it is not a "previous placement". `p` is the candidate alias.
const notCancelled = (p) =>
    `NOT (${p}.status = 'archived' AND EXISTS (
          SELECT 1 FROM nine_box_events cx WHERE cx.evaluation_id = ${p}.id AND cx.action = 'cancel'))`;
/**
 * The previous approved placement of the row aliased `ev`, as a LATERAL join
 * aliased `lp`. Used only when `ev` has no snapshot yet (an open proposal): the
 * snapshot, once taken, is the answer and is never recomputed.
 */
const PREV_LATERAL = `LEFT JOIN LATERAL (
        SELECT p.id, p.box, p.performance, p.potential,
               COALESCE(p.cycle_id, p.movement_cycle_id) AS cycle_id, p.approved_at
          FROM nine_box_evaluations p
         WHERE p.employee_id = ev.employee_id AND p.id <> ev.id
           AND p.approved_at IS NOT NULL AND p.status IN ('approved', 'archived')
           AND (ev.approved_at IS NULL OR p.approved_at < ev.approved_at)
           AND ${notCancelled('p')}
         ORDER BY p.approved_at DESC, p.id DESC LIMIT 1
    ) lp ON ev.movement_snapshot_at IS NULL`;
// The previous-placement columns: the snapshot when there is one, else the live preview.
const PREV_COLS = `
    CASE WHEN ev.movement_snapshot_at IS NOT NULL THEN ev.previous_evaluation_id ELSE lp.id END AS prev_id,
    CASE WHEN ev.movement_snapshot_at IS NOT NULL THEN ev.previous_box ELSE lp.box END AS prev_box,
    CASE WHEN ev.movement_snapshot_at IS NOT NULL THEN ev.previous_performance ELSE lp.performance END AS prev_performance,
    CASE WHEN ev.movement_snapshot_at IS NOT NULL THEN ev.previous_potential ELSE lp.potential END AS prev_potential,
    CASE WHEN ev.movement_snapshot_at IS NOT NULL THEN ev.previous_cycle_id ELSE lp.cycle_id END AS prev_cycle_id,
    CASE WHEN ev.movement_snapshot_at IS NOT NULL THEN ev.previous_approved_at ELSE lp.approved_at END AS prev_approved_at,
    (ev.movement_snapshot_at IS NOT NULL) AS movement_snapshot,
    ev.movement_backfilled, ev.movement_justification,
    ev.movement_justified_by, ev.movement_justified_by_type, ev.movement_justified_at`;

/**
 * A justification is a SENTENCE, not a way around the minimum.
 * Refused: whitespace/punctuation/symbols only, one repeated character
 * (« aaaaaaaaaaaaaaaaaaaaa », « …….. »), or a copy — ignoring case and spaces —
 * of the same employee's previous justification.
 */
const JUST_NOISE = /[\s\p{P}\p{S}]/gu;
function justificationCore(text) {
    return String(text || '')
        .toLowerCase()
        .replace(JUST_NOISE, '');
}
function justificationKey(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/\s+/g, '');
}
function justificationRefused(code, key, message) {
    const e = new Error(message);
    say(e, key, { min: MOVEMENT_MIN_JUSTIFICATION });
    e.code = code;
    e.status = 400;
    e.expose = true;
    return e;
}

function justificationRequired(min = MOVEMENT_MIN_JUSTIFICATION) {
    const e = new Error(
        `A written justification of at least ${min} characters is required when the box changes.`
    );
    say(e, 'talentx:nb_mv_err_justification_required', { min });
    e.code = 'MOVEMENT_JUSTIFICATION_REQUIRED';
    e.status = 400;
    e.expose = true;
    return e;
}

class NineBoxService {
    /** Pure placement model (potential x performance) → box 1..9 + label. */
    computeBox(performance, potential) {
        if (!(performance in BAND) || !(potential in BAND))
            throw new Error('performance/potential must be low|medium|high');
        const box = BAND[potential] * 3 + BAND[performance] + 1; // 1..9
        return { box, label: BOX_LABELS[`${potential}-${performance}`] || null };
    }

    static get MOVEMENT_MIN_JUSTIFICATION() {
        return MOVEMENT_MIN_JUSTIFICATION;
    }

    /**
     * MOVEMENT DIRECTION between two placements, from the two axes only
     * (band deltas dPerf = new − old performance, dPot = new − old potential):
     *   first    no previous approved placement
     *   stable   same box (dPerf = 0 and dPot = 0)
     *   up       progression — neither axis down, at least one up
     *   down     régression  — neither axis up, at least one down
     *   lateral  one axis up and the other down
     * The cell's colour category plays no part: a move is judged on the two
     * judgements it is made of, never on the palette.
     */
    movementDirection(prev, next) {
        if (!prev || !(prev.performance in BAND) || !(prev.potential in BAND)) return 'first';
        if (!next || !(next.performance in BAND) || !(next.potential in BAND)) return null;
        const dPerf = BAND[next.performance] - BAND[prev.performance];
        const dPot = BAND[next.potential] - BAND[prev.potential];
        if (dPerf === 0 && dPot === 0) return 'stable';
        if (dPerf >= 0 && dPot >= 0) return 'up';
        if (dPerf <= 0 && dPot <= 0) return 'down';
        return 'lateral';
    }

    /** True when this direction changes the box, hence needs a written justification. */
    movementNeedsJustification(direction) {
        return MOVING.has(direction);
    }

    /**
     * The whole justification rule (≥ 20 characters + the placeholder and copy rules). Throws a 400 with
     * its own code and catalogue key; returns nothing when the text is acceptable.
     * `evaluationId` is excluded from the "previous justification" comparison
     * (the proposal's own stored text is not a copy of itself).
     */
    async _assertJustification(text, employeeId, evaluationId) {
        const t = this._cleanJustification(text);
        if (t.length < MOVEMENT_MIN_JUSTIFICATION) throw justificationRequired();
        const core = justificationCore(t);
        if (!core || /^(.)\1*$/u.test(core))
            throw justificationRefused(
                'MOVEMENT_JUSTIFICATION_PLACEHOLDER',
                'talentx:nb_mv_err_justification_placeholder',
                'The justification must be a real sentence: not only spaces, punctuation or one repeated character.'
            );
        const prev = await db.get(
            `SELECT movement_justification FROM nine_box_evaluations
              WHERE employee_id = ? AND id <> ? AND movement_justification IS NOT NULL
              ORDER BY movement_justified_at DESC NULLS LAST, id DESC LIMIT 1`,
            [employeeId, evaluationId == null ? 0 : evaluationId]
        );
        if (prev && justificationKey(prev.movementJustification) === justificationKey(t))
            throw justificationRefused(
                'MOVEMENT_JUSTIFICATION_COPY',
                'talentx:nb_mv_err_justification_copy',
                "The justification repeats this employee's previous justification word for word: explain this change."
            );
    }

    _cleanJustification(text) {
        return text == null ? '' : String(text).trim().slice(0, 4000);
    }

    _justifierType(user) {
        return user && user.userType === 'admin' ? 'admin' : 'employee';
    }

    /**
     * The person's previous APPROVED placement, relative to evaluation `excludeId`
     * (approved strictly before `before` when given). Cancelled placements are not
     * positions and are skipped.
     */
    async _previousApproved(employeeId, excludeId, before = null) {
        return db.get(
            `SELECT p.id, p.box, p.performance, p.potential,
                    COALESCE(p.cycle_id, p.movement_cycle_id) AS cycle_id, p.approved_at
               FROM nine_box_evaluations p
              WHERE p.employee_id = ? AND p.id <> ?
                AND p.approved_at IS NOT NULL AND p.status IN ('approved', 'archived')
                AND (?::timestamptz IS NULL OR p.approved_at < ?::timestamptz)
                AND ${notCancelled('p')}
              ORDER BY p.approved_at DESC, p.id DESC LIMIT 1`,
            [employeeId, excludeId == null ? 0 : excludeId, before, before]
        );
    }

    /**
     * SNAPSHOT THE MOVE onto evaluation `ev` (at submit, or at approval straight
     * from a draft) and enforce the justification rule. `newText` is a
     * justification supplied with this act; otherwise the one already stored on
     * the proposal is used. Throws MOVEMENT_JUSTIFICATION_REQUIRED, writing
     * nothing, when the box changes and no ≥ 20-character justification exists.
     */
    async _snapshotMovement(ev, user, auth, newText = null, { enforce = true } = {}) {
        const prev = await this._previousApproved(ev.employeeId, ev.id);
        const direction = this.movementDirection(prev, ev);
        const fresh = this._cleanJustification(newText);
        const text = fresh || this._cleanJustification(ev.movementJustification);
        if (enforce && this.movementNeedsJustification(direction))
            await this._assertJustification(text, ev.employeeId, ev.id);
        let movementCycle = null;
        if (ev.cycleId == null) {
            const cyc = await this._resolveMirrorCycle();
            movementCycle = cyc ? cyc.id : null;
        }
        await db.run(
            `UPDATE nine_box_evaluations
                SET previous_evaluation_id = ?, previous_box = ?, previous_performance = ?,
                    previous_potential = ?, previous_cycle_id = ?, previous_approved_at = ?,
                    movement_direction = ?, movement_snapshot_at = now(), movement_backfilled = false,
                    movement_cycle_id = COALESCE(movement_cycle_id, ?),
                    movement_justification = CASE WHEN ? THEN ?::text ELSE movement_justification END,
                    movement_justified_by = CASE WHEN ? THEN ?::bigint ELSE movement_justified_by END,
                    movement_justified_by_type = CASE WHEN ? THEN ?::text ELSE movement_justified_by_type END,
                    movement_justified_at = CASE WHEN ? THEN now() ELSE movement_justified_at END
              WHERE id = ?`,
            [
                prev ? prev.id : null,
                prev ? prev.box : null,
                prev ? prev.performance : null,
                prev ? prev.potential : null,
                prev ? prev.cycleId : null,
                prev ? prev.approvedAt : null,
                direction,
                movementCycle,
                Boolean(fresh),
                fresh || null,
                Boolean(fresh),
                user && user.id != null ? user.id : null,
                Boolean(fresh),
                this._justifierType(user),
                Boolean(fresh),
                ev.id,
            ]
        );
        // Ids only (audit rule): no name, and not the text itself — the
        // text lives in the row, where DSR erasure and confidentiality apply.
        await this._event(ev.id, ev.employeeId, user, auth, 'movement', ev.status, ev.status, {
            previousEvaluationId: prev ? Number(prev.id) : null,
            fromBox: prev ? Number(prev.box) : null,
            toBox: Number(ev.box),
            direction,
            justified: text.length >= MOVEMENT_MIN_JUSTIFICATION,
        });
        return { direction, previous: prev || null };
    }

    /**
     * A BOX CHANGE on a proposal or a placement that already carries a snapshot
     * (a reviewer editing a submitted proposal, or a calibration). The previous
     * placement stays the snapshot; the direction is recomputed; a moving
     * direction needs a NEW justification, because the old one explained a box
     * that is no longer proposed. Without a snapshot (a draft) nothing is
     * enforced yet, but a stale justification is cleared.
     */
    async _onBoxChange(ev, next, user, auth, newText, { enforce }) {
        const fresh = this._cleanJustification(newText);
        if (!ev.movementSnapshotAt) {
            await db.run(
                `UPDATE nine_box_evaluations
                    SET movement_justification = ?, movement_justified_by = ?,
                        movement_justified_by_type = ?, movement_justified_at = ?
                  WHERE id = ?`,
                fresh
                    ? [
                          fresh,
                          user && user.id != null ? user.id : null,
                          this._justifierType(user),
                          new Date(),
                          ev.id,
                      ]
                    : [null, null, null, null, ev.id]
            );
            return null;
        }
        const prev =
            ev.previousPerformance != null && ev.previousPotential != null
                ? { performance: ev.previousPerformance, potential: ev.previousPotential }
                : null;
        const direction = this.movementDirection(prev, next);
        if (enforce && this.movementNeedsJustification(direction))
            await this._assertJustification(fresh, ev.employeeId, ev.id);
        await db.run(
            `UPDATE nine_box_evaluations
                SET movement_direction = ?, movement_justification = ?, movement_justified_by = ?,
                    movement_justified_by_type = ?, movement_justified_at = ?
              WHERE id = ?`,
            [
                direction,
                fresh || null,
                fresh && user && user.id != null ? user.id : null,
                fresh ? this._justifierType(user) : null,
                fresh ? new Date() : null,
                ev.id,
            ]
        );
        await this._event(ev.id, ev.employeeId, user, auth, 'movement', ev.status, ev.status, {
            previousEvaluationId: ev.previousEvaluationId ? Number(ev.previousEvaluationId) : null,
            fromBox: ev.previousBox != null ? Number(ev.previousBox) : null,
            toBox: Number(this.computeBox(next.performance, next.potential).box),
            direction,
            justified: fresh.length >= MOVEMENT_MIN_JUSTIFICATION,
            boxChangedFrom: Number(ev.box),
        });
        return direction;
    }

    /** Names for justifier refs (a Map), two queries whatever the size. Erased → null. */
    async _names(refs) {
        const emp = [
            ...new Set(refs.filter((r) => r && r.type === 'employee').map((r) => Number(r.id))),
        ];
        const adm = [
            ...new Set(refs.filter((r) => r && r.type === 'admin').map((r) => Number(r.id))),
        ];
        // A Map, never an object keyed by data.
        const out = new Map();
        try {
            if (emp.length) {
                const rows = await db.all(
                    `SELECT id, first_name, last_name, erased_at FROM employees WHERE id = ANY(?::bigint[])`,
                    [emp]
                );
                for (const r of rows)
                    out.set(
                        `employee:${r.id}`,
                        r.erasedAt
                            ? null
                            : [r.firstName, r.lastName].filter(Boolean).join(' ') || null
                    );
            }
            if (adm.length) {
                const rows = await db.all(
                    `SELECT id, username FROM admins WHERE id = ANY(?::bigint[])`,
                    [adm]
                );
                for (const r of rows)
                    out.set(`admin:${r.id}`, r.username ? String(r.username) : null);
            }
        } catch (_) {
            /* a failed lookup leaves names out — never a wrong one */
        }
        return out;
    }

    /** Shape a row carrying PREV_COLS into the `movement` object the pages read. */
    _movementOf(r, names = new Map()) {
        // Keyed on the snapshot's BANDS, not its id: the id goes NULL if that row is
        // ever deleted (FK ON DELETE SET NULL), the recorded origin does not.
        const prev =
            r.prevPerformance != null && r.prevPotential != null
                ? {
                      evaluationId: r.prevId != null ? Number(r.prevId) : null,
                      box: r.prevBox != null ? Number(r.prevBox) : null,
                      performance: r.prevPerformance,
                      potential: r.prevPotential,
                      cycleId: r.prevCycleId != null ? Number(r.prevCycleId) : null,
                      cycleLabel: r.prevCycleLabel || null,
                      approvedAt: r.prevApprovedAt || null,
                  }
                : null;
        const direction = this.movementDirection(prev, r);
        const text = this._cleanJustification(r.movementJustification);
        const byKey =
            r.movementJustifiedBy != null
                ? `${r.movementJustifiedByType === 'admin' ? 'admin' : 'employee'}:${r.movementJustifiedBy}`
                : null;
        return {
            direction,
            previous: prev,
            requiresJustification: this.movementNeedsJustification(direction),
            justified: text.length >= MOVEMENT_MIN_JUSTIFICATION,
            justification: text || null,
            justifiedBy: byKey ? (names.get(byKey) ?? null) : null,
            justifiedAt: r.movementJustifiedAt || null,
            // false = a live preview of an open proposal, not yet a snapshot
            snapshot: Boolean(r.movementSnapshot),
            backfilled: Boolean(r.movementBackfilled),
            minJustification: MOVEMENT_MIN_JUSTIFICATION,
        };
    }

    /** One evaluation's movement (detail panel). */
    async _movementForId(id) {
        const r = await db.get(
            `SELECT ev.performance, ev.potential, ${PREV_COLS}, pc.label AS prev_cycle_label
               FROM nine_box_evaluations ev ${PREV_LATERAL}
               LEFT JOIN assessment_cycles pc ON pc.id =
                    CASE WHEN ev.movement_snapshot_at IS NOT NULL THEN ev.previous_cycle_id ELSE lp.cycle_id END
              WHERE ev.id = ?`,
            [id]
        );
        if (!r) return null;
        const names = await this._names([
            r.movementJustifiedBy != null
                ? { type: r.movementJustifiedByType, id: r.movementJustifiedBy }
                : null,
        ]);
        return this._movementOf(r, names);
    }

    /**
     * The previous approved placement of an employee, for the assess dialog
     * (before any proposal exists). Same authority as suggestPosition.
     */
    async previousPlacement(employeeId, user) {
        const auth = await this.resolveAuthority(user, employeeId);
        if (!auth.canDraft && !auth.canView)
            throw say(
                new Error('Not authorized for this employee'),
                'talentx:nb_err_not_authorized_employee'
            );
        const p = await this._previousApproved(employeeId, 0);
        if (!p) return { previous: null, minJustification: MOVEMENT_MIN_JUSTIFICATION };
        let cycleLabel = null;
        if (p.cycleId != null) {
            const c = await db.get('SELECT label FROM assessment_cycles WHERE id = ?', [p.cycleId]);
            cycleLabel = c ? c.label : null;
        }
        return {
            previous: {
                evaluationId: Number(p.id),
                box: Number(p.box),
                performance: p.performance,
                potential: p.potential,
                cycleId: p.cycleId != null ? Number(p.cycleId) : null,
                cycleLabel,
                approvedAt: p.approvedAt,
            },
            minJustification: MOVEMENT_MIN_JUSTIFICATION,
        };
    }

    /**
     * 9-BOX MOVEMENTS — every DECIDED placement in the reader's scope (the
     * same scope as the grid: super admin all, local admin clearance ∪ line,
     * manager their sub-tree), with where it came from, the direction and the
     * justification. Filters: cycle (id | 'none'), siteId, departmentId,
     * direction. Returns the rows, the counts per direction, the 9×9 transition
     * matrix (first evaluations have no origin and stay out of it) and the
     * filter options — built from the scope itself, so an option never names a
     * site the reader cannot see. Audited as a view.
     */
    async movements(user, filters = {}, req = null) {
        const scope = await this._scopedEmployeeIds(user);
        const empty = {
            rows: [],
            counts: { first: 0, stable: 0, up: 0, down: 0, lateral: 0, total: 0 },
            matrix: Array.from({ length: 9 }, () => Array(9).fill(0)),
            options: { cycles: [], sites: [], departments: [], hasNoCycle: false },
        };
        // Leavers and erased people are out of the report for every reader,
        // the super administrator included.
        let where = `ev.approved_at IS NOT NULL AND ev.status IN ('approved', 'archived') AND ${notCancelled('ev')}
                     AND e.is_active = true AND e.erased_at IS NULL`;
        const params = [];
        if (!scope.all) {
            if (!scope.ids.length) return empty;
            where += ' AND ev.employee_id = ANY(?::bigint[])';
            params.push(scope.ids);
        }
        const all = await db.all(
            `SELECT ev.id, ev.employee_id, ev.performance, ev.potential, ev.box, ev.status,
                    ev.approved_at, COALESCE(ev.cycle_id, ev.movement_cycle_id) AS cycle_id,
                    c.label AS cycle_label, pc.label AS prev_cycle_label,
                    e.first_name, e.last_name, e.employee_number,
                    e.site_id, s.name AS site_name, e.department_id, d.name AS department_name,
                    ${PREV_COLS}
               FROM nine_box_evaluations ev
               JOIN employees e ON e.id = ev.employee_id
               LEFT JOIN sites s ON s.id = e.site_id
               LEFT JOIN departments d ON d.id = e.department_id
               LEFT JOIN assessment_cycles c ON c.id = COALESCE(ev.cycle_id, ev.movement_cycle_id)
               ${PREV_LATERAL}
               LEFT JOIN assessment_cycles pc ON pc.id =
                    CASE WHEN ev.movement_snapshot_at IS NOT NULL THEN ev.previous_cycle_id ELSE lp.cycle_id END
              WHERE ${where}
              ORDER BY ev.approved_at DESC, ev.id DESC`,
            params
        );
        const names = await this._names(
            all
                .filter((r) => r.movementJustifiedBy != null)
                .map((r) => ({ type: r.movementJustifiedByType, id: r.movementJustifiedBy }))
        );
        const opt = {
            cycles: new Map(),
            sites: new Map(),
            departments: new Map(),
            hasNoCycle: false,
        };
        const shaped = all.map((r) => {
            if (r.cycleId != null)
                opt.cycles.set(Number(r.cycleId), r.cycleLabel || `#${r.cycleId}`);
            else opt.hasNoCycle = true;
            if (r.siteId != null) opt.sites.set(Number(r.siteId), r.siteName || `#${r.siteId}`);
            if (r.departmentId != null)
                opt.departments.set(
                    Number(r.departmentId),
                    r.departmentName || `#${r.departmentId}`
                );
            return {
                evaluationId: Number(r.id),
                employeeId: Number(r.employeeId),
                firstName: r.firstName,
                lastName: r.lastName,
                employeeNumber: r.employeeNumber || null,
                siteId: r.siteId != null ? Number(r.siteId) : null,
                siteName: r.siteName || null,
                departmentId: r.departmentId != null ? Number(r.departmentId) : null,
                departmentName: r.departmentName || null,
                cycleId: r.cycleId != null ? Number(r.cycleId) : null,
                cycleLabel: r.cycleLabel || null,
                status: r.status,
                approvedAt: r.approvedAt,
                box: Number(r.box),
                performance: r.performance,
                potential: r.potential,
                movement: this._movementOf(r, names),
            };
        });
        const f = filters || {};
        const num = (v) => (v == null || v === '' ? null : Number(v));
        const rows = shaped.filter((x) => {
            if (f.cycle === 'none' && x.cycleId != null) return false;
            if (f.cycle && f.cycle !== 'none' && x.cycleId !== num(f.cycle)) return false;
            if (num(f.siteId) != null && x.siteId !== num(f.siteId)) return false;
            if (num(f.departmentId) != null && x.departmentId !== num(f.departmentId)) return false;
            if (f.direction && x.movement.direction !== f.direction) return false;
            return true;
        });
        const counts = { first: 0, stable: 0, up: 0, down: 0, lateral: 0, total: rows.length };
        const matrix = Array.from({ length: 9 }, () => Array(9).fill(0));
        for (const x of rows) {
            if (counts[x.movement.direction] != null) counts[x.movement.direction] += 1;
            const from = x.movement.previous && x.movement.previous.box;
            if (from >= 1 && from <= 9 && x.box >= 1 && x.box <= 9)
                matrix[from - 1][x.box - 1] += 1;
        }
        const sorted = (m) =>
            [...m.entries()]
                .map(([id, name]) => ({ id, name }))
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        await this._audit(
            req,
            'NINEBOX_MOVEMENTS_VIEW',
            null,
            `viewed 9-box movements (${rows.length} of ${shaped.length})`
        );
        return {
            rows,
            counts,
            matrix,
            options: {
                cycles: sorted(opt.cycles),
                sites: sorted(opt.sites),
                departments: sorted(opt.departments),
                hasNoCycle: opt.hasNoCycle,
            },
        };
    }

    /** Normalise the in-cell position (tier 1-3, trend up/stable/down). */
    _cellPos(data) {
        let tier = parseInt(data && data.cellTier, 10);
        if (![1, 2, 3].includes(tier)) tier = 2;
        let trend = String((data && data.cellTrend) || '').toLowerCase();
        if (!['up', 'stable', 'down'].includes(trend)) trend = 'stable';
        const source =
            String((data && data.positionSource) || '').toLowerCase() === 'system'
                ? 'system'
                : 'manager';
        return { tier, trend, source };
    }

    /**
     * Suggest an in-cell position from the data the system already has:
     *   - tier  ← the CANONICAL readiness % (≥67% upper, 34–66% middle, <34% lower)
     *   - trend ← net skill-level change over the last 6 months (assessment_history)
     * The manager may accept this or readjust it.
     *
     * ONE READINESS NUMBER (Wave 2, item 5)
     *   This used to compute a FOURTH definition of readiness of its own:
     *   count-of-met over `skill_assessments` alone, with a LEFT JOIN whose
     *   COALESCE(current_level, 0) turned every never-rated requirement into a
     *   failed one — and which ignored approved self-assessments entirely. It
     *   was the strictest number in the app, and it fed the PIP/IDP
     *   auto-triggers and the DEI placement statistics: somebody assessed on 3
     *   of 47 skills was suggested into the LOWER tier, which is the tier that
     *   opens a performance-improvement plan. That is a disciplinary
     *   consequence derived from missing data.
     *
     *   The tier now comes from v_employee_assessment_coverage
     *   .readiness_assessed_only — the same figure the dashboard, the Report
     *   Builder, the API and the digest publish — and the coverage denominator
     *   is returned with it. When NOTHING has been assessed there is no
     *   suggestion to make: the tier stays the neutral middle, `measured` is
     *   false, and the rationale says "non mesuré", not "sous-performant".
     *
     *   `expectedSkills` is the FULL department-designed requirement count.
     *   Nothing here reduces, samples or filters the skills a role requires.
     */
    // Below this coverage a suggestion is still offered but flagged
    // low-confidence, so a manager knows the tier rests on a thin measurement.
    static get LOW_COVERAGE_PCT() {
        return 50;
    }

    async suggestPosition(employeeId, user, req = null) {
        const auth = await this.resolveAuthority(user, employeeId);
        if (!auth.canDraft && !auth.canView)
            throw say(
                new Error('Not authorized for this employee'),
                'talentx:nb_err_not_authorized_employee'
            );

        const r = await db.get(
            `SELECT c.readiness_assessed_only               AS "readinessAssessedOnly",
                    COALESCE(c.assessed_skills, 0)::int     AS "assessedSkills",
                    COALESCE(c.expected_skills, 0)::int     AS "expectedSkills",
                    COALESCE(c.never_assessed_skills, 0)::int AS "neverAssessedSkills",
                    c.coverage                              AS "coveragePct"
               FROM v_employee_assessment_coverage c
              WHERE c.employee_id = ?`,
            [employeeId]
        );
        const assessedSkills = Number(r && r.assessedSkills) || 0;
        const expectedSkills = Number(r && r.expectedSkills) || 0;
        const coveragePct = r && r.coveragePct != null ? Number(r.coveragePct) : null;
        const readinessPct =
            r && r.readinessAssessedOnly != null ? Number(r.readinessAssessedOnly) : null;
        const measured = assessedSkills > 0 && readinessPct != null;
        const lowCoverage =
            measured && coveragePct != null && coveragePct < NineBoxService.LOW_COVERAGE_PCT;

        // Unmeasured → the neutral middle tier. Never the lower tier: the lower
        // tier is what triggers a PIP.
        let tier = 2;
        if (measured) tier = readinessPct >= 67 ? 1 : readinessPct >= 34 ? 2 : 3;

        let delta = 0;
        try {
            const d = await db.get(
                `SELECT COALESCE(SUM(new_level - COALESCE(previous_level, new_level)), 0)::int AS delta
                   FROM assessment_history
                  WHERE employee_id = ? AND assessed_at >= now() - interval '6 months'`,
                [employeeId]
            );
            delta = Number(d && d.delta) || 0;
        } catch (_) {
            /* history optional */
        }
        const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'stable';

        const tierName = { 1: 'upper (Tier 1)', 2: 'middle (Tier 2)', 3: 'lower (Tier 3)' }[tier];
        const trendName = { up: 'improving →', stable: 'stable', down: '← declining' }[trend];
        const trendPart = `Évolution ${delta > 0 ? '+' : ''}${delta} sur 6 mois → ${trendName}.`;

        // FR-first. The unmeasured case must not read as under-performance.
        const rationale = !measured
            ? `Non mesuré : 0 / ${expectedSkills} exigence(s) évaluée(s) — aucun niveau suggéré, ` +
              `positionnement neutre (palier 2). Not measured: nothing assessed yet, ` +
              `so no tier is inferred. ${trendPart}`
            : `Maîtrise ${readinessPct} % (sur ${assessedSkills} / ${expectedSkills} exigences évaluées` +
              `${coveragePct == null ? '' : `, couverture ${coveragePct} %`}) → ${tierName}. ` +
              (lowCoverage
                  ? `Couverture faible — suggestion peu fiable, à valider. Low coverage: treat as indicative. `
                  : '') +
              trendPart;

        return {
            tier,
            trend,
            readinessPct,
            recentDelta: delta,
            // Coverage travels with the score so the console can show "non
            // mesuré" instead of a fabricated under-performance.
            measured,
            lowCoverage,
            assessedSkills,
            expectedSkills,
            neverAssessedSkills: Number(r && r.neverAssessedSkills) || 0,
            coveragePct,
            rationale,
        };
    }

    async resolveAuthority(user, employeeId) {
        const employee = await EmployeeModel.findById(employeeId);
        if (!employee)
            throw say(new Error('Employee not found'), 'talentx:nb_err_employee_not_found');

        // THE PERSON BEHIND THE ACCOUNT, and the manager_type DISCRIMINATOR, through
        // the resolver every review service shares (AuthorityService.relation).
        // Two defects lived here, in opposite directions:
        //   * `manager_id` is polymorphic (an EMPLOYEE or an ADMIN id) and the two
        //     id spaces overlap. Compared without `manager_type`, the employee
        //     whose id equals the ADMIN id named manager of this person was handed
        //     isManager — canDraft AND canApprove over a stranger.
        //   * a manager signed in on their LINKED administration account
        //     (admins.linked_employee_id) compared the ADMIN id to the employee
        //     line and lost their whole team: the grid listed them (scopeFilter
        //     unions the line), the guard refused every one of them.
        const rel = await AuthorityService.relation(user, employee);
        const isAdmin = rel.isAdmin;
        const isSuper = rel.isSuper;
        const isLocalAdmin = rel.isLocalAdmin;
        const isViewer = rel.isViewer;
        const isSelf = rel.isSelf;
        const isSupervisor = rel.isSupervisor;
        const isManager = Boolean(rel.isDirectManager || rel.isAdminManager);

        // CLEARANCE — admin scopes only. A bounded admin's right to ACT rests on
        // this and nothing else (the line grants reading, and the direct link).
        const inClearance = rel.inClearance;
        // READING scope — the UNION of the clearance and the reporting line.
        // The SUB-TREE, not only the direct link: the roster and the grid list the
        // whole span (findGoverned), so an N+2 manager saw names and cells and
        // then got 403 on opening one.
        const inScope = Boolean(inClearance || isSupervisor || isManager || rel.inLine);

        // A "self" is never in their own scope (they don't supervise themselves),
        // so confidential self-view is already excluded.
        const canView = Boolean(inScope);
        // Viewers may look but never act.
        // A local admin acts on placements only with the manage_talent_reviews
        // slug AND inside their clearance — being in scope is clearance, not
        // capability. Without this the service admitted any in-scope local admin
        // the route guard let through.
        const adminMayDecide =
            isSuper ||
            (isLocalAdmin &&
                inClearance &&
                RBACService.hasPermission(user, 'manage_talent_reviews'));
        // Nobody drafts or approves their own placement, by either of their
        // accounts or through an unlinked admin account sharing their identity.
        const ownRecord = Boolean(isSelf || rel.selfByIdentity);
        const strictDraft =
            !isViewer && !ownRecord && Boolean(adminMayDecide || isSupervisor || isManager);
        const strictApprove = !isViewer && !ownRecord && Boolean(adminMayDecide || isManager);
        // Strict (the default) is the rule above; the ladder (extended mode) adds
        // the line above as the manager and a local admin in clearance without
        // the slug.
        const draft = AuthorityService.allows(rel, 'ninebox.draft', { strict: strictDraft });
        const approve = AuthorityService.allows(rel, 'ninebox.approve', { strict: strictApprove });
        const canDraft = draft.ok;
        const canApprove = approve.ok;

        return {
            employee,
            isAdmin,
            isSuper,
            isLocalAdmin,
            isViewer,
            isSelf,
            selfByIdentity: rel.selfByIdentity,
            isSupervisor,
            // the line above acting by the ladder labels its events as a manager
            isManager: Boolean(isManager || (rel.isLineAbove && draft.by === 'ladder')),
            canDraft,
            canApprove,
            canView,
            as: (canApprove ? approve.as : canDraft ? draft.as : null) || 'none',
        };
    }

    async _event(
        evaluationId,
        employeeId,
        user,
        auth,
        action,
        fromStatus,
        toStatus,
        detail = null
    ) {
        const actorType = auth
            ? auth.isAdmin
                ? 'admin'
                : auth.isManager
                  ? 'manager'
                  : auth.isSupervisor
                    ? 'supervisor'
                    : 'other'
            : null;
        await db.run(
            `INSERT INTO nine_box_events (evaluation_id, employee_id, actor_id, actor_type, action, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                evaluationId,
                employeeId,
                user && user.id != null ? user.id : null,
                actorType,
                action,
                fromStatus,
                toStatus,
                detail ? JSON.stringify(detail) : null,
            ]
        );
    }

    /**
     * The actor is named WITHOUT CONDITION, by `actor_ref`, and the write is
     * contained in a SAVEPOINT — same shape as SelfAssessmentWorkflowService._audit.
     *
     * `system_logs.admin_id` is a foreign key to `admins`, and a manager is an
     * EMPLOYEE. Writing `req.user.id` there for an employee failed in 23503, and
     * LogService's retry then failed too because this runs INSIDE the
     * runTransaction of approve / setDisclosure / reject / archive / calibrate:
     * the swallowed error left the PostgreSQL transaction aborted (25P02) and
     * every 9-box act of an employee-manager answered 500 — measured: approve
     * threw 25P02 on evaluation 4042 for manager 137. Worse, when an admin
     * happens to carry the same id, the FK SUCCEEDS and the act is attributed
     * to that administrator. `adminId` is therefore written only for an admin.
     */
    async _audit(req, action, id, details) {
        const u = req && req.user;
        const isAdmin = Boolean(u && u.userType === 'admin');
        try {
            await db.runInSavepoint(() =>
                LogService.log({
                    adminId: isAdmin && u.id != null ? u.id : null,
                    actorRef:
                        u && u.id != null ? `${isAdmin ? 'admin' : 'employee'}:${u.id}` : null,
                    action,
                    entityType: 'nineBox',
                    entityId: id,
                    // The rung the act used (AuthorityService), when one was resolved.
                    details: AuthorityService.withAs(details, u),
                    ipAddress: req ? req.ip : null,
                    userAgent: req && req.get ? req.get('user-agent') : null,
                })
            );
        } catch (_) {
            /* audit must never break the transition */
        }
    }

    /**
     * The cycle an approved placement is mirrored into (talent_placements.cycle_id
     * is NOT NULL with an FK, so a real cycle must exist).
     *
     *   1. The open cycle closing soonest — the same "current campaign" rule the
     *      six other resolvers use (CycleService, LifecycleService, v2-talent x3,
     *      DashboardV2Controller).
     *   2. No open cycle: the most recent NON-closed one, a LOCKED cycle first (its
     *      assessments are frozen and under review, which is exactly when talent
     *      reviews happen), then a draft. Tie-break on id DESC so the answer is
     *      deterministic. The previous fallback had no status filter and no
     *      tie-break: six cycles sharing one opened_at made Postgres pick any of
     *      them, and it picked CLOSED cycle 6 while every consumer of the mirror
     *      (DEI, bias, copilot, Report Builder, Power BI) reads
     *      (SELECT MAX(cycle_id) FROM talent_placements) = 9 — a fresh approval
     *      was written where nothing reads.
     *   3. Nothing but closed cycles: null. A closed campaign is history, and a new
     *      position must never be back-dated into it; the caller reports
     *      'no_active_cycle' instead of writing where nothing reads.
     */
    async _resolveMirrorCycle() {
        const open = await db.get(
            `SELECT id, status FROM assessment_cycles
              WHERE status = 'open' ORDER BY closes_at LIMIT 1`
        );
        if (open && open.id) return { id: Number(open.id), status: 'open' };
        const fallback = await db.get(
            `SELECT id, status FROM assessment_cycles
              WHERE status <> 'closed'
              ORDER BY CASE WHEN status = 'locked' THEN 0 ELSE 1 END,
                       COALESCE(opened_at, created_at) DESC, id DESC
              LIMIT 1`
        );
        return fallback && fallback.id
            ? { id: Number(fallback.id), status: fallback.status }
            : null;
    }

    /**
     * MIRROR AN APPROVED PLACEMENT INTO talent_placements — the one write path for
     * that table, shared by approve and by the calibration write-back.
     *
     * Constraints honoured: cycle_id NOT NULL + FK (resolved above, never
     * fabricated), source is the enum auto|override, tier is up|mid|low while
     * nine_box_evaluations.cell_tier is 1|2|3, PK (employee_id, cycle_id) so a
     * re-approval upserts.
     *
     * `nine_box_evaluations.box` is a smallint 1-9 for display;
     * `talent_placements.box` is TEXT and every consumer parses it as
     * "{potential}-{performance}" (BiasDetectionService, DEIService,
     * CopilotService, ReportDataService, TalentDepthService). Mirroring the
     * integer stored "4", and `boxScore("4")` returns 0 — so every employee placed
     * via the 9-box dragged the cohort mean down and fabricated or masked
     * discrimination alerts. Write the vocabulary key the consumers actually read.
     *
     * Returns a marker the caller attaches to its result:
     *   { cycleId, cycleStatus, box, visibleToConsumers }  or  { skipped: 'no_active_cycle' }
     * `visibleToConsumers` is false when a later (closed) cycle still holds rows,
     * because the consumers' MAX(cycle_id) then reads that closed cycle — logged,
     * so the gap is named rather than silent.
     */
    async _mirrorApproved(
        approved,
        { cycleId = null, placedBy = null, source = null, overrideReason = null } = {}
    ) {
        const cyc =
            cycleId != null
                ? { id: Number(cycleId), status: null }
                : await this._resolveMirrorCycle();
        if (!cyc) {
            console.warn(
                '[ninebox] placement mirror skipped — no open, locked or draft assessment cycle exists (no_active_cycle)'
            );
            return { skipped: 'no_active_cycle' };
        }
        const tier =
            { 1: 'up', 2: 'mid', 3: 'low' }[Number(approved.cellTier ?? approved.cell_tier)] ||
            'mid';
        const src =
            source ||
            (String(approved.positionSource ?? approved.position_source ?? '') === 'system'
                ? 'auto'
                : 'override');
        const placementBox = `${approved.potential}-${approved.performance}`;
        if (!Object.prototype.hasOwnProperty.call(BOX_LABELS, placementBox)) {
            // Fail loudly rather than store a value nothing can interpret.
            throw new Error(
                `invalid placement box "${placementBox}" for employee ${approved.employeeId}`
            );
        }
        await db.run(
            `INSERT INTO talent_placements
                 (employee_id, cycle_id, box, tier, source, override_reason, placed_by, placed_at)
             VALUES (?, ?, ?, ?::talent_tier, ?::placement_source, ?, ?, now())
             ON CONFLICT (employee_id, cycle_id) DO UPDATE
                SET box = EXCLUDED.box, tier = EXCLUDED.tier, source = EXCLUDED.source,
                    override_reason = EXCLUDED.override_reason,
                    placed_by = EXCLUDED.placed_by, placed_at = now()`,
            [
                approved.employeeId,
                cyc.id,
                placementBox,
                tier,
                src,
                overrideReason != null ? overrideReason : approved.comments || null,
                placedBy,
            ]
        );
        const mx = await db.get('SELECT MAX(cycle_id) AS m FROM talent_placements');
        const visibleToConsumers = Number(mx && mx.m) === cyc.id;
        if (!visibleToConsumers) {
            console.warn(
                `[ninebox] placement for employee ${approved.employeeId} mirrored into cycle ${cyc.id}, ` +
                    `but consumers read MAX(cycle_id) = ${mx && mx.m} (a later, closed cycle still holds rows) — open a new cycle`
            );
        }
        return { cycleId: cyc.id, cycleStatus: cyc.status, box: placementBox, visibleToConsumers };
    }

    /**
     * The two BEST-EFFORT steps that follow a position being (re)decided — the
     * talent_placements mirror and the PIP/IDP auto-trigger — each inside a
     * SAVEPOINT so a failure costs that step and never the decision it is attached
     * to. Inside a transaction a failed statement aborts the WHOLE transaction, so a
     * bare catch here would leave the eventual COMMIT silently performing a
     * ROLLBACK: the approval answered 200 while the status change, the audit event
     * and the triggers were all discarded. Verified by execution before the
     * savepoint was added. Shared by approve and applyCalibration.
     */
    async _mirrorContained(approved, opts) {
        try {
            return await db.runInSavepoint(async () => this._mirrorApproved(approved, opts));
        } catch (e) {
            console.error('[ninebox] talent_placements mirror failed:', e && e.message);
            return { error: e && e.message ? e.message : 'mirror failed' };
        }
    }

    async _triggerContained(user, placement, evaluationId, auditReq, req) {
        try {
            const out = await db.runInSavepoint(async () =>
                DevelopmentTriggerService.triggerForPlacement(
                    user,
                    {
                        employeeId: placement.employeeId,
                        performance: placement.performance,
                        potential: placement.potential,
                        label: placement.boxLabel || placement.label || `box ${placement.box}`,
                        // Exact provenance for the PIP/IDP this placement creates. Without
                        // it the trigger has to INFER the source evaluation from a 5-minute
                        // "recently approved, same levels" match — correct in practice but
                        // guessy. We know the id here, so pass it.
                        evaluationId,
                    },
                    req
                )
            );
            if (out) {
                await this._audit(
                    auditReq,
                    'NINEBOX_AUTO_TRIGGER',
                    evaluationId,
                    `${out.zone}: ${JSON.stringify(out)}`
                );
            }
            return out;
        } catch (e) {
            return { error: e && e.message ? e.message : 'auto-trigger failed' };
        }
    }

    /**
     * When an employee no longer holds an APPROVED evaluation, any talent_placements
     * row still standing for them is an orphan: the mirror of a position that no
     * longer exists, which DEI, bias, the copilot, the Report Builder and Power BI
     * would keep counting. Called by archive and reject AFTER the status change,
     * inside their transaction. Returns the cleared row (box/tier/source/cycle) so the
     * caller can copy it into the nine_box_events detail — talent_placements keeps no
     * history of its own (same pattern as MaintenanceService.cancelPlacement).
     *
     * Only the employee's LATEST mirror row is considered (the one a MAX(cycle_id)
     * consumer can read); older cycles are that person's history and stay.
     */
    async _clearOrphanMirror(employeeId) {
        const still = await db.get(
            "SELECT id FROM nine_box_evaluations WHERE employee_id = ? AND status = 'approved' LIMIT 1",
            [employeeId]
        );
        if (still) return null; // a standing approval backs the mirror — leave it
        const row = await db.get(
            `SELECT cycle_id, box, tier, source FROM talent_placements
              WHERE employee_id = ? ORDER BY cycle_id DESC LIMIT 1`,
            [employeeId]
        );
        if (!row) return null;
        await db.run('DELETE FROM talent_placements WHERE employee_id = ? AND cycle_id = ?', [
            employeeId,
            row.cycleId,
        ]);
        return { cycleId: Number(row.cycleId), box: row.box, tier: row.tier, source: row.source };
    }

    /**
     * Read one placement — WITH THE CAPACITÉS DU LECTEUR (constat M-06).
     *
     * `resolveAuthority` calcule déjà `canDraft` / `canApprove` : c'est le MÊME
     * arbitrage qui refuse ensuite approve/reject/archive/disclose à un
     * superviseur. La charge ne les portait pas, alors la console construisait
     * ses boutons sur le seul `status` et proposait à un superviseur quatre
     * commandes qui lui rendaient toutes 403 : une affordance qui ment.
     *
     * On ne DONNE aucun droit ici — la garde de chaque écriture est inchangée,
     * et A4 tient : on dit seulement au lecteur ce qu'il a le droit de faire, de
     * sorte que la page n'offre que cela.
     */
    async get(id, user, req = null) {
        const ev = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        if (!ev) throw say(new Error('Evaluation not found'), 'talentx:nb_err_not_found');
        const auth = await this.resolveAuthority(user, ev.employeeId);
        if (!auth.canView)
            throw say(
                new Error('Not authorized: confidential talent data'),
                'talentx:nb_err_not_authorized_view'
            );
        await this._event(id, ev.employeeId, user, auth, 'view', ev.status, ev.status);
        return {
            ...ev,
            canDraft: Boolean(auth.canDraft),
            canApprove: Boolean(auth.canApprove),
            movement: await this._movementForId(id),
        };
    }

    /**
     * Supervisor (or admin) creates a DRAFT placement.
     *
     * ONE OPEN PROPOSAL PER PERSON. This used to INSERT unconditionally,
     * so pressing "Re-assess" three times left three drafts and three chips on the
     * grid. Re-assessing a person who already has a proposal in flight is an EDIT of
     * that proposal, not a second one: the open row is updated in place and the audit
     * trail records an 'update'. Migration 95's partial unique index is the backstop
     * for the write paths that do not come through here.
     */
    async createDraft(user, data, req = null) {
        const auth = await this.resolveAuthority(user, data.employeeId);
        if (!auth.canDraft)
            throw say(
                new Error('Not authorized: supervisor/admin only'),
                'talentx:nb_err_not_authorized_supervisor'
            );
        const { box, label } = this.computeBox(data.performance, data.potential);
        const pos = this._cellPos(data);

        const open = await db.get(
            `SELECT * FROM nine_box_evaluations
              WHERE employee_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(', ')})
              ORDER BY ${currentOrder('')} LIMIT 1`,
            [data.employeeId, ...OPEN_STATUSES]
        );
        const fresh = this._cleanJustification(data.movementJustification);
        if (open)
            return db.runTransaction(async () => {
                // Movement first: a refused justification writes nothing.
                if (Number(open.box) !== Number(box) || fresh)
                    await this._onBoxChange(open, data, user, auth, fresh, {
                        enforce: open.status === 'under_review',
                    });
                await db.run(
                    `UPDATE nine_box_evaluations
                    SET performance=?, potential=?, box=?, box_label=?,
                        comments=COALESCE(?, comments), evidence=COALESCE(?, evidence),
                        calibration_notes=COALESCE(?, calibration_notes),
                        cell_tier=?, cell_trend=?, position_source=?, updated_at=now()
                  WHERE id=?`,
                    [
                        data.performance,
                        data.potential,
                        box,
                        label,
                        data.comments || null,
                        data.evidence || null,
                        data.calibrationNotes || null,
                        pos.tier,
                        pos.trend,
                        pos.source,
                        open.id,
                    ]
                );
                await this._event(
                    open.id,
                    data.employeeId,
                    user,
                    auth,
                    'update',
                    open.status,
                    open.status,
                    { box, label, reason: 'reassessed an open proposal' }
                );
                await this._audit(
                    req,
                    'NINEBOX_UPDATE',
                    open.id,
                    `re-assessed open proposal → box ${box} (${label}) for employee ${data.employeeId}`
                );
                return db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [open.id]);
            });

        const ev = await db.get(
            `INSERT INTO nine_box_evaluations (employee_id, cycle_id, performance, potential, box, box_label, comments, evidence, calibration_notes, clearance, status, created_by, cell_tier, cell_trend, position_source,
                                               movement_justification, movement_justified_by, movement_justified_by_type, movement_justified_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN now() END) RETURNING *`,
            [
                data.employeeId,
                data.cycleId || null,
                data.performance,
                data.potential,
                box,
                label,
                data.comments || null,
                data.evidence || null,
                data.calibrationNotes || null,
                data.clearance || 'confidential',
                auth.isAdmin ? null : user.id,
                pos.tier,
                pos.trend,
                pos.source,
                fresh || null,
                fresh && user && user.id != null ? user.id : null,
                fresh ? this._justifierType(user) : null,
                Boolean(fresh),
            ]
        );
        await this._event(ev.id, data.employeeId, user, auth, 'create', null, 'draft', {
            box,
            label,
        });
        await this._audit(
            req,
            'NINEBOX_CREATE',
            ev.id,
            `draft box ${box} (${label}) for employee ${data.employeeId}`
        );
        return ev;
    }

    /** Supervisor edits a draft (recomputes box). */
    async update(user, id, data, req = null) {
        const ev = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        if (!ev) throw say(new Error('Evaluation not found'), 'talentx:nb_err_not_found');
        const auth = await this.resolveAuthority(user, ev.employeeId);
        if (!auth.canDraft)
            throw say(
                new Error('Not authorized: supervisor/admin only'),
                'talentx:nb_err_not_authorized_supervisor'
            );
        if (!['draft', 'under_review'].includes(ev.status))
            throw say(
                new Error(`Cannot edit from '${ev.status}'`),
                'talentx:nb_err_cannot_edit_from',
                { statusRaw: ev.status }
            );
        const performance = data.performance || ev.performance;
        const potential = data.potential || ev.potential;
        const { box, label } = this.computeBox(performance, potential);
        const tier = data.cellTier != null ? this._cellPos(data).tier : null;
        const trend = data.cellTrend != null ? this._cellPos(data).trend : null;
        const fresh = this._cleanJustification(data.movementJustification);
        return db.runTransaction(async () => {
            // A REVIEWER CHANGING THE BOX of a submitted proposal must say why, again
            // (migration 175). Checked before any write, so a refusal changes nothing.
            if (Number(ev.box) !== Number(box) || fresh)
                await this._onBoxChange(ev, { performance, potential }, user, auth, fresh, {
                    enforce: ev.status === 'under_review',
                });
            await db.run(
                `UPDATE nine_box_evaluations SET performance=?, potential=?, box=?, box_label=?, comments=COALESCE(?,comments), evidence=COALESCE(?,evidence), calibration_notes=COALESCE(?,calibration_notes), cell_tier=COALESCE(?,cell_tier), cell_trend=COALESCE(?,cell_trend), updated_at=now() WHERE id=?`,
                [
                    performance,
                    potential,
                    box,
                    label,
                    data.comments ?? null,
                    data.evidence ?? null,
                    data.calibrationNotes ?? null,
                    tier,
                    trend,
                    id,
                ]
            );
            await this._event(id, ev.employeeId, user, auth, 'update', ev.status, ev.status, {
                box,
                label,
            });
            await this._audit(req, 'NINEBOX_UPDATE', id, `updated → box ${box}`);
            return db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        });
    }

    /** Supervisor submits draft for manager review. */
    async submit(user, id, req = null, { movementJustification = null } = {}) {
        const ev = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        if (!ev) throw say(new Error('Evaluation not found'), 'talentx:nb_err_not_found');
        const auth = await this.resolveAuthority(user, ev.employeeId);
        if (!auth.canDraft)
            throw say(
                new Error('Not authorized: supervisor/admin only'),
                'talentx:nb_err_not_authorized_supervisor'
            );
        if (ev.status !== 'draft')
            throw say(
                new Error(`Cannot submit from '${ev.status}'`),
                'talentx:nb_err_cannot_submit_from',
                { statusRaw: ev.status }
            );
        return db.runTransaction(async () => {
            // MOVEMENT SNAPSHOT (migration 175): link to the previous approved
            // placement and refuse — writing nothing — when the box changes
            // without a written justification.
            const mv = await this._snapshotMovement(ev, user, auth, movementJustification);
            await db.run(
                "UPDATE nine_box_evaluations SET status='under_review', submitted_by=?, updated_at=now() WHERE id=?",
                [user.id, id]
            );
            await this._event(id, ev.employeeId, user, auth, 'submit', 'draft', 'under_review');
            await this._audit(
                req,
                'NINEBOX_SUBMIT',
                id,
                `submitted for manager review (movement ${mv.direction}` +
                    `${mv.previous ? ` from evaluation ${mv.previous.id}` : ''})`
            );
            return db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        });
    }

    /**
     * FOUR EYES on a placement (App Setting nineBoxFourEyes; on for a new
     * install, off after an upgrade until a SuperAdmin switches it on): the
     * person who DRAFTED the placement — its 'create' event, by either of their
     * accounts or an unlinked admin account sharing their identity
     * (personIdentity.isSamePerson) — does not approve it. A SuperAdmin may
     * approve their own draft with a written reason (10 characters or more),
     * journalled. Returns null when allowed, or the override reason to journal.
     */
    async _assertFourEyes(user, ev, overrideReason) {
        let on = true;
        try {
            const v = await require('../models/AppSettingsModel').getValue('nineBoxFourEyes', true);
            on = !(v === false || v === 'false' || v === 0 || v === '0');
        } catch (_) {
            on = true;
        }
        if (!on) return null;
        const d = await db.get(
            `SELECT actor_id, actor_type FROM nine_box_events
              WHERE evaluation_id = ? AND action = 'create' ORDER BY id LIMIT 1`,
            [ev.id]
        );
        let ref = null;
        if (d && d.actorId != null)
            ref = `${d.actorType === 'admin' ? 'admin' : 'employee'}:${Number(d.actorId)}`;
        else if (ev.createdBy != null) ref = `employee:${Number(ev.createdBy)}`;
        if (!ref) return null; // no recorded drafter (a row older than the journal)
        const same = await require('../utils/personIdentity').isSamePerson(user, ref);
        if (!same) return null;
        const why = String(overrideReason == null ? '' : overrideReason).trim();
        if (RBACService.isSuperAdmin(user) && why.length >= 10) return why.slice(0, 500);
        const e = say(
            new Error(
                'Four eyes: whoever drafted this placement cannot approve it (a SuperAdmin may, with a written reason).'
            ),
            'talentx:nb_err_four_eyes'
        );
        e.status = 409;
        e.expose = true;
        e.code = 'NINEBOX_FOUR_EYES';
        throw e;
    }

    /** MANAGER ONLY (admin inherits) — approve/publish. */
    async approve(
        user,
        id,
        req = null,
        { movementJustification = null, fourEyesReason = null } = {}
    ) {
        const ev = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        if (!ev) throw say(new Error('Evaluation not found'), 'talentx:nb_err_not_found');
        const auth = await this.resolveAuthority(user, ev.employeeId);
        if (!auth.canApprove)
            throw say(
                new Error('Not authorized: manager/admin only'),
                'talentx:nb_err_not_authorized_manager'
            );
        if (!['under_review', 'draft'].includes(ev.status))
            throw say(
                new Error(`Cannot approve from '${ev.status}'`),
                'talentx:nb_err_cannot_approve_from',
                { statusRaw: ev.status }
            );
        const fourEyesOverride = await this._assertFourEyes(user, ev, fourEyesReason);
        // Status change + audit event + auto-triggers commit atomically.
        return db.runTransaction(async () => {
            if (fourEyesOverride)
                await this._audit(
                    req,
                    'NINEBOX_FOUR_EYES_OVERRIDE',
                    id,
                    `SuperAdmin approved their own draft — reason: ${fourEyesOverride}`
                );
            // MOVEMENT (migration 175). A placement approved straight from a
            // draft, or a proposal submitted before the rule existed, has no
            // snapshot yet: it is taken now. Otherwise the snapshot stands, and
            // the justification it calls for must already be stored or come with
            // this approval. Checked before any other write.
            if (!ev.movementSnapshotAt) {
                await this._snapshotMovement(ev, user, auth, movementJustification);
            } else {
                const fresh = this._cleanJustification(movementJustification);
                const prev =
                    ev.previousPerformance != null && ev.previousPotential != null
                        ? { performance: ev.previousPerformance, potential: ev.previousPotential }
                        : null;
                const dir = this.movementDirection(prev, ev);
                const have = fresh || this._cleanJustification(ev.movementJustification);
                if (this.movementNeedsJustification(dir))
                    await this._assertJustification(have, ev.employeeId, ev.id);
                if (fresh) await this._onBoxChange(ev, ev, user, auth, fresh, { enforce: true });
            }
            // ONE APPROVED PLACEMENT PER PERSON. A new approval SUPERSEDES the
            // previous one instead of stacking beside it — employee 88 held 7 approved rows
            // in the same box, which the talent-development dashboard counted as 7 people.
            // Superseded rows become 'archived', which is exactly where placementTrend
            // and the talent timeline read history from, so nothing is lost. Same
            // transaction as the approval, so the unique index can never see two.
            const superseded = await db.all(
                `SELECT id, employee_id FROM nine_box_evaluations
              WHERE employee_id = ? AND status = 'approved' AND id <> ?`,
                [ev.employeeId, id]
            );
            if (superseded.length) {
                await db.run(
                    "UPDATE nine_box_evaluations SET status='archived', updated_at=now() WHERE employee_id=? AND status='approved' AND id<>?",
                    [ev.employeeId, id]
                );
                for (const s of superseded) {
                    await this._event(
                        s.id,
                        ev.employeeId,
                        user,
                        auth,
                        'supersede',
                        'approved',
                        'archived',
                        { supersededBy: Number(id) }
                    );
                }
            }
            await db.run(
                "UPDATE nine_box_evaluations SET status='approved', approved_by=?, approved_at=now(), updated_at=now() WHERE id=?",
                [auth.isAdmin ? null : user.id, id]
            );
            await this._event(id, ev.employeeId, user, auth, 'approve', ev.status, 'approved');
            await this._audit(req, 'NINEBOX_APPROVE', id, 'placement approved/published');
            // The direct manager learns when someone above them approved (best-effort).
            await require('./LineNoticeService').actedAbove(
                user,
                ev.employeeId,
                'ninebox_approved'
            );
            const approved = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);

            // MIRROR THE APPROVED PLACEMENT INTO talent_placements.
            // Nothing here ever wrote that table, yet it is what the DEI analytics,
            // bias detection, the copilot, Report Builder, Power BI and the calibration
            // write-back all READ — so an approved placement was invisible to every
            // downstream consumer. Cycle resolution + the write live in
            // _mirrorApproved (shared with the calibration write-back, so there is ONE
            // rule for where a position is mirrored and what it looks like there);
            // never break the approval: a mirror failure is logged, not thrown.
            approved.mirror = await this._mirrorContained(approved, {
                placedBy: auth.isAdmin ? user.id : null,
            });
            // Side-effect: red ⇒ PIP + coaching; blue ⇒ IDP proposal. Never break approval.
            approved.autoTrigger = await this._triggerContained(user, approved, id, req, req);
            return approved;
        });
    }

    // Disclose (or hide) an APPROVED placement to the subject employee. Only the
    // hierarchical superior (manager/admin in scope) may decide this; the employee
    // can then see ONLY their own position on their dashboard. Audited.
    //
    // DISCLOSURE IS A DELIBERATE ACT, AND IT IS
    // TRACED. The boolean recorded the fact and nothing else: the person saw
    // their cell with no date, no author and no reason, and a manager could
    // publish — or retract — a confidential judgement leaving nothing behind. A
    // written reason is now mandatory in BOTH directions, and the row carries
    // who/when/why (migration 115, chk_ninebox_disclosure_complete is the
    // backstop). Retracting clears the stamp and records its own reason in the
    // event log, where the whole history of the decision lives.
    async setDisclosure(user, id, disclosed, reason = null, req = null) {
        const ev = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        if (!ev) throw say(new Error('Evaluation not found'), 'talentx:nb_err_not_found');
        const auth = await this.resolveAuthority(user, ev.employeeId);
        if (!auth.canApprove)
            throw say(
                new Error('Not authorized: manager/admin only'),
                'talentx:nb_err_not_authorized_manager'
            );
        if (ev.status !== 'approved')
            throw say(
                new Error(`Only an approved placement can be disclosed (current: '${ev.status}')`),
                'talentx:nb_err_disclose_not_approved',
                { statusRaw: ev.status }
            );
        // Explicit coercion: a stray string like "false" must NOT disclose.
        const flag =
            disclosed === true || disclosed === 1 || disclosed === 'true' || disclosed === '1';
        const why = reason == null ? '' : String(reason).trim();
        if (!why) {
            const e = new Error(
                flag
                    ? 'Un motif écrit est obligatoire pour divulguer un positionnement à la personne concernée.'
                    : 'Un motif écrit est obligatoire pour retirer un positionnement déjà divulgué.'
            );
            // Ces deux-là sont rédigés en FRANÇAIS : sans clé ils partaient tels
            // quels sur la page anglaise. Le message reste la phrase de référence
            // (des suites l'épinglent), la clé donne la phrase lue.
            say(
                e,
                flag
                    ? 'talentx:nb_err_disclose_reason_required'
                    : 'talentx:nb_err_hide_reason_required'
            );
            e.code = 'REASON_REQUIRED';
            e.status = 400;
            e.expose = true;
            throw e;
        }
        // admin | manager | supervisor — employees and admins are different id
        // spaces, so the type is what makes disclosed_by readable later.
        const actorType = auth.isAdmin ? 'admin' : auth.isManager ? 'manager' : 'supervisor';
        return db
            .runTransaction(async () => {
                await db.run(
                    `UPDATE nine_box_evaluations
                    SET disclosed_to_employee = ?,
                        disclosed_at      = CASE WHEN ? THEN now() ELSE NULL END,
                        disclosed_by      = CASE WHEN ? THEN ?::bigint ELSE NULL END,
                        disclosed_by_type = CASE WHEN ? THEN ?::text ELSE NULL END,
                        disclosure_reason = CASE WHEN ? THEN ?::text ELSE NULL END,
                        updated_at = now()
                  WHERE id = ?`,
                    [
                        flag,
                        flag,
                        flag,
                        user && user.id != null ? user.id : null,
                        flag,
                        actorType,
                        flag,
                        why.slice(0, 2000),
                        id,
                    ]
                );
                await this._event(
                    id,
                    ev.employeeId,
                    user,
                    auth,
                    flag ? 'disclose' : 'undisclose',
                    ev.status,
                    ev.status,
                    { reason: why.slice(0, 2000) }
                );
                await this._audit(
                    req,
                    flag ? 'NINEBOX_DISCLOSE' : 'NINEBOX_UNDISCLOSE',
                    id,
                    (flag ? 'placement disclosed to employee' : 'placement hidden from employee') +
                        ` — ${why.slice(0, 300)}`
                );
                return await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
            })
            .then(async (row) => {
                // Only when a manager/admin DISCLOSES the placement do we tell the
                // employee. CRITICAL: in-app only (category 'confidential' is unmapped →
                // email OFF) and the payload carries NO box/performance/potential — those
                // must never leave the app. The employee sees the detail behind the link.
                if (flag) {
                    try {
                        await require('./NotificationService')
                            .notify({
                                userType: 'employee',
                                userId: Number(ev.employeeId),
                                kind: 'ninebox.disclosed',
                                category: 'confidential',
                                payload: { link: '/employee/dashboard' },
                            })
                            .catch(() => {});
                    } catch (_) {
                        /* never block */
                    }
                }
                return row;
            });
    }

    async reject(user, id, reason, req = null) {
        // A rejection reason is mandatory (parity with self-assessment rejection):
        // the supervisor who drafted the placement must be told WHY it was rejected.
        if (!reason || !String(reason).trim())
            throw say(
                new Error('A rejection reason is required.'),
                'talentx:nb_err_reject_reason_required'
            );
        reason = String(reason).trim();
        const ev = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        if (!ev) throw say(new Error('Evaluation not found'), 'talentx:nb_err_not_found');
        const auth = await this.resolveAuthority(user, ev.employeeId);
        if (!auth.canApprove)
            throw say(
                new Error('Not authorized: manager/admin only'),
                'talentx:nb_err_not_authorized_manager'
            );
        if (!['under_review', 'draft'].includes(ev.status))
            throw say(
                new Error(`Cannot reject from '${ev.status}'`),
                'talentx:nb_err_cannot_reject_from',
                { statusRaw: ev.status }
            );
        // Status change, mirror clean-up and the event that explains both commit
        // together. A rejected proposal was never mirrored itself, but if the person
        // holds NO approved position the mirror row is an orphan (proved: after the
        // rejection the grid showed 0 rows for the employee while talent_placements
        // still counted their box for DEI/bias/copilot/Report Builder/Power BI).
        return db.runTransaction(async () => {
            await db.run(
                "UPDATE nine_box_evaluations SET status='rejected', rejected_by=?, rejected_at=now(), calibration_notes=COALESCE(?,calibration_notes), updated_at=now() WHERE id=?",
                [user.id, reason || null, id]
            );
            const cleared = await this._clearOrphanMirror(ev.employeeId);
            await this._event(id, ev.employeeId, user, auth, 'reject', ev.status, 'rejected', {
                reason: reason || null,
                // Copied out because talent_placements keeps no history.
                ...(cleared ? { clearedPlacement: cleared } : {}),
            });
            await this._audit(
                req,
                'NINEBOX_REJECT',
                id,
                `placement rejected${cleared ? ` (orphan mirror ${cleared.box} in cycle ${cleared.cycleId} cleared)` : ''}`
            );
            return db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        });
    }

    async archive(user, id, req = null) {
        const ev = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        if (!ev) throw say(new Error('Evaluation not found'), 'talentx:nb_err_not_found');
        const auth = await this.resolveAuthority(user, ev.employeeId);
        if (!auth.canApprove)
            throw say(
                new Error('Not authorized: manager/admin only'),
                'talentx:nb_err_not_authorized_manager'
            );
        // Archiving the APPROVED row removes the person's position (migration 95:
        // a placement is what has been approved), so its talent_placements mirror
        // goes with it in the SAME transaction — its old box copied into the event
        // first, exactly as MaintenanceService.cancelPlacement does. Before this,
        // the grid dropped employee 87 while talent_placements still held
        // 87/cycle 6/medium-medium and every downstream consumer kept counting it.
        return db.runTransaction(async () => {
            await db.run(
                "UPDATE nine_box_evaluations SET status='archived', updated_at=now() WHERE id=?",
                [id]
            );
            const cleared = await this._clearOrphanMirror(ev.employeeId);
            await this._event(
                id,
                ev.employeeId,
                user,
                auth,
                'archive',
                ev.status,
                'archived',
                cleared ? { box: ev.box, boxLabel: ev.boxLabel, clearedPlacement: cleared } : null
            );
            await this._audit(
                req,
                'NINEBOX_ARCHIVE',
                id,
                `placement archived${cleared ? ` (mirror ${cleared.box} in cycle ${cleared.cycleId} cleared)` : ''}`
            );
            return db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        });
    }

    /**
     * CALIBRATION WRITE-BACK — design review's decision applied to a person's
     * APPROVED placement, through the same path as approve:
     *   evaluation updated → nine_box_events 'calibrate' row (from/to box, session,
     *   rationale) → audit → talent_placements mirror → DevelopmentTriggerService
     *   .triggerForPlacement, the last two each inside a savepoint so a mirror or
     *   trigger failure costs that step and never the calibration.
     *
     * Before this, TalentDepthService.finalizeCalibration wrote talent_placements
     * and nine_box_evaluations with two raw UPDATEs: no event, no audit, and no
     * trigger — a calibration that moved someone into the RED zone opened no PIP
     * and no coaching (proved: 68963 low-low → high-low, applied 1, pips unchanged).
     *
     * Returns null — and writes NOTHING — when the employee holds no approved
     * evaluation: there is no position to calibrate. The caller counts that as
     * "not applied". `toBox` is "{potential}-{performance}".
     */
    async applyCalibration(
        actor,
        { employeeId, toBox, reason = null, sessionId = null, cycleId = null },
        req = null
    ) {
        const [potential, performance] = String(toBox || '').split('-');
        const { box, label } = this.computeBox(performance, potential); // rejects anything outside the 9 boxes
        const ev = await db.get(
            `SELECT * FROM nine_box_evaluations
              WHERE employee_id = ? AND status = 'approved'
              ORDER BY approved_at DESC NULLS LAST, id DESC LIMIT 1`,
            [employeeId]
        );
        if (!ev) return null;

        const isAdmin = Boolean(actor && actor.userType === 'admin');
        const auth = {
            isAdmin,
            isManager: Boolean(actor && actor.userType === 'manager'),
            isSupervisor: false,
        };
        const auditReq = req || (actor ? { user: actor, ip: null } : null);
        const fromBox = `${ev.potential}-${ev.performance}`;
        const note = ('Calibration: ' + (reason || '')).slice(0, 480);

        return db.runTransaction(async () => {
            // MOVEMENT (migration 175): a calibration that CHANGES the box is a
            // new move from the previous placement, and its rationale is the
            // justification. It is required when the box then differs from the
            // previous one, and also when there is no previous approved
            // placement at all (a 'first' placement moved by the session would
            // otherwise carry no written reason). A refusal aborts the finalize:
            // nothing is written and the session stays open to be corrected.
            // Checked BEFORE any write; recorded by ONE extra UPDATE below and
            // named in the same 'calibrate' event (one act, one event).
            let mv = null;
            if (fromBox !== String(toBox)) {
                const prev = ev.movementSnapshotAt
                    ? ev.previousPerformance != null && ev.previousPotential != null
                        ? {
                              id: ev.previousEvaluationId,
                              box: ev.previousBox,
                              performance: ev.previousPerformance,
                              potential: ev.previousPotential,
                              cycleId: ev.previousCycleId,
                              approvedAt: ev.previousApprovedAt,
                          }
                        : null
                    : (await this._previousApproved(employeeId, ev.id)) || null;
                const direction = this.movementDirection(prev, { performance, potential });
                const text = this._cleanJustification(reason);
                // The copy rule applies to the session's rationale too. Here the
                // calibrated placement's OWN stored justification is the
                // person's previous one (the session replaces it), so it is not
                // excluded from the comparison: pasting the manager's text back
                // word for word is refused.
                if (this.movementNeedsJustification(direction) || direction === 'first')
                    await this._assertJustification(text, employeeId, null);
                mv = { prev, direction, text };
            }
            await db.run(
                `UPDATE nine_box_evaluations
                    SET potential = ?, performance = ?, box = ?, box_label = ?,
                        calibration_notes = ?, updated_at = now()
                  WHERE id = ? AND status = 'approved'`,
                [potential, performance, box, label, note, ev.id]
            );
            if (mv) {
                const p = mv.prev;
                await db.run(
                    `UPDATE nine_box_evaluations
                        SET previous_evaluation_id = ?, previous_box = ?, previous_performance = ?,
                            previous_potential = ?, previous_cycle_id = ?, previous_approved_at = ?,
                            movement_direction = ?,
                            movement_snapshot_at = COALESCE(movement_snapshot_at, now()),
                            movement_justification = COALESCE(?, movement_justification),
                            movement_justified_by = COALESCE(?, movement_justified_by),
                            movement_justified_by_type = COALESCE(?, movement_justified_by_type),
                            movement_justified_at = CASE WHEN ?::text IS NULL THEN movement_justified_at ELSE now() END
                      WHERE id = ?`,
                    [
                        p ? p.id : null,
                        p ? p.box : null,
                        p ? p.performance : null,
                        p ? p.potential : null,
                        p ? p.cycleId : null,
                        p ? p.approvedAt : null,
                        mv.direction,
                        // An empty rationale never blanks a stored justification,
                        // its author or its date.
                        mv.text || null,
                        mv.text ? (actor && actor.id != null ? actor.id : null) : null,
                        mv.text ? this._justifierType(actor) : null,
                        mv.text || null,
                        ev.id,
                    ]
                );
            }
            await this._event(ev.id, employeeId, actor, auth, 'calibrate', 'approved', 'approved', {
                fromBox,
                toBox: String(toBox),
                from: ev.box,
                to: box,
                fromLabel: ev.boxLabel,
                toLabel: label,
                sessionId: sessionId != null ? Number(sessionId) : null,
                // Ids only: the session's rationale is NOT copied into the
                // journal. It lives in calibration_notes, movement_justification
                // and calibration_adjustments, which erasure redacts and the
                // self-service export withholds. The event records only that a
                // rationale was given.
                reasonRecorded: Boolean(reason && String(reason).trim()),
                // Migration 175: the move, ids only.
                ...(mv
                    ? {
                          movement: {
                              previousEvaluationId:
                                  mv.prev && mv.prev.id != null ? Number(mv.prev.id) : null,
                              fromBox: mv.prev && mv.prev.box != null ? Number(mv.prev.box) : null,
                              toBox: box,
                              direction: mv.direction,
                              justified: mv.text.length >= MOVEMENT_MIN_JUSTIFICATION,
                          },
                      }
                    : {}),
            });
            await this._audit(
                auditReq,
                'NINEBOX_CALIBRATE',
                ev.id,
                `calibration session ${sessionId}: ${fromBox} → ${toBox} (${label}) for employee ${employeeId}`
            );
            const approved = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [
                ev.id,
            ]);
            const out = {
                evaluationId: Number(ev.id),
                employeeId: Number(employeeId),
                fromBox,
                toBox: String(toBox),
                changed: fromBox !== String(toBox),
            };

            out.mirror = await this._mirrorContained(approved, {
                cycleId,
                placedBy: isAdmin ? actor.id : null,
                source: 'override',
                overrideReason: note,
            });
            // Red ⇒ PIP + coaching; blue ⇒ IDP. Same containment as approve.
            out.autoTrigger = await this._triggerContained(actor, approved, ev.id, auditReq, req);
            return out;
        });
    }

    async history(id, user) {
        // Confidential talent data — gate on the same authority as get.
        const ev = await db.get('SELECT * FROM nine_box_evaluations WHERE id = ?', [id]);
        if (!ev) throw say(new Error('Evaluation not found'), 'talentx:nb_err_not_found');
        const auth = await this.resolveAuthority(user, ev.employeeId);
        if (!auth.canView)
            throw say(
                new Error('Not authorized: confidential talent data'),
                'talentx:nb_err_not_authorized_view'
            );
        return await db.all(
            'SELECT * FROM nine_box_events WHERE evaluation_id = ? ORDER BY created_at, id',
            [id]
        );
    }

    /**
     * Resolve the set of employee IDs the user is cleared for.
     *   super admin → all · local admin/viewer → admin scope · manager → reports.
     * Returns { all: true } for super admin (no IN-list needed) or { ids: [...] }.
     */
    async _scopedEmployeeIds(user) {
        if (RBACService.isSuperAdmin(user)) return { all: true };
        let employees;
        if (user && user.userType === 'admin') {
            employees = await RBACService.getFilteredEmployees(user); // scoped or []
        } else {
            employees = await EmployeeModel.findGoverned(user.id); // full sub-tree
        }
        const ids = new Set(employees.map((e) => Number(e.id)));
        // UNION with the reporting line of the PERSON behind an administration
        // account (admins.linked_employee_id) — the same union RBACService
        // .scopeFilter applies to every list, and the same authority
        // resolveAuthority now recognises. Measured: the linked admin 703
        // (person 137) got n=0 here against 16 for the same human signed in as
        // employee 137.
        if (user && user.userType === 'admin') {
            for (const id of await GovernanceService.lineAuthorityEmployeeIds(user))
                ids.add(Number(id));
        }
        return { all: false, ids: [...ids] };
    }

    /**
     * Grid (clearance-filtered: only the actor's span of control). Audited as a view.
     *
     * EXACTLY ONE CHIP PER PERSON. This used to select every row with
     * status <> 'archived', which plotted employee 87 ten times across three boxes
     * and also plotted REJECTED placements as if they were positions. A DISTINCT ON
     * over `currentOrder` now resolves the one row that is this person's position:
     * their approved placement, or — only when they have none — the open proposal,
     * which travels with `provisional: true` so the console can mark it as a
     * proposal rather than show it as a decision.
     *
     * `pendingProposal` reports the OTHER case that made two screens disagree: an
     * approved placement with a newer draft on top of it. The position stays the
     * approved one everywhere; the pending proposal is surfaced as a separate
     * marker, never as the answer.
     */
    async grid(user, req = null) {
        const scope = await this._scopedEmployeeIds(user);
        let where = `ev.status IN (${LIVE_STATUSES.map(() => '?').join(', ')})`;
        const params = [...LIVE_STATUSES];
        if (!scope.all) {
            if (!scope.ids.length) return [];
            where += ` AND ev.employee_id IN (${scope.ids.map(() => '?').join(', ')})`;
            params.push(...scope.ids);
        }
        const rows = await db.all(
            `SELECT cur.id, cur.box, cur.box_label, cur.performance, cur.potential, cur.status,
                    cur.clearance, cur.cell_tier, cur.cell_trend, cur.disclosed_to_employee,
                    cur.provisional, cur.pending_proposal,
                    cur.employee_id, cur.first_name, cur.last_name,
                    cur.prev_id, cur.prev_box, cur.prev_performance, cur.prev_potential,
                    cur.prev_cycle_id, cur.prev_approved_at, cur.movement_snapshot,
                    cur.movement_backfilled, cur.movement_justification, cur.movement_justified_by,
                    cur.movement_justified_by_type, cur.movement_justified_at
             FROM (
                SELECT DISTINCT ON (ev.employee_id)
                       ev.id, ev.box, ev.box_label, ev.performance, ev.potential, ev.status,
                       ev.clearance, ev.cell_tier, ev.cell_trend, ev.disclosed_to_employee,
                       (ev.status <> 'approved') AS provisional,
                       (ev.status = 'approved' AND EXISTS (
                            SELECT 1 FROM nine_box_evaluations o
                             WHERE o.employee_id = ev.employee_id
                               AND o.status IN ('draft', 'under_review'))) AS pending_proposal,
                       e.id AS employee_id, e.first_name, e.last_name,
                       ${PREV_COLS}
                  FROM nine_box_evaluations ev JOIN employees e ON e.id = ev.employee_id
                  ${PREV_LATERAL}
                 WHERE ${where}
                 ORDER BY ev.employee_id, ${currentOrder('ev.')}
             ) cur
             ORDER BY cur.box, cur.cell_tier, cur.last_name`,
            params
        );
        await this._audit(
            req,
            'NINEBOX_GRID_VIEW',
            null,
            `viewed grid (${rows.length} placements)`
        );
        return this._withMovement(rows);
    }

    /**
     * Attach `movement` (before → now, direction, justification) to rows
     * that carry PREV_COLS, and drop the raw prev_* columns from the payload.
     */
    async _withMovement(rows) {
        const names = await this._names(
            rows
                .filter((r) => r.movementJustifiedBy != null)
                .map((r) => ({ type: r.movementJustifiedByType, id: r.movementJustifiedBy }))
        );
        const RAW = [
            'prevId',
            'prevBox',
            'prevPerformance',
            'prevPotential',
            'prevCycleId',
            'prevApprovedAt',
            'movementSnapshot',
            'movementBackfilled',
            'movementJustification',
            'movementJustifiedBy',
            'movementJustifiedByType',
            'movementJustifiedAt',
        ];
        return rows.map((r) => {
            const movement = this._movementOf(r, names);
            const out = { ...r, movement };
            for (const k of RAW) delete out[k];
            return out;
        });
    }

    /**
     * Roster of registered employees the user may assess (clearance-filtered),
     * each annotated with their latest non-archived placement (or null).
     * This is what lets the user populate/assess the workforce, not just see
     * employees that already have a placement.
     */
    async roster(user, req = null) {
        let employees;
        if (user && user.userType === 'admin') {
            employees = await RBACService.getFilteredEmployees(user); // all (super) or scoped
        } else {
            employees = await EmployeeModel.findGoverned(user.id); // full sub-tree
        }
        const ids = employees.map((e) => Number(e.id));
        let placements = [];
        // Same precedence as grid: the APPROVED placement is the position; an open
        // proposal only stands in when there is no approval yet, and is flagged
        // `provisional` so the badge can say so. Before this, the roster took the most
        // recently updated non-archived row, which showed the unapproved DRAFT with no
        // marker while the dashboard tile showed the approved position — two screens,
        // two answers, for the same person.
        if (ids.length) {
            placements = await db.all(
                `SELECT DISTINCT ON (ev.employee_id) ev.employee_id, ev.id, ev.box, ev.box_label,
                        ev.performance, ev.potential, ev.status,
                        COALESCE(ev.approved_at, ev.updated_at) AS assessed_at,
                        (ev.status <> 'approved') AS provisional,
                        ${PREV_COLS}
                 FROM nine_box_evaluations ev
                 ${PREV_LATERAL}
                 WHERE ev.employee_id IN (${ids.map(() => '?').join(', ')})
                   AND ev.status IN (${LIVE_STATUSES.map(() => '?').join(', ')})
                 ORDER BY ev.employee_id, ${currentOrder('ev.')}`,
                [...ids, ...LIVE_STATUSES]
            );
            // before → now for each person (migration 175).
            placements = await this._withMovement(placements);
        }
        const byEmp = {};
        for (const p of placements) byEmp[Number(p.employeeId)] = p;

        // The proposal in flight, when the person ALSO has an approved position.
        // It is reported next to the position, never instead of it.
        const openByEmp = {};
        if (ids.length) {
            const open = await db.all(
                `SELECT DISTINCT ON (employee_id) employee_id, id, box, status
                   FROM nine_box_evaluations
                  WHERE employee_id IN (${ids.map(() => '?').join(', ')})
                    AND status IN (${OPEN_STATUSES.map(() => '?').join(', ')})
                  ORDER BY employee_id, ${currentOrder('')}`,
                [...ids, ...OPEN_STATUSES]
            );
            for (const r of open) openByEmp[Number(r.employeeId)] = r;
        }

        // The re-assessment clock must be driven by an APPROVED placement, never by
        // a draft. `assessed_at = COALESCE(approved_at, updated_at)` over every
        // non-archived row meant that opening a draft and saving it read as
        // "assessed just now": 8 of the 10 employees listed here have only a draft,
        // and all 10 showed `due = false`. People with no decision at all vanished
        // from the queue — an absence of decision presented as a decision.
        //
        // This is a separate lookup rather than a change to the query above, because
        // the roster still shows the CURRENT row (draft included) — it is only the
        // cadence that requires an approval. The latest approval also survives a
        // newer draft being opened on top of it.
        const approvedByEmp = {};
        if (ids.length) {
            const approvals = await db.all(
                `SELECT employee_id, MAX(approved_at) AS approved_at
                   FROM nine_box_evaluations
                  WHERE employee_id IN (${ids.map(() => '?').join(', ')})
                    AND status = 'approved' AND approved_at IS NOT NULL
                  GROUP BY employee_id`,
                ids
            );
            for (const r of approvals) approvedByEmp[Number(r.employeeId)] = r.approvedAt;
        }

        await this._audit(
            req,
            'NINEBOX_ROSTER_VIEW',
            null,
            `viewed roster (${employees.length} employees)`
        );

        const cadence = await this._reassessMonths();
        const now = Date.now();
        // « New in the role » (4.0.0 port, wave 5): a recorded role start date
        // within newInRoleMonths — a fact next to the name, never a placement.
        const newInRole = await require('../utils/newInRole')
            .newInRoleIds(ids)
            .catch(() => new Set());
        return employees.map((e) => {
            const p = byEmp[Number(e.id)] || null;
            if (p) p.boxLabel = this.computeBox(p.performance, p.potential).label; // consistent labels
            // Only an approval starts the cadence; a draft leaves the person due.
            const approvedAt = approvedByEmp[Number(e.id)] || null;
            let monthsSince = null,
                due = true;
            if (approvedAt) {
                monthsSince = (now - new Date(approvedAt).getTime()) / (1000 * 60 * 60 * 24 * 30.4);
                due = monthsSince >= cadence;
            }
            const open = openByEmp[Number(e.id)] || null;
            return {
                employeeId: Number(e.id),
                firstName: e.firstName,
                lastName: e.lastName,
                employeeNumber: e.employeeNumber,
                roleName: e.roleName || null,
                serviceName: e.serviceName || null,
                siteName: e.siteName || null,
                placement: p,
                // TRUE when the badge is showing a proposal, not a decision.
                provisional: Boolean(p && p.provisional),
                // A proposal in flight ON TOP of an approved position (id so the
                // console can open it). Null when the badge already IS that proposal.
                pendingProposal:
                    p && !p.provisional && open
                        ? { id: Number(open.id), box: Number(open.box), status: open.status }
                        : null,
                // The date of the last real DECISION, not of the last edit.
                lastAssessedAt: approvedAt,
                monthsSince: monthsSince == null ? null : Math.round(monthsSince * 10) / 10,
                // « il y a 3 semaines », never « il y a 0,8 mois »: the unit a
                // person would use (utils/agoBucket), labelled by the console.
                sinceAgo: approvedAt ? agoBucket(daysBetween(approvedAt, now)) : null,
                dueForReassessment: due,
                cadenceMonths: cadence,
                newInRole: newInRole.has(Number(e.id)),
            };
        });
    }

    /** Re-assessment cadence (months) — from app settings, default REASSESS_MONTHS. */
    async _reassessMonths() {
        try {
            const row = await db.get(
                "SELECT setting_value FROM app_settings WHERE setting_key = 'nineBoxReassessMonths'"
            );
            const v = row && parseInt(row.settingValue, 10);
            if (v && v > 0) return v;
        } catch (_) {
            /* table/setting may not exist */
        }
        return REASSESS_MONTHS;
    }

    /** Per-employee placement history over time (for trend tracking). */
    async placementTrend(employeeId, user, req = null) {
        const auth = await this.resolveAuthority(user, employeeId);
        if (!auth.canView)
            throw say(
                new Error('Not authorized to view this employee’s 9-box'),
                'talentx:nb_err_not_authorized_view'
            );
        const rows = await db.all(
            `SELECT id, box, box_label, performance, potential, status,
                    COALESCE(approved_at, updated_at, created_at) AS at
               FROM nine_box_evaluations
              WHERE employee_id = ? AND status IN ('approved','archived')
              ORDER BY COALESCE(approved_at, updated_at, created_at)`,
            [employeeId]
        );
        const SC = { low: 1, medium: 2, high: 3 };
        return rows.map((r) => ({
            id: r.id,
            box: r.box,
            boxLabel: this.computeBox(r.performance, r.potential).label,
            status: r.status,
            performance: r.performance,
            potential: r.potential,
            perfScore: SC[r.performance] || 0,
            potScore: SC[r.potential] || 0,
            at: r.at,
        }));
    }
}

module.exports = new NineBoxService();
