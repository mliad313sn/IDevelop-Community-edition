'use strict';
/**
 * 3.23.21 — lane L2, ST-2: optional router mounts in src/routes/index.js.
 *
 * Every optional mount sat in `catch (_) {}`: a router that failed to LOAD
 * disappeared without a word, and v2-idp + v2-idp-lifecycle shared ONE try, so
 * a fault in either removed both. Now each mount has its own block and a
 * failure is logged as `[routes] <name> not mounted`.
 *
 *  1. the real route tree carries the safety-gate status API and the IDP
 *     lifecycle writes (complete / archive / objective state);
 *  2. a router that throws at load is LOGGED by name, and its sibling survives.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.V2_FEATURES = '1';

const { listRoutes } = require('../helpers/c318/buildApp');

function routesOf(router) {
    return listRoutes({ _router: { stack: router.stack } }).map((r) => `${r.method} ${r.path}`);
}

function loadRoutes() {
    let router;
    jest.isolateModules(() => {
        router = require('../../src/routes/index');
    });
    return router;
}

jest.setTimeout(60000);

describe('ST-2 — the optional surfaces are mounted, and a failed mount is logged', () => {
    let errSpy;
    beforeEach(() => {
        errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        errSpy.mockRestore();
        jest.dontMock('../../src/routes/v2-idp-lifecycle');
    });

    const notMounted = () =>
        errSpy.mock.calls.filter((a) => /^\[routes\] .* not mounted$/.test(String(a[0])));

    test('the real tree: /v2/safety-gate/status and /v2/idp/:id/complete exist, nothing failed to mount', () => {
        const all = routesOf(loadRoutes());
        const has = (re) => all.some((r) => re.test(r));
        expect(all).toEqual(
            expect.arrayContaining([
                'GET /v2/safety-gate/status',
                'GET /v2/safety-gate/status/:employeeNumber',
            ])
        );
        expect(has(/^POST \/v2\/idp\/:id(\(.*\))?\/complete$/)).toBe(true);
        expect(has(/^POST \/v2\/idp\/:id(\(.*\))?\/archive$/)).toBe(true);
        expect(has(/^POST \/v2\/idp\/objectives\/:oid(\(.*\))?\/state$/)).toBe(true);
        expect(notMounted()).toEqual([]);
    });

    test('a router that throws at load is logged BY NAME, and v2-idp stays mounted', () => {
        jest.doMock('../../src/routes/v2-idp-lifecycle', () => {
            throw new Error('boom at load');
        });
        const all = routesOf(loadRoutes());
        const logged = notMounted();
        expect(logged.map((a) => a[0])).toEqual(['[routes] v2-idp-lifecycle not mounted']);
        expect(String(logged[0][1] && logged[0][1].message)).toMatch(/boom at load/);
        expect(all.some((r) => /^POST \/v2\/idp\/:id(\(.*\))?\/complete$/.test(r))).toBe(false);
        // the sibling router in the same /v2/idp space survived
        expect(all.some((r) => /^GET \/v2\/idp\b/.test(r))).toBe(true);
    });
});
