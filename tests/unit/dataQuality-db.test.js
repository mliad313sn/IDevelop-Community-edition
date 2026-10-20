'use strict';
/**
 * « Data quality » (DataQualityService, 4.0.0 port wave 10) on the REAL
 * schema, inside a transaction that is always rolled back. Invented people
 * only: the KPI fixture world (tests/helpers/kpiWorld.js) and its local
 * administrator L, scoped to the fixture service.
 *
 * Checked:
 *   - a SuperAdmin gets every organisation section; a local administrator gets
 *     only the sections of the permissions they hold, and none without one;
 *   - the people section counts the reader's clearance, leavers and erased
 *     people excluded, with the dashboard's own « no requirement » and « not
 *     assessed yet » (K1), and a role start date captured lowers its row;
 *   - the development section: open actions without a due date, plans with
 *     no open action;
 *   - the certificates section is « not configured » (no role of the
 *     fixtures requires a certificate), never 0;
 *   - an empty clearance gives « nothing concerned », never « no anomaly »;
 *   - no name and no person id anywhere in the model.
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

const rowsOf = (panel, key) => {
    const s = panel.sections.find((x) => x.key === key);
    return s ? Object.fromEntries(s.rows.map((r) => [r.key, r])) : null;
};

suite('data quality on the real schema (invented people, rolled back)', () => {
    test('sections, scope and counts', async () => {
        const out = await W.inRolledBackTx(db, async (q) => {
            const F = await W.seedFacts(db);
            const w = await W.world(db, F, q);
            const DQ = require('../../src/services/DataQualityService');
            const K = require('../../src/services/KpiService');
            const LOCAL = { ...w.LOCAL, permissions: ['view_employees'] };
            const r = { w };
            r.sa = await DQ.panel(F.SUPER);
            r.local = await DQ.panel(LOCAL);
            r.none = await DQ.panel({ ...w.LOCAL, permissions: [] });
            r.hse = await DQ.panel({ ...w.LOCAL, permissions: ['view_compliance'] });
            const pop = await K.resolvePopulation({ viewer: LOCAL });
            r.pop = pop.ids;
            r.k1 = await K.compute('K1', { viewer: LOCAL });
            // a role start date captured for A lowers the row by one
            await db.run('UPDATE employees SET role_start_date = CURRENT_DATE - 30 WHERE id = ?', [
                w.A,
            ]);
            const scope = { viewer: LOCAL, __population: pop };
            r.peopleAfter = await DQ._sections.peopleSection(pop.ids, {
                lc: false,
                can: (s) => s === 'view_employees',
                scope,
            });
            // development: A has a plan with an action without a due date and
            // one with a due date; B has a plan without any action
            const pa = await db.get(
                "INSERT INTO idp_plans (employee_id, status) VALUES (?, 'active') RETURNING id",
                [w.A]
            );
            await db.run(
                `INSERT INTO idp_actions (idp_id, type, title, status, due_on)
                 VALUES (?, 'training', 'Invented action', 'pending', NULL),
                        (?, 'training', 'Invented action', 'in_progress', CURRENT_DATE + 10),
                        (?, 'training', 'Invented action', 'completed', NULL)`,
                [Number(pa.id), Number(pa.id), Number(pa.id)]
            );
            await db.run("INSERT INTO idp_plans (employee_id, status) VALUES (?, 'draft')", [w.B]);
            r.dev = await DQ._sections.developmentSection([w.A, w.B, w.C]);
            r.devEmpty = await DQ._sections.developmentSection([]);
            r.certs = await DQ._sections.certificatesSection(scope, {
                can: (s) => s === 'view_compliance',
            });
            return r;
        });
        const { w } = out;

        // sections per permission
        const keys = (p) => p.sections.map((s) => s.key);
        expect(keys(out.sa)).toEqual(
            expect.arrayContaining([
                'people',
                'framework',
                'certificates',
                'snapshots',
                'audit',
                'privacy',
            ])
        );
        expect(keys(out.local).filter((k) => k !== 'development')).toEqual(['people']);
        expect(keys(out.none)).toEqual([]);
        expect(keys(out.hse)).toEqual(['certificates']);
        expect(out.local.scoped).toBe(true);
        expect(out.sa.scoped).toBe(false);
        for (const p of [out.sa, out.local, out.hse])
            expect(p.sections.every((s) => !s.failed)).toBe(true);

        // the local administrator's clearance, leavers and erased people out
        expect(out.local.population).toBe(out.pop.length);
        expect(out.pop).toEqual(expect.arrayContaining([w.A, w.B, w.E]));
        expect(out.pop).not.toContain(w.F);
        expect(out.pop).not.toContain(w.G);
        const people = rowsOf(out.local, 'people');
        expect(people.no_line.population).toBe(out.pop.length);
        // the dashboard's own measurability, two different reasons
        expect(people.no_requirement.count).toBe(out.k1.breakdown.noRequirement);
        expect(people.not_assessed.count).toBe(out.k1.breakdown.notAssessed);
        expect(people.no_requirement.count).toBeGreaterThanOrEqual(1); // M: a role without requirement
        const after = Object.fromEntries(out.peopleAfter.map((r) => [r.key, r]));
        expect(after.no_role_start.count).toBe(people.no_role_start.count - 1);
        // the local-content row only while its module is on
        expect(people.no_nationality).toBeUndefined();
        // 5 people or more: a share; a 0 with people is « no anomaly »
        expect(people.no_role.status).toBe(people.no_role.count === 0 ? 'clean' : 'complete');

        // development
        const dev = Object.fromEntries(out.dev.map((r) => [r.key, r]));
        expect(dev.action_no_due).toMatchObject({ count: 1, population: 2 });
        expect(dev.plan_no_action).toMatchObject({ count: 1, population: 2 });
        expect(out.devEmpty.every((r) => r.population === 0)).toBe(true);
        expect(
            out.devEmpty.map(
                (r) => require('../../src/services/DataQualityService').finishRow(r).status
            )
        ).toEqual(['empty', 'empty']);

        // certificates: not configured, never 0
        expect(out.certs.every((r) => r.state === 'not_configured' && r.count === null)).toBe(true);
        const hse = rowsOf(out.hse, 'certificates');
        expect(Object.values(hse).every((r) => r.status === 'not_configured')).toBe(true);

        // no name, no person id
        for (const p of [out.sa, out.local, out.hse]) {
            const json = JSON.stringify(p);
            expect(json).not.toMatch(/Kpi[A-H]\b|Fixture|Invented|employeeId|"ids?"/);
        }
    });
});
