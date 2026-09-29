/**
 * 3.23.17 — lane G-ux (external UX review). Behaviour first: the client scripts
 * run in a small vm DOM, the views are RENDERED with the real locale catalogues,
 * and the colour fixes are checked by COMPUTING WCAG contrast on the shipped
 * token values.
 *
 *  UX-01  icons self-hosted (every url() of the vendored Font Awesome resolves to
 *         a shipped file) and no view emits a third-party request by default.
 *  UX-02  light-theme button ink and status-as-text colours ≥ 4.5:1.
 *  UX-10  input boundary ≥ 3:1 in both themes (WCAG 1.4.11).
 *  UX-04  Talent tab pipeline / 9-box labels come from __I18N__, not English.
 *  UX-14  printable EDP: localised headings, labels for enum codes, camelCased
 *         rows actually printed, sections in order.
 *  UX-06  labels are linked to their controls.
 *  UX-07  toast close is a <button> with a name; errors stay until dismissed;
 *         success flash is role=status.
 *  UX-12  self-assessment shortcuts act only inside a rating row.
 *  UX-08  9-box assess popup: no preset axes, required, real dialog.
 *  UX-11  mobile drawer inert when closed, aria-expanded, Escape closes.
 *  main.js showToast renders its message as TEXT.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─────────────────────────────── tiny DOM ────────────────────────────────────
function makeNode(tag, attrs, doc) {
    const node = {
        nodeType: 1,
        tagName: String(tag || 'div').toUpperCase(),
        attrs: Object.assign({}, attrs || {}),
        children: [],
        parentNode: null,
        style: {},
        listeners: {},
        _html: '',
        textContent: '',
        value: '',
        disabled: false,
        get innerHTML() {
            return this._html;
        },
        set innerHTML(v) {
            this._html = String(v);
            this.htmlWrites = (this.htmlWrites || 0) + 1;
        },
        get id() {
            return this.attrs.id || '';
        },
        set id(v) {
            this.attrs.id = v;
        },
        get type() {
            return this.attrs.type || '';
        },
        set type(v) {
            this.attrs.type = v;
        },
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
        removeAttribute(n) {
            delete this.attrs[n];
        },
        hasAttribute(n) {
            return Object.prototype.hasOwnProperty.call(this.attrs, n);
        },
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
            this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
        },
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
        focus() {
            if (doc) doc.activeElement = this;
        },
        dispatchEvent() {
            return true;
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
    const s = sel.replace(/:not\(\[disabled\]\)|:not\(\[type="hidden"\]\)/g, '');
    const m = s.match(/^([a-z][\w-]*)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i);
    if (!m) return false;
    if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
    const parts = m[2].match(/\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || [];
    if (!m[1] && !parts.length) return false;
    if (/:not\(\[disabled\]\)/.test(sel) && node.disabled) return false;
    if (/:not\(\[type="hidden"\]\)/.test(sel) && node.getAttribute('type') === 'hidden')
        return false;
    return parts.every((p) => {
        if (p[0] === '.') return node.classList.contains(p.slice(1));
        const a = p.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/);
        return a[2] === undefined ? node.hasAttribute(a[1]) : node.getAttribute(a[1]) === a[2];
    });
}

function makeSandbox(opts) {
    opts = opts || {};
    const document = {
        readyState: 'complete',
        listeners: {},
        activeElement: null,
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
            this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
        },
        querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
        querySelector: (sel) => documentElement.querySelector(sel),
        getElementById: (id) => documentElement.querySelector('[id="' + id + '"]'),
        createElement: (t) => makeNode(t, null, document),
        contains: (n) => documentElement.contains(n),
        fire(type, ev) {
            (this.listeners[type] || []).slice().forEach((fn) => fn(ev));
        },
    };
    const documentElement = makeNode('html', null, document);
    const head = makeNode('head', null, document);
    const body = makeNode('body', null, document);
    documentElement.appendChild(head);
    documentElement.appendChild(body);
    Object.assign(document, { documentElement, head, body });
    document.activeElement = body;
    const window = {
        document,
        innerWidth: opts.innerWidth || 1280,
        innerHeight: 800,
        scrollY: 0,
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
    if (opts.I18N) window.__UIF_I18N__ = opts.I18N;
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
        Set,
        Map,
        Event: function (type) {
            this.type = type;
        },
        HTMLFormElement: function () {},
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
    return { sandbox, window, document, body, mk: (t, a) => makeNode(t, a, document) };
}
const runFile = (ctx, rel) => vm.runInContext(read(rel), ctx.sandbox, { filename: rel });
const inDom = (n) => !!n.parentNode;

// ─────────────────────────── i18n for rendering ──────────────────────────────
function makeT(lang) {
    const cache = {};
    return (key, vars) => {
        const [ns, k] = key.includes(':') ? key.split(/:(.+)/) : ['common', key];
        if (!cache[ns]) {
            const p = path.join(ROOT, 'locales', lang, ns + '.json');
            cache[ns] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
        }
        let v = cache[ns][k];
        if (v === undefined)
            v = k
                .split('.')
                .reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), cache[ns]);
        if (typeof v !== 'string') return key; // i18next returns the key when missing
        return vars ? v.replace(/\{\{(\w+)\}\}/g, (m, n) => (vars[n] != null ? vars[n] : m)) : v;
    };
}
function render(rel, locals, lang) {
    const file = path.join(ROOT, rel);
    return ejs.render(
        fs.readFileSync(file, 'utf8'),
        Object.assign(
            { __: makeT(lang || 'fr'), cspNonce: 'n', assetVersion: '1', csrfToken: 't' },
            locals
        ),
        { filename: file }
    );
}

// ─────────────────────────────── contrast ────────────────────────────────────
const hex = (h) => {
    h = h.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16));
};
const lum = (c) => {
    const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const cr = (a, b) => {
    const x = lum(hex(a)),
        y = lum(hex(b));
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** The CASCADED value of a custom property for a theme: every block that
 *  targets the theme is applied in source order, later wins (as the browser does). */
function tokens(css, theme) {
    const out = {};
    // A top-level rule starts at the beginning of the sheet or right after a `}`
    // (lookbehind: the previous match already consumed that brace).
    const blockRe = /(?:^|(?<=\}))\s*([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = blockRe.exec(css))) {
        m = [m[0], '', m[1], m[2]];
        const sel = m[2].trim();
        const applies =
            theme === 'light'
                ? /^(:root|\[data-theme="light"\])$/.test(sel)
                : /^(:root|:root:not\(\[data-theme="light"\]\))$/.test(sel);
        if (!applies) continue;
        m[3].replace(/--([\w-]+)\s*:\s*([^;]+);/g, (x, k, v) => {
            out[k] = v.trim();
        });
    }
    return out;
}

// ═════════════════════════════════ tests ═════════════════════════════════════

describe('UX-01 — icons are self-hosted, web fonts are opt-in', () => {
    test('every url() in the vendored Font Awesome resolves to a shipped file', () => {
        const cssRel = 'public/vendor/fontawesome/css/all.min.css';
        const css = read(cssRel);
        const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/["']/g, ''));
        expect(urls.length).toBeGreaterThan(0);
        urls.forEach((u) => {
            const abs = path.resolve(path.dirname(path.join(ROOT, cssRel)), u);
            expect(fs.existsSync(abs)).toBe(true);
        });
        expect(css).toMatch(/Font Awesome Free 6\.4\.0/);
    });

    const pages = [
        ['views/pages/auth/login.ejs', { branding: null }],
        ['views/pages/auth/forgot-password.ejs', {}],
        ['views/pages/auth/reset-password.ejs', { token: 'x' }],
    ];
    test.each(pages)(
        '%s: loads the local icon CSS and calls no third party by default',
        (rel, locals) => {
            let html;
            try {
                html = render(
                    rel,
                    Object.assign({ success: [], errors: [], warnings: [], lang: 'fr' }, locals)
                );
            } catch (e) {
                // A page needing more locals than this harness gives is not what is under
                // test; its <head> is. Render just the head.
                const src = read(rel);
                const head = src.slice(0, src.indexOf('</head>') + 7);
                html = ejs.render(
                    head,
                    Object.assign({ __: makeT('fr'), cspNonce: 'n', assetVersion: '1' }, locals),
                    { filename: path.join(ROOT, rel) }
                );
            }
            expect(html).toContain('/vendor/fontawesome/css/all.min.css');
            expect(html).not.toMatch(/cdnjs\.cloudflare\.com/);
            expect(html).not.toMatch(/fonts\.googleapis\.com/);
            // …and a deployment that explicitly enables external fonts still gets them.
            const src = read(rel);
            const head = src.slice(0, src.indexOf('</head>') + 7);
            const on = ejs.render(
                head,
                Object.assign(
                    { __: makeT('fr'), cspNonce: 'n', assetVersion: '1', externalFonts: true },
                    locals
                ),
                { filename: path.join(ROOT, rel) }
            );
            expect(on).toMatch(/fonts\.googleapis\.com/);
            expect(on).not.toMatch(/cdnjs\.cloudflare\.com/);
        }
    );
});

describe('UX-02 / UX-10 — computed contrast of the shipped tokens', () => {
    const css = (read('public/css/style.css') + '\n' + read('public/css/a11y-polish.css')).replace(
        /\/\*[\s\S]*?\*\//g,
        ''
    );
    const L = tokens(css, 'light');
    const D = tokens(css, 'dark');
    const lightSurfaces = ['#FFFFFF', '#F4F5FB', '#F8F8FD', '#ECEEF7'];

    test('the parser really reads each theme (guard against a vacuous pass)', () => {
        expect(L.brand).toBe('#5B4BE0');
        expect(D.brand).toBe('#7C6CFF');
    });
    test('light theme: primary-button ink on every brand stop ≥ 4.5:1', () => {
        ['brand', 'brand-hover', 'brand-pressed'].forEach((g) => {
            expect(cr(L['text-inverse'], L[g])).toBeGreaterThanOrEqual(4.5);
        });
    });
    test('dark theme: primary-button ink unchanged and ≥ 4.5:1', () => {
        expect(D['text-inverse']).toBe('#0A0C18');
        expect(cr(D['text-inverse'], D.brand)).toBeGreaterThanOrEqual(4.5);
    });
    test('light theme: status colours used as TEXT hold 4.5:1 on every light surface', () => {
        ['emerald', 'amber', 'red', 'blue', 'success', 'warning', 'danger', 'info'].forEach((k) => {
            lightSurfaces.forEach((bg) => {
                expect([k, bg, cr(L[k], bg) >= 4.5]).toEqual([k, bg, true]);
            });
        });
    });
    test('input boundary ≥ 3:1 against every surface a field sits on (both themes)', () => {
        lightSurfaces.forEach((bg) => expect(cr(L['border-input'], bg)).toBeGreaterThanOrEqual(3));
        ['#1F2442', '#151931', '#0F1222', '#0A0C18'].forEach((bg) =>
            expect(cr(D['border-input'], bg)).toBeGreaterThanOrEqual(3)
        );
    });
});

describe('UX-07 — ui-feedback toasts', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    const boot = () => {
        const ctx = makeSandbox({ I18N: { close: 'Fermer la notification' } });
        runFile(ctx, 'public/js/ui-feedback.js');
        return ctx;
    };
    test('the close control is a keyboard-reachable <button> with an accessible name', () => {
        const ctx = boot();
        const t = ctx.window.toast('Enregistré', 'success');
        const x = t.querySelector('.uif-x');
        expect(x.tagName).toBe('BUTTON');
        expect(x.getAttribute('type')).toBe('button');
        expect(x.getAttribute('aria-label')).toBe('Fermer la notification');
    });
    test('an error toast stays until it is dismissed; others still leave on their own', () => {
        const ctx = boot();
        const err = ctx.window.toast('Refus', 'error');
        const info = ctx.window.toast('Information', 'info');
        jest.advanceTimersByTime(120000);
        expect(inDom(info)).toBe(false);
        expect(inDom(err)).toBe(true);
        expect(err.getAttribute('role')).toBe('alert');
        err.querySelector('.uif-x').onclick();
        jest.advanceTimersByTime(300);
        expect(inDom(err)).toBe(false);
    });
    test('an explicit type wins over the wording; aliases are normalised', () => {
        const ctx = boot();
        expect(ctx.window.toast('Erreur corrigée avec succès', 'success').className).toContain(
            'uif-success'
        );
        expect(ctx.window.toast('Attention', 'warning').className).toContain('uif-warn');
        expect(ctx.window.toast('Oups', 'danger').className).toContain('uif-error');
    });
});

describe('UX-07 — flash banners', () => {
    test('a success flash is role=status (polite); an error flash stays role=alert', () => {
        const html = render('views/partials/flash.ejs', {
            success: ['ok'],
            errors: ['ko'],
            warnings: [],
        });
        expect(html).toMatch(/class="alert alert-success" role="status"/);
        expect(html).toMatch(/class="alert alert-error" role="alert"/);
    });
});

describe('main.js — showToast renders text, mobile drawer is inert when closed (UX-11)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    function bootMain(width) {
        const ctx = makeSandbox({ innerWidth: width });
        ctx.body.attrs.class = 'has-sidebar';
        const sidebar = ctx.mk('aside', { id: 'appSidebar', class: 'sidebar' });
        const link = ctx.mk('a', { href: '/dashboard' });
        sidebar.appendChild(link);
        const menuBtn = ctx.mk('button', { id: 'mobileMenuToggle' });
        const other = ctx.mk('button', { id: 'somewhere' });
        ctx.body.appendChild(menuBtn);
        ctx.body.appendChild(sidebar);
        ctx.body.appendChild(other);
        runFile(ctx, 'public/js/main.js');
        ctx.document.fire('DOMContentLoaded', {});
        return { ctx, sidebar, link, menuBtn, other };
    }
    test('showToast puts the message in as TEXT, never as markup', () => {
        const { ctx } = bootMain(1280);
        const evil = '<img src=x onerror="window.pwned=1">';
        const t = ctx.window.showToast(evil, 'error');
        const msg = t.querySelector('.toast-message');
        expect(msg.textContent).toBe(evil);
        expect(t.htmlWrites || 0).toBe(0);
        expect(msg.htmlWrites || 0).toBe(0);
        expect(t.querySelector('.toast-close').getAttribute('type')).toBe('button');
    });
    test('phone: the closed drawer is inert, the hamburger says collapsed', () => {
        const { sidebar, menuBtn } = bootMain(375);
        expect(sidebar.hasAttribute('inert')).toBe(true);
        expect(menuBtn.getAttribute('aria-expanded')).toBe('false');
        expect(menuBtn.getAttribute('aria-controls')).toBe('appSidebar');
    });
    test('phone: opening removes inert, moves focus in; Escape closes and returns focus', () => {
        const { ctx, sidebar, link, menuBtn } = bootMain(375);
        ctx.sandbox.toggleSidebar();
        expect(ctx.body.classList.contains('sidebar-open')).toBe(true);
        expect(sidebar.hasAttribute('inert')).toBe(false);
        expect(menuBtn.getAttribute('aria-expanded')).toBe('true');
        expect(ctx.document.activeElement).toBe(link);
        ctx.document.fire('keydown', { key: 'Escape', target: link, preventDefault() {} });
        expect(ctx.body.classList.contains('sidebar-open')).toBe(false);
        expect(sidebar.hasAttribute('inert')).toBe(true);
        expect(ctx.document.activeElement).toBe(menuBtn);
    });
    test('desktop: the sidebar is never inert', () => {
        const { sidebar } = bootMain(1280);
        expect(sidebar.hasAttribute('inert')).toBe(false);
    });
});

describe('UX-12 — self-assessment shortcuts act only inside a rating row', () => {
    // The page's own keydown handler, executed against a fake roster.
    function extractHandler() {
        const src = read('views/pages/employee/self-assessment.ejs');
        const start = src.indexOf("document.addEventListener('keydown', (e) => {");
        expect(start).toBeGreaterThan(-1);
        let depth = 0,
            i = src.indexOf('{', start);
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) break;
        }
        return src.slice(start, src.indexOf(';', i) + 1);
    }
    function setup() {
        const ctx = makeSandbox({});
        const rows = [0, 1].map((i) => {
            const tr = ctx.mk('tr', { class: 'sa-row' });
            const sel = ctx.mk('select', { class: 'self-rating-select' });
            sel.value = '';
            const comment = ctx.mk('textarea', {});
            tr.appendChild(sel);
            tr.appendChild(comment);
            ctx.body.appendChild(tr);
            return tr;
        });
        const next = ctx.mk('button', { id: 'saNextUnrated' });
        next.click = () => {};
        const search = ctx.mk('input', { id: 'saSearch', type: 'search' });
        ctx.body.appendChild(next);
        ctx.body.appendChild(search);
        rows[0].classList.add('sa-focus');
        ctx.sandbox.rows = rows;
        ctx.sandbox.focusRow = jest.fn();
        vm.runInContext(extractHandler(), ctx.sandbox);
        const press = (key, target) => {
            const ev = {
                key,
                target,
                preventDefault: jest.fn(),
                ctrlKey: false,
                metaKey: false,
                altKey: false,
            };
            ctx.document.fire('keydown', ev);
            return ev;
        };
        return { ctx, rows, search, press };
    }
    test('a digit pressed with the focus on the page body rates nothing', () => {
        const { ctx, rows, press } = setup();
        press('2', ctx.body);
        expect(rows[0].querySelector('.self-rating-select').value).toBe('');
        press('j', ctx.body);
        expect(ctx.sandbox.focusRow).not.toHaveBeenCalled();
    });
    test('typing in the search box or a comment never rates', () => {
        const { rows, search, press } = setup();
        press('3', search);
        press('3', rows[1].querySelector('textarea'));
        expect(rows[0].querySelector('.self-rating-select').value).toBe('');
        expect(rows[1].querySelector('.self-rating-select').value).toBe('');
    });
    test('on a rating select, the digit rates THAT row', () => {
        const { rows, press } = setup();
        const sel = rows[1].querySelector('.self-rating-select');
        const ev = press('3', sel);
        expect(sel.value).toBe('3');
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(rows[0].querySelector('.self-rating-select').value).toBe('');
    });
});

describe('UX-08 — 9-box assess popup', () => {
    function boot() {
        const html = render('views/pages/talent/nine-box-console.ejs', {}, 'fr');
        const ctx = makeSandbox({});
        const ids = [...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]);
        const byId = {};
        ids.forEach((id) => {
            byId[id] = ctx.mk(
                /nb-(perf|pot|tier|trend)$/.test(id)
                    ? 'select'
                    : id === 'nb-comments'
                      ? 'textarea'
                      : 'div',
                { id }
            );
        });
        const box = byId['nb-modal-box'];
        ['nb-perf', 'nb-pot', 'nb-comments'].forEach((id) => box.appendChild(byId[id]));
        const cancel = ctx.mk('button', { class: 'btn' });
        const createBtn = ctx.mk('button', { class: 'btn' });
        box.appendChild(cancel);
        box.appendChild(createBtn);
        byId['nb-modal'].appendChild(box);
        Object.keys(byId).forEach((id) => {
            if (!byId[id].parentNode) ctx.body.appendChild(byId[id]);
        });
        ctx.body.appendChild(byId['nb-modal']);
        const opener = ctx.mk('button', { class: 'assess' });
        ctx.body.appendChild(opener);
        const posted = [];
        ctx.sandbox.SAConsoleNet = new Proxy({}, { get: () => () => new Promise(() => {}) });
        ctx.sandbox.fetch = () => new Promise(() => {});
        const scripts = [...html.matchAll(/<script nonce="n">([\s\S]*?)<\/script>/g)].map(
            (m) => m[1]
        );
        const page = scripts.find((s) => /const NB\s*=|var NB\s*=|NB\s*=\s*\{/.test(s));
        vm.runInContext(page.replace(/\bconst NB\b/, 'var NB'), ctx.sandbox);
        const NB = ctx.sandbox.NB;
        NB.api = (url, method, body) => {
            if (method === 'POST') posted.push(body);
            return new Promise(() => {});
        };
        return { html, ctx, NB, byId, opener, posted, createBtn };
    }
    test('the rendered axes carry no preset and are required', () => {
        const { html } = boot();
        ['nb-perf', 'nb-pot'].forEach((id) => {
            const sel = html.match(
                new RegExp('<select id="' + id + '"[^>]*>([\\s\\S]*?)</select>')
            );
            expect(sel[0]).toMatch(/\brequired\b/);
            const selected = sel[1].match(/<option value="([^"]*)"[^>]*\bselected\b/);
            expect(selected[1]).toBe('');
        });
        expect(html).toMatch(
            /id="nb-modal-box" role="dialog" aria-modal="true" aria-labelledby="nb-modal-title"/
        );
    });
    test('creating without choosing the axes posts nothing and points at the gap', async () => {
        const { NB, byId, opener, posted, ctx } = boot();
        opener.focus();
        NB.assess('42', 'A. Person');
        byId['nb-perf'].value = '';
        byId['nb-pot'].value = 'high';
        await NB.create();
        expect(posted).toHaveLength(0);
        expect(byId['nb-perf'].getAttribute('aria-invalid')).toBe('true');
        expect(ctx.document.activeElement).toBe(byId['nb-perf']);
        byId['nb-perf'].value = 'low';
        NB.create();
        expect(posted).toHaveLength(1);
        expect(posted[0]).toEqual(
            expect.objectContaining({ performance: 'low', potential: 'high' })
        );
    });
    test('re-opening for another person clears the previous choice', () => {
        const { NB, byId } = boot();
        NB.assess('1', 'A');
        byId['nb-perf'].value = 'high';
        byId['nb-pot'].value = 'high';
        NB.closeModal();
        NB.assess('2', 'B');
        expect(byId['nb-perf'].value).toBe('');
        expect(byId['nb-pot'].value).toBe('');
    });
    test('Escape closes the dialog and focus returns to the opener', () => {
        const { NB, byId, opener, ctx } = boot();
        opener.focus();
        NB.assess('42', 'A');
        expect(byId['nb-modal'].style.display).toBe('flex');
        expect(ctx.document.activeElement).toBe(byId['nb-perf']);
        ctx.document.fire('keydown', { key: 'Escape', preventDefault() {} });
        expect(byId['nb-modal'].style.display).toBe('none');
        expect(ctx.document.activeElement).toBe(opener);
    });
});

describe('UX-14 — printable development plan', () => {
    const locals = {
        session: { sessionAt: '2026-09-01T09:00:00Z', kind: 'mentor', agenda: 'Revue' },
        grow: { goal: 'But G', reality: 'Réalité R', options: 'Options O', wayForward: 'Suite W' },
        objectives: [{ smartText: 'Objectif SMART 1', dueOn: '2026-12-31', state: 'in_progress' }],
        fmtDate: (d) => 'D(' + d + ')',
        fmtDateTime: (d) => 'DT(' + d + ')',
    };
    test('FR: localised headings, labelled enums, camelCased fields printed, sections in order', () => {
        const html = render('views/pages/coaching/print-edp.ejs', locals, 'fr');
        expect(html).not.toMatch(
            /SMART Objectives|Sign-off|HR-BP|Way forward<\/td>|>in_progress<|>mentor</
        );
        expect(html).toContain('Objectifs SMART');
        expect(html).toContain('Mentorat');
        expect(html).toContain('En cours');
        expect(html).toContain('Suite W');
        expect(html).toContain('Objectif SMART 1');
        expect(html).toContain('D(2026-12-31)');
        expect(html).toContain('DT(2026-09-01T09:00:00Z)');
        const nums = [...html.matchAll(/<h2[^>]*>(\d+)\./g)].map((m) => Number(m[1]));
        expect(nums).toEqual([1, 2, 3, 4]);
        expect(html).not.toMatch(/common:|coaching:|idp:/); // no raw key leaked
    });
    test('EN renders its own catalogue', () => {
        const html = render('views/pages/coaching/print-edp.ejs', locals, 'en');
        expect(html).toContain('SMART objectives');
        expect(html).toContain('Mentoring');
        expect(html).not.toMatch(/common:|coaching:|idp:/);
    });
});

describe('UX-06 — form labels are programmatically linked', () => {
    // Every <label> in these views names a control that exists in the same markup.
    const files = [
        'views/pages/pip/index.ejs',
        'views/pages/onboarding/queue.ejs',
        'views/pages/organization/sites.ejs',
        'views/pages/organization/departments.ejs',
        'views/pages/organization/services.ejs',
    ];
    test.each(files)('%s', (rel) => {
        const src = read(rel);
        const labels = [...src.matchAll(/<label\b((?:<%[\s\S]*?%>|[^>])*)>/g)];
        expect(labels.length).toBeGreaterThan(0);
        labels.forEach((m) => {
            const f = (m[1].match(/\bfor="([^"]+)"/) || [])[1];
            expect([rel, m[0], !!f]).toEqual([rel, m[0], true]);
            expect(src.includes('id="' + f + '"')).toBe(true);
        });
    });
});

describe('UX-04 — Talent tab labels come from the session language', () => {
    function bootDash(I18N) {
        const ctx = makeSandbox({});
        ctx.window.__I18N__ = I18N;
        ctx.window.__DASHBOARD__ = {};
        ctx.window.ChartTheme = { tokens: {}, ROLE: {} };
        const pipes = ctx.mk('div', { id: 'talentdev-pipelines' });
        const grid = ctx.mk('div', { id: 'talentdev-ninebox-grid' });
        ctx.body.appendChild(pipes);
        ctx.body.appendChild(grid);
        const src = read('public/js/dashboard.js');
        // Expose the two renderers from the module closure for the test.
        const patched = src
            .replace(
                /function renderTalentPipelines\(d\) \{/,
                'globalThis.__rtp = (d) => renderTalentPipelines(d);\n    function renderTalentPipelines(d) {'
            )
            .replace(
                /function renderNineBoxGrid\(nb\) \{/,
                'globalThis.__rng = (nb) => renderNineBoxGrid(nb);\n    function renderNineBoxGrid(nb) {'
            );
        vm.runInContext(patched, ctx.sandbox, { filename: 'dashboard.js' });
        return { ctx, pipes, grid };
    }
    test('pipeline and 9-box grid print the FR labels and theme tokens, no English', () => {
        const I18N = {
            tdPipeHeadingPip: 'PAP ({0})',
            tdPipeHeadingIdp: 'PDI ({0})',
            tdPipeProposed: 'Proposé',
            tdStActive: 'Actif',
            tdPipeClosedSuccess: 'Clôturé — réussite',
            tdPipeClosedFailure: 'Clôturé — échec',
            tdPipeDraft: 'Brouillon',
            tdStCompleted: 'Terminé',
            nbAxisPot: '↑ Potentiel',
            nbAxisPerf: 'Performance →',
            nbLevels: { low: 'faible', medium: 'moyen', high: 'élevé' },
            tdNbCellTitle: '{0} (performance : {1} / potentiel : {2})',
            nbCells: {
                'high-low': 'Diamant brut',
                'high-medium': 'Étoile montante',
                'high-high': "Étoile d'or",
                'medium-low': 'Dilemme',
                'medium-medium': 'Contributeur clé',
                'medium-high': 'Étoile émergente',
                'low-low': 'Point de vigilance',
                'low-medium': 'Contributeur essentiel',
                'low-high': 'Professionnel de confiance',
            },
        };
        const { ctx, pipes, grid } = bootDash(I18N);
        ctx.sandbox.__rtp({
            pip: { total: 4, proposed: 1, active: 1, closedSuccess: 1, closedFailure: 1 },
            idp: { total: 3, draft: 1, active: 1, completed: 1 },
        });
        ctx.sandbox.__rng({ grid: { 'high-high': 2 } });
        const out = pipes.innerHTML + grid.innerHTML;
        expect(out).toContain('PAP (4)');
        expect(out).toContain('Clôturé — réussite');
        expect(out).toContain('Étoile d&#39;or');
        expect(out).toContain('↑ Potentiel');
        expect(out).toContain('performance : élevé / potentiel : élevé');
        expect(out).not.toMatch(/Proposed|Closed —|Gold Star|Potential ↑|\(perf /);
        expect(out).not.toMatch(/#(FF9800|2E75B6|4CAF50|F44336|9E9E9E|2f80c4|2e9e57|c0392b)/i);
        expect(out).toMatch(/var\(--emerald\)/);
    });
});
