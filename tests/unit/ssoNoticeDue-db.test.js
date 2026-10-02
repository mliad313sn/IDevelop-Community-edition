'use strict';
/**
 * « Notices SSO à remettre » (port item S2) on the REAL schema (idevelop_test*):
 * a printed notice is due for everyone who never received the e-mail — no
 * address ('skipped_no_email') AND e-mail off ('inapp_only') — not yet handed
 * over, judged on the person's LATEST invitation (a later e-mailed invitation
 * clears it; nobody counted twice). Counter, filter and the default print
 * selection agree. Everything runs in a rolled-back transaction.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const HAS_DB = /idevelop_test|idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''));

const ROLLBACK = new Error('sso-notice-due-rollback');
const SUPER = { id: 1, userType: 'admin', role: 'superadmin' };
let db;
let ready = false;
let Ctl;
let Inv;

beforeAll(async () => {
    if (!HAS_DB) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        ready = Boolean(
            await db.get(
                `SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'sso_migration_invites'`
            )
        );
    } catch (_) {
        ready = false;
    }
    Ctl = require('../../src/controllers/InvitationController');
    Inv = require('../../src/services/SsoInviteService');
}, 30000);

afterAll(async () => {
    if (db) await db.close().catch(() => {});
});

async function inRollback(fn) {
    try {
        await db.runTransaction(async () => {
            await fn();
            throw ROLLBACK;
        });
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

const ctx = () => ({
    expiryDays: 14,
    dormantDays: 30,
    policy: { maxAttempts: 5, lockoutMinutes: 30 },
});

test('the outbox is on the test database (not vacuous)', () => {
    if (!HAS_DB) return;
    expect(ready).toBe(true);
});

test('no address OR e-mail off, latest row, not handed over → one notice per person', async () => {
    if (!ready) return;
    await inRollback(async () => {
        // The test seed is small: add six people (rolled back with the rest).
        const tpl = await db.get(
            'SELECT site_id, department_id, service_id, role_id FROM employees ORDER BY id LIMIT 1'
        );
        for (let i = 0; i < 6; i++) {
            await db.run(
                `INSERT INTO employees (employee_number, first_name, last_name, site_id, department_id, service_id, role_id, is_active)
                 VALUES (?, 'Notice', ?, ?, ?, ?, ?, true)`,
                [`SSO-ND-${i}`, `Due ${i}`, tpl.siteId, tpl.departmentId, tpl.serviceId, tpl.roleId]
            );
        }
        const emps = await db.all(
            `SELECT e.id FROM employees e
              WHERE e.is_active = true AND e.erased_at IS NULL AND e.cancelled_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.linked_employee_id = e.id)
                AND NOT EXISTS (SELECT 1 FROM sso_migration_invites s WHERE s.subject_type = 'employee' AND s.subject_id = e.id)
              ORDER BY e.id LIMIT 6`
        );
        expect(emps).toHaveLength(6); // never vacuous
        const [a, b, c, d, e, f] = emps.map((x) => Number(x.id));
        const before = await Ctl._counters(SUPER, { siteId: null, departmentId: null }, ctx());
        const add = (id, provider, status, handed = false) =>
            db.run(
                `INSERT INTO sso_migration_invites (subject_type, subject_id, provider, trigger, status, sent_at, handed_over_at)
                 VALUES ('employee', ?, ?, 'manual', ?, now(), ${handed ? 'now()' : 'NULL'})`,
                [id, provider, status]
            );
        await add(a, 'idvp', 'skipped_no_email'); // no address → due
        await add(b, 'idvp', 'inapp_only'); // e-mail OFF → due (the fix)
        await add(c, 'idvp', 'sent'); // e-mailed → not due
        await add(d, 'idvp', 'inapp_only', true); // already handed over → not due
        await add(e, 'idvp', 'inapp_only'); // older row …
        await add(e, 'idvq', 'sent'); // … then e-mailed → not due
        await add(f, 'idvp', 'skipped_no_email'); // two due rows for one person …
        await add(f, 'idvq', 'inapp_only'); // … counted once

        const after = await Ctl._counters(SUPER, { siteId: null, departmentId: null }, ctx());
        expect(after.ssoNoticeDue - before.ssoNoticeDue).toBe(3); // a, b, f

        // The filter shows exactly those people.
        const { fromSql, params } = await Ctl._population(
            SUPER,
            { siteId: null, departmentId: null, state: 'sso_notice_due', q: '', requests: false },
            ctx()
        );
        const listed = (await db.all(`SELECT x.id ${fromSql}`, params)).map((r) => Number(r.id));
        expect(listed).toEqual(expect.arrayContaining([a, b, f]));
        for (const id of [c, d, e]) expect(listed).not.toContain(id);
        expect(listed.filter((id) => id === f)).toHaveLength(1);

        // The default print selection (no ?ids) is the same population.
        const spy = jest.spyOn(Inv, 'notices').mockResolvedValue([]);
        const req = { query: {}, user: SUPER, ip: '127.0.0.1', get: () => 'jest', t: (k) => k };
        await Ctl.ssoNotices(req, { render: () => {} });
        const printed = spy.mock.calls[0][1];
        spy.mockRestore();
        expect(printed).toEqual(expect.arrayContaining([a, b, f]));
        for (const id of [c, d, e]) expect(printed).not.toContain(id);
        expect(printed.filter((id) => id === f)).toHaveLength(1);
    });
}, 60000);
