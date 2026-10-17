'use strict';
/**
 * CSRF on multipart uploads (audit SA-15).
 *
 * multer parses a multipart body AFTER the global CSRF check, so the upload
 * routes used to be exempt. They are not any more: the token travels in the
 * `x-csrf-token` header (fetch uploads) or as `?_csrf=` on the action of a
 * native multipart form (public/js/main.js adds it at submit time).
 *
 * This file builds the SAME token check server.js mounts (csrf-sync with
 * httpHardening.csrfTokenFromRequest, skipped only where httpHardening.csrfSkip
 * says) in front of the REAL routers, then:
 *   - enumerates every upload mount from the live router stacks (each
 *     guardUpload middleware is marked) and fails when one is missing from the
 *     table below, so a new mount cannot slip in untested;
 *   - for each route family: no token, a wrong header token or a wrong query
 *     token is 403 before multer runs; the right token in the header or in the
 *     query reaches the upload guard (an executable wearing the accepted
 *     extension is then refused with 400, which proves the check was passed);
 *   - `?_csrf=` is honoured for multipart only, never for a url-encoded form;
 *   - /api/v1 keeps its key model (not cookie-based, not token-checked).
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.V2_FEATURES = '1';
process.env.SQL_CONSOLE_ENABLED = '1';

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const { csrfSync } = require('csrf-sync');
const H = require('../../src/middleware/httpHardening');

jest.setTimeout(90000);

const ROOT = path.join(__dirname, '..', '..');
const { ALL_SLUGS } = require('../../src/config/permissions');
const SUPER = {
    id: 1,
    userType: 'admin',
    role: 'superadmin',
    username: 't',
    permissions: [...ALL_SLUGS],
};
const EMPLOYEE = { id: 77, userType: 'employee', permissions: [] };

// Every upload mount: [route family, path as mounted, multipart field, file name].
const FAMILIES = {
    'POST /admin/integrations/hris/upload': ['HRIS CSV', 'file', 'people.csv'],
    'POST /framework/library/esco/upload': ['skills library (ESCO)', 'files', 'skills_en.csv'],
    'POST /framework/quality/import': ['skill quality workbook', 'file', 'q.xlsx'],
    'POST /app-settings/branding': ['branding logo', 'logoFile', 'logo.png'],
    'POST /admin/data/import': ['full-system import', 'excelFile', 'full.xlsx'],
    'POST /admin/data/import-json': ['full-system import', 'jsonFile', 'full.json'],
    'POST /admin/data/preview': ['full-system import', 'excelFile', 'full.xlsx'],
    'POST /admin/data/preview-json': ['full-system import', 'jsonFile', 'full.json'],
    'POST /data-management/sql-console/from-excel': ['SQL console', 'excelFile', 'x.xlsx'],
    'POST /data-management/import/organization': ['data-management import', 'file', 'o.xlsx'],
    'POST /data-management/import/domains-skills': ['data-management import', 'file', 'd.xlsx'],
    'POST /data-management/import/employees': ['employee import', 'file', 'e.xlsx'],
    'POST /data-management/import/local-admins': ['data-management import', 'file', 'a.xlsx'],
    'POST /data-management/import/roles': ['data-management import', 'file', 'r.xlsx'],
    'POST /data-management/import/skill-framework': ['data-management import', 'file', 's.xlsx'],
    'POST /data-management/import/assessments': ['data-management import', 'file', 'as.xlsx'],
    'POST /data-management/import/certifications': ['certificates import', 'file', 'c.xlsx'],
    'POST /data-management/skill-matrix-workbook/preview': [
        'skill-matrix workbook',
        'file',
        'w.xlsx',
    ],
    'POST /data-management/skill-matrix-workbook/import': [
        'skill-matrix workbook',
        'file',
        'w.xlsx',
    ],
    'POST /compliance/certifications': ['certificate evidence', 'evidence', 'cert.pdf'],
    'POST /v2/slf/evidence/:selfAssessmentId': ['self-assessment evidence', 'file', 'proof.pdf'],
};

/** Every route whose handler chain contains a guardUpload middleware. */
function uploadMounts(router, prefix) {
    const out = [];
    for (const layer of router.stack || []) {
        if (layer.route) {
            const guarded = layer.route.stack.some((l) => l.handle && l.handle.uploadGuard);
            if (!guarded) continue;
            const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
            for (const m of Object.keys(layer.route.methods)) {
                for (const p of paths) out.push(`${m.toUpperCase()} ${prefix}${p}`);
            }
        } else if (layer.handle && Array.isArray(layer.handle.stack)) {
            // router.use('/v2/slf', sub): Express 4 keeps only the compiled regexp.
            const sub = String(layer.regexp && layer.regexp.source)
                .replace(/^\^/, '')
                .replace('\\/?(?=\\/|$)', '')
                .replace(/\\\//g, '/');
            out.push(...uploadMounts(layer.handle, prefix + (sub === '\\/?' ? '' : sub)));
        }
    }
    return out;
}

// routes/index.js mounts every other router (v2-slf included, under /v2/slf).
let indexRouter;
function loadIndex() {
    if (!indexRouter) {
        jest.isolateModules(() => {
            indexRouter = require('../../src/routes/index');
        });
    }
    return indexRouter;
}

function buildApp() {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(ROOT, 'views'));
    app.use(express.json({ type: [...H.JSON_TYPES] }));
    app.use(express.urlencoded({ extended: true }));
    app.use(
        session({ secret: 'test-secret', resave: false, saveUninitialized: true, name: 'app.sid' })
    );
    // The check server.js mounts (same token source, same skip list).
    const { generateToken, csrfSynchronisedProtection } = csrfSync({
        getTokenFromRequest: H.csrfTokenFromRequest,
    });
    app.use((req, res, next) => {
        if (H.csrfSkip(req)) return next();
        csrfSynchronisedProtection(req, res, (err) => {
            if (err) return res.status(403).send('Invalid CSRF token');
            next();
        });
    });
    app.get('/__token', (req, res) => res.json({ t: generateToken(req) }));
    app.post('/__form', (req, res) => res.json({ ok: true }));
    app.use((req, res, next) => {
        req.user = req.path.startsWith('/v2/slf/') ? EMPLOYEE : SUPER;
        req.isAuthenticated = () => true;
        req.flash = () => {};
        req.t = (k, o) => (o && o.defaultValue) || k;
        next();
    });
    app.use(loadIndex());
    app.use(require('../../src/middleware/errorHandler').errorHandler);
    return app;
}

let app;
let agent;
let token;
beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    app = buildApp();
    agent = request.agent(app);
    token = (await agent.get('/__token')).body.t;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);
});

const concrete = (p) => p.replace(/:(\w+)(\([^)]*\))?/g, '1');
const exe = Buffer.from('MZ\u0090\u0000 not what it says');

function upload(route, { header, query } = {}) {
    const [, field, name] = FAMILIES[route];
    const url =
        concrete(route.split(' ')[1]) + (query ? `?_csrf=${encodeURIComponent(query)}` : '');
    let r = agent.post(url).set('Accept', 'application/json');
    if (header) r = r.set('x-csrf-token', header);
    return r.attach(field, exe, name);
}

describe('every upload mount is enumerated and CSRF-protected', () => {
    test('the live routers expose exactly the upload mounts listed here', () => {
        const found = uploadMounts(loadIndex(), '').sort();
        expect(found).toEqual(Object.keys(FAMILIES).sort());
    });

    test('no source file outside the known set builds a multer instance', () => {
        const known = new Set([
            'src/routes/index.js',
            'src/routes/v2-slf.js',
            'src/controllers/DataManagementController.js',
        ]);
        const hits = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                const rel = `${dir}/${e.name}`;
                if (e.isDirectory()) walk(rel);
                else if (/\.js$/.test(e.name)) {
                    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
                    if (/require\(['"]multer['"]\)/.test(src)) hits.push(rel);
                }
            }
        };
        walk('src');
        for (const h of hits) expect(known.has(h) ? h : `${h} (unknown multer user)`).toBe(h);
        expect(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')).not.toMatch(
            /require\(['"]multer['"]\)/
        );
    });

    test('no multipart upload is on the CSRF skip list', () => {
        for (const route of Object.keys(FAMILIES)) {
            const p = concrete(route.split(' ')[1]);
            expect([
                p,
                H.csrfSkip({
                    path: p,
                    method: 'POST',
                    headers: { 'content-type': 'multipart/form-data; boundary=B' },
                }),
            ]).toEqual([p, false]);
        }
        expect(H.CSRF_EXEMPT_UPLOADS).toBeUndefined();
        expect(H.CSRF_EXEMPT_UPLOAD_EXACT).toBeUndefined();
    });
});

// One representative mount per route family, plus every mount for the 403.
describe.each(Object.keys(FAMILIES))('%s', (route) => {
    test('no token, a wrong header token or a wrong query token is 403', async () => {
        expect((await upload(route)).status).toBe(403);
        expect((await upload(route, { header: 'nope' })).status).toBe(403);
        expect((await upload(route, { query: 'nope' })).status).toBe(403);
    });
    test('the session token in the x-csrf-token header passes the check', async () => {
        const r = await upload(route, { header: token });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: 'UPLOAD_TYPE_MISMATCH' });
    });
    test('the session token as ?_csrf= on a multipart request passes the check', async () => {
        const r = await upload(route, { query: token });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: 'UPLOAD_TYPE_MISMATCH' });
    });
});

describe('the query-string token', () => {
    test('is honoured for multipart only, never for a url-encoded form', async () => {
        const r = await agent
            .post(`/__form?_csrf=${encodeURIComponent(token)}`)
            .type('form')
            .send('a=1');
        expect(r.status).toBe(403);
        const ok = await agent.post('/__form').type('form').send(`a=1&_csrf=${token}`);
        expect(ok.status).toBe(200);
    });
    test('csrfTokenFromRequest reads body, then header, then (multipart) query', () => {
        const mp = { 'content-type': 'multipart/form-data; boundary=x' };
        expect(H.csrfTokenFromRequest({ body: { _csrf: 'b' }, headers: {}, query: {} })).toBe('b');
        expect(H.csrfTokenFromRequest({ headers: { 'x-csrf-token': 'h' }, query: {} })).toBe('h');
        expect(H.csrfTokenFromRequest({ headers: mp, query: { _csrf: 'q' } })).toBe('q');
        expect(
            H.csrfTokenFromRequest({
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                query: { _csrf: 'q' },
            })
        ).toBeUndefined();
        expect(H.csrfTokenFromRequest({ headers: mp, query: { _csrf: ['a', 'b'] } })).toBe(
            undefined
        );
    });
    test('the request log redacts it', () => {
        const { safeUrl } = require('../../src/middleware/logger');
        expect(safeUrl({ path: '/compliance/certifications', query: { _csrf: 'secret' } })).toBe(
            '/compliance/certifications?_csrf=REDACTED'
        );
    });
});

describe('server.js and the clients', () => {
    const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    test('server.js reads the token through csrfTokenFromRequest and skips through csrfSkip', () => {
        expect(SERVER).toMatch(/getTokenFromRequest:\s*httpHardening\.csrfTokenFromRequest/);
        expect(SERVER).toMatch(/if \(httpHardening\.csrfSkip\(req\)\) return next\(\);/);
    });
    test('/api/v1 stays key-authenticated: not token-checked', () => {
        expect(H.csrfSkip({ path: '/api/v1/employees', method: 'POST', headers: {} })).toBe(true);
    });
    test('main.js adds the header to same-origin mutations and ?_csrf= to native multipart forms', () => {
        const js = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
        expect(js).toMatch(/h\.set\('x-csrf-token', t\)/);
        expect(js).toMatch(/searchParams\.set\('_csrf', t\)/);
        expect(js).toMatch(/sameOrigin\(url\)/);
        // Decided at the end of the submit dispatch: a form a script sends itself
        // (fetch + header) never gets the token in its URL; a data-confirm form,
        // re-submitted natively after its dialog, does.
        expect(js).toMatch(/window\.addEventListener\('submit'/);
        expect(js).toMatch(
            /if \(e\.defaultPrevented && !f\.hasAttribute\('data-confirm'\)\) return;/
        );
    });
    test.each([
        ['public/js/hris-admin.js'],
        ['public/js/framework-library.js'],
        ['public/js/skill-quality.js'],
        ['views/pages/app-settings/index.ejs'],
        ['views/pages/data-management/sql-console.ejs'],
        ['views/pages/compliance/index.ejs'],
    ])('%s sends the x-csrf-token header with its upload', (f) => {
        expect(fs.readFileSync(path.join(ROOT, f), 'utf8')).toMatch(/'x-csrf-token'/);
    });
    test('every multipart fetch on the data-management page sends the header', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'views/pages/data-management/index.ejs'),
            'utf8'
        );
        expect(src).toMatch(/const CSRF_HEADERS = \{ 'x-csrf-token': '<%= csrfToken %>' \}/);
        const multipartFetches = [
            ...src.matchAll(/fetch\([^)]*?\{\s*method: 'POST',[^}]*?body: (fd|formData)[^}]*\}/g),
        ];
        expect(multipartFetches.length).toBeGreaterThanOrEqual(3);
        for (const m of multipartFetches) expect(m[0]).toMatch(/headers: CSRF_HEADERS/);
    });
});
