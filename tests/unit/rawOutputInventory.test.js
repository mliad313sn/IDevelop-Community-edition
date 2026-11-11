'use strict';
/**
 * Inventory guard for every place where text reaches a page WITHOUT the
 * template engine's HTML escaping, rebuilt on IDevelop's own views (360°
 * feedback, one-to-one, HRIS, modules, scope editors included):
 *
 *   A. every unescaped EJS output `<%- … %>` in views/, classified:
 *      - safe by construction: an include(), the layout `body`, a
 *        JSON.stringify() of literals only (an i18n key with literal options);
 *      - REVIEWED: every other raw output, pinned per file below after tracing
 *        its source. A NEW raw output anywhere fails this suite until it is
 *        reviewed and its count updated here with the reason;
 *      - a JSON.stringify() of DATA in a view is refused outside the reviewed
 *        list: it leaves « < » alone, so a value carrying « </script> » closes
 *        the inline script. Data goes through views/partials/json-script.ejs.
 *   B. every client-side HTML sink (innerHTML / outerHTML / insertAdjacentHTML
 *      / document.write) in public/js AND in the inline scripts of views/,
 *      pinned per file after review (each concatenation escaped by the file's
 *      own esc helper, or static / numeric / i18n markup).
 *   C. an HTML-escaped output `<%= … %>` inside an inline <script> is limited
 *      to ids and the CSRF token: HTML escaping does not make text safe in a
 *      JavaScript string (a `<` escape in a name is decoded by the
 *      JavaScript parser into a live « < »).
 *   D. rendered proofs: the json-script partial, the login page (white-label
 *      name, tagline, flash and SSO button labels), the access review script
 *      block and the admin scope editors keep a hostile value inert.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function walk(dir, ext, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== 'vendor') walk(p, ext, out);
        } else if (e.name.endsWith(ext) && !e.name.endsWith('.min.js')) out.push(p);
    }
    return out;
}

/** An argument made only of literals: strings, numbers, keys, punctuation and `__`. */
function literalOnly(arg) {
    const stripped = String(arg)
        .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '')
        .replace(/\b\w+\s*:/g, '')
        .replace(/\b__\s*\(/g, '(')
        .replace(/\b\d+(\.\d+)?\b/g, '')
        .replace(/\b(true|false|null)\b/g, '');
    return !/[A-Za-z_$]/.test(stripped);
}

function rawOutputs() {
    const out = [];
    for (const f of walk(path.join(ROOT, 'views'), '.ejs')) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/<%-([\s\S]*?)[-_]?%>/g)) {
            const expr = m[1].trim().replace(/\s+/g, ' ');
            const line = src.slice(0, m.index).split('\n').length;
            let cls;
            if (/^include\s*\(/.test(expr)) cls = 'include';
            else if (expr === 'body') cls = 'layout-body';
            else if (/^JSON\.stringify\(/.test(expr))
                cls = literalOnly(expr.replace(/^JSON\.stringify\(|\)$/g, ''))
                    ? 'json-literal'
                    : 'json-data';
            else cls = 'reviewed';
            out.push({ file: rel(f), line, cls, expr });
        }
    }
    return out;
}

/**
 * Reviewed raw outputs per view. Source of each, in short:
 *  layouts/main, auth/login|sso-choose-account|sso-enrol-code, partials/brand-accent:
 *    branding.accentCss
 *    (a CSS block built from a hex-validated colour, utils/branding);
 *  about, admin/api-keys, admin/sso-migration, admins/create, app-settings/sso,
 *    data-management/sql-console, idp/new, lms, reports/schedules:7: static
 *    HTML catalogue entries (no interpolation);
 *  admins/accounts:34: the catalogue sentence with numbers from settings;
 *  admin/notifications: opt() builds <option> with esc() on value and label;
 *  system-logs/index:43: fld() markup whose values all go through esc()/opt();
 *  admins/accounts, employees/index, framework/library, lifecycle,
 *    maker-checker, notifications, reports/local-content (tabs),
 *    system-logs:125, employee/assessment-status, reports/schedules:155:
 *    constant attribute strings chosen by a condition;
 *  employees/show: the catalogue sentence with _ehAcc()-escaped values, and a
 *    static catalogue entry;
 *  error.ejs: a comment;
 *  guide: the static bilingual guide content (GuideController, no stored data);
 *  reports/local-content natBar(): numbers only;
 *  talent/nine-box-movements dirBadge(): an enum mapped to a class and i18n;
 *  partials/json-script: its own « < »-escaped JSON.
 */
const REVIEWED = {
    'views/layouts/main.ejs': 1,
    'views/pages/about.ejs': 4,
    'views/pages/admin/api-keys.ejs': 4,
    'views/pages/admin/notifications.ejs': 8,
    'views/pages/admin/sso-migration.ejs': 5,
    'views/pages/admins/accounts.ejs': 14,
    'views/pages/admins/create.ejs': 1,
    'views/pages/app-settings/sso.ejs': 2,
    'views/pages/auth/login.ejs': 1,
    'views/pages/auth/sso-choose-account.ejs': 1,
    'views/pages/auth/sso-enrol-code.ejs': 1,
    'views/pages/data-management/sql-console.ejs': 7,
    'views/pages/employee/assessment-status.ejs': 1,
    'views/pages/employees/index.ejs': 1,
    'views/pages/employees/show.ejs': 2,
    'views/pages/error.ejs': 1,
    'views/pages/framework/library.ejs': 2,
    'views/pages/guide.ejs': 43,
    'views/pages/idp/new.ejs': 1,
    'views/pages/lifecycle/index.ejs': 1,
    'views/pages/lms/index.ejs': 1,
    'views/pages/maker-checker/index.ejs': 1,
    'views/pages/notifications/index.ejs': 1,
    'views/pages/reports/local-content.ejs': 7,
    'views/pages/reports/schedules.ejs': 2,
    'views/pages/system-logs/index.ejs': 2,
    'views/pages/talent/nine-box-movements.ejs': 3,
    'views/partials/json-script.ejs': 1,
    // branding.accentCss, the same block as the layout (4.0.0 port, wave 11)
    'views/partials/brand-accent.ejs': 1,
};

/** JSON.stringify of non-literal arguments, reviewed: never stored or typed text. */
const JSON_DATA_REVIEWED = {
    // catalogue strings and the colon typography helper
    'views/pages/admin/maintenance.ejs': 1,
    // a locale code chosen between two literals
    // a role id as a string, or ''
    'views/pages/employee/opportunities.ejs': 1,
    // a cycle id as a string, or null
    'views/pages/employee/self-assessment.ejs': 1,
    // the round id (Number), a mode between two literals, the CSRF token
    'views/pages/feedback360/subject.ejs': 3,
    // a boolean (engagement module on)
    'views/pages/supervisor/self-assessment-review.ejs': 1,
};

/**
 * Client-side HTML sinks per file (review notes). Every concatenated value is
 * escaped by the file's own helper (esc / escapeHtml / capEsc / lmsEsc / esc9 /
 * smEsc / _esc), is a number or an id, or is static / catalogue markup.
 * reauditXssSinks and c317-C-dom-xss run the riskiest ones.
 */
const CLIENT_SINKS = {
    'public/js/help.js': 1, // static help content; titles escaped
    'public/js/main.js': 2, // static icons / spinner
    'public/js/rb-renderers.js': 8, // esc() on every label, header and value
    'public/js/report-builder.js': 24, // _esc(); the SQL preview escaped before highlighting
    'public/js/skill-matrix.js': 6, // smEsc(); levels are integers
    'public/js/status-badge.js': 1, // el(): the markup of html(), every value through esc()
    'public/js/table-search.js': 2, // restores its own button markup / static spinner
    'public/js/ui-feedback.js': 2, // esc() on title and buttons; the message set as text
    'views/pages/admin/modules.ejs': 1, // esc() on module labels
    'views/pages/admin/sso-migration.ejs': 2, // cleared, rows built with DOM
    'views/pages/admins/create.ejs': 2, // static scope skeleton (catalogue JSON); cleared
    'views/pages/admins/show.ejs': 2, // static scope skeleton (catalogue JSON); cleared
    'views/pages/app-settings/index.ejs': 4, // spinner, restore, cleared, catalogue options
    'views/pages/app-settings/sso.ejs': 1, // cleared; content built with DOM text
    'views/pages/capability/index.ejs': 8, // esc() / capEsc() on names, notes, answers
    'views/pages/coaching/plans-console.ejs': 7, // esc() on names, titles, labels
    'views/pages/compliance/index.ejs': 2, // numbers; row errors through escH()
    'views/pages/continuity/index.ejs': 6, // esc() on names (re-audit X3)
    'views/pages/data-management/index.ejs': 2, // catalogue labels and numbers
    'views/pages/data-management/sql-console.ejs': 15, // esc() on every cell, error and label
    'views/pages/employee/assessment-status.ejs': 2, // esc() on skill names and comments
    'views/pages/employee/dashboard.ejs': 4, // esc(safeHref()) / esc() on labels
    'views/pages/employee/my-coaching.ejs': 2, // esc() on titles, objectives, actions
    'views/pages/employee/okr.ejs': 9, // esc() on goal and check-in text
    'views/pages/employee/opportunities.ejs': 3, // static icons
    'views/pages/employee/supervisor-reviews.ejs': 4, // esc() on labels and comments
    'views/pages/employees/create.ejs': 6, // catalogue placeholder options
    'views/pages/employees/edit.ejs': 6, // catalogue placeholder options
    'views/pages/employees/show.ejs': 18, // esc() / esc9() on names, notes, goals, check-ins
    'views/pages/feedback360/subject.ejs': 4, // esc() on names; ids through Number()
    'views/pages/guide.ejs': 2, // copies the static guide's own markup
    'views/pages/lms/index.ejs': 4, // lmsEsc(); SAConsoleNet failure cards
    'views/pages/org-chart/index.ejs': 3, // this.esc() on names and roles
    'views/pages/qualified/index.ejs': 2, // cleared; items built with DOM text
    'views/pages/reports/dept-analytics.ejs': 2, // static skeleton, text set after
    'views/pages/safety-gate/config.ejs': 2, // cleared; items built with DOM text
    'views/pages/supervisor/self-assessment-review.ejs': 16, // escapeHtml() / esc()
    'views/pages/system-logs/index.ejs': 7, // this.esc() on routes, kinds, labels
    'views/pages/talent/career-path.ejs': 1, // esc() on skill and domain names
    'views/pages/talent/nine-box-console.ejs': 8, // esc() on names and labels (re-audit X4)
    'views/partials/command-palette.ejs': 2, // ids and static icons; labels set as text
    // bell: actions list, notes list and their three empty / unavailable states;
    // every value through esc() (5-character escaper), links through safeHref()
    'views/partials/header.ejs': 7,
};

describe('A. unescaped EJS outputs are inventoried and reviewed', () => {
    const all = rawOutputs();

    test('inventory shape: almost all raw outputs are includes and literal i18n JSON', () => {
        const by = {};
        for (const r of all) by[r.cls] = (by[r.cls] || 0) + 1;
        expect(by.include).toBeGreaterThan(150);
        expect(by['json-literal']).toBeGreaterThan(800);
        expect(by['layout-body']).toBe(1);
    });

    test('every other raw output sits in a reviewed file, at the reviewed count', () => {
        const counts = {};
        for (const r of all.filter((x) => x.cls === 'reviewed'))
            counts[r.file] = (counts[r.file] || 0) + 1;
        const drift = [];
        for (const f of new Set([...Object.keys(counts), ...Object.keys(REVIEWED)]))
            if ((counts[f] || 0) !== (REVIEWED[f] || 0))
                drift.push(
                    `${f}: ${counts[f] || 0} raw output(s), reviewed ${REVIEWED[f] || 0} -> ` +
                        all
                            .filter((x) => x.file === f && x.cls === 'reviewed')
                            .map((x) => `:${x.line} ${x.expr.slice(0, 80)}`)
                            .join(' | ')
                );
        expect(drift).toEqual([]);
    });

    test('no JSON.stringify of data in a view outside the reviewed list (data goes through json-script)', () => {
        const counts = {};
        for (const r of all.filter((x) => x.cls === 'json-data'))
            counts[r.file] = (counts[r.file] || 0) + 1;
        expect(counts).toEqual(JSON_DATA_REVIEWED);
    });
});

describe('B. client-side HTML sinks are inventoried', () => {
    test('per-file count (public/js and inline view scripts) matches the reviewed inventory', () => {
        const counts = {};
        const files = [
            ...walk(path.join(ROOT, 'public', 'js'), '.js'),
            ...walk(path.join(ROOT, 'views'), '.ejs'),
        ];
        for (const f of files) {
            const n = (
                fs
                    .readFileSync(f, 'utf8')
                    .match(
                        /\.innerHTML\s*\+?=(?!=)|\.outerHTML\s*=(?!=)|insertAdjacentHTML\s*\(|document\.write\s*\(/g
                    ) || []
            ).length;
            if (n) counts[rel(f)] = n;
        }
        expect(counts).toEqual(CLIENT_SINKS);
    });
});

describe('C. HTML-escaped output inside an inline script is an id or the CSRF token only', () => {
    // An id, `csrfToken`, or the signed-in user's id with a literal fallback.
    const ALLOWED = /^(?:csrfToken|[a-z]\w*\.id|user && user\.id \? user\.id : "0?")$/;

    test('every <%= %> inside an inline <script> body is on the allow-list', () => {
        const bad = [];
        for (const f of walk(path.join(ROOT, 'views'), '.ejs')) {
            const src = fs.readFileSync(f, 'utf8');
            for (const s of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
                if (/\bsrc\s*=/.test(s[1])) continue; // an external script: no inline body
                const body = s[2];
                const base = s.index + s[0].indexOf(body, s[1].length);
                for (const m of body.matchAll(/<%=([\s\S]*?)%>/g)) {
                    const expr = m[1].trim().replace(/\s+/g, ' ');
                    if (!ALLOWED.test(expr)) {
                        const line = src.slice(0, base + m.index).split('\n').length;
                        bad.push(`${rel(f)}:${line} ${expr.slice(0, 100)}`);
                    }
                }
            }
        }
        expect(bad).toEqual([]);
    });
});

// ---------------------------------------------------------------- D: rendered

const NS = {};
const loc = (ns) => {
    if (!NS[ns]) {
        const f = path.join(ROOT, 'locales', 'fr', `${ns}.json`);
        NS[ns] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    }
    return NS[ns];
};
// i18next runs with escapeValue:false: placeholders are substituted RAW, as in production.
const tr = (key, o) => {
    const [ns, k] = String(key).split(':');
    let s = loc(ns)[k];
    if (s === undefined) s = o && o.defaultValue !== undefined ? o.defaultValue : `[${key}]`;
    if (o) for (const [a, b] of Object.entries(o)) s = String(s).split(`{{${a}}}`).join(b);
    return s;
};
const M = (f) => `<i data-probe-${f}>m</i>&"'`;
const RAW = /<i data-probe/;

describe('D. rendered proofs', () => {
    test('the json-script partial escapes « < », U+2028 and U+2029', () => {
        const f = path.join(ROOT, 'views/partials/json-script.ejs');
        const v = 'a</script><i x>' + String.fromCharCode(0x2028, 0x2029);
        const out = ejs.render(fs.readFileSync(f, 'utf8'), { v }, { filename: f });
        expect(out).not.toMatch(/</);
        expect(out).not.toMatch(new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']'));
        expect(JSON.parse(out)).toBe(v);
    });

    describe('login page: white-label text, flash and SSO button labels are text', () => {
        const FILE = path.join(ROOT, 'views/pages/auth/login.ejs');
        const render = (extra) =>
            ejs.renderFile(FILE, {
                __: tr,
                cspNonce: 'n',
                csrfToken: 't',
                assetVersion: '1',
                lang: 'fr',
                brandName: M('brandname'),
                branding: {
                    appName: M('app'),
                    tagline: M('tag'),
                    logoUrl: null,
                    faviconUrl: null,
                    accentCss: '',
                },
                success: [],
                errors: [M('flash')],
                warnings: [],
                ...extra,
            });

        test('SSO only: a custom button label and a provider name (interpolated raw by i18n)', async () => {
            const html = await render({
                ssoEnforced: true,
                ssoProviders: [
                    {
                        key: 'entra',
                        icon: 'fab fa-microsoft',
                        label: M('label'),
                        customLabel: true,
                    },
                    { key: 'okta', icon: 'fas fa-key', name: M('pname') },
                ],
            });
            expect(html).not.toMatch(RAW);
            for (const f of ['app', 'tag', 'flash', 'label', 'pname'])
                expect(html).toContain(`&lt;i data-probe-${f}&gt;`);
        });

        test('password form: the same branding is text', async () => {
            const html = await render({ ssoEnforced: false, ssoProviders: [] });
            expect(html).not.toMatch(RAW);
            expect(html).toContain('&lt;i data-probe-app&gt;');
        });
    });

    test('access review: an admin username cannot close the inline script', () => {
        const file = path.join(ROOT, 'views/pages/admin/access-review.ejs');
        const line = fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .find((l) => /\bby:\s*<%-/.test(l));
        expect(line).toBeTruthy();
        const out = ejs.render(
            line.trim().replace(/,$/, ''),
            { __: tr, user: { username: 'x</script><i data-probe-u>m</i>' } },
            { filename: file }
        );
        expect(out).not.toMatch(/<\/script>/i);
        expect(out).not.toMatch(RAW);
        expect(JSON.parse(out.replace(/^by:\s*/, ''))).toContain('x</script><i data-probe-u>m</i>');
    });

    test.each(['views/pages/admins/show.ejs', 'views/pages/admins/create.ejs'])(
        '%s: scope names reach the script as inert JSON data, set as option text',
        (view) => {
            const file = path.join(ROOT, view);
            const src = fs.readFileSync(file, 'utf8');
            const a = src.indexOf('const SCOPE_OPTIONS =');
            const b = src.indexOf('%>;', a) + 3;
            expect(a).toBeGreaterThan(0);
            // The block runs in the page's scope: `_regions` exists only in show.ejs.
            const tpl =
                (view.endsWith('show.ejs') ? '<% const _regions = regions; %>' : '') +
                src.slice(a, b);
            const hostile = '\\u003cimg src=x onerror=alert(1)\\u003e</script><i data-probe-s>';
            const out = ejs.render(
                tpl,
                {
                    __: tr,
                    regions: [{ id: 1, name: hostile }],
                    countries: [{ id: 2, name: hostile }],
                    sites: [{ id: 3, name: hostile, isActive: false }],
                    departments: [{ id: 4, siteName: hostile, name: hostile }],
                    services: [{ id: 5, siteName: 's', departmentName: 'd', name: hostile }],
                },
                { filename: file }
            );
            expect(out).not.toMatch(/<\/script>/i);
            expect(out).not.toMatch(RAW);
            const json = out.replace(/^const SCOPE_OPTIONS =\s*/, '').replace(/;$/, '');
            // Evaluated as JavaScript, the escape stays a backslash sequence in the data.
            // eslint-disable-next-line no-new-func
            const data = new Function(`return ${json};`)();
            expect(data.site[0].label.startsWith(hostile)).toBe(true);
            expect(data.service[0].label).toBe(`s - d - ${hostile}`);
            // and the page sets it as text: no innerHTML built from these names
            expect(src).toMatch(/new Option\(o\.label, String\(o\.id\)\)/);
            expect(src).not.toMatch(/innerHTML \+= '<option/);
        }
    );
});
