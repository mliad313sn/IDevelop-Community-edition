'use strict';
/**
 * The weak-secret rule refused about 9 % of random 64-hex SESSION_SECRETs (any
 * "20\d\d" digit run), so the production boot threw and the service looped.
 * Random values must always pass; guessable ones must still be refused.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadConfig(env) {
    let cfg;
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        jest.isolateModules(() => {
            cfg = require('../../src/config/app');
        });
    } finally {
        for (const k of Object.keys(env)) delete process.env[k];
        Object.assign(process.env, saved);
    }
    return cfg;
}

describe('weak-secret rule', () => {
    const { isWeakSecret } = loadConfig({ NODE_ENV: 'development' });

    test('3 000 installer-style secrets (32 random bytes, hex) all pass', () => {
        let refused = 0;
        for (let i = 0; i < 3000; i++)
            if (isWeakSecret(crypto.randomBytes(32).toString('hex'))) refused++;
        expect(refused).toBe(0);
    });

    test('a hex secret containing a "year" passes (the boot loop)', () => {
        const s = '345427b513b2fb7ee9b70737eb38ede35786fe4b5e7b9bfd5b4ac2024a281bc4';
        expect(isWeakSecret(s)).toBe(false);
    });

    test('base64 values (openssl rand -base64 32, APP_KEY style) pass', () => {
        for (let i = 0; i < 500; i++) {
            expect(isWeakSecret(crypto.randomBytes(32).toString('base64'))).toBe(false);
            expect(isWeakSecret('base64:' + crypto.randomBytes(32).toString('base64'))).toBe(false);
        }
    });

    test('guessable values are still refused', () => {
        for (const s of [
            'short',
            'please-change-this-secret-now-1234',
            'my-default-session-secret-value-xyz',
            'changemechangemechangemechangeme12',
            'MySessionSecretForYear2024xyzab',
            'company-session-key-2025-production',
            'test test test test test test',
        ])
            expect({ s, weak: isWeakSecret(s) }).toEqual({ s, weak: true });
    });

    test('production boot accepts a "year" hex SESSION_SECRET and refuses a weak one', () => {
        expect(() =>
            loadConfig({
                NODE_ENV: 'production',
                SESSION_SECRET: '20' + '25' + crypto.randomBytes(30).toString('hex'),
            })
        ).not.toThrow();
        expect(() =>
            loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'please-change-me-2025-xxxxxxxx' })
        ).toThrow(/too weak/);
    });
});

describe('installer secrets', () => {
    test('New-Secret re-rolls a value with a "year" run, so older releases accept it too', () => {
        const ps = fs.readFileSync(
            path.join(__dirname, '..', '..', 'installer', 'Install-IDevelop.ps1'),
            'utf8'
        );
        const fn = ps.slice(ps.indexOf('function New-Secret('));
        const body = fn.slice(0, fn.indexOf('\n}\n'));
        expect(body).toMatch(/-notmatch '20\\d\\d'/);
        expect(body).toMatch(/RandomNumberGenerator/);
        expect(body).toMatch(/\$rng\.Dispose\(\)/);
    });
});
