'use strict';

// Integration coverage for the phase9i–9m additions that previously had no
// automated tests: System-Logs analytics aggregation, Org-Chart data endpoint,
// Dashboard workforce measures, and the 9-box disclosure guard. All checks are
// READ-ONLY (no seeding/mutation) so they are safe against any populated DB, and
// the whole suite skips cleanly when no DATABASE_URL is configured (CI-safe).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
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

    // the former dashboard page and public/js/dashboard.js were retired in wave 12 (D3); the server-rendered dashboard has its own tests (dash*.test.js)

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
