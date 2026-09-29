'use strict';

/**
 * ComplianceController — Operational Compliance Assurance surfaces:
 *
 *   GET  /compliance                          page (certs, currency, coverage)
 *   GET  /api/compliance/certifications       scoped current certs (?status=)
 *   GET  /api/compliance/currency             scoped lapsed skill levels
 *   GET  /api/compliance/coverage             scoped coverage-rule status
 *   POST /compliance/policies                 set per-skill cert/decay policy
 *   POST /compliance/certifications           record cert/VOC (+evidence file)
 *   POST /compliance/certifications/:id/revoke
 *   GET  /compliance/evidence/:id             download evidence (clean only)
 *   POST /compliance/rules                    create coverage rule
 *   POST /compliance/rules/:id/toggle         activate/deactivate rule
 *   POST /compliance/rules/:id/delete         delete ONE coverage rule
 *
 * RBAC: reads are scoped BEFORE aggregation via rbacScope (managers see their
 * sub-tree, local admins their assigned scopes, SuperAdmin everything).
 *
 * Writes split into two capabilities, matching who actually does the work:
 *   canRecord    — the FIELD acts (record/revoke a certification or VOC
 *                  sign-off, log a planned absence). A manager holds this for
 *                  their own reports; a delegate holds it via manage_compliance.
 *   canConfigure — the PROGRAMME (certification policies, coverage rules, bulk
 *                  generation and import). manage_compliance only.
 * The routes enforce the same split; these flags exist so the page shows a
 * manager the forms they can actually submit and hides the ones they cannot.
 */

const fs = require('fs');
const db = require('../config/database');
const CertificationService = require('../services/CertificationService');
const CoverageService = require('../services/CoverageService');
const LogService = require('../services/LogService');
const { scopedEmployeeIds } = require('../utils/rbacScope');
const RBACService = require('../services/RBACService');

class ComplianceController {
    /** Page shell with initial data (tables render server-side; no SPA needed). */
    async page(req, res) {
        const ids = await scopedEmployeeIds(req.user);
        const [counts, expiring, lapsed, coverage, policies, skills, absences, lapseImpact] =
            await Promise.all([
                CertificationService.statusCounts(ids),
                CertificationService.listCurrent(ids, { limit: 50 }),
                CertificationService.listLapsed(ids, { limit: 50 }),
                CoverageService.status(ids),
                CertificationService.listPolicies(),
                db
                    .all('SELECT id, name FROM skills WHERE is_active IS NOT FALSE ORDER BY name')
                    .catch(() => db.all('SELECT id, name FROM skills ORDER BY name')),
                CoverageService.listAbsences(ids, { limit: 100 }).catch(() => []),
                CertificationService.listLapseImpact(ids, { limit: 100 }),
            ]);
        // Roster for the record-certification form (scoped; capped for the datalist).
        let roster = [];
        const canConfigure = ComplianceController.canConfigure(req.user);
        const canRecord = ComplianceController.canRecord(req.user);
        // Kept for template compatibility: "manage" now means "configure".
        const canManage = canConfigure;
        if (canRecord) {
            const params = [];
            let scopeSql = '';
            if (ids !== null) {
                if (ids.length) {
                    scopeSql = ` WHERE id IN (${ids.map(() => '?').join(',')})`;
                    params.push(...ids);
                } else scopeSql = ' WHERE 1 = 0';
            }
            roster = await db.all(
                `SELECT id, employee_number AS "employeeNumber", first_name AS "firstName", last_name AS "lastName"
                   FROM employees${scopeSql ? scopeSql + ' AND' : ' WHERE'} is_active = true
                  ORDER BY last_name, first_name LIMIT 3000`,
                params
            );
        }
        const orgUnits = canConfigure
            ? {
                  sites: await db.all(
                      'SELECT id, name FROM sites WHERE is_active = true ORDER BY name'
                  ),
                  departments: await db.all(
                      'SELECT d.id, d.name, s.name AS site_name FROM departments d JOIN sites s ON s.id = d.site_id WHERE d.is_active = true ORDER BY s.name, d.name'
                  ),
              }
            : { sites: [], departments: [] };

        // Domains feed the bulk rule generator: authoring safe-shift rules one at a
        // time is why this instance has none, so the generator works pillar-wide.
        const domains = canConfigure
            ? await require('../config/database').all(
                  `SELECT d.id, d.name, COUNT(s.id) AS "skillCount"
                 FROM domains d LEFT JOIN skills s ON s.domain_id = d.id
                 GROUP BY d.id, d.name HAVING COUNT(s.id) > 0 ORDER BY d.name`
              )
            : [];

        res.render('pages/compliance/index', {
            title: req.t ? req.t('chrome:pt_operational_compliance') : 'Operational Compliance',
            counts,
            expiring,
            lapsed,
            coverage,
            policies,
            skills,
            roster,
            orgUnits,
            absences,
            domains,
            lapseImpact,
            canManage,
            canConfigure,
            canRecord,
        });
    }

    /**
     * FIELD acts: recording/revoking a certification (VOC sign-off) and logging
     * a planned absence. A manager is the person who actually does this at the
     * pit, so they hold it for their own reports; a delegated admin holds it
     * through `manage_compliance`. Scope is still enforced per employee.
     */
    static canRecord(user) {
        if (!user) return false;
        if (user.userType === 'manager') return true;
        return RBACService.hasPermission(user, 'manage_compliance');
    }

    /** PROGRAMME configuration: policies, coverage rules, bulk import/generate. */
    static canConfigure(user) {
        return RBACService.hasPermission(user, 'manage_compliance');
    }

    // ---- Scoped JSON reads -------------------------------------------------

    async certifications(req, res) {
        const ids = await scopedEmployeeIds(req.user);
        const status = ['valid', 'expiring', 'expired', 'no_expiry'].includes(req.query.status)
            ? req.query.status
            : null;
        res.json({
            certifications: await CertificationService.listCurrent(ids, {
                status,
                limit: req.query.limit,
            }),
        });
    }

    async currency(req, res) {
        const ids = await scopedEmployeeIds(req.user);
        res.json({
            lapsed: await CertificationService.listLapsed(ids, { limit: req.query.limit }),
        });
    }

    async coverage(req, res) {
        const ids = await scopedEmployeeIds(req.user);
        res.json({ rules: await CoverageService.status(ids) });
    }

    // ---- Writes (manage_compliance, route-gated) ---------------------------

    async setPolicy(req, res) {
        const { skillId, isCertification, validityMonths, revalidationWindowDays, decayMonths } =
            req.body;
        if (!skillId) return res.status(400).json({ error: 'skillId is required' });
        const policy = await CertificationService.setPolicy(
            skillId,
            {
                isCertification: isCertification !== '0' && isCertification !== false,
                validityMonths: validityMonths || null,
                revalidationWindowDays: revalidationWindowDays || 90,
                decayMonths: decayMonths || null,
            },
            req.user.id
        );
        await LogService.log({
            adminId: req.user.userType === 'admin' ? req.user.id : null,
            action: 'CERT_POLICY_SET',
            entityType: 'skill',
            entityId: skillId,
            details: `Certification policy set for skill ${skillId}: validity ${policy.validityMonths || '∞'} months, revalidation window ${policy.revalidationWindowDays}d, decay ${policy.decayMonths || 'off'} months`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        if (this._wantsJson(req)) return res.json({ success: true, policy });
        req.flash(
            'success',
            req.t ? req.t('flash:cmp_cert_policy_saved') : 'Certification policy saved'
        );
        res.redirect('/compliance');
    }

    async recordCertification(req, res) {
        try {
            const { employeeId, skillId, certNumber, issuedOn, expiresOn, notes } = req.body;
            // Scope check: the target employee must be visible to the actor.
            const ids = await scopedEmployeeIds(req.user);
            if (ids !== null && !ids.includes(Number(employeeId))) {
                if (req.file) fs.unlink(req.file.path, () => {});
                return res.status(403).json({ error: 'Employee outside your scope' });
            }
            const cert = await CertificationService.record(
                {
                    employeeId: Number(employeeId),
                    skillId: Number(skillId),
                    certNumber,
                    issuedOn,
                    expiresOn: expiresOn || null,
                    notes,
                    file: req.file || null,
                },
                req.user
            );
            await LogService.log({
                adminId: req.user.userType === 'admin' ? req.user.id : null,
                action: 'CERTIFICATION_RECORDED',
                entityType: 'employee',
                entityId: employeeId,
                details: `Certification/VOC recorded: skill ${skillId}, issued ${issuedOn}, expires ${cert.expiresOn || 'never'}${req.file ? ', evidence attached' : ''}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            if (this._wantsJson(req)) return res.json({ success: true, certification: cert });
            req.flash(
                'success',
                req.t ? req.t('flash:cmp_cert_recorded') : 'Certification recorded'
            );
            res.redirect('/compliance');
        } catch (e) {
            if (req.file) fs.unlink(req.file.path, () => {});
            if (this._wantsJson(req)) return res.status(400).json({ error: e.message });
            req.flash(
                'error',
                (req.t ? req.t('flash:cmp_cert_record_error') : 'Could not record certification:') +
                    ' ' +
                    e.message
            );
            res.redirect('/compliance');
        }
    }

    async revokeCertification(req, res) {
        const cert = await db.get('SELECT * FROM employee_certifications WHERE id = ?', [
            req.params.id,
        ]);
        if (!cert) return res.status(404).json({ error: 'Certification not found' });
        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null && !ids.includes(Number(cert.employeeId))) {
            return res.status(403).json({ error: 'Employee outside your scope' });
        }
        await CertificationService.revoke(cert.id, req.body.reason, req.user);
        await LogService.log({
            adminId: req.user.userType === 'admin' ? req.user.id : null,
            action: 'CERTIFICATION_REVOKED',
            entityType: 'employee',
            entityId: cert.employeeId,
            details: `Certification ${cert.id} (skill ${cert.skillId}) revoked${req.body.reason ? ': ' + req.body.reason : ''}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({ success: true });
    }

    /** Evidence download — clean files only (pending/quarantined/scan_error refused). */
    async evidence(req, res) {
        const cert = await db.get('SELECT * FROM employee_certifications WHERE id = ?', [
            req.params.id,
        ]);
        if (!cert || !cert.fileUri) return res.status(404).send('No evidence on file');
        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null && !ids.includes(Number(cert.employeeId)))
            return res.status(403).send('Access denied');
        if (cert.avStatus !== 'clean')
            return res.status(409).send('Evidence not available (virus scan not clean)');
        res.download(cert.fileUri, cert.originalName || 'evidence');
    }

    /** Download the certifications bulk-import Excel template. */
    async importTemplate(req, res) {
        const TemplateGenerator = require('../utils/TemplateGenerator');
        const workbook = await TemplateGenerator.generateCertificationsTemplate();
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', 'attachment; filename=certifications_template.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    }

    /**
     * Bulk certification import — preview-before-commit: dryRun=1 validates
     * and reports what WOULD happen (nothing written); omit/0 to commit.
     * Idempotent on re-import (duplicate employee+skill+issue-date skipped).
     */
    async importCertifications(req, res) {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const dryRun = String(req.body.dryRun || '') === '1';
        try {
            const CertificationService = require('../services/CertificationService');
            const results = await CertificationService.importWorkbook(req.file.path, {
                dryRun,
                actor: req.user,
            });
            fs.unlink(req.file.path, () => {});
            if (!dryRun) {
                await LogService.log({
                    adminId: req.user.userType === 'admin' ? req.user.id : null,
                    action: 'DATA_IMPORT',
                    entityType: 'certifications',
                    details: `Imported certifications: ${results.created} created, ${results.skipped} duplicates skipped, ${results.errors.length} rows in error (of ${results.total})`,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                });
            }
            res.json({ success: true, dryRun, results });
        } catch (e) {
            fs.unlink(req.file.path, () => {});
            res.status(400).json({ error: e.message });
        }
    }

    // ---- Planned absences (migration 58 — feeds predicted-breach coverage) ----

    async addAbsence(req, res) {
        try {
            const employeeId = Number(req.body.employeeId);
            const ids = await scopedEmployeeIds(req.user);
            if (ids !== null && !ids.includes(employeeId)) {
                return res.status(403).json({ error: 'Employee outside your scope' });
            }
            const absence = await CoverageService.addAbsence(
                {
                    employeeId,
                    startsOn: req.body.startsOn,
                    endsOn: req.body.endsOn,
                    kind: req.body.kind,
                    note: req.body.note || null,
                },
                req.user.userType === 'admin' ? req.user.id : null
            );
            await LogService.log({
                adminId: req.user.userType === 'admin' ? req.user.id : null,
                action: 'ABSENCE_RECORDED',
                entityType: 'employee',
                entityId: employeeId,
                details: `Planned absence recorded (${absence.kind}): ${absence.startsOn} → ${absence.endsOn}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            if (this._wantsJson(req)) return res.json({ success: true, absence });
            req.flash(
                'success',
                req.t ? req.t('flash:cmp_absence_recorded') : 'Planned absence recorded'
            );
            res.redirect('/compliance');
        } catch (e) {
            if (this._wantsJson(req)) return res.status(400).json({ error: e.message });
            req.flash(
                'error',
                (req.t ? req.t('flash:cmp_absence_error') : 'Could not record absence:') +
                    ' ' +
                    e.message
            );
            res.redirect('/compliance');
        }
    }

    async deleteAbsence(req, res) {
        const absence = await db.get('SELECT * FROM planned_absences WHERE id = ?', [
            req.params.id,
        ]);
        if (!absence) return res.status(404).json({ error: 'Absence not found' });
        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null && !ids.includes(Number(absence.employeeId))) {
            return res.status(403).json({ error: 'Employee outside your scope' });
        }
        await CoverageService.deleteAbsence(absence.id);
        await LogService.log({
            adminId: req.user.userType === 'admin' ? req.user.id : null,
            action: 'ABSENCE_REMOVED',
            entityType: 'employee',
            entityId: absence.employeeId,
            details: `Planned absence ${absence.id} removed (${absence.startsOn} → ${absence.endsOn})`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({ success: true });
    }

    async createRule(req, res) {
        // A scoped author may only write a rule on an org unit they are allowed
        // to SEE (same predicate as the rule list, CoverageService.status):
        // any site/department/service id used to be accepted (3.23.17, B-5).
        const unit = {
            siteId: req.body.siteId ? Number(req.body.siteId) : null,
            departmentId: req.body.departmentId ? Number(req.body.departmentId) : null,
            serviceId: req.body.serviceId ? Number(req.body.serviceId) : null,
        };
        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null && !(await CoverageService.ruleWithinScope(unit, ids))) {
            const message = req.t
                ? req.t('compliance:err_rule_out_of_scope')
                : 'This org unit is outside your scope.';
            if (this._wantsJson(req)) return res.status(403).json({ error: message });
            req.flash('error', message);
            return res.redirect('/compliance');
        }
        try {
            const rule = await CoverageService.createRule(
                {
                    name: req.body.name,
                    siteId: unit.siteId,
                    departmentId: unit.departmentId,
                    serviceId: unit.serviceId,
                    skillId: Number(req.body.skillId),
                    minLevel: req.body.minLevel,
                    minHeadcount: req.body.minHeadcount,
                    requireValidCert:
                        req.body.requireValidCert === '1' || req.body.requireValidCert === true,
                    severity: req.body.severity,
                },
                req.user.id
            );
            await LogService.log({
                adminId: req.user.userType === 'admin' ? req.user.id : null,
                action: 'COVERAGE_RULE_CREATED',
                entityType: 'coverage_rule',
                entityId: rule.id,
                details: `Coverage rule "${rule.name}": >=${rule.minHeadcount} @ level>=${rule.minLevel} in skill ${rule.skillId}${rule.requireValidCert ? ' (valid cert required)' : ''}`,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
            });
            if (this._wantsJson(req)) return res.json({ success: true, rule });
            req.flash('success', req.t ? req.t('flash:cmp_rule_created') : 'Coverage rule created');
            res.redirect('/compliance');
        } catch (e) {
            if (this._wantsJson(req)) return res.status(400).json({ error: e.message });
            req.flash(
                'error',
                (req.t ? req.t('flash:cmp_rule_create_error') : 'Could not create rule:') +
                    ' ' +
                    e.message
            );
            res.redirect('/compliance');
        }
    }

    async toggleRule(req, res) {
        const rule = await db.get('SELECT * FROM coverage_rules WHERE id = ?', [req.params.id]);
        if (!rule) return res.status(404).json({ error: 'Rule not found' });
        // Same scope contract as delete: a scoped delegate can only act on the
        // rules they can SEE (CoverageService.status applies rule visibility).
        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null) {
            const visible = await CoverageService.status(ids);
            if (!visible.some((r) => Number(r.ruleId) === Number(rule.id))) {
                return res.status(403).json({ error: 'Rule outside your scope' });
            }
        }
        const updated = await CoverageService.setActive(rule.id, !rule.isActive);
        await LogService.log({
            adminId: req.user.userType === 'admin' ? req.user.id : null,
            action: 'COVERAGE_RULE_TOGGLED',
            entityType: 'coverage_rule',
            entityId: rule.id,
            details: `Coverage rule "${rule.name}" ${updated.isActive ? 'activated' : 'deactivated'}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        res.json({ success: true, isActive: updated.isActive });
    }

    /**
     * Delete ONE coverage rule. The bulk generator can create a grid of
     * hundreds; until now there was no way to remove a single bad rule short of
     * a DB console, so operators disabled them and lived with the noise.
     *
     * Deleting is destructive, so it is: permission-gated at the route,
     * scope-checked here (a rule naming an org unit outside the caller's scope
     * is invisible to them and stays undeletable), and audited with the FULL
     * rule definition — a safe-shift rule must never vanish without a record of
     * what it required.
     */
    async deleteRule(req, res) {
        const rule = await CoverageService.findRule(req.params.id);
        if (!rule) return res.status(404).json({ error: 'Rule not found' });

        const ids = await scopedEmployeeIds(req.user);
        if (ids !== null) {
            const visible = await CoverageService.status(ids);
            if (!visible.some((r) => Number(r.ruleId) === Number(rule.id))) {
                return res.status(403).json({ error: 'Rule outside your scope' });
            }
        }

        const scopeLabel =
            [rule.siteName, rule.departmentName, rule.serviceName].filter(Boolean).join(' / ') ||
            'whole organization';
        await CoverageService.deleteRule(rule.id);
        await LogService.log({
            adminId: req.user.userType === 'admin' ? req.user.id : null,
            action: 'COVERAGE_RULE_DELETED',
            entityType: 'coverage_rule',
            entityId: rule.id,
            details:
                `Coverage rule "${rule.name}" DELETED (${scopeLabel}): required >=${rule.minHeadcount} at level>=${rule.minLevel} in ${rule.skillName}` +
                `${rule.requireValidCert ? ' with a valid certification' : ''}, severity ${rule.severity}`,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
        });
        if (this._wantsJson(req)) return res.json({ success: true, deleted: Number(rule.id) });
        req.flash('success', req.t ? req.t('flash:cmp_rule_deleted') : 'Coverage rule deleted');
        res.redirect('/compliance');
    }

    // ---- Transparency surfaces (ComplianceRegisterService) -------------------

    /**
     * Employee-representative (works council / CSE) register — SuperAdmin only
     * (route-gated). Generated from the live configuration on every read, so
     * it cannot drift from what the appliance actually does; printable.
     */
    async register(req, res) {
        const reg = await require('../services/ComplianceRegisterService').register();
        res.render('pages/compliance/register', {
            title: req.t ? req.t('compliance:reg_title') : 'Employee-representative register',
            reg,
        });
    }

    /**
     * "What is recorded about me" — the signed-in person's OWN data only. No
     * :id and no query-string employee id: everything keys on req.user.id.
     */
    async myData(req, res) {
        let mine = null;
        try {
            mine = await require('../services/ComplianceRegisterService').forEmployee(req.user.id);
        } catch (_) {
            mine = null;
        }
        res.render('pages/employee/my-data', {
            title: req.t ? req.t('compliance:mydata_title') : 'What is recorded about me',
            mine,
        });
    }

    _wantsJson(req) {
        return (
            req.xhr ||
            (req.headers.accept || '').includes('json') ||
            (req.headers['content-type'] || '').includes('json')
        );
    }
}

module.exports = new ComplianceController();
