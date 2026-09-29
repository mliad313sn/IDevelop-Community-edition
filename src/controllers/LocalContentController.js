'use strict';

const db = require('../config/database');
const AppSettingsModel = require('../models/AppSettingsModel');
const { csvCell } = require('../utils/csvSafe');

/**
 * Local Content / Nationalization report — OPTIONAL module, activated via the
 * `featureLocalContent` app setting (Settings → modules). Answers the
 * local-content compliance question for mining/regulated industries: what share
 * of the workforce is national, by role family and by site, and which positions
 * are expatriate-held (the nationalization pipeline).
 *
 * "National" = employee.nationality matches `localContentHomeCountry`
 * (case-insensitive). NULL/blank nationality = "unspecified" (counted apart so
 * partial data never inflates the national %).
 */
class LocalContentController {
    async _enabled() {
        // Robust on-check: a boolean setting mistakenly stored with setting_type
        // 'string' comes back as the string '0', and Boolean('0') is TRUE — which would
        // leave the module visible while it reads "0". Only treat explicit truthy values
        // as ON; '0' / 'false' / '' / false / null are OFF.
        const v = await AppSettingsModel.getValue('featureLocalContent', false);
        return v === true || v === 1 || v === '1' || v === 'true';
    }

    // Scope clause on employees alias `e`. Uses the canonical governed id-set
    // (RBACService.getFilteredEmployees) rather than hand-rolling scope tiers —
    // the previous version only honoured site/employee grants, so a
    // department- or service-scoped local admin (siteIds/employeeIds both empty)
    // fell through to org-wide national/expat headcounts. Superadmin → no clause
    // (org-wide by design); empty governed set → fail closed (no rows).
    async _scope(req, params) {
        const RBACService = require('../services/RBACService');
        if (RBACService.isSuperAdmin && RBACService.isSuperAdmin(req.user)) return '';
        const emps = await RBACService.getFilteredEmployees(req.user);
        const ids = [...new Set(emps.map((e) => Number(e.id)).filter(Boolean))];
        if (!ids.length) return ' AND 1 = 0';
        params.push(...ids);
        return ` AND e.id IN (${ids.map(() => '?').join(',')})`;
    }

    /**
     * Resolve the `localContentHomeCountry` setting to a country id. The setting is
     * free text typed by an administrator, so it is matched the same way a
     * nationality is: against the accepted spellings, case- and accent-insensitively.
     * Returns null when unset or unrecognised — the classifier then reports
     * "unspecified" rather than silently calling everyone an expatriate.
     */
    async _resolveCountryId(home) {
        const needle = String(home || '').trim();
        if (!needle) return null;
        const row = await db.get(
            `SELECT c.id
               FROM countries c
               JOIN country_aliases ca ON ca.country_id = c.id
              WHERE lower(unaccent(ca.alias)) = lower(unaccent(?))
              ORDER BY c.id LIMIT 1`,
            [needle]
        );
        return row ? Number(row.id) : null;
    }

    /**
     * Data of the « Nationalisation » and « Rapport réglementaire » tabs — loaded
     * only for the tab on screen, and only for a reader the services admit (a
     * tab the reader may not open is rendered as "not available", never as an
     * empty result).
     */
    async _tabData(req, tab) {
        const Nationalisation = require('../services/NationalisationService');
        const Reports = require('../services/LocalContentReportService');
        const out = {
            natAllowed: Nationalisation.canView(req.user),
            natCanWrite: Nationalisation.canWrite(req.user),
            packAllowed: Reports.canView(req.user),
            packCanManage: Reports.canManage(req.user),
            natPlans: [],
            natUnplanned: [],
            natCandidates: {},
            packs: [],
            packCountries: [],
        };
        if (tab === 'nationalisation' && out.natAllowed) {
            out.natPlans = await Nationalisation.listPlans(req.user);
            out.natUnplanned = await Nationalisation.unplannedExpatPositions(req.user);
            if (out.natCanWrite) {
                for (const p of out.natPlans.filter((x) => x.state === 'active')) {
                    out.natCandidates[p.id] = await Nationalisation.candidateSuccessors(
                        req.user,
                        p.id
                    );
                }
            }
        }
        if (tab === 'regulatory' && out.packAllowed) {
            out.packs = await Reports.list(req.user);
            out.packCountries = await Reports.countriesFor(req.user);
        }
        return out;
    }

    async index(req, res) {
        try {
            if (!(await this._enabled())) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:module_disabled')
                        : 'This module is not enabled. Activate it in Settings.'
                );
                return res.redirect('/dashboard');
            }
            // MULTI-COUNTRY: "national" is relative to each employee's OPERATING country
            // — the country of their site — so the report is correct for a group that
            // runs in several countries at once (e.g. an Ivorian is national in the CI
            // operation, a Burkinabè in the BF operation). `localContentHomeCountry` is
            // now only a FALLBACK for sites that have no country set. NULL/blank
            // nationality = "unspecified" (never counted as national).
            const home = String(
                (await AppSettingsModel.getValue('localContentHomeCountry', '')) || ''
            ).trim();

            // Resolve the fallback setting to a COUNTRY once, here, rather than
            // comparing strings in SQL — so the join below costs one parameter and
            // the classifier costs none.
            const homeCountryId = await this._resolveCountryId(home);

            // The operating country per employee row, and the national/expat classifier.
            // `_hc` is the fallback country for sites that have none.
            const CO_JOIN = `LEFT JOIN sites _st ON _st.id = e.site_id
                             LEFT JOIN countries _co ON _co.id = _st.country_id
                             LEFT JOIN countries _hc ON _hc.id = ?`; // 1 param (home fallback id)

            // A nationality is free text. Comparing it to the country's French
            // DISPLAY NAME meant nothing a human types ever matched — not the
            // English name, not a demonym, not the ISO code — so every national was
            // silently counted as an expatriate. Resolve to a country instead, case-
            // and accent-insensitively, through the accepted spellings.
            //
            // Two cases now yield "unspecified" rather than "expatriate": a blank
            // nationality (as before), and a site with no country and no fallback
            // setting — previously the whole site was classed expatriate in silence.
            const NAT = `CASE WHEN e.nationality IS NULL OR btrim(e.nationality) = '' THEN NULL
                              WHEN COALESCE(_co.id, _hc.id) IS NULL THEN NULL
                              WHEN EXISTS (SELECT 1 FROM country_aliases _ca
                                            WHERE _ca.country_id = COALESCE(_co.id, _hc.id)
                                              AND lower(unaccent(_ca.alias)) = lower(unaccent(btrim(e.nationality))))
                                   THEN 1
                              ELSE 0 END`;

            // Params in SQL order: the fallback country id (in CO_JOIN), then scope.
            const kpiP = [];
            const kpiScope = await this._scope(req, kpiP);
            const kpi = await db.get(
                `SELECT count(*)::int AS total,
                        count(*) FILTER (WHERE ${NAT} = 1)::int AS nationals,
                        count(*) FILTER (WHERE ${NAT} = 0)::int AS expats
                   FROM employees e ${CO_JOIN}
                  WHERE e.is_active = true${kpiScope}`,
                [homeCountryId, ...kpiP]
            );
            kpi.unspecified = kpi.total - kpi.nationals - kpi.expats;
            // The nationalisation ratio is measured on the population whose
            // nationality is KNOWN. Dividing by the whole headcount let unrecorded
            // nationalities read as a nationalisation shortfall — an absence of
            // measurement presented as a result. `unspecified` is reported beside
            // it so the base is always visible.
            kpi.specified = kpi.nationals + kpi.expats;
            kpi.nationalPct = kpi.specified
                ? Math.round((100 * kpi.nationals) / kpi.specified)
                : null;

            const byGroup = async (join, groupCol) => {
                const sp = [];
                const sc = await this._scope(req, sp);
                // Params in SQL order: the fallback country id (in CO_JOIN), then scope.
                return db.all(
                    `SELECT COALESCE(${groupCol}, '—') AS name,
                            count(*)::int AS headcount,
                            count(*) FILTER (WHERE ${NAT} = 1)::int AS nationals,
                            count(*) FILTER (WHERE ${NAT} = 0)::int AS expats,
                            count(*) FILTER (WHERE ${NAT} IS NULL)::int AS unspecified
                       FROM employees e ${CO_JOIN} ${join}
                      WHERE e.is_active = true${sc}
                      GROUP BY 1 ORDER BY headcount DESC`,
                    [homeCountryId, ...sp]
                );
            };

            const [byCountry, byDepartment, byFamily, bySite, expatPositions] = await Promise.all([
                // Per operating country — the headline multi-country breakdown.
                byGroup('', "COALESCE(_co.name, '—')"),
                byGroup('LEFT JOIN departments d ON d.id = e.department_id', 'd.name'),
                byGroup(
                    'LEFT JOIN roles r ON r.id = e.role_id LEFT JOIN role_families rf ON rf.id = r.role_family_id',
                    'rf.name'
                ),
                byGroup('LEFT JOIN sites s ON s.id = e.site_id', 's.name'),
                (async () => {
                    const p = [];
                    const sc = await this._scope(req, p);
                    // Params in SQL order: the fallback country id (in CO_JOIN), then scope.
                    return db.all(
                        `SELECT e.first_name || ' ' || e.last_name AS name, e.nationality,
                                r.name AS role_name, _st.name AS site_name, _co.name AS country_name, r.id AS role_id,
                                (SELECT count(*) FROM employees n
                                  WHERE n.is_active = true AND n.role_id = e.role_id AND n.id <> e.id
                                    AND EXISTS (SELECT 1 FROM country_aliases _ca2
                                                 WHERE _ca2.country_id = COALESCE(_co.id, _hc.id)
                                                   AND lower(unaccent(_ca2.alias)) = lower(unaccent(btrim(n.nationality)))))::int AS national_peers
                           FROM employees e ${CO_JOIN}
                           LEFT JOIN roles r ON r.id = e.role_id
                          WHERE e.is_active = true AND e.nationality IS NOT NULL AND e.nationality <> ''
                            AND ${NAT} = 0${sc}
                          ORDER BY _co.name NULLS LAST, _st.name, r.name`,
                        [homeCountryId, ...p]
                    );
                })(),
            ]);

            // CSV export: country + department + role-family breakdowns (the quota artifact).
            if (req.query.format === 'csv') {
                // `Unspecified` is a column of its own so Headcount = Nationals +
                // Expatriates + Unspecified always holds, and so the ratio's base is
                // auditable: it is computed on the population whose nationality is
                // recorded, not on the whole headcount.
                const header = [
                    'Group Type',
                    'Group',
                    'Headcount',
                    'Nationals',
                    'Expatriates',
                    'Unspecified',
                    'Specified',
                    'National % (of specified)',
                ];
                const lines = [header.map(csvCell).join(',')];
                const push = (type, rows) =>
                    rows.forEach((r) => {
                        const specified = Number(r.nationals) + Number(r.expats);
                        lines.push(
                            [
                                type,
                                r.name,
                                r.headcount,
                                r.nationals,
                                r.expats,
                                r.unspecified,
                                specified,
                                specified
                                    ? Math.round((100 * r.nationals) / specified) + '%'
                                    : 'n/a',
                            ]
                                .map(csvCell)
                                .join(',')
                        );
                    });
                push('Country', byCountry);
                push('Department', byDepartment);
                push('Role Family', byFamily);
                push('Site', bySite);
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', 'attachment; filename="local-content.csv"');
                // UTF-8 BOM so Excel opens accented names correctly (no mojibake).
                return res.send('﻿' + lines.join('\r\n'));
            }

            const tab = LocalContentController.TABS.includes(req.query.tab)
                ? req.query.tab
                : 'overview';
            let extra;
            try {
                extra = await this._tabData(req, tab);
            } catch (tabErr) {
                // The headline report stays readable; the tab says it failed.
                console.error('Local content tab error:', tabErr);
                extra = { tabError: true };
            }

            res.render('pages/reports/local-content', {
                title: req.t ? req.t('chrome:pt_local_content') : 'Local Content',
                home,
                kpi,
                byCountry,
                byDepartment,
                byFamily,
                bySite,
                expatPositions,
                tab,
                ...extra,
                csrfToken: req.csrfToken ? req.csrfToken() : res.locals && res.locals.csrfToken,
            });
        } catch (err) {
            console.error('Local content report error:', err);
            req.flash('error', req.t ? req.t('flash:report_load_error') : 'Error loading report');
            res.redirect('/dashboard');
        }
    }
}

LocalContentController.TABS = ['overview', 'nationalisation', 'regulatory'];

module.exports = new LocalContentController();
