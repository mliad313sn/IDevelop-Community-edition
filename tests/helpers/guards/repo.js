'use strict';
/**
 * Guard tests — shared, read-only helpers for the c334-GUARD-* suites:
 * repository walks (src/, views/, public/js), the SQL-looking literals of a
 * source file and the flattened locale catalogues. Paths are repo-relative.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const SKIP = /node_modules|[\\/]\.git[\\/]|[\\/]migrations[\\/]|coverage|[\\/]dist[\\/]/;

function walk(dir, exts, acc = []) {
    if (!fs.existsSync(dir)) return acc;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (SKIP.test(p)) continue;
        if (e.isDirectory()) walk(p, exts, acc);
        else if (exts.includes(path.extname(e.name))) acc.push(p);
    }
    return acc;
}
const srcFiles = () => walk(path.join(REPO, 'src'), ['.js']).concat([path.join(REPO, 'server.js')]);
const viewFiles = () => walk(path.join(REPO, 'views'), ['.ejs']);
const pubFiles = () => walk(path.join(REPO, 'public', 'js'), ['.js']);
const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/');
const read = (p) => fs.readFileSync(p, 'utf8');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const snakeToCamel = (s) => s.replace(/(?<!^)_([a-z0-9])/g, (_, c) => c.toUpperCase());
const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/** String / template literals of a JS source that look like SQL. */
function sqlLiterals(text) {
    const out = [];
    const re = /`((?:\\.|[^`\\])*)`|'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"/g;
    let m;
    while ((m = re.exec(text))) {
        const s = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
        if (s.length < 12) continue;
        if (!/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\b/i.test(s)) continue;
        out.push({ sql: s, idx: m.index, line: lineOf(text, m.index) });
    }
    return out;
}

/** Locale namespaces of one language flattened to "ns:a.b.c" → value. */
function locales(lang) {
    const dir = path.join(REPO, 'locales', lang);
    const keys = new Map();
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const ns = f.replace(/\.json$/, '');
        const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        (function flat(o, pre) {
            for (const [k, v] of Object.entries(o)) {
                const kk = pre ? pre + '.' + k : k;
                if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, kk);
                else keys.set(ns + ':' + kk, v);
            }
        })(obj, '');
    }
    return keys;
}
/** i18next plural / context forms: K resolves to K, K_one, K_other, K_zero … */
const PLURAL = ['', '_one', '_other', '_zero', '_two', '_few', '_many'];
const hasKey = (map, k) => PLURAL.some((s) => map.has(k + s));

module.exports = {
    REPO,
    walk,
    srcFiles,
    viewFiles,
    pubFiles,
    rel,
    read,
    lineOf,
    snakeToCamel,
    camelToSnake,
    sqlLiterals,
    locales,
    hasKey,
};
