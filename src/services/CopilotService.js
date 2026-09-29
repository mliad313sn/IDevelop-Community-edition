'use strict';

/**
 * CopilotService — a SOVEREIGN, on-prem talent copilot. It answers questions
 * about the talent data, scoped strictly to the asker's RBAC clearance (reuses
 * getFilteredEmployees, like the Power BI feeds), so it can never reveal data
 * the user isn't allowed to see.
 *
 * Two modes:
 *  - With an LLM configured (App Settings → copilot, or legacy LLM_URL env):
 *    retrieves the scoped context, prompts the model, returns its answer.
 *  - WITHOUT any LLM (default): a deterministic retrieval answer routed by intent.
 *
 * DATA EGRESS & ANONYMIZATION (cipher/decipher — AnonymizationService):
 * by default EVERY AI request, internal or external, carries only CIPHERED
 * data — personal identifiers (employee names + parts) AND company
 * identifiers (site/department/service/role names, org identity; skills in
 * strict mode) are replaced with per-request RANDOMIZED tokens (EMP-xxxx,
 * SITE-xxxx, …) in both the context and the question; the model answers in
 * tokens and a decipher pass rebuilds the real values before the user sees
 * the answer. 'external-only' mode may relax internal/trusted servers to
 * full data; EXTERNAL targets are ciphered UNCONDITIONALLY. Classification
 * is FAIL-CLOSED (unprovable = external = ciphered). EVERY query is AUDITED —
 * external calls as COPILOT_QUERY_EGRESS, internal-model and deterministic
 * answers as COPILOT_QUERY — with provider/model, egress flag, per-class cipher
 * counts, a SHA-256 of the question and the answer length (never raw text).
 *
 * EU AI ACT GUARDRAILS (employment is a high-risk domain — Annex III §4):
 *  - Transparency: every answer carries `disclaimer` ("AI-generated — decision
 *    support only; a person makes the decision"), translated by the route and
 *    shown next to the answer in the UI.
 *  - No automated ranking of people by default: intents that rank or name
 *    individuals (flight-risk lists, "who needs development", weakest/strongest,
 *    open PIPs by name) answer with aggregates unless the super admin switches on
 *    `copilot.allow_named_person_ranking` (default OFF). The named lists are also
 *    stripped from the context an LLM receives, so a model cannot name them either.
 *  - Data residency: provider presets carry `region` / `euHosted`; with
 *    `copilot.eu_only_providers` (default ON) a non-EU preset is refused and the
 *    copilot falls back to the built-in engine — nothing leaves the box.
 *  - Human oversight: the audit record of each query states that the answer was
 *    shown as decision support, whether it was about people, and whether named
 *    ranking was allowed or withheld.
 */
const db = require('../config/database');
const RBACService = require('./RBACService');
const LogService = require('./LogService');

/**
 * Turnkey provider presets — pick a provider by NAME in Settings, paste an API
 * key, done: the endpoint URL and a sensible default model are filled in
 * automatically (both still overridable via copilotUrl / copilotModel).
 *
 * `style` selects the request/response wire format in _providerRequest:
 * almost every engine (incl. the free tiers of Grok/xAI, Groq, Google Gemini,
 * Mistral, DeepSeek, OpenRouter, Together) speaks the OpenAI chat-completions
 * dialect; Anthropic and Ollama keep their native formats.
 *
 * DATA EGRESS: every one of these except ollama is a THIRD-PARTY cloud —
 * copilot questions send RBAC-scoped talent context (names, risk, PIP status)
 * to that provider, and each call is audited as COPILOT_QUERY_EGRESS.
 *
 * DATA RESIDENCY: `region` is where the stock endpoint processes the request
 * ('local' = on the appliance, 'eu', 'us', 'cn'); `euHosted` is true only for
 * 'local' and 'eu'. With `copilot.eu_only_providers` on (the default) a preset
 * whose `euHosted` is false is refused. `trainsOnData` flags providers whose
 * free tier / default terms allow prompts to be used for model training: no
 * preset defaults to a free-tier model, so choosing one is a deliberate act.
 * The guard applies to a preset's STOCK endpoint; an overridden copilotUrl (e.g.
 * an EU-region Azure OpenAI deployment, or a LAN gateway) is the administrator's
 * declared choice and is audited like every call.
 */
const PROVIDER_PRESETS = {
    ollama: {
        style: 'ollama',
        url: 'http://localhost:11434/api/generate',
        model: 'llama3.1',
        region: 'local',
        euHosted: true,
        trainsOnData: false,
    },
    openai: {
        style: 'openai',
        url: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
        region: 'us',
        euHosted: false,
        trainsOnData: false,
    },
    anthropic: {
        style: 'anthropic',
        url: 'https://api.anthropic.com/v1/messages',
        model: 'claude-haiku-4-5',
        region: 'us',
        euHosted: false,
        trainsOnData: false,
    },
    grok: {
        style: 'openai',
        url: 'https://api.x.ai/v1/chat/completions',
        model: 'grok-3-mini',
        region: 'us',
        euHosted: false,
        trainsOnData: false,
    },
    groq: {
        style: 'openai',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'llama-3.3-70b-versatile',
        region: 'us',
        euHosted: false,
        trainsOnData: false,
    },
    gemini: {
        style: 'openai',
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        model: 'gemini-2.0-flash',
        region: 'us',
        euHosted: false,
        // Gemini API free tier: prompts may be used to improve Google products.
        trainsOnData: true,
    },
    mistral: {
        style: 'openai',
        url: 'https://api.mistral.ai/v1/chat/completions',
        model: 'mistral-small-latest',
        region: 'eu',
        euHosted: true,
        trainsOnData: false,
    },
    deepseek: {
        style: 'openai',
        url: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-chat',
        region: 'cn',
        euHosted: false,
        trainsOnData: true,
    },
    openrouter: {
        style: 'openai',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        // Was the ':free' variant, whose upstream hosts may log and train on
        // prompts. A free-tier model is never the default any more.
        model: 'meta-llama/llama-3.3-70b-instruct',
        region: 'us',
        euHosted: false,
        trainsOnData: true,
    },
    together: {
        style: 'openai',
        url: 'https://api.together.xyz/v1/chat/completions',
        // Was the '-Free' endpoint; never default to a free tier (see above).
        model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        region: 'us',
        euHosted: false,
        trainsOnData: false,
    },
};
// Spelling/branding aliases so a reasonable entry still resolves.
const PROVIDER_ALIASES = {
    grock: 'grok',
    xai: 'grok',
    google: 'gemini',
    'google-gemini': 'gemini',
    claude: 'anthropic',
    chatgpt: 'openai',
};

/** Private/loopback/link-local IP test — shared by the SSRF guard and the
 *  internal-target classifier of the privacy filter. */
function isPrivateIp(ip) {
    if (/^(127\.|0\.|10\.|169\.254\.|192\.168\.)/.test(ip)) return true;
    const m = /^172\.(\d+)\./.exec(ip);
    if (m && +m[1] >= 16 && +m[1] <= 31) return true;
    const l = String(ip).toLowerCase();
    return (
        l === '::1' ||
        l === '::' ||
        l.startsWith('fe80:') ||
        l.startsWith('fc') ||
        l.startsWith('fd') ||
        l.startsWith('::ffff:127.') ||
        l.startsWith('::ffff:10.') ||
        l.startsWith('::ffff:192.168.') ||
        l.startsWith('::ffff:169.254.')
    );
}

/**
 * Transparency label carried by EVERY copilot answer (EU AI Act Art. 13, 14, 50).
 * The route translates `key`; `en` is the fallback for a caller with no request.
 */
const AI_DISCLAIMER = Object.freeze({
    key: 'talentx:cap_ai_disclaimer',
    en: 'AI-generated — decision support only; a person makes the decision.',
});

/** Setting keys (App Settings, category "copilot"). */
const SETTING_ALLOW_NAMED = 'copilot.allow_named_person_ranking';
const SETTING_EU_ONLY = 'copilot.eu_only_providers';

/**
 * Questions that rank or name individual people. Used to decide whether an
 * answer is "about people" for the human-oversight audit record.
 */
const PEOPLE_QUESTION_RE =
    /flight|risk|leav|attriti|retain|who |priorit|weakest|strongest|develop|ready|readiness|strong|weak|pip|underperform|rank|performer|best|worst|people|employee/;

class CopilotService {
    /** The preset catalog (for the admin UI / docs). */
    presets() {
        return Object.entries(PROVIDER_PRESETS).map(([name, p]) => ({
            name,
            url: p.url,
            defaultModel: p.model,
            style: p.style,
            region: p.region,
            euHosted: !!p.euHosted,
            trainsOnData: !!p.trainsOnData,
        }));
    }

    /** The transparency label (for callers that need it outside ask()). */
    disclaimer() {
        return { ...AI_DISCLAIMER };
    }

    /**
     * Read a boolean App Setting tolerantly: true/'true'/'1'/1 → true,
     * false/'false'/'0'/0 → false, anything else (absent, '') → `def`.
     */
    async _boolSetting(key, def) {
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const v = await AppSettingsModel.getValue(key, def);
            if (v === true || v === 1 || v === '1' || v === 'true') return true;
            if (v === false || v === 0 || v === '0' || v === 'false') return false;
            return def;
        } catch (_) {
            return def;
        }
    }

    /** Whether the copilot may rank/name individual people (default OFF). */
    async allowNamedPersonRanking() {
        return this._boolSetting(SETTING_ALLOW_NAMED, false);
    }

    /** Whether only EU-hosted (or on-prem) provider presets may be used (default ON). */
    async euOnlyProviders() {
        return this._boolSetting(SETTING_EU_ONLY, true);
    }

    /** True when the question is about people (ranking, risk, readiness, PIPs…). */
    _isPeopleQuestion(question) {
        return PEOPLE_QUESTION_RE.test(String(question || '').toLowerCase());
    }

    /**
     * The context with every NAMED per-person list removed — what an LLM receives
     * when named ranking is off. Counts and averages stay; names and orderings go.
     */
    _withoutNamedPeople(ctx) {
        const out = { ...ctx };
        delete out.lowestReadiness;
        delete out.highestReadiness;
        delete out.flightRiskWho;
        delete out.openPipsWho;
        out.namedPersonRanking = 'withheld';
        return out;
    }

    /**
     * EU-residency guard. Returns null when `cfg` may be used, else a reason code.
     * Only a named preset on its STOCK endpoint is judged (see PROVIDER_PRESETS).
     */
    _residencyBlock(cfg, euOnly) {
        if (!euOnly || !cfg || cfg.provider === 'none') return null;
        const preset = PROVIDER_PRESETS[cfg.provider];
        if (!preset) return null; // custom endpoint: the administrator's declared choice
        if (cfg.url && cfg.url !== preset.url) return null; // overridden endpoint, same
        return preset.euHosted ? null : 'non_eu_provider';
    }
    /**
     * Resolve the LLM connection from App Settings (category "copilot"), falling
     * back to the legacy LLM_URL/LLM_MODEL env vars so existing installs keep
     * working. Cached briefly; AppSettingsController calls invalidate on change.
     * Providers: none | ollama | openai (OpenAI-compatible chat) | anthropic | custom.
     */
    async getConfig() {
        const now = Date.now();
        if (this._cfg && now - this._cfgAt < 30_000) return this._cfg;
        let cfg = {
            provider: 'none',
            url: null,
            model: 'llama3.1',
            apiKey: null,
            timeoutMs: 20000,
        };
        let providerSet = false; // did an admin explicitly store copilotProvider?
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const providerRow = await AppSettingsModel.findByKey('copilotProvider');
            providerSet = !!providerRow;
            const [provider, url, model, apiKey, timeoutMs] = await Promise.all([
                AppSettingsModel.getValue('copilotProvider', 'none'),
                AppSettingsModel.getValue('copilotUrl', ''),
                AppSettingsModel.getValue('copilotModel', 'llama3.1'),
                AppSettingsModel.getValue('copilotApiSecret', ''),
                AppSettingsModel.getValue('copilotTimeoutMs', '20000'),
            ]);
            cfg = {
                provider: String(provider || 'none')
                    .toLowerCase()
                    .trim(),
                url: String(url || '').trim() || null,
                model: String(model || 'llama3.1').trim(),
                apiKey: String(apiKey || '').trim() || null,
                timeoutMs: Number(timeoutMs) || 20000,
            };
        } catch (_) {
            /* settings table unavailable → env fallback below */
        }
        // Legacy env fallback: only when the provider was NEVER configured in
        // Settings — an admin who explicitly chose "none" (providerSet) must NOT be
        // silently overridden back to a live LLM by a stale LLM_URL in the env.
        if (!providerSet && process.env.LLM_URL) {
            cfg = {
                provider: 'custom',
                url: process.env.LLM_URL,
                model: process.env.LLM_MODEL || 'llama3.1',
                apiKey: null,
                timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 20000,
            };
        }
        // Resolve provider aliases (grock→grok, google→gemini, …) then apply the
        // preset: a named provider needs only an API key — endpoint URL and a
        // default model fill in automatically, both overridable in Settings.
        if (PROVIDER_ALIASES[cfg.provider]) cfg.provider = PROVIDER_ALIASES[cfg.provider];
        const preset = PROVIDER_PRESETS[cfg.provider];
        if (preset) {
            if (!cfg.url) cfg.url = preset.url;
            // 'llama3.1' is the shipped default VALUE of copilotModel — it is
            // meaningless for a cloud engine, so treat it as "not chosen" for
            // any non-ollama preset and use the preset's default model.
            if (!cfg.model || (cfg.model === 'llama3.1' && preset.style !== 'ollama'))
                cfg.model = preset.model;
        }
        if (cfg.provider !== 'none' && !cfg.url) cfg.provider = 'none'; // no URL = nothing to call
        // Data residency: a non-EU preset is refused while copilot.eu_only_providers
        // is on (default). The provider stays visible (admin UI, test button) but
        // `blocked` stops every outbound call — ask() answers deterministically.
        const blocked = this._residencyBlock(cfg, await this.euOnlyProviders());
        if (blocked) {
            cfg.blocked = blocked;
            cfg.region = PROVIDER_PRESETS[cfg.provider].region;
        }
        this._cfg = cfg;
        this._cfgAt = now;
        return cfg;
    }

    /**
     * SSRF guard for the outbound LLM URL. ALWAYS: http(s) only + no redirects (in
     * _callLlm). The private/loopback/link-local block is OPT-IN via
     * COPILOT_BLOCK_PRIVATE_HOSTS=1 — because a fully on-prem deployment's flagship
     * path is a LOCAL model (Ollama on localhost:11434 or an internal-LAN host), so
     * blocking private ranges by default would break the primary use case. The real
     * control against the delegated-admin SSRF vector is that copilot settings are
     * superadmin-only (SENSITIVE_CATEGORIES); cloud/hardened installs can additionally
     * set the env flag to forbid internal targets.
     */
    async _assertSafeUrl(rawUrl) {
        let u;
        try {
            u = new URL(rawUrl);
        } catch {
            throw new Error('Invalid LLM URL.');
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            throw new Error('LLM URL must use http or https.');
        const blockPrivate = process.env.COPILOT_BLOCK_PRIVATE_HOSTS === '1';
        if (!blockPrivate) return; // on-prem default: local/LAN LLM allowed
        const dns = require('dns').promises;
        const host = u.hostname.replace(/^\[|\]$/g, '');
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
            if (isPrivateIp(host))
                throw new Error(
                    'LLM URL points to a private/loopback address — refused (COPILOT_BLOCK_PRIVATE_HOSTS).'
                );
            return;
        }
        if (host === 'localhost')
            throw new Error('LLM URL points to localhost — refused (COPILOT_BLOCK_PRIVATE_HOSTS).');
        try {
            const addrs = await dns.lookup(host, { all: true });
            for (const a of addrs)
                if (isPrivateIp(a.address))
                    throw new Error(
                        'LLM URL resolves to a private/loopback address — refused (COPILOT_BLOCK_PRIVATE_HOSTS).'
                    );
        } catch (e) {
            if (/refused/.test(e.message)) throw e;
        }
    }

    /** Drop the cached connection config + target classification (called when
     *  copilot settings change). */
    invalidate() {
        this._cfg = null;
        this._cfgAt = 0;
        if (this._targetCache) this._targetCache.clear();
    }

    // ------------------------------------------------------------------
    // PRIVACY FILTER (pseudonymization firewall)
    // Only an INTERNAL AI target (localhost / private LAN / *.local-style
    // hostname / explicitly trusted host) may receive full talent data.
    // Every EXTERNAL target gets PSEUDONYMIZED content: employee names are
    // replaced with stable EMP-nnn tokens in both the context AND the
    // question, and tokens in the model's answer are swapped back before
    // the user sees it. FAIL-CLOSED: if the target cannot be proven
    // internal, it is treated as external and pseudonymized.
    // ------------------------------------------------------------------

    /**
     * Classify the LLM target. Internal =
     *   - host listed in the `copilotTrustedHosts` setting (superadmin-only,
     *     for an internal AI server behind a corporate DNS name), or
     *   - localhost / *.local / *.lan / *.internal / *.corp hostname, or
     *   - a private/loopback IP literal, or
     *   - a hostname whose DNS answers are ALL private addresses.
     * Anything else — including DNS failure — is EXTERNAL (fail-closed).
     */
    async _isInternalTarget(rawUrl) {
        // Per-host classification cache (5 min): the answer for a given URL is
        // stable, and re-resolving DNS on every question is wasted latency.
        // invalidate clears it alongside the config cache.
        this._targetCache = this._targetCache || new Map();
        const cached = this._targetCache.get(rawUrl);
        if (cached && Date.now() - cached.at < 300_000) return cached.val;
        const val = await this._classifyTarget(rawUrl);
        this._targetCache.set(rawUrl, { val, at: Date.now() });
        return val;
    }

    async _classifyTarget(rawUrl) {
        try {
            const u = new URL(rawUrl);
            const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
            try {
                const AppSettingsModel = require('../models/AppSettingsModel');
                const trusted = String(
                    (await AppSettingsModel.getValue('copilotTrustedHosts', '')) || ''
                )
                    .toLowerCase()
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                if (trusted.includes(host)) return true;
            } catch (_) {
                /* settings unavailable → heuristics below */
            }
            if (host === 'localhost' || /\.(local|lan|internal|corp)$/.test(host)) return true;
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':'))
                return isPrivateIp(host);
            const addrs = await require('dns').promises.lookup(host, { all: true });
            return addrs.length > 0 && addrs.every((a) => isPrivateIp(a.address));
        } catch (_) {
            return false; // cannot classify ⇒ external ⇒ pseudonymize
        }
    }

    // Ciphering/deciphering is delegated to AnonymizationService: a per-request
    // cipher session covering PERSONAL data (scoped employee names + parts) and
    // COMPANY data (site/department/service/role names, org identity; skills in
    // strict mode), with randomized per-request tokens and a decipher pass that
    // rebuilds the real values in the answer.

    /** Aggregate, RBAC-scoped context for the asker. */
    async buildContext(user) {
        return (await this._buildContextAndRoster(user)).ctx;
    }

    /**
     * Context + the scoped roster's full names (for question scrubbing in the
     * privacy filter). The roster NEVER enters the context/prompt itself.
     */
    async _buildContextAndRoster(user) {
        const emps = await RBACService.getFilteredEmployees(user);
        const roster = emps
            .map((e) => `${e.firstName || ''} ${e.lastName || ''}`.trim())
            .filter(Boolean);
        const ids = emps.map((e) => Number(e.id));
        const ctx = { headcount: ids.length };
        if (!ids.length) return { ctx, roster };
        // Array binding (`= ANY(?)`) not a `?`-expanded IN-list: one STABLE SQL string
        // per query → the translate memo-cache always hits and Postgres plans once,
        // instead of a fresh 4000-constant IN that churns the cache and re-plans.
        const safe = async (sql, label) => {
            try {
                return await db.all(sql, [ids]);
            } catch {
                ctx[label + '_err'] = true;
                return [];
            }
        };

        // Run every independent aggregate concurrently (they share no data) — collapses
        // ~9 sequential round-trips into one wave. Named keys keep the result mapping clear.
        const [
            perEmp,
            nineBox,
            flightRisk,
            flightRiskWho,
            openPipsWho,
            pipCount,
            topGaps,
            un,
            bySite,
        ] = await Promise.all([
            // Per-employee readiness (drives avg + weakest/strongest names) — THE
            // canonical figure, v_employee_assessment_coverage.readiness_assessed_only:
            // readiness over the requirements somebody actually assessed, NULL (never
            // 0) when nothing was. The old inline formula counted every never-rated
            // requirement as a failed one, so five people nobody had assessed were
            // NAMED as the weakest at 0 % and the org average read 64 % against the
            // dashboard's 82 %. Coverage (assessed / expected) travels with the score.
            safe(
                `SELECT e.first_name || ' ' || e.last_name AS full_name,
                       c.readiness_assessed_only AS pct,
                       c.assessed_skills AS assessed, c.expected_skills AS expected, c.coverage AS coverage
                FROM employees e JOIN v_employee_assessment_coverage c ON c.employee_id = e.id
                WHERE e.id = ANY(?) ORDER BY c.readiness_assessed_only ASC NULLS LAST, full_name`,
                'readiness'
            ),
            safe(
                `SELECT box, COUNT(*) AS n FROM talent_placements WHERE cycle_id=(SELECT MAX(cycle_id) FROM talent_placements) AND employee_id = ANY(?) GROUP BY box ORDER BY n DESC`,
                'nineBox'
            ),
            safe(
                `SELECT flight_risk, COUNT(*) AS n FROM retention_risk WHERE employee_id = ANY(?) GROUP BY flight_risk`,
                'flightRisk'
            ),
            safe(
                `SELECT e.first_name || ' ' || e.last_name AS name
                FROM retention_risk rr JOIN employees e ON e.id = rr.employee_id
                WHERE rr.flight_risk = 'high' AND rr.employee_id = ANY(?)
                ORDER BY rr.computed_score DESC NULLS LAST LIMIT 10`,
                'flightRiskWho'
            ),
            safe(
                `SELECT e.first_name || ' ' || e.last_name AS name, p.state
                FROM pips p JOIN employees e ON e.id = p.employee_id
                WHERE p.state IN ('proposed','approved','active') AND p.employee_id = ANY(?) LIMIT 10`,
                'pips'
            ),
            safe(
                `SELECT COUNT(*) AS n FROM pips WHERE state IN ('proposed','approved','active') AND employee_id = ANY(?)`,
                'pipCount'
            ),
            // Top gaps are MEASURED shortfalls (rated below the requirement). A
            // never-rated requirement is reported beside them as `unmeasured`, never
            // folded in as a shortfall — that is what put the unmeasured at the top
            // of the "worst gaps" list.
            safe(
                `SELECT s.name AS skill,
                       COUNT(*) FILTER (WHERE sa.current_level IS NOT NULL AND rsr.required_level > sa.current_level) AS shortfall,
                       COUNT(*) FILTER (WHERE sa.current_level IS NULL) AS unmeasured
                FROM employees e
                JOIN role_skill_requirements rsr ON rsr.role_id=e.role_id JOIN skills s ON s.id=rsr.skill_id
                LEFT JOIN skill_assessments sa ON sa.employee_id=e.id AND sa.skill_id=rsr.skill_id
                WHERE e.id = ANY(?) AND rsr.required_level > 0
                GROUP BY s.name
                HAVING COUNT(*) FILTER (WHERE sa.current_level IS NOT NULL AND rsr.required_level > sa.current_level) > 0
                ORDER BY shortfall DESC LIMIT 5`,
                'topGaps'
            ),
            safe(
                `SELECT COUNT(*) AS n FROM employees e WHERE e.id = ANY(?)
                AND NOT EXISTS (SELECT 1 FROM skill_assessments sa WHERE sa.employee_id = e.id)`,
                'unassessed'
            ),
            // Site readiness = average of the canonical per-person figure over the
            // people MEASURED at that site; `measured` / `coverage` say how many that is.
            safe(
                `SELECT st.name AS site, ROUND(AVG(c.readiness_assessed_only)) AS pct,
                       COUNT(*) AS people, COUNT(c.readiness_assessed_only) AS measured,
                       ROUND(100.0 * SUM(c.assessed_skills) / NULLIF(SUM(c.expected_skills), 0)) AS coverage
                FROM employees e JOIN sites st ON st.id = e.site_id
                JOIN v_employee_assessment_coverage c ON c.employee_id = e.id
                WHERE e.id = ANY(?) GROUP BY st.name ORDER BY pct DESC NULLS LAST`,
                'bySite'
            ),
        ]);

        // Only MEASURED people are averaged or ranked. Someone with no assessed
        // requirement has no readiness — they are counted in `neverAssessed`, and
        // never named as "weakest" on the strength of zero measurement.
        const person = (r) => ({
            name: r.fullName || r.full_name,
            pct: r.pct == null ? null : Math.round(Number(r.pct)),
            assessed: Number(r.assessed || 0),
            expected: Number(r.expected || 0),
            coveragePct: r.coverage == null ? null : Math.round(Number(r.coverage)),
        });
        const measured = perEmp.filter((r) => r.pct != null).map(person);
        ctx.measuredCount = measured.length;
        ctx.neverAssessed = perEmp.length - measured.length;
        ctx.coverage = {
            assessed: perEmp.reduce((s, r) => s + Number(r.assessed || 0), 0),
            expected: perEmp.reduce((s, r) => s + Number(r.expected || 0), 0),
        };
        ctx.coverage.pct =
            ctx.coverage.expected > 0
                ? Math.round((1000 * ctx.coverage.assessed) / ctx.coverage.expected) / 10
                : null;
        if (measured.length) {
            ctx.avgReadinessPct = Math.round(
                measured.reduce((s, r) => s + r.pct, 0) / measured.length
            );
            ctx.lowestReadiness = measured.slice(0, 5);
            ctx.highestReadiness = measured.slice(-5).reverse();
        } else {
            ctx.avgReadinessPct = null;
            ctx.lowestReadiness = [];
            ctx.highestReadiness = [];
        }
        ctx.nineBox = nineBox;
        ctx.flightRisk = flightRisk;
        ctx.flightRiskWho = flightRiskWho;
        ctx.openPipsWho = openPipsWho;
        ctx.openPips = { n: pipCount[0] ? Number(pipCount[0].n) : openPipsWho.length };
        ctx.topGaps = topGaps.map((r) => ({
            skill: r.skill,
            shortfall: Number(r.shortfall),
            unmeasured: Number(r.unmeasured || 0),
        }));
        ctx.unassessed = un[0] ? Number(un[0].n) : 0;
        ctx.bySite = bySite.map((r) => ({
            site: r.site,
            pct: r.pct == null ? null : Number(r.pct),
            people: Number(r.people),
            measured: Number(r.measured || 0),
            coveragePct: r.coverage == null ? null : Number(r.coverage),
        }));
        return { ctx, roster };
    }

    /**
     * Deterministic answer (no LLM) — routed by intent keywords.
     * Individuals are named / ranked ONLY when `allowNamedPersonRanking` is true
     * (the copilot.allow_named_person_ranking setting, default off); otherwise the
     * people intents answer with aggregates and say why no names are given.
     */
    _deterministic(question, ctx, { allowNamedPersonRanking = false } = {}) {
        const q = String(question || '').toLowerCase();
        const named = allowNamedPersonRanking === true;
        const noNames =
            ' I do not rank or name individual people: that is a judgement for a person, not for the copilot (an administrator can change this in Settings → Copilot).';
        const pct = (v) => (v == null ? 'n/a' : v + '%');
        const names = (list, f) => (list || []).map(f).join(', ');
        // Every readiness figure leaves with its denominator: "62 %" alone is
        // unreadable once pasted into a deck.
        const who = (r) => `${r.name} (${r.pct}%, ${r.assessed}/${r.expected} assessed)`;
        const cov =
            ctx.coverage && ctx.coverage.pct != null
                ? ` Coverage: ${ctx.coverage.assessed} of ${ctx.coverage.expected} requirements assessed (${ctx.coverage.pct}%).`
                : '';
        const never = ctx.neverAssessed
            ? ` ${ctx.neverAssessed} of your ${ctx.headcount} people have no assessed requirement and are not ranked — not measured is not 0%.`
            : '';

        if (/flight|risk|leav|attriti|retain/.test(q)) {
            const fr =
                names(ctx.flightRisk, (r) => `${r.flightRisk}: ${r.n}`) || 'no risk data yet';
            if (!named) {
                return (
                    `Across your ${ctx.headcount} people, risk-of-loss breaks down as — ${fr}.` +
                    noNames +
                    ` The Continuity module shows each person's situation to those entitled to see it.`
                );
            }
            const who = names(ctx.flightRiskWho, (r) => r.name);
            return (
                `Across your ${ctx.headcount} people, risk-of-loss breaks down as — ${fr}.` +
                (who ? ` High risk: ${who}.` : '') +
                ` Open the Continuity module to act on the high-risk ones.`
            );
        }
        // "Who needs development / development priorities" is a PEOPLE question →
        // answer with the weakest-readiness names, not the skill-gap list.
        if (/who needs|priorit|weakest|strongest|develop.*(first|who)/.test(q)) {
            if (!named) {
                const g = names(ctx.topGaps, (r) => `${r.skill} (${r.shortfall} measured short)`);
                return ctx.measuredCount
                    ? `Average role-readiness over the ${ctx.measuredCount} people measured is ${pct(ctx.avgReadinessPct)}.${cov}` +
                          (g ? ` Where development is most needed, by skill: ${g}.` : '') +
                          noNames +
                          never
                    : `No readiness data yet — nobody in your scope has an assessed requirement. Run assessments first.${never}`;
            }
            const low = names(ctx.lowestReadiness, who);
            return low
                ? `Development priorities (lowest MEASURED role-readiness): ${low}. Average over the ${ctx.measuredCount} people measured is ${pct(ctx.avgReadinessPct)}.${cov}${never}`
                : `No readiness data yet — nobody in your scope has an assessed requirement. Run assessments first.${never}`;
        }
        // Gaps BEFORE 9-box: "talent gaps" / "skill gaps" must not be swallowed
        // by the 9-box intent ("talent" used to match first).
        if (/gap|train|learn|course|develop/.test(q)) {
            const g =
                names(
                    ctx.topGaps,
                    (r) =>
                        `${r.skill} (${r.shortfall} measured short${r.unmeasured ? `, ${r.unmeasured} not measured` : ''})`
                ) || 'no measured gaps found';
            return `Top measured skill gaps in your scope: ${g}. The LMS Hub can auto-assign mapped courses to close these.${cov}`;
        }
        if (/not assessed|unassessed|coverage|missing assessment/.test(q)) {
            return `${ctx.neverAssessed || 0} of your ${ctx.headcount} people have no assessed requirement (${ctx.unassessed || 0} have no skill assessment at all).${cov} Run an assessment campaign (or the skill matrix Quick Edit) to close the coverage gap.`;
        }
        if (/site|location|where/.test(q) && (ctx.bySite || []).length) {
            const s = names(ctx.bySite, (r) =>
                r.pct == null
                    ? `${r.site} not measured (0 of ${r.people} assessed)`
                    : `${r.site} ${r.pct}% (${r.measured} of ${r.people} measured, coverage ${pct(r.coveragePct)})`
            );
            return `Role-readiness by site: ${s}.`;
        }
        if (/ready|readiness|strong|weak|priorit/.test(q)) {
            const low = named ? names(ctx.lowestReadiness, who) : '';
            const high = named ? names(ctx.highestReadiness, who) : '';
            return (
                `Average role-readiness over the ${ctx.measuredCount} of your ${ctx.headcount} people measured is ${pct(ctx.avgReadinessPct)}.${cov}` +
                (low ? ` Development priorities: ${low}.` : '') +
                (high ? ` Strongest: ${high}.` : '') +
                never
            );
        }
        if (/9.?box|nine.?box|talent|distribution|performer/.test(q)) {
            const nb = names(ctx.nineBox, (r) => `${r.box}: ${r.n}`) || 'no placements yet';
            return `Current 9-box distribution (latest cycle): ${nb}.`;
        }
        if (/pip|underperform/.test(q)) {
            const who = named ? names(ctx.openPipsWho, (r) => `${r.name} (${r.state})`) : '';
            return (
                `You have ${ctx.openPips ? ctx.openPips.n : 0} open PIP(s) in scope.` +
                (who ? ` — ${who}.` : '')
            );
        }
        if (/skill/.test(q)) {
            const g =
                names(
                    ctx.topGaps,
                    (r) =>
                        `${r.skill} (${r.shortfall} measured short${r.unmeasured ? `, ${r.unmeasured} not measured` : ''})`
                ) || 'no measured gaps found';
            return `Top measured skill gaps in your scope: ${g}.${cov}`;
        }
        if (named) {
            return `I can answer, for your ${ctx.headcount} people: role-readiness (avg ${pct(ctx.avgReadinessPct)} over the ${ctx.measuredCount || 0} measured, incl. weakest/strongest names), readiness by site, top skill gaps, who is at flight risk, open PIPs (with names), assessment coverage and the 9-box distribution. Try "who is at flight risk?", "readiness by site" or "who needs development first?". (Connect a local LLM via LLM_URL for free-form answers.)`;
        }
        return `I can answer, for your ${ctx.headcount} people: role-readiness (avg ${pct(ctx.avgReadinessPct)} over the ${ctx.measuredCount || 0} measured), readiness by site, top skill gaps, risk-of-loss and open PIPs as counts, assessment coverage and the 9-box distribution. Try "readiness by site", "what are our top skill gaps?" or "how many people are not assessed yet?". (Connect a local LLM via LLM_URL for free-form answers.)`;
    }

    /**
     * Build the provider-specific HTTP request + response parser.
     * All providers get the same system+context prompt; auth headers are sent in
     * every compatible form (Bearer / api-key / x-api-key) so OpenAI, Azure
     * OpenAI and Anthropic-style gateways all authenticate without extra config.
     */
    _providerRequest(cfg, system, userPrompt) {
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) {
            headers.Authorization = 'Bearer ' + cfg.apiKey;
            headers['api-key'] = cfg.apiKey; // Azure OpenAI
            headers['x-api-key'] = cfg.apiKey; // Anthropic
        }
        // Wire format comes from the preset's STYLE (grok/groq/gemini/mistral/
        // deepseek/openrouter/together all speak OpenAI chat completions);
        // unknown providers fall through to their own name → custom default.
        const style = PROVIDER_PRESETS[cfg.provider]
            ? PROVIDER_PRESETS[cfg.provider].style
            : cfg.provider;
        if (style === 'anthropic') headers['anthropic-version'] = '2023-06-01';

        let body, parse;
        switch (style) {
            case 'ollama':
                body = { model: cfg.model, prompt: `${system}\n\n${userPrompt}`, stream: false };
                parse = (j) => j.response;
                break;
            case 'openai': // OpenAI-compatible chat completions (OpenAI, Azure, LM Studio, vLLM, LocalAI, llama.cpp, Groq, Mistral, OpenRouter…)
                body = {
                    model: cfg.model,
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: userPrompt },
                    ],
                    stream: false,
                };
                parse = (j) =>
                    j.choices &&
                    j.choices[0] &&
                    j.choices[0].message &&
                    j.choices[0].message.content;
                break;
            case 'anthropic': // Claude Messages API
                body = {
                    model: cfg.model,
                    max_tokens: 1024,
                    system,
                    messages: [{ role: 'user', content: userPrompt }],
                };
                parse = (j) => j.content && j.content[0] && j.content[0].text;
                break;
            default: // 'custom' — generic completions: POST {model, prompt}; tolerant parse
                body = { model: cfg.model, prompt: `${system}\n\n${userPrompt}`, stream: false };
                parse = (j) =>
                    j.response ||
                    j.message ||
                    (j.choices &&
                        j.choices[0] &&
                        (j.choices[0].text ||
                            (j.choices[0].message && j.choices[0].message.content))) ||
                    (j.content && j.content[0] && j.content[0].text);
        }
        return { headers, body, parse };
    }

    async _callLlm(cfg, system, userPrompt, timeoutMs) {
        const { headers, body, parse } = this._providerRequest(cfg, system, userPrompt);
        await this._assertSafeUrl(cfg.url); // SSRF guard before any outbound request
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            // redirect:'manual' — refuse 3xx so a redirect to a private/metadata host
            // can't bypass the pre-flight URL check.
            const res = await globalThis.fetch(cfg.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: ctrl.signal,
                redirect: 'manual',
            });
            if (res.status >= 300 && res.status < 400)
                throw new Error('LLM endpoint returned a redirect — refused.');
            if (!res.ok) throw new Error('LLM HTTP ' + res.status);
            const j = await res.json();
            return parse(j) || '(no answer)';
        } catch (e) {
            if (e.name === 'AbortError') throw new Error(`LLM timed out after ${timeoutMs}ms`);
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    async _askLlm(
        cfg,
        question,
        ctx,
        { anonymized = false, allowNamedPersonRanking = false } = {}
    ) {
        const system =
            "You are IDevelop's talent copilot. Answer ONLY from the provided JSON context, which is already scoped to what the user is allowed to see. Be concise and actionable. If the context lacks the answer, say so. Your answer is decision support only: a person makes every decision about people." +
            (allowNamedPersonRanking
                ? ''
                : ' Do NOT rank, score, shortlist or name individual people (for example by flight risk, readiness or performance); answer with aggregates, and if asked for a ranking of individuals, politely explain that this is a decision for a person.') +
            (anonymized
                ? ' People, sites, departments, services, roles and the organization are identified only by pseudonymous tokens (EMP-xxxx, SITE-xxxx, DEPT-xxxx, SVC-xxxx, ROLE-xxxx, ORG-xxxx, SKILL-xxxx) — you do not know their real identities. When referring to any of them, use the token VERBATIM exactly as written; never invent names or guess identities.'
                : '');
        const userPrompt = `Context:\n${JSON.stringify(ctx)}\n\nQuestion: ${question}\n\nAnswer:`;
        return this._callLlm(cfg, system, userPrompt, cfg.timeoutMs);
    }

    /**
     * Whether a language model may be called at all: configured (provider not
     * 'none') AND not refused by the EU-residency guard. Never calls the model.
     */
    async llmUsable() {
        const cfg = await this.getConfig();
        return cfg.provider !== 'none' && !cfg.blocked;
    }

    /**
     * Public, NARROW wrapper for other in-app assistants (CompanionService): one
     * completion over caller-supplied, NON-PERSONAL text (product-guide snippets),
     * through the SAME connection, residency guard, SSRF guard and timeout as the
     * copilot. It never touches talent data and never anonymises (there is
     * nothing to anonymise — the caller guarantees the prompt carries no personal
     * data). Returns `{ ok:false, reason }` when no model may be used (not
     * configured / residency-blocked) or the call failed — the caller then answers
     * deterministically — and `{ ok:true, text, provider, model, host, internal }`
     * otherwise. The call is bounded by `maxTimeoutMs` (default 10 s).
     */
    async completeText(system, userPrompt, { maxTimeoutMs = 10000 } = {}) {
        const cfg = await this.getConfig();
        if (cfg.provider === 'none') return { ok: false, reason: 'not_configured' };
        if (cfg.blocked)
            return { ok: false, reason: cfg.blocked, provider: cfg.provider, blocked: true };
        const meta = {
            provider: cfg.provider,
            model: cfg.model || null,
            host: this._hostOf(cfg.url),
        };
        try {
            const internal = await this._isInternalTarget(cfg.url);
            const text = await this._callLlm(
                cfg,
                String(system || ''),
                String(userPrompt || ''),
                Math.min(Number(cfg.timeoutMs) || 20000, Number(maxTimeoutMs) || 10000)
            );
            return { ok: true, text: String(text || ''), internal, ...meta };
        } catch (e) {
            return { ok: false, reason: 'error', error: e.message, ...meta };
        }
    }

    /** Health/status of the configured LLM connection (for the admin UI / test button). */
    async llmStatus() {
        const cfg = await this.getConfig();
        if (cfg.blocked)
            return {
                configured: true,
                reachable: false,
                mode: 'blocked',
                provider: cfg.provider,
                model: cfg.model,
                region: cfg.region || null,
                blocked: cfg.blocked,
                error: `Provider "${cfg.provider}" is not EU-hosted (region: ${cfg.region || 'unknown'}) and copilot.eu_only_providers is on — no request was sent. The copilot answers with the built-in engine.`,
            };
        if (cfg.provider === 'none')
            return {
                configured: false,
                reachable: false,
                mode: 'deterministic',
                provider: 'none',
                model: null,
            };
        try {
            const out = await this._callLlm(
                cfg,
                'Reply with the single word: pong',
                'ping',
                Math.min(cfg.timeoutMs, 8000)
            );
            return {
                configured: true,
                reachable: true,
                mode: 'llm',
                provider: cfg.provider,
                model: cfg.model,
                sample: String(out).slice(0, 80),
            };
        } catch (e) {
            return {
                configured: true,
                reachable: false,
                mode: 'fallback',
                provider: cfg.provider,
                model: cfg.model,
                error: e.message,
            };
        }
    }

    /** Host of the configured LLM URL, for the egress audit (never the full path/query). */
    _hostOf(url) {
        try {
            return new URL(url).host;
        } catch {
            return '(invalid)';
        }
    }

    /**
     * Responsible-AI audit of ONE copilot query — every query, whatever answered
     * it: an external model (COPILOT_QUERY_EGRESS, the RBAC-scoped context left
     * the box), an internal/LAN model or the deterministic engine (COPILOT_QUERY).
     * Previously an internal model left no trace at all, and the egress record
     * said nothing about the exchange itself.
     *
     * PRIVACY: the raw question and answer are NEVER written. The record carries
     * a SHA-256 of the question (lets an investigator confirm "was this exact
     * question asked?" without the log becoming a store of what people asked),
     * the answer LENGTH, provider/model/host, whether the data left the box,
     * whether it was anonymized and the per-class cipher counts.
     * Best-effort: logging never affects the answer.
     */
    async _auditQuery(
        user,
        cfg,
        {
            mode,
            internal = false,
            anonymized = false,
            stats = null,
            question = '',
            answer = '',
            subjectCount = null,
            aboutPeople = false,
            namedPersonRanking = false,
            blocked = null,
        } = {}
    ) {
        try {
            const crypto = require('crypto');
            const llm =
                !!cfg && cfg.provider && cfg.provider !== 'none' && mode !== 'deterministic';
            const egress = !!(llm && !internal);
            const meta = {
                provider: llm ? cfg.provider : 'none',
                model: llm ? cfg.model || null : null,
                host: llm ? this._hostOf(cfg.url) : null,
                mode,
                egress,
                anonymized: !!anonymized,
                anonymizationCounts: stats ? { ...stats } : null,
                questionSha256: crypto
                    .createHash('sha256')
                    .update(String(question == null ? '' : question), 'utf8')
                    .digest('hex'),
                questionLength: String(question == null ? '' : question).length,
                answerLength: String(answer == null ? '' : answer).length,
                subjects: subjectCount,
                // Human oversight (EU AI Act Art. 14): the answer was shown with the
                // "decision support only; a person makes the decision" label. For a
                // question about people this record is the acknowledgement that the
                // output reached a human as advice, not as a decision.
                humanOversight: {
                    notice: 'decision_support_only',
                    disclaimerShown: true,
                    aboutPeople: !!aboutPeople,
                    namedPersonRanking: namedPersonRanking ? 'allowed' : 'withheld',
                },
                residencyBlocked: blocked || null,
            };
            const summary = egress
                ? anonymized
                    ? `Copilot query: ANONYMIZED talent context (${subjectCount} people) sent to ${meta.provider} at ${meta.host} — no personal or company identifiers transmitted`
                    : `Copilot query: talent context (${subjectCount} people, incl. names/risk/PIP) sent to ${meta.provider} at ${meta.host}`
                : llm
                  ? `Copilot query answered by internal model ${meta.provider} at ${meta.host} — no data egress`
                  : blocked
                    ? `Copilot query answered by the deterministic engine — provider ${cfg.provider} refused (${blocked}), no data egress`
                    : 'Copilot query answered by the deterministic engine — no AI model, no data egress';
            const oversight = aboutPeople
                ? ' — answer about people shown as decision support only; a person makes the decision'
                : '';
            await LogService.log({
                adminId: user && user.userType === 'admin' ? user.id : null,
                action: egress ? 'COPILOT_QUERY_EGRESS' : 'COPILOT_QUERY',
                entityType: 'copilot',
                details: `${summary}${oversight} ${JSON.stringify(meta)}`,
                actorRef: user ? `${user.userType}:${user.id}` : null,
            });
        } catch (_) {
            /* audit best-effort */
        }
    }

    /**
     * Main entry — RBAC-scoped; LLM if configured else deterministic.
     *
     * ANONYMIZATION (cipher/decipher): by default ('always' mode) EVERY AI
     * request — internal or external — carries only ciphered data: personal
     * identifiers AND company identifiers (sites, departments, services,
     * roles, org identity) are replaced with per-request randomized tokens in
     * the context and the question; the decipher pass rebuilds the real
     * values in the answer. 'external-only' mode lets a proven-internal AI
     * server receive full data. EXTERNAL targets are ciphered UNCONDITIONALLY
     * — no configuration can disable that. Fail-closed classification.
     */
    async ask(user, question) {
        const { ctx, roster } = await this._buildContextAndRoster(user);
        const cfg = await this.getConfig();
        const allowNamedPersonRanking = await this.allowNamedPersonRanking();
        const oversight = {
            aboutPeople: this._isPeopleQuestion(question),
            namedPersonRanking: allowNamedPersonRanking,
        };
        // Transparency fields carried by EVERY answer, whatever produced it.
        const guard = {
            disclaimer: AI_DISCLAIMER.en,
            disclaimerKey: AI_DISCLAIMER.key,
            namedPersonRanking: allowNamedPersonRanking ? 'allowed' : 'withheld',
        };
        if (cfg.provider !== 'none' && !cfg.blocked) {
            const Anonymization = require('./AnonymizationService');
            const internal = await this._isInternalTarget(cfg.url);
            const anonMode = await Anonymization.mode();
            // External: always ciphered. Internal: ciphered unless 'external-only'.
            const active = !internal || anonMode === 'always';
            // Named per-person lists never reach the model while ranking is off.
            const baseCtx = allowNamedPersonRanking ? ctx : this._withoutNamedPeople(ctx);
            let sendCtx = baseCtx,
                sendQuestion = question,
                session = null;
            if (active) {
                session = await Anonymization.createSession(roster);
                sendCtx = session.cipherObject(baseCtx);
                sendQuestion = session.cipherText(String(question || ''));
            }
            const auditBase = {
                internal,
                anonymized: active,
                stats: session && session.stats,
                question,
                subjectCount: ctx.headcount,
                ...oversight,
            };
            try {
                let answer = await this._askLlm(cfg, sendQuestion, sendCtx, {
                    anonymized: active,
                    allowNamedPersonRanking,
                });
                if (session) answer = session.decipher(answer);
                await this._auditQuery(user, cfg, { ...auditBase, mode: 'llm', answer });
                return {
                    answer,
                    mode: 'llm',
                    provider: cfg.provider,
                    scope: ctx.headcount,
                    sanitized: active,
                    ...guard,
                };
            } catch (e) {
                // Keep the raw provider error OUT of the user-facing answer (it's
                // meaningless/alarming to a business user); surface it only as a field
                // for the admin/logs, and log it server-side.
                console.warn(
                    `[copilot] LLM (${cfg.provider}) unavailable, using deterministic fallback: ${e.message}`
                );
                const answer = this._deterministic(question, ctx, { allowNamedPersonRanking });
                // A failed call may still have transmitted the request body — record it.
                await this._auditQuery(user, cfg, { ...auditBase, mode: 'fallback', answer });
                return {
                    answer,
                    mode: 'fallback',
                    provider: cfg.provider,
                    scope: ctx.headcount,
                    sanitized: active,
                    llmError: e.message,
                    ...guard,
                };
            }
        }
        const answer = this._deterministic(question, ctx, { allowNamedPersonRanking });
        await this._auditQuery(user, cfg, {
            mode: 'deterministic',
            question,
            answer,
            subjectCount: ctx.headcount,
            blocked: cfg.blocked || null,
            ...oversight,
        });
        const out = { answer, mode: 'deterministic', scope: ctx.headcount, ...guard };
        if (cfg.blocked) {
            out.provider = cfg.provider;
            out.blocked = cfg.blocked;
        }
        return out;
    }
}

module.exports = new CopilotService();
module.exports.PROVIDER_PRESETS = PROVIDER_PRESETS;
module.exports.AI_DISCLAIMER = AI_DISCLAIMER;
module.exports.SETTING_ALLOW_NAMED = SETTING_ALLOW_NAMED;
module.exports.SETTING_EU_ONLY = SETTING_EU_ONLY;
