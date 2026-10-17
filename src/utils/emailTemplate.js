'use strict';

const PRODUCT = require('../config/product');
/**
 * emailTemplate — the ONE branded, email-client-safe HTML layout for every
 * outbound mail: one look, one language, one footer.
 *
 * `renderEmail({ kind, title, intro, blocks, … })` (NotificationService.renderEmail,
 * re-exported here) is THE way to build a mail. It composes the body with
 * layout() / button() / footer() below. Table-based markup and inline styles
 * only (Outlook / Gmail safe), fluid (width:100%; max-width:600px), lang +
 * charset + color-scheme + title + preheader, the logo as a CID attachment
 * (never a data: URL), white-label aware (app name and accent colour; the text
 * printed on the accent is computed for a contrast of at least 4.5:1).
 *
 *   const T = require('../utils/emailTemplate');
 *   const B = T.blocks(lang);   // block builders in ONE language
 *   const mail = await T.renderEmail({
 *       kind: 'manager_digest', locale: lang, title: B.pick('Récap', 'Digest'),
 *       blocks: [B.kpis([...]), B.section('…', '…'), B.table([...], rows)],
 *   });
 *
 * The bilingual string helpers of earlier versions (wrap, kpis, section, para,
 * table, details, steps, cta, which printed French and English side by side)
 * are gone: `blocks(lang)` takes the same (fr, en) arguments and keeps one.
 *
 * Every helper escapes its inputs — callers pass RAW strings.
 */

const esc = (s) =>
    String(s == null ? '' : s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

/**
 * The URL users should click in emails — the ONE resolver for every absolute
 * link this app puts in front of a user.
 *
 * SECURITY — an email link must NEVER be built from `req.get('host')`. That
 * value is the caller's own `Host` header (or `X-Forwarded-Host` behind a
 * proxy), i.e. fully attacker-controlled. The classic abuse is password reset:
 * the attacker POSTs a reset for a VICTIM's account with `Host: evil.test`, the
 * platform mails the victim a genuine reset link pointing at the attacker, and
 * clicking it hands over a valid single-use token → account takeover. The link
 * therefore comes from server-side configuration, and a request host is only
 * ever honoured when it is on an explicit allowlist.
 *
 * Resolution order:
 *   1. The `appBaseUrl` APP SETTING (App Settings → E-mail). Editable in the UI
 *      by an administrator, with no .env edit and no restart — because the person
 *      who knows the address people actually browse to is the HR administrator,
 *      not whoever can SSH into the box.
 *   2. APP_BASE_URL (documented in .env.example). BASE_URL is accepted as an
 *      alias — both names were in use across the code and an admin who set
 *      only one got relative, unclickable links in half the mail.
 *   3. `req`'s host, ONLY if TRUSTED_HOSTS lists it (comma-separated
 *      host[:port] entries) — for multi-hostname installs behind a proxy.
 *   4. The machine hostname + PORT — the same default the installer writes —
 *      so links never silently vanish on installs whose preserved .env
 *      predates APP_BASE_URL. Note this is a LAST RESORT: the server's own name
 *      frequently does not resolve from where people read their mail.
 *
 * @param {import('express').Request} [req] optional — enables step 3 only.
 */
// The `appBaseUrl` App Setting, cached so baseUrl can stay synchronous for its
// six leaf callers. Warmed at boot and refreshed lazily; `refreshBaseUrl` is
// also called when the setting is saved, so a change takes effect without a
// restart — the whole point of moving it out of .env.
let _settingBase = null;
let _settingAt = 0;
const SETTING_TTL_MS = 30_000;

// The base URL is the address of the APPLICATION ROOT. An operator who pasted
// the sign-in page ("https://host/login") produced "/login/login" in every
// e-mail and "/login/auth/sso/saml/callback" as the SAML ACS suggested on the
// SSO page, a callback no route answered, so every SSO sign-in bounced back to
// the sign-in page. Page paths of the app are never part of the base: strip them.
const APP_PAGE_SUFFIX = /\/(?:login|logout|dashboard|auth(?:\/.*)?)$/i;
const _warnedBase = new Set();
function normalizeBase(raw) {
    let v = String(raw || '')
        .trim()
        .replace(/\/+$/, '');
    if (!v) return '';
    const before = v;
    let guard = 0;
    while (APP_PAGE_SUFFIX.test(v) && guard++ < 5)
        v = v.replace(APP_PAGE_SUFFIX, '').replace(/\/+$/, '');
    if (v !== before && !_warnedBase.has(before)) {
        _warnedBase.add(before);
        console.warn(
            `[config] base URL "${before}" points at a page of the app; using "${v}" (the application root) instead. Fix it in App Settings.`
        );
    }
    return v;
}

async function refreshBaseUrl() {
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        const v = await AppSettingsModel.getValue('appBaseUrl', '');
        _settingBase = normalizeBase(v) || null;
    } catch (_) {
        /* settings unavailable (boot, tests) → env/hostname */
    }
    _settingAt = Date.now();
    return _settingBase;
}

/** Await the setting before resolving — use where correctness beats latency. */
async function baseUrlAsync(req) {
    await refreshBaseUrl();
    return baseUrl(req);
}

function baseUrl(req) {
    // Fire-and-forget refresh when stale: the CURRENT call still uses the last
    // known value, so a settings read can never delay or break an outgoing mail.
    if (Date.now() - _settingAt > SETTING_TTL_MS) {
        refreshBaseUrl().catch(() => {});
    }
    if (_settingBase) return _settingBase;

    const envUrl = normalizeBase(process.env.APP_BASE_URL || process.env.BASE_URL || '');
    if (envUrl) return envUrl;

    if (req && typeof req.get === 'function') {
        const trusted = String(process.env.TRUSTED_HOSTS || '')
            .split(',')
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean);
        const host = String(req.get('host') || '')
            .trim()
            .toLowerCase();
        // Exact match only — no suffix matching ('evil-example.test' must never
        // satisfy an 'example.test' entry).
        if (host && trusted.includes(host)) {
            return `${req.protocol}://${host}`;
        }
        if (host) {
            console.warn(
                `[security] Host header "${host}" is not in TRUSTED_HOSTS — ` +
                    'building the link from the server hostname instead. Set APP_BASE_URL ' +
                    'to the public URL of this instance.'
            );
        }
    }

    try {
        const host = require('os').hostname().toLowerCase();
        return `http://${host}:${process.env.PORT || 3000}`;
    } catch {
        return '';
    }
}

const MUTED = '#4b5563'; // 6.9:1 on #f4f5f7, 7.6:1 on white
const BORDER = '#e5e7eb';
const INK = '#0E1116'; // header band; white text on it is 18.9:1
const BODY = '#374151'; // body copy, 10.3:1 on white
const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The stock accent (src/config/product.js) when no brand colour is configured. */
const BRAND_FALLBACK = PRODUCT.accentColor;
const DARK_TEXT = '#1a1a1a';

/**
 * The colour maths come from utils/branding (the one place they live); a
 * stand-in is used only when that module is unavailable or partially stubbed
 * (unit tests mock it with getBranding alone).
 */
function brandingUtil() {
    try {
        return require('./branding') || {};
    } catch (_) {
        return {};
    }
}

function normalizeHex(v) {
    const u = brandingUtil();
    if (typeof u.normalizeHex === 'function') return u.normalizeHex(v);
    const m = /^#?([0-9a-f]{6})$/i.exec(String(v || '').trim());
    return m ? `#${m[1].toLowerCase()}` : null;
}

function contrastRatio(a, b) {
    const u = brandingUtil();
    if (typeof u.contrastRatio === 'function') return u.contrastRatio(a, b);
    const lum = (hex) => {
        const h = normalizeHex(hex);
        if (!h) return 0;
        const f = (i) => {
            const c = parseInt(h.slice(i, i + 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(1) + 0.7152 * f(3) + 0.0722 * f(5);
    };
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The product's default name — the ONE fallback for every mail. */
function defaultAppName() {
    const u = brandingUtil();
    return (u.DEFAULTS && u.DEFAULTS.appName) || PRODUCT.name;
}

/** A usable #rrggbb accent, else the stock one. */
function accentOf(branding) {
    const raw = branding && (branding.accentColor || branding.accent);
    return normalizeHex(raw) || normalizeHex(BRAND_FALLBACK) || '#5b4be0';
}

/**
 * The text colour to print ON a background: computed, never assumed. Dark
 * #1a1a1a when it reaches 4.5:1; otherwise the better of white and black.
 * Every colour reaches at least 4.58:1 against white or black, so the result
 * always passes WCAG AA for normal text.
 */
function onColor(bg) {
    const b = normalizeHex(bg) || accentOf(null);
    if (contrastRatio(b, DARK_TEXT) >= 4.5) return DARK_TEXT;
    return contrastRatio(b, '#ffffff') >= contrastRatio(b, '#000000') ? '#ffffff' : '#000000';
}

const NAMED = new Map([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
    ['nbsp', String.fromCharCode(160)],
    ['rarr', '→'],
    ['larr', '←'],
    ['mdash', '—'],
    ['ndash', '–'],
    ['hellip', '…'],
    ['laquo', '«'],
    ['raquo', '»'],
    ['euro', '€'],
    ['middot', '·'],
    ['copy', '©'],
]);

/** Decode HTML entities (named subset + every numeric form). */
function decodeEntities(s) {
    return String(s).replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (m, e) => {
        if (e[0] === '#') {
            const code =
                e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000
                ? String.fromCodePoint(code)
                : m;
        }
        const v = NAMED.get(e.toLowerCase());
        return v == null ? m : v;
    });
}

const BLOCK_TAGS = new Set([
    'p',
    'div',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'tr',
    'table',
    'ul',
    'ol',
    'blockquote',
]);
const SKIPPED_TAGS = new Set(['head', 'style', 'script', 'title']);

/** The value of one attribute in a tag's source text, or null. */
function attrOf(tagText, name) {
    const lower = tagText.toLowerCase();
    let i = lower.indexOf(`${name}=`);
    while (i > 0 && !/\s/.test(lower[i - 1])) i = lower.indexOf(`${name}=`, i + 1);
    if (i < 0) return null;
    let j = i + name.length + 1;
    const q = tagText[j];
    if (q === '"' || q === "'") {
        const end = tagText.indexOf(q, j + 1);
        return end < 0 ? null : tagText.slice(j + 1, end);
    }
    let end = j;
    while (end < tagText.length && !/[\s>]/.test(tagText[end])) end++;
    return tagText.slice(j, end);
}

/**
 * Plain-text part from HTML: block elements become line breaks, links keep
 * their target (« libellé (https://…) »), list items get a dash, entities are
 * DECODED, the hidden preheader and <head>/<style> are dropped, runs of blank
 * lines collapse. A single forward scan over the markup (indexOf, no regular
 * expression over the document), so it is linear in the size of the mail.
 */
function htmlToText(html) {
    const s = String(html == null ? '' : html);
    let out = '';
    let i = 0;
    let link = null; // { href, label }
    let hiddenDepth = 0;
    const emit = (t) => {
        if (hiddenDepth) return;
        if (link) link.label += t;
        else out += t;
    };
    while (i < s.length) {
        const lt = s.indexOf('<', i);
        if (lt < 0) {
            emit(s.slice(i));
            break;
        }
        if (lt > i) emit(s.slice(i, lt));
        if (s.startsWith('<!--', lt)) {
            const end = s.indexOf('-->', lt + 4);
            i = end < 0 ? s.length : end + 3;
            continue;
        }
        const gt = s.indexOf('>', lt + 1);
        if (gt < 0) {
            emit(s.slice(lt));
            break;
        }
        const tagText = s.slice(lt + 1, gt);
        i = gt + 1;
        const closing = tagText.startsWith('/');
        const name = (closing ? tagText.slice(1) : tagText)
            .trim()
            .split(/[\s/]/, 1)[0]
            .toLowerCase();
        if (!closing && SKIPPED_TAGS.has(name)) {
            const end = s.toLowerCase().indexOf(`</${name}`, i);
            const close = end < 0 ? -1 : s.indexOf('>', end);
            i = close < 0 ? s.length : close + 1;
            continue;
        }
        if (name === 'div') {
            const style = (attrOf(tagText, 'style') || '').replace(/\s+/g, '').toLowerCase();
            if (!closing && (hiddenDepth || style.includes('display:none'))) {
                hiddenDepth++;
                continue;
            }
            if (closing && hiddenDepth) {
                hiddenDepth--;
                continue;
            }
        }
        if (name === 'a') {
            if (!closing) {
                const href = attrOf(tagText, 'href');
                link = href != null ? { href: decodeEntities(href), label: '' } : null;
            } else if (link) {
                const label = decodeEntities(link.label.replace(/\s+/g, ' ').trim());
                const url = link.href;
                link = null;
                emit(!label || label === url ? url : `${label} (${url})`);
            }
            continue;
        }
        if (name === 'br') emit('\n');
        else if (name === 'li' && !closing) emit('\n- ');
        else if ((name === 'td' || name === 'th') && closing) emit(' ');
        else if (BLOCK_TAGS.has(name)) emit('\n');
    }
    return decodeEntities(out)
        .split('\n')
        .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Footer copy: one language, why + préférences, or « Message obligatoire ». */
const FOOTER = {
    fr: {
        auto: (app) => `Ceci est un message automatique de ${app}, merci de ne pas y répondre.`,
        why: (app) => `Vous le recevez parce que vous avez un compte sur ${app}.`,
        prefs: 'Gérer mes préférences de notification',
        prefsWhere: 'Mon compte → Notifications',
        mandatory:
            'Message obligatoire : il concerne la sécurité ou la sûreté et ne peut pas être désactivé.',
    },
    en: {
        auto: (app) => `This is an automated message from ${app}; please do not reply.`,
        why: (app) => `You receive it because you have an account on ${app}.`,
        prefs: 'Manage my notification preferences',
        prefsWhere: 'My account → Notifications',
        mandatory: 'Mandatory message: it concerns safety or security and cannot be switched off.',
    },
};

/** French puts a space before « : », English does not. */
const colon = (l) => (lang2(l) === 'en' ? ':' : ' :');

const lang2 = (l) =>
    String(l || 'fr')
        .toLowerCase()
        .startsWith('en')
        ? 'en'
        : 'fr';

/** { html, text } of the footer. `prefsUrl` absolute (or null). */
function footer({ appName, lang, mandatory, prefsUrl }) {
    const F = FOOTER[lang2(lang)];
    const app = appName || defaultAppName();
    const lines = [esc(F.auto(app)), esc(F.why(app))];
    const text = [F.auto(app), F.why(app)];
    if (mandatory) {
        lines.push(`<strong>${esc(F.mandatory)}</strong>`);
        text.push(F.mandatory);
    } else if (prefsUrl) {
        lines.push(
            `<a href="${esc(prefsUrl)}" style="color:${MUTED};text-decoration:underline">${esc(F.prefs)}</a> (${esc(F.prefsWhere)})`
        );
        text.push(`${F.prefs} (${F.prefsWhere})${colon(lang)} ${prefsUrl}`);
    }
    return {
        html: `<p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED}">${lines.join('<br>')}</p>`,
        text: text.join('\n'),
    };
}

/**
 * Call-to-action button, at least 48 px high, full width on a phone (max
 * 320 px elsewhere), its text colour computed against the accent, followed by
 * the link in clear so it can be copied.
 */
function button({ label, url, accent, lang }) {
    if (!url) return '';
    const bg = accentOf({ accent });
    const fg = onColor(bg);
    const copy =
        lang2(lang) === 'en'
            ? 'If the button does not work, copy this link:'
            : 'Si le bouton ne fonctionne pas, copiez ce lien :';
    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;max-width:320px;margin:24px 0 8px"><tr><td height="48" align="center" style="height:48px;border-radius:8px;background:${bg}">
  <a href="${esc(url)}" style="display:block;padding:14px 24px;line-height:20px;font-family:${FONT};font-size:16px;font-weight:700;color:${fg};text-decoration:none;text-align:center;border-radius:8px">${esc(label)}</a>
</td></tr></table>
<p style="margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED}">${esc(copy)}<br><a href="${esc(url)}" style="color:${BODY};word-break:break-all">${esc(url)}</a></p>`;
}

/**
 * THE document (one look for every mail): <html lang>, charset, viewport,
 * color-scheme (light only), <title>, hidden preheader (at most 90
 * characters), fluid card (width:100%; max-width:600px), ink header with the
 * logo as a CID image or the app name, 4 px brand bar, 24/16 padding, footer.
 * `bodyHtml` / `footerHtml` are trusted HTML built by the escaping helpers.
 */
function layout({ lang, title, preheader, appName, accent, logoCid, bodyHtml, footerHtml }) {
    const l = lang2(lang);
    const app = appName || defaultAppName();
    const bar = accentOf({ accent });
    const head = logoCid
        ? `<img src="cid:${esc(logoCid)}" alt="${esc(app)}" height="32" style="height:32px;width:auto;max-width:190px;display:block;border:0">`
        : `<span style="font-family:${FONT};font-size:19px;line-height:24px;font-weight:800;color:#ffffff">${esc(app)}</span>`;
    const pre = preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${esc(String(preheader).replace(/\s+/g, ' ').trim().slice(0, 90))}</div>`
        : '';
    return `<!doctype html>
<html lang="${l}" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title || app)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;color:${BODY}">
${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#f4f5f7;margin:0;padding:24px 0">
  <tr><td align="center" style="padding:0 8px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${BORDER}">
      <tr><td style="background:${INK};padding:16px 24px" align="left">${head}</td></tr>
      <tr><td style="height:4px;background:${bar};font-size:0;line-height:0">&nbsp;</td></tr>
      <tr><td style="padding:24px 16px;font-family:${FONT};font-size:16px;line-height:24px;color:${BODY}">
${bodyHtml || ''}
      </td></tr>
      <tr><td style="padding:16px;background:#f4f5f7;border-top:1px solid ${BORDER}">${footerHtml || ''}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Block builders in ONE language, for the mails that compose sections,
 * tables and key figures (digests, briefs, account mails). Each takes the
 * French and the English text, as the old bilingual helpers did, and keeps
 * the mail's language only; each returns a renderEmail block (plain text,
 * escaped by the renderer).
 *
 *   const B = blocks('en');
 *   B.pick('Bonjour', 'Hello')                → 'Hello'
 *   B.section('Revues', 'Reviews')            → { type: 'h', text: 'Reviews' }
 *   B.para('…', '…')                          → { type: 'p', text }
 *   B.kpis([{ label, value, sub }])           → { type: 'kv', rows }
 *   B.table([{ fr, en }], rows)               → { type: 'table', head, rows }
 *   B.details([[label, value]])               → { type: 'kv', rows }
 *   B.steps([{ fr, en }])                     → { type: 'list', ordered: true, items }
 *   B.notice('…', '…', 'warning')             → { type: 'notice', … }
 *   B.button('Ouvrir', 'Open', url)           → { type: 'button', label, url }
 * A label given as { fr, en } is resolved the same way.
 */
function blocks(lang) {
    const l = lang2(lang);
    const pick = (fr, en) => {
        if (fr && typeof fr === 'object' && !Array.isArray(fr)) return pick(fr.fr, fr.en);
        if (l === 'en' && en != null && en !== '') return String(en);
        return fr == null ? '' : String(fr);
    };
    return {
        lang: l,
        pick,
        section: (fr, en) => ({ type: 'h', text: pick(fr, en) }),
        para: (fr, en) => ({ type: 'p', text: pick(fr, en) }),
        notice: (fr, en, severity) => ({
            type: 'notice',
            severity: severity || 'info',
            text: pick(fr, en),
        }),
        kpis: (items) => ({
            type: 'kv',
            rows: (items || []).map((k) => [
                pick(k.label, k.labelEn),
                k.sub ? `${k.value} (${pick(k.sub, k.subEn)})` : k.value,
            ]),
        }),
        details: (pairs) => ({
            type: 'kv',
            rows: (pairs || []).map(([k, v]) => [pick(k), v]),
        }),
        table: (headers, rows) => ({
            type: 'table',
            head: (headers || []).map((h) => pick(h)),
            rows: (rows || []).map((r) =>
                (r || []).map((c) =>
                    c && typeof c === 'object' ? { text: c.text, bold: !!c.bold } : c
                )
            ),
        }),
        steps: (items) => ({
            type: 'list',
            ordered: true,
            items: (items || []).map((s) => pick(s)),
        }),
        button: (fr, en, url) => ({ type: 'button', label: pick(fr, en), url }),
    };
}

/**
 * The language of a mail: the recipient's (`locale`, when the caller knows
 * it), else the site's mail language (App Settings → E-mail,
 * `mailDefaultLanguage`), else French. ONE language per mail.
 */
async function mailLang(locale) {
    if (locale) return lang2(locale);
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        return lang2(await AppSettingsModel.getValue('mailDefaultLanguage', 'fr'));
    } catch (_) {
        return 'fr';
    }
}

/**
 * The language of ONE recipient's mails: their own choice (My account →
 * Notifications, migration 183), else `fallback` (the sender's), else the
 * site's mail language. For senders that compose a mail per recipient
 * themselves. Never throws: an unreadable setting is the fallback.
 */
async function recipientLang(userType, userId, fallback) {
    if (userId && (userType === 'admin' || userType === 'employee')) {
        try {
            const db = require('../config/database');
            const r = await db.get(
                'SELECT email_locale FROM notification_user_settings WHERE user_type = ? AND user_id = ?',
                [userType, Number(userId)]
            );
            const l = r && (r.emailLocale ?? r.email_locale);
            if (l === 'fr' || l === 'en') return l;
        } catch (_) {
            /* the fallback below */
        }
    }
    return mailLang(fallback);
}

// ---------------------------------------------------------------------------
// THE composer: blocks → { subject, html, text, attachments, headers }
// ---------------------------------------------------------------------------

/** The notification catalogue (lazy: it is not needed for baseUrl alone). */
function catalogue() {
    return require('../services/notificationCatalogue');
}

/** Mail chrome per language — one language per mail. */
const CHROME = {
    fr: {
        hello: 'Bonjour',
        regards: 'Cordialement',
        team: (app) => `L'équipe ${app}`,
        open: (app) => `Ouvrir dans ${app}`,
        notMeasured: 'Non mesuré',
        generic: 'Une mise à jour vous concernant est disponible sur la plateforme.',
        newNotification: 'Une nouvelle notification',
    },
    en: {
        hello: 'Hello',
        regards: 'Kind regards',
        team: (app) => `The ${app} team`,
        open: (app) => `Open in ${app}`,
        notMeasured: 'Not measured',
        generic: 'An update concerning you is available on the platform.',
        newNotification: 'A new notification',
    },
};

/** Content-ID of the inline logo. */
const LOGO_CID = 'brand-logo@notifications';

/**
 * Severity → chip. The catalogue speaks 'critique' | 'action' | 'echeance' |
 * 'info' | 'favorable'; callers may also pass 'info' | 'warning' | 'critical'.
 * Red is reserved to « Critique »; no emoji. 'info' has no chip.
 */
const SEVERITY_STYLE = {
    critique: { bg: '#b91c1c', fr: 'Critique', en: 'Critical' },
    action: { bg: null, fr: 'Action requise', en: 'Action required' },
    echeance: { bg: '#b45309', fr: 'Échéance', en: 'Deadline' },
    favorable: { bg: '#15803d', fr: 'Décision favorable', en: 'Favourable decision' },
};
const SEVERITY_ALIAS = new Map([
    ['critical', 'critique'],
    ['critique', 'critique'],
    ['warning', 'action'],
    ['action', 'action'],
    ['echeance', 'echeance'],
    ['deadline', 'echeance'],
    ['favorable', 'favorable'],
    ['info', 'info'],
]);

function severityKey(severity, kind) {
    let s = severity != null ? SEVERITY_ALIAS.get(String(severity).toLowerCase()) : null;
    if (!s && kind) s = SEVERITY_ALIAS.get(catalogue().severityOf(kind));
    return s || 'info';
}

/** A number in the reader's language (« 1 234,5 » / « 1,234.5 »). */
function fmtNum(v, digits, lang) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return new Intl.NumberFormat(lang2(lang) === 'en' ? 'en-GB' : 'fr-FR', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    })
        .format(n)
        .replace(/[\u202f\u00a0]/g, ' ');
}

/** An absolute URL for an in-app path (an absolute http(s) URL is kept). */
function absUrl(link) {
    if (!link) return null;
    if (/^https?:\/\//i.test(link)) return link;
    const base = baseUrl();
    const p = String(link).startsWith('/') ? link : `/${link}`;
    return base ? `${base}${p}` : p;
}

/**
 * The logo as a nodemailer inline attachment, or null (PNG / JPEG / GIF of at
 * most 20 KB, shown 32 px high). A larger logo is not sent — the header prints
 * the app name instead — and a data: URL is never put in the HTML (mail
 * clients block it).
 */
function logoAttachment(brand) {
    const raw = String((brand && brand.logo) || '');
    const m = /^data:(image\/(png|jpe?g|gif));base64,/i.exec(raw);
    if (!m) return null;
    const b64 = raw.slice(m[0].length).replace(/\s+/g, '');
    if (!b64 || b64.length > 40000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
    let buf;
    try {
        buf = Buffer.from(b64, 'base64');
    } catch (_) {
        return null;
    }
    if (!buf.length || buf.length > 20 * 1024) return null;
    const ext = m[2].toLowerCase() === 'jpg' ? 'jpeg' : m[2].toLowerCase();
    return {
        filename: `logo.${ext === 'jpeg' ? 'jpg' : ext}`,
        content: buf,
        contentType: `image/${ext}`,
        cid: LOGO_CID,
        contentDisposition: 'inline',
    };
}

/**
 * Tenant branding for a mail (best-effort; the stock identity otherwise).
 * Sequential reads, NOT Promise.all: a mail is often composed inside a
 * transaction, where every query shares ONE pg client.
 */
async function brand() {
    const d = { appName: defaultAppName(), accent: BRAND_FALLBACK, ink: INK, logo: '' };
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        const app = await AppSettingsModel.getValue('appName', null).catch(() => null);
        const accent = await AppSettingsModel.getValue('brandAccentColor', null).catch(() => null);
        const logo = await AppSettingsModel.getValue('brandLogo', null).catch(() => null);
        if (app && String(app).trim()) d.appName = String(app).trim();
        if (accent) d.accent = accentOf({ accent });
        if (logo && /^data:image\//.test(String(logo))) d.logo = String(logo);
    } catch (_) {
        /* stock identity */
    }
    return d;
}

/** THE subject pattern: « {app} — {text} », whitespace folded to one line. */
function subjectLine(appName, text) {
    const app = String(appName || defaultAppName())
        .replace(/\s+/g, ' ')
        .trim();
    const t = String(text == null ? '' : text)
        .replace(/\s+/g, ' ')
        .trim();
    return t ? `${app} — ${t}` : app;
}

/**
 * The subject line of a mail: « {app} — {subject} », where the subject is the
 * kind's catalogue subject (a neutral one when the title states a decision or
 * a status), else its title. It is NEVER built from a payload or from the
 * caller: no person's name, no figure, no date and no status ever reaches a
 * subject line, which is read on lock screens, in notification previews and
 * in shared mailboxes.
 */
function subjectFor(kind, lang, appName) {
    const l = lang2(lang);
    return subjectLine(appName, catalogue().subjectOf(kind, l) || CHROME[l].newNotification);
}

/** The kind's title (+ its subtitle) in one language: the headline INSIDE the mail. */
function kindHeadline(kind, lang, payload) {
    const c = catalogue();
    const l = lang2(lang);
    const title = c.titleOf(kind, l) || kind || '';
    const sub = c.subtitleOf(kind, payload, l);
    return sub ? `${title} — ${sub}` : title;
}

/** The kind's body sentence (never payload-interpolated), else a generic one. */
function kindMessage(kind, lang) {
    const l = lang2(lang);
    const m = catalogue().KIND_MESSAGES[kind];
    if (m) return m[l] || m.fr;
    return CHROME[l].generic;
}

/** renderEmail blocks → { html, text }. Values are plain text, escaped here. */
function renderBlocks(list, { lang, accent } = {}) {
    const l = lang2(lang);
    const C = colon(l);
    const acc = accentOf({ accent });
    const cell = (v) => {
        if (v && typeof v === 'object') v = v.text;
        return v == null || v === '' ? '—' : String(v);
    };
    const bold = (v) => !!(v && typeof v === 'object' && v.bold);
    const NOTICE = new Map([
        ['info', acc],
        ['warning', '#b45309'],
        ['action', '#b45309'],
        ['echeance', '#b45309'],
        ['critical', '#b91c1c'],
        ['critique', '#b91c1c'],
    ]);
    const F = FONT;
    const html = [];
    const text = [];
    for (const b of list || []) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'h') {
            html.push(
                `<h2 style="margin:20px 0 8px;font-family:${F};color:${INK};font-size:17px;line-height:24px;font-weight:700">${esc(cell(b.text))}</h2>`
            );
            text.push(cell(b.text));
        } else if (b.type === 'p') {
            html.push(
                `<p style="margin:0 0 16px;font-family:${F};color:${BODY};font-size:16px;line-height:24px">${esc(cell(b.text))}</p>`
            );
            text.push(cell(b.text));
        } else if (b.type === 'kv') {
            const rows = Array.isArray(b.rows) ? b.rows : [];
            html.push(
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${rows
                    .map(
                        (r) =>
                            `<tr><td style="padding:6px 12px 6px 0;font-family:${F};color:${MUTED};font-size:14px;vertical-align:top">${esc(cell(r && r[0]))}</td><td style="padding:6px 0;font-family:${F};color:${INK};font-size:14px;font-weight:600;vertical-align:top">${esc(cell(r && r[1]))}</td></tr>`
                    )
                    .join('')}</table>`
            );
            text.push(rows.map((r) => `${cell(r && r[0])}${C} ${cell(r && r[1])}`).join('\n'));
        } else if (b.type === 'table') {
            const head = Array.isArray(b.head) ? b.head : [];
            const rows = Array.isArray(b.rows) ? b.rows : [];
            const th = head.length
                ? `<tr>${head.map((h) => `<th align="left" style="padding:6px 8px;border-bottom:2px solid ${BORDER};font-family:${F};color:${MUTED};font-size:13px">${esc(cell(h))}</th>`).join('')}</tr>`
                : '';
            const tr = rows
                .map(
                    (r) =>
                        `<tr>${(Array.isArray(r) ? r : []).map((c) => `<td style="padding:6px 8px;border-bottom:1px solid ${BORDER};font-family:${F};color:${INK};font-size:14px${bold(c) ? ';font-weight:700' : ''}">${esc(cell(c))}</td>`).join('')}</tr>`
                )
                .join('');
            html.push(
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse">${th}${tr}</table>`
            );
            const lines = [];
            if (head.length) lines.push(head.map(cell).join(' | '));
            for (const r of rows) lines.push((Array.isArray(r) ? r : []).map(cell).join(' | '));
            text.push(lines.join('\n'));
        } else if (b.type === 'list') {
            const items = Array.isArray(b.items) ? b.items : [];
            const tag = b.ordered ? 'ol' : 'ul';
            html.push(
                `<${tag} style="margin:0 0 16px;padding-left:20px;font-family:${F};color:${BODY};font-size:16px;line-height:24px">${items.map((i) => `<li>${esc(cell(i))}</li>`).join('')}</${tag}>`
            );
            text.push(
                items.map((i, n) => `${b.ordered ? `${n + 1}.` : '-'} ${cell(i)}`).join('\n')
            );
        } else if (b.type === 'links') {
            const items = (Array.isArray(b.items) ? b.items : []).filter(
                (i) => i && typeof i === 'object'
            );
            html.push(
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px">${items
                    .map((i) => {
                        const href = i.href ? absUrl(String(i.href)) : null;
                        const lbl = esc(cell(i.text));
                        return `<tr><td style="padding:12px 0;border-bottom:1px solid ${BORDER};font-family:${F};font-size:16px;line-height:24px">${href ? `<a href="${esc(href)}" style="color:${INK};font-weight:600;text-decoration:underline">${lbl}</a>` : `<span style="color:${INK};font-weight:600">${lbl}</span>`}</td></tr>`;
                    })
                    .join('')}</table>`
            );
            text.push(
                items
                    .map((i) => {
                        const href = i.href ? absUrl(String(i.href)) : null;
                        return `- ${cell(i.text)}${href ? `${C} ${href}` : ''}`;
                    })
                    .join('\n')
            );
        } else if (b.type === 'bar') {
            const v = b.value == null || b.value === '' ? NaN : Number(b.value);
            const max = Number(b.max);
            const measured = Number.isFinite(v);
            const shown = measured
                ? fmtNum(v, Number.isInteger(v) ? 0 : 1, l)
                : CHROME[l].notMeasured;
            const nTxt =
                b.n != null && Number.isFinite(Number(b.n))
                    ? `n = ${fmtNum(Number(b.n), 0, l)}`
                    : '';
            let bar = '';
            if (measured && Number.isFinite(max) && max > 0) {
                const pct = Math.max(0, Math.min(100, Math.round((v / max) * 100)));
                bar = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>${pct > 0 ? `<td width="${pct}%" style="height:10px;background:${acc};font-size:0;line-height:0">&nbsp;</td>` : ''}${pct < 100 ? `<td style="height:10px;background:#eef0f3;font-size:0;line-height:0">&nbsp;</td>` : ''}</tr></table>`;
            }
            html.push(
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px"><tr><td style="font-family:${F};color:${INK};font-size:14px;padding:0 0 4px">${esc(cell(b.label))}</td><td align="right" style="font-family:${F};color:${INK};font-size:14px;font-weight:600;padding:0 0 4px">${esc(shown)}</td></tr><tr><td colspan="2">${bar}</td></tr>${nTxt ? `<tr><td colspan="2" style="font-family:${F};color:${MUTED};font-size:13px;padding:2px 0 0">${esc(nTxt)}</td></tr>` : ''}</table>`
            );
            text.push(`${cell(b.label)}${C} ${shown}${nTxt ? ` (${nTxt})` : ''}`);
        } else if (b.type === 'button') {
            const url = b.url ? absUrl(String(b.url)) : null;
            if (url && b.label) {
                html.push(button({ label: String(b.label), url, accent: acc, lang: l }));
                text.push(`${cell(b.label)}${C} ${url}`);
            }
        } else if (b.type === 'notice') {
            const colour = NOTICE.get(b.severity) || acc;
            html.push(
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="border-left:4px solid ${colour};background:#f9fafb;padding:12px 16px;font-family:${F};color:${INK};font-size:15px;line-height:22px">${esc(cell(b.text))}</td></tr></table>`
            );
            text.push(cell(b.text));
        }
    }
    return { html: html.join('\n'), text: text.filter(Boolean).join('\n\n') };
}

/**
 * THE composer — every mail goes through here: one look, one language, one
 * subject pattern, one footer. Synchronous. `spec` is renderEmail's argument
 * (kind, severity, title, intro, blocks, ctaLabel, ctaUrl, preheader, locale,
 * mandatory, calendar) plus `payload` (the notification's, for the headline's
 * complement and the default link); `ctx` carries the resolved brand, the
 * recipient's first name for the greeting, `icsEnabled` (the recipient's .ics
 * switch, on by default) and `trackId` (the in-app row the button may go
 * through, see below).
 * Returns { subject, html, text, attachments, headers }.
 */
function compose(spec = {}, ctx = {}) {
    const c = catalogue();
    const b = ctx.brand || {};
    const appName = b.appName || defaultAppName();
    const accent = accentOf(b);
    const lang = lang2(spec.locale);
    const L = CHROME[lang];
    const kind = spec.kind;
    const payload = spec.payload && typeof spec.payload === 'object' ? spec.payload : {};
    const meta = c.KIND_META[kind] || c.MAIL_ONLY[kind] || {};
    const mandatory = spec.mandatory != null ? !!spec.mandatory : c.isMandatory(kind);
    const nonEmpty = (v) => v != null && String(v).trim() !== '';

    // Headline: the caller's title, else the catalogue's. The SUBJECT is always
    // the catalogue's (subjectFor).
    const head = nonEmpty(spec.title)
        ? String(spec.title).trim()
        : kindHeadline(kind, lang, payload);
    const subject = subjectFor(kind, lang, appName);

    const list = Array.isArray(spec.blocks) ? spec.blocks : [];
    let intro = nonEmpty(spec.intro) ? String(spec.intro) : null;
    if (intro == null && !list.length) intro = kindMessage(kind, lang);

    // CTA: explicit → forced kind link → payload link → kind link → the centre.
    const inAppLink = (meta.forceLink && meta.link) || payload.link || meta.link || null;
    const rawLink =
        (nonEmpty(spec.ctaUrl) && String(spec.ctaUrl)) ||
        (meta.forceLink && meta.link) ||
        payload.link ||
        payload.url ||
        meta.link ||
        '/notifications';
    // Measurement (migration 183): when the button lands where the in-app row
    // lands anyway, it goes through /notifications/:id/go, which records that
    // the person opened it and redirects to the same page. No tracking pixel.
    const tracked =
        Number(ctx.trackId) > 0 &&
        Number.isInteger(Number(ctx.trackId)) &&
        rawLink === inAppLink &&
        String(rawLink).startsWith('/') &&
        !String(rawLink).startsWith('//');
    const linkAbs = absUrl(tracked ? `/notifications/${Number(ctx.trackId)}/go` : rawLink);
    const label = nonEmpty(spec.ctaLabel) ? String(spec.ctaLabel) : L.open(appName);

    const greeting = nonEmpty(ctx.recipientName)
        ? `${L.hello} ${String(ctx.recipientName).trim()},`
        : `${L.hello},`;
    const sev = SEVERITY_STYLE[severityKey(spec.severity, kind)];
    let chipHtml = '';
    if (sev) {
        const bg = sev.bg || accent;
        chipHtml = `<p style="margin:0 0 8px"><span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${bg};color:${onColor(bg)};font-family:${FONT};font-size:13px;line-height:20px;font-weight:700">${esc(sev[lang])}</span></p>`;
    }
    const { html: blocksHtml, text: blocksText } = renderBlocks(list, { lang, accent });
    const pBody = (s) =>
        `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:24px;color:${BODY}">${esc(s)}</p>`;
    const bodyHtml = [
        pBody(greeting),
        chipHtml,
        `<h1 style="margin:0 0 12px;font-family:${FONT};font-size:21px;line-height:28px;font-weight:700;color:${INK}">${esc(head)}</h1>`,
        intro != null ? pBody(intro) : '',
        blocksHtml,
        button({ label, url: linkAbs, accent, lang }),
        `<p style="margin:24px 0 0;font-family:${FONT};font-size:15px;line-height:22px;color:${BODY}">${esc(L.regards)},<br><strong>${esc(L.team(appName))}</strong></p>`,
    ]
        .filter(Boolean)
        .join('\n');

    const prefsUrl = absUrl('/account/notifications');
    const foot = footer({ appName, lang, mandatory, prefsUrl });
    const logo = logoAttachment(b);
    const firstP = list.find((x) => x && x.type === 'p' && nonEmpty(x.text));
    const preheader = nonEmpty(spec.preheader)
        ? String(spec.preheader)
        : intro != null
          ? intro
          : firstP
            ? String(firstP.text)
            : head;
    const html = layout({
        lang,
        title: subject,
        preheader,
        appName,
        accent,
        logoCid: logo ? logo.cid : null,
        bodyHtml,
        footerHtml: foot.html,
    });

    const textParts = [greeting];
    if (sev) textParts.push(`[${sev[lang]}]`);
    textParts.push(head);
    if (intro != null) textParts.push(intro);
    if (blocksText) textParts.push(blocksText);
    if (linkAbs) textParts.push(`${label}${colon(lang)} ${linkAbs}`);
    textParts.push(`${L.regards},\n${L.team(appName)}`);
    textParts.push(`--\n${foot.text}`);

    const headers = {
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'All',
    };
    if (!mandatory && prefsUrl) headers['List-Unsubscribe'] = `<${prefsUrl}>`;

    const attachments = logo ? [logo] : [];
    // A dated obligation carries a content-free .ics (IcsService) unless the
    // recipient switched it off (ctx.icsEnabled, on by default).
    const ics =
        spec.calendar && ctx.icsEnabled !== false
            ? icsAttachment(spec.calendar, {
                  appName,
                  lang,
                  url: absUrl(rawLink),
                  kind,
              })
            : null;
    if (ics) attachments.push(ics);

    return {
        subject,
        html,
        text: textParts.filter(Boolean).join('\n\n'),
        attachments,
        headers,
    };
}

/**
 * The .ics attachment of a dated obligation, or null. `calendar` = { type,
 * date | start, end?, allDay?, uid? }: dates, a type and a stable key only;
 * the summary is a fixed phrase, never caller text.
 */
function icsAttachment(calendar, { appName, lang, url, kind } = {}) {
    const c = calendar && typeof calendar === 'object' ? calendar : null;
    if (!c) return null;
    try {
        return require('../services/IcsService').attachment({
            type: c.type,
            start: c.start || c.date,
            end: c.end,
            allDay: c.allDay,
            uid: c.uid || `${kind || 'obligation'}-${String(c.start || c.date || '')}`,
            url: /^https?:\/\//i.test(String(url || '')) ? url : null,
            appName,
            lang,
        });
    } catch (_) {
        return null;
    }
}

/**
 * renderEmail — THE e-mail rendering contract.
 *
 *   await renderEmail({
 *       kind, severity, title, intro, blocks, ctaLabel, ctaUrl,
 *       preheader, locale, mandatory, recipientName,
 *   }) → { subject, html, text, attachments, headers }
 *
 * ASYNC (it resolves the tenant branding and the mail language itself). Every
 * field is optional except `kind`, which must be declared in
 * src/services/notificationCatalogue.js.
 *   kind       catalogue kind: subject, default title, default CTA link,
 *              default severity, mandatory flag
 *   severity   'info' | 'warning' | 'critical' (or the catalogue's
 *              'critique' | 'action' | 'echeance' | 'favorable'); default =
 *              the kind's. Shown as a text chip; red only for critical.
 *   title      plain text headline; default = the kind's title. It is NOT the
 *              subject: the subject is always the catalogue's.
 *   intro      plain text paragraph under the title; default (no blocks) =
 *              the kind's catalogue sentence
 *   blocks     array of content blocks (below; `blocks(lang)` builds them)
 *   ctaLabel   plain text; default « Ouvrir dans {app} » / « Open in {app} »
 *   ctaUrl     app path or absolute URL; default = the kind's link, else
 *              /notifications — there is ALWAYS a button
 *   preheader  plain text shown next to the subject (≤ 90 characters)
 *   locale     the RECIPIENT's 'fr' | 'en'; default = the site's mail language
 *   mandatory  true ⇒ « Message obligatoire » footer, no List-Unsubscribe;
 *              default = the catalogue's flag
 *   recipientName  first name for the greeting (optional)
 *   calendar   { type: 'campaign_deadline'|'deadline'|'session'|…, date | start,
 *              end?, uid? } → a content-free RFC 5545 .ics in `attachments`
 *              (IcsService); dates and a type only, never caller text
 *
 * BLOCK TYPES — every value is PLAIN TEXT, escaped by the renderer (never pass HTML):
 *   { type: 'h', text }                                 a section heading
 *   { type: 'p', text }
 *   { type: 'kv', rows: [[label, value], …] }           value null → « — »
 *   { type: 'table', head: [..], rows: [[..], …] }      cell null → « — »; a cell may be { text, bold }
 *   { type: 'list', items: [..], ordered? }             ordered → 1. 2. 3.
 *   { type: 'links', items: [{ text, href }, …] }       href = app path or absolute URL
 *   { type: 'bar', label, value, max, n }               HTML-table bar (no image);
 *        value null / not finite → « Non mesuré », no bar (never drawn as 0)
 *   { type: 'notice', severity: 'info'|'warning'|'critical', text }
 *   { type: 'button', label, url }                      an early call to action
 * Unknown block types are skipped.
 */
async function renderEmail(spec = {}) {
    const b = await brand();
    const locale = await mailLang(spec.locale);
    const { recipientName, ...rest } = spec || {};
    return compose({ ...rest, locale }, { brand: b, recipientName });
}

module.exports = {
    esc,
    baseUrl,
    baseUrlAsync,
    refreshBaseUrl,
    normalizeBase,
    renderEmail,
    compose,
    icsAttachment,
    renderBlocks,
    mailLang,
    recipientLang,
    blocks,
    brand,
    absUrl,
    fmtNum,
    logoAttachment,
    subjectFor,
    subjectLine,
    kindHeadline,
    kindMessage,
    severityKey,
    SEVERITY_STYLE,
    CHROME,
    LOGO_CID,
    layout,
    footer,
    button,
    onColor,
    accentOf,
    contrastRatio,
    defaultAppName,
    htmlToText,
    decodeEntities,
    BRAND_FALLBACK,
    DARK_TEXT,
    FONT,
    MUTED,
    BODY,
    INK,
    BORDER,
};
