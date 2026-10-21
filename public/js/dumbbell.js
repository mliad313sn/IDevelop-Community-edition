/* eslint-env browser */
/**
 * dumbbell.js — gap bars: the demonstrated level (●) against the required
 * level (◆) per row (sub-domain, domain or skill), on a track from 0 to `max`.
 *
 * Rules:
 *   - a row with no measurement (actual null) is a HATCHED track saying
 *     "Not measured" — never a dot at 0 — and it is left out of the "widest
 *     gaps" ranking;
 *   - rows are sorted widest measured shortfall first, unmeasured rows last;
 *   - the values are printed (fr « 2,5 », en "2.5"), never carried by colour
 *     alone; colours come from the --viz-* tokens (public/css/viz.css);
 *   - « Show data » opens an accessible table, and every row carries its own
 *     text for screen readers. No canvas: it works on a phone and in print.
 * CSP: no inline handler, no injected stylesheet; positions are set through
 * the CSSOM (element.style), text through textContent.
 *
 * Server pages render <div data-dumbbell> with a
 * <script type="application/json" class="dumbbell-data">{rows, opts}</script>
 * block (views/partials/viz/dumbbell.ejs); this file draws it on load.
 *
 * API (window.Dumbbell / require):
 *   build(rows, opts)   → { items, widest, unmeasured, max }   (pure)
 *   summary(model, opts) → one sentence                         (pure)
 *   render(el, rows, opts) → model                              (DOM)
 * rows: [{ label, actual: number|null, required: number|null, n?: number }]
 * opts: { max = 4, topN, title, lang, i18n: { actual, required, gap, unmeasured,
 *         widest, toggle, colLabel, empty } }
 */
(function (global, factory) {
    'use strict';
    var api = factory(global);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (global) global.Dumbbell = api;
})(typeof window !== 'undefined' ? window : null, function (global) {
    'use strict';

    // Fallback wording; pages pass the `viz` locale namespace.
    var I18N = {
        fr: {
            actual: 'Démontré',
            required: 'Requis',
            gap: 'Écart',
            unmeasured: 'Pas encore mesuré',
            widest: 'Écarts les plus importants (mesurés seulement)',
            toggle: 'Voir les données',
            colLabel: 'Sous-domaine',
            empty: 'Aucune exigence à comparer.',
        },
        en: {
            actual: 'Demonstrated',
            required: 'Required',
            gap: 'Gap',
            unmeasured: 'Not measured yet',
            widest: 'Widest gaps (measured only)',
            toggle: 'Show data',
            colLabel: 'Sub-domain',
            empty: 'No requirement to compare.',
        },
    };

    function langOf(opts) {
        var l = opts && opts.lang;
        if (!l && global && global.document && global.document.documentElement)
            l = global.document.documentElement.getAttribute('lang');
        return String(l || 'fr')
            .toLowerCase()
            .indexOf('en') === 0
            ? 'en'
            : 'fr';
    }
    function isNum(v) {
        return v !== null && v !== undefined && v !== '' && isFinite(Number(v));
    }
    function num(v) {
        return isNum(v) ? Number(v) : null;
    }
    function fmt(v, opts) {
        if (v === null || v === undefined) return null;
        var F =
            (global && global.Fmt) || (typeof require === 'function' ? require('./fmt.js') : null);
        return F.fmtNum(v, 1, langOf(opts));
    }
    function i18nOf(opts) {
        var base = I18N[langOf(opts)];
        var o = (opts && opts.i18n) || {};
        var out = {};
        Object.keys(base).forEach(function (k) {
            out[k] = typeof o[k] === 'string' && o[k] ? o[k] : base[k];
        });
        return out;
    }

    /** Pure model: measured rows by widest shortfall first, unmeasured last. */
    function build(rows, opts) {
        var o = opts || {};
        var max = num(o.max) || 4;
        var items = (rows || []).map(function (r, i) {
            var a = num(r.actual);
            var q = num(r.required);
            var measured = a !== null && q !== null;
            return {
                label: String(r.label === null || r.label === undefined ? '' : r.label),
                actual: a,
                required: q,
                n: num(r.n),
                measured: measured,
                // shortfall (> 0) or surplus (< 0); null when unmeasured — never 0
                gap: measured ? Math.round((q - a) * 100) / 100 : null,
                actualPct: a === null ? null : Math.max(0, Math.min(100, (a / max) * 100)),
                requiredPct: q === null ? null : Math.max(0, Math.min(100, (q / max) * 100)),
                _i: i,
            };
        });
        items.sort(function (x, y) {
            if (x.measured !== y.measured) return x.measured ? -1 : 1;
            if (x.measured && x.gap !== y.gap) return y.gap - x.gap;
            return x._i - y._i;
        });
        if (o.topN && items.length > o.topN) {
            // keep the widest measured gaps; unmeasured rows are reported, not ranked
            var measuredItems = items
                .filter(function (x) {
                    return x.measured;
                })
                .slice(0, o.topN);
            items = measuredItems.concat(
                items.filter(function (x) {
                    return !x.measured;
                })
            );
        }
        var widest = items
            .filter(function (x) {
                return x.measured && x.gap > 0;
            })
            .slice(0, 3)
            .map(function (x) {
                return x.label;
            });
        return {
            items: items,
            widest: widest,
            unmeasured: items.filter(function (x) {
                return !x.measured;
            }).length,
            max: max,
        };
    }

    function summary(model, opts) {
        var t = i18nOf(opts);
        var title = (opts && opts.title) || '';
        var parts = [];
        model.items.forEach(function (x) {
            if (!x.measured) return;
            parts.push(
                x.label +
                    ' : ' +
                    t.actual.toLowerCase() +
                    ' ' +
                    fmt(x.actual, opts) +
                    ', ' +
                    t.required.toLowerCase() +
                    ' ' +
                    fmt(x.required, opts)
            );
        });
        var s = (title ? title + ' — ' : '') + parts.slice(0, 3).join(' ; ');
        if (model.unmeasured) s += (s ? ' ; ' : '') + t.unmeasured + ' : ' + model.unmeasured;
        return s;
    }

    function h(doc, tag, cls, text) {
        var e = doc.createElement(tag);
        if (cls) e.className = cls;
        if (text !== null && text !== undefined) e.textContent = String(text);
        return e;
    }

    function render(el, rows, opts) {
        if (!el || !global || !global.document) return build(rows, opts);
        var doc = global.document;
        var t = i18nOf(opts);
        var model = build(rows, opts);
        while (el.firstChild) el.removeChild(el.firstChild);
        if (!model.items.length) {
            el.appendChild(h(doc, 'p', 'db-empty', t.empty));
            return model;
        }
        var legend = h(doc, 'div', 'db-legend');
        legend.setAttribute('aria-hidden', 'true');
        var l1 = h(doc, 'span');
        l1.appendChild(h(doc, 'span', 'db-dot'));
        l1.appendChild(doc.createTextNode(t.actual));
        var l2 = h(doc, 'span');
        l2.appendChild(h(doc, 'span', 'db-req'));
        l2.appendChild(doc.createTextNode(t.required));
        legend.appendChild(l1);
        legend.appendChild(l2);
        el.appendChild(legend);

        var listEl = h(doc, 'ul', 'db-list');
        listEl.setAttribute('aria-label', summary(model, opts));
        model.items.forEach(function (x) {
            var li = h(doc, 'li', 'db-row');
            var lab = h(doc, 'span', 'db-label', x.label);
            lab.setAttribute('title', x.label);
            li.appendChild(lab);
            var track = h(doc, 'span', 'db-track' + (x.measured ? '' : ' db-track--unmeasured'));
            track.setAttribute('aria-hidden', 'true');
            if (x.measured) {
                var lo = Math.min(x.actualPct, x.requiredPct);
                var hi = Math.max(x.actualPct, x.requiredPct);
                var bar = h(doc, 'span', 'db-bar' + (x.gap > 0 ? ' db-bar--short' : ''));
                bar.style.left = lo + '%';
                bar.style.width = hi - lo + '%';
                track.appendChild(bar);
                var req = h(doc, 'span', 'db-req');
                req.style.left = x.requiredPct + '%';
                track.appendChild(req);
                var dot = h(doc, 'span', 'db-dot');
                dot.style.left = x.actualPct + '%';
                track.appendChild(dot);
            } else if (x.requiredPct !== null) {
                var req2 = h(doc, 'span', 'db-req');
                req2.style.left = x.requiredPct + '%';
                track.appendChild(req2);
            }
            li.appendChild(track);
            var val = x.measured
                ? h(doc, 'span', 'db-val', fmt(x.actual, opts) + ' → ' + fmt(x.required, opts))
                : h(doc, 'span', 'db-val db-un', t.unmeasured);
            val.setAttribute('aria-hidden', 'true');
            li.appendChild(val);
            // the row's text for screen readers (the track is decorative)
            li.appendChild(
                h(
                    doc,
                    'span',
                    'viz-live',
                    x.measured
                        ? t.actual +
                              ' ' +
                              fmt(x.actual, opts) +
                              ', ' +
                              t.required +
                              ' ' +
                              fmt(x.required, opts) +
                              ', ' +
                              t.gap +
                              ' ' +
                              fmt(x.gap, opts)
                        : t.unmeasured +
                              (x.required !== null
                                  ? ', ' + t.required + ' ' + fmt(x.required, opts)
                                  : '')
                )
            );
            listEl.appendChild(li);
        });
        el.appendChild(listEl);
        if (model.widest.length)
            el.appendChild(h(doc, 'p', 'db-widest', t.widest + ' : ' + model.widest.join(' · ')));
        var det = h(doc, 'details', 'viz-data');
        det.appendChild(h(doc, 'summary', 'viz-data-toggle btn btn-sm btn-secondary', t.toggle));
        var wrap = h(doc, 'div', 'viz-table-wrap');
        var table = h(doc, 'table', 'viz-table');
        var thead = h(doc, 'thead');
        var tr = h(doc, 'tr');
        [t.colLabel, t.actual, t.required, t.gap].forEach(function (c, i) {
            var th = h(doc, 'th', i ? 'viz-num' : null, c);
            th.setAttribute('scope', 'col');
            tr.appendChild(th);
        });
        thead.appendChild(tr);
        table.appendChild(thead);
        var tb = h(doc, 'tbody');
        model.items.forEach(function (x) {
            var row = h(doc, 'tr');
            var th = h(doc, 'th', null, x.label);
            th.setAttribute('scope', 'row');
            row.appendChild(th);
            row.appendChild(
                h(
                    doc,
                    'td',
                    x.actual === null ? 'viz-num viz-unmeasured-cell' : 'viz-num',
                    x.actual === null ? t.unmeasured : fmt(x.actual, opts)
                )
            );
            row.appendChild(
                h(doc, 'td', 'viz-num', x.required === null ? '—' : fmt(x.required, opts))
            );
            row.appendChild(
                h(
                    doc,
                    'td',
                    x.gap === null ? 'viz-num viz-unmeasured-cell' : 'viz-num',
                    x.gap === null ? t.unmeasured : fmt(x.gap, opts)
                )
            );
            tb.appendChild(row);
        });
        table.appendChild(tb);
        wrap.appendChild(table);
        det.appendChild(wrap);
        el.appendChild(det);
        return model;
    }

    /** Draw every [data-dumbbell] block of the page from its JSON data. */
    function init(root) {
        if (!global || !global.document) return 0;
        var n = 0;
        Array.prototype.forEach.call(
            (root || global.document).querySelectorAll('[data-dumbbell]'),
            function (el) {
                if (el.__dumbbell) return;
                var block = el.querySelector('script.dumbbell-data[type="application/json"]');
                if (!block) return;
                var payload = null;
                try {
                    payload = JSON.parse(block.textContent || 'null');
                } catch (_) {
                    payload = null;
                }
                if (!payload) return;
                var host = el.querySelector('.dumbbell-body') || el;
                el.__dumbbell = render(host, payload.rows || [], payload.opts || {});
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

    return { build: build, summary: summary, render: render, init: init };
});
