'use strict';

/**
 * SafetyGateService — the safety-competency gate (« Habilitations sécurité »,
 * migration 150).
 *
 * One question, asked by a permit-to-work or site access-control system:
 * "may this person be sent to a safety-critical task today?"
 *
 *   CLEARED         every critical skill of the person's role is at or above its
 *                   minimum level, and every mandatory certificate is valid;
 *   EXPIRING        cleared today, but a certificate on a critical skill expires
 *                   within the configured warning window;
 *   BLOCKED         at least one blocking reason (below level, NOT ASSESSED,
 *                   certificate missing / expired / revoked, person inactive);
 *   NOT_CONFIGURED  no critical skill is configured for the person's role (or the
 *                   person has no role). This is NOT a clearance: an absent
 *                   configuration is not a measured result, and the API says
 *                   `cleared: false` for it.
 *
 * "Not assessed" is never a silent level 0 — it is its own blocking reason, so
 * the reader knows the difference between "measured too low" and "never measured".
 *
 * The answer is ALWAYS recomputed (a stale safety answer is worse than a slow
 * one). `safety_gate_status` only remembers the last known answer so that each
 * CHANGE is recorded exactly once: history row + audit log + optional webhook +
 * (3.23.21 F7) a notification to the person and their line when the ENFORCED
 * answer becomes BLOCKED or EXPIRING.
 *
 * 3.23.21 (migration 155):
 *   - F5 rollout mode per rule: 'observe' (default for a NEW rule) or 'enforce'.
 *     An observe rule is computed and shown, but it does not close the gate:
 *     the API answers `cleared: true` with `observe: true` and the observe-only
 *     reasons tagged `observe: true`. `enforcedStatus` is the answer over the
 *     enforce rules alone; it drives `cleared`, the webhook and notifications.
 *   - F6 rule options: `requireValidated` (only a SUPERVISOR-validated level
 *     counts — an approved self-rating alone is `level_not_validated`) and
 *     `maxAgeMonths` (an older measurement is `assessment_too_old`).
 *   - SEC-1 configuration is clearance-bound: settings and site-less rules are
 *     SuperAdmin only; a site rule needs RBACService.canAccessSite; the delivery
 *     trail is scoped to the actor's employees.
 */

const crypto = require('crypto');
const dns = require('dns');
const db = require('../config/database');
const { scopedEmployeeIds } = require('../utils/rbacScope');
const { personNameSql } = require('../utils/personName');
const secretBox = require('../utils/secretBox');

const STATUS = Object.freeze({
    CLEARED: 'CLEARED',
    EXPIRING: 'EXPIRING',
    BLOCKED: 'BLOCKED',
    NOT_CONFIGURED: 'NOT_CONFIGURED',
});

const REASON = Object.freeze({
    NOT_ASSESSED: 'not_assessed',
    LEVEL_BELOW_MIN: 'level_below_min',
    CERT_MISSING: 'cert_missing',
    CERT_EXPIRED: 'cert_expired',
    CERT_REVOKED: 'cert_revoked',
    CERT_EXPIRING: 'cert_expiring',
    EMPLOYEE_INACTIVE: 'employee_inactive',
    NO_ROLE: 'no_role',
    // 3.23.21 F6
    LEVEL_NOT_VALIDATED: 'level_not_validated',
    ASSESSMENT_TOO_OLD: 'assessment_too_old',
});

const MODE = Object.freeze({ OBSERVE: 'observe', ENFORCE: 'enforce' });
const MAX_AGE_MONTHS_MAX = 120;

const VALID_NOW = new Set(['valid', 'expiring', 'no_expiry']);
const DEFAULT_WARNING_DAYS = 30;
const MAX_ATTEMPTS = 6;
const WEBHOOK_TIMEOUT_MS = 5000;
const BULK_MAX = 5000;

// ---------------------------------------------------------------------------
// Pure evaluation (no I/O) — the rules of the gate, testable on their own.
// ---------------------------------------------------------------------------

/** Applicable rules for one employee, merged per skill to the STRICTEST. */
function applicableRules(employee, rules) {
    const bySkill = new Map();
    for (const r of rules) {
        if (Number(r.roleId) !== Number(employee.roleId)) continue;
        if (r.siteId != null && Number(r.siteId) !== Number(employee.siteId)) continue;
        const k = Number(r.skillId);
        const prev = bySkill.get(k);
        const age = positiveInt(r.maxAgeMonths);
        if (!prev) {
            const merged = {
                skillId: k,
                skillName: r.skillName,
                minLevel: Number(r.minLevel),
                certRequired: !!r.certRequired,
            };
            // Only carried when set, so a rule without the 3.23.21 options
            // merges to exactly the shape it always had.
            if (r.requireValidated) merged.requireValidated = true;
            if (age) merged.maxAgeMonths = age;
            bySkill.set(k, merged);
        } else {
            prev.minLevel = Math.max(prev.minLevel, Number(r.minLevel));
            prev.certRequired = prev.certRequired || !!r.certRequired;
            if (r.requireValidated) prev.requireValidated = true;
            if (age) prev.maxAgeMonths = prev.maxAgeMonths ? Math.min(prev.maxAgeMonths, age) : age;
        }
    }
    return [...bySkill.values()].sort((a, b) => a.skillId - b.skillId);
}

function positiveInt(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** True when `at` (date / ISO string) is older than `months` before `now`. */
function olderThanMonths(at, months, now) {
    const d = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(d.getTime())) return true; // an unreadable date proves nothing: fail closed
    const cutoff = new Date(now instanceof Date ? now.getTime() : Date.now());
    cutoff.setMonth(cutoff.getMonth() - Number(months));
    return d.getTime() < cutoff.getTime();
}

function dateOnly(at) {
    if (!at) return null;
    const d = at instanceof Date ? at : new Date(at);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * @param employee {id, isActive, roleId, siteId}
 * @param rules    merged applicable rules (applicableRules)
 * @param facts    { levels: Map<skillId, number|null>,
 *                   assessedAt: Map<skillId, date>        (date of the resolved level),
 *                   validated: Map<skillId, {level, assessedAt}> (latest SUPERVISOR-validated),
 *                   certs:  Map<skillId, {certStatus, expiresOn, daysLeft}>,
 *                   lapsed: Map<skillId, {lapseReason, lastExpiresOn}> }
 * @param opts     { warningDays, now }
 */
function evaluate(employee, rules, facts, { warningDays = DEFAULT_WARNING_DAYS, now } = {}) {
    const reasons = [];
    const add = (code, rule, extra = {}) =>
        reasons.push({
            code,
            blocking: code !== REASON.CERT_EXPIRING,
            skillId: rule ? rule.skillId : null,
            skillName: rule ? rule.skillName : null,
            ...extra,
        });

    if (employee.isActive === false) add(REASON.EMPLOYEE_INACTIVE, null);

    if (employee.roleId == null || !rules.length) {
        if (reasons.length) return finish(STATUS.BLOCKED, reasons, null);
        if (employee.roleId == null) add(REASON.NO_ROLE, null);
        reasons.forEach((r) => {
            r.blocking = false;
        });
        return finish(STATUS.NOT_CONFIGURED, reasons, null);
    }

    let nextExpiry = null;
    const levels = facts.levels || new Map();
    const certs = facts.certs || new Map();
    const lapsed = facts.lapsed || new Map();
    const assessedAt = facts.assessedAt || new Map();
    const validated = facts.validated || new Map();

    for (const rule of rules) {
        let level = levels.has(rule.skillId) ? levels.get(rule.skillId) : null;
        let at = assessedAt.get(rule.skillId) || null;
        let selfOnly = false;
        if (rule.requireValidated) {
            // Only a SUPERVISOR-validated level counts: the latest one, even when
            // a later approved self-rating is the resolved level elsewhere.
            const v = validated.get(rule.skillId) || null;
            selfOnly = level != null && !(v && v.level != null);
            level = v && v.level != null ? Number(v.level) : null;
            at = v ? v.assessedAt || null : null;
        }
        const lapse = lapsed.get(rule.skillId) || null;
        const cert = certs.get(rule.skillId) || null;
        let certReported = false;

        // Level. "Never measured" is its own reason — never a silent 0; a
        // self-rating where a validated level is required is ITS own reason too.
        if (level == null) {
            add(selfOnly ? REASON.LEVEL_NOT_VALIDATED : REASON.NOT_ASSESSED, rule, {
                requiredLevel: rule.minLevel,
            });
        } else if (lapse) {
            // A lapsed certificate degrades the qualification (migration 78) —
            // the same rule readiness, benchmark and succession apply.
            add(
                lapse.lapseReason === 'revoked' ? REASON.CERT_REVOKED : REASON.CERT_EXPIRED,
                rule,
                lapse.lastExpiresOn ? { expiresOn: lapse.lastExpiresOn } : {}
            );
            certReported = true;
        } else if (Number(level) < rule.minLevel) {
            add(REASON.LEVEL_BELOW_MIN, rule, {
                requiredLevel: rule.minLevel,
                level: Number(level),
            });
        }

        // Freshness: a measurement older than the rule allows no longer
        // proves the level today. A missing date proves nothing either.
        if (
            level != null &&
            rule.maxAgeMonths &&
            (!at || olderThanMonths(at, rule.maxAgeMonths, now))
        ) {
            add(REASON.ASSESSMENT_TOO_OLD, rule, {
                maxAgeMonths: rule.maxAgeMonths,
                ...(dateOnly(at) ? { assessedOn: dateOnly(at) } : {}),
            });
        }

        // Mandatory certificate.
        if (rule.certRequired && !certReported) {
            if (!cert || !cert.certStatus) {
                if (lapse && lapse.lapseReason === 'revoked') add(REASON.CERT_REVOKED, rule);
                else if (lapse)
                    add(
                        REASON.CERT_EXPIRED,
                        rule,
                        lapse.lastExpiresOn ? { expiresOn: lapse.lastExpiresOn } : {}
                    );
                else add(REASON.CERT_MISSING, rule);
            } else if (!VALID_NOW.has(cert.certStatus)) {
                add(REASON.CERT_EXPIRED, rule, cert.expiresOn ? { expiresOn: cert.expiresOn } : {});
            }
        }

        // Expiry warning on any currently valid certificate of a critical skill:
        // when it lapses the skill degrades, so the gate will close.
        if (cert && VALID_NOW.has(cert.certStatus) && cert.expiresOn && cert.daysLeft != null) {
            if (!nextExpiry || cert.expiresOn < nextExpiry) nextExpiry = cert.expiresOn;
            if (Number(cert.daysLeft) <= Number(warningDays)) {
                add(REASON.CERT_EXPIRING, rule, {
                    expiresOn: cert.expiresOn,
                    daysLeft: Number(cert.daysLeft),
                });
            }
        }
    }

    const blocking = reasons.some((r) => r.blocking);
    const warning = reasons.some((r) => !r.blocking);
    return finish(
        blocking ? STATUS.BLOCKED : warning ? STATUS.EXPIRING : STATUS.CLEARED,
        reasons,
        nextExpiry
    );
}

function finish(status, reasons, nextExpiry) {
    return { status, reasons, nextExpiry: nextExpiry || null };
}

const reasonKey = (r) => `${r.code}:${r.skillId == null ? '-' : r.skillId}`;

/**
 * evaluate once over EVERY active rule (the status shown) and once over
 * the ENFORCE rules alone (`enforcedStatus`, the one that closes the gate).
 * Reasons that only an observe rule produces are tagged `observe: true`.
 * Rules without a mode (created before migration 155) are enforce.
 */
function evaluateWithModes(employee, rules, facts, opts) {
    const all = evaluate(employee, applicableRules(employee, rules), facts, opts);
    const enforceRules = rules.filter((r) => r.mode !== MODE.OBSERVE);
    if (enforceRules.length === rules.length) return { ...all, enforcedStatus: all.status };
    const enforced = evaluate(employee, applicableRules(employee, enforceRules), facts, opts);
    const enforcedKeys = new Set(enforced.reasons.map(reasonKey));
    for (const x of all.reasons) if (!enforcedKeys.has(reasonKey(x))) x.observe = true;
    return { ...all, enforcedStatus: enforced.status };
}

/** The status that actually closes the gate (enforce rules only). */
function effectiveStatus(r) {
    return r.enforcedStatus || r.status;
}

/**
 * Stable fingerprint of an answer — a change of it is a logged change. The
 * 3.23.21 parts (enforced status, observe tags) are only appended when they
 * differ from the plain answer, so every answer recorded before migration 155
 * keeps its fingerprint and nothing is re-logged on upgrade.
 */
function fingerprint(result) {
    const parts = result.reasons
        .map(
            (r) =>
                `${r.code}:${r.skillId == null ? '-' : r.skillId}:${r.expiresOn || ''}${r.observe ? ':o' : ''}`
        )
        .sort();
    const eff = effectiveStatus(result);
    const head = eff === result.status ? result.status : `${result.status}/${eff}`;
    return `${head}|${parts.join(',')}`;
}

/**
 * Does the answer let the person through? CLEARED / EXPIRING do. BLOCKED does
 * only when every blocking reason comes from an OBSERVE rule (F5: day-1 rollout
 * must not deny access). NOT_CONFIGURED never does — and it is not a denial
 * either: the gate simply has no requirement for the role.
 */
function isCleared(r) {
    if (r.status === STATUS.CLEARED || r.status === STATUS.EXPIRING) return true;
    if (r.status !== STATUS.BLOCKED) return false;
    return effectiveStatus(r) !== STATUS.BLOCKED;
}

/** The API shape: status, reason CODES and expiry dates — never a score. */
function toApi(r) {
    const out = {
        employeeNumber: r.employeeNumber,
        status: r.status,
        cleared: isCleared(r),
        reasons: r.reasons.map((x) => {
            const o = { code: x.code, blocking: !!x.blocking };
            if (x.skillId != null) {
                o.skillId = x.skillId;
                o.skillName = x.skillName;
            }
            if (x.expiresOn) o.expiresOn = x.expiresOn;
            if (x.observe) o.observe = true;
            return o;
        }),
        nextExpiry: r.nextExpiry || null,
        evaluatedAt: r.evaluatedAt,
    };
    if (r.reasons.some((x) => x.observe)) {
        out.observe = true;
        out.enforcedStatus = effectiveStatus(r);
    }
    return out;
}

/** API-key scope that may read the gate. Read-only scopes of OTHER feeds may not. */
function scopeAllowsSafetyRead(scope) {
    if (scope == null) return false;
    const tokens = String(scope)
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean);
    return tokens.some((t) =>
        ['safety.read', 'safety_gate.read', 'safety-gate.read', 'safetygate.read'].includes(t)
    );
}

// ---------------------------------------------------------------------------
// SSRF guard for the outgoing webhook (mirrors SamlMetadataService.fetchMetadata)
// ---------------------------------------------------------------------------

function isPrivateAddress(ip) {
    return require('./SamlMetadataService').isPrivateAddress(ip);
}

function allowPrivate() {
    return process.env.SAFETY_GATE_WEBHOOK_ALLOW_PRIVATE === '1';
}

/**
 * Validate a webhook URL and resolve it to the address that will be used.
 * @returns {Promise<{ok:true, url:URL, address:{address,family}}|{ok:false, code:string}>}
 */
async function checkWebhookUrl(raw) {
    let u;
    try {
        u = new URL(String(raw || '').trim());
    } catch (_) {
        return { ok: false, code: 'bad_url' };
    }
    if (u.protocol !== 'https:') return { ok: false, code: 'https_only' };
    if (u.username || u.password) return { ok: false, code: 'bad_url' };
    // WHATWG keeps the brackets on an IPv6 literal ('[::1]'); dns wants it bare.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let addrs;
    try {
        addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    } catch (_) {
        return { ok: false, code: 'dns' };
    }
    if (!addrs || !addrs.length) return { ok: false, code: 'dns' };
    if (!allowPrivate() && addrs.some((a) => isPrivateAddress(a.address)))
        return { ok: false, code: 'private_address' };
    return { ok: true, url: u, address: addrs[0] };
}

/** POST once, to the CHECKED address (pinned lookup — no DNS rebinding), no redirects. */
async function postOnce(rawUrl, body, headers) {
    const chk = await checkWebhookUrl(rawUrl);
    if (!chk.ok) return { ok: false, status: null, error: chk.code };
    const https = require('https');
    const pinned = chk.address;
    return new Promise((resolve) => {
        const req = https.request(
            chk.url,
            {
                method: 'POST',
                timeout: WEBHOOK_TIMEOUT_MS,
                headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
                lookup: (_h, opts, cb) =>
                    opts && opts.all
                        ? cb(null, [{ address: pinned.address, family: pinned.family }])
                        : cb(null, pinned.address, pinned.family),
            },
            (res) => {
                res.resume();
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                resolve({
                    ok,
                    status: res.statusCode,
                    error: ok ? null : `http_${res.statusCode}`,
                });
            }
        );
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, status: null, error: 'timeout' });
        });
        req.on('error', () => resolve({ ok: false, status: null, error: 'unreachable' }));
        req.end(body);
    });
}

/** Minutes before attempt n+1 (n = attempts already made): 1, 2, 4, 8, 16 … capped at 6 h. */
function backoffMinutes(attempts) {
    return Math.min(2 ** Math.max(0, attempts - 1), 360);
}

function sign(secret, timestamp, body) {
    return (
        'sha256=' +
        crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${body}`).digest('hex')
    );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const SafetyGateService = {
    STATUS,
    REASON,
    MODE,
    applicableRules,
    evaluate,
    evaluateWithModes,
    effectiveStatus,
    isCleared,
    fingerprint,
    toApi,
    scopeAllowsSafetyRead,
    checkWebhookUrl,
    backoffMinutes,
    sign,
    _postOnce: postOnce,

    // ---- Settings ---------------------------------------------------------

    async getSettings() {
        const row = await db.get(
            `SELECT expiry_warning_days AS "expiryWarningDays", webhook_url AS "webhookUrl",
                    webhook_enabled AS "webhookEnabled", (webhook_secret IS NOT NULL) AS "hasSecret",
                    updated_at AS "updatedAt"
               FROM safety_gate_settings WHERE id = 1`
        );
        return {
            expiryWarningDays:
                row && row.expiryWarningDays ? Number(row.expiryWarningDays) : DEFAULT_WARNING_DAYS,
            webhookUrl: (row && row.webhookUrl) || '',
            webhookEnabled: !!(row && row.webhookEnabled),
            hasSecret: !!(row && row.hasSecret),
            updatedAt: row ? row.updatedAt : null,
        };
    },

    /**
     * @throws Error with .code — 'bad_days' | 'secret_required' | SSRF codes
     *         ('https_only', 'private_address', 'bad_url', 'dns').
     */
    async updateSettings({ expiryWarningDays, webhookUrl, webhookSecret, webhookEnabled }, actor) {
        const fail = (code) => {
            const e = new Error(code);
            e.code = code;
            e.status = 400;
            throw e;
        };
        // SEC-1: the warning window and the outgoing webhook are organisation-
        // wide — a site-scoped compliance admin must not redirect every site's
        // status changes to a URL of their choosing.
        assertSuperAdmin(actor);
        const days = parseInt(expiryWarningDays, 10);
        if (!Number.isFinite(days) || days < 1 || days > 365) fail('bad_days');
        const url = String(webhookUrl || '').trim();
        const enabled = !!webhookEnabled && !!url;
        if (url) {
            const chk = await checkWebhookUrl(url);
            if (!chk.ok) fail(chk.code);
        }
        const current = await db.get(
            'SELECT webhook_secret AS "secret" FROM safety_gate_settings WHERE id = 1'
        );
        const newSecret = String(webhookSecret || '');
        if (enabled && !newSecret && !(current && current.secret)) fail('secret_required');
        const storedSecret = newSecret
            ? secretBox.encrypt(newSecret, 'safety_gate')
            : current
              ? current.secret
              : null;
        await db.run(
            `INSERT INTO safety_gate_settings (id, expiry_warning_days, webhook_url, webhook_secret, webhook_enabled, updated_by, updated_at)
             VALUES (1, ?, ?, ?, ?, ?, now())
             ON CONFLICT (id) DO UPDATE SET
                expiry_warning_days = EXCLUDED.expiry_warning_days,
                webhook_url = EXCLUDED.webhook_url,
                webhook_secret = EXCLUDED.webhook_secret,
                webhook_enabled = EXCLUDED.webhook_enabled,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()`,
            [days, url || null, storedSecret, enabled, actor ? actor.id : null]
        );
        await audit(
            actor,
            'SAFETY_GATE_SETTINGS_UPDATED',
            'safety_gate_settings',
            1,
            `warningDays=${days}, webhook=${enabled ? 'on' : 'off'}${url ? ` (${safeHost(url)})` : ''}${newSecret ? ', secret rotated' : ''}`
        );
        return this.getSettings();
    },

    // ---- Rules (configuration) -------------------------------------------

    /**
     * SEC-1: may this actor change a rule on `siteId` (null = every site)?
     * Site-less rules are SuperAdmin only; a site rule needs clearance on it.
     */
    async canManageRuleSite(actor, siteId) {
        const RBACService = require('./RBACService');
        if (!actor || actor.userType !== 'admin') return false;
        if (RBACService.isSuperAdmin(actor)) return true;
        if (siteId == null || siteId === '') return false;
        try {
            return !!(await RBACService.canAccessSite(actor, Number(siteId)));
        } catch (_) {
            return false; // fail closed
        }
    },

    /** Site ids the actor may configure rules on; null = every site (SuperAdmin). */
    async manageableSiteIds(actor, sites) {
        const RBACService = require('./RBACService');
        if (actor && RBACService.isSuperAdmin(actor)) return null;
        const out = [];
        for (const s of sites || []) {
            if (await this.canManageRuleSite(actor, s.id)) out.push(Number(s.id));
        }
        return out;
    },

    async listRules({ includeInactive = false } = {}) {
        return db.all(
            `SELECT gr.id, gr.role_id AS "roleId", r.name AS "roleName", gr.site_id AS "siteId",
                    s.name AS "siteName", gr.skill_id AS "skillId", sk.name AS "skillName",
                    gr.min_level AS "minLevel", gr.cert_required AS "certRequired",
                    gr."mode" AS "mode", gr.require_validated AS "requireValidated",
                    gr.max_age_months AS "maxAgeMonths",
                    gr.is_active AS "isActive", gr.deactivated_reason AS "deactivatedReason",
                    gr.updated_at AS "updatedAt"
               FROM safety_gate_rules gr
               JOIN roles r ON r.id = gr.role_id
               JOIN skills sk ON sk.id = gr.skill_id
               LEFT JOIN sites s ON s.id = gr.site_id
              WHERE ${includeInactive ? '1 = 1' : 'gr.is_active'}
              ORDER BY r.name, s.name NULLS FIRST, sk.name`
        );
    },

    /**
     * Validate a rule as typed in the form. New rules default to OBSERVE.
     * @throws Error .code 'bad_rule' | 'bad_level' | 'bad_mode' | 'bad_max_age'
     */
    normaliseRule({
        roleId,
        siteId,
        skillId,
        minLevel,
        certRequired,
        mode,
        requireValidated,
        maxAgeMonths,
    }) {
        const rid = parseInt(roleId, 10);
        const kid = parseInt(skillId, 10);
        const sid = siteId === '' || siteId == null ? null : parseInt(siteId, 10);
        const lvl = parseInt(minLevel, 10);
        if (!Number.isFinite(rid) || !Number.isFinite(kid)) failWith('bad_rule');
        if (sid !== null && !Number.isFinite(sid)) failWith('bad_rule');
        if (!Number.isFinite(lvl) || lvl < 1 || lvl > 4) failWith('bad_level');
        const m = mode == null || mode === '' ? MODE.OBSERVE : String(mode);
        if (m !== MODE.OBSERVE && m !== MODE.ENFORCE) failWith('bad_mode');
        let age = null;
        if (maxAgeMonths != null && String(maxAgeMonths).trim() !== '') {
            age = Number(maxAgeMonths);
            if (!Number.isInteger(age) || age < 1 || age > MAX_AGE_MONTHS_MAX)
                failWith('bad_max_age');
        }
        return {
            roleId: rid,
            siteId: sid,
            skillId: kid,
            minLevel: lvl,
            certRequired: !!certRequired,
            mode: m,
            requireValidated: !!requireValidated,
            maxAgeMonths: age,
        };
    },

    async addRule(input, actor) {
        const r = this.normaliseRule(input);
        const { roleId: rid, siteId: sid, skillId: kid, minLevel: lvl } = r;
        if (!(await this.canManageRuleSite(actor, sid))) failWith('forbidden', 403);
        const dup = await db.get(
            `SELECT id FROM safety_gate_rules
              WHERE is_active AND role_id = ? AND COALESCE(site_id, 0) = ? AND skill_id = ?`,
            [rid, sid == null ? 0 : sid, kid]
        );
        if (dup) failWith('duplicate_rule');
        const row = await db.get(
            `INSERT INTO safety_gate_rules (role_id, site_id, skill_id, min_level, cert_required,
                                            mode, require_validated, max_age_months, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [
                rid,
                sid,
                kid,
                lvl,
                r.certRequired,
                r.mode,
                r.requireValidated,
                r.maxAgeMonths,
                actor ? actor.id : null,
                actor ? actor.id : null,
            ]
        );
        await audit(
            actor,
            'SAFETY_GATE_RULE_ADDED',
            'safety_gate_rule',
            row.id,
            `role=${rid}, site=${sid == null ? 'all' : sid}, skill=${kid}, minLevel=${lvl}, certRequired=${r.certRequired}, mode=${r.mode}, requireValidated=${r.requireValidated}, maxAgeMonths=${r.maxAgeMonths == null ? '-' : r.maxAgeMonths}`
        );
        await this.recomputeForRole(rid, 'rule_change').catch((e) =>
            console.error('[safety-gate] recompute after rule add failed:', e && e.message)
        );
        return row;
    },

    /** Nothing is ever deleted: a rule is deactivated, with its reason. */
    async deactivateRule(id, reason, actor) {
        const fail = (code) => failWith(code);
        const why = String(reason || '').trim();
        if (!why) fail('reason_required');
        await this._ruleInReach(id, actor);
        const row = await db.get(
            `UPDATE safety_gate_rules
                SET is_active = false, deactivated_reason = ?, deactivated_at = now(),
                    deactivated_by = ?, updated_by = ?, updated_at = now()
              WHERE id = ? AND is_active
              RETURNING id, role_id AS "roleId"`,
            [why.slice(0, 500), actor ? actor.id : null, actor ? actor.id : null, parseInt(id, 10)]
        );
        if (!row) fail('not_found');
        await audit(
            actor,
            'SAFETY_GATE_RULE_DEACTIVATED',
            'safety_gate_rule',
            row.id,
            `reason: ${why.slice(0, 200)}`
        );
        await this.recomputeForRole(row.roleId, 'rule_change').catch((e) =>
            console.error('[safety-gate] recompute after rule deactivation failed:', e && e.message)
        );
        return row;
    },

    /** Load an ACTIVE rule and check the actor may change it (SEC-1). */
    async _ruleInReach(id, actor) {
        const rid = parseInt(id, 10);
        if (!Number.isFinite(rid)) failWith('not_found');
        const rule = await db.get(
            `SELECT id, site_id AS "siteId", role_id AS "roleId", mode
               FROM safety_gate_rules WHERE id = ? AND is_active`,
            [rid]
        );
        if (!rule) failWith('not_found');
        if (!(await this.canManageRuleSite(actor, rule.siteId))) failWith('forbidden', 403);
        return rule;
    },

    /**
     * move a rule between OBSERVE and ENFORCE. Audited; the role is
     * recomputed so the change of answer is recorded (and notified) at once.
     */
    async setRuleMode(id, mode, actor) {
        const m = String(mode || '');
        if (m !== MODE.OBSERVE && m !== MODE.ENFORCE) failWith('bad_mode');
        const rule = await this._ruleInReach(id, actor);
        if (rule.mode === m) return { id: Number(rule.id), mode: m, unchanged: true };
        const row = await db.get(
            `UPDATE safety_gate_rules SET mode = ?, updated_by = ?, updated_at = now()
              WHERE id = ? AND is_active
              RETURNING id, role_id AS "roleId", mode`,
            [m, actor ? actor.id : null, Number(rule.id)]
        );
        if (!row) failWith('not_found');
        await audit(
            actor,
            'SAFETY_GATE_RULE_MODE_CHANGED',
            'safety_gate_rule',
            row.id,
            `${rule.mode || MODE.ENFORCE} -> ${m}`
        );
        await this.recomputeForRole(row.roleId, 'rule_change').catch((e) =>
            console.error('[safety-gate] recompute after mode change failed:', e && e.message)
        );
        return row;
    },

    /**
     * impact preview BEFORE a rule is saved: how many people of the role
     * (on the rule's site, within the actor's clearance) would become BLOCKED by
     * it. Nothing is recorded. The candidate is evaluated as ENFORCED, whatever
     * its mode, because that is the question: "what will this rule block?".
     */
    async previewRule(input, actor) {
        const r = this.normaliseRule(input);
        if (!(await this.canManageRuleSite(actor, r.siteId))) failWith('forbidden', 403);
        const ids = await scopedEmployeeIds(actor);
        const where = { roleId: r.roleId, activeOnly: true };
        if (r.siteId != null) where.siteId = r.siteId;
        const before = await this.computeFor(where, ids, { record: false });
        const skill = await db.get('SELECT name FROM skills WHERE id = ?', [r.skillId]);
        const candidate = {
            roleId: r.roleId,
            siteId: r.siteId,
            skillId: r.skillId,
            skillName: skill ? skill.name : null,
            minLevel: r.minLevel,
            certRequired: r.certRequired,
            requireValidated: r.requireValidated,
            maxAgeMonths: r.maxAgeMonths,
            mode: MODE.ENFORCE,
        };
        const after = await this.computeFor(where, ids, {
            record: false,
            extraRules: [candidate],
        });
        const prev = new Map(before.map((x) => [x.employeeId, x]));
        const newly = after.filter((x) => {
            const p = prev.get(x.employeeId);
            return x.status === STATUS.BLOCKED && (!p || p.status !== STATUS.BLOCKED);
        });
        return {
            rule: { ...r, skillName: candidate.skillName },
            evaluated: after.length,
            newlyBlocked: newly.length,
            alreadyBlocked: after.filter(
                (x) =>
                    x.status === STATUS.BLOCKED && prev.get(x.employeeId)?.status === STATUS.BLOCKED
            ).length,
            sample: newly.slice(0, 10).map((x) => ({
                employeeId: x.employeeId,
                name: x.name,
                siteName: x.siteName,
            })),
        };
    },

    // ---- Computation ------------------------------------------------------

    /**
     * Compute the gate for a set of employees.
     * @param where { employeeIds?: number[], employeeNumber?: string, siteKey?: string,
     *                roleId?: number, activeOnly?: boolean, includeCached?: boolean }
     * @param scopeIds  null = unrestricted, array = RBAC-visible ids
     */
    async computeFor(
        where = {},
        scopeIds = null,
        { source = 'on_demand', record = true, extraRules = null } = {}
    ) {
        if (Array.isArray(scopeIds) && !scopeIds.length) return [];
        const cond = [];
        const params = [];
        if (Array.isArray(scopeIds)) {
            cond.push(`e.id IN (${scopeIds.map(() => '?').join(',')})`);
            params.push(...scopeIds);
        }
        if (Array.isArray(where.employeeIds)) {
            if (!where.employeeIds.length) return [];
            cond.push(`e.id IN (${where.employeeIds.map(() => '?').join(',')})`);
            params.push(...where.employeeIds);
        }
        if (where.employeeNumber != null) {
            cond.push('LOWER(e.employee_number) = LOWER(?)');
            params.push(String(where.employeeNumber));
        }
        if (where.siteKey) {
            cond.push('(s.name = ? OR s.code = ? OR CAST(s.id AS text) = ?)');
            params.push(where.siteKey, where.siteKey, where.siteKey);
        }
        if (where.roleId != null) {
            cond.push('e.role_id = ?');
            params.push(Number(where.roleId));
        }
        if (where.siteId != null) {
            cond.push('e.site_id = ?');
            params.push(Number(where.siteId));
        }
        if (where.activeOnly) {
            cond.push(
                where.includeCached
                    ? '(e.is_active = true OR EXISTS (SELECT 1 FROM safety_gate_status gs WHERE gs.employee_id = e.id))'
                    : 'e.is_active = true'
            );
        }
        const employees = await db.all(
            `SELECT e.id, e.employee_number AS "employeeNumber", ${personNameSql('e')} AS "name",
                    e.is_active AS "isActive", e.role_id AS "roleId", e.site_id AS "siteId",
                    s.name AS "siteName", r.name AS "roleName"
               FROM employees e
               LEFT JOIN sites s ON s.id = e.site_id
               LEFT JOIN roles r ON r.id = e.role_id
              WHERE ${cond.length ? cond.join(' AND ') : '1 = 1'}
              ORDER BY s.name NULLS LAST, r.name NULLS LAST, e.last_name, e.id
              LIMIT ${BULK_MAX}`,
            params
        );
        if (!employees.length) return [];

        const settings = await this.getSettings();
        const roleIds = [
            ...new Set(
                employees
                    .map((e) => e.roleId)
                    .filter((x) => x != null)
                    .map(Number)
            ),
        ];
        const rules = roleIds.length
            ? await db.all(
                  `SELECT gr.role_id AS "roleId", gr.site_id AS "siteId", gr.skill_id AS "skillId",
                        gr.min_level AS "minLevel", gr.cert_required AS "certRequired", sk.name AS "skillName",
                        gr."mode" AS "mode", gr.require_validated AS "requireValidated",
                        gr.max_age_months AS "maxAgeMonths"
                   FROM safety_gate_rules gr JOIN skills sk ON sk.id = gr.skill_id
                  WHERE gr.is_active AND gr.role_id IN (${roleIds.map(() => '?').join(',')})`,
                  roleIds
              )
            : [];
        if (Array.isArray(extraRules) && extraRules.length) rules.push(...extraRules);

        const empIds = employees.map((e) => Number(e.id));
        const skillIds = [...new Set(rules.map((r) => Number(r.skillId)))];
        const needValidated = rules.some((r) => r.requireValidated);
        const facts = new Map(
            empIds.map((id) => [
                id,
                {
                    levels: new Map(),
                    assessedAt: new Map(),
                    validated: new Map(),
                    certs: new Map(),
                    lapsed: new Map(),
                },
            ])
        );
        if (skillIds.length) {
            const eIn = empIds.map(() => '?').join(',');
            const kIn = skillIds.map(() => '?').join(',');
            const p = [...empIds, ...skillIds];
            // Sequential on purpose: inside a caller's transaction the three reads
            // share ONE client, and pg refuses concurrent queries on a client.
            const levels = await db.all(
                `SELECT ra.employee_id AS "employeeId", ra.skill_id AS "skillId", ra.level AS "level",
                        ra.assessed_at AS "assessedAt"
                   FROM v_resolved_assessments ra
                  WHERE ra.employee_id IN (${eIn}) AND ra.skill_id IN (${kIn})`,
                p
            );
            // the latest SUPERVISOR-validated level, read only when a rule
            // asks for it (skill_assessments is the validated source of the view).
            const validated = needValidated
                ? await db.all(
                      `SELECT DISTINCT ON (sa.employee_id, sa.skill_id)
                              sa.employee_id AS "employeeId", sa.skill_id AS "skillId",
                              sa.current_level AS "level", sa.assessed_at AS "assessedAt"
                         FROM skill_assessments sa
                        WHERE sa.employee_id IN (${eIn}) AND sa.skill_id IN (${kIn})
                          AND sa.current_level IS NOT NULL
                        ORDER BY sa.employee_id, sa.skill_id, sa.assessed_at DESC`,
                      p
                  )
                : [];
            const certs = await db.all(
                `SELECT cc.employee_id AS "employeeId", cc.skill_id AS "skillId", cc.cert_status AS "certStatus",
                        to_char(cc.expires_on, 'YYYY-MM-DD') AS "expiresOn", cc.days_to_expiry AS "daysLeft"
                   FROM v_certification_current cc
                  WHERE cc.employee_id IN (${eIn}) AND cc.skill_id IN (${kIn})`,
                p
            );
            const lapsed = await db.all(
                `SELECT cl.employee_id AS "employeeId", cl.skill_id AS "skillId", cl.lapse_reason AS "lapseReason",
                        to_char(cl.last_expires_on, 'YYYY-MM-DD') AS "lastExpiresOn"
                   FROM v_certification_lapsed cl
                  WHERE cl.employee_id IN (${eIn}) AND cl.skill_id IN (${kIn})`,
                p
            );
            for (const r of levels) {
                const f = facts.get(Number(r.employeeId));
                if (f && r.level != null) {
                    f.levels.set(Number(r.skillId), Number(r.level));
                    if (r.assessedAt) f.assessedAt.set(Number(r.skillId), r.assessedAt);
                }
            }
            for (const r of validated) {
                const f = facts.get(Number(r.employeeId));
                if (f && r.level != null)
                    f.validated.set(Number(r.skillId), {
                        level: Number(r.level),
                        assessedAt: r.assessedAt || null,
                    });
            }
            for (const r of certs) {
                const f = facts.get(Number(r.employeeId));
                if (f)
                    f.certs.set(Number(r.skillId), {
                        certStatus: r.certStatus,
                        expiresOn: r.expiresOn || null,
                        daysLeft: r.daysLeft == null ? null : Number(r.daysLeft),
                    });
            }
            for (const r of lapsed) {
                const f = facts.get(Number(r.employeeId));
                if (f)
                    f.lapsed.set(Number(r.skillId), {
                        lapseReason: r.lapseReason,
                        lastExpiresOn: r.lastExpiresOn || null,
                    });
            }
        }

        const evaluatedAt = new Date().toISOString();
        const results = employees.map((e) => {
            const out = evaluateWithModes(e, rules, facts.get(Number(e.id)), {
                warningDays: settings.expiryWarningDays,
            });
            return {
                employeeId: Number(e.id),
                employeeNumber: e.employeeNumber,
                name: e.name,
                siteName: e.siteName || null,
                roleName: e.roleName || null,
                isActive: e.isActive !== false,
                ...out,
                evaluatedAt,
            };
        });

        if (record) {
            try {
                await this.recordStatuses(results, source, settings);
            } catch (e) {
                // Recording a change must never withhold the answer itself.
                console.error('[safety-gate] recording status changes failed:', e && e.message);
            }
        }
        return results;
    },

    /** One employee by number, within the caller's scope; null when not visible. */
    async statusByEmployeeNumber(user, employeeNumber, opts = {}) {
        const num = String(employeeNumber || '').trim();
        if (!num || num.length > 64) return null;
        const ids = await scopedEmployeeIds(user);
        const rows = await this.computeFor({ employeeNumber: num }, ids, opts);
        return rows[0] || null;
    },

    /** Active employees in scope, optionally narrowed to a site / role / status. */
    async statusBulk(user, { site, roleId, status } = {}, opts = {}) {
        const ids = await scopedEmployeeIds(user);
        const rows = await this.computeFor(
            {
                siteKey: site ? String(site).slice(0, 200) : null,
                roleId:
                    roleId != null && roleId !== '' && Number.isFinite(Number(roleId))
                        ? Number(roleId)
                        : null,
                activeOnly: true,
            },
            ids,
            opts
        );
        const want = status ? String(status).toUpperCase() : null;
        return want && STATUS[want] ? rows.filter((r) => r.status === want) : rows;
    },

    async recomputeForEmployee(employeeId, source = 'source_change') {
        const id = parseInt(employeeId, 10);
        if (!Number.isFinite(id)) return null;
        const rows = await this.computeFor({ employeeIds: [id] }, null, { source });
        return rows[0] || null;
    },

    async recomputeForRole(roleId, source = 'rule_change') {
        return this.computeFor({ roleId, activeOnly: true, includeCached: true }, null, { source });
    },

    async recomputeAll(source = 'nightly') {
        return this.computeFor({ activeOnly: true, includeCached: true }, null, { source });
    },

    /**
     * Persist the answers that CHANGED: upsert the last-known status, append a
     * history row, write the audit log and queue the webhook. The upsert only
     * returns a row when the fingerprint differs, so two concurrent evaluations
     * record one change, not two.
     */
    async recordStatuses(results, source, settings = null) {
        if (!results.length) return { changed: 0 };
        const ids = results.map((r) => r.employeeId);
        const cached = await db.all(
            `SELECT employee_id AS "employeeId", status, enforced_status AS "enforcedStatus", fingerprint
               FROM safety_gate_status WHERE employee_id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
        const prevById = new Map(cached.map((c) => [Number(c.employeeId), c]));
        const cfg = settings || (await this.getSettings());
        let changed = 0;
        for (const r of results) {
            const fp = fingerprint(r);
            const prev = prevById.get(r.employeeId) || null;
            if (prev && prev.fingerprint === fp) continue;
            // Never seen and nothing to say: do not fill the trail with every
            // employee of a role that has no critical skill.
            if (!prev && r.status === STATUS.NOT_CONFIGURED) continue;
            const reasonsJson = JSON.stringify(r.reasons.map(stripScores));
            const enforced = effectiveStatus(r);
            const up = await db.get(
                `INSERT INTO safety_gate_status (employee_id, status, enforced_status, reasons, next_expiry, fingerprint, computed_at, changed_at)
                 VALUES (?, ?, ?, CAST(? AS jsonb), CAST(? AS date), ?, now(), now())
                 ON CONFLICT (employee_id) DO UPDATE SET
                    status = EXCLUDED.status, enforced_status = EXCLUDED.enforced_status,
                    reasons = EXCLUDED.reasons, next_expiry = EXCLUDED.next_expiry,
                    fingerprint = EXCLUDED.fingerprint, computed_at = now(), changed_at = now()
                  WHERE safety_gate_status.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
                 RETURNING employee_id AS "employeeId"`,
                [r.employeeId, r.status, enforced, reasonsJson, r.nextExpiry, fp]
            );
            if (!up) continue; // a concurrent evaluation already recorded this change
            changed++;
            const previousStatus = prev ? prev.status : null;
            // Rows written before migration 155 have no enforced status: every
            // rule was enforced then, so the plain status IS the enforced one.
            const previousEnforced = prev ? prev.enforcedStatus || prev.status : null;
            await db.run(
                `INSERT INTO safety_gate_status_history (employee_id, previous_status, status, enforced_status, reasons, next_expiry, source)
                 VALUES (?, ?, ?, ?, CAST(? AS jsonb), CAST(? AS date), ?)`,
                [
                    r.employeeId,
                    previousStatus,
                    r.status,
                    enforced,
                    reasonsJson,
                    r.nextExpiry,
                    String(source).slice(0, 40),
                ]
            );
            await audit(
                null,
                'SAFETY_GATE_STATUS_CHANGED',
                'employee',
                r.employeeId,
                `${previousStatus || 'none'} -> ${r.status}${enforced !== r.status ? ` (enforced: ${enforced})` : ''} [${r.reasons.map((x) => x.code).join(',') || '-'}] (${source})`,
                enforced === STATUS.BLOCKED ? 'warn' : 'info'
            );
            if (
                prev &&
                (previousStatus !== r.status || previousEnforced !== enforced) &&
                cfg.webhookEnabled &&
                cfg.webhookUrl
            ) {
                await this.enqueueWebhook(r, previousStatus).catch((e) =>
                    console.error('[safety-gate] webhook enqueue failed:', e && e.message)
                );
            }
            // the person and their line hear of it when the ENFORCED answer
            // becomes BLOCKED or EXPIRING. This point is reached once per change
            // (the conditional upsert above returns the row to ONE writer), and
            // only a change of enforced status notifies — a new reason on an
            // already-blocked person does not.
            if (
                r.isActive !== false &&
                enforced !== previousEnforced &&
                (enforced === STATUS.BLOCKED || enforced === STATUS.EXPIRING)
            ) {
                await this.notifyTransition(r, previousEnforced).catch((e) =>
                    console.error('[safety-gate] notification failed:', e && e.message)
                );
            }
        }
        return { changed };
    },

    /**
     * tell the person and their reporting line (ReportingLineService
     * .lineRecipients: effective reviewer + manager, ACTIVE only, never the
     * person) why, with a link to the development plan. Only the reasons that
     * ENFORCE are listed; no level or score is ever written.
     */
    async notifyTransition(r, previousEnforced) {
        const NotificationService = require('./NotificationService');
        const enforced = effectiveStatus(r);
        const blocked = enforced === STATUS.BLOCKED;
        const kind = blocked ? 'safety.blocked' : 'safety.expiring';
        const relevant = r.reasons.filter(
            (x) => !x.observe && (blocked ? x.blocking : !x.blocking)
        );
        const fr = reasonSummary(relevant.length ? relevant : r.reasons, 'fr');
        const en = reasonSummary(relevant.length ? relevant : r.reasons, 'en');
        const skillId = (relevant.find((x) => x.skillId != null) || {}).skillId;
        const plan = await db
            .get(
                `SELECT id FROM idp_plans WHERE employee_id = ?
                  ORDER BY created_at DESC, id DESC LIMIT 1`,
                [r.employeeId]
            )
            .catch(() => null);
        const lineLink = plan
            ? `/v2/idp/${Number(plan.id)}`
            : `/v2/idp/new?employeeId=${Number(r.employeeId)}${skillId != null ? `&skillId=${Number(skillId)}` : ''}`;
        const L = LOCALE_TEXT;
        const head = (lng) => (blocked ? L[lng].notif_blocked : L[lng].notif_expiring);
        const sent = [];

        const personResult = await NotificationService.notify({
            userType: 'employee',
            userId: r.employeeId,
            kind,
            category: 'compliance',
            payload: {
                employeeId: r.employeeId,
                status: enforced,
                previousStatus: previousEnforced,
                reason: fr,
                link: '/v2/idp',
            },
            subject: `${head('fr')} / ${head('en')}`,
            html: `<p>${esc(head('fr'))} : ${esc(fr)}.</p><p>${esc(L.fr.notif_plan)}</p><p style="color:#888;">${esc(head('en'))}: ${esc(en)}. ${esc(L.en.notif_plan)}</p>`,
            text: `${head('fr')} : ${fr}. ${L.fr.notif_plan}\n${head('en')}: ${en}. ${L.en.notif_plan}`,
        });
        sent.push({ userType: 'employee', id: r.employeeId, result: personResult });

        const recipients = await require('./ReportingLineService')
            .lineRecipients(r.employeeId, { includeManager: true })
            .catch(() => []);
        const who = r.name || r.employeeNumber || `#${r.employeeId}`;
        for (const x of recipients) {
            const res = await NotificationService.notify({
                userType: x.userType,
                userId: x.id,
                kind: `${kind}.team`,
                category: 'compliance',
                payload: {
                    employeeId: r.employeeId,
                    status: enforced,
                    previousStatus: previousEnforced,
                    reason: `${who} — ${fr}`,
                    link: lineLink,
                },
                subject: `${head('fr')} — ${who} / ${head('en')}`,
                html: `<p><strong>${esc(who)}</strong> — ${esc(head('fr'))} : ${esc(fr)}.</p><p style="color:#888;">${esc(head('en'))}: ${esc(en)}.</p>`,
                text: `${who} — ${head('fr')} : ${fr}.\n${head('en')}: ${en}.`,
            });
            sent.push({ userType: x.userType, id: x.id, result: res });
        }
        return sent;
    },

    // ---- Outgoing webhook -------------------------------------------------

    async enqueueWebhook(result, previousStatus) {
        const payload = JSON.stringify({
            event: 'safety_gate.status_changed',
            previousStatus,
            ...toApi(result),
        });
        const row = await db.get(
            `INSERT INTO safety_gate_webhook_deliveries (employee_id, event, payload)
             VALUES (?, 'safety_gate.status_changed', ?) RETURNING id`,
            [result.employeeId, payload]
        );
        // First attempt right away, off the request path; failures are retried
        // by the job with exponential backoff.
        if (row && row.id)
            setImmediate(() => {
                this.deliver(row.id).catch(() => {});
            });
        return row;
    },

    /** One delivery attempt; schedules the next one with backoff on failure. */
    async deliver(deliveryId, { send = postOnce } = {}) {
        const d = await db.get(
            `SELECT id, event, payload, attempts FROM safety_gate_webhook_deliveries
              WHERE id = ? AND state = 'pending'`,
            [deliveryId]
        );
        if (!d) return { skipped: true };
        const s = await db.get(
            `SELECT webhook_url AS "url", webhook_secret AS "secret", webhook_enabled AS "enabled"
               FROM safety_gate_settings WHERE id = 1`
        );
        const attempts = Number(d.attempts || 0) + 1;
        let res;
        if (!s || !s.enabled || !s.url || !s.secret) {
            res = { ok: false, status: null, error: 'webhook_disabled' };
        } else {
            let secret;
            try {
                secret = secretBox.decrypt(s.secret);
            } catch (_) {
                secret = null;
            }
            if (!secret) {
                res = { ok: false, status: null, error: 'secret_unavailable' };
            } else {
                const ts = String(Math.floor(Date.now() / 1000));
                res = await send(s.url, d.payload, {
                    'Content-Type': 'application/json',
                    'User-Agent': 'IDevelop-SafetyGate/1',
                    'X-IDevelop-Event': d.event,
                    'X-IDevelop-Delivery': String(d.id),
                    'X-IDevelop-Timestamp': ts,
                    'X-IDevelop-Signature': sign(secret, ts, d.payload),
                });
            }
        }
        if (res.ok) {
            await db.run(
                `UPDATE safety_gate_webhook_deliveries
                    SET state = 'delivered', attempts = ?, status_code = ?, last_error = NULL, delivered_at = now()
                  WHERE id = ?`,
                [attempts, res.status, d.id]
            );
            return { delivered: true, attempts };
        }
        const abandon = attempts >= MAX_ATTEMPTS || res.error === 'webhook_disabled';
        await db.run(
            `UPDATE safety_gate_webhook_deliveries
                SET state = ?, attempts = ?, status_code = ?, last_error = ?,
                    next_attempt_at = now() + (? * interval '1 minute')
              WHERE id = ?`,
            [
                abandon ? 'abandoned' : 'pending',
                attempts,
                res.status,
                String(res.error || 'failed').slice(0, 200),
                backoffMinutes(attempts),
                d.id,
            ]
        );
        if (abandon) {
            await audit(
                null,
                'SAFETY_GATE_WEBHOOK_ABANDONED',
                'safety_gate_delivery',
                d.id,
                `after ${attempts} attempt(s): ${res.error || 'failed'}`,
                'warn'
            );
        }
        return { delivered: false, attempts, abandoned: abandon, error: res.error };
    },

    /** Retry every due delivery (job). */
    async retryDue(limit = 50) {
        const due = await db.all(
            `SELECT id FROM safety_gate_webhook_deliveries
              WHERE state = 'pending' AND next_attempt_at <= now()
              ORDER BY next_attempt_at LIMIT ${Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500)}`
        );
        let delivered = 0;
        for (const d of due) {
            const r = await this.deliver(d.id);
            if (r && r.delivered) delivered++;
        }
        return { due: due.length, delivered };
    },

    /**
     * The delivery trail, scoped to the actor (SEC-1): the SuperAdmin reads it
     * all; anyone else only deliveries about employees in their clearance. No
     * actor, or an empty scope, reads nothing.
     */
    async recentDeliveries(limit = 20, actor = null) {
        if (!actor) return [];
        const ids = await scopedEmployeeIds(actor);
        if (Array.isArray(ids) && !ids.length) return [];
        const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
        const scoped = Array.isArray(ids);
        return db.all(
            `SELECT d.id, d.event, d.state, d.attempts, d.status_code AS "statusCode", d.last_error AS "lastError",
                    d.created_at AS "createdAt", d.delivered_at AS "deliveredAt", e.employee_number AS "employeeNumber"
               FROM safety_gate_webhook_deliveries d LEFT JOIN employees e ON e.id = d.employee_id
              ${scoped ? `WHERE d.employee_id IN (${ids.map(() => '?').join(',')})` : ''}
              ORDER BY d.id DESC LIMIT ${lim}`,
            scoped ? ids : []
        );
    },

    /** True when today's full recompute has not completed yet. */
    async nightlyDue() {
        const row = await db.get(
            `SELECT 1 AS due FROM safety_gate_settings
              WHERE id = 1 AND (last_recompute_on IS NULL OR last_recompute_on < CURRENT_DATE)`
        );
        return !!row;
    },

    /**
     * Mark today's recompute done — called AFTER the sweep completes, so a sweep
     * that fails is retried on the next tick instead of the day being burned.
     * True for exactly one caller per day.
     */
    async claimNightly() {
        const row = await db.get(
            `UPDATE safety_gate_settings SET last_recompute_on = CURRENT_DATE
              WHERE id = 1 AND (last_recompute_on IS NULL OR last_recompute_on < CURRENT_DATE)
              RETURNING id`
        );
        return !!row;
    },

    /** Options for the page filters and the configuration form. */
    async formOptions() {
        const [roles, sites] = await Promise.all([
            db.all('SELECT id, name FROM roles WHERE is_active = true ORDER BY name'),
            db.all('SELECT id, name FROM sites ORDER BY name'),
        ]);
        return { roles, sites };
    },
};

function stripScores(r) {
    const o = { code: r.code, blocking: !!r.blocking };
    if (r.skillId != null) o.skillId = r.skillId;
    if (r.expiresOn) o.expiresOn = r.expiresOn;
    if (r.observe) o.observe = true;
    return o;
}

function failWith(code, status = 400) {
    const e = new Error(code);
    e.code = code;
    e.status = status;
    throw e;
}

function assertSuperAdmin(actor) {
    if (!require('./RBACService').isSuperAdmin(actor)) failWith('forbidden', 403);
}

// The namespace's own strings, read once, for notification texts written
// outside a request (jobs, recomputes): FR primary, EN parity.
const LOCALE_TEXT = (() => {
    const load = (lng) => {
        try {
            return require(`../../locales/${lng}/safety.json`);
        } catch (_) {
            return {};
        }
    };
    return { fr: load('fr'), en: load('en') };
})();

/** "Skill — reason; Skill — reason" in one language. Never a level or score. */
function reasonSummary(reasons, lng) {
    const L = LOCALE_TEXT[lng] || LOCALE_TEXT.fr;
    return reasons
        .map((x) => {
            const label = L[`reason_${x.code}`] || x.code;
            return x.skillName ? `${x.skillName} — ${label}` : label;
        })
        .join(' ; ');
}

function esc(s) {
    return String(s == null ? '' : s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

function safeHost(url) {
    try {
        return new URL(url).host;
    } catch (_) {
        return '?';
    }
}

async function audit(actor, action, entityType, entityId, details, severity) {
    try {
        await require('./LogService').log({
            adminId: actor && actor.userType === 'admin' ? actor.id : null,
            actorRef:
                actor && actor.userType && actor.id != null
                    ? `${actor.userType}:${actor.id}`
                    : undefined,
            action,
            entityType,
            entityId: entityId != null ? Number(entityId) : null,
            details,
            category: 'compliance',
            severity,
        });
    } catch (_) {
        /* audit is best-effort; the change itself is in safety_gate_status_history */
    }
}

module.exports = SafetyGateService;
