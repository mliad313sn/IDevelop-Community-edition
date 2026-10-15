'use strict';
/**
 * Admin forms that did not work as written, and the page journeys around them.
 *
 *  1. The administrator list nested each row's own forms (unlock, extend,
 *     deactivate, reactivate) inside the bulk form. The HTML parser drops a
 *     <form> opened inside another: the row's closing tag closed the BULK form,
 *     so a row button posted the bulk action, and every checkbox after the
 *     first row with an action left the selection. No view may nest a form.
 *  2. The role page printed its placeholder as text: « <em>No description</em> ».
 *  3. Required labels carried a typed « * » while style.css draws one for every
 *     required control: « Username * * ». One marker, drawn by CSS.
 *  4. Links to pages the reader cannot open: the employee journal's « see the
 *     system log » for an admin without view_system_logs, and the access
 *     review banner (SuperAdmin only) for a local admin.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir, out = []) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (p.endsWith('.ejs')) out.push(p);
    }
    return out;
}

/** <form> depth over the markup, EJS and HTML comments and scripts removed. */
function nestedForms(src) {
    const t = src
        .replace(/<%#[\s\S]*?%>/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
    const hits = [];
    let depth = 0;
    for (const m of t.matchAll(/<(\/?)form\b/gi)) {
        if (m[1]) depth = Math.max(0, depth - 1);
        else {
            if (depth > 0) hits.push(t.slice(0, m.index).split('\n').length);
            depth++;
        }
    }
    return hits;
}

describe('1 — no view nests a <form> inside another', () => {
    test('every view', () => {
        const bad = [];
        for (const f of walk('views')) {
            const lines = nestedForms(read(f));
            if (lines.length) bad.push(`${f}: ${lines.join(', ')}`);
        }
        expect(bad).toEqual([]);
    });
    test('mutation self-check: a nested form is found', () => {
        expect(nestedForms('<form a><div><form b></form></div></form>')).toEqual([1]);
        expect(nestedForms('<form a></form><form b></form>')).toEqual([]);
    });
    test('the administrator list: the bulk form holds its bar, the row checkboxes join it by attribute', () => {
        const src = read('views/pages/admins/index.ejs');
        const open = src.indexOf('<form action="/admin/admin-accounts/bulk"');
        const close = src.indexOf('</form>', open);
        expect(open).toBeGreaterThan(0);
        expect(src.slice(open, close)).toContain('id="tri-bulk-submit"');
        expect(src.slice(open, close)).not.toContain('<table');
        expect(src).toMatch(/class="tri-row-check" form="tri-bulk-form"/);
    });
});

describe('2 — the role page placeholder is markup', () => {
    const src = read('views/pages/roles/show.ejs');
    test('no tag is built inside an escaped output', () => {
        expect(src).not.toMatch(/'<em>'/);
    });
    test('rendered, it is an <em>, never « &lt;em&gt; »', () => {
        const line = src
            .split('\n')
            .find((l) => l.includes('no_description_provided') && l.includes('<% if'));
        const html = ejs.render(line, { __: (k) => k, role: { description: '' } });
        expect(html).toContain('<em>admin:no_description_provided</em>');
        expect(html).not.toContain('&lt;em&gt;');
        expect(ejs.render(line, { __: (k) => k, role: { description: 'a <b>' } })).toContain(
            'a &lt;b&gt;'
        );
    });
});

describe('3 — one required marker, drawn by CSS', () => {
    // The two legacy standalone pages are never served (/domains and /skills
    // redirect to the framework hub); they keep their old markup.
    const LEGACY = ['views/pages/domains/index.ejs', 'views/pages/skills/index.ejs'];
    test('no label ends with a typed « * »', () => {
        const bad = [];
        for (const f of walk('views')) {
            if (LEGACY.includes(f.replace(/\\/g, '/'))) continue;
            const src = read(f);
            for (const m of src.matchAll(/<label\b[^>]*>((?:(?!<\/label>)[\s\S])*?)<\/label>/g))
                if (/\s\*\s*$/.test(m[1].replace(/<[^>]*>/g, '')))
                    bad.push(`${f}: ${m[0].slice(0, 80)}`);
        }
        expect(bad).toEqual([]);
    });
    test('style.css draws the marker for label.required and for a required control', () => {
        const css = read('public/css/style.css');
        expect(css).toMatch(/label\.required::after/);
        expect(css).toMatch(
            /\.form-group:has\(> input:required[^{]*label:not\(\.required\)::after/
        );
    });
    test('the administrator forms mark their required labels by class', () => {
        expect(read('views/pages/admins/create.ejs')).toMatch(
            /<label for="newAdminUsername" class="required">/
        );
        expect(read('views/pages/cycles/form.ejs')).toMatch(
            /<label for="cyc-code" class="required">/
        );
    });
});

describe('4 — a link only to a page the reader may open', () => {
    test('the employee journal links to the system log only with view_system_logs', () => {
        const view = read('views/pages/employees/show.ejs');
        expect(view).toMatch(
            /<% if \(journal\.canOpenLog\) \{ %>\s*<p[^>]*>\s*<a class="btn btn-sm btn-secondary" href="\/system-logs\?employeeId=/
        );
        const ctl = read('src/controllers/EmployeeController.js');
        expect(ctl).toMatch(
            /canOpenLog: RBACService\.hasPermission\(req\.user, 'view_system_logs'\)/
        );
    });
    test('the access-review banner link is for a SuperAdmin only', () => {
        const view = read('views/pages/admins/index.ejs');
        expect(view).toMatch(
            /<% if \(user && user\.role === 'superadmin'\) \{ %><a href="\/admin\/access-review" class="tri-banner-cta">/
        );
    });
});
