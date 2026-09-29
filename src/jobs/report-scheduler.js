'use strict';

/**
 * report-scheduler — runs due report_schedules and emails the CSV.
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
    const EmailService = require('../services/EmailService');
    let status = 'ok';
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
            ReportBuilderService.exportToCSV(rows, rows.columns || config.selectedFields) ||
                'no data'
        );
        const stamp = now.toISOString().slice(0, 10);
        const recipients = String(s.recipients || '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);

        const result = await EmailService.send({
            to: recipients.join(', '),
            subject: `[IDevelop] Scheduled report: ${s.templateName} — ${stamp}`,
            html: `<p>Attached is the scheduled report <strong>${String(s.templateName).replace(/[<>&]/g, '')}</strong> (${rows.length} row${rows.length === 1 ? '' : 's'}, generated ${stamp}).</p><p>Frequency: ${s.frequency}. Manage schedules under Reports &rarr; Schedules.</p>`,
            attachments: [
                {
                    filename: `${String(s.templateName).replace(/[^\w.-]+/g, '_')}-${stamp}.csv`,
                    content: csv,
                    // Explicit charset: without it a mail client may re-encode
                    // the body and undo the BOM the file just gained.
                    contentType: 'text/csv; charset=utf-8',
                },
            ],
        });
        if (!result.sent) status = 'email_failed: ' + (result.error || result.skipped || 'unknown');
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
    // daily-deduplicated alert the backup and job watchdogs raise.
    if (status !== 'ok') {
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

module.exports = { tick, runOne, loadSchedule, nextRunAt, creatorUserType, resolveCreator };
