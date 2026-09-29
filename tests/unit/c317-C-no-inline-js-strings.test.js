/**
 * Release 3.23.17 — lane C-xss. Source guard (the one permitted scan).
 *
 * THE BUG CLASS: a value spliced into a JS string literal inside an inline
 * on*="…" handler.  Escaping does not help there — esc() turns ' into &#39;, and
 * the HTML parser decodes &#39; back to ' BEFORE the handler is compiled, so a name
 * such as  x');alert(1);//  closes the string and runs. Found live four times in
 * one audit (coaching plans, snapshots, report-builder filter tags, LMS providers).
 *
 * THE RULE: pass values through data-* attributes and read them back with
 * this.dataset (or a delegated listener). This test fails on any handler attribute
 * that opens a quoted JS string right next to a splice point:
 *     onclick="f(\'' + x + '\')"      (JS-built markup)
 *     onclick="f('<%= x %>')"          (EJS)
 *     onclick="f('${x}')"              (template literal)
 * No allow-list: a constant argument is written literally, a variable one goes
 * through data-*.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ROOTS = ['views', 'public/js'];

const PATTERNS = [
    /\bon[a-z]+=\\?"[^"\n]*?\\'['"`]?\s*\+/, //   \'' + x
    /\bon[a-z]+=\\?"[^"\n]*?\+\s*['"`]?\\'/, //   x + '\'
    /\bon[a-z]+="[^"\n]*?'\s*<%[=-]/, //          '<%= x
    /\bon[a-z]+="[^"\n]*?'\$\{/, //                '${x}
    /\bon[a-z]+=\\?"[^"\n]*?&(#39|quot);\s*['"`]?\s*\+/, // &#39;' + x
];

function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p, out);
        } else if (/\.(ejs|js|html)$/.test(e.name)) out.push(p);
    }
    return out;
}

function offenders(text) {
    const hits = [];
    text.split('\n').forEach((line, i) => {
        if (PATTERNS.some((re) => re.test(line))) hits.push(i + 1);
    });
    return hits;
}

describe('no value is spliced into a JS string inside an inline on*= handler', () => {
    test('the detector catches every shape it claims to (self-check)', () => {
        const bad = [
            `'<button onclick="CP.start('+id+',\\'coaching\\',\\''+esc(name)+'\\')">'`,
            `<button onclick="restoreSnapshot(<%= s.id %>, '<%= s.name %>')">`,
            '`<b onclick="go(\'${x}\')">`',
            `'<span onclick="RB.removeFilterTag(\\'sites\\',\\'' + _esc(s) + '\\')">'`,
        ];
        bad.forEach((l) => expect(offenders(l)).toEqual([1]));
        const good = [
            `'<button data-name="'+esc(name)+'" onclick="CP.startBtn(this)">'`,
            `<button data-provider="<%= p %>" onclick="LMS.sync(this.dataset.provider)">`,
            `'<button onclick="CP.act('+id+',\\'session\\')">'`,
            `<button onclick="LMS.loadMaps(<%= c.id %>)">`,
        ];
        good.forEach((l) => expect(offenders(l)).toEqual([]));
    });

    test('views/ and public/js/ contain none', () => {
        const files = ROOTS.flatMap((r) => walk(path.join(ROOT, r), []));
        expect(files.length).toBeGreaterThan(50);
        const found = [];
        files.forEach((f) => {
            offenders(fs.readFileSync(f, 'utf8')).forEach((n) =>
                found.push(path.relative(ROOT, f).replace(/\\/g, '/') + ':' + n)
            );
        });
        expect(found).toEqual([]);
    });
});
