'use strict';
/**
 * The « Health and safety operations » block of the dashboard's Safety tab
 * (K40 to K44, views/pages/dashboard/_hse-ops.ejs), rendered from models with
 * the real locale files, no database:
 *   - a week without a nightly recompute is null in the chart, never 0;
 *   - « to be set up » and « not measured yet » are said in words;
 *   - under 5 people, K44 prints counts, no %; the share is the floored one;
 *   - a site under 5 people is the « fewer than 5 people » row;
 *   - the block is shown only when the tab model asks for it;
 *   - FR and EN print no raw key, no inline handler.
 */
const { render } = require('../helpers/vizRender');

const ctx = { scope: {}, scopeQuery: '', navVisible: {} };
const panel = (P, lang = 'fr') =>
    render(
        'views/pages/dashboard/_panel.ejs',
        { panel: P, ctx, monthLabel: (m) => 'M' + m, fmtPeriodBound: (d) => 'D' + d },
        lang
    );
const configOf = (html, id) => {
    const m = html.match(
        new RegExp(
            `id="${id}"[\\s\\S]*?<script type="application/json" class="viz-config">([\\s\\S]*?)</script>`
        )
    );
    return m ? JSON.parse(m[1]).config : null;
};
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const weeks = Array.from({ length: 13 }, (_, i) => ({
    start: `2026-07-${String(i + 1).padStart(2, '0')}`,
    end: `2026-07-${String(i + 7).padStart(2, '0')}`,
    current: i === 12,
    recomputed: i % 4 !== 0,
    count: i % 4 === 0 ? null : i % 3,
}));
const months = Array.from({ length: 12 }, (_, i) => ({
    start: 'x',
    end: 'y',
    month: `2027-${String(i + 1).padStart(2, '0')}`,
}));

const measured = {
    people: 40,
    recompute: { at: '2026-10-20T02:10:00.000Z', day: '2026-10-20' },
    K40: {
        kpi: 'K40',
        value: 2,
        status: 'watch',
        drill: [],
        breakdown: {
            running: 2,
            renewed: 1,
            oldestHours: 30,
            granted30: 3,
            granted30Line: 1,
            granted30Hse: 2,
            granted30Contest: 0,
            contestsOpen: 1,
            contestOldestDays: 4,
            upheld90: 2,
            overturned90: 1,
        },
    },
    K41: {
        kpi: 'K41',
        value: 9,
        status: null,
        weeks,
        reasons: [
            { code: 'cert_expired', n: 5 },
            { code: 'level_below_min', n: 4 },
        ],
        breakdown: { gated: 30, measuredWeeks: 9, unrecomputedWeeks: 4 },
        drill: [],
    },
    K42: {
        kpi: 'K42',
        value: 7,
        status: null,
        months,
        totals: [1, 0, 2, 0, 0, 1, 0, 0, 3, 0, 0, 0],
        sites: [
            {
                siteName: 'Stonebridge',
                noSite: false,
                smallSites: false,
                counts: [1, 0, 2, 0, 0, 1, 0, 0, 2, 0, 0, 0],
                total: 6,
            },
            {
                siteName: null,
                noSite: false,
                smallSites: true,
                counts: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
                total: 1,
            },
        ],
        breakdown: { expiring12m: 7, noDate: 2 },
        drill: [],
    },
    K43: {
        kpi: 'K43',
        value: 1,
        status: 'at_risk',
        sites: [
            { siteName: 'Stonebridge', allSites: false, active: 3, breached: 1, projected90: 1 },
            { siteName: null, allSites: true, active: 1, breached: 0, projected90: 0 },
        ],
        breakdown: {
            active: 4,
            breached: 1,
            breachedCritical: 1,
            breachedWarning: 0,
            projected30: 0,
            projected60: 1,
            projected90: 1,
        },
        drill: [],
    },
    K44: {
        kpi: 'K44',
        value: 99.9,
        status: 'watch',
        rates: {
            dated: { filled: 1000, recorded: 1001, pct: 99.9 },
            evidence: { filled: 1001, recorded: 1001, pct: 100 },
            voc: { filled: 990, recorded: 1001, pct: 98.9 },
            numbered: { filled: 1001, recorded: 1001, pct: 100 },
            issuer: { filled: 12, recorded: 1001, pct: 1.1 },
        },
        breakdown: { recorded: 1001, complete: 1000, incomplete: 1, missing: 3 },
        drill: [],
    },
};

describe('the measured block', () => {
    const P = { id: 'safety', blocks: ['hseOps'], hseOps: measured };

    test.each(['fr', 'en'])('%s: the five cards, no raw key, no inline handler', (lang) => {
        const html = panel(P, lang);
        for (const k of ['K40', 'K41', 'K42', 'K43', 'K44'])
            expect(html).toContain(`data-kpi="${k}"`);
        expect(html).not.toMatch(/(safety|kpi|dash|viz):[a-z0-9_.]+/);
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        for (const k of ['K40', 'K41', 'K42', 'K43', 'K44'])
            expect(html).toContain(`href="/kpi/glossary#${k}"`);
    });

    test('a week without a recompute is null in the chart, never 0', () => {
        const cfg = configOf(panel(P, 'en'), 'ds-k41-chart');
        const data = cfg.series[0].data;
        expect(data).toHaveLength(13);
        expect(data.filter((v) => v === null)).toHaveLength(4);
        weeks.forEach((w, i) => expect(data[i]).toBe(w.count));
        expect(text(panel(P, 'en'))).toContain('Weeks without a nightly recompute: 4');
    });

    test('statuses and the floored share are printed as computed', () => {
        const t = text(panel(P, 'en'));
        expect(t).toContain('Waivers running: 2');
        expect(t).toContain('Rules in breach now: 1 of 4');
        expect(t).toContain('Complete records: 99.9%');
        expect(t).not.toContain('Complete records: 100');
        expect(t).toContain('Required: 1,004. On record: 1,001. Complete: 1,000.');
        expect(t).toContain('Required certificates never recorded, outside the share: 3');
        expect(t).toContain('Certificate expired');
        expect(t).toContain('Last nightly recompute of the gate: D2026-10-20');
        expect(panel(P, 'en')).toContain('data-status="at_risk"');
    });

    test('a site under 5 people is the « fewer than 5 people » row', () => {
        const t = text(panel(P, 'en'));
        expect(t).toContain('Sites of fewer than 5 people');
        expect(t).toContain(
            'Required certificates on record without an expiry date, counted apart: 2'
        );
        const cfg = configOf(panel(P, 'en'), 'ds-k42-chart');
        expect(cfg.series[0].data).toEqual(measured.K42.totals);
        expect(cfg.labels[0]).toBe('M2027-01');
    });

    test('FR speaks French', () => {
        const t = text(panel(P, 'fr'));
        expect(t).toContain('Dérogations en cours : 2');
        expect(t).toContain('Règles en rupture aujourd’hui : 1 sur 4');
    });
});

describe('the honest empty states', () => {
    test('nothing set up and nothing measured are said in words, never 0', () => {
        const nc = (kpi) => ({ kpi, value: null, status: 'not_configured', drill: [] });
        const P = {
            id: 'safety',
            blocks: ['hseOps'],
            hseOps: {
                people: 3,
                recompute: null,
                K40: nc('K40'),
                K41: {
                    kpi: 'K41',
                    value: null,
                    status: 'not_measured',
                    breakdown: { gated: 3 },
                    drill: [],
                },
                K42: nc('K42'),
                K43: nc('K43'),
                K44: nc('K44'),
            },
        };
        const t = text(panel(P, 'en'));
        expect(t).toContain(
            'No role is under an enforced safety rule, and no waiver was ever granted.'
        );
        expect(t).toContain('The gate has no history yet for these people.');
        expect(t).toContain('The nightly recompute of the gate has not run yet.');
        expect(t).toContain('No coverage rule that you can see is set up.');
        expect(t).toContain('No required certificate is set up for these people.');
        expect(t).not.toMatch(/Waivers running: 0|Rules in breach now: 0/);
        expect(panel(P, 'en')).not.toContain('viz-config');
    });

    test('under 5 people K44 prints counts, no %', () => {
        const P = {
            id: 'safety',
            blocks: ['hseOps'],
            hseOps: {
                ...measured,
                K44: {
                    kpi: 'K44',
                    value: null,
                    status: 'small_n',
                    rates: Object.fromEntries(
                        ['dated', 'evidence', 'voc', 'numbered', 'issuer'].map((k) => [
                            k,
                            { filled: 2, recorded: 3, pct: null },
                        ])
                    ),
                    breakdown: { recorded: 3, complete: 2, incomplete: 1, missing: 0 },
                    drill: [],
                },
            },
        };
        const html = panel(P, 'en');
        const k44 = html.slice(html.indexOf('id="ds-k44"'));
        expect(text(k44)).toContain('Complete records: 2 of 3');
        expect(k44).not.toMatch(/\d%/);
        expect(text(k44)).toContain('Fewer than 5 people: counts only');
    });

    test('no block when the tab model does not ask for it, nor for an empty population', () => {
        expect(panel({ id: 'safety', blocks: [], hseOps: measured }, 'en')).not.toContain(
            'data-kpi="K40"'
        );
        expect(
            panel({ id: 'safety', blocks: ['hseOps'], hseOps: { people: 0 } }, 'en')
        ).not.toContain('data-kpi="K40"');
    });
});
