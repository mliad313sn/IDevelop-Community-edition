const PRODUCT = require('../config/product');
const ExcelJS = require('exceljs');

/**
 * TemplateGenerator - Generates downloadable Excel/CSV templates for bulk import
 *
 * Each template includes:
 * - Proper column headers matching import format
 * - Example rows with sample data
 * - Instructions sheet explaining the format
 */
class TemplateGenerator {
    /**
     * Generate Domains & Skills template
     * Format matches the export/import CSV structure
     */
    async generateDomainsSkillsTemplate() {
        const workbook = new ExcelJS.Workbook();

        // Instructions sheet
        const instructionsSheet = workbook.addWorksheet('Instructions');
        instructionsSheet.getColumn(1).width = 80;

        instructionsSheet.addRow(['Domains & Skills Import Template']);
        instructionsSheet.getRow(1).font = { bold: true, size: 16 };
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Instructions:']);
        instructionsSheet.getRow(3).font = { bold: true };
        instructionsSheet.addRow([
            '1. Fill in the "Domains" sheet with domain names and descriptions',
        ]);
        instructionsSheet.addRow([
            '2. Fill in the "Skills" sheet with skills, linking them to domains by domain name',
        ]);
        instructionsSheet.addRow([
            '3. Save the file and import it via Data Management > Import > Domains & Skills',
        ]);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Notes:']);
        instructionsSheet.getRow(8).font = { bold: true };
        instructionsSheet.addRow(['- Domain names must be unique']);
        instructionsSheet.addRow(['- Each skill must reference an existing domain name']);
        instructionsSheet.addRow(['- Descriptions are optional but recommended']);
        instructionsSheet.addRow(['- Delete the example rows before importing']);

        // Domains sheet
        const domainsSheet = workbook.addWorksheet('Domains');
        domainsSheet.columns = [
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Description', key: 'description', width: 50 },
        ];

        // Style headers
        domainsSheet.getRow(1).font = { bold: true };
        domainsSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };
        domainsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        // Add example data
        domainsSheet.addRow({
            name: 'Technical Skills',
            description: 'Programming, software development, and technical competencies',
        });
        domainsSheet.addRow({
            name: 'Soft Skills',
            description: 'Communication, leadership, and interpersonal skills',
        });
        domainsSheet.addRow({
            name: 'Business Skills',
            description: 'Project management, business analysis, and strategic thinking',
        });

        // Style example rows
        [2, 3, 4].forEach((rowNum) => {
            domainsSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        // Skills sheet
        const skillsSheet = workbook.addWorksheet('Skills');
        skillsSheet.columns = [
            { header: 'Domain Name', key: 'domainName', width: 30 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Description', key: 'description', width: 50 },
        ];

        // Style headers
        skillsSheet.getRow(1).font = { bold: true };
        skillsSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };
        skillsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        // Add example data
        skillsSheet.addRow({
            domainName: 'Technical Skills',
            name: 'JavaScript',
            description: 'Modern JavaScript programming (ES6+)',
        });
        skillsSheet.addRow({
            domainName: 'Technical Skills',
            name: 'Python',
            description: 'Python programming for backend and data analysis',
        });
        skillsSheet.addRow({
            domainName: 'Soft Skills',
            name: 'Team Leadership',
            description: 'Leading and motivating teams effectively',
        });

        // Style example rows
        [2, 3, 4].forEach((rowNum) => {
            skillsSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        return workbook;
    }

    /**
     * Generate Organization template (Sites, Departments, Services)
     */
    async generateOrganizationTemplate() {
        const workbook = new ExcelJS.Workbook();

        // Instructions sheet
        const instructionsSheet = workbook.addWorksheet('Instructions');
        instructionsSheet.getColumn(1).width = 80;

        instructionsSheet.addRow(['Organization Structure Import Template']);
        instructionsSheet.getRow(1).font = { bold: true, size: 16 };
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Instructions:']);
        instructionsSheet.getRow(3).font = { bold: true };
        instructionsSheet.addRow(['1. Fill in the "Sites" sheet with your organization sites']);
        instructionsSheet.addRow([
            '2. Fill in the "Departments" sheet, linking to sites by site name',
        ]);
        instructionsSheet.addRow([
            '3. Fill in the "Services" sheet, linking to departments by department name',
        ]);
        instructionsSheet.addRow([
            '4. Save and import via Data Management > Import > Organization',
        ]);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Notes:']);
        instructionsSheet.getRow(9).font = { bold: true };
        instructionsSheet.addRow(['- Hierarchy: Site > Department > Service']);
        instructionsSheet.addRow(['- All names must be unique within their type']);
        instructionsSheet.addRow(['- Departments must reference existing site names']);
        instructionsSheet.addRow(['- Services must reference existing department names']);
        instructionsSheet.addRow(['- Delete the example rows before importing']);

        // Sites sheet
        const sitesSheet = workbook.addWorksheet('Sites');
        sitesSheet.columns = [
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Location', key: 'location', width: 40 },
        ];

        sitesSheet.getRow(1).font = { bold: true };
        sitesSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };
        sitesSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        sitesSheet.addRow({ name: 'Headquarters', location: 'New York, NY' });
        sitesSheet.addRow({ name: 'West Coast Office', location: 'San Francisco, CA' });

        [2, 3].forEach((rowNum) => {
            sitesSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        // Departments sheet
        const departmentsSheet = workbook.addWorksheet('Departments');
        departmentsSheet.columns = [
            { header: 'Site Name', key: 'siteName', width: 30 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Code', key: 'code', width: 15 },
        ];

        departmentsSheet.getRow(1).font = { bold: true };
        departmentsSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };
        departmentsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        departmentsSheet.addRow({ siteName: 'Headquarters', name: 'Engineering', code: 'ENG' });
        departmentsSheet.addRow({ siteName: 'Headquarters', name: 'Human Resources', code: 'HR' });
        departmentsSheet.addRow({ siteName: 'West Coast Office', name: 'Sales', code: 'SALES' });

        [2, 3, 4].forEach((rowNum) => {
            departmentsSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        // Services sheet
        const servicesSheet = workbook.addWorksheet('Services');
        servicesSheet.columns = [
            { header: 'Department Name', key: 'departmentName', width: 30 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Code', key: 'code', width: 15 },
        ];

        servicesSheet.getRow(1).font = { bold: true };
        servicesSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };
        servicesSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        servicesSheet.addRow({
            departmentName: 'Engineering',
            name: 'Backend Development',
            code: 'BACKEND',
        });
        servicesSheet.addRow({
            departmentName: 'Engineering',
            name: 'Frontend Development',
            code: 'FRONTEND',
        });
        servicesSheet.addRow({
            departmentName: 'Human Resources',
            name: 'Recruitment',
            code: 'RECRUIT',
        });

        [2, 3, 4].forEach((rowNum) => {
            servicesSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        return workbook;
    }

    /**
     * Generate Employees template
     */
    async generateEmployeesTemplate() {
        const workbook = new ExcelJS.Workbook();

        // Instructions sheet
        const instructionsSheet = workbook.addWorksheet('Instructions');
        instructionsSheet.getColumn(1).width = 80;

        instructionsSheet.addRow(['Employees Import Template']);
        instructionsSheet.getRow(1).font = { bold: true, size: 16 };
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Instructions:']);
        instructionsSheet.getRow(3).font = { bold: true };
        instructionsSheet.addRow(['1. Fill in employee information in the "Employees" sheet']);
        instructionsSheet.addRow([
            '2. Ensure Site, Department, Service, and Role names match existing records',
        ]);
        instructionsSheet.addRow(['3. Save and import via Data Management > Import > Employees']);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Required Fields:']);
        instructionsSheet.getRow(8).font = { bold: true };
        instructionsSheet.addRow(['- Employee Number (unique identifier)']);
        instructionsSheet.addRow(['- First Name, Last Name']);
        instructionsSheet.addRow(['- Site Name, Department Name, Service Name']);
        instructionsSheet.addRow(['- Role Name']);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Optional Fields:']);
        instructionsSheet.getRow(14).font = { bold: true };
        instructionsSheet.addRow(['- Email, Phone']);
        instructionsSheet.addRow(['- Hire Date (format: YYYY-MM-DD)']);
        instructionsSheet.addRow(['- Supervisor Employee Number']);

        // Employees sheet
        const employeesSheet = workbook.addWorksheet('Employees');
        employeesSheet.columns = [
            { header: 'Employee Number', key: 'employeeNumber', width: 18 },
            { header: 'First Name', key: 'firstName', width: 20 },
            { header: 'Last Name', key: 'lastName', width: 20 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Phone', key: 'phone', width: 15 },
            { header: 'Site Name', key: 'siteName', width: 25 },
            { header: 'Department Name', key: 'departmentName', width: 25 },
            { header: 'Service Name', key: 'serviceName', width: 25 },
            { header: 'Role Name', key: 'roleName', width: 25 },
            { header: 'Hire Date', key: 'hireDate', width: 15 },
            { header: 'Supervisor Emp#', key: 'supervisorEmployeeNumber', width: 18 },
        ];

        employeesSheet.getRow(1).font = { bold: true };
        employeesSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };
        employeesSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        employeesSheet.addRow({
            employeeNumber: 'EMP001',
            firstName: 'John',
            lastName: 'Doe',
            email: 'john.doe@company.com',
            phone: '+1-555-0100',
            siteName: 'Headquarters',
            departmentName: 'Engineering',
            serviceName: 'Backend Development',
            roleName: 'Senior Developer',
            hireDate: '2023-01-15',
            supervisorEmployeeNumber: '',
        });

        employeesSheet.addRow({
            employeeNumber: 'EMP002',
            firstName: 'Jane',
            lastName: 'Smith',
            email: 'jane.smith@company.com',
            phone: '+1-555-0101',
            siteName: 'Headquarters',
            departmentName: 'Engineering',
            serviceName: 'Frontend Development',
            roleName: 'Developer',
            hireDate: '2023-03-20',
            supervisorEmployeeNumber: 'EMP001',
        });

        [2, 3].forEach((rowNum) => {
            employeesSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        return workbook;
    }

    /**
     * Generate Local Admins template (JSON format)
     */
    generateLocalAdminsTemplate() {
        return {
            _instructions: {
                description: 'Local Admins Import Template',
                format: 'JSON array of admin objects',
                required_fields: ['username', 'role', 'scopes'],
                optional_fields: ['email'],
                notes: [
                    "Role must be 'localadmin'",
                    'Scopes array contains site/department/service access definitions',
                    'Each scope needs: type (site/department/service) and id',
                    'Password will be auto-generated and must be changed on first login',
                ],
            },
            admins: [
                {
                    username: 'admin.site1',
                    email: 'admin.site1@company.com',
                    role: 'localadmin',
                    scopes: [{ type: 'site', id: 1 }],
                },
                {
                    username: 'admin.dept1',
                    email: 'admin.dept1@company.com',
                    role: 'localadmin',
                    scopes: [{ type: 'department', id: 1 }],
                },
            ],
        };
    }

    /**
     * Generate Roles template
     */
    async generateRolesTemplate() {
        const workbook = new ExcelJS.Workbook();

        // Instructions sheet
        const instructionsSheet = workbook.addWorksheet('Instructions');
        instructionsSheet.getColumn(1).width = 80;

        instructionsSheet.addRow(['Roles & Skill Requirements Import Template']);
        instructionsSheet.getRow(1).font = { bold: true, size: 16 };
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Instructions:']);
        instructionsSheet.getRow(3).font = { bold: true };
        instructionsSheet.addRow(['1. Fill in roles in the "Roles" sheet']);
        instructionsSheet.addRow(['2. Define skill requirements in "Skill Requirements" sheet']);
        instructionsSheet.addRow(['3. Link requirements to roles using the exact role name']);
        instructionsSheet.addRow(['4. Save and import via Data Management (custom import needed)']);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Skill Levels:']);
        instructionsSheet.getRow(9).font = { bold: true };
        instructionsSheet.addRow([
            '0 = Novice, 1 = Beginner, 2 = Intermediate, 3 = Advanced, 4 = Expert',
        ]);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Notes:']);
        instructionsSheet.getRow(12).font = { bold: true };
        instructionsSheet.addRow(['- Role names must be unique']);
        instructionsSheet.addRow([
            '- Role Family is optional; a new family is created if it does not exist',
        ]);
        instructionsSheet.addRow(['- Skills must exist in the system before importing']);
        instructionsSheet.addRow(['- Mark critical skills with "Yes" in isCritical column']);

        // Roles sheet
        const rolesSheet = workbook.addWorksheet('Roles');
        rolesSheet.columns = [
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Description', key: 'description', width: 50 },
            { header: 'Role Family', key: 'roleFamily', width: 30 },
        ];

        rolesSheet.getRow(1).font = { bold: true };
        rolesSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };
        rolesSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        rolesSheet.addRow({
            name: 'Senior Developer',
            description: 'Experienced developer with team leadership responsibilities',
            roleFamily: 'Application & Technical',
        });
        rolesSheet.addRow({
            name: 'Developer',
            description: 'Mid-level developer working on application features',
            roleFamily: 'Application & Technical',
        });

        [2, 3].forEach((rowNum) => {
            rolesSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        // Skill Requirements sheet
        const requirementsSheet = workbook.addWorksheet('Skill Requirements');
        requirementsSheet.columns = [
            { header: 'Role Name', key: 'roleName', width: 30 },
            { header: 'Skill Name', key: 'skillName', width: 30 },
            { header: 'Required Level', key: 'requiredLevel', width: 15 },
            { header: 'Is Critical', key: 'isCritical', width: 15 },
        ];

        requirementsSheet.getRow(1).font = { bold: true };
        requirementsSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };
        requirementsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        requirementsSheet.addRow({
            roleName: 'Senior Developer',
            skillName: 'JavaScript',
            requiredLevel: 3,
            isCritical: 'Yes',
        });
        requirementsSheet.addRow({
            roleName: 'Senior Developer',
            skillName: 'Python',
            requiredLevel: 3,
            isCritical: 'Yes',
        });
        requirementsSheet.addRow({
            roleName: 'Senior Developer',
            skillName: 'Team Leadership',
            requiredLevel: 2,
            isCritical: 'No',
        });
        requirementsSheet.addRow({
            roleName: 'Developer',
            skillName: 'JavaScript',
            requiredLevel: 2,
            isCritical: 'Yes',
        });

        [2, 3, 4, 5].forEach((rowNum) => {
            requirementsSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        return workbook;
    }

    /**
     * Generate the FULL-SYSTEM Excel template, pre-filled with one worked example
     * (a brand-new department brought in together with its sub-domain, skill, role
     * family, role + requirement and two employees + their skill levels). Upload it
     * to Data Management -> Import -> Full System (Excel) to create the whole chain
     * in one shot. Sheet/column layout matches UnifiedImportService.importFullFramework.
     */
    async generateFullSystemTemplate() {
        const wb = new ExcelJS.Workbook();
        wb.creator = PRODUCT.name;

        const headerFill = (row, argb) => {
            row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
        };
        const example = (sheet, fromRow, toRow) => {
            for (let n = fromRow; n <= toRow; n++)
                sheet.getRow(n).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        };

        // 0. Instructions
        const info = wb.addWorksheet('Instructions');
        info.getColumn(1).width = 100;
        info.addRow(['Full System Import Template — add everything in one file']);
        info.getRow(1).font = { bold: true, size: 16 };
        [
            '',
            'Upload this workbook via Data Management → Import → Full System (Excel).',
            'Everything imports in one transaction, in this order, so dependencies resolve automatically:',
            '   Organization → Domains & Skills → Roles → Employees.',
            '',
            'The rows below (in grey italics) are a worked example: a new "Environmental Affairs"',
            'department created together with its sub-domain, skill, role family, role + requirement,',
            'and two employees with their skill levels. Replace them with your own data.',
            '',
            'Sheet-by-sheet:',
            '• Organization  — Site | Department | Service. Hierarchy is Site → Department → Service.',
            '• Domains & Skills — Domain | Sub-Domain | Skill | Category | Description. Sub-Domain & Category optional.',
            '• Roles  — Role Name | Description | Role Family | Level | <one column per skill>. Put the required',
            '           level (0–4) under each skill column; Role Family is optional (created if new).',
            '• Employees — Employee ID | First Name | Last Name | Email | Site | Department | Service | Role |',
            '           <one column per skill>. Put the employee’s current level (0–4) under each skill column.',
            '',
            'Notes:',
            '• Levels are 0–4 (0 = None, 1 = Basic Awareness, 2 = Guided, 3 = Autonomous, 4 = Expert).',
            '• A new employee needs Site + Department + Service + Role to all resolve, or that row is skipped',
            '  (the rest still import). Names are matched case-insensitively.',
            '• Each new employee is given a login (username + one-time password) reported after import.',
            '• Re-importing the same file is safe (idempotent): existing rows are updated, not duplicated.',
        ].forEach((t) => info.addRow([t]));

        // 1. Organization: Site | Department | Service
        const org = wb.addWorksheet('Organization');
        org.columns = [
            { header: 'Site', key: 'site', width: 25 },
            { header: 'Department', key: 'department', width: 28 },
            { header: 'Service', key: 'service', width: 28 },
        ];
        headerFill(org.getRow(1), 'FF2C3E50');
        org.addRow({
            site: 'Green Valley Mine',
            department: 'Environmental Affairs',
            service: 'Water & Effluent',
        });
        example(org, 2, 2);

        // 2. Domains & Skills: Domain | Sub-Domain | Skill | Category | Description
        const ds = wb.addWorksheet('Domains & Skills');
        ds.columns = [
            { header: 'Domain', key: 'domain', width: 26 },
            { header: 'Sub-Domain', key: 'subDomain', width: 26 },
            { header: 'Skill', key: 'skill', width: 30 },
            { header: 'Category', key: 'category', width: 16 },
            { header: 'Description', key: 'description', width: 44 },
        ];
        headerFill(ds.getRow(1), 'FF2980B9');
        ds.addRow({
            domain: 'Environment',
            subDomain: 'Water Management',
            skill: 'Effluent Monitoring',
            category: 'Technical',
            description: 'Monitor and report discharge water quality',
        });
        example(ds, 2, 2);

        // 3. Roles: Role Name | Description | Role Family | Level | <skill columns...>
        const roles = wb.addWorksheet('Roles');
        roles.addRow(['Role Name', 'Description', 'Role Family', 'Level', 'Effluent Monitoring']);
        headerFill(roles.getRow(1), 'FF8E44AD');
        // Level column stays blank; the number under the skill column is the REQUIRED level.
        roles.addRow([
            'Environmental Officer',
            'Field environmental officer',
            'Environment & Sustainability',
            '',
            3,
        ]);
        example(roles, 2, 2);
        roles.getColumn(1).width = 28;
        roles.getColumn(2).width = 34;
        roles.getColumn(3).width = 28;
        roles.getColumn(5).width = 20;
        roles.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

        // 4. Employees: EmpID | First | Last | Email | Site | Department | Service | Role | <skill columns...>
        const emp = wb.addWorksheet('Employees');
        emp.addRow([
            'Employee ID',
            'First Name',
            'Last Name',
            'Email',
            'Site',
            'Department',
            'Service',
            'Role',
            'Effluent Monitoring',
        ]);
        headerFill(emp.getRow(1), 'FF27AE60');
        emp.addRow([
            'ENV-001',
            'Awa',
            'Coste',
            'awa.coste@example.com',
            'Green Valley Mine',
            'Environmental Affairs',
            'Water & Effluent',
            'Environmental Officer',
            2,
        ]);
        emp.addRow([
            'ENV-002',
            'Kofi',
            'Mensah',
            'kofi.mensah@example.com',
            'Green Valley Mine',
            'Environmental Affairs',
            'Water & Effluent',
            'Environmental Officer',
            1,
        ]);
        example(emp, 2, 3);
        [1, 2, 3, 4, 5, 6, 7, 8].forEach((c) => {
            emp.getColumn(c).width = 18;
        });
        emp.getColumn(9).width = 20;
        emp.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];

        return wb;
    }

    /**
     * Generate Assessments template
     */
    async generateAssessmentsTemplate() {
        const workbook = new ExcelJS.Workbook();

        // Instructions sheet
        const instructionsSheet = workbook.addWorksheet('Instructions');
        instructionsSheet.getColumn(1).width = 80;

        instructionsSheet.addRow(['Skill Assessments Import Template']);
        instructionsSheet.getRow(1).font = { bold: true, size: 16 };
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Instructions:']);
        instructionsSheet.getRow(3).font = { bold: true };
        instructionsSheet.addRow(['1. Fill in skill assessments for employees']);
        instructionsSheet.addRow(['2. Use valid employee numbers and skill names']);
        instructionsSheet.addRow(['3. Save and import via Data Management (custom import needed)']);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Skill Levels:']);
        instructionsSheet.getRow(8).font = { bold: true };
        instructionsSheet.addRow([
            '0 = Novice, 1 = Beginner, 2 = Intermediate, 3 = Advanced, 4 = Expert',
        ]);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Notes:']);
        instructionsSheet.getRow(11).font = { bold: true };
        instructionsSheet.addRow(['- Employee must exist in the system']);
        instructionsSheet.addRow(['- Skill must exist in the system']);
        instructionsSheet.addRow(['- AssessedBy should be employee number of assessor (optional)']);

        // Assessments sheet
        const assessmentsSheet = workbook.addWorksheet('Assessments');
        assessmentsSheet.columns = [
            { header: 'Employee Number', key: 'employeeNumber', width: 18 },
            { header: 'Skill Name', key: 'skillName', width: 30 },
            { header: 'Current Level', key: 'currentLevel', width: 15 },
            { header: 'Target Level', key: 'targetLevel', width: 15 },
            { header: 'Assessed By', key: 'assessedBy', width: 18 },
            { header: 'Notes', key: 'notes', width: 50 },
        ];

        assessmentsSheet.getRow(1).font = { bold: true };
        assessmentsSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };
        assessmentsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

        assessmentsSheet.addRow({
            employeeNumber: 'EMP001',
            skillName: 'JavaScript',
            currentLevel: 3,
            targetLevel: 4,
            assessedBy: 'EMP100',
            notes: 'Strong skills, ready for expert level',
        });

        assessmentsSheet.addRow({
            employeeNumber: 'EMP002',
            skillName: 'Python',
            currentLevel: 2,
            targetLevel: 3,
            assessedBy: 'EMP100',
            notes: 'Needs more practice with advanced features',
        });

        [2, 3].forEach((rowNum) => {
            assessmentsSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        return workbook;
    }

    /**
     * Generate Complete Skill Framework template
     * Combines Domains, Skills, Roles, and Requirements in one file
     */
    async generateSkillFrameworkTemplate() {
        const workbook = new ExcelJS.Workbook();

        // Instructions sheet
        const instructionsSheet = workbook.addWorksheet('Instructions');
        instructionsSheet.getColumn(1).width = 90;

        instructionsSheet.addRow(['Complete Skill Framework Import Template']);
        instructionsSheet.getRow(1).font = { bold: true, size: 16 };
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Instructions:']);
        instructionsSheet.getRow(3).font = { bold: true, size: 12 };
        instructionsSheet.addRow([
            'This template allows you to import your entire skill framework in one file.',
        ]);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Import Order (automatic):']);
        instructionsSheet.getRow(7).font = { bold: true };
        instructionsSheet.addRow(['1. Domains are imported first']);
        instructionsSheet.addRow(['2. Skills are imported and linked to domains']);
        instructionsSheet.addRow(['3. Roles are imported']);
        instructionsSheet.addRow([
            '4. Role Requirements are imported, linking roles to skills with required levels',
        ]);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['How to use:']);
        instructionsSheet.getRow(13).font = { bold: true };
        instructionsSheet.addRow(['1. Fill in the "Domains" sheet with your skill domains']);
        instructionsSheet.addRow([
            '2. Fill in the "Skills" sheet, referencing domain names from step 1',
        ]);
        instructionsSheet.addRow(['3. Fill in the "Roles" sheet with your job roles']);
        instructionsSheet.addRow([
            '4. Fill in the "Requirements" sheet, linking roles to skills with required levels',
        ]);
        instructionsSheet.addRow(['5. Delete all example rows (in gray italic text)']);
        instructionsSheet.addRow([
            '6. Save the file and import via Data Management > Import > Skill Framework',
        ]);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Skill Levels:']);
        instructionsSheet.getRow(21).font = { bold: true };
        instructionsSheet.addRow(['0 = Novice     - Just starting to learn']);
        instructionsSheet.addRow(['1 = Beginner   - Basic understanding and application']);
        instructionsSheet.addRow(['2 = Intermediate - Can work independently']);
        instructionsSheet.addRow(['3 = Advanced   - Deep expertise, can mentor others']);
        instructionsSheet.addRow(['4 = Expert     - Industry-leading expertise']);
        instructionsSheet.addRow([]);
        instructionsSheet.addRow(['Important Notes:']);
        instructionsSheet.getRow(28).font = { bold: true };
        instructionsSheet.addRow([
            '- All names must match exactly when referenced (case-sensitive)',
        ]);
        instructionsSheet.addRow(['- Domain names must be unique']);
        instructionsSheet.addRow(['- Skill names must be unique within each domain']);
        instructionsSheet.addRow(['- Role names must be unique']);
        instructionsSheet.addRow([
            '- Mark critical skills with "Yes" in the isCritical column of Requirements',
        ]);

        // Domains sheet
        const domainsSheet = workbook.addWorksheet('Domains');
        domainsSheet.columns = [
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Description', key: 'description', width: 60 },
        ];

        domainsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        domainsSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };

        domainsSheet.addRow({
            name: 'Technical Skills',
            description: 'Programming, software development, and technical competencies',
        });
        domainsSheet.addRow({
            name: 'Soft Skills',
            description: 'Communication, leadership, and interpersonal skills',
        });
        domainsSheet.addRow({
            name: 'Business Skills',
            description: 'Project management, business analysis, and strategic thinking',
        });

        [2, 3, 4].forEach((rowNum) => {
            domainsSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        // Skills sheet
        const skillsSheet = workbook.addWorksheet('Skills');
        skillsSheet.columns = [
            { header: 'Domain Name', key: 'domainName', width: 30 },
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Description', key: 'description', width: 60 },
        ];

        skillsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        skillsSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };

        skillsSheet.addRow({
            domainName: 'Technical Skills',
            name: 'JavaScript',
            description: 'Modern JavaScript programming (ES6+, async/await, modules)',
        });
        skillsSheet.addRow({
            domainName: 'Technical Skills',
            name: 'Python',
            description: 'Python programming for backend development and data analysis',
        });
        skillsSheet.addRow({
            domainName: 'Technical Skills',
            name: 'SQL',
            description: 'Database design and query optimization',
        });
        skillsSheet.addRow({
            domainName: 'Soft Skills',
            name: 'Team Leadership',
            description: 'Leading and motivating teams effectively',
        });
        skillsSheet.addRow({
            domainName: 'Soft Skills',
            name: 'Communication',
            description: 'Clear and effective verbal and written communication',
        });
        skillsSheet.addRow({
            domainName: 'Business Skills',
            name: 'Project Management',
            description: 'Planning, executing, and delivering projects on time',
        });

        [2, 3, 4, 5, 6, 7].forEach((rowNum) => {
            skillsSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        // Roles sheet
        const rolesSheet = workbook.addWorksheet('Roles');
        rolesSheet.columns = [
            { header: 'Name', key: 'name', width: 30 },
            { header: 'Description', key: 'description', width: 60 },
        ];

        rolesSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        rolesSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };

        rolesSheet.addRow({
            name: 'Senior Developer',
            description:
                'Experienced developer with team leadership and architectural responsibilities',
        });
        rolesSheet.addRow({
            name: 'Developer',
            description: 'Mid-level developer working on application features',
        });
        rolesSheet.addRow({
            name: 'Junior Developer',
            description: 'Entry-level developer learning the technology stack',
        });

        [2, 3, 4].forEach((rowNum) => {
            rolesSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        // Requirements sheet
        const requirementsSheet = workbook.addWorksheet('Requirements');
        requirementsSheet.columns = [
            { header: 'Role Name', key: 'roleName', width: 30 },
            { header: 'Skill Name', key: 'skillName', width: 30 },
            { header: 'Required Level (0-4)', key: 'requiredLevel', width: 20 },
            { header: 'Is Critical (Yes/No)', key: 'isCritical', width: 20 },
        ];

        requirementsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        requirementsSheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF3498DB' },
        };

        // Senior Developer requirements
        requirementsSheet.addRow({
            roleName: 'Senior Developer',
            skillName: 'JavaScript',
            requiredLevel: 3,
            isCritical: 'Yes',
        });
        requirementsSheet.addRow({
            roleName: 'Senior Developer',
            skillName: 'Python',
            requiredLevel: 3,
            isCritical: 'Yes',
        });
        requirementsSheet.addRow({
            roleName: 'Senior Developer',
            skillName: 'SQL',
            requiredLevel: 3,
            isCritical: 'Yes',
        });
        requirementsSheet.addRow({
            roleName: 'Senior Developer',
            skillName: 'Team Leadership',
            requiredLevel: 2,
            isCritical: 'Yes',
        });
        requirementsSheet.addRow({
            roleName: 'Senior Developer',
            skillName: 'Project Management',
            requiredLevel: 2,
            isCritical: 'No',
        });

        // Developer requirements
        requirementsSheet.addRow({
            roleName: 'Developer',
            skillName: 'JavaScript',
            requiredLevel: 2,
            isCritical: 'Yes',
        });
        requirementsSheet.addRow({
            roleName: 'Developer',
            skillName: 'Python',
            requiredLevel: 2,
            isCritical: 'No',
        });
        requirementsSheet.addRow({
            roleName: 'Developer',
            skillName: 'SQL',
            requiredLevel: 2,
            isCritical: 'Yes',
        });
        requirementsSheet.addRow({
            roleName: 'Developer',
            skillName: 'Communication',
            requiredLevel: 2,
            isCritical: 'Yes',
        });

        // Junior Developer requirements
        requirementsSheet.addRow({
            roleName: 'Junior Developer',
            skillName: 'JavaScript',
            requiredLevel: 1,
            isCritical: 'Yes',
        });
        requirementsSheet.addRow({
            roleName: 'Junior Developer',
            skillName: 'SQL',
            requiredLevel: 1,
            isCritical: 'Yes',
        });

        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].forEach((rowNum) => {
            requirementsSheet.getRow(rowNum).font = { italic: true, color: { argb: 'FF7F8C8D' } };
        });

        return workbook;
    }

    /**
     * Generate Full System JSON template
     */
    generateFullSystemJsonTemplate() {
        return {
            metadata: {
                version: '1.0',
                description: 'Full System Migration Template',
                exportedAt: new Date().toISOString(),
            },
            framework: {
                domains: [
                    {
                        name: 'Technical Skills',
                        skills: ['JavaScript', 'Node.js', 'SQL'],
                    },
                ],
            },
            organization: {
                sites: [
                    {
                        name: 'Main Office',
                        departments: [
                            {
                                name: 'Engineering',
                                services: ['Backend', 'Frontend'],
                            },
                        ],
                    },
                ],
            },
            roles: [
                {
                    name: 'Senior Developer',
                    requirements: {
                        JavaScript: 4,
                        'Node.js': 3,
                    },
                },
            ],
            employees: [
                {
                    firstName: 'John',
                    lastName: 'Doe',
                    employeeNumber: 'EMP001',
                    site: 'Main Office',
                    department: 'Engineering',
                    service: 'Backend',
                    role: 'Senior Developer',
                    assessments: [
                        {
                            skill: 'JavaScript',
                            level: 4,
                            targetLevel: 5,
                            notes: 'Strong proficiency',
                        },
                    ],
                },
            ],
        };
    }

    generateDomainsSkillsJsonTemplate() {
        return {
            framework: {
                domains: [
                    {
                        name: 'Technical Skills',
                        skills: ['Python', 'Docker', 'AWS'],
                    },
                ],
            },
        };
    }

    generateOrganizationJsonTemplate() {
        return {
            organization: {
                sites: [
                    {
                        name: 'New York HQ',
                        departments: [
                            {
                                name: 'HR',
                                services: ['Recruitment', 'Payroll'],
                            },
                        ],
                    },
                ],
            },
        };
    }

    generateEmployeesJsonTemplate() {
        return {
            employees: [
                {
                    employeeNumber: 'EMP123',
                    firstName: 'Alice',
                    lastName: 'Johnson',
                    site: 'New York HQ',
                    department: 'HR',
                    service: 'Recruitment',
                    role: 'Recruiter',
                },
            ],
        };
    }

    generateRolesJsonTemplate() {
        return {
            roles: [
                {
                    name: 'Manager',
                    description: 'People manager',
                    roleFamily: 'Leadership & Management',
                    requirements: {
                        Leadership: 4,
                        Communication: 4,
                    },
                },
            ],
        };
    }

    generateAssessmentsJsonTemplate() {
        return {
            employees: [
                {
                    employeeNumber: 'EMP001',
                    assessments: [
                        {
                            skill: 'Communication',
                            level: 3,
                            targetLevel: 4,
                            notes: 'Good progress',
                        },
                    ],
                },
            ],
        };
    }
    /**
     * Certifications / VOC bulk-import template (migration 56 engine).
     * Sheet "Certifications": one row per issued certificate.
     */
    async generateCertificationsTemplate() {
        const workbook = new ExcelJS.Workbook();

        const inst = workbook.addWorksheet('Instructions');
        inst.getColumn(1).width = 90;
        inst.addRow(['Certifications / VOC Import Template']);
        inst.getRow(1).font = { bold: true, size: 16 };
        inst.addRow([]);
        inst.addRow(['Instructions:']);
        inst.getRow(3).font = { bold: true };
        inst.addRow(['1. One row per issued certificate / VOC sign-off.']);
        inst.addRow([
            '2. Employee Number and Skill Name must already exist in the system (exact skill name).',
        ]);
        inst.addRow([
            '3. Dates as YYYY-MM-DD. Leave "Expires On" blank to derive it from the skill\'s certification policy (or never expire when no policy).',
        ]);
        inst.addRow([
            '4. Import via Data Management -> Certifications: use PREVIEW first (nothing is written), then Import.',
        ]);
        inst.addRow([]);
        inst.addRow(['Notes:']);
        inst.getRow(10).font = { bold: true };
        inst.addRow([
            '- A row identical to an already-recorded certificate (same employee, skill and issue date) is skipped, so re-importing the same file is safe.',
        ]);
        inst.addRow([
            '- Evidence files cannot be bulk-imported; attach them per record on the Compliance page.',
        ]);
        inst.addRow(['- Expiry alerts (90/60/30 days) start automatically once records exist.']);

        const sheet = workbook.addWorksheet('Certifications');
        sheet.columns = [
            { header: 'Employee Number', key: 'employeeNumber', width: 18 },
            { header: 'Skill Name', key: 'skillName', width: 40 },
            { header: 'Cert Number', key: 'certNumber', width: 20 },
            { header: 'Issued On', key: 'issuedOn', width: 14 },
            { header: 'Expires On', key: 'expiresOn', width: 14 },
            { header: 'Notes', key: 'notes', width: 50 },
        ];
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3498DB' } };
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.addRow({
            employeeNumber: 'EMP001',
            skillName: 'First Aid & Emergency Response',
            certNumber: 'FA-2025-0042',
            issuedOn: '2025-06-01',
            expiresOn: '2027-06-01',
            notes: 'Issued by St John WA',
        });
        sheet.addRow({
            employeeNumber: 'EMP002',
            skillName: 'Working at Heights',
            certNumber: '',
            issuedOn: '2026-01-15',
            expiresOn: '',
            notes: 'Expiry derived from the skill policy',
        });
        return workbook;
    }
}

module.exports = new TemplateGenerator();
