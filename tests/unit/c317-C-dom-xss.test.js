/**
 * Release 3.23.17 — lane C-xss. DOM-XSS findings from the external audit.
 *
 * WHAT WAS BROKEN
 *  1. coaching/plans-console.ejs built  onclick="CP.start(id,'coaching','NAME')"
 *     with esc(name).replace(/'/g,"\\'"). esc() had already turned ' into &#39;,
 *     the HTML parser decodes that back BEFORE the handler is compiled, so the
 *     replace was a no-op: a first name  x');alert(1);//  (SCIM, SSO JIT, import,
 *     self-signup) ran as script for every manager/admin opening /coaching/plans.
 *  2. assessments/show.ejs read domainCell.textContent (DECODED) and wrote it back
 *     through innerHTML: a domain named <img src=x onerror=…> became live markup.
 *  3. lms/index.ejs put skillName into innerHTML unescaped (curation + mappings);
 *     the provider buttons had the same ' breakout as (1).
 *  4. data-management/index.ejs: restoreSnapshot(id,'<%= snapshot.name %>') — (1) again.
 *  5. report-builder.js: RB.removeFilterTag('sites','<_esc(site)>') — (1) again;
 *     the SQL preview highlighted RAW text (section title) into innerHTML;
 *     an imported template's `width` landed unescaped in class="…".
 *  6. employees/edit.ejs + create.ejs: `${dept.name}` / `${service.name}` spliced
 *     into <option> markup via innerHTML.
 *  7. rb-renderers.js: gauge label and table headers unescaped.
 *  8. header.ejs: the textContent→innerHTML escaper does not escape quotes, and it
 *     fed href="…" / class="…" attributes.
 *
 * METHOD — behaviour, not source regexes. jsdom is not a dependency, so each page
 * script runs in a vm sandbox over a small fake DOM. Whatever the script writes into
 * innerHTML is then read the way a BROWSER reads it: a tag/attribute tokenizer
 * decodes character references in attribute values, and an inline on*= handler is
 * compiled from the DECODED value with `this` bound to an element whose dataset
 * comes from its data-* attributes. A payload "works" here exactly when it would
 * work in the browser: `alert` is a spy in the sandbox.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const EVIL_JS = "x');alert(1);//";
const EVIL_HTML = '<img src=x onerror=alert(1)>';
const OBRIEN = "O'Brien";
const MIXED = 'a"b<c>&d';

// ─── A browser-faithful reading of an HTML string ──────────────────────────────
function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
        const k = e.toLowerCase();
        if (k[0] === '#')
            return String.fromCodePoint(
                k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
            );
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
    });
}
/** Start tags with their DECODED attributes, per the HTML tokenizer rules. */
function parseTags(html) {
    const out = [];
    let i = 0;
    html = String(html);
    while ((i = html.indexOf('<', i)) !== -1) {
        const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(i));
        if (!m) {
            i++;
            continue;
        }
        let j = i + m[0].length;
        const attrs = {};
        while (j < html.length) {
            while (/\s/.test(html[j])) j++;
            if (html[j] === '>') {
                j++;
                break;
            }
            if (html[j] === '/') {
                j++;
                continue;
            }
            let name = '';
            while (j < html.length && !/[\s=>/]/.test(html[j])) name += html[j++];
            while (/\s/.test(html[j])) j++;
            let val = '';
            if (html[j] === '=') {
                j++;
                while (/\s/.test(html[j])) j++;
                const q = html[j];
                if (q === '"' || q === "'") {
                    const k = html.indexOf(q, j + 1);
                    val = html.slice(j + 1, k < 0 ? html.length : k);
                    j = k < 0 ? html.length : k + 1;
                } else {
                    while (j < html.length && !/[\s>]/.test(html[j])) val += html[j++];
                }
            }
            name = name.toLowerCase();
            if (name && !(name in attrs)) attrs[name] = decodeEntities(val);
        }
        out.push({ tag: m[1].toLowerCase(), attrs });
        i = j;
    }
    return out;
}
function datasetOf(attrs) {
    const d = {};
    Object.keys(attrs).forEach((k) => {
        if (k.startsWith('data-'))
            d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attrs[k];
    });
    return d;
}
/** The click handler a tag declares: a delegated data-on-click or an inline onclick. */
const clickOf = (tag) => tag.attrs['data-on-click'] || tag.attrs.onclick || '';
/**
 * Click a tag as the browser would.
 *  - data-on-click (CSP, SA-14): dispatched by the REAL public/js/csp-actions.js
 *    loaded into the sandbox — the handler path is resolved on window and the
 *    DECODED data-args JSON becomes the arguments ("$el" = the element). Nothing
 *    in the attribute is ever compiled as code.
 *  - onclick (legacy): compiled from the decoded body with this = element.
 */
function click(ctx, tag) {
    const el = {
        nodeType: 1,
        parentNode: null,
        dataset: datasetOf(tag.attrs),
        getAttribute: (k) => (k in tag.attrs ? tag.attrs[k] : null),
        hasAttribute: (k) => k in tag.attrs,
    };
    ctx.__el = el;
    try {
        if (tag.attrs['data-on-click']) {
            if (!ctx.__cspActions) vm.runInContext(read('public/js/csp-actions.js'), ctx);
            ctx.__cspActions.handle('click', {
                target: el,
                cancelBubble: false,
                preventDefault() {},
                stopPropagation() {},
            });
            return null;
        }
        vm.runInContext('(function(){\n' + tag.attrs.onclick + '\n}).call(__el)', ctx);
        return null;
    } catch (e) {
        return e;
    }
}

// ─── A small fake DOM ─────────────────────────────────────────────────────────
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function makeSandbox(extra) {
    const htmlWrites = [];
    const byId = new Map();
    const qs = {};
    const qsa = {};
    const listeners = {};
    function node(tag) {
        const n = {
            tagName: String(tag || 'div').toUpperCase(),
            nodeType: 1,
            childNodes: [],
            options: [],
            attrs: {},
            style: {},
            dataset: {},
            value: '',
            checked: false,
            hidden: false,
            className: '',
            _html: '',
            _text: '',
            _qs: {},
            _qsa: {},
            get innerHTML() {
                return this._html;
            },
            set innerHTML(v) {
                this._html = String(v);
                this._text = '';
                this.childNodes = [];
                if (this.tagName === 'SELECT') this.options = [];
                htmlWrites.push(this._html);
            },
            // Browser semantics: setting textContent then reading innerHTML yields
            // the text with & < > escaped — and NOTHING else (quotes stay raw).
            get textContent() {
                return this._text + this.childNodes.map((c) => c.textContent).join('');
            },
            set textContent(v) {
                this._text = String(v == null ? '' : v);
                this._html = escText(this._text);
                this.childNodes = [];
            },
            appendChild(c) {
                this.childNodes.push(c);
                return c;
            },
            insertBefore(c) {
                this.childNodes.push(c);
                return c;
            },
            add(opt) {
                this.options.push(opt);
            },
            remove() {},
            focus() {},
            setAttribute(k, v) {
                this.attrs[k] = String(v);
            },
            getAttribute(k) {
                return this.attrs[k];
            },
            addEventListener() {},
            getContext() {
                return {};
            },
            classList: {
                add() {},
                remove() {},
                toggle() {},
                contains() {
                    return false;
                },
            },
            querySelector(sel) {
                return this._qs[sel] || node('div');
            },
            querySelectorAll(sel) {
                return this._qsa[sel] || [];
            },
        };
        return n;
    }
    const document = {
        getElementById(id) {
            if (!byId.has(id)) byId.set(id, node('div'));
            return byId.get(id);
        },
        createElement: (t) => node(t),
        createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
        querySelector: (sel) => qs[sel] || node('div'),
        querySelectorAll: (sel) => qsa[sel] || [],
        addEventListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
        },
    };
    function Option(text, value) {
        this.tagName = 'OPTION';
        this.text = String(text);
        this.value = String(value);
    }
    const alerts = [];
    const sb = Object.assign(
        {
            document,
            Option,
            console,
            Promise,
            JSON,
            setTimeout: (f) => {
                f();
                return 0;
            },
            requestAnimationFrame: () => 0,
            alert: (m) => alerts.push(String(m)),
            localStorage: { getItem: () => null, setItem() {} },
            navigator: { clipboard: { writeText: async () => {} } },
        },
        extra || {}
    );
    sb.window = sb;
    const ctx = vm.createContext(sb);
    return { ctx, document, node, byId, qs, qsa, listeners, alerts, htmlWrites };
}
const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
const L = (k) => k; // i18n stub: the key is the text

/** Inline <script> bodies of a RENDERED page. */
function scriptsOf(html) {
    return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}
/** A source script with its EJS tags neutralised (for partials not worth rendering). */
function stripEjs(src) {
    return src.replace(/<%[-=]([\s\S]*?)%>/g, '"T"').replace(/<%[\s\S]*?%>/g, '');
}

// ═════════════════════════════════════════════════════════════════════════════
describe('1. coaching plans console — an employee name never runs as script', () => {
    async function boot() {
        const file = path.join(ROOT, 'views/pages/coaching/plans-console.ejs');
        const html = ejs.render(
            fs.readFileSync(file, 'utf8'),
            { __: L, assetVersion: '1', cspNonce: 'n' },
            { filename: file }
        );
        const script = scriptsOf(html).find((s) => s.includes('const CP = {'));
        const roster = [
            { employeeId: 5, firstName: EVIL_JS, lastName: 'Z', planCount: 0 },
            { employeeId: 6, firstName: OBRIEN, lastName: 'Y', planCount: 0 },
            { employeeId: 7, firstName: MIXED, lastName: 'W', planCount: 0 },
        ];
        const S = makeSandbox({
            SAConsoleNet: {
                configure() {},
                confirmed: () => true,
                t: (k) => k,
                call: async (p) => (p === '/api/coaching/roster' ? { employees: roster } : {}),
            },
        });
        vm.runInContext(script, S.ctx);
        await flush();
        vm.runInContext(
            'var __calls=[]; CP.start=function(id,kind,name){ __calls.push([id,kind,name]); };',
            S.ctx
        );
        return S;
    }

    test('clicking « Start a plan » passes the exact name and executes nothing', async () => {
        const S = await boot();
        const buttons = parseTags(S.document.getElementById('cp-roster-body').innerHTML).filter(
            (t) => t.tag === 'button' && /CP\.start/.test(clickOf(t))
        );
        expect(buttons).toHaveLength(3);
        // No value is spliced into code: no inline handler at all.
        buttons.forEach((b) => expect(b.attrs.onclick).toBeUndefined());
        buttons.forEach((b) => expect(click(S.ctx, b)).toBeNull()); // O'Brien used to throw a SyntaxError
        expect(S.alerts).toEqual([]);
        expect(vm.runInContext('__calls', S.ctx)).toEqual([
            [5, 'coaching', EVIL_JS + ' Z'],
            [6, 'coaching', OBRIEN + ' Y'],
            [7, 'coaching', MIXED + ' W'],
        ]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('2. assessment page — the decoded domain name is never re-parsed as HTML', () => {
    test('a domain named <img onerror> becomes a text node, never markup', () => {
        const src = read('views/pages/assessments/show.ejs');
        const iife = /\(function addDomainHeaders\(\) \{[\s\S]*?\n\s*\}\)\(\);/.exec(src)[0];
        const S = makeSandbox();
        const tbody = S.node('tbody');
        const rows = [EVIL_HTML, EVIL_HTML, 'Safety'].map((dn) => {
            const row = S.node('tr');
            const cell = S.node('td');
            cell.textContent = dn; // what textContent returns: the DECODED name
            row._qs['td:first-child'] = cell;
            return row;
        });
        tbody._qsa['tr[data-skill-row]'] = rows;
        S.qs['.assessments-section tbody'] = tbody;
        S.htmlWrites.length = 0;
        vm.runInContext(iife, S.ctx);
        // No innerHTML write carries the payload as markup…
        S.htmlWrites.forEach((h) => expect(parseTags(h).map((t) => t.tag)).not.toContain('img'));
        // …and the name is still shown, as text, in the header rows.
        const headers = tbody.childNodes;
        expect(headers).toHaveLength(2);
        expect(headers[0].textContent).toContain(EVIL_HTML);
        expect(headers[1].textContent).toContain('Safety');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('3. LMS hub — skill names and provider names stay inert', () => {
    function render() {
        const file = path.join(ROOT, 'views/pages/lms/index.ejs');
        return ejs.render(
            fs.readFileSync(file, 'utf8'),
            {
                __: L,
                assetVersion: '1',
                cspNonce: 'n',
                user: { role: 'admin' },
                providers: ['moodle'],
                courses: [],
                skills: [],
                integrations: [
                    {
                        provider: EVIL_JS,
                        name: 'n',
                        baseUrl: '',
                        enabled: true,
                        hasWebhookSecret: false,
                    },
                ],
            },
            { filename: file }
        );
    }
    async function boot() {
        const html = render();
        const script = scriptsOf(html).find((s) => s.includes('const LMS = {'));
        const S = makeSandbox({
            SAConsoleNet: {
                configure() {},
                call: async (p) => {
                    if (p === '/v2/lms/curation')
                        return { list: [{ skillName: EVIL_HTML, demand: '<b>3</b>' }] };
                    if (p === '/v2/lms/course/3/mappings')
                        return { list: [{ skillName: EVIL_HTML, levelDelta: 1 }] };
                    return { result: {}, upserted: 0 };
                },
            },
            location: { reload() {} },
        });
        vm.runInContext(script, S.ctx);
        return { S, html };
    }

    test('curation queue and course mappings render skill names as text', async () => {
        const { S } = await boot();
        const tb = S.node('tbody');
        S.qs['#cur-table tbody'] = tb;
        await vm.runInContext('LMS.loadCuration()', S.ctx);
        await vm.runInContext('LMS.loadMaps(3)', S.ctx);
        const cur = parseTags(tb.innerHTML).map((t) => t.tag);
        expect(cur).not.toContain('img');
        expect(cur).not.toContain('b');
        expect(tb.innerHTML).toContain('&lt;img');
        const maps = S.document.getElementById('maps-3').innerHTML;
        expect(parseTags(maps).map((t) => t.tag)).not.toContain('img');
        expect(maps).toContain('&lt;img');
    });

    test('the Test / Sync buttons hand the provider over intact and run nothing', async () => {
        const { S, html } = await boot();
        vm.runInContext(
            'var __got=[]; LMS.test=function(p){__got.push(["test",p]);}; LMS.sync=function(p){__got.push(["sync",p]);};',
            S.ctx
        );
        const btns = parseTags(html).filter(
            (t) => t.tag === 'button' && /LMS\.(test|sync)/.test(clickOf(t))
        );
        expect(btns).toHaveLength(2);
        btns.forEach((b) => expect(click(S.ctx, b)).toBeNull());
        expect(S.alerts).toEqual([]);
        expect(vm.runInContext('__got', S.ctx)).toEqual([
            ['test', EVIL_JS],
            ['sync', EVIL_JS],
        ]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('4. data management — a snapshot name never runs as script', () => {
    test.each([EVIL_JS, OBRIEN, MIXED])('Restore passes %p intact and executes nothing', (name) => {
        const file = path.join(ROOT, 'views/pages/data-management/index.ejs');
        const html = ejs.render(
            fs.readFileSync(file, 'utf8'),
            {
                __: L,
                csrfToken: 't',
                cspNonce: 'n',
                fmtDateTime: String,
                user: { role: 'superadmin' },
                stats: {},
                snapshots: [
                    { id: 7, name, createdAt: new Date(0), sizeBytes: 1024, entityCounts: {} },
                ],
            },
            { filename: file }
        );
        const btn = parseTags(html).find(
            (t) => t.tag === 'button' && /restoreSnapshot/.test(clickOf(t))
        );
        expect(btn).toBeDefined();
        const S = makeSandbox();
        const helper = /function restoreSnapshotBtn\(btn\) \{[\s\S]*?\n {4}\}/.exec(html);
        if (helper) vm.runInContext(helper[0], S.ctx);
        vm.runInContext(
            'var __got=[]; function restoreSnapshot(id,n){ __got.push([id,n]); }',
            S.ctx
        );
        expect(click(S.ctx, btn)).toBeNull();
        expect(S.alerts).toEqual([]);
        expect(vm.runInContext('__got', S.ctx)).toEqual([[7, name]]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('5. report builder — filter tags, SQL preview, section width', () => {
    async function boot() {
        const S = makeSandbox({
            fetch: async (url) => ({
                ok: true,
                json: async () =>
                    String(url).startsWith('/reports/reference/sites')
                        ? { data: [{ name: EVIL_JS }, { name: 'Other' }] }
                        : { data: [] },
            }),
        });
        vm.runInContext(read('public/js/report-builder.js'), S.ctx);
        (S.listeners.DOMContentLoaded || []).forEach((f) => f());
        await flush();
        return S;
    }

    test('removing a site filter tag unticks that site and runs nothing', async () => {
        const S = await boot();
        const evil = { value: EVIL_JS, checked: true };
        const other = { value: 'Other', checked: false };
        S.qsa['#filterSites input:checked'] = [evil];
        S.qsa['#filterSites input'] = [evil, other];
        vm.runInContext('RB.applyFilters()', S.ctx);
        const tag = parseTags(S.document.getElementById('rbFilterTags').innerHTML).find((t) =>
            clickOf(t)
        );
        expect(tag).toBeDefined();
        S.qsa['#filterSites input:checked'] = [];
        expect(click(S.ctx, tag)).toBeNull();
        expect(S.alerts).toEqual([]);
        expect(evil.checked).toBe(false);
    });

    test('a section title is shown in the SQL preview as text, not markup', async () => {
        const S = await boot();
        vm.runInContext(
            'RB.addSection({source:"v_employee_readiness",dimension:"site",metric:"readinessPct"}, ' +
                JSON.stringify(EVIL_HTML) +
                ')',
            S.ctx
        );
        const sql = S.document.getElementById('rbSQLContent').innerHTML;
        expect(parseTags(sql).map((t) => t.tag)).not.toContain('img');
        expect(sql).toContain('&lt;img');
        expect(sql).toContain('<span class="kw">SELECT</span>'); // still highlighted
    });

    test('an imported section width cannot add attributes to the section', async () => {
        const S = await boot();
        vm.runInContext(
            'RB.addSection({}, "t", ' + JSON.stringify('x" onmouseover="alert(1)') + ')',
            S.ctx
        );
        const sec = parseTags(S.document.getElementById('rbSections').innerHTML).find((t) =>
            /rb-section\b/.test(t.attrs.class || '')
        );
        expect(sec).toBeDefined();
        expect(sec.attrs.onmouseover).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6. employee create/edit — org names fill the selects as text', () => {
    test.each(['views/pages/employees/edit.ejs', 'views/pages/employees/create.ejs'])(
        '%s',
        async (rel) => {
            const src = read(rel);
            const fns = ['loadDepartments', 'loadServices']
                .map((n) => new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}\\n').exec(src)[0])
                .join('\n');
            const S = makeSandbox({
                EMP_T: { selectDept: '-', selectService: '-' },
                SELECT_DEPT: '-',
                SELECT_SVC: '-',
                fetch: async () => ({ json: async () => [{ id: 1, name: EVIL_HTML }] }),
            });
            vm.runInContext(fns, S.ctx);
            await vm.runInContext('loadDepartments(3)', S.ctx);
            await vm.runInContext('loadServices(4)', S.ctx);
            for (const id of ['departmentId', 'serviceId']) {
                const sel = S.document.getElementById(id);
                expect(parseTags(sel.innerHTML).map((t) => t.tag)).not.toContain('img');
                expect(sel.options.map((o) => o.text)).toContain(EVIL_HTML);
            }
        }
    );
});

// ═════════════════════════════════════════════════════════════════════════════
describe('7. report renderers — gauge label and table headers are escaped', () => {
    function load() {
        const S = makeSandbox({ Chart: function Chart() {} });
        vm.runInContext(read('public/js/rb-renderers.js'), S.ctx);
        return S;
    }
    test('gauge label', () => {
        const S = load();
        const c = S.node('div');
        vm.runInContext('RBRenderers', S.ctx).render_gauge(
            c,
            { data: [50], labels: [EVIL_HTML] },
            {}
        );
        expect(parseTags(c.innerHTML).map((t) => t.tag)).not.toContain('img');
        expect(c.innerHTML).toContain('&lt;img');
    });
    test('table headers', () => {
        const S = load();
        const c = S.node('div');
        vm.runInContext('RBRenderers', S.ctx).render_table(
            c,
            { columns: [EVIL_HTML], rows: [{ [EVIL_HTML]: 1 }] },
            {}
        );
        expect(parseTags(c.innerHTML).map((t) => t.tag)).not.toContain('img');
        expect(c.innerHTML).toContain('<th>&lt;img');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('8. header action centre — attribute values cannot break out', () => {
    test('a quote in icon/href stays inside its attribute; only app paths are links', async () => {
        const src = read('views/partials/header.ejs');
        const script = scriptsOf(stripEjs(src)).find((s) => s.includes('/api/my-actions'));
        const S = makeSandbox({
            fetch: async (url) => ({
                ok: true,
                json: async () =>
                    url === '/api/my-actions'
                        ? {
                              total: 3,
                              items: [
                                  {
                                      href: '/x" onmouseover="alert(1)',
                                      icon: 'fa-a" onmouseover="alert(2)',
                                      label: 'A',
                                      count: 1,
                                  },
                                  {
                                      href: 'javascript:alert(3)',
                                      icon: 'fa-b',
                                      label: 'B',
                                      count: 1,
                                  },
                                  { href: '/v2/idp', icon: 'fa-c', label: 'C', count: 1 },
                              ],
                          }
                        : { unread: 0, items: [] },
            }),
        });
        vm.runInContext(script, S.ctx);
        await flush();
        const tags = parseTags(S.document.getElementById('acBody').innerHTML);
        tags.forEach((t) =>
            expect(Object.keys(t.attrs).filter((k) => k.startsWith('on'))).toEqual([])
        );
        const links = tags.filter((t) => t.tag === 'a').map((t) => t.attrs.href);
        expect(links[0]).toBe('/x" onmouseover="alert(1)'); // intact, inside the attribute
        expect(links[1]).toBe('#'); // javascript: refused
        expect(links[2]).toBe('/v2/idp');
        expect(tags.filter((t) => t.tag === 'i')[0].attrs.class).toBe(
            'fas fa-a" onmouseover="alert(2)'
        );
    });
});
