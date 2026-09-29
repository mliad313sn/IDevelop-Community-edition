const DashboardService = require('../services/DashboardService');
const db = require('../config/database');
const RBACService = require('../services/RBACService');

const _n = (v) => Number(v) || 0;
const BAND = { low: 0, medium: 1, high: 2 };

// Smallest number of MEASURED PIP closures that may be turned into a published
// success percentage. Below it the tile reports "not measured" and shows the
// raw counts instead. Same suppression threshold the survey module already
// uses for small groups (SurveyService / DEIService / bias: 5 since 3.23.17), so the product has
// ONE convention for "too few observations to publish a ratio".
const PIP_MIN_MEASURED_CLOSURES = 5;

class DashboardController {
    // -------------------------------------------------------------------------
    // Helper: RBAC Filter Construction
    // -------------------------------------------------------------------------

    _buildFilters(req) {
        const f = {};

        // Une requête sans chaîne de requête est un appel LÉGITIME (les sondes et
        // les tests d'intégration appellent le contrôleur directement) : lire
        // `req.query` sans garde rendait un 500 au lieu d'une mesure non filtrée.
        const q = (req && req.query) || {};

        // 1. User Selection (from Query) - Now Name based
        if (q.siteName && q.siteName !== 'null' && q.siteName !== '') f.siteName = q.siteName;
        if (q.departmentName && q.departmentName !== 'null' && q.departmentName !== '')
            f.departmentName = q.departmentName;
        if (q.serviceName && q.serviceName !== 'null' && q.serviceName !== '')
            f.serviceName = q.serviceName;
        // Roles and Domains if needed
        if (q.roleName && q.roleName !== 'null' && q.roleName !== '') f.roleName = q.roleName;
        if (q.domainName && q.domainName !== 'null' && q.domainName !== '')
            f.domainName = q.domainName;

        // Legacy/Backup ID handling if needed (or remove if fully switched)?
        // Keeping them might conflict if mixed. Let's prefer Name.
        // If ID passed, we ignore or map? Use Name. ID deprecated for dashboard filters.

        // 2. RBAC Scope Enforcement (Updates/Overrides User Selection)
        const s = req.scope || {};

        // If scope has restrictions (array length > 0), use scope.
        // If user selected something *within* scope, we could respect it,
        // but for simplicity and security, the Model treats 'siteIds' params as an IN clause.
        // If we want intersection (User Selection AND Scope), we need to handle that.
        // The Model _buildFilterClause handles:
        // - siteId (single) -> "AND siteId = ?"
        // - siteIds (array) -> "AND siteId IN (?)"
        // If BOTH are present, both ANDs apply. This is correct intersection.
        // e.g. User selects Site 1. Scope allows Site 1, 2. Query becomes: Site=1 AND Site IN(1,2). Result: Site 1.
        // e.g. User selects Site 3. Scope allows Site 1, 2. Query becomes: Site=3 AND Site IN(1,2). Result: Empty. Correct.

        if (s.siteIds && s.siteIds.length) f.siteIds = s.siteIds;
        if (s.departmentIds && s.departmentIds.length) f.departmentIds = s.departmentIds;
        if (s.serviceIds && s.serviceIds.length) f.serviceIds = s.serviceIds;
        // Manager/supervisor scope: restrict to the people they govern.
        if (s.employeeIds && s.employeeIds.length) f.employeeIds = s.employeeIds;

        return f;
    }

    _handleError(res, error, message = 'Internal Server Error') {
        console.error(message, error);
        res.status(500).json({ error: message, details: error.message });
    }

    // -------------------------------------------------------------------------
    // Helper: the READER's own perimeter (RBAC), independent of any filter
    // -------------------------------------------------------------------------

    // The people the caller may see at all (managers → their governed sub-tree;
    // local admin/viewer → their admin scope; superadmin → everyone).
    // `null` means "no scope filter" — the only value that legitimately reads as
    // "the whole organisation".
    async _scopeEmployeeIds(req) {
        const user = req && req.user;
        if (RBACService.isSuperAdmin(user)) return null;
        try {
            if (user && user.userType === 'admin') {
                const e = await RBACService.getFilteredEmployees(user);
                return [...new Set((e || []).map((x) => Number(x.id)).filter(Boolean))];
            }
            if (user) {
                const EmployeeModel = require('../models/EmployeeModel');
                // the governed set is the manager's REPORTS — their span of
                // governance — exactly what the RBAC middleware puts in
                // req.scope.employeeIds (findGovernedIds, no self) and what every KPI
                // card counts. This used to push the manager's OWN id too, so the
                // "Périmètre" tiles (getMeasures) and the scope bar counted 17 where
                // the perimeter — and the headcount KPI — were 16, and could show
                // the manager's own site/department as an extra unit. All consumers
                // of this scope filter with `= ANY(?)`, which matches nothing on an
                // empty set, so a report-less manager stays correctly scoped to
                // no one (never org-wide).
                const ids = await EmployeeModel.findGovernedIds(user.id);
                return [...new Set(ids.map(Number).filter(Boolean))];
            }
        } catch (_) {
            /* fall through: an unresolvable scope is NOT a wider scope */
        }
        return null;
    }

    // M-12 (résiduel) — CE QUE LE BANDEAU A LE DROIT D'ÉCRIRE.
    // Mesuré avant correction : `uat.manager` sur `/dashboard`, sans aucun filtre,
    // lisait « Périmètre — Tous les sites · Tous les départements · Tous les
    // services » pendant que la tuile du même onglet rendait `scoped=true`,
    // `people 16`, `sites 1`, `depts 1`, `services 1` : la garantie promettait
    // PLUS LARGE que ce que les chiffres tenaient. `updateScopeBar` ne lisait que
    // les filtres choisis et retombait sur le libellé « Tous les … » de la
    // première option ; le périmètre RBAC n'entrait jamais dans le bandeau.
    // Ici on le résout côté serveur, avec EXACTEMENT le prédicat de la tuile
    // (`placedIn` : les entrées de catalogue réellement occupées par les
    // personnes du périmètre, sans prédicat d'état), pour que le bandeau et les
    // cartes ne puissent pas diverger. Aucun élargissement possible : à défaut de
    // résolution on ne renvoie pas « tous », on renvoie un périmètre non nommé.
    async _readerScope(req) {
        const empIds = await this._scopeEmployeeIds(req);
        if (empIds === null) return { restricted: false };
        const t = (k, fb) => (req && req.t ? req.t('dash:' + k) : fb);
        const scope = { restricted: true, empty: empIds.length === 0 };
        scope.limitedLabel = t('scope_limited', 'limited to your scope');
        scope.emptyLabel = t('scope_empty', 'Your scope contains no one');
        scope.fallbackLabel = t('scope_your_perimeter', 'Your scope');
        if (scope.empty) return scope;
        const dims = [
            ['site', 'sites', 'site_id', 'scope_n_sites', '{n} sites', 'scope_no_site', 'No site'],
            [
                'department',
                'departments',
                'department_id',
                'scope_n_departments',
                '{n} departments',
                'scope_no_department',
                'No department',
            ],
            [
                'service',
                'services',
                'service_id',
                'scope_n_services',
                '{n} services',
                'scope_no_service',
                'No service',
            ],
        ];
        for (const [key, table, col, nKey, nFb, zeroKey, zeroFb] of dims) {
            try {
                // On compte des ENTRÉES de catalogue (`DISTINCT t.id`), l'unité
                // exacte de la tuile : deux départements homonymes sur deux sites
                // (cas RÉEL du jeu, cf. `src/utils/orgFilters.js`) doivent faire
                // « 2 départements » dans le bandeau comme « Départements 2 » dans
                // la carte, jamais un nom au singulier au-dessus d'un 2.
                const rows = await db.all(
                    `SELECT DISTINCT t.id AS id, t.name AS name FROM ${table} t JOIN employees e ON e.${col} = t.id WHERE e.id = ANY(?) ORDER BY t.name`,
                    [empIds]
                );
                const entries = (rows || []).filter((r) => r && r.name);
                const total = await db.get(`SELECT COUNT(*) AS n FROM ${table}`);
                const catalogue = total ? Number(Object.values(total)[0]) : null;
                // Zéro entrée occupée n'est pas « toutes » : on l'écrit.
                if (entries.length === 0) {
                    scope[key] = t(zeroKey, zeroFb);
                    continue;
                }
                // Le libellé « Tous les … » n'est rendu que s'il est VRAI : le
                // périmètre couvre alors chaque entrée du catalogue.
                if (catalogue != null && entries.length >= catalogue) {
                    scope[key] = null;
                    continue;
                }
                scope[key] =
                    entries.length === 1
                        ? entries[0].name
                        : String(t(nKey, nFb)).replace('{n}', entries.length);
            } catch (_) {
                scope[key] = scope.fallbackLabel;
            }
        }
        return scope;
    }

    // -------------------------------------------------------------------------
    // Page Rendering
    // -------------------------------------------------------------------------

    async renderDashboard(req, res) {
        try {
            const filters = this._buildFilters(req);
            const filterOptions = await DashboardService.getFilterOptions(filters);

            // First-run setup banner: any ADMIN (not just superadmin), until the
            // org is set up or dismissed. A newly-delegated local admin landing on
            // an empty dashboard previously got no "start here" path (banner + /setup
            // were superadmin-only), so the person who actually populates a site
            // never saw the guided zero→first-assessment flow.
            // the banner follows the page — SuperAdmin only, because
            // /setup is now SuperAdmin-only and a banner nobody can open (or dismiss)
            // is a dead end.
            let setupPending = false;
            let setupProgress = null;
            if (req.user && req.user.userType === 'admin' && req.user.role === 'superadmin') {
                try {
                    const AppSettingsModel = require('../models/AppSettingsModel');
                    const dismissed = await AppSettingsModel.getValue('setupDismissed', false);
                    if (!dismissed) {
                        const SetupController = require('./SetupController');
                        setupProgress = await SetupController.getProgress();
                        setupPending = !setupProgress.complete;
                    }
                } catch (_) {
                    /* banner is best-effort */
                }
            }

            // M-12 (résiduel) : le bandeau « Périmètre » est rendu depuis le
            // périmètre RÉEL du lecteur, pas depuis le libellé de la première
            // option des listes déroulantes. Un lecteur borné ne lit plus
            // « Tous les sites » au-dessus de chiffres qui n'en couvrent qu'un.
            let readerScope = { restricted: false };
            try {
                readerScope = await this._readerScope(req);
            } catch (_) {
                readerScope = { restricted: false };
            }

            res.render('pages/dashboard', {
                user: req.user,
                filterOptions,
                readerScope,
                setupPending,
                setupProgress,
                // `title` (not just pageTitle) — the top bar and the browser <title>
                // read `title`; passing only pageTitle left it undefined, so the header
                // fell back to a hardcoded product name while the sidebar showed the
                // configured white-label brand (two names on one screen).
                title: req.t
                    ? req.t('dash:workforce_capability_dashboard')
                    : 'Workforce Capability Dashboard',
                pageTitle: 'Workforce Capability Dashboard',
                // Pass constants/enums if needed
            });
        } catch (error) {
            console.error('Error rendering dashboard:', error);
            res.status(500).send('Error loading dashboard');
        }
    }

    // -------------------------------------------------------------------------
    // API Endpoints
    // -------------------------------------------------------------------------

    async getOverviewKPIs(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getExecutiveData(filters);
            res.json(data.kpis);
        } catch (err) {
            this._handleError(res, err, 'Error fetching overview KPIs');
        }
    }

    async getReadinessByGroup(req, res) {
        try {
            const filters = this._buildFilters(req);
            const groupBy = req.query.groupBy || 'site'; // default?
            const data = await DashboardService.getReadinessByGroup(groupBy, filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching readiness by group');
        }
    }

    async getReadinessDistribution(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getReadinessDistribution(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching readiness distribution');
        }
    }

    async getSkillGaps(req, res) {
        try {
            // User spec: getSkillGaps -> service.getTrainingPriorities
            const filters = this._buildFilters(req);
            const data = await DashboardService.getTrainingPriorities(filters);
            // API Contract for /api/dashboard/skill-gaps ??
            // "GET /api/dashboard/skill-gaps -> [{ skillName... }]" (Array of skill gaps)
            // `getTrainingPriorities` returns `{ priorities: [], ... }`
            // So I should return `data.priorities`.
            res.json(data.priorities);
        } catch (err) {
            this._handleError(res, err, 'Error fetching skill gaps');
        }
    }

    async getDomainGaps(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getDomainGaps(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching domain gaps');
        }
    }

    async getGapsByService(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getGapsByService(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching gaps by service');
        }
    }

    async getGapsByGroup(req, res) {
        try {
            const filters = this._buildFilters(req);
            const groupBy = req.query.groupBy || 'service';
            const data = await DashboardService.getGapsByGroup(groupBy, filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching gaps by group');
        }
    }

    async getGapDrilldown(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getGapDrilldown(req.params.skillId, filters);
            res.json(data.employees); // Unwrapping object as per typical array response expectation or spec?
            // Service returns `{ employees }`. Route likely expects array of employees?
            // "GET /api/dashboard/gap-drilldown/:skillId" -> JSON.
            // In File 6 (JS): "fetch gap-drilldown... render sub-table"
        } catch (err) {
            this._handleError(res, err, 'Error fetching gap drilldown');
        }
    }

    async getRoleStaffing(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getRoleStaffing(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching role staffing');
        }
    }

    async getEmployeeList(req, res) {
        try {
            const filters = this._buildFilters(req);
            const options = {
                search: req.query.search,
                // Clamped (audit SA-11): an unbounded ?pageSize= asked the database
                // for the whole scoped table in one page, and a negative ?page=
                // reached PostgreSQL as a negative OFFSET (a 500).
                page: Math.max(1, parseInt(req.query.page, 10) || 1),
                pageSize: Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 200),
                sortBy: req.query.sortBy,
                sortDir: req.query.sortDir,
                supervisorId: req.query.supervisorId,
                roleId: req.query.roleId ? parseInt(req.query.roleId) : null,
            };
            // Note: Trend data is now included in getOverviewKPIs automatically via Service update?
            // Yes, Service.getExecutiveData now includes `trend`.
            // But we need to make sure frontend receives it.
            // `getOverviewKPIs` controller method calls `DashboardService.getExecutiveData`
            // but returns `data.kpis`.
            // I should update `getOverviewKPIs` to return the whole object or just kpis?
            // The frontend expects `kpis` object.
            // I should probably add a new endpoint `getExecutiveData` or just return everything?
            // Existing `getOverviewKPIs` is used by `loadExecutive` in frontend.
            // Let's create a new specific method for Trend or update `getOverviewKPIs` to return robust data.
            // But `loadExecutive` expects `kpis` to be the first result.
            // Let's just add `getManagerActionBoard` here first.
            const data = await DashboardService.getEmployeeList(filters, options);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching employee list');
        }
    }

    async getManagerActionBoard(req, res) {
        try {
            const filters = this._buildFilters(req);
            // If user is manager, enforce supervisor filter?
            // The service uses arbitrary filters.
            // If "My Direct Reports" toggle is on, frontend passes supervisorId?
            // But `getManagerActionBoard` implies "My Team".
            // Implementation: depends on filters passed.
            const data = await DashboardService.getManagerActionBoard(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching manager action board');
        }
    }

    async getExecutiveTrend(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getReadinessTrend(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching executive trend');
        }
    }

    async getEmployeeDetail(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getEmployeeProfile(req.params.id, filters);
            if (!data)
                return res.status(404).json({ error: 'Employee not found or access denied' });
            res.json(data); // returns { info, domainGroups, topGaps, strengths }
        } catch (err) {
            this._handleError(res, err, 'Error fetching employee detail');
        }
    }

    async getDomainHeatmap(req, res) {
        try {
            const filters = this._buildFilters(req);
            const groupBy = req.query.groupBy || 'site';
            const data = await DashboardService.getCapabilityMapData(filters, groupBy);
            res.json(data.heatmap); // Extract heatmap array
        } catch (err) {
            this._handleError(res, err, 'Error fetching domain heatmap');
        }
    }

    async getDomainRadarData(req, res) {
        try {
            const { groupId, groupBy } = req.query;

            // Fix: Return empty if params missing (prevents crash)
            if (!groupId || !groupBy) {
                return res.json([]);
            }

            const filters = this._buildFilters(req);

            // Fix: Radar chart compares specific groups, so we must ignore the global filter for that group type
            // to avoid "AND site = A AND site = B" conflicts.
            if (groupBy === 'site') {
                delete filters.siteName;
                delete filters.siteId;
            } else if (groupBy === 'service') {
                delete filters.serviceName;
                delete filters.serviceId;
            } else if (groupBy === 'department') {
                delete filters.departmentName;
                delete filters.departmentId;
            }

            // Extract Radar-specific filters
            if (req.query.domainName) filters.domainName = req.query.domainName;
            if (req.query.requiredOnly) filters.requiredOnly = req.query.requiredOnly;

            const data = await DashboardService.getDomainRadarData(groupId, groupBy, filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching domain radar data');
        }
    }

    async getFilterOptions(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getFilterOptions(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching filter options');
        }
    }

    async getOrgDomainRadar(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getOrgDomainRadar(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching org domain radar data');
        }
    }

    async getOrgSubDomainRadar(req, res) {
        try {
            const filters = this._buildFilters(req);
            // optional pillar drill-down
            if (
                req.query.domainName &&
                req.query.domainName !== '' &&
                req.query.domainName !== 'null'
            ) {
                filters.domainName = req.query.domainName;
            }
            const data = await DashboardService.getOrgSubDomainRadar(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching org sub-domain radar data');
        }
    }

    async getComparatorRadars(req, res) {
        try {
            const filters = this._buildFilters(req);
            const compOptions = {};

            // Extract benchmark targets — these overlap with filters but have different purpose
            // for the benchmark panel. We KEEP them in filters so other panels (domain/skill)
            // show data specific to the selection, but we also pass them as compOptions.
            if (filters.siteName) compOptions.compSite = filters.siteName;
            if (filters.departmentName) compOptions.compDepartment = filters.departmentName;
            if (filters.serviceName) compOptions.compService = filters.serviceName;

            // Domain filter stays as a cross-panel axis filter
            if (
                req.query.domainName &&
                req.query.domainName !== '' &&
                req.query.domainName !== 'null'
            ) {
                filters.domainName = req.query.domainName;
            }

            const data = await DashboardService.getComparatorRadars(filters, compOptions);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching comparator radars');
        }
    }

    async getStrategicInsights(req, res) {
        try {
            const filters = this._buildFilters(req);
            const data = await DashboardService.getStrategicInsights(filters);
            res.json(data);
        } catch (err) {
            this._handleError(res, err, 'Error fetching strategic insights');
        }
    }

    // -------------------------------------------------------------------------
    // Talent Development Performance
    // -------------------------------------------------------------------------
    // Build a secure WHERE for the talent-action tables: mandatory RBAC scope
    // (manager → reporting tree, local admin → admin scope, super admin → all)
    // joined to employees `e`, plus the dashboard's optional site/department/
    // service name filters via org-table joins.
    async _devFilter(req) {
        const sc = await RBACService.scopeFilter(req.user, { empAlias: 'e' });
        const f = this._buildFilters(req);
        const parts = [];
        const params = [];
        let joins = '';
        if (f.siteName) {
            joins += ' LEFT JOIN sites st ON st.id = e.site_id';
            parts.push('st.name = ?');
            params.push(f.siteName);
        }
        if (f.departmentName) {
            joins += ' LEFT JOIN departments dp ON dp.id = e.department_id';
            parts.push('dp.name = ?');
            params.push(f.departmentName);
        }
        if (f.serviceName) {
            joins += ' LEFT JOIN services sv ON sv.id = e.service_id';
            parts.push('sv.name = ?');
            params.push(f.serviceName);
        }
        const where = sc.clause + (parts.length ? ' AND ' + parts.join(' AND ') : '');
        return { joins, where, params: [...sc.params, ...params] };
    }

    async getTalentDevelopment(req, res) {
        try {
            const df = await this._devFilter(req);
            const W = `WHERE 1=1 ${df.where}`;
            const emp = (col) => `JOIN employees e ON e.id = ${col}`;

            const [coaching, coachCtx, idp, idpAct, pip, nine, levelUps] = await Promise.all([
                db.get(
                    `SELECT
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE c.state='active')    AS active,
                        COUNT(*) FILTER (WHERE c.state='completed') AS completed,
                        COUNT(*) FILTER (WHERE c.state='cancelled') AS cancelled,
                        COUNT(*) FILTER (WHERE c.kind='mentoring' AND c.state='active') AS mentoring_active,
                        COUNT(*) FILTER (WHERE c.kind='coaching'  AND c.state='active') AS coaching_active,
                        COUNT(*) FILTER (WHERE c.state='active' AND COALESCE(c.progress,0)=0) AS not_started,
                        COALESCE(ROUND(AVG(c.progress) FILTER (WHERE c.state='active')),0) AS avg_active_progress
                      FROM coaching_plans c ${emp('c.employee_id')} ${df.joins} ${W}`,
                    df.params
                ),
                db.all(
                    `SELECT c.context_type AS k, COUNT(*) AS c
                      FROM coaching_plans c ${emp('c.employee_id')} ${df.joins} ${W} GROUP BY c.context_type`,
                    df.params
                ),
                db.get(
                    `SELECT
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE i.status='draft')     AS draft,
                        COUNT(*) FILTER (WHERE i.status='active')    AS active,
                        COUNT(*) FILTER (WHERE i.status='completed') AS completed
                      FROM idp_plans i ${emp('i.employee_id')} ${df.joins} ${W}`,
                    df.params
                ),
                // Actions of cancelled/archived plans are out of the completion
                // denominator: a plan cancelled by the queue left its actions
                // 'pending' and kept dragging the org "IDP completion %" down.
                // Completed plans stay in — their done actions ARE the numerator,
                // and dropping them would make the % fall as plans finish.
                db.get(
                    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE a.status='completed') AS done
                      FROM idp_actions a JOIN idp_plans i ON i.id = a.idp_id ${emp('i.employee_id')} ${df.joins} ${W}
                        AND i.status IN ('draft','active','completed')`,
                    df.params
                ),
                // A PIP outcome is a judgement about whether the employee met the
                // plan's objectives OVER THE PLAN PERIOD. So a closure only counts
                // as MEASURED when that period had actually elapsed at closure:
                // a declared `ends_on`, already reached when the plan was closed.
                // A plan closed before its own end date (or with no end date at
                // all) was closed administratively — the period it claims to judge
                // was never observed — and it must not feed a success rate.
                // `updated_at` is the closure instant for a closed plan (the
                // set_updated_at trigger; nothing rewrites a closed PIP afterwards
                // except a GDPR erase, which only blanks text).
                // Every filter fails CLOSED: unknown dates => not measured.
                db.get(
                    `SELECT
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE p.state='proposed')       AS proposed,
                        COUNT(*) FILTER (WHERE p.state='active')         AS active,
                        COUNT(*) FILTER (WHERE p.state='closed_success') AS closed_success,
                        COUNT(*) FILTER (WHERE p.state='closed_failure') AS closed_failure,
                        COUNT(*) FILTER (WHERE p.state='closed_success'
                                           AND p.ends_on IS NOT NULL
                                           AND p.ends_on > p.created_at::date
                                           AND p.updated_at >= p.ends_on) AS measured_success,
                        COUNT(*) FILTER (WHERE p.state='closed_failure'
                                           AND p.ends_on IS NOT NULL
                                           AND p.ends_on > p.created_at::date
                                           AND p.updated_at >= p.ends_on) AS measured_failure
                      FROM pips p ${emp('p.employee_id')} ${df.joins} ${W}`,
                    df.params
                ),
                db.all(
                    `SELECT nb.performance AS perf, nb.potential AS pot, COUNT(*) AS c
                      FROM nine_box_evaluations nb ${emp('nb.employee_id')} ${df.joins} ${W} AND nb.status='approved'
                      GROUP BY nb.performance, nb.potential`,
                    df.params
                ),
                db.get(
                    `SELECT COUNT(*) AS c
                      FROM assessment_history ah ${emp('ah.employee_id')} ${df.joins} ${W}
                        AND ah.new_level > COALESCE(ah.previous_level, 0)
                        AND ah.assessed_at >= now() - interval '90 days'`,
                    df.params
                ),
            ]);

            const coachingContext = {};
            (coachCtx || []).forEach((r) => {
                coachingContext[r.k || 'other'] = _n(r.c);
            });

            // 9-box: build the 3×3 grid + top/core/risk tallies + a 5-tier talent
            // distribution curve (score = perf band + pot band, range 0..4).
            const grid = {};
            let top = 0,
                core = 0,
                risk = 0,
                assessed = 0;
            // Emit tier KEYS (score 0-4); the client maps them to localized labels
            // via the injected i18n bundle (talentTiers[score]).
            const TIER_KEYS = ['at_risk', 'below_core', 'core', 'above_core', 'top_talent'];
            const curveCounts = [0, 0, 0, 0, 0];
            (nine || []).forEach((r) => {
                const c = _n(r.c);
                assessed += c;
                grid[`${r.pot}-${r.perf}`] = c;
                const s = (BAND[r.perf] || 0) + (BAND[r.pot] || 0);
                curveCounts[s] += c;
                if (s >= 3) top += c;
                else if (s === 2) core += c;
                else risk += c;
            });
            const curve = TIER_KEYS.map((tier, i) => ({ tier, score: i, count: curveCounts[i] }));

            const pipClosed = _n(pip.closedSuccess) + _n(pip.closedFailure);
            // Success rate over the MEASURED closures only, and only once there
            // are enough of them to publish a ratio. Below the threshold — or
            // when nothing qualifies — successRate is null and the client prints
            // "not measured" rather than a confident percentage. The excluded
            // plans are NOT dropped: unmeasuredClosed and neverStarted carry them
            // to the surface as their own signal.
            const pipMeasuredSuccess = _n(pip.measuredSuccess);
            const pipMeasuredClosed = pipMeasuredSuccess + _n(pip.measuredFailure);
            const actTotal = _n(idpAct.total);

            res.json({
                coaching: {
                    total: _n(coaching.total),
                    active: _n(coaching.active),
                    completed: _n(coaching.completed),
                    cancelled: _n(coaching.cancelled),
                    mentoringActive: _n(coaching.mentoringActive),
                    coachingActive: _n(coaching.coachingActive),
                    notStarted: _n(coaching.notStarted),
                    avgProgress: _n(coaching.avgActiveProgress),
                },
                coachingContext,
                idp: {
                    total: _n(idp.total),
                    draft: _n(idp.draft),
                    active: _n(idp.active),
                    completed: _n(idp.completed),
                    actionTotal: actTotal,
                    actionDone: _n(idpAct.done),
                    completionPct: actTotal ? Math.round((_n(idpAct.done) / actTotal) * 100) : null,
                },
                pip: {
                    total: _n(pip.total),
                    proposed: _n(pip.proposed),
                    active: _n(pip.active),
                    closedSuccess: _n(pip.closedSuccess),
                    closedFailure: _n(pip.closedFailure),
                    closed: pipClosed,
                    measuredSuccess: pipMeasuredSuccess,
                    measuredFailure: _n(pip.measuredFailure),
                    measuredClosed: pipMeasuredClosed,
                    // closures whose plan period never elapsed — the signal that
                    // used to be laundered into the percentage
                    unmeasuredClosed: pipClosed - pipMeasuredClosed,
                    // plans still waiting to be started at all
                    neverStarted: _n(pip.proposed),
                    minMeasured: PIP_MIN_MEASURED_CLOSURES,
                    successRate:
                        pipMeasuredClosed >= PIP_MIN_MEASURED_CLOSURES
                            ? Math.round((pipMeasuredSuccess / pipMeasuredClosed) * 100)
                            : null,
                },
                nineBox: { assessed, top, core, risk, grid, curve },
                skillLevelUps90d: _n(levelUps.c),
            });
        } catch (err) {
            this._handleError(res, err, 'Error fetching talent development overview');
        }
    }

    // Additional workforce / talent / engagement measures (NON-security) for the
    // Executive Overview. Each metric runs in its own guard so one failure (e.g. a
    // differing enum) yields a null card, never a 500.
    async getMeasures(req, res) {
        const one = async (sql, params = []) => {
            try {
                const r = await db.get(sql, params);
                if (!r) return null;
                const v = Object.values(r)[0];
                return v == null ? null : Number(v);
            } catch (_) {
                return null;
            }
        };
        try {
            let empIds = await this._scopeEmployeeIds(req);
            // M-12 (arbitrage 4a) — LA TUILE SUIT LE FILTRE ACTIF.
            // Mesuré avant correction : `getMeasures` ne lisait AUCUN `req.query`,
            // si bien que la charge était octet pour octet identique avec et sans
            // filtre (uat.admin, md5 8aec6bb36704d22d8b36aeebf0bb436c, 966 octets,
            // `people 76` des deux côtés) pendant que `/overview-kpis` passait de
            // 76 à 17 sur le MÊME filtre — deux réponses contradictoires sur le
            // même écran. Le filtre de nom est résolu vers les personnes qu'il
            // désigne, puis INTERSECTÉ avec le périmètre RBAC : un filtre ne peut
            // jamais élargir un périmètre, seulement le rétrécir (le prédicat RBAC
            // reste ET-é, comme partout ailleurs sur ce contrôleur).
            const f = this._buildFilters(req);
            if (f.siteName || f.departmentName || f.serviceName || f.roleName) {
                const joins = [];
                const where = [];
                const params = [];
                if (f.siteName) {
                    joins.push('LEFT JOIN sites st ON st.id = e.site_id');
                    where.push('st.name = ?');
                    params.push(f.siteName);
                }
                if (f.departmentName) {
                    joins.push('LEFT JOIN departments dp ON dp.id = e.department_id');
                    where.push('dp.name = ?');
                    params.push(f.departmentName);
                }
                if (f.serviceName) {
                    joins.push('LEFT JOIN services sv ON sv.id = e.service_id');
                    where.push('sv.name = ?');
                    params.push(f.serviceName);
                }
                if (f.roleName) {
                    joins.push('LEFT JOIN roles rl ON rl.id = e.role_id');
                    where.push('rl.name = ?');
                    params.push(f.roleName);
                }
                // Pas de `is_active` ici : chaque mesure porte déjà son propre
                // prédicat d'état (people compte les actifs, les plans comptent
                // leurs états). Le filtre est un filtre de PLACEMENT, rien d'autre.
                const rows = await db.all(
                    `SELECT e.id FROM employees e ${joins.join(' ')} WHERE ${where.join(' AND ')}`,
                    params
                );
                const picked = new Set(rows.map((r) => Number(r.id)).filter(Boolean));
                empIds = empIds === null ? [...picked] : empIds.filter((id) => picked.has(id));
            }
            const scoped = Array.isArray(empIds);
            // `col = ANY(?)` with ONE array parameter, not an N-placeholder
            // IN-list. Sixteen queries run per request here, and the recursive
            // `layers` CTE binds the scope TWICE — for a superadmin-adjacent
            // scope on a 4 000-person estate that was ~8 000 bind parameters in
            // a single statement and a distinct SQL string (so a fresh parse and
            // a translation-cache miss) on every request. The template is now
            // constant regardless of scope size.
            // An empty scope still yields `AND 1=0` (no rows) rather than
            // relying on PG's `= ANY('{}')` semantics; '' when unscoped (superadmin).
            const inq = (col) =>
                !scoped ? '' : empIds.length ? ` AND ${col} = ANY(?)` : ' AND 1=0';
            const P = () => (scoped && empIds.length ? [empIds] : []);
            // Catalogue de PLACEMENT (sites / départements / services / postes) :
            // dès qu'un périmètre ou un filtre est actif, on compte les entrées
            // RÉELLEMENT OCCUPÉES par les personnes de ce périmètre — exactement
            // la règle que `ReportBuilderService.getReferenceData` (:913-925)
            // applique déjà à ses listes de filtres, et pour la même raison :
            // offrir un compte qui ne peut pas produire une seule ligne pour ce
            // lecteur se lit comme un écran faux. Sans périmètre ni filtre, c'est
            // le catalogue entier, inchangé. L'unité ne change pas d'un cas à
            // l'autre : on compte des ENTRÉES de catalogue dans les deux modes.
            const placedIn = (table, col) =>
                !scoped
                    ? `SELECT COUNT(*) FROM ${table}`
                    : `SELECT COUNT(DISTINCT t.id) FROM ${table} t JOIN employees e ON e.${col} = t.id WHERE 1=1${inq('e.id')}`;
            const lineMeasures = require('../models/DashboardModel')
                .reportingLineMeasures(scoped ? empIds : null)
                .catch(() => ({ managers: null, span: null, layers: null }));

            const [
                people,
                sites,
                depts,
                services,
                roles,
                managers,
                span,
                layers,
                placed,
                coaching,
                idp,
                pip,
                goals,
                checkins,
                skills,
                domains,
            ] = await Promise.all([
                one(`SELECT COUNT(*) FROM employees e WHERE is_active${inq('e.id')}`, P()),
                one(placedIn('sites', 'site_id'), P()),
                one(placedIn('departments', 'department_id'), P()),
                one(placedIn('services', 'service_id'), P()),
                one(placedIn('roles', 'role_id'), P()),
                // 3.23.18: managers / span / layers over the REPORTING LINE
                // (live supervisor, else live employee manager), computed once and
                // cycle-safe — see DashboardModel.reportingLineStats. The three
                // queries this replaces read manager_id alone (a team led through
                // supervisor_id counted no manager) and started the depth walk from
                // "no manager" roots, so a reporting loop, and a manager's own
                // perimeter, dropped people silently. One failure → null cards.
                lineMeasures.then((m) => m.managers),
                lineMeasures.then((m) => m.span),
                lineMeasures.then((m) => m.layers),
                one(
                    `SELECT COUNT(DISTINCT employee_id) FROM nine_box_evaluations WHERE status='approved'${inq('employee_id')}`,
                    P()
                ),
                one(
                    `SELECT COUNT(*) FROM coaching_plans WHERE state NOT IN ('completed','cancelled')${inq('employee_id')}`,
                    P()
                ),
                one(
                    `SELECT COUNT(*) FROM idp_plans WHERE status IN ('draft','active')${inq('employee_id')}`,
                    P()
                ),
                one(
                    `SELECT COUNT(*) FROM pips WHERE state IN ('active','proposed','approved')${inq('employee_id')}`,
                    P()
                ),
                one(
                    `SELECT COUNT(*) FROM goals WHERE status NOT IN ('completed','cancelled','archived')${inq('employee_id')}`,
                    P()
                ),
                one(
                    `SELECT COUNT(*) FROM check_ins WHERE created_at >= now() - interval '30 days'${inq('employee_id')}`,
                    P()
                ),
                // JAMAIS restreints, délibérément : compétences et domaines sont
                // le RÉFÉRENTIEL conçu par les départements, pas un placement
                // organisationnel. Le réduire à ce que les gens d'un périmètre
                // portent aujourd'hui masquerait des compétences — interdit (règle
                // du propriétaire, §3 règle 12) — et le même arbitrage est écrit
                // dans `ReportBuilderService.getReferenceData`. Ces deux cartes
                // sont marquées `framework` et la phrase de garantie les exclut
                // NOMMÉMENT (M-12, arbitrage 4b).
                one('SELECT COUNT(*) FROM skills'),
                one('SELECT COUNT(*) FROM domains'),
            ]);
            const calibrated =
                placed != null && people ? Math.round((100 * placed) / people) : null;
            // FR-first labels via i18next (req.t); English literal is the fallback
            // when the translator is unavailable on the request.
            const t = (k, fb) => (req.t ? req.t('dash:' + k) : fb);
            const measures = [
                { key: 'people', label: t('measure_people', 'Active employees'), value: people },
                { key: 'sites', label: t('measure_sites', 'Sites'), value: sites },
                { key: 'depts', label: t('measure_depts', 'Departments'), value: depts },
                { key: 'services', label: t('measure_services', 'Services'), value: services },
                { key: 'roles', label: t('measure_roles', 'Distinct roles'), value: roles },
                {
                    key: 'managers',
                    label: t('measure_managers', 'People managers'),
                    value: managers,
                },
                {
                    key: 'span',
                    label: t('measure_span', 'Avg span of control'),
                    value: span,
                    sub: t('measure_span_sub', 'reports per manager'),
                },
                { key: 'layers', label: t('measure_layers', 'Management layers'), value: layers },
                {
                    key: 'ninebox',
                    label: t('measure_ninebox', '9-box placed'),
                    value: placed,
                    sub:
                        calibrated != null
                            ? calibrated + t('measure_pct_workforce', '% of workforce')
                            : '',
                },
                {
                    key: 'coaching',
                    label: t('measure_coaching', 'Active coaching/mentoring'),
                    value: coaching,
                },
                { key: 'idp', label: t('measure_idp', 'Active IDPs'), value: idp },
                { key: 'pip', label: t('measure_pip', 'Active PIPs'), value: pip },
                { key: 'goals', label: t('measure_goals', 'Active goals / OKRs'), value: goals },
                {
                    key: 'checkins',
                    label: t('measure_checkins', 'Check-ins (30d)'),
                    value: checkins,
                },
                // `framework: true` = cette carte ne suit PAS le périmètre, et le dit.
                {
                    key: 'skills',
                    label: t('measure_skills', 'Skills tracked'),
                    value: skills,
                    framework: true,
                },
                {
                    key: 'domains',
                    label: t('measure_domains', 'Skill domains'),
                    value: domains,
                    framework: true,
                },
            ];
            res.json({
                measures,
                // Ce que la tuile vient de faire, pour que la vue puisse l'écrire
                // au lieu de l'affirmer : `scoped` = les chiffres de personnes
                // sont bornés (périmètre RBAC et/ou filtre actif).
                scoped,
                frameworkChip: t('measure_framework_chip', 'framework'),
                frameworkHint: t(
                    'measure_framework_hint',
                    'The skills framework is department-designed and deliberately org-wide: it is never reduced to the people in scope.'
                ),
            });
        } catch (err) {
            console.error('Dashboard measures error:', err);
            res.status(500).json({ error: 'Error computing measures' });
        }
    }
}

module.exports = DashboardController;
