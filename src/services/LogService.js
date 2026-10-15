const SystemLogModel = require('../models/SystemLogModel');

/**
 * Canonical spellings for `entity_type`. Writers used table
 * names, camelCase and snake_case for the same thing; from now on every row is
 * written in ONE vocabulary. The legacy spellings already in the table are NOT
 * rewritten (entity_type is inside the tamper-evidence hash) — the model's
 * ENTITY_SYNONYMS makes a filter on the canonical name match them too.
 */
const ENTITY_CANONICAL = {
    employees: 'employee',
    selfAssessment: 'self_assessment',
    self_assessments: 'self_assessment',
    selfassessment: 'self_assessment',
    nineBox: 'nine_box',
    nine_box_evaluations: 'nine_box',
    ninebox: 'nine_box',
    admins: 'admin',
    localAdmins: 'admin',
    localadmin: 'admin',
    idp_plans: 'idp',
    idpPlan: 'idp',
    pips: 'pip',
    appSetting: 'app_setting',
    appSettings: 'app_setting',
    setting: 'app_setting',
    skillAssessment: 'skill_assessment',
    skillAssessments: 'skill_assessment',
    coachingPlan: 'coaching_plan',
    coaching_plans: 'coaching_plan',
    coaching: 'coaching_plan',
    assessment_cycles: 'cycle',
    assessmentCycle: 'cycle',
    cycles: 'cycle',
    supervisorReview: 'supervisor_review',
    supervisor_reviews: 'supervisor_review',
    roles: 'role',
    sites: 'site',
    departments: 'department',
    services: 'service',
    skills: 'skill',
    domains: 'domain',
    apiKey: 'api_key',
    api_keys: 'api_key',
};

/** `employee#84 hamady` / `employee:84` / `manager#12 x` → `employee:84` / `manager:12`. */
function normalizeActorRef(ref) {
    if (ref == null || ref === '') return null;
    const s = String(ref).trim();
    const m = /^([a-z]+)[#:](\d+)(?:\s.*)?$/i.exec(s);
    return m ? `${m[1].toLowerCase()}:${m[2]}` : s;
}

function normalizeEntityType(type) {
    if (type == null || type === '') return null;
    const s = String(type).trim();
    return ENTITY_CANONICAL[s] || s;
}

/** One severity vocabulary: info · warn · error · critical. */
function normalizeSeverity(sev) {
    if (sev == null || sev === '') return null;
    const s = String(sev).trim().toLowerCase();
    if (s === 'warning') return 'warn';
    if (s === 'err' || s === 'fatal') return 'error';
    return s;
}

/**
 * Category from the action prefix, for writers that do not say. The SAME rules
 * as the backfill in db/postgres/112_system_logs_normalisation.sql (the unit
 * test pins both), so old and new rows classify alike.
 */

/** Actions filed under « security »: prefixes, exact names, suffixes, anywhere. */
const SECURITY_ACTIONS = [
    /^(?:LOGIN|MFA_|PASSWORD_|SESSION|API_KEY|SSO_)/,
    /^(?:ACCOUNT_LOCKED|IP_BLOCKED|ACCESS_DENIED)$/,
    /RATE_LIMITED$/,
    /(?:LOGOUT|UNAUTH|TAMPER)/,
];
function categoryFor(action) {
    const a = String(action || '').toUpperCase();
    if (/^HTTP_/.test(a)) return 'http';
    if (/^MAINT_/.test(a)) return 'maintenance';
    if (SECURITY_ACTIONS.some((re) => re.test(a))) return 'security';
    if (a.startsWith('SERVER_ERROR') || a.endsWith('_ERROR')) return 'system';
    return 'audit';
}

/** Severity from the HTTP status or the action, for writers that do not say. */
function severityFor(action, statusCode) {
    const a = String(action || '').toUpperCase();
    const sc = statusCode != null ? Number(statusCode) : null;
    if ((sc != null && sc >= 500) || /^SERVER_ERROR/.test(a)) return 'error';
    if (
        (sc != null && sc >= 400) ||
        /^(LOGIN_FAILED|ACCOUNT_LOCKED|IP_BLOCKED|ACCESS_DENIED)$|RATE_LIMITED$|_FAILED$|DENIED|^MAINT_|TAMPER/.test(
            a
        )
    )
        return 'warn';
    return 'info';
}

/**
 * HR4-25 — UNE ACTION NE DOIT JAMAIS ÊTRE ATTRIBUÉE À LA MAUVAISE PERSONNE.
 *
 * `admin_id` est une clé étrangère vers `admins`. Quand l'acteur est un EMPLOYÉ,
 * l'insertion échoue normalement (23503) et le service réessaie en `actor_ref` —
 * mais si un compte d'administration porte par hasard le MÊME identifiant
 * numérique qu'un employé, la clé étrangère RÉUSSIT et l'action est enregistrée
 * en silence au nom de cet administrateur. Mesuré sur la base de développement :
 * l'administrateur
 * #87 et l'employé #87 (Ismael LINDQVIST) coexistent déjà.
 *
 * Dès que l'appelant dit qui agit (`actorRef`), c'est lui qui fait foi : une
 * référence non-administrateur interdit d'écrire l'identifiant dans `admin_id`.
 * Les appelants qui ne disent rien gardent exactement le comportement d'avant.
 */
function adminIdFor(data, actorRef) {
    const id = data.adminId || null;
    if (id == null || !actorRef) return id;
    return /^admin:/i.test(actorRef) ? id : null;
}

/* ---------------------------------------------------------------------------
 * IDS ONLY in the audit log.
 *
 * The audit log is immutable and kept for years, so it must not carry names,
 * e-mail addresses or login names in free text: the id is the key and the name
 * is resolved AT VIEW TIME (SystemLogModel.resolvePeople), where an erased
 * person reads "Erased person #id" in the reader's language.
 *
 * Two central guards, whatever the caller wrote:
 *  1. every e-mail address in `details` becomes `[e-mail]`;
 *  2. the identifiers of the row's own subjects — the actor (actorRef /
 *     adminId), the entity when it is a person (employee / admin), and any
 *     ref listed in `data.subjects` — are replaced by their ref
 *     (`employee:84`, `admin:3`): full name (both orders), login, e-mail.
 * Callers still pass ids rather than names (fixed where they did not).
 * ------------------------------------------------------------------------- */
// A LINEAR e-mail pattern. An unbounded, unanchored one restarts at every
// character of a long local-part run: an 80 KB request path or free-text reason
// would block the event loop for seconds, anonymously through the
// CSRF-rejection audit. The look-behind lets a match start only where a
// local-part run starts, and every quantifier is bounded (RFC 5321 sizes), so
// the scan is linear.
const EMAIL_RE =
    /(?<![\w.%+'-])[\w.%+'-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
// …and no logged string is longer than this, cut BEFORE any scrubbing (~4 KB).
const MAX_LOGGED_STRING = 4096;
function capLoggedString(s) {
    return s.length > MAX_LOGGED_STRING ? `${s.slice(0, MAX_LOGGED_STRING)} […]` : s;
}
const IDENT_TTL_MS = 5 * 60 * 1000;
const IDENT_CACHE_MAX = 500;
const _identCache = new Map(); // ref → { at, needles }

// Escapes only syntax characters: the result is used with the `u` flag, where an
// identity escape such as `\-` is a SyntaxError (hyphenated names).
function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Identifiers worth scrubbing: ≥ 3 characters, at least one letter, not already a pseudonym. */
function usableNeedle(s) {
    const t = String(s == null ? '' : s).trim();
    return t.length >= 3 && /\p{L}/u.test(t) && !/^erased/i.test(t) ? t : null;
}

/** The person refs a row is about: `employee:<id>` / `admin:<id>`. */
function subjectRefsOf(data, actorRef, adminId, entityType) {
    const refs = new Set();
    const m = /^(employee|manager|supervisor|admin):(\d+)$/.exec(actorRef || '');
    if (m) refs.add(`${m[1] === 'admin' ? 'admin' : 'employee'}:${m[2]}`);
    if (adminId != null && Number(adminId) > 0) refs.add(`admin:${Number(adminId)}`);
    const eid = Number(data.entityId);
    if (Number.isInteger(eid) && eid > 0) {
        if (entityType === 'employee') refs.add(`employee:${eid}`);
        else if (entityType === 'admin') refs.add(`admin:${eid}`);
    }
    for (const r of Array.isArray(data.subjects) ? data.subjects : []) {
        const s = /^(employee|manager|supervisor|admin):(\d+)$/.exec(String(r || '').trim());
        if (s) refs.add(`${s[1] === 'admin' ? 'admin' : 'employee'}:${s[2]}`);
    }
    return [...refs];
}

/** Names / login / e-mail of one person ref, from the database (cached 5 min). */
async function identifiersOf(ref) {
    const hit = _identCache.get(ref);
    if (hit && Date.now() - hit.at < IDENT_TTL_MS) return hit.needles;
    const [type, id] = ref.split(':');
    const db = require('../config/database');
    let row = null;
    if (type === 'employee')
        row = await db.get(
            'SELECT first_name, last_name, email, username FROM employees WHERE id = ?',
            [Number(id)]
        );
    else if (type === 'admin')
        row = await db.get('SELECT username, email FROM admins WHERE id = ?', [Number(id)]);
    const needles = [];
    if (row) {
        const f = String(row.firstName ?? row.first_name ?? '').trim();
        const l = String(row.lastName ?? row.last_name ?? '').trim();
        if (f && l) needles.push(`${f} ${l}`, `${l} ${f}`);
        needles.push(row.email, row.username);
    }
    const out = [...new Set(needles.map(usableNeedle).filter(Boolean))].sort(
        (a, b) => b.length - a.length
    );
    if (_identCache.size >= IDENT_CACHE_MAX) _identCache.clear();
    _identCache.set(ref, { at: Date.now(), needles: out });
    return out;
}

/** Apply `fn` to every string inside `v` (keys untouched), depth-bounded. */
function mapStrings(v, fn, depth = 0) {
    if (typeof v === 'string') return fn(v);
    if (depth > 8 || v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn, depth + 1));
    if (v instanceof Date) return v;
    const out = new Map();
    for (const [k, x] of Object.entries(v)) out.set(k, mapStrings(x, fn, depth + 1));
    return Object.fromEntries(out);
}

/**
 * `details` with the subjects' identifiers replaced by their ref and every
 * other e-mail address masked. `subjects`: [{ ref, needles }].
 */
function scrubDetails(details, subjects = []) {
    if (details == null) return details;
    const rules = [];
    for (const s of subjects)
        for (const n of s.needles || [])
            rules.push({
                re: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(n)}(?![\\p{L}\\p{N}_])`, 'giu'),
                to: s.ref,
            });
    return mapStrings(details, (str) => {
        let out = capLoggedString(str);
        for (const r of rules) out = out.replace(r.re, r.to);
        return out.replace(EMAIL_RE, '[e-mail]');
    });
}

/** The row's subjects with their identifiers; a failed lookup scrubs e-mails only. */
async function subjectsFor(details, refs) {
    if (details == null || !refs.length) return [];
    const out = [];
    for (const ref of refs) {
        try {
            out.push({ ref, needles: await identifiersOf(ref) });
        } catch (_) {
            /* no database here (unit test) or no such person: e-mails are still masked */
        }
    }
    return out;
}

class LogService {
    async log(data) {
        const actorRef = normalizeActorRef(data.actorRef);
        const entityType = normalizeEntityType(data.entityType);
        const adminId = adminIdFor(data, actorRef);
        const details = scrubDetails(
            data.details || null,
            await subjectsFor(data.details, subjectRefsOf(data, actorRef, adminId, entityType))
        );
        const base = {
            adminId,
            action: data.action,
            entityType,
            entityId: data.entityId || null,
            details: details || null,
            ipAddress: data.ipAddress || null,
            userAgent: data.userAgent || null,
            // Observability facets. Every row is classified: an explicit
            // value wins, otherwise the action/status decide — never NULL.
            requestId: data.requestId || null,
            severity: normalizeSeverity(data.severity) || severityFor(data.action, data.statusCode),
            category: data.category || categoryFor(data.action),
            httpMethod: data.httpMethod || null,
            route: data.route || null,
            statusCode: data.statusCode != null ? data.statusCode : null,
            latencyMs: data.latencyMs != null ? data.latencyMs : null,
            // `<type>:<id>` at write time — the id is the key, the
            // username some callers appended is one JOIN away and changes.
            actorRef,
        };
        try {
            await SystemLogModel.create(base);
        } catch (error) {
            // Managers/supervisors/employees aren't in the admins table, so the
            // admin_id FK (23503) fails for non-admin actors. Re-log with a null
            // admin_id and keep the actor reference in details so the change is
            // still tracked (the entity event tables capture the exact actor).
            if (error && error.code === '23503' && base.adminId != null) {
                try {
                    // Non-admin actor (employee/manager): the admin_id FK can't hold
                    // them, so record a queryable actor_ref instead of only text, and
                    // null the admin_id. This keeps WHO acted searchable in the logs.
                    await SystemLogModel.create({
                        ...base,
                        adminId: null,
                        actorRef: base.actorRef || `employee:${base.adminId}`,
                    });
                    return;
                } catch (retryErr) {
                    console.error(
                        'Error logging to database (retry):',
                        retryErr.message || retryErr
                    );
                    return;
                }
            }
            console.error('Error logging to database:', error.message || error);
            // Don't throw - logging should not break the application
        }
    }
}

const service = new LogService();
service.normalizeActorRef = normalizeActorRef;
service.normalizeEntityType = normalizeEntityType;
service.normalizeSeverity = normalizeSeverity;
service.categoryFor = categoryFor;
service.severityFor = severityFor;
service.ENTITY_CANONICAL = ENTITY_CANONICAL;
service.scrubDetails = scrubDetails;
service.EMAIL_RE = EMAIL_RE;
service.MAX_LOGGED_STRING = MAX_LOGGED_STRING;
service.subjectRefsOf = subjectRefsOf;
service._identCache = _identCache;

module.exports = service;
