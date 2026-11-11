'use strict';
/**
 * Where an uploaded file's temp copy may live (CWE-22; CodeQL js/path-injection).
 *
 * multer's disk storage names the temp file itself (destination + 16 random
 * bytes in hex), so `file.path` is never the client's name. It still arrives on
 * an object built while parsing the request, so every read or unlink of it goes
 * through `containedUploadPath`: the path is resolved (no `..`, absolute) and
 * must sit strictly INSIDE one of the upload directories the routes configure.
 * Anything else answers null and the caller treats the upload as unreadable.
 *
 * @module utils/uploadTempPath
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

/** The upload temp directories (the multer `dest` values in src/, and the OS default). */
function uploadTempDirs() {
    return [
        path.resolve(ROOT, 'tmp'), // routes/index.js, routes/v2-slf.js
        path.resolve(process.cwd(), 'tmp'), // multer({ dest: path.resolve('tmp') })
        path.resolve(ROOT, 'AI_Engine_Docs', 'tmp'), // DataManagementController
        path.resolve(os.tmpdir()), // multer's own default destination
    ];
}

/**
 * The resolved path when it lies inside an upload temp directory, else null.
 * @param {unknown} p   the `path` of a multer file
 * @returns {string|null}
 */
function containedUploadPath(p) {
    if (typeof p !== 'string' || p === '' || p.includes('\0')) return null;
    const abs = path.resolve(p);
    for (const base of uploadTempDirs()) {
        if (abs.startsWith(base + path.sep)) return abs;
    }
    return null;
}

/**
 * The contained path of an uploaded file, for reading it. Throws a 400-class
 * error when multer's path is not inside an upload temp directory.
 * @param {{path?: unknown}|undefined} file
 * @returns {string}
 */
function uploadedPath(file) {
    const p = containedUploadPath(file && file.path);
    if (!p) {
        const err = new Error('The upload is not where uploads are kept.');
        err.status = 400;
        throw err;
    }
    return p;
}

/** Delete an uploaded temp file, if it is one. Never throws. */
function discardUpload(file) {
    const p = containedUploadPath(file && file.path);
    if (p) fs.unlink(p, () => {});
}

module.exports = { containedUploadPath, uploadTempDirs, uploadedPath, discardUpload };
