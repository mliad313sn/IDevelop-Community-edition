'use strict';
/**
 * The About page lists security controls from src/config/securityPosture.js.
 * Each control cites the files that implement it and the suites that prove it:
 * if one disappears, this fails, so the page never claims what the code lost.
 */
const fs = require('fs');
const path = require('path');
const { CATEGORIES, postureFor, totals } = require('../../src/config/securityPosture');

const root = path.join(__dirname, '../..');
const rows = [];
for (const c of CATEGORIES) for (const x of c.controls) rows.push([c.id, x]);

describe('security posture evidence', () => {
    test.each(rows.map(([c, x]) => [`${c}/${x.id}`, x]))('%s cites real files', (_n, x) => {
        expect(x.evidence.length).toBeGreaterThan(0);
        for (const f of x.evidence)
            expect([f, fs.existsSync(path.join(root, f))]).toEqual([f, true]);
        for (const t of x.tests)
            expect([t, fs.existsSync(path.join(__dirname, t))]).toEqual([t, true]);
    });

    test('every control is written in French and English', () => {
        for (const [, x] of rows) {
            expect(x.fr && x.fr.length > 20).toBe(true);
            expect(x.en && x.en.length > 20).toBe(true);
        }
        for (const c of CATEGORIES) expect(c.title.fr && c.title.en).toBeTruthy();
    });

    test('ids are unique and rendering picks the language', () => {
        const ids = rows.map(([, x]) => x.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(postureFor('en-GB')[0].title).toBe(CATEGORIES[0].title.en);
        expect(postureFor('fr')[0].title).toBe(CATEGORIES[0].title.fr);
        expect(totals().controls).toBe(rows.length);
    });

    test('docs/SECURITY-MEASURES.md lists every control', () => {
        const doc = fs.readFileSync(path.join(root, 'docs/SECURITY-MEASURES.md'), 'utf8');
        for (const [, x] of rows) expect([x.id, doc.includes(x.en)]).toEqual([x.id, true]);
    });
});

describe('generated document', () => {
    test('docs/SECURITY-MEASURES.md is regenerated (npm run security:doc)', () => {
        // Prettier 3 loads its plugins through dynamic import, which Jest's VM
        // refuses; the check therefore runs in a plain Node process.
        const { execFileSync } = require('child_process');
        expect(() =>
            execFileSync(process.execPath, ['scripts/export-security-measures.js', '--check'], {
                cwd: root,
                stdio: 'pipe',
            })
        ).not.toThrow();
    });
});
