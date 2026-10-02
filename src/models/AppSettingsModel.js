const PRODUCT = require('../config/product');
const db = require('../config/database');
const { TtlCache } = require('../utils/ttlCache');
const secretBox = require('../utils/secretBox');

/**
 * SECRET SETTINGS. A setting whose key names a credential is encrypted at rest
 * with secretBox (purpose 'app_settings') INSIDE this model: setValue() and
 * update() encrypt, getValue() decrypts, so EmailService and CopilotService
 * read plaintext without knowing. A legacy clear (or v1) value still reads and
 * is re-encrypted to v2 lazily on read (best-effort) and on the next write.
 * Listing methods (findAll / findByCategory) NEVER return the value, only
 * SECRET_MASK when one is set, and a write of SECRET_MASK is refused as
 * "unchanged", so a mask echoed back by a form or a restore can never
 * overwrite the stored secret.
 *
 * Matched by the LAST dot-segment of the key: …password / …secret / …token /
 * …apiKey / …privateKey / …passphrase / …pass (smtpPassword, copilotApiSecret,
 * sso.entra.clientSecret…). SSO values arrive already encrypted by
 * SsoSettingsService; an 'enc:' value is never encrypted twice.
 */
const SECRET_MASK = '••••••••';
const SECRET_PURPOSE = 'app_settings';
const { isSecretKey } = require('../utils/secretSettingKeys');
/**
 * Secrets this MODEL seals and opens. SSO keys are excluded: SsoSettingsService
 * seals them itself and must SEE an undecryptable value as such (it then keeps
 * the provider unconfigured instead of falling back to an older .env value),
 * so they are stored and returned exactly as that service hands them over.
 */
function isManagedSecret(key, type) {
    return isSecretKey(key, type) && !require('../utils/ssoSettingKeys').isSsoSettingKey(key);
}
/** Encrypt a secret value for storage ('' and already-encrypted values pass through). */
function sealSecret(stringValue) {
    const v = stringValue == null ? '' : String(stringValue);
    if (v === '' || secretBox.isEncrypted(v)) return v;
    return secretBox.encrypt(v, SECRET_PURPOSE);
}
const _undecryptableWarned = new Set();

// Settings are read very frequently (e.g. EmailService reads ~5 keys per event,
// ReadinessService reads the threshold per calculation) but change rarely, so
// cache the resolved row per key with a short TTL. Every write busts the cache.
// A cached "absent" setting is stored as null (distinct from an undefined miss).
const settingsCache = new TtlCache(60_000, 200);

/**
 * The settings CATALOG: what each key accepts, and
 * which keys are job-state markers that must never be edited by hand.
 *
 *   min/max/integer  numeric range (checked server-side on every save)
 *   enum             the only accepted values
 *   kind             'url' | 'email' | 'host' | 'hour' | 'dow' — format checks
 *   optional         blank is allowed (the feature is simply off)
 *   readOnly         written by a job, rendered greyed, refused by the form
 *   restart          takes effect at the next service restart (badge)
 *
 * Keys absent here fall back to a rule derived from their NAME (…Hour → 0-23,
 * …Dow → 0-6, …Days → ≥ 0, …Ms → ≥ 1000, …Port → 1-65535, …Url → URL,
 * …Address → e-mail), so a future tunable is never accepted unchecked.
 * The rows themselves are seeded by initializeDefaults or by the owning
 * lot's migration (cycleAutoLock / cycleAutoCloseGraceDays / loginLockoutMinutes).
 */
const CATALOG = {
    readinessThreshold: { min: 0, max: 100 },
    // Wired: the ABSOLUTE session lifetime in hours — read per request
    // by middleware/sessionActivity (SESSION_MAX_HOURS is the fallback).
    sessionTimeout: { min: 1, max: 720, integer: true },
    sessionIdleMinutes: { min: 1, max: 1440, integer: true },
    // Read by middleware/rateLimiter.checkAccountLockout.
    maxLoginAttempts: { min: 1, max: 100, integer: true },
    loginLockoutMinutes: { min: 1, max: 10080, integer: true },
    mfaRequiredForPrivileged: { type: 'boolean' },
    // Migration 162: managers with a local password, and the upgrade grace
    // periods. mfaGraceStartedAt is written once by the migration.
    mfaRequiredForManagers: { type: 'boolean' },
    mfaGraceAdminDays: { min: 0, max: 365, integer: true },
    mfaGraceManagerDays: { min: 0, max: 365, integer: true },
    mfaGraceStartedAt: { readOnly: true },
    // 3.23.19 (S6, migration 152): extra multi-factor acr values, comma list; blank = built-ins only.
    'sso.mfaAcrValues': { optional: true },
    // 3.23.20 (C3, migration 153): help contact (free text) + invitation batch size.
    'sso.helpContact': { optional: true },
    'ssoInvite.batchSize': { min: 1, max: 500, integer: true },
    smtpHost: { kind: 'host', optional: true },
    smtpPort: { min: 1, max: 65535, integer: true },
    smtpFromAddress: { kind: 'email', optional: true },
    // ONE named private/loopback relay may be reached without TLS. Written only
    // by EmailService.setPlaintextRelay (SuperAdmin, mandatory reason, audited),
    // never by the generic settings form.
    smtpPlaintextRelayHost: { readOnly: true },
    smtpPlaintextRelayReason: { readOnly: true },
    smtpPlaintextRelaySetBy: { readOnly: true },
    // Private/loopback AI hosts a SuperAdmin explicitly allows (comma list of
    // host or host:port), and the recorded external-transfer basis.
    copilotAllowedPrivateHosts: { optional: true },
    copilotTransferRecord: { readOnly: true },
    appBaseUrl: { kind: 'url', optional: true },
    invitationExpiryDays: { min: 0, max: 3650, integer: true },
    'onboarding.allowedDomains': { kind: 'domains', optional: true },
    copilotProvider: {
        enum: [
            'none',
            'ollama',
            'openai',
            'anthropic',
            'grok',
            'groq',
            'gemini',
            'mistral',
            'deepseek',
            'openrouter',
            'together',
            'custom',
        ],
    },
    copilotUrl: { kind: 'url', optional: true },
    copilotTimeoutMs: { min: 1000, max: 600000, integer: true },
    copilotAnonymizationMode: { enum: ['always', 'external-only'] },
    // EU AI Act guardrails (CopilotService): named ranking of people is OFF by
    // default; only EU-hosted / on-prem provider presets are allowed by default.
    'copilot.allow_named_person_ranking': { type: 'boolean' },
    'copilot.eu_only_providers': { type: 'boolean' },
    // AI companion (help panel « Assistant » tab) for every signed-in user.
    'companion.enabled': { type: 'boolean' },
    'dispute.l0SlaDays': { min: 0, max: 365, integer: true },
    'dispute.l1SlaDays': { min: 0, max: 365, integer: true },
    'dispute.l2SlaDays': { min: 0, max: 365, integer: true },
    backupHour: { kind: 'hour' },
    backupKeep: { min: 0, max: 3650, integer: true },
    digestDow: { kind: 'dow' },
    digestHour: { kind: 'hour' },
    perfEventsRetentionDays: { min: 0, max: 3650, integer: true },
    notificationRetentionDays: { min: 0, max: 3650, integer: true },
    reminderLogRetentionDays: { min: 0, max: 3650, integer: true },
    cycleAutoLock: { type: 'boolean' },
    // -1 = automatic closing off; 0 = close at the deadline.
    cycleAutoCloseGraceDays: { min: -1, max: 365, integer: true },
    biasZThreshold: { min: 0.5, max: 10 },
    // 3.23.18: retention purge — 'report' (default) never erases anyone.
    retentionPurgeMode: { enum: ['report', 'apply'] },
    nineBoxReassessMonths: { min: 1, max: 60, integer: true },
    // Off = employees never see the 9-box, even a disclosed placement
    // (TalentConfidentialityService.nineBoxVisibleToEmployees). Default on.
    nineBoxVisibleToEmployees: { type: 'boolean' },
    dormantAccountDays: { min: 1, max: 3650, integer: true },
    edition: { enum: ['community'] },
    localContentHomeCountry: { optional: true },
    // ---- Department brief (dept-brief) ------------------------------------
    // Eleven of the fifteen keys need no entry here: `…Hour`, `…Dow`, `…Dom` and
    // `…Days` are covered by the name-derived rules of ruleFor, and
    // `deptBriefLastRunOn` by its `LastRunOn` suffix. Only the four that carry a
    // rule of their own are declared. deptBriefHour is a UTC hour — the brief
    // reads ONE clock for the gate, the bucket and the period bounds.
    deptBriefWeeklyEnabled: { type: 'boolean' },
    deptBriefMonthlyEnabled: { type: 'boolean' },
    deptBriefQuarterlyEnabled: { type: 'boolean' },
    deptBriefYearlyEnabled: { type: 'boolean' },
    deptBriefYearlySendEmpty: { type: 'boolean' },
    deptBriefMaxLines: { min: 3, max: 12, integer: true },
    deptBriefReadRateFloorPct: { min: 0, max: 100, integer: true },
    // Written by the job at its first run and never edited by hand: they are what
    // stops a fresh install back-filling briefs for periods it holds no data for.
    deptBriefSince: { readOnly: true },
    deptBriefDataSince: { readOnly: true },
    // ---- job-state markers: written by jobs, shown read-only ----
    backupLastRunOn: { readOnly: true },
    backupLastStatus: { readOnly: true },
    backupLastFile: { readOnly: true },
    backupLastSize: { readOnly: true },
    certExpiryLastRunOn: { readOnly: true },
    retentionRecomputeLastRunOn: { readOnly: true },
    digestLastSentOn: { readOnly: true },
    personalDigestLastSentOn: { readOnly: true },
    smtpVerifiedAt: { readOnly: true },
    smtpVerifiedBy: { readOnly: true },
    smtpLastFailure: { readOnly: true },
    setupDismissed: { type: 'boolean' },
    // ---- Optional modules and adoption stage (Administration → Modules) ----
    // Written by ModuleService.save (category 'adoption', which the generic
    // settings table does not list). Rows are absent on a fresh install: the
    // stage then reads as 1, or 3 when the legacy V2_FEATURES=1 is set.
    'adoption.stage': { enum: ['1', '2', '3', 'custom'] },
    'modules.campaigns': { type: 'boolean' },
    'modules.development': { type: 'boolean' },
    'modules.talent': { type: 'boolean' },
    'modules.mobility': { type: 'boolean' },
    'modules.engagement': { type: 'boolean' },
    'modules.ai': { type: 'boolean' },
};

const RE = {
    url: /^https?:\/\/[^\s/$.?#][^\s]*$/i,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    host: /^[a-z0-9.-]+$/i,
    domain: /^[a-z0-9.-]+\.[a-z]{2,}$/i,
};

/** The rule for a key: catalog first, then the name-derived fallback. */
function ruleFor(key) {
    const k = String(key || '');
    if (CATALOG[k]) return CATALOG[k];
    if (/LastRunOn$|LastStatus$|LastSentOn$|LastFile$|LastSize$|VerifiedAt$|VerifiedBy$/.test(k))
        return { readOnly: true };
    if (/Hour$/.test(k)) return { kind: 'hour' };
    if (/Dow$/.test(k)) return { kind: 'dow' };
    if (/Dom$/.test(k)) return { min: 1, max: 28, integer: true };
    if (/Days$/.test(k)) return { min: 0, max: 3650, integer: true };
    if (/Ms$/.test(k)) return { min: 1000, max: 3600000, integer: true };
    if (/Port$/.test(k)) return { min: 1, max: 65535, integer: true };
    if (/Url$/.test(k)) return { kind: 'url', optional: true };
    if (/Address$|Email$/.test(k)) return { kind: 'email', optional: true };
    return {};
}

/**
 * Validate a raw form value against the STORED type and the catalog rule.
 * Returns { ok, value } or { ok: false, code, params } where `code` is a
 * `admin:set_err_<code>` locale key — never an English sentence.
 */
function validate(key, storedType, raw) {
    const rule = ruleFor(key);
    if (rule.readOnly) return { ok: false, code: 'readonly', params: { key } };
    const s = raw == null ? '' : String(raw).trim();
    const type = rule.type || storedType || 'string';
    if (type === 'boolean')
        return { ok: true, value: s === 'true' || s === '1' ? 'true' : 'false' };
    if (type === 'json') {
        try {
            JSON.parse(s || 'null');
            return { ok: true, value: s };
        } catch {
            return { ok: false, code: 'json', params: { key } };
        }
    }
    if (rule.enum) {
        return rule.enum.includes(s)
            ? { ok: true, value: s }
            : { ok: false, code: 'enum', params: { key, values: rule.enum.join(', ') } };
    }
    if (
        type === 'number' ||
        rule.kind === 'hour' ||
        rule.kind === 'dow' ||
        rule.min != null ||
        rule.max != null
    ) {
        if (s === '' && rule.optional) return { ok: true, value: '' };
        const n = Number(s);
        if (s === '' || !Number.isFinite(n)) return { ok: false, code: 'number', params: { key } };
        let min = rule.min,
            max = rule.max,
            integer = rule.integer;
        if (rule.kind === 'hour') {
            min = 0;
            max = 23;
            integer = true;
        }
        if (rule.kind === 'dow') {
            min = 0;
            max = 6;
            integer = true;
        }
        if (integer && !Number.isInteger(n))
            return { ok: false, code: 'integer', params: { key, min, max } };
        if ((min != null && n < min) || (max != null && n > max))
            return {
                ok: false,
                code: 'range',
                params: { key, min: min != null ? min : '−∞', max: max != null ? max : '+∞' },
            };
        return { ok: true, value: String(n) };
    }
    if (s === '' && rule.optional) return { ok: true, value: '' };
    if (rule.kind === 'url' && !RE.url.test(s)) return { ok: false, code: 'url', params: { key } };
    if (rule.kind === 'email' && !RE.email.test(s))
        return { ok: false, code: 'email', params: { key } };
    if (rule.kind === 'host' && !RE.host.test(s))
        return { ok: false, code: 'host', params: { key } };
    if (rule.kind === 'domains' && s && !s.split(',').every((d) => RE.domain.test(d.trim())))
        return { ok: false, code: 'domains', params: { key } };
    return { ok: true, value: s };
}

class AppSettingsModel {
    /** Boolean value of a setting input: true/1/'true'/'1'/'on'/'yes' only. */
    static toBool(value) {
        if (typeof value === 'string') {
            return ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase());
        }
        return value === true || value === 1;
    }

    get CATALOG() {
        return CATALOG;
    }
    ruleFor(key) {
        return ruleFor(key);
    }
    validate(key, storedType, raw) {
        return validate(key, storedType, raw);
    }
    isReadOnly(key) {
        return Boolean(ruleFor(key).readOnly);
    }
    get SECRET_MASK() {
        return SECRET_MASK;
    }
    isSecretKey(key, type) {
        return isSecretKey(key, type);
    }

    /**
     * A settings row safe to hand to a view or an export: a secret's value is
     * replaced by SECRET_MASK (set) or '' (not set), and `secretSet` says which.
     */
    maskRow(row) {
        if (
            !row ||
            !(
                isSecretKey(row.settingKey, row.settingType) ||
                secretBox.isEncrypted(row.settingValue)
            )
        )
            return row;
        const set = row.settingValue != null && String(row.settingValue) !== '';
        return { ...row, settingValue: set ? SECRET_MASK : '', isSecret: true, secretSet: set };
    }

    async findAll() {
        // Attribution: who last changed each row, for the "Modifié le · par" column.
        const rows = await db.all(
            `SELECT s.*, a.username AS updatedByUsername
               FROM appSettings s LEFT JOIN admins a ON a.id = s.updatedBy
              ORDER BY s.category, s.settingKey`
        );
        return (rows || []).map((r) => this.maskRow(r));
    }

    /** RAW row (a secret is still sealed): internal use; never render it. */
    async findByKey(key) {
        return await db.get('SELECT * FROM appSettings WHERE settingKey = ?', [key]);
    }

    async findByCategory(category) {
        const rows = await db.all(
            'SELECT * FROM appSettings WHERE category = ? ORDER BY settingKey',
            [category]
        );
        return (rows || []).map((r) => this.maskRow(r));
    }

    /**
     * The plaintext of a stored secret value. Undecryptable (APP_KEY changed)
     * gives null, warned once per key, never thrown into the caller.
     */
    _openSecret(key, raw) {
        if (raw == null || raw === '') return raw;
        try {
            return secretBox.decrypt(String(raw));
        } catch (e) {
            if (!_undecryptableWarned.has(key)) {
                _undecryptableWarned.add(key);
                console.warn(
                    `[security] app setting ${key} is stored encrypted but cannot be decrypted (${e.code || e.message}). ` +
                        'Treated as unset until it is re-entered, or run scripts/rotate-app-key.js with the old key.'
                );
            }
            return null;
        }
    }

    /** Lazy re-encryption: a secret still stored clear or v1 is resealed as v2 (best-effort). */
    async _upgradeSecretAtRest(setting, plain) {
        try {
            if (plain == null || plain === '' || !secretBox.isEnabled()) return;
            if (!secretBox.needsUpgrade(setting.settingValue)) return;
            const sealed = secretBox.encrypt(String(plain), SECRET_PURPOSE);
            await db.run(
                'UPDATE appSettings SET settingValue = ? WHERE settingKey = ? AND settingValue = ?',
                [sealed, setting.settingKey, setting.settingValue]
            );
            settingsCache.bust();
        } catch (_) {
            /* best-effort: the next write re-encrypts anyway */
        }
    }

    async getValue(key, defaultValue = null) {
        let setting = settingsCache.get(key);
        if (setting === undefined) {
            // cache miss (not yet cached / expired)
            setting = await this.findByKey(key);
            settingsCache.set(key, setting || null); // null sentinel for "absent"
        }
        if (!setting) return defaultValue;

        if (isManagedSecret(setting.settingKey || key, setting.settingType)) {
            const plain = this._openSecret(key, setting.settingValue);
            await this._upgradeSecretAtRest(setting, plain);
            if (plain == null) return defaultValue;
            setting = { ...setting, settingValue: plain };
        }

        switch (setting.settingType) {
            case 'number': {
                // Don't use `|| defaultValue`: a legitimately-stored 0 (e.g.
                // "retention = 0 → keep forever") is falsy and would be lost.
                const n = parseFloat(setting.settingValue);
                return Number.isNaN(n) ? defaultValue : n;
            }
            case 'boolean':
                return setting.settingValue === 'true' || setting.settingValue === '1';
            case 'json':
                try {
                    return JSON.parse(setting.settingValue);
                } catch {
                    return defaultValue;
                }
            default:
                return setting.settingValue || defaultValue;
        }
    }

    async setValue(
        key,
        value,
        type = 'string',
        description = null,
        category = 'general',
        updatedBy = null
    ) {
        let stringValue;
        if (type === 'json') {
            stringValue = JSON.stringify(value);
        } else if (type === 'boolean') {
            // Strings are parsed, not tested for truthiness: 'false' and '0' are
            // non-empty strings, so `value ? …` stored them as 'true' and every
            // boolean default meant to be OFF (open signup, named AI ranking…)
            // was seeded ON (fixed in migration 159).
            stringValue = AppSettingsModel.toBool(value) ? 'true' : 'false';
        } else {
            stringValue = String(value);
        }

        const existing = await this.findByKey(key);
        if (isSecretKey(key, type) && stringValue === SECRET_MASK) {
            // The mask is what a listing shows, never a value: echoing it back
            // (a form, an import, a restore) leaves the stored secret untouched.
            if (existing) return;
            stringValue = '';
        }
        if (isManagedSecret(key, type)) stringValue = sealSecret(stringValue);
        if (existing) {
            await db.run(
                'UPDATE appSettings SET settingValue = ?, settingType = ?, description = ?, category = ?, updatedBy = ?, updatedAt = CURRENT_TIMESTAMP WHERE settingKey = ?',
                [stringValue, type, description, category, updatedBy, key]
            );
        } else {
            await db.run(
                'INSERT INTO appSettings (settingKey, settingValue, settingType, description, category, updatedBy) VALUES (?, ?, ?, ?, ?, ?)',
                [key, stringValue, type, description, category, updatedBy]
            );
        }
        settingsCache.bust(); // a setting changed — drop the read cache
    }

    async update(data) {
        const { id, settingType, description, category, updatedBy } = data;
        let { settingValue } = data;
        // The key decides whether the value is a secret: taken from the ROW,
        // never trusted from the caller alone.
        let key = data.settingKey;
        try {
            const row = await db.get('SELECT settingKey FROM appSettings WHERE id = ?', [id]);
            if (row && row.settingKey) key = row.settingKey;
        } catch (_) {
            /* fall back to the caller's key */
        }
        if (
            isSecretKey(key, settingType) &&
            String(settingValue == null ? '' : settingValue) === SECRET_MASK
        )
            return; // a mask is never a value (see setValue)
        if (isManagedSecret(key, settingType)) settingValue = sealSecret(settingValue);
        await db.run(
            'UPDATE appSettings SET settingValue = ?, settingType = ?, description = ?, category = ?, updatedBy = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?',
            [settingValue, settingType, description, category, updatedBy, id]
        );
        settingsCache.bust(); // a setting changed — drop the read cache
    }

    async initializeDefaults() {
        // Initialize default settings if they don't exist
        const defaults = [
            {
                key: 'readinessThreshold',
                value: '80',
                type: 'number',
                description:
                    'Minimum readiness percentage required for an employee to be considered ready (0-100)',
                category: 'readiness',
            },
            {
                key: 'nineBoxVisibleToEmployees',
                value: 'true',
                type: 'boolean',
                description:
                    'Show employees their own 9-box placement once it has been disclosed to them. Off: the 9-box is hidden from every employee page.',
                category: 'readiness',
            },
            {
                key: 'appName',
                value: PRODUCT.name,
                type: 'string',
                description: 'Application name displayed in the header and page titles',
                category: 'general',
            },
            {
                key: 'sessionTimeout',
                // 12 h by default (ASVS 3.3.2). Seeded only when absent: an
                // upgraded install keeps its row (migration 162 moves only the
                // untouched old default).
                value: String(Number(process.env.SESSION_MAX_HOURS) || 12),
                type: 'number',
                description:
                    'Absolute session lifetime in hours — a session older than this is signed out even while active (applies to new requests immediately; SESSION_MAX_HOURS is the fallback)',
                category: 'security',
            },
            {
                key: 'enableEmailNotifications',
                value: 'false',
                type: 'boolean',
                description:
                    'Master switch — send emails when system actions occur (workflow, validation, talent actions, etc.)',
                category: 'notifications',
            },
            // ---- SMTP server configuration (category: email) ----
            {
                key: 'smtpHost',
                value: '',
                type: 'string',
                description:
                    'SMTP server hostname (e.g. smtp.office365.com). Leave blank to disable email.',
                category: 'email',
            },
            {
                key: 'smtpPort',
                value: '587',
                type: 'number',
                description: 'SMTP server port (587 for STARTTLS, 465 for SSL/TLS, 25 for relay)',
                category: 'email',
            },
            {
                key: 'smtpSecure',
                value: 'false',
                type: 'boolean',
                description:
                    'Use implicit SSL/TLS (enable for port 465; leave off for 587 STARTTLS)',
                category: 'email',
            },
            {
                key: 'smtpUser',
                value: '',
                type: 'string',
                description:
                    'SMTP username for authentication (leave blank for unauthenticated relay)',
                category: 'email',
            },
            {
                key: 'smtpPassword',
                value: '',
                type: 'string',
                description:
                    'SMTP password / app password (stored server-side; hidden in this list)',
                category: 'email',
            },
            {
                key: 'smtpFromName',
                value: PRODUCT.name,
                type: 'string',
                description: 'Display name shown on outgoing emails',
                category: 'email',
            },
            {
                key: 'smtpFromAddress',
                value: '',
                type: 'string',
                description: 'From address for outgoing emails (e.g. no-reply@yourcompany.com)',
                category: 'email',
            },
            // ---- Per-domain email triggers (category: emailEvents) ----
            {
                key: 'emailOnWorkflow',
                value: 'true',
                type: 'boolean',
                description:
                    'Email on workflow events (self-assessment submitted / approved / rejected / changes requested)',
                category: 'emailEvents',
            },
            {
                key: 'emailOnValidation',
                value: 'true',
                type: 'boolean',
                description:
                    'Email on validation events (maker-checker submitted / approved / rejected)',
                category: 'emailEvents',
            },
            {
                key: 'emailOnTalentActions',
                value: 'true',
                type: 'boolean',
                description: 'Email on talent actions (PIP, IDP, 9-box placement)',
                category: 'emailEvents',
            },
            {
                key: 'emailOnCoaching',
                value: 'true',
                type: 'boolean',
                description: 'Email on coaching plan events (created / completed)',
                category: 'emailEvents',
            },
            {
                key: 'emailOnLifecycle',
                value: 'true',
                type: 'boolean',
                description:
                    'Email on lifecycle events (joiner / mover / leaver, cycle open / close)',
                category: 'emailEvents',
            },
            {
                key: 'emailOnAuth',
                value: 'false',
                type: 'boolean',
                description:
                    'Email on account/security events (new admin account, password changes)',
                category: 'emailEvents',
            },
            {
                key: 'maxLoginAttempts',
                value: '5',
                type: 'number',
                description:
                    'Failed login attempts before the account is locked (read by the login lockout check; LOGIN_RATE_LIMIT is the fallback)',
                category: 'security',
            },
            // ---- Self-service onboarding (category: onboarding) ----
            {
                key: 'onboarding.enabled',
                value: 'false',
                type: 'boolean',
                description:
                    'Master switch — allow people to self-onboard (they wait in a queue until an admin places them into the org).',
                category: 'onboarding',
            },
            {
                key: 'onboarding.allowSso',
                value: 'false',
                type: 'boolean',
                description:
                    'Auto-create a pending onboarding request when someone signs in via SSO but has no account yet.',
                category: 'onboarding',
            },
            {
                key: 'onboarding.allowSignup',
                value: 'false',
                type: 'boolean',
                description:
                    'Show a public "Create account" page where anyone can register (email + password) and land in the onboarding queue.',
                category: 'onboarding',
            },
            {
                key: 'onboarding.allowedDomains',
                value: '',
                type: 'string',
                description:
                    'Optional comma-separated email domains allowed to self-onboard (e.g. acme.com,acme.org). Blank = any domain (only if Allow open signup is on).',
                category: 'onboarding',
            },
            {
                key: 'onboarding.allowOpenSignup',
                value: 'false',
                type: 'boolean',
                description:
                    'Explicitly accept open signup from ANY email domain. Required when Allowed domains is blank; off by default so a fresh install cannot accidentally accept registrations from anyone.',
                category: 'onboarding',
            },
            // `assessmentHistoryRetention` used to be listed here (365 days) but NOTHING
            // ever read it: assessment_history is append-only by database trigger
            // (trg_assessment_history_immutable + the TRUNCATE guard of migration 101),
            // so it cannot be pruned by row deletes and no job attempts to. A retention
            // number that enforces nothing is a policy presented as enforced — it is
            // deliberately NOT implemented (a prune would fight the immutability
            // trigger) and the setting is removed instead; migration 101 deletes the
            // stored row so the settings screen stops displaying it.
            // ---- Talent copilot LLM connection (category: copilot) ----
            // Every practical connection type is supported via the provider switch;
            // when provider is "none" the copilot answers deterministically (no LLM).
            {
                key: 'copilotProvider',
                value: 'none',
                type: 'string',
                description:
                    'LLM connection: none (deterministic, no LLM) | ollama (local, sovereign) | a NAMED cloud engine — mistral (EU), openai, anthropic, grok (xAI), groq, gemini (Google), deepseek, openrouter, together — where only the API key is required (endpoint + default model auto-fill; no preset defaults to a free tier, whose terms may allow training on your prompts) | custom (generic completions: POST {model,prompt}). RESIDENCY: while copilot.eu_only_providers is on (default), a non-EU preset is refused and the copilot answers with the built-in engine. PRIVACY: external engines only ever receive PSEUDONYMIZED data (names replaced by EMP-nnn tokens; answers de-tokenized); full data goes only to internal/trusted AI servers. Every external call is audited (COPILOT_QUERY_EGRESS).',
                category: 'copilot',
            },
            {
                key: 'copilotTrustedHosts',
                value: '',
                type: 'string',
                description:
                    'Comma-separated hostnames classified as INTERNAL AI servers — e.g. ai.mycompany.com. Localhost, *.local/*.lan/*.internal/*.corp and private-IP targets are internal automatically. Whether internal servers receive full or anonymized data is governed by copilotAnonymizationMode; EXTERNAL targets always receive anonymized data.',
                category: 'copilot',
            },
            {
                key: 'copilotAllowedPrivateHosts',
                value: '',
                type: 'string',
                description:
                    'Private, loopback or link-local AI hosts the copilot may call (comma list: host or host:port, e.g. localhost:11434, llm.lan). Hosts listed in copilotTrustedHosts are allowed too. Blank = none: every other private target is refused. Plain http is accepted only for a LOOPBACK host listed here and only without an API key.',
                category: 'copilot',
            },
            {
                key: 'copilotAnonymizationMode',
                value: 'always',
                type: 'string',
                description:
                    'Cipher/decipher scope: "always" (default — EVERY AI request, internal AND external, carries only anonymized data: personal names + site/department/service/role/org identities replaced with per-request randomized tokens, answers deciphered back) | "external-only" (proven-internal AI servers receive full data). External targets are ALWAYS anonymized regardless of this setting.',
                category: 'copilot',
            },
            {
                key: 'copilotAnonymizeSkills',
                value: '0',
                type: 'boolean',
                description:
                    'Strict mode: also cipher SKILL names in AI requests (hides the capability map, e.g. which certifications the org tracks). Default off — skill names are generic and keeping them makes answers more useful.',
                category: 'copilot',
            },
            {
                key: 'copilot.allow_named_person_ranking',
                value: 'false',
                type: 'boolean',
                description:
                    'EU AI Act guardrail. Off (default): the copilot never ranks or names individual people (flight-risk lists, "who needs development", weakest/strongest, open PIPs by name) — it answers with aggregates, and named lists are withheld from any AI model. On: named answers are allowed; every answer still carries the "decision support only" label.',
                category: 'copilot',
            },
            {
                key: 'copilot.eu_only_providers',
                value: 'true',
                type: 'boolean',
                description:
                    "Data residency. On (default): only on-prem (ollama) and EU-hosted (mistral) provider presets may be used; a non-EU preset (openai, anthropic, grok, groq, gemini, deepseek, openrouter, together) is refused and the copilot answers with the built-in engine. A custom or overridden endpoint URL is the administrator's declared choice.",
                category: 'copilot',
            },
            {
                key: 'companion.enabled',
                value: 'true',
                type: 'boolean',
                description:
                    'AI companion. On (default): every signed-in user gets the « Assistant » tab in the help panel — how-to answers from the built-in product guide, their own next actions, page and concept explanations; managers/admins can ask data questions through the copilot. Works with no language model. When the copilot LLM is configured and allowed, it may rephrase product-guide answers (it never receives personal data). Off: the tab and its API are removed.',
                category: 'copilot',
            },
            {
                key: 'invitationExpiryDays',
                value: '14',
                type: 'number',
                description:
                    'Days an invitation temporary password stays valid when the person has NEVER signed in. After expiry the login is refused ("invitation expired — contact your administrator") and the Invitations console flags the row for re-invite. 0 = invitations never expire.',
                category: 'onboarding',
            },
            {
                key: 'copilotUrl',
                value: '',
                type: 'string',
                description:
                    'Endpoint URL — leave BLANK for any named provider (ollama/openai/anthropic/grok/groq/gemini/mistral/deepseek/openrouter/together) to use its default endpoint. Set it only to override (Azure OpenAI, LM Studio, vLLM, a LAN Ollama host, custom gateways).',
                category: 'copilot',
            },
            {
                key: 'copilotModel',
                value: 'llama3.1',
                type: 'string',
                description:
                    'Model name sent to the endpoint. Leave the default for a named cloud provider to use its default model (e.g. mistral → mistral-small-latest, grok → grok-3-mini, gemini → gemini-2.0-flash, groq → llama-3.3-70b-versatile). Override for a specific model — note that free-tier models (e.g. OpenRouter ":free") may allow the provider to train on your prompts.',
                category: 'copilot',
            },
            {
                key: 'copilotApiSecret',
                value: '',
                type: 'string',
                description:
                    'API key when the endpoint requires one (sent as Authorization: Bearer + api-key + x-api-key, so OpenAI, Azure and Anthropic all work). Leave blank for local engines like Ollama. Stored server-side, never displayed.',
                category: 'copilot',
            },
            {
                key: 'copilotTimeoutMs',
                value: '20000',
                type: 'number',
                description:
                    'Abort an LLM call after this many milliseconds and fall back to the deterministic engine',
                category: 'copilot',
            },
            // ---- Scheduled jobs (category: jobs) — runtime-tunable, no restart.
            // Defaults are seeded FROM the matching env var when one is set, so an
            // install tuned via .env keeps its behaviour when these settings appear.
            {
                key: 'backupHour',
                value: String(Number(process.env.BACKUP_HOUR) || 2),
                type: 'number',
                description:
                    'Hour of day (0-23, server time) after which the daily database backup runs',
                category: 'jobs',
            },
            {
                key: 'backupKeep',
                value: String(Number(process.env.BACKUP_KEEP) || 14),
                type: 'number',
                description:
                    'How many daily backup files to keep, newest first (older ones are deleted). 0 = keep all (no pruning).',
                category: 'jobs',
            },
            {
                key: 'digestDow',
                value: String(Number(process.env.DIGEST_DOW) || 1),
                type: 'number',
                description:
                    'Day of week the manager digest is sent (0=Sunday … 6=Saturday; default 1=Monday)',
                category: 'jobs',
            },
            {
                key: 'digestHour',
                value: String(Number(process.env.DIGEST_HOUR) || 7),
                type: 'number',
                description:
                    'Hour of day (0-23, server time) after which the weekly manager digest is sent',
                category: 'jobs',
            },
            // ---- Department brief (dept-brief.tick, category: jobs) ----------
            // Category MUST be 'jobs': views/pages/app-settings/index.ejs:25-31
            // carries a hard-coded whitelist of categories, and a setting filed
            // anywhere else (in 'ops', for instance, which does exist in the
            // database) is loaded, validated… and never displayed.
            // initializeDefaults never overwrites an existing row, so changing
            // one of these defaults after a deployment takes a migration.
            {
                key: 'deptBriefWeeklyEnabled',
                value: 'true',
                type: 'boolean',
                description:
                    'Send the WEEKLY department brief. Off by default for employees who already receive the Monday manager digest, and for SuperAdmins; on for scoped admins, who receive no weekly message today. Each person can override it under My account → Notifications.',
                category: 'jobs',
            },
            {
                key: 'deptBriefMonthlyEnabled',
                value: 'true',
                type: 'boolean',
                description:
                    'Send the MONTHLY department brief (in-app and, when the digest e-mail category is on, by e-mail)',
                category: 'jobs',
            },
            {
                key: 'deptBriefQuarterlyEnabled',
                value: 'true',
                type: 'boolean',
                description: 'Send the QUARTERLY department brief over the closed calendar quarter',
                category: 'jobs',
            },
            {
                key: 'deptBriefYearlyEnabled',
                value: 'true',
                type: 'boolean',
                description: 'Send the YEARLY department brief over the closed calendar year',
                category: 'jobs',
            },
            {
                key: 'deptBriefYearlySendEmpty',
                value: 'true',
                type: 'boolean',
                description:
                    'Send the YEARLY brief even when it has nothing to report (the other cadences stay silent when there is nothing to say; the archive row is written either way)',
                category: 'jobs',
            },
            {
                key: 'deptBriefHour',
                value: '7',
                type: 'number',
                description:
                    'Hour (0-23, UTC — not server time) at or after which a closed period is sent. The brief reads one clock for the gate, the period bucket and the period bounds.',
                category: 'jobs',
            },
            {
                key: 'deptBriefWeeklyDow',
                value: '1',
                type: 'number',
                description:
                    'Day of week the weekly brief goes out (0=Sunday … 6=Saturday; default 1=Monday, the day the week closes)',
                category: 'jobs',
            },
            {
                key: 'deptBriefMonthlyDom',
                value: '1',
                type: 'number',
                description:
                    'Day of month (1-28) the monthly brief goes out, counted from the first day of the new month',
                category: 'jobs',
            },
            {
                key: 'deptBriefQuarterlyDom',
                value: '1',
                type: 'number',
                description:
                    'Day (1-28) of the first month of the new quarter on which the quarterly brief goes out',
                category: 'jobs',
            },
            {
                key: 'deptBriefYearlyDom',
                value: '1',
                type: 'number',
                description: 'Day (1-28) of January on which the yearly brief goes out',
                category: 'jobs',
            },
            {
                key: 'deptBriefReviewSlaDays',
                value: '5',
                type: 'number',
                description:
                    'Days after which a self-assessment waiting for review is reported as overdue in the brief',
                category: 'jobs',
            },
            {
                key: 'deptBriefMaxLines',
                value: '7',
                type: 'number',
                description:
                    'Maximum number of action lines in one brief (3-12). Past it the brief says "+N other actions" and links to the full page.',
                category: 'jobs',
            },
            {
                key: 'deptBriefReadRateFloorPct',
                value: '20',
                type: 'number',
                description:
                    'Read-rate floor (%) for a cadence. After two full periods below it, that cadence is switched off by default rather than reworked — a notification that cannot be stopped on evidence is irreversible.',
                category: 'jobs',
            },
            {
                key: 'deptBriefLastRunOn',
                value: '',
                type: 'string',
                description:
                    'Last date the department-brief tick ran (written by the job, display only — the exactly-once ledger is the dept_briefs table, never this value)',
                category: 'jobs',
            },
            {
                key: 'deptBriefSince',
                value: '',
                type: 'string',
                description:
                    'Date the department brief was switched on (written at the first run). A period that starts before it is flagged as PARTIAL and publishes no change figures.',
                category: 'jobs',
            },
            {
                key: 'deptBriefDataSince',
                value: '',
                type: 'string',
                description:
                    'Earliest usable performance-action date (written at the first run). Same role as deptBriefSince: it stops a fresh install presenting an empty past as a decline.',
                category: 'jobs',
            },
            {
                key: 'perfEventsRetentionDays',
                value: String(Number(process.env.PERF_EVENTS_RETENTION_DAYS) || 30),
                type: 'number',
                description:
                    'Days to keep performance telemetry (perf_events) before pruning; 0 = keep forever. Audit logs are never pruned.',
                category: 'jobs',
            },
            {
                key: 'notificationRetentionDays',
                value: String(Number(process.env.NOTIFICATION_RETENTION_DAYS) || 120),
                type: 'number',
                description:
                    'Days to keep READ in-app notifications before pruning; 0 = keep forever',
                category: 'jobs',
            },
            {
                // Read by jobs/telemetry-prune.js alongside the two above; it was the
                // only retention window the job read that had no setting to be read from.
                key: 'reminderLogRetentionDays',
                value: String(Number(process.env.REMINDER_LOG_RETENTION_DAYS) || 180),
                type: 'number',
                description:
                    'Days to keep the reminder ledger (reminder_log: one row per nudge sent) before pruning; 0 = keep forever. Audit logs are never pruned.',
                category: 'jobs',
            },
            {
                key: 'sessionIdleMinutes',
                // 30 min by default (ASVS 3.3.2).
                value: String(Number(process.env.SESSION_IDLE_MINUTES) || 30),
                type: 'number',
                description:
                    'Sign users out after this many minutes of inactivity (applies to admins and employees; takes effect immediately)',
                category: 'security',
            },
            // Two-factor policy. Same rows as migration 162 (insert-if-absent, so
            // the migration's values always win). The grace start
            // (mfaGraceStartedAt) is deliberately NOT seeded here: it is the
            // migration's own first-run marker, and an empty row written before
            // the migration would cancel the upgrade grace period.
            {
                key: 'mfaRequiredForPrivileged',
                value: 'true',
                type: 'boolean',
                description:
                    'Require two-factor authentication for every administrator role (HR-wide viewers included). Upgrades: grace period of mfaGraceAdminDays from the upgrade, then enrolment is forced.',
                category: 'security',
            },
            {
                key: 'mfaRequiredForManagers',
                value: 'true',
                type: 'boolean',
                description:
                    "Require two-factor authentication for managers who sign in with a local password (managers signing in through SSO use their organisation's MFA). Upgrades: grace period of mfaGraceManagerDays.",
                category: 'security',
            },
            {
                key: 'mfaGraceAdminDays',
                value: '14',
                type: 'number',
                description:
                    'Upgrade grace period (days) before two-factor enrolment is forced for administrators.',
                category: 'security',
            },
            {
                key: 'mfaGraceManagerDays',
                value: '30',
                type: 'number',
                description:
                    'Upgrade grace period (days) before two-factor enrolment is forced for managers with a local password.',
                category: 'security',
            },
            {
                key: 'biasZThreshold',
                value: String(Number(process.env.BIAS_Z_THRESHOLD) || 2.0),
                type: 'number',
                description:
                    'Z-score beyond which a 9-box rating pattern raises a bias alert (higher = fewer, stronger alerts)',
                category: 'modules',
            },
            // ---- White-label branding (category: branding) — managed via the
            // dedicated Branding panel (not the generic settings table: the logo
            // values are data-URLs). appName (category general) is the display name.
            {
                key: 'brandLogo',
                value: '',
                type: 'string',
                description:
                    'Company logo (data-URL) shown in the sidebar, on the login page and as favicon fallback',
                category: 'branding',
            },
            {
                key: 'brandFavicon',
                value: '',
                type: 'string',
                description: 'Browser-tab icon (data-URL); falls back to the logo',
                category: 'branding',
            },
            {
                key: 'brandAccentColor',
                value: '',
                type: 'string',
                description: 'Brand accent color (hex) replacing the default gold across the UI',
                category: 'branding',
            },
            {
                // The line printed under the product name on /about. It is a
                // SETTING, not an `if (edition === ...)`, so a fork can change
                // it by data alone.
                key: 'legalNotice',
                value: require('../config/product').legalNotice,
                type: 'string',
                description:
                    'Legal line shown on the About page (confidentiality notice, or licence attribution)',
                category: 'branding',
            },
            {
                key: 'brandTagline',
                value: '',
                type: 'string',
                description: 'Login-page tagline (blank = default subtitle)',
                category: 'branding',
            },
            {
                // Which visual identity the charts draw from. Like legalNotice
                // this is DATA: src/utils/branding.js turns this value into the
                // `--chart-*` custom properties that public/js/chart-theme.js
                // reads, and no chart, view or controller ever branches on it.
                // Blank or unknown → 'community', the stock IDevelop CE look.
                key: 'edition',
                value: 'community',
                type: 'string',
                description:
                    "Chart identity row (src/utils/branding.js CHART_IDENTITY): 'community'",
                category: 'branding',
            },
        ];

        for (const setting of defaults) {
            const existing = await this.findByKey(setting.key);
            if (!existing) {
                await this.setValue(
                    setting.key,
                    setting.value,
                    setting.type,
                    setting.description,
                    setting.category,
                    null
                );
            }
        }
    }
}

module.exports = new AppSettingsModel();
