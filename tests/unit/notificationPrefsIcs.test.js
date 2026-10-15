'use strict';

/**
 * Notification preferences, .ics and measurement (migration 183, SA-48) —
 * pure and mocked behaviour:
 *   IcsService (RFC 5545, content-free), the .ics in the composer and its
 *   per-person switch, the tracked button (/notifications/:id/go), one
 *   language per mail (the recipient's when it can be honoured), the category
 *   of a kind (mandatory rows), the summary cadence and step-down in
 *   personal-digest, the campaign reminder ladder (at most 4 per campaign),
 *   the controller (go → opened, mark-all never, grid parsing, « turn back
 *   on », catalogue preview, site quiet hours), the bell grouped by day, and
 *   the three views rendered in French and English.
 */
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
}));

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const db = require('../../src/config/database');
const Ics = require('../../src/services/IcsService');
const N = require('../../src/services/NotificationService');

const ROOT = path.join(__dirname, '../..');

// ---------------------------------------------------------------- IcsService
describe('IcsService — RFC 5545, content-free', () => {
    const NOW = new Date(Date.UTC(2026, 9, 4, 8, 0, 0));

    test('an all-day deadline: VALUE=DATE, DTEND the next day, CRLF, fixed summary', () => {
        const s = Ics.build({
            type: 'campaign_deadline',
            start: '2026-10-31',
            uid: 'cycle-12-deadline',
            url: 'https://app.example.test/employee/self-assessment',
            appName: 'Compétences',
            lang: 'fr',
            now: NOW,
        });
        expect(s.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
        expect(s.endsWith('END:VCALENDAR\r\n')).toBe(true);
        expect(s).toContain('DTSTART;VALUE=DATE:20261031\r\n');
        expect(s).toContain('DTEND;VALUE=DATE:20261101\r\n');
        expect(s).toContain('DTSTAMP:20261004T080000Z');
        expect(s).toContain('UID:cycle-12-deadline@app.example.test');
        expect(s).toContain('SUMMARY:Échéance de campagne — Compétences');
        expect(s).toContain('METHOD:PUBLISH');
        expect(s.replace(/\r\n/g, '')).not.toMatch(/\n/); // only CRLF line breaks
    });

    test('a timed session is written in UTC with a default one-hour end', () => {
        const s = Ics.build({
            type: 'coaching_session',
            start: new Date(Date.UTC(2026, 10, 3, 9, 30)),
            appName: 'App',
            lang: 'en',
            now: NOW,
        });
        expect(s).toContain('DTSTART:20261103T093000Z');
        expect(s).toContain('DTEND:20261103T103000Z');
        expect(s).toContain('SUMMARY:Coaching session — App');
    });

    test('lines are folded at 75 octets (UTF-8), never inside a character', () => {
        const s = Ics.build({
            type: 'hearing',
            start: new Date(Date.UTC(2026, 10, 3, 9)),
            appName: 'Évaluation des compétences — plateforme interne éàüç'.repeat(2),
            url: `https://app.example.test/${'a'.repeat(120)}`,
            now: NOW,
        });
        for (const line of s.split('\r\n'))
            expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
        const unfolded = s.replace(/\r\n /g, '');
        expect(unfolded).toContain('SUMMARY:Audience de contestation — Évaluation');
        expect(unfolded).not.toContain('�');
    });

    test('text escaping: ; , \\ and line breaks', () => {
        expect(Ics._escText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
    });

    test('no caller text ever reaches the file; a bad date gives no file', () => {
        const s = Ics.build({
            type: 'deadline',
            start: '2026-10-31',
            appName: 'App',
            summary: 'Review of Alex Example — rated 1/4',
            description: 'Reason: insufficient',
        });
        expect(s).not.toMatch(/Alex|rated|Reason/);
        expect(Ics.build({ type: 'deadline', start: 'not a date' })).toBeNull();
        expect(Ics.attachment({ type: 'deadline', start: null })).toBeNull();
        const a = Ics.attachment({ type: 'deadline', start: '2026-10-31', lang: 'fr' });
        expect(a.filename).toBe('echeance.ics');
        expect(a.contentType).toMatch(/^text\/calendar/);
        expect(Ics.attachment({ type: 'deadline', start: '2026-10-31', lang: 'en' }).filename).toBe(
            'deadline.ics'
        );
    });

    test('a relative or non-http URL is never written into the file', () => {
        const s = Ics.build({ type: 'deadline', start: '2026-10-31', url: 'javascript:x' });
        expect(s).not.toMatch(/javascript/);
        expect(s).not.toMatch(/^URL:/m);
    });
});

// ------------------------------------------------- composer: .ics, CTA, lang
describe('the composer — .ics, tracked button, one language', () => {
    const brand = { appName: 'App', accent: '#2563eb' };

    test('calendar ⇒ an .ics attachment; icsEnabled false ⇒ none; a held mail keeps it', () => {
        const spec = {
            kind: 'cycle.opened',
            locale: 'fr',
            payload: {},
            calendar: { type: 'campaign_deadline', date: '2026-10-31', uid: 'c-1' },
        };
        const on = N._compose(spec, { brand });
        const off = N._compose(spec, { brand, icsEnabled: false });
        const ics = on.attachments.find((a) => /calendar/.test(a.contentType || ''));
        expect(ics).toBeTruthy();
        expect(ics.content).toContain('DTSTART;VALUE=DATE:20261031');
        expect(off.attachments.some((a) => /calendar/.test(a.contentType || ''))).toBe(false);
        expect(N._storable(on).attachments[0].filename).toBe('echeance.ics');
        expect(N._storable(off).attachments).toBeUndefined();
    });

    test('renderEmail honours the recipient’s .ics switch', async () => {
        db.get.mockImplementation(async (sql) =>
            /notification_user_settings/.test(sql) ? { icsEnabled: false } : undefined
        );
        const r = await N.renderEmail({
            kind: 'cycle.opened',
            locale: 'fr',
            calendar: { type: 'campaign_deadline', date: '2026-10-31' },
            recipient: { userType: 'employee', userId: 5 },
        });
        expect(r.attachments.some((a) => /calendar/.test(a.contentType || ''))).toBe(false);
        db.get.mockImplementation(async () => undefined);
        const r2 = await N.renderEmail({
            kind: 'cycle.opened',
            locale: 'fr',
            calendar: { type: 'campaign_deadline', date: '2026-10-31' },
            recipient: { userType: 'employee', userId: 5 },
        });
        expect(r2.attachments.some((a) => /calendar/.test(a.contentType || ''))).toBe(true);
    });

    test('the button goes through /notifications/:id/go only when it lands on the in-app link', () => {
        const tracked = N._compose(
            { kind: 'lms.due', locale: 'fr', payload: { link: '/employee/my-learning' } },
            { brand, trackId: 314 }
        );
        expect(tracked.html).toContain('/notifications/314/go');
        const explicit = N._compose(
            {
                kind: 'lms.due',
                locale: 'fr',
                payload: { link: '/employee/my-learning' },
                ctaUrl: '/other/place',
            },
            { brand, trackId: 314 }
        );
        expect(explicit.html).not.toContain('/notifications/314/go');
        expect(explicit.html).toContain('/other/place');
        const none = N._compose({ kind: 'lms.due', locale: 'fr', payload: {} }, { brand });
        expect(none.html).not.toMatch(/\/notifications\/\d+\/go/);
        const bad = N._compose(
            { kind: 'lms.due', locale: 'fr', payload: { link: '/x' } },
            { brand, trackId: '1 OR 1=1' }
        );
        expect(bad.html).not.toMatch(/\/notifications\/[^"]*\/go/);
    });

    test('never a French body under English chrome', () => {
        const en = { emailLocale: 'en' };
        // catalogue-worded ⇒ the person's language
        expect(N._mailContent({ locale: 'fr' }, en).locale).toBe('en');
        // the emitter wrote French text and gave no English ⇒ the whole mail stays French
        expect(N._mailContent({ locale: 'fr', title: 'Votre revue', blocks: [] }, en).locale).toBe(
            'fr'
        );
        expect(
            N._mailContent({ locale: 'fr', blocks: [{ type: 'p', text: 'Bonjour' }] }, en).locale
        ).toBe('fr');
        // …unless it supplied English too
        const both = N._mailContent(
            { locale: 'fr', title: 'Votre revue', byLocale: { en: { title: 'Your review' } } },
            en
        );
        expect(both).toMatchObject({ locale: 'en', title: 'Your review' });
        // no preference ⇒ the emitter's language, else the site's
        expect(N._mailContent({ locale: 'fr' }, null).locale).toBe('fr');
        expect(N._mailContent({}, null, 'en').locale).toBe('en');
    });

    test('a `content` builder is written in the person’s language, else the site’s', () => {
        const content = (B) => ({
            intro: B.pick('Bonjour', 'Hello'),
            ctaLabel: B.pick('Ouvrir', 'Open'),
        });
        expect(
            N._mailContent({ content, locale: 'fr' }, { emailLocale: 'en' }, 'fr')
        ).toMatchObject({
            locale: 'en',
            intro: 'Hello',
            ctaLabel: 'Open',
        });
        expect(N._mailContent({ content }, null, 'fr')).toMatchObject({
            locale: 'fr',
            intro: 'Bonjour',
        });
        // a builder that throws never takes the notification down
        const broken = N._mailContent(
            {
                content: () => {
                    throw new Error('x');
                },
            },
            null,
            'fr'
        );
        expect(broken.locale).toBe('fr');
        expect(broken.blocks).toBeUndefined();
    });

    test('recipientLang: the person’s choice, else the sender’s, else the site’s', async () => {
        db.get.mockImplementation(async (sql) =>
            /notification_user_settings/.test(sql) ? { emailLocale: 'en' } : undefined
        );
        expect(await N.recipientLang('employee', 3, 'fr')).toBe('en');
        db.get.mockImplementation(async () => undefined);
        expect(await N.recipientLang('employee', 3, 'fr')).toBe('fr');
        expect(await N.recipientLang('employee', 3)).toBe('fr'); // site default (mocked)
    });
});

// --------------------------------------------------------------- categories
describe('categoryOf — mandatory kinds sit in a mandatory row', () => {
    test.each([
        ['safety.blocked', 'safety'],
        ['security.breakglass_signin', 'security'],
        ['account.setup', 'security'],
        ['access.expiry', 'account'],
        ['cert.expiry', 'compliance'],
        ['lms.due', 'development'],
        ['feedback360.nominate', 'development'],
        ['oneonone.topic_added', 'development'],
        ['sa.submitted', 'evaluations'],
        ['unknown.kind', 'other'],
    ])('%s → %s', (kind, cat) => {
        expect(N.categoryOf(kind)).toBe(cat);
    });

    test('every category has a label in both languages', () => {
        for (const lang of ['fr', 'en']) {
            const c = require(`../../locales/${lang}/chrome.json`);
            for (const k of N.CATEGORIES) expect(c[`notif_cat_${k}`]).toBeTruthy();
        }
    });

    test('channelAllowed: e-mail on by default, mandatory always, in-app always, other channels never', async () => {
        db.get.mockImplementation(async () => undefined);
        const who = { userType: 'employee', userId: 7 };
        expect(await N.channelAllowed({ ...who, kind: 'lms.due', channel: 'email' })).toBe(true);
        expect(await N.channelAllowed({ ...who, kind: 'lms.due', channel: 'inapp' })).toBe(true);
        expect(await N.channelAllowed({ ...who, kind: 'lms.due', channel: 'sms' })).toBe(false);
        expect(await N.channelAllowed({ ...who, kind: 'safety.blocked', channel: 'email' })).toBe(
            true
        );
        db.get.mockImplementation(async (sql) =>
            /notification_category_prefs/.test(sql) ? { enabled: false } : undefined
        );
        expect(await N.channelAllowed({ ...who, kind: 'lms.due', channel: 'email' })).toBe(false);
        // a mandatory kind ignores the grid
        expect(await N.channelAllowed({ ...who, kind: 'safety.blocked', channel: 'email' })).toBe(
            true
        );
        db.get.mockImplementation(async () => undefined);
    });

    test('the default summary cadence is daily: an upgrade changes nothing', async () => {
        expect(await N.defaultCadence('employee', 3)).toBe('daily');
        expect(await N.defaultCadence('admin', 1)).toBe('daily');
        expect(await N.digestCadence('employee', 3)).toBe('daily');
    });

    test('markActed: no filter, an undeclared kind or a free-text ref writes nothing', async () => {
        db.run.mockClear();
        expect(await N.markActed({})).toBe(0);
        expect(await N.markActed({ userType: 'employee', userId: 3, kinds: ['x; DROP'] })).toBe(0);
        expect(await N.markActed({ refType: 'Cycle Name', refId: 3 })).toBe(0);
        expect(db.run).not.toHaveBeenCalled();
    });

    test('_refOf: identifiers from whitelisted keys only', () => {
        expect(N._refOf('cycle.reminder', { cycleId: 12 }, {})).toEqual({
            refType: 'cycle',
            refId: '12',
        });
        expect(N._refOf('cycle.reminder', { cycleId: 'Q3 review; x' }, {})).toEqual({
            refType: null,
            refId: null,
        });
        expect(N._refOf('lms.due', { cycleId: 12 }, {})).toEqual({ refType: null, refId: null });
        expect(N._refOf('lms.due', {}, { refType: 'skill', refId: 4 })).toEqual({
            refType: 'skill',
            refId: '4',
        });
    });
});

// ----------------------------------------------------- personal-digest cadence
describe('personal-digest — cadence and step-down', () => {
    const run = async ({ day, cadence, stepDown }) => {
        jest.resetModules();
        jest.useFakeTimers();
        jest.setSystemTime(day);
        const sendDigest = jest.fn(async () => ({ sent: true }));
        jest.doMock('../../src/config/database', () => ({
            all: jest.fn(async () => [{ userType: 'employee', userId: 3, kinds: ['lms.due'] }]),
            get: jest.fn(),
            run: jest.fn(),
        }));
        jest.doMock('../../src/models/AppSettingsModel', () => ({
            getValue: jest.fn(async (k, d) =>
                k === 'digestHour' ? 0 : d === undefined ? null : d
            ),
            setValue: jest.fn(async () => true),
        }));
        jest.doMock('../../src/services/EmailService', () => ({
            isCategoryEnabled: jest.fn(async () => true),
        }));
        jest.doMock('../../src/services/NotificationService', () => ({
            sendDigest,
            digestCadence: jest.fn(async () => cadence),
            digestStepDown: jest.fn(async () => stepDown || { steppedDown: false }),
        }));
        const out = await require('../../src/jobs/personal-digest').tick();
        jest.useRealTimers();
        return { out, sendDigest };
    };
    const MONDAY = new Date(2026, 9, 5, 9, 0, 0);
    const TUESDAY = new Date(2026, 9, 6, 9, 0, 0);

    test('weekly: nothing on Tuesday; Monday covers 7 days', async () => {
        const tue = await run({ day: TUESDAY, cadence: 'weekly' });
        expect(tue.sendDigest).not.toHaveBeenCalled();
        expect(tue.out.notDue).toBe(1);
        const mon = await run({ day: MONDAY, cadence: 'weekly' });
        expect(mon.sendDigest).toHaveBeenCalledWith({
            userType: 'employee',
            userId: 3,
            sinceHours: 168,
        });
    });

    test('daily: sent every day with the 24-hour default; never: never', async () => {
        const d = await run({ day: TUESDAY, cadence: 'daily' });
        expect(d.sendDigest).toHaveBeenCalledWith({ userType: 'employee', userId: 3 });
        const off = await run({ day: MONDAY, cadence: 'off' });
        expect(off.sendDigest).not.toHaveBeenCalled();
    });

    test('a step-down to weekly on a Tuesday sends nothing that day', async () => {
        const r = await run({
            day: TUESDAY,
            cadence: 'daily',
            stepDown: { steppedDown: true, from: 'daily', to: 'weekly' },
        });
        expect(r.sendDigest).not.toHaveBeenCalled();
        expect(r.out.steppedDown).toBe(1);
    });
});

// --------------------------------------------------------- the reminder ladder
describe('cycle-nudge — the person’s ladder, at most 4 mails per campaign', () => {
    let J;
    beforeAll(() => {
        jest.resetModules();
        jest.dontMock('../../src/services/NotificationService');
        jest.dontMock('../../src/services/EmailService');
        jest.dontMock('../../src/models/AppSettingsModel');
        jest.doMock('../../src/config/database', () => ({
            get: jest.fn(async () => undefined),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({ changes: 0 })),
        }));
        J = require('../../src/jobs/cycle-nudge').__test;
    });

    test('42-day campaign: D+3, D-7, D-2 windows; nothing before D+3', () => {
        expect(J.ladderStage({ sinceOpenDays: 1, daysLeft: 41, durationDays: 42 })).toBeNull();
        expect(J.ladderStage({ sinceOpenDays: 3, daysLeft: 39, durationDays: 42 })).toBe('d+3');
        expect(J.ladderStage({ sinceOpenDays: 35, daysLeft: 7, durationDays: 42 })).toBe(
            'reminder_7'
        );
        expect(J.ladderStage({ sinceOpenDays: 40, daysLeft: 2, durationDays: 42 })).toBe(
            'reminder_2'
        );
        expect(J.MAX_PER_PERSON).toBe(4);
    });

    test('a campaign shorter than 10 days: D-2 only', () => {
        expect(J.ladderStage({ sinceOpenDays: 3, daysLeft: 5, durationDays: 8 })).toBeNull();
        expect(J.ladderStage({ sinceOpenDays: 6, daysLeft: 2, durationDays: 8 })).toBe(
            'reminder_2'
        );
    });

    test('the mails are written in the recipient’s language, counts and dates only', () => {
        const { blocks } = require('../../src/utils/emailTemplate');
        const cycle = { id: 9, code: 'C-9', label: 'Spring review' };
        const fr = J.ladderMail(cycle, 'reminder_2', '2026-10-31', 12)(blocks('fr'));
        const en = J.ladderMail(cycle, 'reminder_2', '2026-10-31', 12)(blocks('en'));
        expect(fr.intro).toMatch(/Dernier rappel/);
        expect(en.intro).toMatch(/Last reminder/);
        expect(JSON.stringify(fr)).toContain('31/10/2026');
        expect(JSON.stringify(en)).not.toMatch(/Campagne|soumise/);
        const rv = J.reviewerMail(cycle, {
            stage: 'escalation_overdue',
            pending: 3,
            closesOn: '2026-10-31',
        })(blocks('en'));
        expect(rv.intro).toMatch(/3 team reviews are overdue/);
        expect(JSON.stringify(rv)).not.toMatch(/revue/);
    });
});

// ---------------------------------------------------------------- controller
describe('NotificationController — opened, grid, preview, bell', () => {
    let C;
    let S;
    beforeAll(() => {
        jest.resetModules();
        jest.dontMock('../../src/services/NotificationService');
        jest.dontMock('../../src/services/EmailService');
        jest.dontMock('../../src/models/AppSettingsModel');
        jest.doMock('../../src/config/database', () => ({
            get: jest.fn(async () => undefined),
            all: jest.fn(async () => []),
            run: jest.fn(async () => ({ changes: 0 })),
        }));
        S = require('../../src/services/NotificationService');
        C = require('../../src/controllers/NotificationController');
    });
    const res = () => {
        const r = { locals: {} };
        r.redirect = jest.fn(() => r);
        r.status = jest.fn(() => r);
        r.send = jest.fn(() => r);
        r.json = jest.fn(() => r);
        r.type = jest.fn(() => r);
        r.set = jest.fn(() => r);
        r.render = jest.fn(() => r);
        return r;
    };
    const user = { id: 9, userType: 'employee' };

    test('go: marks read AND opened for the owner, merged ids too, then redirects', async () => {
        jest.spyOn(S, 'getOwned').mockResolvedValue({
            id: 5,
            kind: 'lms.due',
            payload: { link: '/employee/my-learning' },
        });
        const read = jest.spyOn(S, 'markRead').mockResolvedValue(true);
        const opened = jest.spyOn(S, 'markOpened').mockResolvedValue(true);
        const r = res();
        await C.go({ user, params: { id: '5' }, query: { with: '6,abc,-1,5' } }, r);
        expect(read).toHaveBeenCalledWith({ id: 5, userType: 'employee', userId: 9 });
        expect(opened).toHaveBeenCalledWith({ id: 5, userType: 'employee', userId: 9 });
        expect(opened).toHaveBeenCalledWith({ id: 6, userType: 'employee', userId: 9 });
        expect(opened).toHaveBeenCalledTimes(2);
        expect(r.redirect).toHaveBeenCalledWith('/employee/my-learning');
    });

    test('go: an outside link is never followed', async () => {
        jest.spyOn(S, 'getOwned').mockResolvedValue({
            id: 5,
            kind: 'lms.due',
            payload: { link: '//evil.example' },
        });
        const r = res();
        await C.go({ user, params: { id: '5' }, query: {} }, r);
        expect(r.redirect).toHaveBeenCalledWith('/dashboard');
    });

    test('mark-all-read never sets opened_at', async () => {
        const opened = jest.spyOn(S, 'markOpened').mockClear();
        jest.spyOn(S, 'markAllRead').mockResolvedValue(3);
        const r = res();
        await C.readAll({ user, accepts: () => 'json' }, r);
        expect(opened).not.toHaveBeenCalled();
        expect(r.json).toHaveBeenCalledWith({ ok: true, marked: 3 });
    });

    test('savePrefs: the grid is a Map of the catalogue’s categories; cadence, language and .ics passed', async () => {
        jest.spyOn(S, 'setUserPrefs').mockResolvedValue(true);
        const save = jest.spyOn(S, 'savePreferenceGrid').mockResolvedValue(true);
        const r = res();
        await C.savePrefs(
            {
                user,
                body: {
                    emailEnabled: 'on',
                    grid: '1',
                    cat_development_email: 'on',
                    cat_reports_email: 'on',
                    cat___proto___email: 'on',
                    digestCadence: 'weekly',
                    emailLocale: 'en',
                },
            },
            r
        );
        const arg = save.mock.calls[0][0];
        expect(arg.categories).toBeInstanceOf(Map);
        expect(arg.categories.get('development')).toEqual({ email: true });
        expect(arg.categories.get('talent')).toEqual({ email: false });
        expect([...arg.categories.keys()].sort()).toEqual([...S.CATEGORIES].sort());
        expect(arg).toMatchObject({
            digestCadence: 'weekly',
            emailLocale: 'en',
            icsEnabled: false,
        });
        expect(r.redirect).toHaveBeenCalledWith('/account/notifications');
    });

    test('savePrefs: half a quiet window is refused and nothing is saved', async () => {
        const set = jest.spyOn(S, 'setUserPrefs').mockClear();
        const r = res();
        const flash = jest.fn();
        await C.savePrefs({ user, flash, body: { quietStart: '22:00', quietEnd: '' } }, r);
        expect(set).not.toHaveBeenCalled();
        expect(flash).toHaveBeenCalledWith('error', expect.any(String));
    });

    test('« turn back on » goes to reactivateDigest and saves nothing else', async () => {
        const re = jest.spyOn(S, 'reactivateDigest').mockResolvedValue(true);
        const set = jest.spyOn(S, 'setUserPrefs').mockClear();
        const r = res();
        await C.savePrefs({ user, body: { action: 'reactivate_digest' } }, r);
        expect(re).toHaveBeenCalledWith({ userType: 'employee', userId: 9 });
        expect(set).not.toHaveBeenCalled();
    });

    test('catalogue preview: an undeclared kind is 404; a declared one is a sandboxed sample mail', async () => {
        const r1 = res();
        await C.cataloguePreview({ query: { kind: 'no.such.kind' } }, r1);
        expect(r1.status).toHaveBeenCalledWith(404);
        const r2 = res();
        await C.cataloguePreview({ query: { kind: 'sa.submitted' } }, r2);
        expect(r2.type).toHaveBeenCalledWith('html');
        expect(r2.send.mock.calls[0][0]).toMatch(/<html lang="fr"/);
        expect(r2.set).toHaveBeenCalledWith(
            'Content-Security-Policy',
            expect.stringMatching(/^sandbox;/)
        );
        const r3 = res();
        await C.cataloguePreview({ query: { kind: 'sa.submitted', lang: 'en' } }, r3);
        expect(r3.send.mock.calls[0][0]).toMatch(/<html lang="en"/);
    });

    test('site quiet hours: half a window is refused', async () => {
        const set = jest.spyOn(S, 'setSiteQuietHours').mockResolvedValue(false);
        const r = res();
        await C.saveSiteQuietHours({ body: { siteId: '2', quietStart: '22:00', quietEnd: '' } }, r);
        expect(set).not.toHaveBeenCalled();
        await C.saveSiteQuietHours(
            { body: { siteId: '2', quietStart: '22:00', quietEnd: '06:00' } },
            r
        );
        expect(set).toHaveBeenCalledWith({ siteId: 2, start: '22:00', end: '06:00' });
        expect(r.redirect).toHaveBeenLastCalledWith('/admin/notifications/catalogue#site-quiet');
    });

    test('the bell and the centre group by day and merge identical items', () => {
        const P = C._presentation;
        const now = new Date(2026, 9, 7, 15, 0, 0); // a Wednesday
        const at = (d, h) => new Date(2026, 9, d, h, 0, 0);
        const rows = [
            { id: 9, kind: 'lms.due', payload: {}, created_at: at(7, 14) },
            { id: 8, kind: 'lms.due', payload: {}, created_at: at(7, 9), read_at: at(7, 10) },
            { id: 7, kind: 'sa.submitted', payload: {}, created_at: at(6, 16) },
            { id: 6, kind: 'safety.blocked', payload: {}, created_at: at(5, 8) },
            { id: 5, kind: 'cert.expiry', payload: {}, created_at: at(1, 8) },
        ];
        const items = P.decorate(rows, 'en', { now, t: (k) => k });
        expect(items.map((i) => [i.id, i.group, i.count])).toEqual([
            [9, 'today', 2],
            [7, 'yesterday', 1],
            [6, 'week', 1],
            [5, 'older', 1],
        ]);
        expect(items[0].href).toBe('/notifications/9/go?with=8');
        expect(items[0].read).toBe(false);
        expect(items[2].icon).toBe('fa-triangle-exclamation');
        expect(P.groupItems(items).map((g) => g.key)).toEqual([
            'today',
            'yesterday',
            'week',
            'older',
        ]);
        // shared computer: the kind label only
        const shared = P.decorate(
            [{ id: 1, kind: 'sa.rejected', payload: { reason: 'secret reason' }, created_at: now }],
            'en',
            { now, shared: true, t: (k) => k }
        );
        expect(shared[0].title).not.toMatch(/secret/);
    });

    test('bell JSON: group labels, at most 8 items, unread count', async () => {
        const now = new Date();
        jest.spyOn(S, 'listInApp').mockResolvedValue(
            Array.from({ length: 12 }, (_, i) => ({
                id: 100 - i,
                kind: i % 2 ? 'lms.due' : 'sa.submitted',
                payload: { link: `/x/${i}` },
                created_at: new Date(now.getTime() - i * 60000),
            }))
        );
        jest.spyOn(S, 'unreadCount').mockResolvedValue(12);
        const r = res();
        await C.bell({ user, t: (k) => `T(${k})`, language: 'en' }, r);
        const body = r.json.mock.calls[0][0];
        expect(body.unread).toBe(12);
        expect(body.items.length).toBeLessThanOrEqual(8);
        expect(body.groups.today).toBe('T(chrome:notif_group_today)');
        expect(body.items[0]).toMatchObject({ group: 'today' });
        expect(body.items[0].href).toMatch(/^\/notifications\/\d+\/go/);
    });
});

// --------------------------------------------------------------------- views
describe('views rendered in French and English', () => {
    const NS = {};
    const loc = (lang, ns) => {
        const k = `${lang}:${ns}`;
        if (!NS[k]) {
            const f = path.join(ROOT, 'locales', lang, `${ns}.json`);
            NS[k] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
        }
        return NS[k];
    };
    const tr = (lang) => (key, o) => {
        const [ns, k] = String(key).split(':');
        let s = loc(lang, ns)[k];
        if (s === undefined) s = o && o.defaultValue !== undefined ? o.defaultValue : `[${key}]`;
        if (o) for (const [a, b] of Object.entries(o)) s = String(s).split(`{{${a}}}`).join(b);
        return s;
    };
    const render = (rel, data, lang = 'fr') =>
        ejs.render(
            fs.readFileSync(path.join(ROOT, rel), 'utf8'),
            { __: tr(lang), ...data },
            { filename: path.join(ROOT, rel) }
        );
    const grid = (over = {}) => ({
        emailEnabled: true,
        quietStart: null,
        quietEnd: null,
        categories: N.CATEGORIES.map((key) => ({
            key,
            mandatory: N.MANDATORY_CATEGORIES.includes(key),
            email: true,
        })),
        digestCadence: 'daily',
        digestCadenceIsDefault: true,
        emailLocale: null,
        defaultLocale: 'fr',
        icsEnabled: true,
        stepdownAt: null,
        stepdownFrom: null,
        siteQuiet: null,
        ...over,
    });

    test.each(['fr', 'en'])(
        'preferences (%s): mandatory rows greyed and disabled, no missing key',
        (lang) => {
            const html = render(
                'views/pages/account/notifications.ejs',
                { prefs: grid(), csrfToken: 't', deptBriefPrefs: null },
                lang
            );
            expect(html).toContain('name="grid" value="1"');
            expect(html).toMatch(/<tr class="np-mandatory">/);
            expect(html).toMatch(/name="cat_safety_email"[^>]*disabled/);
            expect(html).toMatch(/name="cat_security_email"[^>]*disabled/);
            expect(html).not.toMatch(/name="cat_development_email"[^>]*disabled/);
            expect(html).not.toContain('_sms');
            expect(html).not.toContain('[chrome:');
            expect(html).not.toContain('np-reactivate');
            expect(html).toContain('<option value="" selected>');
        }
    );

    test('preferences: the step-down notice with « Rétablir »; the site window', () => {
        const html = render('views/pages/account/notifications.ejs', {
            prefs: grid({
                stepdownAt: new Date(),
                stepdownFrom: 'daily',
                digestCadence: 'weekly',
                digestCadenceIsDefault: false,
                emailLocale: 'en',
                siteQuiet: { start: '21:00', end: '06:00' },
            }),
            csrfToken: 't',
            deptBriefPrefs: null,
        });
        expect(html).toContain('id="np-reactivate"');
        expect(html).toContain('Rétablir');
        expect(html).toContain('de « Chaque jour » à « Chaque semaine (le lundi) »');
        expect(html).toContain('de 21:00 à 06:00 (heure du serveur)');
        expect(html).toMatch(/<option value="en" selected/);
    });

    const metrics = {
        days: 30,
        minN: 5,
        globalOptOut: 2,
        stepDowns: 0,
        kinds: [
            {
                kind: 'lms.due',
                mandatory: false,
                sent: 3,
                emailed: 0,
                opened: 0,
                openedPct: null,
                openedReason: 'small',
                actedPct: null,
                actedReason: 'no_hook',
                medianHours: null,
                medianReason: 'no_hook',
                optOuts: 1,
                lowOpen: false,
            },
            {
                kind: 'cycle.reminder',
                mandatory: false,
                sent: 40,
                emailed: 40,
                opened: 6,
                openedPct: 15,
                openedReason: null,
                actedPct: 50,
                actedReason: null,
                medianHours: 30,
                medianReason: null,
                optOuts: 0,
                lowOpen: true,
            },
        ],
    };

    test('metrics (fr): a small group reads « Effectif trop faible », never 0 %', () => {
        const C = require('../../src/controllers/NotificationController');
        const html = render('views/pages/admin/notification-metrics.ejs', {
            metrics,
            fmt: C._presentation.numbers('fr'),
        });
        expect(html).toContain('Effectif trop faible (moins de 5)');
        expect(html).toContain('Non mesuré (aucune action suivie)');
        expect(html).not.toMatch(/>\s*0[\s\u202f]?%/);
        expect(html).toContain('15,0 %');
        expect(html).toContain('Peu ouverte');
        expect(html).not.toContain('[chrome:');
    });

    test('metrics (en): English labels and numbers', () => {
        const C = require('../../src/controllers/NotificationController');
        const html = render(
            'views/pages/admin/notification-metrics.ejs',
            { metrics, fmt: C._presentation.numbers('en') },
            'en'
        );
        expect(html).toContain('Group too small (fewer than 5)');
        expect(html).toContain('15.0%');
        expect(html).toContain('30.0 h');
        expect(html).not.toContain('[chrome:');
    });

    test.each(['fr', 'en'])(
        'catalogue (%s): one row per declared kind, recipients, preview links',
        async (lang) => {
            const C = require('../../src/controllers/NotificationController');
            const rows = await N.catalogueRows({ lang });
            const html = render(
                'views/pages/admin/notification-catalogue.ejs',
                {
                    rows,
                    sites: [{ id: 1, name: 'Site <A>', start: '', end: '' }],
                    fmt: C._presentation.numbers(lang),
                    csrfToken: 't',
                },
                lang
            );
            expect(rows.length).toBe(
                require('../../src/services/notificationCatalogue').kinds().length
            );
            expect(html).toContain(
                '/admin/notifications/catalogue/preview?kind=safety.blocked&amp;lang=fr'
            );
            expect(html).toContain('Site &lt;A&gt;');
            expect(html).not.toContain('[chrome:');
            // volumes unknown (mocked db): « — » or 0, never invented
            expect(rows.every((r) => r.volume === 0 || r.volume === null)).toBe(true);
            expect(rows.find((r) => r.kind === 'account.setup').volume).toBeNull(); // mail only
        }
    );

    test('the centre groups by day, merges, names the severity for screen readers', () => {
        const C = require('../../src/controllers/NotificationController');
        const now = new Date();
        const notifications = C._presentation.decorate(
            [
                { id: 3, kind: 'safety.blocked', payload: {}, created_at: now },
                { id: 2, kind: 'lms.due', payload: {}, created_at: now },
                { id: 1, kind: 'lms.due', payload: {}, created_at: now },
            ],
            'fr',
            { now, t: tr('fr') }
        );
        const html = render('views/pages/notifications/index.ejs', {
            notifications,
            groups: C._presentation.groupItems(notifications),
            sharedView: false,
            filters: {},
            families: [],
            pager: null,
            csrfToken: 't',
        });
        expect(html).toContain('id="notif-g-today"');
        expect(html).toContain('Aujourd’hui');
        expect(html).toContain('href="/notifications/2/go?with=1"');
        expect(html).toContain('×2');
        expect(html).toContain('Critique');
        expect(html).not.toContain('[chrome:');
    });
});
