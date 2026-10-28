'use strict';
/**
 * The Power BI assessments feed, version 2 (/api/powerbi/v2/assessments): its
 * contract, on the REAL test database (tests/helpers/kpiWorld.js, inside a
 * transaction that is always rolled back; invented people only).
 *
 *   - the population is the key owner's K1 population: the leaver and the
 *     erased person are absent, a reader with nobody in scope gets nothing;
 *   - a requirement row carries the level the indicators count; while the
 *     skill is not assessed, LevelUsed, MeetsRequirement and Gap are NULL;
 *   - a level above the requirement is never credited (Gap 0, never negative);
 *   - an assessed skill the role does not require is neither met nor missed;
 *   - the people whose every requirement is met are exactly K1's « ready »;
 *   - version 1 keeps its route and answers as deprecated, pointing to v2;
 *   - the column list is pinned.
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
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (c) => {
        res.statusCode = c;
        return res;
    };
    res.json = (b) => {
        res.body = b;
        return res;
    };
    res.setHeader = (k, v) => {
        res.headers[k] = v;
    };
    return res;
}
const req = (user) => ({ user, query: {}, headers: {}, protocol: 'http', get: () => 'localhost' });

const COLUMNS = [
    'AssessmentID',
    'EmployeeID',
    'EmployeeNumber',
    'EmployeeName',
    'SkillID',
    'SkillName',
    'DomainID',
    'DomainName',
    'CurrentLevel',
    'LevelUsed',
    'IsRequired',
    'RequiredLevel',
    'IsCritical',
    'IsAssessed',
    'CertLapsed',
    'MeetsRequirement',
    'Gap',
    'AssessedBy',
    'AssessedDate',
];

suite('Power BI assessments v2 — the levels the indicators count', () => {
    let out;
    beforeAll(async () => {
        out = await tx(async (q) => {
            const w = await W.world(db, F, q);
            // A exceeds the requirement on S3, and holds a skill the role does not require.
            await db.run(
                'UPDATE skill_assessments SET current_level = 4 WHERE employee_id = ? AND skill_id = ?',
                [w.A, w.S3]
            );
            const dom = await db.get('SELECT domain_id AS d FROM skills WHERE id = ?', [w.S1]);
            const extra = await db.get(
                'INSERT INTO skills (domain_id, name) VALUES (?, ?) RETURNING id',
                [Number(dom.d), 'Feed fixture skill ' + W.STAMP]
            );
            const S4 = Number(extra.id);
            await db.run(
                `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
                 VALUES (?, ?, 3, ?, 'feed fixture')`,
                [w.A, S4, F.adminId]
            );
            const viewer = W.managerOf(w);
            const v2 = mockRes();
            await RC.powerbIAssessmentsV2(req(viewer), v2);
            const sup = mockRes();
            await RC.powerbIAssessmentsV2(req(F.SUPER), sup);
            const nobody = mockRes();
            await RC.powerbIAssessmentsV2(
                req({ id: w.A, userType: 'manager', role: 'manager' }),
                nobody
            );
            const v1 = mockRes();
            await RC.powerbIAssessments(req(viewer), v1);
            const k1 = await K.k1RoleReady({ viewer });
            return { w, S4, v2, sup, nobody, v1, k1 };
        });
    });
    const rowsOf = (id) => out.v2.body.value.filter((r) => r.EmployeeID === id);
    const cell = (id, skill) => rowsOf(id).find((r) => r.SkillID === skill);

    test('version headers, contract and column list', () => {
        expect(out.v2.statusCode).toBe(200);
        expect(out.v2.headers['X-IDevelop-Feed-Version']).toBe('2');
        expect(out.v2.body.feedVersion).toBe(2);
        expect(out.v2.body.kpiContract).toBe(K.CONTRACT_VERSION);
        expect(out.v2.body['@odata.context']).toBe('http://localhost/api/powerbi/v2/assessments');
        expect(out.v2.body.value.length).toBeGreaterThan(0);
        for (const r of out.v2.body.value) expect(Object.keys(r)).toEqual(COLUMNS);
        // no free text in version 2
        expect(JSON.stringify(out.v2.body)).not.toContain('KPI fixture');
    });

    test('the population is K1’s: no leaver, no erased person, nothing outside scope', () => {
        const people = new Set(out.v2.body.value.map((r) => r.EmployeeID));
        const { w } = out;
        for (const t of ['A', 'B', 'C', 'D', 'E', 'H']) expect(people.has(w[t])).toBe(true);
        expect(people.has(w.F)).toBe(false);
        expect(people.has(w.G)).toBe(false);
        const all = new Set(out.sup.body.value.map((r) => r.EmployeeID));
        expect(all.has(w.F)).toBe(false);
        expect(all.has(w.G)).toBe(false);
        expect(out.nobody.body.value).toEqual([]);
    });

    test('a required skill not yet assessed is NULL, never a failure', () => {
        const { w } = out;
        const d = rowsOf(w.D);
        expect(d).toHaveLength(3);
        for (const r of d) {
            expect(r).toMatchObject({
                IsRequired: true,
                RequiredLevel: 2,
                IsAssessed: false,
                LevelUsed: null,
                MeetsRequirement: null,
                Gap: null,
                CurrentLevel: null,
                AssessmentID: null,
            });
        }
        // C assessed S2 only: S1 and S3 stay NULL
        expect(cell(w.C, w.S2)).toMatchObject({ IsAssessed: true, MeetsRequirement: true, Gap: 0 });
        expect(cell(w.C, w.S1)).toMatchObject({ IsAssessed: false, MeetsRequirement: null });
    });

    test('a missed requirement reads its gap; the critical flag travels', () => {
        const { w } = out;
        expect(cell(w.B, w.S1)).toMatchObject({
            IsCritical: true,
            CurrentLevel: 1,
            LevelUsed: 1,
            MeetsRequirement: false,
            Gap: 1,
            CertLapsed: false,
        });
    });

    test('a level above the requirement is not credited: the gap is 0, never negative', () => {
        const { w } = out;
        expect(cell(w.A, w.S3)).toMatchObject({
            CurrentLevel: 4,
            RequiredLevel: 2,
            MeetsRequirement: true,
            Gap: 0,
        });
        for (const r of out.v2.body.value)
            if (r.Gap != null) expect(r.Gap).toBeGreaterThanOrEqual(0);
    });

    test('a skill the role does not require is neither met nor missed', () => {
        const { w, S4 } = out;
        expect(cell(w.A, S4)).toMatchObject({
            IsRequired: false,
            RequiredLevel: null,
            CurrentLevel: 3,
            IsAssessed: null,
            MeetsRequirement: null,
            Gap: null,
        });
    });

    test('the people with every requirement met are exactly K1’s ready', () => {
        const byPerson = new Map();
        for (const r of out.v2.body.value) {
            if (!r.IsRequired) continue;
            const list = byPerson.get(r.EmployeeID) || [];
            list.push(r);
            byPerson.set(r.EmployeeID, list);
        }
        const allMet = [...byPerson.entries()]
            .filter(([, list]) => list.every((r) => r.MeetsRequirement === true))
            .map(([id]) => id)
            .sort((a, b) => a - b);
        const ready = (out.k1.drillByState.ready || []).map(Number).sort((a, b) => a - b);
        expect(allMet).toEqual(ready);
        expect(ready).toHaveLength(4);
    });

    test('version 1 is kept for one release, marked deprecated, pointing to version 2', () => {
        expect(out.v1.headers['X-IDevelop-Feed-Version']).toBe('1');
        expect(out.v1.headers.Deprecation).toBe('true');
        expect(out.v1.headers.Link).toBe('</api/powerbi/v2/assessments>; rel="successor-version"');
    });
});

describe('the route and the API-key page (static)', () => {
    const fs = require('fs');
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

    test('the v2 route takes the same API-key gate as every Power BI feed', () => {
        const routes = read('src/routes/index.js');
        expect(routes).toContain(
            "router.get('/api/powerbi/v2/assessments', requireApiKey, ReportController.powerbIAssessmentsV2);"
        );
        expect(routes).toContain(
            "router.get('/api/powerbi/assessments', requireApiKey, ReportController.powerbIAssessments);"
        );
    });

    test('the person ids are bound, never written into the SQL text', () => {
        const src = read('src/controllers/ReportController.js');
        const body = src.slice(
            src.indexOf('async powerbIAssessmentsV2('),
            src.indexOf('async powerbIReadiness(')
        );
        expect(body).toContain('WHERE g.employee_id = ANY(?)');
        expect(body).toContain('[ids, ids]');
        expect(body).not.toMatch(/\$\{(?!req\.protocol|req\.get|ASSESSMENTS_FEED_V2)/);
    });

    test('the API-key page lists every feed', () => {
        const page = read('views/pages/admin/api-keys.ejs');
        for (const f of [
            'employees',
            'v2/assessments',
            'assessments',
            'v2/readiness',
            'readiness',
            'organization',
            'certifications',
            'coverage',
            'ninebox',
            'pips',
            'idp',
            'coaching',
            'goals',
        ])
            expect(page).toContain(`<code>/api/powerbi/${f}</code>`);
        for (const lang of ['en', 'fr']) {
            const a = JSON.parse(read(`locales/${lang}/admin.json`));
            for (const k of [
                'apik_feed_assessments_v2',
                'apik_feed_goals',
                'apik_feed_versions_note',
            ])
                expect(a[k]).toBeTruthy();
        }
    });
});
