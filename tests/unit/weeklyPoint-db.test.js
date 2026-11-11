'use strict';
/**
 * The employee's weekly point (4.0.0 port, wave 7) on the REAL schema, with
 * the invented people of tests/helpers/dashWorld.js, every case inside a
 * transaction that is always rolled back.
 *
 *   - « Since your last summary of DD/MM »: the employee home's own
 *     definitions (a validated level, a gap closed), counts only — never a
 *     skill or a name in the payload or the mail;
 *   - a first point says the comparison comes with the next one;
 *   - e-mailed (notify, category 'digest') only with a positive change or a
 *     step to take, never to an address shared by several accounts;
 *     otherwise written in the app only (enqueue);
 *   - the executive's weekly window is « since the previous summary ».
 * Skipped unless DATABASE_URL names a *_test database.
 */
require('dotenv').config();

const mockN = {
    notify: jest.fn(async () => ({ inapp: 'queued', email: 'sent' })),
    enqueue: jest.fn(async () => ({ state: 'queued', id: 1 })),
    recipientLang: jest.fn(async () => 'en'),
};
jest.mock('../../src/services/NotificationService', () => mockN);

const { isTestDatabaseUrl } = require('../helpers/testDatabase');
const W = require('../helpers/dashWorld');

const ENABLED = isTestDatabaseUrl(process.env.DATABASE_URL);
const d = ENABLED ? describe : describe.skip;
jest.setTimeout(120000);

const S = require('../../src/services/PersonaDigestService');
const P = require('../../src/services/DigestProgress');

let db;
beforeAll(async () => {
    if (!ENABLED) return;
    db = require('../../src/config/database');
    await db.connect();
});
afterAll(async () => {
    if (db) await db.close();
});
beforeEach(() => {
    mockN.notify.mockClear();
    mockN.enqueue.mockClear();
});

describe('the progress block, pure', () => {
    test('first point, nothing new, counts only', () => {
        expect(P.compose('en', null, null)).toMatchObject({
            state: 'first',
            positive: 0,
            title: null,
            lines: [{ text: 'First summary: the comparison comes with the next one.' }],
        });
        const prev = { id: 1, at: '2026-10-12T08:00:00.000Z' };
        const none = P.compose('fr', prev, {
            upliftsTotal: 0,
            gapsClosed: 0,
            actionsDone: 0,
            trainingsDone: null,
        });
        expect(none.positive).toBe(0);
        expect(none.title).toMatch(/^Depuis votre dernier point du \d{2}\/10$/);
        expect(none.lines.map((l) => l.polarity)).toEqual(['neutral']);
        const some = P.compose('en', prev, {
            upliftsTotal: 2,
            gapsClosed: 1,
            actionsDone: 3,
            trainingsDone: null, // unreadable: left out, never 0
            uplifts: [{ skillName: 'Secret skill' }],
        });
        expect(some.positive).toBe(6);
        expect(some.lines.map((l) => l.text)).toEqual([
            '2 levels validated by your manager',
            '1 gap closed: the required level is reached',
            '3 actions of your development plan completed',
        ]);
        expect(JSON.stringify(some)).not.toContain('Secret skill');
        // the changes cannot be read: no block rather than « nothing new »
        expect(P.compose('en', prev, null)).toBeNull();
    });

    test('the executive window is « since the previous summary », 1 to 30 days', () => {
        const now = new Date('2026-10-19T08:00:00Z');
        const ago = (days) => ({ at: new Date(now.getTime() - days * 86400000).toISOString() });
        expect(S.windowDays('executive', 'weekly', null, now)).toBe(30);
        expect(S.windowDays('executive', 'weekly', ago(7), now)).toBe(7);
        expect(S.windowDays('executive', 'weekly', ago(90), now)).toBe(30);
        expect(S.windowDays('executive', 'daily', ago(7), now)).toBe(1);
        expect(S.windowDays('hr', 'weekly', ago(14), now)).toBe(7);
    });
});

d('the weekly point on the real schema (rolled back)', () => {
    test('a validated level that closes a gap: counted, e-mailed, no skill and no name', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const person = w.people.N[5]; // S1 at 1, required 2
            // Inside one transaction now() is fixed, so the world's own first
            // measurements carry it: the previous point is placed just after
            // them and the validated rise of S1 (1 → 2, the requirement) after it.
            await db.run(
                `INSERT INTO persona_digests (user_type, user_id, persona, cadence, window_days, period_key, state, payload, created_at)
                 VALUES ('employee', ?, 'employee', 'weekly', 7, CURRENT_DATE - 7, 'sent', '{}'::jsonb, now() + interval '30 seconds')`,
                [person]
            );
            await db.run(
                `INSERT INTO assessment_history (employee_id, skill_id, previous_level, new_level, assessed_by, assessed_at, source, notes)
                 VALUES (?, ?, 1, 2, ?, now() + interval '1 minute', 'supervisor_review', 'weekly point fixture')`,
                [person, w.S1, w.adminId]
            );
            const skill = await db.get('SELECT name FROM skills WHERE id = ?', [w.S1]);
            const r = { userType: 'employee', id: person, persona: 'employee' };
            const at = await db.get(`SELECT now() + interval '2 minutes' AS "t"`);
            const built = await S.build(r, {
                cadence: 'weekly',
                now: new Date(at.t),
                locale: 'en',
            });
            await S.deliver(r, built, 4242, 'en');
            return { w, built, skill: skill.name };
        });
        const pr = out.built.payload.progress;
        expect(pr.state).toBe('comparable');
        expect(pr.title).toMatch(/^Since your last summary of \d{2}\/\d{2}$/);
        expect(pr.positive).toBeGreaterThanOrEqual(2);
        const texts = pr.lines.map((l) => l.text);
        expect(texts).toContain('1 level validated by your manager');
        expect(texts).toContain('1 gap closed: the required level is reached');
        expect(out.built.state).toBe('sent');
        expect(mockN.notify).toHaveBeenCalledTimes(1);
        const call = mockN.notify.mock.calls[0][0];
        expect(call).toMatchObject({
            userType: 'employee',
            kind: 'digest.persona.employee',
            category: 'digest',
            ctaUrl: '/digests/4242',
            refType: 'persona_digest',
            refId: 4242,
        });
        expect(call.blocks[0]).toEqual({ type: 'h', text: pr.title });
        expect(mockN.enqueue).not.toHaveBeenCalled();
        const everything = JSON.stringify(out.built) + JSON.stringify(call);
        expect(everything).not.toContain(out.skill);
        expect(W.namesIn(everything, out.w)).toEqual([]);
    });

    test('a first point with nothing to do stays in the app', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const person = w.people.N[0]; // all met, nothing waiting
            const r = { userType: 'employee', id: person, persona: 'employee' };
            const built = await S.build(r, { cadence: 'weekly', now: new Date(), locale: 'fr' });
            // whatever the next step, a point without a positive change and without
            // a step goes in-app only: force the « nothing to do » case
            built.payload.actions = [];
            await S.deliver(r, built, 4243, 'fr');
            return { built };
        });
        expect(out.built.payload.progress).toMatchObject({ state: 'first', positive: 0 });
        expect(mockN.notify).not.toHaveBeenCalled();
        expect(mockN.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'digest.persona.employee', channel: 'inapp' })
        );
    });

    test('an address shared by several active accounts never receives the point', async () => {
        const out = await W.inRolledBackTx(db, async () => {
            const w = await W.world(db);
            const [a, b] = [w.people.N[5], w.people.N[6]];
            const shared = `team.box.${W.STAMP}@example.test`;
            await db.run('UPDATE employees SET email = ? WHERE id IN (?, ?)', [shared, a, b]);
            const isShared = await S._test.sharedAddress(a);
            const r = { userType: 'employee', id: a, persona: 'employee' };
            const built = {
                persona: 'employee',
                payload: {
                    title: 'x',
                    actions: [{ key: 'k', text: 'step', href: '/x' }],
                    changes: [],
                    history: [],
                    progress: { lines: [{ text: 'l', polarity: 'better' }], positive: 1 },
                },
            };
            await S.deliver(r, built, 4244, 'en');
            return { isShared };
        });
        expect(out.isShared).toBe(true);
        expect(mockN.notify).not.toHaveBeenCalled();
        expect(mockN.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ channel: 'inapp', kind: 'digest.persona.employee' })
        );
    });
});
