'use strict';

/**
 * render-notification-samples — renders EVERY notification kind of the
 * catalogue in French AND in English, every renderEmail block type, the daily
 * digest, a mandatory mail and a catalogue-only mail to files, so a reviewer
 * can open them and check the rules (one look, one language, no name or
 * figure in a subject). No database, no SMTP: the database module and the
 * settings model are replaced in the require cache by inert stand-ins, and the
 * branding is a mock (app name, accent, a small PNG logo).
 *
 *   node scripts/render-notification-samples.js [outDir] [--accent=#123456] [--no-logo] [--app="Name"]
 *
 * Default outDir: <os.tmpdir()>/notif-samples. Writes, per sample:
 *   <name>.html   the HTML part exactly as sent (logo referenced as cid:…)
 *   <name>.txt    the plain-text part
 *   <name>.json   subject, headers, attachments (metadata), kind, locale
 * plus logo.png (the CID attachment), index.html (links + subjects) and
 * samples.json (everything above in one file, for scripted checks).
 *
 * A development tool: it is never run by the application.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Options from the command line (only when run directly). */
function cliOptions(argv) {
    const args = argv.slice(2);
    const opt = (name, dflt) => {
        const a = args.find((x) => x.startsWith(`--${name}=`));
        return a ? a.slice(name.length + 3) : dflt;
    };
    return {
        outDir: args.find((a) => !a.startsWith('--')),
        accent: opt('accent', undefined),
        app: opt('app', undefined),
        logo: !args.includes('--no-logo'),
    };
}

/** A 32×32 opaque square PNG in the accent colour (well under the 20 KB CID limit). */
function squarePng(hex) {
    const zlib = require('zlib');
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex)) || [null, '5b4be0'];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    const W = 32;
    const raw = Buffer.alloc((W * 3 + 1) * W);
    for (let y = 0; y < W; y++) {
        const o = y * (W * 3 + 1);
        raw[o] = 0;
        for (let x = 0; x < W; x++) raw.set([r, g, b], o + 1 + x * 3);
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const c = Buffer.alloc(4);
        c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
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

// ---- inert stand-ins (installed BEFORE anything requires them) -------------
process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'https://talents.example.test';
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://samples:samples@127.0.0.1:1/samples';
function stub(rel, exportsObj) {
    const file = require.resolve(path.join(ROOT, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
stub('src/config/database', {
    get: async () => null,
    all: async () => [],
    run: async () => ({ changes: 0 }),
    runInSavepoint: async (fn) => fn(),
    runTransaction: async (fn) => fn(),
});
const SETTINGS = {
    appBaseUrl: process.env.APP_BASE_URL,
    enableEmailNotifications: true,
    smtpHost: 'smtp.example.test',
};
stub('src/models/AppSettingsModel', {
    getValue: async (k, d) => (Object.prototype.hasOwnProperty.call(SETTINGS, k) ? SETTINGS[k] : d),
    setValue: async () => true,
});

const N = require(path.join(ROOT, 'src/services/NotificationService'));
const EmailService = require(path.join(ROOT, 'src/services/EmailService'));
const T = require(path.join(ROOT, 'src/utils/emailTemplate'));
const catalogue = require(path.join(ROOT, 'src/services/notificationCatalogue'));

// ---- helpers ------------------------------------------------------------------
const samples = [];

/**
 * Every file the tool writes goes through here: a plain file name (no
 * directory part), inside the output directory it was given. A developer tool
 * writing where it is asked to — the one place the path is not a literal.
 */
function writeOut(outDir, name, data) {
    const file = path.join(outDir, path.basename(String(name)));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
    fs.writeFileSync(file, data, typeof data === 'string' ? 'utf8' : undefined);
}
const safe = (s) =>
    String(s)
        .replace(/[^a-z0-9._-]+/gi, '_')
        .slice(0, 80);

function save(outDir, name, mail, meta = {}) {
    const base = safe(name);
    writeOut(outDir, `${base}.html`, mail.html);
    writeOut(outDir, `${base}.txt`, mail.text);
    const info = {
        name: base,
        subject: mail.subject,
        headers: mail.headers || {},
        attachments: (mail.attachments || []).map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            cid: a.cid,
            bytes: a.content ? a.content.length : 0,
        })),
        ...meta,
    };
    writeOut(outDir, `${base}.json`, JSON.stringify(info, null, 2));
    samples.push(info);
}

/**
 * A payload as hostile as an emitter could write: a person's name, figures, a
 * campaign code, a reason. None of it may reach a subject line.
 */
const HOSTILE = {
    name: 'Jo Martin',
    employeeName: 'Jo Martin',
    reason: 'Saisie faite sur le mauvais collaborateur.',
    cycle: 'C-2026-T4',
    stage: 'overdue',
    overdueDays: 4,
    pending: 7,
    count: 12,
    days: 3,
    report: 'Effectifs par site',
    provider: 'entra',
    variant: 'standard',
    link: '/notifications',
};

const BLOCKS = (B) => ({
    h: [B.section('Une section', 'A section')],
    p: [
        B.para(
            'Un paragraphe en texte brut : « guillemets », & esperluette, <balise> échappée.',
            'A plain-text paragraph: “quotes”, & ampersand, an escaped <tag>.'
        ),
    ],
    kv: [
        B.details([
            [{ fr: 'Échéance', en: 'Due' }, '31/10/2026'],
            [{ fr: 'Campagne', en: 'Campaign' }, 'C-2026-T4'],
            [{ fr: 'Valeur absente', en: 'Missing value' }, null],
        ]),
    ],
    table: [
        B.table(
            [
                { fr: 'Site', en: 'Site' },
                { fr: 'Effectif', en: 'Headcount' },
                { fr: 'Couverture', en: 'Coverage' },
            ],
            [
                ['Site Nord', '1 234', '82,1 %'],
                ['Site Sud', '57', null],
            ]
        ),
    ],
    list: [{ type: 'list', items: ['1', '2', '3'].map((n) => B.pick(`Point ${n}`, `Item ${n}`)) }],
    steps: [
        B.steps([
            { fr: 'Ouvrir', en: 'Open' },
            { fr: 'Saisir', en: 'Enter' },
        ]),
    ],
    links: [
        {
            type: 'links',
            items: [
                {
                    text: B.pick('Faites votre auto-évaluation', 'Do your self-assessment'),
                    href: '/employee/self-assessment',
                },
                {
                    text: B.pick('3 actions en attente', '3 actions waiting'),
                    href: '/notifications',
                },
            ],
        },
    ],
    bar: [
        {
            type: 'bar',
            label: B.pick('Couverture d’évaluation', 'Assessment coverage'),
            value: 41,
            max: 50,
            n: 12,
        },
        {
            type: 'bar',
            label: B.pick('Maîtrise moyenne', 'Average proficiency'),
            value: 3.4,
            max: 4,
        },
        { type: 'bar', label: B.pick('Sans mesure', 'Not measured'), value: null, max: 100 },
    ],
    notice: [
        B.notice('Information : rien à faire.', 'For information: nothing to do.', 'info'),
        B.notice(
            'Action requise avant le 31/10/2026.',
            'Action required before 31/10/2026.',
            'warning'
        ),
        B.notice(
            'Ne faites pas les tâches concernées.',
            'Do not carry out the tasks concerned.',
            'critical'
        ),
    ],
    button: [B.button('Ouvrir', 'Open', '/notifications')],
});

function esc(s) {
    return T.esc(s);
}

/**
 * Render everything into `outDir`. Options: { outDir, accent, app, logo }.
 * The mock brand is injected through NotificationService._brand for the
 * duration of the run (restored afterwards), so the output does not depend on
 * any settings store.
 */
async function main(options = {}) {
    const outDir = path.resolve(options.outDir || path.join(os.tmpdir(), 'notif-samples'));
    const ACCENT = options.accent || T.BRAND_FALLBACK;
    const APP = options.app || 'Démo Talents';
    const WITH_LOGO = options.logo !== false;
    const LOGO_PNG_B64 = squarePng(ACCENT).toString('base64');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the directory it was asked to write into
    fs.mkdirSync(outDir, { recursive: true });
    if (WITH_LOGO) writeOut(outDir, 'logo.png', Buffer.from(LOGO_PNG_B64, 'base64'));
    samples.length = 0;
    const realBrand = N._brand;
    N._brand = async () => ({
        appName: APP,
        accent: ACCENT,
        ink: T.INK,
        logo: WITH_LOGO ? `data:image/png;base64,${LOGO_PNG_B64}` : '',
    });
    try {
        return await renderAll({ outDir, ACCENT, APP, WITH_LOGO });
    } finally {
        N._brand = realBrand;
    }
}

async function renderAll({ outDir, ACCENT, APP, WITH_LOGO }) {
    const brand = await N._brand();
    // 1) Every kind of the catalogue, FR and EN, with a hostile payload (what an
    //    emitter without blocks gets).
    for (const kind of catalogue.kinds()) {
        for (const locale of ['fr', 'en']) {
            const mail = N._render({
                kind,
                payload: HOSTILE,
                brand,
                recipientName: 'Jo',
                locale,
            });
            save(outDir, `kind-${kind}-${locale}`, mail, {
                group: 'kind',
                kind,
                locale,
                tier: N._tier(kind),
                mandatory: N._isMandatory(kind),
            });
        }
    }

    // 2) Every block type, alone (FR) and all together (FR + EN).
    for (const locale of ['fr', 'en']) {
        const B = T.blocks(locale);
        const all = BLOCKS(B);
        if (locale === 'fr') {
            for (const [type, blocks] of Object.entries(all)) {
                const mail = await N.renderEmail({
                    kind: 'cycle.reminder',
                    title: `Bloc « ${type} »`,
                    intro: `Rendu du type de bloc ${type}.`,
                    blocks,
                    ctaUrl: '/notifications',
                    locale,
                });
                save(outDir, `block-${type}-fr`, mail, {
                    group: 'block',
                    kind: 'cycle.reminder',
                    block: type,
                    locale,
                });
            }
        }
        const mail = await N.renderEmail({
            kind: 'coverage.breach',
            severity: 'critical',
            title: B.pick('Tous les types de blocs', 'All block types'),
            intro: B.pick(
                'Tous les types de blocs dans un seul e-mail.',
                'Every block type in one mail.'
            ),
            preheader: B.pick('Exemple avec tous les blocs', 'Sample with every block'),
            blocks: Object.values(all).flat(),
            locale,
        });
        save(outDir, `blocks-all-${locale}`, mail, {
            group: 'block',
            kind: 'coverage.breach',
            block: '*',
            locale,
        });
    }

    // 3) A mandatory mail (no List-Unsubscribe, « Message obligatoire »).
    save(
        outDir,
        'mandatory-safety-fr',
        await N.renderEmail({
            kind: 'safety.blocked',
            severity: 'critical',
            title: 'Votre habilitation sécurité est bloquée',
            intro: 'Une habilitation sécurité doit être régularisée avant votre prochaine affectation.',
            locale: 'fr',
        }),
        { group: 'special', kind: 'safety.blocked', locale: 'fr', mandatory: true }
    );

    // 4) The daily digest, FR and EN, through sendDigest itself.
    const saved = {
        listInApp: N.listInApp,
        resolve: N._resolveRecipient,
        allowed: N._userEmailAllowed,
        outstanding: N._outstandingCount,
        cat: EmailService.isCategoryEnabled,
        send: EmailService.send,
    };
    let captured = null;
    try {
        const now = new Date();
        N.listInApp = async () => [
            { id: 1, kind: 'sa.changes_requested', payload: '{}', locale: 'fr', created_at: now },
            {
                id: 2,
                kind: 'cycle.escalation',
                payload: JSON.stringify({ cycle: 'C-2026-T4', stage: 'overdue', overdueDays: 4 }),
                locale: 'fr',
                created_at: now,
            },
            { id: 3, kind: 'ninebox.approved', payload: '{}', locale: 'fr', created_at: now }, // tier none → excluded
        ];
        N._resolveRecipient = async () => ({
            email: 'jo@example.test',
            name: 'Jo',
            emailStatus: null,
        });
        N._userEmailAllowed = async () => true;
        N._outstandingCount = async () => 4;
        EmailService.isCategoryEnabled = async () => true;
        EmailService.send = async (m) => {
            captured = m;
            return { sent: true };
        };
        for (const locale of ['fr', 'en']) {
            captured = null;
            await N.sendDigest({ userType: 'employee', userId: 1, locale });
            if (captured)
                save(outDir, `digest-daily-${locale}`, captured, {
                    group: 'digest',
                    kind: 'digest.daily',
                    locale,
                });
        }
    } finally {
        N.listInApp = saved.listInApp;
        N._resolveRecipient = saved.resolve;
        N._userEmailAllowed = saved.allowed;
        N._outstandingCount = saved.outstanding;
        EmailService.isCategoryEnabled = saved.cat;
        EmailService.send = saved.send;
    }

    // 5) Index + machine-readable summary.
    const rows = samples
        .map(
            (s) =>
                `<tr><td>${esc(s.group || '')}</td><td><a href="${esc(s.name)}.html">${esc(s.name)}</a></td><td>${esc(s.subject)}</td><td>${s.mandatory ? 'mandatory' : ''}</td><td><a href="${esc(s.name)}.txt">text</a></td></tr>`
        )
        .join('\n');
    writeOut(
        outDir,
        'index.html',
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notification samples (${samples.length})</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#1a1a1a}td,th{padding:4px 8px;border-bottom:1px solid #e5e7eb;text-align:left;font-size:14px}</style></head>
<body><h1>Notification samples — ${samples.length} rendered</h1>
<p>Mock brand: ${esc(APP)}, accent ${esc(ACCENT)}${WITH_LOGO ? ', logo as a CID attachment (logo.png)' : ', no logo'}. <code>cid:</code> images do not show outside a mail client.</p>
<table><tr><th>Group</th><th>Sample</th><th>Subject</th><th></th><th></th></tr>
${rows}
</table></body></html>`
    );
    writeOut(outDir, 'samples.json', JSON.stringify(samples, null, 2));
    return { outDir, count: samples.length, samples };
}

if (require.main === module) {
    main(cliOptions(process.argv))
        .then((r) => console.log(`[render-notification-samples] ${r.count} samples → ${r.outDir}`))
        .catch((e) => {
            console.error(e);
            process.exit(1);
        });
}

module.exports = { main, HOSTILE };
