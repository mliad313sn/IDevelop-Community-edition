/**
 * ui-feedback.js — app-wide notification + dialog utilities.
 *
 * - window.toast(msg, type)              non-blocking styled toast ('success'|'error'|'info'|'warn')
 * - window.confirmDialog(msg, opts)      Promise<boolean> styled confirm
 *       opts: { title, confirmText, cancelText, danger }
 * - window.promptDialog(msg, def, opts)  Promise<string|null> styled prompt
 *       opts: { title, okText, cancelText, multiline, required, placeholder }
 *       `required` keeps OK disabled until something is typed — the "mandatory
 *       reason" every cancellation / exclusion must carry (product rule 3).
 * - <form data-confirm="…">              declarative confirm before a POST (replaces the
 *       native onsubmit="return confirm(…)"): data-confirm-title, data-confirm-yes,
 *       data-confirm-no, data-confirm-danger, and data-confirm-reason="fieldName" to
 *       collect a required reason into a hidden input before submitting.
 *
 * window.alert is transparently replaced by a toast (alert is fire-and-forget, so
 * this is safe and instantly upgrades every legacy alert call to a styled toast).
 * Labels come from window.__UIF_I18N__ (set by the layout in the session language);
 * French defaults otherwise.
 */
(function () {
    'use strict';
    if (window.__uiFeedbackLoaded) return;
    window.__uiFeedbackLoaded = true;

    // Single motion table for JavaScript timers (the CSS prefers-reduced-motion
    // blocks cannot see a setTimeout). Values mirror the CSS durations; `hold` is
    // the maximum life of a "look here" cue. A reduced-motion preference does not
    // mean "the information leaves faster" — it means "it does not leave on its
    // own": autoDismiss returns 0 (= never) under reduce. Read via window.MOTION
    // by every timer that removes information (main.js flash banners first).
    window.MOTION = (function () {
        var reduce = false;
        try {
            reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (_) {
            /* no matchMedia: treat as full motion */
        }
        return {
            reduce: reduce,
            quick: 100,
            base: 200,
            slow: 350,
            hold: 2000,
            autoDismiss: function (ms) {
                return reduce ? 0 : ms;
            } /* 0 = never */,
        };
    })();

    var css =
        '' +
        // Below the fixed top bar (48px), so a toast never covers the notification
        // bell and its counter while it talks about them.
        '.uif-toasts{position:fixed;top:calc(var(--topbar-height,48px) + 12px);right:18px;z-index:99999;display:flex;flex-direction:column;gap:10px;max-width:90vw}' +
        '.uif-toast{min-width:240px;max-width:420px;padding:12px 16px;border-radius:10px;color:#fff;font:500 14px/1.4 system-ui,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(2,32,71,.22);opacity:0;transform:translateY(-8px);transition:opacity .25s,transform .25s;display:flex;gap:10px;align-items:flex-start}' +
        '.uif-toast.show{opacity:1;transform:translateY(0)}' +
        // A real <button> (UX-07): 24x24 minimum target (WCAG 2.5.8), inherits
        // the toast colour, visible ring on keyboard focus.
        '.uif-toast .uif-x{margin-left:auto;cursor:pointer;opacity:.85;font:700 16px/1 system-ui,Segoe UI,Roboto,sans-serif;background:none;border:0;color:inherit;min-width:24px;min-height:24px;padding:0 2px;border-radius:4px}' +
        '.uif-toast .uif-x:hover{opacity:1}.uif-toast .uif-x:focus-visible{outline:2px solid #fff;outline-offset:1px;opacity:1}' +
        '.uif-success{background:#15803d}.uif-error{background:#b91c1c}.uif-info{background:#1d4ed8}.uif-warn{background:#b45309}' +
        '.uif-backdrop{position:fixed;inset:0;background:rgba(2,8,20,.55);z-index:99998;display:flex;align-items:center;justify-content:center;padding:16px}' +
        // Theme-aware surface: tokens (dark+gold / light) with light fallbacks so the
        // dialog no longer renders a jarring white box over the dark UI.
        '.uif-modal{background:var(--bg-elevated,#fff);color:var(--text-primary,#0f172a);border:1px solid var(--border-color,transparent);border-radius:14px;max-width:440px;width:100%;padding:22px 24px;box-shadow:0 20px 50px rgba(2,32,71,.45)}' +
        '.uif-modal h4{margin:0 0 10px;font-size:17px;color:var(--text-primary,#0f172a)}.uif-modal p{margin:0 0 16px;color:var(--text-secondary,#334155);font-size:14px;white-space:pre-wrap}' +
        '.uif-modal input,.uif-modal textarea,.uif-modal select{width:100%;padding:9px 12px;border:1px solid var(--border-color,#cbd5e1);background:var(--bg-input,#fff);color:var(--text-primary,#0f172a);border-radius:8px;font-size:14px;margin-bottom:16px;font-family:inherit}' +
        '.uif-modal textarea{min-height:84px;resize:vertical}' +
        '.uif-actions{display:flex;justify-content:flex-end;gap:10px}' +
        '.uif-btn{padding:8px 16px;border-radius:8px;border:0;font-size:14px;font-weight:600;cursor:pointer}' +
        '.uif-btn[disabled]{opacity:.5;cursor:not-allowed}' +
        '.uif-btn-primary{background:#2563eb;color:#fff}.uif-btn-danger{background:#b91c1c;color:#fff}.uif-btn-secondary{background:var(--bg-subtle,#e2e8f0);color:var(--text-primary,#0f172a);border:1px solid var(--border-color,transparent)}';
    var style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    function container() {
        var c = document.querySelector('.uif-toasts');
        if (!c) {
            c = document.createElement('div');
            c.className = 'uif-toasts';
            // POLITE by default. This was 'assertive' for every toast, so a
            // routine "enregistré" cut a screen-reader user off mid-sentence —
            // including in the middle of the very content they were reading to
            // decide something. Assertiveness is reserved for the error case,
            // where the individual toast carries role="alert".
            c.setAttribute('aria-live', 'polite');
            document.body.appendChild(c);
        }
        return c;
    }

    // Colour by content when the caller gave no type. FR words first (every
    // French « Erreur … » used to render as a blue "info" toast). `\b` is ASCII-only,
    // so accented words are matched without it.
    var ERR_FR =
        /(erreur|échec|echec|impossible|refus[ée]?|interdit|invalide|introuvable|expir[ée])/;
    var OK_FR =
        /(enregistr[ée]|succès|succes|termin[ée]|cré[ée]|mis[e]? à jour|approuv[ée]|envoy[ée]|réussi)/;
    function detectType(msg) {
        var m = String(msg || '').toLowerCase();
        if (
            ERR_FR.test(m) ||
            /\b(error|failed|cannot|not authorized|forbidden|invalid|denied)\b/.test(m)
        )
            return 'error';
        if (
            OK_FR.test(m) ||
            /\b(saved|success|created|updated|submitted|approved|done|completed)\b/.test(m)
        )
            return 'success';
        return 'info';
    }
    window.__uifDetectType = detectType; // exposed for tests / call sites that want the same rule

    // Caller-given types are normalised to the four styled ones, so a 'warning'
    // or 'danger' from a page no longer renders as an unstyled (white) toast.
    var TYPE_ALIAS = {
        success: 'success',
        ok: 'success',
        error: 'error',
        danger: 'error',
        info: 'info',
        warn: 'warn',
        warning: 'warn',
    };

    window.toast = function (msg, type) {
        if (msg == null) return;
        // An explicit type always wins. Wording is only a FALLBACK for callers that
        // give none (legacy alert above all), never an override (UX-07).
        type = TYPE_ALIAS[type] || detectType(msg);
        var c = container();
        var t = document.createElement('div');
        t.className = 'uif-toast uif-' + type;
        // An error interrupts; nothing else does. role="alert" carries its own
        // assertive politeness, so only this one preempts the reader.
        if (type === 'error') t.setAttribute('role', 'alert');
        var span = document.createElement('span');
        span.textContent = String(msg);
        // UX-07: the close control is a real <button> — it was a <span>, so it was
        // not in the Tab order and had no name for a screen reader.
        var x = document.createElement('button');
        x.setAttribute('type', 'button');
        x.className = 'uif-x';
        x.setAttribute('aria-label', L().close || 'Fermer');
        x.textContent = '×';
        x.onclick = function () {
            dismiss();
        };
        t.appendChild(span);
        t.appendChild(x);
        c.appendChild(t);
        requestAnimationFrame(function () {
            t.classList.add('show');
        });
        // §2.4: a timer that removes information reads the same table as the CSS.
        // Under prefers-reduced-motion autoDismiss returns 0 = never.
        // UX-07: an ERROR never leaves on its own — it used to vanish after 6 s,
        // before a slow reader (or one who looked away) had read what went wrong.
        // It stays until its close button is pressed.
        var ttl = type === 'error' ? 0 : window.MOTION.autoDismiss(3500);
        var timer = ttl ? setTimeout(dismiss, ttl) : null;
        function dismiss() {
            clearTimeout(timer);
            t.classList.remove('show');
            setTimeout(function () {
                if (t.parentNode) t.parentNode.removeChild(t);
            }, 300);
        }
        return t;
    };

    // Transparently upgrade legacy alert calls to toasts (non-blocking, safe).
    window.alert = function (msg) {
        window.toast(msg);
    };

    function modal(buildBody, resolveValue) {
        return new Promise(function (resolve) {
            var prevFocus = document.activeElement; // restore on close (WCAG 2.4.3)
            var bd = document.createElement('div');
            bd.className = 'uif-backdrop';
            var box = document.createElement('div');
            box.className = 'uif-modal';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            bd.appendChild(box);
            document.body.appendChild(bd);
            var closed = false;
            function close(v) {
                if (closed) return;
                closed = true;
                document.removeEventListener('keydown', onKey, true);
                if (bd.parentNode) bd.parentNode.removeChild(bd);
                if (prevFocus && prevFocus.focus) {
                    try {
                        prevFocus.focus();
                    } catch (e) {
                        /* gone from DOM */
                    }
                }
                resolve(v);
            }
            buildBody(box, close);
            // Label the dialog by its heading so a screen reader announces it as a dialog.
            var h = box.querySelector('h4, h3, h2');
            if (h) {
                if (!h.id) h.id = 'uif-title-' + Math.random().toString(36).slice(2);
                box.setAttribute('aria-labelledby', h.id);
            }
            function focusables() {
                return Array.prototype.slice
                    .call(
                        box.querySelectorAll(
                            'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])'
                        )
                    )
                    .filter(function (el) {
                        return el.offsetParent !== null;
                    });
            }
            function onKey(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    close(resolveValue);
                    return;
                }
                if (e.key !== 'Tab') return;
                var f = focusables();
                if (!f.length) return;
                var first = f[0],
                    last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
            document.addEventListener('keydown', onKey, true);
            bd.addEventListener('click', function (e) {
                if (e.target === bd) close(resolveValue);
            });
        });
    }

    // Labels: the layout sets window.__UIF_I18N__ in the session language; read it
    // at CALL time so a page that sets it after this script loads still wins.
    function L() {
        return window.__UIF_I18N__ || {};
    }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    window.confirmDialog = function (msg, opts) {
        opts = opts || {};
        return modal(function (box, close) {
            box.innerHTML =
                '<h4>' +
                esc(opts.title || L().confirmTitle || 'Confirmation') +
                '</h4><p></p>' +
                '<div class="uif-actions"><button type="button" class="uif-btn uif-btn-secondary" data-no>' +
                esc(opts.cancelText || L().cancel || 'Annuler') +
                '</button>' +
                '<button type="button" class="uif-btn ' +
                (opts.danger ? 'uif-btn-danger' : 'uif-btn-primary') +
                '" data-yes>' +
                esc(opts.confirmText || L().confirm || 'Confirmer') +
                '</button></div>';
            box.querySelector('p').textContent = msg;
            box.querySelector('[data-yes]').onclick = function () {
                close(true);
            };
            box.querySelector('[data-no]').onclick = function () {
                close(false);
            };
            box.querySelector('[data-yes]').focus();
        }, false);
    };

    // `opts.choices` (array of strings): ready-made reasons offered in a <select>
    // above the free-text field. The resolved value is the chosen reason, then
    // the free text on its own line — either one alone satisfies `required`.
    window.promptDialog = function (msg, def, opts) {
        opts = opts || {};
        var choices = Array.isArray(opts.choices) ? opts.choices : null;
        return modal(function (box, close) {
            box.innerHTML =
                '<h4>' +
                esc(opts.title || L().promptTitle || 'Saisie requise') +
                '</h4><p></p>' +
                (choices
                    ? '<select data-choice aria-label="' +
                      esc(opts.choicePlaceholder || '') +
                      '"><option value="">' +
                      esc(opts.choicePlaceholder || '—') +
                      '</option>' +
                      choices
                          .map(function (c) {
                              return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
                          })
                          .join('') +
                      '</select>'
                    : '') +
                (opts.multiline ? '<textarea rows="3"></textarea>' : '<input type="text">') +
                (opts.required
                    ? '<small class="uif-hint" style="display:block;margin:-10px 0 12px;opacity:.75">' +
                      esc(L().reasonRequired || 'Champ obligatoire') +
                      '</small>'
                    : '') +
                '<div class="uif-actions">' +
                '<button type="button" class="uif-btn uif-btn-secondary" data-no>' +
                esc(opts.cancelText || L().cancel || 'Annuler') +
                '</button>' +
                '<button type="button" class="uif-btn uif-btn-primary" data-yes>' +
                esc(opts.okText || L().ok || 'OK') +
                '</button></div>';
            box.querySelector('p').textContent = msg;
            var inp = box.querySelector('input, textarea');
            var sel = box.querySelector('select[data-choice]');
            inp.value = def || '';
            if (opts.placeholder) inp.placeholder = opts.placeholder;
            var yes = box.querySelector('[data-yes]');
            function value() {
                if (!sel) return inp.value;
                return [sel.value, inp.value.trim()]
                    .filter(function (x) {
                        return !!x;
                    })
                    .join('\n');
            }
            function sync() {
                yes.disabled = !!opts.required && !value().trim();
            }
            sync();
            inp.addEventListener('input', sync);
            if (sel) sel.addEventListener('change', sync);
            yes.onclick = function () {
                if (!yes.disabled) close(value());
            };
            box.querySelector('[data-no]').onclick = function () {
                close(null);
            };
            (sel || inp).focus();
            inp.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !(opts.multiline && !e.ctrlKey)) {
                    e.preventDefault();
                    if (!yes.disabled) close(value());
                }
            });
        }, null);
    };

    // Declarative confirm on forms: one dialog component for every POST
    // that used to rely on the native confirm. Capture phase so it runs before the
    // double-submit guard, which skips a prevented submit.
    document.addEventListener(
        'submit',
        function (e) {
            var form = e.target;
            if (!form || !form.hasAttribute || !form.hasAttribute('data-confirm')) return;
            if (form.__uifConfirmed) {
                form.__uifConfirmed = false;
                return;
            }
            e.preventDefault();
            var opts = {
                title: form.getAttribute('data-confirm-title') || undefined,
                confirmText: form.getAttribute('data-confirm-yes') || undefined,
                cancelText: form.getAttribute('data-confirm-no') || undefined,
                danger: form.hasAttribute('data-confirm-danger'),
            };
            var reasonField = form.getAttribute('data-confirm-reason');
            var p = reasonField
                ? window.promptDialog(form.getAttribute('data-confirm'), '', {
                      title: opts.title,
                      okText: opts.confirmText,
                      cancelText: opts.cancelText,
                      required: true,
                      multiline: true,
                  })
                : window.confirmDialog(form.getAttribute('data-confirm'), opts);
            p.then(function (v) {
                if (v === false || v === null) return;
                if (reasonField) {
                    var hid = form.querySelector('input[name="' + reasonField + '"]');
                    if (!hid) {
                        hid = document.createElement('input');
                        hid.type = 'hidden';
                        hid.name = reasonField;
                        form.appendChild(hid);
                    }
                    hid.value = String(v).trim();
                }
                if (window.showLoading) window.showLoading('…');
                HTMLFormElement.prototype.submit.call(form);
            });
        },
        true
    );
})();
