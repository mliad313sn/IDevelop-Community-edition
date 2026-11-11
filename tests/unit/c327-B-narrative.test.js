'use strict';
/**
 * « What changed » (NarrativeService) against a snapshot double: fixed
 * sentences from same-contract movements, thresholds, never « +0 », small-n
 * suppression, « History starts on … », NULL never 0, at most 3 sentences in a
 * fixed order, capability- and module-aware, the viewer's clearance.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockSnap = { latest: null, prior: null, first: null, calls: [] };
jest.mock('../../src/services/KpiSnapshotService', () => ({
    currentContract: () => 'kpi-1',
    latest: jest.fn(async (...a) => {
        mockSnap.calls.push(['latest', ...a]);
        return mockSnap.latest;
    }),
    priorTo: jest.fn(async (...a) => {
        mockSnap.calls.push(['priorTo', ...a]);
        return mockSnap.prior;
    }),
    firstDate: jest.fn(async () => mockSnap.first),
}));
const mockPop = { mine: null, all: null };
jest.mock('../../src/services/KpiService', () => ({
    resolvePopulation: jest.fn(async (s) => (s && s.system ? mockPop.all : mockPop.mine)),
}));
jest.mock('../../src/config/database', () => ({ all: jest.fn(), get: jest.fn(), run: jest.fn() }));

const N = require('../../src/services/NarrativeService');

const ALL_CAPS = { pop: true, safety: true, continuity: true };
const TALENT = { talent: true };
const href = (kpi, part) => `/dashboard/list?kpi=${kpi}&part=${part}`;

function row(over) {
    return {
        date: '2026-10-03',
        totalEmployees: 80,
        roleReadyCount: 36,
        notReadyCount: 21, // K1 = 36 / 57 = 63.2 %
        assessmentCoverage: 64.2,
        safetyFitPct: 96,
        safetyFitN: 25,
        certsExpired: 4,
        certsExpiring90d: 7,
        criticalUnassessed: 120,
        soleHolderCount: 3,
        criticalRolesWithoutReady: 2,
        kpiContract: 'kpi-1',
        ...over,
    };
}

beforeEach(() => {
    mockSnap.latest = null;
    mockSnap.prior = null;
    mockSnap.first = null;
    mockSnap.calls.length = 0;
});

describe('history states', () => {
    test('no snapshot at all: no_history, no line, no sentence', async () => {
        const r = await N.whatChanged({ type: 'org' }, { days: 7 });
        expect(r.state).toBe('no_history');
        expect(r.line).toBeNull();
        expect(r.sentences).toEqual([]);
    });
    test('no prior: « History starts on », with the date of the first comparison, never a movement', async () => {
        mockSnap.latest = row();
        mockSnap.first = '2026-09-29';
        const r = await N.whatChanged({ type: 'site', id: 3 }, { days: 7, locale: 'en' });
        expect(r.state).toBe('history_start');
        expect(r.line).toBe(
            'History starts on 29/09/2026: the first comparison will be possible on 06/10/2026.'
        );
        expect(r.sentences).toEqual([]);
        const fr = await N.whatChanged({ type: 'site', id: 3 }, { days: 7 });
        expect(fr.line).toMatch(/^L'historique commence le 29\/09\/2026/);
    });
    test('same contract only, the prior relative to the latest row', async () => {
        mockSnap.latest = row();
        mockSnap.prior = row({ date: '2026-09-26' });
        await N.whatChanged({ type: 'department', id: 9 }, { days: 7 });
        expect(mockSnap.calls[0]).toEqual(['latest', 'department', 9, 'kpi-1']);
        expect(mockSnap.calls[1]).toEqual(['priorTo', 'department', 9, '2026-10-03', 7, 'kpi-1']);
    });
});

describe('sentences', () => {
    test('K1: value, signed movement in points, n; FR and EN; linked to its list', async () => {
        mockSnap.latest = row();
        mockSnap.prior = row({ date: '2026-09-26', roleReadyCount: 34, notReadyCount: 23 }); // 59.6 %
        const r = await N.whatChanged({ type: 'org' }, { days: 7, hrefOf: href, locale: 'en' });
        expect(r.state).toBe('changes');
        expect(r.sentences[0]).toMatchObject({
            kpi: 'K1',
            polarity: 'better',
            href: '/dashboard/list?kpi=K1&part=not_ready',
        });
        expect(r.sentences[0].text).toBe(
            'Role-ready rate: 63% (+4 pts), over 57 people with a verdict.'
        );
        expect(r.line).toBe('Since 26/09/2026:');
        const fr = await N.whatChanged({ type: 'org' }, { days: 7 });
        expect(fr.sentences[0].text).toBe(
            'Taux de prêts au poste : 63 % (+4 pts), sur 57 personnes ayant un verdict.'
        );
        expect(fr.sentences[0].href).toBeNull(); // no list link for a reader without one
    });
    test('a decrease carries a true minus and is « worse »; a safety % is rounded down', async () => {
        mockSnap.latest = row({ safetyFitPct: 94.6 });
        mockSnap.prior = row({ date: '2026-09-26', safetyFitPct: 96.6 });
        const r = await N.whatChanged(
            { type: 'site', id: 4 },
            { days: 7, capabilities: ALL_CAPS, locale: 'en' }
        );
        const k9 = r.sentences.find((s) => s.kpi === 'K9');
        expect(k9.text).toBe('Safety fitness: 94% (−2 pts), over 25 people on safety-gated roles.');
        expect(k9.polarity).toBe('worse');
    });
    test('counts: fewer expired certificates is « better », plural agreement', async () => {
        mockSnap.latest = row({ certsExpired: 1 });
        mockSnap.prior = row({ date: '2026-09-26', certsExpired: 4 });
        const r = await N.whatChanged(
            { type: 'department', id: 7 },
            { days: 7, capabilities: ALL_CAPS, locale: 'en' }
        );
        const s = r.sentences.find((x) => x.kpi === 'K8x');
        expect(s.text).toBe('1 person has a required certificate expired (−3).');
        expect(s.polarity).toBe('better');
    });
    test('never « +0 »: an unchanged value is no sentence', async () => {
        mockSnap.latest = row();
        mockSnap.prior = row({ date: '2026-09-26' });
        const r = await N.whatChanged({ type: 'org' }, { days: 7, capabilities: ALL_CAPS });
        expect(r.state).toBe('no_change');
        expect(r.sentences).toEqual([]);
        expect(r.line).toBe('Aucun changement notable depuis le 26/09/2026.');
        expect(JSON.stringify(r)).not.toMatch(/\+0|−0/);
    });
    test('below the threshold (K1 < 1 pt, K3 < 2 pts) there is no sentence', async () => {
        mockSnap.latest = row({ assessmentCoverage: 65.9 });
        mockSnap.prior = row({ date: '2026-09-26', assessmentCoverage: 64.2 });
        const r = await N.whatChanged({ type: 'org' }, { days: 7 });
        expect(r.sentences).toEqual([]);
    });
    test('a NULL side is never read as 0', async () => {
        mockSnap.latest = row({ safetyFitPct: 90 });
        mockSnap.prior = row({ date: '2026-09-26', safetyFitPct: null });
        const r = await N.whatChanged({ type: 'org' }, { days: 7, capabilities: ALL_CAPS });
        expect(r.sentences.find((s) => s.kpi === 'K9')).toBeUndefined();
    });
    test('small n: a % over fewer than 5 is suppressed; an unknown n too', async () => {
        mockSnap.latest = row({ safetyFitPct: 75, safetyFitN: 4 });
        mockSnap.prior = row({ date: '2026-09-26', safetyFitPct: 100, safetyFitN: 4 });
        let r = await N.whatChanged({ type: 'org' }, { days: 7, capabilities: ALL_CAPS });
        expect(r.sentences.find((s) => s.kpi === 'K9')).toBeUndefined();
        mockSnap.latest = row({ safetyFitPct: 75, safetyFitN: 40 });
        mockSnap.prior = row({ date: '2026-09-26', safetyFitPct: 100, safetyFitN: null });
        r = await N.whatChanged({ type: 'org' }, { days: 7, capabilities: ALL_CAPS });
        expect(r.sentences.find((s) => s.kpi === 'K9')).toBeUndefined();
    });
    test('a scope of fewer than 5 people says nothing but that', async () => {
        mockSnap.latest = row({ totalEmployees: 4, certsExpired: 3 });
        mockSnap.prior = row({ date: '2026-09-26', totalEmployees: 4, certsExpired: 0 });
        const r = await N.whatChanged({ type: 'department', id: 2 }, { days: 7, locale: 'en' });
        expect(r.state).toBe('small_n');
        expect(r.sentences).toEqual([]);
        expect(r.line).toBe('Fewer than 5 people in this scope: no comparison.');
    });
    test('at most 3 sentences, in the fixed order (not by size)', async () => {
        mockSnap.latest = row({
            roleReadyCount: 40,
            safetyFitPct: 80,
            certsExpired: 10,
            soleHolderCount: 9,
        });
        mockSnap.prior = row({ date: '2026-09-02', assessmentCoverage: 50 });
        const r = await N.whatChanged(
            { type: 'org' },
            { days: 30, capabilities: ALL_CAPS, flags: TALENT }
        );
        expect(r.sentences.map((s) => s.kpi)).toEqual(['K1', 'K9', 'K3']);
    });
});

describe('capabilities and modules', () => {
    beforeEach(() => {
        mockSnap.latest = row({
            safetyFitPct: 80,
            criticalRolesWithoutReady: 5,
            soleHolderCount: 9,
        });
        mockSnap.prior = row({ date: '2026-09-26' });
    });
    test('without the safety capability, no safety sentence', async () => {
        const r = await N.whatChanged({ type: 'org' }, { days: 7, capabilities: { pop: true } });
        expect(r.sentences.map((s) => s.kpi)).not.toContain('K9');
    });
    test('the talent module off: no succession sentence, never « not measured »', async () => {
        const off = await N.whatChanged(
            { type: 'org' },
            { days: 7, capabilities: { pop: true, continuity: true }, flags: {} }
        );
        expect(off.sentences.map((s) => s.kpi)).toEqual([]);
        expect(JSON.stringify(off)).not.toMatch(/not measured|non mesuré/i);
        const on = await N.whatChanged(
            { type: 'org' },
            { days: 7, capabilities: { pop: true, continuity: true }, flags: TALENT }
        );
        expect(on.sentences.map((s) => s.kpi)).toEqual(['K6', 'K7']);
    });
    test('orderFor follows the capability set and the modules', () => {
        expect(N.orderFor({})).toEqual(['K1', 'K3']);
        expect(N.orderFor({ capabilities: ALL_CAPS, flags: TALENT })).toEqual(N.ORDER);
    });
});

describe('the viewer clearance', () => {
    const pop = (n) => ({ ids: Array.from({ length: n }, (_, i) => i + 1), rows: [] });
    test('a unit the viewer sees only partly is never read', async () => {
        mockPop.mine = pop(10);
        mockPop.all = pop(12);
        mockSnap.latest = row();
        const r = await N.forViewer({ userType: 'admin', id: 2 }, { siteId: 3 });
        expect(r.state).toBe('not_available');
        expect(mockSnap.calls).toEqual([]);
    });
    test('a unit fully inside the clearance is read as that unit', async () => {
        mockPop.mine = pop(12);
        mockPop.all = pop(12);
        expect(await N.snapshotScopeFor({ userType: 'admin', id: 2 }, { departmentId: 5 })).toEqual(
            { type: 'department', id: 5 }
        );
        expect(await N.snapshotScopeFor({ userType: 'admin', id: 2 }, {})).toEqual({
            type: 'org',
            id: 0,
        });
        expect(
            await N.snapshotScopeFor({ userType: 'admin', id: 2 }, { siteId: 'none' })
        ).toBeNull();
        expect(
            await N.snapshotScopeFor({ userType: 'admin', id: 2 }, { siteId: 1, departmentId: 2 })
        ).toBeNull();
    });
});

describe('templates', () => {
    test('every nar_ key exists in French and English', () => {
        const fr = require('../../locales/fr/dash.json');
        const en = require('../../locales/en/dash.json');
        const k = (o) => Object.keys(o).filter((x) => x.startsWith('nar_') || x.startsWith('dg_'));
        expect(k(fr).sort()).toEqual(k(en).sort());
    });
    test('no template can carry a person: the only variables are figures, dates and a unit label', () => {
        for (const lang of ['fr', 'en']) {
            const d = require(`../../locales/${lang}/dash.json`);
            for (const [key, v] of Object.entries(d)) {
                if (!key.startsWith('nar_')) continue;
                const vars = [...String(v).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
                for (const x of vars)
                    expect([key, x]).toEqual([
                        key,
                        expect.stringMatching(
                            /^(value|delta|n|count|countText|date|next|label|text|code|validated|invited|action)$/
                        ),
                    ]);
            }
        }
    });
});
