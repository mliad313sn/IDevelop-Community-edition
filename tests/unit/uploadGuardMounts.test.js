'use strict';
/**
 * uploadGuard on every multer mount (ASVS 12.2.1).
 *
 * For EVERY upload mount (routes/index.js, including the HRIS CSV upload and
 * the skills-library ESCO upload, v2-slf.js, DataManagementController's
 * uploadMiddleware) this proves, against the REAL routers:
 *   - a truncated / malformed multipart body answers 4xx (not 500), and the
 *     process is still alive and serving afterwards (no uncaughtException);
 *   - a file whose CONTENT does not match its extension is refused with 400
 *     before any controller runs.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.V2_FEATURES = '1';
process.env.SQL_CONSOLE_ENABLED = '1';

const http = require('http');
const express = require('express');

jest.setTimeout(90000);

const { ALL_SLUGS } = require('../../src/config/permissions');
const SUPER = {
    id: 1,
    userType: 'admin',
    role: 'superadmin',
    username: 't',
    permissions: [...ALL_SLUGS],
};
const EMPLOYEE = { id: 77, userType: 'employee', permissions: [] };

let server;
let port;
let uncaught = [];
let lastErr = null;
const onUncaught = (e) => uncaught.push(e);

function buildApp() {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', require('path').join(__dirname, '..', '..', 'views'));
    app.use((req, res, next) => {
        const asEmployee = req.path.startsWith('/v2/slf/');
        req.user = asEmployee ? EMPLOYEE : SUPER;
        req.isAuthenticated = () => true;
        req.flash = () => {};
        req.t = (k, o) => (o && o.defaultValue) || k;
        next();
    });
    app.get('/__alive', (req, res) => res.send('alive'));
    let slf;
    let index;
    jest.isolateModules(() => {
        slf = require('../../src/routes/v2-slf');
        index = require('../../src/routes/index');
    });
    app.use('/v2/slf', slf);
    app.use(index);
    app.use((err, req, res, next) => {
        lastErr = err;
        next(err);
    });
    app.use(require('../../src/middleware/errorHandler').errorHandler);
    return app;
}

beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.on('uncaughtException', onUncaught);
    const app = buildApp();
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
});
afterAll(async () => {
    process.removeListener('uncaughtException', onUncaught);
    if (server) await new Promise((r) => server.close(r));
});

function post(pathName, body, { json = true } = {}) {
    return new Promise((resolve) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: pathName,
                headers: {
                    'content-type': 'multipart/form-data; boundary=B',
                    'content-length': Buffer.byteLength(body),
                    ...(json ? { 'x-csrf-token': 't', accept: 'application/json' } : {}),
                },
            },
            (res) => {
                let d = '';
                res.on('data', (c) => (d += c));
                res.on('end', () => resolve({ status: res.statusCode, body: d }));
            }
        );
        req.on('error', (e) => resolve({ status: 0, body: e.message }));
        req.end(body);
    });
}

function get(pathName) {
    return new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }).on('error', (e) => resolve({ status: 0, body: e.message }));
    });
}

// [route, multipart field, a file name the route accepts by extension]
const MOUNTS = [
    ['/framework/quality/import', 'file', 'q.xlsx'], // routes/index.js — memoryStorage
    ['/app-settings/branding', 'logoFile', 'logo.png'], // routes/index.js — .fields()
    ['/admin/data/import', 'excelFile', 'full.xlsx'], // routes/index.js — upload.single
    ['/data-management/sql-console/from-excel', 'excelFile', 'x.xlsx'], // routes/index.js
    ['/compliance/certifications', 'evidence', 'cert.pdf'], // routes/index.js — _cmul
    ['/data-management/import/employees', 'file', 'e.xlsx'], // DataManagementController.upload
    ['/data-management/import/certifications', 'file', 'c.xlsx'], // DataManagementController.upload
    ['/v2/slf/evidence/1', 'file', 'proof.pdf'], // v2-slf.js
    ['/admin/integrations/hris/upload', 'file', 'people.csv'], // HRIS CSV upload
    ['/framework/library/esco/upload', 'files', 'skills_en.csv'], // ESCO library (csv)
    ['/framework/library/esco/upload', 'files', 'esco.zip'], // ESCO library (zip)
];

const truncated = (field, name) =>
    `--B\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\n\r\nxx`;
const badHeader = (field, name) =>
    `--B\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\nxxx\r\n--B\r\n\r\n--B--\r\n`;
const fullPart = (field, name, content) =>
    `--B\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--B--\r\n`;

describe.each(MOUNTS)('%s', (route, field, name) => {
    test('a truncated multipart body is a 4xx and the process survives', async () => {
        uncaught = [];
        const r = await post(route, truncated(field, name));
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        const r2 = await post(route, badHeader(field, name));
        expect(r2.status).toBeGreaterThanOrEqual(400);
        expect(r2.status).toBeLessThan(500);
        // Give a deferred throw (the multer 1.x failure mode) a chance to surface.
        await new Promise((res) => setTimeout(res, 150));
        expect(uncaught.map((e) => e.message)).toEqual([]);
        expect((await get('/__alive')).body).toBe('alive');
    });

    test('an executable wearing the accepted extension is refused with 400', async () => {
        const r = await post(route, fullPart(field, name, 'MZ\u0090\u0000 not what it says'));
        expect(r.status).toBe(400);
        expect(JSON.parse(r.body)).toMatchObject({ code: 'UPLOAD_TYPE_MISMATCH' });
    });
});

test('an HTML form post (no x-csrf-token) reaches the error handler as an exposed 400, not a 500', async () => {
    lastErr = null;
    const r = await post('/compliance/certifications', truncated('evidence', 'c.pdf'), {
        json: false,
    });
    expect(r.status).toBeLessThan(500);
    expect(lastErr).toMatchObject({ status: 400, expose: true, code: 'UPLOAD_MALFORMED' });
});

test('an extension the route does not accept is a typed 400 (not a silent drop, not a 500)', async () => {
    const r = await post('/compliance/certifications', fullPart('evidence', 'run.exe', 'MZ'));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toMatchObject({ code: 'UPLOAD_TYPE_NOT_ALLOWED' });
});

test('every raw multer instance in the route files is only ever called inside guardUpload', () => {
    const fs = require('fs');
    const path = require('path');
    const files = [
        'src/routes/index.js',
        'src/routes/v2-slf.js',
        'src/controllers/DataManagementController.js',
    ];
    let checked = 0;
    for (const f of files) {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
        // names bound to a multer instance: `const x = multer({` / `require('multer')({`
        const names = [
            ...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:multer|require\('multer'\))\(\{/g),
        ].map((m) => m[1]);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            const re = new RegExp(`\\b${name}\\.(single|array|fields|any|none)\\(`, 'g');
            for (const m of src.matchAll(re)) {
                const before = src.slice(Math.max(0, m.index - 80), m.index);
                expect(
                    `${f}: ${name}.${m[1]} ${/guardUpload\(\s*$/.test(before) ? 'ok' : 'NOT GUARDED'}`
                ).toMatch(/ ok$/);
                checked++;
            }
        }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
});
