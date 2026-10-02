'use strict';
/**
 * The copilot egress gate (audit SA-17).
 *  - an API key never travels over http; plain http only to an allow-listed
 *    LOOPBACK model without key;
 *  - private / loopback / link-local targets refused unless allow-listed;
 *  - the connection goes to the address that was checked (pinned) and a
 *    redirect is refused;
 *  - an EXTERNAL target needs a recorded transfer basis + DPA acknowledgement
 *    for that provider AND host; without it the copilot answers
 *    deterministically and nothing leaves the box.
 */
const http = require('http');

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockSettings = { findByKey: jest.fn(), getValue: jest.fn(), setValue: jest.fn() };
jest.mock('../../src/models/AppSettingsModel', () => mockSettings);
const mockLog = { log: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../src/services/LogService', () => mockLog);

const Copilot = require('../../src/services/CopilotService');

let settings;
function wire(map) {
    settings = { ...map };
    mockSettings.findByKey.mockResolvedValue({ settingKey: 'copilotProvider' });
    mockSettings.getValue.mockImplementation(async (k, d) => (k in settings ? settings[k] : d));
    mockSettings.setValue.mockImplementation(async (k, v) => {
        settings[k] = v;
    });
    Copilot.invalidate();
}
const cfgOf = (o) => ({ provider: 'custom', model: 'm', apiKey: null, timeoutMs: 3000, ...o });

afterEach(() => jest.restoreAllMocks());

describe('connectionGate: transport and address rules', () => {
    test('an API key is never sent over plain http, even to an allow-listed loopback', async () => {
        wire({ copilotAllowedPrivateHosts: 'localhost' });
        const g = await Copilot.connectionGate(
            cfgOf({ url: 'http://127.0.0.1:11434/api', apiKey: 'k' })
        );
        expect(g).toMatchObject({ ok: false, code: 'https_required' });
    });

    test('a private / loopback / link-local target is refused unless allow-listed', async () => {
        wire({ copilotAllowedPrivateHosts: '' });
        for (const url of [
            'http://127.0.0.1:11434/api',
            'https://10.0.0.5/v1',
            'https://169.254.169.254/latest',
            'https://[::1]/v1',
            'https://192.168.1.4/v1',
        ]) {
            const g = await Copilot.connectionGate(cfgOf({ url }));
            expect([url, g.code]).toEqual([url, 'private_host']);
        }
    });

    test('a NAME that resolves to a private address is refused like the address itself', async () => {
        wire({ copilotAllowedPrivateHosts: '' });
        jest.spyOn(Copilot, '_resolve').mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
        const g = await Copilot.connectionGate(cfgOf({ url: 'https://innocent.example.com/v1' }));
        expect(g.code).toBe('private_host');
    });

    test('allow-listed loopback model without key: plain http accepted (the on-prem Ollama case)', async () => {
        wire({ copilotAllowedPrivateHosts: 'localhost:11434, 127.0.0.1:11434' });
        const g = await Copilot.connectionGate(
            cfgOf({ provider: 'ollama', url: 'http://127.0.0.1:11434/api/generate' })
        );
        expect(g).toMatchObject({ ok: true, external: false });
    });

    test('allow-list is port-aware when a port is given', async () => {
        wire({ copilotAllowedPrivateHosts: '127.0.0.1:11434' });
        const g = await Copilot.connectionGate(cfgOf({ url: 'http://127.0.0.1:5432/' }));
        expect(g.code).toBe('private_host');
    });

    test('an allow-listed LAN (non-loopback) host still needs https', async () => {
        wire({ copilotAllowedPrivateHosts: '10.0.0.5' });
        expect((await Copilot.connectionGate(cfgOf({ url: 'http://10.0.0.5/v1' }))).code).toBe(
            'https_required'
        );
        expect((await Copilot.connectionGate(cfgOf({ url: 'https://10.0.0.5/v1' }))).ok).toBe(true);
    });

    test('credentials in the URL / non-http schemes are refused', async () => {
        wire({});
        expect(
            (await Copilot.connectionGate(cfgOf({ url: 'https://u:p@api.example.com/' }))).code
        ).toBe('bad_url');
        expect((await Copilot.connectionGate(cfgOf({ url: 'file:///etc/passwd' }))).code).toBe(
            'bad_url'
        );
    });
});

describe('connectionGate: external transfer basis', () => {
    const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

    test('an external provider with no recorded basis is disabled', async () => {
        wire({});
        jest.spyOn(Copilot, '_resolve').mockResolvedValue(PUBLIC);
        const g = await Copilot.connectionGate(
            cfgOf({
                provider: 'openai',
                url: 'https://api.openai.com/v1/chat/completions',
                apiKey: 'k',
            })
        );
        expect(g).toMatchObject({ ok: false, code: 'transfer_basis_missing', external: true });
    });

    test('an external target over plain http is refused outright', async () => {
        wire({});
        jest.spyOn(Copilot, '_resolve').mockResolvedValue(PUBLIC);
        expect((await Copilot.connectionGate(cfgOf({ url: 'http://llm.example.com/' }))).code).toBe(
            'https_required'
        );
    });

    test('recording the basis (who, when, text) enables exactly that provider + host', async () => {
        wire({
            copilotProvider: 'openai',
            copilotUrl: '',
            copilotApiSecret: 'k',
            'copilot.eu_only_providers': false,
        });
        jest.spyOn(Copilot, '_resolve').mockResolvedValue(PUBLIC);
        const bad = await Copilot.recordTransferBasis(
            { id: 1, username: 'sa' },
            { basis: 'sccs', basisText: 'short', region: 'EU', dpaAcknowledged: 'true' }
        );
        expect(bad).toMatchObject({ ok: false, code: 'basis_text_short' });
        const noDpa = await Copilot.recordTransferBasis(
            { id: 1 },
            { basis: 'sccs', basisText: 'SCC 2021/914 module 2 signed 2026-09-01', region: 'EU' }
        );
        expect(noDpa).toMatchObject({ ok: false, code: 'dpa_required' });

        const ok = await Copilot.recordTransferBasis(
            { id: 7, username: 'super' },
            {
                basis: 'sccs',
                basisText: 'SCC 2021/914 module 2 signed 2026-09-01',
                region: 'EU (Ireland)',
                dpaAcknowledged: 'true',
                dpaText: 'ack text',
            }
        );
        expect(ok.ok).toBe(true);
        const rec = settings.copilotTransferRecord;
        expect(rec).toMatchObject({
            provider: 'openai',
            host: 'api.openai.com',
            basis: 'sccs',
            region: 'EU (Ireland)',
            dpaAcknowledged: true,
            dpaText: 'ack text',
        });
        expect(rec.recordedBy).toEqual({ id: 7, username: 'super' });
        expect(new Date(rec.recordedAt).toString()).not.toBe('Invalid Date');
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'COPILOT_TRANSFER_BASIS_RECORDED' })
        );

        const cfg = await Copilot.getConfig();
        expect((await Copilot.connectionGate(cfg)).ok).toBe(true);
        // Same record, another host: not covered.
        expect(
            (await Copilot.connectionGate({ ...cfg, url: 'https://api.other-llm.example/v1' })).code
        ).toBe('transfer_basis_missing');
        // Withdrawn: disabled again.
        await Copilot.revokeTransferBasis({ id: 7 });
        expect((await Copilot.connectionGate(await Copilot.getConfig())).code).toBe(
            'transfer_basis_missing'
        );
    });

    test('ask() with a blocked external config answers deterministically and sends NOTHING', async () => {
        wire({
            copilotProvider: 'gemini',
            copilotUrl: '',
            copilotApiSecret: 'k',
            'copilot.eu_only_providers': false,
        });
        jest.spyOn(Copilot, '_resolve').mockResolvedValue(PUBLIC);
        jest.spyOn(Copilot, '_buildContextAndRoster').mockResolvedValue({
            ctx: { headcount: 3 },
            roster: [],
        });
        jest.spyOn(Copilot, '_isInternalTarget').mockResolvedValue(false);
        const post = jest.spyOn(Copilot, '_pinnedPost');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const r = await Copilot.ask({ id: 1, userType: 'admin' }, 'who is at flight risk?');
        expect(r.mode).toBe('deterministic');
        expect(r.llmBlocked).toBe('transfer_basis_missing');
        expect(post).not.toHaveBeenCalled();
        const actions = mockLog.log.mock.calls.map((c) => c[0].action);
        expect(actions).toContain('COPILOT_QUERY');
        expect(actions).not.toContain('COPILOT_QUERY_EGRESS');
    });

    test('policyStatus tells the settings page why the provider is off', async () => {
        wire({
            copilotProvider: 'anthropic',
            copilotUrl: '',
            copilotApiSecret: 'k',
            'copilot.eu_only_providers': false,
        });
        jest.spyOn(Copilot, '_resolve').mockResolvedValue(PUBLIC);
        const s = await Copilot.policyStatus();
        expect(s).toMatchObject({
            configured: true,
            allowed: false,
            external: true,
            needsTransferBasis: true,
            blockedCode: 'transfer_basis_missing',
            host: 'api.anthropic.com',
        });
    });
});

describe('the connection itself: pinned address, no redirect', () => {
    let server;
    let port;
    let handler;
    beforeAll(async () => {
        server = http.createServer((req, res) => handler(req, res));
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });
    afterAll(() => new Promise((r) => server.close(r)));

    test('connects to the CHECKED address, never re-resolves the name (DNS rebinding)', async () => {
        wire({ copilotAllowedPrivateHosts: 'model.internal.test' });
        handler = (req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ response: `pong via ${req.headers.host}` }));
        };
        // The gate's single resolution says 127.0.0.1; a second lookup would fail (no such name).
        jest.spyOn(Copilot, '_resolve').mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
        const out = await Copilot._callLlm(
            cfgOf({ provider: 'ollama', url: `http://model.internal.test:${port}/api/generate` }),
            'sys',
            'ping',
            3000
        );
        expect(out).toBe(`pong via model.internal.test:${port}`);
    });

    test('a redirect is refused (it could point at a private or metadata host)', async () => {
        wire({ copilotAllowedPrivateHosts: '127.0.0.1' });
        handler = (req, res) => {
            res.statusCode = 302;
            res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
            res.end();
        };
        await expect(
            Copilot._callLlm(
                cfgOf({ provider: 'ollama', url: `http://127.0.0.1:${port}/api/generate` }),
                's',
                'p',
                3000
            )
        ).rejects.toThrow(/redirect/);
    });

    test('a refused target never opens a socket', async () => {
        wire({ copilotAllowedPrivateHosts: '' });
        let hit = false;
        handler = (req, res) => {
            hit = true;
            res.end('{}');
        };
        await expect(
            Copilot._callLlm(
                cfgOf({ provider: 'ollama', url: `http://127.0.0.1:${port}/api/generate` }),
                's',
                'p',
                3000
            )
        ).rejects.toMatchObject({ code: 'COPILOT_EGRESS_BLOCKED', gate: 'private_host' });
        expect(hit).toBe(false);
    });
});

describe('IDevelop specifics', () => {
    test('a host named in copilotTrustedHosts is allow-listed too', async () => {
        wire({ copilotAllowedPrivateHosts: '', copilotTrustedHosts: 'ai.corp.example' });
        jest.spyOn(Copilot, '_resolve').mockResolvedValue([{ address: '10.4.4.4', family: 4 }]);
        const g = await Copilot.connectionGate(cfgOf({ url: 'https://ai.corp.example/v1' }));
        expect(g).toMatchObject({ ok: true, external: false });
    });

    test('the residency rule still applies on top of the gate', async () => {
        wire({ copilotProvider: 'openai', copilotUrl: '', copilotApiSecret: 'k' });
        const s = await Copilot.policyStatus();
        expect(s.allowed).toBe(false);
        expect(s.blockedCode).toBeTruthy();
    });

    test('the opt-in private-host switch is gone: a private target is refused by default', () => {
        const src = require('fs').readFileSync(
            require.resolve('../../src/services/CopilotService'),
            'utf8'
        );
        expect(src).not.toMatch(/COPILOT_BLOCK_PRIVATE_HOSTS/);
        expect(src).not.toMatch(/globalThis\.fetch\(cfg\.url/);
    });
});
