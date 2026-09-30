/*
 * Password strength meter (ASVS 2.1.8).
 *
 * <input type="password" data-pw-strength="meterId">
 * <div id="meterId" data-l-empty="…" data-l-weak="…" data-l-fair="…"
 *      data-l-good="…" data-l-strong="…"><meter …></meter><span></span></div>
 *
 * The labels come from the page (FR/EN locale files); this script holds no
 * text. The score follows the server's PasswordValidator.calculateStrength:
 * length first, a bonus for a multi-word passphrase, a penalty for repeats.
 * It is advice only: the server decides, including the common-password list.
 */
(function () {
    'use strict';

    function score(pw) {
        if (!pw) return 0;
        var len = Array.from(pw).length;
        var s = Math.min(70, len * 4);
        var classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(function (r) {
            return r.test(pw);
        }).length;
        s += classes * 5;
        if (/\s/.test(pw.trim()) && len >= 16) s += 10;
        s += Math.min(10, Math.floor(new Set(pw.split('')).size / 2));
        if (/(.)\1{2,}/.test(pw)) s -= 15;
        if (/(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|azer|asdf)/i.test(pw)) s -= 20;
        return Math.max(0, Math.min(100, s));
    }

    function level(s, len) {
        if (!len) return 'empty';
        if (len < 12 || s < 40) return 'weak';
        if (s < 60) return 'fair';
        if (s < 80) return 'good';
        return 'strong';
    }

    function bind(input) {
        var out = document.getElementById(input.getAttribute('data-pw-strength'));
        if (!out) return;
        var meter = out.querySelector('meter');
        var label = out.querySelector('[data-pw-strength-text]');
        function update() {
            var v = input.value || '';
            var s = score(v);
            var l = level(s, v.length);
            if (meter) meter.value = v.length ? Math.max(s, 5) : 0;
            if (label) label.textContent = out.getAttribute('data-l-' + l) || '';
            out.setAttribute('data-level', l);
        }
        input.addEventListener('input', update);
        update();
    }

    function init() {
        var inputs = document.querySelectorAll('input[data-pw-strength]');
        for (var i = 0; i < inputs.length; i++) bind(inputs[i]);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
