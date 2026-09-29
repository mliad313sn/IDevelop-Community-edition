'use strict';

/**
 * reminders — the "nothing slips" nudge tick. Exactly-once per period via the
 * reminder_log ledger (claim-before-send), covering the stalls the event-time
 * notifications can't catch:
 *   - IDP dual sign-off stalled (one party signed, the other hasn't)   → weekly
 *   - LMS course assigned but never started                            → weekly
 *   - Survey open with non-responders                                  → weekly
 *   - Access-review overdue (reviewers = SuperAdmins)                  → monthly
 *   - 9-box placements past the re-assessment cadence                  → weekly
 *   - PIP/IDP plans stalled or running out of time                     → weekly
 *   - Handover plans overdue / running out of time                     → weekly
 *
 * `claim`, `weekBucket` and `monthBucket` are exported so the other proactive
 * ticks (succession-review, retention-recompute, planning-digest) share ONE
 * ledger implementation instead of forking a subtly different copy of it.
 *
 * All reminders are digest-tier (in-app + daily digest), so they never spam the
 * inbox. Self-gated to one hour/day; the ledger makes re-runs a no-op anyway.
 *
 * TALENT reminders (the last two) are AGGREGATED PER MANAGER — ONE notification
 * carrying a count, never one per row: at 4000 employees a per-row fan-out would
 * be a flood. They are delivered IN-APP ONLY (enqueue, not notify) because 9-box
 * material is confidential and must never leave the app, and because the personal
 * digest already rolls unread in-app items into a single courteous email.
 * Payloads carry a COUNT and a deep link only — never a placement label, a box,
 * a performance/potential level or an employee name.
 */
const db = require('../config/database');

const ENV_HOUR = Number(process.env.REMINDER_HOUR) || 8;
// How far ahead a plan end-date counts as "coming due" (and how long a proposed
// PIP may sit unactivated before the owner is nudged).
const PLAN_DUE_DAYS = Number(process.env.TALENT_PLAN_DUE_DAYS) || 14;
const PIP_STALLED_DAYS = Number(process.env.TALENT_PIP_STALLED_DAYS) || 14;
// Fallback cadence when the `nineBoxReassessMonths` App Setting is absent —
// mirrors NineBoxService.REASSESS_MONTHS.
const REASSESS_MONTHS_DEFAULT = 3;

function weekBucket(d) {
    // ISO-week-ish bucket: YYYY-Www (UTC). Deterministic string for the ledger.
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = (t.getUTCDay() + 6) % 7; // Mon=0
    t.setUTCDate(t.getUTCDate() - day + 3);
    const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const week =
        1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function monthBucket(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
// Quarterly / yearly buckets live HERE, beside the week and month ones, because
// this module is the ONE shared bucket registry (dept-brief spec §4.2). A job
// that needs a bucket imports it; it never writes its own. `cycle-nudge.js:123`
// already forked a different week bucket ('YYYY-MM-DD' of the Monday) and the
// two silently disagree about which period a run belongs to.
// UTC like their neighbours: the gate, the bucket and the period bounds must all
// read the same clock, or a run on a period boundary is mislabelled or skipped.
function quarterBucket(d) {
    return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
function yearBucket(d) {
    return String(d.getUTCFullYear());
}

/** Atomic claim: true only the FIRST time this (kind,target,ref,period) is seen. */
async function claim(kind, targetType, targetId, refId, period) {
    if (!targetId) return false;
    const row = await db.get(
        `INSERT INTO reminder_log (kind, target_type, target_id, ref_id, period)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, target_type, target_id, ref_id, period) DO NOTHING
         RETURNING id`,
        [kind, targetType, Number(targetId), Number(refId) || 0, period]
    );
    return !!row;
}

/**
 * Hand a claim back when NOTHING was delivered.
 *
 * The ledger insert is the claim and it happens BEFORE the send, so a crash can
 * never double-notify. But `NotificationService.notify` signals failure by
 * RETURNING `{ inapp: 'error' }` — it does not throw — and every section here
 * used to `.catch( => {})` the promise and then count the reminder as sent.
 * A failed delivery therefore burned the claim: the access-review nudge was lost
 * for the whole MONTH, the weekly ones for the whole week, and the tick reported
 * them as sent.
 *
 * Releasing turns a permanent loss back into a retry on the next tick.
 * Duplicate-protection is untouched, because a claim is only ever released when
 * nothing was delivered. Same contract as jobs/cycle-nudge.js and
 * jobs/cert-expiry.js.
 */
async function release(kind, targetType, targetId, refId, period) {
    try {
        await db.run(
            `DELETE FROM reminder_log
              WHERE kind = ? AND target_type = ? AND target_id = ? AND ref_id = ? AND period = ?`,
            [kind, targetType, Number(targetId), Number(refId) || 0, period]
        );
    } catch (e) {
        console.error('[reminders] could not release the claim', kind, targetId, e && e.message);
    }
}

/**
 * True when a NotificationService result represents an actual delivery.
 * `notify` resolves with `{ inapp: 'error' }` on failure and the send helpers
 * below resolve with `null` when the call threw — both mean "not delivered".
 */
function delivered(result) {
    return !!result && result.inapp !== 'error';
}

/** notify that never throws and never lies: null means "not delivered". */
async function send(N, args) {
    try {
        const r = await N.notify(args);
        return delivered(r) ? r : null;
    } catch (_) {
        return null;
    }
}

/**
 * Resolve the notification kind to use, WITHOUT adding kinds to
 * NotificationService: a kind that has no KIND_META entry renders in the
 * notification centre with its raw string as the title. So we use `preferred`
 * only when the map really has it, and otherwise fall back to an existing kind
 * whose FR/EN title still reads correctly for this reminder.
 */
function kindFor(meta, preferred, fallback) {
    return meta && meta[preferred] ? preferred : fallback;
}

/**
 * In-app-only delivery for the talent nudges (no email path, no webhook
 * fan-out): confidential-adjacent content stays inside the app, and the daily
 * personal digest still surfaces it as ONE rollup mail.
 */
async function inApp(N, userId, kind, payload, userType = 'employee') {
    try {
        await N.enqueue({ userType, userId: Number(userId), kind, channel: 'inapp', payload });
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * The person's effective reviewer as a recipient { userType, id } — ACTIVE
 * supervisor → ACTIVE employee-manager → ACTIVE admin-manager (3.23.18 R2,
 * ReportingLineService). A departed supervisor is skipped, never addressed.
 */
async function supervisorOf(employeeId) {
    const r = await require('../services/ReportingLineService')
        .effectiveReviewer(employeeId)
        .catch(() => null);
    return r ? { userType: r.type, id: r.id } : null;
}

/**
 * Aggregate per-employee counts onto each person's LINE: the effective
 * reviewer, plus the manager (employee or admin) when `includeManager`. Only
 * ACTIVE recipients; never the subject. Returns Map 'type:id' → { userType, userId, ...counts }.
 */
async function aggregateOnLine(perEmployee, { includeManager }) {
    const RL = require('../services/ReportingLineService');
    const lines = await RL.lineRecipientsMany([...perEmployee.keys()], { includeManager });
    const out = new Map();
    for (const [empId, counts] of perEmployee) {
        for (const r of lines.get(empId) || []) {
            const key = `${r.userType}:${r.id}`;
            const cur = out.get(key) || { userType: r.userType, userId: r.id };
            for (const [k, v] of Object.entries(counts)) cur[k] = (cur[k] || 0) + (Number(v) || 0);
            out.set(key, cur);
        }
    }
    return out;
}

async function tick() {
    const now = new Date();
    const AppSettingsModel = require('../models/AppSettingsModel');
    // ---- SECTION accounts: scheduled departures are executed on the hour they are
    // due — BEFORE the daily hour gate below, because a leaver effective today
    // must not wait for the reminder hour. Idempotent (processed_at).
    let dueLeavers = 0;
    try {
        dueLeavers = await require('../services/LifecycleService').processDue();
    } catch (e) {
        console.error('[reminders] due lifecycle events failed', e && e.message);
    }
    // ---- end SECTION accounts
    let hour = ENV_HOUR;
    try {
        hour = Number(await AppSettingsModel.getValue('reminderHour', ENV_HOUR));
    } catch {
        /* default */
    }
    if (now.getHours() < hour) return { skipped: 'not_due', dueLeavers };

    const N = require('../services/NotificationService');
    const wk = weekBucket(now);
    const out = {
        idp: 0,
        lms: 0,
        survey: 0,
        access: 0,
        ninebox: 0,
        plans: 0,
        handover: 0,
        dueLeavers,
        dormant: 0,
    };

    // 1) IDP dual sign-off stalled (exactly one role signed, draft > 7 days).
    try {
        const rows = await db.all(
            `SELECT p.id AS idp_id, p.employee_id,
                    bool_or(s.role = 'employee')   AS emp_signed,
                    bool_or(s.role = 'supervisor') AS sup_signed
               FROM idp_plans p JOIN idp_signoffs s ON s.idp_id = p.id
               JOIN employees e ON e.id = p.employee_id AND e.is_active = true
              WHERE p.status = 'draft' AND p.updated_at < now() - interval '7 days'
              GROUP BY p.id, p.employee_id
             HAVING COUNT(DISTINCT s.role) = 1`
        );
        for (const r of rows) {
            const empId = Number(r.employeeId ?? r.employee_id);
            const empSigned = r.empSigned ?? r.emp_signed;
            // Employee signed → the LINE's signature is missing: the effective
            // reviewer (never a departed supervisor; an admin manager when that
            // is who holds the line).
            const recipient = empSigned
                ? await supervisorOf(empId)
                : { userType: 'employee', id: empId };
            const refId = r.idpId ?? r.idp_id;
            if (
                recipient &&
                recipient.id &&
                (await claim('idp.signoff', recipient.userType, recipient.id, refId, wk))
            ) {
                const ok = await send(N, {
                    userType: recipient.userType,
                    userId: recipient.id,
                    kind: 'idp.signoff_needed',
                    category: 'talent',
                    payload: { link: '/v2/idp' },
                });
                if (ok) out.idp++;
                else await release('idp.signoff', recipient.userType, recipient.id, refId, wk);
            }
        }
    } catch (_) {
        /* section best-effort */
    }

    // 2) LMS assigned but not started (> 7 days).
    try {
        const rows = await db.all(
            "SELECT id, employee_id FROM lms_enrollments WHERE status = 'assigned' AND created_at < now() - interval '7 days'"
        );
        for (const r of rows) {
            const empId = Number(r.employeeId ?? r.employee_id);
            if (empId && (await claim('lms.due', 'employee', empId, r.id, wk))) {
                const ok = await send(N, {
                    userType: 'employee',
                    userId: empId,
                    kind: 'lms.due',
                    category: 'talent',
                    payload: { link: '/employee/my-learning' },
                });
                if (ok) out.lms++;
                else await release('lms.due', 'employee', empId, r.id, wk);
            }
        }
    } catch (_) {
        /* best-effort */
    }

    // 3) Survey non-responders — survey-level weekly claim, then bulk fan-out.
    try {
        const surveys = await db.all(
            "SELECT id FROM surveys WHERE state = 'open' AND opened_at BETWEEN now() - interval '21 days' AND now() - interval '3 days'"
        );
        for (const s of surveys) {
            if (!(await claim('survey.respond', 'survey', s.id, 0, wk))) continue;
            const nonResp = await db.all(
                `SELECT e.id FROM employees e
                  WHERE e.is_active = true
                    AND NOT EXISTS (SELECT 1 FROM survey_responses r WHERE r.survey_id = ? AND r.employee_id = e.id)`,
                [s.id]
            );
            // Employee-facing: /v2/cap is manager/admin-only (requireManagerOrAdmin),
            // so the reminder used to land non-responders on /dashboard instead of
            // on the survey. "Mon évolution" is their survey surface.
            let n = 0;
            try {
                n = await N.enqueueBulkInApp({
                    userType: 'employee',
                    userIds: nonResp.map((e) => Number(e.id)),
                    kind: 'survey.respond',
                    payload: { link: '/employee/opportunities' },
                });
            } catch (_) {
                n = 0;
            }
            n = Number(n) || 0;
            // Non-responders existed but not one nudge landed → the survey's weekly
            // claim bought nothing; hand it back so the next tick retries.
            if (nonResp.length && !n) await release('survey.respond', 'survey', s.id, 0, wk);
            out.survey += n;
        }
    } catch (_) {
        /* best-effort */
    }

    // 4) Access-review overdue — monthly nudge to the reviewers (SuperAdmins).
    try {
        const mo = monthBucket(now);
        const admins = await db.all(
            "SELECT id FROM admins WHERE role = 'superadmin' AND COALESCE(is_active, true) = true"
        );
        for (const a of admins) {
            if (await claim('access.review', 'admin', a.id, 0, mo)) {
                // MONTHLY claim: burning this one loses the access review for the
                // entire month, which is why the release matters most here.
                const ok = await send(N, {
                    userType: 'admin',
                    userId: Number(a.id),
                    kind: 'access.review',
                    category: 'access',
                    payload: { link: '/admin/access-review' },
                });
                if (ok) out.access++;
                else await release('access.review', 'admin', a.id, 0, mo);
            }
        }
    } catch (_) {
        /* best-effort */
    }

    // 5) 9-box placements past the re-assessment cadence — the grid only ever
    //    showed a passive "due" badge, so a stale placement waited for someone to
    //    open the console. Nudge the MANAGER who owns the placement, once a week,
    //    with a COUNT (never a name or a box).
    const META = (() => {
        try {
            return N.KIND_META || {};
        } catch {
            return {};
        }
    })();
    try {
        let cadence = REASSESS_MONTHS_DEFAULT;
        try {
            cadence = Number(
                await AppSettingsModel.getValue('nineBoxReassessMonths', REASSESS_MONTHS_DEFAULT)
            );
        } catch {
            /* default */
        }
        if (!Number.isFinite(cadence) || cadence <= 0) cadence = REASSESS_MONTHS_DEFAULT;
        const rows = await db.all(
            `WITH latest AS (
                 SELECT DISTINCT ON (ev.employee_id)
                        ev.employee_id AS emp_id,
                        COALESCE(ev.approved_at, ev.updated_at) AS assessed_at
                   FROM nine_box_evaluations ev
                  WHERE ev.status = 'approved'
                  ORDER BY ev.employee_id, COALESCE(ev.approved_at, ev.updated_at) DESC
             )
             SELECT e.id AS emp_id
               FROM latest JOIN employees e ON e.id = latest.emp_id
              WHERE e.is_active = true
                AND assessed_at < now() - (? || ' months')::interval`,
            [cadence]
        );
        // A re-assessment is the REVIEWER's job: counted on the effective
        // reviewer (ACTIVE supervisor → employee-manager → admin-manager).
        const perEmp = new Map();
        for (const r of rows) {
            const id = Number(r.empId ?? r.emp_id);
            if (id) perEmp.set(id, { n: 1 });
        }
        const byRecipient = await aggregateOnLine(perEmp, { includeManager: false });
        const kind = kindFor(META, 'ninebox.reassess_due', 'ninebox.submitted');
        for (const c of byRecipient.values()) {
            const n = Number(c.n) || 0;
            if (!n) continue;
            if (await claim('ninebox.reassess', c.userType, c.userId, 0, wk)) {
                if (
                    await inApp(
                        N,
                        c.userId,
                        kind,
                        { link: '/talent/nine-box', count: n, cadenceMonths: cadence },
                        c.userType
                    )
                )
                    out.ninebox++;
                else await release('ninebox.reassess', c.userType, c.userId, 0, wk);
            }
        }
    } catch (_) {
        /* best-effort */
    }

    // 6) PIP / IDP follow-up — a PIP proposed but never activated, and PIP/IDP
    //    plans whose end date is near or past. Merged into ONE weekly per-manager
    //    notification (counts only) pointing at the manager talent console.
    try {
        // Counted PER EMPLOYEE first, then put on that person's LINE: the
        // effective reviewer AND the manager (employee or admin) — a stalled
        // PIP awaits the manager's validation, so the validator hears of it
        // even when a direct reviewer exists (3.23.18 R2). Leavers excluded.
        const perEmp = new Map();
        const bump = (id, key, n) => {
            const emp = Number(id);
            if (!emp || !n) return;
            const cur = perEmp.get(emp) || { pipStalled: 0, pipEnding: 0, idpEnding: 0 };
            cur[key] += Number(n) || 0;
            perEmp.set(emp, cur);
        };
        const pips = await db.all(
            `WITH open_pips AS (
                 SELECT p.employee_id AS emp_id,
                        p.state AS pip_state, p.created_at AS opened_at, p.ends_on AS ends_on
                   FROM pips p JOIN employees e ON e.id = p.employee_id
                  WHERE p.state IN ('proposed', 'approved', 'active') AND e.is_active = true
             )
             SELECT emp_id,
                    COUNT(*) FILTER (WHERE pip_state IN ('proposed', 'approved')
                                       AND opened_at < now() - (? || ' days')::interval)::int AS stalled,
                    COUNT(*) FILTER (WHERE ends_on IS NOT NULL
                                       AND ends_on <= (now() + (? || ' days')::interval)::date)::int AS ending
               FROM open_pips GROUP BY emp_id`,
            [PIP_STALLED_DAYS, PLAN_DUE_DAYS]
        );
        for (const r of pips) {
            bump(r.empId ?? r.emp_id, 'pipStalled', r.stalled);
            bump(r.empId ?? r.emp_id, 'pipEnding', r.ending);
        }
        // IDP: an objective's own due_on wins, else the plan's end date. Counted
        // per PLAN so a 5-objective plan is one item, not five.
        const idps = await db.all(
            `WITH due_plans AS (
                 SELECT p.employee_id AS emp_id, p.id AS plan_id
                   FROM idp_objectives o
                   JOIN idp_plans p ON p.id = o.idp_id
                   JOIN employees e ON e.id = p.employee_id
                  WHERE p.status IN ('draft', 'active')
                    AND o.state IN ('pending', 'in_progress')
                    AND e.is_active = true
                    AND COALESCE(o.due_on, p.ends_on) IS NOT NULL
                    AND COALESCE(o.due_on, p.ends_on) <= (now() + (? || ' days')::interval)::date
             )
             SELECT emp_id, COUNT(DISTINCT plan_id)::int AS n
               FROM due_plans GROUP BY emp_id`,
            [PLAN_DUE_DAYS]
        );
        for (const r of idps) bump(r.empId ?? r.emp_id, 'idpEnding', r.n);

        const byRecipient = await aggregateOnLine(perEmp, { includeManager: true });
        const kind = kindFor(META, 'talent.plan_due', 'cycle.escalation');
        for (const c of byRecipient.values()) {
            const counts = {
                pipStalled: c.pipStalled || 0,
                pipEnding: c.pipEnding || 0,
                idpEnding: c.idpEnding || 0,
            };
            const count = counts.pipStalled + counts.pipEnding + counts.idpEnding;
            if (!count) continue;
            if (await claim('talent.plan_due', c.userType, c.userId, 0, wk)) {
                if (
                    await inApp(
                        N,
                        c.userId,
                        kind,
                        { link: '/talent/actions', count, ...counts },
                        c.userType
                    )
                )
                    out.plans++;
                else await release('talent.plan_due', c.userType, c.userId, 0, wk);
            }
        }
    } catch (_) {
        /* best-effort */
    }

    // 7) Handover plans running out of road. A departure creates the plan
    //    automatically (LifecycleService._ensureHandover) — but nothing ever
    //    chased it, so the knowledge-continuity artefact the buyer bought the
    //    platform for sat open until someone happened to open /v2/continuity.
    //    Both accountable parties are nudged: the OWNING ADMIN (the FK the plan
    //    actually stores) and the outgoing person's MANAGER (who holds the
    //    operational reality). Aggregated per recipient — one weekly
    //    notification with counts, never one per plan.
    try {
        const HandoverService = require('../services/HandoverService');
        const rows = await HandoverService.listDue();
        const byRecipient = new Map(); // 'employee:42' -> { overdue, dueSoon, openItems }
        const bump = (type, id, overdue, openItems) => {
            const key = `${type}:${Number(id)}`;
            const cur = byRecipient.get(key) || {
                userType: type,
                userId: Number(id),
                overdue: 0,
                dueSoon: 0,
                openItems: 0,
            };
            if (overdue) cur.overdue++;
            else cur.dueSoon++;
            cur.openItems += Number(openItems) || 0;
            byRecipient.set(key, cur);
        };
        for (const r of rows) {
            const overdue = !!(r.isOverdue ?? r.is_overdue);
            const openItems = r.openItems ?? r.open_items;
            const ownerId = Number(r.ownerAdminId ?? r.owner_admin_id) || null;
            if (ownerId) bump('admin', ownerId, overdue, openItems);
            // The outgoing person's ACTIVE line (reviewer + manager, employee or
            // admin) — resolved by HandoverService.listDue. A recipient who is
            // also the owning admin is counted once.
            const line = Array.isArray(r.lineRecipients)
                ? r.lineRecipients
                : Number(r.managerId ?? r.manager_id)
                  ? [{ userType: 'employee', userId: Number(r.managerId ?? r.manager_id) }]
                  : [];
            for (const l of line) {
                if (l.userType === 'admin' && Number(l.userId) === ownerId) continue;
                bump(l.userType, l.userId, overdue, openItems);
            }
        }
        const kind = kindFor(META, 'handover.due', 'lifecycle.leaver');
        for (const c of byRecipient.values()) {
            const count = c.overdue + c.dueSoon;
            if (!count) continue;
            if (await claim('handover.due', c.userType, c.userId, 0, wk)) {
                // AWAITED: an un-awaited write races the pooled client and can
                // outlive the tick. A failure releases the claim instead of
                // silently consuming this recipient's weekly handover nudge.
                const ok = await send(N, {
                    userType: c.userType,
                    userId: c.userId,
                    kind,
                    category: 'lifecycle',
                    payload: {
                        link: '/v2/continuity',
                        count,
                        overdue: c.overdue,
                        dueSoon: c.dueSoon,
                        openItems: c.openItems,
                    },
                });
                if (ok) out.handover++;
                else await release('handover.due', c.userType, c.userId, 0, wk);
            }
        }
    } catch (_) {
        /* best-effort */
    }

    // ---- SECTION accounts: dormant accounts — a credential that exists but was
    //    never used for more than `dormantAccountDays` (default 30; App Setting,
    //    env DORMANT_ACCOUNT_DAYS fallback), or not used for that long. ONE
    //    monthly in-app notification per admin who can act on it (SuperAdmins
    //    and holders of reset_employee_password), carrying a COUNT and the
    //    console link — never a name. The claim is per admin per month, so a
    //    re-run of the tick is a no-op (claim-before-send, release on failure).
    try {
        let days = Number(process.env.DORMANT_ACCOUNT_DAYS) || 30;
        try {
            days = Number(await AppSettingsModel.getValue('dormantAccountDays', days)) || days;
        } catch {
            /* default */
        }
        const dormant = await db.get(
            `SELECT COUNT(*)::int AS n FROM employees e
              WHERE e.is_active AND e.erased_at IS NULL AND e.cancelled_at IS NULL
                AND e.password_hash IS NOT NULL AND COALESCE(e.is_account_active, false)
                AND COALESCE(e.last_login_at, e.invited_at, e.created_at) < now() - (? * interval '1 day')`,
            [days]
        );
        const n = Number(dormant && dormant.n) || 0;
        if (n) {
            const mo = monthBucket(now);
            const admins = await db.all(
                `SELECT a.id FROM admins a
                  WHERE COALESCE(a.is_active, true)
                    AND (a.role = 'superadmin' OR EXISTS (
                        SELECT 1 FROM admin_permissions p
                         WHERE p.admin_id = a.id AND p.permission = 'reset_employee_password'
                           AND (p.expires_at IS NULL OR p.expires_at > now())))`
            );
            const kind = kindFor(META, 'account.dormant', 'access.review');
            for (const a of admins) {
                if (await claim('account.dormant', 'admin', a.id, 0, mo)) {
                    const ok = await send(N, {
                        userType: 'admin',
                        userId: Number(a.id),
                        kind,
                        category: 'access',
                        payload: { link: '/admin/accounts?state=dormant', count: n, days },
                    });
                    if (ok) out.dormant++;
                    else await release('account.dormant', 'admin', a.id, 0, mo);
                }
            }
        }
    } catch (_) {
        /* best-effort */
    }
    // ---- end SECTION accounts

    // ---- SECTION access: a TIME-BOUND admin delegation about to run out. An
    //    expired grant is silent — the person simply starts getting refusals and
    //    the console used to read "jamais provisionné". Warn at 30, 7 and 1 day
    //    before the soonest expiry: the account itself (so it can ask) and every
    //    SuperAdmin (who can extend in one click). The claim period carries BOTH
    //    the threshold and the expiry date, so each of the three nudges fires
    //    exactly once per delegation, and moving the expiry re-arms them.
    out.accessExpiry = 0;
    try {
        const thresholds = [1, 7, 30]; // ascending: the first match is the tightest bucket
        const expiring = await db.all(
            `SELECT p.admin_id AS "adminId", MIN(p.expires_at) AS "nextExpiry", COUNT(*)::int AS n
               FROM admin_permissions p
               JOIN admins a ON a.id = p.admin_id AND COALESCE(a.is_active, true) = true
              WHERE p.revoked_at IS NULL
                AND p.expires_at IS NOT NULL
                AND p.expires_at > now()
                AND p.expires_at <= now() + interval '30 days'
              GROUP BY p.admin_id`
        );
        const supers = expiring.length
            ? await db.all(
                  "SELECT id FROM admins WHERE role = 'superadmin' AND COALESCE(is_active, true) = true"
              )
            : [];
        for (const row of expiring) {
            const when = new Date(row.nextExpiry);
            const daysLeft = Math.max(0, Math.ceil((when - now) / 86400000));
            const bucket = thresholds.find((t) => daysLeft <= t);
            if (!bucket) continue;
            const period = `${bucket}d:${when.toISOString().slice(0, 10)}`;
            const kind = kindFor(META, 'access.expiry', 'access.review');
            const subject = Number(row.adminId);
            const recipients = [subject, ...supers.map((s) => Number(s.id))].filter(
                (id, i, all) => all.indexOf(id) === i
            );
            for (const rid of recipients) {
                if (!(await claim('access.expiry', 'admin', rid, subject, period))) continue;
                const ok = await send(N, {
                    userType: 'admin',
                    userId: rid,
                    kind,
                    category: 'access',
                    payload: {
                        link: `/admins/${subject}`,
                        count: Number(row.n) || 0,
                        days: daysLeft,
                    },
                });
                if (ok) out.accessExpiry++;
                else await release('access.expiry', 'admin', rid, subject, period);
            }
        }
    } catch (_) {
        /* best-effort */
    }
    // ---- end SECTION access

    if (process.env.NODE_ENV !== 'test')
        console.log(
            `[reminders] idp:${out.idp} lms:${out.lms} survey:${out.survey} access:${out.access} ninebox:${out.ninebox} plans:${out.plans} handover:${out.handover} dueLeavers:${out.dueLeavers} dormant:${out.dormant} accessExpiry:${out.accessExpiry}`
        );
    return out;
}

// `claim`/`release`/`weekBucket`/`monthBucket`/`quarterBucket`/`yearBucket` are
// the shared exactly-once ledger primitives — see the header. Exported so
// succession-review, retention-recompute, planning-digest and the department
// brief (utils/periodWindow) reuse this implementation rather than copying it.
// `release` is part of the contract: a claim taken before a send that did not
// land MUST be handed back, or the reminder is lost for the whole period.
module.exports = {
    tick,
    claim,
    release,
    weekBucket,
    monthBucket,
    quarterBucket,
    yearBucket,
    delivered,
};
