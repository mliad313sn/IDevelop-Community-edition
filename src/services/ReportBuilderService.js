const db = require('../config/database');
const { scopedEmployeeIds } = require('../utils/rbacScope');
const { ilike } = require('../utils/searchSql');
const { csvCell } = require('../utils/csvSafe');

class ReportBuilderService {
    /**
     * Get available data sources for report building
     */
    getDataSources() {
        return [
            {
                id: 'employees',
                name: 'Employees',
                description: 'Employee information with organization details',
                fields: [
                    { id: 'employeeNumber', name: 'Employee Number', type: 'text' },
                    { id: 'firstName', name: 'First Name', type: 'text' },
                    { id: 'lastName', name: 'Last Name', type: 'text' },
                    { id: 'email', name: 'Email', type: 'text' },
                    { id: 'phone', name: 'Phone', type: 'text' },
                    { id: 'siteName', name: 'Site', type: 'reference', source: 'sites' },
                    {
                        id: 'departmentName',
                        name: 'Department',
                        type: 'reference',
                        source: 'departments',
                    },
                    { id: 'serviceName', name: 'Service', type: 'reference', source: 'services' },
                    { id: 'roleName', name: 'Role', type: 'reference', source: 'roles' },
                    { id: 'isActive', name: 'Status', type: 'boolean' },
                    { id: 'createdAt', name: 'Created Date', type: 'date' },
                    { id: 'updatedAt', name: 'Updated Date', type: 'date' },
                ],
            },
            {
                id: 'assessments',
                name: 'Skill Assessments',
                description: 'Employee skill assessments and levels',
                fields: [
                    { id: 'employeeNumber', name: 'Employee Number', type: 'text' },
                    { id: 'employeeName', name: 'Employee Name', type: 'text' },
                    { id: 'skillName', name: 'Skill Name', type: 'text' },
                    { id: 'domainName', name: 'Domain', type: 'text' },
                    { id: 'currentLevel', name: 'Current Level', type: 'number' },
                    { id: 'requiredLevel', name: 'Required Level', type: 'number' },
                    { id: 'isCritical', name: 'Is Critical', type: 'boolean' },
                    { id: 'assessedBy', name: 'Assessed By', type: 'text' },
                    { id: 'assessedAt', name: 'Assessment Date', type: 'date' },
                    { id: 'notes', name: 'Notes', type: 'text' },
                ],
            },
            {
                id: 'readiness',
                name: 'Employee Readiness',
                description: 'Employee readiness scores and status',
                fields: [
                    { id: 'employeeNumber', name: 'Employee Number', type: 'text' },
                    { id: 'employeeName', name: 'Employee Name', type: 'text' },
                    { id: 'siteName', name: 'Site', type: 'reference', source: 'sites' },
                    {
                        id: 'departmentName',
                        name: 'Department',
                        type: 'reference',
                        source: 'departments',
                    },
                    { id: 'serviceName', name: 'Service', type: 'reference', source: 'services' },
                    { id: 'roleName', name: 'Role', type: 'reference', source: 'roles' },
                    { id: 'totalRequired', name: 'Total Required Skills', type: 'number' },
                    { id: 'skillsMet', name: 'Skills Met', type: 'number' },
                    { id: 'skillsNotMet', name: 'Skills Not Met', type: 'number' },
                    { id: 'criticalSkillsMet', name: 'Critical Skills Met', type: 'number' },
                    { id: 'criticalSkillsTotal', name: 'Critical Skills Total', type: 'number' },
                    // Readiness % IS readiness_assessed_only (Wave 2) — the one
                    // number the dashboard, the API and the digest all publish.
                    { id: 'readinessPercent', name: 'Readiness %', type: 'number' },
                    // The all-requirements figure, kept under its own label so
                    // the two can never be confused for one another.
                    {
                        id: 'readinessAllRequirements',
                        name: 'Readiness % (all requirements, incl. never assessed as 0)',
                        type: 'number',
                    },
                    { id: 'isReady', name: 'Is Ready', type: 'boolean' },
                    // Provenance (migration 71): never_assessed | self_only | assessed,
                    // plus the assessed/expected denominator behind every score.
                    { id: 'assessmentStatus', name: 'Assessment Status', type: 'text' },
                    { id: 'assessedSkills', name: 'Assessed Skills', type: 'number' },
                    { id: 'expectedSkills', name: 'Expected Skills', type: 'number' },
                    { id: 'neverAssessedSkills', name: 'Never Assessed Skills', type: 'number' },
                    { id: 'coveragePercent', name: 'Coverage %', type: 'number' },
                    {
                        id: 'readinessAssessedOnly',
                        name: 'Readiness % (assessed only)',
                        type: 'number',
                    },
                ],
            },
            {
                id: 'skills',
                name: 'Skills & Domains',
                description: 'Skills catalog and domain information',
                fields: [
                    { id: 'skillName', name: 'Skill Name', type: 'text' },
                    { id: 'domainName', name: 'Domain', type: 'text' },
                    { id: 'skillDescription', name: 'Skill Description', type: 'text' },
                    { id: 'isActive', name: 'Status', type: 'boolean' },
                    { id: 'createdAt', name: 'Created Date', type: 'date' },
                ],
            },
            {
                id: 'roles',
                name: 'Roles & Requirements',
                description: 'Job roles and skill requirements',
                fields: [
                    { id: 'roleName', name: 'Role Name', type: 'text' },
                    { id: 'skillName', name: 'Skill Name', type: 'text' },
                    { id: 'domainName', name: 'Domain', type: 'text' },
                    { id: 'requiredLevel', name: 'Required Level', type: 'number' },
                    { id: 'isCritical', name: 'Is Critical', type: 'boolean' },
                    { id: 'employeeCount', name: 'Employee Count', type: 'number' },
                ],
            },
            {
                id: 'organization',
                name: 'Organization Structure',
                description: 'Sites, departments, and services',
                fields: [
                    { id: 'siteName', name: 'Site', type: 'text' },
                    { id: 'departmentName', name: 'Department', type: 'text' },
                    { id: 'serviceName', name: 'Service', type: 'text' },
                    { id: 'employeeCount', name: 'Employee Count', type: 'number' },
                    { id: 'isActive', name: 'Status', type: 'boolean' },
                ],
            },
        ];
    }

    /**
     * Get filter operators based on field type
     */
    getOperators(fieldType) {
        const operators = {
            text: [
                { value: 'equals', label: 'Equals' },
                { value: 'not_equals', label: 'Not Equals' },
                { value: 'contains', label: 'Contains' },
                { value: 'not_contains', label: 'Does Not Contain' },
                { value: 'starts_with', label: 'Starts With' },
                { value: 'ends_with', label: 'Ends With' },
                { value: 'is_empty', label: 'Is Empty' },
                { value: 'is_not_empty', label: 'Is Not Empty' },
            ],
            number: [
                { value: 'equals', label: 'Equals' },
                { value: 'not_equals', label: 'Not Equals' },
                { value: 'greater_than', label: 'Greater Than' },
                { value: 'less_than', label: 'Less Than' },
                { value: 'greater_or_equal', label: 'Greater or Equal' },
                { value: 'less_or_equal', label: 'Less or Equal' },
                { value: 'between', label: 'Between' },
            ],
            date: [
                { value: 'equals', label: 'Equals' },
                { value: 'before', label: 'Before' },
                { value: 'after', label: 'After' },
                { value: 'between', label: 'Between' },
                { value: 'last_days', label: 'Last N Days' },
                { value: 'next_days', label: 'Next N Days' },
            ],
            boolean: [
                { value: 'is_true', label: 'Is True' },
                { value: 'is_false', label: 'Is False' },
            ],
            reference: [
                { value: 'in', label: 'In' },
                { value: 'not_in', label: 'Not In' },
            ],
        };

        return operators[fieldType] || operators.text;
    }

    /**
     * Build SQL query based on report configuration
     */
    /**
     * The data sources buildQuery can actually execute.
     *
     * Kept as one list so a caller can ASK before committing to something that
     * will only fail later. The composite builder saves its templates with
     * `dataSource: 'multi'` (report-builder.js), and saveTemplate defaults a
     * missing dataSource to 'multi' as well — neither has a case below, so both
     * throw "Invalid data source". Scheduling such a template used to be
     * accepted happily and then fail on every tick, for ever, the owner finding
     * out only from last_status.
     */
    get EXECUTABLE_SOURCES() {
        return ['employees', 'assessments', 'readiness', 'skills', 'roles', 'organization'];
    }

    canExecute(dataSource) {
        return this.EXECUTABLE_SOURCES.includes(dataSource);
    }

    async buildQuery(config, user) {
        const { dataSource, selectedFields, filters, sorting, groupBy } = config;

        // `columns` is the RESOLVED select list: the caller's fields after the
        // whitelist (unknown keys dropped) plus anything the builder forces in
        // (readiness pulls its coverage/provenance columns along). It is what the
        // rows actually contain, and therefore the only honest CSV header.
        let built;
        switch (dataSource) {
            case 'employees':
                built = await this.buildEmployeesQuery(
                    selectedFields,
                    filters,
                    sorting,
                    groupBy,
                    user
                );
                break;
            case 'assessments':
                built = await this.buildAssessmentsQuery(
                    selectedFields,
                    filters,
                    sorting,
                    groupBy,
                    user
                );
                break;
            case 'readiness':
                built = await this.buildReadinessQuery(
                    selectedFields,
                    filters,
                    sorting,
                    groupBy,
                    user
                );
                break;
            case 'skills':
                built = await this.buildSkillsQuery(selectedFields, filters, sorting, groupBy);
                break;
            case 'roles':
                built = await this.buildRolesQuery(selectedFields, filters, sorting, groupBy, user);
                break;
            case 'organization':
                built = await this.buildOrganizationQuery(
                    selectedFields,
                    filters,
                    sorting,
                    groupBy,
                    user
                );
                break;
            default:
                throw new Error('Invalid data source');
        }

        return {
            query: built.query,
            params: built.params,
            columns: Array.isArray(built.columns) ? built.columns.slice() : [],
        };
    }

    /**
     * Build a safe `SELECT` list from a client-supplied field list. Only fields
     * present in the server-side `fieldMapping` whitelist are emitted; unknown
     * fields (which would otherwise land raw in the SQL alias position) are
     * dropped. The alias is double-quoted so it round-trips to the exact field
     * key the caller reads back from each row.
     */
    buildSelectList(selectedFields, fieldMapping) {
        const known = (Array.isArray(selectedFields) ? selectedFields : []).filter(
            (f) => fieldMapping[f]
        );
        return known.map((f) => `${fieldMapping[f]} AS "${f}"`).join(', ');
    }

    /** Whitelisted GROUP BY expression list (drops unknown fields). */
    buildGroupList(groupBy, fieldMapping) {
        return (Array.isArray(groupBy) ? groupBy : [])
            .filter((f) => fieldMapping[f])
            .map((f) => fieldMapping[f])
            .join(', ');
    }

    /**
     * Build employees query
     */
    async buildEmployeesQuery(selectedFields, filters, sorting, groupBy, user) {
        const fieldMapping = {
            employeeNumber: 'e.employeeNumber',
            firstName: 'e.firstName',
            lastName: 'e.lastName',
            email: 'e.email',
            phone: 'e.phone',
            siteName: 's.name',
            departmentName: 'd.name',
            serviceName: 'sv.name',
            roleName: 'r.name',
            isActive: 'e.isActive',
            createdAt: 'e.createdAt',
            updatedAt: 'e.updatedAt',
        };

        // Whitelist: only fields present in fieldMapping reach the SQL. An unknown
        // field would otherwise emit `undefined AS <field>` (an unhandled 500).
        const knownSel = (Array.isArray(selectedFields) ? selectedFields : []).filter(
            (f) => fieldMapping[f]
        );
        const cols = knownSel.length ? knownSel : [Object.keys(fieldMapping)[0]];
        const selectFields = cols.map((field) => `${fieldMapping[field]} AS ${field}`).join(', ');

        let query = `
            SELECT ${selectFields}
            FROM employees e
            LEFT JOIN sites s ON e.siteId = s.id
            LEFT JOIN departments d ON e.departmentId = d.id
            LEFT JOIN services sv ON e.serviceId = sv.id
            LEFT JOIN roles r ON e.roleId = r.id
            WHERE 1=1
        `;

        const params = [];

        // Apply RBAC filtering
        const rbacFilter = await this.getRBACFilter(user, 'e');
        if (rbacFilter.condition) {
            query += ` AND ${rbacFilter.condition}`;
            params.push(...rbacFilter.params);
        }

        // Apply custom filters
        if (filters && filters.conditions && filters.conditions.length > 0) {
            const { condition, filterParams } = this.buildFilterConditions(
                filters,
                fieldMapping,
                this.fieldTypesFor('employees')
            );
            if (condition) {
                query += ` AND (${condition})`;
                params.push(...filterParams);
            }
        }

        // Apply grouping (whitelisted — unknown fields dropped, never interpolated)
        if (groupBy && groupBy.length > 0) {
            const groupFields = groupBy
                .filter((f) => fieldMapping[f])
                .map((field) => fieldMapping[field])
                .join(', ');
            if (groupFields) query += ` GROUP BY ${groupFields}`;
        }

        // Apply sorting (whitelisted — an unknown sort field would yield ORDER BY undefined)
        if (sorting && sorting.length > 0) {
            const orderClauses = sorting
                .filter((s) => fieldMapping[s.field])
                .map(
                    (sort) =>
                        `${fieldMapping[sort.field]} ${/^desc$/i.test(String(sort.direction).trim()) ? 'DESC' : 'ASC'}`
                )
                .join(', ');
            if (orderClauses) query += ` ORDER BY ${orderClauses}`;
        }

        return { query, params, columns: cols };
    }

    /**
     * Build assessments query
     */
    async buildAssessmentsQuery(selectedFields, filters, sorting, groupBy, user) {
        const fieldMapping = {
            employeeNumber: 'e.employeeNumber',
            employeeName: "e.firstName || ' ' || e.lastName",
            skillName: 'sk.name',
            domainName: 'dm.name',
            currentLevel: 'sa.currentLevel',
            requiredLevel: 'rsr.requiredLevel',
            isCritical: 'rsr.isCritical',
            assessedBy: 'a.username',
            assessedAt: 'sa.assessedAt',
            notes: 'sa.notes',
        };

        // Whitelist: drop unknown fields before they land raw in the SELECT alias slot.
        const knownSel = (Array.isArray(selectedFields) ? selectedFields : []).filter(
            (f) => fieldMapping[f]
        );
        const cols = knownSel.length ? knownSel : [Object.keys(fieldMapping)[0]];
        const selectFields = cols.map((field) => `${fieldMapping[field]} AS ${field}`).join(', ');

        let query = `
            SELECT ${selectFields}
            FROM skillAssessments sa
            INNER JOIN employees e ON sa.employeeId = e.id
            INNER JOIN skills sk ON sa.skillId = sk.id
            INNER JOIN domains dm ON sk.domainId = dm.id
            LEFT JOIN roleSkillRequirements rsr ON e.roleId = rsr.roleId AND sa.skillId = rsr.skillId
            LEFT JOIN admins a ON sa.assessedBy = a.id
            WHERE 1=1
        `;

        const params = [];

        // Apply RBAC filtering
        const rbacFilter = await this.getRBACFilter(user, 'e');
        if (rbacFilter.condition) {
            query += ` AND ${rbacFilter.condition}`;
            params.push(...rbacFilter.params);
        }

        // Apply custom filters
        if (filters && filters.conditions && filters.conditions.length > 0) {
            const { condition, filterParams } = this.buildFilterConditions(
                filters,
                fieldMapping,
                this.fieldTypesFor('assessments')
            );
            if (condition) {
                query += ` AND (${condition})`;
                params.push(...filterParams);
            }
        }

        // Apply grouping (whitelisted — unknown fields dropped, never interpolated)
        if (groupBy && groupBy.length > 0) {
            const groupFields = groupBy
                .filter((f) => fieldMapping[f])
                .map((field) => fieldMapping[field])
                .join(', ');
            if (groupFields) query += ` GROUP BY ${groupFields}`;
        }

        // Apply sorting (whitelisted — an unknown sort field would yield ORDER BY undefined)
        if (sorting && sorting.length > 0) {
            const orderClauses = sorting
                .filter((s) => fieldMapping[s.field])
                .map(
                    (sort) =>
                        `${fieldMapping[sort.field]} ${/^desc$/i.test(String(sort.direction).trim()) ? 'DESC' : 'ASC'}`
                )
                .join(', ');
            if (orderClauses) query += ` ORDER BY ${orderClauses}`;
        }

        return { query, params, columns: cols };
    }

    /**
     * Build readiness query against the v_employee_readiness view (per employee).
     */
    async buildReadinessQuery(selectedFields, filters, sorting, groupBy, user) {
        const fieldMapping = {
            employeeNumber: 'emp.employeeNumber',
            employeeName: 'v.full_name',
            siteName: 'v.site_name',
            departmentName: 'v.department_name',
            serviceName: 'v.service_name',
            roleName: 'v.role_name',
            totalRequired: 'v.total_required',
            skillsMet: 'v.skills_met',
            // "Not met" is a MEASURED shortfall: assessed − met. It used to be
            // total_required − skills_met, so every requirement nobody had ever
            // rated was exported as a failed skill (37 invented failures for
            // someone assessed on 10 of 47). The full requirement count is
            // still exported, untouched, as totalRequired / expectedSkills —
            // and neverAssessedSkills says how many are simply unknown.
            skillsNotMet: '(COALESCE(c.assessed_skills, 0) - v.skills_met)',
            criticalSkillsMet: 'v.critical_met',
            criticalSkillsTotal: 'v.total_critical',
            // PROVENANCE (migration 71) + ONE NUMBER (Wave 2).
            //
            // This used to export v.readiness — readiness over EVERY
            // requirement, with the never-rated ones coalesced to level 0. For
            // a partially assessed employee that diverged from the dashboard by
            // up to 17 points on the same person, on the same day. It is now
            // readiness_assessed_only, the same figure the dashboard, the API
            // and the digest publish. NULL (blank / "—") when nothing was ever
            // assessed; a FULLY assessed employee's number is unchanged,
            // because with zero never-assessed requirements the two formulas
            // are arithmetically identical.
            //
            // The all-requirements figure is not lost — it is exported under
            // the distinct label readinessAllRequirements, never silently
            // swapped in under the old name.
            readinessPercent: 'c.readiness_assessed_only',
            readinessAllRequirements:
                'CASE WHEN COALESCE(c.assessed_skills, 0) = 0 THEN NULL ELSE v.readiness END',
            isReady:
                'CASE WHEN COALESCE(c.assessed_skills, 0) = 0 THEN NULL ELSE v.is_role_ready END',
            // The coverage denominator travels with the report so "40 %" can
            // never be read without "…of the 12 requirements out of 96 that
            // anyone actually assessed".
            assessmentStatus: `CASE WHEN COALESCE(c.assessed_skills, 0) = 0 THEN 'never_assessed'
                                    WHEN COALESCE(c.validated_skills, 0) = 0 THEN 'self_only'
                                    ELSE 'assessed' END`,
            assessedSkills: 'COALESCE(c.assessed_skills, 0)',
            expectedSkills: 'COALESCE(c.expected_skills, 0)',
            neverAssessedSkills: 'COALESCE(c.never_assessed_skills, 0)',
            coveragePercent: 'c.coverage',
            readinessAssessedOnly: 'c.readiness_assessed_only',
        };

        // Whitelist (this source was the only builder that skipped it: an
        // unknown key emitted `undefined AS <key>` → an unhandled 500).
        const knownSel = (Array.isArray(selectedFields) ? selectedFields : []).filter(
            (f) => fieldMapping[f]
        );
        const cols = knownSel.length ? knownSel : ['employeeName'];

        // COVERAGE TRAVELS WITH THE SCORE. A readiness column must never leave
        // this service without its denominator: "62 %" on its own is unreadable
        // once it is pasted into a deck. Selecting any readiness field pulls
        // assessed / expected / coverage / status along, deduplicated and only
        // when they were not already picked.
        // Skipped when the report is GROUPED: an ungrouped extra column is a
        // PG strict-GROUP-BY error, and a grouped readiness report is already
        // an aggregate whose denominator has to be chosen deliberately.
        const CARRIES_COVERAGE = [
            'readinessPercent',
            'readinessAssessedOnly',
            'readinessAllRequirements',
            'isReady',
        ];
        const COVERAGE_FIELDS = [
            'assessedSkills',
            'expectedSkills',
            'coveragePercent',
            'assessmentStatus',
        ];
        const grouped = Array.isArray(groupBy) && groupBy.length > 0;
        if (!grouped && cols.some((f) => CARRIES_COVERAGE.includes(f))) {
            COVERAGE_FIELDS.forEach((f) => {
                if (!cols.includes(f)) cols.push(f);
            });
        }

        const selectFields = cols.map((field) => `${fieldMapping[field]} AS ${field}`).join(', ');

        let query = `
            SELECT ${selectFields}
            FROM v_employee_readiness v
            LEFT JOIN employees emp ON emp.id = v.employee_id
            LEFT JOIN v_employee_assessment_coverage c ON c.employee_id = v.employee_id
            WHERE 1=1
        `;
        const params = [];

        // RBAC: scope by employee id on the view (see getRBACFilter — the old
        // site/department columns resolved against the wrong id-space for
        // managers and returned nothing at all).
        const rbacFilter = await this.getRBACFilter(user, 'v', 'employee_id');
        if (rbacFilter.condition) {
            query += ` AND ${rbacFilter.condition}`;
            params.push(...rbacFilter.params);
        }

        if (filters && filters.conditions && filters.conditions.length > 0) {
            const { condition, filterParams } = this.buildFilterConditions(
                filters,
                fieldMapping,
                this.fieldTypesFor('readiness')
            );
            if (condition) {
                query += ` AND (${condition})`;
                params.push(...filterParams);
            }
        }
        if (groupBy && groupBy.length > 0) {
            const groupFields = groupBy
                .filter((f) => fieldMapping[f])
                .map((f) => fieldMapping[f])
                .join(', ');
            if (groupFields) query += ` GROUP BY ${groupFields}`;
        }
        if (sorting && sorting.length > 0) {
            const orderClauses = sorting
                .filter((s) => fieldMapping[s.field])
                .map(
                    (sort) =>
                        `${fieldMapping[sort.field]} ${/^desc$/i.test(String(sort.direction).trim()) ? 'DESC' : 'ASC'}`
                )
                .join(', ');
            if (orderClauses) query += ` ORDER BY ${orderClauses}`;
        }
        return { query, params, columns: cols };
    }

    /**
     * Build skills query
     */
    async buildSkillsQuery(selectedFields, filters, sorting, groupBy) {
        const fieldMapping = {
            skillName: 'sk.name',
            domainName: 'd.name',
            skillDescription: 'sk.description',
            isActive: 'sk.isActive',
            createdAt: 'sk.createdAt',
        };

        const knownSel = (Array.isArray(selectedFields) ? selectedFields : []).filter(
            (f) => fieldMapping[f]
        );
        const cols = knownSel.length ? knownSel : [Object.keys(fieldMapping)[0]];
        const selectFields = cols.map((field) => `${fieldMapping[field]} AS ${field}`).join(', ');

        let query = `
            SELECT ${selectFields}
            FROM skills sk
            INNER JOIN domains d ON sk.domainId = d.id
            WHERE 1=1
        `;

        const params = [];

        // Apply custom filters
        if (filters && filters.conditions && filters.conditions.length > 0) {
            const { condition, filterParams } = this.buildFilterConditions(
                filters,
                fieldMapping,
                this.fieldTypesFor('skills')
            );
            if (condition) {
                query += ` AND (${condition})`;
                params.push(...filterParams);
            }
        }

        // Apply grouping (whitelisted — unknown fields dropped, never interpolated)
        if (groupBy && groupBy.length > 0) {
            const groupFields = groupBy
                .filter((f) => fieldMapping[f])
                .map((field) => fieldMapping[field])
                .join(', ');
            if (groupFields) query += ` GROUP BY ${groupFields}`;
        }

        // Apply sorting (whitelisted — an unknown sort field would yield ORDER BY undefined)
        if (sorting && sorting.length > 0) {
            const orderClauses = sorting
                .filter((s) => fieldMapping[s.field])
                .map(
                    (sort) =>
                        `${fieldMapping[sort.field]} ${/^desc$/i.test(String(sort.direction).trim()) ? 'DESC' : 'ASC'}`
                )
                .join(', ');
            if (orderClauses) query += ` ORDER BY ${orderClauses}`;
        }

        return { query, params, columns: cols };
    }

    /**
     * Build roles query
     */
    async buildRolesQuery(selectedFields, filters, sorting, groupBy, user) {
        const fieldMapping = {
            roleName: 'r.name',
            skillName: 'sk.name',
            domainName: 'd.name',
            requiredLevel: 'rsr.requiredLevel',
            isCritical: 'rsr.isCritical',
            employeeCount: 'COUNT(DISTINCT e.id)',
        };

        // Drop unknown field keys before they reach the SQL text (defense-in-depth;
        // an unknown key would otherwise emit `undefined AS <raw>`).
        const safeFields = (selectedFields || []).filter((f) => fieldMapping[f]);
        const cols = safeFields.length ? safeFields : ['roleName'];
        const selectFields = cols.map((field) => `${fieldMapping[field]} AS ${field}`).join(', ');

        // Scope the employee COUNT to the caller's RBAC scope — this source previously
        // ignored scope, so a site-limited admin could read org-wide headcount per role.
        // Put the filter in the JOIN (not WHERE) so all roles still list (count 0 when
        // no in-scope occupants).
        const rbac = user ? await this.getRBACFilter(user, 'e') : { condition: '', params: [] };
        const joinScope = rbac.condition ? ` AND (${rbac.condition})` : '';

        let query = `
            SELECT ${selectFields}
            FROM roles r
            LEFT JOIN roleSkillRequirements rsr ON r.id = rsr.roleId
            LEFT JOIN skills sk ON rsr.skillId = sk.id
            LEFT JOIN domains d ON sk.domainId = d.id
            LEFT JOIN employees e ON r.id = e.roleId AND e.isActive = 1${joinScope}
            WHERE 1=1
        `;

        // JOIN params precede any WHERE-filter params in the SQL text → push first.
        const params = [...rbac.params];

        // Apply custom filters
        if (filters && filters.conditions && filters.conditions.length > 0) {
            const { condition, filterParams } = this.buildFilterConditions(
                filters,
                fieldMapping,
                this.fieldTypesFor('roles')
            );
            if (condition) {
                query += ` AND (${condition})`;
                params.push(...filterParams);
            }
        }

        // Apply grouping (whitelisted — unknown fields dropped, never interpolated)
        if (groupBy && groupBy.length > 0) {
            const groupFields = groupBy
                .filter((f) => fieldMapping[f])
                .map((field) => fieldMapping[field])
                .join(', ');
            if (groupFields) query += ` GROUP BY ${groupFields}`;
        } else if (selectedFields.includes('employeeCount')) {
            // Auto-group if counting employees
            const nonAggregateFields = selectedFields
                .filter((f) => f !== 'employeeCount' && fieldMapping[f])
                .map((f) => fieldMapping[f]);
            if (nonAggregateFields.length > 0) {
                query += ` GROUP BY ${nonAggregateFields.join(', ')}`;
            }
        }

        // Apply sorting (whitelisted — an unknown sort field would yield ORDER BY undefined)
        if (sorting && sorting.length > 0) {
            const orderClauses = sorting
                .filter((s) => fieldMapping[s.field])
                .map(
                    (sort) =>
                        `${fieldMapping[sort.field]} ${/^desc$/i.test(String(sort.direction).trim()) ? 'DESC' : 'ASC'}`
                )
                .join(', ');
            if (orderClauses) query += ` ORDER BY ${orderClauses}`;
        }

        return { query, params, columns: cols };
    }

    /**
     * Build organization query
     */
    async buildOrganizationQuery(selectedFields, filters, sorting, groupBy, user) {
        const fieldMapping = {
            siteName: 's.name',
            departmentName: 'd.name',
            serviceName: 'sv.name',
            employeeCount: 'COUNT(DISTINCT e.id)',
            isActive: 'sv.isActive',
        };

        const knownSel = (Array.isArray(selectedFields) ? selectedFields : []).filter(
            (f) => fieldMapping[f]
        );
        const cols = knownSel.length ? knownSel : [Object.keys(fieldMapping)[0]];
        const selectFields = cols.map((field) => `${fieldMapping[field]} AS ${field}`).join(', ');

        // The scope belongs in the JOIN, not the WHERE — same as the role report
        // above. A condition on a LEFT-JOINed table placed in WHERE silently makes
        // it an INNER JOIN, so a VACANT service vanished for a scoped user while a
        // superadmin saw it at 0. Measured on identical population: 17 rows for the
        // superadmin, 16 for the scoped user — "Riverside / IT / Projects" disappeared.
        // That is precisely the service somebody needs to see in order to staff it.
        const rbacFilter = await this.getRBACFilter(user, 'e');
        const joinScope = rbacFilter.condition ? ` AND (${rbacFilter.condition})` : '';

        let query = `
            SELECT ${selectFields}
            FROM services sv
            INNER JOIN departments d ON sv.departmentId = d.id
            INNER JOIN sites s ON d.siteId = s.id
            LEFT JOIN employees e ON sv.id = e.serviceId AND e.isActive = 1${joinScope}
            WHERE 1=1
        `;

        // Scope params bind at the JOIN, so they lead the list.
        const params = [...rbacFilter.params];

        // Apply custom filters
        if (filters && filters.conditions && filters.conditions.length > 0) {
            const { condition, filterParams } = this.buildFilterConditions(
                filters,
                fieldMapping,
                this.fieldTypesFor('organization')
            );
            if (condition) {
                query += ` AND (${condition})`;
                params.push(...filterParams);
            }
        }

        // Apply grouping (whitelisted — unknown fields dropped, never interpolated)
        if (groupBy && groupBy.length > 0) {
            const groupFields = groupBy
                .filter((f) => fieldMapping[f])
                .map((field) => fieldMapping[field])
                .join(', ');
            if (groupFields) query += ` GROUP BY ${groupFields}`;
        } else if (selectedFields.includes('employeeCount')) {
            // Auto-group if counting employees
            const nonAggregateFields = selectedFields
                .filter((f) => f !== 'employeeCount' && fieldMapping[f])
                .map((f) => fieldMapping[f]);
            if (nonAggregateFields.length > 0) {
                query += ` GROUP BY ${nonAggregateFields.join(', ')}`;
            }
        }

        // Apply sorting (whitelisted — an unknown sort field would yield ORDER BY undefined)
        if (sorting && sorting.length > 0) {
            const orderClauses = sorting
                .filter((s) => fieldMapping[s.field])
                .map(
                    (sort) =>
                        `${fieldMapping[sort.field]} ${/^desc$/i.test(String(sort.direction).trim()) ? 'DESC' : 'ASC'}`
                )
                .join(', ');
            if (orderClauses) query += ` ORDER BY ${orderClauses}`;
        }

        return { query, params, columns: cols };
    }

    /**
     * Build filter conditions from filter configuration
     */
    buildFilterConditions(filters, fieldMapping, fieldTypes = {}) {
        if (!filters || !filters.conditions || filters.conditions.length === 0) {
            return { condition: '', filterParams: [] };
        }

        const conditions = [];
        const filterParams = [];
        // Whitelist the join operator — it is concatenated into the SQL string
        // (not bindable), so an unvalidated request value would be injectable.
        const logic = String(filters.logic).toUpperCase() === 'OR' ? 'OR' : 'AND';

        filters.conditions.forEach((filter) => {
            const field = fieldMapping[filter.field];
            if (!field) return;

            const { condition, params } = this.buildSingleFilter(
                field,
                filter,
                fieldTypes[filter.field]
            );
            if (condition) {
                conditions.push(condition);
                filterParams.push(...params);
            }
        });

        const finalCondition = conditions.length > 0 ? conditions.join(` ${logic} `) : '';
        return { condition: finalCondition, filterParams };
    }

    /**
     * Build a single filter condition.
     *
     * TEXT fields are matched case- AND accent-insensitively through the
     * shared `utils/searchSql.ilike` helper (f_unaccent + ILIKE, migration 46 —
     * the same helper the employee/system-log table searches use). Plain
     * `LIKE`/`=` made "lambert", "LAMBÉRT" and "Lambért" three different values,
     * so a French name typed without its accent never matched anything and the
     * report came back empty. Non-text fields keep exact comparison: numeric
     * and date columns must not be pushed through a text function.
     *
     * @param {string} field SQL expression from the server-side whitelist
     * @param {object} filter {operator, value, value2}
     * @param {string} [fieldType] text|number|date|boolean|reference
     */
    buildSingleFilter(field, filter, fieldType) {
        const { operator, value, value2 } = filter;
        const isText = fieldType === 'text';
        let condition = '';
        const params = [];

        switch (operator) {
            case 'equals':
                if (isText) {
                    condition = ilike(field);
                    params.push(String(value == null ? '' : value));
                } else {
                    condition = `${field} = ?`;
                    params.push(value);
                }
                break;
            case 'not_equals':
                if (isText) {
                    condition = `NOT (${ilike(field)})`;
                    params.push(String(value == null ? '' : value));
                } else {
                    condition = `${field} != ?`;
                    params.push(value);
                }
                break;
            case 'contains':
                condition = isText ? ilike(field) : `${field} LIKE ?`;
                params.push(`%${value}%`);
                break;
            case 'not_contains':
                condition = isText ? `NOT (${ilike(field)})` : `${field} NOT LIKE ?`;
                params.push(`%${value}%`);
                break;
            case 'starts_with':
                condition = isText ? ilike(field) : `${field} LIKE ?`;
                params.push(`${value}%`);
                break;
            case 'ends_with':
                condition = isText ? ilike(field) : `${field} LIKE ?`;
                params.push(`%${value}`);
                break;
            case 'is_empty':
                condition = `(${field} IS NULL OR ${field} = '')`;
                break;
            case 'is_not_empty':
                condition = `(${field} IS NOT NULL AND ${field} != '')`;
                break;
            case 'greater_than':
                condition = `${field} > ?`;
                params.push(value);
                break;
            case 'less_than':
                condition = `${field} < ?`;
                params.push(value);
                break;
            case 'greater_or_equal':
                condition = `${field} >= ?`;
                params.push(value);
                break;
            case 'less_or_equal':
                condition = `${field} <= ?`;
                params.push(value);
                break;
            case 'between':
                condition = `${field} BETWEEN ? AND ?`;
                params.push(value, value2);
                break;
            case 'before':
                condition = `${field} < ?`;
                params.push(value);
                break;
            case 'after':
                condition = `${field} > ?`;
                params.push(value);
                break;
            case 'last_days':
                condition = `${field} >= (now() - ((?)::text || ' days')::interval)`;
                params.push(value);
                break;
            case 'next_days':
                condition = `${field} <= (now() + ((?)::text || ' days')::interval)`;
                params.push(value);
                break;
            case 'is_true':
                condition = `${field} = 1`;
                break;
            case 'is_false':
                condition = `${field} = 0`;
                break;
            case 'in':
                if (Array.isArray(value) && value.length > 0) {
                    const placeholders = value.map(() => '?').join(', ');
                    condition = `${field} IN (${placeholders})`;
                    params.push(...value);
                }
                break;
            case 'not_in':
                if (Array.isArray(value) && value.length > 0) {
                    const placeholders = value.map(() => '?').join(', ');
                    condition = `${field} NOT IN (${placeholders})`;
                    params.push(...value);
                }
                break;
        }

        return { condition, params };
    }

    /**
     * Get the RBAC filter for a user.
     *
     * Resolution goes through `utils/rbacScope.scopedEmployeeIds` — the SAME
     * path every screen and Power BI feed uses:
     *     super admin           → unrestricted
     *     manager / supervisor  → EmployeeModel.findGovernedIds (employee ids)
     *     local admin / viewer  → RBACService.getFilteredEmployees (admin scopes)
     *
     * The previous implementation read `adminScopes WHERE adminId = user.id`
     * for anyone who was not a superadmin. A MANAGER's `user.id` is an
     * EMPLOYEE id — a different sequence from admin ids — so the lookup found
     * no scope rows and returned the fail-closed `1=0`. Result: every data
     * source produced an empty grid, empty charts and an empty CSV, with no
     * error anywhere. Scoping by employee id removes the id-space confusion
     * entirely (and an admin id can never be mistaken for an employee id).
     *
     * @param {object} user
     * @param {string} [tableAlias='e'] alias of the employees table / view
     * @param {string} [idColumn='id']  the employee-id column on that alias
     */
    async getRBACFilter(user, tableAlias = 'e', idColumn = 'id') {
        const ids = await scopedEmployeeIds(user);
        if (ids === null) return { condition: '', params: [] }; // super admin
        // Fail CLOSED: nothing visible → no rows (never the whole org).
        if (!ids.length) return { condition: '1=0', params: [] };
        // `= ANY(?)` with one array parameter keeps the SQL template identical
        // whatever the scope size, so the translation memo cache still hits.
        return { condition: `${tableAlias}.${idColumn} = ANY(?)`, params: [ids] };
    }

    /** Field-type lookup (text/number/date/boolean/reference) for a data source. */
    fieldTypesFor(dataSourceId) {
        const src = this.getDataSources().find((s) => s.id === dataSourceId);
        const out = {};
        (src ? src.fields : []).forEach((f) => {
            out[f.id] = f.type;
        });
        return out;
    }

    /**
     * Execute report query
     */
    async executeReport(config, user) {
        const { query, params, columns } = await this.buildQuery(config, user);
        const results = await db.all(query, params);
        // The resolved column list rides with the rows as a NON-enumerable
        // property: JSON consumers (the builder grid, /reports/generate) see the
        // same array they always did, while exportToCSV and the scheduler read
        // the columns the query really selected.
        Object.defineProperty(results, 'columns', {
            value: columns,
            enumerable: false,
            writable: true,
            configurable: true,
        });
        return results;
    }

    /**
     * Export data to CSV.
     *
     * The header/column list is the RESOLVED list executeReport selected
     * (`data.columns`), never the caller's raw selectedFields. Iterating the raw
     * list dropped every column the builder forced in (the readiness coverage /
     * provenance columns that make "62 %" readable) and emitted an all-blank
     * column for every field the whitelist had rejected. `selectedFields` is
     * only the fallback for rows that did not come through executeReport.
     */
    exportToCSV(data, selectedFields) {
        if (!data || data.length === 0) {
            return '';
        }

        const resolved = Array.isArray(data.columns) && data.columns.length ? data.columns : null;
        const fields = resolved || (Array.isArray(selectedFields) ? selectedFields : []);
        const headers = fields.join(',');

        // Build rows
        const rows = data.map((row) => {
            return fields
                .map((field) => {
                    let value = row[field];
                    // Handle null/undefined
                    // Neutralize formula injection + RFC-4180 quote every cell.
                    return csvCell(value);
                })
                .join(',');
        });

        return [headers, ...rows].join('\n');
    }

    /**
     * Export data to JSON
     */
    exportToJSON(data) {
        return JSON.stringify(data, null, 2);
    }

    /**
     * Wrap a CSV body so French Excel opens it correctly, wherever it is
     * delivered — interactive download OR scheduled e-mail attachment.
     *   * UTF-8 BOM  → "Lambért"/"Lindqvïst" render instead of "KaborÃ©".
     *   * `sep=,`    → fr-FR Excel defaults its list separator to ';' and would
     *                  otherwise drop every row into a single column.
     * Single implementation on purpose: the scheduler used to attach the raw
     * body, so the same report was correct when downloaded and mojibake when
     * e-mailed.
     */
    excelCsv(body) {
        return '﻿' + 'sep=,\r\n' + (body == null ? '' : String(body));
    }

    /**
     * Reference lists behind the filter dropdowns.
     *
     * CLEARANCE: the org-placement lists (sites / departments / services /
     * roles) are scoped to the caller's span through the SAME resolver every
     * other query uses (`utils/rbacScope.scopedEmployeeIds` → RBACService for
     * admins, EmployeeModel.findGovernedIds for managers/supervisors).
     * No data ever leaked — a name filter is AND-ed with the RBAC predicate —
     * but a manager was offered sites and departments outside their span, and
     * ticking one silently produced an empty section, which reads as "the
     * report is broken". A list now only offers values that can actually return
     * rows for this caller. Super admin stays unrestricted (ids === null).
     *
     * NOT scoped, deliberately: `domains` and `skills` are the department-
     * designed FRAMEWORK catalogue, not an org placement. Filtering them by who
     * happens to sit in a span would hide skills from the ask — forbidden — and
     * a skill is meaningful to a manager whether or not one of their people is
     * currently mapped to it.
     *
     * Response shape is unchanged: [{ id, name }].
     */
    async getReferenceData(source, user) {
        // `user` is REQUIRED. No unscoped fallback: a missing/unknown identity
        // resolves to an empty scope (scopedEmployeeIds returns []), which fails
        // CLOSED below — never to the whole org.
        const ids = await scopedEmployeeIds(user);
        const params = [];
        // Employees the caller may see. '' = unrestricted; ' AND 1 = 0' = fail
        // CLOSED (an empty scope must never fall back to the whole org).
        let inScope = '';
        if (ids !== null) {
            if (!ids.length) return [];
            inScope = ' AND emp.id = ANY(?)';
        }
        const occupied = (col) => {
            if (ids === null) return '';
            params.push(ids);
            return ` AND id IN (SELECT emp.${col} FROM employees emp WHERE emp.${col} IS NOT NULL${inScope})`;
        };
        // Departments/services are deduped by NAME (the same name legitimately
        // repeats under many sites and the filters match on name), so their
        // scope test is by name too.
        const occupiedByName = (table, col) => {
            if (ids === null) return '';
            params.push(ids);
            return ` AND name IN (SELECT t.name FROM ${table} t JOIN employees emp ON emp.${col} = t.id WHERE 1 = 1${inScope})`;
        };

        let query = '';
        switch (source) {
            case 'sites':
                query = `SELECT id, name FROM sites WHERE isActive = 1${occupied('siteId')} ORDER BY name`;
                break;
            case 'departments':
                // Filters match employees by department NAME, and the same name exists
                // under many sites — list each name once (was one row per site).
                query = `SELECT MIN(id) AS id, name FROM departments WHERE isActive = 1${occupiedByName('departments', 'departmentId')} GROUP BY name ORDER BY name`;
                break;
            case 'services':
                query = `SELECT MIN(id) AS id, name FROM services WHERE isActive = 1${occupiedByName('services', 'serviceId')} GROUP BY name ORDER BY name`;
                break;
            case 'roles':
                query = `SELECT id, name FROM roles WHERE isActive = 1${occupied('roleId')} ORDER BY name`;
                break;
            case 'domains':
                query = 'SELECT id, name FROM domains WHERE isActive = 1 ORDER BY name';
                break;
            case 'skills':
                query = 'SELECT id, name FROM skills WHERE isActive = 1 ORDER BY name';
                break;
            default:
                return [];
        }

        const results = await db.all(query, params);
        return results;
    }
}

module.exports = new ReportBuilderService();
