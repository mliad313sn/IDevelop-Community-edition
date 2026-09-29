/* eslint-env browser, node */
/**
 * chart-axis-fit.js — the one y-axis rule for PROGRESSION charts.
 *
 * A trend drawn on its full theoretical scale (0-100 %, level 0-4) flattens a
 * real but narrow movement into a straight line: a mature roster moving
 * 96.8 -> 97.9 % looks frozen, while a freshly cleaned install climbing
 * 82 -> 97 % shows a slope. Every chart that plots a metric OVER TIME asks this
 * helper for its window instead of pinning the scale.
 *
 * The window is padded around the data, snapped to `step`, clamped to the
 * metric's natural bounds, and never narrower than `minSpan` — so a
 * near-constant series is not over-zoomed into a misleading swing. Counts and
 * magnitudes (bars, stacked areas) must NOT use this: their zero is meaningful.
 *
 * Presets: PERCENT (0-100, 10-point minimum window, 5 % ticks) and LEVEL
 * (0-4 proficiency, 1-level minimum window, 0.5 ticks).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ChartAxisFit = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var PERCENT = { floor: 0, ceil: 100, minSpan: 10, step: 5, padMin: 2 };
    var LEVEL = { floor: 0, ceil: 4, minSpan: 1, step: 0.5, padMin: 0.2 };

    /**
     * @param {Array<number|null>} values  every value the axis will carry (all series)
     * @param {{floor:number, ceil:number, minSpan:number, step:number, padMin:number}} opts
     * @returns {{min:number, max:number}}
     */
    function fitRange(values, opts) {
        var o = opts || PERCENT;
        var ys = (values || [])
            .filter(function (v) {
                return v !== null && v !== undefined && v !== '';
            })
            .map(Number)
            .filter(function (v) {
                return isFinite(v);
            });
        if (!ys.length) return { min: o.floor, max: o.ceil };

        var lo = Math.min.apply(null, ys);
        var hi = Math.max.apply(null, ys);
        var pad = Math.max(o.padMin, (hi - lo) * 0.5);
        var a = lo - pad;
        var b = hi + pad;
        if (b - a < o.minSpan) {
            var mid = (lo + hi) / 2;
            a = mid - o.minSpan / 2;
            b = mid + o.minSpan / 2;
        }
        var min = Math.max(o.floor, Math.floor(a / o.step) * o.step);
        var max = Math.min(o.ceil, Math.ceil(b / o.step) * o.step);
        if (max - min < o.minSpan) {
            if (max >= o.ceil) min = Math.max(o.floor, o.ceil - o.minSpan);
            else max = Math.min(o.ceil, min + o.minSpan);
        }
        return { min: min, max: max };
    }

    return { fitRange: fitRange, PERCENT: PERCENT, LEVEL: LEVEL };
});
