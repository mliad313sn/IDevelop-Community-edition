'use strict';
/**
 * HRIS admin screen through the REAL app (server.js's own middleware chain,
 * tests/helpers/c318/buildApp.js): a SuperAdmin session opens the page,
 * uploads a CSV with the CSRF header, reads the plan, applies it; a local
 * admin is refused. Everything runs inside ONE transaction that also applies
 * migration 160 and is always rolled back.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
process.env.ACTIVITY_TRAIL = '0';
process.env.API_RATE_LIMIT = '100000000';
process.env.WRITE_ACTION_LIMIT = '100000000';
require('dotenv').config();

jest.mock('../../src/config/sessionStore', () => require('../helpers/c318/sessionStoreMock'));
jest.mock('../../src/services/PerfEventService', () => {
    const real = jest.requireActual('../../src/services/PerfEventService');
    real.record = () => null;
    return real;
});

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const ENABLED = /idevelop_test|idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(120000);

const CSRF = 'hris-fixed-csrf-token';
const ROLLBACK = Symbol('hris-rollback');
const MIG = fs.readFileSync(path.join(__dirname, '../../db/postgres/160_hris_sync.sql'), 'utf8');

let db;
let app;
let superCookie;
let localCookie;

d('HRIS admin screen through the real app (rolled back)', () => {
    beforeAll(async () => {
        const { loadApp, mintSession } = require('../helpers/c318/buildApp');
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
        await new Promise((r) => setTimeout(r, 300));
        const sa = await db.get(
            `SELECT id FROM admins WHERE role = 'superadmin' AND is_active = true ORDER BY id LIMIT 1`
        );
        superCookie = await mintSession(
            storeState.store,
            { id: Number(sa.id), userType: 'admin' },
            CSRF
        );
        const la = await db.get(
            `SELECT id FROM admins WHERE role = 'localadmin' AND is_active = true ORDER BY id LIMIT 1`
        );
        localCookie = la
            ? await mintSession(storeState.store, { id: Number(la.id), userType: 'admin' }, CSRF)
            : null;
    });
    afterAll(async () => {
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    });

    async function inRollback(fn) {
        try {
            await db.runTransaction(async () => {
                await db._txStore.getStore().query(MIG);
                await fn();
                await new Promise((r) => setTimeout(r, 15));
                throw ROLLBACK;
            });
        } catch (e) {
            if (e !== ROLLBACK) throw e;
        }
    }

    test('page → upload → plan → apply, as a SuperAdmin', async () => {
        await inRollback(async () => {
            const site = await db.get(
                `INSERT INTO sites (name, code) VALUES ('Hris App Site', 'HRISAPP') RETURNING id`
            );
            const dept = await db.get(
                `INSERT INTO departments (site_id, name) VALUES (?, 'Hris App Dept') RETURNING id`,
                [site.id]
            );
            await db.run(`INSERT INTO services (department_id, name) VALUES (?, 'Hris App Svc')`, [
                dept.id,
            ]);
            await db.run(`INSERT INTO roles (name) VALUES ('Hris App Role')`);

            const page = await request(app)
                .get('/admin/integrations/hris')
                .set('Cookie', superCookie)
                .redirects(0);
            expect(page.status).toBe(200);
            expect(page.text).toContain('id="hris-upload"');
            expect(page.text).toContain('action="/admin/integrations/hris/connector"');

            const csv = [
                'external_id,first_name,last_name,email,job_title,department',
                'APP-1,Zoe,Upload,zoe.upload@hris.test,Hris App Role,Hris App Dept',
                'APP-2,Yan,Blocked,yan@hris.test,Astronaut,Hris App Dept',
            ].join('\n');
            const up = await request(app)
                .post('/admin/integrations/hris/upload')
                .set('Cookie', superCookie)
                .set('x-csrf-token', CSRF)
                .set('Accept', 'application/json')
                .attach('file', Buffer.from(csv), 'export.csv');
            expect(up.status).toBe(200);
            expect(up.body).toMatchObject({ ok: true, status: 'planned' });

            const planPage = await request(app).get(up.body.redirect).set('Cookie', superCookie);
            expect(planPage.status).toBe(200);
            expect(planPage.text).toContain('Zoe Upload');
            expect(planPage.text).toContain('Astronaut'); // reported unmapped, never invented

            const apply = await request(app)
                .post(`/admin/integrations/hris/runs/${up.body.runId}/apply`)
                .set('Cookie', superCookie)
                .type('form')
                .send({ _csrf: CSRF })
                .redirects(0);
            expect(apply.status).toBe(302);
            const zoe = await db.get(
                `SELECT id, is_active FROM employees WHERE email = 'zoe.upload@hris.test'`
            );
            expect(zoe).toBeTruthy();
            expect(
                await db.get(`SELECT id FROM employees WHERE email = 'yan@hris.test'`)
            ).toBeFalsy();

            // A CSRF-less upload never reaches the service.
            const noCsrf = await request(app)
                .post('/admin/integrations/hris/upload')
                .set('Cookie', superCookie)
                .attach('file', Buffer.from(csv), 'export.csv');
            expect(noCsrf.status).toBe(403);

            if (localCookie) {
                const refused = await request(app)
                    .get('/admin/integrations/hris')
                    .set('Cookie', localCookie)
                    .redirects(0);
                expect([302, 403]).toContain(refused.status);
                if (refused.status === 302) expect(refused.headers.location).not.toMatch(/hris/);
            }
        });
    });
});
