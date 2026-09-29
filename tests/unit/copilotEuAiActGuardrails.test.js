'use strict';
/**
 * EU AI Act guardrails for the talent copilot (employment = high-risk domain):
 *  (a) every answer carries a "decision support only" disclaimer;
 *  (b) ranking / naming individual people is OFF by default
 *      (copilot.allow_named_person_ranking) — aggregates instead, and the named
 *      lists never reach an LLM;
 *  (c) presets carry region / euHosted, and copilot.eu_only_providers (default
 *      ON) refuses non-EU presets; no preset defaults to a free-tier model;
 *  (d) the audit record carries the human-oversight acknowledgement.
 */
const fs = require('fs');
const path = require('path');

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = { findByKey: jest.fn(), getValue: jest.fn() };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const mockRbac = { getFilteredEmployees: jest.fn() };
jest.mock('../../src/services/RBACService', () => mockRbac);

const mockLog = { log: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../src/services/LogService', () => mockLog);
jest.mock('../../src/utils/branding', () => ({ getBranding: jest.fn().mockResolvedValue(null) }));

const Copilot = require('../../src/services/CopilotService');

const ROOT = path.resolve(__dirname, '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

function wire(map = {}) {
    mockSettings.findByKey.mockResolvedValue(
        'copilotProvider' in map ? { settingKey: 'copilotProvider' } : null
    );
    mockSettings.getValue.mockImplementation(async (key, fb) => (key in map ? map[key] : fb));
    mockRbac.getFilteredEmployees.mockResolvedValue([
        { id: 1, firstName: 'Ada', lastName: 'LOVELACE' },
        { id: 2, firstName: 'Alan', lastName: 'TURING' },
    ]);
    mockDb.all.mockImplementation(async (sql) => {
        const s = String(sql);
        if (/readiness_assessed_only AS pct/.test(s))
            return [
                { fullName: 'Ada LOVELACE', pct: 30, assessed: 3, expected: 10, coverage: 30 },
                { fullName: 'Alan TURING', pct: 90, assessed: 9, expected: 10, coverage: 90 },
            ];
        if (/GROUP BY flight_risk/.test(s)) return [{ flightRisk: 'high', n: 1 }];
        if (/rr\.flight_risk = 'high'/.test(s)) return [{ name: 'Ada LOVELACE' }];
        if (/FROM pips p JOIN employees/.test(s)) return [{ name: 'Alan TURING', state: 'active' }];
        if (/COUNT\(\*\) AS n FROM pips/.test(s)) return [{ n: 1 }];
        if (/AS shortfall/.test(s)) return [{ skill: 'Blasting', shortfall: 2, unmeasured: 0 }];
        return [];
    });
}

function copilotAudits() {
    return mockLog.log.mock.calls.map(([e]) => e).filter((e) => /^COPILOT_QUERY/.test(e.action));
}
const meta = (e) => JSON.parse(e.details.slice(e.details.indexOf('{')));

beforeEach(() => {
    mockSettings.findByKey.mockReset();
    mockSettings.getValue.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockLog.log.mockReset().mockResolvedValue(undefined);
    Copilot.invalidate();
});

describe('(a) transparency label', () => {
    test('every answer carries the disclaimer and its i18n key', async () => {
        wire();
        const out = await Copilot.ask({ id: 5, userType: 'manager' }, 'readiness by site');
        expect(out.disclaimer).toBe(
            'AI-generated — decision support only; a person makes the decision.'
        );
        expect(out.disclaimerKey).toBe('talentx:cap_ai_disclaimer');
    });

    test('LLM and fallback answers carry it too', async () => {
        wire({ copilotProvider: 'ollama', copilotUrl: '', copilotModel: 'llama3.1' });
        const spy = jest.spyOn(Copilot, '_callLlm').mockResolvedValue('ok');
        const spyInt = jest.spyOn(Copilot, '_isInternalTarget').mockResolvedValue(true);
        try {
            const a = await Copilot.ask({ id: 5, userType: 'manager' }, 'hello');
            expect(a.mode).toBe('llm');
            expect(a.disclaimer).toMatch(/decision support only/);
            spy.mockRejectedValue(new Error('down'));
            const b = await Copilot.ask({ id: 5, userType: 'manager' }, 'hello');
            expect(b.mode).toBe('fallback');
            expect(b.disclaimer).toMatch(/decision support only/);
        } finally {
            spy.mockRestore();
            spyInt.mockRestore();
        }
    });

    test('the label exists in both locales and the UI shows it', () => {
        expect(readJson('locales/en/talentx.json').cap_ai_disclaimer).toMatch(
            /AI-generated — decision support only; a person makes the decision/
        );
        expect(readJson('locales/fr/talentx.json').cap_ai_disclaimer).toMatch(/Généré par IA/);
        const view = fs.readFileSync(path.join(ROOT, 'views/pages/capability/index.ejs'), 'utf8');
        expect(view).toContain("__('talentx:cap_ai_disclaimer')");
        expect(view).toMatch(/j\.disclaimer \|\| CAP_T\.aiDisclaimer/);
        const route = fs.readFileSync(path.join(ROOT, 'src/routes/v2-capability.js'), 'utf8');
        expect(route).toMatch(/out\.disclaimer = req\.t\(out\.disclaimerKey/);
    });
});

describe('(b) no named ranking of people by default', () => {
    const ctx = {
        headcount: 3,
        measuredCount: 2,
        neverAssessed: 1,
        avgReadinessPct: 60,
        coverage: { assessed: 12, expected: 30, pct: 40 },
        lowestReadiness: [{ name: 'Ada LOVELACE', pct: 30, assessed: 3, expected: 10 }],
        highestReadiness: [{ name: 'Alan TURING', pct: 90, assessed: 9, expected: 10 }],
        flightRisk: [{ flightRisk: 'high', n: 1 }],
        flightRiskWho: [{ name: 'Ada LOVELACE' }],
        openPipsWho: [{ name: 'Alan TURING', state: 'active' }],
        openPips: { n: 1 },
        topGaps: [{ skill: 'Blasting', shortfall: 2, unmeasured: 0 }],
        bySite: [],
        nineBox: [],
    };
    const PEOPLE_QUESTIONS = [
        'Who is at flight risk?',
        'Who needs development first?',
        'Who are the weakest?',
        'readiness',
        'Open PIPs?',
        'something else entirely',
    ];

    test.each(PEOPLE_QUESTIONS)('default: %p names nobody', (q) => {
        const a = Copilot._deterministic(q, ctx);
        expect(a).not.toMatch(/Ada|Alan|LOVELACE|TURING/);
    });

    test('default answers with aggregates and a polite explanation', () => {
        const fr = Copilot._deterministic('Who is at flight risk?', ctx);
        expect(fr).toMatch(/high: 1/);
        expect(fr).toMatch(/I do not rank or name individual people/);
        const dev = Copilot._deterministic('Who needs development first?', ctx);
        expect(dev).toMatch(/Average role-readiness over the 2 people measured is 60%/);
        expect(dev).toMatch(/Blasting \(2 measured short\)/);
        expect(dev).toMatch(/a judgement for a person/);
        expect(Copilot._deterministic('Open PIPs?', ctx)).toMatch(/1 open PIP/);
    });

    test('opt-in: names are given when the setting allows it', () => {
        const on = { allowNamedPersonRanking: true };
        expect(Copilot._deterministic('Who is at flight risk?', ctx, on)).toMatch(/Ada LOVELACE/);
        expect(Copilot._deterministic('Who needs development first?', ctx, on)).toMatch(
            /Ada LOVELACE/
        );
        expect(Copilot._deterministic('Open PIPs?', ctx, on)).toMatch(/Alan TURING \(active\)/);
    });

    test('ask(): the setting defaults to OFF, and on/off is read from App Settings', async () => {
        wire();
        const off = await Copilot.ask({ id: 5, userType: 'manager' }, 'Who is at flight risk?');
        expect(off.answer).not.toMatch(/Ada/);
        expect(off.namedPersonRanking).toBe('withheld');

        wire({ 'copilot.allow_named_person_ranking': true });
        const on = await Copilot.ask({ id: 5, userType: 'manager' }, 'Who is at flight risk?');
        expect(on.answer).toMatch(/Ada LOVELACE/);
        expect(on.namedPersonRanking).toBe('allowed');
    });

    test('ask() with an LLM: named lists are withheld from the model and the prompt forbids ranking', async () => {
        wire({ copilotProvider: 'ollama', copilotUrl: '', copilotModel: 'llama3.1' });
        const spy = jest.spyOn(Copilot, '_callLlm').mockResolvedValue('aggregate answer');
        const spyInt = jest.spyOn(Copilot, '_isInternalTarget').mockResolvedValue(true);
        try {
            await Copilot.ask({ id: 5, userType: 'manager' }, 'Who needs development first?');
            const [, system, userPrompt] = spy.mock.calls[0];
            expect(system).toMatch(/Do NOT rank, score, shortlist or name individual people/);
            expect(userPrompt).not.toMatch(/lowestReadiness|flightRiskWho|openPipsWho/);
            expect(userPrompt).toMatch(/"namedPersonRanking":"withheld"/);
        } finally {
            spy.mockRestore();
            spyInt.mockRestore();
        }
    });
});

describe('(c) data residency', () => {
    test('every preset declares region / euHosted / trainsOnData', () => {
        for (const p of Copilot.presets()) {
            expect(['local', 'eu', 'us', 'cn']).toContain(p.region);
            expect(typeof p.euHosted).toBe('boolean');
            expect(typeof p.trainsOnData).toBe('boolean');
            expect(p.euHosted).toBe(p.region === 'local' || p.region === 'eu');
        }
        const byName = Object.fromEntries(Copilot.presets().map((p) => [p.name, p]));
        expect(byName.ollama.region).toBe('local');
        expect(byName.mistral.euHosted).toBe(true);
        expect(byName.openai.euHosted).toBe(false);
    });

    test('no preset defaults to a free-tier model', () => {
        for (const p of Copilot.presets()) {
            expect(p.defaultModel).not.toMatch(/:free$|-free$/i);
        }
    });

    test('default (eu_only on): a non-EU preset is blocked and nothing is sent', async () => {
        wire({
            copilotProvider: 'openai',
            copilotUrl: '',
            copilotModel: '',
            copilotApiSecret: 'k',
        });
        const cfg = await Copilot.getConfig();
        expect(cfg.blocked).toBe('non_eu_provider');
        expect(cfg.region).toBe('us');
        const spy = jest.spyOn(Copilot, '_callLlm');
        try {
            const out = await Copilot.ask({ id: 5, userType: 'manager' }, 'readiness by site');
            expect(spy).not.toHaveBeenCalled();
            expect(out.mode).toBe('deterministic');
            expect(out.blocked).toBe('non_eu_provider');
            const [a] = copilotAudits();
            expect(a.action).toBe('COPILOT_QUERY');
            expect(meta(a)).toMatchObject({ egress: false, residencyBlocked: 'non_eu_provider' });
            const st = await Copilot.llmStatus();
            expect(st).toMatchObject({
                mode: 'blocked',
                reachable: false,
                blocked: 'non_eu_provider',
            });
        } finally {
            spy.mockRestore();
        }
    });

    test('EU and on-prem presets pass; switching the guard off lets a non-EU preset through', async () => {
        wire({
            copilotProvider: 'mistral',
            copilotUrl: '',
            copilotModel: '',
            copilotApiSecret: 'k',
        });
        expect((await Copilot.getConfig()).blocked).toBeUndefined();
        Copilot.invalidate();
        wire({ copilotProvider: 'ollama', copilotUrl: '', copilotModel: 'llama3.1' });
        expect((await Copilot.getConfig()).blocked).toBeUndefined();
        Copilot.invalidate();
        wire({
            copilotProvider: 'openai',
            copilotUrl: '',
            copilotModel: '',
            copilotApiSecret: 'k',
            'copilot.eu_only_providers': false,
        });
        expect((await Copilot.getConfig()).blocked).toBeUndefined();
    });

    test('an overridden endpoint URL is the administrator’s declared choice', async () => {
        wire({
            copilotProvider: 'openai',
            copilotUrl: 'https://my-eu-deployment.openai.azure.com/v1/chat/completions',
            copilotModel: 'gpt-4o-mini',
            copilotApiSecret: 'k',
        });
        expect((await Copilot.getConfig()).blocked).toBeUndefined();
    });
});

describe('(d) human-oversight acknowledgement in the audit record', () => {
    test('a question about people is recorded as shown-as-decision-support', async () => {
        wire();
        await Copilot.ask({ id: 5, userType: 'manager' }, 'Who is at flight risk?');
        const [a] = copilotAudits();
        expect(a.details).toMatch(/shown as decision support only; a person makes the decision/);
        expect(meta(a).humanOversight).toEqual({
            notice: 'decision_support_only',
            disclaimerShown: true,
            aboutPeople: true,
            namedPersonRanking: 'withheld',
        });
        // Still never the raw question or names.
        expect(JSON.stringify(a)).not.toMatch(/Ada|flight risk\?/);
    });

    test('a non-people question is recorded as such', async () => {
        wire();
        await Copilot.ask({ id: 5, userType: 'manager' }, 'top skill gaps by site');
        const [a] = copilotAudits();
        expect(meta(a).humanOversight.aboutPeople).toBe(false);
    });
});

describe('admin settings', () => {
    test('both toggles have EN/FR names and descriptions', () => {
        for (const lang of ['en', 'fr']) {
            const admin = readJson(`locales/${lang}/admin.json`);
            for (const k of ['copilot_allow_named_person_ranking', 'copilot_eu_only_providers']) {
                expect(admin[`set_name_${k}`]).toBeTruthy();
                expect(admin[`set_desc_${k}`]).toBeTruthy();
            }
        }
    });

    test('defaults: named ranking off, EU-only on; both boolean-validated', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/models/AppSettingsModel.js'), 'utf8');
        expect(src).toMatch(
            /key: 'copilot\.allow_named_person_ranking',\s*value: 'false',\s*type: 'boolean'/
        );
        expect(src).toMatch(
            /key: 'copilot\.eu_only_providers',\s*value: 'true',\s*type: 'boolean'/
        );
        expect(src).toMatch(/'copilot\.allow_named_person_ranking': \{ type: 'boolean' \}/);
        expect(src).toMatch(/'copilot\.eu_only_providers': \{ type: 'boolean' \}/);
    });
});
