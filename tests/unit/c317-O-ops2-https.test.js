'use strict';
/**
 * 3.23.18 lane O-ops2 — S-05 HTTPS listener.
 *
 * Drives the SAME code path server.js uses (src/utils/tlsServer.js) with a
 * throwaway self-signed PFX generated here by openssl (Git for Windows ships
 * one). Asserts: HTTPS answers 200 with HSTS (max-age 15552000); the HTTP port
 * only redirects (301 for GET, 308 for POST); a wrong passphrase / missing file
 * refuses to boot (fail closed); without TLS_PFX_PATH the plain listener is
 * unchanged and sends no HSTS.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { execFileSync } = require('child_process');
const tlsServer = require('../../src/utils/tlsServer');

function findOpenssl() {
    const candidates = [
        process.env.OPENSSL_BIN,
        'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
        'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
        'openssl',
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            execFileSync(c, ['version'], { stdio: 'pipe', timeout: 15000 });
            return c;
        } catch (_) {
            /* next */
        }
    }
    return null;
}

const OPENSSL = findOpenssl();
const PASS = 'c317-o-ops2-test-pass';
let dir;
let pfxPath;

beforeAll(() => {
    if (!OPENSSL) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c317-o-tls-'));
    const key = path.join(dir, 'k.pem');
    const crt = path.join(dir, 'c.pem');
    pfxPath = path.join(dir, 'server.pfx');
    const run = (args) => execFileSync(OPENSSL, args, { stdio: 'pipe', timeout: 60000 });
    run([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        crt,
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
    ]);
    run([
        'pkcs12',
        '-export',
        '-out',
        pfxPath,
        '-inkey',
        key,
        '-in',
        crt,
        '-passout',
        `pass:${PASS}`,
    ]);
}, 90000);

afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function buildApp() {
    const app = express();
    app.use(tlsServer.hstsMiddleware());
    app.get('/ping', (req, res) => res.status(200).send(req.secure ? 'secure' : 'plain'));
    return app;
}

function get(mod, opts) {
    return new Promise((resolve, reject) => {
        const req = mod.request(opts, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

const closeAll = (...servers) =>
    Promise.all(servers.filter(Boolean).map((s) => new Promise((r) => s.close(() => r()))));

const withTls = OPENSSL ? test : test.skip;
if (!OPENSSL) {
    // eslint-disable-next-line no-console
    console.warn(
        'c317-O-ops2-https: openssl not found - the HTTPS round-trip tests are SKIPPED (set OPENSSL_BIN).'
    );
}

describe('S-05 — HTTPS listener with an installer-style PFX', () => {
    withTls(
        'HTTPS answers 200 with HSTS; HTTP redirects to HTTPS (301 GET, 308 POST)',
        async () => {
            const env = { TLS_PFX_PATH: pfxPath, TLS_PFX_PASSPHRASE: PASS, HTTPS_PORT: '0' };
            const started = await tlsServer.startListeners(buildApp(), {
                port: 0,
                env,
                host: '127.0.0.1',
            });
            try {
                expect(started.mode).toBe('https');
                const hp = started.httpsPort;
                const rp = started.redirectServer.address().port;

                const s = await get(https, {
                    host: '127.0.0.1',
                    port: hp,
                    path: '/ping',
                    rejectUnauthorized: false,
                });
                expect(s.status).toBe(200);
                expect(s.body).toBe('secure');
                expect(s.headers['strict-transport-security']).toBe('max-age=15552000');

                const r = await get(http, { host: '127.0.0.1', port: rp, path: '/ping?x=1' });
                expect(r.status).toBe(301);
                expect(r.headers.location).toBe(`https://127.0.0.1:${hp}/ping?x=1`);
                expect(r.headers['strict-transport-security']).toBeUndefined();

                const p = await get(http, {
                    host: '127.0.0.1',
                    port: rp,
                    path: '/login',
                    method: 'POST',
                });
                expect(p.status).toBe(308);
                expect(p.headers.location).toBe(`https://127.0.0.1:${hp}/login`);
            } finally {
                await closeAll(started.server, started.redirectServer);
            }
        },
        30000
    );

    withTls(
        'an https APP_BASE_URL decides the redirect host (a forged Host header does not)',
        async () => {
            const env = {
                TLS_PFX_PATH: pfxPath,
                TLS_PFX_PASSPHRASE: PASS,
                HTTPS_PORT: '0',
                APP_BASE_URL: 'https://hr-box.corp.example:3443',
            };
            const started = await tlsServer.startListeners(buildApp(), {
                port: 0,
                env,
                host: '127.0.0.1',
            });
            try {
                const r = await get(http, {
                    host: '127.0.0.1',
                    port: started.redirectServer.address().port,
                    path: '/x',
                    headers: { Host: 'evil.example' },
                });
                expect(r.status).toBe(301);
                expect(r.headers.location).toBe('https://hr-box.corp.example:3443/x');
            } finally {
                await closeAll(started.server, started.redirectServer);
            }
        },
        30000
    );

    withTls(
        'fails CLOSED: a wrong passphrase refuses to boot instead of serving clear HTTP',
        () => {
            expect(() =>
                tlsServer.resolveTlsOptions({ TLS_PFX_PATH: pfxPath, TLS_PFX_PASSPHRASE: 'wrong' })
            ).toThrow(/could not be loaded/);
        }
    );
});

describe('S-05 — without TLS_PFX_PATH nothing changes', () => {
    test('a missing PFX file refuses to boot', () => {
        expect(() =>
            tlsServer.resolveTlsOptions({ TLS_PFX_PATH: path.join(os.tmpdir(), 'nope-c317.pfx') })
        ).toThrow(/cannot be read/);
    });

    test('plain HTTP listener, 200, no HSTS on clear HTTP', async () => {
        const started = await tlsServer.startListeners(buildApp(), {
            port: 0,
            env: {},
            host: '127.0.0.1',
        });
        try {
            expect(started.mode).toBe('http');
            expect(started.redirectServer).toBeNull();
            const r = await get(http, {
                host: '127.0.0.1',
                port: started.server.address().port,
                path: '/ping',
            });
            expect(r.status).toBe(200);
            expect(r.body).toBe('plain');
            expect(r.headers['strict-transport-security']).toBeUndefined();
        } finally {
            await closeAll(started.server);
        }
    });

    test('redirect target never carries a path/userinfo smuggled in the Host header', () => {
        const t = tlsServer.redirectTarget(
            { headers: { host: 'a.example@evil.example/x' }, url: '/p' },
            { httpsPort: 3443 }
        );
        expect(t).toBe('https://localhost:3443/p');
        expect(
            tlsServer.redirectTarget(
                { headers: { host: 'box:3000' }, url: '/p' },
                { httpsPort: 3443 }
            )
        ).toBe('https://box:3443/p');
    });

    test('server.js boots through tlsServer (HSTS no longer from helmet on clear HTTP)', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
        expect(src).toMatch(/tlsServer\.startListeners\(\s*app/);
        expect(src).toMatch(/strictTransportSecurity:\s*false/);
        expect(src).toMatch(/app\.use\(\s*tlsServer\.hstsMiddleware\(\)\s*\)/);
    });
});
