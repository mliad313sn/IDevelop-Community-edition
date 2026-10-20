'use strict';
/**
 * No admin page is wider than a 390 px phone.
 *
 * The REAL app (server.js's own middleware chain, tests/helpers/c318/buildApp.js)
 * listens on an ephemeral port; a SuperAdmin session is minted into the memory
 * store; Chromium opens each page at 390 × 844 and reads
 * document.documentElement.scrollWidth. A wide TABLE may scroll inside its own
 * box (.table-wrapper) — the page itself never scrolls sideways. The same is
 * checked for the rail of a manager and of an employee.
 *
 * Runs on idevelop_test* / idevelop_fixtures with a Chromium binary; skipped
 * otherwise. Read-only: GET requests only, the audit writers are no-ops.
 */
process.env.ACTIVITY_TRAIL = '0';
process.env.API_RATE_LIMIT = '100000000';
process.env.WRITE_ACTION_LIMIT = '100000000';
require('dotenv').config();

jest.mock('../../src/config/sessionStore', () => require('../helpers/c318/sessionStoreMock'));
jest.mock('../../src/services/LogService', () => {
    const real = jest.requireActual('../../src/services/LogService');
    real.log = async () => null;
    return real;
});
jest.mock('../../src/services/PerfEventService', () => {
    const real = jest.requireActual('../../src/services/PerfEventService');
    real.record = () => null;
    return real;
});

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const { chromiumOrNull, launchOptions } = require('../helpers/chromium');

const chromium = chromiumOrNull();
const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL) && !!chromium;
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(10 * 60 * 1000);

const CSRF = 'phone-width-csrf-token';
const ADMIN_PAGES = [
    '/dashboard',
    '/tasks',
    '/employees',
    '/admin/accounts',
    '/onboarding',
    '/cycles',
    '/supervisor/self-assessment-reviews',
    '/talent/nine-box',
    '/reports/builder',
    '/reports/schedules',
    '/organization',
    '/domains-skills',
    '/roles',
    '/data-management',
    '/admins',
    '/admin/delegation',
    '/system-logs',
    '/app-settings',
    '/app-settings/sso',
    '/admin/api-keys',
    '/admin/health',
    '/admin/maintenance',
    '/admin/modules',
    '/admin/integrations/hris',
    '/admin/notifications',
    '/admin/notifications/catalogue',
    '/admin/sessions',
    '/admin/access-review',
    '/admin/license',
    '/setup',
    // 4.0.0 port (wave 10)
    '/admin/data-quality',
    '/admin/usage',
    '/guide',
    '/about',
];

let db;
let server;
let base;
let browser;
const cookies = {};

d('no page is wider than a 390 px phone (real app, Chromium)', () => {
    beforeAll(async () => {
        const { loadApp, i18nReady, mintSession } = require('../helpers/c318/buildApp');
        const storeState = require('../helpers/c318/sessionStoreMock').state;
        db = require('../../src/config/database');
        await db.connect();
        await require('../../src/utils/searchSql').init(db);
        try {
            await require('../../src/config/i18n').init();
        } catch (_) {
            /* key passthrough */
        }
        const app = loadApp();
        await i18nReady();
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
        const sa = await db.get(
            `SELECT id FROM admins WHERE role = 'superadmin' AND is_active = true ORDER BY id LIMIT 1`
        );
        cookies.superadmin = await mintSession(
            storeState.store,
            { id: Number(sa.id), userType: 'admin' },
            CSRF
        );
        const emp = await db.get(
            `SELECT id FROM employees WHERE is_active = true ORDER BY id LIMIT 1`
        );
        if (emp)
            cookies.employee = await mintSession(
                storeState.store,
                { id: Number(emp.id), userType: 'employee' },
                CSRF
            );
        browser = await chromium.launch(launchOptions());
    });
    afterAll(async () => {
        if (browser) await browser.close();
        if (server) await new Promise((r) => server.close(r));
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    });

    // French labels are longer than English ones: every check runs in the
    // language chosen by the `lang` cookie (the « FR / EN » switch).
    async function contextFor(who, lang = 'en') {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const [name, value] = cookies[who].split(';')[0].split(/=(.*)/s);
        await ctx.addCookies([
            { name, value, url: base },
            { name: 'lang', value: lang, url: base },
        ]);
        return ctx;
    }

    async function widths(ctx, paths) {
        const page = await ctx.newPage();
        const out = [];
        for (const p of paths) {
            const res = await page.goto(base + p, { waitUntil: 'load' });
            await page.waitForTimeout(100);
            const w = await page.evaluate(() => {
                const vw = document.documentElement.clientWidth;
                const sw = document.documentElement.scrollWidth;
                // When the page is too wide, name what sticks out (outside any
                // box that scrolls on its own) so the failure says where to look.
                const culprits = [];
                if (sw > vw) {
                    for (const el of document.querySelectorAll('.main-content *')) {
                        const b = el.getBoundingClientRect();
                        if (!b.width || b.right <= vw) continue;
                        let q = el.parentElement;
                        let scrolls = false;
                        while (q && q !== document.body) {
                            const ox = getComputedStyle(q).overflowX;
                            if (ox !== 'visible' && q.scrollWidth > q.clientWidth) {
                                scrolls = true;
                                break;
                            }
                            q = q.parentElement;
                        }
                        if (!scrolls)
                            culprits.push(
                                el.tagName.toLowerCase() +
                                    (el.id ? '#' + el.id : '') +
                                    (typeof el.className === 'string' && el.className
                                        ? '.' + el.className.trim().split(/\s+/).join('.')
                                        : '')
                            );
                        if (culprits.length >= 3) break;
                    }
                }
                return [sw, vw, culprits];
            });
            out.push({
                p,
                status: res ? res.status() : 0,
                url: page.url(),
                sw: w[0],
                vw: w[1],
                culprits: w[2],
            });
        }
        await page.close();
        return out;
    }

    test.each(['en', 'fr'])(
        'SuperAdmin (%s): every administration page fits 390 px',
        async (lang) => {
            const ctx = await contextFor('superadmin', lang);
            const rows = await widths(ctx, ADMIN_PAGES);
            await ctx.close();
            // the pages really opened (no bounce to the sign-in page)
            expect(rows.filter((r) => /\/login/.test(r.url)).map((r) => r.p)).toEqual([]);
            expect(
                rows
                    .filter((r) => r.sw > r.vw)
                    .map((r) => `${r.p} ${r.sw}/${r.vw} ${r.culprits.join(' ')}`)
            ).toEqual([]);
        }
    );

    test.each(['en', 'fr'])('employee (%s): every page of the rail fits 390 px', async (lang) => {
        if (!cookies.employee) return;
        const ctx = await contextFor('employee', lang);
        const page = await ctx.newPage();
        await page.goto(base + '/employee/dashboard');
        const rail = await page.$$eval('#appSidebar nav a.sidebar-link[href]', (as) =>
            as.map((a) => a.getAttribute('href'))
        );
        await page.close();
        expect(rail.length).toBeGreaterThan(3);
        const rows = await widths(ctx, rail);
        await ctx.close();
        expect(
            rows
                .filter((r) => r.sw > r.vw)
                .map((r) => `${r.p} ${r.sw}/${r.vw} ${r.culprits.join(' ')}`)
        ).toEqual([]);
    });

    test('the phone drawer is a modal dialog with a way back to the menu button', async () => {
        const ctx = await contextFor('superadmin');
        const page = await ctx.newPage();
        await page.goto(base + '/dashboard');
        await page.click('#mobileMenuToggle');
        await page.waitForTimeout(400);
        expect(await page.getAttribute('#appSidebar', 'role')).toBe('dialog');
        expect(await page.getAttribute('#appSidebar', 'aria-modal')).toBe('true');
        expect(await page.evaluate(() => !!document.activeElement.closest('#appSidebar'))).toBe(
            true
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        expect(await page.getAttribute('#appSidebar', 'role')).toBe('complementary');
        expect(await page.evaluate(() => document.activeElement.id)).toBe('mobileMenuToggle');
        await ctx.close();
    });
});
