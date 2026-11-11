'use strict';
/**
 * heatBins — the ONE colour scale of every heatmap (views/partials/viz/heat.ejs,
 * public/css/viz.css .vh-*). Pure; shared by the server, the views and the tests.
 *
 *   attain   r = Σ credited ÷ Σ required (credited = min(demonstrated,
 *            required), src/utils/capability.js) — one-sided, at most 100 %:
 *            at or above the requirement is ONE state, « met »; there is no
 *            « above » step, a surplus is never coloured and never offsets a gap
 *   deficit  d = required − demonstrated, in levels — one-sided (below only)
 *   coverage c = at level ÷ assessed             — one-sided (below only)
 *   level    a required or demonstrated level 0-4 (benchmark matrices)
 *
 * Edges are inclusive-low / exclusive-high and apply to the value the caller
 * passes: the caller passes the value AS PRINTED (utils/displayedValue), so a
 * cell never carries ▼ beside « 80 % ». `null` (nothing measured) has NO bin:
 * the caller draws it hatched "Not measured", never coloured, never 0.
 */

const BINS = Object.freeze({
    attain: Object.freeze(['below-3', 'below-2', 'below-1', 'at']),
    deficit: Object.freeze(['below-3', 'below-2', 'below-1', 'at']),
    coverage: Object.freeze(['below-3', 'below-2', 'below-1', 'at']),
    level: Object.freeze(['seq-0', 'seq-1', 'seq-2', 'seq-3', 'seq-4']),
});

const isNum = (v) =>
    v !== null &&
    v !== undefined &&
    v !== '' &&
    typeof v !== 'boolean' &&
    Number.isFinite(Number(v));

/** The bin of one value, or null when nothing was measured. */
function binOf(kind, value) {
    if (!isNum(value)) return null;
    const v = Number(value);
    switch (kind) {
        case 'attain':
            if (v < 0.6) return 'below-3';
            if (v < 0.8) return 'below-2';
            if (v < 1) return 'below-1';
            return 'at'; // at or above the requirement: met
        case 'deficit':
            if (v >= 1) return 'below-3';
            if (v >= 0.5) return 'below-2';
            if (v >= 0.1) return 'below-1';
            return 'at';
        case 'coverage':
            if (v < 0.5) return 'below-3';
            if (v < 0.8) return 'below-2';
            if (v < 1) return 'below-1';
            return 'at';
        case 'level':
            return 'seq-' + Math.max(0, Math.min(4, Math.round(v)));
        default:
            throw new Error('heatBins: unknown kind');
    }
}

/**
 * The deficit bin of ONE person's level against a requirement (benchmark
 * matrices): null when the level was never assessed — an unassessed cell is
 * "Not assessed", never level 0.
 */
function personGapBin(actual, required, assessed) {
    if (!assessed || !isNum(actual) || !isNum(required)) return null;
    return binOf('deficit', Math.max(0, Number(required) - Number(actual)));
}

/** The ▼ marker: below 80 % of the requirement (attain, coverage) or >= 0.5 level short. */
function belowMark(kind, value) {
    if (!isNum(value)) return false;
    const v = Number(value);
    if (kind === 'attain' || kind === 'coverage') return v < 0.8;
    if (kind === 'deficit') return v >= 0.5;
    return false;
}

module.exports = { BINS, binOf, belowMark, personGapBin };
