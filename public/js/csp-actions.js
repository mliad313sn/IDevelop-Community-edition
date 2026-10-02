/**
 * csp-actions.js — declarative event wiring so pages need no inline on*= handlers
 * (the CSP drops script-src-attr 'unsafe-inline').
 *
 * One delegated listener per event type on document, so it also works for HTML
 * inserted later by page scripts.
 *
 *   <button data-on-click="hideModal" data-args='["editModal"]'>
 *   <select data-on-change="RB.setGroup" data-args='["$value"]'>
 *   <input  data-on-keydown="CAP.onKey" data-args='["$event"]'>
 *
 * - data-on-<type>: a function path on window ("fn" or "NS.fn"; own properties only).
 * - data-args: JSON array. Tokens "$el", "$event", "$value", "$checked" are replaced by
 *   the element, the event, element.value, element.checked. Default args: [$event].
 * - `NS.fn` runs with `this` = NS (like the old inline call); a plain global runs
 *   with `this` = the element. Returning false prevents the default
 *   action (same as `return fn()` in the old inline handler).
 * Types: click, change, input, keydown, keyup, submit, focusin, focusout.
 *
 * Common idioms, no page script needed:
 *   data-submit-on-change            → submits the element's form on change
 *   data-remove-parent               → removes the parent element on click
 *   <link data-async-css media=print> → switched to media="all" once loaded
 */
(function () {
    'use strict';
    var TYPES = ['click', 'change', 'input', 'keydown', 'keyup', 'submit', 'focusin', 'focusout'];
    var FORBIDDEN = { __proto__: 1, prototype: 1, constructor: 1 };
    var hasOwn = Object.prototype.hasOwnProperty;

    function resolve(path) {
        if (typeof path !== 'string' || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(path)) {
            return null;
        }
        var parts = path.split('.');
        var ctx = window;
        var owner = window;
        for (var i = 0; i < parts.length; i++) {
            var k = parts[i];
            if (FORBIDDEN[k] === 1 || ctx == null) return null;
            // window globals declared with `function x(){}` or `var` are own properties of
            // window; namespace members must be own properties of their object.
            if (!(k in Object(ctx)) || (ctx !== window && !hasOwn.call(ctx, k))) return null;
            owner = ctx;
            ctx = ctx[k];
        }
        return typeof ctx === 'function' ? { fn: ctx, owner: owner } : null;
    }

    function buildArgs(el, ev) {
        var raw = el.getAttribute('data-args');
        var args;
        if (raw == null || raw === '') {
            args = ['$event'];
        } else {
            try {
                args = JSON.parse(raw);
            } catch (e) {
                return null;
            }
            if (!Array.isArray(args)) args = [args];
        }
        return args.map(function (a) {
            if (a === '$el') return el;
            if (a === '$event') return ev;
            if (a === '$value') return el.value;
            if (a === '$checked') return el.checked;
            return a;
        });
    }

    function handle(type, ev) {
        var attr = 'data-on-' + type;
        var node = ev.target;
        // Walk up like inline handlers bubble: each matching ancestor fires once.
        while (node && node !== document && node.nodeType === 1) {
            if (node.hasAttribute(attr)) {
                var name = node.getAttribute(attr);
                var hit = resolve(name);
                if (!hit) {
                    if (window.console) console.warn('[csp-actions] no handler', name);
                } else {
                    var args = buildArgs(node, ev);
                    if (args) {
                        // `NS.fn` keeps `this` = NS, as the old inline `NS.fn()` did;
                        // a plain global gets the element (use "$el" to pass it).
                        var out = hit.fn.apply(hit.owner !== window ? hit.owner : node, args);
                        if (out === false) {
                            ev.preventDefault();
                            ev.stopPropagation();
                            return;
                        }
                    }
                }
                if (ev.cancelBubble) return;
            }
            node = node.parentNode;
        }
    }

    TYPES.forEach(function (type) {
        document.addEventListener(type, function (ev) {
            handle(type, ev);
        });
    });

    document.addEventListener('change', function (ev) {
        var el = ev.target;
        if (el && el.hasAttribute && el.hasAttribute('data-submit-on-change') && el.form) {
            el.form.submit();
        }
    });
    document.addEventListener('click', function (ev) {
        var el = ev.target && ev.target.closest && ev.target.closest('[data-remove-parent]');
        if (el && el.parentElement) el.parentElement.remove();
    });

    function asyncCss() {
        var links = document.querySelectorAll('link[data-async-css]');
        for (var i = 0; i < links.length; i++) {
            (function (l) {
                if (l.sheet) l.media = 'all';
                else
                    l.addEventListener('load', function () {
                        l.media = 'all';
                    });
            })(links[i]);
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', asyncCss);
    else asyncCss();

    // Exposed for tests only.
    window.__cspActions = { resolve: resolve, buildArgs: buildArgs, handle: handle };
})();
