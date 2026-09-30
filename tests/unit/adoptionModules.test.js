'use strict';
/**
 * Optional modules and adoption stages (Administration → Modules).
 *
 * The talent suite used to be mounted only when V2_FEATURES=1 was set at boot.
 * Each optional module is now a database setting resolved per request by
 * ModuleService, from the adoption stage (1 | 2 | 3 | custom):
 *
 *   - stage presets map to the right modules; a fresh install reads stage 1;
 *   - the legacy V2_FEATURES=1 forces every module on, and an install started
 *     with it is recorded at stage 3 so removing the variable loses nothing;
 *   - the module guard answers the app's normal 404 while a module is off, and
 *     lets the request through once it is switched on — no restart (the
 *     settings TTL cache is busted by AppSettingsModel.setValue);
 *   - core routes never carry a module guard;
 *   - the sidebar hides the menu entries of modules that are off;
 *   - the setup step is optional (the required count is unchanged);
 *   - every change on /admin/modules is audit-logged.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const request = require('supertest');

// An in-memory appSettings table behind the REAL AppSettingsModel, so the
// TTL cache and its busting on setValue are exercised for real.
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
    };
});
const mockLog = { log: jest.fn().mockResolvedValue(undefined) };
jest.mock('../../src/services/LogService', () => mockLog);

const db = require('../../src/config/database');
const AppSettingsModel = require('../../src/models/AppSettingsModel');
const ModuleService = require('../../src/services/ModuleService');
const M = require('../../src/config/modules');

const ROOT = path.resolve(__dirname, '..', '..');
const SIDEBAR = path.join(ROOT, 'views/partials/sidebar.ejs');

async function reset() {
    db.__rows.clear();
    // any write busts the whole settings cache
    await AppSettingsModel.setValue('t.reset', '1');
    db.__rows.delete('t.reset');
    await AppSettingsModel.setValue('t.reset2', '1');
    db.__rows.delete('t.reset2');
}

const OLD_V2 = process.env.V2_FEATURES;
beforeEach(async () => {
    delete process.env.V2_FEATURES;
    mockLog.log.mockClear();
    await reset();
});
afterAll(() => {
    if (OLD_V2 === undefined) delete process.env.V2_FEATURES;
    else process.env.V2_FEATURES = OLD_V2;
});

// ─────────────────────────────────────────────────────────────────────────
describe('stage presets', () => {
    const on = (mods) => M.STAGED_MODULES.filter((k) => mods[k]);

    test('stage 1 — framework & assessment: campaigns only', () => {
        expect(on(ModuleService.presetFor('1'))).toEqual(['campaigns']);
    });
    test('stage 2 — adds development, talent and mobility', () => {
        expect(on(ModuleService.presetFor('2'))).toEqual([
            'campaigns',
            'development',
            'talent',
            'mobility',
        ]);
    });
    test('stage 3 — adds engagement and AI (every staged module)', () => {
        expect(on(ModuleService.presetFor('3'))).toEqual(M.STAGED_MODULES);
    });
    test('a stored stage decides the modules; localContent keeps its own switch', async () => {
        await ModuleService.save({ stage: '2', localContent: 'true' });
        const s = await ModuleService.resolve();
        expect(s.stage).toBe('2');
        expect(s.modules).toMatchObject({
            campaigns: true,
            development: true,
            talent: true,
            mobility: true,
            engagement: false,
            ai: false,
            localContent: true,
        });
        // the historical key is the one written
        expect(await AppSettingsModel.getValue('featureLocalContent', false)).toBe(true);
    });
    test('custom: each switch decides, and the string "false" is OFF', async () => {
        await ModuleService.save({
            stage: 'custom',
            toggles: { campaigns: 'false', development: '1', talent: 'on', ai: 'true' },
        });
        const s = await ModuleService.resolve();
        expect(s.stage).toBe('custom');
        expect(s.modules).toMatchObject({
            campaigns: false,
            development: true,
            talent: true,
            mobility: false,
            engagement: false,
            ai: true,
        });
        expect(db.__rows.get('modules.campaigns')).toMatchObject({
            value: 'false',
            type: 'boolean',
        });
    });
    test('an invalid stage is refused', async () => {
        await expect(ModuleService.save({ stage: '4' })).rejects.toThrow(/invalid stage/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('fresh install and legacy V2_FEATURES=1', () => {
    test('a fresh install (no stage stored, no V2_FEATURES) reads stage 1', async () => {
        const s = await ModuleService.resolve();
        expect(s).toMatchObject({ stage: '1', stored: false, legacy: false });
        expect(M.STAGED_MODULES.filter((k) => s.modules[k])).toEqual(['campaigns']);
        expect(await ModuleService.ensureLegacyStage()).toBe(false);
        expect(db.__rows.has('adoption.stage')).toBe(false);
    });

    test('V2_FEATURES=1 forces every module on, whatever stage is stored', async () => {
        await ModuleService.save({ stage: '1' });
        process.env.V2_FEATURES = '1';
        const s = await ModuleService.resolve();
        expect(s.legacy).toBe(true);
        for (const k of M.STAGED_MODULES) expect(s.modules[k]).toBe(true);
        // what applies once the variable is gone
        expect(s.configured.development).toBe(false);
        expect(ModuleService.isOnSync('ai')).toBe(true);
    });

    test('an install started with V2_FEATURES=1 is recorded at stage 3 — once', async () => {
        process.env.V2_FEATURES = '1';
        expect(await ModuleService.ensureLegacyStage()).toBe(true);
        expect(db.__rows.get('adoption.stage')).toMatchObject({ value: '3' });
        expect(await ModuleService.ensureLegacyStage()).toBe(false);
        // …so removing the variable later takes nothing away
        delete process.env.V2_FEATURES;
        const s = await ModuleService.resolve();
        expect(s.stage).toBe('3');
        for (const k of M.STAGED_MODULES) expect(s.modules[k]).toBe(true);
    });

    test('a stage the admin already chose is never overwritten by the upgrade step', async () => {
        await ModuleService.save({ stage: '2' });
        process.env.V2_FEATURES = '1';
        expect(await ModuleService.ensureLegacyStage()).toBe(false);
        expect(db.__rows.get('adoption.stage')).toMatchObject({ value: '2' });
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('module guard — off → 404, on → reachable, no restart', () => {
    function app() {
        const a = express();
        a.get('/v2/pip', ModuleService.requireModule('development'), (req, res) =>
            res.json({ ok: true })
        );
        a.use('/v2/cap', ModuleService.capGuard(), (req, res) =>
            res.json({ ok: true, path: req.path })
        );
        a.get(
            '/employee/opportunities',
            ModuleService.requireModule('mobility', 'engagement'),
            (req, res) => res.json({ ok: true })
        );
        return a;
    }
    const json = (r) => r.set('Accept', 'application/json');

    test('the normal 404 while off, then 200 on the next request after the switch', async () => {
        const a = app();
        // prime the TTL cache with the stage-1 reads
        let r = await json(request(a).get('/v2/pip'));
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ error: 'Not found' }); // errorHandler.notFoundHandler
        await ModuleService.save({ stage: '2' });
        r = await json(request(a).get('/v2/pip'));
        expect(r.status).toBe(200);
        await ModuleService.save({ stage: '1' });
        r = await json(request(a).get('/v2/pip'));
        expect(r.status).toBe(404);
    });

    test('a guard naming several modules opens with any of them', async () => {
        const a = app();
        expect((await json(request(a).get('/employee/opportunities'))).status).toBe(404);
        await ModuleService.save({ stage: 'custom', toggles: { engagement: true } });
        expect((await json(request(a).get('/employee/opportunities'))).status).toBe(200);
    });

    test('/v2/cap: each sub-path follows its module; GDPR and webhooks are core', async () => {
        const a = app();
        // stage 1: nothing of the hub, but DSR / webhooks / skills answer
        expect((await json(request(a).get('/v2/cap'))).status).toBe(404);
        expect((await json(request(a).get('/v2/cap/survey/1/results'))).status).toBe(404);
        expect((await json(request(a).post('/v2/cap/copilot/ask'))).status).toBe(404);
        expect((await json(request(a).get('/v2/cap/dsr/retention/status'))).status).toBe(200);
        expect((await json(request(a).get('/v2/cap/webhooks'))).status).toBe(200);
        expect((await json(request(a).get('/v2/cap/skills/1/adjacent'))).status).toBe(200);
        await ModuleService.save({ stage: '2' });
        expect((await json(request(a).get('/v2/cap'))).status).toBe(200);
        expect((await json(request(a).get('/v2/cap/calibration/1'))).status).toBe(200);
        expect((await json(request(a).get('/v2/cap/opportunity/1/match'))).status).toBe(200);
        expect((await json(request(a).get('/v2/cap/survey/1/results'))).status).toBe(404);
        expect((await json(request(a).get('/v2/cap/objectives'))).status).toBe(404);
        await ModuleService.save({ stage: '3' });
        expect((await json(request(a).get('/v2/cap/survey/1/results'))).status).toBe(200);
        expect((await json(request(a).post('/v2/cap/copilot/ask'))).status).toBe(200);
    });

    test('V2_FEATURES=1 opens every guard', async () => {
        process.env.V2_FEATURES = '1';
        const a = app();
        expect((await json(request(a).get('/v2/pip'))).status).toBe(200);
        expect((await json(request(a).get('/v2/cap/survey/1/results'))).status).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('core routes are never gated', () => {
    let stack;
    beforeAll(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.isolateModules(() => {
            stack = require('../../src/routes/index').stack;
        });
        console.error.mockRestore();
    });
    const isGuard = (fn) => fn && fn.name === 'moduleGuard' && !fn.capPaths;
    /** Every plain module guard (not the /v2/cap one, tested above) matching `p`. */
    function guardsOn(p) {
        return stack.filter((layer) => {
            if (!layer.match(p)) return false;
            if (isGuard(layer.handle)) return true;
            return Boolean(layer.route && layer.route.stack.some((l) => isGuard(l.handle)));
        });
    }

    test('the V2 routers are mounted without V2_FEATURES (behind their guard)', () => {
        for (const p of [
            '/v2/idp/manage',
            '/v2/pip',
            '/v2/talent/x',
            '/v2/continuity',
            '/v2/lifecycle',
            '/v2/lms',
            '/cycles',
            '/coaching/plans',
        ]) {
            expect(`${p}:${guardsOn(p).length > 0}`).toBe(`${p}:true`);
        }
        const mounted = (p) => stack.some((l) => !isGuard(l.handle) && l.match(p));
        expect(mounted('/v2/uam/mfa/manage')).toBe(true);
        expect(mounted('/v2/slf/disputes')).toBe(true);
    });

    test.each(M.CORE_PREFIXES)('%s carries no module guard', (p) => {
        expect(guardsOn(p)).toEqual([]);
    });

    test('no module owns a core prefix', () => {
        for (const [mod, prefixes] of Object.entries(M.MODULE_PREFIXES)) {
            for (const mp of prefixes) {
                for (const cp of M.CORE_PREFIXES) {
                    expect(`${mod} ${mp} vs ${cp}: ${mp === cp || mp.startsWith(cp + '/')}`).toBe(
                        `${mod} ${mp} vs ${cp}: false`
                    );
                }
            }
        }
    });

    test('the licence core features stay out of every module', () => {
        const EntitlementService = require('../../src/services/EntitlementService');
        expect(EntitlementService.CORE_FEATURES).toEqual(
            expect.arrayContaining(['framework', 'assessment', 'readiness', 'nine_box', 'reports'])
        );
        const all = Object.values(M.MODULE_PREFIXES).flat();
        for (const p of [
            '/talent/nine-box',
            '/employee/my-development',
            '/employee/self-assessment',
        ]) {
            expect(all.some((m) => p === m || p.startsWith(m + '/'))).toBe(false);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the sidebar hides the menus of modules that are off', () => {
    const user = { id: 1, userType: 'admin', role: 'superadmin', username: 'sa' };
    function hrefs(appModules) {
        const html = ejs.render(
            fs.readFileSync(SIDEBAR, 'utf8'),
            {
                user,
                can: () => true,
                wsVisible: () => true,
                appModules,
                sqlConsoleEnabled: false,
                featureLocalContent: !!appModules.localContent,
                currentPath: '/nowhere',
                __: (k) => k,
                cspNonce: 'n',
                csrfToken: 't',
                lang: 'en',
            },
            { filename: SIDEBAR }
        );
        const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
        return new Set([...nav.matchAll(/<a\s+href="([^"]+)"/g)].map((m) => m[1]));
    }
    const mods = (stage, extra = {}) => ({
        ...ModuleService.presetFor(stage),
        localContent: false,
        ...extra,
    });

    test('stage 1: no development / talent / mobility / engagement menus', () => {
        const h = hrefs(mods('1'));
        for (const p of [
            '/v2/idp/manage',
            '/v2/pip',
            '/coaching/plans',
            '/v2/continuity',
            '/exec/key-person',
            '/v2/lifecycle',
            '/v2/lms',
            '/v2/cap',
            '/reports/local-content',
        ]) {
            expect(`${p}:${h.has(p)}`).toBe(`${p}:false`);
        }
        // core and stage-1 entries
        for (const p of [
            '/cycles',
            '/talent/nine-box',
            '/v2/slf/disputes',
            '/admin/modules',
            '/setup',
        ]) {
            expect(`${p}:${h.has(p)}`).toBe(`${p}:true`);
        }
    });

    test('stage 2 shows development, talent and mobility; local content follows its switch', () => {
        const h = hrefs(mods('2', { localContent: true }));
        for (const p of [
            '/v2/idp/manage',
            '/v2/pip',
            '/coaching/plans',
            '/v2/continuity',
            '/v2/lifecycle',
            '/v2/cap',
            '/reports/local-content',
        ]) {
            expect(`${p}:${h.has(p)}`).toBe(`${p}:true`);
        }
    });

    test('custom with campaigns off hides the campaign console', () => {
        const h = hrefs({ ...mods('3'), campaigns: false });
        expect(h.has('/cycles')).toBe(false);
        expect(h.has('/v2/pip')).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('setup step and audit', () => {
    test('« Choose what to switch on » is an OPTIONAL setup step; the required count is unchanged', async () => {
        db.get.mockImplementationOnce(async () => ({
            sites: 1,
            departments: 1,
            services: 1,
            skills: 1,
            roles: 1,
            rolesWithReq: 1,
            employees: 3,
            noReviewer: 0,
            noEmail: 0,
            openCycles: 0,
            assessments: 1,
        }));
        const Setup = require('../../src/controllers/SetupController');
        const { checks, complete } = await Setup.getChecks();
        const step = checks.find((c) => c.key === 'modules');
        expect(step).toMatchObject({ href: '/admin/modules', optional: true, done: false });
        expect(checks.filter((c) => !c.optional).map((c) => c.key)).toEqual([
            'org',
            'skills',
            'roles',
            'employees',
            'reviewers',
            'assessments',
        ]);
        expect(complete).toBe(true);
    });

    test('saving on /admin/modules is audit-logged with the before → after', async () => {
        const Ctl = require('../../src/controllers/ModulesController');
        const flashes = [];
        const req = {
            body: { stage: '2' },
            user: { id: 1, userType: 'admin', role: 'superadmin' },
            ip: '127.0.0.1',
            get: () => 'jest',
            t: (k) => k,
            flash: (type, msg) => flashes.push([type, msg]),
        };
        const res = { redirect: jest.fn() };
        await Ctl.save(req, res);
        expect(res.redirect).toHaveBeenCalledWith('/admin/modules');
        expect(flashes).toEqual([['success', 'admin:mod_saved']]);
        expect(mockLog.log).toHaveBeenCalledTimes(1);
        const entry = mockLog.log.mock.calls[0][0];
        expect(entry).toMatchObject({ adminId: 1, action: 'MODULES_UPDATED' });
        expect(entry.details).toMatch(/\(unset\) → 2/);
        expect(entry.details).toMatch(/switched on: development, talent, mobility/);
    });

    test('an unticked local-content box switches the module OFF (absent from the form)', async () => {
        await ModuleService.save({ stage: '1', localContent: 'true' });
        expect((await ModuleService.resolve()).modules.localContent).toBe(true);
        const Ctl = require('../../src/controllers/ModulesController');
        const req = {
            body: { stage: '1' },
            user: { id: 1, userType: 'admin', role: 'superadmin' },
            ip: '127.0.0.1',
            get: () => 'jest',
            flash: () => {},
        };
        await Ctl.save(req, { redirect: jest.fn() });
        expect((await ModuleService.resolve()).modules.localContent).toBe(false);
        expect(mockLog.log.mock.calls[0][0].details).toMatch(/switched off: localContent/);
    });

    test('the impact preview names the menus that appear and disappear', () => {
        const imp = ModuleService.impact(
            ModuleService.presetFor('1'),
            ModuleService.presetFor('2')
        );
        expect(imp.appear).toEqual(
            expect.arrayContaining(['chrome:nav_pip', 'chrome:nav_continuity'])
        );
        expect(imp.disappear).toEqual([]);
        const back = ModuleService.impact(
            ModuleService.presetFor('3'),
            ModuleService.presetFor('1')
        );
        expect(back.disappear).toEqual(
            expect.arrayContaining(['chrome:nav_my_okr', 'chrome:nav_pip'])
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('i18n', () => {
    const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
    test('every admin:/chrome: key of the Modules screen exists in FR and EN, literally', () => {
        const src = fs.readFileSync(path.join(ROOT, 'views/pages/admin/modules.ejs'), 'utf8');
        expect(src).not.toMatch(/__\(\s*[^'\s]/); // no computed keys
        const keys = [...src.matchAll(/__\('([a-z]+):([A-Za-z0-9_]+)'/g)];
        expect(keys.length).toBeGreaterThan(30);
        for (const [, ns, k] of keys) {
            for (const lng of ['fr', 'en']) {
                expect(`${lng}/${ns}:${k}:${Boolean(read(`locales/${lng}/${ns}.json`)[k])}`).toBe(
                    `${lng}/${ns}:${k}:true`
                );
            }
        }
    });
});
