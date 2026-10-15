'use strict';

/**
 * SafetyWaiverService — the human path on the safety-competency gate
 * (migration 174). The gate decides BLOCKED from data alone; this service lets
 * a responsible person act on that answer in the open, never hide it.
 *
 * Waiver
 *   - Granted by the person's line (their direct supervisor or manager, as
 *     ReportingLineService resolves it) or by HSE: an admin holding
 *     manage_compliance whose clearance covers the person. Never by the person.
 *   - Covers ONE critical skill of ONE person, and only a reason that blocks
 *     under an enforced rule right now.
 *   - A reason is required. It lasts 72 hours at most (a database CHECK too)
 *     and can be renewed once. Every step is audited by id.
 *   - Refused on a rule marked legally mandatory; the evaluation ignores a
 *     waiver on such a rule in any case.
 *   - While it runs, the status is WAIVED (« autorisé par dérogation »), never
 *     CLEARED, in the pages, the API and the webhook. The evaluation only counts
 *     a running window, so its end restores the computed status at once; the
 *     job then marks the row expired and the change is notified once.
 *   - Limits on repetition: no fresh grant within 72 hours of the end of any
 *     waiver for the same person and skill, and no more than 144 waived hours
 *     per person and skill over a rolling 30 days.
 *
 * Contest
 *   - The person, or their line, contests an enforced BLOCKED status with a
 *     reason. One open contest per person.
 *   - An HSE or HR reviewer (manage_compliance within clearance, neither the
 *     person nor the one who contested) records a decision with its reason:
 *     upheld, or overturned with a remedy (a waiver under the same limits, or
 *     a pointer to the data that must be corrected).
 *   - The person, and a line contester, are told the outcome. Nothing is
 *     deleted.
 */

const db = require('../config/database');
const SafetyGateService = require('./SafetyGateService');
const { scopedEmployeeIds } = require('../utils/rbacScope');
const { personNameSql } = require('../utils/personName');
const { fmtDateTime } = require('../utils/dateFormat');

const { failWith, audit, actorRefOf, reasonSummary, LOCALE_TEXT } = SafetyGateService._internal;
const { STATUS } = SafetyGateService;

const HOURS_MAX = 72;
const COOLDOWN_HOURS = 72;
const CAP_HOURS = 144;
const CAP_WINDOW_DAYS = 30;
const REASON_MAX = 2000;
const POINTER_MAX = 500;
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function idOf(v, code = 'not_found') {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) failWith(code);
    return n;
}

/**
 * Throw with the usual code (reason_required, forbidden…) and a `subject`
 * naming what was refused (waiver, waiver_end, contest, decision), so the page
 * can say « the reason for the waiver is required » rather than reuse the
 * wording written for deactivating a rule.
 */
function refuse(subject, code, status) {
    try {
        failWith(code, status);
    } catch (e) {
        if (subject) e.subject = subject;
        throw e;
    }
}

function reasonOf(v, subject = null) {
    const s = String(v == null ? '' : v).trim();
    if (!s) refuse(subject, 'reason_required');
    return s.slice(0, REASON_MAX);
}

function hoursOf(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > HOURS_MAX) failWith('bad_hours');
    return n;
}

function uniqueViolation(e) {
    if (!e) return false;
    if (e.code === '23505') return true;
    const m = String(e.message || '');
    return m.includes('duplicate key') || m.includes('unique');
}

/** A date and time for texts written outside a request (FR, the server's zone). */
function whenText(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return fmtDateTime(d, 'fr');
}

function fill(s, vars) {
    return String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? '' : vars[k]));
}

function T(lng, key, vars = {}) {
    const L = LOCALE_TEXT[lng] || LOCALE_TEXT.fr;
    return fill(L[key] || key, vars);
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

function isEmployeeActor(actor) {
    return !!actor && (actor.userType === 'employee' || actor.userType === 'manager');
}

/** The employee row the actor is (an admin through its linked employee). */
async function selfEmployeeId(actor) {
    if (!actor || actor.id == null) return null;
    if (isEmployeeActor(actor)) return Number(actor.id);
    if (actor.userType !== 'admin') return null;
    const row = await db.get(
        'SELECT linked_employee_id AS "linkedEmployeeId" FROM admins WHERE id = ?',
        [Number(actor.id)]
    );
    return row && row.linkedEmployeeId != null ? Number(row.linkedEmployeeId) : null;
}

/** Is the actor this person's active direct supervisor or manager? */
function actorIsLine(actor, line) {
    if (!actor || !line) return false;
    const id = Number(actor.id);
    if (isEmployeeActor(actor)) {
        if (line.supervisor && Number(line.supervisor.id) === id) return true;
        return !!(
            line.manager &&
            line.manager.type === 'employee' &&
            Number(line.manager.id) === id
        );
    }
    if (actor.userType === 'admin')
        return !!(line.manager && line.manager.type === 'admin' && Number(line.manager.id) === id);
    return false;
}

function holdsCompliance(actor) {
    return (
        !!actor &&
        actor.userType === 'admin' &&
        require('./RBACService').hasPermission(actor, 'manage_compliance')
    );
}

async function inScope(actor, employeeId) {
    const ids = await scopedEmployeeIds(actor);
    return ids === null || (Array.isArray(ids) && ids.map(Number).includes(Number(employeeId)));
}

const SafetyWaiverService = {
    HOURS_MAX,
    COOLDOWN_HOURS,
    CAP_HOURS,
    CAP_WINDOW_DAYS,

    /**
     * Who may act on each person: 'line', 'hse' or null. Never the person
     * themselves; HSE only inside the actor's clearance. Fails closed.
     * @returns {Promise<Map<number, 'line'|'hse'|null>>}
     */
    async authorityMany(actor, employeeIds) {
        const ids = [...new Set((employeeIds || []).map(Number).filter((n) => n > 0))];
        const out = new Map(ids.map((id) => [id, null]));
        if (!actor || !ids.length) return out;
        try {
            const self = await selfEmployeeId(actor);
            const lines = await require('./ReportingLineService').linesFor(ids);
            const hse = holdsCompliance(actor) ? await scopedEmployeeIds(actor) : undefined;
            const hseSet = Array.isArray(hse) ? new Set(hse.map(Number)) : null;
            for (const id of ids) {
                if (self != null && id === self) continue;
                if (actorIsLine(actor, lines.get(id))) out.set(id, 'line');
                else if (hse === null || (hseSet && hseSet.has(id))) out.set(id, 'hse');
            }
        } catch (e) {
            console.error('[safety-waiver] authority lookup failed:', e && e.message);
            for (const id of ids) out.set(id, null);
        }
        return out;
    },

    async authority(actor, employeeId) {
        const id = Number(employeeId);
        return (await this.authorityMany(actor, [id])).get(id) || null;
    },

    /** May this actor decide a contest about this person (HSE/HR within clearance)? */
    async canDecide(actor, employeeId) {
        if (!holdsCompliance(actor)) return false;
        try {
            const self = await selfEmployeeId(actor);
            if (self != null && self === Number(employeeId)) return false;
            return await inScope(actor, employeeId);
        } catch (_) {
            return false;
        }
    },

    // ---- Waivers ----------------------------------------------------------

    /** Active rules on this skill that apply to the person (role, own site or all sites). */
    async _rulesFor(employeeId, skillId) {
        const emp = await db.get(
            'SELECT id, role_id AS "roleId", site_id AS "siteId", is_active AS "isActive" FROM employees WHERE id = ?',
            [employeeId]
        );
        if (!emp) failWith('not_found', 404);
        const rules = await db.all(
            `SELECT id, site_id AS "siteId", legally_mandatory AS "legallyMandatory", "mode" AS "mode"
               FROM safety_gate_rules
              WHERE is_active AND role_id = ? AND skill_id = ? AND (site_id IS NULL OR site_id = ?)
              ORDER BY site_id NULLS LAST, id`,
            [emp.roleId, skillId, emp.siteId]
        );
        return { emp, rules: rules || [] };
    },

    /**
     * Hours already waived for this person and skill inside the rolling window.
     * Each waiver counts from the later of its start and the window start, to
     * its real end (ended_at, else its scheduled expiry). `closingId` is a
     * running waiver about to end now (a renewal): it counts up to now only.
     * Throws `waiver_cap` (409) when `hours` more would pass the cap; an
     * unreadable sum also refuses.
     */
    async _assertUnderCap(employeeId, skillId, hours, closingId) {
        const row = await db.get(
            `SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                        CASE WHEN id = CAST(? AS bigint) THEN LEAST(now(), COALESCE(ended_at, expires_at))
                             ELSE COALESCE(ended_at, expires_at) END
                        - GREATEST(starts_at, now() - interval '${CAP_WINDOW_DAYS} days')))
                    )) / 3600.0, 0) AS "used"
               FROM safety_gate_waivers
              WHERE employee_id = ? AND skill_id = ?
                AND COALESCE(ended_at, expires_at) > now() - interval '${CAP_WINDOW_DAYS} days'`,
            [closingId == null ? null : Number(closingId), employeeId, skillId]
        );
        const used = row && row.used != null ? Number(row.used) : 0;
        if (!Number.isFinite(used) || used + Number(hours) > CAP_HOURS + 1e-6) {
            const e = new Error('waiver_cap');
            e.code = 'waiver_cap';
            e.status = 409;
            e.usedHours = Number.isFinite(used) ? Math.round(used * 10) / 10 : null;
            throw e;
        }
        return used;
    },

    /** Refuse a waiver that is not allowed; returns the rule it is recorded against. */
    async _assertWaivable(employeeId, skillId) {
        const { emp, rules } = await this._rulesFor(employeeId, skillId);
        if (emp.isActive === false) failWith('not_waivable', 409);
        if (!rules.length) failWith('not_blocking', 409);
        if (rules.some((r) => r.legallyMandatory)) failWith('legally_mandatory', 409);
        return rules[0];
    },

    /**
     * Grant a waiver. `opts.via = 'contest'` is a reviewer's overturn, whose
     * authority decideContest has already checked.
     * @throws .code forbidden | not_found | reason_required | bad_hours |
     *   not_waivable | not_blocking | legally_mandatory | waiver_exists |
     *   renewal_exhausted | waiver_cooldown | waiver_cap
     */
    async grantWaiver({ employeeId, skillId, hours, reason }, actor, opts = {}) {
        const eid = idOf(employeeId);
        const kid = idOf(skillId, 'not_blocking');
        const why = reasonOf(reason, 'waiver');
        const h = hoursOf(hours);
        let via = opts.via === 'contest' ? 'contest' : null;
        if (!via) {
            via = await this.authority(actor, eid);
            if (!via) refuse('waiver', 'forbidden', 403);
        }
        const rule = await this._assertWaivable(eid, kid);

        // It must be a blocking reason of an enforced rule on this skill, now.
        const [cur] = await SafetyGateService.computeFor({ employeeIds: [eid] }, null, {
            record: false,
        });
        if (!cur) failWith('not_found', 404);
        const target = cur.reasons.find(
            (x) => Number(x.skillId) === kid && x.blocking && !x.observe
        );
        if (!target) failWith('not_blocking', 409);
        if (target.waived) failWith('waiver_exists', 409);

        // No fresh grant while any waiver for the same person and skill ended
        // less than 72 hours ago: grant, expire, grant again is not a way round
        // the single renewal.
        const recent = await db.get(
            `SELECT id, renewal_of AS "renewalOf" FROM safety_gate_waivers
              WHERE employee_id = ? AND skill_id = ?
                AND COALESCE(ended_at, expires_at) > now() - interval '${COOLDOWN_HOURS} hours'
              ORDER BY (renewal_of IS NOT NULL) DESC
              LIMIT 1`,
            [eid, kid]
        );
        if (recent)
            failWith(recent.renewalOf != null ? 'renewal_exhausted' : 'waiver_cooldown', 409);
        await this._assertUnderCap(eid, kid, h, null);

        let row;
        try {
            row = await db.get(
                `INSERT INTO safety_gate_waivers
                    (employee_id, skill_id, rule_id, reason, granted_by_ref, granted_via,
                     starts_at, expires_at, contest_id)
                 VALUES (?, ?, ?, ?, ?, ?, now(), now() + (? * interval '1 hour'), ?)
                 RETURNING id, to_char(expires_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "expiresAt"`,
                [
                    eid,
                    kid,
                    rule.id,
                    why,
                    actorRefOf(actor),
                    via,
                    h,
                    opts.contestId != null ? Number(opts.contestId) : null,
                ]
            );
        } catch (e) {
            if (uniqueViolation(e)) failWith('waiver_exists', 409);
            throw e;
        }
        await audit(
            actor,
            'SAFETY_GATE_WAIVER_GRANTED',
            'safety_gate_waiver',
            row.id,
            `employee=${eid} skill=${kid} rule=${rule.id} hours=${h} via=${via}${opts.contestId ? ` contest=${Number(opts.contestId)}` : ''}`,
            'warn'
        );
        await SafetyGateService.recomputeForEmployee(eid, 'waiver').catch((e) =>
            console.error('[safety-waiver] recompute after grant failed:', e && e.message)
        );
        if (opts.notify !== false)
            await this.notifyWaiverGranted(eid, target, row.expiresAt, actor, false).catch(
                () => {}
            );
        return { id: Number(row.id), expiresAt: row.expiresAt, via };
    },

    /** The single renewal of a running waiver: a new window of at most 72 hours from now. */
    async renewWaiver(waiverId, { hours, reason }, actor) {
        const wid = idOf(waiverId);
        const why = reasonOf(reason, 'waiver');
        const h = hoursOf(hours);
        const result = await db.runTransaction(async () => {
            const w = await db.get(
                `SELECT id, employee_id AS "employeeId", skill_id AS "skillId", rule_id AS "ruleId",
                        renewal_of AS "renewalOf", state, (expires_at > now()) AS "running"
                   FROM safety_gate_waivers WHERE id = ? FOR UPDATE`,
                [wid]
            );
            if (!w) failWith('not_found', 404);
            const via = await this.authority(actor, w.employeeId);
            if (!via) refuse('waiver', 'forbidden', 403);
            if (w.state !== 'active' || !w.running) failWith('waiver_not_running', 409);
            if (w.renewalOf != null) failWith('renewal_exhausted', 409);
            const rule = await this._assertWaivable(Number(w.employeeId), Number(w.skillId));
            await this._assertUnderCap(Number(w.employeeId), Number(w.skillId), h, wid);
            await db.run(
                `UPDATE safety_gate_waivers SET state = 'renewed', ended_at = now()
                  WHERE id = ? AND state = 'active'`,
                [wid]
            );
            let row;
            try {
                row = await db.get(
                    `INSERT INTO safety_gate_waivers
                        (employee_id, skill_id, rule_id, reason, granted_by_ref, granted_via,
                         starts_at, expires_at, renewal_of)
                     VALUES (?, ?, ?, ?, ?, ?, now(), now() + (? * interval '1 hour'), ?)
                     RETURNING id, to_char(expires_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "expiresAt"`,
                    [w.employeeId, w.skillId, rule.id, why, actorRefOf(actor), via, h, wid]
                );
            } catch (e) {
                if (uniqueViolation(e)) failWith('renewal_exhausted', 409);
                throw e;
            }
            await audit(
                actor,
                'SAFETY_GATE_WAIVER_RENEWED',
                'safety_gate_waiver',
                row.id,
                `renewal_of=${wid} employee=${Number(w.employeeId)} skill=${Number(w.skillId)} hours=${h} via=${via}`,
                'warn'
            );
            return {
                id: Number(row.id),
                expiresAt: row.expiresAt,
                employeeId: Number(w.employeeId),
                skillId: Number(w.skillId),
            };
        });
        await SafetyGateService.recomputeForEmployee(result.employeeId, 'waiver').catch(() => {});
        await this.notifyWaiverGranted(
            result.employeeId,
            { skillId: result.skillId },
            result.expiresAt,
            actor,
            true
        ).catch(() => {});
        return result;
    },

    /** End a running waiver early (line or HSE), with a reason. Nothing is deleted. */
    async revokeWaiver(waiverId, reason, actor) {
        const wid = idOf(waiverId);
        const why = reasonOf(reason, 'waiver_end');
        const w = await db.get(
            'SELECT id, employee_id AS "employeeId", state FROM safety_gate_waivers WHERE id = ?',
            [wid]
        );
        if (!w) failWith('not_found', 404);
        if (!(await this.authority(actor, w.employeeId))) refuse('waiver', 'forbidden', 403);
        const row = await db.get(
            `UPDATE safety_gate_waivers
                SET state = 'revoked', ended_at = now(), ended_reason = ?, revoked_by_ref = ?
              WHERE id = ? AND state = 'active' RETURNING id`,
            [why, actorRefOf(actor), wid]
        );
        if (!row) failWith('waiver_not_running', 409);
        await audit(
            actor,
            'SAFETY_GATE_WAIVER_REVOKED',
            'safety_gate_waiver',
            wid,
            `employee=${Number(w.employeeId)}`
        );
        // The recompute records WAIVED -> computed status and notifies the end.
        await SafetyGateService.recomputeForEmployee(w.employeeId, 'waiver_revoked').catch(
            () => {}
        );
        return { id: wid };
    },

    /**
     * Job step: mark every waiver whose window has closed as expired and
     * recompute those people, so the change is recorded, sent to the webhook
     * and notified once. The evaluation already stopped counting them when the
     * window closed; this makes the end visible.
     */
    async expireDue() {
        const rows =
            (await db.all(
                `UPDATE safety_gate_waivers SET state = 'expired', ended_at = expires_at
                  WHERE state = 'active' AND expires_at <= now()
                  RETURNING id, employee_id AS "employeeId"`
            )) || [];
        for (const r of rows)
            await audit(
                null,
                'SAFETY_GATE_WAIVER_EXPIRED',
                'safety_gate_waiver',
                r.id,
                `employee=${Number(r.employeeId)}`
            );
        const ids = [...new Set(rows.map((r) => Number(r.employeeId)))];
        if (ids.length)
            await SafetyGateService.computeFor({ employeeIds: ids }, null, {
                source: 'waiver_expired',
            });
        return { expired: rows.length, employees: ids.length };
    },

    // ---- Contests ---------------------------------------------------------

    /**
     * The person, or their line, contests an enforced BLOCKED status.
     * @throws .code forbidden | reason_required | not_blocked | contest_exists
     */
    async submitContest({ employeeId, reason }, actor) {
        const eid = idOf(employeeId);
        const why = reasonOf(reason, 'contest');
        const self = await selfEmployeeId(actor);
        let as = null;
        if (self != null && self === eid && isEmployeeActor(actor)) as = 'self';
        else if ((await this.authority(actor, eid)) === 'line') as = 'line';
        if (!as) refuse('contest', 'forbidden', 403);
        const [cur] = await SafetyGateService.computeFor({ employeeIds: [eid] }, null, {
            source: 'contest',
        });
        if (!cur || SafetyGateService.effectiveStatus(cur) !== STATUS.BLOCKED)
            failWith('not_blocked', 409);
        const reasons = cur.reasons
            .filter((x) => x.blocking && !x.observe && !x.waived)
            .map((x) => ({ code: x.code, ...(x.skillId != null ? { skillId: x.skillId } : {}) }));
        let row;
        try {
            row = await db.get(
                `INSERT INTO safety_gate_contests
                    (employee_id, contested_by_ref, contested_as, reason, status_at_contest, reasons_at_contest)
                 VALUES (?, ?, ?, ?, ?, CAST(? AS jsonb)) RETURNING id`,
                [eid, actorRefOf(actor), as, why, STATUS.BLOCKED, JSON.stringify(reasons)]
            );
        } catch (e) {
            if (uniqueViolation(e)) failWith('contest_exists', 409);
            throw e;
        }
        await audit(
            actor,
            'SAFETY_GATE_CONTEST_SUBMITTED',
            'safety_gate_contest',
            row.id,
            `employee=${eid} as=${as}`
        );
        await this.notifyContestReviewers(eid, row.id, actor).catch(() => {});
        return { id: Number(row.id), as };
    },

    /**
     * Record the human decision on a contest.
     * @param input { decision: 'upheld'|'overturned', reason,
     *                remedy?: 'waiver'|'data_correction', skillId?, hours?, correctionPointer? }
     * @throws .code forbidden | not_found | contest_closed | self_decision |
     *   bad_decision | reason_required | bad_remedy | pointer_required | (waiver codes)
     */
    async decideContest(contestId, input, actor) {
        const cid = idOf(contestId);
        const b = input || {};
        const decision = String(b.decision || '');
        if (decision !== 'upheld' && decision !== 'overturned') failWith('bad_decision');
        const why = reasonOf(b.reason, 'decision');
        const out = await db.runTransaction(async () => {
            const c = await db.get(
                `SELECT id, employee_id AS "employeeId", contested_by_ref AS "contestedByRef",
                        contested_as AS "contestedAs", state
                   FROM safety_gate_contests WHERE id = ? FOR UPDATE`,
                [cid]
            );
            if (!c) failWith('not_found', 404);
            if (!(await this.canDecide(actor, c.employeeId))) refuse('decision', 'forbidden', 403);
            if (c.state !== 'open') failWith('contest_closed', 409);
            if (c.contestedByRef === actorRefOf(actor)) failWith('self_decision', 403);

            let remedy = null;
            let pointer = null;
            let waiver = null;
            if (decision === 'overturned') {
                remedy = String(b.remedy || '');
                if (remedy === 'waiver') {
                    waiver = await this.grantWaiver(
                        {
                            employeeId: c.employeeId,
                            skillId: b.skillId,
                            hours: b.hours,
                            reason: why,
                        },
                        actor,
                        { via: 'contest', contestId: cid, notify: false }
                    );
                } else if (remedy === 'data_correction') {
                    pointer = String(b.correctionPointer || '')
                        .trim()
                        .slice(0, POINTER_MAX);
                    if (!pointer) failWith('pointer_required');
                } else {
                    failWith('bad_remedy');
                }
            }
            const row = await db.get(
                `UPDATE safety_gate_contests
                    SET state = ?, decision_reason = ?, decided_by_ref = ?, decided_at = now(),
                        remedy = ?, correction_pointer = ?, waiver_id = ?
                  WHERE id = ? AND state = 'open' RETURNING id`,
                [decision, why, actorRefOf(actor), remedy, pointer, waiver ? waiver.id : null, cid]
            );
            if (!row) failWith('contest_closed', 409);
            await audit(
                actor,
                'SAFETY_GATE_CONTEST_DECIDED',
                'safety_gate_contest',
                cid,
                `employee=${Number(c.employeeId)} decision=${decision}${remedy ? ` remedy=${remedy}` : ''}${waiver ? ` waiver=${waiver.id}` : ''}`
            );
            return { contest: c, decision, remedy, waiver };
        });
        await this.notifyContestDecided(out).catch(() => {});
        return {
            id: cid,
            decision: out.decision,
            remedy: out.remedy,
            waiverId: out.waiver ? out.waiver.id : null,
        };
    },

    // ---- Reads (all limited to the actor's clearance) ---------------------

    async _scopeSql(actor, alias = 'x') {
        const ids = await scopedEmployeeIds(actor);
        if (ids === null) return { sql: '', params: [], empty: false };
        if (!ids.length) return { sql: '', params: [], empty: true };
        return {
            sql: ` AND ${alias}.employee_id IN (${ids.map(() => '?').join(',')})`,
            params: ids.map(Number),
            empty: false,
        };
    },

    /** Running waivers the actor may see. */
    async listRunningWaivers(actor) {
        if (!actor) return [];
        const s = await this._scopeSql(actor, 'w');
        if (s.empty) return [];
        return db.all(
            `SELECT w.id, w.employee_id AS "employeeId", ${personNameSql('e')} AS "name",
                    e.employee_number AS "employeeNumber", w.skill_id AS "skillId", sk.name AS "skillName",
                    w.granted_via AS "grantVia", w.reason, w.starts_at AS "startsAt",
                    to_char(w.expires_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "expiresAt",
                    (w.renewal_of IS NOT NULL) AS "isRenewal"
               FROM safety_gate_waivers w
               JOIN employees e ON e.id = w.employee_id
               JOIN skills sk ON sk.id = w.skill_id
              WHERE w.state = 'active' AND w.expires_at > now()${s.sql}
              ORDER BY w.expires_at, w.id`,
            s.params
        );
    },

    /** Contests the actor may see, open ones first. */
    async listContests(actor, { openOnly = false, limit = 100 } = {}) {
        if (!actor) return [];
        const s = await this._scopeSql(actor, 'c');
        if (s.empty) return [];
        const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
        const rows =
            (await db.all(
                `SELECT c.id, c.employee_id AS "employeeId", ${personNameSql('e')} AS "name",
                    e.employee_number AS "employeeNumber", c.contested_as AS "contestedAs",
                    c.reason, c.reasons_at_contest AS "reasonsAtContest", c.state,
                    c.decision_reason AS "decisionReason", c.remedy, c.correction_pointer AS "correctionPointer",
                    c.waiver_id AS "waiverId", c.created_at AS "createdAt", c.decided_at AS "decidedAt"
               FROM safety_gate_contests c
               JOIN employees e ON e.id = c.employee_id
              WHERE ${openOnly ? "c.state = 'open'" : '1 = 1'}${s.sql}
              ORDER BY (c.state = 'open') DESC, c.created_at DESC
              LIMIT ${lim}`,
                s.params
            )) || [];
        // The skills named by the reasons recorded with the contest: the ones
        // an overturn by waiver may target, named for the decision form.
        const skillIds = new Set();
        for (const c of rows) {
            const list = Array.isArray(c.reasonsAtContest) ? c.reasonsAtContest : [];
            list.forEach((x) => x && x.skillId != null && skillIds.add(Number(x.skillId)));
        }
        const names = new Map();
        if (skillIds.size) {
            const ids = [...skillIds];
            const found = await db.all(
                `SELECT id, name FROM skills WHERE id IN (${ids.map(() => '?').join(',')})`,
                ids
            );
            (found || []).forEach((s) => names.set(Number(s.id), s.name));
        }
        return rows.map((c) => {
            const list = Array.isArray(c.reasonsAtContest) ? c.reasonsAtContest : [];
            const seen = new Set();
            const skills = [];
            for (const x of list) {
                const id = x && x.skillId != null ? Number(x.skillId) : null;
                if (id == null || seen.has(id)) continue;
                seen.add(id);
                skills.push({ id, name: names.get(id) || `#${id}` });
            }
            return { ...c, skills };
        });
    },

    /** The person's own waivers and contests, for their page. */
    async forEmployee(employeeId) {
        const eid = Number(employeeId);
        const waivers = await db.all(
            `SELECT w.id, w.skill_id AS "skillId", sk.name AS "skillName", w.reason, w.state,
                    w.starts_at AS "startsAt",
                    to_char(w.expires_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS "expiresAt",
                    w.ended_at AS "endedAt", (w.expires_at > now()) AS "running"
               FROM safety_gate_waivers w JOIN skills sk ON sk.id = w.skill_id
              WHERE w.employee_id = ? ORDER BY w.created_at DESC, w.id DESC LIMIT 20`,
            [eid]
        );
        const contests = await db.all(
            `SELECT id, contested_as AS "contestedAs", reason, state, decision_reason AS "decisionReason",
                    remedy, correction_pointer AS "correctionPointer", created_at AS "createdAt",
                    decided_at AS "decidedAt"
               FROM safety_gate_contests WHERE employee_id = ?
              ORDER BY created_at DESC, id DESC LIMIT 20`,
            [eid]
        );
        return { waivers: waivers || [], contests: contests || [] };
    },

    // ---- Notifications ----------------------------------------------------
    //
    // No subject or body is passed: the e-mail is the catalogue's own (the
    // kind's title, a generic sentence and a link), so no name, status, skill
    // or reason reaches a mailbox. The detail sits in the in-app payload
    // (`reason`), read behind sign-in by the person, their line or in-scope
    // HSE, who are the only recipients here.

    async _lineOf(employeeId, actor) {
        const recipients = await require('./ReportingLineService')
            .lineRecipients(employeeId, { includeManager: true })
            .catch(() => []);
        const me = actor ? actorRefOf(actor) : null;
        return (recipients || []).filter(
            (x) => `${x.userType === 'admin' ? 'admin' : 'employee'}:${Number(x.id)}` !== me
        );
    },

    async _who(employeeId) {
        const e = await db
            .get(
                `SELECT ${personNameSql('e')} AS "name", e.employee_number AS "employeeNumber"
                   FROM employees e WHERE e.id = ?`,
                [employeeId]
            )
            .catch(() => null);
        return (e && (e.name || e.employeeNumber)) || `#${employeeId}`;
    },

    async _skillName(skillId) {
        if (skillId == null) return '';
        const s = await db.get('SELECT name FROM skills WHERE id = ?', [skillId]).catch(() => null);
        return (s && s.name) || '';
    },

    /** The person and their line hear of a waiver (grant or renewal) and its end date. */
    async notifyWaiverGranted(employeeId, target, expiresAt, actor, renewed) {
        const N = require('./NotificationService');
        const skill =
            (target && target.skillName) || (await this._skillName(target && target.skillId));
        const body = T('fr', 'notif_waiver_body', { skill, date: whenText(expiresAt) });
        const payload = {
            employeeId,
            skillId: target ? target.skillId : null,
            until: expiresAt,
            renewed: !!renewed,
        };
        await N.notify({
            userType: 'employee',
            userId: employeeId,
            kind: 'safety.waiver_granted',
            category: 'compliance',
            payload: { ...payload, reason: body, link: '/safety-gate/me' },
        });
        const who = await this._who(employeeId);
        for (const x of await this._lineOf(employeeId, actor)) {
            await N.notify({
                userType: x.userType,
                userId: x.id,
                kind: 'safety.waiver_granted.team',
                category: 'compliance',
                payload: { ...payload, reason: `${who} — ${body}`, link: '/safety-gate' },
            });
        }
    },

    /** A waiver ended (expired, ended early, or no longer needed): the status now. */
    async notifyWaiverEnded(r, enforced) {
        const N = require('./NotificationService');
        const relevant = r.reasons.filter((x) => x.blocking && !x.observe && !x.waived);
        const why = relevant.length ? ` — ${reasonSummary(relevant, 'fr')}` : '';
        const body =
            T('fr', 'notif_waiver_ended_body', { status: T('fr', `status_${enforced}`) }) + why;
        const payload = {
            employeeId: r.employeeId,
            status: enforced,
            previousStatus: STATUS.WAIVED,
        };
        await N.notify({
            userType: 'employee',
            userId: r.employeeId,
            kind: 'safety.waiver_ended',
            category: 'compliance',
            payload: { ...payload, reason: body, link: '/safety-gate/me' },
        });
        const who = r.name || r.employeeNumber || `#${r.employeeId}`;
        for (const x of await this._lineOf(r.employeeId, null)) {
            await N.notify({
                userType: x.userType,
                userId: x.id,
                kind: 'safety.waiver_ended.team',
                category: 'compliance',
                payload: { ...payload, reason: `${who} — ${body}`, link: '/safety-gate' },
            });
        }
    },

    /** Reviewers: admins holding manage_compliance whose clearance covers the person. */
    async notifyContestReviewers(employeeId, contestId, actor) {
        const RBACService = require('./RBACService');
        const N = require('./NotificationService');
        const adminIds = await RBACService.adminsWithPermission('manage_compliance').catch(
            () => []
        );
        const who = await this._who(employeeId);
        const me = actorRefOf(actor);
        for (const id of adminIds || []) {
            if (`admin:${Number(id)}` === me) continue;
            const a = await db
                .get('SELECT id, role FROM admins WHERE id = ?', [id])
                .catch(() => null);
            if (!a) continue;
            const reviewer = { id: Number(a.id), userType: 'admin', role: a.role };
            if (!(await inScope(reviewer, employeeId).catch(() => false))) continue;
            await N.notify({
                userType: 'admin',
                userId: reviewer.id,
                kind: 'safety.contest.review',
                category: 'compliance',
                payload: { employeeId, contestId, reason: who, link: '/safety-gate#contests' },
            });
        }
    },

    /** The person, and a line contester, hear the decision. */
    async notifyContestDecided({ contest, decision, remedy, waiver }) {
        const N = require('./NotificationService');
        const key =
            decision === 'upheld'
                ? 'notif_contest_upheld'
                : remedy === 'waiver'
                  ? 'notif_contest_overturned_waiver'
                  : 'notif_contest_overturned_correction';
        const body = T('fr', key, { date: waiver ? whenText(waiver.expiresAt) : '' });
        const eid = Number(contest.employeeId);
        const targets = [{ userType: 'employee', id: eid, link: '/safety-gate/me' }];
        const ref = String(contest.contestedByRef || '');
        const colon = ref.indexOf(':');
        const refType = colon > 0 ? ref.slice(0, colon) : '';
        const refId = colon > 0 ? Number(ref.slice(colon + 1)) : NaN;
        if (
            (refType === 'admin' || refType === 'employee') &&
            Number.isInteger(refId) &&
            refId > 0 &&
            !(refType === 'employee' && refId === eid)
        )
            targets.push({ userType: refType, id: refId, link: '/safety-gate' });
        for (const t of targets) {
            await N.notify({
                userType: t.userType,
                userId: t.id,
                kind: 'safety.contest.decided',
                category: 'compliance',
                payload: {
                    employeeId: eid,
                    contestId: contest.id,
                    decision,
                    remedy,
                    reason: body,
                    link: t.link,
                },
            });
        }
    },
};

module.exports = SafetyWaiverService;
module.exports.__test = { actorIsLine, whenText, fill };
