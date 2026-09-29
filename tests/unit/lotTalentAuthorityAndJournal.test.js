'use strict';
/**
 * LOT talent (committee 2026-09-17) — seven findings, each reproduced by
 * execution on the development database inside a rolled-back transaction
 * before the fix and re-proved after it (scratchpad triage-talent/*.log):
 *
 *   Ztalent-1  NineBox / CoachingPlan.resolveAuthority compared user.id to
 *              employee.managerId WITHOUT manager_type: employee 145 became the
 *              9-box/coaching manager of 139 whose manager is ADMIN 145.
 *   Ztalent-2  NineBoxService._audit wrote adminId = req.user.id for an EMPLOYEE
 *              inside runTransaction, no savepoint: 23503 then 25P02 — every
 *              9-box act of an employee-manager answered 500 (measured: approve
 *              of evaluation 4042 by manager 137 threw 25P02).
 *   Ztalent-3  the PIP console's Cancel on « close — not met » still POSTed
 *              {success:'false', outcome:''} and closed the plan as failed.
 *   Ztalent-4  PipService.close wrote no author and no journal; withdraw and the
 *              task decisions were journaled with admin_id NULL, actor_ref NULL.
 *   Ztalent-5  a manager on their LINKED admin account (linked_employee_id) was
 *              listed their team (scopeFilter) and refused every one of them by
 *              the per-object guards of 9-box, PIP, IDP and coaching.
 *   Ztalent-7  a VIEWER created an IDP (POST /v2/idp/new) and proposed a PIP
 *              (POST /v2/pip/propose): guards by the shape of the role only.
 *   Ztalent-8  coaching_sessions.coach_id (FK employees) received req.user.id of
 *              an ADMIN: the session belonged to the employee sharing the number.
 *
 * DB mocked; the live behaviour is exercised by the rolled-back probes.
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);

const mockLog = { log: jest.fn(async () => {}) };
jest.mock('../../src/services/LogService', () => mockLog);

const mockEmployees = {
    findById: jest.fn(),
    governs: jest.fn(async () => false),
    findGoverned: jest.fn(async () => []),
};
jest.mock('../../src/models/EmployeeModel', () => mockEmployees);

const mockRbac = {
    isSuperAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'superadmin'),
    isLocalAdmin: (u) => Boolean(u && u.userType === 'admin' && u.role === 'localadmin'),
    isViewer: (u) => Boolean(u && u.userType === 'admin' && u.role === 'viewer'),
    hasPermission: jest.fn(() => false),
    canAccessEmployeeData: jest.fn(async () => false),
    canAccessEmployee: jest.fn(async () => false),
    getFilteredEmployees: jest.fn(async () => []),
    scopeFilter: jest.fn(async () => ({ clause: '', params: [] })),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

// The person behind an account: employees are themselves; admin 703 is linked to
// person 137; every other admin names nobody.
const mockGov = {
    actingPersonId: jest.fn(async (u) => {
        if (!u || u.id == null) return null;
        if (u.userType !== 'admin') return Number(u.id);
        return Number(u.id) === 703 ? 137 : null;
    }),
    lineAuthorityEmployeeIds: jest.fn(async (u) =>
        u && u.userType === 'admin' && Number(u.id) === 703 ? [138, 139, 152] : []
    ),
};
jest.mock('../../src/services/GovernanceService', () => mockGov);

jest.mock('../../src/services/DevelopmentTriggerService', () => ({
    triggerForPlacement: jest.fn(),
    levelsFromBox: jest.fn(),
}));
jest.mock('../../src/services/NotificationService', () => ({ notify: jest.fn(async () => {}) }));
jest.mock('../../src/services/MakerCheckerService', () => ({
    register: jest.fn(),
    submit: jest.fn(),
}));
jest.mock('../../src/middleware/auth', () => {
    const pass = (req, res, next) => next();
    return {
        requireAuth: pass,
        requireEmployee: pass,
        requireManager: pass,
        requireManagerOrAdmin: pass,
        requireEmployeeOrManager: pass,
    };
});
jest.mock('../../src/services/IDPService', () => ({
    createManualPlan: jest.fn(async () => ({ idpId: 73 })),
    signOff: jest.fn(async () => ({})),
}));
jest.mock('../../src/services/ActionEffectivenessService', () => ({ onActionClose: jest.fn() }));
const mockCoaching = {
    createSession: jest.fn(async () => 14),
    upsertGrow: jest.fn(async () => {}),
    signOff: jest.fn(async () => {}),
};
jest.mock('../../src/services/CoachingService', () => mockCoaching);

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

const NineBox = require('../../src/services/NineBoxService');
const CoachingPlan = require('../../src/services/CoachingPlanService');
const PipService = require('../../src/services/PipService');
const TalentTaskService = require('../../src/services/TalentTaskService');

const MGR137 = { id: 137, userType: 'manager', role: null, permissions: [] };
const EMP145 = { id: 145, userType: 'employee' };
const LINKED703 = { id: 703, userType: 'admin', role: 'localadmin', permissions: [] };
const VIEWER = { id: 1035, userType: 'admin', role: 'viewer', permissions: ['view_employees'] };
const SUPER = { id: 666, userType: 'admin', role: 'superadmin', permissions: [] };
const req = (user) => ({ user, ip: '127.0.0.1', get: () => 'jest' });
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Drive a real router in-process (no HTTP), the way the rolled-back probe did. */
function call(mount, router, user, method, url, body = {}) {
    return new Promise((resolve) => {
        const app = express.Router();
        app.use(mount, router);
        const headers = { 'content-type': 'application/json', accept: 'application/json' };
        const r = {
            method,
            url: mount + url,
            originalUrl: mount + url,
            headers,
            body,
            query: {},
            params: {},
            user,
            ip: '127.0.0.1',
            xhr: true,
            isAuthenticated: () => true,
            get: (h) => headers[String(h).toLowerCase()],
            flash: () => {},
            t: (k, o) => (o && o.defaultValue) || k,
            getLocale: () => 'fr',
            session: {},
        };
        const res = {
            _status: 200,
            status(s) {
                this._status = s;
                return this;
            },
            json(j) {
                resolve({ status: this._status, json: j });
            },
            render(v, d) {
                resolve({ status: this._status, render: v, message: d && d.message });
            },
            redirect(u) {
                resolve({ status: 302, location: u });
            },
            set() {
                return this;
            },
            setHeader() {},
            getHeader() {},
        };
        app.handle(r, res, (err) => resolve({ status: 'next', err: err && (err.message || err) }));
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockReset();
    mockDb.all.mockReset().mockResolvedValue([]);
    mockDb.run.mockReset().mockResolvedValue({ changes: 1 });
    mockEmployees.governs.mockResolvedValue(false);
    mockEmployees.findGoverned.mockResolvedValue([]);
    mockRbac.canAccessEmployeeData.mockResolvedValue(false);
    mockRbac.canAccessEmployee.mockResolvedValue(false);
    mockRbac.getFilteredEmployees.mockResolvedValue([]);
});

// ─── Ztalent-1 — manager_type discriminates the polymorphic manager_id ───────
describe('Ztalent-1 — manager_id is polymorphic: no authority without manager_type', () => {
    const e139adminManaged = { id: 139, supervisorId: 136, managerId: 145, managerType: 'admin' };
    const e139employeeManaged = {
        id: 139,
        supervisorId: 136,
        managerId: 145,
        managerType: 'employee',
    };

    test('NineBox: employee 145 is NOT the manager of 139 whose manager is ADMIN 145', async () => {
        mockEmployees.findById.mockResolvedValue(e139adminManaged);
        const a = await NineBox.resolveAuthority(EMP145, 139);
        expect(a.isManager).toBe(false);
        expect(a.canApprove).toBe(false);
        expect(a.canDraft).toBe(false);
        expect(a.canView).toBe(false);
    });

    test('NineBox: the same link typed employee grants the manager authority', async () => {
        mockEmployees.findById.mockResolvedValue(e139employeeManaged);
        const a = await NineBox.resolveAuthority(EMP145, 139);
        expect(a.isManager).toBe(true);
        expect(a.canApprove).toBe(true);
    });

    test('CoachingPlan: same discriminator, same verdicts', async () => {
        mockEmployees.findById.mockResolvedValue(e139adminManaged);
        expect((await CoachingPlan.resolveAuthority(EMP145, 139)).canManage).toBe(false);
        mockEmployees.findById.mockResolvedValue(e139employeeManaged);
        expect((await CoachingPlan.resolveAuthority(EMP145, 139)).canManage).toBe(true);
    });

    test('an ADMIN account designated manager (manager_type = admin) draws its authority from the designation', async () => {
        mockEmployees.findById.mockResolvedValue({
            id: 139,
            supervisorId: null,
            managerId: 145,
            managerType: 'admin',
        });
        const a = await NineBox.resolveAuthority(
            { id: 145, userType: 'admin', role: 'localadmin', permissions: [] },
            139
        );
        expect(a.isManager).toBe(true);
        expect(a.canApprove).toBe(true);
    });
});

// ─── Ztalent-5 — the person behind a linked admin account keeps their line ───
describe('Ztalent-5 — a manager on their LINKED admin account keeps their team', () => {
    const e152 = { id: 152, supervisorId: 136, managerId: 137, managerType: 'employee' };
    beforeEach(() => mockEmployees.findById.mockResolvedValue(e152));

    test('NineBox.resolveAuthority(admin 703 → person 137, 152): manager, may approve', async () => {
        const a = await NineBox.resolveAuthority(LINKED703, 152);
        expect(a).toMatchObject({
            isManager: true,
            canView: true,
            canDraft: true,
            canApprove: true,
        });
    });

    test('CoachingPlan.resolveAuthority(admin 703, 152): in scope, may manage', async () => {
        const a = await CoachingPlan.resolveAuthority(LINKED703, 152);
        expect(a).toMatchObject({ inScope: true, canView: true, canManage: true, personId: 137 });
    });

    test('an admin linked to NOBODY draws no line authority (clearance only)', async () => {
        const a = await NineBox.resolveAuthority(
            { id: 702, userType: 'admin', role: 'localadmin', permissions: [] },
            152
        );
        expect(a).toMatchObject({ isManager: false, canView: false, canApprove: false });
    });

    test('NineBox._scopedEmployeeIds unions the line of the person behind the account', async () => {
        const s = await NineBox._scopedEmployeeIds(LINKED703);
        expect(s.all).toBe(false);
        expect(s.ids).toEqual(expect.arrayContaining([138, 139, 152]));
    });

    test('routes: /v2/pip propose and /v2/idp new accept the linked admin for a person on their line', async () => {
        const pip = require('../../src/routes/v2-pip');
        mockDb.get.mockImplementation(async (sql) =>
            /SELECT id FROM pips WHERE employee_id/.test(norm(sql)) ? undefined : { id: 123 }
        );
        const r1 = await call('/v2/pip', pip, LINKED703, 'POST', '/propose', {
            employeeId: '152',
            startsOn: '2030-01-01',
            endsOn: '2030-03-01',
            summary: 'x',
        });
        expect(r1.status).toBe(200);
        expect(r1.json.ok).toBe(true);
        const idp = require('../../src/routes/v2-idp');
        const r2 = await call('/v2/idp', idp, LINKED703, 'POST', '/new', {
            employeeId: '152',
            priority: 'medium',
        });
        expect(r2.status).toBe(302);
        expect(r2.location).toBe('/v2/idp/73');
        // And a person OFF the line is still refused (clearance is empty here).
        mockEmployees.findById.mockResolvedValue({
            id: 87,
            supervisorId: 85,
            managerId: 86,
            managerType: 'employee',
        });
        const r3 = await call('/v2/pip', pip, LINKED703, 'POST', '/propose', {
            employeeId: '87',
            startsOn: '2030-01-01',
            endsOn: '2030-03-01',
            summary: 'x',
        });
        expect(r3.status).toBe(403);
    });
});

// ─── Ztalent-2 — the 9-box audit inside a transaction ────────────────────────
describe('Ztalent-2 — NineBoxService._audit names the actor and is contained in a savepoint', () => {
    test('employee-manager: adminId NULL, actorRef employee:137, inside runInSavepoint', async () => {
        await NineBox._audit(req(MGR137), 'NINEBOX_APPROVE', 4042, 'x');
        expect(mockDb.runInSavepoint).toHaveBeenCalledTimes(1);
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                adminId: null,
                actorRef: 'employee:137',
                action: 'NINEBOX_APPROVE',
            })
        );
    });

    test('administrator: adminId set AND actorRef admin:666', async () => {
        await NineBox._audit(req(SUPER), 'NINEBOX_REJECT', 1, 'x');
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ adminId: 666, actorRef: 'admin:666' })
        );
    });

    test('a failing log never escapes the transition', async () => {
        mockLog.log.mockRejectedValueOnce(new Error('23503'));
        await expect(
            NineBox._audit(req(MGR137), 'NINEBOX_ARCHIVE', 1, 'x')
        ).resolves.toBeUndefined();
    });

    test('CoachingPlanService._audit: same contract', async () => {
        await CoachingPlan._audit(req(MGR137), 'COACHING_PLAN_CREATED', 9, 'x');
        expect(mockDb.runInSavepoint).toHaveBeenCalledTimes(1);
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ adminId: null, actorRef: 'employee:137' })
        );
    });
});

// ─── Ztalent-4 — PIP closure carries its author; decisions are journaled ────
describe('Ztalent-4 — PIP close / withdraw / task decisions name their author', () => {
    test('close(met) writes closed_by_ref + closed_at and journals PIP_CLOSED with actor_ref', async () => {
        mockDb.get.mockResolvedValue({ id: 120, employeeId: 152 });
        expect(await PipService.close(120, true, 'objectifs atteints', MGR137, req(MGR137))).toBe(
            true
        );
        const [sql, params] = mockDb.get.mock.calls[0];
        expect(norm(sql)).toMatch(
            /UPDATE pips SET state=\?, outcome=\?, closed_by_ref=\?, closed_at=now\(\)/
        );
        expect(params).toEqual(['closed_success', 'objectifs atteints', 'employee:137', 120]);
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'PIP_CLOSED',
                adminId: null,
                actorRef: 'employee:137',
                entityId: 120,
            })
        );
        expect(mockDb.runInSavepoint).toHaveBeenCalled();
    });

    test('close(not met) WITHOUT a note is refused before any write (REASON_REQUIRED)', async () => {
        await expect(PipService.close(120, false, '', MGR137)).rejects.toMatchObject({
            code: 'REASON_REQUIRED',
            status: 400,
        });
        await expect(PipService.close(120, false, undefined, MGR137)).rejects.toMatchObject({
            code: 'REASON_REQUIRED',
        });
        expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('close(not met) WITH a note closes as failure, attributed', async () => {
        mockDb.get.mockResolvedValue({ id: 120, employeeId: 152 });
        expect(await PipService.close(120, false, 'critères non tenus', SUPER, req(SUPER))).toBe(
            true
        );
        expect(mockDb.get.mock.calls[0][1]).toEqual([
            'closed_failure',
            'critères non tenus',
            'admin:666',
            120,
        ]);
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'PIP_CLOSED', adminId: 666, actorRef: 'admin:666' })
        );
    });

    test('withdraw journals PIP_WITHDRAWN with actor_ref employee:137 (admin_id NULL)', async () => {
        mockDb.get.mockResolvedValue({ id: 121, employeeId: 152 });
        expect(await PipService.withdraw(121, 'retrait motivé', MGR137, req(MGR137))).toBe(true);
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'PIP_WITHDRAWN',
                adminId: null,
                actorRef: 'employee:137',
            })
        );
    });

    test('TalentTaskService.resolve journals the decision with actor_ref', async () => {
        mockDb.get.mockResolvedValue({ id: 15, employeeId: 152 });
        await TalentTaskService.resolve(
            15,
            MGR137,
            { resolution: 'no_plan', reason: 'pas de plan' },
            req(MGR137)
        );
        expect(mockLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'TALENT_TASK_DISMISSED',
                adminId: null,
                actorRef: 'employee:137',
            })
        );
        expect(mockDb.runInSavepoint).toHaveBeenCalled();
    });

    test('route POST /v2/pip/:id/close passes the actor and answers 400 without a note on a not-met verdict', async () => {
        const pip = require('../../src/routes/v2-pip');
        mockRbac.getFilteredEmployees.mockResolvedValue([{ id: 152 }]);
        mockDb.get.mockImplementation(async (sql) =>
            /SELECT employee_id FROM pips/.test(norm(sql))
                ? { employeeId: 152 }
                : { id: 120, employeeId: 152 }
        );
        const ko = await call('/v2/pip', pip, MGR137, 'POST', '/120/close', {
            success: 'false',
            outcome: '',
        });
        expect(ko.status).toBe(400);
        expect(ko.json.error).toMatch(/note de résultat/i);
        const ok = await call('/v2/pip', pip, MGR137, 'POST', '/120/close', {
            success: 'true',
            outcome: 'atteint',
        });
        expect(ok.status).toBe(200);
        const update = mockDb.get.mock.calls.find(([s]) => /UPDATE pips SET state=/.test(norm(s)));
        expect(update[1]).toEqual(['closed_success', 'atteint', 'employee:137', 120]);
    });

    test('migration 130 adds the author columns idempotently', () => {
        const sql = read('db/postgres/130_pip_closure_author.sql');
        expect(sql).toMatch(
            /ALTER\s+TABLE\s+pips\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+closed_by_ref\s+text/i
        );
        expect(sql).toMatch(
            /ALTER\s+TABLE\s+pips\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+closed_at\s+timestamptz/i
        );
    });
});

// ─── Ztalent-3 — the console's Cancel is not a closure ───────────────────────
describe('Ztalent-3 — PIP console: Cancel on the close dialog sends nothing', () => {
    function loadPip(promptResult) {
        const src = read('views/pages/pip/index.ejs');
        const m = src.match(/const PIP\s*=\s*\{[\s\S]*?\n\};/);
        expect(m).toBeTruthy();
        const calls = [];
        const ctx = {
            PIP_T: new Proxy({}, { get: (_, k) => String(k) }),
            window: {
                promptDialog: async () => promptResult,
                confirmDialog: async () => true,
                toast() {
                    calls.push('toast');
                },
            },
            document: { getElementById: () => null },
            location: {
                reload() {
                    calls.push('reload');
                },
            },
            SAConsoleNet: {
                call: async (p, mth, b) => {
                    calls.push({ url: p, method: mth, body: b });
                    return { ok: true };
                },
            },
            console,
            alert() {},
        };
        vm.createContext(ctx);
        return { PIP: vm.runInContext(m[0] + '\nPIP;', ctx), calls };
    }

    test('Cancel (null) on « not met » → no POST', async () => {
        const { PIP, calls } = loadPip(null);
        await PIP.close(123, false);
        expect(calls.filter((c) => c.url)).toEqual([]);
    });

    test('empty note on « not met » → refused client-side, no POST', async () => {
        const { PIP, calls } = loadPip('   ');
        await PIP.close(123, false);
        expect(calls.filter((c) => c.url)).toEqual([]);
        expect(calls).toContain('toast');
    });

    test('a written note on « not met » → POST with the trimmed note', async () => {
        const { PIP, calls } = loadPip('  critères non tenus ');
        await PIP.close(123, false);
        expect(calls.filter((c) => c.url)).toEqual([
            {
                url: '/v2/pip/123/close',
                method: 'POST',
                body: { success: 'false', outcome: 'critères non tenus' },
            },
        ]);
    });

    test('« met » with an empty note is still a closure', async () => {
        const { PIP, calls } = loadPip('');
        await PIP.close(123, true);
        expect(calls.filter((c) => c.url)).toHaveLength(1);
    });

    test('locales carry the refusal in both languages', () => {
        const fr = JSON.parse(read('locales/fr/pip.json'));
        const en = JSON.parse(read('locales/en/pip.json'));
        expect(fr.close_note_required).toBeTruthy();
        expect(en.close_note_required).toBeTruthy();
        const ffr = JSON.parse(read('locales/fr/flash.json'));
        const fen = JSON.parse(read('locales/en/flash.json'));
        for (const k of ['pip_close_note_required', 'coaching_no_acting_person']) {
            expect(ffr[k]).toBeTruthy();
            expect(fen[k]).toBeTruthy();
        }
    });
});

// ─── Ztalent-7 — a viewer never acts ─────────────────────────────────────────
describe('Ztalent-7 — a read-only viewer is refused on every talent write route', () => {
    beforeEach(() => {
        // The viewer's CLEARANCE covers employee 87 — that is what let them through.
        mockRbac.getFilteredEmployees.mockResolvedValue([{ id: 87 }]);
        mockRbac.canAccessEmployeeData.mockResolvedValue(true);
        mockRbac.canAccessEmployee.mockResolvedValue(true);
        mockEmployees.findById.mockResolvedValue({
            id: 87,
            supervisorId: 85,
            managerId: 86,
            managerType: 'employee',
        });
        // One row shape serves both the pip lookups and the OPEN task lookup.
        mockDb.get.mockResolvedValue({ id: 5, employeeId: 87, state: 'open' });
    });

    test('POST /v2/idp/new → 403, nothing created', async () => {
        const idp = require('../../src/routes/v2-idp');
        const r = await call('/v2/idp', idp, VIEWER, 'POST', '/new', {
            employeeId: '87',
            priority: 'medium',
        });
        expect(r.status).toBe(403);
        expect(require('../../src/services/IDPService').createManualPlan).not.toHaveBeenCalled();
    });

    test('POST /v2/idp/:id/sign → 403', async () => {
        const idp = require('../../src/routes/v2-idp');
        const r = await call('/v2/idp', idp, VIEWER, 'POST', '/5/sign', {});
        expect(r.status).toBe(403);
        expect(require('../../src/services/IDPService').signOff).not.toHaveBeenCalled();
    });

    test('every /v2/pip write → 403 (propose, activate, close, withdraw, tasks)', async () => {
        const pip = require('../../src/routes/v2-pip');
        const writes = [
            ['/propose', { employeeId: '87', startsOn: '2030-01-01', endsOn: '2030-03-01' }],
            ['/5/activate', {}],
            ['/5/close', { success: 'true', outcome: 'x' }],
            ['/5/withdraw', { reason: 'x' }],
            ['/tasks/5/open-plan', { reason: 'x' }],
            ['/tasks/5/dismiss', { reason: 'x' }],
        ];
        for (const [url, body] of writes) {
            const r = await call('/v2/pip', pip, VIEWER, 'POST', url, body);
            expect({ url, status: r.status }).toEqual({ url, status: 403 });
        }
        const inserts = mockDb.get.mock.calls.filter(([s]) =>
            /INSERT INTO pips|UPDATE pips/.test(norm(s))
        );
        expect(inserts).toEqual([]);
    });

    test('POST /v2/coaching/sessions, grow, sign → 403', async () => {
        const coaching = require('../../src/routes/v2-coaching');
        mockDb.get.mockResolvedValue({ employeeId: 87, coachId: 86 });
        for (const url of ['/sessions', '/sessions/3/grow', '/sessions/3/sign']) {
            const r = await call('/v2/coaching', coaching, VIEWER, 'POST', url, {
                employeeId: 87,
                goal: 'x',
            });
            expect({ url, status: r.status }).toEqual({ url, status: 403 });
        }
        expect(mockCoaching.createSession).not.toHaveBeenCalled();
        expect(mockCoaching.upsertGrow).not.toHaveBeenCalled();
    });

    test('the same clearance on a NON-viewer local admin is accepted (the refusal is the role, not the scope)', async () => {
        const pip = require('../../src/routes/v2-pip');
        mockDb.get.mockImplementation(async (sql) =>
            /SELECT id FROM pips WHERE employee_id/.test(norm(sql))
                ? undefined
                : { id: 9, employeeId: 87 }
        );
        const r = await call(
            '/v2/pip',
            pip,
            { id: 702, userType: 'admin', role: 'localadmin', permissions: [] },
            'POST',
            '/propose',
            { employeeId: '87', startsOn: '2030-01-01', endsOn: '2030-03-01' }
        );
        expect(r.status).toBe(200);
    });
});

// ─── Ztalent-8 — the coach is a PERSON ───────────────────────────────────────
describe('Ztalent-8 — coaching_sessions.coach_id holds the person behind the account', () => {
    const coaching = () => require('../../src/routes/v2-coaching');

    test('linked admin 703 creates a session whose coach is person 137, never admin id 703', async () => {
        const r = await call('/v2/coaching', coaching(), LINKED703, 'POST', '/sessions', {
            employeeId: 138,
            kind: 'coach',
            contextType: 'skill_gap',
            skillId: 299,
        });
        expect(r.status).toBe(200);
        expect(mockCoaching.createSession).toHaveBeenCalledWith(
            expect.objectContaining({ employeeId: 138, coachId: 137 })
        );
    });

    test('an admin linked to NOBODY cannot be written as coach → 400, nothing inserted', async () => {
        const r = await call('/v2/coaching', coaching(), SUPER, 'POST', '/sessions', {
            employeeId: 138,
            kind: 'coach',
        });
        expect(r.status).toBe(400);
        expect(mockCoaching.createSession).not.toHaveBeenCalled();
    });

    test('the EMPLOYEE homonym of an admin coach gets no access to the session; the person does', async () => {
        mockDb.get.mockResolvedValue({ employeeId: 138, coachId: 137 });
        const homonym = await call(
            '/v2/coaching',
            coaching(),
            { id: 703, userType: 'employee' },
            'POST',
            '/sessions/14/grow',
            { goal: 'x' }
        );
        expect(homonym.status).toBe(403);
        const person = await call('/v2/coaching', coaching(), MGR137, 'POST', '/sessions/14/grow', {
            goal: 'x',
        });
        expect(person.status).toBe(200);
        const linked = await call(
            '/v2/coaching',
            coaching(),
            LINKED703,
            'POST',
            '/sessions/14/grow',
            { goal: 'x' }
        );
        expect(linked.status).toBe(200);
    });

    test('an admin whose id equals the employee signs as the COACH, never as the employee', async () => {
        mockDb.get.mockResolvedValue({ employeeId: 703, coachId: 137 });
        await call('/v2/coaching', coaching(), LINKED703, 'POST', '/sessions/14/sign', {});
        expect(mockCoaching.signOff).toHaveBeenCalledWith(
            expect.objectContaining({ role: 'coach' })
        );
    });

    test('CoachingPlanService: a session note by an admin linked to nobody is not written under a stranger', async () => {
        mockEmployees.findById.mockResolvedValue({
            id: 152,
            supervisorId: 136,
            managerId: 137,
            managerType: 'employee',
        });
        mockRbac.canAccessEmployeeData.mockResolvedValue(true);
        mockDb.get.mockResolvedValue({ id: 3, employeeId: 152, kind: 'coaching' });
        await expect(
            CoachingPlan.recordSession(
                { id: 702, userType: 'admin', role: 'localadmin', permissions: [] },
                3,
                { note: 'x' },
                null
            )
        ).rejects.toMatchObject({ code: 'NO_ACTING_PERSON' });
        expect(mockDb.run).not.toHaveBeenCalled();
        await CoachingPlan.recordSession(LINKED703, 3, { note: 'x' }, req(LINKED703));
        expect(mockDb.run).toHaveBeenCalledWith(
            expect.stringMatching(/INSERT INTO coaching_sessions/),
            [152, 137, 'coach', 'x', 3]
        );
    });

    test('v2-talent: the rating reviewer is the person, the placer is the admin account or nobody', () => {
        const src = read('src/routes/v2-talent.js');
        expect(src).not.toMatch(/reviewerId:\s*req\.user\.id/);
        expect(src).not.toMatch(/placedBy:\s*req\.user\.id/);
        expect(src).toMatch(/placedBy:\s*placedByFor\(req\.user\)/);
    });
});
