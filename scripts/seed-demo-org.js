'use strict';
/* eslint-disable no-console */
/**
 * Seed a small FICTIONAL demo organisation so evaluators can see IDevelop CE
 * populated: 2 sites, 3 departments, 6 teams, 24 people with managers, and
 * self-assessments against the starter framework's role requirements.
 *
 *   npm run db:seed:starter -- --commit          # prerequisite (roles + skills)
 *   npm run db:seed:demo-org -- --commit         # add the demo organisation
 *   npm run db:seed:demo-org -- --clean --commit # deactivate it (history is append-only)
 *
 * Every person is invented. Every row is identifiable: employee numbers start
 * with DEMO-, site codes with DM-. --clean deactivates exactly those rows. For a
 * clean slate, seed demo data into a throwaway database.
 * Dry run by default; refuses NODE_ENV=production.
 */
require('dotenv').config();
const db = require('../src/config/database');

const ROLLBACK = '__demo_org_dry_run__';

const ORG = [
    {
        site: ['Riverside Campus', 'DM-RIV'],
        departments: [
            [
                'Operations',
                [
                    ['Production', ['Operations Technician', 'Team Leader']],
                    ['Quality & Planning', ['Operations Technician', 'Project Manager']],
                ],
            ],
            [
                'People & Culture',
                [
                    ['HR Partners', ['HR Business Partner']],
                    ['Health & Safety', ['Health & Safety Officer']],
                ],
            ],
        ],
    },
    {
        site: ['Hillcrest Studio', 'DM-HIL'],
        departments: [
            [
                'Technology',
                [
                    ['Data & Insights', ['Data Analyst', 'Team Leader']],
                    ['Delivery', ['Project Manager', 'Data Analyst']],
                ],
            ],
        ],
    },
];

const FIRST = [
    'Amelia',
    'Noah',
    'Sofia',
    'Liam',
    'Maya',
    'Ethan',
    'Chloe',
    'Lucas',
    'Zara',
    'Mateo',
    'Ivy',
    'Omar',
    'Hana',
    'Leo',
    'Nina',
    'Arjun',
    'Elena',
    'Kofi',
    'Mei',
    'Jonas',
    'Aisha',
    'Tomas',
    'Lena',
    'Rafael',
];
const LAST = [
    'Carter',
    'Nguyen',
    'Rossi',
    'Okoye',
    'Lindgren',
    'Moreau',
    'Silva',
    'Kowalski',
    'Haddad',
    'Tanaka',
    'Brennan',
    'Varga',
    'Mensah',
    'Dubois',
    'Patel',
    'Novak',
    'Ortega',
    'Fischer',
    'Kim',
    'Adeyemi',
    'Larsen',
    'Costa',
    'Weber',
    'Ibrahim',
];

// Deterministic pseudo-random levels so screenshots and demos are reproducible.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

async function clean() {
    // Assessment history is append-only by design (audit), so demo people are
    // DEACTIVATED rather than deleted: they disappear from every list,
    // dashboard and report, and their history stays consistent.
    const people = await db.run(
        "UPDATE employees SET is_active = false, is_account_active = false WHERE employee_number LIKE 'DEMO-%' AND is_active"
    );
    const sites = await db.run(
        "UPDATE sites SET is_active = false WHERE code LIKE 'DM-%' AND is_active"
    );
    return { peopleDeactivated: people.changes, sitesDeactivated: sites.changes };
}

async function seedOrg() {
    const already = await db.get(
        "SELECT count(*)::int AS n FROM employees WHERE employee_number LIKE 'DEMO-%'"
    );
    if (already.n)
        return {
            skipped: `demo organisation already present (${already.n} people) — use --clean first`,
        };
    const roles = new Map(
        (await db.all('SELECT id, name FROM roles')).map((r) => [r.name, Number(r.id)])
    );
    if (!roles.has('Team Leader'))
        throw new Error('Starter roles missing: run `npm run db:seed:starter -- --commit` first.');
    const admin = await db.get(
        "SELECT id FROM admins WHERE role = 'superadmin' ORDER BY id LIMIT 1"
    );
    if (!admin) throw new Error('No super-administrator found (start the app once to create it).');

    let n = 0;
    let assessed = 0;
    for (const s of ORG) {
        const site = await db.get(
            'INSERT INTO sites (name, code) VALUES ($1, $2) RETURNING id',
            s.site
        );
        for (const [dName, teams] of s.departments) {
            const dep = await db.get(
                'INSERT INTO departments (site_id, name) VALUES ($1, $2) RETURNING id',
                [site.id, dName]
            );
            for (const [tName, roleNames] of teams) {
                const svc = await db.get(
                    'INSERT INTO services (department_id, name) VALUES ($1, $2) RETURNING id',
                    [dep.id, tName]
                );
                let lead = null;
                for (let i = 0; i < 4; i++) {
                    const k = n % FIRST.length;
                    const roleName =
                        i === 0 && roleNames.includes('Team Leader')
                            ? 'Team Leader'
                            : roleNames[i % roleNames.length];
                    n += 1;
                    const num = 'DEMO-' + String(n).padStart(3, '0');
                    const first = FIRST[k];
                    const last = LAST[(k * 7) % LAST.length];
                    const email = `${first}.${last}@demo.idevelop.invalid`.toLowerCase();
                    const emp = await db.get(
                        `INSERT INTO employees (employee_number, first_name, last_name, email, site_id, department_id,
                                                service_id, role_id, manager_id, manager_type, supervisor_id, is_account_active)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,false) RETURNING id`,
                        [
                            num,
                            first,
                            last,
                            email,
                            site.id,
                            dep.id,
                            svc.id,
                            roles.get(roleName),
                            lead,
                            lead ? 'employee' : null,
                        ]
                    );
                    if (i === 0) lead = emp.id;
                    const reqs = await db.all(
                        'SELECT skill_id AS sid, required_level AS req FROM role_skill_requirements WHERE role_id = $1',
                        [roles.get(roleName)]
                    );
                    for (const r of reqs) {
                        if (rnd() < 0.15) continue; // some skills not yet assessed
                        const level = Math.max(
                            0,
                            Math.min(4, Number(r.req) + Math.round(rnd() * 3) - 2)
                        );
                        await db.run(
                            `INSERT INTO skill_assessments (employee_id, skill_id, current_level, assessed_by, validation)
                             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (employee_id, skill_id) DO NOTHING`,
                            [
                                emp.id,
                                r.sid,
                                level,
                                admin.id,
                                rnd() < 0.6 ? 'manager_validated' : 'self',
                            ]
                        );
                        assessed += 1;
                    }
                }
            }
        }
    }
    return { people: n, assessments: assessed };
}

(async () => {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
        console.error('Refused: the demo organisation is never seeded in production.');
        process.exit(1);
    }
    const commit = process.argv.includes('--commit');
    const wantClean = process.argv.includes('--clean');
    await db.connect();
    let out = null;
    try {
        await db.runTransaction(async () => {
            out = wantClean ? await clean() : await seedOrg();
            if (!commit) throw new Error(ROLLBACK);
        });
    } catch (e) {
        if (e.message !== ROLLBACK) throw e;
    }
    console.log(wantClean ? 'Demo organisation removed:' : 'Demo organisation:', out);
    console.log(commit ? 'COMMITTED.' : 'DRY RUN - rolled back. Re-run with --commit to write.');
    await db.close();
})().catch(async (e) => {
    console.error('Demo organisation failed:', e.message);
    try {
        await db.close();
    } catch (_) {
        /* closed */
    }
    process.exit(1);
});
