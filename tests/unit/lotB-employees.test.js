'use strict';
/**
 * Lot B — B2 (the roster and the manager surfaces) and B4 (the security trail).
 *   · /employees filters by department / service / supervisor and exports the
 *     filtered set; the search finds a USERNAME
 *   · a manager edits contact + reporting line, never the placement or the
 *     matricule — the form hides them and a hand-crafted POST is refused
 *   · a manager ASKS for an unlock / resend; the ask is one open row
 *   · a failed employee login is ONE row, carrying the person (entityId +
 *     actor_ref), and an expired invitation is told to the person
 */

const mockDb = {
    get: jest.fn(),
    all: jest.fn(() => Promise.resolve([])),
    run: jest.fn(() => Promise.resolve()),
    runTransaction: jest.fn((fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(() => Promise.resolve()) }));

const fs = require('fs');
const path = require('path');
const db = require('../../src/config/database');
const LogService = require('../../src/services/LogService');
const EmployeeModel = require('../../src/models/EmployeeModel');
const EmployeeController = require('../../src/controllers/EmployeeController');
const EmployeeAuthService = require('../../src/services/EmployeeAuthService');

const REPO = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const superAdmin = { id: 1, userType: 'admin', role: 'superadmin', username: 'admin' };
const manager = {
    id: 136,
    userType: 'manager',
    username: 'qa.manager',
    firstName: 'Q',
    lastName: 'M',
};

function reqOf(user, { body = {}, params = {}, query = {} } = {}) {
    const r = {
        user,
        body,
        params,
        query,
        ip: '127.0.0.1',
        path: '/employees',
        get: () => 'jest',
        t: (k) => k,
        flash: (k, v) => {
            r._flash.push([k, v]);
        },
        _flash: [],
    };
    return r;
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
    r.redirect = (u) => {
        r.redirectedTo = u;
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
    LogService.log.mockReset();
    LogService.log.mockResolvedValue();
});

describe('the roster filters on the org structure', () => {
    test('department / service / supervisor reach the model instead of being dropped', async () => {
        const page = jest
            .spyOn(EmployeeModel, 'findPageWithOrg')
            .mockResolvedValue({ rows: [], total: 0 });
        jest.spyOn(EmployeeModel, 'accountStates').mockResolvedValue(new Map());
        jest.spyOn(EmployeeModel, 'campaignStates').mockResolvedValue(new Map());
        const res = resOf();
        await EmployeeController.index(
            reqOf(superAdmin, {
                query: { departmentId: '1', serviceId: '4', supervisorId: '137' },
            }),
            res
        );
        expect(page.mock.calls[0][0].filters).toMatchObject({
            departmentId: 1,
            serviceId: 4,
            supervisorId: 137,
            isActive: true,
        });
        expect(res.view).toBe('pages/employees/index');
        jest.restoreAllMocks();
    });

    test('the search clause matches a username, not only the name and the matricule', async () => {
        jest.spyOn(EmployeeModel, 'accountStates').mockResolvedValue(new Map());
        jest.spyOn(EmployeeModel, 'campaignStates').mockResolvedValue(new Map());
        db.get.mockResolvedValue({ total: 0 });
        await EmployeeModel.findPageWithOrg({
            filters: { search: 'qa.employee' },
            limit: 10,
            offset: 0,
        });
        const [sql, params] = db.all.mock.calls[0];
        expect(sql).toContain('e.username ILIKE ?');
        expect(params.filter((p) => p === '%qa.employee%').length).toBeGreaterThanOrEqual(3);
        jest.restoreAllMocks();
    });

    test('?sort= can only ever reach SQL through the whitelist', async () => {
        db.get.mockResolvedValue({ total: 0 });
        await EmployeeModel.findPageWithOrg({
            filters: {},
            limit: 10,
            offset: 0,
            orderBy: 'lastName;DROP TABLE:desc',
        });
        expect(db.all.mock.calls[0][0]).not.toContain('DROP TABLE');
        expect(Object.keys(EmployeeModel.SORT_COLUMNS)).toEqual(
            expect.arrayContaining([
                'employeeNumber',
                'lastName',
                'site',
                'supervisor',
                'lastLogin',
            ])
        );
    });

    test('the export is the filtered list, with an audit row and 13 translated columns', async () => {
        jest.spyOn(EmployeeModel, 'findPageWithOrg').mockResolvedValue({
            rows: [
                {
                    id: 142,
                    employeeNumber: 'MOUA1184',
                    lastName: 'O',
                    firstName: 'M',
                    roleName: 'R',
                    siteName: 'S',
                    departmentName: 'D',
                    serviceName: 'SV',
                    email: null,
                    username: 'MOUA1184',
                    isActive: true,
                },
            ],
            total: 1,
        });
        jest.spyOn(EmployeeModel, 'accountStates').mockResolvedValue(
            new Map([[142, { state: 'never_invited', lastLoginAt: null }]])
        );
        jest.spyOn(EmployeeModel, 'campaignStates').mockResolvedValue(new Map());
        const res = resOf();
        await EmployeeController.index(
            reqOf(superAdmin, { query: { export: 'csv', departmentId: '1' } }),
            res
        );
        expect(res.headers['Content-Type']).toBe('text/csv; charset=utf-8');
        expect(String(res.body).charCodeAt(0)).toBe(0xfeff);
        expect(String(res.body).split('\r\n')[1].split(',')).toHaveLength(13);
        expect(LogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'EMPLOYEES_EXPORTED' })
        );
        jest.restoreAllMocks();
    });

    test('the export button points at the list route — /employees/:id would swallow /employees/export.csv', () => {
        const view = read('views/pages/employees/index.ejs');
        expect(view).toContain('/employees?export=csv');
        expect(view).not.toContain('"/employees/export.csv');
        expect(read('src/routes/index.js')).not.toContain("router.get('/employees/export.csv'");
    });
});

describe('what a manager may change', () => {
    test('a hand-crafted POST cannot move the person or rewrite the matricule', async () => {
        jest.spyOn(EmployeeModel, 'findById').mockResolvedValue({
            id: 138,
            employeeNumber: 'EMP138',
            siteId: 11,
            departmentId: 3,
            serviceId: 7,
            roleId: 4,
            isActive: true,
        });
        jest.spyOn(
            require('../../src/services/RBACService'),
            'canAccessEmployeeData'
        ).mockResolvedValue(true);
        const req = reqOf(manager, {
            params: { id: '138' },
            body: {
                siteId: '12',
                departmentId: '3',
                serviceId: '7',
                roleId: '4',
                employeeNumber: 'EMP138',
                firstName: 'A',
                lastName: 'B',
            },
        });
        const res = resOf();
        await EmployeeController.update(req, res);
        expect(req._flash[0]).toEqual(['error', 'flash:emp_manager_org_locked']);
        expect(res.redirectedTo).toContain('/employees/138/edit'); // the form is kept, not dropped
        expect(db.run).not.toHaveBeenCalled();
        jest.restoreAllMocks();
    });

    test('the form itself shows the placement read-only for a manager', () => {
        const view = read('views/pages/employees/edit.ejs');
        const locked = view.slice(view.indexOf('<% if (mgrOnly) {'), view.indexOf('<% } else {'));
        ['employeeNumber', 'siteId', 'departmentId', 'serviceId', 'roleId'].forEach((f) => {
            expect(locked).toContain(`<input type="hidden" name="${f}"`);
        });
        expect(locked).not.toContain('<select');
    });

    test('a manager ASKS for an unlock; a second ask does not queue a duplicate', async () => {
        jest.spyOn(EmployeeModel, 'findById').mockResolvedValue({
            id: 138,
            employeeNumber: 'EMP138',
            isActive: true,
        });
        db.get.mockResolvedValueOnce(null); // no open request yet
        const res1 = resOf();
        await EmployeeController.accountRequest(
            reqOf(manager, { params: { id: '138' }, body: { kind: 'unlock', note: 'bloqué' } }),
            res1
        );
        expect(res1.body).toMatchObject({ ok: true });
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO account_requests'),
            [138, 'unlock', 136, 'bloqué']
        );
        expect(LogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'ACCOUNT_REQUEST_CREATED', actorRef: 'employee:136' })
        );

        db.run.mockClear();
        db.get.mockResolvedValueOnce({ id: 9 }); // already open
        const res2 = resOf();
        await EmployeeController.accountRequest(
            reqOf(manager, { params: { id: '138' }, body: { kind: 'unlock' } }),
            res2
        );
        expect(res2.body).toMatchObject({ ok: true, alreadyOpen: true });
        expect(db.run).not.toHaveBeenCalled();
        jest.restoreAllMocks();
    });

    test('an unknown request kind is a clean 400, not a 500', async () => {
        const res = resOf();
        await EmployeeController.accountRequest(
            reqOf(manager, { params: { id: '138' }, body: { kind: 'nope' } }),
            res
        );
        expect([res.code, res.body.code]).toEqual([400, 'bad_request_kind']);
        expect(res.body.error).toBe('admin:acc_err_bad_request_kind');
    });

    test('the dead credential endpoints are gone (they set passwords outside the console)', () => {
        expect(typeof EmployeeController.activateAccount).toBe('undefined');
        expect(typeof EmployeeController.resetPassword).toBe('undefined');
        const routes = read('src/routes/index.js');
        expect(routes).not.toContain('EmployeeController.activateAccount');
        expect(routes).not.toContain('EmployeeController.resetPassword');
    });
});

describe('the security trail of a failed sign-in', () => {
    const reqAuth = { ip: '10.0.0.1', get: () => 'jest' };

    test('a failed password names the person: entityId + actor_ref, ONE row', async () => {
        jest.spyOn(EmployeeModel, 'findByUsername').mockResolvedValue({
            id: 138,
            username: 'qa.employee',
            isAccountActive: true,
            passwordHash: '$2b$10$notarealhash',
        });
        const out = await EmployeeAuthService.login('qa.employee', 'wrong', reqAuth);
        expect(out.success).toBe(false);
        expect(LogService.log).toHaveBeenCalledTimes(1);
        expect(LogService.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'EMPLOYEE_LOGIN_FAILED',
                entityType: 'employee',
                entityId: 138,
                actorRef: 'employee:138',
            })
        );
        jest.restoreAllMocks();
    });

    test('an identifier that names an ADMIN writes no second, employee-side row', async () => {
        jest.spyOn(EmployeeModel, 'findByUsername').mockResolvedValue(null);
        jest.spyOn(require('../../src/models/AdminModel'), 'findByUsername').mockResolvedValue({
            id: 1,
            username: 'admin',
        });
        const out = await EmployeeAuthService.login('admin', 'wrong', reqAuth);
        expect(out.success).toBe(false);
        expect(LogService.log).not.toHaveBeenCalled();
        jest.restoreAllMocks();
    });

    test('an unknown identifier is still recorded, without a person on it', async () => {
        jest.spyOn(EmployeeModel, 'findByUsername').mockResolvedValue(null);
        jest.spyOn(require('../../src/models/AdminModel'), 'findByUsername').mockResolvedValue(
            null
        );
        await EmployeeAuthService.login('ghost', 'wrong', reqAuth);
        expect(LogService.log).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'EMPLOYEE_LOGIN_FAILED',
                entityType: null,
                entityId: null,
                actorRef: null,
            })
        );
        jest.restoreAllMocks();
    });

    test('a policy refusal is parked once for the login page, then forgotten', () => {
        expect(EmployeeAuthService.takeRefusalCode('nobody')).toBeNull();
        const src = read('src/services/EmployeeAuthService.js');
        expect(src).toContain("parkRefusal(identifier, 'INVITATION_EXPIRED')");
        const auth = read('src/controllers/AuthController.js');
        expect(auth).toContain('EmployeeAuthService.takeRefusalCode(req.body.username)');
        expect(auth).toContain("req.t('flash:auth_invitation_expired')");
        // the third, unattributed LOGIN_FAILED row is only written when no
        // strategy answered at all
        // \s* on purpose: prettier puts the call on its own line under the `if`
        // and wraps its arguments one per line. The rule pinned here is that the
        // unattributed row is written ONLY under this guard — not the layout.
        expect(auth).toMatch(
            /if \(!info \|\| !info\.message\)\s*authAudit\(\s*req,\s*'LOGIN_FAILED'/
        );
    });
});
