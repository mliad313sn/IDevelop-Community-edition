/* eslint-env browser */
/**
 *   sync-indicator.js — listens for browser online/offline events, shows
 *   a status pill, and replays pending drafts via exponential backoff:
 *   1s → 2 → 4 → 8 → 16 → 30 (cap).  Companion to draft-store.js.
 *
 *   The labels come from the page (JSON block #syncI18n, employee locale), never
 *   hard-coded English; the tones are CSS classes on the design tokens
 *   (self-assessment.css), never hex; the pill docks in the page's action bar
 *   (#saSyncSlot) instead of floating over the content. It is QUIET by default:
 *   shown while offline, while sending, when something is NOT saved, or for 3 s
 *   after a send went through — and silent on a read-only page (a locked
 *   campaign), where nothing can be saved.
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
    const OK_LINGER_MS = 3000;

    // French first when a page does not provide its labels.
    const FALLBACK = {
        locked: false,
        synced: '✓ Enregistré',
        online: 'En ligne',
        offline: 'Hors ligne — vos réponses restent sur cet appareil',
        offlineOne: 'Hors ligne — %n% réponse conservée sur cet appareil',
        offlineOther: 'Hors ligne — %n% réponses conservées sur cet appareil',
        syncingOne: 'Envoi de %n% réponse…',
        syncingOther: 'Envoi de %n% réponses…',
        failedOne: '⚠ %n% réponse NON enregistrée — nouvel essai automatique',
        failedOther: '⚠ %n% réponses NON enregistrées — nouvel essai automatique',
    };
    function labels() {
        let L = {};
        try {
            const el = document.getElementById('syncI18n');
            if (el) L = JSON.parse(el.textContent || '{}') || {};
        } catch (_) {
            L = {};
        }
        return Object.assign({}, FALLBACK, L);
    }
    const T = labels();
    const plural = (n, one, other) => String(n === 1 ? T[one] : T[other]).replace('%n%', String(n));

    let pill;
    let lingerTimer = null;
    function ensurePill() {
        if (pill) return pill;
        pill = document.createElement('span');
        pill.id = 'sync-pill';
        pill.className = 'sync-pill';
        pill.hidden = true;
        // A status that changes on its own must be announced, or a screen-reader
        // user never learns their work failed to save.
        pill.setAttribute('role', 'status');
        pill.setAttribute('aria-live', 'polite');
        const slot = document.getElementById('saSyncSlot');
        (slot || document.body).appendChild(pill);
        return pill;
    }
    /** tone: ok | busy | offline | failed. `linger`: hide again after 3 s. */
    function setLabel(text, tone, linger) {
        if (T.locked) return; // read-only page: nothing here can be saved
        const p = ensurePill();
        clearTimeout(lingerTimer);
        p.textContent = text;
        p.className = 'sync-pill sync-pill--' + tone;
        p.hidden = false;
        if (linger) {
            lingerTimer = setTimeout(() => {
                p.hidden = true;
            }, OK_LINGER_MS);
        }
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
            setLabel(T.synced, 'ok', true);
            return;
        }
        if (!navigator.onLine) {
            setLabel(plural(left.length, 'offlineOne', 'offlineOther'), 'offline');
            return;
        }
        setLabel(plural(left.length, 'failedOne', 'failedOther'), 'failed');
    }

    async function replay() {
        if (T.locked) return; // a locked campaign refuses every save (409)
        if (!window.AppDraftStore) return;
        const owner = ownerId();
        if (!owner) return; // cannot attribute the drafts — never guess an owner
        // A sign-out wipe still in progress finishes first: a draft the
        // person's own sign-out removed is never replayed.
        if (window.AppDraftStore.wipeDone) await window.AppDraftStore.wipeDone;
        const pending = await window.AppDraftStore.listPending(owner);
        if (!pending.length) return; // nothing to send: stay quiet

        setLabel(plural(pending.length, 'syncingOne', 'syncingOther'), 'busy');
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
        setLabel(T.online, 'ok', true);
        replay();
    });
    window.addEventListener('offline', () => setLabel(T.offline, 'offline'));
    window.addEventListener('load', () => {
        if (!navigator.onLine) setLabel(T.offline, 'offline');
        else replay();
    });
})();
