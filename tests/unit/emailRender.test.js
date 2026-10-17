'use strict';

/**
 * ONE e-mail renderer (utils/emailTemplate: renderEmail / compose / blocks):
 * one document and one look for every mail, one language per mail, a subject
 * that never carries a name, a figure or a status, a real plain-text part, the
 * logo as a CID attachment, a footer that says why the mail was sent (or that
 * it is mandatory). Behavioural: every assertion is on a rendered mail.
 */
jest.mock('../../src/config/database', () => ({
    get: jest.fn(async () => null),
    all: jest.fn(async () => []),
    run: jest.fn(async () => ({ changes: 0 })),
    runInSavepoint: jest.fn(async (fn) => fn()),
}));
const mockSettings = { appName: 'Acme Talent', brandAccentColor: null, brandLogo: null };
jest.mock('../../src/models/AppSettingsModel', () => ({
    getValue: jest.fn(async (key, d) =>
        Object.prototype.hasOwnProperty.call(mockSettings, key) && mockSettings[key] != null
            ? mockSettings[key]
            : d
    ),
    setValue: jest.fn(async () => true),
}));

process.env.APP_BASE_URL = 'https://app.example.test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const T = require('../../src/utils/emailTemplate');
const N = require('../../src/services/NotificationService');
const PRODUCT = require('../../src/config/product');

/** A valid W×W PNG of random pixels (so it does not compress below the size we want). */
function png(W) {
    const crcT = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (b) => {
        let c = 0xffffffff;
        for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (t, d) => {
        const l = Buffer.alloc(4);
        l.writeUInt32BE(d.length);
        const td = Buffer.concat([Buffer.from(t), d]);
        const c = Buffer.alloc(4);
        c.writeUInt32BE(crc(td));
        return Buffer.concat([l, td, c]);
    };
    const raw = require('crypto').randomBytes((W * 3 + 1) * W);
    for (let y = 0; y < W; y++) raw[y * (W * 3 + 1)] = 0;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(W, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

beforeEach(() => {
    mockSettings.appName = 'Acme Talent';
    mockSettings.brandAccentColor = null;
    mockSettings.brandLogo = null;
    mockSettings.mailDefaultLanguage = null;
});

describe('one document, one look', () => {
    test('a full document: lang, charset, color-scheme, title, preheader, fluid 600, ONE <html>', async () => {
        const m = await T.renderEmail({ kind: 'sa.submitted', locale: 'fr' });
        expect((m.html.match(/<html/g) || []).length).toBe(1);
        expect(m.html).toMatch(/^<!doctype html>/);
        expect(m.html).toMatch(/<html lang="fr"/);
        expect(m.html).toContain('<meta charset="utf-8">');
        expect(m.html).toContain('<meta name="color-scheme" content="light">');
        expect(m.html).toContain(`<title>${T.esc(m.subject)}</title>`);
        expect(m.html).toMatch(/display:none;max-height:0[^>]*>[^<]{1,90}<\/div>/);
        expect(m.html).toContain('max-width:600px');
    });

    test('no accent configured ⇒ the stock accent, with a computed text colour', async () => {
        const m = await T.renderEmail({ kind: 'sa.submitted' });
        expect(m.html.toLowerCase()).toContain(PRODUCT.accentColor.toLowerCase());
        expect(m.html).not.toContain('#2563eb');
    });

    test('the subject is « {app} — {catalogue subject} », never the caller’s title', async () => {
        const m = await T.renderEmail({ kind: 'sa.rejected', title: 'Jo Martin — 2/4' });
        expect(m.subject).toBe('Acme Talent — Une décision a été prise sur votre auto-évaluation');
        expect(m.html).toContain('Jo Martin — 2/4'); // the headline, inside the mail
    });
});

describe('contrast: the text on a brand colour is computed, ≥ 4.5:1', () => {
    test.each(['#5b4be0', '#ffd400', '#0e1116', '#b91c1c', '#00a3a3', '#ffffff'])(
        'accent %s',
        (accent) => {
            const fg = T.onColor(accent);
            expect(T.contrastRatio(accent, fg)).toBeGreaterThanOrEqual(4.5);
        }
    );

    test('the severity chips and the footer meet 4.5:1 too', () => {
        for (const s of Object.values(T.SEVERITY_STYLE).filter((x) => x.bg))
            expect(T.contrastRatio(s.bg, T.onColor(s.bg))).toBeGreaterThanOrEqual(4.5);
        expect(T.contrastRatio(T.MUTED, '#f4f5f7')).toBeGreaterThanOrEqual(4.5);
    });
});

describe('the call to action', () => {
    test('≥ 48 px high, full width on a phone, and the link printed in clear', async () => {
        const m = await T.renderEmail({ kind: 'sa.submitted', ctaUrl: '/notifications' });
        expect(m.html).toMatch(/height="48"[^>]*style="height:48px/);
        expect(m.html).toContain('max-width:320px');
        expect(m.html).toContain('Si le bouton ne fonctionne pas, copiez ce lien');
        expect(m.html).toContain('https://app.example.test/notifications');
    });
});

describe('the logo is a CID inline attachment', () => {
    test('a small PNG logo → an attachment with a cid, referenced by cid:, never data:', async () => {
        mockSettings.brandLogo = `data:image/png;base64,${png(16).toString('base64')}`;
        const m = await T.renderEmail({ kind: 'sa.submitted' });
        expect(m.attachments).toHaveLength(1);
        expect(m.attachments[0].cid).toBe(T.LOGO_CID);
        expect(m.html).toContain(`src="cid:${T.LOGO_CID}"`);
        expect(m.html).not.toContain('data:image');
    });

    test('a logo over 20 KB is not sent: the header prints the app name', async () => {
        mockSettings.brandLogo = `data:image/png;base64,${png(120).toString('base64')}`;
        const m = await T.renderEmail({ kind: 'sa.submitted' });
        expect(m.attachments).toHaveLength(0);
        expect(m.html).not.toContain('cid:');
        expect(m.html).toContain('>Acme Talent</span>');
    });
});

describe('footer and headers', () => {
    test('FR: automatic, why, a link to the preferences; List-Unsubscribe → the preferences', async () => {
        const m = await T.renderEmail({ kind: 'sa.submitted', locale: 'fr' });
        expect(m.html).toContain('Ceci est un message automatique de Acme Talent');
        expect(m.html).toContain('Vous le recevez parce que vous avez un compte sur Acme Talent');
        expect(m.html).toContain('href="https://app.example.test/account/notifications"');
        expect(m.headers).toMatchObject({
            'Auto-Submitted': 'auto-generated',
            'X-Auto-Response-Suppress': 'All',
            'List-Unsubscribe': '<https://app.example.test/account/notifications>',
        });
    });

    test('mandatory (safety, security): « Message obligatoire », no preferences link, no List-Unsubscribe', async () => {
        for (const kind of ['safety.blocked', 'security.account_soft_locked']) {
            const m = await T.renderEmail({ kind, locale: 'fr' });
            expect(m.html).toContain('Message obligatoire');
            expect(m.html).not.toContain('/account/notifications');
            expect(m.headers['List-Unsubscribe']).toBeUndefined();
        }
    });
});

describe('one language per mail', () => {
    const FR_CHROME = /Bonjour|Cordialement|Ouvrir dans|Ceci est un message|Si le bouton/;
    const EN_CHROME = /Hello|Kind regards|Open in|This is an automated|If the button/;

    test('a French mail carries no English chrome, an English mail no French chrome — HTML and text', async () => {
        const fr = await T.renderEmail({ kind: 'sa.changes_requested', locale: 'fr' });
        const en = await T.renderEmail({ kind: 'sa.changes_requested', locale: 'en' });
        expect(`${fr.html}\n${fr.text}`).not.toMatch(EN_CHROME);
        expect(`${en.html}\n${en.text}`).not.toMatch(FR_CHROME);
        expect(fr.subject).not.toBe(en.subject);
        expect(en.html).toMatch(/<html lang="en"/);
    });

    test('the default is the site’s mail language, French unless it says English', async () => {
        expect((await T.renderEmail({ kind: 'sa.submitted' })).html).toMatch(/<html lang="fr"/);
        mockSettings.mailDefaultLanguage = 'en';
        expect((await T.renderEmail({ kind: 'sa.submitted' })).html).toMatch(/<html lang="en"/);
        // The recipient's own language, when the caller knows it, wins.
        expect((await T.renderEmail({ kind: 'sa.submitted', locale: 'fr' })).html).toMatch(
            /<html lang="fr"/
        );
    });

    test('the block builders keep ONE of the two texts', () => {
        const B = T.blocks('en');
        expect(B.section('Revues', 'Reviews')).toEqual({ type: 'h', text: 'Reviews' });
        expect(B.para('Bonjour', 'Hello').text).toBe('Hello');
        expect(B.table([{ fr: 'Nom', en: 'Name' }], [['x']]).head).toEqual(['Name']);
        expect(B.steps([{ fr: 'a', en: 'b' }])).toEqual({
            type: 'list',
            ordered: true,
            items: ['b'],
        });
        expect(T.blocks('fr').pick({ fr: 'Oui', en: 'Yes' })).toBe('Oui');
        // An English text missing: French, the primary language, is the fallback.
        expect(B.pick('Seulement', '')).toBe('Seulement');
    });
});

describe('the bilingual string helpers are gone — every mail is built from blocks', () => {
    test('emailTemplate exports no wrap() / kpis() / section() / para() / table() / cta()', () => {
        for (const k of ['wrap', 'kpis', 'section', 'para', 'table', 'details', 'steps', 'cta'])
            expect(T[k]).toBeUndefined();
    });

    test('a stray html / subject passed to the composer is ignored', () => {
        const m = T.compose(
            {
                kind: 'sa.submitted',
                subject: 'Jo Martin',
                html: '<html><body><script>alert(1)</script></body></html>',
            },
            { brand: { appName: 'Acme' } }
        );
        expect(m.subject).toBe(N._subjectFor('sa.submitted', 'fr', 'Acme'));
        expect(m.html).not.toContain('<script>');
    });

    test('a catalogue-only mail still gets the greeting, the sign-off and a CTA from payload.link', () => {
        const m = N._render({
            kind: 'cert.expiry',
            payload: { link: '/employee/my-certifications' },
            brand: { appName: 'Acme' },
            recipientName: 'Jo',
            locale: 'fr',
        });
        expect(m.html).toContain('Bonjour Jo,');
        expect(m.html).toContain('Cordialement');
        expect(m.html).toContain('href="https://app.example.test/employee/my-certifications"');
    });
});

describe('blocks', () => {
    test('every value is escaped; null cells read « — »; an unmeasured bar is « Non mesuré », never 0', () => {
        const { html, text } = T.renderBlocks(
            [
                { type: 'p', text: '<img src=x onerror=1> & co' },
                { type: 'kv', rows: [['Échéance', null]] },
                { type: 'table', head: ['A'], rows: [[{ text: '<b>x</b>', bold: true }]] },
                { type: 'bar', label: 'Couverture', value: null, max: 100 },
                { type: 'bar', label: 'Mesurée', value: 41, max: 50, n: 12 },
                { type: 'notice', severity: 'critical', text: 'Attention' },
                { type: 'unknown', text: 'skipped' },
            ],
            { lang: 'fr' }
        );
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img src=x onerror=1&gt; &amp; co');
        expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
        expect(text).toContain('Échéance : —');
        expect(text).toContain('Couverture : Non mesuré');
        expect(text).toContain('Mesurée : 41 (n = 12)');
        expect(html).not.toContain('skipped');
        expect(html).toContain('#b91c1c');
    });

    test('English colon spacing in the text part', () => {
        const { text } = T.renderBlocks([{ type: 'kv', rows: [['Due', '31/10/2026']] }], {
            lang: 'en',
        });
        expect(text).toBe('Due: 31/10/2026');
    });
});

describe('the plain-text part', () => {
    test('entities decoded, links kept, lists dashed, the preheader and <head> dropped', () => {
        const t = T.htmlToText(
            '<html><head><title>x</title><style>p{}</style></head><body><div style="display:none">pre</div><p>A &amp; B &#39;c&#39;</p><ul><li>one</li><li>two</li></ul><a href="https://a.test/?x=1&amp;y=2">go</a></body></html>'
        );
        expect(t).toBe("A & B 'c'\n\n- one\n- two\ngo (https://a.test/?x=1&y=2)");
    });

    test('a hostile input is read in linear time', () => {
        const evil = '<a href="'.repeat(20000) + '<div style="display:none'.repeat(20000);
        const t0 = Date.now();
        T.htmlToText(evil);
        expect(Date.now() - t0).toBeLessThan(1000);
    });

    test('the text part of a rendered mail carries no HTML entity', async () => {
        const m = await T.renderEmail({
            kind: 'sa.submitted',
            title: 'L’équipe « A & B »',
            blocks: [{ type: 'p', text: '<x> & "y"' }],
        });
        expect(m.text).not.toMatch(/&(amp|lt|gt|quot|#39);/);
        expect(m.text).toContain('<x> & "y"');
    });
});

describe('the app name, never a typed product name', () => {
    test('subject, header, sign-off and footer use the configured app name', async () => {
        mockSettings.appName = 'Nimbus';
        const m = await T.renderEmail({ kind: 'sa.submitted' });
        expect(m.subject.startsWith('Nimbus — ')).toBe(true);
        expect(m.html).toContain('>Nimbus</span>');
        expect(m.html).toContain('L&#39;équipe Nimbus');
        expect(m.text).toContain("L'équipe Nimbus");
        expect(m.html).toContain('Ceci est un message automatique de Nimbus');
        expect(m.html).not.toContain(PRODUCT.name);
    });
});

describe('render-notification-samples (the reviewer tool) — every kind, FR and EN', () => {
    let out;
    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-samples-'));
        out = await require('../../scripts/render-notification-samples').main({ outDir: dir });
    });
    afterAll(() => {
        if (out && out.outDir) fs.rmSync(out.outDir, { recursive: true, force: true });
    });

    test('every kind of the catalogue was rendered in both languages, and every block type', () => {
        const catalogue = require('../../src/services/notificationCatalogue');
        const rendered = new Set(
            out.samples.filter((s) => s.group === 'kind').map((s) => `${s.kind}|${s.locale}`)
        );
        for (const k of catalogue.kinds())
            for (const l of ['fr', 'en']) expect(rendered.has(`${k}|${l}`)).toBe(true);
        const blocks = out.samples.filter((s) => s.group === 'block').map((s) => s.block);
        for (const b of [
            'h',
            'p',
            'kv',
            'table',
            'list',
            'steps',
            'links',
            'bar',
            'notice',
            'button',
        ])
            expect(blocks).toContain(b);
        expect(out.samples.some((s) => s.kind === 'digest.daily' && s.locale === 'en')).toBe(true);
    });

    test('no subject carries a name, a figure or a campaign code — whatever the payload', () => {
        for (const s of out.samples) {
            const subject = s.subject.replace(/^Démo Talents — /, '').replace(/360°/g, '');
            expect([s.name, /\d|Jo|Martin|C-2026|mauvais|Effectifs/.test(subject)]).toEqual([
                s.name,
                false,
            ]);
        }
    });

    test('no sample breaks a house rule', () => {
        for (const s of out.samples) {
            const html = fs.readFileSync(path.join(out.outDir, `${s.name}.html`), 'utf8');
            const text = fs.readFileSync(path.join(out.outDir, `${s.name}.txt`), 'utf8');
            expect(html).toMatch(new RegExp(`<html lang="${s.locale}"`));
            expect(html).toContain('color-scheme');
            expect(html).toContain('max-width:600px');
            expect(html).toContain('cid:');
            expect(html).not.toContain('data:image');
            expect(html).toMatch(/height:48px/);
            expect(text).not.toMatch(/&(amp|lt|gt|quot|#39);/);
            if (s.locale === 'fr') expect(text).not.toMatch(/Kind regards|This is an automated/);
            else expect(text).not.toMatch(/Cordialement|Ceci est un message/);
        }
    });
});
