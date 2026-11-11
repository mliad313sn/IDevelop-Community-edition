'use strict';

/**
 * IcsService — a minimal RFC 5545 calendar file for a DATED OBLIGATION: the
 * deadline of an assessment campaign today, a session or a hearing tomorrow.
 *
 * Content-free by construction. The SUMMARY and the DESCRIPTION are a fixed
 * phrase per type (« Échéance de campagne — {app} ») plus the app's link; no
 * caller text is ever written: no person's name, no rating, no reason, no
 * campaign title. A calendar entry is copied into phones, shared agendas and
 * synchronised calendars the application can never clean up afterwards.
 *
 *   IcsService.build({ type, start, end, allDay, uid, url, appName, lang, now })
 *       → the VCALENDAR text (CRLF line ends, lines folded at 75 octets), or
 *         null when the date is unusable.
 *   IcsService.attachment(sameArgs) → a nodemailer attachment, or null.
 *
 * An all-day obligation (a deadline) is written as VALUE=DATE, with no time
 * zone at all: the day is the same day everywhere. A timed one (a session) is
 * written in UTC (…Z), which every calendar converts to the reader's zone.
 * The UID is the caller's stable key, so sending the same obligation again
 * (the D-7 and the D-2 reminders of one campaign) updates ONE event.
 */
const TYPES = {
    campaign_deadline: { fr: 'Échéance de campagne', en: 'Campaign deadline', allDay: true },
    deadline: { fr: 'Échéance', en: 'Deadline', allDay: true },
    session: { fr: 'Séance planifiée', en: 'Scheduled session', allDay: false },
    coaching_session: { fr: 'Séance de coaching', en: 'Coaching session', allDay: false },
    review_session: { fr: 'Entretien planifié', en: 'Scheduled review', allDay: false },
    hearing: { fr: 'Audience de contestation', en: 'Dispute hearing', allDay: false },
};

const DESC = {
    fr: (app) => `Ouvrez ${app} pour le détail.`,
    en: (app) => `Open ${app} for the details.`,
};

const FILENAME = { fr: 'echeance.ics', en: 'deadline.ics' };

function lang(l) {
    return String(l || 'fr')
        .toLowerCase()
        .startsWith('en')
        ? 'en'
        : 'fr';
}

function defaultAppName() {
    try {
        return require('../utils/emailTemplate').defaultAppName();
    } catch (_) {
        return 'App';
    }
}

/** RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma, line breaks. */
function escText(s) {
    return String(s == null ? '' : s)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * RFC 5545 §3.1: a content line longer than 75 OCTETS is folded with CRLF and
 * one space. Counts UTF-8 bytes and never splits a multi-byte character.
 */
function fold(line) {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of String(line)) {
        const b = Buffer.byteLength(ch, 'utf8');
        if (bytes + b > 75) {
            out.push(cur);
            cur = ' ';
            bytes = 1;
        }
        cur += ch;
        bytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
}

const pad = (n) => String(n).padStart(2, '0');
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** A Date, an ISO string or 'YYYY-MM-DD' → Date, or null. A bare date is a LOCAL day. */
function toDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    const s = String(v).slice(0, 40);
    if (s.length === 10) {
        const m = DAY_RE.exec(s);
        if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Calendar day of a date-only value (the string's own digits when it starts with 'YYYY-MM-DD'). */
function dayOf(v) {
    const m = typeof v === 'string' ? DAY_RE.exec(v.slice(0, 10)) : null;
    if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    const d = toDate(v);
    return d ? { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() } : null;
}

const fmtDay = (p) => `${p.y}${pad(p.m)}${pad(p.d)}`;
const fmtUtc = (d) =>
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

function nextDay(p) {
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** Characters kept from a caller key or a host name (everything else becomes « - » or goes). */
function keep(s, allowed, max) {
    let out = '';
    for (const ch of String(s || '').slice(0, max * 2)) {
        if (allowed(ch)) out += ch;
        else if (allowed === UID_CHAR) out += '-';
        if (out.length >= max) break;
    }
    return out;
}
const UID_CHAR = (ch) => /[A-Za-z0-9._-]/.test(ch);
const HOST_CHAR = (ch) => /[A-Za-z0-9.-]/.test(ch);

function uidOf(uid, host) {
    const base = keep(uid, UID_CHAR, 120);
    const h = keep(host || 'notifications', HOST_CHAR, 80) || 'notifications';
    return `${base || `obligation-${Date.now()}`}@${h}`;
}

function build({ type, start, end, allDay, uid, url, appName, lang: l, now } = {}) {
    const t = TYPES[type] || TYPES.deadline;
    const L = lang(l);
    const app = String(appName || '').trim() || defaultAppName();
    const isAllDay = allDay != null ? !!allDay : t.allDay;
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        `PRODID:-//${keep(app, (ch) => /[\w .-]/.test(ch), 60) || 'App'}//Notifications//${L.toUpperCase()}`,
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
    ];
    let host = 'notifications';
    const link = url && /^https?:\/\//i.test(String(url)) ? String(url) : null;
    if (link) {
        try {
            host = new URL(link).hostname || host;
        } catch (_) {
            /* a malformed URL: default host */
        }
    }
    lines.push(`UID:${uidOf(uid, host)}`);
    lines.push(`DTSTAMP:${fmtUtc(toDate(now) || new Date())}`);
    if (isAllDay) {
        const p = dayOf(start);
        if (!p || !toDate(start)) return null;
        const q = dayOf(end);
        const endDay = q && fmtDay(q) > fmtDay(p) ? nextDay(q) : nextDay(p);
        lines.push(`DTSTART;VALUE=DATE:${fmtDay(p)}`);
        lines.push(`DTEND;VALUE=DATE:${fmtDay(endDay)}`);
        lines.push('TRANSP:TRANSPARENT');
    } else {
        const s = toDate(start);
        if (!s) return null;
        let e = toDate(end);
        if (!e || e.getTime() <= s.getTime()) e = new Date(s.getTime() + 60 * 60 * 1000);
        lines.push(`DTSTART:${fmtUtc(s)}`);
        lines.push(`DTEND:${fmtUtc(e)}`);
    }
    lines.push(`SUMMARY:${escText(`${t[L]} — ${app}`)}`);
    lines.push(`DESCRIPTION:${escText(DESC[L](app) + (link ? `\n${link}` : ''))}`);
    if (link) lines.push(`URL:${link}`);
    lines.push('CLASS:PRIVATE');
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
}

function attachment(args = {}) {
    const ics = build(args);
    if (!ics) return null;
    return {
        filename: FILENAME[lang(args.lang)],
        content: ics,
        contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
    };
}

module.exports = { build, attachment, TYPES, _escText: escText, _fold: fold };
