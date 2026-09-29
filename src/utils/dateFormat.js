'use strict';

/**
 * dateFormat — ONE date rendering per language for server-rendered pages
 * (the same instance rendered « Mon Jun 15 », « 9/9/2026,
 * 11:03:51 AM », ISO and dd/MM/yyyy side by side, year lost on cycle dates).
 *
 *   fmtDate(d, lang)      → fr « 10/09/2026 »        en « 10/09/2026 » (en-GB day-first)
 *   fmtDateTime(d, lang)  → fr « 10/09/2026 14:35 »  en « 10/09/2026, 14:35 »
 *
 * Absent / unparsable input → « — » (never « Invalid Date », never an empty cell
 * that reads as "no value" when the value is merely unreadable).
 * Times are rendered in APP_TIMEZONE when set, otherwise the server's local zone
 * (the zone every existing toLocaleString call already used).
 */
const UNMEASURED = '—';

function toDate(d) {
    if (d == null || d === '') return null;
    const x = d instanceof Date ? d : new Date(d);
    return Number.isNaN(x.getTime()) ? null : x;
}

function parts(x) {
    const tz = process.env.APP_TIMEZONE;
    if (tz) {
        const p = {};
        new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        })
            .formatToParts(x)
            .forEach((seg) => {
                p[seg.type] = seg.value;
            });
        // Some ICU builds print midnight as "24".
        if (p.hour === '24') p.hour = '00';
        return { d: p.day, m: p.month, y: p.year, h: p.hour, i: p.minute };
    }
    const pad = (n) => String(n).padStart(2, '0');
    return {
        d: pad(x.getDate()),
        m: pad(x.getMonth() + 1),
        y: String(x.getFullYear()),
        h: pad(x.getHours()),
        i: pad(x.getMinutes()),
    };
}

function fmtDate(d) {
    const x = toDate(d);
    if (!x) return UNMEASURED;
    const p = parts(x);
    return `${p.d}/${p.m}/${p.y}`;
}

function fmtDateTime(d, lang) {
    const x = toDate(d);
    if (!x) return UNMEASURED;
    const p = parts(x);
    const isFr = !lang || String(lang).slice(0, 2).toLowerCase() === 'fr';
    return `${p.d}/${p.m}/${p.y}${isFr ? ' ' : ', '}${p.h}:${p.i}`;
}

/**
 * A PERIOD BOUND — dd/MM/yyyy forced to UTC, whatever APP_TIMEZONE says.
 *
 * Period bounds are computed in UTC (utils/periodWindow) and must be PRINTED in
 * UTC, or a bound that is midnight UTC prints as the day before in a negative
 * offset. Deliberately NOT `fmtDate`: that one follows APP_TIMEZONE / the
 * server zone, which is right for an instant a human observed and wrong for a
 * calendar boundary.
 *
 * Replaces two live defects it must never reproduce:
 *   - `new Date(x).toISOString.slice(0, 10)` — ISO in a French email
 *     (dept-digest.js:186, manager-digest.js:179/191/213);
 *   - interpolating a PG `date` column straight into a template — node-pg hands
 *     back a Date object and the mail prints its full toString
 *     (planning-digest.js:124-127); the project's only setTypeParser covers
 *     OID 1700 (PostgresDatabase.js:23-24), not dates.
 *
 * Absent / unparsable → « — », same contract as the rest of this module.
 */
function fmtPeriodBound(d) {
    const x = toDate(d);
    if (!x) return UNMEASURED;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(x.getUTCDate())}/${pad(x.getUTCMonth() + 1)}/${x.getUTCFullYear()}`;
}

module.exports = { fmtDate, fmtDateTime, fmtPeriodBound, UNMEASURED };
