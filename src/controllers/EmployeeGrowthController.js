'use strict';

/**
 * EmployeeGrowthController — the employee-facing "Mon évolution" surface. The
 * mobility, aspirations, survey and recognition FEATURES were fully built with
 * employee-authorized endpoints (v2-capability, requireAuth) but had NO employee
 * UI — their only view was the manager/admin hub. This page finally surfaces them
 * to employees (and gives the recognition/mobility notification deep-links a real
 * destination). Server-rendered so it works without JS on slow mine-site browsers.
 */
const db = require('../config/database');
const Mob = require('../services/MobilityService');
const Rec = require('../services/RecognitionService');
const Sv = require('../services/SurveyService');
const Growth = require('../services/EmployeeGrowthService');

class EmployeeGrowthController {
    async page(req, res) {
        // Admins use the manager capability hub; this is the employee surface.
        if (req.user && req.user.userType === 'admin') return res.redirect('/v2/cap');
        const eid = Number(req.user && req.user.id) || null;

        let opportunities = [];
        let surveys = [];
        let recognition = [];
        let aspirations = null;
        let applications = [];
        let targetGap = null;
        let closest = [];
        let colleagues = [];
        try {
            // Expired postings (closes_on passed) are hidden by the service.
            opportunities = await Mob.listOpportunities('open');
        } catch (_) {
            /* optional */
        }
        try {
            // Only the surveys this person was invited to (the opener's scope).
            surveys = eid ? (await Sv.listOpenForEmployee(eid)) || [] : [];
        } catch (_) {
            /* optional */
        }
        if (eid && surveys.length) {
            // Per-survey "already answered" state (works for anonymous surveys via
            // the pseudonymous key) so the card can show a "Répondu" badge instead
            // of an eternal "Répondre" that silently overwrites.
            for (const s of surveys) {
                try {
                    s.answered = await Sv.hasResponded(s.id, eid, s.anonymous === true);
                } catch (_) {
                    s.answered = false;
                }
            }
        }
        if (eid) {
            try {
                recognition = await Rec.forEmployee(eid, 20);
            } catch (_) {
                /* optional */
            }
            try {
                aspirations = await db.get(
                    `SELECT target_role_id AS "targetRoleId", interests, open_to_mobility AS "openToMobility"
                       FROM employee_aspirations WHERE employee_id = ?`,
                    [eid]
                );
            } catch (_) {
                /* none yet */
            }
            // Every read below is keyed on the signed-in person's own id — no
            // employee id is taken from the request.
            if (aspirations && aspirations.targetRoleId) {
                try {
                    targetGap = await Growth.targetRoleGap(eid);
                } catch (_) {
                    /* optional */
                }
            }
            try {
                closest = await Growth.closestRoles(eid, { limit: 5 });
            } catch (_) {
                /* optional */
            }
            try {
                colleagues = await Rec.colleaguesFor(eid);
            } catch (_) {
                /* optional */
            }
            try {
                // "Which have I applied to" must not count one I withdrew — the
                // withdrawal is a state now, not a deleted row, so the page
                // would keep showing "applied" after the person pulled out.
                const applied = await db.all(
                    "SELECT opportunity_id FROM opportunity_applications WHERE employee_id = ? AND status <> 'withdrawn'",
                    [eid]
                );
                const set = new Set(
                    applied.map((a) => Number(a.opportunityId ?? a.opportunity_id))
                );
                // The card said "applied" forever — even once the poster had
                // accepted or declined. It now carries the application's status.
                applications = (await Mob.applicationsForEmployee(eid)) || [];
                const statusBy = new Map(
                    applications.map((a) => [Number(a.opportunityId ?? a.opportunity_id), a.status])
                );
                opportunities = opportunities.map((o) => ({
                    ...o,
                    applied: set.has(Number(o.id)),
                    applicationStatus: statusBy.get(Number(o.id)) || null,
                }));
            } catch (_) {
                /* ignore */
            }
        }
        const roles = await db.all('SELECT id, name FROM roles ORDER BY name').catch(() => []);

        res.render('pages/employee/opportunities', {
            title: req.t ? req.t('chrome:nav_my_growth') : 'Mon évolution',
            opportunities,
            applications,
            surveys,
            recognition,
            aspirations,
            roles,
            targetGap,
            closest,
            colleagues,
            csrfToken: req.csrfToken ? req.csrfToken() : res.locals && res.locals.csrfToken,
        });
    }
}

module.exports = new EmployeeGrowthController();
