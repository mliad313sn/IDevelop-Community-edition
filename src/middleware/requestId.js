'use strict';

const crypto = require('crypto');
const db = require('../config/database');

// Correlation id per request. Accepts an inbound X-Request-Id (for trusted
// upstreams / trace propagation) but validates it as a UUID, otherwise mints one.
// Establishes a DB correlation context so slow-query/db-error telemetry recorded
// deep in the model layer can be stitched back to this HTTP request, and echoes the
// id back in a response header so a user can quote it in a support ticket.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = function requestId(req, res, next) {
    const inbound = req.get('x-request-id');
    const id = inbound && UUID_RE.test(inbound) ? inbound : crypto.randomUUID();
    req.id = id;
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    // Run the rest of the request within the DB correlation context.
    if (db && typeof db.runWithRequest === 'function') {
        db.runWithRequest({ requestId: id }, () => next());
    } else {
        next();
    }
};
