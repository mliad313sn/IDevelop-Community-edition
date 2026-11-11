'use strict';
/**
 * The dashboard over REAL HTTP: the real app (tests/helpers/c318/buildApp.js),
 * sessions minted into a memory store, the fixture world of
 * tests/helpers/dashWorld.js (invented people) built inside ONE transaction
 * that the server runs in and that is always rolled back.
 *
 *   - one dashboard adapted to the clearance: per access profile, the first
 *     row (1 to 5 tiles), the « Not visible with your rights » line, the lists
 *     each may open (200) and those it may not (403, no list row printed);
 *     never a persona switch;
 *   - NO PERSON NAME on the dashboard, every tab, « Print everything », every
 *     list a page links to, the manager's home and the board pack; a list's
 *     count equals the count its link printed (reconciliation);
 *   - the context tabs: every allowed tab is served on demand; an unknown or
 *     an unauthorised one is 404, never another tab's content;
 *   - the scope bar: a site outside the reader's population is refused (400,
 *     not applied), a valid one is remembered for the next visit;
 *   - movements and the sparkline read snapshots of the same KPI contract;
 *   - the employee is taken to their home without an « access denied »
 *     flash; a viewer without scope gets one page-level state;
 *   - the former JSON endpoints answer 410; the module widgets need the
 *     block's capability (403);
 *   - at adoption stages 1, 2 and 3 no link of the dashboard, its lists, the
 *     manager's home or the board pack starts with a route prefix of a module
 *     that is off (config/modules.js MODULE_PREFIXES).
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
const M = require('../../src/config/modules');

const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL);
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(10 * 60 * 1000);

const CSRF = 'dash-http-csrf';
let db;
let app;
let server;
let base;
let world;
let release;
let txDone;
const COOKIE = {};
let ModuleService;

function stageState(stage) {
    const on = new Set(M.PRESETS[stage]);
    const modules = {};
    for (const k of M.MODULE_KEYS) modules[k] = on.has(k);
    return {
        stage: String(stage),
        stored: true,
        legacy: false,
        modules,
        configured: { ...modules },
    };
}
function setStage(stage) {
    // jest.config restores mocks before every test: spy again each time
    jest.spyOn(ModuleService, 'resolve').mockImplementation(async () => stageState(stage));
}

function get(role, url) {
    let r = request(base).get(url).redirects(0).timeout(120000);
    if (COOKIE[role]) r = r.set('Cookie', COOKIE[role]);
    return r.set('Accept', 'text/html,application/xhtml+xml');
}
const tiles = (html) =>
    [...html.matchAll(/<article class="viz-kpi[^"]*" id="([^"]+)"/g)].map((m) => m[1]);
const firstRow = (html) => {
    const m = html.match(/id="ds-tiles">([\s\S]*?)<\/section>/);
    return m ? tiles(m[1]) : [];
};
const lists = (html) => [
    ...new Set(
        [...html.matchAll(/href="(\/dashboard\/list\?[^"]*)"/g)].map((m) =>
            m[1].replace(/&amp;/g, '&')
        )
    ),
];
const clearance = (html) =>
    (html.match(/<p class="ds-clearance"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '';
const hrefs = (html) =>
    [...html.matchAll(/href="([^"#]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

d('the dashboard over real HTTP (fixture world, rolled back)', () => {
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
        ModuleService = require('../../src/services/ModuleService');
        setStage(3);
        app = loadApp();
        await i18nReady();
        // The server is started INSIDE the transaction: every request it
        // serves runs on the transaction's client and sees the fixture world.
        let started;
        let failed;
        const ready = new Promise((r, j) => {
            started = r;
            failed = j;
        });
        const ROLLBACK = new Error('__DASH_HTTP_ROLLBACK__');
        txDone = db
            .runTransaction(async () => {
                world = await W.world(db);
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
        const sa = await db.get(
            "SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1"
        );
        const P = {
            superadmin: { id: Number(sa.id), userType: 'admin' },
            manager: { id: world.M, userType: 'employee' },
            employee: { id: world.employeeAccount, userType: 'employee' },
            viewer: { id: world.viewerId, userType: 'admin' },
        };
        for (const [k, id] of Object.entries(world.profiles)) P[k] = { id, userType: 'admin' };
        for (const [role, p] of Object.entries(P))
            COOKIE[role] = await mintSession(storeState.store, p, CSRF);
        COOKIE.__store = storeState.store;
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

    beforeEach(() => setStage(3));

    // Expected per access profile (scoped to site N), stage 3. `hidden` = the
    // areas of the « Not visible with your rights » line; lists by indicator.
    const MATRIX = {
        site_hr: { hidden: ['campagnes'], allowed: ['K1', 'K8', 'VAL', 'K6'], refused: ['K11'] },
        dept_lead: {
            hidden: ['relève', 'campagnes', 'grille 9 cases'],
            allowed: ['K1', 'K8', 'VAL'],
            refused: ['K6', 'K7', 'K11'],
        },
        training_coord: {
            hidden: ['relève', 'campagnes', 'validations', 'grille 9 cases'],
            allowed: ['K1', 'K8', 'K9'],
            refused: ['VAL', 'K6'],
        },
        country_hrbp: {
            hidden: ['campagnes'],
            allowed: ['K1', 'K8', 'VAL', 'K6'],
            refused: ['K11'],
        },
        governance_read: {
            hidden: ['campagnes', 'validations', 'grille 9 cases', 'listes de personnes'],
            allowed: [],
            refused: ['K1', 'K8', 'K9', 'K6', 'K7', 'VAL'],
        },
        data_steward: {
            hidden: [
                'sécurité et habilitations',
                'relève',
                'campagnes',
                'validations',
                'grille 9 cases',
            ],
            allowed: ['K1', 'K4'],
            refused: ['K8', 'K9', 'K6', 'VAL'],
        },
    };
    const FIRST_PART = {
        K1: 'not_ready',
        K4: 'not_met',
        K8: 'expired',
        K9: 'unfit',
        K6: 'uncovered',
        K7: 'cells',
        K11: 'not_validated',
        VAL: 'waiting',
    };

    test.each(Object.keys(MATRIX))(
        '%s: tiles, « not visible » line, lists allowed (200) and refused (403)',
        async (role) => {
            const X = MATRIX[role];
            const r = await get(role, '/dashboard');
            expect(`${role}:${r.status}`).toBe(`${role}:200`);
            const html = r.text;
            const row = firstRow(html);
            expect(row.length).toBeGreaterThan(0);
            expect(row.length).toBeLessThanOrEqual(5);
            expect(html).not.toMatch(/vue=|persona|ds-switch/);
            const cl = clearance(html);
            for (const a of X.hidden) expect(`${role}: ${cl}`).toContain(a);
            for (const href of lists(html)) {
                const l = await get(role, href);
                expect(`${role} ${href} → ${l.status}`).toBe(`${role} ${href} → 200`);
            }
            for (const k of X.allowed) {
                const l = await get(role, `/dashboard/list?kpi=${k}&part=${FIRST_PART[k]}`);
                expect(`${role} ${k} → ${l.status}`).toBe(`${role} ${k} → 200`);
            }
            for (const k of X.refused) {
                const l = await get(role, `/dashboard/list?kpi=${k}&part=${FIRST_PART[k]}`);
                expect(`${role} ${k} → ${l.status}`).toBe(`${role} ${k} → 403`);
                expect(l.text).not.toMatch(/data-drill-row/);
                expect(l.text).toMatch(/Liste non visible avec vos droits/);
            }
        }
    );

    test('a SuperAdmin sees everything: no « not visible » line, every tab, deltas and a sparkline', async () => {
        const r = await get('superadmin', '/dashboard');
        expect(r.status).toBe(200);
        expect(clearance(r.text)).toBe('');
        const tabs = [...r.text.matchAll(/role="tab" id="ds-tab-([a-z]+)"/g)].map((m) => m[1]);
        expect(tabs).toEqual([
            'overview',
            'readiness',
            'safety',
            'talent',
            'succession',
            'development',
            'assessments',
        ]);
        // the K1 tile: a movement from a kpi-1 snapshot and a 3-point sparkline
        const k1 =
            (r.text.match(/<article class="viz-kpi[^"]*" id="kpi-k1">([\s\S]*?)<\/article>/) ||
                [])[1] || '';
        expect(k1).toMatch(/class="viz-delta viz-delta--(better|worse|same)"/);
        expect(k1).toMatch(/<svg class="viz-kpi-spark"/);
        expect(r.text).toMatch(/id="ds-brief"/);
    });

    test('NO NAMES: the dashboard, every tab, « Print everything », every list, the board pack and the manager home', async () => {
        const pages = ['/dashboard', '/dashboard?print=all', '/exec/board-pack'];
        for (const t of [
            'overview',
            'readiness',
            'safety',
            'talent',
            'succession',
            'development',
            'assessments',
        ])
            pages.push(`/dashboard/panel?tab=${t}`);
        const seen = new Set();
        for (const url of pages) {
            const r = await get('superadmin', url);
            expect(`${url} ${r.status}`).toBe(`${url} 200`);
            expect([url, W.namesIn(r.text, world)]).toEqual([url, []]);
            for (const l of lists(r.text)) seen.add(l);
        }
        expect(seen.size).toBeGreaterThan(0);
        for (const url of seen) {
            const r = await get('superadmin', url);
            expect([url, r.status, W.namesIn(r.text, world)]).toEqual([url, 200, []]);
        }
        const m = await get('manager', '/supervisor/dashboard');
        expect(m.status).toBe(200);
        expect(W.namesIn(m.text, world)).toEqual([]);
        expect(m.text).toMatch(/id="ds-team"/);
        expect(m.text).toMatch(/id="kpi-k1"/);
        expect(m.text).toMatch(/href="\/supervisor\/team"/);
        // the named roster is « My team », behind the manager's own guard
        const roster = await get('manager', '/supervisor/team');
        expect(roster.status).toBe(200);
        expect(W.namesIn(roster.text, world).length).toBeGreaterThan(0);
    });

    test('reconciliation: the count a « See the list » link prints = the list count', async () => {
        const r = await get('superadmin', '/dashboard?print=all');
        const pairs = [
            ...r.text.matchAll(
                /<a class="viz-kpi-drill" href="([^"]+)"[^>]*>[^(<]*\(([\d\s\u202f\u00a0,.]+)\)/g
            ),
        ];
        expect(pairs.length).toBeGreaterThan(0);
        for (const [, href, n] of pairs) {
            const l = await get('superadmin', href.replace(/&amp;/g, '&'));
            const m = l.text.match(/data-drill-count="(\d+)"/);
            expect(`${href} ${m && m[1]}`).toBe(`${href} ${n.replace(/\D/g, '')}`);
        }
    });

    test('context tabs: served on demand under the same gates; unknown or unauthorised ⇒ 404', async () => {
        for (const t of [
            'overview',
            'readiness',
            'talent',
            'development',
            'assessments',
            'safety',
        ]) {
            const r = await get('superadmin', `/dashboard/panel?tab=${t}`);
            expect(`${t} ${r.status}`).toBe(`${t} 200`);
            expect(r.text).toMatch(new RegExp(`data-tab-body="${t}"`));
            expect(r.text).not.toMatch(/<html/);
        }
        expect((await get('superadmin', '/dashboard/panel?tab=nope')).status).toBe(404);
        expect((await get('data_steward', '/dashboard/panel?tab=safety')).status).toBe(404);
        expect((await get('governance_read', '/dashboard/panel?tab=assessments')).status).toBe(404);
        // a former tab name is understood
        const legacy = await get('superadmin', '/dashboard?tab=executive');
        expect(legacy.text).toMatch(/id="ds-tab-overview"[^>]*aria-selected="true"/);
    });

    test('scope bar: a unit outside the population is refused; a valid one is remembered', async () => {
        const [N, E] = world.sites;
        const out = await get('site_hr', `/dashboard?site=${E.siteId}`);
        expect(out.status).toBe(400);
        expect(out.text).toMatch(/id="ds-scope-refused"/);
        const bad = await get('superadmin', '/dashboard?site=1%20OR%201%3D1');
        expect(bad.status).toBe(400);
        const ok = await get('superadmin', `/dashboard?site=${E.siteId}`);
        expect(ok.status).toBe(200);
        expect(ok.text).toMatch(new RegExp(`Dashsite E ${W.STAMP}`));
        const again = await get('superadmin', '/dashboard');
        expect(again.text).toMatch(new RegExp(`Vous voyez : Dashsite E ${W.STAMP}`));
        // another account never inherits it
        const other = await get('country_hrbp', '/dashboard');
        expect(other.text).not.toMatch(new RegExp(`Dashsite E ${W.STAMP}`));
        // the lists keep the scope
        expect(lists(again.text).every((h) => h.includes(`site=${E.siteId}`))).toBe(true);
        await get('superadmin', '/dashboard?scope=all');
        expect(N.siteId).toBeGreaterThan(0);
    });

    test('employee ⇒ their home without the « access denied » flash; viewer without scope ⇒ one state', async () => {
        const e = await get('employee', '/dashboard');
        expect([e.status, e.headers.location]).toEqual([302, '/employee/dashboard']);
        const sessions = JSON.stringify(COOKIE.__store.sessions || {});
        expect(sessions).not.toMatch(
            /manager_or_admin_required|Privilèges manager ou administrateur/
        );
        const v = await get('viewer', '/dashboard');
        expect(v.status).toBe(200);
        expect(v.text).toMatch(/Aucun périmètre attribué/);
        expect(tiles(v.text)).toEqual([]);
        expect(v.text).not.toMatch(/id="ds-explore"|id="ds-scope"/);
    });

    test('the former JSON endpoints are retired (410); module widgets need the capability (403)', async () => {
        const { RETIRED } = require('../../src/routes/dashboard');
        for (const p of RETIRED) {
            const url = p.replace(':skillId', '1').replace(':id', '1');
            for (const role of ['superadmin', 'manager']) {
                const r = await get(role, url).set('Accept', 'application/json');
                expect(`${role} ${url} ${r.status}`).toBe(`${role} ${url} 410`);
                expect(r.body.code).toBe('endpoint_retired');
            }
        }
        const w = await get('governance_read', '/api/dashboard/v2/cycle-countdown').set(
            'Accept',
            'application/json'
        );
        expect(w.status).toBe(403);
        const ok = await get('superadmin', '/api/dashboard/v2/cycle-countdown').set(
            'Accept',
            'application/json'
        );
        expect(ok.status).toBe(200);
    });

    test.each([1, 2, 3])('stage %s: no link leads into a module that is off', async (stage) => {
        setStage(stage);
        const on = new Set(M.PRESETS[stage]);
        const off = M.MODULE_KEYS.filter((k) => k !== 'localContent' && !on.has(k));
        const prefixes = off.flatMap((k) => M.MODULE_PREFIXES[k]);
        const bad = [];
        const visit = async (role, url) => {
            const r = await get(role, url);
            if (r.status !== 200) return [];
            for (const h of hrefs(r.text))
                if (prefixes.some((p) => h === p || h.startsWith(p + '/') || h.startsWith(p + '?')))
                    bad.push(`${role} ${url} → ${h}`);
            return lists(r.text);
        };
        for (const role of ['superadmin', 'site_hr', 'manager']) {
            const found = new Set();
            for (const url of ['/dashboard?print=all', '/exec/board-pack'])
                for (const l of await visit(role, url)) found.add(l);
            if (role === 'manager') await visit(role, '/supervisor/dashboard');
            for (const l of found) await visit(role, l);
        }
        expect(bad).toEqual([]);
        const sa = await get('superadmin', '/dashboard');
        const tabs = [...sa.text.matchAll(/role="tab" id="ds-tab-([a-z]+)"/g)].map((m) => m[1]);
        expect(tabs.includes('succession')).toBe(on.has('talent'));
        // an indicator whose module is off is not shown as « not measured »
        if (!on.has('campaigns')) expect(sa.text).not.toMatch(/id="kpi-k11/);
    });
});
