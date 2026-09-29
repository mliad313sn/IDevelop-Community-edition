'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Product-readiness committee — LOT W, employee portal.
 *
 *  F2  EmployeePortalController.submitSelfAssessment discarded the `skipped`
 *      results of createOrUpdateSelfAssessment and answered success:true —
 *      the browser was told "submitted" for ratings the server had dropped
 *      (measured: an approved skill + a fresh one → HTTP 200 {"success":true}
 *      with the approved row untouched). It now reports `skipped` exactly the
 *      way saveDraftSelfAssessment already does, and refuses (409) when nothing
 *      the employee sent was accepted.
 *  F1  disputeReview answers a service refusal (not the owner / not decided
 *      yet) as a clean 4xx with localized text, never a 500.
 */

const mockService = { createOrUpdateSelfAssessment: jest.fn(), submitSelfAssessment: jest.fn() };
jest.mock('../../src/services/SelfAssessmentService', () => mockService);
jest.mock('../../src/models/EmployeeModel', () => ({}));
jest.mock('../../src/models/SelfAssessmentModel', () => ({}));
const mockReviewModel = { findById: jest.fn() };
jest.mock('../../src/models/SupervisorReviewModel', () => mockReviewModel);
jest.mock('../../src/models/RoleSkillRequirementModel', () => ({}));
jest.mock('../../src/models/SkillAssessmentModel', () => ({}));
jest.mock('../../src/services/ReadinessService', () => ({}));
jest.mock('../../src/config/database', () => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() }));
const mockDispute = { open: jest.fn() };
jest.mock('../../src/services/DisputeServiceV2', () => mockDispute);

const Portal = require('../../src/controllers/EmployeePortalController');

function res() {
    const r = { code: 200, body: null };
    r.status = (c) => {
        r.code = c;
        return r;
    };
    r.json = (b) => {
        r.body = b;
        return r;
    };
    return r;
}
const req = (body, extra = {}) => ({
    user: { id: 98, userType: 'employee' },
    body,
    ip: '127.0.0.1',
    get: () => 'jest',
    t: (key, opts) => `[${key}]` + (opts && opts.defaultValue ? '' : ''),
    ...extra,
});

beforeEach(() => {
    mockService.createOrUpdateSelfAssessment.mockReset();
    mockService.submitSelfAssessment
        .mockReset()
        .mockResolvedValue({ assessments: [], reviews: [] });
    mockReviewModel.findById.mockReset();
    mockDispute.open.mockReset();
});

describe('F2 — submit never reports "submitted" over dropped ratings', () => {
    test('everything refused → 409 not_editable with the list, and NO submit', async () => {
        mockService.createOrUpdateSelfAssessment.mockResolvedValue({
            id: 70,
            skipped: true,
            state: 'approved',
        });
        const r = res();
        await Portal.submitSelfAssessment(
            req({
                assessments: [
                    { skillId: 318, selfRatedLevel: 2 },
                    { skillId: 319, selfRatedLevel: 1 },
                ],
            }),
            r
        );
        expect(r.code).toBe(409);
        expect(r.body).toEqual({
            code: 'not_editable',
            skipped: [
                { skillId: 318, reason: 'approved' },
                { skillId: 319, reason: 'approved' },
            ],
        });
        expect(mockService.submitSelfAssessment).not.toHaveBeenCalled();
    });

    test('partly refused → submits the rest and SAYS which rows were dropped', async () => {
        mockService.createOrUpdateSelfAssessment
            .mockResolvedValueOnce({ id: 70, skipped: true, state: 'approved' })
            .mockResolvedValueOnce({ id: 71 });
        const r = res();
        await Portal.submitSelfAssessment(
            req({
                assessments: [
                    { skillId: 318, selfRatedLevel: 2 },
                    { skillId: 319, selfRatedLevel: 1 },
                ],
            }),
            r
        );
        expect(r.code).toBe(200);
        expect(r.body.success).toBe(true);
        expect(r.body.skipped).toEqual([{ skillId: 318, reason: 'approved' }]);
        expect(mockService.submitSelfAssessment).toHaveBeenCalledWith(98, expect.anything());
    });

    test('nothing refused → success with an EMPTY skipped list (the page reads it)', async () => {
        mockService.createOrUpdateSelfAssessment.mockResolvedValue({ id: 71 });
        const r = res();
        await Portal.submitSelfAssessment(
            req({ assessments: [{ skillId: 319, selfRatedLevel: 1 }] }),
            r
        );
        expect(r.code).toBe(200);
        expect(r.body).toEqual(expect.objectContaining({ success: true, skipped: [] }));
    });

    test('a reopened row (new campaign) is accepted, not reported as skipped', async () => {
        mockService.createOrUpdateSelfAssessment.mockResolvedValue({
            id: 70,
            reopened: true,
            fromCycleId: 9,
            cycleId: 11,
        });
        const r = res();
        await Portal.submitSelfAssessment(
            req({ assessments: [{ skillId: 318, selfRatedLevel: 2 }] }),
            r
        );
        expect(r.code).toBe(200);
        expect(r.body.skipped).toEqual([]);
        expect(mockService.submitSelfAssessment).toHaveBeenCalled();
    });

    test('an under_dispute refusal carries its own reason', async () => {
        mockService.createOrUpdateSelfAssessment.mockResolvedValue({
            id: 70,
            skipped: true,
            state: 'reviewed',
            reason: 'under_dispute',
        });
        const r = res();
        await Portal.submitSelfAssessment(
            req({ assessments: [{ skillId: 318, selfRatedLevel: 2 }] }),
            r
        );
        expect(r.code).toBe(409);
        expect(r.body.skipped).toEqual([{ skillId: 318, reason: 'under_dispute' }]);
    });

    test('the input guards come first: no array → 400, empty → 400, nothing saved', async () => {
        let r = res();
        await Portal.submitSelfAssessment(req({ assessments: 'x' }), r);
        expect(r.code).toBe(400);
        expect(r.body).toEqual({ code: 'invalid_assessments' });
        r = res();
        await Portal.submitSelfAssessment(req({ assessments: [] }), r);
        expect(r.code).toBe(400);
        expect(r.body).toEqual({ code: 'rate_at_least_one' });
        expect(mockService.createOrUpdateSelfAssessment).not.toHaveBeenCalled();
    });
});

describe('F1 — disputing a review from the portal answers refusals honestly', () => {
    const refusal = (status, code, message) => Object.assign(new Error(message), { status, code });

    test('the service refusing a non-owner is a 403 with the localized message', async () => {
        mockReviewModel.findById.mockResolvedValue({ id: 974, employeeId: 98 });
        mockDispute.open.mockRejectedValue(
            refusal(403, 'DISPUTE_NOT_OWNER', 'You can only dispute your own review.')
        );
        const r = res();
        await Portal.disputeReview(
            req({ disputeReason: 'unfair' }, { params: { reviewId: '974' } }),
            r
        );
        expect(r.code).toBe(403);
        expect(r.body).toEqual({
            error: '[employee:sr_err_not_own_review]',
            code: 'DISPUTE_NOT_OWNER',
        });
    });

    test('a review that is not decided yet is a 409, not a 500', async () => {
        mockReviewModel.findById.mockResolvedValue({ id: 974, employeeId: 98 });
        mockDispute.open.mockRejectedValue(
            refusal(409, 'DISPUTE_NOT_DISPUTABLE', 'not disputable')
        );
        const r = res();
        await Portal.disputeReview(
            req({ disputeReason: 'unfair' }, { params: { reviewId: '974' } }),
            r
        );
        expect(r.code).toBe(409);
        expect(r.body.error).toBe('[employee:sr_err_not_disputable]');
    });

    test('an unexpected failure is still a generic 500 with no driver text', async () => {
        mockReviewModel.findById.mockResolvedValue({ id: 974, employeeId: 98 });
        mockDispute.open.mockRejectedValue(
            new Error('duplicate key value violates unique constraint "uq_dispute_open_per_review"')
        );
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const r = res();
        await Portal.disputeReview(
            req({ disputeReason: 'unfair' }, { params: { reviewId: '974' } }),
            r
        );
        spy.mockRestore();
        expect(r.code).toBe(500);
        expect(r.body.error).not.toMatch(/uq_dispute_open_per_review/);
    });

    test('the controller-level ownership guard still stands in front of the service', async () => {
        mockReviewModel.findById.mockResolvedValue({ id: 974, employeeId: 12345 });
        const r = res();
        await Portal.disputeReview(
            req({ disputeReason: 'unfair' }, { params: { reviewId: '974' } }),
            r
        );
        expect(r.code).toBe(403);
        expect(mockDispute.open).not.toHaveBeenCalled();
    });
});
