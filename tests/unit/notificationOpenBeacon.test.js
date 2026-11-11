'use strict';

/**
 * A notification link changes nothing on GET (mail scanners follow every
 * link); the landing page's beacon (public/js/notif-open.js) posts the ids
 * to POST /notifications/opened. Pure checks: the fragment builder, the
 * route and the layout wiring, and the beacon script run in a sandbox.
 */
process.env.NODE_ENV = 'test';
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
}));

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('withOpenFragment', () => {
    const { withOpenFragment: w } =
        require('../../src/controllers/NotificationController')._presentation;
    test('adds the ids, keeps an existing anchor, ignores junk', () => {
        expect(w('/employee/development-plan/3', [1])).toBe('/employee/development-plan/3#nopen=1');
        expect(w('/x#action-4', [1, 2])).toBe('/x#action-4&nopen=1,2');
        expect(w('/x', [0, -1, 1.5])).toBe('/x');
    });
});

describe('wiring', () => {
    test('the beacon route is a signed-in POST; the GET stays a redirect', () => {
        const src = read('src/routes/index.js');
        expect(src).toMatch(
            /router\.post\(\s*'\/notifications\/opened',\s*requireAuth,\s*asyncHandler\(NotificationController\.opened/
        );
        expect(src).toMatch(/router\.get\(\s*'\/notifications\/:id\/go'/);
    });
    test('the main layout loads the beacon as a static, versioned script', () => {
        expect(read('views/layouts/main.ejs')).toMatch(
            /<script src="\/js\/notif-open\.js\?v=<%= assetVersion %>" defer><\/script>/
        );
    });
});

describe('notif-open.js in a sandbox', () => {
    const code = read('public/js/notif-open.js');
    function run(hash) {
        const calls = { fetch: [], replace: [] };
        const location = { hash, pathname: '/employee/my-learning', search: '?tab=1' };
        const window = {
            location,
            history: { state: null, replaceState: (s, t, u) => calls.replace.push(u) },
            fetch: (url, opts) => {
                calls.fetch.push({ url, opts });
                return Promise.resolve();
            },
        };
        const document = {
            getElementById: () => null,
            querySelector: () => ({ getAttribute: () => 'tok123' }),
        };
        vm.runInNewContext(code, { window, document, JSON, String });
        return calls;
    }
    test('posts the ids with the CSRF header and restores the address', () => {
        const c = run('#nopen=5,6');
        expect(c.replace).toEqual(['/employee/my-learning?tab=1']);
        expect(c.fetch).toHaveLength(1);
        expect(c.fetch[0].url).toBe('/notifications/opened');
        expect(c.fetch[0].opts.method).toBe('POST');
        expect(c.fetch[0].opts.headers['x-csrf-token']).toBe('tok123');
        expect(JSON.parse(c.fetch[0].opts.body)).toEqual({ ids: '5,6' });
    });
    test('keeps the anchor in front of the ids', () => {
        const c = run('#action-4&nopen=9');
        expect(c.replace).toEqual(['/employee/my-learning?tab=1#action-4']);
        expect(JSON.parse(c.fetch[0].opts.body)).toEqual({ ids: '9' });
    });
    test('does nothing without the tag, and drops non-numeric ids', () => {
        expect(run('#section').fetch).toHaveLength(0);
        expect(run('').fetch).toHaveLength(0);
        expect(run('#xnopen=5').fetch).toHaveLength(0);
        expect(run('#nopen=abc').fetch).toHaveLength(0);
        expect(JSON.parse(run('#nopen=7,x,8').fetch[0].opts.body)).toEqual({ ids: '7,8' });
    });
});
