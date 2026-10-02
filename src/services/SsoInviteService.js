'use strict';
/**
 * SsoInviteService — 3.23.20 (Amendment C3). The « SSO migration » invitation:
 * tells a person whose EXISTING account has just been migrated to SSO what
 * changed, why it is better and exactly how to sign in.
 *
 * OUTBOX (migration 153, sso_migration_invites): rows are written by database
 * triggers, atomically with the link itself (an SSO-migration mapping, a
 * SuperAdmin link, an onboarding merge, a readiness « confirm », a first
 * sign-in matched by e-mail). This module only DISPATCHES them:
 *   - SSO not live (no interactive provider enabled / not enforced) → rows wait
 *     ('waiting_sso') and go out the moment SSO is live;
 *   - mapping rows wait at least 10 minutes (the console's revert window);
 *   - re-checked at send time: account active (else 'cancelled'), not a
 *     SuperAdmin ('skipped_superadmin'), still linked/mapped for that provider
 *     (else 'cancelled');
 *   - in-app notification always; e-mail when e-mail is on (else
 *     'inapp_only', no retry); no stored address → 'skipped_no_email' (the
 *     Accounts console prints a notice to hand over);
 *   - errors back off 15 min → 1 h → 6 h, then 'failed'; a row stuck in
 *     'sending' for 15 minutes is marked 'failed' (never resent automatically);
 *   - one reminder 7 days after 'sent' when no SSO sign-in happened since.
 *
 * The recipient is the address stored IN THE APP, never one asserted by the
 * IdP. The only link is <base URL>/login — no token, no query string, no
 * password link: this path never calls OnboardingCredentialService.issueAndSend
 * and never touches employees.invited_at. The mail says we never ask for a
 * password by e-mail. Texts: locales/{fr,en}/auth.json (ssoinv_*), FR first.
 *
 * @module services/SsoInviteService
 */
const PRODUCT = require('../config/product');
const db = require('../config/database');

const MAPPING_WAIT_MIN = 10;
const STUCK_SENDING_MIN = 15;
const BACKOFF_MIN = [15, 60, 360]; // after attempt 1, 2, 3 — then 'failed'
const REMINDER_DAYS = 7;
const MANUAL_REQUEUE_COOLDOWN_MIN = 60;
// EXC (3.23.21): the last_error of an invitation held back by an SSO exception.
const EXCEPTION_HOLD = 'sso_exception';
// ANN (3.23.21, PO decision): the announcement goes out 48 h before go-live.
const ANNOUNCE_LEAD_DEFAULT_H = 48;
const ANNOUNCE_LEAD_MIN_H = 24;
const ANNOUNCE_LEAD_MAX_H = 168;
// The signed-in page the in-app notice opens (same text as the e-mail).
const SSO_CHANGE_PATH = '/account/sso-change';

const TEXTS = {
    fr: require('../../locales/fr/auth.json'),
    en: require('../../locales/en/auth.json'),
};

/** i18next-style {{var}} interpolation on the locale files (no i18next needed in a job). */
function tr(lang, key, vars = {}) {
    const s = (TEXTS[lang] && TEXTS[lang][key]) || TEXTS.fr[key] || key;
    return String(s).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
        vars[k] == null ? '' : String(vars[k])
    );
}

const isMissingTable = (e) =>
    !!e &&
    (e.code === '42P01' ||
        (/sso_migration_invites/.test(String(e.message)) &&
            /does not exist/.test(String(e.message))));

/** SSO is LIVE: enforced (the switch is on) AND an interactive provider is registered. */
function isSsoLive() {
    try {
        const sso = require('../config/sso');
        const enforced = require('./AdminSsoService').isEnforced();
        const providers =
            typeof sso.getEnabledProviders === 'function' ? sso.getEnabledProviders() : [];
        return enforced && Array.isArray(providers) && providers.length > 0;
    } catch (_) {
        return false;
    }
}

/** The enabled provider descriptor (or the test-only one while SSO is off), or null. */
function providerInfo(key) {
    try {
        const sso = require('../config/sso');
        const p = (sso.getEnabledProviders() || []).find((x) => x.key === key);
        if (p) return p;
        const t = typeof sso.getTestProvider === 'function' ? sso.getTestProvider(key) : null;
        return t || null;
    } catch (_) {
        return null;
    }
}

/**
 * The provider NAME printed in sentences (« votre compte {{provider}} »): the
 * brand (Microsoft, Google), else the operator's label — a button phrase such as
 * « Sign in with Contoso » is reduced to « Contoso » (UX-11: the invitation read
 * « Se connecter avec Sign in with … »).
 */
function providerLabel(key) {
    const p = providerInfo(key);
    if (p && p.name) return String(p.name);
    if (p && p.label) {
        const m = /^(?:sign in with|log in with|se connecter avec)\s+(.+)$/i.exec(
            String(p.label).trim()
        );
        // « Sign in with your Contoso Account » → « Contoso Account »: the sentence
        // already says « votre compte … » (invitations used to read « votre
        // compte d'entreprise your … Account »).
        const name = (m ? m[1] : String(p.label))
            .replace(/^(?:your|votre|ton|the|le|la)\s+/i, '')
            .replace(/^(?:compte|account)\s+/i, '')
            .replace(/\s+(?:account|compte)$/i, '')
            .trim();
        return name || String(p.label);
    }
    return (
        { entra: 'Microsoft', google: 'Google', saml: 'SSO', oidc: 'SSO' }[key] ||
        String(key || 'SSO')
    );
}

/**
 * The bare fallback label ('SSO', a generic SAML/OIDC provider with no
 * name) is never printed in a sentence: « votre compte d'entreprise SSO » read
 * like a product name. It then reads « votre compte d'entreprise ».
 */
function isBareLabel(label) {
    return !label || /^\s*sso\s*$/i.test(String(label));
}

/**
 * « le même que pour Windows ou Outlook » is only true for a Microsoft (Entra)
 * account: the provider key 'entra', or a provider NAMED Microsoft.
 */
function isMicrosoftProvider(key, label) {
    return key === 'entra' || /\bmicrosoft\b/i.test(String(label || ''));
}

/** « votre compte Microsoft » / « votre compte d'entreprise » in the reader's language. */
function accountPhrase(lang, provider) {
    return isBareLabel(provider)
        ? tr(lang, 'ssoinv_account_generic')
        : tr(lang, 'ssoinv_account_named', { provider });
}

/** The login-page button text exactly as the person will see it (views/pages/auth/login.ejs). */
function buttonText(key, lang) {
    const p = providerInfo(key);
    if (!p) return tr(lang, 'login_sso_with', { name: providerLabel(key) });
    if (p.customLabel && p.label) return String(p.label);
    return p.name ? tr(lang, 'login_sso_with', { name: p.name }) : tr(lang, 'login_sso_org');
}

async function setting(key, dflt) {
    try {
        return await require('../models/AppSettingsModel').getValue(key, dflt);
    } catch (_) {
        return dflt;
    }
}

/** The help contact (setting sso.helpContact) or null. */
async function helpContact() {
    const v = String((await setting('sso.helpContact', '')) || '').trim();
    return v || null;
}

async function appName() {
    try {
        const b = await require('../utils/branding').getBranding();
        if (b && b.appName) return String(b.appName);
    } catch (_) {
        /* stock */
    }
    return PRODUCT.name;
}

/** The account an outbox row is about, as the dispatcher needs it. */
async function recipientOf(row) {
    const type = row.subjectType ?? row.subject_type;
    const id = Number(row.subjectId ?? row.subject_id);
    if (type === 'admin') {
        const a = await db.get(
            'SELECT id, username, email, role, is_active, linked_employee_id FROM admins WHERE id = ?',
            [id]
        );
        if (!a) return null;
        let first = a.username;
        const le = a.linkedEmployeeId ?? a.linked_employee_id;
        if (le) {
            const e = await db.get('SELECT first_name FROM employees WHERE id = ?', [Number(le)]);
            if (e && (e.firstName ?? e.first_name)) first = e.firstName ?? e.first_name;
        }
        return {
            type,
            id,
            isAdmin: true,
            superadmin: a.role === 'superadmin',
            active: (a.isActive ?? a.is_active) !== false,
            email: String(a.email || '').trim() || null,
            firstName: first,
            name: a.username,
            linkedEmployeeId: le ? Number(le) : null,
        };
    }
    const e = await db.get(
        `SELECT id, first_name, last_name, email, employee_number, is_active, erased_at, cancelled_at
           FROM employees WHERE id = ?`,
        [id]
    );
    if (!e) return null;
    return {
        type: 'employee',
        id,
        isAdmin: false,
        superadmin: false,
        active:
            (e.isActive ?? e.is_active) !== false &&
            !(e.erasedAt ?? e.erased_at) &&
            !(e.cancelledAt ?? e.cancelled_at),
        email: String(e.email || '').trim() || null,
        firstName: e.firstName ?? e.first_name,
        name: `${e.firstName ?? e.first_name ?? ''} ${e.lastName ?? e.last_name ?? ''}`.trim(),
        employeeNumber: e.employeeNumber ?? e.employee_number,
    };
}

/** Still migrated for that provider (identity or open/bound mapping)? */
async function stillMigrated(row, rec) {
    const provider = row.provider;
    if (rec.type === 'employee') {
        const hit = await db.get(
            `SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM user_identities
                                            WHERE subject_type = 'employee' AND subject_id = ? AND sso_provider = ?)
                             OR EXISTS (SELECT 1 FROM sso_pending_links
                                         WHERE employee_id = ? AND provider = ? AND status IN ('pending', 'bound'))`,
            [rec.id, provider, rec.id, provider]
        );
        return !!hit;
    }
    const hit = await db.get(
        `SELECT 1 AS ok FROM user_identities
          WHERE sso_provider = ?
            AND ((subject_type = 'admin' AND subject_id = ?)
              OR (subject_type = 'employee' AND subject_id = ?
                  AND link_method IN ('superadmin_link', 'onboarding_merge')))
          LIMIT 1`,
        [provider, rec.id, rec.linkedEmployeeId || 0]
    );
    return !!hit;
}

/** The company login to print (mapping UPN, else an e-mail-like identity id). */
async function upnFor(row, rec) {
    try {
        const empId = rec.type === 'employee' ? rec.id : rec.linkedEmployeeId;
        if (empId) {
            const m = await db.get(
                `SELECT match_upn FROM sso_pending_links
                  WHERE employee_id = ? AND provider = ? AND match_upn IS NOT NULL
                  ORDER BY id DESC LIMIT 1`,
                [empId, row.provider]
            );
            const upn = m && (m.matchUpn ?? m.match_upn);
            if (upn) return String(upn);
        }
        const i = await db.get(
            `SELECT sso_uid FROM user_identities
              WHERE sso_provider = ? AND sso_uid LIKE '%@%'
                AND ((subject_type = ? AND subject_id = ?) OR (subject_type = 'employee' AND subject_id = ?))
              ORDER BY id DESC LIMIT 1`,
            [row.provider, rec.type, rec.id, empId || 0]
        );
        const uid = i && (i.ssoUid ?? i.sso_uid);
        return uid ? String(uid) : null;
    } catch (_) {
        return null;
    }
}

/**
 * One ordered content spec → the three renderings (e-mail HTML, plain text /
 * printed notice, signed-in page /account/sso-change). The page shows the SAME
 * sentences as the e-mail, in the reader's language.
 *   spec item: { t: 'p'|'h'|'steps'|'cta', k?: key, ks?: [keys], href? }
 */
function pageOf(spec, v, lang) {
    return spec
        .filter((b) => b.t !== 'cta') // the page is read signed in: no « sign in » button
        .map((b) =>
            b.t === 'steps'
                ? { t: 'steps', items: b.ks.map((k) => tr(lang, k, v(lang))) }
                : { t: b.t, text: tr(lang, b.k, v(lang)) }
        );
}

/**
 * Compose the invitation (FR first, EN below) — pure given its inputs.
 * `providerKey` (entra/google/saml/oidc…) selects the Microsoft-only sentence
 * « le même que pour Windows ou Outlook »; a provider NAMED Microsoft does too.
 * @returns {{subject:string, html:string, text:string, page:{fr:object, en:object}}}
 */
function compose({
    rec,
    provider,
    providerKey = null,
    variant,
    upn,
    contact,
    app,
    url,
    reminder = false,
    branding = null,
    buttons = null,
}) {
    const T = require('../utils/emailTemplate');
    const v = (lang) => ({
        app,
        provider,
        account: accountPhrase(lang, provider),
        url,
        upn,
        first: rec.firstName || rec.name || '',
        contact: contact || tr(lang, 'ssoinv_contact_default'),
        // UX-11: the button's own text, as printed on the sign-in page.
        button:
            (buttons && buttons[lang]) ||
            (isBareLabel(provider)
                ? tr(lang, 'login_sso_org')
                : tr(lang, 'login_sso_with', { name: provider })),
    });
    // UX-11: French puts a space before « : », English does not.
    const colon = (lang) => (lang === 'fr' ? ' :' : ':');
    const introKey = isMicrosoftProvider(providerKey, provider)
        ? 'ssoinv_intro_ms'
        : 'ssoinv_intro';
    const step3 = upn ? 'ssoinv_step3_upn' : 'ssoinv_step3';
    const spec = [
        variant === 'security_notice' ? { t: 'p', k: 'ssoinv_security_notice' } : null,
        { t: 'p', k: introKey },
        { t: 'h', k: 'ssoinv_benefits_title' },
        { t: 'p', k: 'ssoinv_benefits' },
        { t: 'h', k: 'ssoinv_how_title' },
        { t: 'steps', ks: ['ssoinv_step1', 'ssoinv_step2', step3] },
        rec.isAdmin ? { t: 'h', k: 'ssoinv_admin_title' } : null,
        rec.isAdmin ? { t: 'p', k: 'ssoinv_admin' } : null,
        { t: 'p', k: 'ssoinv_shared_pc' },
        { t: 'p', k: 'ssoinv_never_password' },
        url ? { t: 'cta', k: 'ssoinv_cta', href: `${url}/login` } : null,
        { t: 'p', k: 'ssoinv_help' },
    ].filter(Boolean);
    const both = (key) => [tr('fr', key, v('fr')), tr('en', key, v('en'))];
    const blocks = spec.map((b) => {
        if (b.t === 'h') return T.section(...both(b.k));
        if (b.t === 'steps')
            return T.steps(
                b.ks.map((k) => ({ fr: tr('fr', k, v('fr')), en: tr('en', k, v('en')) }))
            );
        if (b.t === 'cta') return T.cta(...both(b.k), b.href, branding && branding.accentColor);
        return T.para(...both(b.k));
    });
    // The reminder prefix is in BOTH halves (« Rappel : … / Reminder: … »).
    const pre = (lang) => (reminder ? `${tr(lang, 'ssoinv_reminder_prefix')} ` : '');
    const subject = `${pre('fr')}${tr('fr', 'ssoinv_subject', v('fr'))} / ${pre('en')}${tr('en', 'ssoinv_subject', v('en'))}`;
    const html = T.wrap({
        branding: branding || { appName: app },
        title: `${tr('fr', 'ssoinv_title')} / ${tr('en', 'ssoinv_title')}`,
        intro: tr('fr', 'ssoinv_hello', v('fr')),
        blocks,
    });
    const lines = (lang) =>
        [
            tr(lang, 'ssoinv_hello', v(lang)),
            variant === 'security_notice' ? tr(lang, 'ssoinv_security_notice', v(lang)) : null,
            tr(lang, introKey, v(lang)),
            `${tr(lang, 'ssoinv_benefits_title')}${colon(lang)} ${tr(lang, 'ssoinv_benefits', v(lang))}`,
            `${tr(lang, 'ssoinv_how_title')}${colon(lang)}`,
            `1. ${tr(lang, 'ssoinv_step1', v(lang))}`,
            `2. ${tr(lang, 'ssoinv_step2', v(lang))}`,
            `3. ${tr(lang, step3, v(lang))}`,
            rec.isAdmin ? tr(lang, 'ssoinv_admin', v(lang)) : null,
            tr(lang, 'ssoinv_shared_pc'),
            tr(lang, 'ssoinv_never_password'),
            tr(lang, 'ssoinv_help', v(lang)),
        ]
            .filter(Boolean)
            .join('\n');
    const page = (lang) => ({
        heading: tr(lang, 'ssoinv_title'),
        hello: tr(lang, 'ssoinv_hello', v(lang)),
        blocks: pageOf(spec, v, lang),
    });
    return {
        subject,
        html,
        text: `${lines('fr')}\n\n----\n\n${lines('en')}`,
        page: { fr: page('fr'), en: page('en') },
    };
}

/** Everything compose needs for one outbox row. */
async function messageFor(row, rec, { reminder = false } = {}) {
    const T = require('../utils/emailTemplate');
    let branding = null;
    try {
        branding = await require('../utils/branding').getBranding();
    } catch (_) {
        branding = null;
    }
    return compose({
        rec,
        provider: providerLabel(row.provider),
        providerKey: row.provider,
        variant: row.variant || 'standard',
        upn: await upnFor(row, rec),
        contact: await helpContact(),
        app: (branding && branding.appName) || (await appName()),
        url: String((await T.baseUrlAsync()) || '').replace(/\/+$/, ''),
        reminder,
        branding,
        buttons: { fr: buttonText(row.provider, 'fr'), en: buttonText(row.provider, 'en') },
    });
}

function audit(action, row, details) {
    try {
        require('./LogService')
            .log({
                adminId: null,
                action,
                entityType: row.subjectType ?? row.subject_type,
                entityId: Number(row.subjectId ?? row.subject_id),
                category: 'security',
                details: `${details} (invitation #${row.id}, provider ${row.provider}, trigger ${row.trigger})`,
            })
            .catch(() => {});
    } catch (_) {
        /* audit best-effort */
    }
}

async function setStatus(row, status, extra = {}) {
    const sets = ['status = ?'];
    const params = [status];
    for (const [col, val] of Object.entries(extra)) {
        if (val === 'now()') sets.push(`${col} = now()`);
        else {
            sets.push(`${col} = ?`);
            params.push(val);
        }
    }
    params.push(Number(row.id));
    // Only the claim holder writes the outcome: a row the stuck-sending sweep
    // already marked 'failed' (or a console re-queue) is never overwritten.
    await db.run(
        `UPDATE sso_migration_invites SET ${sets.join(', ')} WHERE id = ? AND status = 'sending'`,
        params
    );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One claimed row → exactly one outcome. */
async function deliver(row) {
    const rec = await recipientOf(row);
    if (!rec) {
        await setStatus(row, 'cancelled', { last_error: 'account not found' });
        audit('SSO_MIGRATION_NOTICE_SKIPPED', row, 'skipped: account not found');
        return 'cancelled';
    }
    if (rec.superadmin) {
        await setStatus(row, 'skipped_superadmin');
        audit('SSO_MIGRATION_NOTICE_SKIPPED', row, 'skipped: superadmin (never through SSO)');
        return 'skipped_superadmin';
    }
    if (!rec.active) {
        await setStatus(row, 'cancelled', { last_error: 'account inactive' });
        audit('SSO_MIGRATION_NOTICE_SKIPPED', row, 'skipped: account inactive');
        return 'cancelled';
    }
    // EXC (3.23.21): a SuperAdmin-listed SSO exception keeps its password — no
    // SSO invitation. Held back as 'cancelled' (reason sso_exception); clearing
    // the exception re-queues it (requeueAfterException).
    if (rec.type === 'employee' && (await require('./AdminSsoService').hasSsoException(rec.id))) {
        await setStatus(row, 'cancelled', { last_error: EXCEPTION_HOLD });
        audit(
            'SSO_MIGRATION_NOTICE_SKIPPED',
            row,
            'skipped: SSO exception (password sign-in kept)'
        );
        return 'cancelled';
    }
    if (!(await stillMigrated(row, rec))) {
        await setStatus(row, 'cancelled', { last_error: 'link or mapping removed' });
        audit('SSO_MIGRATION_NOTICE_SKIPPED', row, 'skipped: SSO link or mapping removed');
        return 'cancelled';
    }
    // In-app: once, on the first claim of the row.
    if (Number(row.attempts) <= 1) {
        try {
            await require('./NotificationService').enqueue({
                userType: rec.type === 'admin' ? 'admin' : 'employee',
                userId: rec.id,
                kind: 'sso.migration_invite',
                channel: 'inapp',
                // The notice opens the SAME explanation as the e-mail, signed
                // in (the only one for a person with no address or with e-mail off).
                payload: { link: SSO_CHANGE_PATH, provider: row.provider, variant: row.variant },
            });
        } catch (_) {
            /* the e-mail still goes; the console shows the status */
        }
    }
    const EmailService = require('./EmailService');
    let emailOn = false;
    try {
        emailOn = await EmailService.isEnabled();
    } catch (_) {
        emailOn = false;
    }
    if (!emailOn) {
        await setStatus(row, 'inapp_only', { sent_at: 'now()' });
        audit('SSO_MIGRATION_NOTICE_SENT', row, 'in-app only (e-mail is off)');
        return 'inapp_only';
    }
    if (!rec.email) {
        await setStatus(row, 'skipped_no_email', { sent_at: 'now()' });
        audit(
            'SSO_MIGRATION_NOTICE_SKIPPED',
            row,
            'no e-mail address in the app: in-app + printed notice'
        );
        return 'skipped_no_email';
    }
    const mail = await messageFor(row, rec);
    // Still ours? (a stuck-row sweep may have marked it 'failed' meanwhile —
    // then nothing is sent, so a later re-queue can never double-send.)
    const still = await db.get(
        `UPDATE sso_migration_invites SET claimed_at = now()
          WHERE id = ? AND status = 'sending' RETURNING id`,
        [Number(row.id)]
    );
    if (!still) return 'lost_claim';
    let r;
    try {
        r = await EmailService.send({ to: rec.email, ...mail });
    } catch (e) {
        r = { sent: false, error: (e && e.message) || String(e) };
    }
    if (r && r.sent) {
        await setStatus(row, 'sent', { sent_at: 'now()', last_error: null });
        audit('SSO_MIGRATION_NOTICE_SENT', row, `e-mailed to the address stored in the app`);
        return 'sent';
    }
    if (r && r.skipped && !r.error) {
        await setStatus(row, 'inapp_only', { sent_at: 'now()', last_error: String(r.skipped) });
        audit('SSO_MIGRATION_NOTICE_SENT', row, `in-app only (${r.skipped})`);
        return 'inapp_only';
    }
    const attempt = Number(row.attempts) || 1;
    const err = String((r && r.error) || 'send failed').slice(0, 300);
    if (attempt > BACKOFF_MIN.length) {
        await setStatus(row, 'failed', { last_error: err });
        audit('SSO_MIGRATION_NOTICE_SKIPPED', row, `failed after ${attempt} attempts: ${err}`);
        return 'failed';
    }
    await db.run(
        `UPDATE sso_migration_invites
            SET status = 'pending', last_error = ?, next_attempt_at = now() + (? * interval '1 minute')
          WHERE id = ? AND status = 'sending'`,
        [err, BACKOFF_MIN[attempt - 1], Number(row.id)]
    );
    return 'retry';
}

/** One reminder, 7 days after 'sent', when no SSO sign-in happened since. */
async function remind(limit) {
    const rows = await db.all(
        `UPDATE sso_migration_invites i
            SET status = 'reminded', reminded_at = now()
          WHERE i.id IN (
                SELECT x.id FROM sso_migration_invites x
                 WHERE x.status = 'sent' AND x.reminded_at IS NULL
                   AND x.sent_at <= now() - (? * interval '1 day')
                   AND NOT EXISTS (
                       SELECT 1 FROM user_identities ui
                        WHERE ui.sso_provider = x.provider
                          AND ui.last_used_at > x.sent_at
                          AND ((ui.subject_type = x.subject_type AND ui.subject_id = x.subject_id)
                            OR (x.subject_type = 'admin' AND ui.subject_type = 'employee'
                                AND ui.subject_id = (SELECT a.linked_employee_id FROM admins a WHERE a.id = x.subject_id))))
                 ORDER BY x.id
                 LIMIT ?
                 FOR UPDATE SKIP LOCKED)
      RETURNING i.*`,
        [REMINDER_DAYS, limit]
    );
    const EmailService = require('./EmailService');
    let n = 0;
    for (const row of rows || []) {
        // eslint-disable-next-line no-await-in-loop
        const rec = await recipientOf(row);
        // Re-checked like a first send: active, never a SuperAdmin, still linked
        // or mapped for this provider.
        if (!rec || rec.superadmin || !rec.active || !rec.email) continue;
        // eslint-disable-next-line no-await-in-loop
        if (!(await stillMigrated(row, rec))) continue;
        if (
            rec.type === 'employee' &&
            // eslint-disable-next-line no-await-in-loop
            (await require('./AdminSsoService').hasSsoException(rec.id))
        )
            continue;
        try {
            // eslint-disable-next-line no-await-in-loop
            const mail = await messageFor(row, rec, { reminder: true });
            // eslint-disable-next-line no-await-in-loop
            const r = await EmailService.send({ to: rec.email, ...mail });
            if (r && r.sent) n++;
        } catch (_) {
            /* one try only — the console shows who never signed in */
        }
        audit(
            'SSO_MIGRATION_NOTICE_REMINDED',
            row,
            'one reminder sent (no SSO sign-in 7 days after the invitation)'
        );
    }
    return n;
}

/**
 * The dispatcher tick (jobs/sso-invites). Safe to run concurrently: rows are
 * claimed with FOR UPDATE SKIP LOCKED in one statement.
 * @returns {Promise<object>} a summary for the job ledger
 */
async function dispatch({ pauseMs = Number(process.env.SSO_INVITE_PAUSE_MS || 200) } = {}) {
    try {
        await db.run(
            `UPDATE sso_migration_invites
                SET status = 'failed', last_error = 'stuck in sending for ${STUCK_SENDING_MIN} minutes (never resent automatically)'
              WHERE status = 'sending' AND claimed_at < now() - interval '${STUCK_SENDING_MIN} minutes'`
        );
    } catch (e) {
        if (isMissingTable(e)) return { skipped: 'no_table' };
        throw e;
    }
    if (!isSsoLive()) {
        const parked = await db.all(
            `UPDATE sso_migration_invites SET status = 'waiting_sso'
              WHERE status = 'pending' RETURNING id, subject_type, subject_id, provider, trigger`
        );
        for (const row of parked || [])
            audit('SSO_MIGRATION_NOTICE_QUEUED', row, 'queued: waiting until SSO is live');
        // ANN (3.23.21): before go-live, the one-time announcement.
        let announced = null;
        try {
            announced = await announce();
        } catch (e) {
            announced = { error: String((e && e.message) || e).slice(0, 200) };
        }
        return { live: false, waiting: (parked || []).length, announced };
    }
    const batch = Math.min(
        Math.max(Number(await setting('ssoInvite.batchSize', 50)) || 50, 1),
        500
    );
    const rows = await db.all(
        `UPDATE sso_migration_invites i
            SET status = 'sending', claimed_at = now(), attempts = i.attempts + 1
          WHERE i.id IN (
                SELECT x.id FROM sso_migration_invites x
                 WHERE x.status IN ('pending', 'waiting_sso')
                   AND (x.next_attempt_at IS NULL OR x.next_attempt_at <= now())
                   AND (x.trigger <> 'mapping' OR x.created_at <= now() - interval '${MAPPING_WAIT_MIN} minutes')
                 ORDER BY x.id
                 LIMIT ?
                 FOR UPDATE SKIP LOCKED)
      RETURNING i.*`,
        [batch]
    );
    const out = { live: true, claimed: (rows || []).length };
    for (const row of rows || []) {
        let r;
        try {
            // eslint-disable-next-line no-await-in-loop
            r = await deliver(row);
        } catch (e) {
            r = 'error';
            // eslint-disable-next-line no-await-in-loop
            await db
                .run(
                    `UPDATE sso_migration_invites SET status = 'pending', last_error = ?,
                            next_attempt_at = now() + interval '15 minutes'
                      WHERE id = ? AND status = 'sending'`,
                    [String((e && e.message) || e).slice(0, 300), Number(row.id)]
                )
                .catch(() => {});
        }
        out[r] = (out[r] || 0) + 1;
        // eslint-disable-next-line no-await-in-loop
        if (pauseMs > 0) await sleep(pauseMs);
    }
    out.reminded = await remind(batch);
    return out;
}

// ---------------------------------------------------------------------------
// ANN (3.23.21, PO decision) — the go-live ANNOUNCEMENT. The SuperAdmin records
// the planned go-live on the SSO page (sso.goLiveAt, local time); 48 h before it
// (sso.announceLeadHours, 24-168) — or at once when the date is set closer than
// that — every migrated account (the invitation audience: rows waiting for SSO)
// receives ONE short notice, SSO exceptions and SuperAdmins excluded. Same
// channel rules as the invitation (in-app always; e-mail when on, to the address
// stored in the app; the only link is <base URL>/login). The ledger
// sso_migration_announcements (migration 156) is claimed BEFORE sending — one
// row per account, never twice. The invitation itself still goes at go-live.
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' (server local time) → Date, else null. */
function parseGoLive(raw) {
    const s = String(raw == null ? '' : raw).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(s);
    if (!m) return null;
    const d = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        m[4] == null ? 0 : Number(m[4]),
        m[5] == null ? 0 : Number(m[5])
    );
    // Reject a date the calendar normalised (2026-02-31 → March).
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1) return null;
    return Number.isNaN(d.getTime()) ? null : d;
}

/** The lead time in hours, clamped to 24-168 (default 48). */
function clampLeadHours(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) return ANNOUNCE_LEAD_DEFAULT_H;
    return Math.min(Math.max(n, ANNOUNCE_LEAD_MIN_H), ANNOUNCE_LEAD_MAX_H);
}

/** {goLiveAt, leadHours, dueAt, raw} from the settings. */
async function announcementPlan() {
    const raw = String((await setting('sso.goLiveAt', '')) || '').trim();
    const goLiveAt = parseGoLive(raw);
    const leadHours = clampLeadHours(
        await setting('sso.announceLeadHours', ANNOUNCE_LEAD_DEFAULT_H)
    );
    return {
        raw,
        goLiveAt,
        leadHours,
        dueAt: goLiveAt ? new Date(goLiveAt.getTime() - leadHours * 3600 * 1000) : null,
    };
}

/** Long date (+ time when not midnight) in the reader's language. */
function formatGoLive(d, lang) {
    const loc = lang === 'en' ? 'en-GB' : 'fr-FR';
    let day = d.toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
    // French writes the first day of the month « 1er octobre ».
    if (lang !== 'en' && d.getDate() === 1) day = day.replace(/^1(?=\s)/, '1er');
    if (d.getHours() === 0 && d.getMinutes() === 0) return day;
    const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return tr(lang, 'ssoann_date_time', { date: day, time: hh });
}

/**
 * The announcement text (FR first, EN below) — pure given its inputs.
 * @returns {{subject:string, html:string, text:string}}
 */
function composeAnnouncement({
    rec,
    provider,
    providerKey = null,
    goLiveAt,
    contact,
    app,
    url,
    branding = null,
}) {
    const T = require('../utils/emailTemplate');
    const v = (lang) => ({
        app,
        provider,
        account: accountPhrase(lang, provider),
        url,
        date: formatGoLive(goLiveAt, lang),
        first: rec.firstName || rec.name || '',
        contact: contact || tr(lang, 'ssoinv_contact_default'),
    });
    const bodyKey = isMicrosoftProvider(providerKey, provider) ? 'ssoann_body_ms' : 'ssoann_body';
    const spec = [
        { t: 'p', k: bodyKey },
        { t: 'p', k: 'ssoann_nothing_yet' },
        { t: 'p', k: 'ssoinv_never_password' },
        url ? { t: 'cta', k: 'ssoann_cta', href: `${url}/login` } : null,
        { t: 'p', k: 'ssoinv_help' },
    ].filter(Boolean);
    const both = (key) => [tr('fr', key, v('fr')), tr('en', key, v('en'))];
    const blocks = spec.map((b) =>
        b.t === 'cta'
            ? T.cta(...both(b.k), b.href, branding && branding.accentColor)
            : T.para(...both(b.k))
    );
    const subject = `${tr('fr', 'ssoann_subject', v('fr'))} / ${tr('en', 'ssoann_subject', v('en'))}`;
    const html = T.wrap({
        branding: branding || { appName: app },
        title: `${tr('fr', 'ssoann_title')} / ${tr('en', 'ssoann_title')}`,
        intro: tr('fr', 'ssoinv_hello', v('fr')),
        blocks,
    });
    const lines = (lang) =>
        [
            tr(lang, 'ssoinv_hello', v(lang)),
            tr(lang, bodyKey, v(lang)),
            tr(lang, 'ssoann_nothing_yet', v(lang)),
            url ? `${url}/login` : null,
            tr(lang, 'ssoinv_never_password'),
            tr(lang, 'ssoinv_help', v(lang)),
        ]
            .filter(Boolean)
            .join('\n');
    const page = (lang) => ({
        heading: tr(lang, 'ssoann_title'),
        hello: tr(lang, 'ssoinv_hello', v(lang)),
        blocks: pageOf(spec, v, lang),
    });
    return {
        subject,
        html,
        text: `${lines('fr')}\n\n----\n\n${lines('en')}`,
        page: { fr: page('fr'), en: page('en') },
    };
}

/**
 * The complement of the in-app title « Connexion avec votre compte
 * d'entreprise : ce qui change »: the announcement carries its DATE (« à partir
 * du 12 octobre 2026 »), the invitation its provider NAME (none for the bare
 * 'SSO' fallback). Sync (NotificationService.KIND_SUBTITLE).
 */
function inAppSubtitle(payload, lang) {
    const p = payload || {};
    if (p.variant === 'announce') {
        const d = p.goLiveAt ? new Date(p.goLiveAt) : null;
        if (!d || Number.isNaN(d.getTime())) return null;
        return tr(lang, 'ssochg_sub_from', { date: formatGoLive(d, lang) });
    }
    if (!p.provider) return null;
    const label = providerLabel(p.provider);
    return isBareLabel(label) ? null : label;
}

/**
 * GET /account/sso-change — what the signed-in person's e-mail says, for THIS
 * person: the invitation once SSO is live; the announcement while it is not and
 * a go-live date is planned; otherwise a short neutral page.
 * @returns {Promise<{mode:'invite'|'announce'|'later'|'none', page?:object}>}
 */
async function changeFor(user, { now = new Date() } = {}) {
    const subjectType = user && user.userType === 'admin' ? 'admin' : 'employee';
    const id = Number(user && user.id);
    if (!id) return { mode: 'none' };
    let row = null;
    try {
        row = await db.get(
            `SELECT id, subject_type, subject_id, provider, variant, status
               FROM sso_migration_invites
              WHERE subject_type = ? AND subject_id = ?
                AND status NOT IN ('cancelled', 'skipped_superadmin')
              ORDER BY id DESC LIMIT 1`,
            [subjectType, id]
        );
    } catch (e) {
        if (!isMissingTable(e)) throw e;
    }
    const live = isSsoLive();
    if (!row && live) {
        // Migrated before the outbox existed: an identity or an open mapping.
        const p = await currentProvider(subjectType, id);
        if (p) row = { subjectType, subjectId: id, provider: p, variant: 'standard' };
    }
    if (!row) return { mode: 'none' };
    row = { ...row, subjectType, subjectId: id };
    const rec = await recipientOf(row);
    if (!rec || rec.superadmin || !rec.active) return { mode: 'none' };
    if (rec.type === 'employee' && (await require('./AdminSsoService').hasSsoException(rec.id)))
        return { mode: 'none' };
    if (!(await stillMigrated(row, rec))) return { mode: 'none' };
    if (live) {
        const m = await messageFor(row, rec);
        return { mode: 'invite', page: m.page };
    }
    const plan = await announcementPlan();
    if (!plan.goLiveAt || now >= plan.goLiveAt) return { mode: 'later' };
    let branding = null;
    try {
        branding = await require('../utils/branding').getBranding();
    } catch (_) {
        branding = null;
    }
    const m = composeAnnouncement({
        rec,
        provider: providerLabel(row.provider),
        providerKey: row.provider,
        goLiveAt: plan.goLiveAt,
        contact: await helpContact(),
        app: (branding && branding.appName) || (await appName()),
        url: String((await require('../utils/emailTemplate').baseUrlAsync()) || '').replace(
            /\/+$/,
            ''
        ),
        branding,
    });
    return { mode: 'announce', page: m.page };
}

function auditAnn(action, subjectType, subjectId, details) {
    try {
        require('./LogService')
            .log({
                adminId: null,
                action,
                entityType: subjectType,
                entityId: Number(subjectId),
                category: 'security',
                details,
            })
            .catch(() => {});
    } catch (_) {
        /* audit best-effort */
    }
}

async function setAnnStatus(id, status, err = null) {
    await db.run(
        `UPDATE sso_migration_announcements SET status = ?, last_error = ?,
                sent_at = CASE WHEN ? IN ('sent', 'inapp_only', 'skipped_no_email') THEN now() ELSE sent_at END
          WHERE id = ? AND status = 'sending'`,
        [status, err, status, Number(id)]
    );
}

/**
 * One announcement pass. Runs only while SSO is NOT live, between
 * (go-live − lead time) and go-live. Exactly once per account (ledger claim).
 * @returns {Promise<object>} a summary
 */
async function announce({ limit = null, now = new Date() } = {}) {
    if (isSsoLive()) return { skipped: 'live' };
    const plan = await announcementPlan();
    if (!plan.goLiveAt) return { skipped: 'no_date' };
    if (now < plan.dueAt) return { skipped: 'not_due', dueAt: plan.dueAt.toISOString() };
    if (now >= plan.goLiveAt) return { skipped: 'past' };
    const batch =
        limit || Math.min(Math.max(Number(await setting('ssoInvite.batchSize', 50)) || 50, 1), 500);
    let rows;
    try {
        rows = await db.all(
            `SELECT i.subject_type, i.subject_id, MIN(i.provider) AS provider
               FROM sso_migration_invites i
              WHERE i.status IN ('waiting_sso', 'pending')
                AND (i.trigger <> 'mapping' OR i.created_at <= now() - interval '${MAPPING_WAIT_MIN} minutes')
                AND NOT EXISTS (SELECT 1 FROM sso_migration_announcements a
                                 WHERE a.subject_type = i.subject_type AND a.subject_id = i.subject_id)
                AND NOT (i.subject_type = 'admin' AND EXISTS (
                        SELECT 1 FROM admins x WHERE x.id = i.subject_id
                           AND (x.role = 'superadmin' OR x.is_active = false)))
                AND NOT (i.subject_type = 'employee' AND EXISTS (
                        SELECT 1 FROM employees x WHERE x.id = i.subject_id
                           AND ((x.sso_exception_at IS NOT NULL AND x.sso_exception_by IS NOT NULL)
                                OR x.is_active = false OR x.is_account_active = false)))
              GROUP BY i.subject_type, i.subject_id
              ORDER BY MIN(i.id)
              LIMIT ?`,
            [batch]
        );
    } catch (e) {
        if (
            isMissingTable(e) ||
            /sso_migration_announcements|sso_exception/.test(String(e.message))
        )
            return { skipped: 'no_table' };
        throw e;
    }
    const out = {
        due: true,
        candidates: (rows || []).length,
        sent: 0,
        inapp_only: 0,
        skipped_no_email: 0,
        failed: 0,
    };
    if (!rows || !rows.length) return out;
    let emailOn = false;
    const EmailService = require('./EmailService');
    try {
        emailOn = await EmailService.isEnabled();
    } catch (_) {
        emailOn = false;
    }
    let branding = null;
    try {
        branding = await require('../utils/branding').getBranding();
    } catch (_) {
        branding = null;
    }
    const app = (branding && branding.appName) || (await appName());
    const url = String((await require('../utils/emailTemplate').baseUrlAsync()) || '').replace(
        /\/+$/,
        ''
    );
    const contact = await helpContact();
    for (const r of rows) {
        const type = r.subjectType ?? r.subject_type;
        const id = Number(r.subjectId ?? r.subject_id);
        const row = { subjectType: type, subjectId: id, provider: r.provider };
        /* eslint-disable no-await-in-loop */
        const rec = await recipientOf(row);
        if (!rec || rec.superadmin || !rec.active) continue;
        if (type === 'employee' && (await require('./AdminSsoService').hasSsoException(id)))
            continue;
        if (!(await stillMigrated(row, rec))) continue;
        // CLAIM first: a concurrent tick (or a rerun) finds the row and stops.
        const claim = await db.get(
            `INSERT INTO sso_migration_announcements (subject_type, subject_id, provider, go_live_at, status)
             VALUES (?, ?, ?, ?, 'sending')
             ON CONFLICT (subject_type, subject_id) DO NOTHING
             RETURNING id`,
            [type, id, r.provider, plan.goLiveAt.toISOString()]
        );
        if (!claim) continue;
        try {
            await require('./NotificationService').enqueue({
                userType: type === 'admin' ? 'admin' : 'employee',
                userId: id,
                kind: 'sso.migration_invite',
                channel: 'inapp',
                payload: {
                    link: SSO_CHANGE_PATH,
                    provider: r.provider,
                    variant: 'announce',
                    goLiveAt: plan.goLiveAt.toISOString(),
                },
            });
        } catch (_) {
            /* the e-mail still goes */
        }
        let status;
        let err = null;
        if (!emailOn) status = 'inapp_only';
        else if (!rec.email) status = 'skipped_no_email';
        else {
            const mail = composeAnnouncement({
                rec,
                provider: providerLabel(r.provider),
                providerKey: r.provider,
                goLiveAt: plan.goLiveAt,
                contact,
                app,
                url,
                branding,
            });
            let s;
            try {
                s = await EmailService.send({ to: rec.email, ...mail });
            } catch (e) {
                s = { sent: false, error: (e && e.message) || String(e) };
            }
            if (s && s.sent) status = 'sent';
            else if (s && s.skipped && !s.error) status = 'inapp_only';
            else {
                status = 'failed'; // one try only: the invitation still goes at go-live
                err = String((s && s.error) || 'send failed').slice(0, 300);
            }
        }
        await setAnnStatus(claim.id, status, err);
        out[status] = (out[status] || 0) + 1;
        auditAnn(
            status === 'failed' ? 'SSO_MIGRATION_ANNOUNCE_SKIPPED' : 'SSO_MIGRATION_ANNOUNCE_SENT',
            type,
            id,
            `SSO go-live announcement (${plan.raw}, provider ${r.provider}): ${status}${err ? ` — ${err}` : ''}`
        );
        /* eslint-enable no-await-in-loop */
    }
    return out;
}

/** Counters for the SSO settings page: {announced, due, planned}. */
async function announcementStatus() {
    const plan = await announcementPlan();
    let announced = null;
    try {
        const r = await db.get('SELECT COUNT(*)::int AS n FROM sso_migration_announcements');
        announced = Number((r && r.n) || 0);
    } catch (_) {
        announced = null; // ledger absent before migration 156 — not a zero
    }
    return {
        goLiveAt: plan.goLiveAt ? plan.goLiveAt.toISOString() : null,
        raw: plan.raw,
        leadHours: plan.leadHours,
        dueAt: plan.dueAt ? plan.dueAt.toISOString() : null,
        announced,
    };
}

/**
 * EXC — the exception was removed: the SSO invitation it had held back goes
 * again (same row, back to 'pending'; the dispatcher waits for SSO to be live).
 */
async function requeueAfterException(employeeId) {
    try {
        const rows = await db.all(
            `UPDATE sso_migration_invites
                SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, claimed_at = NULL
              WHERE subject_type = 'employee' AND subject_id = ? AND status = 'cancelled' AND last_error = ?
          RETURNING id, subject_type, subject_id, provider, trigger`,
            [Number(employeeId), EXCEPTION_HOLD]
        );
        for (const row of rows || [])
            audit('SSO_MIGRATION_NOTICE_QUEUED', row, 're-queued: SSO exception removed');
        return (rows || []).length;
    } catch (e) {
        if (isMissingTable(e)) return 0;
        throw e;
    }
}

/**
 * ST-3 (b): run `fn` in a transaction where the migration-156 outbox triggers
 * queue NO invitation — for an employee merge or an identity MOVE, which is not
 * a migration (the person was already migrated, or is being re-keyed).
 */
async function withoutInvites(fn) {
    return db.runTransaction(async () => {
        await db.get("SELECT set_config('app.skip_sso_invite', 'on', true) AS x");
        try {
            return await fn();
        } finally {
            // A nested call shares the outer transaction (no savepoint): the flag
            // must not outlive `fn` there.
            await db.get("SELECT set_config('app.skip_sso_invite', '', true) AS x").catch(() => {});
        }
    });
}

// ---------------------------------------------------------------------------
// The Accounts console (C3g)
// ---------------------------------------------------------------------------

/** Latest invitation row per subject: Map(id → row). */
async function statusFor(subjectType, ids) {
    const list = [...new Set((ids || []).map(Number).filter(Boolean))];
    const out = new Map();
    if (!list.length) return out;
    try {
        const rows = await db.all(
            `SELECT DISTINCT ON (subject_id) id, subject_id, provider, status, variant, created_at, sent_at,
                    reminded_at, handed_over_at, last_error
               FROM sso_migration_invites
              WHERE subject_type = ? AND subject_id = ANY(?)
              ORDER BY subject_id, id DESC`,
            [subjectType, list]
        );
        for (const r of rows || []) out.set(Number(r.subjectId ?? r.subject_id), r);
    } catch (e) {
        if (!isMissingTable(e)) throw e;
    }
    return out;
}

/**
 * « Relancer l'invitation SSO » — re-queue (never a password). Refused while a
 * row is pending/sending, and within an hour of the last send.
 * @returns {Promise<{ok:boolean, code?:string}>}
 */
async function requeue(subjectType, subjectId, actor) {
    const latest = () =>
        db.get(
            `SELECT id, status, sent_at, subject_type, subject_id, provider, trigger
               FROM sso_migration_invites WHERE subject_type = ? AND subject_id = ?
              ORDER BY id DESC LIMIT 1`,
            [subjectType, Number(subjectId)]
        );
    let row = await latest();
    if (!row) {
        // Migrated before the outbox existed (an identity or a mapping, no row):
        // queue one now for that provider.
        const p = await currentProvider(subjectType, subjectId);
        if (!p) return { ok: false, code: 'sso_not_migrated' };
        await db.run(
            `INSERT INTO sso_migration_invites (subject_type, subject_id, provider, trigger, variant)
             VALUES (?, ?, ?, 'manual', 'standard')
             ON CONFLICT (subject_type, subject_id, provider) DO NOTHING`,
            [subjectType, Number(subjectId), p]
        );
        row = await latest();
        if (!row) return { ok: false, code: 'sso_not_migrated' };
        audit(
            'SSO_MIGRATION_NOTICE_QUEUED',
            row,
            `queued from the Accounts console by admin #${actor && actor.id}`
        );
        return { ok: true };
    }
    if (['pending', 'sending', 'waiting_sso'].includes(row.status))
        return { ok: false, code: 'sso_invite_already_queued' };
    const recent = await db.get(
        `SELECT 1 AS x FROM sso_migration_invites
          WHERE id = ? AND GREATEST(sent_at, claimed_at, reminded_at, created_at) > now() - (? * interval '1 minute')`,
        [Number(row.id), MANUAL_REQUEUE_COOLDOWN_MIN]
    );
    if (recent) return { ok: false, code: 'sso_invite_too_soon' };
    await db.run(
        `UPDATE sso_migration_invites
            SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL,
                reminded_at = NULL, claimed_at = NULL
          WHERE id = ?`,
        [Number(row.id)]
    );
    audit(
        'SSO_MIGRATION_NOTICE_QUEUED',
        row,
        `re-queued from the Accounts console by admin #${actor && actor.id}`
    );
    return { ok: true };
}

/** The provider this account is migrated on (identity first, then an open/bound mapping), or null. */
async function currentProvider(subjectType, subjectId) {
    const id = Number(subjectId);
    const i = await db.get(
        `SELECT sso_provider FROM user_identities WHERE subject_type = ? AND subject_id = ?
          ORDER BY id DESC LIMIT 1`,
        [subjectType, id]
    );
    if (i && (i.ssoProvider ?? i.sso_provider)) return i.ssoProvider ?? i.sso_provider;
    if (subjectType !== 'employee') return null;
    const m = await db.get(
        `SELECT provider FROM sso_pending_links WHERE employee_id = ? AND status IN ('pending', 'bound')
          ORDER BY id DESC LIMIT 1`,
        [id]
    );
    return m ? m.provider : null;
}

/**
 * Is this account MIGRATED to SSO? — only while SSO is LIVE: an invitation row
 * (not cancelled) or any SSO identity / open mapping. A migrated account is
 * never issued a password (C3g); before SSO is live nothing changes.
 */
async function isMigrated(subjectType, subjectId) {
    // Committee HR decision (security Low 5): while SSO is NOT live the account
    // is only queued ('waiting_sso') — today's password invitation still applies.
    if (!isSsoLive()) return false;
    try {
        const r = await db.get(
            `SELECT 1 AS x FROM sso_migration_invites
              WHERE subject_type = ? AND subject_id = ? AND status NOT IN ('cancelled', 'skipped_superadmin')
              LIMIT 1`,
            [subjectType, Number(subjectId)]
        );
        if (r) return true;
    } catch (e) {
        if (!isMissingTable(e)) throw e;
    }
    return !!(await currentProvider(subjectType, subjectId));
}

/** « Marquer comme remis » — the printed notice was handed over. */
async function markHandedOver(subjectType, ids, actor) {
    const list = [...new Set((ids || []).map(Number).filter(Boolean))];
    if (!list.length) return 0;
    const rows = await db.all(
        `UPDATE sso_migration_invites SET handed_over_at = now(), handed_over_by = ?
          WHERE subject_type = ? AND subject_id = ANY(?) AND handed_over_at IS NULL
      RETURNING id, subject_type, subject_id, provider, trigger`,
        [actor && actor.id ? Number(actor.id) : null, subjectType, list]
    );
    for (const row of rows || [])
        audit(
            'SSO_MIGRATION_NOTICE_HANDED_OVER',
            row,
            `printed notice handed over (admin #${actor && actor.id})`
        );
    return (rows || []).length;
}

/** The printable notices (no secret on them) for these subjects. */
async function notices(subjectType, ids) {
    const map = await statusFor(subjectType, ids);
    const out = [];
    for (const [, row] of map) {
        // eslint-disable-next-line no-await-in-loop
        const rec = await recipientOf({ ...row, subjectType });
        if (!rec || rec.superadmin) continue;
        // eslint-disable-next-line no-await-in-loop
        const m = await messageFor({ ...row, subjectType }, rec);
        out.push({
            subjectId: rec.id,
            name: rec.name,
            employeeNumber: rec.employeeNumber || null,
            text: m.text,
            subject: m.subject,
        });
    }
    return out;
}

module.exports = {
    dispatch,
    deliver,
    remind,
    compose,
    messageFor,
    recipientOf,
    isSsoLive,
    helpContact,
    providerLabel,
    statusFor,
    requeue,
    isMigrated,
    currentProvider,
    markHandedOver,
    notices,
    tr,
    buttonText,
    // ANN (3.23.21)
    announce,
    announcementPlan,
    announcementStatus,
    composeAnnouncement,
    formatGoLive,
    parseGoLive,
    // The in-app notice and its signed-in page
    inAppSubtitle,
    changeFor,
    isMicrosoftProvider,
    SSO_CHANGE_PATH,
    clampLeadHours,
    ANNOUNCE_LEAD_DEFAULT_H,
    ANNOUNCE_LEAD_MIN_H,
    ANNOUNCE_LEAD_MAX_H,
    // EXC / ST-3 (3.23.21)
    requeueAfterException,
    withoutInvites,
    EXCEPTION_HOLD,
    MAPPING_WAIT_MIN,
    BACKOFF_MIN,
};
