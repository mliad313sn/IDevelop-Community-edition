'use strict';
/**
 * The --viz-* tokens of public/css/viz.css (what the browser reads) and
 * VIZ_FALLBACK of public/js/chart-theme.js (what a page without the stylesheet
 * gets) are the same values, in both modes of the Open Horizon theme, and:
 *   - every mark clears 3:1 and every status / text token 4.5:1 against EVERY
 *     surface of its mode (WCAG 2.2 AA; --viz-grid is a decorative gridline);
 *   - the risk red is not a category colour (red means "At risk" only);
 *   - "Not measured" is a hatch, never a flat colour;
 *   - IDevelop's own design: no gold, no foreign typeface, no colour theme
 *     changes a status;
 *   - the heatmap steps: ink >= 4.5:1 on every step, the step furthest below the
 *     requirement is the most visible on the card, adjacent steps distinct.
 */
const CT = require('../../public/js/chart-theme');
const { read } = require('../helpers/vizRender');

const CSS = read('public/css/viz.css');
const HORIZON = read('public/css/horizon.css');

/** The surfaces of each mode (public/css/horizon.css §1 and §2). */
function surfaces(selector) {
    const i = HORIZON.indexOf(selector);
    const body = HORIZON.slice(i, HORIZON.indexOf('}', i));
    return ['--bg-base', '--bg-panel', '--bg-card', '--bg-elevated'].map((p) => {
        const m = new RegExp(p + ':\\s*(#[0-9a-fA-F]{6})').exec(body);
        return m[1].toUpperCase();
    });
}
const SURFACES = { dark: surfaces(':root {'), light: surfaces(":root[data-theme='light'] {") };

const lum = (hex) => {
    const c = [1, 3, 5]
        .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const worst = (hex, theme) => Math.min(...SURFACES[theme].map((s) => ratio(hex, s)));

/** The --viz-* / --vh-* hex declarations of the n-th block opened by `selector`. */
function block(selector, prefix, nth = 0) {
    let at = -1;
    for (let k = 0; k <= nth; k++) at = CSS.indexOf(selector + ' {', at + 1);
    if (at < 0) throw new Error('block not found: ' + selector);
    const body = CSS.slice(at, CSS.indexOf('}', at));
    const out = {};
    for (const m of body.matchAll(
        new RegExp('(--' + prefix + '-[a-z0-9-]+)\\s*:\\s*(#[0-9A-Fa-f]{6})', 'g')
    ))
        out[m[1]] = m[2].toUpperCase();
    return out;
}
const VIZ = { dark: block(':root', 'viz'), light: block(":root[data-theme='light']", 'viz') };
const VH = { dark: block(':root', 'vh', 1), light: block(":root[data-theme='light']", 'vh', 1) };

const MARKS = ['good', 'warn', 'risk', 'unmeasured', 'neutral', 'focus', 'target'].concat(
    [1, 2, 3, 4, 5, 6].map((i) => 'cat' + i),
    ['measure', 'required']
);
const TEXT = ['good', 'warn', 'risk', 'unmeasured', 'neutral', 'focus', 'target'];

describe('one set of tokens, two modes', () => {
    test('the surfaces are the theme layer’s own', () => {
        expect(SURFACES.dark).toHaveLength(4);
        expect(SURFACES.light[1]).toBe('#FFFFFF');
    });
    test.each(['light', 'dark'])(
        '%s: viz.css declares every token and equals VIZ_FALLBACK',
        (theme) => {
            for (const k of [...MARKS, 'grid']) {
                const prop = CT.VIZ_CSS[k];
                expect([k, VIZ[theme][prop]]).toEqual([k, CT.VIZ_FALLBACK[theme][k].toUpperCase()]);
            }
        }
    );
});

describe('contrast (WCAG 2.2 AA, every surface of the mode)', () => {
    test.each(['light', 'dark'])('%s: every mark >= 3:1', (theme) => {
        for (const k of MARKS)
            expect([k, worst(CT.VIZ_FALLBACK[theme][k], theme) >= 3]).toEqual([k, true]);
    });
    test.each(['light', 'dark'])('%s: status and text tokens >= 4.5:1', (theme) => {
        for (const k of TEXT)
            expect([k, worst(CT.VIZ_FALLBACK[theme][k], theme) >= 4.5]).toEqual([k, true]);
    });
    test('the validator really rejects a weak value', () => {
        expect(worst('#A9A7C4', 'light')).toBeLessThan(3);
    });
    test('red means "At risk" only: no category is the risk colour or a red hue', () => {
        for (const theme of ['light', 'dark']) {
            const cats = [1, 2, 3, 4, 5, 6].map((i) => CT.VIZ_FALLBACK[theme]['cat' + i]);
            expect(cats).not.toContain(CT.VIZ_FALLBACK[theme].risk);
            for (const c of cats) {
                const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.substr(i, 2), 16) / 255);
                const max = Math.max(r, g, b);
                const dd = max - Math.min(r, g, b);
                if (dd < 0.15) continue;
                let hue =
                    max === r
                        ? ((g - b) / dd) % 6
                        : max === g
                          ? (b - r) / dd + 2
                          : (r - g) / dd + 4;
                hue = (hue * 60 + 360) % 360;
                expect([c, hue >= 345 || hue <= 20]).toEqual([c, false]);
            }
        }
    });
});

describe('IDevelop’s own design', () => {
    test('"Not measured" is a 45° hatch on its token, with a class', () => {
        expect(CSS).toMatch(
            /--viz-hatch:\s*repeating-linear-gradient\(45deg,\s*var\(--viz-unmeasured\)/
        );
        expect(CSS).toMatch(/\.viz-hatch \{[^}]*background-image:\s*var\(--viz-hatch\)/);
    });
    test('no gold, no foreign typeface, no @font-face of its own', () => {
        expect(CSS).not.toMatch(/gold|DM Sans|@font-face/i);
        expect(read('public/js/chart-theme.js')).not.toMatch(/DM Sans|--gold\b/);
    });
    test('a colour theme (data-palette) never redefines a viz or heatmap token', () => {
        expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/data-palette/);
        const pal = HORIZON.split(/\n(?=:root\[)/).filter((b) => /data-palette/.test(b));
        for (const b of pal) expect(b).not.toMatch(/--viz-|--vh-/);
    });
});

describe('heatmap steps', () => {
    const STEPS = [
        'below-3',
        'below-2',
        'below-1',
        'at',
        'seq-0',
        'seq-1',
        'seq-2',
        'seq-3',
        'seq-4',
    ];
    const CARD = { dark: SURFACES.dark[2], light: SURFACES.light[2] };
    describe.each(['light', 'dark'])('%s', (theme) => {
        const T = VH[theme];
        test.each(STEPS)('ink on %s >= 4.5:1', (s) => {
            expect(ratio(T['--vh-' + s], T['--vh-ink-' + s])).toBeGreaterThanOrEqual(4.5);
        });
        test('the furthest below is the most visible on the card', () => {
            const v = ['below-3', 'below-2', 'below-1'].map((s) =>
                ratio(T['--vh-' + s], CARD[theme])
            );
            expect(v[0]).toBeGreaterThan(v[1]);
            expect(v[1]).toBeGreaterThan(v[2]);
            expect(v[0]).toBeGreaterThanOrEqual(3);
        });
        test('adjacent steps are distinct (>= 1.1:1)', () => {
            const seq = ['below-3', 'below-2', 'below-1', 'at'];
            for (let i = 1; i < seq.length; i++)
                expect(ratio(T['--vh-' + seq[i - 1]], T['--vh-' + seq[i]])).toBeGreaterThanOrEqual(
                    1.1
                );
        });
    });
    test('the « n » line is never dimmed: it inherits the cell ink', () => {
        const rule = CSS.match(/\.vh-n \{[^}]*\}/)[0];
        expect(rule).not.toMatch(/color\s*:|opacity/);
    });
});
