'use strict';

/**
 * How long ago something happened, in the unit a person would say it in:
 * « aujourd'hui », « il y a 3 jours », « il y a 5 semaines », « il y a 4 mois ».
 * Never a fraction of a month (« il y a 0,8 mois »).
 *
 *   agoBucket(days) → { unit: 'today' | 'days' | 'weeks' | 'months', n } | null
 *
 * `days` is the whole number of days elapsed. Under 14 days the days are
 * counted, under 60 days the weeks (rounded), beyond that the months (rounded,
 * at least 1). A negative or unknown value is null: the caller prints nothing
 * rather than a wrong figure.
 */
const DAYS_PER_MONTH = 30.44;

function agoBucket(days) {
    if (days === null || days === undefined || days === '') return null;
    const d = Math.floor(Number(days));
    if (!Number.isFinite(d) || d < 0) return null;
    if (d === 0) return { unit: 'today', n: 0 };
    if (d < 14) return { unit: 'days', n: d };
    if (d < 60) return { unit: 'weeks', n: Math.round(d / 7) };
    return { unit: 'months', n: Math.max(1, Math.round(d / DAYS_PER_MONTH)) };
}

/** Whole days between two instants (later minus earlier), or null. */
function daysBetween(earlier, later = Date.now()) {
    const a = earlier instanceof Date ? earlier.getTime() : new Date(earlier).getTime();
    const b = later instanceof Date ? later.getTime() : Number(later);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.floor((b - a) / 86400000);
}

module.exports = { agoBucket, daysBetween, DAYS_PER_MONTH };
