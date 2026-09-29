'use strict';

/**
 * DeptBriefController — the CONSULTABLE side of the department brief
 * (spec of 13/09/2026, §5.3 and §7 rows 11-12).
 *
 *   GET  /reports/dept-brief              my archived briefs, filterable
 *   GET  /reports/dept-brief/:id          one brief, rendered from the FROZEN payload
 *   POST /reports/dept-brief/:id/recompute  adds a SEPARATE « state as of today » column
 *   POST /account/dept-brief-prefs        the four cadence checkboxes
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: **the page renders the payload exactly
 * as it was computed and sent; it NEVER recomputes on the way in.** That is what
 * makes the brief opposable. Every view underneath descends from
 * `v_employee_details WHERE is_active = true` (44 of the 136 supervisor_reviews
 * rows evaporate through that join), departmental membership is TODAY's, and
 * `skill_assessments.assessed_at` is mutated in place by three code paths — so a
 * silent recomputation would quietly rewrite history under the reader. The
 * recomputation therefore exists, but only as an EXPLICIT button that renders a
 * second, clearly-titled column beside the frozen one.
 *
 * THE THREE READ GUARDS (§5.3), applied in this order by `show` and `recompute`:
 *
 *  1. OWNERSHIP — a row is served only to the recipient it was addressed to
 *     (SuperAdmin excepted). A brief belonging to somebody else is a 403 with a
 *     sentence, never a blank page.
 *  2. SCOPE REPLAYED AT READ TIME — `admin_scopes` carries `revoked_at` and
 *     `expires_at`, so an archive row must NOT grant permanent access to figures
 *     the reader is no longer cleared for. The reader's scope is re-resolved on
 *     every open and every department id the payload carries must still be
 *     covered by it; otherwise 403 « hors de votre périmètre ». The same check
 *     runs for a deep link arriving from a notification: the existence of the
 *     notification proves nothing.
 *  3. NO NAME IS EVER STORED — the payload holds aggregates and unit ids only.
 *     The few names a brief may show (block C1b, certificate holders) are
 *     re-resolved LIVE from TODAY's governance, and a person who is no longer a
 *     DIRECT report of the reader is dropped. A frozen name cannot be
 *     re-authorised later, which is precisely why none is frozen.
 *
 * Scope comes from `scopedEmployeeIds(req.user)` — the SESSION identity. A
 * principal is never fabricated from the archive row: serving somebody else's
 * brief through somebody else's scope is the whole class of bug these guards
 * exist to prevent.
 */

const db = require('../config/database');
const { scopedEmployeeIds } = require('../utils/rbacScope');
const { safeBackUrl } = require('../utils/safeRedirect');
const DeptBriefService = require('../services/DeptBriefService');
const { windowFor, CADENCES } = require('../utils/periodWindow');
// Period bounds are UTC calendar boundaries, so they are printed with
// fmtPeriodBound and NOT with res.locals.fmtDate (which follows APP_TIMEZONE and
// would print a midnight-UTC bound as the previous day in a negative offset).
const { fmtPeriodBound } = require('../utils/dateFormat');
const RBACService = require('../services/RBACService');

/** Rows fetched by the list. A brief is a small, slow-moving series per person. */
const LIST_LIMIT = 200;

/**
 * the two facts about the person ABOUT TO CLICK that one deep link of the
 * brief depends on (the LMS: a hub for whoever configures it, a learner page for
 * everyone else, and no page at all for an admin without the grant). They are
 * read HERE, from the session identity, with the very test the hub's own guard
 * runs (v2-lms.js:42) — never inside the service, whose principals are built by
 * a job and carry no session permissions.
 */
function readerOf(req) {
    const u = (req && req.user) || null;
    if (!u) return null;
    return {
        isAdmin: u.userType === 'admin',
        canConfigureLms: RBACService.hasPermission(u, 'configure_lms'),
    };
}

/**
 * Weekly is OFF by default for an EMPLOYEE recipient and ON for an admin (§4.8):
 * every governing employee already receives `manager-digest` every Monday with
 * A1, A5, B1, C1, C2 and the footer, while admins receive no weekly message at
 * all. The other three cadences default to their global switch.
 */
const WEEKLY_DEFAULT_BY_TYPE = { admin: true, employee: false };

const SETTING_FOR = {
    weekly: 'deptBriefWeeklyEnabled',
    monthly: 'deptBriefMonthlyEnabled',
    quarterly: 'deptBriefQuarterlyEnabled',
    yearly: 'deptBriefYearlyEnabled',
};

function t(req, key, fallback, opts) {
    if (req && typeof req.t === 'function') {
        const v = req.t(key, { defaultValue: fallback, ...(opts || {}) });
        if (v) return v;
    }
    return fallback;
}

/**
 * The SESSION identity, in the two values `dept_briefs` is keyed on. A supervisor
 * and a people manager both carry `userType === 'manager'` in session and both
 * archive as `'employee'` — the CHECK on `notifications.user_type` (and on
 * `dept_briefs.recipient_type`) admits only 'admin' and 'employee'.
 */
function identityOf(user) {
    const type = user && user.userType === 'admin' ? 'admin' : 'employee';
    return { type, id: Number(user && user.id) || -1, role: (user && user.role) || null };
}

function isSuperAdmin(user) {
    return !!(user && user.userType === 'admin' && user.role === 'superadmin');
}

function forbid(req, next, key, fallback) {
    const err = new Error(t(req, key, fallback));
    err.status = 403;
    // `expose` keeps the sentence readable on a production appliance: a refusal
    // the reader cannot understand is indistinguishable from an outage.
    err.expose = true;
    return next(err);
}

function notFound(req, next) {
    const err = new Error(t(req, 'reports:db_not_found', 'Ce bilan n’existe pas.'));
    err.status = 404;
    err.expose = true;
    return next(err);
}

/**
 * The reader's scope object, in the exact shape DeptBriefService consumes.
 *
 * The ids come from `scopedEmployeeIds(req.user)` — the same resolution the job
 * uses through `RBACService.scopeFilter` (SuperAdmin → null; admin →
 * getFilteredEmployees; manager/supervisor → findGovernedIds), which is what
 * makes the page and the job agree on the headcount (AC-3). `type` is carried so
 * `unitLabel` renders the ADMIN form of R3 (« votre périmètre : 1 personne sur
 * 36 ») rather than the employee one.
 */
async function readerScope(req) {
    const who = identityOf(req.user);
    const ids = await scopedEmployeeIds(req.user);
    return {
        type: who.type,
        id: who.id,
        role: who.role,
        ids,
        unrestricted: ids === null,
        size: ids === null ? null : ids.length,
        principal:
            who.type === 'admin'
                ? { id: who.id, userType: 'admin', role: who.role }
                : { id: who.id, userType: 'employee' },
        filter(alias, column = 'id') {
            return DeptBriefService.scopeClause(ids, alias, column);
        },
    };
}

/** node-pg hands jsonb back parsed; a text column would arrive as a string. */
function parsePayload(raw) {
    if (!raw) return {};
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }
    return raw;
}

const ROW_COLUMNS = `id, cadence, period,
        recipient_type AS "recipientType", recipient_id AS "recipientId",
        period_start AS "periodStart", period_end AS "periodEnd",
        scope_signature AS "scopeSignature", scope_size AS "scopeSize",
        is_empty AS "isEmpty", computed_at AS "computedAt", sent_at AS "sentAt"`;

class DeptBriefController {
    // -----------------------------------------------------------------------
    // GET /reports/dept-brief
    // -----------------------------------------------------------------------
    async list(req, res) {
        const scope = await readerScope(req);
        const grid = await DeptBriefService.rosterGrid(scope);
        const inScope = new Set(grid.map((u) => Number(u.departmentId)));

        // §5.3 — `?dept=` is INTERSECTED with the re-resolved scope. A department
        // outside it answers « hors de votre périmètre » and still lists the
        // briefs; an empty table would itself be a signal (and a wrong one).
        const rawDept = String(req.query.dept || '').trim();
        let dept = null;
        let deptOutOfScope = false;
        if (rawDept) {
            if (/^\d{1,18}$/.test(rawDept) && inScope.has(Number(rawDept))) dept = Number(rawDept);
            else deptOutOfScope = true;
        }

        const cadence = CADENCES.includes(String(req.query.cadence || ''))
            ? String(req.query.cadence)
            : '';
        const rawPeriod = String(req.query.period || '').trim();
        const period = /^[0-9A-Za-z-]{1,10}$/.test(rawPeriod) ? rawPeriod : '';

        const who = identityOf(req.user);
        const params = [];
        let where = '';
        // GUARD 1 on the list too: only my own rows, unless I am a SuperAdmin.
        if (!isSuperAdmin(req.user)) {
            where += ' AND recipient_type = ? AND recipient_id = ?';
            params.push(who.type, who.id);
        }
        if (cadence) {
            where += ' AND cadence = ?';
            params.push(cadence);
        }
        if (period) {
            where += ' AND period = ?';
            params.push(period);
        }
        if (dept !== null) {
            // Containment on the frozen unit list — the department is part of the
            // payload, not a column, and the brief must not be re-derived to
            // answer a filter.
            where += ` AND payload -> 'units' @> ?::jsonb`;
            params.push(JSON.stringify([{ departmentId: dept }]));
        }

        const rows = await db.all(
            `SELECT ${ROW_COLUMNS} FROM dept_briefs
              WHERE 1 = 1${where}
              ORDER BY period_start DESC, id DESC
              LIMIT ${LIST_LIMIT}`,
            params
        );

        // §2.7 rule 6 — the series start, per cadence, so the reader knows from
        // which brief a comparison becomes possible at all.
        const series = await db.all(
            `SELECT cadence, MIN(period_end) AS "firstEnd", COUNT(*)::int AS n
               FROM dept_briefs
              WHERE recipient_type = ? AND recipient_id = ?
              GROUP BY cadence`,
            [who.type, who.id]
        );

        return res.render('pages/reports/dept-brief', {
            title: t(req, 'reports:db_title', 'Bilans de département'),
            briefs: rows,
            filters: { cadence, period, dept: dept === null ? '' : String(dept) },
            units: grid.map((u) => ({ ...u, label: DeptBriefService.unitLabel(u, scope) })),
            deptOutOfScope,
            scopeSize: scope.size,
            unrestricted: scope.unrestricted,
            viewingAsSuperAdmin: isSuperAdmin(req.user),
            me: who,
            series,
            cadences: CADENCES,
            fmtPeriodBound,
        });
    }

    // -----------------------------------------------------------------------
    // GET /reports/dept-brief/:id
    // -----------------------------------------------------------------------
    async show(req, res, next) {
        const loaded = await loadForReader(req, next);
        if (!loaded) return undefined; // a guard already answered
        const { row, payload, scope, names } = loaded;

        return res.render('pages/reports/dept-brief-show', {
            title: t(req, 'reports:db_show_title', 'Bilan de département'),
            brief: row,
            payload,
            names,
            today: null,
            // Recomputation is offered only to the recipient themself: running it
            // for somebody else would have to resolve THEIR scope, and this
            // controller never fabricates a principal.
            canRecompute: isOwner(req, row),
            scopeSize: scope.size,
            unrestricted: scope.unrestricted,
            // M-11 — deep links of an ALREADY ARCHIVED payload are resolved at
            // render time through the service's alias table. The archive is
            // never rewritten; eight of its links pointed at routes that are not
            // mounted (S10 closed the five the first pass had not opened).
            // The reader is passed because ONE destination depends on them: the
            // LMS hub is for whoever configures it, the learner page for everyone
            // else, and an admin without the grant is offered no link at all.
            linkOf: (l) => DeptBriefService.resolveLink(l, readerOf(req)),
            // A-07 — a frozen flow title that is a database token is recomputed
            // at render time, the same way the frozen deep links are.
            flowTitleOf: DeptBriefService.resolveFlowTitle,
            csrfToken: req.csrfToken ? req.csrfToken() : res.locals && res.locals.csrfToken,
            fmtPeriodBound,
        });
    }

    // -----------------------------------------------------------------------
    // POST /reports/dept-brief/:id/recompute
    // -----------------------------------------------------------------------
    /**
     * « État au <date du jour> » — a SEPARATE column, never a rewrite.
     *
     * Nothing is written: `buildPayload` is a pure read (it is the job that
     * archives). The window is the same CADENCE anchored on today, so the two
     * columns are the same measurement taken at two instants — which is exactly
     * the point being demonstrated: the reference data moves.
     */
    async recompute(req, res, next) {
        const loaded = await loadForReader(req, next);
        if (!loaded) return undefined;
        const { row, payload, scope, names } = loaded;

        if (!isOwner(req, row)) {
            return forbid(
                req,
                next,
                'reports:db_forbidden_recompute',
                'Le recalcul n’est offert qu’au destinataire du bilan.'
            );
        }

        const recipient = { type: scope.type, id: scope.id, role: scope.role };
        const win = windowFor(row.cadence, new Date());
        // One read transaction: buildPayload sets `SET LOCAL TimeZone = 'UTC'`
        // only inside one, and a torn read (headcount at one instant, campaign at
        // another) is exactly what produces "0 enrolled" beside "36 submitted".
        const today = await db.runTransaction(async () =>
            DeptBriefService.buildPayload(recipient, row.cadence, win, { scope })
        );

        return res.render('pages/reports/dept-brief-show', {
            title: t(req, 'reports:db_show_title', 'Bilan de département'),
            brief: row,
            payload,
            names,
            today,
            canRecompute: true,
            scopeSize: scope.size,
            unrestricted: scope.unrestricted,
            linkOf: (l) => DeptBriefService.resolveLink(l, readerOf(req)), // M-11 + S10
            flowTitleOf: DeptBriefService.resolveFlowTitle, // A-07
            csrfToken: req.csrfToken ? req.csrfToken() : res.locals && res.locals.csrfToken,
            fmtPeriodBound,
        });
    }

    // -----------------------------------------------------------------------
    // POST /account/dept-brief-prefs
    // -----------------------------------------------------------------------
    /**
     * The four cadence checkboxes. Written on the SESSION identity — the same
     * identity the bell, `markRead` and the e-mail opt-out use, so a person can
     * always switch off what they can see.
     *
     * All four cadences are written explicitly, ON and OFF alike: an unchecked
     * checkbox posts nothing, so "absent from the body" has to mean OFF here, and
     * a missing row would otherwise fall back to the default and silently switch
     * the cadence back on.
     */
    async savePrefs(req, res) {
        const who = identityOf(req.user);
        const body = req.body || {};
        const wanted = {};
        for (const c of CADENCES) wanted[c] = isChecked(body[c]);

        await db.runTransaction(async () => {
            for (const c of CADENCES) {
                await db.run(
                    `INSERT INTO dept_brief_prefs (recipient_type, recipient_id, cadence, enabled, updated_at)
                     VALUES (?, ?, ?, ?, now())
                     ON CONFLICT (recipient_type, recipient_id, cadence)
                     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
                    [who.type, who.id, c, wanted[c]]
                );
            }
        });

        if (req.flash)
            req.flash(
                'success',
                t(req, 'reports:db_prefs_saved', 'Fréquence du bilan enregistrée.')
            );
        return res.redirect(safeBackUrl(req, '/account/notifications'));
    }

    // -----------------------------------------------------------------------
    // Local provider for the SHARED preferences page
    // -----------------------------------------------------------------------
    /**
     * `/account/notifications` is rendered by NotificationController, which
     * belongs to no lot of this programme and is therefore not edited here. This
     * one-line middleware puts the reader's cadence preferences on `res.locals`
     * so the shared page can render the four checkboxes SERVER-SIDE, with their
     * real state, without a client-side hydration round trip and without a
     * second GET endpoint. It is mounted immediately before that route.
     */
    async attachPrefs(req, res, next) {
        if (req.method !== 'GET') return next();
        try {
            res.locals.deptBriefPrefs = await prefsFor(identityOf(req.user));
        } catch (e) {
            // A preferences read must never take the notification page down.
            res.locals.deptBriefPrefs = null;
        }
        return next();
    }

    /** Public alias — used by the brief page itself and by the tests. */
    async prefsFor(who) {
        return prefsFor(who);
    }
}

/**
 * Effective preference per cadence: the stored row when there is one, the
 * default otherwise. `source` travels with it so the page can say « valeur par
 * défaut » instead of pretending the person chose it.
 */
async function prefsFor(who) {
    const rows = await db.all(
        `SELECT cadence, enabled FROM dept_brief_prefs
          WHERE recipient_type = ? AND recipient_id = ?`,
        [who.type, who.id]
    );
    const stored = {};
    for (const r of rows || [])
        stored[String(r.cadence)] = r.enabled === true || r.enabled === 't' || r.enabled === 1;

    const out = {};
    for (const c of CADENCES) {
        const explicit = Object.prototype.hasOwnProperty.call(stored, c);
        out[c] = {
            enabled: explicit ? stored[c] : await defaultFor(c, who.type),
            source: explicit ? 'explicit' : 'default',
        };
    }
    return out;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isOwner(req, row) {
    const who = identityOf(req.user);
    return row.recipientType === who.type && Number(row.recipientId) === who.id;
}

/**
 * Load one archived brief and run the THREE read guards on it. Returns null when
 * a guard has already answered the request.
 */
async function loadForReader(req, next) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        notFound(req, next);
        return null;
    }

    const row = await db.get(`SELECT ${ROW_COLUMNS}, payload FROM dept_briefs WHERE id = ?`, [id]);
    if (!row) {
        notFound(req, next);
        return null;
    }

    // ---- GUARD 1 — ownership ------------------------------------------------
    if (!isOwner(req, row) && !isSuperAdmin(req.user)) {
        forbid(
            req,
            next,
            'reports:db_forbidden_not_yours',
            'Ce bilan est adressé à quelqu’un d’autre : il ne vous est pas servi.'
        );
        return null;
    }

    //  + A-15 — the SENTENCES of an already-archived brief are
    // repaired here, on a copy, exactly as M-11 repairs its dead deep links: an
    // archived payload is never recomputed, so an impossible bucket interval
    // (« 31–30 j »), a column empty by construction (« Au-delà de 30 jours : 0 »)
    // and three frozen agreement faults (« 1 postes occupés », « 1 of 36
    // person », « -13 jour ») can only be corrected on the way out. NO FIGURE
    // MOVES: every number stays the one that was computed and sent, and nothing
    // is written back to `dept_briefs`.
    const payload = DeptBriefService.repairFrozenPayload(parsePayload(row.payload));
    const scope = await readerScope(req);

    // ---- GUARD 2 — scope REPLAYED at read time ------------------------------
    // admin_scopes carries revoked_at and expires_at. An archive row must not
    // become a permanent window onto figures the reader has since lost the right
    // to see, so the scope is re-resolved on every open and every department the
    // payload carries must still be inside it.
    if (!scope.unrestricted) {
        const grid = await DeptBriefService.rosterGrid(scope);
        const covered = new Set(grid.map((u) => Number(u.departmentId)));
        const unitIds = (payload.units || []).map((u) => Number(u.departmentId));
        const lost = unitIds.filter((d) => !covered.has(d));
        if (!scope.ids || !scope.ids.length || lost.length) {
            forbid(
                req,
                next,
                'reports:db_forbidden_out_of_scope',
                'Ce bilan porte sur des départements qui sont aujourd’hui hors de votre périmètre.'
            );
            return null;
        }
    }

    // ---- GUARD 3 — names re-resolved LIVE, never frozen ---------------------
    const names = await resolveNames(scope, payload);

    return { row, payload, scope, names };
}

/**
 * Block C1b carries `employeeId` and nothing else. A name is published only when
 * the person is STILL a direct report of the reader today — `directReportIds`,
 * not `findGovernedIds`: the sub-tree would name people three levels away.
 *
 * An admin never receives names for this block, whatever the breadth of their
 * scope (§2.4 C1b). Everything that cannot be re-authorised is counted in
 * `withheld` and said out loud, because a silently shortened list reads as
 * "nothing to report".
 */
async function resolveNames(scope, payload) {
    const out = { byId: {}, withheld: 0, allowed: false };
    const blocks = (payload && payload.blocks && payload.blocks.C) || [];
    const c1b = blocks.find((s) => s && s.id === 'C1b');
    if (!c1b || !Array.isArray(c1b.lines) || !c1b.lines.length) return out;

    const wanted = c1b.lines.map((l) => Number(l.employeeId)).filter(Boolean);
    if (!wanted.length) return out;

    if (scope.type !== 'employee') {
        out.withheld = wanted.length;
        return out;
    }
    out.allowed = true;

    const direct = new Set(await DeptBriefService.directReportIds(scope.id));
    const inScope = (eid) => scope.unrestricted || (scope.ids || []).includes(eid);
    const serve = wanted.filter((eid) => direct.has(eid) && inScope(eid));
    out.withheld = wanted.length - serve.length;
    if (!serve.length) return out;

    const rows = await db.all(
        `SELECT employee_id AS "employeeId", full_name AS "fullName"
           FROM v_employee_details WHERE is_active AND employee_id = ANY(?)`,
        [serve]
    );
    for (const r of rows || []) out.byId[Number(r.employeeId)] = r.fullName;
    // A row that is in `serve` but absent from the view (deactivated between the
    // two statements) simply has no name — the line is dropped by the view.
    out.withheld += serve.length - (rows || []).length;
    return out;
}

// ---------------------------------------------------------------------------
// Preferences defaults
// ---------------------------------------------------------------------------

function isChecked(v) {
    if (v === true) return true;
    const s = String(v === undefined || v === null ? '' : v).toLowerCase();
    return s === 'on' || s === 'true' || s === '1' || s === 'yes';
}

/**
 * House pattern (manager-digest.js:32-37): a settings exception must NEVER take
 * the surface down, and the fallback is the documented default.
 */
async function defaultFor(cadence, recipientType) {
    let global = true;
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        const v = await AppSettingsModel.getValue(SETTING_FOR[cadence], true);
        global = !(v === false || v === 0 || v === '0' || v === 'false');
    } catch {
        global = true;
    }
    if (cadence !== 'weekly') return global;
    return global && WEEKLY_DEFAULT_BY_TYPE[recipientType] !== false;
}

module.exports = new DeptBriefController();
// Named helpers, exported for the unit tests (no scheduler, no HTTP session).
module.exports.__test = {
    identityOf,
    isSuperAdmin,
    isChecked,
    defaultFor,
    resolveNames,
    parsePayload,
    prefsFor,
};
