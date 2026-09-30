'use strict';
/**
 * Notification-kind invariants — the two that keep the notification centre and
 * its emails honest, pinned so they cannot drift again:
 *
 *   1. Every kind with an email POLICY has display META.
 *      present() falls back to the raw kind string, so a policy-without-meta
 *      kind renders a literal "ninebox.approved" in the bell and produces the
 *      subject "IDevelop — ninebox.approved" in the mailbox. That has happened
 *      more than once as new kinds were added to one map only.
 *
 *   2. Every META deep link points at a route that is actually MOUNTED.
 *      A previous pass found several links that 404'd or bounced. This test
 *      loads the real router tree and matches each link against it, so adding a
 *      notification that links into a page nobody built fails here rather than
 *      under a user's click.
 *
 * DB-free: the router modules only need DATABASE_URL to be SET (a Pool is
 * constructed lazily and never connects during require).
 */

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/notification_kinds_test';
process.env.NODE_ENV = 'test';
// Most notification deep links live under /v2/*. Those routers used to be
// mounted only under V2_FEATURES=1; they are now ALWAYS mounted (behind their
// module switch, Administration → Modules), so the flag is deliberately NOT
// set here: the check proves the links resolve on a default install too.
delete process.env.V2_FEATURES;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'notification-kinds-test-secret';
process.env.API_KEY = process.env.API_KEY || 'notification-kinds-test-api-key';

const NotificationService = require('../../src/services/NotificationService');

/**
 * Express keeps a mounted sub-router's prefix only as the regexp it compiled
 * from it. Turn that back into the literal prefix so nested paths can be
 * rebuilt ('^\\/v2\\/cap\\/?(?=\\/|$)' → '/v2/cap').
 */
function mountPrefix(layer) {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    return layer.regexp.source
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\$$/, '')
        .replace(/\\\//g, '/');
}

function collectPaths(router) {
    const paths = new Set();
    (function walk(stack, prefix) {
        for (const layer of stack) {
            if (layer.route) {
                const p = layer.route.path;
                for (const one of Array.isArray(p) ? p : [p]) {
                    paths.add(prefix + (one === '/' ? '' : one) || '/');
                }
            } else if (layer.handle && layer.handle.stack) {
                walk(layer.handle.stack, prefix + mountPrefix(layer));
            }
        }
    })(router.stack, '');
    return paths;
}

let mounted;
beforeAll(() => {
    mounted = collectPaths(require('../../src/routes/index'));
});

describe('notification kinds', () => {
    test('the route inventory really loaded (guards against a vacuous test)', () => {
        expect(mounted.size).toBeGreaterThan(100);
        expect(mounted.has('/notifications')).toBe(true);
        expect(mounted.has('/dashboard')).toBe(true);
        // the /v2/* routers are mounted without V2_FEATURES.
        expect([...mounted].some((p) => p.startsWith('/v2/'))).toBe(true);
    });

    test('every kind in KIND_POLICY has a KIND_META entry', () => {
        const missing = Object.keys(NotificationService.KIND_POLICY).filter(
            (kind) => !NotificationService.KIND_META[kind]
        );
        expect(missing).toEqual([]);
    });

    test('every KIND_META link points at a mounted route', () => {
        const dead = Object.entries(NotificationService.KIND_META)
            .filter(([, meta]) => meta && meta.link)
            .filter(([, meta]) => !mounted.has(meta.link))
            .map(([kind, meta]) => `${kind} -> ${meta.link}`);
        expect(dead).toEqual([]);
    });

    test('every KIND_META entry carries an internal link, an icon and a FR+EN title', () => {
        const broken = [];
        for (const [kind, meta] of Object.entries(NotificationService.KIND_META)) {
            if (!meta.icon) broken.push(`${kind}: no icon`);
            // Relative, same-origin only — present() feeds these to a redirect.
            if (!meta.link || !meta.link.startsWith('/') || meta.link.startsWith('//'))
                broken.push(`${kind}: bad link ${meta.link}`);
            if (!meta.title || !meta.title.fr || !meta.title.en)
                broken.push(`${kind}: title missing fr/en`);
        }
        expect(broken).toEqual([]);
    });

    test('every emailable kind has a real bilingual body — no generic filler', () => {
        // 'none'-tier kinds are never emailed, so they need no message.
        const emailable = Object.entries(NotificationService.KIND_POLICY)
            .filter(([, tier]) => tier !== 'none')
            .map(([kind]) => kind);
        const missing = emailable.filter((kind) => {
            const m = NotificationService.KIND_MESSAGES[kind];
            return !m || !m.fr || !m.en;
        });
        expect(missing).toEqual([]);
    });

    test('subjects are localised, never the raw kind slug', () => {
        for (const kind of Object.keys(NotificationService.KIND_POLICY)) {
            const fr = NotificationService._subjectFor(kind, 'fr', 'ACME');
            const en = NotificationService._subjectFor(kind, 'en-GB', 'ACME');
            expect(fr).not.toContain(kind);
            expect(en).not.toContain(kind);
            expect(fr.startsWith('ACME — ')).toBe(true);
            expect(en.startsWith('ACME — ')).toBe(true);
            expect(fr).not.toBe(en); // FR and EN really differ
        }
    });
});

describe('quiet hours actually defer', () => {
    const at = (h, m = 0) => new Date(2026, 7, 21, h, m, 0, 0); // local wall clock
    const win = (start, end) => ({ quiet_hours_start: start, quiet_hours_end: end });

    test('a window that wraps past midnight holds the evening AND the small hours', () => {
        const p = win('22:00', '07:00');
        expect(NotificationService._inQuietHours(p, at(23, 30))).toBe(true);
        expect(NotificationService._inQuietHours(p, at(3))).toBe(true);
        expect(NotificationService._inQuietHours(p, at(9))).toBe(false);
        expect(NotificationService._inQuietHours(p, at(21, 59))).toBe(false);
    });

    test('a same-day window holds only that window', () => {
        const p = win('12:00', '14:00');
        expect(NotificationService._inQuietHours(p, at(13))).toBe(true);
        expect(NotificationService._inQuietHours(p, at(14))).toBe(false);
        expect(NotificationService._inQuietHours(p, at(11, 59))).toBe(false);
    });

    test('half a window, a malformed time or a zero-length window is NO window', () => {
        expect(NotificationService._window(win('22:00', null))).toBeNull();
        expect(NotificationService._window(win(null, '07:00'))).toBeNull();
        expect(NotificationService._window(win('08:00', '08:00'))).toBeNull();
        expect(NotificationService._window(win('99:99', '07:00'))).toBeNull();
        expect(NotificationService._inQuietHours(win('22:00', null), at(23))).toBe(false);
    });

    test('release_at is the END of the window, rolling to tomorrow when it wraps', () => {
        // Raised at 23:30 inside 22:00→07:00: released at 07:00 the NEXT morning,
        // not at 07:00 today (which is already past).
        const evening = NotificationService._releaseAt(win('22:00', '07:00'), at(23, 30));
        expect(evening.getHours()).toBe(7);
        expect(evening.getDate()).toBe(22);

        // Raised at 03:00 in the same window: released at 07:00 the same morning.
        const smallHours = NotificationService._releaseAt(win('22:00', '07:00'), at(3));
        expect(smallHours.getHours()).toBe(7);
        expect(smallHours.getDate()).toBe(21);

        // Outside the window there is nothing to defer.
        expect(NotificationService._releaseAt(win('22:00', '07:00'), at(12))).toBeNull();
        expect(NotificationService._releaseAt(null, at(12))).toBeNull();
    });

    test('the inbox predicate hides a row only while its window is open', () => {
        // The literal SQL every read path shares — if this changes, snoozed rows
        // become visible again and quiet hours are decorative once more.
        expect(NotificationService.VISIBLE_SQL).toBe(
            "(state <> 'snoozed' OR release_at IS NULL OR release_at <= now())"
        );
    });
});
