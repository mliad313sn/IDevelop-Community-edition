/*
 * Erasure under legal hold: the two-person override panel on the maintenance
 * page (views/partials/erase-override.ejs). Lists the pending requests,
 * submits a new request, and sends the decision (approve / refuse by another
 * SuperAdmin, withdraw by the requester). No inline handlers: everything is
 * bound here; texts come from the section's data-i18n attribute.
 */
(function () {
    'use strict';
    var root = document.getElementById('mntEraseOverride');
    if (!root) return;
    var T = {};
    try {
        T = JSON.parse(root.getAttribute('data-i18n') || '{}');
    } catch (_) {
        T = {};
    }
    var meta = document.querySelector('meta[name="csrf-token"]');
    var CSRF = meta ? meta.getAttribute('content') : '';
    var list = document.getElementById('mntEoList');
    var msg = document.getElementById('mntEoMsg');

    function fill(tpl, vars) {
        return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, k) {
            return vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m;
        });
    }
    function say(text, ok) {
        msg.textContent = text || '';
        msg.hidden = !text;
        msg.className = 'mnt-hint ' + (ok ? 'text-success' : 'text-danger');
    }
    function post(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'x-csrf-token': CSRF,
            },
            body: JSON.stringify(body),
        }).then(function (r) {
            return r.json().catch(function () {
                return {};
            });
        });
    }
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }
    function button(label, cls, action) {
        var b = el('button', 'btn btn-sm ' + cls, label);
        b.type = 'button';
        b.setAttribute('data-eo-action', action);
        return b;
    }

    function render(rows) {
        list.textContent = '';
        if (!rows || !rows.length) {
            list.appendChild(el('p', 'text-muted', T.empty || ''));
            return;
        }
        rows.forEach(function (r) {
            var box = el('div', 'mnt-eo-row');
            box.setAttribute('data-eo-id', String(r.id));
            box.appendChild(
                el(
                    'p',
                    '',
                    fill(T.row, {
                        id: r.id,
                        emp: r.employeeId,
                        by: r.requestedBy,
                        at: String(r.requestedAt || '').slice(0, 10),
                        reason: r.reason,
                    })
                )
            );
            var note = el('input', 'form-control mnt-input');
            note.setAttribute('aria-label', T.note || '');
            note.placeholder = T.note || '';
            note.maxLength = 1000;
            note.setAttribute('data-eo-note', '');
            box.appendChild(note);
            if (r.mine) box.appendChild(button(T.withdraw, 'btn-secondary', 'withdraw'));
            else {
                box.appendChild(button(T.refuse, 'btn-secondary', 'refuse'));
                box.appendChild(button(T.approve, 'btn-danger', 'approve'));
            }
            list.appendChild(box);
        });
    }

    function load() {
        fetch('/admin/maintenance/dsr-erase-overrides', { headers: { Accept: 'application/json' } })
            .then(function (r) {
                return r.json();
            })
            .then(function (j) {
                if (j && j.ok) render(j.rows);
                else say((j && j.error) || T.err, false);
            })
            .catch(function () {
                say(T.err, false);
            });
    }

    document.getElementById('mntEoForm').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var raw = (document.getElementById('mntEoEmp').value || '').trim();
        var reason = (document.getElementById('mntEoReason').value || '').trim();
        if (!reason) return say(T.needReason, false);
        post('/admin/maintenance/dsr-erase-override', {
            employeeId: parseInt(raw, 10),
            confirmNumber: (document.getElementById('mntEoNumber').value || '').trim(),
            reason: reason,
        })
            .then(function (j) {
                if (j && j.ok) {
                    say(T.requested, true);
                    ev.target.reset();
                    load();
                } else say((j && j.error) || T.err, false);
            })
            .catch(function () {
                say(T.err, false);
            });
    });

    list.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-eo-action]') : null;
        if (!b) return;
        var row = b.closest('[data-eo-id]');
        var id = row.getAttribute('data-eo-id');
        var action = b.getAttribute('data-eo-action');
        var note = (row.querySelector('[data-eo-note]').value || '').trim();
        if (action !== 'withdraw' && !note) return say(T.needReason, false);
        b.disabled = true;
        post('/admin/maintenance/dsr-erase-override/' + encodeURIComponent(id) + '/decide', {
            approve: action === 'approve',
            note: note,
        })
            .then(function (j) {
                b.disabled = false;
                if (j && j.ok) {
                    say(T['done_' + j.state] || '', true);
                    load();
                } else say((j && j.error) || T.err, false);
            })
            .catch(function () {
                b.disabled = false;
                say(T.err, false);
            });
    });

    load();
})();
