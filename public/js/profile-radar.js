/* eslint-env browser */
/**
 * profile-radar.js — the profile radar: the demonstrated level against the
 * required level per sub-domain (of one person, or the average of a role's
 * occupants), drawn by the `radar` kind of window.Viz.
 *
 * Rules:
 *   - an UNMEASURED axis (actual null) stays OPEN — the demonstrated polygon
 *     breaks there — and its label reads « … (Not measured) »; it is NEVER
 *     drawn at 0, and the unmeasured sub-domains are listed in words;
 *   - « Show data » opens an accessible table (demonstrated, required,
 *     assessed / required skills);
 *   - colours come from the --viz-* tokens and follow a theme switch; without
 *     Chart.js, or on a phone, the table is what shows.
 * CSP: no inline script. The page renders
 *   <section data-profile-radar> with a
 *   <script type="application/json" class="prof-radar-data">{axes, i18n, lang}</script>
 * block (views/partials/viz/radar.ejs); this file draws it on load.
 *
 * Pure part (tests): ProfileRadar.build(axes, i18n) → { labels, pointLabels,
 *   actual, required, unmeasured, rows }.
 */
(function (global, factory) {
    'use strict';
    var api = factory(global);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (global) global.ProfileRadar = api;
})(typeof window !== 'undefined' ? window : null, function (global) {
    'use strict';

    // Fallback wording; pages pass the `viz` locale namespace.
    var DEF = {
        fr: {
            actual: 'Niveau démontré',
            required: 'Niveau requis',
            unmeasured: 'Pas encore mesuré',
            unmeasuredAxes: 'Sous-domaines pas encore mesurés : {{list}}',
            empty: 'Aucune exigence de poste à comparer.',
            colSubdomain: 'Sous-domaine',
            toggle: 'Voir les données',
            coverage: 'Évaluées / requises',
        },
        en: {
            actual: 'Demonstrated level',
            required: 'Required level',
            unmeasured: 'Not measured yet',
            unmeasuredAxes: 'Sub-domains not measured yet: {{list}}',
            empty: 'No role requirement to compare.',
            colSubdomain: 'Sub-domain',
            toggle: 'Show data',
            coverage: 'Assessed / required',
        },
    };

    function langOf(i18n) {
        var l = i18n && i18n.lang;
        if (!l && global && global.document && global.document.documentElement)
            l = global.document.documentElement.getAttribute('lang');
        return String(l || 'fr')
            .toLowerCase()
            .indexOf('en') === 0
            ? 'en'
            : 'fr';
    }
    function num(v) {
        return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v);
    }
    function t(i18n, k) {
        return (i18n && typeof i18n[k] === 'string' && i18n[k]) || DEF[langOf(i18n)][k];
    }
    function fmt(v, i18n) {
        if (v === null || v === undefined) return null;
        var F =
            (global && global.Fmt) || (typeof require === 'function' ? require('./fmt.js') : null);
        return F.fmtNum(v, 1, langOf(i18n));
    }

    /** Pure: chart arrays + table rows. An unmeasured axis is null, never 0. */
    function build(axes, i18n) {
        var rows = (axes || [])
            .filter(function (a) {
                return a && a.label;
            })
            .map(function (a) {
                var actual = a.measured === false ? null : num(a.actual);
                return {
                    label: String(a.label),
                    actual: actual,
                    required: num(a.required),
                    assessed: num(a.assessed),
                    total: num(a.total),
                    measured: actual !== null,
                };
            });
        var un = t(i18n, 'unmeasured');
        return {
            labels: rows.map(function (r) {
                return r.label;
            }),
            // an unmeasured axis says so on a second line of its label
            pointLabels: rows.map(function (r) {
                return r.measured ? r.label : [r.label, '(' + un + ')'];
            }),
            actual: rows.map(function (r) {
                return r.actual;
            }),
            required: rows.map(function (r) {
                return r.required;
            }),
            unmeasured: rows
                .filter(function (r) {
                    return !r.measured;
                })
                .map(function (r) {
                    return r.label;
                }),
            rows: rows,
        };
    }

    function el(doc, tag, cls, text) {
        var e = doc.createElement(tag);
        if (cls) e.className = cls;
        if (text !== null && text !== undefined) e.textContent = String(text);
        return e;
    }

    function renderTable(doc, host, model, i18n, open) {
        var det = el(doc, 'details', 'viz-data');
        if (open) det.open = true;
        det.appendChild(
            el(doc, 'summary', 'viz-data-toggle btn btn-sm btn-secondary', t(i18n, 'toggle'))
        );
        var wrap = el(doc, 'div', 'viz-table-wrap');
        var table = el(doc, 'table', 'viz-table');
        var thead = el(doc, 'thead');
        var tr = el(doc, 'tr');
        [
            t(i18n, 'colSubdomain'),
            t(i18n, 'actual'),
            t(i18n, 'required'),
            t(i18n, 'coverage'),
        ].forEach(function (c, i) {
            var th = el(doc, 'th', i ? 'viz-num' : null, c);
            th.setAttribute('scope', 'col');
            tr.appendChild(th);
        });
        thead.appendChild(tr);
        table.appendChild(thead);
        var tb = el(doc, 'tbody');
        model.rows.forEach(function (r) {
            var row = el(doc, 'tr');
            var th = el(doc, 'th', null, r.label);
            th.setAttribute('scope', 'row');
            row.appendChild(th);
            row.appendChild(
                el(
                    doc,
                    'td',
                    r.measured ? 'viz-num' : 'viz-num viz-unmeasured-cell',
                    r.measured ? fmt(r.actual, i18n) : t(i18n, 'unmeasured')
                )
            );
            row.appendChild(
                el(doc, 'td', 'viz-num', r.required === null ? '—' : fmt(r.required, i18n))
            );
            row.appendChild(
                el(
                    doc,
                    'td',
                    'viz-num',
                    (r.assessed === null ? '—' : r.assessed) +
                        ' / ' +
                        (r.total === null ? '—' : r.total)
                )
            );
            tb.appendChild(row);
        });
        table.appendChild(tb);
        wrap.appendChild(table);
        det.appendChild(wrap);
        host.appendChild(det);
    }

    function draw(section, axes, i18n) {
        var doc = global.document;
        var model = build(axes, i18n);
        var host = section.querySelector('.prof-radar-body') || section;
        while (host.firstChild) host.removeChild(host.firstChild);
        if (!model.rows.length) {
            host.appendChild(el(doc, 'p', 'text-muted', t(i18n, 'empty')));
            return model;
        }
        var Chart = global.Chart;
        var C = global.ChartTheme;
        var V = global.Viz;
        var narrow = global.matchMedia && global.matchMedia('(max-width: 479.98px)').matches;
        var drawn = false;
        if (Chart && C && V && typeof V.buildChartConfig === 'function' && !narrow) {
            var wrap = el(doc, 'div', 'prof-radar-canvas');
            var canvas = el(doc, 'canvas');
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('tabindex', '0');
            var summary = model.rows
                .filter(function (r) {
                    return r.measured;
                })
                .slice(0, 4)
                .map(function (r) {
                    return r.label + ' ' + fmt(r.actual, i18n) + ' / ' + fmt(r.required, i18n);
                })
                .join(' ; ');
            if (model.unmeasured.length)
                summary +=
                    (summary ? ' ; ' : '') +
                    t(i18n, 'unmeasured') +
                    ' : ' +
                    model.unmeasured.length;
            canvas.setAttribute('aria-label', summary);
            canvas.textContent = summary;
            wrap.appendChild(canvas);
            host.appendChild(wrap);
            var lang = langOf(i18n);
            var cfg = function () {
                return V.buildChartConfig(
                    {
                        kind: 'radar',
                        unit: 'level',
                        min: 0,
                        max: 4,
                        labels: model.labels,
                        series: [
                            { key: 'actual', label: t(i18n, 'actual'), data: model.actual },
                            { key: 'required', label: t(i18n, 'required'), data: model.required },
                        ],
                    },
                    V.i18n({ lang: lang, i18n: { unmeasured: t(i18n, 'unmeasured') } }),
                    lang
                );
            };
            if (C.attachChart) C.attachChart();
            var chart = new Chart(canvas.getContext('2d'), cfg());
            if (C.register) {
                C.register(chart, function (ch) {
                    var fresh = cfg();
                    ch.data.datasets.forEach(function (ds, i) {
                        var nd = fresh.data.datasets[i] || {};
                        ds.borderColor = nd.borderColor;
                        ds.pointBackgroundColor = nd.pointBackgroundColor;
                        ds.pointBorderColor = nd.pointBorderColor;
                    });
                    ch.options = fresh.options;
                });
            }
            drawn = true;
        }
        if (model.unmeasured.length) {
            host.appendChild(
                el(
                    doc,
                    'p',
                    'prof-radar-unmeasured',
                    t(i18n, 'unmeasuredAxes').replace('{{list}}', model.unmeasured.join(' · '))
                )
            );
        }
        // without a canvas the table IS the chart: it opens by itself
        renderTable(doc, host, model, i18n, !drawn);
        return model;
    }

    function init(root) {
        if (!global || !global.document) return 0;
        var n = 0;
        Array.prototype.forEach.call(
            (root || global.document).querySelectorAll('[data-profile-radar]'),
            function (section) {
                if (section.__profRadar) return;
                var block = section.querySelector(
                    'script.prof-radar-data[type="application/json"]'
                );
                if (!block) return;
                var payload = null;
                try {
                    payload = JSON.parse(block.textContent || 'null');
                } catch (_) {
                    payload = null;
                }
                if (!payload) return;
                var i18n = payload.i18n || {};
                if (payload.lang) i18n.lang = payload.lang;
                section.__profRadar = draw(section, payload.axes || [], i18n);
                n++;
            }
        );
        return n;
    }

    if (global && global.document) {
        if (global.document.readyState === 'loading')
            global.document.addEventListener('DOMContentLoaded', function () {
                init();
            });
        else init();
    }

    return { build: build, draw: draw, init: init };
});
