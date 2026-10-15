'use strict';
/**
 * SA-37 — an invitation never carries a password.
 *   - e-mail possible: username + a one-time « Définir mon mot de passe / Set
 *     my password » link, valid 72 h, built on the CONFIGURED base URL; the
 *     account holds a random password nobody knows, no forced rotation;
 *   - e-mail off, or the send failed: nothing is mailed, no link stays live,
 *     and a temporary password comes back ONCE for the credentials sheet;
 *   - the link is single use: a second use, an expired or an unknown link
 *     answers 410 on the « forgot password » page (GET and POST).
 * The token table is an in-memory fake of password_reset_tokens driven through
 * the REAL PasswordResetService (issueSetupToken / validate / consume).
 */
process.env.APP_BASE_URL = 'https://hr.example.test';
delete process.env.TRUSTED_HOSTS;

const mockTokens = [];
let mockSeq = 0;
const mockLive = (t) => !t.usedAt && new Date(t.expiresAt) > new Date();

jest.mock('../../src/config/database', () => ({
    get: jest.fn(async (sql, p = []) => {
        if (/FROM password_reset_tokens/.test(sql) && /token_hash = \?/.test(sql)) {
            const t = mockTokens.find((x) => x.hash === p[0] && mockLive(x));
            return t ? { id: t.id, subjectType: t.type, subjectId: t.subjectId } : undefined;
        }
        return undefined;
    }),
    all: jest.fn(async () => []),
    run: jest.fn(async (sql, p = []) => {
        if (/^\s*INSERT INTO password_reset_tokens/.test(sql)) {
            const [type, id, hash, exp] = p;
            mockTokens.push({ id: ++mockSeq, type, subjectId: Number(id), hash, expiresAt: exp });
            return { changes: 1 };
        }
        if (/UPDATE password_reset_tokens SET used_at = now\(\)/.test(sql)) {
            const t = mockTokens.find((x) => x.id === p[0] && mockLive(x));
            if (!t) return { changes: 0 };
            t.usedAt = new Date().toISOString();
            return { changes: 1 };
        }
        if (/DELETE FROM password_reset_tokens/.test(sql) && /id <> \?/.test(sql)) {
            for (let i = mockTokens.length - 1; i >= 0; i--)
                if (
                    mockTokens[i].type === p[0] &&
                    mockTokens[i].subjectId === Number(p[1]) &&
                    mockTokens[i].id !== p[2]
                )
                    mockTokens.splice(i, 1);
            return { changes: 1 };
        }
        if (/DELETE FROM password_reset_tokens/.test(sql) && /used_at IS NULL/.test(sql)) {
            let n = 0;
            for (let i = mockTokens.length - 1; i >= 0; i--)
                if (
                    mockTokens[i].type === p[0] &&
                    mockTokens[i].subjectId === Number(p[1]) &&
                    !mockTokens[i].usedAt
                ) {
                    mockTokens.splice(i, 1);
                    n++;
                }
            return { changes: n };
        }
        return { changes: 0 };
    }),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
}));
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (k, d) => d),
    setValue: jest.fn(),
    findByKey: jest.fn(),
}));
jest.mock('../../src/utils/branding', () => ({
    getBranding: jest.fn(async () => ({ appName: 'Example Talent' })),
}));
const mockEmp = {
    id: 5,
    email: 'alex@corp.test',
    username: 'alex.sample',
    firstName: 'Alex',
    lastName: 'Sample',
    employeeNumber: 'E5',
    isActive: true,
    isAccountActive: true,
};
jest.mock('../../src/models/EmployeeModel', () => ({
    findById: jest.fn(async () => ({ ...mockEmp })),
    findByUsername: jest.fn(async () => null),
    update: jest.fn(async () => ({})),
}));
jest.mock('../../src/models/PasswordHistoryModel', () => ({
    addPassword: jest.fn(async () => {}),
}));
jest.mock('../../src/services/SessionService', () => ({
    revokeAllForUser: jest.fn(async () => 0),
}));
jest.mock('../../src/services/AdminSsoService', () => ({
    isEnforced: () => false,
    hasSsoException: async () => false,
}));
jest.mock('../../src/services/SsoInviteService', () => ({
    isMigrated: jest.fn(async () => false),
}));
jest.mock('../../src/services/MovementService', () => ({
    recordAccount: jest.fn(async () => {}),
}));
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
const mockMail = { on: true, sent: [] };
jest.mock('../../src/services/EmailService', () => ({
    isEnabled: jest.fn(async () => mockMail.on),
    send: jest.fn(async (m) => {
        if (!mockMail.on) return { sent: false, skipped: 'disabled' };
        mockMail.sent.push(m);
        return { sent: true };
    }),
}));

const express = require('express');
const session = require('express-session');
const flash = require('../../src/middleware/flash');
const request = require('supertest');
const bcrypt = require('bcrypt');
const EmployeeModel = require('../../src/models/EmployeeModel');
const LogService = require('../../src/services/LogService');
const PRS = require('../../src/services/PasswordResetService');
const OCS = require('../../src/services/OnboardingCredentialService');
const AuthController = require('../../src/controllers/AuthController');

function buildApp() {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(session({ secret: 'setup-link-test', resave: false, saveUninitialized: false }));
    app.use(flash());
    app.use((req, res, next) => {
        res.render = (view, opts = {}) =>
            res.json({
                view,
                title: opts.title || null,
                setup: opts.setup === true,
                errors: res.locals.errors || null,
            });
        next();
    });
    app.get('/reset-password', AuthController.showResetPassword);
    app.post('/reset-password', AuthController.resetPassword);
    return app;
}

beforeEach(() => {
    mockTokens.length = 0;
    mockMail.on = true;
    mockMail.sent.length = 0;
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('an invitation never carries a password', () => {
    test.each([
        ['welcome invitation', { welcome: true }],
        ['short resend', {}],
    ])('%s: username + one-time 72 h link, no password in html or text', async (_label, opts) => {
        const hashSpy = jest.spyOn(bcrypt, 'hash');
        const gen = require('../../src/utils/credentialGenerator');
        const genSpy = jest.spyOn(gen, 'generatePassword');
        const r = await OCS.issueAndSend(5, { userType: 'admin', id: 1 }, null, opts);
        expect(r).toMatchObject({ success: true, emailed: true, username: 'alex.sample' });
        expect(r.tempPassword).toBeUndefined();
        expect(genSpy).not.toHaveBeenCalled();
        expect(mockMail.sent).toHaveLength(1);
        const m = mockMail.sent[0];
        expect(m.to).toBe('alex@corp.test');
        const all = `${m.subject}\n${m.html}\n${m.text}`;
        // Whatever secret was hashed for the account never appears in the mail.
        for (const [secret] of hashSpy.mock.calls) expect(all).not.toContain(String(secret));
        expect(all).not.toMatch(/mot de passe temporaire|temporary password/i);
        expect(m.html).toContain('alex.sample');
        expect(m.html).toContain('Définir mon mot de passe');
        expect(m.html).toContain('Set my password');
        expect(m.html).toMatch(
            /href="https:\/\/hr\.example\.test\/reset-password\?token=[A-Za-z0-9_-]{43}&amp;setup=1"/
        );
        expect(m.text).toMatch(
            /https:\/\/hr\.example\.test\/reset-password\?token=[A-Za-z0-9_-]{43}&setup=1/
        );
        expect(m.html).toContain('72 heures');
        expect(m.html).toContain('72 hours');
        // The account got an unusable password and no forced rotation.
        const upd = EmployeeModel.update.mock.calls.at(-1)[1];
        expect(upd.forcePasswordChange).toBe(false);
        expect(upd.isAccountActive).toBe(1);
        // One live token, 72 h, stored hashed.
        expect(mockTokens).toHaveLength(1);
        expect(mockTokens[0].type).toBe('employee');
        expect(m.html).not.toContain(mockTokens[0].hash);
        const hours = (new Date(mockTokens[0].expiresAt) - Date.now()) / 3600000;
        expect(hours).toBeGreaterThan(71.9);
        expect(hours).toBeLessThanOrEqual(72);
        // The audit line names neither the password nor the link.
        const line = LogService.log.mock.calls.find((c) => c[0].action === 'CREDENTIALS_ISSUED')[0]
            .details;
        expect(line).toMatch(/set-password link/);
        expect(line).not.toMatch(/token=/);
    });

    test('a second invitation burns the first link (one live link per account)', async () => {
        await OCS.issueAndSend(5, { userType: 'admin', id: 1 }, null);
        const first = mockTokens[0].hash;
        await OCS.issueAndSend(5, { userType: 'admin', id: 1 }, null);
        expect(mockTokens).toHaveLength(1);
        expect(mockTokens[0].hash).not.toBe(first);
    });

    test('e-mail off: nothing sent, no link left, the one-time sheet password', async () => {
        mockMail.on = false;
        const r = await OCS.issueAndSend(5, { userType: 'admin', id: 1 }, null);
        expect(r.emailed).toBe(false);
        expect(typeof r.tempPassword).toBe('string');
        expect(mockMail.sent).toHaveLength(0);
        expect(mockTokens).toHaveLength(0);
        expect(EmployeeModel.update.mock.calls.at(-1)[1].forcePasswordChange).toBe(true);
    });

    test('a failed send burns the link and falls back to the sheet', async () => {
        const EmailService = require('../../src/services/EmailService');
        EmailService.send.mockResolvedValueOnce({ sent: false, error: 'SMTP 550' });
        const r = await OCS.issueAndSend(5, { userType: 'admin', id: 1 }, null);
        expect(r.emailed).toBe(false);
        expect(typeof r.tempPassword).toBe('string');
        expect(mockTokens).toHaveLength(0);
        expect(EmployeeModel.update.mock.calls.at(-1)[1].forcePasswordChange).toBe(true);
    });

    test('SSO enforced without an exception: no link is minted', async () => {
        jest.spyOn(PRS, 'resetAllowed').mockResolvedValue(false);
        expect(await PRS.issueSetupToken('employee', 5)).toBeNull();
        expect(mockTokens).toHaveLength(0);
    });
});

describe('the link is single use: reuse ⇒ 410', () => {
    test('GET (« Set my password ») → POST sets it → the same link again is 410', async () => {
        const { rawToken } = await PRS.issueSetupToken('employee', 5, { ttlHours: 72 });
        const agent = request.agent(buildApp());
        const url = `/reset-password?token=${encodeURIComponent(rawToken)}&setup=1`;
        const g1 = await agent.get(url);
        expect(g1.status).toBe(200);
        expect(g1.body).toMatchObject({ view: 'pages/auth/reset-password', setup: true });
        const pw = 'Correct horse battery staple 42!';
        const p1 = await agent
            .post('/reset-password')
            .type('form')
            .send({ token: rawToken, password: pw, passwordConfirm: pw, setup: '1' });
        expect(p1.status).toBe(302);
        expect(p1.headers.location).toBe('/login');
        expect(EmployeeModel.update).toHaveBeenCalledWith(
            5,
            expect.objectContaining({ passwordHash: expect.any(String) })
        );

        const g2 = await agent.get(url);
        expect(g2.status).toBe(410);
        expect(g2.body.view).toBe('pages/auth/forgot-password');
        expect(g2.body.errors[0]).toBeTruthy();
        const p2 = await agent
            .post('/reset-password')
            .type('form')
            .send({ token: rawToken, password: pw, passwordConfirm: pw });
        expect(p2.status).toBe(410);
    });

    test('a mismatch keeps the setup flag on the way back', async () => {
        const { rawToken } = await PRS.issueSetupToken('employee', 5);
        const r = await request(buildApp())
            .post('/reset-password')
            .type('form')
            .send({ token: rawToken, password: 'a', passwordConfirm: 'b', setup: '1' });
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe(
            `/reset-password?token=${encodeURIComponent(rawToken)}&setup=1`
        );
    });

    test('an unknown or expired link is 410 too', async () => {
        expect((await request(buildApp()).get('/reset-password?token=nope')).status).toBe(410);
        const { rawToken } = await PRS.issueSetupToken('employee', 5);
        mockTokens[0].expiresAt = new Date(Date.now() - 1000).toISOString();
        expect((await request(buildApp()).get(`/reset-password?token=${rawToken}`)).status).toBe(
            410
        );
    });
});
