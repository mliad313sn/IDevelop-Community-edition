'use strict';

/**
 * T5 — a red-zone talent task for an admin-managed employee reached nobody.
 *
 * The task is addressed to the person's hierarchical superior, resolved by
 * _supervisorOf = COALESCE(supervisor_id, manager_id WHERE manager_type='employee').
 * ~4 people here are managed DIRECTLY by an admin, with no employee superior, so
 * that expression is NULL: the task was raised with assignee NULL and the
 * notification was skipped, so the managing admin — who can see the task in their
 * queue — was never told a placement had asked them to decide on a PIP.
 *
 * DevelopmentTriggerService now falls back to the managing admin (the polymorphic
 * manager_id when manager_type='admin') and notifies them as an admin recipient,
 * so the task always reaches a human. Applies to both the red-zone PIP task and
 * the blue-zone IDP notification.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const norm = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\s+/g, ' ');

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
let svc;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
    svc = require('../../src/services/DevelopmentTriggerService');
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('an admin-managed employee’s talent task reaches the managing admin', () => {
    let adminManaged = null; // { id, managerId }
    let employeeManaged = null; // { id, sup }

    beforeAll(async () => {
        adminManaged = await db.get(
            `SELECT id, manager_id AS "managerId" FROM employees
              WHERE is_active = true AND manager_type = 'admin' AND manager_id IS NOT NULL
                AND supervisor_id IS NULL LIMIT 1`
        );
        employeeManaged = await db.get(
            `SELECT id, COALESCE(supervisor_id, CASE WHEN manager_type='employee' THEN manager_id END) AS sup
               FROM employees
              WHERE is_active = true
                AND COALESCE(supervisor_id, CASE WHEN manager_type='employee' THEN manager_id END) IS NOT NULL
              LIMIT 1`
        );
    });

    test('fixtures exist (an admin-managed and an employee-managed person)', () => {
        expect(adminManaged && adminManaged.id).toBeTruthy();
        expect(employeeManaged && employeeManaged.id).toBeTruthy();
    });

    test('_managingAdminOf resolves the admin for an admin-managed employee, null otherwise', async () => {
        expect(await svc._managingAdminOf(adminManaged.id)).toBe(Number(adminManaged.managerId));
        expect(await svc._managingAdminOf(employeeManaged.id)).toBeNull();
    });

    test('_notifyManager routes an admin-managed employee to the managing admin, and writes the notification', async () => {
        await db
            .runTransaction(async () => {
                const r = await svc._notifyManager(
                    adminManaged.id,
                    'talent.task.created',
                    '/v2/pip'
                );
                expect(r).toEqual({ userType: 'admin', userId: Number(adminManaged.managerId) });
                const n = await db.get(
                    `SELECT user_type, user_id FROM notifications
                  WHERE user_type = 'admin' AND user_id = ? AND kind = 'talent.task.created'
                  ORDER BY id DESC LIMIT 1`,
                    [adminManaged.managerId]
                );
                expect(n).toBeTruthy(); // the managing admin really got a row
                throw new Error('__ROLLBACK__');
            })
            .catch((e) => {
                if (!/__ROLLBACK__/.test(e.message)) throw e;
            });
    });

    test('_notifyManager still routes an employee-managed person to their employee superior', async () => {
        await db
            .runTransaction(async () => {
                const r = await svc._notifyManager(
                    employeeManaged.id,
                    'talent.task.created',
                    '/v2/pip'
                );
                expect(r).toEqual({ userType: 'employee', userId: Number(employeeManaged.sup) });
                throw new Error('__ROLLBACK__');
            })
            .catch((e) => {
                if (!/__ROLLBACK__/.test(e.message)) throw e;
            });
    });
});

describe('the trigger routes notifications through _notifyManager (admin fallback)', () => {
    const src = norm('src/services/DevelopmentTriggerService.js');

    test('the red-zone path no longer drops the signal when there is no employee superior', () => {
        expect(src).toMatch(/_notifyManager\(\s*employeeId,\s*'talent\.task\.created'/);
        // the old "sup = task.assigneeId || _supervisorOf; if (sup) notify" is gone
        expect(src).not.toMatch(/const sup = task\.assigneeId \|\| \(await this\._supervisorOf/);
    });

    test('_notifyManager falls back to the managing admin', () => {
        expect(src).toMatch(/_managingAdminOf\(employeeId\)/);
        expect(src).toMatch(/userType: 'admin'/);
    });
});
