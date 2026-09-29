const { test, expect } = require('../fixtures/auth');

// Scope isolation is the non-negotiable working principle from V2 planning.
// This spec is a placeholder that becomes binding once Phase 2 seeds a
// site-scoped admin + a cross-site employee. Skipped until then.
test.describe.skip('smoke / scope isolation (Phase 2+)', () => {
    test('site-scoped admin cannot view a cross-site employee', async ({ page, loginAs }) => {
        await loginAs('siteAdminA');
        const r = await page.request.get('/employees/SITE_B_EMPLOYEE_ID');
        expect(r.status()).toBe(403);
    });
});
