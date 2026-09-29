'use strict';

/**
 * activityTrail — the catch-all trail row for every authenticated
 * STATE-CHANGING request (POST/PUT/PATCH/DELETE), independent of whether the
 * controller wrote a detailed audit entry.
 *
 * Purpose: "who touched which endpoint, when, with what outcome" — the
 * skeleton that joins (via requestId) the winston file logs, the detailed
 * audit rows and slow-query telemetry during incident reconstruction and
 * debugging.
 *
 * STORAGE CHOICE — perf_events, NOT system_logs: the audit log is
 * hash-chained and immutable (pruning it would break chain verification),
 * while the activity trail is high-volume operational telemetry. perf_events
 * is already retention-managed by the telemetry-prune job
 * (perfEventsRetentionDays), so the trail stays bounded. Security INCIDENTS
 * (origin/CSRF rejections, lockouts, server errors) still go to the
 * evidentiary system_logs — low-volume, high-value.
 *
 * Design constraints:
 *   - MUTATIONS ONLY (reads stay in the winston file logs — volume),
 *   - never the request BODY (passwords/PII must not persist here),
 *   - fire-and-forget on response finish (no latency, never throws),
 *   - ACTIVITY_TRAIL=0 disables it (escape hatch).
 */

const SKIP_PREFIXES = ['/css/', '/js/', '/images/', '/vendor/', '/health', '/metrics'];

function enforceActivityTrail(req, res, next) {
    if (process.env.ACTIVITY_TRAIL === '0') return next();
    const method = req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    if (SKIP_PREFIXES.some((p) => req.path.startsWith(p))) return next();

    const startedAt = Date.now();
    res.on('finish', () => {
        try {
            // Authenticated actors only — anonymous POSTs (login, signup) are
            // already covered by the dedicated auth/security audit events.
            if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) return;
            const u = req.user;
            const db = require('../config/database');
            db.run(`INSERT INTO perf_events (kind, route, detail) VALUES ('activity', ?, ?)`, [
                `${method} ${req.path}`,
                JSON.stringify({
                    status: res.statusCode,
                    ms: Date.now() - startedAt,
                    actor: `${u.userType}:${u.id}`,
                    requestId: req.id || null,
                    ip: req.ip,
                }),
            ]).catch(() => {
                /* trail is best-effort, never breaks a request */
            });
        } catch (_) {
            /* never throw from a finish handler */
        }
    });
    next();
}

module.exports = { enforceActivityTrail };
