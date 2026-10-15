/* eslint-env browser */
/**
 * dashboard-tabs.js — the context tabs of the dashboard, loaded on demand.
 *
 * Without JavaScript every tab is a plain link (/dashboard?tab=…) and the page
 * renders the chosen tab on the server. With it:
 *   - a click (or Enter / Space) selects the tab, shows its panel and, the
 *     first time, fetches the panel from /dashboard/panel?tab=… (same scope,
 *     same gates as the page); aria-busy while it loads;
 *   - the arrow keys, Home and End move the selection along the tab list;
 *   - the phone « Section » select does the same;
 *   - the address is replaced (?tab=…) so a reload or a shared link opens the
 *     same tab; the scope stays in the address;
 *   - a fetched panel that draws a chart loads the chart scripts it needs
 *     (fixed same-origin paths) and initialises its charts and heatmaps.
 * The fetched HTML is parsed by DOMParser (scripts inert) and its nodes are
 * moved into the panel; no text of the page is ever re-read as HTML.
 */
(function () {
    'use strict';
    var root = document.getElementById('ds-explore');
    if (!root) return;
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    var select = document.getElementById('ds-tab-select');
    var live = document.getElementById('ds-panel-live');
    var errorBox = document.getElementById('ds-panel-error');
    var i18n = {};
    try {
        var node = document.getElementById('ds-i18n');
        i18n = node ? JSON.parse(node.textContent || '{}') : {};
    } catch (_) {
        i18n = {};
    }
    var src = root.getAttribute('data-panel-src') || '/dashboard/panel';
    if (src.charAt(0) !== '/' || src.charAt(1) === '/') src = '/dashboard/panel';

    // the chart scripts a fetched panel may need, in their load order
    var CHART_SCRIPTS = ['/vendor/chart.umd.min.js', '/js/viz.js', '/js/profile-radar.js'];
    var loading = null;
    function loadScript(path) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = path;
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }
    function ensureCharts() {
        if (window.Viz && window.Chart) return Promise.resolve();
        if (!loading) {
            loading = CHART_SCRIPTS.reduce(function (p, path) {
                if (path === '/js/viz.js' && window.Viz) return p;
                if (path === '/vendor/chart.umd.min.js' && window.Chart) return p;
                return p.then(function () {
                    return loadScript(path);
                });
            }, Promise.resolve());
        }
        return loading;
    }
    function initPanel(panel) {
        var needsChart = !!panel.querySelector('[data-viz-chart]');
        var done = function () {
            if (window.Viz && typeof window.Viz.init === 'function') window.Viz.init(panel);
            if (window.VizHeat && typeof window.VizHeat.init === 'function')
                window.VizHeat.init(panel);
        };
        if (needsChart) ensureCharts().then(done, done);
        else done();
    }

    function panelOf(tab) {
        return document.getElementById(tab.getAttribute('aria-controls'));
    }
    function idOf(tab) {
        return tab.getAttribute('data-tab');
    }
    function setAddress(id) {
        try {
            var url = new URL(window.location.href);
            url.searchParams.set('tab', id);
            url.searchParams.delete('print');
            window.history.replaceState(null, '', url.pathname + url.search);
        } catch (_) {
            /* an old browser keeps the address */
        }
    }
    function load(tab) {
        var panel = panelOf(tab);
        if (!panel || panel.getAttribute('data-loaded') === '1') return;
        panel.setAttribute('aria-busy', 'true');
        if (live && i18n.loading) live.textContent = i18n.loading;
        if (errorBox) errorBox.hidden = true;
        var url =
            src + (src.indexOf('?') >= 0 ? '&' : '?') + 'tab=' + encodeURIComponent(idOf(tab));
        fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' } })
            .then(function (r) {
                if (!r.ok) throw new Error('panel ' + r.status);
                return r.text();
            })
            .then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var frag = document.createDocumentFragment();
                Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) {
                    frag.appendChild(document.adoptNode(n));
                });
                panel.appendChild(frag);
                panel.setAttribute('data-loaded', '1');
                panel.removeAttribute('aria-busy');
                if (live) live.textContent = '';
                initPanel(panel);
            })
            .catch(function () {
                panel.removeAttribute('aria-busy');
                if (errorBox) errorBox.hidden = false;
                if (live && i18n.failed) live.textContent = i18n.failed;
            });
    }
    function activate(tab, focusHeading) {
        tabs.forEach(function (t) {
            var on = t === tab;
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
            var p = panelOf(t);
            if (p) p.hidden = !on;
        });
        if (select) select.value = idOf(tab);
        setAddress(idOf(tab));
        load(tab);
        if (focusHeading) {
            var h = panelOf(tab) && panelOf(tab).querySelector('h2');
            if (h) h.focus();
        }
    }

    tabs.forEach(function (tab, i) {
        tab.addEventListener('click', function (e) {
            e.preventDefault();
            activate(tab, true);
        });
        tab.addEventListener('keydown', function (e) {
            var next = null;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
                next = tabs[(i - 1 + tabs.length) % tabs.length];
            else if (e.key === 'Home') next = tabs[0];
            else if (e.key === 'End') next = tabs[tabs.length - 1];
            else if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                activate(tab, true);
                return;
            }
            if (next) {
                e.preventDefault();
                activate(next, false);
                next.focus();
            }
        });
    });
    if (select)
        select.addEventListener('change', function () {
            var t = tabs.filter(function (x) {
                return idOf(x) === select.value;
            })[0];
            if (t) activate(t, true);
        });
})();
