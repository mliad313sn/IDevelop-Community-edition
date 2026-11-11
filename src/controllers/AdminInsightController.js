'use strict';

/**
 * AdminInsightController — two read-only administration pages (4.0.0 port,
 * wave 10). No SQL here; nothing is written.
 *
 *   GET /admin/data-quality  « Data quality »: the counts that keep the
 *                            indicators from being measured, by section, each
 *                            section behind its module's permission
 *                            (DataQualityService). Route gate: SuperAdmin or
 *                            ANY of DataQualityService.PANEL_SLUGS.
 *   GET /admin/usage         « Usage by site »: account activation and
 *                            self-assessment activity per site of the reader's
 *                            cleared population (UsageService). Route gate: an
 *                            administrator holding view_employees.
 *
 * Counts only, never a name; the population is the reader's clearance.
 */

const t = (req, key, fallback) => (typeof req.t === 'function' ? req.t(key) : fallback);

const AdminInsightController = {
    async dataQuality(req, res) {
        const model = await require('../services/DataQualityService').panel(req.user);
        res.render('pages/admin/data-quality', {
            title: t(req, 'admin:dq_title', 'Data quality'),
            dq: model,
        });
    },

    async usage(req, res) {
        const model = await require('../services/UsageService').bySite(req.user);
        res.render('pages/admin/usage', {
            title: t(req, 'admin:us_title', 'Usage by site'),
            usage: model,
        });
    },
};

module.exports = AdminInsightController;
