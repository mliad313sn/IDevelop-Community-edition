/* eslint-env browser */
/**
 *   draft-store.js — IndexedDB-backed local cache for self-assessment
 *   drafts.  Keyed by `${userId}:${cycleId}:${skillId}`.  Used by
 *   /employee/self-assessment to survive network drops on remote sites.
 *   Companion to sync-indicator.js.
 */

(function (global) {
    'use strict';

    const DB_NAME = 'app_drafts';
    const STORE = 'drafts';
    const DB_VERSION = 1;

    function openNamed(name, upgrade) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(name, DB_VERSION);
            if (upgrade) req.onupgradeneeded = () => upgrade(req.result);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function createStore(db) {
        if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'key' });
        }
    }

    async function openDb() {
        return openNamed(DB_NAME, createStore);
    }

    // The REAL campaign id, or null for a rating filed outside any campaign —
    // never the empty string the page used to send.
    function normCycle(cycleId) {
        return cycleId == null || cycleId === '' ? null : String(cycleId);
    }
    function keyOf(userId, cycleId, skillId) {
        return `${userId}:${normCycle(cycleId) == null ? '' : normCycle(cycleId)}:${skillId}`;
    }

    async function put({ userId, cycleId, skillId, level, justification }) {
        const db = await openDb();
        const cycle = normCycle(cycleId);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({
                key: keyOf(userId, cycle, skillId),
                userId,
                cycleId: cycle,
                skillId,
                level,
                justification,
                updatedAt: Date.now(),
                pendingSync: true,
            });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Pending drafts belonging to ONE user.
     *
     * `ownerId` is required. This used to return every pending row on the device
     * regardless of who saved it, and the replay POSTs them under whatever session
     * is open — so on a shared site tablet the ratings and written justifications
     * one person saved offline were written into the NEXT person's self-assessment,
     * under a "✓ synced" badge. The key has always carried the user id; nothing
     * read it.
     *
     * An unknown owner returns nothing rather than everything: a replay that cannot
     * establish whose work it is holds the drafts until the right person signs in.
     */
    async function listPending(ownerId) {
        const owner = ownerId == null ? '' : String(ownerId);
        if (!owner) return [];
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).getAll();
            req.onsuccess = () =>
                resolve(
                    (req.result || []).filter((r) => r.pendingSync && String(r.userId) === owner)
                );
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * A draft that reached the server is DELETED, not flagged.
     *
     * Flagging left the rating and the written justification readable in IndexedDB
     * for whoever used the device next — on a shared site tablet, indefinitely.
     * The server now holds the record, so the local copy has no further purpose.
     *
     * Drafts belonging to OTHER users are deliberately left alone: they may be
     * unsynced work that will replay when that person signs back in, and deleting
     * them to tidy the device would destroy it.
     */
    async function markSynced(key) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * A rating that the server ACCEPTED while online leaves no copy on the
     * device — the page calls this after each successful save.
     */
    async function markSyncedFor({ userId, cycleId, skillId }) {
        return markSynced(keyOf(userId, cycleId, skillId));
    }

    /**
     * At sign-out, every draft of THAT person is removed from the device (shared
     * computer or not). Other people's rows are untouched.
     */
    async function wipeOwner(ownerId) {
        const owner = ownerId == null ? '' : String(ownerId);
        if (!owner) return 0;
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const os = tx.objectStore(STORE);
            let n = 0;
            const req = os.getAll();
            req.onsuccess = () => {
                (req.result || []).forEach((r) => {
                    if (r && String(r.userId) === owner) {
                        os.delete(r.key);
                        n++;
                    }
                });
            };
            tx.oncomplete = () => resolve(n);
            tx.onerror = () => reject(tx.error);
        });
    }

    // The sign-out response names whose drafts to remove (cookie app_drafts_wipe,
    // a numeric id, 10 minutes). Whatever page loads this file next — the login
    // page right after the redirect — honours it once and clears the cookie.
    const WIPE_COOKIE = 'app_drafts_wipe';
    function pendingWipe() {
        const m = /(?:^|;\s*)app_drafts_wipe=(\d{1,12})(?:;|$)/.exec(document.cookie || '');
        return m ? m[1] : null;
    }
    function clearWipeCookie() {
        const secure = location.protocol === 'https:' ? '; secure' : '';
        document.cookie = WIPE_COOKIE + '=; path=/; max-age=0; samesite=lax' + secure;
    }
    const wipeDone = (function () {
        const owner = pendingWipe();
        if (!owner || typeof indexedDB === 'undefined') return Promise.resolve(0);
        return wipeOwner(owner)
            .catch(() => 0)
            .then((n) => {
                clearWipeCookie();
                return n;
            });
    })();

    global.AppDraftStore = { put, listPending, markSynced, markSyncedFor, wipeOwner, wipeDone };
})(window);
