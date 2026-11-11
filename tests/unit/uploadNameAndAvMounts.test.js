'use strict';
/**
 * The file-name rule and the antivirus gate on EVERY real upload mount
 * (routes/index.js with the HRIS CSV and skills-library ESCO uploads, branding,
 * data management, SQL console, compliance evidence, v2-slf evidence and
 * DataManagementController's imports), over HTTP against the real routers:
 *
 *   - a client name carrying a folder path is refused (400 UPLOAD_BAD_NAME)
 *     before any scan: every multer instance runs with `preservePath: true`, so
 *     the guard sees the raw name;
 *   - a file the antivirus calls infected is refused (422 UPLOAD_REJECTED_AV)
 *     before any controller runs.
 *
 * And it fails when a new upload slips past the guard:
 *   - the live routers expose exactly the mounts listed here (a new guarded
 *     mount must be added to this table);
 *   - no route anywhere carries a bare multer middleware (unguarded);
 *   - every multer instance in src/ is built with `preservePath: true` and is
 *     only ever used inside guardUpload().
 * The scanner is mocked (MalwareScanService.scanFile); the gate's own rules are
 * in uploadAvGate.test.js.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';
process.env.V2_FEATURES = '1';
process.env.SQL_CONSOLE_ENABLED = '1';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

let mockVerdict = { verdict: 'infected', engine: 'clamd', signature: 'Test' };
const mockScanned = [];
jest.mock('../../src/services/MalwareScanService', () => {
    const actual = jest.requireActual('../../src/services/MalwareScanService');
    return {
        ...actual,
        scanFile: jest.fn(async (p) => {
            mockScanned.push(p);
            return mockVerdict;
        }),
        // memory-storage mounts (HRIS, skill quality, skills library)
        scanBuffer: jest.fn(async (b) => {
            mockScanned.push(`buffer:${b.length}`);
            return mockVerdict;
        }),
        requireScan: jest.fn(async () => false),
    };
});
jest.mock('../../src/services/LogService', () => {
    const actual = jest.requireActual('../../src/services/LogService');
    actual.log = jest.fn(async () => null);
    return actual;
});
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

// Every upload mount: [method + path as mounted, multipart field, accepted name].
const MOUNTS = {
    'POST /admin/integrations/hris/upload': ['file', 'people.csv'],
    'POST /framework/library/esco/upload': ['files', 'esco.zip'],
    'POST /framework/quality/import': ['file', 'q.xlsx'],
    'POST /app-settings/branding': ['logoFile', 'logo.png'],
    'POST /admin/data/import': ['excelFile', 'full.xlsx'],
    'POST /admin/data/import-json': ['jsonFile', 'full.json'],
    'POST /admin/data/preview': ['excelFile', 'full.xlsx'],
    'POST /admin/data/preview-json': ['jsonFile', 'full.json'],
    'POST /data-management/sql-console/from-excel': ['excelFile', 'x.xlsx'],
    'POST /data-management/import/organization': ['file', 'o.csv'],
    'POST /data-management/import/domains-skills': ['file', 'd.xlsx'],
    'POST /data-management/import/employees': ['file', 'e.csv'],
    'POST /data-management/import/local-admins': ['file', 'a.xlsx'],
    'POST /data-management/import/roles': ['file', 'r.xlsx'],
    'POST /data-management/import/skill-framework': ['file', 's.xlsx'],
    'POST /data-management/import/assessments': ['file', 'as.xlsx'],
    'POST /data-management/import/certifications': ['file', 'c.xlsx'],
    'POST /data-management/skill-matrix-workbook/preview': ['file', 'w.xlsx'],
    'POST /data-management/skill-matrix-workbook/import': ['file', 'w.xlsx'],
    'POST /compliance/certifications': ['evidence', 'cert.pdf'],
    'POST /v2/slf/evidence/:selfAssessmentId': ['file', 'proof.pdf'],
};

let XLSX;
let ZIP;
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const content = (name) => {
    const ext = path.extname(name);
    if (ext === '.xlsx') return XLSX;
    if (ext === '.zip') return ZIP;
    if (ext === '.pdf') return PDF;
    if (ext === '.png') return PNG;
    if (ext === '.json') return Buffer.from('{"a":1}');
    return Buffer.from('a,b\n1,2\n');
};

let server;
let port;
let indexRouter;

function buildApp() {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(ROOT, 'views'));
    app.use((req, res, next) => {
        req.user = req.path.startsWith('/v2/slf/') ? EMPLOYEE : SUPER;
        req.isAuthenticated = () => true;
        req.flash = () => {};
        req.t = (k, o) => (o && o.defaultValue) || k;
        next();
    });
    jest.isolateModules(() => {
        indexRouter = require('../../src/routes/index');
    });
    app.use(indexRouter);
    app.use(require('../../src/middleware/errorHandler').errorHandler);
    return app;
}

beforeAll(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRow(['a']);
    XLSX = Buffer.from(await wb.xlsx.writeBuffer());
    // A workbook is a well-formed ZIP archive: enough for the archive checks.
    ZIP = XLSX;
    await new Promise((resolve) => {
        server = buildApp().listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
});
afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
});

function post(pathName, field, name, body) {
    const payload = Buffer.concat([
        Buffer.from(
            `--B\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        ),
        body,
        Buffer.from('\r\n--B--\r\n'),
    ]);
    return new Promise((resolve) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: pathName,
                headers: {
                    'content-type': 'multipart/form-data; boundary=B',
                    'content-length': payload.length,
                    'x-csrf-token': 't',
                    accept: 'application/json',
                },
            },
            (res) => {
                let d = '';
                res.on('data', (c) => (d += c));
                res.on('end', () => resolve({ status: res.statusCode, body: d }));
            }
        );
        req.on('error', (e) => resolve({ status: 0, body: e.message }));
        req.end(payload);
    });
}

const concrete = (p) => p.replace(/:(\w+)(\([^)]*\))?/g, '1');
const codeOf = (r) => {
    try {
        return JSON.parse(r.body).code;
    } catch (_) {
        return `(not JSON) ${r.status} ${r.body.slice(0, 80)}`;
    }
};

describe.each(Object.keys(MOUNTS))('%s', (route) => {
    const [field, name] = MOUNTS[route];
    const url = concrete(route.split(' ')[1]);

    test.each([`..\\..\\${name}`, `../${name}`, `C:\\temp\\${name}`])(
        'the client name %j is refused (400 UPLOAD_BAD_NAME) before any scan',
        async (bad) => {
            mockScanned.length = 0;
            const r = await post(url, field, bad, content(name));
            expect([r.status, codeOf(r)]).toEqual([400, 'UPLOAD_BAD_NAME']);
            expect(mockScanned).toEqual([]);
        }
    );

    test('a file the antivirus calls infected is refused (422 UPLOAD_REJECTED_AV)', async () => {
        mockVerdict = { verdict: 'infected', engine: 'clamd', signature: 'Test' };
        mockScanned.length = 0;
        const r = await post(url, field, name, content(name));
        expect([r.status, codeOf(r)]).toEqual([422, 'UPLOAD_REJECTED_AV']);
        expect(mockScanned).toHaveLength(1);
    });
});

/** Every route of a router tree as `METHOD /path`, with its handler chain. */
function routesOf(router, prefix, out = []) {
    for (const layer of router.stack || []) {
        if (layer.route) {
            const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
            for (const m of Object.keys(layer.route.methods))
                for (const p of paths)
                    out.push({ key: `${m.toUpperCase()} ${prefix}${p}`, stack: layer.route.stack });
        } else if (layer.handle && Array.isArray(layer.handle.stack)) {
            const sub = String(layer.regexp && layer.regexp.source)
                .replace(/^\^/, '')
                .replace('\\/?(?=\\/|$)', '')
                .replace(/\\\//g, '/');
            routesOf(layer.handle, prefix + (sub === '\\/?' ? '' : sub), out);
        } else if (layer.handle && layer.handle.name === 'multerMiddleware') {
            out.push({ key: `USE ${prefix}`, stack: [layer] });
        }
    }
    return out;
}

describe('no upload slips past the guard', () => {
    test('the live routers expose exactly the guarded mounts listed here', () => {
        const guarded = routesOf(indexRouter, '')
            .filter((r) => r.stack.some((l) => l.handle && l.handle.uploadGuard))
            .map((r) => r.key)
            .sort();
        expect(guarded).toEqual(Object.keys(MOUNTS).sort());
    });

    test('no route or router.use carries a bare multer middleware', () => {
        const bare = routesOf(indexRouter, '')
            .filter((r) => r.stack.some((l) => l.handle && l.handle.name === 'multerMiddleware'))
            .map((r) => r.key);
        expect(bare).toEqual([]);
    });

    test('every multer instance in src/ has preservePath: true and is used only inside guardUpload()', () => {
        const files = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                const rel = `${dir}/${e.name}`;
                if (e.isDirectory()) walk(rel);
                else if (/\.js$/.test(e.name)) files.push(rel);
            }
        };
        walk('src');
        files.push('server.js');
        const problems = [];
        let instances = 0;
        for (const f of files) {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            if (!/require\(['"]multer['"]\)/.test(src)) continue;
            const builds = [
                ...src.matchAll(
                    /(?:const|let)\s+(\w+)\s*=\s*(?:multer|require\(['"]multer['"]\))\(\{/g
                ),
            ];
            // every call that builds an instance must be one of the named ones above
            const calls = (src.match(/(?:\bmulter|require\(['"]multer['"]\))\(\{/g) || []).length;
            if (calls !== builds.length)
                problems.push(`${f}: a multer instance built without a name to check`);
            for (const m of builds) {
                instances++;
                const name = m[1];
                // the options object: up to the matching closing brace
                let depth = 0;
                let end = m.index + m[0].length - 1;
                for (; end < src.length; end++) {
                    if (src[end] === '{') depth++;
                    else if (src[end] === '}' && --depth === 0) break;
                }
                const opts = src.slice(m.index, end);
                if (!/\bpreservePath:\s*true\b/.test(opts))
                    problems.push(`${f}: ${name} lacks preservePath: true`);
                const uses = [
                    ...src.matchAll(
                        new RegExp(`\\b${name}\\.(single|array|fields|any|none)\\(`, 'g')
                    ),
                ];
                if (!uses.length) problems.push(`${f}: ${name} is never used`);
                for (const u of uses) {
                    const before = src.slice(Math.max(0, u.index - 80), u.index);
                    if (!/guardUpload\(\s*$/.test(before))
                        problems.push(`${f}: ${name}.${u[1]}() outside guardUpload()`);
                }
            }
        }
        expect(problems).toEqual([]);
        expect(instances).toBeGreaterThanOrEqual(8);
    });
});
