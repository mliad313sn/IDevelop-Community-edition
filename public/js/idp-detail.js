/* eslint-env browser */
/**
 * idp-detail.js — the Print button of a development plan prints it (with the
 * signature block idp.css shows on paper only). CSP: no inline handler; the
 * listener is attached here.
 */
(function () {
    'use strict';
    document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-print]') : null;
        // csp-actions.js prints [data-print] too: whichever runs first prints once.
        if (!btn || e.defaultPrevented) return;
        e.preventDefault();
        window.print();
    });
})();
