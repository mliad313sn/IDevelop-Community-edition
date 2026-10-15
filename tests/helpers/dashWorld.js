'use strict';
/**
 * The dashboard fixture world: invented people only, built INSIDE a
 * transaction the suite always rolls back (inRolledBackTx). Large enough for
 * the rules that need 5 people (percentages, heat cells, 9-box slices) and
 * spread over three sites so the site comparisons have something to compare.
 *
 *   Sites N (the seed's site), E and W, one department each.
 *   Role R: three requirements (S1 critical, level 2 each).
 *   Per site, 9 people on R: 5 ready (all met), 2 not ready (S1 at 1),
 *   1 partial (S2 only), 1 not assessed.
 *   A manager M (on a role without requirements) supervises the 9 people of
 *   site N. Three of them have a self-assessment waiting for validation.
 *   9-box: 7 approved positions high/high, 2 medium/medium (merged with the
 *   next smallest, never alone), 1 low/low.
 *   Recorded snapshots (contract kpi-1) for the organisation 95, 65 and 35
 *   days ago: the first row's movement and the sparkline read them.
 *   A viewer account without any scope; one temporary admin per access
 *   profile (config/accessProfiles.js) scoped to site N.
 * Every first and last name is distinctive (NAMES) so a page can be scanned
 * for any of them.
 */

const ROLLBACK = new Error('__DASH_WORLD_ROLLBACK__');

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

const STAMP = `${Date.now()}`.slice(-6);
const FIRST = [
    'Quorvin',
    'Elsabeth',
    'Thandor',
    'Myrrine',
    'Oswyn',
    'Pelagia',
    'Rudric',
    'Sefira',
    'Talwyn',
];
const LAST = 'Brightvale';

async function world(db) {
    const admin = await db.get(
        "SELECT id FROM admins WHERE role = 'superadmin' AND is_active ORDER BY id LIMIT 1"
    );
    const adminId = Number(admin.id);
    const seed = await db.get(
        `SELECT d.site_id AS "siteId", d.id AS "departmentId", sv.id AS "serviceId"
           FROM services sv JOIN departments d ON d.id = sv.department_id ORDER BY sv.id LIMIT 1`
    );
    const skills = (
        await db.all(
            `SELECT s.id FROM skills s
              WHERE NOT EXISTS (SELECT 1 FROM skill_certification_policies p WHERE p.skill_id = s.id)
                AND NOT EXISTS (SELECT 1 FROM safety_gate_rules g WHERE g.skill_id = s.id)
              ORDER BY s.id LIMIT 3`
        )
    ).map((r) => Number(r.id));
    const [S1, S2, S3] = skills;
    const sites = [
        {
            key: 'N',
            siteId: Number(seed.siteId),
            departmentId: Number(seed.departmentId),
            serviceId: Number(seed.serviceId),
        },
    ];
    for (const key of ['E', 'W']) {
        const s = await db.get(`INSERT INTO sites (name) VALUES (?) RETURNING id`, [
            `Dashsite ${key} ${STAMP}`,
        ]);
        const d = await db.get(
            `INSERT INTO departments (site_id, name) VALUES (?, ?) RETURNING id`,
            [Number(s.id), `Dashdept ${key} ${STAMP}`]
        );
        const v = await db.get(
            `INSERT INTO services (department_id, name) VALUES (?, ?) RETURNING id`,
            [Number(d.id), `Dashsvc ${key} ${STAMP}`]
        );
        sites.push({
            key,
            siteId: Number(s.id),
            departmentId: Number(d.id),
            serviceId: Number(v.id),
        });
    }
    const role = await db.get(`INSERT INTO roles (name) VALUES (?) RETURNING id`, [
        `Dashrole ${STAMP}`,
    ]);
    const R = Number(role.id);
    await db.run(
        `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
         VALUES (?, ?, 2, true), (?, ?, 2, false), (?, ?, 2, false)`,
        [R, S1, R, S2, R, S3]
    );
    const mrole = await db.get(`INSERT INTO roles (name) VALUES (?) RETURNING id`, [
        `Dashmgr ${STAMP}`,
    ]);
    const names = [];
    const emp = async (first, last, site, roleId, supervisorId, username) => {
        const r = await db.get(
            `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                    service_id, role_id, supervisor_id, is_active, username)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, true, ?) RETURNING id`,
            [
                `DSH-${names.length}-${STAMP}`,
                first,
                last,
                site.siteId,
                site.departmentId,
                site.serviceId,
                roleId,
                supervisorId,
                username || null,
            ]
        );
        names.push({ first, last, number: `DSH-${names.length}-${STAMP}` });
        return Number(r.id);
    };
    const M = await emp(
        'Corvane',
        `${LAST}${STAMP}`,
        sites[0],
        Number(mrole.id),
        null,
        `dash.mgr.${STAMP}`
    );
    const people = {};
    const assess = (e, s, lvl) =>
        db.run(
            `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, notes)
             VALUES (?, ?, ?, ?, 'dashboard fixture')`,
            [e, s, lvl, adminId]
        );
    for (const site of sites) {
        people[site.key] = [];
        for (let i = 0; i < 9; i++) {
            const id = await emp(
                FIRST[i],
                `${LAST}${site.key}${STAMP}`,
                site,
                R,
                site.key === 'N' ? M : null,
                site.key === 'N' && i === 8 ? `dash.emp.${STAMP}` : null
            );
            people[site.key].push(id);
            if (i < 5) {
                await assess(id, S1, 2);
                await assess(id, S2, 2);
                await assess(id, S3, 2);
            } else if (i < 7) {
                await assess(id, S1, 1);
                await assess(id, S2, 2);
                await assess(id, S3, 2);
            } else if (i === 7) {
                await assess(id, S2, 2);
            }
        }
    }
    // three self-assessments of site N wait for validation
    for (const id of people.N.slice(0, 3))
        await db.run(
            `INSERT INTO self_assessments (employee_id, skill_id, self_rated_level, status, workflow_state, submitted_at)
             VALUES (?, ?, 3, 'submitted', 'submitted', now() - interval '10 days')`,
            [id, S2]
        );
    // 9-box: approved positions
    const place = async (id, perf, pot, box) =>
        db.run(
            `INSERT INTO nine_box_evaluations (employee_id, performance, potential, box, status, approved_at)
             VALUES (?, ?, ?, ?, 'approved', now())`,
            [id, perf, pot, box]
        );
    const all = [...people.N, ...people.E, ...people.W];
    for (const id of all.slice(0, 7)) await place(id, 'high', 'high', 9);
    for (const id of all.slice(7, 9)) await place(id, 'medium', 'medium', 5);
    await place(all[9], 'low', 'low', 1);
    // recorded organisation snapshots of the KPI contract (deltas, sparkline)
    for (const [days, ready, notReady] of [
        [95, 10, 8],
        [65, 12, 7],
        [35, 13, 6],
    ])
        await db.run(
            `INSERT INTO kpi_snapshots (snapshot_date, scope_type, scope_id, total_employees, measured_employees,
                                        role_ready_count, not_ready_count, partial_count, unassessed_count,
                                        assessment_coverage, kpi_contract)
             VALUES (CURRENT_DATE - ?::int, 'org', 0, 28, 25, ?, ?, 3, 3, 70.0, 'kpi-1')
             ON CONFLICT DO NOTHING`,
            [days, ready, notReady]
        );
    // a viewer without any scope
    const v = await db.get(
        `INSERT INTO admins (username, email, password_hash, role, is_active, force_password_change)
         VALUES (?, ?, '!nologin', 'viewer', true, false) RETURNING id`,
        [`dash.viewer.${STAMP}`, `dash.viewer.${STAMP}@example.test`]
    );
    // one admin per access profile, scoped to site N
    const { ACCESS_PROFILES } = require('../../src/config/accessProfiles');
    const profiles = {};
    for (const p of ACCESS_PROFILES) {
        const r = await db.get(
            `INSERT INTO admins (username, email, password_hash, role, is_active, force_password_change)
             VALUES (?, ?, '!nologin', ?, true, false) RETURNING id`,
            [`dash.${p.key}.${STAMP}`, `dash.${p.key}.${STAMP}@example.test`, p.role]
        );
        const id = Number(r.id);
        for (const s of p.slugs)
            await db.run('INSERT INTO admin_permissions (admin_id, permission) VALUES (?, ?)', [
                id,
                s,
            ]);
        await db.run(
            `INSERT INTO admin_scopes (admin_id, scope_type, site_id) VALUES (?, 'site', ?)`,
            [id, sites[0].siteId]
        );
        profiles[p.key] = id;
    }
    return {
        adminId,
        R,
        S1,
        S2,
        S3,
        M,
        sites,
        people,
        all,
        names,
        viewerId: Number(v.id),
        profiles,
        employeeAccount: people.N[8],
    };
}

/** The names, last names and employee numbers of the world found in a text. */
function namesIn(text, w) {
    const low = String(text || '').toLowerCase();
    const hits = [];
    for (const n of w.names) {
        if (low.includes(String(n.last).toLowerCase())) hits.push(n.last);
        if (low.includes(`${n.first} ${n.last}`.toLowerCase())) hits.push(`${n.first} ${n.last}`);
        if (String(text).includes(n.number)) hits.push(n.number);
    }
    for (const f of FIRST) if (new RegExp('\\b' + f + '\\b').test(String(text))) hits.push(f);
    return [...new Set(hits)];
}

module.exports = { inRolledBackTx, world, namesIn, STAMP, FIRST };
