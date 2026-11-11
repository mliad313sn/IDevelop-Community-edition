'use strict';
/**
 * SA-14 — the Content-Security-Policy refuses every inline event handler
 * (`script-src-attr 'none'`). One `onclick=` left anywhere is a button that
 * silently does nothing in the browser, so this guard fails on:
 *
 *   1. an inline handler attribute (`on<event>=`) in markup: EJS views, static
 *      HTML pages, and HTML built as strings in browser scripts or in server code
 *      that sends HTML;
 *   2. a `javascript:` URL in an href/src/action/formaction attribute;
 *   3. a CSP whose script-src-attr is anything but 'none';
 *   4. a data-on-<event> handler whose name cannot be reached on window
 *      (a top-level `const X` is not a window property).
 *
 * Controls are declared as data-on-<event>="fn" + JSON data-args and dispatched
 * by the delegated listeners in public/js/csp-actions.js.
 *
 * E-mail HTML is exempt: a mail client never applies the page CSP. Comments are
 * stripped before matching.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git']);
// E-mail bodies are not subject to the page CSP.
const EXEMPT = new Set([path.join('src', 'utils', 'emailTemplate.js')]);

function walk(dir, exts, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), exts, out);
        } else if (exts.includes(path.extname(e.name).toLowerCase())) {
            out.push(path.join(dir, e.name));
        }
    }
    return out;
}

// `<tag … onclick="…"` / `onchange='…'` / on…=`…` / on…=unquoted-handler(… inside a tag.
const HANDLER = /<[a-z][^<>]*?\son[a-z]+\s*=\s*(?:["'`]|\\["']|[A-Za-z_$][\w$.]*\s*\()/i;
// In markup files an attribute may sit on its own line of a multi-line tag
// (`<button\n   onclick="…"`): there, any whitespace-led `on<event>=` counts.
const ATTR_LINE = /(^|\s)on[a-z]{3,}\s*=\s*\\?["'`]/i;
// A javascript: URL in a URL-bearing attribute (quoted, escaped-quoted or bare).
const JS_URL = /\b(?:href|src|action|formaction|xlink:href)\s*=\s*\\?["'`]?\s*javascript:/i;

function stripComments(src, kind) {
    let s = src;
    if (kind === 'ejs') s = s.replace(/<%#[\s\S]*?%>/g, (m) => m.replace(/[^\n]/g, ''));
    s = s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
    if (kind === 'js' || kind === 'ejs') {
        s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
        s = s.replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
    }
    return s;
}

function offenders(files, kind) {
    const hits = [];
    for (const f of files) {
        const rel = path.relative(ROOT, f);
        if (EXEMPT.has(rel)) continue;
        const lines = stripComments(fs.readFileSync(f, 'utf8'), kind).split('\n');
        lines.forEach((line, i) => {
            const bad =
                HANDLER.test(line) || JS_URL.test(line) || (kind !== 'js' && ATTR_LINE.test(line));
            if (bad) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
        });
    }
    return hits;
}

const VIEWS = walk(path.join(ROOT, 'views'), ['.ejs']);
const PUBLIC_JS = walk(path.join(ROOT, 'public', 'js'), ['.js']);

describe('SA-14: no inline event handler survives (script-src-attr none)', () => {
    test('the matcher catches the forms it must catch, and only those', () => {
        expect(HANDLER.test('<button onclick="go()">')).toBe(true);
        expect(HANDLER.test("<select class=x onchange='this.form.submit()'>")).toBe(true);
        expect(HANDLER.test('html += `<a href="#" onClick=`')).toBe(true);
        expect(HANDLER.test('<img src=x onerror=alert(1)>')).toBe(true);
        expect(HANDLER.test('h += "<a onclick=\\"go()\\">"')).toBe(true);
        expect(HANDLER.test('<button data-on-click="go">')).toBe(false);
        expect(HANDLER.test('el.onclick = handler;')).toBe(false);
        expect(HANDLER.test('<div class="money-on">')).toBe(false);
        expect(ATTR_LINE.test('        onclick="save()"')).toBe(true);
        expect(ATTR_LINE.test('  button.onclick = "x";')).toBe(false);
        expect(JS_URL.test('<a href="javascript:void(0)">')).toBe(true);
        expect(JS_URL.test("'<a href=\\'javascript:go()\\'>'")).toBe(true);
        expect(JS_URL.test('<a href=javascript:go()>')).toBe(true);
        expect(JS_URL.test('// refuse javascript: and data: URLs')).toBe(false);
        expect(JS_URL.test('<a href="/help#javascript">')).toBe(false);
    });

    test('a planted handler is reported (mutation check of the scanner)', () => {
        const tmp = path.join(require('os').tmpdir(), `sa14-inline-${process.pid}.ejs`);
        fs.writeFileSync(
            tmp,
            '<%# onclick="ignored()" %>\n<button\n   class="b"\n   onclick="go()">x</button>\n<a href="javascript:x()">y</a>\n'
        );
        try {
            const hits = offenders([tmp], 'ejs');
            expect(hits).toHaveLength(2);
            expect(hits[0]).toMatch(/:4: onclick="go\(\)"/);
            expect(hits[1]).toMatch(/:5: <a href="javascript:/);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    test('EJS views (every page and partial, including the theme and module pages)', () => {
        expect(VIEWS.length).toBeGreaterThan(100);
        expect(offenders(VIEWS, 'ejs')).toEqual([]);
    });

    test('static HTML pages', () => {
        expect(offenders(walk(path.join(ROOT, 'public'), ['.html']), 'html')).toEqual([]);
    });

    test('HTML built as strings in browser scripts', () => {
        expect(offenders(PUBLIC_JS, 'js')).toEqual([]);
    });

    test('HTML built as strings in server code', () => {
        expect(offenders(walk(path.join(ROOT, 'src'), ['.js']), 'js')).toEqual([]);
        expect(offenders([path.join(ROOT, 'server.js')], 'js')).toEqual([]);
    });
});

describe('SA-14: the policy itself', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    test("helmet is configured with script-src-attr 'none'", () => {
        const m = /scriptSrcAttr\s*:\s*\[([^\]]*)\]/.exec(src);
        expect(m).not.toBeNull();
        expect(m[1].replace(/\s/g, '')).toBe(`"'none'"`);
        expect(src).not.toMatch(/scriptSrcAttr\s*:\s*\[[^\]]*unsafe-inline/);
    });
    test('script-src stays nonce-only', () => {
        const m = /scriptSrc\s*:\s*\[([^\]]*)\]/.exec(src);
        expect(m[1]).not.toMatch(/unsafe-inline|unsafe-eval/);
    });
    test('every layout and standalone page that wires data-on-* loads csp-actions.js', () => {
        const missing = VIEWS.filter((f) => {
            const s = fs.readFileSync(f, 'utf8');
            const standalone = /<html[\s>]/i.test(s);
            const wires =
                /data-on-[a-z]+=|data-async-css|data-submit-on-change|data-remove-parent/.test(s);
            return standalone && wires && !/\/js\/csp-actions\.js/.test(s);
        }).map((f) => path.relative(ROOT, f));
        expect(missing).toEqual([]);
    });
});

// ─── every data-on-* name must be reachable on window ──────────────────────────
function handlerNames(src) {
    const names = new Set();
    // Markup and JS-built markup: data-on-click="NS.fn" (possibly \"-escaped).
    for (const m of src.matchAll(/data-on-[a-z]+=\\?["']([A-Za-z_$][\w$.]*)\\?["']/g))
        names.add(m[1]);
    // Page helpers that build the attribute: xxOn('click', 'NS.fn', [...]).
    for (const m of src.matchAll(/\b[a-zA-Z]+On\(\s*'[a-z]+'\s*,\s*'([A-Za-z_$][\w$.]*)'/g))
        names.add(m[1]);
    return names;
}
function globalsOf(src) {
    const g = new Set();
    for (const m of src.matchAll(/(?:^|[\s;])function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) g.add(m[1]);
    for (const m of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) g.add(m[1]);
    for (const m of src.matchAll(/^(?:\s{0,4})var\s+([A-Za-z_$][\w$]*)\s*=/gm)) g.add(m[1]);
    return g;
}

describe('SA-14: data-on-* handlers resolve', () => {
    const GLOBALS = new Set();
    [...PUBLIC_JS, ...VIEWS].forEach((f) =>
        globalsOf(fs.readFileSync(f, 'utf8')).forEach((n) => GLOBALS.add(n))
    );

    test('each handler root is a window global (function, var or window.X =)', () => {
        const bad = [];
        let total = 0;
        for (const f of [...VIEWS, ...PUBLIC_JS]) {
            const src = fs.readFileSync(f, 'utf8');
            for (const name of handlerNames(src)) {
                total++;
                const root = name.split('.')[0];
                if (!GLOBALS.has(root)) bad.push(`${path.relative(ROOT, f)}: ${name}`);
            }
        }
        expect(total).toBeGreaterThan(100);
        expect(bad).toEqual([]);
    });

    test('a namespace declared as a top-level const is published on window', () => {
        const bad = [];
        for (const f of [...VIEWS, ...PUBLIC_JS]) {
            const src = fs.readFileSync(f, 'utf8');
            const roots = new Set(
                [...handlerNames(src)].filter((n) => n.includes('.')).map((n) => n.split('.')[0])
            );
            for (const r of roots) {
                const declared = new RegExp(`^(?:const|let)\\s+${r}\\s*=`, 'm').test(src);
                if (declared && !new RegExp(`window\\.${r}\\s*=`).test(src)) {
                    bad.push(`${path.relative(ROOT, f)}: ${r}`);
                }
            }
        }
        expect(bad).toEqual([]);
    });
});

// ─── csp-actions.js itself ──────────────────────────────────────────────────────
describe('csp-actions.js dispatch', () => {
    function load() {
        const listeners = {};
        const window = {
            console: { warn: jest.fn() },
        };
        window.window = window;
        window.document = {
            readyState: 'complete',
            addEventListener: (t, fn) => (listeners[t] = listeners[t] || []).push(fn),
            querySelectorAll: () => [],
        };
        const ctx = vm.createContext(window);
        vm.runInContext(
            fs.readFileSync(path.join(ROOT, 'public', 'js', 'csp-actions.js'), 'utf8'),
            ctx
        );
        const fire = (type, target, extra) => {
            const ev = Object.assign(
                {
                    type,
                    target,
                    cancelBubble: false,
                    defaultPrevented: false,
                    preventDefault() {
                        this.defaultPrevented = true;
                    },
                    stopPropagation() {
                        this.cancelBubble = true;
                    },
                },
                extra
            );
            (listeners[type] || []).forEach((fn) => fn(ev));
            return ev;
        };
        return { ctx, fire };
    }
    function node(attrs, extra) {
        return Object.assign(
            {
                nodeType: 1,
                attrs,
                value: 'v1',
                checked: true,
                getAttribute(k) {
                    return k in this.attrs ? this.attrs[k] : null;
                },
                hasAttribute(k) {
                    return k in this.attrs;
                },
            },
            extra
        );
    }

    test('resolves globals and namespace members, refuses prototype walks', () => {
        const { ctx } = load();
        ctx.go = function () {};
        ctx.NS = { fn() {} };
        expect(ctx.__cspActions.resolve('go')).not.toBeNull();
        expect(ctx.__cspActions.resolve('NS.fn')).not.toBeNull();
        expect(ctx.__cspActions.resolve('NS.toString')).toBeNull();
        expect(ctx.__cspActions.resolve('NS.__proto__')).toBeNull();
        expect(ctx.__cspActions.resolve('missing')).toBeNull();
        expect(ctx.__cspActions.resolve('a b')).toBeNull();
    });

    test('data-args tokens, `this` for a namespace, return false prevents default', () => {
        const { ctx, fire } = load();
        const seen = [];
        ctx.NS = {
            tag: 'ns',
            fn(a, b, c, d) {
                seen.push([this.tag, a, b, c && c.type, d]);
                return false;
            },
        };
        const el = node({
            'data-on-change': 'NS.fn',
            'data-args': '["x", "$value", "$event", "$checked"]',
        });
        const ev = fire('change', el);
        expect(seen).toEqual([['ns', 'x', 'v1', 'change', true]]);
        expect(ev.defaultPrevented).toBe(true);
    });

    test('a click bubbles to the ancestor carrying data-on-click; $el is that ancestor', () => {
        const { ctx, fire } = load();
        const got = [];
        ctx.hideModal = function (id, el) {
            got.push([id, el && el.attrs.id]);
        };
        const btn = node({ id: 'b', 'data-on-click': 'hideModal', 'data-args': '["m1", "$el"]' });
        const icon = node({}, { parentNode: btn });
        btn.parentNode = null;
        fire('click', icon);
        expect(got).toEqual([['m1', 'b']]);
    });
});
