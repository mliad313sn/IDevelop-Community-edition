'use strict';
/**
 * Regression tests for the CodeQL triage of PR #14 (docs/SECURITY-AUDIT.md,
 * "Static analysis (CodeQL) triage"). One block per real fix:
 *   js/path-injection              upload temp paths are contained
 *   js/insecure-temporary-file     the Defender probe file is private
 *   js/loop-bound-injection        the SQL tokeniser only loops over strings
 *   js/unvalidated-dynamic-method-call  the login throttle table is own-keys only
 *   js/log-injection               a sign-in identifier cannot forge a log line
 *   js/missing-rate-limiting       the app-wide limiter answers 429 past its ceiling
 *   js/clear-text-logging          the key-rotation summary holds counts only
 *   js/insufficient-password-hash  (excluded as a false positive) compensating guard
 * The js/user-controlled-bypass fix is covered in accountLockoutPolicy.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const mockDb = {
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/services/LogService', () => ({ log: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/services/AdminSsoService', () => ({ isEnforced: () => false }));

const ROOT = path.resolve(__dirname, '../..');

describe('js/path-injection: upload temp paths are contained', () => {
    const { containedUploadPath } = require('../../src/utils/uploadTempPath');

    test('a multer temp file inside an upload directory resolves', () => {
        const p = path.join(ROOT, 'tmp', 'a1b2c3d4e5f6');
        expect(containedUploadPath(p)).toBe(p);
        const q = path.join(os.tmpdir(), 'abcdef');
        expect(containedUploadPath(q)).toBe(path.resolve(q));
    });

    test('traversal, sibling prefixes, the directory itself and non-strings are refused', () => {
        expect(containedUploadPath(path.join(ROOT, 'tmp', '..', 'server.js'))).toBeNull();
        expect(containedUploadPath(path.join(ROOT, 'tmp-evil', 'x'))).toBeNull();
        expect(containedUploadPath(path.join(ROOT, 'tmp'))).toBeNull();
        expect(containedUploadPath('/etc/passwd')).toBeNull();
        expect(containedUploadPath(path.join(ROOT, 'tmp', 'a\0b'))).toBeNull();
        expect(containedUploadPath(['x'])).toBeNull();
        expect(containedUploadPath({ toString: () => '/etc/passwd' })).toBeNull();
        expect(containedUploadPath('')).toBeNull();
    });

    test('checkFile never reads a path outside the upload directories', async () => {
        const { checkFile } = require('../../src/utils/fileSignature');
        const outside = path.join(ROOT, 'package.json');
        expect(await checkFile({ originalname: 'a.pdf', path: outside }, ['pdf'])).toEqual({
            ok: false,
            code: 'UPLOAD_UNREADABLE',
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-upload-'));
        const inside = path.join(dir, 'f');
        fs.writeFileSync(inside, '%PDF-1.4 x');
        try {
            expect((await checkFile({ originalname: 'a.pdf', path: inside }, ['pdf'])).ok).toBe(
                true
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a refused upload never deletes a file outside the upload directories', async () => {
        const { guardUpload } = require('../../src/middleware/uploadGuard');
        const unlink = jest.spyOn(fs, 'unlink').mockImplementation((p, cb) => cb && cb());
        try {
            const outside = path.join(ROOT, 'package.json');
            const fakeMulter = (req, res, cb) => {
                req.file = { originalname: 'a.exe', path: outside };
                cb();
            };
            const mw = guardUpload(fakeMulter, { kinds: ['pdf'], json: true });
            const res = { status: () => res, json: () => res };
            await new Promise((resolve) => {
                res.json = () => {
                    resolve();
                    return res;
                };
                mw({ headers: {}, get: () => null }, res, resolve);
            });
            expect(unlink).not.toHaveBeenCalled();
        } finally {
            unlink.mockRestore();
        }
    });
});

describe('js/insecure-temporary-file: the Defender probe file', () => {
    test('lives in a fresh private directory and is created exclusively, mode 0600', () => {
        const MalwareScanService = require('../../src/services/MalwareScanService');
        const { dir, file } = MalwareScanService.__test.makeProbeFile();
        try {
            expect(path.dirname(file)).toBe(dir);
            expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
            expect(path.basename(dir)).toMatch(/^app-av-probe-.{6}$/);
            if (process.platform !== 'win32') {
                expect(fs.statSync(file).mode & 0o777).toBe(0o600);
                expect(fs.statSync(dir).mode & 0o077).toBe(0);
            }
            // A second probe never reuses (or follows) an existing path.
            const again = MalwareScanService.__test.makeProbeFile();
            expect(again.dir).not.toBe(dir);
            fs.rmSync(again.dir, { recursive: true, force: true });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('js/loop-bound-injection: the SQL tokeniser', () => {
    const SqlConsoleService = require('../../src/services/SqlConsoleService');

    test('an object with a forged length is refused before any loop', () => {
        const t0 = Date.now();
        expect(() => SqlConsoleService._sqlTokens({ length: 1e12 })).toThrow(TypeError);
        expect(() => SqlConsoleService._sqlTokens(['select 1'])).toThrow(TypeError);
        expect(Date.now() - t0).toBeLessThan(1000);
    });

    test('a string still tokenises, and null is empty', () => {
        expect(SqlConsoleService._sqlTokens('select 1').length).toBeGreaterThan(0);
        expect(SqlConsoleService._sqlTokens(null)).toEqual([]);
    });

    test('the controller passes only a string body field to the service', async () => {
        const execute = jest.spyOn(SqlConsoleService, 'execute').mockResolvedValue({
            ok: true,
            results: [],
        });
        const ctrl = require('../../src/controllers/SqlConsoleController');
        const denied = jest.spyOn(ctrl, '_denied').mockReturnValue(false);
        try {
            const res = { status: () => res, json: () => res, set: () => res };
            await ctrl
                .execute(
                    {
                        body: { sql: { length: 1e12 }, dryRun: true },
                        user: { id: 1 },
                        ip: '127.0.0.1',
                        get: () => '',
                    },
                    res
                )
                .catch(() => {});
            expect(execute).toHaveBeenCalled();
            expect(execute.mock.calls[0][0]).toBe('');
        } finally {
            execute.mockRestore();
            denied.mockRestore();
        }
    });
});

describe('js/unvalidated-dynamic-method-call: the login throttle table', () => {
    const rl = require('../../src/middleware/rateLimiter');

    test.each(['/__proto__', '/constructor', '/toString', '/hasOwnProperty'])(
        '%s resolves to a fresh throttle, never an inherited member',
        async (p) => {
            rl._resetThrottlesForTests();
            const next = jest.fn();
            const res = { set: jest.fn(), on: jest.fn() };
            await rl.loginRateLimiter(
                { originalUrl: p, ip: '10.9.9.9', body: {}, get: () => '' },
                res,
                next
            );
            expect(next).toHaveBeenCalledWith();
        }
    );
});

describe('js/log-injection: sign-in identifiers in log lines', () => {
    const { logSafe } = require('../../src/middleware/rateLimiter');

    test('CR, LF, line separators and control characters become spaces', () => {
        const forged = 'ops\r\n[CRITICAL] admin "root" unlocked\u2028x\u0007';
        const out = logSafe(forged);
        expect(out).not.toMatch(/[\r\n\u2028\u2029]/);
        expect(out.includes(String.fromCharCode(7))).toBe(false);
        expect(out).toBe('ops  [CRITICAL] admin "root" unlocked x ');
        expect(out.startsWith('ops  [CRITICAL]')).toBe(true);
        expect(logSafe('x'.repeat(500))).toHaveLength(200);
        expect(logSafe(null)).toBe('');
    });
});

describe('js/missing-rate-limiting: the app-wide limiter', () => {
    const rateLimit = require('express-rate-limit');
    const { globalRateLimitOptions } = require('../../src/middleware/rateLimiter');

    function appWith(env, user) {
        const app = express();
        app.use((req, res, next) => {
            req.user = user || null;
            next();
        });
        app.use(rateLimit(globalRateLimitOptions(env)));
        app.get('/x', (req, res) => res.send('ok'));
        app.get('/api/v1/x', (req, res) => res.json({ ok: true }));
        return app;
    }

    test('defaults are generous: 600/min per account, 1200/min per address', () => {
        const o = globalRateLimitOptions({});
        expect(o.windowMs).toBe(60000);
        expect(o.limit({ user: { id: 1 } })).toBe(600);
        expect(o.limit({})).toBe(1200);
    });

    test('a signed-in person is counted per account, an anonymous one per address', () => {
        const o = globalRateLimitOptions({});
        expect(o.keyGenerator({ user: { id: 7, userType: 'admin' }, ip: '1.1.1.1' })).toBe(
            'u:admin:7'
        );
        expect(o.keyGenerator({ user: { id: 7, userType: 'employee' }, ip: '1.1.1.1' })).toBe(
            'u:person:7'
        );
        expect(o.keyGenerator({ ip: '1.1.1.1' })).toBe('ip:1.1.1.1');
    });

    test('past the ceiling a page answers 429 with Retry-After', async () => {
        const app = appWith({ GLOBAL_RATE_LIMIT: '2' }, { id: 5, userType: 'employee' });
        await request(app).get('/x').expect(200);
        await request(app).get('/x').expect(200);
        const r = await request(app).get('/x').set('Accept', 'text/html').expect(429);
        expect(r.headers['retry-after']).toBe('60');
    });

    test('an API caller past the ceiling gets JSON', async () => {
        const app = appWith({ GLOBAL_IP_RATE_LIMIT: '1' }, null);
        await request(app).get('/api/v1/x').expect(200);
        const r = await request(app).get('/api/v1/x').expect(429);
        expect(r.body.error).toMatch(/Too many requests/);
    });

    test('server.js mounts the limiter before every router', () => {
        const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const mount = src.indexOf(
            "app.use(require('express-rate-limit')(globalRateLimitOptions()))"
        );
        expect(mount).toBeGreaterThan(src.indexOf('app.use(passport.session())'));
        expect(mount).toBeLessThan(src.indexOf("app.post('/logout'"));
        expect(mount).toBeLessThan(src.indexOf("app.use('/api/v1', require('./src/api/v1'))"));
        expect(mount).toBeLessThan(src.indexOf("app.use('/', routes)"));
    });
});

describe('js/clear-text-logging: the key-rotation summary', () => {
    const rot = require('../../scripts/rotate-app-key');

    test('holds integers from the fixed store list only', () => {
        const counts = rot.rotationCounts(
            { done: 2, skipped: 'k3y-material' },
            {
                appSettings: { done: 1, skipped: 0, secret: 'nope' },
                hrisConnectors: { done: '4', skipped: -1 },
                'enc:v2:abc': { done: 9, skipped: 9 },
            }
        );
        expect(counts).toEqual({
            factors: { done: 2, skipped: 0 },
            stores: {
                appSettings: { done: 1, skipped: 0 },
                hrisConnectors: { done: 4, skipped: 0 },
            },
        });
        expect(rot.summary(counts)).toBe(
            '2 MFA secret(s) (0 skipped), 1 appSettings (0 skipped), 4 hrisConnectors (0 skipped)'
        );
    });

    test('every store rotateSecretBoxStores counts is in the summary list', () => {
        const src = fs.readFileSync(path.join(ROOT, 'scripts/rotate-app-key.js'), 'utf8');
        const used = [...src.matchAll(/await one\(\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
        expect(used.length).toBeGreaterThanOrEqual(6);
        for (const name of used) expect(rot.COUNTED_STORES).toContain(name);
    });
});

describe('js/insufficient-password-hash (excluded): compensating guards', () => {
    test('API keys carry 192 bits of CSPRNG randomness', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/services/ApiKeyService.js'), 'utf8');
        expect(src).toMatch(/const raw = 'ak_' \+ crypto\.randomBytes\(24\)\.toString\('hex'\);/);
    });

    test('no fast hash (createHash/createHmac) is ever applied to a password', () => {
        const files = [];
        const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith('.js')) files.push(p);
            }
        };
        walk(path.join(ROOT, 'src'));
        walk(path.join(ROOT, 'scripts'));
        files.push(path.join(ROOT, 'server.js'));
        const offenders = [];
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            for (const m of src.matchAll(/create(?:Hash|Hmac)\(/g)) {
                // The hashing chain: from the constructor to its digest().
                const end = src.indexOf('.digest(', m.index);
                const stmt = src.slice(
                    m.index,
                    end > m.index ? Math.min(end, m.index + 300) : m.index + 120
                );
                if (/pass(?:word|wd|phrase)|\bpwd\b/i.test(stmt))
                    offenders.push(`${path.relative(ROOT, f)}: ${stmt.split('\n')[0]}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
