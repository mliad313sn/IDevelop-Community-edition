'use strict';

/**
 * L1 — the dashboard trend printed ISO YYYY-MM-DD dates on a French-first product.
 *
 * window.FMT (public/js/date-format.js, loaded globally by the layout) renders
 * the product's unambiguous dd/MM/yyyy in both languages. The dashboard is now
 * rendered on the server (wave 12, D3): its trend axis and the board pack read
 * months through res.locals.monthLabel, and a movement's date through fmtDate.
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

describe('the dashboard prints months and dates in the reader language, never raw ISO', () => {
    const { fmtMonth } = require('../../src/utils/dateFormat');

    test('a calendar month reads « oct. 2026 » / "Oct 2026"', () => {
        expect(fmtMonth('2026-10', 'fr')).toBe('oct. 2026');
        expect(fmtMonth('2026-10', 'en')).toBe('Oct 2026');
        expect(fmtMonth('not-a-month', 'fr')).toBe('not-a-month');
    });

    test('the trend axis, the board pack months and the movement dates go through the formatters', () => {
        expect(norm('views/pages/dashboard/_tab-overview.ejs')).toMatch(
            /labels: _axis\.map\(typeof monthLabel === 'function' \? monthLabel : String\)/
        );
        expect(norm('views/pages/exec/board-pack.ejs')).toMatch(/monthLabel\(p\.month\)/);
        expect(norm('views/partials/kpi-tile.ejs')).toMatch(/fmtDate\(_k\.since\)/);
        expect(norm('src/services/DashboardHomeService.js')).toMatch(/since: day\(mv\.since\)/);
        expect(norm('server.js')).toMatch(
            /res\.locals\.monthLabel = \(ym\) => fmtMonth\(ym, lang\)/
        );
    });
});
