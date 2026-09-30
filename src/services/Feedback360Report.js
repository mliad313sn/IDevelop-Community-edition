'use strict';
/**
 * Feedback360Report — the 360° report, computed from answers that carry a rater
 * GROUP and nothing else. Pure: no I/O, no identity in, no identity out.
 *
 * ANONYMITY RULES (the product promise, pinned by tests/unit/feedback360Report.test.js)
 *
 *   1. Self and manager are NAMED groups: one person each, shown as such.
 *   2. Peers, direct reports and others are ANONYMOUS groups: shown only as an
 *      aggregate, and only when the group has at least `threshold` responses
 *      (default 3, never below 3).
 *   3. An anonymous group below the floor is MERGED into "others" when the
 *      merged group reaches the floor; otherwise every group in that pool is
 *      HIDDEN, with a message — its answers reach no number, no average, no
 *      comment and no "others' view" anywhere in the report. (A hidden group
 *      that still fed a combined figure could be recovered by subtraction.)
 *   4. The same floor applies per question: an aggregate is printed only when
 *      at least `threshold` raters of the shown groups OBSERVED the item.
 *   5. "Not observed" is not a rating. It is never counted as 0 and never
 *      enters an average or a denominator (the product's "not measured ≠ zero").
 *   6. Open comments are returned without names or groups, in a random order,
 *      and only from groups that are themselves shown.
 *
 * The output contains no rater id, no rater name (bar the subject and their
 * manager, passed in by the caller), no response id and no order of arrival.
 */
const crypto = require('crypto');
const C = require('../config/feedback360');

const AGG_ANON = ['peer', 'direct_report']; // may be merged into 'other'

function floorOf(threshold) {
    const n = Number(threshold);
    return Math.max(C.MIN_THRESHOLD, Number.isInteger(n) ? n : C.DEFAULT_THRESHOLD);
}

/** A valid rating 0..4, or null for "not observed" / anything else. */
function ratingOf(v) {
    if (v === null || v === undefined || v === '' || v === 'na') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 4 ? n : null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const mean = (xs) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Decide, from the response count of each group, which groups are shown,
 * merged into "others", hidden or empty.
 *
 * @param {Record<string, number>} counts responses per group
 * @param {number} threshold anonymity floor (clamped to ≥ 3)
 * @returns {{ threshold: number, state: Record<string,string>,
 *             target: Record<string,string|null>, othersSize: number|null,
 *             merged: string[] }}
 *   state:  'shown' | 'merged' | 'hidden' | 'empty'
 *   target: the display column a group's answers feed, or null (never shown)
 */
function resolveGroups(counts, threshold) {
    const t = floorOf(threshold);
    const n = (g) => Math.max(0, Number((counts && counts[g]) || 0));
    const state = {};
    const target = {};
    for (const g of C.NAMED_GROUPS) {
        state[g] = n(g) > 0 ? 'shown' : 'empty';
        target[g] = n(g) > 0 ? g : null;
    }
    let pool = n('other');
    const merged = [];
    for (const g of AGG_ANON) {
        if (n(g) >= t) {
            state[g] = 'shown';
            target[g] = g;
        } else if (n(g) > 0) {
            merged.push(g);
            pool += n(g);
        } else {
            state[g] = 'empty';
            target[g] = null;
        }
    }
    let othersSize = null;
    if (pool >= t) {
        state.other = 'shown';
        target.other = 'other';
        othersSize = pool;
        for (const g of merged) {
            state[g] = 'merged';
            target[g] = 'other';
        }
    } else {
        state.other = n('other') > 0 ? 'hidden' : 'empty';
        target.other = null;
        for (const g of merged) {
            state[g] = 'hidden';
            target[g] = null;
        }
    }
    return { threshold: t, state, target, othersSize, merged: pool >= t ? merged : [] };
}

/** Fisher–Yates with a CSPRNG: comment order must reveal nothing. */
function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Build the report.
 *
 * @param {object}   args
 * @param {Array<{type:'skill'|'behaviour', key:string, label:string, required?:number|null}>} args.items
 * @param {Array<{group:string, answers:Array<{itemType:string, itemKey:string, rating:any, body?:string}>}>} args.responses
 * @param {number}   [args.threshold]
 * @returns {object} report — see the doc comment at the top of this file
 */
function buildReport({ items = [], responses = [], threshold = C.DEFAULT_THRESHOLD } = {}) {
    const counts = {};
    for (const r of responses) {
        if (!C.GROUPS.includes(r && r.group)) continue;
        counts[r.group] = (counts[r.group] || 0) + 1;
    }
    const res = resolveGroups(counts, threshold);
    const t = res.threshold;

    // Group summary: a count is printed only for a SHOWN group. A hidden or
    // merged group says so, without its size.
    const groups = C.GROUPS.map((g) => {
        const st = res.state[g];
        const out = { key: g, state: st };
        if (st === 'shown') out.responses = g === 'other' ? res.othersSize : counts[g] || 0;
        if (g === 'other' && st === 'shown' && res.merged.length) out.mergedFrom = res.merged;
        if (st === 'merged') out.mergedInto = 'other';
        return out;
    });

    // Index the answers of the SHOWN columns only. A response whose group has
    // no target is dropped here, before any arithmetic.
    const byItem = new Map(); // `${type}:${key}` → { self:[], manager:[], peer:[], direct_report:[], other:[] }
    const comments = { keep: [], start: [], stop: [] };
    for (const r of responses) {
        const col = res.target[r && r.group];
        if (!col) continue;
        for (const a of (r && r.answers) || []) {
            if (a.itemType === 'comment') {
                const body = typeof a.body === 'string' ? a.body.trim() : '';
                if (body && C.COMMENT_KINDS.includes(a.itemKey)) comments[a.itemKey].push(body);
                continue;
            }
            const k = `${a.itemType}:${a.itemKey}`;
            if (!byItem.has(k))
                byItem.set(k, { self: [], manager: [], peer: [], direct_report: [], other: [] });
            byItem.get(k)[col].push(ratingOf(a.rating)); // null kept: "answered, not observed"
        }
    }

    const skills = [];
    const behaviours = [];
    const blindSpots = [];
    const hiddenStrengths = [];
    for (const it of items) {
        const cells = byItem.get(`${it.type}:${it.key}`) || {
            self: [],
            manager: [],
            peer: [],
            direct_report: [],
            other: [],
        };
        const observed = (xs) => xs.filter((x) => x !== null);
        const named = (g) => {
            if (res.state[g] !== 'shown') return { state: 'none', value: null };
            const obs = observed(cells[g]);
            if (!obs.length) return { state: 'not_observed', value: null };
            return { state: 'rated', value: mean(obs) };
        };
        const self = named('self');
        const manager = named('manager');

        const byGroup = {};
        let anon = [];
        for (const g of C.ANONYMOUS_GROUPS) {
            if (res.state[g] !== 'shown') continue;
            const obs = observed(cells[g]);
            if (obs.length >= t) {
                // Only a printable group feeds the combined figure: otherwise the
                // combined average minus the printed ones would give the rest away.
                anon = anon.concat(obs);
                byGroup[g] = { state: 'rated', value: mean(obs), observed: obs.length };
            } else {
                byGroup[g] = { state: 'too_few_observed', value: null };
            }
        }
        const others =
            anon.length >= t
                ? { state: 'rated', value: mean(anon), observed: anon.length }
                : {
                      state: Object.keys(byGroup).length ? 'too_few_observed' : 'none',
                      value: null,
                  };

        // Others' view: manager + the anonymous aggregate — each only when it is
        // printable on its own, so the view never carries a hidden rating.
        const view = [];
        if (manager.state === 'rated') view.push(...observed(cells.manager));
        if (others.state === 'rated') view.push(...anon);
        const othersView = view.length ? mean(view) : null;
        const gap =
            self.state === 'rated' && othersView !== null ? round2(self.value - othersView) : null;
        let flag = null;
        if (gap !== null && gap >= C.GAP_THRESHOLD) flag = 'blind_spot';
        else if (gap !== null && gap <= -C.GAP_THRESHOLD) flag = 'hidden_strength';

        const row = {
            key: it.key,
            label: it.label,
            self,
            manager,
            others,
            byGroup,
            othersView,
            gap,
            flag,
        };
        if (it.type === 'skill') {
            row.skillId = Number(it.key);
            row.required =
                it.required === null || it.required === undefined ? null : Number(it.required);
            skills.push(row);
        } else {
            behaviours.push(row);
        }
        if (flag === 'blind_spot')
            blindSpots.push({ type: it.type, key: it.key, label: it.label, gap });
        if (flag === 'hidden_strength')
            hiddenStrengths.push({ type: it.type, key: it.key, label: it.label, gap });
    }

    return {
        threshold: t,
        groups,
        skills,
        behaviours,
        blindSpots,
        hiddenStrengths,
        comments: {
            keep: shuffle(comments.keep),
            start: shuffle(comments.start),
            stop: shuffle(comments.stop),
        },
    };
}

module.exports = { resolveGroups, buildReport, ratingOf, floorOf, shuffle };
