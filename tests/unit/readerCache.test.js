'use strict';
/**
 * The per-reader model cache (src/utils/readerCache.js) of the dashboard and
 * the board pack. A cache that crosses readers is a confidentiality leak, so
 * this suite proves, with invented readers:
 *   - two readers never share an entry, even with the same scope and figures;
 *   - the same reader with a different clearance, permission set, scope,
 *     language or tab gets a different entry;
 *   - a hit is a deep clone (a caller that decorates it changes nothing);
 *   - any successful write request drops everything, a refused one does not;
 *   - the dashboard bust signal drops it too; a write during a computation
 *     keeps that result out; the TTL is a backstop;
 *   - through the real controller, reader B is never served reader A's model.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..');
const RC = require('../../src/utils/readerCache');
const { dashboardCache } = require('../../src/utils/ttlCache');

const SCOPE = { site: 4 };
function ctxOf(user, ids = [11, 12, 13], extra = {}) {
    return {
        user,
        full: { ids },
        pop: { ids },
        scope: SCOPE,
        scopeRefused: false,
        flags: { talent: true, development: true },
        caps: { pop: true, safety: true },
        navVisible: { board_pack: true },
        ...extra,
    };
}
const ADA = { id: 41, userType: 'admin', role: 'localadmin', permissions: ['view_employees'] };
const BEN = { id: 42, userType: 'admin', role: 'localadmin', permissions: ['view_employees'] };
const parts = (ctx, more) => ({ ...RC.contextParts(ctx), lang: 'en', ...(more || {}) });

beforeEach(() => {
    process.env.DASHBOARD_MODEL_CACHE = '1';
    RC.bust();
});
afterAll(() => {
    delete process.env.DASHBOARD_MODEL_CACHE;
});

describe('an entry belongs to one reader and one clearance', () => {
    test('two readers with the same scope and figures never share an entry', async () => {
        let n = 0;
        const compute = (who) => async () => ({ owner: who, n: ++n });
        const a1 = await RC.memo('firstScreen', parts(ctxOf(ADA)), compute('ada'));
        const b1 = await RC.memo('firstScreen', parts(ctxOf(BEN)), compute('ben'));
        const a2 = await RC.memo('firstScreen', parts(ctxOf(ADA)), compute('ada'));
        const b2 = await RC.memo('firstScreen', parts(ctxOf(BEN)), compute('ben'));
        expect(a1.owner).toBe('ada');
        expect(b1.owner).toBe('ben');
        expect(a2).toEqual(a1);
        expect(b2).toEqual(b1);
        expect(n).toBe(2);
        expect(RC.entryId('firstScreen', parts(ctxOf(ADA)))).not.toBe(
            RC.entryId('firstScreen', parts(ctxOf(BEN)))
        );
    });

    test.each([
        ['a different clearance', ctxOf(ADA, [11, 12, 99])],
        ['a smaller scoped population', ctxOf(ADA, [11, 12, 13], { pop: { ids: [11] } })],
        [
            'another permission',
            ctxOf({ ...ADA, permissions: ['view_employees', 'view_compliance'] }),
        ],
        ['another role', ctxOf({ ...ADA, role: 'viewer' })],
        ['the same id as another user type', ctxOf({ ...ADA, userType: 'manager' })],
        ['another scope', ctxOf(ADA, [11, 12, 13], { scope: { site: 5 } })],
        ['other module switches', ctxOf(ADA, [11, 12, 13], { flags: { talent: false } })],
        ['other navigation gates', ctxOf(ADA, [11, 12, 13], { navVisible: {} })],
    ])('the same reader with %s gets a new entry', async (_what, other) => {
        let n = 0;
        const compute = async () => ({ n: ++n });
        await RC.memo('tab', parts(ctxOf(ADA), { tab: 'readiness' }), compute);
        const again = await RC.memo('tab', parts(other, { tab: 'readiness' }), compute);
        expect(again.n).toBe(2);
    });

    test('language, tab and query are part of the entry', () => {
        const base = RC.entryId('tab', parts(ctxOf(ADA), { tab: 'readiness', query: {} }));
        expect(
            RC.entryId('tab', { ...parts(ctxOf(ADA)), lang: 'fr', tab: 'readiness', query: {} })
        ).not.toBe(base);
        expect(RC.entryId('tab', parts(ctxOf(ADA), { tab: 'talent', query: {} }))).not.toBe(base);
        expect(
            RC.entryId(
                'tab',
                parts(ctxOf(ADA), { tab: 'readiness', query: { unit: 'department' } })
            )
        ).not.toBe(base);
        // equal content in another key order is the same entry
        expect(RC.entryId('tab', { query: {}, tab: 'readiness', ...parts(ctxOf(ADA)) })).toBe(base);
    });

    test('a request without a reader is never cached', async () => {
        let n = 0;
        const compute = async () => ({ n: ++n });
        await RC.memo('firstScreen', parts(ctxOf(null)), compute);
        await RC.memo('firstScreen', parts(ctxOf(null)), compute);
        await RC.memo('firstScreen', null, compute);
        expect(n).toBe(3);
        expect(RC._store.map.size).toBe(0);
    });

    test('entries live in a Map under a fixed-length digest', async () => {
        await RC.memo('firstScreen', parts(ctxOf(ADA)), async () => ({ ok: 1 }));
        expect(RC._store.map).toBeInstanceOf(Map);
        for (const id of RC._store.map.keys()) expect(id).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('a hit is a deep clone', () => {
    test('decorating a served model changes nothing for the next request', async () => {
        const at = new Date('2026-01-02T03:04:05Z');
        const first = await RC.memo('firstScreen', parts(ctxOf(ADA)), async () => ({
            tiles: [{ id: 'K1', value: 71 }],
            when: at,
            byUnit: new Map([['north', { n: 7 }]]),
        }));
        first.tiles[0].value = 0;
        first.tiles.push({ id: 'X' });
        first.byUnit.get('north').n = 0;
        first.when.setFullYear(1999);
        const second = await RC.memo('firstScreen', parts(ctxOf(ADA)), async () => {
            throw new Error('must be a hit');
        });
        expect(second.tiles).toEqual([{ id: 'K1', value: 71 }]);
        expect(second.byUnit.get('north').n).toBe(7);
        expect(second.when.getUTCFullYear()).toBe(2026);
        expect(RC.computedAt(second)).toBeInstanceOf(Date);
        expect(RC.computedAt({})).toBeNull();
    });

    test('concurrent identical requests share one computation', async () => {
        let n = 0;
        const slow = () => new Promise((r) => setTimeout(() => r({ n: ++n }), 20));
        const [x, y] = await Promise.all([
            RC.memo('tab', parts(ctxOf(ADA)), slow),
            RC.memo('tab', parts(ctxOf(ADA)), slow),
        ]);
        expect(n).toBe(1);
        expect(x).toEqual(y);
        expect(x).not.toBe(y);
    });
});

describe('any successful write drops it', () => {
    function fakeReqRes(method, status) {
        const res = new EventEmitter();
        res.statusCode = status;
        return { req: { method }, res };
    }
    async function warm() {
        await RC.memo('firstScreen', parts(ctxOf(ADA)), async () => ({ v: 1 }));
        expect(RC._store.map.size).toBe(1);
    }

    test.each(['POST', 'PUT', 'PATCH', 'DELETE'])('a %s answered 2xx/3xx busts', async (m) => {
        for (const status of [200, 302]) {
            await warm();
            const { req, res } = fakeReqRes(m, status);
            let called = false;
            RC.bustOnWrite(req, res, () => (called = true));
            expect(called).toBe(true);
            res.emit('finish');
            expect(RC._store.map.size).toBe(0);
        }
    });

    test('a refused write and a read keep it', async () => {
        await warm();
        for (const [m, status] of [
            ['POST', 403],
            ['POST', 400],
            ['DELETE', 500],
            ['GET', 200],
            ['HEAD', 200],
        ]) {
            const { req, res } = fakeReqRes(m, status);
            RC.bustOnWrite(req, res, () => {});
            res.emit('finish');
        }
        expect(RC._store.map.size).toBe(1);
    });

    test('the dashboard bust signal (assessments, imports) drops it too', async () => {
        await warm();
        dashboardCache.bust();
        expect(RC._store.map.size).toBe(0);
    });

    test('a write during a computation keeps that result out', async () => {
        let release;
        const gate = new Promise((r) => (release = r));
        const pending = RC.memo('firstScreen', parts(ctxOf(ADA)), async () => {
            await gate;
            return { v: 'before the write' };
        });
        RC.bust();
        release();
        expect((await pending).v).toBe('before the write');
        expect(RC._store.map.size).toBe(0);
    });

    test('the TTL is a backstop for changes made outside HTTP', async () => {
        const realNow = Date.now;
        try {
            await warm();
            Date.now = () => realNow() + RC.TTL_MS + 1000;
            let n = 0;
            await RC.memo('firstScreen', parts(ctxOf(ADA)), async () => ({ n: ++n }));
            expect(n).toBe(1);
        } finally {
            Date.now = realNow;
        }
    });

    test('server.js mounts the bust before every router', () => {
        const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const bust = server.indexOf("app.use(require('./src/utils/readerCache').bustOnWrite);");
        expect(bust).toBeGreaterThan(0);
        for (const later of [
            'app.get([...MANIFEST_FILES.keys()]',
            "app.post('/logout'",
            "app.post('/login'",
            "app.use('/api/v1', require('./src/api/v1'));",
            "app.use('/', routes);",
        ])
            expect(server.indexOf(later)).toBeGreaterThan(bust);
    });
});

describe('off in unit suites unless asked', () => {
    test('NODE_ENV=test leaves it off by default; DASHBOARD_MODEL_CACHE=0 always does', () => {
        delete process.env.DASHBOARD_MODEL_CACHE;
        expect(RC.enabled()).toBe(process.env.NODE_ENV !== 'test');
        process.env.DASHBOARD_MODEL_CACHE = '0';
        expect(RC.enabled()).toBe(false);
        process.env.DASHBOARD_MODEL_CACHE = '1';
        expect(RC.enabled()).toBe(true);
    });
});

describe('through the real controller: reader B never gets reader A’s board pack', () => {
    function loadController() {
        let C;
        const calls = { firstScreen: 0, tabModel: 0, packModel: 0 };
        jest.isolateModules(() => {
            jest.doMock('../../src/services/DashboardHomeService', () => ({
                context: async ({ user }) =>
                    ctxOf(user, user.id === 41 ? [11, 12, 13] : [21, 22], {
                        tabs: [{ id: 'overview' }],
                    }),
                firstScreen: async (ctx) => {
                    calls.firstScreen++;
                    return { owner: ctx.user.id, headcount: ctx.pop.ids.length };
                },
                tabModel: async (ctx, id) => {
                    calls.tabModel++;
                    return { owner: ctx.user.id, tab: id };
                },
                scopeLabel: () => 'Site 4',
                navHref: () => null,
                resolveTab: (v) => v || 'overview',
            }));
            jest.doMock('../../src/services/BoardPackService', () => ({
                packModel: async (ctx) => {
                    calls.packModel++;
                    return {
                        owner: ctx.user.id,
                        decisions: ctx.user.id === 41 ? ['north plan'] : [],
                    };
                },
            }));
            jest.doMock('../../src/controllers/BoardDecisionController', () => ({
                hiddenFields: () => [],
            }));
            const RCi = require('../../src/utils/readerCache');
            RCi.bust();
            C = { ctl: require('../../src/controllers/DashboardHomeController'), RC: RCi };
        });
        return { ...C, calls };
    }
    function res() {
        const r = { locals: { lang: 'en', numFmt: {}, fmtDate: (d) => String(d) } };
        r.status = () => r;
        r.render = (view, locals) => {
            r.view = view;
            r.out = locals;
            return r;
        };
        r.set = () => r;
        return r;
    }

    test('two readers, one after the other, each get their own figures', async () => {
        const { ctl, calls, RC: RCi } = loadController();
        const next = (e) => {
            throw e;
        };
        const req = (user) => ({ user, query: {}, t: (k) => k });
        const a1 = res();
        await ctl.boardPack(req(ADA), a1, next);
        const b1 = res();
        await ctl.boardPack(req(BEN), b1, next);
        const a2 = res();
        await ctl.boardPack(req(ADA), a2, next);

        expect(a1.out.screen).toEqual({ owner: 41, headcount: 3 });
        expect(a1.out.board.decisions).toEqual(['north plan']);
        expect(b1.out.screen).toEqual({ owner: 42, headcount: 2 });
        expect(b1.out.board.decisions).toEqual([]);
        expect(b1.out.overview.owner).toBe(42);
        // A's second open is served from A's own entries
        expect(a2.out.screen).toEqual(a1.out.screen);
        expect(calls).toEqual({ firstScreen: 2, tabModel: 2, packModel: 2 });
        // the pack says when its figures were computed
        expect(a2.out.generatedAt).toBeInstanceOf(Date);
        expect(RCi._store.map.size).toBe(6);
    });
});
