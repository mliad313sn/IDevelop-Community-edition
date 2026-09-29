'use strict';
/**
 * IDevelop Community Edition must not carry any trace of the product it was
 * derived from: no former product or brand name, no former customer name, no
 * customer site name, no personal name or account name copied from a live
 * database.
 *
 * The guard scans the WHOLE repository (code, tests, docs, SQL, installer),
 * because a public repository publishes all of it. It must not re-publish the
 * very names it protects, so the denylist below holds SHA-256 digests of
 * lower-cased, accent-folded word tokens — never the words themselves. Every
 * word token in every text file is hashed and compared.
 *
 * To add a token: echo -n 'token' | sha256sum, append the digest.
 * A hit prints the file and the digest, not the word.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

const DENY = new Set([
    '6fd5a4d6a1c70fb9d78657ae5a584d60d7b110b06f7c7400f9cd3dde8074953c',
    '0a12324590cb45454bceb80726167f1ce5da9ca8748c3fcef5ce6d4b813b398c',
    'ad954419e17a945c068bcadcbaf2a33810c14c026b5fe9baf1af604c14f8ec7d',
    '2e72f8750391595b64404a7bfbd01ea97aa17106196c8528a139bdc6c338858a',
    '63b9602fa016ec26044ab6b168fabf276861c13aae741d3d3aa255808b23777a',
    '1cd38b20bf937895efffc247bd9b85abbacfc5bfe21bfc12a44efa47a1da2343',
    '738238ac002fae2ea55884d3d78da3e6175c71c93dfa10c937d38c308615ea13',
    '26245002a1775567f259092ae7470bf23c4cd0af541c6c06d5ae84d5489c7f33',
    'dec0f402d76ce9fade1bda3b2d4e7a8b8c7f82064a1960b6201ce91dd085da53',
    '399fef936c1d5767a9a5613883509021b65cd311f0be75a06f81710ece5fe9e3',
    '08f4550b96ad40a164b995b51eaaa7d3d6fd78f8b65c1eafde32f7bd1db56b0a',
    '5e84fa9e9dd57c17ee5e95f5ee442a7212036fd5b59b28d530753e6dd9389820',
    'cd4979dba049df65d203e7a5438a3b0f14fbb182aa5ed52695ad394a589ade95',
    '47d53a740132aa13f01cc9c04308bf015a068c4ac1d06e56882ad553300eb5f9',
    'ccafb803a73de50867ac5ccc53a65f32f41c4a22171f3c8a899da6919480cd7b',
    '2025a4cf3fe63ee28d6836fbb50c4b4baad9e6e7f08410da57cf97490fa5ca47',
    '2ddfb7191e3b6f3e208a42210a8b7bfeb23461fd865d7f8a3e66cee664807d7e',
    '8097a40d0018258716edfa73e5b213b8929394b5179b27fd424bd14c80c819dc',
    'b5ebb916ac6beac024f69dc0f5253db3155d86341ef67a91a0de338bc9b116b7',
    '341cc65fa8eba1b4eb840a33dbbc2f1d10564f7f26f4220ffeb9dea04619e4c3',
    'b16aad885854792872993ac31f087428f5deeeca76f63874d48096ead98af067',
    '2034a3c1a44561cf3fd3c79613469d5ee63c72148b1f8212cc671951ace7c5eb',
    '6c9936cbc2f2aa78f2a5fd8d2a317926bbdbaf56d3fe095f1f41458cf8d71b91',
    'fcf389908979352552db0969b3dcf78514f1a122b657dff384a9f42a976669c8',
    'c189a82530843e939c97041ae786d07c91989eb5368ba7f00325e25f1927f8b2',
    '6ab29f1f967528dc97a942e07fd1a73246d2f90c96ca67a3cbdad22d3d20812b',
    '8fcde35f3074b80637a62f360ff620fea55b549f8856bb828be2c0d6b8afca4f',
    'bd7cca8a417565887c328bab0baca2678a1191673dd3ae9444780deee48d8b3c',
    '90f231ef4ef721c5e4c2af30c1c3bbaca930444c737d7fb18361bd139c0364ca',
    '2c3d7269c7df3fcd8ee4b5934edc8306d93f99c73e43f5452f39dfee99480c67',
    '5da44deaf5d7dd4cf346ae5615b8644ec217972087eacb6349042d9c2abcf78a',
    '34201f678d4400aeef6b6789471d68e021b8cbd071d1fac812ca02d2bdc7cc19',
    '64d10a6869c3851f47945cae3025a7fc307d8df0aa69762ee6287b78abf577fc',
    'a067d9b75967c402f1d7865f672ef8663431b82a8931b78c462e4d74e643e892',
    'f364d4ade58c230576008c670265186055a064361f82ec661f909c400b6fc57d',
    'b822288b0b187717435aaebeea4062fd626b7e56e967cd6d0f4cd22d859d20f2',
    '7ed08692c9f41f23f1dca0c0efd832d80f1397accb3042cceaef1d4af6e44f7c',
]);

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'coverage',
    'logs',
    'tmp',
    'dist',
    'vendor',
    'test-results',
    'playwright-report',
]);
const SCAN_EXT = new Set([
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.json',
    '.sql',
    '.ejs',
    '.css',
    '.html',
    '.webmanifest',
    '.md',
    '.yml',
    '.yaml',
    '.txt',
    '.bat',
    '.cmd',
    '.ps1',
    '.psd1',
    '.psm1',
    '.cs',
    '.manifest',
    '.svg',
    '.example',
    '',
]);
// Generated from the public npm registry: third-party package names.
const isGenerated = (rel) => rel === 'package-lock.json';
// data: URIs are random base64 and can spell anything by chance.
const B64 = /data:[^;,]+;base64,[A-Za-z0-9+/=]+/g;

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
        } else if (SCAN_EXT.has(path.extname(e.name).toLowerCase())) {
            out.push(path.join(dir, e.name));
        }
    }
    return out;
}

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

describe('no legacy brand, customer, site or personal name anywhere in the repository', () => {
    test('every word token of every text file is clear of the hashed denylist', () => {
        const hits = [];
        for (const f of walk(ROOT)) {
            const rel = path.relative(ROOT, f);
            if (isGenerated(rel)) continue;
            // File NAMES are published too.
            const text = fold(rel + '\n' + fs.readFileSync(f, 'utf8').replace(B64, ''));
            const seen = new Set();
            for (const tok of text.split(/[^a-z0-9]+/)) {
                if (!tok || seen.has(tok)) continue;
                seen.add(tok);
                const h = sha(tok);
                if (DENY.has(h)) hits.push(`${rel} :: ${h.slice(0, 12)}`);
            }
        }
        expect(hits).toEqual([]);
    });

    test('the denylist is not vacuous (a known digest round-trips)', () => {
        expect(DENY.size).toBeGreaterThanOrEqual(30);
        expect(sha('idevelop')).toMatch(/^[0-9a-f]{64}$/);
        expect(DENY.has(sha('idevelop'))).toBe(false);
    });
});

describe('observable technical identifiers are product-neutral', () => {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

    test('cookie, metrics, API key prefix, service-worker cache and draft store', () => {
        expect(read('server.js')).toContain("'app.sid'");
        expect(read('server.js')).toMatch(/app_http_requests_total/);
        expect(read(path.join('src', 'api', 'v1', 'openapi.js'))).toContain("'app.sid'");
        expect(read(path.join('src', 'services', 'ApiKeyService.js'))).toContain("'ak_'");
        expect(read(path.join('public', 'service-worker.js'))).toMatch(/const CACHE = 'app-shell-/);
        expect(read(path.join('public', 'js', 'draft-store.js'))).toContain(
            "const DB_NAME = 'app_drafts'"
        );
    });

    test('every reader of the session cookie agrees on the name', () => {
        const readers = [
            'server.js',
            path.join('src', 'controllers', 'AuthController.js'),
            path.join('src', 'middleware', 'sessionActivity.js'),
            path.join('src', 'api', 'v1', 'openapi.js'),
        ];
        for (const r of readers) {
            expect({ file: r, ok: /SESSION_COOKIE_NAME \|\| 'app\.sid'/.test(read(r)) }).toEqual({
                file: r,
                ok: true,
            });
        }
    });

    test('the product identity is declared in one module', () => {
        const PRODUCT = require('../../src/config/product');
        expect(PRODUCT.name).toBe('IDevelop');
        expect(PRODUCT.fullName).toBe('IDevelop Community Edition');
        expect(require('../../src/utils/branding').DEFAULTS.appName).toBe(PRODUCT.name);
    });
});
