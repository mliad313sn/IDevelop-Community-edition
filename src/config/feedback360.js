'use strict';
/**
 * 360° feedback — pure data, no I/O.
 *
 * The questionnaire of a round is built from the subject's role skills (rated
 * 0–4 or "not observed") plus the behaviour statements below, then three open
 * comments. The behaviours are copied into the round when it is launched, so a
 * later edit of this file never changes a questionnaire already answered.
 */

/** Rater groups, in report order. */
const GROUPS = Object.freeze(['self', 'manager', 'peer', 'direct_report', 'other']);
/** Named groups: shown with a name, as users expect (one person each). */
const NAMED_GROUPS = Object.freeze(['self', 'manager']);
/** Anonymous groups: shown only aggregated, and only at or above the floor. */
const ANONYMOUS_GROUPS = Object.freeze(['peer', 'direct_report', 'other']);
/** The groups a subject (or their manager) may nominate someone into. */
const NOMINABLE_GROUPS = ANONYMOUS_GROUPS;

/** Default and minimum anonymity floor (responses per anonymous group). */
const DEFAULT_THRESHOLD = 3;
const MIN_THRESHOLD = 3;
/** Default minimum number of raters to nominate per anonymous group. */
const DEFAULT_MIN_RATERS = 3;

/** Open comments, in display order. */
const COMMENT_KINDS = Object.freeze(['keep', 'start', 'stop']);
const COMMENT_MAX = 2000;

/** Self minus others, in levels, from which a gap is called out. */
const GAP_THRESHOLD = 1;

/** Default behaviour statements (bilingual; UK English). */
const DEFAULT_BEHAVIOURS = Object.freeze([
    {
        key: 'b_listens',
        fr: 'Écoute les autres et tient compte de leur point de vue.',
        en: 'Listens to others and takes their view into account.',
    },
    {
        key: 'b_shares',
        fr: 'Partage l’information et ses connaissances avec l’équipe.',
        en: 'Shares information and knowledge with the team.',
    },
    {
        key: 'b_delivers',
        fr: 'Tient ses engagements et livre ce qui est convenu.',
        en: 'Keeps commitments and delivers what was agreed.',
    },
    {
        key: 'b_feedback',
        fr: 'Donne et reçoit du feedback de façon constructive.',
        en: 'Gives and receives feedback constructively.',
    },
    {
        key: 'b_safety',
        fr: 'Montre l’exemple en matière de sécurité et de qualité.',
        en: 'Sets an example on safety and quality.',
    },
    {
        key: 'b_adapts',
        fr: 'S’adapte au changement et aide les autres à le faire.',
        en: 'Adapts to change and helps others to do so.',
    },
]);

module.exports = {
    GROUPS,
    NAMED_GROUPS,
    ANONYMOUS_GROUPS,
    NOMINABLE_GROUPS,
    DEFAULT_THRESHOLD,
    MIN_THRESHOLD,
    DEFAULT_MIN_RATERS,
    COMMENT_KINDS,
    COMMENT_MAX,
    GAP_THRESHOLD,
    DEFAULT_BEHAVIOURS,
};
