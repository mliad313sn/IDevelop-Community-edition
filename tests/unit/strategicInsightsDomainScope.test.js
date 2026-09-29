'use strict';

/**
 * Re-audit A4 — the /strategic-insights panel took the dashboard `domainName`
 * filter and applied it to exactly ONE of its sub-metrics (getOrgHealthMetrics'
 * top-impact-gaps query, the only one over the gap view), while its risk index,
 * critical-role and every other org-health KPI (employee/coverage views, which
 * have no domain axis) silently ignored it. The panel therefore showed a
 * domain-scoped number beside org-wide ones. The overview is now uniformly
 * org-wide: the domain drill-down lives on the dedicated capability/gap panels.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockModel = {
    getWorkforceRiskIndex: jest.fn(async () => ({})),
    getCriticalRolesDetail: jest.fn(async () => []),
    getOrgHealthMetrics: jest.fn(async () => ({})),
};
jest.mock('../../src/models/DashboardModel', () => mockModel);

const DashboardService = require('../../src/services/DashboardService');

beforeEach(() => {
    mockModel.getWorkforceRiskIndex.mockClear();
    mockModel.getCriticalRolesDetail.mockClear();
    mockModel.getOrgHealthMetrics.mockClear();
});

describe('A4 — the strategic overview never applies the domain filter to only part of itself', () => {
    test('a domainName filter is stripped before every strategic sub-metric', async () => {
        await DashboardService.getStrategicInsights({
            siteName: 'Riverside',
            domainName: 'Sécurité',
        });
        for (const fn of [
            mockModel.getWorkforceRiskIndex,
            mockModel.getCriticalRolesDetail,
            mockModel.getOrgHealthMetrics,
        ]) {
            const passed = fn.mock.calls[0][0];
            expect(passed).not.toHaveProperty('domainName'); // no half-scoped panel
            expect(passed.siteName).toBe('Riverside'); // other filters survive
        }
    });

    test("the caller's filter object is not mutated", async () => {
        const filters = { siteName: 'Riverside', domainName: 'Sécurité' };
        await DashboardService.getStrategicInsights(filters);
        expect(filters.domainName).toBe('Sécurité'); // only a copy was trimmed
    });

    test('with no domain filter every sub-metric still sees the same scope', async () => {
        await DashboardService.getStrategicInsights({ departmentName: 'IT' });
        for (const fn of [
            mockModel.getWorkforceRiskIndex,
            mockModel.getCriticalRolesDetail,
            mockModel.getOrgHealthMetrics,
        ]) {
            expect(fn.mock.calls[0][0]).toEqual({ departmentName: 'IT' });
        }
    });
});
