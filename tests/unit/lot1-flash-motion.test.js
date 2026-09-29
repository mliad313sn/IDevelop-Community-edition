/**
 * Lot 1 — « Ne plus effacer, ne plus masquer »
 * (docs/committee/UX-MOUVEMENT-SON-2026-09-16.md — §2.4, §3 M1..M5, §6, §7 lot 1, proof 6).
 *
 * WHAT WAS BROKEN (all measured on :3801 before the fix):
 *  M1  public/js/main.js selected `document.querySelectorAll('.alert')` on DOMContentLoaded
 *      and removed EVERY match 5 000 ms later — by class name, so a server refusal
 *      (« Accès refusé… »: gone at 5.6 s), the three data-management danger-zone
 *      warnings (3 → 0 at 5.6 s), the licence banner and any in-page note went with it,
 *      in a one-frame cut (`.alert` has no transition) followed by a layout jump. It did
 *      so under prefers-reduced-motion too: a CSS media query cannot see a setTimeout.
 *  M2  ui-feedback.js anchored its toasts at top:18px, inside the 48px fixed top bar —
 *      a toast covered the notification bell and its counter (toast x 1017-1262,
 *      y 18-61 ; bell centre x 1016, y 23.5).
 *  M3  self-assessment.ejs `.sa-bar{top:0}` stuck the bar UNDER the top bar after
 *      600 px of scroll: #saAutosave at y=25, Save/Submit 28/28 px masked.
 *  M4  dashboard.css replayed `fadeIn 0.3s` on every tab switch, cached tab included
 *      (panel.getAnimations() → 1 × fadeIn 300 ms on a re-click).
 *  M5  dashboard.ejs painted « Aucune mesure disponible. » and « Impossible de charger
 *      les mesures. » with class chart-loading: a gold ring spinning (a11y-spin) next
 *      to a text saying there is nothing to load.
 *
 * WHAT THIS FILE PREVENTS: any return to selection by class name; auto-dismissal of
 * anything but a server SUCCESS flash; auto-dismissal under reduced motion; a dead
 * close cross; the toast container climbing back into the top bar; the sticky bar
 * sliding back under it; the dashboard fade replaying on a cached tab; a spinner
 * ring beside an empty/error text; FR/EN drift on the close label.
 *
 * METHOD: behaviour first — main.js / ui-feedback.js / the flash.ejs close script run
 * in a vm sandbox over a small purpose-built DOM with jest fake timers (jsdom is not
 * a dependency of this project). Source assertions measure the CODE and tolerate
 * whitespace (\s*): the pre-commit hook runs prettier --write on every indexed .js.
 *
 * INTEGRATION PASS (verifiers' findings, measured on :3899):
 *  - a success banner whose close cross held the keyboard focus was removed by the
 *    5 s timer and the focus fell onto <body> — main.js now leaves it in place;
 *  - the ui-feedback toasts (3 500 / 6 000 ms) did not read window.MOTION: under
 *    prefers-reduced-motion an ERROR toast still left at 6.4 s — they now read
 *    MOTION.autoDismiss(), 0 = it waits for its cross (§2.4: one table for all timers);
 *  - the close cross was a 16.7 × 17.6 px target (WCAG 2.2 SC 2.5.8 asks 24 × 24);
 *  - focusRow() in self-assessment.ejs centred the row in the viewport, under the
 *    sticky bar on short/narrow viewports (select 9 / 15 / 36 px masked at 414x896,
 *    1280x400, 375x812) — it now sets scroll-margin-top from the bar's real height.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// A tiny DOM: enough for main.js / ui-feedback.js to boot and for the flash
// banners to be selected, faded and removed. Selectors supported: `tag`,
// `.class`, `[attr]`, `[attr="value"]`, comma lists; anything else matches nothing
// (main.js queries many selectors at boot that simply return []).
// ─────────────────────────────────────────────────────────────────────────────
function makeNode(tag, attrs) {
    const node = {
        tagName: String(tag || 'div').toUpperCase(),
        attrs: Object.assign({}, attrs || {}),
        children: [],
        parentNode: null,
        style: {},
        listeners: {},
        innerHTML: '',
        textContent: '',
        get className() {
            return this.attrs.class || '';
        },
        set className(v) {
            this.attrs.class = v;
        },
        classList: {
            contains: (c) => (node.attrs.class || '').split(/\s+/).includes(c),
            add: (c) => {
                if (!node.classList.contains(c))
                    node.attrs.class = ((node.attrs.class || '') + ' ' + c).trim();
            },
            remove: (c) => {
                node.attrs.class = (node.attrs.class || '')
                    .split(/\s+/)
                    .filter((x) => x && x !== c)
                    .join(' ');
            },
            toggle: (c, f) => {
                const on = f === undefined ? !node.classList.contains(c) : !!f;
                if (on) node.classList.add(c);
                else node.classList.remove(c);
                return on;
            },
        },
        getAttribute(n) {
            return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
        },
        setAttribute(n, v) {
            this.attrs[n] = String(v);
        },
        hasAttribute(n) {
            return Object.prototype.hasOwnProperty.call(this.attrs, n);
        },
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        removeEventListener() {},
        appendChild(c) {
            if (c.parentNode) c.parentNode.removeChild(c);
            c.parentNode = this;
            this.children.push(c);
            return c;
        },
        removeChild(c) {
            this.children = this.children.filter((x) => x !== c);
            c.parentNode = null;
            return c;
        },
        remove() {
            if (this.parentNode) this.parentNode.removeChild(this);
        },
        contains(other) {
            let e = other;
            while (e) {
                if (e === this) return true;
                e = e.parentNode;
            }
            return false;
        },
        closest(sel) {
            let e = this;
            while (e && e.matches) {
                if (e.matches(sel)) return e;
                e = e.parentNode;
            }
            return null;
        },
        matches(sel) {
            return sel.split(',').some((s) => matchSimple(this, s.trim()));
        },
        querySelectorAll(sel) {
            const out = [];
            walk(this, (n) => {
                if (n !== this && n.matches(sel)) out.push(n);
            });
            return out;
        },
        querySelector(sel) {
            return this.querySelectorAll(sel)[0] || null;
        },
        focus() {},
        get labels() {
            return [];
        },
        get offsetParent() {
            return this.parentNode;
        },
    };
    return node;
}
function walk(n, fn) {
    fn(n);
    (n.children || []).forEach((c) => walk(c, fn));
}
function matchSimple(node, sel) {
    if (!sel) return false;
    // one compound selector: tag? (.class | [attr] | [attr="v"])*
    const re = /^([a-z][\w-]*)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i;
    const m = sel.match(re);
    if (!m) return false;
    if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
    const parts = m[2].match(/\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || [];
    if (!m[1] && !parts.length) return false;
    return parts.every((p) => {
        if (p[0] === '.') return node.classList.contains(p.slice(1));
        const a = p.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/);
        if (!a) return false;
        return a[2] === undefined ? node.hasAttribute(a[1]) : node.getAttribute(a[1]) === a[2];
    });
}

function makeSandbox(opts) {
    opts = opts || {};
    const documentElement = makeNode('html');
    const head = makeNode('head');
    const body = makeNode('body');
    documentElement.appendChild(head);
    documentElement.appendChild(body);
    const document = {
        documentElement,
        head,
        body,
        readyState: 'complete',
        listeners: {},
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        removeEventListener() {},
        querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
        querySelector: (sel) => documentElement.querySelector(sel),
        getElementById: (id) => documentElement.querySelector('[id="' + id + '"]'),
        createElement: (t) => makeNode(t),
        fire(type, ev) {
            (this.listeners[type] || []).forEach((fn) => fn(ev || { target: null }));
        },
    };
    const window = {
        document,
        innerWidth: 1280,
        history: { length: 1 },
        location: { href: '', hash: '' },
        localStorage: { getItem: () => null, setItem() {} },
        sessionStorage: { getItem: () => null, setItem() {} },
        listeners: {},
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        matchMedia: opts.matchMedia || ((q) => ({ matches: false, media: q })),
        requestAnimationFrame: (fn) => setTimeout(fn, 0),
        scrollTo() {},
    };
    if (opts.MOTION !== undefined) window.MOTION = opts.MOTION;
    const sandbox = {
        window,
        document,
        localStorage: window.localStorage,
        sessionStorage: window.sessionStorage,
        matchMedia: window.matchMedia,
        requestAnimationFrame: window.requestAnimationFrame,
        console,
        Promise,
        Array,
        Object,
        String,
        Number,
        Math,
        Date,
        JSON,
        Error,
        TypeError,
        RegExp,
        HTMLFormElement: function () {},
        Set,
        Map,
        // Always route to the CURRENT global timer so jest fake timers apply.
        setTimeout: function () {
            return global.setTimeout.apply(global, arguments);
        },
        clearTimeout: function () {
            return global.clearTimeout.apply(global, arguments);
        },
        setInterval: function () {
            return global.setInterval.apply(global, arguments);
        },
        clearInterval: function () {
            return global.clearInterval.apply(global, arguments);
        },
    };
    sandbox.HTMLFormElement.prototype = { submit() {} };
    sandbox.globalThis = sandbox;
    sandbox.self = window;
    vm.createContext(sandbox);
    return { sandbox, window, document, body };
}

function runFile(ctx, rel) {
    vm.runInContext(read(rel), ctx.sandbox, { filename: rel });
}

// Flash markup as views/partials/flash.ejs renders it, plus the non-flash alerts
// that share the `.alert` class and used to die with them.
function seedFlashPage(body) {
    const mk = (cls, extra) => {
        const n = makeNode('div', Object.assign({ class: cls }, extra || {}));
        body.appendChild(n);
        return n;
    };
    return {
        licence: mk('alert alert-warning lic-banner', { id: 'licBanner', role: 'status' }),
        pageWarning: mk('alert alert-warning alert-prose'),
        pageError: mk('alert alert-error alert-prose'),
        success: mk('alert alert-success', { 'data-flash': 'success', role: 'alert' }),
        success2: mk('alert alert-success', { 'data-flash': 'success', role: 'alert' }),
        warning: mk('alert alert-warning', { 'data-flash': 'warning', role: 'status' }),
        error: mk('alert alert-error', { 'data-flash': 'error', role: 'alert' }),
    };
}
const inDom = (n) => !!n.parentNode;

// ─────────────────────────────────────────────────────────────────────────────
describe('M1 — main.js auto-dismisses ONLY [data-flash="success"] (proof 6 of lot 1)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    test('boots main.js on the stub DOM and binds the dismiss to DOMContentLoaded', () => {
        const ctx = makeSandbox({ MOTION: { reduce: false, base: 200, autoDismiss: (ms) => ms } });
        expect(() => runFile(ctx, 'public/js/main.js')).not.toThrow();
        expect(typeof ctx.window.flashAutoDismiss).toBe('function');
        expect((ctx.document.listeners.DOMContentLoaded || []).length).toBeGreaterThan(0);
    });

    test('an .alert WITHOUT data-flash is never removed; a success flash fades then leaves; warning/error flashes stay', () => {
        const ctx = makeSandbox({ MOTION: { reduce: false, base: 200, autoDismiss: (ms) => ms } });
        runFile(ctx, 'public/js/main.js');
        const n = seedFlashPage(ctx.body);
        ctx.document.fire('DOMContentLoaded');

        jest.advanceTimersByTime(4999);
        expect(Object.values(n).every(inDom)).toBe(true);
        expect(n.success.style.opacity).toBeUndefined();

        jest.advanceTimersByTime(1); // t = 5 000 ms: the success banner starts its fade, still in the DOM
        expect(n.success.style.opacity).toBe('0');
        expect(n.success2.style.opacity).toBe('0');
        expect(inDom(n.success)).toBe(true);

        jest.advanceTimersByTime(200); // t = 5 200 ms: fade over (MOTION.base), node removed
        expect(inDom(n.success)).toBe(false);
        expect(inDom(n.success2)).toBe(false);

        jest.advanceTimersByTime(60000); // one minute later: everything else is STILL there
        expect(inDom(n.licence)).toBe(true);
        expect(inDom(n.pageWarning)).toBe(true);
        expect(inDom(n.pageError)).toBe(true);
        expect(inDom(n.warning)).toBe(true);
        expect(inDom(n.error)).toBe(true);
        [n.licence, n.pageWarning, n.pageError, n.warning, n.error].forEach((x) =>
            expect(x.style.opacity).toBeUndefined()
        );
    });

    test('under MOTION.reduce nothing is removed — a success flash waits for its close button', () => {
        const ctx = makeSandbox({ MOTION: { reduce: true, base: 200, autoDismiss: () => 0 } });
        runFile(ctx, 'public/js/main.js');
        const n = seedFlashPage(ctx.body);
        ctx.document.fire('DOMContentLoaded');
        jest.advanceTimersByTime(120000);
        expect(Object.values(n).every(inDom)).toBe(true);
        expect(Object.values(n).every((x) => x.style.opacity === undefined)).toBe(true);
        expect(jest.getTimerCount()).toBe(0); // no dismiss timer was even armed
    });

    test('without window.MOTION (ui-feedback.js absent) the media query is read directly', () => {
        const reduced = makeSandbox({ matchMedia: () => ({ matches: true }) });
        runFile(reduced, 'public/js/main.js');
        const a = seedFlashPage(reduced.body);
        reduced.document.fire('DOMContentLoaded');
        jest.advanceTimersByTime(60000);
        expect(inDom(a.success)).toBe(true);

        const full = makeSandbox({ matchMedia: () => ({ matches: false }) });
        runFile(full, 'public/js/main.js');
        const b = seedFlashPage(full.body);
        full.document.fire('DOMContentLoaded');
        jest.advanceTimersByTime(5200);
        expect(inDom(b.success)).toBe(false);
        expect(inDom(b.error)).toBe(true);
        expect(inDom(b.licence)).toBe(true);
    });

    test('a success banner closed by hand before 5 s is not touched again by the timer', () => {
        const ctx = makeSandbox({ MOTION: { reduce: false, base: 200, autoDismiss: (ms) => ms } });
        runFile(ctx, 'public/js/main.js');
        const n = seedFlashPage(ctx.body);
        ctx.document.fire('DOMContentLoaded');
        jest.advanceTimersByTime(1000);
        n.success.remove();
        expect(() => jest.advanceTimersByTime(10000)).not.toThrow();
        expect(n.success.style.opacity).toBeUndefined();
    });

    test('a success banner whose close cross holds the keyboard focus is NOT removed by the timer (the focus would fall onto <body>)', () => {
        const ctx = makeSandbox({ MOTION: { reduce: false, base: 200, autoDismiss: (ms) => ms } });
        runFile(ctx, 'public/js/main.js');
        const n = seedFlashPage(ctx.body);
        const cross = makeNode('button', { class: 'flash-close', 'data-flash-close': '' });
        n.success.appendChild(cross);
        ctx.document.activeElement = cross; // the person tabbed onto the cross
        ctx.document.fire('DOMContentLoaded');
        jest.advanceTimersByTime(5200);
        expect(inDom(n.success)).toBe(true);
        expect(n.success.style.opacity).toBeUndefined();
        expect(inDom(n.success2)).toBe(false); // the other one, not focused, left as usual
    });
});

describe('M1 — the close cross (flash.ejs) works by delegation, without main.js, and removes only its own banner', () => {
    const partial = read('views/partials/flash.ejs');
    // The opening tag carries an EJS expression (`%>`), so match up to the tag's closing `">`.
    const script = (partial.match(/<script[\s\S]*?%>">([\s\S]*?)<\/script>/) || [])[1];

    test('flash.ejs ships the delegated close handler with a CSP nonce', () => {
        expect(script).toBeTruthy();
        expect(partial).toMatch(
            /<script\s+nonce="<%=\s*\(typeof cspNonce !== 'undefined'\)\s*\?\s*cspNonce\s*:\s*''\s*%>"/
        );
    });

    test('clicking the cross removes that banner, immediately, and nothing else', () => {
        const ctx = makeSandbox({});
        vm.runInContext(script, ctx.sandbox, { filename: 'flash.ejs#close' });
        const n = seedFlashPage(ctx.body);
        const cross = makeNode('button', { class: 'flash-close', 'data-flash-close': '' });
        n.error.appendChild(cross);
        const cross2 = makeNode('button', { class: 'flash-close', 'data-flash-close': '' });
        n.warning.appendChild(cross2);
        expect((ctx.document.listeners.click || []).length).toBe(1);
        ctx.document.fire('click', { target: cross });
        expect(inDom(n.error)).toBe(false);
        expect(inDom(n.warning)).toBe(true);
        expect(inDom(n.success)).toBe(true);
        expect(inDom(n.licence)).toBe(true);
        // A click anywhere else is ignored.
        ctx.document.fire('click', { target: n.success });
        expect(inDom(n.success)).toBe(true);
        // Bound once even if the partial is evaluated twice on a page.
        vm.runInContext(script, ctx.sandbox, { filename: 'flash.ejs#close-again' });
        expect((ctx.document.listeners.click || []).length).toBe(1);
    });
});

describe('§2.4 — window.MOTION (ui-feedback.js) is the single JS timer table', () => {
    function boot(matches) {
        const ctx = makeSandbox({ matchMedia: () => ({ matches }) });
        runFile(ctx, 'public/js/ui-feedback.js');
        return ctx.window.MOTION;
    }
    test('mirrors the CSS durations and exposes reduce', () => {
        const m = boot(false);
        expect(m).toEqual(
            expect.objectContaining({ reduce: false, quick: 100, base: 200, slow: 350, hold: 2000 })
        );
        expect(m.autoDismiss(5000)).toBe(5000);
    });
    test('reduced motion means « it does not leave on its own »: autoDismiss → 0, never a shorter delay', () => {
        const m = boot(true);
        expect(m.reduce).toBe(true);
        expect(m.autoDismiss(5000)).toBe(0);
        expect(m.autoDismiss(3500)).toBe(0);
    });
    test('survives a browser without matchMedia (full motion, no throw)', () => {
        const ctx = makeSandbox({});
        delete ctx.window.matchMedia;
        delete ctx.sandbox.matchMedia;
        expect(() => runFile(ctx, 'public/js/ui-feedback.js')).not.toThrow();
        expect(ctx.window.MOTION.reduce).toBe(false);
    });

    describe('the toast timers (3 500 / 6 000 ms) read the same table', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());
        function bootAndToast(matches) {
            const ctx = makeSandbox({ matchMedia: () => ({ matches }) });
            runFile(ctx, 'public/js/ui-feedback.js');
            const err = ctx.window.toast('Refus non bloquant', 'error');
            const info = ctx.window.toast('Information', 'info');
            return { ctx, err, info };
        }
        // 3.23.17 (UX-07): an error toast no longer vanishes after 6 s — it stays
        // until the reader dismisses it; an info toast still leaves at 3 800 ms.
        test('full motion: an info toast leaves at 3 800 ms, an error toast stays until dismissed', () => {
            const { err, info } = bootAndToast(false);
            jest.advanceTimersByTime(3799);
            expect(inDom(info)).toBe(true);
            jest.advanceTimersByTime(1); // 3 500 ms dismiss + 300 ms exit
            expect(inDom(info)).toBe(false);
            expect(inDom(err)).toBe(true);
            jest.advanceTimersByTime(60000); // long after the old 6 300 ms
            expect(inDom(err)).toBe(true);
        });
        test('reduced motion: no toast ever leaves on its own — it waits for its cross', () => {
            const { ctx, err, info } = bootAndToast(true);
            expect(ctx.window.MOTION.reduce).toBe(true);
            jest.advanceTimersByTime(120000);
            expect(inDom(info)).toBe(true);
            expect(inDom(err)).toBe(true);
            // The cross still works: closing is the person's act.
            err.querySelector('.uif-x').onclick();
            jest.advanceTimersByTime(300);
            expect(inDom(err)).toBe(false);
            expect(inDom(info)).toBe(true);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Source guards — the code, not its layout', () => {
    const mainJs = read('public/js/main.js');
    const flash = read('views/partials/flash.ejs');
    const uif = read('public/js/ui-feedback.js');
    const style = read('public/css/style.css');
    const sa = read('views/pages/employee/self-assessment.ejs');
    const dashCss = read('public/css/dashboard.css');
    const dashJs = read('public/js/dashboard.js');
    const dashEjs = read('views/pages/dashboard.ejs');
    const fr = require('../../locales/fr/chrome.json');
    const en = require('../../locales/en/chrome.json');

    test('M1 main.js never again selects banners by class name', () => {
        // Comments may DESCRIBE the old defect; the code may not contain it.
        const code = mainJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/querySelectorAll\(\s*['"`]\.alert['"`]\s*\)/);
        expect(code).toMatch(/querySelectorAll\(\s*['"`]\[data-flash="success"\]['"`]\s*\)/);
        expect(code).toMatch(/window\.MOTION/);
        expect(code).toMatch(/autoDismiss\(\s*5000\s*\)/);
        // The focus guard: a banner holding the keyboard focus is left alone.
        expect(code).toMatch(/banner\.contains\(\s*document\.activeElement\s*\)/);
    });
    test('§2.4 ui-feedback.js: the toast timers read MOTION.autoDismiss, and no /* global */ directive redeclares browser globals', () => {
        const code = uif.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // 3.23.17 (UX-07): errors never auto-dismiss (ttl 0); others read MOTION.
        expect(code).toMatch(
            /type\s*===\s*['"]error['"]\s*\?\s*0\s*:\s*window\.MOTION\.autoDismiss\(\s*3500\s*\)/
        );
        expect(code).not.toMatch(/setTimeout\(\s*dismiss\s*,\s*type\s*===/);
        // eslint's browser env provides these; redeclaring them fails no-redeclare and the commit.
        expect(uif).not.toMatch(/\/\*\s*global\s+[^*]*\b(document|window|globalThis)\b/);
    });
    test('M1 style.css: the close cross is a 24 × 24 px minimum target (SC 2.5.8)', () => {
        const rule = style.match(/\.flash-close\s*\{([^}]*)\}/);
        expect(rule).toBeTruthy();
        expect(rule[1]).toMatch(/min-width:\s*24px/);
        expect(rule[1]).toMatch(/min-height:\s*24px/);
    });
    test('M3 self-assessment.ejs focusRow: the scroll target is computed from the sticky bar — one scroll, never under the bar', () => {
        const fn = sa.match(/function\s+focusRow\s*\(row\)\s*\{([\s\S]*?)\n\s*\}/);
        expect(fn).toBeTruthy();
        const body = fn[1].replace(/^\s*\/\/.*$/gm, '');
        expect(body).toMatch(/getElementById\(\s*['"]saBar['"]\s*\)/);
        expect(body).toMatch(/getComputedStyle\(\s*bar\s*\)\.top/);
        expect(body).toMatch(/bar\.offsetHeight/);
        // Centred where there is room, else 8 px below the bar: Math.max(centre, covered + 8).
        expect(body).toMatch(
            /Math\.max\(\s*\(\s*window\.innerHeight\s*-\s*r\.height\s*\)\s*\/\s*2\s*,\s*covered\s*\+\s*8\s*\)/
        );
        // ONE scroll, and not scrollIntoView (its centre lands under the sticky bar).
        expect((body.match(/window\.scrollTo\(/g) || []).length).toBe(1);
        expect(body).not.toMatch(/scrollIntoView\(/);
        // Smooth only when the person has not asked for less motion (§2.4).
        expect(body).toMatch(/behavior:\s*reduce\s*\?\s*['"]auto['"]\s*:\s*['"]smooth['"]/);
        expect(body).toMatch(/window\.MOTION\s*&&\s*window\.MOTION\.reduce/);
    });
    test('M1 flash.ejs marks its origin on all three blocks, keeps its role/aria-live pairs, adds a labelled cross', () => {
        expect(flash).toMatch(
            // 3.23.17 (UX-20): a success is announced as a status, not an alert.
            /alert-success"\s+role="status"\s+aria-live="polite"\s+data-flash="success"/
        );
        expect(flash).toMatch(
            /alert-warning"\s+role="status"\s+aria-live="polite"\s+data-flash="warning"/
        );
        expect(flash).toMatch(
            /alert-error"\s+role="alert"\s+aria-live="assertive"\s+data-flash="error"/
        );
        const markup = flash.replace(/<script[\s\S]*?<\/script>/, ''); // the close handler is measured above
        expect(
            (markup.match(/<button type="button" class="flash-close" data-flash-close /g) || [])
                .length
        ).toBe(3);
        expect((markup.match(/aria-label="<%= _flashClose %>"/g) || []).length).toBe(3);
        expect((markup.match(/title="<%= _flashClose %>"/g) || []).length).toBe(3);
        expect(flash).toMatch(/__\(\s*'chrome:flash_close'\s*\)/);
        expect(flash).not.toMatch(/lic_banner_dismiss/); // generic key, not the licence one
    });
    test('M1 style.css: opacity transition on the success flash only; a close-button rule', () => {
        const rule = style.match(/\[data-flash="success"\]\s*\{([^}]*)\}/);
        expect(rule).toBeTruthy();
        expect(rule[1]).toMatch(
            /transition:\s*opacity\s+var\(--motion-base,\s*0?\.2s\)\s+var\(--motion-ease,\s*ease\)/
        );
        expect(rule[1]).not.toMatch(/max-height|height|transform/);
        expect(style).toMatch(/\.flash-close\s*\{[^}]*margin-left:\s*auto/);
        // The three prefers-reduced-motion switch blocks stay, word for word.
        expect((style.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length).toBe(2);
        expect(read('public/css/a11y-polish.css')).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\n\s*\*, \*::before, \*::after \{\n\s*animation-duration: \.001ms !important;/
        );
    });
    test('M1 chrome.json: flash_close exists in FR and EN, and the two catalogues stay in parity', () => {
        expect(fr.flash_close).toBe('Fermer');
        expect(en.flash_close).toBe('Close');
        expect(Object.keys(fr).filter((k) => !(k in en))).toEqual([]);
        expect(Object.keys(en).filter((k) => !(k in fr))).toEqual([]);
    });
    test('M2 ui-feedback.js anchors its toasts below the top bar, not at 18px', () => {
        const rule = uif.match(/\.uif-toasts\{([^}]*)\}/);
        expect(rule).toBeTruthy();
        expect(rule[1]).toMatch(
            /top:\s*calc\(\s*var\(--topbar-height(?:,\s*48px)?\)\s*\+\s*12px\s*\)/
        );
        expect(rule[1]).not.toMatch(/top:\s*18px/);
    });
    test('M3 self-assessment.ejs sticky bar starts at the top bar height', () => {
        const rule = sa.match(/\.sa-bar\s*\{([^}]*)\}/);
        expect(rule).toBeTruthy();
        expect(rule[1]).toMatch(/position:\s*sticky/);
        expect(rule[1]).toMatch(/top:\s*var\(--topbar-height(?:,\s*48px)?\)/);
        expect(rule[1]).not.toMatch(/top:\s*0\b/);
    });
    test('M4 dashboard: no fade on the base panel; a 100 ms fade only on .tab-fresh; the class follows state.loadedTabs', () => {
        const base = dashCss.match(/\.tab-panel\s*\{([^}]*)\}/);
        expect(base).toBeTruthy();
        expect(base[1]).not.toMatch(/animation/);
        const fresh = dashCss.match(/\.tab-panel\.active\.tab-fresh\s*\{([^}]*)\}/);
        expect(fresh).toBeTruthy();
        expect(fresh[1]).toMatch(/animation:\s*fadeIn\s+var\(--motion-quick,\s*0?\.1s\)/);
        expect(dashCss).not.toMatch(/fadeIn\s+0?\.3s/);
        expect(dashJs).toMatch(
            /classList\.toggle\(\s*'tab-fresh',\s*isTarget\s*&&\s*!state\.loadedTabs\.has\(tabName\)\s*\)/
        );
    });
    test('M5 dashboard.ejs: a spinner ring only ever sits next to a LOADING text', () => {
        const lines = dashEjs.split('\n');
        const ringLines = lines.filter((l) => /chart-loading/.test(l));
        expect(ringLines.length).toBeGreaterThan(0);
        ringLines.forEach((l) => expect(l).toMatch(/dash:loading/));
        const empty = lines.find((l) => /no_measures_available/.test(l));
        const error = lines.find((l) => /could_not_load_measures/.test(l));
        expect(empty).toMatch(/class="empty-state"/);
        expect(error).toMatch(/class="empty-state"\s+role="alert"/);
    });
});
