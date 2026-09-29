'use strict';
/**
 * 3.23.21 — lane L2, SEC-3 + SEC-5 (/v2/cap surveys), through the real router
 * and the real SurveyService with a mocked database.
 *
 *  SEC-3  POST /survey/:id/respond — only the employee THEMSELVES answers. An
 *         admin used to answer « for » any in-scope employee (body.employeeId).
 *  SEC-5  GET /survey/:id/questions — the audience of an opened survey, or its
 *         owner / the SuperAdmin. Anyone signed in used to read any survey's
 *         questions by id, drafts included.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

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
    // The local admin's scope contains employee 31 — the old admin branch took it.
    getFilteredEmployees: jest.fn(async () => [{ id: 31 }, { id: 32 }]),
};
jest.mock('../../src/services/RBACService', () => mockRbac);
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(),
    enqueueBulkInApp: jest.fn().mockResolvedValue(),
}));
jest.mock('../../src/services/TalentDepthService', () => ({}));
jest.mock('../../src/services/RecognitionService', () => ({}));
jest.mock('../../src/services/SkillsIntelligenceService', () => ({}));
jest.mock('../../src/services/WebhookService', () => ({}));
jest.mock('../../src/services/DSRService', () => ({}));
jest.mock('../../src/services/CopilotService', () => ({}));

const router = require('../../src/routes/v2-capability');

function invoke(method, routePath, { user, params = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const layer = router.stack.find(
            (l) => l.route && l.route.path === routePath && l.route.methods[method]
        );
        if (!layer) return reject(new Error('no route ' + routePath));
        const req = {
            user,
            params,
            body,
            query: {},
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
const OWNER_ADMIN = { userType: 'admin', role: 'localadmin', id: 9 };
const EMP_IN = { userType: 'employee', id: 31 };
const EMP_OUT = { userType: 'employee', id: 55 };
const MGR_OWNER = { userType: 'manager', id: 40 };

/**
 * A tiny fake of the three survey tables the paths read. `state` / audience /
 * owner are set per test.
 */
function world({
    state = 'open',
    audience = [31],
    audienceScoped = true,
    ownerAdmin = 9,
    ownerEmp = null,
} = {}) {
    const survey = {
        id: 5,
        title: 'Baromètre',
        state,
        anonymous: true,
        minResponses: 5,
        createdByAdminId: ownerAdmin,
        actorEmployeeId: ownerEmp,
        audienceScoped,
    };
    mockDb.get.mockImplementation(async (sql, p = []) => {
        if (/FROM surveys WHERE id = \?/.test(sql))
            return Number(p[0]) === 5 ? { ...survey } : undefined;
        if (/FROM survey_audience/.test(sql))
            return audience.includes(Number(p[1])) ? { ok: 1 } : undefined;
        if (/FROM employees WHERE id = \?/.test(sql)) return { siteId: 1, departmentId: 2 };
        return undefined;
    });
    mockDb.all.mockImplementation(async (sql) => {
        if (/FROM survey_questions WHERE survey_id = \? ORDER BY ord/.test(sql))
            return [{ id: 70, text: 'Q1', qtype: 'scale' }];
        if (/SELECT id, qtype FROM survey_questions/.test(sql)) return [{ id: 70, qtype: 'scale' }];
        return [];
    });
    mockDb.run.mockResolvedValue({ changes: 1 });
}

const responseInserts = () =>
    mockDb.run.mock.calls.filter(([sql]) => /INSERT INTO survey_responses/.test(sql));

beforeEach(() => {
    jest.clearAllMocks();
});

describe('SEC-3 — POST /survey/:id/respond: the employee themselves, nobody else', () => {
    const answers = [{ questionId: 70, score: 4 }];

    test('a local admin answering FOR an in-scope employee is refused, nothing is written', async () => {
        world();
        const r = await invoke('post', '/survey/:id/respond', {
            user: LOCAL,
            params: { id: '5' },
            body: { employeeId: 31, answers },
        });
        expect(r.status).toBe(403);
        expect(responseInserts()).toHaveLength(0);
    });

    test('the SuperAdmin cannot answer for someone either', async () => {
        world();
        const r = await invoke('post', '/survey/:id/respond', {
            user: SUPER,
            params: { id: '5' },
            body: { employeeId: 31, answers },
        });
        expect(r.status).toBe(403);
        expect(responseInserts()).toHaveLength(0);
    });

    test('an invited employee answers for THEMSELVES — a body employeeId is ignored', async () => {
        world();
        const r = await invoke('post', '/survey/:id/respond', {
            user: EMP_IN,
            params: { id: '5' },
            body: { employeeId: 32, answers },
        });
        expect(r.status).toBe(200);
        expect(r.body.recorded).toBe(1);
        expect(responseInserts()).toHaveLength(1);
    });
});

describe('SEC-5 — GET /survey/:id/questions: audience or owner only', () => {
    const ask = (user, id = '5') =>
        invoke('get', '/survey/:id/questions', { user, params: { id } });

    test('an employee OUTSIDE the audience gets 404, no questions', async () => {
        world();
        const r = await ask(EMP_OUT);
        expect(r.status).toBe(404);
        expect(r.body.questions).toBeUndefined();
    });

    test('an employee IN the audience of an open survey reads them', async () => {
        world();
        const r = await ask(EMP_IN);
        expect(r.status).toBe(200);
        expect(r.body.questions).toHaveLength(1);
    });

    test('a DRAFT is never shown to an employee (no audience yet — audience_scoped false)', async () => {
        world({ state: 'draft', audienceScoped: false, audience: [] });
        expect((await ask(EMP_IN)).status).toBe(404);
    });

    test('a local admin who did not create it: 404; its creator and the SuperAdmin: 200', async () => {
        world();
        expect((await ask(LOCAL)).status).toBe(404);
        expect((await ask(OWNER_ADMIN)).status).toBe(200);
        expect((await ask(SUPER)).status).toBe(200);
    });

    test('a manager who created it reads it even as a draft', async () => {
        world({
            state: 'draft',
            ownerAdmin: null,
            ownerEmp: 40,
            audienceScoped: false,
            audience: [],
        });
        expect((await ask(MGR_OWNER)).status).toBe(200);
    });

    test('unknown id and malformed id answer the same 404', async () => {
        world();
        expect((await ask(EMP_IN, '999')).status).toBe(404);
        expect((await ask(EMP_IN, 'abc')).status).toBe(404);
    });
});
