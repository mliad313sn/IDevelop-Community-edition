const { test, expect } = require('../fixtures/auth');

test.describe('smoke / employees', () => {
    test('superadmin can list employees', async ({ page, loginAs }) => {
        await loginAs('superadmin');
        await page.goto('/employees');
        await expect(page.locator('h1, h2').filter({ hasText: /employee/i })).toBeVisible();
    });

    // Phase-0 leaves create/edit at scaffold level so the suite doesn't depend on seeded org rows.
    test.skip('superadmin can create an employee (seeded org rows required)', async () => {});
});
