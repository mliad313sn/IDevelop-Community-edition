'use strict';

/**
 * NarrativeService — « What changed » (migrations 187, 189).
 *
 * DETERMINISTIC, RULE-BASED, OFFLINE. No language model anywhere in this
 * path: every sentence is a fixed template (locales/{fr,en}/dash.json, keys
 * `nar_*`) filled with figures read from kpi_snapshots. The same snapshots
 * always give the same sentences: reproducible and auditable. A sentence
 * names an indicator and a unit (a site, a department), never a person.
 *
 * RULES
 *   - Same contract only: the latest row and the comparison row carry the
 *     SAME kpi_contract (KpiService.CONTRACT_VERSION). A movement never
 *     crosses a change of definition.
 *   - No prior row, no movement: « History starts on dd/mm/yyyy ».
 *   - Never « +0 »: a movement that rounds to zero, or smaller than the
 *     indicator's threshold, is no sentence.
 *   - Small n: a % sentence needs 5 people or more on BOTH sides; a scope of
 *     fewer than 5 people says nothing at all (state 'small_n').
 *   - NULL is never 0: an unmeasured side gives no sentence.
 *   - At most 3 sentences, in a FIXED order (never ranked by size: the order
 *     a reader sees never depends on the data).
 *   - Module- and capability-aware: a sentence is written only about an
 *     indicator the reader's dashboard shows (the capability set of
 *     DashboardHomeService.capabilities) and whose module is on; an indicator
 *     of a module that is off is omitted, never « not measured ».
 *
 * CLEARANCE: whatChanged() reads a SNAPSHOT scope (organisation, site,
 * department) and is unscoped by design. snapshotScopeFor() decides which
 * snapshot scope a viewer may read: the viewer's cleared population inside
 * the unit must BE the unit's whole population, otherwise nothing.
 */

const KpiSnapshotService = require('./KpiSnapshotService');
const { fmtNum, fmtPct } = require('../utils/kpiFormat');
const { fmtDate } = require('../utils/dateFormat');

const TEXT = {
    fr: require('../../locales/fr/dash.json'),
    en: require('../../locales/en/dash.json'),
};

const SMALL_N = 5;
const MAX_SENTENCES = 3;
const round1 = (v) => Math.round(v * 10) / 10;
const isNum = (v) =>
    v !== null &&
    v !== undefined &&
    v !== '' &&
    typeof v !== 'boolean' &&
    Number.isFinite(Number(v));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** One template, FR fallback; `{{x}}` filled once; `_one` / `_other` by `count`. */
function phrase(lang, key, vars) {
    const l = lang === 'en' ? 'en' : 'fr';
    const v = vars || {};
    let k = key;
    if (isNum(v.count) && (has(TEXT[l], `${key}_one`) || has(TEXT.fr, `${key}_one`))) {
        k = Number(v.count) === 1 ? `${key}_one` : `${key}_other`;
    }
    const s = has(TEXT[l], k) ? TEXT[l][k] : has(TEXT.fr, k) ? TEXT.fr[k] : null;
    if (typeof s !== 'string') return '';
    return s.replace(/\{\{(\w+)\}\}/g, (m, name) => (has(v, name) ? String(v[name]) : ''));
}

/** A day 'YYYY-MM-DD' printed in the reader's language (noon: no zone shift). */
function day(d, lang) {
    if (!d) return '';
    const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? fmtDate(new Date(s + 'T12:00:00'), lang) : '';
}

/** A signed movement: « +3 pts », « −1.5 pts », « +2 ». */
function signed(delta, unit, lang) {
    const digits = unit === 'pct' && Math.abs(delta) < 1 ? 1 : 0;
    const n = fmtNum(Math.abs(delta), digits, lang);
    const sign = delta > 0 ? '+' : '−';
    return unit === 'pct' ? `${sign}${n} ${phrase(lang, 'nar_pts')}` : `${sign}${n}`;
}

/** K1 % from the four-state counts of a row: Ready ÷ (Ready + Not ready). */
function k1Of(row) {
    if (!row || !isNum(row.roleReadyCount) || !isNum(row.notReadyCount)) return null;
    const n = Number(row.roleReadyCount) + Number(row.notReadyCount);
    if (!n) return null;
    return { value: round1((100 * Number(row.roleReadyCount)) / n), n };
}

/**
 * The metrics a sentence can be about. `read(row)` gives {value, n} or null.
 * `better`: the good direction (a movement is coloured by it, never by its
 * sign). `threshold`: the smallest movement worth a sentence. `cap`: the
 * dashboard capability that shows it; `module`: its optional module (null =
 * core). `drill`: the list behind it (DashboardHomeService DRILLS), or null.
 */
const METRICS = Object.freeze({
    K1: {
        unit: 'pct',
        better: 'up',
        threshold: 1,
        cap: 'pop',
        module: null,
        read: k1Of,
        drill: ['K1', 'not_ready'],
    },
    K3: {
        unit: 'pct',
        better: 'up',
        threshold: 2,
        cap: 'pop',
        module: null,
        read: (r) =>
            isNum(r.assessmentCoverage)
                ? {
                      value: Number(r.assessmentCoverage),
                      n: isNum(r.totalEmployees) ? Number(r.totalEmployees) : null,
                  }
                : null,
        drill: null,
    },
    K9: {
        unit: 'pct',
        safety: true,
        better: 'up',
        threshold: 1,
        cap: 'safety',
        module: null,
        read: (r) =>
            isNum(r.safetyFitPct)
                ? {
                      value: Number(r.safetyFitPct),
                      n: isNum(r.safetyFitN) ? Number(r.safetyFitN) : null,
                  }
                : null,
        drill: ['K9', 'unfit'],
    },
    K8x: {
        unit: 'count',
        better: 'down',
        threshold: 1,
        cap: 'safety',
        module: null,
        read: (r) => (isNum(r.certsExpired) ? { value: Number(r.certsExpired) } : null),
        drill: ['K8', 'expired'],
    },
    K8e: {
        unit: 'count',
        better: 'down',
        threshold: 1,
        cap: 'safety',
        module: null,
        read: (r) => (isNum(r.certsExpiring90d) ? { value: Number(r.certsExpiring90d) } : null),
        drill: ['K8', 'expiring'],
    },
    K4u: {
        unit: 'count',
        better: 'down',
        threshold: 1,
        cap: 'safety',
        module: null,
        read: (r) => (isNum(r.criticalUnassessed) ? { value: Number(r.criticalUnassessed) } : null),
        drill: null,
    },
    K6: {
        unit: 'count',
        better: 'down',
        threshold: 1,
        cap: 'continuity',
        module: 'talent',
        read: (r) =>
            isNum(r.criticalRolesWithoutReady)
                ? { value: Number(r.criticalRolesWithoutReady) }
                : null,
        drill: ['K6', 'uncovered'],
    },
    K7: {
        unit: 'count',
        better: 'down',
        threshold: 1,
        cap: 'continuity',
        module: 'talent',
        read: (r) => (isNum(r.soleHolderCount) ? { value: Number(r.soleHolderCount) } : null),
        drill: ['K7', 'cells'],
    },
});

/** The fixed sentence order. */
const ORDER = Object.freeze(['K1', 'K9', 'K3', 'K8x', 'K6', 'K7', 'K8e', 'K4u']);

/**
 * The order restricted to what the reader's dashboard shows: the capability
 * of each metric held and its module on. Without capabilities: core only.
 */
function orderFor(o = {}) {
    const caps =
        o.capabilities && typeof o.capabilities === 'object' ? o.capabilities : { pop: true };
    const flags = o.flags && typeof o.flags === 'object' ? o.flags : {};
    return ORDER.filter((id) => {
        const m = METRICS[id];
        if (m.module && flags[m.module] !== true) return false;
        return m.cap === 'pop' ? caps.pop !== false : !!caps[m.cap];
    });
}

/**
 * One sentence for one metric, or null: the whole rule set.
 * @returns {null | {kpi, text, delta, polarity, href, value, n}}
 */
function sentenceFor(id, now, then, lang, hrefOf) {
    const m = METRICS[id];
    if (!m) return null;
    const a = m.read(now || {});
    const b = m.read(then || {});
    if (!a || !b) return null; // an unmeasured side: no movement, never 0
    if (m.unit === 'pct' && (!(a.n >= SMALL_N) || !(b.n >= SMALL_N))) return null;
    const delta = round1(round1(a.value) - round1(b.value));
    if (delta === 0 || Math.abs(delta) < m.threshold) return null; // never « +0 »
    const better = m.better === 'up' ? delta > 0 : delta < 0;
    const vars = { delta: signed(delta, m.unit, lang) };
    if (m.unit === 'pct') {
        // a safety % printed whole is ROUNDED DOWN: 99.5 % with someone unfit
        // never reads « 100 % »
        const shown = m.safety ? Math.floor(a.value) : Math.round(a.value);
        vars.value = fmtPct(shown, 0, lang);
        vars.n = fmtNum(a.n, 0, lang);
        vars.count = a.n;
    } else {
        vars.count = a.value;
        vars.countText = fmtNum(a.value, 0, lang);
    }
    const href =
        m.drill && typeof hrefOf === 'function' ? hrefOf(m.drill[0], m.drill[1]) || null : null;
    return {
        kpi: id,
        text: phrase(lang, `nar_${id.toLowerCase()}`, vars),
        delta,
        polarity: better ? 'better' : 'worse',
        href,
        value: a.value,
        n: m.unit === 'pct' ? a.n : null,
    };
}

function normScope(scope) {
    const s = scope || {};
    const type = ['org', 'site', 'department'].includes(s.type) ? s.type : 'org';
    return { type, id: type === 'org' ? 0 : Number(s.id) || 0, label: s.label || null };
}

/** The day `days` after a 'YYYY-MM-DD' day, or null. */
function plusDays(d, days) {
    const x = new Date(String(d).slice(0, 10) + 'T12:00:00Z');
    if (Number.isNaN(x.getTime())) return null;
    x.setUTCDate(x.getUTCDate() + days);
    return x.toISOString().slice(0, 10);
}

const NarrativeService = {
    METRICS,
    ORDER,
    SMALL_N,
    MAX_SENTENCES,
    phrase,
    orderFor,

    /**
     * « What changed » for one SNAPSHOT scope.
     * @param {{type:'org'|'site'|'department', id?:number, label?:string}} scope
     * @param {{days?:number, capabilities?:object, flags?:object, locale?:string,
     *          max?:number, hrefOf?:function}} [o]
     *   hrefOf(kpi, part): the list behind a figure for THIS reader, or null.
     * @returns {Promise<{state: 'changes'|'no_change'|'history_start'|'no_history'|'small_n',
     *   scope, days, asOf, since, historySince, nextComparison, line, sentences}>}
     */
    async whatChanged(scope, o = {}) {
        const s = normScope(scope);
        const days = Math.max(1, Math.min(366, Number(o.days) || 7));
        const lang = o.locale === 'en' ? 'en' : 'fr';
        const order = orderFor(o);
        const max = Math.max(1, Math.min(MAX_SENTENCES, Number(o.max) || MAX_SENTENCES));
        const contract = KpiSnapshotService.currentContract();
        const out = {
            state: 'no_history',
            scope: s,
            days,
            asOf: null,
            since: null,
            historySince: null,
            nextComparison: null,
            line: null,
            sentences: [],
        };
        const now = await KpiSnapshotService.latest(s.type, s.id, contract);
        if (!now) return out;
        out.asOf = now.date;
        if (!(isNum(now.totalEmployees) && Number(now.totalEmployees) >= SMALL_N)) {
            out.state = 'small_n';
            out.line = phrase(lang, 'nar_small_n');
            return out;
        }
        const then = await KpiSnapshotService.priorTo(s.type, s.id, now.date, days, contract);
        if (!then) {
            out.state = 'history_start';
            out.historySince =
                (await KpiSnapshotService.firstDate(s.type, s.id, contract)) || now.date;
            out.nextComparison = plusDays(out.historySince, days);
            out.line = out.nextComparison
                ? phrase(lang, 'nar_history_since', {
                      date: day(out.historySince, lang),
                      next: day(out.nextComparison, lang),
                  })
                : phrase(lang, 'nar_history_since_only', { date: day(out.historySince, lang) });
            return out;
        }
        out.since = then.date;
        if (!(isNum(then.totalEmployees) && Number(then.totalEmployees) >= SMALL_N)) {
            out.state = 'small_n';
            out.line = phrase(lang, 'nar_small_n');
            return out;
        }
        for (const id of order) {
            if (out.sentences.length >= max) break;
            const st = sentenceFor(id, now, then, lang, o.hrefOf);
            if (st) out.sentences.push(st);
        }
        const since = day(then.date, lang);
        if (!out.sentences.length) {
            out.state = 'no_change';
            out.line = phrase(lang, 'nar_no_change', { date: since });
        } else {
            out.state = 'changes';
            out.line = phrase(lang, 'nar_since', { date: since });
        }
        return out;
    },

    /**
     * The snapshot scope a VIEWER may read for a screen scope, or null. A
     * unit is readable only when the viewer's cleared population inside it IS
     * the unit's whole population (nobody hidden by clearance): otherwise a
     * snapshot would aggregate people the viewer may not see.
     * @param {object} viewer req.user-like
     * @param {{siteId?:number, departmentId?:number}} [screen]
     */
    async snapshotScopeFor(viewer, screen = {}) {
        const K = require('./KpiService');
        const present = (v) => v !== undefined && v !== null && v !== '';
        const hasSite = present(screen.siteId);
        const hasDep = present(screen.departmentId);
        if (hasSite && hasDep) return null; // no row is « this department within this site »
        if (hasSite && (screen.siteId === 'none' || !Number.isFinite(Number(screen.siteId))))
            return null;
        if (hasDep && !Number.isFinite(Number(screen.departmentId))) return null;
        const narrow = {};
        if (hasSite) narrow.siteId = Number(screen.siteId);
        if (hasDep) narrow.departmentId = Number(screen.departmentId);
        const mine = await K.resolvePopulation({ viewer, ...narrow });
        const all = await K.resolvePopulation({ system: true, ...narrow });
        if (!all.ids.length || mine.ids.length !== all.ids.length) return null;
        if (hasDep) return { type: 'department', id: Number(screen.departmentId) };
        if (hasSite) return { type: 'site', id: Number(screen.siteId) };
        return { type: 'org', id: 0 };
    },

    /**
     * The viewer-safe entry point: the whatChanged() result, or
     * { state: 'not_available' } when no snapshot scope matches the screen.
     */
    async forViewer(viewer, o = {}) {
        const scope = await NarrativeService.snapshotScopeFor(viewer, o);
        if (!scope) {
            return {
                state: 'not_available',
                scope: null,
                asOf: null,
                since: null,
                historySince: null,
                line: null,
                sentences: [],
            };
        }
        return NarrativeService.whatChanged(scope, o);
    },

    _test: { sentenceFor, k1Of, signed, plusDays },
};

module.exports = NarrativeService;
