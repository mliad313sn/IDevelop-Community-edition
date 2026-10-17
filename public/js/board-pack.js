/* eslint-env browser */
/**
 * board-pack.js — the Print button of the board pack prints (CSP: no inline
 * handler; the listener is attached here).
 */
(function () {
    'use strict';
    document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-print]') : null;
        if (!btn) return;
        e.preventDefault();
        window.print();
    });
})();
