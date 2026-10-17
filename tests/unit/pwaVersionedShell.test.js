'use strict';

/**
 * Installable app: the manifests are served from branding, the service
 * worker's cache is named after the deploy (?v=<assetVersion>) and precaches
 * the versioned addresses the pages actually request, and a versioned
 * stylesheet or script is immutable in production.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadWorker(href) {
    const listeners = {};
    const self = {
        location: { href, origin: 'https://app.example.test' },
        addEventListener: (k, fn) => (listeners[k] = fn),
        clients: { matchAll: async () => [], claim: async () => {} },
        skipWaiting: async () => {},
    };
    const code =
        read('public/service-worker.js') + '\n;self.__probe = { CACHE, SHELL, SW_VERSION };';
    vm.runInNewContext(code, { self, URL, encodeURIComponent, caches: {}, fetch: () => {} });
    return { probe: self.__probe, listeners };
}

describe('service worker cache tied to the deploy', () => {
    test('the cache name and the precache follow ?v=', () => {
        const { probe } = loadWorker('https://app.example.test/service-worker.js?v=abc123');
        expect(probe.CACHE).toBe('app-shell-abc123');
        expect(probe.SHELL).toContain('/css/style.css?v=abc123');
        expect(probe.SHELL).toContain('/js/notif-open.js?v=abc123');
        // requested without ?v= by their pages
        expect(probe.SHELL).toContain('/offline.html');
        expect(probe.SHELL).toContain('/js/offline.js');
        expect(probe.SHELL).toContain('/manifest.fr.webmanifest');
    });
    test('without ?v= the worker still has a fixed fallback name', () => {
        const { probe } = loadWorker('https://app.example.test/service-worker.js');
        expect(probe.CACHE).toMatch(/^app-shell-v\d+$/);
        expect(probe.SHELL).toContain('/css/style.css');
    });
    test('pwa-head registers the worker with the asset version', () => {
        expect(read('views/partials/pwa-head.ejs')).toMatch(
            /\/service-worker\.js\?v=<%= encodeURIComponent\(typeof assetVersion !== 'undefined' \? assetVersion : ''\) %>/
        );
    });
});

describe('server wiring', () => {
    const server = read('server.js');
    test('the manifests are served by a route before express.static, from fixed file names', () => {
        const route = server.indexOf('app.get([...MANIFEST_FILES.keys()]');
        const stat = server.indexOf("express.static(path.join(__dirname, 'public')");
        expect(route).toBeGreaterThan(0);
        expect(route).toBeLessThan(stat);
        for (const f of [
            'manifest.webmanifest',
            'manifest.fr.webmanifest',
            'manifest.en.webmanifest',
        ])
            expect(server).toContain(`['/${f}', '${f}']`);
        expect(server).toMatch(/getBranding\(\)/);
        expect(server).toMatch(/PRODUCT\.fullName/);
    });
    test('a ?v= stylesheet or script is immutable in production, and the hash covers them all', () => {
        expect(server).toMatch(/public, max-age=31536000, immutable/);
        expect(server).toMatch(/res\.req\.query\.v === app\.locals\.assetVersion/);
        expect(server).toMatch(/for \(const dir of \['public\/css', 'public\/js'\]\)/);
    });
});
