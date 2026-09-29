'use strict';
/**
 * 3.23.17 lane H — responsible-AI audit of the copilot.
 *
 * A question answered by an INTERNAL model left no audit record at all, and the
 * external-egress record said nothing about the exchange. Every query must now
 * be audited — external as COPILOT_QUERY_EGRESS, internal / deterministic as
 * COPILOT_QUERY — with provider, model, egress flag, a SHA-256 of the question,
 * the answer length and the anonymization counts, and NEVER the raw text.
 */
const crypto = require('crypto');

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = { findByKey: jest.fn(), getValue: jest.fn().mockResolvedValue('') };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const mockRbac = { getFilteredEmployees: jest.fn() };
jest.mock('../../src/services/RBACService', () => mockRbac);

const mockLog = { log: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../src/services/LogService', () => mockLog);
jest.mock('../../src/utils/branding', () => ({ getBranding: jest.fn().mockResolvedValue(null) }));

const CopilotService = require('../../src/services/CopilotService');

const QUESTION = 'Who needs development, Ismael from Geologie?';
const SHA = crypto.createHash('sha256').update(QUESTION, 'utf8').digest('hex');

function wire({ provider = 'gemini', anonMode = 'always' } = {}) {
    mockSettings.findByKey.mockResolvedValue({ settingKey: 'copilotProvider' });
    mockSettings.getValue.mockImplementation(
        async (key, fb) =>
            ({
                copilotProvider: provider,
                copilotUrl: '',
                copilotModel: '',
                copilotApiSecret: 'k',
                copilotTimeoutMs: '5000',
                copilotTrustedHosts: '',
                copilotAnonymizationMode: anonMode,
                copilotAnonymizeSkills: '0',
                // gemini is a non-EU preset: these tests exercise the egress audit,
                // so the EU-only residency guard (default on) is switched off here.
                'copilot.eu_only_providers': false,
            })[key] ?? fb
    );
    mockRbac.getFilteredEmployees.mockResolvedValue([
        { id: 1, firstName: 'Ismael', lastName: 'LINDQVIST' },
    ]);
    mockDb.all.mockImplementation(async (sql) => {
        if (/full_name/.test(sql)) return [{ fullName: 'Ismael LINDQVIST', pct: 40 }];
        if (/FROM sites/.test(sql)) return [{ name: 'Exploration' }];
        if (/FROM departments/.test(sql)) return [{ name: 'Geologie' }];
        return [];
    });
}

function copilotAudits() {
    return mockLog.log.mock.calls.map(([e]) => e).filter((e) => /^COPILOT_QUERY/.test(e.action));
}

function meta(entry) {
    return JSON.parse(entry.details.slice(entry.details.indexOf('{')));
}

beforeEach(() => {
    mockSettings.getValue.mockReset().mockResolvedValue('');
    mockSettings.findByKey.mockReset().mockResolvedValue(null);
    mockDb.all.mockReset().mockResolvedValue([]);
    mockLog.log.mockReset().mockResolvedValue(undefined);
    CopilotService.invalidate();
});

function assertNoRawText(entry, answer) {
    const blob = JSON.stringify(entry);
    expect(blob).not.toContain('Ismael');
    expect(blob).not.toContain('Geologie');
    expect(blob).not.toContain(QUESTION);
    if (answer) expect(blob).not.toContain(answer);
}

test('INTERNAL model: the query is audited (COPILOT_QUERY), no egress, no raw text', async () => {
    wire();
    const spyCall = jest
        .spyOn(CopilotService, '_callLlm')
        .mockResolvedValue('Priorité : développer la planification.');
    const spyInternal = jest.spyOn(CopilotService, '_isInternalTarget').mockResolvedValue(true);
    try {
        const out = await CopilotService.ask({ id: 5, userType: 'manager' }, QUESTION);
        const audits = copilotAudits();
        expect(audits).toHaveLength(1);
        expect(audits[0].action).toBe('COPILOT_QUERY');
        const m = meta(audits[0]);
        expect(m).toMatchObject({
            provider: 'gemini',
            egress: false,
            mode: 'llm',
            anonymized: true,
            questionSha256: SHA,
            answerLength: out.answer.length,
        });
        expect(m.model).toBeTruthy();
        expect(m.anonymizationCounts).toBeTruthy();
        assertNoRawText(audits[0], out.answer);
    } finally {
        spyCall.mockRestore();
        spyInternal.mockRestore();
    }
});

test('EXTERNAL model: COPILOT_QUERY_EGRESS carries hash, answer length and cipher counts', async () => {
    wire();
    const spyCall = jest.spyOn(CopilotService, '_callLlm').mockResolvedValue('Réponse courte.');
    const spyInternal = jest.spyOn(CopilotService, '_isInternalTarget').mockResolvedValue(false);
    try {
        const out = await CopilotService.ask({ id: 5, userType: 'manager' }, QUESTION);
        const audits = copilotAudits();
        expect(audits).toHaveLength(1);
        expect(audits[0].action).toBe('COPILOT_QUERY_EGRESS');
        const m = meta(audits[0]);
        expect(m).toMatchObject({
            egress: true,
            anonymized: true,
            questionSha256: SHA,
            answerLength: out.answer.length,
        });
        expect(m.anonymizationCounts).toEqual(expect.any(Object));
        assertNoRawText(audits[0], out.answer);
    } finally {
        spyCall.mockRestore();
        spyInternal.mockRestore();
    }
});

test('EXTERNAL failure → fallback is still audited as egress (the request may have left)', async () => {
    wire();
    const spyCall = jest.spyOn(CopilotService, '_callLlm').mockRejectedValue(new Error('timeout'));
    const spyInternal = jest.spyOn(CopilotService, '_isInternalTarget').mockResolvedValue(false);
    try {
        const out = await CopilotService.ask({ id: 5, userType: 'manager' }, QUESTION);
        const [a] = copilotAudits();
        expect(a.action).toBe('COPILOT_QUERY_EGRESS');
        expect(meta(a)).toMatchObject({
            mode: 'fallback',
            egress: true,
            answerLength: out.answer.length,
        });
    } finally {
        spyCall.mockRestore();
        spyInternal.mockRestore();
    }
});

test('no model configured: the deterministic answer is audited too', async () => {
    mockRbac.getFilteredEmployees.mockResolvedValue([]);
    const out = await CopilotService.ask({ id: 5, userType: 'manager' }, QUESTION);
    const audits = copilotAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('COPILOT_QUERY');
    expect(meta(audits[0])).toMatchObject({
        provider: 'none',
        model: null,
        egress: false,
        mode: 'deterministic',
        questionSha256: SHA,
        answerLength: out.answer.length,
    });
    assertNoRawText(audits[0]);
});
