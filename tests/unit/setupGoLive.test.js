'use strict';
/**
 * /setup « Ready for go-live » (SetupController.getGoLiveChecks, 4.0.0 port
 * wave 10) with a mocked database, and the page rendered with the real locale
 * files:
 *   - a source that cannot be read is « not measured », never « done », and
 *     keeps the instance from being « ready »;
 *   - the decisions (SSO, shared computers, local content) are never scored;
 *   - another administrator reads it: no SuperAdmin link, no administrator-
 *     account count, no dismiss, a read-only note; the routes say so.
 */
const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) => d),
    setValue: jest.fn(),
}));
jest.mock('../../src/services/ModuleService', () => ({ flags: async () => ({ talent: true }) }));
jest.mock('../../src/services/SsoSettingsService', () => ({ isSwitchOn: async () => false }));
jest.mock('../../src/utils/featureFlags', () => ({ isNationalisationEnabled: async () => false }));
jest.mock('../../src/jobs/db-backup', () => ({
    status: async () => ({
        lastOk: true,
        lastRunOn: '2026-10-19',
        lastVerify: 'ok 2026-10-19T02:00:00Z f.sql: fine',
    }),
}));
jest.mock('../../src/services/KpiService', () => ({
    compute: async () => ({ breakdown: { population: 12, noRequirement: 0 }, denominator: 12 }),
    resolvePopulation: async () => ({ ids: [1, 2, 3], rows: [] }),
}));

const fs = require('fs');
const path = require('path');
const { render } = require('../helpers/vizRender');
const Setup = require('../../src/controllers/SetupController');

const SA = { id: 1, userType: 'admin', role: 'superadmin', permissions: [] };
const LOCAL = { id: 9, userType: 'admin', role: 'localadmin', permissions: ['view_roles'] };
const SA_ONLY = [
    '/admin/access-review',
    '/admin/health',
    '/app-settings/sso',
    '/admin/modules',
    '/compliance/register',
    '/admin/integrations/hris',
];

/** Every probe answers « done », except the ones named in `fail` (throw). */
function answer(fail = []) {
    mockDb.get.mockImplementation(async (sql) => {
        const s = String(sql);
        const hit = (re) => re.test(s);
        if (fail.some((re) => hit(re))) throw new Error('relation does not exist');
        if (hit(/FROM roles r\s+WHERE r\.is_active/)) return { n: 0 };
        if (hit(/role_criticality/)) return { critical: 3, withoutSuccessor: 0 };
        if (hit(/is_critical = true/)) return { n: 5 };
        if (hit(/kpi_targets/)) return { n: 4 };
        if (hit(/mfa_secrets/)) return { n: 0 };
        if (hit(/ACCESS_REVIEW_ATTEST/)) return { n: 0 };
        if (hit(/privacy_notice_versions/)) return { n: 1 };
        return null;
    });
}

const byKey = (g) => Object.fromEntries(g.lines.map((l) => [l.key, l]));

describe('go-live lines', () => {
    test('everything measured and done: ready; the decisions are never scored', async () => {
        answer();
        const g = await Setup.getGoLiveChecks(SA);
        expect(g.ready).toBe(true);
        expect(g.todo).toBe(0);
        const L = byKey(g);
        for (const k of ['gl_sso', 'gl_kiosk', 'gl_local_content']) expect(L[k].state).toBe('info');
        expect(L.gl_critical_roles.count).toBe('3 (0)');
        expect(L.gl_admin_mfa).toMatchObject({
            state: 'done',
            count: 0,
            href: '/admin/access-review',
        });
    });

    test('a source that cannot be read is « not measured », never « done », and blocks « ready »', async () => {
        answer([/mfa_secrets/, /privacy_notice_versions/]);
        const g = await Setup.getGoLiveChecks(SA);
        const L = byKey(g);
        expect(L.gl_admin_mfa).toMatchObject({ state: 'unmeasured', count: null });
        expect(L.gl_privacy).toMatchObject({ state: 'unmeasured', count: null });
        expect(g.ready).toBe(false);
        expect(g.todo).toBe(2);
    });

    test('another administrator: no SuperAdmin link, no administrator-account count', async () => {
        answer();
        const g = await Setup.getGoLiveChecks(LOCAL);
        const L = byKey(g);
        for (const l of g.lines) expect(SA_ONLY).not.toContain(l.href);
        expect(L.gl_admin_mfa).toMatchObject({ state: 'done', count: null, href: null });
        expect(L.gl_access_review).toMatchObject({ count: null, href: null });
        expect(L.gl_backup).toMatchObject({ state: 'done', count: null, href: null });
        // a page their permissions open keeps its link; a public count stays
        expect(L.gl_critical_skills).toMatchObject({ count: 5, href: '/roles' });
        expect(L.gl_kpi_targets.href).toBe('/kpi/targets');
        expect(L.gl_safety.href).toBeNull();
        expect(L.gl_privacy).toMatchObject({ count: 1, href: null });
    });
});

describe('the page', () => {
    const checks = [
        { key: 'org', done: true, href: null, count: '1/1/1' },
        { key: 'employees', done: true, href: '/employees', count: 12 },
    ];
    const golive = {
        lines: [
            { key: 'gl_admin_mfa', state: 'unmeasured', count: null, href: null },
            { key: 'gl_kpi_targets', state: 'todo', count: 0, href: '/kpi/targets' },
            { key: 'gl_sso', state: 'info', count: 'off', href: null },
        ],
        ready: false,
        todo: 2,
    };
    const page = (lang, readOnly, user) =>
        render(
            'views/pages/setup/index.ejs',
            { checks, complete: false, golive, readOnly, user, csrfToken: 't' },
            lang
        );
    const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    test('read-only: the note, no dismiss, no sample commands, no link where none is given', () => {
        const html = page('en', true, LOCAL);
        expect(html).toMatch(/data-setup-readonly/);
        expect(html).not.toMatch(/action="\/setup\/dismiss"/);
        expect(html).not.toMatch(/db:seed:/);
        expect(text(html)).toMatch(/Handled by a SuperAdmin/);
        for (const h of SA_ONLY) expect(html).not.toContain(`href="${h}"`);
        expect(text(html)).toMatch(/— Not measured Second factor for every administrator/);
        expect(text(html)).toMatch(/Single sign-on .*? off/);
        expect(text(html)).toMatch(/2 lines still to deal with/);
    });

    test('a SuperAdmin keeps the dismiss', () => {
        const html = page('fr', false, SA);
        expect(html).toMatch(/action="\/setup\/dismiss"/);
        expect(html).not.toMatch(/data-setup-readonly/);
    });

    test('FR and EN: no raw key, no inline handler', () => {
        for (const lang of ['fr', 'en']) {
            const html = page(lang, true, LOCAL);
            expect(html).not.toMatch(/setup_gl_[a-z_]+/);
            expect(html).not.toMatch(/\son[a-z]+="/i);
            expect(html).not.toMatch(/undefined|NaN/);
        }
    });

    test('the routes: read for every administrator, dismiss for a SuperAdmin', () => {
        const routes = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'routes', 'index.js'),
            'utf8'
        );
        expect(routes).toMatch(/router\.get\('\/setup', requireAdmin, SetupController\.index/);
        expect(routes).toMatch(
            /router\.post\('\/setup\/dismiss', requireSuperAdmin, SetupController\.dismiss/
        );
    });
});
