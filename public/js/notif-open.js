/*
 * notif-open.js — the "opened" beacon of a notification link.
 *
 * GET /notifications/:id/go changes nothing (mail-security scanners follow
 * every link of a message). It redirects here with the notification ids in
 * the URL fragment (`#nopen=12,13` or `#anchor&nopen=12`), which a browser
 * never sends to a server. This script runs in the owner's own signed-in
 * page: it posts the ids to /notifications/opened (same origin; main.js adds
 * the x-csrf-token header too) and restores the fragment (`#anchor`, or none).
 * CSP: an external file, no inline script.
 */
(function () {
    'use strict';
    var h = String(window.location.hash || '');
    if (h.length > 700) return;
    var at = h.lastIndexOf('nopen=');
    if (at < 1) return;
    var sep = h.charAt(at - 1);
    if (sep !== '#' && sep !== '&') return;
    var list = h.slice(at + 6);
    var ids = list.split(',').filter(function (x) {
        if (!x || x.length > 12) return false;
        for (var i = 0; i < x.length; i++) {
            var c = x.charCodeAt(i);
            if (c < 48 || c > 57) return false;
        }
        return true;
    });
    var anchor = sep === '&' ? h.slice(1, at - 1) : '';
    try {
        var url = window.location.pathname + window.location.search + (anchor ? '#' + anchor : '');
        window.history.replaceState(window.history.state, '', url);
        if (anchor) {
            var el = document.getElementById(anchor);
            if (el && el.scrollIntoView) el.scrollIntoView();
        }
    } catch (_) {
        /* the address stays as it is */
    }
    if (!ids.length || typeof window.fetch !== 'function') return;
    var meta = document.querySelector('meta[name="csrf-token"]');
    var headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (meta && meta.getAttribute('content'))
        headers['x-csrf-token'] = meta.getAttribute('content');
    window
        .fetch('/notifications/opened', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ ids: ids.slice(0, 51).join(',') }),
        })
        .catch(function () {
            /* best-effort: the bell still shows the item as unread */
        });
})();
