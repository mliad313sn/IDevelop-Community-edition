'use strict';

/**
 * report-scheduler — runs due report_schedules, keeps ONE in-app copy of each
 * run and tells the schedule's ACCOUNT recipients that it is ready (SA-38: no
 * attachment, no typed address; see "recipients are accounts" below).
 *
 * A schedule is DUE when it is active, hasn't already run today (last_run_at),
 * the current hour has reached its configured hour, and (weekly) today matches
 * day_of_week / (monthly) today is the 1st. The report executes headlessly with
 * the CREATOR's RBAC identity ({id, role}) so the recipients only ever receive
 * data the scheduling user was allowed to see. Per-schedule failures are recorded
 * in last_status and never abort the tick.
 */

const db = require('../config/database');

/**
 * The identity type the schedule replays under. creator_type (migration 102) is
 * authoritative; a row read on a database that has not applied it yet falls back
 * to the migration's own backfill rule on creator_role, erring towards the
 * narrower (employee) clearance.
 */
function creatorUserType(s) {
    const t = s.creatorType != null ? s.creatorType : s.creator_type;
    if (t === 'admin') return 'admin';
    if (t === 'employee') return 'manager';
    const role = s.creatorRole != null ? s.creatorRole : s.creator_role;
    return ['superadmin', 'viewer'].includes(role) ? 'admin' : 'manager';
}

/**
 * The creator's CURRENT account, re-read at every run (3.23.17, B-4).
 *
 * The replay used to trust the snapshot stored on the schedule
 * (`creator_role`): a local admin demoted — or deactivated — after scheduling
 * kept receiving data under the clearance they no longer held, and a stored
 * 'superadmin' role replayed as unrestricted forever. The identity is now the
 * live row: its current role (admins) and its active state. Anything that
 * cannot be resolved to an ACTIVE account returns null and the run is skipped.
 *
 * @returns {Promise<{id:number, role:string|null, userType:string}|null>}
 */
async function resolveCreator(s) {
    const id = s.createdBy != null ? s.createdBy : s.created_by;
    if (id == null) return null;
    const type = creatorUserType(s);
    if (type === 'admin') {
        const a = await db.get('SELECT id, role, is_active FROM admins WHERE id = ?', [Number(id)]);
        if (!a || a.isActive === false || a.is_active === false) return null;
        return { id: Number(a.id), role: a.role || null, userType: type };
    }
    const e = await db.get('SELECT id, is_active, cancelled_at FROM employees WHERE id = ?', [
        Number(id),
    ]);
    if (!e || e.isActive === false || e.is_active === false || e.cancelledAt || e.cancelled_at)
        return null;
    // An employee creator never carries an admin role; their scope is their
    // CURRENT governed sub-tree (rbacScope.scopedEmployeeIds), empty if they no
    // longer govern anyone.
    return { id: Number(e.id), role: null, userType: 'manager' };
}

// ---------------------------------------------------------------------------
// SA-38 — recipients are ACCOUNTS (migration 172)
// ---------------------------------------------------------------------------
//
// A schedule is delivered only to accounts of the application (an admin or an
// employee id, never a typed address), and only to an account whose CURRENT
// clearance covers the report: the report runs under its creator's scope, so a
// recipient must be able to see at least every person the creator can. The
// same check runs when the schedule is written (400 otherwise), at every run
// (an under-cleared recipient is skipped and the status says so), and when the
// in-app copy is downloaded (403 otherwise). The mail never carries the data:
// it links to the in-app copy.

const ACCOUNT_TOKEN = /^(admin|employee):(\d{1,10})$/;
const MAX_RECIPIENTS = 20;

/** 'admin' | 'employee' — the account kind an identity is stored under. */
function accountTypeOf(user) {
    return user && user.userType === 'admin' ? 'admin' : 'employee';
}

/**
 * The LIVE identity of an account, as the scope resolver needs it, or null
 * when the account is unknown or no longer active. An employee account reads
 * reports only while it governs at least one person (the test that makes a
 * session 'manager', the only employee kind admitted to /reports).
 */
async function accountActor(type, id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (type === 'admin') {
        const a = await db.get('SELECT id, role, is_active FROM admins WHERE id = ?', [n]);
        if (!a || a.isActive === false || a.is_active === false) return null;
        return { id: Number(a.id), role: a.role || null, userType: type };
    }
    if (type !== 'employee') return null;
    const e = await db.get(
        'SELECT id, is_active, cancelled_at, erased_at FROM employees WHERE id = ?',
        [n]
    );
    if (
        !e ||
        e.isActive === false ||
        e.is_active === false ||
        e.cancelledAt ||
        e.cancelled_at ||
        e.erasedAt ||
        e.erased_at
    )
        return null;
    const EmployeeModel = require('../models/EmployeeModel');
    if (!(await EmployeeModel.governsAnyone(n))) return null;
    return { id: n, role: null, userType: 'manager' };
}

/**
 * The employee ids an identity may see (null = unrestricted), through the
 * report's own resolver. `cache` (a Map, one per request or per run) resolves
 * each identity once.
 */
async function scopeOf(actor, cache = null) {
    const { scopedEmployeeIds } = require('../utils/rbacScope');
    if (!cache) return scopedEmployeeIds(actor);
    const key = `${actor && actor.userType}:${actor && actor.id}:${(actor && actor.role) || ''}`;
    if (!cache.has(key)) cache.set(key, scopedEmployeeIds(actor));
    return cache.get(key);
}

/** An admin role that sees everyone (scopedEmployeeIds → null). */
function isUnrestricted(actor) {
    return !!(actor && actor.userType === 'admin' && actor.role === 'superadmin');
}

/**
 * Does a reader's scope cover a report's scope? null = unrestricted. An
 * unrestricted report is covered only by an unrestricted reader; otherwise
 * every person in the report must be visible to the reader.
 */
function covers(readerScope, reportScope) {
    if (readerScope === null) return true;
    if (reportScope === null || reportScope === undefined) return false;
    const mine = new Set((readerScope || []).map(Number));
    return (reportScope || []).every((id) => mine.has(Number(id)));
}

/** 'admin:12' / 'employee:34' tokens from a form value (array or comma list). */
function parseAccountTokens(v) {
    const raw = Array.isArray(v) ? v : v == null ? [] : String(v).split(',');
    return raw.map((x) => String(x).trim()).filter(Boolean);
}

/** Does the legacy free-text field carry anything at all (a typed address)? */
function hasTypedAddress(v) {
    const raw = Array.isArray(v) ? v.join(',') : String(v == null ? '' : v);
    return raw.trim() !== '';
}

/**
 * Validate a proposed recipient list against the creator's report scope.
 * @returns {Promise<{ok:true, accounts:Array<{type,id}>} |
 *                   {ok:false, code:string, refused?:string[]}>}
 */
async function validateRecipients({ recipients, recipientAccounts }, creator, { cache } = {}) {
    const memo = cache || new Map();
    // A typed address is refused outright, whatever it is.
    if (hasTypedAddress(recipients)) return { ok: false, code: 'outside_address' };
    const tokens = parseAccountTokens(recipientAccounts);
    if (!tokens.length) return { ok: false, code: 'no_recipient' };
    if (tokens.some((t) => t.includes('@'))) return { ok: false, code: 'outside_address' };
    const bad = tokens.filter((t) => !ACCOUNT_TOKEN.test(t));
    if (bad.length) return { ok: false, code: 'not_an_account', refused: bad };
    const uniq = [...new Set(tokens)];
    if (uniq.length > MAX_RECIPIENTS) return { ok: false, code: 'too_many' };
    const reportScope = await scopeOf(creator, memo);
    const refused = [];
    const accounts = [];
    for (const t of uniq) {
        const [, type, id] = ACCOUNT_TOKEN.exec(t);
        const actor = await accountActor(type, id);
        if (!actor || !covers(await scopeOf(actor, memo), reportScope)) {
            refused.push(t);
            continue;
        }
        accounts.push({ type, id: Number(id) });
    }
    if (refused.length) return { ok: false, code: 'under_cleared', refused };
    return { ok: true, accounts };
}

/**
 * The accounts that may be offered as recipients to this creator: active
 * admins and active managers whose clearance covers the creator's scope.
 * @returns {Promise<Array<{token:string, type:string, id:number, name:string}>>}
 */
async function eligibleAccounts(creator, { cache } = {}) {
    const memo = cache || new Map();
    const reportScope = await scopeOf(creator, memo);
    // An unrestricted report is covered only by an unrestricted reader: nobody
    // else needs their scope resolved at all.
    const canCover = async (actor) =>
        reportScope === null
            ? isUnrestricted(actor)
            : covers(await scopeOf(actor, memo).catch(() => []), reportScope);
    const { personNameSql } = require('../utils/personName');
    const admins = await db.all(
        `SELECT id, username AS name, role FROM admins
          WHERE COALESCE(is_active, true) = true ORDER BY username`
    );
    const managers = await db.all(
        `SELECT e.id, ${personNameSql('e')} AS name
           FROM employees e
          WHERE e.is_active AND e.cancelled_at IS NULL AND e.erased_at IS NULL
            AND EXISTS (SELECT 1 FROM employees r
                         WHERE r.is_active
                           AND (r.supervisor_id = e.id OR (r.manager_id = e.id AND r.manager_type = 'employee')))
          ORDER BY 2`
    );
    const out = [];
    for (const a of admins || []) {
        const actor = { userType: 'admin', id: Number(a.id), role: a.role || null };
        if (await canCover(actor))
            out.push({ token: `admin:${a.id}`, type: 'admin', id: Number(a.id), name: a.name });
    }
    for (const m of managers || []) {
        const actor = { id: Number(m.id), role: null, userType: 'manager' };
        if (await canCover(actor))
            out.push({
                token: `employee:${m.id}`,
                type: 'employee',
                id: Number(m.id),
                name: m.name,
            });
    }
    return out;
}

/** The schedule's current account recipients (removed ones excluded). */
async function recipientsOf(scheduleId) {
    return db.all(
        `SELECT recipient_type AS "type", recipient_id AS "id"
           FROM report_schedule_recipients
          WHERE schedule_id = ? AND removed_at IS NULL
          ORDER BY id`,
        [Number(scheduleId)]
    );
}

/**
 * Replace a schedule's recipient list. Nothing is deleted: a recipient taken
 * off is stamped removed_at; one put back is revived.
 */
async function setRecipients(scheduleId, accounts) {
    const sid = Number(scheduleId);
    const keep = accounts.map((a) => `${a.type}:${a.id}`);
    await db.run(
        `UPDATE report_schedule_recipients SET removed_at = now()
          WHERE schedule_id = ? AND removed_at IS NULL
            AND NOT ((recipient_type || ':' || recipient_id) = ANY(?))`,
        [sid, keep]
    );
    for (const a of accounts) {
        await db.run(
            `INSERT INTO report_schedule_recipients (schedule_id, recipient_type, recipient_id)
             VALUES (?, ?, ?)
             ON CONFLICT (schedule_id, recipient_type, recipient_id) DO UPDATE SET removed_at = NULL`,
            [sid, a.type, Number(a.id)]
        );
    }
}

/**
 * Tell ONE recipient account that a run is ready, through the notification
 * service: an in-app row and, when e-mail is on for that person, a mail in the
 * standard notification layout, WITHOUT attachment, whose only call to action
 * is the in-app copy (access re-checked on download). Quiet hours and opt-outs
 * apply.
 */
async function deliverTo(actor, { schedule, runId }) {
    const NotificationService = require('../services/NotificationService');
    const link = `/reports/schedules/runs/${Number(runId)}`;
    return NotificationService.notify({
        userType: accountTypeOf(actor),
        userId: actor.id,
        kind: 'report.schedule_ready',
        payload: {
            scheduleId: Number(schedule.id),
            runId: Number(runId),
            report: String(schedule.templateName || '').slice(0, 120),
            link,
        },
    });
}

/** The joined row `runOne` needs, by schedule id. */
async function loadSchedule(id) {
    return db.get(
        `SELECT s.*, t.name AS template_name, t.data_source, t.selected_fields, t.filters, t.sorting, t.group_by
           FROM report_schedules s
           JOIN report_templates t ON t.id = s.template_id
          WHERE s.id = ?`,
        [Number(id)]
    );
}

/**
 * Next moment this schedule is due. The tick fires every 15 min and
 * gates on hour/day, so "next" is the next calendar slot at or after its hour
 * that has not already run today. Null for an inactive schedule — a paused one
 * has no next run, and saying "—" is the honest answer.
 */
function nextRunAt(s, now = new Date()) {
    if (!(s.isActive != null ? s.isActive : s.is_active)) return null;
    if (s.enabled === false) return null;
    const hour = Number(s.hour != null ? s.hour : 6);
    const freq = s.frequency || 'weekly';
    const dow = Number(
        s.dayOfWeek != null ? s.dayOfWeek : s.day_of_week != null ? s.day_of_week : 1
    );
    const lastRun = s.lastRunAt || s.last_run_at || null;
    const ranToday = lastRun && new Date(lastRun).toDateString() === now.toDateString();
    const at = (d) => {
        const x = new Date(d);
        x.setHours(hour, 0, 0, 0);
        return x;
    };
    for (let i = 0; i <= 366; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        const slot = at(d);
        if (i === 0 && (ranToday || slot.getTime() <= now.getTime())) continue;
        if (freq === 'daily') return slot;
        if (freq === 'weekly' && d.getDay() === dow) return slot;
        if (freq === 'monthly' && d.getDate() === 1) return slot;
    }
    return null;
}

/**
 * Run ONE schedule and record its outcome, exactly as the tick does. Shared by
 * the scheduled path and by "Exécuter maintenant" so a manual run can never
 * behave differently from the real one.
 */
async function runOne(s, now = new Date()) {
    const ReportBuilderService = require('../services/ReportBuilderService');
    let status = 'ok';
    // Suspended BY THE SYSTEM (typed addresses, migration 172): never run,
    // whoever asks (the tick filters it; "run now" lands here).
    if (s.enabled === false) {
        status = `skipped: disabled (${s.disabledReason || s.disabled_reason || 'no reason'})`;
        await db
            .run('UPDATE report_schedules SET last_status = ? WHERE id = ?', [status, s.id])
            .catch(() => {});
        return status;
    }
    // Re-resolve the creator BEFORE anything runs; unknown or inactive ⇒ no
    // report is built, nothing is sent, and the row says why.
    let user = null;
    try {
        user = await resolveCreator(s);
    } catch (e) {
        user = null;
    }
    if (!user) {
        status = 'skipped: creator_inactive';
        await db
            .run('UPDATE report_schedules SET last_run_at = now(), last_status = ? WHERE id = ?', [
                status,
                s.id,
            ])
            .catch(() => {
                /* status write is best-effort */
            });
        try {
            await require('../services/LogService').log({
                action: 'REPORT_SCHEDULE_SKIPPED',
                entityType: 'report_schedule',
                entityId: Number(s.id),
                details: `Schedule #${s.id} not run: its creator (${creatorUserType(s)} #${s.createdBy != null ? s.createdBy : s.created_by}) is unknown or no longer active.`,
            });
        } catch {
            /* the trail must never break the tick */
        }
        return status;
    }
    try {
        const parse = (v, fb) => {
            if (v == null) return fb;
            if (typeof v === 'object') return v;
            try {
                return JSON.parse(v);
            } catch {
                return fb;
            }
        };
        const config = {
            dataSource: s.dataSource,
            selectedFields: parse(s.selectedFields, []),
            filters: parse(s.filters, {}),
            sorting: parse(s.sorting, {}),
            groupBy: s.groupBy || null,
        };
        // Headless RBAC identity: the schedule creator's snapshot — of the
        // creator's OWN identity type (migration 102, creator_type). created_by
        // is an employees.id for a manager and an admins.id for an admin; the
        // hardcoded userType 'admin' scoped a manager's schedule to nothing
        // (empty CSV, status ok) or, on an id collision, to an unrelated
        // admin's clearance. An employee creator replays as 'manager' — the
        // only employee kind allowed to schedule (requireManagerOrAdmin).
        // `user` is the LIVE account resolved above — never the stored role.
        const rows = await ReportBuilderService.executeReport(config, user);
        // Same Excel treatment as the interactive download (sendCsv):
        // UTF-8 BOM so "Lambért"/"Lindqvïst" arrive intact instead of
        // "KaborÃ©", plus the `sep=,` hint so fr-FR Excel — whose default
        // list separator is ';' — splits the columns instead of dumping
        // every row into column A. The attachment carried the raw body
        // before, so the same report was correct when downloaded and
        // mojibake when e-mailed.
        // Columns are the RESOLVED, whitelisted list executeReport actually
        // selected (incl. the forced coverage/provenance columns), never the
        // template's raw selectedFields — see ReportBuilderService.exportToCSV.
        const csv = ReportBuilderService.excelCsv(
            ReportBuilderService.exportToCSV(rows, rows.columns || config.selectedFields) || ''
        );
        const stamp = now.toISOString().slice(0, 10);

        // SA-38: recipients are ACCOUNTS, each re-checked NOW against the scope
        // this report was produced under.
        const memo = new Map();
        const reportScope = await scopeOf(user, memo);
        const listed = await recipientsOf(s.id);
        const eligible = [];
        let refused = 0;
        for (const r of listed) {
            const actor = await accountActor(r.type, r.id);
            if (actor && covers(await scopeOf(actor, memo), reportScope)) eligible.push(actor);
            else refused++;
        }
        if (!eligible.length) {
            status = listed.length
                ? 'skipped: no_recipient_with_covering_clearance'
                : 'skipped: no_account_recipient';
        } else {
            // The in-app copy every notice links to. Its download re-checks the
            // reader's CURRENT scope against `scope_ids`.
            const run = await db.get(
                `INSERT INTO report_schedule_runs (schedule_id, row_count, scope_ids, filename, content)
                 VALUES (?, ?, CAST(? AS jsonb), ?, ?) RETURNING id`,
                [
                    s.id,
                    rows.length,
                    JSON.stringify(reportScope === null ? null : reportScope.map(Number)),
                    `${String(s.templateName).replace(/[^\w.-]+/g, '_')}-${stamp}.csv`,
                    csv,
                ]
            );
            let failed = 0;
            for (const actor of eligible) {
                const out = await deliverTo(actor, { schedule: s, runId: run.id });
                if (
                    !out ||
                    out.inapp === 'error' ||
                    out.email === 'error' ||
                    out.email === 'failed'
                )
                    failed++;
            }
            if (failed) status = `email_failed: ${failed}/${eligible.length}`;
            else if (refused)
                status = `partial: ${refused} recipient(s) without covering clearance`;
        }
    } catch (e) {
        status = 'error: ' + String(e.message).slice(0, 200);
    }
    await db
        .run('UPDATE report_schedules SET last_run_at = now(), last_status = ? WHERE id = ?', [
            status,
            s.id,
        ])
        .catch(() => {
            /* status write is best-effort */
        });
    // A delivery failure is an ops event, not a console line: the same
    // daily-deduplicated alert the backup and job watchdogs raise. A run that
    // had nobody cleared to receive it is not a mail failure: its status says
    // so on the schedules page.
    if (/^(email_failed|error)/.test(status)) {
        try {
            await require('../services/JobRunService').alert(
                'ops.smtp_failed',
                `schedule:${s.id}`,
                { scheduleId: s.id, status, link: '/reports/schedules' }
            );
        } catch {
            /* best-effort */
        }
    }
    return status;
}

async function tick() {
    const now = new Date();
    const hour = now.getHours();
    const dow = now.getDay(); // 0=Sunday
    const dom = now.getDate();

    const due = await db.all(
        `SELECT s.*, t.name AS template_name, t.data_source, t.selected_fields, t.filters, t.sorting, t.group_by
           FROM report_schedules s
           JOIN report_templates t ON t.id = s.template_id
          WHERE s.is_active = true
            AND s.enabled = true
            AND (s.last_run_at IS NULL OR s.last_run_at::date < now()::date)
            AND s.hour <= ?
            AND (s.frequency = 'daily'
                 OR (s.frequency = 'weekly'  AND COALESCE(s.day_of_week, 1) = ?)
                 OR (s.frequency = 'monthly' AND ? = 1))`,
        [hour, dow, dom]
    );
    if (!due.length) return { ran: 0 };

    let ran = 0;
    for (const s of due) {
        await runOne(s, now);
        ran++;
    }
    return { ran };
}

module.exports = {
    tick,
    runOne,
    loadSchedule,
    nextRunAt,
    creatorUserType,
    resolveCreator,
    // SA-38: account recipients
    accountActor,
    accountTypeOf,
    scopeOf,
    covers,
    validateRecipients,
    eligibleAccounts,
    recipientsOf,
    setRecipients,
    deliverTo,
    MAX_RECIPIENTS,
};
