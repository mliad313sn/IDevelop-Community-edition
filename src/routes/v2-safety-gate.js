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
 *               /safety-gate/me         the person's own status,
 *                                       waivers and contests
 *               POST /waivers, /waivers/:id/renew|revoke, /contests,
 *               /contests/:id/decide    human intervention (SafetyWaiverService
 *                                       decides who may act).
 */

const express = require('express');
const SafetyGateService = require('../services/SafetyGateService');
const SafetyWaiverService = require('../services/SafetyWaiverService');
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
        const counts = { CLEARED: 0, EXPIRING: 0, BLOCKED: 0, NOT_CONFIGURED: 0, WAIVED: 0 };
        rows.forEach((r) => {
            counts[r.status] = (counts[r.status] || 0) + 1;
        });
        // Who may act on each listed person (their line, or HSE within
        // clearance; never the person), and the running waivers and open
        // contests the actor can see.
        const blockedRows = rows.filter((r) => r.status === 'BLOCKED');
        const [authority, waivers, contests] = await Promise.all([
            SafetyWaiverService.authorityMany(
                req.user,
                blockedRows.map((r) => r.employeeId)
            ),
            SafetyWaiverService.listRunningWaivers(req.user),
            SafetyWaiverService.listContests(req.user, { openOnly: true }),
        ]);
        const waiverAuthority = await SafetyWaiverService.authorityMany(
            req.user,
            waivers.map((w) => w.employeeId)
        );
        const canDecide = require('../services/RBACService').hasPermission(
            req.user,
            'manage_compliance'
        );
        // a person blocked ONLY by observe-mode rules is listed (the status
        // is computed and shown) but flagged: access control is not closed.
        const blocked = blockedRows.map((r) => {
            const auth = authority.get(Number(r.employeeId)) || null;
            const enforcedBlocked = SafetyGateService.effectiveStatus(r) === 'BLOCKED';
            return {
                ...r,
                observeOnly: SafetyGateService.isCleared(r),
                authority: auth,
                canContest: auth === 'line' && enforcedBlocked,
                waivable: enforcedBlocked
                    ? r.reasons.filter(
                          (x) =>
                              x.blocking &&
                              !x.observe &&
                              !x.waived &&
                              x.skillId != null &&
                              !x.legallyMandatory
                      )
                    : [],
                legalOnly: r.reasons.some((x) => x.blocking && !x.observe && x.legallyMandatory),
            };
        });
        const waived = rows.filter((r) => SafetyGateService.isWaived(r));
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
            waived,
            waivers: waivers.map((w) => ({
                ...w,
                authority: waiverAuthority.get(Number(w.employeeId)) || null,
            })),
            contests: contests.map((c) => ({ ...c, canDecide })),
            hoursMax: SafetyWaiverService.HOURS_MAX,
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
        // Waivers and contests
        'bad_hours',
        'not_waivable',
        'not_blocking',
        'legally_mandatory',
        'waiver_exists',
        'renewal_exhausted',
        'waiver_not_running',
        'not_blocked',
        'contest_exists',
        'contest_closed',
        'self_decision',
        'bad_decision',
        'bad_remedy',
        'pointer_required',
        'waiver_cooldown',
        'waiver_cap',
    ];
    // A waiver / contest / decision refusal names ITS subject (« le motif
    // de la dérogation… »), not the rule-deactivation / settings wording.
    const SUBJECTS = ['waiver', 'waiver_end', 'contest', 'decision'];
    const subject = e && SUBJECTS.includes(e.subject) ? e.subject : null;
    if (code && e.subject === 'mode' && ['reason_required', 'legally_mandatory'].includes(code)) {
        // Loosening a rule to OBSERVE names THAT refusal.
        req.flash('error', t(req, `safety:err_mode_${code}`, code));
    } else if (
        code &&
        known.includes(code) &&
        subject &&
        ['reason_required', 'forbidden'].includes(code)
    ) {
        req.flash('error', t(req, `safety:err_${code}_${subject}`, code));
    } else if (code && known.includes(code)) {
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
        legallyMandatory: checked(b.legallyMandatory),
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
        const b = req.body || {};
        await SafetyGateService.setRuleMode(req.params.id, b.mode, req.user, b.reason);
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

// Legally mandatory certification: no waiver ever lifts the rule.
// Setting it: whoever may manage the rule; lifting it: SuperAdmin + reason
// (both enforced in the service).
pageRouter.post('/config/rules/:id/legal', canManage, async (req, res) => {
    const b = req.body || {};
    try {
        await SafetyGateService.setRuleLegal(
            req.params.id,
            checked(b.legallyMandatory),
            b.reason,
            req.user
        );
        req.flash('success', t(req, 'safety:rule_legal_changed', 'Rule updated.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect('/safety-gate/config');
});

// ---------------------------------------------------------------------------
// Human path: waivers and contests. Authority is decided by the
// service (line = direct supervisor / manager; HSE = manage_compliance within
// clearance; never the person themselves), so each route only needs a session.
// ---------------------------------------------------------------------------

const back = (req) => ((req.body || {}).back === 'me' ? '/safety-gate/me' : '/safety-gate');

pageRouter.post('/waivers', async (req, res) => {
    const b = req.body || {};
    try {
        await SafetyWaiverService.grantWaiver(
            { employeeId: b.employeeId, skillId: b.skillId, hours: b.hours, reason: b.reason },
            req.user
        );
        req.flash('success', t(req, 'safety:waiver_granted', 'Waiver granted.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect(back(req));
});

pageRouter.post('/waivers/:id/renew', async (req, res) => {
    const b = req.body || {};
    try {
        await SafetyWaiverService.renewWaiver(
            req.params.id,
            { hours: b.hours, reason: b.reason },
            req.user
        );
        req.flash('success', t(req, 'safety:waiver_renewed', 'Waiver renewed.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect(back(req));
});

pageRouter.post('/waivers/:id/revoke', async (req, res) => {
    try {
        await SafetyWaiverService.revokeWaiver(req.params.id, (req.body || {}).reason, req.user);
        req.flash('success', t(req, 'safety:waiver_revoked', 'Waiver ended.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect(back(req));
});

pageRouter.post('/contests', async (req, res) => {
    const b = req.body || {};
    try {
        await SafetyWaiverService.submitContest(
            { employeeId: b.employeeId, reason: b.reason },
            req.user
        );
        req.flash('success', t(req, 'safety:contest_submitted', 'Contest submitted.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect(back(req));
});

pageRouter.post('/contests/:id/decide', canManage, async (req, res) => {
    const b = req.body || {};
    try {
        await SafetyWaiverService.decideContest(
            req.params.id,
            {
                decision: b.decision,
                reason: b.reason,
                remedy: b.remedy,
                skillId: b.skillId,
                hours: b.hours,
                correctionPointer: b.correctionPointer,
            },
            req.user
        );
        req.flash('success', t(req, 'safety:contest_decided', 'Decision recorded.'));
    } catch (e) {
        flashError(req, e);
    }
    return res.redirect('/safety-gate');
});

/**
 * The person's own page: their status (WAIVED is said as such, with its end),
 * the reasons, their waivers and contests, and the contest form when the
 * ENFORCED answer is BLOCKED. An employee / manager session only.
 */
pageRouter.get('/me', async (req, res) => {
    const u = req.user;
    if (!u || (u.userType !== 'employee' && u.userType !== 'manager'))
        return res.redirect('/safety-gate');
    try {
        const [rows, mine] = await Promise.all([
            SafetyGateService.computeFor({ employeeIds: [Number(u.id)] }, null, {
                source: 'ui',
            }),
            SafetyWaiverService.forEmployee(u.id),
        ]);
        const me = rows[0] || null;
        const enforced = me ? SafetyGateService.effectiveStatus(me) : null;
        return res.render('pages/safety-gate/me', {
            title: t(req, 'safety:me_title', 'My safety clearance'),
            me,
            enforced,
            waived: me ? SafetyGateService.isWaived(me) : false,
            waivers: mine.waivers,
            contests: mine.contests,
            canContest: enforced === 'BLOCKED' && !mine.contests.some((c) => c.state === 'open'),
            // A manager acts for their team from the main page.
            teamLink: u.userType === 'manager',
        });
    } catch (e) {
        console.error('[safety-gate] my page failed:', e && e.message);
        req.flash('error', t(req, 'flash:generic_error', 'Something went wrong.'));
        return res.redirect('/dashboard');
    }
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
