const { csvCell } = require('../utils/csvSafe');
const EmployeeModel = require('../models/EmployeeModel');
const SkillAssessmentModel = require('../models/SkillAssessmentModel');
const AssessmentHistoryModel = require('../models/AssessmentHistoryModel');
const SnapshotModel = require('../models/SnapshotModel');
const RBACService = require('../services/RBACService');
const SkillAssessmentService = require('../services/SkillAssessmentService');
const LogService = require('../services/LogService');
const ImportExportService = require('../services/ImportExportService');
const SnapshotService = require('../services/SnapshotService');
const TemplateGenerator = require('../utils/TemplateGenerator');
const { bc } = require('../utils/breadcrumbLabel');
const UnifiedImportService = require('../services/UnifiedImportService');
const UnifiedExportService = require('../services/UnifiedExportService');
const UnifiedJsonService = require('../services/UnifiedJsonService');
const SkillMatrixWorkbookService = require('../services/SkillMatrixWorkbookService');
const appConfig = require('../config/app');
const path = require('path');
const fs = require('fs');
const db = require('../config/database');

// Try to require multer, but make it optional
let multer = null;
let upload = null;
try {
    multer = require('multer');

    // Ensure tmp directory exists
    const tmpDir = path.join(__dirname, '../../AI_Engine_Docs/tmp/');
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Configure multer for file uploads. The decision is made on the EXTENSION
    // only (a browser-sent MIME type used to admit any name), and the content
    // is then proven by guardUpload (magic bytes, OOXML [Content_Types].xml,
    // zip-bomb caps) before any importer or ExcelJS reads it. ASVS 12.2.1.
    const { guardUpload, extensionFilter } = require('../middleware/uploadGuard');
    const rawUpload = multer({
        dest: tmpDir,
        limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10MB limit
        fileFilter: extensionFilter([
            '.csv',
            '.txt',
            '.json',
            '.xml',
            '.yaml',
            '.yml',
            '.xlsx',
            '.xls',
        ]),
    });
    upload = {
        single: (fieldName) =>
            guardUpload(rawUpload.single(fieldName), { kinds: ['text', 'xlsx', 'xls'] }),
    };
} catch (error) {
    console.warn('Warning: multer module not found. Import functionality will be disabled.');
    console.warn('To enable imports, run: npm install multer@^1.4.5-lts.1');
    // Create a dummy upload middleware that returns an error
    upload = {
        single: (fieldName) => {
            return (req, res, next) => {
                res.status(500).json({
                    error: 'Import functionality requires multer module. Please install it with: npm install multer@^1.4.5-lts.1',
                });
            };
        },
    };
}

class DataManagementController {
    constructor() {
        // Route handlers are passed unbound, so any method that uses `this`
        // (e.g. exportAssessments → exportAssessmentsCSV) must be bound.
        this.exportAssessments = this.exportAssessments.bind(this);
        this.exportAssessmentsCSV = this.exportAssessmentsCSV.bind(this);
        // Skill Matrix handlers use this._smFormat, so bind them too.
        this.exportSkillMatrix = this.exportSkillMatrix.bind(this);
        this.downloadSkillMatrixTemplate = this.downloadSkillMatrixTemplate.bind(this);
        this.previewSkillMatrix = this.previewSkillMatrix.bind(this);
        this.importSkillMatrix = this.importSkillMatrix.bind(this);
        // Both read the counts through this.computeStatistics.
        this.index = this.index.bind(this);
        this.getStatistics = this.getStatistics.bind(this);
    }

    async index(req, res) {
        try {
            // Access Control: SuperAdmin OR LocalAdmin
            // This page is now accessible to Local Admins for their limited scope
            if (!req.user || (req.user.role !== 'superadmin' && req.user.role !== 'localadmin')) {
                req.flash('error', req.t ? req.t('flash:access_denied') : 'Access denied');
                return res.redirect('/dashboard');
            }

            // Get snapshots, with the stored size and captured counts:
            // a row that says only "name · creator · date" cannot be told apart
            // from an empty capture.
            const [snapshots, sizes, stats] = await Promise.all([
                SnapshotModel.findAllWithCreator(),
                SnapshotModel.sizesById().catch(() => ({})),
                // the three counts are rendered server-side; the page used
                // to print « - » until a fetch answered, showing an absence of
                // measurement as a result.
                this.computeStatistics(req.user).catch(() => null),
            ]);
            snapshots.forEach((s) => {
                const m = sizes[Number(s.id)];
                s.sizeBytes = m ? m.bytes : null;
                s.entityCounts = m ? m.counts : null;
            });

            // Construct API URL
            const apiUrl = `${req.protocol}://${req.get('host')}/api/powerbi`;

            res.render('pages/data-management/index', {
                title: req.t ? req.t('chrome:pt_data_management') : 'Data Management',
                snapshots,
                stats,
                apiKey: appConfig.apiKey,
                apiUrl: apiUrl,
                csrfToken: res.locals.csrfToken || '',
                // English literal crumbs on a French page (the class is nine
                // breadcrumb blocks; the labels go through req.t like every other string).
                breadcrumbs: [
                    { label: bc(req, 'chrome:pt_bc_tools', 'Tools'), url: '/dashboard' },
                    { label: bc(req, 'chrome:pt_data_management', 'Data Management') },
                ],
            });
        } catch (error) {
            console.error('Data Management error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:dm_load_error') : 'Error loading data management'
            );
            res.redirect('/dashboard');
        }
    }

    // ========== EXPORT FUNCTIONS ==========

    async exportEmployees(req, res) {
        try {
            const employees = await RBACService.getFilteredEmployees(req.user, {
                includeInactive: true,
            }); // data export: whole population, leavers included

            // Convert to CSV
            const headers = [
                'Employee Number',
                'First Name',
                'Last Name',
                'Email',
                'Phone',
                'Site',
                'Department',
                'Service',
                'Role',
            ];
            const rows = employees.map((emp) => [
                emp.employeeNumber,
                emp.firstName,
                emp.lastName,
                emp.email || '',
                emp.phone || '',
                emp.siteName || '',
                emp.departmentName || '',
                emp.serviceName || '',
                emp.roleName || '',
            ]);

            const csv =
                '﻿' + // UTF-8 BOM so Excel opens accented names without mojibake
                [headers, ...rows]
                    .map((row) => row.map((cell) => csvCell(cell)).join(','))
                    .join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=employees_export.csv');
            res.send(csv);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_EXPORT',
                entityType: 'employees',
                details: `Exported ${employees.length} employees`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Export employees error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:dm_export_employees_error') : 'Error exporting employees'
            );
            res.redirect('/data-management');
        }
    }

    async exportOrganization(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const data = await ImportExportService.exportOrganization();

            // Convert to CSV format
            // The SECTION MARKERS go through csvCell like every data cell. They
            // begin with '=', so Excel treated them as formulas: the file could
            // not be opened, corrected and saved back without mangling the
            // markers this export's OWN re-import path matches on. csvCell
            // prefixes an apostrophe and the importer uses includes, so the
            // marker still round-trips.
            const csvLines = [];
            const section = (name) => csvCell(name);

            // Sites
            csvLines.push(section('=== SITES ==='));
            csvLines.push('Name,Code,Description');
            data.sites.forEach((s) => {
                csvLines.push([s.name, s.code || '', s.description || ''].map(csvCell).join(','));
            });

            csvLines.push('');
            csvLines.push(section('=== DEPARTMENTS ==='));
            csvLines.push('Site Name,Name,Code,Description');
            data.departments.forEach((d) => {
                csvLines.push(
                    [d.siteName, d.name, d.code || '', d.description || ''].map(csvCell).join(',')
                );
            });

            csvLines.push('');
            csvLines.push(section('=== SERVICES ==='));
            csvLines.push('Site Name,Department Name,Name,Code,Description');
            data.services.forEach((s) => {
                csvLines.push(
                    [s.siteName, s.departmentName, s.name, s.code || '', s.description || '']
                        .map(csvCell)
                        .join(',')
                );
            });

            // UTF-8 BOM + the `sep=,` hint, the same treatment every other
            // export in the product gets: without them fr-FR Excel splits on
            // ';' and drops every row into column A, and accented names arrive
            // mojibaked. The importer ignores any line before the first section
            // marker, so the hint costs the round-trip nothing.
            const csv = '﻿' + 'sep=,\r\n' + csvLines.join('\r\n');

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=organization_export.csv');
            res.send(csv);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_EXPORT',
                entityType: 'organization',
                details: `Exported organization data`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Export organization error:', error);
            res.status(500).json({ error: 'Error exporting organization' });
        }
    }

    async exportDomainsSkills(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const data = await ImportExportService.exportDomainsSkills();

            const csvLines = [];

            csvLines.push('=== DOMAINS ===');
            csvLines.push('Name,Description');
            data.domains.forEach((d) => {
                csvLines.push([d.name, d.description || ''].map(csvCell).join(','));
            });
            // Sub-domains section (the layer between domain and skill).
            csvLines.push('');
            csvLines.push('=== SUB-DOMAINS ===');
            csvLines.push('Domain Name,Name,Definition');
            (data.subDomains || []).forEach((sd) => {
                csvLines.push([sd.domainName, sd.name, sd.definition || ''].map(csvCell).join(','));
            });

            csvLines.push('');
            csvLines.push('=== SKILLS ===');
            csvLines.push('Domain Name,Sub-Domain Name,Name,Category,Description');
            data.skills.forEach((s) => {
                csvLines.push(
                    [
                        s.domainName,
                        s.subDomainName || '',
                        s.name,
                        s.category || '',
                        s.description || '',
                    ]
                        .map(csvCell)
                        .join(',')
                );
            });

            const csv = '﻿' + csvLines.join('\n'); // UTF-8 BOM for Excel (accents)

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=domains_skills_export.csv');
            res.send(csv);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_EXPORT',
                entityType: 'domainsSkills',
                details: `Exported domains and skills`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Export domains & skills error:', error);
            res.status(500).json({ error: 'Error exporting domains & skills' });
        }
    }

    async exportLocalAdmins(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const data = await ImportExportService.exportLocalAdmins();

            // Convert to JSON for download
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=local_admins_export.json');
            res.send(JSON.stringify(data, null, 2));

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_EXPORT',
                entityType: 'localAdmins',
                details: `Exported ${data.length} local admins`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Export local admins error:', error);
            res.status(500).json({ error: 'Error exporting local admins' });
        }
    }

    async exportAssessments(req, res) {
        return this.exportAssessmentsCSV(req, res);
    }

    async exportAssessmentsCSV(req, res) {
        try {
            const employees = await RBACService.getFilteredEmployees(req.user, {
                includeInactive: true,
            }); // data export: whole population, leavers included
            const employeeIds = employees.map((e) => e.id);

            if (employeeIds.length === 0) {
                return res.status(400).json({ error: 'No employees to export' });
            }

            // Scoped in SQL, not after the fact: this used to load every assessment
            // in the database into memory and then discard the ones out of clearance.
            const filteredAssessments = await SkillAssessmentModel.findAll({ employeeIds });

            const employeeMap = {};
            employees.forEach((emp) => {
                employeeMap[emp.id] = emp;
            });

            // assessed_by is an admins.id — resolve to a round-trippable label and
            // emit an ISO date (was: raw id + a JS Date.toString).
            const { buildAdminMaps, labelForAssessor } = require('../utils/assessorRef');
            const { byId: adminById } = await buildAdminMaps();
            const isoDate = (v) => {
                if (!v) return '';
                const d = new Date(v);
                return isNaN(d) ? String(v) : d.toISOString().slice(0, 19).replace('T', ' ');
            };

            // "Skill ID" is a stable technical key so re-import lands on the exact
            // same skill (skill NAMES repeat across/within domains, incl. retired
            // duplicates — name-only re-import created spurious rows).
            const headers = [
                'Skill ID',
                'Employee Number',
                'Employee Name',
                'Skill',
                'Domain',
                'Current Level',
                'Assessed At',
                'Assessed By',
                'Notes',
            ];
            const rows = filteredAssessments.map((ass) => {
                const emp = employeeMap[ass.employeeId];
                return [
                    ass.skillId ?? '',
                    emp ? emp.employeeNumber : '',
                    emp ? `${emp.firstName} ${emp.lastName}` : '',
                    ass.skillName || '',
                    ass.domainName || '',
                    ass.currentLevel,
                    isoDate(ass.assessedAt),
                    labelForAssessor(ass.assessedBy, adminById),
                    ass.notes || '',
                ];
            });

            const csv =
                '﻿' + // UTF-8 BOM so Excel opens accented names without mojibake
                [headers, ...rows]
                    .map((row) => row.map((cell) => csvCell(cell)).join(','))
                    .join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=assessments_export.csv');
            res.send(csv);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_EXPORT',
                entityType: 'assessments',
                details: `Exported ${filteredAssessments.length} assessments to CSV`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Export assessments CSV error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:dm_export_assessments_error') : 'Error exporting assessments'
            );
            res.redirect('/data-management');
        }
    }

    async exportAssessmentsExcel(req, res) {
        try {
            // Permission check: Both SuperAdmin and LocalAdmin allowed
            if (!req.user) return res.status(403).json({ error: 'Access denied' });

            const workbook = await UnifiedExportService.exportAssessments(req.user);

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader('Content-Disposition', 'attachment; filename=assessments_export.xlsx');

            await workbook.xlsx.write(res);
            res.end();

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_EXPORT',
                entityType: 'assessments',
                details: `Exported assessments to Excel via Unified Service`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Export assessments Excel error:', error);
            req.flash(
                'error',
                req.t
                    ? req.t('flash:dm_export_excel_error')
                    : 'Error exporting assessments to Excel. Data might be too large.'
            );
            res.redirect('/data-management');
        }
    }

    async exportAssessmentsJSON(req, res) {
        try {
            // Permission check
            if (!req.user) return res.status(403).json({ error: 'Access denied' });

            const data = await UnifiedExportService.exportAssessmentsJSON(req.user);

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=assessments_export.json');
            res.send(JSON.stringify(data, null, 2));

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_EXPORT',
                entityType: 'assessments',
                details: `Exported assessments to JSON via Unified Service`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Export assessments JSON error:', error);
            res.status(500).json({ error: 'Error exporting assessments to JSON' });
        }
    }

    async exportHistory(req, res) {
        try {
            const employees = await RBACService.getFilteredEmployees(req.user, {
                includeInactive: true,
            }); // data export: whole population, leavers included
            const employeeIds = employees.map((e) => e.id);

            if (employeeIds.length === 0) {
                return res.status(400).json({ error: 'No employees to export' });
            }

            const placeholders = employeeIds.map(() => '?').join(',');
            const history = await db.all(
                `
                SELECT ah.*, s.name as skillName, d.name as domainName, a.username as assessedByUsername
                FROM assessmentHistory ah
                INNER JOIN skills s ON ah.skillId = s.id
                INNER JOIN domains d ON s.domainId = d.id
                LEFT JOIN admins a ON ah.assessedBy = a.id
                WHERE ah.employeeId IN (${placeholders})
                ORDER BY ah.assessedAt DESC
            `,
                employeeIds
            );

            // Create employee map
            const employeeMap = {};
            employees.forEach((emp) => {
                employeeMap[emp.id] = emp;
            });

            // Convert to CSV
            const headers = [
                'Employee Number',
                'Employee Name',
                'Skill',
                'Domain',
                'Previous Level',
                'New Level',
                'Assessed At',
                'Assessed By',
                'Notes',
            ];
            const rows = history.map((entry) => {
                const emp = employeeMap[entry.employeeId];
                return [
                    emp ? emp.employeeNumber : '',
                    emp ? `${emp.firstName} ${emp.lastName}` : '',
                    entry.skillName || '',
                    entry.domainName || '',
                    entry.previousLevel !== null ? entry.previousLevel : 'N/A',
                    entry.newLevel,
                    entry.assessedAt || '',
                    entry.assessedByUsername || '',
                    entry.notes || '',
                ];
            });

            const csv =
                '﻿' + // UTF-8 BOM so Excel opens accented names without mojibake
                [headers, ...rows]
                    .map((row) => row.map((cell) => csvCell(cell)).join(','))
                    .join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader(
                'Content-Disposition',
                'attachment; filename=assessment_history_export.csv'
            );
            res.send(csv);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_EXPORT',
                entityType: 'assessmentHistory',
                details: `Exported ${history.length} history entries`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Export history error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:dm_export_history_error') : 'Error exporting history'
            );
            res.redirect('/data-management');
        }
    }

    // ========== TEMPLATE DOWNLOAD FUNCTIONS ==========

    async downloadDomainsSkillsTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const workbook = await TemplateGenerator.generateDomainsSkillsTemplate();

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader(
                'Content-Disposition',
                'attachment; filename=domains_skills_template.xlsx'
            );

            await workbook.xlsx.write(res);
            res.end();

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'domainsSkills',
                details: 'Downloaded Domains & Skills template',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download domains & skills template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadOrganizationTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const workbook = await TemplateGenerator.generateOrganizationTemplate();

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader('Content-Disposition', 'attachment; filename=organization_template.xlsx');

            await workbook.xlsx.write(res);
            res.end();

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'organization',
                details: 'Downloaded Organization template',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download organization template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadEmployeesTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const workbook = await TemplateGenerator.generateEmployeesTemplate();

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader('Content-Disposition', 'attachment; filename=employees_template.xlsx');

            await workbook.xlsx.write(res);
            res.end();

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'employees',
                details: 'Downloaded Employees template',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download employees template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadLocalAdminsTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const template = TemplateGenerator.generateLocalAdminsTemplate();

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=local_admins_template.json');
            res.send(JSON.stringify(template, null, 2));

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'localAdmins',
                details: 'Downloaded Local Admins template',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download local admins template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadRolesTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const workbook = await TemplateGenerator.generateRolesTemplate();

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader('Content-Disposition', 'attachment; filename=roles_template.xlsx');

            await workbook.xlsx.write(res);
            res.end();

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'roles',
                details: 'Downloaded Roles template',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download roles template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadAssessmentsTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const workbook = await TemplateGenerator.generateAssessmentsTemplate();

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader('Content-Disposition', 'attachment; filename=assessments_template.xlsx');

            await workbook.xlsx.write(res);
            res.end();

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'assessments',
                details: 'Downloaded Assessments template',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download assessments template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadFullSystemJsonTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const template = TemplateGenerator.generateFullSystemJsonTemplate();

            res.setHeader('Content-Type', 'application/json');
            res.setHeader(
                'Content-Disposition',
                'attachment; filename=migration_full_template.json'
            );
            res.send(JSON.stringify(template, null, 2));

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'fullSystemJson',
                details: 'Downloaded Full System JSON template',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download full system JSON template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadFullSystemTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const workbook = await TemplateGenerator.generateFullSystemTemplate();

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader('Content-Disposition', 'attachment; filename=full_system_template.xlsx');

            await workbook.xlsx.write(res);
            res.end();

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'fullSystemExcel',
                details: 'Downloaded Full System Excel template (pre-filled example)',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download full system Excel template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadDomainsSkillsJsonTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user))
                return res.status(403).json({ error: 'Access denied' });
            const template = TemplateGenerator.generateDomainsSkillsJsonTemplate();
            res.setHeader('Content-Type', 'application/json');
            res.setHeader(
                'Content-Disposition',
                'attachment; filename=domains_skills_template.json'
            );
            res.send(JSON.stringify(template, null, 2));
        } catch (error) {
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadOrganizationJsonTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user))
                return res.status(403).json({ error: 'Access denied' });
            const template = TemplateGenerator.generateOrganizationJsonTemplate();
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=organization_template.json');
            res.send(JSON.stringify(template, null, 2));
        } catch (error) {
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadEmployeesJsonTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user))
                return res.status(403).json({ error: 'Access denied' });
            const template = TemplateGenerator.generateEmployeesJsonTemplate();
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=employees_template.json');
            res.send(JSON.stringify(template, null, 2));
        } catch (error) {
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadRolesJsonTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user))
                return res.status(403).json({ error: 'Access denied' });
            const template = TemplateGenerator.generateRolesJsonTemplate();
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=roles_template.json');
            res.send(JSON.stringify(template, null, 2));
        } catch (error) {
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadAssessmentsJsonTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user))
                return res.status(403).json({ error: 'Access denied' });
            const template = TemplateGenerator.generateAssessmentsJsonTemplate();
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=assessments_template.json');
            res.send(JSON.stringify(template, null, 2));
        } catch (error) {
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async downloadSkillFrameworkTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const workbook = await TemplateGenerator.generateSkillFrameworkTemplate();

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader(
                'Content-Disposition',
                'attachment; filename=skill_framework_template.xlsx'
            );

            await workbook.xlsx.write(res);
            res.end();

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'skillFramework',
                details: 'Downloaded Complete Skill Framework template',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download skill framework template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    // ========== IMPORT FUNCTIONS ==========

    async importSkillFramework(req, res) {
        try {
            // Allow Local Admin for Skill Framework? Usually global.
            // Let's keep Framework Global (SuperAdmin) but allow Assessments Local.
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            // Read Excel file using exceljs
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            require('../utils/importGuards').assertSafeXlsxFile(req.file.path); // zip-bomb guard (SA-09)
            await workbook.xlsx.readFile(req.file.path);

            // Parse each sheet
            const data = {
                domains: [],
                skills: [],
                roles: [],
                requirements: [],
            };

            // Read Domains sheet
            const domainsSheet = workbook.getWorksheet('Domains');
            if (domainsSheet) {
                domainsSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1) return; // Skip header
                    const name = row.getCell(1).value;
                    const description = row.getCell(2).value;
                    if (name && name.toString().trim()) {
                        data.domains.push({
                            name: name.toString().trim(),
                            description: description ? description.toString().trim() : '',
                        });
                    }
                });
            }

            // Read Skills sheet
            const skillsSheet = workbook.getWorksheet('Skills');
            if (skillsSheet) {
                skillsSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1) return; // Skip header
                    const domainName = row.getCell(1).value;
                    const name = row.getCell(2).value;
                    const description = row.getCell(3).value;
                    if (
                        domainName &&
                        name &&
                        domainName.toString().trim() &&
                        name.toString().trim()
                    ) {
                        data.skills.push({
                            domainName: domainName.toString().trim(),
                            name: name.toString().trim(),
                            description: description ? description.toString().trim() : '',
                        });
                    }
                });
            }

            // Read Roles sheet
            const rolesSheet = workbook.getWorksheet('Roles');
            if (rolesSheet) {
                rolesSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1) return; // Skip header
                    const name = row.getCell(1).value;
                    const description = row.getCell(2).value;
                    if (name && name.toString().trim()) {
                        data.roles.push({
                            name: name.toString().trim(),
                            description: description ? description.toString().trim() : '',
                        });
                    }
                });
            }

            // Read Requirements sheet
            const requirementsSheet = workbook.getWorksheet('Requirements');
            if (requirementsSheet) {
                requirementsSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1) return; // Skip header
                    const roleName = row.getCell(1).value;
                    const skillName = row.getCell(2).value;
                    const requiredLevel = row.getCell(3).value;
                    const isCritical = row.getCell(4).value;
                    if (
                        roleName &&
                        skillName &&
                        roleName.toString().trim() &&
                        skillName.toString().trim()
                    ) {
                        data.requirements.push({
                            roleName: roleName.toString().trim(),
                            skillName: skillName.toString().trim(),
                            requiredLevel:
                                requiredLevel !== null && requiredLevel !== undefined
                                    ? parseInt(requiredLevel)
                                    : 0,
                            isCritical: isCritical ? isCritical.toString().trim() : 'No',
                        });
                    }
                });
            }

            // Clean up uploaded file
            const fs = require('fs');
            fs.unlinkSync(req.file.path);

            // Import using service
            const results = await ImportExportService.importSkillFramework(data, req.user.id);

            // Log the import
            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_IMPORT',
                entityType: 'skillFramework',
                details: `Created: ${results.domains.created} domains, ${results.skills.created} skills, ${results.roles.created} roles, ${results.requirements.created} requirements | Skipped (existing): ${results.domains.skipped} domains, ${results.skills.skipped} skills, ${results.roles.skipped} roles, ${results.requirements.skipped} requirements`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, results });
        } catch (error) {
            console.error('Import skill framework error:', error);
            if (req.file && require('fs').existsSync(req.file.path)) {
                require('fs').unlinkSync(req.file.path);
            }
            res.status(500).json({ error: error.message || 'Error importing skill framework' });
        }
    }

    async importOrganization(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const fs = require('fs');
            const csvText = fs.readFileSync(req.file.path, 'utf8');
            fs.unlinkSync(req.file.path); // Clean up temp file

            // Parse CSV
            const lines = csvText.split('\n').filter((l) => l.trim());
            const data = { sites: [], departments: [], services: [] };
            let currentSection = null;
            let skipHeader = false; // the line right after a section marker is its column header

            for (const line of lines) {
                if (line.includes('=== SITES ===')) {
                    currentSection = 'sites';
                    skipHeader = true;
                    continue;
                } else if (line.includes('=== DEPARTMENTS ===')) {
                    currentSection = 'departments';
                    skipHeader = true;
                    continue;
                } else if (line.includes('=== SERVICES ===')) {
                    currentSection = 'services';
                    skipHeader = true;
                    continue;
                }

                if (line.startsWith('===') || !line.trim()) continue;
                if (skipHeader) {
                    skipHeader = false;
                    continue;
                } // skip the per-section header row

                const values = ImportExportService.parseCSVLine(line);
                if (currentSection === 'sites' && values.length >= 1) {
                    data.sites.push({
                        name: values[0],
                        code: values[1] || '',
                        description: values[2] || '',
                    });
                } else if (currentSection === 'departments' && values.length >= 2) {
                    data.departments.push({
                        siteName: values[0],
                        name: values[1],
                        code: values[2] || '',
                        description: values[3] || '',
                    });
                } else if (currentSection === 'services' && values.length >= 3) {
                    data.services.push({
                        siteName: values[0],
                        departmentName: values[1],
                        name: values[2],
                        code: values[3] || '',
                        description: values[4] || '',
                    });
                }
            }

            const results = await ImportExportService.importOrganization(data, req.user.id);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_IMPORT',
                entityType: 'organization',
                details: `Imported organization: ${results.sites.created} sites, ${results.departments.created} departments, ${results.services.created} services`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, results });
        } catch (error) {
            console.error('Import organization error:', error);
            res.status(500).json({ error: error.message || 'Error importing organization' });
        }
    }

    async importDomainsSkills(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const fs = require('fs');
            const csvText = fs.readFileSync(req.file.path, 'utf8');
            fs.unlinkSync(req.file.path);

            const lines = csvText.split('\n').filter((l) => l.trim());
            const data = { domains: [], subDomains: [], skills: [] };
            let currentSection = null;
            let skipHeader = false; // the line right after a section marker is its column header

            for (const line of lines) {
                if (line.includes('=== DOMAINS ===')) {
                    currentSection = 'domains';
                    skipHeader = true;
                    continue;
                } else if (line.includes('=== SUB-DOMAINS ===')) {
                    currentSection = 'subDomains';
                    skipHeader = true;
                    continue;
                } else if (line.includes('=== SKILLS ===')) {
                    currentSection = 'skills';
                    skipHeader = true;
                    continue;
                }

                if (line.startsWith('===') || !line.trim()) continue;
                if (skipHeader) {
                    skipHeader = false;
                    continue;
                } // skip the per-section header row

                const values = ImportExportService.parseCSVLine(line);
                if (currentSection === 'domains' && values.length >= 1) {
                    data.domains.push({ name: values[0], description: values[1] || '' });
                } else if (currentSection === 'subDomains' && values.length >= 2) {
                    data.subDomains.push({
                        domainName: values[0],
                        name: values[1],
                        definition: values[2] || '',
                    });
                } else if (currentSection === 'skills' && values.length >= 3) {
                    // New wide layout: Domain, Sub-Domain, Name, Category, Description.
                    data.skills.push({
                        domainName: values[0],
                        subDomainName: values[1] || '',
                        name: values[2],
                        category: values[3] || '',
                        description: values[4] || '',
                    });
                } else if (currentSection === 'skills' && values.length === 2) {
                    // Back-compat: old narrow layout Domain, Name (Description).
                    data.skills.push({
                        domainName: values[0],
                        name: values[1],
                        description: values[2] || '',
                    });
                }
            }

            const results = await ImportExportService.importDomainsSkills(data, req.user.id);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_IMPORT',
                entityType: 'domainsSkills',
                details: `Imported: ${results.domains.created} domains, ${results.skills.created} skills`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, results });
        } catch (error) {
            console.error('Import domains & skills error:', error);
            res.status(500).json({ error: error.message || 'Error importing domains & skills' });
        }
    }

    async importRoles(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            // Determine file type and parse accordingly
            const fs = require('fs');
            const path = require('path');
            const ext = path.extname(req.file.originalname).toLowerCase();
            let data = [];

            if (ext === '.json') {
                const jsonText = fs.readFileSync(req.file.path, 'utf8');
                data = JSON.parse(jsonText);
                fs.unlinkSync(req.file.path);
            } else if (ext === '.csv') {
                const csvText = fs.readFileSync(req.file.path, 'utf8');
                fs.unlinkSync(req.file.path);

                // Parse CSV using service helper
                const lines = csvText.split('\n').filter((l) => l.trim());
                if (!lines.length) {
                    return res
                        .status(400)
                        .json({ success: false, error: 'The uploaded CSV file is empty.' });
                }
                // Skip header if present (assuming header exists if first line contains 'Name' or 'Role')
                const header = lines[0].toLowerCase();
                const startIndex = header.includes('name') || header.includes('role') ? 1 : 0;

                for (let i = startIndex; i < lines.length; i++) {
                    const values = ImportExportService.parseCSVLine(lines[i]);
                    if (values.length > 0) {
                        data.push({
                            name: values[0],
                            description: values[1] || '',
                            roleFamily: values[2] || '',
                        });
                    }
                }
            } else if (ext === '.xlsx') {
                // Read Excel file using exceljs
                const ExcelJS = require('exceljs');
                const workbook = new ExcelJS.Workbook();
                require('../utils/importGuards').assertSafeXlsxFile(req.file.path); // zip-bomb guard (SA-09)
                await workbook.xlsx.readFile(req.file.path);
                const worksheet = workbook.getWorksheet(1); // First sheet

                if (worksheet) {
                    worksheet.eachRow((row, rowNumber) => {
                        if (rowNumber === 1) return; // Assume header

                        // Try to find name column
                        // Simple approach: Column 1 is Name, Column 2 is Description
                        const name = row.getCell(1).value;
                        const description = row.getCell(2).value;
                        const roleFamily = row.getCell(3).value;

                        if (name) {
                            data.push({
                                name: name.toString(),
                                description: description ? description.toString() : '',
                                roleFamily: roleFamily ? roleFamily.toString() : '',
                            });
                        }
                    });
                }
                fs.unlinkSync(req.file.path);
            }

            const results = await ImportExportService.importRoles(data, req.user.id);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_IMPORT',
                entityType: 'roles',
                details: `Imported roles: ${results.created} created, ${results.skipped} skipped`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, results });
        } catch (error) {
            console.error('Import roles error:', error);
            if (req.file && require('fs').existsSync(req.file.path)) {
                require('fs').unlinkSync(req.file.path);
            }
            res.status(500).json({ error: error.message || 'Error importing roles' });
        }
    }

    async importEmployees(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const fs = require('fs');
            const csvText = fs.readFileSync(req.file.path, 'utf8');
            fs.unlinkSync(req.file.path);

            const data = ImportExportService.parseCSV(csvText);
            const results = await ImportExportService.importEmployees(data, req.user);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_IMPORT',
                entityType: 'employees',
                details: `Imported ${results.created} employees`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, results });
        } catch (error) {
            console.error('Import employees error:', error);
            res.status(500).json({ error: error.message || 'Error importing employees' });
        }
    }

    async importLocalAdmins(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const fs = require('fs');
            const jsonText = fs.readFileSync(req.file.path, 'utf8');
            fs.unlinkSync(req.file.path);

            const data = JSON.parse(jsonText);
            const results = await ImportExportService.importLocalAdmins(
                Array.isArray(data) ? data : [data],
                req.user.id
            );

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_IMPORT',
                entityType: 'localAdmins',
                details: `Imported ${results.created} local admins`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, results });
        } catch (error) {
            console.error('Import local admins error:', error);
            res.status(500).json({ error: error.message || 'Error importing local admins' });
        }
    }

    // ========== SNAPSHOT FUNCTIONS ==========

    async createSnapshot(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const { name, description } = req.body;
            if (!name || !name.trim()) {
                return res.status(400).json({ error: 'Snapshot name is required' });
            }

            const snapshot = await SnapshotService.createSnapshot(
                name.trim(),
                description?.trim(),
                req.user.id
            );

            await LogService.log({
                adminId: req.user.id,
                action: 'SNAPSHOT_CREATED',
                entityType: 'snapshot',
                entityId: snapshot.id,
                details: `Created snapshot: ${name}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, snapshot });
        } catch (error) {
            console.error('Create snapshot error:', error);
            res.status(500).json({ error: error.message || 'Error creating snapshot' });
        }
    }

    async restoreSnapshot(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Accept the id from the REST path (/snapshots/:id/restore) or the body.
            const snapshotId = req.params.id || req.body.snapshotId;
            if (!snapshotId) {
                return res.status(400).json({ error: 'Snapshot ID is required' });
            }

            const result = await SnapshotService.restoreSnapshot(parseInt(snapshotId), req.user.id);

            await LogService.log({
                adminId: req.user.id,
                action: 'SNAPSHOT_RESTORED',
                entityType: 'snapshot',
                entityId: snapshotId,
                details: `Restored snapshot ${snapshotId}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json(result);
        } catch (error) {
            console.error('Restore snapshot error:', error);
            res.status(500).json({ error: error.message || 'Error restoring snapshot' });
        }
    }

    async deleteSnapshot(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const { id } = req.params;
            await SnapshotModel.delete(id);

            await LogService.log({
                adminId: req.user.id,
                action: 'SNAPSHOT_DELETED',
                entityType: 'snapshot',
                entityId: id,
                details: `Deleted snapshot ${id}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true });
        } catch (error) {
            console.error('Delete snapshot error:', error);
            res.status(500).json({ error: error.message || 'Error deleting snapshot' });
        }
    }

    async getSnapshotStats(req, res) {
        try {
            const { id } = req.params;
            const stats = await SnapshotService.getSnapshotStats(parseInt(id));
            res.json(stats);
        } catch (error) {
            console.error('Get snapshot stats error:', error);
            res.status(500).json({ error: error.message || 'Error getting snapshot stats' });
        }
    }

    /**
     * The three counts of the statistics card, scoped to the caller.
     * Shared by the server render and by the refresh endpoint so the page can
     * never show one number before the fetch and another after it.
     */
    async computeStatistics(user) {
        const employees = await RBACService.getFilteredEmployees(user, { includeInactive: true }); // data export: whole population, leavers included
        const employeeIds = employees.map((e) => e.id);

        let totalAssessments = 0;
        let totalHistoryEntries = 0;

        if (employeeIds.length > 0) {
            // A COUNT, not a full materialisation, for a number.
            totalAssessments = await SkillAssessmentModel.countForEmployees(employeeIds);

            const placeholders = employeeIds.map(() => '?').join(',');
            const historyCount = await db.get(
                `
                SELECT COUNT(*) as count FROM assessmentHistory
                WHERE employeeId IN (${placeholders})
            `,
                employeeIds
            );
            totalHistoryEntries = historyCount ? historyCount.count : 0;
        }

        return { totalEmployees: employees.length, totalAssessments, totalHistoryEntries };
    }

    async getStatistics(req, res) {
        try {
            res.json(await this.computeStatistics(req.user));
        } catch (error) {
            console.error('Get statistics error:', error);
            res.status(500).json({ error: 'Error loading statistics' });
        }
    }

    // ========== RESET FUNCTION ==========

    async resetDatabase(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const { confirmation } = req.body;
            if (confirmation !== 'RESET_ALL_DATA') {
                return res.status(400).json({
                    error: 'Invalid confirmation. Please type RESET_ALL_DATA to confirm.',
                });
            }

            // Get default admin info before deletion
            const defaultAdmin = await db.get('SELECT * FROM admins WHERE username = ?', ['admin']);
            if (!defaultAdmin) {
                return res.status(500).json({
                    error: 'Default admin account not found. Cannot reset database safely. Please ensure the default admin (username: admin) exists.',
                });
            }

            // Store default admin data to preserve it
            const defaultAdminData = {
                id: defaultAdmin.id,
                username: defaultAdmin.username,
                email: defaultAdmin.email,
                passwordHash: defaultAdmin.passwordHash,
                role: defaultAdmin.role,
                isActive: defaultAdmin.isActive,
                createdAt: defaultAdmin.createdAt,
            };

            // Create backup before resetting.
            //
            // this used to "log it heavily but proceed", so a reset
            // could wipe the instance with NO backup while the audit line read
            // "Automatic backup: FAILED". The snapshot restore next to it already
            // aborts when its pre-dump fails; the reset now behaves the same way.
            // The safety net is the point of the safety net.
            const DatabaseCleanupService = require('../services/DatabaseCleanupService');
            let backupPath = null;
            try {
                backupPath = await DatabaseCleanupService.createBackup();
                console.log('Automatic backup created at:', backupPath);
            } catch (backupError) {
                console.error('Failed to create automatic backup — reset aborted:', backupError);
                await LogService.log({
                    adminId: req.user.id,
                    action: 'DATABASE_RESET_ABORTED',
                    entityType: 'database',
                    category: 'system',
                    severity: 'error',
                    details: `Reset aborted: the mandatory pre-reset backup failed (${String(backupError.message).slice(0, 200)}). Nothing was deleted.`,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                }).catch(() => {
                    /* audit best-effort */
                });
                return res.status(409).json({
                    error: 'backup_failed',
                    message: req.t
                        ? req.t('datamgmt:js_reset_backup_failed')
                        : 'The mandatory pre-reset backup failed. Nothing was deleted.',
                });
            }

            // Deletes run child → parent below, so foreign keys stay satisfied
            // (no PRAGMA needed on PostgreSQL). Wrap the destructive body in a single
            // transaction so a mid-reset failure rolls everything back.
            //
            // THE APPEND-ONLY GUARD, HANDLED THE WAY THE REST OF THE PRODUCT DOES.
            //
            // assessment_history, review_signatures and system_logs carry a BEFORE
            // DELETE/UPDATE `block_mutation` trigger that RAISES `IMMUTABLE_TABLE`.
            // Inside a PostgreSQL transaction that raise poisons every following
            // statement, so the whole reset ROLLBACKs and clears nothing. The old
            // code opened with `DELETE FROM assessmentHistory` and also deleted
            // `systemLogs`, so the documented wipe could never succeed — it 500'd.
            //
            // Skipping those three tables is NOT sufficient either, because the
            // guard is reached by CASCADE from tables the reset must clear:
            //   employees            -> assessment_history        (ON DELETE CASCADE)
            //   skills               -> assessment_history        (ON DELETE CASCADE)
            //   employees -> supervisor_reviews -> review_signatures (CASCADE)
            //   admins               -> system_logs.admin_id      (ON DELETE SET NULL
            //                                                      = an UPDATE, also blocked)
            //
            // So we use the SAME mechanism as scripts/reset-for-golive.js (the
            // supported go-live wipe): disable the block_mutation triggers for the
            // duration of this explicitly-confirmed, backup-first transaction, then
            // re-enable them. ALTER TABLE is transactional, so a rollback restores
            // them automatically. system_logs is emptied by NOBODY — the audit trail
            // must survive the reset that it records; only the FK's SET NULL touches
            // it. DatabaseCleanupService.IMMUTABLE_TABLES stays the single source of
            // truth for which tables are append-only.
            const RESET_ORDER = [
                'assessmentHistory',
                'skillAssessments',
                'employees',
                'adminScopes',
                'roleSkillRequirements',
                'appSettings',
                'services',
                'departments',
                'sites',
                'skills',
                'domains',
                'roles',
                'snapshots',
            ];
            // Never emptied, and never entered through a dependency: the audit
            // trail, the migration ledger, the session store (this request's own
            // session) and the admins table (non-default admins are deleted below,
            // once nothing references them any more).
            const PRESERVED_TABLES = ['system_logs', 'schema_meta', 'session', 'admins'];
            const preserved = [
                'system_logs (append-only audit trail)',
                'schema_meta',
                'session',
                'admins (default admin kept)',
            ];
            const cleared = {};
            let toggled = [];
            let plan = { order: [], added: [], cycle: [] };

            await db.runTransaction(async () => {
                // Pre-flight: suspend the append-only guards. Requires table
                // ownership; if it fails nothing has been deleted yet and the whole
                // transaction rolls back with a clear message.
                toggled = await db.all(`
                    SELECT c.relname AS tbl, t.tgname AS tgname
                    FROM pg_trigger t
                    JOIN pg_class c ON c.oid = t.tgrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE n.nspname = 'public' AND NOT t.tgisinternal AND p.proname = 'block_mutation'`);
                for (const { tbl, tgname } of toggled) {
                    await db.run(`ALTER TABLE public."${tbl}" DISABLE TRIGGER "${tgname}"`);
                }

                // Everything that references the wiped tables — transitively — is
                // emptied first, children before parents, from the LIVE foreign-key
                // graph (DatabaseCleanupService.wipePlan). The 13-table list above
                // trusted CASCADE for the other ~110 tables; seven foreign keys onto
                // employees do not cascade, so with ONE coaching session on file the
                // reset died on "fk_coaching_sessions_coach" (customer, 2026-09-09).
                // Non-default admins are deleted right after, so the tables that
                // reference admins (api_keys, assessment_cycles, maker_checker_requests,
                // …) are part of the plan too.
                const roots = RESET_ORDER.map((t) => DatabaseCleanupService.pgName(t));
                const adminDependents = (
                    await db.all(
                        `SELECT DISTINCT c.conrelid::regclass::text AS tbl FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.confrelid = 'public.admins'::regclass AND c.conrelid <> c.confrelid`
                    )
                ).map((r) =>
                    String(r.tbl)
                        .replace(/^public\./, '')
                        .replace(/"/g, '')
                );
                plan = await DatabaseCleanupService.wipePlan(
                    [...roots, ...adminDependents],
                    PRESERVED_TABLES
                );
                for (const table of plan.order) {
                    // A table absent from a partial install would also abort the
                    // transaction — precheck instead of try/catch.
                    const reg = await db.get('SELECT to_regclass(?) AS oid', [`public.${table}`]);
                    if (!reg || !reg.oid) {
                        cleared[table] = 'absent';
                        continue;
                    }
                    const before = await db.get(`SELECT COUNT(*) AS count FROM public."${table}"`);
                    await db.run(`DELETE FROM public."${table}"`);
                    cleared[table] = Number(before.count);
                }

                // Delete all admins except the default one (safer - preserves the account)
                await db.run('DELETE FROM admins WHERE username != ?', ['admin']);

                // Verify default admin still exists (should always be true, but double-check)
                const verifyAdmin = await db.get('SELECT * FROM admins WHERE username = ?', [
                    'admin',
                ]);
                if (!verifyAdmin) {
                    // If somehow deleted (shouldn't happen), restore it
                    await db.run(
                        'INSERT INTO admins (username, email, passwordHash, role, isActive) VALUES (?, ?, ?, ?, ?)',
                        [
                            defaultAdminData.username,
                            defaultAdminData.email,
                            defaultAdminData.passwordHash,
                            defaultAdminData.role,
                            defaultAdminData.isActive,
                        ]
                    );
                }

                // Re-initialize default app settings
                const AppSettingsModel = require('../models/AppSettingsModel');
                await AppSettingsModel.initializeDefaults();

                // Restore the append-only guards before COMMIT. (A rollback would
                // restore them too — ALTER TABLE is transactional — but re-enabling
                // explicitly keeps the committed state unambiguous.)
                for (const { tbl, tgname } of toggled) {
                    await db.run(`ALTER TABLE public."${tbl}" ENABLE TRIGGER "${tgname}"`);
                }
            });

            // The reset never clears the audit trail (system_logs is append-only), so
            // this entry lands on top of the existing history rather than being the
            // first row of an emptied table. Record the true row counts and the
            // tables deliberately preserved.
            const clearedTotal = Object.values(cleared).reduce(
                (n, v) => n + (typeof v === 'number' ? v : 0),
                0
            );
            await LogService.log({
                adminId: req.user.id,
                action: 'DATABASE_RESET',
                entityType: 'database',
                details:
                    `Database reset: ${clearedTotal} rows cleared across ${Object.keys(cleared).length} tables (${JSON.stringify(cleared)}). ` +
                    `Dependents added from the live FK graph: ${plan.added.join(', ') || 'none'}${plan.cycle.length ? `; unordered cycle: ${plan.cycle.join(', ')}` : ''}. ` +
                    `Append-only guard suspended for the reset transaction on: ${toggled.map((t) => t.tbl).join(', ') || 'none'} (re-enabled). ` +
                    `Preserved: ${preserved.join(', ')}. ` +
                    `Automatic backup: ${backupPath ? path.basename(backupPath) : 'FAILED'}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({
                success: true,
                message:
                    `Database reset successfully. Backup created: ${backupPath ? path.basename(backupPath) : 'None'}. ` +
                    `${clearedTotal} rows cleared; default admin kept. Preserved: ${preserved.join(', ')}.`,
                backup: backupPath,
                cleared,
                preserved,
            });
        } catch (error) {
            console.error('Reset database error:', error);
            res.status(500).json({ error: error.message || 'Error resetting database' });
        }
    }

    async importAssessments(req, res) {
        try {
            // Access Control: SuperAdmin OR LocalAdmin
            if (!req.user || (req.user.role !== 'superadmin' && req.user.role !== 'localadmin')) {
                return res.status(403).json({ error: 'Access denied' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const path = require('path');
            const fs = require('fs');
            const ext = path.extname(req.file.originalname).toLowerCase();

            let result;
            if (ext === '.json') {
                const jsonText = fs.readFileSync(req.file.path, 'utf8');
                const jsonData = JSON.parse(jsonText);
                result = await UnifiedImportService.importAssessmentsJSON(jsonData, req.user.id);
            } else {
                // Assume Excel
                result = await UnifiedImportService.importAssessments(req.file.path);
            }

            // Clean up file
            fs.unlink(req.file.path, () => {});

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_IMPORT',
                entityType: 'assessments',
                details: `Imported assessments (${ext}): ${JSON.stringify(result.results)}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({
                success: true,
                message: 'Assessments imported successfully',
                results: result.results,
            });
        } catch (error) {
            console.error('Import assessments error:', error);
            if (req.file && require('fs').existsSync(req.file.path)) {
                require('fs').unlink(req.file.path, () => {});
            }
            res.status(500).json({ error: error.message });
        }
    }

    async exportFullSystem(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }

            const workbook = await UnifiedExportService.exportFullSystem();

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader('Content-Disposition', 'attachment; filename=system_full_backup.xlsx');

            await workbook.xlsx.write(res);
            res.end();

            await LogService.log({
                adminId: req.user.id,
                action: 'SYSTEM_EXPORT_FULL',
                entityType: 'system',
                details: 'Full system data exported to Excel',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Full system export error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    async exportSystemJson(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }

            const data = await UnifiedJsonService.exportSystemToJson();

            // Named for what it is. This file is the PROVISIONING export (framework
            // incl. retired rows, organization, roles, employees, assessments, admins,
            // settings) — it does not carry the audit trail, assessment history or the
            // talent records, so "system_full_backup" overstated it. The true full
            // backup is a database snapshot / pg_dump. `data.metadata.scope` says the same.
            res.setHeader('Content-Type', 'application/json');
            res.setHeader(
                'Content-Disposition',
                'attachment; filename=system_provisioning_export.json'
            );
            res.send(JSON.stringify(data, null, 2));

            await LogService.log({
                adminId: req.user.id,
                action: 'SYSTEM_EXPORT_JSON',
                entityType: 'system',
                details:
                    'Provisioning data (framework, organization, roles, employees, assessments, admins, settings) exported to JSON',
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Full system JSON export error:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }

    async importFullSystem(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }

            if (!req.file) {
                return res.json({ success: false, message: 'No file uploaded' });
            }

            // Unified full framework import
            const result = await UnifiedImportService.importFullFramework(req.file.path);

            // Clean up uploaded file
            const fs = require('fs');
            fs.unlink(req.file.path, () => {});

            await LogService.log({
                adminId: req.user.id,
                action: 'DATABASE_IMPORT_FULL',
                entityType: 'system',
                details: `Full framework imported: ${JSON.stringify(result.results)}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({
                success: true,
                message: 'Framework imported successfully',
                results: result.results,
            });
        } catch (error) {
            console.error('Import error:', error);

            if (req.file) {
                const fs = require('fs');
                if (fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
            }

            res.json({
                success: false,
                message: error.message,
            });
        }
    }

    async importSystemJson(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }

            if (!req.file) {
                return res.json({ success: false, message: 'No file uploaded' });
            }

            const fs = require('fs');
            const fileContent = fs.readFileSync(req.file.path, 'utf8');
            const jsonData = JSON.parse(fileContent);

            const result = await UnifiedJsonService.importSystemFromJson(jsonData, req.user);

            // Clean up uploaded file
            fs.unlink(req.file.path, () => {});

            await LogService.log({
                adminId: req.user.id,
                action: 'SYSTEM_IMPORT_JSON',
                entityType: 'system',
                details: `Full system imported from JSON: ${JSON.stringify(result.results)}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({
                success: true,
                message: 'System imported successfully from JSON',
                results: result.results,
            });
        } catch (error) {
            console.error('Full system JSON import error:', error);
            if (req.file) {
                const fs = require('fs');
                if (fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
            }
            res.json({
                success: false,
                message: error.message,
            });
        }
    }

    // Dry-run preview of a full-system JSON import (onboarding wizard step 2):
    // reports new-vs-existing counts and how many logins would be generated,
    // without writing anything.
    async previewSystemJson(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }
            if (!req.file) {
                return res.json({ success: false, message: 'No file uploaded' });
            }
            const fs = require('fs');
            const fileContent = fs.readFileSync(req.file.path, 'utf8');
            fs.unlink(req.file.path, () => {});
            const jsonData = JSON.parse(fileContent);
            const preview = await UnifiedJsonService.previewSystemFromJson(jsonData);
            res.json({ success: true, preview });
        } catch (error) {
            console.error('Preview system JSON error:', error);
            if (req.file) {
                const fs = require('fs');
                if (fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
            }
            res.json({ success: false, message: error.message });
        }
    }

    async previewImport(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }

            if (!req.file) {
                return res.json({ success: false, message: 'No file uploaded' });
            }

            // Preview validates file structure
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            require('../utils/importGuards').assertSafeXlsxFile(req.file.path); // zip-bomb guard (SA-09)
            await workbook.xlsx.readFile(req.file.path);

            // Validate using the SAME sheet-name aliases the importer accepts
            // (importFullFramework's getWorksheet) — the export names its sheets
            // "Domains & Skills" / "Roles" / "Employees", so checking hard-coded
            // "Data Model" etc. falsely reported "missing sheets" for a file the
            // importer would happily accept.
            const hasSheet = (names) => names.some((n) => !!workbook.getWorksheet(n));
            const checks = {
                'Domains & Skills': hasSheet([
                    'Domains & Skills',
                    'Domains_Skills',
                    'Skills',
                    'Data Model',
                ]),
                Roles: hasSheet(['Roles', 'Roles ', 'Role Requirements']),
                Employees: hasSheet([
                    'Employees',
                    'Employee Directory',
                    'Employees_Live',
                    'Employee Directory & Skills',
                ]),
            };

            const isValid = Object.values(checks).every((v) => v === true);

            // Clean up uploaded file
            const fs = require('fs');
            fs.unlink(req.file.path, () => {});

            res.json({
                success: true,
                validation: {
                    valid: isValid,
                    checks,
                    message: isValid
                        ? 'File structure is valid for framework import'
                        : 'Missing required sheets',
                },
            });
        } catch (error) {
            console.error('Preview import error:', error);
            if (req.file) {
                const fs = require('fs');
                if (fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
            }
            res.json({
                success: false,
                message: error.message,
            });
        }
    }

    // ========== SKILL MATRIX (single-file provisioning: Excel/JSON/XML/CSV) ==========

    // Map a route :format param (or file extension) to a service format.
    _smFormat(value) {
        const v = String(value || '')
            .toLowerCase()
            .replace(/^\./, '');
        if (v === 'xlsx' || v === 'xls' || v === 'excel') return 'excel';
        if (v === 'json') return 'json';
        if (v === 'xml') return 'xml';
        if (v === 'csv') return 'csv';
        if (v === 'yaml' || v === 'yml') return 'yaml';
        return null;
    }

    async exportSkillMatrix(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }
            const format = this._smFormat(req.params.format) || 'excel';

            // The workbook carries personal data, so it must be built inside the
            // caller's clearance — the sibling exportEmployees already does this.
            const { buffer, contentType, ext } = await SkillMatrixWorkbookService.exportData(
                format,
                req.user
            );

            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `attachment; filename=skill_matrix_export.${ext}`);
            res.send(buffer);

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_EXPORT',
                entityType: 'skillMatrix',
                details: `Exported Skill Matrix (.${ext})`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Export skill matrix error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:dm_export_matrix_error') : 'Error exporting skill matrix'
            );
            res.redirect('/data-management');
        }
    }

    async downloadSkillMatrixTemplate(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }
            const format = this._smFormat(req.params.format) || 'excel';

            const { buffer, contentType, ext } =
                await SkillMatrixWorkbookService.buildTemplateData(format);

            res.setHeader('Content-Type', contentType);
            res.setHeader(
                'Content-Disposition',
                `attachment; filename=skill_matrix_template.${ext}`
            );
            res.send(buffer);

            await LogService.log({
                adminId: req.user.id,
                action: 'TEMPLATE_DOWNLOAD',
                entityType: 'skillMatrix',
                details: `Downloaded Skill Matrix template (.${ext})`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
        } catch (error) {
            console.error('Download skill matrix template error:', error);
            res.status(500).json({ error: 'Error generating template' });
        }
    }

    async previewSkillMatrix(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ success: false, message: 'Unauthorized' });
            }
            if (!req.file) {
                return res.json({ success: false, message: 'No file uploaded' });
            }
            const format = this._smFormat(require('path').extname(req.file.originalname));
            if (!format) {
                require('fs').unlink(req.file.path, () => {});
                return res.json({
                    success: false,
                    message: 'Unsupported file type. Use .xlsx, .json, .xml or .csv',
                });
            }

            const preview = await SkillMatrixWorkbookService.preview(req.file.path, format);

            require('fs').unlink(req.file.path, () => {});
            res.json({ success: true, preview });
        } catch (error) {
            console.error('Preview skill matrix error:', error);
            if (req.file && require('fs').existsSync(req.file.path)) {
                require('fs').unlink(req.file.path, () => {});
            }
            res.json({ success: false, message: error.message });
        }
    }

    async importSkillMatrix(req, res) {
        try {
            if (!RBACService.canUseDataManagement(req.user)) {
                return res.status(403).json({ error: 'Access denied' });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }
            const format = this._smFormat(require('path').extname(req.file.originalname));
            if (!format) {
                require('fs').unlink(req.file.path, () => {});
                return res
                    .status(400)
                    .json({ error: 'Unsupported file type. Use .xlsx, .json, .xml or .csv' });
            }

            const result = await SkillMatrixWorkbookService.import(
                req.file.path,
                req.user.id,
                format
            );

            require('fs').unlink(req.file.path, () => {});

            await LogService.log({
                adminId: req.user.id,
                action: 'DATA_IMPORT',
                entityType: 'skillMatrix',
                details:
                    `Imported Skill Matrix (.${format}): ${JSON.stringify(result.results)}`.slice(
                        0,
                        4000
                    ),
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });

            res.json({ success: true, results: result.results });
        } catch (error) {
            console.error('Import skill matrix error:', error);
            if (req.file && require('fs').existsSync(req.file.path)) {
                require('fs').unlink(req.file.path, () => {});
            }
            res.status(500).json({ error: error.message || 'Error importing skill matrix' });
        }
    }
}

// Create controller instance
const dataManagementController = new DataManagementController();

// Export multer middleware (or dummy if not available)
dataManagementController.upload = upload;

module.exports = dataManagementController;
