'use strict';
/**
 * Training completions to validate (/v2/lms/uplifts).
 *
 * 1. The template read `locale`, which the route never passes, so as soon as
 *    ONE completion was waiting the render threw a ReferenceError and the error
 *    handler bounced the manager away: nobody could validate a training. Proven
 *    by rendering the real template with the locals the route and server.js
 *    provide (res.locals.lang, no `locale`) and a NON-empty list.
 * 2. A refused decision (409 / 403 / 404) answered the English service message
 *    and the page toasted it to French readers. It is now translated by code.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
    withActor: jest.fn(async (_w, fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/middleware/auth', () => {
    const actual = jest.requireActual('../../src/middleware/auth');
    return { ...actual, requireAuth: (req, _res, next) => next() };
});

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const request = require('supertest');

const ROOT = path.join(__dirname, '../..');
const loadNs = (lng, ns) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lng, ns + '.json'), 'utf8'));
const tFor = (lng) => (key, opts) => {
    const [ns, k] = String(key).includes(':') ? key.split(':') : ['common', key];
    let dict;
    try {
        dict = loadNs(lng, ns);
    } catch (_) {
        dict = {};
    }
    if (typeof dict[k] === 'string') return dict[k];
    return opts && opts.defaultValue !== undefined ? opts.defaultValue : key;
};

const LmsService = require('../../src/services/LmsService');

const ROW = {
    completionId: 501,
    firstName: 'Alex',
    lastName: 'Sample',
    employeeNumber: 'E-138',
    courseTitle: 'Lockout procedure',
    completedAt: '2026-09-28T10:00:00Z',
    skills: [{ skillName: 'Isolation', from: 1, to: 3 }],
};

const renderUplifts = (locals) =>
    ejs.renderFile(path.join(ROOT, 'views/pages/lms/uplifts.ejs'), {
        __: tFor('fr'),
        cspNonce: 'n',
        csrfToken: 't',
        ...locals,
    });

describe('the page renders when a completion is waiting', () => {
    test('non-empty list, locals as the route and server.js give them (lang, no locale)', async () => {
        const html = await renderUplifts({ uplifts: [ROW], lang: 'fr' });
        expect(html).toContain('data-uplift="501"');
        expect(html).toContain('Alex');
        expect(html).toContain(new Date(ROW.completedAt).toLocaleDateString('fr'));
    });

    test('the date follows the reader language (en)', async () => {
        const html = await renderUplifts({ uplifts: [ROW], lang: 'en' });
        expect(html).toContain(new Date(ROW.completedAt).toLocaleDateString('en'));
    });

    test('no lang at all still renders and a missing date reads —', async () => {
        const html = await renderUplifts({ uplifts: [{ ...ROW, completedAt: null }] });
        expect(html).toContain('data-uplift="501"');
        expect(html).toContain('—');
    });

    test('through the real router: GET /v2/lms/uplifts renders 200 with the list', async () => {
        jest.spyOn(LmsService, 'pendingUplifts').mockResolvedValue([ROW]);
        const router = require('../../src/routes/v2-lms');
        const app = express();
        app.set('view engine', 'ejs');
        app.set('views', path.join(ROOT, 'views'));
        app.use((req, res, next) => {
            req.user = { id: 50, userType: 'manager' };
            req.t = tFor('fr');
            res.locals.__ = tFor('fr');
            res.locals.lang = 'fr';
            res.locals.cspNonce = 'n';
            res.locals.csrfToken = 't';
            next();
        });
        app.use('/v2/lms', router);
        // eslint-disable-next-line no-unused-vars
        app.use((err, _req, res, _next) => res.status(500).send('ERR ' + err.message));
        const r = await request(app).get('/v2/lms/uplifts').set('Accept', 'text/html');
        expect(r.status).toBe(200);
        expect(r.text).toContain('data-uplift="501"');
    });
});

describe('a refused decision is answered in the reader language', () => {
    const appAs = (lng) => {
        const router = require('../../src/routes/v2-lms');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { id: 50, userType: 'manager' };
            req.t = tFor(lng);
            next();
        });
        app.use('/v2/lms', router);
        return app;
    };
    beforeEach(() => {
        mockDb.get.mockReset();
        mockDb.run.mockReset();
        jest.restoreAllMocks();
    });

    test('409 already decided → French sentence, stable code', async () => {
        mockDb.get.mockResolvedValue({
            id: 501,
            employeeId: 138,
            applied: false,
            reviewReason: 'declined_by_supervisor',
        });
        const r = await request(appAs('fr')).post('/v2/lms/uplifts/501/accept').send({});
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('upl_err_not_pending');
        expect(r.body.error).toBe(loadNs('fr', 'lms').upl_err_not_pending);
        expect(r.body.error).not.toMatch(/not awaiting/i);
    });

    test('403 not the manager → French sentence', async () => {
        mockDb.get.mockResolvedValue({
            id: 501,
            employeeId: 138,
            applied: false,
            reviewReason: 'awaiting_supervisor',
        });
        jest.spyOn(LmsService, '_mayDecide').mockResolvedValue(false);
        const r = await request(appAs('fr')).post('/v2/lms/uplifts/501/decline').send({});
        expect(r.status).toBe(403);
        expect(r.body.error).toBe(loadNs('fr', 'lms').upl_err_forbidden);
    });

    test('404 → an English reader gets English', async () => {
        mockDb.get.mockResolvedValue(null);
        const r = await request(appAs('en')).post('/v2/lms/uplifts/999/accept').send({});
        expect(r.status).toBe(404);
        expect(r.body.error).toBe(loadNs('en', 'lms').upl_err_not_found);
    });

    test('an unexpected fault never leaks its message', async () => {
        mockDb.get.mockRejectedValue(new Error('relation lms_completions is broken'));
        const r = await request(appAs('en')).post('/v2/lms/uplifts/1/accept').send({});
        expect(r.status).toBe(500);
        expect(r.body.error).toBe(loadNs('en', 'lms').upl_failed);
        expect(r.body.code).toBe('internal_error');
    });

    test('FR and EN lms namespaces carry identical key sets', () => {
        expect(Object.keys(loadNs('fr', 'lms')).sort()).toEqual(
            Object.keys(loadNs('en', 'lms')).sort()
        );
    });
});
