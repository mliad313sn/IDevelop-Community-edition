'use strict';

/**
 * BoardPackService — what the board pack (/exec/board-pack) adds to the
 * dashboard's figures, and the decisions taken on it (/exec/decisions).
 * 4.0.0 port, wave 9; migrations 197 (board_decisions) and 198
 * (board_pack_runs).
 *
 *   Targets and gaps      for each indicator of the pack: its target (the
 *                         kpi_targets of the scope, KpiTargetService), the gap
 *                         on the DISPLAYED values, when the target was set and
 *                         by which ROLE, and the 90-day trend from snapshots of
 *                         the same contract.
 *   Since the last pack   a pack recorded as presented (an explicit action)
 *                         keeps its printed values, its population ids, its
 *                         coverage and its KPI contract; the next pack of the
 *                         same scope compares with THAT pack: entries and
 *                         exits, then → now per indicator. Under another KPI
 *                         contract it says the definitions changed and prints
 *                         no delta.
 *   Site deltas           the K1 (and K9) movement over 90 days per site, from
 *                         the site's own snapshots, only where the reader sees
 *                         the whole site; a site under 5 people prints none.
 *   Decisions             recorded on a pack scope, owner = a ROLE, followed
 *                         by state and notes, never deleted.
 *
 * SCOPE KEYS. A pack is kept under the key of its validated scope ('org',
 * 'site:<id>', 'site:none', 'dept:<id>', 'site:<id>/dept:<id>') ONLY when the
 * reader sees the whole of that unit (their population of it is the whole
 * population of it). Any other reader keeps their packs and decisions under
 * their own key, 'reader:<admin|employee|manager>:<id>[/<unit>]', so a line
 * manager never reads nor moves the committee's decisions of a site, and
 * their recorded pack never becomes the committee's « last pack ».
 *
 * NO NAME. Nothing here reads a person's name: owners are roles, people are
 * counts, recorded populations are internal ids. The free text of a decision
 * is checked for a person's name before it is written
 * (src/utils/boardNameGuard.js).
 */

const db = require('../config/database');
const P = require('../utils/kpiPredicates');
const { displayedValue } = require('../utils/displayedValue');

const K = () => require('./KpiService');
const D = () => require('./DashboardHomeService');
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const round1 = (v) => Math.round(v * 10) / 10;
const SMALL_N = P.SMALL_N;

/** The roles a decision may be given to (migration 197 CHECK). */
const OWNER_ROLES = Object.freeze([
    'exec_committee',
    'hr_director',
    'hse',
    'site',
    'training',
    'hr_local',
    'managers',
    'finance',
]);
const STATES = Object.freeze(['open', 'in_progress', 'done', 'dropped']);
const CLOSED = Object.freeze(['done', 'dropped']);
/** The indicators a decision may be linked to. */
const DECISION_KPIS = Object.freeze([
    'K1',
    'K3',
    'K4',
    'K5',
    'K6',
    'K7',
    'K8',
    'K9',
    'K11',
    'K13',
    'K16',
    'K17',
    'K19',
    'K20',
    'K21',
    'K30',
]);
/**
 * The rows of « Targets and gaps », in reading order, with the precision the
 * pack PRINTS (the gap and « reached » are decided on that printed value; a
 * safety % rounds down).
 */
const TARGET_ROWS = Object.freeze([
    { id: 'K1', unit: 'pct', display: 'pct1', polarity: 'higher' },
    { id: 'K3', unit: 'pct', display: 'pct1', polarity: 'higher' },
    { id: 'K4', unit: 'pct', display: 'pct1Floor', polarity: 'higher' },
    { id: 'K9', unit: 'pct', display: 'pct1Floor', polarity: 'higher' },
    { id: 'K8', unit: 'count', display: 'count', polarity: 'lower' },
    { id: 'K5', unit: 'pct', display: 'pct1', polarity: 'higher' },
    { id: 'K6', unit: 'count', display: 'count', polarity: 'lower' },
    { id: 'K7', unit: 'count', display: 'count', polarity: 'lower' },
    { id: 'K17', unit: 'days', display: 1, polarity: 'lower' },
]);
const DISPLAY_OF = new Map(TARGET_ROWS.map((r) => [r.id, r.display]));

/** The snapshot reading of an indicator (small-n points are null, never a value). */
const k1PctOf = (r) => {
    if (!r || !isNum(r.roleReadyCount) || !isNum(r.notReadyCount)) return null;
    const a = Number(r.roleReadyCount);
    const b = Number(r.notReadyCount);
    return a + b < SMALL_N ? null : round1((100 * a) / (a + b));
};
const numOf = (key) => (r) => (r && isNum(r[key]) ? Number(r[key]) : null);
const SNAP_POINT = Object.freeze({
    K1: k1PctOf,
    K3: numOf('assessmentCoverage'),
    K4: numOf('criticalCompliance'),
    K9: numOf('safetyFitPct'),
    K5: numOf('benchStrengthPct'),
    K6: numOf('criticalRolesWithoutReady'),
    K7: numOf('soleHolderCount'),
    K8: numOf('certsExpired'),
});
const DELTA_DAYS = 90;
/** A « 90 days ago » point may be 90 to 135 days old, never a year-old row. */
const DELTA_MAX_DAYS = 135;

class BoardError extends Error {
    constructor(code, status = 400) {
        super(code);
        this.code = code;
        this.status = status;
    }
}

/** 'admin:5' / 'manager:12' / 'employee:12' for a signed-in user. */
function actorRef(user) {
    const u = user || {};
    const kind =
        u.userType === 'admin' ? 'admin' : u.userType === 'manager' ? 'manager' : 'employee';
    return `${kind}:${Number(u.id)}`;
}

/** May this reader record decisions, move them and record packs? (a read-only admin may not) */
function canWrite(user) {
    if (!user) return false;
    if (user.userType === 'manager') return true;
    return user.userType === 'admin' && user.role !== 'viewer';
}

// ---------------------------------------------------------------------------
// Scope keys
// ---------------------------------------------------------------------------

/** The unit key of a validated dashboard scope ({site?, department?}); 'org' when none. Pure. */
function unitKey(scope) {
    const s = scope || {};
    const dept = s.department !== undefined && s.department !== null ? Number(s.department) : null;
    if (s.site === 'none') return dept === null ? 'site:none' : `dept:${dept}`;
    const site = s.site !== undefined && s.site !== null ? Number(s.site) : null;
    if (site !== null && dept !== null) return `site:${site}/dept:${dept}`;
    if (dept !== null) return `dept:${dept}`;
    if (site !== null) return `site:${site}`;
    return 'org';
}

/** The reader's own key, optionally narrowed to a unit. Pure. */
function readerKey(user, unit) {
    const base = `reader:${actorRef(user)}`;
    return unit && unit !== 'org' ? `${base}/${unit}` : base;
}

/** The system population of a unit key (the whole unit, whatever the reader sees). */
async function unitPopulation(key) {
    const sys = { system: true };
    let m = /^site:(none|\d+)$/.exec(key);
    if (m) sys.siteId = m[1] === 'none' ? 'none' : Number(m[1]);
    m = /^dept:(\d+)$/.exec(key);
    if (m) sys.departmentId = Number(m[1]);
    m = /^site:(\d+)\/dept:(\d+)$/.exec(key);
    if (m) {
        sys.siteId = Number(m[1]);
        sys.departmentId = Number(m[2]);
    }
    return K().resolvePopulation(sys);
}

/**
 * The key a reader reads and writes for the scope of `ctx` (DashboardHomeService
 * context): the unit's shared key only when the reader's population of the
 * scope IS the whole unit; their own reader key otherwise.
 */
async function scopeKeyFor(ctx) {
    const unit = unitKey(ctx.scope);
    const whole = await unitPopulation(unit);
    const mine = new Set((ctx.pop.ids || []).map(Number));
    const same =
        whole.ids.length > 0 &&
        whole.ids.length === mine.size &&
        whole.ids.every((id) => mine.has(Number(id)));
    return same ? unit : readerKey(ctx.user, unit);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** The database's calendar day: one clock for every board date. */
async function today() {
    const row = await db.get(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS "d"`);
    return (row && row.d) || new Date().toISOString().slice(0, 10);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** '' / null → null; a real calendar day → it; anything else → undefined. Pure. */
function dayOf(v) {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).trim();
    if (s.length !== 10 || !DAY.test(s)) return undefined;
    const d = new Date(s + 'T00:00:00Z');
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? undefined : s;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const text = (v) => {
    const x = one(v);
    return typeof x === 'string' ? x.trim() : '';
};

/** A decision from the form, validated. Pure; throws BoardError. */
function parseDecision(body, todayIso) {
    const b = body || {};
    const t = text(b.decisionText);
    if (!t) throw new BoardError('text_required');
    if (t.length > 2000) throw new BoardError('text_too_long');
    const role = text(b.ownerRole);
    if (!OWNER_ROLES.includes(role)) throw new BoardError('owner_role');
    const decided = dayOf(one(b.decidedAt));
    if (decided === undefined) throw new BoardError('decided_at');
    const decidedAt = decided || todayIso;
    if (decidedAt > todayIso) throw new BoardError('decided_future');
    const pack = dayOf(one(b.packDate));
    if (pack === undefined) throw new BoardError('pack_date');
    const due = dayOf(one(b.dueDate));
    if (due === undefined) throw new BoardError('due_date');
    if (due && due < decidedAt) throw new BoardError('due_before');
    const kpi = text(b.kpiId);
    if (kpi && !DECISION_KPIS.includes(kpi)) throw new BoardError('kpi');
    return {
        text: t,
        ownerRole: role,
        decidedAt,
        packDate: pack || decidedAt,
        dueDate: due || null,
        kpiId: kpi || null,
    };
}

/** A decision id from the URL: a whole number, else « not found ». Pure. */
function decisionId(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw);
    if (s.length < 1 || s.length > 18 || !/^[1-9][0-9]*$/.test(s))
        throw new BoardError('not_found', 404);
    return Number(s);
}

async function audit(action, id, details, user) {
    try {
        await require('./LogService').log({
            action,
            entityType: 'board_decision',
            entityId: Number(id),
            actorRef: actorRef(user),
            details,
        });
    } catch (_) {
        /* the event row is the record; the audit line is best effort */
    }
}

async function refuseNames(t, user) {
    const { boardTextNamesSomeone } = require('../utils/boardNameGuard');
    if (await boardTextNamesSomeone(t, user)) throw new BoardError('person_name');
}

/** Record a decision on the pack scope `scopeKey` (from the VALIDATED scope). Returns its id. */
async function createDecision(scopeKey, body, user) {
    if (!canWrite(user)) throw new BoardError('forbidden', 403);
    const d = parseDecision(body, await today());
    await refuseNames(d.text, user);
    const ref = actorRef(user);
    const id = await db.runTransaction(async () => {
        const row = await db.get(
            `INSERT INTO board_decisions (scope_key, pack_date, decided_at, decision_text, owner_role,
                                          due_date, kpi_id, state, created_by_ref)
             VALUES (?, ?::date, ?::date, ?, ?, ?::date, ?, 'open', ?)
             RETURNING id`,
            [scopeKey, d.packDate, d.decidedAt, d.text, d.ownerRole, d.dueDate, d.kpiId, ref]
        );
        await db.run(
            `INSERT INTO board_decision_events (decision_id, kind, to_state, actor_ref)
             VALUES (?, 'created', 'open', ?)`,
            [row.id, ref]
        );
        return Number(row.id);
    });
    await audit('BOARD_DECISION_CREATE', id, `owner ${d.ownerRole}`, user);
    return id;
}

/** Move the follow-up state of a decision of THIS scope. Dropping needs a reason. */
async function setState(rawId, scopeKey, body, user) {
    if (!canWrite(user)) throw new BoardError('forbidden', 403);
    const id = decisionId(rawId);
    const to = text((body || {}).state);
    if (!STATES.includes(to)) throw new BoardError('state');
    const note = text((body || {}).note);
    if (note.length > 2000) throw new BoardError('text_too_long');
    if (to === 'dropped' && !note) throw new BoardError('reason_required');
    if (note) await refuseNames(note, user);
    const ref = actorRef(user);
    await db.runTransaction(async () => {
        const row = await db.get(
            'SELECT id, state FROM board_decisions WHERE id = ? AND scope_key = ? FOR UPDATE',
            [id, scopeKey]
        );
        // a decision of another scope is « not found », never acted upon
        if (!row) throw new BoardError('not_found', 404);
        if (row.state === to) throw new BoardError('same_state', 409);
        await db.run(
            `UPDATE board_decisions
                SET state = ?, state_changed_at = now(),
                    closed_at = CASE WHEN ? IN ('done', 'dropped') THEN now() ELSE NULL END
              WHERE id = ?`,
            [to, to, id]
        );
        await db.run(
            `INSERT INTO board_decision_events (decision_id, kind, from_state, to_state, note, actor_ref)
             VALUES (?, 'state', ?, ?, ?, ?)`,
            [id, row.state, to, note || null, ref]
        );
    });
    await audit('BOARD_DECISION_STATE', id, `-> ${to}`, user);
}

/** Add a follow-up note to a decision of THIS scope (append-only). */
async function addNote(rawId, scopeKey, body, user) {
    if (!canWrite(user)) throw new BoardError('forbidden', 403);
    const id = decisionId(rawId);
    const note = text((body || {}).note);
    if (!note) throw new BoardError('note_required');
    if (note.length > 2000) throw new BoardError('text_too_long');
    await refuseNames(note, user);
    const row = await db.get('SELECT id FROM board_decisions WHERE id = ? AND scope_key = ?', [
        id,
        scopeKey,
    ]);
    if (!row) throw new BoardError('not_found', 404);
    await db.run(
        `INSERT INTO board_decision_events (decision_id, kind, note, actor_ref)
         VALUES (?, 'note', ?, ?)`,
        [id, note, actorRef(user)]
    );
    await audit('BOARD_DECISION_NOTE', id, 'note', user);
}

/**
 * The decisions of a scope with their history. `forPack` keeps what a
 * meeting reads: every decision still open or in progress, and those closed
 * since `closedSince` (the previous recorded pack, else 90 days). Event rows
 * carry no author; `mine` says which are the reader's own. null when the
 * table is not there yet (migration 197 not applied).
 */
async function listDecisions(
    scopeKey,
    { forPack = false, closedSince = null, viewer = null } = {}
) {
    let rows;
    try {
        rows = await db.runInSavepoint(() =>
            db.all(
                `SELECT id, to_char(pack_date, 'YYYY-MM-DD') AS "packDate",
                        to_char(decided_at, 'YYYY-MM-DD') AS "decidedAt",
                        decision_text AS "text", owner_role AS "ownerRole",
                        to_char(due_date, 'YYYY-MM-DD') AS "dueDate", kpi_id AS "kpiId", state,
                        to_char(closed_at, 'YYYY-MM-DD') AS "closedOn",
                        (due_date IS NOT NULL AND due_date < CURRENT_DATE
                           AND state IN ('open', 'in_progress')) AS "late"
                   FROM board_decisions
                  WHERE scope_key = ?
                    AND (? = false OR state IN ('open', 'in_progress')
                         OR closed_at >= COALESCE(?::date::timestamptz, now() - interval '90 days'))
                  ORDER BY CASE state WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                           due_date NULLS LAST, decided_at DESC, id DESC`,
                [scopeKey, !!forPack, closedSince]
            )
        );
    } catch (e) {
        if (e && /board_decisions/.test(String(e.message))) return null;
        throw e;
    }
    const list = (rows || []).map((r) => ({
        ...r,
        id: Number(r.id),
        late: r.late === true || r.late === 't',
        events: [],
    }));
    if (!list.length) return list;
    const ev = await db.all(
        `SELECT decision_id AS "decisionId", kind, from_state AS "fromState", to_state AS "toState",
                note, actor_ref AS "actorRef", to_char(created_at, 'YYYY-MM-DD') AS "on"
           FROM board_decision_events WHERE decision_id = ANY(?) ORDER BY id`,
        [list.map((r) => r.id)]
    );
    const me = viewer ? actorRef(viewer) : null;
    const byId = new Map(list.map((r) => [r.id, r]));
    for (const e of ev || []) {
        const d = byId.get(Number(e.decisionId));
        if (!d) continue;
        d.events.push({
            kind: e.kind,
            fromState: e.fromState,
            toState: e.toState,
            note: e.note,
            on: e.on,
            mine: !!(me && e.actorRef === me),
        });
    }
    return list;
}

// ---------------------------------------------------------------------------
// Snapshots: trends of the same contract
// ---------------------------------------------------------------------------

/** The snapshots of a recorded scope under the CURRENT contract only. */
async function sameContractSeries(snap) {
    if (!snap) return [];
    try {
        const rows = await require('./KpiSnapshotService').series(
            snap.scopeType,
            snap.scopeId,
            400
        );
        return (rows || []).filter((r) => r.kpiContract === K().CONTRACT_VERSION);
    } catch (_) {
        return [];
    }
}

/** The latest snapshot and the one 90 to 135 days before it. Pure. */
function snapPair(rows, pointFn) {
    const list = (rows || []).filter((r) => r && r.date);
    if (!list.length) return { now: null, then: null, nowDate: null, thenDate: null };
    const last = list[list.length - 1];
    const lastDay = Date.parse(String(last.date).slice(0, 10) + 'T00:00:00Z');
    let then = null;
    for (let i = list.length - 1; i >= 0; i--) {
        const age = Math.round(
            (lastDay - Date.parse(String(list[i].date).slice(0, 10) + 'T00:00:00Z')) / 86400000
        );
        if (age >= DELTA_DAYS && age <= DELTA_MAX_DAYS) {
            then = list[i];
            break;
        }
        if (age > DELTA_MAX_DAYS) break;
    }
    return {
        now: pointFn(last),
        then: then ? pointFn(then) : null,
        nowDate: last.date,
        thenDate: then ? then.date : null,
    };
}

/** The 90-day trend of an indicator: { delta, since } or { delta: null, reason }. Pure. */
function trendOf(rows, kpiId) {
    const fn = Object.prototype.hasOwnProperty.call(SNAP_POINT, kpiId) ? SNAP_POINT[kpiId] : null;
    if (!fn) return { delta: null, reason: 'not_tracked' };
    if (!rows || !rows.length) return { delta: null, reason: 'no_history' };
    const p = snapPair(rows, fn);
    if (p.thenDate === null) return { delta: null, reason: 'no_history' };
    if (!isNum(p.now) || !isNum(p.then)) return { delta: null, reason: 'unmeasured' };
    return { delta: round1(Number(p.now) - Number(p.then)), since: p.thenDate, reason: null };
}

/**
 * How the linked indicator moved since a decision: the snapshot on (or just
 * before) the decision day against the latest one, same contract. A reason
 * otherwise, never an invented delta. Pure.
 */
function kpiSinceDecision(decision, rows) {
    if (!decision || !decision.kpiId) return null;
    const fn = Object.prototype.hasOwnProperty.call(SNAP_POINT, decision.kpiId)
        ? SNAP_POINT[decision.kpiId]
        : null;
    if (!fn) return { delta: null, reason: 'not_tracked' };
    const list = (rows || []).filter((r) => r && r.date);
    let at = null;
    for (const r of list) if (String(r.date).slice(0, 10) <= decision.decidedAt) at = r;
    if (!at) return { delta: null, reason: 'no_history' };
    const last = list[list.length - 1];
    if (last === at) return { delta: null, reason: 'too_recent' };
    const a = fn(at);
    const b = fn(last);
    if (!isNum(a) || !isNum(b)) return { delta: null, reason: 'unmeasured' };
    return { delta: round1(Number(b) - Number(a)), from: at.date, to: last.date, reason: null };
}

// ---------------------------------------------------------------------------
// Targets and gaps
// ---------------------------------------------------------------------------

/** The KPI results of the pack, by indicator id (the first screen's, plus K17). */
function resultsOf(screen, extra = {}) {
    const ind = (screen && screen.indicators) || {};
    const out = {};
    for (const def of TARGET_ROWS) {
        const r = Object.prototype.hasOwnProperty.call(extra, def.id) ? extra[def.id] : ind[def.id];
        if (r && typeof r === 'object' && !Array.isArray(r)) out[def.id] = r;
    }
    return out;
}

/** The target scope of a pack key: the organisation, a site, or none. Pure. */
function targetScopeOf(scopeKey) {
    if (scopeKey === 'org') return 'org';
    const m = /^site:(\d+)$/.exec(String(scopeKey || ''));
    return m ? { type: 'site', id: Number(m[1]) } : null;
}

/** Who set a target, as a ROLE label key (never a name). */
async function targetSetter(kpiId, tScope) {
    try {
        const scopeType = tScope === 'org' ? 'org' : 'site';
        const scopeId = tScope === 'org' ? null : Number(tScope.id);
        const row = await db.runInSavepoint(() =>
            db.get(
                `SELECT to_char(t.created_at, 'YYYY-MM-DD') AS "setOn", a.role::text AS "adminRole"
                   FROM kpi_targets t
                   LEFT JOIN admins a ON a.id = CASE WHEN t.set_by_ref ~ '^admin:[0-9]{1,12}$'
                                                     THEN substring(t.set_by_ref FROM 7)::bigint END
                  WHERE t.kpi_id = ? AND t.scope_type = ? AND t.scope_id IS NOT DISTINCT FROM ?::bigint
                    AND t.effective_from <= CURRENT_DATE
                  ORDER BY t.effective_from DESC, t.id DESC
                  LIMIT 1`,
                [kpiId, scopeType, scopeId]
            )
        );
        if (!row) return null;
        const role = ['superadmin', 'localadmin', 'viewer'].includes(row.adminRole)
            ? row.adminRole
            : null;
        return { setOn: row.setOn || null, roleKey: role ? `chrome:role_${role}` : null };
    } catch (_) {
        return null;
    }
}

/**
 * « Targets and gaps »: one row per indicator the pack shows. No target is
 * « no target », never a 0 line; the gap and « reached » are decided on the
 * PRINTED values; a figure under 5 people has no gap.
 */
async function targets({ results, scopeKey, series = [], flags = null }) {
    const T = require('./KpiTargetService');
    const tScope = targetScopeOf(scopeKey);
    const rows = [];
    for (const def of TARGET_ROWS) {
        const r = results[def.id];
        if (!r) continue;
        let t = null;
        if (tScope) {
            try {
                t = await T.targetFor(def.id, tScope === 'org' ? 'org' : tScope, null, {
                    flags: flags || undefined,
                });
            } catch (_) {
                t = null;
            }
        }
        const target = t && isNum(t.value) ? Number(t.value) : null;
        const shown = isNum(r.value) ? displayedValue(Number(r.value), def.display) : null;
        const shownT = target === null ? null : displayedValue(target, def.display);
        let gap = null;
        let reached = null;
        if (shown !== null && shownT !== null) {
            gap = round1(shown - shownT);
            reached = def.polarity === 'lower' ? shown <= shownT : shown >= shownT;
        }
        const who =
            target !== null ? await targetSetter(def.id, t.inherited ? 'org' : tScope) : null;
        rows.push({
            kpi: def.id,
            unit: def.unit,
            value: shown,
            status: r.status || null,
            smallN: r.status === 'small_n',
            notConfigured: r.status === 'not_configured',
            target,
            inherited: !!(t && t.inherited),
            effectiveFrom: (t && t.effectiveFrom) || null,
            gap,
            reached,
            setOn: who ? who.setOn : null,
            setByRoleKey: who ? who.roleKey : null,
            trend: trendOf(series, def.id),
        });
    }
    return { rows, targetScope: tScope ? true : false };
}

// ---------------------------------------------------------------------------
// Recorded packs
// ---------------------------------------------------------------------------

/** What a pack says, as stored in board_pack_runs.kpi_values (printed values). Pure. */
function runValues(results) {
    const out = {};
    for (const def of TARGET_ROWS) {
        const r = results[def.id];
        if (!r) continue;
        out[def.id] = {
            value: isNum(r.value) ? displayedValue(Number(r.value), def.display) : null,
            status: r.status || null,
            unit: def.unit,
        };
    }
    return out;
}

/** The population ids of a pack: whole numbers only, sorted, no duplicate. Pure. */
function populationIds(pop) {
    const set = new Set();
    for (const v of (pop && pop.ids) || []) {
        const n = Number(v);
        if (Number.isSafeInteger(n) && n > 0) set.add(n);
    }
    return [...set].sort((a, b) => a - b);
}

/** Record the pack as presented (an explicit action). Returns the run id. */
async function recordRun(scopeKey, { results, pop, coverage, snapshotDate }, user) {
    if (!canWrite(user)) throw new BoardError('forbidden', 403);
    const ids = populationIds(pop);
    const cov = isNum(coverage) ? Number(coverage) : null;
    const row = await db.get(
        `INSERT INTO board_pack_runs (scope_key, pack_date, kpi_contract, snapshot_date, population,
                                      population_ids, coverage, kpi_values, generated_by_ref)
         VALUES (?, ?::date, ?, ?::date, ?, ?::bigint[], ?, ?::jsonb, ?)
         RETURNING id`,
        [
            scopeKey,
            await today(),
            K().CONTRACT_VERSION,
            snapshotDate || null,
            ids.length,
            ids,
            cov,
            JSON.stringify(runValues(results)),
            actorRef(user),
        ]
    );
    await audit('BOARD_PACK_RECORDED', row.id, `population ${ids.length}`, user);
    return Number(row.id);
}

/**
 * Compare with the previous recorded pack. Pure.
 *   prev   { on, contract, population, ids, coverage, values } | null
 *   now    { values (runValues), ids, coverage }
 * Another contract: definitionsChanged and NO delta. A side under 5 people
 * prints no then/now value that could identify.
 */
function compareRuns(prev, now, contract) {
    if (!prev) return { previous: null };
    const nowIds = new Set((now.ids || []).map(Number));
    const thenIds = new Set((prev.ids || []).map(Number));
    let entered = 0;
    let exited = 0;
    for (const id of nowIds) if (!thenIds.has(id)) entered++;
    for (const id of thenIds) if (!nowIds.has(id)) exited++;
    const changed = prev.contract !== contract;
    const thenVals = prev.values && typeof prev.values === 'object' ? prev.values : {};
    const kpis = [];
    for (const def of TARGET_ROWS) {
        const a = Object.prototype.hasOwnProperty.call(thenVals, def.id) ? thenVals[def.id] : null;
        const b = now.values[def.id] || null;
        if (!a && !b) continue;
        const then = a && isNum(a.value) ? Number(a.value) : null;
        const cur = b && isNum(b.value) ? Number(b.value) : null;
        kpis.push({
            kpi: def.id,
            unit: def.unit,
            then,
            now: cur,
            delta: !changed && then !== null && cur !== null ? round1(cur - then) : null,
        });
    }
    const covNow = isNum(now.coverage) ? Number(now.coverage) : null;
    const covThen = isNum(prev.coverage) ? Number(prev.coverage) : null;
    const small = thenIds.size < SMALL_N || nowIds.size < SMALL_N;
    return {
        previous: { on: prev.on, population: Number(prev.population) || 0 },
        definitionsChanged: changed,
        population: {
            then: thenIds.size,
            now: nowIds.size,
            // fewer than 5 on a side: no entries / exits that could point at someone
            entered: small ? null : entered,
            exited: small ? null : exited,
        },
        coverage: {
            then: covThen,
            now: covNow,
            delta:
                !changed && covThen !== null && covNow !== null ? round1(covNow - covThen) : null,
        },
        kpis,
    };
}

/**
 * « Since the last pack »: the last pack of the same key recorded on an
 * EARLIER day (today's own recording is not « the last meeting »).
 */
async function sinceLast(scopeKey, { results, pop, coverage }) {
    let prev;
    let todayN = 0;
    try {
        const day = await today();
        prev = await db.runInSavepoint(() =>
            db.get(
                `SELECT to_char(generated_at, 'YYYY-MM-DD') AS "on", kpi_contract AS "contract",
                        population, population_ids AS "ids", coverage, kpi_values AS "values"
                   FROM board_pack_runs
                  WHERE scope_key = ? AND pack_date < ?::date
                  ORDER BY generated_at DESC, id DESC LIMIT 1`,
                [scopeKey, day]
            )
        );
        const n = await db.runInSavepoint(() =>
            db.get(
                `SELECT COUNT(*)::int AS "n" FROM board_pack_runs WHERE scope_key = ? AND pack_date = ?::date`,
                [scopeKey, day]
            )
        );
        todayN = n ? Number(n.n) || 0 : 0;
    } catch (e) {
        if (e && /board_pack_runs/.test(String(e.message))) return { available: false };
        throw e;
    }
    const cmp = compareRuns(
        prev || null,
        { values: runValues(results), ids: populationIds(pop), coverage },
        K().CONTRACT_VERSION
    );
    return { available: true, recordedToday: todayN, ...cmp };
}

// ---------------------------------------------------------------------------
// Site deltas
// ---------------------------------------------------------------------------

/**
 * The 90-day movement of K1 (and K9 with the safety clearance) per site,
 * from the site's own snapshots, same contract, only for a site the reader
 * sees whole and of 5 people or more. « — » with a reason otherwise.
 */
async function siteDeltas(ctx) {
    const groups = new Map();
    for (const r of (ctx.pop && ctx.pop.rows) || []) {
        const k = r.siteId == null ? 'none' : String(r.siteId);
        if (!groups.has(k)) groups.set(k, { siteId: r.siteId, siteName: r.siteName, ids: [] });
        groups.get(k).ids.push(r.id);
    }
    if (groups.size < 2) return [];
    const out = [];
    for (const [k, g] of groups) {
        if (k === 'none') {
            out.push({ siteId: null, noSite: true, k1: { delta: null, reason: 'no_snapshot' } });
            continue;
        }
        if (g.ids.length < SMALL_N) {
            out.push({ siteId: null, small: true, k1: { delta: null, reason: 'small_n' } });
            continue;
        }
        const whole = await K().resolvePopulation({ system: true, siteId: Number(g.siteId) });
        const mine = new Set(g.ids.map(Number));
        const same =
            whole.ids.length === mine.size && whole.ids.every((id) => mine.has(Number(id)));
        const rows = same
            ? await sameContractSeries({ scopeType: 'site', scopeId: Number(g.siteId) })
            : [];
        const one = (kpi) =>
            same ? trendOf(rows, kpi) : { delta: null, reason: 'not_comparable' };
        out.push({
            siteId: Number(g.siteId),
            siteName: g.siteName || null,
            k1: one('K1'),
            k9: ctx.caps.safety ? one('K9') : null,
        });
    }
    // the small sites are one line, never named one by one
    const small = out.filter((r) => r.small);
    const rest = out
        .filter((r) => !r.small)
        .sort((a, b) =>
            a.noSite !== b.noSite
                ? a.noSite
                    ? 1
                    : -1
                : String(a.siteName || '').localeCompare(String(b.siteName || ''))
        );
    if (small.length)
        rest.push({
            siteId: null,
            small: true,
            count: small.length,
            k1: { delta: null, reason: 'small_n' },
            k9: ctx.caps.safety ? { delta: null, reason: 'small_n' } : null,
        });
    return rest;
}

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

/**
 * What the board pack adds for one validated scope (`ctx` from
 * DashboardHomeService.context, `screen` from firstScreen). Gates: K20 needs
 * the safety clearance; K19 the continuity clearance and the talent module;
 * K17 is core; the Development section needs the development tab and module.
 */
async function packModel(ctx, screen, { t } = {}) {
    const Kpi = K();
    const scopeKey = await scopeKeyFor(ctx);
    const s = ctx.kpiScope;
    const extra = {};
    extra.K17 = await Kpi.compute('K17', s);
    const results = resultsOf(screen, extra);
    let snap = null;
    try {
        snap = await D().snapshotScope(ctx);
    } catch (_) {
        snap = null;
    }
    const series = await sameContractSeries(snap);
    const coverage = screen && isNum(screen.coverage) ? Number(screen.coverage) : null;
    const since = await sinceLast(scopeKey, { results, pop: ctx.pop, coverage });
    const closedSince = since && since.previous ? since.previous.on : null;
    const decisions = await listDecisions(scopeKey, { forPack: true, closedSince });
    const k20 = ctx.caps.safety ? await Kpi.compute('K20', s) : null;
    let k19 = null;
    if (ctx.caps.continuity && Kpi.isAvailable('K19', ctx.flags)) {
        const k19Scope = { viewer: ctx.user };
        if (ctx.scope && ctx.scope.site !== undefined) k19Scope.siteId = ctx.scope.site;
        if (ctx.scope && ctx.scope.department !== undefined)
            k19Scope.departmentId = ctx.scope.department;
        k19 = await Kpi.compute('K19', k19Scope);
    }
    let development = null;
    if (ctx.tabs.some((x) => x.id === 'development')) {
        const m = await D().tabModel(ctx, 'development', { query: {}, t });
        if (m && m.devOutcomes) development = { outcomes: m.devOutcomes, k13: m.k && m.k.K13 };
    }
    return {
        scopeKey,
        shared: !/^reader:/.test(scopeKey),
        canWrite: canWrite(ctx.user),
        snapshotDate: series.length ? series[series.length - 1].date : null,
        targets: await targets({ results, scopeKey, series, flags: ctx.flags }),
        since,
        decisions:
            decisions === null
                ? null
                : decisions.map((d) => ({ ...d, kpiSince: kpiSinceDecision(d, series) })),
        k17: extra.K17,
        k19,
        k20,
        siteDeltas: await siteDeltas(ctx),
        development,
        results,
        coverage,
    };
}

module.exports = {
    OWNER_ROLES,
    STATES,
    CLOSED,
    DECISION_KPIS,
    TARGET_ROWS,
    DISPLAY_OF,
    BoardError,
    actorRef,
    canWrite,
    unitKey,
    readerKey,
    scopeKeyFor,
    dayOf,
    parseDecision,
    decisionId,
    createDecision,
    setState,
    addNote,
    listDecisions,
    snapPair,
    trendOf,
    kpiSinceDecision,
    resultsOf,
    targetScopeOf,
    targets,
    runValues,
    populationIds,
    recordRun,
    compareRuns,
    sinceLast,
    siteDeltas,
    packModel,
};
