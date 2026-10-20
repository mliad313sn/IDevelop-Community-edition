'use strict';
/**
 * The manager's home (ManagerHomeService, 4.0.0 port wave 10) on the REAL
 * schema, inside a transaction that is always rolled back. Invented people
 * only: the KPI fixture world (tests/helpers/kpiWorld.js) — a manager M, the
 * ready A to A4, B not ready, C partial, D not assessed, E a known critical
 * fail, the leaver F and the erased G — plus, for this suite:
 *
 *   validations  B submitted 12 days ago, C today, the leaver F (absent)
 *   disputes     an open level-0 dispute of D (today), one of E already
 *                answered with a proposal (not waiting on the manager)
 *   changes      a pending request raised by E, one raised by M himself
 *   actions      B reported an action done 3 days ago; another, completed
 *   proposals    C proposed an action to the line 8 days ago; one routed to HR
 *   plans        E's plan ended 100 days ago (late), D's 30 days ago (not yet)
 *   handovers    E's open handover is 5 days past its due date
 *   safety       nobody has a status row first (« not configured »), then A
 *                is blocked since 2 days and B cleared
 *   targets      A wishes a role she meets, A2 a role above her level, A3 a
 *                role with an unassessed requirement, A4 is nominated for the
 *                role A meets; B (not ready) wishes a role too
 *
 * Checked: the counts and ages per line, today is 0 (the view says
 * « today »), the top task, « not configured » never 0, a module that is off
 * leaves its lines out, the ready-to-move-on counts with the requirement
 * credited (never above), no name and no person id in the model.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(90000);

const db = HAS_DB ? require('../../src/config/database') : null;
const W = require('../helpers/kpiWorld');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ALL = { development: true, talent: true, mobility: true };

/** A self-assessment line: submitted (waiting for validation) or already reviewed. */
async function round(person, skill, ago, state = 'submitted') {
    const r = await db.get(
        `INSERT INTO self_assessment_rounds (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at)
         VALUES (?, ?, 2, ?::self_assessment_state, ?, now() - (? || ' days')::interval) RETURNING id`,
        [person, skill, state, state, String(ago)]
    );
    return Number(r.id);
}

async function teamWorld(w, F) {
    const dom = await db.get('SELECT domain_id AS "d" FROM skills WHERE id = ?', [F.SKILLS[0]]);
    const extra = await db.get('INSERT INTO skills (domain_id, name) VALUES (?, ?) RETURNING id', [
        Number(dom.d),
        `MH skill ${W.STAMP}`,
    ]);
    const S4 = Number(extra.id);
    // validations
    await round(w.B, w.S1, 12);
    await round(w.C, w.S1, 0);
    await round(w.F, w.S1, 3);
    // disputes: D open today; E answered with a proposal
    const dispute = async (person, proposed) => {
        const rid = await round(person, w.S2, 20, 'reviewed');
        const rv = await db.get(
            `INSERT INTO supervisor_reviews (self_assessment_id, employee_id, skill_id, supervisor_rated_level,
                                             gap, reviewed_by, reviewed_at, status)
             VALUES (?, ?, ?, 1, -1, ?, now(), 'disputed') RETURNING id`,
            [rid, person, w.S2, w.M]
        );
        await db.run(
            `INSERT INTO assessment_disputes (supervisor_review_id, employee_id, reason, proposed_at, proposed_rating, proposed_by)
             VALUES (?, ?, 'Invented reason', ?, ?, ?)`,
            [
                Number(rv.id),
                person,
                proposed ? new Date() : null,
                proposed ? 2 : null,
                proposed ? w.M : null,
            ]
        );
    };
    await dispute(w.D, false);
    await dispute(w.E, true);
    // change requests
    const acr = async (person, by, skill) => {
        const rid = await round(person, skill, 30, 'reviewed');
        await db.run(
            `INSERT INTO assessment_change_requests (self_assessment_id, employee_id, requester_ref, requester_role,
                                                     reason, target_state, status, created_at)
             VALUES (?, ?, ?, ?, 'Invented reason', 'draft', 'pending', now() - interval '4 days')`,
            [rid, person, `employee:${by}`, by === w.M ? 'manager' : 'employee']
        );
    };
    await acr(w.E, w.E, w.S3);
    await acr(w.A, w.M, w.S3);
    // plan actions and proposals
    const plan = await db.get(
        "INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id",
        [w.B]
    );
    await db.run(
        `INSERT INTO idp_actions (idp_id, type, title, status, reported_done_at)
         VALUES (?, 'training', 'Invented action', 'in_progress', now() - interval '3 days'),
                (?, 'training', 'Invented action', 'completed', now() - interval '9 days')`,
        [Number(plan.id), Number(plan.id)]
    );
    await db.run(
        `INSERT INTO dev_proposals (employee_id, proposal_text, routed_to, created_at)
         VALUES (?, 'Invented proposal', 'line', now() - interval '8 days'),
                (?, 'Invented proposal', 'hr', now() - interval '20 days')`,
        [w.C, w.D]
    );
    // late plans
    await db.run(
        `INSERT INTO idp_plans (employee_id, status, ends_on) VALUES (?, 'active', CURRENT_DATE - 100),
                                                                     (?, 'active', CURRENT_DATE - 30)`,
        [w.E, w.D]
    );
    // handover
    const ho = await db.get(
        `INSERT INTO handover_plans (outgoing_employee_id, status, due_date)
         VALUES (?, 'open', CURRENT_DATE - 5) RETURNING id`,
        [w.E]
    );
    await db.run(
        "INSERT INTO handover_items (handover_id, title, status) VALUES (?, 'Invented item', 'open')",
        [Number(ho.id)]
    );
    // target roles
    const role = async (name, reqs) => {
        const r = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [
            `${name}-${W.STAMP}`,
        ]);
        for (const [skill, level, crit] of reqs)
            await db.run(
                'INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical) VALUES (?, ?, ?, ?)',
                [Number(r.id), skill, level, crit]
            );
        return Number(r.id);
    };
    // A is assessed 2 on S1..S3: a requirement of 1 on S1 credits 1, never 2
    const T_MET = await role('MH-MET', [
        [w.S1, 1, true],
        [w.S2, 2, false],
    ]);
    const T_ABOVE = await role('MH-ABOVE', [[w.S3, 4, false]]);
    const T_OPEN = await role('MH-OPEN', [[S4, 2, false]]);
    const wish = (person, roleId) =>
        db.run('INSERT INTO employee_aspirations (employee_id, target_role_id) VALUES (?, ?)', [
            person,
            roleId,
        ]);
    await wish(w.A, T_MET);
    await wish(w.A2, T_ABOVE);
    await wish(w.A3, T_OPEN);
    await wish(w.B, T_MET);
    const sp = await db.get(
        "INSERT INTO succession_plans (position_role_id, status) VALUES (?, 'active') RETURNING id",
        [T_MET]
    );
    await db.run(
        "INSERT INTO successors (plan_id, candidate_employee_id, state) VALUES (?, ?, 'active')",
        [Number(sp.id), w.A4]
    );
    return { T_MET };
}

const byKey = (bl) => Object.fromEntries(bl.lines.map((l) => [l.key, l]));

suite('the manager home on the real schema (invented people, rolled back)', () => {
    test('waiting on me, expiring, ready to move on', async () => {
        const out = await W.inRolledBackTx(db, async (q) => {
            const F = await W.seedFacts(db);
            const w = await W.world(db, F, q);
            await teamWorld(w, F);
            const MH = require('../../src/services/ManagerHomeService');
            const K = require('../../src/services/KpiService');
            const mgr = W.managerOf(w);
            const pop = await K.resolvePopulation({ viewer: mgr });
            const r = { w, ids: pop.ids };
            r.before = await MH.backlog({
                viewer: mgr,
                ids: pop.ids,
                flags: ALL,
                caps: { safety: true },
            });
            await db.run(
                `INSERT INTO safety_gate_status (employee_id, status, enforced_status, reasons, fingerprint, computed_at, changed_at)
                 VALUES (?, 'BLOCKED', 'BLOCKED', '[]'::jsonb, 't', now(), now() - interval '2 days'),
                        (?, 'CLEARED', 'CLEARED', '[]'::jsonb, 't', now(), now())
                 ON CONFLICT (employee_id) DO UPDATE SET status = EXCLUDED.status,
                        enforced_status = EXCLUDED.enforced_status, changed_at = EXCLUDED.changed_at`,
                [w.A, w.B]
            );
            r.after = await MH.backlog({
                viewer: mgr,
                ids: pop.ids,
                flags: ALL,
                caps: { safety: true },
            });
            r.core = await MH.backlog({
                viewer: mgr,
                ids: pop.ids,
                flags: {},
                caps: { safety: false },
            });
            const bundle = await K.readinessBundle({ viewer: mgr });
            r.ready = await MH.readyToGrow({
                people: bundle.people,
                threshold: bundle.threshold,
                flags: ALL,
            });
            r.readyWishesOnly = await MH.readyToGrow({
                people: bundle.people,
                threshold: bundle.threshold,
                flags: { mobility: true },
            });
            r.readyOff = await MH.readyToGrow({
                people: bundle.people,
                threshold: bundle.threshold,
                flags: {},
            });
            r.k8 = await K.compute('K8', { viewer: mgr });
            // the whole page model, as the controller builds it
            const D = require('../../src/services/DashboardHomeService');
            const ctx = await D.context({
                user: mgr,
                query: {},
                page: 'dashboard',
                remember: false,
            });
            r.home = await D.teamHome(ctx, {
                t: (k) => k,
                fmt: require('../../src/utils/kpiFormat').forLang('en'),
            });
            return r;
        });
        const { w } = out;
        // the population: the team, no leaver, no erased person
        expect(out.ids).toEqual(expect.arrayContaining([w.A, w.B, w.C, w.D, w.E, w.H]));
        expect(out.ids).not.toContain(w.F);
        expect(out.ids).not.toContain(w.G);

        const b = byKey(out.before);
        expect(b.validations).toMatchObject({ count: 2, oldestDays: 12, over7: 1 });
        expect(b.disputes).toMatchObject({ count: 1, oldestDays: 0, over7: 0 });
        expect(b.changes).toMatchObject({ count: 1, oldestDays: 4 });
        expect(b.actions).toMatchObject({ count: 1, oldestDays: 3, over7: 0 });
        expect(b.proposals).toMatchObject({ count: 1, oldestDays: 8, over7: 1 });
        expect(b.plans).toMatchObject({ count: 1, oldestDays: 100, ageKind: 'late' });
        expect(b.handovers).toMatchObject({ count: 1, oldestDays: 5, ageKind: 'late' });
        // nobody has a clearance computed: « not configured », never 0
        expect(b.safety).toMatchObject({ notConfigured: true, count: null, mandatory: true });
        expect(out.before.top.key).toBe('validations');

        const a = byKey(out.after);
        expect(a.safety).toMatchObject({ count: 1, oldestDays: 2 });
        expect(out.after.top.key).toBe('safety');
        expect(out.after.total).toBe(9);

        // modules off: their lines are left out, not « not measured »
        expect(out.core.lines.map((l) => l.key)).toEqual(['validations', 'disputes', 'changes']);

        // ready to move on: A (met, the S1 surplus credited at 1) and A4
        // (nominated) are ready for the target; A2 has a gap; A3 is to assess;
        // B is not ready in her own role, so she is not counted at all
        expect(out.ready).toMatchObject({
            readyNow: 4,
            withTarget: 4,
            readyForTarget: 2,
            toAssess: 1,
        });
        expect(out.readyWishesOnly).toMatchObject({
            withTarget: 3,
            readyForTarget: 1,
            toAssess: 1,
        });
        expect(out.readyOff).toBeNull();

        // the fixture skills carry no certification policy: not configured
        expect(out.k8.status).toBe('not_configured');
        const watch = out.home.watch;
        expect(watch.empty).toBe(false);
        expect(watch.backlog.lines.length).toBeGreaterThan(0);
        if (watch.expiry) expect(watch.expiry.state).toBe('not_configured');

        // no name and no person id in what the page receives
        const json = JSON.stringify(watch);
        expect(json).not.toMatch(/Kpi[A-H]|Fixture|Invented/);
        expect(json).not.toMatch(/employeeId|empId|"ids?"/);
    });

    test('an administrator gets no watch (the manager page only)', async () => {
        const home = await W.inRolledBackTx(db, async () => {
            const F = await W.seedFacts(db);
            const D = require('../../src/services/DashboardHomeService');
            const ctx = await D.context({
                user: F.SUPER,
                query: {},
                page: 'dashboard',
                remember: false,
            });
            return D.teamHome(ctx, {
                t: (k) => k,
                fmt: require('../../src/utils/kpiFormat').forLang('en'),
            });
        });
        expect(home.watch == null).toBe(true);
    });
});
