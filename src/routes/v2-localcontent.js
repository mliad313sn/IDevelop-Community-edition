'use strict';

/**
 * Local content — nationalisation plans and regulator packs (3.23.18).
 *
 * Mounted by routes/index.js UNDER the local-content page, behind the same
 * gates as the page itself:
 *
 *   router.use('/reports/local-content', requireManagerOrAdmin, rbacMiddleware,
 *              require('./v2-localcontent'));
 *
 * It is NOT behind V2_FEATURES: the optional module is gated by its own
 * `featureLocalContent` setting (checked below, same rule as the page).
 *
 * Every write is a form POST from the page (CSRF-protected by the global
 * middleware) and answers either JSON (API callers) or a redirect back to the
 * right tab with a flash message. The services re-check every permission and
 * the scope: the route guards are the first line, not the only one.
 */

const express = require('express');
const router = express.Router();
const { requireManagerOrAnyPermission, requireAnyPermission } = require('../middleware/auth');
const { wantsJson } = require('../utils/wantsJson');
const LocalContentController = require('../controllers/LocalContentController');
const Nationalisation = require('../services/NationalisationService');
const Reports = require('../services/LocalContentReportService');
const LogService = require('../services/LogService');

const PAGE = '/reports/local-content';
const TAB_NAT = `${PAGE}?tab=nationalisation`;
const TAB_PACK = `${PAGE}?tab=regulatory`;

const requirePlanWrite = requireManagerOrAnyPermission('manage_succession');
const requirePlanRead = requireManagerOrAnyPermission('view_continuity', 'manage_succession');
const requirePackRead = requireAnyPermission('view_compliance', 'manage_compliance');
const requirePackWrite = requireAnyPermission('manage_compliance');

// The module is optional: when it is off, none of this exists.
router.use(async (req, res, next) => {
    try {
        if (await LocalContentController._enabled()) return next();
    } catch (_) {
        /* fail closed */
    }
    return res.status(404).json({ error: 'not_found' });
});

function tr(req, key, fallback) {
    return req.t ? req.t(key) : fallback || key;
}

function actor(req) {
    const u = req.user || {};
    return {
        adminId: u.userType === 'admin' ? Number(u.id) : null,
        actorRef: Nationalisation.actorRef(u),
    };
}

async function audit(req, action, entityType, entityId, details) {
    try {
        await LogService.log({
            ...actor(req),
            action,
            entityType,
            entityId: entityId != null ? Number(entityId) : null,
            details: details ? String(details).slice(0, 500) : null,
            category: 'local_content',
            ipAddress: req.ip,
        });
    } catch (_) {
        /* the event journal is the record; the system log is best-effort */
    }
}

function id(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Run a write and answer: JSON for API callers, redirect + flash for the page.
 * Service errors carry `status` + an i18n key; anything else is a 500 whose
 * text is never shown.
 */
function act(back, okKey, fn) {
    return async (req, res) => {
        try {
            const out = await fn(req);
            if (wantsJson(req)) return res.json({ ok: true, ...out });
            req.flash('success', tr(req, okKey));
            return res.redirect(back);
        } catch (e) {
            const status = e && e.expose && e.status ? e.status : 500;
            if (status === 500) console.error('local-content write error:', e);
            const msg =
                e && e.expose && e.i18nKey
                    ? tr(req, e.i18nKey, e.message)
                    : tr(req, 'localcontent:err_generic', 'Error');
            if (wantsJson(req)) {
                return res
                    .status(status)
                    .json({ error: e && e.expose ? e.code : 'error', message: msg });
            }
            req.flash('error', msg);
            return res.redirect(back);
        }
    };
}

// ---- nationalisation plans --------------------------------------------------

router.post(
    '/nationalisation/plans',
    requirePlanWrite,
    act(TAB_NAT, 'localcontent:ok_plan_created', async (req) => {
        const out = await Nationalisation.createPlan(req.user, {
            incumbentEmployeeId: id(req.body.incumbentEmployeeId),
            targetDate: String(req.body.targetDate || ''),
            notes: req.body.notes || null,
        });
        await audit(req, 'lc_nationalisation_plan_created', 'lc_nationalisation_plan', out.id);
        return out;
    })
);

router.post(
    '/nationalisation/plans/:id/target',
    requirePlanWrite,
    act(TAB_NAT, 'localcontent:ok_target_moved', async (req) => {
        const out = await Nationalisation.setTargetDate(
            req.user,
            id(req.params.id),
            String(req.body.targetDate || ''),
            req.body.reason
        );
        await audit(req, 'lc_nationalisation_target_moved', 'lc_nationalisation_plan', out.id);
        return out;
    })
);

router.post(
    '/nationalisation/plans/:id/close',
    requirePlanWrite,
    act(TAB_NAT, 'localcontent:ok_plan_closed', async (req) => {
        const out = await Nationalisation.closePlan(
            req.user,
            id(req.params.id),
            String(req.body.state || ''),
            req.body.reason
        );
        await audit(req, `lc_nationalisation_plan_${out.state}`, 'lc_nationalisation_plan', out.id);
        return out;
    })
);

router.post(
    '/nationalisation/plans/:id/successors',
    requirePlanWrite,
    act(TAB_NAT, 'localcontent:ok_successor_added', async (req) => {
        const out = await Nationalisation.addSuccessor(
            req.user,
            id(req.params.id),
            id(req.body.employeeId)
        );
        await audit(
            req,
            'lc_nationalisation_successor_added',
            'lc_nationalisation_plan',
            req.params.id
        );
        return out;
    })
);

router.post(
    '/nationalisation/successors/:id/withdraw',
    requirePlanWrite,
    act(TAB_NAT, 'localcontent:ok_successor_withdrawn', async (req) => {
        const out = await Nationalisation.withdrawSuccessor(
            req.user,
            id(req.params.id),
            req.body.reason
        );
        await audit(
            req,
            'lc_nationalisation_successor_withdrawn',
            'lc_nationalisation_successor',
            out.id
        );
        return out;
    })
);

router.post(
    '/nationalisation/successors/:id/idp',
    requirePlanWrite,
    act(TAB_NAT, 'localcontent:ok_idp_linked', async (req) => {
        const locale = req.language && String(req.language).startsWith('en') ? 'en' : 'fr';
        const out = await Nationalisation.linkIdp(req.user, id(req.params.id), { locale });
        await audit(
            req,
            out.created ? 'lc_nationalisation_idp_created' : 'lc_nationalisation_idp_linked',
            'lc_nationalisation_successor',
            req.params.id,
            `idp ${out.idpId}`
        );
        return out;
    })
);

router.get('/nationalisation/plans/:id/candidates', requirePlanRead, async (req, res) => {
    try {
        res.json({
            candidates: await Nationalisation.candidateSuccessors(req.user, id(req.params.id)),
        });
    } catch (e) {
        res.status(e && e.expose ? e.status : 500).json({
            error: e && e.expose ? e.code : 'error',
        });
    }
});

router.get('/nationalisation/plans/:id/events', requirePlanRead, async (req, res) => {
    try {
        res.json({ events: await Nationalisation.events(req.user, id(req.params.id)) });
    } catch (e) {
        res.status(e && e.expose ? e.status : 500).json({
            error: e && e.expose ? e.code : 'error',
        });
    }
});

// ---- regulator packs ----------------------------------------------------------

router.post(
    '/packs',
    requirePackWrite,
    act(TAB_PACK, 'localcontent:ok_pack_generated', async (req) => {
        const out = await Reports.generateDraft(req.user, {
            countryId: id(req.body.countryId),
            periodType: String(req.body.periodType || ''),
            periodLabel: String(req.body.periodLabel || ''),
        });
        await audit(req, 'lc_pack_generated', 'lc_regulatory_pack', out.id);
        return out;
    })
);

router.post(
    '/packs/:id/publish',
    requirePackWrite,
    act(TAB_PACK, 'localcontent:ok_pack_published', async (req) => {
        // A form checkbox posts "1"/"on"; JSON callers may send true.
        const ticked = (v) => v === true || v === 1 || ['1', 'on', 'true'].includes(String(v));
        const out = await Reports.publish(req.user, id(req.params.id), {
            exactFigures: ticked(req.body.exactFigures),
            acknowledgeUnspecified: ticked(req.body.acknowledgeUnspecified),
        });
        // the exact-figures choice is audited with the publication.
        await audit(
            req,
            'lc_pack_published',
            'lc_regulatory_pack',
            out.id,
            [
                `exact figures: ${out.exactFigures ? 'yes' : 'no'}`,
                `unspecified nationality: ${out.unspecifiedPct == null ? 'n/a' : `${out.unspecifiedPct} %`}${out.unspecifiedAcknowledged ? ' (acknowledged)' : ''}`,
                out.superseded ? `supersedes ${out.superseded}` : null,
            ]
                .filter(Boolean)
                .join('; ')
        );
        return out;
    })
);

router.post(
    '/packs/:id/discard',
    requirePackWrite,
    act(TAB_PACK, 'localcontent:ok_pack_discarded', async (req) => {
        const out = await Reports.discard(req.user, id(req.params.id), req.body.reason);
        await audit(req, 'lc_pack_discarded', 'lc_regulatory_pack', out.id);
        return out;
    })
);

function packFileName(pack, ext) {
    const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-');
    return `local-content-${safe(pack.snapshot && pack.snapshot.meta && pack.snapshot.meta.countryCode)}-${safe(pack.periodLabel)}-v${Number(pack.version)}.${ext}`;
}

router.get('/packs/:id/xlsx', requirePackRead, async (req, res) => {
    try {
        const pack = await Reports.get(req.user, id(req.params.id));
        const buf = await Reports.toXlsx(pack, req.t);
        await audit(req, 'lc_pack_exported', 'lc_regulatory_pack', pack.id, 'xlsx');
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${packFileName(pack, 'xlsx')}"`
        );
        return res.send(Buffer.from(buf));
    } catch (e) {
        if (!(e && e.expose)) console.error('local-content xlsx error:', e);
        return res
            .status(e && e.expose ? e.status : 500)
            .json({ error: e && e.expose ? e.code : 'error' });
    }
});

router.get('/packs/:id/print', requirePackRead, async (req, res) => {
    try {
        const pack = await Reports.get(req.user, id(req.params.id));
        const vm = Reports.viewModel(pack, req.t);
        await audit(req, 'lc_pack_exported', 'lc_regulatory_pack', pack.id, 'print');
        return res.render('pages/reports/local-content-pack', {
            layout: false,
            title: vm.labels.title,
            vm,
        });
    } catch (e) {
        if (!(e && e.expose)) console.error('local-content print error:', e);
        return res
            .status(e && e.expose ? e.status : 500)
            .json({ error: e && e.expose ? e.code : 'error' });
    }
});

module.exports = router;
