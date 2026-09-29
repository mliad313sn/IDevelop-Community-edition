'use strict';

const db = require('../config/database');
const AppSettingsModel = require('../models/AppSettingsModel');
const { missingReviewerSql } = require('../utils/reviewerGapSql');

/**
 * First-run setup checklist — guides a fresh install from empty to usable:
 * organization → roles+requirements → people → email. Shown to SuperAdmins at
 * /setup and as a dashboard banner until every step is done (or dismissed).
 */
class SetupController {
    async getChecks() {
        const c = await db.get(`
            SELECT (SELECT count(*) FROM sites WHERE is_active = true)::int AS sites,
                   (SELECT count(*) FROM departments WHERE is_active = true)::int AS departments,
                   (SELECT count(*) FROM services WHERE is_active = true)::int AS services,
                   (SELECT count(*) FROM skills WHERE is_active = true)::int AS skills,
                   (SELECT count(*) FROM roles WHERE is_active = true)::int AS roles,
                   (SELECT count(DISTINCT role_id) FROM role_skill_requirements)::int AS roles_with_req,
                   (SELECT count(*) FROM employees WHERE is_active = true)::int AS employees,
                   (SELECT count(*) FROM employees e WHERE ${missingReviewerSql('e')})::int AS no_reviewer,
                   (SELECT count(*) FROM employees WHERE is_active = true
                      AND (email IS NULL OR email = ''))::int AS no_email,
                   (SELECT count(*) FROM assessment_cycles WHERE status = 'open')::int AS open_cycles,
                   (SELECT count(*) FROM skill_assessments)::int AS assessments`);
        const smtpHost = await AppSettingsModel.getValue('smtpHost', '');
        const checks = [
            {
                key: 'org',
                done: c.sites > 0 && c.departments > 0 && c.services > 0,
                href: '/organization',
                count: `${c.sites}/${c.departments}/${c.services}`,
            },
            { key: 'skills', done: c.skills > 0, href: '/domains-skills', count: c.skills },
            {
                key: 'roles',
                done: c.roles > 0 && c.rolesWithReq > 0,
                href: '/roles',
                count: `${c.roles} (${c.rolesWithReq})`,
            },
            { key: 'employees', done: c.employees > 0, href: '/employees', count: c.employees },
            // Governance gap: an employee with NO supervisor and NO manager can
            // submit a self-assessment that reaches no review queue — a silent
            // dead end. Surfaced as a first-class, clickable worklist. Genuinely
            // orphaned only (responsibility falls through supervisor -> manager
            // -> covering admin scope), and "no supervisor" means no ACTIVE,
            // non-voided one — the SAME rule as the worklist this links to
            // (utils/reviewerGapSql.missingReviewerSql), so the count here always
            // equals the number of rows the operator lands on.
            {
                key: 'reviewers',
                done: c.employees > 0 && c.noReviewer === 0,
                href: '/employees?missingReviewer=1',
                count: c.noReviewer,
            },
            // People without an email can receive neither invitations nor any
            // notification — the practical gate on onboarding.
            {
                key: 'contactable',
                done: c.employees > 0 && c.noEmail === 0,
                href: '/admin/accounts',
                count: c.noEmail,
                optional: true,
            },
            // /v2/slf/cycles only 301-redirects now; the checklist
            // points at the campaign console itself so the nav highlight works.
            {
                key: 'cycle',
                done: c.openCycles > 0,
                href: '/cycles',
                count: c.openCycles,
                optional: true,
            },
            {
                key: 'assessments',
                done: c.assessments > 0,
                href: '/skill-matrix',
                count: c.assessments,
            },
            {
                key: 'email',
                done: Boolean(smtpHost),
                href: '/app-settings',
                count: smtpHost ? 'configured' : '—',
                optional: true,
            },
        ];
        const required = checks.filter((x) => !x.optional);
        return { checks, complete: required.every((x) => x.done) };
    }

    /**
     * Compact progress for the dashboard banner and the sidebar pill:
     * required steps done / total and the first unfinished step. Cached for
     * 30 s so rendering the sidebar on every page costs one query at most
     * twice a minute.
     */
    async getProgress() {
        const now = Date.now();
        if (this._progress && now - this._progressAt < 30000) return this._progress;
        const { checks, complete } = await this.getChecks();
        const required = checks.filter((x) => !x.optional);
        const next = required.find((x) => !x.done) || null;
        this._progress = {
            complete,
            done: required.filter((x) => x.done).length,
            total: required.length,
            next: next ? { key: next.key, href: next.href } : null,
        };
        this._progressAt = now;
        return this._progress;
    }

    async index(req, res) {
        try {
            const { checks, complete } = await this.getChecks();
            res.render('pages/setup/index', {
                title: req.t ? req.t('chrome:pt_setup') : 'Setup',
                checks,
                complete,
            });
        } catch (e) {
            console.error('Setup page error:', e);
            req.flash('error', req.t ? req.t('flash:form_load_error') : 'Error loading page');
            res.redirect('/dashboard');
        }
    }

    async dismiss(req, res) {
        try {
            await AppSettingsModel.setValue(
                'setupDismissed',
                '1',
                'boolean',
                'Hide the first-run setup banner',
                'general',
                req.user && req.user.id
            );
        } catch (e) {
            console.error('Setup dismiss error:', e.message);
        }
        res.redirect('/dashboard');
    }
}

module.exports = new SetupController();
