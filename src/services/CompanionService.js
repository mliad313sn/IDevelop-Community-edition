'use strict';

/**
 * CompanionService — the in-app AI companion offered to EVERY signed-in user
 * (employee, manager, administrator) in the « Assistant » tab of the help panel.
 * It helps people get value from the product: how to do something, what to do
 * next, what the current page is for, what a term means.
 *
 * DETERMINISTIC FIRST (the default, air-gapped friendly): answers come from a
 * bilingual knowledge base (src/config/companionKnowledge.js) and from the
 * user's own to-dos, routed by keyword intent detection (FR + EN). No language
 * model is needed and nothing leaves the server.
 *
 * INTENTS
 *   capabilities  "what can you do"
 *   next          "what should I do next" → the user's own Action Center items
 *                 (collectMyActions — RBAC-scoped), plus the remaining setup steps
 *                 for a SuperAdmin
 *   page          "explain this page" → the knowledge entry of the current path
 *   self          "what is my readiness" → the asker's OWN readiness and gaps
 *                 (employee rows only: employees and managers)
 *   data          a question about a population → managers/admins: delegated to
 *                 CopilotService.ask (RBAC scope, EU AI Act guardrails, audit,
 *                 anonymisation all unchanged); employees: refused — an employee
 *                 never gets anybody else's data
 *   concept       readiness, not measured, gap, critical skill, 9-box, dispute,
 *                 campaign, IDP, PIP, succession, coverage, level scale
 *   howto         the best knowledge entry the user's role may open
 *
 * ROLE FILTERING: an entry (and therefore its link) is offered only when the
 * asker's account type is listed on it and, for an administrator, when they hold
 * one of its permissions (SuperAdmin-only entries need a SuperAdmin). A screen
 * that belongs to an optional module (entry.module) is offered only while that
 * module is switched on (Administration → Modules) — the assistant never links
 * to a disabled module.
 *
 * OPTIONAL LLM MODE: when the copilot's language model is configured AND allowed
 * (CopilotService.llmUsable — respects copilot.eu_only_providers), a knowledge
 * answer (howto / concept / page) is REPHRASED by the model. The model receives
 * ONLY the question (scrubbed of e-mails, URLs, numbers and the asker's own name),
 * the retrieved knowledge-base snippets and the page path with ids removed —
 * never a to-do, a readiness figure, a name or any other personal data. Any
 * error or timeout falls back to the deterministic answer.
 *
 * Every answer: { answer, links:[{label,href}], suggestions:[…],
 *   source:'kb'|'actions'|'copilot'|'llm', disclaimer, intent }. `disclaimer` is
 * the EU AI Act label ("AI-generated — decision support only …") whenever a
 * language model or the copilot produced the answer, else null.
 *
 * AUDIT: every question is logged as COMPANION_QUERY with a SHA-256 of the
 * question, its length, the answer length, the intent, the source, the page path
 * with ids removed and the LLM host when one was called — never the raw text.
 */

const db = require('../config/database');
const RBACService = require('./RBACService');
const LogService = require('./LogService');
const Copilot = require('./CopilotService');
const K = require('../config/companionKnowledge');

const LOCALES = {
    fr: require('../../locales/fr/companion.json'),
    en: require('../../locales/en/companion.json'),
};

const MAX_QUESTION = 500;
const SETTING_ENABLED = 'companion.enabled';

// ── Text normalisation ───────────────────────────────────────────────────
/** lower-case, accents stripped, punctuation → spaces, single-spaced. */
function norm(s) {
    return String(s == null ? '' : s)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[’'`«»“”"]/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Weight of one keyword in a normalised question (0 = absent). */
function kwWeight(nq, kw) {
    const prefix = kw.endsWith('*');
    const k = norm(prefix ? kw.slice(0, -1) : kw);
    if (!k) return 0;
    const words = k.split(' ').length;
    const re = new RegExp('(^| )' + escRe(k) + (prefix ? '[a-z0-9]*' : '') + '( |$)');
    if (!re.test(nq)) return 0;
    // Phrases are more specific than single words.
    return words > 1 ? words * 2 : prefix ? 1.5 : 1;
}

function scoreKeywords(nq, keywords) {
    if (!keywords) return 0;
    let s = 0;
    for (const kw of [...(keywords.fr || []), ...(keywords.en || [])]) s += kwWeight(nq, kw);
    return s;
}

// ── Intent patterns (on normalised text) ─────────────────────────────────
const RE = {
    capabilities:
        /(^(help|aide|hello|hi|bonjour|salut)$|what can you do|what do you do|who are you|what are you|how can you help|what can i ask|que (peux|sais|pouvez|savez) (tu|vous) faire|qu est ce que (tu|vous) (peux|sais|pouvez|savez) faire|a quoi (sers|servez) (tu|vous)|tu sers a quoi|qui es tu|que fais tu|comment (peux|pouvez) (tu|vous) m aider|que puis je te demander)/,
    next: /(what should i do|what do i do next|what (s|is) next|whats next|next step|next best|what now|what is waiting|waiting for me|my to ?dos?|to do list|todo|what are my priorities|my priorities|que dois je faire|que faire (maintenant|ensuite)|quoi faire|prochaine etape|prochaines etapes|par quoi commencer|mes taches|ma liste|a faire|ce qui m attend|qu est ce qui m attend|mes priorites)/,
    page: /(this page|this screen|current page|explain the page|explain this|where am i|what can i do here|what is this (page|screen)|cette page|cet ecran|explique (moi )?la page|ou suis je|que puis je faire ici|a quoi sert (cette|cet|la) (page|ecran))/,
    howto: /(^| )(how (do|can|to|should|does)|how i |where (do|can|is|are|should)|comment|ou (est|sont|trouver|puis|peut|peux|se trouve|voir|en est|consulter|suivre|configurer|lire)|i want to|i would like to|i need to|je veux|je voudrais|j aimerais|je souhaite|je dois|il faut que)( |$)/,
    definition:
        /(what is|what s |whats|what are|what does|mean(s|ing)?( |$)|define|definition|qu est ce qu|c est quoi|que signifie|que veut dire|veut dire quoi|signification|explain|explique)/,
    self: /(^| )(my|mine|mon|ma|mes|am i|suis je|me concernant|moi)( |$)/,
    selfMetric:
        /(readiness|preparation|pret|ready|score|gap|ecart|lacune|level|niveau|strength|point fort|weakness|faiblesse|results?|resultat|how am i doing|ou j en suis)/,
    data: /(by site|par site|per site|by department|par departement|par service|how many|combien|who is|who are|who needs|who has|who should|qui est|qui sont|qui a |qui doit|qui faut|flight risk|risque de depart|attrition|my team|mon equipe|our team|notre equipe|nos equipes|the team|l equipe|our people|nos collaborateurs|mes collaborateurs|my reports|headcount|effectif|average|moyenne|distribution|repartition|top (skill )?gaps|biggest gaps|main gaps|principaux ecarts|plus gros ecarts|our (skill )?gaps|nos ecarts|weakest|strongest|plus faibles?|plus forts?|open pips|pips? ouverts?|not assessed yet|pas encore evalue|unassessed|non evalues|readiness by|preparation par|organisation readiness|org readiness|across the (company|organisation))/,
};

// ── Role helpers ─────────────────────────────────────────────────────────
function roleOf(user) {
    if (!user) return null;
    if (user.userType === 'admin') return 'admin';
    if (user.userType === 'manager') return 'manager';
    if (user.userType === 'employee') return 'employee';
    return null;
}

/** Is the entry's optional module (any of them, when a list) switched on? */
function moduleOn(entry) {
    if (!entry.module) return true;
    const ModuleService = require('./ModuleService');
    return [].concat(entry.module).some((k) => ModuleService.isOnSync(k));
}

/** May this user be pointed at this knowledge entry (and its link)? */
function canSee(user, entry) {
    const role = roleOf(user);
    if (!role || !entry || !entry.roles.includes(role)) return false;
    if (!moduleOn(entry)) return false;
    if (role === 'admin') {
        if (entry.superadmin && !RBACService.isSuperAdmin(user)) return false;
        const perms = entry.perm ? [].concat(entry.perm) : [];
        if (perms.length && !perms.some((p) => RBACService.hasPermission(user, p))) return false;
    }
    return true;
}

function visibleEntries(user) {
    return K.ENTRIES.filter((e) => canSee(user, e));
}

function entryById(id) {
    return K.ENTRIES.find((e) => e.id === id) || null;
}

/** Clean a client-sent page path: '/…' only, no query/hash, bounded. */
function cleanPath(p) {
    const s = String(p == null ? '' : p)
        .split(/[?#]/)[0]
        .trim();
    if (!s.startsWith('/') || s.startsWith('//') || s.length > 200) return '';
    return s.replace(/\/+$/, '') || '/';
}

/** The path with every numeric / uuid-like segment replaced — safe to log or send. */
function redactPath(p) {
    return cleanPath(p)
        .split('/')
        .map((seg) => (/\d/.test(seg) && /^[0-9a-f-]+$/i.test(seg) ? ':id' : seg))
        .join('/');
}

function lng(opts) {
    return opts &&
        String(opts.lng || '')
            .toLowerCase()
            .startsWith('en')
        ? 'en'
        : 'fr';
}

function tr(lang, key, params) {
    const dict = LOCALES[lang] || LOCALES.fr;
    let s = dict[key] != null ? dict[key] : LOCALES.en[key] != null ? LOCALES.en[key] : key;
    if (params)
        s = s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
            params[k] == null ? '' : String(params[k])
        );
    return s;
}

const linkOf = (entry, lang) => ({ label: entry.title[lang], href: entry.link });

class CompanionService {
    constructor() {
        this.MAX_QUESTION = MAX_QUESTION;
        this.SETTING_ENABLED = SETTING_ENABLED;
    }

    /** Admin switch `companion.enabled` (default ON; absent / unreadable → ON). */
    async isEnabled() {
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            const v = await AppSettingsModel.getValue(SETTING_ENABLED, true);
            return !(v === false || v === 0 || v === '0' || v === 'false');
        } catch (_) {
            return true;
        }
    }

    // ── Retrieval ─────────────────────────────────────────────────────────
    /** Best knowledge entries for a question, restricted to what `user` may open. */
    searchEntries(user, question, limit = 3) {
        const nq = norm(question);
        return visibleEntries(user)
            .map((e, i) => {
                let score = scoreKeywords(nq, e.keywords);
                if (nq && (norm(e.ask.fr) === nq || norm(e.ask.en) === nq)) score += 100;
                return { e, score, i };
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score || a.i - b.i)
            .slice(0, limit);
    }

    /** Best concept for a question (score > 0) or null. */
    findConcept(question) {
        const nq = norm(question);
        let best = null;
        K.CONCEPTS.forEach((c, i) => {
            const score = scoreKeywords(nq, c.keywords);
            if (score > 0 && (!best || score > best.score)) best = { c, score, i };
        });
        return best;
    }

    /** Knowledge entry describing the page at `path` (longest link prefix wins). */
    pageEntry(user, path) {
        const p = cleanPath(path);
        if (!p) return null;
        const hits = visibleEntries(user).filter((e) => p === e.link || p.startsWith(e.link + '/'));
        hits.sort((a, b) => b.link.length - a.link.length);
        return hits[0] || null;
    }

    /**
     * Pure intent routing (no I/O). Returns { intent, entry?, concept? }.
     * Order matters and is tested (tests/unit/companionService.test.js).
     */
    detectIntent(user, question) {
        const nq = norm(question);
        const role = roleOf(user);
        if (!nq) return { intent: 'capabilities' };
        if (RE.capabilities.test(nq)) return { intent: 'capabilities' };
        if (RE.next.test(nq)) return { intent: 'next' };
        if (RE.page.test(nq)) return { intent: 'page' };

        const hits = this.searchEntries(user, question, 1);
        const best = hits[0] || null;
        // A "how do I …" with a clear knowledge hit is a product question, even
        // when it mentions data words ("how do I see my readiness report").
        if (RE.howto.test(nq) && best && best.score >= 2) return { intent: 'howto', entry: best.e };

        const isDataQ = RE.data.test(nq);
        const isSelfQ = RE.self.test(nq) && RE.selfMetric.test(nq);
        if (isDataQ) return { intent: role === 'employee' ? 'data_denied' : 'data' };
        if (isSelfQ) return { intent: 'self' };

        const concept = this.findConcept(question);
        if (concept && RE.definition.test(nq)) return { intent: 'concept', concept: concept.c };
        if (best && RE.howto.test(nq)) return { intent: 'howto', entry: best.e };
        // A bare term ("9-box", "coverage") is a concept question.
        if (concept && nq.split(' ').length <= 4 && (!best || concept.score >= best.score))
            return { intent: 'concept', concept: concept.c };
        if (best) return { intent: 'howto', entry: best.e };
        if (concept) return { intent: 'concept', concept: concept.c };
        return { intent: 'fallback' };
    }

    // ── Suggestions ───────────────────────────────────────────────────────
    /** Suggested prompts for the page at `path` and the user's role. */
    suggestions(user, path, opts = {}) {
        const lang = lng(opts);
        const role = roleOf(user);
        if (!role) return [];
        const out = [];
        const entry = this.pageEntry(user, path);
        if (entry) {
            out.push(tr(lang, 'sugg_explain_page'));
            out.push(entry.ask[lang]);
        }
        for (const p of K.ROLE_PROMPTS[role] || []) out.push(p[lang]);
        if (!out.includes(tr(lang, 'sugg_capabilities'))) out.push(tr(lang, 'sugg_capabilities'));
        return [...new Set(out)].slice(0, 5);
    }

    // ── Personal data (the asker's OWN, never anybody else's) ──────────────
    /** The asker's own readiness summary — employee rows (employees, managers) only. */
    async _selfSummary(user, lang) {
        const id = Number(user.id);
        const lines = [];
        const role = await db
            .get(
                `SELECT r.name AS role_name FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?`,
                [id]
            )
            .catch(() => null);
        if (role && role.roleName) lines.push(tr(lang, 'self_role', { role: role.roleName }));
        const cov = await db
            .get(
                `SELECT readiness_assessed_only, assessed_skills, expected_skills
                   FROM v_employee_assessment_coverage WHERE employee_id = ?`,
                [id]
            )
            .catch(() => null);
        const expected = cov ? Number(cov.expectedSkills) || 0 : 0;
        const assessed = cov ? Number(cov.assessedSkills) || 0 : 0;
        if (!expected) {
            lines.push(tr(lang, 'self_no_role'));
            return lines.join(' ');
        }
        if (cov.readinessAssessedOnly == null)
            lines.push(tr(lang, 'self_not_measured', { expected }));
        else
            lines.push(
                tr(lang, 'self_readiness', {
                    pct: Math.round(Number(cov.readinessAssessedOnly)),
                    assessed,
                    expected,
                })
            );
        const gaps = await db
            .all(
                `SELECT skill_name, is_assessed, is_critical, gap
                   FROM v_employee_skill_gaps WHERE employee_id = ?`,
                [id]
            )
            .catch(() => []);
        const measured = (gaps || []).filter(
            (g) => Number(g.isAssessed) === 1 && Number(g.gap) > 0
        );
        const critical = measured.filter(
            (g) => g.isCritical === true || Number(g.isCritical) === 1
        );
        const unmeasured = Math.max(
            (gaps || []).filter((g) => Number(g.isAssessed) !== 1).length,
            expected - assessed
        );
        lines.push(
            tr(lang, 'self_gaps', { gaps: measured.length, critical: critical.length, unmeasured })
        );
        const top = measured
            .sort((a, b) => Number(b.gap) - Number(a.gap))
            .slice(0, 3)
            .map((g) => g.skillName)
            .filter(Boolean);
        if (top.length) lines.push(tr(lang, 'self_top_gaps', { list: top.join(', ') }));
        return lines.join(' ');
    }

    /** Next-best actions: the user's own to-dos (+ remaining setup for a SuperAdmin). */
    async _nextActions(user, lang, translate) {
        const TalentActions = require('../controllers/TalentActionsController');
        const role = roleOf(user);
        const lines = [];
        const links = [];
        let items = [];
        try {
            items = await TalentActions.collectMyActions(user, translate);
        } catch (_) {
            items = [];
        }
        if (items.length) {
            lines.push(tr(lang, 'next_intro'));
            for (const it of items.slice(0, 6)) {
                lines.push(tr(lang, 'next_item', { label: it.label, count: it.count }));
                if (it.href && links.length < 4) links.push({ label: it.label, href: it.href });
            }
        }
        if (RBACService.isSuperAdmin(user)) {
            try {
                const Setup = require('../controllers/SetupController');
                const { checks, complete } = await Setup.getChecks();
                if (!complete) {
                    const required = checks.filter((c) => !c.optional);
                    const todo = required.filter((c) => !c.done);
                    lines.push(
                        tr(lang, 'setup_intro', {
                            done: required.length - todo.length,
                            total: required.length,
                        })
                    );
                    for (const c of todo.slice(0, 4)) {
                        const label = tr(lang, 'setup_step_' + c.key);
                        lines.push('• ' + label);
                        if (links.length < 5) links.push({ label, href: c.href });
                    }
                }
            } catch (_) {
                /* setup checklist is best-effort */
            }
        }
        if (!lines.length) lines.push(tr(lang, 'next_none_' + role));
        return { answer: lines.join('\n'), links };
    }

    // ── Optional language model (product text only) ──────────────────────
    /** Remove what could identify a person from the question before any LLM call. */
    _scrubQuestion(question, user) {
        let q = String(question || '');
        q = q.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]');
        q = q.replace(/\bhttps?:\/\/\S+/gi, '[url]');
        q = q.replace(/\d{3,}/g, '[n]');
        const names = [user && user.firstName, user && user.lastName, user && user.username]
            .map((s) => String(s || '').trim())
            .filter((s) => s.length >= 2);
        for (const n of names) q = q.replace(new RegExp(escRe(n), 'gi'), '[name]');
        return q;
    }

    /** Prompt for the rephrasing pass: question + knowledge snippets + path. Nothing else. */
    _llmPrompt(question, snippets, path, lang, user) {
        const system =
            'You are the in-app help assistant of IDevelop, a skills and talent management product. ' +
            'Answer ONLY from the product-guide snippets provided; never invent screens, menus or features. ' +
            'Be concise (at most 120 words), friendly and practical. ' +
            (lang === 'en' ? 'Reply in UK English.' : 'Réponds en français (vouvoiement).') +
            ' Do not ask for, guess or mention any personal data.';
        const lines = snippets.map((s) => `- ${s.title}: ${s.text}`);
        const userPrompt =
            `Page: ${redactPath(path) || '(unknown)'}\n` +
            `Product-guide snippets:\n${lines.join('\n')}\n\n` +
            `Question: ${this._scrubQuestion(question, user)}\n\nAnswer:`;
        return { system, userPrompt };
    }

    async _maybeRephrase(out, ctx) {
        let usable = false;
        try {
            usable = await Copilot.llmUsable();
        } catch (_) {
            usable = false;
        }
        if (!usable || !ctx.snippets || !ctx.snippets.length) return out;
        const { system, userPrompt } = this._llmPrompt(
            ctx.question,
            ctx.snippets,
            ctx.path,
            ctx.lang,
            ctx.user
        );
        const res = await Copilot.completeText(system, userPrompt, { maxTimeoutMs: 10000 }).catch(
            (e) => ({ ok: false, reason: 'error', error: e && e.message })
        );
        ctx.llm = res && res.provider ? res : null;
        if (!res || !res.ok || !String(res.text || '').trim()) return out;
        return {
            ...out,
            answer: String(res.text).trim().slice(0, 2000),
            source: 'llm',
            disclaimer: ctx.disclaimer,
        };
    }

    // ── Audit ─────────────────────────────────────────────────────────────
    async _audit(user, { question, answer, intent, source, path, llm = null }) {
        try {
            const crypto = require('crypto');
            const q = String(question == null ? '' : question);
            const meta = {
                intent,
                source,
                role: roleOf(user),
                path: redactPath(path) || null,
                questionSha256: crypto.createHash('sha256').update(q, 'utf8').digest('hex'),
                questionLength: q.length,
                answerLength: String(answer == null ? '' : answer).length,
                delegatedTo: source === 'copilot' ? 'copilot' : null,
                llm: llm
                    ? {
                          provider: llm.provider || null,
                          host: llm.host || null,
                          egress: llm.ok ? !llm.internal : false,
                          ok: !!llm.ok,
                      }
                    : null,
                personalDataToLlm: false,
            };
            await LogService.log({
                adminId: user && user.userType === 'admin' ? user.id : null,
                action: 'COMPANION_QUERY',
                entityType: 'companion',
                details: `Companion question answered (${intent} → ${source}) ${JSON.stringify(meta)}`,
                actorRef: user ? `${user.userType}:${user.id}` : null,
            });
        } catch (_) {
            /* audit is best-effort */
        }
    }

    // ── Main entry ────────────────────────────────────────────────────────
    /**
     * Answer one question.
     * @param {object} user   req.user
     * @param {string} question  ≤ 500 characters (the route validates)
     * @param {object} [opts] { path, lng: 'fr'|'en', translate(fullKey, fallback, params) }
     */
    async ask(user, question, opts = {}) {
        const lang = lng(opts);
        const path = cleanPath(opts.path);
        const translate =
            typeof opts.translate === 'function' ? opts.translate : (k, fallback) => fallback;
        const disclaimer = translate(Copilot.AI_DISCLAIMER.key, Copilot.AI_DISCLAIMER.en);
        const q = String(question || '').slice(0, MAX_QUESTION);
        const role = roleOf(user);
        // Fresh module state before any link is chosen (TTL-cached settings).
        await require('./ModuleService').resolve();
        const { intent, entry, concept } = this.detectIntent(user, q);

        let out = { answer: '', links: [], source: 'kb', disclaimer: null };
        const ctx = { question: q, path, lang, user, disclaimer, snippets: null, llm: null };

        switch (intent) {
            case 'capabilities':
                out.answer = tr(lang, 'cap_' + role);
                out.links = [entryById('user_guide')]
                    .filter((e) => canSee(user, e))
                    .map((e) => linkOf(e, lang));
                break;
            case 'next': {
                const r = await this._nextActions(user, lang, translate);
                out = { ...out, ...r, source: 'actions' };
                break;
            }
            case 'page': {
                const pe = this.pageEntry(user, path);
                if (pe) {
                    out.answer =
                        tr(lang, 'page_intro', { title: pe.title[lang] }) + ' ' + pe.answer[lang];
                    ctx.snippets = [{ title: pe.title[lang], text: pe.answer[lang] }];
                } else {
                    out.answer = tr(lang, 'page_unknown');
                }
                const guide = entryById('user_guide');
                if (canSee(user, guide)) out.links = [linkOf(guide, lang)];
                break;
            }
            case 'self': {
                if (role === 'admin') {
                    out.answer = tr(lang, 'self_admin');
                } else {
                    out.answer = await this._selfSummary(user, lang);
                    out.source = 'actions';
                    out.links = ['employee_home', 'my_development']
                        .map(entryById)
                        .filter((e) => canSee(user, e))
                        .map((e) => linkOf(e, lang));
                }
                break;
            }
            case 'data_denied':
                out.answer = tr(lang, 'data_denied');
                break;
            case 'data': {
                // Managers/admins only (detectIntent never yields 'data' for an employee;
                // re-checked here so a routing change can never widen it).
                if (role !== 'manager' && role !== 'admin') {
                    out.answer = tr(lang, 'data_denied');
                    break;
                }
                // The data copilot is the AI module: while it is switched off the
                // assistant says so instead of calling it.
                if (!require('./ModuleService').isOnSync('ai')) {
                    out.answer = tr(lang, 'data_ai_off');
                    out.links = ['dashboard', 'reports']
                        .map(entryById)
                        .filter((e) => canSee(user, e))
                        .map((e) => linkOf(e, lang));
                    break;
                }
                try {
                    const r = await Copilot.ask(user, q);
                    out.answer = String(r.answer || '');
                    out.source = 'copilot';
                    out.disclaimer = r.disclaimerKey
                        ? translate(r.disclaimerKey, r.disclaimer || disclaimer)
                        : disclaimer;
                } catch (_) {
                    out.answer = tr(lang, 'copilot_unavailable');
                }
                out.links = ['dashboard', 'reports']
                    .map(entryById)
                    .filter((e) => canSee(user, e))
                    .map((e) => linkOf(e, lang));
                break;
            }
            case 'concept': {
                out.answer = concept.answer[lang];
                const rel = entryById(concept.related);
                if (rel && canSee(user, rel)) out.links = [linkOf(rel, lang)];
                ctx.snippets = [{ title: concept.title[lang], text: concept.answer[lang] }];
                break;
            }
            case 'howto': {
                out.answer = entry.answer[lang];
                out.links = [linkOf(entry, lang)];
                const more = this.searchEntries(user, q, 3).filter((h) => h.e.id !== entry.id);
                ctx.snippets = [
                    { title: entry.title[lang], text: entry.answer[lang] },
                    ...more
                        .slice(0, 2)
                        .map((h) => ({ title: h.e.title[lang], text: h.e.answer[lang] })),
                ];
                for (const h of more.slice(0, 1)) out.links.push(linkOf(h.e, lang));
                break;
            }
            default:
                out.answer = tr(lang, 'fallback');
        }

        // Optional rephrasing — product text only (howto / concept / page).
        if (ctx.snippets && ['howto', 'concept', 'page'].includes(intent)) {
            out = await this._maybeRephrase(out, ctx);
        }

        // Only same-origin, path-absolute links ever reach the client.
        out.links = (out.links || []).filter(
            (l) =>
                l &&
                typeof l.href === 'string' &&
                l.href.startsWith('/') &&
                !l.href.startsWith('//')
        );
        const suggestions = this.suggestions(user, path, { lng: lang }).filter(
            (s) => norm(s) !== norm(q)
        );
        const result = {
            answer: out.answer,
            links: out.links,
            suggestions: suggestions.slice(0, 4),
            source: out.source,
            disclaimer:
                out.source === 'llm' || out.source === 'copilot'
                    ? out.disclaimer || disclaimer
                    : null,
            intent,
        };
        await this._audit(user, {
            question: q,
            answer: result.answer,
            intent,
            source: result.source,
            path,
            llm: ctx.llm,
        });
        return result;
    }
}

module.exports = new CompanionService();
module.exports.norm = norm;
module.exports.canSee = canSee;
module.exports.cleanPath = cleanPath;
module.exports.redactPath = redactPath;
module.exports.SETTING_ENABLED = SETTING_ENABLED;
module.exports.MAX_QUESTION = MAX_QUESTION;
