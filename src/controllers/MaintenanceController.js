'use strict';

/**
 * MaintenanceController — the SuperAdmin maintenance panel.
 *
 * Thin on purpose: every rule (SuperAdmin only, reason mandatory, what may still
 * be cancelled) lives in MaintenanceService, so the HTTP layer cannot be the
 * place where a guard is accidentally softened. Refusals raised by the service
 * carry `expose` + a stable code, so they come back as a 400 the UI can
 * translate rather than a 500 with a generic message.
 */

const MaintenanceService = require('../services/MaintenanceService');
const { paramsFrom, csvResponse } = require('../utils/listTools');

/** Service refusals are user-facing; everything else is a real fault. */
function fail(req, res, e) {
    // LE REFUS DE LA PORTE DE CAMPAGNE.
    // Ce refus-là n'a pas de `userMessage` : sa phrase est déjà rédigée par
    // `CycleService.gateMessage` (elle NOMME la campagne et sa date, dans la
    // langue de la session) et son code est `cycle_write_*`. Sans cette branche
    // il retombait sur le `throw` ci-dessous → 500 « nous sommes cassés » pour
    // une réponse qui est « non, et voici pourquoi ». Même enveloppe que
    // `CycleController.fail` : statut honnête, code stable, phrase lisible.
    // La clé i18n `admin:maint_err_*` n'est PAS appliquée ici — la re-passer sur
    // une phrase entière produirait une clé absurde et perdrait le libellé.
    if (e && e.gate && e.status) {
        return res.status(e.status).json({
            ok: false,
            error: e.message,
            code: e.code || null,
            cycle: e.gate.cycle || null,
        });
    }
    if (e && e.expose && e.userMessage) {
        // A legal-hold refusal names who set the hold, when and why.
        const hold = e.hold || null;
        const vars = hold
            ? {
                  by: hold.by || '?',
                  at: hold.at ? new Date(hold.at).toISOString().slice(0, 10) : '?',
                  reason: hold.reason || '—',
              }
            : {};
        const msg = req.t
            ? req.t(`admin:maint_err_${e.userMessage}`, { defaultValue: e.userMessage, ...vars })
            : e.userMessage;
        return res.status(e.status || 400).json({
            ok: false,
            error: msg,
            code: e.userMessage,
            ...(hold ? { hold } : {}),
        });
    }
    throw e;
}

/** Five independent lists share this page, so each carries its OWN page param
 *  (`pPlans`, `pAssess`…). listTools.buildPager only knows `page`, so the same
 *  model is built here around the section's key — every other filter is kept
 *. */
function pagerFor(query, key, { page, total, perPage }) {
    const base = paramsFrom(query, [key]);
    const urlFor = (n) => {
        const qs = new URLSearchParams(base);
        qs.set(key, String(n));
        return `/admin/maintenance?${qs.toString()}#${key}`;
    };
    const totalPages = Math.max(1, Math.ceil((total || 0) / perPage));
    const cur = Math.min(Math.max(1, page), totalPages);
    return {
        key,
        page: cur,
        perPage,
        total: total || 0,
        totalPages,
        from: total ? (cur - 1) * perPage + 1 : 0,
        to: Math.min(total || 0, cur * perPage),
        prevUrl: cur > 1 ? urlFor(cur - 1) : null,
        nextUrl: cur < totalPages ? urlFor(cur + 1) : null,
    };
}

const PER_PAGE = 50;
const pageOf = (query, key) => Math.max(1, parseInt(query[key], 10) || 1);
const str = (v) => (v == null ? '' : String(v).trim());

class MaintenanceController {
    async page(req, res) {
        const q = req.query || {};
        // One search + site filter across every list, one state select per list
        // (the three lists live on different enums — see MaintenanceService).
        const shared = {
            q: str(q.q),
            siteId: str(q.siteId) || null,
            employeeId: str(q.employee) || null,
        };
        const f = {
            plans: {
                ...shared,
                state: str(q.planState) || null,
                planType: str(q.planType) || null,
            },
            assess: { ...shared, state: str(q.assessState) || null },
            place: { ...shared, state: str(q.placeState) || null },
            trail: {
                action: str(q.trailAction) || null,
                actor: str(q.trailActor) || null,
                from: /^\d{4}-\d{2}-\d{2}$/.test(str(q.trailFrom)) ? str(q.trailFrom) : null,
                to: /^\d{4}-\d{2}-\d{2}$/.test(str(q.trailTo)) ? str(q.trailTo) : null,
                employeeId: shared.employeeId,
            },
        };
        const pg = (k) => ({ page: pageOf(q, k), perPage: PER_PAGE });

        const [
            plans,
            cancelledPlans,
            assessments,
            placements,
            cancelledPlacements,
            voided,
            actions,
            candidates,
            sites,
            trailActions,
        ] = await Promise.all([
            MaintenanceService.openPlans(f.plans, pg('pPlans')),
            MaintenanceService.cancelledPlans(shared, pg('pCplans')),
            MaintenanceService.openAssessments(f.assess, pg('pAssess')),
            MaintenanceService.openPlacements(f.place, pg('pPlace')),
            MaintenanceService.cancelledPlacements(shared, pg('pCplace')),
            MaintenanceService.voidedEmployees(shared, pg('pVoid')),
            MaintenanceService.recentActions(f.trail, pg('pTrail')),
            MaintenanceService.candidateEmployees(),
            MaintenanceService.sites(),
            MaintenanceService.trailActions(),
        ]);

        const trailQs = paramsFrom({
            q: shared.q,
            siteId: shared.siteId,
            employee: shared.employeeId,
            trailAction: f.trail.action,
            trailActor: f.trail.actor,
            trailFrom: f.trail.from,
            trailTo: f.trail.to,
        }).toString();

        res.render('pages/admin/maintenance', {
            title: req.t
                ? req.t('admin:maint_title', { defaultValue: 'Maintenance' })
                : 'Maintenance',
            plans: plans.rows,
            plansPager: pagerFor(q, 'pPlans', plans),
            cancelledPlans: cancelledPlans.rows,
            cancelledPlansPager: pagerFor(q, 'pCplans', cancelledPlans),
            assessments: assessments.rows,
            assessmentsPager: pagerFor(q, 'pAssess', assessments),
            placements: placements.rows,
            placementsPager: pagerFor(q, 'pPlace', placements),
            cancelledPlacements: cancelledPlacements.rows,
            cancelledPlacementsPager: pagerFor(q, 'pCplace', cancelledPlacements),
            voided: voided.rows,
            voidedPager: pagerFor(q, 'pVoid', voided),
            actions: actions.rows,
            actionsPager: pagerFor(q, 'pTrail', actions),
            candidates: candidates.rows,
            candidatesTruncated: candidates.truncated,
            sites,
            trailActions,
            filters: {
                ...shared,
                planState: f.plans.state,
                assessState: f.assess.state,
                placeState: f.place.state,
                ...f.trail,
            },
            trailQs,
        });
    }

    /** The filtered trail as CSV — same filters as the screen, capped and said so. */
    async trailExport(req, res) {
        const q = req.query || {};
        const CAP = 5000;
        const f = {
            action: str(q.trailAction) || null,
            actor: str(q.trailActor) || null,
            from: /^\d{4}-\d{2}-\d{2}$/.test(str(q.trailFrom)) ? str(q.trailFrom) : null,
            to: /^\d{4}-\d{2}-\d{2}$/.test(str(q.trailTo)) ? str(q.trailTo) : null,
            employeeId: str(q.employee) || null,
        };
        const rows = await MaintenanceService.trailAll(f, CAP);
        const headers = [
            'id',
            'date_utc',
            'action',
            'actor',
            'actor_ref',
            'employee_id',
            'employee',
            'employee_number',
            'entity_type',
            'entity_id',
            'reason',
            'details',
        ];
        const body = rows.map((r) => [
            r.id,
            r.createdAt ? new Date(r.createdAt).toISOString() : '',
            r.action,
            r.username || '',
            r.actorRef || '',
            r.employeeId != null ? r.employeeId : '',
            r.employeeName || '',
            r.employeeNumber || '',
            r.entityType || '',
            r.entityId != null ? r.entityId : '',
            r.reason || '',
            r.details || '',
        ]);
        const stamp = [f.from || 'debut', f.to || new Date().toISOString().slice(0, 10)].join('-');
        return csvResponse(res, `maintenance-trail-${stamp}.csv`, headers, body);
    }

    /** "Rétablir" a plan cancelled by this panel. */
    async restorePlan(req, res) {
        try {
            const out = await MaintenanceService.restorePlan(
                req.user,
                {
                    entityType: req.body.entityType,
                    entityId: req.body.entityId,
                    reason: req.body.reason,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    /** "Rétablir" a 9-box position archived by this panel. */
    async restorePlacement(req, res) {
        try {
            const out = await MaintenanceService.restorePlacement(
                req.user,
                {
                    evaluationId: req.body.evaluationId,
                    reason: req.body.reason,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    async cancelPlan(req, res) {
        try {
            const out = await MaintenanceService.cancelPlan(
                req.user,
                {
                    entityType: req.body.entityType,
                    entityId: req.body.entityId,
                    reason: req.body.reason,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    async cancelAssessment(req, res) {
        try {
            const out = await MaintenanceService.cancelAssessment(
                req.user,
                {
                    assessmentId: req.body.assessmentId,
                    reason: req.body.reason,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    async reopenAssessment(req, res) {
        try {
            const out = await MaintenanceService.reopenAssessment(
                req.user,
                {
                    assessmentId: req.body.assessmentId,
                    reason: req.body.reason,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    async withdrawReview(req, res) {
        try {
            const out = await MaintenanceService.withdrawReview(
                req.user,
                {
                    assessmentId: req.body.assessmentId,
                    reason: req.body.reason,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    async cancelPlacement(req, res) {
        try {
            const out = await MaintenanceService.cancelPlacement(
                req.user,
                {
                    evaluationId: req.body.evaluationId,
                    reason: req.body.reason,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    async voidEmployee(req, res) {
        try {
            const out = await MaintenanceService.voidEmployee(
                req.user,
                {
                    employeeId: req.body.employeeId,
                    reason: req.body.reason,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    async restoreEmployee(req, res) {
        try {
            const out = await MaintenanceService.restoreEmployee(
                req.user,
                {
                    employeeId: req.body.employeeId,
                    reason: req.body.reason,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    // ---- SECTION accounts — GDPR export / erase --------------------------------
    async dsrExport(req, res) {
        try {
            const data = await MaintenanceService.dsrExport(
                req.user,
                { employeeId: req.params.id },
                req
            );
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="dsr-export-${Number(req.params.id)}.json"`
            );
            res.setHeader('Cache-Control', 'no-store');
            res.json(data);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    async dsrErase(req, res) {
        try {
            const out = await MaintenanceService.dsrErase(
                req.user,
                {
                    employeeId: req.body.employeeId,
                    reason: req.body.reason,
                    confirmNumber: req.body.confirmNumber,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    // ---- Erasure under legal hold: two-person override (migration 166) ---------
    /** Is the person under legal hold, and is an override possible? (erase dialog) */
    async dsrEraseStatus(req, res) {
        try {
            const out = await MaintenanceService.dsrEraseStatus(req.user, {
                employeeId: req.params.id,
            });
            res.setHeader('Cache-Control', 'no-store');
            res.json({ ok: true, ...out });
        } catch (e) {
            return fail(req, res, e);
        }
    }

    /** Pending override requests, for the panel. */
    async dsrOverrideList(req, res) {
        try {
            const rows = await MaintenanceService.dsrOverrideList(req.user);
            res.setHeader('Cache-Control', 'no-store');
            res.json({ ok: true, rows: rows || [] });
        } catch (e) {
            return fail(req, res, e);
        }
    }

    /** Step 1: request the erasure of a held person (reason + number retyped). */
    async dsrOverrideRequest(req, res) {
        try {
            const out = await MaintenanceService.dsrOverrideRequest(
                req.user,
                {
                    employeeId: req.body.employeeId,
                    reason: req.body.reason,
                    confirmNumber: req.body.confirmNumber,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }

    /** Step 2: another SuperAdmin approves / refuses; the requester withdraws. */
    async dsrOverrideDecide(req, res) {
        try {
            const out = await MaintenanceService.dsrOverrideDecide(
                req.user,
                {
                    requestId: req.params.rid,
                    approve: req.body.approve,
                    note: req.body.note,
                },
                req
            );
            res.json(out);
        } catch (e) {
            return fail(req, res, e);
        }
    }
    // ---- end SECTION accounts -----------------------------------------------------------
}

module.exports = new MaintenanceController();
