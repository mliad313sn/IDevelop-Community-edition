/**
 * framework-library.js — skills library screen (/framework/library).
 *
 * 1. ESCO upload: a multipart body is parsed AFTER the global CSRF check, so
 *    the token travels in the x-csrf-token header (the check still runs and
 *    fails closed). The server answers JSON; the message is written as TEXT
 *    into a role=status region, then the page moves to the group selection.
 * 2. Group selection: a pillar box ticks or clears its sub-groups, and a live
 *    line tells how many skills are selected against the per-import cap.
 */
(function () {
    'use strict';
    var t = {};
    try {
        t = JSON.parse((document.getElementById('libI18n') || {}).textContent || '{}') || {};
    } catch (_) {
        t = {};
    }
    var fmt = function (s, vars) {
        return String(s || '').replace(/%(\w+)%/g, function (_, k) {
            return vars && vars[k] != null ? String(vars[k]) : '';
        });
    };

    var form = document.getElementById('libEscoUpload');
    if (form) {
        var status = document.getElementById('libEscoStatus');
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var input = form.querySelector('input[type="file"]');
            if (!input || !input.files || !input.files.length) {
                if (status) status.textContent = t.noFile || '';
                return;
            }
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
                    if (res.ok && res.j.ok && /^\/framework\/library/.test(res.j.redirect || ''))
                        setTimeout(function () {
                            location.assign(res.j.redirect);
                        }, 800);
                })
                .catch(function () {
                    if (status) status.textContent = t.failed || '';
                })
                .then(function () {
                    if (btn) btn.disabled = false;
                });
        });
    }

    var groups = document.getElementById('libEscoGroups');
    if (groups) {
        var counter = document.getElementById('libEscoCount');
        var limitInput = document.getElementById('libEscoLimit');
        var subs = function (pillar) {
            return groups.querySelectorAll('input[data-pillar="' + pillar + '"]');
        };
        var refresh = function () {
            var n = 0;
            groups.querySelectorAll('input[name="groups"]').forEach(function (b) {
                if (b.checked) n += Number(b.getAttribute('data-count')) || 0;
            });
            groups.querySelectorAll('input[data-pillar-all]').forEach(function (all) {
                var list = subs(all.getAttribute('data-pillar-all'));
                var on = 0;
                list.forEach(function (b) {
                    if (b.checked) on += 1;
                });
                all.checked = on > 0 && on === list.length;
                all.indeterminate = on > 0 && on < list.length;
            });
            if (counter) {
                var cap = Number(limitInput && limitInput.value) || 0;
                counter.textContent = fmt(n > cap && cap > 0 ? t.countOver : t.count, {
                    n: n,
                    cap: cap,
                });
            }
        };
        groups.addEventListener('change', function (e) {
            var el = e.target;
            if (el && el.hasAttribute('data-pillar-all')) {
                subs(el.getAttribute('data-pillar-all')).forEach(function (b) {
                    b.checked = el.checked;
                });
            }
            refresh();
        });
        if (limitInput) limitInput.addEventListener('input', refresh);
        refresh();
    }
})();
