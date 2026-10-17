'use strict';
/**
 * POST /api/self-assessment/employee/:employeeId/approve-selected over REAL HTTP:
 * server.js's own middleware chain (tests/helpers/c318/buildApp), the WHOLE
 * suite inside ONE transaction that is rolled back (the server listens inside
 * db._txStore.run, so every request inherits the client; the app's
 * transactions nest as savepoints). Sessions are minted in the MemoryStore
 * double. Invented people (tests/helpers/ladderWorld.js).
 *
 * Pinned: the session CSRF token is REQUIRED on top of the origin guard; 200
 * JSON with each skill's new state; 409 with every refused skill and nothing
 * written; 403 JSON for the person themself and for someone outside the line;
 * a local admin in clearance WITHOUT approve_assessments approves one skill
 * (as today) and is refused several in strict mode (the approve-all guard),
 * accepted in extended mode; with the permission, and as SuperAdmin, several.
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
jest.mock('../../src/services/WebhookService', () => ({
    isEmittable: () => false,
    emit: async () => {},
    minimisePayload: () => ({}),
}));

const { loadApp, mintSession, i18nReady } = require('../helpers/c318/buildApp');
const storeState = require('../helpers/c318/sessionStoreMock').state;
const W = require('../helpers/ladderWorld');

const ENABLED = require('../helpers/testDatabase').isTestDatabaseUrl(
    process.env.DATABASE_URL || ''
);
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(180000);

d('approve-selected over HTTP (rolled back)', () => {
    let db;
    let client;
    let server;
    let base;
    let world;
    const TOKEN = 'sa-approve-selected-' + Date.now();
    const cookies = {};

    const inTx = (fn) => db._txStore.run(client, fn);

    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
        const app = loadApp();
        await i18nReady();
        client = await db.pool.connect();
        await client.query('BEGIN');
        world = await inTx(() => W.build(db));
        // The test seed holds three skills: invented ones for this suite's rounds.
        await inTx(async () => {
            const dom = await db.get('SELECT domain_id FROM skills ORDER BY id LIMIT 1');
            for (let i = 1; i <= 16; i++)
                await db.run('INSERT INTO skills (domain_id, name) VALUES (?, ?)', [
                    dom.domainId,
                    `Bulk approval probe skill ${i} ${TOKEN}`,
                ]);
        });
        server = await inTx(
            () =>
                new Promise((resolve) => {
                    const s = app.listen(0, '127.0.0.1', () => resolve(s));
                })
        );
        base = 'http://127.0.0.1:' + server.address().port;
        const who = {
            manager: { id: world.people.M, userType: 'employee' },
            self: { id: world.people.P, userType: 'employee' },
            stranger: { id: world.people.R, userType: 'employee' },
            local: { id: world.admins.LA_IN, userType: 'admin' },
            localSlug: { id: world.admins.LA_SLUG, userType: 'admin' },
            super: { id: world.admins.SUPER, userType: 'admin' },
        };
        for (const [k, p] of Object.entries(who))
            cookies[k] = await mintSession(storeState.store, p, TOKEN);
    });
    afterAll(async () => {
        try {
            if (server) await new Promise((r) => server.close(r));
        } finally {
            try {
                if (client) {
                    await client.query('ROLLBACK');
                    client.release();
                }
            } finally {
                await db.close();
            }
        }
    });

    async function plant(n) {
        return inTx(async () => {
            const skills = await db.all(
                `SELECT s.id FROM skills s
                  WHERE NOT EXISTS (SELECT 1 FROM self_assessments x
                                     WHERE x.employee_id = ? AND x.skill_id = s.id)
                  ORDER BY s.id LIMIT ?`,
                [world.people.P, n]
            );
            const ids = [];
            for (const s of skills) {
                const r = await db.get(
                    `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at)
                     VALUES (?, ?, 2, 'submitted', 'submitted', now()) RETURNING id`,
                    [world.people.P, Number(s.id)]
                );
                ids.push(Number(r.id));
            }
            return ids;
        });
    }
    const states = (ids) =>
        inTx(() =>
            db.all(
                'SELECT id, workflow_state AS wf FROM self_assessments WHERE id = ANY(?) ORDER BY id',
                [ids]
            )
        );
    async function post(who, items, { token = TOKEN, origin = true } = {}) {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
        };
        if (who) headers.Cookie = cookies[who];
        if (origin) headers.Origin = base;
        if (token) headers['x-csrf-token'] = token;
        const r = await fetch(
            `${base}/api/self-assessment/employee/${world.people.P}/approve-selected`,
            { method: 'POST', headers, body: JSON.stringify({ items }), redirect: 'manual' }
        );
        let body = null;
        try {
            body = await r.json();
        } catch (_) {
            body = null;
        }
        return { status: r.status, body };
    }
    const items = (ids) => ids.map((id) => ({ id }));

    test('CSRF: no token, a wrong token, no Origin — all refused (403), nothing written', async () => {
        const ids = await plant(2);
        expect((await post('manager', items(ids), { token: null })).status).toBe(403);
        expect((await post('manager', items(ids), { token: 'nope' })).status).toBe(403);
        expect((await post('manager', items(ids), { origin: false })).status).toBe(403);
        expect((await states(ids)).map((s) => s.wf)).toEqual(['submitted', 'submitted']);
    });

    test('a manager approves 3 skills in ONE request: 200 JSON with each skill’s new state', async () => {
        const ids = await plant(3);
        const r = await post('manager', items(ids));
        expect(r.status).toBe(200);
        expect(r.body.success).toBe(true);
        expect(r.body.result.count).toBe(3);
        expect(r.body.result.approved.map((a) => a.workflowState)).toEqual([
            'approved',
            'approved',
            'approved',
        ]);
        expect((await states(ids)).every((s) => s.wf === 'approved')).toBe(true);
    });

    test('409: one refused skill — every reason returned, NOTHING approved', async () => {
        const ids = await plant(2);
        const r = await post('manager', [{ id: ids[0] }, { id: ids[1], supervisorLevel: 4 }]);
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('BATCH_REFUSED');
        expect(r.body.refused.map((x) => x.id)).toEqual([ids[1]]);
        expect(typeof r.body.refused[0].reason).toBe('string');
        expect((await states(ids)).map((s) => s.wf)).toEqual(['submitted', 'submitted']);
    });

    test('403 JSON: the person on their own skills (one and several), someone outside the line; never a redirect', async () => {
        const ids = await plant(2);
        for (const [who, list] of [
            ['self', items(ids)],
            ['self', items(ids.slice(0, 1))],
            ['stranger', items(ids)],
            ['stranger', items(ids.slice(0, 1))],
        ]) {
            const r = await post(who, list);
            expect([who, list.length, r.status]).toEqual([who, list.length, 403]);
            expect(r.body).not.toBeNull();
        }
        expect((await states(ids)).map((s) => s.wf)).toEqual(['submitted', 'submitted']);
    });

    test('strict (default): a local admin in clearance without approve_assessments approves one skill, not several', async () => {
        const ids = await plant(3);
        const several = await post('local', items(ids.slice(0, 2)));
        expect(several.status).toBe(403);
        const one = await post('local', items(ids.slice(2)));
        expect(one.status).toBe(200);
        expect((await states(ids)).map((s) => s.wf)).toEqual([
            'submitted',
            'submitted',
            'approved',
        ]);
    });

    test('extended: the same local admin approves several skills, like one', async () => {
        const A = require('../../src/services/AuthorityService');
        const spy = jest.spyOn(A, 'mode').mockResolvedValue('extended');
        try {
            const ids = await plant(2);
            const r = await post('local', items(ids));
            expect(r.status).toBe(200);
            expect(r.body.result.count).toBe(2);
        } finally {
            spy.mockRestore();
        }
    });

    test('with approve_assessments, and as SuperAdmin: several skills', async () => {
        const a = await plant(2);
        expect((await post('localSlug', items(a))).status).toBe(200);
        const b = await plant(2);
        expect((await post('super', items(b))).status).toBe(200);
    });
});
