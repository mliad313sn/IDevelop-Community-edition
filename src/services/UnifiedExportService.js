const PRODUCT = require('../config/product');
const ExcelJS = require('exceljs');
const db = require('../config/database');

class UnifiedExportService {
    async exportFullSystem() {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = PRODUCT.name;
        workbook.created = new Date();

        // 1. Organization Sheet (Sites, Depts, Services)
        await this.addOrganizationSheet(workbook);

        // 2. Domains & Skills Sheet
        await this.addDomainsSkillsSheet(workbook);

        // 3. Roles Sheet (with Requirements)
        await this.addRolesSheet(workbook);

        // 4. Employees Sheet (with Assessments)
        await this.addEmployeesSheet(workbook);

        return workbook;
    }

    async addOrganizationSheet(workbook) {
        const sheet = workbook.addWorksheet('Organization');

        // Headers
        sheet.columns = [
            { header: 'Site', key: 'site', width: 25 },
            { header: 'Department', key: 'department', width: 25 },
            { header: 'Service', key: 'service', width: 25 },
        ];

        // Fetch all services with their hierarchy
        const rows = await db.all(`
            SELECT s.name as siteName, d.name as deptName, sv.name as serviceName
            FROM services sv
            JOIN departments d ON sv.departmentId = d.id
            JOIN sites s ON d.siteId = s.id
            WHERE s.isActive = 1 AND d.isActive = 1 AND sv.isActive = 1
            ORDER BY s.name, d.name, sv.name
        `);

        // Also get sites/departments that might not have services yet
        const depts = await db.all(`
            SELECT s.name as siteName, d.name as deptName 
            FROM departments d
            JOIN sites s ON d.siteId = s.id
            WHERE s.isActive = 1 AND d.isActive = 1
            AND d.id NOT IN (SELECT DISTINCT departmentId FROM services WHERE isActive = 1)
        `);

        const sites = await db.all(`
            SELECT s.name as siteName 
            FROM sites s
            WHERE s.isActive = 1
            AND s.id NOT IN (SELECT DISTINCT siteId FROM departments WHERE isActive = 1)
        `);

        // Add full hierarchy rows
        rows.forEach((r) => {
            sheet.addRow({ site: r.siteName, department: r.deptName, service: r.serviceName });
        });

        // Add departments without services
        depts.forEach((r) => {
            sheet.addRow({ site: r.siteName, department: r.deptName, service: '' });
        });

        // Add sites without departments
        sites.forEach((r) => {
            sheet.addRow({ site: r.siteName, department: '', service: '' });
        });

        // Style header
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
    }

    async addDomainsSkillsSheet(workbook) {
        const sheet = workbook.addWorksheet('Domains & Skills');

        sheet.columns = [
            { header: 'Domain', key: 'domain', width: 30 },
            { header: 'Sub-Domain', key: 'subDomain', width: 30 },
            { header: 'Skill', key: 'skill', width: 40 },
            { header: 'Category', key: 'category', width: 18 },
            { header: 'Description', key: 'description', width: 50 },
        ];

        const skills = await db.all(`
            SELECT s.name as skillName, s.description, s.category, d.name as domainName, sd.name as subDomainName
            FROM skills s
            JOIN domains d ON s.domainId = d.id
            LEFT JOIN subDomains sd ON sd.id = s.subDomainId
            WHERE s.isActive = 1 AND d.isActive = 1
            ORDER BY d.name, sd.name, s.name
        `);

        skills.forEach((s) => {
            sheet.addRow({
                domain: s.domainName,
                subDomain: s.subDomainName || '',
                skill: s.skillName,
                category: s.category || '',
                description: s.description || '',
            });
        });

        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2980B9' } };
    }

    async addRolesSheet(workbook) {
        const sheet = workbook.addWorksheet('Roles');

        // Fetch active skills for columns
        const skills = await db.all('SELECT id, name FROM skills WHERE isActive = 1 ORDER BY name');
        const skillIds = skills.map((s) => s.id);
        const skillNames = skills.map((s) => s.name);

        // Row 1: Headers
        const row1 = ['Role Name', 'Description', 'Role Family', 'Level', ...skillNames];
        const headerRow = sheet.addRow(row1);

        // The matrix cell carries BOTH facts of a requirement: the required level
        // and whether the skill is CRITICAL for the role. A trailing "*" marks
        // critical (e.g. "3*"), a bare number marks non-critical. Without this the
        // Excel round-trip silently cleared is_critical on every requirement — the
        // flag drives critical-gap alerts, benchmark fit and the manager digest.
        // The importer reads the same convention (UnifiedImportService).
        if (skillNames.length) {
            const legendCell = headerRow.getCell(5);
            legendCell.note =
                'Required level 0-4. Append "*" to mark the skill CRITICAL for the role (e.g. "3*").';
        }

        // Fetch Roles (with their family so it round-trips)
        const roles = await db.all(
            'SELECT r.id, r.name, r.description, rf.name AS roleFamily FROM roles r LEFT JOIN role_families rf ON rf.id = r.role_family_id WHERE r.isActive = 1 ORDER BY r.name'
        );

        for (const role of roles) {
            const requirements = await db.all(
                'SELECT skillId, requiredLevel as level, isCritical FROM roleSkillRequirements WHERE roleId = ?',
                [role.id]
            );
            const reqMap = new Map();
            requirements.forEach((r) =>
                reqMap.set(String(r.skillId), { level: r.level, critical: !!r.isCritical })
            );

            const roleRow = [
                role.name,
                role.description || '',
                role.roleFamily || '',
                '', // Role Level (removed from schema)
            ];

            skillIds.forEach((id) => {
                const req = reqMap.get(String(id));
                // `req.level` may legitimately be 0 ("Aucun") — test for the ABSENCE
                // of a requirement, never for falsiness, or every level-0 row is
                // exported as an empty cell and disappears on re-import.
                if (!req || req.level == null) {
                    roleRow.push('');
                    return;
                }
                roleRow.push(req.critical ? `${Number(req.level)}*` : Number(req.level));
            });

            sheet.addRow(roleRow);
        }

        // Styling
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8E44AD' } };

        // Freeze first column
        sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
    }

    async addEmployeesSheet(workbook) {
        const sheet = workbook.addWorksheet('Employees');

        // Fetch active skills for columns
        const skills = await db.all('SELECT id, name FROM skills WHERE isActive = 1 ORDER BY name');
        const skillIds = skills.map((s) => s.id);
        const skillNames = skills.map((s) => s.name);

        // Row 1: Headers
        const row1 = [
            'Employee ID',
            'First Name',
            'Last Name',
            'Email',
            'Site',
            'Department',
            'Service',
            'Role',
            ...skillNames,
        ];
        const headerRow = sheet.addRow(row1);

        // Fetch Employees
        const employees = await db.all(`
            SELECT e.*, s.name as siteName, d.name as deptName, sv.name as serviceName, r.name as roleName
            FROM employees e
            LEFT JOIN sites s ON e.siteId = s.id
            LEFT JOIN departments d ON e.departmentId = d.id
            LEFT JOIN services sv ON e.serviceId = sv.id
            LEFT JOIN roles r ON e.roleId = r.id
            WHERE e.isActive = 1
            ORDER BY e.lastName, e.firstName
        `);

        for (const emp of employees) {
            const assessments = await db.all(
                'SELECT skillId, currentLevel as level FROM skillAssessments WHERE employeeId = ?',
                [emp.id]
            );
            const assMap = new Map();
            assessments.forEach((a) => assMap.set(String(a.skillId), a.level));

            const empRow = [
                emp.employeeNumber,
                emp.firstName,
                emp.lastName,
                emp.email || '',
                emp.siteName || '',
                emp.deptName || '',
                emp.serviceName || '',
                emp.roleName || '',
            ];

            skillIds.forEach((id) => {
                const level = assMap.get(String(id));
                // Level 0 ("Aucun") is a RATING, not a blank: it is the strongest
                // gap signal and the input to the IDP/PIP auto-triggers. `level ?
                // level : ''` treated it as empty, so a backup/restore round-trip
                // silently deleted every level-0 assessment. Distinguish
                // "no assessment" (undefined) from "assessed at 0".
                empRow.push(level == null ? '' : Number(level));
            });

            sheet.addRow(empRow);
        }

        // Styling
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF27AE60' } };

        // Freeze columns
        sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
    }
    async exportAssessments(adminUser) {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Assessments');

        sheet.columns = [
            { header: 'Skill ID', key: 'skillId', width: 10 },
            { header: 'Employee Number', key: 'employeeNumber', width: 20 },
            { header: 'Employee Name', key: 'employeeName', width: 30 },
            { header: 'Skill Name', key: 'skillName', width: 30 },
            { header: 'Domain', key: 'domainName', width: 25 },
            { header: 'Current Level', key: 'level', width: 15 },
            { header: 'Target Level', key: 'targetLevel', width: 15 },
            { header: 'Assessed By', key: 'assessor', width: 25 },
            { header: 'Date', key: 'date', width: 20 },
            { header: 'Notes', key: 'notes', width: 40 },
        ];

        sheet.getRow(1).font = { bold: true };

        // Dynamic SQL based on RBAC is complex to replicate fully in one query without params
        // But for Data Management, we typically export ALL data if SuperAdmin, or filtered if LocalAdmin.
        // We can leverage the existing RBACService to get IDs, OR reimplement efficient SQL.

        // For now, let's use a robust query that handles the joins correctly.
        // We will fetch ALL assessments and filter in JS if necessary, OR filter via join.
        // Since sqlite "IN" clause has limits, we avoid passing 10k IDs data.

        // Check if SuperAdmin
        const isSuperAdmin = adminUser.role === 'superadmin';

        // Base Query. assessed_by is an admins.id — join ONLY admins for the
        // assessor name (the old employees join matched unrelated people because
        // employees.id and admins.id spaces overlap).
        let sql = `
            SELECT sa.*,
                   e.employeeNumber, e.firstName, e.lastName,
                   s.name as skillName, d.name as domainName,
                   adm_assessor.username as assessorAdminName
            FROM skillAssessments sa
            JOIN employees e ON sa.employeeId = e.id
            JOIN skills s ON sa.skillId = s.id
            JOIN domains d ON s.domainId = d.id
            LEFT JOIN admins adm_assessor ON sa.assessedBy = adm_assessor.id
            WHERE 1=1
        `;

        const params = [];

        // If NOT SuperAdmin, we need to filter `e` (the subject) by scope.
        // Replicating RBAC logic in SQL:
        if (!isSuperAdmin) {
            // Fetch filtering scopes first to avoid massive IN clause if possible,
            // or just use JOIN logic if performant.
            // Given the complexity of RBAC (sites/depts/services), let's assume for this "Crash Fix"
            // that we want to retrieve rows where the EMPLOYEE is visible to the ADMIN.
            // We can optimize this by collecting the Admin's allowed Site/Dept/Service IDs first.
            // However, to strictly fix the "crash" caused by `IN (...)` with filtered employees:
            // We will simply Append criteria regarding the employee's location.
            // We need `AdminScopeModel` here.
            // For simplicity in this iteration (harmonization focus):
            // We'll restrict export to SuperAdmins OR fetch all and filter in stream
            // if the dataset isn't millions of rows.
            // BUT, respecting the user's "Crash" report, we must be efficient.
            // Let's use the RBAC Service's employee list BUT execute the query differently.
            // Actually, DataManagementController *already* fetches filtered employees.
            // The crash likely happened because that list was passed to `IN (...)`.
            // Optimization: We can Filter in the LOOP if we stream results.
        }

        // EXECUTE QUERY
        // We'll stream via db.each if available in this driver, or db.all if memory allows.
        // The previous crash was specifically `WHERE employeeId IN (huge_array)`.
        // If we remove the `IN` clause and filter in code, we trade DB load for Memory load.
        // Better: Join with standard filtering if possible.

        const rows = await db.all(sql, params);
        // Note: `db.all` might still be heavy if millions of rows, but better than `IN (huge_list)`.

        // Post-processing filter (if not super admin)
        // This is safe because we aren't generating a massive SQL string.
        let finalRows = rows;
        if (!isSuperAdmin) {
            const RBACService = require('./RBACService');
            // This is heavy. Let's rely on the fact that DataManagement is typically SuperAdmin.
            // If LocalAdmin access is required, we should implement deeper SQL filtering.
            // For now, assuming SuperAdmin for "Export All" or strictly filtering ID set if small.

            // Re-using the logic from Controller:
            const allowedEmployees = await RBACService.getFilteredEmployees(adminUser, {
                includeInactive: true,
            }); // clearance only — leavers' rows stay exportable
            const allowedIds = new Set(allowedEmployees.map((e) => e.id));
            finalRows = rows.filter((r) => allowedIds.has(r.employeeId));
        }

        const isoDate = (v) => {
            if (!v) return '';
            const dt = new Date(v);
            return isNaN(dt) ? String(v) : dt.toISOString().slice(0, 19).replace('T', ' ');
        };
        for (const r of finalRows) {
            // assessed_by is an admins.id → "Admin: <username>" (round-trips via
            // the import's resolveAssessorId); "Admin #<id>" if the admin is gone.
            const assessor = r.assessorAdminName
                ? `Admin: ${r.assessorAdminName}`
                : r.assessedBy != null
                  ? `Admin #${r.assessedBy}`
                  : '';

            sheet.addRow({
                skillId: r.skillId,
                employeeNumber: r.employeeNumber,
                employeeName: `${r.firstName} ${r.lastName}`,
                skillName: r.skillName,
                domainName: r.domainName,
                level: r.currentLevel,
                targetLevel: '',
                assessor: assessor,
                date: isoDate(r.assessedAt),
                notes: r.notes,
            });
        }

        return workbook;
    }

    // Same data as exportAssessments, returned as a plain JSON-serialisable array.
    async exportAssessmentsJSON(adminUser) {
        const isSuperAdmin = adminUser.role === 'superadmin';
        const sql = `
            SELECT sa.*,
                   e.employeeNumber, e.firstName, e.lastName,
                   s.name as skillName, d.name as domainName,
                   adm_assessor.username as assessorAdminName
            FROM skillAssessments sa
            JOIN employees e ON sa.employeeId = e.id
            JOIN skills s ON sa.skillId = s.id
            JOIN domains d ON s.domainId = d.id
            LEFT JOIN admins adm_assessor ON sa.assessedBy = adm_assessor.id
            WHERE 1=1
        `;
        let rows = await db.all(sql, []);
        if (!isSuperAdmin) {
            const RBACService = require('./RBACService');
            const allowed = await RBACService.getFilteredEmployees(adminUser, {
                includeInactive: true,
            }); // clearance only — leavers' rows stay exportable
            const ids = new Set(allowed.map((e) => e.id));
            rows = rows.filter((r) => ids.has(r.employeeId));
        }
        const isoDate = (v) => {
            if (!v) return null;
            const dt = new Date(v);
            return isNaN(dt) ? String(v) : dt.toISOString();
        };
        return rows.map((r) => ({
            skillId: r.skillId,
            employeeNumber: r.employeeNumber,
            employeeName: `${r.firstName} ${r.lastName}`,
            skillName: r.skillName,
            domainName: r.domainName,
            currentLevel: r.currentLevel,
            assessor: r.assessorAdminName
                ? `Admin: ${r.assessorAdminName}`
                : r.assessedBy != null
                  ? `Admin #${r.assessedBy}`
                  : '',
            assessedAt: isoDate(r.assessedAt),
            notes: r.notes,
        }));
    }
}

module.exports = new UnifiedExportService();
