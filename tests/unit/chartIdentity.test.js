'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * The chart identity (src/utils/branding.js CHART_IDENTITY) decides every colour
 * a chart draws, so it is also the one thing that can silently make the charts
 * unreadable. Guarded here, measured rather than eyeballed: a palette entry that
 * fails contrast, or two series a deuteranope cannot tell apart, is a defect and
 * not a matter of taste. The floors below are the WCAG 1.4.11 non-text minimum
 * (3:1) against BOTH chart surfaces, and a CIE76 separation floor in simulated
 * dichromatic vision.
 */

const fs = require('fs');
const path = require('path');
const branding = require('../../src/utils/branding');

const THEME = fs.readFileSync(path.join(__dirname, '../../public/js/chart-theme.js'), 'utf8');

// Chart canvases sit on --bg-card, which is near-black on the dark theme and
// white on the light one. A colour has to clear 3:1 on both to be usable in a
// product where the user picks the theme.
const DARK_SURFACE = '#151931';
const LIGHT_SURFACE = '#FFFFFF';

// ---- colour math (WCAG relative luminance, CIE-Lab, dichromacy simulation) ----
const hex2rgb = (h) => {
    h = String(h).replace('#', '');
    if (h.length === 3)
        h = h
            .split('')
            .map((c) => c + c)
            .join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const lin = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const contrast = branding.contrastRatio;
const lab = (hex) => {
    const [r, g, b] = hex2rgb(hex).map(lin);
    const xyz = [
        r * 0.4124 + g * 0.3576 + b * 0.1805,
        r * 0.2126 + g * 0.7152 + b * 0.0722,
        r * 0.0193 + g * 0.1192 + b * 0.9505,
    ];
    const w = [0.95047, 1, 1.08883];
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const [fx, fy, fz] = xyz.map((v, i) => f(v / w[i]));
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
const dE = (a, b) => {
    const A = lab(a),
        B = lab(b);
    return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
};
const CVD = {
    // Brettel/Viénot linear-RGB projections.
    deuteranopia: [
        [0.625, 0.375, 0],
        [0.7, 0.3, 0],
        [0, 0.3, 0.7],
    ],
    protanopia: [
        [0.567, 0.433, 0],
        [0.558, 0.442, 0],
        [0, 0.242, 0.758],
    ],
};
function simulate(hex, kind) {
    const M = CVD[kind];
    const [r, g, b] = hex2rgb(hex).map(lin);
    const gam = (v) => {
        v = Math.max(0, Math.min(1, v));
        return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    };
    return (
        '#' +
        M.map((row) =>
            Math.round(gam(row[0] * r + row[1] * g + row[2] * b) * 255)
                .toString(16)
                .padStart(2, '0')
        ).join('')
    );
}
const cvdGap = (a, b) =>
    Math.min(
        dE(a, b),
        dE(simulate(a, 'deuteranopia'), simulate(b, 'deuteranopia')),
        dE(simulate(a, 'protanopia'), simulate(b, 'protanopia'))
    );

const COM = branding.CHART_IDENTITY.community;
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v);

describe('the identity table resolves safely', () => {
    test('an absent or unknown edition resolves to the community identity', () => {
        expect(branding.editionRow(undefined).identity).toBe('community');
        expect(branding.editionRow('').identity).toBe('community');
        expect(branding.editionRow('no-such-row').identity).toBe('community');
        expect(branding.DEFAULTS.edition).toBe('community');
    });

    test('the accent role follows the brand token, so a re-brand repaints charts', () => {
        expect(COM.semantic.accent).toBe('var(--brand)');
        expect(branding.buildChartCss('community')).toContain('--chart-accent:var(--brand);');
    });
});

describe('the community palette is accessible — measured, not assumed', () => {
    const CAT = COM.categorical;

    test.each(CAT.map((c, i) => [i + 1, c]))(
        'categorical slot %i (%s) clears 3:1 on the dark AND the light chart surface',
        (_i, colour) => {
            expect(isHex(colour)).toBe(true);
            expect(contrast(colour, DARK_SURFACE)).toBeGreaterThanOrEqual(3);
            expect(contrast(colour, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
        }
    );

    test('adjacent series stay separable for deuteranopes and protanopes', () => {
        // Adjacent slots are what a reader compares in a legend, so they carry the
        // strictest floor. 20 is roughly four times the "clearly different" JND
        // for large filled areas.
        const weak = [];
        for (let i = 0; i < CAT.length - 1; i++) {
            const gap = cvdGap(CAT[i], CAT[i + 1]);
            if (gap < 20) weak.push(`${i + 1}-${i + 2} dE ${gap.toFixed(1)}`);
        }
        expect(weak).toEqual([]);
    });

    test('no two series anywhere in the palette collapse together', () => {
        const weak = [];
        for (let i = 0; i < CAT.length; i++) {
            for (let j = i + 1; j < CAT.length; j++) {
                const gap = cvdGap(CAT[i], CAT[j]);
                if (gap < 12) weak.push(`${i + 1}-${j + 1} dE ${gap.toFixed(1)}`);
            }
        }
        expect(weak).toEqual([]);
    });

    test('the palette spreads across lightness, so it survives greyscale too', () => {
        const lums = CAT.map((c) => lab(c)[0]);
        expect(Math.max(...lums) - Math.min(...lums)).toBeGreaterThan(12);
    });

    test('a marker-shape cycle carries what colour alone cannot', () => {
        expect(COM.pointCycle.length).toBeGreaterThanOrEqual(4);
        expect(new Set(COM.pointCycle).size).toBe(COM.pointCycle.length);
    });
});

describe('semantic colours stay semantic whatever the brand', () => {
    test('danger is red-ish and success is green-ish — the brand accent does not get a vote', () => {
        const [gr, gg] = hex2rgb(COM.semantic.good);
        const [lr, , lb] = hex2rgb(COM.semantic.low);
        expect(gg).toBeGreaterThan(gr); // success: green channel dominates red
        expect(lr).toBeGreaterThan(lb); // danger: red channel dominates blue
        expect(lr).toBeGreaterThan(hex2rgb(COM.semantic.low)[1]);
    });

    test('warning and danger do not merge under deuteranopia', () => {
        // Amber-vs-red is the classic collapse under deuteranopia (a naive
        // #F5A623 / #F06060 pair measures ~7 here), which is why this floor exists.
        expect(cvdGap(COM.semantic.mid, COM.semantic.low)).toBeGreaterThan(20);
    });

    test('every semantic colour clears 3:1 on both chart surfaces', () => {
        for (const [name, colour] of Object.entries(COM.semantic)) {
            if (!isHex(colour)) continue; // accent follows brandAccentColor via var(--brand)
            expect([name, contrast(colour, DARK_SURFACE) >= 3]).toEqual([name, true]);
            expect([name, contrast(colour, LIGHT_SURFACE) >= 3]).toEqual([name, true]);
        }
    });

    test('the heat scale is never red-vs-green alone', () => {
        // 0-4 proficiency: the middle of the ramp has to be a third hue, or the
        // scale is unreadable for the ~8% of men with a red-green deficiency.
        for (const row of [COM]) {
            expect(row.heat).toHaveLength(5);
            const mid = row.heat[2];
            const [r, g, b] = mid.match(/[\d.]+/g).map(Number);
            expect(b).toBeGreaterThan(r);
            expect(b).toBeGreaterThan(g);
        }
    });
});

describe('the identity travels as tokens, so no chart branches on it', () => {
    test('chart-theme.js never reads the edition, only the tokens it emits', () => {
        expect(THEME).not.toMatch(/\bedition\s*[=!]==/);
        expect(THEME).not.toMatch(/['"]community['"]\s*===/);
        // and every differentiator is a cssVar read, so adding one is one line
        expect(THEME).toMatch(/cssVar\('--chart-cat-1'/);
        expect(THEME).toMatch(/setIfDeclared\(/);
    });

    test('every token the table emits is actually read by the theme', () => {
        const emitted = [
            ...branding.buildChartCss('community').matchAll(/(--chart-[a-z0-9-]+):/g),
        ].map((m) => m[1]);
        const unread = emitted.filter((t) => {
            if (/^--chart-(cat|heat)-\d+$/.test(t)) return false; // built by index
            if (/^--chart-scheme-/.test(t)) return false; // built by scheme key
            return !THEME.includes(`'${t}'`);
        });
        expect(unread).toEqual([]);
    });
});
