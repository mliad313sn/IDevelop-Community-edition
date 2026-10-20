'use strict';
/* eslint-disable no-console */
/**
 * Writes THIRD-PARTY-NOTICES.txt: the licence of every third-party component
 * the installed application ships, for /about/third-party-notices.
 *
 *   - every PRODUCTION package of package-lock.json (dev-only packages are not
 *     shipped, so they are left out), with its version, its declared licence
 *     and the licence / notice files found in its node_modules folder;
 *   - the browser assets vendored under public/vendor that carry their own
 *     licence file (the icon font, the typeface).
 *
 * Run at package time, after `npm ci --omit=dev` (the Dockerfile, the Windows
 * package build). The output holds no date and is sorted, so two builds of the
 * same lockfile give the same file. A package folder that is absent (an
 * optional dependency for another platform) is listed without its text.
 *
 * Usage: node scripts/build-third-party-notices.js [--root <app dir>] [--out <file>]
 */
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = path.resolve(arg('--root', path.join(__dirname, '..')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'THIRD-PARTY-NOTICES.txt')));

/** Licence-bearing file names, compared on a lower-cased prefix (no pattern). */
const PREFIXES = ['license', 'licence', 'copying', 'notice'];
const isLicenceFile = (name) => {
    const n = name.toLowerCase();
    return PREFIXES.some((p) => n.startsWith(p));
};
const RULE = '-'.repeat(78);

function licenceTexts(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch (_) {
        return null; // not installed here
    }
    return names
        .filter(isLicenceFile)
        .sort()
        .map((n) => {
            try {
                const full = path.join(dir, n);
                if (!fs.statSync(full).isFile()) return null;
                return {
                    file: n,
                    text: fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim(),
                };
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean);
}

function npmPackages(root) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const out = [];
    for (const [key, meta] of Object.entries(lock.packages || {})) {
        if (!key || meta.dev || meta.devOptional || meta.link) continue;
        const at = key.lastIndexOf('node_modules/');
        if (at < 0) continue;
        out.push({
            name: key.slice(at + 'node_modules/'.length),
            version: meta.version || '',
            license: meta.license || 'see the package',
            dir: path.join(root, key),
        });
    }
    // The same name and version can sit at several depths: list it once.
    const seen = new Set();
    return out
        .sort((a, b) => (a.name + '@' + a.version).localeCompare(b.name + '@' + b.version))
        .filter((p) => {
            const k = p.name + '@' + p.version;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
}

const VENDORED = [
    { name: 'Font Awesome Free (icons)', dir: 'public/vendor/fontawesome' },
    { name: 'Plus Jakarta Sans (typeface)', dir: 'public/vendor/fonts/plus-jakarta-sans' },
];

function build(root) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    let product = 'IDevelop';
    try {
        product = require(path.join(root, 'src/config/product.js')).name || product;
    } catch (_) {
        /* the name stays the default */
    }
    const lines = [
        `Third-party software notices — ${product} ${pkg.version || ''}`.trim(),
        '',
        `${product} is distributed under ${pkg.license || 'its own licence'}. It includes the`,
        'third-party components below, each under its own licence. This file is',
        'generated from package-lock.json at package time (scripts/build-third-party-notices.js).',
        '',
    ];
    const pkgs = npmPackages(root);
    lines.push(`Node.js packages shipped with the application: ${pkgs.length}`, '');
    for (const p of pkgs) {
        lines.push(RULE, `${p.name} ${p.version} — ${p.license}`, RULE);
        const texts = licenceTexts(p.dir);
        if (texts === null) lines.push('(not installed on this build: an optional dependency)');
        else if (!texts.length)
            lines.push(`(no licence file in the package; declared: ${p.license})`);
        for (const t of texts || []) lines.push(`[${t.file}]`, t.text, '');
        lines.push('');
    }
    lines.push(RULE, 'Browser assets bundled under public/vendor', RULE, '');
    for (const v of VENDORED) {
        lines.push(RULE, v.name, RULE);
        const texts = licenceTexts(path.join(root, v.dir)) || [];
        for (const t of texts) lines.push(`[${t.file}]`, t.text, '');
        lines.push('');
    }
    return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', count: pkgs.length };
}

if (require.main === module) {
    const { text, count } = build(ROOT);
    fs.writeFileSync(OUT, text, 'utf8');
    console.log(
        `THIRD-PARTY-NOTICES: ${count} packages → ${path.relative(process.cwd(), OUT) || OUT}`
    );
}

module.exports = { build, npmPackages, isLicenceFile };
