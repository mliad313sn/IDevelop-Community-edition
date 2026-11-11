'use strict';
/**
 * Pure parts of the KPI module: the shared predicates (active plan, overdue,
 * certification windows, current campaign), the status bands, the four-state
 * readiness rule, the result rules (small n, unmeasured, the safety floor),
 * the K12 band and the K14 replay. No database (src/config/database mocked).
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const P = require('../../src/utils/kpiPredicates');
const K = require('../../src/services/KpiService');

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
});

describe('one "active" predicate for performance, development and coaching plans', () => {
    test.each([
        ['active', true],
        ['proposed', false], // a silent proposal is a draft
        ['approved', true],
        ['draft', false],
        ['completed', false],
        ['closed_success', false],
        ['closed_failure', false],
        ['cancelled', false],
        ['withdrawn', false],
        ['rejected', false],
        ['archived', false],
        ['closed_some_later_outcome', false],
        [null, false],
        ['', false],
    ])('%s → %s', (state, want) => expect(P.isPlanActive(state)).toBe(want));

    test('overdue = active AND due date strictly before today; no due date is never overdue', () => {
        expect(P.isPlanOverdue('active', '2026-10-01', '2026-10-02')).toBe(true);
        expect(P.isPlanOverdue('active', '2026-10-02', '2026-10-02')).toBe(false);
        expect(P.isPlanOverdue('completed', '2026-01-01', '2026-10-02')).toBe(false);
        expect(P.isPlanOverdue('active', null, '2026-10-02')).toBe(false);
    });
});

describe('certification windows', () => {
    const T = '2026-10-02';
    test('expired / within 90 days (inclusive) / valid / no expiry', () => {
        expect(P.certWindow('2026-10-01', T)).toBe('expired');
        expect(P.certWindow('2026-10-02', T)).toBe('within_90d');
        expect(P.certWindow('2026-12-31', T)).toBe('within_90d'); // today + 90
        expect(P.certWindow('2027-01-01', T)).toBe('valid');
        expect(P.certWindow(null, T)).toBeNull();
    });
    test('"within 30 days" is a SUB-SET of the 90-day window', () => {
        expect(P.certWithin30('2026-11-01', T)).toBe(true);
        expect(P.certWithin30('2026-11-02', T)).toBe(false);
        expect(P.certWithin30('2026-10-01', T)).toBe(false);
    });
});

describe('current campaign', () => {
    const T = '2026-10-02';
    const cur = (c) => P._internal.isCurrentCampaign(c, T);
    test('open AND its window contains today; locked is current until closed', () => {
        expect(cur({ status: 'open', openedAt: '2026-09-01', closesAt: '2026-10-30' })).toBe(true);
        expect(cur({ status: 'open', openedAt: '2026-10-05', closesAt: '2026-10-30' })).toBe(false);
        expect(cur({ status: 'open', openedAt: '2026-09-01', closesAt: '2026-10-01' })).toBe(false);
        expect(cur({ status: 'closed', openedAt: '2026-09-01', closesAt: '2026-10-30' })).toBe(
            false
        );
        expect(cur({ status: 'locked', openedAt: '2026-06-01', closesAt: '2026-08-31' })).toBe(
            true
        );
    });
    test('currentCampaigns() keeps every current campaign separately', async () => {
        mockDb.all.mockResolvedValueOnce([
            { id: 1, code: 'A', status: 'open', openedAt: '2000-01-01', closesAt: '2999-01-01' },
            { id: 2, code: 'B', status: 'open', openedAt: '2000-01-01', closesAt: '2999-01-01' },
            { id: 3, code: 'C', status: 'open', openedAt: '2000-01-01', closesAt: '2001-01-01' },
        ]);
        const list = await P.currentCampaigns();
        expect(list.map((c) => c.id)).toEqual([1, 2]);
    });
});

describe('bands from one source', () => {
    test('readiness bands follow the threshold; null never gets a colour', () => {
        expect(P.statusBand(80, 'K1', { threshold: 80 })).toBe('compliant');
        expect(P.statusBand(79.9, 'K1', { threshold: 80 })).toBe('watch');
        expect(P.statusBand(49.9, 'K1', { threshold: 80 })).toBe('at_risk');
        expect(P.statusBand(70, 'K1', { threshold: 60 })).toBe('compliant');
        expect(P.statusBand(null, 'K1')).toBeNull();
        expect(P.statusBand(undefined, 'K4')).toBeNull();
        expect(P.statusBand(50, 'K13')).toBeNull(); // informational
    });
    test('K3 below 50 is amber, never red', () => {
        expect(P.statusBand(10, 'K3', { threshold: 80 })).toBe('watch');
    });
    test('safety and critical bands 100 / 95; counts', () => {
        expect(P.statusBand(100, 'K4')).toBe('compliant');
        expect(P.statusBand(95, 'K9')).toBe('watch');
        expect(P.statusBand(94.9, 'K9')).toBe('at_risk');
        expect(P.statusBand(0, 'K8')).toBe('compliant');
        expect(P.statusBand(1, 'K8')).toBe('at_risk');
        expect(P.statusBand(3, 'K7')).toBe('watch');
        expect(P.statusBand(4, 'K7')).toBe('at_risk');
        expect(P.statusBand(2, 'K6')).toBe('watch');
        expect(P.statusBand(3, 'K6')).toBe('at_risk');
        expect(P.statusBand(5, 'K16')).toBe('watch');
    });
    test('K11 time-aware band', () => {
        expect(P.campaignBand(50, 50)).toBe('compliant');
        expect(P.campaignBand(35, 50)).toBe('watch');
        expect(P.campaignBand(29.9, 50)).toBe('at_risk');
        expect(P.campaignBand(null, 50)).toBeNull();
    });
    test('K12 band on |mean gap|: 0.3 / 0.7; null stays null', () => {
        expect(P.k12Band(0.3)).toBe('compliant');
        expect(P.k12Band(-0.5)).toBe('watch');
        expect(P.k12Band(0.71)).toBe('at_risk');
        expect(P.k12Band(null)).toBeNull();
    });
    test('codes are English; every code has a label key', () => {
        expect(Object.values(P.STATUS)).toEqual([
            'compliant',
            'watch',
            'at_risk',
            'not_measured',
            'not_configured',
            'small_n',
        ]);
        for (const s of Object.values(P.STATUS)) expect(P.VOCAB.status[s]).toMatch(/^kpi:/);
        for (const s of P.READINESS_STATES) expect(P.VOCAB.readiness[s]).toMatch(/^kpi:/);
    });
});

describe('the four-state readiness of one person', () => {
    const f = (o) => ({
        totalReq: 4,
        assessed: 4,
        ptsGained: 8,
        ptsReq: 8,
        ptsGainedAssessed: 8,
        ptsReqAssessed: 8,
        critTotal: 1,
        critAssessed: 1,
        critMet: 1,
        ...o,
    });
    test('ready needs every requirement assessed + the threshold + every critical met', () => {
        expect(K.classifyReadiness(f({}), 80).state).toBe('ready');
    });
    test('fully assessed below the threshold → not_ready', () => {
        expect(K.classifyReadiness(f({ ptsGained: 6, ptsGainedAssessed: 6 }), 80).state).toBe(
            'not_ready'
        );
    });
    test('a known critical fail is not_ready even when partial', () => {
        expect(K.classifyReadiness(f({ assessed: 1, critMet: 0 }), 80).state).toBe('not_ready');
    });
    test('never assessed is not_assessed — never not_ready', () => {
        const r = K.classifyReadiness(
            f({
                assessed: 0,
                critAssessed: 0,
                critMet: 0,
                ptsGained: 0,
                ptsGainedAssessed: 0,
                ptsReqAssessed: 0,
            }),
            80
        );
        expect(r.state).toBe('not_assessed');
        expect(r.readinessAssessed).toBeNull();
    });
    test('some evidence, no verdict → partial', () => {
        expect(K.classifyReadiness(f({ assessed: 2, critAssessed: 0, critMet: 0 }), 80).state).toBe(
            'partial'
        );
    });
    test('no requirement → no_requirement (outside every denominator)', () => {
        expect(K.classifyReadiness(null, 80).state).toBe('no_requirement');
        expect(K.classifyReadiness(f({ totalReq: 0 }), 80).state).toBe('no_requirement');
    });
    test('a scope without a reader is refused (no silent unrestricted read)', async () => {
        await expect(K.resolvePopulation({})).rejects.toThrow(/viewer/);
    });
});

describe('result rules', () => {
    test('denominator 0 → null + not_measured; small n → null + small_n with the counts', () => {
        expect(K.pctResult('K1', 0, 0, 0)).toMatchObject({
            value: null,
            status: 'not_measured',
        });
        expect(K.pctResult('K1', 1, 2, 2, { threshold: 80 })).toMatchObject({
            value: null,
            rawValue: 50,
            numerator: 1,
            denominator: 2,
            status: 'small_n',
        });
    });
    test('a safety % rounds DOWN and is never compliant while one falls short', () => {
        const r = K.pctResult('K9', 1999, 2000, 2000);
        expect(r.value).toBe(99.9);
        expect(r.status).toBe('watch');
        expect(K.pctResult('K9', 20, 20, 20).status).toBe('compliant');
        // the same counts on a non-safety indicator round half up
        expect(K.pctResult('K1', 1999, 2000, 2000, { threshold: 80 }).value).toBe(100);
    });
    test('overdue status of a volume: null with nothing late, watch, at risk above 10 %', () => {
        expect(K.overdueStatus(0, 10)).toBeNull();
        expect(K.overdueStatus(1, 10)).toBe('watch');
        expect(K.overdueStatus(2, 10)).toBe('at_risk');
        expect(K.overdueStatus(1, null)).toBeNull();
    });
    test('an unknown indicator is refused', async () => {
        await expect(K.compute('K10', { system: true })).rejects.toThrow(/unknown KPI/);
        await expect(K.bySite('__proto__', { system: true })).rejects.toThrow(/unknown KPI/);
    });
});

describe('K14 replay (pure)', () => {
    const reqs = [
        { skillId: 1, required: 2, critical: true },
        { skillId: 2, required: 2, critical: false },
    ];
    const start = Date.parse('2026-01-01T00:00:00Z');
    test('ready already at role start gives the start day', () => {
        const ev = [
            { skillId: 1, level: 2, at: '2025-06-01' },
            { skillId: 2, level: 2, at: '2025-06-01' },
        ];
        expect(K.firstReadyDay(reqs, ev, start, 80)).toBe(start);
    });
    test('later: the day the last requirement is met; never: null', () => {
        const ev = [
            { skillId: 1, level: 2, at: '2026-01-10' },
            { skillId: 2, level: 1, at: '2026-01-20' },
            { skillId: 2, level: 2, at: '2026-02-15' },
        ];
        expect(K.firstReadyDay(reqs, ev, start, 80)).toBe(Date.parse('2026-02-15T00:00:00Z'));
        expect(K.firstReadyDay(reqs, ev.slice(0, 2), start, 80)).toBeNull();
        expect(K.firstReadyDay([], ev, start, 80)).toBeNull();
    });
    test('without employees.role_start_date K14 is not measured (no imputed start date)', async () => {
        mockDb.all.mockResolvedValueOnce([{ id: 1, siteId: 1, roleId: 1 }]); // population
        mockDb.get.mockResolvedValueOnce(undefined); // the column does not exist
        const r = await K.k14TimeToCompetence({ system: true });
        expect(r.status).toBe('not_measured');
        expect(r.notCaptured).toBe(true);
        expect(r.value).toBeNull();
    });
});
