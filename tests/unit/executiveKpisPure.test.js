'use strict';
/**
 * The executive indicators of the board pack (K17, K19, K20, K21 —
 * ExecutiveKpiService), their pure rules:
 *
 *   K17  the median counts the rounds still waiting (Kaplan–Meier), a P90
 *        only from 10 approvals, fewer than 5 approvals give counts only,
 *        « watch » while someone waits more than 7 days, nothing submitted
 *        is « not measured », never 0 days;
 *   K19  only a CAPTURED capability counts, by the site and department
 *        captured at the event; before any capture « insufficient history »;
 *   K20  never « compliant » while one person is exposed; a site under 5
 *        people is folded with the other small sites, never named;
 *   K21  a flight risk never reviewed is « not assessed », never « low ».
 *
 * They are registered in the KPI contract (kpi-2), K17 can carry a target
 * (lower is better, in days), and the glossary documents all four in FR
 * and EN.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const X = require('../../src/services/ExecutiveKpiService');
const K = require('../../src/services/KpiService');
const T = require('../../src/services/KpiTargetService');

describe('K17 validation lead time', () => {
    test('nothing submitted is « not measured », never 0 days', () => {
        const r = X.k17FromFacts({ approvedLead: [], waitingRounds: [], backlogPeople: [] });
        expect(r).toMatchObject({ value: null, status: 'not_measured', n: 0 });
    });

    test('fewer than 5 approvals: counts only, the median kept apart', () => {
        const r = X.k17FromFacts({ approvedLead: [1, 2, 3], waitingRounds: [], backlogPeople: [] });
        expect(r.value).toBeNull();
        expect(r.status).toBe('small_n');
        expect(r.n).toBe(3);
        expect(r.rawValue).toBe(2);
    });

    test('a round still waiting is censored, not dropped: the median moves up', () => {
        const lead = [1, 1, 2, 2, 3];
        const dropped = X.k17FromFacts({
            approvedLead: lead,
            waitingRounds: [],
            backlogPeople: [],
        });
        const censored = X.k17FromFacts({
            approvedLead: lead,
            waitingRounds: [10, 12, 14, 16],
            backlogPeople: [],
        });
        expect(dropped.value).toBe(2);
        expect(censored.value).toBeGreaterThan(dropped.value);
        expect(censored.censored).toBe(4);
    });

    test('fewer than half decided: the median is « beyond » the longest wait', () => {
        const r = X.k17FromFacts({
            approvedLead: [1, 1, 1, 1, 1],
            waitingRounds: [5, 6, 7, 8, 9, 10, 11],
            backlogPeople: [],
        });
        expect(r.value).toBeNull();
        expect(r.medianBeyond).toBe(11);
    });

    test('a P90 only from 10 approvals', () => {
        const nine = Array.from({ length: 9 }, (_, i) => i + 1);
        const ten = Array.from({ length: 10 }, (_, i) => i + 1);
        const f = (l) => X.k17FromFacts({ approvedLead: l, waitingRounds: [], backlogPeople: [] });
        expect(f(nine).p90).toBeNull();
        expect(f(ten).p90).toBe(9);
    });

    test('the backlog in age bands; « watch » while someone waits more than 7 days', () => {
        expect(X.k17Bands([0, 7, 7.5, 30, 31, null, 'x'])).toEqual({
            total: 5,
            upTo7: 2,
            d8to30: 2,
            over30: 1,
        });
        const lead = [1, 2, 3, 4, 5];
        const calm = X.k17FromFacts({ approvedLead: lead, waitingRounds: [], backlogPeople: [2] });
        const late = X.k17FromFacts({ approvedLead: lead, waitingRounds: [], backlogPeople: [9] });
        expect(calm.status).toBeNull();
        expect(late.status).toBe('watch');
        expect(late.late).toBe(1);
    });

    test('K17 can carry a target in days, lower is better', () => {
        expect(T.TARGETABLE.K17).toEqual({ polarity: 'lower', unit: 'days' });
        expect(T.meetsTarget('K17', 4.5, 5)).toBe(true);
        expect(T.meetsTarget('K17', 6, 5)).toBe(false);
    });
});

describe('K19 capability lost to departures', () => {
    const cap = (readiness, soleCritical = 0, siteId = 3, departmentId = 4) => ({
        payload: { capability: { readiness, soleCritical, siteId, departmentId } },
    });

    test('before any capture: « insufficient history », never a 0', () => {
        const r = X.k19FromRows([{ payload: {} }, { payload: {} }], null);
        expect(r).toMatchObject({
            value: null,
            status: 'not_measured',
            insufficientHistory: true,
            leavers: 2,
            measured: 0,
        });
    });

    test('only what was captured counts; the rest is « not measured », apart', () => {
        const r = X.k19FromRows(
            [cap('ready', 1), cap('not_ready'), cap('ready'), { payload: {} }],
            '2026-01-01'
        );
        expect(r).toMatchObject({
            leavers: 4,
            measured: 3,
            unmeasured: 1,
            readyAtDeparture: 2,
            soleHolderAtDeparture: 1,
            value: 2,
            status: null,
        });
    });

    test('the scope reads the site and department CAPTURED at the event', () => {
        const row = { siteId: 9, departmentId: 9, ...cap('ready', 0, 3, 4) };
        expect(X.leaverInScope(row, { siteId: 3 })).toBe(true);
        expect(X.leaverInScope(row, { siteId: 9 })).toBe(false);
        expect(X.leaverInScope(row, { departmentId: 4 })).toBe(true);
        expect(X.leaverInScope(row, { siteId: 'none' })).toBe(false);
        // without a capture, the person's row decides
        expect(X.leaverInScope({ siteId: null, payload: {} }, { siteId: 'none' })).toBe(true);
        expect(X.capabilityOf({ capability: [] })).toBeNull();
        expect(X.capabilityOf({ capability: { readiness: 'ready' } })).toEqual({
            readiness: 'ready',
        });
    });
});

describe('K20 legal safety exposure', () => {
    const people = (site, n) =>
        Array.from({ length: n }, (_, i) => ({
            id: site * 100 + i,
            siteId: site,
            siteName: `Site ${site}`,
        }));

    test('never « compliant » while one person is exposed', () => {
        const covered = people(1, 6);
        expect(X.k20FromCounts(covered, new Set()).status).toBe('compliant');
        const one = X.k20FromCounts(covered, new Set([100]));
        expect(one).toMatchObject({ value: 1, status: 'at_risk' });
    });

    test('a site under 5 people is folded with the other small sites, never named', () => {
        const covered = [...people(1, 6), ...people(2, 2), ...people(3, 1)];
        const r = X.k20FromCounts(covered, new Set([200, 300]));
        expect(r.bySite).toEqual([
            {
                siteId: 1,
                noSite: false,
                siteName: 'Site 1',
                covered: 6,
                exposed: 0,
            },
            { siteId: null, noSite: false, folded: true, siteName: null, covered: 3, exposed: 2 },
        ]);
        expect(JSON.stringify(r)).not.toMatch(/Site 2|Site 3/);
    });
});

describe('K21 key roles exposed', () => {
    const roles = [
        { roleId: 1, familyId: 7, familyName: 'Operations' },
        { roleId: 2, familyId: 7, familyName: 'Operations' },
        { roleId: 3, familyId: null },
    ];
    const holders = [
        { id: 11, roleId: 1 },
        { id: 21, roleId: 2 },
        { id: 31, roleId: 3 },
    ];

    test('a flight risk never reviewed is « not assessed », never « low »', () => {
        const r = X.k21Classify(roles, holders, new Map([[11, 'high']]));
        expect(r).toMatchObject({ exposed: 1, notAssessed: 2, controlled: 0 });
        const low = X.k21Classify(
            roles,
            holders,
            new Map([
                [11, 'low'],
                [21, 'medium'],
                [31, 'low'],
            ])
        );
        expect(low).toMatchObject({ exposed: 0, notAssessed: 0, controlled: 3 });
        expect(r.byFamily[0]).toMatchObject({ familyId: 7, exposed: 1, notAssessed: 1 });
        expect(r.byFamily[1]).toMatchObject({ noFamily: true, familyName: null, notAssessed: 1 });
    });

    test('only the retention-risk clearance reads it', () => {
        expect(X.canSeeFlightRisk({ userType: 'admin', role: 'superadmin' })).toBe(true);
        expect(X.canSeeFlightRisk({ userType: 'manager', role: 'manager' })).toBe(false);
        expect(X.canSeeFlightRisk({ userType: 'admin', role: 'localadmin', permissions: [] })).toBe(
            false
        );
        expect(
            X.canSeeFlightRisk({
                userType: 'admin',
                role: 'localadmin',
                permissions: ['view_retention_risk'],
            })
        ).toBe(true);
    });
});

describe('the contract and the glossary', () => {
    test('registered on the KPI contract with their module, owner and freshness', () => {
        expect(K.CONTRACT_VERSION).toBe('kpi-2');
        expect(K.CONTRACTS.K17).toMatchObject({ module: null, unit: 'days', owner: 'hr_local' });
        expect(K.CONTRACTS.K19).toMatchObject({ module: 'talent', freshness: 'captured' });
        expect(K.CONTRACTS.K20).toMatchObject({ module: null, owner: 'hse' });
        expect(K.CONTRACTS.K21).toMatchObject({ module: 'talent', list: 'continuity' });
        for (const id of ['K17', 'K19', 'K20', 'K21'])
            expect(typeof K.KPI_FUNCTIONS[id]).toBe('function');
        expect(K.isAvailable('K21', { talent: false })).toBe(false);
        expect(K.isAvailable('K17', {})).toBe(true);
    });

    test('FR and EN glossary entries for all four', () => {
        for (const lang of ['fr', 'en']) {
            const L = require(`../../locales/${lang}/kpi.json`);
            for (const k of ['k17', 'k19', 'k20', 'k21'])
                for (const f of ['name', 'def', 'formula', 'den', 'incl', 'bands'])
                    expect([lang, k, f, typeof L[`${k}_${f}`]]).toEqual([lang, k, f, 'string']);
            expect(L.freshness_captured).toBeTruthy();
            expect(L.targets_unit_days).toBeTruthy();
        }
    });
});
