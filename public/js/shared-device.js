/* eslint-env browser */
/**
 *   shared-device.js — shared-computer (kiosk) mode, OFF unless a SuperAdmin
 *   switches kioskModeEnabled on.
 *
 *   data-mode="login"   (login page) — mirrors the « Shared computer » box into a
 *       short-lived cookie (app_kiosk) so the choice survives the SSO button's
 *       round-trip through the identity provider and the session regeneration of
 *       sign-in. The server reads it once, on the first request of the new
 *       session (src/middleware/sessionActivity.js).
 *
 *   data-mode="session" (every page of a shared-device session; the layout adds
 *       the tag only for such sessions, with the data-* attributes below):
 *       - a visible « Shared computer » badge in the top bar, with a one-click logout;
 *       - closing the tab / browser signs out: `pagehide` → navigator.sendBeacon
 *         to /logout-beacon with the per-session token and this page's render
 *         time (a navigation inside the app renders the NEXT page first, so the
 *         server ignores the beacon of the page being left). Best-effort — the
 *         short server idle window is the backstop;
 *       - no input for the idle window → automatic logout (one minute's notice);
 *         typing on a page that sends no request keeps the session alive (ping);
 *       - before a logout, offline self-assessment drafts of THIS person still
 *         waiting on the device are counted and the person is warned: a sign-out
 *         ERASES that person's drafts from the device (draft-store.js honours
 *         app_drafts_wipe on the login page);
 *       - the menu state of the person who leaves (sidebarNav.v2) is forgotten.
 *
 *   data-* (session mode): beacon-token, render-at, idle-minutes, draft-owner,
 *   label, logout-label, drafts-warning (contains __N__), idle-warning,
 *   stay-label, confirm-yes, confirm-no.
 */
(function () {
    'use strict';

    var script = document.currentScript;
    var cfg = (script && script.dataset) || {};
    var INTENT = 'app_kiosk';
    var BEACON = '/logout-beacon';

    function setIntent(on) {
        var secure = location.protocol === 'https:' ? '; secure' : '';
        document.cookie = on
            ? INTENT + '=1; path=/; max-age=900; samesite=lax' + secure
            : INTENT + '=; path=/; max-age=0; samesite=lax' + secure;
    }

    // ---------------------------------------------------------------- login page
    function initLogin() {
        var box = document.getElementById('sharedDevice');
        if (!box) return;
        var sync = function () {
            setIntent(box.checked);
        };
        if (!box.hasAttribute('data-kiosk-forced')) {
            box.addEventListener('change', sync);
            sync(); // the page state is the truth (a stale intent is dropped)
        }
        // The SSO buttons are plain links: make sure the cookie matches the box
        // at the moment of leaving for the identity provider.
        document.addEventListener(
            'click',
            function (e) {
                var a = e.target && e.target.closest && e.target.closest('[data-sso-provider]');
                if (a && !box.hasAttribute('data-kiosk-forced')) sync();
            },
            true
        );
    }

    // ------------------------------------------------------------ session pages
    function csrf() {
        var m = document.querySelector('meta[name="csrf-token"]');
        return (m && m.getAttribute('content')) || '';
    }

    function beacon(action) {
        var body = new URLSearchParams();
        body.set('token', cfg.beaconToken || '');
        body.set('action', action);
        body.set('renderedAt', String(cfg.renderAt || ''));
        try {
            if (navigator.sendBeacon) return navigator.sendBeacon(BEACON, body);
            fetch(BEACON, {
                method: 'POST',
                body: body,
                credentials: 'same-origin',
                keepalive: true,
            });
        } catch (_) {
            /* best-effort: the server idle window is the backstop */
        }
        return false;
    }

    /** This person's offline drafts still on the device (never anyone else's). */
    async function pendingDrafts() {
        var owner = String(cfg.draftOwner || '');
        if (!owner || !window.indexedDB) return 0;
        try {
            if (window.AppDraftStore && window.AppDraftStore.listPending) {
                return (await window.AppDraftStore.listPending(owner)).length;
            }
            // Never CREATE the database just to look (an empty v1 database
            // would stop draft-store.js from creating its object store later).
            if (typeof indexedDB.databases !== 'function') return 0;
            var names = (await indexedDB.databases()).map(function (d) {
                return d && d.name;
            });
            if (names.indexOf('app_drafts') === -1) return 0;
            return await new Promise(function (resolve) {
                var req = indexedDB.open('app_drafts');
                req.onerror = function () {
                    resolve(0);
                };
                req.onsuccess = function () {
                    var db = req.result;
                    if (!db.objectStoreNames.contains('drafts')) {
                        db.close();
                        return resolve(0);
                    }
                    var all = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
                    all.onsuccess = function () {
                        var n = (all.result || []).filter(function (r) {
                            return r && r.pendingSync && String(r.userId) === owner;
                        }).length;
                        db.close();
                        resolve(n);
                    };
                    all.onerror = function () {
                        db.close();
                        resolve(0);
                    };
                };
            });
        } catch (_) {
            return 0;
        }
    }

    var leaving = false;
    function submitLogout(form) {
        leaving = true;
        // The next person on the shared computer must not inherit this
        // person's open menus: every logout of a shared-device session (badge,
        // account menu, idle) passes here.
        try {
            window.localStorage.removeItem('sidebarNav.v2');
        } catch (_) {
            /* private mode: never block the sign-out */
        }
        HTMLFormElement.prototype.submit.call(form);
    }

    function logoutForm() {
        var f = document.createElement('form');
        f.method = 'POST';
        f.action = '/logout';
        f.hidden = true;
        var i = document.createElement('input');
        i.type = 'hidden';
        i.name = '_csrf';
        i.value = csrf();
        f.appendChild(i);
        document.body.appendChild(f);
        return f;
    }

    function isLogoutForm(form) {
        try {
            return !!form && new URL(form.action, location.href).pathname === '/logout';
        } catch (_) {
            return false;
        }
    }

    async function confirmThenLogout(form) {
        var n = await pendingDrafts();
        if (n > 0) {
            var msg = String(cfg.draftsWarning || '').replace('__N__', String(n));
            var ok = window.confirmDialog
                ? await window.confirmDialog(msg, {
                      confirmText: cfg.confirmYes || undefined,
                      cancelText: cfg.confirmNo || undefined,
                      danger: true,
                  })
                : window.confirm(msg);
            if (!ok) return;
        }
        submitLogout(form);
    }

    // Classes only — .kiosk-badge / .kiosk-badge--floating live in style.css on
    // tokens — no inline style string, no hard-coded colour.
    function badge() {
        var wrap = document.createElement('div');
        wrap.className = 'kiosk-badge';
        wrap.setAttribute('role', 'status');
        var ico = document.createElement('i');
        ico.className = 'fas fa-users';
        ico.setAttribute('aria-hidden', 'true');
        var txt = document.createElement('span');
        txt.textContent = cfg.label || 'Shared computer';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-primary';
        btn.textContent = cfg.logoutLabel || 'Sign out';
        btn.addEventListener('click', function () {
            confirmThenLogout(logoutForm());
        });
        wrap.appendChild(ico);
        wrap.appendChild(txt);
        wrap.appendChild(btn);
        var right = document.querySelector('.topbar-right');
        if (right) right.insertBefore(wrap, right.firstChild);
        else {
            wrap.classList.add('kiosk-badge--floating');
            document.body.appendChild(wrap);
        }
    }

    // The idle warning is a product alert (.alert.alert-warning.kiosk-idle) under
    // the top bar, with a 44 px « Stay signed in » button that resets the timer
    // (touching the screen still works).
    function idleBanner(onStay) {
        var el = document.createElement('div');
        el.className = 'alert alert-warning kiosk-idle';
        el.setAttribute('role', 'alert');
        var ico = document.createElement('i');
        ico.className = 'fas fa-clock';
        ico.setAttribute('aria-hidden', 'true');
        var txt = document.createElement('span');
        txt.textContent = cfg.idleWarning;
        var stay = document.createElement('button');
        stay.type = 'button';
        stay.className = 'btn btn-sm btn-primary';
        stay.setAttribute('data-kiosk-stay', '');
        stay.textContent = cfg.stayLabel || 'Stay signed in';
        stay.addEventListener('click', onStay);
        el.appendChild(ico);
        el.appendChild(txt);
        el.appendChild(stay);
        var bar = document.getElementById('appTopbar');
        if (bar && bar.parentNode) bar.parentNode.insertBefore(el, bar.nextSibling);
        else document.body.insertBefore(el, document.body.firstChild);
        return el;
    }

    function initSession() {
        badge();

        // Every logout form of the page (the account menu too) goes through the
        // drafts check first.
        document.addEventListener(
            'submit',
            function (e) {
                var form = e.target;
                if (!isLogoutForm(form) || leaving) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                confirmThenLogout(form);
            },
            true
        );

        // Tab / browser closed → sign out (the server ignores it for a page a
        // navigation has already replaced).
        window.addEventListener('pagehide', function () {
            if (!leaving) beacon('close');
        });

        // Idle: no keyboard / pointer input for the window → logout, with a
        // minute's notice. Input on a page that sends no request keeps the
        // server session alive (ping at most once a minute).
        var idleMs = Math.max(1, Number(cfg.idleMinutes) || 5) * 60000;
        var lastInput = Date.now();
        var lastPing = Date.now();
        var warned = null;
        var onInput = function () {
            lastInput = Date.now();
            if (warned) {
                warned.remove();
                warned = null;
            }
        };
        ['keydown', 'pointerdown', 'wheel', 'touchstart', 'input'].forEach(function (ev) {
            window.addEventListener(ev, onInput, { passive: true, capture: true });
        });
        setInterval(function () {
            var now = Date.now();
            var idle = now - lastInput;
            if (idle >= idleMs - 5000) {
                // Automatic (no confirmation): like any sign-out, it erases this
                // person's drafts from the device.
                if (!leaving) submitLogout(logoutForm());
                return;
            }
            if (idle >= idleMs - 60000 && !warned && cfg.idleWarning) {
                warned = idleBanner(function () {
                    onInput();
                });
            }
            if (lastInput > lastPing && now - lastPing >= 60000) {
                lastPing = now;
                beacon('ping');
            }
        }, 10000);
    }

    if (cfg.mode === 'login') {
        if (document.readyState === 'loading')
            document.addEventListener('DOMContentLoaded', initLogin);
        else initLogin();
    } else if (cfg.mode === 'session' && cfg.beaconToken) {
        if (document.readyState === 'loading')
            document.addEventListener('DOMContentLoaded', initSession);
        else initSession();
    }
})();
