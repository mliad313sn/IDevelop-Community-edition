'use strict';

/**
 * Product rule (2026-09-21): the campaign window locks a FINALISED verdict, not
 * work still in progress.
 *
 *   - An assessment that is NOT yet approved can be changed even outside its
 *     campaign — a closed or locked campaign must not freeze a draft/submitted/
 *     reviewed round that nobody has finalised.
 *   - An assessment that IS approved can be modified only during an open
 *     campaign (reopen / cancel / re-decide); the normal route is a change
 *     request, itself gated by the same door.
 *
 * The single write-gate is SelfAssessmentWorkflowService._setState. Before this
 * rule it refused EVERY transition once the campaign closed/locked, regardless of
 * state. It now applies the campaign gate only when the CURRENT workflow_state is
 * 'approved'. Off-campaign rounds (cycle_id null) stay always-writable (A6).
 *
 * Proven on idevelop by forcing the fixture cycle's status inside a rolled-back
 * transaction, so no persisted state changes.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const norm = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\s+/g, ' ');

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
let svc;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
    svc = require('../../src/services/SelfAssessmentWorkflowService');
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

// Run one _setState transition against a fixture round whose campaign has been
// forced to `cycleStatus`, inside a transaction that always rolls back. Returns
// 'ALLOWED' if the gate let it through, or the gate's error code if it blocked.
async function attempt(roundId, cycleId, cycleStatus, toState, extra) {
    let outcome = 'ALLOWED';
    try {
        await db.runTransaction(async () => {
            await db.run('UPDATE assessment_cycles SET status = ? WHERE id = ?', [
                cycleStatus,
                cycleId,
            ]);
            await svc._setState(roundId, toState, extra);
            throw new Error('__ROLLBACK__');
        });
    } catch (e) {
        if (/__ROLLBACK__/.test(e.message)) outcome = 'ALLOWED';
        else outcome = e.code || e.message;
    }
    return outcome;
}

suite('assessment edit gating by approval and campaign', () => {
    let draft = null; // a not-yet-approved round bound to a campaign
    let approved = null; // an approved round bound to a campaign

    beforeAll(async () => {
        draft = await db.get(
            `SELECT id, cycle_id AS "cycleId" FROM self_assessment_rounds
              WHERE workflow_state = 'draft' AND cycle_id IS NOT NULL AND superseded_at IS NULL LIMIT 1`
        );
        approved = await db.get(
            `SELECT id, cycle_id AS "cycleId" FROM self_assessment_rounds
              WHERE workflow_state = 'approved' AND cycle_id IS NOT NULL AND superseded_at IS NULL LIMIT 1`
        );
    });

    test('the fixtures exist (guards against a vacuous suite)', () => {
        expect(draft && draft.id).toBeTruthy();
        expect(approved && approved.id).toBeTruthy();
    });

    test('a not-yet-approved round submits even when its campaign is CLOSED', async () => {
        const r = await attempt(draft.id, draft.cycleId, 'closed', 'submitted', {
            status: 'submitted',
        });
        expect(r).toBe('ALLOWED');
    });

    test('a not-yet-approved round submits even when its campaign is LOCKED', async () => {
        const r = await attempt(draft.id, draft.cycleId, 'locked', 'submitted', {
            status: 'submitted',
        });
        expect(r).toBe('ALLOWED');
    });

    test('an approved round CANNOT be reopened while its campaign is closed', async () => {
        const r = await attempt(approved.id, approved.cycleId, 'closed', 'draft', {
            status: 'draft',
        });
        expect(r).toBe('cycle_write_closed');
    });

    test('an approved round CANNOT be reopened while its campaign is locked', async () => {
        // 'draft' is not a review-write state, so a locked campaign refuses it.
        const r = await attempt(approved.id, approved.cycleId, 'locked', 'draft', {
            status: 'draft',
        });
        expect(r).toBe('cycle_write_locked');
    });

    test('an approved round CAN be reopened while a campaign is open', async () => {
        const r = await attempt(approved.id, approved.cycleId, 'open', 'draft', {
            status: 'draft',
        });
        expect(r).toBe('ALLOWED');
    });
});

describe('the write-gate is conditioned on the approved state', () => {
    const src = norm('src/services/SelfAssessmentWorkflowService.js');
    const seg = (() => {
        const i = src.indexOf('async _setState(');
        return src.slice(i, i + 3000);
    })();

    test('_assertCycleWritable runs only when the current state is approved', () => {
        expect(seg).toMatch(/workflow_state AS "workflowState" FROM self_assessment_rounds/);
        expect(seg).toMatch(
            /if \(cur && cur\.workflowState === 'approved'\) \{\s*await this\._assertCycleWritable/
        );
    });
});
