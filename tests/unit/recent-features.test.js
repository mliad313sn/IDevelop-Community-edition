'use strict';

// Integration coverage for the phase9i–9m additions that previously had no
// automated tests: System-Logs analytics aggregation, Org-Chart data endpoint,
// Dashboard workforce measures, and the 9-box disclosure guard. All checks are
// READ-ONLY (no seeding/mutation) so they are safe against any populated DB, and
// the whole suite skips cleanly when no DATABASE_URL is configured (CI-safe).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = !!process.env.DATABASE_URL;
const suite = HAS_DB ? describe : describe.skip;

// Minimal Express res stub capturing status + json payload.
function resStub() {
    return {
        statusCode: 200,
        body: null,
        status(c) {
            this.statusCode = c;
            return this;
        },
        json(o) {
            this.body = o;
            return this;
        },
    };
}

suite('Recent features (integration, read-only)', () => {
    let db;
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
    });
    afterAll(async () => {
        await db.close();
    });

    describe('SystemLogModel.analytics', () => {
        const SystemLogModel = require('../../src/models/SystemLogModel');

        // This is the regression guard for the SQLite-compat SQL gotcha that broke
        // the endpoint once (EXTRACT(... FROM ...) → "syntax error near ORDER").
        test('executes without error and returns the full aggregate shape', async () => {
            const d = await SystemLogModel.analytics(7);
            expect(d).toBeTruthy();
            for (const k of ['byDay', 'byAction', 'byActor', 'byHour', 'riskByDay', 'topIps']) {
                expect(Array.isArray(d[k])).toBe(true);
            }
            expect(d.totals).toBeTruthy();
            for (const k of ['total', 'risk', 'actors', 'ips']) {
                expect(typeof d.totals[k]).toBe('number');
            }
            // byHour buckets are integer hours 0..23 when present
            d.byHour.forEach((h) => {
                expect(h.hour).toBeGreaterThanOrEqual(0);
                expect(h.hour).toBeLessThanOrEqual(23);
            });
        });

        test('clamps the window (days) to a sane range', async () => {
            const big = await SystemLogModel.analytics(99999);
            const small = await SystemLogModel.analytics(0);
            expect(big.days).toBeLessThanOrEqual(365);
            expect(small.days).toBeGreaterThanOrEqual(1);
        });
    });

    describe('OrgChartController.data', () => {
        const OrgChart = require('../../src/controllers/OrgChartController');
        const superadmin = { id: 1, userType: 'admin', role: 'superadmin' };

        test('returns a scoped node list with hierarchy + org fields', async () => {
            const res = resStub();
            await OrgChart.data({ user: superadmin }, res);
            expect(res.statusCode).toBe(200);
            expect(Array.isArray(res.body.nodes)).toBe(true);
            expect(res.body.scope).toBe('all');
            if (res.body.nodes.length) {
                const n = res.body.nodes[0];
                ['id', 'name', 'site', 'department', 'service'].forEach((k) =>
                    expect(n).toHaveProperty(k)
                );
                // managerId / supervisorId are either null or a number (never undefined)
                expect(['number', 'object']).toContain(typeof n.managerId); // number or null
                expect(['number', 'object']).toContain(typeof n.supervisorId);
            }
        });

        test('manager-line parent references resolve within the node set (no dangling links)', async () => {
            const res = resStub();
            await OrgChart.data({ user: superadmin }, res);
            const ids = new Set(res.body.nodes.map((n) => n.id));
            res.body.nodes.forEach((n) => {
                if (n.managerId != null) expect(ids.has(n.managerId)).toBe(true);
            });
        });
    });

    describe('DashboardController.getMeasures', () => {
        const DashboardController = require('../../src/controllers/DashboardController');
        const ctrl = new DashboardController();

        const superadmin = { id: 1, userType: 'admin', role: 'superadmin' };

        test('returns 16 non-null-shaped workforce measures', async () => {
            const res = resStub();
            await ctrl.getMeasures({ user: superadmin }, res);
            expect(res.statusCode).toBe(200);
            const m = res.body.measures;
            expect(Array.isArray(m)).toBe(true);
            expect(m.length).toBe(16);
            m.forEach((x) => {
                expect(x).toHaveProperty('key');
                expect(x).toHaveProperty('label');
            });
            const people = m.find((x) => x.key === 'people');
            expect(people && typeof people.value === 'number').toBe(true);
        });

        test('measures are RBAC-scoped: a manager sees a subset of people and of org placements; the skills framework stays global', async () => {
            const get = (res, key) => (res.body.measures.find((x) => x.key === key) || {}).value;
            const all = resStub();
            await ctrl.getMeasures({ user: superadmin }, all);
            // Assert the baseline call succeeded FIRST. Without this, a failure of
            // the superadmin call makes every later comparison read `undefined`,
            // and the suite reports the scoped side as the culprit.
            expect(all.statusCode).toBe(200);
            const orgPeople = get(all, 'people');

            // pick a real manager (an employee who manages ≥1 employee-typed report)
            // ORDER BY so the fixture pick is stable: an unordered LIMIT 1 lets
            // Postgres return a different manager per run.
            const mgr = await db.get(
                "SELECT manager_id AS id FROM employees WHERE manager_id IS NOT NULL AND manager_type='employee' AND is_active ORDER BY manager_id LIMIT 1"
            );
            if (!mgr || mgr.id == null) return; // no manager hierarchy in this DB → nothing to assert
            const scoped = resStub();
            await ctrl.getMeasures({ user: { id: Number(mgr.id), userType: 'employee' } }, scoped);
            expect(scoped.statusCode).toBe(200);
            const mgrPeople = get(scoped, 'people');

            expect(mgrPeople).toBeLessThanOrEqual(orgPeople); // span ⊆ org
            expect(mgrPeople).toBeGreaterThanOrEqual(1); // at least themselves
            // MISE À JOUR (lot E, constat M-12, arbitrage 4 du comité UAT3) : ce
            // test épinglait « tout le catalogue est global ». L'onglet affiche
            // pourtant « Tous les chiffres de cet onglet respectent ce périmètre »,
            // et un manager de 16 personnes lisait « 9 sites, 10 départements,
            // 17 services, 50 postes ». L'intention — un lecteur restreint ne voit
            // JAMAIS plus que l'organisation — est conservée, mais elle se sépare
            // désormais en deux règles :
            //   • catalogue de PLACEMENT (sites/départements/services/postes) : il
            //     suit le périmètre, comme ReportBuilderService.getReferenceData ;
            //   • RÉFÉRENTIEL de compétences (skills/domains) : jamais restreint —
            //     règle du propriétaire, le nombre de compétences ne se réduit pas.
            expect(get(scoped, 'sites')).toBeLessThanOrEqual(get(all, 'sites'));
            expect(get(scoped, 'skills')).toBe(get(all, 'skills'));
            expect(get(scoped, 'domains')).toBe(get(all, 'domains'));
        });
    });

    describe('NineBoxService.setDisclosure (guard)', () => {
        const svc = require('../../src/services/NineBoxService');
        const manager = { id: 999999, userType: 'employee' };

        test('rejects a non-existent evaluation (no mutation)', async () => {
            await expect(svc.setDisclosure(manager, 999999999, true, null)).rejects.toThrow(
                /not found/i
            );
        });
    });
});
