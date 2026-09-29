/**
 * Client-side twin of src/utils/dateFormat.js.
 *
 * The product prints ONE date format in both languages: dd/MM/yyyy, and
 * dd/MM/yyyy HH:mm for a timestamp. That is deliberate — it is unambiguous for
 * a French reader and for an English one, and it never depends on whatever
 * locale the browser happens to be set to.
 *
 * Fourteen places in the views still called `toLocaleDateString` /
 * `toLocaleString` with no argument. On a browser set to en-US that prints
 * "3/4/2026", which a French reader reads as 3 April and an American reads as
 * 4 March — the same string, two different days, with nothing to tell them
 * apart. Several of those calls were the FALLBACK arm of
 * `typeof fmtDateTime === 'function' ? fmtDateTime : …`, i.e. exactly the path
 * taken when the server-side helper is not in scope.
 *
 *   window.FMT.date(v)      -> "04/03/2026"     (UNMEASURED when unparseable)
 *   window.FMT.dateTime(v)  -> "04/03/2026 14:05"
 *
 * Unparseable input returns the em dash, never "Invalid Date" and never a
 * fabricated today.
 */
(function (w) {
    'use strict';

    var UNMEASURED = '—';

    function toDate(d) {
        if (d === null || d === undefined || d === '') return null;
        var x = d instanceof Date ? d : new Date(d);
        return isNaN(x.getTime()) ? null : x;
    }

    function pad(n) {
        return String(n).padStart(2, '0');
    }

    function date(d) {
        var x = toDate(d);
        if (!x) return UNMEASURED;
        return pad(x.getDate()) + '/' + pad(x.getMonth() + 1) + '/' + x.getFullYear();
    }

    function dateTime(d) {
        var x = toDate(d);
        if (!x) return UNMEASURED;
        return date(x) + ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes());
    }

    function time(d) {
        var x = toDate(d);
        if (!x) return UNMEASURED;
        return pad(x.getHours()) + ':' + pad(x.getMinutes());
    }

    w.FMT = { date: date, dateTime: dateTime, time: time, UNMEASURED: UNMEASURED };
})(window);
