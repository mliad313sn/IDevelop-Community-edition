'use strict';

/**
 * Safety-competency gate (« Habilitations sécurité ») — migration 150.
 *
 * Two routers:
 *
 *   apiRouter   GET /v2/safety-gate/status/:employeeNumber
 *               GET /v2/safety-gate/status?site=…&role=…&status=…
 *               Read API for permit-to-work / access-control systems. Mounted
 *               BEFORE requireAuth (like SCIM): an API key with a safety read
 *               scope (`safety.read`), or a manager / compliance session. The
 *               key runs as its owning profile, so the answer is clearance-
 *               scoped. Returns status + reason codes + expiry dates only —
 *               never an assessment score.
 *
 *   pageRouter  /safety-gate            blocked / expiring people per site & role
 *               /safety-gate/config     critical skills per role (+ site), warning
 *                                       window and outgoing webhook
 *               Mounted AFTER requireAuth. Writes need manage_compliance AND
 *               (3.23.21 SEC-1, enforced in the service) SuperAdmin for the
 *               settings / site-less rules, site clearance for a site rule.
 */

const express = require('express');
const SafetyGateService = require('../services/SafetyGateService');
const { requireApiKey, apiKeyScopeOf } = require('../middleware/apiAuth');
const { requireManagerOrAnyPermission, requirePermission } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function sessionCanRead(user) {
    if (!user) return false;
    if (user.userType === 'manager') return true;
    if (user.userType !== 'admin') return false;
    if (user.role === 'superadmin') return true;
    const grants = Array.isArray(user.permissions) ? user.permissions : [];
    return grants.includes('view_compliance') || grants.includes('manage_compliance');
}

/**
 * Session (manager / compliance admin) OR an API key whose scope grants the
 * safety read. Any other key — including read-only keys of other feeds
 * ('powerbi.read') and the legacy shared key — is refused: fail closed.
 */
function safetyApiAuth(req, res, next) {
    const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated() && req.user;
    if (authed && !req.user._apiKey) {
        if (sessionCanRead(req.user)) return next();
        return res.status(403).json({ error: 'forbidden' });
    }
    return requireApiKey(req, res, () => {
        if (!SafetyGateService.scopeAllowsSafetyRead(apiKeyScopeOf(req))) {
            return res.status(403).json({
                error: 'insufficient_scope',
                hint: 'this API key does not carry the safety.read scope',
            });
        }
        return next();
    });
}

const apiRouter = express.Router();

apiRouter.get('/v2/safety-gate/status', safetyApiAuth, async (req, res) => {
    try {
        const rows = await SafetyGateService.statusBulk(
            req.user,
            {
                site: req.query.site,
                roleId: req.query.role,
                status: req.query.status,
            },
            { source: 'api' }
        );
        const data = rows.map(SafetyGateService.toApi);
        res.set('Cache-Control', 'no-store');
        return res.json({ data, count: data.length, evaluatedAt: new Date().toISOString() });
    } catch (e) {
        console.error('[safety-gate] bulk status failed:', e && e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
});

apiRouter.get('/v2/safety-gate/status/:employeeNumber', safetyApiAuth, async (req, res) => {
    try {
        const num = String(req.params.employeeNumber || '').trim();
        if (!num || num.length > 64) return res.status(400).json({ error: 'bad_employee_number' });
        const row = await SafetyGateService.statusByEmployeeNumber(req.user, num, {
            source: 'api',
        });
        // Out of scope and unknown answer the same: never confirm existence.
        if (!row) return res.status(404).json({ error: 'not_found' });
        res.set('Cache-Control', 'no-store');
        return res.json({ data: SafetyGateService.toApi(row) });
    } catch (e) {
        console.error('[safety-gate] status failed:', e && e.message);
        return res.status(500).json({ error: 'internal_error' });
    }
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const pageRouter = express.Router();
const canView = requireManagerOrAnyPermission('view_compliance', 'manage_compliance');
const canManage = requirePermission('manage_compliance');

const t = (req, key, fallback) => (req.t ? req.t(key) : fallback);

pageRouter.get('/', canView, async (req, res) => {
    try {
        const filters = {
            site: req.query.site ? String(req.query.site) : '',
            role: req.query.role ? String(req.query.role) : '',
        };
        const [rows, options, settings] = await Promise.all([
            SafetyGateService.statusBulk(
                req.user,
                { site: filters.site, roleId: filters.role },
                { source: 'ui' }
            ),
            SafetyGateService.formOptions(),
            SafetyGateService.getSettings(),
        ]);
        const counts = { CLEARED: 0, EXPIRING: 0, BLOCKED: 0, NOT_CONFIGURED: 0 };
        rows.forEach((r) => {
            counts[r.status] = (counts[r.status] || 0) + 1;
        });
        // a person blocked ONLY by observe-mode rules is listed (the status
        // is computed and shown) but flagged: access control is not closed.
        const blocked = rows
            .filter((r) => r.status === 'BLOCKED')
            .map((r) => ({ ...r, observeOnly: SafetyGateService.isCleared(r) }));
        // UX-6: nothing measured anywhere and only unconfigured roles → say
        // "no critical skill is configured", not "nobody is blocked".
        const rulesNone =
            counts.BLOCKED + counts.CLEARED + counts.EXPIRING === 0 && counts.NOT_CONFIGURED > 0;
        const expiring = rows
            .filter((r) => r.status === 'EXPIRING')
            .sort((a, b) => String(a.nextExpiry || '').localeCompare(String(b.nextExpiry || '')));
        const canConfigure = require('../services/RBACService').hasPermission(
            req.user,
            'manage_compliance'
        );
        return res.render('pages/safety-gate/index', {
            title: t(req, 'safety:title', 'Safety clearances'),
            counts,
            blocked,
            expiring,
            rulesNone,
            options,
            filters,
            settings,
            canConfigure,
        });
    } catch (e) {
        console.error('[safety-gate] page failed:', e && e.message);
        req.flash('error', t(req, 'flash:generic_error', 'Something went wrong.'));
        return res.redirect('/dashboard');
    }
});

/**
 * The configuration page. SEC-1: what the actor may change is decided by the
 * service (settings + site-less rules = SuperAdmin; a site rule = clearance on
 * that site); the page only mirrors it so nobody is offered a button that
 * will be refused. `preview` / `draft` come from the impact preview.
 */
async function renderConfig(req, res, extra = {}) {
    const RBACService = require('../services/RBACService');
    const isSuper = RBACService.isSuperAdmin(req.user);
    const [rules, options, settings, deliveries] = await Promise.all([
        SafetyGateService.listRules({ includeInactive: req.query.all === '1' }),
        SafetyGateService.formOptions(),
        SafetyGateService.getSettings(),
        SafetyGateService.recentDeliveries(15, req.user),
    ]);
    const siteIds = await SafetyGateService.manageableSiteIds(req.user, options.sites);
    const mayManage = (siteId) =>
        isSuper || (siteId != null && Array.isArray(siteIds) && siteIds.includes(Number(siteId)));
    return res.render('pages/safety-gate/config', {
        title: t(req, 'safety:config_title', 'Safety clearances — configuration'),
        rules: rules.map((r) => ({ ...r, canManage: mayManage(r.siteId) })),
        options: {
            roles: options.roles,
            sites: isSuper
                ? options.sites
                : options.sites.filter((s) => siteIds.includes(Number(s.id))),
        },
        settings,
        deliveries,
        isSuper,
        showAll: req.query.all === '1',
        preview: null,
        draft: null,
        ...extra,
    });
}

pageRouter.get('/config', canManage, async (req, res) => {
    try {
        return await renderConfig(req, res);
    } catch (e) {
        console.error('[safety-gate] config page failed:', e && e.message);
        req.flash('error', t(req, 'flash:generic_error', 'Something went wrong.'));
        return res.redirect('/safety-gate');
    }
});

function flashError(req, e) {
    const code = e && e.code ? String(e.code) : null;
    const known = [
        'bad_days',
        'secret_required',
        'https_only',
        'private_address',
        'bad_url',
        'dns',
        'bad_rule',
        'bad_level',
        'bad_mode',
        'bad_max_age',
        'duplicate_rule',
        'reason_required',
        'not_found',
        'forbidden',
    ];
    if (code && known.includes(code)) {
        req.flash('error', t(req, `safety:err_${code}`, code));
    } else {
        console.error('[safety-gate] write failed:', e && e.message);
        req.flash('error', t(req, 'flash:generic_error', 'Something went wrong.'));
    }
}

const checked = (v) => v === '1' || v === 'on' || v === true;

function ruleFromBody(b) {
    return {
        roleId: b.roleId,
        siteId: b.siteId,
        skillId: b.skillId,
        minLevel: b.minLevel,
        certRequired: checked(b.certRequired),
        mode: b.mode,
        requireValidated: checked(b.requireValidated),
        maxAgeMonths: b.maxAgeMonths,
    };
}

// impact preview: the form posts here first; the page comes back with the
// count of people the rule would newly BLOCK and a confirmation form.
pageRouter.post('/config/rules/preview', canManage, async (req, res) => {
    const b = req.body || {};
    try {
        const preview = await SafetyGateService.previewRule(ruleFromBody(b), req.user);
        return await renderConfig(req, res, {
            preview,
            draft: { ...preview.rule, skillLabel: String(b.skillLabel || '').slice(0, 200) },
        });
    } catch (e) {
        flashError(req, e);
        return res.redirect('/safety-gate/config');
    }
});

pageRouter.post('/config/rules', canManage, async (req, res) => {
    try {
        await SafetyGateService.addRule(ruleFromBody(req.body || {}), req.user);
        req.flash('success', t(req, 'safety:rule_added', 'Rule added.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect('/safety-gate/config');
});

pageRouter.post('/config/rules/:id/mode', canManage, async (req, res) => {
    try {
        await SafetyGateService.setRuleMode(req.params.id, (req.body || {}).mode, req.user);
        req.flash('success', t(req, 'safety:rule_mode_changed', 'Rule mode changed.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect('/safety-gate/config');
});

pageRouter.post('/config/rules/:id/deactivate', canManage, async (req, res) => {
    try {
        await SafetyGateService.deactivateRule(req.params.id, (req.body || {}).reason, req.user);
        req.flash('success', t(req, 'safety:rule_deactivated', 'Rule deactivated.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect('/safety-gate/config');
});

pageRouter.post('/config/settings', canManage, async (req, res) => {
    try {
        const b = req.body || {};
        await SafetyGateService.updateSettings(
            {
                expiryWarningDays: b.expiryWarningDays,
                webhookUrl: b.webhookUrl,
                webhookSecret: b.webhookSecret,
                webhookEnabled: b.webhookEnabled === '1' || b.webhookEnabled === 'on',
            },
            req.user
        );
        req.flash('success', t(req, 'safety:settings_saved', 'Settings saved.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect('/safety-gate/config');
});

module.exports = { apiRouter, pageRouter, safetyApiAuth, sessionCanRead };
