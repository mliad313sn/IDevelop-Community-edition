// Progressive a11y/responsive enhancements applied app-wide on load:
//  1. Wrap any bare .table in a horizontally-scrollable container so wide
//     tables don't overflow the viewport on phones/tablets.
//  2. Give each chart <canvas> a role+label from its nearest heading, so screen
//     readers announce "chart: <title>" instead of nothing.
document.addEventListener('DOMContentLoaded', function () {
    try {
        document.querySelectorAll('table.table').forEach(function (t) {
            const parent = t.parentElement;
            if (parent && parent.classList.contains('table-wrapper')) return;
            if (t.closest('.table-wrapper')) return;
            const wrap = document.createElement('div');
            wrap.className = 'table-wrapper';
            t.parentNode.insertBefore(wrap, t);
            wrap.appendChild(t);
        });
    } catch (_) {
        /* enhancement only */
    }
    try {
        document.querySelectorAll('canvas').forEach(function (c) {
            if (c.getAttribute('aria-label') || c.getAttribute('role') === 'presentation') return;
            let title = '';
            const box = c.closest('.chart-box, .chart-card, .dashboard-card, section, .card');
            if (box) {
                const h = box.querySelector('h1,h2,h3,h4');
                if (h) title = h.textContent.trim();
            }
            c.setAttribute('role', 'img');
            c.setAttribute('aria-label', (title ? title + ' — ' : '') + 'chart');
        });
    } catch (_) {
        /* enhancement only */
    }
});

// Global safety net: a fetch/promise that rejects with no .catch would fail
// silently (a click that "does nothing"). Surface it as a toast so the user
// knows to retry instead of staring at an unchanged screen.
window.addEventListener('unhandledrejection', function (e) {
    try {
        const msg = (e && e.reason && (e.reason.message || e.reason)) || 'Something went wrong.';
        if (String(msg).toLowerCase().indexOf('network') > -1 || e.reason instanceof TypeError) {
            (window.toast || function () {})(
                document.documentElement.lang === 'fr'
                    ? 'La requête a échoué — vérifiez votre connexion et réessayez.'
                    : 'Request failed — check your connection and try again.',
                'error'
            );
        }
        // Keep it out of the console-noise-as-error bucket but still visible.
        console.warn('[unhandledrejection]', msg);
    } catch (_) {
        /* never let the handler itself throw */
    }
});

// Keyboard Shortcuts
document.addEventListener('keydown', function (e) {
    // Alt + Key shortcuts
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        switch (e.key.toLowerCase()) {
            case 'd':
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    window.location.href = '/dashboard';
                }
                break;
            case 'o':
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    window.location.href = '/organization';
                }
                break;
            case 's':
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    window.location.href = '/app-settings';
                }
                break;
            case 'm':
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    window.location.href = '/skill-matrix';
                }
                break;
            case 'r':
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    window.location.href = '/reports/readiness';
                }
                break;
        }
    }

    // Ctrl+K to focus search input (desktop power-user shortcut)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        const searchInput = document.querySelector('.search-input');
        if (searchInput) {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
        }
    }

    // Escape key to close modals/dropdowns
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.show').forEach((modal) => {
            window.hideModal(modal.id);
        });
        const userDropdown = document.getElementById('userDropdown');
        if (userDropdown && userDropdown.classList.contains('show')) {
            userDropdown.classList.remove('show');
        }
        document.querySelectorAll('.topbar-user').forEach(function (b) {
            b.setAttribute('aria-expanded', 'false');
        });
    }
});

// Flash auto-dismiss — SUCCESS banners from views/partials/flash.ejs only.
// This used to select every element of the alert CLASS and remove it after 5 s,
// so it also destroyed every refusal, the licence banner, the data-management
// danger-zone warnings and any in-page note, with a one-frame cut and a layout
// jump. Now: selection by ORIGIN ([data-flash="success"] — never by class name),
// warnings/errors persist until their close button or the next navigation, the
// success banner fades on opacity (CSS transition, see style.css) and is then
// removed. Reduced motion is read from window.MOTION (ui-feedback.js): a person
// who asked for less motion has not asked for the information to leave sooner —
// nothing auto-dismisses, the banner waits for its close button.
window.flashAutoDismiss = function (root) {
    const motion = window.MOTION || null;
    let reduce = false;
    if (motion) {
        reduce = !!motion.reduce;
    } else {
        try {
            reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (_) {
            /* no matchMedia */
        }
    }
    const hold =
        motion && typeof motion.autoDismiss === 'function'
            ? motion.autoDismiss(5000)
            : reduce
              ? 0
              : 5000;
    const fade = (motion && motion.base) || 200;
    if (!hold) return 0; // 0 = never: the banner waits for its close button
    const banners = (root || document).querySelectorAll('[data-flash="success"]');
    banners.forEach((banner) => {
        setTimeout(() => {
            if (!banner.parentNode) return; // already closed by hand
            // The person is ON the banner (its close cross holds the keyboard focus):
            // removing it now would drop the focus onto <body>. It waits for her.
            if (document.activeElement && banner.contains(document.activeElement)) return;
            banner.style.opacity = '0';
            setTimeout(() => banner.remove(), fade);
        }, hold);
    });
    return banners.length;
};

document.addEventListener('DOMContentLoaded', function () {
    window.flashAutoDismiss(document);

    // Close dropdowns when clicking outside
    document.addEventListener('click', function (event) {
        const userDropdown = document.getElementById('userDropdown');
        const topbarUser = document.querySelector('.topbar-user');

        if (
            userDropdown &&
            topbarUser &&
            !topbarUser.contains(event.target) &&
            !userDropdown.contains(event.target)
        ) {
            userDropdown.classList.remove('show');
            topbarUser.setAttribute('aria-expanded', 'false');
        }
    });

    // Add loading overlay for form submissions — not when a confirm dialog
    // (ui-feedback data-confirm) or a page script has already stopped the submit.
    document.querySelectorAll('form').forEach((form) => {
        form.addEventListener('submit', function (e) {
            if (e && e.defaultPrevented) return;
            if (!this.dataset.noLoading) {
                window.showLoading('Processing...');
            }
        });
    });

    // Add back button functionality
    if (window.history.length > 1) {
        const backBtn = document.querySelector('.btn-back');
        if (backBtn) {
            backBtn.addEventListener('click', function (e) {
                if (e.ctrlKey || e.metaKey) {
                    return; // Allow Ctrl+Click to open in new tab
                }
                e.preventDefault();
                window.history.back();
            });
        }
    }
});

// Sidebar toggle — desktop collapses, mobile overlays
// UX-11 (3.23.17): on a phone the off-canvas menu was only slid out of view
// (translateX), so its ~40 links stayed in the Tab order — a keyboard or
// switch user tabbed through an invisible menu before reaching the page. The
// closed drawer is now `inert` (+ visibility:hidden in style.css for browsers
// without inert), the hamburger carries aria-expanded/aria-controls, Escape
// closes it and focus goes back to the hamburger.
const MOBILE_MAX = 768;
function isMobileViewport() {
    return window.innerWidth <= MOBILE_MAX;
}
window.syncMobileSidebar = function () {
    const sidebar = document.getElementById('appSidebar');
    const menuBtn = document.getElementById('mobileMenuToggle');
    const mobile = isMobileViewport();
    const open = document.body.classList.contains('sidebar-open');
    if (sidebar) {
        const hide = mobile && !open;
        if (hide) {
            sidebar.setAttribute('inert', '');
            sidebar.inert = true;
        } else {
            sidebar.removeAttribute('inert');
            sidebar.inert = false;
        }
    }
    if (menuBtn) {
        menuBtn.setAttribute('aria-controls', 'appSidebar');
        menuBtn.setAttribute('aria-expanded', mobile && open ? 'true' : 'false');
    }
};

function closeMobileSidebar(returnFocus) {
    if (!document.body.classList.contains('sidebar-open')) return false;
    document.body.classList.remove('sidebar-open');
    window.syncMobileSidebar();
    if (returnFocus) {
        const menuBtn = document.getElementById('mobileMenuToggle');
        if (menuBtn && menuBtn.focus) menuBtn.focus();
    }
    return true;
}

function toggleSidebar() {
    const body = document.body;

    if (isMobileViewport()) {
        body.classList.toggle('sidebar-open');
        window.syncMobileSidebar();
        if (body.classList.contains('sidebar-open')) {
            // Move the keyboard into the drawer it just opened.
            const sidebar = document.getElementById('appSidebar');
            const first = sidebar && sidebar.querySelector('a[href], button:not([disabled])');
            if (first && first.focus) first.focus();
        }
    } else {
        body.classList.toggle('sidebar-collapsed');
        localStorage.setItem(
            'sidebarCollapsed',
            body.classList.contains('sidebar-collapsed') ? '1' : '0'
        );
    }
}

// Close sidebar on mobile when clicking outside
document.addEventListener('click', function (e) {
    if (isMobileViewport() && document.body.classList.contains('sidebar-open')) {
        const sidebar = document.getElementById('appSidebar');
        const menuBtn = document.getElementById('mobileMenuToggle');
        const sidebarToggle = document.getElementById('sidebarToggle');
        if (
            sidebar &&
            !sidebar.contains(e.target) &&
            (!menuBtn || !menuBtn.contains(e.target)) &&
            (!sidebarToggle || !sidebarToggle.contains(e.target))
        ) {
            closeMobileSidebar(false);
        }
    }
});

// Escape closes the open drawer and hands focus back to the hamburger.
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isMobileViewport()) {
        if (closeMobileSidebar(true) && e.preventDefault) e.preventDefault();
    }
});

// Crossing the breakpoint (rotation, window resize) re-evaluates inert.
window.addEventListener('resize', function () {
    window.syncMobileSidebar();
});
document.addEventListener('DOMContentLoaded', function () {
    window.syncMobileSidebar();
});

// Restore sidebar state on load
document.addEventListener('DOMContentLoaded', function () {
    if (localStorage.getItem('sidebarCollapsed') === '1') {
        document.body.classList.add('sidebar-collapsed');
    }

    // Scroll-to-top button
    const scrollBtn = document.createElement('button');
    scrollBtn.className = 'scroll-to-top';
    scrollBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
    scrollBtn.setAttribute('aria-label', 'Scroll to top');
    scrollBtn.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.body.appendChild(scrollBtn);

    window.addEventListener('scroll', function () {
        if (window.scrollY > 300) {
            scrollBtn.classList.add('visible');
        } else {
            scrollBtn.classList.remove('visible');
        }
    });
});

// ── Appearance: mode (light / dark / system) + colour theme ─────────
// The mode is 'light', 'dark' or 'system' (follow the device); with nothing
// stored the device preference applies. The colour theme is iris | meadow |
// sunrise | ocean. The inline script in each page's <head> applies both before
// first paint; these helpers change them afterwards.
const HZ_PALETTES = ['iris', 'meadow', 'sunrise', 'ocean'];
const HZ_DARK_QUERY = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function hzGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (_) {
        return null;
    }
}
function hzStore(key, value) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch (_) {
        /* private mode: the choice lasts for this page only */
    }
}

function hzApplyMode() {
    const stored = hzGet('theme');
    const dark =
        stored === 'dark' || (stored !== 'light' && HZ_DARK_QUERY && HZ_DARK_QUERY.matches);
    if (dark) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'light');
}

function setThemeMode(mode) {
    hzStore('theme', mode === 'dark' || mode === 'light' ? mode : null);
    hzApplyMode();
    hzSyncMenu();
}

function setPalette(name) {
    const root = document.documentElement;
    const pal = HZ_PALETTES.indexOf(name) === -1 ? 'iris' : name;
    if (pal === 'iris') root.removeAttribute('data-palette');
    else root.setAttribute('data-palette', pal);
    hzStore('palette', pal);
    hzSyncMenu();
}

// Kept for any caller of the old one-button toggle.
function toggleTheme() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    setThemeMode(light ? 'dark' : 'light');
}

function hzSyncMenu() {
    const stored = hzGet('theme');
    const mode = stored === 'dark' || stored === 'light' ? stored : 'system';
    const pal = document.documentElement.getAttribute('data-palette') || 'iris';
    document.querySelectorAll('input[name="hz-mode"]').forEach(function (i) {
        i.checked = i.value === mode;
    });
    document.querySelectorAll('input[name="hz-palette"]').forEach(function (i) {
        i.checked = i.value === pal;
    });
}

if (HZ_DARK_QUERY && HZ_DARK_QUERY.addEventListener) {
    HZ_DARK_QUERY.addEventListener('change', hzApplyMode);
}

// Current page in the sidebar: announced, not only coloured (WCAG 1.3.1).
document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.sidebar-link.active').forEach(function (a) {
        a.setAttribute('aria-current', 'page');
    });
});

// Card tables below 768 px: each cell shows its column header as a label.
// Cells that already carry data-label keep it; colspan rows are left alone.
function hzLabelCardTables(root) {
    (root || document).querySelectorAll('table.table-cards').forEach(function (t) {
        const heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) {
            return (th.textContent || '').replace(/\s+/g, ' ').trim();
        });
        t.querySelectorAll('tbody tr').forEach(function (tr) {
            Array.prototype.forEach.call(tr.children, function (td, i) {
                if (td.hasAttribute('colspan') || td.hasAttribute('data-label')) return;
                if (heads[i]) td.setAttribute('data-label', heads[i]);
            });
        });
    });
}
document.addEventListener('DOMContentLoaded', function () {
    hzLabelCardTables(document);
});

// Disclosure pattern: a button that shows a panel of two native radio groups.
document.addEventListener('DOMContentLoaded', function () {
    const wrap = document.getElementById('hzPalette');
    const btn = document.getElementById('hzPaletteBtn');
    const menu = document.getElementById('hzPaletteMenu');
    if (!wrap || !btn || !menu) return;
    const close = function () {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', function () {
        const open = menu.hidden;
        menu.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        if (open) hzSyncMenu();
    });
    // A mouse press on a choice must not move focus out of the widget first: the
    // labels are not focusable, so the button's focusout (relatedTarget null)
    // closed the menu before the click could pick the swatch or the mode.
    menu.addEventListener('mousedown', function (e) {
        if (e.target.closest('label')) e.preventDefault();
    });
    menu.addEventListener('change', function (e) {
        if (e.target.name === 'hz-mode') setThemeMode(e.target.value);
        if (e.target.name === 'hz-palette') setPalette(e.target.value);
    });
    // Close when focus or a click leaves the widget (2.4.11: never left
    // covering the element that now has focus).
    wrap.addEventListener('focusout', function (e) {
        if (!wrap.contains(e.relatedTarget)) close();
    });
    document.addEventListener('click', function (e) {
        if (!wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !menu.hidden) {
            close();
            btn.focus();
        }
    });
    hzSyncMenu();
});

// Toast notification system
window.showToast = function (message, type = 'info', duration = 5000) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle',
    };

    // UX (3.23.17, main.js:326): the message used to be interpolated into
    // innerHTML, so any server/user text reaching showToast was parsed as HTML.
    // Built node by node; the message is TEXT.
    const kind = Object.prototype.hasOwnProperty.call(icons, type) ? type : 'info';
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + kind;
    if (kind === 'error') toast.setAttribute('role', 'alert');
    else toast.setAttribute('role', 'status');
    const icon = document.createElement('i');
    icon.className = 'fas ' + icons[kind] + ' toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    const msgEl = document.createElement('span');
    msgEl.className = 'toast-message';
    msgEl.textContent = message == null ? '' : String(message);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute(
        'aria-label',
        (window.__UIF_I18N__ && window.__UIF_I18N__.close) || 'Fermer'
    );
    closeBtn.textContent = '×';
    toast.appendChild(icon);
    toast.appendChild(msgEl);
    toast.appendChild(closeBtn);

    closeBtn.addEventListener('click', function () {
        toast.style.animation = 'toastFadeOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    });

    container.appendChild(toast);

    // Errors wait for their close button (same rule as window.toast, UX-07).
    if (kind !== 'error') {
        setTimeout(() => {
            if (toast.parentNode) {
                toast.remove();
            }
        }, duration);
    }
    return toast;
};

// User menu toggle — ONE account menu, in the top bar (UX-17). It used to toggle
// a second, differently-stocked dropdown in the sidebar footer at the same time,
// so a single click opened two menus. The sidebar footer is now a profile link.
function toggleUserMenu() {
    const userDropdown = document.getElementById('userDropdown');
    let open = false;
    if (userDropdown) open = userDropdown.classList.toggle('show');
    // Reflect popup state to assistive tech on the trigger (WCAG 4.1.2).
    document.querySelectorAll('.topbar-user').forEach(function (b) {
        b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
}

// Confirmation dialogs: <form data-confirm="…"> (ui-feedback.js) — never the native confirm.
// Legacy client-side row filter. Opt-in ONLY: it used to bind every
// input[type=search]/.search-input, so a SERVER search box (/employees, /movements…)
// hid rows on the current page while typing and then fought the reload. Pages that
// want it mark the input with data-client-search; new pages use table-search.js.
document.addEventListener('DOMContentLoaded', function () {
    const explicit = Array.from(document.querySelectorAll('[data-client-search]'));
    // Legacy fallback for pages not yet migrated: a search box that is NOT a
    // server form field (not inside a GET form), not table-search.js-driven and
    // has no handler of its own. Pages should move to data-client-search.
    const legacy = Array.from(
        document.querySelectorAll('input[type="search"], .search-input')
    ).filter(
        (el) =>
            !explicit.includes(el) &&
            !el.closest('form[method="GET"], form[method="get"]') &&
            !el.hasAttribute('data-table-search') &&
            !el.hasAttribute('oninput') &&
            !el.hasAttribute('data-no-client-search')
    );
    const searchInputs = explicit.concat(legacy);
    searchInputs.forEach((searchInput) => {
        searchInput.addEventListener('input', function () {
            const searchTerm = this.value.toLowerCase().trim();
            const container =
                this.closest('.content-wrapper') || this.closest('.container') || document;
            const tables = container.querySelectorAll('.table');

            tables.forEach((table) => {
                const rows = table.querySelectorAll('tbody tr:not(.empty-row)');
                let visibleCount = 0;

                rows.forEach((row) => {
                    const text = row.textContent.toLowerCase();
                    const matches = text.includes(searchTerm);
                    row.style.display = matches ? '' : 'none';
                    if (matches) visibleCount++;
                });

                // Show/hide empty state
                const emptyRow = table.querySelector('tbody tr.empty-row');
                if (emptyRow) {
                    emptyRow.style.display = visibleCount === 0 && searchTerm ? '' : 'none';
                }
            });
        });
    });

    // Column sorting (th.sortable) lives in list-tools.js: keyboard-reachable,
    // aria-sort, and safe on grouped tables (— this used to throw on the
    // /employees site-separator rows and sort them in among people).
});

// Enhanced modal handling
document.querySelectorAll('.modal').forEach((modal) => {
    // Show modal with animation
    const showModal = function (modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('show'), 10);
        }
    };

    // Hide modal with animation
    const hideModal = function (modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('show');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 300);
        }
    };

    // Close on outside click
    modal.addEventListener('click', function (e) {
        if (e.target === this) {
            hideModal(this.id);
        }
    });

    // Close button
    const closeBtn = modal.querySelector('.close');
    if (closeBtn) {
        closeBtn.addEventListener('click', function () {
            hideModal(modal.id);
        });
    }
});

// ---- Modal a11y: every modal opened via showModal gets a dialog role,
// focus trapping, Escape-to-close and focus restoration (WCAG 2.4.3 / aria-modal
// honesty). One shared implementation covers all modals in the app.
let _modalLastFocus = null;
function _modalFocusables(modal) {
    return Array.prototype.slice
        .call(
            modal.querySelectorAll(
                'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
            )
        )
        .filter((el) => el.offsetParent !== null);
}
function _modalTrap(e) {
    if (e.key === 'Escape') {
        const open = document.querySelector('.modal.show');
        if (open && open.id) {
            window.hideModal(open.id);
        }
        return;
    }
    if (e.key !== 'Tab') return;
    const modal = document.querySelector('.modal.show');
    if (!modal) return;
    const f = _modalFocusables(modal);
    if (!f.length) return;
    const first = f[0],
        last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

// Update all modal show functions to use new animation
window.showModal = function (modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        _modalLastFocus = document.activeElement;
        if (!modal.getAttribute('role')) modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.style.display = 'flex';
        setTimeout(() => {
            modal.classList.add('show');
            const f = _modalFocusables(modal);
            const closeBtn = modal.querySelector('.close');
            (closeBtn || f[0] || modal).focus && (closeBtn || f[0] || modal).focus();
        }, 10);
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', _modalTrap, true);
    }
};

window.hideModal = function (modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
        modal.setAttribute('aria-modal', 'false');
        document.removeEventListener('keydown', _modalTrap, true);
        setTimeout(() => {
            modal.style.display = 'none';
            document.body.style.overflow = '';
            if (_modalLastFocus && _modalLastFocus.focus) _modalLastFocus.focus();
            _modalLastFocus = null;
        }, 300);
    }
};

// Loading overlay functions
window.showLoading = function (message = 'Loading...') {
    let overlay = document.getElementById('loadingOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loadingOverlay';
        overlay.className = 'loading-overlay';
        overlay.innerHTML = `
            <div class="loading-spinner"></div>
            <div class="loading-text">${message}</div>
        `;
        document.body.appendChild(overlay);
    }
    overlay.querySelector('.loading-text').textContent = message;
    overlay.classList.add('show');
};

window.hideLoading = function () {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.remove('show');
        setTimeout(() => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        }, 300);
    }
};

// Shared password show/hide toggle. Password fields render type="password" (masked
// by default — never plaintext on screen); an eye button reveals them when an admin
// needs to read/copy a generated credential. Global so any page can call it inline
// (onclick="togglePasswordVisibility('id', this)"); also delegated via
// [data-pw-toggle="<inputId>"] for CSP-clean, handler-free markup.
window.togglePasswordVisibility = function (inputId, btn) {
    var input = document.getElementById(inputId);
    if (!input) return;
    var reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    // Swap the eye icon if the triggering button carries one.
    var icon = btn && btn.querySelector ? btn.querySelector('.fa-eye, .fa-eye-slash') : null;
    if (icon) {
        icon.classList.toggle('fa-eye', !reveal);
        icon.classList.toggle('fa-eye-slash', reveal);
    }
    if (btn && btn.setAttribute) btn.setAttribute('aria-pressed', String(reveal));
};
document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-pw-toggle]') : null;
    if (btn) {
        e.preventDefault();
        window.togglePasswordVisibility(btn.getAttribute('data-pw-toggle'), btn);
    }
});

/* ------------------------------------------------------------------
   Accessible names for placeholder-only controls.

   An audit of the running app found 28 search inputs across the product
   that carry a placeholder but no <label>, aria-label or aria-labelledby.
   A placeholder is NOT a reliable accessible name: several screen readers
   ignore it, and it disappears the moment the user types � so the control
   becomes anonymous exactly when it is being used.

   Retrofitting 28 i18n-bearing templates by hand is churn with regression
   risk, and would not cover pages added later. This mirrors the already
   translated placeholder into aria-label whenever a control has no other
   accessible name, so every current and future field is covered.
   Anything that already has a real label is left untouched.
------------------------------------------------------------------- */
(function nameUnlabelledControls() {
    'use strict';
    function apply(root) {
        var sel = 'input:not([type=hidden]),select,textarea';
        (root || document).querySelectorAll(sel).forEach(function (el) {
            if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return;
            if (el.labels && el.labels.length) return; // real <label> wins
            var name = el.getAttribute('placeholder') || el.getAttribute('title');
            if (name && name.trim()) el.setAttribute('aria-label', name.trim());
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            apply(document);
        });
    } else {
        apply(document);
    }
    // Cover controls injected later (modals, async tables, the command palette).
    if (window.MutationObserver) {
        new MutationObserver(function (muts) {
            muts.forEach(function (m) {
                m.addedNodes &&
                    m.addedNodes.forEach(function (n) {
                        if (n.nodeType === 1) apply(n.querySelectorAll ? n : null);
                    });
            });
        }).observe(document.documentElement, { childList: true, subtree: true });
    }
})();
