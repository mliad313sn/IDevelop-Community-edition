// offline.html « Réessayer » button: an external script because the CSP forbids
// inline handlers (script-src-attr 'none', SA-14).
//
// An unattended screen (a tablet at a site entrance, a wall display) must come
// back by itself once the network returns: on the browser's `online` event, and
// by a quiet check every 30 seconds (a HEAD request the service worker lets
// through, since it only answers GET). A tab in the background is not probed.
(function () {
    'use strict';
    var b = document.getElementById('offline-retry');
    if (b)
        b.addEventListener('click', function () {
            location.reload();
        });
    window.addEventListener('online', function () {
        location.reload();
    });
    var PROBE_MS = 30000;
    setInterval(function () {
        if (!window.fetch || document.hidden) return;
        fetch(location.href, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
            .then(function (r) {
                if (r && r.ok) location.reload();
            })
            .catch(function () {
                /* still offline: try again at the next tick */
            });
    }, PROBE_MS);
})();
