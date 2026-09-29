const EmployeeModel = require('../models/EmployeeModel');
const SelfAssessmentModel = require('../models/SelfAssessmentModel');
const SupervisorReviewModel = require('../models/SupervisorReviewModel');
const RoleSkillRequirementModel = require('../models/RoleSkillRequirementModel');
const SkillAssessmentModel = require('../models/SkillAssessmentModel');
const ReadinessService = require('../services/ReadinessService');
const SelfAssessmentService = require('../services/SelfAssessmentService');
const SkillHelpService = require('../services/SkillHelpService');
// 3 — the one place that decides whether employee-facing prose may
// name a person's 9-box cell, and what they have actually been told.
const TalentConfidentialityService = require('../services/TalentConfidentialityService');
// one date rendering per page. `closes_at` is a calendar bound stored
// at UTC midnight, so it is printed with fmtPeriodBound (UTC-forced dd/MM/yyyy),
// never with the toISOString.slice(0,10) the module itself condemns.
const { fmtPeriodBound } = require('../utils/dateFormat');
const db = require('../config/database');
const EmployeeGrowthService = require('../services/EmployeeGrowthService');

// Translate raw/DB errors into a clean HTTP status + STABLE error CODE so the
// employee never sees a 500/stack trace — and never sees English prose in a
// French-first UI. The client maps the code to a localized employee:* string.
function mapSelfAssessmentError(error) {
    const code = error && error.code;
    const msg = (error && error.message) || '';
    // Postgres unique-violation (e.g. a stale duplicate row from an older submit)
    if (code === '23505' || /duplicate key|already exists/i.test(msg)) {
        return { status: 409, code: 'already_submitted' };
    }
    // Foreign-key / check violations → bad input
    if (code === '23503' || code === '23514' || code === '23502') {
        return { status: 400, code: 'invalid_data' };
    }
    // Our own validation / business-rule messages (service-thrown, English text)
    // collapse to one stable validation code the client localizes.
    if (
        /(between 0 and 4|at least one skill|Invalid|no supervisor or manager|not found|Nothing to submit)/i.test(
            msg
        )
    ) {
        return { status: 400, code: 'validation' };
    }
    return { status: 500, code: 'unexpected' };
}

// Which campaign is this employee working in RIGHT NOW?
//
// residual: the live self-assessment page posts no cycle id (it is current
// by definition), so every save reached SelfAssessmentService with
// `expectedCycleId = null` — the "file it wherever" path. Once the person's
// campaign is LOCKED there is no open cycle left, so the service filed the row
// with cycle_id NULL and the browser was answered 200 "brouillon enregistré":
// work the employee did FOR a named campaign, filed outside it, reported as a
// success. Naming the campaign here lets the service refuse instead.
//   open cycle       → its id (the normal case; the save proceeds unchanged)
//   locked enrolment → that campaign (mismatch → refused, and we can name it)
//   neither          → null: genuinely off-campaign entry, still supported
// Never throws: a failing lookup degrades to "no campaign stated" rather than
// taking the save down with it.
async function resolveEmployeeCycle(employeeId) {
    try {
        const open = await db.get(
            "SELECT id FROM assessment_cycles WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
        );
        if (open && open.id != null) return { cycleId: String(open.id), locked: null };
        const locked = await db.get(
            `SELECT c.id, c.code, c.label, c.closes_at AS "closesAt"
               FROM assessment_cycles c
               JOIN cycle_participants p ON p.cycle_id = c.id
              WHERE c.status = 'locked' AND p.employee_id = ? AND p.excluded_at IS NULL
              ORDER BY c.closes_at DESC LIMIT 1`,
            [employeeId]
        );
        if (locked && locked.id != null) return { cycleId: String(locked.id), locked };
    } catch (_) {
        /* campaigns are optional — never block a save on this lookup */
    }
    return { cycleId: null, locked: null };
}

// The refusal sentence for a locked campaign, in the session language. It reuses
// the very wording the page already shows above the form
// (employee:sa_no_campaign_last), so the notice and the refusal agree.
function lockedCampaignMessage(req, locked) {
    if (!req || typeof req.t !== 'function' || !locked) return undefined;
    return req.t('employee:sa_no_campaign_last', {
        label: locked.label || locked.code || '',
        // was toISOString.slice(0,10) → « clôturée le 2026-08-31 » in a
        // French sentence, while the neighbouring page said « 31/08/2026 ».
        date: fmtPeriodBound(locked.closesAt),
    });
}

class EmployeePortalController {
    // Employee landing page: their assessment state, skill gaps and 9-box position.
    async dashboard(req, res) {
        const employeeId = req.user.id;
        let employee = null,
            snapshot = null;
        try {
            employee = await EmployeeModel.findByIdWithOrganization(employeeId);

            // Skill gaps vs the role's required levels.
            //
            // Read the SHARED view rather than a bespoke query. The previous
            // local SELECT diverged from the rest of the platform three ways:
            //   * COALESCE(sa.current_level, 0) showed a skill NOBODY HAS EVER
            //     ASSESSED as "current 0" with a real-looking gap — an absence
            //     of measurement rendered as a result.
            //   * it included requirements of level 0 (which mean "not
            //     required"), and those scored gap 0, so they were badged
            //     "✓ atteint" and inflated the denominator.
            //   * met/total gave the employee a readiness number that
            //     contradicted v_employee_readiness on the very same profile —
            //     measured: 80 % (40/50) here vs 89 % (39/49) everywhere else.
            //
            // v_employee_skill_gaps already excludes required_level = 0 and
            // carries is_assessed, so both problems disappear; readiness comes
            // from v_employee_readiness so the employee sees the SAME figure the
            // organisation sees, not a third opinion.
            const rawGaps = await db.all(
                `SELECT g.skill_name, g.domain_name,
                        g.required_level AS required, g.actual_level,
                        g.is_assessed, g.is_critical, g.gap, g.is_met
                   FROM v_employee_skill_gaps g
                  WHERE g.employee_id = ?
                  ORDER BY g.is_assessed ASC, g.gap DESC, g.is_critical DESC, g.skill_name`,
                [employeeId]
            );
            // `current` and `gap` are NULL when nothing was ever measured, so the
            // template cannot print a 0 that was never observed.
            const gapRows = rawGaps.map((r) => {
                const assessed = Number(r.isAssessed) === 1;
                return {
                    skillName: r.skillName,
                    domainName: r.domainName,
                    required: r.required,
                    isCritical: r.isCritical,
                    assessed,
                    current: assessed ? Number(r.actualLevel) : null,
                    gap: assessed ? Number(r.gap) : null,
                    met: assessed && Number(r.isMet) === 1,
                };
            });
            const total = gapRows.length;
            const met = gapRows.filter((r) => r.met).length;
            const unmeasured = gapRows.filter((r) => !r.assessed).length;
            const criticalGaps = gapRows.filter(
                (r) => r.assessed && Number(r.gap) > 0 && r.isCritical
            ).length;
            // The readiness the ORGANISATION publishes is readiness_assessed_only:
            // readiness over the requirements that have actually been assessed.
            // Every other surface — the dashboard, the reports, the MANAGER's view
            // of this same person — uses it, so the employee must see the SAME
            // number. This tile used to read v_employee_readiness.readiness, the
            // ALL-REQUIREMENTS figure, which folds every not-yet-assessed skill
            // back in as a failure: it contradicts the null gap rows built twenty
            // lines above AND undercuts the manager's number (measured here: 8
            // employees saw a portal readiness up to 17 points below what their
            // manager saw — e.g. 88 % on the portal for someone the manager sees
            // at 100 %). readiness_assessed_only is already NULL when nothing has
            // been assessed, so the first-run state is preserved; coverage travels
            // with it so the partial assessment is shown, not hidden in a lowered
            // percentage.
            const covRow = await db
                .get(
                    `SELECT readiness_assessed_only, assessed_skills, expected_skills
                       FROM v_employee_assessment_coverage WHERE employee_id = ?`,
                    [employeeId]
                )
                .catch(() => null);
            const readiness =
                covRow && covRow.readinessAssessedOnly != null
                    ? Math.round(Number(covRow.readinessAssessedOnly))
                    : null;
            const coverage = {
                assessedSkills: covRow ? Number(covRow.assessedSkills) || 0 : 0,
                expectedSkills: covRow ? Number(covRow.expectedSkills) || 0 : 0,
            };

            // Assessment workflow state breakdown
            const stateRows = await db.all(
                `SELECT workflow_state AS state, COUNT(*)::int AS n
                   FROM self_assessments WHERE employee_id = ? GROUP BY workflow_state`,
                [employeeId]
            );

            // Latest APPROVED 9-box placement — only visible to the employee when the
            // hierarchical superior has explicitly DISCLOSED it. Undisclosed placements
            // (and all in-progress ones) stay confidential and are hidden entirely.
            //
            // The organisation may also hide the 9-box from employees ENTIRELY
            // (App Setting nineBoxVisibleToEmployees, default visible): then even a
            // disclosed placement is not read, and the page shows no 9-box at all.
            const nineBoxVisible = await TalentConfidentialityService.nineBoxVisibleToEmployees();
            const nineBox = nineBoxVisible
                ? await db.get(
                      `SELECT performance, potential, box, box_label, approved_at
                         FROM nine_box_evaluations
                        WHERE employee_id = ? AND status = 'approved' AND disclosed_to_employee = true
                        ORDER BY approved_at DESC NULLS LAST, id DESC LIMIT 1`,
                      [employeeId]
                  )
                : null;

            // `gaps` counts MEASURED shortfalls only. It used to be total - met,
            // which silently swept every never-assessed skill into the gap tile.
            const gaps = gapRows.filter((r) => r.assessed && Number(r.gap) > 0).length;
            snapshot = {
                gapRows,
                total,
                met,
                gaps,
                unmeasured,
                criticalGaps,
                readiness,
                coverage,
                stateRows,
                nineBox,
                nineBoxVisible,
            };
        } catch (e) {
            console.error('Employee dashboard error:', e);
        }
        // « Mon écart avec mon poste visé » teaser — the person's OWN target role
        // (employee_aspirations), summarised like the manager's career-path tool.
        let targetGap = null;
        try {
            targetGap = await EmployeeGrowthService.targetRoleGap(employeeId);
        } catch (_) {
            /* optional */
        }
        res.render('pages/employee/dashboard', {
            title: req.t ? req.t('employee:dashboard_title') : 'My workspace',
            employee,
            snapshot,
            targetGap,
        });
    }

    // My OKRs & 1-on-1s — the employee's own goals and check-ins. The page is a
    // thin shell; data comes from /api/v1 (session-authed, canAccessEmployee lets
    // everyone read/update their OWN goals and add items to their own 1:1s).
    async myOkr(req, res) {
        let employee = null;
        try {
            employee = await EmployeeModel.findByIdWithOrganization(req.user.id);
        } catch (e) {
            console.error('My OKR page error:', e);
        }
        if (!employee) {
            req.flash('error', req.t ? req.t('flash:emp_not_found') : 'Employee not found');
            return res.redirect('/employee/dashboard');
        }
        res.render('pages/employee/okr', {
            title: req.t ? req.t('employee:okr_title') : 'My OKRs & 1-on-1s',
            employee,
        });
    }

    async selfAssessment(req, res) {
        try {
            const employeeId = req.user.id;
            const employee = await EmployeeModel.findByIdWithOrganization(employeeId);

            // Get role requirements
            const requirements = await RoleSkillRequirementModel.findByRoleId(employee.roleId);

            // Get current self-assessments
            const selfAssessments = await SelfAssessmentModel.findByEmployeeId(employeeId);
            const assessmentMap = {};
            selfAssessments.forEach((a) => {
                assessmentMap[a.skillId] = a;
            });

            // Get current skill assessments (supervisor/admin assessments)
            const skillAssessments = await SkillAssessmentModel.findByEmployeeId(employeeId);
            const skillAssessmentMap = {};
            skillAssessments.forEach((a) => {
                skillAssessmentMap[a.skillId] = a;
            });

            // Merge requirements with self-assessments
            const skillsWithAssessments = requirements.map((req) => ({
                ...req,
                selfAssessment: assessmentMap[req.skillId] || null,
                // NULLISH, not `|| 0`: a never-rated skill must reach the view as null so
                // the "answered vs unrated" logic works (a genuine saved 0 stays 0). With
                // `|| 0` a fresh form loaded as 100%-complete — defeating the honest-zero UX.
                selfRatedLevel: assessmentMap[req.skillId]?.selfRatedLevel ?? null,
                currentSkillLevel: skillAssessmentMap[req.skillId]?.currentLevel || 0,
                status: assessmentMap[req.skillId]?.status || 'not_started',
            }));
            // 3.23.21: what each skill and each of its levels mean — two
            // batched queries for the whole list, best-effort (never fails the page).
            await SkillHelpService.attach(skillsWithAssessments);

            // Campaign context: the deadline must be visible ON the page where
            // the work happens — previously the employee saw no due date at all
            // even though the cycle, the nudge job and the burndown all knew it.
            let cycle = null;
            // With NO open campaign the form still works — SelfAssessmentService
            // files the rating with cycle_id NULL ("organic", outside any campaign).
            // That is a supported path, but it must be SAID: the page used to
            // render the full form with no banner and accept Save/Submit as if a
            // campaign were counting them. `lockedCycle` names the most recent
            // locked campaign the person is enrolled in so the notice can explain
            // why its counters (on /employee/assessment-status) will not move.
            let lockedCycle = null;
            try {
                const c = await db.get(
                    `SELECT id, code, label, closes_at AS "closesAt"
                       FROM assessment_cycles WHERE status = 'open'
                      ORDER BY opened_at DESC LIMIT 1`
                );
                if (c) {
                    const daysLeft = Math.ceil((new Date(c.closesAt) - Date.now()) / 86400000);
                    // the view printed this bound with toISOString.slice(0,10).
                    // The date is formatted HERE, once, so both banners read « 31/08/2026 ».
                    cycle = { ...c, daysLeft, closesAtText: fmtPeriodBound(c.closesAt) };
                } else {
                    const lc = await db.get(
                        `SELECT c.id, c.code, c.label, c.closes_at AS "closesAt"
                           FROM assessment_cycles c
                           JOIN cycle_participants p ON p.cycle_id = c.id
                          WHERE c.status = 'locked' AND p.employee_id = ? AND p.excluded_at IS NULL
                          ORDER BY c.closes_at DESC LIMIT 1`,
                        [employeeId]
                    );
                    lockedCycle = lc ? { ...lc, closesAtText: fmtPeriodBound(lc.closesAt) } : null;
                }
            } catch (_) {
                /* cycles optional — page still works without one */
            }

            // the header counters ("0 sur 0", "Environ -") were rendered
            // empty and only became true after JS ran, so the first thing an employee
            // read about their own file was wrong. The server has the list: it counts it.
            const saTotal = (skillsWithAssessments || []).length;
            const saRated = (skillsWithAssessments || []).filter(
                (s) => s.selfRatedLevel != null
            ).length;
            const saRemaining = saTotal - saRated;
            res.render('pages/employee/self-assessment', {
                title: req.t ? req.t('employee:sa_title') : 'Self-Assessment',
                employee,
                skillsWithAssessments,
                cycle,
                lockedCycle,
                saTotal,
                saRated,
                saRemaining,
                // ~8 s per remaining skill, floor of one minute — the same rule the
                // client uses while rating, so the number never jumps on first keystroke.
                saEstimateMin: Math.max(1, Math.round((saRemaining * 8) / 60)),
            });
        } catch (error) {
            console.error('Self-assessment error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:sa_load_error') : 'Error loading self-assessment'
            );
            res.redirect('/employee/dashboard');
        }
    }

    async submitSelfAssessment(req, res) {
        try {
            const employeeId = req.user.id;
            const { assessments } = req.body;

            if (!Array.isArray(assessments)) {
                return res.status(400).json({ code: 'invalid_assessments' });
            }
            if (assessments.length === 0) {
                return res.status(400).json({ code: 'rate_at_least_one' });
            }

            // Save or update self-assessments. The service REFUSES a rating on a
            // row that has left the employee's hands (returns {skipped:true}); the
            // draft path already reports those, but this path threw them away and
            // answered "submitted" — the browser was told the ratings went through
            // when they had been dropped. Same contract as saveDraftSelfAssessment.
            // State the campaign this submission belongs to (see
            // resolveEmployeeCycle): a locked campaign must refuse, not file the
            // work outside it and then announce "envoyé".
            const cycle = await resolveEmployeeCycle(employeeId);

            const skipped = [];
            for (const assessment of assessments) {
                const r = await SelfAssessmentService.createOrUpdateSelfAssessment(
                    employeeId,
                    parseInt(assessment.skillId),
                    parseInt(assessment.selfRatedLevel),
                    assessment.notes || null,
                    cycle.cycleId
                );
                if (r && r.skipped)
                    skipped.push({ skillId: assessment.skillId, reason: r.reason || r.state });
            }
            // Nothing the employee sent was accepted: refuse, do not submit
            // whatever unrelated drafts happen to exist as if it were this request.
            if (skipped.length === assessments.length) {
                if (cycle.locked && skipped.every((s) => s.reason === 'cycle_changed')) {
                    return res.status(409).json({
                        code: 'cycle_locked',
                        message: lockedCampaignMessage(req, cycle.locked),
                        cycle: {
                            id: Number(cycle.locked.id),
                            label: cycle.locked.label || cycle.locked.code,
                        },
                        skipped,
                    });
                }
                return res.status(409).json({ code: 'not_editable', skipped });
            }

            // Submit all assessments
            await SelfAssessmentService.submitSelfAssessment(employeeId, req);

            res.json({
                success: true,
                message:
                    'Self-assessment submitted successfully. Your supervisor or manager will review it.',
                skipped,
            });
        } catch (error) {
            const { status, code } = mapSelfAssessmentError(error);
            if (status >= 500) console.error('Submit self-assessment error:', error);
            res.status(status).json({ code });
        }
    }

    async saveDraftSelfAssessment(req, res) {
        try {
            const employeeId = req.user.id;
            // The page posts the same {assessments:[{skillId,selfRatedLevel,notes}]}
            // array shape as Submit (it serializes the whole form). Accept that;
            // also tolerate the single-row {skillId,...} shape for back-compat.
            let { assessments } = req.body;
            if (!Array.isArray(assessments)) {
                const { skillId, selfRatedLevel, notes } = req.body;
                assessments =
                    skillId !== undefined && selfRatedLevel !== undefined
                        ? [{ skillId, selfRatedLevel, notes }]
                        : [];
            }
            if (assessments.length === 0) {
                return res.status(400).json({ code: 'nothing_to_save' });
            }

            // The OFFLINE replay states which campaign the work belongs to; the live
            // page does not, so the SERVER states it (resolveEmployeeCycle). Either
            // way the campaign is now named, and a stale or LOCKED one is refused
            // rather than filed into whatever campaign happens to be open — or, as
            // it was until now, into no campaign at all under a green "enregistré".
            const stated =
                req.body.cycleId != null && req.body.cycleId !== ''
                    ? String(req.body.cycleId)
                    : null;
            const cycle = stated
                ? { cycleId: stated, locked: null }
                : await resolveEmployeeCycle(employeeId);
            const expectedCycleId = cycle.cycleId;

            const skipped = [];
            for (const a of assessments) {
                const r = await SelfAssessmentService.createOrUpdateSelfAssessment(
                    employeeId,
                    parseInt(a.skillId),
                    parseInt(a.selfRatedLevel),
                    a.notes || null,
                    expectedCycleId
                );
                if (r && r.skipped)
                    skipped.push({ skillId: a.skillId, reason: r.reason || r.state });
            }

            // Never report a blanket success over rows the server declined: the
            // sync badge turning green on a refused write is the failure mode this
            // whole path exists to avoid.
            if (skipped.length === assessments.length) {
                const payload = {
                    code: skipped[0].reason === 'cycle_changed' ? 'cycle_changed' : 'not_editable',
                    skipped,
                };
                // A LOCKED campaign is not "the campaign moved on" — it is THIS
                // person's campaign, closed. Name it and say so, in their language.
                if (cycle.locked && payload.code === 'cycle_changed') {
                    payload.code = 'cycle_locked';
                    payload.message = lockedCampaignMessage(req, cycle.locked);
                    payload.cycle = {
                        id: Number(cycle.locked.id),
                        label: cycle.locked.label || cycle.locked.code,
                    };
                }
                return res.status(409).json(payload);
            }
            res.json({ success: true, message: 'Draft saved successfully', skipped });
        } catch (error) {
            const { status, code } = mapSelfAssessmentError(error);
            if (status >= 500) console.error('Save draft error:', error);
            res.status(status).json({ code });
        }
    }

    // ---- « Mon développement » --------------------------------------------
    // The plans that concern the signed-in person: their own PIP(s), their own
    // IDP(s) with objectives/actions/sign-off state, and a pointer to their
    // coaching plans.
    //
    // CONFIDENTIALITY (non-negotiable): a PIP is visible to its SUBJECT, but the
    // 9-box placement that may have triggered it is NOT. No query below touches
    // nine_box_evaluations / talent_placements / calibration_*, and no string
    // rendered by this page may carry grid vocabulary (box, tier, label,
    // performance/potential coordinates). The placement→trigger link lives in
    // the audit trail, never in employee-facing prose.
    //
    // IDENTITY: every query is keyed on req.user.id. There is deliberately no
    // :id parameter and no query-string employee id to tamper with.
    async myDevelopment(req, res) {
        const employeeId = req.user.id;
        const locale =
            String(
                (req.getLocale && req.getLocale()) ||
                    req.language ||
                    (res.locals && res.locals.lang) ||
                    'fr'
            )
                .split(/[-_]/)[0]
                .toLowerCase() || 'fr';
        const T = (key, fallback) => (req.t ? req.t(key, { defaultValue: fallback }) : fallback);

        // `date` columns come back as a Date pinned to UTC midnight; formatting
        // them in the server's zone can slide them a day. Force UTC for day-only
        // values. Timestamps (signed_at, created_at) format normally.
        const fmtDay = (v) => {
            if (!v) return null;
            const d = v instanceof Date ? v : new Date(v);
            if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
            try {
                return d.toLocaleDateString(locale, { timeZone: 'UTC' });
            } catch (_) {
                return d.toISOString().slice(0, 10);
            }
        };
        const fmtStamp = (v) => {
            if (!v) return null;
            const d = v instanceof Date ? v : new Date(v);
            if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
            try {
                return d.toLocaleDateString(locale);
            } catch (_) {
                return d.toISOString().slice(0, 10);
            }
        };

        // IDPService.SMART_TEMPLATES emit a literal `<due_date>` / `<date_butoir>`
        // token and idp_objectives.due_on is not written by any generator, so the
        // raw text an employee is asked to sign contains an unsubstituted
        // placeholder. Substitute the real due date when the objective has one,
        // and an honest "to be agreed" phrase when it does not — the employee
        // never sees the template token.
        const DUE_TOKEN = /<\s*(?:due_date|date_butoir)\s*>/gi;
        const resolveSmart = (text, dueOn) => {
            const raw = text == null ? '' : String(text);
            if (!DUE_TOKEN.test(raw)) {
                DUE_TOKEN.lastIndex = 0;
                return raw;
            }
            DUE_TOKEN.lastIndex = 0;
            const label =
                fmtDay(dueOn) || T('employee:dev_idp_due_tbd', 'à convenir avec votre responsable');
            return raw.replace(DUE_TOKEN, label);
        };

        let employee = null;
        let pips = [];
        let idps = [];
        let coaching = { open: 0, total: 0 };
        let loadError = false;
        // 3 — the placement this person has been TOLD about, or null.
        let placement = null;

        try {
            employee = await EmployeeModel.findByIdWithOrganization(employeeId);

            // ---: CONFIDENTIALITY GUARD -----------------------
            // Everything below is read by the SUBJECT of the plan. A PIP summary
            // is free text a manager types, and rows written before the rule
            // still named the 9-box cell: PIP #12 read 'Auto-initiated from 9-box
            // placement "Underperformer" (low performance)…' here while 0 of the
            // 37 placements in the database were disclosed. Migration 115
            // corrected those rows; this guard is what stops the next one.
            //
            // The rule is the arbitration, exactly: the cell may be named ONLY
            // once it has been deliberately disclosed. `redactForSubject` drops
            // the sentence that names it and keeps every other sentence the
            // manager wrote, so the plan still stands on its own reasons.
            // Hidden from employees by the organisation → treated exactly as
            // undisclosed: nothing shown, and the cell is redacted from the prose.
            placement = (await TalentConfidentialityService.nineBoxVisibleToEmployees())
                ? await TalentConfidentialityService.disclosedPlacement(employeeId)
                : null;
            const disclosed = Boolean(placement);
            const neutral = T(
                'employee:dev_pip_summary_neutral',
                'Plan d’amélioration ouvert à la suite d’une revue de performance.'
            );
            const safe = (text, fallback = '') =>
                TalentConfidentialityService.redactForSubject(text, { disclosed, fallback }).text;

            // --- Performance-improvement plans (structured fields, migration 66).
            // pip_state members: proposed|approved|active|closed_success|closed_failure|cancelled.
            const pipRows = await db.all(
                `SELECT id, state, starts_on, ends_on, summary, objectives, success_criteria,
                        review_checkpoints, support_offered, outcome, created_at
                   FROM pips
                  WHERE employee_id = ?
                  ORDER BY (state IN ('proposed','approved','active')) DESC,
                           COALESCE(starts_on, created_at::date) DESC, id DESC`,
                [employeeId]
            );
            pips = pipRows.map((p) => ({
                id: Number(p.id),
                state: p.state,
                isOpen: ['proposed', 'approved', 'active'].includes(p.state),
                startsOn: fmtDay(p.startsOn),
                endsOn: fmtDay(p.endsOn),
                createdAt: fmtStamp(p.createdAt),
                // A summary must never be blank — an empty field reads as "nobody
                // wrote anything", so a fully-redacted one falls back to the
                // neutral sentence. The other fields degrade to '' and the view
                // already renders "non renseigné" for those.
                summary: safe(p.summary || '', neutral),
                objectives: safe(p.objectives || ''),
                successCriteria: safe(p.successCriteria || ''),
                reviewCheckpoints: safe(p.reviewCheckpoints || ''),
                supportOffered: safe(p.supportOffered || ''),
                outcome: safe(p.outcome || ''),
            }));

            // --- Individual development plans + their objectives, actions, signatures.
            const planRows = await db.all(
                `SELECT id, status, priority, starts_on, ends_on, created_at
                   FROM idp_plans
                  WHERE employee_id = ?
                  ORDER BY (status IN ('draft','active')) DESC, created_at DESC, id DESC`,
                [employeeId]
            );

            if (planRows.length) {
                const ids = planRows.map((p) => Number(p.id));
                const marks = ids.map(() => '?').join(',');

                const objRows = await db.all(
                    `SELECT o.id, o.idp_id, o.smart_text, o.due_on, o.priority, o.state,
                            s.name AS skill_name
                       FROM idp_objectives o
                       LEFT JOIN skills s ON s.id = o.skill_id
                      WHERE o.idp_id IN (${marks})
                      ORDER BY o.idp_id, o.id`,
                    ids
                );
                const actRows = await db.all(
                    `SELECT a.id, a.idp_id, a.objective_id, a.type, a.title, a.description,
                            a.status, a.completed_at
                       FROM idp_actions a
                      WHERE a.idp_id IN (${marks})
                      ORDER BY a.idp_id, a.id`,
                    ids
                );
                const signRows = await db.all(
                    `SELECT idp_id, role, signed_at FROM idp_signoffs WHERE idp_id IN (${marks})`,
                    ids
                );

                const byPlan = (rows) =>
                    rows.reduce((m, r) => {
                        const k = Number(r.idpId);
                        (m[k] = m[k] || []).push(r);
                        return m;
                    }, {});
                const objBy = byPlan(objRows);
                const actBy = byPlan(actRows);
                const signBy = byPlan(signRows);

                // The employee may sign their OWN plan: POST /v2/idp/:id/sign is
                // requireAuth + canAccessIdp(own plan → true) and derives the
                // 'employee' slot from the relationship, so this is the ONE write
                // path the service already supports for the subject. It only exists
                // when the V2 routers are mounted; otherwise the page is read-only
                // rather than offering a button that 404s.
                const v2 = process.env.V2_FEATURES === '1';

                idps = planRows.map((p) => {
                    const pid = Number(p.id);
                    const signs = signBy[pid] || [];
                    const mine = signs.find((s) => s.role === 'employee') || null;
                    const theirs = signs.find((s) => s.role === 'supervisor') || null;
                    // 3: the same guard as the PIP fields above —
                    // IDP objective #17 in a test instance read '… (from 9-box
                    // "High Performer")' on the plan its subject is asked to sign.
                    const objectives = (objBy[pid] || []).map((o) => ({
                        id: Number(o.id),
                        smartText: safe(resolveSmart(o.smartText, o.dueOn)),
                        dueOn: fmtDay(o.dueOn),
                        priority: o.priority,
                        state: o.state,
                        skillName: o.skillName || null,
                        isOpen: !['completed', 'cancelled'].includes(o.state),
                    }));
                    const actions = (actBy[pid] || []).map((a) => ({
                        id: Number(a.id),
                        type: a.type,
                        title: safe(a.title || ''),
                        description: safe(a.description || ''),
                        status: a.status,
                        completedAt: fmtDay(a.completedAt),
                        isOpen: !['completed', 'cancelled'].includes(a.status),
                    }));
                    return {
                        id: pid,
                        status: p.status,
                        priority: p.priority,
                        isOpen: ['draft', 'active'].includes(p.status),
                        startsOn: fmtDay(p.startsOn),
                        endsOn: fmtDay(p.endsOn),
                        createdAt: fmtStamp(p.createdAt),
                        objectives,
                        actions,
                        openObjectives: objectives.filter((o) => o.isOpen).length,
                        openActions: actions.filter((a) => a.isOpen).length,
                        signedByMeOn: mine ? fmtStamp(mine.signedAt) : null,
                        signedBySupervisorOn: theirs ? fmtStamp(theirs.signedAt) : null,
                        // Read-only unless the plan is still a draft awaiting my signature.
                        canSign: v2 && p.status === 'draft' && !mine,
                        detailUrl: v2 ? `/v2/idp/${pid}` : null,
                    };
                });
            }

            // --- Coaching pointer only: the plans themselves (and the progress
            // write path) already live on /employee/my-coaching. Counting here
            // avoids duplicating that page.
            const c = await db.get(
                `SELECT COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE state IN ('draft','active'))::int AS open_count
                   FROM coaching_plans WHERE employee_id = ?`,
                [employeeId]
            );
            coaching = {
                open: Number((c && c.openCount) || 0),
                total: Number((c && c.total) || 0),
            };
        } catch (e) {
            loadError = true;
            console.error('My development page error:', e);
        }

        const hasAnything = pips.length > 0 || idps.length > 0 || coaching.total > 0;

        // 3 — a DISCLOSED placement is shown to its subject with the
        // date it was disclosed and the name of whoever disclosed it. Undisclosed,
        // `placement` is null and the page says nothing about the grid at all.
        const disclosedPlacement = placement
            ? {
                  label: placement.boxLabel || null,
                  performance: placement.performance,
                  potential: placement.potential,
                  approvedOn: fmtDay(placement.approvedAt),
                  disclosedOn: fmtStamp(placement.disclosedAt),
                  disclosedBy: placement.authorName || null,
                  reason: placement.disclosureReason || null,
              }
            : null;

        res.render('pages/employee/my-development', {
            title: T('employee:dev_title', 'Mon développement'),
            employee,
            pips,
            idps,
            coaching,
            hasAnything,
            loadError,
            disclosedPlacement,
        });
    }

    // ---- « Mes certifications » -------------------------------------------
    // The landing page for the certification-expiry ladder. cert-expiry.js tells
    // the EMPLOYEE four times (90/60/30 days, then expired) that something is
    // running out — they are the person who must book the revalidation — but the
    // notification pointed at /employee/dashboard, which shows no certification
    // at all. There was no employee-facing certification view anywhere: the only
    // certification surface, /compliance, is manager/manage_compliance-gated.
    //
    // IDENTITY: keyed on req.user.id only. No :id parameter, no query-string
    // employee id, nothing to tamper with (a manager's req.user.id IS their own
    // employee id, so a manager sees their OWN certifications here — the team
    // view stays on /compliance).
    //
    // WINDOW LOGIC: read straight off v_certification_current, so 'expiring'
    // means exactly what the compliance module and the coverage rules mean by it
    // — COALESCE(policy.revalidation_window_days, 90) days before expiry.
    //
    // READ-ONLY: recording or revoking a certification is a verified act
    // (CertificationService.record → VOC sign-off, evidence, AV scan) gated on
    // manage_compliance / the governing manager. No employee-safe write path
    // exists, so none is invented here; the page tells the person who to ask.
    async myCertifications(req, res) {
        const employeeId = req.user.id;
        const locale =
            String(
                (req.getLocale && req.getLocale()) ||
                    req.language ||
                    (res.locals && res.locals.lang) ||
                    'fr'
            )
                .split(/[-_]/)[0]
                .toLowerCase() || 'fr';
        const T = (key, fallback) => (req.t ? req.t(key, { defaultValue: fallback }) : fallback);

        // `date` columns arrive pinned to UTC midnight; format them in UTC so a
        // 31/12 expiry never displays as 30/12 west of Greenwich.
        const fmtDay = (v) => {
            if (!v) return null;
            const d = v instanceof Date ? v : new Date(v);
            if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
            try {
                return d.toLocaleDateString(locale, { timeZone: 'UTC' });
            } catch (_) {
                return d.toISOString().slice(0, 10);
            }
        };

        // Worst first: what has already lapsed, then what lapses soonest.
        const RANK = { expired: 0, expiring: 1, valid: 2, no_expiry: 3 };

        let employee = null;
        let held = []; // every current certification held, worst first
        let required = []; // role requirements that carry a cert policy
        let others = []; // held certs outside the role's requirements
        let counts = { valid: 0, expiring: 0, expired: 0, no_expiry: 0 };
        let contactName = null;
        let refresherCount = 0;
        let loadError = false;

        try {
            employee = await EmployeeModel.findByIdWithOrganization(employeeId);

            // Current (latest non-revoked) certification per skill, with the
            // computed status the whole compliance module agrees on.
            const certRows = await db.all(
                `SELECT cc.certification_id, cc.skill_id, cc.skill_name, cc.cert_number,
                        cc.issued_on, cc.expires_on, cc.days_to_expiry, cc.cert_status,
                        COALESCE(cc.revalidation_window_days, 90) AS window_days
                   FROM v_certification_current cc
                  WHERE cc.employee_id = ?`,
                [employeeId]
            );

            held = certRows
                .map((c) => {
                    const days =
                        c.daysToExpiry === null || c.daysToExpiry === undefined
                            ? null
                            : Number(c.daysToExpiry);
                    return {
                        skillId: Number(c.skillId),
                        skillName: c.skillName,
                        certNumber: c.certNumber || null,
                        issuedOn: fmtDay(c.issuedOn),
                        expiresOn: fmtDay(c.expiresOn),
                        status: c.certStatus,
                        daysToExpiry: days,
                        daysOverdue: days !== null && days < 0 ? Math.abs(days) : null,
                        windowDays: Number(c.windowDays),
                    };
                })
                .sort(
                    (a, b) =>
                        (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) ||
                        (a.daysToExpiry ?? 1e9) - (b.daysToExpiry ?? 1e9) ||
                        String(a.skillName).localeCompare(String(b.skillName))
                );

            for (const c of held) {
                if (counts[c.status] !== undefined) counts[c.status] += 1;
            }

            // What the ROLE requires. This is not a view of the role's skills —
            // it is the subset of them that the compliance programme has declared
            // a certification (skill_certification_policies.is_certification).
            // The role's full skill list is untouched and lives on
            // /employee/self-assessment and /employee/my-progress.
            const reqRows = await db.all(
                `SELECT s.id AS skill_id, s.name AS skill_name,
                        rsr.is_critical, p.validity_months,
                        COALESCE(p.revalidation_window_days, 90) AS window_days
                   FROM employees e
                   JOIN role_skill_requirements rsr ON rsr.role_id = e.role_id
                   JOIN skills s ON s.id = rsr.skill_id
                   JOIN skill_certification_policies p ON p.skill_id = rsr.skill_id
                  WHERE e.id = ? AND p.is_certification = true
                  ORDER BY rsr.is_critical DESC, s.name`,
                [employeeId]
            );

            const heldBySkill = new Map(held.map((c) => [c.skillId, c]));
            required = reqRows
                .map((r) => {
                    const cert = heldBySkill.get(Number(r.skillId)) || null;
                    return {
                        skillId: Number(r.skillId),
                        skillName: r.skillName,
                        isCritical: !!r.isCritical,
                        validityMonths:
                            r.validityMonths === null || r.validityMonths === undefined
                                ? null
                                : Number(r.validityMonths),
                        windowDays: Number(r.windowDays),
                        cert,
                        // 'missing' is its own state: never certified for a
                        // requirement that demands a certificate.
                        status: cert ? cert.status : 'missing',
                    };
                })
                .sort(
                    (a, b) =>
                        (a.status === 'missing' ? -1 : (RANK[a.status] ?? 9)) -
                            (b.status === 'missing' ? -1 : (RANK[b.status] ?? 9)) ||
                        Number(b.isCritical) - Number(a.isCritical) ||
                        String(a.skillName).localeCompare(String(b.skillName))
                );

            const requiredSkillIds = new Set(required.map((r) => r.skillId));
            others = held.filter((c) => !requiredSkillIds.has(c.skillId));

            // Who to ask — the SAME person the expiry job notifies alongside the
            // employee, so the page and the alert never name different people.
            // 3.23.18 R2: the EFFECTIVE reviewer (ReportingLineService) — an
            // inactive supervisor falls back to the manager (employee or admin)
            // instead of naming somebody who has left.
            const mgr = await require('../services/ReportingLineService')
                .effectiveReviewer(employeeId)
                .catch(() => null);
            contactName = mgr && mgr.name ? mgr.name : null;

            // From 60 days the expiry job auto-assigns a refresher course when
            // the skill is mapped to one. Surfacing the count turns "what do I
            // do" into a link the person can actually follow.
            const atRisk = held
                .filter((c) => c.status === 'expiring' || c.status === 'expired')
                .map((c) => c.skillId);
            if (atRisk.length) {
                try {
                    const marks = atRisk.map(() => '?').join(',');
                    const r = await db.get(
                        `SELECT COUNT(DISTINCT en.id)::int AS n
                           FROM lms_enrollments en
                           JOIN course_skill_map m ON m.course_id = en.course_id
                          WHERE en.employee_id = ?
                            AND en.status IN ('assigned', 'in_progress')
                            AND m.skill_id IN (${marks})`,
                        [employeeId, ...atRisk]
                    );
                    refresherCount = Number((r && r.n) || 0);
                } catch (_) {
                    /* LMS optional — the page must not depend on it */
                }
            }
        } catch (e) {
            loadError = true;
            console.error('My certifications page error:', e);
        }

        res.render('pages/employee/my-certifications', {
            title: T('employee:cert_title', 'Mes certifications'),
            employee,
            held,
            required,
            others,
            counts,
            contactName,
            refresherCount,
            hasAnything: held.length > 0 || required.length > 0,
            loadError,
        });
    }

    async viewSupervisorReviews(req, res) {
        try {
            const employeeId = req.user.id;
            const reviews = await SupervisorReviewModel.findByEmployeeId(employeeId);
            const DisputeServiceV2 = require('../services/DisputeServiceV2');
            const disputes = await DisputeServiceV2.listForEmployee(employeeId);

            res.render('pages/employee/supervisor-reviews', {
                title: req.t ? req.t('employee:sr_title') : 'Supervisor Reviews',
                reviews,
                disputes,
            });
        } catch (error) {
            console.error('View supervisor reviews error:', error);
            req.flash(
                'error',
                req.t ? req.t('flash:review_list_load_error') : 'Error loading supervisor reviews'
            );
            res.redirect('/employee/dashboard');
        }
    }

    /**
     * LE DÉPÔT D'UNE CONTESTATION PARLAIT ANGLAIS.
     * ------------------------------------------------------------------
     * `views/pages/employee/supervisor-reviews.ejs:175` affiche `result.error`
     * tel quel dans un toast. Mesuré avant correction, `uat.employee` en session
     * FRANÇAISE (`/lang/fr`), `POST /employee/reviews/1023/dispute` sans motif :
     *     400 {"error":"Dispute reason is required"}
     * — identique en FR et en EN. Trois voisines partaient de même : « Review
     * not found », « Not authorized to dispute this review » et le 500 « Could
     * not submit your dispute. Please try again. ».
     *
     * Le court-circuit de la garde de motif est CONSERVÉ (il évite un aller à la
     * base pour une requête vide) mais il rend désormais la phrase du catalogue,
     * la MÊME que celle du service : le même refus ne se dit pas de deux façons
     * selon qu'il est attrapé tôt ou tard. La FORME de la réponse ne bouge pas
     * (`{error}` / `{success, message}`) : le gabarit qui la lit n'appartient
     * pas à ce lot.
     */
    async disputeReview(req, res) {
        // Une phrase du catalogue, avec la phrase anglaise d'origine en repli si
        // le traducteur n'est pas monté (sonde, tâche) — et jamais l'écho de la
        // clé nue, qui est le défaut P2-17.
        const say = (key, fallback) => {
            if (!req || typeof req.t !== 'function') return fallback;
            const s = req.t(key, { defaultValue: fallback });
            return !s || s === key || s === key.split(':').pop() ? fallback : s;
        };
        try {
            const { reviewId } = req.params;
            const { disputeReason } = req.body;
            const employeeId = req.user.id;

            if (!disputeReason || disputeReason.trim() === '') {
                return res.status(400).json({
                    code: 'DISPUTE_REASON_REQUIRED',
                    error: say(
                        'employee:sr_err_reason_required',
                        'A written reason is required to dispute this review.'
                    ),
                });
            }

            // Ownership guard: an employee may only dispute their OWN review.
            const review = await SupervisorReviewModel.findById(parseInt(reviewId));
            if (!review) {
                return res.status(404).json({
                    code: 'DISPUTE_REVIEW_NOT_FOUND',
                    error: say('employee:sr_err_review_not_found', 'Review not found.'),
                });
            }
            if (Number(review.employeeId) !== Number(employeeId)) {
                return res.status(403).json({
                    code: 'DISPUTE_NOT_OWNER',
                    error: say(
                        'employee:sr_err_not_own_review',
                        'You can only dispute your own reviews.'
                    ),
                });
            }

            const DisputeServiceV2 = require('../services/DisputeServiceV2');
            await DisputeServiceV2.open({
                supervisorReviewId: parseInt(reviewId),
                employeeId,
                reason: disputeReason.trim(),
            });

            res.json({
                success: true,
                message: say(
                    'employee:sr_toast_disputed',
                    'Review disputed — your reviewer will look into it.'
                ),
            });
        } catch (error) {
            // A business-rule refusal from the service (not the owner, review not
            // decided yet / already disputed, no reason) is a clean 4xx with the
            // localized text the page toasts — never a 500.
            const KEYS = {
                DISPUTE_NOT_OWNER: 'employee:sr_err_not_own_review',
                DISPUTE_NOT_DISPUTABLE: 'employee:sr_err_not_disputable',
                DISPUTE_REVIEW_NOT_FOUND: 'employee:sr_err_review_not_found',
                DISPUTE_REVIEW_INVALID: 'employee:sr_err_review_not_found',
                // P2-20, même racine : le service lève ce code AUSSI pour la note
                // de résolution du manager. Sur CE chemin c'est l'employé qui
                // dépose — la phrase est celle du dépôt, jamais celle de la note.
                DISPUTE_REASON_REQUIRED: 'employee:sr_err_reason_required',
            };
            if (
                error &&
                Number.isInteger(error.status) &&
                error.status >= 400 &&
                error.status < 500
            ) {
                const key = KEYS[error.code];
                const msg = key ? say(key, error.message) : error.message;
                return res.status(error.status).json({ error: msg, code: error.code });
            }
            console.error('Dispute review error:', error);
            // Generic message — no raw DB/driver text to the employee.
            res.status(500).json({
                error: say(
                    'employee:sr_err_dispute_failed',
                    'Your dispute could not be recorded. Please try again.'
                ),
            });
        }
    }
}

module.exports = new EmployeePortalController();
