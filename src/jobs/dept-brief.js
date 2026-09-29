'use strict';

/**
 * dept-brief — the periodic "Bilan de performance du département".
 *
 * One message per recipient per period: what is waiting for their signature,
 * what they must chase, what falls due before the next period, and — at the
 * BOTTOM — the measured state of their departments. The figures themselves are
 * computed by src/services/DeptBriefService (which owns every scoping and
 * rendering rule); this file owns the SCHEDULE, the exactly-once ledger, the
 * merge of overlapping cadences, the daily cap, the email rendering and the
 * delivery, and nothing else.
 *
 * The five things that go wrong in a job like this, and how each is closed:
 *
 *  1. FLOODING. Four cadences × three roles could hand somebody who is both a
 *     supervisor and an admin four messages on 1 January. Only the LONGEST due
 *     cadence is EMITTED (§4.7); the shorter buckets are still CLAIMED so they
 *     do not fire again at the next tick, and the emitted message names the
 *     windows it absorbed. On top of that a HARD cap of one brief per recipient
 *     per day (`digest.any` on reminder_log).
 *
 *  2. AN EMPTY BRIEF. A + B + C say nothing → nothing is sent (§5.4, the
 *     manager-digest precedent: "nothing to say — no noise mail"). The archive
 *     row is still written with is_empty = true so the SERIES stays complete and
 *     the page can say "rien à signaler" for that period.
 *
 *  3. DOUBLE SENDS ON A REPLAY. The claim is `INSERT … ON CONFLICT DO NOTHING
 *     RETURNING id` on the UNIQUE of dept_briefs — atomic, so a second leader, a
 *     reboot loop or three manual runs in a row produce exactly one brief. The
 *     ledger is dept_briefs and NOT reminder_log, which telemetry-prune deletes
 *     at 180 days: a yearly claim taken in January would be pruned in June and
 *     the "Bilan annuel" would go out again in July.
 *
 *  4. A HALF-DELIVERED RUN. Every recipient is calculated in its own read
 *     transaction and its own try/catch; a failure increments `errors` and the
 *     run continues. Claims are released IN BULK only when NOTHING landed, so a
 *     failure on 1 January cannot lose the week, the month, the quarter and the
 *     year at once — and a delivery that DID land (email sent, in-app insert
 *     failed) KEEPS its claim, because re-sending the email hourly to 33 people
 *     is worse than a lost bell (§5.1).
 *
 *  5. SMTP DOWN. The in-app line is the deliverable; the email is a courtesy.
 *     A failed send is counted (`emailFailed`), alerted once a day
 *     (`ops.job_failed`) and the brief stays readable on its page.
 *
 * Everything is UTC — the gate, the bucket and the bounds (§2.0 R7) — and every
 * query is SEQUENTIAL: a tick can be exercised from inside db.runTransaction
 * (probe, test, "Exécuter maintenant"), where all queries share ONE pg client
 * and a fan-out raises "client is already executing a query".
 */

const PRODUCT = require('../config/product');
const db = require('../config/database');
const { windowFor, daysSinceClose } = require('../utils/periodWindow');
const { fmtPeriodBound } = require('../utils/dateFormat');

const DAY = 86400000;
const HOUR = 3600000;

/** Longest first — §4.7: when several cadences fall due, the longest wins. */
const LONGEST_FIRST = ['yearly', 'quarterly', 'monthly', 'weekly'];

const CADENCE_LABEL = {
    weekly: { fr: 'hebdomadaire', en: 'weekly', unit: { fr: 'semaine', en: 'week' } },
    monthly: { fr: 'mensuel', en: 'monthly', unit: { fr: 'mois', en: 'month' } },
    quarterly: { fr: 'trimestriel', en: 'quarterly', unit: { fr: 'trimestre', en: 'quarter' } },
    yearly: { fr: 'annuel', en: 'yearly', unit: { fr: 'année', en: 'year' } },
};

// ---------------------------------------------------------------------------
// Settings (§6)
// ---------------------------------------------------------------------------

/**
 * House pattern (manager-digest.js:32-37): a settings exception must NEVER kill
 * a tick, and every number is Number.isFinite-checked before use.
 */
async function _settings() {
    const AppSettingsModel = require('../models/AppSettingsModel');
    const num = async (key, dflt) => {
        try {
            const v = Number(await AppSettingsModel.getValue(key, dflt));
            return Number.isFinite(v) ? v : dflt;
        } catch {
            return dflt;
        }
    };
    const str = async (key) => {
        try {
            const v = await AppSettingsModel.getValue(key, null);
            return v === null || v === undefined || String(v).trim() === ''
                ? null
                : String(v).trim();
        } catch {
            return null;
        }
    };
    const bool = async (key, dflt) => {
        try {
            const v = await AppSettingsModel.getValue(key, dflt);
            if (v === null || v === undefined || v === '') return dflt;
            return v === true || v === 'true' || v === 1 || v === '1';
        } catch {
            return dflt;
        }
    };
    return {
        enabled: {
            weekly: await bool('deptBriefWeeklyEnabled', true),
            monthly: await bool('deptBriefMonthlyEnabled', true),
            quarterly: await bool('deptBriefQuarterlyEnabled', true),
            yearly: await bool('deptBriefYearlyEnabled', true),
        },
        yearlySendEmpty: await bool('deptBriefYearlySendEmpty', true),
        hour: await num('deptBriefHour', 7), // UTC, deliberately
        weeklyDow: await num('deptBriefWeeklyDow', 1),
        dom: {
            monthly: await num('deptBriefMonthlyDom', 1),
            quarterly: await num('deptBriefQuarterlyDom', 1),
            yearly: await num('deptBriefYearlyDom', 1),
        },
        maxLines: await num('deptBriefMaxLines', 7),
        readRateFloorPct: await num('deptBriefReadRateFloorPct', 20),
        since: await str('deptBriefSince'),
        dataSince: await str('deptBriefDataSince'),
    };
}

/**
 * §2.1 — the anti-retroactive guard, written at the FIRST run that sends.
 *
 * `deptBriefSince` is the day the brief was switched on and `deptBriefDataSince`
 * the earliest performance action the database actually holds. A period that
 * starts before either is PARTIAL: it is published with a plain warning and with
 * every change figure suppressed, because comparing a full period against a
 * period the instance was not recording is how a fresh install manufactures a
 * collapse.
 */
async function _stampSince(settings) {
    const AppSettingsModel = require('../models/AppSettingsModel');
    const set = async (key, value, description) => {
        try {
            await AppSettingsModel.setValue(key, value, 'string', description, 'jobs', null);
        } catch {
            /* a settings write must never kill a tick */
        }
    };
    const today = new Date().toISOString().slice(0, 10);
    if (!settings.since) {
        await set('deptBriefSince', today, 'Date the department brief was switched on');
        settings.since = today;
    }
    if (!settings.dataSince) {
        let min = null;
        try {
            const r = await db.get('SELECT MIN(occurred_at) AS m FROM v_perf_actions');
            min = r && r.m ? new Date(r.m).toISOString().slice(0, 10) : today;
        } catch {
            min = today;
        }
        await set('deptBriefDataSince', min, 'Earliest usable performance-action date');
        settings.dataSince = min;
    }
    await set('deptBriefLastRunOn', today, 'Last date the department-brief tick ran');
}

/** The later of the two "we were not recording before this" marks, or null. */
function _dataFloor(settings) {
    const dates = [settings.since, settings.dataSince]
        .filter(Boolean)
        .map((d) => new Date(`${d}T00:00:00.000Z`))
        .filter((d) => !Number.isNaN(d.getTime()));
    if (!dates.length) return null;
    return new Date(Math.max(...dates.map((d) => d.getTime())));
}

/**
 * Flag a partial period and STRIP every delta from it (§2.1). Four honest words
 * beat a −100 % that only means "we were not here yet".
 */
function _markPartial(payload, floor) {
    if (!floor || new Date(payload.periodStart) >= floor) return payload;
    payload.partialPeriod = { since: floor.toISOString().slice(0, 10) };
    for (const l of (payload.flow && payload.flow.lines) || []) {
        l.delta = { state: 'suppressed', reason: 'partial_period', value: null, pct: null };
    }
    if (payload.deltas) {
        payload.deltas.d1 = {
            state: 'suppressed',
            reason: 'partial_period',
            value: null,
            pct: null,
        };
        payload.deltas.d5 = {
            state: 'suppressed',
            reason: 'partial_period',
            value: null,
            pct: null,
        };
    }
    return payload;
}

// ---------------------------------------------------------------------------
// The gate (§4.4) — the LEDGER decides, not the calendar
// ---------------------------------------------------------------------------

/**
 * The instant a closed period becomes due. `>=`, never `===`: the existing jobs
 * gate on a strict equality (`now.getDate !== dom → return`,
 * planning-digest.js:205) so a machine that was off on the due day skipped the
 * send for good — for the yearly cadence, for a year.
 */
function dueAt(cadence, win, settings) {
    if (cadence === 'weekly') {
        // periodEnd is a Monday 00:00 UTC by construction; shift to the chosen day.
        const offset = ((((Number(settings.weeklyDow) || 1) - 1) % 7) + 7) % 7;
        return new Date(win.periodEnd.getTime() + offset * DAY + settings.hour * HOUR);
    }
    const dom = Math.max(1, Number(settings.dom[cadence]) || 1);
    return new Date(win.periodEnd.getTime() + (dom - 1) * DAY + settings.hour * HOUR);
}

/**
 * Whether a recipient wants a cadence when they have expressed no preference.
 *
 * Weekly is OFF by default for EMPLOYEES because manager-digest already composes
 * exactly A1, A5, B1, C1, C2 and the footer for them every Monday (§4.8), and OFF
 * for superadmins who already receive cycle-deadline, access.review,
 * account.dormant and every ops.job_failed alert (§3.3). It is ON for scoped
 * admins, who receive no weekly message at all today.
 */
function defaultEnabled(cadence, recipient) {
    if (cadence !== 'weekly') return true;
    if (recipient.type === 'employee') return false;
    return String(recipient.role || '').toLowerCase() !== 'superadmin';
}

/**
 * Is this cadence due for this recipient, and why not when it is not.
 * Pure — no I/O — so the whole schedule is testable without a scheduler.
 */
function gateFor(cadence, now, { settings, prefs = {}, recipient }) {
    const win = windowFor(cadence, now);
    const out = {
        cadence,
        win,
        bucket: win.bucket,
        due: false,
        reason: null,
        dueAt: dueAt(cadence, win, settings),
    };
    if (!settings.enabled[cadence]) {
        out.reason = 'disabled';
        return out;
    }

    const pref = prefs[cadence];
    const wanted =
        pref === undefined || pref === null ? defaultEnabled(cadence, recipient) : Boolean(pref);
    if (!wanted) {
        // The hard guard of §4.8, kept as its own reason so the result can show
        // WHY an employee gets no weekly brief instead of looking broken.
        out.reason =
            cadence === 'weekly' && recipient.type === 'employee'
                ? 'covered_by_manager_digest'
                : 'pref_off';
        return out;
    }
    if (now < out.dueAt) {
        out.reason = 'not_due';
        return out;
    }
    // Catch-up window: a fresh install must not retro-send three years of briefs.
    if (daysSinceClose(win, now) > win.catchUpDays) {
        out.reason = 'too_late';
        return out;
    }
    out.due = true;
    return out;
}

/**
 * The window whose bucket IS `period`, found by walking back from `now` one
 * cadence at a time. Needed by the manual replay (`tick({ force, cadence,
 * period })`), which names a period that is not the one currently closing.
 * Bounded so a typo cannot spin.
 */
function _windowForPeriod(cadence, period, now) {
    const steps = { weekly: 60, monthly: 36, quarterly: 20, yearly: 10 }[cadence] || 12;
    let anchor = new Date(now.getTime());
    for (let i = 0; i <= steps; i++) {
        const win = windowFor(cadence, anchor);
        if (win.bucket === period) return win;
        // One period back, exactly: the instant before this period closed sits
        // inside the previous one, and windowFor snaps to the calendar boundary
        // again. Calendar arithmetic, never "the same number of days".
        anchor = new Date(win.periodEnd.getTime() - 1);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Recipients (§3)
// ---------------------------------------------------------------------------

/**
 * Everybody who may receive a brief, plus the governance holes worth publishing.
 *
 * Employees: supervisors and managers are two LINES of governance but ONE
 * recipient — findGovernedIds returns the same population for both, so the
 * DISTINCT query below cannot duplicate them. `username IS NOT NULL AND
 * is_account_active` is not cosmetic: employee 137 governs 16 people and their
 * login was stripped (house rule "strip the login, never void the person"), so
 * they cannot receive anything — they are excluded from the send and REPORTED as
 * `skipped.noAccount`, because a 16-person scope with no reachable owner is
 * itself a governance hole.
 *
 * An employee who also holds a linked ADMIN account is removed here and folded
 * into that admin's brief (§3.4): NotificationController.identity is
 * single-faced, so a second brief on the employee identity would be a bell they
 * could neither read nor silence while signed in as an admin.
 */
async function recipients({ only = null } = {}) {
    const out = { list: [], noAccount: [] };

    const linkedRows = await db.all(
        `SELECT id AS "adminId", linked_employee_id AS "employeeId"
           FROM admins WHERE is_active AND linked_employee_id IS NOT NULL`
    );
    const linkedByEmployee = new Map(
        linkedRows.map((r) => [Number(r.employeeId), Number(r.adminId)])
    );
    const linkedByAdmin = new Map(linkedRows.map((r) => [Number(r.adminId), Number(r.employeeId)]));

    const govs = await db.all(
        `SELECT DISTINCT m.id, m.first_name AS "firstName", m.email, m.username,
                m.is_account_active AS "accountActive"
           FROM employees m
           JOIN employees e ON (e.supervisor_id = m.id
                             OR (e.manager_id = m.id AND e.manager_type = 'employee'))
          WHERE m.is_active AND e.is_active
          ORDER BY m.id`
    );
    for (const g of govs) {
        const id = Number(g.id);
        if (!g.username || g.accountActive === false) {
            out.noAccount.push(id);
            continue;
        }
        if (linkedByEmployee.has(id)) continue; // folded into the admin identity
        out.list.push({
            type: 'employee',
            id,
            role: null,
            name: g.firstName || g.username,
            email: g.email || null,
        });
    }

    const admins = await db.all(
        `SELECT id, username, email, role::text AS role FROM admins WHERE is_active ORDER BY id`
    );
    for (const a of admins) {
        const id = Number(a.id);
        out.list.push({
            type: 'admin',
            id,
            role: a.role,
            name: a.username,
            email: a.email || null,
            // §3.4 — the governed sub-tree of the linked employee, rendered as a
            // SECOND labelled section of the same brief.
            teamOfEmployeeId: linkedByAdmin.has(id) ? linkedByAdmin.get(id) : null,
        });
    }

    if (only && only.userType && only.userId) {
        out.list = out.list.filter((r) => r.type === only.userType && r.id === Number(only.userId));
    }
    return out;
}

/** The recipient's cadence preferences, as `{ weekly: bool|undefined, … }`. */
async function _prefs(recipient) {
    const rows = await db.all(
        `SELECT cadence, enabled FROM dept_brief_prefs
          WHERE recipient_type = ? AND recipient_id = ?`,
        [recipient.type, Number(recipient.id)]
    );
    const out = {};
    for (const r of rows) out[r.cadence] = r.enabled !== false;
    return out;
}

// ---------------------------------------------------------------------------
// Claim / release — the ledger IS the archive (§4.5)
// ---------------------------------------------------------------------------

/**
 * Atomic claim. `RETURNING id` non-null = the claim is ours; null = somebody
 * (another leader, the previous tick, yesterday's run) already holds it.
 *
 * Deliberately NOT an App-Settings marker (`getValue` then `setValue`, the
 * manager-digest pattern): that is a read-then-write with no lock, and two
 * instances both read "not sent yet" and both send.
 */
/**
 * The headcount to archive. `dept_briefs.scope_size` is NOT NULL, so
 * a number has to be written — which is exactly why the null had to die at the
 * SOURCE (DeptBriefService.buildPayload resolves an unrestricted scope to the
 * roster population). This is the last-resort coercion for a payload built by an
 * older code path, and it is deliberately NOT `|| 0`: a missing measurement is
 * not a zero, so the page reads `scopeSignature === 'unrestricted'` to decide
 * what to say about it.
 */
function _scopeSizeOf(payload) {
    const n = Number(payload && payload.scopeSize);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function claimBrief(recipient, cadence, win, { signature, scopeSize, isEmpty, payload }) {
    const row = await db.get(
        `INSERT INTO dept_briefs (cadence, period, recipient_type, recipient_id, period_start, period_end,
                                  scope_signature, scope_size, is_empty, computed_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?)
         ON CONFLICT (cadence, period, recipient_type, recipient_id) DO NOTHING
         RETURNING id`,
        [
            cadence,
            win.bucket,
            recipient.type,
            Number(recipient.id),
            win.periodStart,
            win.periodEnd,
            signature,
            _scopeSizeOf({ scopeSize }),
            Boolean(isEmpty),
            JSON.stringify(payload),
        ]
    );
    return row ? Number(row.id) : null;
}

/** Hand back claims when NOTHING was delivered — in BULK (§4.6 step 10). */
async function releaseBriefs(ids) {
    for (const id of ids) {
        try {
            await db.run('DELETE FROM dept_briefs WHERE id = ?', [Number(id)]);
        } catch (e) {
            console.error('[dept-brief] could not release the claim', id, e && e.message);
        }
    }
}

/**
 * Supersede-by-archive (§5.1): the previous unread briefs of the same recipient
 * are marked read before the new one is written.
 *
 * telemetry-prune only deletes READ notifications, and 259 of the 262 rows on the
 * development database are unread — without this, 69 brief lines per person per
 * year pile up forever and the bell stops signalling anything at all, including a
 * dispute escalation. The archive table exists precisely so the bell can forget.
 */
async function supersede(recipient) {
    const r = await db.run(
        `UPDATE notifications SET read_at = now()
          WHERE user_type = ? AND user_id = ? AND channel = 'inapp'
            AND kind = 'dept_brief' AND read_at IS NULL`,
        [recipient.type, Number(recipient.id)]
    );
    return (r && r.changes) || 0;
}

// ---------------------------------------------------------------------------
// Rendering — BARE BLOCKS, never T.wrap (§5.2)
// ---------------------------------------------------------------------------

/**
 * Column headings for the per-line figures. A key with no entry here still
 * renders (humanised), so a new figure in DeptBriefService never disappears
 * silently from the email.
 */
const FIELD_LABELS = {
    count: { fr: 'Nombre', en: 'Count' },
    oldestAge: { fr: 'Plus ancien', en: 'Oldest' },
    age: { fr: 'Ancienneté', en: 'Age' },
    toActivate: { fr: 'À activer', en: 'To activate' },
    toCountersign: { fr: 'À contre-signer', en: 'To countersign' },
    ending: { fr: 'À échéance', en: 'Ending' },
    milestoneMissed: { fr: 'Jalon dépassé', en: 'Milestone missed' },
    noGovernance: { fr: 'Sans responsable', en: 'No manager' },
    adminAsManager: { fr: 'Responsable = admin', en: 'Manager is an admin' },
    notStarted: { fr: 'Non démarrés', en: 'Not started' },
    actions: { fr: 'Actions ouvertes', en: 'Open actions' },
    plans: { fr: 'Plans', en: 'Plans' },
    gaps: { fr: 'Écarts', en: 'Gaps' },
    state: { fr: 'État', en: 'State' },
    expired: { fr: 'Expirées', en: 'Expired' },
    expiringSoon: { fr: '0-30 j', en: '0-30 d' },
    expiringLater: { fr: 'Au-delà', en: 'Later' },
    expiring: { fr: 'À échéance', en: 'Expiring' },
    soleHolder: { fr: 'Détenteur unique', en: 'Sole holder' },
    noQualified: { fr: 'Aucun qualifié', en: 'None qualified' },
    breaches: { fr: 'Ruptures', en: 'Breaches' },
    predicted: { fr: 'Prévues', en: 'Predicted' },
    newlyHigh: { fr: 'Passages en risque élevé', en: 'Newly high risk' },
    d1Coverage: { fr: 'Couverture d’évaluation', en: 'Assessment coverage' },
    d2Readiness: { fr: 'Préparation moyenne', en: 'Average readiness' },
    d3Completion: { fr: 'Complétion de matrice', en: 'Matrix completion' },
    d3Met: { fr: 'Exigences atteintes', en: 'Requirements met' },
    d4Critical: { fr: 'Conformité critique', en: 'Critical compliance' },
    d5MeasuredPeople: { fr: 'Personnes mesurées', en: 'People measured' },
};

const SEVERITY_COLOR = { action: '#b45309', info: '#64748b' };
const GREY = '#64748b';

/**
 * The heading colour of a section.
 *
 * Amber ONLY when at least one rendered line carries a measured, non-zero
 * figure. A section whose every cell is an em dash — key-person exposure with
 * nothing ever assessed, certifications with no register — is UNKNOWN, and
 * unknown is grey. Painting it amber is the same mistake as dept-digest.js:132,
 * one level up: the colour would be chosen from the section's name instead of
 * from what was measured.
 */
function _sectionColor(section, lines) {
    if (section.severity === 'info') return GREY;
    const measured = lines.some((l) =>
        Object.values(l).some((v) => _isCell(v) && v.state === 'measured' && Number(v.value) > 0)
    );
    return measured ? SEVERITY_COLOR.action : GREY;
}

/** Is this value one of DeptBriefService's four display states? */
function _isCell(v) {
    return Boolean(v && typeof v === 'object' && v.text && typeof v.text.fr === 'string');
}

/**
 * the two certification buckets are named with the bounds the
 * section really used. `0-30 j` was hard-coded, so a WEEKLY brief (horizon 14 d)
 * labelled a 0–14 count « 0-30 j », and the third bucket was announced even when
 * the cadence left it no room.
 */
function _fieldLabel(key, section) {
    const b = section && section.buckets;
    if (b && key === 'expiringSoon') return { fr: `0-${b.soonMax} j`, en: `0-${b.soonMax} d` };
    if (b && key === 'expiringLater' && b.laterMax) {
        return { fr: `${b.soonMax + 1}-${b.laterMax} j`, en: `${b.soonMax + 1}-${b.laterMax} d` };
    }
    return FIELD_LABELS[key] || { fr: key, en: key };
}

/**
 * R8 sort: (1) past SLA, oldest first; (2) dated inside the horizon, nearest
 * first; (3) undated, biggest population first.
 *
 * Deliberately NOT `supervisor_reviews.priority_index`: that column reads
 * 0.0000 on all 136 rows and the service that was to fill it does not exist.
 */
function _rank(line, unitById) {
    const age =
        (_isCell(line.oldestAge) && line.oldestAge.value) ||
        (_isCell(line.age) && line.age.value) ||
        0;
    if (line.overdue) return [0, -Number(age || 0)];
    const dated =
        line.daysToExpiry !== undefined && line.daysToExpiry !== null
            ? Number(line.daysToExpiry)
            : null;
    if (dated !== null) return [1, dated];
    const u = unitById[line.unitId];
    return [2, -(u ? Number(u.headcount) || 0 : 0)];
}

function _cmp(a, b) {
    return a[0] - b[0] || a[1] - b[1];
}

/** One section rendered as a bilingual table: the unit, then its figures. */
function _sectionBlocks(T, section, lines) {
    const keys = [];
    for (const l of lines) {
        for (const [k, v] of Object.entries(l)) {
            if (_isCell(v) && !keys.includes(k)) keys.push(k);
        }
    }
    const blocks = [T.section(section.title.fr, section.title.en, _sectionColor(section, lines))];
    const headers = [{ fr: 'Unité', en: 'Unit' }, ...keys.map((k) => _fieldLabel(k, section))];
    const rows = lines.map((l) => {
        const label = l.label ? l.label.fr : l.skillName || '—';
        const first = { text: label, bold: true };
        const cells = keys.map((k) => {
            const c = l[k];
            if (!_isCell(c)) return '—';
            return {
                text: c.text.fr,
                color: c.color || undefined,
                bold: c.state === 'measured' && Number(c.value) > 0,
            };
        });
        return [first, ...cells];
    });
    blocks.push(T.table(headers, rows));
    // The notes are where "aucune règle définie" lives; dropping them is exactly
    // how "not governed" starts looking like "compliant".
    for (const l of lines) {
        if (l.note && l.note.fr) blocks.push(T.para(l.note.fr, l.note.en));
    }
    if (section.rule && section.rule.fr) {
        blocks.push(
            T.para(
                `Règle : ${section.rule.fr}${section.source ? ` — source : ${section.source}` : ''}`,
                `Rule: ${section.rule.en}${section.source ? ` — source: ${section.source}` : ''}`
            )
        );
    }
    return blocks;
}

/**
 * The A / B / C sections of ONE scope, capped at `maxLines` ACTION lines and
 * ordered by R8. A section left with no line is OMITTED, never rendered as "0";
 * what was dropped is COUNTED and stated, never silently lost.
 */
function _actionBlocks(T, p, { maxLines, unitById, base, accent }) {
    const pb = p.blocks || {};
    const sections = [...(pb.A || []), ...(pb.B || []), ...(pb.C || [])];
    const ranked = [];
    for (const s of sections) for (const l of s.lines) ranked.push({ s, l, r: _rank(l, unitById) });
    ranked.sort((a, b) => _cmp(a.r, b.r));
    const kept = new Set(ranked.slice(0, maxLines).map((x) => x.l));
    const omitted = Math.max(0, ranked.length - kept.size);

    const out = [];
    for (const s of sections) {
        const lines = s.lines.filter((l) => kept.has(l));
        if (!lines.length) continue;
        out.push(..._sectionBlocks(T, s, lines));
        if (s.cta && base) out.push(T.cta('Ouvrir', 'Open', base + s.cta, accent));
    }
    if (omitted > 0) {
        out.push(
            T.para(
                `+${omitted} autres actions — voir le bilan complet.`,
                `+${omitted} more actions — see the full brief.`
            )
        );
    }
    return out;
}

/** The measured state of ONE scope. */
function _footerBlocks(T, p) {
    if (!p.footer || !p.footer.units.length) return [];
    const keys = ['d1Coverage', 'd2Readiness', 'd3Completion', 'd4Critical', 'd5MeasuredPeople'];
    const out = [T.section('État mesuré', 'Measured state', GREY)];
    out.push(
        T.table(
            [{ fr: 'Unité', en: 'Unit' }, ...keys.map(_fieldLabel)],
            p.footer.units.map((u) => [
                { text: u.label.fr, bold: true },
                ...keys.map((k) => ({ text: u[k].text.fr, color: u[k].color || undefined })),
            ])
        )
    );
    const withoutReq = p.footer.units.filter((u) => u.withoutRequirements > 0);
    if (withoutReq.length) {
        const n = withoutReq.reduce((s, u) => s + u.withoutRequirements, 0);
        // The gap between the ROSTER and the requirement population: dept-digest
        // derives its headcount from v_employee_skill_gaps, i.e. from
        // REQUIREMENTS, so a person with no requirement simply is not there.
        out.push(
            T.para(
                `Dont ${n} personne(s) sans exigence définie.`,
                `Including ${n} person(s) with no requirement defined.`
            )
        );
    }
    return out;
}

/**
 * The email body, from the FROZEN payload and nothing else.
 *
 * PURE: no query, no clock, no `new Date` — which is what makes a `resend`
 * byte-identical to the original send, and what makes the whole rendering
 * testable with no database and no scheduler (the dept-digest.__test contract).
 *
 * BARE BLOCKS. The three existing digests hand NotificationService a COMPLETE
 * `<!doctype html>` document produced by emailTemplate.wrap, and _render
 * re-wraps it in _shell — so those emails ship a full HTML document nested
 * inside a table cell, with two brand headers and two footers. This one returns
 * the concatenated blocks and lets _shell dress them exactly once (AC-23).
 */
function renderBlocks(payload, opts = {}) {
    const T = require('../utils/emailTemplate');
    // A-07 — required here (not at module scope) for the same reason as `T`:
    // this file is loaded by the scheduler before the service graph is warm.
    const { resolveFlowTitle } = require('../services/DeptBriefService');
    const appName = opts.appName || PRODUCT.name;
    const accent = opts.accent || '#2563eb';
    const base = opts.baseUrl || '';
    const maxLines = Math.max(3, Math.min(12, Number(opts.maxLines) || 7));
    const cad = CADENCE_LABEL[payload.cadence] || CADENCE_LABEL.monthly;
    const unitById = {};
    for (const u of payload.units || []) unitById[u.unitId] = u;

    const startTxt = fmtPeriodBound(payload.periodStart);
    const endTxt = fmtPeriodBound(payload.displayEnd);
    const titleFr = `Bilan ${cad.fr} — ${cad.unit.fr} ${payload.period} (${startTxt} → ${endTxt} inclus)`;
    const titleEn = `${cad.en.charAt(0).toUpperCase()}${cad.en.slice(1)} brief — ${cad.unit.en} ${payload.period} (${startTxt} → ${endTxt} inclusive)`;

    const blocks = [];
    blocks.push(T.section(titleFr, titleEn, accent));

    // §4.7 — the absorbed windows are named in the header, never silently merged.
    if (Array.isArray(payload.absorbed) && payload.absorbed.length) {
        const list = payload.absorbed
            .map((a) => `${(CADENCE_LABEL[a.cadence] || cad).unit.fr} ${a.period}`)
            .join(', ');
        const listEn = payload.absorbed
            .map((a) => `${(CADENCE_LABEL[a.cadence] || cad).unit.en} ${a.period}`)
            .join(', ');
        blocks.push(T.para(`Inclut ${list}.`, `Includes ${listEn}.`));
    }
    if (payload.partialPeriod) {
        blocks.push(
            T.para(
                `Période partielle — données disponibles depuis le ${fmtPeriodBound(payload.partialPeriod.since)} : aucune évolution n’est publiée pour cette période.`,
                `Partial period — data available since ${fmtPeriodBound(payload.partialPeriod.since)}: no change figures are published for this period.`
            )
        );
    }
    if (opts.recomputedAt) {
        blocks.push(
            T.para(
                `Recalculé le ${fmtPeriodBound(opts.recomputedAt)} — peut différer de l’envoi initial.`,
                `Recomputed on ${fmtPeriodBound(opts.recomputedAt)} — may differ from the original send.`
            )
        );
    }

    // The units, each carrying its own population.
    for (const u of payload.units || []) blocks.push(T.para(u.label.fr, u.label.en));
    blocks.push(T.para(payload.natureOfFigures.fr, payload.natureOfFigures.en));

    // KPI chips — the five-second read, taken from the FOOTER totals.
    const totals = payload.footer && payload.footer.totals;
    if (totals) {
        blocks.push(
            T.kpis([
                {
                    label: 'Couverture d’évaluation / Assessment coverage',
                    value: totals.coverage.text.fr,
                    color: totals.coverage.color || undefined,
                },
                {
                    label: 'Personnes mesurées / People measured',
                    value: totals.measuredPeople.text.fr,
                    color: totals.measuredPeople.color || undefined,
                },
                {
                    label: 'Départements / Departments',
                    value: String(totals.departments),
                    sub: `${totals.contributingDepartments} avec exigences`,
                },
            ])
        );
    }

    // §3.4 — one human, one brief, TWO labelled sections. The employee governor
    // who also holds a linked admin account is folded onto the ADMIN identity, so
    // the two scopes must be told apart INSIDE the message, or the reader cannot
    // know which population a figure describes.
    if (payload.team)
        blocks.push(
            T.section('Votre périmètre d’administration', 'Your administration scope', accent)
        );

    // ---- A / B / C, capped at deptBriefMaxLines ACTION lines ----------
    blocks.push(..._actionBlocks(T, payload, { maxLines, unitById, base, accent }));

    // ---- FLOW (§2.6) — the only real window block --------------------------
    const flow = payload.flow;
    if (flow && flow.lines.length) {
        const nonZero = flow.lines.filter((l) => l.now > 0 || l.before > 0);
        if (nonZero.length) {
            blocks.push(
                T.section(
                    'Ce qui s’est passé pendant la période',
                    'What happened during the period',
                    accent
                )
            );
            blocks.push(
                T.table(
                    [
                        { fr: 'Indicateur', en: 'Indicator' },
                        {
                            fr: `Période (${flow.window.days} j)`,
                            en: `Period (${flow.window.days} d)`,
                        },
                        {
                            fr: `Période précédente (${flow.window.prevDays} j)`,
                            en: `Previous period (${flow.window.prevDays} d)`,
                        },
                        { fr: 'Évolution', en: 'Change' },
                    ],
                    nonZero.map((l) => [
                        // A-07 — the outgoing message publishes the SAME title as the
                        // page, recomputed from the line's metric. Twelve archived
                        // briefs froze « self_assessment ouverts »; a resend (or a
                        // catch-up run) would have posted the database token again.
                        { text: resolveFlowTitle(l).fr, bold: true },
                        String(l.now),
                        String(l.before),
                        _deltaText(l.delta),
                    ])
                )
            );
            if (!flow.window.sameLength) {
                blocks.push(
                    T.para(
                        `Les deux périodes n’ont pas la même longueur (${flow.window.days} j contre ${flow.window.prevDays} j) : les volumes sont publiés avec leur nombre de jours.`,
                        `The two periods are not the same length (${flow.window.days} d vs ${flow.window.prevDays} d): volumes are published with their day counts.`
                    )
                );
            }
            const imported = nonZero.find((l) => l.importBatch);
            if (imported) {
                blocks.push(
                    T.para(
                        `Inclut un import du ${fmtPeriodBound(imported.importBatch.minute)} (${imported.importBatch.share} % des faits sur la même minute) — évolution supprimée.`,
                        `Includes an import of ${fmtPeriodBound(imported.importBatch.minute)} (${imported.importBatch.share}% of the facts share one minute) — change suppressed.`
                    )
                );
            }
        }
        blocks.push(
            T.para(
                `Évaluations enregistrées : ${flow.assessmentsRecorded.text.fr} (${flow.assessmentsRecorded.rule.fr}).`,
                `Assessments recorded: ${flow.assessmentsRecorded.text.en} (${flow.assessmentsRecorded.rule.en}).`
            )
        );
    }

    // ---- FOOTER — the measured state, never at the top (§2.5) --------------
    blocks.push(..._footerBlocks(T, payload));

    // ---- The SECOND labelled section (§3.4), with its own units and figures.
    if (payload.team) {
        blocks.push(T.section('Votre équipe', 'Your team', accent));
        for (const u of payload.team.units || []) blocks.push(T.para(u.label.fr, u.label.en));
        const teamUnits = {};
        for (const u of payload.team.units || []) teamUnits[u.unitId] = u;
        blocks.push(
            ..._actionBlocks(T, payload.team, { maxLines, unitById: teamUnits, base, accent })
        );
        blocks.push(..._footerBlocks(T, payload.team));
    }

    // ---- Δ provenance (§2.7) ----------------------------------------------
    blocks.push(
        T.para(
            _deltaBasisText(payload.deltas, 'fr', cad),
            _deltaBasisText(payload.deltas, 'en', cad)
        )
    );

    if (base && payload.briefId) {
        blocks.push(
            T.cta(
                'Ouvrir le bilan complet',
                'Open the full brief',
                `${base}/reports/dept-brief/${payload.briefId}`,
                accent
            )
        );
    }
    blocks.push(
        T.para(
            'Gérer la fréquence de ce bilan : Mon compte → Notifications.',
            'Manage the frequency of this brief: My account → Notifications.'
        )
    );
    blocks.push(T.para(payload.disclaimer.fr, payload.disclaimer.en));
    blocks.push(
        T.para(
            `Chiffres figés au ${fmtPeriodBound(payload.computedAt)} — un recalcul ultérieur peut différer, les données de référence évoluent.`,
            `Figures frozen on ${fmtPeriodBound(payload.computedAt)} — a later recomputation may differ, the underlying data moves.`
        )
    );

    const subject = `${appName} — Bilan ${cad.fr} — ${payload.period}`;
    const text = _textOf(payload, cad, maxLines, unitById);
    return { subject, html: blocks.join(''), text };
}

/** An arrow only when the comparison is real; a WORD whenever it is not. */
function _deltaText(d) {
    if (!d) return '—';
    switch (d.state) {
        case 'value':
            return {
                text: `${d.value > 0 ? '+' : ''}${d.value}${d.pct === null ? '' : ` (${d.pct > 0 ? '+' : ''}${d.pct} %)`}`,
                color: d.color || undefined,
            };
        case 'stable':
            return 'stable';
        case 'first_measure':
            return 'première mesure';
        case 'measure_lost':
            return 'mesure perdue';
        case 'scope_changed':
            return 'périmètre modifié';
        case 'suppressed':
            return 'évolution supprimée';
        default:
            return 'évolution indisponible';
    }
}

function _deltaBasisText(deltas, lang, cad) {
    const start = deltas && deltas.seriesStart ? fmtPeriodBound(deltas.seriesStart) : null;
    if (lang === 'en') {
        if (deltas.basis === 'scope_changed')
            return 'Change not comparable — your scope changed between the two briefs.';
        if (!start) return 'First measured period — there is no comparison yet.';
        return `Your ${cad.en} brief series started on ${start}. Comparison is available from the second brief onwards.`;
    }
    if (deltas.basis === 'scope_changed')
        return 'Évolution non comparable — le périmètre a changé entre les deux bilans.';
    if (!start) return 'Première période mesurée — pas de comparaison.';
    return `La série de vos bilans ${cad.fr}s a commencé le ${start}. La comparaison est disponible à partir du deuxième bilan.`;
}

/** The plain-text twin. Same content, same cap, no markup. */
function _textOf(payload, cad, maxLines, unitById) {
    const out = [
        `Bilan ${cad.fr} — ${payload.period} (${fmtPeriodBound(payload.periodStart)} → ${fmtPeriodBound(payload.displayEnd)} inclus)`,
    ];
    for (const u of payload.units || []) out.push(u.label.fr);
    // « twin » means twin: the HTML part publishes the §2.1 sentence
    // right after the unit labels (:638) and the text part published NOTHING,
    // so a reader on a text-only client never learned what A, B and C mean nor
    // which day B was observed on. Same position, same sentence, same source.
    if (payload.natureOfFigures && payload.natureOfFigures.fr) out.push(payload.natureOfFigures.fr);
    const pb = payload.blocks || {};
    const sections = [...(pb.A || []), ...(pb.B || []), ...(pb.C || [])];
    const ranked = [];
    for (const s of sections) for (const l of s.lines) ranked.push({ s, l, r: _rank(l, unitById) });
    ranked.sort((a, b) => _cmp(a.r, b.r));
    for (const { s, l } of ranked.slice(0, maxLines)) {
        const figures = Object.entries(l)
            .filter(([, v]) => _isCell(v))
            .map(([k, v]) => `${_fieldLabel(k, s).fr} ${v.text.fr}`)
            .join(', ');
        out.push(`- [${s.id}] ${l.label ? l.label.fr : l.skillName || ''} : ${figures || '—'}`);
    }
    if (ranked.length > maxLines) out.push(`+${ranked.length - maxLines} autres actions.`);
    const t = payload.footer && payload.footer.totals;
    if (t)
        out.push(
            `État mesuré — couverture ${t.coverage.text.fr}, personnes mesurées ${t.measuredPeople.text.fr}.`
        );
    out.push(payload.disclaimer.fr);
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * "Did anything land?" — NOT reminders.delivered.
 *
 * That helper reads `!!r && r.inapp !== 'error'`, but _notify keeps going after
 * an in-app insert failure (NotificationService.js:117-124 sets inapp='error' and
 * does not return), so `{ inapp:'error', email:'sent' }` would release the claim
 * and re-send the SAME brief at the next tick — hourly, to every recipient.
 */
function landed(r) {
    return Boolean(r) && (r.inapp !== 'error' || r.email === 'sent');
}

/**
 * Send one brief. Weekly is IN-APP ONLY (enqueue writes one row and attempts no
 * email at all); the other three go through notify, which writes the bell line
 * first and then decides about the email.
 *
 * The notification payload is `{ cadence, period, briefId, link }` and NOTHING
 * else: NotificationService._notify fans every event out to
 * WebhookService.emit BEFORE the in-app write, before the tier, before the
 * opt-out and before the category — with no scope and no clearance check. Every
 * figure lives in subject/html/text, which the webhook never sees.
 */
async function deliver(recipient, cadence, payload, rendered, { inAppOnly }) {
    const NotificationService = require('../services/NotificationService');
    const notifPayload = {
        cadence,
        period: payload.period,
        briefId: payload.briefId,
        link: `/reports/dept-brief/${payload.briefId}`,
    };
    if (inAppOnly) {
        const r = await NotificationService.enqueue({
            userType: recipient.type,
            userId: Number(recipient.id),
            kind: 'dept_brief',
            channel: 'inapp',
            payload: notifPayload,
        });
        // `{ skipped:'disabled' }` is the recipient's own preference, not a
        // failure: the claim stays, or we would retry it every hour forever.
        return {
            inapp: r && r.skipped ? r.skipped : (r && r.state) || 'queued',
            email: 'inapp_only',
        };
    }
    return NotificationService.notify({
        userType: recipient.type,
        userId: Number(recipient.id),
        kind: 'dept_brief',
        category: 'digest',
        payload: notifPayload,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
    });
}

/**
 * A shared mailbox must not receive somebody else's figures. Since migration 107
 * one address may legitimately belong to several accounts (a departmental inbox
 * included), and the flows that assumed "one address = one account" must REFUSE
 * the ambiguity instead of guessing. NotificationService._resolveRecipient
 * consults none of this, so the check happens here, before the send.
 */
async function _sharedMailbox(recipient) {
    if (!recipient.email) return false;
    try {
        const EmailAccountsService = require('../services/EmailAccountsService');
        const accounts = await EmailAccountsService.accountsWithEmail(recipient.email);
        return accounts.filter((a) => a.isActive).length > 1;
    } catch {
        return false;
    }
}

/** The read rate of the PREVIOUS period of a cadence (§9 AC-24, the stop rule). */
async function _readRate(cadence, win) {
    try {
        const r = await db.get(
            `SELECT count(*) FILTER (WHERE read_at IS NOT NULL)::int AS "read", count(*)::int AS n
               FROM notifications
              WHERE kind = 'dept_brief' AND channel = 'inapp'
                AND payload->>'cadence' = ? AND created_at >= ? AND created_at < ?`,
            [cadence, win.prevStart, win.prevEnd]
        );
        if (!r || !Number(r.n)) return null; // no previous period → not measured, NOT 0 %
        return Math.round((1000 * Number(r.read)) / Number(r.n)) / 10;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

function _emptyResult(now) {
    return {
        cadence: null,
        period: null,
        recipients: 0,
        sent: 0,
        empty: 0,
        superseded: 0,
        emailFailed: 0,
        errors: 0,
        coverage: null,
        readRatePct: null,
        capHit: [],
        leader: process.env.REDIS_URL ? 'bullmq' : 'inproc',
        at: fmtPeriodBound(now),
        skipped: {
            notDue: 0,
            noAccount: [],
            noScope: 0,
            sharedMailbox: [],
            tooLate: 0,
            dailyCap: 0,
            optedOut: 0,
            prefOff: 0,
        },
    };
}

/** Keep the result under JobRunService.finish's 4 KB ceiling (AC-13). */
function _compact(result) {
    const cap = (a) =>
        Array.isArray(a) && a.length > 20 ? [...a.slice(0, 20), `+${a.length - 20}`] : a;
    result.skipped.noAccount = cap(result.skipped.noAccount);
    result.skipped.sharedMailbox = cap(result.skipped.sharedMailbox);
    result.capHit = cap(result.capHit);
    return result;
}

async function tick({
    force = false,
    cadence = null,
    period = null,
    resend = null,
    only = null,
} = {}) {
    const now = new Date();
    const result = _emptyResult(now);
    if (resend) return _resendOne(resend, result);

    const settings = await _settings();

    // 3. The email category is evaluated BEFORE any claim — the explicit lesson of
    //    personal-digest.js:28-39 ("Claiming first burned the day"). It does NOT
    //    suppress the brief: the in-app line is the deliverable and the email is a
    //    courtesy (§3.6, §5.1). Gating the whole job on it would make the brief
    //    invisible on every instance with SMTP off — which is this development box
    //    and the appliance today. It is reported so a reader of /admin/health can
    //    see that no email could have gone out.
    try {
        result.emailCategory = await require('../services/EmailService').isCategoryEnabled(
            'digest'
        );
    } catch {
        result.emailCategory = null;
    }

    const { list, noAccount } = await recipients({ only });
    result.skipped.noAccount = noAccount;
    result.recipients = list.length;

    const wanted = cadence ? [cadence] : LONGEST_FIRST;
    const covered = new Set();
    let coversEveryone = false;
    let anyDue = false;

    for (const recipient of list) {
        try {
            const prefs = await _prefs(recipient);
            // 1-2. Which cadences are DUE for this person?
            const gates = [];
            for (const c of LONGEST_FIRST) {
                if (!wanted.includes(c)) continue;
                const natural = gateFor(c, now, { settings, prefs, recipient });
                if (!period) {
                    gates.push(natural);
                    continue;
                }
                // An explicitly named period: only that bucket is considered, and
                // it is only sent when it is naturally due — unless `force`.
                const win = _windowForPeriod(c, period, now);
                if (!win) continue;
                const g = { ...natural, win, bucket: win.bucket, dueAt: dueAt(c, win, settings) };
                if (natural.bucket !== win.bucket) {
                    g.due = false;
                    g.reason = 'not_due';
                }
                if (force) {
                    g.due = true;
                    g.reason = 'forced';
                }
                gates.push(g);
            }
            const due = gates.filter((g) => g.due);
            if (!due.length) {
                const why = gates.map((g) => g.reason);
                if (why.includes('too_late')) result.skipped.tooLate++;
                else if (why.includes('covered_by_manager_digest') || why.includes('pref_off'))
                    result.skipped.prefOff++;
                else result.skipped.notDue++;
                continue;
            }
            if (!anyDue) {
                // Stamped before the FIRST brief is built, so that brief already
                // knows whether its period predates the data (§2.1).
                anyDue = true;
                await _stampSince(settings);
            }
            const emitted = due[0]; // LONGEST_FIRST ⇒ [0] is the longest
            result.cadence = result.cadence || emitted.cadence;
            result.period = result.period || emitted.bucket;

            const one = await _oneRecipient(recipient, due, emitted, {
                settings,
                force,
                result,
                covered,
                now,
            });
            if (one && one.coversEveryone) coversEveryone = true;
        } catch (e) {
            result.errors++;
            console.error(
                `[dept-brief] recipient ${recipient.type}:${recipient.id} failed:`,
                e && e.message
            );
        }
    }

    if (!anyDue) return _compact(result);

    // §3.5 — publish the COVERAGE hole: 15 of the 76 active employees have
    // neither a supervisor nor a manager, so they fall into nobody's brief. That
    // gap must be visible, not guessed.
    try {
        const t = await db.get('SELECT count(*)::int AS n FROM employees WHERE is_active');
        const total = Number(t.n);
        result.coverage = `${coversEveryone ? total : covered.size}/${total}`;
    } catch {
        /* coverage is reporting, never a reason to fail a tick */
    }
    if (result.cadence) {
        result.readRatePct = await _readRate(result.cadence, windowFor(result.cadence, now));
        if (result.readRatePct !== null && result.readRatePct < settings.readRateFloorPct) {
            result.readRateBelowFloor = true; // §9 AC-24 — the written-down stop rule
        }
    }
    // AC-14 — a partial failure is reported ONCE a day, never swallowed.
    if (result.errors > 0) {
        try {
            await require('../services/JobRunService').alert(
                'ops.job_failed',
                `dept-brief:partial:${result.period}`,
                {
                    tick: 'dept-brief.tick',
                    errors: result.errors,
                    period: result.period,
                    link: '/admin/health',
                }
            );
        } catch {
            /* alerting must not fail the tick */
        }
    }
    return _compact(result);
}

/**
 * One recipient, in the order §4.6 imposes: CALCULATE, then claim, then the
 * daily cap, then supersede, then send, and release in bulk only if nothing
 * landed. dept-digest.js:231-236 does the opposite — claims, computes, then
 * `if (!rows.length) continue;` — so a subscriber whose scope is momentarily
 * empty burns up to a MONTH with no send and no release.
 */
async function _oneRecipient(recipient, due, emitted, { settings, force, result, covered, now }) {
    const DeptBriefService = require('../services/DeptBriefService');

    // 4. The whole calculation inside ONE read transaction, then COMMIT. Sending
    //    from inside it would post the email before the commit, and computing
    //    outside one would produce a torn read ("0 enrolled" next to "36
    //    self-assessments submitted").
    const built = await db.runTransaction(async () => {
        const scope = await DeptBriefService.scopeOf(recipient);
        // §3.2 — an admin with NO live scope is not silently skipped (the current
        // `if (!rows.length) continue;` is indistinguishable from an outage):
        // they get a one-line in-app notice, at most once per period, and NO
        // archive row.
        if (recipient.type === 'admin' && Array.isArray(scope.ids) && scope.ids.length === 0) {
            return { noScope: true };
        }
        const payloads = [];
        for (const g of due) {
            payloads.push({
                gate: g,
                payload: await DeptBriefService.buildPayload(recipient, g.cadence, g.win, {
                    scope,
                }),
            });
        }
        // §3.4 — an employee governor with a linked admin account gets ONE brief,
        // on the ADMIN identity, carrying a second labelled section computed on
        // their governed sub-tree.
        let team = null;
        if (recipient.teamOfEmployeeId) {
            const teamScope = await DeptBriefService.scopeOf({
                type: 'employee',
                id: recipient.teamOfEmployeeId,
            });
            team = {
                scope: teamScope,
                payload: await DeptBriefService.buildPayload(
                    { type: 'employee', id: recipient.teamOfEmployeeId },
                    emitted.cadence,
                    emitted.win,
                    { scope: teamScope }
                ),
            };
        }
        return { scope, payloads, team };
    });

    if (built.noScope) {
        result.skipped.noScope++;
        await _noScopeNotice(recipient, emitted);
        return { coversEveryone: false };
    }
    // An unrestricted scope (superadmin) covers the whole active population; an
    // empty id list from a scoped reader means NOTHING, never "everything".
    const out = { coversEveryone: Boolean(built.scope.unrestricted) };
    for (const id of built.scope.ids || []) covered.add(Number(id));
    if (built.team) for (const id of built.team.scope.ids || []) covered.add(Number(id));

    // 5. Claim EVERY due bucket. Claiming only the emitted one would let the
    //    shorter cadences fire again at the next tick.
    const claimed = [];
    let emittedRow = null;
    const floor = _dataFloor(settings);
    for (const p of built.payloads) {
        const isEmitted = p.gate.cadence === emitted.cadence;
        const payload = _markPartial(
            isEmitted ? _mergePayload(p.payload, built) : p.payload,
            floor
        );
        const signature = built.team
            ? DeptBriefService.scopeSignature([
                  ...(built.scope.ids || []),
                  ...(built.team.scope.ids || []),
              ])
            : payload.scopeSignature;
        // the archived headcount comes from the PAYLOAD, which now
        // resolves an unrestricted scope to its real population. `scope.size ||
        // 0` turned the superadmin's `null` into a 0 the page then printed as
        // « Effectif retenu 0 » beside « Ensemble 76 ».
        let id = await claimBrief(recipient, p.gate.cadence, p.gate.win, {
            signature,
            scopeSize: payload.scopeSize,
            isEmpty: payload.isEmpty,
            payload,
        });
        if (!id && force) {
            // AC-12 third case: an explicit force writes a NEW VERSION over the
            // existing row (new computed_at) — it never silently does nothing.
            const row = await db.get(
                `UPDATE dept_briefs SET payload = ?, computed_at = now(), is_empty = ?, scope_signature = ?, scope_size = ?
                  WHERE cadence = ? AND period = ? AND recipient_type = ? AND recipient_id = ? RETURNING id`,
                [
                    JSON.stringify(payload),
                    Boolean(payload.isEmpty),
                    signature,
                    _scopeSizeOf(payload),
                    p.gate.cadence,
                    p.gate.win.bucket,
                    recipient.type,
                    Number(recipient.id),
                ]
            );
            id = row ? Number(row.id) : null;
            if (id) {
                p.recomputed = true;
            }
        }
        if (!id) continue; // already claimed — somebody else sent it
        // Only rows this run INSERTED may ever be released. A forced run UPDATES a
        // row that already existed: releasing that one would DELETE an archived
        // brief somebody has already received — the archive is the deliverable,
        // and nothing in this job may destroy one.
        if (!p.recomputed) claimed.push(id);
        if (isEmitted) {
            emittedRow = { id, payload, gate: p.gate, recomputed: Boolean(p.recomputed) };
        }
    }
    if (!emittedRow) return out; // the emitted bucket was already claimed

    emittedRow.payload.briefId = emittedRow.id;
    emittedRow.payload.absorbed = built.payloads
        .filter((p) => p.gate.cadence !== emitted.cadence)
        .map((p) => ({
            cadence: p.gate.cadence,
            period: p.gate.win.bucket,
            days: p.gate.win.days,
            lines: (p.payload.flow.lines || []).map((l) => ({
                metric: l.metric,
                title: l.title,
                now: l.now,
            })),
        }));

    // §5.4 — an empty brief is ARCHIVED but not SENT. Three months of messages
    // that say nothing teaches people to stop opening the one that does.
    const sendEmpty = emitted.cadence === 'yearly' && settings.yearlySendEmpty;
    if (emittedRow.payload.isEmpty && !sendEmpty) {
        result.empty++;
        await db.run('UPDATE dept_briefs SET payload = ? WHERE id = ?', [
            JSON.stringify(emittedRow.payload),
            emittedRow.id,
        ]);
        return out; // claims are KEPT: the period is done
    }

    // 7. The hard cap: at most ONE summary message per recipient per day, all
    //    sources together. Monday already carries the weekly reminders (00:05),
    //    cycle-nudge (:45), succession-review (:55) and manager_digest (07:20).
    const reminders = require('./reminders');
    const dayBucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    // A FORCED run is an explicit human action, already recorded in job_runs and
    // in the system log: it bypasses the daily cap, or the "Renvoyer un bilan"
    // button would silently do nothing for the rest of the day of the first send.
    const capOk =
        force ||
        (await reminders.claim('digest.any', recipient.type, Number(recipient.id), 0, dayBucket));
    if (!capOk) {
        result.skipped.dailyCap++;
        await releaseBriefs(claimed); // retried at the next run, not lost
        return out;
    }

    try {
        result.superseded += await supersede(recipient);

        const branding = await _branding();
        const T = require('../utils/emailTemplate');
        const rendered = renderBlocks(emittedRow.payload, {
            appName: branding.appName,
            accent: branding.accent,
            baseUrl: T.baseUrl(),
            maxLines: settings.maxLines,
            recomputedAt: emittedRow.recomputed ? new Date() : null,
        });

        // Weekly is IN-APP ONLY (§5.2): ≤ 12 emails per person per year.
        let inAppOnly = emitted.cadence === 'weekly';
        if (!inAppOnly && (await _sharedMailbox(recipient))) {
            result.skipped.sharedMailbox.push(`${recipient.type}:${recipient.id}`);
            inAppOnly = true;
        }

        const r = await deliver(recipient, emitted.cadence, emittedRow.payload, rendered, {
            inAppOnly,
        });
        await db.run('UPDATE dept_briefs SET payload = ?, sent_at = now() WHERE id = ?', [
            JSON.stringify(emittedRow.payload),
            emittedRow.id,
        ]);

        if (r && r.email === 'failed') result.emailFailed++;
        if (r && (r.inapp === 'disabled' || r.email === 'user_opt_out')) result.skipped.optedOut++;

        if (!landed(r)) {
            await releaseBriefs(claimed);
            if (!force)
                await reminders.release(
                    'digest.any',
                    recipient.type,
                    Number(recipient.id),
                    0,
                    dayBucket
                );
            result.errors++;
            return out;
        }
        if (r.inapp === 'error') {
            // The email DID go out. Re-sending it every hour is worse than a lost
            // bell, so the claim stays and the loss is alerted instead.
            try {
                await require('../services/JobRunService').alert(
                    'ops.job_failed',
                    `dept-brief:inapp:${emittedRow.payload.period}`,
                    {
                        tick: 'dept-brief.tick',
                        recipient: `${recipient.type}:${recipient.id}`,
                        link: '/admin/health',
                    }
                );
            } catch {
                /* best effort */
            }
        }
        result.sent++;
        // C0 logs the departments where KeyPersonRiskService.sweep hit its
        // hard-coded limit of 1000 rows WITHOUT raising: the figure is a floor,
        // not a count, and the tick says so.
        const c0 = ((emittedRow.payload.blocks && emittedRow.payload.blocks.C) || []).find(
            (s2) => s2.id === 'C0'
        );
        if (c0 && Array.isArray(c0.capHit) && c0.capHit.length) result.capHit.push(...c0.capHit);
    } catch (e) {
        // 10. Nothing landed → release ALL the claims, not just the emitted one.
        await releaseBriefs(claimed);
        if (!force)
            await reminders
                .release('digest.any', recipient.type, Number(recipient.id), 0, dayBucket)
                .catch(() => {});
        throw e;
    }
    return out;
}

/** The linked-employee section (§3.4), folded into the admin's own payload. */
function _mergePayload(payload, built) {
    if (!built.team) return payload;
    return {
        ...payload,
        sections: [
            {
                kind: 'admin',
                label: { fr: 'Votre périmètre d’administration', en: 'Your administration scope' },
            },
            { kind: 'team', label: { fr: 'Votre équipe', en: 'Your team' } },
        ],
        team: built.team.payload,
        isEmpty: payload.isEmpty && built.team.payload.isEmpty,
    };
}

/**
 * §3.2 — "Aucun périmètre actif ne vous est attribué". One in-app line, at most
 * once per period, and NO archive row: there is nothing to archive, and a silent
 * skip cannot be told apart from a broken job.
 */
async function _noScopeNotice(recipient, emitted) {
    const reminders = require('./reminders');
    if (
        !(await reminders.claim(
            'dept_brief.noscope',
            recipient.type,
            Number(recipient.id),
            0,
            emitted.bucket
        ))
    )
        return;
    try {
        const NotificationService = require('../services/NotificationService');
        await NotificationService.enqueue({
            userType: recipient.type,
            userId: Number(recipient.id),
            kind: 'dept_brief',
            channel: 'inapp',
            payload: {
                cadence: emitted.cadence,
                period: emitted.bucket,
                briefId: null,
                link: '/admin/access-review',
            },
        });
    } catch (e) {
        await reminders.release(
            'dept_brief.noscope',
            recipient.type,
            Number(recipient.id),
            0,
            emitted.bucket
        );
        throw e;
    }
}

/**
 * AC-12 second case: re-send an ARCHIVED brief exactly as it was — reading the
 * frozen payload, never recomputing. The rendering is pure, so the HTML is
 * identical to the original send.
 */
async function _resendOne({ cadence, period, only }, result) {
    result.cadence = cadence || null;
    result.period = period || null;
    if (!cadence || !period || !only || !only.userType || !only.userId) {
        result.skipped.notDue++;
        result.reason = 'resend_needs_cadence_period_and_recipient';
        return _compact(result);
    }
    const row = await db.get(
        `SELECT id, payload, is_empty AS "isEmpty" FROM dept_briefs
          WHERE cadence = ? AND period = ? AND recipient_type = ? AND recipient_id = ?`,
        [cadence, period, only.userType, Number(only.userId)]
    );
    if (!row) {
        result.reason = 'no_archived_brief';
        return _compact(result);
    }

    // the replay goes through the SAME render-time repair as the
    // page (DeptBriefController.loadForReader), on the same copy, for the same
    // reason A-07 recomputes the flow titles here: a replay must not re-publish
    // a sentence that is already known to be false. The seven archived briefs
    // carrying `A1.oldestAge = -13` would otherwise e-mail « Le plus ancien :
    // -13 jour » a second time. Nothing is recomputed and nothing is written:
    // the repair is a pure function of the archived payload, so two replays of
    // the same archive still produce byte-identical HTML.
    const { repairFrozenPayload } = require('../services/DeptBriefService');
    const payload = repairFrozenPayload(
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    );
    payload.briefId = Number(row.id);
    const branding = await _branding();
    const T = require('../utils/emailTemplate');
    const settings = await _settings();
    const rendered = renderBlocks(payload, {
        appName: branding.appName,
        accent: branding.accent,
        baseUrl: T.baseUrl(),
        maxLines: settings.maxLines,
    });
    const recipient = { type: only.userType, id: Number(only.userId) };
    // §5.1 and §4.6 step 8: BEFORE inserting an in-app line, mark
    // the recipient's previous unread ones read. The nominal loop does it
    // (:1064); this manual path skipped it, so every click on « Renvoyer un
    // bilan » left a second unread bell line pointing at the same brief. The
    // archive is what lets the bell forget — an unread pile is exactly what the
    // rule was written to prevent.
    result.superseded += await supersede(recipient);
    const r = await deliver(recipient, cadence, payload, rendered, {
        inAppOnly: cadence === 'weekly',
    });
    result.recipients = 1;
    if (landed(r)) result.sent++;
    else result.errors++;
    if (r && r.email === 'failed') result.emailFailed++;
    result.resent = true;
    return _compact(result);
}

/** Branding for the email — the two shapes of the house brand object (§5.2). */
async function _branding() {
    try {
        const b = await require('../utils/branding').getBranding();
        return {
            appName: (b && b.appName) || PRODUCT.name,
            accent: (b && (b.accentColor || b.accent)) || '#2563eb',
        };
    } catch {
        return { appName: PRODUCT.name, accent: PRODUCT.accentColor };
    }
}

// `tick` is the job surface. `__test` exposes the schedule and the rendering so
// both can be asserted with no scheduler and no database — the same contract as
// dept-digest.__test and planning-digest.__test.
module.exports = {
    tick,
    __test: { renderBlocks, gateFor, recipients, landed, defaultEnabled, dueAt },
};
