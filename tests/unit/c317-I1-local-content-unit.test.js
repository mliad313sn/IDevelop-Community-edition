'use strict';
/**
 * 3.23.18 — lane I1 (local content): nationalisation plan + regulator pack,
 * behaviour with a mocked database. The real-schema proof is in
 * c317-I1-local-content-db.test.js (idevelop_fixtures, rolled back).
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

jest.mock('../../src/config/database', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
}));
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (_k, d) => d),
}));
jest.mock('../../src/services/ReadinessService', () => ({
    calculateReadinessMap: jest.fn(async () => ({})),
}));

const db = require('../../src/config/database');
const RBACService = require('../../src/services/RBACService');
const Nat = require('../../src/services/NationalisationService');
const Reports = require('../../src/services/LocalContentReportService');

const SUPER = { userType: 'admin', role: 'superadmin', id: 1 };
const MANAGER = { userType: 'manager', id: 50 };
const VIEWER = {
    userType: 'admin',
    role: 'viewer',
    id: 7,
    permissions: ['view_continuity', 'view_compliance'],
};
const LOCAL_NO_GRANT = { userType: 'admin', role: 'localadmin', id: 8, permissions: [] };
const LOCAL_SUCC = {
    userType: 'admin',
    role: 'localadmin',
    id: 9,
    permissions: ['manage_succession'],
};
const EMPLOYEE = { userType: 'employee', id: 60 };

beforeEach(() => {
    jest.spyOn(RBACService, 'scopeFilter').mockResolvedValue({ clause: '', params: [] });
});

describe('plan status is computed from dates, successors and MEASURED readiness', () => {
    const today = '2026-09-26';
    test('stored lifecycle wins', () => {
        expect(
            Nat.computeStatus({
                state: 'achieved',
                targetDate: '2020-01-01',
                today,
                successors: [],
            }).status
        ).toBe('achieved');
        expect(
            Nat.computeStatus({
                state: 'cancelled',
                targetDate: '2030-01-01',
                today,
                successors: [],
            }).status
        ).toBe('cancelled');
    });
    test('past target → overdue, even with a ready successor', () => {
        const r = Nat.computeStatus({
            state: 'active',
            targetDate: '2026-09-01',
            today,
            successors: [{ isReady: true, readinessPercent: 95 }],
        });
        expect(r).toEqual({ status: 'overdue', reason: 'target_passed' });
    });
    test('nobody named → at risk', () => {
        expect(
            Nat.computeStatus({ state: 'active', targetDate: '2030-01-01', today, successors: [] })
        ).toEqual({
            status: 'at_risk',
            reason: 'no_successor',
        });
    });
    test('near target with nobody ready → at risk; unmeasured says so instead of claiming 0 %', () => {
        expect(
            Nat.computeStatus({
                state: 'active',
                targetDate: '2027-01-15',
                today,
                successors: [{ isReady: false, readinessPercent: 40 }],
            })
        ).toEqual({ status: 'at_risk', reason: 'not_ready_near_target' });
        expect(
            Nat.computeStatus({
                state: 'active',
                targetDate: '2027-01-15',
                today,
                successors: [{ isReady: false, readinessPercent: null }],
            })
        ).toEqual({ status: 'at_risk', reason: 'readiness_not_measured' });
    });
    test('far target: ready → in progress, active IDP → in progress, else planned', () => {
        const far = '2028-06-30';
        expect(
            Nat.computeStatus({
                state: 'active',
                targetDate: far,
                today,
                successors: [{ isReady: true, readinessPercent: 90 }],
            }).status
        ).toBe('in_progress');
        expect(
            Nat.computeStatus({
                state: 'active',
                targetDate: far,
                today,
                successors: [{ isReady: false, readinessPercent: 30, idpStatus: 'active' }],
            }).status
        ).toBe('in_progress');
        expect(
            Nat.computeStatus({
                state: 'active',
                targetDate: far,
                today,
                successors: [{ isReady: false, readinessPercent: null, idpStatus: 'draft' }],
            })
        ).toEqual({ status: 'planned', reason: 'readiness_not_measured' });
    });
});

describe('who may read and write nationalisation plans (fails closed)', () => {
    test('read', () => {
        expect(Nat.canView(SUPER)).toBe(true);
        expect(Nat.canView(MANAGER)).toBe(true);
        expect(Nat.canView(VIEWER)).toBe(true);
        expect(Nat.canView(LOCAL_NO_GRANT)).toBe(false);
        expect(Nat.canView(EMPLOYEE)).toBe(false);
        expect(Nat.canView(null)).toBe(false);
    });
    test('write: never a viewer, never an employee, a local admin needs manage_succession', () => {
        expect(Nat.canWrite(SUPER)).toBe(true);
        expect(Nat.canWrite(MANAGER)).toBe(true);
        expect(Nat.canWrite(LOCAL_SUCC)).toBe(true);
        expect(Nat.canWrite(VIEWER)).toBe(false);
        expect(Nat.canWrite(LOCAL_NO_GRANT)).toBe(false);
        expect(Nat.canWrite(EMPLOYEE)).toBe(false);
    });
    test('a refused writer touches nothing', async () => {
        await expect(
            Nat.createPlan(VIEWER, { incumbentEmployeeId: 1, targetDate: '2027-01-01' })
        ).rejects.toMatchObject({
            code: 'LC_FORBIDDEN',
            status: 403,
        });
        expect(db.run).not.toHaveBeenCalled();
    });
});

describe('createPlan — only an expatriate-held position, only in scope', () => {
    const incumbent = (over) => ({
        id: 11,
        roleId: 3,
        isActive: true,
        isNational: 0,
        operatingCountryId: 9,
        ...over,
    });

    test('a national incumbent is refused', async () => {
        db.get.mockResolvedValueOnce(incumbent({ isNational: 1 })); // classify
        db.get.mockResolvedValueOnce({ id: 11 }); // _inScope
        await expect(
            Nat.createPlan(SUPER, { incumbentEmployeeId: 11, targetDate: '2027-06-30' })
        ).rejects.toMatchObject({
            code: 'LC_NOT_EXPATRIATE',
        });
        expect(db.run).not.toHaveBeenCalled();
    });
    test('an unspecified nationality is refused, never guessed', async () => {
        db.get.mockResolvedValueOnce(incumbent({ isNational: null }));
        db.get.mockResolvedValueOnce({ id: 11 });
        await expect(
            Nat.createPlan(SUPER, { incumbentEmployeeId: 11, targetDate: '2027-06-30' })
        ).rejects.toMatchObject({
            code: 'LC_NATIONALITY_UNKNOWN',
        });
    });
    test('out of scope → 403', async () => {
        db.get.mockResolvedValueOnce(incumbent());
        db.get.mockResolvedValueOnce(undefined); // not in scope
        await expect(
            Nat.createPlan(MANAGER, { incumbentEmployeeId: 11, targetDate: '2027-06-30' })
        ).rejects.toMatchObject({
            code: 'LC_FORBIDDEN',
        });
    });
    test('a malformed date is refused before any read', async () => {
        await expect(
            Nat.createPlan(SUPER, { incumbentEmployeeId: 11, targetDate: '2027-02-30' })
        ).rejects.toMatchObject({
            code: 'LC_BAD_DATE',
        });
        expect(db.get).not.toHaveBeenCalled();
    });
    test('an expatriate in scope → plan + journal event, stamped with the operating country and the actor', async () => {
        db.get.mockResolvedValueOnce(incumbent());
        db.get.mockResolvedValueOnce({ id: 11 });
        db.get.mockResolvedValueOnce(undefined); // no active plan yet
        db.run.mockResolvedValueOnce({ lastID: 77 }).mockResolvedValueOnce({ lastID: 1 });
        await expect(
            Nat.createPlan(MANAGER, { incumbentEmployeeId: 11, targetDate: '2027-06-30' })
        ).resolves.toEqual({ id: 77 });
        const [sql, params] = db.run.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO lc_nationalisation_plans/);
        expect(params).toEqual([3, 11, 9, '2027-06-30', null, 'employee:50']);
        expect(db.run.mock.calls[1][0]).toMatch(/INSERT INTO lc_nationalisation_events/);
    });
});

describe('addSuccessor — the successor must be a national of the POSITION country', () => {
    const plan = {
        id: 5,
        roleId: 3,
        incumbentEmployeeId: 11,
        countryId: 9,
        targetDate: '2027-06-30',
        state: 'active',
    };
    function arrange(nat) {
        db.get
            .mockResolvedValueOnce(plan) // _plan
            .mockResolvedValueOnce({ id: 11 }) // incumbent in scope
            .mockResolvedValueOnce({ id: 20, isActive: true }) // employee
            .mockResolvedValueOnce({ id: 20 }) // successor in scope
            .mockResolvedValueOnce({ isNational: nat }); // nationalOf
    }
    test('an expatriate successor is refused', async () => {
        arrange(0);
        await expect(Nat.addSuccessor(SUPER, 5, 20)).rejects.toMatchObject({
            code: 'LC_SUCCESSOR_NOT_NATIONAL',
        });
        expect(db.run).not.toHaveBeenCalled();
    });
    test('an unknown nationality is refused', async () => {
        arrange(null);
        await expect(Nat.addSuccessor(SUPER, 5, 20)).rejects.toMatchObject({
            code: 'LC_NATIONALITY_UNKNOWN',
        });
    });
    test('a national is named, and the nationality test is made against the plan country', async () => {
        arrange(1);
        db.run.mockResolvedValue({ lastID: 30 });
        await expect(Nat.addSuccessor(SUPER, 5, 20)).resolves.toEqual({ id: 30 });
        const natCall = db.get.mock.calls[4];
        expect(natCall[1]).toEqual([9, 9, 20]);
    });
    test('the incumbent cannot succeed themself', async () => {
        db.get.mockResolvedValueOnce(plan).mockResolvedValueOnce({ id: 11 });
        await expect(Nat.addSuccessor(SUPER, 5, 11)).rejects.toMatchObject({
            code: 'LC_SUCCESSOR_IS_INCUMBENT',
        });
    });
});

describe('closing and withdrawing need a reason — nothing is deleted', () => {
    test('close without reason', async () => {
        await expect(Nat.closePlan(SUPER, 5, 'achieved', '  ')).rejects.toMatchObject({
            code: 'LC_REASON_REQUIRED',
        });
        await expect(Nat.closePlan(SUPER, 5, 'deleted', 'x')).rejects.toMatchObject({
            code: 'LC_BAD_STATE',
        });
    });
    test('withdraw without reason', async () => {
        await expect(Nat.withdrawSuccessor(SUPER, 30, '')).rejects.toMatchObject({
            code: 'LC_REASON_REQUIRED',
        });
        expect(db.run).not.toHaveBeenCalled();
    });
});

describe('linkIdp goes through IDPService public methods (create-or-link)', () => {
    const IDPService = require('../../src/services/IDPService');
    const plan = {
        id: 5,
        roleId: 3,
        incumbentEmployeeId: 11,
        countryId: 9,
        targetDate: '2027-06-30',
        state: 'active',
    };
    const succ = { id: 30, planId: 5, employeeId: 20, idpId: null, state: 'active' };

    test('no IDP authority → refused', async () => {
        db.get
            .mockResolvedValueOnce(succ)
            .mockResolvedValueOnce(plan)
            .mockResolvedValueOnce({ id: 11 });
        jest.spyOn(IDPService, 'planAuthority').mockResolvedValue({
            canAct: false,
            isSubject: true,
        });
        const create = jest.spyOn(IDPService, 'createManualPlan');
        await expect(Nat.linkIdp(MANAGER, 30)).rejects.toMatchObject({ code: 'LC_IDP_FORBIDDEN' });
        expect(create).not.toHaveBeenCalled();
    });
    test('an existing open plan is LINKED, not duplicated', async () => {
        db.get
            .mockResolvedValueOnce(succ)
            .mockResolvedValueOnce(plan)
            .mockResolvedValueOnce({ id: 11 });
        jest.spyOn(IDPService, 'planAuthority').mockResolvedValue({ canAct: true });
        const err = Object.assign(new Error('open'), { code: 'IDP_OPEN_EXISTS', existingId: 444 });
        jest.spyOn(IDPService, 'createManualPlan').mockRejectedValue(err);
        db.run.mockResolvedValue({ changes: 1 });
        await expect(Nat.linkIdp(MANAGER, 30)).resolves.toEqual({
            idpId: 444,
            created: false,
            linked: true,
        });
        expect(db.run.mock.calls[0][1]).toEqual([444, 30]);
    });
    test('otherwise a plan is created, due on the target date', async () => {
        db.get
            .mockResolvedValueOnce(succ)
            .mockResolvedValueOnce(plan)
            .mockResolvedValueOnce({ id: 11 });
        jest.spyOn(IDPService, 'planAuthority').mockResolvedValue({ canAct: true });
        const create = jest.spyOn(IDPService, 'createManualPlan').mockResolvedValue({ idpId: 555 });
        db.run.mockResolvedValue({ changes: 1 });
        await expect(Nat.linkIdp(MANAGER, 30)).resolves.toEqual({
            idpId: 555,
            created: true,
            linked: false,
        });
        expect(create.mock.calls[0][0]).toMatchObject({
            employeeId: 20,
            dueOn: '2027-06-30',
            priority: 'high',
        });
    });
});

describe('regulator pack — anonymity, periods, templates, access', () => {
    test('counts 1-4 are shown "< 5"; 0 and ≥ 5 as is; null stays null', () => {
        expect(Reports.maskCount(0)).toBe(0);
        expect(Reports.maskCount(1)).toBe('< 5');
        expect(Reports.maskCount(4)).toBe('< 5');
        expect(Reports.maskCount(5)).toBe(5);
        expect(Reports.maskCount(null)).toBe(null);
    });
    test('no percentage on a base under 5', () => {
        expect(Reports.safePct(3, 4)).toBe(null);
        expect(Reports.safePct(0, 0)).toBe(null);
        expect(Reports.safePct(4, 5)).toBe(80);
    });
    test('periods are calendar periods, end exclusive', () => {
        expect(Reports.parsePeriod('quarter', '2026-q3')).toEqual({
            periodType: 'quarter',
            label: '2026-Q3',
            start: '2026-07-01',
            end: '2026-10-01',
            endInclusive: '2026-09-30',
        });
        expect(Reports.parsePeriod('year', '2025')).toMatchObject({
            start: '2025-01-01',
            end: '2026-01-01',
        });
        expect(() => Reports.parsePeriod('quarter', '2026')).toThrow();
        expect(() => Reports.parsePeriod('month', '2026-01')).toThrow();
    });
    test('five country templates, a generic one otherwise; country wording falls back to the common one', () => {
        expect(['ML', 'BF', 'GN', 'CI', 'SN'].map(Reports.templateFor)).toEqual([
            'ML',
            'BF',
            'GN',
            'CI',
            'SN',
        ]);
        expect(Reports.templateFor('ZA')).toBe('generic');
        const t = (k, o) =>
            k === 'localcontent:tpl_sn_plans'
                ? 'SN plans'
                : k.startsWith('localcontent:tpl_generic_')
                  ? 'GEN'
                  : o && 'defaultValue' in o
                    ? o.defaultValue
                    : k;
        expect(Reports.tplLabel(t, 'SN', 'plans')).toBe('SN plans');
        expect(Reports.tplLabel(t, 'ML', 'plans')).toBe('GEN');
    });
    test('packs are for admins with a compliance grant; writing never for a viewer or a manager', () => {
        expect(Reports.canView(MANAGER)).toBe(false);
        expect(Reports.canView(VIEWER)).toBe(true);
        expect(Reports.canManage(VIEWER)).toBe(false);
        expect(Reports.canManage(MANAGER)).toBe(false);
        expect(Reports.canManage(SUPER)).toBe(true);
        expect(
            Reports.canManage({
                userType: 'admin',
                role: 'localadmin',
                id: 3,
                permissions: ['manage_compliance'],
            })
        ).toBe(true);
    });
    test('a site-scoped compliance admin cannot produce a country pack', async () => {
        jest.spyOn(RBACService, 'canAccessCountry').mockResolvedValue(false);
        const u = {
            userType: 'admin',
            role: 'localadmin',
            id: 3,
            permissions: ['manage_compliance'],
        };
        await expect(
            Reports.generateDraft(u, { countryId: 9, periodType: 'year', periodLabel: '2026' })
        ).rejects.toMatchObject({
            code: 'LC_FORBIDDEN',
        });
        expect(db.run).not.toHaveBeenCalled();
    });
    test('discarding a draft needs a reason', async () => {
        await expect(Reports.discard(SUPER, 1, ' ')).rejects.toMatchObject({
            code: 'LC_REASON_REQUIRED',
        });
    });

    const pack = {
        id: 1,
        state: 'published',
        version: 2,
        templateCode: 'CI',
        companyName: 'Acme Mining',
        snapshot: {
            meta: {
                countryName: "Côte d'Ivoire",
                countryCode: 'CI',
                templateCode: 'CI',
                periodLabel: '2026-Q3',
                periodStart: '2026-07-01',
                periodEndInclusive: '2026-09-30',
                asOf: '2026-10-02T08:00:00.000Z',
                anonymityThreshold: 5,
            },
            workforce: {
                total: { headcount: 57, nationals: 41, expats: 3, unspecified: 13 },
                byLevel: [
                    { name: 'management', headcount: 4, nationals: 2, expats: 2, unspecified: 0 },
                ],
                byRoleFamily: [],
                bySite: [{ name: 'Site A', headcount: 9, nationals: 6, expats: 3, unspecified: 0 }],
            },
            plans: {
                summary: { at_risk: 1, total: 1 },
                rows: [
                    {
                        roleName: 'Chef',
                        status: 'at_risk',
                        readiness: 'not_measured',
                        successorCount: 1,
                        idpLinkedCount: 0,
                        targetDate: '2027-01-01',
                    },
                ],
            },
            training: {
                lmsCompletions: {
                    nationals: { completions: 12, people: 3 },
                    expats: { completions: 0, people: 0 },
                    unspecified: { completions: 0, people: 0 },
                },
                certificationsIssued: {
                    nationals: { certificates: 2, people: 2 },
                    expats: { certificates: 0, people: 0 },
                    unspecified: { certificates: 0, people: 0 },
                },
                certificationsValidAtEnd: {
                    nationals: { people: 30 },
                    expats: { people: 1 },
                    unspecified: { people: 0 },
                },
            },
        },
    };
    const t = (k) => k;

    test('the view model masks every small count and withholds small-base percentages', () => {
        const vm = Reports.viewModel(pack, t);
        expect(vm.workforce.total).toMatchObject({
            headcount: 57,
            nationals: 41,
            expats: '< 5',
            nationalPct: 93,
        });
        expect(vm.workforce.byLevel[0]).toMatchObject({
            headcount: '< 5',
            nationals: '< 5',
            nationalPct: null,
        });
        expect(vm.workforce.bySite[0]).toMatchObject({ expats: '< 5', nationalPct: 67 });
        expect(vm.training.lms[0]).toMatchObject({ completions: 12, people: '< 5' });
        expect(vm.training.valid[1]).toMatchObject({ people: '< 5' });
        expect(vm.companyName).toBe('Acme Mining');
    });

    test('the XLSX carries the masking, the company, the period and a signature block', async () => {
        const ExcelJS = require('exceljs');
        const buf = await Reports.toXlsx(pack, t);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const cells = [];
        wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value)))));
        expect(cells).toContain('< 5');
        expect(cells).toContain('Acme Mining');
        expect(cells.some((c) => c.includes('2026-Q3'))).toBe(true);
        expect(cells).toContain('localcontent:sig_signature');
        // The raw small counts never reach the file.
        const wf = wb.worksheets[0];
        const siteRow = [];
        wf.eachRow((row) => {
            if (row.getCell(1).value === 'Site A') siteRow.push(row.values.slice(1));
        });
        expect(siteRow[0]).toEqual(['Site A', 9, 6, '< 5', 0, '67 %']);
    });
});
