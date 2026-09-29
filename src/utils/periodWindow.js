'use strict';

/**
 * periodWindow — the CLOSED calendar period a department brief reports on.
 *
 * ONE clock, and it is UTC (spec §2.0 R7). The existing jobs gate on the LOCAL
 * hour (`manager-digest.js:38`, `planning-digest.js:205`) but bucket in UTC
 * (`weekBucket`/`monthBucket` use getUTC*). On a period boundary the gate opens
 * while the bucket still names the PREVIOUS period: the brief is either
 * mislabelled, or its bucket is already claimed and the brief is skipped — for
 * the yearly cadence, skipped for a year. Everything here is getUTC*, and the
 * bounds are handed to the queries as Date OBJECTS so the pg driver emits an
 * offset-qualified literal (SHOW TimeZone is Atlantic/Reykjavik on this machine
 * and may be anything on the appliance).
 *
 * The arithmetic is CALENDAR arithmetic, never "the same number of days back"
 * (spec §2.6). A month is 28-31 days, a quarter 90-92, a year 365 or 366.
 * Comparing February to "the previous 28 days" manufactures a −10 % every year;
 * `beforeDays` is banned from this lot. The previous window is therefore the
 * previous CALENDAR period, and both windows publish their own day count so a
 * reader can see that 50 actions over 92 days is not 94 over 91.
 *
 * A brief is always emitted AFTER its period has CLOSED: the upper bound is
 * EXCLUSIVE and is never in the future. `[periodStart, periodEnd)`. The display
 * bound `displayEnd` is periodEnd − 1 day, rendered with "inclus".
 *
 * No query, no I/O. The period BUCKETS come from src/jobs/reminders.js — the one
 * shared ledger registry (spec §4.2); forking a second week bucket is what
 * `cycle-nudge.js:123-128` already did, and the two disagree.
 */

/** Shortest → longest. §4.7: when several cadences fall due, the LONGEST wins. */
const CADENCES = ['weekly', 'monthly', 'quarterly', 'yearly'];

/**
 * Prospective horizon, INDEXED ON THE CADENCE and never wider than it (§2.4).
 * A window wider than the cadence makes the same dated risk reappear in two
 * consecutive briefs, and makes the email disagree with the application.
 */
const HORIZON_DAYS = { weekly: 14, monthly: 30, quarterly: 90, yearly: 180 };

/**
 * Catch-up window (§4.4). The gate is the ledger, not the calendar, so a machine
 * that was off on the due day still sends — but a FRESH install must not
 * retro-send three years of briefs.
 */
const CATCH_UP_DAYS = { weekly: 6, monthly: 20, quarterly: 30, yearly: 60 };

const DAY_MS = 86400000;

/** Midnight UTC. Date.UTC normalises month/day overflow, so −1 is "December". */
function utcMidnight(y, m, d) {
    return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
}

function toUtcDate(anchor) {
    const a = anchor instanceof Date ? anchor : new Date(anchor);
    if (Number.isNaN(a.getTime())) throw new TypeError('periodWindow: invalid anchor date');
    return a;
}

/** The period bucket string for a cadence — the SHARED registry, never a fork. */
function bucketFor(cadence, date) {
    // Lazy require: the bucket registry lives in a job module that pulls the db
    // handle at load time. This util must stay loadable (and testable) on its
    // own arithmetic.
    const R = require('../jobs/reminders');
    switch (cadence) {
        case 'weekly':
            return R.weekBucket(date);
        case 'monthly':
            return R.monthBucket(date);
        case 'quarterly':
            return R.quarterBucket(date);
        case 'yearly':
            return R.yearBucket(date);
        default:
            throw new RangeError(`periodWindow: unknown cadence "${cadence}"`);
    }
}

/**
 * The closed period a brief anchored at `anchorUtc` reports on.
 *
 * @param {'weekly'|'monthly'|'quarterly'|'yearly'} cadence
 * @param {Date|string|number} anchorUtc  the instant the tick is reasoning about
 * @returns {{cadence, periodStart: Date, periodEnd: Date, displayEnd: Date,
 *            prevStart: Date, prevEnd: Date, bucket: string, prevBucket: string,
 *            days: number, prevDays: number, horizonDays: number,
 *            horizonEnd: Date, catchUpDays: number}}
 */
function windowFor(cadence, anchorUtc) {
    if (!CADENCES.includes(cadence))
        throw new RangeError(`periodWindow: unknown cadence "${cadence}"`);
    const a = toUtcDate(anchorUtc);
    const y = a.getUTCFullYear();
    const m = a.getUTCMonth();
    const d = a.getUTCDate();

    let periodStart, periodEnd, prevStart;
    if (cadence === 'weekly') {
        // Monday 00:00 UTC at or before the anchor closes the week that just
        // ended. (getUTCDay: Sunday = 0, so shift to Monday = 0.)
        const sinceMonday = (a.getUTCDay() + 6) % 7;
        periodEnd = utcMidnight(y, m, d - sinceMonday);
        periodStart = utcMidnight(y, m, d - sinceMonday - 7);
        prevStart = utcMidnight(y, m, d - sinceMonday - 14);
    } else if (cadence === 'monthly') {
        periodEnd = utcMidnight(y, m, 1);
        periodStart = utcMidnight(y, m - 1, 1);
        prevStart = utcMidnight(y, m - 2, 1);
    } else if (cadence === 'quarterly') {
        // Existing house idiom (AccessReviewService.js:160), applied to the
        // ANCHOR and never to a fresh new Date.
        const q0 = Math.floor(m / 3) * 3;
        periodEnd = utcMidnight(y, q0, 1);
        periodStart = utcMidnight(y, q0 - 3, 1);
        prevStart = utcMidnight(y, q0 - 6, 1);
    } else {
        periodEnd = utcMidnight(y, 0, 1);
        periodStart = utcMidnight(y - 1, 0, 1);
        prevStart = utcMidnight(y - 2, 0, 1);
    }
    const prevEnd = periodStart;
    const horizonDays = HORIZON_DAYS[cadence];

    return {
        cadence,
        periodStart,
        periodEnd,
        // Upper bound is EXCLUSIVE; this is the inclusive bound to PRINT.
        displayEnd: new Date(periodEnd.getTime() - DAY_MS),
        prevStart,
        prevEnd,
        bucket: bucketFor(cadence, periodStart),
        prevBucket: bucketFor(cadence, prevStart),
        // Real calendar lengths — published side by side whenever they differ.
        days: Math.round((periodEnd - periodStart) / DAY_MS),
        prevDays: Math.round((prevEnd - prevStart) / DAY_MS),
        horizonDays,
        horizonEnd: new Date(periodEnd.getTime() + horizonDays * DAY_MS),
        catchUpDays: CATCH_UP_DAYS[cadence],
    };
}

/** Days elapsed since a period closed — the catch-up test of §4.4. */
function daysSinceClose(win, nowUtc) {
    return Math.floor((toUtcDate(nowUtc) - win.periodEnd) / DAY_MS);
}

module.exports = { windowFor, bucketFor, daysSinceClose, CADENCES, HORIZON_DAYS, CATCH_UP_DAYS };
