'use strict';
/* eslint-disable no-console */
/**
 * Load the generic STARTER capability framework into an empty (or partly
 * filled) database so a fresh installation is usable on day one:
 *
 *   6 pillars → 12 sub-domains → 34 skills (FR + EN descriptions),
 *   5 role families (with their skills) and 6 sample roles with requirements.
 *
 * Data: db/postgres/seed-data/starter-framework.json (CC0 — edit freely).
 * Proficiency level anchors are NOT duplicated here: the schema already ships
 * per-category descriptors (Behavioral, Technical, Safety, Compliance, …).
 *
 * Idempotent: every row is matched by name first and only created when absent,
 * so re-running never duplicates and never overwrites an edit made in the app.
 * Runs in ONE transaction. Dry run by default:
 *
 *   npm run db:seed:starter              # show what would be created (rolled back)
 *   npm run db:seed:starter -- --commit  # write it
 *
 * --file <path> loads another framework file of the same shape instead, for
 * example one generated from ESCO by scripts/import-esco.js:
 *
 *   npm run db:seed:starter -- --file esco.json            # dry run
 *   npm run db:seed:starter -- --file esco.json --commit
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');

const DATA = path.join(__dirname, '..', 'db', 'postgres', 'seed-data', 'starter-framework.json');
const ROLLBACK = '__starter_dry_run__';

async function findOrCreate(counter, selectSql, selectParams, insertSql, insertParams) {
    const row = await db.get(selectSql, selectParams);
    if (row) return row.id;
    const r = await db.get(insertSql + ' RETURNING id', insertParams);
    counter.created += 1;
    return r.id;
}

async function load(fw) {
    const stats = {};
    const c = (k) => (stats[k] = stats[k] || { created: 0 });
    const skillIds = new Map();

    for (const pillar of fw.pillars) {
        const domainId = await findOrCreate(
            c('pillars'),
            'SELECT id FROM domains WHERE lower(name) = lower($1)',
            [pillar.name],
            'INSERT INTO domains (name, description) VALUES ($1, $2)',
            [pillar.name, pillar.description || null]
        );
        let pos = 0;
        for (const sd of pillar.subDomains || []) {
            pos += 1;
            const subId = await findOrCreate(
                c('sub-domains'),
                'SELECT id FROM sub_domains WHERE domain_id = $1 AND lower(name) = lower($2)',
                [domainId, sd.name],
                'INSERT INTO sub_domains (domain_id, name, definition, position) VALUES ($1, $2, $3, $4)',
                [domainId, sd.name, sd.definition || null, pos]
            );
            for (const sk of sd.skills || []) {
                const id = await findOrCreate(
                    c('skills'),
                    'SELECT id FROM skills WHERE domain_id = $1 AND lower(name) = lower($2)',
                    [domainId, sk.name],
                    `INSERT INTO skills (domain_id, sub_domain_id, name, description, description_en, category, source)
                     VALUES ($1, $2, $3, $4, $5, $6, 'standard')`,
                    [
                        domainId,
                        subId,
                        sk.name,
                        sk.fr || null,
                        sk.en || null,
                        sk.category || pillar.category || 'Technical',
                    ]
                );
                skillIds.set(sk.name.toLowerCase(), id);
            }
        }
    }

    const familyIds = new Map();
    for (const f of fw.roleFamilies || []) {
        const id = await findOrCreate(
            c('role families'),
            'SELECT id FROM role_families WHERE lower(name) = lower($1)',
            [f.name],
            "INSERT INTO role_families (name, description, origin) VALUES ($1, $2, 'standard')",
            [f.name, f.description || null]
        );
        familyIds.set(f.name, id);
    }

    const skill = (name) => {
        const id = skillIds.get(String(name).toLowerCase());
        if (!id) throw new Error(`starter-framework.json references an unknown skill: ${name}`);
        return id;
    };

    for (const [family, names] of Object.entries(fw.familySkills || {})) {
        for (const n of names) {
            const r = await db.run(
                `INSERT INTO skill_role_families (skill_id, role_family_id) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [skill(n), familyIds.get(family)]
            );
            c('family links').created += r.changes || 0;
        }
    }

    for (const role of fw.roles || []) {
        const roleId = await findOrCreate(
            c('roles'),
            'SELECT id FROM roles WHERE lower(name) = lower($1)',
            [role.name],
            'INSERT INTO roles (name, role_family_id) VALUES ($1, $2)',
            [role.name, familyIds.get(role.family) || null]
        );
        for (const [name, level, critical] of role.requirements) {
            const r = await db.run(
                `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
                 VALUES ($1, $2, $3, $4) ON CONFLICT (role_id, skill_id) DO NOTHING`,
                [roleId, skill(name), level, !!critical]
            );
            c('role requirements').created += r.changes || 0;
        }
    }
    return stats;
}

/** The framework file: --file <path> (or --file=<path>), else the bundled starter. */
function dataFile(argv) {
    const i = argv.indexOf('--file');
    if (i !== -1) {
        if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--file needs a path');
        return path.resolve(argv[i + 1]);
    }
    const eq = argv.find((a) => a.startsWith('--file='));
    return eq ? path.resolve(eq.slice('--file='.length)) : DATA;
}

function readFramework(file) {
    const fw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!fw || !Array.isArray(fw.pillars))
        throw new Error(`${file} is not a framework file (no "pillars" array)`);
    for (const p of fw.pillars) {
        if (!p || !p.name || !Array.isArray(p.subDomains))
            throw new Error(`${file}: every pillar needs a name and a subDomains array`);
    }
    return fw;
}

(async () => {
    const commit = process.argv.includes('--commit');
    const file = dataFile(process.argv.slice(2));
    const fw = readFramework(file);
    await db.connect();
    let stats = null;
    try {
        await db.runTransaction(async () => {
            stats = await load(fw);
            if (!commit) throw new Error(ROLLBACK);
        });
    } catch (e) {
        if (e.message !== ROLLBACK) throw e;
    }
    console.log(`\n${fw.name} (v${fw.version})${file === DATA ? '' : ` from ${file}`}`);
    if (fw.attribution) console.log(`  ${fw.attribution}`);
    for (const [k, v] of Object.entries(stats || {}))
        console.log(`  ${k.padEnd(18)} ${v.created} new`);
    console.log(
        commit
            ? '\nCOMMITTED. Existing rows with the same names were left untouched.'
            : '\nDRY RUN - rolled back. Re-run with --commit to write.'
    );
    await db.close();
})().catch(async (e) => {
    console.error('Starter framework load failed:', e.message);
    try {
        await db.close();
    } catch (_) {
        /* already closed */
    }
    process.exit(1);
});
