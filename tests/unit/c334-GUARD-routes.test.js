'use strict';
/**
 * Guard — route coverage: no button or form posts to an address nobody serves.
 *
 * What: every <form action>, data-action / -post / -url / -endpoint attribute
 * and fetch() URL in views/ and public/js is matched (method + Express pattern,
 * mount prefixes resolved through app.use / router.use, module gates and other
 * middleware included) against the routes registered in src/** and server.js.
 * A URL built by concatenation ('/x/' + id + '/y') is matched by its static
 * prefix. No database.
 *
 * Exceptions: allowlist.json → routes (method, url, reason) for a target that
 * is served outside Express (a static file, a proxy rewrite…).
 */
const S = require('../helpers/guards/scans');
const A = require('../helpers/guards/allowlist');

describe('every UI target resolves to a mounted route', () => {
    const r = S.routeCoverage();
    test('scan sanity (routes and targets found)', () => {
        expect(r.routes).toBeGreaterThan(700);
        expect(r.targets).toBeGreaterThan(180);
        expect(A.unreasoned('routes')).toEqual([]);
    });
    test('no unmatched form action / fetch URL', () => {
        const missing = r.missing.filter(
            (t) => !A.allowed('routes', { method: t.method, url: t.url })
        );
        expect(missing.map((t) => `${t.method} ${t.url} ← ${t.where}`)).toEqual([]);
    });
    test('a mount behind a module gate is resolved (the 360° pages live under /feedback-360)', () => {
        const people = r.missing.filter((t) => t.url.startsWith('/feedback-360/'));
        expect(people).toEqual([]);
    });
});
