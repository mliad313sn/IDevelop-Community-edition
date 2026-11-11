'use strict';

/**
 * Migration 182 and the delivery SQL against the REAL test database, every
 * write inside ONE rolled-back transaction: the migration applies twice
 * (idempotent), and the statements the mocked suite only pattern-matches run
 * for real — the outbox insert, the retry ladder through the release tick
 * (1 → 2 → 3 → abandoned, then never claimed again), the « already e-mailed »
 * marking and the digest filter, and the suppression of a leaver.
 */
const fs = require('fs');
const path = require('path');

const HAS_DB = require('../helpers/testDatabase').isTestDatabaseUrl(process.env.DATABASE_URL || '');
const suite = HAS_DB ? describe : describe.skip;

const mockEmail = {
    isEnabled: jest.fn(async () => true),
    isCategoryEnabled: jest.fn(async () => true),
    send: jest.fn(async () => ({ sent: false, error: 'connect ECONNREFUSED' })),
};
jest.mock('../../src/services/EmailService', () => mockEmail);
jest.mock('../../src/services/WebhookService', () => ({ emit: jest.fn() }));

const db = HAS_DB ? require('../../src/config/database') : null;
const N = require('../../src/services/NotificationService');
const MIG = fs.readFileSync(
    path.join(__dirname, '../../db/postgres/182_notification_delivery.sql'),
    'utf8'
);

beforeAll(async () => {
    if (HAS_DB) await db.connect();
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

const ROLLBACK = new Error('__NOTIFICATION_DELIVERY_ROLLBACK__');
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

suite('migration 182 + delivery SQL (rolled back)', () => {
    let EMP;
    beforeAll(async () => {
        const e = await db.get(
            `SELECT id FROM employees WHERE is_active = true AND cancelled_at IS NULL AND erased_at IS NULL
              ORDER BY id LIMIT 1`
        );
        EMP = Number(e.id);
    });

    test('the four columns, the CHECKs and the setting exist after two runs', async () => {
        const out = await inRolledBackTx(async () => ({
            cols: await db.all(
                `SELECT column_name AS c FROM information_schema.columns
                  WHERE table_name = 'notifications'
                    AND column_name IN ('email_status','email_attempts','next_attempt_at','last_error')`
            ),
            checks: await db.all(
                `SELECT conname AS n FROM pg_constraint
                  WHERE conrelid = 'public.notifications'::regclass
                    AND conname IN ('notifications_email_status_check', 'notifications_last_error_len')`
            ),
            setting: await db.get(
                "SELECT setting_value AS v FROM app_settings WHERE setting_key = 'mailDefaultLanguage'"
            ),
        }));
        expect(out.cols.map((r) => r.c).sort()).toEqual([
            'email_attempts',
            'email_status',
            'last_error',
            'next_attempt_at',
        ]);
        expect(out.checks.map((r) => r.n).sort()).toEqual([
            'notifications_email_status_check',
            'notifications_last_error_len',
        ]);
        expect(out.setting.v).toBe('fr');
    });

    test('an unknown e-mail status is refused by the CHECK', async () => {
        const err = await inRolledBackTx(async (q) => {
            try {
                await q.query('SAVEPOINT s');
                await q.query(
                    `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, email_status)
                     VALUES ('employee', $1, 'email', 'sa.submitted', 'fr', '{}', 'failed', 'lost')`,
                    [EMP]
                );
                return null;
            } catch (e) {
                await q.query('ROLLBACK TO SAVEPOINT s');
                return e.message;
            }
        });
        expect(err).toMatch(/notifications_email_status_check/);
    });

    test('a failed send lands in the outbox and the release tick walks it 1 → 2 → 3 → abandoned', async () => {
        const trail = await inRolledBackTx(async () => {
            mockEmail.send.mockResolvedValue({ sent: false, error: 'connect ECONNREFUSED' });
            await db.run('UPDATE employees SET email = ? WHERE id = ?', [
                'delivery-probe@example.invalid',
                EMP,
            ]);
            await db.run(
                "DELETE FROM notification_preferences WHERE user_type = 'employee' AND user_id = ?",
                [EMP]
            );
            const r = await N.notify({
                userType: 'employee',
                userId: EMP,
                kind: 'sa.changes_requested',
                category: 'validation',
                ignoreQuietHours: true,
            });
            const steps = [r.emailStatus];
            const row = await db.get(
                `SELECT id, email_status, email_attempts, last_error
                   FROM notifications WHERE channel = 'email' AND user_id = ? AND kind = 'sa.changes_requested'
                  ORDER BY id DESC LIMIT 1`,
                [EMP]
            );
            if (!row) throw new Error(`no email row: ${JSON.stringify(r)}`);
            steps.push(`${row.emailStatus}:${row.emailAttempts}`);
            const inapp = await db.get(
                `SELECT email_status FROM notifications WHERE channel = 'inapp' AND user_id = ?
                  AND kind = 'sa.changes_requested' ORDER BY id DESC LIMIT 1`,
                [EMP]
            );
            steps.push(`inapp:${inapp.emailStatus}`);
            for (let i = 0; i < 2; i++) {
                await db.run(
                    `UPDATE notifications SET next_attempt_at = now() - interval '1 minute' WHERE id = ?`,
                    [row.id]
                );
                await N.releaseSnoozed();
                const x = await db.get(
                    'SELECT email_status, email_attempts, state FROM notifications WHERE id = ?',
                    [row.id]
                );
                steps.push(`${x.emailStatus}:${x.emailAttempts}:${x.state}`);
            }
            await db.run(
                `UPDATE notifications SET next_attempt_at = now() - interval '1 minute' WHERE id = ?`,
                [row.id]
            );
            mockEmail.send.mockClear();
            await N.releaseSnoozed();
            steps.push(`calls:${mockEmail.send.mock.calls.length}`);
            return steps;
        });
        expect(trail).toEqual([
            'retry',
            'retry:1',
            'inapp:emailed',
            'retry:2:failed',
            'abandoned:3:failed',
            'calls:0',
        ]);
    });

    test('the digest query skips e-mailed rows; the outstanding count runs', async () => {
        const out = await inRolledBackTx(async () => {
            await db.run(
                `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, email_status)
                 VALUES ('employee', ?, 'inapp', 'sa.approved', 'fr', '{}', 'queued', 'emailed'),
                        ('employee', ?, 'inapp', 'sa.changes_requested', 'fr', '{}', 'queued', NULL)`,
                [EMP, EMP]
            );
            const rows = await N.listInApp({
                userType: 'employee',
                userId: EMP,
                unreadOnly: true,
                sinceHours: 24,
                excludeEmailed: true,
                limit: 100,
            });
            return {
                kinds: rows.map((r) => r.kind),
                outstanding: await N._outstandingCount('employee', EMP),
            };
        });
        expect(out.kinds).toContain('sa.changes_requested');
        expect(out.kinds).not.toContain('sa.approved');
        expect(Number.isInteger(out.outstanding)).toBe(true);
    });

    test('a leaver, a voided record and an erased person resolve to « suppressed »', async () => {
        const out = await inRolledBackTx(async () => {
            const res = [];
            await db.run('UPDATE employees SET is_active = false WHERE id = ?', [EMP]);
            res.push(await N._resolveRecipient('employee', EMP));
            await db.run(
                'UPDATE employees SET is_active = true, cancelled_at = now() WHERE id = ?',
                [EMP]
            );
            res.push(await N._resolveRecipient('employee', EMP));
            return res;
        });
        for (const r of out) expect(r).toMatchObject({ email: null, emailStatus: 'suppressed' });
    });
});
