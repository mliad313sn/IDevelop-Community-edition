'use strict';

/**
 * SurveyService — engagement / eNPS / pulse / lifecycle surveys. Aggregation
 * suppresses any group below the survey's anonymity threshold so individuals are
 * never exposed. Aggregate engagement feeds the People-Continuity risk-of-loss
 * signal (engagement is the leading indicator of attrition).
 */
const db = require('../config/database');
const crypto = require('crypto');

// Pseudonymous respondent key for ANONYMOUS surveys: keyed HMAC of the
// (survey, employee) pair so re-answers still dedupe, but no row carries the
// employee id and the DB alone cannot map answers back to people. (Reversal
// would require the app secret AND a brute-force — outside the DB threat model.)
function respondentKey(surveyId, employeeId, anonymous) {
    if (!anonymous) return String(employeeId);
    const secret = process.env.SESSION_SECRET || 'dev-only';
    return crypto
        .createHmac('sha256', secret)
        .update(`survey:${surveyId}:emp:${employeeId}`)
        .digest('hex')
        .slice(0, 32);
}

/**
 * The anonymity floor. A survey could be created with minResponses = 1, which
 * publishes one person's answers as "the results". Five is the same small-cell
 * rule DEIService applies to demographic groups; any lower stored value
 * (surveys created before this floor) is lifted at READ time as well.
 */
const MIN_RESPONSES_FLOOR = 5;
const KINDS = ['engagement', 'enps', 'pulse', 'onboarding', 'exit'];
const QTYPES = ['scale', 'nps', 'text'];
const MAX_QUESTIONS = 30;

function refuse(status, code) {
    const e = new Error(code);
    e.status = status;
    e.code = code;
    e.expose = true;
    return e;
}

function floorOf(stored) {
    const n = Number(stored);
    return Math.max(MIN_RESPONSES_FLOOR, Number.isInteger(n) ? n : MIN_RESPONSES_FLOOR);
}

class SurveyService {
    get MIN_RESPONSES_FLOOR() {
        return MIN_RESPONSES_FLOOR;
    }

    /** Validate and normalise a question list (400 on anything unusable). */
    normaliseQuestions(questions) {
        const list = Array.isArray(questions) ? questions : [];
        if (!list.length) throw refuse(400, 'survey_questions_required');
        if (list.length > MAX_QUESTIONS) throw refuse(400, 'survey_too_many_questions');
        return list.map((q) => {
            const text = String((q && q.text) || '')
                .trim()
                .slice(0, 500);
            const qtype = String((q && q.qtype) || 'scale');
            if (!text) throw refuse(400, 'survey_question_text_required');
            if (!QTYPES.includes(qtype)) throw refuse(400, 'survey_question_type_invalid');
            const category =
                q && q.category ? String(q.category).trim().slice(0, 60) || null : null;
            return { text, qtype, category };
        });
    }

    async create({
        kind = 'pulse',
        title,
        anonymous = true,
        minResponses = MIN_RESPONSES_FLOOR,
        createdByAdminId = null,
        actorEmployeeId = null,
        questions = [],
    }) {
        const t = String(title || '')
            .trim()
            .slice(0, 200);
        if (!t) throw refuse(400, 'survey_title_required');
        const k = KINDS.includes(String(kind)) ? String(kind) : 'pulse';
        const qs = this.normaliseQuestions(questions);
        // Clamp — never below the anonymity floor, never above a sane ceiling.
        const min = Math.min(1000, floorOf(parseInt(minResponses, 10)));
        return db.runTransaction(async () => {
            const s = await db.get(
                `INSERT INTO surveys (kind, title, anonymous, min_responses, created_by_admin_id, actor_employee_id)
                 VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
                [
                    k,
                    t,
                    !(anonymous === false || anonymous === 'false'),
                    min,
                    createdByAdminId,
                    actorEmployeeId,
                ]
            );
            let ord = 0;
            for (const q of qs) {
                await db.run(
                    'INSERT INTO survey_questions (survey_id, ord, text, qtype, category) VALUES (?, ?, ?, ?, ?)',
                    [s.id, ord++, q.text, q.qtype, q.category]
                );
            }
            return s;
        });
    }

    async get(id) {
        return db.get(
            'SELECT id, title, state, anonymous, min_responses, created_by_admin_id, actor_employee_id, audience_scoped FROM surveys WHERE id = ?',
            [Number(id)]
        );
    }

    /**
     * Owner check for open / close / results: the SuperAdmin, the admin who
     * created it, or the manager who created it. These three routes had NO
     * owner check — any holder of manage_surveys could open, close or read the
     * results of anybody's survey.
     */
    canManage(user, survey) {
        if (!user || !survey) return false;
        if (user.userType === 'admin' && user.role === 'superadmin') return true;
        if (user.userType === 'admin') {
            return (
                Number(survey.createdByAdminId ?? survey.created_by_admin_id) === Number(user.id)
            );
        }
        return Number(survey.actorEmployeeId ?? survey.actor_employee_id) === Number(user.id);
    }

    /**
     * draft → open. The audience is the OPENER's scope, handed in by the route
     * (SuperAdmin: every active employee), frozen in survey_audience and the
     * only population invited. Previously open had no state guard (a closed
     * survey could be re-opened, re-notifying everybody) and invited every
     * active employee of the organisation whoever opened it.
     */
    async open(id, { audienceIds = [] } = {}) {
        const ids = [
            ...new Set((audienceIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)),
        ];
        let invited = [];
        await db.runTransaction(async () => {
            const row = await db.get(
                "UPDATE surveys SET state='open', opened_at=now(), audience_scoped=true WHERE id=? AND state='draft' RETURNING id",
                [Number(id)]
            );
            if (!row) throw refuse(409, 'survey_not_draft');
            for (let i = 0; i < ids.length; i += 500) {
                const chunk = ids.slice(i, i + 500);
                const rows = await db.all(
                    `INSERT INTO survey_audience (survey_id, employee_id)
                     SELECT CAST(? AS bigint), e.id FROM employees e
                      WHERE e.is_active = true AND e.id IN (${chunk.map(() => '?').join(',')})
                     ON CONFLICT DO NOTHING RETURNING employee_id`,
                    [Number(id), ...chunk]
                );
                invited = invited.concat(rows.map((r) => Number(r.employeeId ?? r.employee_id)));
            }
        });
        try {
            if (invited.length) {
                await require('./NotificationService').enqueueBulkInApp({
                    userType: 'employee',
                    userIds: invited,
                    // /v2/cap is manager/admin-only; employees answer surveys from
                    // the "Mon évolution" hub.
                    kind: 'survey.published',
                    payload: { link: '/employee/opportunities' },
                });
            }
        } catch (_) {
            /* never block survey open on notification */
        }
        return { ok: true, invited: invited.length };
    }

    /** open → closed (and only that). */
    async close(id) {
        const row = await db.get(
            "UPDATE surveys SET state='closed', closed_at=now() WHERE id=? AND state='open' RETURNING id",
            [Number(id)]
        );
        if (!row) throw refuse(409, 'survey_not_open');
        return { ok: true };
    }

    /**
     * Survey list. `owner` restricts it to the surveys a non-SuperAdmin created
     * (admin id or manager employee id); omitted = all (SuperAdmin).
     */
    async list(owner = null) {
        const params = [];
        let where = '';
        if (owner) {
            const ors = [];
            if (owner.adminId) {
                ors.push('s.created_by_admin_id = ?');
                params.push(Number(owner.adminId));
            }
            if (owner.employeeId) {
                ors.push('s.actor_employee_id = ?');
                params.push(Number(owner.employeeId));
            }
            where = ors.length ? `WHERE (${ors.join(' OR ')})` : 'WHERE false';
        }
        return db.all(
            `SELECT s.*, (SELECT COUNT(DISTINCT respondent_key) FROM survey_responses r WHERE r.survey_id = s.id) AS respondents
             FROM surveys s ${where} ORDER BY s.created_at DESC`,
            params
        );
    }

    /**
     * Open surveys this employee is invited to. A survey opened before the
     * audience existed (audience_scoped = false) keeps its historical org-wide
     * audience.
     */
    async listOpenForEmployee(employeeId) {
        return db.all(
            `SELECT s.* FROM surveys s
              WHERE s.state = 'open'
                AND (s.audience_scoped = false
                     OR EXISTS (SELECT 1 FROM survey_audience sa WHERE sa.survey_id = s.id AND sa.employee_id = ?))
              ORDER BY s.created_at DESC`,
            [Number(employeeId)]
        );
    }

    async isInAudience(surveyId, employeeId) {
        const s = await db.get('SELECT audience_scoped FROM surveys WHERE id = ?', [
            Number(surveyId),
        ]);
        if (!s) return false;
        if (s.audienceScoped === false || s.audience_scoped === false) return true;
        const r = await db.get(
            'SELECT 1 AS ok FROM survey_audience WHERE survey_id = ? AND employee_id = ?',
            [Number(surveyId), Number(employeeId)]
        );
        return !!r;
    }
    /**
     * SEC-5 (3.23.21) — who may read a survey's questions: whoever may manage
     * it (canManage: SuperAdmin / creator), or an EMPLOYEE (manager included)
     * of its audience once it has been opened. A draft is never shown to an
     * audience — before open it has none (audience_scoped is still false,
     * which isInAudience reads as the legacy "everyone").
     */
    async canReadQuestions(user, survey) {
        if (!user || !survey) return false;
        if (this.canManage(user, survey)) return true;
        if (user.userType !== 'employee' && user.userType !== 'manager') return false;
        if (String(survey.state) === 'draft') return false;
        return this.isInAudience(survey.id, Number(user.id));
    }

    async questions(surveyId) {
        return db.all('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY ord', [
            surveyId,
        ]);
    }

    /** Record one employee's answers (idempotent per question). Hardened:
     *  - only OPEN surveys accept responses (a closed/read eNPS can't be rewritten);
     *  - answers only bind to that survey's own questions (no cross-survey attach);
     *  - per-qtype validation: scale 1-5, nps 0-10, text requires text_answer;
     *  - anonymous surveys never store employee_id — a pseudonymous respondent_key
     *    keeps re-answers idempotent without a name on the row. */
    async respond(surveyId, employeeId, answers) {
        const survey = await db.get('SELECT id, state, anonymous FROM surveys WHERE id = ?', [
            surveyId,
        ]);
        if (!survey) throw refuse(404, 'survey_not_found');
        if (String(survey.state) !== 'open') throw refuse(409, 'survey_not_open');
        // Only the invited audience may answer (legacy org-wide surveys: everyone).
        if (!(await this.isInAudience(surveyId, employeeId)))
            throw refuse(403, 'survey_not_in_audience');
        const anonymous = survey.anonymous === true;
        const qRows = await db.all('SELECT id, qtype FROM survey_questions WHERE survey_id = ?', [
            surveyId,
        ]);
        const qtypeById = new Map(qRows.map((q) => [Number(q.id), String(q.qtype || 'scale')]));
        const emp = await db.get('SELECT site_id, department_id FROM employees WHERE id = ?', [
            employeeId,
        ]);
        const rk = respondentKey(surveyId, employeeId, anonymous);
        let recorded = 0;
        for (const a of answers || []) {
            const qid = Number(a.questionId);
            const qtype = qtypeById.get(qid);
            if (!qtype) continue; // not this survey's question — drop silently
            let score = null,
                text = null;
            if (qtype === 'text') {
                text = String(a.text || '')
                    .trim()
                    .slice(0, 4000);
                if (!text) continue;
            } else {
                const n = Number(a.score);
                const min = qtype === 'nps' ? 0 : 1;
                const max = qtype === 'nps' ? 10 : 5;
                if (!Number.isInteger(n) || n < min || n > max) continue;
                score = n;
            }
            await db.run(
                `INSERT INTO survey_responses (survey_id, question_id, employee_id, respondent_key, score, text_answer, site_id, department_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (survey_id, question_id, respondent_key) DO UPDATE SET score = EXCLUDED.score, text_answer = EXCLUDED.text_answer`,
                [
                    surveyId,
                    qid,
                    anonymous ? null : employeeId,
                    rk,
                    score,
                    text,
                    emp ? emp.siteId : null,
                    emp ? emp.departmentId : null,
                ]
            );
            recorded++;
        }
        return { recorded };
    }

    /** True when this employee has already answered ≥1 question of the survey
     *  (works for anonymous surveys via the pseudonymous key). */
    async hasResponded(surveyId, employeeId, anonymous) {
        const rk = respondentKey(surveyId, employeeId, anonymous === true);
        const r = await db.get(
            'SELECT 1 AS ok FROM survey_responses WHERE survey_id = ? AND respondent_key = ? LIMIT 1',
            [surveyId, rk]
        );
        return !!r;
    }

    /**
     * Aggregate results with anonymity suppression. eNPS computed for nps
     * questions. Text answers — collected but never returned before — are
     * returned for a text question only once it has reached the anonymity
     * floor, as bare strings in alphabetical order: no id, no date, no
     * respondent key, no order of arrival, nothing to attribute them by.
     */
    async results(surveyId) {
        const s = await db.get('SELECT min_responses FROM surveys WHERE id = ?', [surveyId]);
        const min = floorOf(s ? s.minResponses : MIN_RESPONSES_FLOOR);
        const rows = await db.all(
            `SELECT q.id AS question_id, q.text, q.qtype, q.category,
                    COUNT(r.id) AS responses, AVG(r.score) AS avg_score,
                    COUNT(r.id) FILTER (WHERE q.qtype='nps' AND r.score >= 9) AS promoters,
                    COUNT(r.id) FILTER (WHERE q.qtype='nps' AND r.score <= 6) AS detractors
             FROM survey_questions q
             LEFT JOIN survey_responses r ON r.question_id = q.id
             WHERE q.survey_id = ?
             GROUP BY q.id, q.text, q.qtype, q.category ORDER BY q.ord`,
            [surveyId]
        );
        const out = [];
        for (const r of rows) {
            const n = Number(r.responses);
            if (n < min) {
                out.push({
                    questionId: r.questionId,
                    text: r.text,
                    qtype: r.qtype,
                    suppressed: true,
                    responses: n,
                    threshold: min,
                });
                continue;
            }
            const o = {
                questionId: r.questionId,
                text: r.text,
                qtype: r.qtype,
                category: r.category,
                responses: n,
                avgScore: r.avgScore != null ? Number(Number(r.avgScore).toFixed(2)) : null,
            };
            if (r.qtype === 'nps')
                o.enps = Math.round(((Number(r.promoters) - Number(r.detractors)) / n) * 100);
            if (r.qtype === 'text') {
                o.avgScore = null;
                const answers = await db.all(
                    `SELECT text_answer FROM survey_responses
                      WHERE question_id = ? AND text_answer IS NOT NULL AND text_answer <> ''`,
                    [r.questionId]
                );
                o.answers = answers
                    .map((a) => String(a.textAnswer ?? a.text_answer ?? ''))
                    .filter(Boolean)
                    .sort((a, b) => a.localeCompare(b));
            }
            out.push(o);
        }
        return out;
    }
    // engagementByEmployee was removed: it had no caller, and it averaged
    // every score of a survey — NPS 0-10 mixed with 1-5 scale — per
    // employee_id, which is NULL on anonymous surveys. The individual
    // engagement signal lives in RetentionRiskService and reads only 1-5 scale
    // questions of NON-anonymous surveys.
}

module.exports = new SurveyService();
