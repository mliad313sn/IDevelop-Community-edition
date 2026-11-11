/* eslint-env browser */
/**
 * chart-theme.js — one Chart.js theme for the whole app.
 *
 * Loaded BEFORE any file that instantiates charts (dashboard.js, rb-renderers.js,
 * viz.js and the inline chart scripts of a few views). It sets the global
 * Chart.defaults so EVERY chart inherits the app font, a themed tooltip, quiet
 * gridlines, the page's number locale, reduced-motion support and colours read
 * from the design tokens (`--brand`, `--emerald`, `--chart-*`, `--viz-*`) —
 * never a literal colour at a call site.
 *
 * Exposes `window.ChartTheme`. The historical members (tokens, PALETTE,
 * SEMANTIC, ROLE, HEAT, SCHEMES, DIAG, RAMP, axis, emptyState, alpha, color,
 * pointStyle, pctTick) keep their shape. The data-visualisation layer adds:
 *
 *   ChartTheme.viz                 the --viz-* tokens of the ACTIVE theme
 *                                  {good, warn, risk, unmeasured, neutral, focus,
 *                                   target, grid, cat1..cat6, text, textDim,
 *                                   surface, measure, measureHi, required…}
 *   ChartTheme.VIZ_FALLBACK        {light:{…}, dark:{…}}: the values of
 *                                  public/css/viz.css (a test compares them)
 *   ChartTheme.colorFor(key[, theme])     the colour of a CATEGORY key, never of
 *                                  an array position; status and role keys are
 *                                  fixed, any other key hashes to a stable slot
 *   ChartTheme.colorsFor(keys[, theme])   {key: colour} for one chart, collision-
 *                                  free and independent of the order of `keys`;
 *                                  a 7th free category is neutral ("Others")
 *   ChartTheme.registerCategories({key: slot 1-6})  pin a key to a slot
 *   ChartTheme.STATUS_ORDER        ready · partial · not_ready · unassessed
 *   ChartTheme.normalizeStatus / statusMeta / statusColor / sortByStatus
 *   ChartTheme.bandStatus(v, bands) 'good' | 'warn' | 'risk' | 'unmeasured'
 *   ChartTheme.deltaTone / deltaColor  a change is coloured by the indicator's
 *                                  polarity (worse = amber, never the risk red)
 *   ChartTheme.hatch([colour])     the 45° pattern of "Not measured"
 *   ChartTheme.register(chart, retheme?)  a chart to re-render on theme change
 *   ChartTheme.refresh()           re-read every token, re-render every chart
 *   ChartTheme.motion() / locale() / theme() / all()
 *
 * THEME SWITCH: ONE MutationObserver on <html data-theme | data-palette | lang>
 * re-reads every token and re-renders every live chart. A chart registered with
 * a `retheme` callback rebuilds its colours; any other chart has each colour
 * that came from an old token value swapped for the same token's new value
 * (alpha kept).
 *
 * ── IDENTITY ────────────────────────────────────────────────────────────────
 * This file does NOT know which chart identity is running and MUST NOT learn:
 * it reads the `--chart-*` custom properties that src/utils/branding.js emits
 * from its identity table, and falls back, property by property, to neutral
 * defaults. Adding a chart colour = a ROLE below + a value in that table; never
 * a literal colour at the call site, which could not follow a re-brand.
 *
 * Also require()-able from node: only the pure helpers run there (tests).
 */
(function (global, factory) {
    'use strict';
    var api = factory(global);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (global && api) global.ChartTheme = api;
})(typeof window !== 'undefined' ? window : null, function (global) {
    'use strict';
    // Included twice (a page and a partial)? Keep the first instance — charts
    // already hold its live objects — and let it pick up Chart.js if it has
    // arrived since.
    if (global && global.ChartTheme && global.ChartTheme.__viz) {
        global.ChartTheme.attachChart();
        return global.ChartTheme;
    }
    var hasDom = !!(global && global.document && global.document.documentElement);
    var Chart = global ? global.Chart || null : null;

    // ---- --viz-* tokens: KEEP IN SYNC with public/css/viz.css (tested) ----------
    // Dusk (dark) is the default theme of the stylesheet (:root), Daylight is
    // [data-theme="light"]. Measured against every surface of the theme: marks
    // >= 3:1, status and text tokens >= 4.5:1 (tests/unit/vizTokens.test.js).
    var VIZ_FALLBACK = {
        light: {
            good: '#1F7A56',
            warn: '#A3490B',
            risk: '#C62828',
            unmeasured: '#63617D',
            neutral: '#514F6B',
            focus: '#5B4BE0',
            target: '#1F1D3A',
            grid: '#E4E2F0',
            cat1: '#187EAA',
            cat2: '#12807F',
            cat3: '#A8457F',
            cat4: '#7A6A10',
            cat5: '#557024',
            cat6: '#5A6280',
            text: '#1F1D3A',
            textDim: '#514F6B',
            surface: '#FFFFFF',
            measure: '#5B4BE0',
            measureHi: '#7C6CFF',
            measureFillA: 'rgba(91,75,224,0.20)',
            measureFillB: 'rgba(91,75,224,0.02)',
            required: '#1F1D3A',
        },
        dark: {
            good: '#4CC38A',
            warn: '#F2A65A',
            risk: '#FF8A80',
            unmeasured: '#A9A7C4',
            neutral: '#B9B7D2',
            focus: '#A99FFF',
            target: '#F2F1FA',
            grid: '#3A3860',
            cat1: '#5FB4E8',
            cat2: '#3CC4B4',
            cat3: '#E08CC0',
            cat4: '#D4B23C',
            cat5: '#9CC75A',
            cat6: '#A3ABC6',
            text: '#F2F1FA',
            textDim: '#C4C2DA',
            surface: '#23213F',
            measure: '#A99FFF',
            measureHi: '#C9C3FF',
            measureFillA: 'rgba(169,159,255,0.30)',
            measureFillB: 'rgba(169,159,255,0.04)',
            required: '#F2F1FA',
        },
    };
    var VIZ_CSS = {
        good: '--viz-good',
        warn: '--viz-warn',
        risk: '--viz-risk',
        unmeasured: '--viz-unmeasured',
        neutral: '--viz-neutral',
        focus: '--viz-focus',
        target: '--viz-target',
        grid: '--viz-grid',
        cat1: '--viz-cat-1',
        cat2: '--viz-cat-2',
        cat3: '--viz-cat-3',
        cat4: '--viz-cat-4',
        cat5: '--viz-cat-5',
        cat6: '--viz-cat-6',
        text: '--viz-text',
        textDim: '--viz-text-dim',
        surface: '--viz-surface',
        measure: '--viz-measure',
        measureHi: '--viz-measure-hi',
        measureFillA: '--viz-measure-fill-a',
        measureFillB: '--viz-measure-fill-b',
        required: '--viz-required',
    };

    function cssVar(name, fallback) {
        if (!hasDom) return fallback;
        try {
            var v = global
                .getComputedStyle(global.document.documentElement)
                .getPropertyValue(name)
                .trim();
            return v || fallback;
        } catch (_) {
            return fallback;
        }
    }

    /** A numeric token, or the fallback when the identity doesn't declare one. */
    function cssNum(name, fallback) {
        var n = parseFloat(cssVar(name, ''));
        return isFinite(n) ? n : fallback;
    }

    /** 'light' when <html data-theme="light">, else 'dark' (the stylesheet default). */
    function currentTheme() {
        if (!hasDom) return 'dark';
        var t = (global.document.documentElement.getAttribute('data-theme') || '').toLowerCase();
        return t === 'light' ? 'light' : 'dark';
    }

    function pageLang() {
        if (!hasDom) return 'fr';
        return (global.document.documentElement.getAttribute('lang') || 'fr')
            .toLowerCase()
            .indexOf('en') === 0
            ? 'en'
            : 'fr';
    }

    /** `color` at `a` alpha. Accepts #rgb, #rrggbb and rgb()/rgba(). */
    function alpha(color, a) {
        var c = parseColor(color);
        if (!c) return String(color || '').trim(); // named colour / gradient: untouched
        return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + a + ')';
    }

    /** {r,g,b,a} of a #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() string, else null. */
    function parseColor(str) {
        if (typeof str !== 'string') return null;
        var s = str.trim();
        var m = /^#([0-9a-f]{3})$/i.exec(s);
        if (m)
            s =
                '#' +
                m[1]
                    .split('')
                    .map(function (c) {
                        return c + c;
                    })
                    .join('');
        var h = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
        if (h) {
            return {
                r: parseInt(h[1].slice(0, 2), 16),
                g: parseInt(h[1].slice(2, 4), 16),
                b: parseInt(h[1].slice(4, 6), 16),
                a: h[2] ? Math.round((parseInt(h[2], 16) / 255) * 1000) / 1000 : 1,
            };
        }
        // Bounded: at most 4 numeric groups of a short string (no backtracking blow-up).
        if (s.length > 64) return null;
        var r =
            /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)(?:[\s,/]+(\d*\.?\d+%?))?\s*\)$/i.exec(
                s
            );
        if (r) {
            var a = r[4] == null ? 1 : /%$/.test(r[4]) ? parseFloat(r[4]) / 100 : parseFloat(r[4]);
            return { r: Math.round(+r[1]), g: Math.round(+r[2]), b: Math.round(+r[3]), a: a };
        }
        return null;
    }

    // ---- live token objects: mutated IN PLACE on a theme change, so a page that
    //      holds ChartTheme.PALETTE / .SEMANTIC / .viz sees the new values ---------
    var VIZ = {};
    var T = {};
    var PALETTE = [];
    var SEMANTIC = {};
    var ROLE = {};
    var HEAT = [];
    var RAMP = [];
    var DIAG = [];
    var SCHEMES = {};
    var GRIDS = { GRID: '', GRID_SOFT: '' };

    function fill(arr, values) {
        arr.length = 0;
        for (var i = 0; i < values.length; i++) arr.push(values[i]);
    }

    /** A token holding a comma-separated colour list, or the fallback list. */
    function list(token, fallback) {
        var raw = cssVar(token, '');
        if (!raw) return fallback;
        var parts = raw
            .split(',')
            .map(function (s) {
                return s.trim();
            })
            .filter(Boolean);
        return parts.length ? parts : fallback;
    }

    function readTokens() {
        var theme = currentTheme();
        var fb = VIZ_FALLBACK[theme];
        Object.keys(VIZ_CSS).forEach(function (k) {
            VIZ[k] = cssVar(VIZ_CSS[k], fb[k]);
        });
        VIZ.theme = theme;

        T.text = cssVar('--text-primary', '#E4E8F0');
        T.textDim = cssVar('--text-secondary', 'rgba(255,255,255,0.6)');
        T.surface = cssVar('--bg-elevated', '#1F2442');
        T.border = cssVar('--border-color', 'rgba(255,255,255,0.12)');
        // `gold` is the historical name of the accent slot: it reads the brand.
        T.gold = cssVar('--brand', '#7C6CFF');
        T.emerald = cssVar('--emerald', '#2DD4A0');
        T.amber = cssVar('--amber', '#F5A623');
        T.red = cssVar('--red', '#F06060');
        T.blue = cssVar('--blue', '#5B9DF5');

        // Quiet gridlines that stay visible in both modes.
        var isLight = theme === 'light';
        GRIDS.GRID = cssVar(
            '--chart-grid',
            isLight ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.08)'
        );
        GRIDS.GRID_SOFT = cssVar(
            '--chart-grid-soft',
            isLight ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.05)'
        );

        // THE ordered categorical palette of the historical chart call sites.
        fill(PALETTE, [
            cssVar('--chart-cat-1', T.gold),
            cssVar('--chart-cat-2', T.blue),
            cssVar('--chart-cat-3', T.emerald),
            cssVar('--chart-cat-4', T.amber),
            cssVar('--chart-cat-5', T.red),
            cssVar('--chart-cat-6', '#B48EE8'),
            cssVar('--chart-cat-7', '#4FC3E8'),
            cssVar('--chart-cat-8', '#E88EB0'),
        ]);
        // Status stays status: "low" is red whatever the brand accent is.
        SEMANTIC.good = cssVar('--chart-good', T.emerald);
        SEMANTIC.mid = cssVar('--chart-mid', T.amber);
        SEMANTIC.low = cssVar('--chart-low', T.red);
        SEMANTIC.neutral = cssVar('--chart-neutral', T.blue);
        SEMANTIC.accent = cssVar('--chart-accent', T.gold);

        // ROLES: recurring series that are neither positional nor status. The
        // historical inconsistencies are preserved (see branding.js).
        ROLE.measured = cssVar('--chart-measured', '#2E75B6');
        ROLE.reference = cssVar('--chart-reference', '#DC3545');
        ROLE.measuredAlt = cssVar('--chart-measured-alt', '#70AD47');
        ROLE.referenceAlt = cssVar('--chart-reference-alt', '#A552A3');
        ROLE.measuredWarm = cssVar('--chart-measured-warm', '#FFC000');
        ROLE.guide = cssVar('--chart-guide', '#f1c40f');
        ROLE.progress = cssVar('--chart-progress', '#3498db');
        ROLE.progressAlt = cssVar('--chart-progress-alt', '#9b59b6');
        ROLE.achieved = cssVar('--chart-achieved', '#27ae60');
        ROLE.achievedAlt = cssVar('--chart-achieved-alt', '#2ecc71');
        ROLE.outstanding = cssVar('--chart-outstanding', '#e74c3c');
        ROLE.rampMid = cssVar('--chart-ramp-mid', '#7FD9BE');
        ROLE.midLow = cssVar('--chart-mid-low', '#EE8244');
        // "Never measured" — NOT a zero. It must read as absent, not as bad.
        ROLE.noData = cssVar('--chart-nodata', 'rgba(148,163,184,0.35)');
        ROLE.neutralFill = cssVar('--chart-neutral-fill', 'rgba(91, 157, 245, 0.20)');
        ROLE.neutralFillSoft = cssVar('--chart-neutral-fill-soft', 'rgba(91,157,245,0.14)');
        ROLE.lowFill = cssVar('--chart-low-fill', 'rgba(240, 96, 96, 0.10)');
        ROLE.accentFill = cssVar('--chart-accent-fill', 'rgba(124, 108, 255,.12)');

        // 0-4 heat scale of the historical charts. Colour-blind aware (never
        // red against green alone).
        fill(
            HEAT,
            [
                'rgba(240,96,96,.32)',
                'rgba(245,166,35,.30)',
                'rgba(91,157,245,.28)',
                'rgba(45,212,160,.32)',
                'rgba(45,212,160,.55)',
            ].map(function (c, i) {
                return cssVar('--chart-heat-' + i, c);
            })
        );
        // The 5-step readiness ramp, authored as a scale (its own token).
        fill(
            RAMP,
            list('--chart-ramp', [
                SEMANTIC.low,
                SEMANTIC.mid,
                SEMANTIC.accent,
                ROLE.rampMid,
                SEMANTIC.good,
            ])
        );
        // System-logs diagnostics: index 1 is the risk series and stays red-ish.
        fill(
            DIAG,
            list('--chart-diag', ['#3b82f6', '#dc2626', '#6366f1', '#0ea5e9', '#10b981', '#f59e0b'])
        );
        // Report-builder colour schemes (the keys are stored in saved reports).
        var schemes = {
            gold: list('--chart-scheme-gold', [
                '#7C6CFF',
                '#6F61E6',
                '#6356CC',
                '#564BB3',
                '#4A4099',
                '#3E3580',
                '#322B66',
            ]),
            emerald: list('--chart-scheme-emerald', [
                '#2DD4A0',
                '#28C090',
                '#23AC80',
                '#1E9870',
                '#198460',
                '#147050',
                '#0F5C40',
            ]),
            multi: list('--chart-scheme-multi', [
                '#7C6CFF',
                '#2DD4A0',
                '#5B9DF5',
                '#F06060',
                '#F5A623',
                '#9B7DFF',
                '#22D3EE',
                '#FF6B9D',
            ]),
            heatscale: list('--chart-scheme-heatscale', [
                '#F06060',
                '#F5A623',
                '#F5D423',
                '#A8D86D',
                '#2DD4A0',
            ]),
            cool: list('--chart-scheme-cool', [
                '#5B9DF5',
                '#4E8DE0',
                '#417DCB',
                '#346DB6',
                '#275DA1',
                '#1A4D8C',
                '#0D3D77',
            ]),
            mono: list('--chart-scheme-mono', [
                '#E4E8F0',
                '#C8CDD8',
                '#ACB2C0',
                '#9097A8',
                '#747C90',
                '#586178',
                '#3C4660',
            ]),
            sunset: list('--chart-scheme-sunset', [
                '#F06060',
                '#F07840',
                '#F09020',
                '#F0A800',
                '#F0C000',
                '#E8D020',
                '#E0E040',
            ]),
        };
        Object.keys(schemes).forEach(function (k) {
            if (!SCHEMES[k]) SCHEMES[k] = [];
            fill(SCHEMES[k], schemes[k]);
        });
    }
    readTokens();

    // ---- status: fixed order, text + icon, hatch for "not measured" -------------
    var STATUS_ORDER = ['ready', 'partial', 'not_ready', 'unassessed'];
    // Labels here are a FALLBACK for a caller that passes none; pages pass the
    // `viz` locale namespace (views/partials/viz/chart.ejs).
    var STATUS = {
        ready: {
            tone: 'good',
            icon: '✓',
            hatch: false,
            order: 0,
            label: { fr: 'Prêt', en: 'Ready' },
        },
        partial: {
            tone: 'warn',
            icon: '!',
            hatch: false,
            order: 1,
            label: { fr: 'Partiellement évalué', en: 'Partially assessed' },
        },
        not_ready: {
            tone: 'risk',
            icon: '▲',
            hatch: false,
            order: 2,
            label: { fr: 'Non prêt', en: 'Not ready' },
        },
        unassessed: {
            tone: 'unmeasured',
            icon: '—',
            hatch: true,
            order: 3,
            label: { fr: 'Non évalué', en: 'Not assessed' },
        },
        good: {
            tone: 'good',
            icon: '✓',
            hatch: false,
            order: 0,
            label: { fr: 'Conforme', en: 'Compliant' },
        },
        warn: {
            tone: 'warn',
            icon: '!',
            hatch: false,
            order: 1,
            label: { fr: 'À surveiller', en: 'Watch' },
        },
        risk: {
            tone: 'risk',
            icon: '▲',
            hatch: false,
            order: 2,
            label: { fr: 'À risque', en: 'At risk' },
        },
        unmeasured: {
            tone: 'unmeasured',
            icon: '—',
            hatch: true,
            order: 3,
            label: { fr: 'Non mesuré', en: 'Not measured' },
        },
        neutral: { tone: 'neutral', icon: '', hatch: false, order: 4, label: { fr: '', en: '' } },
    };
    // The KPI module's codes (kpiPredicates.STATUS / READINESS) map onto these.
    var STATUS_ALIAS = new Map([
        ['ready', 'ready'],
        ['role_ready', 'ready'],
        ['partial', 'partial'],
        ['partially_assessed', 'partial'],
        ['not_ready', 'not_ready'],
        ['notready', 'not_ready'],
        ['unassessed', 'unassessed'],
        ['not_assessed', 'unassessed'],
        ['never_assessed', 'unassessed'],
        ['good', 'good'],
        ['compliant', 'good'],
        ['ok', 'good'],
        ['on_track', 'good'],
        ['warn', 'warn'],
        ['watch', 'warn'],
        ['warning', 'warn'],
        ['risk', 'risk'],
        ['at_risk', 'risk'],
        ['danger', 'risk'],
        ['unmeasured', 'unmeasured'],
        ['not_measured', 'unmeasured'],
        ['no_data', 'unmeasured'],
        ['neutral', 'neutral'],
        // French labels a caller may pass as a status (folded, see slug())
        ['pret', 'ready'],
        ['partiellement_evalue', 'partial'],
        ['non_pret', 'not_ready'],
        ['non_evalue', 'unassessed'],
        ['conforme', 'good'],
        ['a_surveiller', 'warn'],
        ['a_risque', 'risk'],
        ['non_mesure', 'unmeasured'],
    ]);

    function slug(s) {
        var x = String(s === null || s === undefined ? '' : s)
            .slice(0, 80)
            .trim()
            .toLowerCase();
        if (x.normalize) x = x.normalize('NFD').replace(/[̀-ͯ]/g, '');
        return x.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    function normalizeStatus(s) {
        if (s === null || s === undefined || s === '') return null;
        return STATUS_ALIAS.get(slug(s)) || null;
    }

    function tokens(theme) {
        return theme === 'light' || theme === 'dark' ? VIZ_FALLBACK[theme] : VIZ;
    }

    function statusMeta(s, lang) {
        var k = normalizeStatus(s);
        if (!k) return null;
        var m = STATUS[k];
        var l = lang === 'en' || lang === 'fr' ? lang : pageLang();
        return {
            key: k,
            tone: m.tone,
            token: '--viz-' + m.tone,
            icon: m.icon,
            hatch: m.hatch,
            order: m.order,
            label: m.label[l],
        };
    }

    /** Colour of a status; an unknown status is NEUTRAL (never green, never red). */
    function statusColor(s, theme) {
        var k = normalizeStatus(s);
        var tone = k ? STATUS[k].tone : 'neutral';
        return tokens(theme)[tone];
    }

    /** Status keys in the fixed order ready · partial · not ready · not assessed. */
    function sortByStatus(keys) {
        return (keys || []).slice().sort(function (a, b) {
            var ma = STATUS[normalizeStatus(a)] || { order: 9 };
            var mb = STATUS[normalizeStatus(b)] || { order: 9 };
            return ma.order - mb.order;
        });
    }

    /** Bands (default 80 / 50, the readiness threshold). null / non-numeric ⇒
     * 'unmeasured' — never a failing band. */
    function bandStatus(v, bands) {
        if (v === null || v === undefined || v === '' || typeof v === 'boolean')
            return 'unmeasured';
        var n = Number(v);
        if (!isFinite(n)) return 'unmeasured';
        var b = bands || {};
        var good = b.good === null || b.good === undefined ? 80 : Number(b.good);
        var warn = b.warn === null || b.warn === undefined ? 50 : Number(b.warn);
        if (b.polarity === 'lower_better') return n <= good ? 'good' : n <= warn ? 'warn' : 'risk';
        return n >= good ? 'good' : n >= warn ? 'warn' : 'risk';
    }

    // ---- categories bound to KEYS ----------------------------------------------
    var ROLE_KEYS = new Map([
        ['focus', 'focus'],
        ['self', 'focus'],
        ['scope', 'focus'],
        ['you', 'focus'],
        ['selected', 'focus'],
        ['org', 'neutral'],
        ['organisation', 'neutral'],
        ['organization', 'neutral'],
        ['reference', 'neutral'],
        ['comparator', 'neutral'],
        ['other', 'neutral'],
        ['others', 'neutral'],
        ['context', 'neutral'],
        ['neutral', 'neutral'],
        ['target', 'target'],
        ['threshold', 'target'],
    ]);
    var pinned = new Map();

    function hashSlot(key) {
        var s = slug(key);
        var h = 5381;
        for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return (h % 6) + 1;
    }

    function fixedTone(key) {
        var s = slug(key);
        if (ROLE_KEYS.has(s)) return ROLE_KEYS.get(s);
        var st = STATUS_ALIAS.get(s);
        return st ? STATUS[st].tone : null;
    }

    function preferredSlot(key) {
        return pinned.get(slug(key)) || hashSlot(key);
    }

    /** The colour of ONE category key: the same key, the same colour on every chart. */
    function colorFor(key, theme) {
        var tk = tokens(theme);
        var tone = fixedTone(key);
        if (tone) return tk[tone];
        return tk['cat' + preferredSlot(key)];
    }

    /** {key: colour} for the categories of one chart: fixed keys keep their tone;
     * free keys get their preferred slot, collisions resolved in SORTED key order,
     * so the result depends on the set of keys, never on their order. */
    function colorsFor(keys, theme) {
        var tk = tokens(theme);
        var out = new Map();
        var seen = new Set();
        var used = new Set();
        var free = [];
        (keys || []).forEach(function (k) {
            if (seen.has(k)) return;
            seen.add(k);
            var tone = fixedTone(k);
            if (tone) out.set(String(k), tk[tone]);
            else free.push(k);
        });
        free.slice()
            .sort(function (a, b) {
                return slug(a) < slug(b) ? -1 : slug(a) > slug(b) ? 1 : 0;
            })
            .forEach(function (k) {
                var slot = preferredSlot(k);
                for (var i = 0; i < 6 && used.has(slot); i++) slot = (slot % 6) + 1;
                if (used.has(slot)) {
                    out.set(String(k), tk.neutral);
                    return;
                }
                used.add(slot);
                out.set(String(k), tk['cat' + slot]);
            });
        // CreateDataProperty: a key such as "__proto__" stays an ordinary key
        return Object.fromEntries(out);
    }

    function registerCategories(map) {
        Object.keys(map || {}).forEach(function (k) {
            var n = Number(map[k]);
            if (n >= 1 && n <= 6 && n === Math.floor(n)) pinned.set(slug(k), n);
        });
    }

    // ---- changes: coloured by POLARITY, not direction ---------------------------
    function deltaTone(d, polarity) {
        if (d === null || d === undefined || d === '' || typeof d === 'boolean') return null;
        var n = Number(d);
        if (!isFinite(n)) return null;
        if (Math.abs(n) < 0.05 || polarity === 'neutral') return 'neutral';
        var up = n > 0;
        return (polarity === 'lower_better' ? !up : up) ? 'better' : 'worse';
    }

    function deltaColor(d, polarity, theme) {
        var tone = deltaTone(d, polarity);
        if (!tone) return null;
        var tk = tokens(theme);
        return tone === 'better' ? tk.good : tone === 'worse' ? tk.warn : tk.textDim;
    }

    // ---- the "not measured" hatch -------------------------------------------------
    var hatchCache = new Map();
    function hatch(color) {
        var c = color || VIZ.unmeasured;
        if (!hasDom) return c;
        var key = c + '|' + VIZ.theme;
        if (hatchCache.has(key)) return hatchCache.get(key);
        var out = c;
        try {
            var cv = global.document.createElement('canvas');
            cv.width = 8;
            cv.height = 8;
            var x = cv.getContext('2d');
            x.strokeStyle = c;
            x.lineWidth = 1.5;
            x.beginPath();
            x.moveTo(0, 8);
            x.lineTo(8, 0);
            x.moveTo(-2, 2);
            x.lineTo(2, -2);
            x.moveTo(6, 10);
            x.lineTo(10, 6);
            x.stroke();
            out = x.createPattern(cv, 'repeat') || c;
        } catch (_) {
            out = c;
        }
        hatchCache.set(key, out);
        return out;
    }

    // ---- motion & locale ------------------------------------------------------------
    var mql = null;
    try {
        mql =
            global && global.matchMedia
                ? global.matchMedia('(prefers-reduced-motion: reduce)')
                : null;
    } catch (_) {
        mql = null;
    }
    function reducedMotion() {
        return !!(mql && mql.matches);
    }
    /** The animation of every chart: 400 ms easeOutQuart; reduced motion ⇒ none. */
    function motion() {
        return reducedMotion() ? false : { duration: 400, easing: 'easeOutQuart' };
    }
    function locale() {
        return pageLang() === 'en' ? 'en-GB' : 'fr-FR';
    }

    /** A percentage tick in the page language (« 80 % » / "80%"). */
    function pctTick(v) {
        var n = Number(v);
        if (!isFinite(n)) return '';
        var F = global && global.Fmt;
        var dec = n === Math.round(n) ? 0 : 1;
        if (F && F.fmtPct) return F.fmtPct(n, dec);
        var s = n.toFixed(dec);
        return pageLang() === 'en' ? s + '%' : s.replace('.', ',') + ' %';
    }

    // ---- geometry tokens (the identity's drawing language) ----------------------
    var gridDash = cssVar('--chart-grid-dash', '');
    var GRID_DASH = gridDash
        ? gridDash
              .split(/[\s,]+/)
              .map(Number)
              .filter(function (n) {
                  return isFinite(n);
              })
        : null;
    // Marker shape cycle: a non-colour channel for readers with a colour-vision
    // deficiency. Absent → every point is a circle.
    var cycleRaw = cssVar('--chart-point-cycle', '');
    var POINT_CYCLE = cycleRaw ? cycleRaw.split(/\s*,\s*/).filter(Boolean) : null;

    /** Per-chart helpers for options the global defaults can't reach (radar scale). */
    function axis(kind) {
        if (kind === 'r') {
            return {
                grid: GRID_DASH
                    ? { color: GRIDS.GRID, borderDash: GRID_DASH }
                    : { color: GRIDS.GRID },
                angleLines: { color: GRIDS.GRID },
                pointLabels: { color: T.textDim, font: { size: 12 } },
                ticks: { color: T.textDim, backdropColor: 'transparent', showLabelBackdrop: false },
            };
        }
        return {
            grid: GRID_DASH
                ? { color: GRIDS.GRID_SOFT, borderDash: GRID_DASH }
                : { color: GRIDS.GRID_SOFT },
            border: { display: false },
            ticks: { color: T.textDim },
        };
    }

    /** A themed empty state in a canvas's container (replaces a stuck "Loading…").
     * Built with DOM nodes: the message is text, never markup. */
    function emptyState(canvasOrId, message) {
        if (!hasDom) return;
        var doc = global.document;
        var el = typeof canvasOrId === 'string' ? doc.getElementById(canvasOrId) : canvasOrId;
        if (!el) return;
        var host =
            el.closest('.chart-container-inner, .chart-container, .sl-chart, .card') ||
            el.parentElement;
        if (!host) return;
        var dflt = pageLang() === 'en' ? 'No data yet' : 'Pas encore de données';
        while (host.firstChild) host.removeChild(host.firstChild);
        var box = doc.createElement('div');
        box.className = 'chart-empty';
        box.setAttribute('role', 'status');
        var NS = 'http://www.w3.org/2000/svg';
        var svg = doc.createElementNS(NS, 'svg');
        svg.setAttribute('width', '34');
        svg.setAttribute('height', '34');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');
        svg.setAttribute('aria-hidden', 'true');
        ['M3 3v18h18', 'M7 14l3-3 3 3 4-5'].forEach(function (d) {
            var p = doc.createElementNS(NS, 'path');
            p.setAttribute('d', d);
            svg.appendChild(p);
        });
        var span = doc.createElement('span');
        span.textContent = String(message || dflt);
        box.appendChild(svg);
        box.appendChild(span);
        host.appendChild(box);
    }

    // ---- gradients (scriptable: re-evaluated on resize and theme change) --------
    /** Vertical gradient over the chart area (area fills, column bars). */
    function vGradient(ctx, top, bottom) {
        var c = ctx && ctx.chart;
        var a = c && c.chartArea;
        if (!a || !c.ctx || !c.ctx.createLinearGradient) return top;
        var g = c.ctx.createLinearGradient(0, a.top, 0, a.bottom);
        g.addColorStop(0, top);
        g.addColorStop(1, bottom);
        return g;
    }
    /** Horizontal gradient (horizontal bars). */
    function hGradient(ctx, left, right) {
        var c = ctx && ctx.chart;
        var a = c && c.chartArea;
        if (!a || !c.ctx || !c.ctx.createLinearGradient) return right;
        var g = c.ctx.createLinearGradient(a.left, 0, a.right, 0);
        g.addColorStop(0, left);
        g.addColorStop(1, right);
        return g;
    }
    /** Radial gradient from the radar centre (the measured profile's fill). */
    function rGradient(ctx, inner, outer) {
        var c = ctx && ctx.chart;
        var s = c && c.scales && c.scales.r;
        if (!s || !c.ctx || !c.ctx.createRadialGradient) return outer;
        var g = c.ctx.createRadialGradient(
            s.xCenter,
            s.yCenter,
            0,
            s.xCenter,
            s.yCenter,
            s.drawingArea || 1
        );
        g.addColorStop(0, inner);
        g.addColorStop(1, outer);
        return g;
    }

    // ---- Chart.js wiring (browser with Chart.js only) -------------------------------
    var registry = [];

    function applyDefaults() {
        if (!Chart || !Chart.defaults) return;
        var D = Chart.defaults;
        D.font.family = cssVar(
            '--chart-font-family',
            cssVar(
                '--font-body',
                "'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',sans-serif"
            )
        );
        D.font.size = Math.max(12, cssNum('--chart-font-size', 12));
        D.color = T.textDim;
        D.borderColor = GRIDS.GRID;
        D.maintainAspectRatio = false;
        D.locale = locale();
        // MERGE into the default animation object: Chart.js copies the keys of
        // defaults.animation (type, fn…) into each property animation, and
        // replacing the object breaks colour transitions.
        var mo = motion();
        if (mo && D.animation && typeof D.animation === 'object') Object.assign(D.animation, mo);
        else D.animation = mo;
        if (reducedMotion()) D.animations = false;
        if (D.plugins && D.plugins.tooltip) {
            Object.assign(D.plugins.tooltip, {
                backgroundColor: T.surface,
                borderColor: T.border,
                borderWidth: 1,
                titleColor: T.text,
                bodyColor: T.textDim,
                padding: 10,
                cornerRadius: cssNum('--chart-tooltip-radius', 8),
                boxPadding: 4,
                usePointStyle: true,
                titleFont: { weight: '600', size: 12 },
                bodyFont: { size: 12 },
            });
        }
        if (D.plugins && D.plugins.legend && D.plugins.legend.labels) {
            Object.assign(D.plugins.legend.labels, {
                color: T.textDim,
                usePointStyle: true,
                pointStyle: cssVar('--chart-legend-point-style', 'circle'),
                boxWidth: cssNum('--chart-legend-box', 8),
                boxHeight: cssNum('--chart-legend-box', 8),
                padding: 14,
            });
        }
    }

    /**
     * GEOMETRY — the non-colour half of the identity (curvature, markers, bar
     * corners, ring spacing). Applied ONLY when the token is declared; otherwise
     * Chart.js's own defaults are left untouched.
     */
    function applyGeometry() {
        if (!Chart || !Chart.defaults || !Chart.defaults.elements) return;
        var E = Chart.defaults.elements;
        function setIfDeclared(obj, key, token, parse) {
            var raw = cssVar(token, '');
            if (!raw || !obj) return;
            obj[key] = parse ? parse(raw) : raw;
        }
        setIfDeclared(E.line, 'tension', '--chart-line-tension', parseFloat);
        setIfDeclared(E.line, 'borderWidth', '--chart-line-width', parseFloat);
        setIfDeclared(E.point, 'radius', '--chart-point-radius', parseFloat);
        setIfDeclared(E.point, 'hoverRadius', '--chart-point-hover-radius', parseFloat);
        setIfDeclared(E.point, 'borderWidth', '--chart-point-border-width', parseFloat);
        setIfDeclared(E.point, 'pointStyle', '--chart-point-style');
        setIfDeclared(E.bar, 'borderRadius', '--chart-bar-radius', parseFloat);
        setIfDeclared(E.bar, 'borderWidth', '--chart-bar-border-width', parseFloat);
        setIfDeclared(E.arc, 'borderWidth', '--chart-arc-border-width', parseFloat);
        setIfDeclared(E.arc, 'spacing', '--chart-arc-spacing', parseFloat);
        var fw = cssVar('--chart-font-weight', '');
        if (fw) Chart.defaults.font.weight = fw;
    }

    /** [path, value] of every token colour (old and new snapshots compared by path). */
    function snapshot() {
        var out = [];
        function add(prefix, obj) {
            Object.keys(obj).forEach(function (k) {
                var v = obj[k];
                if (typeof v === 'string') out.push([prefix + k, v]);
                else if (Array.isArray(v))
                    v.forEach(function (x, i) {
                        if (typeof x === 'string') out.push([prefix + k + '.' + i, x]);
                    });
            });
        }
        add('T.', T);
        add('V.', VIZ);
        add('S.', SEMANTIC);
        add('R.', ROLE);
        add('G.', GRIDS);
        add('', { P: PALETTE, H: HEAT, A: RAMP, D: DIAG });
        Object.keys(SCHEMES).forEach(function (k) {
            add('X.' + k, { '': SCHEMES[k] });
        });
        return out;
    }

    function rgbKey(c) {
        return c.r + ',' + c.g + ',' + c.b;
    }

    /** old rgb → new colour (first mapping wins; identical values are skipped). */
    function buildRemap(before, after) {
        var byPath = new Map();
        after.forEach(function (e) {
            byPath.set(e[0], e[1]);
        });
        var map = new Map();
        before.forEach(function (e) {
            var nv = byPath.get(e[0]);
            if (nv === undefined || nv === null || nv === e[1]) return;
            var oc = parseColor(e[1]);
            var nc = parseColor(nv);
            if (!oc || !nc) return;
            var k = rgbKey(oc);
            if (!map.has(k)) map.set(k, nc);
        });
        return map;
    }

    function remapColor(v, map) {
        var c = parseColor(v);
        if (!c) return v;
        var n = map.get(rgbKey(c));
        if (!n) return v;
        var a = Math.round(c.a * n.a * 1000) / 1000;
        return a >= 1
            ? 'rgb(' + n.r + ', ' + n.g + ', ' + n.b + ')'
            : 'rgba(' + n.r + ', ' + n.g + ', ' + n.b + ', ' + a + ')';
    }

    function remapValue(v, map) {
        if (typeof v === 'string') return remapColor(v, map);
        if (Array.isArray(v))
            return v.map(function (x) {
                return typeof x === 'string' ? remapColor(x, map) : x;
            });
        return v;
    }

    var COLOR_KEY = /colou?r$/i;
    function remapObject(obj, map, seen, depth) {
        if (!obj || typeof obj !== 'object' || depth > 7 || seen.indexOf(obj) >= 0) return;
        seen.push(obj);
        Object.keys(obj).forEach(function (k) {
            var v = obj[k];
            if (typeof v === 'function') return;
            if (COLOR_KEY.test(k) || k === 'fill') {
                if (typeof v === 'string' || Array.isArray(v)) obj[k] = remapValue(v, map);
                else if (v && typeof v === 'object') remapObject(v, map, seen, depth + 1);
            } else if (
                v &&
                typeof v === 'object' &&
                !(typeof global.HTMLElement === 'function' && v instanceof global.HTMLElement)
            ) {
                remapObject(v, map, seen, depth + 1);
            }
        });
    }

    /** Swap old-token colours for new-token colours in a chart's config. */
    function remapChart(chart, map) {
        if (!chart || !chart.config) return;
        var cfg = chart.config;
        var data = cfg.data || chart.data;
        if (data && data.datasets)
            data.datasets.forEach(function (ds) {
                remapObject(ds, map, [], 0);
            });
        var raw = cfg._config && cfg._config.options ? cfg._config.options : cfg.options;
        if (raw) remapObject(raw, map, [], 0);
    }

    function liveCharts() {
        if (!Chart || !Chart.instances) return [];
        var inst = Chart.instances;
        return Object.keys(inst)
            .map(function (k) {
                return inst[k];
            })
            .filter(Boolean);
    }

    /** A chart to re-render on a theme change. `retheme(chart)` (optional) rebuilds
     * its colours from tokens; without it, old token colours are remapped. */
    function register(chart, retheme) {
        if (!chart) return chart;
        registry = registry.filter(function (r) {
            return r.chart !== chart && r.chart && r.chart.canvas;
        });
        registry.push({ chart: chart, retheme: typeof retheme === 'function' ? retheme : null });
        return chart;
    }

    function unregister(chart) {
        registry = registry.filter(function (r) {
            return r.chart !== chart;
        });
    }

    /** Every live chart: registered ones first, then Chart.instances. */
    function all() {
        if (!Chart && global) Chart = global.Chart || null;
        var out = [];
        registry.forEach(function (r) {
            if (r.chart && r.chart.canvas && out.indexOf(r.chart) < 0) out.push(r.chart);
        });
        liveCharts().forEach(function (ch) {
            if (ch && ch.canvas && out.indexOf(ch) < 0) out.push(ch);
        });
        return out;
    }

    var refreshCount = 0;
    /** Re-read every token; re-render every live chart. Returns how many re-rendered. */
    function refresh() {
        attachChart();
        var before = snapshot();
        readTokens();
        hatchCache = new Map();
        var map = buildRemap(before, snapshot());
        applyDefaults();
        var n = 0;
        var charts = liveCharts();
        registry.forEach(function (r) {
            if (charts.indexOf(r.chart) < 0 && r.chart && r.chart.canvas) charts.push(r.chart);
        });
        charts.forEach(function (ch) {
            var reg = null;
            registry.forEach(function (r) {
                if (r.chart === ch) reg = r;
            });
            try {
                if (reg && reg.retheme) reg.retheme(ch);
                else remapChart(ch, map);
                if (ch.options) ch.options.animation = motion();
                // Chart.js keeps ONE shared options object per dataset and never
                // refreshes it in 'none' mode: drop it so the update rebuilds it.
                (ch.data && ch.data.datasets ? ch.data.datasets : []).forEach(function (_, di) {
                    var meta = ch.getDatasetMeta ? ch.getDatasetMeta(di) : null;
                    if (meta && meta.controller) meta.controller._sharedOptions = undefined;
                });
                ch.update('none');
                n++;
            } catch (_) {
                /* a destroyed chart: skip */
            }
        });
        registry = registry.filter(function (r) {
            return r.chart && r.chart.canvas;
        });
        refreshCount++;
        if (hasDom && typeof global.CustomEvent === 'function') {
            try {
                global.document.dispatchEvent(
                    new global.CustomEvent('viz:themechange', { detail: { theme: VIZ.theme } })
                );
            } catch (_) {
                /* old browser */
            }
        }
        return n;
    }

    var chartWired = false;
    /** Apply the Chart.js defaults once Chart.js is present (idempotent). */
    function attachChart() {
        if (!Chart && global) Chart = global.Chart || null;
        if (!Chart || !Chart.defaults || chartWired) return !!chartWired;
        chartWired = true;
        applyDefaults();
        applyGeometry();
        return true;
    }
    attachChart();

    // ONE observer for the whole page, even if this file is included twice.
    if (hasDom && typeof global.MutationObserver === 'function' && !global.__vizThemeObserver) {
        var pending = false;
        var schedule = function () {
            if (pending) return;
            pending = true;
            var run = function () {
                pending = false;
                refresh();
            };
            if (global.requestAnimationFrame) global.requestAnimationFrame(run);
            else global.setTimeout(run, 0);
        };
        global.__vizThemeObserver = new global.MutationObserver(schedule);
        global.__vizThemeObserver.observe(global.document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme', 'data-palette', 'lang'],
        });
        if (mql) {
            var onMotion = function () {
                refresh();
            };
            if (mql.addEventListener) mql.addEventListener('change', onMotion);
            else if (mql.addListener) mql.addListener(onMotion);
        }
    }

    return {
        // historical surface (unchanged shape)
        tokens: T,
        get GRID() {
            return GRIDS.GRID;
        },
        get GRID_SOFT() {
            return GRIDS.GRID_SOFT;
        },
        GRID_DASH: GRID_DASH,
        PALETTE: PALETTE,
        SEMANTIC: SEMANTIC,
        ROLE: ROLE,
        HEAT: HEAT,
        SCHEMES: SCHEMES,
        DIAG: DIAG,
        RAMP: RAMP,
        get reduceMotion() {
            return reducedMotion();
        },
        identity: cssVar('--chart-identity', 'community'),
        axis: axis,
        emptyState: emptyState,
        alpha: alpha,
        color: function (i) {
            return PALETTE[i % PALETTE.length];
        },
        /** Marker shape for series i (a non-colour channel when the identity asks). */
        pointStyle: function (i) {
            return POINT_CYCLE ? POINT_CYCLE[i % POINT_CYCLE.length] : undefined;
        },
        pctTick: pctTick,
        // data-visualisation layer
        viz: VIZ,
        VIZ_FALLBACK: VIZ_FALLBACK,
        VIZ_CSS: VIZ_CSS,
        STATUS_ORDER: STATUS_ORDER,
        normalizeStatus: normalizeStatus,
        statusMeta: statusMeta,
        statusColor: statusColor,
        sortByStatus: sortByStatus,
        bandStatus: bandStatus,
        colorFor: colorFor,
        colorsFor: colorsFor,
        registerCategories: registerCategories,
        deltaTone: deltaTone,
        deltaColor: deltaColor,
        hatch: hatch,
        vGradient: vGradient,
        hGradient: hGradient,
        rGradient: rGradient,
        parseColor: parseColor,
        register: register,
        unregister: unregister,
        all: all,
        refresh: refresh,
        get refreshCount() {
            return refreshCount;
        },
        motion: motion,
        locale: locale,
        theme: currentTheme,
        attachChart: attachChart,
        __viz: true,
        _buildRemap: buildRemap,
        _remapColor: remapColor,
    };
});
