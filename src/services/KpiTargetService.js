'use strict';

/**
 * KpiTargetService — the targets of the indicators (migration 186).
 *
 * A target is set per indicator and scope (the organisation or a site), from
 * a date, with a reason. Storage is kpi_targets, APPEND-ONLY: a change,
 * including a withdrawal (target_value NULL), is a new row; nothing is updated
 * in place or deleted (the table carries the block_mutation trigger). No
 * target, no target line: a page prints « No target set », never 0.
 *
 * Who may set a target (canManage):
 *   SuperAdmin                            every indicator, every scope;
 *   admin holding manage_kpi_targets      a SITE inside their clearance
 *                                         (RBACService.canAccessSite: a site,
 *                                         country or region scope; a department
 *                                         scope does not govern the whole site);
 *                                         the ORGANISATION only with an
 *                                         unrestricted clearance (utils/adminScope);
 *   a viewer                              never (a write permission).
 * Any administrator account may READ the page (canView).
 *
 * Module-aware: an indicator whose module is off (KpiService.CONTRACTS) is
 * not offered, not accepted (404) and has no target; stored rows are kept.
 *
 * Resolution (targetFor): the latest row with effective_from <= the date for
 * the exact scope; a SITE without its own row inherits the ORGANISATION's
 * target (`inherited: true`). A withdrawal at the site stops the inheritance.
 *
 *   KpiTargetService.targetFor(kpiId, scope, date?) -> Promise<Target|null>
 *     scope  = 'org' | { type: 'org' } | { type: 'site', id } | { siteId }
 *     Target = { id, kpiId, scopeType, scopeId, value, unit, polarity,
 *                effectiveFrom: 'YYYY-MM-DD', inherited }
 * (who set it and why stay on the targets page: governance, not tile content.)
 */

const db = require('../config/database');

const PERMISSION = 'manage_kpi_targets';

/**
 * The indicators that can carry a target, with their polarity (which side of
 * the target is good) and unit. Informational indicators (K12 to K15) take
 * no target.
 */
const TARGETABLE = Object.freeze({
    K1: Object.freeze({ polarity: 'higher', unit: 'pct' }),
    K2: Object.freeze({ polarity: 'higher', unit: 'pct' }),
    K3: Object.freeze({ polarity: 'higher', unit: 'pct' }),
    K4: Object.freeze({ polarity: 'higher', unit: 'pct' }),
    K5: Object.freeze({ polarity: 'higher', unit: 'pct' }),
    K6: Object.freeze({ polarity: 'lower', unit: 'count' }),
    K7: Object.freeze({ polarity: 'lower', unit: 'count' }),
    K8: Object.freeze({ polarity: 'lower', unit: 'count' }),
    K9: Object.freeze({ polarity: 'higher', unit: 'pct' }),
    K11: Object.freeze({ polarity: 'higher', unit: 'pct' }),
    K16: Object.freeze({ polarity: 'lower', unit: 'count' }),
    // the median validation lead time, in days with one decimal: lower is better
    K17: Object.freeze({ polarity: 'lower', unit: 'days' }),
});

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

class TargetError extends Error {
    constructor(code, status = 400) {
        super(code);
        this.code = code;
        this.status = status;
    }
}

/** The organisation's module flags (ModuleService), {} when unreadable. */
async function moduleFlags() {
    try {
        return (await require('./ModuleService').flags()) || {};
    } catch (_) {
        return {};
    }
}

/** May this indicator carry a target under these module flags? */
function isTargetable(kpiId, flags) {
    if (!has(TARGETABLE, kpiId)) return false;
    return require('./KpiService').isAvailable(kpiId, flags || {});
}

/** The indicator ids that may carry a target now, in catalogue order. */
async function targetableIds(flags) {
    const f = flags || (await moduleFlags());
    return Object.keys(TARGETABLE).filter((k) => isTargetable(k, f));
}

/** Normalise a scope argument to { scopeType, scopeId }, or null when invalid. */
function normScope(scope) {
    if (scope === 'org' || scope === null || scope === undefined) {
        return { scopeType: 'org', scopeId: null };
    }
    if (typeof scope === 'object') {
        if (scope.type === 'org' || scope.scopeType === 'org') {
            return { scopeType: 'org', scopeId: null };
        }
        let raw = scope.siteId;
        if (scope.type === 'site' || scope.scopeType === 'site')
            raw = scope.id !== undefined && scope.id !== null ? scope.id : scope.scopeId;
        const id = Number(raw);
        if (Number.isInteger(id) && id > 0) return { scopeType: 'site', scopeId: id };
    }
    return null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD of a Date or a day string; null when unreadable. */
function dayKey(d) {
    if (d === null || d === undefined || d === '') return null;
    if (typeof d === 'string' && DAY_RE.test(d)) return d;
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function shape(row, kpiId, inherited) {
    const meta = TARGETABLE[kpiId];
    return {
        id: Number(row.id),
        kpiId,
        scopeType: row.scopeType,
        scopeId: row.scopeId === null || row.scopeId === undefined ? null : Number(row.scopeId),
        value: toNum(row.targetValue),
        unit: meta.unit,
        polarity: meta.polarity,
        effectiveFrom: dayKey(row.effectiveFrom),
        inherited: !!inherited,
    };
}

async function latestRow(kpiId, scopeType, scopeId, day) {
    return db.get(
        `SELECT id, kpi_id AS "kpiId", scope_type AS "scopeType", scope_id AS "scopeId",
                target_value AS "targetValue", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom"
           FROM kpi_targets
          WHERE kpi_id = ? AND scope_type = ?
            AND scope_id IS NOT DISTINCT FROM ?::bigint
            AND effective_from <= ?::date
          ORDER BY effective_from DESC, id DESC
          LIMIT 1`,
        [kpiId, scopeType, scopeId, day]
    );
}

/**
 * The target in force for an indicator and scope at `date` (default today),
 * or null (« No target set »). Never throws for a bad argument.
 * @param {object} [opts] { flags } the module flags when the caller has them
 */
async function targetFor(kpiId, scope, date, opts = {}) {
    const id = String(kpiId || '').toUpperCase();
    if (!has(TARGETABLE, id)) return null;
    const flags = opts.flags || (await moduleFlags());
    if (!isTargetable(id, flags)) return null;
    const s = normScope(scope);
    if (!s) return null;
    const day = dayKey(date || new Date());
    if (!day) return null;
    const own = await latestRow(id, s.scopeType, s.scopeId, day);
    if (own) {
        const t = shape(own, id, false);
        return t.value === null ? null : t; // withdrawn here: no target, no inheritance
    }
    if (s.scopeType === 'site') {
        const org = await latestRow(id, 'org', null, day);
        if (org) {
            const t = shape(org, id, true);
            return t.value === null ? null : t;
        }
    }
    return null;
}

/** Is `value` on the good side of `target`? null when either is unknown. */
function meetsTarget(kpiId, value, target) {
    const id = String(kpiId || '').toUpperCase();
    if (!has(TARGETABLE, id)) return null;
    const v = toNum(value);
    const t = toNum(target && typeof target === 'object' ? target.value : target);
    if (v === null || t === null) return null;
    return TARGETABLE[id].polarity === 'lower' ? v <= t : v >= t;
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

async function canManage(actor, scope) {
    if (!actor || actor.userType !== 'admin') return false;
    const RBACService = require('./RBACService');
    if (RBACService.isSuperAdmin(actor)) return true;
    if (!RBACService.hasPermission(actor, PERMISSION)) return false;
    const s = normScope(scope);
    if (!s) return false;
    if (s.scopeType === 'org') {
        const { resolveAdminScope } = require('../utils/adminScope');
        const sc = await resolveAdminScope(actor);
        return !!(sc && sc.unrestricted);
    }
    try {
        return !!(await RBACService.canAccessSite(actor, s.scopeId));
    } catch (_) {
        return false;
    }
}

/** May this account open the targets page (read)? Administrator accounts only. */
function canView(actor) {
    return !!(actor && actor.userType === 'admin');
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function actorRef(actor) {
    return `admin:${Number(actor.id)}`;
}

/**
 * A submitted value for an indicator: '' or null = a withdrawal (null). A %
 * is 0 to 100 with one decimal; a count is a whole number >= 0. The input is
 * at most 16 characters; a comma is a decimal point.
 */
function parseValue(kpiId, raw) {
    if (raw === null || raw === undefined) return null;
    const txt = String(raw).trim();
    if (txt === '') return null;
    if (txt.length > 16) throw new TargetError('invalid_value');
    const clean = txt.split(' ').join('').split(' ').join('').replace(',', '.');
    if (!/^\d{1,6}(\.\d{1,4})?$/.test(clean)) throw new TargetError('invalid_value');
    const n = Number(clean);
    if (!Number.isFinite(n) || n < 0) throw new TargetError('invalid_value');
    if (TARGETABLE[kpiId].unit === 'pct') {
        if (n > 100) throw new TargetError('invalid_value');
        return Math.round(n * 10) / 10;
    }
    // days (K17): one decimal, as the median is printed; at most ten years
    if (TARGETABLE[kpiId].unit === 'days') {
        if (n > 3650) throw new TargetError('invalid_value');
        return Math.round(n * 10) / 10;
    }
    if (!Number.isInteger(n)) throw new TargetError('invalid_value');
    return n;
}

/**
 * Record a target decision (a NEW row, never an update). Audited
 * (KPI_TARGET_SET / KPI_TARGET_WITHDRAWN). Posting the decision in force
 * again (same scope, same value, same date) appends nothing.
 * @param {object} input { kpiId, scopeType, scopeId, targetValue ('' = withdraw),
 *                         effectiveFrom 'YYYY-MM-DD', reason }
 * @param {object} actor req.user
 * @param {object} [ctx] { ipAddress, userAgent, requestId }
 */
async function setTarget(input, actor, ctx = {}) {
    const i = input || {};
    const kpiId = String(i.kpiId || '').toUpperCase();
    if (!has(TARGETABLE, kpiId)) throw new TargetError('invalid_kpi');
    if (!isTargetable(kpiId, await moduleFlags())) throw new TargetError('not_found', 404);
    if (i.scopeType !== 'org' && i.scopeType !== 'site') throw new TargetError('invalid_scope');
    const scope = normScope(i.scopeType === 'site' ? { type: 'site', id: i.scopeId } : 'org');
    if (!scope) throw new TargetError('invalid_scope');
    if (!(await canManage(actor, scope))) throw new TargetError('forbidden', 403);
    if (scope.scopeType === 'site') {
        const site = await db.get('SELECT id FROM sites WHERE id = ?', [scope.scopeId]);
        if (!site) throw new TargetError('invalid_scope');
    }
    const value = parseValue(kpiId, i.targetValue);
    const effectiveFrom = typeof i.effectiveFrom === 'string' ? i.effectiveFrom.trim() : '';
    // a real calendar day: 2026-02-31 does not read back as itself
    if (
        !DAY_RE.test(effectiveFrom) ||
        dayKey(new Date(effectiveFrom + 'T12:00:00')) !== effectiveFrom
    ) {
        throw new TargetError('invalid_date');
    }
    const reason = String(i.reason === null || i.reason === undefined ? '' : i.reason)
        .slice(0, 2000)
        .split(/\s+/)
        .filter(Boolean)
        .join(' ')
        .slice(0, 500);
    if (!reason) throw new TargetError('reason_required');

    // The decision in force from the same day with the same value (or the same
    // withdrawal) is the same decision: posting it again appends nothing.
    const inForce = await latestRow(kpiId, scope.scopeType, scope.scopeId, effectiveFrom);
    if (inForce && inForce.effectiveFrom === effectiveFrom) {
        const was = toNum(inForce.targetValue);
        if (was === value) {
            return {
                id: Number(inForce.id),
                kpiId,
                scopeType: scope.scopeType,
                scopeId: scope.scopeId,
                value,
                effectiveFrom,
                unchanged: true,
            };
        }
    }

    const ref = actorRef(actor);
    const row = await db.get(
        `INSERT INTO kpi_targets (kpi_id, scope_type, scope_id, target_value, effective_from, set_by_ref, reason)
         VALUES (?, ?, ?, ?, ?::date, ?, ?)
         RETURNING id`,
        [kpiId, scope.scopeType, scope.scopeId, value, effectiveFrom, ref, reason]
    );
    const id = row ? Number(row.id) : null;
    try {
        await require('./LogService').log({
            adminId: Number(actor.id),
            actorRef: ref,
            action: value === null ? 'KPI_TARGET_WITHDRAWN' : 'KPI_TARGET_SET',
            entityType: 'kpi_target',
            entityId: id,
            details: JSON.stringify({
                kpi: kpiId,
                scopeType: scope.scopeType,
                scopeId: scope.scopeId,
                value,
                effectiveFrom,
            }),
            severity: 'info',
            ipAddress: ctx.ipAddress || null,
            userAgent: ctx.userAgent || null,
            requestId: ctx.requestId || null,
        });
    } catch (e) {
        console.error('[kpi-targets] audit log failed:', e && e.message);
    }
    return { id, kpiId, scopeType: scope.scopeType, scopeId: scope.scopeId, value, effectiveFrom };
}

// ---------------------------------------------------------------------------
// Read (the targets page)
// ---------------------------------------------------------------------------

/** Sites the account may SEE targets for: a SuperAdmin all, else its navigable sites. */
async function visibleSites(actor) {
    const RBACService = require('./RBACService');
    const rows = RBACService.isSuperAdmin(actor)
        ? await db.all('SELECT id, name FROM sites ORDER BY name')
        : await RBACService.getFilteredSites(actor);
    return (rows || [])
        .map((s) => ({ id: Number(s.id), name: s.name || '' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/**
 * Everything the page shows: per targetable indicator, the organisation row
 * and one row per visible site with the target in force today, the history
 * (newest first) of the scopes the account can see, and what it may edit.
 */
async function overview(actor, { today, flags } = {}) {
    const day = dayKey(today || new Date());
    const f = flags || (await moduleFlags());
    const kpis = await targetableIds(f);
    const sites = await visibleSites(actor);
    const canOrg = await canManage(actor, 'org');
    const editableSites = [];
    for (const s of sites) {
        if (await canManage(actor, { type: 'site', id: s.id })) editableSites.push(s.id);
    }
    const scopes = [{ scopeType: 'org', scopeId: null, name: null }].concat(
        sites.map((s) => ({ scopeType: 'site', scopeId: s.id, name: s.name }))
    );
    const rows = [];
    for (const k of kpis) {
        for (const sc of scopes) {
            const t = await targetFor(
                k,
                sc.scopeType === 'org' ? 'org' : { type: 'site', id: sc.scopeId },
                day,
                { flags: f }
            );
            rows.push({ kpiId: k, ...sc, target: t });
        }
    }
    const history = kpis.length
        ? await db.all(
              `SELECT t.id, t.kpi_id AS "kpiId", t.scope_type AS "scopeType", t.scope_id AS "scopeId",
                      s.name AS "siteName", t.target_value AS "targetValue",
                      to_char(t.effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
                      t.set_by_ref AS "setByRef", a.username AS "setByName",
                      t.reason, t.created_at AS "createdAt"
                 FROM kpi_targets t
                 LEFT JOIN sites s ON s.id = t.scope_id
                 LEFT JOIN admins a ON t.set_by_ref = 'admin:' || a.id::text
                WHERE t.kpi_id = ANY(?)
                  AND (t.scope_type = 'org' OR t.scope_id = ANY(?))
                ORDER BY t.created_at DESC, t.id DESC
                LIMIT 200`,
              [kpis, sites.map((s) => s.id)]
          )
        : [];
    return {
        today: day,
        kpis,
        sites,
        rows,
        history: (history || []).map((h) => ({
            ...h,
            id: Number(h.id),
            scopeId: h.scopeId === null || h.scopeId === undefined ? null : Number(h.scopeId),
            value: toNum(h.targetValue),
            unit: has(TARGETABLE, h.kpiId) ? TARGETABLE[h.kpiId].unit : null,
        })),
        canEditOrg: canOrg,
        editableSites,
        canEdit: canOrg || editableSites.length > 0,
    };
}

module.exports = {
    PERMISSION,
    TARGETABLE,
    TargetError,
    isTargetable,
    targetableIds,
    targetFor,
    meetsTarget,
    canManage,
    canView,
    setTarget,
    overview,
    parseValue,
    _internal: { normScope, dayKey },
};
