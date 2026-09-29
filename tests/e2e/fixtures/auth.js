// Shared Playwright fixtures: programmatic login as each V1 profile.
// Credentials come from env vars so the same suite runs locally and in CI.
const { test: base } = require('@playwright/test');

const creds = {
    superadmin: {
        username: process.env.E2E_SA_USER || 'admin',
        password: process.env.E2E_SA_PASS || 'Admin123!',
    },
    employee: {
        username: process.env.E2E_EMP_USER || 'emp001',
        password: process.env.E2E_EMP_PASS || 'Employee123!',
    },
    manager: {
        username: process.env.E2E_MGR_USER || 'mgr001',
        password: process.env.E2E_MGR_PASS || 'Manager123!',
    },
};

async function loginAs(page, role) {
    const { username, password } = creds[role];
    await page.goto('/login');
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await Promise.all([
        page.waitForURL((url) => !url.pathname.endsWith('/login')),
        page.locator('button[type="submit"]').click(),
    ]);
}

exports.test = base.extend({
    loginAs: async ({ page }, use) => {
        await use((role) => loginAs(page, role));
    },
});
exports.expect = base.expect;
