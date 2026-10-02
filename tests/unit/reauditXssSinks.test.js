'use strict';

/**
 * Four stored-XSS sinks the committee re-audit detonated in real Chromium, all
 * reached by admin-editable text going into innerHTML (or an onclick attribute):
 *
 *   X1 dashboard.js  skill-name column formatter returned raw `${v}`
 *   X2 dashboard.js  expert-skills column returned the raw GROUP_CONCAT
 *   X3 continuity    loadHandover interpolated employee names unescaped
 *   X4 nine-box      esc(name).replace(/'/g,...) was a no-op; the &#39; it
 *                    produced decoded back to ' inside onclick → arbitrary JS
 *
 * No jsdom here, so: extract each file's own escaper and PROVE it neutralises a
 * payload (the check can fail), then pin each sink to esc()/data-attributes on
 * whitespace-normalised source.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAYLOAD = `<img src=x onerror="alert(1)">O'Brien & Co`;

// Pull a `const esc = (s) => String(...).replace(/[&<>"']/g, ...)` out of a
// file and run it, so a test can never pass on the mere presence of "esc(".
const extractEsc = (src) => {
    // esc appears both as `const esc = (s) => String(...)` and as
    // `function esc(s){ return String(...) }` across these files.
    const at = src.search(/(?:const esc = \(s\) =>|function esc\(s\)\s*\{\s*return)/);
    if (at < 0) return null;
    const start = src.indexOf('String(', at);
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ';' && depth === 0) {
            end = i;
            break;
        }
    }
    // eslint-disable-next-line no-new-func
    return new Function(`return (s) => ${src.slice(start, end)};`)();
};

describe('X1/X2 — dashboard.js skill and expert formatters escape', () => {
    const src = read('public/js/dashboard.js');
    const flat = src.replace(/\s+/g, ' ');

    test('the module escaper actually neutralises markup and quotes', () => {
        const esc = extractEsc(src);
        expect(typeof esc).toBe('function');
        const out = esc(PAYLOAD);
        expect(out).not.toContain('<img');
        expect(out).toContain('&lt;img');
        expect(out).toContain('&#39;'); // the apostrophe
        expect(out).toContain('&amp;');
    });

    test('X1: the skill-name formatter runs esc on the value', () => {
        expect(flat).toMatch(
            /format: \(v, r\) => r\.isCritical \? `\$\{esc\(v\)\} <span class="badge-dot"><\/span>` : esc\(v\)/
        );
        // the raw form is gone
        expect(flat).not.toMatch(/r\.isCritical \? `\$\{v\} <span/);
    });

    test('X2: the expert-skills formatter escapes (truncate raw, then esc)', () => {
        expect(flat).toMatch(
            /format: \(v\) => esc\(v \? \(v\.length > 50 \? v\.substring\(0, 50\) \+ '\.\.\.' : v\) : ''\)/
        );
    });
});

describe('X3 — continuity handover table escapes names', () => {
    const src = read('views/pages/continuity/index.ejs');

    test('the page escaper neutralises the payload', () => {
        const esc = extractEsc(src);
        expect(typeof esc).toBe('function');
        expect(esc(PAYLOAD)).not.toContain('<img');
        expect(esc(PAYLOAD)).toContain('&lt;img');
    });

    test('loadHandover escapes both parties and the status', () => {
        const flat = src.replace(/\s+/g, ' ');
        expect(flat).toMatch(/esc\(h\.outFirst\s*\|\|\s*''\)[\s\S]*esc\(h\.outLast\s*\|\|\s*''\)/);
        expect(flat).toMatch(/esc\(h\.inFirst\s*\|\|\s*''\)/);
        expect(flat).toMatch(/<span class="badge">'\+esc\(h\.status\)/);
        // the raw splice is gone
        expect(flat).not.toMatch(/'<tr><td>'\+\(h\.outFirst\|\|''\)/);
    });
});

describe('X4 — nine-box roster passes the name safely, never spliced into onclick', () => {
    const src = read('views/pages/talent/nine-box-console.ejs');
    const flat = src.replace(/\s+/g, ' ');

    test('the name goes on an esc()-guarded data attribute', () => {
        expect(flat).toMatch(/const nmAttr = esc\(e\.firstName \+ ' ' \+ e\.lastName\)/);
        expect(flat).toMatch(/data-name="'\+nmAttr\+'"/);
        // CSP (SA-14): delegated handler, the button itself passed as '$el'
        // (csp-actions.js) — still no value spliced into an attribute as code.
        expect(flat).toMatch(/nbOn\('click','NB\.assessBtn',\['\$el'\]\)/);
        expect(flat).toMatch(
            /function nbOn\(type,fn,args\)\{ return ' data-on-'\+type\+'="'\+fn\+'" data-args="'\+esc\(JSON\.stringify\(args\|\|\[\]\)\)\+'"'; \}/
        );
    });

    test('assessBtn reads the decoded name from the dataset', () => {
        expect(flat).toMatch(
            /assessBtn\(btn\)\{ this\.assess\(btn\.dataset\.emp, btn\.dataset\.name\); \}/
        );
    });

    test('the broken escape-then-splice construction is gone', () => {
        // no value spliced into a JS-string-in-an-HTML-attribute
        expect(flat).not.toMatch(/onclick="NB\.assess\('\+e\.employeeId\+',\\''\+nm\+'\\''\)/);
        expect(flat).not.toMatch(/\.replace\(\/'\/g,"\\\\'"\)/);
        // and modal-name assignment stays textContent (safe), not innerHTML
        expect(flat).toMatch(/nb-modal-name'\)\.textContent = name/);
    });

    test('an apostrophe name no longer breaks the button (regression for O\u2019Brien)', () => {
        const esc = extractEsc(src);
        // esc'd into a double-quoted attribute: the ' becomes &#39;, which is
        // inert as attribute text and decodes to a plain ' in dataset.name.
        const attr = esc("O'Brien");
        expect(attr).toBe('O&#39;Brien');
        expect(attr).not.toContain("'"); // nothing to break the attribute
    });
});
