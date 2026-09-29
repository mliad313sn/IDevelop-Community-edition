/**
 * AI companion — the « Assistant » tab of the help panel (views/partials/contextual-help.ejs).
 *
 *  - chat thread (role="log", polite live region) + input + suggestion chips;
 *  - answers come from POST /api/companion/ask (CSRF token from the page's
 *    <meta name="csrf-token">), suggestions from GET /api/companion/suggestions;
 *  - every answer is rendered as TEXT (never HTML); links become buttons and only
 *    same-origin, path-absolute hrefs are kept;
 *  - history is kept in sessionStorage, per user, for this tab only (cleared by
 *    the « Clear » button); a first-visit dot on the « ? » button until the panel
 *    has been opened once (localStorage). Storage access is always guarded — a
 *    blocked storage just means no history / no dot.
 */
document.addEventListener('DOMContentLoaded', () => {
    const root = document.querySelector('[data-companion]');
    if (!root) return;
    const fab = document.getElementById('helpFab');
    const thread = root.querySelector('[data-companion-thread]');
    const form = root.querySelector('[data-companion-form]');
    const input = root.querySelector('[data-companion-input]');
    const send = root.querySelector('[data-companion-send]');
    const chips = root.querySelector('[data-companion-chips]');
    const typing = root.querySelector('[data-companion-typing]');
    const clearBtn = root.querySelector('[data-companion-clear]');
    const dot = document.querySelector('[data-companion-dot]');

    let I18N = {};
    try {
        I18N = JSON.parse(root.getAttribute('data-i18n') || '{}');
    } catch (_) {
        I18N = {};
    }
    const MAX = 500;
    const HISTORY_MAX = 40;
    const STORE_KEY = 'idv.companion.history.' + (root.getAttribute('data-user-key') || 'anon');
    const SEEN_KEY = 'idv.companion.seen';
    const csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
    const pagePath = window.location.pathname;
    let busy = false;
    let suggestionsLoaded = false;

    // ── Storage (guarded) ───────────────────────────────────────────────
    function loadHistory() {
        try {
            const raw = window.sessionStorage.getItem(STORE_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (_) {
            return [];
        }
    }
    function saveHistory(arr) {
        try {
            window.sessionStorage.setItem(STORE_KEY, JSON.stringify(arr.slice(-HISTORY_MAX)));
        } catch (_) {
            /* storage unavailable: history simply is not kept */
        }
    }
    function clearHistory() {
        try {
            window.sessionStorage.removeItem(STORE_KEY);
        } catch (_) {
            /* ignore */
        }
    }
    let history = loadHistory();

    // ── Welcome nudge on the « ? » button ────────────────────────────────
    function seen() {
        try {
            return window.localStorage.getItem(SEEN_KEY) === '1';
        } catch (_) {
            return true; // storage blocked: never nag
        }
    }
    const baseAria = fab ? fab.getAttribute('aria-label') || '' : '';
    if (dot && fab && !seen()) {
        dot.hidden = false;
        fab.classList.add('hz-companion-nudging');
        const nudge = dot.getAttribute('data-nudge');
        if (nudge) fab.setAttribute('aria-label', baseAria + ' — ' + nudge);
    }
    function markSeen() {
        try {
            window.localStorage.setItem(SEEN_KEY, '1');
        } catch (_) {
            /* ignore */
        }
        if (dot) dot.hidden = true;
        if (fab) {
            fab.classList.remove('hz-companion-nudging');
            fab.setAttribute('aria-label', baseAria);
        }
    }

    // ── Rendering (text only) ────────────────────────────────────────────
    function safeHref(h) {
        return typeof h === 'string' && h.charAt(0) === '/' && h.charAt(1) !== '/' ? h : null;
    }
    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function renderMessage(m) {
        const wrap = el('div', 'hz-companion__msg ' + (m.role === 'user' ? 'is-user' : 'is-bot'));
        wrap.appendChild(
            el('span', 'sr-only', (m.role === 'user' ? I18N.you : I18N.assistant) + ' : ')
        );
        const bubble = el('div', 'hz-companion__bubble');
        String(m.text || '')
            .split('\n')
            .filter((line) => line.trim() !== '')
            .forEach((line) => bubble.appendChild(el('p', null, line)));
        wrap.appendChild(bubble);
        if (m.role !== 'user') {
            const links = (m.links || []).filter((l) => l && safeHref(l.href));
            if (links.length) {
                const nav = el('div', 'hz-companion__links');
                if (I18N.linksLabel) nav.setAttribute('aria-label', I18N.linksLabel);
                links.forEach((l) => {
                    const a = el('a', 'hz-companion__link', l.label || l.href);
                    a.href = safeHref(l.href);
                    nav.appendChild(a);
                });
                wrap.appendChild(nav);
            }
            const meta = [];
            if (m.source && I18N['src_' + m.source]) meta.push(I18N['src_' + m.source]);
            if (meta.length) wrap.appendChild(el('p', 'hz-companion__source', meta.join(' · ')));
            if (m.disclaimer) {
                const d = el('p', 'hz-companion__disclaimer');
                const icon = el('i', 'fas fa-scale-balanced');
                icon.setAttribute('aria-hidden', 'true');
                d.appendChild(icon);
                d.appendChild(document.createTextNode(' ' + m.disclaimer));
                wrap.appendChild(d);
            }
        }
        return wrap;
    }
    function renderWelcome() {
        const w = el('div', 'hz-companion__msg is-bot hz-companion__welcome');
        const b = el('div', 'hz-companion__bubble');
        b.appendChild(el('p', null, I18N.welcome || ''));
        if (I18N.welcomeNote) b.appendChild(el('p', 'hz-companion__small', I18N.welcomeNote));
        w.appendChild(b);
        return w;
    }
    function renderAll() {
        thread.textContent = '';
        thread.appendChild(renderWelcome());
        history.forEach((m) => thread.appendChild(renderMessage(m)));
        scrollDown();
    }
    function scrollDown() {
        thread.scrollTop = thread.scrollHeight;
    }
    function append(m) {
        history.push(m);
        saveHistory(history);
        thread.appendChild(renderMessage(m));
        scrollDown();
    }

    function renderChips(list) {
        chips.textContent = '';
        (list || []).slice(0, 5).forEach((s) => {
            const b = el('button', 'hz-companion__chip', s);
            b.type = 'button';
            b.addEventListener('click', () => ask(s));
            chips.appendChild(b);
        });
    }

    function setBusy(on) {
        busy = on;
        typing.hidden = !on;
        send.disabled = on;
        input.setAttribute('aria-busy', on ? 'true' : 'false');
        root.classList.toggle('is-busy', on);
    }

    // ── Network ──────────────────────────────────────────────────────────
    function loadSuggestions() {
        if (suggestionsLoaded) return;
        suggestionsLoaded = true;
        fetch('/api/companion/suggestions?path=' + encodeURIComponent(pagePath), {
            credentials: 'same-origin',
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
                if (j && Array.isArray(j.suggestions)) renderChips(j.suggestions);
            })
            .catch(() => {
                suggestionsLoaded = false;
            });
    }

    function ask(text) {
        const q = String(text || '').trim();
        if (!q || busy) return;
        if (q.length > MAX) {
            append({ role: 'bot', text: I18N.tooLong || '500 max' });
            return;
        }
        append({ role: 'user', text: q });
        input.value = '';
        setBusy(true);
        fetch('/api/companion/ask', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'x-csrf-token': csrf,
            },
            body: JSON.stringify({ question: q, path: pagePath }),
        })
            .then((r) =>
                r
                    .json()
                    .catch(() => ({}))
                    .then((j) => ({ ok: r.ok, j }))
            )
            .then(({ ok, j }) => {
                if (!ok || !j || !j.ok) {
                    append({ role: 'bot', text: (j && j.error) || I18N.error });
                    return;
                }
                append({
                    role: 'bot',
                    text: j.answer,
                    links: j.links,
                    source: j.source,
                    disclaimer: j.disclaimer || null,
                });
                if (Array.isArray(j.suggestions) && j.suggestions.length)
                    renderChips(j.suggestions);
            })
            .catch(() => append({ role: 'bot', text: I18N.error }))
            .then(() => {
                setBusy(false);
                if (!window.matchMedia || !window.matchMedia('(max-width: 600px)').matches)
                    input.focus();
            });
    }

    // ── Wiring ───────────────────────────────────────────────────────────
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        ask(input.value);
    });
    input.addEventListener('keydown', (e) => {
        // Enter sends; Shift+Enter keeps a new line.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            ask(input.value);
        }
    });
    clearBtn.addEventListener('click', () => {
        history = [];
        clearHistory();
        renderAll();
        input.focus();
    });
    if (fab)
        fab.addEventListener('click', () => {
            markSeen();
            loadSuggestions();
        });
    const tab = document.querySelector('.help-tab[data-target="tab-assistant"]');
    if (tab)
        tab.addEventListener('click', () => {
            loadSuggestions();
            input.focus();
        });

    renderAll();
});
