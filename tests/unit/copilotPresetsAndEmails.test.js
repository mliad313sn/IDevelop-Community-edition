'use strict';
/**
 * 3.22.35 additions:
 *   - Copilot provider PRESETS: a named free engine (grok/groq/gemini/mistral/
 *     deepseek/openrouter/together) needs only an API key — endpoint + default
 *     model auto-fill, aliases resolve, explicit URL/model overrides win, and
 *     the wire format maps to the right style.
 *   - emailTemplate: escaping + branded wrapper invariants.
 *   - Welcome invitation email: credentials, profile details and role-adapted
 *     expectations all present.
 */

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const mockSettings = { findByKey: jest.fn(), getValue: jest.fn() };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);

const CopilotService = require('../../src/services/CopilotService');
const T = require('../../src/utils/emailTemplate');

function wireSettings(map) {
    mockSettings.findByKey.mockResolvedValue({ settingKey: 'copilotProvider' });
    mockSettings.getValue.mockImplementation(async (key, fallback) =>
        key in map ? map[key] : fallback
    );
}

beforeEach(() => {
    mockSettings.findByKey.mockReset();
    mockSettings.getValue.mockReset();
    CopilotService.invalidate();
});

describe('copilot provider presets', () => {
    test('named engine + API key only → preset endpoint and default model', async () => {
        wireSettings({
            copilotProvider: 'gemini',
            copilotUrl: '',
            copilotModel: 'llama3.1',
            copilotApiSecret: 'k',
        });
        const cfg = await CopilotService.getConfig();
        expect(cfg.provider).toBe('gemini');
        expect(cfg.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
        );
        expect(cfg.model).toBe('gemini-2.0-flash'); // shipped 'llama3.1' default treated as "not chosen"
    });

    test('aliases resolve (grock → grok, google → gemini)', async () => {
        wireSettings({
            copilotProvider: 'grock',
            copilotUrl: '',
            copilotModel: '',
            copilotApiSecret: 'k',
        });
        const cfg = await CopilotService.getConfig();
        expect(cfg.provider).toBe('grok');
        expect(cfg.url).toBe('https://api.x.ai/v1/chat/completions');
        expect(cfg.model).toBe('grok-3-mini');
    });

    test('explicit URL and model overrides beat the preset', async () => {
        wireSettings({
            copilotProvider: 'groq',
            copilotUrl: 'https://gw.corp.local/v1/chat/completions',
            copilotModel: 'my-model',
            copilotApiSecret: 'k',
        });
        const cfg = await CopilotService.getConfig();
        expect(cfg.url).toBe('https://gw.corp.local/v1/chat/completions');
        expect(cfg.model).toBe('my-model');
    });

    test('ollama keeps llama3.1 (its own legitimate default)', async () => {
        wireSettings({
            copilotProvider: 'ollama',
            copilotUrl: '',
            copilotModel: 'llama3.1',
            copilotApiSecret: '',
        });
        const cfg = await CopilotService.getConfig();
        expect(cfg.url).toBe('http://localhost:11434/api/generate');
        expect(cfg.model).toBe('llama3.1');
    });

    test('every OpenAI-style preset builds a chat-completions request', () => {
        for (const provider of [
            'grok',
            'groq',
            'gemini',
            'mistral',
            'deepseek',
            'openrouter',
            'together',
            'openai',
        ]) {
            const { body, parse } = CopilotService._providerRequest(
                { provider, model: 'm', apiKey: 'k' },
                'sys',
                'hi'
            );
            expect(body.messages).toBeDefined();
            expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
            expect(parse({ choices: [{ message: { content: 'ok' } }] })).toBe('ok');
        }
    });

    test('anthropic preset keeps the native Messages format + version header', () => {
        const { headers, body, parse } = CopilotService._providerRequest(
            { provider: 'anthropic', model: 'm', apiKey: 'k' },
            'sys',
            'hi'
        );
        expect(headers['anthropic-version']).toBe('2023-06-01');
        expect(body.system).toBe('sys');
        expect(parse({ content: [{ text: 'ok' }] })).toBe('ok');
    });

    test('presets() exposes the catalog for the admin UI', () => {
        const names = CopilotService.presets().map((p) => p.name);
        for (const n of [
            'grok',
            'groq',
            'gemini',
            'mistral',
            'deepseek',
            'openrouter',
            'together',
        ]) {
            expect(names).toContain(n);
        }
    });
});

describe('emailTemplate', () => {
    test('escapes user-controlled content everywhere', () => {
        const html = T.wrap({
            branding: { appName: '<script>x</script>' },
            title: 'T',
            intro: 'Bonjour <b>—',
            blocks: [T.table([{ fr: 'A<' }], [[{ text: '<img onerror=1>' }]])],
        });
        expect(html).not.toContain('<script>x</script>');
        expect(html).not.toContain('<img onerror=1>');
        expect(html).toContain('&lt;img onerror=1&gt;');
    });

    test('wrap carries the brand name and accent color', () => {
        const html = T.wrap({
            branding: { appName: 'MinesRH', accentColor: '#123456' },
            title: 'T',
            blocks: [],
        });
        expect(html).toContain('MinesRH');
        expect(html).toContain('#123456');
    });
});

describe('welcome invitation email', () => {
    test('contains credentials, profile details and manager-adapted expectations', async () => {
        mockDb.get.mockImplementation(async (sql) => {
            if (/v_employee_details/.test(sql)) {
                return {
                    fullName: 'Awa Costé',
                    siteName: 'Mine A',
                    departmentName: 'HSE',
                    serviceName: 'Safety',
                    roleName: 'HSE Officer',
                };
            }
            if (/sup\.first_name/.test(sql)) return { name: 'Moussa Ka' };
            if (/r\.supervisor_id = \?/.test(sql)) return { x: 1 }; // IS a manager
            return null;
        });
        const OnboardingCredentialService = require('../../src/services/OnboardingCredentialService');
        const mail = await OnboardingCredentialService._welcomeEmail({
            employee: { id: 5, firstName: 'Awa', lastName: 'Costé', employeeNumber: 'EMP005' },
            username: 'awa.coste',
            tempPassword: 'Tmp#12345678',
            branding: { appName: 'MinesRH' },
        });
        expect(mail.subject).toContain('MinesRH');
        for (const needle of [
            'awa.coste',
            'Tmp#12345678',
            'EMP005',
            'HSE Officer',
            'Mine A',
            'Moussa Ka',
        ]) {
            expect(mail.html).toContain(needle);
        }
        expect(mail.html).toContain('En tant que manager'); // manager-adapted expectations
        expect(mail.text).toContain('awa.coste');
    });
});
