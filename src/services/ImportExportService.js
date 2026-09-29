const SiteModel = require('../models/SiteModel');
const DepartmentModel = require('../models/DepartmentModel');
const ServiceModel = require('../models/ServiceModel');
const DomainModel = require('../models/DomainModel');
const SkillModel = require('../models/SkillModel');
const EmployeeModel = require('../models/EmployeeModel');
const AdminModel = require('../models/AdminModel');
const AdminScopeModel = require('../models/AdminScopeModel');
const RoleModel = require('../models/RoleModel');
const bcrypt = require('bcrypt');
const db = require('../config/database');

class ImportExportService {
    /**
     * Run ONE import row inside a SAVEPOINT and report its failure into `errors`.
     *
     * Every importer here wraps the whole file in db.runTransaction and used to
     * catch-and-continue per row. PostgreSQL aborts the WHOLE transaction on the
     * first statement error: every later statement fails with "current transaction
     * is aborted", and the final COMMIT silently performs a ROLLBACK without
     * raising. Measured on a clone with sites A/PC1, B/PC1, C/PC3: the API answered
     * `{ sites: { created: 1, errors: [B duplicate, C "transaction is aborted"] } }`
     * while NOTHING had landed — not even A, whose "created" had been counted.
     *
     * A savepoint per row contains the bad row alone; the counters then describe
     * rows that will actually commit. An uncaught error still propagates out of
     * runTransaction — the caller gets an exception, never a success payload
     * describing a transaction that rolled back.
     */
    async _row(errors, label, fn) {
        try {
            return await db.runInSavepoint(fn);
        } catch (error) {
            errors.push(`${label}: ${error.message}`);
            return undefined;
        }
    }

    // Export Organization (Sites, Departments, Services)
    async exportOrganization() {
        const sites = await SiteModel.findAll({ isActive: 1 }, 'name ASC');
        const departments = await DepartmentModel.findWithSite();
        const services = await ServiceModel.findWithDepartment();

        return {
            sites: sites.map((s) => ({
                name: s.name,
                code: s.code || '',
                description: s.description || '',
            })),
            departments: departments.map((d) => ({
                siteName: d.siteName,
                name: d.name,
                code: d.code || '',
                description: d.description || '',
            })),
            services: services.map((s) => ({
                siteName: s.siteName,
                departmentName: s.departmentName,
                name: s.name,
                code: s.code || '',
                description: s.description || '',
            })),
        };
    }

    // Export Domains & Skills
    async exportDomainsSkills() {
        const domains = await DomainModel.findAll({ isActive: 1 }, 'name ASC');
        const skills = await SkillModel.findWithDomain();
        // Sub-domains (the layer between domain and skill) so the framework
        // structure round-trips through the file.
        const subDomains = await db.all(
            `SELECT sd.name, d.name AS domainName, sd.definition, sd.position
             FROM subDomains sd JOIN domains d ON d.id = sd.domainId
             WHERE sd.isActive = 1 AND d.isActive = 1 ORDER BY d.name, sd.position, sd.name`
        );

        return {
            domains: domains.map((d) => ({
                name: d.name,
                description: d.description || '',
            })),
            subDomains: subDomains.map((sd) => ({
                domainName: sd.domainName,
                name: sd.name,
                definition: sd.definition || '',
            })),
            skills: skills.map((s) => ({
                domainName: s.domainName,
                subDomainName: s.subDomainName || '',
                name: s.name,
                category: s.category || '',
                description: s.description || '',
            })),
        };
    }

    // Export Employees
    async exportEmployees(admin = null) {
        let employees;
        if (admin && admin.role === 'superadmin') {
            employees = await EmployeeModel.findWithOrganization();
        } else {
            const RBACService = require('./RBACService');
            employees = await RBACService.getFilteredEmployees(admin, { includeInactive: true }); // export: leavers included, as the superadmin branch
        }

        return employees.map((emp) => ({
            employeeNumber: emp.employeeNumber,
            firstName: emp.firstName,
            lastName: emp.lastName,
            email: emp.email || '',
            phone: emp.phone || '',
            siteName: emp.siteName,
            departmentName: emp.departmentName,
            serviceName: emp.serviceName,
            roleName: emp.roleName,
        }));
    }

    // Export Local Admins
    async exportLocalAdmins() {
        const admins = await AdminModel.findAll(
            { role: 'localadmin', isActive: 1 },
            'username ASC'
        );
        const result = [];

        for (const admin of admins) {
            const scopes = await AdminScopeModel.findByAdminId(admin.id);
            // admin_scopes supports FIVE types (region, country, site, department,
            // service). Serialising only three silently dropped every region- and
            // country-scoped grant, so a country admin re-imported elsewhere had NO
            // scope at all. The downstream behaviour fails CLOSED (the `-1` sentinel
            // in middleware/rbac), so they simply saw nothing, with no message —
            // the worst shape for a support call. UnifiedJsonService already
            // resolves all five; this exporter knew three.
            const scopeData = scopes.map((s) => ({
                scopeType: s.scopeType,
                regionId: s.regionId,
                countryId: s.countryId,
                siteId: s.siteId,
                departmentId: s.departmentId,
                serviceId: s.serviceId,
            }));

            result.push({
                username: admin.username,
                email: admin.email,
                scopes: scopeData,
            });
        }

        return result;
    }

    // Import Organization
    async importOrganization(data, adminId) {
        // Wrap the full write set in one transaction so a mid-import failure rolls
        // back all parents+children (no partial org tree left behind).
        return await db.runTransaction(async () => {
            const results = {
                sites: { created: 0, errors: [] },
                departments: { created: 0, errors: [] },
                services: { created: 0, errors: [] },
            };

            // Import Sites — one savepoint per row (see _row).
            if (data.sites && Array.isArray(data.sites)) {
                for (const siteData of data.sites) {
                    await this._row(results.sites.errors, `Site "${siteData.name}"`, async () => {
                        const existing = await SiteModel.findOne({ name: siteData.name });
                        if (existing) return;
                        await SiteModel.create({
                            name: siteData.name.trim(),
                            code: siteData.code?.trim() || null,
                            description: siteData.description?.trim() || null,
                            isActive: 1,
                        });
                        results.sites.created++;
                    });
                }
            }

            // Import Departments
            if (data.departments && Array.isArray(data.departments)) {
                for (const deptData of data.departments) {
                    await this._row(
                        results.departments.errors,
                        `Department "${deptData.name}"`,
                        async () => {
                            const site = await SiteModel.findOne({ name: deptData.siteName });
                            if (!site) {
                                results.departments.errors.push(
                                    `Department "${deptData.name}": Site "${deptData.siteName}" not found`
                                );
                                return;
                            }

                            const existing = await db.get(
                                'SELECT * FROM departments WHERE siteId = ? AND name = ?',
                                [site.id, deptData.name]
                            );
                            if (existing) return;
                            await DepartmentModel.create({
                                siteId: site.id,
                                name: deptData.name.trim(),
                                code: deptData.code?.trim() || null,
                                description: deptData.description?.trim() || null,
                                isActive: 1,
                            });
                            results.departments.created++;
                        }
                    );
                }
            }

            // Import Services
            if (data.services && Array.isArray(data.services)) {
                for (const serviceData of data.services) {
                    await this._row(
                        results.services.errors,
                        `Service "${serviceData.name}"`,
                        async () => {
                            const site = await SiteModel.findOne({ name: serviceData.siteName });
                            if (!site) {
                                results.services.errors.push(
                                    `Service "${serviceData.name}": Site "${serviceData.siteName}" not found`
                                );
                                return;
                            }

                            const department = await db.get(
                                `SELECT d.* FROM departments d
                         INNER JOIN sites s ON d.siteId = s.id
                         WHERE s.name = ? AND d.name = ?`,
                                [serviceData.siteName, serviceData.departmentName]
                            );
                            if (!department) {
                                results.services.errors.push(
                                    `Service "${serviceData.name}": Department "${serviceData.departmentName}" not found`
                                );
                                return;
                            }

                            const existing = await db.get(
                                'SELECT * FROM services WHERE departmentId = ? AND name = ?',
                                [department.id, serviceData.name]
                            );
                            if (existing) return;
                            await ServiceModel.create({
                                departmentId: department.id,
                                name: serviceData.name.trim(),
                                code: serviceData.code?.trim() || null,
                                description: serviceData.description?.trim() || null,
                                isActive: 1,
                            });
                            results.services.created++;
                        }
                    );
                }
            }

            return results;
        });
    }

    // Import Domains & Skills
    async importDomainsSkills(data, adminId) {
        // One transaction around the file, one savepoint per row: this importer had
        // NO transaction, so a crash mid-file left the first rows committed and the
        // rest absent (measured: domains [LOTD-DOM-1] landed after a mid-file throw).
        return await db.runTransaction(async () => {
            const results = {
                domains: { created: 0, skipped: 0, errors: [] },
                subDomains: { created: 0, skipped: 0, errors: [] },
                skills: { created: 0, skipped: 0, errors: [] },
            };

            // Import Domains
            if (data.domains && Array.isArray(data.domains)) {
                for (const domainData of data.domains) {
                    await this._row(
                        results.domains.errors,
                        `Domain "${domainData.name}"`,
                        async () => {
                            const existing = await DomainModel.findOne({ name: domainData.name });
                            if (!existing) {
                                await DomainModel.create({
                                    name: domainData.name.trim(),
                                    description: domainData.description?.trim() || null,
                                    isActive: 1,
                                });
                                results.domains.created++;
                            } else {
                                results.domains.skipped++;
                            }
                        }
                    );
                }
            }

            // Import Sub-Domains (between domains and skills)
            if (data.subDomains && Array.isArray(data.subDomains)) {
                let pos = 0;
                for (const sd of data.subDomains) {
                    await this._row(
                        results.subDomains.errors,
                        `Sub-domain "${sd.name}"`,
                        async () => {
                            const domain = await DomainModel.findOne({ name: sd.domainName });
                            if (!domain) {
                                results.subDomains.errors.push(
                                    `Sub-domain "${sd.name}": Domain "${sd.domainName}" not found`
                                );
                                return;
                            }
                            pos++;
                            const existing = await db.get(
                                'SELECT id FROM subDomains WHERE domainId = ? AND name = ?',
                                [domain.id, sd.name]
                            );
                            if (!existing) {
                                await db.run(
                                    'INSERT INTO subDomains (domainId, name, definition, position, isActive) VALUES (?, ?, ?, ?, true)',
                                    [domain.id, sd.name.trim(), sd.definition?.trim() || null, pos]
                                );
                                results.subDomains.created++;
                            } else {
                                results.subDomains.skipped++;
                            }
                        }
                    );
                }
            }

            // Import Skills (with optional sub-domain + category)
            if (data.skills && Array.isArray(data.skills)) {
                for (const skillData of data.skills) {
                    await this._row(
                        results.skills.errors,
                        `Skill "${skillData.name}"`,
                        async () => {
                            const domain = await DomainModel.findOne({
                                name: skillData.domainName,
                            });
                            if (!domain) {
                                results.skills.errors.push(
                                    `Skill "${skillData.name}": Domain "${skillData.domainName}" not found`
                                );
                                return;
                            }

                            // Resolve the sub-domain within this domain (create if named but absent).
                            let subDomainId = null;
                            if (skillData.subDomainName) {
                                let sub = await db.get(
                                    'SELECT id FROM subDomains WHERE domainId = ? AND LOWER(name) = LOWER(?)',
                                    [domain.id, skillData.subDomainName]
                                );
                                if (!sub) {
                                    await db.run(
                                        'INSERT INTO subDomains (domainId, name, position, isActive) VALUES (?, ?, 999, true)',
                                        [domain.id, skillData.subDomainName.trim()]
                                    );
                                    sub = await db.get(
                                        'SELECT id FROM subDomains WHERE domainId = ? AND LOWER(name) = LOWER(?)',
                                        [domain.id, skillData.subDomainName]
                                    );
                                }
                                subDomainId = sub ? sub.id : null;
                            }

                            // Match the live uniqueness key (sub_domain_id, lower(name)); fall back
                            // to (domain, name) when the skill has no sub-domain. A name reused across
                            // two sub-domains of the same domain resolves to two distinct skills.
                            const existing =
                                subDomainId != null
                                    ? await db.get(
                                          'SELECT id, subDomainId FROM skills WHERE subDomainId = ? AND LOWER(name) = LOWER(?)',
                                          [subDomainId, skillData.name]
                                      )
                                    : await db.get(
                                          'SELECT id, subDomainId FROM skills WHERE domainId = ? AND LOWER(name) = LOWER(?) AND subDomainId IS NULL',
                                          [domain.id, skillData.name]
                                      );
                            if (!existing) {
                                await SkillModel.create({
                                    domainId: domain.id,
                                    subDomainId: subDomainId,
                                    name: skillData.name.trim(),
                                    category: skillData.category?.trim() || null,
                                    description: skillData.description?.trim() || null,
                                    isActive: 1,
                                });
                                results.skills.created++;
                            } else {
                                // Backfill sub-domain on an existing skill that lacks one.
                                if (subDomainId && existing.subDomainId == null) {
                                    await db.run('UPDATE skills SET subDomainId = ? WHERE id = ?', [
                                        subDomainId,
                                        existing.id,
                                    ]);
                                }
                                results.skills.skipped++;
                            }
                        }
                    );
                }
            }

            return results;
        });
    }

    // Import Employees
    async importEmployees(data, actor) {
        const results = {
            created: 0,
            errors: [],
        };

        if (!Array.isArray(data)) {
            return { ...results, errors: ['Invalid data format'] };
        }

        // Per-row scope enforcement: a delegated (non-SuperAdmin) admin may only
        // provision people into their assigned site/department/service. `actor` is
        // the acting user; a bare id / null (internal callers) is treated as
        // unrestricted for back-compat.
        const RBACService = require('./RBACService');
        const actorUser = actor && typeof actor === 'object' ? actor : null;
        const enforceScope = !!actorUser && !RBACService.isSuperAdmin(actorUser);

        // Wrap all employee creates in one transaction so a mid-import failure rolls
        // back every created employee (no partial provisioning).
        return await db.runTransaction(async () => {
            for (const empData of data) {
                await this._row(
                    results.errors,
                    `Employee "${(empData && empData.employeeNumber) || 'Unknown'}"`,
                    async () => {
                        // Validate required fields
                        if (!empData.employeeNumber || !empData.firstName || !empData.lastName) {
                            results.errors.push(
                                `Row missing required fields: ${JSON.stringify(empData)}`
                            );
                            return;
                        }

                        // Already-present employees are a clean SKIP, not an error — so
                        // re-importing an export is a quiet no-op rather than a wall of
                        // "already exists" messages. (This importer only CREATES.)
                        const existing = await EmployeeModel.findByEmployeeNumber(
                            empData.employeeNumber
                        );
                        if (existing) {
                            results.skipped = (results.skipped || 0) + 1;
                            return;
                        }

                        // Find site, department, service, role
                        const site = await SiteModel.findOne({ name: empData.siteName });
                        if (!site) {
                            results.errors.push(
                                `Employee "${empData.employeeNumber}": Site "${empData.siteName}" not found`
                            );
                            return;
                        }

                        const department = await db.get(
                            `SELECT d.* FROM departments d
                     INNER JOIN sites s ON d.siteId = s.id
                     WHERE s.name = ? AND d.name = ?`,
                            [empData.siteName, empData.departmentName]
                        );
                        if (!department) {
                            results.errors.push(
                                `Employee "${empData.employeeNumber}": Department "${empData.departmentName}" not found`
                            );
                            return;
                        }

                        const service = await db.get(
                            `SELECT sv.* FROM services sv
                     INNER JOIN departments d ON sv.departmentId = d.id
                     INNER JOIN sites s ON d.siteId = s.id
                     WHERE s.name = ? AND d.name = ? AND sv.name = ?`,
                            [empData.siteName, empData.departmentName, empData.serviceName]
                        );
                        if (!service) {
                            results.errors.push(
                                `Employee "${empData.employeeNumber}": Service "${empData.serviceName}" not found`
                            );
                            return;
                        }

                        // Reject rows that would provision someone outside the importer's scope.
                        if (enforceScope) {
                            const inScope =
                                (await RBACService.canAccessSite(actorUser, site.id)) &&
                                (await RBACService.canAccessDepartment(actorUser, department.id)) &&
                                (await RBACService.canAccessService(actorUser, service.id));
                            if (!inScope) {
                                results.errors.push(
                                    `Employee "${empData.employeeNumber}": site/department/service is outside your assigned scope — skipped`
                                );
                                return;
                            }
                        }

                        const role = await RoleModel.findOne({ name: empData.roleName });
                        if (!role) {
                            results.errors.push(
                                `Employee "${empData.employeeNumber}": Role "${empData.roleName}" not found`
                            );
                            return;
                        }

                        await EmployeeModel.create({
                            employeeNumber: empData.employeeNumber.trim(),
                            firstName: empData.firstName.trim(),
                            lastName: empData.lastName.trim(),
                            email: empData.email?.trim() || null,
                            phone: empData.phone?.trim() || null,
                            siteId: site.id,
                            departmentId: department.id,
                            serviceId: service.id,
                            roleId: role.id,
                            isActive: 1,
                        });

                        results.created++;
                    }
                );
            }

            return results;
        });
    }

    // Import Local Admins
    async importLocalAdmins(data, adminId) {
        const results = {
            created: 0,
            errors: [],
        };

        if (!Array.isArray(data)) {
            return { ...results, errors: ['Invalid data format'] };
        }

        // Wrap admin + scope creates in one transaction so a failure can't leave an
        // admin with a partial/empty scope set (which would mean wrong access).
        return await db.runTransaction(async () => {
            for (const adminData of data) {
                await this._row(
                    results.errors,
                    `Admin "${(adminData && adminData.username) || 'Unknown'}"`,
                    async () => {
                        // Only USERNAME is required — admins.email is nullable, and the
                        // export emits null email for admins created without one (so
                        // requiring email here rejected every exported local admin).
                        if (!adminData.username || !String(adminData.username).trim()) {
                            results.errors.push(
                                `Admin missing required field: username — ${JSON.stringify(adminData)}`
                            );
                            return;
                        }

                        // Already-present admins are a clean SKIP (re-import is a no-op, not
                        // a wall of "already exists" errors).
                        const existing = await AdminModel.findByUsername(adminData.username);
                        if (existing) {
                            results.skipped = (results.skipped || 0) + 1;
                            return;
                        }

                        // No shared default password: the account gets an unguessable
                        // random secret that nobody knows and a forced change, so it is
                        // unusable until credentials are issued from the accounts
                        // console (or SSO links it). A constant here would have been a
                        // working login for every imported admin.
                        const unusable = require('crypto').randomBytes(32).toString('base64url');
                        const passwordHash = await bcrypt.hash(unusable, 10);

                        const admin = await AdminModel.create({
                            username: adminData.username.trim(),
                            email: adminData.email ? String(adminData.email).trim() : null,
                            passwordHash,
                            role: 'localadmin',
                            isActive: 1,
                            forcePasswordChange: true,
                        });

                        // Add scopes if provided — each in its own savepoint so a bad scope
                        // row cannot poison the admin row (or the rest of the file).
                        if (adminData.scopes && Array.isArray(adminData.scopes)) {
                            for (const scopeData of adminData.scopes) {
                                await this._row(
                                    results.errors,
                                    `Admin "${adminData.username}" scope error`,
                                    async () => {
                                        await AdminScopeModel.create({
                                            adminId: admin.id,
                                            scopeType: scopeData.scopeType,
                                            siteId: scopeData.siteId || null,
                                            departmentId: scopeData.departmentId || null,
                                            serviceId: scopeData.serviceId || null,
                                        });
                                    }
                                );
                            }
                        }

                        results.created++;
                    }
                );
            }

            return results;
        });
    }

    // Import Complete Skill Framework (Domains, Skills, Roles, Requirements)
    async importSkillFramework(data, adminId) {
        // Wrap the full framework import (domains → skills → roles → requirements)
        // in one transaction so a mid-import failure rolls back all parents+children.
        return await db.runTransaction(async () => {
            const results = {
                domains: { created: 0, skipped: 0, errors: [] },
                skills: { created: 0, skipped: 0, errors: [] },
                roles: { created: 0, skipped: 0, errors: [] },
                requirements: { created: 0, skipped: 0, errors: [] },
            };

            // Step 1: Import Domains (skip existing, don't overwrite)
            if (data.domains && Array.isArray(data.domains)) {
                for (const domainData of data.domains) {
                    await this._row(
                        results.domains.errors,
                        `Domain "${domainData.name}"`,
                        async () => {
                            const existing = await DomainModel.findOne({ name: domainData.name });
                            if (!existing) {
                                await DomainModel.create({
                                    name: domainData.name.trim(),
                                    description: domainData.description?.trim() || null,
                                    isActive: 1,
                                });
                                results.domains.created++;
                            } else {
                                results.domains.skipped++;
                            }
                        }
                    );
                }
            }

            // Step 2: Import Skills
            if (data.skills && Array.isArray(data.skills)) {
                for (const skillData of data.skills) {
                    await this._row(
                        results.skills.errors,
                        `Skill "${skillData.name}"`,
                        async () => {
                            const domain = await DomainModel.findOne({
                                name: skillData.domainName,
                            });
                            if (!domain) {
                                results.skills.errors.push(
                                    `Skill "${skillData.name}": Domain "${skillData.domainName}" not found`
                                );
                                return;
                            }

                            const existing = await db.get(
                                'SELECT * FROM skills WHERE domainId = ? AND name = ?',
                                [domain.id, skillData.name]
                            );
                            if (!existing) {
                                await SkillModel.create({
                                    domainId: domain.id,
                                    name: skillData.name.trim(),
                                    description: skillData.description?.trim() || null,
                                    isActive: 1,
                                });
                                results.skills.created++;
                            } else {
                                results.skills.skipped++;
                            }
                        }
                    );
                }
            }

            // Step 3: Import Roles
            if (data.roles && Array.isArray(data.roles)) {
                for (const roleData of data.roles) {
                    await this._row(results.roles.errors, `Role "${roleData.name}"`, async () => {
                        const existing = await RoleModel.findOne({ name: roleData.name });
                        if (!existing) {
                            await RoleModel.create({
                                name: roleData.name.trim(),
                                description: roleData.description?.trim() || null,
                                isActive: 1,
                            });
                            results.roles.created++;
                        } else {
                            results.roles.skipped++;
                        }
                    });
                }
            }

            // Step 4: Import Role Requirements
            if (data.requirements && Array.isArray(data.requirements)) {
                for (const reqData of data.requirements) {
                    await this._row(
                        results.requirements.errors,
                        `Requirement "${reqData.roleName}" -> "${reqData.skillName}"`,
                        async () => {
                            // Find role
                            const role = await RoleModel.findOne({ name: reqData.roleName });
                            if (!role) {
                                results.requirements.errors.push(
                                    `Requirement: Role "${reqData.roleName}" not found`
                                );
                                return;
                            }

                            // Find skill
                            const skill = await db.get(
                                `SELECT s.* FROM skills s
                         INNER JOIN domains d ON s.domainId = d.id
                         WHERE s.name = ?`,
                                [reqData.skillName]
                            );
                            if (!skill) {
                                results.requirements.errors.push(
                                    `Requirement: Skill "${reqData.skillName}" not found`
                                );
                                return;
                            }

                            // Check if requirement already exists
                            const existing = await db.get(
                                'SELECT * FROM roleSkillRequirements WHERE roleId = ? AND skillId = ?',
                                [role.id, skill.id]
                            );

                            if (!existing) {
                                // Parse required level
                                const requiredLevel = parseInt(reqData.requiredLevel) || 0;
                                if (requiredLevel < 0 || requiredLevel > 4) {
                                    results.requirements.errors.push(
                                        `Requirement for "${reqData.roleName}" -> "${reqData.skillName}": Invalid level ${reqData.requiredLevel}`
                                    );
                                    return;
                                }

                                // Parse isCritical
                                // Same vocabulary as SkillMatrixWorkbookService.parseBoolish:
                                // this is a French-first product and the templates carry
                                // English headers, so "Oui"/"VRAI" must count as yes.
                                const _crit = String(reqData.isCritical ?? '')
                                    .toLowerCase()
                                    .normalize('NFD')
                                    .replace(/[̀-ͯ]/g, '')
                                    .trim();
                                const isCritical =
                                    reqData.isCritical === true ||
                                    [
                                        'yes',
                                        'y',
                                        'true',
                                        '1',
                                        'critical',
                                        'oui',
                                        'o',
                                        'vrai',
                                        'critique',
                                        'x',
                                    ].includes(_crit);

                                await db.run(
                                    `INSERT INTO roleSkillRequirements (roleId, skillId, requiredLevel, isCritical, createdAt)
                             VALUES (?, ?, ?, ?, datetime('now'))`,
                                    [role.id, skill.id, requiredLevel, isCritical]
                                );
                                results.requirements.created++;
                            } else {
                                results.requirements.skipped++;
                            }
                        }
                    );
                }
            }

            return results;
        });
    }

    // Human-readable export headers → canonical keys the importers read. Lets a
    // flat CSV export (e.g. employees: "Employee Number", "Site", "Role") re-import
    // cleanly — before, parseCSV keyed rows by the literal header and importEmployees
    // read camelCase (employeeNumber/siteName/roleName), so EVERY row failed.
    static get CSV_HEADER_ALIASES() {
        return {
            'employee number': 'employeeNumber',
            'employee #': 'employeeNumber',
            'employee id': 'employeeNumber',
            'first name': 'firstName',
            'last name': 'lastName',
            email: 'email',
            phone: 'phone',
            site: 'siteName',
            'site name': 'siteName',
            department: 'departmentName',
            'department name': 'departmentName',
            service: 'serviceName',
            'service name': 'serviceName',
            role: 'roleName',
            'role name': 'roleName',
            name: 'name',
            code: 'code',
            description: 'description',
            domain: 'domainName',
            'domain name': 'domainName',
        };
    }

    // Parse CSV to JSON
    parseCSV(csvText) {
        const lines = csvText.split('\n').filter((line) => line.trim());
        if (lines.length < 2) return [];

        const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
        const aliases = ImportExportService.CSV_HEADER_ALIASES;
        const rows = [];

        for (let i = 1; i < lines.length; i++) {
            const values = this.parseCSVLine(lines[i]);
            if (values.length === headers.length) {
                const row = {};
                headers.forEach((header, index) => {
                    const v = values[index]?.trim() || '';
                    row[header] = v; // keep the literal header key (back-compat)
                    const canonical = aliases[header.toLowerCase()];
                    if (canonical && row[canonical] === undefined) row[canonical] = v; // + canonical key the importers read
                });
                rows.push(row);
            }
        }

        return rows;
    }

    parseCSVLine(line) {
        const values = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                values.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current);

        return values.map((v) => v.replace(/^"|"$/g, ''));
    }
    // Import Roles Only
    async importRoles(data, adminId) {
        const results = {
            created: 0,
            skipped: 0,
            errors: [],
        };

        // Handle both simple array of objects (JSON/Excel) and nested structure
        const rolesData = Array.isArray(data) ? data : data.roles || [];

        // One transaction around the file, one savepoint per row (see _row): this
        // importer had NO transaction, so a crash mid-file committed the first rows
        // and lost the rest (measured: roles [LOTD-ROLE-1] landed after a mid-file throw).
        return await db.runTransaction(async () => {
            for (const roleItem of rolesData) {
                await this._row(results.errors, 'Role error', async () => {
                    // Determine name, description and (optional) role family based on source format
                    let name, description, roleFamily;

                    // If it's from our Excel template or similar structure
                    if (roleItem.name) {
                        name = roleItem.name;
                        description = roleItem.description;
                        roleFamily = roleItem.roleFamily;
                    } else if (roleItem['Role Name']) {
                        name = roleItem['Role Name'];
                        description = roleItem['Description'];
                        roleFamily = roleItem['Role Family'];
                    } else {
                        // Try first columns if raw values
                        const values = Object.values(roleItem);
                        if (values.length > 0) name = values[0];
                        if (values.length > 1) description = values[1];
                        if (values.length > 2) roleFamily = values[2];
                    }

                    if (!name || !name.toString().trim()) {
                        results.errors.push(`Row missing role name: ${JSON.stringify(roleItem)}`);
                        return;
                    }

                    const finalName = name.toString().trim();
                    const finalDesc = description ? description.toString().trim() : null;

                    // Resolve (or create) the named role family so role_family_id round-trips.
                    let roleFamilyId = null;
                    const famName = roleFamily && roleFamily.toString().trim();
                    if (famName) {
                        let fam = await db.get(
                            'SELECT id FROM role_families WHERE LOWER(name) = LOWER(?)',
                            [famName]
                        );
                        if (!fam) {
                            await db.run(
                                "INSERT INTO role_families (name, origin, isActive) VALUES (?, 'standard', true)",
                                [famName]
                            );
                            fam = await db.get(
                                'SELECT id FROM role_families WHERE LOWER(name) = LOWER(?)',
                                [famName]
                            );
                        }
                        roleFamilyId = fam ? fam.id : null;
                    }

                    const existing = await RoleModel.findOne({ name: finalName });
                    if (!existing) {
                        await RoleModel.create({
                            name: finalName,
                            description: finalDesc,
                            isActive: 1,
                        });
                        // Assign the family via raw snake_case UPDATE (compat layer doesn't map roleFamilyId).
                        if (roleFamilyId) {
                            await db.run('UPDATE roles SET role_family_id = ? WHERE name = ?', [
                                roleFamilyId,
                                finalName,
                            ]);
                        }
                        results.created++;
                    } else {
                        if (
                            roleFamilyId &&
                            existing.roleFamilyId == null &&
                            existing.role_family_id == null
                        ) {
                            await db.run('UPDATE roles SET role_family_id = ? WHERE id = ?', [
                                roleFamilyId,
                                existing.id,
                            ]);
                        }
                        results.skipped++;
                    }
                });
            }

            return results;
        });
    }
}

module.exports = new ImportExportService();
