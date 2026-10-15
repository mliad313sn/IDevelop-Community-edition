/**
 * ui-feedback.js — app-wide notification + dialog utilities.
 *
 * THE app-wide toast + dialog component: one implementation every page uses —
 * no local toast, no native alert() / confirm().
 *
 * - window.toast(text, kind, opts)       non-blocking toast; kind ∈ success|error|warn|info
 *   window.toast(kind, text, opts)       (both orders accepted: the kind is recognised
 *                                         whichever side it is on)
 *       opts: { duration: ms, persist: true } — an ERROR always persists.
 * - window.confirmDialog(opts)           Promise — the object form:
 *       { title, body, confirmLabel (VERB-FIRST, e.g. « Retirer le périmètre »),
 *         cancelLabel, danger, reason }
 *       reason:false → resolves true / false
 *       reason:true  → resolves the typed reason (string) or null when cancelled
 *   window.confirmDialog(msg, opts)      legacy form, still works: opts { title,
 *       confirmText, cancelText, danger } → true / false
 *   An action label that is not a verb (« OK », « Oui », « Yes ») is refused:
 *   the default verb (« Confirmer ») is used and a console warning names it.
 * - window.promptDialog(msg, def, opts)  Promise<string|null> styled prompt
 *       opts: { title, okText, cancelText, multiline, required, placeholder }
 *       `required` keeps OK disabled until something is typed — the "mandatory
 *       reason" every cancellation / exclusion must carry (product rule 3).
 * - <form data-confirm="…">              declarative confirm before a POST (replaces the
 *       native onsubmit="return confirm(…)"): data-confirm-title, data-confirm-yes,
 *       data-confirm-no, data-confirm-danger, and data-confirm-reason="fieldName" to
 *       collect a required reason into a hidden input before submitting.
 *
 * Dialog contract: role=dialog, aria-modal, labelled by its heading and described
 * by its message, Tab trapped inside, Escape and a backdrop click cancel, the
 * focus returns to the opener; a destructive dialog opens on its cancel button.
 * Colours, radii and layers are IDevelop's tokens (style.css), never literals.
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

    // Tokens only: brand primary, the semantic status colours, the radius and
    // spacing scales and the --z-* layers of style.css (fallbacks for a page that
    // loads this script without it).
    var css =
        '' +
        // Below the fixed top bar, so a toast never covers the bell it talks about.
        '.uif-toasts{position:fixed;top:calc(var(--topbar-height,48px) + 12px);right:var(--space-4,16px);z-index:var(--z-toast,700);display:flex;flex-direction:column;gap:var(--space-2,8px);max-width:90vw}' +
        '.uif-toast{min-width:240px;max-width:420px;padding:var(--space-3,12px) var(--space-4,16px);border-radius:var(--radius-md,10px);color:var(--toast-ink,#fff);font:500 14px/1.4 var(--font-body,system-ui,sans-serif);box-shadow:var(--shadow-lg,0 8px 24px rgba(0,0,0,.25));opacity:0;transform:translateY(-8px);transition:opacity .2s,transform .2s;display:flex;gap:var(--space-3,12px);align-items:flex-start}' +
        '.uif-toast.show{opacity:1;transform:translateY(0)}' +
        // A real <button>: 24x24 minimum target (WCAG 2.5.8), inherits the toast
        // colour, visible ring on keyboard focus.
        '.uif-toast .uif-x{margin-left:auto;cursor:pointer;opacity:.85;font:700 16px/1 var(--font-body,system-ui,sans-serif);background:none;border:0;color:inherit;min-width:24px;min-height:24px;padding:0 2px;border-radius:4px}' +
        '.uif-toast .uif-x:hover{opacity:1}.uif-toast .uif-x:focus-visible{outline:2px solid currentColor;outline-offset:2px;opacity:1}' +
        // White text at 4.5:1 or more on each fill.
        '.uif-success{background:var(--toast-success-bg,#15803d)}.uif-error{background:var(--toast-error-bg,#b91c1c)}.uif-info{background:var(--toast-info-bg,#3f4a6b)}.uif-warn{background:var(--toast-warn-bg,#a94e08)}' +
        '.uif-toast .uif-ic{flex:0 0 auto;margin-top:2px}.uif-toast .uif-msg{flex:1;min-width:0;overflow-wrap:anywhere}' +
        '.uif-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}' +
        '@media (max-width:480px){.uif-toasts{left:var(--space-3,12px);right:var(--space-3,12px);max-width:none}.uif-toast{min-width:0;max-width:none}}' +
        '.uif-backdrop{position:fixed;inset:0;background:var(--overlay,rgba(2,6,23,.55));z-index:var(--z-modal,600);display:flex;align-items:center;justify-content:center;padding:var(--space-4,16px)}' +
        '.uif-modal{background:var(--bg-elevated,#fff);color:var(--text-primary,#0f172a);border:1px solid var(--border,transparent);border-radius:var(--radius-lg,14px);max-width:440px;width:100%;padding:var(--space-6,24px);box-shadow:var(--shadow-xl,0 20px 50px rgba(0,0,0,.45));font-family:var(--font-body,system-ui,sans-serif)}' +
        '.uif-modal h4{margin:0 0 var(--space-3,12px);font-size:17px;font-weight:600;color:var(--text-primary,#0f172a)}.uif-modal p{margin:0 0 var(--space-4,16px);color:var(--text-secondary,#334155);font-size:14px;white-space:pre-wrap}' +
        '.uif-modal label{display:block;margin:0 0 var(--space-2,8px);font-size:13px;font-weight:600;color:var(--text-primary,#0f172a)}' +
        '.uif-modal input,.uif-modal textarea,.uif-modal select{width:100%;min-height:40px;padding:var(--space-2,8px) var(--space-3,12px);border:1px solid var(--border,#cbd5e1);background:var(--bg-inset,#fff);color:var(--text-primary,#0f172a);border-radius:var(--radius-md,8px);font-size:14px;margin-bottom:var(--space-4,16px);font-family:inherit}' +
        '.uif-modal textarea{min-height:84px;resize:vertical}' +
        '.uif-hint{display:block;margin:-12px 0 12px;font-size:13px;color:var(--text-secondary,#334155)}' +
        '.uif-actions{display:flex;justify-content:flex-end;gap:var(--space-3,12px);flex-wrap:wrap}' +
        '.uif-btn{min-height:40px;padding:var(--space-2,8px) var(--space-4,16px);border-radius:999px;border:1px solid transparent;font:600 14px/1 var(--font-body,system-ui,sans-serif);cursor:pointer}' +
        '.uif-btn[disabled]{opacity:.5;cursor:not-allowed}' +
        '.uif-btn:focus-visible{outline:2px solid var(--focus-ring,var(--brand,#2563eb));outline-offset:2px}' +
        '.uif-btn-primary{background:var(--brand,#2563eb);color:var(--text-inverse,#fff)}' +
        '.uif-btn-primary:hover{background:var(--brand-hover,var(--brand,#2563eb))}' +
        '.uif-btn-danger{background:var(--danger,#b91c1c);color:var(--toast-ink,#fff)}' +
        '.uif-btn-secondary{background:transparent;color:var(--text-primary,#0f172a);border-color:var(--border,#cbd5e1)}' +
        '.uif-btn-secondary:hover{background:var(--bg-subtle,#e2e8f0)}' +
        '@media (pointer:coarse){.uif-toast .uif-x{min-width:44px;min-height:44px}.uif-btn{min-height:44px}}';
    var style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    function container() {
        var c = document.querySelector('.uif-toasts');
        if (!c) {
            c = document.createElement('div');
            c.className = 'uif-toasts';
            c.id = 'uifToasts';
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

    // A screen reader hears the kind before the text (« Erreur : … »): the colour
    // and the icon alone are not the meaning.
    var TYPE_WORD = {
        fr: { success: 'Succès', error: 'Erreur', warn: 'Attention', info: 'Information' },
        en: { success: 'Success', error: 'Error', warn: 'Warning', info: 'Information' },
    };
    var TYPE_ICON = {
        success: 'fa-circle-check',
        error: 'fa-circle-exclamation',
        warn: 'fa-triangle-exclamation',
        info: 'fa-circle-info',
    };
    function lang() {
        try {
            return String(document.documentElement.getAttribute('lang') || 'fr')
                .toLowerCase()
                .indexOf('en') === 0
                ? 'en'
                : 'fr';
        } catch (_) {
            return 'fr';
        }
    }
    function typeWord(type) {
        var key = 'toast' + type.charAt(0).toUpperCase() + type.slice(1);
        if (L()[key]) return L()[key];
        return TYPE_WORD[lang()][type];
    }

    /**
     * window.toast(msg, type, opts)  — or —  window.toast(type, msg, opts)
     *   type   'success' | 'error' | 'warn' | 'info' (+ aliases ok, danger, warning)
     *   opts   { duration: ms, persist: true } — persist = stays until closed.
     */
    window.toast = function (msg, type, opts) {
        if (msg == null && type == null) return;
        if (
            typeof msg === 'string' &&
            Object.prototype.hasOwnProperty.call(TYPE_ALIAS, msg) &&
            (type == null || typeof type === 'string') &&
            !Object.prototype.hasOwnProperty.call(TYPE_ALIAS, String(type))
        ) {
            var swap = msg;
            msg = type;
            type = swap;
        }
        if (msg == null) return;
        var o = opts || {};
        // An explicit type always wins. Wording is only a FALLBACK for callers that
        // give none (legacy alert above all), never an override.
        type = TYPE_ALIAS[type] || detectType(msg);
        var c = container();
        var t = document.createElement('div');
        t.className = 'uif-toast uif-' + type;
        t.setAttribute('data-type', type);
        // An error interrupts; nothing else does. role="alert" carries its own
        // assertive politeness, so only this one preempts the reader.
        if (type === 'error') t.setAttribute('role', 'alert');
        var ic = document.createElement('i');
        ic.className = 'fas ' + TYPE_ICON[type] + ' uif-ic';
        ic.setAttribute('aria-hidden', 'true');
        var span = document.createElement('span');
        span.className = 'uif-msg';
        var sr = document.createElement('span');
        sr.className = 'uif-sr';
        sr.textContent = typeWord(type) + ' : ';
        span.appendChild(sr);
        span.appendChild(document.createTextNode(String(msg)));
        // The close control is a real <button> with a name.
        var x = document.createElement('button');
        x.setAttribute('type', 'button');
        x.className = 'uif-x';
        x.setAttribute('aria-label', L().close || (lang() === 'en' ? 'Close' : 'Fermer'));
        x.textContent = '×';
        x.onclick = function () {
            dismiss();
        };
        t.appendChild(ic);
        t.appendChild(span);
        t.appendChild(x);
        c.appendChild(t);
        requestAnimationFrame(function () {
            t.classList.add('show');
        });
        // A timer that removes information reads the motion table: under
        // prefers-reduced-motion autoDismiss returns 0 = never. An ERROR never
        // leaves on its own: it stays until its close button is pressed.
        var ttl =
            type === 'error' || o.persist
                ? 0
                : window.MOTION.autoDismiss(Number(o.duration) > 0 ? Number(o.duration) : 3500);
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
            var desc = box.querySelector('p');
            if (desc && desc.textContent) {
                if (!desc.id) desc.id = 'uif-desc-' + Math.random().toString(36).slice(2);
                box.setAttribute('aria-describedby', desc.id);
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
                var inside = box.contains(document.activeElement);
                if (e.shiftKey && (document.activeElement === first || !inside)) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
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

    // No « OK », no « Oui / Yes » on an action button: the label says what
    // happens. A non-verb label is replaced by the default verb and reported, so
    // the page author sees it in the console.
    var NOT_A_VERB = /^\s*(ok|okay|oui|yes|non|no|d'accord|go)\s*[!.]?\s*$/i;
    function verbLabel(label, fallback, where) {
        if (label == null || label === '') return fallback;
        if (NOT_A_VERB.test(String(label))) {
            try {
                console.warn(
                    '[ui-feedback] ' +
                        where +
                        ': the confirm label must be verb-first (« ' +
                        label +
                        ' » refused, « ' +
                        fallback +
                        ' » used).'
                );
            } catch (_) {
                /* no console */
            }
            return fallback;
        }
        return String(label);
    }
    function defaultConfirm() {
        return L().confirm || (lang() === 'en' ? 'Confirm' : 'Confirmer');
    }
    function defaultCancel() {
        return L().cancel || (lang() === 'en' ? 'Cancel' : 'Annuler');
    }

    /**
     * confirmDialog({ title, body, confirmLabel, cancelLabel, danger, reason })
     * confirmDialog(msg, { title, confirmText, cancelText, danger })   (legacy)
     */
    window.confirmDialog = function (msg, opts) {
        if (msg && typeof msg === 'object') {
            opts = msg;
            msg = opts.body != null ? opts.body : opts.message != null ? opts.message : '';
        }
        opts = opts || {};
        var confirmLabel = verbLabel(
            opts.confirmLabel || opts.confirmText || opts.okText,
            defaultConfirm(),
            'confirmDialog'
        );
        var cancelLabel = opts.cancelLabel || opts.cancelText || defaultCancel();
        if (opts.reason) {
            return window.promptDialog(msg, '', {
                title: opts.title,
                okText: confirmLabel,
                cancelText: cancelLabel,
                required: true,
                multiline: true,
                danger: !!opts.danger,
                placeholder: opts.placeholder,
            });
        }
        return modal(function (box, close) {
            box.innerHTML =
                '<h4>' +
                esc(opts.title || L().confirmTitle || 'Confirmation') +
                '</h4><p></p>' +
                '<div class="uif-actions"><button type="button" class="uif-btn uif-btn-secondary" data-no>' +
                esc(cancelLabel) +
                '</button>' +
                '<button type="button" class="uif-btn ' +
                (opts.danger ? 'uif-btn-danger' : 'uif-btn-primary') +
                '" data-yes>' +
                esc(confirmLabel) +
                '</button></div>';
            box.querySelector('p').textContent = msg == null ? '' : String(msg);
            box.querySelector('[data-yes]').onclick = function () {
                close(true);
            };
            box.querySelector('[data-no]').onclick = function () {
                close(false);
            };
            // A destructive dialog opens on CANCEL: Enter never destroys by reflex.
            box.querySelector(opts.danger ? '[data-no]' : '[data-yes]').focus();
        }, false);
    };

    // `opts.choices` (array of strings): ready-made reasons offered in a <select>
    // above the free-text field. The resolved value is the chosen reason, then
    // the free text on its own line — either one alone satisfies `required`.
    window.promptDialog = function (msg, def, opts) {
        opts = opts || {};
        var choices = Array.isArray(opts.choices) ? opts.choices : null;
        var okLabel = verbLabel(opts.okText, defaultConfirm(), 'promptDialog');
        return modal(function (box, close) {
            var fieldId = 'uif-field-' + Math.random().toString(36).slice(2);
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
                '<label for="' +
                fieldId +
                '">' +
                esc(opts.label || L().reasonLabel || (lang() === 'en' ? 'Reason' : 'Motif')) +
                '</label>' +
                (opts.multiline
                    ? '<textarea rows="3" id="' + fieldId + '"></textarea>'
                    : '<input type="text" id="' + fieldId + '">') +
                (opts.required
                    ? '<small class="uif-hint">' +
                      esc(L().reasonRequired || 'Champ obligatoire') +
                      '</small>'
                    : '') +
                '<div class="uif-actions">' +
                '<button type="button" class="uif-btn uif-btn-secondary" data-no>' +
                esc(opts.cancelText || defaultCancel()) +
                '</button>' +
                '<button type="button" class="uif-btn ' +
                (opts.danger ? 'uif-btn-danger' : 'uif-btn-primary') +
                '" data-yes>' +
                esc(okLabel) +
                '</button></div>';
            box.querySelector('p').textContent = msg == null ? '' : String(msg);
            var inp = box.querySelector('input, textarea');
            if (opts.required) inp.setAttribute('aria-required', 'true');
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
                      danger: opts.danger,
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
