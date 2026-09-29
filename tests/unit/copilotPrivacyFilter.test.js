'use strict';
/**
 * The AI privacy layer end-to-end through CopilotService.ask():
 *   - target classification (fail-closed)
 *   - 'always' mode (default): internal AND external requests are ciphered
 *   - 'external-only' mode: internal/trusted servers get full data
 *   - external targets are ciphered UNCONDITIONALLY
 *   - answers are deciphered back to real values for the user
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = { findByKey: jest.fn(), getValue: jest.fn().mockResolvedValue('') };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const mockRbac = { getFilteredEmployees: jest.fn() };
jest.mock('../../src/services/RBACService', () => mockRbac);

jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/utils/branding', () => ({ getBranding: jest.fn().mockResolvedValue(null) }));

const CopilotService = require('../../src/services/CopilotService');

function wireProvider({ anonMode = 'always' } = {}) {
    mockSettings.findByKey.mockResolvedValue({ settingKey: 'copilotProvider' });
    mockSettings.getValue.mockImplementation(
        async (key, fb) =>
            ({
                copilotProvider: 'gemini',
                copilotUrl: '',
                copilotModel: '',
                copilotApiSecret: 'k',
                copilotTimeoutMs: '5000',
                copilotTrustedHosts: '',
                copilotAnonymizationMode: anonMode,
                copilotAnonymizeSkills: '0',
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

beforeEach(() => {
    mockSettings.getValue.mockReset().mockResolvedValue('');
    mockSettings.findByKey.mockReset().mockResolvedValue(null);
    mockDb.all.mockReset().mockResolvedValue([]);
    CopilotService.invalidate();
});

describe('_isInternalTarget classification', () => {
    test('localhost / private IPs / internal-suffix hostnames are internal', async () => {
        expect(await CopilotService._isInternalTarget('http://localhost:11434/api/generate')).toBe(
            true
        );
        expect(await CopilotService._isInternalTarget('http://10.1.2.3:8080/v1')).toBe(true);
        expect(await CopilotService._isInternalTarget('http://192.168.1.10/v1')).toBe(true);
        expect(await CopilotService._isInternalTarget('http://172.20.0.5/v1')).toBe(true);
        expect(await CopilotService._isInternalTarget('http://ai.mine.local/v1')).toBe(true);
        expect(await CopilotService._isInternalTarget('http://llm.corp/v1')).toBe(true);
    });
    test('public IPs are external; invalid URLs fail CLOSED (external)', async () => {
        expect(await CopilotService._isInternalTarget('https://8.8.8.8/v1')).toBe(false);
        expect(await CopilotService._isInternalTarget('not a url')).toBe(false);
    });
    test('copilotTrustedHosts setting classifies an internal DNS name', async () => {
        mockSettings.getValue.mockImplementation(async (key, fb) =>
            key === 'copilotTrustedHosts' ? 'ai.mycompany.com, other.host' : fb
        );
        expect(await CopilotService._isInternalTarget('https://ai.mycompany.com/v1/chat')).toBe(
            true
        );
    });
});

describe('ask() cipher/decipher', () => {
    test('external provider: personal AND company data ciphered, answer deciphered', async () => {
        wireProvider();
        let captured = null;
        const spyCall = jest
            .spyOn(CopilotService, '_callLlm')
            .mockImplementation(async (cfg, system, userPrompt) => {
                captured = { system, userPrompt };
                const emp = /EMP-[0-9A-F]{4}/.exec(userPrompt);
                return `Priority: ${emp ? emp[0] : 'nobody'} (40%).`;
            });
        const spyInternal = jest
            .spyOn(CopilotService, '_isInternalTarget')
            .mockResolvedValue(false);
        try {
            const out = await CopilotService.ask(
                { id: 5, userType: 'manager' },
                'Who needs development, Ismael from Geologie?'
            );
            for (const secret of ['Ismael', 'LINDQVIST', 'Geologie']) {
                expect(captured.userPrompt).not.toContain(secret);
            }
            expect(captured.system).toContain('pseudonymous tokens');
            expect(out.sanitized).toBe(true);
            expect(out.answer).toContain('Ismael LINDQVIST'); // deciphered for the user
        } finally {
            spyCall.mockRestore();
            spyInternal.mockRestore();
        }
    });

    test("default 'always' mode: INTERNAL targets are ciphered too", async () => {
        wireProvider({ anonMode: 'always' });
        let captured = null;
        const spyCall = jest
            .spyOn(CopilotService, '_callLlm')
            .mockImplementation(async (cfg, system, userPrompt) => {
                captured = userPrompt;
                return 'ok';
            });
        const spyInternal = jest.spyOn(CopilotService, '_isInternalTarget').mockResolvedValue(true);
        try {
            const out = await CopilotService.ask({ id: 5, userType: 'manager' }, 'status?');
            expect(captured).not.toContain('Ismael LINDQVIST');
            expect(out.sanitized).toBe(true);
        } finally {
            spyCall.mockRestore();
            spyInternal.mockRestore();
        }
    });

    test("'external-only' mode: internal target receives full data", async () => {
        wireProvider({ anonMode: 'external-only' });
        let captured = null;
        const spyCall = jest
            .spyOn(CopilotService, '_callLlm')
            .mockImplementation(async (cfg, system, userPrompt) => {
                captured = userPrompt;
                return 'ok';
            });
        const spyInternal = jest.spyOn(CopilotService, '_isInternalTarget').mockResolvedValue(true);
        try {
            const out = await CopilotService.ask({ id: 5, userType: 'manager' }, 'status?');
            expect(captured).toContain('Ismael LINDQVIST');
            expect(out.sanitized).toBe(false);
        } finally {
            spyCall.mockRestore();
            spyInternal.mockRestore();
        }
    });

    test("'external-only' mode: EXTERNAL target is still ciphered (non-negotiable)", async () => {
        wireProvider({ anonMode: 'external-only' });
        let captured = null;
        const spyCall = jest
            .spyOn(CopilotService, '_callLlm')
            .mockImplementation(async (cfg, system, userPrompt) => {
                captured = userPrompt;
                return 'ok';
            });
        const spyInternal = jest
            .spyOn(CopilotService, '_isInternalTarget')
            .mockResolvedValue(false);
        try {
            const out = await CopilotService.ask(
                { id: 5, userType: 'manager' },
                'status of Ismael?'
            );
            expect(captured).not.toContain('Ismael');
            expect(out.sanitized).toBe(true);
        } finally {
            spyCall.mockRestore();
            spyInternal.mockRestore();
        }
    });
});
