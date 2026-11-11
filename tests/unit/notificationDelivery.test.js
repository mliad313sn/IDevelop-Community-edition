'use strict';

/**
 * E-mail delivery of notifications (SA-47, migration 182):
 *   - a recipient who has left, was voided or erased is never e-mailed
 *     (suppressed, and the outcome is recorded);
 *   - safety and security kinds are mandatory: they ignore the person's own
 *     e-mail switch and the per-domain toggle, never the global switch, and
 *     a tier-'none' kind is never e-mailed;
 *   - a failed send is retried for 24 hours (1 h, then 23 h later), then
 *     abandoned; a skip is never retried; a retry to a leaver is suppressed;
 *   - the daily digest lists only new, digestible, not-yet-e-mailed items,
 *     marks them digested, and its subject carries no count;
 *   - the outgoing webhook never runs on the caller's transaction client and
 *     carries no figure, name or free text.
 * The database is a scripted fake: each test states what the tables hold.
 */
const mockState = {};
const mockDb = {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    runInSavepoint: jest.fn(async (fn) => fn()),
};
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (key, d) => (key === 'appName' ? 'Acme' : d)),
    setValue: jest.fn(async () => true),
}));
const mockEmail = {
    isEnabled: jest.fn(),
    isCategoryEnabled: jest.fn(),
    send: jest.fn(),
};
jest.mock('../../src/services/EmailService', () => mockEmail);
const mockHook = { emit: jest.fn(), minimisePayload: null };
jest.mock('../../src/services/WebhookService', () => mockHook);

process.env.APP_BASE_URL = 'https://app.example.test';

const N = require('../../src/services/NotificationService');
const catalogue = require('../../src/services/notificationCatalogue');
mockHook.minimisePayload = jest.requireActual('../../src/services/WebhookService').minimisePayload;

function reset(over = {}) {
    Object.assign(mockState, {
        employee: {
            email: 'jo@example.test',
            firstName: 'Jo',
            isActive: true,
            cancelledAt: null,
            erasedAt: null,
        },
        admin: { email: 'root@example.test', username: 'root', isActive: true },
        emailPref: null, // { enabled: false } = the person switched e-mail OFF
        quiet: null,
        listRows: [],
        outstandingRows: [],
        dueRows: [],
        retryRows: [],
        ...over,
    });
    mockDb.get.mockImplementation(async (sql) => {
        if (/FROM employees WHERE id/.test(sql)) return mockState.employee;
        if (/FROM admins WHERE id/.test(sql)) return mockState.admin;
        if (/kind = '__all__' AND channel = 'email'/.test(sql)) return mockState.emailPref;
        if (/quiet_hours_start, quiet_hours_end FROM notification_preferences/.test(sql))
            return mockState.quiet;
        return null;
    });
    mockDb.all.mockImplementation(async (sql) => {
        if (/FROM notification_preferences/.test(sql)) return [];
        if (/GROUP BY kind/.test(sql)) return mockState.outstandingRows;
        if (/SET email_status = 'sending'/.test(sql) && !/SET state = 'queued'/.test(sql))
            return mockState.retryRows;
        if (/SET state = 'queued'/.test(sql) && /RETURNING/.test(sql)) return mockState.dueRows;
        if (/FROM notifications/.test(sql) && /channel = 'inapp'/.test(sql))
            return mockState.listRows;
        return [];
    });
    mockDb.run.mockImplementation(async () => ({ changes: 1 }));
    mockEmail.isEnabled.mockResolvedValue(true);
    mockEmail.isCategoryEnabled.mockResolvedValue(true);
    mockEmail.send.mockResolvedValue({ sent: true });
    mockHook.emit.mockReset();
}

const runs = (re) => mockDb.run.mock.calls.filter(([sql]) => re.test(sql));
const emailInserts = () =>
    runs(/INSERT INTO notifications/).filter(([sql]) => /email_status/.test(sql));

beforeEach(() => reset());

const IMMEDIATE = 'sa.changes_requested';
const MANDATORY = 'safety.blocked';
const kindOfTier = (tier) =>
    Object.keys(N.KIND_POLICY).find((k) => N._tier(k) === tier && !N._isMandatory(k));
const notify = (over = {}) =>
    N.notify({ userType: 'employee', userId: 7, kind: IMMEDIATE, category: 'validation', ...over });

describe('suppression: a person who left, was voided or erased is never e-mailed', () => {
    test.each([
        ['inactive (leaver)', { isActive: false }],
        ['voided (cancelled_at)', { cancelledAt: new Date() }],
        ['erased (erased_at)', { erasedAt: new Date() }],
    ])('%s → suppressed, nothing sent, the outcome recorded', async (_l, patch) => {
        mockState.employee = { ...mockState.employee, ...patch };
        const r = await notify();
        expect(r.email).toBe('suppressed');
        expect(r.inapp).toBe('queued'); // the in-app row is still written
        expect(mockEmail.send).not.toHaveBeenCalled();
        const [sql, params] = emailInserts()[0];
        expect(sql).toMatch(/email_status/);
        expect(params).toContain('suppressed');
    });

    test('a mandatory kind is suppressed too: leaving ends every mail', async () => {
        mockState.employee = { ...mockState.employee, isActive: false };
        const r = await notify({ kind: MANDATORY, category: 'compliance' });
        expect(r.email).toBe('suppressed');
        expect(mockEmail.send).not.toHaveBeenCalled();
    });

    test('a deactivated admin is suppressed; an active employee is mailed', async () => {
        mockState.admin = { ...mockState.admin, isActive: false };
        expect(await N._resolveRecipient('admin', 1)).toMatchObject({
            email: null,
            emailStatus: 'suppressed',
        });
        const r = await notify();
        expect(r.email).toBe('sent');
        expect(mockEmail.send).toHaveBeenCalledTimes(1);
    });
});

describe('mandatory safety and security mails', () => {
    test('exactly the safety and security kinds are mandatory', () => {
        const mandatory = catalogue
            .kinds()
            .filter((k) => !catalogue.MAIL_ONLY[k] && catalogue.isMandatory(k));
        expect(mandatory.length).toBeGreaterThan(10);
        for (const k of mandatory) expect(k).toMatch(/^(safety|security)\./);
        for (const k of catalogue.kinds())
            if (/^(safety|security)\./.test(k)) expect(catalogue.isMandatory(k)).toBe(true);
    });

    test('e-mail OFF for the person + domain toggle OFF: a mandatory mail still goes, a normal one does not', async () => {
        mockState.emailPref = { enabled: false };
        mockEmail.isCategoryEnabled.mockResolvedValue(false);
        expect((await notify()).email).toBe('user_opt_out');
        expect(mockEmail.send).not.toHaveBeenCalled();
        const must = await notify({ kind: MANDATORY, category: 'compliance' });
        expect(must.email).toBe('sent');
        expect(must.mandatory).toBe(true);
        const mail = mockEmail.send.mock.calls[0][0];
        expect(mail.headers['List-Unsubscribe']).toBeUndefined();
        expect(mail.html).toContain('Message obligatoire');
    });

    test('the GLOBAL e-mail switch still applies to a mandatory mail', async () => {
        mockEmail.isEnabled.mockResolvedValue(false);
        mockEmail.isCategoryEnabled.mockResolvedValue(false);
        expect((await notify({ kind: MANDATORY })).email).toBe('disabled');
        expect(mockEmail.send).not.toHaveBeenCalled();
    });

    test('a mandatory kind is sent now even on a digest tier; a tier-none kind never', async () => {
        const tier = jest.spyOn(catalogue, 'tierOf').mockReturnValue('digest');
        expect((await notify({ kind: MANDATORY })).email).toBe('sent');
        tier.mockReturnValue('none');
        expect((await notify({ kind: MANDATORY })).email).toBe('policy_none');
        tier.mockRestore();
        expect(mockEmail.send).toHaveBeenCalledTimes(1);
        const digestKind = kindOfTier('digest');
        expect((await notify({ kind: digestKind })).email).toBe('digest_deferred');
    });

    test('a HELD mandatory mail ignores the opt-out at release; a normal one honours it', async () => {
        mockState.emailPref = { enabled: false };
        const held = (kind) => ({
            id: 77,
            user_type: 'employee',
            user_id: 7,
            kind,
            locale: 'fr',
            payload: JSON.stringify({
                __pendingEmail: {
                    subject: 'Acme — Votre habilitation sécurité : à consulter',
                    html: '<p>x</p>',
                    text: 'x',
                    headers: { 'Auto-Submitted': 'auto-generated' },
                },
            }),
        });
        mockState.dueRows = [held(MANDATORY)];
        const out = await N.releaseSnoozed();
        expect(out.emailsSent).toBe(1);
        expect(mockEmail.send.mock.calls[0][0].headers).toEqual({
            'Auto-Submitted': 'auto-generated',
        });
        mockEmail.send.mockClear();
        mockState.dueRows = [held(IMMEDIATE)];
        await N.releaseSnoozed();
        expect(mockEmail.send).not.toHaveBeenCalled();
    });
});

describe('the mail handed to EmailService', () => {
    test('headers, no empty attachment list; the greeting names the recipient; payload.link is the CTA; the in-app row is marked', async () => {
        await notify({ payload: { link: '/employee/self-assessment/42' } });
        const mail = mockEmail.send.mock.calls[0][0];
        expect(mail.to).toBe('jo@example.test');
        expect(mail.headers).toMatchObject({
            'Auto-Submitted': 'auto-generated',
            'X-Auto-Response-Suppress': 'All',
            'List-Unsubscribe': '<https://app.example.test/account/notifications>',
        });
        expect(mail.attachments).toBeUndefined(); // no logo configured: no attachment at all
        expect(mail.html).toContain('Bonjour Jo,');
        expect(mail.html).toContain('href="https://app.example.test/employee/self-assessment/42"');
        expect(mail.subject).toBe(N._subjectFor(IMMEDIATE, 'fr', 'Acme'));
        const [, params] = runs(/SET email_status = 'emailed'/)[0];
        expect(params).toEqual(['employee', 7, IMMEDIATE]);
    });

    test('blocks are rendered; the caller’s title is the headline, NEVER the subject', async () => {
        await notify({
            title: 'Votre équipe — Jo Martin — 3 revues',
            blocks: [{ type: 'kv', rows: [['Échéance', '31/10/2026']] }],
            ctaUrl: '/notifications',
        });
        const mail = mockEmail.send.mock.calls[0][0];
        expect(mail.subject).toBe(N._subjectFor(IMMEDIATE, 'fr', 'Acme'));
        expect(mail.subject).not.toMatch(/Jo Martin|\d/);
        expect(mail.html).toContain('Votre équipe — Jo Martin — 3 revues');
        expect(mail.text).toContain('Échéance : 31/10/2026');
    });

    test('a legacy subject / html / text is ignored: the mail is always the renderer’s', async () => {
        await notify({
            subject: 'Jo Martin — 12/20 — rejected',
            html: '<html><body><script>alert(1)</script></body></html>',
            text: 'raw',
        });
        const mail = mockEmail.send.mock.calls[0][0];
        expect(mail.subject).toBe(N._subjectFor(IMMEDIATE, 'fr', 'Acme'));
        expect(mail.html).not.toContain('<script>');
        expect((mail.html.match(/<html/g) || []).length).toBe(1);
    });

    test('one language per mail: the site’s mail language when the recipient’s is not known', async () => {
        const settings = require('../../src/models/AppSettingsModel');
        settings.getValue.mockImplementation(async (key, d) =>
            key === 'mailDefaultLanguage' ? 'en' : key === 'appName' ? 'Acme' : d
        );
        await notify();
        const mail = mockEmail.send.mock.calls[0][0];
        expect(mail.html).toMatch(/<html lang="en"/);
        expect(mail.text).toMatch(/^Hello Jo,/);
        expect(mail.text).not.toMatch(/Bonjour|Cordialement/);
        settings.getValue.mockImplementation(async (key, d) => (key === 'appName' ? 'Acme' : d));
    });
});

describe('outbox: a failed send is retried for 24 hours, then abandoned', () => {
    test('first failure → « retry », 1 attempt, next in 1 h, address masked, rendered mail kept', async () => {
        mockEmail.send.mockResolvedValue({
            sent: false,
            error: 'connect ECONNREFUSED for jo@example.test',
        });
        const before = Date.now();
        const r = await notify();
        expect(r.emailStatus).toBe('retry');
        const [, params] = emailInserts()[0];
        // (user_type, user_id, kind, locale, payload, state, email_status, attempts, next, error)
        expect(params[5]).toBe('failed');
        expect(params[6]).toBe('retry');
        expect(params[7]).toBe(1);
        const next = params[8].getTime();
        expect(next - before).toBeGreaterThanOrEqual(3600e3 - 1000);
        expect(next - before).toBeLessThanOrEqual(3600e3 + 5000);
        expect(params[9]).toContain('j***@example.test');
        expect(params[9]).not.toContain('jo@example.test');
        expect(JSON.parse(params[4]).__pendingEmail.subject).toMatch(/^Acme — /);
    });

    test('_outcome: 1 → retry (+1 h), 2 → retry (+23 h), 3 → abandoned; a skip is never retried', () => {
        const t0 = new Date('2026-10-03T10:00:00Z');
        const err = { sent: false, error: 'boom' };
        const o1 = N._outcome(err, 1, t0);
        const o2 = N._outcome(err, 2, t0);
        const o3 = N._outcome(err, 3, t0);
        expect(o1).toMatchObject({ emailStatus: 'retry', state: 'failed' });
        expect(o1.nextAttemptAt.getTime() - t0.getTime()).toBe(3600e3);
        expect(o2.nextAttemptAt.getTime() - t0.getTime()).toBe(23 * 3600e3);
        expect(o3).toMatchObject({ emailStatus: 'abandoned', nextAttemptAt: null });
        // The whole ladder fits in 24 hours.
        expect(N.EMAIL_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(24 * 3600e3);
        expect(N._outcome({ sent: false, skipped: 'disabled' }, 1).emailStatus).toBe('skipped');
        expect(N._outcome({ sent: true }, 2)).toMatchObject({ state: 'sent', emailStatus: 'sent' });
    });

    test('_safeError masks every address, in linear time, and caps the length', () => {
        expect(N._safeError('to a.b@x.test and c@y.test failed')).toBe(
            'to a***@x.test and c***@y.test failed'
        );
        const long = 'a'.repeat(50000) + '@';
        const t = Date.now();
        expect(N._safeError(long).length).toBeLessThanOrEqual(500);
        expect(Date.now() - t).toBeLessThan(500);
        expect(N._safeError(null)).toBeNull();
    });

    const stored = (attempts) => ({
        id: 91,
        user_type: 'employee',
        user_id: 7,
        kind: IMMEDIATE,
        locale: 'fr',
        email_attempts: attempts,
        payload: JSON.stringify({
            __pendingEmail: {
                subject: 'Acme — X',
                html: '<p>x</p>',
                text: 'x',
                headers: { 'Auto-Submitted': 'auto-generated' },
            },
        }),
    });
    const updateFor = (id) =>
        runs(/UPDATE notifications\s+SET state = \?/).find(([, p]) => p[p.length - 1] === id);

    test('the release tick walks a row: 2nd failure → retry, 3rd → abandoned, success → sent', async () => {
        mockEmail.send.mockResolvedValue({ sent: false, error: 'timeout' });
        mockState.retryRows = [stored(1)];
        let out = await N.releaseSnoozed();
        expect(out.retried).toBe(1);
        let [, p] = updateFor(91);
        expect(p.slice(0, 3)).toEqual(['failed', 'retry', 2]);
        expect(p[3]).toBeInstanceOf(Date);

        mockDb.run.mockClear();
        mockState.retryRows = [stored(2)];
        out = await N.releaseSnoozed();
        expect(out.abandoned).toBe(1);
        expect(out.failed).toBe(1);
        [, p] = updateFor(91);
        expect(p.slice(0, 4)).toEqual(['failed', 'abandoned', 3, null]);

        mockDb.run.mockClear();
        mockEmail.send.mockResolvedValue({ sent: true });
        mockState.retryRows = [stored(1)];
        out = await N.releaseSnoozed();
        expect(out.emailsSent).toBe(1);
        [, p] = updateFor(91);
        expect(p.slice(0, 3)).toEqual(['sent', 'sent', 2]);
    });

    test('a retry to a person who has left since is suppressed, not sent', async () => {
        mockState.employee = { ...mockState.employee, isActive: false };
        mockState.retryRows = [stored(1)];
        await N.releaseSnoozed();
        expect(mockEmail.send).not.toHaveBeenCalled();
        const [, p] = updateFor(91);
        expect(p[1]).toBe('suppressed');
    });

    test('the retry claim is a lease: due retries, and « sending » rows older than an hour', async () => {
        await N.releaseSnoozed();
        const sql = mockDb.all.mock.calls
            .map(([s]) => s)
            .find((s) => /email_status = 'retry' AND next_attempt_at <= now\(\)/.test(s));
        expect(sql).toMatch(
            /email_status = 'sending' AND next_attempt_at <= now\(\) - interval '1 hour'/
        );
        expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    });
});

describe('the daily digest', () => {
    const t = new Date();
    const row = (id, kind, extra = {}) => ({
        id,
        kind,
        payload: '{}',
        locale: 'fr',
        created_at: t,
        ...extra,
    });

    test('only new, digestible, not-yet-e-mailed items; marked digested; no count in the subject', async () => {
        const none = kindOfTier('none');
        mockState.listRows = [
            row(1, IMMEDIATE),
            row(2, none),
            row(3, 'sa.approved', { email_status: 'emailed' }),
        ];
        mockState.outstandingRows = [
            { kind: IMMEDIATE, c: 3 },
            { kind: none, c: 5 }, // never counted
        ];
        const r = await N.sendDigest({ userType: 'employee', userId: 7, locale: 'fr' });
        expect(r).toMatchObject({ sent: true, count: 1, outstanding: 3 });
        const mail = mockEmail.send.mock.calls[0][0];
        const title = (k) => N.KIND_META[k].title.fr;
        expect(mail.html).toContain(title(IMMEDIATE));
        expect(mail.html).not.toContain(title(none));
        expect(mail.html).not.toContain(title('sa.approved'));
        expect(mail.text).toContain(
            '3 notifications plus anciennes toujours en attente : https://app.example.test/notifications'
        );
        expect(mail.subject).toBe('Acme — Votre récapitulatif');
        expect(mail.html).toContain('1 nouveauté pour vous aujourd');
        const listSql = mockDb.all.mock.calls
            .map(([s]) => s)
            .find((s) => /LIMIT \?/.test(s) && /inapp/.test(s));
        expect(listSql).toMatch(/email_status IS NULL/);
        expect(runs(/SET email_status = 'digested'/)[0][1]).toEqual([1]);
    });

    test('nothing new ⇒ no mail at all', async () => {
        mockState.listRows = [
            row(2, kindOfTier('none')),
            row(3, IMMEDIATE, { emailStatus: 'emailed' }),
        ];
        mockState.outstandingRows = [{ kind: IMMEDIATE, c: 9 }];
        const r = await N.sendDigest({ userType: 'employee', userId: 7 });
        expect(r.skipped).toBe('empty');
        expect(mockEmail.send).not.toHaveBeenCalled();
    });

    test('a leaver gets no digest', async () => {
        mockState.listRows = [row(1, IMMEDIATE)];
        mockState.employee = { ...mockState.employee, erasedAt: new Date() };
        const r = await N.sendDigest({ userType: 'employee', userId: 7 });
        expect(r.skipped).toBe('suppressed');
        expect(mockEmail.send).not.toHaveBeenCalled();
    });
});

describe('the outgoing webhook', () => {
    test('it never runs on the caller’s transaction client', async () => {
        const { AsyncLocalStorage } = require('async_hooks');
        const als = new AsyncLocalStorage();
        mockDb._txStore = als;
        const seen = [];
        mockHook.emit.mockImplementation(async () => {
            seen.push(als.getStore());
        });
        try {
            await als.run({ client: 'tx' }, () => notify());
        } finally {
            delete mockDb._txStore;
        }
        expect(seen).toEqual([undefined]);
    });

    test('it carries ids, dates and the link only: no figure, no name, no free text', async () => {
        await notify({
            kind: 'dept_digest',
            category: 'digest',
            payload: {
                figures: [{ key: 'headcount', value: 57 }],
                reason: 'Saisie faite sur le mauvais collaborateur.',
                name: 'Jo Martin',
                link: '/reports/dept-analytics',
                cycleId: 12,
                closesOn: '2026-10-31',
            },
        });
        await new Promise((r) => setImmediate(r));
        const [kind, data] = mockHook.emit.mock.calls[0];
        expect(kind).toBe('dept_digest');
        expect(data.payload).toEqual({
            link: '/reports/dept-analytics',
            cycleId: 12,
            closesOn: '2026-10-31',
        });
        expect(JSON.stringify(data)).not.toMatch(/57|mauvais collaborateur|Jo Martin/);
    });
});

describe('a notify() without payload still records the in-app row (NOT NULL payload)', () => {
    test('the in-app INSERT gets « {} », not NULL', async () => {
        await notify();
        const [, params] = runs(/INSERT INTO notifications/).find(
            ([sql, p]) => !/email_status/.test(sql) && p[2] === 'inapp'
        );
        expect(params[5]).toBe('{}');
    });
});
