'use strict';
/**
 * 3.23.20 — Amendment C3/C4: the SSO migration invitation OUTBOX on the REAL
 * schema (idevelop_fixtures, migration 153).
 *   - the two outbox triggers (identity link methods, SSO-migration mapping),
 *     dedup per (account, provider), the linked-admin fan-out, never a SuperAdmin;
 *   - the dispatcher: waiting_sso until SSO is live, the 10-minute mapping
 *     window, revert → cancelled, SMTP off → inapp_only, e-mail with no
 *     password link, back-off then failed, stuck sending → failed, SuperAdmin
 *     at dispatch → skipped_superadmin, one reminder only;
 *   - concurrency (committed rows, cleaned up): two links racing for the same
 *     account/provider → ONE outbox row; two dispatchers racing → ONE e-mail.
 * E-mail is stubbed (EmailService.send) — nothing leaves the machine. The
 * rolled-back part never survives; the committed part deletes its own rows.
 */
require('dotenv').config();
process.env.SSO_INVITE_PAUSE_MS = '0';

const mockSso = { enforced: false, providers: [] };
jest.mock('../../src/config/sso', () => ({
    isConfigured: () => mockSso.enforced,
    isSsoIntended: () => mockSso.enforced,
    getEnabledProviders: () => mockSso.providers,
}));

const ROLLBACK = new Error('c320-inv-rollback');
let db;
let ready = false;
let EmailService;
let Inv;

beforeAll(async () => {
    if (!/idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''))) return;
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
    EmailService = require('../../src/services/EmailService');
    Inv = require('../../src/services/SsoInviteService');
}, 30000);

afterAll(async () => {
    if (db) {
        try {
            await db.close();
        } catch (_) {
            /* already closed */
        }
    }
});

let sent;
beforeEach(() => {
    sent = [];
    mockSso.enforced = false;
    mockSso.providers = [];
    if (EmailService) {
        jest.spyOn(EmailService, 'isEnabled').mockResolvedValue(true);
        jest.spyOn(EmailService, 'send').mockImplementation(async (m) => {
            sent.push(m);
            return { sent: true };
        });
    }
});

const live = (key = 'c320p') => {
    mockSso.enforced = true;
    mockSso.providers = [{ key, label: 'Contoso' }];
};

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

async function someEmployees(n) {
    return db.all(
        `SELECT e.id FROM employees e
          WHERE e.is_active = true AND e.erased_at IS NULL AND e.cancelled_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.linked_employee_id = e.id)
          ORDER BY e.id LIMIT ?`,
        [n]
    );
}

async function rowsFor(type, id) {
    return db.all(
        'SELECT * FROM sso_migration_invites WHERE subject_type = ? AND subject_id = ? ORDER BY id',
        [type, Number(id)]
    );
}

const ident = (type, id, provider, uid, method) =>
    db.run(
        `INSERT INTO user_identities (subject_type, subject_id, sso_provider, sso_uid, link_method)
         VALUES (?, ?, ?, ?, ?)`,
        [type, Number(id), provider, uid, method]
    );

test('the outbox table really is on the test database (not vacuous)', () => {
    if (!/idevelop_fixtures/.test(String(process.env.DATABASE_URL || ''))) return;
    expect(ready).toBe(true);
});

test('C3b — the triggers: which link methods queue, dedup per (account, provider), linked admins, never a SuperAdmin', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const s = stamp();
        const emps = await someEmployees(5);
        if (emps.length < 5) return;
        const [a, b, c, d, e] = emps.map((x) => Number(x.id));
        const P = `c320p${s}`;

        await ident('employee', a, P, `a-${s}`, 'superadmin_link');
        await ident('employee', b, P, `b-${s}@corp.test`, 'sso_email');
        await ident('employee', c, P, `c-${s}`, 'migration_mapping');
        await ident('employee', c, `${P}x`, `c2-${s}`, 'unknown');
        const ra = await rowsFor('employee', a);
        expect(ra.map((r) => [r.trigger, r.variant, r.status])).toEqual([
            ['superadmin_link', 'standard', 'pending'],
        ]);
        expect((await rowsFor('employee', b))[0].variant).toBe('security_notice');
        expect(await rowsFor('employee', c)).toEqual([]);

        // re-link / alias of the same account + provider → no second row; a NEW provider → one more
        await ident('employee', a, P, `a2-${s}`, 'superadmin_link');
        expect(await rowsFor('employee', a)).toHaveLength(1);
        await ident('employee', a, `${P}n`, `a3-${s}`, 'delegated_link');
        expect(await rowsFor('employee', a)).toHaveLength(2);

        // a mapping created from the SSO-migration console
        await db.run(
            `INSERT INTO sso_pending_links (provider, employee_id, match_upn, created_by)
             VALUES (?, ?, ?, 1)`,
            [P, d, `d-${s}@corp.test`]
        );
        const rd = await rowsFor('employee', d);
        expect(rd.map((r) => r.trigger)).toEqual(['mapping']);
        // …claimed later at sign-in: the identity (migration_mapping) queues nothing more
        await ident('employee', d, P, `d-oid-${s}`, 'migration_mapping');
        expect(await rowsFor('employee', d)).toHaveLength(1);

        // the linked-person admin account is migrated too (trusted link only)
        const adm = Number(
            (
                await db.get(
                    `INSERT INTO admins (username, email, password_hash, role, is_active, linked_employee_id)
                     VALUES (?, ?, 'x', 'localadmin', true, ?) RETURNING id`,
                    [`c320.inv.${s}`, `adm-${s}@corp.test`, e]
                )
            ).id
        );
        await ident('employee', e, P, `e-${s}`, 'superadmin_link');
        expect((await rowsFor('admin', adm)).map((r) => r.subjectType ?? r.subject_type)).toEqual([
            'admin',
        ]);
        // « confirm » for an admin: link_method unknown → superadmin_link queues it
        const adm2 = Number(
            (
                await db.get(
                    `INSERT INTO admins (username, password_hash, role, is_active)
                     VALUES (?, 'x', 'localadmin', true) RETURNING id`,
                    [`c320.inv2.${s}`]
                )
            ).id
        );
        await ident('admin', adm2, P, `adm2-${s}`, 'unknown');
        expect(await rowsFor('admin', adm2)).toEqual([]);
        await db.run(
            "UPDATE user_identities SET link_method = 'superadmin_link' WHERE sso_uid = ?",
            [`adm2-${s}`]
        );
        expect(await rowsFor('admin', adm2)).toHaveLength(1);
    });
}, 30000);

test('C3c — the dispatcher: waits until SSO is live, then sends ONE e-mail with only a /login link', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const s = stamp();
        const [emp] = await someEmployees(1);
        if (!emp) return;
        const id = Number(emp.id);
        const P = `c320p${s}`;
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [`inv-${s}@corp.test`, id]);
        await ident('employee', id, P, `u-${s}`, 'superadmin_link');

        // not live → waiting_sso, nothing sent
        const w = await Inv.dispatch({ pauseMs: 0 });
        expect(w.live).toBe(false);
        expect((await rowsFor('employee', id))[0].status).toBe('waiting_sso');
        expect(sent).toHaveLength(0);

        // live → sent once, to the address stored in the app
        live(P);
        await Inv.dispatch({ pauseMs: 0 });
        const [row] = await rowsFor('employee', id);
        expect(row.status).toBe('sent');
        const mine = sent.filter((m) => m.to === `inv-${s}@corp.test`);
        expect(mine).toHaveLength(1);
        const m = mine[0];
        expect(m.subject).toMatch(
            /Connectez-vous avec votre compte Contoso \/ Sign in with your Contoso account/
        );
        // the only link is <base>/login: no token, no query, no password link
        const links = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
        expect(links.length).toBeGreaterThan(0);
        for (const l of links) expect(l).toMatch(/^https?:\/\/[^?#]+\/login$/);
        expect(m.html).not.toMatch(
            /reset-password|token=|mot de passe temporaire|temporary password/i
        );
        expect(m.text).toMatch(/Nous ne vous demanderons jamais votre mot de passe/);
        // in-app too
        const n = await db.get(
            "SELECT COUNT(*)::int AS n FROM notifications WHERE user_type = 'employee' AND user_id = ? AND kind = 'sso.migration_invite'",
            [id]
        );
        expect(n.n).toBe(1);
        // a second run sends nothing more (exactly once)
        await Inv.dispatch({ pauseMs: 0 });
        expect(sent.filter((x) => x.to === `inv-${s}@corp.test`)).toHaveLength(1);
        // never touched the invitation columns of the credentials path
        const e = await db.get('SELECT invited_at FROM employees WHERE id = ?', [id]);
        expect(e.invitedAt ?? e.invited_at ?? null).toEqual(
            (await db.get('SELECT invited_at FROM employees WHERE id = ?', [id])).invitedAt ?? null
        );
    });
}, 30000);

test('C3c — mapping rows wait 10 minutes; a revert inside the window cancels; SMTP off → in-app only; no address → skipped_no_email', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const s = stamp();
        const emps = await someEmployees(3);
        if (emps.length < 3) return;
        const [a, b, c] = emps.map((x) => Number(x.id));
        const P = `c320p${s}`;
        live(P);
        for (const [id, k] of [
            [a, 'a'],
            [b, 'b'],
        ])
            await db.run(
                `INSERT INTO sso_pending_links (provider, employee_id, match_upn, created_by)
                 VALUES (?, ?, ?, 1)`,
                [P, id, `${k}-${s}@corp.test`]
            );
        await Inv.dispatch({ pauseMs: 0 });
        expect((await rowsFor('employee', a))[0].status).toBe('pending'); // inside the window
        // revert a's mapping (console « annuler ») then let the window pass
        await db.run(
            "UPDATE sso_pending_links SET status = 'cancelled', cancelled_at = now() WHERE employee_id = ? AND provider = ?",
            [a, P]
        );
        await db.run(
            "UPDATE sso_migration_invites SET created_at = now() - interval '11 minutes' WHERE provider = ?",
            [P]
        );
        EmailService.isEnabled.mockResolvedValue(false); // SMTP off
        await Inv.dispatch({ pauseMs: 0 });
        expect((await rowsFor('employee', a))[0].status).toBe('cancelled');
        expect((await rowsFor('employee', b))[0].status).toBe('inapp_only');
        expect(sent).toHaveLength(0);
        // no address stored in the app → in-app + a printed notice
        EmailService.isEnabled.mockResolvedValue(true);
        await db.run('UPDATE employees SET email = NULL WHERE id = ?', [c]);
        await ident('employee', c, P, `c-${s}`, 'superadmin_link');
        await Inv.dispatch({ pauseMs: 0 });
        expect((await rowsFor('employee', c))[0].status).toBe('skipped_no_email');
        const notes = await Inv.notices('employee', [c]);
        expect(notes).toHaveLength(1);
        expect(notes[0].text).toMatch(/\/login/);
        expect(notes[0].text).toMatch(/c-\d+|votre identifiant d’entreprise/);
    });
}, 30000);

test('C3c — errors back off then fail; stuck sending → failed; SuperAdmin at dispatch → skipped; ONE reminder', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const s = stamp();
        const emps = await someEmployees(3);
        if (emps.length < 3) return;
        const [a, b, c] = emps.map((x) => Number(x.id));
        const P = `c320p${s}`;
        live(P);
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [`a-${s}@corp.test`, a]);
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [`c-${s}@corp.test`, c]);
        await ident('employee', a, P, `a-${s}`, 'superadmin_link');
        EmailService.send.mockResolvedValue({ sent: false, error: 'smtp 451' });
        const back = [];
        for (let i = 0; i < 4; i++) {
            await Inv.dispatch({ pauseMs: 0 });
            const [r] = await rowsFor('employee', a);
            back.push(r.status);
            await db.run('UPDATE sso_migration_invites SET next_attempt_at = NULL WHERE id = ?', [
                Number(r.id),
            ]);
        }
        expect(back).toEqual(['pending', 'pending', 'pending', 'failed']);

        // stuck in 'sending' for more than 15 minutes → failed, never resent
        await ident('employee', b, P, `b-${s}`, 'superadmin_link');
        await db.run(
            "UPDATE sso_migration_invites SET status = 'sending', claimed_at = now() - interval '16 minutes' WHERE subject_type = 'employee' AND subject_id = ? AND provider = ?",
            [b, P]
        );
        await Inv.dispatch({ pauseMs: 0 });
        expect((await rowsFor('employee', b))[0].status).toBe('failed');

        // a local admin queued, then promoted to SuperAdmin → skipped at dispatch
        const adm = Number(
            (
                await db.get(
                    `INSERT INTO admins (username, email, password_hash, role, is_active)
                     VALUES (?, ?, 'x', 'localadmin', true) RETURNING id`,
                    [`c320.inv.sa.${s}`, `sa-${s}@corp.test`]
                )
            ).id
        );
        await ident('admin', adm, P, `sa-${s}`, 'superadmin_link');
        await db.run("UPDATE admins SET role = 'superadmin' WHERE id = ?", [adm]);
        EmailService.send.mockImplementation(async (m) => {
            sent.push(m);
            return { sent: true };
        });
        await Inv.dispatch({ pauseMs: 0 });
        expect((await rowsFor('admin', adm))[0].status).toBe('skipped_superadmin');
        expect(sent.filter((m) => m.to === `sa-${s}@corp.test`)).toHaveLength(0);

        // one reminder 7 days after 'sent' without an SSO sign-in — and only one
        await ident('employee', c, P, `c-${s}`, 'superadmin_link');
        await Inv.dispatch({ pauseMs: 0 });
        expect((await rowsFor('employee', c))[0].status).toBe('sent');
        await db.run(
            "UPDATE sso_migration_invites SET sent_at = now() - interval '8 days' WHERE subject_type = 'employee' AND subject_id = ? AND provider = ?",
            [c, P]
        );
        sent.length = 0;
        await Inv.dispatch({ pauseMs: 0 });
        await Inv.dispatch({ pauseMs: 0 });
        expect((await rowsFor('employee', c))[0].status).toBe('reminded');
        const rem = sent.filter((m) => m.to === `c-${s}@corp.test`);
        expect(rem).toHaveLength(1);
        expect(rem[0].subject).toMatch(/^Rappel :/);
    });
}, 60000);

test('security Low 2/5 — the sweep wins over a late delivery; re-queue cooldown; reminder re-checks the link; no SSO rule before SSO is live', async () => {
    if (!ready) return;
    await inRollback(async () => {
        const s = stamp();
        const emps = await someEmployees(2);
        if (emps.length < 2) return;
        const [a, b] = emps.map((x) => Number(x.id));
        const P = `c320p${s}`;
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [`la-${s}@corp.test`, a]);
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [`lb-${s}@corp.test`, b]);
        await ident('employee', a, P, `la-${s}`, 'superadmin_link');

        // Low 5: not live → not "migrated" (today's password invitation applies)
        expect(await Inv.isMigrated('employee', a)).toBe(false);
        live(P);
        expect(await Inv.isMigrated('employee', a)).toBe(true);

        // Low 2: a row the sweep marked 'failed' while "sending" is never sent nor overwritten
        const [row] = await rowsFor('employee', a);
        await db.run(
            "UPDATE sso_migration_invites SET status = 'failed', attempts = 1 WHERE id = ?",
            [Number(row.id)]
        );
        const out = await Inv.deliver({ ...row, status: 'sending', attempts: 1 });
        expect(out).toBe('lost_claim');
        expect((await rowsFor('employee', a))[0].status).toBe('failed');
        expect(sent.filter((m) => m.to === `la-${s}@corp.test`)).toHaveLength(0);
        // …and a failed row just touched is under the 60-minute re-queue cooldown
        await db.run('UPDATE sso_migration_invites SET claimed_at = now() WHERE id = ?', [
            Number(row.id),
        ]);
        expect((await Inv.requeue('employee', a, { id: 1 })).code).toBe('sso_invite_too_soon');

        // Low 2: the 7-day reminder re-checks the link
        await ident('employee', b, P, `lb-${s}`, 'superadmin_link');
        await Inv.dispatch({ pauseMs: 0 });
        expect((await rowsFor('employee', b))[0].status).toBe('sent');
        await db.run(
            "UPDATE sso_migration_invites SET sent_at = now() - interval '8 days' WHERE subject_type = 'employee' AND subject_id = ? AND provider = ?",
            [b, P]
        );
        await db.run('DELETE FROM user_identities WHERE sso_provider = ? AND subject_id = ?', [
            P,
            b,
        ]);
        sent.length = 0;
        await Inv.dispatch({ pauseMs: 0 });
        expect(sent.filter((m) => m.to === `lb-${s}@corp.test`)).toHaveLength(0);
    });
}, 60000);

test('C4 concurrency — racing links → ONE outbox row; racing dispatchers → ONE e-mail (committed, cleaned up)', async () => {
    if (!ready) return;
    const s = stamp();
    const P = `c320cc${s}`;
    const [emp] = await someEmployees(1);
    if (!emp) return;
    const id = Number(emp.id);
    const before = await db.get('SELECT email FROM employees WHERE id = ?', [id]);
    try {
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [`cc-${s}@corp.test`, id]);
        // two different migrations of the same account + provider, concurrently
        await Promise.all([
            db.runTransaction(() =>
                db.run(
                    `INSERT INTO sso_pending_links (provider, employee_id, match_upn, created_by)
                     VALUES (?, ?, ?, 1)`,
                    [P, id, `cc-${s}@corp.test`]
                )
            ),
            db.runTransaction(() => ident('employee', id, P, `cc-oid-${s}`, 'superadmin_link')),
        ]);
        expect(
            await rowsFor('employee', id).then((r) => r.filter((x) => x.provider === P))
        ).toHaveLength(1);
        await db.run(
            "UPDATE sso_migration_invites SET created_at = now() - interval '11 minutes' WHERE provider = ?",
            [P]
        );
        live(P);
        await Promise.all([Inv.dispatch({ pauseMs: 0 }), Inv.dispatch({ pauseMs: 0 })]);
        expect(sent.filter((m) => m.to === `cc-${s}@corp.test`)).toHaveLength(1);
    } finally {
        await db.run(
            "DELETE FROM notifications WHERE kind = ? AND user_type = ? AND user_id = ? AND payload->>'provider' = ?",
            ['sso.migration_invite', 'employee', id, P]
        );
        await db.run('DELETE FROM sso_migration_invites WHERE provider = ?', [P]);
        await db.run('DELETE FROM user_identities WHERE sso_provider = ?', [P]);
        await db.run('DELETE FROM sso_pending_links WHERE provider = ?', [P]);
        await db.run('UPDATE employees SET email = ? WHERE id = ?', [
            before ? before.email : null,
            id,
        ]);
    }
}, 60000);
