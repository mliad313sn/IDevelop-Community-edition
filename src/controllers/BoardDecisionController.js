'use strict';

/**
 * BoardDecisionController — the decisions taken on a board pack and the
 * pack recorded as presented (4.0.0 port, wave 9; BoardPackService).
 *
 *   GET  /exec/decisions                the decisions of the pack scope, with
 *                                       their history and follow-up forms
 *   POST /exec/decisions                record a decision
 *   POST /exec/decisions/:id/state      move its follow-up state (dropping
 *                                       needs a reason)
 *   POST /exec/decisions/:id/note       add a follow-up note
 *   POST /exec/board-pack/record        record the pack as presented
 *
 * The router mount (routes/index.js) already applies requireManagerOrAdmin and
 * the RBAC scope; the session's CSRF token guards every POST (server.js).
 * Each request resolves the pack scope with the SAME rules as the pack
 * (DashboardHomeService.context, page 'board_pack'): a unit outside the
 * reader's clearance is refused, never widened, and the key it is stored
 * under is the reader's own unless they see the whole unit
 * (BoardPackService.scopeKeyFor). Writing needs a manager or an
 * administrator who is not read-only, checked in the service. Every redirect
 * goes to a fixed path; the scope comes back from the remembered choice.
 */

const D = require('../services/DashboardHomeService');
const B = require('../services/BoardPackService');
const NAV = require('../config/navigation');

/** Locale key of each refusal (full keys, so the locale scan finds them). */
const ERRORS = new Map([
    ['text_required', 'exec:bd_err_text_required'],
    ['text_too_long', 'exec:bd_err_text_too_long'],
    ['owner_role', 'exec:bd_err_owner_role'],
    ['decided_at', 'exec:bd_err_decided_at'],
    ['decided_future', 'exec:bd_err_decided_future'],
    ['pack_date', 'exec:bd_err_pack_date'],
    ['due_date', 'exec:bd_err_due_date'],
    ['due_before', 'exec:bd_err_due_before'],
    ['kpi', 'exec:bd_err_kpi'],
    ['state', 'exec:bd_err_state'],
    ['reason_required', 'exec:bd_err_reason_required'],
    ['same_state', 'exec:bd_err_same_state'],
    ['note_required', 'exec:bd_err_note_required'],
    ['person_name', 'exec:bd_err_person_name'],
    ['scope_refused', 'exec:bd_err_scope'],
]);

const DECISIONS = '/exec/decisions';
const PACK = '/exec/board-pack';

function tr(req) {
    return typeof req.t === 'function' ? req.t.bind(req) : (k) => k;
}

function navVisible(res) {
    try {
        return NAV.gates(NAV.buildContext(res.locals || {}));
    } catch (_) {
        return {};
    }
}

/** The scope fields of a form body: the three keys the scope bar knows, nothing else. */
function scopeFields(body) {
    const b = body || {};
    const pick = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
    const out = {};
    if (typeof pick(b.site) === 'string') out.site = pick(b.site);
    if (typeof pick(b.department) === 'string') out.department = pick(b.department);
    if (pick(b.scope) === 'all') out.scope = 'all';
    return out;
}

/** The hidden fields that carry a validated scope in a form. Pure. */
function hiddenFields(scope) {
    const s = scope || {};
    const f = [];
    if (s.site !== undefined && s.site !== null) f.push({ name: 'site', value: String(s.site) });
    if (s.department !== undefined && s.department !== null)
        f.push({ name: 'department', value: String(s.department) });
    if (!f.length) f.push({ name: 'scope', value: 'all' });
    return f;
}

async function postContext(req, res) {
    return D.context({
        user: req.user,
        query: scopeFields(req.body),
        page: 'board_pack',
        // a form submit applies the scope it carries, as a link would
        remember: true,
        navVisible: navVisible(res),
    });
}

function flash(req, kind, key) {
    if (typeof req.flash === 'function') req.flash(kind, tr(req)(key));
}

/** A refused form: the message, then back to a fixed page. Anything else goes on. */
function fail(req, res, next, err, back) {
    if (!(err instanceof B.BoardError)) return next(err);
    if (err.status === 403 || err.status === 404) {
        const e = new Error(err.status === 403 ? 'Forbidden' : 'Not found');
        e.status = err.status;
        return next(e);
    }
    flash(req, 'error', ERRORS.has(err.code) ? ERRORS.get(err.code) : 'exec:bd_err_state');
    return res.redirect(303, back);
}

const BoardDecisionController = {
    scopeFields,
    hiddenFields,

    /** GET /exec/decisions */
    async page(req, res, next) {
        try {
            const ctx = await D.context({
                user: req.user,
                query: req.query || {},
                page: 'board_pack',
                navVisible: navVisible(res),
            });
            const t = tr(req);
            let decisions = null;
            if (!ctx.scopeRefused && ctx.caps.pop) {
                const key = await B.scopeKeyFor(ctx);
                decisions = await B.listDecisions(key, { viewer: req.user });
            }
            res.status(ctx.scopeRefused ? 400 : 200).render('pages/exec/decisions', {
                title: t('exec:bd_title'),
                ctx,
                decisions,
                scopeLabel: D.scopeLabel(ctx, t),
                hidden: hiddenFields(ctx.scope),
                canWrite: B.canWrite(req.user),
                ownerRoles: B.OWNER_ROLES,
                states: B.STATES,
                kpis: B.DECISION_KPIS.filter((k) =>
                    require('../services/KpiService').isAvailable(k, ctx.flags)
                ),
                today: await require('../services/KpiService').dbToday(),
                currentPath: DECISIONS,
            });
        } catch (err) {
            next(err);
        }
    },

    /** POST /exec/decisions */
    async create(req, res, next) {
        try {
            const ctx = await postContext(req, res);
            if (ctx.scopeRefused || !ctx.caps.pop) throw new B.BoardError('scope_refused');
            await B.createDecision(await B.scopeKeyFor(ctx), req.body || {}, req.user);
            flash(req, 'success', 'exec:bd_flash_created');
            return res.redirect(303, DECISIONS);
        } catch (err) {
            return fail(req, res, next, err, DECISIONS);
        }
    },

    /** POST /exec/decisions/:id/state */
    async state(req, res, next) {
        try {
            const ctx = await postContext(req, res);
            if (ctx.scopeRefused || !ctx.caps.pop) throw new B.BoardError('scope_refused');
            await B.setState(req.params.id, await B.scopeKeyFor(ctx), req.body || {}, req.user);
            flash(req, 'success', 'exec:bd_flash_state');
            return res.redirect(303, DECISIONS);
        } catch (err) {
            return fail(req, res, next, err, DECISIONS);
        }
    },

    /** POST /exec/decisions/:id/note */
    async note(req, res, next) {
        try {
            const ctx = await postContext(req, res);
            if (ctx.scopeRefused || !ctx.caps.pop) throw new B.BoardError('scope_refused');
            await B.addNote(req.params.id, await B.scopeKeyFor(ctx), req.body || {}, req.user);
            flash(req, 'success', 'exec:bd_flash_note');
            return res.redirect(303, DECISIONS);
        } catch (err) {
            return fail(req, res, next, err, DECISIONS);
        }
    },

    /**
     * POST /exec/board-pack/record — record the pack as presented: what it
     * says NOW is kept, and the next pack of the same scope compares with it.
     * Opening or printing the pack writes nothing.
     */
    async record(req, res, next) {
        try {
            const ctx = await postContext(req, res);
            if (ctx.scopeRefused || !ctx.caps.pop) throw new B.BoardError('scope_refused');
            if (!B.canWrite(req.user)) throw new B.BoardError('forbidden', 403);
            const t = tr(req);
            const screen = await D.firstScreen(ctx, { t, fmt: res.locals.numFmt });
            const model = await B.packModel(ctx, screen, { t });
            await B.recordRun(
                model.scopeKey,
                {
                    results: model.results,
                    pop: ctx.pop,
                    coverage: model.coverage,
                    snapshotDate: model.snapshotDate,
                },
                req.user
            );
            flash(req, 'success', 'exec:bp_flash_recorded');
            return res.redirect(303, PACK);
        } catch (err) {
            return fail(req, res, next, err, PACK);
        }
    },
};

module.exports = BoardDecisionController;
