'use strict';
/**
 * SuperAdmin-only in-app management of Single Sign-On providers.
 *   GET  /app-settings/sso        - the management page
 *   POST /app-settings/sso        - save settings, then live-reload the strategies
 *   POST /app-settings/sso/test   - lightweight validation of one provider's config
 *
 * Settings persist to app_settings (category 'sso'); saving re-registers the
 * passport strategies immediately (no service restart). Gated to SuperAdmins
 * because this controls how users authenticate.
 */
const SsoSettingsService = require('../services/SsoSettingsService');
const RBACService = require('../services/RBACService');
const LogService = require('../services/LogService');
const { passport } = require('../middleware/auth');
const sso = require('../config/sso');
const SamlMetadataService = require('../services/SamlMetadataService');
const SsoTest = require('../services/SsoTestService');
const { baseUrlAsync } = require('../utils/emailTemplate');

/** The trusted public base URL of this instance (never the raw Host header). */
async function publicBase(req) {
    return String(await baseUrlAsync(req)).replace(/\/+$/, '');
}

/** Fetch (url) or take (xml) the IdP metadata and parse it. */
async function loadMetadata(body) {
    const url = String((body && body.url) || '').trim();
    const xml = String((body && body.xml) || '');
    if (!url && !xml.trim()) return { ok: false, code: 'ssof_md_empty' };
    let text = xml;
    if (url) {
        const r = await SamlMetadataService.fetchMetadata(url);
        if (!r.ok) return r;
        text = r.xml;
    }
    const parsed = SamlMetadataService.parseIdpMetadata(text);
    return parsed.ok ? { ok: true, parsed, url: url || null } : parsed;
}

function mdError(req, res, r) {
    return res.status(400).json({
        ok: false,
        code: r.code,
        error: tr(req, r.code, 'The metadata could not be used.', { status: r.status || '' }),
    });
}

// every flash on this controller speaks the session language.
function tr(req, key, fallback, params) {
    return req.t
        ? req.t('admin:' + key, Object.assign({ defaultValue: fallback }, params || {}))
        : fallback;
}

function denyIfNotSuperAdmin(req, res) {
    if (!RBACService.isSuperAdmin || !RBACService.isSuperAdmin(req.user)) {
        if (!(req.user && req.user.role === 'superadmin')) {
            req.flash(
                'error',
                tr(req, 'sso_only_superadmin', 'Only SuperAdmins can manage Single Sign-On.')
            );
            res.redirect('/dashboard');
            return true;
        }
    }
    return false;
}

class SsoSettingsController {
    async index(req, res) {
        if (denyIfNotSuperAdmin(req, res)) return;
        try {
            const model = await SsoSettingsService.getFormModel();
            const base = await publicBase(req);
            res.render('pages/app-settings/sso', {
                title: req.t ? req.t('chrome:pt_single_sign_on') : 'Single Sign-On',
                sso: model,
                // The values an IdP admin pastes (SSO facilitator, phase 1).
                spValues: SamlMetadataService.spValues(base, {
                    issuer: model.saml.issuer,
                    callbackUrl: model.saml.callbackUrl,
                }),
                publicBase: base,
                // the breadcrumb printed the literal English "App Settings"
                // on the French UI.
                breadcrumbs: [
                    {
                        label: tr(req, 'sso_bc_configuration', 'Configuration'),
                        url: '/organization',
                    },
                    { label: tr(req, 'sso_bc_app_settings', 'App settings'), url: '/app-settings' },
                    { label: tr(req, 'sso_bc_sso', 'Single Sign-On') },
                ],
            });
        } catch (e) {
            console.error('SSO settings index error:', e);
            req.flash('error', tr(req, 'sso_load_error', 'Error loading SSO settings.'));
            res.redirect('/app-settings');
        }
    }

    async update(req, res) {
        if (denyIfNotSuperAdmin(req, res)) return;
        try {
            await SsoSettingsService.save(req.body, req.user.id);
            // Re-register strategies from the new config — takes effect immediately.
            const active = await sso.reloadSso(passport);

            await LogService.log({
                adminId: req.user.id,
                action: 'SSO_SETTINGS_UPDATED',
                entityType: 'appSetting',
                details: `SSO settings saved; active providers: ${active.length ? active.join(', ') : 'none'}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            req.flash(
                'success',
                active.length
                    ? tr(req, 'sso_saved_active', 'SSO settings saved.', {
                          providers: active.join(', '),
                      })
                    : tr(req, 'sso_saved_none', 'SSO settings saved. No provider is active yet.')
            );
            // ANN (3.23.21): a go-live set closer than the lead time announces
            // at once (the 5-minute tick would too). Never blocks the save.
            Promise.resolve()
                .then(() => require('../services/SsoInviteService').announce())
                .catch(() => {});
            res.redirect('/app-settings/sso');
        } catch (e) {
            if (e && e.code === 'sso_enable_confirm_required') {
                let n = 0;
                try {
                    const rd = await require('../services/AdminSsoService').readiness();
                    n = rd.noSsoAccessCount;
                } catch (_) {
                    n = '?';
                }
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:sso_enable_confirm_required', { n })
                        : 'SSO not switched on: confirm the readiness count first.'
                );
                return res.redirect('/app-settings/sso');
            }
            if (e && e.code === 'sso_golive_invalid') {
                req.flash(
                    'error',
                    req.t ? req.t('flash:sso_golive_invalid') : 'Invalid go-live date.'
                );
                return res.redirect('/app-settings/sso');
            }
            if (e && e.code === 'sso_mfa_acr_invalid') {
                // nothing was saved; say which value and why.
                req.flash(
                    'error',
                    tr(
                        req,
                        'sso_mfa_acr_invalid',
                        'Valeurs acr refusées (aucun réglage enregistré) : utilisez des URI ou des noms explicites, jamais un nombre seul comme « 1 ».',
                        { values: (e.bad || []).join(', ') }
                    )
                );
                return res.redirect('/app-settings/sso');
            }
            console.error('SSO settings update error:', e);
            req.flash('error', tr(req, 'sso_save_error', 'Error saving SSO settings.'));
            res.redirect('/app-settings/sso');
        }
    }

    /** Lightweight, side-effect-free validation of a provider's saved config. */
    async test(req, res) {
        if (denyIfNotSuperAdmin(req, res)) return;
        const provider = String(req.body.provider || '').toLowerCase();
        try {
            // UX-1: a saved connection is checked even while SSO is off.
            if (
                !sso.getProvider(provider) &&
                !(sso.getTestProvider && sso.getTestProvider(provider))
            ) {
                req.flash(
                    'error',
                    tr(req, 'sso_test_inactive', 'That provider is not active yet.', { provider })
                );
                return res.redirect('/app-settings/sso');
            }
            await LogService.log({
                adminId: req.user.id,
                action: 'SSO_TEST',
                entityType: 'appSetting',
                details: `SSO config check for ${provider}: registered`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            req.flash(
                'success',
                tr(req, 'sso_test_ok', 'The provider is configured and registered.', { provider })
            );
            res.redirect('/app-settings/sso');
        } catch (e) {
            console.error('SSO test error:', e);
            req.flash(
                'error',
                tr(req, 'sso_test_failed', 'SSO check failed.', { error: e.message })
            );
            res.redirect('/app-settings/sso');
        }
    }
}

/**
 * GET /saml/metadata — PUBLIC by design: an IdP (or its admin) downloads it.
 * It carries nothing secret: our entity ID, ACS URL and NameID format.
 */
SsoSettingsController.prototype.spMetadata = async function (req, res) {
    try {
        const saml = await SsoSettingsService.samlModel();
        const xml = SamlMetadataService.spMetadataXml(await publicBase(req), {
            issuer: saml.issuer,
            callbackUrl: saml.callbackUrl,
        });
        res.set('Content-Type', 'application/samlmetadata+xml; charset=utf-8');
        res.set('Content-Disposition', 'inline; filename="idevelop-sp-metadata.xml"');
        return res.send(xml);
    } catch (e) {
        console.error('SP metadata error:', e);
        return res.status(500).type('text/plain').send('Metadata unavailable');
    }
};

/** POST /app-settings/sso/saml/metadata/preview — what applying would change. */
SsoSettingsController.prototype.metadataPreview = async function (req, res) {
    if (denyIfNotSuperAdmin(req, res)) return;
    const r = await loadMetadata(req.body);
    if (!r.ok) return mdError(req, res, r);
    const current = await SsoSettingsService.effective('sso.saml.idpCert', 'SAML_IDP_CERT', true);
    const diff = SamlMetadataService.certDiff(current, r.parsed);
    const strip = (c) => ({ sha256: c.sha256, notAfter: c.notAfter, subject: c.subject });
    return res.json({
        ok: true,
        entityId: r.parsed.entityId,
        ssoUrl: r.parsed.ssoUrl,
        sloUrl: r.parsed.sloUrl,
        certs: r.parsed.certs.map(strip),
        added: diff.added.map(strip),
        removed: diff.removed.map(strip),
        needsConfirmation: diff.needsConfirmation,
    });
};

/**
 * POST /app-settings/sso/saml/metadata/apply — re-reads the metadata (never a
 * client-supplied parse) and applies it. A NEW signing certificate replacing
 * trusted ones needs `confirmCerts: true`: it is never trusted silently.
 */
SsoSettingsController.prototype.metadataApply = async function (req, res) {
    if (denyIfNotSuperAdmin(req, res)) return;
    const r = await loadMetadata(req.body);
    if (!r.ok) return mdError(req, res, r);
    const current = await SsoSettingsService.effective('sso.saml.idpCert', 'SAML_IDP_CERT', true);
    const diff = SamlMetadataService.certDiff(current, r.parsed);
    // The confirmation names the certificates the admin SAW (fingerprints from
    // the preview). If the metadata served now differs, nothing is applied.
    const confirmed = Array.isArray(req.body && req.body.confirmCerts)
        ? req.body.confirmCerts.map(String)
        : null;
    const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    if (
        diff.needsConfirmation &&
        !(
            confirmed &&
            sameSet(
                confirmed,
                diff.added.map((c) => c.sha256)
            )
        )
    ) {
        return res.status(409).json({
            ok: false,
            code: 'ssof_md_confirm_certs',
            error: tr(req, 'ssof_md_confirm_certs', 'Confirm the new signing certificate first.'),
        });
    }
    await SsoSettingsService.applyMetadata(
        { parsed: r.parsed, metadataUrl: r.url, base: await publicBase(req) },
        req.user.id
    );
    const active = await sso.reloadSso(passport);
    await LogService.log({
        adminId: req.user.id,
        action: 'SSO_SAML_METADATA_APPLIED',
        entityType: 'appSetting',
        details:
            `SAML IdP metadata applied: ${r.parsed.entityId}; certificates ${r.parsed.certs.map((c) => c.sha256).join(' | ')}` +
            (diff.added.length ? `; added ${diff.added.length}` : '') +
            (diff.removed.length ? `; removed ${diff.removed.length}` : '') +
            `; active providers: ${active.join(', ') || 'none'}`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
    });
    return res.json({ ok: true, active, samlActive: active.includes('saml') });
};

/** GET /app-settings/sso/test-signin/:provider — start a no-session round trip. */
SsoSettingsController.prototype.testSignin = async function (req, res) {
    if (denyIfNotSuperAdmin(req, res)) return;
    const provider = String(req.params.provider || '').toLowerCase();
    // UX-1 (3.23.21): works on a SAVED connection while the master switch is
    // still off — the test signs nobody in (config/sso.js test-only mode).
    if (provider !== 'saml' || !sso.getTestProvider('saml')) {
        req.flash(
            'error',
            tr(req, 'ssof_test_unavailable', 'A test sign-in needs an active SAML connection.')
        );
        return res.redirect('/app-settings/sso');
    }
    const t = SsoTest.issue(req.user.id, provider);
    await LogService.log({
        adminId: req.user.id,
        action: 'SSO_TEST_STARTED',
        entityType: 'appSetting',
        details: `Test sign-in started for ${provider}`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
    });
    return res.redirect(`/auth/sso/${provider}?RelayState=${encodeURIComponent(t.relayState)}`);
};

/** GET /app-settings/sso/test-result/:nonce — the diagnostic, for its admin only. */
SsoSettingsController.prototype.testResult = async function (req, res) {
    if (denyIfNotSuperAdmin(req, res)) return;
    const result = SsoTest.readResult(req.params.nonce, req.user.id);
    if (!result) {
        req.flash(
            'error',
            tr(req, 'ssof_test_expired', 'This test sign-in has expired. Start it again.')
        );
        return res.redirect('/app-settings/sso');
    }
    return res.render('pages/app-settings/sso-test-result', {
        title: tr(req, 'ssof_test_title', 'Test sign-in result'),
        result,
        breadcrumbs: [
            { label: tr(req, 'sso_bc_app_settings', 'App settings'), url: '/app-settings' },
            { label: tr(req, 'sso_bc_sso', 'Single Sign-On'), url: '/app-settings/sso' },
            { label: tr(req, 'ssof_test_title', 'Test sign-in result') },
        ],
    });
};

/**
 * POST /employees/:id/sso-exception — EXC (3.23.21, PO decision). SuperAdmin
 * only (the route guards it; AdminSsoService re-checks the DB role, fail
 * closed). body.action = 'grant' (reason required) | 'remove'. Audited.
 */
SsoSettingsController.prototype.setEmployeeException = async function (req, res) {
    const id = Number(req.params.id);
    const back = `/employees/${Number.isInteger(id) ? id : ''}`;
    if (denyIfNotSuperAdmin(req, res)) return;
    try {
        const on = String((req.body && req.body.action) || '') === 'grant';
        const r = await require('../services/AdminSsoService').setSsoException(
            id,
            { on, reason: req.body && req.body.reason },
            req.user
        );
        const key = `flash:sso_exc_${r.code}`;
        req.flash(r.ok ? 'success' : 'error', req.t ? req.t(key) : r.code);
    } catch (e) {
        console.error('SSO exception error:', e);
        req.flash('error', tr(req, 'sso_save_error', 'Error saving SSO settings.'));
    }
    return res.redirect(back);
};

module.exports = new SsoSettingsController();
