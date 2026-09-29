'use strict';
/**
 * 3.23.17 — lane F-talent-modules, route authority (/v2/cap), executed through
 * the real router with mocked guards, RBAC and database.
 *
 *  - survey open / close / results had no owner check;
 *  - objective/:id/align took any goalId (no scope check);
 *  - opportunity close/fill and the applicant list are poster/scope-bound;
 *  - the new-opportunity notification pool is the poster's scope;
 *  - the hub lists are filtered for a non-SuperAdmin.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const pass = (req, res, next) => next();
jest.mock('../../src/middleware/auth', () => ({
    requireAuth: (req, res, next) => next(),
    requireManagerOrAdmin: (req, res, next) => next(),
    requireManagerOrAnyPermission: () => (req, res, next) => next(),
    requireSuperAdmin: (req, res, next) => next(),
    wantsJson: () => true,
}));
jest.mock('../../src/middleware/rateLimiter', () => ({
    writeActionLimiter: (req, res, next) => next(),
}));
const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
const mockRbac = {
    isSuperAdmin: (u) => !!u && u.userType === 'admin' && u.role === 'superadmin',
    getFilteredEmployees: jest.fn(),
};
jest.mock('../../src/services/RBACService', () => mockRbac);
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(),
    enqueueBulkInApp: jest.fn().mockResolvedValue(),
}));
jest.mock('../../src/services/TalentDepthService', () => ({
    listCalibrations: jest.fn().mockResolvedValue([]),
    listObjectives: jest.fn().mockResolvedValue([]),
    alignGoal: jest.fn().mockResolvedValue({ id: 99 }),
    objectiveCascade: jest.fn(),
}));
jest.mock('../../src/services/RecognitionService', () => ({
    feed: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../src/services/SkillsIntelligenceService', () => ({
    adjacent: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../src/services/WebhookService', () => ({}));
jest.mock('../../src/services/DSRService', () => ({}));
jest.mock('../../src/services/CopilotService', () => ({}));

const router = require('../../src/routes/v2-capability');
const Mob = require('../../src/services/MobilityService');
const Sv = require('../../src/services/SurveyService');
const Calib = require('../../src/services/TalentDepthService');
void pass;

function invoke(method, routePath, { user, params = {}, body = {}, query = {} }) {
    return new Promise((resolve, reject) => {
        const layer = router.stack.find(
            (l) => l.route && l.route.path === routePath && l.route.methods[method]
        );
        if (!layer) return reject(new Error('no route ' + routePath));
        const req = {
            user,
            params,
            body,
            query,
            headers: { accept: 'application/json' },
            get: () => '',
            method: method.toUpperCase(),
            path: routePath,
        };
        const res = {
            statusCode: 200,
            headersSent: false,
            status(c) {
                this.statusCode = c;
                return this;
            },
            json(b) {
                resolve({ status: this.statusCode, body: b });
                return this;
            },
            render(view, locals) {
                resolve({ status: this.statusCode, view, locals });
            },
        };
        const handles = layer.route.stack.map((s) => s.handle);
        let i = 0;
        const next = (err) => {
            if (err) return reject(err);
            const h = handles[i++];
            if (!h) return reject(new Error('fell through'));
            try {
                h(req, res, next);
            } catch (e) {
                reject(e);
            }
        };
        next();
    });
}

const SUPER = { userType: 'admin', role: 'superadmin', id: 1 };
const LOCAL = { userType: 'admin', role: 'localadmin', id: 7 };
const MGR = { userType: 'manager', id: 30 };

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockResolvedValue(null);
    mockDb.all.mockResolvedValue([]);
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockRbac.getFilteredEmployees.mockResolvedValue([{ id: 31 }, { id: 32 }]);
});

describe('surveys — owner check on open / close / results', () => {
    const someoneElses = { id: 4, createdByAdminId: 8, actorEmployeeId: null, state: 'draft' };
    test.each([
        ['post', '/survey/:id/open'],
        ['post', '/survey/:id/close'],
        ['get', '/survey/:id/results'],
    ])('%s %s refuses a non-owner (403) and touches nothing', async (m, p) => {
        const get = jest.spyOn(Sv, 'get').mockResolvedValue(someoneElses);
        const open = jest.spyOn(Sv, 'open');
        const close = jest.spyOn(Sv, 'close');
        const results = jest.spyOn(Sv, 'results');
        const r = await invoke(m, p, { user: LOCAL, params: { id: '4' } });
        expect(r.status).toBe(403);
        expect(open).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        expect(results).not.toHaveBeenCalled();
        get.mockRestore();
    });

    test('the owner opens it for THEIR scope, not the organisation', async () => {
        jest.spyOn(Sv, 'get').mockResolvedValue({ id: 4, createdByAdminId: 7 });
        const open = jest.spyOn(Sv, 'open').mockResolvedValue({ ok: true, invited: 2 });
        const r = await invoke('post', '/survey/:id/open', { user: LOCAL, params: { id: '4' } });
        expect(r.status).toBe(200);
        expect(open).toHaveBeenCalledWith(4, { audienceIds: [31, 32] });
    });

    test('a state-machine refusal is a 409 with a code, not a 500', async () => {
        jest.spyOn(Sv, 'get').mockResolvedValue({ id: 4, createdByAdminId: 7 });
        mockDb.get.mockResolvedValue(null); // UPDATE … WHERE state='open' matched nothing
        const r = await invoke('post', '/survey/:id/close', { user: LOCAL, params: { id: '4' } });
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ ok: false, code: 'survey_not_open' });
    });
});

describe('goal alignment — the goal must be in the actor scope', () => {
    test('an out-of-scope goal is refused and nothing is aligned', async () => {
        mockDb.get.mockResolvedValueOnce({ id: 50, employeeId: 999 }); // goal of someone out of scope
        const r = await invoke('post', '/objective/:id/align', {
            user: MGR,
            params: { id: '3' },
            body: { goalId: 50 },
        });
        expect(r.status).toBe(403);
        expect(Calib.alignGoal).not.toHaveBeenCalled();
    });

    test('an in-scope goal onto an active objective is aligned', async () => {
        mockDb.get
            .mockResolvedValueOnce({ id: 50, employeeId: 31 })
            .mockResolvedValueOnce({ id: 3 });
        const r = await invoke('post', '/objective/:id/align', {
            user: MGR,
            params: { id: '3' },
            body: { goalId: 50 },
        });
        expect(r.status).toBe(200);
        expect(Calib.alignGoal).toHaveBeenCalledWith(50, 3, 1.0);
    });

    test('a missing goal is a 404', async () => {
        const r = await invoke('post', '/objective/:id/align', {
            user: MGR,
            params: { id: '3' },
            body: { goalId: 50 },
        });
        expect(r.status).toBe(404);
    });
});

describe('opportunities — poster / scope authority', () => {
    test('close/fill by a non-poster is refused', async () => {
        jest.spyOn(Mob, 'getOpportunity').mockResolvedValue({
            id: 5,
            postedByAdminId: 8,
            actorEmployeeId: null,
        });
        const set = jest.spyOn(Mob, 'setOpportunityState');
        const r = await invoke('post', '/opportunity/:id/state', {
            user: LOCAL,
            params: { id: '5' },
            body: { state: 'closed', reason: 'x' },
        });
        expect(r.status).toBe(403);
        expect(set).not.toHaveBeenCalled();
    });

    test('the manager who posted it may fill it', async () => {
        jest.spyOn(Mob, 'getOpportunity').mockResolvedValue({
            id: 5,
            postedByAdminId: null,
            actorEmployeeId: 30,
        });
        const set = jest
            .spyOn(Mob, 'setOpportunityState')
            .mockResolvedValue({ ok: true, id: 5, state: 'filled' });
        const r = await invoke('post', '/opportunity/:id/state', {
            user: MGR,
            params: { id: '5' },
            body: { state: 'filled', reason: 'Awa' },
        });
        expect(r.status).toBe(200);
        expect(set).toHaveBeenCalledWith(
            5,
            expect.objectContaining({
                state: 'filled',
                reason: 'Awa',
                employeeId: 30,
                adminId: null,
            })
        );
    });

    test('a non-poster sees only the applicants they govern, and is refused when that is nobody', async () => {
        jest.spyOn(Mob, 'getOpportunity').mockResolvedValue({ id: 5, postedByAdminId: 8 });
        const list = jest.spyOn(Mob, 'listApplicants').mockResolvedValue([]);
        const r = await invoke('get', '/opportunity/:id/applicants', {
            user: LOCAL,
            params: { id: '5' },
        });
        expect(list).toHaveBeenCalledWith(5, { scopeIds: [31, 32] });
        expect(r.status).toBe(403);
    });

    test('the poster sees every applicant', async () => {
        jest.spyOn(Mob, 'getOpportunity').mockResolvedValue({ id: 5, postedByAdminId: 7 });
        const list = jest.spyOn(Mob, 'listApplicants').mockResolvedValue([{ id: 1 }]);
        const r = await invoke('get', '/opportunity/:id/applicants', {
            user: LOCAL,
            params: { id: '5' },
        });
        expect(list).toHaveBeenCalledWith(5, { scopeIds: null });
        expect(r.body).toEqual({ ok: true, applicants: [{ id: 1 }] });
    });

    test('a new posting notifies within the poster scope', async () => {
        const post = jest.spyOn(Mob, 'postOpportunity').mockResolvedValue({ id: 9 });
        await invoke('post', '/opportunity', {
            user: MGR,
            body: { title: 'Mission', closesOn: 'not-a-date' },
        });
        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({ audiencePool: [31, 32], closesOn: null, actorEmployeeId: 30 })
        );
    });

    test('the manager-poster may decide an application on their posting', async () => {
        mockDb.get.mockResolvedValueOnce({
            employeeId: 999,
            postedByAdminId: null,
            actorEmployeeId: 30,
        });
        const dec = jest.spyOn(Mob, 'decideApplication').mockResolvedValue({ ok: true });
        const r = await invoke('post', '/opportunity/application/:id/decide', {
            user: MGR,
            params: { id: '12' },
            body: { decision: 'accepted' },
        });
        expect(r.status).toBe(200);
        expect(dec).toHaveBeenCalled();
    });
});

describe('hub lists are filtered for a non-SuperAdmin', () => {
    test('a manager gets own + in-scope opportunities and own surveys only', async () => {
        const lo = jest.spyOn(Mob, 'listOpportunities').mockResolvedValue([
            { id: 1, actorEmployeeId: 30 },
            { id: 2, actorEmployeeId: 44 },
        ]);
        const ls = jest.spyOn(Sv, 'list').mockResolvedValue([]);
        const r = await invoke('get', '/', { user: MGR });
        expect(lo).toHaveBeenCalledWith('open', {
            includeExpired: true,
            visibleTo: { employeeId: 30, scopeIds: [31, 32] },
        });
        expect(ls).toHaveBeenCalledWith({ employeeId: 30 });
        expect(r.locals.opportunities.map((o) => o.canClose)).toEqual([true, false]);
    });

    test('the SuperAdmin keeps the unfiltered lists', async () => {
        const lo = jest.spyOn(Mob, 'listOpportunities').mockResolvedValue([]);
        const ls = jest.spyOn(Sv, 'list').mockResolvedValue([]);
        await invoke('get', '/', { user: SUPER });
        expect(lo).toHaveBeenCalledWith('open', { includeExpired: true, visibleTo: null });
        expect(ls).toHaveBeenCalledWith(null);
    });
});

describe('DEI — a malformed label is a 400, never stored', () => {
    test('POST /dei/:employeeId with markup is refused', async () => {
        const r = await invoke('post', '/dei/:employeeId', {
            user: SUPER,
            params: { employeeId: '31' },
            body: { gender: '<img src=x onerror=alert(1)>' },
        });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('dei_invalid_gender');
        expect(mockDb.get).not.toHaveBeenCalled();
    });
});
