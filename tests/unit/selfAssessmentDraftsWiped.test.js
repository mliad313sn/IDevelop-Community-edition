'use strict';
/**
 * Self-assessment drafts no longer stay on the device: an accepted save leaves
 * no copy, a failed one is queued (cycleId null outside a campaign), and a
 * sign-out sets app_drafts_wipe=<id> so the next load of draft-store.js removes
 * that person's rows. Template / client-script assertions, plus draft-store.js
 * run against a small in-memory IndexedDB.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('the page queues only what could not be sent', () => {
    const view = read('views/pages/employee/self-assessment.ejs');
    test('a change is written to the device only while offline', () => {
        expect(view).toMatch(
            /function noteChange\(s\) \{\s*dirty\.add\(s\);\s*if \(!navigator\.onLine\) cacheDraft\(s\);/
        );
        expect(view).not.toMatch(/addEventListener\('change', \(\) => \{ cacheDraft\(s\)/);
    });
    test('an accepted save removes the local copies; a failed one queues them', () => {
        expect(view).toMatch(/forgetSaved\(sent\.map\(\(a\) => a\.skillId\), result\.skipped\)/);
        expect(view).toMatch(/catch \(e\) \{\s*queueDirty\(\);/);
        expect(view).toMatch(/if \(res\.status >= 500\) queueDirty\(\);/);
        expect(view).toMatch(
            /addEventListener\('pagehide', \(\) => \{ if \(dirty\.size\) queueDirty\(\); \}\)/
        );
    });
    test('the real campaign id (or null), never ""', () => {
        expect(view).toMatch(/const SA_CYCLE_ID = <%- JSON\.stringify\(/);
    });
});

describe('draft-store: markSyncedFor / wipeOwner / sign-out cookie', () => {
    // A tiny in-memory IndexedDB, enough for draft-store's calls.
    function fakeIndexedDB() {
        const dbs = {};
        const req = (fn) => {
            const r = {};
            setTimeout(() => {
                try {
                    r.result = fn();
                    r.onsuccess && r.onsuccess();
                } catch (e) {
                    r.error = e;
                    r.onerror && r.onerror();
                }
            }, 0);
            return r;
        };
        function makeDb(name) {
            const stores = dbs[name] || (dbs[name] = {});
            return {
                objectStoreNames: { contains: (s) => !!stores[s] },
                createObjectStore: (s) => (stores[s] = new Map()),
                close() {},
                transaction(s) {
                    const tx = {};
                    const map = stores[s];
                    tx.objectStore = () => ({
                        put: (v) => map.set(v.key, v),
                        add: (v) => !map.has(v.key) && map.set(v.key, v),
                        delete: (k) => map.delete(k),
                        getAll: () => req(() => [...map.values()]),
                    });
                    setTimeout(() => tx.oncomplete && tx.oncomplete(), 5);
                    return tx;
                },
            };
        }
        return {
            dbs,
            databases: async () => Object.keys(dbs).map((name) => ({ name })),
            deleteDatabase: (n) => delete dbs[n],
            open(name) {
                const r = {};
                setTimeout(() => {
                    const fresh = !dbs[name];
                    r.result = makeDb(name);
                    if (fresh && r.onupgradeneeded) r.onupgradeneeded();
                    r.onsuccess && r.onsuccess();
                }, 0);
                return r;
            },
        };
    }
    function load(cookie) {
        const idb = fakeIndexedDB();
        const doc = { cookie };
        const win = {};
        const sandbox = {
            window: win,
            indexedDB: idb,
            document: doc,
            location: { protocol: 'http:' },
            setTimeout,
            Promise,
        };
        vm.createContext(sandbox);
        vm.runInContext(read('public/js/draft-store.js'), sandbox);
        return { store: win.AppDraftStore, idb, doc };
    }

    test('put normalises "" to null; markSyncedFor removes exactly that draft', async () => {
        const { store } = load('');
        await store.wipeDone;
        await store.put({
            userId: '138',
            cycleId: '',
            skillId: '308',
            level: '2',
            justification: 'x',
        });
        await store.put({
            userId: '138',
            cycleId: '7',
            skillId: '309',
            level: '1',
            justification: '',
        });
        let rows = await store.listPending('138');
        expect(rows.find((r) => r.skillId === '308').cycleId).toBe(null);
        await store.markSyncedFor({ userId: '138', cycleId: null, skillId: '308' });
        rows = await store.listPending('138');
        expect(rows.map((r) => r.skillId)).toEqual(['309']);
    });

    test("wipeOwner removes that person's drafts only", async () => {
        const { store } = load('');
        await store.wipeDone;
        await store.put({ userId: '138', cycleId: null, skillId: '1', level: '1' });
        await store.put({ userId: '139', cycleId: null, skillId: '1', level: '1' });
        expect(await store.wipeOwner('138')).toBe(1);
        expect((await store.listPending('138')).length).toBe(0);
        expect((await store.listPending('139')).length).toBe(1);
    });

    test('the sign-out cookie triggers the wipe once and is cleared', async () => {
        const first = load('');
        await first.store.wipeDone;
        await first.store.put({ userId: '138', cycleId: null, skillId: '1', level: '1' });
        // same device, next page, cookie set by the sign-out
        const doc = { cookie: 'lang=fr; app_drafts_wipe=138' };
        const sandbox = {
            window: {},
            indexedDB: first.idb,
            document: doc,
            location: { protocol: 'http:' },
            setTimeout,
            Promise,
        };
        vm.createContext(sandbox);
        vm.runInContext(read('public/js/draft-store.js'), sandbox);
        expect(await sandbox.window.AppDraftStore.wipeDone).toBe(1);
        expect((await sandbox.window.AppDraftStore.listPending('138')).length).toBe(0);
        expect(doc.cookie).toMatch(/^app_drafts_wipe=; path=\/; max-age=0/);
    });
});

describe('sync-indicator waits for a sign-out wipe before replaying', () => {
    test('wipeDone is awaited before listPending', () => {
        const src = read('public/js/sync-indicator.js');
        const w = src.indexOf('await window.AppDraftStore.wipeDone');
        const l = src.indexOf('await window.AppDraftStore.listPending(owner)');
        expect(w).toBeGreaterThan(0);
        expect(l).toBeGreaterThan(w);
    });
});
