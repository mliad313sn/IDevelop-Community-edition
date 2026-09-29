'use strict';

const PRODUCT = require('../config/product');
/**
 * emailTemplate — the ONE branded, email-client-safe HTML layout for every
 * outbound notification (digests, expiry alerts, nudges, invitations).
 * Table-based markup + inline styles only (Outlook/Gmail-safe), bilingual
 * FR/EN convention (FR primary, EN muted inline), white-label aware
 * (app name + accent color from the branding settings).
 *
 * Compose with the small helpers, then wrap:
 *
 *   const T = require('../utils/emailTemplate');
 *   const html = T.wrap({
 *     branding, title: 'Récap équipe / Team digest',
 *     intro: 'Bonjour Awa,',
 *     blocks: [ T.kpis([...]), T.section(...), T.table(...), T.cta(...) ],
 *   });
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

async function refreshBaseUrl() {
    try {
        const AppSettingsModel = require('../models/AppSettingsModel');
        const v = await AppSettingsModel.getValue('appBaseUrl', '');
        _settingBase =
            String(v || '')
                .trim()
                .replace(/\/+$/, '') || null;
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

    const envUrl = String(process.env.APP_BASE_URL || process.env.BASE_URL || '')
        .trim()
        .replace(/\/+$/, '');
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

const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

/** KPI chip row: [{ label, value, color?, sub? }] */
function kpis(items) {
    const cells = items
        .map(
            (k) => `
        <td style="padding:0 6px 12px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="border:1px solid ${BORDER};border-radius:10px;min-width:110px;">
            <tr><td style="padding:10px 14px;font-family:Segoe UI,Arial,sans-serif;">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};">${esc(k.label)}</div>
              <div style="font-size:22px;font-weight:700;color:${k.color || '#111827'};">${esc(k.value)}</div>
              ${k.sub ? `<div style="font-size:11px;color:${MUTED};">${esc(k.sub)}</div>` : ''}
            </td></tr>
          </table>
        </td>`
        )
        .join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`;
}

/** Section heading: FR title with muted EN twin. */
function section(titleFr, titleEn, color) {
    return `<h3 style="margin:20px 0 8px;font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:${color || '#111827'};">
        ${esc(titleFr)} <span style="color:${MUTED};font-weight:400;font-size:13px;">/ ${esc(titleEn)}</span></h3>`;
}

/** Plain paragraph (FR + optional muted EN). */
function para(fr, en) {
    return `<p style="margin:6px 0;font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#374151;">
        ${esc(fr)}${en ? ` <span style="color:${MUTED};">/ ${esc(en)}</span>` : ''}</p>`;
}

/**
 * Data table: headers = [{fr, en}], rows = array of arrays of
 * strings OR {text, color, bold} cells.
 */
function table(headers, rows) {
    const th = headers
        .map(
            (h) => `
        <th align="left" style="padding:6px 12px 6px 0;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.03em;border-bottom:2px solid ${BORDER};">
            ${esc(h.fr)}${h.en ? `<br><span style="font-weight:400;text-transform:none;">${esc(h.en)}</span>` : ''}</th>`
        )
        .join('');
    const trs = rows
        .map(
            (r) =>
                '<tr>' +
                r
                    .map((c) => {
                        const cell = c && typeof c === 'object' ? c : { text: c };
                        return `<td style="padding:6px 12px 6px 0;font-family:Segoe UI,Arial,sans-serif;font-size:13px;border-bottom:1px solid ${BORDER};color:${cell.color || '#374151'};${cell.bold ? 'font-weight:700;' : ''}">${esc(cell.text)}</td>`;
                    })
                    .join('') +
                '</tr>'
        )
        .join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;"><tr>${th}</tr>${trs}</table>`;
}

/** Key/value detail list (e.g. a user's profile block). */
function details(pairs) {
    const rows = pairs
        .map(
            ([k, v]) => `
        <tr><td style="padding:4px 16px 4px 0;font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:${MUTED};white-space:nowrap;">${esc(k)}</td>
        <td style="padding:4px 0;font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#111827;font-weight:600;">${esc(v)}</td></tr>`
        )
        .join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0;">${rows}</table>`;
}

/** Numbered step list (onboarding "what is expected"). steps = [{fr, en}] */
function steps(items) {
    return (
        '<ol style="margin:6px 0 6px 18px;padding:0;">' +
        items
            .map(
                (s) => `
        <li style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#374151;margin:5px 0;">
            ${esc(s.fr)}${s.en ? ` <span style="color:${MUTED};">/ ${esc(s.en)}</span>` : ''}</li>`
            )
            .join('') +
        '</ol>'
    );
}

/** Call-to-action button (accent-colored). */
function cta(labelFr, labelEn, url, accent) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr><td
        style="background:${accent || '#2563eb'};border-radius:8px;">
        <a href="${esc(url)}" style="display:inline-block;padding:10px 22px;font-family:Segoe UI,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">
            ${esc(labelFr)} / ${esc(labelEn)}</a></td></tr></table>`;
}

/**
 * Branded wrapper. opts:
 *   branding {appName, accentColor?}   title (subject-line style, raw)
 *   intro (greeting line, raw)         blocks (array of html strings from helpers)
 *   footerNote? (raw FR / EN handled by caller via para)
 */
function wrap({ branding, title, intro, blocks, footerNote }) {
    const appName = (branding && branding.appName) || PRODUCT.name;
    const accent = (branding && (branding.accentColor || branding.accent)) || '#2563eb';
    return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f3f4f6;padding:18px 0;"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" width="620" style="max-width:620px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${BORDER};">
      <tr><td style="background:${accent};padding:14px 24px;">
        <span style="font-family:Segoe UI,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;">${esc(appName)}</span>
        <span style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:rgba(255,255,255,.85);"> — ${esc(title)}</span>
      </td></tr>
      <tr><td style="padding:20px 24px 8px;">
        ${intro ? `<p style="margin:0 0 10px;font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827;">${esc(intro)}</p>` : ''}
        ${(blocks || []).join('\n')}
      </td></tr>
      <tr><td style="padding:12px 24px 18px;">
        ${footerNote || para('Cet e-mail est généré automatiquement par la plateforme.', 'This email is generated automatically by the platform.')}
      </td></tr>
    </table>
    <p style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${MUTED};margin:10px 0 0;">${esc(appName)} · Skills, Talent &amp; Compliance</p>
  </td></tr></table>
</body></html>`;
}

module.exports = {
    wrap,
    kpis,
    section,
    para,
    table,
    details,
    steps,
    cta,
    esc,
    baseUrl,
    baseUrlAsync,
    refreshBaseUrl,
};
