'use strict';
/**
 * One paper sheet for every page of the main layout (public/css/print.css):
 *   - linked last, media="print", after the organisation's accent block;
 *   - paper is Daylight: every ink it sets reads at 4.5:1 on the paper and on
 *     its raised surfaces, input borders at 3:1 (IDevelop's own tokens);
 *   - the accent on paper is Iris Daylight unless the organisation set its own,
 *     whose print block out-ranks it;
 *   - no chrome on paper; a printed header that the screen never shows;
 *   - a [data-print] button prints exactly once, whichever script sees it first.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../../src/utils/branding');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PRINT = read('public/css/print.css').replace(/\/\*[\s\S]*?\*\//g, '');
const LAYOUT = read('views/layouts/main.ejs');
const cr = B.contrastRatio;

function decls(selector) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = PRINT.match(new RegExp('(?:^|\\})\\s*' + esc + '\\s*\\{([^}]*)\\}'));
    const out = {};
    if (!m) return out;
    for (const d of m[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
    return out;
}
const PAPER = decls(":root,\n:root[data-theme='light']");
const ACCENT = decls(':root:root:root:root');
const hex = (v) => String(v).replace(/\s*!important$/, '');

describe('the layout links the sheet', () => {
    test('last, for print only, after the accent block', () => {
        const link = LAYOUT.indexOf('href="/css/print.css?v=<%= assetVersion %>" media="print"');
        expect(link).toBeGreaterThan(0);
        expect(link).toBeGreaterThan(LAYOUT.indexOf('/css/horizon.css'));
        expect(link).toBeGreaterThan(LAYOUT.indexOf('/css/viz.css'));
        expect(link).toBeGreaterThan(LAYOUT.indexOf('_brand.accentCss %></style>'));
    });

    test('a printed header the screen never shows', () => {
        expect(LAYOUT).toMatch(/<div class="print-header" aria-hidden="true">/);
        expect(LAYOUT).toContain("__('chrome:print_internal_use')");
        expect(read('public/css/style.css')).toMatch(/\.print-header \{\s*display: none;\s*\}/);
        expect(PRINT).toMatch(/\.print-header \{\s*display: flex !important;/);
        for (const lang of ['en', 'fr'])
            expect(JSON.parse(read(`locales/${lang}/chrome.json`)).print_internal_use).toBeTruthy();
    });

    test('A4, and no chrome on paper', () => {
        expect(PRINT).toMatch(/@page \{\s*size: A4;/);
        for (const sel of ['.topbar', '#appSidebar', '.breadcrumbs', '.help-fab', '.cmdk', '.btn'])
            expect(PRINT).toContain(sel + ',');
    });
});

describe('paper is Daylight and every ink holds AA', () => {
    const paper = hex(PAPER['bg-card']);
    const raised = [hex(PAPER['bg-elevated']), hex(PAPER['bg-inset'])];

    test('the sheet sets the surfaces, with !important', () => {
        for (const k of ['bg-base', 'bg-panel', 'bg-card', 'bg-elevated', 'text-primary'])
            expect(PAPER[k]).toMatch(/^#[0-9a-f]{6} !important$/);
        expect(paper).toBe('#ffffff');
    });

    test.each([
        'text-primary',
        'text-secondary',
        'text-muted',
        'emerald-text',
        'amber-text',
        'red-text',
        'blue-text',
        'viz-good',
        'viz-warn',
        'viz-risk',
        'viz-unmeasured',
        'viz-text-dim',
    ])('%s reads at 4.5:1 on paper and on raised surfaces', (k) => {
        for (const s of [paper, ...raised])
            expect(cr(hex(PAPER[k]), s)).toBeGreaterThanOrEqual(4.5);
    });

    test('input borders hold 3:1', () => {
        for (const s of [paper, ...raised])
            expect(cr(hex(PAPER['border-input']), s)).toBeGreaterThanOrEqual(3);
    });

    test('the paper values are the Daylight values of the theme', () => {
        const horizon = read('public/css/horizon.css');
        for (const v of ['#1f1d3a', '#514f6b', '#63617d', '#7d7a95'])
            expect(horizon.toLowerCase()).toContain(v);
    });
});

describe('the accent on paper', () => {
    test('Iris Daylight, not forced, so an organisation accent wins', () => {
        expect(ACCENT.brand).toBe('#5b4be0');
        for (const v of Object.values(ACCENT)) expect(v).not.toMatch(/!important/);
        expect(cr(ACCENT['brand-text'], '#ffffff')).toBeGreaterThanOrEqual(4.5);
        expect(cr(ACCENT.brand, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    });

    test("the organisation's print block out-ranks the sheet's", () => {
        const css = B.buildAccentCss('#ffe066');
        const sel = css.match(/@media print\{([^{]+)\{/)[1];
        const count = (s) => (s.match(/:root/g) || []).length;
        expect(count(sel)).toBeGreaterThan(count(':root:root:root:root'));
    });
});

describe('[data-print] prints exactly once', () => {
    function world() {
        const listeners = [];
        let printed = 0;
        const btn = {
            nodeType: 1,
            hasAttribute: () => false,
            getAttribute: () => null,
            parentNode: null,
            closest: (sel) => (sel === '[data-print]' ? btn : null),
        };
        const document = {
            readyState: 'complete',
            addEventListener: (type, fn) => listeners.push({ type, fn }),
            querySelectorAll: () => [],
        };
        const window = {
            print: () => {
                printed += 1;
            },
            console,
        };
        const ctx = vm.createContext({ document, window, console });
        const click = () => {
            const ev = {
                target: btn,
                defaultPrevented: false,
                preventDefault() {
                    this.defaultPrevented = true;
                },
                stopPropagation() {},
            };
            for (const l of listeners) if (l.type === 'click') l.fn(ev);
        };
        return { ctx, click, printed: () => printed };
    }

    test('csp-actions alone prints it', () => {
        const w = world();
        vm.runInContext(read('public/js/csp-actions.js'), w.ctx);
        w.click();
        expect(w.printed()).toBe(1);
    });

    test.each(['public/js/board-pack.js', 'public/js/idp-detail.js'])(
        'with %s on the page, once in either order',
        (page) => {
            for (const order of [
                [page, 'public/js/csp-actions.js'],
                ['public/js/csp-actions.js', page],
            ]) {
                const w = world();
                for (const f of order) vm.runInContext(read(f), w.ctx);
                w.click();
                expect(w.printed()).toBe(1);
            }
        }
    );
});
