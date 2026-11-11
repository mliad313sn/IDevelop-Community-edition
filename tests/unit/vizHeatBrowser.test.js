'use strict';
/**
 * The heatmap component in a real browser (Chromium, no server, no database):
 * views/partials/viz/heat.ejs rendered with the real locales, styled by the
 * app's own stylesheets (style, horizon, viz) and driven by public/js/viz-heat.js.
 *   keyboard   ONE tab stop per grid; the arrow keys, Home / End, Ctrl+Home /
 *              Ctrl+End and PageUp / PageDown move the roving focus; Escape
 *              hides the tooltip; Enter follows the cell's link;
 *   tooltip    shown on focus and on hover, it names the cell (row — column)
 *              and is text, never markup;
 *   390 px     the grid gives way to the list of the cells furthest behind
 *              (at most 10); « Show the full grid » opens a grid that scrolls
 *              in its own box — the page never scrolls sideways; no text under
 *              12 px; every list row is a 44 px target;
 *   print      the full grid prints, the list, tooltip and buttons do not,
 *              colours exact;
 *   themes     Daylight, Dusk and a colour theme: the cells keep the heatmap
 *              scale (a colour theme changes the accent only).
 * Plus: no console error, no page error. Skipped without a Chromium binary.
 */
const { chromiumOrNull, launchOptions } = require('../helpers/chromium');
const { render, read } = require('../helpers/vizRender');
const { heatModel } = require('../../src/utils/heatModel');

const chromium = chromiumOrNull();
const d = chromium ? describe : describe.skip;
jest.setTimeout(5 * 60 * 1000);

const CSS = ['public/css/style.css', 'public/css/horizon.css', 'public/css/viz.css']
    .map(read)
    .join('\n')
    // fonts and icons are not served here: keep the layout, drop the url()s
    .replace(/url\([^)]*\)/g, 'none');
const HEAT_JS = read('public/js/viz-heat.js');

const cell = (u, k, sa, sr, m, n) => ({
    part: 'cell',
    unitKey: u,
    unitName: 'Site ' + u,
    key: k,
    label: 'Domain ' + k,
    sumActual: sa,
    sumRequired: sr,
    measured: m,
    n,
});
const unitT = (u, sa, sr, m, n) => ({
    part: 'unit',
    unitKey: u,
    sumActual: sa,
    sumRequired: sr,
    measured: m,
    n,
});
const axisT = (k, sa, sr, m, n) => ({
    part: 'axis',
    key: k,
    sumActual: sa,
    sumRequired: sr,
    measured: m,
    n,
});

function model() {
    const rows = [];
    const units = ['1', '2', '3', '4'];
    const keys = ['10', '20', '30'];
    const ratio = {
        10: [0.5, 0.9, 1.1, 0.7],
        20: [0.65, 1.0, 1.3, 0.85],
        30: [null, 0.96, 0.75, 1.0],
    };
    keys.forEach((k) =>
        units.forEach((u, j) => {
            const r = ratio[k][j];
            rows.push(
                r === null
                    ? cell(u, k, null, null, 0, 0)
                    : cell(u, k, Math.round(r * 100), 100, 50, 8 + j)
            );
        })
    );
    units.forEach((u, j) => rows.push(unitT(u, 250 + j * 20, 300, 150, 8 + j)));
    keys.forEach((k, i) => rows.push(axisT(k, 300 + i * 10, 400, 200, 38)));
    rows.push({ part: 'total', sumActual: 930, sumRequired: 1200, measured: 600, n: 38 });
    return heatModel(rows, {
        kind: 'attain',
        hrefOf: (u, k) => '#cell-' + u + '-' + k,
    });
}

function pageHtml(lang, theme, palette) {
    const fig = render(
        'views/partials/viz/heat.ejs',
        { H: model(), heatId: 'hb', heatTitle: lang === 'fr' ? 'Carte' : 'Map' },
        lang
    );
    const attrs =
        `lang="${lang}"` +
        (theme === 'light' ? ' data-theme="light"' : '') +
        (palette ? ` data-palette="${palette}"` : '');
    return `<!doctype html><html ${attrs}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style></head><body><main class="main-content"><p>top</p>${fig}</main></body></html>`;
}

let browser;

d('the heatmap component in Chromium', () => {
    beforeAll(async () => {
        browser = await chromium.launch(launchOptions());
    });
    afterAll(async () => {
        if (browser) await browser.close();
    });

    async function open(width, { lang = 'en', theme = 'light', palette = null, media } = {}) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await ctx.newPage();
        const errors = [];
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        page.on('pageerror', (e) => errors.push(String(e.message)));
        if (media) await page.emulateMedia({ media });
        await page.setContent(pageHtml(lang, theme, palette), { waitUntil: 'load' });
        await page.addScriptTag({ content: HEAT_JS });
        return { ctx, page, errors };
    }
    const active = (page) =>
        page.evaluate(() => {
            const a = document.activeElement;
            const tr = a.closest('tr');
            return {
                role: a.getAttribute('role'),
                row: tr ? tr.rowIndex : -1,
                col: a.cellIndex,
                stops: document.querySelectorAll('#hb-grid [role=gridcell][tabindex="0"]').length,
            };
        });
    const tip = (page) =>
        page.evaluate(() => {
            const t = document.querySelector('#hb .vh-tip');
            return { shown: !!t && !t.hidden, text: t ? t.textContent : '' };
        });

    test.each(['light', 'dark'])(
        '1280 %s: one tab stop, arrows, Home / End, corners, Escape',
        async (theme) => {
            const { ctx, page, errors } = await open(1280, { theme });
            expect(await page.locator('#hb-grid [role=gridcell][tabindex="0"]').count()).toBe(1);
            await page.focus('#hb-grid [role=gridcell][tabindex="0"]');
            const a = await active(page);
            expect(a.role).toBe('gridcell');
            let t = await tip(page);
            expect(t.shown).toBe(true);
            expect(t.text).toMatch(/ — /); // « row — column »
            await page.keyboard.press('ArrowRight');
            const b = await active(page);
            expect([b.row, b.col]).toEqual([a.row, a.col + 1]);
            expect(b.stops).toBe(1); // roving: still one tab stop
            await page.keyboard.press('ArrowDown');
            expect((await active(page)).row).toBe(a.row + 1);
            await page.keyboard.press('End');
            const e = await active(page);
            expect(e.col).toBe(5); // row header + 4 sites + Overall
            await page.keyboard.press('Home');
            expect((await active(page)).col).toBe(1);
            await page.keyboard.press('Control+End');
            const corner = await active(page);
            expect(corner.col).toBe(5);
            await page.keyboard.press('Control+Home');
            expect((await active(page)).row).toBe(1);
            await page.keyboard.press('PageDown');
            expect((await active(page)).row).toBe(corner.row);
            await page.keyboard.press('Escape');
            t = await tip(page);
            expect(t.shown).toBe(false);
            // the tooltip follows the mouse too
            await page.hover('#hb-grid tbody tr:nth-child(2) td:nth-child(3)');
            await page.waitForTimeout(200);
            expect((await tip(page)).shown).toBe(true);
            expect(errors).toEqual([]);
            await ctx.close();
        }
    );

    test('Enter follows the cell link; a masked or unmeasured cell has none', async () => {
        const { ctx, page } = await open(1280);
        await page.focus('#hb-grid [role=gridcell][tabindex="0"]');
        const href = await page.evaluate(() => {
            const a = document.activeElement.querySelector('a.vh-drill');
            return a ? a.getAttribute('href') : null;
        });
        expect(href).toMatch(/^#cell-/);
        await page.keyboard.press('Enter');
        expect(await page.evaluate(() => location.hash)).toBe(href);
        const bad = await page.evaluate(
            () =>
                document.querySelectorAll(
                    '#hb-grid .vh-c--unmeasured a, #hb-grid .vh-c--masked a, #hb-grid [data-href]'
                ).length
        );
        expect(bad).toBe(0);
        await ctx.close();
    });

    test('the unmeasured cell is hatched, says so and carries no colour', async () => {
        const { ctx, page } = await open(1280, { lang: 'fr' });
        const um = page.locator('#hb-grid td.vh-c--unmeasured').first();
        expect(await um.count()).toBe(1);
        expect(await um.getAttribute('data-bin')).toBeNull();
        expect(await um.evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(
            /repeating-linear-gradient/
        );
        expect(await um.innerText()).toMatch(/Pas encore mesuré/);
        await ctx.close();
    });

    test.each([
        ['en', 'light', null],
        ['fr', 'dark', null],
        ['fr', 'light', 'ocean'],
    ])(
        '390 %s %s %s: the list, the grid on demand, never wider than the screen',
        async (lang, theme, palette) => {
            const { ctx, page, errors } = await open(390, { lang, theme, palette });
            const vis = (sel) =>
                page.evaluate(
                    (s) =>
                        [...document.querySelectorAll(s)].some(
                            (e) => getComputedStyle(e).display !== 'none'
                        ),
                    sel
                );
            expect(await vis('#hb .vh-scroll')).toBe(false);
            expect(await vis('#hb .vh-list')).toBe(true);
            const items = await page.locator('#hb .vh-item').count();
            expect(items).toBeGreaterThan(0);
            expect(items).toBeLessThanOrEqual(10);
            const minH = await page.evaluate(() =>
                Math.min(
                    ...[...document.querySelectorAll('#hb .vh-item')].map((e) => e.offsetHeight)
                )
            );
            expect(minH).toBeGreaterThanOrEqual(44);
            const fits = () =>
                page.evaluate(
                    () =>
                        document.documentElement.scrollWidth <= document.documentElement.clientWidth
                );
            expect(await fits()).toBe(true);
            await page.click('#hb [data-vh-showgrid]');
            expect(await vis('#hb .vh-scroll')).toBe(true);
            expect(await page.getAttribute('#hb [data-vh-showgrid]', 'aria-expanded')).toBe('true');
            expect(await fits()).toBe(true); // the grid scrolls in its own box
            await page.focus('#hb-grid [role=gridcell][tabindex="0"]');
            await page.keyboard.press('ArrowRight');
            expect((await active(page)).role).toBe('gridcell');
            // nothing a person reads under 12 px
            const small = await page.evaluate(() =>
                [...document.querySelectorAll('#hb *')]
                    .filter(
                        (e) =>
                            e.childNodes.length &&
                            [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
                    )
                    .filter(
                        (e) => getComputedStyle(e).display !== 'none' && !e.closest('.viz-live')
                    )
                    .map((e) => parseFloat(getComputedStyle(e).fontSize))
                    .filter((px) => px < 12)
            );
            expect(small).toEqual([]);
            expect(errors).toEqual([]);
            await ctx.close();
        }
    );

    test('print: the full grid, no list, no tooltip, no buttons, exact colours', async () => {
        const { ctx, page } = await open(390, { media: 'print' });
        const state = await page.evaluate(() => {
            const shown = (s) =>
                [...document.querySelectorAll(s)].some(
                    (e) => getComputedStyle(e).display !== 'none'
                );
            const c = document.querySelector('#hb-grid td[data-bin]');
            return {
                grid: shown('#hb .vh-scroll'),
                list: shown('#hb .vh-list'),
                button: shown('#hb .vh-showgrid'),
                toggle: shown('#hb .viz-data-toggle'),
                exact:
                    getComputedStyle(c).printColorAdjust ||
                    getComputedStyle(c).webkitPrintColorAdjust,
            };
        });
        expect(state).toEqual({
            grid: true,
            list: false,
            button: false,
            toggle: false,
            exact: 'exact',
        });
        await ctx.close();
    });

    test('a colour theme keeps the heatmap scale (status never follows the accent)', async () => {
        const bg = async (palette) => {
            const { ctx, page } = await open(1280, { palette });
            const v = await page.evaluate(() =>
                [...document.querySelectorAll('#hb-grid td[data-bin]')].map(
                    (c) => c.getAttribute('data-bin') + ':' + getComputedStyle(c).backgroundColor
                )
            );
            await ctx.close();
            return v;
        };
        const iris = await bg(null);
        expect(await bg('meadow')).toEqual(iris);
        expect(await bg('sunrise')).toEqual(iris);
    });
});
