/* Integrations → HRIS (/admin/integrations/hris).
 *
 * 1. CSV upload: a multipart body is parsed AFTER the global CSRF check, so the
 *    token travels in the x-csrf-token header (same contract as the skills
 *    quality import). The server answers JSON with the page of the dry run.
 * 2. Value-mapping form: the target list only offers units of the chosen kind.
 */
(function () {
    'use strict';

    var form = document.getElementById('hris-upload');
    if (form) {
        form.addEventListener('submit', function (ev) {
            ev.preventDefault();
            var msg = document.getElementById('hris-upload-msg');
            var btn = form.querySelector('button[type="submit"]');
            var data = new FormData(form);
            if (btn) btn.disabled = true;
            if (msg) msg.textContent = '…';
            fetch(form.action, {
                method: 'POST',
                body: data,
                credentials: 'same-origin',
                headers: {
                    'x-csrf-token': form.getAttribute('data-csrf') || '',
                    Accept: 'application/json',
                },
            })
                .then(function (r) {
                    return r.json().catch(function () {
                        return { ok: false, error: r.statusText };
                    });
                })
                .then(function (j) {
                    if (j && j.ok && j.redirect) {
                        window.location.href = j.redirect;
                        return;
                    }
                    if (msg) msg.textContent = (j && j.error) || '';
                    if (btn) btn.disabled = false;
                })
                .catch(function (e) {
                    if (msg) msg.textContent = String((e && e.message) || e);
                    if (btn) btn.disabled = false;
                });
        });
    }

    var kind = document.getElementById('hris-map-kind');
    var target = document.getElementById('hris-map-target');
    if (kind && target) {
        var sync = function () {
            var k = kind.value;
            Array.prototype.forEach.call(target.querySelectorAll('optgroup'), function (g) {
                var match = false;
                Array.prototype.forEach.call(g.querySelectorAll('option'), function (o) {
                    var on = o.getAttribute('data-kind') === k;
                    o.hidden = !on;
                    o.disabled = !on;
                    if (on) match = true;
                });
                g.hidden = !match;
            });
            var sel = target.options[target.selectedIndex];
            if (sel && sel.getAttribute('data-kind') && sel.getAttribute('data-kind') !== k)
                target.value = '';
        };
        kind.addEventListener('change', sync);
        sync();
    }
})();
