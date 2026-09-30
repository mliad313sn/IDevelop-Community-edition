'use strict';
/**
 * Shared one-to-one space, proved against the REAL schema inside ONE
 * transaction that is always rolled back.
 *
 *   Pair only   the person and their direct manager write; HR within scope
 *               reads the SHARED content; a stranger, a colleague and an admin
 *               without scope get a 404.
 *   Private     a private note is returned to its author ONLY — never to the
 *               other party, never to HR, never to a SuperAdmin.
 *   Agenda      either side adds a topic; the other side is notified.
 *   Actions     owner (one of the pair), due date, links to the person's own
 *               IDP objective or goal only.
 *   Roster      a meeting marked as held feeds TeamRosterService's "last 1:1".
 *
 * Skipped (not failed) when no database is reachable.
 */
require('dotenv').config();

const ROLLBACK = new Error('oneonone-rollback');
let db;
let svc;
let ready = false;

beforeAll(async () => {
    const url = String(process.env.DATABASE_URL || '');
    if (!url || /placeholder/.test(url)) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        ready = Boolean(
            await db.get(
                `SELECT 1 AS ok FROM services sv JOIN departments d ON d.id = sv.department_id
                  WHERE to_regclass('public.one_on_one_notes') IS NOT NULL LIMIT 1`
            )
        );
        svc = require('../../src/services/OneOnOneService');
    } catch (_) {
        ready = false;
    }
}, 30000);

afterAll(async () => {
    if (db) {
        try {
            await db.close();
        } catch (_) {
            /* closed */
        }
    }
});

async function inRollback(fn) {
    try {
        await db.runTransaction(async () => {
            await fn(await fixture());
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

async function fixture() {
    const org = await db.get(
        `SELECT sv.id AS service_id, d.id AS department_id, d.site_id
           FROM services sv JOIN departments d ON d.id = sv.department_id
          ORDER BY sv.id LIMIT 1`
    );
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const role = Number(
        (await db.get('INSERT INTO roles (name) VALUES (?) RETURNING id', [`OO role ${stamp}`])).id
    );
    const mk = async (n, { sup = null } = {}) =>
        Number(
            (
                await db.get(
                    `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id,
                                            service_id, role_id, supervisor_id, is_active)
                     VALUES (?, ?, 'OO', ?, ?, ?, ?, ?, true) RETURNING id`,
                    [`OO-${n}-${stamp}`, n, org.siteId, org.departmentId, org.serviceId, role, sup]
                )
            ).id
        );
    const M = await mk('Manager');
    const E = await mk('Employee', { sup: M });
    const C = await mk('Colleague', { sup: M });
    const X = await mk('Stranger');
    return {
        M,
        E,
        C,
        X,
        u: {
            M: { id: M, userType: 'manager' },
            E: { id: E, userType: 'employee' },
            C: { id: C, userType: 'employee' },
            X: { id: X, userType: 'employee' },
            SA: { id: 0, userType: 'admin', role: 'superadmin', username: 'sa' },
            NOSCOPE: { id: 987654321, userType: 'admin', role: 'localadmin', username: 'none' },
        },
    };
}

const status = async (p) => {
    try {
        await p;
        return 200;
    } catch (e) {
        return e.status || 500;
    }
};

describe('shared one-to-one space — against the real schema (rolled back)', () => {
    test('only the pair (and HR within scope, read-only) reach the space', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            expect((await svc.space(f.u.E, f.E)).role).toBe('employee');
            expect((await svc.space(f.u.M, f.E)).role).toBe('manager');
            const hr = await svc.space(f.u.SA, f.E);
            expect(hr.role).toBe('hr');
            expect(hr.canWrite).toBe(false);
            for (const u of [f.u.X, f.u.C, f.u.NOSCOPE])
                expect(await status(svc.space(u, f.E))).toBe(404);
            // HR reads, never writes.
            expect(await status(svc.addTopic(f.u.SA, f.E, 'from HR'))).toBe(403);
            expect(await status(svc.addTopic(f.u.X, f.E, 'from a stranger'))).toBe(404);
        });
    });

    test('a topic from one side notifies the other side', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            const { meetingId } = await svc.addTopic(f.u.E, f.E, 'Training budget');
            await svc.addTopic(f.u.M, f.E, 'Next quarter');
            const notes = await db.all(
                `SELECT user_id FROM notifications
                  WHERE kind = 'oneonone.topic_added' AND channel = 'inapp' AND user_id = ANY(?)`,
                [[f.E, f.M]]
            );
            expect(notes.map((n) => Number(n.userId)).sort()).toEqual([f.E, f.M].sort());
            const space = await svc.space(f.u.M, f.E);
            expect(space.next.id).toBe(meetingId);
            expect(space.next.agenda.map((t) => t.body)).toEqual([
                'Training budget',
                'Next quarter',
            ]);
            const m = await db.get('SELECT manager_id, kind, status FROM check_ins WHERE id = ?', [
                meetingId,
            ]);
            expect(Number(m.managerId)).toBe(f.M);
            expect(m.kind).toBe('one_on_one');
            expect(m.status).toBe('scheduled');
        });
    });

    test('private notes are visible to their author only — not the other party, not HR, not a SuperAdmin', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            const { meetingId } = await svc.addTopic(f.u.E, f.E, 'Topic');
            await svc.saveNote(f.u.E, meetingId, 'private', 'E-PRIVATE-SECRET');
            await svc.saveNote(f.u.M, meetingId, 'private', 'M-PRIVATE-SECRET');
            await svc.saveNote(f.u.E, meetingId, 'shared', 'E shared words');
            await svc.saveNote(f.u.M, meetingId, 'shared', 'M shared words');

            const asE = JSON.stringify(await svc.space(f.u.E, f.E));
            const asM = JSON.stringify(await svc.space(f.u.M, f.E));
            const asSA = JSON.stringify(await svc.space(f.u.SA, f.E));
            expect(asE).toContain('E-PRIVATE-SECRET');
            expect(asE).not.toContain('M-PRIVATE-SECRET');
            expect(asM).toContain('M-PRIVATE-SECRET');
            expect(asM).not.toContain('E-PRIVATE-SECRET');
            expect(asSA).not.toContain('PRIVATE-SECRET');
            // Shared notes are shared: both parties and HR read both.
            for (const j of [asE, asM, asSA]) {
                expect(j).toContain('E shared words');
                expect(j).toContain('M shared words');
            }
            // Nobody can write into someone else's space, and HR cannot write at all.
            expect(await status(svc.saveNote(f.u.SA, meetingId, 'private', 'x'))).toBe(403);
            expect(await status(svc.saveNote(f.u.C, meetingId, 'private', 'x'))).toBe(404);
            // Saving again replaces, an empty body removes.
            await svc.saveNote(f.u.E, meetingId, 'private', '');
            expect(JSON.stringify(await svc.space(f.u.E, f.E))).not.toContain('E-PRIVATE-SECRET');
            // The v1 check-in API reads check_ins/check_in_items only: no note table there.
            const { CheckInsRepository } = require('../../src/api/v1/repository');
            const api = JSON.stringify(await CheckInsRepository.listForEmployee(f.E));
            expect(api).not.toContain('PRIVATE-SECRET');
        });
    });

    test('action items: owner of the pair, due date, links only to the person’s own objective or goal', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            const { meetingId } = await svc.addTopic(f.u.M, f.E, 'Topic');
            const goal = await db.get(
                `INSERT INTO goals (employee_id, title) VALUES (?, 'Reduce rework') RETURNING id`,
                [f.E]
            );
            const other = await db.get(
                `INSERT INTO goals (employee_id, title) VALUES (?, 'Not theirs') RETURNING id`,
                [f.X]
            );
            const { id } = await svc.addAction(f.u.M, meetingId, {
                body: 'Book the course',
                ownerId: f.E,
                dueOn: '2030-01-31',
                goalId: goal.id,
            });
            expect(
                await status(svc.addAction(f.u.M, meetingId, { body: 'x', goalId: other.id }))
            ).toBe(400);
            expect(await status(svc.addAction(f.u.M, meetingId, { body: 'x', ownerId: f.X }))).toBe(
                400
            );
            const space = await svc.space(f.u.E, f.E);
            const act = space.next.actions.find((a) => a.id === id);
            expect(act).toMatchObject({ body: 'Book the course', ownerId: f.E, done: false });
            expect(String(act.dueOn)).toMatch(/2030/);
            expect(act.goal.title).toBe('Reduce rework');
            await svc.setActionDone(f.u.E, id, true);
            const row = await db.get('SELECT done FROM check_in_items WHERE id = ?', [id]);
            expect(row.done).toBe(true);
        });
    });

    test('marking the meeting as held feeds the roster; open topics move to the next meeting', async () => {
        if (!ready) return;
        await inRollback(async (f) => {
            const a = await svc.addTopic(f.u.E, f.E, 'Discussed');
            const b = await svc.addTopic(f.u.E, f.E, 'Not reached');
            await svc.setTopicDiscussed(f.u.M, a.id, true);
            const out = await svc.complete(f.u.M, a.meetingId);
            expect(out.nextId).toBeTruthy();
            const moved = await db.get(
                'SELECT check_in_id FROM one_on_one_agenda_items WHERE id = ?',
                [b.id]
            );
            expect(Number(moved.checkInId)).toBe(out.nextId);
            expect(await status(svc.complete(f.u.M, a.meetingId))).toBe(409);

            const roster = await require('../../src/services/TeamRosterService').forManager(f.u.M);
            const row = roster.rows.find((r) => r.employeeId === f.E);
            expect(row.lastOneOnOne).toBeTruthy();

            const space = await svc.space(f.u.E, f.E);
            expect(space.history.map((h) => h.id)).toContain(a.meetingId);
            expect(space.next.id).toBe(out.nextId);
        });
    });
});
