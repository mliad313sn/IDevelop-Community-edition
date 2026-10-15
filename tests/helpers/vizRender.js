'use strict';
/**
 * Test helpers of the data-visualisation layer: render a viz partial with the
 * real locale files (an i18next-like `__`: nested keys, _one / _other plurals,
 * {{var}}), the real number formatter, no database.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const kpiFormat = require('../../src/utils/kpiFormat');

const ROOT = path.join(__dirname, '..', '..');
const cache = new Map();

function ns(lang, name) {
    const k = lang + ':' + name;
    if (!cache.has(k))
        cache.set(
            k,
            JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lang, name + '.json'), 'utf8'))
        );
    return cache.get(k);
}

/** `__` for one language, as i18next resolves it (French: 0 and 1 are singular). */
function tr(lang) {
    return (key, vars) => {
        const [n, ...rest] = String(key).split(':');
        const k = rest.join(':');
        const d = ns(lang, n);
        const get = (p) =>
            p.split('.').reduce((o, x) => (o && typeof o === 'object' ? o[x] : undefined), d);
        let v;
        if (vars && vars.count !== undefined) {
            const c = Number(vars.count);
            const one = lang === 'fr' ? c < 2 : c === 1;
            v = get(k + (one ? '_one' : '_other'));
        }
        if (typeof v !== 'string') v = get(k);
        if (typeof v !== 'string') v = k;
        return v.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, x) =>
            vars && vars[x] !== null && vars[x] !== undefined ? vars[x] : ''
        );
    };
}

/** Render a view file (relative to the repository) with the locals of a page. */
function render(rel, locals = {}, lang = 'fr') {
    const file = path.join(ROOT, rel);
    return ejs.render(
        fs.readFileSync(file, 'utf8'),
        {
            __: tr(lang),
            lang,
            numFmt: kpiFormat.forLang(lang),
            fmtDate: (d) => String(d),
            cspNonce: 'n',
            assetVersion: '1',
            ...locals,
        },
        { filename: file }
    );
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

module.exports = { ROOT, ns, tr, render, read };
