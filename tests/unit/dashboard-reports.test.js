'use strict';

// Read-only smoke tests for the SQL-heavy reports / dashboard data layer
// (older modules that lacked direct coverage). These guard the aggregation
// queries against regressions / compat-layer breakage. CI-safe (skips w/o DB).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = !!process.env.DATABASE_URL;
const suite = HAS_DB ? describe : describe.skip;

suite('Dashboard & Reports data layer (integration, read-only)', () => {
    let db, DashboardModel;
    beforeAll(async () => {
        db = require('../../src/config/database');
        DashboardModel = require('../../src/models/DashboardModel');
        await db.connect();
    });
    afterAll(async () => {
        await db.close();
    });

    test('getOverviewKPIs returns the executive KPI shape', async () => {
        const k = await DashboardModel.getOverviewKPIs({});
        expect(k).toBeTruthy();
        expect(typeof Number(k.totalEmployees)).toBe('number');
        // avgReadiness / assessmentCoverage are numeric-or-null but must not throw
        expect(k).toHaveProperty('avgReadiness');
        expect(k).toHaveProperty('assessmentCoverage');
    });

    test('getSkillGaps returns a bounded array', async () => {
        const gaps = await DashboardModel.getSkillGaps({}, 20);
        expect(Array.isArray(gaps)).toBe(true);
        expect(gaps.length).toBeLessThanOrEqual(20);
    });

    test('getReadinessDistribution returns an array', async () => {
        const dist = await DashboardModel.getReadinessDistribution({});
        expect(Array.isArray(dist)).toBe(true);
    });

    test('getRoleStaffing returns an array', async () => {
        const roles = await DashboardModel.getRoleStaffing({});
        expect(Array.isArray(roles)).toBe(true);
    });

    test('getReadinessByGroup(site) returns an array (grouped aggregation)', async () => {
        const bySite = await DashboardModel.getReadinessByGroup('site', {});
        expect(Array.isArray(bySite)).toBe(true);
    });
});
