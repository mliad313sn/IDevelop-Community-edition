/**
 * Progression charts must fit their y-axis to the data.
 *
 * A trend pinned to its full theoretical scale (0-100 %, level 0-4) drew a real
 * but narrow movement as a flat line: the live roster's readiness moved
 * 96.8 -> 97.9 % and looked frozen, while a freshly cleaned install climbing
 * 82 -> 97 % showed a slope. Every chart that plots a metric OVER TIME now asks
 * public/js/chart-axis-fit.js for its window.
 */
const fs = require('fs');
const path = require('path');
const { fitRange, PERCENT, LEVEL } = require('../../public/js/chart-axis-fit');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('fitRange — percent', () => {
    test('a mature roster band (96.8 -> 97.9 %) is zoomed, not drawn on 0-100', () => {
        expect(fitRange([96.8, 97.1, 97.9], PERCENT)).toEqual({ min: 90, max: 100 });
    });
    test('a filling install (82 -> 97 %) keeps a proportionate window', () => {
        expect(fitRange([82.4, 82.6, 97.2], PERCENT)).toEqual({ min: 75, max: 100 });
    });
    test('never narrower than the 10-point minimum window', () => {
        const r = fitRange([50, 50.2], PERCENT);
        expect(r.max - r.min).toBeGreaterThanOrEqual(10);
        expect(r.min).toBeLessThanOrEqual(50);
        expect(r.max).toBeGreaterThanOrEqual(50.2);
    });
    test('clamped to 0-100 at both ends', () => {
        expect(fitRange([1, 2], PERCENT).min).toBe(0);
        expect(fitRange([99.5, 100], PERCENT).max).toBe(100);
    });
    test('null / missing measurements are ignored, never read as 0', () => {
        expect(fitRange([null, 96.8, undefined, 97.9, ''], PERCENT)).toEqual({ min: 90, max: 100 });
    });
    test('no data at all falls back to the full scale', () => {
        expect(fitRange([], PERCENT)).toEqual({ min: 0, max: 100 });
        expect(fitRange([null, null], PERCENT)).toEqual({ min: 0, max: 100 });
    });
    test('every value is always inside the window', () => {
        for (const vals of [[0, 100], [3, 4], [55, 71.3], [99.9], [12.5, 13]]) {
            const r = fitRange(vals, PERCENT);
            vals.forEach((v) => {
                expect(v).toBeGreaterThanOrEqual(r.min);
                expect(v).toBeLessThanOrEqual(r.max);
            });
        }
    });
});

describe('fitRange — level 0-4', () => {
    test('a few tenths of progress (2.9 -> 3.1) is visible, not flat on 0-4', () => {
        const r = fitRange([2.9, 3.0, 3.1], LEVEL);
        expect(r.max - r.min).toBeLessThan(4);
        expect(r.min).toBeGreaterThan(0);
        expect(r.max).toBeLessThanOrEqual(4);
        expect(r.min).toBeLessThanOrEqual(2.9);
        expect(r.max).toBeGreaterThanOrEqual(3.1);
    });
    test('at least a one-level window, clamped to the scale', () => {
        const r = fitRange([3.95, 4], LEVEL);
        expect(r.max).toBe(4);
        expect(r.max - r.min).toBeGreaterThanOrEqual(1);
    });
});

describe('every progression chart uses the shared fit (source guard)', () => {
    const CHARTS = [
        { file: 'public/js/dashboard.js', page: 'views/pages/dashboard.ejs' },
        { file: 'views/pages/benchmark/role.ejs', page: 'views/pages/benchmark/role.ejs' },
        { file: 'views/pages/employees/progress.ejs', page: 'views/pages/employees/progress.ejs' },
        {
            file: 'views/pages/reports/dept-analytics.ejs',
            page: 'views/pages/reports/dept-analytics.ejs',
        },
    ];
    test.each(CHARTS)('$file calls ChartAxisFit.fitRange', ({ file }) => {
        expect(read(file)).toMatch(/ChartAxisFit\.fitRange\(/);
    });
    test.each(CHARTS)('$page loads chart-axis-fit.js', ({ page }) => {
        expect(read(page)).toMatch(/<script src="\/js\/chart-axis-fit\.js/);
    });
    test('the trend charts no longer pin a 0-100 or 0-4 y-axis', () => {
        expect(read('views/pages/benchmark/role.ejs')).not.toMatch(
            /y:\s*\{\s*beginAtZero:\s*true,\s*max:\s*100/
        );
        const prog = read('views/pages/employees/progress.ejs');
        expect(prog).not.toMatch(/y:\s*\{\s*beginAtZero:\s*true,\s*max:\s*4/);
        expect(prog).not.toMatch(/y2:\s*\{\s*beginAtZero:\s*true,\s*max:\s*100/);
        const dept = read('views/pages/reports/dept-analytics.ejs');
        expect(dept).not.toMatch(/y:\s*\{\s*beginAtZero:\s*true,\s*max:\s*4/);
    });
});
