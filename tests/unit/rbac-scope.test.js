'use strict';

// Integration test for clearance scoping. Seeds its own isolated org so it
// works against a fresh CI Postgres. Skipped entirely when no DATABASE_URL.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = !!process.env.DATABASE_URL;
const suite = HAS_DB ? describe : describe.skip;

suite('RBAC scoping (integration)', () => {
    let db, RBAC, EmployeeModel, AdminModel;
    const T = 'ZZTEST';
    const ids = {};

    beforeAll(async () => {
        db = require('../../src/config/database');
        RBAC = require('../../src/services/RBACService');
        EmployeeModel = require('../../src/models/EmployeeModel');
        AdminModel = require('../../src/models/AdminModel');
        await db.connect();

        const ins = async (sql, params) => {
            await db.run(sql, params);
        };
        const id = async (sql, params) => Number((await db.get(sql, params)).id);

        await ins('INSERT INTO sites (name, isActive) VALUES (?, true)', [`${T}_Site`]);
        ids.site = await id('SELECT id FROM sites WHERE name = ?', [`${T}_Site`]);
        await ins('INSERT INTO departments (name, siteId, isActive) VALUES (?, ?, true)', [
            `${T}_Dept`,
            ids.site,
        ]);
        ids.dept = await id('SELECT id FROM departments WHERE name = ?', [`${T}_Dept`]);
        await ins('INSERT INTO services (name, departmentId, isActive) VALUES (?, ?, true)', [
            `${T}_Svc`,
            ids.dept,
        ]);
        ids.svc = await id('SELECT id FROM services WHERE name = ?', [`${T}_Svc`]);
        await ins('INSERT INTO roles (name, isActive) VALUES (?, true)', [`${T}_Role`]);
        ids.role = await id('SELECT id FROM roles WHERE name = ?', [`${T}_Role`]);

        const emp = async (num, supId) => {
            await ins(
                `INSERT INTO employees (employeeNumber, firstName, lastName, siteId, departmentId, serviceId, roleId, supervisorId, isActive)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, true)`,
                [num, T, num, ids.site, ids.dept, ids.svc, ids.role, supId || null]
            );
            return id('SELECT id FROM employees WHERE employeeNumber = ?', [num]);
        };
        ids.mgr = await emp(`${T}-MGR`, null);
        ids.r1 = await emp(`${T}-R1`, ids.mgr);
        ids.r2 = await emp(`${T}-R2`, ids.mgr);
        ids.sub = await emp(`${T}-SUB`, ids.r1); // report-of-report (sub-tree)
        ids.unrel = await emp(`${T}-UNREL`, null); // not under the manager

        await ins(
            'INSERT INTO admins (username, password_hash, role, is_active) VALUES (?, ?, ?, true)',
            [`${T}_localadmin`, 'x', 'localadmin']
        );
        ids.admin = await id('SELECT id FROM admins WHERE username = ?', [`${T}_localadmin`]);
        await ins('INSERT INTO admin_scopes (admin_id, scope_type, service_id) VALUES (?, ?, ?)', [
            ids.admin,
            'service',
            ids.svc,
        ]);
    });

    afterAll(async () => {
        if (!db) return;
        try {
            await db.run('DELETE FROM admin_scopes WHERE admin_id = ?', [ids.admin]);
            await db.run('DELETE FROM admins WHERE username = ?', [`${T}_localadmin`]);
            await db.run('DELETE FROM employees WHERE employeeNumber LIKE ?', [`${T}-%`]);
            await db.run('DELETE FROM roles WHERE name = ?', [`${T}_Role`]);
            await db.run('DELETE FROM services WHERE name = ?', [`${T}_Svc`]);
            await db.run('DELETE FROM departments WHERE name = ?', [`${T}_Dept`]);
            await db.run('DELETE FROM sites WHERE name = ?', [`${T}_Site`]);
        } finally {
            await db.close();
        }
    });

    test('manager governs their full reporting sub-tree (reports + reports-of-reports), not others', async () => {
        const governed = await EmployeeModel.findGovernedIds(ids.mgr);
        expect(governed).toEqual(expect.arrayContaining([ids.r1, ids.r2, ids.sub]));
        expect(governed).not.toContain(ids.unrel);
        expect(governed).not.toContain(ids.mgr); // a manager does not govern themselves
    });

    test('getFilteredEmployees scopes a manager to their sub-tree', async () => {
        const list = await RBAC.getFilteredEmployees({ id: ids.mgr, userType: 'manager' });
        const nums = list.map((e) => e.employeeNumber);
        expect(nums).toEqual(expect.arrayContaining([`${T}-R1`, `${T}-R2`, `${T}-SUB`]));
        expect(nums).not.toContain(`${T}-UNREL`);
    });

    test('local admin sees only employees within their service scope', async () => {
        const admin = { ...(await AdminModel.findWithScopes(ids.admin)), userType: 'admin' };
        const list = await RBAC.getFilteredEmployees(admin);
        const inScope = list.filter((e) => Number(e.serviceId) === Number(ids.svc));
        // every returned employee is in the scoped service, and our seeded ones appear
        expect(list.length).toBe(inScope.length);
        const nums = list.map((e) => e.employeeNumber);
        expect(nums).toEqual(expect.arrayContaining([`${T}-MGR`, `${T}-R1`]));
    });

    test('super admin is unrestricted', async () => {
        const list = await RBAC.getFilteredEmployees({
            id: 1,
            userType: 'admin',
            role: 'superadmin',
        });
        const nums = list.map((e) => e.employeeNumber);
        // sees both the scoped service AND the unrelated employee
        expect(nums).toEqual(expect.arrayContaining([`${T}-MGR`, `${T}-UNREL`]));
    });
});
