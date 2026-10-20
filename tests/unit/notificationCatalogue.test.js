'use strict';

/**
 * The notification catalogue (src/services/notificationCatalogue.js) declares
 * EVERY kind IDevelop emits — IDevelop's own included (360° feedback,
 * one-to-one topics, safety waivers and contests, scheduled reports, the
 * SuperAdmin reset of an assessment) — each with its category, severity,
 * e-mail tier, mandatory flag, webhook rule and FR/EN title and subject.
 *
 * Two nets catch a kind that is emitted but not declared:
 *   1. here, a scan of every file that emits notifications: each kind-like
 *      literal is declared, or listed below as NOT a kind (ledger keys,
 *      permissions, maker-checker kinds) with the reason;
 *   2. at run time, NotificationService reports an undeclared kind and
 *      tests/helpers/dbSuiteLockSetup.js fails the suite that emitted it.
 */
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/notification_catalogue';

const fs = require('fs');
const path = require('path');
const catalogue = require('../../src/services/notificationCatalogue');
const N = require('../../src/services/NotificationService');

const ROOT = path.join(__dirname, '../..');

/** Literals that look like kinds in emitter files but are NOT notification kinds. */
const NOT_KINDS = new Map([
    // The authority ladder's actions (AuthorityService.ACTIONS), named where a
    // service asks the ladder: they are rights, never notification kinds.
    ['coaching.act', 'authority ladder action'],
    ['coaching.manage', 'authority ladder action'],
    ['idp.act', 'authority ladder action'],
    ['lms.uplift', 'authority ladder action'],
    ['ninebox.approve', 'authority ladder action'],
    ['ninebox.draft', 'authority ladder action'],
    ['pip.act', 'authority ladder action'],
    ['sa.approve', 'authority ladder action'],
    ['sa.validate', 'authority ladder action'],
    ['cycle.autolock', 'reminder_log ledger key of a campaign transition'],
    ['cycle.closure_proposed', 'reminder_log ledger key of a campaign transition'],
    ['cycle.manual_nudge', 'nudge_log ledger key'],
    ['cycle.not_started', 'nudge_log ledger key'],
    ['cycle.overdue', 'reminder_log ledger key of a campaign transition'],
    ['cycle.review_pending', 'reminder_log ledger key (weekly reviewer reminder)'],
    ['cycle.team_d7', 'reminder_log ledger key (the D-7 line message)'],
    ['dept_brief.noscope', 'job result reason'],
    ['digest.any', 'reminder_log ledger key of the department brief'],
    ['dispute.reason', 'locale key'],
    ['idp.signoff', 'reminder_log ledger key'],
    ['lifecycle.leaver.admin_revoked', 'lifecycle cascade step name'],
    ['lifecycle.leaver.plans_closed', 'lifecycle cascade step name'],
    ['ninebox.reassess', 'reminder_log ledger key'],
    ['onboarding.enabled', 'app setting key'],
    ['pip.create', 'maker-checker request kind'],
    ['retention.high', 'reminder_log ledger key'],
    ['sa.employee_id', 'SQL column reference'],
    ['safety.read', 'permission name'],
    ['succession.review', 'reminder_log ledger key'],
]);

function emitterFiles() {
    const files = [];
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) files.push(p);
        }
    })(path.join(ROOT, 'src'));
    const EMITTER = /\b(notify|enqueue|enqueueBulkInApp|_notify|alert)\s*\(/;
    return files
        .filter((f) => !f.endsWith('notificationCatalogue.js'))
        .map((f) => ({ f, src: fs.readFileSync(f, 'utf8') }))
        .filter(({ src }) => EMITTER.test(src));
}

describe('every kind IDevelop emits is declared', () => {
    const families = new Set(catalogue.kinds().map((k) => k.split('.')[0]));

    test('no kind-like literal in an emitter file is left undeclared', () => {
        const LIT = /(['"`])([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\1/g;
        const undeclared = new Map();
        const seenNotKinds = new Set();
        const files = emitterFiles();
        expect(files.length).toBeGreaterThan(25); // guards against a vacuous scan
        for (const { f, src } of files) {
            let m;
            while ((m = LIT.exec(src))) {
                const v = m[2];
                if (!families.has(v.split('.')[0]) || catalogue.isDeclared(v)) continue;
                if (NOT_KINDS.has(v)) {
                    seenNotKinds.add(v);
                    continue;
                }
                undeclared.set(v, path.relative(ROOT, f));
            }
        }
        expect([...undeclared]).toEqual([]);
        // The list of non-kinds stays honest: none is declared, none is stale.
        for (const k of NOT_KINDS.keys()) expect(catalogue.isDeclared(k)).toBe(false);
        expect([...NOT_KINDS.keys()].filter((k) => !seenNotKinds.has(k))).toEqual([]);
    });

    test('the kinds built at run time are declared too', () => {
        // SafetyGateService: `${kind}.team` for kind in safety.blocked / safety.expiring.
        for (const k of ['safety.blocked', 'safety.expiring'])
            expect(catalogue.isDeclared(`${k}.team`)).toBe(true);
        // jobs/reminders.js prefers these when declared (kindFor), and falls back
        // to the second; both are declared.
        for (const k of [
            'ninebox.reassess_due',
            'talent.plan_due',
            'handover.due',
            'account.dormant',
            'access.expiry',
            'access.review',
        ])
            expect(catalogue.isDeclared(k)).toBe(true);
        // AssessmentChangeRequestService: granted / refused.
        expect(catalogue.isDeclared('sa.change_request_granted')).toBe(true);
        expect(catalogue.isDeclared('sa.change_request_refused')).toBe(true);
    });

    test.each([
        'feedback360.nominate',
        'feedback360.approve',
        'feedback360.invited',
        'feedback360.reminder',
        'feedback360.closed',
        'feedback360.released',
        'oneonone.topic_added',
        'safety.waiver_granted',
        'safety.waiver_granted.team',
        'safety.waiver_ended',
        'safety.waiver_ended.team',
        'safety.contest.review',
        'safety.contest.decided',
        'report.schedule_ready',
        'report.schedule_suspended',
        'sa.reset_for_redo',
        'sa.review_reset',
        'ops.hris_plan_ready',
        'ops.hris_sync_alert',
    ])('IDevelop kind %s is declared in full', (kind) => {
        const d = catalogue.describe(kind);
        expect(d).not.toBeNull();
        expect(catalogue.CATEGORIES).toContain(d.category);
        expect(Object.keys(catalogue.SEVERITY_LEVELS)).toContain(d.severity);
        expect(d.title.fr).toBeTruthy();
        expect(d.title.en).toBeTruthy();
        expect(d.subject.fr).toBeTruthy();
        expect(d.subject.en).toBeTruthy();
    });

    test('a kind written at run time that is not declared is reported', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(N._checkDeclared('sa.submitted')).toBe(true);
        expect(N._checkDeclared('not.a.declared.kind')).toBe(false);
        expect(global.__undeclaredNotificationKinds.has('not.a.declared.kind')).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not\.a\.declared\.kind/));
        // This suite emitted it on purpose: clear it so the afterAll net passes.
        global.__undeclaredNotificationKinds.clear();
        warn.mockRestore();
    });
});

describe('every declaration is complete', () => {
    const kinds = catalogue.kinds();

    test('the catalogue is not empty', () => {
        expect(kinds.length).toBeGreaterThan(100);
    });

    test('category, severity, tier, mandatory, webhook, FR/EN title and subject for every kind', () => {
        const bad = [];
        for (const k of kinds) {
            const d = catalogue.describe(k);
            if (!catalogue.CATEGORIES.includes(d.category)) bad.push(`${k}: category`);
            if (!Object.keys(catalogue.SEVERITY_LEVELS).includes(d.severity))
                bad.push(`${k}: severity`);
            if (!['immediate', 'digest', 'none'].includes(d.tier)) bad.push(`${k}: tier`);
            if (typeof d.mandatory !== 'boolean') bad.push(`${k}: mandatory`);
            if (!['default', 'opt-in', 'never'].includes(d.webhook)) bad.push(`${k}: webhook`);
            for (const l of ['fr', 'en']) {
                if (!d.title[l]) bad.push(`${k}: title.${l}`);
                if (!d.subject[l]) bad.push(`${k}: subject.${l}`);
            }
        }
        expect(bad).toEqual([]);
    });

    test('every category has a label in both languages', () => {
        for (const c of catalogue.CATEGORIES) {
            expect(catalogue.CATEGORY_LABELS[c].fr).toBeTruthy();
            expect(catalogue.CATEGORY_LABELS[c].en).toBeTruthy();
        }
    });

    test('one language per mail: an English mail never carries a French body', () => {
        const T = require('../../src/utils/emailTemplate');
        for (const k of kinds.filter((x) => catalogue.KIND_MESSAGES[x])) {
            const m = catalogue.KIND_MESSAGES[k];
            if (m.fr === m.en) continue;
            const en = T.compose({ kind: k, locale: 'en' }, { brand: { appName: 'Acme' } }).text;
            const fr = T.compose({ kind: k, locale: 'fr' }, { brand: { appName: 'Acme' } }).text;
            expect([k, en.includes(m.en), en.includes(m.fr)]).toEqual([k, true, false]);
            expect([k, fr.includes(m.fr), fr.includes(m.en)]).toEqual([k, true, false]);
        }
    });

    test('mandatory kinds sit in a mandatory category', () => {
        for (const k of kinds.filter((x) => catalogue.isMandatory(x) && !catalogue.MAIL_ONLY[x]))
            expect(catalogue.MANDATORY_CATEGORIES).toContain(catalogue.categoryOf(k));
    });

    test('mail-only kinds never have an in-app row nor a webhook', () => {
        for (const k of Object.keys(catalogue.MAIL_ONLY)) {
            expect(catalogue.webhookOf(k)).toBe('never');
            expect(catalogue.KIND_POLICY[k]).toBeUndefined();
        }
    });
});

describe('webhook rule (decision 8): the catalogue and WebhookService agree', () => {
    const Hook = require('../../src/services/WebhookService');

    test('the default list is the same', () => {
        expect([...catalogue.WEBHOOK_DEFAULT].sort()).toEqual([...Hook.EMITTABLE_EVENTS].sort());
    });

    test('for every declared kind, « default » ⇔ it leaves with no opt-in', () => {
        for (const k of catalogue.kinds())
            expect([k, catalogue.webhookOf(k) === 'default']).toEqual([k, Hook.isEmittable(k)]);
    });

    test('360° feedback and one-to-one kinds never leave by default; a SuperAdmin may opt in', () => {
        for (const k of catalogue.kinds().filter((x) => /^(feedback360|oneonone)\./.test(x))) {
            expect(catalogue.webhookOf(k)).toBe('opt-in');
            expect(Hook.isEmittable(k)).toBe(false);
            expect(Hook.isEmittable(k, Hook.parseOptIn(k))).toBe(true);
        }
        for (const k of ['ops.hris_plan_ready', 'ops.hris_sync_alert'])
            expect(catalogue.webhookOf(k)).toBe('never');
    });

    test('confidential families never leave, whatever the opt-in', () => {
        for (const k of catalogue.kinds().filter((x) => /^(pip|ninebox|retention|privacy)/.test(x)))
            expect(catalogue.webhookOf(k)).toBe('never');
    });
});

describe('subjects: no person name, no figure, no status', () => {
    const hostile = {
        name: 'Jo Martin',
        employeeName: 'Jo Martin',
        fullName: 'Jo Martin',
        reason: 'Refusé : niveau 2/4',
        count: 12,
        pending: 7,
        days: 3,
        cycle: 'C-2026-T4',
        report: 'Rapport secret 2026',
        closesOn: '2026-10-31',
        provider: 'entra',
        variant: 'standard',
        link: '/x',
    };

    test.each(catalogue.kinds().map((k) => [k]))('%s', (kind) => {
        for (const lang of ['fr', 'en']) {
            const plain = N._subjectFor(kind, lang, 'Acme');
            const rendered = N._compose(
                { kind, payload: hostile, locale: lang, title: 'Jo Martin — 12 revues' },
                { brand: { appName: 'Acme' }, recipientName: 'Jo' }
            ).subject;
            expect(rendered).toBe(plain);
            expect(plain.startsWith('Acme — ')).toBe(true);
            // « 360° » is the name of a feature, not a figure.
            expect(plain.replace(/360°/g, '')).not.toMatch(/\d/);
            expect(plain).not.toMatch(/Jo Martin|C-2026|secret|Refusé/);
            expect(plain).not.toContain(kind);
        }
    });

    test('a decision or a status is never stated in a subject', () => {
        const STATUS =
            /rejet|refus|approuv|annul|bloqu|retiré|validé|plan de performance|rejected|refused|approved|cancelled|blocked|revoked|validated|performance plan/i;
        // The SuperAdmin security alerts name the EVENT (a refused sign-in, a
        // locked administrator account), never a person: that is their point.
        const EVENT_ALERTS = /^security\.(superadmin_|breakglass_|admin_account_locked)/;
        for (const kind of catalogue.kinds().filter((k) => !EVENT_ALERTS.test(k)))
            for (const lang of ['fr', 'en'])
                expect([kind, lang, STATUS.test(catalogue.subjectOf(kind, lang))]).toEqual([
                    kind,
                    lang,
                    false,
                ]);
    });
});

describe('the development loop kinds (4.0.0 port, wave 4)', () => {
    const LOOP = [
        'idp.action_due',
        'idp.action_reported',
        'idp.action_validated',
        'idp.completed',
        'idp.proposal_received',
        'idp.proposal_decided',
        'lms.uplift_accepted',
        'lms.uplift_declined',
    ];

    test.each(LOOP.map((k) => [k]))(
        '%s: development module, digest tier, leaves by webhook by default',
        (kind) => {
            const d = catalogue.describe(kind);
            expect(d).toMatchObject({
                category: 'development',
                module: 'development',
                tier: 'digest',
                mandatory: false,
                webhook: 'default',
            });
            for (const lang of ['fr', 'en']) {
                expect(typeof catalogue.KIND_MESSAGES[kind][lang]).toBe('string');
                expect(d.title[lang]).toBeTruthy();
            }
        }
    );

    test('a decision is told in the title, never in the subject', () => {
        for (const kind of [
            'idp.action_validated',
            'idp.proposal_decided',
            'lms.uplift_accepted',
            'lms.uplift_declined',
        ])
            for (const lang of ['fr', 'en'])
                expect(catalogue.subjectOf(kind, lang)).toBe(
                    lang === 'fr'
                        ? 'Du nouveau sur votre développement'
                        : 'An update on your development'
                );
    });

    test('counts only in the subtitle, never a name', () => {
        expect(catalogue.subtitleOf('idp.action_due', { count: 3, overdue: 1 }, 'en')).toBe(
            '3 actions, 1 overdue'
        );
        expect(catalogue.subtitleOf('idp.action_due', { count: 1 }, 'fr')).toBe(
            '1 action à échéance'
        );
        expect(catalogue.subtitleOf('lms.uplift_accepted', { skills: 2 }, 'en')).toBe(
            '2 skills at the validated level'
        );
        expect(catalogue.subtitleOf('idp.action_due', { name: 'Jo' }, 'en')).toBeNull();
    });

    test('the closing hooks are measured: reminder effectiveness counts them as acted', () => {
        for (const k of ['idp.action_due', 'idp.action_reported', 'idp.proposal_received'])
            expect(N.ACTED_KINDS).toContain(k);
        expect(N._refOf('idp.proposal_received', { proposalId: 9 }, {})).toEqual({
            refType: 'dev_proposal',
            refId: '9',
        });
    });
});

describe('the communications kinds (4.0.0 port, wave 7)', () => {
    test('cycle.team_reminder: a count to the line, digest tier, leaves by webhook by default', () => {
        expect(catalogue.describe('cycle.team_reminder')).toMatchObject({
            category: 'evaluations',
            module: null,
            severity: 'echeance',
            tier: 'digest',
            mandatory: false,
            webhook: 'default',
        });
        expect(catalogue.subtitleOf('cycle.team_reminder', { count: 3, cycle: 'C-7' }, 'en')).toBe(
            '3 not started — campaign C-7'
        );
        expect(catalogue.subtitleOf('cycle.team_reminder', { count: 1, cycle: 'C-7' }, 'fr')).toBe(
            '1 personne n’a pas commencé — campagne C-7'
        );
        // no count or no campaign: no complement, never « 0 »
        expect(catalogue.subtitleOf('cycle.team_reminder', { cycle: 'C-7' }, 'fr')).toBeNull();
        expect(
            catalogue.subtitleOf('cycle.team_reminder', { count: 2, name: 'Jo' }, 'en')
        ).toBeNull();
    });

    test('dispute.hr_reminder: its own kind, immediate, never by webhook', () => {
        expect(catalogue.describe('dispute.hr_reminder')).toMatchObject({
            category: 'evaluations',
            severity: 'echeance',
            tier: 'immediate',
            webhook: 'never',
        });
        expect(catalogue.subtitleOf('dispute.hr_reminder', { count: 2 }, 'en')).toBe(
            '2 disputes due in two days'
        );
        for (const lang of ['fr', 'en'])
            expect(typeof catalogue.KIND_MESSAGES['dispute.hr_reminder'][lang]).toBe('string');
    });

    test('a wave-6 reminder row (dispute.escalated + reminder) still reads as a reminder', () => {
        expect(catalogue.subtitleOf('dispute.escalated', { count: 1, reminder: true }, 'en')).toBe(
            'Reminder: a level-2 deadline is two days away'
        );
        expect(catalogue.subtitleOf('dispute.escalated', { count: 1 }, 'en')).toBeNull();
        // a reminder flag that is not exactly true changes nothing
        expect(catalogue.subtitleOf('dispute.escalated', { reminder: 'yes' }, 'fr')).toBeNull();
    });

    test('dispute.proposal carries its answer date in the body, never in the subject', () => {
        expect(catalogue.subtitleOf('dispute.proposal', { respondBy: '2026-11-04' }, 'fr')).toBe(
            'Répondez avant le 04/11/2026'
        );
        expect(catalogue.subtitleOf('dispute.proposal', { respondBy: '2026-11-04' }, 'en')).toBe(
            'Answer by 04/11/2026'
        );
        expect(catalogue.subtitleOf('dispute.proposal', { respondBy: 'soon' }, 'en')).toBeNull();
        expect(catalogue.subtitleOf('dispute.proposal', {}, 'en')).toBeNull();
        for (const lang of ['fr', 'en'])
            expect(catalogue.subjectOf('dispute.proposal', lang)).not.toMatch(/\d/);
        // disputes never leave by webhook (wave 7 decision: a contest is HR data)
        expect(catalogue.webhookOf('dispute.proposal')).toBe('never');
    });

    test('pip.created is no longer sent but stays declared for the rows already stored', () => {
        expect(catalogue.isDeclared('pip.created')).toBe(true);
        expect(catalogue.webhookOf('pip.created')).toBe('never');
    });

    test('a summary is never a line of the daily digest', () => {
        for (const k of [
            'digest.persona.employee',
            'digest.persona.executive',
            'dept_brief',
            'dept_digest',
            'manager_digest',
            'planning.digest',
        ])
            expect([k, N._digestible(k)]).toEqual([k, false]);
        for (const k of ['sa.submitted', 'cycle.team_reminder', 'idp.action_due'])
            expect([k, N._digestible(k)]).toEqual([k, true]);
    });
});
