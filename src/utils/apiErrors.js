'use strict';

/**
 * JSON error discipline for the talent JSON controllers (9-box, coaching plans,
 * self-assessment workflow).
 *
 * THE DEFECT THIS CLOSES
 * Those three controllers each carried the same `handle` wrapper which ended
 * with `res.status(code).json({ success: false, error: err.message })` —
 * UNCONDITIONALLY, for every throw. That bypasses middleware/errorHandler and its
 * environment gate entirely, so anything the DB driver raised went straight to
 * the browser: `invalid input syntax for type bigint: "abc"` (schema type),
 * `duplicate key value violates unique constraint "uq_idp_open_per_employee"`
 * (index and table names), `relation "…" does not exist`, connection strings in
 * a pool error. That is free reconnaissance for anyone with a login.
 *
 * THE RULE
 * The services raise DELIBERATE domain errors whose wording IS the user feedback
 * ("Not authorized: supervisor/admin only", "Evaluation not found", "Cannot
 * submit from 'approved'", "A rejection reason is required."). Those are mapped
 * to their status and passed through unchanged — the UI depends on them.
 * Everything that looks like a driver/runtime fault instead becomes ONE generic
 * French sentence plus the request id, and the real error is written to the
 * error log and the audit trail so an operator can still reconstruct it.
 *
 * Classification is by SHAPE, not by a message blacklist: a pg error carries a
 * 5-character SQLSTATE `code` (plus `severity` / `routine` / `file`), and a
 * programming fault is a TypeError / RangeError / ReferenceError / SyntaxError.
 * Both are internal by construction, so a new domain message added to a service
 * later keeps working without touching this file.
 *
 * @module utils/apiErrors
 */

/** Generic client-facing text for anything we refuse to describe. FR-first. */
const GENERIC_FR =
    'Une erreur technique est survenue. Réessayez ou contactez votre administrateur.';
/** Client-facing text for a malformed identifier in the URL. FR-first. */
const INVALID_ID_FR = 'identifiant invalide';

/** Runtime/programming faults — never the user's business. */
const INTERNAL_ERROR_TYPES = [
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    EvalError,
    URIError,
];

/**
 * Message signatures of driver/infrastructure faults that reach us as a plain
 * Error (a pool wrapper, a rethrow that dropped `code`). Belt and braces on top
 * of the structural test below.
 */
const INTERNAL_MESSAGE = new RegExp(
    [
        'invalid input syntax',
        'does not exist',
        'duplicate key value',
        'violates .*constraint',
        'out of range',
        'could not (?:connect|serialize)',
        'connection (?:terminated|refused|timeout)',
        'timeout exceeded when trying to connect',
        'ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EPIPE',
        'password authentication failed',
        'too many clients',
        'deadlock detected',
        'current transaction is aborted',
        'is not a function',
        'Cannot read propert',
    ].join('|'),
    'i'
);

/**
 * Is this error an INTERNAL fault (DB/driver/programming) rather than a
 * deliberate domain error raised by a service?
 * @param {any} err
 * @returns {boolean}
 */
function isInternal(err) {
    if (!err) return true;
    if (INTERNAL_ERROR_TYPES.some((T) => err instanceof T)) return true;
    // node-postgres: SQLSTATE is exactly 5 chars of [0-9A-Z]; the rest of the
    // DatabaseError shape is equally conclusive.
    const code = String(err.code || '');
    if (/^[0-9A-Z]{5}$/.test(code)) return true;
    if (err.severity || err.routine || err.sqlState || err.schema || err.constraint) return true;
    // Node system errors (ECONNREFUSED & friends) carry an errno.
    if (typeof err.errno === 'number') return true;
    return INTERNAL_MESSAGE.test(String(err.message || ''));
}

/**
 * HTTP status for a DOMAIN error, from the shape of its message. This is the
 * same ladder the three controllers already used — kept byte-identical so no
 * client-side branch changes behaviour.
 * @param {string} msg
 * @returns {number}
 */
function domainStatus(msg) {
    if (/not authorized/i.test(msg)) return 403;
    if (/not found/i.test(msg)) return 404;
    if (/cannot .* from/i.test(msg)) return 409;
    return 400;
}

/**
 * M-02 — the refusal, in the language the page is being read in.
 *
 * A service raises its refusal in ENGLISH on purpose: that sentence is the
 * REFERENCE (the logs quote it, `domainStatus` above derives the status from it,
 * suites pin it). It was also what the USER read — on a page whose `<html lang>`
 * says "fr". `SelfAssessmentWorkflowService.say` therefore attaches
 * `e.i18n = {key, vars}` beside the message, and the translation happens HERE,
 * in the one place every JSON controller of this family already funnels through.
 *
 * It lived in `AssessmentChangeRequestController` instead, so exactly one
 * controller spoke French: the keys posted on the workflow service's own
 * refusals were DEAD on the routes of `SelfAssessmentWorkflowController`, which
 * takes `makeHandle` directly. Nothing about a translation is controller-specific,
 * so it belongs to the wrapper, not to a controller that remembered to ask.
 *
 * Two variables are never printed raw:
 *  - `stateRaw` — a workflow_state token ('draft') goes through the same
 *    dictionary as the tables (`admin:enum_sa_state_*`), so the sentence reads
 *    « Brouillon » and never exposes a database value;
 *  - `outcomeRaw` — a request outcome ('withdrawn') through `assess:acr_status_*`.
 *
 * `defaultValue` is the English reference sentence: a missing key degrades to the
 * behaviour of before, never to a raw key on screen.
 *
 * @param {object} req the Express request (for `req.t`)
 * @param {any} err the thrown error, possibly carrying `.i18n`
 * @param {string} [fallback] text to use when the error carries no message
 * @returns {string}
 */
function sayError(req, err, fallback) {
    const msg = err && err.message ? String(err.message) : '';
    const i = err && err.i18n;
    if (!i || !i.key || !req || typeof req.t !== 'function') return msg || fallback || '';
    const vars = { ...(i.vars || {}) };
    try {
        const { enumLabel } = require('./enumLabels');
        if (vars.stateRaw) vars.state = enumLabel('sa_state', vars.stateRaw, req.t);
    } catch (_) {
        if (vars.stateRaw) vars.state = vars.stateRaw;
    }
    if (vars.outcomeRaw) {
        vars.outcome = req.t(`assess:acr_status_${vars.outcomeRaw}`, {
            defaultValue: vars.outcomeRaw,
        });
    }
    return req.t(i.key, { defaultValue: msg || fallback || '', ...vars });
}

/**
 * The same catalogue lookup for a refusal that is NOT thrown — a route that
 * answers `res.status(403).json({ error: … })` inline. Thirteen such lines wrote
 * « Not authorized for this employee » as an English literal across five route
 * files and one controller, and no `say` could ever reach them.
 *
 * @param {object} req
 * @param {string} key catalogue key, e.g. 'common:err_not_authorized_employee'
 * @param {string} fallback the English reference sentence
 * @param {object} [vars]
 * @returns {string}
 */
function sayText(req, key, fallback, vars) {
    if (!req || typeof req.t !== 'function') return fallback;
    const s = req.t(key, { defaultValue: fallback, ...(vars || {}) });
    return typeof s === 'string' && s && s !== key ? s : fallback;
}

/**
 * Log an internal fault so nothing is lost by the generic response: winston (for
 * the stack) plus the DB audit trail (for the System Logs "issues" view), both
 * carrying the request id that ties them to the request the user saw fail.
 * Best-effort — logging must never turn a handled error into an unhandled one.
 */
function logInternal(err, req, where) {
    const requestId = (req && req.id) || null;
    try {
        require('../middleware/logger').logger.error(`[${where}] ${err && err.message}`, {
            requestId,
            stack: err && err.stack,
            url: req && req.originalUrl,
            method: req && req.method,
            userId: req && req.user ? req.user.id : null,
        });
    } catch (_) {
        /* logger unavailable — continue */
    }
    try {
        require('../services/LogService')
            .log({
                action: 'SERVER_ERROR',
                entityType: 'system',
                details: `${where}: ${String((err && err.message) || 'unknown').slice(0, 300)}`,
                severity: 'error',
                category: 'system',
                requestId,
                ipAddress: req && req.ip,
                userAgent: req && req.get ? req.get('user-agent') : null,
                actorRef: req && req.user ? `${req.user.userType}:${req.user.id}` : null,
            })
            .catch(() => {});
    } catch (_) {
        /* audit unavailable — continue */
    }
}

/**
 * Translate a thrown error into the JSON body + status to send.
 * @param {any} err
 * @param {object} req  the Express request (for the id + audit context)
 * @param {string} where a short label naming the controller, for the log line
 * @returns {{status:number, body:{success:false, error:string, requestId?:string}}}
 */
function toResponse(err, req, where) {
    // A guard that already decided its own status (see `badId`) is authoritative.
    if (err && err.expose && err.status) {
        return { status: err.status, body: { success: false, error: sayError(req, err) } };
    }
    if (isInternal(err)) {
        logInternal(err, req, where || 'controller');
        const requestId = (req && req.id) || null;
        return {
            status: 500,
            body: requestId
                ? { success: false, error: GENERIC_FR, requestId }
                : { success: false, error: GENERIC_FR },
        };
    }
    const msg = err && err.message ? String(err.message) : 'Error';
    // The STATUS is read from the ENGLISH reference sentence, BEFORE translation:
    // `domainStatus` matches "not authorized" / "not found" / "cannot … from",
    // and a French sentence would make it answer 400 everywhere.
    return { status: domainStatus(msg), body: { success: false, error: sayError(req, err) } };
}

/**
 * Build the shared `handle` wrapper used by a JSON controller.
 *
 * @param {string} where short label for the log line, e.g. 'NineBoxController'
 * @returns {(fn: Function) => import('express').RequestHandler}
 */
function makeHandle(where) {
    return function handle(fn) {
        return async (req, res) => {
            try {
                const result = await fn(req, res);
                if (res.headersSent) return;
                res.json({ success: true, ...result });
            } catch (err) {
                if (res.headersSent) return;
                const { status, body } = toResponse(err, req, where);
                res.status(status).json(body);
            }
        };
    };
}

/**
 * Coerce a route/body identifier to a positive integer, or throw a 400 that
 * `toResponse` passes through verbatim.
 *
 * Call this BEFORE any query: `Number('abc')` is NaN, and NaN reaching a bigint
 * column made PostgreSQL answer `invalid input syntax for type bigint: "NaN"` —
 * a 500 that told the caller the column type. A malformed id is a 400.
 *
 * @param {any} raw
 * @param {string} [label] what the id names, appended to the message
 * @returns {number}
 */
function requireId(raw, label) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        const e = new Error(label ? `${INVALID_ID_FR} (${label})` : INVALID_ID_FR);
        e.status = 400;
        e.expose = true;
        throw e;
    }
    return n;
}

module.exports = {
    GENERIC_FR,
    INVALID_ID_FR,
    isInternal,
    domainStatus,
    sayError,
    sayText,
    toResponse,
    makeHandle,
    requireId,
};
