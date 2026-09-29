'use strict';
/**
 * Accent-insensitive search fragments for raw SQL.
 *
 * When the unaccent extension (wrapped as f_unaccent, migration 46) is present,
 * ilike('col') yields "f_unaccent(col) ILIKE f_unaccent(?)" so 'Valery' matches
 * 'Valéry'. Without it, it degrades to plain ILIKE — same call sites, no crash.
 *
 * init(db) is called once at boot (server.js); until/without it, plain ILIKE.
 */
let hasUnaccent = false;

async function init(db) {
    try {
        const r = await db.get("SELECT 1 AS ok FROM pg_proc WHERE proname = 'f_unaccent'");
        hasUnaccent = Boolean(r && r.ok);
    } catch (_) {
        hasUnaccent = false;
    }
    return hasUnaccent;
}

// colExpr is a raw SQL expression (column or concatenation), NOT user input.
function ilike(colExpr) {
    return hasUnaccent ? `f_unaccent(${colExpr}) ILIKE f_unaccent(?)` : `${colExpr} ILIKE ?`;
}

module.exports = { init, ilike, isEnabled: () => hasUnaccent };
