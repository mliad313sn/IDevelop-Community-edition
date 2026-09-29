'use strict';
/**
 * 3.23.17 — lane F-talent-modules, service layer (mocked database).
 *
 * Mobility: the "new opportunity" ping went to every aspiration row (leavers
 * and people outside the poster's scope included); closes_on was ignored; an
 * opportunity could never be closed or filled; the poster could not list the
 * applicants; a decline carried no reason.
 * Surveys: minResponses could be 1; open() had no state guard and invited the
 * whole organisation; text answers were never returned.
 * DEI: free text stored and later rendered as HTML.
 * Retention: NPS 0-10 averaged with 1-5 scale answers, anonymous surveys read.
 * OKR: a key result reaching its target stayed "active".
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runTransaction: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
const mockNotify = {
    notify: jest.fn().mockResolvedValue(undefined),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../../src/services/NotificationService', () => mockNotify);
jest.mock('../../src/services/SkillsIntelligenceService', () => ({
    adjacent: jest.fn().mockResolvedValue([]),
}));

const Mobility = require('../../src/services/MobilityService');
const Survey = require('../../src/services/SurveyService');
const DEI = require('../../src/services/DEIService');
const { GoalsRepository } = require('../../src/api/v1/repository');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.get.mockResolvedValue(null);
    mockDb.all.mockResolvedValue([]);
    mockDb.run.mockResolvedValue({ changes: 1 });
    mockDb.runTransaction.mockImplementation(async (fn) => fn());
});

const sqlCalls = (fn) => fn.mock.calls.map((c) => String(c[0]));

// ─────────────────────────────── Mobility ───────────────────────────────
describe('mobility — new-opportunity notification pool', () => {
    test('without a scope pool nobody is notified and no population is read', async () => {
        await Mobility._notifyMatched({ id: 7 }, null);
        expect(mockDb.all).not.toHaveBeenCalled();
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });

    test('the pool is the poster scope ∩ active ∩ open-to-mobility', async () => {
        mockDb.all.mockResolvedValueOnce([]); // aspirations query → nobody
        await Mobility._notifyMatched({ id: 7 }, [11, 12]);
        const [sql, params] = mockDb.all.mock.calls[0];
        expect(params).toEqual([11, 12]);
        expect(String(sql)).toMatch(/e\.is_active = true/);
        expect(String(sql)).toMatch(/a\.employee_id IN \(\?,\?\)/);
        expect(mockNotify.notify).not.toHaveBeenCalled();
    });

    test('postOpportunity hands the pool through (fire-and-forget)', async () => {
        const spy = jest.spyOn(Mobility, '_notifyMatched').mockResolvedValue(undefined);
        mockDb.get.mockResolvedValueOnce({ id: 3 });
        await Mobility.postOpportunity({ title: 'T', audiencePool: [5] });
        expect(spy).toHaveBeenCalledWith({ id: 3 }, [5]);
        spy.mockRestore();
    });
});

describe('mobility — closing date, close/fill, applicants, decisions', () => {
    test('the marketplace listing hides postings past their closing date', async () => {
        await Mobility.listOpportunities('open');
        expect(String(mockDb.all.mock.calls[0][0])).toMatch(
            /o\.closes_on IS NULL OR o\.closes_on >= CURRENT_DATE/
        );
        await Mobility.listOpportunities('open', { includeExpired: true });
        expect(String(mockDb.all.mock.calls[1][0])).not.toMatch(/closes_on >= CURRENT_DATE/);
    });

    test('a console filter with nothing to see through lists nothing', async () => {
        await Mobility.listOpportunities('open', { visibleTo: {} });
        expect(String(mockDb.all.mock.calls[0][0])).toMatch(/AND false/);
    });

    test('apply is refused after the closing date, with no application filed', async () => {
        mockDb.get.mockResolvedValueOnce({ state: 'open', expired: true });
        await expect(Mobility.apply(5, 42, null)).rejects.toMatchObject({
            status: 409,
            code: 'opportunity_expired',
        });
        expect(
            sqlCalls(mockDb.get).some((s) => /INSERT INTO opportunity_applications/.test(s))
        ).toBe(false);
    });

    test('apply on an open, in-date posting still files the application', async () => {
        mockDb.get.mockImplementation(async (sql) =>
            /FROM opportunities\s+WHERE id|FROM opportunities WHERE id/.test(sql)
                ? { state: 'open', expired: false }
                : { id: 1 }
        );
        await Mobility.apply(5, 42, null);
        expect(
            sqlCalls(mockDb.get).some((s) => /INSERT INTO opportunity_applications/.test(s))
        ).toBe(true);
    });

    test('close/fill needs a valid state and a reason, and only moves an OPEN posting', async () => {
        await expect(
            Mobility.setOpportunityState(1, { state: 'deleted', reason: 'x' })
        ).rejects.toMatchObject({ status: 400, code: 'invalid_state' });
        await expect(
            Mobility.setOpportunityState(1, { state: 'filled', reason: '  ' })
        ).rejects.toMatchObject({ status: 400, code: 'reason_required' });
        expect(mockDb.get).not.toHaveBeenCalled();
        mockDb.get.mockResolvedValueOnce(null); // not open any more
        await expect(
            Mobility.setOpportunityState(1, { state: 'closed', reason: 'budget' })
        ).rejects.toMatchObject({ status: 409 });
        mockDb.get.mockResolvedValueOnce({ id: 1, state: 'filled' });
        const r = await Mobility.setOpportunityState(1, {
            state: 'filled',
            reason: ' Awa retenue ',
            employeeId: 9,
        });
        expect(r).toEqual({ ok: true, id: 1, state: 'filled' });
        const [sql, params] = mockDb.get.mock.calls[1];
        expect(String(sql)).toMatch(/WHERE id = \? AND state = 'open'/);
        expect(params).toEqual(['filled', 'Awa retenue', null, 9, 1]);
    });

    test('a decline without a reason is refused before any write', async () => {
        await expect(
            Mobility.decideApplication(3, { decision: 'declined', note: ' ' })
        ).rejects.toMatchObject({ status: 400, code: 'reason_required' });
        expect(mockDb.get).not.toHaveBeenCalled();
    });

    test('the applicant is sent to the page that now shows the outcome', async () => {
        mockDb.get.mockResolvedValueOnce({ id: 3, employeeId: 42 });
        await Mobility.decideApplication(3, { decision: 'declined', note: 'Profil trop junior' });
        expect(mockNotify.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 42,
                payload: { link: '/employee/opportunities#my-applications' },
            })
        );
    });

    test('applicants: names, status, and a fit that is null — not 0 — when unmeasurable', async () => {
        mockDb.all.mockResolvedValueOnce([
            {
                id: 1,
                employeeId: 42,
                status: 'applied',
                firstName: 'Awa',
                lastName: 'Diop',
                createdAt: '2026-09-01',
            },
        ]);
        mockDb.get.mockResolvedValueOnce({ skillsSought: [] }); // matchCandidates → no skills sought
        const list = await Mobility.listApplicants(5);
        expect(list).toEqual([
            expect.objectContaining({
                id: 1,
                employeeId: 42,
                name: 'Awa Diop',
                status: 'applied',
                fitPct: null,
            }),
        ]);
    });

    test('applicants limited to a scope return nothing for an empty scope', async () => {
        expect(await Mobility.listApplicants(5, { scopeIds: [] })).toEqual([]);
        expect(mockDb.all).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────── Surveys ───────────────────────────────
describe('surveys — creation', () => {
    test('the anonymity threshold is clamped to at least 5', async () => {
        mockDb.get.mockResolvedValueOnce({ id: 1 });
        await Survey.create({
            title: 'Pulse',
            minResponses: 1,
            questions: [{ text: 'Q', qtype: 'scale' }],
        });
        expect(mockDb.get.mock.calls[0][1][3]).toBe(5);
    });

    test('a survey without questions, or with an unknown type, is refused', async () => {
        await expect(Survey.create({ title: 'x', questions: [] })).rejects.toMatchObject({
            status: 400,
            code: 'survey_questions_required',
        });
        await expect(
            Survey.create({ title: 'x', questions: [{ text: 'a', qtype: 'essay' }] })
        ).rejects.toMatchObject({ status: 400, code: 'survey_question_type_invalid' });
        await expect(
            Survey.create({ title: ' ', questions: [{ text: 'a' }] })
        ).rejects.toMatchObject({ status: 400, code: 'survey_title_required' });
        expect(mockDb.get).not.toHaveBeenCalled();
    });
});

describe('surveys — state machine and audience', () => {
    test('open() refuses anything but a draft, and invites nobody', async () => {
        mockDb.get.mockResolvedValueOnce(null);
        await expect(Survey.open(4, { audienceIds: [1, 2] })).rejects.toMatchObject({
            status: 409,
            code: 'survey_not_draft',
        });
        expect(mockNotify.enqueueBulkInApp).not.toHaveBeenCalled();
    });

    test('open() invites the given audience only — never every active employee', async () => {
        mockDb.get.mockResolvedValueOnce({ id: 4 });
        mockDb.all.mockResolvedValueOnce([{ employeeId: 1 }, { employeeId: 2 }]);
        const r = await Survey.open(4, { audienceIds: [1, 2, 2] });
        expect(r).toEqual({ ok: true, invited: 2 });
        expect(
            sqlCalls(mockDb.all).some((s) =>
                /SELECT id FROM employees WHERE is_active = true/.test(s)
            )
        ).toBe(false);
        expect(mockDb.all.mock.calls[0][1]).toEqual([4, 1, 2]);
        expect(mockNotify.enqueueBulkInApp).toHaveBeenCalledWith(
            expect.objectContaining({ userIds: [1, 2] })
        );
    });

    test('close() only closes an open survey', async () => {
        mockDb.get.mockResolvedValueOnce(null);
        await expect(Survey.close(4)).rejects.toMatchObject({
            status: 409,
            code: 'survey_not_open',
        });
        mockDb.get.mockResolvedValueOnce({ id: 4 });
        await expect(Survey.close(4)).resolves.toEqual({ ok: true });
        expect(String(mockDb.get.mock.calls[1][0])).toMatch(/WHERE id=\? AND state='open'/);
    });

    test('a person outside the audience cannot respond', async () => {
        mockDb.get
            .mockResolvedValueOnce({ id: 4, state: 'open', anonymous: true }) // survey
            .mockResolvedValueOnce({ audienceScoped: true }) // isInAudience: survey
            .mockResolvedValueOnce(null); // not invited
        await expect(Survey.respond(4, 99, [{ questionId: 1, score: 3 }])).rejects.toMatchObject({
            status: 403,
            code: 'survey_not_in_audience',
        });
        expect(mockDb.run).not.toHaveBeenCalled();
    });

    test('a legacy survey (opened before audiences existed) stays open to everyone', async () => {
        mockDb.get.mockResolvedValueOnce({ audienceScoped: false });
        expect(await Survey.isInAudience(4, 99)).toBe(true);
    });

    test('owner check: SuperAdmin, creating admin, creating manager — nobody else', () => {
        const s = { createdByAdminId: 7, actorEmployeeId: null };
        expect(Survey.canManage({ userType: 'admin', role: 'superadmin', id: 1 }, s)).toBe(true);
        expect(Survey.canManage({ userType: 'admin', role: 'localadmin', id: 7 }, s)).toBe(true);
        expect(Survey.canManage({ userType: 'admin', role: 'localadmin', id: 8 }, s)).toBe(false);
        expect(Survey.canManage({ userType: 'manager', id: 7 }, s)).toBe(false);
        expect(Survey.canManage({ userType: 'manager', id: 30 }, { actorEmployeeId: 30 })).toBe(
            true
        );
    });
});

describe('surveys — results', () => {
    test('a stored threshold of 1 is lifted to 5 at read time', async () => {
        mockDb.get.mockResolvedValueOnce({ minResponses: 1 });
        mockDb.all.mockResolvedValueOnce([
            { questionId: 1, text: 'Q', qtype: 'scale', responses: 3, avgScore: 4 },
        ]);
        const r = await Survey.results(4);
        expect(r[0]).toMatchObject({ suppressed: true, responses: 3 });
        expect(r[0].avgScore).toBeUndefined();
    });

    test('text answers are returned at the threshold — bare, sorted, unattributed', async () => {
        mockDb.get.mockResolvedValueOnce({ minResponses: 5 });
        mockDb.all
            .mockResolvedValueOnce([
                { questionId: 2, text: 'Un mot ?', qtype: 'text', responses: 5, avgScore: null },
            ])
            .mockResolvedValueOnce(
                ['zèbre', 'avion', 'moto', 'bus', 'train'].map((t) => ({ textAnswer: t }))
            );
        const r = await Survey.results(4);
        expect(r[0].answers).toEqual(['avion', 'bus', 'moto', 'train', 'zèbre']);
        expect(String(mockDb.all.mock.calls[1][0])).not.toMatch(
            /employee_id|respondent_key|created_at/
        );
    });

    test('below the threshold a text question returns no answers', async () => {
        mockDb.get.mockResolvedValueOnce({ minResponses: 5 });
        mockDb.all.mockResolvedValueOnce([
            { questionId: 2, text: 'Un mot ?', qtype: 'text', responses: 4 },
        ]);
        const r = await Survey.results(4);
        expect(r[0].suppressed).toBe(true);
        expect(r[0].answers).toBeUndefined();
        expect(mockDb.all).toHaveBeenCalledTimes(1);
    });
});

// ─────────────────────────────── DEI ───────────────────────────────
describe('DEI — declared labels are validated before storage', () => {
    test.each(['<img src=x onerror=alert(1)>', '"><script>x</script>', 'a'.repeat(65)])(
        'refuses %s',
        async (bad) => {
            await expect(DEI.setDemographics(1, { gender: bad })).rejects.toMatchObject({
                status: 400,
                code: 'dei_invalid_gender',
            });
            expect(mockDb.get).not.toHaveBeenCalled();
        }
    );

    test('accepts ordinary labels in any script', async () => {
        mockDb.get.mockResolvedValue({ employeeId: 1 });
        await DEI.setDemographics(1, {
            gender: 'Femme',
            ageBand: '36-45',
            nationality: 'Sénégalaise',
            ethnicity: 'Peul (Fulani)',
        });
        const params = mockDb.get.mock.calls[0][1];
        expect(params.slice(1, 4)).toEqual(['Femme', 'Peul (Fulani)', '36-45']);
        expect(params[5]).toBe('Sénégalaise');
    });
});

// ─────────────────────────────── OKR ───────────────────────────────
describe('OKR — a key result reaching its target completes itself', () => {
    const lastUpdate = () =>
        mockDb.run.mock.calls.map((c) => c).find((c) => /UPDATE goals/.test(String(c[0])));

    test('KR at/over target, no explicit status → done', async () => {
        mockDb.get.mockResolvedValueOnce({ kind: 'key_result', targetValue: 10, status: 'active' });
        await GoalsRepository.updateProgress(5, 12);
        expect(lastUpdate()[1]).toEqual([12, 'done', 5]);
    });

    test('below target, an objective, a zero target, a cancelled KR or an explicit status are left alone', async () => {
        mockDb.get.mockResolvedValueOnce({ kind: 'key_result', targetValue: 10, status: 'active' });
        await GoalsRepository.updateProgress(5, 9);
        expect(lastUpdate()[1]).toEqual([9, 5]);
        mockDb.run.mockClear();
        mockDb.get.mockResolvedValueOnce({ kind: 'objective', targetValue: 10, status: 'active' });
        await GoalsRepository.updateProgress(5, 12);
        expect(lastUpdate()[1]).toEqual([12, 5]);
        mockDb.run.mockClear();
        mockDb.get.mockResolvedValueOnce({ kind: 'key_result', targetValue: 0, status: 'active' });
        await GoalsRepository.updateProgress(5, 3);
        expect(lastUpdate()[1]).toEqual([3, 5]);
        mockDb.run.mockClear();
        mockDb.get.mockResolvedValueOnce({
            kind: 'key_result',
            targetValue: 10,
            status: 'cancelled',
        });
        await GoalsRepository.updateProgress(5, 12);
        expect(lastUpdate()[1]).toEqual([12, 5]);
        mockDb.run.mockClear();
        await GoalsRepository.updateProgress(5, 12, 'at_risk');
        expect(lastUpdate()[1]).toEqual([12, 'at_risk', 5]);
    });
});
