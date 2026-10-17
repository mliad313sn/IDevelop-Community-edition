'use strict';
/**
 * The capability rule on the real test database (src/utils/capability.js):
 * « no role or unit figure above 100 %; a surplus never offsets a gap;
 * another role re-evaluates against ITS requirement ». The invented KPI world
 * (tests/helpers/kpiWorld.js) is given surplus levels on purpose, inside a
 * transaction that is always rolled back; test 0 proves the surplus exists, so
 * no property below is vacuously true.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/kpiWorld');
const CAP = require('../../src/utils/capability');
const HM = require('../../src/utils/heatModel');

const HAS_DB = isTestDatabaseUrl(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(180000);

const EPS = 1e-9;
let db;
let facts;

/** The KPI world with surplus levels: A and A2 at 4 on S2, B at 4 on S3 (required 2). */
async function surplusWorld(q) {
    const w = await W.world(db, facts, q);
    // the role matrix lists skills by sub-domain: give the three skills one
    const sd = await db.get(
        `INSERT INTO sub_domains (domain_id, name)
         SELECT domain_id, ? FROM skills WHERE id = ? RETURNING id`,
        [`CAP-SUB-${W.STAMP}`, w.S1]
    );
    await db.run(
        'UPDATE skills SET sub_domain_id = ? WHERE id = ANY(?) AND sub_domain_id IS NULL',
        [Number(sd.id), [w.S1, w.S2, w.S3]]
    );
    for (const [e, s] of [
        [w.A, w.S2],
        [w.A2, w.S2],
        [w.B, w.S3],
    ])
        await db.run(
            'UPDATE skill_assessments SET current_level = 4 WHERE employee_id = ? AND skill_id = ?',
            [e, s]
        );
    const r2 = await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [
        `CAP-TARGET-${W.STAMP}`,
    ]);
    const R2 = Number(r2.id);
    // the target role asks MORE on S2 and S3 than the people's own role
    await db.run(
        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
         VALUES (?, ?, 4, false), (?, ?, 3, false)`,
        [R2, w.S2, R2, w.S3]
    );
    return { ...w, R2, ids: W.fixtureIds(w) };
}

suite('capability rule on the test database (rolled back)', () => {
    beforeAll(async () => {
        db = require('../../src/config/database');
        await db.connect();
        facts = await W.seedFacts(db);
    });
    afterAll(async () => {
        await db.close();
    });

    test('0 to 6 — every surface credits at most the requirement', async () => {
        const D = require('../../src/services/DashboardHomeService');
        const B = require('../../src/models/BenchmarkModel');
        const DM = require('../../src/models/DashboardModel');
        const G = require('../../src/services/EmployeeGrowthService');
        const K = require('../../src/services/KpiService');
        const out = await W.inRolledBackTx(db, async (q) => {
            const w = await surplusWorld(q);
            const surplus = await db.get(
                `SELECT COUNT(*)::int AS "cells" FROM v_employee_skill_gaps
                  WHERE is_assessed = 1 AND actual_level > required_level AND employee_id = ANY(?)`,
                [w.ids]
            );
            const raw = await db.all(
                `SELECT domain_id::text AS "key",
                        AVG(GREATEST(required_level - actual_level, 0)) AS "pos",
                        AVG(required_level - actual_level) AS "signed"
                   FROM v_employee_skill_gaps
                  WHERE is_assessed = 1 AND employee_id = ANY(?)
                  GROUP BY domain_id`,
                [w.ids]
            );
            return {
                w,
                surplus: surplus.cells,
                raw,
                profile: await D.capabilityProfile(w.ids, 'domain'),
                skills: await D.capabilityProfile(w.ids, 'skill'),
                heat: await D.capabilityHeat(w.ids, 'site', 'domain'),
                sub: await D.capabilityHeat(w.ids, 'department', 'subdomain'),
                map: await D.capabilityMap(w.ids, 'site'),
                tree: await D.frameworkTree(),
                occupants: await B.getRoleOccupants(w.R, {}),
                radar: await DM.getOrgDomainRadar({}),
                own: await G.roleGap(w.A, w.R),
                target: await G.roleGap(w.A, w.R2),
                k2: await K.compute('K2', { system: true, employeeIds: w.ids }),
            };
        });

        // 0 — the surplus is real (A, A2 and B are above the requirement)
        expect(out.surplus).toBe(3);

        // 1 — profiles: demonstrated never above the requirement, the gap never negative
        for (const p of [...out.profile, ...out.skills].filter((x) => x.actual !== null))
            expect(p.actual).toBeLessThanOrEqual(p.required + EPS);
        // the pillar gap IS the mean POSITIVE gap: the signed mean would hide part of it
        let hidden = false;
        for (const x of out.raw) {
            const p = out.profile.find((y) => y.key === x.key);
            expect(p.required - p.actual).toBeCloseTo(Number(x.pos), 2);
            if (Math.abs(Number(x.pos) - Number(x.signed)) > 0.01) hidden = true;
        }
        expect(hidden).toBe(true);

        // 2 — heat cubes and the capability map: Σ credited ≤ Σ required everywhere
        for (const rows of [out.heat, out.sub, out.map])
            for (const x of rows)
                if (x.sumRequired !== null)
                    expect(x.sumActual).toBeLessThanOrEqual(x.sumRequired + EPS);

        // 3 — the models print no value above 100 % and no « above » step
        const heatM = HM.heatModel(out.heat, { kind: 'attain' });
        const mapM = HM.capabilityMapModel(out.map, out.tree, { unit: 'site' });
        for (const m of [heatM, mapM]) {
            const cells = [m.total, ...(m.cols || []).map((c) => c.marg)];
            (m.rows || []).forEach((x) => {
                cells.push(x.marg, ...x.cells);
                (x.children || []).forEach((k) => cells.push(k.marg, ...k.cells));
            });
            for (const c of cells.filter((x) => x && x.state === 'ok')) {
                expect(c.value).toBeLessThanOrEqual(1);
                expect(c.bin).not.toMatch(/above/);
            }
        }

        // 4 — the benchmark role matrix shows the CREDITED level
        let cells = 0;
        for (const d of out.occupants.domains)
            for (const sd of d.subs)
                for (const sk of sd.skills)
                    for (const c of Object.values(sk.cells))
                        if (c.assessed) {
                            expect(c.actual).toBeLessThanOrEqual(sk.required);
                            cells++;
                        }
        expect(cells).toBeGreaterThan(0);
        for (const o of out.occupants.occupants)
            if (o.fit !== null) expect(o.fit).toBeLessThanOrEqual(100);

        // 5 — the requirement-relative radar never plots above the requirement
        for (const x of out.radar)
            if (x.avgActual !== null) expect(x.avgActual).toBeLessThanOrEqual(x.avgRequired + EPS);

        // 6 — another role re-evaluates: A meets every requirement of the own role
        //     (2, 4, 2 against 2) and only S2 of the target (4 against 4; S3 2 < 3)
        expect(out.own).toMatchObject({ met: 3, gaps: 0, readiness: 100 });
        expect(out.target).toMatchObject({ met: 1, gaps: 1, readiness: 50 });
        expect(out.target.growRows.map((x) => x.gap)).toEqual([1]);

        // K2 stays at most 100 % with the surplus in the population
        if (out.k2.rawValue !== null) expect(out.k2.rawValue).toBeLessThanOrEqual(100);
        // and the helper agrees with K2's per-person credited sum for A2 (2 + 2 + 2 of 6)
        expect(
            CAP.roleAttainment([
                { actual: 2, required: 2 },
                { actual: 4, required: 2 },
                { actual: 2, required: 2 },
            ]).ratio
        ).toBe(1);
    });
});
