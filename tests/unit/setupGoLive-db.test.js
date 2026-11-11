'use strict';
/**
 * /setup read-only for a local administrator (SetupController, 4.0.0 port
 * wave 10, owner decision 13) on the REAL schema, inside a transaction that
 * is always rolled back. Invented people only (tests/helpers/kpiWorld.js).
 *
 *   - the SuperAdmin reads the organisation's counts and every link;
 *   - the local administrator reads the people counts of their clearance
 *     (never the organisation's headcount), no SuperAdmin link, no
 *     administrator-account count; every go-live line is measured or a
 *     decision, none fails on the real schema.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(90000);

const db = HAS_DB ? require('../../src/config/database') : null;
const W = require('../helpers/kpiWorld');

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const SA_ONLY = [
    '/admin/access-review',
    '/admin/health',
    '/app-settings/sso',
    '/admin/modules',
    '/compliance/register',
    '/admin/integrations/hris',
];

suite('/setup on the real schema (invented people, rolled back)', () => {
    test('organisation counts for the SuperAdmin, clearance counts for a local administrator', async () => {
        const out = await W.inRolledBackTx(db, async (q) => {
            const F = await W.seedFacts(db);
            const w = await W.world(db, F, q);
            const Setup = require('../../src/controllers/SetupController');
            const K = require('../../src/services/KpiService');
            const LOCAL = { ...w.LOCAL, permissions: ['view_employees'] };
            return {
                saChecks: await Setup.getChecks(F.SUPER),
                bannerChecks: await Setup.getChecks(),
                localChecks: await Setup.getChecks(LOCAL),
                saLive: await Setup.getGoLiveChecks(F.SUPER),
                localLive: await Setup.getGoLiveChecks(LOCAL),
                localPop: (await K.resolvePopulation({ viewer: LOCAL })).ids.length,
                orgActive: Number(
                    (
                        await db.get(
                            'SELECT count(*)::int AS n FROM employees WHERE is_active = true'
                        )
                    ).n
                ),
            };
        });
        const by = (c) => Object.fromEntries(c.checks.map((x) => [x.key, x]));
        const sa = by(out.saChecks);
        const local = by(out.localChecks);
        // the SuperAdmin page and the banner read the organisation
        expect(sa.employees.count).toBe(out.orgActive);
        expect(by(out.bannerChecks).employees.count).toBe(out.orgActive);
        // the local administrator reads their clearance only
        expect(local.employees.count).toBe(out.localPop);
        expect(out.localPop).toBeLessThan(out.orgActive);
        // links: only the pages their permissions open
        expect(local.employees.href).toBe('/employees');
        expect(local.org.href).toBeNull();
        if (local.modules) expect(local.modules.href).toBeNull();
        expect(sa.org.href).toBe('/organization');
        for (const c of out.localChecks.checks) expect(SA_ONLY).not.toContain(c.href);

        // go-live: every line measured (or a decision) on the real schema
        for (const l of out.saLive.lines) expect(`${l.key}:${l.state}`).not.toMatch(/:unmeasured$/);
        const live = Object.fromEntries(out.localLive.lines.map((l) => [l.key, l]));
        for (const l of out.localLive.lines) expect(SA_ONLY).not.toContain(l.href);
        expect(live.gl_admin_mfa.count).toBeNull();
        expect(live.gl_access_review.count).toBeNull();
        const saLive = Object.fromEntries(out.saLive.lines.map((l) => [l.key, l]));
        expect(typeof saLive.gl_admin_mfa.count).toBe('number');
        expect(saLive.gl_admin_mfa.href).toBe('/admin/access-review');
        // the measurable people of the clearance: M's role has no requirement
        expect(live.gl_measurable.state).toBe('todo');
        expect(live.gl_measurable.count).toBeGreaterThanOrEqual(1);
        // a decision is never scored
        for (const k of ['gl_sso', 'gl_kiosk', 'gl_local_content'])
            expect(live[k].state).toBe('info');
    });
});
