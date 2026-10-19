'use strict';
/**
 * HR governance over REAL HTTP (4.0.0 port, wave 6): the real app
 * (tests/helpers/c318/buildApp.js), sessions minted into a memory store, the
 * invented people of tests/helpers/dashWorld.js built inside ONE transaction
 * the server runs in and that is always rolled back.
 *
 *   HR-01  the supervisor's level-0 answer is a proposal: a rating below the
 *          contested one is refused; the person (and only the person)
 *          answers it with the CSRF token; their page offers the answer;
 *   HR-03  a proposed PIP is not on its subject's page and its routes answer
 *          « not found »; once activated: their page lists it, they
 *          acknowledge (a reading), write observations, answer a checkpoint
 *          and print THEIR letter — never another person's; the manager
 *          records the checkpoint and prints the letter.
 * Skipped unless DATABASE_URL names a *_test database.
 */
process.env.ACTIVITY_TRAIL = '0';
process.env.API_RATE_LIMIT = '100000000';
process.env.WRITE_ACTION_LIMIT = '100000000';
process.env.LOGIN_RATE_LIMIT = process.env.LOGIN_RATE_LIMIT || '1000';
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
const W = require('../helpers/dashWorld');

const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL);
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(10 * 60 * 1000);

const CSRF = 'hr-gov-csrf';
const TOKEN = `HGtok${Date.now().toString(36)}`;
let db;
let server;
let base;
let world;
let release;
let txDone;
let TXQ;
let disputeId;
const COOKIE = {};

const get = (who, url, lang = 'fr') =>
    request(base)
        .get(url)
        .redirects(0)
        .timeout(120000)
        .set('Cookie', `${COOKIE[who]}; lang=${lang}`)
        .set('Accept', 'text/html,application/xhtml+xml');
// A JSON write from one of our own pages: same Origin and the token. A JSON
// body is guarded by the same-origin check (httpHardening.originGuard) and a
// form body by the synchroniser token: `forged` sends a form without the token,
// `crossSite` a JSON body from another origin.
const post = (who, url, body, { forged = false, crossSite = false } = {}) => {
    let r = request(base)
        .post(url)
        .redirects(0)
        .timeout(120000)
        .set('Cookie', `${COOKIE[who]}; lang=en`)
        .set('Accept', 'application/json');
    if (forged) return r.type('form').send(body || {});
    r = r.set('Origin', crossSite ? 'https://elsewhere.example' : base).type('json');
    if (!crossSite) r = r.set('x-csrf-token', CSRF);
    return r.send(body || {});
};
// Every module on (the PIP side lives in the development module); jest
// restores the spies before each test, so it is set again each time.
function allModulesOn() {
    const M = require('../../src/config/modules');
    const modules = {};
    for (const k of M.MODULE_KEYS) modules[k] = true;
    jest.spyOn(require('../../src/services/ModuleService'), 'resolve').mockImplementation(
        async () => ({ stage: 'custom', stored: true, legacy: false, modules, configured: modules })
    );
}
const q = (sql, params = []) => TXQ.query(sql, params);

d('HR governance over real HTTP (invented people, rolled back)', () => {
    beforeAll(async () => {
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
        allModulesOn();
        const app = loadApp();
        await i18nReady();
        let started;
        let failed;
        const ready = new Promise((r, j) => {
            started = r;
            failed = j;
        });
        const ROLLBACK = new Error('__HR_GOV_ROLLBACK__');
        txDone = db
            .runTransaction(async () => {
                TXQ = db._txStore.getStore();
                world = await W.world(db);
                const person = world.people.N[5];
                // M is the person's direct manager (the PIP authority) and the
                // supervisor who rated them (the dispute's level 0).
                await db.run(
                    "UPDATE employees SET manager_id = ?, manager_type = 'employee' WHERE id = ?",
                    [world.M, person]
                );
                const round = await db.get(
                    `INSERT INTO self_assessment_rounds (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at)
                     VALUES (?, ?, 3, 'submitted', 'submitted', now() - interval '12 days') RETURNING id`,
                    [person, world.S1]
                );
                const review = await db.get(
                    `INSERT INTO supervisor_reviews (self_assessment_id, employee_id, skill_id, supervisor_rated_level,
                                                     gap, reviewed_by, reviewed_at, status)
                     VALUES (?, ?, ?, 1, -2, ?, now() - interval '11 days', 'disputed') RETURNING id`,
                    [Number(round.id), person, world.S1, world.M]
                );
                const dsp = await db.get(
                    `INSERT INTO assessment_disputes (supervisor_review_id, employee_id, reason)
                     VALUES (?, ?, ?) RETURNING id`,
                    [Number(review.id), person, `${TOKEN} my reason`]
                );
                disputeId = Number(dsp.id);
                await new Promise((r) => {
                    server = app.listen(0, '127.0.0.1', r);
                });
                started();
                await new Promise((r) => {
                    release = r;
                });
                throw ROLLBACK;
            })
            .catch((e) => {
                if (e !== ROLLBACK) failed(e);
            });
        await ready;
        base = `http://127.0.0.1:${server.address().port}`;
        const P = {
            person: { id: world.people.N[5], userType: 'employee' },
            other: { id: world.people.N[6], userType: 'employee' },
            manager: { id: world.M, userType: 'manager' },
        };
        for (const [k, p] of Object.entries(P))
            COOKIE[k] = await mintSession(storeState.store, p, CSRF);
    });

    beforeEach(() => allModulesOn());

    afterAll(async () => {
        if (server) await new Promise((r) => server.close(r));
        if (release) release();
        if (txDone) await txDone;
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    });

    test('HR-01: the level-0 answer is a proposal only the person answers', async () => {
        const url = `/v2/slf/disputes/${disputeId}`;
        const lower = await post('manager', `${url}/resolve-l0`, {
            decidedRating: 0,
            reason: 'Lower',
        });
        expect(lower.status).toBe(400);
        expect(lower.body.code).toBe('DISPUTE_L0_LOWER');
        const ok = await post('manager', `${url}/resolve-l0`, {
            decidedRating: 2,
            reason: `${TOKEN} proposer note`,
        });
        expect([ok.status, ok.body]).toEqual([200, { ok: true, proposed: true }]);
        const again = await post('manager', `${url}/resolve-l0`, {
            decidedRating: 3,
            reason: 'Again',
        });
        expect([again.status, again.body.code]).toEqual([409, 'DISPUTE_ALREADY_PROPOSED']);
        // the manager's queue says a proposal waits; no button any more
        const queue = await get('manager', '/v2/slf/disputes');
        expect(queue.status).toBe(200);
        expect(queue.text).toContain(`data-dsp-proposal="${disputeId}"`);
        // the person's page offers the answer
        const page = await get('person', '/employee/supervisor-reviews');
        expect(page.status).toBe(200);
        expect(page.text).toContain(`data-sr-proposal="${disputeId}"`);
        expect(page.text).toContain(`${TOKEN} proposer note`);
        // the manager cannot answer it (an employee route), nor can a stranger
        const byManager = await post('manager', `${url}/respond`, { response: 'accept' });
        expect(byManager.status).toBe(403);
        const byOther = await post('other', `${url}/respond`, { response: 'accept' });
        expect([byOther.status, byOther.body.code]).toEqual([403, 'DISPUTE_NOT_OWNER']);
        const bad = await post('person', `${url}/respond`, { response: 'maybe' });
        expect([bad.status, bad.body.code]).toEqual([400, 'DISPUTE_RESPONSE_INVALID']);
        const malformed = await post('person', '/v2/slf/disputes/abc/respond', {
            response: 'accept',
        });
        expect(malformed.status).toBe(404);
        // a form without the token, a JSON body from another site: refused
        const noTok = await post(
            'person',
            `${url}/respond`,
            { response: 'accept' },
            { forged: true }
        );
        expect(noTok.status).toBe(403);
        const cross = await post(
            'person',
            `${url}/respond`,
            { response: 'accept' },
            { crossSite: true }
        );
        expect(cross.status).toBe(403);
        const before = (await q('SELECT state FROM assessment_disputes WHERE id = $1', [disputeId]))
            .rows[0];
        expect(before.state).toBe('open');
        const yes = await post('person', `${url}/respond`, { response: 'accept' });
        expect([yes.status, yes.body]).toEqual([
            200,
            { ok: true, resolved: true, escalated: false },
        ]);
        const row = (
            await q(
                'SELECT state, decided_rating, employee_response FROM assessment_disputes WHERE id = $1',
                [disputeId]
            )
        ).rows[0];
        expect(row).toEqual({
            state: 'resolved',
            decided_rating: 2,
            employee_response: 'accepted',
        });
        const twice = await post('person', `${url}/respond`, { response: 'refuse' });
        expect([twice.status, twice.body.code]).toEqual([409, 'DISPUTE_NO_PROPOSAL']);
    });

    test('HR-03: a proposed PIP is hidden from its subject; once active, their own side works', async () => {
        const person = world.people.N[5];
        const prop = await post('manager', '/v2/pip/propose', {
            employeeId: person,
            summary: `${TOKEN} plan summary`,
            objectives: 'Close the backlog',
        });
        expect(prop.status).toBe(200);
        const id = Number(prop.body.id);
        // hidden while proposed
        const dev = await get('person', '/employee/my-development');
        expect(dev.status).toBe(200);
        expect(dev.text).not.toContain(`${TOKEN} plan summary`);
        expect((await post('person', `/employee/pip/${id}/acknowledge`)).status).toBe(404);
        expect((await get('person', `/employee/pip/${id}/letter`)).status).toBe(404);
        // the manager activates it
        const act = await post('manager', `/v2/pip/${id}/activate`);
        expect(act.status).toBe(200);
        const dev2 = await get('person', '/employee/my-development');
        expect(dev2.text).toContain(`${TOKEN} plan summary`);
        expect(dev2.text).toContain(`href="/employee/pip/${id}/letter"`);
        expect(dev2.text).toMatch(/data-pip-ack="0"/);
        // a reading, with the token; never another person's plan
        expect(
            (await post('person', `/employee/pip/${id}/acknowledge`, {}, { forged: true })).status
        ).toBe(403);
        expect((await post('other', `/employee/pip/${id}/acknowledge`)).status).toBe(404);
        const ack = await post('person', `/employee/pip/${id}/acknowledge`);
        expect(ack.body).toEqual({ ok: true, acknowledged: true });
        const obs = await post('person', `/employee/pip/${id}/comment`, {
            comment: `${TOKEN} my observations`,
        });
        expect(obs.status).toBe(200);
        expect((await post('other', `/employee/pip/${id}/comment`, { comment: 'x' })).status).toBe(
            404
        );
        // the manager records a checkpoint; the person answers it
        const cp = await post('manager', `/v2/pip/${id}/checkpoint`, {
            note: `${TOKEN} checkpoint note`,
        });
        expect(cp.status).toBe(200);
        const rid = Number(cp.body.id);
        expect(
            (await post('person', `/v2/pip/${id}/checkpoint`, { note: 'Self-recorded' })).status
        ).toBe(403);
        expect(
            (await post('other', `/employee/pip/checkpoints/${rid}/respond`, { response: 'x' }))
                .status
        ).toBe(404);
        const resp = await post('person', `/employee/pip/checkpoints/${rid}/respond`, {
            response: `${TOKEN} my answer`,
        });
        expect(resp.status).toBe(200);
        // the person's letter, and only theirs
        const letter = await get('person', `/employee/pip/${id}/letter`);
        expect(letter.status).toBe(200);
        expect(letter.headers['cache-control']).toMatch(/no-store/);
        for (const t of ['plan summary', 'my observations', 'checkpoint note', 'my answer'])
            expect(letter.text).toContain(`${TOKEN} ${t}`);
        expect(letter.text).toContain(`data-pip-letter="${id}"`);
        expect(letter.text).not.toMatch(/\son[a-z]+="/i);
        expect((await get('other', `/employee/pip/${id}/letter`)).status).toBe(404);
        // the manager's letter; the person cannot open the manager's route
        const mgrLetter = await get('manager', `/v2/pip/${id}/letter`);
        expect(mgrLetter.status).toBe(200);
        expect(mgrLetter.text).toContain(`${TOKEN} my answer`);
        // (the PIP console is closed to employees: sent away before the route)
        const theirs = await get('person', `/v2/pip/${id}/letter`);
        expect([302, 403]).toContain(theirs.status);
        expect(theirs.text || '').not.toContain(TOKEN);
        const ev = (
            await q(
                `SELECT acknowledged_at IS NOT NULL AS ack, employee_comment, activated_by_ref
                   FROM pips WHERE id = $1`,
                [id]
            )
        ).rows[0];
        expect(ev).toEqual({
            ack: true,
            employee_comment: `${TOKEN} my observations`,
            activated_by_ref: `employee:${world.M}`,
        });
    });
});
