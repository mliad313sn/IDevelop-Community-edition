'use strict';

/**
 * Migration 183 and the measurement / preferences SQL against the REAL test
 * database, every scenario inside ONE rolled-back transaction (the migration
 * runs twice: idempotent).
 *
 *   event_id / ref_type / ref_id written by notify() on the in-app AND the
 *   e-mail row; opened_at only by the owner's « go », never by mark-all-read;
 *   markActed(); eight unopened summaries slow daily → weekly and « turn back
 *   on » restores it; the site's quiet hours when the person has none; the
 *   grid round trip, mandatory rows never written, an e-mail category
 *   switched off keeps the event in-app only; the person's e-mail language;
 *   metrics(): a ratio over fewer than 5 or « acted » with no closing action
 *   is null and the reason — never 0 %; the bulk fan-out; the personal-data
 *   export and the erasure of the two new tables.
 */
const fs = require('fs');
const path = require('path');

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;

const mockEmail = {
    isEnabled: jest.fn(async () => true),
    isCategoryEnabled: jest.fn(async () => true),
    send: jest.fn(async () => ({ sent: true })),
};
jest.mock('../../src/services/EmailService', () => mockEmail);
jest.mock('../../src/services/WebhookService', () => ({ emit: jest.fn() }));

const db = HAS_DB ? require('../../src/config/database') : null;
const N = require('../../src/services/NotificationService');
const MIG = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/183_notification_metrics_prefs.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ROLLBACK = new Error('__NOTIFICATION_METRICS_ROLLBACK__');
async function inRolledBackTx(fn) {
    let out;
    try {
        await db.runTransaction(async () => {
            const q = db._txStore.getStore();
            await q.query(MIG);
            await q.query(MIG); // idempotent
            out = await fn(q);
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
    return out;
}

suite('migration 183 + measurement / preferences (rolled back)', () => {
    let EMP;
    let OTHER;
    beforeAll(async () => {
        const rows = await db.all(
            `SELECT id FROM employees WHERE is_active = true AND cancelled_at IS NULL AND erased_at IS NULL
              ORDER BY id LIMIT 2`
        );
        EMP = Number(rows[0].id);
        OTHER = Number(rows[1].id);
    });
    beforeEach(() => {
        mockEmail.send.mockClear();
        mockEmail.send.mockResolvedValue({ sent: true });
    });

    const clean = async (uid) => {
        await db.run(
            "DELETE FROM notification_preferences WHERE user_type::text = 'employee' AND user_id = ?",
            [uid]
        );
        await db.run(
            `UPDATE sites SET quiet_hours_start = NULL, quiet_hours_end = NULL
              WHERE id = (SELECT site_id FROM employees WHERE id = ?)`,
            [uid]
        );
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [
            `notif-metrics-${uid}@example.test`,
            uid,
        ]);
    };

    test('the tables, columns and CHECKs exist after two runs', async () => {
        const out = await inRolledBackTx(async () => ({
            cols: await db.all(
                `SELECT table_name AS t, column_name AS c FROM information_schema.columns
                  WHERE (table_name = 'notifications'
                         AND column_name IN ('event_id','ref_type','ref_id','opened_at','acted_at'))
                     OR (table_name = 'sites' AND column_name LIKE 'quiet_hours_%')`
            ),
            tables: await db.all(
                `SELECT table_name AS t FROM information_schema.tables
                  WHERE table_name IN ('notification_user_settings','notification_category_prefs')`
            ),
            badCategory: await db
                .runInSavepoint(() =>
                    db.run(
                        `INSERT INTO notification_category_prefs (user_type, user_id, category, channel, enabled)
                         VALUES ('employee', 1, 'Robert''); --', 'email', false)`
                    )
                )
                .then(
                    () => 'accepted',
                    () => 'refused'
                ),
        }));
        expect(out.cols).toHaveLength(7);
        expect(out.tables).toHaveLength(2);
        expect(out.badCategory).toBe('refused');
    });

    test('notify() writes event_id and ref on the in-app AND the e-mail row (same event)', async () => {
        const out = await inRolledBackTx(async () => {
            await clean(EMP);
            const r = await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'cert.expiry',
                category: 'compliance',
                payload: { skillId: 4242, link: '/employee/certifications' },
            });
            const rows = await db.all(
                `SELECT channel, event_id::text AS ev, ref_type, ref_id FROM notifications
                  WHERE user_id = ? AND kind = 'cert.expiry' AND event_id = ?::uuid ORDER BY channel`,
                [EMP, r.eventId]
            );
            return { r, rows, html: mockEmail.send.mock.calls[0][0].html };
        });
        expect(out.r.email).toBe('sent');
        expect(out.rows.map((x) => x.channel).sort()).toEqual(['email', 'inapp']);
        for (const x of out.rows) {
            expect(x.ev).toBe(out.r.eventId);
            expect(x.refType).toBe('skill');
            expect(x.refId).toBe('4242');
        }
        // the button goes through « go » so that opening it is measured
        expect(out.html).toMatch(/\/notifications\/\d+\/go/);
    });

    test('opened_at: the owner’s « go » sets it once; mark-all-read never; another person cannot', async () => {
        const out = await inRolledBackTx(async () => {
            await clean(EMP);
            await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'lms.assigned',
                payload: {},
            });
            await N.notify({ userType: 'employee', userId: EMP, kind: 'lms.due', payload: {} });
            const [a, b] = await db.all(
                `SELECT id FROM notifications WHERE user_id = ? AND channel = 'inapp'
                  AND kind IN ('lms.assigned','lms.due') ORDER BY id DESC LIMIT 2`,
                [EMP]
            );
            const stranger = await N.markOpened({ id: a.id, userType: 'employee', userId: OTHER });
            const own = await N.markOpened({ id: a.id, userType: 'employee', userId: EMP });
            const again = await N.markOpened({ id: a.id, userType: 'employee', userId: EMP });
            await N.markAllRead({ userType: 'employee', userId: EMP });
            const rows = await db.all(
                'SELECT id, opened_at, read_at FROM notifications WHERE id IN (?, ?)',
                [a.id, b.id]
            );
            return { stranger, own, again, rows, a: Number(a.id), b: Number(b.id) };
        });
        expect(out.stranger).toBe(false);
        expect(out.own).toBe(true);
        expect(out.again).toBe(false); // first open only
        const byId = new Map(out.rows.map((r) => [Number(r.id), r]));
        expect(byId.get(out.a).openedAt).toBeTruthy();
        expect(byId.get(out.b).readAt).toBeTruthy(); // mark-all read it…
        expect(byId.get(out.b).openedAt).toBeNull(); // …but did not « open » it
    });

    test('markActed(): by object, by person and kinds; never a closed row twice', async () => {
        const out = await inRolledBackTx(async () => {
            await clean(EMP);
            await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'cycle.reminder',
                payload: { cycleId: 777, link: '/employee/self-assessment' },
            });
            await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'sa.changes_requested',
                payload: {},
            });
            const none = await N.markActed({});
            const byRef = await N.markActed({
                refType: 'cycle',
                refId: 777,
                userType: 'employee',
                userId: EMP,
            });
            const twice = await N.markActed({ refType: 'cycle', refId: 777 });
            const byKind = await N.markActed({
                userType: 'employee',
                userId: EMP,
                kinds: ['sa.changes_requested'],
            });
            const left = await db.get(
                `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = ?
                  AND kind IN ('cycle.reminder','sa.changes_requested') AND acted_at IS NULL
                  AND created_at >= now() - interval '1 minute'`,
                [EMP]
            );
            return { none, byRef, twice, byKind, left: left.c };
        });
        expect(out.none).toBe(0);
        expect(out.byRef).toBeGreaterThanOrEqual(1);
        expect(out.twice).toBe(0);
        expect(out.byKind).toBeGreaterThanOrEqual(1);
        expect(out.left).toBe(0);
    });

    test('a submitted self-assessment closes the campaign reminders (the closing hook)', async () => {
        const left = await inRolledBackTx(async () => {
            await clean(EMP);
            await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'cycle.reminder',
                payload: { cycleId: 778 },
            });
            await N.actedQuietly({
                userType: 'employee',
                userId: EMP,
                kinds: [
                    'cycle.opened',
                    'cycle.reminder',
                    'sa.changes_requested',
                    'sa.reset_for_redo',
                ],
            });
            const r = await db.get(
                `SELECT COUNT(*)::int AS c FROM notifications
                  WHERE user_id = ? AND kind = 'cycle.reminder' AND ref_id = '778' AND acted_at IS NULL`,
                [EMP]
            );
            return r.c;
        });
        expect(left).toBe(0);
    });

    test('an e-mail category switched off keeps the event in-app only; mandatory still mails', async () => {
        const out = await inRolledBackTx(async () => {
            await clean(EMP);
            await N.savePreferenceGrid({
                userType: 'employee',
                userId: EMP,
                categories: new Map([
                    ['development', { email: false }],
                    ['safety', { email: false }],
                ]),
                digestCadence: 'weekly',
                emailLocale: 'en',
                icsEnabled: false,
            });
            const off = await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'mobility.application_decided', // immediate tier, development row
                payload: {},
            });
            const mand = await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'safety.blocked',
                payload: {},
            });
            const grid = await N.getPreferenceGrid({ userType: 'employee', userId: EMP });
            const mandRows = await db.get(
                `SELECT COUNT(*)::int AS c FROM notification_category_prefs
                  WHERE user_id = ? AND category IN ('safety','security')`,
                [EMP]
            );
            return { off, mand, grid, mandRows: mandRows.c };
        });
        expect(out.off.inapp).toBe('queued');
        expect(out.off.email).toBe('category_opt_out');
        expect(out.mand.email).toBe('sent'); // mandatory ignores the grid
        expect(out.mandRows).toBe(0); // mandatory rows are never written
        const dev = out.grid.categories.find((c) => c.key === 'development');
        const safety = out.grid.categories.find((c) => c.key === 'safety');
        expect(dev.email).toBe(false);
        expect(safety).toEqual({ key: 'safety', mandatory: true, email: true });
        expect(out.grid.digestCadence).toBe('weekly');
        expect(out.grid.digestCadenceIsDefault).toBe(false);
        expect(out.grid.emailLocale).toBe('en');
        expect(out.grid.icsEnabled).toBe(false);
    });

    test('mandatory mails still respect the global e-mail switch', async () => {
        const r = await inRolledBackTx(async () => {
            await clean(EMP);
            mockEmail.isEnabled.mockResolvedValueOnce(false);
            return N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'safety.blocked',
                payload: {},
            });
        });
        expect(r.email).toBe('disabled');
        expect(mockEmail.send).not.toHaveBeenCalled();
    });

    test('the person’s e-mail language drives a catalogue-worded mail', async () => {
        const subject = await inRolledBackTx(async () => {
            await clean(EMP);
            await N.savePreferenceGrid({
                userType: 'employee',
                userId: EMP,
                categories: new Map(),
                emailLocale: 'en',
            });
            await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'sa.changes_requested',
                locale: 'fr',
                payload: {},
            });
            return mockEmail.send.mock.calls[0][0].subject;
        });
        expect(subject).toMatch(/Changes requested on your self-assessment/);
    });

    test('a `content` mail follows the person’s language; fixed French text stays French', async () => {
        const out = await inRolledBackTx(async () => {
            await clean(EMP);
            await N.savePreferenceGrid({
                userType: 'employee',
                userId: EMP,
                categories: new Map(),
                emailLocale: 'en',
            });
            await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'sa.changes_requested',
                locale: 'fr',
                payload: {},
                content: (B) => ({ intro: B.pick('Texte français', 'English text') }),
            });
            await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'sa.changes_requested',
                locale: 'fr',
                payload: {},
                intro: 'Texte français seulement',
            });
            return mockEmail.send.mock.calls.map((c) => c[0]);
        });
        expect(out[0].text).toContain('English text');
        expect(out[0].html).toMatch(/<html lang="en"/);
        expect(out[1].text).toContain('Texte français seulement');
        expect(out[1].html).toMatch(/<html lang="fr"/);
    });

    test('no personal window ⇒ the site’s default window defers the in-app row', async () => {
        const row = await inRolledBackTx(async () => {
            await clean(EMP);
            const h = new Date().getHours();
            const hh = (x) => `${String((x + 24) % 24).padStart(2, '0')}:00`;
            await db.run(
                `UPDATE sites SET quiet_hours_start = ?, quiet_hours_end = ?
                  WHERE id = (SELECT site_id FROM employees WHERE id = ?)`,
                [hh(h - 1), hh(h + 2), EMP]
            );
            const r = await N.enqueue({
                userType: 'employee',
                userId: EMP,
                kind: 'lms.due',
                channel: 'inapp',
                payload: {},
            });
            const grid = await N.getPreferenceGrid({ userType: 'employee', userId: EMP });
            return { r, grid, sites: await N.siteQuietHours() };
        });
        expect(row.r.state).toBe('snoozed');
        expect(row.r.releaseAt).toBeInstanceOf(Date);
        expect(row.grid.siteQuiet).toMatchObject({ start: expect.stringMatching(/^\d{2}:00$/) });
        expect(row.sites.some((s) => s.start)).toBe(true);
    });

    test('eight unopened summaries slow daily → weekly; « turn back on » restores daily', async () => {
        const out = await inRolledBackTx(async () => {
            await clean(EMP);
            await N.savePreferenceGrid({
                userType: 'employee',
                userId: EMP,
                categories: new Map(),
                digestCadence: 'daily',
            });
            // the streak counts from the cadence change: push it into the past
            await db.run(
                `UPDATE notification_user_settings SET digest_streak_from = now() - interval '30 days'
                  WHERE user_type = 'employee' AND user_id = ?`,
                [EMP]
            );
            const digest = (daysAgo) =>
                db.run(
                    `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, sent_at,
                                                email_status, event_id, created_at)
                     VALUES ('employee', ?, 'email', 'digest.daily', 'fr', '{}', 'sent', now(), 'sent',
                             gen_random_uuid(), now() - (? || ' days')::interval)`,
                    [EMP, String(daysAgo)]
                );
            for (let d = 7; d >= 1; d--) await digest(d);
            const seven = await N.digestStepDown({ userType: 'employee', userId: EMP });
            await digest(0);
            const eight = await N.digestStepDown({ userType: 'employee', userId: EMP });
            const after = await N.digestCadence('employee', EMP);
            const grid = await N.getPreferenceGrid({ userType: 'employee', userId: EMP });
            await N.reactivateDigest({ userType: 'employee', userId: EMP });
            const restored = await N.digestCadence('employee', EMP);
            const again = await N.digestStepDown({ userType: 'employee', userId: EMP });
            return { seven, eight, after, grid, restored, again };
        });
        expect(out.seven.steppedDown).toBe(false);
        expect(out.eight).toEqual({ steppedDown: true, from: 'daily', to: 'weekly' });
        expect(out.after).toBe('weekly');
        expect(out.grid.stepdownFrom).toBe('daily');
        expect(out.grid.stepdownAt).toBeTruthy();
        expect(out.restored).toBe('daily');
        expect(out.again.steppedDown).toBe(false); // the count restarts at reactivation
    });

    test('an item opened after the summaries breaks the streak', async () => {
        const out = await inRolledBackTx(async () => {
            await clean(EMP);
            await N.savePreferenceGrid({
                userType: 'employee',
                userId: EMP,
                categories: new Map(),
                digestCadence: 'daily',
            });
            await db.run(
                `UPDATE notification_user_settings SET digest_streak_from = now() - interval '30 days'
                  WHERE user_type = 'employee' AND user_id = ?`,
                [EMP]
            );
            for (let d = 9; d >= 2; d--)
                await db.run(
                    `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, sent_at,
                                                email_status, event_id, created_at)
                     VALUES ('employee', ?, 'email', 'digest.daily', 'fr', '{}', 'sent', now(), 'sent',
                             gen_random_uuid(), now() - (? || ' days')::interval)`,
                    [EMP, String(d)]
                );
            await db.run(
                `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, opened_at)
                 VALUES ('employee', ?, 'inapp', 'lms.due', 'fr', '{}', 'queued', now() - interval '1 day')`,
                [EMP]
            );
            return N.digestStepDown({ userType: 'employee', userId: EMP });
        });
        expect(out.steppedDown).toBe(false);
    });

    test('a sent summary is recorded (the step-down counts it) and its lines go through « go »', async () => {
        const out = await inRolledBackTx(async () => {
            await clean(EMP);
            await db.run(
                "UPDATE notifications SET read_at = now() WHERE user_id = ? AND user_type::text = 'employee'",
                [EMP]
            );
            await N.enqueue({
                userType: 'employee',
                userId: EMP,
                kind: 'lms.assigned',
                channel: 'inapp',
                payload: { link: '/employee/my-learning' },
            });
            const r = await N.sendDigest({ userType: 'employee', userId: EMP });
            const row = await db.get(
                `SELECT state, event_id FROM notifications
                  WHERE user_id = ? AND channel = 'email' AND kind = 'digest.daily'
                  ORDER BY id DESC LIMIT 1`,
                [EMP]
            );
            return { r, row, html: mockEmail.send.mock.calls[0][0].html };
        });
        expect(out.r.sent).toBe(true);
        expect(out.row.state).toBe('sent');
        expect(out.row.eventId).toBeTruthy();
        expect(out.html).toMatch(/\/notifications\/\d+\/go/);
    });

    test('metrics(): small groups and kinds without a closing action are « not measured », never 0 %', async () => {
        const m = await inRolledBackTx(async () => {
            await clean(EMP);
            await db.run(`UPDATE notifications SET event_id = NULL WHERE event_id IS NOT NULL`);
            for (let i = 0; i < 6; i++)
                await N.notify({
                    userType: 'employee',
                    userId: EMP,
                    kind: 'cycle.reminder',
                    payload: { cycleId: 900 + i },
                });
            await N.notify({ userType: 'employee', userId: EMP, kind: 'lms.due', payload: {} });
            const ids = await db.all(
                `SELECT id FROM notifications WHERE user_id = ? AND kind = 'cycle.reminder'
                  AND channel = 'inapp' AND event_id IS NOT NULL ORDER BY id`,
                [EMP]
            );
            await N.markOpened({ id: ids[0].id, userType: 'employee', userId: EMP });
            await N.markActed({ refType: 'cycle', refId: 900 });
            return N.metrics({ days: 30 });
        });
        const cyc = m.kinds.find((k) => k.kind === 'cycle.reminder');
        const lms = m.kinds.find((k) => k.kind === 'lms.due');
        expect(cyc.sent).toBe(6);
        expect(cyc.openedPct).toBeCloseTo(100 / 6, 5);
        expect(cyc.actedPct).toBeCloseTo(100 / 6, 5);
        expect(cyc.medianHours).toBeNull(); // 1 acted < 5
        expect(cyc.medianReason).toBe('small');
        expect(cyc.lowOpen).toBe(true); // 16.7 % < 20 %
        expect(lms.sent).toBe(1);
        expect(lms.openedPct).toBeNull();
        expect(lms.openedReason).toBe('small');
        expect(lms.actedPct).toBeNull();
        expect(lms.actedReason).toBe('no_hook');
    });

    test('a leaver is out of every figure', async () => {
        const m = await inRolledBackTx(async () => {
            await clean(OTHER);
            await db.run(`UPDATE notifications SET event_id = NULL WHERE event_id IS NOT NULL`);
            for (let i = 0; i < 5; i++)
                await N.enqueue({
                    userType: 'employee',
                    userId: OTHER,
                    kind: 'lms.assigned',
                    channel: 'inapp',
                    payload: {},
                    eventId: N._newEventId(),
                });
            await db.run('UPDATE employees SET is_active = false WHERE id = ?', [OTHER]);
            return N.metrics({ days: 30 });
        });
        expect(m.kinds.find((k) => k.kind === 'lms.assigned')).toBeUndefined();
    });

    test('the bulk fan-out writes one event_id per row and the campaign as ref', async () => {
        const rows = await inRolledBackTx(async () => {
            await clean(EMP);
            await clean(OTHER);
            await N.enqueueBulkInApp({
                userType: 'employee',
                userIds: [EMP, OTHER],
                kind: 'cycle.opened',
                payload: { cycleId: 31337, link: '/employee/self-assessment' },
            });
            return db.all(
                `SELECT event_id::text AS ev, ref_type, ref_id FROM notifications
                  WHERE kind = 'cycle.opened' AND ref_id = '31337'`
            );
        });
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((r) => r.ev)).size).toBe(2);
        expect(rows.every((r) => r.refType === 'cycle')).toBe(true);
    });

    test('the settings are exported with the person, then erased with them', async () => {
        const out = await inRolledBackTx(async () => {
            const s = await db.get(
                `SELECT id FROM employees WHERE is_active = true AND erased_at IS NULL
                  ORDER BY id DESC LIMIT 1`
            );
            const id = Number(s.id);
            await N.savePreferenceGrid({
                userType: 'employee',
                userId: id,
                categories: new Map([['talent', { email: false }]]),
                digestCadence: 'weekly',
                emailLocale: 'en',
            });
            const DSR = require('../../src/services/DSRService');
            const exp = await DSR.export(id);
            jest.spyOn(console, 'error').mockImplementation(() => {});
            await DSR.erase(id, null, { reason: 'notification settings test' });
            const left = await db.get(
                `SELECT (SELECT COUNT(*) FROM notification_user_settings WHERE user_type = 'employee' AND user_id = ?)
                      + (SELECT COUNT(*) FROM notification_category_prefs WHERE user_type = 'employee' AND user_id = ?) AS n`,
                [id, id]
            );
            return { exp, left: Number(left.n) };
        });
        expect(JSON.stringify(out.exp.notificationSettings)).toContain('weekly');
        expect(JSON.stringify(out.exp.notificationCategoryPrefs)).toContain('talent');
        expect(out.left).toBe(0);
    });
});

suite('reminder effectiveness from the ledgers (4.0.0 port, wave 7, rolled back)', () => {
    /** Invented people on a template row's site, department and role. */
    async function people(tag, n) {
        const tpl = await db.get(
            `SELECT site_id, department_id, service_id, role_id FROM employees
              WHERE is_active AND role_id IS NOT NULL ORDER BY id LIMIT 1`
        );
        const ids = [];
        for (let i = 0; i < n; i++) {
            const r = await db.get(
                `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id, service_id, role_id, is_active)
                 VALUES (?, ?, 'Reminded', ?, ?, ?, ?, true) RETURNING id`,
                [
                    `EFF-${tag}-${i}-${Date.now()}`,
                    `${tag}${i}`,
                    tpl.siteId,
                    tpl.departmentId,
                    tpl.serviceId,
                    tpl.roleId,
                ]
            );
            ids.push(Number(r.id));
        }
        return ids;
    }

    async function campaign(code) {
        const admin = await db.get(
            "SELECT id FROM admins WHERE role::text = 'superadmin' ORDER BY id LIMIT 1"
        );
        const r = await db.get(
            `INSERT INTO assessment_cycles (code, label, status, opened_at, closes_at, created_by)
             VALUES (?, ?, 'open', now() - interval '20 days', now() + interval '20 days', ?) RETURNING id`,
            [code, code, Number(admin.id)]
        );
        return Number(r.id);
    }

    test('acted within 7 days counts; a leaver is out; under 5 no rate', async () => {
        const out = await inRolledBackTx(async () => {
            const C = await campaign(`EFF-${Date.now()}`);
            const ids = await people('EFF', 7);
            for (const id of ids) {
                await db.run(
                    'INSERT INTO cycle_participants (cycle_id, employee_id, expected_skills) VALUES (?, ?, 4)',
                    [C, id]
                );
                await db.run(
                    `INSERT INTO reminder_log (kind, target_type, target_id, ref_id, period, sent_at)
                     VALUES ('cycle.not_started', 'employee', ?, ?, 'd+3', now() - interval '10 days')`,
                    [id, C]
                );
            }
            // two start within 7 days of the reminder, one only after 9 days
            await db.run(
                `UPDATE cycle_participants SET started_at = now() - interval '8 days'
                  WHERE cycle_id = ? AND employee_id IN (?, ?)`,
                [C, ids[0], ids[1]]
            );
            await db.run(
                `UPDATE cycle_participants SET started_at = now() - interval '1 day'
                  WHERE cycle_id = ? AND employee_id = ?`,
                [C, ids[2]]
            );
            // a leaver is out of every figure
            await db.run('UPDATE employees SET is_active = false WHERE id = ?', [ids[6]]);
            const before = await N.reminderEffectiveness({ days: 90 });
            // with only four people left reminded, there is no rate
            await db.run('UPDATE employees SET is_active = false WHERE id IN (?, ?)', [
                ids[4],
                ids[5],
            ]);
            const small = await N.reminderEffectiveness({ days: 90 });
            return { before, small };
        });
        const camp = (r) => r.rows.find((x) => x.key === 'campaign');
        expect(out.before.rows.map((r) => r.key)).toEqual(['campaign', 'learning', 'development']);
        const c = camp(out.before);
        expect(c.reminded).toBeGreaterThanOrEqual(6);
        expect(c.acted).toBeGreaterThanOrEqual(2);
        expect(c.rate).toBeCloseTo((100 * c.acted) / c.reminded, 5);
        // the base data may hold other reminders: only check ours did not make it 0 %
        expect(c.rate).toBeGreaterThan(0);
        const s = camp(out.small);
        expect(s.reminded).toBe(c.reminded - 2);
        if (s.reminded < 5) expect(s).toMatchObject({ rate: null, acted: null, reason: 'small' });
    });

    test('the window is bounded and a reason is always given for a missing rate', async () => {
        const r = await N.reminderEffectiveness({ days: 1 });
        expect(r.days).toBe(7);
        for (const row of r.rows) {
            if (row.rate == null) expect(['small', 'unavailable']).toContain(row.reason);
            else expect(row.reason).toBeNull();
        }
        expect((await N.reminderEffectiveness({ days: 9999 })).days).toBe(365);
    });
});
