'use strict';
/**
 * Consolidated "Talent Actions" oversight hub — aggregates PIPs, IDPs and
 * coaching/mentoring plans across the org in a single RBAC-scoped view, plus a
 * calibration/bias panel. Answers the HR ask for one place to see every active
 * development action rather than three separate consoles.
 *
 * Scope: super admin → all; local admin → admin scope; manager → reports.
 */
const db = require('../config/database');
const RBACService = require('../services/RBACService');
/**
 * M-02 — « Not authorized for this employee », la phrase de refus la plus
 * répandue de ce domaine, était un LITTÉRAL anglais rendu tel quel sur une page
 * française : treize lignes, cinq fichiers de routes et un contrôleur, et aucun
 * `say` ne pouvait les atteindre puisqu'elles ne LANCENT pas — elles répondent
 * directement. Le catalogue est partagé (`common:err_not_authorized_employee`)
 * et la phrase anglaise reste la référence par défaut.
 */
const { sayText } = require('../utils/apiErrors');
const notAuthorizedForEmployee = (req) =>
    sayText(req, 'common:err_not_authorized_employee', 'Not authorized for this employee');

const num = (v) => Number(v) || 0;

async function index(req, res) {
    const sc = await RBACService.scopeFilter(req.user, { empAlias: 'e' });

    const pips = await db.all(
        `SELECT p.id, p.state, p.starts_on, p.ends_on, p.summary, p.created_at,
                e.first_name, e.last_name, e.employee_number
           FROM pips p JOIN employees e ON e.id = p.employee_id
          WHERE 1=1 ${sc.clause} ORDER BY p.created_at DESC`,
        sc.params
    );
    const idps = await db.all(
        `SELECT i.id, i.status, i.priority, i.starts_on, i.ends_on, i.created_at,
                e.first_name, e.last_name, e.employee_number
           FROM idp_plans i JOIN employees e ON e.id = i.employee_id
          WHERE 1=1 ${sc.clause} ORDER BY i.created_at DESC`,
        sc.params
    );
    const coaching = await db.all(
        `SELECT c.id, c.kind, c.title, c.state, c.progress, c.context_type, c.target_date, c.created_at,
                e.first_name, e.last_name, e.employee_number
           FROM coaching_plans c JOIN employees e ON e.id = c.employee_id
          WHERE 1=1 ${sc.clause} ORDER BY c.created_at DESC`,
        sc.params
    );

    let bias = [];
    // Calibration bias alerts are org-wide, cross-demographic aggregates (a scoped
    // manager has no clearance over another site's cycle). Org-wide DEI/bias data is
    // SuperAdmin-only everywhere else (v2-capability hub gates deiRep the same way);
    // a scoped manager/admin must not read the whole-org bias table here either.
    if (RBACService && RBACService.isSuperAdmin && RBACService.isSuperAdmin(req.user)) {
        try {
            bias = await db.all(
                `SELECT cycle_id, group_dim, group_value, z_score, state
                   FROM bias_alerts WHERE state = 'open' ORDER BY raised_at DESC LIMIT 25`
            );
        } catch (_) {
            /* bias_alerts may not exist on older schemas */
        }
    }

    const activePips = pips.filter((p) => p.state === 'active');
    const activeIdps = idps.filter((i) => i.status === 'active');
    const activeCoaching = coaching.filter((c) => c.state === 'active');
    // NULL, not 0, when nothing is active: an average over an empty set is an
    // absence of measurement, and "0 %" on the tile read as "no progress".
    const avgProgress = activeCoaching.length
        ? Math.round(
              activeCoaching.reduce((a, c) => a + num(c.progress), 0) / activeCoaching.length
          )
        : null;

    // "Needs attention" — items waiting on a manager action
    const attention = {
        pipsProposed: pips.filter((p) => p.state === 'proposed').length,
        idpsDraft: idps.filter((i) => i.status === 'draft').length,
        coachingStalled: activeCoaching.filter((c) => num(c.progress) === 0).length,
        biasOpen: bias.length,
    };

    const summary = {
        pipsTotal: pips.length,
        pipsActive: activePips.length,
        idpsTotal: idps.length,
        idpsActive: activeIdps.length,
        coachingTotal: coaching.length,
        coachingActive: activeCoaching.length,
        avgProgress,
        byContext: {
            skill_gap: coaching.filter((c) => c.context_type === 'skill_gap').length,
            pip: coaching.filter((c) => c.context_type === 'pip').length,
            idp: coaching.filter((c) => c.context_type === 'idp').length,
        },
    };

    res.render('pages/talent/actions', {
        pips,
        idps,
        coaching,
        bias,
        summary,
        attention,
        title: req.t ? req.t('chrome:pt_talent_actions') : 'Talent Actions',
    });
}

// ---- Career-path gap maps -------------------------------------------
// Compare an employee against a TARGET role: which target-role skill
// requirements are already met vs the gaps to close to be "ready" for it.
async function careerPathPage(req, res) {
    const employees = (await RBACService.getFilteredEmployees(req.user)).map((e) => ({
        id: Number(e.id),
        name: `${e.firstName} ${e.lastName}`,
        number: e.employeeNumber || '',
        roleId: e.roleId,
    }));
    const roles = await db.all('SELECT id, name FROM roles ORDER BY name');
    res.render('pages/talent/career-path', {
        employees,
        roles,
        title: req.t ? req.t('chrome:pt_career_path') : 'Career Path',
    });
}

async function careerPathData(req, res) {
    const employeeId = Number(req.query.employeeId);
    const targetRoleId = Number(req.query.targetRoleId);
    // Classe M-02 : un refus servi à l'écran passe par le catalogue, dans la
    // langue du lecteur. Ces deux-là sont restés en anglais brut parce qu'ils
    // ne sont pas atteignables depuis l'IHM (les listes ne proposent que des
    // identifiants existants) — mais « pas atteignable aujourd'hui » n'est pas
    // « jamais servi » : une requête forgée, un lien périmé ou une future page
    // les rend visibles tels quels.
    if (!employeeId || !targetRoleId) {
        return res.status(400).json({
            code: 'career_path_params_required',
            error: req.t
                ? req.t('flash:career_path_params_required')
                : 'Sélectionnez un collaborateur et un poste cible.',
        });
    }

    // Scope guard: caller must govern this employee.
    if (!RBACService.isSuperAdmin(req.user)) {
        const ok = (await RBACService.getFilteredEmployees(req.user)).some(
            (e) => Number(e.id) === employeeId
        );
        if (!ok) return res.status(403).json({ error: notAuthorizedForEmployee(req) });
    }

    const emp = await db.get(
        `SELECT e.id, e.first_name, e.last_name, e.role_id, r.name AS role_name
           FROM employees e LEFT JOIN roles r ON r.id = e.role_id WHERE e.id = ?`,
        [employeeId]
    );
    const target = await db.get('SELECT id, name FROM roles WHERE id = ?', [targetRoleId]);
    if (!emp || !target) {
        return res.status(404).json({
            code: 'career_path_not_found',
            error: req.t
                ? req.t('flash:career_path_not_found')
                : 'Ce collaborateur ou ce poste n’existe plus.',
        });
    }

    // Read the RESOLVED level (validated + approved self) and honour a lapsed
    // certificate, like every other readiness surface — not raw skill_assessments
    // with COALESCE(...,0). A requirement the employee has never been assessed on
    // is unknown, not a gap from 0: current/gap are null and it is reported as
    // unmeasured, never as a red shortfall or a folded-in failure. required_level
    // = 0 means NOT REQUIRED and is excluded.
    // The query and the summary live in EmployeeGrowthService so the employee's
    // own "gap against my target role" reads the SAME numbers as this tool.
    const {
        rows: mapped,
        total,
        measured,
        met,
        criticalGaps,
        unmeasured,
        readiness,
        coverage,
        gaps,
    } = await require('../services/EmployeeGrowthService').roleGap(employeeId, targetRoleId);

    res.json({
        employee: {
            id: emp.id,
            name: `${emp.firstName} ${emp.lastName}`,
            currentRole: emp.roleName || '—',
        },
        target: { id: target.id, name: target.name },
        readiness,
        coverage,
        met,
        total,
        measured,
        unmeasured,
        gaps,
        criticalGaps,
        rows: mapped,
    });
}

// ---- Action Center (G2, thin) -------------------------------------------
// Live count of items waiting on THIS user, computed on read (no write pipeline).
/**
 * The signed-in user's to-do items (the Action Center list), RBAC-scoped:
 * managers/admins get their scoped queues, an employee only their OWN items.
 * Shared by GET /api/my-actions and the AI companion's "what should I do next".
 *
 * @param {object} user       req.user
 * @param {function} [translate] (fullKey, fallback, params) → label; defaults to
 *                             the English fallback when no i18n is at hand
 * @returns {Promise<Array<{label,count,href,icon,overdue?}>>}
 */
async function collectMyActions(user, translate) {
    const tr = typeof translate === 'function' ? translate : (k, fallback) => fallback;
    const items = [];
    // Action Center is the app's most-viewed component (bell + "what awaits you"
    // strip) — labels must follow the user's locale, not ship English on a
    // French-first product. Resolve server-side; the client renders verbatim.
    const t = (key, fallback) => tr('talentx:' + key, fallback);
    const isMgrAdmin = user.userType === 'admin' || user.userType === 'manager';
    try {
        if (isMgrAdmin) {
            const sc = await RBACService.scopeFilter(user, { empAlias: 'e' });
            const review = await db.get(
                `SELECT COUNT(DISTINCT sa.id) AS c FROM self_assessments sa JOIN employees e ON e.id = sa.employee_id
                  WHERE sa.workflow_state = 'submitted' ${sc.clause}`,
                sc.params
            );
            if (num(review && review.c))
                items.push({
                    label: t('ac_sa_review', 'Self-assessments to review'),
                    count: num(review.c),
                    href: '/supervisor/self-assessment-reviews',
                    icon: 'fa-clipboard-check',
                });

            const pip = await db.get(
                `SELECT COUNT(*) AS c FROM pips p JOIN employees e ON e.id = p.employee_id
                  WHERE p.state = 'proposed' ${sc.clause}`,
                sc.params
            );
            if (num(pip && pip.c))
                items.push({
                    label: t('ac_pip_activate', 'PIPs awaiting activation'),
                    count: num(pip.c),
                    href: '/v2/pip',
                    icon: 'fa-user-clock',
                });

            const idp = await db.get(
                `SELECT COUNT(*) AS c FROM idp_plans i JOIN employees e ON e.id = i.employee_id
                  WHERE i.status = 'draft' ${sc.clause}`,
                sc.params
            );
            if (num(idp && idp.c))
                items.push({
                    label: t('ac_idp_draft', 'IDPs in draft'),
                    count: num(idp.c),
                    href: '/v2/idp',
                    icon: 'fa-seedling',
                });

            const stalled = await db.get(
                `SELECT COUNT(*) AS c FROM coaching_plans c JOIN employees e ON e.id = c.employee_id
                  WHERE c.state = 'active' AND COALESCE(c.progress,0) = 0 ${sc.clause}`,
                sc.params
            );
            if (num(stalled && stalled.c))
                items.push({
                    label: t('ac_coaching_notstarted', 'Coaching plans not started'),
                    count: num(stalled.c),
                    href: '/coaching/plans',
                    icon: 'fa-people-arrows',
                });

            // The campaign chase: the governed people who have not started
            // the running campaign are the manager's first item — read from the
            // ROSTER, so the person who never opened the page is counted. "Overdue"
            // once the deadline has passed. Fail-soft: never blocks the bell.
            try {
                const CycleService = require('../services/CycleService');
                const cycle = await CycleService.findCurrent();
                if (cycle) {
                    const scope = await CycleService.resolveScope(user);
                    const p = await CycleService.progress(cycle.id, user, { scope });
                    const overdue =
                        cycle.closesAt && new Date(cycle.closesAt).getTime() < Date.now();
                    const tc = (key, fallback) =>
                        tr('admin:' + key, fallback, { cycle: cycle.code });
                    if (p.states.not_started.count) {
                        items.push({
                            label: tc(
                                overdue ? 'camp_ac_not_started_overdue' : 'camp_ac_not_started',
                                `Reports not started in campaign ${cycle.code}`
                            ),
                            count: p.states.not_started.count,
                            href: `/cycles/${cycle.id}?state=not_started`,
                            icon: 'fa-bullhorn',
                            overdue: !!overdue,
                        });
                    }
                }
            } catch (_) {
                /* campaign item is best-effort */
            }

            // Admin-only queues: two-person-rule approvals (superadmin decides) and
            // self-service onboarding requests (manage_onboarding). These are the
            // "something awaits your approval / a new person to process" actions.
            if (user.userType === 'admin') {
                if (RBACService.isSuperAdmin(user)) {
                    const appr = await db
                        .get(
                            `SELECT COUNT(*) AS c FROM maker_checker_requests WHERE state = 'pending'`
                        )
                        .catch(() => null);
                    if (num(appr && appr.c))
                        items.push({
                            label: t('ac_approvals', 'Approvals awaiting your decision'),
                            count: num(appr.c),
                            href: '/v2/uam/maker-checker/queue',
                            icon: 'fa-user-shield',
                        });
                }
                if (RBACService.hasPermission(user, 'manage_onboarding')) {
                    const onb = await db
                        .get(
                            `SELECT COUNT(*) AS c FROM onboarding_requests WHERE status = 'pending'`
                        )
                        .catch(() => null);
                    if (num(onb && onb.c))
                        items.push({
                            label: t('ac_onboarding', 'Onboarding requests to review'),
                            count: num(onb.c),
                            href: '/onboarding',
                            icon: 'fa-user-plus',
                        });
                }
                // ---- SECTION accounts: manager requests waiting on an admin (scoped) ----
                // "Unlock / resend my report's credentials" → whoever holds
                // reset_employee_password; "departure requested"
                // → whoever holds edit_employees. Both land on the page that acts.
                if (RBACService.hasPermission(user, 'reset_employee_password')) {
                    const ar = await db
                        .get(
                            `SELECT COUNT(*) AS c FROM account_requests r JOIN employees e ON e.id = r.employee_id
                          WHERE r.decided_at IS NULL ${sc.clause}`,
                            sc.params
                        )
                        .catch(() => null);
                    if (num(ar && ar.c))
                        items.push({
                            label: t('ac_account_requests', 'Account requests (unlock / resend)'),
                            count: num(ar.c),
                            href: '/admin/accounts?requests=1',
                            icon: 'fa-user-lock',
                        });
                }
                if (RBACService.hasPermission(user, 'edit_employees')) {
                    const lr = await db
                        .get(
                            `SELECT COUNT(*) AS c FROM lifecycle_events le JOIN employees e ON e.id = le.employee_id
                          WHERE le.kind = 'leaver' AND le.requested_by IS NOT NULL AND le.decided_at IS NULL AND le.reverted_at IS NULL ${sc.clause}`,
                            sc.params
                        )
                        .catch(() => null);
                    if (num(lr && lr.c))
                        items.push({
                            label: t('ac_leaver_requests', 'Departure requests to decide'),
                            count: num(lr.c),
                            href: '/v2/lifecycle?state=requested',
                            icon: 'fa-door-closed',
                        });
                }
                // ---- end SECTION accounts ----
            }
        } else {
            // Employee: the things THEY most need to act on next.
            const eid = user.id;
            // Self-assessment(s) sent back for changes — they're blocked until they act.
            const cr = await db.get(
                `SELECT COUNT(DISTINCT id) AS c FROM self_assessments WHERE employee_id = ? AND workflow_state = 'changes_requested'`,
                [eid]
            );
            if (num(cr && cr.c))
                items.push({
                    label: t('ac_sa_changes', 'Self-assessment changes requested'),
                    count: num(cr.c),
                    href: '/employee/self-assessment',
                    icon: 'fa-pen-to-square',
                });
            // Newly reviewed ratings (their dispute window is open).
            const rv = await db.get(
                `SELECT COUNT(DISTINCT id) AS c FROM self_assessments WHERE employee_id = ? AND workflow_state = 'reviewed'`,
                [eid]
            );
            if (num(rv && rv.c))
                items.push({
                    label: t('ac_reviewed_ack', 'Reviewed assessments to acknowledge'),
                    count: num(rv.c),
                    href: '/employee/assessment-status',
                    icon: 'fa-clipboard-check',
                });
            // Open development actions assigned to them (IDP) — on a LIVE plan
            // only. An action still 'pending' under a cancelled/archived plan is
            // not something they can act on, and used to keep the bell lit.
            const acts = await db
                .get(
                    `SELECT COUNT(a.id) AS c FROM idp_actions a JOIN idp_plans p ON p.id = a.idp_id
                  WHERE p.employee_id = ? AND p.status IN ('draft','active')
                    AND a.status IN ('pending','in_progress')`,
                    [eid]
                )
                .catch(() => null);
            if (num(acts && acts.c))
                items.push({
                    label: t('ac_dev_actions', 'Development actions to progress'),
                    count: num(acts.c),
                    href: '/v2/idp',
                    icon: 'fa-seedling',
                });
            // Active coaching plans.
            const mine = await db.get(
                `SELECT COUNT(*) AS c FROM coaching_plans WHERE employee_id = ? AND state = 'active'`,
                [eid]
            );
            if (num(mine && mine.c))
                items.push({
                    label: t('ac_my_coaching', 'Your active coaching plans'),
                    count: num(mine.c),
                    href: '/employee/my-coaching',
                    icon: 'fa-hands-helping',
                });
            // Recognition received (delight, not a task — but worth surfacing).
            const rec = await db
                .get(
                    `SELECT COUNT(*) AS c FROM recognitions WHERE to_employee_id = ? AND created_at > now() - interval '14 days'`,
                    [eid]
                )
                .catch(() => null);
            if (num(rec && rec.c))
                items.push({
                    label: t('ac_recognition', 'Recent recognition you received'),
                    count: num(rec.c),
                    href: '/employee/dashboard',
                    icon: 'fa-award',
                });
        }
        // 360° feedback (development module): questionnaires to fill in, raters
        // to choose, nominations to approve — for the PERSON behind any account.
        if (await require('../services/ModuleService').isOn('development')) {
            const f = await require('../services/Feedback360Service').pendingCounts(user);
            const f360 = [
                [f.answer, t('ac_f360_answer', '360° questionnaires to fill in'), 'fa-comments'],
                [f.nominate, t('ac_f360_nominate', '360° raters to choose'), 'fa-street-view'],
                [f.approve, t('ac_f360_approve', '360° raters to approve'), 'fa-user-check'],
            ];
            for (const [count, label, icon] of f360)
                if (count) items.push({ label, count, href: '/feedback-360', icon });
        }
    } catch (e) {
        /* never block the bell */
    }
    return items;
}

async function myActions(req, res) {
    const translate = (key, fallback, params) =>
        req.t ? req.t(key, { defaultValue: fallback, ...(params || {}) }) : fallback;
    const items = await collectMyActions(req.user, translate);
    res.json({ total: items.reduce((a, i) => a + i.count, 0), items });
}

// ---- Per-employee development dossier (coaching + IDP + PIP) -------------
// Used on the employee profile to show progression across all talent actions.
async function employeeDevelopment(req, res) {
    const id = Number(req.params.id);
    const coaching = await db.all(
        `SELECT id, kind, title, state, COALESCE(progress,0) AS progress, context_type, target_date, created_at, updated_at
           FROM coaching_plans WHERE employee_id = ? ORDER BY created_at DESC`,
        [id]
    );
    const idps = await db.all(
        `SELECT i.id, i.status, i.priority, i.starts_on, i.ends_on, i.created_at,
                (SELECT COUNT(*) FROM idp_objectives o WHERE o.idp_id = i.id)::int AS obj_total,
                (SELECT COUNT(*) FROM idp_actions a WHERE a.idp_id = i.id)::int AS act_total,
                (SELECT COUNT(*) FROM idp_actions a WHERE a.idp_id = i.id AND a.status = 'completed')::int AS act_done
           FROM idp_plans i WHERE i.employee_id = ? ORDER BY i.created_at DESC`,
        [id]
    );
    const pips = await db.all(
        `SELECT id, state, starts_on, ends_on, summary, outcome, created_at, updated_at
           FROM pips WHERE employee_id = ? ORDER BY created_at DESC`,
        [id]
    );
    res.json({ coaching, idps, pips });
}

// ---- Unified development timeline (skills · 9-box · coaching · IDP · PIP) -
async function employeeTimeline(req, res) {
    const id = Number(req.params.id);
    const NineBox = require('../services/NineBoxService');
    const ev = [];

    // Clearance-fit: when the viewer IS the subject employee, surface only 9-box
    // placements already disclosed to them — an approved-but-undisclosed box must
    // not leak through the timeline (a manager/admin viewing a report still sees
    // everything). Admins are not employee rows, so they are never "the subject".
    const viewerIsSubject = req.user && req.user.userType !== 'admin' && Number(req.user.id) === id;
    // And when the organisation hides the 9-box from employees entirely, the
    // subject sees no placement in their timeline at all.
    const nbHiddenFromSubject =
        viewerIsSubject &&
        !(await require('../services/TalentConfidentialityService').nineBoxVisibleToEmployees());
    const nbDisclosed = nbHiddenFromSubject
        ? ' AND false'
        : viewerIsSubject
          ? ' AND disclosed_to_employee = true'
          : '';
    // French-first product: the development-dossier event text was English server-side.
    const fr = !req.language || String(req.language).startsWith('fr');
    const stateLbl = (s) =>
        fr
            ? { completed: 'terminé', cancelled: 'annulé', closed: 'clôturé', active: 'activé' }[
                  s
              ] || s
            : s;

    const sk = await db.all(
        `SELECT ah.assessed_at AS at, s.name AS skill, ah.previous_level AS prev, ah.new_level AS nl, ah.source
           FROM assessment_history ah JOIN skills s ON s.id = ah.skill_id
          WHERE ah.employee_id = ? ORDER BY ah.assessed_at DESC LIMIT 80`,
        [id]
    );
    sk.forEach((r) =>
        ev.push({
            at: r.at,
            kind: 'skill',
            text:
                (fr ? 'Compétence' : 'Skill') +
                ' “' +
                r.skill +
                '” : ' +
                (r.prev == null ? '—' : r.prev) +
                ' → ' +
                r.nl +
                (r.source ? ' (' + r.source + ')' : ''),
        })
    );

    const nb = await db.all(
        `SELECT COALESCE(approved_at, updated_at, created_at) AS at, performance, potential, status
           FROM nine_box_evaluations WHERE employee_id = ? AND status IN ('approved','archived')${nbDisclosed} ORDER BY 1 DESC`,
        [id]
    );
    nb.forEach((r) => {
        const lbl = NineBox.computeBox(r.performance, r.potential).label;
        ev.push({
            at: r.at,
            kind: 'ninebox',
            text:
                '9-Box : ' +
                lbl +
                ' (' +
                (fr ? 'perf' : 'perf') +
                ' ' +
                r.performance +
                ' / ' +
                (fr ? 'pot' : 'pot') +
                ' ' +
                r.potential +
                ')' +
                (r.status === 'archived' ? (fr ? ' [archivé]' : ' [archived]') : ''),
        });
    });

    const co = await db.all(
        `SELECT created_at, updated_at, title, kind, state FROM coaching_plans WHERE employee_id = ?`,
        [id]
    );
    co.forEach((c) => {
        ev.push({
            at: c.createdAt,
            kind: 'coaching',
            text:
                (c.kind === 'mentoring' ? (fr ? 'Mentorat' : 'Mentoring') : 'Coaching') +
                (fr ? ' démarré : ' : ' plan started: ') +
                (c.title || ''),
        });
        if (['completed', 'cancelled'].includes(c.state))
            ev.push({
                at: c.updatedAt,
                kind: 'coaching',
                text:
                    (fr ? 'Plan de coaching ' : 'Coaching plan ') +
                    stateLbl(c.state) +
                    ' : ' +
                    (c.title || ''),
            });
    });

    const idp = await db.all(`SELECT id, created_at, status FROM idp_plans WHERE employee_id = ?`, [
        id,
    ]);
    idp.forEach((i) =>
        ev.push({
            at: i.createdAt,
            kind: 'idp',
            text:
                'IDP #' + i.id + (fr ? ' créé (statut : ' : ' created (status: ') + i.status + ')',
        })
    );
    const ida = await db.all(
        `SELECT a.completed_at AS at, a.title FROM idp_actions a JOIN idp_plans i ON i.id = a.idp_id WHERE i.employee_id = ? AND a.status = 'completed' AND a.completed_at IS NOT NULL`,
        [id]
    );
    ida.forEach((a) =>
        ev.push({
            at: a.at,
            kind: 'idp',
            text: (fr ? 'Action IDP terminée : ' : 'IDP action completed: ') + (a.title || ''),
        })
    );

    const pip = await db.all(
        `SELECT id, created_at, updated_at, state, outcome FROM pips WHERE employee_id = ?`,
        [id]
    );
    pip.forEach((p) => {
        ev.push({
            at: p.createdAt,
            kind: 'pip',
            text: 'PIP #' + p.id + (fr ? ' ouvert' : ' opened'),
        });
        // pip_state has NO 'closed' member — it is
        // proposed|approved|active|closed_success|closed_failure|cancelled
        // (db/postgres/05_talent_coaching_pip.sql). Branching on 'closed' meant this
        // never matched, so every PIP showed only as "opened" and no outcome ever
        // reached the development timeline.
        if (
            p.state === 'closed_success' ||
            p.state === 'closed_failure' ||
            p.state === 'cancelled'
        ) {
            const label =
                p.state === 'closed_success'
                    ? fr
                        ? ' clôturé — réussi'
                        : ' closed — successful'
                    : p.state === 'closed_failure'
                      ? fr
                          ? ' clôturé — non atteint'
                          : ' closed — not met'
                      : fr
                        ? ' annulé'
                        : ' cancelled';
            ev.push({
                at: p.updatedAt,
                kind: 'pip',
                text: 'PIP #' + p.id + label + (p.outcome ? ' — ' + p.outcome : ''),
            });
        } else if (p.state === 'active')
            ev.push({
                at: p.updatedAt,
                kind: 'pip',
                text: 'PIP #' + p.id + (fr ? ' activé' : ' activated'),
            });
    });

    const out = ev
        .filter((e) => e.at)
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, 150);
    res.json({ timeline: out });
}

module.exports = {
    index,
    careerPathPage,
    careerPathData,
    myActions,
    collectMyActions,
    employeeDevelopment,
    employeeTimeline,
};
