'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Product-readiness committee — LOT PO (employee / manager portal).
 * Driven as test.mgr (employee 137) on idevelop where the only enrolled campaign,
 * 2026-Q3, is LOCKED and no campaign is open.
 *
 *  PO-1  /employee/assessment-status showed the LOCKED campaign as "Campagne en
 *        cours" with a "Continuer" CTA, while a rating saved now is filed with
 *        cycle_id NULL (only an OPEN cycle is resolved) — "0 sur 13" forever.
 *        Now: locked/closed header, explanatory note, no Continue CTA, and the
 *        service prefers an open campaign over a locked one when both exist.
 *  PO-2  /talent/actions "Progression moyenne du coaching" was 0 % with zero
 *        active coachings. Now null → "—" + not-measured.
 *  PO-3  /employee/self-assessment rendered the full form with NO banner when
 *        no campaign is open. Now an explicit "hors campagne" notice naming the
 *        last locked campaign. Decision: ratings are still ACCEPTED (organic
 *        assessment outside a campaign is a supported path) — but said.
 *  PO-4  Employee dashboard first-run copy promised "your readiness will appear
 *        once validated" above a displayed supervisor-measured 90 %. Variant
 *        copy when readiness !== null.
 *  PO-5  /employee/my-progress said "0 campagnes — aucune participation" while
 *        the person was enrolled (not started) in 2026-Q3. Enrolled campaigns
 *        are merged into the history as not started, with NULL measurements.
 *  PO-6  /v2/idp was a bare table header without <title>; /v2/idp/manage, /new
 *        and /v2/pip had no <title>. Dashboard "Mon PDI" → /employee/my-development.
 *  PO-7  /v2/coaching listed sessions where me = subject OR coach (a manager
 *        never saw their reports'), no title/empty state, nothing linked to it.
 *        Removed as a page: it redirects to the real surfaces.
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const viewPath = (p) => path.join(ROOT, 'views', 'pages', p);
const view = (p) => fs.readFileSync(viewPath(p), 'utf8');
// Render WITH the view's own filename. Without it ejs cannot resolve an
// include(), and several pages now pull in views/partials/json-script.ejs (it
// escapes `<` so a reflected value carrying `</script>` cannot break out of an
// inline block). A renderer that cannot follow an include is a harness gap, not
// a defect in the page.
const renderView = (p, data) => ejs.render(view(p), data, { filename: viewPath(p) });
const __ = (key, opts) =>
    opts && (opts.label !== undefined || opts.date !== undefined)
        ? `[${key}|${opts.label}|${opts.date}]`
        : `[${key}]`;
// `colon` est un auxiliaire de vue PARTAGÉ (server.js → res.locals.colon,
// src/utils/colon.js) : la typographie du deux-points suit la langue (A-11).
const baseLocals = {
    __,
    lang: 'fr',
    colon: ' :',
    cspNonce: 'n',
    csrfToken: 'c',
    assetVersion: '1',
    user: { id: 137, firstName: 'Test', username: 'test.mgr' },
};

// ---- shared mocks ----------------------------------------------------------
const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/EmployeeModel', () => ({
    findByIdWithOrganization: jest.fn(),
    findById: jest.fn(),
    governs: jest.fn(),
}));
jest.mock('../../src/services/LogService', () => ({}));
const mockRbac = {
    scopeFilter: jest.fn(),
    isSuperAdmin: jest.fn(),
    getFilteredEmployees: jest.fn(),
    canAccessEmployeeData: jest.fn(),
    canAccessEmployee: jest.fn(),
};
jest.mock('../../src/services/RBACService', () => mockRbac);
jest.mock('../../src/models/SelfAssessmentModel', () => ({ findByEmployeeId: jest.fn() }));
jest.mock('../../src/models/SupervisorReviewModel', () => ({}));
jest.mock('../../src/models/RoleSkillRequirementModel', () => ({ findByRoleId: jest.fn() }));
jest.mock('../../src/models/SkillAssessmentModel', () => ({ findByEmployeeId: jest.fn() }));
jest.mock('../../src/services/ReadinessService', () => ({}));
jest.mock('../../src/services/SelfAssessmentService', () => ({}));
const passThrough = (req, res, next) => next();
jest.mock('../../src/middleware/auth', () => ({
    requireAuth: passThrough,
    requireEmployee: passThrough,
    requireManager: passThrough,
    requireManagerOrAdmin: passThrough,
    requireEmployeeOrManager: passThrough,
}));
jest.mock('../../src/utils/asyncHandler', () => (fn) => fn);
jest.mock('../../src/services/IDPService', () => ({}));
jest.mock('../../src/services/ActionEffectivenessService', () => ({}));
jest.mock('../../src/services/PipService', () => ({ register: jest.fn() }));
jest.mock('../../src/services/CoachingService', () => ({}));

const t = (key, opts) =>
    opts && opts.defaultValue !== undefined && key === '__dv__' ? opts.defaultValue : `[${key}]`;
function res() {
    const r = { code: 200, view: null, locals: null, redirectedTo: null, body: null };
    r.status = (c) => {
        r.code = c;
        return r;
    };
    r.render = (v, l) => {
        r.view = v;
        r.locals = l;
        return r;
    };
    r.redirect = (u) => {
        r.redirectedTo = u;
        return r;
    };
    r.json = (b) => {
        r.body = b;
        return r;
    };
    return r;
}
function handlerOf(router, method, routePath) {
    const layer = router.stack.find(
        (l) => l.route && l.route.path === routePath && l.route.methods[method]
    );
    if (!layer) throw new Error(`no ${method} ${routePath}`);
    const st = layer.route.stack;
    return st[st.length - 1].handle;
}

beforeEach(() => {
    mockDb.get.mockReset();
    mockDb.all.mockReset();
    mockDb.run.mockReset();
    mockRbac.scopeFilter.mockReset().mockResolvedValue({ clause: '', params: [] });
    mockRbac.isSuperAdmin.mockReset().mockReturnValue(false);
    mockRbac.getFilteredEmployees.mockReset().mockResolvedValue([]);
});

// ---- PO-1 -----------------------------------------------------------------
describe('PO-1 — a locked campaign is never "en cours"', () => {
    const Svc = require('../../src/services/SelfAssessmentWorkflowService');

    test('listForEmployee prefers an OPEN campaign over a locked one and exposes is_open', async () => {
        mockDb.all.mockResolvedValue([]);
        mockDb.get.mockResolvedValue({
            cycleId: 9,
            cycleStatus: 'locked',
            isOpen: false,
            expectedSkills: 13,
        });
        const rows = await Svc.listForEmployee(137);
        const sql = mockDb.get.mock.calls[0][0];
        expect(sql).toMatch(/ORDER BY \(c\.status = 'open'\) DESC, c\.closes_at ASC/);
        expect(sql).toMatch(/\(c\.status = 'open'\) AS is_open/);
        expect(sql).toMatch(/c\.status IN \('open', 'locked'\)/);
        expect(rows.campaign).toEqual(
            expect.objectContaining({ cycleStatus: 'locked', isOpen: false })
        );
    });

    const status = (camp) =>
        renderView('employee/assessment-status.ejs', {
            ...baseLocals,
            items: Object.assign([], { campaign: camp }),
        });
    const locked = {
        cycleId: 9,
        cycleCode: '2026-Q3',
        cycleLabel: '2026-Q3',
        closesAt: '2026-08-31',
        cycleStatus: 'locked',
        isOpen: false,
        expectedSkills: 13,
        ratedSkills: 0,
        submittedSkills: 0,
        approvedSkills: 0,
        participantState: 'not_started',
    };

    test('status page: locked → "Campagne verrouillée", note, NO Continue CTA, off-campaign link instead', () => {
        const html = status(locked);
        expect(html).toContain('[employee:loop_campaign_header_locked]');
        expect(html).not.toContain('[employee:loop_campaign_header]');
        expect(html).toContain('[employee:loop_campaign_locked_note]');
        expect(html).not.toContain('[employee:loop_campaign_continue]');
        expect(html).toContain('[employee:loop_campaign_off_campaign_link]');
        expect(html).toMatch(/data-campaign-state="locked"/);
        // The department-designed denominator is still reported in full.
        expect(html).toMatch(/<strong>13<\/strong>/);
    });

    test('status page: closed → "Campagne clôturée" header', () => {
        const html = status({ ...locked, cycleStatus: 'closed' });
        expect(html).toContain('[employee:loop_campaign_header_closed]');
        expect(html).not.toContain('[employee:loop_campaign_continue]');
    });

    test('status page: open → "Campagne en cours" + Continue, no lock note', () => {
        const html = status({
            ...locked,
            cycleStatus: 'open',
            isOpen: true,
            closesAt: '2099-01-01',
        });
        expect(html).toContain('[employee:loop_campaign_header]');
        expect(html).toContain('[employee:loop_campaign_continue]');
        expect(html).not.toContain('[employee:loop_campaign_locked_note]');
        expect(html).toMatch(/data-campaign-state="open"/);
    });

    test('status page: is_open as the pg text "t" still counts as open (compat layer variance)', () => {
        const html = status({
            ...locked,
            cycleStatus: 'open',
            isOpen: 't',
            closesAt: '2099-01-01',
        });
        expect(html).toContain('[employee:loop_campaign_continue]');
    });

    test('status page: no campaign at all → "aucune campagne" sentence, no CTA block', () => {
        const html = status(null);
        expect(html).toContain('[employee:loop_campaign_none]');
        expect(html).not.toContain('[employee:loop_campaign_continue]');
    });
});

// ---- PO-3 -----------------------------------------------------------------
describe('PO-3 — the self-assessment form says when no campaign is open', () => {
    const Portal = require('../../src/controllers/EmployeePortalController');
    const EmployeeModel = require('../../src/models/EmployeeModel');
    const RSR = require('../../src/models/RoleSkillRequirementModel');
    const SAM = require('../../src/models/SelfAssessmentModel');
    const SKA = require('../../src/models/SkillAssessmentModel');
    const req = () => ({ user: { id: 137, userType: 'manager' }, t, flash: jest.fn() });

    beforeEach(() => {
        EmployeeModel.findByIdWithOrganization.mockResolvedValue({
            id: 137,
            roleId: 76,
            roleName: 'R',
        });
        RSR.findByRoleId.mockResolvedValue([{ skillId: 1, skillName: 'S', requiredLevel: 3 }]);
        SAM.findByEmployeeId.mockResolvedValue([]);
        SKA.findByEmployeeId.mockResolvedValue([]);
    });

    test('no open cycle → the controller resolves the last LOCKED enrolment and passes cycle=null', async () => {
        mockDb.get
            .mockResolvedValueOnce(null) // status='open'
            .mockResolvedValueOnce({
                id: 9,
                code: '2026-Q3',
                label: '2026-Q3',
                closesAt: '2026-08-31T00:00:00.000Z',
            });
        const r = res();
        await Portal.selfAssessment(req(), r);
        expect(r.view).toBe('pages/employee/self-assessment');
        expect(r.locals.cycle).toBeNull();
        expect(r.locals.lockedCycle).toEqual(expect.objectContaining({ code: '2026-Q3' }));
        const lockedSql = mockDb.get.mock.calls[1][0];
        expect(lockedSql).toMatch(/status = 'locked'/);
        expect(lockedSql).toMatch(/cycle_participants/);
        expect(mockDb.get.mock.calls[1][1]).toEqual([137]);
    });

    test('an open cycle → no locked lookup at all', async () => {
        mockDb.get.mockResolvedValueOnce({
            id: 20,
            code: 'Q4',
            label: 'Q4',
            closesAt: new Date(Date.now() + 5 * 86400000).toISOString(),
        });
        const r = res();
        await Portal.selfAssessment(req(), r);
        expect(mockDb.get).toHaveBeenCalledTimes(1);
        expect(r.locals.cycle).toEqual(expect.objectContaining({ code: 'Q4' }));
        expect(r.locals.lockedCycle).toBeNull();
    });

    const skills = [
        {
            skillId: 1,
            skillName: 'S',
            domainName: 'D',
            requiredLevel: 3,
            isCritical: false,
            selfRatedLevel: null,
            currentSkillLevel: 0,
            status: 'not_started',
            selfAssessment: null,
        },
    ];
    const form = (extra) =>
        renderView('employee/self-assessment.ejs', {
            ...baseLocals,
            employee: { roleName: 'R' },
            skillsWithAssessments: skills,
            cycle: null,
            lockedCycle: null,
            ...extra,
        });

    // The two situations used to share one notice, and for a LOCKED enrolment that
    // notice made a false promise: it said the ratings would be filed outside the
    // campaign, while the server now REFUSES the save (409 cycle_locked). They are
    // two distinct messages now, so this test asserts the locked one specifically.
    // UPDATED by UAT3 lot D, intent unchanged (the locked notice still names the
    // campaign and its close date). Two deliberate changes it now pins instead:
    //  · E-13 — the date is no longer built in the view with toISOString().slice(0,10)
    //    (« 2026-08-31 » in French prose); the controller passes `closesAtText`;
    //  · E-08 — the banner title is the CAMPAIGN one, not the per-competency lock
    //    sentence (which named no competency and promised the wrong reopening path).
    test('form: locked enrolment → the LOCKED notice, naming the campaign', () => {
        const html = form({
            lockedCycle: {
                code: '2026-Q3',
                label: '2026-Q3',
                closesAt: '2026-08-31T00:00:00.000Z',
                closesAtText: '31/08/2026',
            },
        });
        expect(html).toMatch(/data-campaign="locked"/);
        expect(html).toContain('[employee:sa_locked_campaign_title]');
        expect(html).toContain('[employee:sa_locked_body]');
        expect(html).toContain('[employee:sa_no_campaign_last|2026-Q3|31/08/2026]');
        // It must NOT keep promising an out-of-campaign save that will be refused.
        expect(html).not.toContain('[employee:sa_no_campaign_body]');
        expect(html).toMatch(/id="submitBtn"/);
        expect(html).toMatch(/id="saveDraftBtn"/);
    });

    test('form: cycle=null and no locked enrolment → notice without the "last campaign" sentence', () => {
        const html = form({});
        expect(html).toContain('[employee:sa_no_campaign_title]');
        expect(html).not.toContain('[employee:sa_no_campaign_last');
    });

    test('form: an open cycle → deadline banner, NO no-campaign notice', () => {
        const html = form({ cycle: { label: 'Q4', closesAt: '2099-01-01', daysLeft: 12 } });
        expect(html).not.toMatch(/data-campaign="none"/);
        expect(html).toContain('[employee:sa_deadline_in]');
    });

    test('form: no role skills → empty state, no campaign notice (nothing to file)', () => {
        const html = form({ skillsWithAssessments: [] });
        expect(html).not.toMatch(/data-campaign="none"/);
        expect(html).toContain('[employee:sa_no_skills_title]');
    });
});

// ---- PO-2 -----------------------------------------------------------------
describe('PO-2 — avg coaching progress is NULL when nothing is active', () => {
    const Talent = require('../../src/controllers/TalentActionsController');
    const req = () => ({ user: { id: 137, userType: 'manager' }, t });

    test('zero active coachings → avgProgress null (not 0)', async () => {
        mockDb.all
            .mockResolvedValueOnce([]) // pips
            .mockResolvedValueOnce([]) // idps
            .mockResolvedValueOnce([
                { id: 1, state: 'completed', progress: 100 },
                { id: 2, state: 'cancelled', progress: 0 },
            ]);
        const r = res();
        await Talent.index(req(), r);
        expect(r.view).toBe('pages/talent/actions');
        expect(r.locals.summary.avgProgress).toBeNull();
        expect(r.locals.summary.coachingActive).toBe(0);
    });

    test('active coachings → a real rounded average', async () => {
        mockDb.all
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { id: 1, state: 'active', progress: 30 },
                { id: 2, state: 'active', progress: 50 },
                { id: 3, state: 'completed', progress: 100 },
            ]);
        const r = res();
        await Talent.index(req(), r);
        expect(r.locals.summary.avgProgress).toBe(40);
    });

    const page = (avg) =>
        renderView('talent/actions.ejs', {
            ...baseLocals,
            enumLabel: (s) => s,
            pips: [],
            idps: [],
            coaching: [],
            bias: [],
            summary: {
                pipsTotal: 0,
                pipsActive: 0,
                idpsTotal: 0,
                idpsActive: 0,
                coachingTotal: 0,
                coachingActive: 0,
                avgProgress: avg,
                byContext: { skill_gap: 0, pip: 0, idp: 0 },
            },
            attention: { pipsProposed: 0, idpsDraft: 0, coachingStalled: 0, biasOpen: 0 },
        });

    test('tile renders "—" + not-measured for null, never "0%"', () => {
        const html = page(null);
        expect(html).not.toMatch(/0%\s*<\/div>\s*<div class="ta-l">\[talentx:ta_avg_progress\]/);
        expect(html).toMatch(/—<\/span><\/div><div class="ta-l">\[talentx:ta_avg_progress\]/);
        expect(html).toContain('[dash:rd_not_measured]');
        expect(html).toContain('title="[talentx:ta_avg_progress_none]"');
    });

    test('tile renders the number when measured', () => {
        const html = page(42);
        expect(html).toMatch(/42%<\/div><div class="ta-l">\[talentx:ta_avg_progress\]/);
        expect(html).not.toContain('[talentx:ta_avg_progress_none]');
    });

    test('the "manage" links from the hub point at the TEAM console, not the personal list', () => {
        const html = renderView('talent/actions.ejs', {
            ...baseLocals,
            enumLabel: (s) => s,
            pips: [],
            idps: [],
            coaching: [],
            bias: [],
            summary: {
                pipsTotal: 0,
                pipsActive: 0,
                idpsTotal: 0,
                idpsActive: 0,
                coachingTotal: 0,
                coachingActive: 0,
                avgProgress: null,
                byContext: { skill_gap: 0, pip: 0, idp: 0 },
            },
            attention: { pipsProposed: 0, idpsDraft: 2, coachingStalled: 0, biasOpen: 0 },
        });
        expect(html).toMatch(/href="\/v2\/idp\/manage"/);
        expect(html).not.toMatch(/href="\/v2\/idp"/);
    });
});

// ---- PO-4 -----------------------------------------------------------------
describe('PO-4 — dashboard first-run copy matches a displayed readiness', () => {
    const dash = (readiness) =>
        renderView('employee/dashboard.ejs', {
            ...baseLocals,
            employee: { roleName: 'R', email: 'x@y.z' },
            snapshot: {
                gapRows: [],
                total: 13,
                met: 0,
                gaps: 0,
                unmeasured: 0,
                criticalGaps: 0,
                readiness,
                stateRows: [],
                nineBox: null,
            },
        });

    test('supervisor-measured 90 % → the "already assessed" variant carrying the figure', () => {
        const html = dash(90);
        expect(html).toMatch(/data-firstrun="measured"/);
        expect(html).toContain('[employee:firstrun_measured_title]');
        expect(html).toMatch(
            /\[employee:firstrun_measured_pre\] <strong>90%<\/strong> \[employee:firstrun_measured_mid\] 13 \[employee:firstrun_skill_many\] \[employee:firstrun_measured_post\]/
        );
        expect(html).not.toContain('[employee:firstrun_body_post]');
    });

    test('nothing measured → the original welcome copy', () => {
        const html = dash(null);
        expect(html).toMatch(/data-firstrun="unmeasured"/);
        expect(html).toContain('[employee:firstrun_title]');
        expect(html).toContain('[employee:firstrun_body_post]');
        expect(html).not.toContain('[employee:firstrun_measured_title]');
    });

    test('"Mon PDI" goes to /employee/my-development, never the bare /v2/idp list', () => {
        const html = dash(90);
        expect(html).toMatch(/href="\/employee\/my-development"[^>]*>\[employee:qa_idp_btn\]/);
        expect(html).not.toMatch(/href="\/v2\/idp"/);
    });
});

// ---- PO-5 -----------------------------------------------------------------
describe('PO-5 — my-progress lists enrolled campaigns the person has not started', () => {
    const Progress = require('../../src/controllers/EmployeeProgressController');
    const enrolledRow = {
        cycleId: 9,
        cycleCode: '2026-Q3',
        cycleLabel: '2026-Q3',
        openedAt: new Date('2026-06-01'),
        closesAt: new Date('2026-08-31'),
        cycleStatus: 'locked',
        expectedSkills: 13,
    };
    const routeAll = (cycles, enrolled) =>
        mockDb.all.mockImplementation(async (sql) => {
            if (/v_employee_cycle_progress/.test(sql)) return cycles;
            if (/v_employee_level_timeline/.test(sql)) return [];
            if (/v_cycle_participant_status/.test(sql)) return enrolled;
            throw new Error('unexpected SQL ' + sql);
        });

    test('enrolled, nothing filed → one not-started row with the full expected count and NULL measurements', async () => {
        routeAll([], [enrolledRow]);
        mockDb.get.mockResolvedValue({ id: 137, fullName: 'T M' });
        const r = res();
        await Progress.myPage({ user: { id: 137 }, t }, r);
        expect(r.view).toBe('pages/employees/progress');
        expect(r.locals.selfView).toBe(true);
        expect(r.locals.cycles).toHaveLength(1);
        const c = r.locals.cycles[0];
        expect(c).toEqual(
            expect.objectContaining({
                // Raw status in both fields: the VIEW translates it and appends the
                // "not started" marker from `participation` (no pre-baked label in
                // the JSON API).
                cycleId: 9,
                participation: 'not_started',
                cycleStatusRaw: 'locked',
                cycleStatus: 'locked',
                skillsInCycle: 13,
                unsubmitted: 13,
                approved: 0,
                inReview: 0,
                avgSelfRated: null,
                avgConfirmed: null,
                readinessPct: null,
                netMovement: null,
            })
        );
        const enrolledSql = mockDb.all.mock.calls.find((c0) =>
            /v_cycle_participant_status/.test(c0[0])
        );
        expect(enrolledSql[0]).toMatch(/excluded_at IS NULL/);
        expect(enrolledSql[0]).toMatch(/c\.status <> 'draft'/);
        expect(enrolledSql[1]).toEqual([137]);
    });

    test('a campaign already in the history is NOT duplicated by its enrolment', async () => {
        routeAll(
            [
                {
                    cycleId: 9,
                    cycleCode: '2026-Q3',
                    cycleLabel: '2026-Q3',
                    openedAt: new Date('2026-06-01'),
                    closesAt: new Date('2026-08-31'),
                    cycleStatus: 'locked',
                    skillsInCycle: 13,
                    approved: 13,
                    avgConfirmed: 2.5,
                    readinessPct: 80,
                },
            ],
            [enrolledRow]
        );
        mockDb.get.mockResolvedValue({ id: 137, fullName: 'T M' });
        const r = res();
        await Progress.myPage({ user: { id: 137 }, t }, r);
        expect(r.locals.cycles).toHaveLength(1);
        expect(r.locals.cycles[0].participation).toBe('active');
        expect(r.locals.cycles[0].cycleStatus).toBe('locked');
    });

    test('merged rows are ordered by opened_at and the roster view being absent is survivable', async () => {
        routeAll(
            [
                {
                    cycleId: 2,
                    cycleCode: 'OLD',
                    cycleLabel: 'OLD',
                    openedAt: new Date('2026-01-01'),
                    closesAt: new Date('2026-02-01'),
                    cycleStatus: 'closed',
                    skillsInCycle: 5,
                    approved: 5,
                    avgConfirmed: 2,
                    readinessPct: 50,
                },
            ],
            [enrolledRow]
        );
        mockDb.get.mockResolvedValue({ id: 137, fullName: 'T M' });
        let r = res();
        await Progress.myPage({ user: { id: 137 }, t }, r);
        expect(r.locals.cycles.map((c) => c.cycleId)).toEqual([2, 9]);
        expect(r.locals.cycles[1].deltaAvgConfirmed).toBeNull(); // no measurement → no delta invented

        mockDb.all.mockImplementation(async (sql) => {
            if (/v_cycle_participant_status/.test(sql)) throw new Error('relation does not exist');
            return [];
        });
        r = res();
        await Progress.myPage({ user: { id: 137 }, t }, r);
        expect(r.locals.cycles).toEqual([]);
    });
});

// ---- PO-6 -----------------------------------------------------------------
describe('PO-6 — /v2 development pages carry a title; the personal IDP list has an empty state', () => {
    const idpRouter = require('../../src/routes/v2-idp');
    const pipRouter = require('../../src/routes/v2-pip');

    test('GET /v2/idp (employee side) renders with a title and the plans', async () => {
        mockDb.all.mockResolvedValue([{ id: 5, status: 'draft' }]);
        const r = res();
        await handlerOf(idpRouter, 'get', '/')({ user: { id: 137, userType: 'manager' }, t }, r);
        expect(r.view).toBe('pages/idp/index');
        expect(r.locals.title).toBe('[idp:my_title]');
        expect(r.locals.plans).toEqual([{ id: 5, status: 'draft' }]);
        expect(mockDb.all.mock.calls[0][1]).toEqual([137]);
    });

    test('GET /v2/idp as an admin → the team console, never an empty "my plans"', async () => {
        const r = res();
        await handlerOf(idpRouter, 'get', '/')({ user: { id: 87, userType: 'admin' }, t }, r);
        expect(r.redirectedTo).toBe('/v2/idp/manage');
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('GET /v2/idp/manage and /v2/idp/new render with titles', async () => {
        mockDb.all.mockResolvedValue([]);
        let r = res();
        await handlerOf(
            idpRouter,
            'get',
            '/manage'
        )({ user: { id: 137, userType: 'manager' }, t }, r);
        expect(r.view).toBe('pages/idp/manage');
        expect(r.locals.title).toBe('[idp:manage_heading]');
        r = res();
        await handlerOf(
            idpRouter,
            'get',
            '/new'
        )({ user: { id: 137, userType: 'manager' }, t, query: {} }, r);
        expect(r.view).toBe('pages/idp/new');
        expect(r.locals.title).toBe('[idp:new_heading]');
    });

    test('GET /v2/pip renders with a title', async () => {
        mockDb.all.mockResolvedValue([]);
        const r = res();
        await handlerOf(pipRouter, 'get', '/')({ user: { id: 137, userType: 'manager' }, t }, r);
        expect(r.view).toBe('pages/pip/index');
        expect(r.locals.title).toBe('[pip:title]');
    });

    test('idp/index.ejs: no plans → empty state with a way to "Mon développement"; plans → table', () => {
        const empty = renderView('idp/index.ejs', { ...baseLocals, plans: [] });
        expect(empty).toMatch(/data-empty="idp-mine"/);
        expect(empty).toContain('[idp:my_empty]');
        expect(empty).toMatch(/href="\/employee\/my-development"[^>]*>\[idp:my_empty_link\]/);
        expect(empty).not.toMatch(/<table/);
        const full = renderView('idp/index.ejs', {
            ...baseLocals,
            plans: [{ id: 5, status: 'draft', priority: 'high', cycle_id: null }],
        });
        expect(full).toMatch(/<table/);
        expect(full).toMatch(/href="\/v2\/idp\/5"/);
        expect(full).not.toMatch(/data-empty="idp-mine"/);
        expect(full).toContain('[idp:my_title]');
    });
});

// ---- PO-7 -----------------------------------------------------------------
describe('PO-7 — /v2/coaching is no longer an orphan session list', () => {
    const coachingRouter = require('../../src/routes/v2-coaching');

    test('manager → /coaching/plans (governed scope); employee → /employee/my-coaching; no query', () => {
        const h = handlerOf(coachingRouter, 'get', '/');
        let r = res();
        h({ user: { id: 137, userType: 'manager' } }, r);
        expect(r.redirectedTo).toBe('/coaching/plans');
        r = res();
        h({ user: { id: 136, userType: 'employee' } }, r);
        expect(r.redirectedTo).toBe('/employee/my-coaching');
        expect(mockDb.all).not.toHaveBeenCalled();
    });

    test('the session API endpoints the plans pages use are still mounted', () => {
        const paths = coachingRouter.stack
            .filter((l) => l.route)
            .map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
        expect(paths).toEqual(
            expect.arrayContaining([
                'post /sessions',
                'post /sessions/:id/grow',
                'post /sessions/:id/sign',
                'get /sessions/:id/print',
            ])
        );
    });

    test('nothing in src or views renders or links to the removed list', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'v2-coaching.js'), 'utf8');
        expect(src).not.toContain('pages/coaching/index');
        const walk = (d) =>
            fs
                .readdirSync(d, { withFileTypes: true })
                .flatMap((e) =>
                    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
                );
        const offenders = walk(path.join(ROOT, 'views'))
            .filter((f) => f.endsWith('.ejs'))
            .filter((f) => /href="\/v2\/coaching\/?"/.test(fs.readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });
});

// ---- locale parity ----------------------------------------------------------
describe('locale parity for the keys this lot added', () => {
    const added = {
        employee: [
            'loop_campaign_header_locked',
            'loop_campaign_header_closed',
            'loop_campaign_locked_note',
            'loop_campaign_off_campaign_link',
            'sa_no_campaign_title',
            'sa_no_campaign_body',
            'sa_no_campaign_last',
            'firstrun_measured_title',
            'firstrun_measured_pre',
            'firstrun_measured_mid',
            'firstrun_measured_post',
            'prog_not_started',
        ],
        idp: ['my_title', 'my_empty', 'my_empty_link'],
        talentx: ['ta_avg_progress_none'],
    };
    test.each(Object.entries(added))(
        '%s.json: FR and EN both carry every key, non-empty',
        (ns, keys) => {
            const fr = JSON.parse(
                fs.readFileSync(path.join(ROOT, 'locales', 'fr', `${ns}.json`), 'utf8')
            );
            const en = JSON.parse(
                fs.readFileSync(path.join(ROOT, 'locales', 'en', `${ns}.json`), 'utf8')
            );
            for (const k of keys) {
                expect(typeof fr[k]).toBe('string');
                expect(fr[k].length).toBeGreaterThan(0);
                expect(typeof en[k]).toBe('string');
                expect(en[k].length).toBeGreaterThan(0);
            }
            expect(
                fr.sa_no_campaign_last === undefined ||
                    /\{\{label\}\}.*\{\{date\}\}/.test(fr.sa_no_campaign_last)
            ).toBe(true);
        }
    );
});
