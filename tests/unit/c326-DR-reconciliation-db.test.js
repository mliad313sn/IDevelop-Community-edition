'use strict';
/**
 * Reports, the report builder, the API v1 and the Power BI readiness feed on
 * the REAL test database: they all read the SAME K1 (KpiService.k1RoleReady,
 * four states). Every test builds its fixtures INSIDE a transaction that is
 * always rolled back (tests/helpers/kpiWorld.js).
 *
 *   A, A2, A3, A4 ready · B not ready · C partial · D not assessed ·
 *   E not ready (known critical fail) · F LEAVER · G ERASED ·
 *   H NO SITE, not assessed · M manager of everyone.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(180000);

const W = require('../helpers/kpiWorld');
const db = HAS_DB ? require('../../src/config/database') : null;
const K = HAS_DB ? require('../../src/services/KpiService') : null;
const RBS = HAS_DB ? require('../../src/services/ReportBuilderService') : null;
const RDS = HAS_DB ? require('../../src/services/ReportDataService') : null;
const RC = HAS_DB ? require('../../src/controllers/ReportController') : null;

let F = null;

beforeAll(async () => {
    if (!HAS_DB) return;
    await db.connect();
    F = await W.seedFacts(db);
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const tx = (fn) => W.inRolledBackTx(db, fn);

function mockRes() {
    const res = { statusCode: 200, body: null, view: null, locals: {}, headers: {} };
    res.status = (c) => {
        res.statusCode = c;
        return res;
    };
    res.json = (b) => {
        res.body = b;
        return res;
    };
    res.render = (v, l) => {
        res.view = v;
        res.body = l;
        return res;
    };
    res.setHeader = (k, v) => {
        res.headers[k] = v;
    };
    res.send = (b) => {
        res.body = b;
        return res;
    };
    res.redirect = (u) => {
        res.redirected = u;
        return res;
    };
    return res;
}
function req(user, extra = {}) {
    return {
        user,
        query: {},
        body: {},
        headers: {},
        protocol: 'http',
        get: () => 'localhost',
        flash: () => {},
        ...extra,
    };
}

suite('reports, builder, API and Power BI read ONE K1', () => {
    test('K1 is identical on /reports/readiness, the builder strip, the builder source, the API v1 and the Power BI v2 feed', async () => {
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const viewer = W.managerOf(w);
            const kpi = await K.k1RoleReady({ viewer });
            const page = mockRes();
            await RC.readiness(req(viewer, { query: { format: 'json' } }), page);
            const strip = await RDS.getSectionData(
                { source: 'v_employee_readiness', chartType: 'kpi', _lang: 'en' },
                viewer,
                null
            );
            const pbi = mockRes();
            await RC.powerbIReadinessV2(req(viewer), pbi);
            const classic = await RBS.executeReport(
                {
                    dataSource: 'readiness',
                    selectedFields: ['employeeName', 'readinessState', 'isReady'],
                },
                viewer
            );
            const Api = require('../../src/api/v1/repository');
            const api = await Api.ReadinessRepository.list(viewer, { limit: 1000 });
            return { w, kpi, json: page.body, strip, pbi, classic, api };
        });
        const { w, kpi, json, strip, pbi, classic, api } = out;
        expect(kpi.numerator).toBe(4);
        expect(kpi.denominator).toBe(6);
        expect(kpi.value).toBe(66.7);

        // /reports/readiness (JSON form of the page)
        expect(json.value).toBe(kpi.value);
        expect(json.numerator).toBe(kpi.numerator);
        expect(json.denominator).toBe(kpi.denominator);
        expect(json.contract).toBe(K.CONTRACT_VERSION);
        expect(json.breakdown).toMatchObject({
            ready: 4,
            notReady: 2,
            partial: 1,
            notAssessed: 2,
        });
        const stateOf = (id) => json.rows.find((r) => r.employee.id === id).state;
        expect(stateOf(w.D)).toBe('not_assessed');
        expect(stateOf(w.H)).toBe('not_assessed');
        expect(stateOf(w.C)).toBe('partial');
        expect(stateOf(w.E)).toBe('not_ready');
        expect(json.rows.find((r) => r.employee.id === w.E).reason).toBe('critical_not_met');
        expect(json.rows.find((r) => r.employee.id === w.D).readinessPercent).toBeNull();

        // builder strip
        expect(strip.k1.value).toBe(kpi.value);
        expect(strip.k1.numerator).toBe(kpi.numerator);
        expect(strip.k1.denominator).toBe(kpi.denominator);
        expect(strip.items[0].key).toBe('K1');
        expect(strip.items[0].display).toBe('66.7%');

        // classic builder « readiness » source, person by person
        const st = (r) => r.readinessState || r.readinessstate;
        const kpiState = new Map();
        for (const [s, ids] of Object.entries(kpi.drillByState)) {
            for (const id of ids) kpiState.set(id, s);
        }
        expect(classic.filter((r) => st(r) === 'ready')).toHaveLength(kpi.numerator);
        expect(classic.filter((r) => st(r) === 'ready' || st(r) === 'not_ready')).toHaveLength(
            kpi.denominator
        );
        // H has no site: the readiness view only holds people WITH a site
        expect(classic.filter((r) => st(r) === 'not_assessed').length).toBe(
            kpi.breakdown.notAssessed - 1
        );
        expect(classic.filter((r) => st(r) === 'partial').length).toBe(kpi.breakdown.partial);
        for (const r of classic.filter((x) => st(x) === 'not_assessed' || st(x) === 'partial')) {
            expect(r.isReady == null ? null : r.isReady).toBeNull();
        }

        // API v1 readiness: the K1 state per person (additive fields; the
        // legacy isReady stays unchanged inside /api/v1), never "not ready"
        // for a person without a verdict
        for (const r of api) {
            expect([r.employeeId, r.readinessState]).toEqual([
                r.employeeId,
                kpiState.get(r.employeeId) || null,
            ]);
        }
        expect(api.find((r) => r.employeeId === w.D).readyForRole).toBeNull();
        expect(api.find((r) => r.employeeId === w.B).readyForRole).toBe(false);
        expect(api.find((r) => r.employeeId === w.A).readyForRole).toBe(true);
        expect(api.find((r) => r.employeeId === w.D).isReady).toBe(false); // legacy, deprecated

        // Power BI v2
        expect(pbi.headers['X-IDevelop-Feed-Version']).toBe('2');
        const rows = pbi.body.value;
        expect(pbi.body.feedVersion).toBe(2);
        const ready = rows.filter((r) => r.ReadinessState === 'ready').length;
        const notReady = rows.filter((r) => r.ReadinessState === 'not_ready').length;
        expect(ready).toBe(kpi.numerator);
        expect(ready + notReady).toBe(kpi.denominator);
        expect(Math.round((1000 * ready) / (ready + notReady)) / 10).toBe(kpi.value);
        const d = rows.find((r) => r.EmployeeID === w.D);
        expect(d.ReadinessState).toBe('not_assessed');
        expect(d.IsReady).toBeNull();
        expect(d.ReadinessStatus).toBe('Not assessed');
        expect(d.ReadinessReason).toBe('never_assessed');
    });

    test('the Power BI v1 readiness feed keeps its shape for one release and names its successor', async () => {
        const out = await tx(async (q) => {
            await W.world(db, F, q);
            const v1 = mockRes();
            await RC.powerbIReadiness(req(F.SUPER), v1);
            return v1;
        });
        expect(out.headers['X-IDevelop-Feed-Version']).toBe('1');
        expect(out.headers.Deprecation).toBe('true');
        expect(out.headers.Link).toBe('</api/powerbi/v2/readiness>; rel="successor-version"');
        const row = out.body.value[0];
        // the version 1 columns, unchanged: no K1 state column
        expect(Object.keys(row)).toEqual([
            'EmployeeID',
            'EmployeeNumber',
            'EmployeeName',
            'Site',
            'SiteID',
            'Department',
            'DepartmentID',
            'Service',
            'ServiceID',
            'Role',
            'RoleID',
            'TotalRequiredSkills',
            'AssessedRequiredSkills',
            'NeverAssessedSkills',
            'CoveragePercent',
            'SkillsMet',
            'SkillsNotMet',
            'CriticalSkillsMet',
            'CriticalSkillsTotal',
            'ReadinessPercent',
            'IsReady',
            'ReadinessStatus',
            'ReadinessCategory',
        ]);
    });

    test('the leaver and the erased person are absent from the readiness report, Power BI v2, the API and the builder', async () => {
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const rep = await RBS.k1Report({ viewer: F.SUPER });
            const pbi = mockRes();
            await RC.powerbIReadinessV2(req(F.SUPER), pbi);
            const classic = await RBS.executeReport(
                { dataSource: 'readiness', selectedFields: ['employeeName', 'readinessState'] },
                F.SUPER
            );
            const Api = require('../../src/api/v1/repository');
            const api = await Api.ReadinessRepository.list(F.SUPER, { limit: 1000 });
            return {
                w,
                repIds: rep.rows.map((r) => r.employee.id),
                pbiIds: pbi.body.value.map((r) => Number(r.EmployeeID)),
                apiIds: api.map((r) => r.employeeId),
                classicNames: classic.map((r) => r.employeeName || r.employeename),
            };
        });
        const { w } = out;
        for (const list of [out.repIds, out.pbiIds, out.apiIds]) {
            expect(list).toContain(w.A);
            expect(list).not.toContain(w.F);
            expect(list).not.toContain(w.G);
        }
        expect(out.classicNames.join('|')).toContain(`KpiA Fixture${W.STAMP}`);
        expect(out.classicNames.join('|')).not.toContain(`KpiF Fixture${W.STAMP}`);
        expect(out.classicNames.join('|')).not.toContain(`KpiG Fixture${W.STAMP}`);
    });

    test('a site filter outside the reader perimeter is not offered and is REJECTED, never answered "0 of 0"', async () => {
        const out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            const other = await db.get(
                `INSERT INTO sites (name, code) VALUES (?, ?) RETURNING id`,
                [`KPI-OTHER-${W.STAMP}`, `KO${W.STAMP}`]
            );
            const viewer = W.managerOf(w);
            const sites = await RBS.perimeterSites(viewer);
            const json = mockRes();
            await RC.readiness(
                req(viewer, { query: { format: 'json', site: String(other.id) } }),
                json
            );
            const page = mockRes();
            await RC.readiness(req(viewer, { query: { site: String(other.id) } }), page);
            const ok = mockRes();
            await RC.readiness(
                req(viewer, { query: { format: 'json', site: String(F.ORG.siteId) } }),
                ok
            );
            const csv = mockRes();
            await RC.readiness(req(viewer, { query: { format: 'csv' } }), csv);
            return { w, other, sites, json, page, ok, csv };
        });
        expect(out.sites.map((s) => String(s.id))).not.toContain(String(out.other.id));
        expect(out.sites.map((s) => String(s.id))).toContain(String(F.ORG.siteId));
        expect(out.sites.find((s) => s.id === 'none')).toBeTruthy(); // H
        expect(out.json.statusCode).toBe(400);
        expect(out.json.body.code).toBe('out_of_perimeter');
        expect(out.page.statusCode).toBe(400);
        expect(out.page.body.filterError).toBe('out_of_perimeter');
        expect(out.ok.statusCode).toBe(200);
        expect(out.ok.body.rows.map((r) => r.employee.id)).not.toContain(out.w.H);
        expect(out.ok.body.rows.map((r) => r.employee.id)).toContain(out.w.A);
        // CSV: the K1 state as words, a blank readiness for the never assessed
        const lines = String(out.csv.body).split('\n');
        expect(
            lines.some((l) => l.includes(`KPI-D-${W.STAMP}`) && l.includes('Not assessed'))
        ).toBe(true);
    });
});
