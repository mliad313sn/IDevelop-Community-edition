'use strict';
/**
 * The organisation's accent (App Settings › Branding) is computed for contrast
 * per mode of the Open Horizon theme (src/utils/branding.js accentTokens), not
 * trusted as typed:
 *   - in each mode (Daylight, Dusk) the button ink holds 4.5:1 on the fill, its
 *     hover and its pressed state, and the fill stands out 3:1 from every surface;
 *   - the accent text holds 4.5:1 on every surface and on its own tinted chip;
 *   - a brand that already passes is left as it is; one that does not is moved
 *     toward compliance, never left failing;
 *   - the block reaches the pages that do not use the main layout (sign-in
 *     steps, onboarding, the error page) and still out-ranks a colour theme.
 * The surfaces and inks are read from public/css/horizon.css itself, so the two
 * cannot drift apart. These are IDevelop's own tokens (no other palette).
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const B = require('../../src/utils/branding');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/horizon.css').replace(/\/\*[\s\S]*?\*\//g, '');

function block(sel) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const out = {};
    for (const m of CSS.matchAll(new RegExp('(?:^|\\})\\s*' + esc + '\\s*\\{([^}]*)\\}', 'g'))) {
        for (const d of m[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
    }
    return out;
}
const DUSK = block(':root');
const DAYLIGHT = { ...DUSK, ...block(":root[data-theme='light']") };
const cr = B.contrastRatio;
function blend(hex, under, a) {
    const n = (h, i) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
    return (
        '#' +
        [0, 1, 2]
            .map((i) => Math.round(n(hex, i) * a + n(under, i) * (1 - a)))
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('')
    );
}

/** A fixed spread of colours, light and dark, saturated and grey, plus a
 *  deterministic pseudo-random sample (no Math.random: reproducible). */
const FIXED = [
    '#ffffff',
    '#000000',
    '#808080',
    '#ffe066', // a pale yellow: fails as a fill under white ink
    '#a3e635', // a lime
    '#ff0000',
    '#0b1f4d', // a navy: fails as text in Dusk
    '#1d6ac9',
    '#5b4be0',
    '#8b7dff',
    '#7c6cff',
    '#00ffff',
    '#3c3c3c',
];
function sample(n) {
    const out = [];
    let x = 20261020;
    for (let i = 0; i < n; i++) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        out.push('#' + (x & 0xffffff).toString(16).padStart(6, '0'));
    }
    return out;
}
const COLOURS = FIXED.concat(sample(300));

describe('the mode table is horizon.css', () => {
    test.each([
        ['dark', DUSK],
        ['light', DAYLIGHT],
    ])('%s: surfaces and button ink match the stylesheet', (mode, t) => {
        const M = B.MODES[mode];
        expect(M.surfaces).toEqual(
            ['bg-base', 'bg-panel', 'bg-card', 'bg-elevated'].map((k) => t[k].toLowerCase())
        );
        expect(M.ink).toBe(t['text-inverse'].toLowerCase());
        expect(M.card).toBe(t['bg-card'].toLowerCase());
        // the tints keep the stylesheet's own opacities
        expect(t['brand-dim']).toMatch(new RegExp(`, ${M.dim}\\)$`));
        expect(t['brand-subtle']).toMatch(new RegExp(`, ${M.subtle}\\)$`));
        expect(t['brand-glow']).toMatch(new RegExp(`, ${M.glow}\\)$`));
    });
});

describe.each(['light', 'dark'])('%s mode: every colour comes out AA', (mode) => {
    const M = B.MODES[mode];
    test.each(COLOURS)('%s', (hex) => {
        const { tokens: t } = B.accentTokens(hex, mode);
        for (const s of [t['--brand'], t['--brand-hover'], t['--brand-pressed']])
            expect(cr(s, M.ink)).toBeGreaterThanOrEqual(4.5);
        for (const s of M.surfaces) {
            expect(cr(t['--brand'], s)).toBeGreaterThanOrEqual(3);
            expect(cr(t['--brand-text'], s)).toBeGreaterThanOrEqual(4.5);
        }
        // the accent text on its own chip (its tint over a card)
        const chip = blend(t['--brand-text'], M.card, M.dim);
        expect(cr(t['--brand-text'], chip)).toBeGreaterThanOrEqual(4.5);
    });
});

describe('a brand is moved only as far as it must', () => {
    test('a colour that already passes is kept exactly', () => {
        // the stock Daylight and Dusk brands pass in their own mode
        expect(B.accentTokens(DAYLIGHT.brand, 'light').tokens['--brand']).toBe(
            DAYLIGHT.brand.toLowerCase()
        );
        expect(B.accentTokens(DAYLIGHT.brand, 'light').adjusted).toBe(false);
        expect(B.accentTokens(DUSK.brand, 'dark').tokens['--brand']).toBe(DUSK.brand.toLowerCase());
    });

    test('a pale brand is darkened in Daylight and kept in Dusk', () => {
        const day = B.accentTokens('#ffe066', 'light');
        const dusk = B.accentTokens('#ffe066', 'dark');
        expect(day.adjusted).toBe(true);
        expect(cr(day.tokens['--brand'], '#000000')).toBeLessThan(cr('#ffe066', '#000000'));
        expect(dusk.adjusted).toBe(false);
        expect(dusk.tokens['--brand']).toBe('#ffe066');
    });

    test('a dark brand is lightened in Dusk and kept in Daylight', () => {
        expect(B.accentTokens('#0b1f4d', 'light').adjusted).toBe(false);
        const dusk = B.accentTokens('#0b1f4d', 'dark');
        expect(dusk.adjusted).toBe(true);
        expect(cr(dusk.tokens['--brand'], '#ffffff')).toBeLessThan(cr('#0b1f4d', '#ffffff'));
    });

    test('the report names the modes that moved and the ratios rendered', () => {
        const r = B.accentReport('#ffe066');
        expect(r.adjusted).toEqual(['light']);
        expect(r.light.ink).toBeGreaterThanOrEqual(4.5);
        expect(r.dark.text).toBeGreaterThanOrEqual(4.5);
        expect(B.accentReport('not a colour')).toBeNull();
    });
});

describe('the CSS block', () => {
    const css = B.buildAccentCss('#ffe066');

    test('one rule per mode, the light tokens again for paper', () => {
        expect(css).toMatch(
            /^:root:root:root:root:not\(\[data-theme='light'\]\)\{--brand:#ffe066;/
        );
        expect(css).toContain(":root:root:root:root[data-theme='light']{--brand:#");
        expect(css).toMatch(/@media print\{:root:root:root:root:root\{--brand:#/);
        const light = css.match(/\[data-theme='light'\]\{([^}]*)\}/)[1];
        const paper = css.match(/@media print\{[^{]*\{([^}]*)\}/)[1];
        expect(paper).toBe(light);
    });

    test('it out-ranks every colour-theme selector of horizon.css', () => {
        // :root ×4 + one attribute/negation = (0,5,0) against (0,3,0) for
        // :root[data-theme][data-palette]
        const spec = (sel) =>
            (sel.match(/:root/g) || []).length + (sel.match(/\[[^\]]+\]/g) || []).length;
        const themeSel = ":root[data-theme='light'][data-palette='ocean']";
        for (const sel of css.match(/:root(?::root|\[[^\]]+\]|:not\(\[[^\]]+\]\))*/g))
            expect(spec(sel)).toBeGreaterThan(spec(themeSel));
    });

    test('only colour values, nothing typed by the administrator', () => {
        const values = [...css.matchAll(/--[a-z-]+:([^;]+);/g)].map((m) => m[1]);
        expect(values.length).toBeGreaterThan(20);
        for (const v of values)
            expect(v).toMatch(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [0-9.]+\))$/);
    });

    test('a non-colour is refused before any pattern runs', () => {
        expect(B.buildAccentCss('red')).toBe('');
        expect(B.buildAccentCss('#12345678')).toBe('');
        expect(B.normalizeHex('#' + 'a'.repeat(5000))).toBeNull();
        expect(B.normalizeHex(' #ABC ')).toBe('#aabbcc');
    });
});

describe('the accent reaches the pages outside the main layout', () => {
    const PAGES = [
        'views/pages/auth/login-mfa.ejs',
        'views/pages/auth/forgot-password.ejs',
        'views/pages/auth/reset-password.ejs',
        'views/pages/onboarding/signup.ejs',
        'views/pages/onboarding/pending.ejs',
        'views/pages/error.ejs',
    ];
    test.each(PAGES)('%s inlines the brand block after horizon.css', (f) => {
        const src = read(f);
        const h = src.indexOf('/css/horizon.css');
        const a = src.search(/include\('(\.\.\/)+partials\/brand-accent'\)/);
        expect(h).toBeGreaterThan(0);
        expect(a).toBeGreaterThan(h);
    });

    test('the partial is nonced and renders nothing without a brand', () => {
        const ejs = require('ejs');
        const file = path.join(ROOT, 'views/partials/brand-accent.ejs');
        const tpl = fs.readFileSync(file, 'utf8');
        expect(ejs.render(tpl, { cspNonce: 'n1' }, { filename: file }).trim()).toBe('');
        const html = ejs.render(
            tpl,
            { cspNonce: 'n1', branding: { accentCss: B.buildAccentCss('#1d6ac9') } },
            { filename: file }
        );
        expect(html).toMatch(/<style nonce="n1">:root:root:root:root/);
    });

    test('the layout and the sign-in pages that inlined it already keep doing so', () => {
        for (const f of [
            'views/layouts/main.ejs',
            'views/pages/auth/login.ejs',
            'views/pages/auth/sso-choose-account.ejs',
            'views/pages/auth/sso-enrol-code.ejs',
        ])
            expect(read(f)).toMatch(/_brand\.accentCss/);
    });
});

describe('App Settings says what it rendered', () => {
    const src = read('src/controllers/AppSettingsController.js');
    test('the save reports the computed ratios and any adjustment', () => {
        expect(src).toMatch(/branding\.accentReport\(hex\)/);
        expect(src).toContain("'flash:brand_contrast_report'");
        expect(src).toContain("'flash:brand_adjusted_both'");
        expect(src).not.toMatch(/brand_low_contrast/);
    });
    test('the messages exist in both languages', () => {
        for (const lang of ['en', 'fr']) {
            const f = JSON.parse(read(`locales/${lang}/flash.json`));
            for (const k of [
                'brand_contrast_report',
                'brand_adjusted_light',
                'brand_adjusted_dark',
                'brand_adjusted_both',
            ])
                expect(f[k]).toBeTruthy();
            expect(f.brand_contrast_report).toContain('{{inkLight}}');
            expect(JSON.parse(read(`locales/${lang}/admin.json`)).brand_accent_hint).toBeTruthy();
        }
    });
});
