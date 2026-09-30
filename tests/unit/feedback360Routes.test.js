'use strict';
/**
 * 360° feedback and one-to-one routes — the HTTP contract, without a database.
 *
 *   - Module guard: /feedback-360 answers the app's 404 while the development
 *     module is off, /one-on-one while engagement is off; both open on the
 *     next request once switched on (no restart).
 *   - A stranger gets a 404, a known party refused an action gets a 403, and
 *     the message is the catalogue's, in the reader's language.
 *   - routes/index.js mounts both prefixes behind their module guard, and
 *     config/modules.js declares them (no core prefix touched).
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const express = require('express');
const request = require('supertest');

// In-memory appSettings behind the real AppSettingsModel (same pattern as
// adoptionModules.test.js) — the module switches are exercised for real.
jest.mock('../../src/config/database', () => {
    const rows = new Map();
    return {
        __rows: rows,
        get: jest.fn(async (sql, params) => {
            if (!/appSettings/i.test(sql)) return undefined;
            const v = rows.get(params && params[0]);
            return v
                ? {
                      settingKey: params[0],
                      settingValue: v.value,
                      settingType: v.type,
                      category: v.category,
                  }
                : undefined;
        }),
        all: jest.fn(async () => []),
        run: jest.fn(async (sql, params) => {
            if (/^INSERT/.test(sql))
                rows.set(params[0], { value: params[1], type: params[2], category: params[4] });
            else if (/^UPDATE/.test(sql))
                rows.set(params[5], { value: params[0], type: params[1], category: params[3] });
            return {};
        }),
        runInSavepoint: jest.fn((fn) => fn()),
        runTransaction: jest.fn((fn) => fn()),
    };
});
jest.mock('../../src/services/LogService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
// The error middleware logs every refusal; keep the test output readable.
jest.mock('../../src/middleware/logger', () => {
    const actual = jest.requireActual('../../src/middleware/logger');
    const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
    return { ...actual, logger: quiet };
});

const refuse = (status, code) => Object.assign(new Error(code), { status, code, expose: true });
jest.mock('../../src/services/Feedback360Service', () => ({
    home: jest.fn(async () => ({ asSubject: [], toAnswer: [], toApprove: [] })),
    report: jest.fn(),
    release: jest.fn(),
}));
jest.mock('../../src/services/OneOnOneService', () => ({
    space: jest.fn(),
    saveNote: jest.fn(),
}));

const db = require('../../src/config/database');
const AppSettingsModel = require('../../src/models/AppSettingsModel');
const ModuleService = require('../../src/services/ModuleService');
const f360 = require('../../src/services/Feedback360Service');
const oo = require('../../src/services/OneOnOneService');

const EN = {
    ...require('../../locales/en/talentx.json'),
    ...require('../../locales/en/growth.json'),
};

function app(user = { id: 7, userType: 'employee' }) {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => {
        req.user = user;
        req.isAuthenticated = () => true;
        req.t = (k, o) => {
            const v = EN[String(k).split(':')[1]] || k;
            return o ? v.replace(/\{\{(\w+)\}\}/g, (_, n) => o[n]) : v;
        };
        req.flash = () => {};
        res.locals.lang = 'en';
        // Views are out of scope here: answer with the view name.
        res.render = (view) => res.json({ view });
        next();
    });
    a.use(
        '/feedback-360',
        ModuleService.requireModule('development'),
        require('../../src/routes/feedback360')
    );
    a.use(
        '/one-on-one',
        ModuleService.requireModule('engagement'),
        require('../../src/routes/one-on-one')
    );
    a.use(require('../../src/middleware/errorHandler').errorHandler);
    return a;
}
const json = (r) => r.set('Accept', 'application/json');

async function reset() {
    db.__rows.clear();
    await AppSettingsModel.setValue('t.reset', '1');
    db.__rows.delete('t.reset');
}

const OLD_V2 = process.env.V2_FEATURES;
beforeEach(async () => {
    delete process.env.V2_FEATURES;
    jest.clearAllMocks();
    await reset();
});
afterAll(() => {
    if (OLD_V2 === undefined) delete process.env.V2_FEATURES;
    else process.env.V2_FEATURES = OLD_V2;
});

describe('module guard — off → 404, on → reachable', () => {
    test('/feedback-360 follows the development module', async () => {
        const a = app();
        expect((await json(request(a).get('/feedback-360'))).status).toBe(404);
        expect(f360.home).not.toHaveBeenCalled();
        await ModuleService.save({ stage: '2' }); // development on
        const r = await json(request(a).get('/feedback-360'));
        expect(r.status).toBe(200);
        expect(r.body.view).toBe('pages/feedback360/index');
        await ModuleService.save({ stage: 'custom', toggles: { engagement: true } });
        expect((await json(request(a).get('/feedback-360'))).status).toBe(404);
    });

    test('/one-on-one follows the engagement module', async () => {
        oo.space.mockResolvedValue({ role: 'employee' });
        const a = app();
        expect((await json(request(a).get('/one-on-one/7'))).status).toBe(404);
        await ModuleService.save({ stage: '2' }); // engagement still off at stage 2
        expect((await json(request(a).get('/one-on-one/7'))).status).toBe(404);
        await ModuleService.save({ stage: '3' });
        expect((await json(request(a).get('/one-on-one/7/data.json'))).status).toBe(200);
        expect(oo.space).toHaveBeenCalledTimes(1);
    });
});

describe('refusals keep their status and speak the reader’s language', () => {
    beforeEach(async () => ModuleService.save({ stage: '3' }));

    test('a stranger asking for a report gets a 404', async () => {
        f360.report.mockRejectedValue(refuse(404, 'f360_not_found'));
        const r = await json(request(app()).get('/feedback-360/subjects/12/report.json'));
        expect(r.status).toBe(404);
        expect(r.body.error).toBe(EN.f360_err_not_found);
    });

    test('a subject whose report is not released gets a 403 with the reason', async () => {
        f360.report.mockRejectedValue(refuse(403, 'f360_report_not_released'));
        const r = await json(request(app()).get('/feedback-360/subjects/12/report.json'));
        expect(r.status).toBe(403);
        expect(r.body.error).toBe(EN.f360_err_report_not_released);
    });

    test('someone else’s one-to-one space is a 404; HR writing is a 403', async () => {
        oo.space.mockRejectedValue(refuse(404, 'oo_not_found'));
        expect((await json(request(app()).get('/one-on-one/99/data.json'))).status).toBe(404);
        oo.saveNote.mockRejectedValue(refuse(403, 'oo_forbidden'));
        const r = await request(app())
            .post('/one-on-one/meetings/5/notes')
            .set('Accept', 'application/json')
            .send({ visibility: 'private', body: 'x' });
        expect(r.status).toBe(403);
        expect(r.body.error).toBe(EN.oo_err_forbidden);
    });

    test('a non-numeric id never reaches the service', async () => {
        const r = await json(request(app()).get('/one-on-one/abc'));
        expect(r.status).toBe(404);
        expect(oo.space).not.toHaveBeenCalled();
    });
});

describe('wiring', () => {
    const M = require('../../src/config/modules');
    test('config/modules.js declares the two prefixes in their modules', () => {
        expect(M.MODULE_PREFIXES.development).toContain('/feedback-360');
        expect(M.MODULE_PREFIXES.engagement).toContain('/one-on-one');
        expect(M.MODULE_MENUS.development).toEqual(
            expect.arrayContaining(['talentx:f360_nav', 'talentx:f360_nav_console'])
        );
        expect(M.MODULE_MENUS.engagement).toContain('growth:oo_nav');
    });

    test('routes/index.js mounts both behind their module guard', () => {
        let stack;
        jest.isolateModules(() => {
            jest.spyOn(console, 'error').mockImplementation(() => {});
            stack = require('../../src/routes/index').stack;
            console.error.mockRestore();
        });
        const guarded = (p, mod) =>
            stack.some(
                (l) =>
                    l.match(p) &&
                    l.handle &&
                    l.handle.name === 'moduleGuard' &&
                    Array.isArray(l.handle.modules) &&
                    l.handle.modules.includes(mod)
            );
        expect(guarded('/feedback-360', 'development')).toBe(true);
        expect(guarded('/feedback-360/manage', 'development')).toBe(true);
        expect(guarded('/one-on-one', 'engagement')).toBe(true);
        expect(guarded('/one-on-one/5', 'engagement')).toBe(true);
    });

    test('every refusal code has a catalogue entry in both languages', () => {
        const FR = {
            ...require('../../locales/fr/talentx.json'),
            ...require('../../locales/fr/growth.json'),
        };
        const maps = [
            require('../../src/routes/feedback360').MSG,
            require('../../src/routes/one-on-one').MSG,
        ];
        for (const m of maps)
            for (const key of Object.values(m)) {
                const k = key.split(':')[1];
                expect(`${key}:${Boolean(FR[k])}:${Boolean(EN[k])}`).toBe(`${key}:true:true`);
            }
    });
});
