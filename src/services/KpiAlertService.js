'use strict';

/**
 * KpiAlertService — threshold alerts on the indicators (migration 186).
 *
 * WHAT FIRES (rule x scope; scope = the organisation or a site, computed by
 * KpiService with { system: true }; the people without a site are covered by
 * the organisation figure):
 *   K1   below its target (KpiTargetService; a site inherits the
 *        organisation's) or « At risk » (the bands) when there is no target.
 *        When K3 (coverage) is below 50 % the K1 figure is not reliable: the
 *        rule then reports « coverage too low » INSTEAD of a K1 verdict.
 *   K6   critical roles without a ready successor RISE above the target (0
 *        without one). Talent module only.
 *   K8   at least one person with an expired required certificate.
 *   K9   safety-gate fitness below 100 % (« Watch » or « At risk »).
 *   K11  a running campaign whose validated share is « At risk » (behind the
 *        elapsed time), one rule per campaign. Campaigns module only.
 * A rule whose module is off is not computed, not evaluated and not
 * announced; its stored state is left as it was.
 *
 * HOW (transitions, never a level): each rule x scope keeps its band in
 * kpi_alert_states. An alert fires when an alerting band is ENTERED (raised),
 * again when the episode gets WORSE than its worst point so far (worsened: a
 * higher band, a higher count), and « back to normal » when it ends
 * (recovered). Nothing measured (no value, fewer than 5 people, not
 * configured) is NOT a transition: the state is kept. The first pass finds
 * every state empty, so it announces everything already in a band.
 *
 * WHO: a site alert reaches the local administrators holding
 * manage_kpi_targets and the viewers whose clearance covers the whole site,
 * and, for K8 / K9, the holders of view_compliance / manage_compliance
 * covering it; nobody in scope means the SuperAdmins (an alert never reaches
 * nobody). An organisation alert reaches the SuperAdmins.
 *
 * CHANNEL: in the app first. kpi.alert and kpi.recovered go to the daily
 * summary mail; safety.kpi_alert (K8, K9) is mandatory and sent now. The
 * subject is the catalogue's neutral subject (no name, no figure); the
 * figures ride in payload.figures for the bell only, never in a mail. Each
 * mail is written in the recipient's language. Once per recipient:
 * reminder_log (kind, admin, ref_id = event id, period 'once'); an event with
 * a recipient not yet told stays open and the next pass retries THAT
 * recipient only, for 7 days.
 */

const db = require('../config/database');

const SMALL_N = 5;
const RETRY_DAYS = 7;
const KIND_ALERT = 'kpi.alert';
const KIND_SAFETY = 'safety.kpi_alert';
const KIND_RECOVERED = 'kpi.recovered';
const KINDS = Object.freeze([KIND_ALERT, KIND_SAFETY, KIND_RECOVERED]);

const TEXT = {
    fr: require('../../locales/fr/kpi.json'),
    en: require('../../locales/en/kpi.json'),
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** One locale string, FR fallback, {{x}} filled from `vars` (never re-read). */
function phrase(lang, key, vars) {
    const table = TEXT[lang === 'en' ? 'en' : 'fr'];
    const s = has(table, key) ? table[key] : has(TEXT.fr, key) ? TEXT.fr[key] : null;
    if (typeof s !== 'string') return '';
    const v = vars || {};
    return s.replace(/\{\{(\w+)\}\}/g, (m, k) => (has(v, k) ? String(v[k]) : ''));
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ---------------------------------------------------------------------------
// Rule evaluation (pure)
// ---------------------------------------------------------------------------

const UNMEASURED = Object.freeze({ measured: false });

function measured(state, level, value, target) {
    return {
        measured: true,
        state,
        level,
        value: value === null || value === undefined ? null : Number(value),
        target: target === null || target === undefined ? null : Number(target),
    };
}

/** A result is unusable for an alert: empty scope, no value, or fewer than 5 behind it. */
function unusable(r) {
    if (!r || r.emptyScope) return true;
    if (r.value === null || r.value === undefined) return true;
    if (r.n !== undefined && r.n !== null && Number(r.n) < SMALL_N) return true;
    return false;
}

/** K1 with the coverage guard. */
function evalK1(k1, k3, target) {
    const cov = k3 ? num(k3.rawValue) : null;
    if (cov !== null && cov < 50 && Number((k3 && k3.n) || 0) >= SMALL_N) {
        return measured('coverage_low', 1, cov, null);
    }
    if (unusable(k1)) return UNMEASURED;
    const v = Number(k1.value);
    const t =
        target && target.value !== null && target.value !== undefined ? Number(target.value) : null;
    if (k1.status === 'at_risk') return measured('at_risk', 2, v, t);
    if (t !== null && v < t) return measured('below_target', 1, v, t);
    return measured('ok', 0, v, t);
}

/** K6 « count rises » above its target (0 without one). Level = the count. */
function evalK6(k6, target) {
    if (!k6 || k6.status === 'not_configured' || k6.emptyScope) return UNMEASURED;
    if (k6.value === null || k6.value === undefined) return UNMEASURED;
    const v = Number(k6.value);
    const thr =
        target && target.value !== null && target.value !== undefined ? Number(target.value) : 0;
    return v > thr ? measured('rising', v, v, thr) : measured('ok', 0, v, thr);
}

/** K8 people with an expired required certificate > 0. Level = the count. */
function evalK8(k8) {
    if (!k8 || k8.status === 'not_configured' || k8.emptyScope) return UNMEASURED;
    const b = k8.breakdown || {};
    const v = num(b.expiredPeople);
    if (v === null) return UNMEASURED;
    return v > 0 ? measured('expired', v, v, null) : measured('ok', 0, v, null);
}

/** K9 below 100 %: « Watch » = 1, « At risk » = 2. */
function evalK9(k9) {
    if (!k9 || k9.status === 'not_configured') return UNMEASURED;
    if (unusable(k9)) return UNMEASURED;
    const v = Number(k9.value);
    if (v >= 100) return measured('ok', 0, v, null);
    return k9.status === 'at_risk'
        ? measured('at_risk', 2, v, null)
        : measured('watch', 1, v, null);
}

/** One running campaign (a K11 `campaigns[]` item): « At risk » = late. */
function evalK11(c) {
    if (unusable(c) || !c.status) return UNMEASURED;
    const v = Number(c.value);
    return c.status === 'at_risk'
        ? measured(
              'late',
              1,
              v,
              c.elapsedPct === null || c.elapsedPct === undefined ? null : Number(c.elapsedPct)
          )
        : measured('ok', 0, v, null);
}

/**
 * The transition between the stored state and a new evaluation (pure).
 * @param {object|null} prev { level, peakLevel } or null (never seen)
 * @param {object} next an evaluation
 * @returns {{ transition: null|'raised'|'worsened'|'recovered', persist: boolean, peakLevel: number }}
 */
function transition(prev, next) {
    if (!next || !next.measured) {
        return {
            transition: null,
            persist: false,
            peakLevel: prev ? Number(prev.peakLevel) || 0 : 0,
        };
    }
    const prevLevel = prev ? Number(prev.level) || 0 : 0;
    const peak = prev ? Number(prev.peakLevel) || 0 : 0;
    if (next.level > 0) {
        if (prevLevel === 0) return { transition: 'raised', persist: true, peakLevel: next.level };
        if (next.level > peak)
            return { transition: 'worsened', persist: true, peakLevel: next.level };
        return { transition: null, persist: true, peakLevel: peak };
    }
    if (prevLevel > 0) return { transition: 'recovered', persist: true, peakLevel: 0 };
    return { transition: null, persist: true, peakLevel: 0 };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function scopeKey(scope) {
    return scope.scopeType === 'org' ? 'org' : `site:${Number(scope.scopeId)}`;
}

async function readState(ruleKey, scope) {
    return db.get(
        `SELECT state, level, peak_level AS "peakLevel" FROM kpi_alert_states
          WHERE rule_key = ? AND scope_key = ?`,
        [ruleKey, scopeKey(scope)]
    );
}

async function writeState(ruleKey, kpiId, scope, ev, peakLevel) {
    await db.run(
        `INSERT INTO kpi_alert_states (rule_key, scope_key, kpi_id, state, level, peak_level, value, target, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())
         ON CONFLICT (rule_key, scope_key) DO UPDATE
            SET state = EXCLUDED.state, level = EXCLUDED.level, peak_level = EXCLUDED.peak_level,
                value = EXCLUDED.value, target = EXCLUDED.target, updated_at = now()`,
        [ruleKey, scopeKey(scope), kpiId, ev.state, ev.level, peakLevel, ev.value, ev.target]
    );
}

async function createEvent(ruleKey, kpiId, scope, tr, prev, ev) {
    const row = await db.get(
        `INSERT INTO kpi_alert_events (rule_key, kpi_id, scope_type, scope_id, transition, from_state, to_state, value, target)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [
            ruleKey,
            kpiId,
            scope.scopeType,
            scope.scopeId,
            tr,
            prev ? prev.state : null,
            ev.state,
            ev.value,
            ev.target,
        ]
    );
    return row ? Number(row.id) : null;
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

const SAFETY_KPIS = new Set(['K8', 'K9']);

async function superAdmins() {
    const rows = await db.all(
        `SELECT id FROM admins WHERE role = 'superadmin' AND COALESCE(is_active, true) = true ORDER BY id`
    );
    return (rows || []).map((r) => Number(r.id)).filter(Boolean);
}

/**
 * The administrator ids to tell about `kpiId` on `scope`. Never empty while a
 * SuperAdmin exists. Clearance first: a site alert only reaches accounts that
 * govern the whole site (RBACService.canAccessSite).
 */
async function recipientsFor(kpiId, scope) {
    if (scope.scopeType === 'org') return superAdmins();
    const RBACService = require('./RBACService');
    const { expandSlugs } = require('../config/permissions');
    const rows = await db.all(
        `SELECT a.id, a.role,
                COALESCE(array_agg(ap.permission) FILTER (WHERE ap.permission IS NOT NULL), '{}') AS "perms"
           FROM admins a
           LEFT JOIN admin_permissions ap
                  ON ap.admin_id = a.id AND ap.revoked_at IS NULL
                 AND (ap.expires_at IS NULL OR ap.expires_at > now())
          WHERE COALESCE(a.is_active, true) = true
            AND a.role IN ('localadmin', 'viewer')
            AND EXISTS (SELECT 1 FROM admin_scopes s
                         WHERE s.admin_id = a.id AND s.revoked_at IS NULL
                           AND (s.expires_at IS NULL OR s.expires_at > now()))
          GROUP BY a.id, a.role
          ORDER BY a.id`
    );
    const safety = SAFETY_KPIS.has(kpiId);
    const out = [];
    for (const r of rows || []) {
        const perms = new Set(expandSlugs(Array.isArray(r.perms) ? r.perms : []));
        const wanted =
            (r.role === 'localadmin' && perms.has('manage_kpi_targets')) ||
            r.role === 'viewer' ||
            (safety && (perms.has('view_compliance') || perms.has('manage_compliance')));
        if (!wanted) continue;
        const user = { id: Number(r.id), userType: 'admin', role: r.role, permissions: [...perms] };
        try {
            if (await RBACService.canAccessSite(user, scope.scopeId)) out.push(Number(r.id));
        } catch (_) {
            /* fail closed: not told */
        }
    }
    return out.length ? out : superAdmins();
}

// ---------------------------------------------------------------------------
// Message (no name; no figure in a mail)
// ---------------------------------------------------------------------------

function kindFor(kpiId, tr) {
    if (tr === 'recovered') return KIND_RECOVERED;
    return SAFETY_KPIS.has(kpiId) ? KIND_SAFETY : KIND_ALERT;
}

/** The indicator's name, e.g. « Role-ready rate ». */
function kpiName(lang, kpiId) {
    return phrase(lang, `${String(kpiId).toLowerCase()}_name`) || kpiId;
}

/** The sentence of a transition, in one language. Pure. */
function sentence(lang, event, siteName) {
    const scope =
        event.scopeType === 'org'
            ? phrase(lang, 'alert_scope_org')
            : phrase(lang, 'alert_scope_site', {
                  site: siteName || phrase(lang, 'alert_scope_site_unknown'),
              });
    const name = kpiName(lang, event.kpiId);
    if (event.transition === 'recovered')
        return phrase(lang, 'alert_recovered', { kpi: name, scope });
    let body = phrase(lang, `alert_${String(event.kpiId).toLowerCase()}_${event.toState}`, {
        kpi: name,
        scope,
    });
    if (!body) body = phrase(lang, 'alert_generic', { kpi: name, scope });
    return event.transition === 'worsened' ? `${phrase(lang, 'alert_worsened')} ${body}` : body;
}

function linkFor(event) {
    return event.scopeType === 'site' && event.scopeId
        ? `/dashboard?site=${Number(event.scopeId)}`
        : '/dashboard';
}

function unitOf(kpiId) {
    return ['K6', 'K7', 'K8', 'K16'].includes(kpiId) ? 'count' : 'pct';
}

/** The notify() arguments for one recipient of an event (pure). */
function message(event, siteName, adminId) {
    const kind = kindFor(event.kpiId, event.transition);
    const safety = kind === KIND_SAFETY;
    const coverage = event.toState === 'coverage_low';
    const link = linkFor(event);
    const severity = event.transition === 'recovered' ? 'info' : safety ? 'critical' : 'warning';
    return {
        userType: 'admin',
        userId: Number(adminId),
        kind,
        category: 'compliance',
        locale: 'fr',
        payload: {
            kpi: event.kpiId,
            rule: event.ruleKey,
            transition: event.transition,
            state: event.toState,
            scopeType: event.scopeType,
            siteId: event.scopeType === 'site' ? Number(event.scopeId) : null,
            siteName: event.scopeType === 'site' ? siteName || null : null,
            eventId: Number(event.id),
            link,
            // For the bell only: never in a subject, never in the mail.
            figures: {
                kpi: coverage ? 'K3' : event.kpiId,
                value: num(event.value),
                target: coverage ? null : num(event.target),
                unit: coverage ? 'pct' : unitOf(event.kpiId),
            },
        },
        ctaUrl: link,
        // Written in the recipient's language (NotificationService picks it).
        content: (B) => ({
            intro: sentence(B.lang, event, siteName),
            blocks: [
                {
                    type: 'notice',
                    severity,
                    text: phrase(
                        B.lang,
                        event.transition === 'recovered' ? 'alert_cta_recovered' : 'alert_cta'
                    ),
                },
            ],
            ctaLabel: phrase(B.lang, 'alert_cta_label'),
            ctaUrl: link,
        }),
    };
}

// ---------------------------------------------------------------------------
// Delivery (once per recipient)
// ---------------------------------------------------------------------------

async function alreadyTold(kind, adminId, eventId) {
    try {
        const row = await db.get(
            `SELECT 1 AS yes FROM reminder_log
              WHERE kind = ? AND target_type = 'admin' AND target_id = ? AND ref_id = ? AND period = 'once'`,
            [kind, Number(adminId), Number(eventId)]
        );
        return !!row;
    } catch (_) {
        return false;
    }
}

async function markTold(kind, adminId, eventId) {
    try {
        await db.run(
            `INSERT INTO reminder_log (kind, target_type, target_id, ref_id, period)
             VALUES (?, 'admin', ?, ?, 'once')
             ON CONFLICT (kind, target_type, target_id, ref_id, period) DO NOTHING`,
            [kind, Number(adminId), Number(eventId)]
        );
    } catch (_) {
        /* best effort: at worst a retry tells this person again */
    }
}

async function siteNameOf(siteId) {
    if (!siteId) return null;
    try {
        const r = await db.get('SELECT name FROM sites WHERE id = ?', [Number(siteId)]);
        return r ? r.name : null;
    } catch (_) {
        return null;
    }
}

async function deliver(event) {
    const NotificationService = require('./NotificationService');
    const kind = kindFor(event.kpiId, event.transition);
    const scope = {
        scopeType: event.scopeType,
        scopeId:
            event.scopeId === null || event.scopeId === undefined ? null : Number(event.scopeId),
    };
    const audience = await recipientsFor(event.kpiId, scope);
    const siteName = scope.scopeType === 'site' ? await siteNameOf(scope.scopeId) : null;
    let delivered = 0;
    for (const adminId of audience) {
        if (await alreadyTold(kind, adminId, event.id)) {
            delivered++;
            continue;
        }
        let res = null;
        try {
            res = await NotificationService.notify(message(event, siteName, adminId));
        } catch (_) {
            res = null;
        }
        if (res && res.inapp && res.inapp !== 'error') {
            await markTold(kind, adminId, event.id);
            delivered++;
        }
    }
    const complete = audience.length > 0 && delivered === audience.length;
    try {
        await db.run(
            'UPDATE kpi_alert_events SET recipients = ?, delivered = ?, complete = ? WHERE id = ?',
            [audience.length, delivered, complete, Number(event.id)]
        );
    } catch (_) {
        /* the ledger already holds who was told */
    }
    return { recipients: audience.length, delivered, complete };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** The rules the organisation's modules allow (K6: talent; K11: campaigns). */
function ruleKpis(flags) {
    const KpiService = require('./KpiService');
    return ['K1', 'K3', 'K6', 'K8', 'K9', 'K11'].filter((k) =>
        KpiService.isAvailable(k, flags || {})
    );
}

async function computeAll(flags) {
    const KpiService = require('./KpiService');
    const sys = { system: true };
    const by = {};
    const failed = [];
    for (const k of ruleKpis(flags)) {
        try {
            by[k] = await KpiService.bySite(k, sys);
        } catch (e) {
            failed.push(k);
            console.error(`[kpi-alerts] ${k} not computed:`, e && e.message);
        }
    }
    return { by, failed };
}

/** The evaluations of every rule x scope from the computed indicators. */
async function evaluations(by, today, flags) {
    const KpiTargetService = require('./KpiTargetService');
    const scopes = new Map([['org', { scopeType: 'org', scopeId: null }]]);
    for (const k of Object.keys(by)) {
        for (const row of by[k].rows || []) {
            if (row.noSite || row.siteId === null || row.siteId === undefined) continue;
            scopes.set(`site:${row.siteId}`, { scopeType: 'site', scopeId: Number(row.siteId) });
        }
    }
    const resultOf = (k, scope) => {
        const b = by[k];
        if (!b) return null;
        if (scope.scopeType === 'org') return b.org;
        const row = (b.rows || []).find((r) => !r.noSite && Number(r.siteId) === scope.scopeId);
        return row ? row.result : null;
    };
    const out = [];
    for (const scope of scopes.values()) {
        const tScope = scope.scopeType === 'org' ? 'org' : { type: 'site', id: scope.scopeId };
        if (by.K1) {
            const t = await KpiTargetService.targetFor('K1', tScope, today, { flags });
            out.push({
                ruleKey: 'K1',
                kpiId: 'K1',
                scope,
                ev: evalK1(resultOf('K1', scope), resultOf('K3', scope), t),
            });
        }
        if (by.K6) {
            const t = await KpiTargetService.targetFor('K6', tScope, today, { flags });
            out.push({ ruleKey: 'K6', kpiId: 'K6', scope, ev: evalK6(resultOf('K6', scope), t) });
        }
        if (by.K8)
            out.push({ ruleKey: 'K8', kpiId: 'K8', scope, ev: evalK8(resultOf('K8', scope)) });
        if (by.K9)
            out.push({ ruleKey: 'K9', kpiId: 'K9', scope, ev: evalK9(resultOf('K9', scope)) });
        if (by.K11) {
            const k11 = resultOf('K11', scope);
            for (const c of (k11 && k11.campaigns) || []) {
                const cid = c.campaign && c.campaign.id;
                if (!cid) continue;
                out.push({ ruleKey: `K11:${Number(cid)}`, kpiId: 'K11', scope, ev: evalK11(c) });
            }
        }
    }
    return out;
}

/** The organisation's module flags; {} (core only) when unreadable. */
async function moduleFlags() {
    try {
        return (await require('./ModuleService').flags()) || {};
    } catch (_) {
        return {};
    }
}

/**
 * One pass: compute, evaluate, persist the transitions, announce them, retry
 * the open events. Idempotent per state: a second pass on the same figures
 * announces nothing.
 */
async function run({ today, flags } = {}) {
    const f = flags || (await moduleFlags());
    const { by, failed } = await computeAll(f);
    const evs = await evaluations(by, today, f);
    const summary = {
        evaluated: 0,
        raised: 0,
        worsened: 0,
        recovered: 0,
        delivered: 0,
        retried: 0,
        failed,
    };
    const fresh = new Set();
    for (const e of evs) {
        summary.evaluated++;
        try {
            const prev = await readState(e.ruleKey, e.scope);
            const tr = transition(prev, e.ev);
            if (!tr.persist) continue;
            await writeState(e.ruleKey, e.kpiId, e.scope, e.ev, tr.peakLevel);
            if (!tr.transition) continue;
            const id = await createEvent(e.ruleKey, e.kpiId, e.scope, tr.transition, prev, e.ev);
            if (!id) continue;
            fresh.add(id);
            summary[tr.transition]++;
            const d = await deliver({
                id,
                ruleKey: e.ruleKey,
                kpiId: e.kpiId,
                scopeType: e.scope.scopeType,
                scopeId: e.scope.scopeId,
                transition: tr.transition,
                toState: e.ev.state,
                value: e.ev.value,
                target: e.ev.target,
            });
            summary.delivered += d.delivered;
        } catch (err) {
            console.error(
                `[kpi-alerts] ${e.ruleKey} ${scopeKey(e.scope)} failed:`,
                err && err.message
            );
        }
    }
    // Retry the open events (a recipient not told yet), newest first, 7 days at
    // most. The events of a rule whose module is now off are not retried.
    const allowed = new Set(ruleKpis(f));
    try {
        const open = await db.all(
            `SELECT id, rule_key AS "ruleKey", kpi_id AS "kpiId", scope_type AS "scopeType",
                    scope_id AS "scopeId", transition, to_state AS "toState", value, target
               FROM kpi_alert_events
              WHERE complete = false AND created_at > now() - make_interval(days => ?::int)
              ORDER BY id DESC LIMIT 200`,
            [RETRY_DAYS]
        );
        for (const ev of open || []) {
            if (fresh.has(Number(ev.id)) || !allowed.has(ev.kpiId)) continue;
            await deliver({ ...ev, id: Number(ev.id) });
            summary.retried++;
        }
    } catch (err) {
        console.error('[kpi-alerts] retry pass failed:', err && err.message);
    }
    return summary;
}

module.exports = {
    KIND_ALERT,
    KIND_SAFETY,
    KIND_RECOVERED,
    KINDS,
    SMALL_N,
    evalK1,
    evalK6,
    evalK8,
    evalK9,
    evalK11,
    transition,
    recipientsFor,
    message,
    sentence,
    ruleKpis,
    evaluations,
    deliver,
    run,
};
