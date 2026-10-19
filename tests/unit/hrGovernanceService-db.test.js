'use strict';
/**
 * HR governance (4.0.0 port, wave 6) on the REAL schema: the services, with
 * the invented people of tests/helpers/dashWorld.js, every scenario inside a
 * transaction that is always rolled back.
 *
 *   HR-01  a dispute's level-0 answer is a PROPOSAL: never below the
 *          contested rating, never above the person's own; one per dispute;
 *          only the person answers it; accepting it decides (the review and
 *          the official level follow), refusing it escalates at once; the
 *          level-0 delay runs from the proposal;
 *   HR-02  level-2 auto-finalisation is OFF by default; HR is reminded once,
 *          two days before the level-2 deadline;
 *   HR-03  a proposed PIP is invisible to its subject until it is activated;
 *   HR-04  the PIP's evidence: real author, activation dated and attributed,
 *          the person's reading and observations, checkpoints held by the
 *          plan authority only, never dated in the future, the person's own
 *          answers; the HR visa when required, never by the proposer;
 *   HR-09  a development plan is never signed empty.
 * Skipped unless DATABASE_URL names a *_test database.
 */
require('dotenv').config();

const mockNotify = jest.fn(async () => ({ inapp: 'ok' }));
jest.mock('../../src/services/NotificationService', () => ({
    notify: (...a) => mockNotify(...a),
    enqueue: jest.fn(async () => ({})),
    enqueueBulkInApp: jest.fn(async () => undefined),
    KIND_META: {},
}));

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/dashWorld');

const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL);
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(120000);

let db;
beforeAll(async () => {
    if (!ENABLED) return;
    db = require('../../src/config/database');
    await db.connect();
});
afterAll(async () => {
    if (db) await db.close();
});
beforeEach(() => mockNotify.mockClear());

const kinds = () => mockNotify.mock.calls.map(([a]) => `${a.userType}:${a.kind}`);
const codeOf = async (p) => {
    try {
        await p;
        return null;
    } catch (e) {
        return e.code || String(e.message);
    }
};

/** A decided review of `person` on `skill` (self `self`, supervisor `sup`) and its open L0 dispute. */
async function disputeOf(w, person, skill, self, sup, extra = '') {
    const round = await db.get(
        `INSERT INTO self_assessment_rounds (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at)
         VALUES (?, ?, ?, 'submitted', 'submitted', now() - interval '12 days') RETURNING id`,
        [person, skill, self]
    );
    const review = await db.get(
        `INSERT INTO supervisor_reviews (self_assessment_id, employee_id, skill_id, supervisor_rated_level,
                                         gap, reviewed_by, reviewed_at, status)
         VALUES (?, ?, ?, ?, ?, ?, now() - interval '11 days', 'disputed') RETURNING id`,
        [Number(round.id), person, skill, sup, sup - self, w.M]
    );
    const dispute = await db.get(
        `INSERT INTO assessment_disputes (supervisor_review_id, employee_id, reason ${extra ? ', ' + extra : ''})
         VALUES (?, ?, 'My rating is higher than that.' ${extra ? ", now() - interval '10 days'" : ''})
         RETURNING id`,
        [Number(review.id), person]
    );
    return { roundId: Number(round.id), reviewId: Number(review.id), id: Number(dispute.id) };
}

d('HR governance services on the real schema (invented people, rolled back)', () => {
    test('HR-01: the level-0 answer is a proposal the person answers', async () => {
        const D = require('../../src/services/DisputeServiceV2');
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const person = w.people.N[5];
            const other = w.people.N[6];
            const a = await disputeOf(w, person, w.S1, 3, 1);
            const r = {};
            const base = { disputeId: a.id, decidedBy: w.M, reason: 'Seen again together.' };
            r.lower = await codeOf(D.proposeL0({ ...base, decidedRating: 0 }));
            r.above = await codeOf(D.proposeL0({ ...base, decidedRating: 4 }));
            r.noReason = await codeOf(D.proposeL0({ ...base, decidedRating: 2, reason: ' ' }));
            r.first = await D.proposeL0({ ...base, decidedRating: 2 });
            r.second = await D.proposeL0({ ...base, decidedRating: 3 });
            r.toldPerson = kinds();
            r.stranger = await codeOf(
                D.respondToProposal({ disputeId: a.id, employeeId: other, accept: true })
            );
            r.missing = await codeOf(
                D.respondToProposal({ disputeId: 99999999, employeeId: person, accept: true })
            );
            r.accept = await D.respondToProposal({
                disputeId: a.id,
                employeeId: person,
                accept: true,
            });
            r.acceptAgain = await D.respondToProposal({
                disputeId: a.id,
                employeeId: person,
                accept: true,
            });
            r.rowA = await db.get(
                `SELECT state, final_level, decided_rating, decided_by, employee_response, reason
                   FROM assessment_disputes WHERE id = ?`,
                [a.id]
            );
            r.review = await db.get(
                'SELECT supervisor_rated_level, status FROM supervisor_reviews WHERE id = ?',
                [a.reviewId]
            );
            r.official = await db.get(
                'SELECT current_level FROM skill_assessments WHERE employee_id = ? AND skill_id = ?',
                [person, w.S1]
            );
            // refusal: escalated to level 1 at once, the manager is told
            const b = await disputeOf(w, person, w.S2, 4, 2);
            await D.proposeL0({ disputeId: b.id, decidedBy: w.M, decidedRating: 3, reason: 'x' });
            mockNotify.mockClear();
            r.refuse = await D.respondToProposal({
                disputeId: b.id,
                employeeId: person,
                accept: false,
            });
            r.rowB = await db.get(
                'SELECT level, state, employee_response, decided_rating FROM assessment_disputes WHERE id = ?',
                [b.id]
            );
            // the level-0 delay runs from the PROPOSAL: opened 10 days ago,
            // proposed today → not escalated by the tick
            const c = await disputeOf(w, person, w.S3, 3, 1, 'opened_at');
            await D.proposeL0({ disputeId: c.id, decidedBy: w.M, decidedRating: 2, reason: 'x' });
            await D.escalateOverdueL0();
            r.rowC = await db.get('SELECT level, state FROM assessment_disputes WHERE id = ?', [
                c.id,
            ]);
            return r;
        });
        expect(out.lower).toBe('DISPUTE_L0_LOWER');
        expect(out.above).toBe('DISPUTE_L0_RANGE');
        expect(out.noReason).toBe('DISPUTE_REASON_REQUIRED');
        expect(out.first).toEqual({ proposed: true });
        expect(out.second).toEqual({ proposed: false, alreadyProposed: true });
        expect(out.toldPerson).toEqual(['employee:dispute.proposal']);
        expect(out.stranger).toBe('DISPUTE_NOT_OWNER');
        expect(out.missing).toBe('DISPUTE_NOT_FOUND');
        expect(out.accept).toEqual({ resolved: true });
        expect(out.acceptAgain).toEqual({ resolved: false });
        expect(out.rowA).toMatchObject({
            state: 'resolved',
            finalLevel: 'L0',
            decidedRating: 2,
            employeeResponse: 'accepted',
        });
        expect(Number(out.rowA.decidedBy)).toBeGreaterThan(0);
        // the proposer's reason is attributed to the decider, not to the person
        expect(out.rowA.reason).toMatch(/\n\n\[resolution:L0\] Seen again together\.$/);
        expect(out.review).toEqual({ supervisorRatedLevel: 2, status: 'completed' });
        expect(out.official).toEqual({ currentLevel: 2 });
        expect(out.refuse).toEqual({ resolved: false, escalated: true });
        expect(out.rowB).toEqual({
            level: 'L1',
            state: 'escalated',
            employeeResponse: 'refused',
            decidedRating: null,
        });
        expect(out.rowC).toEqual({ level: 'L0', state: 'open' });
    });

    test('HR-02: auto-finalise is off by default; HR is reminded once, two days before', async () => {
        const D = require('../../src/services/DisputeServiceV2');
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const days =
                Number(
                    (
                        await db.get(
                            "SELECT setting_value FROM app_settings WHERE setting_key = 'dispute.l2SlaDays'"
                        )
                    )?.settingValue
                ) || 7;
            const setting = await db.get(
                "SELECT setting_value FROM app_settings WHERE setting_key = 'dispute.autoFinalizeOnExpiry'"
            );
            // one level-2 dispute one day before its deadline, one long overdue
            const soon = await disputeOf(w, w.people.N[5], w.S1, 3, 1);
            const late = await disputeOf(w, w.people.N[6], w.S1, 3, 1);
            await db.run(
                `UPDATE assessment_disputes SET level = 'L2', state = 'escalated',
                        escalated_at = now() - (interval '1 day' * ?) WHERE id = ?`,
                [days - 1, soon.id]
            );
            await db.run(
                `UPDATE assessment_disputes SET level = 'L2', state = 'escalated', hr_reminded_at = now(),
                        escalated_at = now() - (interval '1 day' * ?) WHERE id = ?`,
                [days + 3, late.id]
            );
            const reminded = await D.remindHrBeforeL2Deadline();
            const told = kinds();
            const again = await D.remindHrBeforeL2Deadline();
            const finalised = await D.autoFinalizeOverdueL2();
            const rows = await db.all(
                `SELECT id, level, state, hr_reminded_at IS NOT NULL AS reminded
                   FROM assessment_disputes WHERE id IN (?, ?) ORDER BY id`,
                [soon.id, late.id]
            );
            return { setting: setting.settingValue, reminded, told, again, finalised, rows };
        });
        expect(out.setting).toBe('false');
        expect(out.reminded).toBe(1);
        expect(out.told.length).toBeGreaterThan(0);
        expect(out.told.every((k) => k === 'admin:dispute.escalated')).toBe(true);
        expect(out.again).toBe(0);
        expect(out.finalised).toBe(0);
        expect(out.rows.map((r) => [r.level, r.state, r.reminded])).toEqual([
            ['L2', 'escalated', true],
            ['L2', 'escalated', true],
        ]);
    });

    test('HR-03 / HR-04: a proposal is hidden from its subject; the evidence of a plan', async () => {
        const P = require('../../src/services/PipService');
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const person = w.people.N[5];
            const other = w.people.N[6];
            // the person's direct manager is M (the plan authority)
            await db.run(
                "UPDATE employees SET manager_id = ?, manager_type = 'employee' WHERE id = ?",
                [w.M, person]
            );
            const M = { id: w.M, userType: 'manager' };
            const row = await P.proposeDirect({
                employeeId: person,
                actor: M,
                summary: 'Plan for the quarter',
                objectives: 'Close the backlog',
            });
            const id = Number(row.id);
            const r = { toldOnProposal: kinds() };
            r.created = await db.get(
                'SELECT proposed_by_ref, activated_at, initiated_by FROM pips WHERE id = ?',
                [id]
            );
            const visible = async () =>
                (
                    await db.all(
                        `SELECT p.id FROM pips p WHERE p.employee_id = ? AND ${P.subjectVisibleSql('p')}`,
                        [person]
                    )
                ).map((x) => Number(x.id));
            r.visibleBefore = await visible();
            r.ackBefore = await codeOf(P.acknowledge(id, person));
            r.cpBefore = await codeOf(P.addReview(id, M, { note: 'Too early' }));
            // the optional HR visa: required → activation refused until given,
            // and never by whoever proposed the plan
            const spy = jest.spyOn(P, 'hrVisaRequired').mockResolvedValue(true);
            try {
                r.noVisa = await codeOf(P.activate(id, M));
                const superadmin = { id: w.adminId, userType: 'admin', role: 'superadmin' };
                r.managerMay = await P.canGiveHrVisa(M, person);
                r.superMay = await P.canGiveHrVisa(superadmin, person);
                r.visa = await P.giveHrVisa(id, superadmin);
                r.visaAgain = await P.giveHrVisa(id, superadmin);
                mockNotify.mockClear();
                r.activated = await P.activate(id, M);
            } finally {
                spy.mockRestore();
            }
            r.toldOnActivation = kinds();
            r.after = await db.get(
                'SELECT state, activated_at IS NOT NULL AS dated, activated_by_ref, hr_visa_by_ref FROM pips WHERE id = ?',
                [id]
            );
            r.visibleAfter = await visible();
            r.ack = await P.acknowledge(id, person);
            r.ackAgain = await P.acknowledge(id, person);
            r.otherAck = await codeOf(P.acknowledge(id, other));
            await P.comment(id, person, '  I read it; point 2 is unclear.  ');
            r.emptyComment = await codeOf(P.comment(id, person, '   '));
            r.longComment = await codeOf(P.comment(id, person, 'x'.repeat(4001)));
            r.cpStranger = await codeOf(
                P.addReview(id, { id: other, userType: 'employee' }, { note: 'Mine' })
            );
            r.cpSelf = await codeOf(
                P.addReview(id, { id: person, userType: 'employee' }, { note: 'Mine' })
            );
            r.cpFuture = await codeOf(P.addReview(id, M, { note: 'Later', heldOn: '2999-01-01' }));
            const rid = await P.addReview(id, M, { note: 'First month: progress on point 1.' });
            await P.respondReview(rid, person, 'Agreed on point 1.');
            r.respondOther = await codeOf(P.respondReview(rid, other, 'Not mine'));
            r.reviews = await P.listReviews(id);
            r.evidence = await db.get(
                `SELECT acknowledged_at IS NOT NULL AS ack, employee_comment FROM pips WHERE id = ?`,
                [id]
            );
            return r;
        });
        expect(out.toldOnProposal).toEqual([]);
        expect(out.created.proposedByRef).toMatch(/^employee:\d+$/);
        expect(out.created.activatedAt).toBeNull();
        expect(out.visibleBefore).toEqual([]);
        expect(out.ackBefore).toBe('PIP_NOT_FOUND');
        expect(out.cpBefore).toBe('PIP_NOT_ACTIVE');
        expect(out.noVisa).toBe('PIP_HR_VISA_REQUIRED');
        expect(out.managerMay).toBe(false);
        expect(out.superMay).toBe(true);
        expect(out.visa).toBe(true);
        expect(out.visaAgain).toBe(false);
        expect(out.activated).toBe(true);
        expect(out.toldOnActivation).toContain('employee:pip.activated');
        expect(out.after).toMatchObject({ state: 'active', dated: true });
        expect(out.after.activatedByRef).toBe(out.created.proposedByRef);
        expect(out.after.hrVisaByRef).toMatch(/^admin:\d+$/);
        expect(out.visibleAfter).toHaveLength(1);
        expect(out.ack).toBe(true);
        expect(out.ackAgain).toBe(false);
        expect(out.otherAck).toBe('PIP_NOT_FOUND');
        expect(out.emptyComment).toBe('TEXT_REQUIRED');
        expect(out.longComment).toBe('TEXT_TOO_LONG');
        expect(out.cpStranger).toBe('FORBIDDEN');
        expect(out.cpSelf).toBe('FORBIDDEN');
        expect(out.cpFuture).toBe('INVALID_DATE');
        expect(out.respondOther).toBe('PIP_NOT_FOUND');
        expect(out.reviews).toHaveLength(1);
        expect(out.reviews[0]).toMatchObject({
            managerNote: 'First month: progress on point 1.',
            employeeResponse: 'Agreed on point 1.',
        });
        expect(out.reviews[0].authorRef).toMatch(/^employee:\d+$/);
        expect(out.evidence).toEqual({
            ack: true,
            employeeComment: 'I read it; point 2 is unclear.',
        });
    });

    test('HR-04: the proposer cannot give the visa; a withdrawn proposal tells its subject nothing', async () => {
        const P = require('../../src/services/PipService');
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const person = w.people.N[4];
            const superadmin = { id: w.adminId, userType: 'admin', role: 'superadmin' };
            const row = await P.proposeDirect({ employeeId: person, actor: superadmin });
            const id = Number(row.id);
            const own = await codeOf(P.giveHrVisa(id, superadmin));
            mockNotify.mockClear();
            const withdrawn = await P.withdraw(id, 'Not needed after all.', superadmin);
            const toldOnWithdraw = kinds();
            // a plan that RAN is announced as withdrawn
            const ran = await P.proposeDirect({ employeeId: person, actor: superadmin });
            await P.activate(Number(ran.id), superadmin);
            mockNotify.mockClear();
            await P.withdraw(Number(ran.id), 'Stopped.', superadmin);
            return { own, withdrawn, toldOnWithdraw, toldOnRan: kinds() };
        });
        expect(out.own).toBe('PIP_VISA_OWN_PROPOSAL');
        expect(out.withdrawn).toBe(true);
        expect(out.toldOnWithdraw).toEqual([]);
        expect(out.toldOnRan).toEqual(['employee:pip.closed']);
    });

    test('HR-09: a development plan with no action is never signed', async () => {
        const I = require('../../src/services/IDPService');
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const plan = await db.get(
                `INSERT INTO idp_plans (employee_id, status, priority) VALUES (?, 'draft', 'medium') RETURNING id`,
                [w.people.N[3]]
            );
            return codeOf(I.assertSignable(Number(plan.id)));
        });
        expect(out).toBe('IDP_NOT_SIGNABLE');
    });
});
