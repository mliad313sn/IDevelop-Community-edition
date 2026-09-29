'use strict';

const db = require('../config/database');

/**
 * PerfEventService — best-effort telemetry sink for the perf_events table.
 * Mirrors LogService's philosophy: never throws, never blocks the caller. Used by
 * the DB layer (slow queries / error codes) and the HTTP finish-hook (slow requests).
 * Writes are fire-and-forget; a failure here must never affect a real request.
 */
class PerfEventService {
    record({
        requestId = null,
        kind,
        route = null,
        sqlSnippet = null,
        latencyMs = null,
        pgCode = null,
        statusCode = null,
        detail = null,
    } = {}) {
        if (!kind) return;
        // Fire-and-forget: do not await, and swallow everything.
        Promise.resolve()
            .then(() =>
                db.run(
                    `INSERT INTO perf_events (request_id, kind, route, sql_snippet, latency_ms, pg_code, status_code, detail)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        requestId,
                        kind,
                        route,
                        sqlSnippet,
                        latencyMs,
                        pgCode,
                        statusCode,
                        detail != null ? JSON.stringify(detail) : null,
                    ]
                )
            )
            .catch(() => {
                /* telemetry best-effort */
            });
    }
}

module.exports = new PerfEventService();
