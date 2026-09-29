'use strict';

/**
 * Guards for spreadsheet imports. Template workbooks often carry an "Instructions"
 * / "Notes" / "Skill Levels" block above the data; without a guard those rows get
 * imported as real roles/skills (this is how junk like "Instructions:", "1. Fill in
 * roles…", "0 = Novice, 1 = Beginner…" ended up in the roles table). Reject any row
 * whose first cell is clearly narrative/header text rather than a name.
 */

// Section headers, bullets, numbered steps, level legends, and auto-generated test rows.
const INSTRUCTION_PATTERNS = [
    /^\s*instructions?\s*:/i,
    /^\s*notes?\s*:/i,
    /^\s*skill levels?\s*:/i,
    /^\s*[-*•]\s/, // bullet lines: "- Role names must be unique"
    /^\s*\d+\s*[.)]\s/, // numbered steps: "1. Fill in roles…"
    /\bmust (be|exist|have)\b/i,
    /\bmark critical\b/i,
    /\bfill in\b/i,
    /\bdefine skill\b/i,
    /\blink requirements\b/i,
    /\bsave and import\b/i,
    /\b(e\.g\.|example|template|column)\b/i,
    /\d+\s*=\s*\w+.*\d+\s*=\s*\w+/, // level legend: "0 = Novice, 1 = Beginner…"
    /^Filter_Role_\d+_\d+$/, // auto-generated filter test artifacts
];

/** True if `name` looks like an instruction/header/legend row, not a real entity name. */
function isNonDataRow(name) {
    if (name == null) return true;
    // ExcelJS cells can be objects (rich text / formula results).
    const s = String(typeof name === 'object' && name.text != null ? name.text : name).trim();
    if (!s) return true;
    if (s.length > 120) return true; // a role/skill name this long is almost certainly prose
    return INSTRUCTION_PATTERNS.some((re) => re.test(s));
}

module.exports = { isNonDataRow };
