'use strict';
/**
 * Third-party notices: scripts/build-third-party-notices.js writes the licence
 * of every shipped dependency at package time, the app serves the file at
 * /about/third-party-notices (read once at start-up, never per request) and
 * About links to it.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const N = require('../../scripts/build-third-party-notices');

describe('the notices file', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const built = N.build(ROOT);

    test('lists every production package of the lockfile, and no dev-only one', () => {
        const prod = N.npmPackages(ROOT);
        expect(prod.length).toBeGreaterThan(50);
        expect(built.count).toBe(prod.length);
        expect(built.text).toMatch(/^-+\nexpress \d+\.\d+\.\d+ — MIT\n-+$/m);
        const devOnly = Object.entries(lock.packages)
            .filter(([k, v]) => k && v.dev)
            .map(([k]) => k.slice(k.lastIndexOf('node_modules/') + 13));
        expect(devOnly).toContain('jest');
        for (const name of ['jest', 'eslint', 'prettier'])
            expect(built.text).not.toMatch(new RegExp(`^${name} \\d+\\.\\d+\\.\\d+ — `, 'm'));
    });

    test('carries the licence texts, and the vendored browser assets', () => {
        expect(built.text).toContain('Permission is hereby granted, free of charge');
        expect(built.text).toContain('Font Awesome Free (icons)');
        expect(built.text).toContain('SIL OPEN FONT LICENSE');
    });

    test('is reproducible: no date, the same bytes twice', () => {
        expect(N.build(ROOT).text).toBe(built.text);
        expect(built.text).not.toMatch(/\b20\d\d-\d\d-\d\d\b.*generated/i);
    });

    test('licence files are recognised by name, without a pattern on input', () => {
        for (const n of ['LICENSE', 'license.md', 'LICENCE.txt', 'COPYING', 'NOTICE'])
            expect(N.isLicenceFile(n)).toBe(true);
        for (const n of ['README.md', 'package.json', 'index.js'])
            expect(N.isLicenceFile(n)).toBe(false);
    });
});

describe('the route and the link', () => {
    const routes = read('src/routes/index.js');

    test('signed-in only, plain text, read once when the routes load', () => {
        expect(routes).toMatch(
            /const THIRD_PARTY_NOTICES = \(\(\) => \{\s*try \{\s*return require\('fs'\)\.readFileSync\(/
        );
        const handler = routes.slice(
            routes.indexOf("router.get('/about/third-party-notices', requireAuth,"),
            routes.indexOf("router.get('/about', requireAuth")
        );
        expect(handler.length).toBeGreaterThan(50);
        expect(handler).not.toMatch(/readFile|sendFile|createReadStream/);
        expect(handler).toContain("'text/plain; charset=utf-8'");
        expect(handler).toContain("req.t('admin:about_notices_missing')");
    });

    test('About links to it, in both languages', () => {
        expect(read('views/pages/about.ejs')).toMatch(
            /<a href="\/about\/third-party-notices" class="btn btn-secondary"[^>]*>.*admin:about_link_notices/
        );
        for (const lang of ['en', 'fr']) {
            const a = JSON.parse(read(`locales/${lang}/admin.json`));
            expect(a.about_link_notices).toBeTruthy();
            expect(a.about_notices_missing).toContain('build-third-party-notices.js');
        }
    });

    test('every package build writes it; the source tree never carries it', () => {
        expect(read('Dockerfile')).toMatch(
            /COPY \. \.\n[^\n]*\nRUN node scripts\/build-third-party-notices\.js/
        );
        const pkg = read('installer/Build-Package.ps1');
        expect(pkg).toContain("scripts\\build-third-party-notices.js') --root $appRoot --out");
        // before the release manifest, so the manifest covers it
        expect(pkg.indexOf('build-third-party-notices.js')).toBeLessThan(
            pkg.indexOf('# 3c. RELEASE MANIFEST')
        );
        expect(read('.gitignore')).toMatch(/^THIRD-PARTY-NOTICES\.txt$/m);
    });
});
