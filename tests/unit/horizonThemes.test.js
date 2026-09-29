'use strict';
/**
 * public/css/horizon.css defines two modes (Daylight = light, Dusk = dark) and
 * four colour themes (iris, meadow, sunrise, ocean). Every combination a user
 * can pick must stay readable: brand-as-text ≥ 4.5:1 on cards and raised
 * surfaces, button ink on the brand fill ≥ 4.5:1, body text ≥ 4.5:1.
 * Measured from the stylesheet itself, so an edit that breaks contrast fails here.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const { contrastRatio: cr } = require('../../src/utils/branding');

const CSS = fs
    .readFileSync(path.join(__dirname, '../../public/css/horizon.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** Custom properties declared by the block whose selector is exactly `sel`. */
function block(sel) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('(?:^|\\})\\s*' + esc + '\\s*\\{([^}]*)\\}').exec(CSS);
    if (!m) return {};
    const out = {};
    for (const d of m[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
    return out;
}

const DARK = block(':root');
const LIGHT = { ...DARK, ...block(":root[data-theme='light']") };
const PALETTES = ['iris', 'meadow', 'sunrise', 'ocean'];

function tokens(mode, pal) {
    const base = mode === 'light' ? LIGHT : DARK;
    if (pal === 'iris') return base;
    const over =
        mode === 'light'
            ? {
                  ...block(`:root[data-palette='${pal}']`),
                  ...block(`:root[data-theme='light'][data-palette='${pal}']`),
              }
            : block(`:root[data-palette='${pal}']`);
    return { ...base, ...over };
}

describe('horizon.css parses (guard against a vacuous pass)', () => {
    test('both modes and every palette declare their brand', () => {
        expect(DARK.brand).toMatch(/^#[0-9a-f]{6}$/i);
        expect(LIGHT.brand).toMatch(/^#[0-9a-f]{6}$/i);
        expect(LIGHT.brand).not.toBe(DARK.brand);
        for (const p of PALETTES.slice(1)) {
            expect(block(`:root[data-palette='${p}']`).brand).toMatch(/^#/);
            expect(block(`:root[data-theme='light'][data-palette='${p}']`).brand).toMatch(/^#/);
        }
    });
});

describe.each(['light', 'dark'])('%s mode', (mode) => {
    test.each(PALETTES)('%s: brand text, button ink and body text hold 4.5:1', (pal) => {
        const t = tokens(mode, pal);
        const rows = [
            ['brand-text on card', cr(t['brand-text'], t['bg-card'])],
            ['brand-text on elevated', cr(t['brand-text'], t['bg-elevated'])],
            ['button ink on brand', cr(t['text-inverse'], t.brand)],
            ['primary text on elevated', cr(t['text-primary'], t['bg-elevated'])],
            ['muted text on elevated', cr(t['text-muted'], t['bg-elevated'])],
        ];
        for (const [what, ratio] of rows) expect([what, ratio >= 4.5]).toEqual([what, true]);
    });
});

describe('organisation branding still wins over a colour theme', () => {
    test('the accent override out-ranks :root[data-theme][data-palette]', () => {
        const css = require('../../src/utils/branding').buildAccentCss('#123456');
        expect(css.startsWith(':root:root:root:root{')).toBe(true);
    });
});
