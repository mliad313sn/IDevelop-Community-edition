/* eslint-env browser */
/**
 * chart-theme.js — one professional Chart.js theme for the whole app.
 *
 * Loaded BEFORE any file that instantiates charts (dashboard.js, rb-renderers.js,
 * and the inline chart scripts in system-logs / employees views). It sets global
 * Chart.defaults so EVERY chart inherits: the app font, a themed dark tooltip,
 * subtle gridlines that are actually visible on the dark bg, tabular numerals,
 * reduced-motion support, and a single categorical palette derived from the
 * design tokens (`--brand`, `--emerald`, …) — instead of the three unrelated
 * hardcoded palettes charts used before.
 *
 * Exposes `window.ChartTheme` (palette, semantic colors, chart roles, heat scale,
 * axis helpers) for the few per-chart options that can't be set globally.
 *
 * ── IDENTITY ────────────────────────────────────────────────────────────────
 * This file does NOT know which chart identity is running and MUST NOT learn: it
 * reads `--chart-*` CSS custom properties and falls back, property by property,
 * to neutral defaults. The custom properties are emitted by src/utils/branding.js
 * from a single identity-keyed table — the one place that knows the palette.
 *
 * Adding a chart colour? Give it a ROLE below and a value in that table. Never a
 * literal hex at the call site — a literal cannot follow the accent, so it would
 * never follow a re-brand and would quietly half-theme the product.
 */
(function (global) {
    'use strict';
    var Chart = global.Chart;
    if (!Chart) return; // Chart.js must be loaded first.

    function cssVar(name, fallback) {
        try {
            var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
        } catch (_) {
            return fallback;
        }
    }

    /** A numeric token, or the fallback when the edition doesn't declare one. */
    function cssNum(name, fallback) {
        var v = cssVar(name, '');
        var n = parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    }

    // Theme tokens (read live so light/dark + brand tweaks flow into the canvases).
    var T = {
        text: cssVar('--text-primary', '#E4E8F0'),
        textDim: cssVar('--text-secondary', 'rgba(255,255,255,0.6)'),
        surface: cssVar('--bg-elevated', '#1F2442'),
        border: cssVar('--border-color', 'rgba(255,255,255,0.12)'),
        gold: cssVar('--brand', '#7C6CFF'),
        emerald: cssVar('--emerald', '#2DD4A0'),
        amber: cssVar('--amber', '#F5A623'),
        red: cssVar('--red', '#F06060'),
        blue: cssVar('--blue', '#5B9DF5'),
    };

    /** `color` at `a` alpha, for the translucent radar/area fills. Accepts #rgb,
     * #rrggbb and rgb/rgba so a token can be given in any of those forms. */
    function alpha(color, a) {
        var s = String(color || '').trim();
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
        var h = /^#([0-9a-f]{6})$/i.exec(s);
        if (h) {
            return (
                'rgba(' +
                parseInt(h[1].slice(0, 2), 16) +
                ', ' +
                parseInt(h[1].slice(2, 4), 16) +
                ', ' +
                parseInt(h[1].slice(4, 6), 16) +
                ', ' +
                a +
                ')'
            );
        }
        var r = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
        if (r) return 'rgba(' + r[1] + ', ' + r[2] + ', ' + r[3] + ', ' + a + ')';
        return s; // named colour / gradient — hand it back untouched
    }

    // Subtle gridlines — must adapt to the active theme (white-alpha on dark,
    // black-alpha on light) so they stay visible-but-quiet in BOTH modes. The old
    // per-chart configs hardcoded black-alpha, which vanished on the dark theme.
    var isLight =
        (document.documentElement.getAttribute('data-theme') || '').toLowerCase() === 'light';
    var GRID = cssVar('--chart-grid', isLight ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.08)');
    var GRID_SOFT = cssVar(
        '--chart-grid-soft',
        isLight ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.05)'
    );

    // THE ordered categorical palette — the only one in the tree. Each slot reads
    // the running identity's token and falls back to a neutral default. Every
    // entry clears 3:1 against the chart surface in the identity that ships it.
    var PALETTE = [
        cssVar('--chart-cat-1', T.gold),
        cssVar('--chart-cat-2', T.blue),
        cssVar('--chart-cat-3', T.emerald),
        cssVar('--chart-cat-4', T.amber),
        cssVar('--chart-cat-5', T.red),
        cssVar('--chart-cat-6', '#B48EE8'),
        cssVar('--chart-cat-7', '#4FC3E8'),
        cssVar('--chart-cat-8', '#E88EB0'),
    ];

    // Semantic colors for readiness / gap severity. NEVER positional: "danger" has
    // to stay red-ish in every edition, whatever the brand accent is.
    var SEMANTIC = {
        good: cssVar('--chart-good', T.emerald),
        mid: cssVar('--chart-mid', T.amber),
        low: cssVar('--chart-low', T.red),
        neutral: cssVar('--chart-neutral', T.blue),
        accent: cssVar('--chart-accent', T.gold),
    };

    /**
     * ROLES — recurring chart series that are neither positional nor status.
     *
     * Each of these was a literal hex at a call site until it was tokenised; the
     * fallback below is only used when no identity declares the role.
     *
     * KNOWN INCONSISTENCY (inherited, deliberately preserved here rather than
     * silently "fixed" under a theming change): the same role carries different
     * legacy colours in different modules — `measured` is #2E75B6 on the
     * comparator radars but `progress` is #3498db on the employee-progress and
     * department-analytics charts, and `achieved` #27ae60 doubles as both a
     * measure and a workflow state. Collapsing them is a real improvement but it
     * restyles every chart, so it belongs to its own re-baselined pass.
     */
    var ROLE = {
        // comparator radars: observed value vs the required/target level
        measured: cssVar('--chart-measured', '#2E75B6'),
        reference: cssVar('--chart-reference', '#DC3545'),
        measuredAlt: cssVar('--chart-measured-alt', '#70AD47'),
        referenceAlt: cssVar('--chart-reference-alt', '#A552A3'),
        measuredWarm: cssVar('--chart-measured-warm', '#FFC000'),
        // an overlay that is a guide rather than data (9-box ideal distribution)
        guide: cssVar('--chart-guide', '#f1c40f'),
        // longitudinal / throughput series
        progress: cssVar('--chart-progress', '#3498db'),
        progressAlt: cssVar('--chart-progress-alt', '#9b59b6'),
        achieved: cssVar('--chart-achieved', '#27ae60'),
        achievedAlt: cssVar('--chart-achieved-alt', '#2ecc71'),
        outstanding: cssVar('--chart-outstanding', '#e74c3c'),
        // Intermediate steps in the readiness ramps, which are finer-grained than
        // the three-step semantic scale.
        rampMid: cssVar('--chart-ramp-mid', '#7FD9BE'),
        midLow: cssVar('--chart-mid-low', '#EE8244'),
        // "Never measured" — NOT a zero. It must read as absent, not as bad.
        noData: cssVar('--chart-nodata', 'rgba(148,163,184,0.35)'),
        // Translucent area fills paired with the neutral / low strokes. These are
        // separate tokens rather than alpha of the stroke because the historical
        // literals are the DARK-theme blue and red at alpha while the strokes are
        // theme-aware — so on the light theme the fill and its stroke are already
        // slightly different hues. Preserved verbatim rather than silently
        // corrected under a theming change; see the report.
        neutralFill: cssVar('--chart-neutral-fill', 'rgba(91, 157, 245, 0.20)'),
        neutralFillSoft: cssVar('--chart-neutral-fill-soft', 'rgba(91,157,245,0.14)'),
        lowFill: cssVar('--chart-low-fill', 'rgba(240, 96, 96, 0.10)'),
        accentFill: cssVar('--chart-accent-fill', 'rgba(124, 108, 255,.12)'),
    };

    // 0–4 heat scale. Colorblind-aware: red → amber → blue → emerald (NOT red/green only).
    var HEAT_FALLBACK = [
        'rgba(240,96,96,.32)',
        'rgba(245,166,35,.30)',
        'rgba(91,157,245,.28)',
        'rgba(45,212,160,.32)',
        'rgba(45,212,160,.55)',
    ];
    var HEAT = HEAT_FALLBACK.map(function (c, i) {
        return cssVar('--chart-heat-' + i, c);
    });

    /**
     * Report-builder colour schemes (the user picks one per chart section).
     * Historically a SECOND palette table living inside rb-renderers.js — i.e. a
     * set of colours no edition could reach, which is why report-builder charts
     * would otherwise have stayed gold in a green product. Hoisted here so a
     * colour is defined in one place and the report builder follows the edition
     * like every other chart.
     *
     * Each scheme is one token holding a comma-separated hex list; the fallbacks
     * below are rb-renderers' arrays verbatim, so an edition that declares nothing
     * gets exactly the ramps it has always had.
     */
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
    /**
     * The 5-step readiness ramp (0-20 % … 81-100 %). Its own token rather than a
     * composition of semantic slots, because a ramp that borrows the
     * ACCENT for its middle step — and an accent is brand-defined. In a
     * green-branded edition that made steps 3, 4 and 5 three near-identical
     * greens, i.e. a status ramp that stopped ranking anything. A sequential
     * scale has to be authored as a scale.
     */
    var RAMP = list('--chart-ramp', [
        SEMANTIC.low,
        SEMANTIC.mid,
        SEMANTIC.accent,
        ROLE.rampMid,
        SEMANTIC.good,
    ]);

    /**
     * The system-logs diagnostics page carried a THIRD unrelated palette (six
     * loose hex arguments). Positional, with one exception: index 1 is the risk
     * series and has to stay red-ish in every identity.
     */
    var DIAG = list('--chart-diag', [
        '#3b82f6',
        '#dc2626',
        '#6366f1',
        '#0ea5e9',
        '#10b981',
        '#f59e0b',
    ]);

    var SCHEMES = {
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
    // Conditional-format thresholds in the report builder (readiness/gap/level/
    // coverage) are STATUS, so they read from SEMANTIC — never from a scheme.

    var reduceMotion = !!(
        global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches
    );

    // ---- Global defaults: apply to every chart with no per-config change --------
    Chart.defaults.font.family = cssVar(
        '--chart-font-family',
        "'Inter','Segoe UI',system-ui,-apple-system,sans-serif"
    );
    Chart.defaults.font.size = cssNum('--chart-font-size', 12);
    Chart.defaults.color = T.textDim;
    Chart.defaults.borderColor = GRID;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.animation = reduceMotion ? false : { duration: 520, easing: 'easeOutQuart' };
    Chart.defaults.animations = reduceMotion ? false : Chart.defaults.animations;

    /**
     * GEOMETRY — the non-colour half of the identity.
     *
     * Recolouring alone is a weak differentiator: two products with the same
     * curves, the same round bars and the same dot markers read as one product in
     * two skins. These tokens let an edition choose a different drawing language
     * (line curvature, marker shape and size, bar corner, ring thickness, grid
     * dash) without any chart knowing about it.
     *
     * Applied ONLY when the token is present. When it is absent — no edition
     * declared —
     * Chart.js's own defaults are left untouched, so nothing about the existing
     * product moves.
     */
    function setIfDeclared(obj, key, token, parse) {
        var raw = cssVar(token, '');
        if (!raw) return;
        obj[key] = parse ? parse(raw) : raw;
    }
    var E = Chart.defaults.elements;
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

    // Gridlines can be dashed rather than solid — a quiet but unmistakable change
    // of drawing language that costs no legibility.
    var gridDash = cssVar('--chart-grid-dash', '');
    var GRID_DASH = gridDash
        ? gridDash
              .split(/[\s,]+/)
              .map(Number)
              .filter(function (n) {
                  return Number.isFinite(n);
              })
        : null;

    // Marker shape cycle: a SECOND, non-colour channel that separates series for
    // readers with a colour-vision deficiency. Absent → every point is a circle,
    // exactly as before.
    var cycleRaw = cssVar('--chart-point-cycle', '');
    var POINT_CYCLE = cycleRaw ? cycleRaw.split(/\s*,\s*/).filter(Boolean) : null;

    if (Chart.defaults.plugins && Chart.defaults.plugins.tooltip) {
        Object.assign(Chart.defaults.plugins.tooltip, {
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
    if (Chart.defaults.plugins && Chart.defaults.plugins.legend) {
        Object.assign(Chart.defaults.plugins.legend.labels, {
            color: T.textDim,
            usePointStyle: true,
            pointStyle: cssVar('--chart-legend-point-style', 'circle'),
            boxWidth: cssNum('--chart-legend-box', 8),
            boxHeight: cssNum('--chart-legend-box', 8),
            padding: 14,
        });
    }

    // ---- helpers ---------------------------------------------------------------

    // Per-chart helpers (for options global defaults can't reach, e.g. radar scale).
    function axis(kind) {
        if (kind === 'r') {
            return {
                grid: GRID_DASH ? { color: GRID, borderDash: GRID_DASH } : { color: GRID },
                angleLines: { color: GRID },
                pointLabels: { color: T.textDim, font: { size: 11 } },
                ticks: { color: T.textDim, backdropColor: 'transparent', showLabelBackdrop: false },
            };
        }
        return {
            grid: GRID_DASH ? { color: GRID_SOFT, borderDash: GRID_DASH } : { color: GRID_SOFT },
            border: { display: false },
            ticks: { color: T.textDim },
        };
    }

    /** Render a themed empty-state into a canvas's container (replaces a stuck "Loading…"). */
    function emptyState(canvasOrId, message) {
        var el = typeof canvasOrId === 'string' ? document.getElementById(canvasOrId) : canvasOrId;
        if (!el) return;
        var host =
            el.closest('.chart-container-inner, .chart-container, .sl-chart, .card') ||
            el.parentElement;
        if (!host) return;
        host.innerHTML =
            '<div class="chart-empty" role="status">' +
            '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
            '<path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 4-5"/></svg>' +
            '<span>' +
            (message || 'No data yet') +
            '</span></div>';
    }

    global.ChartTheme = {
        tokens: T,
        GRID: GRID,
        GRID_SOFT: GRID_SOFT,
        GRID_DASH: GRID_DASH,
        PALETTE: PALETTE,
        SEMANTIC: SEMANTIC,
        ROLE: ROLE,
        HEAT: HEAT,
        SCHEMES: SCHEMES,
        DIAG: DIAG,
        RAMP: RAMP,
        reduceMotion: reduceMotion,
        identity: cssVar('--chart-identity', 'community'),
        axis: axis,
        emptyState: emptyState,
        alpha: alpha,
        color: function (i) {
            return PALETTE[i % PALETTE.length];
        },
        /** Marker shape for series i — a non-colour channel when the edition asks
         * for one, and plain circles (Chart.js's own default) when it doesn't. */
        pointStyle: function (i) {
            return POINT_CYCLE ? POINT_CYCLE[i % POINT_CYCLE.length] : undefined;
        },
        pctTick: function (v) {
            return v + '%';
        },
    };
})(window);
