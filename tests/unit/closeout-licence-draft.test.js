'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Closeout lot — (1) the global licence strip, (2) the campaign-less draft.
 *
 * L4-22  `EntitlementService.status().warn` (over seat / expired) was computed but
 *        shown nowhere outside /admin/license. The strip now renders on every
 *        authenticated page — which makes it a site-wide outage risk, so the guard
 *        is tested by EXECUTION: a missing / null / partial `entitlement` must
 *        render nothing at all rather than throw inside the layout.
 *
 * Lot A residual  POST /employee/self-assessment/save-draft answered
 *        200 {"success":true} while the employee's campaign was LOCKED, filing the
 *        rating with cycle_id NULL — work done for a named campaign, recorded
 *        outside it, reported as saved. Measured on idevelop (cycle #9 locked, no open
 *        cycle, employee 138): BEFORE 200 + rows 0→1 with cycle_id NULL;
 *        AFTER 409 {"code":"cycle_locked"} + rows 0→0. The open-campaign save is
 *        unchanged (rolled-back probe: 200, row stamped cycle_id 11).
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

// ---------------------------------------------------------------- (1) licence
describe('L4-22 — the licence strip is guarded so it can never blank a page', () => {
    const layout = read('views/layouts/main.ejs');
    // The banner block only (no includes), so it can be rendered on its own.
    const fragment = (() => {
        const start = layout.indexOf('<% if (typeof entitlement');
        const end = layout.indexOf('<%- body %>');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        return layout.slice(start, end);
    })();

    const render = (locals) =>
        ejs.render(
            fragment,
            Object.assign(
                {
                    __: (key, opts) => `[${key}${opts && opts.brand ? ':' + opts.brand : ''}]`,
                    can: () => false,
                    user: { id: 1, role: 'localadmin' },
                    cspNonce: 'test-nonce',
                },
                locals
            )
        );

    test('nothing is emitted when there is no entitlement at all', () => {
        expect(render({ entitlement: undefined }).trim()).toBe('');
        expect(render({ entitlement: null }).trim()).toBe('');
        expect(render({ entitlement: {} }).trim()).toBe('');
        expect(render({ entitlement: { warn: false, expired: true } }).trim()).toBe('');
    });

    test('an expired licence with NO seat figures renders without inventing numbers', () => {
        const html = render({
            entitlement: {
                warn: true,
                expired: true,
                overSeat: false,
                seats: null,
                seatsUsed: null,
            },
        });
        expect(html).toMatch(/\[admin:lic_banner_expired:IDevelop\]/);
        expect(html).not.toMatch(/null/);
        expect(html).not.toMatch(/\(\s*\/\s*\)/);
        expect(html).toMatch(/class="alert alert-warning lic-banner"/);
    });

    test('an over-seat licence names the measured seats', () => {
        const html = render({
            entitlement: { warn: true, expired: false, overSeat: true, seats: 10, seatsUsed: 76 },
        });
        expect(html).toMatch(/\[admin:lic_banner_overseat\]/);
        expect(html).toMatch(/\(76\/10\)/);
        expect(html).not.toMatch(/lic_banner_expired/);
    });

    test('the manage link is offered only to someone who may manage settings', () => {
        const both = { warn: true, expired: true, overSeat: true, seats: 10, seatsUsed: 76 };
        expect(render({ entitlement: both })).not.toMatch(/\/admin\/license/);
        expect(render({ entitlement: both, can: (s) => s === 'manage_settings' })).toMatch(
            /href="\/admin\/license"/
        );
        expect(render({ entitlement: both, user: { id: 1, role: 'superadmin' } })).toMatch(
            /href="\/admin\/license"/
        );
    });

    test('it is dismissible per distinct problem, for the browser session only', () => {
        const a = render({
            entitlement: { warn: true, expired: true, overSeat: false, seats: 10, seatsUsed: 4 },
        });
        const b = render({
            entitlement: { warn: true, expired: true, overSeat: true, seats: 10, seatsUsed: 76 },
        });
        expect(a).toMatch(/data-lic-sig="x-:4\/10"/);
        expect(b).toMatch(/data-lic-sig="xo:76\/10"/);
        expect(a).toMatch(/id="licBannerClose"/);
        expect(a).toMatch(/aria-label="\[admin:lic_banner_dismiss\]"/);
        // `.alert` sets display:flex, so [hidden] would not hide it: it is removed.
        expect(a).toMatch(/sessionStorage\.setItem\(KEY, sig\)/);
        expect(a).toMatch(/b\.remove\(\);/);
        // Server-rendered visible: a no-JS admin still sees the warning.
        expect(a).not.toMatch(/<div class="alert alert-warning lic-banner"[^>]*\bhidden\b/);
    });

    test('every visible string comes from a key that exists in FR and EN', () => {
        const fr = JSON.parse(read('locales/fr/admin.json'));
        const en = JSON.parse(read('locales/en/admin.json'));
        for (const key of [
            'lic_banner_expired',
            'lic_banner_overseat',
            'lic_banner_manage',
            'lic_banner_dismiss',
        ]) {
            expect(typeof fr[key]).toBe('string');
            expect(typeof en[key]).toBe('string');
            expect(fr[key].length).toBeGreaterThan(0);
        }
        // No hard-coded prose in the layout block itself.
        expect(fragment).not.toMatch(/licence has expired|licencié/i);
    });
});

// ------------------------------------------------------------------ (2) draft
const mockService = { createOrUpdateSelfAssessment: jest.fn(), submitSelfAssessment: jest.fn() };
jest.mock('../../src/services/SelfAssessmentService', () => mockService);
jest.mock('../../src/models/EmployeeModel', () => ({}));
jest.mock('../../src/models/SelfAssessmentModel', () => ({}));
jest.mock('../../src/models/SupervisorReviewModel', () => ({}));
jest.mock('../../src/models/RoleSkillRequirementModel', () => ({}));
jest.mock('../../src/models/SkillAssessmentModel', () => ({}));
jest.mock('../../src/services/ReadinessService', () => ({}));
const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);

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
const req = (body) => ({
    user: { id: 138, userType: 'employee' },
    body,
    t: (key, opts) => `[${key}|${opts && opts.label}|${opts && opts.date}]`,
});
const LOCKED = { id: '9', code: '2026-Q3', label: '2026-Q3', closesAt: '2026-08-31T00:00:00.000Z' };

// The campaign lookup: first call = the open cycle, second = the locked enrolment.
function campaign({ open = undefined, locked = undefined } = {}) {
    mockDb.get.mockReset();
    mockDb.get.mockResolvedValueOnce(open).mockResolvedValueOnce(locked);
}

beforeEach(() => {
    mockService.createOrUpdateSelfAssessment.mockReset().mockResolvedValue({ id: 70 });
    mockService.submitSelfAssessment
        .mockReset()
        .mockResolvedValue({ assessments: [], reviews: [] });
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
});

describe('Lot A residual — a LOCKED campaign refuses the save instead of filing it nowhere', () => {
    test('save-draft: the locked campaign is stated, refused, and NAMED in the reply', async () => {
        campaign({ open: undefined, locked: LOCKED });
        mockService.createOrUpdateSelfAssessment.mockResolvedValue({
            skipped: true,
            reason: 'cycle_changed',
        });
        const r = res();
        await Portal.saveDraftSelfAssessment(
            req({ assessments: [{ skillId: 299, selfRatedLevel: 2 }] }),
            r
        );

        // the campaign travelled with the write — this is the whole fix
        expect(mockService.createOrUpdateSelfAssessment).toHaveBeenCalledWith(
            138,
            299,
            2,
            null,
            '9'
        );
        expect(r.code).toBe(409);
        expect(r.body.code).toBe('cycle_locked');
        // La date est désormais au format français, jamais en ISO : c'est le
        // correctif du constat E-13 (« clôturée le 2026-08-31 » sur une page
        // française, alors que l'écran voisin écrivait déjà 31/08/2026).
        // L'INTENTION de ce test est inchangée : la campagne est NOMMÉE et sa
        // date de clôture est DITE dans la réponse de refus.
        expect(r.body.message).toBe('[employee:sa_no_campaign_last|2026-Q3|31/08/2026]');
        expect(r.body.cycle).toEqual({ id: 9, label: '2026-Q3' });
        expect(r.body.success).toBeUndefined();
    });

    test('save-draft: an OPEN campaign is stated and the save goes through unchanged', async () => {
        campaign({ open: { id: '11' } });
        const r = res();
        await Portal.saveDraftSelfAssessment(
            req({ assessments: [{ skillId: 299, selfRatedLevel: 3, notes: 'x' }] }),
            r
        );
        expect(mockService.createOrUpdateSelfAssessment).toHaveBeenCalledWith(
            138,
            299,
            3,
            'x',
            '11'
        );
        expect(r.code).toBe(200);
        expect(r.body).toEqual({ success: true, message: 'Draft saved successfully', skipped: [] });
    });

    test('save-draft: with NO campaign at all the off-campaign save is still supported', async () => {
        campaign({});
        const r = res();
        await Portal.saveDraftSelfAssessment(
            req({ assessments: [{ skillId: 299, selfRatedLevel: 1 }] }),
            r
        );
        expect(mockService.createOrUpdateSelfAssessment).toHaveBeenCalledWith(
            138,
            299,
            1,
            null,
            null
        );
        expect(r.code).toBe(200);
    });

    test('save-draft: an OFFLINE replay still states its own campaign and is refused as before', async () => {
        campaign({ open: { id: '11' }, locked: LOCKED });
        mockService.createOrUpdateSelfAssessment.mockResolvedValue({
            skipped: true,
            reason: 'cycle_changed',
        });
        const r = res();
        await Portal.saveDraftSelfAssessment(
            req({ cycleId: '8', assessments: [{ skillId: 299, selfRatedLevel: 2 }] }),
            r
        );
        expect(mockService.createOrUpdateSelfAssessment).toHaveBeenCalledWith(
            138,
            299,
            2,
            null,
            '8'
        );
        expect(r.code).toBe(409);
        expect(r.body.code).toBe('cycle_changed');
        expect(r.body.message).toBeUndefined();
    });

    test('save-draft: a refusal that is not about the campaign keeps its own code', async () => {
        campaign({ open: undefined, locked: LOCKED });
        mockService.createOrUpdateSelfAssessment.mockResolvedValue({
            skipped: true,
            state: 'approved',
        });
        const r = res();
        await Portal.saveDraftSelfAssessment(
            req({ assessments: [{ skillId: 299, selfRatedLevel: 2 }] }),
            r
        );
        expect(r.code).toBe(409);
        expect(r.body.code).toBe('not_editable');
    });

    test('save-draft: a failing campaign lookup never takes the save down', async () => {
        mockDb.get
            .mockReset()
            .mockRejectedValue(new Error('relation "assessment_cycles" does not exist'));
        const r = res();
        await Portal.saveDraftSelfAssessment(
            req({ assessments: [{ skillId: 299, selfRatedLevel: 2 }] }),
            r
        );
        expect(mockService.createOrUpdateSelfAssessment).toHaveBeenCalledWith(
            138,
            299,
            2,
            null,
            null
        );
        expect(r.code).toBe(200);
    });

    test('submit: a locked campaign refuses and nothing is submitted', async () => {
        campaign({ open: undefined, locked: LOCKED });
        mockService.createOrUpdateSelfAssessment.mockResolvedValue({
            skipped: true,
            reason: 'cycle_changed',
        });
        const r = res();
        await Portal.submitSelfAssessment(
            req({ assessments: [{ skillId: 299, selfRatedLevel: 2 }] }),
            r
        );
        expect(mockService.createOrUpdateSelfAssessment).toHaveBeenCalledWith(
            138,
            299,
            2,
            null,
            '9'
        );
        expect(r.code).toBe(409);
        expect(r.body.code).toBe('cycle_locked');
        // La date est désormais au format français, jamais en ISO : c'est le
        // correctif du constat E-13 (« clôturée le 2026-08-31 » sur une page
        // française, alors que l'écran voisin écrivait déjà 31/08/2026).
        // L'INTENTION de ce test est inchangée : la campagne est NOMMÉE et sa
        // date de clôture est DITE dans la réponse de refus.
        expect(r.body.message).toBe('[employee:sa_no_campaign_last|2026-Q3|31/08/2026]');
        expect(mockService.submitSelfAssessment).not.toHaveBeenCalled();
    });

    test('submit: an open campaign still submits', async () => {
        campaign({ open: { id: '11' } });
        const r = res();
        await Portal.submitSelfAssessment(
            req({ assessments: [{ skillId: 299, selfRatedLevel: 2 }] }),
            r
        );
        expect(mockService.createOrUpdateSelfAssessment).toHaveBeenCalledWith(
            138,
            299,
            2,
            null,
            '11'
        );
        expect(r.code).toBe(200);
        expect(mockService.submitSelfAssessment).toHaveBeenCalled();
    });
});
