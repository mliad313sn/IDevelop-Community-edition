'use strict';
/**
 * Layout guards on IDevelop's own stylesheets and views (Open Horizon tokens):
 *   1. z-index: the 8-step scale is declared in ascending order, and every
 *      z-index of the chrome (style, a11y-polish, help, horizon, login, the
 *      chrome partials and the chrome scripts) is a step of it — or 0, 1 or
 *      auto for an order local to a component;
 *   2. type floor: no font under 12 px — in every stylesheet and in every view
 *      (<style> blocks, style="" attributes, scripts that set cssText) — except
 *      the icon-only selectors pinned in ICON_ALLOW;
 *   3. the table pattern exists: the actions column is sticky, a wide table
 *      shows a scroll cue, a card table turns into cards under 768 px, and a
 *      scroll box clips what it holds;
 *   4. phones: a tab bar wraps, a help sentence wraps, long code breaks.
 * Each rule was mutation-checked: removing it makes its test fail.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

function walk(dir, ext, out = []) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== 'vendor') walk(p, ext, out);
        } else if (e.name.endsWith(ext) && !e.name.endsWith('.min.css')) out.push(p);
    }
    return out;
}

const Z_SCALE = [
    'dropdown',
    'sticky',
    'fixed',
    'drawer',
    'modal-backdrop',
    'modal',
    'popover',
    'toast',
];

describe('1 — the z-index scale', () => {
    const style = read('public/css/style.css');

    test(':root declares the 8 steps in ascending order', () => {
        const vals = Z_SCALE.map((k) => {
            const m = style.match(new RegExp('--z-' + k + ':\\s*(\\d+)'));
            return m ? Number(m[1]) : NaN;
        });
        expect(vals.every((v) => Number.isFinite(v))).toBe(true);
        for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    });

    const CHROME = [
        'public/css/style.css',
        'public/css/a11y-polish.css',
        'public/css/help.css',
        'public/css/horizon.css',
        'public/css/login.css',
        'views/partials/header.ejs',
        'views/partials/sidebar.ejs',
        'views/partials/command-palette.ejs',
        'views/partials/page-toc.ejs',
        'views/partials/contextual-help.ejs',
        'views/partials/bulk-bar.ejs',
        'public/js/ui-feedback.js',
        'public/js/shared-device.js',
        'public/js/sync-indicator.js',
        'public/js/nav-rail.js',
    ];
    const STEP = Z_SCALE.join('|');
    test.each(CHROME)('%s uses only steps of the scale', (file) => {
        const src = file.endsWith('.css') ? stripComments(read(file)) : read(file);
        const bad = [];
        const re = /z-index\s*:\s*([^;}'"\n]+)/g;
        let m;
        while ((m = re.exec(src))) {
            const v = m[1].trim();
            const ok =
                /^(0|1|auto)$/.test(v) ||
                new RegExp('^var\\(--z-(' + STEP + ')(,\\s*\\d+)?\\)$').test(v) ||
                new RegExp('^calc\\(var\\(--z-(' + STEP + ')\\)\\s*[+-]\\s*\\d+\\)$').test(v);
            if (!ok) bad.push(v);
        }
        expect(bad).toEqual([]);
    });

    test('the open phone drawer sits on the drawer step, its backdrop just under it', () => {
        expect(style).toMatch(
            /body\.has-sidebar\.sidebar-open \.sidebar \{ z-index: var\(--z-drawer\); \}/
        );
        expect(style).toMatch(
            /body\.has-sidebar\.sidebar-open \.nav-backdrop \{[^}]*z-index: calc\(var\(--z-drawer\) - 1\)/
        );
    });
});

describe('2 — the 12 px type floor', () => {
    // Icon-only selectors (chevrons, the sort arrow, the folded-rail dots): a
    // glyph, never text a person reads.
    const ICON_ALLOW = [
        '.sidebar-section-chevron',
        '.sidebar-hub-chevron',
        '.sidebar-entry-toggle i',
        '.sidebar-link i.sidebar-hub-chevron',
        '.topbar-arrow',
        '.table th.sortable::after',
        '.sidebar-collapsed .sidebar-section-label::after',
    ];
    const NUM = /(\d*\.?\d+)(px|rem)\b/;
    function tooSmall(value) {
        const m = String(value).match(NUM);
        if (!m) return false;
        const n = Number(m[1]);
        const px = m[2] === 'px' ? n : n * 16;
        return px > 1 && px < 12;
    }
    /** font-size / font shorthand values under 12 px in a CSS text, with their selector. */
    function scanCss(css) {
        const out = [];
        for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            const sel = m[1].trim().replace(/\s+/g, ' ');
            const sels = sel.split(',').map((x) => x.trim());
            if (sels.every((x) => ICON_ALLOW.includes(x))) continue;
            for (const d of m[2].matchAll(/(?:^|[;\s{])font(-size)?\s*:\s*([^;}]+)/g)) {
                if (tooSmall(d[2])) out.push(`${sel} { font${d[1] || ''}: ${d[2].trim()} }`);
            }
        }
        return out;
    }

    test.each(walk('public/css', '.css'))('%s', (file) => {
        expect(scanCss(read(file))).toEqual([]);
    });

    test('every view: <style> blocks, style="" attributes and cssText strings', () => {
        const bad = [];
        for (const file of walk('views', '.ejs')) {
            const src = read(file);
            for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
                for (const x of scanCss(m[1])) bad.push(`${file}: ${x}`);
            for (const m of src.matchAll(/font(-size)?\s*:\s*([^;"'}\n]+)/g)) {
                if (
                    /<style/.test(src.slice(Math.max(0, m.index - 4000), m.index)) &&
                    !/<\/style>/.test(src.slice(Math.max(0, m.index - 4000), m.index))
                )
                    continue; // inside a <style> block: scanned above
                if (tooSmall(m[2])) bad.push(`${file}: font${m[1] || ''}: ${m[2].trim()}`);
            }
        }
        expect(bad).toEqual([]);
    });

    test('client scripts never set a font under 12 px either', () => {
        const bad = [];
        for (const file of walk('public/js', '.js')) {
            for (const m of read(file).matchAll(/font(-size)?\s*:\s*([^;"'}\n]+)/g))
                if (tooSmall(m[2])) bad.push(`${file}: ${m[0]}`);
        }
        expect(bad).toEqual([]);
    });

    test('the guard itself catches a small size (mutation check)', () => {
        expect(scanCss('.x { font-size: 11px; }')).toHaveLength(1);
        expect(scanCss('.x { font: 600 0.7rem/1 var(--font-data); }')).toHaveLength(1);
        expect(scanCss('.sidebar-section-chevron { font-size: 9px; }')).toEqual([]);
        expect(scanCss('.x { font-size: 0.75rem; } .y { font-size: 1.1em; }')).toEqual([]);
    });
});

describe('3 — the table pattern', () => {
    const style = read('public/css/style.css');
    const horizon = read('public/css/horizon.css');
    const main = read('public/js/main.js');

    test('the actions column is sticky on the right', () => {
        expect(style).toMatch(
            /\.table :is\(th, td\)\.col-actions \{\s*position: sticky;\s*right: 0;/
        );
        expect(horizon).toMatch(/\.table-sticky-actions td:last-child \{\s*position: sticky;/);
    });

    test('a wide table shows the scroll cue until the first scroll', () => {
        expect(style).toMatch(/\.table-wrapper\.is-scrollable \{/);
        expect(style).toMatch(
            /\.table-wrapper\.is-scrollable:not\(\.is-scrolled\)::after \{\s*content: attr\(data-scroll-hint\);/
        );
        expect(main).toMatch(/box\.classList\.toggle\('is-scrollable', over\)/);
        expect(main).toMatch(/box\.classList\.add\('is-scrolled'\)/);
        expect(main).toMatch(/__UIF_I18N__\.scrollHint/);
    });

    test('a card table becomes labelled cards under 768 px', () => {
        expect(horizon).toMatch(
            /@media \(max-width: 767px\)[\s\S]*\.table\.table-cards tbody tr \{/
        );
        expect(horizon).toMatch(
            /\.table\.table-cards td\[data-label\]::before \{\s*content: attr\(data-label\);/
        );
        expect(main).toMatch(/function hzLabelCardTables/);
    });

    test('the scroll box is the containing block of what it holds', () => {
        expect(style).toMatch(/\.table-wrapper \{\s*position: relative;\s*\}/);
    });
});

describe('4 — phones: nothing wider than the screen', () => {
    const style = read('public/css/style.css');
    test('tab bars wrap; long code breaks; a help sentence wraps like a paragraph', () => {
        expect(style).toMatch(
            /@media \(max-width: 767\.98px\) \{\s*\.tabs,\s*\[role='tablist'\] \{\s*flex-wrap: wrap;/
        );
        expect(style).toMatch(/\.main-content code \{\s*overflow-wrap: anywhere;/);
        expect(style).toMatch(/\.help-text \{[^}]*display: block;/);
    });
    test('a checkbox in a form group keeps its own width', () => {
        expect(style).toMatch(
            /\.form-group input\[type='checkbox'\],\s*\.form-group input\[type='radio'\] \{\s*width: auto;/
        );
    });

    test('a long status label wraps inside its chip', () => {
        expect(style).toMatch(
            /\.main-content \.badge \{\s*max-width: 100%;\s*white-space: normal;/
        );
    });

    test('a grid track never asks for more than its container (minmax(min(N px, 100%), 1fr))', () => {
        const bad = [];
        for (const file of [...walk('views', '.ejs'), ...walk('public/css', '.css')]) {
            for (const m of read(file).matchAll(/minmax\(\s*(\d+)px\s*,\s*1fr\s*\)/g))
                if (Number(m[1]) >= 200) bad.push(`${file}: ${m[0]}`);
        }
        expect(bad).toEqual([]);
    });

    test('the rail labels wrap instead of being cut; every drawer row is a 44 px target', () => {
        expect(style).toMatch(
            /\.sidebar-link-text \{ flex: 1 1 auto; min-width: 0; white-space: normal; overflow-wrap: anywhere; \}/
        );
        expect(style).toMatch(
            /\.sidebar-link,\s*\.sidebar-link\.sidebar-sublink \{ min-height: 44px; \}/
        );
    });
});
