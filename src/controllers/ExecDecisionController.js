'use strict';

/**
 * ExecDecisionController — the three executive decision surfaces:
 *
 *   /exec/key-person     single points of failure BY NAME (skill x org-unit)
 *   /exec/site-exposure  the sites side by side on readiness / continuity / certs
 *   /exec/board-pack     one print-ready brief a director takes into the room
 *
 * RBAC
 *   The router already enforces manager-or-admin + rbacMiddleware. Naming the
 *   sole holder of a capability is continuity-grade data, so the key-person
 *   surface carries an EXTRA gate: a manager always qualifies (they see only
 *   their own reports anyway), a local admin needs one of the continuity grants.
 *   The board pack computes the same predicate and omits the key-person section
 *   entirely for a caller who does not hold it — the section is not rendered
 *   blank, it is not rendered at all.
 *
 *   Every underlying service scopes by scopedEmployeeIds BEFORE aggregating, so
 *   no figure on these pages can be influenced by a person outside the caller's
 *   clearance.
 */

const KeyPersonRiskService = require('../services/KeyPersonRiskService');
const SiteExposureService = require('../services/SiteExposureService');
const KpiSnapshotService = require('../services/KpiSnapshotService');
const db = require('../config/database');

/** Continuity-grade read: manager, superadmin, or a continuity grant holder. */
function canSeeKeyPerson(user) {
    if (!user) return false;
    if (user.userType === 'manager') return true;
    if (user.userType !== 'admin') return false;
    if (user.role === 'superadmin') return true;
    const grants = Array.isArray(user.permissions) ? user.permissions : [];
    return ['view_continuity', 'manage_succession', 'view_retention_risk', 'manage_handover'].some(
        (s) => grants.includes(s)
    );
}

const ExecDecisionController = {
    canSeeKeyPerson,

    // ---- Key-person risk ---------------------------------------------------

    async keyPersonPage(req, res, next) {
        try {
            const opts = ExecDecisionController._sweepOpts(req);
            const [data, units] = await Promise.all([
                KeyPersonRiskService.sweep(req.user, opts),
                ExecDecisionController._unitOptions(req.user, opts.unit),
            ]);
            res.render('pages/exec/key-person', {
                title: req.t ? req.t('exec:kp_title') : 'Key-person risk',
                rows: data.rows,
                summary: data.summary,
                scope: data.scope,
                units,
                filters: opts,
                currentPath: '/exec/key-person',
            });
        } catch (err) {
            next(err);
        }
    },

    async keyPersonApi(req, res, next) {
        try {
            const data = await KeyPersonRiskService.sweep(
                req.user,
                ExecDecisionController._sweepOpts(req)
            );
            res.json({ ok: true, ...data });
        } catch (err) {
            next(err);
        }
    },

    // ---- Per-site exposure scorecard ---------------------------------------

    async siteExposurePage(req, res, next) {
        try {
            const { rows, scope } = await SiteExposureService.bySite(req.user);
            res.render('pages/exec/site-exposure', {
                title: req.t ? req.t('exec:se_title') : 'Exposure by site',
                rows,
                totals: SiteExposureService.totals(rows),
                scope,
                showKeyPerson: canSeeKeyPerson(req.user),
                currentPath: '/exec/site-exposure',
            });
        } catch (err) {
            next(err);
        }
    },

    async siteExposureApi(req, res, next) {
        try {
            const { rows, scope } = await SiteExposureService.bySite(req.user);
            res.json({ ok: true, rows, totals: SiteExposureService.totals(rows), scope });
        } catch (err) {
            next(err);
        }
    },

    // The board pack is DashboardHomeController.boardPack (counts only, the
    // dashboard's own figures and scope).

    // ---- internals ---------------------------------------------------------

    _sweepOpts(req) {
        const q = req.query || {};
        return {
            unit: KeyPersonRiskService.resolveUnitKey(q.unit),
            band:
                KeyPersonRiskService.BANDS.includes(q.band) || q.band === 'all'
                    ? q.band
                    : 'sole_holder',
            criticalOnly: q.criticalOnly === '1' || q.criticalOnly === 'true',
            unitId: Number(q.unitId) > 0 ? Number(q.unitId) : null,
            limit: Math.max(1, Math.min(500, Number(q.limit) || 200)),
        };
    },

    /**
     * Org-unit dropdown options, drawn from the caller's own scope so the filter
     * can never offer a unit whose rows the caller may not see.
     */
    async _unitOptions(user, unitKey) {
        const { scopedEmployeeIds, scopeClause } = require('../utils/rbacScope');
        const unit = KeyPersonRiskService.UNITS[KeyPersonRiskService.resolveUnitKey(unitKey)];
        const ids = await scopedEmployeeIds(user);
        if (Array.isArray(ids) && ids.length === 0) return [];
        const params = [];
        const scope = scopeClause(ids, params, 'ed.employee_id');
        return db.all(
            `SELECT DISTINCT ed.${unit.id} AS "id", ed.${unit.name} AS "name"
               FROM v_employee_details ed
              WHERE ed.is_active AND ed.${unit.id} IS NOT NULL ${scope}
              ORDER BY 2`,
            params
        );
    },
};

module.exports = ExecDecisionController;
module.exports.KpiSnapshotService = KpiSnapshotService;
