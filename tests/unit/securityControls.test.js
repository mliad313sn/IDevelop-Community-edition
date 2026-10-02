'use strict';
/**
 * Behavioural checks behind the About page's security claims that had no
 * dedicated suite: secrets encrypted at rest, webhook SSRF refusal, and a
 * container that runs unprivileged and refuses to start without secrets.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

describe('secrets at rest (secretBox, AES-256-GCM)', () => {
    const OLD = process.env.APP_KEY;
    beforeAll(() => {
        process.env.APP_KEY = 'test-app-key-0123456789abcdef0123456789abcdef';
    });
    afterAll(() => {
        if (OLD === undefined) delete process.env.APP_KEY;
        else process.env.APP_KEY = OLD;
    });
    const box = () => require('../../src/utils/secretBox');

    test('round-trips, never stores the clear text, uses a fresh IV each time', () => {
        const a = box().encrypt('smtp-password');
        const b = box().encrypt('smtp-password');
        // secretBox v2 (enc:v2:<purpose>:iv:tag:ct); v1 is read-only.
        expect(a.startsWith('enc:v2:')).toBe(true);
        expect(a).not.toContain('smtp-password');
        expect(a).not.toBe(b);
        expect(box().decrypt(a)).toBe('smtp-password');
    });

    test('a tampered ciphertext or a truncated tag is refused', () => {
        const v = box().encrypt('secret');
        // v2 layout: enc:v2:<purpose>:<iv>:<tag>:<ct>
        const [p1, p2, purpose, iv, tag, ct] = v.split(':');
        const flipped = Buffer.from(ct, 'base64');
        flipped[0] ^= 0xff;
        expect(() =>
            box().decrypt([p1, p2, purpose, iv, tag, flipped.toString('base64')].join(':'))
        ).toThrow();
        const shortTag = Buffer.from(tag, 'base64').subarray(0, 8).toString('base64');
        expect(() => box().decrypt([p1, p2, purpose, iv, shortTag, ct].join(':'))).toThrow(
            /tag length/
        );
    });

    test('another key cannot decrypt', () => {
        const v = box().encrypt('secret');
        process.env.APP_KEY = 'a-different-key-0123456789abcdef0123456789';
        expect(() => box().decrypt(v)).toThrow();
        process.env.APP_KEY = 'test-app-key-0123456789abcdef0123456789abcdef';
    });
});

describe('webhooks refuse internal targets (SSRF)', () => {
    const Hook = require('../../src/services/WebhookService');
    test.each([
        'http://localhost/hook',
        'http://127.0.0.1:5432/',
        'http://10.0.0.5/x',
        'http://192.168.1.10/x',
        'http://172.16.0.1/x',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/x',
        'http://db.internal/x',
        'file:///etc/passwd',
    ])('%s is rejected before anything is stored', async (url) => {
        await expect(Hook.subscribe({ label: 'x', url })).rejects.toThrow();
    });
});

describe('container', () => {
    const root = path.join(__dirname, '../..');
    test('the image runs as an unprivileged user', () => {
        const df = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
        expect(df).toMatch(/^USER (?!root)\w+/m);
    });
    test('Compose refuses to start without real secrets', () => {
        const dc = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
        for (const v of ['DB_PASSWORD', 'SESSION_SECRET', 'APP_KEY']) {
            expect(dc).toMatch(new RegExp(`\\$\\{${v}:\\?`));
        }
    });
});
