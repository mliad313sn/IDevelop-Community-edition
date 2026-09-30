'use strict';

const ModuleService = require('../services/ModuleService');
const LogService = require('../services/LogService');
const M = require('../config/modules');

/**
 * Administration → Modules (/admin/modules, SuperAdmin only): choose the
 * adoption stage (1, 2, 3) or switch each optional module by hand (custom).
 * A change applies on the next request — no restart — and is audit-logged.
 */
class ModulesController {
    async page(req, res) {
        const state = await ModuleService.resolve();
        res.render('pages/admin/modules', {
            title: req.t ? req.t('admin:mod_page_title') : 'Modules',
            state,
            presets: M.PRESETS,
            stagedModules: M.STAGED_MODULES,
            moduleMenus: M.MODULE_MENUS,
        });
    }

    async save(req, res) {
        const body = req.body || {};
        const stage = ModuleService.normStage(body.stage);
        if (!stage) {
            req.flash('error', req.t ? req.t('admin:mod_err_stage') : 'Choose a stage.');
            return res.redirect('/admin/modules');
        }
        const toggles = {};
        for (const k of M.STAGED_MODULES) toggles[k] = body['mod_' + k];
        const { before, after } = await ModuleService.save({
            stage,
            toggles,
            // an unticked checkbox is absent from the body: absent means OFF
            localContent: body.mod_localContent || 'false',
            actorId: req.user && req.user.id,
        });

        const on = M.MODULE_KEYS.filter((k) => after.configured[k] && !before.configured[k]);
        const off = M.MODULE_KEYS.filter((k) => !after.configured[k] && before.configured[k]);
        await LogService.log({
            adminId: req.user && req.user.id,
            action: 'MODULES_UPDATED',
            entityType: 'appSetting',
            details:
                `Adoption stage ${before.stored ? before.stage : '(unset)'} → ${after.stage}; ` +
                `switched on: ${on.join(', ') || '—'}; switched off: ${off.join(', ') || '—'}` +
                (after.legacy ? ' (V2_FEATURES=1 keeps every module on)' : ''),
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });

        req.flash('success', req.t ? req.t('admin:mod_saved') : 'Modules saved.');
        return res.redirect('/admin/modules');
    }
}

module.exports = new ModulesController();
