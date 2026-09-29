'use strict';

/**
 * Skill resolution for the import paths (Excel + JSON + bulk).
 *
 * WHY THIS EXISTS
 * ---------------
 * Skill names are NOT unique across the catalogue. Duplicate groups were merged
 * by soft-retire (`skills.is_active = false`) — the losing twin keeps its row so
 * history and old assessments stay readable, and the partial unique index
 * `uq_skill_subdomain_name ... WHERE is_active` only guards the LIVE ones.
 *
 * A bare `SELECT id FROM skills WHERE name = ?` therefore returns an ARBITRARY
 * row of the group — frequently the RETIRED one (PostgreSQL is free to return
 * any matching row without ORDER BY). Importing an export then writes the role
 * requirement / assessment onto a skill no screen displays, while the live
 * requirement on the active twin survives untouched: the role silently gains a
 * phantom extra requirement and the retired skill is resurrected in the data.
 *
 * These helpers resolve names to an ACTIVE skill, deterministically (lowest id
 * wins when several active twins share a name), and never fall back to a
 * retired row.
 */

/**
 * Resolve a skill NAME (optionally disambiguated by domain) to an active skill.
 * Returns { id } or null. Never returns a soft-retired skill.
 *
 * @param {object} db     database handle (config/database)
 * @param {string} name   skill name as written in the file
 * @param {string} [domain] optional domain name to disambiguate reused names
 */
async function resolveActiveSkillByName(db, name, domain = null) {
    const clean = name == null ? '' : String(name).trim();
    if (!clean) return null;

    if (domain && String(domain).trim()) {
        const s = await db.get(
            `SELECT s.id FROM skills s
             JOIN domains d ON d.id = s.domainId
             WHERE LOWER(s.name) = LOWER(?) AND LOWER(d.name) = LOWER(?) AND s.isActive = true
             ORDER BY s.id LIMIT 1`,
            [clean, String(domain).trim()]
        );
        if (s) return s;
    }

    return db.get(
        'SELECT id FROM skills WHERE LOWER(name) = LOWER(?) AND isActive = true ORDER BY id LIMIT 1',
        [clean]
    );
}

/**
 * Same as resolveActiveSkillByName but tries an explicit numeric skill id first.
 * An explicit id is a deliberate reference to one exact row (the assessments
 * export carries it precisely so a re-import is idempotent), so it is honoured
 * even when that row is retired — only NAME lookups are restricted to active
 * skills.
 */
async function resolveSkillByIdOrName(db, id, name, domain = null) {
    const raw = id == null ? '' : String(id).trim();
    if (raw && /^\d+$/.test(raw)) {
        const byId = await db.get('SELECT id FROM skills WHERE id = ?', [Number(raw)]);
        if (byId) return byId;
    }
    return resolveActiveSkillByName(db, name, domain);
}

/**
 * True when a skill name exists in the catalogue but ONLY as soft-retired rows.
 * Lets callers report "skill X is retired — row skipped" instead of the
 * misleading "skill not found".
 */
async function isRetiredOnly(db, name) {
    const clean = name == null ? '' : String(name).trim();
    if (!clean) return false;
    const row = await db.get(
        `SELECT COUNT(*) FILTER (WHERE is_active)::int AS active,
                COUNT(*)::int AS total
         FROM skills WHERE LOWER(name) = LOWER(?)`,
        [clean]
    );
    return Boolean(row && Number(row.total) > 0 && Number(row.active) === 0);
}

module.exports = { resolveActiveSkillByName, resolveSkillByIdOrName, isRetiredOnly };
