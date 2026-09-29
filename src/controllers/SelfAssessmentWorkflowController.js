'use strict';
/**
 * SelfAssessmentWorkflowController — Phase 2 endpoints.
 * Authorization is enforced inside SelfAssessmentWorkflowService.resolveAuthority
 * (admin inherits supervisor/manager). Handlers translate auth errors to 403.
 */
const svc = require('../services/SelfAssessmentWorkflowService');
// Shared JSON error discipline: domain errors keep their message + status, DB /
// runtime faults become one generic FR sentence + a request id and are logged.
// See utils/apiErrors — the old inline wrapper returned err.message for EVERY
// throw, so raw PostgreSQL text reached the browser.
const { makeHandle, requireId } = require('../utils/apiErrors');

const handle = makeHandle('SelfAssessmentWorkflowController');
/** Route :id → positive integer, or a 400 "identifiant invalide" before any query. */
const id = (req, name = 'id') => requireId(req.params[name], name);

class SelfAssessmentWorkflowController {
    // --- supervisor actions ---
    openReview = handle(async (req) => ({
        assessment: await svc.openReview(id(req), req.user, req),
    }));
    requestChanges = handle(async (req) => ({
        assessment: await svc.requestChanges(id(req), req.user, req.body.comment, req),
    }));
    approve = handle(async (req) => ({
        assessment: await svc.approve(
            id(req),
            req.user,
            req.body.recommendation,
            req,
            // Optional reviewer-entered rating (0–4). When present it is promoted as
            // the official skill level instead of the employee's self-rating.
            req.body.supervisorLevel === undefined ||
                req.body.supervisorLevel === null ||
                req.body.supervisorLevel === ''
                ? null
                : req.body.supervisorLevel
        ),
    }));
    reject = handle(async (req) => ({
        assessment: await svc.reject(id(req), req.user, req.body.reason, req),
    }));

    // --- manager actions ---
    validate = handle(async (req) => ({
        assessment: await svc.managerValidate(id(req), req.user, req),
    }));
    arbitrate = handle(async (req) => ({
        assessment: await svc.arbitrate(
            id(req),
            req.user,
            { outcome: req.body.outcome, note: req.body.note },
            req
        ),
    }));

    // --- employee action ---
    respond = handle(async (req) => ({
        comment: await svc.employeeRespond(
            id(req),
            req.user,
            req.body.body,
            req.body.inReplyTo || null,
            req
        ),
    }));

    // Non-mutating discussion comment (reviewer or employee). Does NOT change state.
    comment = handle(async (req) => ({
        comment: await svc.comment(
            id(req),
            req.user,
            req.body.comment != null ? req.body.comment : req.body.body,
            req
        ),
    }));

    // --- read ---
    thread = handle(async (req) => ({ comments: await svc.getThread(id(req), req.user) }));
    events = handle(async (req) => ({ events: await svc.getEvents(id(req), req.user) }));
    analytics = handle(async (req) => ({ stats: await svc.completionStats(req.user) }));
    // `?cycleId=<id|none>` narrows the queue to one campaign.
    queue = handle(async (req) => ({
        items: await svc.reviewQueue(req.user, { cycleId: req.query.cycleId }),
    }));
    queueByEmployee = handle(async (req) => ({
        employees: await svc.reviewQueueByEmployee(req.user, { cycleId: req.query.cycleId }),
    }));
    bulkApprove = handle(async (req) => ({
        result: await svc.bulkApproveForEmployee(id(req, 'employeeId'), req.user, req),
    }));
    mine = handle(async (req) => ({ items: await svc.listForEmployee(req.user.id) }));
    movement = handle(async (req) => ({
        events: await svc.movementForEmployee(id(req), req.user),
    }));

    // --- pages ---
    // Server-render the reviewer's queue for the SAME reason myStatusPage does it
    // below: the console shipped a page whose only content was "Chargement…", so a
    // browser without (or with a broken) JS showed a reviewer NOTHING — and every
    // refusal behind the JS was invisible. Same contract as the employee screen:
    // best-effort, no cycle filter (the console must never filter itself), and the
    // JS re-renders the same rows on load.
    // On failure `employees` stays NULL, never `[]`: an empty array would render
    // "Rien en attente de votre revue" — an absence of measurement shown as a zero.
    // Null means "the server could not answer", and the view falls back to the JS
    // path, which says what actually went wrong.
    reviewConsolePage = async (req, res) => {
        let employees = null;
        try {
            employees = await svc.reviewQueueByEmployee(req.user, {});
        } catch (_) {
            employees = null;
        }
        res.render('pages/supervisor/self-assessment-review', {
            title: req.t ? req.t('chrome:pt_self_assessment_reviews') : 'Self-Assessment Reviews',
            employees,
        });
    };
    // Server-render the initial rows so the page is usable WITHOUT JS (slow/flaky
    // mine-site browsers) instead of a permanent "Chargement…"; the JS still
    // re-renders on load (idempotent). Best-effort: a data error falls back to the
    // JS-only path rather than failing the page.
    myStatusPage = async (req, res) => {
        let items = [];
        try {
            items = await svc.listForEmployee(req.user.id);
        } catch (_) {
            items = [];
        }
        res.render('pages/employee/assessment-status', {
            title: req.t ? req.t('chrome:pt_my_assessment_status') : 'My Assessment Status',
            items,
        });
    };
}

module.exports = new SelfAssessmentWorkflowController();
