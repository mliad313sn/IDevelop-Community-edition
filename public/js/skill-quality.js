/**
 * skill-quality.js — « Qualité du référentiel » (3.23.21, D13): the Excel import
 * of skill texts. A multipart body is parsed AFTER the global CSRF check, so the
 * token travels in the x-csrf-token header (the check still runs and fails
 * closed). The server answers JSON; the result is written as TEXT into a
 * role=status region, then the page reloads to show the new counts.
 */
(function () {
    'use strict';
    var form = document.getElementById('sqImportForm');
    if (!form) return;
    var status = document.getElementById('sqImportStatus');
    var t = {};
    try {
        t = JSON.parse((document.getElementById('sqI18n') || {}).textContent || '{}') || {};
    } catch (_) {
        t = {};
    }
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(form);
        var btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        if (status) status.textContent = t.sending || '';
        fetch(form.getAttribute('action'), {
            method: 'POST',
            headers: { 'x-csrf-token': form.getAttribute('data-csrf') || '' },
            body: fd,
            credentials: 'same-origin',
            redirect: 'error',
        })
            .then(function (r) {
                return r.json().then(
                    function (j) {
                        return { ok: r.ok, j: j || {} };
                    },
                    function () {
                        return { ok: false, j: {} };
                    }
                );
            })
            .then(function (res) {
                if (status) status.textContent = res.j.message || t.failed || '';
                if (res.ok && res.j.ok)
                    setTimeout(function () {
                        location.reload();
                    }, 2500);
            })
            .catch(function () {
                if (status) status.textContent = t.failed || '';
            })
            .then(function () {
                if (btn) btn.disabled = false;
            });
    });
})();
