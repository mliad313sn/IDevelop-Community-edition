'use strict';
/**
 * The authority-ladder fixture world, shared by the ladder suites. Invented
 * people only. Every call must run INSIDE a transaction the suite rolls back
 * (inRolledBackTx): nothing is left behind.
 *
 * The organisation (one site / department / service of the test seed):
 *
 *   N2  heads M (M.manager = N2)                     the line ABOVE P
 *   M   manager of P and of Q                        also Q's supervisor (the union)
 *   S   supervisor of P
 *   P   the subject: supervisor S, manager M
 *   Q   supervisor M, manager M
 *   R   managed by the ADMIN account NAMED (manager_type 'admin')
 *
 * Administration accounts:
 *   LA_IN    local admin, clearance over the service, no permission
 *   LA_SLUG  local admin, same clearance, manage_talent_reviews + approve_assessments
 *   LA_OUT   local admin with no clearance at all
 *   ADMIN_S  local admin linked to the person S, no clearance
 *   NAMED    local admin named manager of R, no clearance
 *   VIEWER   viewer linked to the person M, clearance over the service (read-only)
 *   SUPER    SuperAdmin
 */

const ROLLBACK = new Error('__LADDER_WORLD_ROLLBACK__');

async function inRolledBackTx(db, fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            out = await fn(db._txStore.getStore());
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
    return out;
}

async function build(db) {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-10);
    const org = await db.get(
        `SELECT sv.id AS "serviceId", sv.department_id AS "departmentId", d.site_id AS "siteId"
           FROM services sv JOIN departments d ON d.id = sv.department_id
          ORDER BY sv.id LIMIT 1`
    );
    const role = await db.get('SELECT id FROM roles ORDER BY id LIMIT 1');
    const emp = async (tag) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, email, site_id,
                                            department_id, service_id, role_id, is_active)
                     VALUES (?, ?, 'Ladder', ?, ?, ?, ?, ?, true) RETURNING id`,
                    [
                        `LAD-${tag}-${stamp}`,
                        `Person${tag}`,
                        `ladder.${tag.toLowerCase()}.${stamp}@example.test`,
                        org.siteId,
                        org.departmentId,
                        org.serviceId,
                        role ? role.id : null,
                    ]
                )
            ).id
        );
    const adm = async (tag, roleName, { linked = null, scope = false, perms = [] } = {}) => {
        const id = Number(
            (
                await db.get(
                    `INSERT INTO admins (username, email, password_hash, role, is_active,
                                         force_password_change, linked_employee_id)
                     VALUES (?, ?, 'x', ?, true, false, ?) RETURNING id`,
                    [
                        `ladder-${tag.toLowerCase()}-${stamp}`,
                        `ladder-admin.${tag.toLowerCase()}.${stamp}@example.test`,
                        roleName,
                        linked,
                    ]
                )
            ).id
        );
        if (scope)
            await db.run(
                `INSERT INTO admin_scopes (admin_id, scope_type, service_id) VALUES (?, 'service', ?)`,
                [id, org.serviceId]
            );
        for (const p of perms)
            await db.run('INSERT INTO admin_permissions (admin_id, permission) VALUES (?, ?)', [
                id,
                p,
            ]);
        return id;
    };

    const N2 = await emp('N2');
    const M = await emp('M');
    const S = await emp('S');
    const P = await emp('P');
    const Q = await emp('Q');
    const R = await emp('R');
    const LA_IN = await adm('LA_IN', 'localadmin', { scope: true });
    const LA_SLUG = await adm('LA_SLUG', 'localadmin', {
        scope: true,
        perms: ['manage_talent_reviews', 'approve_assessments'],
    });
    const LA_OUT = await adm('LA_OUT', 'localadmin');
    const ADMIN_S = await adm('ADMIN_S', 'localadmin', { linked: S });
    const NAMED = await adm('NAMED', 'localadmin');
    const VIEWER = await adm('VIEWER', 'viewer', {
        linked: M,
        scope: true,
        perms: ['manage_talent_reviews', 'approve_assessments'],
    });
    const SUPER = await adm('SUPER', 'superadmin');

    await db.run("UPDATE employees SET manager_id = ?, manager_type = 'employee' WHERE id = ?", [
        N2,
        M,
    ]);
    await db.run(
        "UPDATE employees SET supervisor_id = ?, manager_id = ?, manager_type = 'employee' WHERE id = ?",
        [S, M, P]
    );
    await db.run(
        "UPDATE employees SET supervisor_id = ?, manager_id = ?, manager_type = 'employee' WHERE id = ?",
        [M, M, Q]
    );
    await db.run("UPDATE employees SET manager_id = ?, manager_type = 'admin' WHERE id = ?", [
        NAMED,
        R,
    ]);
    try {
        require('../../src/services/GovernanceService').clearLineAuthorityCache();
    } catch (_) {
        /* optional */
    }
    return {
        org,
        people: { N2, M, S, P, Q, R },
        admins: { LA_IN, LA_SLUG, LA_OUT, ADMIN_S, NAMED, VIEWER, SUPER },
    };
}

/** The user object deserializeUser would put on req.user. */
async function hydrate(db, spec) {
    if (spec.employee != null) {
        const EmployeeModel = require('../../src/models/EmployeeModel');
        const gov = await EmployeeModel.governanceOf(spec.employee);
        return {
            id: Number(spec.employee),
            userType: gov.governs ? 'manager' : 'employee',
            isManager: Boolean(gov.governs),
        };
    }
    const a = await db.get('SELECT id, username, role FROM admins WHERE id = ?', [spec.admin]);
    const perms = await db.all('SELECT permission FROM admin_permissions WHERE admin_id = ?', [
        spec.admin,
    ]);
    return {
        id: Number(a.id),
        username: a.username,
        role: a.role,
        userType: 'admin',
        permissions: perms.map((r) => r.permission),
    };
}

/** Run an Express middleware on a fake JSON request: true when it calls next(). */
function passes(mw, user, body = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            user,
            body,
            params: {},
            query: {},
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            method: 'POST',
            originalUrl: '/probe',
            path: '/probe',
            xhr: true,
            isAuthenticated: () => Boolean(user),
            get: (h) => (/accept/i.test(h) ? 'application/json' : undefined),
            accepts: () => 'json',
            flash: () => {},
            t: null,
            session: {},
        };
        const res = {
            locals: {},
            statusCode: 200,
            status(c) {
                this.statusCode = c;
                return this;
            },
            json() {
                resolve(false);
                return this;
            },
            render() {
                resolve(false);
            },
            redirect() {
                resolve(false);
            },
            set() {
                return this;
            },
            setHeader() {},
        };
        try {
            mw(req, res, (err) => (err ? reject(err) : resolve(true)));
        } catch (e) {
            reject(e);
        }
    });
}

module.exports = { inRolledBackTx, build, hydrate, passes };
