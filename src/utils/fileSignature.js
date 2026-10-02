'use strict';

/**
 * fileSignature: what an uploaded file REALLY is (ASVS 12.2.1).
 *
 * Upload routes used to trust the file name alone: `tool.exe` renamed
 * `certificate.pdf` was stored, scanned when a scanner existed, and served back
 * as a PDF. These checks look at the CONTENT:
 *
 *   detectKind(buffer)        the content family from the first bytes (magic
 *                             numbers): pdf, png, jpeg, zip, cfb (legacy .xls),
 *                             webp, ico, text, or null.
 *   inspectZip(buffer, lim)   walks the ZIP central directory with the app's one
 *                             ZIP reader (utils/importGuards.zipDirectory),
 *                             refuses ZIP64, encrypted and unknown-method
 *                             entries, caps the entry count and the TOTAL
 *                             uncompressed size, and measures the REAL inflated
 *                             size of every entry against what the directory
 *                             declares (a lying header is how a zip bomb slips
 *                             past a directory-only check). Memory stays at one
 *                             zlib window: the output is counted, then dropped.
 *                             Also returns [Content_Types].xml so an OOXML file
 *                             can be told apart from any other zip.
 *   checkFile(file, kinds)    both, for a multer file (disk or memory storage):
 *                             { ok, kind, mime } or { ok:false, code }.
 *
 * The `zip` kind (the ESCO CSV package of the skills library) checks the
 * directory only (sane, not encrypted, not ZIP64, bounded entry count). The
 * entries are not inflated here: the importer extracts only the CSVs it needs
 * through importGuards.readZipEntries, which caps every byte it inflates.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { zipDirectory, ZIP_READ_LIMITS } = require('./importGuards');
const { containedUploadPath } = require('./uploadTempPath');

// Extension -> the kind the CONTENT must prove. One table for every route.
const EXT_KIND = {
    '.pdf': 'pdf',
    '.png': 'png',
    '.jpg': 'jpeg',
    '.jpeg': 'jpeg',
    '.docx': 'docx',
    '.xlsx': 'xlsx',
    '.xls': 'xls',
    '.csv': 'text',
    '.tsv': 'text',
    '.txt': 'text',
    '.json': 'text',
    '.xml': 'text',
    '.yaml': 'text',
    '.yml': 'text',
    '.svg': 'svg',
    '.webp': 'webp',
    '.ico': 'ico',
    '.zip': 'zip',
};

// Canonical MIME stored for a verified kind (the browser-sent type is not trusted).
const KIND_MIME = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpeg: 'image/jpeg',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    text: 'text/plain',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    ico: 'image/x-icon',
    zip: 'application/zip',
};

// The main part an OOXML package must declare in [Content_Types].xml.
// Macro-enabled variants (.xlsm/.docm main parts) are deliberately NOT accepted.
const OOXML_MAIN = {
    xlsx: /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.(sheet|template)\.main\+xml/,
    docx: /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.(document|template)\.main\+xml/,
};
// A macro project inside an OOXML package, whatever the content types claim.
const MACRO_PART = /(^|\/)vbaProject\.bin$/i;

const MB = 1024 * 1024;
function envInt(name, dflt) {
    const n = parseInt(process.env[name], 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
}
function defaultZipLimits() {
    return {
        maxEntries: envInt('UPLOAD_ZIP_MAX_ENTRIES', 5000),
        maxUncompressed: envInt('UPLOAD_ZIP_MAX_UNCOMPRESSED_MB', 150) * MB,
    };
}

function startsWith(buf, bytes, at = 0) {
    if (!buf || buf.length < at + bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false;
    return true;
}

/** Text: no NUL byte in the sampled head (UTF-16 with a BOM is accepted as text). */
function looksLikeText(buf) {
    if (!buf || !buf.length) return true; // an empty CSV is text (the importer says "no rows")
    if (startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) return true;
    const head = buf.subarray(0, Math.min(buf.length, 64 * 1024));
    return head.indexOf(0) === -1;
}

/** Content family from the first bytes, or null when unrecognised. */
function detectKind(buf) {
    if (!buf || !buf.length) return 'text';
    // The PDF header may sit anywhere in the first KiB (ISO 32000-1 §7.5.2).
    if (buf.subarray(0, 1024).indexOf('%PDF-') !== -1) return 'pdf';
    if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]))
        return 'zip';
    if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'cfb';
    if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8))
        return 'webp';
    if (startsWith(buf, [0x00, 0x00, 0x01, 0x00])) return 'ico';
    // Executables are never "text", whatever their bytes look like.
    if (startsWith(buf, [0x4d, 0x5a]) || startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return null;
    if (looksLikeText(buf)) return 'text';
    return null;
}

class ZipRefusal extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const zipRefusal = (message, code) => new ZipRefusal(code || 'ZIP_MALFORMED', message);

/**
 * Count the bytes an entry REALLY inflates to, stopping as soon as it passes
 * `limit` (the output is discarded). Resolves the size, -1 past the limit,
 * -2 when it is not valid deflate.
 */
function inflatedSizeAtMost(compressed, limit) {
    return new Promise((resolve) => {
        let total = 0;
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            resolve(v);
        };
        const inf = zlib.createInflateRaw();
        inf.on('data', (chunk) => {
            total += chunk.length;
            if (total > limit) {
                finish(-1);
                inf.destroy();
            }
        });
        inf.on('error', () => finish(-2));
        inf.on('end', () => finish(total));
        inf.on('close', () => finish(total > limit ? -1 : total));
        inf.end(compressed);
    });
}

/** Central directory only (no inflation): typed refusals, encrypted entries refused. */
function zipEntries(buf, maxEntries) {
    const entries = zipDirectory(buf, maxEntries, zipRefusal);
    for (const e of entries) {
        if (e.flags & 0x1)
            throw new ZipRefusal('ZIP_UNSUPPORTED', 'encrypted entries are not accepted');
    }
    return entries;
}

/**
 * Inspect a ZIP held in memory. Resolves { entries, uncompressed, contentTypes,
 * names } or rejects with a ZipRefusal (code: ZIP_MALFORMED | ZIP_UNSUPPORTED |
 * ZIP_TOO_MANY_ENTRIES | ZIP_TOO_LARGE).
 */
async function inspectZip(buf, limits = {}) {
    const { maxEntries, maxUncompressed } = { ...defaultZipLimits(), ...limits };
    const entries = zipEntries(buf, maxEntries);
    let declaredTotal = 0;
    let realTotal = 0;
    let contentTypes = null;
    for (const e of entries) {
        declaredTotal += e.usize;
        if (declaredTotal > maxUncompressed)
            throw new ZipRefusal('ZIP_TOO_LARGE', 'declared uncompressed size over the limit');
        const data = buf.subarray(e.dataStart, e.dataStart + e.csize);
        let real;
        if (e.method === 0) {
            real = e.csize;
            if (real !== e.usize)
                throw new ZipRefusal('ZIP_MALFORMED', 'stored entry size mismatch');
        } else if (e.method === 8) {
            // Never trust the declared size: inflate (discarding) and stop past it.
            real = await inflatedSizeAtMost(data, e.usize);
            if (real === -2) throw new ZipRefusal('ZIP_MALFORMED', 'entry is not valid deflate');
            if (real < 0)
                throw new ZipRefusal('ZIP_TOO_LARGE', 'entry inflates past its declared size');
        } else {
            throw new ZipRefusal(
                'ZIP_UNSUPPORTED',
                `compression method ${e.method} is not accepted`
            );
        }
        realTotal += real;
        if (realTotal > maxUncompressed)
            throw new ZipRefusal('ZIP_TOO_LARGE', 'uncompressed size over the limit');
        if (e.name === '[Content_Types].xml' && e.usize <= MB) {
            contentTypes =
                e.method === 0
                    ? data.toString('utf8')
                    : zlib.inflateRawSync(data, { maxOutputLength: MB }).toString('utf8');
        }
    }
    return {
        entries: entries.length,
        uncompressed: realTotal,
        contentTypes,
        names: entries.map((e) => e.name),
    };
}

function fileBuffer(file) {
    if (file && Buffer.isBuffer(file.buffer)) return file.buffer;
    // Disk storage: only a temp file INSIDE an upload directory is read.
    const p = file ? containedUploadPath(file.path) : null;
    if (p) return fs.readFileSync(p);
    return null;
}

/**
 * Validate one multer file against the route's allowed kinds.
 * @returns {Promise<{ok:true, kind:string, mime:string} | {ok:false, code:string, detail?:string}>}
 */
async function checkFile(file, allowedKinds, zipLimits) {
    const ext = path.extname(String((file && file.originalname) || '')).toLowerCase();
    const expected = EXT_KIND[ext];
    if (!expected || !allowedKinds.includes(expected))
        return { ok: false, code: 'UPLOAD_TYPE_NOT_ALLOWED' };
    let buf;
    try {
        buf = fileBuffer(file);
    } catch (_) {
        buf = null;
    }
    if (!buf) return { ok: false, code: 'UPLOAD_UNREADABLE' };

    const got = detectKind(buf);
    const ooxml = expected === 'xlsx' || expected === 'docx';
    const match =
        (ooxml && got === 'zip') ||
        (expected === 'xls' && got === 'cfb') ||
        (expected === 'svg' &&
            got === 'text' &&
            /<svg[\s>]/i.test(buf.subarray(0, 64 * 1024).toString('utf8'))) ||
        got === expected;
    if (!match) return { ok: false, code: 'UPLOAD_TYPE_MISMATCH', detail: `${expected} vs ${got}` };

    try {
        if (ooxml) {
            const z = await inspectZip(buf, zipLimits);
            if (
                !z.contentTypes ||
                !OOXML_MAIN[expected].test(z.contentTypes) ||
                z.names.some((n) => MACRO_PART.test(n))
            )
                return {
                    ok: false,
                    code: 'UPLOAD_TYPE_MISMATCH',
                    detail: `${expected}: [Content_Types].xml`,
                };
        } else if (expected === 'zip') {
            zipEntries(buf, (zipLimits && zipLimits.maxEntries) || ZIP_READ_LIMITS.maxEntries);
        }
    } catch (e) {
        if (e instanceof ZipRefusal) return { ok: false, code: e.code, detail: e.message };
        return { ok: false, code: 'ZIP_MALFORMED', detail: e.message };
    }
    return { ok: true, kind: expected, mime: KIND_MIME[expected] };
}

module.exports = {
    EXT_KIND,
    KIND_MIME,
    detectKind,
    inspectZip,
    checkFile,
    ZipRefusal,
    defaultZipLimits,
};
