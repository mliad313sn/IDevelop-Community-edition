'use strict';

/**
 * build-offline-cache.js — RELEASE TOOLING, run by installer/Build-Package.ps1
 * on the build machine. It never ships (Build-Package lists it as dev-only).
 *
 * Builds the npm cache the package carries (<package>\npm-cache), so the
 * installer can run `npm ci --offline --cache <package>\npm-cache` on a server
 * that has no access to the npm registry (filtered egress, air gap): installing
 * and upgrading then need no network at all.
 *
 * What goes in: exactly the PRODUCTION entries of the shipped package-lock.json
 * (dev, linked and bundled entries excluded), each tarball stored under its
 * lockfile `integrity` (sha512). npm reads a tarball from the cache by that
 * digest, so `npm ci` still installs exactly the audited versions and still
 * checks every byte against the lockfile: nothing is resolved again.
 *
 * Where the bytes come from, in order: the build machine's own npm cache (by
 * digest: the tarballs `npm ci` already checked there), else a download of the
 * lockfile's `resolved` URL with curl. Every tarball is checked against its
 * integrity BEFORE it is written; a mismatch fails the build.
 *
 * usage: node scripts/build-offline-cache.js --root <app dir with package-lock.json>
 *                                            --out <cache dir> [--from <npm cache dir>]
 * exit 0 = every required tarball cached; 1 = something missing (listed), or an
 * integrity mismatch. No new dependency: cacache and ssri are the copies bundled
 * with npm itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** A module bundled with npm (Windows: <node dir>\node_modules\npm; elsewhere <prefix>/lib/node_modules/npm). */
function npmModule(name) {
    const bin = path.dirname(process.execPath);
    const roots = [
        path.join(bin, 'node_modules', 'npm'),
        path.join(bin, '..', 'lib', 'node_modules', 'npm'),
    ];
    return require(require.resolve(name, { paths: roots }));
}

function parseArgs(argv) {
    const f = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const n = argv[i + 1];
        if (n !== undefined && !n.startsWith('--')) {
            f[argv[i].slice(2)] = n;
            i++;
        } else f[argv[i].slice(2)] = true;
    }
    return f;
}

/** The production tarballs of a v2/v3 lockfile, one per integrity (pure). */
function productionTarballs(lock) {
    const out = [];
    const seen = new Set();
    for (const [key, p] of Object.entries((lock && lock.packages) || {})) {
        if (!key || p.dev || p.link || p.inBundle) continue;
        if (!p.resolved || !p.integrity || !/^https?:/.test(p.resolved)) continue;
        if (seen.has(p.integrity)) continue;
        seen.add(p.integrity);
        out.push({
            name: key.replace(/^.*node_modules\//, ''),
            version: p.version,
            resolved: p.resolved,
            integrity: p.integrity,
            optional: !!p.optional,
        });
    }
    return out;
}

function defaultNpmCache() {
    if (process.env.npm_config_cache) return process.env.npm_config_cache;
    if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'npm-cache');
    return path.join(os.homedir(), '.npm');
}

function download(url) {
    const tmp = path.join(os.tmpdir(), `idv-oc-${process.pid}-${Date.now()}.tgz`);
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    try {
        execFileSync(curl, ['-sSfL', '--retry', '2', '-o', tmp, url], {
            windowsHide: true,
            timeout: 120 * 1000,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        return fs.readFileSync(tmp);
    } finally {
        try {
            fs.unlinkSync(tmp);
        } catch (_) {
            /* ignore */
        }
    }
}

async function build({ root, out, from, fetch = download }) {
    const cacache = npmModule('cacache');
    const ssri = npmModule('ssri');
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const list = productionTarballs(lock);
    const srcCache = path.join(from || defaultNpmCache(), '_cacache');
    const dstCache = path.join(out, '_cacache');
    fs.mkdirSync(dstCache, { recursive: true });
    const res = { total: list.length, fromCache: 0, downloaded: 0, missing: [], bytes: 0 };
    for (const t of list) {
        let data = null;
        try {
            data = await cacache.get.byDigest(srcCache, t.integrity);
        } catch (_) {
            data = null;
        }
        if (data) res.fromCache++;
        else {
            try {
                data = fetch(t.resolved);
                res.downloaded++;
            } catch (_) {
                res.missing.push(`${t.name}@${t.version}${t.optional ? ' (optional)' : ''}`);
                continue;
            }
        }
        if (!ssri.checkData(data, t.integrity)) {
            throw new Error(`integrity mismatch for ${t.name}@${t.version}: refusing to cache it`);
        }
        await cacache.put(dstCache, `make-fetch-happen:request-cache:${t.resolved}`, data, {
            integrity: t.integrity,
        });
        res.bytes += data.length;
    }
    res.required_missing = res.missing.filter((m) => !/\(optional\)$/.test(m));
    return res;
}

if (require.main === module) {
    const f = parseArgs(process.argv.slice(2));
    if (typeof f.root !== 'string' || typeof f.out !== 'string') {
        process.stderr.write(
            'usage: build-offline-cache.js --root <app> --out <cache> [--from <npm cache>]\n'
        );
        process.exit(2);
    }
    build({ root: f.root, out: f.out, from: typeof f.from === 'string' ? f.from : undefined }).then(
        (r) => {
            process.stdout.write(JSON.stringify(r) + '\n');
            process.exit(r.required_missing.length ? 1 : 0);
        },
        (e) => {
            process.stderr.write('build-offline-cache: ' + e.message + '\n');
            process.exit(1);
        }
    );
}

module.exports = { productionTarballs, build, npmModule };
