'use strict';
/**
 * Three small input controls:
 *  - a free-text reason is capped at 2 000 characters server-side, on every
 *    route (validators.reasonLengthGuard, mounted in server.js);
 *  - a NEW admin username is letters, digits and ". _ @ -" only, 2 to 64
 *    characters (create only);
 *  - the SQL console's function-name scan is linear (it was quadratic on a long
 *    identifier run: a ReDoS).
 */
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({})),
    pool: {},
}));

const fs = require('fs');
const path = require('path');
const { validationResult } = require('express-validator');
const v = require('../../src/utils/validators');

const ROOT = path.join(__dirname, '..', '..');
const loadNs = (lng, ns) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lng, ns + '.json'), 'utf8'));
const tFor = (lng) => (key, opts) => {
    const [ns, k] = key.split(':');
    const s = loadNs(lng, ns)[k];
    return typeof s === 'string' ? s : (opts && opts.defaultValue) || key;
};

const ms = (fn) => {
    const t = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t) / 1e6;
};
// The fastest of 3 runs: a ReDoS is slow every time, a loaded machine only once.
const best = (fn, n = 3) => Math.min(...Array.from({ length: n }, () => ms(fn)));

describe('reasons are capped at 2 000 characters server-side', () => {
    const run = (req) =>
        new Promise((resolve) => {
            const res = {
                statusCode: 200,
                status(c) {
                    this.statusCode = c;
                    return this;
                },
                json(b) {
                    resolve({ status: this.statusCode, body: b });
                },
                redirect(u) {
                    resolve({ redirect: u });
                },
            };
            v.reasonLengthGuard(req, res, () => resolve({ next: true }));
        });

    test('2 000 characters pass; 2 001 are refused (JSON), in the reader language', async () => {
        expect(
            await run({
                path: '/x',
                headers: { 'content-type': 'application/json' },
                body: { reason: 'r'.repeat(2000) },
            })
        ).toEqual({ next: true });
        const r = await run({
            path: '/compliance/certifications/1/revoke',
            headers: { 'content-type': 'application/json' },
            t: tFor('fr'),
            body: { reason: 'r'.repeat(2001) },
        });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('reason_too_long');
        expect(r.body.field).toBe('reason');
        expect(r.body.error).toBe(loadNs('fr', 'validation').reason_too_long);
        const en = await run({
            path: '/x',
            headers: { 'content-type': 'application/json' },
            t: tFor('en'),
            body: { reason: 'r'.repeat(2001) },
        });
        expect(en.body.error).toBe(loadNs('en', 'validation').reason_too_long);
    });

    test('nested and suffixed reason fields are covered; other text fields are not', () => {
        const long = 'r'.repeat(5000);
        expect(v.overlongReasonField({ items: [{ cancelReason: long }] })).toBe('cancelReason');
        expect(v.overlongReasonField({ rejection_reason: long })).toBe('rejection_reason');
        expect(v.overlongReasonField({ motif: long })).toBe('motif');
        expect(v.overlongReasonField({ justification: long, comment: long })).toBe(null);
        expect(v.reasonTooLong('x'.repeat(2001))).toBe(true);
        expect(v.reasonTooLong('x'.repeat(2000))).toBe(false);
    });

    test('a form post flashes the message and goes back to the form', async () => {
        const flashed = [];
        const r = await run({
            path: '/lifecycle/events/1/revert',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            get: () => null,
            t: tFor('fr'),
            session: {},
            flash: (k, m) => flashed.push([k, m]),
            body: { reason: 'r'.repeat(80000) },
        });
        expect(r.redirect).toBeTruthy();
        expect(flashed.find(([k]) => k === 'error')[1]).toMatch(/motif/i);
    });

    test('server.js mounts the guard after the CSRF check', () => {
        const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const guard = src.indexOf("require('./src/utils/validators').reasonLengthGuard");
        expect(guard).toBeGreaterThan(src.indexOf("send('Invalid CSRF token')"));
        expect(guard).toBeLessThan(
            src.indexOf('// Make user and CSRF token available to all views')
        );
    });
});

describe('a new admin username: letters, digits and . _ @ -, 2 to 64 characters', () => {
    async function errorsFor(username) {
        const req = {
            body: {
                username,
                email: 'a@example.test',
                password: 'a-long-enough-password',
                passwordConfirm: 'a-long-enough-password',
                role: 'viewer',
            },
        };
        for (const chain of v.adminValidation.slice(0, -1)) await chain.run(req);
        return validationResult(req)
            .array()
            .map((e) => e.msg);
    }

    test.each(['jdoe', 'j.doe', 'j_doe-2', 'jdoe@corp.example', 'ab', 'x'.repeat(64)])(
        '%s is accepted',
        async (u) => {
            expect(await errorsFor(u)).not.toContain('validation:username_charset');
        }
    );

    test.each(['a', 'x'.repeat(65), 'j doe', '<script>', 'jdoe;drop', 'jdoé', 'a/b'])(
        '%s is refused with its own message',
        async (u) => {
            expect(await errorsFor(u)).toContain('validation:username_charset');
        }
    );

    test('an empty username gets only the "required" message', async () => {
        const msgs = await errorsFor('');
        expect(msgs).toContain('validation:username_required');
        expect(msgs).not.toContain('validation:username_charset');
    });

    test('the update rules do not apply it (existing usernames keep working)', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/utils/validators.js'), 'utf8');
        const update = src.slice(src.indexOf('const adminUpdateValidation'));
        expect(update.slice(0, update.indexOf('];'))).not.toMatch(/username_charset/);
    });

    test('FR and EN carry the messages', () => {
        for (const lng of ['fr', 'en']) {
            const ns = loadNs(lng, 'validation');
            expect(ns.username_charset).toEqual(expect.any(String));
            expect(ns.reason_too_long).toEqual(expect.any(String));
        }
    });
});

describe('SQL console function-name scan is linear and finds the same calls', () => {
    const svc = require('../../src/services/SqlConsoleService');
    test('the same names as before', () => {
        expect(svc._calledFunctionNames('SELECT public.wipe_all()')).toContain('wipe_all');
        expect(svc._calledFunctionNames('select a.b.c_fn  (1), count(*) from t')).toEqual(
            expect.arrayContaining(['c_fn', 'count'])
        );
        expect(svc._calledFunctionNames('select "public".pg_sleep(1)')).toContain('pg_sleep');
        expect(svc._calledFunctionNames("select 'f(x)' from t")).toEqual([]);
    });
    test('an 80 KB identifier run is scanned quickly (was a timeout)', () => {
        for (const s of [
            'select ' + 'a'.repeat(80000),
            'select ' + 'a.'.repeat(40000),
            'select ' + 'a_'.repeat(40000) + ' x',
        ]) {
            expect(best(() => svc._calledFunctionNames(s))).toBeLessThan(100);
        }
    });
});
