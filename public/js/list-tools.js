'use strict';
/**
 * list-tools.js — the client half of the shared list toolkit. Loaded on
 * every page; no-ops unless a page opts in:
 *
 *   <th class="sortable">                 — client-side column sort: the header becomes
 *       a keyboard-reachable <button> carrying aria-sort. Rows marked [data-ts-skip],
 *       .site-separator, .empty-row or [data-ts-noresults] are never moved and never
 *       compared. Rows between two
 *       separators sort WITHIN their group. A cell may carry data-sort-value.
 *   <th class="sortable"><a href="?sort=…"> — server-side sort: the view renders the
 *       link (utils/listTools.sortLinks) with aria-sort; nothing to do here.
 *   <form method="GET" data-filter-memory> — remembers the last query string per
 *       route (localStorage `filters:<pathname>`, without `page`) and applies it when
 *       the page is opened WITHOUT a query string; adds a "Réinitialiser" link
 *       (label from window.__UIF_I18N__.resetFilters). `?reset=1` clears the memory.
 *   <select data-per-page> / [data-auto-submit] — submits the enclosing GET form on
 *       change (page reset to 1) — CSP-clean replacement for onchange="this.form.submit".
 */
(function () {
    var SKIP = '[data-ts-skip], .site-separator, .empty-row, [data-ts-noresults]';
    var L = window.__UIF_I18N__ || {};

    // ---- client-side column sort --------------------------------------------
    function cellKey(row, idx) {
        var cell = row.cells[idx];
        if (!cell) return '';
        var v = cell.getAttribute('data-sort-value');
        return (v != null ? v : cell.textContent).trim();
    }
    function sortTable(table, th, dir) {
        var body = table.tBodies[0];
        if (!body) return;
        var idx = Array.prototype.indexOf.call(th.parentElement.children, th);
        var all = Array.prototype.slice.call(body.rows);
        // Split into groups: a separator row starts a new group and stays in place.
        var groups = [],
            cur = { sep: null, rows: [] };
        all.forEach(function (r) {
            if (r.matches(SKIP)) {
                groups.push(cur);
                cur = { sep: r, rows: [] };
            } else cur.rows.push(r);
        });
        groups.push(cur);
        var cmp = function (a, b) {
            var c = cellKey(a, idx).localeCompare(
                cellKey(b, idx),
                document.documentElement.lang || undefined,
                { numeric: true, sensitivity: 'base' }
            );
            return dir === 'desc' ? -c : c;
        };
        groups.forEach(function (g) {
            g.rows.sort(cmp);
            if (g.sep) body.appendChild(g.sep);
            g.rows.forEach(function (r) {
                body.appendChild(r);
            });
        });
        Array.prototype.forEach.call(
            table.tHead ? table.tHead.querySelectorAll('th') : [],
            function (h) {
                h.classList.remove('sort-asc', 'sort-desc');
                if (h.hasAttribute('aria-sort')) h.setAttribute('aria-sort', 'none');
            }
        );
        th.classList.add(dir === 'desc' ? 'sort-desc' : 'sort-asc');
        th.setAttribute('aria-sort', dir === 'desc' ? 'descending' : 'ascending');
    }
    document.querySelectorAll('table th.sortable').forEach(function (th) {
        if (th.querySelector('a[href]')) {
            // server-side sort link: already accessible
            if (!th.hasAttribute('aria-sort')) th.setAttribute('aria-sort', 'none');
            return;
        }
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'th-sort';
        btn.setAttribute('aria-label', (L.sortBy || 'Trier par') + ' ' + th.textContent.trim());
        while (th.firstChild) btn.appendChild(th.firstChild);
        th.appendChild(btn);
        th.setAttribute('aria-sort', 'none');
        btn.addEventListener('click', function () {
            var table = th.closest('table');
            var dir = th.classList.contains('sort-asc') ? 'desc' : 'asc';
            sortTable(table, th, dir);
        });
    });

    // ---- filter memory --------------------------------------------------------
    var path = location.pathname;
    var KEY = 'filters:' + path;
    function stripPage(search) {
        var qs = new URLSearchParams(search);
        qs.delete('page');
        qs.delete('reset');
        var s = qs.toString();
        return s ? '?' + s : '';
    }
    document.querySelectorAll('form[data-filter-memory]').forEach(function (form) {
        if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') return;
        try {
            var qs = new URLSearchParams(location.search);
            if (qs.get('reset') === '1') {
                localStorage.removeItem(KEY);
                history.replaceState(null, '', path);
            } else if (!location.search) {
                var saved = localStorage.getItem(KEY);
                // One attempt per navigation, so a server that redirects back to the
                // bare path can never loop.
                var tried = sessionStorage.getItem('filters:tried:' + path);
                sessionStorage.removeItem('filters:tried:' + path);
                if (saved && saved !== '?' && !tried) {
                    sessionStorage.setItem('filters:tried:' + path, '1');
                    location.replace(path + saved);
                    return;
                }
            } else {
                var s = stripPage(location.search);
                if (s) localStorage.setItem(KEY, s);
                else localStorage.removeItem(KEY);
            }
        } catch (e) {
            /* storage unavailable: filters simply are not remembered */
        }
        // "Réinitialiser" — next to the submit button (or at the end of the form).
        var reset = document.createElement('a');
        reset.href = path + '?reset=1';
        reset.className = 'btn btn-secondary btn-sm list-reset';
        reset.textContent = L.resetFilters || 'Réinitialiser';
        var submit = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submit && submit.parentNode) submit.parentNode.insertBefore(reset, submit.nextSibling);
        else form.appendChild(reset);
    });

    // ---- per-page selector / auto-submit selects -------------------------------
    document.addEventListener('change', function (e) {
        var el = e.target;
        if (!el || !el.matches || !el.matches('select[data-per-page], [data-auto-submit]')) return;
        var form = el.closest('form');
        if (form) {
            var page = form.querySelector('input[name="page"]');
            if (page) page.value = '1';
            form.submit();
            return;
        }
        var qs = new URLSearchParams(location.search);
        qs.set(el.name || 'perPage', el.value);
        qs.delete('page');
        location.href = path + '?' + qs.toString();
    });
})();
