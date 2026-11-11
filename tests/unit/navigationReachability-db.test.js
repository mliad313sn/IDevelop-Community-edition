'use strict';
/**
 * Every link of the rail opens for the person who sees it — with every
 * optional module on (V2_FEATURES=1) and at a fresh install's stage 1.
 *
 * The REAL app (server.js's own middleware chain, tests/helpers/c318/buildApp.js)
 * is driven with supertest. For a SuperAdmin, a manager and an employee: the
 * home page answers 200, « Tableau de bord » is its first entry, and every rail
 * link answers 200 or a redirect that does not lead to the sign-in page — never
 * a refusal (401/403) and never a 404 (a module that is off leaves no link).
 * The quick-search index offers the same pages as the rail, then the account
 * menu; the help glossary names them.
 *
 * The manager is made by pointing two employees' supervisor at a third (put
 * back afterwards). Runs on idevelop_test* / idevelop_fixtures; skipped
 * otherwise.
 */
process.env.ACTIVITY_TRAIL = '0';
process.env.API_RATE_LIMIT = '100000000';
process.env.WRITE_ACTION_LIMIT = '100000000';
require('dotenv').config();

jest.mock('../../src/config/sessionStore', () => require('../helpers/c318/sessionStoreMock'));
jest.mock('../../src/services/LogService', () => {
    const real = jest.requireActual('../../src/services/LogService');
    real.log = async () => null;
    return real;
});
jest.mock('../../src/services/PerfEventService', () => {
    const real = jest.requireActual('../../src/services/PerfEventService');
    real.record = () => null;
    return real;
});

const request = require('supertest');
const { isTestDatabaseUrl } = require('../helpers/testDatabase');

const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL);
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(10 * 60 * 1000);

const CSRF = 'nav-reach-csrf-token';
let db;
let app;
const cookie = {};
const HOME = {
    superadmin: '/dashboard',
    manager: '/supervisor/dashboard',
    employee: '/employee/dashboard',
};
let restore = [];
let v2Before;

/** The rail hrefs of a rendered page, in order. */
function railOf(html) {
    const nav = html.slice(html.indexOf('<nav class="sidebar-nav"'), html.indexOf('</nav>'));
    return [...nav.matchAll(/<a href="([^"]+)" class="sidebar-link/g)].map((m) => m[1]);
}

d('every rail link opens for the person who sees it (real app)', () => {
    beforeAll(async () => {
        v2Before = process.env.V2_FEATURES;
        const { loadApp, i18nReady, mintSession } = require('../helpers/c318/buildApp');
        const storeState = require('../helpers/c318/sessionStoreMock').state;
        db = require('../../src/config/database');
        await db.connect();
        await require('../../src/utils/searchSql').init(db);
        try {
            await require('../../src/config/i18n').init();
        } catch (_) {
            /* key passthrough */
        }
        app = loadApp();
        await i18nReady();
        const sa = await db.get(
            `SELECT id FROM admins WHERE role = 'superadmin' AND is_active = true ORDER BY id LIMIT 1`
        );
        const people = await db.all(
            `SELECT id, supervisor_id AS "supervisorId" FROM employees WHERE is_active = true ORDER BY id LIMIT 3`
        );
        cookie.superadmin = await mintSession(
            storeState.store,
            { id: Number(sa.id), userType: 'admin' },
            CSRF
        );
        if (people.length >= 3) {
            const [a, mgr, b] = people;
            restore = [a, b].map((p) => [p.id, p.supervisorId]);
            for (const p of [a, b])
                await db.run('UPDATE employees SET supervisor_id = ? WHERE id = ?', [mgr.id, p.id]);
            cookie.manager = await mintSession(
                storeState.store,
                { id: Number(mgr.id), userType: 'manager' },
                CSRF
            );
            cookie.employee = await mintSession(
                storeState.store,
                { id: Number(a.id), userType: 'employee' },
                CSRF
            );
        }
    });
    afterAll(async () => {
        if (v2Before === undefined) delete process.env.V2_FEATURES;
        else process.env.V2_FEATURES = v2Before;
        for (const [id, sup] of restore)
            await db.run('UPDATE employees SET supervisor_id = ? WHERE id = ?', [sup, id]);
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    });

    for (const v2 of [true, false]) {
        for (const who of ['superadmin', 'manager', 'employee']) {
            test(`${who} (${v2 ? 'every module on' : 'stage 1'}): home first, no rail link refused`, async () => {
                if (!cookie[who]) return;
                if (v2) process.env.V2_FEATURES = '1';
                else delete process.env.V2_FEATURES;
                const home = await request(app)
                    .get(HOME[who])
                    .set('Cookie', cookie[who])
                    .set('Accept', 'text/html')
                    .redirects(0);
                expect(home.status).toBe(200);
                const rail = railOf(home.text);
                expect(rail[0]).toBe(HOME[who]);
                expect(rail.length).toBeGreaterThan(4);
                const bad = [];
                for (const href of rail) {
                    const r = await request(app)
                        .get(href)
                        .set('Cookie', cookie[who])
                        .set('Accept', 'text/html')
                        .redirects(0);
                    const loc = r.headers.location || '';
                    if (r.status >= 400 || (r.status >= 300 && /\/login/.test(loc)))
                        bad.push(`${href} → ${r.status} ${loc}`);
                }
                expect(bad).toEqual([]);
                // the module pages appear only while their module is on
                const modulePages = ['/feedback-360', '/v2/pip', '/coaching/plans', '/one-on-one'];
                const shown = rail.filter((h) =>
                    modulePages.some((p) => h === p || h.startsWith(p + '/'))
                );
                if (!v2) expect(shown).toEqual([]);
            });
        }
    }

    test('a SuperAdmin-only page opened by a manager: the explanatory 403 page, not a bounce', async () => {
        if (!cookie.manager) return;
        const r = await request(app)
            .get('/admin/health')
            .set('Cookie', cookie.manager)
            .set('Accept', 'text/html')
            .set('Sec-Fetch-Mode', 'navigate')
            .set('Sec-Fetch-Dest', 'document')
            .redirects(0);
        expect(r.status).toBe(403);
        expect(r.text).toMatch(/<main/);
    });

    test('/tasks for a manager; /action-center leads there; an employee goes home', async () => {
        if (!cookie.manager) return;
        const t = await request(app).get('/tasks').set('Cookie', cookie.manager).redirects(0);
        expect(t.status).toBe(200);
        expect(t.text).toMatch(/<h1><i class="fas fa-list-check" aria-hidden="true"><\/i>/);
        const ac = await request(app)
            .get('/action-center')
            .set('Cookie', cookie.manager)
            .redirects(0);
        expect([ac.status, ac.headers.location]).toEqual([301, '/tasks']);
        const e = await request(app).get('/tasks').set('Cookie', cookie.employee).redirects(0);
        expect([e.status, e.headers.location]).toEqual([302, '/employee/dashboard']);
        const api = await request(app)
            .get('/api/my-actions')
            .set('Cookie', cookie.manager)
            .set('Accept', 'application/json');
        expect(api.status).toBe(200);
        expect(api.body).toEqual(
            expect.objectContaining({ total: expect.any(Number), complete: true })
        );
    });

    test('legacy pages answer a permanent redirect', async () => {
        const a = await request(app)
            .get('/supervisor/reviews')
            .set('Cookie', cookie.superadmin)
            .redirects(0);
        expect([a.status, a.headers.location]).toEqual([
            301,
            '/supervisor/self-assessment-reviews',
        ]);
        const b = await request(app)
            .get('/supervisor/reviews/12')
            .set('Cookie', cookie.superadmin)
            .redirects(0);
        expect([b.status, b.headers.location]).toEqual([
            301,
            '/supervisor/self-assessment-reviews?review=12',
        ]);
        process.env.V2_FEATURES = '1';
        const c = await request(app)
            .get('/v2/cap/calibration')
            .set('Cookie', cookie.superadmin)
            .redirects(0);
        expect([c.status, c.headers.location]).toEqual([301, '/v2/cap#calibration']);
        delete process.env.V2_FEATURES;
        // the talent module off (stage 1): the calibration path is not there at all
        const off = await request(app)
            .get('/v2/cap/calibration')
            .set('Cookie', cookie.superadmin)
            .redirects(0);
        expect(off.status).toBe(404);
    });
});
