'use strict';

/**
 * ComplianceRegisterService — two transparency surfaces, both GENERATED from
 * what is configured and held, never from a hand-written text that can drift:
 *
 *   register()          the employee-representative (works council / CSE)
 *                       register: modules, retention, who may see the 9-box and
 *                       risk-of-loss scores, copilot, SSO/SCIM, audit trail and
 *                       the categories of personal data processed.
 *   forEmployee(id)     "What is recorded about me": the same categories for ONE
 *                       person, with how many records each holds, who may see it
 *                       and how long it is kept.
 *
 * The data categories ARE DSRService.export's keys — one definition of "the
 * personal data held about a subject" (the test pins the two lists together, so
 * a category added to the export without a line here fails the build).
 *
 * No new table. Every read is best-effort: a figure that could not be read is
 * `null` ("not measured"), never 0.
 */

const db = require('../config/database');
const DSRService = require('./DSRService');

/**
 * Audience keys (labels in locales/{fr,en}/compliance.json → reg_aud_<key>):
 *   self_line_hr    the person, their reporting line, HR administrators in scope
 *   self_admins     the person and the system administrators (sign-in identity)
 *   talent_conf     reporting line + HR holding the talent-review grant; the
 *                   person only once the placement is disclosed to them
 *   risk_conf       reporting line + HR holding the risk-of-loss grant; never
 *                   the person themselves
 *   hr_aggregate    HR administrators; reported in aggregate only
 *
 * `confidential: true` → the person's own page lists the category but does not
 * print a count: its existence is itself a confidential talent decision until
 * disclosed, and the complete content is available through a formal access
 * request (DSR export), which is where the law puts it.
 */
const DATA_CATEGORIES = [
    { key: 'profile', group: 'identity', audience: 'self_line_hr' },
    { key: 'userIdentities', group: 'identity', audience: 'self_admins' },
    { key: 'ssoMappings', group: 'identity', audience: 'self_admins' },
    { key: 'ssoMigrationRows', group: 'identity', audience: 'self_admins' },
    { key: 'linkedAdminAccounts', group: 'identity', audience: 'self_admins' },
    { key: 'skillAssessments', group: 'skills', audience: 'self_line_hr' },
    { key: 'selfAssessments', group: 'skills', audience: 'self_line_hr' },
    { key: 'supervisorReviews', group: 'skills', audience: 'self_line_hr' },
    { key: 'disputes', group: 'skills', audience: 'self_line_hr' },
    { key: 'changeRequests', group: 'skills', audience: 'self_line_hr' },
    { key: 'nineBox', group: 'talent', audience: 'talent_conf', confidential: true },
    {
        key: 'calibrationAdjustments',
        group: 'talent',
        audience: 'talent_conf',
        confidential: true,
    },
    { key: 'retentionRisk', group: 'talent', audience: 'risk_conf', confidential: true },
    { key: 'coachingSessions', group: 'development', audience: 'self_line_hr' },
    { key: 'coachingPlans', group: 'development', audience: 'self_line_hr' },
    { key: 'coachingGrow', group: 'development', audience: 'self_line_hr' },
    { key: 'goals', group: 'development', audience: 'self_line_hr' },
    { key: 'checkins', group: 'development', audience: 'self_line_hr' },
    { key: 'idp', group: 'development', audience: 'self_line_hr' },
    { key: 'idpObjectives', group: 'development', audience: 'self_line_hr' },
    { key: 'pips', group: 'development', audience: 'self_line_hr' },
    { key: 'surveyResponses', group: 'engagement', audience: 'hr_aggregate' },
    { key: 'recognitions', group: 'engagement', audience: 'self_line_hr' },
    { key: 'demographics', group: 'engagement', audience: 'hr_aggregate' },
    { key: 'lifecycleEvents', group: 'employment', audience: 'self_line_hr' },
];

/** Export keys that are envelope, not data about the person. */
const EXPORT_META_KEYS = ['employeeId', 'generatedAt'];

/** Grants that open the confidential talent surfaces to a delegated admin. */
const TALENT_SLUGS = ['manage_talent_reviews'];
const RISK_SLUGS = ['view_retention_risk', 'manage_retention_risk'];

const truthy = (v) =>
    v === true || v === 1 || ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

/** Records held in one export slot: rows, 1 for an object, null when unreadable. */
function countOf(v) {
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return v.error ? null : 1;
    return v === null || v === undefined ? 0 : 1;
}

class ComplianceRegisterService {
    get DATA_CATEGORIES() {
        return DATA_CATEGORIES;
    }

    async _safe(fn, dflt = null) {
        try {
            return await db.runInSavepoint(fn);
        } catch (_) {
            return dflt;
        }
    }

    async _setting(key, dflt) {
        return this._safe(() => require('../models/AppSettingsModel').getValue(key, dflt), dflt);
    }

    /** Which modules are switched on, and from where. */
    async _modules() {
        let licence = null;
        try {
            const s = await require('./EntitlementService').status();
            licence = { unmanaged: !!s.unmanaged, features: s.features || ['*'] };
        } catch (_) {
            licence = null;
        }
        const localContent = truthy(await this._setting('featureLocalContent', false));
        // Development & talent modules (Administration → Modules): the row reads
        // ON while any of them is switched on (V2_FEATURES=1 forces them all on).
        const mods = await this._safe(() => require('./ModuleService').flags(), {});
        return {
            items: [
                { key: 'core', enabled: true },
                {
                    key: 'v2',
                    enabled: Boolean(mods.development || mods.talent || mods.mobility),
                },
                { key: 'local_content', enabled: localContent },
            ],
            licence,
        };
    }

    async _retention() {
        let dsr = null;
        try {
            dsr = await DSRService.retentionStatus();
        } catch (_) {
            dsr = null;
        }
        const num = async (key, envName, dflt) => {
            const v = Number(await this._setting(key, Number(process.env[envName]) || dflt));
            return Number.isFinite(v) ? v : null;
        };
        return {
            mode: dsr ? dsr.mode : null,
            periods: dsr && Array.isArray(dsr.periods) ? dsr.periods : null,
            tombstones: dsr ? dsr.tombstones : null,
            perfEventsDays: await num('perfEventsRetentionDays', 'PERF_EVENTS_RETENTION_DAYS', 30),
            notificationDays: await num(
                'notificationRetentionDays',
                'NOTIFICATION_RETENTION_DAYS',
                120
            ),
            reminderLogDays: await num(
                'reminderLogRetentionDays',
                'REMINDER_LOG_RETENTION_DAYS',
                180
            ),
        };
    }

    /** Who may see the 9-box and the risk-of-loss scores, from the live grants. */
    async _access() {
        const one = async (sql, params = []) => {
            const r = await this._safe(() => db.get(sql, params), null);
            return r && r.n !== undefined && r.n !== null ? Number(r.n) : null;
        };
        const superadmins = await one(
            "SELECT COUNT(*)::int AS n FROM admins WHERE is_active = true AND role::text = 'superadmin'"
        );
        const scopedAdmins = await one(
            "SELECT COUNT(*)::int AS n FROM admins WHERE is_active = true AND role::text <> 'superadmin'"
        );
        const managers = await one(
            `SELECT COUNT(*)::int AS n FROM employees m
              WHERE m.is_active = true AND EXISTS (
                    SELECT 1 FROM employees e
                     WHERE e.is_active = true AND e.id <> m.id
                       AND (e.supervisor_id = m.id OR (e.manager_id = m.id AND e.manager_type = 'employee')))`
        );
        const holders = async (slugs) =>
            one(
                `SELECT COUNT(DISTINCT a.id)::int AS n
                   FROM admin_permissions p JOIN admins a ON a.id = p.admin_id
                  WHERE a.is_active = true AND a.role::text <> 'superadmin'
                    AND p.permission = ANY(?)`,
                [slugs]
            );
        return {
            superadmins,
            scopedAdmins,
            managers,
            talentDeciders: await holders(TALENT_SLUGS),
            riskViewers: await holders(RISK_SLUGS),
            // Continuity / risk of loss is the talent module.
            riskModuleMounted: await this._safe(
                () => require('./ModuleService').isOn('talent'),
                false
            ),
        };
    }

    async _copilot() {
        try {
            const cfg = await require('./CopilotService').getConfig();
            const provider = String((cfg && cfg.provider) || 'none');
            return {
                enabled: provider !== 'none',
                provider,
                model: provider !== 'none' && cfg ? cfg.model || null : null,
            };
        } catch (_) {
            return null;
        }
    }

    async _identity() {
        let sso = null;
        try {
            const cfg = require('../config/sso');
            const providers = cfg.getEnabledProviders().map((p) => p.label || p.key);
            sso = { enabled: providers.length > 0, providers };
        } catch (_) {
            sso = null;
        }
        const keys = await this._safe(
            () =>
                db.all(
                    `SELECT scope FROM api_keys
                      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
                ),
            null
        );
        let scim = null;
        if (Array.isArray(keys)) {
            const { apiKeyCanWrite } = require('../middleware/apiAuth');
            const writable = keys.filter((k) =>
                apiKeyCanWrite({ _apiKey: { scope: String(k.scope || '') } })
            );
            scim = { activeKeys: keys.length, writeKeys: writable.length };
        }
        return { sso, scim };
    }

    async _audit() {
        const row = await this._safe(
            () => db.get('SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM system_logs'),
            null
        );
        const triggers = await this._safe(
            () =>
                db.all(
                    `SELECT tgname FROM pg_trigger
                      WHERE tgrelid = 'public.system_logs'::regclass AND NOT tgisinternal`
                ),
            null
        );
        const names = Array.isArray(triggers) ? triggers.map((t) => String(t.tgname)) : null;
        return {
            entries: row ? Number(row.n) : null,
            oldest: row ? row.oldest || null : null,
            hashChained: names ? names.some((n) => /hashchain/.test(n)) : null,
            immutable: names ? names.some((n) => /immutable/.test(n)) : null,
        };
    }

    /** The whole register, in one read. */
    async register() {
        return {
            generatedAt: new Date().toISOString(),
            modules: await this._modules(),
            retention: await this._retention(),
            access: await this._access(),
            copilot: await this._copilot(),
            identity: await this._identity(),
            audit: await this._audit(),
            categories: DATA_CATEGORIES,
        };
    }

    /**
     * One person's own view. Counts come from DSRService.export — the very
     * export an access request produces — so the page and the formal answer
     * cannot disagree. Confidential categories are listed without a count.
     */
    async forEmployee(employeeId) {
        const id = Number(employeeId);
        const data = await DSRService.export(id);
        const categories = DATA_CATEGORIES.map((c) => ({
            ...c,
            count: c.confidential ? null : countOf(data[c.key]),
            withheld: Boolean(c.confidential),
        }));
        const country = await this._safe(
            () =>
                db.get(
                    `SELECT c.code, c.name, c.dsr_sla_days
                       FROM employees e
                       JOIN sites s ON s.id = e.site_id
                       JOIN countries c ON c.id = s.country_id
                      WHERE e.id = ?`,
                    [id]
                ),
            null
        );
        return {
            categories,
            retentionDays:
                country && country.dsrSlaDays !== null && country.dsrSlaDays !== undefined
                    ? Number(country.dsrSlaDays)
                    : null,
            countryName: country ? country.name || country.code || null : null,
        };
    }
}

const service = new ComplianceRegisterService();
service.EXPORT_META_KEYS = EXPORT_META_KEYS;
service.countOf = countOf;
module.exports = service;
