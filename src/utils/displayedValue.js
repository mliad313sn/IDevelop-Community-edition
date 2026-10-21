'use strict';
/**
 * displayedValue: decide on what is displayed.
 *
 * Every cell, tile or sentence that says "reached", "below target" or carries a
 * status colour decides on the SAME rounded value it prints. 79.96 % printed
 * "80.0 %" must not be coloured as below an 80 % objective; a level of 1.85
 * printed "1.9" meets a requirement of 1.9.
 *
 * The rounding is decimal half-up on |v| with the sign re-applied (a value that
 * rounds to zero is 0), so the decision can never disagree with the text. Pure;
 * no dependency.
 *
 *   displayedValue(v, unit)          number | null (null = not a measurement)
 *     unit 'pct'    a percentage 0-100 printed with 0 decimals   ("80 %")
 *          'pct1'   a percentage 0-100 printed with 1 decimal    ("79.6 %")
 *          'ratio'  a ratio 0-1 printed as a whole %  (0.796 -> 0.8)
 *          'ratio1' a ratio 0-1 printed as a % with 1 decimal (0.7996 -> 0.8)
 *          'level'  a level 0-4 printed with 1 decimal           ("1.9")
 *          'count'  an integer
 *          <n>      a number printed with n decimals
 *   below(value, threshold, unit)     displayed value < displayed threshold (null when unmeasured)
 *   atLeast(value, threshold, unit)   displayed value >= displayed threshold (null when unmeasured)
 *
 * SAFETY EXCEPTION: a safety or compliance % (critical requirements met, people
 * fit for their assignment: a shortfall means somebody is not compliant) NEVER
 * rounds UP: 99.5 % with one person short must not read "100 %". Its units
 * round DOWN to the printed precision, and a value below 100 can never print 100:
 *     'pctFloor'  a safety % printed with 0 decimals  (99.9 -> "99 %")
 *     'pct1Floor' a safety % printed with 1 decimal   (99.96 -> "99.9 %")
 *   safetyUnit(decimals) the floor unit for a tile's precision.
 * Flooring keeps print and decision in step: for an integer threshold T,
 * floor(v) >= T <=> v >= T. Thresholds are compared as given (never floored),
 * so a floor unit errs towards "not reached".
 */

const DECIMALS = Object.freeze({
    pct: 0,
    pct1: 1,
    ratio: 0,
    ratio1: 1,
    level: 1,
    count: 0,
    pctFloor: 0,
    pct1Floor: 1,
});
const RATIO = Object.freeze({ ratio: true, ratio1: true });
const FLOOR = Object.freeze({ pctFloor: true, pct1Floor: true });

const isNum = (v) =>
    v !== null &&
    v !== undefined &&
    v !== '' &&
    typeof v !== 'boolean' &&
    !(typeof v === 'string' && v.trim() === '') &&
    Number.isFinite(Number(v));

function decimalsOf(unit) {
    if (typeof unit === 'number' && Number.isInteger(unit) && unit >= 0 && unit <= 10) return unit;
    if (Object.prototype.hasOwnProperty.call(DECIMALS, unit)) return DECIMALS[unit];
    throw new Error('displayedValue: unknown unit ' + unit);
}

/** |v| rounded half-up in DECIMAL, sign re-applied. */
function roundLikeFr(v, k) {
    const a = Math.abs(v);
    let r = Number(`${Math.round(Number(`${a}e${k}`))}e-${k}`);
    if (!Number.isFinite(r)) r = a;
    r = Number(r.toFixed(k));
    if (r === 0) return 0;
    return v < 0 ? -r : r;
}

/**
 * v rounded DOWN to k decimals (decimal arithmetic, a 1e-9 guard so that a
 * binary 28,999999999999996 meant as 29 stays 29). A value below 100 never
 * floors to 100 (the guard cannot lift it there).
 */
function floorLikeFr(v, k) {
    const scaled = Number(`${v}e${k}`);
    let r = Number(`${Math.floor(scaled + 1e-9)}e-${k}`);
    if (!Number.isFinite(r)) r = Math.floor(v);
    if (v < 100 && r >= 100) r = 100 - Math.pow(10, -k);
    r = Number(r.toFixed(k));
    return r === 0 ? 0 : r;
}

function displayedValue(v, unit = 'pct') {
    if (!isNum(v)) return null;
    const k = decimalsOf(unit);
    const x = Number(v);
    if (FLOOR[unit]) return floorLikeFr(x, k);
    if (RATIO[unit]) return roundLikeFr(x * 100, k) / 100;
    return roundLikeFr(x, k);
}

/** The safety (round-down) unit for a % printed with `decimals` decimals (0 or 1). */
function safetyUnit(decimals) {
    return Number(decimals) >= 1 ? 'pct1Floor' : 'pctFloor';
}

function below(value, threshold, unit = 'pct') {
    const v = displayedValue(value, unit);
    // a safety (floor) unit compares against the threshold AS GIVEN
    const t = FLOOR[unit]
        ? isNum(threshold)
            ? Number(threshold)
            : null
        : displayedValue(threshold, unit);
    if (v === null || t === null) return null;
    return v < t;
}

function atLeast(value, threshold, unit = 'pct') {
    const b = below(value, threshold, unit);
    return b === null ? null : !b;
}

module.exports = { displayedValue, below, atLeast, safetyUnit, DECIMALS };
