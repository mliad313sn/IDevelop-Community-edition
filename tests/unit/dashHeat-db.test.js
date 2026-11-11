'use strict';
/**
 * The dashboard heatmaps and their lists on the real test database (the
 * invented world of tests/helpers/dashWorld.js, inside a transaction that is
 * always rolled back):
 *   - the heat cube's marginals equal the population aggregates of the
 *     capability profile (paired means, n), and n adds up across units;
 *   - the rendered pillar and sub-domain heatmaps carry no person name,
 *     username or employee number, and every cell under 5 people is masked;
 *   - the list behind a heat cell counts people by site and role, the groups
 *     add up to the count, no name; a malformed part is refused.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/dashWorld');
const { render } = require('../helpers/vizRender');
const { heatModel } = require('../../src/utils/heatModel');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(180000);

let db;
let D;
suite('dashboard heatmaps and their lists (rolled back)', () => {
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
        D = require('../../src/services/DashboardHomeService');
    });
    afterAll(async () => {
        await db.close();
    });

    test('marginals = population aggregates; n additive across units', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            return {
                cube: await D.capabilityHeat(w.all, 'site', 'domain'),
                prof: await D.capabilityProfile(w.all, 'domain'),
            };
        });
        for (const p of out.prof.filter((x) => x.measured)) {
            const a = out.cube.find((r) => r.part === 'axis' && r.key === p.key);
            expect(a).toBeDefined();
            expect(a.sumActual / a.measured).toBeCloseTo(p.actual, 1);
            expect(a.sumRequired / a.measured).toBeCloseTo(p.required, 1);
            expect(a.n).toBe(p.n);
        }
        const total = out.cube.find((r) => r.part === 'total');
        const units = out.cube.filter((r) => r.part === 'unit');
        expect(units.reduce((s, u) => s + u.n, 0)).toBe(total.n);
        expect(units.length).toBe(3);
    });

    test('no names in the rendered heatmaps; every cell under 5 people is masked', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const few = [...w.people.N.slice(0, 3), ...w.people.E, ...w.people.W];
            return {
                w,
                pillar: await D.capabilityHeat(w.all, 'site', 'domain'),
                sub: await D.capabilityHeat(w.all, 'department', 'subdomain'),
                few: await D.capabilityHeat(few, 'site', 'domain'),
            };
        });
        for (const [cube, kind] of [
            [out.pillar, 'attain'],
            [out.sub, 'deficit'],
            [out.few, 'attain'],
        ]) {
            const m = heatModel(cube, { kind, maxRows: 12 });
            const html = render('views/partials/viz/heat.ejs', { H: m, heatId: 't' });
            expect(W.namesIn(html, out.w)).toEqual([]);
            for (const r of m.rows)
                for (const c of r.cells)
                    if (c.state === 'ok') expect(c.n).toBeGreaterThanOrEqual(5);
        }
        // site N with 3 people measured is pooled, never shown as its own column
        const m = heatModel(out.few, { kind: 'attain' });
        expect(m.cols.some((c) => c.pooled)).toBe(true);
    });

    test('the list behind a heat cell: counts by site and role, no name; a malformed part is refused', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const SA = { id: w.adminId, userType: 'admin', role: 'superadmin' };
            const ctx = await D.context({
                user: SA,
                query: {},
                page: 'dashboard',
                remember: false,
                navVisible: { gaps_report: true, readiness: true },
            });
            const pillar = (
                await db.get(
                    'SELECT domain_id AS "id" FROM v_employee_skill_gaps WHERE skill_id = ? LIMIT 1',
                    [w.S1]
                )
            ).id;
            return {
                w,
                list: await D.drillList(ctx, 'DOM', 'p' + pillar),
                bad: await D.drillList(ctx, 'DOM', "p1' OR 1=1"),
                k1: await D.drillList(ctx, 'K1', 'not_ready'),
            };
        });
        expect(out.list.kind).toBe('people');
        expect(out.list.count).toBeGreaterThanOrEqual(6); // the « not ready » people of the world
        expect(out.list.groups.bySite.reduce((s, g) => s + g.count, 0)).toBe(out.list.count);
        expect(out.list.groups.byRole.reduce((s, g) => s + g.count, 0)).toBe(out.list.count);
        expect(out.list.moduleHref).toBe('/reports/gaps');
        expect(W.namesIn(JSON.stringify(out.list), out.w)).toEqual([]);
        expect(out.bad).toBeNull();
        expect(out.k1.count).toBe(out.k1.groups.bySite.reduce((s, g) => s + g.count, 0));
    });
});
