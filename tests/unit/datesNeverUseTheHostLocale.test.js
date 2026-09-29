'use strict';

/**
 * Fifteen places printed a date in whatever format the reader's browser or the
 * host happened to prefer.
 *
 * The product has ONE date format, in both languages: dd/MM/yyyy, and
 * dd/MM/yyyy HH:mm for a timestamp (src/utils/dateFormat.js). It is deliberate
 * — unambiguous for a French reader and an English one, and independent of the
 * machine. But fourteen views and one client bundle still called
 * `toLocaleDateString()` / `toLocaleString()` / `toLocaleTimeString()` with no
 * argument. On a browser set to en-US that prints "3/4/2026", which a French
 * reader reads as 3 April and an American reads as 4 March: the same string,
 * two different days, nothing to tell them apart.
 *
 * Several were the FALLBACK arm of
 * `typeof fmtDateTime === 'function' ? fmtDateTime : …` — precisely the branch
 * taken when the server-side helper is not in scope, which for two of these
 * views is always, because their controllers never passed one.
 *
 * public/js/date-format.js is the client-side twin, loaded globally; the two
 * server-rendered views define a local helper, the same pattern
 * continuity/index.ejs already uses for its `sDate`.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A call with NO argument, or an explicit `undefined`, takes the host locale.
const HOST_LOCALE_CALL = /toLocale[A-Za-z]*\(\s*(\)|undefined)/g;

const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel, out);
        else if (/\.(ejs|js)$/.test(e.name)) out.push(rel);
    }
    return out;
};

describe('no surface formats a date in the host locale', () => {
    test('the sweep is clean across views, client bundles and server code', () => {
        const files = [...walk('views'), ...walk('public/js'), ...walk('src')];
        const offenders = [];
        for (const f of files) {
            // dateFormat.js documents the old calls in prose; date-format.js is
            // the replacement and names them too.
            if (/dateFormat\.js$|date-format\.js$/.test(f)) continue;
            const hits = read(f).match(HOST_LOCALE_CALL);
            if (hits) offenders.push(`${f} (${hits.length})`);
        }
        expect(offenders).toEqual([]);
    });

    test('the sweep would actually notice a regression', () => {
        // Guard against the matcher silently never matching anything.
        const sample = 'const s = new Date(x).toLocaleDateString();';
        expect(sample.match(HOST_LOCALE_CALL)).not.toBeNull();
        expect("new Date(x).toLocaleDateString('fr-FR')".match(HOST_LOCALE_CALL)).toBeNull();
    });
});

describe('the client helper matches the server contract', () => {
    // Evaluate the real file rather than a copy of it.
    const src = read('public/js/date-format.js');
    const w = {};
    // eslint-disable-next-line no-new-func
    new Function('window', src)(w);
    const FMT = w.FMT;

    const server = require('../../src/utils/dateFormat');

    test('it is loaded on every page', () => {
        expect(read('views/layouts/main.ejs')).toMatch(/\/js\/date-format\.js/);
    });

    test('dd/MM/yyyy, the same as the server, for the ambiguous case', () => {
        const d = new Date(2026, 2, 4, 14, 5); // 4 March 2026
        expect(FMT.date(d)).toBe('04/03/2026');
        expect(FMT.date(d)).toBe(server.fmtDate(d));
        expect(FMT.dateTime(d)).toBe('04/03/2026 14:05');
        expect(FMT.time(d)).toBe('14:05');
    });

    test('absent or unreadable input is the em dash, never Invalid Date', () => {
        for (const bad of [null, undefined, '', 'not a date']) {
            expect(FMT.date(bad)).toBe(server.UNMEASURED);
            expect(FMT.dateTime(bad)).toBe(server.UNMEASURED);
            expect(FMT.time(bad)).toBe(server.UNMEASURED);
        }
    });

    test('it never returns a fabricated today for missing input', () => {
        const today = FMT.date(new Date());
        expect(FMT.date(null)).not.toBe(today);
    });
});

describe('the two server-rendered views carry their own helper', () => {
    test.each(['views/pages/assessments/show.ejs', 'views/pages/onboarding/queue.ejs'])(
        '%s defines _vdt and uses it',
        (f) => {
            const s = read(f);
            expect(s).toMatch(/function _vdt\(v\)/);
            expect(s).toMatch(/_vdt\(/);
            // and does not depend on a local its controller never passes
            expect(s).not.toMatch(/fmtDateTime\(/);
        }
    );

    test('every touched view still compiles', () => {
        const ejs = require('ejs');
        const files = [
            'views/pages/assessments/show.ejs',
            'views/pages/onboarding/queue.ejs',
            'views/pages/admin/health.ejs',
            'views/pages/employees/show.ejs',
            'views/pages/system-logs/index.ejs',
            'views/pages/talent/nine-box-console.ejs',
            'views/pages/app-settings/index.ejs',
            'views/pages/employee/self-assessment.ejs',
            'views/layouts/main.ejs',
        ];
        for (const f of files) {
            expect(() => ejs.compile(read(f), { filename: path.join(ROOT, f) })).not.toThrow();
        }
    });
});
