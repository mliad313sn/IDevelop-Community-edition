'use strict';
/**
 * The end-of-campaign record (ReviewRecordService, migration 193) on the REAL
 * schema, inside transactions that are always rolled back. Invented people
 * only (tests/helpers/dashWorld.js).
 *
 *   - only a LOCKED or CLOSED campaign the person had ratings in is readable;
 *     an open one is refused (409), another person's or one without a rating
 *     of theirs is "not found" (404);
 *   - per skill: own rating, the level validated only once the round was
 *     approved (a pending round is never shown as validated), « adjusted »
 *     and the reviewer's reason read LIVE, a dispute still open;
 *   - acknowledging freezes ids, levels, states and dates only — no reason,
 *     no name — and is idempotent; the comment is added and changed later;
 *   - the guard: the snapshot and the date never change, a record is never
 *     deleted, the comment may change;
 *   - an erased reason disappears from the page with nothing left in the
 *     snapshot.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/dashWorld');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/LogService', () => {
    const real = jest.requireActual('../../src/services/LogService');
    real.log = async () => null;
    return real;
});

const TOKEN = `RRtok${Date.now().toString(36)}`;
let db;
let RR;

async function refused(fn) {
    try {
        await db.runInSavepoint(fn);
        return null;
    } catch (e) {
        return e.code || e.message || 'error';
    }
}

/** A campaign with three rounds for `person`: adjusted+approved, approved as is, pending. */
async function campaign(w, person, status) {
    const c = await db.get(
        `INSERT INTO assessment_cycles (code, label, opened_at, closes_at, status, created_by)
         VALUES (?, ?, now() - interval '60 days', now() - interval '5 days', ?, ?) RETURNING id`,
        [`RR-${status}-${TOKEN}`, `Campaign ${status} ${TOKEN}`, status, w.adminId]
    );
    const cycleId = Number(c.id);
    const round = async (skillId, self, state) => {
        const st = { approved: 'approved', submitted: 'submitted' }[state];
        const r = await db.get(
            `INSERT INTO self_assessment_rounds (employee_id, skill_id, self_rated_level, status, workflow_state,
                                                 cycle_id, submitted_at, approved_at, approved_by_ref)
             VALUES (?, ?, ?, ?::self_assessment_state, ?, ?, now() - interval '20 days',
                     CASE WHEN ? = 'approved' THEN now() - interval '10 days' END,
                     CASE WHEN ? = 'approved' THEN 'admin:1' END)
             RETURNING id`,
            [person, skillId, self, st, state, cycleId, state, state]
        );
        return Number(r.id);
    };
    const r1 = await round(w.S1, 3, 'approved');
    const rev = await db.get(
        `INSERT INTO supervisor_reviews (self_assessment_id, employee_id, skill_id, supervisor_rated_level,
                                         gap, gap_reason, reviewed_by, reviewed_at, status)
         VALUES (?, ?, ?, 1, 2, ?, ?, now() - interval '11 days', 'completed') RETURNING id`,
        [r1, person, w.S1, `${TOKEN} reason`, w.M]
    );
    await round(w.S2, 2, 'approved');
    await round(w.S3, 2, 'submitted');
    return { cycleId, reviewId: Number(rev.id) };
}

suite('the end-of-campaign record (real schema, rolled back)', () => {
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
        RR = require('../../src/services/ReviewRecordService');
    });
    afterAll(async () => {
        await db.close();
    });

    test('readable campaigns, the live record and its refusals', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const me = w.people.N[5];
            const other = w.people.N[6];
            const locked = await campaign(w, me, 'locked');
            const open = await campaign(w, other, 'open');
            const list = await RR.listForEmployee(me);
            const view = await RR.view(me, locked.cycleId);
            const errs = {};
            for (const [k, fn] of [
                ['open', () => RR.view(other, open.cycleId)],
                ['otherPerson', () => RR.view(other, locked.cycleId)],
                ['bogus', () => RR.view(me, '1 OR 1=1')],
                ['commentFirst', () => RR.comment(me, locked.cycleId, 'hello')],
            ]) {
                try {
                    await fn();
                    errs[k] = null;
                } catch (e) {
                    errs[k] = [e.status, e.code];
                }
            }
            return { list, view, errs, locked };
        });
        expect(out.list.map((c) => c.id)).toEqual([out.locked.cycleId]);
        expect(out.list[0]).toMatchObject({ status: 'locked', acknowledgedAt: null });
        const by = Object.fromEntries(out.view.skills.map((s) => [s.self, s]));
        // adjusted: self 3, validated 1, the reason read live
        expect(by[3]).toMatchObject({ validated: 1, adjusted: true, reason: `${TOKEN} reason` });
        expect(out.view.skills).toHaveLength(3);
        const pending = out.view.skills.filter((s) => s.validated === null);
        expect(pending).toHaveLength(1); // the submitted round is never "validated"
        expect(pending[0]).toMatchObject({ pending: true, adjusted: false, reason: null });
        expect(out.view.counts).toMatchObject({ skills: 3, validated: 2, adjusted: 1, pending: 1 });
        expect(out.view.acknowledged).toBe(false);
        expect(out.errs.open).toEqual([409, 'RR_NOT_CLOSED']);
        expect(out.errs.otherPerson).toEqual([404, 'RR_NOT_FOUND']);
        expect(out.errs.bogus).toEqual([404, 'RR_NOT_FOUND']);
        expect(out.errs.commentFirst).toEqual([409, 'RR_NOT_ACKNOWLEDGED']);
    });

    test('acknowledging freezes ids and levels only; the comment changes; the guard holds', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const me = w.people.N[5];
            const c = await campaign(w, me, 'closed');
            const first = await RR.acknowledge(me, c.cycleId, '  first words  ');
            const again = await RR.acknowledge(me, c.cycleId, 'ignored');
            const row = await db.get(
                'SELECT id, snapshot::text AS "snap", employee_comment AS "comment" FROM review_records WHERE employee_id = ? AND cycle_id = ?',
                [me, c.cycleId]
            );
            await RR.comment(me, c.cycleId, 'changed words');
            const after = await RR.view(me, c.cycleId);
            // the line changes the reason AFTER the acknowledgement: the page reads it live
            await db.run('UPDATE supervisor_reviews SET gap_reason = ? WHERE id = ?', [
                '[erased]',
                c.reviewId,
            ]);
            const erased = await RR.view(me, c.cycleId);
            const g = {
                snapshot: await refused(() =>
                    db.run(`UPDATE review_records SET snapshot = '{}'::jsonb WHERE id = ?`, [
                        row.id,
                    ])
                ),
                date: await refused(() =>
                    db.run(
                        `UPDATE review_records SET acknowledged_at = now() + interval '1 day' WHERE id = ?`,
                        [row.id]
                    )
                ),
                del: await refused(() =>
                    db.run('DELETE FROM review_records WHERE id = ?', [row.id])
                ),
                comment: await refused(() =>
                    db.run(`UPDATE review_records SET employee_comment = 'x' WHERE id = ?`, [
                        row.id,
                    ])
                ),
            };
            const tooLong = await RR.comment(me, c.cycleId, 'x'.repeat(4001)).catch((e) => e.code);
            return { first, again, row, after, erased, g, tooLong, names: w.names };
        });
        expect(out.first).toEqual({ created: true });
        expect(out.again).toEqual({ created: false });
        expect(out.row.comment).toBe('first words');
        // decision 8: no free text and no name in the frozen snapshot
        expect(out.row.snap).not.toContain(TOKEN);
        expect(out.row.snap).not.toMatch(/reason|skillName|domainName/);
        for (const n of out.names) expect(out.row.snap).not.toContain(n.last);
        const snap = JSON.parse(out.row.snap);
        expect(Object.keys(snap.skills[0]).sort()).toEqual(
            [
                'adjusted',
                'disputeOpen',
                'pending',
                'reviewId',
                'roundId',
                'self',
                'skillId',
                'validated',
            ].sort()
        );
        expect(out.after).toMatchObject({ acknowledged: true, comment: 'changed words' });
        expect(out.after.skills.find((s) => s.adjusted).reason).toBe(`${TOKEN} reason`);
        // an erased reason is gone from the page, and was never in the snapshot
        expect(out.erased.skills.find((s) => s.adjusted).reason).toBeNull();
        expect(out.g.snapshot).toBe('23514');
        expect(out.g.date).toBe('23514');
        expect(out.g.del).toBe('23514');
        expect(out.g.comment).toBeNull();
        expect(out.tooLong).toBe('RR_TEXT_TOO_LONG');
    });
});
