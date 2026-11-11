'use strict';
/**
 * The executive indicators K17, K19, K20, K21 (ExecutiveKpiService) on the
 * REAL schema, inside a transaction that is always rolled back, over the KPI
 * fixture world (tests/helpers/kpiWorld.js, invented people only):
 *
 *   K17  five approvals two days after submission, one round waiting twelve
 *        days: a median, the waiting round censored, the backlog late;
 *   K20  a legally mandatory rule on the world's role: exposed = the known
 *        failures plus those who never showed it, never « compliant »;
 *   K21  the world's role made critical with no successor: « not measured »
 *        while no flight risk is reviewed, exposed once one is high;
 *   K19  a real departure through LifecycleService: the capability is
 *        captured into the event BEFORE the switch-off, and K19 reads it.
 *
 * No person id or name leaves a result.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(90000);

jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue({ inapp: 'ok' }),
    enqueue: jest.fn().mockResolvedValue({}),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
    notifyMany: jest.fn().mockResolvedValue(undefined),
    KIND_META: {},
}));

const db = HAS_DB ? require('../../src/config/database') : null;
const W = require('../helpers/kpiWorld');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const X = () => require('../../src/services/ExecutiveKpiService');

/** Every number found under a key naming a person (employeeId, ids, drill…). */
function personIds(result) {
    const out = [];
    const visit = (v, key) => {
        if (v == null) return;
        if (Array.isArray(v)) return v.forEach((x) => visit(x, key));
        if (typeof v === 'object') return Object.keys(v).forEach((k) => visit(v[k], k));
        if (typeof v === 'number' && /employee|person|drill|^ids?$/i.test(String(key))) out.push(v);
    };
    visit(result, '');
    return out;
}

suite('the executive indicators on the real schema', () => {
    test('K17, K20, K21 and the K19 capture at a real departure', async () => {
        const out = await W.inRolledBackTx(db, async (q) => {
            const F = await W.seedFacts(db);
            const w = await W.world(db, F, q);
            const scope = { viewer: F.SUPER, employeeIds: W.fixtureIds(w) };
            const res = {};

            // K17: five approvals, two days each; one round waiting twelve days
            const round = (e, skill, approved) =>
                db.run(
                    approved
                        ? `INSERT INTO self_assessment_rounds (employee_id, skill_id, self_rated_level, status,
                               workflow_state, submitted_at, approved_at, approved_by_ref)
                           VALUES (?, ?, 2, 'approved', 'approved', now() - interval '10 days',
                                   now() - interval '8 days', 'admin:1')`
                        : `INSERT INTO self_assessment_rounds (employee_id, skill_id, self_rated_level, status,
                               workflow_state, submitted_at)
                           VALUES (?, ?, 2, 'submitted', 'submitted', now() - interval '12 days')`,
                    [e, skill]
                );
            for (const t of ['A', 'A2', 'A3', 'A4', 'B']) await round(w[t], w.S3, true);
            await round(w.C, w.S3, false);
            res.k17 = await X().k17ValidationLeadTime(scope);

            // K20: before any legal rule, then with one on the world's role
            res.k20none = await X().k20LegalSafetyExposure(scope);
            await db.run(
                `INSERT INTO safety_gate_rules (role_id, skill_id, min_level, mode, is_active, legally_mandatory)
                 VALUES (?, ?, 2, 'enforce', true, true)`,
                [w.R, w.S1]
            );
            res.k20 = await X().k20LegalSafetyExposure(scope);

            // K21: the world's role is critical and has no successor
            await db.run(
                `INSERT INTO role_criticality (role_id, criticality_score) VALUES (?, 5)
                 ON CONFLICT (role_id) DO UPDATE SET criticality_score = 5`,
                [w.R]
            );
            res.k21unknown = await X().k21KeyRolesExposed(scope);
            await db.run(
                `INSERT INTO retention_risk (employee_id, flight_risk) VALUES (?, 'high')
                 ON CONFLICT (employee_id) DO UPDATE SET flight_risk = 'high'`,
                [w.A]
            );
            res.k21 = await X().k21KeyRolesExposed(scope);

            // K19: a real departure of A (ready, all requirements met)
            res.capture = await X().captureLeaverCapability(w.A);
            const L = require('../../src/services/LifecycleService');
            await L.record('leaver', w.A, { reason: 'fixture departure', actorRef: 'admin:1' });
            const ev = await db.get(
                `SELECT payload->'capability' AS "cap", processed_at AS "processedAt"
                   FROM lifecycle_events WHERE employee_id = ? AND kind = 'leaver'
                  ORDER BY id DESC LIMIT 1`,
                [w.A]
            );
            res.event = ev;
            res.k19 = await X().k19CapabilityLost({ viewer: F.SUPER, siteId: F.ORG.siteId });
            res.k19other = await X().k19CapabilityLost({ viewer: F.SUPER, siteId: 'none' });
            return { res, w };
        });
        const { res, w } = out;

        expect(res.k17).toMatchObject({ kpi: 'K17', n: 5, censored: 1, value: 2, status: 'watch' });
        expect(res.k17.backlog.total).toBeGreaterThanOrEqual(1);
        expect(res.k17.late).toBeGreaterThanOrEqual(1);
        expect(res.k17.p90).toBeNull(); // fewer than 10 approvals

        expect(res.k20none).toMatchObject({ value: null, status: 'not_configured' });
        // A..A4 meet the rule; B and E fail it; C, D and H never showed it
        expect(res.k20.breakdown).toEqual({ covered: 9, exposed: 5, knownFail: 2, notShown: 3 });
        expect(res.k20).toMatchObject({ value: 5, status: 'at_risk' });

        expect(res.k21unknown).toMatchObject({ value: null, status: 'not_measured' });
        expect(res.k21unknown.breakdown).toMatchObject({ uncovered: 1, notAssessed: 1 });
        expect(res.k21).toMatchObject({ value: 1, status: 'watch' });

        expect(res.capture).toMatchObject({ readiness: 'ready', soleCritical: 0, v: 'kpi-2' });
        expect(res.event.processedAt).toBeTruthy();
        expect(res.event.cap).toMatchObject({ readiness: 'ready', roleId: w.R });
        expect(res.k19.measured).toBeGreaterThanOrEqual(1);
        expect(res.k19.readyAtDeparture).toBeGreaterThanOrEqual(1);
        expect(res.k19.insufficientHistory).toBe(false);
        expect(res.k19other.leavers).toBe(0);

        for (const r of [res.k17, res.k20, res.k21, res.k19]) {
            expect(personIds(r)).toEqual([]);
            expect(JSON.stringify(r)).not.toMatch(/Kpi[A-H]|Fixture\d/);
        }
    });
});
