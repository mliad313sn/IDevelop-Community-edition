'use strict';
/**
 * Smoke coverage for the 3.22.30–3.22.34 surfaces: operational compliance,
 * departmental analytics (incl. burndown + team progression), employee
 * progression, the digest-subscription API, and permission enforcement on
 * the manage-gated compliance endpoints. Runs as the MANAGER profile — the
 * scoped view is the common case and also proves RBAC gating.
 */
const { test, expect } = require('../fixtures/auth');

test.describe('smoke / compliance & analytics suite', () => {
    test('compliance page renders scoped for a manager (no console errors)', async ({
        page,
        loginAs,
    }) => {
        await loginAs('manager');
        const errors = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
        });
        await page.goto('/compliance');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('h1')).toContainText('Operational Compliance');
        // Predicted-breach column (migration 58) present in the coverage table.
        await expect(page.locator('th', { hasText: 'Predicted' })).toBeVisible();
        // Manager is read-only: the manage-gated forms must NOT render.
        await expect(page.locator('form[action="/compliance/rules"]')).toHaveCount(0);
        await expect(page.locator('#cert-import-preview')).toHaveCount(0);
        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('dept-analytics page renders with burndown + team progression sections', async ({
        page,
        loginAs,
    }) => {
        await loginAs('manager');
        const errors = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        await page.goto('/reports/dept-analytics');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#completionChart')).toBeVisible();
        await expect(page.locator('#burndownTitle')).toBeVisible();
        await expect(page.locator('#teamProgressChart, #teamProgressEmpty').first()).toBeVisible();
        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('analytics APIs respond and are JSON', async ({ page, loginAs }) => {
        await loginAs('manager');
        for (const url of [
            '/api/analytics/department-completion',
            '/api/analytics/ninebox-by-department',
            '/api/analytics/perf-actions-trend?months=6',
            '/api/analytics/campaign-burndown',
            '/api/analytics/team-progression?months=6',
            '/api/compliance/coverage',
            '/api/compliance/certifications',
        ]) {
            const r = await page.request.get(url);
            expect(r.ok(), `${url} -> ${r.status()}`).toBeTruthy();
            expect(r.headers()['content-type']).toContain('application/json');
        }
    });

    test('my-progress page renders for the signed-in user', async ({ page, loginAs }) => {
        await loginAs('manager');
        await page.goto('/employee/my-progress');
        await expect(page.locator('h1')).toContainText(/Progression/i);
        await expect(page.locator('table')).toBeVisible();
    });

    test('digest subscription API round-trips (subscribe → mine → cancel)', async ({
        page,
        loginAs,
    }) => {
        await loginAs('manager');
        // JSON mutations are guarded by the same-origin check (an Origin header
        // is REQUIRED), so the round-trip must run as in-page fetch — which is
        // exactly how the real UI calls it. page.request (no Origin) is
        // asserted rejected at the end: the guard itself is part of the test.
        const result = await page.evaluate(async () => {
            const post = (u, b) =>
                fetch(u, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(b || {}),
                }).then((r) => r.json());
            const get = (u) => fetch(u).then((r) => r.json());
            const sub = await post('/api/digest-subscriptions', {
                frequency: 'monthly',
                dayOfMonth: 15,
                hour: 0,
            });
            const mine = await get('/api/digest-subscriptions/mine');
            await post('/api/digest-subscriptions/cancel');
            const after = await get('/api/digest-subscriptions/mine');
            return {
                subHour: sub.hour,
                activeAfterSub: mine.subscription && mine.subscription.isActive,
                activeAfterCancel: after.subscription && after.subscription.isActive,
            };
        });
        expect(result.subHour).toBe(0); // 0 must NOT collapse to the default
        expect(result.activeAfterSub).toBe(true);
        expect(result.activeAfterCancel).toBe(false);

        // Origin-less JSON mutation (server-to-server shape without an API key)
        // must be refused by the same-origin guard.
        const noOrigin = await page.request.post('/api/digest-subscriptions', {
            data: { frequency: 'monthly' },
        });
        expect(noOrigin.status()).toBe(403);
    });

    test('manage-gated compliance endpoints are refused for a manager', async ({
        page,
        loginAs,
    }) => {
        await loginAs('manager');
        // requirePermission bounces non-admins to the dashboard (HTML), so the
        // assertion is: we did NOT receive the spreadsheet.
        const r = await page.request.get('/data-management/templates/certifications');
        expect(r.headers()['content-type'] || '').not.toContain('spreadsheetml');
        // JSON mutation endpoints must not succeed either.
        const rule = await page.request.post('/compliance/rules', {
            data: { name: 'e2e-should-fail', skillId: 1, minHeadcount: 1 },
        });
        const ruleBody = await rule.json().catch(() => null);
        expect(ruleBody && ruleBody.success === true).toBeFalsy();
    });
});
