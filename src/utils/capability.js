'use strict';
/**
 * capability — the ONE rule that relates a demonstrated level to a required
 * level. Pure, no dependency; shared by the services, the models (as SQL
 * fragments), the views and the tests.
 *
 * The rule
 *   - Reaching the required level is ONE state, « met ». A level above the
 *     requirement is not « over-skilled » in any figure: it is credited at the
 *     requirement, never more.
 *   - Per skill the credited level is min(demonstrated, required), so the ratio
 *     credited ÷ required is at most 1 and the gap required − credited is never
 *     negative.
 *   - A surplus on one skill never makes up for a gap on another skill or on
 *     another person: an aggregate sums CREDITED levels (and positive gaps),
 *     so every role, unit or framework figure is at most 100 %.
 *   - Comparing a person with ANOTHER role (career path, succession, mobility)
 *     re-evaluates every skill against THAT role's requirement: call these
 *     helpers with the target role's required level.
 *   - No level at all is « unmeasured », never 0, and stays outside every sum.
 *
 * In SQL an aggregate uses creditedSql() = LEAST(actual, required) for the
 * demonstrated side and gapSql() = GREATEST(required − actual, 0) for gaps.
 * Both take COLUMN EXPRESSIONS written by the caller, never user input.
 */

const isNum = (v) =>
    v !== null &&
    v !== undefined &&
    v !== '' &&
    typeof v !== 'boolean' &&
    !(typeof v === 'string' && v.trim() === '') &&
    Number.isFinite(Number(v));

/** The three states of one skill against one requirement (fixed English codes). */
const STATES = Object.freeze({ MET: 'met', GAP: 'gap', UNMEASURED: 'unmeasured' });

/** The level credited against a requirement: min(demonstrated, required); null when unmeasured. */
function credited(demonstrated, required) {
    if (!isNum(demonstrated) || !isNum(required)) return null;
    const d = Math.max(0, Number(demonstrated));
    const r = Number(required);
    return r > 0 ? Math.min(d, r) : d;
}

/** The gap below a requirement (>= 0); null when unmeasured or when nothing is required. */
function gapOf(demonstrated, required) {
    if (!isNum(demonstrated) || !isNum(required) || Number(required) <= 0) return null;
    return Math.max(0, Number(required) - Number(demonstrated));
}

/**
 * One skill against one requirement.
 * A requirement of 0 or none is not a requirement: state 'unmeasured' with a
 * null ratio (there is nothing to measure against).
 * @returns {{state:'met'|'gap'|'unmeasured', ratio:number|null, gap:number|null,
 *            credited:number|null, required:number|null}} ratio in [0, 1], gap >= 0
 */
function skillAttainment(demonstrated, required) {
    const req = isNum(required) && Number(required) > 0 ? Number(required) : null;
    if (req === null || !isNum(demonstrated)) {
        return { state: STATES.UNMEASURED, ratio: null, gap: null, credited: null, required: req };
    }
    const c = credited(demonstrated, req);
    const gap = req - c;
    return {
        state: gap > 0 ? STATES.GAP : STATES.MET,
        ratio: c / req,
        gap,
        credited: c,
        required: req,
    };
}

/**
 * The aggregate of requirement rows [{ demonstrated | actual, required }] for
 * a role or any population: Σ credited ÷ Σ required over the MEASURED rows
 * only. At most 1 by construction; a surplus never offsets a gap. Unmeasured
 * rows are counted, never scored; rows without a requirement are ignored.
 * @returns {{state, ratio:number|null, credited:number, required:number, gapPoints:number,
 *            measured:number, unmeasured:number, met:number, gaps:number}}
 */
function roleAttainment(rows) {
    let cred = 0;
    let req = 0;
    let gapPoints = 0;
    let measured = 0;
    let unmeasured = 0;
    let met = 0;
    let gaps = 0;
    for (const r of rows || []) {
        if (!r) continue;
        const d = r.demonstrated !== undefined ? r.demonstrated : r.actual;
        const s = skillAttainment(d, r.required);
        if (s.required === null) continue;
        if (s.state === STATES.UNMEASURED) {
            unmeasured++;
            continue;
        }
        measured++;
        cred += s.credited;
        req += s.required;
        gapPoints += s.gap;
        if (s.state === STATES.MET) met++;
        else gaps++;
    }
    const ratio = req > 0 ? Math.min(1, cred / req) : null;
    let state = STATES.UNMEASURED;
    if (ratio !== null) state = gapPoints > 0 ? STATES.GAP : STATES.MET;
    return {
        state,
        ratio,
        credited: cred,
        required: req,
        gapPoints,
        measured,
        unmeasured,
        met,
        gaps,
    };
}

/** Σ credited ÷ Σ required, clamped to [0, 1]; null when nothing was measured. */
function cappedRatio(sumCredited, sumRequired) {
    if (!isNum(sumCredited) || !isNum(sumRequired) || Number(sumRequired) <= 0) return null;
    return Math.max(0, Math.min(1, Number(sumCredited) / Number(sumRequired)));
}

/** A (mean) credited level, never above the (mean) required level of the same rows. */
function cappedLevel(actual, required) {
    if (!isNum(actual)) return null;
    if (!isNum(required)) return Number(actual);
    return Math.min(Number(actual), Number(required));
}

/** SQL fragment: the credited level of one requirement row (column expressions only). */
function creditedSql(actualCol, requiredCol) {
    return `LEAST(${actualCol}, ${requiredCol})`;
}

/** SQL fragment: the positive gap of one requirement row (column expressions only). */
function gapSql(actualCol, requiredCol) {
    return `GREATEST(${requiredCol} - ${actualCol}, 0)`;
}

module.exports = {
    STATES,
    credited,
    gapOf,
    skillAttainment,
    roleAttainment,
    cappedRatio,
    cappedLevel,
    creditedSql,
    gapSql,
};
