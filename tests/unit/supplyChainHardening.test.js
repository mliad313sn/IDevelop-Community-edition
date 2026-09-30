'use strict';
/**
 * Supply-chain hardening guard (docs/SECURITY-SUPPLY-CHAIN.md). Pins the CI
 * security gates, the SHA pinning of third-party actions, Dependabot coverage and
 * the container hardening, so a later edit cannot quietly drop one of them.
 */
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const workflows = fs
    .readdirSync(WF_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ file: f, text: read(`.github/workflows/${f}`) }))
    .map((w) => ({ ...w, doc: YAML.parse(w.text) }));
const byName = Object.fromEntries(workflows.map((w) => [w.file, w]));

/** Every `uses:` of every step of every job. */
const usesOf = (doc) =>
    Object.values(doc.jobs || {}).flatMap((job) =>
        (job.steps || []).filter((s) => s.uses).map((s) => s.uses)
    );
/** `on:` triggers as a list of names (the YAML key may be parsed as boolean true). */
const triggersOf = (doc) => Object.keys(doc.on || doc[true] || {});

describe('CI workflows: least privilege and pinned actions', () => {
    test('the security workflows exist', () => {
        for (const f of [
            'ci.yml',
            'codeql.yml',
            'dependency-review.yml',
            'secret-scan.yml',
            'scorecard.yml',
            'supply-chain.yml',
        ])
            expect({ f, exists: Boolean(byName[f]) }).toEqual({ f, exists: true });
    });

    test('every workflow sets a read-only default token at workflow level', () => {
        for (const w of workflows) {
            expect({ file: w.file, permissions: w.doc.permissions }).toEqual({
                file: w.file,
                permissions: { contents: 'read' },
            });
        }
    });

    test('no job is granted write-all / a blanket write token', () => {
        for (const w of workflows)
            for (const [name, job] of Object.entries(w.doc.jobs)) {
                const p = job.permissions;
                expect({ job: `${w.file}:${name}`, p }).not.toEqual({
                    job: `${w.file}:${name}`,
                    p: 'write-all',
                });
                if (p && typeof p === 'object' && p.contents)
                    expect({ job: `${w.file}:${name}`, contents: p.contents }).toEqual({
                        job: `${w.file}:${name}`,
                        contents: 'read',
                    });
            }
    });

    test('no action tracks a branch (@main / @master) and every third-party action is SHA-pinned', () => {
        const bad = [];
        for (const w of workflows)
            for (const ref of usesOf(w.doc)) {
                if (ref.startsWith('./')) continue;
                if (/@(main|master|HEAD)$/.test(ref) || !/@[0-9a-f]{40}$/.test(ref))
                    bad.push(`${w.file}: ${ref}`);
            }
        expect(bad).toEqual([]);
    });

    test('every pinned SHA carries a version comment for humans and Dependabot', () => {
        const bad = [];
        for (const w of workflows)
            for (const line of w.text.split(/\r?\n/))
                if (/uses:\s*[^./][^\s]*@[0-9a-f]{40}/.test(line) && !/#\s*v?\d+\.\d+/.test(line))
                    bad.push(`${w.file}: ${line.trim()}`);
        expect(bad).toEqual([]);
    });

    test('CodeQL runs on push, pull request and a weekly schedule', () => {
        const doc = byName['codeql.yml'].doc;
        expect(triggersOf(doc)).toEqual(
            expect.arrayContaining(['push', 'pull_request', 'schedule'])
        );
        expect(byName['codeql.yml'].text).toMatch(/languages:\s*javascript/);
    });

    test('dependency review fails on high severity with an AGPL-compatible licence policy', () => {
        const doc = byName['dependency-review.yml'].doc;
        const step = doc.jobs['dependency-review'].steps.find((s) =>
            String(s.uses || '').startsWith('actions/dependency-review-action@')
        );
        expect(step.with['fail-on-severity']).toBe('high');
        const allowed = String(step.with['allow-licenses'])
            .split(',')
            .map((l) => l.trim());
        expect(allowed).toEqual(expect.arrayContaining(['AGPL-3.0-or-later', 'MIT']));
        // Licences that cannot be combined with AGPL-3.0-or-later stay out of the allow-list.
        for (const bad of ['GPL-2.0-only', 'LGPL-2.0-only', 'SSPL-1.0', 'BUSL-1.1', 'EPL-1.0'])
            expect({ bad, allowed: allowed.includes(bad) }).toEqual({ bad, allowed: false });
    });

    test('the production npm audit gate is in CI', () => {
        expect(byName['ci.yml'].text).toMatch(/npm audit --omit=dev --audit-level=high/);
    });

    test('gitleaks scans the full history with a checksum-verified binary', () => {
        const text = byName['secret-scan.yml'].text;
        expect(text).toMatch(/fetch-depth:\s*0/);
        expect(text).toMatch(/sha256sum --check/);
        expect(text).toMatch(/gitleaks git --config \.gitleaks\.toml/);
        expect(fs.existsSync(path.join(ROOT, '.gitleaks.toml'))).toBe(true);
    });

    test('Scorecard runs weekly and does not publish', () => {
        const doc = byName['scorecard.yml'].doc;
        expect(triggersOf(doc)).toContain('schedule');
        expect(byName['scorecard.yml'].text).toMatch(/publish_results:\s*false/);
    });

    test('Trivy scans image and filesystem, fails on fixable CRITICAL/HIGH, uploads SARIF; SBOM is built', () => {
        const text = byName['supply-chain.yml'].text;
        expect(text).toMatch(/scan-type:\s*fs/);
        expect(text).toMatch(/scan-type:\s*image/);
        expect(text.match(/severity:\s*CRITICAL,HIGH/g)).toHaveLength(2);
        expect(text.match(/ignore-unfixed:\s*true/g)).toHaveLength(2);
        expect(text.match(/exit-code:\s*'1'/g)).toHaveLength(2);
        expect(text).toMatch(/upload-sarif@/);
        expect(text).toMatch(/npm run security:sbom/);
    });
});

describe('Dependabot', () => {
    const doc = YAML.parse(read('.github/dependabot.yml'));
    const ecosystems = doc.updates.map((u) => u['package-ecosystem']);

    test('covers npm, github-actions and docker, weekly', () => {
        expect(ecosystems).toEqual(expect.arrayContaining(['npm', 'github-actions', 'docker']));
        for (const u of doc.updates) expect(u.schedule.interval).toBe('weekly');
    });

    test('groups minor and patch updates', () => {
        for (const u of doc.updates) {
            const groups = Object.values(u.groups || {});
            expect({
                eco: u['package-ecosystem'],
                grouped: groups.some(
                    (g) =>
                        (g['update-types'] || []).includes('minor') &&
                        (g['update-types'] || []).includes('patch')
                ),
            }).toEqual({ eco: u['package-ecosystem'], grouped: true });
        }
    });
});

describe('Dockerfile (CIS Docker Benchmark 4.x)', () => {
    const df = read('Dockerfile');

    test('runs as a non-root USER', () => {
        const users = [...df.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
        expect(users.length).toBeGreaterThan(0);
        expect(users[users.length - 1]).not.toMatch(/^(root|0)(:|$)/);
    });

    test('has a HEALTHCHECK', () => {
        expect(df).toMatch(/^HEALTHCHECK\s+.*\\?\s*\n?\s*CMD .*readyz/m);
    });

    test('pins the base image by digest and installs production dependencies only', () => {
        expect(df).toMatch(/node:22-alpine@sha256:[0-9a-f]{64}/);
        expect(df).toMatch(/npm ci --omit=dev/);
        expect(df).toMatch(/NODE_ENV=production/);
    });

    test('bakes no secret into a layer and ignores .env / .git in the build context', () => {
        expect(df).not.toMatch(/^\s*(ENV|ARG)\s+\S*(SECRET|PASSWORD|TOKEN|APP_KEY)/im);
        const ignore = read('.dockerignore')
            .split(/\r?\n/)
            .map((l) => l.trim().replace(/\/$/, ''));
        expect(ignore).toEqual(expect.arrayContaining(['.git', '.env', '.env.*', 'tests']));
    });
});

describe('docker-compose (CIS Docker Benchmark 5.x)', () => {
    const doc = YAML.parse(read('docker-compose.yml'), { merge: true });

    test('every service sets no-new-privileges and drops all capabilities', () => {
        for (const [name, svc] of Object.entries(doc.services)) {
            expect({ name, sec: svc.security_opt }).toEqual({
                name,
                sec: expect.arrayContaining(['no-new-privileges:true']),
            });
            expect({ name, cap: svc.cap_drop }).toEqual({ name, cap: ['ALL'] });
        }
    });

    test('root filesystems are read-only and resources are limited', () => {
        for (const [name, svc] of Object.entries(doc.services)) {
            expect({ name, ro: svc.read_only }).toEqual({ name, ro: true });
            const limits = svc.deploy && svc.deploy.resources && svc.deploy.resources.limits;
            expect({ name, mem: Boolean(limits && limits.memory) }).toEqual({ name, mem: true });
        }
    });

    test('the database and redis are not published to the host', () => {
        expect(doc.services.db.ports).toBeUndefined();
        expect(doc.services.redis.ports).toBeUndefined();
    });
});

describe('scripts/security-check.js static policy', () => {
    const check = require('../../scripts/security-check');

    test('recognises pinned and unpinned references', () => {
        expect(check.isPinned('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1')).toBe(
            true
        );
        expect(check.isPinned('actions/checkout@v4')).toBe(false);
        expect(check.isPinned('actions/checkout@main')).toBe(false);
        expect(check.isPinned('./.github/actions/local')).toBe(true);
    });

    test('the repository passes its own policy and lockfile checks', () => {
        expect(check.policyChecks()).toEqual([]);
        expect(check.lockfileChecks()).toEqual([]);
    });
});
