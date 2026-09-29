'use strict';

/**
 * Regression tests for the 2026-09-29 security audit (docs/SECURITY-AUDIT.md).
 * One describe block per finding id (SA-xx). Pure unit tests: the database is
 * mocked, network calls stay on the loopback interface.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const dns = require('dns');
const ejs = require('ejs');

const mockDb = {
    all: jest.fn(async () => []),
    get: jest.fn(async () => null),
    run: jest.fn(async () => ({ changes: 0 })),
};
jest.mock('../../src/config/database', () => mockDb);

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** i18next-like interpolation with escapeValue:false — the production setting. */
function fakeT(catalogue) {
    return (key, opts = {}) =>
        String(catalogue[key] || key).replace(/{{(\w+)}}/g, (_, k) =>
            opts[k] === undefined ? '' : String(opts[k])
        );
}

const XSS = '<img src=x onerror=alert(1)>';

// ---------------------------------------------------------------------------
describe('SA-01 temporary passwords come from the CSPRNG', () => {
    test('generatePassword never calls Math.random and draws via crypto.randomInt', () => {
        const mathSpy = jest.spyOn(Math, 'random');
        const cryptoSpy = jest.spyOn(crypto, 'randomInt');
        const { generatePassword } = require('../../src/utils/credentialGenerator');
        const pw = generatePassword();
        expect(pw.length).toBeGreaterThanOrEqual(12);
        expect(mathSpy).not.toHaveBeenCalled();
        expect(cryptoSpy).toHaveBeenCalled();
    });

    test('the module source no longer uses Math.random for a draw', () => {
        const src = read('src/utils/credentialGenerator.js').replace(/\/\/.*$/gm, '');
        expect(src).not.toMatch(/Math\.random\s*\(/);
    });
});

// ---------------------------------------------------------------------------
describe('SA-02 admin username is escaped inside the raw "linked admin" sentence', () => {
    const view = read('views/pages/employees/show.ejs');
    const lines = view.split('\n');
    const helper = lines.find((l) => l.includes('var _ehAcc = function'));
    const sentence = lines.find((l) => l.includes("__('admin:acc_id_admin_has'"));

    test('the template passes escaped values into the unescaped tag', () => {
        expect(helper).toBeTruthy();
        expect(sentence).toMatch(/username: _ehAcc\(linkedAdmin\.username\)/);
    });

    test('a hostile username renders as text, not markup', () => {
        const html = ejs.render(`${helper}\n${sentence}`, {
            __: fakeT({
                'admin:acc_id_admin_has':
                    'Has <strong>{{role}}</strong> via <a href="/admins/{{id}}"><code>{{username}}</code></a>.',
            }),
            enumLabel: (_k, v) => v,
            linkedAdmin: { role: 'localadmin', username: XSS, id: 7, isActive: true },
        });
        expect(html).toContain('<strong>localadmin</strong>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<img');
    });
});

// ---------------------------------------------------------------------------
describe('SA-03 access-review reviewer name cannot close the script element', () => {
    test('the "by" label goes through the json-script partial', () => {
        const file = path.join(ROOT, 'views/pages/admin/access-review.ejs');
        const line = fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .find((l) => /^\s*by: /.test(l));
        expect(line).toMatch(/json-script/);
        const out = ejs.render(
            line,
            {
                __: fakeT({ 'admin:ar_by': 'by {{who}}' }),
                user: { username: `</script>${XSS}` },
            },
            { filename: file }
        );
        expect(out).not.toMatch(/<\/script/i);
        expect(out).not.toContain('<img');
        expect(out).toContain('\\u003c/script>');
    });
});

// ---------------------------------------------------------------------------
describe('SA-04 webhook SSRF guard', () => {
    const W = require('../../src/services/WebhookService');
    const saved = process.env.WEBHOOK_ALLOW_PRIVATE;
    afterEach(() => {
        if (saved === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE;
        else process.env.WEBHOOK_ALLOW_PRIVATE = saved;
    });

    test.each([
        'http://[::ffff:127.0.0.1]/hook',
        'http://[::ffff:169.254.169.254]/latest/meta-data',
        'http://100.64.0.1/hook',
        'http://0.0.0.1/hook',
        'http://2130706433/hook',
        'http://[::1]/hook',
        'http://metadata.localhost/hook',
        'http://user:pass@hooks.example.org/hook',
    ])('refuses %s at subscription time', (url) => {
        expect(() => W.assertSafeWebhookUrl(url)).toThrow();
    });

    test('accepts a public https receiver', () => {
        expect(() =>
            W.assertSafeWebhookUrl('https://hooks.slack.com/services/T/B/X')
        ).not.toThrow();
    });

    test('a NAME that resolves to a private address is refused at delivery', async () => {
        jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.0.0.8', family: 4 }]);
        await expect(W.resolveTarget('https://innocent.example.org/hook')).rejects.toThrow(
            /private/
        );
    });

    test('emit() records blocked-url instead of posting to a privately resolving name', async () => {
        jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
        mockDb.all.mockResolvedValueOnce([
            { id: 9, url: 'http://127.0.0.1.nip.io/x', events: ['*'], format: 'json' },
        ]);
        mockDb.run.mockClear();
        const out = await W.emit('test.ping', {});
        expect(out.delivered).toBe(0);
        expect(mockDb.run).toHaveBeenCalledWith(expect.stringMatching(/last_status/), [
            'blocked-url',
            9,
        ]);
    });

    describe('delivery against a local receiver (private explicitly allowed)', () => {
        let a;
        let b;
        let bHits = 0;
        let aHits = 0;
        beforeAll(async () => {
            b = http.createServer((req, res) => {
                bHits++;
                res.end('ok');
            });
            await new Promise((r) => b.listen(0, '127.0.0.1', r));
            a = http.createServer((req, res) => {
                aHits++;
                req.resume();
                if (req.url === '/redirect') {
                    res.writeHead(302, { Location: `http://127.0.0.1:${b.address().port}/x` });
                    return res.end();
                }
                res.writeHead(204);
                res.end();
            });
            await new Promise((r) => a.listen(0, '127.0.0.1', r));
        });
        afterAll(async () => {
            await new Promise((r) => a.close(r));
            await new Promise((r) => b.close(r));
        });

        test('a 3xx is reported, never followed', async () => {
            process.env.WEBHOOK_ALLOW_PRIVATE = '1';
            const r = await W.deliver(`http://127.0.0.1:${a.address().port}/redirect`, '{}', {
                'Content-Type': 'application/json',
            });
            expect(r).toEqual({ ok: false, status: 302 });
            expect(bHits).toBe(0);
        });

        test('the connection is pinned to the address that was checked', async () => {
            process.env.WEBHOOK_ALLOW_PRIVATE = '1';
            jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
                { address: '127.0.0.1', family: 4 },
            ]);
            const before = aHits;
            const r = await W.deliver(`http://receiver.invalid:${a.address().port}/hook`, '{}', {});
            expect(r).toEqual({ ok: true, status: 204 });
            expect(aHits).toBe(before + 1);
        });
    });
});

// ---------------------------------------------------------------------------
describe('SA-05 LMS base URL guard covers every spelling of loopback/metadata', () => {
    const LmsService = require('../../src/services/LmsService');
    test.each([
        'http://[::ffff:169.254.169.254]/',
        'http://[::ffff:127.0.0.1]/',
        'http://0.0.0.0/',
        'http://0.1.2.3/',
        'http://127.1/',
        'http://[::1]/',
        'http://[fe80::1]/',
        'http://lms.localhost/',
    ])('refuses %s', (u) => {
        expect(() => LmsService._assertSafeLmsBaseUrl(u)).toThrow();
    });
    test.each(['http://10.0.0.5/lms', 'https://acme.csod.com', 'https://192.168.1.20:8443'])(
        'still allows an on-prem or SaaS LMS: %s',
        (u) => {
            expect(() => LmsService._assertSafeLmsBaseUrl(u)).not.toThrow();
        }
    );
});

// ---------------------------------------------------------------------------
describe('SA-06 Cornerstone pagination never follows a foreign next link', () => {
    test('the bearer token is not sent to another origin', async () => {
        const { getConnector } = require('../../src/integrations/lms');
        const calls = [];
        const res = (status, obj) => ({
            ok: status >= 200 && status < 300,
            status,
            text: async () => JSON.stringify(obj),
        });
        const c = getConnector('cornerstone', {
            base_url: 'https://acme-sa06.csod.com',
            auth_config: { client_id: 'sa06', client_secret: 's' },
            _fetch: async (url, opts) => {
                calls.push({ url: String(url), auth: opts.headers && opts.headers.Authorization });
                if (String(url).includes('/oauth2/token'))
                    return res(200, { access_token: 'TOK', expires_in: 3600 });
                return res(200, {
                    value: [{ lo_object_id: 'LO-1', lo_title: 'Course' }],
                    '@odata.nextLink': 'https://attacker.example/steal?skip=1',
                });
            },
        });
        const cat = await c.fetchCatalog();
        expect(cat).toHaveLength(1);
        expect(calls.some((x) => x.url.includes('attacker.example'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('SA-07 certification import errors are escaped before innerHTML', () => {
    test('errHtml maps every cell-derived value through the escaper', () => {
        const view = read('views/pages/compliance/index.ejs');
        const line = view.split('\n').find((l) => l.includes('var errHtml ='));
        expect(line).toMatch(/escH\(e\.error\)/);
        expect(line).toMatch(/escH\(e\.row\)/);
    });
});

// ---------------------------------------------------------------------------
describe('SA-08 safeBackUrl refuses protocol-relative paths', () => {
    const { safeBackUrl } = require('../../src/utils/safeRedirect');
    const req = (referer, host = 'app.example') => ({
        get: (h) => (h.toLowerCase() === 'referer' ? referer : host),
    });
    test('//evil path on the same host falls back', () => {
        expect(safeBackUrl(req('https://app.example//evil.example/x'), '/home')).toBe('/home');
    });
    test('a normal same-origin path is kept (relative)', () => {
        expect(safeBackUrl(req('https://app.example/employees?page=2'), '/home')).toBe(
            '/employees?page=2'
        );
    });
    test('a foreign host falls back', () => {
        expect(safeBackUrl(req('https://evil.example/admin/notifications'), '/home')).toBe('/home');
    });
    test('notification retry no longer echoes a foreign Referer', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        jest.doMock('../../src/services/NotificationAdminService', () => ({
            retry: async () => null,
        }));
        const ctl = require('../../src/controllers/NotificationAdminController');
        const redirect = jest.fn();
        await ctl.retry(
            {
                params: { id: '1' },
                flash: () => {},
                get: (h) =>
                    h.toLowerCase() === 'referer'
                        ? 'https://evil.example/admin/notifications'
                        : 'app.example',
            },
            { redirect }
        );
        expect(redirect).toHaveBeenCalledWith('/admin/notifications');
    });
});

// ---------------------------------------------------------------------------
describe('SA-09 zip-bomb guard for uploaded workbooks', () => {
    const { assertSafeXlsxBuffer, assertSafeXlsxFile } = require('../../src/utils/importGuards');

    /** Minimal ZIP writer (deflate). `declared` lets a test LIE about the size. */
    function makeZip(entries) {
        const locals = [];
        const centrals = [];
        let offset = 0;
        for (const e of entries) {
            const name = Buffer.from(e.name);
            const comp = zlib.deflateRawSync(e.data);
            const usize = e.declared != null ? e.declared : e.data.length;
            const lh = Buffer.alloc(30);
            lh.writeUInt32LE(0x04034b50, 0);
            lh.writeUInt16LE(20, 4);
            lh.writeUInt16LE(8, 8);
            lh.writeUInt32LE(comp.length, 18);
            lh.writeUInt32LE(usize, 22);
            lh.writeUInt16LE(name.length, 26);
            locals.push(lh, name, comp);
            const ch = Buffer.alloc(46);
            ch.writeUInt32LE(0x02014b50, 0);
            ch.writeUInt16LE(20, 4);
            ch.writeUInt16LE(20, 6);
            ch.writeUInt16LE(8, 10);
            ch.writeUInt32LE(comp.length, 20);
            ch.writeUInt32LE(usize, 24);
            ch.writeUInt16LE(name.length, 28);
            ch.writeUInt32LE(offset, 42);
            centrals.push(ch, name);
            offset += 30 + name.length + comp.length;
        }
        const cd = Buffer.concat(centrals);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(entries.length, 8);
        eocd.writeUInt16LE(entries.length, 10);
        eocd.writeUInt32LE(cd.length, 12);
        eocd.writeUInt32LE(offset, 16);
        return Buffer.concat([...locals, cd, eocd]);
    }

    test('a genuine ExcelJS workbook passes', async () => {
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        wb.addWorksheet('Employees').addRow(['A-1', 'Ada', 'Lovelace']);
        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        expect(assertSafeXlsxBuffer(buf).entries).toBeGreaterThan(3);
    });

    test('an entry that inflates past the cap is refused', () => {
        const bomb = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(4e6) }]);
        expect(bomb.length).toBeLessThan(10000); // tiny on the wire…
        expect(() => assertSafeXlsxBuffer(bomb, { maxTotalBytes: 1e6 })).toThrow(/exceeds/);
    });

    test('a header that LIES about the size is caught by actually inflating', () => {
        const liar = makeZip([
            { name: 'xl/sharedStrings.xml', data: Buffer.alloc(4e6), declared: 100 },
        ]);
        expect(() => assertSafeXlsxBuffer(liar, { maxTotalBytes: 1e6 })).toThrow(/exceeds/);
    });

    test('too many entries and non-ZIP input are refused', () => {
        const many = makeZip(
            Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') }))
        );
        expect(() => assertSafeXlsxBuffer(many, { maxEntries: 10 })).toThrow(/too many/);
        expect(() => assertSafeXlsxBuffer(Buffer.from('not a zip at all, clearly'))).toThrow(
            /not a ZIP/
        );
    });

    test('the refusal is a 400 the error handler may show', () => {
        const tmp = path.join(require('os').tmpdir(), `sa09-${process.pid}.xlsx`);
        fs.writeFileSync(tmp, makeZip([{ name: 'a.xml', data: Buffer.alloc(2e6) }]));
        try {
            assertSafeXlsxFile(tmp, { maxTotalBytes: 1e5 });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e.status).toBe(400);
            expect(e.expose).toBe(true);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    test('every ExcelJS read of an upload is preceded by the guard', () => {
        const files = [
            'src/controllers/DataManagementController.js',
            'src/services/BulkDataService.js',
            'src/services/CertificationService.js',
            'src/services/SkillMatrixWorkbookService.js',
            'src/services/UnifiedImportService.js',
            'src/services/SqlConsoleService.js',
            'src/services/SkillDescriptionService.js',
        ];
        for (const f of files) {
            const lines = read(f).split('\n');
            lines.forEach((l, i) => {
                if (/\.xlsx\.(readFile|load)\(/.test(l)) {
                    expect(`${f}:${i + 1} ${lines[i - 1]}`).toMatch(/assertSafeXlsx(File|Buffer)/);
                }
            });
        }
    });
});

// ---------------------------------------------------------------------------
describe('SA-10 container build context excludes secrets', () => {
    test('.dockerignore keeps .env, keys and host node_modules out of the image', () => {
        const di = read('.dockerignore')
            .split('\n')
            .map((l) => l.trim());
        for (const p of ['.env', 'certs/', '*.pem', '*.pfx', 'node_modules/', '.git/', 'uploads/'])
            expect(di).toContain(p);
        expect(di).toContain('!.env.example');
    });
});

// ---------------------------------------------------------------------------
describe('SA-11 dashboard employee list page size is bounded', () => {
    test('pageSize and page are clamped before reaching the service', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        const getEmployeeList = jest.fn(async () => ({ rows: [] }));
        jest.doMock('../../src/services/DashboardService', () => ({ getEmployeeList }));
        const DashboardController = require('../../src/controllers/DashboardController');
        const ctl = new DashboardController();
        const res = { json: jest.fn(), status: jest.fn(() => res) };
        await ctl.getEmployeeList(
            { query: { pageSize: '100000000', page: '-4' }, user: { userType: 'admin' } },
            res
        );
        const opts = getEmployeeList.mock.calls[0][1];
        expect(opts.pageSize).toBe(200);
        expect(opts.page).toBe(1);
    });
});

// ---------------------------------------------------------------------------
describe('SA-12 a superadmin gate needs userType admin, not just a role field', () => {
    test('rbacMiddleware does not grant unrestricted scope to a person principal', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => mockDb);
        jest.doMock('../../src/models/EmployeeModel', () => ({
            findGovernedIds: async () => [42],
        }));
        const { rbacMiddleware } = require('../../src/middleware/rbac');
        const req = { user: { id: 5, userType: 'manager', role: 'superadmin' } };
        await rbacMiddleware(req, {}, () => {});
        expect(req.scope.employeeIds).toEqual([42]);
    });

    test('route/controller gates use RBACService.isSuperAdmin', () => {
        expect(read('src/routes/v2-capability.js')).toMatch(
            /const superOnly = \(req, res, next\) =>\s+RBACService\.isSuperAdmin\(req\.user\)/
        );
        expect(read('src/controllers/SqlConsoleController.js')).toMatch(
            /if \(RBACService\.isSuperAdmin\(req\.user\)\) return false;/
        );
        expect(read('src/controllers/SsoSettingsController.js')).not.toMatch(
            /req\.user && req\.user\.role === 'superadmin'/
        );
    });
});

// ---------------------------------------------------------------------------
describe('SA-13 vulnerable dependency lines are gone', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const ver = (name) => lock.packages[`node_modules/${name}`].version;
    const major = (v) => Number(String(v).split('.')[0]);
    test('nodemailer >= 10.0.12 (GHSA-6vj9-mwq6-2f5v, GHSA-8vvx-rff5-p5rq)', () => {
        const [M, m, p] = ver('nodemailer').split('.').map(Number);
        expect(M > 10 || (M === 10 && (m > 0 || p >= 12))).toBe(true);
    });
    test('multer is on the maintained 2.x line (1.x is deprecated as vulnerable)', () => {
        expect(major(ver('multer'))).toBeGreaterThanOrEqual(2);
    });
});
