/**
 * Bulk Data Service
 * Import/Export data in Excel format compatible with datamodel.xlsx
 */

const ExcelJS = require('exceljs');
const db = require('../config/database');
const path = require('path');
const { isNonDataRow } = require('../utils/importGuards');
const { resolveActiveSkillByName } = require('../utils/importSkillResolver');

class BulkDataService {
    /**
     * Export database to Excel (datamodel.xlsx format)
     */
    async exportToExcel() {
        const workbook = new ExcelJS.Workbook();

        // Sheet 1: Employee Directory & Skills
        await this.createEmployeeSheet(workbook);

        // Sheet 2: Role Requirements
        await this.createRoleRequirementsSheet(workbook);

        // Sheet 3: Data Model
        await this.createDataModelSheet(workbook);

        // Save file
        const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
        const filename = `export_${timestamp}.xlsx`;
        const filepath = path.join(__dirname, '../../tmp', filename);

        await workbook.xlsx.writeFile(filepath);

        return {
            filepath,
            filename,
        };
    }

    /**
     * Create Employee Directory & Skills sheet
     */
    async createEmployeeSheet(workbook) {
        const sheet = workbook.addWorksheet('Employee Directory & Skills');

        // Get all skills for columns
        const skills = await db.all('SELECT id, name FROM skills WHERE isActive = 1 ORDER BY name');

        // Headers
        const headers = [
            'Employee Number',
            'First Name',
            'Last Name',
            'Service',
            'Position',
            'Site',
            'Department',
            ...skills.map((s) => s.name),
        ];

        sheet.addRow(headers);

        // Style header row
        sheet.getRow(1).font = { bold: true };
        sheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFD9D9D9' },
        };

        // Get employees with skills
        const employees = await db.all(`
            SELECT e.*, 
                   s.name as siteName,
                   d.name as deptName,
                   sv.name as serviceName,
                   r.name as roleName
            FROM employees e
            LEFT JOIN sites s ON e.siteId = s.id
            LEFT JOIN departments d ON e.departmentId = d.id
            LEFT JOIN services sv ON e.serviceId = sv.id
            LEFT JOIN roles r ON e.roleId = r.id
            WHERE e.isActive = 1
            ORDER BY e.lastName, e.firstName
        `);

        // Add employee data
        for (const emp of employees) {
            const row = [
                emp.employeeNumber,
                emp.firstName,
                emp.lastName,
                emp.serviceName,
                emp.roleName,
                emp.siteName,
                emp.deptName,
            ];

            // Add skill assessments
            for (const skill of skills) {
                const assessment = await db.get(
                    `SELECT currentLevel FROM skillAssessments 
                     WHERE employeeId = ? AND skillId = ?
                     ORDER BY assessedAt DESC LIMIT 1`,
                    [emp.id, skill.id]
                );
                row.push(assessment ? assessment.currentLevel : '');
            }

            sheet.addRow(row);
        }

        // Auto-fit columns
        sheet.columns.forEach((column) => {
            column.width = 15;
        });
    }

    /**
     * Create Role Requirements sheet
     */
    async createRoleRequirementsSheet(workbook) {
        const sheet = workbook.addWorksheet('Role Requirements');

        // Get all skills and domains
        const skills = await db.all(`
            SELECT s.id, s.name, d.name as domainName
            FROM skills s
            LEFT JOIN domains d ON s.domainId = d.id
            WHERE s.isActive = 1
            ORDER BY d.name, s.name
        `);

        // Row 1: Domain names
        const domainRow = ['Domain'];
        const skillRow = ['Role'];

        for (const skill of skills) {
            domainRow.push(skill.domainName || '');
            skillRow.push(skill.name);
        }

        sheet.addRow(domainRow);
        sheet.addRow(skillRow);

        // Style headers
        sheet.getRow(1).font = { bold: true, color: { argb: 'FF0070C0' } };
        sheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE7E6E6' },
        };

        sheet.getRow(2).font = { bold: true };
        sheet.getRow(2).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFD9D9D9' },
        };

        // Get roles with requirements
        const roles = await db.all('SELECT id, name FROM roles WHERE isActive = 1 ORDER BY name');

        for (const role of roles) {
            const row = [role.name];

            // Get requirements for each skill
            for (const skill of skills) {
                const req = await db.get(
                    `SELECT requiredLevel FROM roleSkillRequirements 
                     WHERE roleId = ? AND skillId = ?`,
                    [role.id, skill.id]
                );
                row.push(req ? req.requiredLevel : '');
            }

            sheet.addRow(row);
        }

        // Auto-fit columns
        sheet.columns.forEach((column) => {
            column.width = 15;
        });
    }

    /**
     * Create Data Model sheet
     */
    async createDataModelSheet(workbook) {
        const sheet = workbook.addWorksheet('Data Model');

        // Add metadata about the export
        sheet.addRow(['Data Model Export']);
        sheet.addRow(['Export Date', new Date().toISOString()]);
        sheet.addRow([]);

        sheet.addRow(['Table', 'Record Count']);
        sheet.getRow(4).font = { bold: true };

        // Add table statistics
        const tables = [
            'sites',
            'departments',
            'services',
            'domains',
            'roles',
            'skills',
            'employees',
        ];

        for (const table of tables) {
            const result = await db.get(`SELECT COUNT(*) as count FROM ${table}`);
            sheet.addRow([table, result.count]);
        }

        sheet.columns.forEach((column) => {
            column.width = 20;
        });
    }

    /**
     * Import data from Excel file
     */
    async importFromExcel(filepath, options = {}) {
        const workbook = new ExcelJS.Workbook();
        require('../utils/importGuards').assertSafeXlsxFile(filepath); // zip-bomb guard (SA-09)
        await workbook.xlsx.readFile(filepath);

        const results = {
            sites: 0,
            departments: 0,
            services: 0,
            domains: 0,
            roles: 0,
            skills: 0,
            employees: 0,
            roleRequirements: 0,
            skillAssessments: 0,
            errors: [],
        };

        await db.runTransaction(async () => {
            // Ensure base data exists
            await this.ensureBaseData();

            // Import Role Requirements first
            if (workbook.getWorksheet('Role Requirements')) {
                await this.importRoleRequirements(workbook, results);
            }

            // Import Employee Directory
            if (workbook.getWorksheet('Employee Directory & Skills')) {
                await this.importEmployees(workbook, results);
            }
        });

        return {
            success: true,
            results,
        };
    }

    /**
     * Ensure base data exists (site, department, service, domain)
     */
    async ensureBaseData() {
        // Ensure site
        let site = await db.get('SELECT id FROM sites LIMIT 1');
        if (!site) {
            await db.run('INSERT INTO sites (name, isActive) VALUES (?, ?)', ['Main Site', 1]);
            site = await db.get('SELECT id FROM sites LIMIT 1');
        }

        // Ensure department
        let dept = await db.get('SELECT id FROM departments LIMIT 1');
        if (!dept) {
            await db.run('INSERT INTO departments (name, siteId, isActive) VALUES (?, ?, ?)', [
                'IT',
                site.id,
                1,
            ]);
            dept = await db.get('SELECT id FROM departments LIMIT 1');
        }

        // Ensure service
        let service = await db.get('SELECT id FROM services LIMIT 1');
        if (!service) {
            await db.run('INSERT INTO services (name, departmentId, isActive) VALUES (?, ?, ?)', [
                'General',
                dept.id,
                1,
            ]);
        }

        // Ensure domain
        let domain = await db.get('SELECT id FROM domains LIMIT 1');
        if (!domain) {
            await db.run('INSERT INTO domains (name, isActive) VALUES (?, ?)', ['Technical', 1]);
        }
    }

    /**
     * Import role requirements from Excel
     */
    async importRoleRequirements(workbook, results) {
        const sheet = workbook.getWorksheet('Role Requirements');
        const rows = [];

        sheet.eachRow((row, rowNum) => {
            rows.push(row.values);
        });

        if (rows.length < 3) return;

        const skillNames = rows[1].slice(2); // Skip first column
        const skillIds = [];

        // Ensure domain exists
        const domain = await db.get('SELECT id FROM domains LIMIT 1');

        // Create/get skills. skillIds MUST stay index-aligned with skillNames —
        // the level cell is read as row[j + 2] — so an unusable column pushes null
        // instead of being skipped (skipping shifted every later skill by one and
        // wrote requirements against the wrong skill).
        for (const skillName of skillNames) {
            if (!skillName) {
                skillIds.push(null);
                continue;
            }

            // Resolve to an ACTIVE skill: duplicate skill groups were merged by
            // soft-retire, and a bare name match could return the retired twin —
            // creating requirements on a skill no screen displays.
            let skill = await resolveActiveSkillByName(db, skillName);
            if (!skill) {
                await db.run('INSERT INTO skills (name, domainId, isActive) VALUES (?, ?, ?)', [
                    skillName,
                    domain.id,
                    1,
                ]);
                skill = await resolveActiveSkillByName(db, skillName);
                results.skills++;
            }
            skillIds.push(skill ? skill.id : null);
        }

        // Process roles (starting from row 3)
        for (let i = 2; i < rows.length; i++) {
            const row = rows[i];
            const roleName = row[1];

            // Skip empty + instruction/header rows so template prose never becomes a role.
            if (isNonDataRow(roleName)) continue;

            // Create/get role
            let role = await db.get('SELECT id FROM roles WHERE name = ?', [roleName]);
            if (!role) {
                await db.run('INSERT INTO roles (name, isActive) VALUES (?, ?)', [roleName, 1]);
                role = await db.get('SELECT id FROM roles WHERE name = ?', [roleName]);
                results.roles++;
            }

            // Add requirements
            for (let j = 0; j < skillIds.length; j++) {
                if (skillIds[j] == null) continue;
                const level = Number(row[j + 2]);
                if (
                    row[j + 2] != null &&
                    row[j + 2] !== '' &&
                    Number.isFinite(level) &&
                    level >= 1 &&
                    level <= 4
                ) {
                    // Delete existing requirement
                    await db.run(
                        'DELETE FROM roleSkillRequirements WHERE roleId = ? AND skillId = ?',
                        [role.id, skillIds[j]]
                    );

                    // Insert new requirement
                    await db.run(
                        `INSERT INTO roleSkillRequirements (roleId, skillId, requiredLevel) 
                         VALUES (?, ?, ?)`,
                        [role.id, skillIds[j], level]
                    );
                    results.roleRequirements++;
                }
            }
        }
    }

    /**
     * Import employees from Excel
     */
    async importEmployees(workbook, results) {
        const sheet = workbook.getWorksheet('Employee Directory & Skills');
        const rows = [];

        sheet.eachRow((row, rowNum) => {
            rows.push(row.values);
        });

        if (rows.length < 2) return;

        const headers = rows[0];
        const skillStartIndex = 7; // Skills start after basic fields
        const skillNames = headers.slice(skillStartIndex);

        // Get default IDs
        const site = await db.get('SELECT id FROM sites LIMIT 1');
        const dept = await db.get('SELECT id FROM departments LIMIT 1');
        const defaultService = await db.get('SELECT id FROM services LIMIT 1');
        const defaultRole = await db.get('SELECT id FROM roles LIMIT 1');
        if (!site || !dept || !defaultRole) {
            throw new Error(
                'Cannot import employees: base data missing (need at least one site, department and role). Run ensureBaseData() first.'
            );
        }
        // assessed_by is an FK → admins(id); resolve a real assessor instead of
        // hard-coding 1 (which FK-violates on a DB without admin id 1).
        const assessor =
            (await db.get("SELECT id FROM admins WHERE username = 'admin' LIMIT 1")) ||
            (await db.get('SELECT id FROM admins ORDER BY id LIMIT 1'));
        const assessorId = assessor ? assessor.id : null;

        // Process employees (starting from row 2)
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];

            const empNumber = row[1];
            const firstName = row[2];
            const lastName = row[3];
            const serviceName = row[4];

            if (!firstName || !lastName) continue;

            // Get/create service
            let service = defaultService;
            if (serviceName) {
                service = await db.get('SELECT id FROM services WHERE name = ?', [serviceName]);
                if (!service) {
                    await db.run(
                        'INSERT INTO services (name, departmentId, isActive) VALUES (?, ?, ?)',
                        [serviceName, dept.id, 1]
                    );
                    service = await db.get('SELECT id FROM services WHERE name = ?', [serviceName]);
                    results.services++;
                }
            }

            // Create/update employee
            let employee = await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                empNumber,
            ]);
            if (!employee) {
                await db.run(
                    `INSERT INTO employees (employeeNumber, firstName, lastName, siteId, departmentId, serviceId, roleId, isActive)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        empNumber,
                        firstName,
                        lastName,
                        site.id,
                        dept.id,
                        service.id,
                        defaultRole.id,
                        1,
                    ]
                );
                employee = await db.get('SELECT id FROM employees WHERE employeeNumber = ?', [
                    empNumber,
                ]);
                results.employees++;
            }

            // Import skill assessments
            for (let j = 0; j < skillNames.length; j++) {
                const skillName = skillNames[j];
                const level = row[skillStartIndex + j];

                // Level 0 ("Aucun") is a RATING, not a blank — `level &&` dropped
                // every level-0 assessment, the strongest gap signal and the input
                // to the IDP/PIP auto-triggers. Test the cell for emptiness, then
                // accept the full 0-4 scale.
                const num = Number(level);
                const hasValue =
                    level !== null && level !== undefined && String(level).trim() !== '';
                if (skillName && hasValue && Number.isFinite(num) && num >= 0 && num <= 4) {
                    // Active-skill resolution — never write onto a soft-retired twin.
                    const skill = await resolveActiveSkillByName(db, skillName);
                    if (skill) {
                        // Delete existing assessment
                        await db.run(
                            'DELETE FROM skillAssessments WHERE employeeId = ? AND skillId = ?',
                            [employee.id, skill.id]
                        );

                        // Insert new assessment
                        await db.run(
                            `INSERT INTO skillAssessments (employeeId, skillId, currentLevel, assessedBy, assessedAt)
                             VALUES (?, ?, ?, ?, datetime('now'))`,
                            [employee.id, skill.id, num, assessorId]
                        );
                        results.skillAssessments++;
                    }
                }
            }
        }
    }

    /**
     * Validate Excel file
     */
    async validateExcelFile(filepath) {
        try {
            const workbook = new ExcelJS.Workbook();
            require('../utils/importGuards').assertSafeXlsxFile(filepath); // zip-bomb guard (SA-09)
            await workbook.xlsx.readFile(filepath);

            const errors = [];
            const warnings = [];

            // Check required sheets
            if (!workbook.getWorksheet('Employee Directory & Skills')) {
                errors.push('Missing required sheet: Employee Directory & Skills');
            }

            if (!workbook.getWorksheet('Role Requirements')) {
                warnings.push('Missing sheet: Role Requirements (optional)');
            }

            // Validate structure
            const empSheet = workbook.getWorksheet('Employee Directory & Skills');
            if (empSheet) {
                const rows = [];
                empSheet.eachRow((row) => rows.push(row.values));

                if (rows.length < 2) {
                    errors.push('Employee Directory sheet has no data');
                }
            }

            return {
                valid: errors.length === 0,
                errors,
                warnings,
            };
        } catch (error) {
            return {
                valid: false,
                errors: [`Invalid Excel file: ${error.message}`],
                warnings: [],
            };
        }
    }
}

module.exports = new BulkDataService();
