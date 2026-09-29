'use strict';
/**
 * COMMITTEE — LOT P (development plans), part 2: IDP / PIP creation and
 * sign-off, and the three counting queries.
 *
 * Reproduced by execution against the dev database (rolled back) before the fix:
 *   F4  createManualPlan(89) with a draft plan open → raw 23505
 *       "uq_idp_open_per_employee" (an HTTP 500); proposeDirect(88) with a
 *       proposed PIP open → raw 23505 "uq_pip_open_per_employee".
 *   F6  proposeDirect(startsOn 2026-01-01, endsOn 2026-03-01) → created;
 *       closed → dashboard measuredSuccess counted it; endsOn<startsOn accepted.
 *   F8  plan 6 set 'cancelled' → signOff employee then supervisor →
 *       { activated: true } (plan still cancelled, idp.activated fired).
 *   F9  1 draft + 1 cancelled IDP → exec measure "Active IDPs" = 2.
 *   F10 with idp_signoffs.user_type present: user_type null; an ADMIN signing
 *       the employee slot → { activated: true }.
 * After the fix, same probe: F4 IDP_OPEN_EXISTS / PIP_OPEN_EXISTS with status
 * 409; F6 INVALID_PERIOD 400 and measuredSuccess 0 on the back-dated row;
 * F8 IDP_NOT_DRAFT on both signatures; F9 = 1; F10 user_type written, admin
 * refused on the employee slot, a stray admin employee-row ignored on read.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
const mockNotify = jest.fn();
jest.mock('../../src/services/NotificationService', () => ({ notify: (...a) => mockNotify(...a) }));
jest.mock('../../src/services/MakerCheckerService', () => ({
    register: jest.fn(),
    submit: jest.fn(),
}));
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: () => false,
    isViewer: () => false,
    hasPermission: () => true,
    scopeFilter: async () => ({ clause: '', params: [] }),
    getFilteredEmployees: async () => [],
}));

const IDPService = require('../../src/services/IDPService');
const PipService = require('../../src/services/PipService');
const TalentActionsController = require('../../src/controllers/TalentActionsController');
const DashboardController = require('../../src/controllers/DashboardController');

const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
const norm = (s) => String(s).replace(/\s+/g, ' ');
const runs = () => mockDb.run.mock.calls.map(([s, p]) => [norm(s), p]);
const gets = () => mockDb.get.mock.calls.map(([s, p]) => [norm(s), p]);
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ lastID: 55, changes: 1 });
    mockDb.runTransaction.mockReset().mockImplementation(async (fn) => fn());
    mockDb.runInSavepoint.mockReset().mockImplementation(async (fn) => fn());
    mockNotify.mockReset().mockResolvedValue(null);
    IDPService._resetSchemaCache();
});

// ---------------------------------------------------------------------------
// F4 — one open plan per person, answered as a 409 (not a raw 23505 → 500)
// ---------------------------------------------------------------------------
describe('F4 createManualPlan(): a second open IDP is a 409, never a raw unique violation', () => {
    test('pre-check: an existing draft/active plan refuses BEFORE the transaction opens', async () => {
        mockDb.get.mockResolvedValueOnce({ id: 6 });
        await expect(
            IDPService.createManualPlan({ employeeId: 89, skillIds: [] })
        ).rejects.toMatchObject({
            code: 'IDP_OPEN_EXISTS',
            status: 409,
            expose: true,
            employeeId: 89,
            existingId: 6,
        });
        expect(gets()[0][0]).toMatch(
            /FROM idp_plans WHERE employee_id = \? AND status IN \('draft', 'active'\)/i
        );
        expect(mockDb.runTransaction).not.toHaveBeenCalled();
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('race fallback: a 23505 on uq_idp_open_per_employee inside the transaction is the same 409', async () => {
        mockDb.get.mockResolvedValueOnce(null);
        const dup = Object.assign(
            new Error('duplicate key value violates unique constraint "uq_idp_open_per_employee"'),
            { code: '23505', constraint: 'uq_idp_open_per_employee' }
        );
        mockDb.run.mockRejectedValueOnce(dup);
        await expect(
            IDPService.createManualPlan({ employeeId: 89, skillIds: [] })
        ).rejects.toMatchObject({ code: 'IDP_OPEN_EXISTS', status: 409 });
    });

    test('any other failure is re-thrown untouched', async () => {
        mockDb.get.mockResolvedValueOnce(null);
        mockDb.run.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '42P01' }));
        await expect(
            IDPService.createManualPlan({ employeeId: 89, skillIds: [] })
        ).rejects.toMatchObject({ code: '42P01' });
    });

    test('no open plan: the draft is created as before', async () => {
        mockDb.get.mockResolvedValueOnce(null);
        await expect(
            IDPService.createManualPlan({ employeeId: 89, skillIds: [] })
        ).resolves.toEqual({ idpId: 55, objectives: 0 });
        expect(runs()[0][0]).toMatch(/INSERT INTO idp_plans/i);
    });
});

describe('F4b proposeDirect(): a second open PIP is a 409, never a raw unique violation', () => {
    const args = { employeeId: 88, actor: SUPER, startsOn: iso(1), endsOn: iso(90), summary: 'x' };

    test('pre-check refuses before any INSERT', async () => {
        mockDb.get.mockResolvedValueOnce({ id: 12 });
        await expect(PipService.proposeDirect(args)).rejects.toMatchObject({
            code: 'PIP_OPEN_EXISTS',
            status: 409,
            expose: true,
            employeeId: 88,
            existingId: 12,
        });
        expect(gets()).toHaveLength(1);
        expect(gets()[0][0]).toMatch(
            /FROM pips WHERE employee_id = \? AND state IN \('proposed','approved','active'\)/i
        );
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('race fallback: 23505 on uq_pip_open_per_employee → same 409', async () => {
        mockDb.get
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(
                Object.assign(
                    new Error(
                        'duplicate key value violates unique constraint "uq_pip_open_per_employee"'
                    ),
                    { code: '23505', constraint: 'uq_pip_open_per_employee' }
                )
            );
        await expect(PipService.proposeDirect(args)).rejects.toMatchObject({
            code: 'PIP_OPEN_EXISTS',
            status: 409,
        });
    });

    test('the automated 9-box path (skipIfOpen) keeps its ON CONFLICT race guard and does NOT pre-check', async () => {
        mockDb.get.mockResolvedValueOnce(null); // the INSERT … DO NOTHING returned no row
        await expect(PipService.proposeDirect({ ...args, skipIfOpen: true })).resolves.toBeNull();
        expect(gets()).toHaveLength(1);
        expect(gets()[0][0]).toMatch(
            /INSERT INTO pips .* ON CONFLICT \(employee_id\) WHERE state IN \('proposed','approved','active'\) DO NOTHING/i
        );
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('no open PIP: created and the employee notified, as before', async () => {
        mockDb.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 61 });
        await expect(PipService.proposeDirect(args)).resolves.toEqual({ id: 61 });
        expect(mockNotify).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'pip.created', userId: 88 })
        );
    });
});

// ---------------------------------------------------------------------------
// F6 — a PIP period must be observable
// ---------------------------------------------------------------------------
describe('F6 PIP period validation', () => {
    test.each([
        [
            'ends before it starts',
            { startsOn: '2026-12-01', endsOn: '2026-11-01' },
            /after its start date/,
        ],
        [
            'ends the day it starts',
            { startsOn: '2027-01-10', endsOn: '2027-01-10' },
            /after its start date/,
        ],
        [
            'whole period already in the past',
            { startsOn: '2026-01-01', endsOn: '2026-03-01' },
            /already be in the past/,
        ],
        ['end date yesterday', { startsOn: iso(-30), endsOn: iso(-1) }, /already be in the past/],
        ['unparseable end date', { startsOn: iso(0), endsOn: 'soon' }, /valid date/],
    ])('%s → 400 INVALID_PERIOD, nothing written', async (_label, period, msg) => {
        await expect(
            PipService.proposeDirect({ employeeId: 285, actor: SUPER, summary: 'x', ...period })
        ).rejects.toMatchObject({
            code: 'INVALID_PERIOD',
            status: 400,
            expose: true,
            message: expect.stringMatching(msg),
        });
        expect(mockDb.get).not.toHaveBeenCalled();
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a forward period (the 9-box trigger uses today → +90) passes; absent dates are left to the caller', () => {
        expect(PipService.validatePeriod({ startsOn: iso(0), endsOn: iso(90) })).toEqual({
            startsOn: iso(0),
            endsOn: iso(90),
        });
        expect(PipService.validatePeriod({ startsOn: null, endsOn: null })).toEqual({
            startsOn: null,
            endsOn: null,
        });
        expect(
            PipService.validatePeriod({
                startsOn: new Date(Date.now() + 86400000),
                endsOn: iso(10),
            }).endsOn
        ).toBe(iso(10));
    });
});

// ---------------------------------------------------------------------------
// F8 / F10 — sign-off
// ---------------------------------------------------------------------------
describe('F8 signOff(): only a draft can be signed; activation is what the UPDATE returned', () => {
    /** db.get keyed on SQL: plan row, user_type column presence, activation UPDATE. */
    const wire = ({ status = 'draft', column = false, activatedRow = { id: 6 } } = {}) =>
        mockDb.get.mockImplementation(async (sql) => {
            const s = norm(sql);
            if (/information_schema\.columns/i.test(s)) return column ? { present: 1 } : null;
            if (/FROM idp_plans WHERE id/i.test(s)) return { id: 6, employeeId: 89, status };
            if (/UPDATE idp_plans SET status = 'active'/i.test(s)) return activatedRow;
            if (/FROM employees WHERE id/i.test(s)) return { sid: 96 };
            return null;
        });
    const sign = (over = {}) =>
        IDPService.signOff({
            idpId: 6,
            role: 'supervisor',
            userId: 96,
            ip: '127.0.0.1',
            ua: 'ua',
            ...over,
        });

    test.each([['cancelled'], ['completed'], ['archived'], ['active']])(
        'a %s plan is refused (409 IDP_NOT_DRAFT) and no signature is written',
        async (status) => {
            wire({ status });
            await expect(sign()).rejects.toMatchObject({
                code: 'IDP_NOT_DRAFT',
                status: 409,
                expose: true,
            });
            expect(mockDb.run).not.toHaveBeenCalled();
            expect(mockNotify).not.toHaveBeenCalled();
        }
    );

    test('a missing plan is a 404', async () => {
        mockDb.get.mockResolvedValue(null);
        await expect(sign()).rejects.toMatchObject({ status: 404 });
    });

    test('one signature only → activated:false and NO activation UPDATE attempted', async () => {
        wire();
        mockDb.all.mockResolvedValue([{ role: 'supervisor' }]);
        await expect(sign()).resolves.toEqual({ activated: false });
        expect(gets().some(([s]) => /UPDATE idp_plans SET status = 'active'/i.test(s))).toBe(false);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('both signatures, UPDATE returns the row → activated:true and idp.activated goes out', async () => {
        wire();
        // 3.23.18: the reviewer is resolved through ReportingLineService (active
        // supervisor 96); every other all() answers the signoff rows.
        mockDb.all.mockImplementation(async (sql) =>
            /LEFT JOIN employees sup/i.test(norm(sql))
                ? [{ employeeId: 89, employeeActive: true, supId: 96, supName: 'S' }]
                : [{ role: 'employee' }, { role: 'supervisor' }]
        );
        await expect(sign()).resolves.toEqual({ activated: true });
        const upd = gets().find(([s]) => /UPDATE idp_plans SET status = 'active'/i.test(s));
        expect(upd[0]).toMatch(/WHERE id = \? AND status = 'draft' RETURNING id/i);
        expect(mockNotify).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'idp.activated', userId: 89 })
        );
        expect(mockNotify).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'idp.activated', userId: 96 })
        );
    });

    test('both signatures but the guarded UPDATE changed nothing → activated:false, NO notification', async () => {
        wire({ activatedRow: null });
        mockDb.all.mockResolvedValue([{ role: 'employee' }, { role: 'supervisor' }]);
        await expect(sign()).resolves.toEqual({ activated: false });
        expect(mockNotify).not.toHaveBeenCalled();
    });

    describe('F10 idp_signoffs.user_type (migration 104, another lot) — works before AND after the column exists', () => {
        test('column absent: the INSERT does not name user_type', async () => {
            wire({ column: false });
            await sign({ userType: 'admin' });
            const [[sql, params]] = runs();
            expect(sql).toMatch(/INSERT INTO idp_signoffs \(idp_id, role, user_id, ip, ua\)/i);
            expect(params).toEqual([6, 'supervisor', 96, '127.0.0.1', 'ua']);
        });

        test('column present: user_type is written VERBATIM (employee | manager | admin — the CHECK on the column)', async () => {
            wire({ column: true });
            await sign({ userType: 'admin', userId: 1 });
            expect(runs()[0][0]).toMatch(
                /INSERT INTO idp_signoffs \(idp_id, role, user_id, user_type, ip, ua\)/i
            );
            expect(runs()[0][1]).toEqual([6, 'supervisor', 1, 'admin', '127.0.0.1', 'ua']);
            mockDb.run.mockClear();
            await sign({ userType: 'manager', userId: 96 });
            expect(runs()[0][1][3]).toBe('manager');
            mockDb.run.mockClear();
            await sign({ role: 'employee', userType: 'employee', userId: 89 });
            expect(runs()[0][1][3]).toBe('employee');
            mockDb.run.mockClear();
            await sign({ userType: 'something-else', userId: 96 }); // never a value the CHECK refuses
            expect(runs()[0][1][3]).toBe('employee');
        });

        test('column detection is cached per process and reset by _resetSchemaCache()', async () => {
            wire({ column: true });
            await sign({ userType: 'admin' });
            await sign({ userType: 'admin' });
            expect(gets().filter(([s]) => /information_schema/i.test(s))).toHaveLength(1);
            IDPService._resetSchemaCache();
            await sign({ userType: 'admin' });
            expect(gets().filter(([s]) => /information_schema/i.test(s))).toHaveLength(2);
        });

        test('column present: an employee-slot row signed by an ADMIN does not count towards activation', async () => {
            wire({ column: true });
            mockDb.all.mockResolvedValue([
                { role: 'employee', userType: 'admin' },
                { role: 'supervisor', userType: 'admin' },
            ]);
            await expect(sign({ userType: 'admin', userId: 1 })).resolves.toEqual({
                activated: false,
            });
            expect(gets().some(([s]) => /UPDATE idp_plans SET status = 'active'/i.test(s))).toBe(
                false
            );
            // and the read asks for the column
            expect(mockDb.all.mock.calls[0][0]).toMatch(/user_type AS "userType"/);
        });

        test('an administrator can never sign as the employee party — refused before any query (403)', async () => {
            wire({ column: false });
            await expect(
                sign({ role: 'employee', userType: 'admin', userId: 89 })
            ).rejects.toMatchObject({ code: 'IDP_SIGNER_MISMATCH', status: 403 });
            expect(mockDb.get).not.toHaveBeenCalled();
            expect(mockDb.run).not.toHaveBeenCalled();
        });

        test("legacy callers that pass no userType keep working: the column is OMITTED (NOT NULL DEFAULT 'employee' applies), never written as NULL", async () => {
            wire({ column: true });
            await sign({ role: 'employee', userId: 89 });
            const [[sql, params]] = runs();
            expect(sql).toMatch(/INSERT INTO idp_signoffs \(idp_id, role, user_id, ip, ua\)/i);
            expect(sql).not.toMatch(/user_type/);
            expect(params).toEqual([6, 'employee', 89, '127.0.0.1', 'ua']);
            expect(params).not.toContain(null);
        });
    });
});

// ---------------------------------------------------------------------------
// F5 / F6 / F9 — the counting queries
// ---------------------------------------------------------------------------
describe('counting queries exclude cancelled plans', () => {
    test('F5 Action Center: "development actions to progress" only counts actions of LIVE plans', async () => {
        let payload = null;
        mockDb.get.mockResolvedValue({ c: 0 });
        await TalentActionsController.myActions(
            { user: { id: 68963, userType: 'employee' } },
            {
                json: (o) => {
                    payload = o;
                },
            }
        );
        const q = gets().find(([s]) => /FROM idp_actions a JOIN idp_plans p/i.test(s));
        expect(q).toBeTruthy();
        expect(q[0]).toMatch(/p\.status IN \('draft','active'\)/);
        expect(q[0]).toMatch(/a\.status IN \('pending','in_progress'\)/);
        expect(payload.total).toBe(0);
    });

    test('F5 dashboard "IDP completion": cancelled/archived plans leave the denominator, completed plans stay', async () => {
        mockDb.get.mockResolvedValue({});
        await new DashboardController().getTalentDevelopment(
            { user: SUPER, query: {} },
            {
                json() {},
                status() {
                    return this;
                },
            }
        );
        const q = gets().find(([s]) => /FROM idp_actions a JOIN idp_plans i/i.test(s));
        expect(q[0]).toMatch(/AND i\.status IN \('draft','active','completed'\)/);
    });

    test('F6 dashboard measured PIP closures require the period to POST-date the plan creation', async () => {
        mockDb.get.mockResolvedValue({});
        await new DashboardController().getTalentDevelopment(
            { user: SUPER, query: {} },
            {
                json() {},
                status() {
                    return this;
                },
            }
        );
        const q = gets().find(([s]) => /FROM pips p/i.test(s));
        // the two MEASURED tallies (the plain closed_* tallies carry no AND)
        const measured = q[0].match(
            /COUNT\(\*\) FILTER \(WHERE p\.state='closed_(?:success|failure)' AND[^)]*\)/g
        );
        expect(measured).toHaveLength(2);
        measured.forEach((m) => {
            expect(m).toMatch(/p\.ends_on IS NOT NULL/);
            expect(m).toMatch(/p\.ends_on > p\.created_at::date/);
            expect(m).toMatch(/p\.updated_at >= p\.ends_on/);
        });
    });

    test('F9 exec measure "Active IDPs" = draft + active only (no NOT IN that lets cancelled/archived through)', async () => {
        mockDb.get.mockResolvedValue({ count: 1 });
        await new DashboardController().getMeasures(
            { user: SUPER, query: {} },
            {
                json() {},
                status() {
                    return this;
                },
            }
        );
        const q = gets().find(([s]) => /FROM idp_plans WHERE/i.test(s));
        expect(q[0]).toMatch(/FROM idp_plans WHERE status IN \('draft','active'\)/);
        expect(q[0]).not.toMatch(/NOT IN/);
    });
});
