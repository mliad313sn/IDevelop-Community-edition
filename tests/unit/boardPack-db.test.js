'use strict';
/**
 * The board pack and its decisions over REAL HTTP (the real app,
 * tests/helpers/c318/buildApp.js), on the dashboard fixture world
 * (tests/helpers/dashWorld.js, invented people only), inside a transaction
 * that is always rolled back:
 *
 *   - the pack opens on the capability index and « In brief », then targets
 *     and gaps, the previous decisions, the executive indicators; it names
 *     nobody;
 *   - recording the pack is an explicit POST with the session's CSRF token:
 *     without it, refused; with it, one board_pack_runs row of whole-number
 *     ids; opening or printing writes nothing;
 *   - a pack recorded on an earlier day is « the last pack »; under another
 *     KPI contract the pack says the definitions changed and prints no change;
 *   - a decision whose text names a person is refused and nothing is
 *     written; a decision names a ROLE; dropping needs a reason; a read-only
 *     administrator cannot write;
 *   - a line manager who sees part of the organisation keeps their decisions
 *     under their own key: the committee's decision is « not found » to them.
 *
 * Runs on idevelop_test* / idevelop_fixtures; skipped otherwise.
 */
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

const request = require('supertest');
const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/dashWorld');

const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL);
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(10 * 60 * 1000);

const CSRF = 'board-pack-csrf';
let db;
let server;
let base;
let world;
let release;
let txDone;
const COOKIE = {};

function get(role, url) {
    return request(base)
        .get(url)
        .redirects(0)
        .timeout(120000)
        .set('Cookie', COOKIE[role])
        .set('Accept', 'text/html');
}
function post(role, url, body, { csrf = true } = {}) {
    return request(base)
        .post(url)
        .redirects(0)
        .timeout(120000)
        .set('Cookie', COOKIE[role])
        .type('form')
        .send({ ...(csrf ? { _csrf: CSRF } : {}), ...body });
}
let txClient;
/** Read or write INSIDE the suite's transaction (where the world and the server live). */
const tx = (fn) => db._txStore.run(txClient, fn);
const q1 = (sql, params = []) => tx(() => db.get(sql, params));
const run = (sql, params = []) => tx(() => db.run(sql, params));
const count = async (sql, params = []) => Number((await q1(sql, params)).n);

d('the board pack and its decisions over real HTTP (fixture world, rolled back)', () => {
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
        const ROLLBACK = new Error('__BOARD_HTTP_ROLLBACK__');
        txDone = db
            .runTransaction(async () => {
                world = await W.world(db);
                txClient = db._txStore.getStore();
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
        const sa = await q1(
            "SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1"
        );
        const P = {
            superadmin: { id: Number(sa.id), userType: 'admin' },
            manager: { id: world.M, userType: 'employee' },
            viewer: { id: world.viewerId, userType: 'admin' },
        };
        for (const [role, p] of Object.entries(P))
            COOKIE[role] = await mintSession(storeState.store, p, CSRF);
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

    test('the pack: index first, then targets, decisions, executive indicators; no name', async () => {
        const r = await get('superadmin', '/exec/board-pack?scope=all');
        expect(r.status).toBe(200);
        const html = r.text;
        const at = (id) => html.indexOf(`id="${id}"`);
        expect(at('bp-index')).toBeGreaterThan(-1);
        expect(at('bp-index')).toBeLessThan(at('bp-kpis'));
        expect(at('bp-kpis')).toBeLessThan(at('bp-targets'));
        expect(at('bp-targets')).toBeLessThan(at('bp-decisions'));
        expect(at('bp-decisions')).toBeLessThan(at('bp-exec'));
        expect(html).toContain('data-bp-since="first"');
        expect(html).toContain('action="/exec/board-pack/record"');
        expect(html).toContain('data-kpi="K17"');
        expect(W.namesIn(html, world)).toEqual([]);
        expect(html).not.toMatch(/\son[a-z]+="/i);
        // opening the pack wrote nothing
        expect(await count('SELECT COUNT(*) AS n FROM board_pack_runs')).toBe(0);
    });

    test('recording the pack: CSRF required, then one run of whole-number ids', async () => {
        const no = await post(
            'superadmin',
            '/exec/board-pack/record',
            { scope: 'all' },
            { csrf: false }
        );
        expect(no.status).toBe(403);
        expect(await count('SELECT COUNT(*) AS n FROM board_pack_runs')).toBe(0);

        const ok = await post('superadmin', '/exec/board-pack/record', { scope: 'all' });
        expect(ok.status).toBe(303);
        expect(ok.headers.location).toBe('/exec/board-pack');
        const run = await q1(
            `SELECT scope_key AS "key", population, population_ids AS "ids", kpi_contract AS "c",
                    kpi_values AS "v", generated_by_ref AS "ref"
               FROM board_pack_runs ORDER BY id DESC LIMIT 1`
        );
        expect(run.key).toBe('org');
        expect(run.c).toBe('kpi-2');
        expect(run.population).toBe(run.ids.length);
        expect(run.ids.every((x) => Number.isSafeInteger(Number(x)))).toBe(true);
        expect(run.ids.map(Number)).toEqual(expect.arrayContaining(world.all));
        expect(Object.keys(run.v)).toContain('K1');
        expect(JSON.stringify(run.v)).not.toMatch(/Brightvale/);

        const today = await get('superadmin', '/exec/board-pack?scope=all');
        expect(today.text).toContain('data-bp-since="first"'); // today's own record is not « the last pack »

        // a viewer reads the pack but cannot record it
        const v = await post('viewer', '/exec/board-pack/record', { scope: 'all' });
        expect([403, 303]).toContain(v.status);
        expect(
            await count(
                "SELECT COUNT(*) AS n FROM board_pack_runs WHERE generated_by_ref LIKE 'admin:%'"
            )
        ).toBe(1);
    });

    test('since the last pack: compared, and no change across a contract change', async () => {
        const ids = world.all.slice(0, 6);
        const ins = (contract, days) =>
            run(
                `INSERT INTO board_pack_runs (scope_key, generated_at, pack_date, kpi_contract, population,
                                              population_ids, coverage, kpi_values, generated_by_ref)
                 VALUES ('org', now() - make_interval(days => ?::int), CURRENT_DATE - ?::int, ?, ?, ?::bigint[], 50,
                         '{"K1": {"value": 10, "status": "at_risk", "unit": "pct"}}'::jsonb, 'admin:1')`,
                [days, days, contract, ids.length, ids]
            );
        await ins('kpi-2', 30);
        let r = await get('superadmin', '/exec/board-pack?scope=all');
        expect(r.text).toContain('data-bp-since="compared"');
        expect(r.text).not.toContain('data-bp-contract');
        await ins('kpi-1', 10);
        r = await get('superadmin', '/exec/board-pack?scope=all');
        expect(r.text).toContain('data-bp-since="compared"');
        expect(r.text).toContain('data-bp-contract');
    });

    test('decisions: a name refused, a role recorded, dropping needs a reason, read-only refused', async () => {
        const named = `${world.names[0].first} ${world.names[0].last}`;
        const before = await count('SELECT COUNT(*) AS n FROM board_decisions');
        const refused = await post('superadmin', '/exec/decisions', {
            scope: 'all',
            decisionText: `Ask ${named} to lead the review`,
            ownerRole: 'hr_director',
        });
        expect(refused.status).toBe(303);
        expect(await count('SELECT COUNT(*) AS n FROM board_decisions')).toBe(before);

        const noCsrf = await post(
            'superadmin',
            '/exec/decisions',
            { scope: 'all', decisionText: 'Open a second session', ownerRole: 'training' },
            { csrf: false }
        );
        expect(noCsrf.status).toBe(403);

        const ok = await post('superadmin', '/exec/decisions', {
            scope: 'all',
            decisionText: 'Open a second training session on the critical skill',
            ownerRole: 'training',
            kpiId: 'K1',
        });
        expect(ok.status).toBe(303);
        expect(ok.headers.location).toBe('/exec/decisions');
        const dec = await q1(
            'SELECT id, scope_key AS "key", owner_role AS "role", state FROM board_decisions ORDER BY id DESC LIMIT 1'
        );
        expect(dec).toMatchObject({ key: 'org', role: 'training', state: 'open' });
        expect(
            await count('SELECT COUNT(*) AS n FROM board_decision_events WHERE decision_id = ?', [
                dec.id,
            ])
        ).toBe(1);

        const page = await get('superadmin', '/exec/decisions?scope=all');
        expect(page.status).toBe(200);
        expect(page.text).toContain(`data-decision="${dec.id}"`);
        expect(page.text).not.toMatch(/\son[a-z]+="/i);

        const drop = await post('superadmin', `/exec/decisions/${dec.id}/state`, {
            scope: 'all',
            state: 'dropped',
        });
        expect(drop.status).toBe(303);
        expect((await q1('SELECT state FROM board_decisions WHERE id = ?', [dec.id])).state).toBe(
            'open'
        );
        const drop2 = await post('superadmin', `/exec/decisions/${dec.id}/state`, {
            scope: 'all',
            state: 'dropped',
            note: 'Budget moved to the next year',
        });
        expect(drop2.status).toBe(303);
        const after = await q1('SELECT state, closed_at AS "c" FROM board_decisions WHERE id = ?', [
            dec.id,
        ]);
        expect(after.state).toBe('dropped');
        expect(after.c).toBeTruthy();

        const note = await post('superadmin', `/exec/decisions/${dec.id}/note`, {
            scope: 'all',
            note: `Follow-up with ${named}`,
        });
        expect(note.status).toBe(303);
        expect(
            await count(
                "SELECT COUNT(*) AS n FROM board_decision_events WHERE decision_id = ? AND kind = 'note'",
                [dec.id]
            )
        ).toBe(0);

        const bad = await post('superadmin', '/exec/decisions/abc/note', {
            scope: 'all',
            note: 'x y z',
        });
        expect(bad.status).toBe(404);

        const viewer = await post('viewer', '/exec/decisions', {
            scope: 'all',
            decisionText: 'Something',
            ownerRole: 'finance',
        });
        expect([403, 303]).toContain(viewer.status);
        expect(
            await count("SELECT COUNT(*) AS n FROM board_decisions WHERE owner_role = 'finance'")
        ).toBe(0);

        // the pack prints the decision with its role, never a person
        const pack = await get('superadmin', '/exec/board-pack?scope=all');
        expect(pack.text).toContain(`data-decision="${dec.id}"`);
        expect(W.namesIn(pack.text, world)).toEqual([]);
    });

    test('a line manager keeps their own key: the committee decision is not found to them', async () => {
        const dec = await q1(
            "SELECT id FROM board_decisions WHERE scope_key = 'org' ORDER BY id DESC LIMIT 1"
        );
        const page = await get('manager', '/exec/decisions?scope=all');
        expect(page.status).toBe(200);
        expect(page.text).not.toContain(`data-decision="${dec.id}"`);
        const move = await post('manager', `/exec/decisions/${dec.id}/note`, {
            scope: 'all',
            note: 'Checked on the floor',
        });
        expect(move.status).toBe(404);
        const mine = await post('manager', '/exec/decisions', {
            scope: 'all',
            decisionText: 'Pair the new starters with a mentor',
            ownerRole: 'managers',
        });
        expect(mine.status).toBe(303);
        const row = await q1(
            'SELECT scope_key AS "key" FROM board_decisions ORDER BY id DESC LIMIT 1'
        );
        expect(row.key).toMatch(/^reader:(manager|employee):\d+$/);
    });
});
