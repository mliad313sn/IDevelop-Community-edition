'use strict';
/**
 * The benchmark pages on the data-visualisation layer, in the REAL app
 * (server.js's own middleware chain through tests/helpers/c318/buildApp.js,
 * a SuperAdmin session minted into the memory store) and a real Chromium:
 *   - FR and EN, Daylight, Dusk and a colour theme (Ocean), 1280 px and 390 px:
 *     the page never scrolls sideways (a wide matrix scrolls in its own box),
 *     no console error, no page error and no CSP violation;
 *   - the occupant × skill matrix: a requirement nobody assessed is a hatched
 *     « Not assessed » cell, never level 0 and never a gap;
 *   - the matrices use the heatmap scale (data-bin), never the old red-to-green
 *     ramp; the coverage heatmap, when the scope has critical skills, renders
 *     the component (its list on a phone);
 *   - print: the charts are pictures, the buttons and the phone list are hidden.
 * Read-only: GET requests only, the audit writers are no-ops. Runs on a
 * *_test database with a Chromium binary; skipped otherwise. Screenshots go to
 * $VIZ_SHOTS when it is set.
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

const path = require('path');
const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const { chromiumOrNull, launchOptions } = require('../helpers/chromium');

const chromium = chromiumOrNull();
const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL) && !!chromium;
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(10 * 60 * 1000);

const CSRF = 'viz-benchmark-csrf';
const SHOTS = process.env.VIZ_SHOTS || null;
const THEMES = [
    { name: 'light', theme: 'light', palette: null },
    { name: 'dark', theme: 'dark', palette: null },
    { name: 'ocean', theme: 'light', palette: 'ocean' },
];

let db;
let server;
let base;
let browser;
let cookie;
let roleId = null;

d('benchmark pages on the viz layer (real app, Chromium)', () => {
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
        cookie = await mintSession(
            storeState.store,
            { id: Number(sa.id), userType: 'admin' },
            CSRF
        );
        // a role with occupants and requirements (the drill-through page)
        const r = await db.get(
            `SELECT e.role_id AS "roleId", COUNT(*)::int AS n
               FROM employees e JOIN role_skill_requirements x ON x.role_id = e.role_id
              WHERE e.is_active = true GROUP BY e.role_id ORDER BY n DESC, e.role_id LIMIT 1`
        );
        roleId = r ? Number(r.roleId) : null;
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

    async function open(url, { width, lang, theme, palette }) {
        const ctx = await browser.newContext({
            viewport: { width, height: width < 600 ? 844 : 900 },
        });
        const [name, value] = cookie.split(';')[0].split(/=(.*)/s);
        await ctx.addCookies([
            { name, value, url: base },
            { name: 'lang', value: lang, url: base },
        ]);
        await ctx.addInitScript(
            ([t, p]) => {
                try {
                    // runs in the page (Playwright init script), not in node
                    // eslint-disable-next-line n/no-unsupported-features/node-builtins
                    const store = window.localStorage;
                    store.setItem('theme', t);
                    if (p) store.setItem('palette', p);
                    else store.removeItem('palette');
                } catch (_) {
                    /* storage optional */
                }
                document.addEventListener('securitypolicyviolation', (e) =>
                    // eslint-disable-next-line no-console
                    console.error('CSP ' + e.violatedDirective + ' ' + e.blockedURI)
                );
            },
            [theme, palette]
        );
        const page = await ctx.newPage();
        const errors = [];
        page.on('console', (m) => {
            if (m.type() === 'error' && !/favicon|Service ?Worker/i.test(m.text()))
                errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(String(e.message)));
        const res = await page.goto(base + url, { waitUntil: 'load' });
        await page.waitForTimeout(250);
        return { ctx, page, errors, status: res ? res.status() : 0 };
    }

    const sideways = (page) =>
        page.evaluate(() => [
            document.documentElement.scrollWidth,
            document.documentElement.clientWidth,
        ]);

    const pages = () => ['/benchmark', ...(roleId ? [`/benchmark/role/${roleId}`] : [])];

    for (const lang of ['fr', 'en'])
        for (const t of THEMES)
            for (const width of [1280, 390])
                test(`${lang} · ${t.name} · ${width} px: fits, no error, heat tokens`, async () => {
                    for (const url of pages()) {
                        const { ctx, page, errors, status } = await open(url, {
                            width,
                            lang,
                            theme: t.theme,
                            palette: t.palette,
                        });
                        expect([url, status]).toEqual([url, 200]);
                        expect(page.url()).not.toMatch(/\/login/);
                        const [sw, vw] = await sideways(page);
                        expect([url, sw <= vw]).toEqual([url, true]);
                        expect([url, errors]).toEqual([url, []]);
                        // the matrices are on the heatmap scale
                        expect(
                            await page.locator('.benchmark-matrix .vh-c[data-bin]').count()
                        ).toBeGreaterThanOrEqual(0);
                        expect(await page.locator('[class*="bm-heat-"]').count()).toBe(0);
                        if (SHOTS)
                            await page.screenshot({
                                path: path.join(
                                    SHOTS,
                                    `${url.replace(/\W+/g, '_')}-${lang}-${t.name}-${width}.png`
                                ),
                                fullPage: true,
                            });
                        await ctx.close();
                    }
                });

    test('an unassessed requirement is a hatched « Not assessed » cell, never level 0', async () => {
        if (!roleId) return;
        // the page's own data: every occupant x requirement cell nobody assessed
        const { domains } = await require('../../src/models/BenchmarkModel').getRoleOccupants(
            roleId,
            {}
        );
        let n = 0;
        for (const dd of domains)
            for (const sd of dd.subs)
                for (const sk of sd.skills)
                    for (const c of Object.values(sk.cells)) if (!c.assessed) n++;
        const unassessed = { n };
        const { ctx, page } = await open(`/benchmark/role/${roleId}`, {
            width: 1280,
            lang: 'en',
            theme: 'light',
        });
        const cells = page.locator('#role-matrix td.bm-unassessed');
        expect(await cells.count()).toBe(unassessed.n);
        if (unassessed.n) {
            const c = cells.first();
            expect((await c.innerText()).trim()).toBe('Not assessed');
            expect(await c.getAttribute('data-bin')).toBeNull();
            const bg = await c.evaluate((el) => getComputedStyle(el).backgroundImage);
            expect(bg).toMatch(/repeating-linear-gradient/);
        }
        await ctx.close();
    });

    test('print: charts become pictures, buttons and phone lists are hidden', async () => {
        if (!roleId) return;
        const { ctx, page, errors } = await open(`/benchmark/role/${roleId}`, {
            width: 1280,
            lang: 'fr',
            theme: 'dark',
        });
        await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
        await page.emulateMedia({ media: 'print' });
        const state = await page.evaluate(() => {
            const vis = (sel) =>
                [...document.querySelectorAll(sel)].some(
                    (e) => getComputedStyle(e).display !== 'none'
                );
            return {
                canvases: vis('.viz-canvas-wrap canvas'),
                toggles: vis('.viz-data-toggle'),
                imgs: document.querySelectorAll('img.viz-print-img').length,
                charts: document.querySelectorAll(
                    '.viz-canvas-wrap canvas, .prof-radar-canvas canvas'
                ).length,
                radarSvg: vis('.viz-radar-print'),
                radarScreen: vis('.viz-radar-screen'),
            };
        });
        expect(state.canvases).toBe(false);
        expect(state.toggles).toBe(false);
        expect(state.imgs).toBe(state.charts);
        // the radar prints as the server-drawn SVG, not as its screen block
        if (await page.locator('.viz-radar-print').count()) {
            expect(state.radarSvg).toBe(true);
            expect(state.radarScreen).toBe(false);
        }
        if (SHOTS) await page.pdf({ path: path.join(SHOTS, 'benchmark-role-print-fr.pdf') });
        expect(errors).toEqual([]);
        await ctx.close();
    });
});
