'use strict';
/**
 * The KPI fixture world, shared by the KPI reconciliation suites
 * (c326-DK, c326-DR, c327-C). Invented people only. Every call must run
 * INSIDE a transaction the suite rolls back (inRolledBackTx): nothing is
 * left behind, the history rows the skill_assessments trigger writes
 * included.
 *
 * One new role R with three requirements (S1 critical, level 2 each), one
 * site / department / service of the test seed, a manager M governing
 * everyone through supervisor_id:
 *   A, A2, A3, A4  all met                                -> ready
 *   B              all assessed, S1 (critical) at 1        -> not_ready
 *   C              S2 only, met                            -> partial
 *   D              nothing assessed                        -> not_assessed
 *   E              S1 assessed at 1, nothing else          -> not_ready (known critical fail)
 *   F  LEAVER      all met + an active plan                -> absent everywhere
 *   G  ERASED      (still is_active) all met + active plan -> absent everywhere
 *   H  NO SITE     nothing assessed                        -> "No site", not_assessed
 *   M  manager, on a role without requirements            -> no_requirement
 * A local administrator L is created with a service scope over the fixture
 * service.
 */

const ROLLBACK = new Error('__KPI_WORLD_ROLLBACK__');

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

const STAMP = `${Date.now()}`.slice(-7);
const TAGS = ['M', 'A', 'A2', 'A3', 'A4', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** The seed's organisation and three skills without a certification policy or a gate rule. */
async function seedFacts(db) {
    const admin = await db.get(
        "SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1"
    );
    const o = await db.get(
        `SELECT sv.id AS "serviceId", sv.department_id AS "departmentId", d.site_id AS "siteId"
           FROM services sv JOIN departments d ON d.id = sv.department_id
          ORDER BY sv.id LIMIT 1`
    );
    const sk = await db.all(
        `SELECT s.id FROM skills s
          WHERE NOT EXISTS (SELECT 1 FROM skill_certification_policies p WHERE p.skill_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM safety_gate_rules g WHERE g.skill_id = s.id)
          ORDER BY s.id LIMIT 3`
    );
    const adminId = Number(admin.id);
    return {
        adminId,
        SUPER: { id: adminId, userType: 'admin', role: 'superadmin', username: 'kpi-super' },
        ORG: {
            siteId: Number(o.siteId),
            departmentId: Number(o.departmentId),
            serviceId: Number(o.serviceId),
        },
        SKILLS: sk.map((r) => Number(r.id)),
    };
}

/** Build the world; returns every id. Must run inside inRolledBackTx. */
async function world(db, facts, q) {
    const { adminId, ORG, SKILLS } = facts;
    const [S1, S2, S3] = SKILLS;
    const role = await db.get(`INSERT INTO roles (name) VALUES (?) RETURNING id`, [
        `KPI-ROLE-${STAMP}`,
    ]);
    const R = Number(role.id);
    await db.run(
        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
         VALUES (?, ?, 2, true), (?, ?, 2, false), (?, ?, 2, false)`,
        [R, S1, R, S2, R, S3]
    );
    const mrole = await db.get(`INSERT INTO roles (name) VALUES (?) RETURNING id`, [
        `KPI-MGR-${STAMP}`,
    ]);
    // "No site" needs a person without a site: the column is NOT NULL in this
    // schema, so the constraint is relaxed INSIDE the rolled-back transaction only.
    await q.query('ALTER TABLE employees ALTER COLUMN site_id DROP NOT NULL');
    const emp = async (tag, roleId, extra = {}) => {
        const r = await db.get(
            `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                    service_id, role_id, supervisor_id, is_active, erased_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [
                `KPI-${tag}-${STAMP}`,
                `Kpi${tag}`,
                `Fixture${STAMP}`,
                extra.noSite ? null : ORG.siteId,
                ORG.departmentId,
                ORG.serviceId,
                roleId,
                extra.supervisorId || null,
                extra.active !== false,
                extra.erased ? new Date().toISOString() : null,
            ]
        );
        return Number(r.id);
    };
    const M = await emp('M', Number(mrole.id));
    const ids = { M };
    for (const t of ['A', 'A2', 'A3', 'A4', 'B', 'C', 'D', 'E'])
        ids[t] = await emp(t, R, { supervisorId: M });
    ids.F = await emp('F', R, { supervisorId: M, active: false });
    ids.G = await emp('G', R, { supervisorId: M, erased: true });
    ids.H = await emp('H', R, { supervisorId: M, noSite: true });

    const assess = (e, s, lvl) =>
        db.run(
            `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
             VALUES (?, ?, ?, ?, 'KPI fixture')`,
            [e, s, lvl, adminId]
        );
    for (const t of ['A', 'A2', 'A3', 'A4', 'F', 'G']) {
        await assess(ids[t], S1, 2);
        await assess(ids[t], S2, 2);
        await assess(ids[t], S3, 2);
    }
    await assess(ids.B, S1, 1);
    await assess(ids.B, S2, 2);
    await assess(ids.B, S3, 2);
    await assess(ids.C, S2, 2);
    await assess(ids.E, S1, 1);

    // A local administrator scoped to the fixture service.
    const la = await db.get(
        `INSERT INTO admins (username, email, password_hash, role, is_active, force_password_change)
         VALUES (?, ?, 'x', 'localadmin', true, false) RETURNING id`,
        [`kpi-local-${STAMP}`, `kpi-local-${STAMP}@example.test`]
    );
    await db.run(
        `INSERT INTO admin_scopes (admin_id, scope_type, service_id) VALUES (?, 'service', ?)`,
        [Number(la.id), ORG.serviceId]
    );
    const LOCAL = {
        id: Number(la.id),
        userType: 'admin',
        role: 'localadmin',
        username: `kpi-local-${STAMP}`,
        permissions: [],
    };
    return { ...ids, R, S1, S2, S3, MROLE: Number(mrole.id), LOCAL };
}

const fixtureIds = (w) => TAGS.map((t) => w[t]);
const managerOf = (w) => ({ id: w.M, userType: 'manager', role: 'manager' });

/** Every person id a KPI result exposes (drills of all shapes). */
function idsIn(result) {
    const out = new Set();
    const visit = (v, deep) => {
        if (v == null) return;
        if (typeof v === 'number') {
            if (deep) out.add(v);
        } else if (Array.isArray(v)) v.forEach((x) => visit(x, deep));
        else if (typeof v === 'object') {
            if (v.employeeId != null) out.add(Number(v.employeeId));
            for (const k of Object.keys(v)) {
                if (/drill/i.test(k)) visit(v[k], true);
                else if (deep && !/^(siteId|skillId|planId|type)$/.test(k)) visit(v[k], true);
                else if (k === 'byType' || k === 'campaigns' || /^(pip|idp|coaching)$/.test(k))
                    visit(v[k], false);
                else if (deep === false && typeof v[k] === 'object') visit(v[k], false);
            }
        }
    };
    visit(result, false);
    return out;
}

module.exports = { inRolledBackTx, seedFacts, world, fixtureIds, managerOf, idsIn, STAMP, TAGS };
