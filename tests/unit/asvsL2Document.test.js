'use strict';
/**
 * docs/ASVS-L2.md (the OWASP ASVS 4.0.3 level 2 self-assessment) stays honest
 * and consistent:
 *  - one row per L1/L2 requirement, V1 to V14, each with a known status;
 *  - the summary block and the figures on About → Security
 *    (securityPosture.ASVS_L2) are the recount of those rows;
 *  - every test a row cites exists, and every "Fixed" row cites one;
 *  - docs/COMPLIANCE-MAPPING.md exists and says it is not a certification.
 */
const fs = require('fs');
const path = require('path');
const { ASVS_L2, FRAMEWORKS } = require('../../src/config/securityPosture');

const ROOT = path.join(__dirname, '../..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/ASVS-L2.md'), 'utf8');
const STATUSES = ['Pass', 'Fixed', 'Partial', 'Gap', 'N/A', 'Not verified'];

const rows = [...DOC.matchAll(/^\|\s*(\d+\.\d+\.\d+)\s*\|\s*([A-Za-z/ ]+?)\s*\|([^\n]*)$/gm)].map(
    (m) => ({ id: m[1], status: m[2], rest: m[3] })
);

const count = (st) => rows.filter((r) => r.status === st).length;

describe('docs/ASVS-L2.md', () => {
    test('one row per requirement, every chapter V1-V14, known statuses only', () => {
        expect(rows.length).toBe(258);
        expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
        for (const r of rows) expect([r.id, STATUSES.includes(r.status)]).toEqual([r.id, true]);
        const chapters = new Set(rows.map((r) => Number(r.id.split('.')[0])));
        for (let v = 1; v <= 14; v++) expect([v, chapters.has(v)]).toEqual([v, true]);
    });

    test('the summary and About → Security show the recount of the rows', () => {
        const expected = {
            total: rows.length,
            pass: count('Pass'),
            fixed: count('Fixed'),
            partial: count('Partial'),
            gap: count('Gap'),
            na: count('N/A'),
            notVerified: count('Not verified'),
        };
        for (const [k, v] of Object.entries(expected)) expect([k, ASVS_L2[k]]).toEqual([k, v]);
        const summary = DOC.slice(
            DOC.indexOf('<!-- ASVS-COUNTS:BEGIN -->'),
            DOC.indexOf('<!-- ASVS-COUNTS:END -->')
        );
        expect(summary).toContain(`**${expected.total} requirements**`);
        expect(summary).toContain(`**${expected.pass} Pass**`);
        expect(summary).toContain(`**${expected.fixed} Fixed**`);
        expect(summary).toContain(`${expected.partial} Partial`);
        expect(summary).toContain(`${expected.gap} Gap`);
    });

    test('every cited test exists, and every Fixed row cites one', () => {
        for (const r of rows) {
            const cited = r.rest.match(/[\w.-]+\.test\.js/g) || [];
            for (const t of cited)
                expect([r.id, t, fs.existsSync(path.join(ROOT, 'tests/unit', t))]).toEqual([
                    r.id,
                    t,
                    true,
                ]);
            if (r.status === 'Fixed') expect([r.id, cited.length > 0]).toEqual([r.id, true]);
        }
    });

    test('every Gap is explained in "Gaps left open"', () => {
        const gaps = DOC.slice(DOC.indexOf('## Gaps left open'));
        for (const r of rows.filter((x) => x.status === 'Gap'))
            expect([r.id, gaps.includes(r.id)]).toEqual([r.id, true]);
    });

    test('it says it is a self-assessment, not a certification', () => {
        expect(DOC).toMatch(/self-assessment by the development team, not a certification/);
    });
});

describe('docs/COMPLIANCE-MAPPING.md and the framework list', () => {
    const MAP = fs.readFileSync(path.join(ROOT, 'docs/COMPLIANCE-MAPPING.md'), 'utf8');

    test('covers every framework shown on About → Security', () => {
        for (const needle of [
            'OWASP Top 10',
            'CWE Top 25',
            'ISO/IEC 27001:2022',
            'SOC 2',
            'GDPR',
            'EU AI Act',
            'NIST SSDF',
        ])
            expect([needle, MAP.includes(needle)]).toEqual([needle, true]);
        for (const f of FRAMEWORKS) expect(fs.existsSync(path.join(ROOT, f.doc))).toBe(true);
    });

    test('is explicit about what it is not, and what the deployer must do', () => {
        expect(MAP).toMatch(/not a certification/i);
        for (const duty of ['penetration test', 'DPIA', 'backups', 'polic'])
            expect([duty, MAP.toLowerCase().includes(duty.toLowerCase())]).toEqual([duty, true]);
    });

    test('every cited test exists', () => {
        for (const t of new Set(MAP.match(/[\w.-]+\.test\.js/g) || []))
            expect([t, fs.existsSync(path.join(ROOT, 'tests/unit', t))]).toEqual([t, true]);
    });

    test('About → Security renders the frameworks with literal keys', () => {
        const view = fs.readFileSync(path.join(ROOT, 'views/pages/about.ejs'), 'utf8');
        for (const k of ['asvs', 'top10', 'cwe', 'iso', 'soc2', 'gdpr', 'aiact', 'ssdf'])
            expect(view).toContain(`__('admin:about_fw_${k}')`);
        expect(view).toMatch(/securityAsvs\.fixed/);
        for (const lang of ['fr', 'en']) {
            const admin = JSON.parse(
                fs.readFileSync(path.join(ROOT, `locales/${lang}/admin.json`), 'utf8')
            );
            expect(admin.about_fw_asvs_detail).toMatch(/\{\{pass\}\}[\s\S]*\{\{fixed\}\}/);
        }
    });
});
