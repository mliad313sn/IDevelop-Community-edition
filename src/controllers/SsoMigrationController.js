'use strict';
/**
 * SSO migration console (/admin/sso-migration) — SuperAdmin only.
 * Thin HTTP layer over SsoRemapService: every decision lives in the service.
 */
const SsoRemapService = require('../services/SsoRemapService');
const { csvResponse } = require('../utils/listTools');

const T = (req, key, params, fallback) =>
    req.t
        ? req.t(`admin:${key}`, { defaultValue: fallback || key, ...(params || {}) })
        : fallback || key;

/** Configured providers first; the others stay selectable (prepare before go-live). */
function providerChoices() {
    let enabled = [];
    try {
        enabled = require('../config/sso')
            .getEnabledProviders()
            .map((p) => p.key);
    } catch (_) {
        /* SSO module unavailable: all choices shown as not configured */
    }
    return SsoRemapService.PROVIDERS.map((key) => ({ key, enabled: enabled.includes(key) }));
}

/** Service result → JSON, with the message localised. */
function send(req, res, r) {
    if (!r)
        return res
            .status(500)
            .json({ ok: false, error: T(req, 'ssom_err_generic', null, 'Unexpected error.') });
    if (!r.ok)
        return res.status(400).json({ ok: false, code: r.code, error: T(req, r.code, r.params) });
    return res.json(r);
}

class SsoMigrationController {
    async page(req, res) {
        const [readiness, batches] = await Promise.all([
            SsoRemapService.readiness(),
            SsoRemapService.batches(),
        ]);
        res.render('pages/admin/sso-migration', {
            title: req.t ? req.t('chrome:pt_sso_migration') : 'SSO migration',
            readiness,
            batches,
            providers: providerChoices(),
            outcomes: SsoRemapService.OUTCOMES,
            maxRows: SsoRemapService.MAX_ROWS,
            expectedTenant: process.env.SSO_EXPECTED_TENANT_ID || process.env.AZURE_TENANT_ID || '',
        });
    }

    async preview(req, res) {
        const b = req.body || {};
        const r = await SsoRemapService.preview(
            {
                text: typeof b.text === 'string' ? b.text : '',
                sourceName: String(b.sourceName || '').slice(0, 200),
                provider: String(b.provider || ''),
                resolutions:
                    b.resolutions && typeof b.resolutions === 'object' ? b.resolutions : {},
            },
            req.user
        );
        return send(req, res, r);
    }

    async apply(req, res) {
        const b = req.body || {};
        const r = await SsoRemapService.apply(
            { previewId: Number(b.previewId), expectedCount: Number(b.expectedCount) },
            req.user
        );
        return send(req, res, r);
    }

    async undo(req, res) {
        const r = await SsoRemapService.undo(
            { batchId: Number(req.params.id), reason: String((req.body && req.body.reason) || '') },
            req.user
        );
        return send(req, res, r);
    }

    async searchEmployees(req, res) {
        const rows = await SsoRemapService.searchEmployees(String(req.query.q || ''));
        res.json({
            ok: true,
            rows: rows.map((e) => ({
                id: Number(e.id),
                number: e.employeeNumber,
                name: `${e.firstName || ''} ${e.lastName || ''}`.trim(),
                email: e.email || '',
                site: e.siteName || '',
            })),
        });
    }

    /** The import template: the columns an Entra "Download users" export carries. */
    async template(req, res) {
        return csvResponse(
            res,
            'sso-migration-template.csv',
            [
                'objectId',
                'userPrincipalName',
                'mail',
                'employeeId',
                'displayName',
                'userType',
                'accountEnabled',
            ],
            []
        );
    }

    /** Active employees with no SSO link and no mapping — to fix and re-import. */
    async unmappedCsv(req, res) {
        const rows = await SsoRemapService.unmappedEmployees();
        return csvResponse(
            res,
            'sso-migration-unmapped.csv',
            [
                T(req, 'ssom_csv_number', null, 'Matricule'),
                T(req, 'ssom_csv_last', null, 'Nom'),
                T(req, 'ssom_csv_first', null, 'Prénom'),
                T(req, 'ssom_csv_email', null, 'E-mail'),
                T(req, 'ssom_csv_site', null, 'Site'),
            ],
            rows.map((e) => [
                e.employeeNumber,
                e.lastName,
                e.firstName,
                e.email || '',
                e.siteName || '',
            ])
        );
    }

    /** Open mappings: the people expected to sign in via SSO for the first time. */
    async pendingCsv(req, res) {
        const rows = await SsoRemapService.pendingMappings(100000);
        return csvResponse(
            res,
            'sso-migration-awaiting-first-sign-in.csv',
            [
                T(req, 'ssom_csv_number', null, 'Matricule'),
                T(req, 'ssom_csv_last', null, 'Nom'),
                T(req, 'ssom_csv_first', null, 'Prénom'),
                'provider',
                'objectId',
                'userPrincipalName',
                'employeeId',
                T(req, 'ssom_csv_batch', null, 'Lot'),
            ],
            rows.map((p) => [
                p.employeeNumber,
                p.lastName,
                p.firstName,
                p.provider,
                p.matchObjectId || '',
                p.matchUpn || '',
                p.matchEmployeeId || '',
                p.batchId || '',
            ])
        );
    }
}

module.exports = new SsoMigrationController();
