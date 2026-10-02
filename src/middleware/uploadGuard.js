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
};

function say(req, code) {
    const [key, fallback] = MESSAGES[code] || MESSAGES.UPLOAD_MALFORMED;
    if (!req || typeof req.t !== 'function') return fallback;
    const s = req.t(key, { defaultValue: fallback });
    return !s || s === key || s === key.split(':').pop() ? fallback : s;
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
                    const r = await checkFile(f, kinds, zipLimits);
                    if (!r.ok) {
                        removeTemp(files);
                        return refuse(req, res, next, 400, r.code, json);
                    }
                    f.mimetype = r.mime;
                    f.verifiedKind = r.kind;
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

module.exports = { guardUpload, typeNotAllowed, extensionFilter, MESSAGES };
