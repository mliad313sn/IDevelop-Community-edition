'use strict';

/**
 * L1 — the dashboard trend printed ISO YYYY-MM-DD dates on a French-first product.
 *
 * The trend caption ("since 2026-09-21") and the trend chart x-axis labels
 * inserted `series[i].date` — the raw ISO string the API returns — straight into
 * the DOM. window.FMT (public/js/date-format.js, loaded globally by the layout)
 * renders the product's unambiguous dd/MM/yyyy in both languages, but dashboard.js
 * never used it. Both now go through a local fmtDate() wrapper over window.FMT.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const norm = (p) => read(p).replace(/\s+/g, ' ');

describe('window.FMT.date renders dd/MM/yyyy, not ISO', () => {
    // Load the client script with a mock window and pull out FMT.
    const src = read('public/js/date-format.js');
    const FMT = new Function('window', src + '\nreturn window.FMT;')({});

    test('an ISO date becomes dd/MM/yyyy (not the ISO input)', () => {
        const out = FMT.date('2026-09-21');
        expect(out).toMatch(/^\d{2}\/\d{2}\/\d{4}$/); // dd/MM/yyyy
        expect(out).not.toBe('2026-09-21');
        expect(out).toContain('/2026');
    });

    test('an unparseable date is the em dash, never "Invalid Date"', () => {
        expect(FMT.date('not-a-date')).toBe('—');
        expect(FMT.date(null)).toBe('—');
    });
});

describe('the dashboard trend uses the locale formatter, not raw ISO', () => {
    const js = norm('public/js/dashboard.js');

    test('a fmtDate helper wraps window.FMT.date', () => {
        expect(js).toMatch(/function fmtDate\(d\) \{[\s\S]*window\.FMT[\s\S]*\.date/);
    });

    test('the caption and x-axis labels go through fmtDate', () => {
        expect(js).toMatch(/\.replace\('\{d\}', fmtDate\(series\[0\]\.date\)\)/);
        // J9 replaced the category axis with a linear time scale; the x-axis tick
        // callback formats the day timestamp through fmtDate.
        expect(js).toMatch(
            /callback: \(v\) => fmtDate\(new Date\(v\)\.toISOString\(\)\.slice\(0, 10\)\)/
        );
        // the raw-ISO renders are gone
        expect(js).not.toMatch(/\.replace\('\{d\}', series\[0\]\.date\)/);
        expect(js).not.toMatch(/labels: series\.map\(\(d\) => d\.date\)/);
    });
});
