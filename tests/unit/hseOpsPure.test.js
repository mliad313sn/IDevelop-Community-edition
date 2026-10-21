'use strict';
/**
 * The pure rules of the health and safety operations indicators (K40 to
 * K44, HseOpsService): statuses that are never « compliant » while someone
 * falls short, null (never 0) for what was not measured, no % under 5
 * people, a share rounded down, and sites under 5 people never named.
 */
const H = require('../../src/services/HseOpsService');
const K = require('../../src/services/KpiService');

describe('statuses', () => {
    test('K40: never compliant while a waiver runs; nothing set up and nothing used', () => {
        expect(H.waiverStatus({ configured: false, everUsed: false, running: 0 })).toBe(
            'not_configured'
        );
        expect(H.waiverStatus({ configured: true, everUsed: false, running: 0 })).toBe('compliant');
        expect(H.waiverStatus({ configured: true, everUsed: true, running: 1 })).toBe('watch');
        // a waiver granted before the rules were removed still says so
        expect(H.waiverStatus({ configured: false, everUsed: true, running: 2 })).toBe('watch');
    });

    test('K43: a critical rule in breach is at risk, a warning one watch', () => {
        const s = (active, c, w) =>
            H.coverageStatus({ active, breachedCritical: c, breachedWarning: w });
        expect(s(0, 0, 0)).toBe('not_configured');
        expect(s(3, 0, 0)).toBe('compliant');
        expect(s(3, 0, 1)).toBe('watch');
        expect(s(3, 1, 1)).toBe('at_risk');
    });

    test('K44: rounded down, never 100 % while one record is short, no % under 5 people', () => {
        expect(H.qualityResult(0, 0, 0)).toEqual({ status: 'not_measured', value: null });
        expect(H.qualityResult(4, 4, 4)).toEqual({ status: 'small_n', value: null });
        expect(H.qualityResult(2000, 1999, 900)).toEqual({ status: 'watch', value: 99.9 });
        expect(H.qualityResult(5, 5, 5)).toEqual({ status: 'compliant', value: 100 });
        expect(H.qualityResult(3, 2, 6).value).toBe(66.6);
    });

    test('a fill rate keeps its counts and drops the % under 5 people', () => {
        expect(H.rateOf(0, 0, 0)).toEqual({ filled: null, recorded: 0, pct: null });
        expect(H.rateOf(1, 3, 3)).toEqual({ filled: 1, recorded: 3, pct: null });
        expect(H.rateOf(199, 200, 50)).toEqual({ filled: 199, recorded: 200, pct: 99.5 });
    });
});

describe('weeks, months and the recompute gaps', () => {
    test('13 Monday-based weeks ending with the current one', () => {
        const w = H.weekWindows('2026-10-21'); // a Wednesday
        expect(w).toHaveLength(13);
        expect(w[12]).toEqual({ start: '2026-10-19', end: '2026-10-25', current: true });
        expect(w[0].start).toBe('2026-07-27');
        expect(w.filter((x) => x.current)).toHaveLength(1);
        expect(H.weekWindows('not a date')).toEqual([]);
    });

    test('a week without a recompute and without an entry is null, never 0', () => {
        const weeks = H.weekWindows('2026-10-21').slice(-3);
        const out = H.bucketWeeks(weeks, ['2026-10-06'], new Set(['2026-10-20']));
        expect(out.map((x) => x.count)).toEqual([1, null, 0]);
        expect(out.map((x) => x.recomputed)).toEqual([false, false, true]);
    });

    test('12 months from today, the first one starting today', () => {
        const m = H.monthWindows('2026-10-20');
        expect(m).toHaveLength(12);
        expect(m[0]).toEqual({ start: '2026-10-20', end: '2026-10-31', month: '2026-10' });
        expect(m[1]).toEqual({ start: '2026-11-01', end: '2026-11-30', month: '2026-11' });
        expect(m[11].month).toBe('2027-09');
        expect(m[4].end).toBe('2027-02-28');
    });
});

describe('blocking causes', () => {
    test('enforced causes only: not observe-only, not waived, not informational', () => {
        expect(
            H.blockingCodes([
                { code: 'cert_expired', blocking: true },
                { code: 'cert_expired', blocking: true },
                { code: 'cert_expiring', blocking: false },
                { code: 'level_below_min', blocking: true, observe: true },
                { code: 'cert_missing', blocking: true, waived: true },
                { code: '' },
                null,
            ])
        ).toEqual(['cert_expired']);
        expect(H.blockingCodes('[{"code":"not_assessed","blocking":true}]')).toEqual([
            'not_assessed',
        ]);
        expect(H.blockingCodes('{not json')).toEqual([]);
        expect(H.blockingCodes({ code: 'x' })).toEqual([]);
    });
});

describe('K42 pipeline', () => {
    const pop = {
        rows: [
            ...[1, 2, 3, 4, 5].map((id) => ({ id, siteId: 10, siteName: 'Stonebridge' })),
            { id: 6, siteId: 20, siteName: 'Little Harbour' },
            { id: 7, siteId: null, siteName: null },
        ],
    };
    const rows = [
        { employeeId: 1, certId: 101, expiresOn: '2026-11-03' },
        { employeeId: 2, certId: 102, expiresOn: '2026-10-25' },
        { employeeId: 3, certId: 103, expiresOn: null },
        { employeeId: 4, certId: 104, expiresOn: '2026-01-01' }, // already expired
        { employeeId: 5, certId: null, expiresOn: null }, // never recorded
        { employeeId: 5, certId: 105, expiresOn: '2028-01-01' }, // beyond 12 months
        { employeeId: 6, certId: 106, expiresOn: '2027-03-15' },
        { employeeId: 7, certId: 107, expiresOn: '2027-03-16' },
    ];
    const p = H.pipelineOf(rows, pop, '2026-10-20');

    test('by month, with « no expiry date » apart and the expired left out', () => {
        expect(p.total).toBe(4);
        expect(p.noDate).toBe(1);
        expect(p.totals[0]).toBe(1);
        expect(p.totals[1]).toBe(1);
        expect(p.totals[5]).toBe(2);
        expect(p.totals.reduce((a, b) => a + b, 0)).toBe(p.total);
    });

    test('a site of fewer than 5 people is not named; the sites add up to the total', () => {
        expect(p.sites.map((s) => [s.siteName, s.noSite, s.smallSites, s.total])).toEqual([
            ['Stonebridge', false, false, 2],
            [null, true, false, 1],
            [null, false, true, 1],
        ]);
        expect(JSON.stringify(p)).not.toContain('Little Harbour');
        expect(p.sites.reduce((a, s) => a + s.total, 0)).toBe(p.total);
    });
});

describe('K43 coverage', () => {
    const rules = [
        { ruleId: 1, satisfied: false, severity: 'critical', siteId: 10, siteName: 'Stonebridge' },
        { ruleId: 2, satisfied: true, severity: 'warning', siteId: 10, siteName: 'Stonebridge' },
        { ruleId: 3, satisfied: true, severity: 'critical', siteId: null },
        { ruleId: 4, satisfied: true, severity: 'critical', siteId: 20, siteName: 'Kingsmere' },
    ];
    const first = new Map([
        ['2', 12],
        ['3', 75],
        ['1', 1], // a rule already broken is never « projected »
    ]);
    const c = H.coverageOf(rules, first);

    test('now, and projected only among the rules holding today', () => {
        expect(c).toMatchObject({
            status: 'at_risk',
            active: 4,
            breached: 1,
            breachedCritical: 1,
            breachedWarning: 0,
            projected: { 30: 1, 60: 1, 90: 2 },
        });
    });

    test('by site, the broken first, rules without a site last among equals', () => {
        expect(c.sites.map((s) => [s.siteName, s.allSites, s.breached, s.projected90])).toEqual([
            ['Stonebridge', false, 1, 1],
            [null, true, 0, 1],
            ['Kingsmere', false, 0, 0],
        ]);
    });
});

describe('the KPI module knows K40 to K44', () => {
    test('core, owned by health and safety, live, with a glossary entry in FR and EN', () => {
        for (const id of ['K40', 'K41', 'K42', 'K43', 'K44']) {
            expect(K.CONTRACTS[id]).toMatchObject({
                module: null,
                owner: 'hse',
                freshness: 'live',
            });
            expect(typeof K.KPI_FUNCTIONS[id]).toBe('function');
            expect(K.isAvailable(id, {})).toBe(true);
            for (const lang of ['fr', 'en']) {
                const kpi = require(`../../locales/${lang}/kpi.json`);
                for (const f of ['name', 'def', 'formula', 'den', 'incl', 'bands'])
                    expect([lang, id, f, typeof kpi[`${id.toLowerCase()}_${f}`]]).toEqual([
                        lang,
                        id,
                        f,
                        'string',
                    ]);
            }
        }
        expect(K.CONTRACT_VERSION).toBe('kpi-2');
        expect(K.CONTRACTS.K44.unit).toBe('pct');
    });

    test('the safety tab carries the block, gated like the tab', () => {
        const T = require('../../src/config/dashboardTabs');
        expect(T.BLOCKS.find((b) => b.id === 'hseOps')).toMatchObject({
            tab: 'safety',
            module: null,
            permission: 'safety',
        });
    });
});
