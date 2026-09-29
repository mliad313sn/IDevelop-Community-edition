'use strict';

/**
 * The Comparator tab shipped the "two unrelated populations" radar that
 * getOrgDomainRadar documents as fixed.
 *
 * getComparatorRadars built its Panel-1 (category) and Panel-5 (domain) radars
 * from _getCategoryRadar / _getDomainRadar, which averaged v_domain_capability
 * (every assessment a person holds) on the actual side and roleSkillRequirements
 * fanned by headcount on the required side — two different row populations
 * subtracted. That is exactly the arithmetic getOrgDomainRadar was rewritten to
 * remove, and the two functions disagreed on every domain (Compliance gap 1.21
 * vs 0.36). A department nobody has assessed rendered actual 0 against a full
 * requirement — the cardinal fabrication.
 *
 * _getDomainRadar now delegates to getOrgDomainRadar; _getCategoryRadar runs
 * the same paired query grouped by skill category. Both are null-on-unmeasured,
 * and the Comparator renderer no longer coalesces that null to 0.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const DashboardModel = HAS_DB ? require('../../src/models/DashboardModel') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('the Comparator domain radar equals the paired Executive radar', () => {
    test('byDomain is identical to getOrgDomainRadar, domain for domain', async () => {
        const cmp = await DashboardModel.getComparatorRadars({}, {});
        const paired = await DashboardModel.getOrgDomainRadar({});
        const pm = new Map(paired.map((p) => [p.domainName, p]));
        expect(cmp.byDomain.length).toBe(paired.length);
        for (const d of cmp.byDomain) {
            const p = pm.get(d.domainName);
            expect(p).toBeTruthy();
            expect(d.avgActual).toEqual(p.avgActual);
            expect(d.avgRequired).toEqual(p.avgRequired);
        }
    });

    test('the fabricated gap is gone — Compliance is the paired figure', async () => {
        const cmp = await DashboardModel.getComparatorRadars({}, {});
        const comp = cmp.byDomain.find((d) => /Compliance/.test(d.domainName));
        expect(comp).toBeTruthy();
        const gap = Number(comp.avgRequired) - Number(comp.avgActual);
        // the two-population query produced 1.21 here; the paired one ~0.36
        expect(gap).toBeLessThan(0.6);
    });
});

suite('the category radar is paired and carries coverage', () => {
    test('both axes come from the same measured rows', async () => {
        const cmp = await DashboardModel.getComparatorRadars({}, {});
        const cats = cmp.actualVsRequired;
        expect(cats.length).toBeGreaterThan(0);
        for (const c of cats) {
            expect(Number.isFinite(Number(c.totalPairs))).toBe(true);
            expect(Number(c.measuredPairs)).toBeLessThanOrEqual(Number(c.totalPairs));
            // a measured category has a real number on BOTH axes or null on both
            const a = c.avgActual;
            const r = c.avgRequired;
            expect(a == null).toBe(r == null);
            if (a != null) {
                expect(Number(a)).toBeGreaterThanOrEqual(0);
                expect(Number(a)).toBeLessThanOrEqual(4);
            }
        }
    });
});

suite('a never-measured scope is null on both axes, never 0', () => {
    test('Internal Audit (0 assessments) yields null, not a capability collapse', async () => {
        // guard against a vacuous suite: this department must really be unmeasured
        const cov = await db.get(
            `SELECT COALESCE(SUM(assessed_skills),0)::int AS a
               FROM v_employee_assessment_coverage v
               JOIN employees e ON e.id = v.employee_id
               JOIN departments d ON d.id = e.department_id
              WHERE d.name = 'Internal Audit'`
        );
        if (!cov || Number(cov.a) !== 0) return; // fixture changed; skip rather than mislead

        const ia = await DashboardModel.getComparatorRadars(
            { departmentName: 'Internal Audit' },
            {}
        );
        for (const d of ia.byDomain) {
            expect(d.avgActual).toBeNull();
            expect(d.avgRequired).toBeNull();
        }
        for (const c of ia.actualVsRequired) {
            expect(c.avgActual).toBeNull();
            expect(c.avgRequired).toBeNull();
        }
    });
});

describe('the source no longer builds a two-population radar', () => {
    const src = read('src/models/DashboardModel.js');

    test('_getDomainRadar delegates rather than running its own query', () => {
        expect(src).toMatch(
            /async _getDomainRadar\(filters\)\s*\{\s*return this\.getOrgDomainRadar\(filters\);/
        );
    });

    test('_getCategoryRadar is a single paired query over the gaps view', () => {
        const flat = src.replace(/\s+/g, ' ');
        expect(flat).toMatch(
            /_getCategoryRadar\(filters\)[\s\S]*?FROM v_employee_skill_gaps g JOIN skills sk/
        );
        // the old two-population construction is gone
        expect(flat).not.toMatch(/_getCategoryRadar[\s\S]{0,600}?FROM v_domain_capability c/);
    });

    test('the renderer maps null to null, not through num()', () => {
        const js = read('public/js/dashboard.js').replace(/\s+/g, ' ');
        expect(js).toMatch(/const rNum = \(v\) => \(v == null \? null : Number\(v\)\)/);
        expect(js).toMatch(/data: avr\.map\(\(d\) => rNum\(d\.avgActual\)\)/);
        expect(js).toMatch(/data: domData\.map\(\(d\) => rNum\(d\.avgActual\)\)/);
    });
});
