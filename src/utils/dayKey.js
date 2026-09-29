'use strict';

/**
 * The LOCAL calendar day as YYYY-MM-DD.
 *
 * Re-audit J12 — several job ticks gate on LOCAL time (now.getHours for the
 * run hour, now.getDay/getDate for the day-of-week/day-of-month) but keyed
 * their "already ran today" marker off now.toISOString.slice(0,10), which is
 * UTC. Near local midnight on a non-UTC host the gate and the key disagree on
 * which day it is, so the tick can run twice or skip a day. Keying the marker
 * off the SAME local clock the gate uses removes the split. (On a UTC host — the
 * only kind this product is deployed on today — the two forms are identical, so
 * this changes nothing there; it makes the jobs correct off-UTC.)
 *
 * This mirrors what jobs/personal-digest.js already did inline.
 */
function dayKey(now = new Date()) {
    const d = now instanceof Date ? now : new Date(now);
    return (
        `${d.getFullYear()}-` +
        `${String(d.getMonth() + 1).padStart(2, '0')}-` +
        `${String(d.getDate()).padStart(2, '0')}`
    );
}

module.exports = { dayKey };
