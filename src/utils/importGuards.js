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

// ---------------------------------------------------------------------------
// Zip-bomb guard for uploaded workbooks (audit 2026-09-29, SA-09).
//
// An .xlsx is a ZIP archive. The upload cap (10 MB, multer) bounds the
// COMPRESSED size only: a crafted 10 MB workbook can inflate to many GB of XML,
// and ExcelJS inflates it fully in memory, so one upload is enough to exhaust
// the heap and take the appliance down for everyone. Before any workbook is
// handed to ExcelJS, every entry is actually inflated here with a hard output
// cap (zlib maxOutputLength), so a size field that LIES in the archive headers
// cannot slip past either. Limits are generous for any real HR workbook and
// tunable through the environment.
// ---------------------------------------------------------------------------
const fs = require('fs');
const zlib = require('zlib');

const XLSX_LIMITS = Object.freeze({
    maxEntries: Number(process.env.XLSX_MAX_ENTRIES) || 5000,
    maxTotalBytes: Number(process.env.XLSX_MAX_UNCOMPRESSED_BYTES) || 200 * 1024 * 1024,
});

function zipRefusal(msg) {
    const e = new Error(`Refused workbook: ${msg}`);
    e.status = 400;
    e.expose = true;
    e.code = 'xlsx_unsafe';
    return e;
}

/**
 * Throw (400, expose) when the buffer is not a sane ZIP or inflates beyond the
 * limits. Returns { entries, totalBytes } when it is safe.
 * @param {Buffer} buf
 * @param {{maxEntries?:number, maxTotalBytes?:number}} [limits]
 */
function assertSafeXlsxBuffer(buf, limits = {}) {
    const maxEntries = limits.maxEntries || XLSX_LIMITS.maxEntries;
    const maxTotal = limits.maxTotalBytes || XLSX_LIMITS.maxTotalBytes;
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw zipRefusal('not a ZIP archive');
    // End of central directory: the last 0x06054b50 within the trailing 64 KiB + 22.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw zipRefusal('not a ZIP archive');
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw zipRefusal('ZIP64 is not supported');
    if (count > maxEntries) throw zipRefusal(`too many entries (${count})`);
    let p = cdOffset;
    let total = 0;
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
            throw zipRefusal('corrupt central directory');
        const method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff)
            throw zipRefusal('ZIP64 is not supported');
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50)
            throw zipRefusal('corrupt local header');
        const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        if (dataStart + csize > buf.length) throw zipRefusal('truncated entry');
        const remaining = maxTotal - total;
        if (usize > remaining) throw zipRefusal('uncompressed size exceeds the limit');
        let out = 0;
        if (method === 0) {
            out = csize;
        } else if (method === 8) {
            try {
                out = zlib.inflateRawSync(buf.subarray(dataStart, dataStart + csize), {
                    maxOutputLength: Math.max(1, remaining),
                }).length;
            } catch (e) {
                if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError))
                    throw zipRefusal('uncompressed size exceeds the limit');
                throw zipRefusal('corrupt compressed entry');
            }
        } else {
            throw zipRefusal(`unsupported compression method ${method}`);
        }
        total += out;
        if (total > maxTotal) throw zipRefusal('uncompressed size exceeds the limit');
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: count, totalBytes: total };
}

/** File-path flavour, for the multer temp file every import reads. */
function assertSafeXlsxFile(filepath, limits) {
    return assertSafeXlsxBuffer(fs.readFileSync(filepath), limits);
}

module.exports = {
    isNonDataRow,
    assertSafeXlsxBuffer,
    assertSafeXlsxFile,
    XLSX_LIMITS,
};
