/* eslint-env browser */
/**
 * viz.js — the shared chart wrapper. Every chart drawn through it gets, once
 * for all:
 *   - colours from the --viz-* tokens through ChartTheme (bound to a category
 *     key or a status; the risk red only ever means "At risk");
 *   - « Show data »: an accessible <table> in a <details> (works without JS);
 *   - a generated summary as the canvas's accessible name;
 *   - keyboard access: the canvas is focusable, the arrow keys, Home and End
 *     move between values, the tooltip follows and a polite live region
 *     reads the value; Escape clears it;
 *   - gaps for null, never 0: line gaps, hatched "Not measured" bars;
 *   - a percentage over fewer than 5 people is not drawn as a percentage;
 *   - a dashed threshold or target line;
 *   - below 480 px (and whenever Chart.js is absent) a SORTED LIST (label ·
 *     value · n · status · bar) instead of the canvas; a radar opens on its
 *     data table;
 *   - a re-render on theme switch (ChartTheme.register) and a picture of
 *     every chart for printing (beforeprint / afterprint);
 *   - no text under 12 px on the canvas.
 *
 * CSP: no inline script. Server pages render views/partials/viz/chart.ejs,
 * which emits a <script type="application/json" class="viz-config"> data
 * block; this file reads it on DOMContentLoaded and attaches every listener
 * itself. Every text goes in with textContent.
 *
 * API
 *   Viz.renderChart(el, config, opts) → {chart, el, mode, update(config, opts), destroy()}
 *   Viz.init([root])                  render every [data-viz-chart] under root (idempotent)
 *   Viz.buildChartConfig(config, i18n) the Chart.js config (pure; tests)
 *   Viz.buildSummary / buildListItems / buildTable (pure)
 *
 * config (plain JSON):
 *   kind       'hbar' (default) | 'bar' | 'line' | 'stacked100' | 'radar'
 *   unit       'pct' (default) | 'count' | 'num' | 'level';  decimals
 *   labels     ['Site A', …]
 *   series     [{ key, label, data:[number|null], n:[number|null], status:[code|null], dashed? }]
 *              stacked100: one series per STATUS key (ready, partial, not_ready,
 *              unassessed), data = counts, drawn in the fixed status order.
 *   colorBy    'status' | 'series'   bands {good, warn[, polarity]}   polarity
 *   threshold  {value, label?, kind:'threshold'|'target'} | null
 *   min, max, xTitle, yTitle, endLabels, xMinFromData, annotate {index, label}
 *   radar:     axisN:[n|null] (n < 5 ⇒ the axis is hidden), targetRing {value,label},
 *              requiredLabel, legend:false
 * opts: { title, subtitle, summary, table:{head, rows}, mobileList:[…] | false,
 *         i18n:{…}, lang, height }
 */
(function (global, factory) {
    'use strict';
    var api = factory(global);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (global) global.Viz = api;
})(typeof window !== 'undefined' ? window : null, function (global) {
    'use strict';
    var hasDom = !!(global && global.document);
    var MIN_FONT = 12;

    function CT() {
        if (global && global.ChartTheme) return global.ChartTheme;
        if (typeof require === 'function') {
            try {
                return require('./chart-theme.js');
            } catch (_) {
                /* browser */
            }
        }
        return null;
    }
    function F() {
        if (global && global.Fmt) return global.Fmt;
        if (typeof require === 'function') {
            try {
                return require('./fmt.js');
            } catch (_) {
                /* browser */
            }
        }
        return null;
    }
    function axisFit() {
        if (global && global.ChartAxisFit) return global.ChartAxisFit;
        if (typeof require === 'function') {
            try {
                return require('./chart-axis-fit.js');
            } catch (_) {
                /* browser */
            }
        }
        return null;
    }
    function ChartJs() {
        return global && global.Chart ? global.Chart : null;
    }
    function fontFamily() {
        var C = ChartJs();
        return C && C.defaults && C.defaults.font ? C.defaults.font.family : 'sans-serif';
    }

    // Fallback wording when a caller passes none (pages pass the `viz` locale
    // namespace through views/partials/viz/chart.ejs).
    var I18N_DEFAULT = {
        fr: {
            unmeasured: 'Pas encore mesuré',
            small_n: 'Moins de 5 personnes : effectif seulement',
            toggle_show: 'Voir les données',
            toggle_hide: 'Masquer les données',
            table_caption: 'Données : {{title}}',
            col_label: 'Libellé',
            col_n: 'Effectif',
            col_status: 'Statut',
            list_label: 'Données du graphique, triées',
            summary_items: '{{count}} éléments',
            summary_lowest: 'le plus bas : {{label}}, {{value}}',
            summary_highest: 'le plus haut : {{label}}, {{value}}',
            summary_unmeasured: 'pas encore mesurés : {{count}}',
            keyboard_hint: 'Les flèches parcourent les valeurs ; Échap efface.',
            threshold: 'Seuil {{value}}',
            target: 'Objectif {{value}}',
            status: {
                ready: 'Prêt',
                partial: 'Partiellement évalué',
                not_ready: 'Non prêt',
                unassessed: 'Non évalué',
                good: 'Conforme',
                warn: 'À surveiller',
                risk: 'À risque',
                unmeasured: 'Pas encore mesuré',
            },
        },
        en: {
            unmeasured: 'Not measured yet',
            small_n: 'Fewer than 5 people: count only',
            toggle_show: 'Show data',
            toggle_hide: 'Hide data',
            table_caption: 'Data: {{title}}',
            col_label: 'Label',
            col_n: 'People',
            col_status: 'Status',
            list_label: 'Chart data, sorted',
            summary_items: '{{count}} items',
            summary_lowest: 'lowest: {{label}}, {{value}}',
            summary_highest: 'highest: {{label}}, {{value}}',
            summary_unmeasured: 'not measured yet: {{count}}',
            keyboard_hint: 'The arrow keys browse the values; Escape clears.',
            threshold: 'Threshold {{value}}',
            target: 'Target {{value}}',
            status: {
                ready: 'Ready',
                partial: 'Partially assessed',
                not_ready: 'Not ready',
                unassessed: 'Not assessed',
                good: 'Compliant',
                warn: 'Watch',
                risk: 'At risk',
                unmeasured: 'Not measured yet',
            },
        },
    };

    function langOf(opts) {
        var l = opts && opts.lang;
        if (!l && hasDom && global.document.documentElement)
            l = global.document.documentElement.getAttribute('lang');
        return String(l || 'fr')
            .toLowerCase()
            .indexOf('en') === 0
            ? 'en'
            : 'fr';
    }

    function i18nOf(opts) {
        var base = I18N_DEFAULT[langOf(opts)];
        var o = (opts && opts.i18n) || {};
        var out = {};
        Object.keys(base).forEach(function (k) {
            out[k] = base[k];
        });
        Object.keys(base).forEach(function (k) {
            if (k === 'status') {
                if (o.status && typeof o.status === 'object') {
                    out.status = {};
                    Object.keys(base.status).forEach(function (s) {
                        out.status[s] =
                            typeof o.status[s] === 'string' && o.status[s]
                                ? o.status[s]
                                : base.status[s];
                    });
                }
            } else if (typeof o[k] === 'string' && o[k]) out[k] = o[k];
        });
        return out;
    }

    function tpl(s, vars) {
        return String(s).replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, k) {
            return vars && vars[k] !== null && vars[k] !== undefined ? vars[k] : '';
        });
    }

    function isNum(v) {
        return typeof v === 'number'
            ? isFinite(v)
            : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v));
    }
    function num(v) {
        return isNum(v) ? Number(v) : null;
    }

    function unitOf(config) {
        return (config && config.unit) || 'pct';
    }

    function decimalsOf(config) {
        if (config && config.decimals !== null && config.decimals !== undefined)
            return config.decimals;
        var u = unitOf(config);
        return u === 'count' || u === 'num' ? 0 : 1;
    }

    /** One formatted value (null ⇒ null: the caller prints "Not measured"). */
    function fmtValue(v, config, lang) {
        var f = F();
        var n = num(v);
        if (n === null) return null;
        var d = decimalsOf(config);
        if (unitOf(config) === 'pct') return f.fmtPct(n, d, lang);
        return f.fmtNum(n, d, lang);
    }

    function kindOf(config) {
        return (config && config.kind) || 'hbar';
    }

    /** The canvas text size: never under 12 px. */
    function fontPx(size) {
        return Math.max(MIN_FONT, size || MIN_FONT);
    }

    /** stacked100: per label, counts → % of the label total; null when the total is 0. */
    function stackedPercents(config) {
        var C = CT();
        var series = (config.series || []).slice();
        series.sort(function (a, b) {
            var ma = C.statusMeta(a.key) || { order: 9 };
            var mb = C.statusMeta(b.key) || { order: 9 };
            return ma.order - mb.order;
        });
        var totals = (config.labels || []).map(function (_, i) {
            var t = 0;
            var any = false;
            series.forEach(function (s) {
                var v = num((s.data || [])[i]);
                if (v !== null) {
                    t += v;
                    any = true;
                }
            });
            return any ? t : null;
        });
        return {
            series: series,
            totals: totals,
            pct: series.map(function (s) {
                return (config.labels || []).map(function (_, i) {
                    var v = num((s.data || [])[i]);
                    var t = totals[i];
                    return v === null || !t ? null : (v / t) * 100;
                });
            }),
        };
    }

    /** The value drawn for series s at i: a % over fewer than 5 people is NOT drawn. */
    function drawnValue(config, s, i) {
        var v = num((s.data || [])[i]);
        if (v === null) return null;
        if (unitOf(config) === 'pct' && s.n) {
            var n = num(s.n[i]);
            if (n !== null && n < 5) return null;
        }
        return v;
    }

    function smallN(config, s, i) {
        if (unitOf(config) !== 'pct' || !s.n) return false;
        var n = num(s.n[i]);
        return n !== null && n < 5 && num((s.data || [])[i]) !== null;
    }

    function statusAt(config, s, i) {
        var C = CT();
        if (s.status && s.status[i]) return C.normalizeStatus(s.status[i]) || null;
        var v = drawnValue(config, s, i);
        if (v === null) return smallN(config, s, i) ? null : 'unmeasured';
        return C.bandStatus(v, config.bands || null);
    }

    function colorBy(config) {
        if (config.colorBy) return config.colorBy;
        var k = kindOf(config);
        return (k === 'hbar' || k === 'bar') && (config.series || []).length === 1
            ? 'status'
            : 'series';
    }

    // ---- Chart.js plugins (per chart, never global) ------------------------------
    function thresholdPlugin(config, i18n, lang) {
        return {
            id: 'vizThreshold',
            afterDatasetsDraw: function (chart) {
                var th = config.threshold;
                if (!th || !isNum(th.value)) return;
                var C = CT();
                var horizontal = kindOf(config) === 'hbar' || kindOf(config) === 'stacked100';
                var scale = horizontal ? chart.scales.x : chart.scales.y;
                if (!scale) return;
                var p = scale.getPixelForValue(Number(th.value));
                var a = chart.chartArea;
                var ctx = chart.ctx;
                ctx.save();
                ctx.strokeStyle = C.viz.target;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                if (horizontal) {
                    ctx.moveTo(p, a.top);
                    ctx.lineTo(p, a.bottom);
                } else {
                    ctx.moveTo(a.left, p);
                    ctx.lineTo(a.right, p);
                }
                ctx.stroke();
                ctx.setLineDash([]);
                var label =
                    th.label ||
                    tpl(th.kind === 'target' ? i18n.target : i18n.threshold, {
                        value: fmtValue(th.value, Object.assign({}, config, { decimals: 0 }), lang),
                    });
                ctx.fillStyle = C.viz.target;
                ctx.font = '600 ' + fontPx(12) + 'px ' + fontFamily();
                ctx.textBaseline = 'bottom';
                if (horizontal) {
                    ctx.textAlign = 'center';
                    ctx.fillText(label, p, a.top - 2);
                } else {
                    ctx.textAlign = 'right';
                    ctx.fillText(label, a.right, p - 3);
                }
                ctx.restore();
            },
        };
    }

    /** A dotted vertical marker on a time axis with a short label (config.annotate). */
    function annotatePlugin(config) {
        return {
            id: 'vizAnnotate',
            afterDatasetsDraw: function (chart) {
                var an = config.annotate;
                if (!an || !isNum(an.index) || kindOf(config) !== 'line') return;
                var C = CT();
                var x = chart.scales.x;
                if (!x) return;
                var p = x.getPixelForValue(Number(an.index));
                var a = chart.chartArea;
                var ctx = chart.ctx;
                ctx.save();
                ctx.strokeStyle = C.viz.textDim;
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 3]);
                ctx.beginPath();
                ctx.moveTo(p, a.top);
                ctx.lineTo(p, a.bottom);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = C.viz.textDim;
                ctx.font = '600 ' + fontPx(12) + 'px ' + fontFamily();
                ctx.textBaseline = 'top';
                ctx.textAlign = p > (a.left + a.right) / 2 ? 'right' : 'left';
                ctx.fillText(
                    String(an.label || ''),
                    p + (ctx.textAlign === 'left' ? 4 : -4),
                    a.top + 2
                );
                ctx.restore();
            },
        };
    }

    function lastIndexOf(data) {
        for (var q = (data || []).length - 1; q >= 0; q--)
            if (data[q] !== null && data[q] !== undefined) return q;
        return -1;
    }
    function firstIndexOf(data) {
        for (var q = 0; q < (data || []).length; q++)
            if (data[q] !== null && data[q] !== undefined) return q;
        return -1;
    }

    /**
     * The first label holding a drawn value in ANY series of a line chart with
     * xMinFromData: one start shared by the canvas (scales.x.min) and the phone
     * list (the leading unmeasured months are dropped, later gaps stay). -1 when
     * not applicable.
     */
    function xStartOf(config) {
        if (!config || kindOf(config) !== 'line' || !config.xMinFromData) return -1;
        var n = (config.labels || []).length;
        var first = -1;
        (config.series || []).forEach(function (s) {
            var data = [];
            for (var i = 0; i < n; i++) data.push(drawnValue(config, s, i));
            var fi = firstIndexOf(data);
            if (fi >= 0 && (first < 0 || fi < first)) first = fi;
        });
        return first;
    }

    function baseKey(s) {
        return String(s.key || s.label || '').replace(/_est$/, '');
    }

    /**
     * End-of-line labels of a time series (the legend is then hidden): each
     * series' LAST measured point gets « label value ». An estimate (dashed)
     * gets no label when the measured series it estimates is drawn. A series
     * with no value gets none (an absence is never "0 %").
     */
    function endLabelItems(config, lang) {
        var series = config.series || [];
        var measured = new Set();
        series.forEach(function (s) {
            if (!s.dashed && lastIndexOf((s.data || []).map(num)) >= 0) measured.add(baseKey(s));
        });
        var out = [];
        series.forEach(function (s, si) {
            var data = (s.data || []).map(num);
            var li = lastIndexOf(data);
            if (li < 0) return;
            if (s.dashed && measured.has(baseKey(s))) return;
            out.push({
                datasetIndex: si,
                index: li,
                value: data[li],
                text: String(s.label || s.key || '') + ' ' + fmtValue(data[li], config, lang),
            });
        });
        return out;
    }

    /** Vertical de-collision: sorted by y, each label >= gap px below the previous one. */
    function spreadLabels(ys, gap) {
        var order = ys
            .map(function (y, i) {
                return { y: y, i: i };
            })
            .sort(function (a, b) {
                return a.y - b.y || a.i - b.i;
            });
        var out = ys.slice();
        var prev = null;
        order.forEach(function (o) {
            var y = prev === null ? o.y : Math.max(o.y, prev + gap);
            out[o.i] = y;
            prev = y;
        });
        return out;
    }

    function endLabelsPlugin(config, lang) {
        return {
            id: 'vizEndLabels',
            afterDatasetsDraw: function (chart) {
                if (!config.endLabels || kindOf(config) !== 'line') return;
                var items = endLabelItems(config, lang).filter(function (it) {
                    return chart.isDatasetVisible(it.datasetIndex);
                });
                if (!items.length) return;
                var ctx = chart.ctx;
                var pts = items.map(function (it) {
                    var el = chart.getDatasetMeta(it.datasetIndex).data[it.index];
                    return el ? { x: el.x, y: el.y } : null;
                });
                var ys = spreadLabels(
                    pts.map(function (p) {
                        return p ? p.y : 0;
                    }),
                    14
                );
                ctx.save();
                ctx.font = '600 ' + fontPx(12) + 'px ' + fontFamily();
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                items.forEach(function (it, k) {
                    if (!pts[k]) return;
                    var ds = chart.data.datasets[it.datasetIndex] || {};
                    ctx.fillStyle =
                        typeof ds.borderColor === 'string' ? ds.borderColor : CT().viz.text;
                    ctx.fillText(it.text, pts[k].x + 8, ys[k]);
                });
                ctx.restore();
            },
        };
    }

    /**
     * Radar annotations: config.targetRing = {value, label} draws a dashed
     * polygon at `value` on every axis; config.requiredLabel names the required
     * polygon ON the chart, next to its first measured vertex.
     */
    function radarAnnotPlugin(config) {
        return {
            id: 'vizRadarAnnot',
            afterDatasetsDraw: function (chart) {
                var s = chart.scales && chart.scales.r;
                if (!s) return;
                var C = CT();
                var ctx = chart.ctx;
                var n = (chart.data.labels || []).length;
                var tr = config.targetRing;
                if (tr && isNum(tr.value) && n >= 3) {
                    ctx.save();
                    ctx.strokeStyle = C.viz.target;
                    ctx.lineWidth = 1.5;
                    ctx.setLineDash([4, 3]);
                    ctx.beginPath();
                    for (var i = 0; i < n; i++) {
                        var p = s.getPointPositionForValue(i, Number(tr.value));
                        if (i === 0) ctx.moveTo(p.x, p.y);
                        else ctx.lineTo(p.x, p.y);
                    }
                    ctx.closePath();
                    ctx.stroke();
                    ctx.setLineDash([]);
                    if (tr.label) {
                        var top = s.getPointPositionForValue(0, Number(tr.value));
                        ctx.fillStyle = C.viz.target;
                        ctx.font = '600 ' + fontPx(12) + 'px ' + fontFamily();
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'bottom';
                        ctx.fillText(String(tr.label), top.x + 6, top.y - 2);
                    }
                    ctx.restore();
                }
                if (config.requiredLabel) {
                    chart.data.datasets.forEach(function (ds, di) {
                        if (ds.vizKey !== 'required' || !chart.isDatasetVisible(di)) return;
                        var fi = firstIndexOf(ds.data);
                        var el = fi >= 0 ? chart.getDatasetMeta(di).data[fi] : null;
                        if (!el) return;
                        ctx.save();
                        ctx.fillStyle = ds.borderColor || C.viz.required;
                        ctx.font = 'italic 600 ' + fontPx(12) + 'px ' + fontFamily();
                        ctx.textAlign = el.x >= s.xCenter ? 'left' : 'right';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(
                            String(config.requiredLabel),
                            el.x + (el.x >= s.xCenter ? 7 : -7),
                            el.y - 9
                        );
                        ctx.restore();
                    });
                }
            },
        };
    }

    /** Direct labels on bars (value · n), hatched "Not measured" placeholders for null. */
    function labelsPlugin(config, i18n, lang) {
        return {
            id: 'vizLabels',
            afterDatasetsDraw: function (chart) {
                var k = kindOf(config);
                if (k !== 'hbar' && k !== 'bar') return;
                var C = CT();
                var f = F();
                var horizontal = k === 'hbar';
                var cat = horizontal ? chart.scales.y : chart.scales.x;
                var val = horizontal ? chart.scales.x : chart.scales.y;
                if (!cat || !val) return;
                var a = chart.chartArea;
                var ctx = chart.ctx;
                var labels = config.labels || [];
                var series = config.series || [];
                var band =
                    (horizontal ? a.bottom - a.top : a.right - a.left) / Math.max(1, labels.length);
                ctx.save();
                ctx.font = fontPx(12) + 'px ' + fontFamily();
                ctx.textBaseline = 'middle';
                labels.forEach(function (_, i) {
                    var allNull = series.every(function (s) {
                        return drawnValue(config, s, i) === null;
                    });
                    var c = cat.getPixelForValue(i);
                    if (allNull) {
                        var small = series.some(function (s) {
                            return smallN(config, s, i);
                        });
                        var thick = Math.max(6, band * 0.55);
                        if (!small) {
                            ctx.fillStyle = C.hatch(C.viz.unmeasured);
                            ctx.globalAlpha = 0.55;
                            if (horizontal)
                                ctx.fillRect(a.left, c - thick / 2, a.right - a.left, thick);
                            else ctx.fillRect(c - thick / 2, a.top, thick, a.bottom - a.top);
                            ctx.globalAlpha = 1;
                        }
                        var n0 = series[0] && series[0].n ? num(series[0].n[i]) : null;
                        var txt = small
                            ? (f.fmtN(n0, lang) || '') + ' · ' + i18n.small_n
                            : i18n.unmeasured;
                        ctx.fillStyle = C.viz.textDim;
                        ctx.textAlign = 'left';
                        if (horizontal) ctx.fillText(txt, a.left + 6, c);
                        else {
                            ctx.save();
                            ctx.translate(c, a.bottom - 6);
                            ctx.rotate(-Math.PI / 2);
                            ctx.fillText(txt, 0, 0);
                            ctx.restore();
                        }
                        return;
                    }
                    if (series.length !== 1) return;
                    var s = series[0];
                    var v = drawnValue(config, s, i);
                    var n = s.n ? num(s.n[i]) : null;
                    var text =
                        fmtValue(v, config, lang) + (n !== null ? ' · ' + f.fmtN(n, lang) : '');
                    var p = val.getPixelForValue(v);
                    ctx.fillStyle = C.viz.text;
                    if (horizontal) {
                        var w = ctx.measureText(text).width;
                        var fits = p + 6 + w <= chart.width;
                        ctx.textAlign = fits ? 'left' : 'right';
                        ctx.fillText(text, fits ? p + 6 : p - 6, c);
                    } else {
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.fillText(text, c, p - 4);
                        ctx.textBaseline = 'middle';
                    }
                });
                ctx.restore();
            },
        };
    }

    // ---- radar kind ------------------------------------------------------------------
    // A null is a GAP (spanGaps false), never 0; an axis where every series is
    // null reads « … (Not measured) »; an axis whose n < 5 is HIDDEN (listed in
    // `hidden`, still in the data table); at most RADAR_MAX axes.
    var RADAR_MAX = 12;
    function radarModel(config, i18n) {
        var labels = config.labels || [];
        var series = config.series || [];
        var axisN = config.axisN || [];
        var keep = [];
        var hidden = [];
        labels.forEach(function (lab, i) {
            var n = num(axisN[i]);
            if (n !== null && n < 5 && n > 0) hidden.push(lab);
            else keep.push(i);
        });
        var cut = keep.slice(RADAR_MAX);
        keep = keep.slice(0, RADAR_MAX);
        var unmeasured = [];
        // long axis names wrap on words (<= 18 characters a line)
        var wrap = function (s) {
            var words = String(s).split(/\s+/);
            var lines = [];
            var cur = '';
            words.forEach(function (w) {
                if (cur && (cur + ' ' + w).length > 18) {
                    lines.push(cur);
                    cur = w;
                } else cur = cur ? cur + ' ' + w : w;
            });
            if (cur) lines.push(cur);
            return lines;
        };
        var pointLabels = keep.map(function (i) {
            var all = series.every(function (s) {
                return num((s.data || [])[i]) === null;
            });
            var lines = wrap(labels[i]);
            if (all) {
                unmeasured.push(labels[i]);
                return lines.concat('(' + i18n.unmeasured + ')');
            }
            return lines.length > 1 ? lines : String(labels[i]);
        });
        return {
            idx: keep,
            labels: keep.map(function (i) {
                return labels[i];
            }),
            pointLabels: pointLabels,
            hidden: hidden,
            cut: cut.map(function (i) {
                return labels[i];
            }),
            unmeasured: unmeasured,
        };
    }

    /**
     * The measured profile is filled as fans centre → two CONSECUTIVE measured
     * vertices only (never through an unmeasured spoke, never to 0); a spoke no
     * series measured gets a hatched 14° wedge. Datasets opt in with vizGapFill.
     */
    function radarGapFillPlugin() {
        return {
            id: 'radarGapFill',
            beforeDatasetsDraw: function (chart) {
                var C = CT();
                var s = chart.scales && chart.scales.r;
                if (!s) return;
                var ctx = chart.ctx;
                var n = (chart.data.labels || []).length;
                if (!n) return;
                var anyMeasured = [];
                chart.data.datasets.forEach(function (ds, di) {
                    if (!ds.vizGapFill || !chart.isDatasetVisible(di)) return;
                    var meta = chart.getDatasetMeta(di);
                    var pts = meta && meta.data ? meta.data : [];
                    var fillCol =
                        ds.vizGapFill === 'measure'
                            ? C.rGradient(
                                  { chart: chart },
                                  C.viz.measureFillB || 'transparent',
                                  C.viz.measureFillA || 'transparent'
                              )
                            : C.alpha(C.viz.cat1, 0.1);
                    ctx.save();
                    ctx.fillStyle = fillCol;
                    for (var i = 0; i < n; i++) {
                        var j = (i + 1) % n;
                        var a = ds.data[i];
                        var b = ds.data[j];
                        if (a === null || a === undefined || b === null || b === undefined)
                            continue;
                        if (!pts[i] || !pts[j]) continue;
                        ctx.beginPath();
                        ctx.moveTo(s.xCenter, s.yCenter);
                        ctx.lineTo(pts[i].x, pts[i].y);
                        ctx.lineTo(pts[j].x, pts[j].y);
                        ctx.closePath();
                        ctx.fill();
                    }
                    ctx.restore();
                    (ds.data || []).forEach(function (v, i) {
                        if (v !== null && v !== undefined) anyMeasured[i] = true;
                    });
                });
                if (
                    !chart.data.datasets.some(function (d) {
                        return d.vizGapFill;
                    })
                )
                    return;
                var half = (7 * Math.PI) / 180;
                for (var k = 0; k < n; k++) {
                    if (anyMeasured[k]) continue;
                    var ang = s.getIndexAngle(k) - Math.PI / 2;
                    ctx.save();
                    ctx.globalAlpha = 0.35;
                    ctx.fillStyle = C.hatch(C.viz.unmeasured);
                    ctx.beginPath();
                    ctx.moveTo(s.xCenter, s.yCenter);
                    ctx.arc(s.xCenter, s.yCenter, s.drawingArea, ang - half, ang + half);
                    ctx.closePath();
                    ctx.fill();
                    ctx.restore();
                }
            },
        };
    }

    function radarChartConfig(config, i18n, lang) {
        var C = CT();
        var f = F();
        var rm = radarModel(config, i18n);
        var unit = config.unit || 'level';
        var max =
            config.max !== null && config.max !== undefined ? config.max : unit === 'pct' ? 100 : 4;
        var min = config.min !== null && config.min !== undefined ? config.min : 0;
        var measureCol = C.viz.measure || C.viz.focus;
        var requiredCol = C.viz.required || C.viz.target;
        var datasets = (config.series || []).slice(0, 3).map(function (s, si) {
            var key = String(s.key || '');
            var data = rm.idx.map(function (i) {
                return num((s.data || [])[i]);
            });
            var base = {
                label: s.label || s.key,
                vizKey: s.key || s.label,
                data: data,
                spanGaps: false, // an unmeasured axis stays OPEN — never 0
                fill: false,
                backgroundColor: 'transparent',
                pointHoverRadius: 5,
                tension: 0,
                cubicInterpolationMode: 'default',
            };
            // the requirement: dashed outline, no fill
            if (key === 'required' || (si === 1 && key !== 'unit')) {
                return Object.assign(base, {
                    borderColor: requiredCol,
                    borderWidth: 1.5,
                    borderDash: [5, 4],
                    pointStyle: 'rectRot',
                    pointRadius: 3,
                    pointBackgroundColor: requiredCol,
                    pointBorderColor: requiredCol,
                    vizGapFill: null,
                });
            }
            // a compared unit: category 1, light fill
            if (key === 'unit' || si >= 2) {
                return Object.assign(base, {
                    borderColor: C.viz.cat1,
                    borderWidth: 2,
                    borderDash: s.dashed ? [6, 4] : [],
                    pointStyle: 'triangle',
                    pointRadius: 3.5,
                    pointBackgroundColor: C.viz.surface,
                    pointBorderColor: C.viz.cat1,
                    pointBorderWidth: 2,
                    vizGapFill: 'cat1',
                });
            }
            // the measure: the measure colour, radial fill between measured vertices
            return Object.assign(base, {
                borderColor: measureCol,
                borderWidth: 2.5,
                borderDash: s.dashed ? [6, 4] : [],
                pointStyle: 'circle',
                pointRadius: 3.5,
                pointBorderWidth: 2,
                pointBackgroundColor: C.viz.surface,
                pointBorderColor: measureCol,
                vizGapFill: 'measure',
            });
        });
        var fmt = function (v) {
            if (v === null || v === undefined) return i18n.unmeasured;
            return unit === 'pct'
                ? f.fmtPct(Number(v), 1, lang)
                : f.fmtNum(Number(v), unit === 'level' ? 1 : decimalsOf(config), lang);
        };
        return {
            type: 'radar',
            data: { labels: rm.pointLabels, datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                locale: C.locale(),
                animation: C.motion(),
                scales: {
                    r: {
                        min: min,
                        max: max,
                        beginAtZero: true,
                        ticks: {
                            stepSize: unit === 'pct' ? 20 : 1,
                            backdropColor: 'transparent',
                            showLabelBackdrop: false,
                            color: C.viz.textDim,
                            font: { size: fontPx(12) },
                            callback: function (v) {
                                // no tick at the centre: the centre is not a result
                                if (Number(v) === min) return '';
                                return unit === 'pct' ? C.pctTick(v) : f.fmtNum(v, 0, lang);
                            },
                        },
                        grid: { color: C.viz.grid, circular: false },
                        angleLines: { color: C.viz.grid },
                        pointLabels: {
                            color: C.viz.text,
                            font: { size: fontPx(12), weight: '600' },
                            padding: 10,
                        },
                    },
                },
                plugins: {
                    legend: {
                        display: config.legend !== false && datasets.length > 1,
                        position: 'bottom',
                    },
                    tooltip: {
                        callbacks: {
                            label: function (item) {
                                var ds = item.dataset || {};
                                var v = ds.data ? ds.data[item.dataIndex] : null;
                                return (ds.label ? ds.label + ' : ' : '') + fmt(v);
                            },
                        },
                    },
                },
            },
            plugins: [radarGapFillPlugin(), radarAnnotPlugin(config)],
        };
    }

    function buildChartConfig(config, i18nIn, langIn) {
        var C = CT();
        var f = F();
        var lang = langIn || langOf(null);
        var i18n = i18nIn || i18nOf({ lang: lang });
        var k = kindOf(config);
        if (k === 'radar') return radarChartConfig(config, i18n, lang);
        var unit = unitOf(config);
        var labels = (config.labels || []).slice();
        var datasets = [];
        var horizontal = k === 'hbar' || k === 'stacked100';

        if (k === 'stacked100') {
            var sp = stackedPercents(config);
            sp.series.forEach(function (s, si) {
                var meta = C.statusMeta(s.key, lang);
                var col = C.statusColor(s.key);
                datasets.push({
                    label: s.label || (meta ? i18n.status[meta.key] || meta.label : s.key),
                    vizKey: s.key,
                    data: sp.pct[si],
                    counts: (s.data || []).map(num),
                    backgroundColor: meta && meta.hatch ? C.hatch(col) : col,
                    borderColor: C.viz.surface,
                    borderWidth: 1,
                    stack: 'status',
                });
            });
        } else {
            var keys = (config.series || []).map(function (s) {
                return s.key || s.label;
            });
            var cols = C.colorsFor(keys);
            var byStatus = colorBy(config) === 'status';
            // line colours by BASE key (k1 and k1_est share one colour): the first
            // base is the measure colour, the next ones categories 1, 3, 4, 6
            var lineCols = new Map();
            var measureCol = C.viz.measure || C.viz.focus;
            var measureAreaUsed = false;
            if (k === 'line') {
                var spare = [C.viz.cat1, C.viz.cat3, C.viz.cat4, C.viz.cat6];
                var bases = [];
                (config.series || []).forEach(function (s) {
                    var b = baseKey(s);
                    if (bases.indexOf(b) < 0) bases.push(b);
                });
                bases.forEach(function (b, bi) {
                    lineCols.set(b, bi === 0 ? measureCol : spare[(bi - 1) % spare.length]);
                });
            }
            (config.series || []).forEach(function (s) {
                var key = s.key || s.label;
                var data = labels.map(function (_, i) {
                    return drawnValue(config, s, i);
                });
                var ds = {
                    label: s.label || key,
                    vizKey: key,
                    data: data,
                    n: (s.n || []).map(num),
                };
                if (k === 'line') {
                    // the FIRST measured series is the measure colour with an
                    // area; an ESTIMATE stays dashed, unfilled, in the colour of
                    // the series it estimates; monotone smoothing never
                    // overshoots 0 or 100
                    var col = lineCols.get(baseKey(s)) || cols[key];
                    ds.borderColor = col;
                    ds.backgroundColor = col;
                    ds.pointBackgroundColor = C.viz.surface;
                    ds.pointBorderColor = col;
                    ds.pointHoverRadius = 5;
                    ds.spanGaps = false;
                    ds.tension = 0.35;
                    ds.cubicInterpolationMode = 'monotone';
                    ds.borderWidth = 2.5;
                    ds.fill = false;
                    var lastIdx = lastIndexOf(data);
                    ds.pointRadius = data.map(function (_, qi) {
                        return qi === lastIdx ? 4 : 0;
                    });
                    if (s.dashed) {
                        ds.borderDash = [6, 4];
                        ds.pointStyle = 'rectRot';
                        ds.borderWidth = 1.5;
                        ds.backgroundColor = 'transparent';
                    } else if (col === measureCol && !measureAreaUsed) {
                        measureAreaUsed = true;
                        ds.fill = 'origin';
                        ds.backgroundColor = function (ctx) {
                            return C.vGradient(ctx, C.viz.measureFillA, C.viz.measureFillB);
                        };
                    }
                } else if (byStatus) {
                    // one measure colour for every status, the risk red only for
                    // "At risk" (the status itself is in the chip, label and list)
                    var stList = labels.map(function (_, i) {
                        return statusAt(config, s, i);
                    });
                    ds.vizStatus = stList;
                    ds.backgroundColor = function (ctx) {
                        var st = stList[ctx.dataIndex];
                        if (st === 'risk') return C.viz.risk;
                        return horizontal
                            ? C.hGradient(ctx, C.viz.measure, C.viz.measureHi)
                            : C.vGradient(ctx, C.viz.measureHi, C.viz.measure);
                    };
                    ds.hoverBackgroundColor = C.viz.measureHi;
                    ds.borderWidth = 0;
                    ds.borderRadius = 6;
                    ds.borderSkipped = false;
                    ds.maxBarThickness = 28;
                } else {
                    ds.backgroundColor = cols[key];
                    ds.borderWidth = 0;
                }
                datasets.push(ds);
            });
        }

        var valueAxis = {
            beginAtZero: k !== 'line',
            grid: { color: C.viz.grid, lineWidth: 1, drawTicks: false },
            border: { display: false },
            ticks: {
                color: C.viz.textDim,
                padding: 8,
                maxTicksLimit: 5,
                font: { size: fontPx(12) },
                callback: function (v) {
                    return unit === 'pct'
                        ? C.pctTick(v)
                        : f.fmtNum(v, Number(v) === Math.round(Number(v)) ? 0 : 1, lang);
                },
            },
        };
        // percentages always on a fixed 0-100 axis (no zoom illusion)
        if (unit === 'pct') {
            valueAxis.min = 0;
            valueAxis.max = 100;
        }
        // A PROGRESSION (a line over time) fits its axis to the data with the
        // shared rule of public/js/chart-axis-fit.js: a narrow but real
        // movement must not look flat on 0-100.
        if (k === 'line' && config.fitAxis) {
            var ChartAxisFit = axisFit();
            if (ChartAxisFit) {
                var all = [];
                (config.series || []).forEach(function (s) {
                    labels.forEach(function (_, i) {
                        all.push(drawnValue(config, s, i));
                    });
                });
                var win = ChartAxisFit.fitRange(
                    all,
                    unit === 'level' ? ChartAxisFit.LEVEL : ChartAxisFit.PERCENT
                );
                valueAxis.min = win.min;
                valueAxis.max = win.max;
            }
        }
        if (config.min !== null && config.min !== undefined) valueAxis.min = config.min;
        if (config.max !== null && config.max !== undefined) valueAxis.max = config.max;
        if (k === 'stacked100') {
            valueAxis.stacked = true;
            valueAxis.min = 0;
            valueAxis.max = 100;
        }
        var catAxis = {
            grid: { display: false },
            border: { display: false },
            ticks:
                k === 'line'
                    ? {
                          color: C.viz.textDim,
                          autoSkip: true,
                          maxRotation: 0,
                          maxTicksLimit: 6,
                          padding: 8,
                          font: { size: fontPx(12) },
                      }
                    : { color: C.viz.text, autoSkip: false, font: { size: fontPx(12) } },
        };
        if (k === 'stacked100') catAxis.stacked = true;
        var xFirst = xStartOf(config);
        if (xFirst > 0) catAxis.min = labels[xFirst];
        var endLabels = k === 'line' && !!config.endLabels;
        var endPad = 0;
        if (endLabels) {
            endLabelItems(config, lang).forEach(function (it) {
                endPad = Math.max(endPad, Math.round(String(it.text).length * 7) + 14);
            });
            endPad = Math.min(220, endPad);
        }
        var titleOf = function (t) {
            return t ? { display: true, text: t, color: C.viz.textDim } : undefined;
        };

        var scales = horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis };
        if (config.xTitle) scales.x.title = titleOf(config.xTitle);
        if (config.yTitle) scales.y.title = titleOf(config.yTitle);

        var tooltipLabel = function (item) {
            var ds = item.dataset || {};
            var i = item.dataIndex;
            if (k === 'stacked100') {
                var cnt = ds.counts ? ds.counts[i] : null;
                var v = ds.data[i];
                if (v === null || v === undefined) return ds.label + ' : ' + i18n.unmeasured;
                return (
                    ds.label +
                    ' : ' +
                    f.fmtPct(v, 1, lang) +
                    (cnt !== null && cnt !== undefined ? ' (' + f.fmtNum(cnt, 0, lang) + ')' : '')
                );
            }
            var val = ds.data ? ds.data[i] : null;
            var n = ds.n ? ds.n[i] : null;
            var txt =
                val === null || val === undefined ? i18n.unmeasured : fmtValue(val, config, lang);
            return (
                (ds.label ? ds.label + ' : ' : '') +
                txt +
                (n !== null && n !== undefined ? ' (' + f.fmtN(n, lang) + ')' : '')
            );
        };

        return {
            type: k === 'line' ? 'line' : 'bar',
            data: { labels: labels, datasets: datasets },
            options: {
                indexAxis: horizontal ? 'y' : 'x',
                responsive: true,
                maintainAspectRatio: false,
                locale: C.locale(),
                animation: C.motion(),
                layout: {
                    padding: {
                        right: k === 'hbar' ? 8 : endPad,
                        top: config.threshold ? 16 : 0,
                    },
                },
                scales: scales,
                plugins: {
                    legend: {
                        display:
                            (k === 'line' && !endLabels) ||
                            k === 'stacked100' ||
                            (colorBy(config) === 'series' && datasets.length > 1 && !endLabels),
                        position: 'bottom',
                    },
                    tooltip: { callbacks: { label: tooltipLabel } },
                },
                elements: { bar: { borderSkipped: false } },
            },
            plugins: [
                thresholdPlugin(config, i18n, lang),
                labelsPlugin(config, i18n, lang),
                annotatePlugin(config),
                endLabelsPlugin(config, lang),
            ],
        };
    }

    // ---- pure derivations: table, list, summary ------------------------------------
    function buildTable(config, opts) {
        if (opts && opts.table && opts.table.head && opts.table.rows) return opts.table;
        var i18n = i18nOf(opts);
        var lang = langOf(opts);
        var labels = config.labels || [];
        var head = [i18n.col_label];
        var rows;
        if (kindOf(config) === 'radar') {
            // every axis (hidden and beyond 12 included): the table is the full data
            (config.series || []).forEach(function (s) {
                head.push(s.label || s.key);
            });
            var withN = (config.axisN || []).some(isNum);
            if (withN) head.push(i18n.col_n);
            rows = labels.map(function (lab, i) {
                var n = num((config.axisN || [])[i]);
                var small = n !== null && n > 0 && n < 5;
                var r = [lab];
                (config.series || []).forEach(function (s) {
                    var v = num((s.data || [])[i]);
                    r.push(small ? i18n.small_n : fmtValue(v, config, lang));
                });
                if (withN) r.push(n === null ? null : F().fmtNum(n, 0, lang));
                return r;
            });
            return { head: head, rows: rows };
        }
        if (kindOf(config) === 'stacked100') {
            var sp = stackedPercents(config);
            sp.series.forEach(function (s) {
                var m = CT().statusMeta(s.key, lang);
                head.push(s.label || (m ? i18n.status[m.key] : s.key));
            });
            head.push(i18n.col_n);
            rows = labels.map(function (lab, i) {
                var small = sp.totals[i] !== null && sp.totals[i] < 5;
                var r = [lab];
                sp.series.forEach(function (s, si) {
                    var c = num((s.data || [])[i]);
                    var p = sp.pct[si][i];
                    r.push(
                        c === null || p === null
                            ? null
                            : small
                              ? F().fmtNum(c, 0, lang)
                              : F().fmtPct(p, 1, lang) + ' (' + F().fmtNum(c, 0, lang) + ')'
                    );
                });
                r.push(sp.totals[i] === null ? null : F().fmtNum(sp.totals[i], 0, lang));
                return r;
            });
            return { head: head, rows: rows };
        }
        var series = config.series || [];
        var hasN = series.some(function (s) {
            return s.n && s.n.some(isNum);
        });
        series.forEach(function (s) {
            head.push(s.label || s.key);
        });
        if (hasN) head.push(i18n.col_n);
        rows = labels.map(function (lab, i) {
            var r = [lab];
            series.forEach(function (s) {
                if (smallN(config, s, i)) r.push(i18n.small_n);
                else r.push(fmtValue((s.data || [])[i], config, lang));
            });
            if (hasN) {
                var n = null;
                series.forEach(function (s) {
                    if (n === null && s.n) n = num(s.n[i]);
                });
                r.push(n === null ? null : F().fmtNum(n, 0, lang));
            }
            return r;
        });
        return { head: head, rows: rows };
    }

    /** The sorted list of a phone: worst first, small n next, unmeasured last. */
    function buildListItems(config, opts) {
        var i18n = i18nOf(opts);
        var lang = langOf(opts);
        var f = F();
        var C = CT();
        var items;
        if (opts && Array.isArray(opts.mobileList)) {
            items = opts.mobileList.map(function (it) {
                var v = num(it.value);
                return {
                    label: it.label,
                    value: v,
                    display: it.display || (v === null ? null : fmtValue(v, config, lang)),
                    n: num(it.n),
                    status: C.normalizeStatus(it.status) || (v === null ? 'unmeasured' : null),
                    small: false,
                    width: v === null ? null : Math.max(0, Math.min(100, v)),
                };
            });
        } else if (kindOf(config) === 'stacked100') {
            var sp = stackedPercents(config);
            var readyIdx = -1;
            sp.series.forEach(function (s, si) {
                if (C.normalizeStatus(s.key) === 'ready') readyIdx = si;
            });
            items = (config.labels || []).map(function (lab, i) {
                var v = readyIdx >= 0 ? sp.pct[readyIdx][i] : null;
                var small = sp.totals[i] !== null && sp.totals[i] < 5;
                var parts = sp.series
                    .map(function (s) {
                        var c = num((s.data || [])[i]);
                        var m = C.statusMeta(s.key, lang);
                        return c === null
                            ? null
                            : (m ? i18n.status[m.key] : s.key) + ' ' + f.fmtNum(c, 0, lang);
                    })
                    .filter(Boolean)
                    .join(' · ');
                return {
                    label: lab,
                    value: small ? null : v,
                    display: small ? i18n.small_n : v === null ? null : f.fmtPct(v, 1, lang),
                    n: sp.totals[i],
                    status: v === null && !small ? 'unmeasured' : null,
                    small: small,
                    detail: parts,
                    width: small ? null : v,
                };
            });
        } else {
            var s = (config.series || [])[0] || { data: [] };
            var max = 0;
            (s.data || []).forEach(function (x) {
                var v = num(x);
                if (v !== null && Math.abs(v) > max) max = Math.abs(v);
            });
            items = (config.labels || []).map(function (lab, i) {
                var small = smallN(config, s, i);
                var v = drawnValue(config, s, i);
                var st = small ? null : statusAt(config, s, i);
                return {
                    label: lab,
                    value: v,
                    // small n: no value ("—") and the reason on the meta line, so a
                    // long sentence never squeezes the label on a phone
                    display: small ? '—' : v === null ? null : fmtValue(v, config, lang),
                    detail: small ? i18n.small_n : null,
                    n: s.n ? num(s.n[i]) : null,
                    status: kindOf(config) === 'line' || kindOf(config) === 'radar' ? null : st,
                    small: small,
                    width:
                        v === null
                            ? null
                            : unitOf(config) === 'pct'
                              ? Math.max(0, Math.min(100, v))
                              : max
                                ? (Math.abs(v) / max) * 100
                                : 0,
                };
            });
        }
        var lowerBetter = config.polarity === 'lower_better';
        items = items.map(function (it, idx) {
            it._i = idx;
            return it;
        });
        if (kindOf(config) === 'line') {
            // a time series stays chronological; with xMinFromData it starts where
            // the canvas starts. The other lines of a month are said on its meta line.
            var custom = opts && Array.isArray(opts.mobileList);
            var x0 = custom ? -1 : xStartOf(config);
            var others = custom ? [] : (config.series || []).slice(1);
            if (others.length)
                items.forEach(function (it) {
                    var parts = [];
                    others.forEach(function (o) {
                        var ov = drawnValue(config, o, it._i);
                        if (ov !== null && ov !== undefined)
                            parts.push((o.label || o.key) + ' ' + fmtValue(ov, config, lang));
                    });
                    if (parts.length)
                        it.detail = (it.detail ? it.detail + ' · ' : '') + parts.join(' · ');
                });
            return x0 > 0 ? items.slice(x0) : items;
        }
        return items.sort(function (a, b) {
            var ra = a.value !== null ? 0 : a.small ? 1 : 2;
            var rb = b.value !== null ? 0 : b.small ? 1 : 2;
            if (ra !== rb) return ra - rb;
            if (ra === 0 && a.value !== b.value)
                return lowerBetter ? b.value - a.value : a.value - b.value;
            return a._i - b._i;
        });
    }

    /** The generated summary: « <title> : N items ; lowest … ; highest … ; not measured k ». */
    function buildSummary(config, opts) {
        if (opts && opts.summary) return String(opts.summary);
        var i18n = i18nOf(opts);
        var lang = langOf(opts);
        var f = F();
        var title = (opts && opts.title) || '';
        var parts = [];
        if (kindOf(config) === 'stacked100') {
            var sp = stackedPercents(config);
            sp.series.forEach(function (s) {
                var t = 0;
                var any = false;
                (s.data || []).forEach(function (x) {
                    var v = num(x);
                    if (v !== null) {
                        t += v;
                        any = true;
                    }
                });
                var m = CT().statusMeta(s.key, lang);
                if (any)
                    parts.push(
                        (m ? i18n.status[m.key] : s.label || s.key) + ' : ' + f.fmtNum(t, 0, lang)
                    );
            });
            return (title ? title + ' : ' : '') + parts.join(' ; ');
        }
        var items = buildListItems(config, opts);
        var measured = items
            .filter(function (it) {
                return it.value !== null;
            })
            .sort(function (a, b) {
                return a.value - b.value || a._i - b._i;
            });
        var unmeasured = items.filter(function (it) {
            return it.value === null && !it.small;
        }).length;
        parts.push(tpl(i18n.summary_items, { count: f.fmtNum(items.length, 0, lang) }));
        if (kindOf(config) === 'line') {
            var s = (config.series || [])[0];
            if (s) {
                var pts = [];
                (config.labels || []).forEach(function (lab, i) {
                    var v = num((s.data || [])[i]);
                    if (v !== null) pts.push(lab + ' ' + fmtValue(v, config, lang));
                });
                if (pts.length) parts.push(pts[0] + ' → ' + pts[pts.length - 1]);
            }
        } else if (measured.length) {
            var lo = measured[0];
            var hi = measured[measured.length - 1];
            var withN = function (it) {
                return (
                    it.display +
                    (it.n !== null && it.n !== undefined ? ' (' + f.fmtN(it.n, lang) + ')' : '')
                );
            };
            parts.push(tpl(i18n.summary_lowest, { label: lo.label, value: withN(lo) }));
            if (measured.length > 1)
                parts.push(tpl(i18n.summary_highest, { label: hi.label, value: withN(hi) }));
        }
        if (unmeasured)
            parts.push(tpl(i18n.summary_unmeasured, { count: f.fmtNum(unmeasured, 0, lang) }));
        return (title ? title + ' : ' : '') + parts.join(' ; ');
    }

    // ---- DOM ------------------------------------------------------------------------
    function h(tag, attrs, text) {
        var e = global.document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            var v = attrs[k];
            if (v === null || v === undefined || v === false) return;
            if (k === 'className') e.className = v;
            else e.setAttribute(k, v === true ? '' : String(v));
        });
        if (text !== null && text !== undefined) e.textContent = String(text);
        return e;
    }

    var uid = 0;
    function ensureStructure(el, opts, i18n) {
        if (!el.id) el.id = 'viz-' + ++uid;
        var id = el.id;
        if (!el.classList.contains('viz-chart')) el.classList.add('viz-chart');
        if (!el.querySelector('.viz-head') && (opts.title || opts.subtitle)) {
            var head = h('div', { className: 'viz-head' });
            var hd = h('div');
            if (opts.title)
                hd.appendChild(h('h3', { className: 'viz-title', id: id + '-title' }, opts.title));
            if (opts.subtitle) hd.appendChild(h('p', { className: 'viz-subtitle' }, opts.subtitle));
            head.appendChild(hd);
            el.insertBefore(head, el.firstChild);
        }
        var wrap = el.querySelector('.viz-canvas-wrap');
        if (!wrap) {
            wrap = h('div', { className: 'viz-canvas-wrap' });
            var after = el.querySelector('.viz-head');
            if (after && after.nextSibling) el.insertBefore(wrap, after.nextSibling);
            else el.appendChild(wrap);
        }
        if (opts.height) wrap.style.height = Number(opts.height) + 'px';
        var hint = el.querySelector('.viz-kbd-hint');
        if (!hint) {
            hint = h(
                'p',
                { className: 'viz-live viz-kbd-hint', id: id + '-hint' },
                i18n.keyboard_hint
            );
            wrap.appendChild(hint);
        }
        var live = el.querySelector('.viz-live[aria-live]');
        if (!live) {
            live = h('p', { className: 'viz-live', 'aria-live': 'polite' });
            wrap.appendChild(live);
        }
        var listEl = el.querySelector('.viz-list');
        if (!listEl) {
            listEl = h('ul', { className: 'viz-list', 'aria-label': i18n.list_label });
            wrap.parentNode.insertBefore(listEl, wrap.nextSibling);
        }
        var details = el.querySelector('details.viz-data');
        if (!details) {
            details = h('details', { className: 'viz-data' });
            var sm = h('summary', { className: 'viz-data-toggle btn btn-sm btn-secondary' });
            sm.appendChild(h('span', { className: 'viz-data-label' }, i18n.toggle_show));
            details.appendChild(sm);
            details.appendChild(h('div', { className: 'viz-table-wrap' }));
            listEl.parentNode.insertBefore(details, listEl.nextSibling);
        }
        return { id: id, wrap: wrap, live: live, list: listEl, details: details, hint: hint };
    }

    function renderTable(details, config, opts, i18n) {
        var tw = details.querySelector('.viz-table-wrap');
        if (!tw || tw.querySelector('table')) return; // a server-rendered table wins
        var t = buildTable(config, opts);
        var table = h('table', { className: 'viz-table' });
        if (opts.title)
            table.appendChild(
                h(
                    'caption',
                    { className: 'viz-live' },
                    tpl(i18n.table_caption, { title: opts.title })
                )
            );
        var thead = h('thead');
        var tr = h('tr');
        t.head.forEach(function (c, ci) {
            tr.appendChild(h('th', { scope: 'col', className: ci ? 'viz-num' : null }, c));
        });
        thead.appendChild(tr);
        table.appendChild(thead);
        var tb = h('tbody');
        t.rows.forEach(function (r) {
            var row = h('tr');
            r.forEach(function (c, ci) {
                if (ci === 0) {
                    row.appendChild(h('th', { scope: 'row' }, c));
                    return;
                }
                var un = c === null || c === undefined;
                row.appendChild(
                    h(
                        'td',
                        { className: 'viz-num' + (un ? ' viz-unmeasured-cell' : '') },
                        un ? i18n.unmeasured : c
                    )
                );
            });
            tb.appendChild(row);
        });
        table.appendChild(tb);
        tw.appendChild(table);
    }

    function renderList(listEl, config, opts, i18n) {
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        var C = CT();
        var lang = langOf(opts);
        buildListItems(config, opts).forEach(function (it) {
            var li = h('li', { className: 'viz-list-item' });
            li.appendChild(h('span', { className: 'viz-list-label' }, it.label));
            li.appendChild(
                h(
                    'span',
                    { className: 'viz-list-value' },
                    it.display === null || it.display === undefined ? i18n.unmeasured : it.display
                )
            );
            var bar = h('span', { className: 'viz-list-bar', 'aria-hidden': 'true' });
            var tone = it.status ? (C.statusMeta(it.status, lang) || {}).tone : null;
            var fillEl = h('span', {
                className:
                    'viz-list-fill' +
                    (it.value === null && !it.small
                        ? ' viz-list-fill--unmeasured'
                        : tone === 'risk' || tone === 'warn'
                          ? ' viz-list-fill--' + tone
                          : ''),
            });
            if (it.value !== null && it.width !== null)
                fillEl.style.width = Math.max(0, Math.min(100, it.width)) + '%';
            if (it.value !== null || !it.small) bar.appendChild(fillEl);
            li.appendChild(bar);
            var meta = [];
            if (it.n !== null && it.n !== undefined) meta.push(F().fmtN(it.n, lang));
            if (it.detail) meta.push(it.detail);
            li.appendChild(h('span', { className: 'viz-list-meta' }, meta.join(' · ')));
            if (it.status) {
                var m = C.statusMeta(it.status, lang);
                if (m && m.tone !== 'neutral') {
                    var chip = h('span', { className: 'viz-chip viz-chip--' + m.tone });
                    chip.appendChild(
                        h('span', { className: 'viz-chip-icon', 'aria-hidden': 'true' }, m.icon)
                    );
                    chip.appendChild(h('span', null, i18n.status[m.key] || m.label));
                    li.appendChild(chip);
                }
            }
            listEl.appendChild(li);
        });
    }

    /** The arrow keys, Home and End move between drawn values; tooltip and live region follow. */
    function attachKeyboard(canvas, getChart, live) {
        var pos = -1;
        function points() {
            var ch = getChart();
            if (!ch) return [];
            var out = [];
            ch.data.datasets.forEach(function (ds, di) {
                if (!ch.isDatasetVisible(di)) return;
                (ds.data || []).forEach(function (v, i) {
                    if (v !== null && v !== undefined) out.push({ datasetIndex: di, index: i });
                });
            });
            out.sort(function (a, b) {
                return a.index - b.index || a.datasetIndex - b.datasetIndex;
            });
            return out;
        }
        function show(p) {
            var ch = getChart();
            if (!ch || !p) return;
            ch.setActiveElements([p]);
            if (ch.tooltip) {
                var el = ch.getDatasetMeta(p.datasetIndex).data[p.index];
                ch.tooltip.setActiveElements([p], el ? { x: el.x, y: el.y } : { x: 0, y: 0 });
            }
            ch.update('none');
            var ds = ch.data.datasets[p.datasetIndex];
            var cb =
                ch.options.plugins &&
                ch.options.plugins.tooltip &&
                ch.options.plugins.tooltip.callbacks;
            var txt =
                cb && cb.label
                    ? cb.label({ dataset: ds, dataIndex: p.index })
                    : String(ds.data[p.index]);
            var lab = ch.data.labels[p.index];
            live.textContent = (Array.isArray(lab) ? lab.join(' ') : String(lab)) + ' — ' + txt;
        }
        function clear() {
            var ch = getChart();
            if (!ch) return;
            ch.setActiveElements([]);
            if (ch.tooltip) ch.tooltip.setActiveElements([], { x: 0, y: 0 });
            ch.update('none');
        }
        canvas.addEventListener('keydown', function (e) {
            var pts = points();
            if (!pts.length) return;
            var k = e.key;
            if (k === 'ArrowRight' || k === 'ArrowDown')
                pos = pos < pts.length - 1 ? pos + 1 : pts.length - 1;
            else if (k === 'ArrowLeft' || k === 'ArrowUp') pos = pos > 0 ? pos - 1 : 0;
            else if (k === 'Home') pos = 0;
            else if (k === 'End') pos = pts.length - 1;
            else if (k === 'Escape') {
                pos = -1;
                live.textContent = '';
                clear();
                return;
            } else return;
            e.preventDefault();
            show(pts[pos]);
        });
        canvas.addEventListener('focus', function () {
            var pts = points();
            if (!pts.length) return;
            if (pos < 0 || pos >= pts.length) pos = 0;
            show(pts[pos]);
        });
        canvas.addEventListener('blur', clear);
    }

    var NARROW = '(max-width: 479.98px)';

    function renderChart(el, config, optsIn) {
        if (!hasDom || !el) return null;
        var opts = optsIn || {};
        var cfg = config || {};
        var lang = langOf(opts);
        var i18n = i18nOf(opts);
        var parts = ensureStructure(el, opts, i18n);
        var summary = buildSummary(cfg, opts);
        var handle = { el: el, chart: null, mode: null };
        var mql = global.matchMedia ? global.matchMedia(NARROW) : null;

        renderTable(parts.details, cfg, opts, i18n);
        var summ = parts.details.querySelector('summary');
        if (summ && !parts.details.__vizToggle) {
            parts.details.__vizToggle = true;
            parts.details.addEventListener('toggle', function () {
                var lab = summ.querySelector('.viz-data-label') || summ;
                lab.textContent = parts.details.open ? i18n.toggle_hide : i18n.toggle_show;
            });
        }

        function destroyChart() {
            if (handle.chart) {
                var C = CT();
                if (C && C.unregister) C.unregister(handle.chart);
                handle.chart.destroy();
                handle.chart = null;
            }
        }

        function mount() {
            var Chart = ChartJs();
            var wantList = opts.mobileList === false ? false : !Chart || (mql && mql.matches);
            if (wantList && kindOf(cfg) === 'radar') {
                // a radar on a phone (or without Chart.js) opens on its data table:
                // a sorted list cannot carry two series
                destroyChart();
                handle.mode = 'table';
                el.setAttribute('data-viz-mode', 'table');
                parts.details.open = true;
                return;
            }
            if (wantList) {
                destroyChart();
                handle.mode = 'list';
                el.setAttribute('data-viz-mode', 'list');
                renderList(parts.list, cfg, opts, i18n);
                parts.list.setAttribute(
                    'aria-label',
                    (opts.title ? opts.title + ' — ' : '') + i18n.list_label
                );
                return;
            }
            handle.mode = 'chart';
            el.setAttribute('data-viz-mode', 'chart');
            if (handle.chart) return;
            var canvas = parts.wrap.querySelector('canvas');
            if (!canvas) {
                canvas = h('canvas');
                parts.wrap.insertBefore(canvas, parts.wrap.firstChild);
            }
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('tabindex', '0');
            canvas.setAttribute('aria-label', summary);
            canvas.setAttribute('aria-describedby', parts.hint.id);
            canvas.textContent = summary; // fallback content
            var C = CT();
            // Chart.js may have arrived after the theme: wire its defaults now
            if (C.attachChart) C.attachChart();
            handle.chart = new Chart(canvas.getContext('2d'), buildChartConfig(cfg, i18n, lang));
            C.register(handle.chart, function (ch) {
                var fresh = buildChartConfig(cfg, i18n, lang);
                ch.data.datasets.forEach(function (ds, di) {
                    var nd = fresh.data.datasets[di];
                    if (!nd) return;
                    [
                        'backgroundColor',
                        'borderColor',
                        'pointBackgroundColor',
                        'pointBorderColor',
                        'hoverBackgroundColor',
                    ].forEach(function (p) {
                        if (p in nd) ds[p] = nd[p];
                    });
                });
                ch.options = fresh.options;
            });
            if (!canvas.__vizKeys) {
                canvas.__vizKeys = true;
                attachKeyboard(
                    canvas,
                    function () {
                        return handle.chart;
                    },
                    parts.live
                );
            }
        }

        mount();
        if (mql && !el.__vizMql) {
            el.__vizMql = true;
            var onChange = function () {
                mount();
            };
            if (mql.addEventListener) mql.addEventListener('change', onChange);
            else if (mql.addListener) mql.addListener(onChange);
        }
        handle.update = function (nextConfig, nextOpts) {
            destroyChart();
            var tw = parts.details.querySelector('.viz-table-wrap');
            if (tw) while (tw.firstChild) tw.removeChild(tw.firstChild);
            return renderChart(el, nextConfig || cfg, nextOpts || opts);
        };
        handle.destroy = destroyChart;
        el.__viz = handle;
        return handle;
    }

    /** Render every [data-viz-chart] under root from its JSON data block. Idempotent. */
    function init(root) {
        if (!hasDom || !CT()) return [];
        var scope = root || global.document;
        var out = [];
        Array.prototype.forEach.call(scope.querySelectorAll('[data-viz-chart]'), function (el) {
            if (el.__viz) {
                out.push(el.__viz);
                return;
            }
            var block = el.querySelector('script.viz-config[type="application/json"]');
            if (!block) return;
            var payload;
            try {
                payload = JSON.parse(block.textContent || 'null');
            } catch (_) {
                payload = null;
            }
            if (!payload || !payload.config) return;
            out.push(renderChart(el, payload.config, payload.opts || {}));
        });
        return out;
    }

    /**
     * Print: a canvas is not re-rendered for paper. Before printing, every live
     * chart is resized to its box and snapshotted into an <img class="viz-print-img">
     * next to its canvas (the print stylesheet shows the picture and hides the
     * canvas); after printing the pictures are removed and the charts resized
     * back. Returns the number of pictures taken.
     */
    function printSnap(on) {
        var C = CT();
        var charts = C && C.all ? C.all() : [];
        var n = 0;
        charts.forEach(function (ch) {
            var cv = ch && ch.canvas;
            var wrap = cv && cv.parentNode;
            if (!wrap) return;
            var img = wrap.querySelector('img.viz-print-img');
            if (on) {
                try {
                    ch.resize(wrap.clientWidth || 640, cv.clientHeight || 280);
                    ch.update('none');
                } catch (_) {
                    /* a destroyed chart keeps its last frame */
                }
                var src = null;
                try {
                    src = ch.toBase64Image ? ch.toBase64Image('image/png', 1) : cv.toDataURL();
                } catch (_) {
                    src = null;
                }
                if (!src || String(src).indexOf('data:image/png') !== 0) return;
                if (!img) {
                    img = global.document.createElement('img');
                    img.className = 'viz-print-img';
                    img.alt = cv.getAttribute('aria-label') || '';
                    wrap.appendChild(img);
                }
                img.src = src;
                n++;
            } else if (img) {
                img.parentNode.removeChild(img);
                try {
                    ch.resize();
                } catch (_) {
                    /* destroyed */
                }
            }
        });
        return n;
    }

    if (hasDom && global.addEventListener && !global.__vizPrintHook) {
        global.__vizPrintHook = true;
        global.addEventListener('beforeprint', function () {
            printSnap(true);
        });
        global.addEventListener('afterprint', function () {
            printSnap(false);
        });
    }

    if (hasDom) {
        if (global.document.readyState === 'loading')
            global.document.addEventListener('DOMContentLoaded', function () {
                init();
            });
        else init();
    }

    return {
        renderChart: renderChart,
        init: init,
        buildChartConfig: buildChartConfig,
        buildSummary: buildSummary,
        buildListItems: buildListItems,
        buildTable: buildTable,
        xStartOf: xStartOf,
        fmtValue: fmtValue,
        i18n: i18nOf,
        radarModel: function (config, opts) {
            return radarModel(config || {}, i18nOf(opts));
        },
        RADAR_MAX: RADAR_MAX,
        printSnap: printSnap,
        endLabelItems: function (config, lang) {
            return endLabelItems(config || {}, lang);
        },
        spreadLabels: spreadLabels,
    };
});
