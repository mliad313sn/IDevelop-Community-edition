'use strict';
/**
 * 360° feedback, proved against the REAL schema inside ONE transaction that is
 * always rolled back (self-contained fixture: own role, skills and people).
 *
 *   Flow        launch → the subject nominates → the manager approves → the
 *               raters answer (once) → close → release → report → IDP.
 *   Anonymity   the direct-report group has TWO answers and nothing to merge
 *               into: it is never shown, its answers reach no figure and no
 *               comment; "not observed" is never a 0; the report JSON names
 *               no rater, and the response rows carry no rater id.
 *   RBAC        a stranger, a colleague and an admin without scope get a 404;
 *               the subject cannot approve, cannot read before release; the
 *               manager and HR within scope read after close.
 *
 * Skipped (not failed) when no database is reachable.
 */
require('dotenv').config();

const ROLLBACK = new Error('feedback360-rollback');
let db;
let svc;
let ready = false;

beforeAll(async () => {
    const url = String(process.env.DATABASE_URL || '');
    if (!url || /placeholder/.test(url)) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        ready = Boolean(
            await db.get(
                `SELECT 1 AS ok FROM services sv JOIN departments d ON d.id = sv.department_id
                  WHERE to_regclass('public.feedback360_rounds') IS NOT NULL LIMIT 1`
            )
        );
        svc = require('../../src/services/Feedback360Service');
    } catch (_) {
        ready = false;
    }
}, 30000);

afterAll(async () => {
    if (db) {
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    }
});

async function inRollback(fn) {
    try {
        await db.runTransaction(async () => {
            await fn(await fixture());
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

async function fixture() {
    const org = await db.get(
        `SELECT sv.id AS service_id, d.id AS department_id, d.site_id
           FROM services sv JOIN departments d ON d.id = sv.department_id
          ORDER BY sv.id LIMIT 1`
    );
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const dom = Number(
        (await db.get('INSERT INTO domains (name) VALUES (?) RETURNING id', [`F360-${stamp}`])).id
    );
    const mkSkill = async (n) =>
        Number(
            (
                await db.get('INSERT INTO skills (domain_id, name) VALUES (?, ?) RETURNING id', [
                    dom,
                    `F360 ${n} ${stamp}`,
                ])
            ).id
        );
    const K1 = await mkSkill('Welding');
    const K2 = await mkSkill('Planning');
    const role = Number(
        (await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [`F360 role ${stamp}`]))
            .id
    );
    await db.run(
        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
         VALUES (?, ?, 3, true), (?, ?, 2, false)`,
        [role, K1, role, K2]
    );
    const mk = async (n, { sup = null } = {}) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                            service_id, role_id, supervisor_id, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, true) RETURNING id`,
                    [
                        `F360-${n}-${stamp}`,
                        n,
                        `Zz${n}`,
                        org.siteId,
                        org.departmentId,
                        org.serviceId,
                        role,
                        sup,
                    ]
                )
            ).id
        );
    const M = await mk('Manager');
    const S = await mk('Subject', { sup: M });
    const P1 = await mk('PeerOne', { sup: M });
    const P2 = await mk('PeerTwo', { sup: M });
    const P3 = await mk('PeerThree', { sup: M });
    const D1 = await mk('ReportOne', { sup: S });
    const D2 = await mk('ReportTwo', { sup: S });
    const X = await mk('Stranger');
    const as = (id, userType = 'employee') => ({ id, userType });
    return {
        K1,
        K2,
        M,
        S,
        P1,
        P2,
        P3,
        D1,
        D2,
        X,
        u: {
            M: as(M, 'manager'),
            S: as(S, 'manager'), // S governs D1/D2
            P1: as(P1),
            P2: as(P2),
            P3: as(P3),
            D1: as(D1),
            D2: as(D2),
            X: as(X),
            HR: { id: 0, userType: 'admin', role: 'superadmin', username: 'hr' },
            NOSCOPE: { id: 987654321, userType: 'admin', role: 'localadmin', username: 'none' },
        },
    };
}

const future = () => new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
const status = async (p) => {
    try {
        await p;
        return 200;
    } catch (e) {
        return e.status || 500;
    }
};

/** Launch → nominate → approve; returns the subject id and the nominations by rater. */
async function openRound(f) {
    const { roundId } = await svc.launchRound(f.u.M, {
        title: 'F360 test round',
        deadline: future(),
        employeeIds: [f.S],
    });
    const s = await db.get('SELECT id FROM feedback360_subjects WHERE round_id = ?', [roundId]);
    const sid = Number(s.id);
    await svc.nominate(f.u.S, sid, {
        raters: [
            { employeeId: f.P1, group: 'peer' },
            { employeeId: f.P2, group: 'peer' },
            { employeeId: f.P3, group: 'peer' },
            { employeeId: f.D1, group: 'direct_report' },
            { employeeId: f.D2, group: 'direct_report' },
        ],
        submit: true,
    });
    await svc.approve(f.u.M, sid, {});
    const noms = await db.all(
        'SELECT id, rater_employee_id FROM feedback360_nominations WHERE subject_id = ?',
        [sid]
    );
    const nom = Object.fromEntries(noms.map((n) => [Number(n.raterEmployeeId), Number(n.id)]));
    return { roundId, sid, nom };
}

const answer = (u, nid, k1, k2, comment) =>
    svc.submitResponse(u, nid, {
        ratings: { [`skill:${K.K1}`]: k1, [`skill:${K.K2}`]: k2, 'behaviour:b_listens': '2' },
        comments: comment ? { keep: comment } : {},
    });
const K = {};

describe('360° feedback — against the real schema (rolled back)', () => {
    test('launch: self and manager are automatic raters; the questionnaire is the role skills', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            const { roundId } = await svc.launchRound(f.u.M, {
                title: 'Launch',
                deadline: future(),
                employeeIds: [f.S],
                threshold: 1, // lifted to the floor
            });
            const r = await db.get(
                'SELECT anonymity_threshold FROM feedback360_rounds WHERE id = ?',
                [roundId]
            );
            expect(Number(r.anonymityThreshold)).toBe(3);
            const s = await db.get(
                'SELECT id, manager_employee_id, skills FROM feedback360_subjects WHERE round_id = ?',
                [roundId]
            );
            expect(Number(s.managerEmployeeId)).toBe(f.M);
            const skills = typeof s.skills === 'string' ? JSON.parse(s.skills) : s.skills;
            expect(skills.map((k) => k.skillId).sort()).toEqual([f.K1, f.K2].sort());
            const noms = await db.all(
                'SELECT rater_employee_id, rater_group, status FROM feedback360_nominations WHERE subject_id = ? ORDER BY rater_group',
                [s.id]
            );
            expect(noms.map((n) => [Number(n.raterEmployeeId), n.raterGroup, n.status])).toEqual([
                [f.M, 'manager', 'approved'],
                [f.S, 'self', 'approved'],
            ]);
            // A stranger cannot launch for someone outside their line.
            expect(
                await status(
                    svc.launchRound(f.u.X, { title: 'x', deadline: future(), employeeIds: [f.S] })
                )
            ).toBe(403);
            // Nobody launches for themselves.
            expect(
                await status(
                    svc.launchRound(f.u.S, { title: 'x', deadline: future(), employeeIds: [f.S] })
                )
            ).toBe(403);
        });
    });

    test('nomination approval flow: subject proposes, manager approves, raters are invited', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            const { roundId } = await svc.launchRound(f.u.M, {
                title: 'Approval',
                deadline: future(),
                employeeIds: [f.S],
            });
            const sid = Number(
                (await db.get('SELECT id FROM feedback360_subjects WHERE round_id = ?', [roundId]))
                    .id
            );
            // Only real direct reports may be nominated as such.
            expect(
                await status(
                    svc.nominate(f.u.S, sid, {
                        raters: [{ employeeId: f.P1, group: 'direct_report' }],
                    })
                )
            ).toBe(400);
            // Self, manager and duplicates are refused.
            expect(
                await status(
                    svc.nominate(f.u.S, sid, { raters: [{ employeeId: f.S, group: 'peer' }] })
                )
            ).toBe(400);
            expect(
                await status(
                    svc.nominate(f.u.S, sid, { raters: [{ employeeId: f.M, group: 'peer' }] })
                )
            ).toBe(400);
            // Too few to submit.
            expect(
                await status(
                    svc.nominate(f.u.S, sid, {
                        raters: [{ employeeId: f.P1, group: 'peer' }],
                        submit: true,
                    })
                )
            ).toBe(400);
            // Nobody but the subject nominates; a stranger does not even see it.
            expect(await status(svc.nominate(f.u.M, sid, { raters: [] }))).toBe(403);
            expect(await status(svc.nominate(f.u.X, sid, { raters: [] }))).toBe(404);

            await svc.nominate(f.u.S, sid, {
                raters: [
                    { employeeId: f.P1, group: 'peer' },
                    { employeeId: f.P2, group: 'peer' },
                    { employeeId: f.D1, group: 'direct_report' },
                ],
                submit: true,
            });
            let st = await db.get('SELECT status FROM feedback360_subjects WHERE id = ?', [sid]);
            expect(st.status).toBe('awaiting_approval');
            // The manager was told.
            const note = await db.get(
                `SELECT COUNT(*)::int AS n FROM notifications
                  WHERE user_type = 'employee' AND user_id = ? AND kind = 'feedback360.approve'`,
                [f.M]
            );
            expect(note.n).toBeGreaterThan(0);

            // The subject cannot approve their own list; a colleague cannot either.
            expect(await status(svc.approve(f.u.S, sid, {}))).toBe(403);
            expect(await status(svc.approve(f.u.P1, sid, {}))).toBe(404);

            const p2 = await db.get(
                'SELECT id FROM feedback360_nominations WHERE subject_id = ? AND rater_employee_id = ?',
                [sid, f.P2]
            );
            const out = await svc.approve(f.u.M, sid, {
                decisions: [{ nominationId: p2.id, status: 'declined' }],
                additions: [{ employeeId: f.P3, group: 'peer' }],
            });
            // self + manager + P1 + D1 + P3 (P2 declined)
            expect(out.invited).toBe(5);
            st = await db.get('SELECT status FROM feedback360_subjects WHERE id = ?', [sid]);
            expect(st.status).toBe('collecting');
            const rows = await db.all(
                'SELECT rater_employee_id, status, proposed_by FROM feedback360_nominations WHERE subject_id = ?',
                [sid]
            );
            const by = Object.fromEntries(rows.map((r) => [Number(r.raterEmployeeId), r]));
            expect(by[f.P2].status).toBe('declined');
            expect(by[f.P3].proposedBy).toBe('manager');
            // The declined rater has no questionnaire.
            expect(await status(svc.questionnaire(f.u.P2, by[f.P2].id))).toBe(404);
            // The subject's own view: their proposals only — no answer status, no manager additions.
            const mine = await svc.subjectView(f.u.S, sid);
            expect(mine.nominations.map((n) => n.employeeId).sort()).toEqual(
                [f.P1, f.P2, f.D1].sort()
            );
            expect(JSON.stringify(mine.nominations)).not.toContain('responded');
        });
    });

    test('the full round: a group of 2 is never shown, "not observed" is not 0, no rater identity', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            K.K1 = f.K1;
            K.K2 = f.K2;
            const { roundId, sid, nom } = await openRound(f);
            // Only the rater opens their questionnaire.
            expect(await status(svc.questionnaire(f.u.X, nom[f.P1]))).toBe(404);
            expect(await status(svc.questionnaire(f.u.P2, nom[f.P1]))).toBe(404);
            const q = await svc.questionnaire(f.u.P1, nom[f.P1], 'en');
            expect(q.skills.map((s) => Number(s.key)).sort()).toEqual([f.K1, f.K2].sort());
            expect(q.behaviours.length).toBeGreaterThan(3);

            await answer(f.u.S, nom[f.S], '4', '1', 'self keep');
            await answer(f.u.M, nom[f.M], '2', 'na', 'manager keep');
            await answer(f.u.P1, nom[f.P1], '2', 'na', 'peer keep');
            await answer(f.u.P2, nom[f.P2], '2', 'na');
            await answer(f.u.P3, nom[f.P3], '3', '1');
            // The direct-report group: TWO answers, extreme values, unique comments.
            await answer(f.u.D1, nom[f.D1], '0', '0', 'DR-SECRET-ONE');
            await answer(f.u.D2, nom[f.D2], '0', '0', 'DR-SECRET-TWO');
            // Once only.
            expect(await status(answer(f.u.P1, nom[f.P1], '4', '4'))).toBe(409);

            // Responses carry a group, never a rater.
            const cols = await db.all(
                `SELECT column_name FROM information_schema.columns WHERE table_name = 'feedback360_responses'`
            );
            expect(cols.map((c) => c.columnName).sort()).toEqual([
                'id',
                'rater_group',
                'subject_id',
            ]);

            // Who answered is visible to the manager (reminders), not what.
            const staff = await svc.subjectView(f.u.M, sid);
            expect(staff.nominations.every((n) => n.responded === true)).toBe(true);

            // Before close: nobody reads the report.
            expect(await status(svc.report(f.u.M, sid))).toBe(403);
            expect(await status(svc.report(f.u.S, sid))).toBe(403);

            // Closing is for the launcher / HR — not a rater.
            expect(await status(svc.closeRound(f.u.P1, roundId))).toBe(404);
            await svc.closeRound(f.u.M, roundId);

            // Not yet released: the subject is refused, the manager and HR read.
            expect(await status(svc.report(f.u.S, sid))).toBe(403);
            for (const u of [f.u.X, f.u.P1, f.u.D1, f.u.NOSCOPE])
                expect(await status(svc.report(u, sid))).toBe(404);
            const hr = await svc.report(f.u.HR, sid, 'en');
            expect(hr.skills.length).toBe(2);

            const rep = await svc.report(f.u.M, sid, 'en');
            const dr = rep.groups.find((g) => g.key === 'direct_report');
            expect(dr.state).toBe('hidden');
            expect(dr.responses).toBeUndefined();
            const k1 = rep.skills.find((s) => s.skillId === f.K1);
            // Peers only: (2+2+3)/3 — the two zeros of the hidden group never count.
            expect(k1.others.value).toBe(2.33);
            expect(k1.self.value).toBe(4);
            expect(k1.manager.value).toBe(2);
            expect(k1.required).toBe(3);
            expect(k1.flag).toBe('blind_spot');
            const k2 = rep.skills.find((s) => s.skillId === f.K2);
            // "Not observed" by the manager is not a 0 …
            expect(k2.manager).toEqual({ state: 'not_observed', value: null });
            // … and one peer observation out of three is too few to print.
            expect(k2.others.value).toBeNull();

            // THE JSON: no rater name, no rater id, no nomination, no response id.
            const flat = JSON.stringify(rep);
            for (const leak of [
                'PeerOne',
                'PeerTwo',
                'PeerThree',
                'ReportOne',
                'ReportTwo',
                'DR-SECRET',
            ])
                expect(flat).not.toContain(leak);
            for (const key of ['raterEmployeeId', 'nominationId', 'responded', 'respondentKey'])
                expect(flat).not.toContain(key);
            const ids = await db.all('SELECT id FROM feedback360_responses WHERE subject_id = ?', [
                sid,
            ]);
            for (const r of ids) expect(flat).not.toContain(String(r.id));
            const idRe = new RegExp(`\\b(${[f.P1, f.P2, f.P3, f.D1, f.D2].join('|')})\\b`);
            expect(flat).not.toMatch(idRe);
            expect(rep.comments.keep.sort()).toEqual(['manager keep', 'peer keep', 'self keep']);

            // The subject may not release their own report; the manager does.
            expect(await status(svc.release(f.u.S, sid))).toBe(403);
            await svc.release(f.u.M, sid);
            const own = await svc.report(f.u.S, sid, 'fr');
            expect(own.viewer.isSubject).toBe(true);
            expect(JSON.stringify(own)).not.toContain('PeerOne');
        });
    });

    test('"Add to my development plan" creates IDP objectives through IDPService, once', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            K.K1 = f.K1;
            K.K2 = f.K2;
            const { roundId, sid, nom } = await openRound(f);
            await answer(f.u.S, nom[f.S], '4', '2');
            await answer(f.u.M, nom[f.M], '2', '2');
            await db.run(`UPDATE feedback360_rounds SET release_mode = 'on_close' WHERE id = ?`, [
                roundId,
            ]);
            await svc.closeRound(f.u.M, roundId);
            // Only the subject adds to THEIR plan.
            expect(await status(svc.addToIdp(f.u.M, sid, [f.K1], 'en'))).toBe(403);
            expect(await status(svc.addToIdp(f.u.X, sid, [f.K1], 'en'))).toBe(404);
            const out = await svc.addToIdp(f.u.S, sid, [f.K1], 'en');
            expect(out).toMatchObject({ created: true, added: 1, skipped: 0 });
            const obj = await db.all(
                `SELECT o.skill_id, o.smart_text, o.state::text AS state, p.status::text AS status
                   FROM idp_objectives o JOIN idp_plans p ON p.id = o.idp_id WHERE p.employee_id = ?`,
                [f.S]
            );
            expect(obj).toHaveLength(1);
            expect(Number(obj[0].skillId)).toBe(f.K1);
            expect(obj[0].state).toBe('pending');
            expect(obj[0].status).toBe('draft');
            expect(obj[0].smartText).toMatch(/360/);
            const ev = await db.get(
                `SELECT COUNT(*)::int AS n FROM idp_plan_events WHERE idp_id = ? AND action = 'objective_added'`,
                [out.idpId]
            );
            expect(ev.n).toBe(1);
            // A second click adds nothing.
            const again = await svc.addToIdp(f.u.S, sid, [f.K1], 'en');
            expect(again).toMatchObject({ added: 0, skipped: 1 });
        });
    });

    test('the tick closes a round past its deadline and reminds non-responders', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            K.K1 = f.K1;
            K.K2 = f.K2;
            const { roundId, sid, nom } = await openRound(f);
            await db.run(
                `UPDATE feedback360_nominations SET invited_at = now() - interval '4 days' WHERE subject_id = ?`,
                [sid]
            );
            const r1 = await svc.remindNonResponders(roundId);
            expect(r1.reminded).toBe(7);
            // Reminded once a week at most.
            expect((await svc.remindNonResponders(roundId)).reminded).toBe(0);
            await answer(f.u.P1, nom[f.P1], '2', '2');
            await db.run(`UPDATE feedback360_rounds SET deadline = CURRENT_DATE - 1 WHERE id = ?`, [
                roundId,
            ]);
            const out = await svc.tick();
            expect(out.closed).toBeGreaterThanOrEqual(1);
            const r = await db.get('SELECT status FROM feedback360_rounds WHERE id = ?', [roundId]);
            expect(r.status).toBe('closed');
        });
    });
});
