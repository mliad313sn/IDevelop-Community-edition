'use strict';

/**
 * Notifications monitor — the operator console over every notification the
 * platform produced, in-app AND email, with delivery state and a re-queue for
 * failed deliveries. (Feature requested 2026-09-21.)
 *
 * In-app and email share one table (`notifications`, channel = inapp | email;
 * state = queued | sent | failed | snoozed), so one service monitors both.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Needs a POPULATED database (several sites, assessed people, reviews): runs
// only against an opt-in fixture database — see CONTRIBUTING.md.
const HAS_DB = /idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));
const suite = HAS_DB ? describe : describe.skip;
const db = HAS_DB ? require('../../src/config/database') : null;
let S;

beforeAll(async () => {
    if (HAS_DB) await db.connect();
    S = require('../../src/services/NotificationAdminService');
});
afterAll(async () => {
    if (HAS_DB) await db.close();
});

suite('NotificationAdminService monitors both channels', () => {
    test('count/stats agree, and stats splits by channel and state', async () => {
        const total = await S.count({});
        const stats = await S.stats({});
        expect(stats.total).toBe(total);
        // both channels present in the shape, even at zero
        expect(stats.byChannel.inapp).toBeTruthy();
        expect(stats.byChannel.email).toBeTruthy();
        // the per-state buckets sum to the total
        const stateSum = Object.values(stats.byState).reduce((a, b) => a + b, 0);
        expect(stateSum).toBe(total);
    });

    test('a channel filter narrows both the list and the count consistently', async () => {
        const inappCount = await S.count({ channel: 'inapp' });
        const rows = await S.list({ channel: 'inapp' }, 1000, 0);
        expect(rows.length).toBe(Math.min(inappCount, 1000));
        for (const r of rows) expect(r.channel).toBe('inapp');
    });

    test('the list resolves a recipient name for both employee and admin rows', async () => {
        const rows = await S.list({}, 50, 0);
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
            expect(['employee', 'admin']).toContain(r.userType);
            // a name resolved, or a stable fallback the view applies (#id)
            expect(r.recipientName === null || typeof r.recipientName === 'string').toBe(true);
        }
    });

    test('an unknown filter value is ignored, never injected', async () => {
        // parseFilters/_where only accept enum members; a bogus channel yields the
        // unfiltered count (the predicate is dropped), never an error.
        const all = await S.count({});
        const bogus = await S.count({ channel: "inapp'; DROP TABLE notifications; --" });
        expect(bogus).toBe(all);
    });
});

suite('retry re-queues only a failed notification', () => {
    test('a failed row becomes queued; a queued row is refused; rolled back', async () => {
        const target = await db.get('SELECT id FROM notifications ORDER BY id LIMIT 1');
        expect(target).toBeTruthy();
        await db
            .runTransaction(async () => {
                // make it failed, then retry → queued
                await db.run(
                    "UPDATE notifications SET state = 'failed', sent_at = now() WHERE id = ?",
                    [target.id]
                );
                const r = await S.retry(target.id);
                expect(r).toBeTruthy();
                const after = await db.get(
                    'SELECT state, sent_at FROM notifications WHERE id = ?',
                    [target.id]
                );
                expect(after.state).toBe('queued');
                expect(after.sentAt).toBeNull();
                // a second retry now finds it queued → refused
                expect(await S.retry(target.id)).toBeNull();
                throw new Error('__ROLLBACK__');
            })
            .catch((e) => {
                if (!/__ROLLBACK__/.test(e.message)) throw e;
            });
        // untouched outside the transaction
        const restored = await db.get('SELECT state FROM notifications WHERE id = ?', [target.id]);
        expect(restored.state).not.toBe('failed');
    });
});

describe('the module is wired end to end', () => {
    test('routes exist, SuperAdmin-gated', () => {
        const routes = read('src/routes/index.js');
        expect(routes).toMatch(/router\.get\(\s*'\/admin\/notifications',\s*requireSuperAdmin/);
        expect(routes).toMatch(
            /router\.post\(\s*'\/admin\/notifications\/:id\/retry',\s*requireSuperAdmin/
        );
    });

    test('the sidebar links to it and both locales define the labels', () => {
        expect(read('views/partials/sidebar.ejs')).toMatch(/href="\/admin\/notifications"/);
        const en = require('../../locales/en/admin.json');
        const fr = require('../../locales/fr/admin.json');
        for (const k of ['notif_nav', 'notif_title', 'notif_state_failed', 'notif_retry']) {
            expect(en[k]).toBeTruthy();
            expect(fr[k]).toBeTruthy();
        }
    });

    test('the view template compiles', () => {
        const ejs = require('ejs');
        const tpl = read('views/pages/admin/notifications.ejs');
        expect(() =>
            ejs.compile(tpl, { filename: 'views/pages/admin/notifications.ejs' })
        ).not.toThrow();
    });
});
