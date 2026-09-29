/* eslint-env browser */
/**
 *   sync-indicator.js — listens for browser online/offline events, shows
 *   a status pill, and replays pending drafts via exponential backoff:
 *   1s → 2 → 4 → 8 → 16 → 30 (cap).  Companion to draft-store.js.
 */

(function () {
    'use strict';

    const POST_URL = '/employee/self-assessment/save-draft';

    /**
     * Whose drafts this page may replay.
     *
     * The replay POSTs with `credentials: 'same-origin'` and the server writes to
     * `req.user.id`, so replaying somebody else's stored drafts silently files
     * THEIR ratings and written justifications under the CURRENT user. On a shared
     * site tablet that is exactly what happened: person A worked offline and signed
     * out, person B signed in, and A's answers landed in B's assessment under a
     * "✓ synced" badge. An unknown owner replays nothing.
     */
    const ownerId = () => (window.APP_DRAFT_OWNER == null ? '' : String(window.APP_DRAFT_OWNER));
    const MAX_BACKOFF_MS = 30_000;

    const GREEN = '#1b7e3a';
    const BLUE = '#1b56b8';
    const RED = '#c62828';
    const AMBER = '#b45309';

    let pill;
    function ensurePill() {
        if (pill) return pill;
        pill = document.createElement('div');
        pill.id = 'sync-pill';
        // A status that changes on its own must be announced, or a screen-reader
        // user never learns their work failed to save.
        pill.setAttribute('role', 'status');
        pill.setAttribute('aria-live', 'polite');
        pill.style.cssText =
            'position:fixed;bottom:16px;right:16px;padding:6px 12px;border-radius:16px;' +
            'font:13px system-ui;color:#fff;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.25)';
        document.body.appendChild(pill);
        return pill;
    }
    function setLabel(text, bg) {
        const p = ensurePill();
        p.textContent = text;
        p.style.background = bg;
    }

    /**
     * Report the TRUE state by re-reading the store, never by assuming the replay
     * loop succeeded. The loop breaks out of a row on a 4xx and on going offline
     * mid-replay, in both cases WITHOUT marking that row synced — so declaring
     * "✓ synced" at the end told a supervisor on a remote site that their
     * assessment was saved when it was still only on their phone. On this product
     * that is the most damaging thing a status pill can do.
     */
    async function reportActualState() {
        let left = [];
        try {
            left = await window.AppDraftStore.listPending(ownerId());
        } catch (_) {
            /* store unreadable */
        }
        if (!left.length) {
            setLabel('✓ synced', GREEN);
            return;
        }
        if (!navigator.onLine) {
            setLabel(`offline — ${left.length} draft(s) stored on this device`, RED);
            return;
        }
        setLabel(`⚠ ${left.length} draft(s) NOT saved — retry`, AMBER);
    }

    async function replay() {
        if (!window.AppDraftStore) return;
        const owner = ownerId();
        if (!owner) return; // cannot attribute the drafts — never guess an owner
        const pending = await window.AppDraftStore.listPending(owner);
        if (!pending.length) return setLabel('✓ synced', GREEN);

        setLabel(`↻ syncing ${pending.length}…`, BLUE);
        let backoff = 1000;
        for (const row of pending) {
            for (;;) {
                try {
                    // The server's save-draft endpoint expects { assessments: [{skillId, selfRatedLevel, notes}] }.
                    // draft-store rows use {skillId, level, justification} — translate here so replay doesn't 400.
                    // `cycleId` travels with the draft: the server refuses to file
                    // work captured in one campaign into a later one, rather than
                    // silently re-dating it.
                    const payload = {
                        cycleId: row.cycleId || null,
                        assessments: [
                            {
                                skillId: row.skillId,
                                selfRatedLevel: row.level,
                                notes: row.justification || null,
                            },
                        ],
                    };
                    const r = await fetch(POST_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                        credentials: 'same-origin',
                    });
                    if (r.ok) {
                        await window.AppDraftStore.markSynced(row.key);
                        break;
                    }
                    if (r.status >= 400 && r.status < 500) break; // do not retry client errors
                } catch (_) {
                    /* offline; fall through to wait */
                }
                await new Promise((res) => setTimeout(res, backoff));
                backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
                if (!navigator.onLine) break; // wait for online event
            }
        }
        await reportActualState();
    }

    window.addEventListener('online', () => {
        setLabel('online', GREEN);
        replay();
    });
    window.addEventListener('offline', () => setLabel('offline — draft stored locally', RED));
    window.addEventListener('load', () => {
        setLabel(navigator.onLine ? 'online' : 'offline', navigator.onLine ? GREEN : RED);
        if (navigator.onLine) replay();
    });
})();
