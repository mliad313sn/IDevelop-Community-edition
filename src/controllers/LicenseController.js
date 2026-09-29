'use strict';

const EntitlementService = require('../services/EntitlementService');
const AppSettingsModel = require('../models/AppSettingsModel');
const LogService = require('../services/LogService');

/** The keys EntitlementService reads; anything else is ignored and SAID so. */
const KNOWN_KEYS = ['customer', 'issuedTo', 'seats', 'features', 'expiresOn', 'expires'];

/**
 * Structural validation of a pasted licence. A typo — `seat`
 * for `seats`, a non-ISO `expiresOn` — used to be saved and silently mean
 * "unlimited seats / never expires". Returns { ok, errors: [code…], ignored: [key…] }
 * where each code is an `admin:ops_lic_err_<code>` locale key.
 */
function validateLicense(raw) {
    const out = { ok: true, errors: [], ignored: [] };
    if (!raw) return out;
    let l;
    try {
        l = JSON.parse(raw);
    } catch {
        return { ok: false, errors: ['json'], ignored: [] };
    }
    if (!l || typeof l !== 'object' || Array.isArray(l))
        return { ok: false, errors: ['object'], ignored: [] };
    out.ignored = Object.keys(l).filter((k) => !KNOWN_KEYS.includes(k));
    if (
        l.seats != null &&
        l.seats !== '' &&
        !(Number.isInteger(Number(l.seats)) && Number(l.seats) >= 0)
    )
        out.errors.push('seats');
    const exp = l.expiresOn != null ? l.expiresOn : l.expires;
    if (
        exp != null &&
        exp !== '' &&
        !(/^\d{4}-\d{2}-\d{2}/.test(String(exp)) && !Number.isNaN(new Date(exp).getTime()))
    )
        out.errors.push('expires');
    if (
        l.features != null &&
        !(Array.isArray(l.features) && l.features.every((f) => typeof f === 'string'))
    )
        out.errors.push('features');
    if (l.customer != null && typeof l.customer !== 'string') out.errors.push('customer');
    if (l.issuedTo != null && typeof l.issuedTo !== 'string') out.errors.push('customer');
    out.ok = out.errors.length === 0;
    return out;
}

class LicenseController {
    async page(req, res) {
        const status = await EntitlementService.status(true);
        const raw = await AppSettingsModel.getValue('license', '');
        const enforce = await AppSettingsModel.getValue('enforceSeatLimit', false);
        res.render('pages/admin/license', {
            title: req.t ? req.t('chrome:pt_license_entitlement') : 'License & Entitlement',
            status,
            rawLicense: typeof raw === 'string' ? raw : JSON.stringify(raw || '', null, 2),
            enforceSeatLimit:
                enforce === true || enforce === 'true' || enforce === 1 || enforce === '1',
        });
    }

    async save(req, res) {
        const raw = (req.body.license || '').toString().trim();
        const t = (k, p) => (req.t ? req.t(k, p) : k);
        // Validate before storing so a bad paste can't wedge the appliance —
        // structurally, not just as JSON.
        const v = validateLicense(raw);
        if (!v.ok) {
            req.flash &&
                req.flash(
                    'error',
                    t('admin:ops_lic_refused', {
                        reasons: v.errors.map((c) => t(`admin:ops_lic_err_${c}`)).join(' '),
                    })
                );
            return res.redirect('/admin/license');
        }
        await AppSettingsModel.setValue(
            'license',
            raw,
            'string',
            'Appliance license (JSON)',
            'licensing',
            req.user && req.user.id
        );
        const enforce =
            req.body.enforceSeatLimit === 'on' ||
            req.body.enforceSeatLimit === 'true' ||
            req.body.enforceSeatLimit === true;
        await AppSettingsModel.setValue(
            'enforceSeatLimit',
            enforce ? 'true' : 'false',
            'boolean',
            'Hard-block new employees over the seat cap',
            'licensing',
            req.user && req.user.id
        );
        EntitlementService.invalidate();
        try {
            await LogService.log({
                adminId: req.user && req.user.id ? req.user.id : null,
                action: 'LICENSE_UPDATED',
                entityType: 'app_setting',
                entityId: null,
                category: 'audit',
                details: {
                    hasLicense: Boolean(raw),
                    enforceSeatLimit: enforce,
                    ignoredKeys: v.ignored,
                },
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
                requestId: req.id || null,
            });
        } catch {
            /* audit best-effort */
        }
        if (v.ignored.length) {
            // Saved, but the operator must know which keys did nothing.
            req.flash &&
                req.flash(
                    'warning',
                    t('admin:ops_lic_ignored_keys', { keys: v.ignored.join(', ') })
                );
        }
        const status = await EntitlementService.status(true);
        if (status && status.warn) {
            // Same alert the watchdog raises daily — the SuperAdmins' bell says it now.
            try {
                await require('../services/JobRunService').alert(
                    'ops.license',
                    `license:${status.expired ? 'expired' : 'overseat'}`,
                    { expired: status.expired, overSeat: status.overSeat, link: '/admin/license' }
                );
            } catch {
                /* best-effort */
            }
        }
        req.flash && req.flash('success', t('admin:ops_lic_saved'));
        res.redirect('/admin/license');
    }
}

const controller = new LicenseController();
controller.validateLicense = validateLicense;
controller.KNOWN_KEYS = KNOWN_KEYS;
module.exports = controller;
