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
function categoryFor(action) {
    const a = String(action || '').toUpperCase();
    if (/^HTTP_/.test(a)) return 'http';
    if (/^MAINT_/.test(a)) return 'maintenance';
    if (
        /^LOGIN|LOGOUT|^(ACCOUNT_LOCKED|IP_BLOCKED|ACCESS_DENIED)$|RATE_LIMITED$|^MFA_|^PASSWORD_|^SESSION|^API_KEY|^SSO_|UNAUTH|TAMPER/.test(
            a
        )
    )
        return 'security';
    if (/^SERVER_ERROR|_ERROR$/.test(a)) return 'system';
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

class LogService {
    async log(data) {
        const actorRef = normalizeActorRef(data.actorRef);
        const base = {
            adminId: adminIdFor(data, actorRef),
            action: data.action,
            entityType: normalizeEntityType(data.entityType),
            entityId: data.entityId || null,
            details: data.details || null,
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

module.exports = service;
