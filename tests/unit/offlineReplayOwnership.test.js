'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * AMDEC L5-3 (criticality 324) and L5-5 (315) — the offline replay.
 *
 * L5-3  `listPending()` returned EVERY pending draft on the device, and the replay
 *       POSTs with `credentials: 'same-origin'` while the server writes to
 *       `req.user.id`. On a shared site tablet: person A rates skills offline and
 *       signs out, person B signs in, the network returns — and A's ratings AND
 *       their written justifications are filed into B's self-assessment, under a
 *       "✓ synced" badge. A's personal data lands in B's record and B's assessment
 *       is falsified. The IndexedDB key had carried the user id all along; nothing
 *       read it. `markSynced` also only flagged rows, so A's written text stayed
 *       readable on the device indefinitely.
 *       G=9, O=4, D=9.
 *
 * L5-5  The replay sent no `cycleId`, so the server re-resolved "the open campaign"
 *       at replay time: a draft captured during campaign N and replayed after N+1
 *       opened was filed into N+1 — answers about one period recorded against
 *       another. Verified: a replay claiming campaign 8 while 9 is open is now
 *       refused (`cycle_changed`); claiming 9 is accepted; the live page, which
 *       claims nothing, is unaffected.
 *       (Its other half — the write forcing an approved row back to draft — is
 *       already closed by the editable-state guard, AMDEC #1.)
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

describe('a replay only ever sends its own drafts (L5-3)', () => {
    const store = read('public/js/draft-store.js');
    const sync = read('public/js/sync-indicator.js');

    test('listPending requires an owner', () => {
        expect(store).toMatch(/async function listPending\(ownerId\)/);
        expect(store).toMatch(/if \(!owner\) return \[\];/);
    });

    test('it filters on the user id the key already carried', () => {
        expect(store).toMatch(/r\.pendingSync && String\(r\.userId\) === owner/);
    });

    test('an unknown owner replays nothing rather than everything', () => {
        expect(sync).toMatch(/if \(!owner\) return; \/\/ cannot attribute the drafts/);
    });

    test('the owner is published where the library files can read it', () => {
        // SA_USER_ID is script-scoped in the page, so it was invisible here.
        const view = read('views/pages/employee/self-assessment.ejs');
        expect(view).toMatch(/window.APP_DRAFT_OWNER = '<%= user && user\.id \? user\.id : "" %>'/);
        expect(sync).toMatch(
            /const ownerId = \(\) => \(window.APP_DRAFT_OWNER == null \? '' : String\(window.APP_DRAFT_OWNER\)\)/
        );
    });

    test('both call sites pass the owner', () => {
        const calls = sync.match(/listPending\((ownerId\(\)|owner)\)/g) || [];
        expect(calls.length).toBe(2);
        expect(sync).not.toMatch(/listPending\(\)/);
    });

    test('a synced draft is deleted, not left readable on the device', () => {
        expect(store).toMatch(/tx\.objectStore\(STORE\)\.delete\(key\)/);
        expect(store).not.toMatch(/row\.pendingSync = false;\s*\n\s*row\.syncedAt/);
    });

    test("another user's unsynced work is NOT purged", () => {
        // Deleting it to tidy the device would destroy work that will replay
        // correctly once that person signs back in.
        expect(store).toMatch(/Drafts belonging to OTHER users are deliberately left alone/);
    });
});

describe('a draft cannot be re-filed into a later campaign (L5-5)', () => {
    const svc = read('src/services/SelfAssessmentService.js');

    test('the write refuses a campaign mismatch', () => {
        expect(svc).toMatch(
            /if \(expectedCycleId != null && String\(expectedCycleId\) !== String\(cycleId\)\)/
        );
        expect(svc).toMatch(/return \{ skipped: true, reason: 'cycle_changed'/);
    });

    test('the live page, which claims no campaign, is unaffected', () => {
        expect(svc).toMatch(/expectedCycleId = null,?\s*\)/);
    });

    test('the replay states the campaign the draft was captured in', () => {
        const sync = read('public/js/sync-indicator.js');
        expect(sync).toMatch(/cycleId: row\.cycleId \|\| null/);
        const view = read('views/pages/employee/self-assessment.ejs');
        expect(view).toMatch(
            /const SA_CYCLE_ID = '<%= typeof cycle !== "undefined" && cycle && cycle\.id \? cycle\.id : "" %>'/
        );
    });

    test('a fully refused save answers 409, never a blanket success', () => {
        // A green sync badge over a refused write is the exact failure this path
        // exists to prevent.
        const ctrl = read('src/controllers/EmployeePortalController.js');
        expect(ctrl).toMatch(/if \(skipped\.length === assessments\.length\)/);
        expect(ctrl).toMatch(/res\.status\(409\)\.json\(\{/);
        expect(ctrl).toMatch(
            /code: skipped\[0\]\.reason === 'cycle_changed' \? 'cycle_changed' : 'not_editable'/
        );
    });
});
