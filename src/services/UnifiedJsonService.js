const PRODUCT = require('../config/product');
const db = require('../config/database');
const bcrypt = require('bcrypt');
const { generatePassword, baseUsername, uniqueUsername } = require('../utils/credentialGenerator');
// assessed_by is an admins.id: exported as a stable label, resolved back on import.
const { buildAdminMaps, labelForAssessor, resolveAssessorId } = require('../utils/assessorRef');

/**
 * The active/inactive flag a file row carries, or `dflt` when the key is absent
 * (older exports carried none and every row was re-created ACTIVE).
 */
function activeOf(o, dflt = true) {
    if (!o || typeof o !== 'object' || !('isActive' in o)) return dflt;
    return !(
        o.isActive === false ||
        o.isActive === 0 ||
        o.isActive === 'false' ||
        o.isActive === '0'
    );
}

/**
 * The skill-merge marker a file row carries (`skills.is_duplicate`: a legacy
 * item judged to overlap a standard one, soft-retired by the merge). Absent
 * key -> `dflt` (older exports carried none; the column defaults to false).
 */
function duplicateOf(o, dflt = false) {
    if (!o || typeof o !== 'object' || !('isDuplicate' in o)) return dflt;
    return (
        o.isDuplicate === true ||
        o.isDuplicate === 1 ||
        o.isDuplicate === 'true' ||
        o.isDuplicate === '1'
    );
}

/**
 * Full-system JSON export/import — the super-admin "provision a whole
 * organisation" path. Covers geography, the skills framework, the org
 * structure, roles & requirements, employees (with generated logins on
 * import), admin accounts & scopes, and app settings.
 *
 * Import is MERGE / find-or-create (never truncates) and backward-compatible
 * with the older shape (skills/services as string[], requirements as a map).
 */
class UnifiedJsonService {
    async exportSystemToJson() {
        const result = {
            metadata: {
                version: '2.1',
                exportedAt: new Date().toISOString(),
                source: PRODUCT.name,
                // Says what this file is — and is not. It is the provisioning export;
                // the append-only audit trail, the assessment history and the talent
                // records are only in a database snapshot / pg_dump.
                scope:
                    'provisioning: geography, framework (domains, sub-domains, skills incl. inactive rows with isActive and the skill-merge isDuplicate marker), ' +
                    'organization, role families, roles + requirements, employees + assessments (with assessedBy/assessedAt/notes), ' +
                    'admins + scopes, app settings (secrets omitted). NOT a full backup: system_logs, assessment_history, ' +
                    'review_signatures and talent records are not carried — use a database snapshot / pg_dump for those.',
            },
            geography: { regions: [], countries: [] },
            framework: { domains: [] },
            organization: { sites: [] },
            roleFamilies: [],
            roles: [],
            employees: [],
            admins: [],
            appSettings: [],
        };

        // 0. Geography (regions -> countries)
        const regions = await db.all('SELECT id, name, code FROM regions ORDER BY name');
        result.geography.regions = regions.map((r) => ({ name: r.name, code: r.code || null }));
        const countries = await db.all(
            'SELECT c.id, c.name, c.code, r.name AS regionName FROM countries c LEFT JOIN regions r ON r.id = c.region_id ORDER BY c.name'
        );
        result.geography.countries = countries.map((c) => ({
            name: c.name,
            code: c.code || null,
            region: c.regionName || null,
        }));

        // 1. Framework (domains -> sub-domains -> skills) — bulk fetch + group (no N+1).
        // Each skill carries its sub-domain so the full framework structure
        // round-trips (skills.sub_domain_id is otherwise lost).
        //
        // EVERY row, with its isActive flag — as the employees section already did.
        // This export used to be active-only (roles 50 -> 41, skills 1 142 -> 1 126,
        // the 49 legacy domains dropped) while being named a full backup. The import
        // honours the flag, so a retired twin comes back retired and a legacy domain
        // comes back inactive instead of being resurrected or lost.
        const domains = await db.all(
            'SELECT id, name, description, isActive FROM domains ORDER BY name'
        );
        const subDomains = await db.all(
            'SELECT id, domainId, name, definition, position, isActive FROM sub_domains ORDER BY position, name'
        );
        const sdById = new Map(subDomains.map((sd) => [String(sd.id), sd.name]));
        const subsByDomain = new Map();
        for (const sd of subDomains) {
            const k = String(sd.domainId);
            if (!subsByDomain.has(k)) subsByDomain.set(k, []);
            subsByDomain.get(k).push({
                name: sd.name,
                definition: sd.definition || null,
                position: sd.position,
                isActive: !!sd.isActive,
            });
        }
        // Retired/de-duplicated twins share (sub_domain_id, lower(name)) with a live
        // skill; uq_skill_subdomain_name is a partial index WHERE is_active, so an
        // inactive twin re-imported AS inactive never collides.
        //
        // `is_duplicate` is the skill-merge marker (a retired twin judged to overlap
        // a standard item). It is carried so a restored instance keeps the marking
        // instead of reading every twin back as a plain retired skill.
        const allSkills = await db.all(
            'SELECT domainId, subDomainId, name, category, description, strategicLink, is_duplicate AS isDuplicate, isActive FROM skills ORDER BY name'
        );
        const skillsByDomain = new Map();
        for (const s of allSkills) {
            const k = String(s.domainId);
            if (!skillsByDomain.has(k)) skillsByDomain.set(k, []);
            skillsByDomain.get(k).push({
                name: s.name,
                subDomain: s.subDomainId != null ? sdById.get(String(s.subDomainId)) || null : null,
                category: s.category || null,
                description: s.description || null,
                strategicLink: s.strategicLink || null,
                isDuplicate: !!s.isDuplicate,
                isActive: !!s.isActive,
            });
        }
        for (const d of domains) {
            result.framework.domains.push({
                name: d.name,
                description: d.description || null,
                isActive: !!d.isActive,
                subDomains: subsByDomain.get(String(d.id)) || [],
                skills: skillsByDomain.get(String(d.id)) || [],
            });
        }

        // 2. Organization (sites -> depts -> services) — bulk fetch + group (no N+1)
        const sites = await db.all(
            'SELECT s.*, c.name AS countryName FROM sites s LEFT JOIN countries c ON c.id = s.country_id ORDER BY s.name'
        );
        const allDepts = await db.all(
            'SELECT id, siteId, name, code, isActive FROM departments ORDER BY name'
        );
        const allServices = await db.all(
            'SELECT id, departmentId, name, code, isActive FROM services ORDER BY name'
        );
        const siteById = new Map(sites.map((s) => [String(s.id), s.name]));
        const deptById = new Map(allDepts.map((d) => [String(d.id), d.name]));
        const svcById = new Map(allServices.map((s) => [String(s.id), s.name]));
        const deptsBySite = new Map();
        for (const d of allDepts) {
            const k = String(d.siteId);
            if (!deptsBySite.has(k)) deptsBySite.set(k, []);
            deptsBySite.get(k).push(d);
        }
        const svcsByDept = new Map();
        for (const sv of allServices) {
            const k = String(sv.departmentId);
            if (!svcsByDept.has(k)) svcsByDept.set(k, []);
            svcsByDept.get(k).push(sv);
        }
        for (const site of sites) {
            const siteObj = {
                name: site.name,
                code: site.code || null,
                country: site.countryName || null,
                isActive: !!site.isActive,
                departments: [],
            };
            for (const dept of deptsBySite.get(String(site.id)) || []) {
                siteObj.departments.push({
                    name: dept.name,
                    code: dept.code || null,
                    isActive: !!dept.isActive,
                    services: (svcsByDept.get(String(dept.id)) || []).map((s) => ({
                        name: s.name,
                        code: s.code || null,
                        isActive: !!s.isActive,
                    })),
                });
            }
            result.organization.sites.push(siteObj);
        }

        // 3. Role families — exported in full (including families not yet assigned to
        // any role) so the complete taxonomy round-trips, not just the referenced ones.
        const roleFamilies = await db.all(
            'SELECT name, description, isActive FROM role_families ORDER BY name'
        );
        result.roleFamilies = roleFamilies.map((f) => ({
            name: f.name,
            description: f.description || null,
            isActive: !!f.isActive,
        }));

        // 3b. Roles & Requirements — bulk fetch + group by role (no N+1). Each role
        // carries its role family so role_family_id round-trips. Inactive roles are
        // carried with their flag (they were dropped: 50 -> 41).
        const roles = await db.all(
            'SELECT r.id, r.name, r.description, r.isActive, rf.name AS roleFamilyName FROM roles r LEFT JOIN role_families rf ON rf.id = r.role_family_id ORDER BY r.name'
        );
        const allReqs = await db.all(
            `SELECT rsr.roleId, s.name AS skillName, dm.name AS domainName, sd.name AS subDomainName,
                    rsr.requiredLevel AS level, rsr.isCritical AS critical
             FROM roleSkillRequirements rsr
             JOIN skills s ON rsr.skillId = s.id
             JOIN domains dm ON s.domainId = dm.id
             LEFT JOIN sub_domains sd ON sd.id = s.subDomainId`
        );
        const reqsByRole = new Map();
        for (const r of allReqs) {
            const k = String(r.roleId);
            if (!reqsByRole.has(k)) reqsByRole.set(k, []);
            // `domain` + `subDomain` disambiguate skills whose name is reused — a name
            // is only unique within its sub-domain (10 names repeat inside one domain).
            reqsByRole.get(k).push({
                skill: r.skillName,
                domain: r.domainName,
                subDomain: r.subDomainName || null,
                level: r.level,
                critical: !!r.critical,
            });
        }
        for (const role of roles) {
            result.roles.push({
                name: role.name,
                description: role.description || null,
                roleFamily: role.roleFamilyName || null,
                isActive: !!role.isActive,
                requirements: reqsByRole.get(String(role.id)) || [],
            });
        }

        // 4. Employees (+ assessments, supervisor by number, username for reference)
        const employees = await db.all(`
            SELECT e.*, s.name AS siteName, d.name AS deptName, sv.name AS serviceName, r.name AS roleName,
                   sup.employeeNumber AS supervisorNumber
            FROM employees e
            LEFT JOIN sites s ON e.siteId = s.id
            LEFT JOIN departments d ON e.departmentId = d.id
            LEFT JOIN services sv ON e.serviceId = sv.id
            LEFT JOIN roles r ON e.roleId = r.id
            LEFT JOIN employees sup ON sup.id = e.supervisorId
            ORDER BY e.lastName, e.firstName
        `);
        const allAssess = await db.all(
            `SELECT sa.employeeId, s.name AS skillName, dm.name AS domainName, sd.name AS subDomainName,
                    sa.currentLevel AS level, sa.notes,
                    sa.assessedAt AS assessedAt, sa.assessedBy AS assessedBy
             FROM skillAssessments sa
             JOIN skills s ON sa.skillId = s.id
             JOIN domains dm ON s.domainId = dm.id
             LEFT JOIN sub_domains sd ON sd.id = s.subDomainId`
        );
        const { byId: adminById } = await buildAdminMaps();
        const assessByEmp = new Map();
        for (const a of allAssess) {
            const k = String(a.employeeId);
            if (!assessByEmp.has(k)) assessByEmp.set(k, []);
            // `domain` + `subDomain` disambiguate skills whose name is reused.
            assessByEmp.get(k).push({
                skill: a.skillName,
                domain: a.domainName,
                subDomain: a.subDomainName || null,
                level: a.level,
                notes: a.notes,
                // Carried so a re-import restores WHEN it was assessed, not just what.
                assessedAt: a.assessedAt ? new Date(a.assessedAt).toISOString() : null,
                // And by WHOM: without it every re-import re-attributed all 2 714
                // assessments to the importing admin.
                assessedBy: labelForAssessor(a.assessedBy, adminById) || null,
            });
        }
        for (const emp of employees) {
            const assessments = assessByEmp.get(String(emp.id)) || [];
            result.employees.push({
                employeeNumber: emp.employeeNumber,
                firstName: emp.firstName,
                lastName: emp.lastName,
                email: emp.email || null,
                phone: emp.phone || null,
                site: emp.siteName,
                department: emp.deptName,
                service: emp.serviceName,
                role: emp.roleName,
                supervisorEmployeeNumber: emp.supervisorNumber || null,
                username: emp.username || null, // password hashes are never exported
                // Without this a leaver was exported with no marker and RESURRECTED
                // as active on the target, silently inflating every denominator
                // (readiness, coverage, headcount) by an invisible number.
                isActive: emp.isActive !== false && emp.isActive !== 0,
                assessments, // already shaped { skill, level, notes }
            });
        }

        // 5. Admins & scopes — bulk fetch, resolve names from in-memory maps (no N+1)
        const regionById = new Map(regions.map((r) => [String(r.id), r.name]));
        const countryById = new Map(countries.map((c) => [String(c.id), c.name]));
        const admins = await db.all(
            'SELECT id, username, email, role FROM admins ORDER BY username'
        );
        const allScopes = await db.all(
            'SELECT admin_id, scope_type, site_id, department_id, service_id, region_id, country_id FROM admin_scopes'
        );
        const resolveScope = (sc) => {
            switch (sc.scopeType) {
                case 'site':
                    return siteById.get(String(sc.siteId));
                case 'department':
                    return deptById.get(String(sc.departmentId));
                case 'service':
                    return svcById.get(String(sc.serviceId));
                case 'region':
                    return regionById.get(String(sc.regionId));
                case 'country':
                    return countryById.get(String(sc.countryId));
                default:
                    return null;
            }
        };
        const scopesByAdmin = new Map();
        for (const sc of allScopes) {
            const nm = resolveScope(sc);
            if (!nm) continue;
            const k = String(sc.adminId);
            if (!scopesByAdmin.has(k)) scopesByAdmin.set(k, []);
            scopesByAdmin.get(k).push({ type: sc.scopeType, name: nm });
        }
        for (const a of admins) {
            result.admins.push({
                username: a.username,
                email: a.email || null,
                role: a.role,
                scopes: scopesByAdmin.get(String(a.id)) || [],
            });
        }

        // 6. App settings — but NEVER export secret values (SMTP password, LLM API
        // key, etc.) in cleartext: a portable JSON backup gets emailed/shared/stored
        // off-box. Secret rows are omitted entirely, so a re-import leaves the target's
        // own secret untouched rather than wiping it to a blank.
        const isSecret = (k) => /password|secret|pass$/i.test(k || '');
        const settings = await db.all('SELECT * FROM app_settings ORDER BY setting_key');
        result.appSettings = settings
            .filter((s) => !isSecret(s.settingKey))
            .map((s) => ({
                key: s.settingKey,
                value: s.settingValue,
                type: s.settingType,
                description: s.description,
                category: s.category,
            }));

        return result;
    }

    /**
     * Dry-run of importSystemFromJson: reports what a full-system JSON import
     * WOULD do (new vs existing per entity, how many employee/admin logins
     * would be generated) without writing anything. Powers the onboarding
     * wizard's upload → preview → commit flow.
     */
    async previewSystemFromJson(data) {
        const norm = (s) =>
            String(s ?? '')
                .trim()
                .toLowerCase();
        const setOf = async (sql, key) => {
            const rows = await db.all(sql);
            return new Set(rows.map(key));
        };

        const existing = {
            regions: await setOf('SELECT name FROM regions', (r) => norm(r.name)),
            countries: await setOf('SELECT name FROM countries', (r) => norm(r.name)),
            domains: await setOf('SELECT name FROM domains', (r) => norm(r.name)),
            // skills keyed by (name, domain) — names repeat across domains
            skills: await setOf(
                'SELECT s.name, d.name AS domainName FROM skills s JOIN domains d ON s.domainId = d.id',
                (r) => norm(r.name) + '§' + norm(r.domainName)
            ),
            sites: await setOf('SELECT name FROM sites', (r) => norm(r.name)),
            departments: await setOf(
                'SELECT d.name, s.name AS siteName FROM departments d JOIN sites s ON d.siteId = s.id',
                (r) => norm(r.name) + '§' + norm(r.siteName)
            ),
            services: await setOf(
                'SELECT sv.name, d.name AS deptName FROM services sv JOIN departments d ON sv.departmentId = d.id',
                (r) => norm(r.name) + '§' + norm(r.deptName)
            ),
            roles: await setOf('SELECT name FROM roles', (r) => norm(r.name)),
            employees: await setOf('SELECT employeeNumber FROM employees', (r) =>
                norm(r.employeeNumber)
            ),
            admins: await setOf('SELECT username FROM admins', (r) => norm(r.username)),
        };

        const counts = {};
        const tally = (label, items, keyFn, set) => {
            const list = items || [];
            const isNew = list.filter((x) => !set.has(keyFn(x)));
            counts[label] = {
                inFile: list.length,
                new: isNew.length,
                existing: list.length - isNew.length,
            };
        };

        const geo = data.geography || {};
        tally('regions', geo.regions, (r) => norm(r.name), existing.regions);
        tally('countries', geo.countries, (c) => norm(c.name), existing.countries);

        const domains = (data.framework && data.framework.domains) || [];
        tally('domains', domains, (d) => norm(d.name), existing.domains);
        const fileSkills = domains.flatMap((d) =>
            (d.skills || []).map((s) => ({
                ...(typeof s === 'string' ? { name: s } : s),
                domain: d.name,
            }))
        );
        tally('skills', fileSkills, (s) => norm(s.name) + '§' + norm(s.domain), existing.skills);

        const sites = (data.organization && data.organization.sites) || [];
        tally('sites', sites, (s) => norm(s.name), existing.sites);
        const fileDepts = sites.flatMap((s) =>
            (s.departments || []).map((d) => ({ ...d, site: s.name }))
        );
        tally(
            'departments',
            fileDepts,
            (d) => norm(d.name) + '§' + norm(d.site),
            existing.departments
        );
        const fileSvcs = fileDepts.flatMap((d) =>
            (d.services || []).map((sv) => ({
                ...(typeof sv === 'string' ? { name: sv } : sv),
                dept: d.name,
            }))
        );
        tally('services', fileSvcs, (sv) => norm(sv.name) + '§' + norm(sv.dept), existing.services);

        tally('roles', data.roles, (r) => norm(r.name), existing.roles);
        const reqCount = (data.roles || []).reduce(
            (n, r) =>
                n +
                (Array.isArray(r.requirements)
                    ? r.requirements.length
                    : Object.keys(r.requirements || {}).length),
            0
        );
        counts.requirements = { inFile: reqCount, note: 'merged (replace on match)' };

        tally('employees', data.employees, (e) => norm(e.employeeNumber), existing.employees);
        const assessCount = (data.employees || []).reduce(
            (n, e) => n + (e.assessments?.length || 0),
            0
        );
        counts.assessments = { inFile: assessCount, note: 'merged (replace on match)' };

        tally('admins', data.admins, (a) => norm(a.username), existing.admins);
        counts.appSettings = { inFile: (data.appSettings || []).length };
        // F1 (3.23.19): SSO settings in the file are never imported — say so up front.
        {
            const { isSsoSettingKey } = require('../utils/ssoSettingKeys');
            counts.appSettings.skippedSso = (data.appSettings || [])
                .filter((s) => s && s.key && isSsoSettingKey(s.key, s.category))
                .map((s) => String(s.key));
        }

        return {
            counts,
            credentialsToGenerate: {
                employees: counts.employees?.new || 0,
                admins: counts.admins?.new || 0,
            },
        };
    }

    async importSystemFromJson(data, importerUser = null) {
        // skill_assessments.assessed_by is NOT NULL and FKs to admins(id). Imports
        // carry the level/notes but no assessor, so attribute them to the importing
        // super-admin (falling back to the default super-admin id 1 if unknown).
        let importerAdminId = 1;
        const candidateId =
            importerUser &&
            (importerUser.userType === 'admin' || importerUser.userType === 'super_admin')
                ? importerUser.id
                : null;
        if (candidateId) {
            const a = await db.get('SELECT id FROM admins WHERE id = ?', [candidateId]);
            if (a) importerAdminId = a.id;
        }

        // Resolve a skill by name, disambiguating by domain when the export
        // provides it (skill names are not globally unique — the same name can
        // exist in several domains). Falls back to name-only for older exports.
        // Names resolve to an ACTIVE skill only. Duplicate skill groups were merged
        // by soft-retire, so an unqualified name matches the retired twin as readily
        // as the live one — and PostgreSQL may return either. Writing to the retired
        // row resurrected it and gave roles phantom duplicate requirements.
        const { resolveActiveSkillByName } = require('../utils/importSkillResolver');
        // With a sub-domain the lookup is exact — (domain, sub-domain, name) is the
        // framework's own identity, the only one that separates a name reused by two
        // sub-domains of the same domain. Without one, the shared active-only resolver.
        const resolveSkill = async (name, domain, subDomain) => {
            if (name && subDomain && String(subDomain).trim()) {
                const s = await db.get(
                    `SELECT s.id FROM skills s
                     JOIN sub_domains sd ON sd.id = s.subDomainId
                     JOIN domains d ON d.id = s.domainId
                     WHERE LOWER(s.name) = LOWER(?) AND LOWER(sd.name) = LOWER(?) AND LOWER(d.name) = LOWER(?)
                       AND s.isActive = true
                     ORDER BY s.id LIMIT 1`,
                    [String(name).trim(), String(subDomain).trim(), String(domain || '').trim()]
                );
                if (s) return s;
            }
            return resolveActiveSkillByName(db, name, domain);
        };
        // "Assessed By" labels resolve to an admins.id; a row without one falls back
        // to the importer (the previous behaviour for every row). The maps are built
        // AFTER the admins section is imported (see step 4 below), so a fresh install
        // resolves the assessors the file itself just created.
        let adminByName = new Map();
        let adminById = new Map();
        // Skill rows a file row has already been matched to, within this import.
        // Retired twins are identical by every natural key — (domain, sub-domain,
        // name, inactive) — so without this, two retired twins in the file both
        // matched the first one in the database and the second was never re-created
        // (1 142 -> 1 139 on a fresh install).
        const claimedSkillIds = new Set();

        // Every `X` counts rows CREATED; every `XUpdated` counts EXISTING rows the
        // file corrected. The documented workflow is export -> correct -> re-import,
        // and only the create branch existed for the framework and the org tree: a
        // corrected domain description, skill category/description/strategic link,
        // sub-domain definition, role description/family, or site/department/service
        // code was silently DISCARDED while the import answered
        // `{ success: true, skills: 0 }` — a summary indistinguishable from "your
        // file contained nothing new", which is exactly how it read.
        //
        // A field is written only when the file actually carries the key (`'x' in o`),
        // so a hand-made or older file that omits a column leaves the stored value
        // alone instead of blanking it; a key the operator deliberately emptied does
        // clear the value.
        const results = {
            regions: 0,
            regionsUpdated: 0,
            countries: 0,
            countriesUpdated: 0,
            domains: 0,
            domainsUpdated: 0,
            subDomainsUpdated: 0,
            skills: 0,
            skillsUpdated: 0,
            sites: 0,
            sitesUpdated: 0,
            departments: 0,
            departmentsUpdated: 0,
            services: 0,
            servicesUpdated: 0,
            roles: 0,
            rolesUpdated: 0,
            roleFamiliesUpdated: 0,
            requirements: 0,
            // `employees` counts rows CREATED; `employeesUpdated` counts existing
            // people whose placement/contact details the file corrected. Declared
            // here so the summary always reports it — an import that silently
            // changed people while reporting 0 is how the missing UPDATE branch
            // went unnoticed.
            employees: 0,
            employeesUpdated: 0,
            assessments: 0,
            assessmentsUnchanged: 0,
            admins: 0,
            adminScopes: 0,
            appSettings: 0,
            appSettingsSkippedSso: [], // F1: SSO keys are never imported
            credentials: [], // generated employee/admin logins for the super-admin to distribute
        };

        // Write only the keys the file carries, and only when they differ from what
        // is stored. Returns true when a row was actually written, so the summary
        // can report a correction instead of staying silently at 0.
        // `table`/`column` are internal literals — never taken from the file.
        const nz = (v) => (v === undefined || v === '' ? null : v);
        const patch = async (table, id, pairs) => {
            const sets = [];
            const vals = [];
            for (const [column, carried, want, stored] of pairs) {
                if (!carried) continue; // key absent from the file — leave it alone
                if (nz(want) === nz(stored)) continue; // already identical — no write
                sets.push(`${column} = ?`);
                vals.push(nz(want));
            }
            if (!sets.length) return false;
            vals.push(id);
            await db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, vals);
            return true;
        };

        await db.runTransaction(async () => {
            // 0. Geography
            const geo = data.geography || {};
            for (const r of geo.regions || []) {
                let region = await db.get('SELECT id, code FROM regions WHERE name = ?', [r.name]);
                if (!region) {
                    await db.run('INSERT INTO regions (name, code, isActive) VALUES (?, ?, true)', [
                        r.name,
                        r.code || null,
                    ]);
                    results.regions++;
                } else if (
                    await patch('regions', region.id, [['code', 'code' in r, r.code, region.code]])
                ) {
                    results.regionsUpdated++;
                }
            }
            for (const c of geo.countries || []) {
                let country = await db.get(
                    'SELECT id, code, region_id AS regionId FROM countries WHERE name = ?',
                    [c.name]
                );
                if (!country) {
                    const region = c.region
                        ? await db.get('SELECT id FROM regions WHERE name = ?', [c.region])
                        : null;
                    await db.run(
                        'INSERT INTO countries (name, code, region_id, isActive) VALUES (?, ?, ?, true)',
                        [c.name, c.code || null, region?.id || null]
                    );
                    results.countries++;
                } else {
                    // A region that does not resolve leaves the existing link alone
                    // rather than orphaning the country.
                    const region = c.region
                        ? await db.get('SELECT id FROM regions WHERE name = ?', [c.region])
                        : null;
                    const wrote = await patch('countries', country.id, [
                        ['code', 'code' in c, c.code, country.code],
                        ['region_id', !!region, region && region.id, country.regionId],
                    ]);
                    if (wrote) results.countriesUpdated++;
                }
            }

            // 1. Framework (domains -> sub-domains -> skills). Skills may be
            // string[] or object[]; objects may carry subDomain/category/strategicLink.
            if (data.framework && data.framework.domains) {
                for (const d of data.framework.domains) {
                    let domain = await db.get(
                        'SELECT id, description, isActive FROM domains WHERE name = ?',
                        [d.name]
                    );
                    if (!domain) {
                        // isActive comes from the file (absent -> active, as before).
                        await db.run(
                            'INSERT INTO domains (name, description, isActive) VALUES (?, ?, ?)',
                            [d.name, d.description || null, activeOf(d)]
                        );
                        domain = await db.get('SELECT id FROM domains WHERE name = ?', [d.name]);
                        results.domains++;
                    } else if (
                        await patch('domains', domain.id, [
                            ['description', 'description' in d, d.description, domain.description],
                            ['isActive', 'isActive' in d, activeOf(d), domain.isActive],
                        ])
                    ) {
                        results.domainsUpdated++;
                    }
                    // Sub-domains (create before skills so skills can link to them).
                    const subIdByName = new Map();
                    let pos = 0;
                    for (const sd of d.subDomains || []) {
                        const sdName = typeof sd === 'string' ? sd : sd.name;
                        if (!sdName) continue;
                        pos++;
                        let sub = await db.get(
                            'SELECT id, definition, position, isActive FROM sub_domains WHERE name = ? AND domainId = ?',
                            [sdName, domain.id]
                        );
                        if (!sub) {
                            await db.run(
                                'INSERT INTO sub_domains (domainId, name, definition, position, isActive) VALUES (?, ?, ?, ?, ?)',
                                [
                                    domain.id,
                                    sdName,
                                    (typeof sd === 'object' && sd.definition) || null,
                                    (typeof sd === 'object' && sd.position) || pos,
                                    activeOf(sd),
                                ]
                            );
                            sub = await db.get(
                                'SELECT id FROM sub_domains WHERE name = ? AND domainId = ?',
                                [sdName, domain.id]
                            );
                            results.subDomains = (results.subDomains || 0) + 1;
                        } else if (
                            typeof sd === 'object' &&
                            (await patch('sub_domains', sub.id, [
                                ['definition', 'definition' in sd, sd.definition, sub.definition],
                                // `position` is re-derived when absent, so only an explicit
                                // one is treated as a correction.
                                ['position', sd.position != null, sd.position, sub.position],
                                ['isActive', 'isActive' in sd, activeOf(sd), sub.isActive],
                            ]))
                        ) {
                            results.subDomainsUpdated++;
                        }
                        subIdByName.set(sdName.toLowerCase(), sub.id);
                    }
                    for (const sk of d.skills || []) {
                        const skillName = typeof sk === 'string' ? sk : sk.name;
                        const category = typeof sk === 'string' ? null : sk.category || null;
                        const description = typeof sk === 'string' ? null : sk.description || null;
                        const strategicLink =
                            typeof sk === 'string' ? null : sk.strategicLink || null;
                        const subName = typeof sk === 'string' ? null : sk.subDomain || null;
                        // A retired twin is matched among retired rows and re-created retired;
                        // an active one among active rows. They share (sub_domain_id,
                        // lower(name)) by design, so the flag is part of the lookup key.
                        const wantActive = activeOf(sk);
                        // The skill-merge marker; absent from older files -> false (the column default).
                        const wantDuplicate = duplicateOf(sk);
                        if (!skillName) continue;
                        // Resolve (or lazily create) the sub-domain this skill names.
                        let subDomainId = subName
                            ? subIdByName.get(String(subName).toLowerCase())
                            : null;
                        if (subName && !subDomainId) {
                            let sub = await db.get(
                                'SELECT id FROM sub_domains WHERE name = ? AND domainId = ?',
                                [subName, domain.id]
                            );
                            if (!sub) {
                                await db.run(
                                    'INSERT INTO sub_domains (domainId, name, position, isActive) VALUES (?, ?, ?, true)',
                                    [domain.id, subName, ++pos]
                                );
                                sub = await db.get(
                                    'SELECT id FROM sub_domains WHERE name = ? AND domainId = ?',
                                    [subName, domain.id]
                                );
                                results.subDomains = (results.subDomains || 0) + 1;
                            }
                            subDomainId = sub.id;
                            subIdByName.set(String(subName).toLowerCase(), subDomainId);
                        }
                        // Match the live uniqueness key (sub_domain_id, lower(name)) so a
                        // re-import lands on the same skill; fall back to (domain, name) when
                        // the skill has no sub-domain. Prevents uq_skill_subdomain_name violations.
                        const cols =
                            'id, subDomainId, category, description, strategicLink, is_duplicate AS isDuplicate';
                        const where =
                            subDomainId != null
                                ? [
                                      'subDomainId = ? AND LOWER(name) = LOWER(?) AND isActive = ?',
                                      [subDomainId, skillName, wantActive],
                                  ]
                                : [
                                      'domainId = ? AND LOWER(name) = LOWER(?) AND subDomainId IS NULL AND isActive = ?',
                                      [domain.id, skillName, wantActive],
                                  ];
                        let skill = await db.get(
                            `SELECT ${cols} FROM skills WHERE ${where[0]} ORDER BY id LIMIT 1`,
                            where[1]
                        );
                        if (skill && claimedSkillIds.has(String(skill.id))) {
                            // Already matched by an earlier file row (a retired twin): take
                            // the next unclaimed twin, or none — so the row is re-created.
                            const twins = await db.all(
                                `SELECT ${cols} FROM skills WHERE ${where[0]} ORDER BY id`,
                                where[1]
                            );
                            skill = twins.find((t) => !claimedSkillIds.has(String(t.id))) || null;
                        }
                        if (skill) claimedSkillIds.add(String(skill.id));
                        if (!skill) {
                            await db.run(
                                'INSERT INTO skills (name, domainId, subDomainId, category, description, strategicLink, is_duplicate, isActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                                [
                                    skillName,
                                    domain.id,
                                    subDomainId,
                                    category,
                                    description,
                                    strategicLink,
                                    wantDuplicate,
                                    wantActive,
                                ]
                            );
                            results.skills++;
                        } else {
                            // Corrected attributes now land. A MOVE between sub-domains
                            // is still only ever a backfill: (sub_domain_id, lower(name))
                            // is the live uniqueness key, so re-parenting a skill onto a
                            // sub-domain that already holds that name would collide.
                            const isObj = typeof sk === 'object' && sk !== null;
                            const wrote = await patch('skills', skill.id, [
                                [
                                    'subDomainId',
                                    !!(subDomainId && skill.subDomainId == null),
                                    subDomainId,
                                    skill.subDomainId,
                                ],
                                ['category', isObj && 'category' in sk, category, skill.category],
                                [
                                    'description',
                                    isObj && 'description' in sk,
                                    description,
                                    skill.description,
                                ],
                                [
                                    'strategicLink',
                                    isObj && 'strategicLink' in sk,
                                    strategicLink,
                                    skill.strategicLink,
                                ],
                                // Only a file that carries the marker may change it.
                                [
                                    'is_duplicate',
                                    isObj && 'isDuplicate' in sk,
                                    wantDuplicate,
                                    !!skill.isDuplicate,
                                ],
                            ]);
                            if (wrote) results.skillsUpdated++;
                        }
                    }
                }
            }

            // 2. Organization (services may be string[] or object[])
            if (data.organization && data.organization.sites) {
                for (const s of data.organization.sites) {
                    let site = await db.get(
                        'SELECT id, code, country_id AS countryId, isActive FROM sites WHERE name = ?',
                        [s.name]
                    );
                    if (!site) {
                        const country = s.country
                            ? await db.get('SELECT id FROM countries WHERE name = ?', [s.country])
                            : null;
                        await db.run(
                            'INSERT INTO sites (name, code, country_id, isActive) VALUES (?, ?, ?, ?)',
                            [s.name, s.code || null, country?.id || null, activeOf(s)]
                        );
                        site = await db.get('SELECT id FROM sites WHERE name = ?', [s.name]);
                        results.sites++;
                    } else {
                        // A country name that does not resolve leaves the existing
                        // link alone rather than detaching the site.
                        const country = s.country
                            ? await db.get('SELECT id FROM countries WHERE name = ?', [s.country])
                            : null;
                        const wrote = await patch('sites', site.id, [
                            ['code', 'code' in s, s.code, site.code],
                            ['country_id', !!country, country && country.id, site.countryId],
                            ['isActive', 'isActive' in s, activeOf(s), site.isActive],
                        ]);
                        if (wrote) results.sitesUpdated++;
                    }
                    for (const d of s.departments || []) {
                        let dept = await db.get(
                            'SELECT id, code, isActive FROM departments WHERE name = ? AND siteId = ?',
                            [d.name, site.id]
                        );
                        if (!dept) {
                            await db.run(
                                'INSERT INTO departments (name, code, siteId, isActive) VALUES (?, ?, ?, ?)',
                                [d.name, d.code || null, site.id, activeOf(d)]
                            );
                            dept = await db.get(
                                'SELECT id FROM departments WHERE name = ? AND siteId = ?',
                                [d.name, site.id]
                            );
                            results.departments++;
                        } else if (
                            await patch('departments', dept.id, [
                                ['code', 'code' in d, d.code, dept.code],
                                ['isActive', 'isActive' in d, activeOf(d), dept.isActive],
                            ])
                        ) {
                            results.departmentsUpdated++;
                        }
                        for (const sv of d.services || []) {
                            const svName = typeof sv === 'string' ? sv : sv.name;
                            const svCode = typeof sv === 'string' ? null : sv.code || null;
                            if (!svName) continue;
                            const service = await db.get(
                                'SELECT id, code, isActive FROM services WHERE name = ? AND departmentId = ?',
                                [svName, dept.id]
                            );
                            if (!service) {
                                await db.run(
                                    'INSERT INTO services (name, code, departmentId, isActive) VALUES (?, ?, ?, ?)',
                                    [svName, svCode, dept.id, activeOf(sv)]
                                );
                                results.services++;
                            } else if (
                                await patch('services', service.id, [
                                    [
                                        'code',
                                        typeof sv === 'object' && sv !== null && 'code' in sv,
                                        svCode,
                                        service.code,
                                    ],
                                    [
                                        'isActive',
                                        typeof sv === 'object' && sv !== null && 'isActive' in sv,
                                        activeOf(sv),
                                        service.isActive,
                                    ],
                                ])
                            ) {
                                results.servicesUpdated++;
                            }
                        }
                    }
                }
            }

            // 3. Role families (create the full taxonomy first, incl. families not yet
            // assigned to a role, so the complete list round-trips).
            if (Array.isArray(data.roleFamilies)) {
                for (const f of data.roleFamilies) {
                    const fName = typeof f === 'string' ? f : f && f.name;
                    if (!fName) continue;
                    const fam = await db.get(
                        'SELECT id, description, isActive FROM role_families WHERE LOWER(name) = LOWER(?)',
                        [fName]
                    );
                    if (!fam) {
                        await db.run(
                            "INSERT INTO role_families (name, description, origin, isActive) VALUES (?, ?, 'standard', ?)",
                            [fName, (typeof f === 'object' && f.description) || null, activeOf(f)]
                        );
                        results.roleFamilies = (results.roleFamilies || 0) + 1;
                    } else if (
                        typeof f === 'object' &&
                        f !== null &&
                        (await patch('role_families', fam.id, [
                            ['description', 'description' in f, f.description, fam.description],
                            ['isActive', 'isActive' in f, activeOf(f), fam.isActive],
                        ]))
                    ) {
                        results.roleFamiliesUpdated++;
                    }
                }
            }

            // 3b. Roles & requirements (requirements: map {skill:level} OR [{skill,level,critical}])
            if (data.roles) {
                for (const r of data.roles) {
                    // Resolve (or create) the role's family so role_family_id round-trips.
                    let roleFamilyId = null;
                    if (r.roleFamily) {
                        let fam = await db.get(
                            'SELECT id FROM role_families WHERE LOWER(name) = LOWER(?)',
                            [r.roleFamily]
                        );
                        if (!fam) {
                            await db.run(
                                "INSERT INTO role_families (name, origin, isActive) VALUES (?, 'standard', true)",
                                [r.roleFamily]
                            );
                            fam = await db.get(
                                'SELECT id FROM role_families WHERE LOWER(name) = LOWER(?)',
                                [r.roleFamily]
                            );
                            results.roleFamilies = (results.roleFamilies || 0) + 1;
                        }
                        roleFamilyId = fam ? fam.id : null;
                    }
                    let role = await db.get(
                        'SELECT id, description, role_family_id AS roleFamilyId, isActive FROM roles WHERE name = ?',
                        [r.name]
                    );
                    if (!role) {
                        await db.run(
                            'INSERT INTO roles (name, description, role_family_id, isActive) VALUES (?, ?, ?, ?)',
                            [r.name, r.description || null, roleFamilyId, activeOf(r)]
                        );
                        role = await db.get('SELECT id FROM roles WHERE name = ?', [r.name]);
                        results.roles++;
                    } else {
                        // The family was only ever back-filled onto a role that had
                        // none; a REASSIGNMENT in the file was discarded in silence.
                        const wrote = await patch('roles', role.id, [
                            ['description', 'description' in r, r.description, role.description],
                            ['role_family_id', !!roleFamilyId, roleFamilyId, role.roleFamilyId],
                            ['isActive', 'isActive' in r, activeOf(r), role.isActive],
                        ]);
                        if (wrote) results.rolesUpdated++;
                    }
                    const reqList = Array.isArray(r.requirements)
                        ? r.requirements
                        : Object.entries(r.requirements || {}).map(([skill, level]) => ({
                              skill,
                              level,
                              critical: false,
                          }));
                    // De-duplicate within a role: distinct source names can resolve to
                    // the SAME active skill (duplicate groups merged by soft-retire),
                    // which double-counted and let the last entry silently overwrite.
                    const seenReq = new Set();
                    for (const req of reqList) {
                        const skill = await resolveSkill(req.skill, req.domain, req.subDomain);
                        if (!skill) {
                            (results.errors = results.errors || []).push(
                                `Role "${r.name}": skill "${req.skill}" not found or retired — requirement skipped.`
                            );
                            continue;
                        }
                        if (seenReq.has(String(skill.id))) continue;
                        seenReq.add(String(skill.id));
                        // `req.level` may legitimately be 0 — pass it through untouched.
                        await db.run(
                            'DELETE FROM roleSkillRequirements WHERE roleId = ? AND skillId = ?',
                            [role.id, skill.id]
                        );
                        await db.run(
                            'INSERT INTO roleSkillRequirements (roleId, skillId, requiredLevel, isCritical) VALUES (?, ?, ?, ?)',
                            [role.id, skill.id, req.level, req.critical ? true : false]
                        );
                        results.requirements++;
                    }
                }
            }

            // 4. Admins & scopes (generated temp password, must change on first login).
            // Imported BEFORE the employees so the assessors the file names exist when
            // the assessments are written: on a fresh install every "Assessed By" used
            // to fall back to the importer because its admin had not been created yet.
            if (data.admins) {
                for (const a of data.admins) {
                    if (!a.username) continue;
                    let admin = await db.get('SELECT id FROM admins WHERE username = ?', [
                        a.username,
                    ]);
                    if (!admin) {
                        const password = generatePassword();
                        const hash = await bcrypt.hash(password, 10);
                        await db.run(
                            'INSERT INTO admins (username, email, password_hash, role, is_active, force_password_change) VALUES (?, ?, ?, ?, true, true)',
                            [a.username, a.email || null, hash, a.role || 'localadmin']
                        );
                        admin = await db.get('SELECT id FROM admins WHERE username = ?', [
                            a.username,
                        ]);
                        results.admins++;
                        results.credentials.push({
                            type: 'admin',
                            name: a.username,
                            username: a.username,
                            password,
                        });
                    }
                    for (const sc of a.scopes || []) {
                        const tableByType = {
                            site: 'sites',
                            department: 'departments',
                            service: 'services',
                            region: 'regions',
                            country: 'countries',
                        };
                        const colByType = {
                            site: 'site_id',
                            department: 'department_id',
                            service: 'service_id',
                            region: 'region_id',
                            country: 'country_id',
                        };
                        const table = tableByType[sc.type];
                        const col = colByType[sc.type];
                        if (!table || !col) continue;
                        const target = await db.get(`SELECT id FROM ${table} WHERE name = ?`, [
                            sc.name,
                        ]);
                        if (!target) continue;
                        const exists = await db.get(
                            `SELECT id FROM admin_scopes WHERE admin_id = ? AND scope_type = ? AND ${col} = ?`,
                            [admin.id, sc.type, target.id]
                        );
                        if (!exists) {
                            await db.run(
                                `INSERT INTO admin_scopes (admin_id, scope_type, ${col}) VALUES (?, ?, ?)`,
                                [admin.id, sc.type, target.id]
                            );
                            results.adminScopes++;
                        }
                    }
                }
            }
            ({ byName: adminByName, byId: adminById } = await buildAdminMaps());

            // 5. Employees (+ generated logins, supervisor linked in a 2nd pass)
            if (data.employees) {
                // Ids already counted as created/updated in pass 1, so the
                // supervisor pass can report a person it changed without
                // counting anybody twice.
                const empCounted = new Set();
                const isTakenEmp = async (name) => {
                    const e = await db.get('SELECT id FROM employees WHERE username = ?', [name]);
                    const a = await db.get('SELECT id FROM admins WHERE username = ?', [name]);
                    return Boolean(e || a);
                };
                for (const e of data.employees) {
                    // Case-insensitive matching so preview (norm/lowercased) and
                    // this commit agree — otherwise a "known" row is treated as new.
                    const site = e.site
                        ? await db.get('SELECT id FROM sites WHERE LOWER(name) = LOWER(?)', [
                              e.site,
                          ])
                        : null;
                    const dept =
                        site && e.department
                            ? await db.get(
                                  'SELECT id FROM departments WHERE LOWER(name) = LOWER(?) AND siteId = ?',
                                  [e.department, site.id]
                              )
                            : null;
                    const service =
                        dept && e.service
                            ? await db.get(
                                  'SELECT id FROM services WHERE LOWER(name) = LOWER(?) AND departmentId = ?',
                                  [e.service, dept.id]
                              )
                            : null;
                    const role = e.role
                        ? await db.get('SELECT id FROM roles WHERE LOWER(name) = LOWER(?)', [
                              e.role,
                          ])
                        : null;

                    let employee = await db.get(
                        `SELECT id, username, firstName, lastName, email, phone,
                                siteId, departmentId, serviceId, roleId, isActive
                         FROM employees WHERE employeeNumber = ?`,
                        [e.employeeNumber]
                    );
                    if (!employee) {
                        // site/dept/service/role are NOT NULL — skip-with-error rather
                        // than insert null (which 23502-aborts the whole import).
                        const missing = [];
                        if (!site) missing.push(`site "${e.site || ''}"`);
                        if (!dept) missing.push(`department "${e.department || ''}"`);
                        if (!service) missing.push(`service "${e.service || ''}"`);
                        if (!role) missing.push(`role "${e.role || ''}"`);
                        if (missing.length) {
                            (results.errors = results.errors || []).push(
                                `Employee ${e.employeeNumber}: could not resolve ${missing.join(', ')} — create them first or fix the names. Row skipped.`
                            );
                            continue;
                        }
                        await db.run(
                            // isActive comes from the file. Hard-coding `true` brought
                            // departed people back to life on every restore.
                            `INSERT INTO employees (employeeNumber, firstName, lastName, email, phone, siteId, departmentId, serviceId, roleId, isActive)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                e.employeeNumber,
                                e.firstName,
                                e.lastName,
                                e.email || null,
                                e.phone || null,
                                site.id,
                                dept.id,
                                service.id,
                                role.id,
                                e.isActive === undefined
                                    ? true
                                    : !(e.isActive === false || e.isActive === 0),
                            ]
                        );
                        employee = await db.get(
                            'SELECT id, username FROM employees WHERE employeeNumber = ?',
                            [e.employeeNumber]
                        );
                        results.employees++;
                        empCounted.add(String(employee.id));

                        // Provision a login if the employee doesn't have one.
                        const username = await uniqueUsername(baseUsername(e), isTakenEmp);
                        const password = generatePassword();
                        const hash = await bcrypt.hash(password, 10);
                        await db.run(
                            'UPDATE employees SET username = ?, password_hash = ?, is_account_active = true, force_password_change = true WHERE id = ?',
                            [username, hash, employee.id]
                        );
                        results.credentials.push({
                            type: 'employee',
                            employeeNumber: e.employeeNumber,
                            name: `${e.firstName} ${e.lastName}`,
                            username,
                            password,
                        });
                    } else {
                        // The documented workflow is export -> correct -> re-import, and
                        // only the INSERT branch existed: for an employee who already
                        // exists NOTHING was written, so every correction to site,
                        // department, service, role, e-mail or phone was silently
                        // discarded while the import reported success and
                        // `results.employees` stayed 0.
                        //
                        // It was PARTIAL, which is what made it look like it worked: the
                        // second pass did update supervisor_id and the assessments below
                        // were rewritten. Only the placement was lost.
                        //
                        // Placement columns are NOT NULL, so each is written only when
                        // the file's name resolved; an unresolvable one is reported and
                        // the existing value kept, rather than nulling the row.
                        //
                        // A value identical to the stored one is NOT written and NOT
                        // counted: `employeesUpdated` must mean "people this file
                        // corrected", and it used to report every person the file
                        // merely mentioned (80 of 80 on a no-op re-import).
                        const sets = [];
                        const vals = [];
                        const identical = (a, b) => {
                            // '' and NULL are the same absence: 70 of 80 people store
                            // an empty e-mail while the export carries null, and
                            // rewriting those would have reported 70 "corrections"
                            // that corrected nothing.
                            const A = a === undefined || a === '' ? null : a;
                            const B = b === undefined || b === '' ? null : b;
                            if (typeof A === 'boolean' || typeof B === 'boolean')
                                return Boolean(A) === Boolean(B);
                            if (A === null || B === null) return A === B;
                            if (typeof A === 'number' || typeof B === 'number')
                                return Number(A) === Number(B);
                            return String(A) === String(B);
                        };
                        const put = (col, v) => {
                            if (identical(employee[col], v)) return;
                            sets.push(`${col} = ?`);
                            vals.push(v);
                        };
                        if (e.firstName) put('firstName', e.firstName);
                        if (e.lastName) put('lastName', e.lastName);
                        if ('email' in e) put('email', e.email || null);
                        if ('phone' in e) put('phone', e.phone || null);
                        if (site) put('siteId', site.id);
                        if (dept) put('departmentId', dept.id);
                        if (service) put('serviceId', service.id);
                        if (role) put('roleId', role.id);
                        if (e.isActive !== undefined)
                            put('isActive', !(e.isActive === false || e.isActive === 0));

                        const unresolved = [];
                        if (e.site && !site) unresolved.push(`site "${e.site}"`);
                        if (e.department && !dept) unresolved.push(`department "${e.department}"`);
                        if (e.service && !service) unresolved.push(`service "${e.service}"`);
                        if (e.role && !role) unresolved.push(`role "${e.role}"`);
                        if (unresolved.length) {
                            (results.errors = results.errors || []).push(
                                `Employee ${e.employeeNumber}: could not resolve ${unresolved.join(', ')} — that placement was left unchanged.`
                            );
                        }
                        if (sets.length) {
                            vals.push(employee.id);
                            await db.run(
                                `UPDATE employees SET ${sets.join(', ')} WHERE id = ?`,
                                vals
                            );
                            results.employeesUpdated = (results.employeesUpdated || 0) + 1;
                            empCounted.add(String(employee.id));
                        }
                    }

                    const seenAss = new Set();
                    for (const a of e.assessments || []) {
                        const skill = await resolveSkill(a.skill, a.domain, a.subDomain);
                        if (skill && !seenAss.has(String(skill.id))) {
                            seenAss.add(String(skill.id));
                            // The assessor the file names, else the importer.
                            const assessorId = resolveAssessorId(
                                a.assessedBy,
                                adminByName,
                                adminById,
                                importerAdminId
                            );
                            const fileAt = (() => {
                                const d = a.assessedAt ? new Date(a.assessedAt) : null;
                                return d && !Number.isNaN(d.getTime()) ? d.getTime() : null;
                            })();
                            // A row the file does not change is left alone. Rewriting it
                            // (DELETE + INSERT) fired the assessment-history trigger for
                            // every row, so a no-op re-import appended 2 714 rows to the
                            // append-only history — noise presented as measurement.
                            const stored = await db.get(
                                'SELECT id, currentLevel, notes, assessedBy, assessedAt FROM skillAssessments WHERE employeeId = ? AND skillId = ?',
                                [employee.id, skill.id]
                            );
                            const same =
                                stored &&
                                Number(stored.currentLevel) === Number(a.level) &&
                                String(stored.notes == null ? '' : stored.notes) ===
                                    String(a.notes == null ? '' : a.notes) &&
                                Number(stored.assessedBy) === Number(assessorId) &&
                                fileAt != null &&
                                stored.assessedAt &&
                                new Date(stored.assessedAt).getTime() === fileAt;
                            if (same) {
                                results.assessmentsUnchanged =
                                    (results.assessmentsUnchanged || 0) + 1;
                                continue;
                            }
                            await db.run(
                                'DELETE FROM skillAssessments WHERE employeeId = ? AND skillId = ?',
                                [employee.id, skill.id]
                            );
                            await db.run(
                                // Keep the date the export carried; an absent or
                                // unreadable one falls back to now. Without this a
                                // full re-import redated every assessment to today.
                                `INSERT INTO skillAssessments (employeeId, skillId, currentLevel, notes, assessedBy, assessedAt)
                                 VALUES (?, ?, ?, ?, ?, COALESCE(?::timestamptz, now()))`,
                                [
                                    employee.id,
                                    skill.id,
                                    a.level,
                                    a.notes || null,
                                    assessorId,
                                    (() => {
                                        const d = a.assessedAt ? new Date(a.assessedAt) : null;
                                        return d && !Number.isNaN(d.getTime())
                                            ? d.toISOString()
                                            : null;
                                    })(),
                                ]
                            );
                            results.assessments++;
                        }
                    }
                }
                // 2nd pass: link supervisors by employee number. Written only when
                // the link actually changes, and counted as a correction so a
                // re-parenting is never hidden behind "0 updated".
                for (const e of data.employees) {
                    if (!e.supervisorEmployeeNumber) continue;
                    const emp = await db.get(
                        'SELECT id, supervisor_id AS supervisorId FROM employees WHERE employeeNumber = ?',
                        [e.employeeNumber]
                    );
                    const sup = await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                        e.supervisorEmployeeNumber,
                    ]);
                    if (!emp || !sup) continue;
                    if (Number(emp.supervisorId) === Number(sup.id)) continue;
                    // 3.23.18 — no reporting loop, no self-line: refused per row
                    // (the person keeps the line they had), reported, import goes on.
                    // Same check as the app's own forms (both lines count), against
                    // the database as it stands — a loop across two rows of the
                    // same file is caught at the second.
                    if (
                        Number(sup.id) === Number(emp.id) ||
                        (await require('../models/EmployeeModel').wouldCreateReportingCycle(
                            emp.id,
                            sup.id
                        ))
                    ) {
                        (results.errors = results.errors || []).push(
                            `Employee ${e.employeeNumber}: supervisor ${e.supervisorEmployeeNumber} would create a reporting loop (or is the person themselves) — link not changed.`
                        );
                        continue;
                    }
                    await db.run('UPDATE employees SET supervisor_id = ? WHERE id = ?', [
                        sup.id,
                        emp.id,
                    ]);
                    if (!empCounted.has(String(emp.id))) {
                        empCounted.add(String(emp.id));
                        results.employeesUpdated = (results.employeesUpdated || 0) + 1;
                    }
                }
            }

            // 6. App settings (upsert by key)
            if (data.appSettings) {
                const { isSsoSettingKey } = require('../utils/ssoSettingKeys');
                for (const s of data.appSettings) {
                    if (!s.key) continue;
                    // 3.23.19: SSO settings are NEVER
                    // imported — they decide who signs in and what counts as MFA,
                    // and are written only on the SuperAdmin SSO page. Skipped and
                    // reported, whoever runs the import.
                    if (isSsoSettingKey(s.key, s.category)) {
                        results.appSettingsSkippedSso.push(String(s.key));
                        continue;
                    }
                    const existing = await db.get(
                        'SELECT id, category FROM app_settings WHERE setting_key = ?',
                        [s.key]
                    );
                    if (existing && isSsoSettingKey(s.key, existing.category)) {
                        results.appSettingsSkippedSso.push(String(s.key));
                        continue;
                    }
                    if (existing) {
                        await db.run(
                            'UPDATE app_settings SET setting_value = ?, updated_at = now() WHERE setting_key = ?',
                            [s.value, s.key]
                        );
                    } else {
                        await db.run(
                            'INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category) VALUES (?, ?, ?, ?, ?)',
                            [
                                s.key,
                                s.value,
                                s.type || 'string',
                                s.description || null,
                                s.category || null,
                            ]
                        );
                    }
                    results.appSettings++;
                }
            }
        });

        // Imports change the aggregates the executive dashboard caches.
        require('../utils/ttlCache').dashboardCache.bust();

        return { success: true, results };
    }
}

module.exports = new UnifiedJsonService();
