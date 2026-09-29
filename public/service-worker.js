/* eslint-env serviceworker */
/**
 * Offline shell for field use on mine sites.
 *
 * WHAT IT CACHES, AND WHY THE LIST IS SO SHORT
 *   Static assets ONLY. Never an HTML page, never a data response.
 *
 *   The earlier version cached every HTML response and every data response it
 *   saw. On this product that is a confidentiality bug, not an optimisation:
 *   every page here is RBAC-scoped to one signed-in person, and the server
 *   deliberately sends `Cache-Control: no-store` on them (server.js) precisely
 *   so that nothing — proxy, bfcache, or service worker — keeps a copy. A cache
 *   that ignores that puts one user's employee data on disk, where the next
 *   person to open the app on a shared site tablet can be served it after
 *   logout, offline, with no session at all.
 *
 *   So the rule is absolute: if a response could differ between two signed-in
 *   users, it is not cached here. Offline capability for the DATA a field
 *   supervisor is capturing lives in IndexedDB instead (public/js/draft-store.js),
 *   which is keyed per user and replayed by sync-indicator.js.
 *
 * WHAT OFFLINE THEREFORE MEANS
 *   The app shell loads (styles, scripts, fonts, the offline notice), and
 *   self-assessment drafts keep saving locally. Pages needing server data show
 *   the offline page rather than a stale copy of someone's record.
 */

const CACHE = 'app-shell-v6'; // v6 (3.23.21): + sa-skill-help.js/.css

// Bumped whenever the caching RULES change, so an old worker's cache is discarded
// wholesale by the activate handler rather than lingering with stale semantics.
const SW_VERSION = 'v4';

// Cache-first, and safe to do so: none of these vary by user.
const SHELL = [
    '/manifest.webmanifest',
    '/css/style.css',
    '/css/a11y-polish.css',
    '/js/draft-store.js',
    '/js/sync-indicator.js',
    // 3.23.21: the self-assessment help runs offline too (descriptions themselves
    // are server-rendered into the page, which is never cached).
    '/js/sa-skill-help.js',
    '/css/sa-skill-help.css',
    '/offline.html',
];

const STATIC_PREFIXES = [
    '/css/',
    '/js/',
    '/vendor/',
    '/img/',
    '/fonts/',
    '/manifest.webmanifest',
    '/favicon',
];

// Never touched by the cache under any circumstances, belt-and-braces even
// though HTML and data are excluded by default below.
const NEVER = ['/api/', '/auth/', '/login', '/logout', '/v1/', '/branding/'];

// Last-resort offline page, used only if /offline.html could not be cached.
// Without this the browser shows its own error screen, which tells a supervisor
// on a mine site nothing about whether their drafts survived.
const FALLBACK_HTML =
    '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Hors connexion</title></head>' +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0A0C18;color:#E8E4D9;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px">' +
    '<div><h1 style="font-size:20px;margin:0 0 10px">Vous êtes hors connexion</h1>' +
    '<p style="color:#9A9386;margin:0 0 6px">Vos saisies restent enregistrées sur cet appareil.</p>' +
    '<p style="color:#9A9386;font-size:13px;opacity:.75">You are offline. Your drafts stay on this device.</p>' +
    '</div></body></html>';

const offlineResponse = () =>
    caches.match('/offline.html').then(
        (r) =>
            r ||
            new Response(FALLBACK_HTML, {
                status: 503,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                },
            })
    );

/**
 * Cache the shell.
 *
 * Explicit fetch + put rather than `cache.add()`. `add()` gives no way to see
 * WHICH entry failed or why, and during testing it silently cached nothing at
 * all while reporting success — a shell that appears fine and is empty is worse
 * than one that fails loudly. `cache: 'reload'` also guarantees the copy stored
 * is fresh from the server rather than whatever the HTTP cache was holding,
 * which matters right after a deploy.
 *
 * One entry failing must never fail the install (that would leave the app with
 * no worker at all), so each is caught individually — but the failures are
 * COUNTED and reported to any listening client instead of vanishing.
 */
function primeShell() {
    return caches.open(CACHE).then((c) =>
        Promise.all(
            SHELL.map((u) =>
                fetch(u, { cache: 'reload' })
                    .then((r) =>
                        r && r.ok
                            ? c.put(u, r.clone()).then(() => null)
                            : `${u} -> HTTP ${r && r.status}`
                    )
                    .catch((err) => `${u} -> ${err && err.message ? err.message : 'fetch failed'}`)
            )
        ).then((results) => {
            const failed = results.filter(Boolean);
            if (failed.length) {
                self.clients
                    .matchAll({ includeUncontrolled: true })
                    .then((cs) =>
                        cs.forEach((client) =>
                            client.postMessage({ type: 'sw-precache-failed', failed })
                        )
                    );
            }
            return failed;
        })
    );
}

self.addEventListener('install', (e) => {
    e.waitUntil(primeShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
            )
            // Re-prime on activate as well. A previous worker can still be
            // controlling during install and intercept these very requests, so an
            // install-time add can silently fail — observed in testing, with
            // /offline.html the casualty. By activate we are in control, so this
            // second attempt is the one that reliably lands.
            .then(() => primeShell())
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'sw-ping' && e.source) {
        e.source.postMessage({ type: 'sw-version', version: SW_VERSION, cache: CACHE });
    }
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;

    let url;
    try {
        url = new URL(req.url);
    } catch {
        return;
    }
    if (url.origin !== self.location.origin) return;
    if (NEVER.some((p) => url.pathname.startsWith(p))) return;

    // A navigation (an HTML page) is per-user: go to the network, and if the
    // network is gone show the offline notice. NEVER serve a cached page — that
    // would be another user's data, or this user's data after logout.
    if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
        e.respondWith(fetch(req).catch(() => offlineResponse()));
        return;
    }

    // Static assets only. Cache-first, and refreshed in the background so a
    // deploy is picked up without stranding the user on old CSS.
    if (STATIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
        e.respondWith(
            caches.match(req).then((cached) => {
                const network = fetch(req)
                    .then((r) => {
                        if (r && r.ok && r.type === 'basic') {
                            const copy = r.clone();
                            caches.open(CACHE).then((c) => c.put(req, copy));
                        }
                        return r;
                    })
                    .catch(() => cached);
                return cached || network;
            })
        );
        return;
    }

    // Everything else (data endpoints and anything unrecognised) — straight to
    // the network, never cached. Falling through without respondWith is the
    // safest default: the browser handles it as if no worker existed.
});
