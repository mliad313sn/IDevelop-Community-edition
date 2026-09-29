'use strict';

/**
 * Domain / site / department names are admin-editable free text and the API
 * hands them to the browser verbatim (proved against idevelop: a domain renamed
 * to `<img src=x onerror=...>` came back through getDomainHeatmap in 9 rows and
 * getOrgDomainRadar in 1, unmodified). Two renderers interpolated those names
 * straight into a string that is then assigned to `innerHTML`, so the name
 * executed as markup.
 *
 * There is no jsdom in this project, so this is a source-shape test. Source
 * shape is fragile in this repo because the pre-commit hook runs prettier over
 * staged JS and reflows whatever it likes: the function body is therefore
 * located by BRACE MATCHING rather than line numbers, and every assertion
 * tolerates arbitrary whitespace. What is pinned is the property that matters —
 * no bare identifier interpolation survives into an innerHTML string — not any
 * particular layout.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'public', 'js', 'dashboard.js');
// Normalise line endings. The working copy is CRLF on this platform and LF
// after git touches it, so any pattern anchored on "\n" passes or fails
// depending on which of those you happen to have checked out — which is how
// the band assertion below went red without the code changing at all.
const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

/** Return the body of `function <name>(...)`, located by matching braces. */
const bodyOf = (name) => {
    const decl = new RegExp(`function\\s+${name}\\s*\\(`);
    const start = source.search(decl);
    expect(start).toBeGreaterThan(-1); // the function must still exist at all
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    throw new Error(`unbalanced braces reading ${name}`);
};

describe('dashboard.js — what the renderers are contractually not allowed to do', () => {
    test('the module-scope esc() really neutralises markup', () => {
        // Pull the shared escaper out of the source and run it, so this suite
        // cannot pass on the mere PRESENCE of the characters "esc(".
        // Locate the arrow body by PAREN matching, for the same reason the
        // function bodies above use brace matching: indentation is prettier's
        // to choose, not ours.
        const at = source.search(/const esc = \(s\) =>/);
        expect(at).toBeGreaterThan(-1);
        // The body is a single expression that may chain calls (`String(...)
        // .replace(...)`), so run to the statement's terminating `;` at paren
        // depth 0 rather than to the first balanced paren.
        const bodyStart = source.indexOf('String(', at);
        let depth = 0;
        let end = -1;
        for (let i = bodyStart; i < source.length; i++) {
            const ch = source[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === ';' && depth === 0) {
                end = i;
                break;
            }
        }
        expect(end).toBeGreaterThan(bodyStart);
        // eslint-disable-next-line no-new-func
        const esc = new Function(`return (s) => ${source.slice(bodyStart, end)};`)();
        expect(esc('<img src=x onerror=alert(1)>Ops')).toBe(
            '&lt;img src=x onerror=alert(1)&gt;Ops'
        );
        expect(esc('a"b\'c&d')).toBe('a&quot;b&#39;c&amp;d');
        expect(esc(null)).toBe('');
    });

    test('renderHeatmap escapes the domain and group names', () => {
        const body = bodyOf('renderHeatmap');
        // the two values that come from the database
        expect(body).toMatch(/\$\{\s*esc\(\s*g\s*\)\s*\}/);
        expect(body).toMatch(/\$\{\s*esc\(\s*dom\s*\)\s*\}/);
        // and neither may appear raw anywhere in the built markup
        expect(body).not.toMatch(/\$\{\s*g\s*\}/);
        expect(body).not.toMatch(/\$\{\s*dom\s*\}/);
    });

    test('renderOrgRadarSummary escapes the domain name', () => {
        const body = bodyOf('renderOrgRadarSummary');
        expect(body).toMatch(/\$\{\s*esc\(\s*d\.domainName\s*\)\s*\}/);
        expect(body).not.toMatch(/\$\{\s*d\.domainName\s*\}/);
    });

    test('org health bands treat "not measured" as its own state, not a failure', () => {
        // Proved against idevelop: getOrgHealthMetrics returns null for all three
        // of these on a scope holding nobody (e.g. a site created but not yet
        // staffed). The old `|| 0` printed 0 / 0% / 0%, and because `null >= 1`
        // is false it took the LAST branch — publishing "never measured" as a
        // red CRITICAL result.
        const body = bodyOf('renderOrgHealthCards');
        const m = body.match(/const band = \(v, good, warn\) =>([\s\S]*?);/);
        expect(m).not.toBeNull();
        // eslint-disable-next-line no-new-func
        const band = new Function(`return (v, good, warn) => ${m[1]};`)();

        expect(band(null, 80, 50)).toBe('neutral'); // the whole point
        expect(band(undefined, 80, 50)).toBe('neutral');
        expect(band(0, 80, 50)).toBe('critical'); // a real measured zero still is
        expect(band(49, 80, 50)).toBe('critical');
        expect(band(50, 80, 50)).toBe('warning'); // boundaries land in one band
        expect(band(79, 80, 50)).toBe('warning');
        expect(band(80, 80, 50)).toBe('good');
        expect(band(2, 2, 1)).toBe('good'); // bench depth uses 2/1
        expect(band(1, 2, 1)).toBe('warning');
        expect(band(0.3, 2, 1)).toBe('critical');
    });

    test('no number or date is formatted in the host locale', () => {
        // This product is French-first. Node and the browser both resolved the
        // host default to en-US here, so `(3371).toLocaleString()` printed
        // "3,371" — which a French reader parses as 3.371, wrong by a factor of
        // a thousand, on a headline coverage KPI. grp()'s own comment says it
        // exists to print "3 371".
        const bad = [...source.matchAll(/toLocale[A-Za-z]*\(\s*(\)|undefined)/g)];
        expect(bad.map((m) => m[0])).toEqual([]);

        const m = source.match(/function _locale\(\) \{([\s\S]*?)\n\s*\}/);
        expect(m).not.toBeNull();
        // eslint-disable-next-line no-new-func
        const mk = (I18N) => new Function('I18N', `${m[0]}; return _locale();`)(I18N);
        expect(mk({})).toBe('fr-FR'); // fallback is French, never the host
        expect(mk({ lang: '' })).toBe('fr-FR');
        expect(mk({ lang: 'en-GB' })).toBe('en-GB');
        expect((3371).toLocaleString(mk({}))).toBe('3 371'); // narrow nbsp
        expect((3371).toLocaleString(mk({ lang: 'en-GB' }))).toBe('3,371');
    });

    test('both renderers do still assign to innerHTML (the sink is real)', () => {
        // If a refactor ever stops using innerHTML the assertions above become
        // pointless; fail loudly rather than pass vacuously.
        expect(bodyOf('renderHeatmap')).toMatch(/innerHTML\s*=/);
        expect(bodyOf('renderOrgRadarSummary')).toMatch(/innerHTML\s*=/);
    });
});
