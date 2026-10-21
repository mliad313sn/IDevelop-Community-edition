'use strict';

/**
 * Branding / white-label helper — lets an organisation re-skin the app to its own
 * graphic charter from App Settings (category "branding", superadmin-managed):
 *
 *   appName          (general)  — product/company name (header, titles, login)
 *   brandTagline     (branding) — login subtitle (falls back to the i18n default)
 *   brandLogo        (branding) — data-URL image (sidebar + login + favicon fallback)
 *   brandFavicon     (branding) — data-URL icon (falls back to brandLogo)
 *   brandAccentColor (branding) — hex; replaces the Iris accent token family
 *   edition          (general)  — key of the chart identity row (default 'community')
 *
 * Stock values come from src/config/product.js — the single place the product
 * identity is declared. getBranding is read per request (micro-cached;
 * AppSettingsModel.getValue is itself TTL-cached) and exposed to every view as
 * `branding`. The accent color is expanded server-side into the FULL token
 * family (hover/pressed/dim/glow/subtle) so one hex restyles every control while
 * all derived states stay consistent.
 */

const PRODUCT = require('../config/product');

const DEFAULTS = Object.freeze({
    appName: PRODUCT.name,
    tagline: null, // null -> views keep the i18n default subtitle
    logo: null, // null -> views keep the built-in logo
    favicon: null,
    accentColor: null, // null -> stock Iris tokens from style.css
    accentCss: '',
    // The line on /about. Lives here, as DATA, so no view branches on it.
    legalNotice: PRODUCT.legalNotice,
    edition: 'community',
});

let _cache = null;
let _cacheAt = 0;

// ---- color math -------------------------------------------------------------

function normalizeHex(v) {
    const s = String(v || '').trim();
    // A colour is at most 7 characters (#rrggbb): anything longer is refused
    // before any pattern runs.
    if (s.length > 7) return null;
    // Accept 3-digit shorthand (#fff) by expanding each nibble, plus full 6-digit.
    const short = /^#?([0-9a-f]{3})$/i.exec(s);
    if (short)
        return (
            '#' +
            short[1]
                .toLowerCase()
                .split('')
                .map((c) => c + c)
                .join('')
        );
    const full = /^#?([0-9a-f]{6})$/i.exec(s);
    return full ? '#' + full[1].toLowerCase() : null;
}

function hexToRgb(hex) {
    const h = normalizeHex(hex);
    if (!h) return null;
    return {
        r: parseInt(h.slice(1, 3), 16),
        g: parseInt(h.slice(3, 5), 16),
        b: parseInt(h.slice(5, 7), 16),
    };
}

function rgba(hex, alpha) {
    const c = hexToRgb(hex);
    return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})` : '';
}

/** Lighten (pct>0) or darken (pct<0) a hex color by blending toward white/black. */
function shade(hex, pct) {
    const c = hexToRgb(hex);
    if (!c) return hex;
    const t = pct > 0 ? 255 : 0;
    const p = Math.abs(pct);
    const f = (v) => Math.round(v + (t - v) * p);
    return '#' + [f(c.r), f(c.g), f(c.b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance + contrast ratio (for accessibility warnings). */
function contrastRatio(hexA, hexB) {
    const lum = (hex) => {
        const c = hexToRgb(hex);
        if (!c) return 0;
        const f = (v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const [a, b] = [lum(hexA), lum(hexB)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---- the brand accent, resolved for contrast per mode -------------------------

/**
 * The surfaces and the button ink of each mode of public/css/horizon.css
 * (Dusk = `:root`, Daylight = `:root[data-theme='light']`): bg-base, bg-panel,
 * bg-card and bg-elevated, then --text-inverse, the ink every filled brand
 * control carries. tests/unit/brandAccentContrast.test.js reads the stylesheet
 * and fails when these drift from it.
 */
const MODES = Object.freeze({
    dark: Object.freeze({
        surfaces: Object.freeze(['#18172c', '#1d1c35', '#23213f', '#2c2a4d']),
        ink: '#18172c',
        card: '#23213f',
        // Dusk raises a colour toward white to gain contrast on its dark surfaces.
        toward: 1,
        hover: 0.1,
        pressed: -0.08,
        dim: 0.16,
        subtle: 0.1,
        glow: 0.35,
    }),
    light: Object.freeze({
        surfaces: Object.freeze(['#f7f6fc', '#ffffff', '#ffffff', '#f1eff9']),
        ink: '#ffffff',
        card: '#ffffff',
        // Daylight lowers a colour toward black.
        toward: -1,
        hover: -0.08,
        pressed: -0.16,
        dim: 0.1,
        subtle: 0.06,
        glow: 0.28,
    }),
});
/** WCAG 2.2 AA: text 4.5:1, a graphical mark or a control boundary 3:1. */
const AA_TEXT = 4.5;
const AA_MARK = 3;

/** `hex` blended at opacity `a` over `under` (what a translucent chip shows). */
function over(hex, under, a) {
    const c = hexToRgb(hex);
    const u = hexToRgb(under);
    const m = (x, y) => Math.round(x * a + y * (1 - a));
    return (
        '#' +
        [m(c.r, u.r), m(c.g, u.g), m(c.b, u.b)].map((v) => v.toString(16).padStart(2, '0')).join('')
    );
}

const lowestOn = (hex, list) => Math.min(...list.map((s) => contrastRatio(hex, s)));

/**
 * The colour closest to `hex`, moving in steps of 2.5 % toward white (dir 1) or
 * black (dir -1), that satisfies `ok`. Pure white and pure black end the walk,
 * and on either one every check of this file holds, so the result never fails.
 */
function nearest(hex, dir, ok) {
    for (let i = 0; i <= 40; i++) {
        const c = i === 0 ? hex : shade(hex, dir * i * 0.025);
        if (ok(c)) return c;
    }
    return dir > 0 ? '#ffffff' : '#000000';
}

/**
 * Every brand token of ONE mode, computed rather than trusted:
 *   - the fill, its hover and pressed states each carry the mode's button ink
 *     at 4.5:1 or more, and the fill stands out 3:1 from every surface;
 *   - --brand-text reads at 4.5:1 on every surface and on its own tinted chip;
 *   - the tints keep the mode's own opacities.
 * A brand that already passes is returned unchanged; one that does not is
 * moved the least it takes, never left failing. `adjusted` says whether the
 * fill moved, so App Settings can say so.
 */
function accentTokens(hex, mode) {
    const h = normalizeHex(hex);
    if (!h) return null;
    const M = MODES[mode === 'dark' ? 'dark' : 'light'];
    const states = (f) => [f, shade(f, M.hover), shade(f, M.pressed)];
    const fillOk = (f) =>
        Math.min(...states(f).map((x) => contrastRatio(x, M.ink))) >= AA_TEXT &&
        lowestOn(f, M.surfaces) >= AA_MARK;
    const fill = nearest(h, M.toward, fillOk);
    const textOk = (t) =>
        lowestOn(t, M.surfaces) >= AA_TEXT && contrastRatio(t, over(t, M.card, M.dim)) >= AA_TEXT;
    const text = nearest(h, M.toward, textOk);
    return {
        adjusted: fill !== h,
        tokens: {
            '--brand': fill,
            '--brand-hover': shade(fill, M.hover),
            '--brand-pressed': shade(fill, M.pressed),
            '--brand-text': text,
            '--brand-dim': rgba(fill, M.dim),
            '--brand-subtle': rgba(fill, M.subtle),
            '--brand-glow': rgba(fill, M.glow),
            '--hz-glow-a': rgba(fill, M.dim),
        },
    };
}

/** Four :root pseudo-classes out-rank the colour themes of horizon.css
 *  (:root[data-theme][data-palette]): an organisation's accent wins over a
 *  person's colour theme, in both modes. */
const OVERRIDE = ':root:root:root:root';

/**
 * The white-label block: one rule per mode, and the Daylight tokens again for
 * paper (print is always light, public/css/print.css). Every view that inlines
 * `branding.accentCss` gets it: the layout, the sign-in pages and the error
 * page (views/partials/brand-accent.ejs).
 */
function buildAccentCss(hex) {
    const h = normalizeHex(hex);
    if (!h) return '';
    const decl = (mode) =>
        Object.entries(accentTokens(h, mode).tokens)
            .map(([k, v]) => `${k}:${v};`)
            .join('');
    return (
        `${OVERRIDE}:not([data-theme='light']){${decl('dark')}}` +
        `${OVERRIDE}[data-theme='light']{${decl('light')}}` +
        `@media print{${OVERRIDE}:root{${decl('light')}}}`
    );
}

/**
 * What App Settings tells the administrator after a save: the ratios actually
 * rendered in each mode, and whether the colour had to move to reach them.
 */
function accentReport(hex) {
    const h = normalizeHex(hex);
    if (!h) return null;
    const out = { adjusted: [] };
    for (const mode of ['light', 'dark']) {
        const r = accentTokens(h, mode);
        const M = MODES[mode];
        const t = r.tokens;
        out[mode] = {
            ink: Math.min(
                ...[t['--brand'], t['--brand-hover'], t['--brand-pressed']].map((x) =>
                    contrastRatio(x, M.ink)
                )
            ),
            text: lowestOn(t['--brand-text'], M.surfaces),
        };
        if (r.adjusted) out.adjusted.push(mode);
    }
    return out;
}

// ---- chart identity ----------------------------------------------------------

/**
 * THE CHART IDENTITY TABLE.
 *
 * Everything the charts draw — colours and geometry — is a VALUE in this table,
 * never a branch at a call site and never a second theme file. `buildChartCss`
 * turns the selected row into `--chart-*` custom properties; public/js/chart-theme.js
 * reads those properties and hands the ~35 chart call sites colours and geometry.
 * No chart, controller or view knows which identity it is rendering.
 *
 * Adding a differentiator = adding a row key here + one `cssVar` read in
 * chart-theme.js. A fork of IDevelop that wants its own chart look adds a row
 * and sets the `edition` app setting to its key — no code elsewhere changes.
 *
 * ── community (IDevelop Community Edition — "Horizon") ─────────────────────
 * Eight categorical hues on a deliberate light/dark sawtooth so series separate
 * by VALUE as well as hue. Every categorical and semantic entry clears 3:1
 * against BOTH the dark (#151931) and the light (#FFFFFF) chart surface
 * (measured; see docs/BRAND.md for the table).
 */
const HORIZON = Object.freeze({
    iris: '#7C6CFF',
    rose: '#CA72A7',
    coral: '#DF5920',
    slate: '#626A84',
    ochre: '#8F8314',
    sky: '#187EAA',
    lime: '#728D35',
    teal: '#17A1A1',
});

/** n-step single-hue ramp, darkening — the shape the report-builder schemes use. */
function ramp(hex, n = 7, step = 0.09) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(shade(hex, -i * step));
    return out;
}

const COMMUNITY = Object.freeze({
    identity: 'community',
    // Order matters: adjacent slots are what a legend compares, and this
    // order keeps every adjacent pair >= 52 CIE76 apart in simulated
    // deuteranopia/protanopia (every pair anywhere >= 13.5).
    categorical: [
        HORIZON.iris,
        HORIZON.rose,
        HORIZON.coral,
        HORIZON.slate,
        HORIZON.ochre,
        HORIZON.sky,
        HORIZON.lime,
        HORIZON.teal,
    ],
    // Status stays status: `low` is red and `good` is green regardless of the
    // brand accent. `mid` sits high in the luminance band and `low` low in it,
    // which is what separates warning from danger for a deuteranope.
    semantic: {
        good: '#1F7A56',
        mid: '#866F13',
        low: '#E02929',
        neutral: '#187EAA',
        accent: 'var(--brand)',
    },
    // Colourblind-aware heat scale (never red-vs-green alone).
    heat: [
        'rgba(224,41,41,.32)',
        'rgba(134,111,19,.30)',
        'rgba(24,126,170,.28)',
        'rgba(31,122,86,.32)',
        'rgba(31,122,86,.55)',
    ],
    roles: {
        measured: HORIZON.iris,
        reference: HORIZON.coral,
        'measured-alt': HORIZON.teal,
        'reference-alt': HORIZON.rose,
        'measured-warm': HORIZON.ochre,
        guide: HORIZON.slate,
        progress: HORIZON.sky,
        'progress-alt': HORIZON.ochre,
        achieved: '#1F7A56',
        'achieved-alt': HORIZON.lime,
        outstanding: HORIZON.coral,
        'ramp-mid': '#4FAF8A',
        'mid-low': '#C9702F',
        nodata: 'rgba(127,134,154,0.35)',
        'neutral-fill': 'rgba(24,126,170,0.20)',
        'neutral-fill-soft': 'rgba(24,126,170,0.14)',
        'low-fill': 'rgba(224,41,41,0.10)',
        'accent-fill': 'rgba(124,108,255,0.12)',
    },
    // A real sequential scale: hue walking red -> orange -> amber -> green,
    // monotonically lightening so it ranks even in greyscale.
    ramp: ['#A8434F', '#C45A2C', '#A7822A', '#4E9A48', '#2FA77A'],
    // Index 1 is the risk series: it stays red, not brand-coloured.
    diag: [HORIZON.sky, '#E02929', HORIZON.iris, HORIZON.slate, HORIZON.teal, HORIZON.ochre],
    schemes: {
        gold: ramp(HORIZON.iris), // key kept for saved report templates: the "brand" ramp
        emerald: ramp(HORIZON.teal),
        multi: [
            HORIZON.iris,
            HORIZON.rose,
            HORIZON.coral,
            HORIZON.slate,
            HORIZON.ochre,
            HORIZON.sky,
            HORIZON.lime,
            HORIZON.teal,
        ],
        heatscale: ['#E02929', HORIZON.ochre, HORIZON.slate, HORIZON.lime, '#1F7A56'],
        cool: ramp(HORIZON.sky),
        mono: ramp(HORIZON.slate),
        sunset: ramp(HORIZON.coral, 7, 0.07),
    },
    // Drawing language: gently curved lines, softly rounded bars, small markers
    // that grow on hover, separated doughnut segments.
    geometry: {
        'line-tension': '0.35',
        'line-width': '2.5',
        'point-radius': '2.6',
        'point-hover-radius': '5',
        'point-border-width': '0',
        'bar-radius': '4',
        'arc-border-width': '0',
        'arc-spacing': '2',
        'legend-box': '9',
        'tooltip-radius': '12',
        'font-weight': '500',
    },
    // A second, non-colour channel for series identity: marker shape carries
    // what hue cannot under dichromacy.
    pointCycle: ['circle', 'rectRot', 'triangle', 'rect', 'rectRounded'],
});

const CHART_IDENTITY = Object.freeze({ community: COMMUNITY });

/** Normalise whatever is in the `edition` setting to a row of the table. */
function editionRow(value) {
    const key = String(value || '')
        .trim()
        .toLowerCase();
    return CHART_IDENTITY[key] || CHART_IDENTITY.community;
}

/** The `--chart-*` custom properties for one edition. */
function buildChartCss(edition) {
    const row = editionRow(edition);
    const d = [`--chart-identity:${row.identity};`];
    row.categorical.forEach((c, i) => d.push(`--chart-cat-${i + 1}:${c};`));
    Object.entries(row.semantic).forEach(([k, v]) => d.push(`--chart-${k}:${v};`));
    row.heat.forEach((c, i) => d.push(`--chart-heat-${i}:${c};`));
    Object.entries(row.roles).forEach(([k, v]) => d.push(`--chart-${k}:${v};`));
    if (row.schemes) {
        Object.entries(row.schemes).forEach(([k, list]) =>
            d.push(`--chart-scheme-${k}:${list.join(',')};`)
        );
    }
    if (row.geometry) {
        Object.entries(row.geometry).forEach(([k, v]) => d.push(`--chart-${k}:${v};`));
    }
    if (row.ramp) d.push(`--chart-ramp:${row.ramp.join(',')};`);
    if (row.diag) d.push(`--chart-diag:${row.diag.join(',')};`);
    if (row.pointCycle) d.push(`--chart-point-cycle:${row.pointCycle.join(',')};`);
    return ':root{' + d.join('') + '}';
}

// ---- accessors ---------------------------------------------------------------

/** Short stable hash of a string — used to version the branding asset URLs so the
 * browser refetches only when the logo/favicon actually changes. */
function shortHash(s) {
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

async function getBranding() {
    const now = Date.now();
    if (_cache && now - _cacheAt < 15_000) return _cache;
    let b = { ...DEFAULTS, logo: null, favicon: null, logoUrl: null, faviconUrl: null };
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        const [appName, tagline, logo, favicon, accent, legalNotice, edition] = await Promise.all([
            AppSettingsModel.getValue('appName', DEFAULTS.appName),
            AppSettingsModel.getValue('brandTagline', ''),
            AppSettingsModel.getValue('brandLogo', ''),
            AppSettingsModel.getValue('brandFavicon', ''),
            AppSettingsModel.getValue('brandAccentColor', ''),
            AppSettingsModel.getValue('legalNotice', DEFAULTS.legalNotice),
            AppSettingsModel.getValue('edition', DEFAULTS.edition),
        ]);
        const accentColor = normalizeHex(accent);
        const logoData = /^data:image\//.test(String(logo || '')) ? logo : null;
        const favData = /^data:image\//.test(String(favicon || '')) ? favicon : null;
        // Serve the images from cached /branding/* routes rather than inlining the
        // base64 (up to ~800 KB) into every page's HTML. The ?v= hash busts the cache
        // when the asset changes; the route sets a long immutable Cache-Control.
        const logoUrl = logoData ? '/branding/logo?v=' + shortHash(logoData) : null;
        const favUrl = favData
            ? '/branding/favicon?v=' + shortHash(favData)
            : logoData
              ? '/branding/logo?v=' + shortHash(logoData)
              : null;
        b = {
            appName: String(appName || DEFAULTS.appName).trim() || DEFAULTS.appName,
            legalNotice: String(legalNotice || DEFAULTS.legalNotice).trim() || DEFAULTS.legalNotice,
            tagline: String(tagline || '').trim() || null,
            logo: logoData, // kept for the Settings panel preview
            favicon: favData,
            logoUrl, // used by every rendered page
            faviconUrl: favUrl,
            accentColor,
            edition: editionRow(edition).identity,
            // One <style> block carries both: the accent token family and the
            // chart identity. Views already inline `accentCss`, so the charts
            // follow the brand through the same channel and no view changes.
            accentCss: (accentColor ? buildAccentCss(accentColor) : '') + buildChartCss(edition),
        };
    } catch (_) {
        /* settings unavailable (boot, tests) → stock branding */
    }
    _cache = b;
    _cacheAt = now;
    return b;
}

/** Raw data-URL for a branding asset ('logo'|'favicon'), or null. Used by the
 * cached image route; favicon falls back to the logo. */
async function getAssetDataUrl(kind) {
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        let v = await AppSettingsModel.getValue(
            kind === 'favicon' ? 'brandFavicon' : 'brandLogo',
            ''
        );
        if (kind === 'favicon' && !/^data:image\//.test(String(v || ''))) {
            v = await AppSettingsModel.getValue('brandLogo', '');
        }
        return /^data:image\//.test(String(v || '')) ? v : null;
    } catch (_) {
        return null;
    }
}

function invalidate() {
    _cache = null;
    _cacheAt = 0;
}

module.exports = {
    getBranding,
    getAssetDataUrl,
    invalidate,
    normalizeHex,
    contrastRatio,
    accentTokens,
    accentReport,
    buildAccentCss,
    MODES,
    buildChartCss,
    editionRow,
    CHART_IDENTITY,
    HORIZON,
    DEFAULTS,
};
