'use strict';
/**
 * TalentConfidentialityService — the ONE place that decides whether a piece of
 * employee-facing prose may name a person's 9-box cell (HR policy,
 * arbitration A4).
 *
 * THE RULE
 *   A placement is confidential until a manager or an administrator deliberately
 *   discloses it. Until then, nothing the SUBJECT can read may name the cell —
 *   not the plan summary, not a development objective, not an action title.
 *   After disclosure the cell is no longer a secret from them, and the same text
 *   passes through untouched.
 *
 * WHY A RUNTIME GUARD AND NOT ONLY A DATA FIX
 *   DevelopmentTriggerService has been careful not to write the label since the
 *   fix that added `origin_evaluation_id`, yet PIP #12 on a development database still read
 *   'Auto-initiated from 9-box placement "Underperformer" (low performance)…' on
 *   /employee/my-development with 0 of 37 placements disclosed. Migration 115
 *   corrects those rows; this guard is what stops the next one, because a PIP
 *   summary is free text a manager types.
 *
 * HOW IT REDACTS
 *   Sentence by sentence. A sentence that names the cell is dropped; every other
 *   sentence the manager wrote survives, so the plan keeps standing on its own
 *   reasons. When nothing survives, the caller's neutral fallback is used —
 *   never an empty field, which would read as "nothing was written".
 *
 * VOCABULARY
 *   The nine current labels, the four legacy labels still present in live rows
 *   (Underperformer / Core Player / Growth Employee / High Performer), and the
 *   grid's own name. 'Concern' and 'Dilemma' are ordinary English words, so they
 *   match CASE-SENSITIVELY as standalone Title-Case words only — French prose
 *   ("les plans qui vous concernent") must never be redacted by accident.
 */

// Unambiguous multi-word labels + the legacy single word 'Underperformer'.
const PHRASE_LABELS = [
    'Diamond in the rough',
    'Shooting Star',
    'Gold Star',
    'Critical Contributor',
    'Emerging Star',
    'Essential Contributor',
    'Trusted Professional',
    'Core Player',
    'Growth Employee',
    'High Performer',
    'Underperformer',
];
// Ambiguous in ordinary prose — Title Case only, case-SENSITIVE.
const AMBIGUOUS_LABELS = ['Concern', 'Dilemma'];
// The grid itself. Naming it inside a plan the subject reads still says "a
// confidential placement exists and caused this", which A4 does not allow.
const GRID_WORDS = [
    '9-box',
    '9 box',
    '9box',
    'nine-box',
    'nine box',
    'matrice 9 cases',
    'grille 9 cases',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHRASE_RE = new RegExp(`(?:${PHRASE_LABELS.map(esc).join('|')})`, 'i');
const AMBIGUOUS_RE = new RegExp(`\\b(?:${AMBIGUOUS_LABELS.map(esc).join('|')})\\b`); // case-sensitive on purpose
const GRID_RE = new RegExp(`(?:${GRID_WORDS.map(esc).join('|')})`, 'i');

// Sentence boundaries: a terminator followed by whitespace, or a line break.
// Keeping the terminator with its sentence so surviving text reads normally.
const SPLIT_RE = /(?<=[.!?…])\s+|\r?\n+/;

class TalentConfidentialityService {
    /** Every word this service refuses to show an undisclosed subject. */
    get vocabulary() {
        return {
            phrases: [...PHRASE_LABELS],
            ambiguous: [...AMBIGUOUS_LABELS],
            grid: [...GRID_WORDS],
        };
    }

    /** Does this text name a 9-box cell (or the grid) at all? */
    mentionsCell(text) {
        if (text == null) return false;
        const s = String(text);
        return PHRASE_RE.test(s) || AMBIGUOUS_RE.test(s) || GRID_RE.test(s);
    }

    /**
     * Redact text that the SUBJECT of a placement will read.
     *
     * @param {string}  text        the stored prose
     * @param {boolean} disclosed   true once the placement has been disclosed to them
     * @param {string}  fallback    neutral sentence used when every sentence was dropped
     * @returns {{ text: string, redacted: boolean }}
     */
    redactForSubject(text, { disclosed = false, fallback = '' } = {}) {
        const raw = text == null ? '' : String(text);
        if (disclosed || !raw.trim() || !this.mentionsCell(raw))
            return { text: raw, redacted: false };
        const kept = raw
            .split(SPLIT_RE)
            .filter((s) => s.trim() && !this.mentionsCell(s))
            .map((s) => s.trim());
        const out = kept.join(' ').trim();
        return { text: out || String(fallback || ''), redacted: true };
    }

    /**
     * The placement this person has been TOLD about, with who told them and when,
     * or null. Used by the employee portal: after a deliberate disclosure the
     * subject must see their cell WITH its date and its author, and before
     * one they must see nothing at all.
     *
     * Deliberately a single approved+disclosed row: a proposal is not a position,
     * and an archived placement is history the person was never shown.
     */
    async disclosedPlacement(employeeId) {
        const db = require('../config/database');
        const row = await db
            .get(
                `SELECT id, performance, potential, box, box_label, approved_at,
                    disclosed_at, disclosed_by, disclosed_by_type, disclosure_reason
               FROM nine_box_evaluations
              WHERE employee_id = ? AND status = 'approved' AND disclosed_to_employee = true
              ORDER BY disclosed_at DESC NULLS LAST, id DESC
              LIMIT 1`,
                [employeeId]
            )
            .catch(() => null);
        if (!row) return null;
        return { ...row, authorName: await this._actorName(row.disclosedBy, row.disclosedByType) };
    }

    /**
     * Name the human behind (id, type). Employees and admins are different id
     * spaces — reading the wrong table would print somebody else's name on a
     * confidential judgement, so the type decides the table and an unknown
     * pairing returns null rather than a guess.
     */
    async _actorName(actorId, actorType) {
        if (!actorId) return null;
        const db = require('../config/database');
        try {
            if (actorType === 'admin') {
                // `admins` has no display-name column; the username IS the name
                // the product shows for an administrator everywhere else.
                const a = await db.get('SELECT username FROM admins WHERE id = ?', [actorId]);
                return a ? a.username || null : null;
            }
            const e = await db.get('SELECT first_name, last_name FROM employees WHERE id = ?', [
                actorId,
            ]);
            return e ? `${e.firstName || ''} ${e.lastName || ''}`.trim() || null : null;
        } catch (_) {
            return null;
        }
    }
}

module.exports = new TalentConfidentialityService();
