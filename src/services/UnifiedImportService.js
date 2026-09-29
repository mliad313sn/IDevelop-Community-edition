const ExcelJS = require('exceljs');
const db = require('../config/database');
const path = require('path');
const bcrypt = require('bcrypt');
const { generatePassword, baseUsername, uniqueUsername } = require('../utils/credentialGenerator');
const { isNonDataRow } = require('../utils/importGuards');
const {
    resolveActiveSkillByName,
    resolveSkillByIdOrName,
    isRetiredOnly,
} = require('../utils/importSkillResolver');

class UnifiedImportService {
    /**
     * Read one matrix cell as a requirement/level.
     * Accepts a plain number, a numeric string, and the critical marker written
     * by UnifiedExportService: "3*" = level 3, critical. Formula/rich-text cells
     * are flattened first.
     * Returns { level:Number, critical:Boolean, marked:Boolean } or null when the
     * cell is empty / not a level.
     */
    _parseLevelCell(raw) {
        let v = raw;
        if (v == null) return null;
        if (typeof v === 'object') {
            v =
                v.text ??
                v.result ??
                (Array.isArray(v.richText) ? v.richText.map((t) => t.text).join('') : null);
            if (v == null) return null;
        }
        const s = String(v).trim();
        if (!s) return null;
        const m = /^(\d+(?:[.,]\d+)?)\s*(\*?)$/.exec(s);
        if (!m) return null;
        const level = Math.round(Number(String(m[1]).replace(',', '.')));
        if (!Number.isFinite(level)) return null;
        return { level, critical: m[2] === '*', marked: m[2] === '*' };
    }

    /**
     * Resolve a valid admin id to attribute imported assessments to.
     * skill_assessments.assessed_by is an FK → admins(id); hard-coding `1`
     * FK-violates (and rolls back the whole transactional import) whenever no
     * admin has id 1 (e.g. after a DB reset). Prefer the canonical 'admin'
     * account, else the lowest admin id; null if none (caller should skip/error).
     */
    async _resolveDefaultAssessor() {
        const a =
            (await db.get("SELECT id FROM admins WHERE username = 'admin' LIMIT 1")) ||
            (await db.get('SELECT id FROM admins ORDER BY id LIMIT 1'));
        return a ? a.id : null;
    }

    /**
     * Import a full framework from a single Excel file
     * This orchestrates the import of all components in the correct order
     */
    async importFullFramework(filepath) {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filepath);

        const results = {
            domains: { created: 0, skipped: 0, errors: [] },
            skills: { created: 0, skipped: 0, errors: [] },
            sites: { created: 0, skipped: 0, errors: [] },
            departments: { created: 0, skipped: 0, errors: [] },
            services: { created: 0, skipped: 0, errors: [] },
            roles: { created: 0, skipped: 0, errors: [] },
            // Role requirements were absent from this shape AND never counted, so
            // the operator summary and the audit entry both read "0 requirements"
            // for an import that rewrote the whole role×skill matrix.
            requirements: { created: 0, updated: 0, applied: 0, skipped: 0, errors: [] },
            employees: { created: 0, skipped: 0, errors: [] },
            // `unchanged` = an existing row whose level already matched: nothing was
            // written, and its date / assessor / notes were left exactly as stored.
            assessments: {
                created: 0,
                updated: 0,
                unchanged: 0,
                applied: 0,
                skipped: 0,
                errors: [],
            },
            credentials: [], // generated logins for newly imported employees
        };

        await db.runTransaction(async () => {
            // 1. Organization (Sites -> Departments -> Services)
            await this.importOrganization(workbook, results);

            // 2. Domains & Skills
            await this.importDomainsAndSkills(workbook, results);

            // 3. Roles & Requirements
            await this.importRolesAndRequirements(workbook, results);

            // 4. Employees & Assessments
            await this.importEmployeesAndAssessments(workbook, results);
        });

        return {
            success: true,
            results,
        };
    }

    /**
     * Helper to find a worksheet by name, trying variations
     */
    getWorksheet(workbook, names) {
        if (!Array.isArray(names)) names = [names];
        for (const name of names) {
            const sheet = workbook.getWorksheet(name);
            if (sheet) return sheet;
        }
        return null;
    }

    async importDomainsAndSkills(workbook, results) {
        const sheet = this.getWorksheet(workbook, [
            'Domains & Skills',
            'Domains_Skills',
            'Skills',
            'Data Model',
        ]);

        if (!results.domains) results.domains = { created: 0, skipped: 0, errors: [] };
        if (!results.subDomains) results.subDomains = { created: 0, skipped: 0, errors: [] };
        if (!results.skills) results.skills = { created: 0, skipped: 0, errors: [] };

        if (!sheet) return;

        // Header-aware: map columns by name so the optional Sub-Domain / Category
        // columns can appear (or not) without breaking older 3-column files.
        const col = this._headerMap(sheet, {
            domain: ['domain', 'domain name'],
            subDomain: ['sub-domain', 'sub domain', 'subdomain', 'sub-domain name'],
            skill: ['skill', 'skill name', 'name'],
            category: ['category', 'type'],
            description: ['description', 'definition'],
        });
        // Fallback to legacy fixed positions (Domain, Skill, Description) if no headers matched.
        const iDomain = col.domain || 1;
        const iSub = col.subDomain || null;
        const iSkill = col.skill || 2;
        const iCat = col.category || null;
        const iDesc = col.description || 3;

        const rows = [];
        sheet.eachRow((row, number) => {
            if (number > 1) rows.push(row.values);
        });

        for (const row of rows) {
            const domainName = row[iDomain];
            const skillName = row[iSkill];
            const subName = iSub ? row[iSub] : null;
            const category = iCat ? row[iCat] : null;
            const description = row[iDesc];

            if (!domainName || !skillName) continue;

            // Domain
            let domain = await db.get('SELECT id FROM domains WHERE name = ?', [domainName]);
            if (!domain) {
                await db.run('INSERT INTO domains (name, isActive) VALUES (?, true)', [domainName]);
                domain = await db.get('SELECT id FROM domains WHERE name = ?', [domainName]);
                results.domains.created++;
            } else {
                results.domains.skipped++;
            }

            // Sub-domain (resolve or create within this domain)
            let subDomainId = null;
            if (subName && String(subName).trim()) {
                let sub = await db.get(
                    'SELECT id FROM subDomains WHERE domainId = ? AND LOWER(name) = LOWER(?)',
                    [domain.id, String(subName).trim()]
                );
                if (!sub) {
                    await db.run(
                        'INSERT INTO subDomains (domainId, name, position, isActive) VALUES (?, ?, 999, true)',
                        [domain.id, String(subName).trim()]
                    );
                    sub = await db.get(
                        'SELECT id FROM subDomains WHERE domainId = ? AND LOWER(name) = LOWER(?)',
                        [domain.id, String(subName).trim()]
                    );
                    results.subDomains.created++;
                }
                subDomainId = sub ? sub.id : null;
            }

            // Skill — key existence on the live unique index (sub_domain_id, lower(name)),
            // falling back to (domain, name) when no sub-domain, so a re-import lands on
            // the same skill and names reused across sub-domains stay distinct.
            const skill =
                subDomainId != null
                    ? await db.get(
                          'SELECT id, subDomainId FROM skills WHERE subDomainId = ? AND LOWER(name) = LOWER(?)',
                          [subDomainId, skillName]
                      )
                    : await db.get(
                          'SELECT id, subDomainId FROM skills WHERE domainId = ? AND LOWER(name) = LOWER(?) AND subDomainId IS NULL',
                          [domain.id, skillName]
                      );
            if (!skill) {
                await db.run(
                    'INSERT INTO skills (name, domainId, subDomainId, category, description, isActive) VALUES (?, ?, ?, ?, ?, true)',
                    [
                        String(skillName).trim(),
                        domain.id,
                        subDomainId,
                        (category && String(category).trim()) || null,
                        description || '',
                    ]
                );
                results.skills.created++;
            } else {
                if (description)
                    await db.run('UPDATE skills SET description = ? WHERE id = ?', [
                        description,
                        skill.id,
                    ]);
                if (subDomainId && skill.subDomainId == null)
                    await db.run('UPDATE skills SET subDomainId = ? WHERE id = ?', [
                        subDomainId,
                        skill.id,
                    ]);
                if (category && String(category).trim())
                    await db.run('UPDATE skills SET category = ? WHERE id = ?', [
                        String(category).trim(),
                        skill.id,
                    ]);
                results.skills.skipped++;
            }
        }
    }

    /**
     * Build a { key -> 1-based column index } map from a sheet's header row,
     * matching each key's accepted header aliases case-insensitively. Lets the
     * importer tolerate added/reordered columns instead of hard-coding positions.
     */
    _headerMap(sheet, aliasSpec) {
        const out = {};
        const header = sheet.getRow(1);
        header.eachCell((cell, colNumber) => {
            const label = (cell.value == null ? '' : String(cell.value)).trim().toLowerCase();
            if (!label) return;
            for (const [key, aliases] of Object.entries(aliasSpec)) {
                if (out[key]) continue;
                if (aliases.some((a) => a.toLowerCase() === label)) out[key] = colNumber;
            }
        });
        return out;
    }

    async importOrganization(workbook, results) {
        const sheet = this.getWorksheet(workbook, [
            'Organization',
            'Organization Structure',
            'Org',
        ]);

        // Results object structure initialization (safe check)
        if (!results.sites) results.sites = { created: 0, skipped: 0, errors: [] };
        if (!results.departments) results.departments = { created: 0, skipped: 0, errors: [] };
        if (!results.services) results.services = { created: 0, skipped: 0, errors: [] };

        if (!sheet) return;

        // Skip header
        const rows = [];
        sheet.eachRow((row, number) => {
            if (number > 1) rows.push(row.values);
        });

        for (const row of rows) {
            // ExcelJS values use 1-based indexing, so row[1] is typically empty or row number
            // Adjust based on observation: row.values is [empty, col1, col2, ...]
            const siteName = row[1];
            const deptName = row[2];
            const serviceName = row[3];

            if (!siteName) continue;

            // Site
            let site = await db.get('SELECT id FROM sites WHERE name = ?', [siteName]);
            if (!site) {
                await db.run('INSERT INTO sites (name, isActive) VALUES (?, true)', [siteName]);
                site = await db.get('SELECT id FROM sites WHERE name = ?', [siteName]);
                results.sites.created++;
            } else {
                results.sites.skipped++;
            }

            // Department
            if (deptName) {
                let dept = await db.get(
                    'SELECT id FROM departments WHERE name = ? AND siteId = ?',
                    [deptName, site.id]
                );
                if (!dept) {
                    await db.run(
                        'INSERT INTO departments (name, siteId, isActive) VALUES (?, ?, true)',
                        [deptName, site.id]
                    );
                    dept = await db.get(
                        'SELECT id FROM departments WHERE name = ? AND siteId = ?',
                        [deptName, site.id]
                    );
                    results.departments.created++;
                } else {
                    results.departments.skipped++;
                }

                // Service
                if (serviceName) {
                    let service = await db.get(
                        'SELECT id FROM services WHERE name = ? AND departmentId = ?',
                        [serviceName, dept.id]
                    );
                    if (!service) {
                        await db.run(
                            'INSERT INTO services (name, departmentId, isActive) VALUES (?, ?, true)',
                            [serviceName, dept.id]
                        );
                        results.services.created++;
                    } else {
                        results.services.skipped++;
                    }
                }
            }
        }
    }

    async importRolesAndRequirements(workbook, results) {
        const sheet = this.getWorksheet(workbook, ['Roles ', 'Roles', 'Role Requirements']);

        if (!results.roles) results.roles = { created: 0, skipped: 0, errors: [] };
        // created = new rows, updated = existing rows rewritten, applied = created+updated,
        // skipped = rows in the file that could not be applied (unresolved/retired skill).
        if (!results.requirements)
            results.requirements = { created: 0, updated: 0, applied: 0, skipped: 0, errors: [] };

        if (!sheet) return;

        // Header-aware: recognise the fixed leading columns (Role Name, Description,
        // optional Role Family, Level) by name; every OTHER header is a skill column.
        // Tolerates the added Role Family column and legacy files without it.
        const firstRow = sheet.getRow(1);
        const known = { role: null, description: null, roleFamily: null, level: null };
        const knownAliases = {
            role: ['role name', 'role', 'name'],
            description: ['description'],
            roleFamily: ['role family', 'family'],
            level: ['level', 'role level'],
        };
        const skillMap = new Map(); // colIndex -> skill name
        firstRow.eachCell((cell, colNumber) => {
            const label = (cell.value == null ? '' : String(cell.value)).trim().toLowerCase();
            if (!label) return;
            let matched = null;
            for (const [key, aliases] of Object.entries(knownAliases)) {
                if (known[key] == null && aliases.includes(label)) {
                    known[key] = colNumber;
                    matched = key;
                    break;
                }
            }
            if (!matched) skillMap.set(colNumber, cell.value); // any non-fixed header = a skill
        });
        // Legacy fallback: no recognised headers → old fixed layout (Role, Desc, Level, skills 4+).
        const iRole = known.role || 1;
        const iDesc = known.description || 2;
        const iFam = known.roleFamily || null;
        if (!known.role && !known.description) {
            skillMap.clear();
            firstRow.eachCell((cell, colNumber) => {
                if (colNumber > 3) skillMap.set(colNumber, cell.value);
            });
        }

        const rows = [];
        sheet.eachRow((row, number) => {
            if (number > 1) rows.push(row);
        });

        // Is this sheet CRITICAL-AWARE? Files produced by the current export mark
        // critical requirements with a trailing "*". A legacy file (or a template)
        // carries no markers at all — there, the absence of "*" means "this file
        // does not know about criticality", NOT "not critical", so we must PRESERVE
        // the flag already stored instead of clearing 215 flags to false.
        let sheetMarksCritical = false;
        for (const row of rows) {
            for (const colIndex of skillMap.keys()) {
                const parsed = this._parseLevelCell(row.getCell(colIndex).value);
                if (parsed && parsed.marked) {
                    sheetMarksCritical = true;
                    break;
                }
            }
            if (sheetMarksCritical) break;
        }

        for (const row of rows) {
            const roleName = row.getCell(iRole).value;
            const description = row.getCell(iDesc).value;
            const roleFamily = iFam ? row.getCell(iFam).value : null;

            // Skip empty rows AND instruction/header/legend rows from template sheets
            // (otherwise "Instructions:", "1. Fill in roles…" etc. become fake roles).
            if (isNonDataRow(roleName)) continue;

            // Resolve (or create) the named role family so role_family_id round-trips.
            let roleFamilyId = null;
            const famName = roleFamily && String(roleFamily).trim();
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

            let role = await db.get(
                'SELECT id, role_family_id AS roleFamilyId FROM roles WHERE name = ?',
                [roleName]
            );
            if (!role) {
                await db.run(
                    'INSERT INTO roles (name, description, isActive) VALUES (?, ?, true)',
                    [roleName, description || '']
                );
                role = await db.get('SELECT id FROM roles WHERE name = ?', [roleName]);
                // Family via raw snake UPDATE (compat layer doesn't map roleFamilyId).
                if (roleFamilyId)
                    await db.run('UPDATE roles SET role_family_id = ? WHERE id = ?', [
                        roleFamilyId,
                        role.id,
                    ]);
                results.roles.created++;
            } else {
                if (roleFamilyId && role.roleFamilyId == null)
                    await db.run('UPDATE roles SET role_family_id = ? WHERE id = ?', [
                        roleFamilyId,
                        role.id,
                    ]);
                results.roles.skipped++;
            }

            // Process Requirements.
            // `seen` de-duplicates within ONE role: two columns can carry the same
            // skill name (duplicate headers, or two names that resolve to the same
            // active skill), and without this the second column silently replaced
            // the first — or, worse, added a phantom requirement on a retired twin.
            const seen = new Set();
            for (const [colIndex, skillName] of skillMap.entries()) {
                const parsed = this._parseLevelCell(row.getCell(colIndex).value);
                // An EMPTY cell means "this role does not require this skill".
                // A cell containing 0 is a real requirement at level 0 ("Aucun") —
                // the row is part of the department-designed skill list for the role
                // and carries its own critical flag, so it must round-trip. The old
                // `reqLevel > 0` guard silently dropped all 115 of them whenever the
                // file was restored into an empty database.
                if (!parsed) continue;
                if (parsed.level < 0 || parsed.level > 4) {
                    results.requirements.skipped++;
                    results.requirements.errors.push(
                        `Role "${roleName}" / skill "${skillName}": level ${parsed.level} out of range (0-4) — requirement skipped.`
                    );
                    continue;
                }

                // Names resolve to an ACTIVE skill only. A bare name lookup used to
                // return an arbitrary row of a duplicate group — often the
                // soft-retired twin — so an export→import round-trip resurrected the
                // retired skill and gave the role a duplicate requirement no screen
                // shows. See utils/importSkillResolver.
                const skill = await resolveActiveSkillByName(db, skillName);
                if (!skill) {
                    results.requirements.skipped++;
                    if (await isRetiredOnly(db, skillName)) {
                        results.requirements.errors.push(
                            `Role "${roleName}": skill "${skillName}" is retired (soft-deleted) — requirement skipped.`
                        );
                    } else {
                        results.requirements.errors.push(
                            `Role "${roleName}": skill "${skillName}" not found — requirement skipped.`
                        );
                    }
                    continue;
                }
                const key = String(skill.id);
                if (seen.has(key)) continue;
                seen.add(key);

                // Upsert requirement. isCritical must be carried explicitly: the old
                // INSERT omitted the column, so every Excel round-trip reset the flag
                // to its false default and 215 critical requirements became ordinary.
                const existing = await db.get(
                    'SELECT id, isCritical FROM roleSkillRequirements WHERE roleId = ? AND skillId = ?',
                    [role.id, skill.id]
                );
                const isCritical = sheetMarksCritical
                    ? parsed.critical
                    : existing
                      ? !!existing.isCritical
                      : false; // legacy sheet → preserve
                await db.run('DELETE FROM roleSkillRequirements WHERE roleId = ? AND skillId = ?', [
                    role.id,
                    skill.id,
                ]);
                await db.run(
                    'INSERT INTO roleSkillRequirements (roleId, skillId, requiredLevel, isCritical) VALUES (?, ?, ?, ?)',
                    [role.id, skill.id, parsed.level, isCritical]
                );
                // True counts: the summary and the audit entry previously reported
                // "0 requirements" while rewriting the whole matrix (~1,932 rows).
                if (existing) results.requirements.updated++;
                else results.requirements.created++;
                results.requirements.applied++;
            }
        }
    }

    async importEmployeesAndAssessments(workbook, results) {
        const sheet = this.getWorksheet(workbook, [
            'Employees',
            'Employee Directory',
            'Employees_Live',
        ]);

        if (!results.employees) results.employees = { created: 0, skipped: 0, errors: [] };
        if (!results.assessments)
            results.assessments = {
                created: 0,
                updated: 0,
                unchanged: 0,
                applied: 0,
                skipped: 0,
                errors: [],
            };
        if (results.assessments.unchanged == null) results.assessments.unchanged = 0;

        if (!sheet) return;

        // Resolve the assessor admin once for this import (fresh each call).
        this._defaultAssessor = await this._resolveDefaultAssessor();

        // Format is: [EmpID, First, Last, Email, Site, Dept, Service, Role, ...Skills]
        const firstRow = sheet.getRow(1);
        const skillMap = new Map();

        // Skills start from column 9 (I)
        firstRow.eachCell((cell, colNumber) => {
            if (colNumber > 8) {
                skillMap.set(colNumber, cell.value);
            }
        });

        const rows = [];
        sheet.eachRow((row, number) => {
            if (number > 1) rows.push(row);
        });

        for (const row of rows) {
            const empId = row.getCell(1).value;
            const firstName = row.getCell(2).value;
            const lastName = row.getCell(3).value;
            const email = row.getCell(4).value;
            const siteName = row.getCell(5).value;
            const deptName = row.getCell(6).value;
            const serviceName = row.getCell(7).value;
            const roleName = row.getCell(8).value;

            if (!firstName || !lastName || !empId) continue;

            // Resolve Foreign Keys (case-insensitive — aligns with preview matching
            // and forgives casing differences between the org rows and this sheet).
            let siteId = null,
                deptId = null,
                serviceId = null,
                roleId = null;

            if (siteName) {
                const site = await db.get('SELECT id FROM sites WHERE LOWER(name) = LOWER(?)', [
                    siteName,
                ]);
                if (site) siteId = site.id;
            }
            if (deptName && siteId) {
                const dept = await db.get(
                    'SELECT id FROM departments WHERE LOWER(name) = LOWER(?) AND siteId = ?',
                    [deptName, siteId]
                );
                if (dept) deptId = dept.id;
            }
            if (serviceName && deptId) {
                const service = await db.get(
                    'SELECT id FROM services WHERE LOWER(name) = LOWER(?) AND departmentId = ?',
                    [serviceName, deptId]
                );
                if (service) serviceId = service.id;
            }
            if (roleName) {
                const role = await db.get('SELECT id FROM roles WHERE LOWER(name) = LOWER(?)', [
                    roleName,
                ]);
                if (role) roleId = role.id;
            }

            // Upsert Employee
            let employee = await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                empId,
            ]);
            if (!employee) {
                // site/dept/service/role are NOT NULL — a NEW employee needs all four
                // resolved. Skip-with-error instead of inserting null (which would
                // 23502 and abort the ENTIRE import); good rows still import.
                const missing = [];
                if (!siteId) missing.push(`site "${siteName || ''}"`);
                if (!deptId) missing.push(`department "${deptName || ''}"`);
                if (!serviceId) missing.push(`service "${serviceName || ''}"`);
                if (!roleId) missing.push(`role "${roleName || ''}"`);
                if (missing.length) {
                    results.employees.skipped++;
                    (results.errors = results.errors || []).push(
                        `Employee ${empId}: could not resolve ${missing.join(', ')} — create them first or fix the names. Row skipped.`
                    );
                    continue;
                }
                await db.run(
                    `INSERT INTO employees (employeeNumber, firstName, lastName, email, siteId, departmentId, serviceId, roleId, isActive)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, true)`,
                    [empId, firstName, lastName, email || null, siteId, deptId, serviceId, roleId]
                );
                employee = await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                    empId,
                ]);
                results.employees.created++;

                // Provision a login for the new employee (generated temp password).
                const isTaken = async (name) => {
                    const e = await db.get('SELECT id FROM employees WHERE username = ?', [name]);
                    const a = await db.get('SELECT id FROM admins WHERE username = ?', [name]);
                    return Boolean(e || a);
                };
                const username = await uniqueUsername(
                    baseUsername({ firstName, lastName, employeeNumber: empId }),
                    isTaken
                );
                const password = generatePassword();
                const hash = await bcrypt.hash(password, 10);
                await db.run(
                    'UPDATE employees SET username = ?, password_hash = ?, is_account_active = true, force_password_change = true WHERE id = ?',
                    [username, hash, employee.id]
                );
                if (results.credentials) {
                    results.credentials.push({
                        type: 'employee',
                        employeeNumber: empId,
                        name: `${firstName} ${lastName}`,
                        username,
                        password,
                    });
                }
            } else {
                // EXISTING employee: only overwrite an org FK when the sheet provided
                // a name that RESOLVED — never null out a NOT-NULL column because a
                // cell was blank or unmatched. Name/email always updated.
                const sets = ['firstName=?', 'lastName=?', 'email=?'];
                const vals = [firstName, lastName, email || null];
                if (siteId) {
                    sets.push('siteId=?');
                    vals.push(siteId);
                }
                if (deptId) {
                    sets.push('departmentId=?');
                    vals.push(deptId);
                }
                if (serviceId) {
                    sets.push('serviceId=?');
                    vals.push(serviceId);
                }
                if (roleId) {
                    sets.push('roleId=?');
                    vals.push(roleId);
                }
                vals.push(employee.id);
                await db.run(`UPDATE employees SET ${sets.join(', ')} WHERE id=?`, vals);
                results.employees.skipped++;
            }

            // Assessments — iterate over skill columns.
            // `seenSkills` de-duplicates: two columns can resolve to the same active
            // skill, and the last one silently won.
            const seenSkills = new Set();
            for (const [colIndex, skillName] of skillMap.entries()) {
                const parsed = this._parseLevelCell(row.getCell(colIndex).value);
                if (!parsed) continue; // blank cell = "not assessed" (distinct from level 0)
                const cleanLevel = parsed.level;
                // levels are 0–4; reject out-of-range so bad cells don't pollute readiness/gaps.
                // 0 is a VALID rating ("Aucun") and must survive the round-trip.
                if (!(cleanLevel >= 0 && cleanLevel <= 4)) {
                    results.assessments.skipped++;
                    results.assessments.errors.push(
                        `Employee ${empId}: level ${cleanLevel} for "${skillName}" out of range (0-4) — skipped.`
                    );
                    continue;
                }
                // Active-skill resolution: a bare name lookup could land on a
                // soft-retired twin and write an assessment no screen shows.
                const skill = await resolveActiveSkillByName(db, skillName);
                if (!skill) {
                    results.assessments.skipped++;
                    results.assessments.errors.push(
                        (await isRetiredOnly(db, skillName))
                            ? `Employee ${empId}: skill "${skillName}" is retired (soft-deleted) — assessment skipped.`
                            : `Employee ${empId}: skill "${skillName}" not found — assessment skipped.`
                    );
                    continue;
                }
                if (!this._defaultAssessor) {
                    results.assessments.skipped++;
                    continue;
                }
                const key = String(skill.id);
                if (seenSkills.has(key)) continue;
                seenSkills.add(key);

                // The matrix layout carries ONE cell per skill: the level. It has no
                // date, assessor or notes column, so it can never supply them. The old
                // DELETE + INSERT therefore re-created every assessment as "assessed
                // today, by the default admin, no notes" — a plain export -> re-import
                // with no edits destroyed the history: measured on a clone, 2 712 rows
                // restamped to today, 175 notes lost, every assessor re-attributed.
                //
                // Same rule as the sibling importAssessments: a row whose level already
                // matches is not written at all; a changed level is an UPDATE that
                // COALESCEs to the stored assessor and notes when the file does not
                // carry them (`carried` is where a future column would land), and takes
                // the current time as the date of that change.
                const carried = { assessedBy: null, notes: null, assessedAt: null };
                const existingAss = await db.get(
                    'SELECT id, currentLevel FROM skillAssessments WHERE employeeId = ? AND skillId = ?',
                    [employee.id, skill.id]
                );
                if (existingAss) {
                    if (Number(existingAss.currentLevel) === cleanLevel) {
                        results.assessments.unchanged++;
                        continue;
                    }
                    await db.run(
                        `UPDATE skillAssessments
                            SET currentLevel = ?,
                                assessedBy = COALESCE(?, assessedBy),
                                notes = COALESCE(?, notes),
                                assessedAt = COALESCE(?::timestamptz, CURRENT_TIMESTAMP)
                          WHERE id = ?`,
                        [
                            cleanLevel,
                            carried.assessedBy,
                            carried.notes,
                            carried.assessedAt,
                            existingAss.id,
                        ]
                    );
                    results.assessments.updated++;
                } else {
                    await db.run(
                        `INSERT INTO skillAssessments (employeeId, skillId, currentLevel, assessedBy, assessedAt, notes)
                            VALUES (?, ?, ?, ?, datetime('now'), NULL)`,
                        [employee.id, skill.id, cleanLevel, this._defaultAssessor]
                    );
                    results.assessments.created++;
                }
                results.assessments.applied++;
            }
        }
    }

    async processRoleAndReq(roleName, row, skillIds, results) {
        // Dummy helper if needed
    }

    /**
     * Dedicated import for assessments from Excel
     */
    async importAssessments(filepath) {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filepath);
        const sheet = workbook.getWorksheet('Assessments');
        if (!sheet) throw new Error('Missing sheet: Assessments');

        const results = {
            processed: 0,
            created: 0,
            updated: 0,
            errors: [],
        };

        const { buildAdminMaps, resolveAssessorId } = require('../utils/assessorRef');
        const defaultAssessor = await this._resolveDefaultAssessor();
        const { byName: adminByName, byId: adminById } = await buildAdminMaps();

        // Header-driven column mapping: read by column NAME, not fixed position,
        // so BOTH the 6-column template AND the 9-column export (with extra
        // Employee Name / Domain / Date columns) round-trip. Tolerant of reordered
        // or extra columns.
        const cellText = (row, idx) => {
            if (!idx) return '';
            const v = row.getCell(idx).value;
            if (v == null) return '';
            if (typeof v === 'object')
                return String(
                    v.text ?? v.result ?? v.richText?.map((t) => t.text).join('') ?? ''
                ).trim();
            return String(v).trim();
        };
        // Dates arrive from ExcelJS as a Date, as an Excel serial number, as a
        // formula result, or as plain text depending on how the cell was authored.
        // Anything unreadable yields null, and the caller falls back to now — the
        // old behaviour becomes the fallback rather than the rule.
        const cellDate = (row, idx) => {
            if (!idx) return null;
            const v = row.getCell(idx).value;
            if (v == null || v === '') return null;
            const ok = (d) =>
                d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
            if (v instanceof Date) return ok(v);
            if (typeof v === 'number') {
                // Excel serial date: days since 1899-12-30.
                return ok(new Date(Math.round((v - 25569) * 86400000)));
            }
            if (typeof v === 'object') {
                if (v.result instanceof Date) return ok(v.result);
                const t = String(v.text ?? v.result ?? '').trim();
                return t ? ok(new Date(t)) : null;
            }
            const t = String(v).trim();
            return t ? ok(new Date(t)) : null;
        };
        const headerRow = sheet.getRow(1);
        const colIx = {};
        headerRow.eachCell((cell, col) => {
            const h = String(cell.value ?? '')
                .trim()
                .toLowerCase();
            if (/skill\s*id/.test(h) && colIx.skillId == null) colIx.skillId = col;
            else if (/employee\s*(number|#|id)/.test(h) && colIx.emp == null) colIx.emp = col;
            else if (/skill/.test(h) && colIx.skill == null) colIx.skill = col;
            else if (/^domain$/.test(h) && colIx.domain == null) colIx.domain = col;
            else if (/current\s*level|^level$/.test(h) && colIx.level == null) colIx.level = col;
            else if (/assessed\s*by|assessor/.test(h) && colIx.by == null) colIx.by = col;
            // The export writes an "Assessed At" column; nothing read it back, so
            // every re-imported row was stamped now. "Export -> correct -> re-import"
            // therefore reset the entire assessment history to today, and the manager
            // "stale assessments" view, v_skill_currency and certification freshness
            // all silently went green.
            else if (/assessed\s*at|^date$/.test(h) && colIx.at == null) colIx.at = col;
            else if (/^notes?$/.test(h) && colIx.notes == null) colIx.notes = col;
        });
        if (colIx.emp == null || colIx.skill == null || colIx.level == null) {
            throw new Error(
                'Assessments sheet is missing required columns (Employee Number, Skill Name, Current Level)'
            );
        }

        await db.runTransaction(async () => {
            const rows = [];
            sheet.eachRow((row, rowNum) => {
                if (rowNum > 1) rows.push(row);
            });

            for (const row of rows) {
                const empNum = cellText(row, colIx.emp);
                const skillIdCell = cellText(row, colIx.skillId);
                const skillName = cellText(row, colIx.skill);
                const domainName = cellText(row, colIx.domain);
                const currentLevel = parseInt(cellText(row, colIx.level), 10);
                const assessedByNum = cellText(row, colIx.by);
                const assessedAt = cellDate(row, colIx.at); // null → now() at the write
                const notes = cellText(row, colIx.notes);

                if (!empNum || !skillName || isNaN(currentLevel)) {
                    // Skip fully-blank trailing rows silently; report partial rows.
                    if (empNum || skillName)
                        results.errors.push(
                            `Row ${row.number}: Missing required fields (Employee #, Skill Name, Level)`
                        );
                    continue;
                }
                if (currentLevel < 0 || currentLevel > 4) {
                    results.errors.push(
                        `Row ${row.number}: Level ${currentLevel} out of range (0-4)`
                    );
                    continue;
                }

                results.processed++;

                // Find employee
                const employee = await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                    empNum,
                ]);
                if (!employee) {
                    results.errors.push(`Row ${row.number}: Employee "${empNum}" not found`);
                    continue;
                }

                // Find skill. Prefer the stable Skill ID (exact same skill, incl.
                // retired duplicates — an explicit id is a deliberate reference) →
                // then (name, domain) → then name-only, so a re-imported EXPORT is
                // idempotent while a TEMPLATE (names only) still works. NAME lookups
                // resolve to ACTIVE skills only: an unqualified name matches any row
                // of a duplicate group, retired twins included.
                const skill = await resolveSkillByIdOrName(db, skillIdCell, skillName, domainName);
                if (!skill) {
                    results.errors.push(
                        (await isRetiredOnly(db, skillName))
                            ? `Row ${row.number}: Skill "${skillName}" is retired (soft-deleted) — row skipped`
                            : `Row ${row.number}: Skill "${skillName || skillIdCell}"${domainName ? ` (domain "${domainName}")` : ''} not found`
                    );
                    continue;
                }

                // Assessor is an admins.id. Resolve the label to an admin (never an
                // employees.id — that column FKs admins), falling back to a real
                // default admin so a re-import never FK-violates.
                const assessorId = resolveAssessorId(
                    assessedByNum,
                    adminByName,
                    adminById,
                    defaultAssessor
                );
                if (!assessorId) {
                    results.errors.push(
                        `Row ${row.number}: no valid assessor admin found — cannot attribute assessment`
                    );
                    continue;
                }

                // Check if assessment already exists
                const existing = await db.get(
                    'SELECT id FROM skillAssessments WHERE employeeId = ? AND skillId = ?',
                    [employee.id, skill.id]
                );

                if (existing) {
                    await db.run(
                        `UPDATE skillAssessments 
                         SET currentLevel = ?, assessedBy = ?, notes = ?, assessedAt = COALESCE(?::timestamptz, now())
                         WHERE id = ?`,
                        [currentLevel, assessorId, notes || null, assessedAt, existing.id]
                    );
                    results.updated++;
                } else {
                    await db.run(
                        `INSERT INTO skillAssessments (employeeId, skillId, currentLevel, assessedBy, notes, assessedAt)
                         VALUES (?, ?, ?, ?, ?, COALESCE(?::timestamptz, now()))`,
                        [employee.id, skill.id, currentLevel, assessorId, notes || null, assessedAt]
                    );
                    results.created++;
                }
            }
        });

        return { success: true, results };
    }

    /**
     * Import assessments from the JSON export shape produced by
     * UnifiedExportService.exportAssessmentsJSON:
     *   [{ skillId, employeeNumber, skillName, domainName, currentLevel,
     *      assessor, assessedAt, notes }, ...]
     * Mirrors the Excel importer: employee by number, skill by id→(name,domain)→
     * name, assessor resolved to an admins.id (fallback = the importing admin).
     */
    async importAssessmentsJSON(jsonData, importerAdminId = null) {
        const { buildAdminMaps, resolveAssessorId } = require('../utils/assessorRef');
        const list = Array.isArray(jsonData)
            ? jsonData
            : jsonData && Array.isArray(jsonData.assessments)
              ? jsonData.assessments
              : [];
        const results = { processed: 0, created: 0, updated: 0, errors: [] };
        const defaultAssessor =
            importerAdminId != null
                ? Number(importerAdminId)
                : await this._resolveDefaultAssessor();
        const { byName: adminByName, byId: adminById } = await buildAdminMaps();

        await db.runTransaction(async () => {
            for (const item of list) {
                const empNum =
                    item.employeeNumber != null ? String(item.employeeNumber).trim() : '';
                const skillName = item.skillName != null ? String(item.skillName).trim() : '';
                const domainName = item.domainName != null ? String(item.domainName).trim() : '';
                const skillIdCell = item.skillId != null ? String(item.skillId).trim() : '';
                const currentLevel = parseInt(item.currentLevel ?? item.level, 10);
                const notes = item.notes != null ? String(item.notes) : null;

                if (!empNum || (!skillName && !skillIdCell) || isNaN(currentLevel)) {
                    if (empNum || skillName || skillIdCell)
                        results.errors.push(
                            `Employee "${empNum}", skill "${skillName || skillIdCell}": missing required fields`
                        );
                    continue;
                }
                if (currentLevel < 0 || currentLevel > 4) {
                    results.errors.push(
                        `Employee "${empNum}", skill "${skillName}": level ${currentLevel} out of range (0-4)`
                    );
                    continue;
                }
                results.processed++;

                const employee = await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                    empNum,
                ]);
                if (!employee) {
                    results.errors.push(`Employee "${empNum}" not found`);
                    continue;
                }

                // Explicit id wins (exact row); NAME lookups resolve to ACTIVE skills
                // only so a retired duplicate is never written to.
                const skill = await resolveSkillByIdOrName(db, skillIdCell, skillName, domainName);
                if (!skill) {
                    results.errors.push(
                        (await isRetiredOnly(db, skillName))
                            ? `Skill "${skillName}" is retired (soft-deleted) — row skipped`
                            : `Skill "${skillName || skillIdCell}" not found`
                    );
                    continue;
                }

                const assessorId = resolveAssessorId(
                    item.assessor,
                    adminByName,
                    adminById,
                    defaultAssessor
                );
                if (!assessorId) {
                    results.errors.push(`Employee "${empNum}": no valid assessor admin found`);
                    continue;
                }

                // Honour the assessment date carried by the file; an absent or
                // unreadable one falls back to now at the write.
                const rawAt = item.assessedAt ?? item.assessed_at ?? item.date ?? null;
                const parsedAt = rawAt ? new Date(rawAt) : null;
                const assessedAt =
                    parsedAt && !Number.isNaN(parsedAt.getTime()) ? parsedAt.toISOString() : null;

                const existing = await db.get(
                    'SELECT id FROM skillAssessments WHERE employeeId = ? AND skillId = ?',
                    [employee.id, skill.id]
                );
                if (existing) {
                    await db.run(
                        `UPDATE skillAssessments SET currentLevel = ?, assessedBy = ?, notes = ?, assessedAt = COALESCE(?::timestamptz, now()) WHERE id = ?`,
                        [currentLevel, assessorId, notes, assessedAt, existing.id]
                    );
                    results.updated++;
                } else {
                    await db.run(
                        `INSERT INTO skillAssessments (employeeId, skillId, currentLevel, assessedBy, notes, assessedAt) VALUES (?, ?, ?, ?, ?, COALESCE(?::timestamptz, now()))`,
                        [employee.id, skill.id, currentLevel, assessorId, notes, assessedAt]
                    );
                    results.created++;
                }
            }
        });

        return { success: true, results };
    }
}

module.exports = new UnifiedImportService();
