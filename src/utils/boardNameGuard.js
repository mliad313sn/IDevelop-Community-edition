'use strict';

/**
 * The « no person's name » rule of the board decisions, enforced on the text.
 *
 * A board decision and its follow-up notes can never be rewritten (migration
 * 197), so a name typed once could never be erased. Before a text is written,
 * it is checked against the names of the people the writer may see.
 *
 * WHEN DOES A TEXT NAME A PERSON? When two DIFFERENT words of that person's
 * names (first names and last names, two letters or more, case and accents
 * ignored) stand next to each other, in either order. For a person recorded
 * as first name « Ada Grace », last name « Lovelace »: « Ada Lovelace »,
 * « Lovelace Ada » and « Grace Lovelace » all name her, not only the full
 * name as stored. One word alone is not refused: a single common word that
 * happens to be a surname would block ordinary decisions.
 *
 * Only ACTIVE, not erased people inside the writer's own clearance are
 * checked (RBACService.scopeFilter): the check never probes another
 * perimeter. The same matching serves the person's access export
 * (DSRService.export), which lists the board texts that name them.
 *
 * The text is split into words by a plain character loop, never by a regular
 * expression run on the input.
 */

/** Lower case, accents removed. */
function fold(s) {
    return String(s === null || s === undefined ? '' : s)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase();
}

const isWordChar = (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

/** The words of a text (a-z, 0-9), two characters or more, in order. Pure. */
function wordsOf(s) {
    const t = fold(s);
    const out = [];
    let cur = '';
    for (const c of t) {
        if (isWordChar(c)) {
            cur += c;
            continue;
        }
        if (cur.length >= 2) out.push(cur);
        cur = '';
    }
    if (cur.length >= 2) out.push(cur);
    return out;
}

/** Pure: does `text` hold two adjacent, different words of this person's names? */
function textNamesPerson(text, firstName, lastName) {
    const tokens = new Set([...wordsOf(firstName), ...wordsOf(lastName)]);
    if (tokens.size < 2) return false;
    const w = wordsOf(text);
    for (let i = 0; i + 1 < w.length; i++) {
        if (w[i] !== w[i + 1] && tokens.has(w[i]) && tokens.has(w[i + 1])) return true;
    }
    return false;
}

/** Pure: the first of `people` ({firstName, lastName}) that `text` names, or null. */
function firstNamed(text, people) {
    for (const p of people || []) {
        if (p && textNamesPerson(text, p.firstName, p.lastName)) return p;
    }
    return null;
}

/**
 * Does `text` name somebody the writer may see? Shorter than five characters
 * cannot hold two words of a name.
 */
async function boardTextNamesSomeone(text, user) {
    const s = String(text === null || text === undefined ? '' : text).trim();
    if (s.length < 5) return false;
    const RBACService = require('../services/RBACService');
    const db = require('../config/database');
    const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
    const rows = await db.all(
        `SELECT e.first_name AS "firstName", e.last_name AS "lastName"
           FROM employees e
          WHERE e.is_active = true AND e.erased_at IS NULL${sc.clause || ''}`,
        [...(sc.params || [])]
    );
    return firstNamed(s, rows) !== null;
}

module.exports = { wordsOf, textNamesPerson, firstNamed, boardTextNamesSomeone };
