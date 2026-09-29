const ReadinessService = require('../services/ReadinessService');
const RBACService = require('../services/RBACService');
const EmployeeModel = require('../models/EmployeeModel');
const ReportBuilderService = require('../services/ReportBuilderService');
const ReportDataService = require('../services/ReportDataService');
const db = require('../config/database');
const LogService = require('../services/LogService');
const { csvCell } = require('../utils/csvSafe');
const { personNameSql } = require('../utils/personName');

// Make a CSV open correctly in French Excel: prepend a UTF-8 BOM (accented
// names render, no mojibake) and a `sep=,` hint line (Excel then parses the
// comma delimiter even in fr-FR locales that default to ';', so rows no longer
// collapse into one column). Send with an explicit utf-8 charset.
// The BOM + `sep=,` wrapping itself lives in ReportBuilderService.excelCsv so
// the scheduled e-mail attachment goes through the exact same treatment as this
// interactive download (it used to attach the raw body → mojibake by e-mail,
// correct by download, same report).
function sendCsv(res, filename, body) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    return res.send(ReportBuilderService.excelCsv(body));
}

class ReportController {
    constructor() {
        // Bind methods to preserve 'this' context
        this.builder = this.builder.bind(this);
        this.generate = this.generate.bind(this);
        this.export = this.export.bind(this);
        this.listTemplates = this.listTemplates.bind(this);
        this.saveTemplate = this.saveTemplate.bind(this);
        this.loadTemplate = this.loadTemplate.bind(this);
        this.deleteTemplate = this.deleteTemplate.bind(this);
        this.getReferenceData = this.getReferenceData.bind(this);
        this.reportData = this.reportData.bind(this);
        this.readiness = this.readiness.bind(this);
        this.gaps = this.gaps.bind(this);
        this.powerbIEmployees = this.powerbIEmployees.bind(this);
        this.powerbIAssessments = this.powerbIAssessments.bind(this);
        this.powerbIReadiness = this.powerbIReadiness.bind(this);
        this.powerbIOrganization = this.powerbIOrganization.bind(this);
        this._odata = this._odata.bind(this);
        this.powerbINineBox = this.powerbINineBox.bind(this);
        this.powerbIPips = this.powerbIPips.bind(this);
        this.powerbIIdp = this.powerbIIdp.bind(this);
        this.powerbICoaching = this.powerbICoaching.bind(this);
        this.powerbIGoals = this.powerbIGoals.bind(this);
    }

    // Report builder — new composite multi-section builder
    async builder(req, res) {
        try {
            res.render('pages/reports/builder', {
                title: req.t ? req.t('chrome:pt_report_builder') : 'Report Builder',
                currentPath: '/reports',
            });
        } catch (error) {
            console.error('Report builder error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:report_builder_load_error') : 'Error loading report builder'
            );
            res.redirect('/dashboard');
        }
    }

    async generate(req, res) {
        try {
            const config = {
                dataSource: req.body.dataSource,
                selectedFields: JSON.parse(req.body.selectedFields || '[]'),
                filters: req.body.filters ? JSON.parse(req.body.filters) : null,
                sorting: req.body.sorting ? JSON.parse(req.body.sorting) : null,
                groupBy: req.body.groupBy ? JSON.parse(req.body.groupBy) : null,
            };

            const results = await ReportBuilderService.executeReport(config, req.user);

            res.json({
                success: true,
                data: results,
                count: results.length,
            });
        } catch (error) {
            console.error('Report generation error:', error);
            res.status(400).json({
                success: false,
                error: error.message,
            });
        }
    }

    async export(req, res) {
        try {
            const config = {
                dataSource: req.body.dataSource,
                selectedFields: JSON.parse(req.body.selectedFields || '[]'),
                filters: req.body.filters ? JSON.parse(req.body.filters) : null,
                sorting: req.body.sorting ? JSON.parse(req.body.sorting) : null,
                groupBy: req.body.groupBy ? JSON.parse(req.body.groupBy) : null,
            };

            const format = req.body.format || 'csv';
            const results = await ReportBuilderService.executeReport(config, req.user);

            if (format === 'csv') {
                const csv = ReportBuilderService.exportToCSV(results, config.selectedFields);
                return sendCsv(res, 'report.csv', csv);
            } else if (format === 'json') {
                const json = ReportBuilderService.exportToJSON(results);
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Content-Disposition', 'attachment; filename=report.json');
                return res.send(json);
            } else {
                throw new Error('Unsupported export format');
            }
        } catch (error) {
            console.error('Report export error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:report_export_error') : 'Error exporting report'
            );
            res.redirect('/reports/builder');
        }
    }

    async listTemplates(req, res) {
        try {
            // Own templates + public ones. Ownership is (creatorType, createdBy)
            // because employee (manager) ids and admin ids are separate sequences —
            // matching on createdBy alone leaked/collided across the two id-spaces.
            const actorType = req.user.userType === 'admin' ? 'admin' : 'employee';
            let query = `
                SELECT rt.*, a.username as createdByName
                FROM reportTemplates rt
                LEFT JOIN admins a ON rt.createdBy = a.id AND rt.creatorType = 'admin'
                WHERE rt.isPublic = true OR (rt.createdBy = ? AND rt.creatorType = ?)
                ORDER BY rt.updatedAt DESC
            `;

            const templates = await db.all(query, [req.user.id, actorType]);

            res.json({
                success: true,
                templates,
            });
        } catch (error) {
            console.error('List templates error:', error);
            res.status(400).json({
                success: false,
                error: error.message,
            });
        }
    }

    async saveTemplate(req, res) {
        try {
            const {
                name,
                description,
                reportType,
                dataSource,
                selectedFields,
                filters,
                sorting,
                groupBy,
                isPublic,
            } = req.body;
            if (!name || !String(name).trim()) {
                return res
                    .status(400)
                    .json({ success: false, error: 'A template name is required.' });
            }

            // report_type is a Postgres enum — map anything the UI sends (e.g.
            // 'composite'/'multi') to a valid value, defaulting to 'custom'.
            const VALID = [
                'employees',
                'assessments',
                'readiness',
                'skills',
                'roles',
                'organization',
                'custom',
            ];
            const rType = VALID.includes(reportType) ? reportType : 'custom';

            // Store the REAL creator identity: (creatorType, createdBy). Previously
            // a manager's save fell back to the default admin's id, so their private
            // template vanished from their own list (and could surface under an
            // admin whose id collided). No more impersonation.
            const creatorType = req.user.userType === 'admin' ? 'admin' : 'employee';
            const createdBy = req.user.id;

            // selected_fields is NOT NULL jsonb; accept a string (UI) or object.
            const asJson = (v) =>
                v == null ? null : typeof v === 'string' ? v : JSON.stringify(v);

            const row = await db.get(
                `
                INSERT INTO reportTemplates (name, description, reportType, dataSource, selectedFields, filters, sorting, groupBy, createdBy, creatorType, isPublic)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
            `,
                [
                    String(name).trim(),
                    description || null,
                    rType,
                    dataSource || 'multi',
                    asJson(selectedFields) || '[]',
                    asJson(filters),
                    asJson(sorting),
                    asJson(groupBy),
                    createdBy,
                    creatorType,
                    isPublic ? true : false,
                ]
            );

            res.json({
                success: true,
                templateId: row && row.id,
                message: 'Report template saved successfully',
            });
        } catch (error) {
            console.error('Save template error:', error);
            res.status(400).json({
                success: false,
                error: error.message,
            });
        }
    }

    async loadTemplate(req, res) {
        try {
            const templateId = req.params.id;

            const actorType = req.user.userType === 'admin' ? 'admin' : 'employee';
            const template = await db.get(
                `
                SELECT * FROM reportTemplates
                WHERE id = ? AND (isPublic = true OR (createdBy = ? AND creatorType = ?))
            `,
                [templateId, req.user.id, actorType]
            );

            if (!template) {
                return res.status(404).json({
                    success: false,
                    error: 'Template not found',
                });
            }

            // JSONB columns come back from the PG driver already parsed —
            // only JSON.parse when we actually got a string.
            const parseMaybe = (v) => (typeof v === 'string' ? JSON.parse(v) : (v ?? null));
            template.selectedFields = parseMaybe(template.selectedFields);
            template.filters = parseMaybe(template.filters);
            template.sorting = parseMaybe(template.sorting);
            template.groupBy = parseMaybe(template.groupBy);

            res.json({
                success: true,
                template,
            });
        } catch (error) {
            console.error('Load template error:', error);
            res.status(400).json({
                success: false,
                error: error.message,
            });
        }
    }

    async deleteTemplate(req, res) {
        try {
            const templateId = req.params.id;

            // Only allow deleting own templates or if superadmin
            let query = 'DELETE FROM reportTemplates WHERE id = ?';
            const params = [templateId];

            if (req.user.role !== 'superadmin') {
                query += ' AND createdBy = ? AND creatorType = ?';
                params.push(req.user.id, req.user.userType === 'admin' ? 'admin' : 'employee');
            }

            const result = await db.run(query, params);

            if (result.changes === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Template not found or access denied',
                });
            }

            res.json({
                success: true,
                message: 'Template deleted successfully',
            });
        } catch (error) {
            console.error('Delete template error:', error);
            res.status(400).json({
                success: false,
                error: error.message,
            });
        }
    }

    // ---- Report schedules: recurring email delivery of saved templates -------

    /** Schedules page: own schedules (all for superadmin) + schedulable templates. */
    async listSchedules(req, res) {
        try {
            const mine = req.user.role !== 'superadmin';
            // Ownership is (creator_type, created_by): employee and admin ids are
            // separate sequences, so created_by alone would show a manager an
            // admin's schedule of the same id (and vice-versa).
            const schedules = await db.all(
                `SELECT s.*, t.name AS template_name
                   FROM report_schedules s JOIN report_templates t ON t.id = s.template_id
                  ${mine ? 'WHERE s.created_by = ? AND s.creator_type = ?' : ''}
                  ORDER BY s.created_at DESC`,
                mine ? [req.user.id, req.user.userType === 'admin' ? 'admin' : 'employee'] : []
            );
            const actorType = req.user.userType === 'admin' ? 'admin' : 'employee';
            const templates = await db.all(
                `SELECT id, name FROM reportTemplates WHERE isPublic = true OR (createdBy = ? AND creatorType = ?) ORDER BY name`,
                [req.user.id, actorType]
            );
            // Owner + next run: a SuperAdmin sees every schedule,
            // so "whose is it" and "when does it run again" have to be on the row.
            // Owner names come from the two id spaces the creator_type selects.
            const { nextRunAt } = require('../jobs/report-scheduler');
            const adminIds = schedules
                .filter((s) => (s.creatorType || s.creator_type) === 'admin')
                .map((s) => s.createdBy);
            const empIds = schedules
                .filter((s) => (s.creatorType || s.creator_type) !== 'admin')
                .map((s) => s.createdBy);
            const [admins, emps] = await Promise.all([
                adminIds.length
                    ? db.all('SELECT id, username AS name FROM admins WHERE id = ANY(?)', [
                          adminIds,
                      ])
                    : [],
                empIds.length
                    ? db.all(
                          `SELECT id, ${personNameSql('')} AS name FROM employees WHERE id = ANY(?)`,
                          [empIds]
                      )
                    : [],
            ]);
            const byAdmin = new Map(admins.map((a) => [Number(a.id), a.name]));
            const byEmp = new Map(emps.map((e) => [Number(e.id), e.name]));
            schedules.forEach((s) => {
                const isAdmin = (s.creatorType || s.creator_type) === 'admin';
                s.ownerName = (isAdmin ? byAdmin : byEmp).get(Number(s.createdBy)) || null;
                s.ownerKind = isAdmin ? 'admin' : 'employee';
                s.nextRunAt = nextRunAt(s);
            });
            res.render('pages/reports/schedules', {
                title: req.t ? req.t('chrome:pt_report_schedules') : 'Report Schedules',
                schedules,
                templates,
            });
        } catch (error) {
            console.error('List schedules error:', error);
            req.flash(
                'error',
                req.t
                    ? req.t('flash:report_schedules_load_error')
                    : 'Error loading report schedules'
            );
            res.redirect('/reports/builder');
        }
    }

    async createSchedule(req, res) {
        try {
            const templateId = parseInt(req.body.templateId, 10);
            const frequency = ['daily', 'weekly', 'monthly'].includes(req.body.frequency)
                ? req.body.frequency
                : 'weekly';
            const hour = Math.min(23, Math.max(0, parseInt(req.body.hour, 10) || 6));
            const dayOfWeek =
                frequency === 'weekly'
                    ? Math.min(6, Math.max(0, parseInt(req.body.dayOfWeek, 10) || 1))
                    : null;
            const recipients = String(req.body.recipients || '')
                .split(',')
                .map((x) => x.trim())
                .filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
                .slice(0, 20)
                .join(',');

            if (!templateId || !recipients) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:report_schedule_invalid')
                        : 'Choose a template and at least one valid recipient email.'
                );
                return res.redirect('/reports/schedules');
            }
            // The template must be visible to the scheduling user (own or public).
            const tpl = await db.get(
                'SELECT id, dataSource FROM reportTemplates WHERE id = ? AND (isPublic = true OR (createdBy = ? AND creatorType = ?))',
                [templateId, req.user.id, req.user.userType === 'admin' ? 'admin' : 'employee']
            );
            if (!tpl) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:report_template_not_found')
                        : 'Template not found or not accessible.'
                );
                return res.redirect('/reports/schedules');
            }
            // Refuse NOW what the scheduler could only fail at later. A composite
            // (multi-section) template is stored with dataSource 'multi', which
            // buildQuery cannot execute — and saveTemplate defaults a missing
            // dataSource to 'multi' too. Accepting the schedule meant an e-mail
            // that never arrived, re-failing on every tick, discoverable only in
            // last_status. Say so at the point the person can still act on it.
            if (!ReportBuilderService.canExecute(tpl.dataSource)) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('flash:report_schedule_not_schedulable')
                        : 'This template cannot be scheduled: multi-section (composite) reports have no single table to e-mail. Schedule a single-source template instead.'
                );
                return res.redirect('/reports/schedules');
            }
            // Store the REAL creator identity: (creator_type, created_by), exactly
            // as reportTemplates does. A manager's id is an EMPLOYEE id — a
            // different sequence from admin ids — and the scheduler used to replay
            // every schedule as userType 'admin', so a manager's report scoped to
            // nothing (empty CSV, status ok) or, on an id collision, to an
            // unrelated admin's clearance. Migration 102 adds the column.
            const creatorType = req.user.userType === 'admin' ? 'admin' : 'employee';
            await db.run(
                `INSERT INTO report_schedules (template_id, recipients, frequency, day_of_week, hour, created_by, creator_role, creator_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    templateId,
                    recipients,
                    frequency,
                    dayOfWeek,
                    hour,
                    req.user.id,
                    req.user.role || 'localadmin',
                    creatorType,
                ]
            );
            req.flash(
                'success',
                req.t
                    ? req.t('flash:report_schedule_created')
                    : 'Schedule created — the report will be emailed automatically.'
            );
            res.redirect('/reports/schedules');
        } catch (error) {
            console.error('Create schedule error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:report_schedule_create_error') : 'Error creating schedule'
            );
            res.redirect('/reports/schedules');
        }
    }

    async deleteSchedule(req, res) {
        try {
            let query = 'DELETE FROM report_schedules WHERE id = ?';
            const params = [parseInt(req.params.id, 10)];
            if (req.user.role !== 'superadmin') {
                query += ' AND created_by = ? AND creator_type = ?';
                params.push(req.user.id, req.user.userType === 'admin' ? 'admin' : 'employee');
            }
            const r = await db.run(query, params);
            req.flash(
                r.changes ? 'success' : 'error',
                r.changes
                    ? req.t
                        ? req.t('flash:report_schedule_deleted')
                        : 'Schedule deleted.'
                    : req.t
                      ? req.t('flash:report_schedule_not_found')
                      : 'Schedule not found or access denied.'
            );
        } catch (error) {
            console.error('Delete schedule error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:report_schedule_delete_error') : 'Error deleting schedule'
            );
        }
        res.redirect('/reports/schedules');
    }

    /**
     * "Exécuter maintenant" for one schedule. Runs the SAME code
     * path as the tick (report-scheduler.runOne), so the report is produced with
     * the schedule creator's clearance and the outcome lands in `last_status` —
     * a manual run can never send more than the scheduled one would.
     * Ownership is re-checked here: a non-SuperAdmin may only run their own.
     */
    async runScheduleNow(req, res) {
        const id = parseInt(req.params.id, 10);
        const scheduler = require('../jobs/report-scheduler');
        const s = await scheduler.loadSchedule(id);
        const owns =
            s &&
            String(s.createdBy) === String(req.user.id) &&
            (s.creatorType || s.creator_type) ===
                (req.user.userType === 'admin' ? 'admin' : 'employee');
        if (!s || (req.user.role !== 'superadmin' && !owns)) {
            req.flash('error', req.t ? req.t('admin:ops_sched_not_found') : 'Schedule not found.');
            return res.redirect('/reports/schedules');
        }
        const status = await scheduler.runOne(s);
        await LogService.log({
            adminId: req.user.userType === 'admin' ? req.user.id : null,
            action: 'REPORT_SCHEDULE_RUN_MANUAL',
            entityType: 'report_schedule',
            entityId: id,
            category: 'audit',
            severity: status === 'ok' ? 'info' : 'warn',
            actorRef: `${req.user.userType === 'admin' ? 'admin' : 'manager'}:${req.user.id}`,
            details: `Scheduled report #${id} run manually — ${status}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            requestId: req.id || null,
        }).catch(() => {
            /* audit best-effort */
        });
        const key = status === 'ok' ? 'admin:ops_sched_run_ok' : 'admin:ops_sched_run_failed';
        req.flash(status === 'ok' ? 'success' : 'error', req.t ? req.t(key, { status }) : status);
        res.redirect('/reports/schedules');
    }

    /** Pause / resume a schedule — `is_active` is the scheduler's own gate. */
    async toggleSchedule(req, res) {
        const id = parseInt(req.params.id, 10);
        let sql = 'UPDATE report_schedules SET is_active = NOT is_active WHERE id = ?';
        const params = [id];
        if (req.user.role !== 'superadmin') {
            sql += ' AND created_by = ? AND creator_type = ?';
            params.push(req.user.id, req.user.userType === 'admin' ? 'admin' : 'employee');
        }
        const r = await db.run(sql, params);
        if (!r.changes) {
            req.flash('error', req.t ? req.t('admin:ops_sched_not_found') : 'Schedule not found.');
            return res.redirect('/reports/schedules');
        }
        const row = await db.get(
            'SELECT is_active AS "isActive" FROM report_schedules WHERE id = ?',
            [id]
        );
        const on = !!(row && row.isActive);
        await LogService.log({
            adminId: req.user.userType === 'admin' ? req.user.id : null,
            action: on ? 'REPORT_SCHEDULE_RESUMED' : 'REPORT_SCHEDULE_PAUSED',
            entityType: 'report_schedule',
            entityId: id,
            category: 'audit',
            severity: 'info',
            actorRef: `${req.user.userType === 'admin' ? 'admin' : 'manager'}:${req.user.id}`,
            details: `Scheduled report #${id} ${on ? 'resumed' : 'paused'}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            requestId: req.id || null,
        }).catch(() => {
            /* audit best-effort */
        });
        req.flash(
            'success',
            req.t
                ? req.t(on ? 'admin:ops_sched_toggled_on' : 'admin:ops_sched_toggled_off')
                : on
                  ? 'Resumed.'
                  : 'Paused.'
        );
        res.redirect('/reports/schedules');
    }

    async getReferenceData(req, res) {
        try {
            const source = req.params.source;
            // Clearance-scoped: the filter lists must offer only values the
            // caller can actually see (a manager offered another site's
            // departments ticks one and gets an empty section — reads as a
            // broken report). Shape is unchanged: { success, data:[{id,name}] }.
            const data = await ReportBuilderService.getReferenceData(source, req.user);

            res.json({
                success: true,
                data,
            });
        } catch (error) {
            console.error('Get reference data error:', error);
            res.status(400).json({
                success: false,
                error: error.message,
            });
        }
    }

    // Real data for one report-builder section (replaces client mock data).
    async reportData(req, res) {
        try {
            const config = {
                source: req.body.source,
                dimension: req.body.dimension,
                dimension2: req.body.dimension2 || null,
                metric: req.body.metric,
                aggregation: req.body.aggregation || 'avg',
                chartType: req.body.chartType || 'bar',
                sortOrder: req.body.sortOrder || 'desc',
                limit: req.body.limit || 20,
                _filters: req.body.filters || null,
            };
            // req.t travels with the request so KPI labels / provenance wording
            // ("Jamais évalué") come back in the caller's locale, FR first.
            const data = await ReportDataService.getSectionData(config, req.user, req.t);
            res.json({ success: true, data });
        } catch (error) {
            console.error('Report data error:', error);
            res.status(400).json({ success: false, error: error.message });
        }
    }

    // Existing report methods
    async readiness(req, res) {
        try {
            const organizationalReadiness = await ReadinessService.getOrganizationalReadiness(
                req.user
            );

            if (req.query.format === 'json') {
                return res.json(organizationalReadiness);
            }

            if (req.query.format === 'csv') {
                const csv = this.generateReadinessCSV(organizationalReadiness);
                return sendCsv(res, 'readiness-report.csv', csv);
            }

            res.render('pages/reports/readiness', {
                title: req.t ? req.t('chrome:pt_readiness_report') : 'Readiness Report',
                organizationalReadiness,
            });
        } catch (error) {
            console.error('Readiness report error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:report_readiness_error') : 'Error generating readiness report'
            );
            res.redirect('/dashboard');
        }
    }

    async gaps(req, res) {
        try {
            const organizationalReadiness = await ReadinessService.getOrganizationalReadiness(
                req.user
            );
            const gapAnalysis = organizationalReadiness.gapAnalysis || [];

            if (req.query.format === 'json') {
                return res.json({ gapAnalysis });
            }

            if (req.query.format === 'csv') {
                const csv = this.generateGapsCSV(
                    gapAnalysis,
                    organizationalReadiness.readinessData
                );
                return sendCsv(res, 'gap-analysis.csv', csv);
            }

            res.render('pages/reports/gaps', {
                title: req.t ? req.t('chrome:pt_gap_analysis_report') : 'Gap Analysis Report',
                gapAnalysis,
            });
        } catch (error) {
            console.error('Gap analysis error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:report_gap_error') : 'Error generating gap analysis'
            );
            res.redirect('/dashboard');
        }
    }

    generateReadinessCSV(data) {
        const headers = [
            'Employee Number',
            'First Name',
            'Last Name',
            'Role',
            'Site',
            'Department',
            'Service',
            'Total Required',
            'Skills Assessed',
            'Skills Met',
            'Skills Not Met',
            'Never Assessed',
            'Critical Skills Met',
            'Critical Skills Total',
            'Coverage %',
            'Readiness %',
            'Is Ready',
        ];

        const rows = data.readinessData.map((rd) => {
            // "Skills Not Met" must be a MEASURED shortfall, never a never-assessed
            // requirement. The old CSV set it to totalRequired - skillsMet, which
            // counted every un-rated requirement as a failure: 853 of 1544 "not
            // met" on this org were skills nobody had ever assessed, and a
            // never-assessed employee's row read "152 not met, 0% , not ready" for
            // skills no one had looked at. Split the three states apart, from the
            // same honest primitives the rest of the platform uses, and leave
            // Readiness % blank (not 0) when nothing was assessed.
            const measuredNotMet = (rd.gaps || []).filter((g) => g.isAssessed).length;
            const assessedMet = Number(rd.assessedRequired || 0) - measuredNotMet;
            return [
                rd.employee.employeeNumber,
                rd.employee.firstName,
                rd.employee.lastName,
                rd.employee.roleName,
                rd.employee.siteName,
                rd.employee.departmentName,
                rd.employee.serviceName,
                rd.totalRequired,
                rd.assessedRequired,
                assessedMet,
                measuredNotMet,
                rd.neverAssessedRequired,
                rd.criticalSkillsMet,
                rd.criticalSkillsTotal,
                rd.coveragePercent == null ? '' : rd.coveragePercent,
                rd.readinessPercent == null ? '' : rd.readinessPercent,
                rd.isReady ? 'Yes' : 'No',
            ];
        });

        // csvCell quotes commas/quotes/newlines AND neutralizes leading =,+,-,@ so a
        // malicious employee/skill name can't corrupt columns or execute as a formula.
        return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    }

    /**
     * Gap CSV. `gapAnalysis` only holds MEASURED gaps (ReadinessService skips
     * never-assessed requirements), so "Average Gap" is blank — not "0.00" — when
     * no measured employee is affected, and the requirement's never-assessed
     * population is its own column, computed from the per-employee gap lists
     * (`isAssessed: false`) in `readinessData`, keyed exactly as gapAnalysis is
     * (skill, required level, criticality).
     */
    generateGapsCSV(gapAnalysis, readinessData = []) {
        const headers = [
            'Skill Name',
            'Domain',
            'Required Level',
            'Is Critical',
            'Employees Affected',
            'Average Gap',
            'Employees Never Assessed',
        ];

        const neverAssessed = new Map();
        for (const rd of readinessData || []) {
            for (const g of (rd && rd.gaps) || []) {
                if (g.isAssessed) continue;
                const key = `${g.skillId}_${g.requiredLevel}_${g.isCritical ? 1 : 0}`;
                neverAssessed.set(key, (neverAssessed.get(key) || 0) + 1);
            }
        }

        const rows = gapAnalysis.map((gap) => [
            gap.skillName,
            gap.domainName,
            gap.requiredLevel,
            gap.isCritical ? 'Yes' : 'No',
            gap.employeesAffected,
            gap.employeesAffected > 0 ? (gap.totalGap / gap.employeesAffected).toFixed(2) : '',
            neverAssessed.get(`${gap.skillId}_${gap.requiredLevel}_${gap.isCritical ? 1 : 0}`) || 0,
        ]);

        return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    }

    // Power BI Integration API Methods
    async powerbIEmployees(req, res) {
        try {
            const employees = await RBACService.getFilteredEmployees(req.user);

            // Format data for Power BI with flattened structure
            const formattedData = employees.map((emp) => ({
                EmployeeID: emp.id,
                EmployeeNumber: emp.employeeNumber,
                FirstName: emp.firstName,
                LastName: emp.lastName,
                FullName: `${emp.firstName} ${emp.lastName}`,
                Email: emp.email || '',
                Phone: emp.phone || '',
                Site: emp.siteName,
                SiteID: emp.siteId,
                Department: emp.departmentName,
                DepartmentID: emp.departmentId,
                Service: emp.serviceName,
                ServiceID: emp.serviceId,
                Role: emp.roleName,
                RoleID: emp.roleId,
                IsActive: !!emp.isActive,
                CreatedDate: emp.createdAt,
                UpdatedDate: emp.updatedAt,
            }));

            res.json({
                '@odata.context': `${req.protocol}://${req.get('host')}/api/powerbi/employees`,
                value: formattedData,
            });
        } catch (error) {
            console.error('Power BI employees API error:', error);
            res.status(500).json({ error: 'Error retrieving employee data' });
        }
    }

    async powerbIAssessments(req, res) {
        try {
            const employees = await RBACService.getFilteredEmployees(req.user);
            const employeeIds = employees.map((e) => e.id);

            if (employeeIds.length === 0) {
                return res.json({
                    '@odata.context': `${req.protocol}://${req.get('host')}/api/powerbi/assessments`,
                    value: [],
                });
            }

            // Get all assessments for authorized employees
            const placeholders = employeeIds.map(() => '?').join(',');
            const assessments = await db.all(
                `
                SELECT 
                    sa.id as AssessmentID,
                    e.id as EmployeeID,
                    e.employeeNumber as EmployeeNumber,
                    e.firstName || ' ' || e.lastName as EmployeeName,
                    sk.id as SkillID,
                    sk.name as SkillName,
                    d.id as DomainID,
                    d.name as DomainName,
                    sa.currentLevel as CurrentLevel,
                    rsr.requiredLevel as RequiredLevel,
                    rsr.isCritical as IsCritical,
                    CASE 
                        WHEN sa.currentLevel >= rsr.requiredLevel THEN 1
                        ELSE 0
                    END as MeetsRequirement,
                    CASE 
                        WHEN rsr.requiredLevel IS NOT NULL 
                        THEN (rsr.requiredLevel - sa.currentLevel)
                        ELSE 0
                    END as Gap,
                    a.username as AssessedBy,
                    sa.assessedAt as AssessedDate,
                    sa.notes as Notes
                FROM skillAssessments sa
                INNER JOIN employees e ON sa.employeeId = e.id
                INNER JOIN skills sk ON sa.skillId = sk.id
                INNER JOIN domains d ON sk.domainId = d.id
                LEFT JOIN roleSkillRequirements rsr ON e.roleId = rsr.roleId AND sa.skillId = rsr.skillId
                LEFT JOIN admins a ON sa.assessedBy = a.id
                WHERE sa.employeeId IN (${placeholders})
                ORDER BY e.employeeNumber, d.name, sk.name
            `,
                employeeIds
            );

            res.json({
                '@odata.context': `${req.protocol}://${req.get('host')}/api/powerbi/assessments`,
                value: assessments,
            });
        } catch (error) {
            console.error('Power BI assessments API error:', error);
            res.status(500).json({ error: 'Error retrieving assessment data' });
        }
    }

    async powerbIReadiness(req, res) {
        try {
            const organizationalReadiness = await ReadinessService.getOrganizationalReadiness(
                req.user
            );

            // Format readiness data for Power BI. Coverage travels with the score:
            // SkillsNotMet is NULL (not the whole requirement count) when nothing
            // was assessed, and the never-assessed count is its own column, so a
            // never-measured person cannot be filed as "152 skills not met".
            const formattedData = organizationalReadiness.readinessData.map((rd) => {
                const measured =
                    Number(rd.assessedRequired || 0) > 0 && rd.readinessPercent != null;
                return {
                    EmployeeID: rd.employee.id,
                    EmployeeNumber: rd.employee.employeeNumber,
                    EmployeeName: `${rd.employee.firstName} ${rd.employee.lastName}`,
                    Site: rd.employee.siteName,
                    SiteID: rd.employee.siteId,
                    Department: rd.employee.departmentName,
                    DepartmentID: rd.employee.departmentId,
                    Service: rd.employee.serviceName,
                    ServiceID: rd.employee.serviceId,
                    Role: rd.employee.roleName,
                    RoleID: rd.employee.roleId,
                    TotalRequiredSkills: rd.totalRequired,
                    AssessedRequiredSkills: rd.assessedRequired,
                    NeverAssessedSkills: rd.neverAssessedRequired,
                    CoveragePercent: rd.coveragePercent,
                    SkillsMet: measured ? rd.skillsMet : null,
                    SkillsNotMet: measured ? rd.skillsNotMet : null,
                    CriticalSkillsMet: rd.criticalSkillsMet,
                    CriticalSkillsTotal: rd.criticalSkillsTotal,
                    ReadinessPercent: rd.readinessPercent,
                    IsReady: measured ? rd.isReady : null,
                    ReadinessStatus: measured
                        ? rd.isReady
                            ? 'Ready'
                            : 'Not Ready'
                        : 'Not measured',
                    ReadinessCategory: this.getReadinessCategory(
                        measured ? rd.readinessPercent : null
                    ),
                };
            });

            res.json({
                '@odata.context': `${req.protocol}://${req.get('host')}/api/powerbi/readiness`,
                value: formattedData,
            });
        } catch (error) {
            console.error('Power BI readiness API error:', error);
            res.status(500).json({ error: 'Error retrieving readiness data' });
        }
    }

    async powerbIOrganization(req, res) {
        try {
            // Clearance-fit: this feed used to return org-wide headcounts to any
            // (clearance-scoped) API key. Scope the employee join to the key
            // owner's governed set so an owner-bound key only counts its own
            // people — the same posture as the sibling talent feeds. Superadmin
            // keys stay unfiltered; an empty scope contributes zero headcount.
            const isSuper = RBACService.isSuperAdmin && RBACService.isSuperAdmin(req.user);
            const params = [];
            let joinScope = '';
            if (!isSuper) {
                const ids = await this._scopedIds(req);
                if (!ids.length) {
                    return res.json({
                        '@odata.context': `${req.protocol}://${req.get('host')}/api/powerbi/organization`,
                        value: [],
                    });
                }
                joinScope = ` AND e.id IN (${ids.map(() => '?').join(',')})`;
                params.push(...ids);
            }
            // Get organizational structure with employee counts
            const orgData = await db.all(
                `
                SELECT
                    s.id as SiteID,
                    s.name as SiteName,
                    s.code as SiteCode,
                    d.id as DepartmentID,
                    d.name as DepartmentName,
                    d.code as DepartmentCode,
                    sv.id as ServiceID,
                    sv.name as ServiceName,
                    sv.code as ServiceCode,
                    COUNT(DISTINCT e.id) as EmployeeCount,
                    COUNT(DISTINCT CASE WHEN e.isActive = 1 THEN e.id END) as ActiveEmployeeCount,
                    s.isActive as SiteActive,
                    d.isActive as DepartmentActive,
                    sv.isActive as ServiceActive
                FROM sites s
                LEFT JOIN departments d ON s.id = d.siteId
                LEFT JOIN services sv ON d.id = sv.departmentId
                LEFT JOIN employees e ON sv.id = e.serviceId${joinScope}
                GROUP BY s.id, d.id, sv.id
                ORDER BY s.name, d.name, sv.name
            `,
                params
            );

            res.json({
                '@odata.context': `${req.protocol}://${req.get('host')}/api/powerbi/organization`,
                value: orgData,
            });
        } catch (error) {
            console.error('Power BI organization API error:', error);
            res.status(500).json({ error: 'Error retrieving organization data' });
        }
    }

    // ---- Talent-development Power BI feeds (RBAC-scoped to the key's profile) --
    async _scopedIds(req) {
        const emps = await RBACService.getFilteredEmployees(req.user);
        return emps.map((e) => Number(e.id));
    }
    async _odata(req, res, name, sql, label) {
        try {
            const ids = await this._scopedIds(req);
            if (!ids.length)
                return res.json({
                    '@odata.context': `${req.protocol}://${req.get('host')}/api/powerbi/${name}`,
                    value: [],
                });
            const ph = ids.map(() => '?').join(',');
            const rows = await db.all(sql.replace('__IDS__', ph), ids);
            res.json({
                '@odata.context': `${req.protocol}://${req.get('host')}/api/powerbi/${name}`,
                value: rows,
            });
        } catch (error) {
            console.error(`Power BI ${name} API error:`, error && error.message);
            res.status(500).json({ error: `Error retrieving ${label} data` });
        }
    }
    async powerbINineBox(req, res) {
        return this._odata(
            req,
            res,
            'ninebox',
            `
            SELECT p.employee_id AS EmployeeID, e.employee_number AS EmployeeNumber,
                   e.first_name || ' ' || e.last_name AS EmployeeName,
                   p.box AS Box, p.tier AS Tier, p.source AS Source, p.placed_at AS PlacedAt
            FROM talent_placements p JOIN employees e ON e.id = p.employee_id
            WHERE p.cycle_id = (SELECT MAX(cycle_id) FROM talent_placements) AND p.employee_id IN (__IDS__)`,
            'nine-box'
        );
    }
    async powerbIPips(req, res) {
        return this._odata(
            req,
            res,
            'pips',
            `
            SELECT p.id AS PipID, p.employee_id AS EmployeeID, e.employee_number AS EmployeeNumber,
                   p.state AS State, p.starts_on AS StartsOn, p.ends_on AS EndsOn, p.created_at AS CreatedAt
            FROM pips p JOIN employees e ON e.id = p.employee_id WHERE p.employee_id IN (__IDS__)`,
            'PIP'
        );
    }
    async powerbIIdp(req, res) {
        return this._odata(
            req,
            res,
            'idp',
            `
            SELECT i.id AS IdpID, i.employee_id AS EmployeeID, e.employee_number AS EmployeeNumber,
                   i.status AS Status, i.priority AS Priority, i.created_at AS CreatedAt
            FROM idp_plans i JOIN employees e ON e.id = i.employee_id WHERE i.employee_id IN (__IDS__)`,
            'IDP'
        );
    }
    async powerbICoaching(req, res) {
        return this._odata(
            req,
            res,
            'coaching',
            `
            SELECT c.id AS PlanID, c.employee_id AS EmployeeID, e.employee_number AS EmployeeNumber,
                   c.kind AS Kind, c.state AS State, c.created_at AS CreatedAt
            FROM coaching_plans c JOIN employees e ON e.id = c.employee_id WHERE c.employee_id IN (__IDS__)`,
            'coaching'
        );
    }
    async powerbIGoals(req, res) {
        return this._odata(
            req,
            res,
            'goals',
            `
            SELECT g.id AS GoalID, g.employee_id AS EmployeeID, e.employee_number AS EmployeeNumber,
                   g.kind AS Kind, g.title AS Title, g.status AS Status,
                   g.current_value AS CurrentValue, g.target_value AS TargetValue, g.period AS Period
            FROM goals g JOIN employees e ON e.id = g.employee_id WHERE g.employee_id IN (__IDS__)`,
            'goals'
        );
    }

    /**
     * Power BI readiness band. `percent` is the canonical assessed-only readiness
     * and is NULL for an employee nobody assessed — that is a distinct category,
     * never the bottom band: `null >= 80` is false all the way down, so the old
     * fall-through filed five never-assessed people under "Very Poor (0-20%)"
     * and Power BI ranked them as the worst performers on zero measurement.
     */
    getReadinessCategory(percent) {
        if (percent === null || percent === undefined || Number.isNaN(Number(percent)))
            return 'Not measured';
        if (percent >= 80) return 'Excellent (80-100%)';
        if (percent >= 61) return 'Good (61-79%)';
        if (percent >= 41) return 'Fair (41-60%)';
        if (percent >= 21) return 'Poor (21-40%)';
        return 'Very Poor (0-20%)';
    }
}

module.exports = new ReportController();
