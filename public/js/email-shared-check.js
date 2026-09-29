/**
 * Inline advisory on e-mail fields: "this address is also used by …".
 *
 * A person may hold several accounts (migration 107), so a shared address is
 * ALLOWED — the form never blocks. This script only tells the person typing,
 * before they submit, that the address already exists on other accounts, so a
 * genuine duplicate is noticed early. The server flashes the same advisory
 * after saving; this is the early copy.
 *
 * Markup: <input type="email" data-email-check [data-exclude-employee=ID] [data-exclude-admin=ID]>
 *         followed by a <small class="email-shared-note" hidden> sibling.
 */
(function () {
    'use strict';
    var inputs = document.querySelectorAll('input[type="email"][data-email-check]');
    if (!inputs.length) return;
    var T = window.EMAIL_SHARED_I18N || {};
    var timer = null;

    function noteFor(input) {
        var n = input.parentElement && input.parentElement.querySelector('.email-shared-note');
        return n;
    }

    function check(input) {
        var note = noteFor(input);
        if (!note) return;
        var email = String(input.value || '').trim();
        if (!email || email.indexOf('@') < 0) {
            note.hidden = true;
            note.textContent = '';
            return;
        }
        var qs = 'email=' + encodeURIComponent(email);
        if (input.dataset.excludeEmployee)
            qs += '&excludeEmployee=' + encodeURIComponent(input.dataset.excludeEmployee);
        if (input.dataset.excludeAdmin)
            qs += '&excludeAdmin=' + encodeURIComponent(input.dataset.excludeAdmin);
        fetch('/api/accounts/email-check?' + qs, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        })
            .then(function (r) {
                return r.ok ? r.json() : null;
            })
            .then(function (j) {
                if (!j || !j.count) {
                    note.hidden = true;
                    note.textContent = '';
                    return;
                }
                var tpl =
                    T.note ||
                    'Already used by {{who}} — allowed (a person may hold several accounts); check that this is intended.';
                note.textContent = tpl
                    .replace('{{who}}', j.who || j.count)
                    .replace('{{count}}', j.count);
                note.hidden = false;
            })
            .catch(function () {
                /* advisory only — never block the form */
            });
    }

    Array.prototype.forEach.call(inputs, function (input) {
        input.addEventListener('blur', function () {
            check(input);
        });
        input.addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                check(input);
            }, 600);
        });
        if (input.value) check(input);
    });
})();
