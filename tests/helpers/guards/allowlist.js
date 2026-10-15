'use strict';
/**
 * Guard tests — the shared allow-list (tests/helpers/guards/allowlist.json).
 *
 * Every entry carries a written `reason`; an entry without one (or with a
 * reason shorter than 8 characters) is itself a failure in each suite. The
 * sections are described in the `_doc` key of the JSON file.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'allowlist.json');
const ALL = JSON.parse(fs.readFileSync(FILE, 'utf8'));

function section(name) {
    const s = ALL[name];
    if (!Array.isArray(s)) throw new Error(`allowlist.json has no section "${name}"`);
    return s;
}
/** entries of a section missing a reason (must be []) */
function unreasoned(name) {
    return section(name).filter((e) => !e.reason || String(e.reason).trim().length < 8);
}
/** true when every key of `probe` equals the entry's (entries may be partial: file, col, literal…) */
function matches(entry, probe) {
    return Object.keys(entry).every((k) => k === 'reason' || k === 'id' || entry[k] === probe[k]);
}
function allowed(name, probe) {
    return section(name).some((e) => matches(e, probe));
}

module.exports = { FILE, ALL, section, unreasoned, allowed, matches };
