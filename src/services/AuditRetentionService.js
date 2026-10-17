'use strict';

/**
 * AuditRetentionService — the audit log's life cycle.
 *
 * system_logs is append-only and hash-chained (migrations 30/52). Migration 170
 * adds, inside the database, the ONLY paths that may change it:
 *
 *   redactErasedSubject()  right to erasure: the erased person's names / login /
 *                          e-mail become their ref (`employee:<id>`) in
 *                          `details`, vouched by a chained AUDIT_REDACTION
 *                          entry (fn_system_logs_redact). The system-logs page
 *                          prints that ref as "Erased person #id" (localised).
 *   seal()                 one AUDIT_SEAL entry per complete UTC month: row
 *                          count, first/last id, sha256 of the month's
 *                          row_hashes, previous seal (fn_system_logs_seal).
 *   purge()                rows older than auditLogRetentionYears (1-10,
 *                          default 5), whole sealed months only, never a
 *                          seal / redaction / purge entry, never a row about a
 *                          person under legal hold, only when the chain
 *                          verifies; an AUDIT_PURGE entry records what remains
 *                          (fn_system_logs_purge).
 *   verify()               the one verifier (fn_system_logs_verify).
 *   chainStatusOnce(req)   verify(), at most once per request (never across
 *                          requests), behind GET /v2/cap/audit/verify.
 *
 * tick() is registered in src/jobs/index.js (hourly, self-gated to once a day
 * after AUDIT_RETENTION_HOUR, default 2): seal, then purge.
 */

const crypto = require('crypto');

const DEFAULT_YEARS = 5;
const _hour = Number(String(process.env.AUDIT_RETENTION_HOUR ?? '').trim() || NaN);
const ENV_HOUR = Number.isInteger(_hour) && _hour >= 0 && _hour <= 23 ? _hour : 2;
let _lastDay = null;
// chainStatusOnce: one chain walk per request, released with the request.
const _verifyByRequest = new WeakMap();

const db = () => require('../config/database');

/** A retention setting clamped to 1..10 years; anything unreadable → 5. */
function clampYears(v) {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n) || String(v ?? '').trim() === '') return DEFAULT_YEARS;
    return Math.min(10, Math.max(1, n));
}

/**
 * A typed identifier that names NO known account (a failed login) is never
 * written as typed: a short keyed fingerprint still shows the same identifier
 * being tried again and again. Keyed (HMAC with the session secret) so that
 * the database alone cannot be turned back into the addresses that were typed
 * by hashing a list of candidates.
 */
function fingerprint(identifier) {
    const s = String(identifier == null ? '' : identifier)
        .trim()
        .toLowerCase();
    if (!s) return 'fp:none';
    // SESSION_SECRET may list several secrets (rotation); the first one keys it.
    const secret =
        String(process.env.SESSION_SECRET || '')
            .split(',')[0]
            .trim() || 'dev-only';
    const key = `audit-fingerprint:${secret}`;
    return 'fp:' + crypto.createHmac('sha256', key).update(s).digest('hex').slice(0, 10);
}

function asJson(v) {
    if (v == null) return null;
    if (typeof v === 'string') {
        try {
            return JSON.parse(v);
        } catch (_) {
            return null;
        }
    }
    return v;
}

class AuditRetentionService {
    constructor() {
        this.clampYears = clampYears;
        this.fingerprint = fingerprint;
        this.DEFAULT_YEARS = DEFAULT_YEARS;
    }

    async retentionYears() {
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            return clampYears(
                await AppSettingsModel.getValue('auditLogRetentionYears', DEFAULT_YEARS)
            );
        } catch (_) {
            return DEFAULT_YEARS;
        }
    }

    /**
     * The identifiers of one employee (and of the admin accounts linked to
     * them) as they are NOW — read before an erasure pseudonymises them.
     */
    async collectNeedles(employeeId) {
        const d = db();
        const e = await d.get(
            'SELECT first_name, last_name, email, username, employee_number FROM employees WHERE id = ?',
            [Number(employeeId)]
        );
        const out = [];
        if (e) {
            const f = String(e.firstName ?? e.first_name ?? '').trim();
            const l = String(e.lastName ?? e.last_name ?? '').trim();
            if (f && l) out.push(`${f} ${l}`, `${l} ${f}`);
            out.push(e.email, e.username, e.employeeNumber ?? e.employee_number);
        }
        const admins = await d.all(
            'SELECT username, email FROM admins WHERE linked_employee_id = ?',
            [Number(employeeId)]
        );
        for (const a of admins || []) out.push(a.username, a.email);
        // The person's OTHER addresses recorded against them — the ones an older
        // audit line may carry after an e-mail change. Only sources keyed on this
        // person's id (never a guess by name): the e-mail each SSO identity
        // asserted at link time and an e-mail-shaped SSO uid (SAML nameID / UPN),
        // the address of the onboarding request that created them, and the UPN of
        // an SSO-migration mapping. A missing table (older schema) is skipped
        // BEFORE querying it: this runs inside the erasure transaction, where a
        // failed statement would abort it.
        const extra = [
            [
                'user_identities',
                `SELECT ui.email, ui.sso_uid FROM user_identities ui
                  WHERE (ui.subject_type = 'employee' AND ui.subject_id = ?)
                     OR (ui.subject_type = 'admin' AND ui.subject_id IN
                         (SELECT id FROM admins WHERE linked_employee_id = ?))`,
                [Number(employeeId), Number(employeeId)],
            ],
            [
                'onboarding_requests',
                'SELECT email FROM onboarding_requests WHERE created_employee_id = ?',
                [Number(employeeId)],
            ],
            [
                'sso_pending_links',
                'SELECT match_upn AS email FROM sso_pending_links WHERE employee_id = ?',
                [Number(employeeId)],
            ],
        ];
        for (const [table, sql, params] of extra) {
            const has = await d.get('SELECT to_regclass(?) IS NOT NULL AS ok', [`public.${table}`]);
            if (!has || !has.ok) continue;
            for (const r of (await d.all(sql, params)) || []) {
                out.push(r.email);
                const uid = r.ssoUid ?? r.sso_uid;
                if (uid && String(uid).includes('@')) out.push(uid);
            }
        }
        return [...new Set(out.map((x) => String(x == null ? '' : x).trim()).filter(Boolean))];
    }

    /**
     * Pseudonymise the erased person's identifiers in the audit log. Runs
     * inside the caller's transaction (DSRService.erase) AFTER the person is
     * marked erased; the database refuses it otherwise. Throws on failure —
     * an erasure that leaves the name in the audit log is not complete.
     */
    async redactErasedSubject(employeeId, needles, { actorRef = null, reason = null } = {}) {
        try {
            const row = await db().get('SELECT fn_system_logs_redact(?, ?::text[], ?, ?) AS r', [
                Number(employeeId),
                Array.isArray(needles) ? needles : [],
                actorRef,
                reason,
            ]);
            const r = asJson(row && row.r) || {};
            return {
                rows: Number(r.rows) || 0,
                entries: Array.isArray(r.entries) ? r.entries.map(Number) : [],
            };
        } catch (e) {
            const err = new Error(`audit_redaction_failed: ${e.message}`);
            err.code = 'audit_redaction_failed';
            err.cause = e;
            throw err;
        }
    }

    /** Seal every complete month not sealed yet. Returns the number written. */
    async seal(now = new Date()) {
        const row = await db().get('SELECT fn_system_logs_seal(?::timestamptz) AS n', [now]);
        return Number(row && row.n) || 0;
    }

    /** Sealed purge with the configured (or given) retention. */
    async purge({ years = null, actorRef = null, now = new Date() } = {}) {
        const y = years == null ? await this.retentionYears() : clampYears(years);
        const row = await db().get('SELECT fn_system_logs_purge(?, ?, ?::timestamptz) AS r', [
            y,
            actorRef,
            now,
        ]);
        return { years: y, ...(asJson(row && row.r) || {}) };
    }

    /**
     * Verify the chain: content (or a vouching redaction), hash links (or a
     * cut recorded by a purge), forks, genesis, the purged region, the seals.
     */
    async verify(limit = 20) {
        const row = await db().get('SELECT fn_system_logs_verify(?) AS v', [Number(limit) || 20]);
        const v = asJson(row && row.v) || {};
        const broken = v.broken || {};
        const brokenAt = [
            ...new Set(
                ['content', 'link', 'fork', 'genesis', 'purged', 'seal'].flatMap((k) =>
                    (broken[k] || []).map(Number)
                )
            ),
        ].sort((a, b) => a - b);
        return { ...v, intact: v.intact === true, brokenAt };
    }

    /**
     * verify(), at most once per REQUEST: two panels of one page (or one page
     * and the JSON it embeds) share one database walk of the chain. Never
     * cached across requests — every new request sees the chain as it is now,
     * so a tampering is never hidden behind an old answer. A failure is not
     * kept either: the next caller in the same request tries again.
     * @param {object|null} req the request the answer belongs to (no request: no cache)
     */
    async chainStatusOnce(req, limit = 20) {
        if (!req || typeof req !== 'object') return this.verify(limit);
        const key = Number(limit) || 20;
        let perReq = _verifyByRequest.get(req);
        if (!perReq) {
            perReq = new Map();
            _verifyByRequest.set(req, perReq);
        }
        if (!perReq.has(key)) {
            const pending = this.verify(key);
            perReq.set(key, pending);
            pending.catch(() => perReq.delete(key));
        }
        return perReq.get(key);
    }

    /**
     * Daily job: seal, then purge. Self-gated. A refused purge (the chain does
     * not verify) is re-thrown AFTER sealing so the job registry records a
     * failure an operator sees — it is never silently skipped.
     */
    async tick({ force = false, now = new Date() } = {}) {
        const day = now.toISOString().slice(0, 10);
        if (!force && now.getHours() < ENV_HOUR) return { done: false, skipped: 'before_hour' };
        if (!force && _lastDay === day) return { done: false, skipped: 'already_today' };
        _lastDay = day;
        const out = { done: true };
        try {
            out.sealed = await this.seal(now);
        } catch (e) {
            out.sealError = e.message;
        }
        try {
            out.purge = await this.purge({ actorRef: 'system:audit-retention', now });
        } catch (e) {
            out.purgeError = e.message;
            console.error('[audit-retention] purge refused:', e.message);
        }
        if (out.purgeError || out.sealError)
            throw new Error(
                `audit-retention: ${out.sealError || ''} ${out.purgeError || ''}`.trim()
            );
        return out;
    }
}

module.exports = new AuditRetentionService();
