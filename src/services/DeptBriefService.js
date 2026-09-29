'use strict';

/**
 * DeptBriefService — the CALCULATION core of the department brief (spec of
 * 13/09/2026, §2). It computes; it never notifies. No NotificationService, no
 * EmailService, no enqueue: the job (src/jobs/dept-brief.js) owns delivery, this
 * file owns the numbers. That separation is what makes the rendering testable
 * without a scheduler and the payload auditable on its own.
 *
 * The five rules that everything else here obeys — they are the part that is
 * easiest to get wrong, so they are implemented ONCE and applied everywhere:
 *
 *  R1  FOUR display states, never three: `cell` decides between "not
 *      measured" (—), "measured, zero", "not publishable" and "measured".
 *      It returns the state BEFORE any threshold comparison, because
 *      `null >= 80` is `false` and paints an em dash amber (live defect:
 *      dept-digest.js:132), and `(x || 0) >= 80` turns an unknown into a bad
 *      score (dept-digest.js:163). `?? null`, never `|| 0`.
 *  R2  ONE anonymity floor, MIN_PUBLISHABLE_OBSERVATIONS = 4 — the same value
 *      as SurveyService.minResponses (floor 5) and PIP_MIN_MEASURED_CLOSURES
 *      (DashboardController.js:8-13). The product has one convention; the brief
 *      does not get a second one. Measured on a development database: Northfield/IT has 1 person,
 *      Eastgate/IT 3, Westbrook/IT and Hillcrest/IT 4, and 8 of the 20 live
 *      (governor × department) couples hold 3 people or fewer. The small unit
 *      is the MAJORITY case here, not an edge case.
 *  R3  A unit label ALWAYS carries its population denominator. a local admin (#3) and
 *      another (#6) are each authorised over exactly ONE person in a department
 *      of 36; "Riverside / IT: 94 %" from such a scope reads as a departmental
 *      figure and is over-disclosure by appearance. Two holders of the same
 *      department comparing their briefs could otherwise reconstruct by
 *      difference the part they are not allowed to see.
 *  R4  Aggregation key is `department_id`, NEVER the name. The development database holds NINE
 *      departments named "IT" (one per site). `DashboardModel.getReadinessByGroup
 *      ('department')` groups by name and collapses them into one 71-person row
 *      carrying id 19 — it is forbidden here, together with
 *      `getOverviewKPIs({departmentIds})` without employeeIds,
 *      `avgReadinessAllRequirements`, and department-scoped `kpi_snapshots`.
 *  R5  The grid comes from the ROSTER; counters LEFT JOIN onto it. Grouping the
 *      FACTS loses a department that has no facts: the probe on skill_assessments
 *      returned 9 departments instead of 10 and Riverside / Internal Audit
 *      (5 people, 0 assessments) had simply evaporated. A department in distress
 *      must read "—", not be absent.
 *  R6  Scope is applied ROW BY ROW, via RBACService.scopeFilter, before every
 *      GROUP BY — never by org unit. `_buildFilterClause` treats departmentIds
 *      and employeeIds as independent branches, so a department id in a filter
 *      returns the WHOLE department.
 *  R10 TWO anchors, and they are never swapped. A FLUX
 *      counter is bounded by the CALENDAR period `[periodStart, periodEnd)`; a
 *      QUEUE — its count, its age, its SLA flag, its "stalled since", its
 *      "overdue" — is observed on the DAY OF COMPUTATION, `ctx.observedAt`,
 *      because that is what blocks A and B claim on the page ("constaté le jour
 *      d'envoi"). Anchoring an age on `periodEnd` while its count is taken now
 *      made the same line count an object and then date it as not yet existing
 *      (brief 325: 1 self-assessment, "oldest: -13 days"), and let anything
 *      submitted inside `[periodEnd, computedAt]` — up to 60 days on the yearly
 *      catch-up window — slip past its SLA unflagged. `observedAt` IS
 *      `payload.computedAt`: one instant, printed once, used everywhere.
 *
 * Everything is UTC and every query is SEQUENTIAL (§4.6): a tick may be
 * exercised from inside db.runTransaction (probes, tests, the "run now" button)
 * where all queries share ONE pg client, and a Promise.all fan-out raises
 * "client is already executing a query".
 */

const crypto = require('crypto');
const db = require('../config/database');
const { fmtPeriodBound, UNMEASURED } = require('../utils/dateFormat');

/**
 * the observation instant of a brief: the day the queues are looked at.
 *
 * Every block A / B figure that expresses "how old" or "since when" reads this,
 * never `win.periodEnd`. Callers that exercise a block on its own (probes,
 * tests) may omit it; the honest default is "now", which is what the block
 * claims to be measuring, and never the end of a period that closed weeks ago.
 */
function observedAtOf(ctx) {
    const a = ctx && ctx.observedAt;
    return a instanceof Date && !Number.isNaN(a.getTime()) ? a : new Date();
}

/**
 * Whole days between two instants, floored — the house age arithmetic.
 *
 * , the LAST way a negative age could still be minted. All three
 * callers measure time SINCE a past event (A1 oldest submission, A2 oldest
 * dispute, C2 oldest breach) against `observedAt`, and an elapsed time is never
 * negative. The anchor is now right, but `observedAt` is captured once, at
 * the start of the build, while the queue queries carry NO upper bound on the
 * event date: an item that lands between that instant and the query — or a row
 * whose timestamp is simply in the future, which an import can produce — would
 * floor to −1 and archive « -1 jour » all over again, on a payload nothing can
 * recompute afterwards. An event at or after the observation instant has waited
 * ZERO whole days, and that is what is published. The clamp cannot hide a
 * re-swapped anchor: `periodEnd` would still fail the two SLA tests of this
 * finding (a 19-day file must read 19 and raise its flag).
 */
function _ageDays(from, to) {
    return Math.max(0, Math.floor((to - new Date(from)) / 86400000));
}

/**
 * the deep links, resolved ONCE against the routes that are really
 * mounted (`SPEC §2.8`: "a link must match a route that is REALLY mounted").
 *
 * Three of the six were invented: `/talent/…` mounts only actions, career-path
 * and nine-box (routes/index.js), continuity lives under `/v2/continuity` and
 * key-person risk under `/exec/key-person`. « Coter la criticité des postes »,
 * the ONLY call to action of the whole brief, was a 404.
 */
const LINK = {
    keyPerson: '/exec/key-person',
    continuity: '/v2/continuity',
    // The retention LIST is a JSON endpoint (`/v2/continuity/retention` answers
    // `{ok:true,list:[…]}`, v2-continuity.js:281) — it is mounted, but it is not
    // a page: « Ouvrir la liste » used to hand the reader raw JSON. The page that
    // SHOWS that list is the continuity hub; `#ret-table` is the id of its
    // risk-of-loss table (continuity/index.ejs:261), so the reader lands on it.
    retention: '/v2/continuity#ret-table',
    // the disputes queue is mounted under the self-assessment router:
    // `/v2/slf/disputes` (v2-slf.js:70, manager or admin). `/v2/disputes` has
    // never existed.
    disputes: '/v2/slf/disputes',
    // two real LMS destinations, and they are NOT interchangeable: the hub
    // is gated by `configure_lms` (v2-lms.js:50) and the learner page by
    // employee-or-manager (v2-lms.js:217). Which one a brief may offer depends
    // on its READER — see `_readerLink`.
    lmsHub: '/v2/lms',
    myLearning: '/employee/my-learning',
    // the three admin queues whose pages live elsewhere than the slug the
    // family was named after.
    accountRequests: '/admin/accounts', // InvitationController.page, manage_invitations
    mobility: '/v2/cap', // the hub that lists opportunities + applicants
    makerChecker: '/v2/uam/maker-checker/queue', // MakerCheckerController.queue, superadmin
};

/**
 * The same targets under the names the ALREADY ARCHIVED payloads froze.
 * A brief is never recomputed when it is opened (that is the whole point of the
 * archive), so the 404s of every brief sent before this fix can only be repaired
 * at RENDER time. Nothing is rewritten in the archive.
 *
 * the rule of §2.8 is a CLASS rule, not a list of the three links a tester
 * happened to click: EVERY `link:` this file emits must be a route that is really
 * mounted. Five more were not (`/v2/disputes`, `/lms`, `/invitations`,
 * `/mobility`, `/admin/maker-checker`); they were invisible only because
 * `assessment_disputes`, `lms_enrollments`, `account_requests` and
 * `maker_checker_requests` are empty here. The producers below now emit the real
 * routes, and the aliases repair the payloads already archived.
 * `tests/unit/deptBriefLinks.test.js` pins the INVARIANT, not the names.
 */
const LEGACY_LINK_ALIAS = {
    '/talent/key-person-risk': LINK.keyPerson,
    '/continuity': LINK.continuity,
    '/talent/retention': LINK.retention,
    '/v2/continuity/retention': LINK.retention,
    '/v2/disputes': LINK.disputes,
    '/lms': LINK.lmsHub, // specialised per reader by `_readerLink` below
    '/invitations': LINK.accountRequests,
    '/mobility': LINK.mobility,
    '/admin/maker-checker': LINK.makerChecker,
};

/**
 * The one destination of the brief that depends on WHO opens it.
 *
 * The LMS has two pages and no third: the hub, gated by `configure_lms`
 * (v2-lms.js:50 — a manager reaches the MOUNT and is then refused by the
 * router's own guard), and the learner page, gated by employee-or-manager
 * (v2-lms.js:217 — an admin is bounced to /login). Nothing anywhere lists a
 * manager the overdue enrolments of their team. So a single frozen string
 * cannot be right for both readers, and « Ouvrir la liste » is offered only
 * when the reader really has a page: an admin without the grant gets the
 * figure and no link rather than a 403.
 *
 * `reader` is `{ isAdmin, canConfigureLms }` — the two facts of the SESSION
 * identity that is about to click, built by the controller
 * (`DeptBriefController.readerOf`). It is deliberately NOT resolved here: a
 * permission of the brief's PRODUCER is read with `RBACService.getPermissions`
 * on a principal that has no session, and the two must not be confused.
 * Without a reader (a job, a test) the link is left as it was frozen.
 */
function _readerLink(link, reader) {
    if (link !== LINK.lmsHub && link !== LINK.myLearning) return link;
    if (!reader) return link;
    if (reader.isAdmin) return reader.canConfigureLms ? LINK.lmsHub : null;
    // employee / manager — the learner page is the only LMS page they may open.
    return LINK.myLearning;
}

/**
 * Render-time link resolution for a frozen payload (M-11, widened to the whole
 * class by S10). `reader` is optional and only the LMS pair above reads it.
 */
function resolveLink(link, reader) {
    if (!link) return link;
    return _readerLink(LEGACY_LINK_ALIAS[String(link)] || String(link), reader);
}

/**
 * ──  / M-14 and A-15, the ALREADY-ARCHIVED half ────────────────────
 *
 * Correcting the PRODUCER leaves the 45 briefs that were already computed and
 * sent saying exactly what the report said they said: the sentences, the labels
 * and the bucket columns are FROZEN in the payload and the page prints them
 * verbatim. `tick({force:true})` can write a NEW version of an archived brief,
 * but it has never run and running it would replace figures a reader has already
 * been shown. So the repair happens where M-11 already repairs the dead deep
 * links: at RENDER time, on a COPY. Nothing is written back to `dept_briefs`.
 *
 * WHAT IS REPAIRED, and on what evidence — never a figure, only the SENTENCE
 * that describes a figure and the agreement of its nouns:
 *
 *  A-09/M-14  the C1 certification buckets. The archived SQL froze 30 on both
 *             sides (`BETWEEN 0 AND 30`, then `> 30 AND <= horizon`), so a
 *             weekly (horizon 14) or monthly (horizon 30) brief announced a
 *             third bucket « 31–30 j » / « 31–14 j » — an interval whose upper
 *             bound is below its lower one — and rendered a column that was
 *             EMPTY BY CONSTRUCTION: « Au-delà de 30 jours : 0 », a zero no data
 *             could ever have produced, against the house rule that an absence
 *             is never a 0. The bounds are re-derived from the payload's OWN
 *             `horizonDays` using the ARCHIVED semantics (near bucket 0–30, far
 *             bucket 31–horizon when there is room), so the sentence describes
 *             what was really counted; the impossible column is dropped, not
 *             recomputed. A quarterly/yearly brief (horizon 90/180) had a real
 *             third bucket and comes out of this unchanged.
 *  A-15(1)    the C3 note, rebuilt from the line's own `occupiedRoles`
 *             (« 1 postes occupés » → « 1 poste occupé »).
 *  A-15(2)    the English unit label, whose noun is governed by the DENOMINATOR
 *             (« 1 of 36 person » → « 1 of 36 people »). The French twin was
 *             already right and is not touched.
 *  A-15(3)    every `days` cell, re-rendered from its own frozen `value`
 *             (« -13 jour » → « -13 jours », « 0 day » → « 0 days »). The number
 *             is the archived one; only its unit word moves.
 *  M-08/A-02  the one exception to « never a figure »: an age that is
 *             ARITHMETICALLY IMPOSSIBLE (negative) is not a measurement the
 *             archive can defend, so it is voided and explained instead of being
 *             published — 7 briefs out of 45, all « -13 jour ». No replacement
 *             figure is invented; see `_voidImpossibleAges` for why none can be.
 *
 * Idempotent by construction: a payload computed AFTER the producer fix carries
 * `buckets`, correct nouns and correct day words, and comes back identical.
 */
/** The near bound every ARCHIVED C1 section counted with, hard-coded in its SQL. */
const LEGACY_C1_SOON_MAX = 30;

function _isCell(v) {
    return !!(
        v &&
        typeof v === 'object' &&
        typeof v.state === 'string' &&
        v.text &&
        typeof v.text === 'object'
    );
}

/** A-15(2) — the noun of « of N person/people » follows N, wherever it appears. */
function _repairEnLabel(label) {
    if (!label || typeof label !== 'object' || typeof label.en !== 'string') return;
    label.en = label.en.replace(
        /\bof (\d+) (?:person|people)\b/g,
        (_m, n) => `of ${n} ${Number(n) === 1 ? 'person' : 'people'}`
    );
}

/** A-15(3) — a `days` cell says its number with the right unit word. */
function _repairCells(holder) {
    if (!holder || typeof holder !== 'object') return;
    for (const k of Object.keys(holder)) {
        const v = holder[k];
        if (_isCell(v) && v.unit === 'days' && typeof v.value === 'number')
            v.text = daysText(v.value);
    }
}

/**
 * ──  / A-02, the ALREADY-ARCHIVED half ─────────────────────────────
 *
 * The producer now ages every queue on `observedAt`, so no brief computed
 * from today on can carry a negative age. The seven monthly briefs that were
 * already computed and SENT still do: 325, 329, 334, 344, 348, 349 and 351 each
 * froze `A1.oldestAge = -13` — the count taken at `computed_at` (14/09), the age
 * taken against `period_end` (01/09) — and the page went on serving « Le plus
 * ancien : -13 jour », the exact sentence the finding opened on. Repairing the
 * plural (A-15) only turned it into « -13 jours ».
 *
 * A NEGATIVE QUEUE AGE IS NOT A MEASUREMENT THE ARCHIVE CAN PROTECT. « L'état
 * est celui du jour d'envoi » is a defence for a figure that was true then; this
 * one says the oldest item of the queue was submitted after the queue was looked
 * at, which was no more true on 14/09 than it is today. It is the arithmetic
 * residue of the swapped anchor, so it is VOIDED at render time, on the same
 * copy and in the same place as the dead deep links of M-11 — the only way to
 * reach a brief that is already in somebody's mailbox.
 *
 * VOIDED, NOT CORRECTED. The age the brief should have printed is NOT
 * recoverable from the archive: the frozen number is a FLOOR, so the oldest
 * submission is only known to within a day and a reconstructed age would be out
 * by one — an opposable document does not print an estimate as a measurement.
 * The page therefore says the age is not restorable and says WHY, with both
 * instants and the archived number, and invents nothing. Everything else on the
 * line is untouched: the COUNT was taken on the day of computation and is right,
 * and `overdue` keeps the value it was sent with — this repair adds no claim it
 * cannot support.
 */
const VOIDED_AGE = 'impossible_age';

/** The sentence, in both languages, with the two instants that contradict. */
function impossibleAgeNote(archived, ctx) {
    const at = fmtPeriodBound(ctx && ctx.periodEnd);
    const on = fmtPeriodBound(ctx && ctx.computedAt);
    const n = Number(archived);
    return {
        fr: `Ancienneté non restituable : ce bilan l’a mesurée au ${at} (fin de période) alors que la file, elle, est constatée au ${on} (jour du calcul). La valeur archivée (${n} j) est impossible — rien ne peut être déposé après avoir été constaté — et n’est pas publiée. Le nombre, lui, est bien celui du jour du calcul.`,
        en: `Age not restorable: this brief measured it against ${at} (period end) while the queue itself was observed on ${on} (day of computation). The archived value (${n} d) is impossible — nothing can be submitted after it was observed — and is not published. The count itself is the one taken on the day of computation.`,
    };
}

/** The voided cell: grey, no value, and its own reason where the figure was. */
function _voidedAgeCell(v, ctx) {
    return {
        ...v,
        value: null,
        state: STATES.UNMEASURED,
        color: GREY,
        voided: VOIDED_AGE,
        archivedValue: v.value,
        // Printed after the field's own label (« Le plus ancien : … »), so the
        // noun is not repeated; the whole reason is one hover — and one line —
        // away.
        text: { fr: 'non restituable', en: 'not restorable' },
        hint: impossibleAgeNote(v.value, ctx),
    };
}

/**
 * M-08 — void every impossible age carried by one line (or footer unit) and
 * return the sentence that explains it, or null when there is nothing to void.
 * A payload computed after the producer fix has no negative age and comes back
 * untouched, which is what makes the repair idempotent.
 */
function _voidImpossibleAges(holder, ctx) {
    if (!holder || typeof holder !== 'object') return null;
    let note = null;
    for (const k of Object.keys(holder)) {
        const v = holder[k];
        if (
            _isCell(v) &&
            v.unit === 'days' &&
            v.kind === 'queue' &&
            typeof v.value === 'number' &&
            v.value < 0
        ) {
            note = note || impossibleAgeNote(v.value, ctx);
            holder[k] = _voidedAgeCell(v, ctx);
        }
    }
    // C2 carries the same measurement without the cell wrapper (« rompue depuis
    // n jour(s) »). A negative one is removed, never printed.
    if (typeof holder.oldestBreachDays === 'number' && holder.oldestBreachDays < 0) {
        note = note || impossibleAgeNote(holder.oldestBreachDays, ctx);
        holder.voidedBreachAge = holder.oldestBreachDays;
        delete holder.oldestBreachDays;
    }
    return note;
}

function repairFrozenPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    // A structural copy. The archive row must be unreachable from here: a repair
    // that cannot touch the stored object cannot rewrite history by accident.
    let p;
    try {
        p = JSON.parse(JSON.stringify(payload));
    } catch (_) {
        return payload;
    }

    const horizon = Number(p.horizonDays);
    // M-08 — the two instants the voided-age sentence has to name. They are the
    // payload's OWN, never today's: the reader is told what this brief did.
    const ageCtx = { periodEnd: p.periodEnd, computedAt: p.computedAt };

    // A-17 (residual) — the §2.1 sentence of a brief archived BEFORE the
    // producer fix names no day (« constaté le jour d’envoi »). It is rebuilt
    // here from the payload's OWN `computedAt`, exactly as M-11 resolves the
    // frozen deep links on the way out: no figure moves, nothing is written.
    _repairNatureOfFigures(p);

    (Array.isArray(p.units) ? p.units : []).forEach((u) => _repairEnLabel(u && u.label));
    if (p.footer && Array.isArray(p.footer.units)) {
        p.footer.units.forEach((u) => {
            _repairEnLabel(u && u.label);
            _repairCells(u);
            _voidImpossibleAges(u, ageCtx);
        });
    }

    const blocks = p.blocks && typeof p.blocks === 'object' ? p.blocks : {};
    for (const key of Object.keys(blocks)) {
        const sections = Array.isArray(blocks[key]) ? blocks[key] : [];
        for (const s of sections) {
            if (!s || typeof s !== 'object') continue;
            const lines = Array.isArray(s.lines) ? s.lines : [];

            // A-09 / M-14 — the buckets, from this brief's own horizon.
            // `s.buckets` present ⇒ computed after the producer fix ⇒ nothing to do.
            if (s.id === 'C1' && !s.buckets && Number.isFinite(horizon) && horizon > 0) {
                const soonMax = LEGACY_C1_SOON_MAX;
                const hasLater = horizon > soonMax;
                s.buckets = { soonMax, laterMax: hasLater ? horizon : null };
                s.rule = c1Rule(soonMax, horizon, hasLater);
                // The column that no data could ever fill is REMOVED, not zeroed.
                if (!hasLater)
                    lines.forEach((l) => {
                        if (l) delete l.expiringLater;
                    });
            }

            for (const l of lines) {
                if (!l || typeof l !== 'object') continue;
                _repairEnLabel(l.label);
                _repairCells(l);
                // M-08 — an age that is arithmetically impossible is voided and
                // explained, ON THE LINE, so the reason is read without hovering
                // a tooltip. An existing note is never overwritten (only C3 has
                // one, and it carries no age); the cell keeps the sentence too.
                const voidedNote = _voidImpossibleAges(l, ageCtx);
                if (voidedNote && !l.note) l.note = voidedNote;
                // A-15(1) — only the C3 note, and only in the state that produces
                // it (nothing rated); rebuilt from the line's own count.
                if (
                    s.id === 'C3' &&
                    l.note &&
                    typeof l.occupiedRoles === 'number' &&
                    !l.ratedRoles
                ) {
                    l.note = c3Note(l.occupiedRoles);
                }
            }
        }
    }
    return p;
}

/**
 * the single anonymity floor. Mirrors SurveyService (MIN_RESPONSES_FLOOR 5),
 * DEIService / BiasDetectionService (5) and DashboardController.PIP_MIN_MEASURED_CLOSURES (5). Changing it here
 * without changing those makes the product contradict itself.
 */
const MIN_PUBLISHABLE_OBSERVATIONS = 5;

// The only four colours a cell may carry. Grey is reserved for "we do not know"
// — an unmeasured value is NEVER amber and NEVER red.
const GREY = '#64748b';
const GREEN = '#15803d';
const AMBER = '#b45309';
const RED = '#b91c1c';

const STATES = Object.freeze({
    UNMEASURED: 'unmeasured',
    NOT_PUBLISHABLE: 'not_publishable',
    ZERO: 'zero',
    MEASURED: 'measured',
});

/**
 * Which way is "good", PER METRIC. It drives the COLOUR, never the sign: a green
 * arrow on a rise in key-person exposure is a contradiction in terms (§2.6 c).
 */
const METRIC_DIRECTION = Object.freeze({
    measuredPeople: 'higher_is_better',
    assessmentCoverage: 'higher_is_better',
    flowActions: 'higher_is_better',
    selfAssessmentsSubmitted: 'higher_is_better',
    reviewsClosed: 'higher_is_better',
    soleHolder: 'lower_is_better',
    certsExpiring: 'lower_is_better',
    coverageBreaches: 'lower_is_better',
});

// ---------------------------------------------------------------------------
// the one renderer of a value
// ---------------------------------------------------------------------------

function frNum(n) {
    if (n === null || n === undefined) return null;
    return String(Math.round(Number(n) * 10) / 10).replace('.', ',');
}
function enNum(n) {
    if (n === null || n === undefined) return null;
    return String(Math.round(Number(n) * 10) / 10);
}

/**
 * (3) — « n days », in both languages, ONCE.
 *
 * `n > 1` is false for EVERY negative value and for 0, so the same test printed
 * « -13 jour » and « 0 day ». The two languages do not share a rule: French
 * takes the plural from |n| ≥ 2, English from anything that is not exactly one
 * day. This lives outside `cell` because the REPAIR of the already-archived
 * briefs (repairFrozenPayload) must render the identical sentence — a second
 * copy of the rule is a second place for it to be wrong.
 */
function daysText(n) {
    const v = Number(n);
    return {
        fr: `${v} jour${Math.abs(v) >= 2 ? 's' : ''}`,
        en: `${v} day${Math.abs(v) === 1 ? '' : 's'}`,
    };
}

/**
 * (1) — the C3 sentence prescribed word for word by SPEC §2.4, with its
 * nouns agreeing with the count instead of frozen in the plural
 * (« 1 postes occupés »). Shared with repairFrozenPayload for the same reason as
 * `daysText`.
 */
function c3Note(occupiedRoles) {
    const n = Number(occupiedRoles) || 0;
    return {
        fr: `criticité des postes non renseignée : ${n} poste${n > 1 ? 's' : ''} occupé${n > 1 ? 's' : ''}, 0 coté`,
        en: `role criticality not filled in: ${n} role${n > 1 ? 's' : ''} occupied, 0 rated`,
    };
}

/**
 *  / M-14 — the C1 rule sentence, written from the bounds the section
 * REALLY used. `hasLater` is false when the horizon leaves the third bucket no
 * room; the sentence then names two buckets, not a « 31–30 j » interval whose
 * upper bound sits below its lower one.
 *
 * The « (horizon de la cadence) » parenthetical is EARNED, not decorative: it is
 * printed only when the near bound really is the cadence horizon. A brief the
 * job archived BEFORE the producer fix counted 0–30 whatever its cadence, so on
 * a repaired WEEKLY brief (horizon 14) the parenthetical would be a false claim
 * about a frozen figure — and that is the one thing this page may never do.
 */
function c1Rule(soonMax, horizon, hasLater) {
    const isHorizon = Number(soonMax) === Number(horizon);
    return {
        fr: hasLater
            ? `expirée (< 0 j), 0–${soonMax} j, ${soonMax + 1}–${horizon} j ; aucun registre ⇒ « — », jamais 0`
            : `expirée (< 0 j), 0–${soonMax} j${isHorizon ? ' (horizon de la cadence)' : ''} ; aucun registre ⇒ « — », jamais 0`,
        en: hasLater
            ? `expired (< 0 d), 0–${soonMax} d, ${soonMax + 1}–${horizon} d; no register ⇒ "—", never 0`
            : `expired (< 0 d), 0–${soonMax} d${isHorizon ? ' (the cadence horizon)' : ''}; no register ⇒ "—", never 0`,
    };
}

/**
 * , arbitrage §7-1 — the §2.1 sentence, carrying the DATE its figures
 * were observed on (« constaté le JJ/MM/AAAA »), in both languages.
 *
 * Shared with `repairFrozenPayload` for exactly the reason `c1Rule`, `c3Note`
 * and `daysText` are: the producer fix is not retroactive, and the 45 briefs
 * archived before it carry the generic « constaté le jour d’envoi ». An archive
 * is never rewritten, so the only honest repair is to rebuild the sentence at
 * render time from the instant the archive itself carries (`computedAt`) — the
 * same instant the page already prints two lines below (« Chiffres figés au … »).
 * One builder ⇒ a repaired archive and a fresh brief say the same words.
 */
function natureOfFiguresText(observedAt) {
    const on = fmtPeriodBound(observedAt);
    return {
        fr:
            `A = ce qui s’est passé pendant la période · B = ce qu’il y a à faire, constaté le ${on} · ` +
            'C = ce qui arrive avant la prochaine période. Les vues du produit ne sont pas historisées : ' +
            'l’état est celui du jour d’envoi.',
        en:
            `A = what happened during the period · B = what is outstanding, as observed on ${on} · ` +
            'C = what falls due before the next period. The product views are not historised: ' +
            'the state is the state of the sending day.',
    };
}

/**
 * The generic formula the pre-fix briefs carry, word for word, one per language.
 * It is the ONLY trigger of the repair: a payload computed after the producer
 * fix already names its day and is returned untouched (idempotence), and a
 * payload carrying some other sentence is never second-guessed.
 */
const LEGACY_NATURE_OF_FIGURES = Object.freeze({
    fr: 'constaté le jour d’envoi',
    en: 'as observed on the sending day',
});

/**
 * A-17 (residual) — repair the frozen §2.1 sentence of an ARCHIVED payload.
 * Nothing is written back; the caller works on `repairFrozenPayload`'s copy.
 * When the archive has no usable instant to name, the generic sentence is KEPT:
 * « constaté le — » would be a worse statement, not a better one.
 */
function _repairNatureOfFigures(p) {
    const n = p && p.natureOfFigures;
    if (!n || typeof n !== 'object') return;
    const stale =
        (typeof n.fr === 'string' && n.fr.includes(LEGACY_NATURE_OF_FIGURES.fr)) ||
        (typeof n.en === 'string' && n.en.includes(LEGACY_NATURE_OF_FIGURES.en));
    if (!stale) return;
    if (fmtPeriodBound(p.computedAt) === UNMEASURED) return;
    p.natureOfFigures = natureOfFiguresText(p.computedAt);
}

/**
 * The ONE cell renderer. Every published figure goes through it.
 *
 * @param {number|null} value   the figure, or null when NOTHING was measured
 * @param {object} opts
 * @param {'count'|'pct'|'ratio'|'days'} [opts.unit='count']
 * @param {number|null} [opts.denom]   the MEASURED denominator (ratios)
 * @param {number|null} [opts.population]  the PEOPLE behind the figure
 * @param {'ratio'|'restricted'|'queue'} [opts.kind='queue']
 *        'ratio'      — any rate: suppressed when fewer than 4 OBSERVATIONS sit
 *                       behind it. When the caller knows how many PEOPLE the
 *                       rate aggregates (`population`), that is the floor test,
 *                       not the raw denominator: "matrix completion 100 %" over
 *                       one person's 44 requirement cells has a denominator of
 *                       44 and still publishes that ONE person's score. Measured:
 *                       governor #123 governs exactly one person, and Northfield/IT
 *                       holds one.
 *        'restricted' — a count from a restricted source (flight risk, 9-box):
 *                       suppressed when the unit headcount < 5
 *        'queue'      — a count of objects the recipient ALREADY governs
 *                       (pending reviews, PIPs to activate, disputes). It stays
 *                       publishable below the floor: they already hold those
 *                       objects. The RATE is suppressed, never the work queue.
 * @param {{good:number, warn:number, direction:'higher'|'lower'}} [opts.thresholds]
 * @param {{fr:string,en:string}} [opts.suffix]  denominator sentence appended
 * @param {string} [opts.source] [opts.rule] [opts.link]  the defensible footer (§2.8)
 */
function cell(value, opts = {}) {
    const {
        unit = 'count',
        denom = null,
        population = null,
        kind = 'queue',
        thresholds = null,
        suffix = null,
        source = null,
        rule = null,
        link = null,
    } = opts;

    const base = {
        value: value === undefined ? null : value,
        denom,
        population,
        unit,
        kind,
        source,
        rule,
        link,
    };

    // 1. Nothing was measured. This is decided FIRST and it short-circuits: no
    //    threshold, no colour, no arithmetic on a null.
    if (value === null || value === undefined) {
        return {
            ...base,
            state: STATES.UNMEASURED,
            text: { fr: '—', en: '—' },
            color: GREY,
            hint: {
                fr: 'Jamais évalué — aucune donnée, ce n’est pas un niveau 0.',
                en: 'Never assessed — no data, this is not a zero.',
            },
        };
    }

    // 2. Anonymity floor. It is checked BEFORE the zero case on purpose: a rate
    //    of 0 over a denominator of 1 discloses that one person's state just as
    //    surely as a rate of 100. Suppressing only non-zero values would leak
    //    exactly the cases that matter.
    const floorDenom =
        kind === 'ratio' ? (population ?? denom) : kind === 'restricted' ? population : null;
    if (kind === 'ratio' || kind === 'restricted') {
        // A missing denominator on a suppressible figure fails CLOSED.
        if (
            floorDenom === null ||
            floorDenom === undefined ||
            Number(floorDenom) < MIN_PUBLISHABLE_OBSERVATIONS
        ) {
            return {
                ...base,
                state: STATES.NOT_PUBLISHABLE,
                text: {
                    fr: `non publiable (effectif < ${MIN_PUBLISHABLE_OBSERVATIONS})`,
                    en: `not publishable (headcount < ${MIN_PUBLISHABLE_OBSERVATIONS})`,
                },
                color: GREY,
                hint: {
                    fr: `Le seuil d’anonymat du produit est de ${MIN_PUBLISHABLE_OBSERVATIONS} observations.`,
                    en: `The product’s anonymity floor is ${MIN_PUBLISHABLE_OBSERVATIONS} observations.`,
                },
            };
        }
    }

    const n = Number(value);
    const color = _colorFor(n, thresholds);
    let fr, en;
    if (unit === 'pct') {
        fr = `${frNum(n)} %`;
        en = `${enNum(n)}%`;
    } else if (unit === 'ratio') {
        // A ZERO numerator publishes the COUNT and NOT the rate. "0/794" is a
        // true statement about a department nobody has assessed; "0/794 (0,0 %)"
        // invites the reader to compare it with a real 94,4 % — which is exactly
        // the defect migration 118 removes from v_department_matrix_completion,
        // where Riverside / Internal Audit was published at 0,0 % with 0 of 794
        // cells ever evaluated.
        const pct = denom && n !== 0 ? Math.round((1000 * n) / denom) / 10 : null;
        fr = `${n}/${denom}` + (pct === null ? '' : ` (${frNum(pct)} %)`);
        en = `${n}/${denom}` + (pct === null ? '' : ` (${enNum(pct)}%)`);
    } else if (unit === 'days') {
        // (3) — see daysText: one rule, shared with the repair of the
        // already-archived briefs.
        ({ fr, en } = daysText(n));
    } else {
        fr = String(n);
        en = String(n);
    }
    if (suffix) {
        fr += ` ${suffix.fr}`;
        en += ` ${suffix.en}`;
    }

    return {
        ...base,
        // 3/4. A measured zero is a RESULT and says so; it is not an em dash.
        state: n === 0 ? STATES.ZERO : STATES.MEASURED,
        text: { fr, en },
        color,
        hint: null,
    };
}

/** Colour, applied ONLY to a real number (never inside the null branches). */
function _colorFor(n, thresholds) {
    if (!thresholds) return null;
    const { good, warn, direction = 'higher' } = thresholds;
    if (direction === 'higher') {
        if (n >= good) return GREEN;
        if (warn !== undefined && n >= warn) return AMBER;
        return warn === undefined ? AMBER : RED;
    }
    if (n <= good) return GREEN;
    if (warn !== undefined && n <= warn) return AMBER;
    return warn === undefined ? AMBER : RED;
}

// ---------------------------------------------------------------------------
// scope, resolved ONCE and applied row by row
// ---------------------------------------------------------------------------

/**
 * The recipient's visible employee ids, resolved through RBACService.scopeFilter
 * — the ONE scope authority (admin_scopes via utils/adminScope for admins, the
 * governed sub-tree via EmployeeModel.findGovernedIds for employees).
 *
 * `scopeFilter` is called ONCE and its ids are reused for every query of the
 * brief, because the whole computation runs inside a single read transaction:
 * re-resolving per query would be both slow and, worse, able to DRIFT mid-brief
 * if a scope were revoked between two statements.
 *
 * NOTE the admin branch never touches `siteIds`/`departmentIds`/`serviceIds`.
 * Those are DELIBERATELY wider than the data scope (adminScope.js:36-45 hands a
 * department-scoped admin the PARENT SITE id so their dropdowns can render the
 * value their people carry); using them as a data filter is guaranteed
 * over-disclosure. `[]` means NOTHING, never "everything".
 */
async function scopeOf(recipient) {
    const type = recipient && recipient.type === 'admin' ? 'admin' : 'employee';
    const id = Number(recipient && recipient.id);
    const principal =
        type === 'admin'
            ? { id, userType: 'admin', role: recipient.role }
            : { id, userType: 'employee' };

    const RBACService = require('./RBACService');
    const f = await RBACService.scopeFilter(principal, { empAlias: '__scope' });
    let ids;
    if (f.clause === '')
        ids = null; // superadmin — unrestricted
    else if (!f.params.length)
        ids = []; // ' AND 1=0' — nothing visible
    else ids = (f.params[0] || []).map(Number);

    return {
        type,
        id,
        role: principal.role || null,
        ids,
        unrestricted: ids === null,
        size: ids === null ? null : ids.length,
        principal,
        /** The same `= ANY(?)` fragment scopeFilter emits, for any alias/column. */
        filter(alias, column = 'id') {
            return scopeClause(ids, alias, column);
        },
    };
}

/** `{ clause, params }` in scopeFilter's own shape. */
function scopeClause(ids, alias, column = 'id') {
    if (ids === null) return { clause: '', params: [] };
    if (!ids.length) return { clause: ' AND 1 = 0', params: [] };
    const qualified = alias ? `${alias}.${column}` : column;
    return { clause: ` AND ${qualified} = ANY(?)`, params: [ids] };
}

/** Accepts a scope object, an ids array, or null (unrestricted). */
function _normaliseScope(scopeOrIds) {
    if (
        scopeOrIds &&
        typeof scopeOrIds === 'object' &&
        !Array.isArray(scopeOrIds) &&
        'ids' in scopeOrIds
    ) {
        return scopeOrIds;
    }
    const ids = scopeOrIds === null || scopeOrIds === undefined ? null : scopeOrIds.map(Number);
    return {
        type: 'employee',
        id: null,
        role: null,
        ids,
        unrestricted: ids === null,
        size: ids === null ? null : ids.length,
        principal: null,
        filter(alias, column = 'id') {
            return scopeClause(ids, alias, column);
        },
    };
}

/**
 * DIRECT reports only — the named-people exception of §2.4 C1b.
 *
 * Deliberately NOT findGovernedIds: that is the whole sub-tree, and naming
 * people three levels away in an email is a different act entirely. Deliberately
 * not EmployeeModel.findSubordinates either, even though it resolves the same
 * shape: that one is the DISPLAY list and it is not the brief's authority — two
 * populations resolved by two functions is how the same person ends up with two
 * different headcounts. This set is named, local, and used for exactly one thing.
 */
async function directReportIds(employeeId) {
    const rows = await db.all(
        `SELECT id FROM employees
          WHERE is_active
            AND (supervisor_id = ? OR (manager_id = ? AND manager_type = 'employee'))`,
        [Number(employeeId), Number(employeeId)]
    );
    return rows.map((r) => Number(r.id));
}

// ---------------------------------------------------------------------------
// R4 + R5 — the roster grid
// ---------------------------------------------------------------------------

/**
 * The department grid of a brief: one row per department the recipient's people
 * actually belong to, keyed by `department_id` and built from the ROSTER
 *. Every counter downstream LEFT JOINs onto this list, so a department with
 * no facts renders "—" instead of disappearing.
 *
 * Publishes, per unit:
 *   headcount            people IN SCOPE (the brief's denominator)
 *   totalHeadcount       people in the department, all scopes (R3's "sur 36")
 *   wholeDepartment      scope covers the department ENTIRELY (C0's gate)
 *   withoutRequirements  in-scope people with no requirement defined — the gap
 *                        between the roster and the requirement population.
 *                        dept-digest.departmentStats (:50-56) derives headcount
 *                        from v_employee_skill_gaps, i.e. from REQUIREMENTS, so
 *                        a person with no role requirement is simply not there.
 */
async function rosterGrid(scopeOrIds) {
    const scope = _normaliseScope(scopeOrIds);
    const f = scope.filter('ed', 'employee_id');

    const rows = await db.all(
        `SELECT ed.department_id AS "departmentId", ed.site_id AS "siteId",
                ed.site_name AS "siteName", ed.department_name AS "departmentName",
                COUNT(*)::int AS headcount
           FROM v_employee_details ed
          WHERE ed.is_active${f.clause}
          GROUP BY 1, 2, 3, 4
          ORDER BY 3, 4`,
        [...f.params]
    );
    if (!rows.length) return [];

    const deptIds = rows.map((r) => Number(r.departmentId));
    // Department-wide populations. This is a HEADCOUNT ONLY — no names, no
    // per-person fact — and R3 requires it: "votre périmètre : 1 personne sur 36"
    // is the sentence that stops a 1/36 slice being read as a department.
    const totals = await db.all(
        `SELECT department_id AS "departmentId", COUNT(*)::int AS n
           FROM v_employee_details WHERE is_active AND department_id = ANY(?) GROUP BY 1`,
        [deptIds]
    );
    const totalBy = _indexBy(totals, 'departmentId', 'n');

    const fc = scope.filter('c', 'employee_id');
    const withReq = await db.all(
        `SELECT c.department_id AS "departmentId", COUNT(*)::int AS n
           FROM v_employee_assessment_coverage c
          WHERE c.expected_skills > 0${fc.clause}
          GROUP BY 1`,
        [...fc.params]
    );
    const reqBy = _indexBy(withReq, 'departmentId', 'n');

    return rows.map((r) => {
        const departmentId = Number(r.departmentId);
        const headcount = Number(r.headcount);
        const totalHeadcount = totalBy[departmentId] ?? headcount;
        const withRequirements = reqBy[departmentId] ?? 0;
        return {
            departmentId,
            siteId: r.siteId === null ? null : Number(r.siteId),
            siteName: r.siteName,
            departmentName: r.departmentName,
            unitName: `${r.siteName} / ${r.departmentName}`,
            headcount,
            totalHeadcount,
            // Equivalent to the spec's "count of in-department people outside the
            // scope = 0", in one query instead of one per department.
            wholeDepartment: scope.unrestricted || headcount === totalHeadcount,
            withRequirements,
            withoutRequirements: Math.max(0, headcount - withRequirements),
        };
    });
}

/** R3 — the label, which always carries its population. */
function unitLabel(unit, scope) {
    const { unitName, headcount, totalHeadcount } = unit;
    const p = (n, fr, en) => ({
        fr: `${n} ${fr}${n > 1 ? 's' : ''}`,
        en: `${n} ${en}${n > 1 ? 's' : ''}`,
    });
    const pop = p(headcount, 'personne', 'person');
    if (scope.type === 'admin') {
        // (2). In « 1 of 36 people » the noun is governed by the
        // DENOMINATOR, not by the numerator: deciding on `headcount` printed
        // « your scope: 1 of 36 person ». The French twin below was already
        // right, which is why only the English line moves.
        return {
            fr: `${unitName} — votre périmètre : ${pop.fr} sur ${totalHeadcount}`,
            en: `${unitName} — your scope: ${headcount} of ${totalHeadcount} ${totalHeadcount > 1 ? 'people' : 'person'}`,
        };
    }
    return {
        fr: `Votre équipe dans ${unitName} — ${pop.fr}`,
        en: `Your team in ${unitName} — ${headcount} ${headcount > 1 ? 'people' : 'person'}`,
    };
}

function _indexBy(rows, key, valueKey) {
    const out = {};
    for (const r of rows || []) out[Number(r[key])] = valueKey ? r[valueKey] : r;
    return out;
}

/**
 * The LEFT JOIN, done in JS: walk the GRID and read the counter map. Never walk
 * the counter rows — that is exactly how a department without facts vanishes.
 */
function _onGrid(grid, map, fallback = 0) {
    return grid.map((u) => ({ unit: u, n: map[u.departmentId] ?? fallback }));
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function _section(id, fr, en, extra = {}) {
    return { id, title: { fr, en }, severity: 'action', lines: [], ...extra };
}

/** R8 — a section with nothing to say is OMITTED, never rendered as "0". */
function _keepNonEmpty(sections) {
    return sections.filter((s) => s && Array.isArray(s.lines) && s.lines.length > 0);
}

/**
 * BLOCK A — À DÉCIDER. What is waiting for the recipient's signature.
 * Everything here is a work QUEUE the recipient already governs, so the counts
 * stay publishable below the anonymity floor (R2, third bullet) — except A4
 * (9-box), whose SOURCE is restricted.
 */
async function blocksA(ctx) {
    const { scope, grid, win, settings } = ctx;
    // block A is a QUEUE: everything in it is observed TODAY, never at the
    // end of the reported period.
    const observedAt = observedAtOf(ctx);
    const out = [];
    const deptIds = grid.map((u) => u.departmentId);
    if (!deptIds.length) return out;

    // ---- A1 self-assessments awaiting review -------------------------------
    // dept-digest.js:77-80, with the IN-list replaced by `= ANY(?)` and the AGE
    // of the oldest added: a count without an age cannot be triaged.
    {
        const f = scope.filter('e', 'id');
        const rows = await db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n,
                    MIN(sa.submitted_at) AS "oldest"
               FROM self_assessments sa JOIN employees e ON e.id = sa.employee_id
              WHERE sa.workflow_state IN ('submitted','under_review')${f.clause}
              GROUP BY 1`,
            [...f.params]
        );
        const by = _indexBy(rows, 'departmentId');
        const sla = settings.reviewSlaDays;
        const lines = [];
        for (const u of grid) {
            const r = by[u.departmentId];
            if (!r || !Number(r.n)) continue; // R8 — nothing to say, no line
            // the COUNT above has no period bound, so the AGE must not
            // have one either: the same line used to count an item submitted on
            // 13/09 and then date it « -13 jours » against a period that closed
            // on 01/09.
            const ageDays = r.oldest ? _ageDays(r.oldest, observedAt) : null;
            lines.push({
                unitId: u.departmentId,
                label: unitLabel(u, scope),
                count: cell(Number(r.n), {
                    unit: 'count',
                    kind: 'queue',
                    source: 'self_assessments',
                    link: '/supervisor/self-assessment-reviews',
                }),
                oldestAge: cell(ageDays, { unit: 'days', kind: 'queue' }),
                overdue: ageDays !== null && ageDays > sla,
            });
        }
        if (lines.length) {
            out.push(
                _section('A1', 'Auto-évaluations à valider', 'Self-assessments to review', {
                    lines,
                    source: 'self_assessments',
                    rule: {
                        fr: `workflow_state ∈ (submitted, under_review) ; « hors délai » au-delà de ${sla} jours`,
                        en: `workflow_state ∈ (submitted, under_review); "overdue" past ${sla} days`,
                    },
                    link: '/supervisor/self-assessment-reviews',
                })
            );
        }
    }

    // ---- A2 disputes to arbitrate ------------------------------------------
    // The `dispute_state` enum is open | resolved | escalated | auto_finalized.
    // There is NO 'closed': `IN (…,'closed')` raises 22P02, which is an ERROR,
    // not an empty result. `resolved_at IS NULL` is the honest open test.
    {
        const f = scope.filter('e', 'id');
        const rows = await db.all(
            `SELECT e.department_id AS "departmentId", d.level::text AS level, COUNT(*)::int AS n,
                    MIN(COALESCE(d.escalated_at, d.opened_at)) AS "since"
               FROM assessment_disputes d JOIN employees e ON e.id = d.employee_id
              WHERE d.resolved_at IS NULL${f.clause}
              GROUP BY 1, 2`,
            [...f.params]
        );
        const lines = [];
        for (const u of grid) {
            for (const r of rows.filter((x) => Number(x.departmentId) === u.departmentId)) {
                const ageDays = r.since ? _ageDays(r.since, observedAt) : null; // R10
                const sla = settings.disputeSla[String(r.level)] ?? null;
                lines.push({
                    unitId: u.departmentId,
                    label: unitLabel(u, scope),
                    level: String(r.level),
                    count: cell(Number(r.n), {
                        unit: 'count',
                        kind: 'queue',
                        source: 'assessment_disputes',
                        link: LINK.disputes,
                    }),
                    age: cell(ageDays, { unit: 'days', kind: 'queue' }),
                    overdue: ageDays !== null && sla !== null && ageDays > sla,
                });
            }
        }
        if (lines.length) {
            out.push(
                _section('A2', 'Litiges à trancher', 'Disputes to arbitrate', {
                    lines,
                    source: 'assessment_disputes',
                    rule: {
                        fr: 'resolved_at IS NULL, ventilé par niveau',
                        en: 'resolved_at IS NULL, split by level',
                    },
                    link: LINK.disputes,
                })
            );
        }
    }

    // ---- A3 PIPs to activate / ending / milestone missed ---------------------
    // `pip_state` has no 'closed' either — it is closed_success / closed_failure.
    {
        const f = scope.filter('e', 'id');
        const proposed = await db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
               FROM pips p JOIN employees e ON e.id = p.employee_id
              WHERE p.state = 'proposed'${f.clause} GROUP BY 1`,
            [...f.params]
        );
        const ending = await db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
               FROM pips p JOIN employees e ON e.id = p.employee_id
              WHERE p.state IN ('approved','active') AND p.ends_on IS NOT NULL
                AND p.ends_on <= ?${f.clause} GROUP BY 1`,
            [win.horizonEnd, ...f.params]
        );
        const missed = await db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
               FROM pip_milestones m JOIN pips p ON p.id = m.pip_id
               JOIN employees e ON e.id = p.employee_id
              WHERE m.due_on < ? AND NOT m.met${f.clause} GROUP BY 1`,
            [observedAt, ...f.params]
        ); // R10
        const bp = _indexBy(proposed, 'departmentId', 'n');
        const be = _indexBy(ending, 'departmentId', 'n');
        const bm = _indexBy(missed, 'departmentId', 'n');
        const lines = [];
        for (const u of grid) {
            const p = bp[u.departmentId] ?? 0,
                e = be[u.departmentId] ?? 0,
                m = bm[u.departmentId] ?? 0;
            if (!p && !e && !m) continue;
            const line = { unitId: u.departmentId, label: unitLabel(u, scope) };
            if (p)
                line.toActivate = cell(p, {
                    unit: 'count',
                    kind: 'queue',
                    source: 'pips',
                    link: '/v2/pip',
                });
            if (e)
                line.ending = cell(e, {
                    unit: 'count',
                    kind: 'queue',
                    source: 'pips',
                    link: '/v2/pip',
                });
            // Omitted entirely when there is no milestone to report — pip_milestones
            // is empty on a development database and "0 missed milestones" would be a claim.
            if (m)
                line.milestoneMissed = cell(m, {
                    unit: 'count',
                    kind: 'queue',
                    source: 'pip_milestones',
                    link: '/v2/pip',
                });
            lines.push(line);
        }
        if (lines.length) {
            out.push(
                _section(
                    'A3',
                    'PIP à activer / à échéance / jalon dépassé',
                    'PIPs to activate / ending / milestone missed',
                    {
                        lines,
                        source: 'pips, pip_milestones',
                        rule: {
                            fr: `state = proposed ; ends_on ≤ ${win.horizonDays} j après la période ; jalon échu non atteint`,
                            en: `state = proposed; ends_on ≤ ${win.horizonDays} d after the period; milestone past due and unmet`,
                        },
                        link: '/v2/pip',
                    }
                )
            );
        }
    }

    // ---- A4 9-box placements awaiting approval -----------------------------
    // COUNT ONLY — never a name, never a box, never a performance/potential
    // pair. Restricted source, so R2 suppresses it under the floor.
    {
        const f = scope.filter('e', 'id');
        const rows = await db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
               FROM nine_box_evaluations nb JOIN employees e ON e.id = nb.employee_id
              WHERE nb.status = 'submitted'${f.clause} GROUP BY 1`,
            [...f.params]
        );
        const by = _indexBy(rows, 'departmentId', 'n');
        const lines = [];
        for (const u of grid) {
            const n = by[u.departmentId] ?? 0;
            if (!n) continue;
            lines.push({
                unitId: u.departmentId,
                label: unitLabel(u, scope),
                count: cell(n, {
                    unit: 'count',
                    kind: 'restricted',
                    population: u.headcount,
                    source: 'nine_box_evaluations',
                    link: '/talent/nine-box',
                }),
            });
        }
        if (lines.length) {
            out.push(
                _section(
                    'A4',
                    'Placements 9-box en attente d’approbation',
                    '9-box placements awaiting approval',
                    {
                        lines,
                        source: 'nine_box_evaluations',
                        rule: {
                            fr: 'status = submitted — compte seul',
                            en: 'status = submitted — count only',
                        },
                        link: '/talent/nine-box',
                    }
                )
            );
        }
    }

    // ---- A5 IDPs to activate / countersign ---------------------------------
    {
        const f = scope.filter('e', 'id');
        const draft = await db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
               FROM idp_plans p JOIN employees e ON e.id = p.employee_id
              WHERE p.status = 'draft'${f.clause} GROUP BY 1`,
            [...f.params]
        );
        const unsigned = await db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
               FROM idp_plans p JOIN employees e ON e.id = p.employee_id
              WHERE p.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM idp_signoffs s
                                 WHERE s.idp_id = p.id AND s.role = 'supervisor')${f.clause}
              GROUP BY 1`,
            [...f.params]
        );
        const bd = _indexBy(draft, 'departmentId', 'n');
        const bu = _indexBy(unsigned, 'departmentId', 'n');
        const lines = [];
        for (const u of grid) {
            const d = bd[u.departmentId] ?? 0,
                s = bu[u.departmentId] ?? 0;
            if (!d && !s) continue;
            const line = { unitId: u.departmentId, label: unitLabel(u, scope) };
            if (d)
                line.toActivate = cell(d, {
                    unit: 'count',
                    kind: 'queue',
                    source: 'idp_plans',
                    link: '/v2/idp',
                });
            if (s)
                line.toCountersign = cell(s, {
                    unit: 'count',
                    kind: 'queue',
                    source: 'idp_signoffs',
                    link: '/v2/idp',
                });
            lines.push(line);
        }
        if (lines.length) {
            out.push(
                _section(
                    'A5',
                    'IDP à activer / à contre-signer',
                    'IDPs to activate / countersign',
                    {
                        lines,
                        source: 'idp_plans, idp_signoffs',
                        rule: {
                            fr: 'status = draft ; plan actif sans signature superviseur',
                            en: 'status = draft; active plan with no supervisor sign-off',
                        },
                        link: '/v2/idp',
                    }
                )
            );
        }
    }

    // ---- A6 requests awaiting the recipient's decision — ADMIN ONLY --------
    if (scope.type === 'admin') {
        const families = await _decisionQueues(ctx);
        const nonEmpty = families.filter((x) => x.n > 0);
        if (nonEmpty.length) {
            // Anti-noise: beyond three live families, fold into ONE line.
            const folded = nonEmpty.length > 3;
            out.push(
                _section(
                    'A6',
                    'Demandes attendant votre décision',
                    'Requests awaiting your decision',
                    {
                        folded,
                        lines: folded
                            ? [
                                  {
                                      unitId: null,
                                      count: cell(
                                          nonEmpty.reduce((s, x) => s + x.n, 0),
                                          {
                                              unit: 'count',
                                              kind: 'queue',
                                              source: 'multiple',
                                              link: '/notifications',
                                          }
                                      ),
                                      label: {
                                          fr: 'demandes attendent votre décision',
                                          en: 'requests awaiting your decision',
                                      },
                                  },
                              ]
                            : nonEmpty.map((x) => ({
                                  unitId: null,
                                  family: x.family,
                                  label: x.label,
                                  count: cell(x.n, {
                                      unit: 'count',
                                      kind: 'queue',
                                      source: x.source,
                                      link: x.link,
                                  }),
                              })),
                        source: 'onboarding_requests, account_requests, cancellation_requests, post_approval_reviews, lifecycle_events, maker_checker_requests, opportunity_applications',
                        rule: {
                            fr: 'chaque famille est gardée par la permission qui autorise la décision',
                            en: 'each family is gated by the permission that authorises the decision',
                        },
                        link: '/notifications',
                    }
                )
            );
        }
    }

    // ---- A7 people with no governance — ADMIN ONLY -------------------------
    // An ACTION (assign a responsible), not a statistic: these people fall into
    // NO governor's brief. `manager_type = 'admin'` is included because
    // GovernanceService.resolveReviewer then returns a PHANTOM reviewer
    // (employee 290 → { kind:'manager', id:33, name:null }).
    if (scope.type === 'admin') {
        const f = scope.filter('e', 'id');
        const rows = await db.all(
            `SELECT ed.department_id AS "departmentId",
                    COUNT(*) FILTER (WHERE e.supervisor_id IS NULL AND e.manager_id IS NULL)::int AS "orphans",
                    COUNT(*) FILTER (WHERE e.supervisor_id IS NULL AND e.manager_type = 'admin')::int AS "phantom"
               FROM employees e JOIN v_employee_details ed ON ed.employee_id = e.id
              WHERE e.is_active${f.clause}
              GROUP BY 1`,
            [...f.params]
        );
        const by = _indexBy(rows, 'departmentId');
        const lines = [];
        for (const u of grid) {
            const r = by[u.departmentId];
            const orphans = r ? Number(r.orphans) : 0;
            const phantom = r ? Number(r.phantom) : 0;
            if (!orphans && !phantom) continue;
            const line = { unitId: u.departmentId, label: unitLabel(u, scope) };
            if (orphans) {
                // COMPTE, jamais un taux. R2 troisième puce garde une file de
                // travail publiable sous le plancher — le destinataire gouverne
                // déjà ces personnes — mais c'est le TAUX qui doit disparaître :
                // « 1/1 (100 %) » chez un administrateur autorisé sur UNE seule
                // personne d'un département de 36 est un pourcentage qui décrit
                // un individu, donc nominatif. Mesuré sur un administrateur local, seul point
                // d'échec d'AC-5 au moment de la recette du lot B2.
                line.noGovernance = cell(orphans, {
                    unit: 'count',
                    kind: 'queue',
                    source: 'employees',
                    link: '/employees?noManager=1',
                });
            }
            if (phantom) {
                line.adminAsManager = cell(phantom, {
                    unit: 'count',
                    kind: 'queue',
                    source: 'employees',
                    link: '/employees?noManager=1',
                });
            }
            lines.push(line);
        }
        if (lines.length) {
            out.push(
                _section(
                    'A7',
                    'Personnes sans gouvernance',
                    'People with no supervisor or manager',
                    {
                        lines,
                        source: 'employees',
                        rule: {
                            fr: 'supervisor_id IS NULL AND manager_id IS NULL ; plus manager_type = admin (réviseur fantôme)',
                            en: 'supervisor_id IS NULL AND manager_id IS NULL; plus manager_type = admin (phantom reviewer)',
                        },
                        link: '/employees?noManager=1',
                    }
                )
            );
        }
    }

    return _keepNonEmpty(out);
}

/**
 * A6's families. Each is gated by a PERMISSION resolved with
 * `RBACService.getPermissions(user)` — never `hasPermission`, which reads
 * `user.permissions` placed on the SESSION at login (RBACService.js:43-49) and
 * would answer `false` for every non-superadmin admin inside a job.
 */
async function _decisionQueues(ctx) {
    const { scope } = ctx;
    const RBACService = require('./RBACService');
    const perms = await RBACService.getPermissions(scope.principal);
    const has = (slug) => perms.includes(slug);
    const isSuper = RBACService.isSuperAdmin(scope.principal);
    const f = scope.filter('e', 'id');
    const out = [];

    const push = async (family, slug, label, source, link, sql, params) => {
        if (slug && !has(slug)) return;
        const r = await db.get(sql, params);
        out.push({ family, label, source, link, n: Number((r && r.n) || 0) });
    };

    await push(
        'onboarding',
        'manage_onboarding',
        { fr: 'Inscriptions en attente', en: 'Pending sign-ups' },
        'onboarding_requests',
        '/onboarding',
        `SELECT COUNT(*)::int AS n FROM onboarding_requests WHERE status = 'pending'`,
        []
    );
    await push(
        'account',
        'manage_invitations',
        { fr: 'Demandes de compte', en: 'Account requests' },
        'account_requests',
        LINK.accountRequests,
        `SELECT COUNT(*)::int AS n FROM account_requests a JOIN employees e ON e.id = a.employee_id
          WHERE a.decided_at IS NULL${f.clause}`,
        [...f.params]
    );
    await push(
        'cancellation',
        'manage_mobility',
        { fr: 'Annulations à décider', en: 'Cancellations to decide' },
        'cancellation_requests',
        '/cancellations',
        `SELECT COUNT(*)::int AS n FROM cancellation_requests c
           LEFT JOIN employees e ON e.id = c.employee_id
          WHERE c.state = 'pending'${f.clause}`,
        [...f.params]
    );
    await push(
        'post_approval',
        'approve_assessments',
        { fr: 'Revues post-approbation', en: 'Post-approval reviews' },
        'post_approval_reviews',
        '/reviews/post-approval',
        `SELECT COUNT(*)::int AS n FROM post_approval_reviews p JOIN employees e ON e.id = p.employee_id
          WHERE p.state = 'pending'${f.clause}`,
        [...f.params]
    );
    await push(
        'leaver',
        'manage_employees',
        { fr: 'Départs à décider', en: 'Leavers to decide' },
        'lifecycle_events',
        '/v2/lifecycle',
        `SELECT COUNT(*)::int AS n FROM lifecycle_events l JOIN employees e ON e.id = l.employee_id
          WHERE l.kind = 'leaver' AND l.requested_by IS NOT NULL
            AND l.decided_at IS NULL AND l.reverted_at IS NULL${f.clause}`,
        [...f.params]
    );
    await push(
        'mobility',
        'manage_mobility',
        { fr: 'Candidatures sans décision', en: 'Applications with no decision' },
        'opportunity_applications',
        LINK.mobility,
        `SELECT COUNT(*)::int AS n FROM opportunity_applications o JOIN employees e ON e.id = o.employee_id
          WHERE o.decided_at IS NULL${f.clause}`,
        [...f.params]
    );
    if (isSuper) {
        await push(
            'maker_checker',
            null,
            { fr: 'Validations à deux personnes', en: 'Two-person approvals' },
            'maker_checker_requests',
            LINK.makerChecker,
            `SELECT COUNT(*)::int AS n FROM maker_checker_requests WHERE state = 'pending'`,
            []
        );
    }
    return out;
}

/**
 * BLOCK B — À RELANCER. Somebody owes the recipient something.
 */
async function blocksB(ctx) {
    const { scope, grid, win } = ctx;
    // block B is "what someone owes me", observed TODAY. The page says so
    // in its own header sentence: « ce qu'il y a à faire, constaté le … ».
    const observedAt = observedAtOf(ctx);
    const out = [];
    if (!grid.length) return out;

    // ---- B1 campaign: not started ------------------------------------------
    // Denominator is the roster FROZEN AT LAUNCH (cycle_participants, migration
    // 70) read through v_cycle_participant_status. `is_active` is NOT filtered:
    // cycle 9 froze 78 participants of whom 76 are still active, and filtering
    // would make the progress rate RISE when somebody leaves.
    // v_employee_cycle_progress is forbidden: it INNER JOINs
    // self_assessment_rounds and returns ONE employee out of a 76-person roster.
    {
        const f = scope.filter('p', 'employee_id');
        const cyc = await db.get(
            `SELECT c.id, c.code, c.label, c.status::text AS status
               FROM assessment_cycles c
              WHERE c.status IN ('open','locked')
                AND EXISTS (SELECT 1 FROM cycle_participants p
                             WHERE p.cycle_id = c.id${f.clause})
              ORDER BY c.opened_at DESC NULLS LAST, c.id DESC LIMIT 1`,
            [...f.params]
        );
        if (!cyc) {
            out.push(
                _section('B1', 'Campagne', 'Campaign', {
                    severity: 'info',
                    lines: [
                        {
                            unitId: null,
                            label: { fr: 'Campagne non lancée', en: 'No campaign running' },
                            // NEVER "0 %": there is no denominator, so there is no rate.
                            state: cell(null, {
                                unit: 'pct',
                                kind: 'ratio',
                                source: 'assessment_cycles',
                            }),
                        },
                    ],
                    source: 'assessment_cycles',
                    rule: {
                        fr: 'aucune campagne ouverte ou verrouillée dans le périmètre',
                        en: 'no open or locked campaign in scope',
                    },
                })
            );
        } else {
            const fp = scope.filter('s', 'employee_id');
            const rows = await db.all(
                `SELECT s.department_id AS "departmentId",
                        COUNT(*)::int AS roster,
                        COUNT(*) FILTER (WHERE s.participant_state = 'not_started')::int AS "notStarted",
                        COUNT(*) FILTER (WHERE s.excluded_at IS NOT NULL)::int AS excluded
                   FROM v_cycle_participant_status s
                  WHERE s.cycle_id = ?${fp.clause}
                  GROUP BY 1`,
                [cyc.id, ...fp.params]
            );
            // The department id here is the one FROZEN AT LAUNCH, which may differ
            // from today's — that is why this block keys on its own rows instead
            // of the roster grid, and says so.
            const gone = await db.get(
                `SELECT COUNT(*)::int AS n FROM cycle_participants p
                   LEFT JOIN employees e ON e.id = p.employee_id
                  WHERE p.cycle_id = ? AND COALESCE(e.is_active, false) = false${f.clause}`,
                [cyc.id, ...f.params]
            );
            const lines = [];
            const nameBy = _indexBy(
                grid.map((u) => ({ departmentId: u.departmentId, u })),
                'departmentId',
                'u'
            );
            for (const r of rows) {
                const did = Number(r.departmentId);
                const u = nameBy[did] || {
                    unitName: `#${did}`,
                    headcount: Number(r.roster),
                    totalHeadcount: Number(r.roster),
                };
                const roster = Number(r.roster);
                lines.push({
                    unitId: did,
                    frozenUnit: true,
                    label: {
                        fr: `${u.unitName} (département figé au lancement)`,
                        en: `${u.unitName} (department frozen at launch)`,
                    },
                    notStarted: cell(Number(r.notStarted), {
                        unit: 'ratio',
                        denom: roster,
                        kind: 'ratio',
                        source: 'v_cycle_participant_status',
                        link: `/cycles/${cyc.id}?state=not_started`,
                    }),
                    roster,
                });
            }
            if (lines.length) {
                out.push(
                    _section('B1', 'Campagne : non démarrés', 'Campaign: not started', {
                        lines,
                        // B1b — an 'open' campaign gets a CTA; a 'locked' one is a
                        // STATEMENT with no CTA. cycle-nudge (:45) and cycle-deadline
                        // (:50) may lock a campaign minutes after this brief is sent,
                        // and an email that asks for an action the app refuses
                        // destroys trust.
                        cta: cyc.status === 'open' ? `/cycles/${cyc.id}?state=not_started` : null,
                        cycle: {
                            id: Number(cyc.id),
                            code: cyc.code,
                            label: cyc.label,
                            status: cyc.status,
                        },
                        leftSinceLaunch: Number((gone && gone.n) || 0),
                        source: 'v_cycle_participant_status, cycle_participants',
                        rule: {
                            fr: 'roster FIGÉ au lancement (is_active non filtré) ; participant_state = not_started',
                            en: 'roster FROZEN at launch (is_active not filtered); participant_state = not_started',
                        },
                    })
                );
            }
        }
    }

    // ---- B2 stalled coaching ------------------------------------------------
    {
        const f = scope.filter('e', 'id');
        // "stalled for more than 21 days" counts back from TODAY, not from
        // a period end: on the yearly catch-up window the two are 60 days apart.
        const stalledBefore = new Date(observedAt.getTime() - 21 * 86400000);
        const rows = await db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
               FROM coaching_plans c JOIN employees e ON e.id = c.employee_id
              WHERE c.state = 'active' AND COALESCE(c.progress, 0) = 0
                AND c.created_at < ?${f.clause} GROUP BY 1`,
            [stalledBefore, ...f.params]
        );
        const by = _indexBy(rows, 'departmentId', 'n');
        const lines = _onGrid(grid, by)
            .filter((x) => x.n > 0)
            .map((x) => ({
                unitId: x.unit.departmentId,
                label: unitLabel(x.unit, scope),
                count: cell(x.n, {
                    unit: 'count',
                    kind: 'queue',
                    source: 'coaching_plans',
                    link: '/coaching/plans',
                }),
            }));
        if (lines.length) {
            out.push(
                _section('B2', 'Coaching à l’arrêt', 'Stalled coaching plans', {
                    lines,
                    source: 'coaching_plans',
                    rule: {
                        fr: 'state = active, progression 0, ouvert depuis plus de 21 jours',
                        en: 'state = active, progress 0, open for more than 21 days',
                    },
                    link: '/coaching/plans',
                })
            );
        }
    }

    // ---- B3 open IDP actions ------------------------------------------------
    // `idp_actions` has NO due-date column at all. The only date available is the
    // PLAN's (or the objective's), so the wording is "3 open IDP actions on 1
    // plan whose end date is in 12 days" — NEVER "3 overdue actions".
    {
        const f = scope.filter('e', 'id');
        const rows = await db.all(
            `SELECT e.department_id AS "departmentId",
                    COUNT(*)::int AS actions,
                    COUNT(DISTINCT p.id)::int AS plans,
                    MIN(COALESCE(o.due_on, p.ends_on)) AS "nextDue"
               FROM idp_actions a
               JOIN idp_plans p ON p.id = a.idp_id
               LEFT JOIN idp_objectives o ON o.id = a.objective_id
               JOIN employees e ON e.id = p.employee_id
              WHERE a.status NOT IN ('completed','cancelled')
                AND p.status IN ('draft','active')${f.clause}
              GROUP BY 1`,
            [...f.params]
        );
        const by = _indexBy(rows, 'departmentId');
        const lines = [];
        for (const u of grid) {
            const r = by[u.departmentId];
            if (!r || !Number(r.actions)) continue;
            // "the plan is due in n days" is counted from TODAY. Counted
            // from the period end it overstated the remaining time by the whole
            // catch-up gap, which is the same defect as the ages above.
            const dueInDays = r.nextDue
                ? Math.round((new Date(r.nextDue) - observedAt) / 86400000)
                : null;
            lines.push({
                unitId: u.departmentId,
                label: unitLabel(u, scope),
                actions: cell(Number(r.actions), {
                    unit: 'count',
                    kind: 'queue',
                    source: 'idp_actions',
                    link: '/v2/idp',
                }),
                plans: Number(r.plans),
                dueInDays,
            });
        }
        if (lines.length) {
            out.push(
                _section('B3', 'Actions IDP ouvertes', 'Open IDP actions', {
                    lines,
                    source: 'idp_actions, idp_plans, idp_objectives',
                    rule: {
                        fr: 'action non terminée sur un plan draft/actif ; l’échéance vient du PLAN (ou de l’objectif), jamais de l’action',
                        en: 'unfinished action on a draft/active plan; the due date comes from the PLAN (or objective), never from the action',
                    },
                    link: '/v2/idp',
                })
            );
        } else {
            // Distinguish "no open plan" (grey, unknown workload) from
            // "0 overdue action" (green, a clean result). They are not the same
            // sentence and must not look alike.
            out.push(
                _section('B3', 'Actions IDP ouvertes', 'Open IDP actions', {
                    severity: 'info',
                    lines: [
                        {
                            unitId: null,
                            label: {
                                fr: 'Aucun plan IDP ouvert dans votre périmètre',
                                en: 'No open IDP plan in your scope',
                            },
                            state: cell(null, {
                                unit: 'count',
                                kind: 'queue',
                                source: 'idp_plans',
                                link: '/v2/idp',
                            }),
                        },
                    ],
                    source: 'idp_plans',
                    rule: {
                        fr: 'aucun plan draft/actif — absence de plan, pas absence de retard',
                        en: 'no draft/active plan — no plan, not "no delay"',
                    },
                    link: '/v2/idp',
                })
            );
        }
    }

    // ---- B4 overdue training ------------------------------------------------
    // `lms_enroll_status` = assigned | in_progress | completed | failed |
    // cancelled. The table is EMPTY on a development database, so the section is OMITTED —
    // never rendered as "0 overdue", which would be a clean bill of health for
    // a module that has never been fed.
    {
        const f = scope.filter('e', 'id');
        const rows = await db.all(
            `SELECT e.department_id AS "departmentId", COUNT(*)::int AS n
               FROM lms_enrollments l JOIN employees e ON e.id = l.employee_id
              WHERE l.due_at IS NOT NULL AND l.due_at < ?
                AND l.status NOT IN ('completed','cancelled')${f.clause}
              GROUP BY 1`,
            [observedAt, ...f.params]
        ); // R10 — overdue TODAY
        const by = _indexBy(rows, 'departmentId', 'n');
        const lines = _onGrid(grid, by)
            .filter((x) => x.n > 0)
            .map((x) => ({
                unitId: x.unit.departmentId,
                label: unitLabel(x.unit, scope),
                // `/lms` was never mounted. The canonical LMS token is the hub;
                // `resolveLink` specialises it for the reader at render time.
                count: cell(x.n, {
                    unit: 'count',
                    kind: 'queue',
                    source: 'lms_enrollments',
                    link: LINK.lmsHub,
                }),
            }));
        if (lines.length) {
            out.push(
                _section('B4', 'Formations en retard', 'Overdue training', {
                    lines,
                    source: 'lms_enrollments',
                    rule: {
                        fr: 'due_at < jour du calcul et statut ∉ (completed, cancelled)',
                        en: 'due_at < day of computation and status ∉ (completed, cancelled)',
                    },
                    link: LINK.lmsHub,
                })
            );
        }
    }

    return out.filter((s) => s.lines && s.lines.length);
}

/**
 * BLOCK C — RISQUE DATÉ. A calendar date is coming.
 * The horizon is INDEXED ON THE CADENCE (win.horizonDays) and never wider.
 */
async function blocksC(ctx) {
    const { scope, grid, win, namesAllowed } = ctx;
    // block C's HORIZON is period-anchored on purpose (§2.4: never wider
    // than the cadence); only the AGES inside it are observed today.
    const observedAt = observedAtOf(ctx);
    const out = [];
    if (!grid.length) return out;

    // ---- C0 key-person exposure ---------------------------------------------
    // Published ONLY when the recipient's scope covers the department ENTIRELY.
    // The sweep scopes by READER first and then counts the qualified, so from a
    // partial scope a person would be declared "sole holder" simply because the
    // reader sees one of the department's five qualified people.
    // We call sweep per department with `unitId` and read its `summary`, which
    // is computed over EVERY cell BEFORE the row cap — exposureByUnit rolls up
    // the CAPPED rows and drops `unitId`, so at 315 skills × 10 departments its
    // hard-coded limit of 1000 bites silently.
    {
        const lines = [];
        const capHit = [];
        let KeyPersonRiskService = null;
        try {
            KeyPersonRiskService = require('./KeyPersonRiskService');
        } catch {
            /* module optional */
        }
        if (KeyPersonRiskService && scope.principal) {
            for (const u of grid) {
                if (!u.wholeDepartment) {
                    lines.push({
                        unitId: u.departmentId,
                        label: unitLabel(u, scope),
                        partialScope: true,
                        soleHolder: cell(null, {
                            unit: 'count',
                            kind: 'restricted',
                            population: u.headcount,
                            source: 'KeyPersonRiskService',
                            link: LINK.keyPerson,
                        }),
                        note: {
                            fr: 'non publiable — périmètre partiel',
                            en: 'not publishable — partial scope',
                        },
                    });
                    continue;
                }
                let res = null;
                try {
                    res = await KeyPersonRiskService.sweep(scope.principal, {
                        unit: 'department',
                        unitId: u.departmentId,
                        band: 'all',
                        limit: 1000,
                    });
                } catch {
                    res = null;
                }
                if (!res) continue;
                if (res.rows && res.rows.length >= 1000) capHit.push(u.departmentId);
                const s = res.summary || {};
                const measuredCells =
                    Number(s.soleHolder || 0) + Number(s.noQualified || 0) + Number(s.covered || 0);
                lines.push({
                    unitId: u.departmentId,
                    label: unitLabel(u, scope),
                    // A cell nobody has ever measured is UNKNOWN, in amber, and is
                    // never counted as a risk.
                    neverMeasured: Number(s.neverMeasured || 0),
                    soleHolder: cell(measuredCells ? Number(s.soleHolder || 0) : null, {
                        unit: 'count',
                        kind: 'restricted',
                        population: u.headcount,
                        source: 'KeyPersonRiskService.sweep',
                        link: LINK.keyPerson,
                    }),
                    noQualified: cell(measuredCells ? Number(s.noQualified || 0) : null, {
                        unit: 'count',
                        kind: 'restricted',
                        population: u.headcount,
                        source: 'KeyPersonRiskService.sweep',
                        link: LINK.keyPerson,
                    }),
                    covered: measuredCells ? Number(s.covered || 0) : null,
                    measuredCells,
                });
            }
        }
        if (lines.length) {
            out.push(
                _section('C0', 'Risque clé-personne', 'Key-person exposure', {
                    lines,
                    capHit,
                    source: 'KeyPersonRiskService.sweep (v_resolved_assessments × role_skill_requirements)',
                    rule: {
                        fr: 'seul détenteur = exactement un qualifié ; aucun qualifié = écart PROUVÉ ; jamais mesuré = INCONNU, jamais compté comme risque',
                        en: 'sole holder = exactly one qualified; no qualified = PROVEN gap; never measured = UNKNOWN, never counted as risk',
                    },
                    link: LINK.keyPerson,
                })
            );
        }
    }

    // ---- C1 certifications expiring ----------------------------------------
    {
        const f = scope.filter('v', 'employee_id');
        const horizon = win.horizonDays;
        //  / M-14, arbitrage §7-2. The spec prescribed three buckets
        // « <0 · 0–30 · 31–horizon » and indexed the horizon on the cadence
        // (14/30/90/180): for weekly and monthly the third bucket asked for
        // « 31–14 » and « 31–30 », an interval whose upper bound is below its
        // lower one. The SQL made it worse by freezing 30 on BOTH sides
        // (`BETWEEN 0 AND 30` then `> 30 AND <= horizon`), so the column was
        // empty BY CONSTRUCTION — a 0 nothing could ever fill.
        // Fix: the near bucket never reaches past the horizon, and the far
        // bucket only exists when there is room for it.
        const soonMax = Math.min(30, horizon);
        const hasLater = horizon > soonMax;
        const rows = await db.all(
            `SELECT v.department_id AS "departmentId",
                    COUNT(*) FILTER (WHERE v.days_to_expiry < 0)::int             AS expired,
                    COUNT(*) FILTER (WHERE v.days_to_expiry BETWEEN 0 AND ?)::int AS soon,
                    COUNT(*) FILTER (WHERE v.days_to_expiry > ? AND v.days_to_expiry <= ?)::int AS later,
                    COUNT(*)::int AS registered
               FROM v_certification_current v
              WHERE 1 = 1${f.clause}
              GROUP BY 1`,
            [soonMax, soonMax, horizon, ...f.params]
        );
        const by = _indexBy(rows, 'departmentId');
        const lines = [];
        for (const u of grid) {
            const r = by[u.departmentId];
            // No certificate register at all → "—" (UNKNOWN), never 0. This is
            // already the contract of safeCertExpiring (kpi-snapshot.js:130-146):
            // "no certificate register returns null (unknown), never 0".
            const registered = r ? Number(r.registered) : 0;
            if (!registered) {
                lines.push({
                    unitId: u.departmentId,
                    label: unitLabel(u, scope),
                    registered: 0,
                    expiring: cell(null, {
                        unit: 'count',
                        kind: 'queue',
                        source: 'v_certification_current',
                        link: '/compliance',
                    }),
                });
                continue;
            }
            const line = {
                unitId: u.departmentId,
                label: unitLabel(u, scope),
                registered,
                expired: cell(Number(r.expired), {
                    unit: 'count',
                    kind: 'queue',
                    source: 'v_certification_current',
                    link: '/compliance',
                }),
                expiringSoon: cell(Number(r.soon), {
                    unit: 'count',
                    kind: 'queue',
                    source: 'v_certification_current',
                    link: '/compliance',
                }),
            };
            // The third bucket is OMITTED when the horizon leaves it no room —
            // never rendered as a 0 that no data could produce.
            if (hasLater) {
                line.expiringLater = cell(Number(r.later), {
                    unit: 'count',
                    kind: 'queue',
                    source: 'v_certification_current',
                    link: '/compliance',
                });
            }
            lines.push(line);
        }
        out.push(
            _section('C1', 'Certifications qui expirent', 'Certifications expiring', {
                lines,
                // The bounds travel with the section so the page and the e-mail can
                // label the buckets with the cadence's real numbers instead of a
                // hard-coded « sous 30 jours ».
                buckets: { soonMax, laterMax: hasLater ? horizon : null },
                source: 'v_certification_current',
                rule: c1Rule(soonMax, horizon, hasLater),
                link: '/compliance',
            })
        );
    }

    // ---- C1b the ONE named exception ---------------------------------------
    // Names only for an EMPLOYEE recipient, only on their DIRECT reports, and
    // only for people whose certificate is inside the horizon.
    let namedBlock = null;
    if (namesAllowed && scope.type === 'employee') {
        const direct = await directReportIds(scope.id);
        if (direct.length) {
            const rows = await db.all(
                `SELECT v.employee_id AS "employeeId", v.full_name AS "fullName", v.skill_name AS "skillName",
                        v.department_id AS "departmentId", v.days_to_expiry AS "daysToExpiry", v.expires_on AS "expiresOn"
                   FROM v_certification_current v
                  WHERE v.employee_id = ANY(?) AND v.days_to_expiry <= ?
                  ORDER BY v.days_to_expiry ASC`,
                [direct, win.horizonDays]
            );
            if (rows.length) {
                namedBlock = _section(
                    'C1b',
                    'Vos rattachés directs — certifications',
                    'Your direct reports — certifications',
                    {
                        severity: 'action',
                        // Names are resolved LIVE at read time from today's governance
                        // (§5.3 guard 3); they are never frozen into the payload.
                        lines: rows.map((r) => ({
                            unitId: Number(r.departmentId),
                            employeeId: Number(r.employeeId),
                            skillName: r.skillName,
                            daysToExpiry: Number(r.daysToExpiry),
                        })),
                        source: 'v_certification_current (rattachés directs uniquement)',
                        rule: {
                            fr: 'supervisor_id = vous OU (manager_id = vous ET manager_type = employee) — jamais le sous-arbre complet',
                            en: 'supervisor_id = you OR (manager_id = you AND manager_type = employee) — never the full sub-tree',
                        },
                        link: '/compliance',
                    }
                );
                out.push(namedBlock);
            }
        }
    }

    // ---- C2 coverage breaches ----------------------------------------------
    {
        let covRows = null;
        try {
            const CoverageService = require('./CoverageService');
            covRows = await CoverageService.status(scope.ids);
        } catch {
            covRows = null;
        }
        if (covRows) {
            const byDept = {};
            for (const r of covRows) {
                const did =
                    r.departmentId === null || r.departmentId === undefined
                        ? null
                        : Number(r.departmentId);
                if (did === null) continue;
                (byDept[did] = byDept[did] || []).push(r);
            }
            const lines = [];
            for (const u of grid) {
                const rules = byDept[u.departmentId] || [];
                if (!rules.length) {
                    // "Compliant" and "ungoverned" must not look alike. The development database has
                    // ONE coverage rule in total (Exploration/IT): nine departments
                    // out of ten land here, and "0 breaches" in green would be a lie.
                    lines.push({
                        unitId: u.departmentId,
                        label: unitLabel(u, scope),
                        rules: 0,
                        breaches: cell(null, {
                            unit: 'count',
                            kind: 'queue',
                            source: 'v_coverage_status',
                            link: '/compliance',
                        }),
                        note: {
                            fr: 'aucune règle de couverture définie pour ce département',
                            en: 'no coverage rule defined for this department',
                        },
                    });
                    continue;
                }
                const breached = rules.filter((r) => r.satisfied === false);
                const predicted = rules.filter(
                    (r) =>
                        r.satisfied &&
                        r.predictedBreachOn &&
                        new Date(r.predictedBreachOn) <= win.horizonEnd
                );
                lines.push({
                    unitId: u.departmentId,
                    label: unitLabel(u, scope),
                    rules: rules.length,
                    breaches: cell(breached.length, {
                        unit: 'ratio',
                        denom: rules.length,
                        kind: 'queue',
                        source: 'v_coverage_status',
                        link: '/compliance',
                    }),
                    predicted: cell(predicted.length, {
                        unit: 'count',
                        kind: 'queue',
                        source: 'v_coverage_status',
                        link: '/compliance',
                    }),
                    // "Breached for 34 days" is actionable; "1 breach" is not.
                    oldestBreachDays: breached.reduce((acc, r) => {
                        if (!r.breachedSince) return acc;
                        const d = _ageDays(r.breachedSince, observedAt); // R10
                        return acc === null ? d : Math.max(acc, d);
                    }, null),
                });
            }
            out.push(
                _section('C2', 'Ruptures de couverture', 'Coverage breaches', {
                    lines,
                    source: 'v_coverage_status (CoverageService.status)',
                    rule: {
                        fr: 'satisfied = false ; règles = dénominateur ; 0 règle ⇒ « non gouverné », jamais « conforme »',
                        en: 'satisfied = false; rules = denominator; 0 rules ⇒ "ungoverned", never "compliant"',
                    },
                    link: '/compliance',
                })
            );
        }
    }

    // ---- C3 critical roles without a successor ------------------------------
    {
        const f = scope.filter('e', 'id');
        const occupied = await db.all(
            `SELECT DISTINCT e.role_id AS "roleId" FROM employees e
              WHERE e.is_active AND e.role_id IS NOT NULL${f.clause}`,
            [...f.params]
        );
        const roleIds = occupied.map((r) => Number(r.roleId)).filter(Boolean);
        let rated = [];
        if (roleIds.length) {
            rated = await db.all(
                `SELECT role_id AS "roleId", has_coverage_gap AS "hasGap"
                   FROM v_continuity_coverage WHERE role_id = ANY(?)`,
                [roleIds]
            );
        }
        const gaps = rated.filter((r) => r.hasGap === true).length;
        out.push(
            _section('C3', 'Postes sans relève', 'Critical roles without a successor', {
                severity: rated.length ? 'action' : 'info',
                lines: [
                    {
                        unitId: null,
                        occupiedRoles: roleIds.length,
                        ratedRoles: rated.length,
                        // role_criticality is EMPTY on a development database (0 rows), so the view is
                        // empty too. "0 critical roles without a successor" would be a
                        // false clean bill of health; the honest line is that nothing has
                        // been rated.
                        gaps: cell(rated.length ? gaps : null, {
                            unit: 'ratio',
                            denom: rated.length || null,
                            kind: 'queue',
                            source: 'v_continuity_coverage',
                            link: LINK.continuity,
                        }),
                        // (1). The sentence is prescribed word for word by
                        // SPEC §2.4 C3, but its nouns were frozen in the plural: with a
                        // single occupied role it read « 1 postes occupés ». See
                        // c3Note — the same builder repairs the archived briefs.
                        note: rated.length ? null : c3Note(roleIds.length),
                        cta: rated.length
                            ? null
                            : { fr: 'Coter la criticité des postes', en: 'Rate role criticality' },
                    },
                ],
                source: 'v_continuity_coverage, role_criticality',
                rule: {
                    fr: 'rôles OCCUPÉS dans le périmètre, joints à la couverture de continuité',
                    en: 'roles OCCUPIED in scope, joined to continuity coverage',
                },
                link: LINK.continuity,
            })
        );
    }

    // ---- C4 newly high flight risk -----------------------------------------
    // COUNT ONLY, never a name and never a band (retention_risk.confidentiality
    // = 'restricted' on 78/78 rows). The "during the period" source is the
    // reminder_log LEDGER, not retention_risk.updated_at, which is rewritten by
    // every nightly pass and therefore cannot mean "changed recently".
    {
        const f = scope.filter('e', 'id');
        const rows = await db.all(
            `SELECT ed.department_id AS "departmentId", COUNT(DISTINCT r.target_id)::int AS n
               FROM reminder_log r
               JOIN employees e ON e.id = r.target_id AND r.target_type = 'employee'
               JOIN v_employee_details ed ON ed.employee_id = e.id
              WHERE r.kind = 'retention.high' AND r.sent_at >= ? AND r.sent_at < ?${f.clause}
              GROUP BY 1`,
            [win.periodStart, win.periodEnd, ...f.params]
        );
        const fr2 = scope.filter('e', 'id');
        const rated = await db.all(
            `SELECT ed.department_id AS "departmentId", COUNT(*)::int AS n
               FROM retention_risk rr
               JOIN employees e ON e.id = rr.employee_id
               JOIN v_employee_details ed ON ed.employee_id = e.id
              WHERE 1 = 1${fr2.clause} GROUP BY 1`,
            [...fr2.params]
        );
        const by = _indexBy(rows, 'departmentId', 'n');
        const ratedBy = _indexBy(rated, 'departmentId', 'n');
        const lines = [];
        for (const u of grid) {
            const ratedN = ratedBy[u.departmentId] ?? 0;
            if (!ratedN) {
                lines.push({
                    unitId: u.departmentId,
                    label: unitLabel(u, scope),
                    newlyHigh: cell(null, {
                        unit: 'count',
                        kind: 'restricted',
                        population: u.headcount,
                        source: 'retention_risk',
                        link: LINK.retention,
                    }),
                    note: { fr: 'risque de départ non calculé', en: 'flight risk not computed' },
                });
                continue;
            }
            lines.push({
                unitId: u.departmentId,
                label: unitLabel(u, scope),
                rated: ratedN,
                // Mutual exclusion with C1b: naming direct reports AND publishing a
                // small-unit count in the same email lets the two be crossed.
                linkOnly: Boolean(namedBlock),
                newlyHigh: namedBlock
                    ? null
                    : cell(by[u.departmentId] ?? 0, {
                          unit: 'ratio',
                          denom: ratedN,
                          kind: 'restricted',
                          population: u.headcount,
                          source: 'reminder_log (kind = retention.high)',
                          link: LINK.retention,
                      }),
            });
        }
        out.push(
            _section('C4', 'Passages en risque de départ élevé', 'Newly high flight risk', {
                lines,
                source: 'reminder_log, retention_risk',
                rule: {
                    fr: 'ledger reminder_log kind = retention.high pendant la période — jamais retention_risk.updated_at',
                    en: 'reminder_log ledger kind = retention.high during the period — never retention_risk.updated_at',
                },
                link: LINK.retention,
            })
        );
    }

    return out.filter((s) => s.lines && s.lines.length);
}

/**
 * FOOTER — the measured state (§2.5). NEVER at the top of the brief: a measured
 * state is context, the action queue is the message.
 */
async function footer(ctx) {
    const { scope, grid } = ctx;
    if (!grid.length) return { units: [], totals: null };

    const fc = scope.filter('c', 'employee_id');
    const cov = await db.all(
        `SELECT c.department_id AS "departmentId",
                SUM(c.expected_skills)::int                        AS "expected",
                SUM(c.assessed_skills)::int                        AS "assessed",
                ROUND(AVG(c.readiness_assessed_only), 1)::float     AS "avgReadiness",
                COUNT(c.readiness_assessed_only)::int               AS "measuredPeople",
                COUNT(*)::int                                       AS "scopedPeople",
                SUM(c.critical_expected)::int                       AS "criticalExpected",
                SUM(c.critical_assessed)::int                       AS "criticalAssessed"
           FROM v_employee_assessment_coverage c
          WHERE 1 = 1${fc.clause}
          GROUP BY 1`,
        [...fc.params]
    );
    const covBy = _indexBy(cov, 'departmentId');

    const fg = scope.filter('g', 'employee_id');
    const gaps = await db.all(
        `SELECT g.department_id AS "departmentId",
                COUNT(*)::int         AS "requiredCells",
                SUM(g.is_assessed)::int AS "assessedCells",
                SUM(g.is_met)::int      AS "metCells"
           FROM v_employee_skill_gaps g
          WHERE 1 = 1${fg.clause}
          GROUP BY 1`,
        [...fg.params]
    );
    const gapBy = _indexBy(gaps, 'departmentId');

    const units = [];
    let tExpected = 0,
        tAssessed = 0,
        tRequired = 0,
        tAssessedCells = 0,
        tMeasured = 0,
        tHeadcount = 0;
    let contributingDepartments = 0;
    for (const u of grid) {
        const c = covBy[u.departmentId] || {};
        const g = gapBy[u.departmentId] || {};
        const expected = Number(c.expected || 0);
        const assessed = Number(c.assessed || 0);
        const measuredPeople = Number(c.measuredPeople || 0);
        const requiredCells = Number(g.requiredCells || 0);
        const assessedCells = Number(g.assessedCells || 0);
        const metCells = Number(g.metCells || 0);
        const criticalAssessed = Number(c.criticalAssessed || 0);
        const criticalExpected = Number(c.criticalExpected || 0);

        tExpected += expected;
        tAssessed += assessed;
        tRequired += requiredCells;
        tAssessedCells += assessedCells;
        tMeasured += measuredPeople;
        tHeadcount += u.headcount;
        if (requiredCells > 0) contributingDepartments++;

        units.push({
            unitId: u.departmentId,
            label: unitLabel(u, scope),
            headcount: u.headcount,
            withoutRequirements: u.withoutRequirements,
            // the denominator ALWAYS ships with the ratio. `population` is
            // the headcount, so the anonymity floor is tested on PEOPLE: a unit
            // of one publishes no rate, however many requirement cells it holds.
            d1Coverage: cell(expected ? assessed : null, {
                unit: 'ratio',
                denom: expected || null,
                kind: 'ratio',
                population: u.headcount,
                source: 'v_employee_assessment_coverage',
                rule: {
                    fr: 'exigences évaluées / exigences attendues',
                    en: 'assessed requirements / expected requirements',
                },
                suffix: { fr: 'exigences évaluées', en: 'requirements assessed' },
            }),
            // readiness_assessed_only, NEVER AVG(readiness) (which scores
            // every unrated requirement as a 0) and NEVER
            // avgReadinessAllRequirements. It is an average OF AVERAGES, so it
            // is composition-sensitive and is never re-aggregated and never
            // carries a Δ in v1 (probe on department 11: 81,90 % as a mean of
            // means vs 85,95 % weighted by assessed requirements, same day).
            d2Readiness: cell(measuredPeople ? Number(c.avgReadiness) : null, {
                unit: 'pct',
                denom: measuredPeople,
                kind: 'ratio',
                population: Math.min(measuredPeople, u.headcount),
                source: 'v_employee_assessment_coverage.readiness_assessed_only',
                suffix: {
                    fr: `(sur ${measuredPeople} personne${measuredPeople > 1 ? 's' : ''} mesurée${measuredPeople > 1 ? 's' : ''} sur ${u.headcount})`,
                    en: `(over ${measuredPeople} of ${u.headcount} people measured)`,
                },
                thresholds: { good: 80, warn: 60, direction: 'higher' },
            }),
            // matrix completion.
            d3Completion: cell(requiredCells ? assessedCells : null, {
                unit: 'ratio',
                denom: requiredCells || null,
                kind: 'ratio',
                population: u.headcount,
                source: 'v_employee_skill_gaps',
            }),
            // "% of requirements MET" is computed over the ASSESSED ones, like
            // DeptAnalyticsController.js:61 — never over ALL requirements, which
            // is exactly the defect migration 118 fixes in
            // v_department_matrix_completion.
            d3Met: cell(assessedCells ? metCells : null, {
                unit: 'ratio',
                denom: assessedCells || null,
                kind: 'ratio',
                population: u.headcount,
                source: 'v_employee_skill_gaps',
            }),
            // critical compliance, guarded on SUM(critical_assessed) > 0.
            // The development database: 303 critical requirements expected, 0 assessed → "—" for
            // all ten departments. That is CORRECT, it is not an outage.
            d4Critical: cell(criticalAssessed > 0 ? criticalAssessed : null, {
                unit: 'ratio',
                denom: criticalExpected || null,
                kind: 'ratio',
                population: u.headcount,
                source: 'v_employee_assessment_coverage (critical_assessed / critical_expected)',
            }),
            // measured people / headcount: a COUNT, the earliest indicator
            // that answers "is this getting better", and the only footer figure
            // that carries a Δ in v1.
            d5MeasuredPeople: cell(measuredPeople, {
                unit: 'ratio',
                denom: u.headcount,
                kind: 'ratio',
                population: u.headcount,
                source: 'v_employee_assessment_coverage + roster',
            }),
            _raw: {
                expected,
                assessed,
                measuredPeople,
                requiredCells,
                assessedCells,
                metCells,
                criticalAssessed,
                criticalExpected,
            },
        });
    }

    return {
        units,
        totals: {
            headcount: tHeadcount,
            // The overall chip is the AGGREGATE ratio SUM/SUM, not a mean of
            // department percentages — otherwise Northfield/IT (1 person) weighs as
            // much as Riverside/IT (36).
            coverage: cell(tExpected ? tAssessed : null, {
                unit: 'ratio',
                denom: tExpected || null,
                kind: 'ratio',
                population: tHeadcount,
                source: 'v_employee_assessment_coverage',
            }),
            completion: cell(tRequired ? tAssessedCells : null, {
                unit: 'ratio',
                denom: tRequired || null,
                kind: 'ratio',
                population: tHeadcount,
                source: 'v_employee_skill_gaps',
            }),
            measuredPeople: cell(tMeasured, {
                unit: 'ratio',
                denom: tHeadcount,
                kind: 'ratio',
                population: tHeadcount,
                source: 'v_employee_assessment_coverage + roster',
            }),
            contributingDepartments,
            departments: grid.length,
            _raw: {
                expected: tExpected,
                assessed: tAssessed,
                requiredCells: tRequired,
                assessedCells: tAssessedCells,
                measuredPeople: tMeasured,
                headcount: tHeadcount,
            },
        },
    };
}

// ---------------------------------------------------------------------------
// FLOW — the only real window block (§2.6)
// ---------------------------------------------------------------------------

/**
 * the title of a flow line, in words, never the database token.
 *
 * `v_perf_actions.action_type` was interpolated raw into both languages, so the
 * brief and the e-mail both published « self_assessment ouverts » and
 * "self_assessment opened". The wording stays IMPERATIVE — "ouverts" / "opened",
 * never "réussis" (§2.6: `occurred_at` is the object's `created_at`, there is no
 * outcome indicator anywhere) — and each label carries its own agreement, which
 * a generic « <nom> ouverts » cannot do for a feminine plural.
 *
 * `utils/enumLabels` is the fallback for a type added later: it already knows
 * `coaching` and `mentoring`, and it humanises anything else rather than
 * printing an underscore.
 */
const FLOW_ACTION_TITLE = {
    coaching: { fr: 'Plans de coaching ouverts', en: 'Coaching plans opened' },
    idp: { fr: 'Plans de développement (IDP) ouverts', en: 'Development plans (IDP) opened' },
    mentoring: { fr: 'Mentorats ouverts', en: 'Mentoring pairs opened' },
    pip: { fr: 'Plans d’amélioration (PIP) ouverts', en: 'Improvement plans (PIP) opened' },
    self_assessment: { fr: 'Auto-évaluations ouvertes', en: 'Self-assessments opened' },
};

function flowActionTitle(actionType) {
    const known = FLOW_ACTION_TITLE[String(actionType)];
    if (known) return known;
    const { enumLabel } = require('../utils/enumLabels');
    return {
        fr: `${enumLabel(actionType, 'fr')} — ouverts`,
        en: `${enumLabel(actionType, 'en')} — opened`,
    };
}

/**
 * A-07, render side — the SAME repair as M-11's link alias, applied to the flow
 * titles instead of the deep links.
 *
 * Fixing `flowActionTitle` fixed the PRODUCER only. A brief is never recomputed
 * when it is opened — that is the whole point of the archive — so the twelve
 * briefs already archived (310, 311, 329, 334, 335, 344, 345, 348, 349, 350,
 * 351, 454) still carry `{"en":"self_assessment opened","fr":"self_assessment
 * ouverts"}` frozen in their payload, and go on publishing the database token on
 * the page AND in the e-mail. The title of a flow-action line is a PURE function
 * of its `metric` (`opened.<action_type>`), so it is recomputed at render time
 * rather than read from the archive. Nothing in the archive is rewritten.
 *
 * Every other flow line (`selfAssessmentsSubmitted`, `reviewsClosed`) keeps the
 * title it froze: those were never built from a raw column.
 *
 * @param {{metric?:string, title?:{fr:string,en:string}}} line one `payload.flow.lines` entry
 * @returns {{fr:string,en:string}} the bilingual title to print
 */
function resolveFlowTitle(line) {
    if (!line) return { fr: '', en: '' };
    const metric = String(line.metric || '');
    if (!metric.startsWith('opened.')) return line.title;
    return flowActionTitle(metric.slice('opened.'.length));
}

/**
 * Append-only sources ONLY. `skill_assessments.assessed_at` is FORBIDDEN as a
 * flow source: the table carries UNIQUE(employee_id, skill_id) and three paths
 * rewrite assessed_at = now on every re-rating (SkillsIntelligenceService.js:196,
 * LmsService.js:498, ActionEffectivenessService.js:47) — an assessment made in Q2
 * and corrected in Q3 LEAVES Q2, so the same brief recomputed later returns a
 * SMALLER number. 2710 of the 2714 rows sit in the single month 2026-06 (an import).
 */
async function flow(ctx) {
    const { scope, win } = ctx;
    const lines = [];

    const count = async (metric, title, sql, tsExpr, table) => {
        const now = await _windowCount(sql, tsExpr, win.periodStart, win.periodEnd, scope);
        const before = await _windowCount(sql, tsExpr, win.prevStart, win.prevEnd, scope);
        lines.push({
            metric,
            title,
            table,
            now: now.n,
            before: before.n,
            importBatch: now.importBatch,
            // Here a 0 is LEGITIMATE — we counted events over a dated window and
            // the result is nil. It is strictly distinct from "—".
            value: cell(now.n, { unit: 'count', kind: 'queue', source: table }),
            delta: deltaOf(now.n, before.n, {
                metric,
                materiality: 1,
                suppress: now.importBatch ? 'import_batch' : null,
            }),
        });
    };

    // v_perf_actions: PIP / IDP / coaching / mentoring / self-assessments OPENED.
    // The wording is imperative: "opened", never "successful" — occurred_at is
    // the object's created_at, and there is NO per-department outcome indicator
    // anywhere (action_effectiveness holds 2 rows and is aggregated nowhere).
    {
        const f = scope.filter('a', 'employee_id');
        const types = await db.all(
            `SELECT a.action_type AS "actionType", COUNT(*)::int AS n
               FROM v_perf_actions a
              WHERE a.occurred_at >= ? AND a.occurred_at < ?${f.clause}
              GROUP BY 1`,
            [win.periodStart, win.periodEnd, ...f.params]
        );
        const prev = await db.all(
            `SELECT a.action_type AS "actionType", COUNT(*)::int AS n
               FROM v_perf_actions a
              WHERE a.occurred_at >= ? AND a.occurred_at < ?${f.clause}
              GROUP BY 1`,
            [win.prevStart, win.prevEnd, ...f.params]
        );
        const prevBy = Object.fromEntries(prev.map((r) => [r.actionType, Number(r.n)]));
        const batch = await _importBatch(
            'v_perf_actions a',
            'a.occurred_at',
            scope,
            win,
            'employee_id'
        );
        for (const r of types) {
            const n = Number(r.n);
            const before = prevBy[r.actionType] ?? 0;
            lines.push({
                metric: `opened.${r.actionType}`,
                title: flowActionTitle(r.actionType),
                table: 'v_perf_actions',
                now: n,
                before,
                importBatch: batch,
                value: cell(n, { unit: 'count', kind: 'queue', source: 'v_perf_actions' }),
                delta: deltaOf(n, before, {
                    metric: 'flowActions',
                    materiality: 1,
                    suppress: batch ? 'import_batch' : null,
                }),
            });
        }
    }

    await count(
        'selfAssessmentsSubmitted',
        { fr: 'Auto-évaluations soumises', en: 'Self-assessments submitted' },
        `FROM self_assessment_events ev
          JOIN self_assessments sa ON sa.id = ev.self_assessment_id
          JOIN employees e ON e.id = sa.employee_id`,
        'ev.created_at',
        'self_assessment_events'
    );

    await count(
        'reviewsClosed',
        { fr: 'Revues clôturées', en: 'Reviews closed' },
        `FROM supervisor_reviews sr JOIN employees e ON e.id = sr.employee_id`,
        'sr.reviewed_at',
        'supervisor_reviews'
    );

    return {
        window: {
            start: win.periodStart,
            end: win.periodEnd,
            days: win.days,
            prevStart: win.prevStart,
            prevEnd: win.prevEnd,
            prevDays: win.prevDays,
            sameLength: win.days === win.prevDays,
        },
        lines,
        // NOT PUBLISHED, and the reason travels with the brief so nobody adds it
        // back: assessment_history covers only 311 of the 2714 pairs.
        assessmentsRecorded: cell(null, {
            unit: 'count',
            kind: 'queue',
            source: 'skill_assessments (non historisée)',
            rule: {
                fr: 'historisation partielle : assessment_history ne couvre que 311 des 2714 paires',
                en: 'partial history: assessment_history covers only 311 of 2714 pairs',
            },
        }),
    };
}

async function _windowCount(fromSql, tsExpr, from, to, scope) {
    const f = scope.filter('e', 'id');
    const r = await db.get(
        `SELECT COUNT(*)::int AS n FROM (SELECT 1 AS x ${fromSql}
          WHERE ${tsExpr} >= ? AND ${tsExpr} < ?${f.clause}) t`,
        [from, to, ...f.params]
    );
    const importBatch = await _importBatchFrom(fromSql, tsExpr, from, to, scope);
    return { n: Number((r && r.n) || 0), importBatch };
}

/**
 * Import-batch detection (§2.6): when more than 60 % of a window's facts share
 * the same WRITE MINUTE, the window is an import, the line says so, and its Δ is
 * SUPPRESSED. Measured precedent: 2710 of 2714 skill_assessments rows sit in one
 * month because of a bulk load.
 */
async function _importBatchFrom(fromSql, tsExpr, from, to, scope) {
    const f = scope.filter('e', 'id');
    const rows = await db.all(
        `SELECT date_trunc('minute', ${tsExpr}) AS m, COUNT(*)::int AS n
           ${fromSql}
          WHERE ${tsExpr} >= ? AND ${tsExpr} < ?${f.clause}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
        [from, to, ...f.params]
    );
    if (!rows.length) return null;
    const total = await db.get(
        `SELECT COUNT(*)::int AS n ${fromSql} WHERE ${tsExpr} >= ? AND ${tsExpr} < ?${f.clause}`,
        [from, to, ...f.params]
    );
    const t = Number((total && total.n) || 0);
    const top = Number(rows[0].n);
    if (!t || top / t <= 0.6) return null;
    return { minute: rows[0].m, share: Math.round((1000 * top) / t) / 10 };
}

async function _importBatch(fromTable, tsExpr, scope, win, col) {
    const f = scope.filter(fromTable.split(' ').pop(), col);
    const rows = await db.all(
        `SELECT date_trunc('minute', ${tsExpr}) AS m, COUNT(*)::int AS n
           FROM ${fromTable}
          WHERE ${tsExpr} >= ? AND ${tsExpr} < ?${f.clause}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
        [win.periodStart, win.periodEnd, ...f.params]
    );
    if (!rows.length) return null;
    const total = await db.get(
        `SELECT COUNT(*)::int AS n FROM ${fromTable} WHERE ${tsExpr} >= ? AND ${tsExpr} < ?${f.clause}`,
        [win.periodStart, win.periodEnd, ...f.params]
    );
    const t = Number((total && total.n) || 0);
    const top = Number(rows[0].n);
    if (!t || top / t <= 0.6) return null;
    return { minute: rows[0].m, share: Math.round((1000 * top) / t) / 10 };
}

/**
 * A delta, or an honest reason why there is none (§2.6, §2.7 rule 5).
 * Never an arrow, never a 0, when the comparison cannot be made.
 */
function deltaOf(now, before, { metric, materiality = 1, unit = 'count', suppress = null } = {}) {
    if (suppress) return { state: 'suppressed', reason: suppress, value: null, pct: null };
    if (now === null || now === undefined) return { state: 'measure_lost', value: null, pct: null };
    if (before === null || before === undefined)
        return { state: 'first_measure', value: null, pct: null };
    const diff = Number(now) - Number(before);
    if (Math.abs(diff) < materiality) {
        return { state: 'stable', value: 0, pct: null, direction: null, color: null };
    }
    // A relative variation is meaningless against a 0 baseline — the house
    // pattern already returns null there (DeptAnalyticsController.js:265).
    const pct = Number(before) === 0 ? null : Math.round((1000 * diff) / Number(before)) / 10;
    const dir = METRIC_DIRECTION[metric] || 'higher_is_better';
    const good = dir === 'higher_is_better' ? diff > 0 : diff < 0;
    return {
        state: 'value',
        value: diff,
        pct,
        unit,
        direction: diff > 0 ? 'up' : 'down',
        // The COLOUR follows the metric's meaning, never the sign.
        color: good ? GREEN : AMBER,
    };
}

// ---------------------------------------------------------------------------
// §2.7 — the comparison is between two BRIEFS, not two org snapshots
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex of the SORTED scope ids; the literal 'unrestricted' for a
 * superadmin. A Δ is published only when two consecutive briefs of the same
 * recipient and cadence carry the SAME signature — otherwise somebody who joined
 * the team during the period would have their PREVIOUS manager's period counted
 * in their new manager's "before", and on a team of three the difference between
 * two briefs isolates them individually.
 */
function scopeSignature(ids) {
    if (ids === null || ids === undefined) return 'unrestricted';
    const sorted = [...ids].map(Number).sort((a, b) => a - b);
    return crypto.createHash('sha256').update(sorted.join(',')).digest('hex');
}

async function _previousBrief(recipient, cadence, periodStart) {
    return db.get(
        `SELECT id, period, period_start AS "periodStart", period_end AS "periodEnd",
                scope_signature AS "scopeSignature", payload
           FROM dept_briefs
          WHERE recipient_type = ? AND recipient_id = ? AND cadence = ? AND period_start < ?
          ORDER BY period_start DESC LIMIT 1`,
        [recipient.type, Number(recipient.id), cadence, periodStart]
    );
}

/**
 * How many of the cadence's own periods a prior brief may be behind the current
 * one and still form an honest period-over-period delta. Twin of
 * KpiSnapshotService.MAX_PRIOR_AGE_FACTOR: past this the last brief is a stale
 * baseline (the recipient's briefs were paused, or they were inactive for
 * months), so the arrow would compare across an unmeasured gap — better rendered
 * as a first measure than as a bogus month-on-month change.
 */
const MAX_PRIOR_BRIEF_AGE_FACTOR = 3;

function _priorTooOld(prev, currentPeriodStart) {
    if (!prev || prev.periodStart == null || prev.periodEnd == null || currentPeriodStart == null) {
        return false; // cannot tell → keep the prior (old behaviour)
    }
    const ps = new Date(prev.periodStart).getTime();
    const pe = new Date(prev.periodEnd).getTime();
    const cur = new Date(currentPeriodStart).getTime();
    if (!Number.isFinite(ps) || !Number.isFinite(pe) || !Number.isFinite(cur)) return false;
    const DAY = 24 * 3600 * 1000;
    const onePeriodMs = Math.max(pe - ps, DAY); // the prior's own span ≈ one period
    return cur - ps > MAX_PRIOR_BRIEF_AGE_FACTOR * onePeriodMs;
}

async function _seriesStart(recipient, cadence) {
    const r = await db.get(
        `SELECT MIN(period_end) AS "firstEnd" FROM dept_briefs
          WHERE recipient_type = ? AND recipient_id = ? AND cadence = ?`,
        [recipient.type, Number(recipient.id), cadence]
    );
    return (r && r.firstEnd) || null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * House pattern (manager-digest.js:32-37): a settings exception must NEVER kill
 * a tick, and every number is Number.isFinite-checked before use.
 */
async function _settings() {
    const AppSettingsModel = require('../models/AppSettingsModel');
    const num = async (key, dflt) => {
        try {
            const v = Number(await AppSettingsModel.getValue(key, dflt));
            return Number.isFinite(v) ? v : dflt;
        } catch {
            return dflt;
        }
    };
    return {
        reviewSlaDays: await num('deptBriefReviewSlaDays', 5),
        maxLines: await num('deptBriefMaxLines', 7),
        disputeSla: {
            L0: await num('dispute.l0SlaDays', 5),
            L1: await num('dispute.l1SlaDays', 7),
            L2: await num('dispute.l2SlaDays', 7),
            0: await num('dispute.l0SlaDays', 5),
            1: await num('dispute.l1SlaDays', 7),
            2: await num('dispute.l2SlaDays', 7),
        },
    };
}

// ---------------------------------------------------------------------------
// buildPayload
// ---------------------------------------------------------------------------

/**
 * The whole brief, as the FROZEN payload that will be archived and rendered.
 *
 * Contains aggregates and unit ids only — NO employee name (§5.3 guard 3): the
 * few names the brief may show (C1b) are re-resolved LIVE at read time from
 * today's governance, because a frozen name cannot be re-authorised later.
 *
 * Beware: this is NOT the notification payload. The webhook fan-out in
 * NotificationService._notify (:112-114) fires BEFORE the in-app write, before
 * the tier, before the opt-out and before the category, and posts the body as-is
 * to any enabled subscription. The notification payload is
 * `{ cadence, period, briefId, link }` and nothing else — the job builds it.
 */
async function buildPayload(recipient, cadence, win, opts = {}) {
    // one clock for the gate, the bucket AND the bounds. Bounds are passed
    // to the queries as Date objects and no SQL below uses now/current_date,
    // so the server's zone cannot move a boundary.
    if (db.inTransaction && db.inTransaction()) {
        await db.run(`SET LOCAL TimeZone = 'UTC'`);
    }

    // ONE observation instant for the whole brief. It is what the queues
    // are measured against AND what the page prints as « Calculé le … »: two
    // clocks would let a line count an item and then date it as not yet there.
    const observedAt = opts.observedAt instanceof Date ? opts.observedAt : new Date();

    const scope = opts.scope || (await scopeOf(recipient));
    const settings = opts.settings || (await _settings());
    const grid = await rosterGrid(scope);
    const ctx = {
        scope,
        grid,
        win,
        settings,
        recipient,
        observedAt,
        namesAllowed: opts.namesAllowed !== false,
    };

    // SEQUENTIAL — a tick may run inside one shared pg client (§4.6).
    const A = await blocksA(ctx);
    const B = await blocksB(ctx);
    const C = await blocksC(ctx);
    const foot = await footer(ctx);
    const flowBlock = await flow(ctx);

    const signature = scopeSignature(scope.ids);
    const prev = await _previousBrief(recipient, cadence, win.periodStart);
    const seriesStart = await _seriesStart(recipient, cadence);

    // §2.7 — the Δ basis. Four distinct renderings, never an arrow by default.
    // A prior brief older than MAX_PRIOR_BRIEF_AGE_FACTOR periods is a stale
    // baseline: treat it as no prior so the delta reads "first measure"
    // rather than a period-over-period change measured across an unmeasured gap.
    let deltaBasis = 'first_measure';
    const priorUsable = prev && !_priorTooOld(prev, win.periodStart);
    if (priorUsable)
        deltaBasis = prev.scopeSignature === signature ? 'comparable' : 'scope_changed';
    const prevPayload =
        priorUsable && prev.payload
            ? typeof prev.payload === 'string'
                ? JSON.parse(prev.payload)
                : prev.payload
            : null;

    if (deltaBasis !== 'comparable') {
        // No arrow of any kind when the periods are not comparable.
        for (const l of flowBlock.lines) {
            l.delta = {
                state: deltaBasis === 'scope_changed' ? 'scope_changed' : 'first_measure',
                value: null,
                pct: null,
            };
        }
    }
    // D5 and D1 are the only footer figures that carry a Δ in v1 (§2.7 rule 3).
    const deltas = { basis: deltaBasis, seriesStart, d5: null, d1: null };
    if (
        deltaBasis === 'comparable' &&
        prevPayload &&
        prevPayload.footer &&
        prevPayload.footer.totals
    ) {
        const pr = prevPayload.footer.totals._raw || {};
        const cu = foot.totals ? foot.totals._raw : {};
        deltas.d5 = deltaOf(cu.measuredPeople ?? null, pr.measuredPeople ?? null, {
            metric: 'measuredPeople',
            materiality: 1,
        });
        // D1 in POINTS, and only while the denominator is stable within 10 % —
        // a ratio whose denominator moved is not the same measurement.
        const now1 = cu.expected ? (100 * cu.assessed) / cu.expected : null;
        const before1 = pr.expected ? (100 * pr.assessed) / pr.expected : null;
        const denomMove = pr.expected ? Math.abs((cu.expected - pr.expected) / pr.expected) : null;
        deltas.d1 =
            denomMove !== null && denomMove < 0.1
                ? deltaOf(now1, before1, {
                      metric: 'assessmentCoverage',
                      materiality: 0.5,
                      unit: 'pts',
                  })
                : { state: 'unavailable', reason: 'denominator_moved', value: null, pct: null };
    } else if (prevPayload) {
        deltas.d5 = { state: deltaBasis, value: null, pct: null };
        deltas.d1 = { state: deltaBasis, value: null, pct: null };
    }

    const blocks = { A, B, C };
    const actionable =
        A.length +
        B.filter((s) => s.severity !== 'info').length +
        C.filter((s) => s.lines.some((l) => _lineSaysSomething(l))).length;
    // §5.4 — empty means A + B + C say nothing AND there is no new measurement
    // debt. The archive row is written anyway (is_empty = true); the job decides
    // whether to send.
    const isEmpty = actionable === 0;

    return {
        version: 1,
        cadence,
        period: win.bucket,
        periodStart: win.periodStart,
        periodEnd: win.periodEnd,
        displayEnd: win.displayEnd,
        days: win.days,
        horizonDays: win.horizonDays,
        computedAt: observedAt,
        scopeSignature: signature,
        // an UNRESTRICTED scope has no id list, but it certainly has
        // a population: every active person of the roster grid. Publishing
        // `null` here is what the job wrote to a NOT NULL column as `0`, and
        // « Effectif retenu 0 » sat on the same page as « Ensemble 76 ». The
        // null dies here, at the source, and never reaches the archive.
        scopeSize:
            scope.size !== null && scope.size !== undefined
                ? scope.size
                : grid.reduce((n, u) => n + Number(u.headcount || 0), 0),
        recipient: { type: scope.type, id: scope.id },
        units: grid.map((u) => ({ ...u, label: unitLabel(u, scope) })),
        blocks,
        footer: foot,
        flow: flowBlock,
        deltas,
        isEmpty,
        // §2.8 — the fixed closing sentence, bilingual, non-negotiable.
        disclaimer: {
            fr:
                'Les chiffres non mesurés sont affichés « — » : ils signalent une absence d’évaluation, pas une valeur nulle. ' +
                'Le bilan mesure le périmètre et l’appartenance départementale tels qu’ils sont aujourd’hui ; ' +
                'l’appartenance passée n’est pas rejouable.',
            en:
                'Unmeasured figures are shown as "—": they mean no assessment exists, not a value of zero. ' +
                'The brief measures the scope and the departmental membership as they are TODAY; ' +
                'past membership cannot be replayed.',
        },
        // §2.1 / , arbitrage §7-1 — the sentence carries the DATE it
        // was observed on, exactly as SPEC §2.1 writes it (« constaté le
        // JJ/MM/AAAA ») and exactly as the same token is honoured by the frozen
        // note at the foot of the page. `observedAt` is the anchor every block
        // A / B figure above was measured against, so the sentence is now
        // a true statement about this brief and not a generic formula.
        // ONE builder, shared with the render-time repair of the briefs archived
        // before this fix (`natureOfFiguresText`) — a second copy of the
        // sentence is a second place for it to be wrong.
        natureOfFigures: natureOfFiguresText(observedAt),
    };
}

/**
 * "Has this line got anything to act on?" — a MEASURED non-zero figure. A
 * measured ZERO, an em dash and a suppressed cell all mean "no action": they are
 * reported honestly inside the brief, but they never make an empty brief look
 * full (§5.4).
 */
function _lineSaysSomething(line) {
    for (const v of Object.values(line || {})) {
        if (v && typeof v === 'object' && v.state === STATES.MEASURED && Number(v.value) > 0)
            return true;
    }
    return false;
}

module.exports = {
    MIN_PUBLISHABLE_OBSERVATIONS,
    STATES,
    METRIC_DIRECTION,
    cell,
    scopeOf,
    scopeClause,
    directReportIds,
    rosterGrid,
    unitLabel,
    blocksA,
    blocksB,
    blocksC,
    footer,
    flow,
    deltaOf,
    scopeSignature,
    buildPayload,
    // a prior brief older than MAX_PRIOR_BRIEF_AGE_FACTOR periods is a stale
    // baseline and must not carry an arrow. Exported for the test.
    MAX_PRIOR_BRIEF_AGE_FACTOR,
    _priorTooOld,
    flowActionTitle,
    // A-07 — render-time title of a flow line, so a FROZEN payload stops
    // publishing the raw `action_type`. Exported for the page AND the e-mail.
    resolveFlowTitle,
    // M-11 — the real routes, and the alias table a FROZEN payload is rendered
    // through. Exported so the page and the job cannot each keep their own.
    LINK,
    LEGACY_LINK_ALIAS,
    resolveLink,
    //  + A-15 — the render-time repair of the ALREADY-ARCHIVED
    // briefs (the producer fix cannot reach them). Applied once, on a copy, by
    // DeptBriefController.loadForReader.
    repairFrozenPayload,
    LEGACY_C1_SOON_MAX,
    // the render-time guard on an IMPOSSIBLE frozen age, and the
    // sentence it publishes in its place. Exported for the tests and so that no
    // other surface writes a second copy of the rule.
    VOIDED_AGE,
    impossibleAgeNote,
    // The bilingual sentence builders the producer AND the repair share,
    // so the two can never drift apart. Exported for the tests.
    daysText,
    c3Note,
    c1Rule,
    // A-17 — the §2.1 sentence with the day it was observed on, and the generic
    // formula of the pre-fix archives that triggers its render-time rebuild.
    natureOfFiguresText,
    LEGACY_NATURE_OF_FIGURES,
    // Colour tokens, exported so the renderer cannot invent a fifth one.
    COLORS: { GREY, GREEN, AMBER, RED },
};
