'use strict';
/**
 * AMDEC C2 (criticality 240) — /movements printed the raw token `admin:136` as the
 * AUTHOR of a supervisor review.
 *
 * REPRODUCED BY EXECUTION on idevelop before the fix, through the real service
 * (MovementService.feed / .summary, not the driver underneath):
 *
 *     actorRef      actorName        <- what the page rendered in the "who" column
 *     admin:136     admin:136
 *     admin:96      admin:96
 *     admin:85      admin:85
 *
 * `v_movement_feed` hard-prefixed `'admin:' || sa.reviewed_by`, but that column has
 * an FK to employees(id): 85 is HOLLOWE Victor, 96 is Berg Ingrid, 136 is Beatrice
 * NOVAK Clara, and `admins` holds exactly one row (id 1). So resolveActors looked
 * every reviewer up in the wrong table, found nothing, and fell back to printing the
 * token. 92 of 92 attributed review rows named nobody.
 *
 * The latent half is the dangerous one: the ids come from two independent sequences.
 * The day an `admins` row exists with an id that also exists in `employees`, the
 * lookup SUCCEEDS and the audit trail silently credits the WRONG PERSON.
 *
 * Migration 96 re-namespaces the review branch to 'employee:'. These tests are
 * behavioural and read-only — they assert what a user sees in the "who" column.
 */

require('dotenv').config();
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/idevelop';

const db = require('../../src/config/database');
const MovementService = require('../../src/services/MovementService');

let reachable = false;
let USER = null;

beforeAll(async () => {
    try {
        await db.connect();
        const a = await db.get('SELECT id, username, role FROM admins ORDER BY id LIMIT 1');
        USER = { id: Number(a.id), userType: 'admin', role: a.role, username: a.username };
        reachable = Boolean(USER);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[movementFeedReviewerIdentity] Postgres unreachable:', err && err.message);
    }
}, 30000);

afterAll(async () => {
    await db.close().catch(() => {});
});

// Needs a POPULATED database (reviews already decided): runs only against an
// opt-in fixture database — see CONTRIBUTING.md.
const HAS_FIXTURES = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
(HAS_FIXTURES ? describe : describe.skip)(
    'FMEA C2 — the movement feed attributes a review to the right person',
    () => {
        test('Postgres is reachable (these tests are worthless without it)', () => {
            expect(reachable).toBe(true);
        });

        test('every actor reference resolves in the table its namespace names', async () => {
            const rows = await db.all(
                `SELECT DISTINCT f.stream, f.actor_ref
               FROM v_movement_feed f WHERE f.actor_ref IS NOT NULL`
            );
            expect(rows.length).toBeGreaterThan(0);
            const unresolved = [];
            for (const r of rows) {
                const [type, rawId] = String(r.actorRef).split(':');
                const id = Number(rawId);
                const table =
                    type === 'admin' ? 'admins' : type === 'employee' ? 'employees' : null;
                if (!table) {
                    unresolved.push(`${r.actorRef} (unknown namespace)`);
                    continue;
                }
                const hit = await db.get(`SELECT id FROM ${table} WHERE id = ?`, [id]);
                if (!hit) unresolved.push(`${r.actorRef} (no ${table} row)`);
            }
            expect(unresolved).toEqual([]);
        });

        test('a supervisor review is credited to the EMPLOYEE who decided it', async () => {
            const sample = await db.get(
                `SELECT sa.reviewed_by AS rb, e.last_name || ', ' || e.first_name AS nm
               FROM self_assessments sa JOIN employees e ON e.id = sa.reviewed_by
              WHERE sa.reviewed_at IS NOT NULL AND sa.reviewed_by IS NOT NULL LIMIT 1`
            );
            expect(sample).toBeTruthy();
            const row = await db.get(
                `SELECT f.actor_ref FROM v_movement_feed f
              WHERE f.stream = 'review' AND f.actor_ref IS NOT NULL LIMIT 1`
            );
            expect(String(row.actorRef).startsWith('employee:')).toBe(true);
            expect(String(row.actorRef).startsWith('admin:')).toBe(false);
        });

        test('a skill assessment is still credited to the ADMIN who recorded it', async () => {
            const row = await db.get(
                `SELECT f.actor_ref FROM v_movement_feed f
              WHERE f.stream = 'assessment' AND f.actor_ref IS NOT NULL LIMIT 1`
            );
            if (!row) return; // no assessment activity in this database
            expect(String(row.actorRef).startsWith('admin:')).toBe(true);
            const id = Number(String(row.actorRef).split(':')[1]);
            expect(await db.get('SELECT id FROM admins WHERE id = ?', [id])).toBeTruthy();
        });

        test('the page renders a human name, never a raw id token', async () => {
            const feed = await MovementService.feed(USER, {
                days: 3650,
                stream: 'review',
                limit: 50,
            });
            expect(feed.length).toBeGreaterThan(0);
            const attributed = feed.filter((r) => r.actorRef);
            expect(attributed.length).toBeGreaterThan(0);
            const raw = attributed.filter((r) =>
                /^(admin|employee):\d+$/.test(String(r.actorName))
            );
            expect(raw).toEqual([]);
            for (const r of attributed) expect(r.actorName).toMatch(/[A-Za-zÀ-ÿ]/);
        });

        test('the "top actors" panel names people, not tokens', async () => {
            const s = await MovementService.summary(USER, { days: 3650 });
            expect(s.topActors.length).toBeGreaterThan(0);
            const raw = s.topActors.filter((a) =>
                /^(admin|employee):\d+$/.test(String(a.actorName))
            );
            expect(raw).toEqual([]);
        });
    }
);
