'use strict';
/**
 * The health and safety operations indicators (K40 to K44, HseOpsService) on
 * the REAL schema, inside a transaction that is always rolled back. Invented
 * people only, on a new site and a new role:
 *
 *   P1..P5  on the gated role, a required certificate each (S1):
 *           P1 complete with an issuer, expires in 40 days
 *           P2 complete, no issuer, expires in 100 days
 *           P3 no expiry date and no policy: not dated
 *           P4 complete, expired 5 days ago, an open contest, blocked last night
 *           P5 no certificate number, expires in 200 days
 *   P6      on the gated role, never recorded: a running HSE waiver, blocked on
 *           demand two weeks ago
 *   P7      a LEAVER with a running waiver: absent everywhere
 *   Coverage rules on the site (S2 at level 2): one needs 2 people and holds
 *   until P1's planned leave, one needs 5 and is in breach now.
 *
 * Checked: the figures, the statuses (never « compliant » while a waiver
 * runs, while a rule is broken, while a record is short), « not measured »
 * as null and never 0, no person id or name in any result, and a reader who
 * governs nobody gets empty scopes, not zeros.
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

const STAMP = `${Date.now()}`.slice(-7);

async function hseWorld(F, q) {
    const site = await db.get('INSERT INTO sites (name) VALUES (?) RETURNING id', [
        `HSE-SITE-${STAMP}`,
    ]);
    const X = Number(site.id);
    const role = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [
        `HSE-ROLE-${STAMP}`,
    ]);
    const R = Number(role.id);
    const [S1, S2] = F.SKILLS;
    const emp = async (tag, active = true) => {
        const r = await db.get(
            `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                    service_id, role_id, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [
                `HSE-${tag}-${STAMP}`,
                `Hse${tag}`,
                `Fixture${STAMP}`,
                X,
                F.ORG.departmentId,
                F.ORG.serviceId,
                R,
                active,
            ]
        );
        return Number(r.id);
    };
    const P = {};
    for (const t of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) P[t] = await emp(t);
    P.P7 = await emp('P7', false);

    const rule = await db.get(
        `INSERT INTO safety_gate_rules (role_id, skill_id, min_level, cert_required, mode, is_active)
         VALUES (?, ?, 1, true, 'enforce', true) RETURNING id`,
        [R, S1]
    );
    const cert = (e, { expires, number = 'N-1', voc = true, clean = true, issuer = null }) =>
        db.run(
            `INSERT INTO employee_certifications
                 (employee_id, skill_id, cert_number, issued_on, expires_on, verified_at,
                  file_uri, av_status, issuer)
             VALUES (?, ?, ?, CURRENT_DATE - 300, ${expires === null ? 'NULL' : `CURRENT_DATE + (${Number(expires)})`},
                     ${voc ? 'now()' : 'NULL'}, ?, ?, ?)`,
            [e, S1, number, clean ? 'cert-fixture.pdf' : null, clean ? 'clean' : null, issuer]
        );
    await cert(P.P1, { expires: 40, issuer: 'Northfield Training Centre' });
    await cert(P.P2, { expires: 100 });
    await cert(P.P3, { expires: null });
    await cert(P.P4, { expires: -5 });
    await cert(P.P5, { expires: 200, number: null });

    const waiver = (e, via) =>
        db.run(
            `INSERT INTO safety_gate_waivers (employee_id, skill_id, rule_id, reason, granted_by_ref,
                                              granted_via, expires_at)
             VALUES (?, ?, ?, 'fixture', 'admin:1', ?, now() + interval '24 hours')`,
            [e, S1, Number(rule.id), via]
        );
    await waiver(P.P6, 'hse');
    await waiver(P.P7, 'line');
    await db.run(
        `INSERT INTO safety_gate_contests (employee_id, contested_by_ref, contested_as, reason,
                                           status_at_contest)
         VALUES (?, 'employee:1', 'self', 'fixture', 'BLOCKED')`,
        [P.P4]
    );
    const hist = (e, code, source, when) =>
        db.run(
            `INSERT INTO safety_gate_status_history
                 (employee_id, previous_status, status, enforced_status, reasons, source, changed_at)
             VALUES (?, 'CLEARED', 'BLOCKED', 'BLOCKED', ?::jsonb, ?, ${when})`,
            [e, JSON.stringify([{ code, blocking: true }]), source]
        );
    await hist(P.P4, 'cert_expired', 'nightly', "now() - interval '1 day'");
    // a re-evaluation of a person already blocked is not a new entry
    await hist(P.P4, 'cert_expired', 'nightly', "now() - interval '2 hours'");
    await hist(P.P6, 'cert_missing', 'on_demand', "now() - interval '14 days'");

    // coverage rules on the site, skill S2 at level 2
    for (const t of ['P1', 'P2'])
        await db.run(
            `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
             VALUES (?, ?, 2, ?, 'HSE fixture')`,
            [P[t], S2, F.adminId]
        );
    await db.run(
        `INSERT INTO coverage_rules (name, site_id, skill_id, min_level, min_headcount, severity)
         VALUES (?, ?, ?, 2, 2, 'critical'), (?, ?, ?, 2, 5, 'warning')`,
        [`HSE-COV-A-${STAMP}`, X, S2, `HSE-COV-B-${STAMP}`, X, S2]
    );
    await db.run(
        `INSERT INTO planned_absences (employee_id, starts_on, ends_on)
         VALUES (?, CURRENT_DATE + 10, CURRENT_DATE + 20)`,
        [P.P1]
    );
    void q;
    return { X, R, P };
}

suite('K40 to K44 on the real schema', () => {
    test('the figures, the statuses and the honesty rules', async () => {
        const F = await W.seedFacts(db);
        const out = await W.inRolledBackTx(db, async (q) => {
            const w = await hseWorld(F, q);
            const H = require('../../src/services/HseOpsService');
            const K = require('../../src/services/KpiService');
            const scope = { viewer: F.SUPER, siteId: w.X };
            const all = await H.forDashboard(scope);
            const viaRegistry = await K.compute('K44', scope);
            const nobody = await H.forDashboard({
                viewer: { id: w.P.P1, userType: 'manager', role: 'manager' },
            });
            const nobodyK40 = await K.compute('K40', {
                viewer: { id: w.P.P1, userType: 'manager', role: 'manager' },
            });
            return { w, all, viaRegistry, nobody, nobodyK40 };
        });
        const { w, all } = out;
        expect(all.people).toBe(6); // the leaver is out

        // K40: one waiver runs (the leaver's does not count), never compliant
        expect(all.K40.value).toBe(1);
        expect(all.K40.status).toBe('watch');
        expect(all.K40.n).toBe(6);
        expect(all.K40.breakdown).toMatchObject({
            running: 1,
            granted30Hse: 1,
            granted30Line: 0,
            granted30: 1,
            contestsOpen: 1,
            upheld90: 0,
        });

        // K41: two entries into « blocked » (the re-evaluation is not one)
        expect(all.K41.value).toBe(2);
        expect(all.K41.reasons).toEqual([
            { code: 'cert_expired', n: 1 },
            { code: 'cert_missing', n: 1 },
        ]);
        expect(all.K41.weeks).toHaveLength(13);
        for (const wk of all.K41.weeks) {
            // a week is null exactly when nothing ran and nothing was recorded
            if (wk.count === null) expect(wk.recomputed).toBe(false);
            else expect(typeof wk.count).toBe('number');
        }
        expect(all.K41.breakdown.unrecomputedWeeks).toBe(
            all.K41.weeks.filter((x) => x.count === null).length
        );

        // K42: P1, P2, P5 expire within 12 months; P3 apart; P4 already expired
        expect(all.K42.value).toBe(3);
        expect(all.K42.breakdown).toEqual({ expiring12m: 3, noDate: 1 });
        expect(all.K42.totals.reduce((a, b) => a + b, 0)).toBe(3);
        expect(all.K42.months).toHaveLength(12);
        expect(all.K42.sites).toHaveLength(1);
        expect(all.K42.sites[0].siteName).toBe(`HSE-SITE-${STAMP}`);

        // K43: one rule broken now (warning), one holds until P1's leave
        expect(all.K43.value).toBe(1);
        expect(all.K43.status).toBe('watch');
        expect(all.K43.breakdown).toEqual({
            active: 2,
            breached: 1,
            breachedCritical: 0,
            breachedWarning: 1,
            projected30: 1,
            projected60: 1,
            projected90: 1,
        });

        // K44: 3 complete of 5 recorded, rounded down, never compliant; P6 apart
        expect(all.K44.breakdown).toEqual({ recorded: 5, complete: 3, incomplete: 2, missing: 1 });
        expect(all.K44.value).toBe(60);
        expect(all.K44.status).toBe('watch');
        expect(all.K44.rates.issuer).toEqual({ filled: 1, recorded: 5, pct: 20 });
        expect(all.K44.rates.numbered).toEqual({ filled: 4, recorded: 5, pct: 80 });
        expect(all.K44.rates.dated).toEqual({ filled: 4, recorded: 5, pct: 80 });
        expect(out.viaRegistry.value).toBe(60);

        // no person id, no name anywhere in the model
        const text = JSON.stringify(all);
        for (const id of Object.values(w.P)) {
            expect(text).not.toMatch(new RegExp(`"employeeId":${id}\\b`));
        }
        expect(text).not.toMatch(/Hse(P\d)|Fixture\d/);
        for (const k of ['K40', 'K41', 'K42', 'K43', 'K44'])
            expect([k, all[k].drill]).toEqual([k, []]);

        // a reader who governs nobody: empty scopes, never zeros
        expect(out.nobody).toEqual({ people: 0 });
        expect(out.nobodyK40).toMatchObject({
            value: null,
            emptyScope: true,
            status: 'not_measured',
        });
    });

    test('nothing set up: « to be set up », never 0', async () => {
        const F = await W.seedFacts(db);
        const out = await W.inRolledBackTx(db, async () => {
            const site = await db.get('INSERT INTO sites (name) VALUES (?) RETURNING id', [
                `HSE-EMPTY-${STAMP}`,
            ]);
            const role = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [
                `HSE-EMPTY-${STAMP}`,
            ]);
            await db.run(
                `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                        service_id, role_id, is_active)
                 VALUES (?, 'HseQ', 'Fixture', ?, ?, ?, ?, true)`,
                [
                    `HSE-Q-${STAMP}`,
                    Number(site.id),
                    F.ORG.departmentId,
                    F.ORG.serviceId,
                    Number(role.id),
                ]
            );
            return require('../../src/services/HseOpsService').forDashboard({
                viewer: F.SUPER,
                siteId: Number(site.id),
            });
        });
        expect(out.people).toBe(1);
        for (const k of ['K40', 'K41', 'K42', 'K43', 'K44']) {
            expect([k, out[k].status]).toEqual([k, 'not_configured']);
            expect([k, out[k].value]).toEqual([k, null]);
        }
    });
});
