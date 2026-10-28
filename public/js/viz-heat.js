/* eslint-env browser */
/**
 * viz-heat.js — the keyboard, tooltip and phone behaviour of the heatmap
 * component (views/partials/viz/heat.ejs). The grid is complete without it:
 * this script only adds behaviour. CSP-safe: no inline handler, one set of
 * document-level listeners, so it also serves a heatmap added later.
 *
 *   - ONE tab stop per grid (roving tabindex): the arrow keys move one cell,
 *     Home / End go to the row ends, Ctrl+Home / Ctrl+End to the corners,
 *     PageUp / PageDown to the first / last row; Enter or Space follows the
 *     cell's link (an aggregate page), when it has one;
 *   - the tooltip shows on focus and on hover (120 ms), Escape hides it; it is
 *     text, set with textContent;
 *   - phone: « Show the full grid » opens the scrollable grid;
 *   - a row whose sub-rows are folded opens and closes with its button.
 * Loaded once per page (guarded): a page may include the tag twice.
 */
(function () {
    'use strict';
    if (window.__vizHeat) return;
    window.__vizHeat = true;

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var hoverTimer = null;

    function figureOf(el) {
        return el && el.closest ? el.closest('figure.vh') : null;
    }
    function gridOf(el) {
        return el && el.closest ? el.closest('table.vh-grid') : null;
    }
    function isCell(el) {
        return !!(el && el.getAttribute && el.getAttribute('role') === 'gridcell' && gridOf(el));
    }
    /** The VISIBLE rows of a grid, every body in order (a folded body is skipped). */
    function cellsOf(grid) {
        var out = [];
        Array.prototype.forEach.call(grid.tBodies, function (tb) {
            if (tb.hidden) return;
            Array.prototype.forEach.call(tb.rows, function (tr) {
                var cells = Array.prototype.filter.call(tr.cells, function (c) {
                    return c.getAttribute('role') === 'gridcell';
                });
                if (cells.length) out.push(cells);
            });
        });
        return out;
    }
    function firstStop(grid) {
        return (
            grid.querySelector('tbody:not([hidden]) [role="gridcell"][data-bin]') ||
            grid.querySelector('tbody:not([hidden]) [role="gridcell"]')
        );
    }
    /** Open or close one row's sub-rows (aria-expanded + aria-controls on the button). */
    function setDisclosure(btn, open) {
        var body = document.getElementById(btn.getAttribute('aria-controls') || '');
        if (!body) return;
        body.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        var grid = gridOf(btn);
        if (!grid) return;
        var stop = grid.querySelector('[role="gridcell"][tabindex="0"]');
        if (!stop || (stop.closest('tbody') && stop.closest('tbody').hidden)) {
            if (stop) stop.setAttribute('tabindex', '-1');
            var f = firstStop(grid);
            if (f) f.setAttribute('tabindex', '0');
        }
    }
    function tipOf(fig) {
        return fig ? fig.querySelector('.vh-tip') : null;
    }
    function hideTip(fig) {
        var tip = tipOf(fig);
        if (tip) tip.hidden = true;
    }
    function showTip(cell) {
        var fig = figureOf(cell);
        var tip = tipOf(fig);
        var text = cell.getAttribute('data-tip');
        if (!tip || !text) return;
        tip.textContent = text; // text only — never markup
        tip.hidden = false;
        var fr = fig.getBoundingClientRect();
        var cr = cell.getBoundingClientRect();
        var tw = tip.offsetWidth;
        var th = tip.offsetHeight;
        var left = cr.left - fr.left + cr.width / 2 - tw / 2;
        left = Math.max(0, Math.min(left, fr.width - tw));
        var top = cr.top - fr.top - th - 8;
        if (cr.top - th - 8 < 0) top = cr.bottom - fr.top + 8; // below the cell at the top edge
        tip.style.left = Math.round(left) + 'px';
        tip.style.top = Math.round(top) + 'px';
    }
    function setActive(grid, cell, focus) {
        Array.prototype.forEach.call(
            grid.querySelectorAll('[role="gridcell"][tabindex="0"]'),
            function (c) {
                if (c !== cell) c.setAttribute('tabindex', '-1');
            }
        );
        cell.setAttribute('tabindex', '0');
        if (focus) cell.focus();
    }
    function initGrid(grid) {
        if (grid.getAttribute('data-vh-ready')) return;
        grid.setAttribute('data-vh-ready', '1');
        if (grid.querySelector('[role="gridcell"][tabindex="0"]')) return;
        var f = firstStop(grid);
        if (f) f.setAttribute('tabindex', '0');
    }
    function initAll(root) {
        Array.prototype.forEach.call(
            (root || document).querySelectorAll('table.vh-grid'),
            initGrid
        );
    }
    function move(cell, key, ctrl) {
        var grid = gridOf(cell);
        var rows = cellsOf(grid);
        var ri = -1;
        var ci = -1;
        rows.some(function (r, i) {
            var j = r.indexOf(cell);
            if (j >= 0) {
                ri = i;
                ci = j;
                return true;
            }
            return false;
        });
        if (ri < 0) return false;
        var last = rows.length - 1;
        if (key === 'ArrowRight') ci++;
        else if (key === 'ArrowLeft') ci--;
        else if (key === 'ArrowDown') ri++;
        else if (key === 'ArrowUp') ri--;
        else if (key === 'Home') {
            ci = 0;
            if (ctrl) ri = 0;
        } else if (key === 'End') {
            ci = Infinity;
            if (ctrl) ri = last;
        } else if (key === 'PageUp') ri = 0;
        else if (key === 'PageDown') ri = last;
        else return false;
        ri = Math.max(0, Math.min(last, ri));
        var row = rows[ri];
        ci = Math.max(0, Math.min(row.length - 1, ci));
        var next = row[ci];
        if (next && next !== cell) setActive(grid, next, true);
        return true;
    }
    /** The cell's own link (a server-rendered <a>, never a URL built here). */
    function follow(cell) {
        var a = cell.querySelector('a.vh-drill[href]');
        if (a) a.click();
        return !!a;
    }

    document.addEventListener('keydown', function (e) {
        var cell = e.target;
        if (!isCell(cell)) return;
        if (e.key === 'Escape') {
            hideTip(figureOf(cell));
            return;
        }
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            if (follow(cell)) e.preventDefault();
            return;
        }
        if (move(cell, e.key, e.ctrlKey || e.metaKey)) e.preventDefault();
    });
    document.addEventListener('focusin', function (e) {
        var cell = e.target;
        if (!isCell(cell)) return;
        var grid = gridOf(cell);
        initGrid(grid);
        setActive(grid, cell, false);
        showTip(cell);
    });
    document.addEventListener('focusout', function (e) {
        if (isCell(e.target)) hideTip(figureOf(e.target));
    });
    document.addEventListener('mouseover', function (e) {
        var cell =
            e.target && e.target.closest
                ? e.target.closest('table.vh-grid td[role="gridcell"]')
                : null;
        if (!cell) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(
            function () {
                showTip(cell);
            },
            reduce ? 0 : 120
        );
    });
    document.addEventListener('mouseout', function (e) {
        var cell =
            e.target && e.target.closest
                ? e.target.closest('table.vh-grid td[role="gridcell"]')
                : null;
        if (!cell) return;
        clearTimeout(hoverTimer);
        if (document.activeElement !== cell) hideTip(figureOf(cell));
    });
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var disc = t.closest('[data-vh-disc]');
        if (disc) {
            setDisclosure(disc, disc.getAttribute('aria-expanded') !== 'true');
            return;
        }
        // the capability map: open or close every pillar at once
        var all = t.closest('[data-vh-expand-all]');
        if (all) {
            var mapFig = figureOf(all);
            if (!mapFig) return;
            var openAll = all.getAttribute('aria-pressed') !== 'true';
            Array.prototype.forEach.call(mapFig.querySelectorAll('[data-vh-disc]'), function (b) {
                setDisclosure(b, openAll);
            });
            all.setAttribute('aria-pressed', openAll ? 'true' : 'false');
            var allLabel = all.getAttribute(openAll ? 'data-label-close' : 'data-label-open');
            if (allLabel) all.textContent = allLabel;
            return;
        }
        var btn = t.closest('[data-vh-showgrid]');
        if (btn) {
            var fig = figureOf(btn);
            if (!fig) return;
            var open = fig.classList.toggle('vh--grid-open');
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            var label = btn.getAttribute(open ? 'data-label-close' : 'data-label-open');
            if (label) btn.textContent = label;
            return;
        }
        // a click anywhere in a drillable cell follows its link
        if (t.closest('a.vh-drill')) return;
        var cell = t.closest('table.vh-grid td[role="gridcell"]');
        if (cell) follow(cell);
    });
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            initAll(document);
        });
    } else initAll(document);
    window.VizHeat = { init: initAll };
})();
