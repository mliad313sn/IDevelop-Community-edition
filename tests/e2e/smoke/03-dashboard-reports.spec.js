const { test, expect } = require('../fixtures/auth');

test.describe('smoke / dashboard + reports', () => {
    test('dashboard renders for superadmin', async ({ page, loginAs }) => {
        await loginAs('superadmin');
        await page.goto('/dashboard');
        // No console errors during the initial widget load is the smoke assertion.
        const errors = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
        });
        await page.waitForLoadState('networkidle');
        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('readiness report responds', async ({ page, loginAs }) => {
        await loginAs('superadmin');
        const r = await page.request.get('/reports/readiness');
        expect(r.ok()).toBeTruthy();
    });

    test('gaps report responds', async ({ page, loginAs }) => {
        await loginAs('superadmin');
        const r = await page.request.get('/reports/gaps');
        expect(r.ok()).toBeTruthy();
    });

    test('skill matrix responds', async ({ page, loginAs }) => {
        await loginAs('superadmin');
        const r = await page.request.get('/skill-matrix');
        expect(r.ok()).toBeTruthy();
    });
});
