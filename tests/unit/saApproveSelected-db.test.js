'use strict';
/**
 * Approve the SELECTED skills of one person in one action
 * (SelfAssessmentWorkflowService.approveSelected), on the real test database,
 * every case inside a rolled-back transaction (tests/helpers/ladderWorld.js).
 *
 *  - each item goes through approve(): same checks, same writes, one SA_APPROVE
 *    audit row per skill, plus ONE SA_BULK_APPROVE summary and ONE sa.approved
 *    notification for the round;
 *  - all or nothing: one refused skill rolls the round back, and every reason
 *    is returned;
 *  - parity with a single approval: arbitration, a changed rating's reason,
 *    one's own record, the line above (strict: reads only; extended: acts),
 *    a local admin in clearance, a viewer;
 *  - malformed input is a 400 before any query.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(120000);

jest.mock('../../src/services/WebhookService', () => ({
    isEmittable: () => false,
    emit: async () => {},
    minimisePayload: () => ({}),
}));
const mockLogs = [];
jest.mock('../../src/services/LogService', () => ({
    log: jest.fn(async (e) => {
        mockLogs.push(e);
        return null;
    }),
}));

const W = require('../helpers/ladderWorld');
const db = HAS_DB ? require('../../src/config/database') : null;
const SA = () => require('../../src/services/SelfAssessmentWorkflowService');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});
beforeEach(() => {
    mockLogs.length = 0;
});

const LEGACY = {
    submitted: 'submitted',
    under_review: 'submitted',
    reviewed: 'reviewed',
    arbitration: 'reviewed',
};

/** One self-assessment per state, on distinct skills, self level 2 unless given. */
async function plant(employeeId, states, levels = []) {
    const skills = await db.all('SELECT id FROM skills ORDER BY id LIMIT ?', [states.length]);
    const ids = [];
    for (let i = 0; i < states.length; i++) {
        const r = await db.get(
            `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at)
             VALUES (?, ?, ?, ?::self_assessment_state, ?, now()) RETURNING id`,
            [
                employeeId,
                Number(skills[i].id),
                levels[i] === undefined ? 2 : levels[i],
                LEGACY[states[i]],
                states[i],
            ]
        );
        ids.push(Number(r.id));
    }
    return ids;
}
const statesOf = (ids) =>
    db.all(
        'SELECT id, workflow_state AS wf, status::text AS st FROM self_assessments WHERE id = ANY(?) ORDER BY id',
        [ids]
    );
const notices = (employeeId) =>
    db.all(
        "SELECT payload FROM notifications WHERE kind = 'sa.approved' AND user_type = 'employee' AND user_id = ?",
        [employeeId]
    );
const refusal = async (fn) => {
    try {
        await fn();
        return null;
    } catch (e) {
        return e;
    }
};
const req = (user) => ({ user, ip: '127.0.0.1', get: () => 'sa-approve-selected', t: null });

suite('approveSelected — service, real database, rolled back', () => {
    test('a manager approves 3 skills: states, levels, audit ×3 + 1 summary, ONE notification', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const ids = await plant(
                w.people.P,
                ['submitted', 'under_review', 'reviewed'],
                [1, 2, 3]
            );
            const M = await W.hydrate(db, { employee: w.people.M });
            const r = await SA().approveSelected(
                w.people.P,
                ids.map((id) => ({ id })),
                M,
                req(M)
            );
            const levels = await db.all(
                `SELECT ska.current_level AS lvl FROM skill_assessments ska
                   JOIN self_assessments sa ON sa.employee_id = ska.employee_id AND sa.skill_id = ska.skill_id
                  WHERE sa.id = ANY(?) ORDER BY sa.id`,
                [ids]
            );
            return { r, ids, states: await statesOf(ids), levels, n: await notices(w.people.P) };
        });
        expect(out.r.count).toBe(3);
        expect(out.r.approved.map((a) => a.id)).toEqual(out.ids);
        expect(out.states.every((s) => s.wf === 'approved' && s.st === 'approved')).toBe(true);
        expect(out.levels.map((l) => Number(l.lvl))).toEqual([1, 2, 3]);
        const actions = mockLogs.map((e) => e.action);
        expect(actions.filter((a) => a === 'SA_APPROVE')).toHaveLength(3);
        expect(actions.filter((a) => a === 'SA_BULK_APPROVE')).toHaveLength(1);
        const summary = mockLogs.find((e) => e.action === 'SA_BULK_APPROVE');
        expect(summary.entityType).toBe('employee');
        expect(summary.details).toMatch(/approved 3 selected skill\(s\)/);
        expect(summary.details).toMatch(/ as=manager$/);
        expect(out.n).toHaveLength(1);
        expect(out.n[0].payload.count).toBe(3);
    });

    test('ATOMIC: one refused skill rolls the round back — nothing approved or notified; every reason listed', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const ids = await plant(w.people.P, ['submitted', 'submitted', 'submitted']);
            const M = await W.hydrate(db, { employee: w.people.M });
            // the third one went back to the employee in the meantime
            await db.run(
                "UPDATE self_assessments SET workflow_state = 'changes_requested', status = 'draft' WHERE id = ?",
                [ids[2]]
            );
            const e = await refusal(() =>
                SA().approveSelected(
                    w.people.P,
                    ids.map((id) => ({ id })),
                    M,
                    req(M)
                )
            );
            return { e, ids, states: await statesOf(ids), n: await notices(w.people.P) };
        });
        expect(out.e.code).toBe('BATCH_REFUSED');
        expect(out.e.status).toBe(409);
        expect(out.e.refused.map((r) => r.id)).toEqual([out.ids[2]]);
        expect(out.e.refused[0].code).toBe('state');
        expect(out.states.slice(0, 2).map((s) => s.wf)).toEqual(['submitted', 'submitted']);
        expect(mockLogs.filter((x) => x.action === 'SA_BULK_APPROVE')).toEqual([]);
        expect(out.n).toEqual([]);
    });

    test('a skill of ANOTHER person blocks the round', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const mine = await plant(w.people.P, ['submitted']);
            const other = await plant(w.people.Q, ['submitted']);
            const M = await W.hydrate(db, { employee: w.people.M });
            return refusal(() =>
                SA().approveSelected(w.people.P, [{ id: mine[0] }, { id: other[0] }], M, req(M))
            );
        });
        expect(out.code).toBe('BATCH_REFUSED');
        expect(out.refused.map((r) => r.code)).toEqual(['not_in_round']);
    });

    test('PARITY — arbitration is never swept by several items; alone, approve() decides', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const ids = await plant(w.people.P, ['submitted', 'arbitration']);
            const S = await W.hydrate(db, { employee: w.people.S });
            const M = await W.hydrate(db, { employee: w.people.M });
            const multi = await refusal(() =>
                SA().approveSelected(
                    w.people.P,
                    ids.map((id) => ({ id })),
                    M,
                    req(M)
                )
            );
            // the supervisor alone is refused exactly as by a single approval
            const supAlone = await refusal(() =>
                SA().approveSelected(w.people.P, [{ id: ids[1] }], S, req(S))
            );
            const supSingle = await refusal(() => SA().approve(ids[1], S, null, req(S)));
            const mgrAlone = await SA().approveSelected(w.people.P, [{ id: ids[1] }], M, req(M));
            return { multi, supAlone, supSingle, mgrAlone };
        });
        expect(out.multi.refused.map((r) => r.code)).toEqual(['arbitration_individual']);
        expect(out.supAlone.code).toBe('BATCH_REFUSED');
        expect(out.supSingle).not.toBeNull();
        expect(out.mgrAlone.count).toBe(1);
    });

    test('PARITY — a changed rating needs its written reason; with it, the reviewer’s level is promoted', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const ids = await plant(w.people.P, ['submitted'], [1]);
            const M = await W.hydrate(db, { employee: w.people.M });
            const none = await refusal(() =>
                SA().approveSelected(w.people.P, [{ id: ids[0], supervisorLevel: 3 }], M, req(M))
            );
            const ok = await SA().approveSelected(
                w.people.P,
                [{ id: ids[0], supervisorLevel: 3, gapReason: 'Seen on the job twice.' }],
                M,
                req(M)
            );
            const lvl = await db.get(
                `SELECT ska.current_level AS lvl FROM skill_assessments ska
                   JOIN self_assessments sa ON sa.employee_id = ska.employee_id AND sa.skill_id = ska.skill_id
                  WHERE sa.id = ?`,
                [ids[0]]
            );
            return { none, ok, lvl: Number(lvl.lvl) };
        });
        expect(out.none.refused.map((r) => r.code)).toEqual(['reason_required']);
        expect(out.ok.approved[0].level).toBe(3);
        expect(out.lvl).toBe(3);
    });

    test('PARITY — the person: own record refused; the line above reads only (strict) and acts (extended); a viewer never', async () => {
        const A = require('../../src/services/AuthorityService');
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const ids = await plant(w.people.P, ['submitted', 'submitted']);
            const items = ids.map((id) => ({ id }));
            const P = await W.hydrate(db, { employee: w.people.P });
            const N2 = await W.hydrate(db, { employee: w.people.N2 });
            const V = await W.hydrate(db, { admin: w.admins.VIEWER });
            const LA = await W.hydrate(db, { admin: w.admins.LA_IN });
            const own = await refusal(() => SA().approveSelected(w.people.P, items, P, req(P)));
            const above = await refusal(() => SA().approveSelected(w.people.P, items, N2, req(N2)));
            const viewer = await refusal(() => SA().approveSelected(w.people.P, items, V, req(V)));
            const spy = jest.spyOn(A, 'mode').mockResolvedValue('extended');
            let aboveExtended;
            try {
                aboveExtended = await SA().approveSelected(w.people.P, [items[0]], N2, req(N2));
            } finally {
                spy.mockRestore();
            }
            const local = await SA().approveSelected(w.people.P, [items[1]], LA, req(LA));
            return { own, above, viewer, aboveExtended, local };
        });
        expect(out.own.i18n.key).toBe('assess:saw_err_review_own');
        expect(out.above.i18n.key).toBe('assess:acr_err_not_authorized_reviewer');
        expect(out.viewer.i18n.key).toBe('assess:acr_err_not_authorized_reviewer');
        expect(out.aboveExtended.count).toBe(1);
        expect(out.local.count).toBe(1);
    });

    test('malformed input is a 400 before any query; duplicates collapse to one item', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.build(db);
            const ids = await plant(w.people.P, ['submitted']);
            const M = await W.hydrate(db, { employee: w.people.M });
            const empty = await refusal(() => SA().approveSelected(w.people.P, [], M, req(M)));
            const bad = await refusal(() =>
                SA().approveSelected(w.people.P, [{ id: 'x' }], M, req(M))
            );
            const many = await refusal(() =>
                SA().approveSelected(
                    w.people.P,
                    Array.from({ length: 201 }, (_, i) => ({ id: i + 1 })),
                    M,
                    req(M)
                )
            );
            const dup = await SA().approveSelected(
                w.people.P,
                [{ id: ids[0] }, { id: ids[0] }],
                M,
                req(M)
            );
            return { empty, bad, many, dup };
        });
        for (const e of [out.empty, out.bad, out.many]) expect(e.status).toBe(400);
        expect(out.empty.i18n.key).toBe('talentx:sab_err_empty');
        expect(out.bad.i18n.key).toBe('talentx:sab_err_bad_id');
        expect(out.many.i18n.key).toBe('talentx:sab_err_too_many');
        expect(out.dup.count).toBe(1);
    });
});
