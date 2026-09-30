'use strict';

/**
 * JSON-only APIs refuse a body they cannot parse (ASVS 13.1.5, 13.2.5).
 *
 * The global parser in server.js only reads `application/json` and
 * `application/*+json` bodies. Any other body (text/plain, a form, XML) used to
 * reach the handler as an EMPTY `req.body`, so the route ran on missing input
 * instead of saying what was wrong. Mounted in front of `/api/v1` and
 * `/scim/v2`, which speak JSON only, this answers 415 Unsupported Media Type.
 *
 * A request without a body (a DELETE, a POST that only names a resource) is
 * not affected: only a request that carries bytes must declare JSON.
 */

const JSON_TYPE = /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasBody(req) {
    if (req.headers['transfer-encoding'] !== undefined) return true;
    const len = Number(req.headers['content-length']);
    return Number.isFinite(len) && len > 0;
}

function isJsonContentType(ct) {
    return JSON_TYPE.test(String(ct || '').trim());
}

function requireJsonBody(req, res, next) {
    if (!BODY_METHODS.has(req.method) || !hasBody(req)) return next();
    if (isJsonContentType(req.headers['content-type'])) return next();
    res.set('Accept', 'application/json');
    return res.status(415).json({
        error: 'unsupported_media_type',
        detail: 'This API accepts JSON bodies only (Content-Type: application/json).',
    });
}

module.exports = { requireJsonBody, isJsonContentType, hasBody };
