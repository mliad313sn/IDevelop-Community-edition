'use strict';
/**
 * Three regressions closed in the executive-decision pass:
 *
 * A. THE TREND CHART'S UNIT MISMATCH.
 *    DashboardService.getReadinessTrend used to back-cast a series by
 *    subtracting SUM(newLevel - previousLevel) — raw 0-4 SKILL LEVELS — from
 *    SUM(readiness_assessed_only) — a sum of PERCENTAGES. Percentages minus
 *    levels is not a quantity, so every historical point was meaningless, and
 *    the chart then plotted ~82 on a {min:0,max:4} axis (blank chart). It now
 *    reads recorded snapshots only, and reports its unit.
 *
 * B. THE CONTINUITY READ-GRANT-WRITES BYPASS.
 *    /v2/continuity is mounted behind an OR of four slugs, one of which
 *    (view_continuity) is declared write:false. Every POST inside then carried
 *    only requireAuth, so a view-only delegate could designate critical roles,
 *    open succession plans and override another person's risk-of-loss.
 *
 * C. THE SEED SCRIPT'S PRODUCTION GUARD + NAMESPACE.
 *
 * DB-free: everything external is mocked.
 */

// ---------------------------------------------------------------------------
// A. Trend
// ---------------------------------------------------------------------------
describe('DashboardService.getReadinessTrend — recorded history, not a back-cast', () => {
    let DashboardService;
    let KpiSnapshotService;
    let db;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../../src/config/database', () => ({
            get: jest.fn(),
            all: jest.fn(),
            run: jest.fn(),
        }));
        jest.doMock('../../src/models/DashboardModel', () => ({
            getOverviewKPIs: jest.fn(),
            getReadinessByGroup: jest.fn(),
            getReadinessDistribution: jest.fn(),
            getRoleStaffing: jest.fn(),
        }));
        jest.doMock('../../src/services/KpiSnapshotService', () => ({
            series: jest.fn(),
            deltas: jest.fn(),
            priorSnapshot: jest.fn(),
        }));
        db = require('../../src/config/database');
        KpiSnapshotService = require('../../src/services/KpiSnapshotService');
        DashboardService = require('../../src/services/DashboardService');
    });

    test('the removed back-cast is really gone (no assessmentHistory level arithmetic)', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/DashboardService.js'),
            'utf8'
        );
        expect(src).not.toMatch(/currentPoints\s*-=/);
        expect(src).not.toMatch(/changeMap/);
        const model = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/models/DashboardModel.js'),
            'utf8'
        );
        expect(model).not.toMatch(/newLevel - COALESCE\(ah\.previousLevel/);
    });

    test('org scope → the recorded org series, labelled as a percentage', async () => {
        KpiSnapshotService.series.mockResolvedValue([
            {
                date: '2026-07-23',
                avgReadiness: 80.8,
                assessmentCoverage: 72.5,
                measuredEmployees: 70,
            },
            {
                date: '2026-08-22',
                avgReadiness: 82.1,
                assessmentCoverage: 74.4,
                measuredEmployees: 72,
            },
        ]);
        const out = await DashboardService.getReadinessTrend({});
        expect(out.unit).toBe('percent');
        expect(out.scopeType).toBe('org');
        expect(out.series.map((p) => p.avg)).toEqual([80.8, 82.1]);
        expect(out.reason).toBeNull();
        expect(KpiSnapshotService.series).toHaveBeenCalledWith('org', 0, 400);
    });

    test('days with NULL readiness are DROPPED, never plotted as 0', async () => {
        KpiSnapshotService.series.mockResolvedValue([
            {
                date: '2026-07-01',
                avgReadiness: null,
                assessmentCoverage: null,
                measuredEmployees: 0,
            },
            {
                date: '2026-08-22',
                avgReadiness: 82.1,
                assessmentCoverage: 74.4,
                measuredEmployees: 72,
            },
        ]);
        const out = await DashboardService.getReadinessTrend({});
        expect(out.series).toHaveLength(1);
        expect(out.series[0].avg).toBe(82.1);
        expect(out.series.some((p) => p.avg === 0)).toBe(false);
    });

    test('a single-site scope reads that site’s recorded series', async () => {
        KpiSnapshotService.series.mockResolvedValue([]);
        const out = await DashboardService.getReadinessTrend({ siteIds: [11] });
        expect(out.scopeType).toBe('site');
        expect(out.scopeId).toBe(11);
        expect(KpiSnapshotService.series).toHaveBeenCalledWith('site', 11, 400);
    });

    test('a scope NARROWER than any recorded scope returns no series, with a reason', async () => {
        for (const f of [
            { departmentIds: [3] },
            { serviceIds: [4] },
            { employeeIds: [7, 8] },
            { siteIds: [11, 12] },
            { roleName: 'Soudeur' },
        ]) {
            const out = await DashboardService.getReadinessTrend(f);
            expect(out.series).toEqual([]);
            expect(out.reason).toBe('no_scoped_history');
        }
        expect(KpiSnapshotService.series).not.toHaveBeenCalled();
    });

    test('no stored rows yet → empty series with no_history_yet (not an error)', async () => {
        KpiSnapshotService.series.mockResolvedValue([]);
        const out = await DashboardService.getReadinessTrend({});
        expect(out.series).toEqual([]);
        expect(out.reason).toBe('no_history_yet');
    });

    test('a site filter given by NAME resolves to that site’s id', async () => {
        db.get.mockResolvedValue({ id: 14 });
        KpiSnapshotService.series.mockResolvedValue([]);
        const out = await DashboardService.getReadinessTrend({ siteName: 'Lakeside' });
        expect(out.scopeType).toBe('site');
        expect(out.scopeId).toBe(14);
    });

    test('an unknown site name yields no series rather than falling back to org', async () => {
        db.get.mockResolvedValue(undefined);
        const out = await DashboardService.getReadinessTrend({ siteName: 'Nowhere' });
        expect(out.reason).toBe('no_scoped_history');
        expect(KpiSnapshotService.series).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// B. Continuity write guards
// ---------------------------------------------------------------------------
describe('/v2/continuity write routes are gated on WRITE slugs', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/v2-continuity.js'), 'utf8');

    // Each POST REGISTRATION — path plus guard list — however it is laid out.
    // This was `match(/router\.post\('[^']+',[^\n]*/g)`, i.e. "the rest of the
    // line after the path". Prettier puts every guard on a line of its own once
    // the registration overflows, so the pattern matched NOTHING and the suite
    // reported zero write routes on a file with more than ten.
    const writeRoutes = (() => {
        const out = [];
        const re = /router\.post\(/g;
        let m;
        while ((m = re.exec(src))) {
            const ends = [src.indexOf('=>', m.index), src.indexOf(';', m.index)].filter(
                (i) => i > -1
            );
            out.push(src.slice(m.index, ends.length ? Math.min(...ends) : m.index + 400));
        }
        return out;
    })();

    test('every POST route carries a write guard beyond requireAuth', () => {
        expect(writeRoutes.length).toBeGreaterThan(10);
        const ungated = writeRoutes.filter(
            (line) => !/require(Succession|Retention|Handover)Write/.test(line)
        );
        // NO carve-outs. /retention/:employeeId/recompute was previously exempted
        // here as "a READ-side recompute", but RetentionRiskService.computeFor
        // does INSERT ... ON CONFLICT DO UPDATE on retention_risk — it refreshes
        // the computed score and last_reviewed. It is a write, so a read-only
        // continuity delegate must not reach it. Every POST is gated.
        expect(ungated).toEqual([]);
    });

    test('recomputing risk-of-loss is gated as a write, not as a read', () => {
        const line = writeRoutes.find((l) => l.includes('/retention/:employeeId/recompute'));
        expect(line).toBeDefined();
        expect(line).toMatch(/requireRetentionWrite/);
    });

    test('criticality / plans / successors need manage_succession', () => {
        for (const frag of [
            '/criticality',
            "'/plan'",
            '/plan/:id/incumbent',
            '/plan/:id/archive',
            '/plan/:id/successor',
            '/successor/:id/remove',
        ]) {
            const line = writeRoutes.find((l) => l.includes(frag));
            expect(line).toBeDefined();
            expect(line).toMatch(/requireSuccessionWrite/);
        }
    });

    test('overriding risk-of-loss needs the new WRITE slug, not the read one', () => {
        const line = writeRoutes.find((l) => l.includes('/retention/:employeeId/override'));
        expect(line).toMatch(/requireRetentionWrite/);
        expect(line).not.toMatch(/view_retention_risk/);
    });

    test('handover writes need manage_handover', () => {
        const line = writeRoutes.find((l) => l.includes("'/handover'"));
        expect(line).toMatch(/requireHandoverWrite/);
    });

    test('POST /criticality now scope-checks the roleId (it had no object authz)', () => {
        // Bounded to THIS route rather than to 900 characters: the reformat
        // spread the registration over more lines and pushed the scope check
        // out of a window that used to reach it, so the assertion failed on a
        // check that had not moved.
        const start = src.search(/router\.post\(\s*'\/criticality'/);
        expect(start).toBeGreaterThan(-1);
        const next = src.indexOf('router.post(', start + 10);
        const block = src.slice(start, next > -1 ? next : undefined);
        expect(block).toMatch(/canAccessRole\(req\.user, roleId\)/);
    });

    test('the write slugs the guards name all exist in the catalogue and are write:true', () => {
        const { BY_SLUG } = require('../../src/config/permissions');
        for (const slug of ['manage_succession', 'manage_retention_risk', 'manage_handover']) {
            expect(BY_SLUG[slug]).toBeDefined();
            expect(BY_SLUG[slug].write).toBe(true);
        }
        // The read grant that used to admit writers stays write:false.
        expect(BY_SLUG.view_continuity.write).toBe(false);
        expect(BY_SLUG.view_retention_risk.write).toBe(false);
    });

    test('the new permission slug is localized in BOTH languages', () => {
        for (const lng of ['fr', 'en']) {
            const dict = require(`../../locales/${lng}/admin.json`);
            let found = null;
            (function walk(o) {
                for (const k of Object.keys(o)) {
                    if (k === 'manage_retention_risk') {
                        found = o[k];
                        return;
                    }
                    if (o[k] && typeof o[k] === 'object') walk(o[k]);
                    if (found) return;
                }
            })(dict);
            expect(found).toBeTruthy();
            expect(typeof found.label).toBe('string');
            expect(found.label.length).toBeGreaterThan(0);
            expect(typeof found.desc).toBe('string');
        }
    });
});

// ---------------------------------------------------------------------------
// C. Demo seed script
// ---------------------------------------------------------------------------
describe('scripts/seed-demo — production guard and namespace', () => {
    const seed = require('../../scripts/seed-demo');

    test('every table it writes is identified by a marker column', () => {
        expect(seed.MARKER).toBe('[DEMO-SEED]');
        expect(seed.NAMESPACED.length).toBeGreaterThan(0);
        for (const entry of seed.NAMESPACED) {
            expect(typeof entry.table).toBe('string');
            expect(typeof entry.column).toBe('string');
        }
    });

    test('it never touches a table holding real workforce data', () => {
        const forbidden = [
            'employees',
            'skills',
            'roles',
            'skill_assessments',
            'self_assessments',
            'role_skill_requirements',
            'admins',
            'audit_log',
        ];
        const touched = seed.NAMESPACED.map((e) => e.table);
        for (const t of forbidden) expect(touched).not.toContain(t);
    });

    test('NODE_ENV=production is detected as production', () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        expect(seed.isProduction()).toBe(true);
        process.env.NODE_ENV = 'PRODUCTION';
        expect(seed.isProduction()).toBe(true);
        process.env.NODE_ENV = prev;
    });

    test('development / unset are not production', () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';
        expect(seed.isProduction()).toBe(false);
        delete process.env.NODE_ENV;
        expect(seed.isProduction()).toBe(false);
        process.env.NODE_ENV = prev;
    });

    test('the script has no flag that can override the production refusal', () => {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../scripts/seed-demo.js'),
            'utf8'
        );
        expect(src).not.toMatch(/--force/);
        expect(src).not.toMatch(/ALLOW_PROD|FORCE_PROD|--i-know/i);
        // The guard must run before any database work.
        expect(src.indexOf("mode === 'seed' && isProduction()")).toBeLessThan(
            src.indexOf("require('../src/config/database')")
        );
    });
});
