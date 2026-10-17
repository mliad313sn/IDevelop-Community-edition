'use strict';
/**
 * The employee's pages over REAL HTTP (4.0.0 port, wave 5): the real app
 * (tests/helpers/c318/buildApp.js), sessions minted into a memory store, the
 * invented people of tests/helpers/dashWorld.js built inside ONE transaction
 * the server runs in and that is always rolled back.
 *
 *   - the home never says « 0 skills met » for a person nobody assessed: one
 *     sentence says nothing is assessed yet, and the next step is named;
 *   - the self-assessment page: five 0-4 buttons per skill (the select kept),
 *     a real label per select, « — » for a level nobody validated, the sync
 *     labels in the page language;
 *   - the end-of-campaign record: listed, read, acknowledged (CSRF), commented;
 *     another person's answers 404; a POST without the token is refused;
 *   - a LOCKED campaign: the next step never sends the person to rate, and the
 *     self-assessment page is read-only (no save, no submit, every control
 *     disabled, the sync status quiet);
 *   - « My progress » and « My development » render for the person.
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

const CSRF = 'emp-pages-csrf';
const TOKEN = `EPtok${Date.now().toString(36)}`;
let db;
let server;
let base;
let world;
let release;
let txDone;
let TXQ;
let lockedCycleId;
const COOKIE = {};

const get = (who, url, lang = 'fr') =>
    request(base)
        .get(url)
        .redirects(0)
        .timeout(120000)
        .set('Cookie', `${COOKIE[who]}; lang=${lang}`)
        .set('Accept', 'text/html,application/xhtml+xml');
const post = (who, url, body, { csrf = true } = {}) => {
    let r = request(base)
        .post(url)
        .redirects(0)
        .timeout(120000)
        .set('Cookie', `${COOKIE[who]}; lang=fr`)
        .type('form');
    if (csrf) r = r.set('x-csrf-token', CSRF);
    return r.send(body);
};
const visible = (html) =>
    String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&rsquo;|&#39;/g, '’')
        .replace(/\s+/g, ' ');
const q = (sql, params = []) => TXQ.query(sql, params);

/** A locked campaign in which `person` had three rounds (one adjusted with a reason). */
async function lockedCampaign(w, person) {
    const c = await db.get(
        `INSERT INTO assessment_cycles (code, label, opened_at, closes_at, status, created_by)
         VALUES (?, ?, now() - interval '60 days', now() - interval '5 days', 'locked', ?) RETURNING id`,
        [`EP-${TOKEN}`, `Campaign ${TOKEN}`, w.adminId]
    );
    const cycleId = Number(c.id);
    const round = async (skillId, self, state) => {
        const st = { approved: 'approved', submitted: 'submitted' }[state];
        const r = await db.get(
            `INSERT INTO self_assessment_rounds (employee_id, skill_id, self_rated_level, status, workflow_state,
                                                 cycle_id, submitted_at, approved_at, approved_by_ref)
             VALUES (?, ?, ?, ?::self_assessment_state, ?, ?, now() - interval '20 days',
                     CASE WHEN ? = 'approved' THEN now() - interval '10 days' END,
                     CASE WHEN ? = 'approved' THEN 'admin:1' END)
             RETURNING id`,
            [person, skillId, self, st, state, cycleId, state, state]
        );
        return Number(r.id);
    };
    const r1 = await round(w.S1, 3, 'approved');
    await db.run(
        `INSERT INTO supervisor_reviews (self_assessment_id, employee_id, skill_id, supervisor_rated_level,
                                         gap, gap_reason, reviewed_by, reviewed_at, status)
         VALUES (?, ?, ?, 1, 2, ?, ?, now() - interval '11 days', 'completed')`,
        [r1, person, w.S1, `${TOKEN} reason`, w.M]
    );
    await round(w.S2, 2, 'approved');
    await round(w.S3, 2, 'submitted');
    return cycleId;
}

d('the employee pages over real HTTP (invented people, rolled back)', () => {
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
        const app = loadApp();
        await i18nReady();
        let started;
        let failed;
        const ready = new Promise((r, j) => {
            started = r;
            failed = j;
        });
        const ROLLBACK = new Error('__EMP_PAGES_ROLLBACK__');
        txDone = db
            .runTransaction(async () => {
                TXQ = db._txStore.getStore();
                world = await W.world(db);
                lockedCycleId = await lockedCampaign(world, world.people.N[5]);
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
            fresh: { id: world.employeeAccount, userType: 'employee' }, // N[8], never assessed
            rated: { id: world.people.N[5], userType: 'employee' }, // had the locked campaign
            other: { id: world.people.N[6], userType: 'employee' },
        };
        for (const [k, p] of Object.entries(P))
            COOKIE[k] = await mintSession(storeState.store, p, CSRF);
    });

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

    test('the home of a person nobody assessed: one honest sentence and a named step', async () => {
        const res = await get('fresh', '/employee/dashboard');
        expect(res.status).toBe(200);
        expect(res.text).toMatch(/data-st="none_assessed"/);
        expect(visible(res.text)).toContain(
            'Aucune de vos 3 compétences requises n’est encore évaluée.'
        );
        expect(visible(res.text)).not.toMatch(/\b0\/3\b/);
        expect(res.text).not.toContain('&lt;span class=');
        expect(res.text).toMatch(/data-next="sa_start"/);
        expect(res.text).toMatch(/id="empRule"/);
        const en = await get('fresh', '/employee/dashboard', 'en');
        expect(visible(en.text)).toContain('None of your 3 required skills is assessed yet.');
    });

    test('the self-assessment page: five buttons per skill, a label per select, « — » for no level', async () => {
        const res = await get('fresh', '/employee/self-assessment');
        expect(res.status).toBe(200);
        const h = res.text;
        const rows = (h.match(/<tr data-skill-id=/g) || []).length;
        expect(rows).toBe(3);
        expect((h.match(/class="sa-seg" role="radiogroup"/g) || []).length).toBe(rows);
        expect((h.match(/class="sa-seg-b" role="radio"/g) || []).length).toBe(rows * 5);
        expect((h.match(/class="self-rating-select/g) || []).length).toBe(rows);
        expect((h.match(/<label class="sr-only" for="sa-rate-\d+"/g) || []).length).toBe(rows);
        expect(h).not.toMatch(/<td class="sa-col-current"[^>]*>0<\/td>/);
        expect(h).toMatch(/<td class="sa-col-current"[^>]*>—<\/td>/);
        expect(h).toMatch(/id="submitBtn"/);
        expect(h).not.toMatch(/data-readonly=1/);
        expect(h).toMatch(/id="syncI18n">\{"locked":false/);
        expect(h).toMatch(/"synced":"✓ Enregistré"/);
        const en = await get('fresh', '/employee/self-assessment', 'en');
        expect(en.text).toMatch(/"synced":"✓ Saved"/);
        // 3 skills: 15 to 20 s each → 1 min (a single figure when the range collapses)
        expect(h).toMatch(/id="saEstimate" data-min="1">1</);
    });

    test('the end-of-campaign record: list, read, acknowledge, comment; never another person’s', async () => {
        const list = await get('rated', '/employee/review-record');
        expect(list.status).toBe(200);
        expect(list.text).toContain(`href="/employee/review-record/${lockedCycleId}"`);
        const page = await get('rated', `/employee/review-record/${lockedCycleId}`);
        expect(page.status).toBe(200);
        expect(page.text).toMatch(/data-rr-ack="0"/);
        expect(visible(page.text)).toContain(`${TOKEN} reason`); // read live
        expect(page.text).toContain(`/employee/review-record/${lockedCycleId}/acknowledge`);
        // another person, the same campaign: not found
        expect((await get('other', `/employee/review-record/${lockedCycleId}`)).status).toBe(404);
        expect((await get('other', '/employee/review-record')).text).not.toContain(
            `/employee/review-record/${lockedCycleId}"`
        );
        // without the token: refused, nothing written
        const noTok = await post(
            'rated',
            `/employee/review-record/${lockedCycleId}/acknowledge`,
            {},
            { csrf: false }
        );
        expect(noTok.status).toBe(403);
        expect(
            (
                await q('SELECT COUNT(*)::int AS n FROM review_records WHERE cycle_id = $1', [
                    lockedCycleId,
                ])
            ).rows[0].n
        ).toBe(0);
        // another person cannot acknowledge it either
        const otherAck = await post(
            'other',
            `/employee/review-record/${lockedCycleId}/acknowledge`,
            {}
        );
        expect(otherAck.status).toBe(302);
        expect(otherAck.headers.location).toBe('/employee/review-record');
        const ack = await post('rated', `/employee/review-record/${lockedCycleId}/acknowledge`, {
            comment: 'My first words',
        });
        expect(ack.status).toBe(302);
        expect(ack.headers.location).toBe(`/employee/review-record/${lockedCycleId}`);
        const rec = (
            await q(
                'SELECT employee_id, employee_comment, snapshot::text AS s FROM review_records WHERE cycle_id = $1',
                [lockedCycleId]
            )
        ).rows;
        expect(rec).toHaveLength(1);
        expect(Number(rec[0].employee_id)).toBe(world.people.N[5]);
        expect(rec[0].employee_comment).toBe('My first words');
        expect(rec[0].s).not.toContain(TOKEN);
        const com = await post('rated', `/employee/review-record/${lockedCycleId}/comment`, {
            comment: 'Changed words',
        });
        expect(com.status).toBe(302);
        const after = await get('rated', `/employee/review-record/${lockedCycleId}`);
        expect(after.text).toMatch(/data-rr-ack="1"/);
        expect(visible(after.text)).toContain('Changed words');
        expect(visible(after.text)).toContain('ce n’est pas un accord');
    });

    test('a LOCKED campaign: never sent to rate, the page is read-only', async () => {
        // enrol the never-assessed person in the locked campaign, with a draft
        await q(
            `INSERT INTO cycle_participants (cycle_id, employee_id, role_id, expected_skills)
             VALUES ($1, $2, $3, 3)`,
            [lockedCycleId, world.employeeAccount, world.R]
        );
        await q(
            `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state)
             VALUES ($1, $2, 2, 'draft', 'draft')`,
            [world.employeeAccount, world.S2]
        );
        const home = await get('fresh', '/employee/dashboard');
        expect(home.text).toMatch(/data-next="sa_locked"/);
        expect(home.text).toMatch(/data-sa-locked="1"/);
        expect(home.text).not.toMatch(/data-next="sa_(continue|start|fix)"/);
        const res = await get('fresh', '/employee/self-assessment');
        const h = res.text;
        expect(h).toMatch(/<form id="selfAssessmentForm" data-readonly=1>/);
        expect(h).not.toMatch(/id="submitBtn"/);
        expect(h).not.toMatch(/id="saveDraftBtn"/);
        expect(h).not.toMatch(/id="saAutosave"/);
        const selects = h.match(/<select name="assessments\[/g) || [];
        const disabled = h.match(/<select name="assessments\[[^>]*?\sdisabled\s/g) || [];
        expect(selects.length).toBe(3);
        expect(disabled.length).toBe(selects.length);
        expect(h).toMatch(/data-sa-readonly="1"/);
        expect(h).toMatch(/id="syncI18n">\{"locked":true/);
        // the five buttons are disabled too
        expect((h.match(/class="sa-seg-b" role="radio"[^>]*disabled/g) || []).length).toBe(15);
    });

    test('« My progress » and « My development » render for the person', async () => {
        const prog = await get('rated', '/employee/my-progress');
        expect(prog.status).toBe(200);
        expect(prog.text).toMatch(/id="progRule"/);
        const dev = await get('rated', '/employee/my-development');
        expect(dev.status).toBe(200);
        const hist = dev.text.indexOf('id="devHistory"');
        if (hist >= 0) expect(dev.text.indexOf('id="devIdp"')).toBeLessThan(hist);
    });
});
