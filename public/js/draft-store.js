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

    async function put({ userId, cycleId, skillId, level, justification }) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({
                key: `${userId}:${cycleId}:${skillId}`,
                userId,
                cycleId,
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

    global.AppDraftStore = { put, listPending, markSynced };
})(window);
