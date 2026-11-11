'use strict';
/**
 * TRUST_PROXY validation, fail closed. GHSA-jqcg-44mw-7w3h: `::ffff:10.0.0.0/8`
 * or `::/1` compiled (proxy-addr < 2.0.8) into "every IPv4 address", so every
 * client was trusted and X-Forwarded-For spoofed req.ip.
 *
 * The relaxed (inline-script) CSP applies to an allow-list of real static
 * documents, not to any path ending in .html.
 */
const express = require('express');
const request = require('supertest');
const { parseTrustProxy } = require('../../src/middleware/httpHardening');

describe('the relaxed (inline-script) CSP only for the real static documents', () => {
    const { isStaticHtmlDoc } = require('../../src/middleware/httpHardening');
    test('allow-list: the user guides and the offline page', () => {
        for (const p of ['/user-guide.html', '/user-guide.en.html', '/offline.html'])
            expect(isStaticHtmlDoc(p)).toBe(true);
    });
    test('an app route ending in .html is NOT relaxed any more', () => {
        for (const p of [
            '/employees/42.html',
            '/dashboard.html',
            '/employee/self-assessment.html',
            '/USER-GUIDE.HTML',
            '/x/offline.html',
            '',
        ])
            expect(isStaticHtmlDoc(p)).toBe(false);
    });
    test('server.js uses the allow-list, not a suffix test', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../server.js'),
            'utf8'
        );
        expect(src).toMatch(/if \(httpHardening\.isStaticHtmlDoc\(req\.path\)\) \{/);
        expect(src).not.toMatch(/if \(\/\\\.html\$\/i\.test\(req\.path\)\)/);
    });
});

describe('TRUST_PROXY is validated at boot', () => {
    test('the settings that worked keep working', () => {
        expect(parseTrustProxy('')).toBe(false);
        expect(parseTrustProxy('1')).toBe(1);
        expect(parseTrustProxy('2')).toBe(2);
        expect(parseTrustProxy('loopback')).toBe('loopback');
        expect(parseTrustProxy('10.0.0.5')).toBe('10.0.0.5');
        expect(parseTrustProxy('10.0.0.0/8, 192.168.1.0/24')).toEqual([
            '10.0.0.0/8',
            '192.168.1.0/24',
        ]);
        expect(parseTrustProxy('::ffff:10.0.0.0/104')).toBe('::ffff:10.0.0.0/104');
        expect(parseTrustProxy('2001:db8::/32')).toBe('2001:db8::/32');
        expect(parseTrustProxy('loopback,uniquelocal')).toEqual(['loopback', 'uniquelocal']);
    });

    test.each([
        ['::ffff:10.0.0.0/8', /subnet needs a prefix/],
        ['loopback, ::ffff:0:0/16', /subnet needs a prefix/],
        ['0:0:0:0:0:ffff:a00:0/64', /subnet needs a prefix/],
        ['::/1', /zero leading bits/],
        ['::/64', /zero leading bits/],
        ['0.0.0.0/0', /every client/],
        ['proxy.example.com', /not an IP/],
        ['true', /not an IP/],
        ['10.0.0.0/abc', /prefix/],
    ])('%s is refused with a clear reason', (v, why) => {
        expect(() => parseTrustProxy(v)).toThrow(why);
    });

    test('server.js passes TRUST_PROXY through the validator', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../server.js'),
            'utf8'
        );
        expect(src).toMatch(
            /app\.set\('trust proxy', httpHardening\.parseTrustProxy\(process\.env\.TRUST_PROXY\)\)/
        );
    });

    test('with an accepted setting, a client outside the proxy range cannot spoof req.ip', async () => {
        const app = express();
        app.set('trust proxy', parseTrustProxy('10.0.0.0/8'));
        app.get('/ip', (req, res) => res.send(req.ip));
        const r = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.9');
        expect(r.text).not.toBe('203.0.113.9');
    });
});
