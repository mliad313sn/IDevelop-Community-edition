'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * The visual identity is DATA, not code: app_settings rows (appName,
 * brandAccentColor, brandTagline, brandLogo, edition) and one identity table in
 * src/utils/branding.js. The moment a second theme file or an
 * `if (edition === ...)` appears at a call site, a re-brand (or a fork's own
 * identity) starts drifting from the code it is supposed to restyle.
 *
 * Branching on the identity is legitimate in exactly one layer — where tokens
 * are resolved. Everywhere else it is a fork in progress.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');

// The ONLY files permitted to know which edition is running. `branding.js`
// expands the accent into the token family; `chart-theme.js` reads those tokens
// and hands charts a palette. Both are the indirection layer that exists so the
// ~35 chart call sites never need to know.
const THEME_LAYER = [
    path.join('public', 'js', 'chart-theme.js'),
    path.join('src', 'utils', 'branding.js'),
    path.join('src', 'models', 'AppSettingsModel.js'), // declares the settings
];

const EDITION_MARKERS = [/\bisCommunity\b/, /\bisEnterprise\b/, /edition\s*===/, /edition\s*!==/];

function walk(dir, acc = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (/\.(js|ejs)$/.test(e.name)) acc.push(p);
    }
    return acc;
}

const sourceFiles = [
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'views')),
    ...walk(path.join(ROOT, 'public', 'js')),
];

const rel = (f) => path.relative(ROOT, f);
const isThemeLayer = (f) => THEME_LAYER.some((t) => rel(f) === t);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

describe('one source tree, one theme layer', () => {
    test('no file outside the theme layer branches on which edition is running', () => {
        const offenders = [];
        for (const f of sourceFiles) {
            if (isThemeLayer(f)) continue;
            const code = stripComments(fs.readFileSync(f, 'utf8'));
            for (const re of EDITION_MARKERS) {
                if (re.test(code)) offenders.push(`${rel(f)} :: ${re}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('there is exactly ONE chart theme — no per-edition copy', () => {
        const themes = fs
            .readdirSync(path.join(ROOT, 'public', 'js'))
            .filter((f) => /theme/i.test(f) && f.endsWith('.js'));
        expect(themes).toEqual(['chart-theme.js']);
    });

    test('the categorical palette is defined once, not per edition', () => {
        // A second PALETTE literal anywhere is how a "temporary" fork begins.
        const withPalette = sourceFiles
            .filter((f) => {
                const code = stripComments(fs.readFileSync(f, 'utf8'));
                return /\bPALETTE\s*=\s*\[/.test(code);
            })
            .map(rel);
        expect(withPalette).toEqual([path.join('public', 'js', 'chart-theme.js')]);
    });

    test('charts take their colours from the theme, never from a literal hex', () => {
        // A hard-coded colour in a chart call site cannot follow the accent, so it
        // would render identically in both editions — the visible symptom of a
        // fix that reached only one of them.
        const offenders = [];
        for (const f of sourceFiles) {
            if (isThemeLayer(f)) continue;
            const code = stripComments(fs.readFileSync(f, 'utf8'));
            if (!/new Chart\(|Chart\(/.test(code)) continue;
            for (const m of code.matchAll(
                /(backgroundColor|borderColor)\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/g
            )) {
                offenders.push(`${rel(f)} :: ${m[0]}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('what legitimately differs is data, not code', () => {
    test('edition and branding are declared as App Settings', () => {
        const model = fs.readFileSync(path.join(ROOT, 'src/models/AppSettingsModel.js'), 'utf8');
        for (const key of ['appName', 'brandAccentColor', 'brandTagline']) {
            expect(model).toContain(`key: '${key}'`);
        }
    });

    test('the accent expands into the whole token family, so one value restyles everything', () => {
        const branding = fs.readFileSync(path.join(ROOT, 'src/utils/branding.js'), 'utf8');
        expect(branding).toMatch(/--brand:/);
        expect(branding).toMatch(/accentColor/);
    });

    test('the stock product name comes from src/config/product.js, not from a literal', () => {
        const branding = fs.readFileSync(path.join(ROOT, 'src/utils/branding.js'), 'utf8');
        expect(branding).toMatch(/require\('\.\.\/config\/product'\)/);
        expect(branding).toMatch(/appName: PRODUCT\.name/);
    });
});
