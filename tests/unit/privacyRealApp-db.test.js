'use strict';
/**
 * Privacy and erasure surfaces through the REAL app (server.js routes, the
 * notice gate, CSRF, views), inside one rolled-back transaction:
 *   - a SuperAdmin publishes a notice from the register page;
 *   - an employee is then held on /privacy/notice, acknowledges, and goes on;
 *   - "What is recorded about me" offers the download and the objection; the
 *     download is a JSON attachment; the objection is recorded and the page
 *     then offers to withdraw it;
 *   - the maintenance page carries the override panel and its list answers.
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

const request = require('supertest');

const ENABLED = /idevelop_test|idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(120000);

const CSRF = 'privacy-fixed-csrf-token';
const ROLLBACK = Symbol('privacy-rollback');

let db;
let app;
let superCookie;
let empCookie;

d('privacy through the real app (rolled back)', () => {
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
        const emp = await db.get(
            `SELECT id FROM employees WHERE is_active = true AND is_account_active = true ORDER BY id LIMIT 1`
        );
        empCookie = await mintSession(
            storeState.store,
            { id: Number(emp.id), userType: 'employee' },
            CSRF
        );
    });
    afterAll(async () => {
        require('../../src/services/PrivacyService').clearCache();
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    });

    async function inRollback(fn) {
        try {
            await db.runTransaction(async () => {
                await fn();
                await new Promise((r) => setTimeout(r, 15));
                throw ROLLBACK;
            });
        } catch (e) {
            if (e !== ROLLBACK) throw e;
        } finally {
            require('../../src/services/PrivacyService').clearCache();
        }
    }

    test('publish, held, acknowledge, download, object', async () => {
        await inRollback(async () => {
            const reg = await request(app).get('/compliance/register').set('Cookie', superCookie);
            expect(reg.status).toBe(200);
            expect(reg.text).toContain('action="/compliance/register/privacy-notice"');

            const pub = await request(app)
                .post('/compliance/register/privacy-notice')
                .set('Cookie', superCookie)
                .type('form')
                .send({
                    _csrf: CSRF,
                    titleFr: 'Notice',
                    titleEn: 'Notice',
                    bodyFr: '## Responsable\nSociété exemple',
                    bodyEn: '## Controller\nExample company',
                })
                .redirects(0);
            expect(pub.status).toBe(303);

            const held = await request(app)
                .get('/employee/my-data')
                .set('Cookie', empCookie)
                .redirects(0);
            expect(held.status).toBe(302);
            expect(held.headers.location).toBe('/privacy/notice');

            const notice = await request(app).get('/privacy/notice').set('Cookie', empCookie);
            expect(notice.status).toBe(200);
            const version = /name="version" value="(\d+)"/.exec(notice.text)[1];
            const ack = await request(app)
                .post('/privacy/notice/acknowledge')
                .set('Cookie', empCookie)
                .type('form')
                .send({ _csrf: CSRF, version })
                .redirects(0);
            expect(ack.status).toBe(303);
            expect(ack.headers.location).toBe('/employee/my-data');

            const page = await request(app).get('/employee/my-data').set('Cookie', empCookie);
            expect(page.status).toBe(200);
            expect(page.text).toContain('href="/employee/my-data/download"');
            expect(page.text).toContain('action="/employee/my-data/objection"');

            const dl = await request(app)
                .get('/employee/my-data/download')
                .set('Cookie', empCookie);
            expect(dl.status).toBe(200);
            expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="my-data-/);
            const body = JSON.parse(dl.text);
            expect(body.withheld).toEqual(expect.arrayContaining(['nineBox', 'retentionRisk']));

            const obj = await request(app)
                .post('/employee/my-data/objection')
                .set('Cookie', empCookie)
                .type('form')
                .send({ _csrf: CSRF, reason: 'no profiling please' })
                .redirects(0);
            expect(obj.status).toBe(303);
            const after = await request(app).get('/employee/my-data').set('Cookie', empCookie);
            expect(after.text).toContain('action="/employee/my-data/objection/withdraw"');

            // the SuperAdmin acknowledges too, then sees the objection in the register
            const sNotice = await request(app).get('/privacy/notice').set('Cookie', superCookie);
            await request(app)
                .post('/privacy/notice/acknowledge')
                .set('Cookie', superCookie)
                .type('form')
                .send({
                    _csrf: CSRF,
                    version: /name="version" value="(\d+)"/.exec(sNotice.text)[1],
                });
            const reg2 = await request(app).get('/compliance/register').set('Cookie', superCookie);
            expect(reg2.text).toContain('no profiling please');
            expect(reg2.text).toMatch(/action="\/compliance\/privacy\/objections\/\d+\/review"/);

            // an employee cannot publish
            const forbidden = await request(app)
                .post('/compliance/register/privacy-notice')
                .set('Cookie', empCookie)
                .set('Accept', 'application/json')
                .type('form')
                .send({ _csrf: CSRF, titleFr: 'x', titleEn: 'x', bodyFr: 'x', bodyEn: 'x' })
                .redirects(0);
            expect(forbidden.status).toBeGreaterThanOrEqual(300);
            expect(forbidden.status).not.toBe(200);
        });
    });

    test('the maintenance page carries the override panel; the list answers', async () => {
        await inRollback(async () => {
            const page = await request(app).get('/admin/maintenance').set('Cookie', superCookie);
            expect(page.status).toBe(200);
            expect(page.text).toContain('id="mntEraseOverride"');
            expect(page.text).toContain('src="/js/erase-override.js"');
            const list = await request(app)
                .get('/admin/maintenance/dsr-erase-overrides')
                .set('Cookie', superCookie)
                .set('Accept', 'application/json');
            expect(list.status).toBe(200);
            expect(list.body).toMatchObject({ ok: true, rows: [] });
        });
    });
});
