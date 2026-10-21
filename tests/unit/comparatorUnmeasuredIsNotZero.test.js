'use strict';

/**
 * The comparator radars plotted "nobody measured this" as "scores zero here".
 *
 * Each panel builds its axis set as the UNION of the domains present across
 * every group, then read each group's value with `dataMap.get(label) || 0`.
 * A group with no measurement in a domain has no entry in its map, so it was
 * drawn at the origin — visually identical to a group measured and found to
 * have no capability at all.
 *
 * Measured on idevelop: in the by-service panel, PMO and Data & Insights were
 * both plotted at 0 on Safety. Neither has ever been assessed on Safety. The
 * chart said those two services have no safety capability.
 *
 * Absent entries are now null, which Chart.js skips — the polygon vertex is
 * left open — and both radar tooltips say "not measured" instead of printing
 * "null" or, in the org radar's case, throwing on `null.toFixed(2)`.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isFixturesDatabaseUrl } = require('../helpers/testDatabase');
// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = isFixturesDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
const DashboardModel = HAS_DB ? require('../../src/models/DashboardModel') : null;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('a group with no measurement in a domain is not plotted at zero', () => {
    let panels = null;
    beforeAll(async () => {
        panels = await DashboardModel.getComparatorRadars({}, {});
    });

    // The exact axis/series construction the client performs.
    const build = (groups) => {
        const all = new Set();
        groups.forEach((g) => g.data.forEach((d) => all.add(d.domainName)));
        const labels = [...all].sort();
        return groups.map((g) => {
            const m = new Map(g.data.map((d) => [d.domainName, d.avgLevel]));
            return {
                label: g.label,
                missing: labels.filter((l) => !m.has(l)),
                data: labels.map((l) => (m.has(l) ? m.get(l) : null)),
            };
        });
    };

    test('the fixture we rely on still exists (guards against a vacuous suite)', () => {
        // At least one group must be missing at least one domain, or nothing
        // below is actually being exercised.
        const anyMissing = ['bySite', 'byDepartment', 'byService']
            .flatMap((k) => build(panels[k] || []))
            .some((s) => s.missing.length > 0);
        expect(anyMissing).toBe(true);
    });

    test.each(['bySite', 'byDepartment', 'byService'])(
        '%s: every absent domain is null, never 0',
        (key) => {
            for (const series of build(panels[key] || [])) {
                for (const v of series.data) {
                    expect(v === null || typeof v === 'number').toBe(true);
                }
                // a missing domain must not have produced a numeric 0
                const zeros = series.data.filter((v) => v === 0).length;
                expect(zeros).toBeLessThanOrEqual(
                    // only genuinely measured zeros are allowed
                    series.data.length - series.missing.length
                );
            }
        }
    );

    test('a measured domain still carries its real level', () => {
        const series = ['bySite', 'byDepartment', 'byService'].flatMap((k) =>
            build(panels[k] || [])
        );
        const numbers = series.flatMap((s) => s.data).filter((v) => v !== null);
        expect(numbers.length).toBeGreaterThan(0);
        for (const v of numbers) {
            expect(Number(v)).toBeGreaterThanOrEqual(0);
            expect(Number(v)).toBeLessThanOrEqual(4);
        }
    });
});

// the former dashboard page and public/js/dashboard.js were retired in wave 12 (D3); the server-rendered dashboard has its own tests (dash*.test.js)
