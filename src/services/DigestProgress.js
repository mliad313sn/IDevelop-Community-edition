'use strict';

/**
 * DigestProgress — « Since your last summary of DD/MM », the block a person's
 * weekly point opens with (4.0.0 port, wave 7).
 *
 * ONE definition, the employee home's: what changed is read by
 * EmployeeHomeService.changesSince (levels VALIDATED — never a self-rating or
 * a draft —, gaps closed on a measured requirement, plan actions done,
 * trainings completed). The anchor is the person's previous point that was
 * actually SENT, so the page « What changed » and the summary never disagree.
 *
 *   - first point (none sent before): one line, « the comparison comes with
 *     the next one »; nothing is counted;
 *   - nothing new: one line that says so;
 *   - the changes cannot be read: NO block (hidden rather than claiming
 *     « nothing new »).
 *
 * Counts only: never a skill, a course, a name or a reason, so the archive
 * page and the mail print the same lines. A count is printed only when it is
 * above zero; an unreadable count is left out, never shown as 0.
 */

const db = require('../config/database');
const Narrative = require('./NarrativeService');
const { fmtNum } = require('../utils/kpiFormat');

const { phrase } = Narrative;
const MAX_LINES = 4;

/** 'YYYY-MM-DD' → 'DD/MM' (the day the previous point was sent), or ''. */
function dayMonth(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}/${m[2]}` : '';
}

/**
 * The reader's previous point: the last persona digest SENT to them before
 * `before`, as { id, at } (at = ISO instant), or null.
 */
async function previous(userType, userId, before = new Date()) {
    const row = await db.get(
        `SELECT id, created_at AS "createdAt"
           FROM persona_digests
          WHERE user_type = ? AND user_id = ? AND state = 'sent' AND created_at < ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [String(userType), Number(userId), before instanceof Date ? before : new Date()]
    );
    if (!row || !row.createdAt) return null;
    const at = new Date(row.createdAt);
    if (Number.isNaN(at.getTime())) return null;
    return { id: Number(row.id), at: at.toISOString() };
}

/** A count line `{ text, polarity: 'better' }` when n > 0, else null. */
function countLine(lang, key, n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return null;
    return {
        text: phrase(lang, key, { count: v, countText: fmtNum(v, 0, lang) }),
        polarity: 'better',
    };
}

/**
 * Compose the block from a previous point and the person's changes since
 * (EmployeeHomeService.changesSince's shape). PURE.
 * @returns {{since: string|null, state: 'first'|'comparable', title: string|null,
 *            lines: Array<{text, polarity}>, positive: number} | null}
 */
function compose(lang, prev, changes) {
    const l = lang === 'en' ? 'en' : 'fr';
    if (!prev) {
        return {
            since: null,
            state: 'first',
            title: null,
            lines: [{ text: phrase(l, 'nar_dg_pr_first'), polarity: 'neutral' }],
            positive: 0,
        };
    }
    if (!changes) return null;
    const lines = [
        countLine(l, 'nar_dg_pr_levels', changes.upliftsTotal),
        countLine(l, 'nar_dg_pr_gaps', changes.gapsClosed),
        countLine(l, 'nar_dg_pr_actions', changes.actionsDone),
        countLine(l, 'nar_dg_pr_trainings', changes.trainingsDone),
    ].filter(Boolean);
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const positive =
        num(changes.upliftsTotal) +
        num(changes.gapsClosed) +
        num(changes.actionsDone) +
        num(changes.trainingsDone);
    return {
        since: prev.at,
        state: 'comparable',
        // the day in the app's zone, never a UTC-shifted day
        title: phrase(l, 'nar_dg_pr_title', {
            date: dayMonth(require('../utils/dateFormat').appDayIso(new Date(prev.at))),
        }),
        lines: lines.length
            ? lines.slice(0, MAX_LINES)
            : [{ text: phrase(l, 'nar_dg_pr_none'), polarity: 'neutral' }],
        positive,
    };
}

/**
 * The progress block of one employee for a point built at `now`, or null
 * when the changes cannot be read.
 */
async function forEmployee(employeeId, { now = new Date(), lang = 'fr' } = {}) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) return null;
    let prev = null;
    try {
        prev = await previous('employee', id, now);
    } catch (_) {
        return null;
    }
    if (!prev) return compose(lang, null, null);
    try {
        const EH = require('./EmployeeHomeService');
        const gaps = await EH.gapRowsOf(id);
        const changes = await EH.changesSince(id, { since: prev.at, kind: 'digest' }, gaps);
        return compose(lang, prev, changes);
    } catch (_) {
        return null;
    }
}

/** The renderEmail blocks of a progress block: its heading, then its lines. */
function blocks(progress) {
    if (!progress || !Array.isArray(progress.lines) || !progress.lines.length) return [];
    const out = [];
    if (progress.title) out.push({ type: 'h', text: progress.title });
    out.push({ type: 'list', items: progress.lines.map((x) => x.text) });
    return out;
}

module.exports = { previous, compose, forEmployee, blocks, _test: { dayMonth } };
