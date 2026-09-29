'use strict';

/**
 * D2 — the readiness CSV export fabricated failures.
 *
 * /reports/readiness?format=csv set "Skills Not Met" to totalRequired - skillsMet,
 * which counts every never-assessed requirement as a failure. On idevelop that was
 * 853 of the 1544 "not met" cells — skills nobody had ever assessed — and a
 * never-assessed employee's row read "Total 152, Not Met 152, Readiness 0 %, Not
 * ready" for a role no one had looked at.
 *
 * The CSV now splits the three states apart from the honest primitives the rest
 * of the platform uses: Skills Assessed, Skills Met (measured & met), Skills Not
 * Met (MEASURED shortfall only), Never Assessed (its own column), Coverage %, and
 * a blank (never 0) Readiness % when nothing was assessed.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = !!process.env.DATABASE_URL;
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
let ReadinessService, ReportController, org;

const parse = (line) =>
    line
        .match(/("(?:[^"]|"")*"|[^,]*)/g)
        .filter((_, i, a) => i < a.length - 1)
        .map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"'));

beforeAll(async () => {
    if (HAS_DB) {
        await db.connect();
        ReadinessService = require('../../src/services/ReadinessService');
        ReportController = require('../../src/controllers/ReportController');
        org = await ReadinessService.getOrganizationalReadiness({
            id: 1,
            userType: 'admin',
            role: 'superadmin',
        });
    }
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('the readiness CSV never counts an un-rated requirement as a failure', () => {
    let header, rows, col;
    beforeAll(() => {
        const csv = ReportController.generateReadinessCSV(org);
        const lines = csv.split('\n');
        header = parse(lines[0]);
        rows = lines.slice(1).map(parse);
        col = (name) => header.indexOf(name);
    });

    test('the header carries the split + coverage columns', () => {
        for (const h of [
            'Skills Assessed',
            'Skills Met',
            'Skills Not Met',
            'Never Assessed',
            'Coverage %',
            'Readiness %',
        ]) {
            expect(header).toContain(h);
        }
    });

    test('per row: Met + Not Met + Never Assessed = Total Required, and Not Met <= Assessed', () => {
        for (const r of rows) {
            const total = Number(r[col('Total Required')]);
            const assessed = Number(r[col('Skills Assessed')]);
            const met = Number(r[col('Skills Met')]);
            const notMet = Number(r[col('Skills Not Met')]);
            const never = Number(r[col('Never Assessed')]);
            expect(met + notMet + never).toBe(total);
            expect(met + notMet).toBe(assessed); // Not Met is a MEASURED shortfall
            expect(notMet).toBeLessThanOrEqual(assessed);
        }
    });

    test('a never-assessed employee shows 0 not-met and a blank readiness', () => {
        const naRow = rows.find((r) => Number(r[col('Skills Assessed')]) === 0);
        expect(naRow).toBeTruthy(); // the dev set has never-assessed employees
        expect(Number(naRow[col('Skills Not Met')])).toBe(0); // no fabricated failure
        expect(Number(naRow[col('Never Assessed')])).toBe(Number(naRow[col('Total Required')]));
        expect(naRow[col('Readiness %')]).toBe(''); // blank, not 0
    });

    test('org-wide "Skills Not Met" equals the measured shortfalls, not the old inflated total', () => {
        const csvNotMet = rows.reduce((a, r) => a + Number(r[col('Skills Not Met')]), 0);
        const measured = org.readinessData.reduce(
            (a, rd) => a + (rd.gaps || []).filter((g) => g.isAssessed).length,
            0
        );
        const oldInflated = org.readinessData.reduce((a, rd) => a + Number(rd.skillsNotMet), 0);
        expect(csvNotMet).toBe(measured);
        expect(csvNotMet).toBeLessThan(oldInflated); // the fabricated failures are gone
    });
});
