'use strict';

/**
 * PersonaDigestService — the « What changed » digests (migration 187).
 *
 * OPT-IN. Nothing is written or sent until an administrator switches
 * `personaDigestsEnabled` on (App Settings → Scheduled jobs; off by default on
 * every install). The existing weekly manager digest and the department
 * digests are untouched: a manager keeps the manager digest and gets no second
 * weekly team message from here.
 *
 * Who gets what:
 *   administrator accounts   « What changed » in the units their clearance
 *                            covers WHOLE (the organisation, else whole sites,
 *                            else whole departments; at most 3), over 30 days
 *                            for a SuperAdmin or a viewer (archived as
 *                            'executive') and 7 days otherwise ('hr'), plus
 *                            « To do » counts read live; what each line is
 *                            about follows the account's dashboard capabilities
 *                            and the organisation's modules;
 *   employees (not managers) ONE next step (EmployeeHomeService), IN-APP ONLY.
 *
 * RULES
 *   - Fixed templates (locales/{fr,en}/dash.json `nar_*`), figures formatted
 *     in the recipient's language. Never a person's name, never a rating.
 *   - Links go to the lists behind the figures (/dashboard/list), which check
 *     the reader's clearance again when opened.
 *   - Archived in persona_digests (the in-app page /digests/:id works with
 *     SMTP off). Nothing changed AND nothing to do: NO message, the period is
 *     archived 'silent' so it is never evaluated again.
 *   - Read-rate rule: eight digests in a row left unopened step the cadence
 *     down (daily → weekly → off), with an in-app notice and « Restore » on
 *     /digests. « Opened » = the archived page was opened or the notification
 *     link was followed (notifications.opened_at).
 */

const db = require('../config/database');
const Narrative = require('./NarrativeService');
const { fmtNum } = require('../utils/kpiFormat');

const { phrase } = Narrative;
const EMPLOYEE_TEXT = {
    fr: require('../../locales/fr/employee.json'),
    en: require('../../locales/en/employee.json'),
};

const PERSONAS = Object.freeze(['executive', 'hr', 'manager', 'employee']);
const CADENCES = Object.freeze(['daily', 'weekly', 'off']);
const DEFAULT_CADENCE = 'weekly';
const UNOPENED_LIMIT = 8;
const MAX_UNITS = 3;
const KIND_PREFIX = 'digest.persona.';
const PAUSED_KIND = 'digest.persona.paused';
const SETTING = 'personaDigestsEnabled';

const kindOf = (persona) => KIND_PREFIX + persona;
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const pad = (n) => String(n).padStart(2, '0');
/** LOCAL calendar day: the same clock as the hour / day-of-week gate. */
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The digest window: daily 1 day; weekly 7 days, 30 for the executive label. */
function windowDays(persona, cadence) {
    if (cadence === 'daily') return 1;
    return persona === 'executive' ? 30 : 7;
}

function titleKey(persona, days) {
    if (persona === 'employee') return 'nar_dg_title_employee';
    if (days <= 1) return 'nar_dg_title_day';
    if (days >= 28) return 'nar_dg_title_month';
    return 'nar_dg_title_week';
}

/** A count phrase with the formatted number (the plural follows the raw count). */
function countPhrase(lang, key, count, extra) {
    return phrase(lang, key, { count, countText: fmtNum(count, 0, lang), ...(extra || {}) });
}

/** Is the feature switched on? Absent = off (opt-in). */
async function isEnabled() {
    try {
        const v = await require('../models/AppSettingsModel').getValue(SETTING, false);
        return v === true || v === 'true';
    } catch (_) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Every account a digest may be written for:
 *   - active administrator accounts (persona from the role: 'executive' for a
 *     SuperAdmin or a viewer, 'hr' otherwise);
 *   - active employees with an active account who manage nobody ('employee').
 * A manager keeps the weekly manager digest and is not listed. An employee
 * who also holds a linked administrator account is that account: one person,
 * one digest.
 */
async function recipients() {
    const out = [];
    const linked = await db.all(
        'SELECT linked_employee_id AS "employeeId" FROM admins WHERE is_active AND linked_employee_id IS NOT NULL'
    );
    const linkedEmp = new Set((linked || []).map((r) => Number(r.employeeId)));
    const admins = await db.all(
        'SELECT id, role::text AS role FROM admins WHERE is_active ORDER BY id'
    );
    for (const a of admins || []) {
        out.push({
            userType: 'admin',
            id: Number(a.id),
            role: a.role,
            persona: a.role === 'superadmin' || a.role === 'viewer' ? 'executive' : 'hr',
        });
    }
    const emps = await db.all(
        `SELECT e.id FROM employees e
          WHERE e.is_active AND e.erased_at IS NULL AND e.cancelled_at IS NULL
            AND e.username IS NOT NULL AND e.is_account_active IS NOT FALSE
            AND NOT EXISTS (
                SELECT 1 FROM employees r
                 WHERE (r.supervisor_id = e.id OR (r.manager_id = e.id AND r.manager_type = 'employee'))
                   AND r.is_active AND r.erased_at IS NULL)
          ORDER BY e.id`
    );
    for (const e of emps || []) {
        const id = Number(e.id);
        if (linkedEmp.has(id)) continue;
        out.push({ userType: 'employee', id, role: null, persona: 'employee' });
    }
    return out;
}

/** The viewer object KpiService / RBACService expect for an administrator. */
async function viewerOf(r) {
    if (r.userType !== 'admin') return { userType: 'employee', id: r.id };
    let permissions = [];
    try {
        permissions =
            (await require('../models/AdminPermissionModel').findSlugsByAdminId(r.id)) || [];
    } catch (_) {
        permissions = [];
    }
    const { expandSlugs } = require('../config/permissions');
    return { userType: 'admin', id: r.id, role: r.role, permissions: expandSlugs(permissions) };
}

// ---------------------------------------------------------------------------
// The units a recipient may read
// ---------------------------------------------------------------------------

/**
 * The snapshot units whose WHOLE population is inside the recipient's cleared
 * population (never a unit with somebody hidden by clearance): the
 * organisation when the population is everyone; else the sites fully covered;
 * else the departments fully covered (outside those sites). At most 3, in
 * name order.
 */
async function narrativeUnits(pop) {
    const K = require('./KpiService');
    if (!pop.ids.length) return [];
    const sys = await K.resolvePopulation({ system: true });
    if (pop.ids.length === sys.ids.length) return [{ type: 'org', id: 0, label: null }];
    const count = (rows, key) => {
        const m = new Map();
        for (const r of rows)
            if (r[key] !== null && r[key] !== undefined) m.set(r[key], (m.get(r[key]) || 0) + 1);
        return m;
    };
    const mineSite = count(pop.rows, 'siteId');
    const allSite = count(sys.rows, 'siteId');
    const siteName = new Map(pop.rows.map((r) => [r.siteId, r.siteName]));
    const units = [];
    const covered = new Set();
    for (const [sid, n] of mineSite) {
        if (allSite.get(sid) === n) {
            covered.add(sid);
            units.push({ type: 'site', id: Number(sid), label: siteName.get(sid) || null });
        }
    }
    const mineDep = count(
        pop.rows.filter((r) => !covered.has(r.siteId)),
        'departmentId'
    );
    const allDep = count(sys.rows, 'departmentId');
    const depIds = [...mineDep.keys()].filter((d) => allDep.get(d) === mineDep.get(d));
    if (depIds.length) {
        const rows = await db.all('SELECT id, name FROM departments WHERE id = ANY(?)', [
            depIds.map(Number),
        ]);
        for (const d of rows || [])
            units.push({ type: 'department', id: Number(d.id), label: d.name || null });
    }
    units.sort(
        (a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'fr') || a.id - b.id
    );
    return units.slice(0, MAX_UNITS);
}

// ---------------------------------------------------------------------------
// Building one digest
// ---------------------------------------------------------------------------

function unitText(lang, unit, text, prefix) {
    if (!prefix || !unit.label) return text;
    return phrase(lang, 'nar_unit', { label: unit.label, text });
}

/**
 * Build the digest of one recipient. A pure read: the caller archives it.
 * @returns {Promise<{persona, cadence, windowDays, state:'sent'|'silent', payload}>}
 */
async function build(r, { cadence = DEFAULT_CADENCE, now = new Date(), locale = 'fr' } = {}) {
    const lang = locale === 'en' ? 'en' : 'fr';
    const persona = r.persona;
    const days = windowDays(persona, cadence);
    const payload = {
        v: 1,
        persona,
        cadence,
        windowDays: days,
        locale: lang,
        generatedAt: now.toISOString(),
        title: phrase(lang, titleKey(persona, days)),
        line: null,
        changes: [],
        history: [],
        actions: [],
        units: [],
    };
    if (persona === 'employee') await buildEmployee(r, payload, lang);
    else await buildScoped(r.viewer || (await viewerOf(r)), payload, days, lang);
    const state = payload.changes.length || payload.actions.length ? 'sent' : 'silent';
    return { persona, cadence, windowDays: days, state, payload };
}

async function buildScoped(viewer, payload, days, lang) {
    const K = require('./KpiService');
    const D = require('./DashboardHomeService');
    let flags = {};
    try {
        flags = (await require('./ModuleService').flags()) || {};
    } catch (_) {
        flags = {};
    }
    const pop = await K.resolvePopulation({ viewer });
    payload.populationSize = pop.ids.length;
    if (!pop.ids.length) return;
    const caps = D.capabilities(viewer, pop);
    // The same context the dashboard uses for the whole clearance: the lists
    // behind a figure are the reader's own, checked again when opened.
    const ctx = {
        user: viewer,
        flags,
        pop,
        caps,
        scope: {},
        scopeQuery: '',
        kpiScope: { viewer, modules: flags, __population: pop },
    };
    const hrefOf = (kpi, part) => D.drillHref(ctx, kpi, part);

    // ---- « What changed » (snapshot movements, units cleared whole) --------
    const units = await narrativeUnits(pop);
    payload.units = units.map((u) => ({ type: u.type, id: u.id }));
    const prefix = units.length > 1;
    for (const u of units) {
        const left = Narrative.MAX_SENTENCES - payload.changes.length;
        if (left <= 0) break;
        const res = await Narrative.whatChanged(u, {
            days,
            capabilities: caps,
            flags,
            locale: lang,
            max: left,
            hrefOf: u.type === 'org' ? hrefOf : null,
        });
        payload.history.push({
            unit: { type: u.type, id: u.id },
            state: res.state,
            since: res.since,
            historySince: res.historySince,
            line: res.line && res.state !== 'changes' ? unitText(lang, u, res.line, prefix) : null,
        });
        for (const x of res.sentences)
            payload.changes.push({
                kpi: x.kpi,
                text: unitText(lang, u, x.text, prefix),
                polarity: x.polarity,
                href: x.href,
            });
        if (!payload.line && res.since) payload.line = res.line;
    }

    // ---- « To do » (live, on the cleared population) ------------------------
    const ind = await D.indicators(ctx);
    const push = (key, text, href) => payload.actions.push({ key, text, href: href || null });
    const k9 = ind.K9;
    const unfit = k9 && k9.breakdown && isNum(k9.breakdown.unfit) ? Number(k9.breakdown.unfit) : 0;
    if (unfit > 0) push('k9', countPhrase(lang, 'nar_dg_act_k9', unfit), hrefOf('K9', 'unfit'));
    const k8 = ind.K8;
    const expired =
        k8 && k8.status !== 'not_configured' && k8.breakdown && isNum(k8.breakdown.expiredPeople)
            ? Number(k8.breakdown.expiredPeople)
            : 0;
    if (expired > 0)
        push('k8x', countPhrase(lang, 'nar_dg_act_k8x', expired), hrefOf('K8', 'expired'));
    if (ind.VAL && ind.VAL.waiting.length) {
        let text = countPhrase(lang, 'nar_dg_act_validations', ind.VAL.waiting.length);
        if (ind.VAL.overdue.length)
            text =
                text.replace(/\.$/, '') +
                countPhrase(lang, 'nar_dg_act_late', ind.VAL.overdue.length) +
                '.';
        push('validations', text, hrefOf('VAL', 'waiting'));
    }
    const k16 = ind.K16;
    if (k16 && isNum(k16.overdue) && Number(k16.overdue) > 0)
        push(
            'k16',
            countPhrase(lang, 'nar_dg_act_k16', Number(k16.overdue)),
            hrefOf('K16', 'overdue')
        );
    const k11 = ind.K11;
    for (const c of (k11 && k11.campaigns) || []) {
        if (c.status !== 'at_risk') continue;
        const b = c.breakdown || {};
        push(
            'k11',
            phrase(lang, 'nar_dg_act_k11', {
                code: String((c.campaign && (c.campaign.code || c.campaign.name)) || '').slice(
                    0,
                    60
                ),
                validated: fmtNum(b.validated, 0, lang),
                invited: fmtNum(b.invited, 0, lang),
            }),
            hrefOf('K11', 'not_validated')
        );
    }
}

async function buildEmployee(r, payload, lang) {
    const next = await require('./EmployeeHomeService').nextStep(r.id);
    // « results » is the fallback (« nothing waits for you »): nothing to act on.
    if (!next || next.key === 'results') return;
    const table = EMPLOYEE_TEXT[lang] || EMPLOYEE_TEXT.fr;
    const key = `next_${next.key}`;
    const action = table[key] || EMPLOYEE_TEXT.fr[key] || '';
    if (!action) return;
    payload.actions.push({
        key: next.key,
        text: phrase(lang, 'nar_dg_emp_next', { action }),
        href: next.href,
    });
}

// ---------------------------------------------------------------------------
// Preferences and the read-rate rule
// ---------------------------------------------------------------------------

async function getPrefs(userType, userId) {
    const row = await db.get(
        `SELECT cadence, stepdown_at AS "stepdownAt", stepdown_from AS "stepdownFrom",
                reactivated_at AS "reactivatedAt"
           FROM persona_digest_prefs WHERE user_type = ? AND user_id = ?`,
        [userType, Number(userId)]
    );
    return row || null;
}

function effectiveCadence(pref) {
    return pref && CADENCES.includes(pref.cadence) ? pref.cadence : DEFAULT_CADENCE;
}

async function setCadence(userType, userId, cadence) {
    if (!CADENCES.includes(cadence)) throw new Error('cadence');
    if (userType !== 'admin' && userType !== 'employee') throw new Error('user_type');
    await db.run(
        `INSERT INTO persona_digest_prefs (user_type, user_id, cadence, updated_at)
         VALUES (?, ?, ?, now())
         ON CONFLICT (user_type, user_id)
         DO UPDATE SET cadence = EXCLUDED.cadence,
                       reactivated_at = CASE WHEN EXCLUDED.cadence <> 'off' THEN now()
                                             ELSE persona_digest_prefs.reactivated_at END,
                       updated_at = now()`,
        [userType, Number(userId), cadence]
    );
}

/** « Restore »: back to the cadence that was stepped down (else weekly). */
async function reactivate(userType, userId) {
    const pref = await getPrefs(userType, userId);
    const to = pref && CADENCES.includes(pref.stepdownFrom) ? pref.stepdownFrom : DEFAULT_CADENCE;
    await setCadence(userType, userId, to);
    return to;
}

/** The cadence to use now, stepped down after eight unopened digests in a row. */
async function applyReadRate(r, cadence, pref) {
    if (cadence === 'off') return cadence;
    const since = [pref && pref.stepdownAt, pref && pref.reactivatedAt]
        .map((d) => (d ? new Date(d).getTime() : 0))
        .reduce((a, b) => Math.max(a, b), 0);
    const rows = await db.all(
        `SELECT d.id,
                (d.opened_at IS NOT NULL OR EXISTS (
                    SELECT 1 FROM notifications n
                     WHERE n.user_type::text = d.user_type AND n.user_id = d.user_id
                       AND n.ref_type = 'persona_digest' AND n.ref_id = d.id::text
                       AND n.opened_at IS NOT NULL)) AS "opened"
           FROM persona_digests d
          WHERE d.user_type = ? AND d.user_id = ? AND d.state = 'sent'
            AND d.created_at > ?
          ORDER BY d.created_at DESC
          LIMIT ?`,
        [r.userType, r.id, new Date(since), UNOPENED_LIMIT]
    );
    const list = rows || [];
    if (list.length < UNOPENED_LIMIT) return cadence;
    if (list.some((x) => x.opened === true || x.opened === 't')) return cadence;
    const to = cadence === 'daily' ? 'weekly' : 'off';
    await db.run(
        `INSERT INTO persona_digest_prefs (user_type, user_id, cadence, stepdown_at, stepdown_from, updated_at)
         VALUES (?, ?, ?, now(), ?, now())
         ON CONFLICT (user_type, user_id)
         DO UPDATE SET cadence = EXCLUDED.cadence, stepdown_at = now(),
                       stepdown_from = EXCLUDED.stepdown_from, updated_at = now()`,
        [r.userType, r.id, to, cadence]
    );
    await require('./NotificationService').enqueue({
        userType: r.userType,
        userId: r.id,
        kind: PAUSED_KIND,
        channel: 'inapp',
        locale: r.locale || 'fr',
        payload: { link: '/digests', from: cadence, to },
    });
    return to;
}

// ---------------------------------------------------------------------------
// Archive and delivery
// ---------------------------------------------------------------------------

async function hasPeriod(r, key) {
    const row = await db.get(
        'SELECT 1 AS x FROM persona_digests WHERE user_type = ? AND user_id = ? AND period_key = ?::date',
        [r.userType, r.id, key]
    );
    return !!row;
}

/** Atomic claim and archive: the new id, or null when the period was taken. */
async function archive(r, built, key) {
    const row = await db.get(
        `INSERT INTO persona_digests (user_type, user_id, persona, cadence, window_days, period_key, state, payload)
         VALUES (?, ?, ?, ?, ?, ?::date, ?, ?::jsonb)
         ON CONFLICT (user_type, user_id, period_key) DO NOTHING
         RETURNING id`,
        [
            r.userType,
            r.id,
            built.persona,
            built.cadence,
            built.windowDays,
            key,
            built.state,
            JSON.stringify(built.payload),
        ]
    );
    return row && row.id !== null && row.id !== undefined ? Number(row.id) : null;
}

/** The mail blocks of a digest (plain text, formatted figures). */
function blocksOf(payload, lang) {
    const blocks = [];
    if (payload.changes.length) {
        blocks.push({ type: 'p', text: phrase(lang, 'nar_dg_changes') });
        blocks.push({
            type: 'links',
            items: payload.changes.map((c) => ({ text: c.text, href: c.href || '/dashboard' })),
        });
    } else {
        for (const h of payload.history)
            if (h.line) blocks.push({ type: 'notice', severity: 'info', text: h.line });
    }
    if (payload.actions.length) {
        blocks.push({ type: 'p', text: phrase(lang, 'nar_dg_todo') });
        blocks.push({
            type: 'links',
            items: payload.actions.map((a) => ({ text: a.text, href: a.href || '/dashboard' })),
        });
    }
    return blocks;
}

async function deliver(r, built, id, lang) {
    const NotificationService = require('./NotificationService');
    const link = `/digests/${id}`;
    const p = built.payload;
    const inapp = { link, digestId: id, persona: built.persona };
    if (built.persona === 'employee') {
        // In the app only, whatever the catalogue says.
        return NotificationService.enqueue({
            userType: r.userType,
            userId: r.id,
            kind: kindOf('employee'),
            channel: 'inapp',
            locale: lang,
            payload: inapp,
            refType: 'persona_digest',
            refId: id,
        });
    }
    return NotificationService.notify({
        userType: r.userType,
        userId: r.id,
        kind: kindOf(built.persona),
        category: 'digest',
        locale: lang,
        payload: inapp,
        refType: 'persona_digest',
        refId: id,
        title: p.title,
        intro: p.line || undefined,
        blocks: blocksOf(p, lang),
        preheader: p.line || p.title,
        ctaLabel: phrase(lang, 'nar_dg_cta'),
        ctaUrl: link,
    });
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

async function tick({ now = new Date(), force = false } = {}) {
    const out = { sent: 0, silent: 0, skipped: 0, steppedDown: 0, failed: 0 };
    if (!force && !(await isEnabled())) return { ...out, skippedAll: 'disabled' };
    const AppSettingsModel = require('../models/AppSettingsModel');
    let hour = 7;
    let dow = 1;
    try {
        hour = Number(await AppSettingsModel.getValue('digestHour', 7));
        dow = Number(await AppSettingsModel.getValue('digestDow', 1));
    } catch (_) {
        /* defaults */
    }
    if (now.getHours() < hour) return { ...out, skippedAll: 'not_due' };
    const isDow = now.getDay() === dow;
    const key = dayKey(now);
    const NotificationService = require('./NotificationService');
    for (const r of await recipients()) {
        try {
            const pref = await getPrefs(r.userType, r.id);
            let cadence = effectiveCadence(pref);
            if (cadence === 'off') continue;
            if (cadence === 'weekly' && !isDow) continue;
            if (await hasPeriod(r, key)) continue;
            let lang = 'fr';
            try {
                lang =
                    (await NotificationService.recipientLang(r.userType, r.id, 'fr')) === 'en'
                        ? 'en'
                        : 'fr';
            } catch (_) {
                lang = 'fr';
            }
            const before = cadence;
            cadence = await applyReadRate({ ...r, locale: lang }, cadence, pref);
            if (cadence !== before) out.steppedDown++;
            if (cadence === 'off' || (cadence === 'weekly' && !isDow)) continue;
            const viewer = r.userType === 'admin' ? await viewerOf(r) : null;
            const built = await build({ ...r, viewer }, { cadence, now, locale: lang });
            const id = await archive(r, built, key);
            if (!id) continue;
            if (built.state === 'silent') {
                out.silent++;
                continue;
            }
            await deliver(r, built, id, lang);
            out.sent++;
        } catch (e) {
            out.failed++;
            console.error(`[persona-digest] ${r.userType}:${r.id} failed:`, e && e.message);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// The archive page
// ---------------------------------------------------------------------------

/** One archived digest, for its owner only: { status: 200|403|404, row }. */
async function findOwned(id, userType, userId) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return { status: 404 };
    const row = await db.get(
        `SELECT id, user_type AS "userType", user_id AS "userId", persona, cadence,
                window_days AS "windowDays", to_char(period_key, 'YYYY-MM-DD') AS "periodKey",
                state, payload, opened_at AS "openedAt", created_at AS "createdAt"
           FROM persona_digests WHERE id = ?`,
        [n]
    );
    if (!row) return { status: 404 };
    if (row.userType !== ownerType(userType) || Number(row.userId) !== Number(userId))
        return { status: 403 };
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {};
    return { status: 200, row: { ...row, payload } };
}

/** The persona_digests user_type of a signed-in account (a manager is an employee). */
function ownerType(userType) {
    return userType === 'admin' ? 'admin' : 'employee';
}

async function markOpened(id) {
    await db.run(
        'UPDATE persona_digests SET opened_at = now() WHERE id = ? AND opened_at IS NULL',
        [Number(id)]
    );
}

async function listOwned(userType, userId, limit = 100) {
    return (
        (await db.all(
            `SELECT id, persona, cadence, window_days AS "windowDays",
                    to_char(period_key, 'YYYY-MM-DD') AS "periodKey", payload ->> 'title' AS "title",
                    opened_at AS "openedAt", created_at AS "createdAt"
               FROM persona_digests
              WHERE user_type = ? AND user_id = ? AND state = 'sent'
              ORDER BY created_at DESC
              LIMIT ?`,
            [ownerType(userType), Number(userId), Math.max(1, Math.min(500, Number(limit) || 100))]
        )) || []
    );
}

module.exports = {
    PERSONAS,
    CADENCES,
    DEFAULT_CADENCE,
    UNOPENED_LIMIT,
    KIND_PREFIX,
    PAUSED_KIND,
    SETTING,
    kindOf,
    windowDays,
    isEnabled,
    recipients,
    viewerOf,
    build,
    blocksOf,
    narrativeUnits,
    getPrefs,
    effectiveCadence,
    setCadence,
    reactivate,
    applyReadRate,
    archive,
    deliver,
    tick,
    findOwned,
    ownerType,
    markOpened,
    listOwned,
    _test: { dayKey },
};
