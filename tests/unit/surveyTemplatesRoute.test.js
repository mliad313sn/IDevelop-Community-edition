'use strict';
/**
 * /v2/cap survey templates through the real router and the real
 * SurveyService with a mocked database: GET /survey/templates, and
 * POST /survey with a templateId (with or without an edited question list).
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
jest.mock('../../src/services/RBACService', () => ({
    isSuperAdmin: (u) => !!u && u.userType === 'admin' && u.role === 'superadmin',
    getFilteredEmployees: jest.fn(async () => []),
}));
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

function invoke(method, routePath, { user, body = {}, language = 'fr' }) {
    return new Promise((resolve, reject) => {
        const layer = router.stack.find(
            (l) => l.route && l.route.path === routePath && l.route.methods[method]
        );
        if (!layer) return reject(new Error('no route ' + routePath));
        const req = {
            user,
            params: {},
            body,
            query: {},
            language,
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

const ADMIN = { userType: 'admin', role: 'superadmin', id: 1 };
const MGR = { userType: 'manager', id: 40 };

beforeEach(() => {
    mockDb.get.mockResolvedValue({ id: 91, minResponses: 5 });
    mockDb.run.mockResolvedValue({ changes: 1 });
});

test('GET /survey/templates lists the templates in the reader language', async () => {
    const r = await invoke('get', '/survey/templates', { user: MGR, language: 'en' });
    expect(r.status).toBe(200);
    const pulse = r.body.templates.find((t) => t.id === 'engagement-pulse');
    expect(pulse.title).toBe('Engagement pulse');
});

test('POST /survey with templateId and no questions creates it from the template', async () => {
    const r = await invoke('post', '/survey', {
        user: MGR,
        language: 'fr',
        body: { templateId: 'onboarding-checkin' },
    });
    expect(r.body).toMatchObject({ ok: true, id: 91 });
    const params = mockDb.get.mock.calls[0][1];
    expect(params).toEqual(['onboarding', "Point d'intégration", true, 5, null, 40]);
    expect(mockDb.run.mock.calls.length).toBeGreaterThan(5);
});

test('POST /survey with templateId AND an edited list keeps the edited list', async () => {
    await invoke('post', '/survey', {
        user: ADMIN,
        body: {
            templateId: 'enps',
            kind: 'enps',
            title: 'Edited',
            questions: [{ text: 'Only this one', qtype: 'nps', category: 'enps' }],
        },
    });
    expect(mockDb.get.mock.calls[0][1].slice(0, 2)).toEqual(['enps', 'Edited']);
    expect(mockDb.run).toHaveBeenCalledTimes(1);
    expect(mockDb.run.mock.calls[0][1]).toEqual([91, 0, 'Only this one', 'nps', 'enps']);
});

test('POST /survey with an unknown templateId is a 404, nothing written', async () => {
    const r = await invoke('post', '/survey', { user: MGR, body: { templateId: 'nope' } });
    expect(r.status).toBe(404);
    expect(mockDb.get).not.toHaveBeenCalled();
});
