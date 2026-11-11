'use strict';
/**
 * Rating disputes, levels 0 and 1, through the authority ladder (routes/v2-slf):
 *
 *   - nobody decides a dispute about their own record — refused 403
 *     DISPUTE_OWN_RECORD before anything is decided, even when the scope
 *     check would let them through;
 *   - a decision is journalled with the rung it used (` as=<rung>`), and the
 *     direct manager is told when someone above them decided;
 *   - same reach in both modes: the route stays manager-only.
 *
 * The services are doubled; the route, its guards and AuthorityService.allows
 * are real.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const http = require('http');
const express = require('express');

const mockLogs = [];
jest.mock('../../src/services/LogService', () => ({
    log: jest.fn(async (e) => {
        mockLogs.push(e);
        return null;
    }),
}));
const mockNotices = [];
jest.mock('../../src/services/LineNoticeService', () => ({
    actedAbove: jest.fn(async (...a) => {
        mockNotices.push(a);
        return true;
    }),
}));
const mockDisputes = {
    employeeFor: jest.fn(async () => 500),
    resolveL0: jest.fn(async () => ({ resolved: true })),
    // Level 0 proposes since migration 194 (the person then answers).
    proposeL0: jest.fn(async () => ({ proposed: true })),
    resolveL1: jest.fn(async () => ({ resolved: true })),
    listForManager: jest.fn(async () => []),
};
jest.mock('../../src/services/DisputeServiceV2', () => mockDisputes);
const mockRbac = {
    isSuperAdmin: () => false,
    isLocalAdmin: () => false,
    isViewer: () => false,
    getFilteredEmployees: jest.fn(async () => [{ id: 500 }]),
};
jest.mock('../../src/services/RBACService', () => mockRbac);

const A = require('../../src/services/AuthorityService');
const router = require('../../src/routes/v2-slf');

let server;
let base;
let currentUser = { id: 40, userType: 'manager' };

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.isAuthenticated = () => true;
        req.user = currentUser;
        req.flash = () => {};
        next();
    });
    app.use('/v2/slf', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
});

let relSpy;
function relationIs(facts) {
    relSpy = jest.spyOn(A, 'relation').mockImplementation(async () => {
        return {
            employee: { id: 500 },
            mode: 'strict',
            isAdmin: false,
            isSuper: false,
            isLocalAdmin: false,
            isViewer: false,
            isSelf: false,
            selfByIdentity: false,
            isSupervisor: false,
            isDirectManager: false,
            isAdminManager: false,
            isLineAbove: false,
            inLine: true,
            inClearance: false,
            strictRung: 0,
            ladderRung: 0,
            rung: 0,
            as: 'none',
            ...facts,
        };
    });
}

beforeEach(() => {
    mockLogs.length = 0;
    mockNotices.length = 0;
    jest.clearAllMocks();
    currentUser = { id: 40, userType: 'manager' };
});
afterEach(() => {
    if (relSpy) relSpy.mockRestore();
    relSpy = null;
});

async function post(url, body) {
    const r = await fetch(base + url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
}

describe.each([
    ['0', 'proposeL0', 'DISPUTE_L0_PROPOSED'],
    ['1', 'resolveL1', 'DISPUTE_L1_RESOLVED'],
])('level %s', (lvl, fn, action) => {
    test('one’s own record is refused, even inside the scope; nothing is decided', async () => {
        relationIs({ isSelf: true, inLine: false });
        const r = await post(`/v2/slf/disputes/7/resolve-l${lvl}`, {
            decidedRating: 2,
            reason: 'x',
        });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('DISPUTE_OWN_RECORD');
        expect(mockDisputes[fn]).not.toHaveBeenCalled();
        expect(mockLogs).toEqual([]);
    });

    test('the line above decides as a manager, on the journal, and the direct manager is told', async () => {
        relationIs({ isLineAbove: true });
        const r = await post(`/v2/slf/disputes/7/resolve-l${lvl}`, {
            decidedRating: 2,
            reason: 'Decided after a conversation.',
        });
        expect(r.status).toBe(200);
        expect(mockDisputes[fn]).toHaveBeenCalledTimes(1);
        const line = mockLogs.find((e) => e.action === action);
        expect(line).toBeDefined();
        expect(line.details).toMatch(/ as=manager$/);
        expect(line.actorRef).toBe('employee:40');
        expect(mockNotices).toEqual([[currentUser, 500, `dispute_l${lvl}`]]);
    });

    test('an administrator is still refused at the route (same reach in both modes)', async () => {
        const spy = jest.spyOn(A, 'mode').mockResolvedValue('extended');
        currentUser = { id: 9, userType: 'admin', role: 'localadmin', permissions: [] };
        try {
            const r = await post(`/v2/slf/disputes/7/resolve-l${lvl}`, { decidedRating: 2 });
            expect(r.status).toBe(403);
            expect(mockDisputes[fn]).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});
