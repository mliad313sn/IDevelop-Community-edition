'use strict';

/**
 * Sign-in fail-closed and reset timing.
 *   - login: an MFA lookup failure refuses the sign-in (it used to be read as
 *     "no MFA" and opened the session on the password alone);
 *   - requestPasswordReset does not wait for the SMTP send (a real account
 *     used to answer seconds slower than an unknown one).
 */
const mockMfa = {
    isActive: jest.fn(async () => false),
    mfaUserType: (u) => (u.userType === 'admin' || !u.userType ? 'admin' : 'employee'),
    hasFreshEnrolment: () => false,
    rememberEnrolment: () => {},
};
jest.mock('../../src/services/MfaService', () => mockMfa);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../../src/services/AdminSsoService', () => ({
    isEnforced: () => false,
    passwordAllowedWhileEnforced: () => true,
}));
jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(async () => []),
    run: jest.fn(),
}));
let mockAuthUser = null;
jest.mock('passport', () => ({
    authenticate: (_s, cb) => () => cb(null, mockAuthUser, {}),
    use: () => {},
    serializeUser: () => {},
    deserializeUser: () => {},
}));
jest.mock('../../src/services/AuthService', () => ({}));
jest.mock('../../src/services/EmployeeAuthService', () => ({ takeRefusalCode: () => null }));
jest.mock('../../src/models/EmployeeModel', () => ({}));

const mockSend = jest.fn(() => new Promise(() => {})); // never settles
jest.mock('../../src/services/PasswordResetService', () => ({
    requestReset: async () => ({
        sent: true,
        resets: [
            { rawToken: 't', email: 'person@example.test', name: 'A', subjectType: 'employee' },
        ],
        ttlMinutes: 30,
    }),
}));
jest.mock('../../src/services/EmailService', () => ({
    isEnabled: async () => true,
    send: (...a) => mockSend(...a),
}));
jest.mock('../../src/utils/emailTemplate', () => ({
    baseUrlAsync: async () => 'https://app.example.test',
}));

const AuthController = require('../../src/controllers/AuthController');

describe('login: an MFA lookup failure refuses the sign-in', () => {
    test('no session is opened on the password alone', async () => {
        mockAuthUser = { id: 5, userType: 'admin', role: 'localadmin', username: 'ops' };
        mockMfa.isActive.mockRejectedValue(new Error('db down'));
        const logIn = jest.fn();
        const regenerate = jest.fn((cb) => cb());
        const flashes = [];
        const to = await new Promise((resolve) => {
            AuthController.login(
                {
                    body: { username: 'ops' },
                    ip: '192.0.2.1',
                    get: () => '',
                    flash: (t, m) => flashes.push([t, m]),
                    session: { regenerate, save: (cb) => cb() },
                    logIn,
                },
                { redirect: resolve },
                () => {}
            );
        });
        expect(to).toBe('/login');
        expect(logIn).not.toHaveBeenCalled();
        expect(regenerate).not.toHaveBeenCalled();
        expect(flashes[0][0]).toBe('error');
        expect(require('../../src/services/LogService').log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'LOGIN_MFA_CHECK_FAILED' })
        );
    });
});

describe('forgot-password: the answer does not wait for the SMTP send', () => {
    test('a real account with a hanging mail server still gets the answer at once', async () => {
        const to = await Promise.race([
            new Promise((resolve) =>
                AuthController.requestPasswordReset(
                    {
                        body: { identifier: 'person@example.test' },
                        ip: '192.0.2.1',
                        get: () => '',
                        flash: () => {},
                    },
                    { redirect: resolve, locals: {} }
                )
            ),
            new Promise((resolve) => setTimeout(() => resolve('TIMED OUT'), 2000)),
        ]);
        expect(to).toBe('/login');
        await new Promise((r) => setImmediate(r));
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({ to: 'person@example.test' })
        );
    });
});
