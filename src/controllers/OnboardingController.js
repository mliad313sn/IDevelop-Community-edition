'use strict';
/**
 * Self-service onboarding endpoints.
 *
 * Public (no auth): GET /signup, POST /signup, GET /onboarding/pending.
 * Admin (manage_onboarding): GET /onboarding (queue), POST /onboarding/:id/approve,
 * POST /onboarding/:id/reject.
 */
const OnboardingService = require('../services/OnboardingService');
const AccountLinkService = require('../services/AccountLinkService');
const RBACService = require('../services/RBACService');
const SiteModel = require('../models/SiteModel');
const DepartmentModel = require('../models/DepartmentModel');
const ServiceModel = require('../models/ServiceModel');
const RoleModel = require('../models/RoleModel');
const EmployeeModel = require('../models/EmployeeModel');
const { bc } = require('../utils/breadcrumbLabel');

/**
 * Render a service outcome in the reader's language.
 *
 * OnboardingService returns a stable `code` (an admin-namespace 'onbx_*' key)
 * plus optional interpolation `params`; `message` is the English last resort for
 * a call with no translator attached. Every decision point in this flow — the
 * signup outcome a brand-new user meets first, and the queue feedback an admin
 * gets — goes through here, so none of them can reach the screen in English on a
 * French-first product.
 */
function say(req, result) {
    if (!result || !result.code || !req.t) return (result && result.message) || '';
    const params = { ...(result.params || {}) };
    // `field` arrives as a stable slug ('department'), never as prose — resolve
    // it too, or the sentence around it would be French with an English noun in
    // the middle.
    if (params.field) params.field = req.t(`admin:onbx_field_${params.field}`);
    return req.t(`admin:${result.code}`, params);
}

class OnboardingController {
    // ---- Public: open email/password signup --------------------------------
    async signupForm(req, res) {
        // The page is reachable when EITHER path is open: the email/password
        // form (allowSignup) and/or one-click SSO registration (allowSso +
        // at least one enabled provider). SSO-only orgs get a form-less page.
        const allowForm = await OnboardingService.allowSignup();
        let ssoProviders = [];
        try {
            if (await OnboardingService.allowSso())
                ssoProviders = require('../config/sso').getEnabledProviders();
        } catch (_) {
            /* SSO optional */
        }
        if (!allowForm && !ssoProviders.length) {
            req.flash(
                'error',
                req.t ? req.t('flash:onb_unavailable') : 'Self-registration is not available.'
            );
            return res.redirect('/login');
        }
        // `layout:false` must be a RENDER OPTION — res.locals.layout is falsy-ignored by
        // express-ejs-layouts and the standalone page ends up double-wrapped.
        const domains = await OnboardingService.allowedDomains();
        // Repopulate the non-secret fields after a validation bounce so the user
        // doesn't retype their email/name. Passwords are never stashed.
        const prefill = (req.session && req.session.signupForm) || {};
        if (req.session) delete req.session.signupForm;
        res.render('pages/onboarding/signup', {
            layout: false,
            title: req.t ? req.t('chrome:pt_create_account') : 'Create account',
            allowedDomains: domains,
            allowForm,
            ssoProviders,
            prefill,
        });
    }

    async signup(req, res) {
        if (!(await OnboardingService.allowSignup())) {
            req.flash(
                'error',
                req.t ? req.t('flash:onb_unavailable') : 'Self-registration is not available.'
            );
            return res.redirect('/login');
        }
        // Honeypot: the form carries a hidden "website" field no human fills. If a
        // bot fills it, silently pretend success (don't signal the trap) and do
        // nothing.
        if (req.body.website) {
            return res.redirect('/onboarding/pending');
        }
        const { email, firstName, lastName, password, confirmPassword } = req.body;
        // Preserve non-secret fields across a validation bounce (never passwords).
        const stash = () => {
            if (req.session) req.session.signupForm = { email, firstName, lastName };
        };
        if (password !== confirmPassword) {
            stash();
            req.flash('error', req.t ? req.t('flash:onb_pw_no_match') : 'Passwords do not match.');
            return res.redirect('/signup');
        }
        const result = await OnboardingService.createFromSignup({
            email,
            firstName,
            lastName,
            password,
        });
        if (!result.ok) {
            if (result.reason !== 'exists') stash();
            req.flash('error', say(req, result));
            return res.redirect(result.reason === 'exists' ? '/login' : '/signup');
        }
        // Remember WHO is waiting, so the holding page can report this person's
        // real state instead of a static leaflet. Session-scoped on purpose: the
        // page must never become an oracle for probing arbitrary addresses.
        if (req.session)
            req.session.onboardingEmail = String(email || '')
                .toLowerCase()
                .trim();
        req.flash('success', say(req, result));
        return res.redirect('/onboarding/pending');
    }

    // ---- Public: "awaiting placement" holding page -------------------------
    async pending(req, res) {
        // Tell the applicant what is ACTUALLY true of their request. Approval used
        // to leave them here forever (account live, page still saying "awaiting"),
        // and a rejection reached them only through an email that a switched-off
        // SMTP silently drops. We only ever look up the address this session
        // submitted; anyone else gets the generic (and still accurate) copy.
        let state = null;
        try {
            const email = req.session && req.session.onboardingEmail;
            if (email) {
                const st = await OnboardingService.statusForEmail(email);
                if (st) state = { ...st, email };
            }
        } catch (e) {
            /* the page must render even if the lookup fails */
        }
        res.render('pages/onboarding/pending', {
            layout: false, // standalone shell — must be a render option, not res.locals
            title: req.t ? req.t('chrome:pt_awaiting_setup') : 'Awaiting setup',
            state,
        });
    }

    // ---- Admin: onboarding queue + placement -------------------------------
    async queue(req, res) {
        try {
            // Placement lists follow the caller's SCOPE: a delegated
            // manage_onboarding holder used to get every site / department /
            // service and every active employee org-wide, and only learnt on
            // submit that the placement was refused. The pending requests
            // themselves carry no placement yet, so they stay listed.
            const isSuper = RBACService.isSuperAdmin(req.user);
            const [requests, sites, departments, services, roles, employees] = await Promise.all([
                OnboardingService.listPending(),
                isSuper
                    ? SiteModel.findAll({}, 'name ASC')
                    : RBACService.getFilteredSites(req.user),
                isSuper
                    ? DepartmentModel.findAll({}, 'name ASC')
                    : RBACService.getFilteredDepartments(req.user),
                isSuper
                    ? ServiceModel.findAll({}, 'name ASC')
                    : RBACService.getFilteredServices(req.user),
                RoleModel.findAll({}, 'name ASC'),
                isSuper
                    ? EmployeeModel.findAll({ isActive: 1 }, 'lastName ASC')
                    : (await RBACService.getFilteredEmployees(req.user)).filter((e) => e.isActive),
            ]);
            // For each SSO request, surface any existing local account it could be
            // MERGED into (matched by email or the incoming external id) so the
            // reviewer can link instead of creating a duplicate. Local signups have
            // no external identity to merge, so they are left as new-account only.
            await Promise.all(
                (requests || []).map(async (r) => {
                    if (r.source === 'sso') {
                        r.matches = await AccountLinkService.findLinkCandidates({
                            email: r.email,
                            provider: r.authProvider,
                            externalId: r.externalId,
                        });
                        r.hasMatches = r.matches.admins.length + r.matches.employees.length > 0;
                    }
                })
            );
            // Repopulate a placement row after a failed submit so the admin doesn't
            // re-enter the whole form. Keyed by request id; consumed once.
            const placementDraft = (req.session && req.session.placementForm) || null;
            if (req.session) delete req.session.placementForm;
            // F10 (3.23.21): during an SSO migration, « attach to the existing
            // account » is the DEFAULT action when a candidate exists.
            const migrationRunning = await OnboardingService.isSsoMigrationRunning();
            res.render('pages/onboarding/queue', {
                title: req.t ? req.t('chrome:pt_onboarding_queue') : 'Onboarding Queue',
                requests,
                sites,
                departments,
                services,
                roles,
                employees,
                migrationRunning,
                isSuperAdmin: RBACService.isSuperAdmin(req.user),
                placementDraft,
                // translated crumbs on a French-first page.
                breadcrumbs: [
                    { label: bc(req, 'chrome:pt_bc_administration', 'Administration') },
                    { label: bc(req, 'chrome:pt_onboarding_queue', 'Onboarding') },
                ],
            });
        } catch (e) {
            console.error('Onboarding queue error:', e);
            req.flash(
                'error',
                req.t ? req.t('flash:onb_queue_load_error') : 'Error loading the onboarding queue.'
            );
            res.redirect('/dashboard');
        }
    }

    async approve(req, res) {
        // Preserve the admin's placement inputs across a validation bounce.
        const stashPlacement = () => {
            if (req.session)
                req.session.placementForm = {
                    requestId: String(req.params.id),
                    employeeNumber: req.body.employeeNumber,
                    firstName: req.body.firstName,
                    lastName: req.body.lastName,
                    siteId: req.body.siteId,
                    departmentId: req.body.departmentId,
                    serviceId: req.body.serviceId,
                    roleId: req.body.roleId,
                    supervisorId: req.body.supervisorId,
                    managerId: req.body.managerId,
                    username: req.body.username,
                };
        };
        try {
            const placement = {
                employeeNumber: req.body.employeeNumber,
                firstName: req.body.firstName,
                lastName: req.body.lastName,
                siteId: req.body.siteId ? parseInt(req.body.siteId, 10) : null,
                departmentId: req.body.departmentId ? parseInt(req.body.departmentId, 10) : null,
                serviceId: req.body.serviceId ? parseInt(req.body.serviceId, 10) : null,
                roleId: req.body.roleId ? parseInt(req.body.roleId, 10) : null,
                supervisorId: req.body.supervisorId ? parseInt(req.body.supervisorId, 10) : null,
                managerId: req.body.managerId ? parseInt(req.body.managerId, 10) : null,
                managerType: req.body.managerId ? 'employee' : null,
                username: req.body.username,
            };
            // Scope guard: a delegated (non-SuperAdmin) admin may only place people
            // INTO their assigned site/department/service — not provision into units
            // outside their scope.
            if (!RBACService.isSuperAdmin(req.user)) {
                const okSite = placement.siteId
                    ? await RBACService.canAccessSite(req.user, placement.siteId)
                    : false;
                const okDept = placement.departmentId
                    ? await RBACService.canAccessDepartment(req.user, placement.departmentId)
                    : false;
                const okSvc = placement.serviceId
                    ? await RBACService.canAccessService(req.user, placement.serviceId)
                    : false;
                // Only-check-what's-provided semantics: every SPECIFIED unit must be
                // in scope, AND at least one specified unit must be in scope. The old
                // `!okSite || !okDept || !okSvc` wrongly denied a legitimate single-
                // unit placement (blank fields defaulted to false → always denied).
                const anyInScope =
                    (placement.siteId && okSite) ||
                    (placement.departmentId && okDept) ||
                    (placement.serviceId && okSvc);
                const anyOutOfScope =
                    (placement.siteId && !okSite) ||
                    (placement.departmentId && !okDept) ||
                    (placement.serviceId && !okSvc);
                if (!anyInScope || anyOutOfScope) {
                    stashPlacement();
                    req.flash(
                        'error',
                        req.t
                            ? req.t('flash:onb_scope_denied')
                            : 'You can only place people within your assigned site/department/service scope.'
                    );
                    return res.redirect('/onboarding');
                }
            }
            // during an SSO migration a request that matches an existing
            // account is ATTACHED by default; creating a second account needs
            // the explicit « create a new account anyway » confirmation.
            if (
                String(req.body.createAnyway || '') !== '1' &&
                (await OnboardingService.isSsoMigrationRunning())
            ) {
                const reqRow = await require('../models/OnboardingRequestModel').findById(
                    parseInt(req.params.id, 10)
                );
                if (reqRow && reqRow.source === 'sso') {
                    const m = await AccountLinkService.findLinkCandidates({
                        email: reqRow.email,
                        provider: reqRow.authProvider,
                        externalId: reqRow.externalId,
                    });
                    if (
                        m.employees.length ||
                        (RBACService.isSuperAdmin(req.user) && m.admins.length)
                    ) {
                        stashPlacement();
                        req.flash(
                            'error',
                            req.t
                                ? req.t('flash:onb_merge_default_required')
                                : 'Attach this request to the existing account, or confirm creating a new one.'
                        );
                        return res.redirect('/onboarding');
                    }
                }
            }
            const result = await OnboardingService.approve(
                parseInt(req.params.id, 10),
                placement,
                req.user.id
            );
            if (!result.ok) stashPlacement();
            // A placed arrival is a JOINER: recorded on the JML
            // ledger and enrolled in the open campaign by LifecycleService.onJoiner
            // — it used to depend on someone recording the event by hand.
            if (result.ok && result.employee && result.employee.id) {
                try {
                    await require('../services/LifecycleService').record(
                        'joiner',
                        Number(result.employee.id),
                        {
                            payload: { source: 'onboarding' },
                            actorRef: `admin:${req.user.id}`,
                        }
                    );
                } catch (e) {
                    console.warn('[onboarding] joiner event failed:', e && e.message);
                }
            }
            // A placement can succeed AND carry an advisory (the address is also
            // used by other accounts): both are shown, the advisory first.
            if (result.ok && result.warning) req.flash('warning', say(req, result.warning));
            req.flash(result.ok ? 'success' : 'error', say(req, result));
            res.redirect('/onboarding');
        } catch (e) {
            console.error('Onboarding approve error:', e);
            stashPlacement();
            req.flash(
                'error',
                req.t ? req.t('flash:onb_place_error') : 'Error placing the onboarding request.'
            );
            res.redirect('/onboarding');
        }
    }

    // Resolve a pending SSO request by MERGING it into an existing local account
    // (link the SSO identity) instead of creating a new employee.
    async merge(req, res) {
        try {
            const result = await AccountLinkService.mergeOnboardingRequest(
                {
                    requestId: parseInt(req.params.id, 10),
                    targetType: req.body.targetType,
                    targetId: parseInt(req.body.targetId, 10),
                },
                req.user
            );
            req.flash(result.ok ? 'success' : 'error', say(req, result));
            res.redirect('/onboarding');
        } catch (e) {
            console.error('Onboarding merge error:', e);
            req.flash(
                'error',
                req.t ? req.t('admin:onbx_err_merge') : 'Error merging the onboarding request.'
            );
            res.redirect('/onboarding');
        }
    }

    async reject(req, res) {
        try {
            const result = await OnboardingService.reject(
                parseInt(req.params.id, 10),
                req.body.note,
                req.user.id
            );
            req.flash(result.ok ? 'success' : 'error', say(req, result));
            res.redirect('/onboarding');
        } catch (e) {
            console.error('Onboarding reject error:', e);
            req.flash(
                'error',
                req.t ? req.t('flash:onb_reject_error') : 'Error rejecting the onboarding request.'
            );
            res.redirect('/onboarding');
        }
    }
}

module.exports = new OnboardingController();
