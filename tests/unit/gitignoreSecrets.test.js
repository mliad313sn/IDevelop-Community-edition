'use strict';
/**
 * Certificates and private keys never enter the repository: the certs/ folder,
 * any .pfx (and the installer's .pfx.bak backup), .p12, .key and .pem anywhere.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const lines = fs
    .readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim());

test('.gitignore lists every certificate and key pattern', () => {
    for (const p of ['certs/', '*.pfx', '*.pfx.bak', '*.p12', '*.key', '*.pem'])
        expect(lines).toContain(p);
});

test('no certificate or key file is tracked', () => {
    let tracked = '';
    try {
        tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
    } catch (_) {
        return; // not a git checkout (release archive): nothing is tracked
    }
    const bad = tracked
        .split('\n')
        .filter((f) => /(^|\/)certs\/|\.(pfx|pfx\.bak|p12|key|pem)$/i.test(f));
    expect(bad).toEqual([]);
});
