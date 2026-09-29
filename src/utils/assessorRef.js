'use strict';
const db = require('../config/database');

/**
 * `skill_assessments.assessed_by` is an **admins.id** (FK → admins, NOT employees).
 * Exports must resolve it to the admin's username, and imports must resolve a
 * label back to an admins.id — never an employees.id (the id spaces overlap, so
 * the old code that JOINed employees on assessed_by matched unrelated people and
 * on import wrote an employees.id into an admins-FK column → 23503).
 */

/** Load the admin id↔username maps once per export/import. */
async function buildAdminMaps() {
    const rows = await db.all('SELECT id, username FROM admins');
    const byId = new Map();
    const byName = new Map();
    for (const r of rows) {
        byId.set(Number(r.id), r.username);
        if (r.username) byName.set(String(r.username).trim().toLowerCase(), Number(r.id));
    }
    return { byId, byName };
}

/** admins.id → a stable, human label that round-trips through resolveAssessorId. */
function labelForAssessor(assessedById, byId) {
    if (assessedById == null || assessedById === '') return '';
    const uname = byId.get(Number(assessedById));
    return uname ? `Admin: ${uname}` : `Admin #${assessedById}`;
}

/**
 * Parse an exported "Assessed By" cell back to an admins.id.
 * Accepts "Admin: <username>", "<username>", or "Admin #<id>". Falls back to the
 * importing admin, then any admin — so a re-import never FK-violates.
 */
function resolveAssessorId(cell, byName, byId, fallbackAdminId) {
    const raw = cell == null ? '' : String(cell).trim();
    if (raw) {
        const byNum = raw.match(/^Admin\s*#\s*(\d+)$/i);
        if (byNum && byId.has(Number(byNum[1]))) return Number(byNum[1]);
        const withPrefix = raw.match(/^Admin:\s*(.+)$/i);
        const name = (withPrefix ? withPrefix[1] : raw).trim().toLowerCase();
        if (byName.has(name)) return byName.get(name);
        // A bare numeric that IS a real admin id (legacy exports emitted raw id).
        if (/^\d+$/.test(raw) && byId.has(Number(raw))) return Number(raw);
    }
    return fallbackAdminId != null ? Number(fallbackAdminId) : null;
}

/** The account assessments are attributed to when nothing else resolves. */
async function defaultAssessorId() {
    const a =
        (await db.get(
            "SELECT id FROM admins WHERE username = 'admin' AND is_active = true ORDER BY id LIMIT 1"
        )) || (await db.get('SELECT id FROM admins ORDER BY id LIMIT 1'));
    return a ? Number(a.id) : null;
}

module.exports = { buildAdminMaps, labelForAssessor, resolveAssessorId, defaultAssessorId };
