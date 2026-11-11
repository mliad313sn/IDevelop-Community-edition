/**
 * The navigation rail on the client (views/partials/sidebar.ejs).
 *
 *  1. Phone drawer (≤ 768 px): when main.js opens the off-canvas rail
 *     (body.sidebar-open) it becomes a MODAL dialog — role="dialog" and
 *     aria-modal, the rest of the page is `inert`, the body does not scroll, a
 *     backdrop covers the page (a click on it closes), Tab stays inside the
 *     drawer, and on close the focus goes back to the menu button. main.js keeps
 *     owning open and close (toggleSidebar, Escape, outside click); this file
 *     only reacts to the state, so the two never fight.
 *  2. Shared computer: signing out forgets the rail's remembered open and
 *     closed groups (the storage key and its legacy keys).
 *  3. « À traiter » badge: the header computes the action count and announces
 *     it with `nav:actions-count`; the rail shows the same number.
 */
(function () {
    'use strict';
    var MOBILE_MAX = 768;
    var sidebar = document.getElementById('appSidebar');
    if (!sidebar) return;
    var nav = sidebar.querySelector('.sidebar-nav');
    var backdrop = document.getElementById('navBackdrop');
    var inerted = [];
    var isOpenModal = false;
    var FOCUSABLE =
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

    function mobile() {
        return window.innerWidth <= MOBILE_MAX;
    }

    function focusables() {
        return Array.prototype.filter.call(sidebar.querySelectorAll(FOCUSABLE), function (el) {
            return el.offsetParent !== null || el === document.activeElement;
        });
    }

    function trap(e) {
        if (!isOpenModal || e.key !== 'Tab') return;
        var f = focusables();
        if (!f.length) return;
        var first = f[0];
        var last = f[f.length - 1];
        var inside = sidebar.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
            e.preventDefault();
            first.focus();
        }
    }

    function setModal(on) {
        if (on === isOpenModal) return;
        isOpenModal = on;
        if (on) {
            sidebar.setAttribute('role', 'dialog');
            sidebar.setAttribute('aria-modal', 'true');
            document.body.classList.add('nav-drawer-lock');
            inerted = [];
            Array.prototype.forEach.call(document.body.children, function (el) {
                if (
                    el === sidebar ||
                    el === backdrop ||
                    el.tagName === 'SCRIPT' ||
                    el.tagName === 'STYLE'
                )
                    return;
                if (el.hasAttribute('inert')) return;
                el.setAttribute('inert', '');
                inerted.push(el);
            });
            if (!sidebar.contains(document.activeElement)) {
                var f = focusables();
                if (f.length) f[0].focus();
            }
        } else {
            // Back to the landmark the rail carries when it is not a modal drawer.
            sidebar.setAttribute('role', 'complementary');
            sidebar.removeAttribute('aria-modal');
            document.body.classList.remove('nav-drawer-lock');
            inerted.forEach(function (el) {
                el.removeAttribute('inert');
            });
            inerted = [];
            var active = document.activeElement;
            if (!active || active === document.body || sidebar.contains(active)) {
                var btn = document.getElementById('mobileMenuToggle');
                if (btn && btn.focus && mobile()) btn.focus();
            }
        }
    }

    function sync() {
        setModal(mobile() && document.body.classList.contains('sidebar-open'));
    }

    if (window.MutationObserver) {
        new MutationObserver(sync).observe(document.body, {
            attributes: true,
            attributeFilter: ['class'],
        });
    }
    window.addEventListener('resize', sync);
    document.addEventListener('keydown', trap, true);
    if (backdrop) {
        backdrop.addEventListener('click', function () {
            document.body.classList.remove('sidebar-open');
            if (typeof window.syncMobileSidebar === 'function') window.syncMobileSidebar();
        });
    }
    // A link followed inside the drawer closes it, so a back-navigation (page
    // cache) does not restore an open modal over the page.
    sidebar.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (a && isOpenModal) document.body.classList.remove('sidebar-open');
    });
    sync();

    // ── shared computer: sign-out forgets the remembered rail state ─────────
    function forgetRail() {
        if (!nav) return;
        var keys = [nav.getAttribute('data-nav-storage') || 'sidebarNav.v3'].concat(
            (nav.getAttribute('data-nav-legacy') || '').split(',')
        );
        try {
            keys.forEach(function (k) {
                if (k) localStorage.removeItem(k);
            });
        } catch (e) {
            /* private mode */
        }
    }
    document.addEventListener(
        'submit',
        function (e) {
            var form = e.target;
            var action = form && form.getAttribute ? form.getAttribute('action') || '' : '';
            if (action === '/logout' || action.indexOf('/logout?') === 0) forgetRail();
        },
        true
    );
    window.appForgetRail = forgetRail;

    // ── « À traiter » badge ─────────────────────────────────────────────────
    document.addEventListener('nav:actions-count', function (e) {
        var n = e && e.detail ? Number(e.detail.count) : NaN;
        Array.prototype.forEach.call(
            document.querySelectorAll('[data-nav-badge="tasks"]'),
            function (b) {
                if (Number.isFinite(n) && n > 0) {
                    b.textContent = n > 99 ? '99+' : String(n);
                    b.hidden = false;
                } else {
                    b.textContent = '';
                    b.hidden = true;
                }
            }
        );
    });
})();
