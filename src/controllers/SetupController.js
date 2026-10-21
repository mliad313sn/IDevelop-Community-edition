'use strict';

const db = require('../config/database');
const AppSettingsModel = require('../models/AppSettingsModel');
const { missingReviewerSql } = require('../utils/reviewerGapSql');

/**
 * First-run setup checklist — guides a fresh install from empty to usable:
 * organization → roles+requirements → people → email. Shown to SuperAdmins at
 * /setup and as a dashboard banner until every step is done (or dismissed).
 *
 * 4.0.0 port (wave 10): a second block, « Ready for go-live »
 * (getGoLiveChecks): every line is a measurement taken now or a declared
 * decision (SSO, shared-computer mode, local content: reported, never scored,
 * never changed here). A line whose source cannot be read is « not
 * measured », never « done ». The page is open READ-ONLY to the other
 * administrators: their people counts are limited to their clearance, a line
 * links only to a page their permissions open (never a SuperAdmin page), the
 * platform lines show their state without the administrator-account counts,
 * and only a SuperAdmin may dismiss the banner.
 */

/** The permission that opens the page a first-run step links to ('sa' = SuperAdmin only). */
const STEP_LINK_NEEDS = Object.freeze({
    modules: 'sa',
    org: 'manage_organization',
    skills: 'view_domains_skills',
    roles: 'view_roles',
    employees: 'view_employees',
    reviewers: 'view_employees',
    contactable: 'manage_invitations',
    cycle: 'manage_cycles',
    assessments: 'view_employees',
    hris: 'sa',
    email: 'view_app_settings',
});

const isSuper = (user) =>
    !!(user && user.userType === 'admin' && require('../services/RBACService').isSuperAdmin(user));
const canOpen = (user, need) => {
    if (isSuper(user)) return true;
    if (!user || user.userType !== 'admin' || !need || need === 'sa') return false;
    if (need === 'admin') return true;
    return require('../services/RBACService').hasPermission(user, need);
};

class SetupController {
    /**
     * @param {object|null} user  null or a SuperAdmin = the whole organisation
     *   (the banner, the SuperAdmin page); another administrator gets the people
     *   counts of their clearance and only the links their permissions open.
     */
    async getChecks(user = null) {
        const scoped = !!user && !isSuper(user);
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
        if (scoped) {
            // The people counts of the reader's clearance (active, not erased,
            // not cancelled): never the organisation's headcount.
            const ids = (
                await require('../services/KpiService').resolvePopulation({ viewer: user })
            ).ids;
            const p = await db.get(
                `SELECT (SELECT count(*) FROM employees e WHERE ${missingReviewerSql('e')} AND e.id = ANY(?))::int AS no_reviewer,
                        (SELECT count(*) FROM employees WHERE id = ANY(?)
                           AND (email IS NULL OR email = ''))::int AS no_email,
                        (SELECT count(*) FROM skill_assessments WHERE employee_id = ANY(?))::int AS assessments`,
                [ids, ids, ids]
            );
            c.employees = ids.length;
            c.noReviewer = Number(p.noReviewer) || 0;
            c.noEmail = Number(p.noEmail) || 0;
            c.assessments = Number(p.assessments) || 0;
        }
        const smtpHost = await AppSettingsModel.getValue('smtpHost', '');
        // Optional modules: done once a stage has been recorded (chosen on
        // /admin/modules, or stage 3 recorded for a V2_FEATURES=1 upgrade).
        const mods = await require('../services/ModuleService').resolve();
        // HRIS connector: an OPTIONAL step (never counted in the required steps).
        let hris = null;
        try {
            hris = await db.get(
                'SELECT provider FROM hris_connectors WHERE enabled = true LIMIT 1'
            );
        } catch (_) {
            hris = null;
        }
        const hrisOn = Boolean(hris && hris.provider);
        const checks = [
            // « Choose what to switch on » — OPTIONAL, so it never changes the
            // required-steps count (sidebar pill, dashboard banner, companion).
            {
                key: 'modules',
                done: Boolean(mods.stored),
                href: '/admin/modules',
                count: mods.stored ? mods.stage : '—',
                optional: true,
            },
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
                key: 'hris',
                done: hrisOn,
                href: '/admin/integrations/hris',
                count: hrisOn ? hris.provider : '—',
                optional: true,
            },
            {
                key: 'email',
                done: Boolean(smtpHost),
                href: '/app-settings',
                count: smtpHost ? 'configured' : '—',
                optional: true,
            },
        ];
        // No campaign step while the campaigns module is switched off (the
        // console answers 404 then).
        let shown = mods.modules.campaigns ? checks : checks.filter((x) => x.key !== 'cycle');
        if (scoped) {
            // Read-only: a link only to a page this reader's permissions open.
            shown = shown.map((x) => ({
                ...x,
                href: canOpen(user, STEP_LINK_NEEDS[x.key]) ? x.href : null,
            }));
        }
        const required = shown.filter((x) => !x.optional);
        return { checks: shown, complete: required.every((x) => x.done) };
    }

    /**
     * « Ready for go-live »: each line a measurement taken now or a declared
     * decision. `state`: 'done' | 'todo' | 'empty' (nothing to measure yet) |
     * 'unmeasured' (the source could not be read: never « done ») | 'info'
     * (a decision, never scored). `count` is what was measured, null when this
     * reader is not shown it; `href` is null when this reader may not open
     * the page.
     * @param {object|null} user  null or a SuperAdmin = the whole organisation
     */
    async getGoLiveChecks(user = null) {
        const sa = !user || isSuper(user);
        let flags = {};
        try {
            flags = (await require('../services/ModuleService').flags()) || {};
        } catch (_) {
            flags = {};
        }
        const one = async (fn) => {
            try {
                return await fn();
            } catch (_) {
                return null;
            }
        };
        const lines = [];
        /**
         * @param {string} key
         * @param {object|null} row   null = the source could not be read
         * @param {object} o  { done, count, href, need, empty, info, publicCount }
         */
        const push = (key, row, o) => {
            const href = sa || canOpen(user, o.need) ? o.href : null;
            if (!row) {
                lines.push({ key, state: 'unmeasured', count: null, href });
                return;
            }
            let state = o.done ? 'done' : 'todo';
            if (o.info) state = 'info';
            else if (o.empty) state = 'empty';
            lines.push({ key, state, count: sa || o.publicCount ? o.count : null, href });
        };

        // 1. Roles with requirements and no active safety clearance rule.
        const safety = await one(() =>
            db.get(`SELECT count(*)::int AS n FROM roles r
                     WHERE r.is_active = true
                       AND EXISTS (SELECT 1 FROM role_skill_requirements q
                                    WHERE q.role_id = r.id AND q.required_level > 0)
                       AND NOT EXISTS (SELECT 1 FROM safety_gate_rules g
                                        WHERE g.is_active = true AND g.role_id = r.id)`)
        );
        push('gl_safety', safety, {
            done: safety && safety.n === 0,
            count: safety && safety.n,
            href: '/safety-gate/config',
            need: 'manage_compliance',
            publicCount: true,
        });

        // 2. Critical roles designated, each with an active successor (talent module).
        if (flags.talent === true) {
            const crit = await one(() =>
                db.get(`SELECT (SELECT count(*) FROM role_criticality)::int AS critical,
                               (SELECT count(*) FROM role_criticality rc
                                 WHERE NOT EXISTS (
                                    SELECT 1 FROM succession_plans sp
                                      JOIN successors s ON s.plan_id = sp.id AND s.state = 'active'
                                     WHERE sp.position_role_id = rc.role_id
                                       AND sp.status::text <> 'archived'))::int AS without_successor`)
            );
            push('gl_critical_roles', crit, {
                done: crit && crit.critical > 0 && crit.withoutSuccessor === 0,
                count: crit && `${crit.critical} (${crit.withoutSuccessor})`,
                href: '/v2/continuity',
                need: 'view_continuity',
                publicCount: true,
            });
        }

        // 3. Critical skills flagged on the role requirements.
        const cs = await one(() =>
            db.get(
                `SELECT count(*)::int AS n FROM role_skill_requirements WHERE is_critical = true AND required_level > 0`
            )
        );
        push('gl_critical_skills', cs, {
            done: cs && cs.n > 0,
            count: cs && cs.n,
            href: '/roles',
            need: 'view_roles',
            publicCount: true,
        });

        // 4. The people the readiness indicators can measure (the reader's
        //    clearance): a role without requirement makes a person unmeasurable.
        const meas = await one(async () => {
            const K = require('../services/KpiService');
            const scope = sa ? { system: true } : { viewer: user };
            const k1 = await K.compute('K1', scope);
            return require('../services/DashboardHomeService').measurability(k1, null);
        });
        push('gl_measurable', meas, {
            done: !!(meas && !meas.emptyScope && meas.noRequirement === 0),
            empty: !!(meas && meas.emptyScope),
            count: meas && !meas.emptyScope ? meas.noRequirement : null,
            href: '/roles',
            need: 'view_roles',
            publicCount: true,
        });

        // 5. Indicator targets decided (distinct indicators with a target).
        const kt = await one(() =>
            db.get(`SELECT count(DISTINCT kpi_id)::int AS n FROM kpi_targets`)
        );
        push('gl_kpi_targets', kt, {
            done: kt && kt.n > 0,
            count: kt && kt.n,
            href: '/kpi/targets',
            need: 'admin',
            publicCount: true,
        });

        // 6. Administrators without a confirmed second factor (SuperAdmin: the count).
        const mfa = await one(() =>
            db.get(`SELECT count(*)::int AS n FROM admins a
                     WHERE a.is_active = true
                       AND NOT EXISTS (SELECT 1 FROM mfa_secrets m
                                        WHERE m.user_type = 'admin' AND m.user_id = a.id
                                          AND m.confirmed_at IS NOT NULL)`)
        );
        push('gl_admin_mfa', mfa, {
            done: mfa && mfa.n === 0,
            count: mfa && mfa.n,
            href: '/admin/access-review',
            need: 'sa',
        });

        // 7. Every non-SuperAdmin administrator's access attested this quarter.
        const ar = await one(() =>
            db.get(`SELECT count(*)::int AS n FROM admins a
                     WHERE a.is_active = true AND a.role <> 'superadmin'
                       AND NOT EXISTS (SELECT 1 FROM system_logs sl
                                        WHERE sl.action = 'ACCESS_REVIEW_ATTEST' AND sl.entity_type = 'admin'
                                          AND sl.entity_id = a.id
                                          AND sl.created_at >= date_trunc('quarter', now()))`)
        );
        push('gl_access_review', ar, {
            done: ar && ar.n === 0,
            count: ar && ar.n,
            href: '/admin/access-review',
            need: 'sa',
        });

        // 8. A privacy notice published.
        const pn = await one(() =>
            db.get(
                `SELECT count(*)::int AS n FROM privacy_notice_versions WHERE published_at IS NOT NULL`
            )
        );
        push('gl_privacy', pn, {
            done: pn && pn.n > 0,
            count: pn && pn.n,
            href: '/compliance/register',
            need: 'sa',
            publicCount: true,
        });

        // 9. The last backup, verified (the nightly job's own record).
        const bk = await one(async () => {
            const st = await require('../jobs/db-backup').status();
            return {
                when: st && st.lastOk ? st.lastRunOn : null,
                verified: /^ok /.test(String((st && st.lastVerify) || '')),
            };
        });
        push('gl_backup', bk, {
            done: !!(bk && bk.when && bk.verified),
            count: bk && bk.when ? String(bk.when).slice(0, 10) : null,
            href: '/admin/health',
            need: 'sa',
        });

        // 10-12. Decisions: reported, never scored, never changed from here.
        const ssoOn = await one(
            async () => !!(await require('../services/SsoSettingsService').isSwitchOn())
        );
        push('gl_sso', ssoOn === null ? null : {}, {
            info: true,
            count: ssoOn ? 'on' : 'off',
            href: '/app-settings/sso',
            need: 'sa',
            publicCount: true,
        });
        const kiosk = await one(() => AppSettingsModel.getValue('kioskModeEnabled', false));
        push('gl_kiosk', kiosk === null ? null : {}, {
            info: true,
            count: String(kiosk) === 'true' ? 'on' : 'off',
            href: '/app-settings',
            need: 'view_app_settings',
            publicCount: true,
        });
        const lc = await one(() => require('../utils/featureFlags').isNationalisationEnabled());
        push('gl_local_content', lc === null ? null : {}, {
            info: true,
            count: lc ? 'on' : 'off',
            href: '/admin/modules',
            need: 'sa',
            publicCount: true,
        });

        const scored = lines.filter((l) => l.state !== 'info');
        return {
            lines,
            ready: scored.length > 0 && scored.every((l) => l.state === 'done'),
            todo: scored.filter((l) => l.state !== 'done').length,
        };
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
            const user = req.user || null;
            const { checks, complete } = await this.getChecks(user);
            const golive = await this.getGoLiveChecks(user);
            res.render('pages/setup/index', {
                title: req.t ? req.t('chrome:pt_setup') : 'Setup',
                checks,
                complete,
                golive,
                readOnly: !isSuper(user),
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
module.exports.STEP_LINK_NEEDS = STEP_LINK_NEEDS;
