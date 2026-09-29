'use strict';

/**
 * CSV / spreadsheet formula-injection protection.
 *
 * A cell whose text starts with `=`, `+`, `-`, `@` (or a leading TAB/CR) is
 * interpreted as a formula by Excel / Google Sheets / LibreOffice — so an
 * attacker-supplied value like `=HYPERLINK(...)` or `=cmd|'/c calc'!A1` would
 * execute when an admin opens an exported report. Prefix a single quote so the
 * cell is always rendered as inert text.
 */
function neutralize(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
    return s;
}

/** Neutralize + RFC-4180 quote (escape `"`, wrap in quotes). */
function csvCell(value) {
    return '"' + neutralize(value).replace(/"/g, '""') + '"';
}

module.exports = { neutralize, csvCell };
