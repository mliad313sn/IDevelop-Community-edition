'use strict';
/**
 * KPI threshold alerts — rules, transitions and message (pure; the database
 * is mocked).
 *   - the bands decide when there is no target; coverage below 50 % reports
 *     « coverage too low » instead of a K1 verdict; fewer than 5 is no alert;
 *   - transitions only: raised on entering a band, worsened only on a new
 *     peak, recovered on leaving it; nothing measured is neither an alert nor
 *     a recovery;
 *   - the mail carries no figure and no name; the figures ride in
 *     payload.figures for the bell; K8 / K9 use the mandatory safety kind;
 *   - the kinds are declared in the catalogue with their category, severity
 *     and module; the locale keys exist in French and English.
 */
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runInSavepoint: (fn) => fn(),
}));
const S = require('../../src/services/KpiAlertService');
const catalogue = require('../../src/services/notificationCatalogue');
const T = require('../../src/utils/emailTemplate');

const k1 = (value, status, n = 20) => ({ kpi: 'K1', value, rawValue: value, status, n });
const k3 = (rawValue, n = 20) => ({ kpi: 'K3', value: rawValue, rawValue, n });
const mail = (m, lang) => m.content(T.blocks(lang));

describe('evalK1', () => {
    test('« At risk » without a target (the bands)', () => {
        expect(S.evalK1(k1(40, 'at_risk'), k3(90), null)).toMatchObject({
            measured: true,
            state: 'at_risk',
            level: 2,
        });
    });
    test('« Watch » without a target is not an alert', () => {
        expect(S.evalK1(k1(70, 'watch'), k3(90), null)).toMatchObject({ state: 'ok', level: 0 });
    });
    test('below a target is below_target; at or above it is ok', () => {
        expect(S.evalK1(k1(70, 'watch'), k3(90), { value: 75 })).toMatchObject({
            state: 'below_target',
            level: 1,
            target: 75,
        });
        expect(S.evalK1(k1(75, 'watch'), k3(90), { value: 75 })).toMatchObject({ level: 0 });
    });
    test('coverage below 50 % reports « coverage too low » instead of any K1 verdict', () => {
        expect(S.evalK1(k1(20, 'at_risk'), k3(42), { value: 80 })).toMatchObject({
            state: 'coverage_low',
            level: 1,
            value: 42,
        });
    });
    test('fewer than 5 people, nothing measured: no evaluation', () => {
        expect(S.evalK1(k1(null, 'small_n', 3), k3(90), null)).toEqual({ measured: false });
        expect(S.evalK1(k1(30, 'at_risk', 4), k3(90), null)).toEqual({ measured: false });
        expect(S.evalK1({ emptyScope: true, value: null }, null, null)).toEqual({
            measured: false,
        });
    });
});

describe('other rules', () => {
    test('K6 rises above its target (0 by default); the level is the count', () => {
        expect(S.evalK6({ value: 2, n: 30 }, null)).toMatchObject({ state: 'rising', level: 2 });
        expect(S.evalK6({ value: 2, n: 30 }, { value: 2 })).toMatchObject({ level: 0 });
        expect(S.evalK6({ value: 0, n: 30 }, null)).toMatchObject({ level: 0 });
        expect(S.evalK6({ value: null, n: 0, status: 'not_configured' }, null)).toEqual({
            measured: false,
        });
    });
    test('K8: people with an expired required certificate; not configured is not « 0 »', () => {
        expect(
            S.evalK8({ value: 5, status: 'at_risk', breakdown: { expiredPeople: 3 } })
        ).toMatchObject({ state: 'expired', level: 3 });
        expect(
            S.evalK8({ value: 0, status: 'compliant', breakdown: { expiredPeople: 0 } })
        ).toMatchObject({ level: 0 });
        expect(S.evalK8({ value: null, status: 'not_configured' })).toEqual({ measured: false });
    });
    test('K9 below 100 %: watch 1, at risk 2, 100 ok, not configured nothing', () => {
        expect(S.evalK9({ value: 97, n: 20, status: 'watch' })).toMatchObject({ level: 1 });
        expect(S.evalK9({ value: 80, n: 20, status: 'at_risk' })).toMatchObject({ level: 2 });
        expect(S.evalK9({ value: 100, n: 20, status: 'compliant' })).toMatchObject({ level: 0 });
        expect(S.evalK9({ value: null, n: 0, status: 'not_configured' })).toEqual({
            measured: false,
        });
        expect(S.evalK9({ value: 75, n: 4, status: 'small_n' })).toEqual({ measured: false });
    });
    test('K11: a campaign « At risk » is late', () => {
        expect(S.evalK11({ value: 10, n: 30, status: 'at_risk', elapsedPct: 60 })).toMatchObject({
            state: 'late',
            level: 1,
        });
        expect(S.evalK11({ value: 50, n: 30, status: 'watch' })).toMatchObject({ level: 0 });
        expect(S.evalK11({ value: null, n: 3, status: 'small_n' })).toEqual({ measured: false });
    });
    test('module-aware: K6 only with talent, K11 only with campaigns', () => {
        expect(S.ruleKpis({})).toEqual(['K1', 'K3', 'K8', 'K9']);
        expect(S.ruleKpis({ talent: true, campaigns: true })).toEqual([
            'K1',
            'K3',
            'K6',
            'K8',
            'K9',
            'K11',
        ]);
    });
});

describe('transition', () => {
    const at = (level, peakLevel = level) => ({ level, peakLevel, state: 'x' });
    const ev = (level) => ({ measured: true, state: level ? 'at_risk' : 'ok', level });
    test('entering a band raises, the first observation included', () => {
        expect(S.transition(null, ev(2)).transition).toBe('raised');
        expect(S.transition(at(0), ev(1)).transition).toBe('raised');
    });
    test('staying in the band sends nothing', () => {
        expect(S.transition(at(2), ev(2)).transition).toBeNull();
        expect(S.transition(at(0), ev(0)).transition).toBeNull();
    });
    test('a new peak re-raises; a movement below the peak does not', () => {
        expect(S.transition(at(1), ev(2))).toMatchObject({ transition: 'worsened', peakLevel: 2 });
        expect(S.transition(at(1, 3), ev(2))).toMatchObject({ transition: null, peakLevel: 3 });
        expect(S.transition(at(2, 3), ev(3))).toMatchObject({ transition: null, peakLevel: 3 });
    });
    test('leaving the band is recovered; nothing measured is never a recovery', () => {
        expect(S.transition(at(2), ev(0))).toMatchObject({ transition: 'recovered', peakLevel: 0 });
        expect(S.transition(at(2), { measured: false })).toMatchObject({
            transition: null,
            persist: false,
        });
    });
});

describe('message', () => {
    const base = {
        id: 7,
        ruleKey: 'K1',
        kpiId: 'K1',
        scopeType: 'site',
        scopeId: 3,
        transition: 'raised',
        toState: 'below_target',
        value: 61.5,
        target: 75,
    };
    test('the figures ride in payload.figures; none in the mail, in French or English', () => {
        const m = S.message(base, 'Harbour View', 12);
        expect(m.kind).toBe('kpi.alert');
        expect(m.payload.figures).toEqual({ kpi: 'K1', value: 61.5, target: 75, unit: 'pct' });
        expect(m.payload.link).toBe('/dashboard?site=3');
        for (const lang of ['fr', 'en']) {
            const c = mail(m, lang);
            const text = [c.intro, ...c.blocks.map((b) => b.text), c.ctaLabel].join(' ');
            expect(text).not.toMatch(/\d/);
            expect(c.intro).toContain('Harbour View');
        }
        expect(mail(m, 'en').intro).toMatch(/below its target/);
        expect(mail(m, 'fr').intro).toMatch(/sous sa cible/);
    });
    test('K8 / K9 use the mandatory safety kind; a recovery uses kpi.recovered', () => {
        const s = S.message({ ...base, kpiId: 'K9', ruleKey: 'K9', toState: 'at_risk' }, 'X', 1);
        expect(s.kind).toBe('safety.kpi_alert');
        expect(catalogue.isMandatory('safety.kpi_alert')).toBe(true);
        expect(catalogue.categoryOf('safety.kpi_alert')).toBe('safety');
        const r = S.message({ ...base, transition: 'recovered', toState: 'ok' }, 'X', 1);
        expect(r.kind).toBe('kpi.recovered');
        expect(mail(r, 'fr').intro).toMatch(/revenu à la normale/);
        expect(mail(r, 'en').intro).toMatch(/back to normal/);
    });
    test('coverage guard: the bell figure is K3', () => {
        const m = S.message({ ...base, toState: 'coverage_low', value: 42 }, 'X', 1);
        expect(m.payload.figures).toMatchObject({ kpi: 'K3', value: 42, target: null });
        expect(catalogue.subtitleOf(m.kind, m.payload, 'en')).toMatch(/assessment coverage/);
    });
    test('the subject is neutral: no digit, no site, no name, FR and EN', () => {
        for (const kind of S.KINDS)
            for (const lang of ['fr', 'en']) {
                const subj = catalogue.subjectOf(kind, lang);
                expect(subj).toBeTruthy();
                expect(subj).not.toMatch(/\d/);
                expect(subj.length).toBeLessThanOrEqual(60);
            }
    });
    test('the subtitle refuses a kpi id that is not one', () => {
        expect(catalogue.subtitleOf('kpi.alert', { kpi: 'Alex Example' }, 'fr')).toBeNull();
        expect(catalogue.subtitleOf('kpi.alert', { kpi: 'K1', state: 'at_risk' }, 'en')).toMatch(
            /Role-ready rate/
        );
    });
    test('worsened prefixes the sentence', () => {
        expect(
            S.sentence('en', { ...base, transition: 'worsened', toState: 'at_risk' }, 'X')
        ).toMatch(/^It is getting worse:/);
    });
});

describe('catalogue', () => {
    test('tiers, severity, category, module; every kind titled FR and EN', () => {
        expect(catalogue.tierOf('kpi.alert')).toBe('digest');
        expect(catalogue.tierOf('kpi.recovered')).toBe('digest');
        expect(catalogue.tierOf('safety.kpi_alert')).toBe('immediate');
        expect(catalogue.isMandatory('kpi.alert')).toBe(false);
        expect(catalogue.severityOf('safety.kpi_alert')).toBe('critique');
        expect(catalogue.severityOf('kpi.alert')).toBe('action');
        expect(catalogue.categoryOf('kpi.alert')).toBe('reports');
        for (const k of S.KINDS) {
            const d = catalogue.describe(k);
            expect(d).not.toBeNull();
            expect(d.module).toBeNull();
            expect(d.webhook).toBe('never');
            expect(d.title.fr).toBeTruthy();
            expect(d.title.en).toBeTruthy();
            expect(catalogue.KIND_MESSAGES[k].fr).toBeTruthy();
            expect(catalogue.KIND_MESSAGES[k].en).toBeTruthy();
        }
    });
    test('the alert keys exist in French and English', () => {
        const fr = require('../../locales/fr/kpi.json');
        const en = require('../../locales/en/kpi.json');
        const a = (o) =>
            Object.keys(o).filter((k) => k.startsWith('alert_') || k.startsWith('targets_'));
        expect(a(fr).sort()).toEqual(a(en).sort());
        for (const s of [
            'k1_at_risk',
            'k1_below_target',
            'k1_coverage_low',
            'k6_rising',
            'k8_expired',
            'k9_watch',
            'k9_at_risk',
            'k11_late',
        ])
            expect(fr['alert_' + s] && en['alert_' + s]).toBeTruthy();
    });
});
