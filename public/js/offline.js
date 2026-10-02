// offline.html « Réessayer » button: an external script because the CSP forbids
// inline handlers (script-src-attr 'none', SA-14).
(function () {
    'use strict';
    var b = document.getElementById('offline-retry');
    if (b)
        b.addEventListener('click', function () {
            location.reload();
        });
})();
