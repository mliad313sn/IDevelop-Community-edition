const { test, expect } = require('../fixtures/auth');

test.describe('smoke / employees', () => {
    test('superadmin can list employees', async ({ page, loginAs }) => {
        await loginAs('superadmin');
        await page.goto('/employees');
        await expect(page.locator('h1, h2').filter({ hasText: /employee/i })).toBeVisible();
    });
});
