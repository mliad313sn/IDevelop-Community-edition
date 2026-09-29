'use strict';
/**
 * Lot B — B1: the Comptes / Accounts console (InvitationController) and the
 * account classification it shares with the roster (EmployeeModel).
 *
 * DB mocked. The regressions pinned here are the ones the probes measured on
 * idevelop: placeholder ORDER in the counters query (an array bound to
 * `? * interval '1 day'` made every render fail), per-id scope on the bulk
 * endpoint, the one-time credentials sheet for people without an address, and
 * the "already signed in" skip that stops a resend overwriting a chosen password.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(() => Promise.resolve([])),
    run: jest.fn(() => Promise.resolve()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(() => Promise.resolve()) }));
const mockScopedIds = jest.fn();
jest.mock('../../src/utils/rbacScope', () => ({ scopedEmployeeIds: mockScopedIds }));
jest.mock('../../src/models/LoginAttemptModel', () => ({
    clearFailedAttempts: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/services/MovementService', () => ({
    recordAccount: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/services/OnboardingCredentialService', () => ({ issueAndSend: jest.fn() }));
// 3.23.20 (C3): these accounts are NOT migrated to SSO (the migrated path has its own tests, c320-sso-invite-guards).
jest.mock('../../src/services/SsoInviteService', () => ({
    isMigrated: jest.fn(async () => false),
    requeue: jest.fn(),
    statusFor: jest.fn(async () => new Map()),
}));

const db = require('../../src/config/database');
const LogService = require('../../src/services/LogService');
const LoginAttemptModel = require('../../src/models/LoginAttemptModel');
const MovementService = require('../../src/services/MovementService');
const Cred = require('../../src/services/OnboardingCredentialService');
const EmployeeModel = require('../../src/models/EmployeeModel');
const Controller = require('../../src/controllers/InvitationController');

const superAdmin = { id: 1, userType: 'admin', role: 'superadmin', username: 'admin' };
const localAdmin = {
    id: 631,
    userType: 'admin',
    role: 'localadmin',
    username: 'qa.local',
    permissions: ['reset_employee_password'],
};

function reqOf(user, { body = {}, params = {}, query = {} } = {}) {
    return {
        user,
        body,
        params,
        query,
        ip: '127.0.0.1',
        id: 'rq1',
        get: () => 'jest',
        t: (k, p) => (p && p.n !== undefined ? `${k}|n=${p.n}` : k),
    };
}
function resOf() {
    const r = { code: 200, headers: {} };
    r.status = (c) => {
        r.code = c;
        return r;
    };
    r.json = (j) => {
        r.body = j;
        return r;
    };
    r.send = (b) => {
        r.body = b;
        return r;
    };
    r.redirect = (c, u) => {
        r.redirectCode = u === undefined ? 302 : c;
        r.redirectedTo = u === undefined ? c : u;
        return r;
    };
    r.render = (v, d) => {
        r.view = v;
        r.data = d;
        return r;
    };
    r.setHeader = (k, v) => {
        r.headers[k] = v;
        return r;
    };
    return r;
}

beforeEach(() => {
    db.get.mockReset();
    db.all.mockReset();
    db.all.mockResolvedValue([]);
    db.run.mockReset();
    db.run.mockResolvedValue();
    mockScopedIds.mockReset();
    LogService.log.mockReset();
    LogService.log.mockResolvedValue();
    LoginAttemptModel.clearFailedAttempts.mockReset();
    LoginAttemptModel.clearFailedAttempts.mockResolvedValue();
    MovementService.recordAccount.mockReset();
    MovementService.recordAccount.mockResolvedValue();
    Cred.issueAndSend.mockReset();
});

describe('account classification SQL (EmployeeModel.accountStateSql)', () => {
    test('every parameter is bound in the TEXTUAL order of its placeholder', () => {
        const { sql, params } = EmployeeModel.accountStateSql('e.id = ANY(?)', [[1, 2]], {
            maxAttempts: 5,
            lockoutMinutes: 30,
            expiryDays: 14,
            staleDays: 7,
        });
        // 6 own placeholders, then the caller's — and the caller's WHERE is last in the text.
        const before = sql.slice(0, sql.indexOf('WHERE e.id = ANY(?)'));
        expect((before.match(/\?/g) || []).length).toBe(6);
        expect(params).toEqual([5, 14, 14, 7, 30, 30, [1, 2]]);
    });

    test('the expiry/stale branches only fire for an invitation that was never used', () => {
        const { sql } = EmployeeModel.accountStateSql('1=1', [], {});
        const order = [
            'locked',
            'disabled',
            "'sso'",
            "'none'",
            "'active'",
            'never_invited',
            'expired',
            'stale',
            'pending',
        ].map((token) => sql.indexOf(token));
        expect(order).toEqual([...order].sort((a, b) => a - b)); // the CASE arms keep their priority
        expect(sql).toContain("WHEN a.last_login_at IS NOT NULL THEN 'active'");
    });

    test('decorateAccountRow derives "locked until" from the last failure + the lockout window', () => {
        const at = new Date('2026-09-10T08:00:00Z');
        const locked = EmployeeModel.decorateAccountRow(
            { state: 'locked', lastFailedAt: at, email: null },
            30
        );
        expect(locked.lockedUntil.toISOString()).toBe('2026-09-10T08:30:00.000Z');
        expect(locked.noEmail).toBe(true);
        const active = EmployeeModel.decorateAccountRow(
            { state: 'active', lastFailedAt: at, email: 'a@b.io' },
            30
        );
        expect(active.lockedUntil).toBeNull();
        expect(active.noEmail).toBe(false);
    });

    test('accountStates asks for nothing when the id list is empty', async () => {
        expect((await EmployeeModel.accountStates([])).size).toBe(0);
        expect(db.all).not.toHaveBeenCalled();
    });
});

describe('the console list', () => {
    test('headline counters bind the population BEFORE the dormant threshold (the 400 that killed the page)', async () => {
        mockScopedIds.mockResolvedValue([142, 157]);
        db.get.mockResolvedValue({ total: 2, neverLogged: 1, dormant: 0 });
        const counters = await Controller._counters(
            localAdmin,
            { siteId: 11 },
            { expiryDays: 14, dormantDays: 30, policy: { maxAttempts: 5, lockoutMinutes: 30 } }
        );
        expect(counters.total).toBe(2);
        const [sql, params] = db.get.mock.calls[0];
        // The population is a CTE, so its placeholders come first in the text and
        // `dormantDays` is the LAST parameter — the scope array can never land on
        // `? * interval '1 day'` (invalid input syntax for type double precision).
        const cte = sql.slice(
            sql.indexOf('WITH pop AS ('),
            sql.indexOf('SELECT COUNT(*)::int AS total')
        );
        expect((cte.match(/\?/g) || []).length).toBe(params.length - 1);
        expect(params[params.length - 1]).toBe(30);
        expect(params).toContain(11);
    });

    test('an empty scope lists nobody instead of everybody', async () => {
        mockScopedIds.mockResolvedValue([]);
        const { fromSql } = await Controller._population(
            localAdmin,
            { state: '', q: '' },
            { expiryDays: 14, dormantDays: 30, policy: {} }
        );
        expect(fromSql).toContain('1 = 0');
    });

    test('search covers the username (the identifier a helpdesk ticket names)', async () => {
        mockScopedIds.mockResolvedValue(null);
        const { fromSql, params } = await Controller._population(
            superAdmin,
            { q: 'qa.employee' },
            { expiryDays: 14, dormantDays: 30, policy: {} }
        );
        expect(fromSql).toContain('e.username ILIKE ?');
        expect(params.filter((p) => p === '%qa.employee%')).toHaveLength(4);
    });

    test('an unknown ?state= is ignored rather than producing an empty list', async () => {
        mockScopedIds.mockResolvedValue(null);
        const filters = Controller._filters(reqOf(superAdmin, { query: { state: 'DROP' } }));
        expect(filters.state).toBe('');
    });

    test('the legacy /admin/invitations link keeps working and carries its query', () => {
        const res = resOf();
        Controller.legacyPage(reqOf(superAdmin, { query: { siteId: '11' } }), res);
        expect(res.redirectCode).toBe(302);
        expect(res.redirectedTo).toBe('/admin/accounts?siteId=11');
    });

    test('the CSV is the list as shown: 16 translated headers, BOM, and an audit row', async () => {
        mockScopedIds.mockResolvedValue(null);
        db.all.mockResolvedValue([
            {
                id: 142,
                employeeNumber: 'MOUA1184',
                lastName: 'MORENO',
                firstName: 'Daniel',
                siteName: 'S',
                departmentName: 'D',
                roleName: 'R',
                username: 'MOUA1184',
                email: null,
                kind: 'local',
                state: 'never_invited',
                accountActive: true,
            },
        ]);
        const res = resOf();
        await Controller.exportCsv(reqOf(superAdmin, { query: { siteId: '11' } }), res);
        expect(res.headers['Content-Type']).toBe('text/csv; charset=utf-8');
        expect(String(res.body).charCodeAt(0)).toBe(0xfeff); // Excel BOM
        expect(String(res.body).split('\r\n')[1].split(',')).toHaveLength(16);
        expect(LogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'ACCOUNTS_EXPORTED' })
        );
    });
});

describe('bulk actions', () => {
    test('refusals carry a stable code AND a sentence', async () => {
        const cases = [
            [{ action: 'nope', employeeIds: [1] }, 400, 'bad_action'],
            [{ action: 'unlock', employeeIds: [] }, 400, 'no_selection'],
            [
                { action: 'unlock', employeeIds: Array.from({ length: 501 }, (_, i) => i + 1) },
                400,
                'batch_too_large',
            ],
            [{ action: 'policy', policy: 'nope', employeeIds: [1] }, 400, 'bad_policy'],
        ];
        for (const [body, status, code] of cases) {
            const res = resOf();
            await Controller.bulk(reqOf(superAdmin, { body }), res);
            expect([res.code, res.body.code]).toEqual([status, code]);
            expect(res.body.error).toBe(`admin:acc_err_${code}`);
        }
        expect(db.run).not.toHaveBeenCalled();
    });

    test('the authentication policy stays SuperAdmin-only', async () => {
        const res = resOf();
        await Controller.bulk(
            reqOf(localAdmin, {
                body: { action: 'policy', policy: 'sso_only', employeeIds: [142] },
            }),
            res
        );
        expect([res.code, res.body.code]).toEqual([403, 'policy_superadmin_only']);
    });

    test('an id outside the caller scope is counted and never acted on', async () => {
        mockScopedIds.mockResolvedValue([142, 157]);
        const res = resOf();
        await Controller.bulk(
            reqOf(localAdmin, { body: { action: 'unlock', employeeIds: [90] } }),
            res
        );
        expect([res.code, res.body.code, res.body.outOfScope]).toEqual([403, 'out_of_scope', 1]);
        expect(LoginAttemptModel.clearFailedAttempts).not.toHaveBeenCalled();
    });

    test('unlock clears BOTH identifiers the person could have typed, audits and feeds the account stream', async () => {
        mockScopedIds.mockResolvedValue([142]);
        jest.spyOn(EmployeeModel, 'findById').mockResolvedValue({
            id: 142,
            employeeNumber: 'MOUA1184',
            username: 'MOUA1184',
            email: 'm@x.io',
            isActive: true,
        });
        const res = resOf();
        await Controller.bulk(
            reqOf(localAdmin, { body: { action: 'unlock', employeeIds: [142] } }),
            res
        );
        expect(res.body.results.done).toBe(1);
        expect(LoginAttemptModel.clearFailedAttempts.mock.calls.map((c) => c[0])).toEqual([
            'MOUA1184',
            'm@x.io',
        ]);
        expect(LogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'EMPLOYEE_ACCOUNT_UNLOCKED', entityId: 142 })
        );
        expect(MovementService.recordAccount).toHaveBeenCalledWith(
            142,
            expect.objectContaining({ toLabel: 'unlocked' })
        );
        // and it answers the manager's open request of the same kind
        expect(db.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE account_requests'), [
            631,
            142,
            'unlock',
        ]);
        EmployeeModel.findById.mockRestore();
    });

    test('a resend NEVER silently overwrites a password someone already chose', async () => {
        mockScopedIds.mockResolvedValue([142]);
        db.get.mockResolvedValue({ active: true }); // password + login + already signed in
        const res = resOf();
        await Controller.bulk(
            reqOf(localAdmin, { body: { action: 'resend', employeeIds: [142] } }),
            res
        );
        expect(res.body.results).toMatchObject({ done: 0, skippedActive: 1 });
        expect(Cred.issueAndSend).not.toHaveBeenCalled();
    });

    test('someone without an address still gets credentials — once, on the sheet', async () => {
        mockScopedIds.mockResolvedValue([142]);
        db.get.mockResolvedValue({ active: false });
        jest.spyOn(EmployeeModel, 'findById').mockResolvedValue({
            id: 142,
            employeeNumber: 'MOUA1184',
            firstName: 'M',
            lastName: 'O',
            isActive: true,
        });
        Cred.issueAndSend.mockResolvedValue({
            success: true,
            emailed: false,
            username: 'MOUA1184',
            tempPassword: 'S3cret!',
            emailStatus: 'no_email',
        });
        const res = resOf();
        await Controller.bulk(
            reqOf(localAdmin, { body: { action: 'resend', employeeIds: [142] } }),
            res
        );
        expect(Cred.issueAndSend).toHaveBeenCalledWith(
            142,
            localAdmin,
            expect.anything(),
            expect.objectContaining({ allowNoEmail: true })
        );
        expect(res.body.results.credentials).toEqual([
            expect.objectContaining({
                username: 'MOUA1184',
                tempPassword: 'S3cret!',
                reason: 'no_email',
            }),
        ]);
        expect(res.body.results.emailed).toBe(0);
        EmployeeModel.findById.mockRestore();
    });

    test('declining a manager request demands a note', async () => {
        const res = resOf();
        await Controller.declineRequest(
            reqOf(localAdmin, { params: { id: '7' }, body: { note: '  ' } }),
            res
        );
        expect([res.code, res.body.code]).toEqual([400, 'reason_required']);
        expect(db.run).not.toHaveBeenCalled();
    });
});
