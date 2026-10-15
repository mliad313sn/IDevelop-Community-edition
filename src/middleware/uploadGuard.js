'use strict';

/**
 * uploadGuard: ONE wrapper for every multer mount (ASVS 12.2.1).
 *
 *   guardUpload(multerMiddleware, { kinds: ['pdf','png',...], json?: true })
 *
 * 1. Runs multer and turns EVERY parser failure into a client error: a
 *    truncated multipart body ("Unexpected end of form"), a malformed part
 *    header, an oversize file (413), an unexpected field. Without it they reach
 *    the error handler with no status, which answers 500 and writes a false
 *    server-error audit row.
 * 2. Checks every received file's CONTENT against the route's allow-list
 *    (utils/fileSignature: magic bytes, OOXML [Content_Types].xml with macro
 *    parts refused, zip-bomb caps). The extension alone is no longer believed.
 *    A mismatch is a 400 and the temp file is removed. The verified canonical
 *    MIME replaces the one the browser sent.
 *
 * 3. Refuses a client file name carrying a folder path, a control character or
 *    more than 200 characters (UPLOAD_BAD_NAME). Every multer instance runs
 *    with `preservePath: true`, so the guard sees the name the client sent; the
 *    disk name is always server-generated, the client name is display text.
 * 4. Runs the ANTIVIRUS GATE (App Setting `uploadAvScan`, on by default) on
 *    every file that passed the content check, before the route sees it:
 *      - a threat: refused (422 UPLOAD_REJECTED_AV), the temp file deleted,
 *        UPLOAD_REJECTED_AV audited;
 *      - no scanner verdict while a scan is REQUIRED (`requireMalwareScan`, read
 *        through MalwareScanService.requireScan): refused (503
 *        UPLOAD_AV_UNAVAILABLE), fail-closed, audited;
 *      - no scanner verdict otherwise: accepted and marked `not_scanned`, one
 *        WARN per process and an UPLOAD_NOT_SCANNED audit row.
 *    The verdict rides on the file (`file.avScan`), so the evidence and
 *    certificate services record it instead of scanning the file twice.
 *
 * Refusals answer JSON to the app's own fetch calls (x-csrf-token header,
 * wantsJson, or `json: true` for endpoints that only ever answer JSON). A native
 * form post goes back to its page with a flash message, or through the error
 * handler (styled 400 page) when there is no same-origin page to return to.
 */

const fs = require('fs');
const { checkFile } = require('../utils/fileSignature');
const { containedUploadPath } = require('../utils/uploadTempPath');
const { wantsJson } = require('../utils/wantsJson');

const MESSAGES = {
    UPLOAD_TYPE_NOT_ALLOWED: [
        'compliance:upload_err_type_not_allowed',
        'This file type is not accepted here.',
    ],
    UPLOAD_TYPE_MISMATCH: [
        'compliance:upload_err_type_mismatch',
        'The file content does not match its extension.',
    ],
    UPLOAD_UNREADABLE: ['compliance:upload_err_malformed', 'The uploaded file could not be read.'],
    UPLOAD_MALFORMED: [
        'compliance:upload_err_malformed',
        'The upload was incomplete or malformed.',
    ],
    UPLOAD_TOO_LARGE: ['compliance:upload_err_too_large', 'The file is too large.'],
    ZIP_MALFORMED: ['compliance:upload_err_malformed', 'The upload was incomplete or malformed.'],
    ZIP_UNSUPPORTED: [
        'compliance:upload_err_zip_unsupported',
        'This archive format is not supported (encrypted or ZIP64 archive).',
    ],
    ZIP_TOO_MANY_ENTRIES: [
        'compliance:upload_err_zip_entries',
        'The file contains too many internal parts to be imported safely.',
    ],
    ZIP_TOO_LARGE: [
        'compliance:upload_err_zip_too_large',
        'The file expands to more data than can be imported safely. Split it into smaller files.',
    ],
    UPLOAD_BAD_NAME: [
        'compliance:upload_err_bad_name',
        'This file name cannot be accepted: it must not contain a folder path or control characters, and must be 200 characters or fewer.',
    ],
    UPLOAD_REJECTED_AV: [
        'compliance:upload_err_av',
        'The antivirus found a threat in this file. The file was refused and deleted.',
    ],
    UPLOAD_AV_UNAVAILABLE: [
        'compliance:upload_err_av_unavailable',
        'No antivirus is available to check this file, and every upload must be scanned.',
    ],
};

function say(req, code) {
    const [key, fallback] = MESSAGES[code] || MESSAGES.UPLOAD_MALFORMED;
    if (!req || typeof req.t !== 'function') return fallback;
    const s = req.t(key, { defaultValue: fallback });
    return !s || s === key || s === key.split(':').pop() ? fallback : s;
}

/** Longest client file name accepted (characters). */
const MAX_NAME_LENGTH = 200;

/**
 * True when the client's file name is refused: empty, longer than
 * MAX_NAME_LENGTH, carrying a folder separator or a control character, or
 * made of dots only. A character loop, no pattern that could backtrack.
 */
function badName(name) {
    const s = typeof name === 'string' ? name : '';
    if (!s || s.length > MAX_NAME_LENGTH) return true;
    let dotsOnly = true;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        // C0 controls, DEL, '/' and '\'
        if (c < 0x20 || c === 0x7f || c === 0x2f || c === 0x5c) return true;
        if (c !== 0x2e && c !== 0x20) dotsOnly = false;
    }
    return dotsOnly;
}

// ---------------------------------------------------------------------------
// Antivirus gate
// ---------------------------------------------------------------------------

let _warnedNotScanned = false;

/** Off only on an explicit false; anything else (absent row, unreadable) is on. */
function isOff(v) {
    return v === false || v === 'false' || v === 0 || v === '0';
}

// Seams the unit tests replace (scanner, settings, audit).
const _deps = {
    scanFile: (p) => require('../services/MalwareScanService').scanFile(p),
    scanBuffer: (b) => require('../services/MalwareScanService').scanBuffer(b),
    requireScan: () => require('../services/MalwareScanService').requireScan(),
    enabled: async () => {
        try {
            const v = await require('../models/AppSettingsModel').getValue('uploadAvScan', true);
            return !isOff(v);
        } catch (_) {
            return true;
        }
    },
    audit: (row) => require('../services/LogService').log(row),
};

function actorOf(req) {
    const u = req && req.user;
    if (!u || u.id == null) return {};
    return u.userType === 'admin'
        ? { adminId: u.id, actorRef: `admin:${u.id}` }
        : { actorRef: `employee:${u.id}` };
}

/** One audit row about an upload: ids, kind and size, never the client file name. */
function auditUpload(req, action, detail) {
    try {
        return Promise.resolve(
            _deps.audit({
                ...actorOf(req),
                action,
                entityType: 'upload',
                details: JSON.stringify(detail),
                severity: 'warn',
                category: 'security',
                route: req && req.originalUrl ? String(req.originalUrl).split('?')[0] : null,
                httpMethod: (req && req.method) || null,
                ipAddress: (req && req.ip) || null,
                userAgent: req && typeof req.get === 'function' ? req.get('user-agent') : null,
            })
        ).catch(() => {});
    } catch (_) {
        return Promise.resolve();
    }
}

/**
 * Scan one multer file: { av: 'clean'|'infected'|'unavailable', engine, signature?, error? }.
 * A disk upload is scanned where multer put it (only inside an upload temp
 * directory); a memory-storage upload through a private copy the scanner
 * service writes and removes (MalwareScanService.scanBuffer).
 */
async function scanOne(f) {
    const target = f && f.path ? containedUploadPath(f.path) : null;
    try {
        let r;
        if (target) r = await _deps.scanFile(target);
        else if (f && !f.path && Buffer.isBuffer(f.buffer)) r = await _deps.scanBuffer(f.buffer);
        else return { av: 'unavailable', engine: null, error: 'no file to scan' };
        r = r || {};
        if (r.verdict === 'clean') return { av: 'clean', engine: r.engine || null };
        if (r.verdict === 'infected')
            return { av: 'infected', engine: r.engine || null, signature: r.signature };
        // multer wrote this file a moment ago: gone now means a real-time host
        // antivirus removed it. That is a detection.
        if (r.verdict === 'missing')
            return { av: 'infected', engine: 'host', signature: 'removed by host antivirus' };
        return {
            av: 'unavailable',
            engine: null,
            error: (r.errors || []).join(' | ') || 'no scanner',
        };
    } catch (e) {
        return { av: 'unavailable', engine: null, error: (e && e.message) || 'scan failed' };
    }
}

/** Is a scan required right now (requireMalwareScan)? Errors read as not required. */
async function scanRequired() {
    try {
        return Boolean(await _deps.requireScan());
    } catch (_) {
        return false;
    }
}

/**
 * The antivirus gate over every received file. Resolves null (go on) or
 * { status, code } (refuse). One rule: a threat is refused; no verdict is
 * refused only while a scan is required, else accepted as not scanned.
 */
async function avGate(req, files) {
    if (!files.length) return null;
    if (!(await _deps.enabled())) {
        for (const f of files) f.avScan = { av: 'off', engine: null };
        return null;
    }
    for (const f of files) {
        const r = await scanOne(f);
        const detail = {
            av: r.av,
            engine: r.engine || null,
            field: f.fieldname || null,
            kind: f.verifiedKind || null,
            size: f.size != null ? f.size : null,
        };
        if (r.av === 'infected') {
            f.avScan = r;
            await auditUpload(req, 'UPLOAD_REJECTED_AV', {
                ...detail,
                signature: String(r.signature || '').slice(0, 200),
            });
            return { status: 422, code: 'UPLOAD_REJECTED_AV' };
        }
        if (r.av !== 'unavailable') {
            f.avScan = r;
            continue;
        }
        if (await scanRequired()) {
            f.avScan = r;
            await auditUpload(req, 'UPLOAD_REFUSED_NOT_SCANNED', detail);
            return { status: 503, code: 'UPLOAD_AV_UNAVAILABLE' };
        }
        f.avScan = { av: 'not_scanned', engine: null };
        if (!_warnedNotScanned) {
            _warnedNotScanned = true;
            console.warn(
                '[upload-av] no antivirus verdict: uploads are accepted and marked not scanned (warned once per process).'
            );
        }
        await auditUpload(req, 'UPLOAD_NOT_SCANNED', { ...detail, av: 'not_scanned' });
    }
    return null;
}

function allFiles(req) {
    const out = [];
    if (req.file) out.push(req.file);
    if (Array.isArray(req.files)) out.push(...req.files);
    else if (req.files && typeof req.files === 'object')
        for (const arr of Object.values(req.files)) if (Array.isArray(arr)) out.push(...arr);
    return out;
}

function removeTemp(files) {
    for (const f of files) {
        // Only a temp file inside an upload directory is ever deleted.
        const p = f ? containedUploadPath(f.path) : null;
        if (p) fs.unlink(p, () => {});
    }
}

/** The Referer path when it is this site's own page, else null. */
function sameOriginReferer(req) {
    try {
        const ref = req.get && req.get('referer');
        const host = req.get && req.get('host');
        if (!ref || !host) return null;
        const u = new URL(ref);
        if (u.host !== host) return null;
        return u.pathname + u.search;
    } catch (_) {
        return null;
    }
}

function refuse(req, res, next, status, code, forceJson) {
    const message = say(req, code);
    const jsonish =
        forceJson || wantsJson(req) || Boolean(req.headers && req.headers['x-csrf-token']);
    if (jsonish)
        return res
            .status(status)
            .json({ ok: false, success: false, code, error: message, message });
    // A native form post (e.g. a certificate with its evidence): back to the form
    // with the reason, rather than a bare error page that loses the context.
    const back = sameOriginReferer(req);
    if (back && typeof req.flash === 'function') {
        req.flash('error', message);
        return res.redirect(303, back);
    }
    const err = new Error(message);
    err.status = status;
    err.expose = true;
    err.code = code;
    return next(err);
}

/** Multer / busboy error -> { status, code }. Every one of them is the client's fault. */
function classify(err) {
    const c = err && err.code;
    if (c === 'LIMIT_FILE_SIZE' || c === 'LIMIT_FIELD_VALUE' || c === 'LIMIT_PART_COUNT')
        return { status: 413, code: 'UPLOAD_TOO_LARGE' };
    if (c === 'UPLOAD_TYPE_NOT_ALLOWED') return { status: 400, code: 'UPLOAD_TYPE_NOT_ALLOWED' };
    return { status: 400, code: 'UPLOAD_MALFORMED' };
}

/** A fileFilter refusal that the guard reports as a typed 400 (not a silent drop, not a 500). */
function typeNotAllowed() {
    const e = new Error('file type not allowed');
    e.code = 'UPLOAD_TYPE_NOT_ALLOWED';
    return e;
}

/**
 * A multer fileFilter accepting only the given extensions (lower-case, with
 * the dot); anything else is a typed refusal.
 */
function extensionFilter(exts) {
    const allowed = exts.map((e) => e.toLowerCase());
    return (req, file, cb) => {
        const name = String((file && file.originalname) || '').toLowerCase();
        const ok = allowed.some((e) => name.endsWith(e));
        cb(ok ? null : typeNotAllowed(), ok);
    };
}

function guardUpload(multerMiddleware, { kinds, zipLimits, json = false } = {}) {
    if (typeof multerMiddleware !== 'function')
        throw new Error('guardUpload: multer middleware required');
    if (!Array.isArray(kinds) || !kinds.length)
        throw new Error('guardUpload: kinds allow-list required');
    // Marked so a test can enumerate every upload mount from the live router
    // stacks (tests/unit/csrfMultipart.test.js proves each one is CSRF-checked).
    const guardedUpload = function guardedUpload(req, res, next) {
        multerMiddleware(req, res, async (err) => {
            if (err) {
                removeTemp(allFiles(req));
                const { status, code } = classify(err);
                return refuse(req, res, next, status, code, json);
            }
            const files = allFiles(req);
            try {
                for (const f of files) {
                    if (badName(f.originalname)) {
                        removeTemp(files);
                        return refuse(req, res, next, 400, 'UPLOAD_BAD_NAME', json);
                    }
                    const r = await checkFile(f, kinds, zipLimits);
                    if (!r.ok) {
                        removeTemp(files);
                        return refuse(req, res, next, 400, r.code, json);
                    }
                    f.mimetype = r.mime;
                    f.verifiedKind = r.kind;
                }
                const avRefusal = await avGate(req, files);
                if (avRefusal) {
                    removeTemp(files);
                    return refuse(req, res, next, avRefusal.status, avRefusal.code, json);
                }
            } catch (e) {
                removeTemp(files);
                return refuse(req, res, next, 400, 'UPLOAD_MALFORMED', json);
            }
            return next();
        });
    };
    Object.defineProperty(guardedUpload, 'uploadGuard', { value: Object.freeze([...kinds]) });
    return guardedUpload;
}

module.exports = {
    guardUpload,
    typeNotAllowed,
    extensionFilter,
    badName,
    MAX_NAME_LENGTH,
    MESSAGES,
    __test: {
        deps: _deps,
        avGate,
        resetWarn() {
            _warnedNotScanned = false;
        },
        warned: () => _warnedNotScanned,
    },
};
