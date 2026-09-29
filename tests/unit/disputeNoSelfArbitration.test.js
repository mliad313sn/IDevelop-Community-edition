'use strict';
/**
 * CODE-REVIEW-2026-09-17 [IMPORTANT/security]: « L'escalade N1 est résoluble
 * par le superviseur dont la note est contestée : la route ne vérifie que le
 * périmètre, le service ne vérifie rien ».
 *
 * Real. `resolveL1` accepted any `decidedBy`, and the route only required
 * userType 'manager' plus the employee being inside the caller's sub-tree —
 * both of which the CONTESTED supervisor satisfies. So a dispute opened
 * against supervisor S, escalated to L1 precisely because S had not answered,
 * was resolvable by S, with S's own rating, from S's own queue. The rung above
 * the supervisor was decided by the supervisor.
 *
 * The assessment workflow already refuses exactly this case — "the very
 * supervisor being arbitrated could approve the escalation away themselves" —
 * and the ladder did not.
 *
 * PROVEN BY EXECUTION on the dev database in a rolled-back transaction
 * (scratchpad/probe-dispute-self.js, 10/10): the contested reviewer is refused
 * 403 DISPUTE_SELF_REVIEW and the dispute is left untouched, while a different
 * decider still resolves it and is recorded as having done so. Removing the
 * guard reproduces the original: the dispute resolves under the contested
 * reviewer's own id.
 *
 * Two fixture facts that cost a run each, worth keeping:
 *   · `self_assessment_rounds` has chk_sa_state_pair — the legacy `status` and
 *     the V2 `workflow_state` must agree, so an arbitration row is
 *     ('arbitration', 'submitted'). A fixture that breaks it describes a state
 *     production cannot reach.
 *   · `supervisor_reviews.reviewed_by` AND `assessment_disputes.decided_by`
 *     are both foreign keys onto EMPLOYEES, not admins.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const Disputes = require('../../src/services/DisputeServiceV2');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

const DISPUTE = 76;
const CONTESTED = 136; // the supervisor who recorded the rating
const OTHER = 137;

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.all.mockResolvedValue([]);
    mockDb.get.mockImplementation(async (sql) => {
        if (/JOIN supervisor_reviews sr ON sr\.id = d\.supervisor_review_id/.test(sql)) {
            return { reviewedBy: CONTESTED };
        }
        if (/supervisor_review_id FROM assessment_disputes/.test(sql)) return null;
        return null;
    });
});

describe('nobody arbitrates their own rating', () => {
    test('the contested reviewer is refused with a stable code', async () => {
        let err = null;
        try {
            await Disputes.resolveL1({
                disputeId: DISPUTE,
                decidedBy: CONTESTED,
                decidedRating: 2,
                reason: 'x',
            });
        } catch (e) {
            err = e;
        }
        expect(err).not.toBeNull();
        expect(err.status).toBe(403);
        expect(err.code).toBe('DISPUTE_SELF_REVIEW');
        expect(err.i18n).toEqual({ key: 'talentx:dsp_err_self_arbitration' });
    });

    test('and NOTHING is written — the refusal precedes the transaction', async () => {
        await Disputes.resolveL1({
            disputeId: DISPUTE,
            decidedBy: CONTESTED,
            decidedRating: 2,
            reason: 'x',
        }).catch(() => {});
        expect(mockDb.run).not.toHaveBeenCalled();
        expect(mockDb.runTransaction).not.toHaveBeenCalled();
    });

    test('a DIFFERENT decider passes — the guard must not jam the rung', async () => {
        const out = await Disputes.resolveL1({
            disputeId: DISPUTE,
            decidedBy: OTHER,
            decidedRating: 2,
            reason: 'x',
        });
        expect(out).toBeDefined();
        expect(mockDb.run).toHaveBeenCalled();
    });

    test('a review with no recorded reviewer does not block the ladder', async () => {
        // Nothing to compare against must never become a silent refusal that
        // strands a dispute nobody can resolve.
        mockDb.get.mockImplementation(async (sql) =>
            /JOIN supervisor_reviews sr/.test(sql) ? { reviewedBy: null } : null
        );
        await expect(
            Disputes.resolveL1({
                disputeId: DISPUTE,
                decidedBy: CONTESTED,
                decidedRating: 2,
                reason: 'x',
            })
        ).resolves.toBeDefined();
    });
});

describe('the guard lives where the write happens', () => {
    const src = read('src/services/DisputeServiceV2.js');

    test('resolveL1 calls it before opening the transaction', () => {
        const i = src.indexOf('static async resolveL1(');
        expect(i).toBeGreaterThan(-1);
        const body = src.slice(i, src.indexOf('static async', i + 10));
        expect(body).toMatch(/_refuseSelfArbitration\(disputeId, decidedBy\)/);
        expect(body.indexOf('_refuseSelfArbitration')).toBeLessThan(body.indexOf('runTransaction'));
    });

    test('it compares against the RECORDED reviewer, not the current supervisor', () => {
        const i = src.indexOf('static async _refuseSelfArbitration(');
        const body = src.slice(i, src.indexOf('static async', i + 10));
        // supervisors change; the person who wrote the contested rating does not.
        expect(body).toMatch(/sr\.reviewed_by/);
        expect(body).not.toMatch(/supervisor_id/);
    });

    test('L0 keeps NO such guard — that rung IS the supervisor answering', () => {
        const i = src.indexOf('static async resolveL0(');
        expect(i).toBeGreaterThan(-1);
        const body = src.slice(i, src.indexOf('static async', i + 10));
        expect(body).not.toMatch(/_refuseSelfArbitration/);
    });

    test('the refusal is written in both languages', () => {
        for (const lang of ['fr', 'en']) {
            const tx = JSON.parse(read(`locales/${lang}/talentx.json`));
            expect(typeof tx.dsp_err_self_arbitration).toBe('string');
            expect(tx.dsp_err_self_arbitration.length).toBeGreaterThan(0);
        }
        const fr = JSON.parse(read('locales/fr/talentx.json'));
        const en = JSON.parse(read('locales/en/talentx.json'));
        expect(fr.dsp_err_self_arbitration).not.toBe(en.dsp_err_self_arbitration);
    });
});
