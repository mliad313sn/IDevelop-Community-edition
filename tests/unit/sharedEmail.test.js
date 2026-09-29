'use strict';
/**
 * One e-mail address, several accounts (migration 107).
 *
 * PRODUCT RULE (user, 2026-09-09): a person may hold two or more accounts, so an
 * address is contact information, not an identity key. Creating or editing an
 * account whose address is already in use is ALLOWED and ADVISED — never
 * refused. What these tests pin:
 *   - the advisory names only what the actor may see (scope), counts the rest;
 *   - every flow that used to assume one account per address now REFUSES
 *     ambiguity instead of guessing (login by e-mail, SSO auto-link, LMS
 *     completion) — a policy refusal, never a lockout;
 *   - the self-service reset serves EVERY eligible account carrying the address;
 *   - the old refusals are gone from the controllers, the constraint from the DB.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn(), runTransaction: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
const mockLog = { log: jest.fn(async () => {}) };
jest.mock('../../src/services/LogService', () => mockLog);
const mockRbac = {
    isSuperAdmin: jest.fn(() => false),
    canAccessEmployeeData: jest.fn(async () => true),
};
jest.mock('../../src/services/RBACService', () => mockRbac);
const mockAdminModel = {
    findByUsername: jest.fn(),
    findById: jest.fn(),
    findByEmail: jest.fn(),
    update: jest.fn(),
};
jest.mock('../../src/models/AdminModel', () => mockAdminModel);
const mockEmployeeModel = {
    findByUsername: jest.fn(),
    findById: jest.fn(),
    findByEmail: jest.fn(),
    update: jest.fn(),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmployeeModel);
jest.mock('../../src/models/PasswordHistoryModel', () => ({ addPassword: jest.fn() }));
jest.mock('../../src/services/SessionService', () => ({ revokeAllForUser: jest.fn() }));

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const Email = require('../../src/services/EmailAccountsService');

const EMP = (id, extra = {}) => ({
    id,
    username: `u${id}`,
    firstName: 'Awa',
    lastName: `K${id}`,
    employeeNumber: `E${id}`,
    isActive: true,
    ...extra,
});
const ADM = (id, extra = {}) => ({
    id,
    username: `adm${id}`,
    role: 'localadmin',
    isActive: true,
    ...extra,
});
/** db.all routed by table: employees first, then admins (the service's call order). */
const wireAll = (emps, admins) =>
    mockDb.all.mockImplementation(async (sql) =>
        /FROM employees/.test(sql) ? emps : /FROM admins/.test(sql) ? admins : []
    );
const req = (user, t = null) => ({ user, t });
const tFn = (k, o) =>
    `[${k}${o && o.count != null ? ':' + o.count : ''}${o && o.who ? ':' + o.who : ''}]`;

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockDb.runTransaction.mockReset().mockImplementation(async (fn) => fn());
    mockLog.log.mockClear();
    mockRbac.isSuperAdmin.mockReset().mockReturnValue(false);
    mockRbac.canAccessEmployeeData.mockReset().mockResolvedValue(true);
    for (const m of [mockAdminModel, mockEmployeeModel])
        for (const f of Object.values(m)) f.mockReset();
});

describe('EmailAccountsService — who else uses this address', () => {
    test('lists employees and admins, case-insensitively, excluding the record being edited', async () => {
        wireAll([EMP(1), EMP(2)], [ADM(9)]);
        const out = await Email.accountsWithEmail('  Awa.K@Example.com ', { excludeEmployeeId: 2 });
        expect(mockDb.all.mock.calls[0][1]).toEqual(['awa.k@example.com']);
        expect(out.map((m) => `${m.kind}:${m.id}`)).toEqual(['employee:1', 'admin:9']);
        expect(out[0].label).toBe('Awa K1 (E1)');
        expect(out[1].label).toBe('adm9 (admin)');
    });

    test('a blank address is nobody', async () => {
        expect(await Email.accountsWithEmail('')).toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('uniqueEmployeeByEmail: one row → the row; two rows → ambiguous, no row; none → neither', async () => {
        wireAll([EMP(1)], []);
        expect(await Email.uniqueEmployeeByEmail('a@x.io')).toEqual({
            row: EMP(1),
            ambiguous: false,
        });
        wireAll([EMP(1), EMP(2)], []);
        expect(await Email.uniqueEmployeeByEmail('a@x.io')).toEqual({ row: null, ambiguous: true });
        wireAll([], []);
        expect(await Email.uniqueEmployeeByEmail('a@x.io')).toEqual({
            row: null,
            ambiguous: false,
        });
    });

    test('the advisory names only what the actor may see and counts the rest', async () => {
        wireAll([EMP(1), EMP(2)], [ADM(9)]);
        // SuperAdmin: every name.
        mockRbac.isSuperAdmin.mockReturnValue(true);
        let d = await Email.describe(req({ userType: 'admin', role: 'superadmin' }, tFn), 'a@x.io');
        expect(d).toMatchObject({ count: 3, who: 'Awa K1 (E1), Awa K2 (E2), adm9 (admin)' });
        // Scoped admin: employee 2 is outside their scope → counted, not named.
        mockRbac.isSuperAdmin.mockReturnValue(false);
        mockEmployeeModel.findById.mockImplementation(async (id) => EMP(id));
        mockRbac.canAccessEmployeeData.mockImplementation(async (u, row) => Number(row.id) !== 2);
        d = await Email.describe(req({ userType: 'admin', role: 'localadmin' }, tFn), 'a@x.io');
        expect(d.who).toBe('Awa K1 (E1), adm9 (admin) + [flash:email_shared_others:1]');
        // An employee on their own profile: a count and nothing else.
        d = await Email.describe(req({ userType: 'employee', id: 5 }, tFn), 'a@x.io');
        expect(d).toMatchObject({ count: 3, who: '[flash:email_shared_others:3]' });
        expect(await Email.advisory(req({ userType: 'employee', id: 5 }, tFn), 'a@x.io')).toBe(
            '[flash:email_shared:3:[flash:email_shared_others:3]]'
        );
        wireAll([], []);
        expect(
            await Email.advisory(req({ userType: 'employee', id: 5 }, tFn), 'nobody@x.io')
        ).toBeNull();
    });
});

describe('signing in by e-mail refuses ambiguity instead of guessing', () => {
    const ctx = { ip: '10.0.0.1', get: () => 'ua' };

    test('admin: two admins share the address → policy refusal, no password compared, no lockout tally', async () => {
        const AuthService = require('../../src/services/AuthService');
        mockAdminModel.findByUsername.mockResolvedValue(null);
        wireAll([], [ADM(1), ADM(2)]);
        const r = await AuthService.login('shared@x.io', 'whatever', ctx);
        expect(r).toMatchObject({ success: false, policyRefusal: true, code: 'EMAIL_AMBIGUOUS' });
        expect(mockAdminModel.findById).not.toHaveBeenCalled();
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'LOGIN_FAILED',
                details: expect.stringContaining('shared by several admin accounts'),
            })
        );
    });

    test('admin: a unique address still signs in (resolved by id, then the usual checks)', async () => {
        const AuthService = require('../../src/services/AuthService');
        mockAdminModel.findByUsername.mockResolvedValue(null);
        wireAll([], [ADM(1)]);
        mockAdminModel.findById.mockResolvedValue({ ...ADM(1), isActive: false });
        const r = await AuthService.login('one@x.io', 'x', ctx);
        expect(mockAdminModel.findById).toHaveBeenCalledWith(1);
        expect(r).toEqual({ success: false, message: 'Invalid credentials' });
    });

    test('employee: two employees share the address → policy refusal with the same code', async () => {
        const EmployeeAuthService = require('../../src/services/EmployeeAuthService');
        mockEmployeeModel.findByUsername.mockResolvedValue(null);
        wireAll([EMP(1), EMP(2)], []);
        const r = await EmployeeAuthService.login('shared@x.io', 'whatever', ctx);
        expect(r).toMatchObject({ success: false, policyRefusal: true, code: 'EMAIL_AMBIGUOUS' });
        expect(mockEmployeeModel.findById).not.toHaveBeenCalled();
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'EMPLOYEE_LOGIN_FAILED' })
        );
    });

    test('the reason lives in the AUDIT line only — the page keeps the generic sentence (anti-enumeration)', () => {
        // The auth services write the explicit LOGIN_FAILED line; the strategy and
        // the page stay generic, so nobody can probe which addresses are shared.
        const mw = read('src/middleware/auth.js');
        expect(mw).toMatch(/return done\(null, false, \{ message: 'Invalid credentials' \}\);/);
        expect(mw).toMatch(
            /if \(!policyRefusal\) await recordLoginAttempt\(username, ctx\.ip, false\);/
        );
        for (const f of ['src/services/AuthService.js', 'src/services/EmployeeAuthService.js']) {
            expect(read(f)).toMatch(
                /shared by several (admin|employee) accounts \(username required\)/
            );
        }
        const ctrl = read('src/controllers/AuthController.js');
        // \s* on purpose: prettier wraps this flash across three lines. The
        // claim is that the page still shows the GENERIC sentence — the
        // anti-enumeration rule — not that the call fits on one line.
        expect(ctrl).toMatch(
            /req\.flash\(\s*'error',\s*req\.t \? req\.t\('flash:auth_invalid_credentials'\)/
        );
    });
});

describe('self-service password reset serves EVERY eligible account carrying the address', () => {
    test('one admin + two employees (one inactive) share the address → two tokens, one per live account', async () => {
        const Reset = require('../../src/services/PasswordResetService');
        mockAdminModel.findByUsername.mockResolvedValue(null);
        mockEmployeeModel.findByUsername.mockResolvedValue(null);
        mockDb.all.mockImplementation(async (sql) => {
            if (/FROM admins/.test(sql))
                return [{ id: 9, username: 'adm9', email: 'shared@x.io', isActive: true }];
            if (/FROM employees/.test(sql))
                return [
                    {
                        id: 1,
                        username: 'u1',
                        email: 'shared@x.io',
                        isActive: true,
                        isAccountActive: true,
                    },
                    {
                        id: 2,
                        username: 'u2',
                        email: 'shared@x.io',
                        isActive: false,
                        isAccountActive: true,
                    },
                ];
            return [];
        });
        const r = await Reset.requestReset('Shared@X.io', '10.0.0.1');
        expect(r.sent).toBe(true);
        expect(r.resets.map((x) => `${x.subjectType}:${x.subjectId}`)).toEqual([
            'admin:9',
            'employee:1',
        ]);
        expect(new Set(r.resets.map((x) => x.rawToken)).size).toBe(2);
        // older callers still get the first token on the top level
        expect(r.rawToken).toBe(r.resets[0].rawToken);
        const inserts = mockDb.run.mock.calls.filter(([s]) =>
            /INSERT INTO password_reset_tokens/.test(s)
        );
        expect(inserts.map(([, p]) => `${p[0]}:${p[1]}`)).toEqual(['admin:9', 'employee:1']);
    });

    test('a username names exactly one account, admin first — unchanged', async () => {
        const Reset = require('../../src/services/PasswordResetService');
        mockAdminModel.findByUsername.mockResolvedValue({
            id: 3,
            username: 'root',
            email: 'r@x.io',
            isActive: true,
        });
        const r = await Reset.requestReset('root');
        expect(r.resets).toHaveLength(1);
        expect(r.resets[0]).toMatchObject({ subjectType: 'admin', subjectId: 3, name: 'root' });
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('nothing eligible → sent:false and no token', async () => {
        const Reset = require('../../src/services/PasswordResetService');
        mockAdminModel.findByUsername.mockResolvedValue(null);
        mockEmployeeModel.findByUsername.mockResolvedValue(null);
        wireAll([], []);
        expect(await Reset.requestReset('nobody@x.io')).toEqual({ sent: false, resets: [] });
        expect(mockDb.run.mock.calls.filter(([s]) => /INSERT/.test(s))).toHaveLength(0);
    });

    test('the controller sends one mail per account and names the account when there are several', () => {
        const src = read('src/controllers/AuthController.js');
        expect(src).toMatch(/for \(const reset of resets\)/);
        expect(src).toMatch(/mail_reset_account/);
        for (const lang of ['fr', 'en'])
            expect(JSON.parse(read(`locales/${lang}/chrome.json`)).mail_reset_account).toMatch(
                /\{\{name\}\}/
            );
    });
});

describe('the old refusals are gone; the advisory is everywhere an address is entered', () => {
    test('controllers no longer refuse a duplicate address', () => {
        for (const f of [
            'src/controllers/EmployeeController.js',
            'src/controllers/AdminController.js',
            'src/controllers/AuthController.js',
            'src/services/AuthService.js',
            'src/controllers/InvitationController.js',
            'src/services/OnboardingService.js',
        ]) {
            const src = read(f);
            expect(src).not.toMatch(
                /flash:email_exists|flash:admin_email_exists|flash:profile_email_taken|onbx_q_employee_exists|already used by another employee/
            );
            expect(src).toMatch(/EmailAccountsService/);
        }
    });

    test('a warning flash exists as a third kind and is rendered', () => {
        expect(read('server.js')).toMatch(/res\.locals\.warnings = req\.flash\('warning'\)/);
        expect(read('views/partials/flash.ejs')).toMatch(/warnings\.forEach[\s\S]*alert-warning/);
    });

    test('every e-mail field carries the inline advisory, and its endpoint is mounted', () => {
        for (const v of [
            'views/pages/employees/create.ejs',
            'views/pages/employees/edit.ejs',
            'views/pages/admins/create.ejs',
            'views/pages/admins/show.ejs',
            'views/pages/account/profile.ejs',
        ]) {
            const src = read(v);
            expect(src).toMatch(/data-email-check/);
            expect(src).toMatch(/email-shared-note/);
            expect(src).toMatch(/\/js\/email-shared-check\.js/);
        }
        expect(read('src/routes/index.js')).toMatch(
            /router\.get\('\/api\/accounts\/email-check', requireAuth/
        );
        expect(read('public/js/email-shared-check.js')).toMatch(/\/api\/accounts\/email-check/);
    });

    test('SSO first-time match and LMS completion require an unambiguous address', () => {
        expect(read('src/services/SsoService.js')).toMatch(
            /uniqueEmployeeByEmail\(\s*email,\s*\{\s*activeLoginOnly: true\s*\}\s*\)[\s\S]*if \(ambiguous\)[\s\S]*return null/
        );
        expect(read('src/services/LmsService.js')).toMatch(
            /uniqueEmployeeByEmail\(\s*norm\.employeeEmail\s*\)/
        );
    });

    test('migration 107 drops the admins e-mail uniqueness and indexes both lower(email) columns', () => {
        const m = read('db/postgres/107_shared_email.sql');
        expect(m).toMatch(/DROP CONSTRAINT IF EXISTS admins_email_key/);
        expect(m).toMatch(/idx_admins_email_lower/);
        expect(m).toMatch(/idx_employees_email_lower/);
        expect(m).toMatch(/INSERT INTO schema_meta\(key, value\) VALUES \('107_shared_email'/);
    });

    test('FR/EN keys exist with parity', () => {
        for (const [ns, keys] of [
            ['flash', ['email_shared', 'email_shared_others']],
            ['admin', ['email_shared_note', 'onbx_q_email_shared']],
            ['chrome', ['mail_reset_account']],
        ]) {
            const fr = JSON.parse(read(`locales/fr/${ns}.json`)),
                en = JSON.parse(read(`locales/en/${ns}.json`));
            for (const k of keys) {
                expect(typeof fr[k]).toBe('string');
                expect(typeof en[k]).toBe('string');
            }
        }
    });
});
