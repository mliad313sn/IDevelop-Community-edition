'use strict';

/**
 * Framework packs — load a capability framework file (pillars → sub-domains →
 * skills, role families, roles with requirements) into the database.
 *
 * One loader for every source, so they all behave the same way:
 *   - scripts/seed-starter-framework.js (the starter framework, or --file),
 *   - the sector packs under db/postgres/seed-data/packs/ (skills library screen),
 *   - an ESCO import converted by scripts/import-esco.js (file or upload).
 *
 * IDEMPOTENT: every row is matched by name first (case-insensitive, on the
 * English OR the French name) and only created when absent, so loading the same
 * file twice creates nothing, and nothing already in the database is ever
 * overwritten: a skill edited in the app keeps its edit. Level anchors are only
 * added for a (skill, level) that has none.
 *
 * DRY RUN: the same load runs inside a savepoint that is always rolled back, so
 * the report of "would be created / already exists" is exactly what a commit
 * would do.
 *
 * File shape (the starter framework is the minimal form; packs add the *Fr
 * fields, `levels` and the metadata):
 *   { id, name, title:{fr,en}, description:{fr,en}, sector, licence, version,
 *     pillars: [{ name, nameFr, description, descriptionFr, category,
 *       subDomains: [{ name, nameFr, definition, definitionFr,
 *         skills: [{ name, nameFr, category, fr, en, levels:[{level,fr,en}] }] }] }],
 *     roleFamilies: [{ name, nameFr, description, descriptionFr }],
 *     familySkills: { <family name>: [<skill name>, …] },
 *     roles: [{ name, nameFr, family, requirements: [[<skill name>, level 0-4, critical]] }] }
 * Skills and roles reference each other by their English `name`.
 */
const fs = require('fs');
const path = require('path');

// Lazy: the pure helpers (validation, previews) must work without a database.
const db = () => require('../config/database');

const SEED_DIR = path.join(__dirname, '..', '..', 'db', 'postgres', 'seed-data');
const STARTER_FILE = path.join(SEED_DIR, 'starter-framework.json');
const PACKS_DIR = path.join(SEED_DIR, 'packs');
const ROLLBACK = '__framework_pack_dry_run__';
const CATEGORIES = new Set([
    'Technical',
    'Behavioral',
    'Safety',
    'Compliance',
    'HardSkills',
    'SoftSkills',
    'Cybersecurity',
]);
const KINDS = [
    'pillars',
    'sub-domains',
    'skills',
    'level anchors',
    'role families',
    'family links',
    'roles',
    'role requirements',
];
/** Names listed per kind in a report (counts are always complete). */
const LIST_CAP = 300;

function httpError(code, status = 400) {
    const e = new Error(code);
    e.code = code;
    e.status = status;
    e.expose = true;
    return e;
}

const low = (s) => String(s == null ? '' : s).toLowerCase();

/** The name to store for `lang`: the French one when asked for and present. */
function nameIn(obj, lang) {
    return lang === 'fr' && obj.nameFr ? obj.nameFr : obj.name;
}
/** Every name the row may already exist under (English, French). */
function namesOf(obj) {
    return [...new Set([obj.name, obj.nameFr].filter(Boolean).map(low))];
}
function textIn(obj, key, lang) {
    const fr = obj[`${key}Fr`];
    const en = obj[key];
    return (lang === 'fr' ? fr || en : en || fr) || null;
}

/**
 * Structural problems of a framework object, as English sentences (empty when
 * valid). Checks what the loader relies on; content rules for the bundled
 * packs (FR + EN everywhere, licence…) are in the pack tests.
 */
function validateFramework(fw) {
    const errors = [];
    if (!fw || !Array.isArray(fw.pillars)) return ['not a framework file (no "pillars" array)'];
    const skills = new Set();
    for (const p of fw.pillars) {
        if (!p || !p.name || !Array.isArray(p.subDomains)) {
            errors.push('every pillar needs a name and a subDomains array');
            continue;
        }
        const inPillar = new Set();
        for (const sd of p.subDomains) {
            if (!sd || !sd.name) errors.push(`pillar "${p.name}": a sub-domain has no name`);
            for (const sk of (sd && sd.skills) || []) {
                if (!sk || !sk.name) {
                    errors.push(`pillar "${p.name}": a skill has no name`);
                    continue;
                }
                if (inPillar.has(low(sk.name)))
                    errors.push(`pillar "${p.name}": duplicate skill "${sk.name}"`);
                inPillar.add(low(sk.name));
                skills.add(low(sk.name));
                const cat = sk.category || p.category;
                if (cat && !CATEGORIES.has(cat))
                    errors.push(`skill "${sk.name}": unknown category "${cat}"`);
                for (const a of sk.levels || []) {
                    if (!a || !Number.isInteger(a.level) || a.level < 0 || a.level > 4)
                        errors.push(`skill "${sk.name}": level anchors must be levels 0-4`);
                }
            }
        }
    }
    const families = new Set((fw.roleFamilies || []).map((f) => low(f && f.name)));
    for (const [fam, names] of Object.entries(fw.familySkills || {})) {
        if (!families.has(low(fam))) errors.push(`familySkills: unknown role family "${fam}"`);
        for (const n of names || [])
            if (!skills.has(low(n))) errors.push(`family "${fam}": unknown skill "${n}"`);
    }
    for (const r of fw.roles || []) {
        if (!r || !r.name) {
            errors.push('a role has no name');
            continue;
        }
        if (r.family && !families.has(low(r.family)))
            errors.push(`role "${r.name}": unknown role family "${r.family}"`);
        for (const req of r.requirements || []) {
            const [n, level] = Array.isArray(req) ? req : [];
            if (!skills.has(low(n))) errors.push(`role "${r.name}": unknown skill "${n}"`);
            if (!Number.isInteger(level) || level < 0 || level > 4)
                errors.push(`role "${r.name}": level of "${n}" must be 0-4`);
        }
    }
    return errors;
}

/** Read and check a framework file (the script's historic error wording). */
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

/** Counts shown on a pack card and in a report header. */
function summarise(fw) {
    const c = {
        pillars: 0,
        subDomains: 0,
        skills: 0,
        anchors: 0,
        roleFamilies: (fw.roleFamilies || []).length,
        roles: (fw.roles || []).length,
    };
    for (const p of fw.pillars || []) {
        c.pillars += 1;
        for (const sd of p.subDomains || []) {
            c.subDomains += 1;
            for (const sk of sd.skills || []) {
                c.skills += 1;
                if (Array.isArray(sk.levels) && sk.levels.length) c.anchors += 1;
            }
        }
    }
    return c;
}

/** A display tree of the framework in one language (for the preview). */
function preview(fw, lang) {
    const skillName = new Map();
    const pillars = (fw.pillars || []).map((p) => ({
        name: nameIn(p, lang),
        description: textIn(p, 'description', lang),
        subDomains: (p.subDomains || []).map((sd) => ({
            name: nameIn(sd, lang),
            skills: (sd.skills || []).map((sk) => {
                const n = nameIn(sk, lang);
                skillName.set(low(sk.name), n);
                return {
                    name: n,
                    category: sk.category || p.category || 'Technical',
                    description: (lang === 'fr' ? sk.fr || sk.en : sk.en || sk.fr) || null,
                    anchors: Array.isArray(sk.levels) ? sk.levels.length : 0,
                };
            }),
        })),
    }));
    const families = new Map((fw.roleFamilies || []).map((f) => [low(f.name), nameIn(f, lang)]));
    const roles = (fw.roles || []).map((r) => ({
        name: nameIn(r, lang),
        family: r.family ? families.get(low(r.family)) || r.family : null,
        requirements: (r.requirements || []).map(([n, level, critical]) => ({
            skill: skillName.get(low(n)) || n,
            level,
            critical: !!critical,
        })),
    }));
    return { pillars, roles };
}

const packCache = new Map();

/** The bundled packs, with their counts (read once per process). */
function listPacks() {
    let files = [];
    try {
        files = fs.readdirSync(PACKS_DIR).filter((f) => /^[a-z0-9-]+\.json$/.test(f));
    } catch (_) {
        return [];
    }
    return files
        .sort()
        .map((f) => getPack(f.replace(/\.json$/, '')))
        .filter(Boolean)
        .map((fw) => ({
            id: fw.id,
            title: fw.title || { en: fw.name, fr: fw.name },
            description: fw.description || {},
            sector: fw.sector || null,
            licence: fw.licence || fw.license || null,
            version: fw.version,
            counts: summarise(fw),
        }));
}

/** One bundled pack by id, or null. The id never becomes a path unchecked. */
function getPack(id) {
    const key = String(id || '');
    if (!/^[a-z0-9-]{1,64}$/.test(key)) return null;
    if (packCache.has(key)) return packCache.get(key);
    const file = path.join(PACKS_DIR, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    const fw = readFramework(file);
    if (fw.id !== key) return null;
    packCache.set(key, fw);
    return fw;
}

/**
 * Write the framework (no transaction of its own: the caller decides whether it
 * commits). Returns the report { stats: {kind: {created, existing}},
 * created: {kind: [names]}, existing: {kind: [names]} }.
 */
async function load(fw, opts = {}) {
    const lang = opts.lang === 'fr' ? 'fr' : 'en';
    const d = db();
    const report = { stats: {}, created: {}, existing: {} };
    for (const k of KINDS) {
        report.stats[k] = { created: 0, existing: 0 };
        report.created[k] = [];
        report.existing[k] = [];
    }
    const note = (kind, isNew, label) => {
        report.stats[kind][isNew ? 'created' : 'existing'] += 1;
        const list = report[isNew ? 'created' : 'existing'][kind];
        if (label && list.length < LIST_CAP) list.push(label);
    };
    async function findOrCreate(kind, label, selectSql, selectParams, insertSql, insertParams) {
        const row = await d.get(selectSql, selectParams);
        if (row) {
            note(kind, false, label);
            return row.id;
        }
        const r = await d.get(insertSql + ' RETURNING id', insertParams);
        note(kind, true, label);
        return r.id;
    }

    const skillIds = new Map();
    for (const pillar of fw.pillars) {
        const pName = nameIn(pillar, lang);
        const domainId = await findOrCreate(
            'pillars',
            pName,
            'SELECT id FROM domains WHERE lower(name) = ANY($1::text[]) ORDER BY id LIMIT 1',
            [namesOf(pillar)],
            'INSERT INTO domains (name, description) VALUES ($1, $2)',
            [pName, textIn(pillar, 'description', lang)]
        );
        let pos = 0;
        for (const sd of pillar.subDomains || []) {
            pos += 1;
            const sdName = nameIn(sd, lang);
            const subId = await findOrCreate(
                'sub-domains',
                `${pName} › ${sdName}`,
                'SELECT id FROM sub_domains WHERE domain_id = $1 AND lower(name) = ANY($2::text[]) ORDER BY id LIMIT 1',
                [domainId, namesOf(sd)],
                'INSERT INTO sub_domains (domain_id, name, definition, position) VALUES ($1, $2, $3, $4)',
                [domainId, sdName, textIn(sd, 'definition', lang), pos]
            );
            for (const sk of sd.skills || []) {
                const skName = nameIn(sk, lang);
                const id = await findOrCreate(
                    'skills',
                    skName,
                    'SELECT id FROM skills WHERE domain_id = $1 AND lower(name) = ANY($2::text[]) ORDER BY id LIMIT 1',
                    [domainId, namesOf(sk)],
                    `INSERT INTO skills (domain_id, sub_domain_id, name, description, description_en, category, source)
                     VALUES ($1, $2, $3, $4, $5, $6, 'standard')`,
                    [
                        domainId,
                        subId,
                        skName,
                        sk.fr || null,
                        sk.en || null,
                        sk.category || pillar.category || 'Technical',
                    ]
                );
                skillIds.set(low(sk.name), id);
                for (const a of sk.levels || []) {
                    const fr = String(a.fr || a.en || '').slice(0, 600);
                    if (!fr) continue;
                    const r = await d.run(
                        `INSERT INTO proficiency_descriptors (skill_id, category, level, anchor, anchor_en)
                         SELECT $1::bigint, NULL, $2::smallint, $3::text, $4::text
                          WHERE NOT EXISTS (SELECT 1 FROM proficiency_descriptors
                                             WHERE skill_id = $1::bigint AND level = $2::smallint)`,
                        [id, a.level, fr, a.en ? String(a.en).slice(0, 600) : null]
                    );
                    note('level anchors', (r.changes || 0) > 0, `${skName} · ${a.level}`);
                }
            }
        }
    }

    const familyIds = new Map();
    const familyName = new Map();
    for (const f of fw.roleFamilies || []) {
        const fName = nameIn(f, lang);
        const id = await findOrCreate(
            'role families',
            fName,
            'SELECT id FROM role_families WHERE lower(name) = ANY($1::text[]) ORDER BY id LIMIT 1',
            [namesOf(f)],
            "INSERT INTO role_families (name, description, origin) VALUES ($1, $2, 'standard')",
            [fName, textIn(f, 'description', lang)]
        );
        familyIds.set(low(f.name), id);
        familyName.set(low(f.name), fName);
    }

    const skill = (name) => {
        const id = skillIds.get(low(name));
        if (!id) {
            const e = httpError('pack_unknown_skill');
            e.message = `the framework references an unknown skill: ${name}`;
            throw e;
        }
        return id;
    };

    for (const [family, names] of Object.entries(fw.familySkills || {})) {
        const famId = familyIds.get(low(family));
        if (!famId) continue;
        for (const n of names) {
            const r = await d.run(
                `INSERT INTO skill_role_families (skill_id, role_family_id) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [skill(n), famId]
            );
            note('family links', (r.changes || 0) > 0, null);
        }
    }

    for (const role of fw.roles || []) {
        const rName = nameIn(role, lang);
        const roleId = await findOrCreate(
            'roles',
            rName,
            'SELECT id FROM roles WHERE lower(name) = ANY($1::text[]) ORDER BY id LIMIT 1',
            [namesOf(role)],
            'INSERT INTO roles (name, role_family_id) VALUES ($1, $2)',
            [rName, familyIds.get(low(role.family)) || null]
        );
        for (const [name, level, critical] of role.requirements || []) {
            const r = await d.run(
                `INSERT INTO role_skill_requirements (role_id, skill_id, required_level, is_critical)
                 VALUES ($1, $2, $3, $4) ON CONFLICT (role_id, skill_id) DO NOTHING`,
                [roleId, skill(name), level, !!critical]
            );
            note('role requirements', (r.changes || 0) > 0, null);
        }
    }
    return report;
}

/**
 * Dry run: the load inside a savepoint that is always rolled back (inside a
 * transaction of its own, or the caller's). Nothing is written.
 */
async function dryRun(fw, opts = {}) {
    const d = db();
    let report = null;
    try {
        await d.runTransaction(() =>
            d.runInSavepoint(async () => {
                report = await load(fw, opts);
                throw new Error(ROLLBACK);
            })
        );
    } catch (e) {
        if (e.message !== ROLLBACK) throw e;
    }
    return report;
}

/** Commit: the load in one transaction, then one audit row. */
async function commit(fw, opts = {}) {
    const d = db();
    const report = await d.runTransaction(() => load(fw, opts));
    if (opts.audit !== false) await audit(fw, report, opts);
    return report;
}

function totalCreated(report) {
    return Object.values(report.stats).reduce((a, s) => a + s.created, 0);
}

async function audit(fw, report, opts) {
    const actor = opts.actor || null;
    const created = Object.entries(report.stats)
        .map(([k, s]) => `${k} ${s.created} new / ${s.existing} existing`)
        .join(', ');
    const source = opts.source || fw.id || fw.name || 'framework file';
    const details =
        `Framework import "${source}" (${fw.name || fw.id || ''}, v${fw.version || '?'}, ` +
        `licence ${fw.licence || fw.license || 'n/a'}, names in ${opts.lang === 'fr' ? 'French' : 'English'}): ` +
        created +
        (fw.attribution ? `. Attribution: ${fw.attribution}` : '') +
        (opts.detail ? `. ${opts.detail}` : '');
    try {
        await require('./LogService').log({
            adminId: actor && actor.userType === 'admin' ? Number(actor.id) : null,
            actorRef: actor && actor.id != null ? `${actor.userType || 'admin'}:${actor.id}` : null,
            action: opts.action || 'FRAMEWORK_PACK_IMPORTED',
            entityType: 'framework',
            details: details.slice(0, 4000),
            ipAddress: opts.ip || null,
            userAgent: opts.userAgent || null,
        });
    } catch (_) {
        /* LogService reports its own failures; the import itself is committed */
    }
}

/** The latest framework imports (packs and ESCO), newest first. */
async function history(limit = 10) {
    return db().all(
        `SELECT sl.action, sl.details #>> '{}' AS details, sl.created_at
           FROM system_logs sl
          WHERE sl.action IN ('FRAMEWORK_PACK_IMPORTED', 'FRAMEWORK_ESCO_IMPORTED')
          ORDER BY sl.created_at DESC, sl.id DESC
          LIMIT $1`,
        [Math.max(1, Math.min(50, Number(limit) || 10))]
    );
}

module.exports = {
    STARTER_FILE,
    PACKS_DIR,
    KINDS,
    CATEGORIES,
    readFramework,
    validateFramework,
    summarise,
    preview,
    listPacks,
    getPack,
    load,
    dryRun,
    commit,
    history,
    totalCreated,
};
