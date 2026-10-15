'use strict';
/**
 * The dashboard in a real Chromium, on the real app (buildApp) serving the
 * invented fixture world of tests/helpers/dashWorld.js inside ONE transaction
 * that is always rolled back. GET requests only.
 *
 *   tabs     FR and EN, Daylight, Dusk and a colour theme (Ocean), 1280 px
 *            and 390 px: every context tab opens (lazily, aria-busy cleared),
 *            no console error, no page error, no CSP violation, the page never
 *            scrolls sideways, the first tile is on the first screen; the
 *            phone uses the « Section » select; arrows move the selection and
 *            the address keeps ?tab=;
 *   heatmap  the pillar heatmap: ONE tab stop, arrows / Home / End move the
 *            roving focus, a tooltip on focus and on hover that names the
 *            cell, Escape hides it; Enter on a cell opens its LIST page, which
 *            names nobody; on a phone the cells furthest behind as a list and
 *            the full grid on demand in its own scroll box; on paper the full
 *            grid and no list;
 *   print    « Print everything » and the board pack hide the controls;
 *   homes    the manager's home fits a phone and names nobody.
 * Skipped without a *_test database or a Chromium. Screenshots go to
 * $DASH_SHOTS when it is set.
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
const W = require('../helpers/dashWorld');
const M = require('../../src/config/modules');

const chromium = chromiumOrNull();
const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL) && !!chromium;
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(15 * 60 * 1000);

const SHOTS = process.env.DASH_SHOTS || null;
const THEMES = [
    { name: 'light', theme: 'light', palette: null },
    { name: 'dark', theme: 'dark', palette: null },
    { name: 'ocean', theme: 'light', palette: 'ocean' },
];
const TABS = [
    'overview',
    'readiness',
    'safety',
    'talent',
    'succession',
    'development',
    'assessments',
];

let db;
let server;
let base;
let browser;
let world;
let release;
let txDone;
const COOKIE = {};
let ModuleService;

function stage3() {
    const modules = {};
    for (const k of M.MODULE_KEYS) modules[k] = k !== 'localContent';
    jest.spyOn(ModuleService, 'resolve').mockImplementation(async () => ({
        stage: '3',
        stored: true,
        legacy: false,
        modules,
        configured: { ...modules },
    }));
}

d('the dashboard in a real browser (fixture world, rolled back)', () => {
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
        ModuleService = require('../../src/services/ModuleService');
        stage3();
        const app = loadApp();
        await i18nReady();
        let started;
        let failed;
        const ready = new Promise((r, j) => {
            started = r;
            failed = j;
        });
        const ROLLBACK = new Error('__DASH_BROWSER_ROLLBACK__');
        txDone = db
            .runTransaction(async () => {
                world = await W.world(db);
                await new Promise((r) => {
                    server = app.listen(0, '127.0.0.1', r);
                });
                started();
                await new Promise((r) => {
                    release = r;
                });
                throw ROLLBACK;
            })
            .catch((e) => {
                if (e !== ROLLBACK) failed(e);
            });
        await ready;
        base = `http://127.0.0.1:${server.address().port}`;
        const sa = await db.get(
            "SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1"
        );
        COOKIE.superadmin = await mintSession(
            storeState.store,
            { id: Number(sa.id), userType: 'admin' },
            'b'
        );
        COOKIE.manager = await mintSession(
            storeState.store,
            { id: world.M, userType: 'employee' },
            'b'
        );
        browser = await chromium.launch(launchOptions());
    });
    afterAll(async () => {
        if (browser) await browser.close();
        if (server) await new Promise((r) => server.close(r));
        if (release) release();
        if (txDone) await txDone;
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    });
    beforeEach(() => stage3());

    async function open(
        url,
        {
            width = 1280,
            lang = 'fr',
            theme = 'light',
            palette = null,
            role = 'superadmin',
            media = null,
        } = {}
    ) {
        const ctx = await browser.newContext({
            viewport: { width, height: width < 600 ? 844 : 900 },
        });
        const [name, value] = COOKIE[role].split(';')[0].split(/=(.*)/s);
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
        if (media) await page.emulateMedia({ media });
        const errors = [];
        page.on('console', (m) => {
            if (m.type() === 'error' && !/favicon|Service ?Worker/i.test(m.text()))
                errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(String(e.message)));
        const res = await page.goto(base + url, { waitUntil: 'load' });
        await page.waitForTimeout(200);
        return { ctx, page, errors, status: res ? res.status() : 0 };
    }
    const fits = (page) =>
        page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        );
    const shot = async (page, name) => {
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
    };

    for (const lang of ['fr', 'en'])
        for (const t of THEMES)
            for (const width of [1280, 390])
                test(`${lang} · ${t.name} · ${width} px: every tab opens, fits, no error`, async () => {
                    const { ctx, page, errors, status } = await open('/dashboard', {
                        width,
                        lang,
                        theme: t.theme,
                        palette: t.palette,
                    });
                    expect(status).toBe(200);
                    expect(await fits(page)).toBe(true);
                    // the first tile is wholly on the first screen
                    const firstTile = await page.evaluate(() => {
                        const el = document.querySelector('#ds-tiles .viz-kpi');
                        return el ? el.getBoundingClientRect().bottom : null;
                    });
                    expect(firstTile).not.toBeNull();
                    expect(firstTile).toBeLessThanOrEqual(width < 600 ? 1400 : 1100);
                    expect(await page.getAttribute('#ds-tab-overview', 'aria-selected')).toBe(
                        'true'
                    );
                    for (const id of TABS) {
                        if (width < 600) await page.selectOption('#ds-tab-select', id);
                        else await page.click(`#ds-tab-${id}`);
                        await page.waitForFunction(
                            (x) => {
                                const p = document.getElementById('ds-panel-' + x);
                                return (
                                    p &&
                                    !p.hidden &&
                                    p.getAttribute('data-loaded') === '1' &&
                                    !p.hasAttribute('aria-busy')
                                );
                            },
                            id,
                            { timeout: 30000 }
                        );
                        expect(new URL(page.url()).searchParams.get('tab')).toBe(id);
                        await page.waitForTimeout(150);
                        expect([id, await fits(page)]).toEqual([id, true]);
                        await shot(page, `dash-${id}-${lang}-${t.name}-${width}`);
                    }
                    expect(errors).toEqual([]);
                    expect(W.namesIn(await page.content(), world)).toEqual([]);
                    await ctx.close();
                });

    test('keyboard: the arrows move the selection and load the tab; focus goes to the heading on click', async () => {
        const { ctx, page, errors } = await open('/dashboard');
        await page.focus('#ds-tab-overview');
        await page.keyboard.press('ArrowRight');
        expect(await page.getAttribute('#ds-tab-readiness', 'aria-selected')).toBe('true');
        expect(await page.evaluate(() => document.activeElement.id)).toBe('ds-tab-readiness');
        await page.waitForFunction(
            () => document.getElementById('ds-panel-readiness').getAttribute('data-loaded') === '1'
        );
        await page.keyboard.press('End');
        expect(await page.getAttribute('#ds-tab-assessments', 'aria-selected')).toBe('true');
        await page.keyboard.press('Home');
        expect(await page.getAttribute('#ds-tab-overview', 'aria-selected')).toBe('true');
        await page.click('#ds-tab-talent');
        await page.waitForFunction(
            () => document.getElementById('ds-panel-talent').getAttribute('data-loaded') === '1'
        );
        expect(await page.evaluate(() => document.activeElement.tagName)).toBe('H2');
        expect(errors).toEqual([]);
        await ctx.close();
    });

    const active = (page) =>
        page.evaluate(() => {
            const a = document.activeElement;
            return {
                role: a.getAttribute('role'),
                row: a.parentElement ? a.parentElement.rowIndex : -1,
                col: a.cellIndex,
                stops: document.querySelectorAll(
                    '#ds-heat-pillar-grid [role=gridcell][tabindex="0"]'
                ).length,
            };
        });
    const tip = (page) =>
        page.evaluate(() => {
            const t = document.querySelector('#ds-heat-pillar .vh-tip');
            return { shown: !!t && !t.hidden, text: t ? t.textContent : '' };
        });

    test.each(['light', 'dark'])(
        'heatmap 1280 %s: one tab stop, arrows, Home / End, tooltip, Escape',
        async (theme) => {
            const { ctx, page, errors } = await open('/dashboard?tab=readiness', { theme });
            const grid = '#ds-heat-pillar-grid';
            expect(await page.locator(`${grid} [role=gridcell][tabindex="0"]`).count()).toBe(1);
            await page.focus(`${grid} [role=gridcell][tabindex="0"]`);
            const a = await active(page);
            expect(a.role).toBe('gridcell');
            let t = await tip(page);
            expect(t.shown).toBe(true);
            expect(t.text).toMatch(/ — /);
            await page.keyboard.press('ArrowRight');
            const b = await active(page);
            expect([b.row, b.col]).toEqual([a.row, a.col + 1]);
            expect(b.stops).toBe(1);
            await page.keyboard.press('End');
            const e = await active(page);
            await page.keyboard.press('Home');
            expect((await active(page)).col).toBeLessThan(e.col);
            await page.keyboard.press('Escape');
            t = await tip(page);
            expect(t.shown).toBe(false);
            await page.hover(`${grid} tbody tr:first-child td:nth-child(2)`);
            await page.waitForTimeout(200);
            expect((await tip(page)).shown).toBe(true);
            expect(errors).toEqual([]);
            await ctx.close();
        }
    );

    test('heatmap: Enter on a cell opens its list page, which names nobody', async () => {
        const { ctx, page } = await open('/dashboard?tab=readiness');
        const href = await page.evaluate(() => {
            const a = document.querySelector('#ds-heat-pillar-grid a.vh-drill[href]');
            return a ? a.getAttribute('href') : null;
        });
        expect(href).toMatch(/^\/dashboard\/list\?kpi=DOM&part=p\d+&/);
        await page.evaluate((h) => {
            const a = document.querySelector(`#ds-heat-pillar-grid a.vh-drill[href="${h}"]`);
            a.closest('[role=gridcell]').focus();
        }, href);
        await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
        expect(page.url()).toContain('/dashboard/list?kpi=DOM');
        const html = await page.content();
        expect(html).toMatch(/data-drill-count="\d+"/);
        expect(W.namesIn(html, world)).toEqual([]);
        await ctx.close();
    });

    test.each([
        ['en', 'light', null],
        ['fr', 'dark', null],
        ['fr', 'light', 'ocean'],
    ])(
        'heatmap 390 %s %s %s: the list, the grid on demand, never wider than the screen',
        async (lang, theme, palette) => {
            const { ctx, page, errors } = await open('/dashboard?tab=readiness', {
                width: 390,
                lang,
                theme,
                palette,
            });
            const vis = (sel) =>
                page.evaluate(
                    (s) =>
                        [...document.querySelectorAll(s)].some(
                            (e) => getComputedStyle(e).display !== 'none'
                        ),
                    sel
                );
            expect(await vis('#ds-heat-pillar .vh-scroll')).toBe(false);
            expect(await vis('#ds-heat-pillar .vh-list')).toBe(true);
            const items = await page.locator('#ds-heat-pillar .vh-item').count();
            expect(items).toBeGreaterThan(0);
            expect(items).toBeLessThanOrEqual(10);
            expect(await fits(page)).toBe(true);
            await page.click('#ds-heat-pillar [data-vh-showgrid]');
            expect(await vis('#ds-heat-pillar .vh-scroll')).toBe(true);
            expect(await fits(page)).toBe(true);
            expect(errors).toEqual([]);
            await ctx.close();
        }
    );

    test('print: « Print everything » shows every tab and no control; the heatmap prints whole', async () => {
        const { ctx, page, errors } = await open('/dashboard?print=all', {
            width: 390,
            media: 'print',
        });
        const state = await page.evaluate(() => {
            const shown = (s) =>
                [...document.querySelectorAll(s)].some(
                    (e) => getComputedStyle(e).display !== 'none'
                );
            return {
                panels: [...document.querySelectorAll('.ds-panel')].filter(
                    (e) => getComputedStyle(e).display !== 'none'
                ).length,
                tabs: shown('.ds-tabs'),
                actions: shown('.ds-actions'),
                grid: shown('#ds-heat-pillar .vh-scroll'),
                list: shown('#ds-heat-pillar .vh-list'),
                form: shown('.viz-scope-form'),
            };
        });
        expect(state).toEqual({
            panels: 7,
            tabs: false,
            actions: false,
            grid: true,
            list: false,
            form: false,
        });
        expect(errors).toEqual([]);
        await ctx.close();
        const bp = await open('/exec/board-pack', { media: 'print' });
        expect(bp.status).toBe(200);
        expect(
            await bp.page.evaluate(
                () => getComputedStyle(document.querySelector('.bp-actions')).display
            )
        ).toBe('none');
        expect(W.namesIn(await bp.page.content(), world)).toEqual([]);
        expect(bp.errors).toEqual([]);
        await bp.ctx.close();
    });

    test.each([1280, 390])(
        'the manager home at %s px fits, names nobody, no error',
        async (width) => {
            const { ctx, page, errors, status } = await open('/supervisor/dashboard', {
                width,
                role: 'manager',
            });
            expect(status).toBe(200);
            expect(await fits(page)).toBe(true);
            expect(W.namesIn(await page.content(), world)).toEqual([]);
            expect(errors).toEqual([]);
            await shot(page, `dash-manager-${width}`);
            await ctx.close();
        }
    );
});
