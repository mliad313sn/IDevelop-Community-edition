'use strict';
/**
 * The chart wrapper in a real browser (Chromium + the vendored Chart.js, no
 * server, no database): views/partials/viz/chart.ejs rendered with the real
 * locales, then fmt.js, chart-theme.js and viz.js as the page loads them.
 *   1280  a canvas with an accessible summary; focus and the arrow keys move
 *         the tooltip and the polite live region; « Show data » opens the
 *         table; a theme switch re-renders the chart from the new tokens;
 *   390   a sorted list instead of the canvas, never wider than the screen; a
 *         radar opens on its data table;
 *   print a picture of every chart, the canvas hidden.
 * Skipped without a Chromium binary.
 */
const { chromiumOrNull, launchOptions } = require('../helpers/chromium');
const { render, read } = require('../helpers/vizRender');

const chromium = chromiumOrNull();
const d = chromium ? describe : describe.skip;
jest.setTimeout(5 * 60 * 1000);

const CSS = ['public/css/style.css', 'public/css/horizon.css', 'public/css/viz.css']
    .map(read)
    .join('\n')
    .replace(/url\([^)]*\)/g, 'none');
const JS = [
    'public/vendor/chart.umd.min.js',
    'public/js/fmt.js',
    'public/js/chart-theme.js',
    'public/js/viz.js',
].map(read);

function html(lang, theme) {
    const bars = render(
        'views/partials/viz/chart.ejs',
        {
            vizChart: {
                id: 'bars',
                title: lang === 'fr' ? 'Prêts par site' : 'Ready by site',
                config: {
                    kind: 'hbar',
                    unit: 'pct',
                    labels: ['Northgate', 'Stonebridge', 'Riverside', 'Hillcrest'],
                    series: [
                        { key: 'k1', label: 'K1', data: [91.2, 41, null, 60], n: [41, 12, 30, 3] },
                    ],
                    threshold: { value: 80 },
                },
            },
        },
        lang
    );
    const radar = render(
        'views/partials/viz/chart.ejs',
        {
            vizChart: {
                id: 'radar',
                title: 'Radar',
                config: {
                    kind: 'radar',
                    unit: 'level',
                    labels: ['A', 'B', 'C', 'D'],
                    series: [
                        { key: 'actual', label: 'Demonstrated', data: [2, null, 3, 1] },
                        { key: 'required', label: 'Required', data: [3, 2, 3, 2] },
                    ],
                },
            },
        },
        lang
    );
    return `<!doctype html><html lang="${lang}"${theme === 'light' ? ' data-theme="light"' : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head>
<body><main class="main-content">${bars}${radar}</main></body></html>`;
}

let browser;
d('the chart wrapper in Chromium', () => {
    beforeAll(async () => {
        browser = await chromium.launch(launchOptions());
    });
    afterAll(async () => {
        if (browser) await browser.close();
    });
    async function open(width, lang = 'en', theme = 'light') {
        const ctx = await browser.newContext({
            viewport: { width, height: 900 },
            reducedMotion: 'reduce',
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        page.on('pageerror', (e) => errors.push(String(e.message)));
        await page.setContent(html(lang, theme), { waitUntil: 'load' });
        for (const content of JS) await page.addScriptTag({ content });
        await page.evaluate(() => window.Viz.init());
        await page.waitForTimeout(100);
        return { ctx, page, errors };
    }

    test('1280: canvas, summary, keyboard, live region, « Show data », theme switch', async () => {
        const { ctx, page, errors } = await open(1280, 'fr');
        expect(await page.getAttribute('#bars', 'data-viz-mode')).toBe('chart');
        const label = await page.getAttribute('#bars canvas', 'aria-label');
        expect(label).toMatch(
            /^Prêts par site : 4 éléments ; le plus bas : Stonebridge, 41,0 % \(n = 12\)/
        );
        await page.focus('#bars canvas');
        const live = () => page.textContent('#bars .viz-live[aria-live]');
        expect(await live()).toMatch(/^Northgate — K1 : 91,2 %/);
        await page.keyboard.press('ArrowRight');
        expect(await live()).toMatch(/^Stonebridge — K1 : 41,0 %/);
        await page.keyboard.press('Escape');
        expect(await live()).toBe('');
        await page.click('#bars summary');
        expect(await page.textContent('#bars .viz-data-label')).toBe('Masquer les données');
        expect(await page.locator('#bars .viz-table tbody tr').count()).toBe(4);
        const color = () =>
            page.evaluate(() => {
                const ch = window.ChartTheme.all().find((c) => c.canvas.closest('#bars'));
                return ch.options.scales.x.grid.color;
            });
        const before = await color();
        await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
        await page.waitForTimeout(100);
        const after = await color();
        expect(before.toUpperCase()).toBe('#E4E2F0');
        expect(after.toUpperCase()).toBe('#3A3860');
        expect(errors).toEqual([]);
        await ctx.close();
    });

    test.each(['fr', 'en'])(
        '390 %s: sorted list, radar as a table, no sideways scroll',
        async (lang) => {
            const { ctx, page, errors } = await open(390, lang, 'dark');
            expect(await page.getAttribute('#bars', 'data-viz-mode')).toBe('list');
            const labels = await page.$$eval('#bars .viz-list-label', (els) =>
                els.map((e) => e.textContent)
            );
            expect(labels).toEqual(['Stonebridge', 'Northgate', 'Hillcrest', 'Riverside']);
            expect(await page.getAttribute('#radar', 'data-viz-mode')).toBe('table');
            expect(await page.evaluate(() => document.querySelector('#radar details').open)).toBe(
                true
            );
            expect(
                await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth <= document.documentElement.clientWidth
                )
            ).toBe(true);
            expect(errors).toEqual([]);
            await ctx.close();
        }
    );

    test('print: a picture per chart, the canvas hidden', async () => {
        const { ctx, page } = await open(1280);
        await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
        await page.emulateMedia({ media: 'print' });
        const s = await page.evaluate(() => ({
            imgs: document.querySelectorAll('img.viz-print-img').length,
            canvasShown: [...document.querySelectorAll('canvas')].some(
                (c) => getComputedStyle(c).display !== 'none'
            ),
            imgShown: getComputedStyle(document.querySelector('img.viz-print-img')).display,
        }));
        expect(s).toEqual({ imgs: 2, canvasShown: false, imgShown: 'block' });
        await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
        expect(await page.locator('img.viz-print-img').count()).toBe(0);
        await ctx.close();
    });
});
