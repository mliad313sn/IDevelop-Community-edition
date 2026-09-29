const { test, expect } = require('../fixtures/auth');

test.describe('smoke / authentication', () => {
    test('shows login page', async ({ page }) => {
        await page.goto('/login');
        await expect(page).toHaveTitle(/IDevelop|Login/i);
        await expect(page.locator('input[name="username"]')).toBeVisible();
        await expect(page.locator('input[name="password"]')).toBeVisible();
    });

    test('rejects invalid credentials', async ({ page }) => {
        await page.goto('/login');
        await page.locator('input[name="username"]').fill('nope');
        await page.locator('input[name="password"]').fill('wrong');
        await page.locator('button[type="submit"]').click();
        await expect(page).toHaveURL(/\/login/);
    });

    test('superadmin logs in', async ({ page, loginAs }) => {
        await loginAs('superadmin');
        await expect(page).not.toHaveURL(/\/login/);
    });
});
