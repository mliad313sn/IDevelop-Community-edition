'use strict';

/**
 * Integrations → HRIS (/admin/integrations/hris) — SuperAdmin only (route
 * guard) and core: not behind a module switch. Thin HTTP layer over
 * HrisSyncService: choose a connector, enter write-only credentials (recent
 * sign-in or current password required), set the column / attribute names and
 * the value mappings, test the connection, run a dry run (or upload a CSV),
 * review the plan, apply it, and read the sync history. Every action is
 * audit-logged by the service.
 */
const db = require('../config/database');
const Hris = require('../services/HrisSyncService');
const HrisConnectors = require('../integrations/hris');

const BASE = '/admin/integrations/hris';

function actorRef(req) {
    return req.user ? `${req.user.userType || 'admin'}:${req.user.id}` : null;
}

/** A stable error code → a sentence in the session language (literal keys). */
function errText(req, code, fallback) {
    const t = (k) => (req.t ? req.t(k) : null);
    const byCode = {
        hris_url_invalid: () => t('admin:hris_err_url_invalid'),
        hris_url_scheme: () => t('admin:hris_err_url_scheme'),
        hris_url_credentials: () => t('admin:hris_err_url_credentials'),
        hris_url_private: () => t('admin:hris_err_url_private'),
        hris_url_unresolved: () => t('admin:hris_err_url_unresolved'),
        hris_timeout: () => t('admin:hris_err_timeout'),
        hris_http_error: () => t('admin:hris_err_http'),
        hris_redirect_refused: () => t('admin:hris_err_redirect'),
        hris_response_too_large: () => t('admin:hris_err_too_large'),
        hris_missing_credentials: () => t('admin:hris_err_missing_credentials'),
        hris_missing_base_url: () => t('admin:hris_err_missing_base_url'),
        hris_auth_failed: () => t('admin:hris_err_auth_failed'),
        hris_csv_no_folder: () => t('admin:hris_err_csv_no_folder'),
        hris_csv_folder_outside_root: () => t('admin:hris_err_csv_outside_root'),
        hris_csv_folder_unreadable: () => t('admin:hris_err_csv_unreadable'),
        hris_csv_no_file: () => t('admin:hris_err_csv_no_file'),
        hris_csv_too_large: () => t('admin:hris_err_too_large'),
        hris_csv_empty: () => t('admin:hris_err_csv_empty'),
        hris_csv_no_id_column: () => t('admin:hris_err_csv_no_id_column'),
        hris_csv_too_many_rows: () => t('admin:hris_err_csv_too_many_rows'),
        hris_not_configured: () => t('admin:hris_err_not_configured'),
        hris_unknown_provider: () => t('admin:hris_err_unknown_provider'),
        hris_run_not_found: () => t('admin:hris_err_run_not_found'),
        hris_run_not_applicable: () => t('admin:hris_err_run_not_applicable'),
        hris_run_too_old: () => t('admin:hris_err_run_too_old'),
        hris_mapping_value_required: () => t('admin:hris_err_mapping_value'),
        hris_mapping_target_invalid: () => t('admin:hris_err_mapping_target'),
        hris_bad_mapping_kind: () => t('admin:hris_err_mapping_target'),
    };
    const s = byCode[code] ? byCode[code]() : null;
    return s || fallback || (req.t ? req.t('admin:hris_err_generic') : 'The HRIS action failed.');
}

function providerOf(v) {
    const p = String(v || '').toLowerCase();
    return Hris.PROVIDERS.includes(p) ? p : null;
}

async function referenceLists() {
    const sites = await db.all('SELECT id, name FROM sites WHERE is_active = true ORDER BY name');
    const departments = await db.all(
        `SELECT d.id, d.name, s.name AS site_name FROM departments d JOIN sites s ON s.id = d.site_id
          WHERE d.is_active = true ORDER BY s.name, d.name`
    );
    const services = await db.all(
        `SELECT v.id, v.name, d.name AS department_name, s.name AS site_name
           FROM services v JOIN departments d ON d.id = v.department_id JOIN sites s ON s.id = d.site_id
          WHERE v.is_active = true ORDER BY s.name, d.name, v.name`
    );
    const roles = await db.all('SELECT id, name FROM roles WHERE is_active = true ORDER BY name');
    return { sites, departments, services, roles };
}

class HrisSyncController {
    async page(req, res) {
        const enabled = await Hris.enabledRow();
        const provider = providerOf(req.query.provider) || (enabled && enabled.provider) || 'csv';
        const connectors = {};
        for (const p of Hris.PROVIDERS) connectors[p] = Hris.mask(await Hris.getRow(p), p);
        const runs = await Hris.listRuns(25);
        let run = null;
        if (req.query.run) run = await Hris.getRun(Number(req.query.run));
        if (!run) {
            const latest = runs.find((r) => r.provider === provider);
            if (latest) run = await Hris.getRun(latest.id);
        }
        const mappings = await Hris.listMappings();
        const refs = await referenceLists();
        let scimAutoPlace = false;
        try {
            scimAutoPlace = await Hris.scimAutoPlaceEnabled();
        } catch (_) {
            scimAutoPlace = false;
        }
        res.render('pages/admin/hris', {
            title: req.t ? req.t('admin:hris_title') : 'HRIS synchronisation',
            provider,
            providers: Hris.PROVIDERS,
            connector: connectors[provider],
            connectors,
            credentialKeys: Hris.credentialKeys(provider),
            csvColumns: HrisConnectors.REGISTRY.csv.DEFAULT_COLUMNS,
            personioAttributes: HrisConnectors.REGISTRY.personio.DEFAULT_ATTRIBUTES,
            runs,
            run,
            plan: run && run.plan ? run.plan : null,
            mappings,
            refs,
            scimAutoPlace,
            hrisBase: BASE,
        });
    }

    async saveConnector(req, res) {
        const provider = providerOf(req.body.provider);
        if (!provider) {
            req.flash('error', errText(req, 'hris_unknown_provider'));
            return res.redirect(BASE);
        }
        try {
            await Hris.saveConnector(
                provider,
                {
                    enabled: req.body.enabled,
                    autoApply: req.body.autoApply,
                    leaverGuardPct: req.body.leaverGuardPct,
                    scheduleHour: req.body.scheduleHour,
                    config: req.body.config || {},
                    credentials: req.body.credentials || {},
                },
                { actorRef: actorRef(req) }
            );
            req.flash('success', req.t ? req.t('admin:hris_saved') : 'Connector saved.');
        } catch (e) {
            req.flash('error', errText(req, e.code, e.message));
        }
        return res.redirect(`${BASE}?provider=${provider}`);
    }

    async saveScim(req, res) {
        const on = req.body.scimAutoPlace === 'true' || req.body.scimAutoPlace === 'on';
        await require('../models/AppSettingsModel').setValue(
            'hris.scimAutoPlace',
            on ? 'true' : 'false',
            'boolean',
            'SCIM provisioning: place a new user directly when every value maps through the HRIS mapping rules; otherwise the request waits in the onboarding queue.',
            'onboarding'
        );
        await require('../services/LogService').log({
            action: 'HRIS_SCIM_PLACEMENT_SET',
            entityType: 'hris_sync',
            actorRef: actorRef(req),
            details: `SCIM automatic placement ${on ? 'enabled' : 'disabled'}`,
            ipAddress: req.ip,
            userAgent: req.get ? req.get('user-agent') : null,
        });
        req.flash('success', req.t ? req.t('admin:hris_saved') : 'Saved.');
        return res.redirect(BASE);
    }

    async test(req, res) {
        const provider = providerOf(req.body.provider);
        if (!provider) {
            req.flash('error', errText(req, 'hris_unknown_provider'));
            return res.redirect(BASE);
        }
        const r = await Hris.testConnection(provider, { actorRef: actorRef(req) });
        if (r.ok) {
            req.flash(
                'success',
                req.t
                    ? req.t('admin:hris_test_ok', { n: r.sample == null ? 0 : r.sample })
                    : 'Connection OK.'
            );
        } else {
            req.flash(
                'error',
                `${errText(req, r.code, null)}${r.error ? ' (' + String(r.error).slice(0, 160) + ')' : ''}`
            );
        }
        return res.redirect(`${BASE}?provider=${provider}`);
    }

    async dryRun(req, res) {
        const provider = providerOf(req.body.provider);
        if (!provider) {
            req.flash('error', errText(req, 'hris_unknown_provider'));
            return res.redirect(BASE);
        }
        try {
            const r = await Hris.dryRun(provider, { trigger: 'manual', actorRef: actorRef(req) });
            if (r.status === 'failed')
                req.flash(
                    'error',
                    `${errText(req, r.code)} (${String(r.error || '').slice(0, 160)})`
                );
            else if (r.status === 'aborted')
                req.flash(
                    'error',
                    req.t ? req.t('admin:hris_guard_tripped_flash') : 'Guard tripped.'
                );
            else req.flash('success', req.t ? req.t('admin:hris_dry_run_done') : 'Dry run done.');
            return res.redirect(`${BASE}?provider=${provider}&run=${r.runId}`);
        } catch (e) {
            req.flash('error', errText(req, e.code, e.message));
            return res.redirect(`${BASE}?provider=${provider}`);
        }
    }

    /** Multipart upload (fetch with the CSRF header) → a dry run of the CSV connector. */
    async upload(req, res) {
        const f = req.file;
        if (!f || !f.buffer || !f.buffer.length) {
            return res.status(400).json({
                ok: false,
                code: 'hris_csv_empty',
                error: errText(req, 'hris_csv_empty'),
            });
        }
        try {
            const r = await Hris.dryRun('csv', {
                trigger: 'upload',
                actorRef: actorRef(req),
                text: f.buffer.toString('utf8'),
                fileName: String(f.originalname || 'upload.csv').slice(0, 200),
            });
            if (r.status === 'failed')
                return res
                    .status(400)
                    .json({ ok: false, code: r.code, error: errText(req, r.code, r.error) });
            return res.json({
                ok: true,
                runId: r.runId,
                status: r.status,
                redirect: `${BASE}?provider=csv&run=${r.runId}`,
            });
        } catch (e) {
            return res
                .status(400)
                .json({ ok: false, code: e.code || null, error: errText(req, e.code, e.message) });
        }
    }

    async apply(req, res) {
        const id = Number(req.params.id);
        try {
            const r = await Hris.apply(id, { actorRef: actorRef(req), trigger: 'manual' });
            if (r.status === 'aborted')
                req.flash(
                    'error',
                    req.t ? req.t('admin:hris_guard_tripped_flash') : 'Guard tripped.'
                );
            else if (r.errors && r.errors.length)
                req.flash(
                    'warning',
                    req.t
                        ? req.t('admin:hris_applied_with_errors', { n: r.errors.length })
                        : 'Applied with errors.'
                );
            else req.flash('success', req.t ? req.t('admin:hris_applied') : 'Applied.');
            return res.redirect(`${BASE}?run=${r.runId}`);
        } catch (e) {
            req.flash('error', errText(req, e.code, e.message));
            return res.redirect(`${BASE}?run=${id}`);
        }
    }

    async addMapping(req, res) {
        try {
            await Hris.addMapping(req.body.kind, req.body.externalValue, req.body.targetId, {
                actorRef: actorRef(req),
            });
            req.flash('success', req.t ? req.t('admin:hris_mapping_saved') : 'Mapping saved.');
        } catch (e) {
            req.flash('error', errText(req, e.code, e.message));
        }
        const back = req.body.run ? `${BASE}?run=${Number(req.body.run)}` : BASE;
        return res.redirect(`${back}#hris-mappings`);
    }

    async deleteMapping(req, res) {
        await Hris.deleteMapping(Number(req.params.id), { actorRef: actorRef(req) });
        req.flash('success', req.t ? req.t('admin:hris_mapping_deleted') : 'Mapping removed.');
        return res.redirect(`${BASE}#hris-mappings`);
    }

    /** The default CSV headers, as a file to start from. */
    async template(req, res) {
        const cols = Object.values(HrisConnectors.REGISTRY.csv.DEFAULT_COLUMNS);
        const sample = [
            'HR-0001',
            'E0001',
            'Awa',
            'Diallo',
            'awa.diallo@example.com',
            'Welder',
            'Mining',
            'Stonebridge',
            'Open Pit',
            'HR-0002',
            '2024-03-01',
            '',
            'active',
        ];
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="hris-export-template.csv"');
        res.send('\ufeff' + [cols.join(','), sample.join(',')].join('\r\n') + '\r\n');
    }
}

module.exports = new HrisSyncController();
module.exports.errText = errText;
