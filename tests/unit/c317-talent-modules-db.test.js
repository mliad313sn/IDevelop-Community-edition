'use strict';
/**
 * 3.23.17 — lane F-talent-modules, executed on idevelop_fixtures.
 *
 * Every scenario runs inside ONE transaction that also applies migration 147
 * (idempotent DDL) and is rolled back: nothing persists, and the SQL the
 * services now emit is proven against the real schema — not a mock.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = !!process.env.DATABASE_URL && /idevelop_fixtures/.test(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;
jest.setTimeout(60000);

const db = HAS_DB ? require('../../src/config/database') : null;
jest.mock('../../src/services/NotificationService', () => ({
    notify: jest.fn().mockResolvedValue(undefined),
    enqueueBulkInApp: jest.fn().mockResolvedValue(undefined),
}));
const Survey = HAS_DB ? require('../../src/services/SurveyService') : null;
const Mobility = HAS_DB ? require('../../src/services/MobilityService') : null;
const Retention = HAS_DB ? require('../../src/services/RetentionRiskService') : null;
const MIG = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/147_talent_modules_state.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

/** Run fn inside a transaction with migration 147 applied, then roll back. */
async function inRolledBackTx(fn) {
    try {
        await db.runTransaction(async () => {
            await db._txStore.getStore().query(MIG);
            await fn();
            throw new Error('__ROLLBACK__');
        });
    } catch (err) {
        if (!String(err.message).includes('__ROLLBACK__')) throw err;
    }
}

suite('talent modules on the real schema (rolled back)', () => {
    test('survey: draft → open (audience frozen) → closed; outsiders refused; threshold ≥ 5', async () => {
        await inRolledBackTx(async () => {
            const emps = await db.all(
                'SELECT id FROM employees WHERE is_active = true ORDER BY id LIMIT 3'
            );
            expect(emps.length).toBe(3);
            const [inA, inB, outC] = emps.map((e) => Number(e.id));
            const s = await Survey.create({
                title: 'Probe',
                minResponses: 1,
                anonymous: true,
                questions: [
                    { text: 'Q1', qtype: 'scale' },
                    { text: 'Q2', qtype: 'text' },
                ],
            });
            expect(Number(s.minResponses)).toBe(5);
            const opened = await Survey.open(s.id, { audienceIds: [inA, inB] });
            expect(opened.invited).toBe(2);
            await expect(Survey.open(s.id, { audienceIds: [inA] })).rejects.toMatchObject({
                code: 'survey_not_draft',
            });

            const forA = await Survey.listOpenForEmployee(inA);
            const forC = await Survey.listOpenForEmployee(outC);
            expect(forA.map((x) => Number(x.id))).toContain(Number(s.id));
            expect(forC.map((x) => Number(x.id))).not.toContain(Number(s.id));

            const qs = await Survey.questions(s.id);
            const q1 = Number(qs[0].id);
            await expect(
                Survey.respond(s.id, outC, [{ questionId: q1, score: 4 }])
            ).rejects.toMatchObject({ code: 'survey_not_in_audience' });
            await expect(
                Survey.respond(s.id, inA, [{ questionId: q1, score: 4 }])
            ).resolves.toEqual({ recorded: 1 });

            const res = await Survey.results(s.id);
            expect(res.every((r) => r.suppressed === true)).toBe(true);

            await Survey.close(s.id);
            await expect(Survey.close(s.id)).rejects.toMatchObject({ code: 'survey_not_open' });
        });
    });

    test('mobility: expired posting hidden and refused; close/fill recorded; applicants listed', async () => {
        await inRolledBackTx(async () => {
            const [a, b] = (
                await db.all('SELECT id FROM employees WHERE is_active = true ORDER BY id LIMIT 2')
            ).map((e) => Number(e.id));
            const live = await Mobility.postOpportunity({
                title: 'Live',
                actorEmployeeId: a,
                audiencePool: [],
            });
            const past = await Mobility.postOpportunity({
                title: 'Past',
                actorEmployeeId: a,
                closesOn: '2020-01-01',
                audiencePool: [],
            });

            const market = (await Mobility.listOpportunities('open')).map((o) => Number(o.id));
            expect(market).toContain(Number(live.id));
            expect(market).not.toContain(Number(past.id));
            const consoleList = await Mobility.listOpportunities('open', {
                includeExpired: true,
                visibleTo: { employeeId: a },
            });
            const pastRow = consoleList.find((o) => Number(o.id) === Number(past.id));
            expect(pastRow && pastRow.expired).toBe(true);

            await expect(Mobility.apply(past.id, b)).rejects.toMatchObject({
                code: 'opportunity_expired',
            });
            await Mobility.apply(live.id, b, 'motivé');
            const apps = await Mobility.listApplicants(live.id);
            expect(apps).toHaveLength(1);
            expect(apps[0]).toMatchObject({ employeeId: b, status: 'applied', fitPct: null });
            expect(apps[0].name.length).toBeGreaterThan(0);

            await Mobility.decideApplication(apps[0].id, {
                decision: 'declined',
                note: 'Profil hors périmètre',
                actorEmployeeId: a,
            });
            const mine = await Mobility.applicationsForEmployee(b);
            expect(mine.find((x) => Number(x.opportunityId) === Number(live.id))).toMatchObject({
                status: 'declined',
                decisionNote: 'Profil hors périmètre',
            });

            await Mobility.setOpportunityState(live.id, {
                state: 'filled',
                reason: 'Poste pourvu en interne',
                employeeId: a,
            });
            const row = await db.get(
                'SELECT state, state_reason, state_changed_by_employee_id FROM opportunities WHERE id = ?',
                [live.id]
            );
            expect(row).toMatchObject({ state: 'filled', stateReason: 'Poste pourvu en interne' });
            expect(Number(row.stateChangedByEmployeeId)).toBe(a);
            await expect(
                Mobility.setOpportunityState(live.id, { state: 'closed', reason: 'x' })
            ).rejects.toMatchObject({ code: 'opportunity_not_open' });
        });
    });

    test('retention engagement: 1-5 scale answers of named surveys only', async () => {
        await inRolledBackTx(async () => {
            const e = await db.get(
                `SELECT e.id FROM employees e WHERE e.is_active = true
                   AND NOT EXISTS (SELECT 1 FROM survey_responses r WHERE r.employee_id = e.id) ORDER BY e.id LIMIT 1`
            );
            const eid = Number(e.id);
            const named = await Survey.create({
                title: 'Named',
                anonymous: false,
                questions: [
                    { text: 'S', qtype: 'scale' },
                    { text: 'N', qtype: 'nps' },
                ],
            });
            await Survey.open(named.id, { audienceIds: [eid] });
            const nq = await Survey.questions(named.id);
            await Survey.respond(named.id, eid, [
                { questionId: Number(nq[0].id), score: 2 },
                { questionId: Number(nq[1].id), score: 10 },
            ]);
            // A legacy anonymous row still carrying employee_id (pre-pseudonymous era).
            const anon = await Survey.create({
                title: 'Anon',
                anonymous: true,
                questions: [{ text: 'S', qtype: 'scale' }],
            });
            const aq = await Survey.questions(anon.id);
            await db.run(
                'INSERT INTO survey_responses (survey_id, question_id, employee_id, respondent_key, score) VALUES (?, ?, ?, ?, ?)',
                [anon.id, Number(aq[0].id), eid, 'legacy-' + eid, 5]
            );
            const s = await Retention._signals(eid);
            // Before: AVG(2, 10, 5) = 5.67 → "engaged". Now: the one 1-5 named answer.
            expect(s.factors.engagement).toBe(2);
        });
    });
});
