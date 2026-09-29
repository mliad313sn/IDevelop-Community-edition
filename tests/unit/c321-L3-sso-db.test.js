'use strict';
/**
 * 3.23.21 lane L3 — on the REAL schema (idevelop_fixtures, migration 156), rolled back:
 *   ST-3 (a) the SuperAdmin guard writes an audit row when it unlinks a person;
 *   ST-3 (b) SET LOCAL app.skip_sso_invite (SsoInviteService.withoutInvites)
 *            stops the outbox triggers — and only inside `fn`;
 *   EXC      an employee SSO exception: SuperAdmin only, audited, excluded from
 *            the readiness gap count and listed; the invitation is held back
 *            and re-queued when the exception is removed; password reset allowed;
 *   ANN      the go-live announcement: 48 h before, once per account (ledger
 *            claim), exceptions excluded, not before the window, not after go-live.
 * E-mail is stubbed; SSO state is mocked; settings are stubbed per key.
 */
require('dotenv').config();
process.env.SSO_INVITE_PAUSE_MS = '0';

const mockSso = { enforced: false, providers: [], test: null };
jest.mock('../../src/config/sso', () => ({
    isConfigured: () => mockSso.enforced,
    isSsoIntended: () => mockSso.enforced,
    getEnabledProviders: () => mockSso.providers,
    getTestProvider: (k) => (mockSso.test && mockSso.test.key === k ? mockSso.test : null),
}));

const ROLLBACK = new Error('c321-L3-rollback');
let db;
let ready = false;
let EmailService;
let Inv;
let AdminSso;
let AppSettingsModel;
const settings = {};

beforeAll(async () => {
    if (!/idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''))) return;
    db = require('../../src/config/database');
    try {
        await db.connect();
        ready = Boolean(
            await db.get(
                `SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'sso_migration_announcements'`
            )
        );
    } catch (_) {
        ready = false;
    }
    EmailService = require('../../src/services/EmailService');
    Inv = require('../../src/services/SsoInviteService');
    AdminSso = require('../../src/services/AdminSsoService');
    AppSettingsModel = require('../../src/models/AppSettingsModel');
}, 30000);

afterAll(async () => {
    if (db) await db.close().catch(() => {});
});

let sent;
beforeEach(() => {
    sent = [];
    mockSso.enforced = false;
    mockSso.providers = [];
    mockSso.test = null;
    for (const k of Object.keys(settings)) delete settings[k];
    settings['ssoInvite.batchSize'] = 500;
    settings['sso.goLiveAt'] = '';
    if (EmailService) {
        jest.spyOn(EmailService, 'isEnabled').mockResolvedValue(true);
        jest.spyOn(EmailService, 'send').mockImplementation(async (m) => {
            sent.push(m);
            return { sent: true };
        });
    }
    if (AppSettingsModel) {
        const real = AppSettingsModel.getValue.bind(AppSettingsModel);
        jest.spyOn(AppSettingsModel, 'getValue').mockImplementation(async (k, d) =>
            Object.prototype.hasOwnProperty.call(settings, k) ? settings[k] : real(k, d)
        );
    }
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
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;
const someEmployees = (n) =>
    db.all(
        `SELECT e.id FROM employees e
          WHERE e.is_active = true AND e.is_account_active = true AND e.erased_at IS NULL AND e.cancelled_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.linked_employee_id = e.id)
          ORDER BY e.id LIMIT ?`,
        [n]
    );
const superadmin = () =>
    db.get(
        "SELECT id FROM admins WHERE role = 'superadmin' AND is_active = true ORDER BY id LIMIT 1"
    );
const ident = (type, id, provider, uid, method) =>
    db.run(
        `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid, link_method)
         VALUES (?, ?, ?, ?, ?)`,
        [type, Number(id), provider, uid, method]
    );
const invites = (id) =>
    db.all(
        "SELECT * FROM sso_migration_invites WHERE subject_type = 'employee' AND subject_id = ? ORDER BY id",
        [Number(id)]
    );
const localIso = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

test('migration 156 is on the test database (not vacuous)', () => {
    if (!/idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''))) return;
    expect(ready).toBe(true);
});

test('ST-3 (a) — promoting a linked admin to SuperAdmin unlinks the person AND leaves an audit row', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const [emp] = await someEmployees(1);
        const s = stamp();
        const a = await db.get(
            `INSERT INTO admins (username, email, password_hash, role, is_active, linked_employee_id)
             VALUES (?, ?, 'x', 'localadmin', true, ?) RETURNING id`,
            [`c321l3-${s}`, `c321l3-${s}@corp.test`, Number(emp.id)]
        );
        await db.run("UPDATE admins SET role = 'superadmin' WHERE id = ?", [a.id]);
        const row = await db.get('SELECT linked_employee_id AS le FROM admins WHERE id = ?', [
            a.id,
        ]);
        expect(row).toEqual({ le: null });
        const logs = await db.all(
            "SELECT details FROM system_logs WHERE action = 'ADMIN_SUPERADMIN_UNLINKED_PERSON' AND entity_id = ?",
            [a.id]
        );
        expect(logs).toHaveLength(1);
        expect(JSON.stringify(logs[0].details)).toMatch(new RegExp(`employee #${emp.id}`));
        // a SuperAdmin update that changes nothing about the link → no second row
        await db.run('UPDATE admins SET email = ? WHERE id = ?', [`x${s}@corp.test`, a.id]);
        const again = await db.all(
            "SELECT 1 FROM system_logs WHERE action = 'ADMIN_SUPERADMIN_UNLINKED_PERSON' AND entity_id = ?",
            [a.id]
        );
        expect(again).toHaveLength(1);
    });
});

test('ST-3 (b) — withoutInvites: no invitation queued inside, queued again right after', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const [e1, e2] = await someEmployees(2);
        const s = stamp();
        const P = `c321p${s}`;
        await Inv.withoutInvites(() => ident('employee', e1.id, P, `m-${s}`, 'superadmin_link'));
        expect(await invites(e1.id)).toEqual([]);
        await ident('employee', e2.id, P, `n-${s}`, 'superadmin_link');
        expect((await invites(e2.id)).map((r) => r.trigger)).toEqual(['superadmin_link']);
    });
});

test('EXC — SuperAdmin only, audited; readiness lists it and does not count it; reset allowed', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const [emp] = await someEmployees(1);
        const sa = await superadmin();
        const local = await db.get(
            "SELECT id FROM admins WHERE role = 'localadmin' AND is_active = true ORDER BY id LIMIT 1"
        );
        const id = Number(emp.id);
        // make it a gap first (no identity, no mapping)
        await db.run(
            "DELETE FROM user_identities WHERE subject_type = 'employee' AND subject_id = ?",
            [id]
        );
        await db.run('UPDATE employees SET external_id = NULL WHERE id = ?', [id]);
        const pend = await db.get(
            "SELECT 1 AS x FROM sso_pending_links WHERE employee_id = ? AND status = 'pending'",
            [id]
        );
        if (pend) return; // not a gap on this database: nothing to measure
        const before = await AdminSso.readiness();

        if (local) {
            const refused = await AdminSso.setSsoException(
                id,
                { on: true, reason: 'r' },
                { id: local.id, userType: 'admin', role: 'superadmin' }
            );
            expect(refused).toEqual({ ok: false, code: 'superadmin_only' }); // DB role wins over the claim
        }
        expect(
            await AdminSso.setSsoException(
                id,
                { on: true, reason: '  ' },
                { id: sa.id, userType: 'admin' }
            )
        ).toEqual({ ok: false, code: 'reason_required' });
        expect(
            await AdminSso.setSsoException(
                id,
                { on: true, reason: 'Pas de compte Entra (atelier)' },
                { id: sa.id, userType: 'admin' }
            )
        ).toEqual({ ok: true, code: 'set' });
        expect(await AdminSso.hasSsoException(id)).toBe(true);

        const after = await AdminSso.readiness();
        expect(after.employeesWithoutSso).toBe(before.employeesWithoutSso - 1);
        expect(after.noSsoAccessCount).toBe(before.noSsoAccessCount - 1);
        expect(after.employeesExcepted.map((x) => x.id)).toContain(id);

        const audit = await db.all(
            "SELECT action FROM system_logs WHERE entity_type = 'employee' AND entity_id = ? AND action LIKE 'EMPLOYEE_SSO_EXCEPTION_%' ORDER BY id",
            [id]
        );
        expect(audit.map((r) => r.action)).toEqual(['EMPLOYEE_SSO_EXCEPTION_SET']);

        // password reset: allowed for the exception while enforced, refused for another employee
        mockSso.enforced = true;
        const Reset = require('../../src/services/PasswordResetService');
        const [other] = await db.all(
            'SELECT id FROM employees WHERE id <> ? AND sso_exception_at IS NULL ORDER BY id LIMIT 1',
            [id]
        );
        expect(await Reset.resetAllowed('employee', id)).toBe(true);
        expect(await Reset.resetAllowed('employee', other.id)).toBe(false);
    });
});

test('EXC — the invitation is held back (cancelled, sso_exception) and re-queued when the exception is removed', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const [emp] = await someEmployees(1);
        const sa = await superadmin();
        const id = Number(emp.id);
        const s = stamp();
        const P = `c321q${s}`;
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [`exc-${s}@corp.test`, id]);
        await ident('employee', id, P, `e-${s}`, 'superadmin_link');
        await AdminSso.setSsoException(
            id,
            { on: true, reason: 'atelier' },
            { id: sa.id, userType: 'admin' }
        );
        mockSso.enforced = true;
        mockSso.providers = [{ key: P, label: 'Contoso' }];
        await Inv.dispatch({ pauseMs: 0 });
        let [row] = await invites(id);
        expect([row.status, row.lastError ?? row.last_error]).toEqual([
            'cancelled',
            'sso_exception',
        ]);
        expect(sent.filter((m) => m.to === `exc-${s}@corp.test`)).toHaveLength(0);

        await AdminSso.setSsoException(id, { on: false }, { id: sa.id, userType: 'admin' });
        [row] = await invites(id);
        expect(row.status).toBe('pending');
        await Inv.dispatch({ pauseMs: 0 });
        [row] = await invites(id);
        expect(row.status).toBe('sent');
        expect(sent.filter((m) => m.to === `exc-${s}@corp.test`)).toHaveLength(1);
    });
});

test('ANN — 48 h before go-live: once per account, exceptions excluded, only a /login link; not before, not after', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const [a, b] = await someEmployees(2);
        const sa = await superadmin();
        const s = stamp();
        const P = `c321a${s}`;
        for (const e of [a, b]) {
            await db.run('UPDATE employees SET email = ? WHERE id = ?', [
                `ann-${e.id}-${s}@corp.test`,
                e.id,
            ]);
            await ident('employee', e.id, P, `u${e.id}-${s}`, 'superadmin_link');
        }
        await AdminSso.setSsoException(
            b.id,
            { on: true, reason: 'atelier' },
            { id: sa.id, userType: 'admin' }
        );
        // the saved (test-only) SAML connection while the switch is off
        mockSso.test = { key: P, label: 'Sign in with Contoso' };
        await Inv.dispatch({ pauseMs: 0 }); // not live → rows parked waiting_sso
        const mine = () =>
            sent.filter((m) => /^ann-/.test(m.to) && m.to.endsWith(`-${s}@corp.test`));

        // go-live in 5 days → not due yet (48 h lead)
        settings['sso.goLiveAt'] = localIso(new Date(Date.now() + 5 * 86400000));
        settings['sso.announceLeadHours'] = 48;
        expect((await Inv.announce()).skipped).toBe('not_due');
        expect(mine()).toHaveLength(0);

        // go-live in 30 hours → inside the window: exactly one notice, to A only
        const goLive = new Date(Date.now() + 30 * 3600000);
        settings['sso.goLiveAt'] = localIso(goLive);
        await Inv.dispatch({ pauseMs: 0 });
        await Inv.announce(); // a rerun never sends twice
        expect(mine().map((m) => m.to)).toEqual([`ann-${a.id}-${s}@corp.test`]);
        const m = mine()[0];
        expect(m.subject).toMatch(
            /À partir du .* connexion avec votre compte Contoso \/ .*From .*: sign in with your Contoso account/
        );
        expect(m.text).toMatch(
            /À partir du .*, vous vous connecterez à .* avec votre compte Contoso/
        );
        const links = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
        for (const l of links) expect(l).toMatch(/^https?:\/\/[^?#]+\/login$/);
        const ledger = await db.all(
            'SELECT subject_id, status FROM sso_migration_announcements WHERE subject_type = ? AND subject_id IN (?, ?)',
            ['employee', a.id, b.id]
        );
        expect(ledger.map((r) => [Number(r.subjectId ?? r.subject_id), r.status])).toEqual([
            [Number(a.id), 'sent'],
        ]);
        // the invitation itself is untouched (still waiting for go-live)
        expect((await invites(a.id))[0].status).toBe('waiting_sso');

        // after go-live → nothing
        settings['sso.goLiveAt'] = localIso(new Date(Date.now() - 3600000));
        expect((await Inv.announce()).skipped).toBe('past');
    });
});

test('ANN — two concurrent passes send ONE notice (ledger claimed before sending)', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const [a] = await someEmployees(1);
        const s = stamp();
        const P = `c321c${s}`;
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [`cc-${s}@corp.test`, a.id]);
        await ident('employee', a.id, P, `c-${s}`, 'superadmin_link');
        settings['sso.goLiveAt'] = localIso(new Date(Date.now() + 3600000)); // closer than 48 h → at once
        await Promise.all([Inv.announce(), Inv.announce()]);
        expect(sent.filter((m) => m.to === `cc-${s}@corp.test`)).toHaveLength(1);
    });
});
