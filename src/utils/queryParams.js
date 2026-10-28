'use strict';
/**
 * Reading numeric and enumerated query parameters without trusting them.
 *
 * A filter such as ?roleId= or ?groupBy= used to reach SQL or a model as typed:
 * text bound to a bigint column, or an unknown grouping thrown as a plain
 * Error, answered 500. These helpers tell "absent" from "malformed", so a route
 * can answer 400 for a malformed value and keep the unfiltered meaning of an
 * absent one.
 *
 * @module utils/queryParams
 */

/** Values that mean "no filter" (absent, empty, or the literal the UI sends for none). */
function isAbsent(v) {
    return v === undefined || v === null || v === '' || v === 'null';
}

/**
 * A positive whole id: { ok: true, value: number|null } (null when absent), or
 * { ok: false } for anything else (text, decimals, negatives, zero, arrays,
 * more than 15 digits).
 */
function queryId(v) {
    if (isAbsent(v)) return { ok: true, value: null };
    if (typeof v !== 'string' || v.length > 15 || !/^\d+$/.test(v)) return { ok: false };
    const n = Number(v);
    return n > 0 ? { ok: true, value: n } : { ok: false };
}

/**
 * One of `allowed`: { ok: true, value } (the default when absent) or
 * { ok: false } for anything else.
 */
function queryEnum(v, allowed, dflt = null) {
    if (isAbsent(v)) return { ok: true, value: dflt };
    return typeof v === 'string' && allowed.includes(v) ? { ok: true, value: v } : { ok: false };
}

/**
 * A number within [min, max]: { ok: true, value: number|null } or { ok: false }.
 */
function queryNumber(v, { min = -Infinity, max = Infinity, integer = false } = {}) {
    if (isAbsent(v)) return { ok: true, value: null };
    if (typeof v !== 'string' || v.length > 20) return { ok: false };
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
        return { ok: false };
    return { ok: true, value: n };
}

module.exports = { isAbsent, queryId, queryEnum, queryNumber };
