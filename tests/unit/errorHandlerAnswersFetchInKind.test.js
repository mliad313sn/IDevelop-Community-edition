'use strict';
/**
 * CODE-REVIEW-2026-09-17 [IMPORTANT/correctness]: « Le gestionnaire d'erreurs
 * global rend un 302 vers HTML a un fetch() de page sur un 500 (lu comme un
 * succes) ».
 *
 * The JSON branch tested `req.xhr`, a `/api/` path prefix, and an Accept
 * naming json. The app's OWN page-level fetch matches none of the three:
 *
 *   · fetch sends no X-Requested-With, so req.xhr is false;
 *   · its default Accept is the wildcard;
 *   · the routes are /v2/…, /employees/…, not /api/….
 *
 * So a 500 fell through to the HTML branch, which answers a flash + 302.
 * `fetch` follows a redirect automatically, received 200 and a page, and the
 * caller read `res.ok === true` — a server error reported to the user as a
 * success. Exactly the failure the whole JSON-302 class is about, still open in
 * the handler itself after the individual callers had been fixed.
 *
 * `wantsJson` additionally recognises a JSON request BODY, which is what those
 * calls actually send. It now lives in utils/wantsJson with ONE definition, so
 * the error handler applies the same rule as the auth middleware without
 * importing passport and every model behind it.
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const { wantsJson } = require('../../src/utils/wantsJson');

const REQ = (headers = {}, extra = {}) => ({ headers, ...extra });

describe('wantsJson recognises how the app actually calls itself', () => {
    test('a page fetch() posting a JSON body is a JSON caller', () => {
        // No Accept, no X-Requested-With — this is the shape that was missed.
        expect(wantsJson(REQ({ 'content-type': 'application/json' }))).toBe(true);
    });

    test('an explicit Accept is honoured', () => {
        expect(wantsJson(REQ({ accept: 'application/json' }))).toBe(true);
    });

    test('a classic XHR is honoured', () => {
        expect(wantsJson(REQ({}, { xhr: true }))).toBe(true);
    });

    test('a browser navigation is NOT — it must keep getting a page', () => {
        expect(wantsJson(REQ({ accept: 'text/html,application/xhtml+xml' }))).toBe(false);
        expect(wantsJson(REQ({}))).toBe(false);
        expect(wantsJson(REQ({ 'content-type': 'application/x-www-form-urlencoded' }))).toBe(false);
    });

    test('a missing request never throws — the error handler must not fail', () => {
        expect(wantsJson(null)).toBe(false);
        expect(wantsJson(undefined)).toBe(false);
    });
});

describe('the error handler uses that rule', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '../..', 'src/middleware/errorHandler.js'),
        'utf8'
    );

    test('it imports the shared predicate rather than testing headers itself', () => {
        expect(src).toMatch(/require\('\.\.\/utils\/wantsJson'\)/);
        expect(src).toMatch(/if \(wantsJson\(req\) \|\| req\.path\?\.startsWith\('\/api\/'\)\)/);
    });

    test('the old narrow test is gone', () => {
        // `req.xhr || path || accept` let a JSON-body fetch through to the 302.
        expect(src).not.toMatch(/if \(req\.xhr \|\| req\.path\?\.startsWith\('\/api\/'\)/);
    });

    test('a JSON caller gets a status and a body, never a redirect', () => {
        const branch = src.slice(src.indexOf('if (wantsJson(req)'), src.indexOf('// CLIENT-FAULT'));
        expect(branch).toMatch(/res\.status\(status\)\.json\(/);
        expect(branch).not.toMatch(/redirect/);
    });

    test('auth.js still exposes the same function, not a second copy', () => {
        const auth = fs.readFileSync(
            path.join(__dirname, '../..', 'src/middleware/auth.js'),
            'utf8'
        );
        expect(auth).toMatch(/require\('\.\.\/utils\/wantsJson'\)/);
        // A second local definition is how the two drift apart.
        expect(auth).not.toMatch(/function wantsJson\(req\) \{/);
    });
});
