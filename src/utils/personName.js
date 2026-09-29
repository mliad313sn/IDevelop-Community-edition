'use strict';

/**
 *  / M-20 — the ONE place that decides how a person is named.
 *
 * Passe 1 found the same person spelled two ways inside a single HTTP response
 * (`/cycles/9`: table « Clara Beatrice NOVAK », filter « Beatrice NOVAK Clara »)
 * and two ways between two CSV exports of the same product
 * (`/employees?export=csv` « Daniel Jean-Luc MORENO » vs
 *  `/admin/accounts/export.csv` « Jean-Luc MORENO, Daniel »).
 *
 * The passe-1 fix repaired the two cited call sites one by one, so the CLASS
 * survived in the EJS layer and in the accounts export. This module kills the
 * class: every surface that names a person goes through here, and the order is
 * decided once.
 *
 * The order is GIVEN NAME, then FAMILY NAME. That is not an arbitrary pick:
 *   - it is what the product already does on its dominant surfaces
 *     (employee table, campaign roster, both other CSV exports);
 *   - it is the order the search boxes index on
 *     (`InvitationController` :113 and `CycleService` :1008 both match
 *     `first_name || ' ' || last_name`), so a label a user copies from the
 *     screen is a label the same page's search can find again;
 *   - `last_name` here is a free-text field that routinely carries a compound
 *     name (employee 136 is first_name='Clara', last_name='Beatrice NOVAK'),
 *     so no consumer can split the two halves back apart — the display order
 *     is the only thing that tells a reader which half is which.
 *
 * Nothing is dropped: a person with only one of the two halves is still named
 * with the half that exists, never with a stray separator or an empty string.
 */

/** Name a person from the two halves. Never returns null for a named person. */
function personName(first, last) {
    const f = first == null ? '' : String(first).trim();
    const l = last == null ? '' : String(last).trim();
    if (f && l) return `${f} ${l}`;
    return f || l || '';
}

/**
 * Name a person from a row, whichever spelling the query used
 * (`firstName`/`first_name`). Returns '' when the row carries neither half,
 * so a caller can fall back on an employee number rather than print 'null'.
 */
function personNameOf(row) {
    if (!row) return '';
    return personName(
        row.firstName !== undefined ? row.firstName : row.first_name,
        row.lastName !== undefined ? row.lastName : row.last_name
    );
}

/**
 * The same decision, in SQL, for the queries that build the label server-side.
 * `alias` is the table alias holding first_name / last_name. COALESCE + TRIM so
 * a missing half yields the other half instead of NULL or a stray space —
 * the reversed spellings this replaces (`last_name || ', ' || first_name`)
 * went NULL as soon as one half was missing.
 */
function personNameSql(alias, columns) {
    const a = alias ? `${alias}.` : '';
    const first = (columns && columns.first) || 'first_name';
    const last = (columns && columns.last) || 'last_name';
    return `TRIM(COALESCE(${a}${first}, '') || ' ' || COALESCE(${a}${last}, ''))`;
}

module.exports = { personName, personNameOf, personNameSql };
