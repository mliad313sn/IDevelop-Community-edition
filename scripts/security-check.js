'use strict';
/**
 * Fast local supply-chain checks, run before pushing (dev machine only; not
 * shipped by the installer). The same controls are enforced in CI; this script
 * gives the developer the answer in seconds. See docs/SECURITY-SUPPLY-CHAIN.md.
 *
 *   node scripts/security-check.js              all checks
 *   node scripts/security-check.js --offline    skip npm audit (no network)
 *   node scripts/security-check.js --secrets    only the gitleaks secret scan
 *
 * Checks:
 *   policy     workflows least-privilege and SHA-pinned, Dockerfile / compose
 *              hardening, .dockerignore, Dependabot coverage (static, offline)
 *   lockfile   every package resolved from the npm registry with an integrity hash
 *   audit      npm audit --omit=dev --audit-level=high
 *   secrets    gitleaks over the full git history (if gitleaks is installed)
 *
 * Exit code 1 if any check FAILs; SKIPs (tool missing, offline) do not fail.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const PASS = 'PASS';
const FAIL = 'FAIL';
const SKIP = 'SKIP';

/** `uses:` references in a workflow, with the line they are on. */
function actionRefs(text) {
    const refs = [];
    text.split(/\r?\n/).forEach((line, i) => {
        const m = /^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#]+)['"]?\s*(#.*)?$/.exec(line);
        if (m) refs.push({ ref: m[1], comment: (m[2] || '').trim(), line: i + 1 });
    });
    return refs;
}

/** A reference is pinned when it is local, a docker digest, or @<40-hex sha>. */
function isPinned(ref) {
    if (ref.startsWith('./')) return true;
    if (ref.startsWith('docker://')) return /@sha256:[0-9a-f]{64}$/.test(ref);
    return /@[0-9a-f]{40}$/.test(ref);
}

function workflowFiles() {
    const dir = path.join(ROOT, '.github', 'workflows');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => path.posix.join('.github/workflows', f));
}

/** Static policy checks: pure file inspection, no network, no tools. */
function policyChecks() {
    const problems = [];
    const wfs = workflowFiles();
    if (!wfs.length) problems.push('no workflows in .github/workflows');
    for (const wf of wfs) {
        const text = read(wf);
        if (!/^permissions:/m.test(text)) problems.push(`${wf}: no top-level permissions`);
        if (/^permissions:\s*write-all/m.test(text)) problems.push(`${wf}: write-all token`);
        for (const r of actionRefs(text)) {
            if (/@(main|master|HEAD)$/.test(r.ref))
                problems.push(`${wf}:${r.line}: ${r.ref} tracks a branch`);
            else if (!isPinned(r.ref))
                problems.push(`${wf}:${r.line}: ${r.ref} is not pinned to a commit SHA`);
            else if (!r.ref.startsWith('./') && !/#\s*v?\d/.test(r.comment))
                problems.push(`${wf}:${r.line}: ${r.ref} has no version comment`);
        }
    }

    if (!exists('Dockerfile')) problems.push('Dockerfile missing');
    else {
        const df = read('Dockerfile');
        const users = [...df.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
        const last = users[users.length - 1];
        if (!last || /^(root|0)(:|$)/.test(last)) problems.push('Dockerfile: no non-root USER');
        if (!/^HEALTHCHECK\s+/m.test(df)) problems.push('Dockerfile: no HEALTHCHECK');
        if (!/@sha256:[0-9a-f]{64}/.test(df))
            problems.push('Dockerfile: base image not pinned by digest');
        if (!/npm ci --omit=dev/.test(df)) problems.push('Dockerfile: not npm ci --omit=dev');
        if (!/NODE_ENV=production/.test(df))
            problems.push('Dockerfile: NODE_ENV=production not set');
        if (/^\s*(ENV|ARG)\s+\S*(SECRET|PASSWORD|TOKEN|APP_KEY)\S*[=\s]/im.test(df))
            problems.push('Dockerfile: a secret-like ENV/ARG is baked into the image');
    }

    if (!exists('.dockerignore')) problems.push('.dockerignore missing');
    else {
        // `tests` and `tests/` mean the same to Docker: compare without the trailing slash.
        const di = read('.dockerignore')
            .split(/\r?\n/)
            .map((l) => l.trim().replace(/\/$/, ''));
        for (const must of ['.git', '.env', 'node_modules', 'tests'])
            if (!di.includes(must)) problems.push(`.dockerignore: does not exclude ${must}`);
    }

    if (exists('docker-compose.yml')) {
        const dc = read('docker-compose.yml');
        if (!/no-new-privileges:true/.test(dc)) problems.push('compose: no no-new-privileges');
        if (!/cap_drop:\s*\n\s*-\s*ALL/.test(dc)) problems.push('compose: cap_drop ALL missing');
        if (!/read_only:\s*true/.test(dc)) problems.push('compose: no read_only root filesystem');
    }

    if (!exists('.github/dependabot.yml')) problems.push('.github/dependabot.yml missing');
    else {
        const db = read('.github/dependabot.yml');
        for (const eco of ['npm', 'github-actions', 'docker'])
            if (!new RegExp(`package-ecosystem:\\s*['"]?${eco}['"]?\\s*$`, 'm').test(db))
                problems.push(`dependabot: ${eco} not covered`);
    }
    return problems;
}

/** Every lockfile entry comes from the public registry over HTTPS with an integrity hash. */
function lockfileChecks() {
    const problems = [];
    if (!exists('package-lock.json')) return ['package-lock.json missing'];
    const lock = JSON.parse(read('package-lock.json'));
    if (!(lock.lockfileVersion >= 2)) problems.push(`lockfileVersion ${lock.lockfileVersion} < 2`);
    for (const [key, pkg] of Object.entries(lock.packages || {})) {
        if (!key || pkg.link || !pkg.resolved) continue; // root, workspace links, bundled
        if (!pkg.resolved.startsWith('https://registry.npmjs.org/'))
            problems.push(`${key}: resolved from ${pkg.resolved.split('/').slice(0, 3).join('/')}`);
        if (!/^sha(256|384|512)-/.test(pkg.integrity || ''))
            problems.push(`${key}: no sha-2 integrity hash`);
    }
    return problems;
}

function npmBin() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function auditCheck() {
    const r = spawnSync(npmBin(), ['audit', '--omit=dev', '--audit-level=high', '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 120000,
    });
    let report;
    try {
        report = JSON.parse(r.stdout || '');
    } catch (_) {
        return { status: SKIP, detail: 'npm audit did not return a report (offline?)' };
    }
    if (report.error)
        return { status: SKIP, detail: `npm audit: ${report.error.summary || 'error'}` };
    const v = (report.metadata && report.metadata.vulnerabilities) || {};
    const high = (v.high || 0) + (v.critical || 0);
    const summary = `critical ${v.critical || 0}, high ${v.high || 0}, moderate ${v.moderate || 0}, low ${v.low || 0}`;
    if (high) {
        const names = Object.values(report.vulnerabilities || {})
            .filter((x) => x.severity === 'high' || x.severity === 'critical')
            .map((x) => x.name);
        return { status: FAIL, detail: `${summary}: ${names.join(', ')}` };
    }
    return { status: PASS, detail: summary };
}

function gitleaksCheck() {
    const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
        return {
            status: SKIP,
            detail:
                'gitleaks is not installed. Install it (https://github.com/gitleaks/gitleaks#installing, ' +
                'e.g. `brew install gitleaks`, `winget install gitleaks` or the release binary) and re-run; ' +
                'CI runs the same scan on every push (.github/workflows/secret-scan.yml).',
        };
    }
    if (!exists('.git')) return { status: SKIP, detail: 'not a git checkout' };
    const args = ['git', '--config', '.gitleaks.toml', '--redact', '--no-banner', '.'];
    const r = spawnSync('gitleaks', args, { cwd: ROOT, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0)
        return { status: PASS, detail: `gitleaks ${probe.stdout.trim()}: no leaks in history` };
    const n = /leaks found:\s*(\d+)/.exec(out);
    return {
        status: FAIL,
        detail: `${n ? n[1] : 'some'} potential secret(s); run \`gitleaks ${args.join(' ')} -v\` for details`,
    };
}

function toResult(name, problems) {
    return problems.length
        ? { name, status: FAIL, detail: problems.join('\n        ') }
        : { name, status: PASS, detail: 'ok' };
}

function run(argv = process.argv.slice(2)) {
    const results = [];
    if (argv.includes('--secrets')) {
        results.push({ name: 'secrets', ...gitleaksCheck() });
    } else {
        results.push(toResult('policy', policyChecks()));
        results.push(toResult('lockfile', lockfileChecks()));
        results.push(
            argv.includes('--offline')
                ? { name: 'audit', status: SKIP, detail: '--offline' }
                : { name: 'audit', ...auditCheck() }
        );
        results.push({ name: 'secrets', ...gitleaksCheck() });
    }
    console.log('\nSupply-chain security check\n');
    for (const r of results) console.log(`  [${r.status}] ${r.name.padEnd(9)} ${r.detail}`);
    const failed = results.filter((r) => r.status === FAIL).length;
    const skipped = results.filter((r) => r.status === SKIP).length;
    console.log(
        `\n  ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped` +
            ' (see docs/SECURITY-SUPPLY-CHAIN.md)\n'
    );
    return failed ? 1 : 0;
}

module.exports = { actionRefs, isPinned, policyChecks, lockfileChecks };

if (require.main === module) process.exitCode = run();
