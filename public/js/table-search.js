'use strict';
/**
 * Shared list search & filter toolkit. Loaded on every page (main layout);
 * no-ops unless a page opts in with data attributes:
 *
 *   <input data-table-search="#myTable">        — debounced, accent- and
 *       case-insensitive text search over each row's text (tbody > tr).
 *       The selector may list SEVERAL tables ("#t1, #t2") — e.g. one search
 *       box covering every tab of a tabbed page. Elements marked
 *       <span data-ts-count="#t1"> (e.g. inside a tab button) show that
 *       table's live match count while a search is active.
 *   <select data-table-filter="#myTable" data-filter-col="3">
 *       — filters rows to those whose (optional) column or whole text contains
 *       the selected value ('' = all). Combines with the search input.
 *   <select data-searchable>                     — augments a long <select>
 *       with a type-to-filter box (for 1000-option skill/employee pickers).
 *
 * Rows hidden get [data-ts-hidden]; an auto "no results" row appears when all
 * rows are hidden. Multiple tables per page are independent.
 */
(function () {
    var fold = function (s) {
        return String(s || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '');
    };
    var debounce = function (fn, ms) {
        var t;
        return function () {
            var a = arguments,
                c = this;
            clearTimeout(t);
            t = setTimeout(function () {
                fn.apply(c, a);
            }, ms);
        };
    };

    // ---- table search / filter ------------------------------------------------
    var states = new Map(); // table el -> {query, filters:[{sel, col}]}

    function ensureState(table) {
        if (!states.has(table)) states.set(table, { query: '', filters: [] });
        return states.get(table);
    }

    function apply(table) {
        var st = ensureState(table);
        var body = table.tBodies[0];
        if (!body) return;
        var rows = Array.prototype.slice.call(body.rows).filter(function (r) {
            return !r.hasAttribute('data-ts-noresults');
        });
        var visible = 0;
        rows.forEach(function (row) {
            // group/separator rows (site headers etc.) stay visible
            if (row.hasAttribute('data-ts-skip') || row.classList.contains('empty-row')) return;
            var ok = true;
            if (st.query)
                ok =
                    fold(row.getAttribute('data-search') || row.textContent).indexOf(st.query) !==
                    -1;
            if (ok) {
                for (var i = 0; i < st.filters.length; i++) {
                    var f = st.filters[i];
                    var val = fold(f.sel.value);
                    if (!val) continue;
                    var hay =
                        f.col != null && row.cells[f.col]
                            ? fold(row.cells[f.col].textContent)
                            : fold(row.getAttribute('data-search') || row.textContent);
                    if (hay.indexOf(val) === -1) {
                        ok = false;
                        break;
                    }
                }
            }
            row.toggleAttribute('data-ts-hidden', !ok);
            row.style.display = ok ? '' : 'none';
            if (ok) visible++;
        });
        // live match-count badge(s) for this table (e.g. on a tab button)
        var active =
            st.query ||
            st.filters.some(function (f) {
                return f.sel.value;
            });
        if (table.id) {
            document
                .querySelectorAll('[data-ts-count="#' + table.id + '"]')
                .forEach(function (badge) {
                    badge.textContent = active ? ' (' + visible + ')' : '';
                });
        }
        // auto empty-state row
        var empty = body.querySelector('[data-ts-noresults]');
        if (!visible && active && rows.length) {
            if (!empty) {
                empty = document.createElement('tr');
                empty.setAttribute('data-ts-noresults', '');
                var td = document.createElement('td');
                td.colSpan =
                    table.tHead && table.tHead.rows[0] ? table.tHead.rows[0].cells.length : 6;
                td.style.cssText = 'text-align:center;padding:1.5rem;color:var(--text-muted,#888);';
                td.textContent =
                    document.documentElement.lang === 'fr'
                        ? 'Aucun résultat — modifiez la recherche ou les filtres.'
                        : 'No results — adjust the search or filters.';
                empty.appendChild(td);
                body.appendChild(empty);
            }
            empty.style.display = '';
        } else if (empty) {
            empty.style.display = 'none';
        }
    }

    document.querySelectorAll('[data-table-search]').forEach(function (input) {
        // May target several tables (comma-separated) — one search box for a
        // whole tabbed module: every tab's table filters at once, and the
        // [data-ts-count] badges tell the user where the matches are.
        var tables = Array.prototype.slice
            .call(document.querySelectorAll(input.getAttribute('data-table-search')))
            .filter(function (t) {
                return t.tagName === 'TABLE';
            });
        if (!tables.length) return;
        tables.forEach(ensureState);
        input.addEventListener(
            'input',
            debounce(function () {
                var q = fold(input.value.trim());
                tables.forEach(function (table) {
                    states.get(table).query = q;
                    apply(table);
                });
            }, 180)
        );
    });

    document.querySelectorAll('[data-table-filter]').forEach(function (sel) {
        var tables = Array.prototype.slice
            .call(document.querySelectorAll(sel.getAttribute('data-table-filter')))
            .filter(function (t) {
                return t.tagName === 'TABLE';
            });
        if (!tables.length) return;
        var colAttr = sel.getAttribute('data-filter-col');
        tables.forEach(function (table) {
            ensureState(table).filters.push({
                sel: sel,
                col: colAttr != null && colAttr !== '' ? Number(colAttr) : null,
            });
        });
        sel.addEventListener('change', function () {
            tables.forEach(apply);
        });
    });

    // ---- double-submit guard --------------------------------------------------
    // On a normal (non-AJAX) form submit, disable the submit button and show a
    // brief "…" so an impatient double-click can't create duplicate records
    // (duplicate IDP/PIP/plan/dispute). Opt out with data-no-submit-guard.
    //
    // The busy wording follows the page's own language. No catalogue lookup is
    // available in this file, so it reads the document language — the same rule
    // the searchable-select placeholder below already uses — rather than
    // hard-coding English onto a French page.
    function BUSY_LABEL() {
        return document.documentElement.lang === 'fr' ? 'Envoi en cours…' : 'Submitting…';
    }
    document.addEventListener(
        'submit',
        function (e) {
            var form = e.target;
            if (!(form instanceof HTMLFormElement)) return;
            if (e.defaultPrevented) return; // a confirm dialog (data-confirm) holds the submit
            if (form.hasAttribute('data-no-submit-guard')) return;
            if (form.getAttribute('onsubmit')) return; // form manages its own submit
            var btn = form.querySelector(
                'button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])'
            );
            if (!btn) return;
            // Let the submit proceed this tick, then lock the button. A 6s failsafe
            // re-enables it so a validation bounce-back isn't permanently stuck.
            setTimeout(function () {
                if (btn.disabled) return;
                btn.dataset.tsLabel = btn.tagName === 'INPUT' ? btn.value : btn.innerHTML;
                btn.disabled = true;
                btn.classList.add('is-submitting');
                // SAY that it is working. The spinner that replaces the label is
                // aria-hidden, so a screen-reader user heard the button lose its
                // name and fall silent — the one moment they most need to know
                // something is in flight. aria-busy marks the form, and the
                // button keeps an accessible name of its own.
                form.setAttribute('aria-busy', 'true');
                btn.setAttribute('aria-label', BUSY_LABEL());
                if (btn.tagName === 'INPUT') btn.value = '…';
                else btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>';
                setTimeout(function () {
                    if (!btn.dataset.tsLabel) return;
                    btn.disabled = false;
                    btn.classList.remove('is-submitting');
                    form.removeAttribute('aria-busy');
                    btn.removeAttribute('aria-label');
                    if (btn.tagName === 'INPUT') btn.value = btn.dataset.tsLabel;
                    else btn.innerHTML = btn.dataset.tsLabel;
                    delete btn.dataset.tsLabel;
                }, 6000);
            }, 0);
        },
        true
    );

    // ---- searchable <select> (long option lists) ------------------------------
    document.querySelectorAll('select[data-searchable]').forEach(function (select) {
        if (select.options.length < 15) return; // short lists don't need it
        var box = document.createElement('input');
        box.type = 'search';
        box.className = select.className || 'form-control';
        box.placeholder =
            document.documentElement.lang === 'fr'
                ? 'Taper pour filtrer les options…'
                : 'Type to filter options…';
        box.setAttribute('aria-label', box.placeholder);
        box.style.marginBottom = '4px';
        select.parentNode.insertBefore(box, select);
        var all = Array.prototype.map.call(select.options, function (o) {
            return { el: o, text: fold(o.textContent) };
        });
        box.addEventListener(
            'input',
            debounce(function () {
                var q = fold(box.value.trim());
                var firstMatch = null,
                    matches = 0;
                all.forEach(function (o) {
                    var show = !q || o.text.indexOf(q) !== -1 || o.el.value === '';
                    o.el.hidden = !show;
                    o.el.disabled = !show; // Safari ignores hidden options
                    if (show && o.el.value !== '' && !firstMatch) firstMatch = o.el;
                    if (show && o.el.value !== '') matches++;
                });
                // If the current selection was filtered out, jump to the first match
                var cur = select.selectedOptions[0];
                if (q && cur && cur.hidden && firstMatch) select.value = firstMatch.value;
                if (q && matches >= 1 && select.size <= 1) select.size = Math.min(8, matches + 1);
                if (!q) select.size = 1;
            }, 150)
        );
        box.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                select.focus();
            }
        });
        select.addEventListener('change', function () {
            select.size = 1;
        });
    });
})();
