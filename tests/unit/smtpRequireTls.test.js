'use strict';
/**
 * SMTP must offer TLS (STARTTLS required, `requireTLS`) except for ONE relay a
 * SuperAdmin names with a mandatory reason (audited): it must resolve to a
 * private or loopback address, it is reached at the pinned address, and SMTP
 * credentials are never sent to it without TLS.
 */
const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

const APP_KEY = 'smtp-tls-test-app-key-0123456789abcdef0123';
const prev = { APP_KEY: process.env.APP_KEY, NODE_ENV: process.env.NODE_ENV };
process.env.APP_KEY = APP_KEY;

const secretBox = require('../../src/utils/secretBox');
const AppSettingsModel = require('../../src/models/AppSettingsModel');

afterAll(() => {
    if (prev.APP_KEY === undefined) delete process.env.APP_KEY;
    else process.env.APP_KEY = prev.APP_KEY;
});

/** A tiny in-memory app_settings table behind the mocked db. */
let table;
function wireTable(rows) {
    table = new Map(
        rows.map((r, i) => [
            r.settingKey,
            { id: i + 1, settingType: 'string', category: 'email', ...r },
        ])
    );
    mockDb.get.mockImplementation(async (sql, params) => {
        if (/WHERE settingKey = \?/.test(sql)) return table.get(params[0]);
        if (/WHERE id = \?/.test(sql)) return [...table.values()].find((r) => r.id === params[0]);
        return undefined;
    });
    mockDb.all.mockImplementation(async () => [...table.values()]);
    mockDb.run.mockImplementation(async (sql, params) => {
        if (
            /^UPDATE appSettings SET settingValue = \?, settingType/.test(sql) &&
            /WHERE settingKey/.test(sql)
        ) {
            const [v, t, , , , k] = params;
            Object.assign(table.get(k), { settingValue: v, settingType: t });
        } else if (
            /^UPDATE appSettings SET settingValue = \? WHERE settingKey = \? AND settingValue = \?/.test(
                sql
            )
        ) {
            const [v, k, old] = params;
            if (table.get(k) && table.get(k).settingValue === old) table.get(k).settingValue = v;
        } else if (/WHERE id = \?/.test(sql)) {
            const row = [...table.values()].find((r) => r.id === params[5]);
            row.settingValue = params[0];
        } else if (/^INSERT INTO appSettings/.test(sql)) {
            const [k, v, t] = params;
            table.set(k, { id: table.size + 1, settingKey: k, settingValue: v, settingType: t });
        }
        return { changes: 1 };
    });
}
beforeEach(async () => {
    jest.clearAllMocks();
    // The model caches rows for 60 s and every write busts that cache: one
    // throw-away write gives each test a cold cache.
    wireTable([]);
    await AppSettingsModel.setValue('zzCacheBust', '1');
});

describe('SMTP requires TLS except for ONE named private relay', () => {
    const EmailService = require('../../src/services/EmailService');
    const LogService = require('../../src/services/LogService');
    const nodemailer = require('nodemailer');
    let built;
    beforeEach(() => {
        built = jest
            .spyOn(nodemailer, 'createTransport')
            .mockReturnValue({ verify: jest.fn().mockResolvedValue(true) });
        EmailService.invalidate();
    });
    afterEach(() => jest.restoreAllMocks());
    const rows = (extra) => [
        { settingKey: 'smtpHost', settingValue: 'smtp.lan' },
        { settingKey: 'smtpPort', settingValue: '25', settingType: 'number' },
        ...extra,
    ];
    const resolveTo = (address) =>
        jest.spyOn(EmailService, '_resolve').mockResolvedValue([{ address, family: 4 }]);

    test('no relay named → STARTTLS required for every server', async () => {
        wireTable(rows([]));
        resolveTo('10.0.0.9');
        await EmailService._getTransport();
        expect(built).toHaveBeenCalledWith(
            expect.objectContaining({ host: 'smtp.lan', requireTLS: true })
        );
    });

    test('the named relay, resolving to a private IP, is reached without TLS AT THE PINNED IP', async () => {
        wireTable(rows([{ settingKey: 'smtpPlaintextRelayHost', settingValue: 'smtp.lan' }]));
        resolveTo('10.0.0.9');
        await EmailService._getTransport();
        const o = built.mock.calls[0][0];
        expect(o.requireTLS).toBe(false);
        expect(o.host).toBe('10.0.0.9');
        expect(o.tls).toEqual({ servername: 'smtp.lan' });
        expect(o.auth).toBeUndefined();
    });

    test('credentials are NEVER sent in clear: with a password set, TLS stays required even for the relay', async () => {
        wireTable(
            rows([
                { settingKey: 'smtpPlaintextRelayHost', settingValue: 'smtp.lan' },
                { settingKey: 'smtpUser', settingValue: 'svc' },
                { settingKey: 'smtpPassword', settingValue: 'pw' },
            ])
        );
        resolveTo('10.0.0.9');
        await EmailService._getTransport();
        expect(built.mock.calls[0][0]).toMatchObject({
            requireTLS: true,
            auth: { user: 'svc', pass: 'pw' },
        });
        const msg = EmailService._explain(
            new Error('Server does not support STARTTLS'),
            await EmailService.getConfig()
        );
        expect(msg).toMatch(/never sent over an unencrypted connection/);
    });

    test('a named relay that resolves to a PUBLIC address is refused: nothing is built or sent', async () => {
        wireTable(rows([{ settingKey: 'smtpPlaintextRelayHost', settingValue: 'smtp.lan' }]));
        resolveTo('93.184.216.34');
        const v = await EmailService.verify();
        expect(v.ok).toBe(false);
        expect(v.error).toMatch(/does not resolve to a private or loopback address/);
        expect(built).not.toHaveBeenCalled();
    });

    test('the exemption covers the NAMED host only', async () => {
        wireTable(rows([{ settingKey: 'smtpPlaintextRelayHost', settingValue: 'other.lan' }]));
        resolveTo('10.0.0.9');
        await EmailService._getTransport();
        expect(built.mock.calls[0][0].requireTLS).toBe(true);
    });

    test('implicit TLS (secure) needs no STARTTLS flag', () => {
        const o = EmailService.transportOptions({
            host: 'h',
            port: 465,
            secure: true,
            user: 'u',
            pass: 'p',
        });
        expect(o.requireTLS).toBeUndefined();
        expect(o.auth).toEqual({ user: 'u', pass: 'p' });
    });

    test('only a SuperAdmin names the relay, with a mandatory reason, audited (who/when/reason)', async () => {
        wireTable(rows([]));
        const log = jest.spyOn(LogService, 'log').mockResolvedValue(undefined);
        expect(
            await EmailService.setPlaintextRelay(
                { id: 2, role: 'localadmin' },
                { host: 'smtp.lan', reason: 'legacy relay' }
            )
        ).toMatchObject({ ok: false, code: 'superadmin_only' });
        expect(
            await EmailService.setPlaintextRelay(
                { id: 1, role: 'superadmin' },
                { host: 'smtp.lan', reason: '' }
            )
        ).toMatchObject({ ok: false, code: 'reason_required' });
        expect(table.get('smtpPlaintextRelayHost')).toBeUndefined();

        const ok = await EmailService.setPlaintextRelay(
            { id: 1, role: 'superadmin', username: 'sa' },
            { host: 'SMTP.lan', reason: 'Exchange relay without TLS, ticket 42' }
        );
        expect(ok.ok).toBe(true);
        expect(table.get('smtpPlaintextRelayHost').settingValue).toBe('smtp.lan');
        expect(table.get('smtpPlaintextRelayReason').settingValue).toBe(
            'Exchange relay without TLS, ticket 42'
        );
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'SMTP_PLAINTEXT_RELAY_SET',
                adminId: 1,
                details: expect.stringContaining('ticket 42'),
            })
        );
        const st = await EmailService.plaintextRelayStatus();
        expect(st).toMatchObject({
            active: true,
            host: 'smtp.lan',
            reason: 'Exchange relay without TLS, ticket 42',
        });
        expect(st.setBy).toMatchObject({ id: 1, username: 'sa' });
        // The generic settings form can never write it.
        expect(AppSettingsModel.validate('smtpPlaintextRelayHost', 'string', 'x').code).toBe(
            'readonly'
        );
    });
});

describe('the relay routes and the dashboard warning', () => {
    const fs = require('fs');
    const routes = fs.readFileSync(require.resolve('../../src/routes/index.js'), 'utf8');
    test('the relay is named on a SuperAdmin-only route', () => {
        expect(routes).toMatch(
            /'\/app-settings\/smtp\/plaintext-relay',\s*requireSuperAdmin,\s*SmtpRelayController\.set/
        );
    });
    test('the dashboard and the settings page receive the relay status', () => {
        const dash = fs.readFileSync(
            require.resolve('../../src/controllers/DashboardController.js'),
            'utf8'
        );
        expect(dash).toMatch(/plaintextRelayStatus\(\)/);
        const set = fs.readFileSync(
            require.resolve('../../src/controllers/AppSettingsController.js'),
            'utf8'
        );
        expect(set).toMatch(/smtpRelay,/);
    });
});
