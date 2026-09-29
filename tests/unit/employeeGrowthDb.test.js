'use strict';

/**
 * Employee growth against the real schema: the target-role gap, the
 * closest-roles ranking and the manager's career-path tool must tell one person
 * the SAME story about the same role. Runs in one transaction that is always
 * rolled back; skipped (not failed) when no database is reachable.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_URL = Boolean(process.env.DATABASE_URL);
const ROLLBACK = new Error('employee-growth-rollback');
let db = null;
let ready = false;

beforeAll(async () => {
    if (!HAS_URL) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        ready = Boolean(
            await db.get(`SELECT 1 AS ok FROM employees e, domains d, admins a LIMIT 1`)
        );
    } catch (_) {
        ready = false;
    }
}, 30000);

afterAll(async () => {
    if (db && db.close) {
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    }
});

const itDb = (name, fn) =>
    test(
        name,
        async () => {
            if (!ready) return;
            try {
                await db.runTransaction(async () => {
                    await fn(await fixture());
                    throw ROLLBACK;
                });
            } catch (e) {
                if (e !== ROLLBACK) throw e;
            }
        },
        30000
    );

async function fixture() {
    const tpl = await db.get(
        'SELECT site_id, department_id, service_id FROM employees ORDER BY id LIMIT 1'
    );
    const domain = Number((await db.get('SELECT id FROM domains ORDER BY id LIMIT 1')).id);
    const admin = Number((await db.get('SELECT id FROM admins ORDER BY id LIMIT 1')).id);
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const id = async (sql, params) => Number((await db.get(sql, params)).id);
    const role = (n) =>
        id('INSERT INTO roles (name) VALUES (?) RETURNING id', [`EGDB-${n}-${stamp}`]);
    const skill = (n) =>
        id('INSERT INTO skills (domain_id, name) VALUES (?, ?) RETURNING id', [
            domain,
            `EGDB-${n}-${stamp}`,
        ]);
    const requires = (roleId, skillId, level, critical = false) =>
        db.run(
            'INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical) VALUES (?, ?, ?, ?)',
            [roleId, skillId, level, critical]
        );
    const assess = (employeeId, skillId, level) =>
        db.run(
            'INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by) VALUES (?, ?, ?, ?)',
            [employeeId, skillId, level, admin]
        );
    const employee = (roleId) =>
        id(
            `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id, service_id, role_id)
             VALUES (?, 'Eg', 'Db', ?, ?, ?, ?) RETURNING id`,
            [`EGDB-${stamp}`, tpl.siteId, tpl.departmentId, tpl.serviceId, roleId]
        );
    return { role, skill, requires, assess, employee, stamp };
}

describe('EmployeeGrowthService — against the database', () => {
    itDb('target gap, closest roles and career path agree', async (f) => {
        const Growth = require('../../src/services/EmployeeGrowthService');
        const current = await f.role('current');
        const target = await f.role('target');
        const other = await f.role('other');
        const [s1, s2, s3, s4] = [
            await f.skill('s1'),
            await f.skill('s2'),
            await f.skill('s3'),
            await f.skill('s4'),
        ];
        await f.requires(current, s1, 1);
        await f.requires(target, s1, 3);
        await f.requires(target, s2, 3, true);
        await f.requires(target, s3, 2); // never assessed
        await f.requires(target, s4, 0); // NOT required
        await f.requires(other, s1, 2);
        await f.requires(other, s2, 1);
        const me = await f.employee(current);
        await f.assess(me, s1, 3);
        await f.assess(me, s2, 1);
        await db.run(
            'INSERT INTO employee_aspirations (employee_id, target_role_id) VALUES (?, ?)',
            [me, target]
        );

        const gap = await Growth.targetRoleGap(me);
        expect(gap.roleId).toBe(target);
        expect(gap.total).toBe(3); // the level-0 row is not a requirement
        expect(gap.metRows.map((r) => r.current)).toEqual([3]);
        expect(gap.growRows).toHaveLength(1);
        expect(gap.growRows[0]).toMatchObject({ current: 1, required: 3, gap: 2, critical: true });
        expect(gap.unmeasuredRows).toHaveLength(1);
        expect(gap.unmeasuredRows[0]).toMatchObject({ current: null, gap: null });
        expect(gap.readiness).toBe(50); // 1 met of 2 measured
        expect(gap.coverage).toBe(67);

        const closest = await Growth.closestRoles(me, { limit: 50 });
        const ids = closest.map((c) => c.roleId);
        expect(ids).not.toContain(current); // the role they already hold
        expect(ids.indexOf(other)).toBeLessThan(ids.indexOf(target)); // 100 % before 50 %
        const t = closest.find((c) => c.roleId === target);
        expect(t).toMatchObject({ readiness: gap.readiness, measured: 2, total: 3, met: 1 });

        // The manager's career-path tool reads the same numbers.
        const ctrl = require('../../src/controllers/TalentActionsController');
        const RBACService = require('../../src/services/RBACService');
        jest.spyOn(RBACService, 'isSuperAdmin').mockReturnValue(true);
        let body = null;
        await ctrl.careerPathData(
            { query: { employeeId: me, targetRoleId: target }, user: { id: 1, userType: 'admin' } },
            {
                status() {
                    return this;
                },
                json(b) {
                    body = b;
                    return this;
                },
            }
        );
        expect(body).toMatchObject({
            readiness: gap.readiness,
            coverage: gap.coverage,
            met: gap.met,
            total: gap.total,
            measured: gap.measured,
            unmeasured: gap.unmeasured,
            gaps: gap.gaps,
            criticalGaps: gap.criticalGaps,
        });
    });

    itDb('no target role → no gap; nothing measured → no ranking', async (f) => {
        const Growth = require('../../src/services/EmployeeGrowthService');
        const r = await f.role('solo');
        const s = await f.skill('solo');
        await f.requires(r, s, 2);
        const me = await f.employee(r);
        expect(await Growth.targetRoleGap(me)).toBeNull();
        const closest = await Growth.closestRoles(me);
        expect(closest.every((c) => c.measured > 0)).toBe(true);
    });
});
