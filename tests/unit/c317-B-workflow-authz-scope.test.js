'use strict';
/**
 * 3.23.17 — lane B (workflow authz), findings 4, 5, 6, 7 and 8.
 *
 *   B-4  report-scheduler replayed under the STORED creator role.
 *   B-5  coverage rules: the generator planned every site; createRule took any unit.
 *   B-6  continuity successor / emergency-cover / incumbent took any employeeId.
 *   B-7  coaching plan read unredacted by its subject; org-wide bias scan open to
 *        any manager; SCIM create was an existence oracle outside the key scope.
 *   B-8  MFA backup code double use; disable() not atomic.
 *
 * Every module is loaded fresh with its own mocks (jest.resetModules + doMock).
 */

const path = require('path');
const express = require('express');
const DB_PATH = path.join(__dirname, '..', '..', 'src', 'config', 'database.js');
const pass = (req, res, next) => next();

function drive(mount, router, user, method, url, body = {}) {
    return new Promise((resolve) => {
        const app = express.Router();
        app.use(mount, router);
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json',
            host: 'h',
        };
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
            protocol: 'http',
            xhr: true,
            isAuthenticated: () => true,
            get: (h) => headers[String(h).toLowerCase()],
            flash: () => {},
            t: (k, o) => (o && o.defaultValue) || k,
        };
        const res = {
            _status: 200,
            headersSent: false,
            status(s) {
                this._status = s;
                return this;
            },
            json(j) {
                resolve({ status: this._status, json: j });
            },
            end() {
                resolve({ status: this._status });
            },
            render(v) {
                resolve({ status: this._status, render: v });
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

// ---------------------------------------------------------------- B-4
describe('B-4 — a scheduled report replays under the creator’s CURRENT account', () => {
    function load(getImpl) {
        jest.resetModules();
        const db = {
            get: jest.fn(getImpl),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({ changes: 1 })),
        };
        jest.doMock(DB_PATH, () => db);
        const executeReport = jest.fn(async () => []);
        jest.doMock('../../src/services/ReportBuilderService', () => ({
            executeReport,
            exportToCSV: () => 'a',
            excelCsv: (b) => b,
        }));
        const send = jest.fn(async () => ({ sent: true }));
        jest.doMock('../../src/services/EmailService', () => ({ send }));
        const log = jest.fn(async () => {});
        jest.doMock('../../src/services/LogService', () => ({ log }));
        jest.doMock('../../src/services/JobRunService', () => ({ alert: jest.fn(async () => {}) }));
        return { sched: require('../../src/jobs/report-scheduler'), db, executeReport, send, log };
    }
    const SCHED = {
        id: 4,
        createdBy: 2,
        creatorType: 'admin',
        creatorRole: 'superadmin',
        templateName: 'T',
        dataSource: 'readiness',
        selectedFields: '[]',
        recipients: 'x@example.test',
        frequency: 'daily',
    };

    test('a DEACTIVATED creator: nothing is built, nothing is sent, the run is marked skipped', async () => {
        const { sched, db, executeReport, send, log } = load(async (sql) =>
            /FROM admins/.test(sql) ? { id: 2, role: 'superadmin', isActive: false } : undefined
        );
        const status = await sched.runOne(SCHED);
        expect(status).toBe('skipped: creator_inactive');
        expect(executeReport).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(db.run.mock.calls[0][1]).toEqual(['skipped: creator_inactive', 4]);
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'REPORT_SCHEDULE_SKIPPED' })
        );
    });

    test('an UNKNOWN creator is skipped too', async () => {
        const { sched, executeReport } = load(async () => undefined);
        await expect(sched.runOne(SCHED)).resolves.toBe('skipped: creator_inactive');
        expect(executeReport).not.toHaveBeenCalled();
    });

    test('a creator DEMOTED since scheduling replays under the current role, never the stored superadmin', async () => {
        const { sched, executeReport } = load(async (sql) =>
            /FROM admins/.test(sql) ? { id: 2, role: 'localadmin', isActive: true } : undefined
        );
        await sched.runOne(SCHED);
        expect(executeReport.mock.calls[0][1]).toEqual({
            id: 2,
            role: 'localadmin',
            userType: 'admin',
        });
    });

    test('an employee creator who has left is skipped', async () => {
        const { sched, executeReport } = load(async (sql) =>
            /FROM employees/.test(sql) ? { id: 137, isActive: false } : undefined
        );
        await sched.runOne({
            ...SCHED,
            createdBy: 137,
            creatorType: 'employee',
            creatorRole: null,
        });
        expect(executeReport).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------- B-5
describe('B-5 — coverage rules are authored only on units inside the caller’s scope', () => {
    // Employees: 1,2 at site 100 (dept 10); 3 at site 200 (dept 20). Caller governs 1 and 2.
    const EMP = [
        { id: 1, siteId: 100, departmentId: 10, serviceId: null },
        { id: 2, siteId: 100, departmentId: 10, serviceId: null },
        { id: 3, siteId: 200, departmentId: 20, serviceId: null },
    ];
    function load(scopeIds) {
        jest.resetModules();
        const db = {
            get: jest.fn(async () => ({ id: 77, name: 'R' })),
            all: jest.fn(async (sql, params = []) => {
                if (/FROM skills WHERE id IN/.test(sql)) return [{ id: 9, name: 'Rigging' }];
                if (/FROM sites/.test(sql))
                    return [
                        { id: 100, name: 'A' },
                        { id: 200, name: 'B' },
                    ];
                if (
                    /SELECT DISTINCT site_id, department_id, service_id FROM employees WHERE id IN/.test(
                        sql
                    )
                )
                    return EMP.filter((e) => params.map(Number).includes(e.id));
                if (/GROUPING SETS/.test(sql)) {
                    const ids = params.map(Number);
                    const rows = [];
                    for (const key of ['siteId', 'departmentId']) {
                        const units = [...new Set(EMP.map((e) => e[key]))];
                        for (const u of units) {
                            const inUnit = EMP.filter((e) => e[key] === u);
                            rows.push({
                                siteId: key === 'siteId' ? u : null,
                                departmentId: key === 'departmentId' ? u : null,
                                serviceId: null,
                                total: inUnit.length,
                                mine: inUnit.filter((e) => ids.includes(e.id)).length,
                            });
                        }
                    }
                    return rows;
                }
                if (/GROUP BY site_id/.test(sql))
                    return [
                        { unitId: 100, n: 2 },
                        { unitId: 200, n: 1 },
                    ];
                return [];
            }),
            run: jest.fn(async () => ({ changes: 1 })),
        };
        jest.doMock(DB_PATH, () => db);
        jest.doMock('../../src/utils/rbacScope', () => ({
            scopedEmployeeIds: jest.fn(async () => scopeIds),
            scopeClause: () => '',
        }));
        jest.doMock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
        return { db, CoverageService: require('../../src/services/CoverageService') };
    }
    const SCOPED = {
        id: 40,
        userType: 'admin',
        role: 'localadmin',
        permissions: ['manage_compliance'],
    };

    test('generator preview for a scoped caller plans ONLY their site (the other site is not even counted)', async () => {
        const { CoverageService } = load([1, 2]);
        const out = await CoverageService.generateRules(
            { skillIds: [9], scope: 'site' },
            40,
            false,
            { actor: SCOPED }
        );
        expect(out.planned.map((p) => p.siteId)).toEqual([100]);
        expect(out.skipped).toBe(0);
    });

    test('company-wide generation is empty for a scoped caller', async () => {
        const { CoverageService } = load([1, 2]);
        const out = await CoverageService.generateRules(
            { skillIds: [9], scope: 'company' },
            40,
            false,
            { actor: SCOPED }
        );
        expect(out.plannedCount).toBe(0);
    });

    test('an unrestricted caller still plans every staffed site', async () => {
        const { CoverageService } = load(null);
        const out = await CoverageService.generateRules(
            { skillIds: [9], scope: 'site' },
            1,
            false,
            { actor: { id: 1, userType: 'admin', role: 'superadmin' } }
        );
        expect(out.planned.map((p) => p.siteId).sort()).toEqual([100, 200]);
    });

    test('createRule: a unit outside the caller’s scope is refused 403 and nothing is inserted', async () => {
        const { CoverageService, db } = load([1, 2]);
        const Ctl = require('../../src/controllers/ComplianceController');
        const req = {
            user: SCOPED,
            body: { name: 'R', siteId: '200', skillId: '9', minHeadcount: '1' },
            headers: { accept: 'application/json' },
            xhr: true,
            get: () => 'jest',
            ip: '1',
            t: (k) => k,
            flash: () => {},
        };
        let out;
        const res = {
            status(s) {
                out = { s };
                return this;
            },
            json(j) {
                out = { ...(out || { s: 200 }), j };
            },
        };
        void CoverageService;
        await Ctl.createRule(req, res);
        expect(out.s).toBe(403);
        expect(db.get.mock.calls.some(([sql]) => /INSERT INTO coverage_rules/.test(sql))).toBe(
            false
        );
    });

    test('createRule: the caller’s own, wholly-governed site is accepted', async () => {
        const { db } = load([1, 2]);
        const Ctl = require('../../src/controllers/ComplianceController');
        const req = {
            user: SCOPED,
            body: { name: 'R', siteId: '100', skillId: '9', minHeadcount: '1' },
            headers: { accept: 'application/json' },
            xhr: true,
            get: () => 'jest',
            ip: '1',
            t: (k) => k,
            flash: () => {},
        };
        let out = { s: 200 };
        const res = {
            status(s) {
                out.s = s;
                return this;
            },
            json(j) {
                out.j = j;
            },
        };
        await Ctl.createRule(req, res);
        expect(out.s).toBe(200);
        expect(db.get.mock.calls.some(([sql]) => /INSERT INTO coverage_rules/.test(sql))).toBe(
            true
        );
    });
});

// ---------------------------------------------------------------- B-6
describe('B-6 — continuity: the employee named in the body must be in the caller’s scope', () => {
    let router;
    let Cont;
    const MGR = { id: 136, userType: 'manager' };
    beforeEach(() => {
        jest.resetModules();
        jest.doMock(DB_PATH, () => ({
            get: jest.fn(async (sql) =>
                /FROM succession_plans/.test(sql) ? { incumbentEmployeeId: 138 } : undefined
            ),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({ changes: 1 })),
        }));
        jest.doMock('../../src/middleware/auth', () => ({
            requireAuth: pass,
            requireManagerOrAnyPermission: () => pass,
        }));
        Cont = {
            addSuccessor: jest.fn(async () => ({ id: 1, readinessBand: 'ready_now' })),
            setEmergencyCover: jest.fn(async () => ({ id: 2 })),
            setIncumbent: jest.fn(async () => {}),
            ensurePlan: jest.fn(async () => ({ id: 3 })),
        };
        jest.doMock('../../src/services/ContinuityService', () => Cont);
        jest.doMock('../../src/services/RetentionRiskService', () => ({}));
        jest.doMock('../../src/services/HandoverService', () => ({}));
        jest.doMock('../../src/services/LogService', () => ({ log: jest.fn(async () => {}) }));
        jest.doMock('../../src/services/RBACService', () => ({
            isSuperAdmin: () => false,
            getFilteredEmployees: jest.fn(async () => [{ id: 138 }, { id: 139 }]),
        }));
        router = require('../../src/routes/v2-continuity');
    });

    test.each([
        ['/plan/5/successor', 'addSuccessor', { employeeId: 999 }],
        ['/plan/5/emergency-cover', 'setEmergencyCover', { employeeId: 999 }],
        ['/plan/5/incumbent', 'setIncumbent', { incumbentEmployeeId: 999 }],
    ])('%s with an out-of-scope employee → 403, nothing written', async (url, fn, body) => {
        const out = await drive('/v2/continuity', router, MGR, 'POST', url, body);
        expect(out.status).toBe(403);
        expect(Cont[fn]).not.toHaveBeenCalled();
    });

    test('POST /plan with an out-of-scope incumbent → 403', async () => {
        const out = await drive('/v2/continuity', router, MGR, 'POST', '/plan', {
            roleId: 4,
            incumbentEmployeeId: 999,
        });
        expect(out.status).toBe(403);
        expect(Cont.ensurePlan).not.toHaveBeenCalled();
    });

    test('an in-scope successor is still accepted', async () => {
        const out = await drive('/v2/continuity', router, MGR, 'POST', '/plan/5/successor', {
            employeeId: 139,
        });
        expect(out.status).toBe(200);
        expect(Cont.addSuccessor).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------- B-7
describe('B-7a — GET /api/coaching/:id is redacted for its SUBJECT', () => {
    function load() {
        jest.resetModules();
        jest.doMock(DB_PATH, () => ({
            get: jest.fn(async () => undefined),
            all: jest.fn(async () => []),
        }));
        const plan = {
            id: 8,
            employeeId: 137,
            title: 'Coaching plan. From 9-box "High Performer".',
            objective: 'Lead the shift handover. Placed as High Performer.',
            expectedOutcome: 'Autonomy.',
            actions: [
                {
                    id: 1,
                    description: 'Shadow the lead. Core Player follow-up.',
                    progressNote: null,
                },
            ],
            context: { type: 'skill_gap', id: 4, label: 'Skill gap: Rigging' },
        };
        jest.doMock('../../src/services/CoachingPlanService', () => ({
            getPlan: jest.fn(async () => JSON.parse(JSON.stringify(plan))),
            resolveAuthority: jest.fn(async () => ({ canView: true })),
        }));
        return require('../../src/controllers/CoachingPlanController');
    }
    async function get(ctl, user) {
        let body;
        await ctl.get(
            { user, params: { id: '8' }, t: (k) => k },
            {
                headersSent: false,
                status() {
                    return this;
                },
                json(j) {
                    body = j;
                },
            }
        );
        return body;
    }

    test('the subject never reads the undisclosed placement', async () => {
        const body = await get(load(), { id: 137, userType: 'employee' });
        const text = JSON.stringify(body.plan);
        expect(text).not.toMatch(/High Performer|9-box|Core Player/);
        expect(body.plan.objective).toContain('Lead the shift handover.');
    });

    test('their supervisor still reads the plan as written', async () => {
        const body = await get(load(), { id: 136, userType: 'manager' });
        expect(body.plan.title).toContain('High Performer');
    });
});

describe('B-7b — the org-wide bias scan is SuperAdmin-only', () => {
    let router;
    let Bias;
    beforeEach(() => {
        jest.resetModules();
        jest.doMock(DB_PATH, () => ({
            get: jest.fn(async () => ({ id: 3 })),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({})),
        }));
        jest.doMock('../../src/middleware/auth', () => ({ requireAuth: pass }));
        jest.doMock('../../src/middleware/rateLimiter', () => ({ writeActionLimiter: pass }));
        jest.doMock('../../src/services/TalentService', () => ({}));
        jest.doMock('../../src/services/DevelopmentTriggerService', () => ({}));
        Bias = { runForCycle: jest.fn(async () => ({ alerts: [] })) };
        jest.doMock('../../src/services/BiasDetectionService', () => Bias);
        jest.doMock('../../src/services/RBACService', () => ({
            isSuperAdmin: (u) => u && u.userType === 'admin' && u.role === 'superadmin',
            isViewer: () => false,
        }));
        router = require('../../src/routes/v2-talent');
    });

    test('a manager is refused and the scan never runs', async () => {
        const out = await drive(
            '/v2/talent',
            router,
            { id: 136, userType: 'manager' },
            'POST',
            '/bias/scan',
            { cycleId: 3 }
        );
        expect(out.status).toBe(403);
        expect(Bias.runForCycle).not.toHaveBeenCalled();
    });

    test('a scoped local admin is refused too', async () => {
        const out = await drive(
            '/v2/talent',
            router,
            { id: 40, userType: 'admin', role: 'localadmin' },
            'POST',
            '/bias/scan',
            { cycleId: 3 }
        );
        expect(out.status).toBe(403);
    });

    test('a SuperAdmin runs it', async () => {
        const out = await drive(
            '/v2/talent',
            router,
            { id: 1, userType: 'admin', role: 'superadmin' },
            'POST',
            '/bias/scan',
            { cycleId: 3 }
        );
        expect(out.status).toBe(200);
        expect(Bias.runForCycle).toHaveBeenCalled();
    });
});

describe('B-7c — SCIM create is not an existence oracle outside the key’s scope', () => {
    let router;
    let Onb;
    beforeEach(() => {
        jest.resetModules();
        jest.doMock(DB_PATH, () => ({
            get: jest.fn(async (sql) =>
                /FROM employees WHERE (lower\(email\)|id = \?)/.test(sql) ? { id: 900 } : undefined
            ),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({ changes: 1 })),
        }));
        jest.doMock('../../src/middleware/apiAuth', () => ({
            requireApiKey: pass,
            apiKeyCanWrite: () => true,
        }));
        Onb = { createFromSso: jest.fn(async () => ({ created: true })) };
        jest.doMock('../../src/services/OnboardingService', () => Onb);
        jest.doMock('../../src/services/RBACService', () => ({
            isSuperAdmin: (u) => u && u.role === 'superadmin',
            getFilteredEmployees: jest.fn(async () => [{ id: 10 }, { id: 11 }]),
        }));
        router = require('../../src/routes/scim');
    });
    const SCOPED_KEY = { id: 40, userType: 'admin', role: 'localadmin' };

    test('an address that belongs to someone OUTSIDE the scope: generic 403, never 409 "uniqueness"', async () => {
        const out = await drive('', router, SCOPED_KEY, 'POST', '/scim/v2/Users', {
            userName: 'x@example.test',
        });
        expect(out.status).toBe(403);
        expect(out.json.scimType).not.toBe('uniqueness');
        expect(JSON.stringify(out.json)).not.toMatch(/already exists/);
        expect(Onb.createFromSso).not.toHaveBeenCalled();
    });

    test('an unrestricted key still gets the 409 "uniqueness" the IdP needs', async () => {
        const out = await drive(
            '',
            router,
            { id: 1, userType: 'admin', role: 'superadmin' },
            'POST',
            '/scim/v2/Users',
            { userName: 'x@example.test' }
        );
        expect(out.status).toBe(409);
        expect(out.json.scimType).toBe('uniqueness');
    });
});

// ---------------------------------------------------------------- B-8
describe('B-8 — MFA backup codes are single-use under concurrency; disable is atomic', () => {
    function load(runImpl) {
        jest.resetModules();
        const bcrypt = require('bcrypt');
        const hash = bcrypt.hashSync('abc123', 4);
        const db = {
            get: jest.fn(async () => undefined),
            all: jest.fn(async () => [{ id: 1, codeHash: hash }]),
            run: jest.fn(runImpl || (async () => ({ changes: 1 }))),
            runTransaction: jest.fn(async (f) => f()),
        };
        jest.doMock(DB_PATH, () => db);
        return { db, Mfa: require('../../src/services/MfaService') };
    }

    test('the request that loses the claim (0 rows updated) is refused', async () => {
        const { Mfa, db } = load(async () => ({ changes: 0 }));
        await expect(
            Mfa.consumeBackupCode({ userType: 'admin', userId: 1, code: 'abc123' })
        ).resolves.toBe(false);
        expect(db.run.mock.calls[0][0]).toMatch(/AND used_at IS NULL/);
    });

    test('the request that wins the claim is accepted', async () => {
        const { Mfa } = load(async () => ({ changes: 1 }));
        await expect(
            Mfa.consumeBackupCode({ userType: 'admin', userId: 1, code: 'abc123' })
        ).resolves.toBe(true);
    });

    test('disable() deletes codes and secret inside ONE transaction', async () => {
        const { Mfa, db } = load();
        let inTx = false;
        const seen = [];
        db.runTransaction.mockImplementation(async (f) => {
            inTx = true;
            try {
                return await f();
            } finally {
                inTx = false;
            }
        });
        db.run.mockImplementation(async (sql) => {
            seen.push({ sql, inTx });
            return { changes: 1 };
        });
        await Mfa.disable({ userType: 'admin', userId: 1 });
        const deletes = seen.filter((s) => /DELETE FROM mfa_(backup_codes|secrets)/.test(s.sql));
        expect(deletes).toHaveLength(2);
        expect(deletes.every((d) => d.inTx)).toBe(true);
    });
});
