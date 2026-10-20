'use strict';

/**
 * KpiTargetController — « Indicator targets » (/kpi/targets, migration 186).
 *
 *   GET  /kpi/targets  any ADMINISTRATOR account (SuperAdmin, local admin,
 *                      viewer): the targets in force today per indicator and
 *                      scope it can see, and the dated history.
 *   POST /kpi/targets  record a target decision (a NEW row; a withdrawal is an
 *                      empty value). The authority is decided by
 *                      KpiTargetService (manage_kpi_targets within the
 *                      clearance; a SuperAdmin everywhere; the organisation
 *                      only with an unrestricted clearance). Audited.
 * Module-aware: an indicator whose module is off is not listed and not
 * accepted (KpiTargetService). The page answers a fixed relative redirect.
 */

const KpiTargetService = require('../services/KpiTargetService');
const { fmtNum, fmtPct } = require('../utils/kpiFormat');
const { fmtDate } = require('../utils/dateFormat');

const PAGE = '/kpi/targets';

function langOf(req, res) {
    const l = String((res && res.locals && res.locals.lang) || (req && req.language) || 'fr');
    return l.startsWith('en') ? 'en' : 'fr';
}

function wantsJson(req) {
    try {
        return require('../utils/wantsJson').wantsJson(req);
    } catch (_) {
        return false;
    }
}

/** A target value in the reader's language; null when there is none. */
function fmtValue(value, unit, lang) {
    if (value === null || value === undefined) return null;
    if (unit === 'days') return fmtNum(value, 1, lang);
    return unit === 'count' ? fmtNum(value, 0, lang) : fmtPct(value, 1, lang);
}

/** A 'YYYY-MM-DD' day printed in the reader's language (noon: no zone shift). */
function fmtDay(day, lang) {
    if (!day) return null;
    const s = String(day).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? fmtDate(new Date(s + 'T12:00:00'), lang) : null;
}

/** The app's error page with a fixed message (403 or 404). */
function refuse(req, res, status) {
    const t = (k, d) => (req.t ? req.t(k) : d);
    return res.status(status).render('pages/error', {
        message:
            status === 404
                ? t('chrome:pt_not_found', 'Not found')
                : t('chrome:pt_forbidden', 'Forbidden'),
        title:
            status === 404
                ? t('chrome:pt_not_found', 'Not found')
                : t('chrome:pt_forbidden', 'Forbidden'),
    });
}

function todayKey() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const KpiTargetController = {
    async page(req, res, next) {
        try {
            if (!KpiTargetService.canView(req.user)) return refuse(req, res, 403);
            const lang = langOf(req, res);
            const ov = await KpiTargetService.overview(req.user);
            const siteName = new Map(ov.sites.map((s) => [s.id, s.name]));
            const rows = ov.rows.map((r) => ({
                kpiId: r.kpiId,
                scopeType: r.scopeType,
                scopeId: r.scopeId,
                name: r.name,
                display: r.target ? fmtValue(r.target.value, r.target.unit, lang) : null,
                effectiveFrom: r.target ? fmtDay(r.target.effectiveFrom, lang) : null,
                inherited: !!(r.target && r.target.inherited),
            }));
            const history = ov.history.map((h) => ({
                kpiId: h.kpiId,
                scopeType: h.scopeType,
                display: fmtValue(h.value, h.unit, lang),
                effectiveFromLabel: fmtDay(h.effectiveFrom, lang),
                createdAtLabel: fmtDate(h.createdAt, lang),
                scopeLabel:
                    h.scopeType === 'org' ? null : h.siteName || siteName.get(h.scopeId) || null,
                by: h.setByName || h.setByRef,
                reason: h.reason,
            }));
            const units = {};
            for (const k of ov.kpis) units[k] = KpiTargetService.TARGETABLE[k].unit;
            res.render('pages/kpi/targets', {
                title: req.t ? req.t('kpi:targets_title') : 'Indicator targets',
                kpis: ov.kpis,
                rows,
                history,
                canEdit: ov.canEdit,
                canEditOrg: ov.canEditOrg,
                editableSites: ov.sites.filter((s) => ov.editableSites.includes(s.id)),
                units,
                today: todayKey(),
            });
        } catch (err) {
            next(err);
        }
    },

    async save(req, res, next) {
        const json = wantsJson(req);
        try {
            const b = req.body || {};
            const raw = typeof b.scope === 'string' ? b.scope : '';
            const scopeType = raw === 'org' ? 'org' : raw.startsWith('site:') ? 'site' : null;
            const saved = await KpiTargetService.setTarget(
                {
                    kpiId: typeof b.kpiId === 'string' ? b.kpiId : '',
                    scopeType,
                    scopeId: scopeType === 'site' ? raw.slice(5) : null,
                    targetValue: typeof b.targetValue === 'string' ? b.targetValue : '',
                    effectiveFrom: typeof b.effectiveFrom === 'string' ? b.effectiveFrom : '',
                    reason: typeof b.reason === 'string' ? b.reason : '',
                },
                req.user,
                {
                    ipAddress: req.ip,
                    userAgent: req.get ? req.get('user-agent') : null,
                    requestId: req.id || null,
                }
            );
            if (json)
                return res.status(saved.unchanged ? 200 : 201).json({ ok: true, target: saved });
            if (req.flash) {
                const key = saved.unchanged
                    ? 'kpi:targets_unchanged'
                    : saved.value === null
                      ? 'kpi:targets_withdrawn'
                      : 'kpi:targets_saved';
                req.flash('success', req.t ? req.t(key) : 'OK');
            }
            return res.redirect(303, PAGE);
        } catch (err) {
            if (!(err instanceof KpiTargetService.TargetError)) return next(err);
            const status = err.status || 400;
            if (json) return res.status(status).json({ error: err.code });
            if (status === 404 || status === 403) return refuse(req, res, status);
            if (req.flash)
                req.flash('error', req.t ? req.t(`kpi:targets_err_${err.code}`) : err.code);
            return res.redirect(303, PAGE);
        }
    },
};

module.exports = KpiTargetController;
