'use strict';

const db = require('../config/database');
const catalogue = require('./notificationCatalogue');

/**
 *   NotificationService — write to notifications, respect per-user
 *   preferences and quiet hours. The in-app channel is always on; e-mail goes
 *   through EmailService, rendered by ONE composer (renderEmail / _compose)
 *   in ONE language, and is delivered through a small outbox: a failed send
 *   is retried for 24 hours, and a person who has left, was voided or was
 *   erased is never written to. Every kind is declared in
 *   ./notificationCatalogue.
 */
class NotificationService {
    static async enqueue({ userType, userId, kind, channel, locale, payload }) {
        NotificationService._checkDeclared(kind);
        // One query for BOTH the kind-specific pref and the user's global ('__all__')
        // pref: kind-specific enable/quiet-hours win, else fall back to the global
        // quiet hours set in the preferences UI. (default = enabled, no quiet hours).
        const prefs = await NotificationService._prefRows(userType, userId, kind, channel);
        const specific = prefs.find((p) => p.kind === kind && p.channel === channel);
        if (specific && specific.enabled === false) return { skipped: 'disabled' };

        // Quiet hours DEFER — they are not decoration. `release_at` records the
        // exact instant the window ends; until then the row is invisible in the
        // inbox (see listInApp/unreadCount) and the release tick flips it back to
        // 'queued'. Storing the absolute moment (rather than re-deriving it from
        // preferences later) is what makes deferral self-healing: the row still
        // surfaces on its own even if the scheduler never runs.
        const releaseAt = NotificationService._releaseAt(
            NotificationService._quietSource(prefs, kind, channel)
        );
        const state = releaseAt ? 'snoozed' : 'queued';
        await db.run(
            `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, release_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userType,
                userId,
                channel,
                kind,
                locale || 'fr',
                // A call without a payload must not write NULL into a NOT NULL
                // column: the in-app row would be lost and, inside a
                // transaction, the aborted savepoint would take the e-mail too.
                typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
                state,
                releaseAt,
            ]
        );
        return { state, releaseAt: releaseAt || null };
    }

    /**
     * Every kind written to `notifications` is declared in the catalogue. An
     * undeclared kind is still written (a notification is never lost for a
     * missing label), but it is reported once per process; under the test
     * runner it is also collected, and tests/helpers/dbSuiteLockSetup.js fails
     * the suite that emitted it.
     */
    static _checkDeclared(kind) {
        if (catalogue.isDeclared(kind)) return true;
        const k = String(kind || '').slice(0, 100);
        if (!NotificationService._undeclared) NotificationService._undeclared = new Set();
        if (!NotificationService._undeclared.has(k)) {
            NotificationService._undeclared.add(k);
            console.warn(`[notify] kind "${k}" is not declared in notificationCatalogue`);
        }
        if (process.env.NODE_ENV === 'test') {
            if (!global.__undeclaredNotificationKinds)
                global.__undeclaredNotificationKinds = new Set();
            global.__undeclaredNotificationKinds.add(k);
        }
        return false;
    }

    /**
     * The preference rows relevant to one (kind, channel) delivery: the
     * kind-specific row for that channel, plus the wildcard rows.
     *
     * The quiet-hours window the preferences UI writes lives on ONE row —
     * ('__all__', 'inapp') — so an email-channel lookup must read the 'inapp'
     * channel too, otherwise quiet hours can never apply to email. (That was
     * the original defect: the email path never consulted them at all.)
     */
    static _prefRows(userType, userId, kind, channel) {
        return db.all(
            `SELECT kind, channel, enabled, quiet_hours_start, quiet_hours_end
               FROM notification_preferences
              WHERE user_type = ? AND user_id = ?
                AND channel IN (?, 'inapp') AND kind IN (?, '__all__')`,
            [userType, userId, channel, kind]
        );
    }

    /** Which preference row supplies the quiet-hours window: kind-specific wins. */
    static _quietSource(prefs, kind, channel) {
        const rows = prefs || [];
        const specific = rows.find((p) => p.kind === kind && p.channel === channel);
        if (NotificationService._window(specific)) return specific;
        return rows.find((p) => p.kind === '__all__' && p.channel === 'inapp') || null;
    }

    /** The user's global quiet-hours row, for channels that have no row of their own. */
    static async _quietPref(userType, userId) {
        try {
            return await db.get(
                "SELECT quiet_hours_start, quiet_hours_end FROM notification_preferences WHERE user_type = ? AND user_id = ? AND kind = '__all__' AND channel = 'inapp'",
                [userType, userId]
            );
        } catch {
            return null;
        }
    }

    /**
     * High-level entry point for system events. Records an in-app notification
     * and, when e-mail applies to the kind, sends ONE mail to the recipient.
     * Best-effort: never throws into the calling business logic.
     *
     *   NotificationService.notify({
     *       userType, userId, kind, category, locale, payload,
     *       // the mail body — same fields as renderEmail(), all optional:
     *       title, intro, blocks, ctaLabel, ctaUrl, preheader, severity,
     *       ignoreQuietHours,
     *   })
     *
     * @param {'admin'|'employee'} o.userType  recipient type
     * @param {number} o.userId                recipient id (admins.id / employees.id)
     * @param {string} o.kind                  a kind declared in notificationCatalogue
     * @param {string} [o.category]            e-mail domain toggle: workflow|validation|talent|lifecycle|coaching|...
     * @param {string} [o.locale]              the RECIPIENT's language; else the site's mail language
     * @param {object} [o.payload]             contextual data (in-app row; never printed in a subject)
     *
     * The subject is always « {app} — {the kind's catalogue subject} »: a caller
     * cannot put a name, a figure or a date in it. A legacy `subject` / `html` /
     * `text` argument is ignored: every mail is built from blocks, in one
     * language.
     */
    /**
     * Every caller treats this as best-effort — around twenty invoke it as
     * `notify(...).catch( => {})` — and many do so INSIDE a transaction (an
     * approval, a JML event, a plan creation). PostgreSQL aborts the whole
     * transaction on any statement error, so a failure in here would have turned
     * the caller's COMMIT into a silent ROLLBACK: the business decision they were
     * committing would be discarded while they reported success.
     *
     * The body therefore runs inside a SAVEPOINT, which is a pass-through when
     * there is no open transaction. A notification failure now costs the
     * notification and nothing else.
     */
    static async notify(args) {
        try {
            return await db.runInSavepoint(() => NotificationService._notify(args));
        } catch (e) {
            // Never silent: one line, the kind and the recipient's id only (the
            // error text is address-masked).
            const a = args || {};
            console.warn(
                `[notify] ${a.kind || '?'} → ${a.userType || '?'}:${a.userId ?? '?'} failed: ${NotificationService._safeError(e && e.message) || 'error'}`.slice(
                    0,
                    300
                )
            );
            return { inapp: 'error', email: 'error', error: e && e.message };
        }
    }

    static async _notify(args) {
        const {
            userType,
            userId,
            kind,
            category,
            locale,
            payload,
            title,
            intro,
            blocks,
            ctaLabel,
            ctaUrl,
            preheader,
            severity,
            ignoreQuietHours,
        } = args || {};
        const result = { inapp: null, email: null };

        // 0) Fan the event out to any external webhook subscribers (best-effort,
        //    non-blocking). Only allow-listed kinds leave (WebhookService.isEmittable,
        //    which reads the SuperAdmin opt-in for the 360°, one-to-one and HRIS
        //    families), and their payload is reduced to ids, dates and an in-app
        //    link: no figure, no name, no free text ever reaches a subscriber or a
        //    chat channel. It is NOT awaited, so it runs outside the caller's
        //    transaction: two queries in flight on one pg client is node-pg's
        //    « client is already executing a query », and a failure there would
        //    abort the caller's transaction.
        try {
            const Hook = require('./WebhookService');
            NotificationService._outsideTx(() =>
                Promise.resolve(
                    Hook.emit(kind, {
                        userType,
                        userId,
                        category,
                        payload:
                            typeof Hook.minimisePayload === 'function'
                                ? Hook.minimisePayload(payload)
                                : {},
                    })
                ).catch(() => {})
            );
        } catch (_) {
            /* never block */
        }

        // 1) Always record the in-app notification (drives the digest UI).
        try {
            const r = await NotificationService._bestEffort(() =>
                NotificationService.enqueue({
                    userType,
                    userId,
                    kind,
                    channel: 'inapp',
                    locale,
                    payload,
                })
            );
            result.inapp = r && (r.state || r.skipped) ? r.state || r.skipped : 'queued';
        } catch (e) {
            result.inapp = 'error';
        }

        // 2) E-mail — the catalogue tier first. 'none' never e-mails; 'digest'
        //    defers to the daily digest; 'immediate' (or a kind absent from
        //    KIND_POLICY) sends now. A MANDATORY kind (safety, security) is sent
        //    now whatever its tier, the recipient's own switch and the per-domain
        //    toggle; the global e-mail switch and SMTP still apply.
        try {
            const tier = NotificationService._tier(kind);
            const mandatory = NotificationService._isMandatory(kind);
            result.mandatory = mandatory;
            if (tier === 'none') {
                result.email = 'policy_none';
                return result;
            }
            if (tier === 'digest' && !mandatory) {
                result.email = 'digest_deferred';
                return result;
            }
            if (!mandatory && !(await NotificationService._userEmailAllowed(userType, userId))) {
                result.email = 'user_opt_out';
                return result;
            }
            const EmailService = require('./EmailService');
            const open = mandatory
                ? await EmailService.isEnabled()
                : await EmailService.isCategoryEnabled(category);
            if (!open) {
                result.email = 'disabled';
                return result;
            }
            const recipient = await NotificationService._resolveRecipient(userType, userId);
            if (recipient.emailStatus === 'suppressed') {
                await NotificationService._recordEmail({
                    userType,
                    userId,
                    kind,
                    locale,
                    payload,
                    state: 'failed',
                    emailStatus: 'suppressed',
                    attempts: 0,
                    lastError: 'recipient inactive, cancelled or erased',
                });
                result.email = 'suppressed';
                return result;
            }
            if (!recipient.email) {
                result.email = 'no_address';
                return result;
            }
            const lang = await NotificationService._mailLang(locale);
            const brand = await NotificationService._brand();
            const rendered = NotificationService._compose(
                {
                    kind,
                    severity,
                    title,
                    intro,
                    blocks,
                    ctaLabel,
                    ctaUrl,
                    preheader,
                    locale: lang,
                    mandatory,
                    payload,
                },
                { brand, recipientName: recipient.name }
            );
            // Quiet hours apply to EMAIL too. An immediate-tier mail raised at
            // 03:00 is written as a deferred email row (rendered NOW and parked
            // on the row: re-deriving it hours later from the kind alone would
            // lose the caller's blocks) and sent by the release tick once the
            // window ends. This is the delivery-audit row, not the in-app inbox
            // row — the inbox payload written in step 1 is untouched.
            const releaseAt = ignoreQuietHours
                ? null
                : NotificationService._releaseAt(
                      await NotificationService._quietPref(userType, userId)
                  );
            if (releaseAt) {
                try {
                    await db.run(
                        `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, release_at)
                         VALUES (?, ?, 'email', ?, ?, ?, 'snoozed', ?)`,
                        [
                            userType,
                            userId,
                            kind,
                            lang,
                            JSON.stringify({
                                ...(payload && typeof payload === 'object' ? payload : {}),
                                [NotificationService.PENDING_EMAIL_KEY]:
                                    NotificationService._storable(rendered),
                            }),
                            releaseAt,
                        ]
                    );
                    await NotificationService._markEmailed(userType, userId, kind);
                    result.email = 'quiet_deferred';
                } catch {
                    result.email = 'error';
                }
                return result;
            }
            const sendResult = await EmailService.send({
                to: recipient.email,
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
                attachments: NotificationService._attachmentsOrNone(rendered.attachments),
                headers: rendered.headers,
            });
            const o = NotificationService._outcome(sendResult, 1);
            await NotificationService._recordEmail({
                userType,
                userId,
                kind,
                locale: lang,
                payload,
                state: o.state,
                emailStatus: o.emailStatus,
                attempts: 1,
                nextAttemptAt: o.nextAttemptAt,
                lastError: o.error,
                pending: o.emailStatus === 'retry' ? rendered : null,
            });
            if (sendResult.sent || o.emailStatus === 'retry') {
                await NotificationService._markEmailed(userType, userId, kind);
            }
            result.emailStatus = o.emailStatus;
            result.email = sendResult.sent ? 'sent' : sendResult.skipped || 'failed';
        } catch (e) {
            result.email = 'error';
        }
        return result;
    }

    /** Outbox: 3 attempts over 24 h — retry after 1 h, then after 23 h, then 'abandoned'. */
    static get EMAIL_MAX_ATTEMPTS() {
        return 3;
    }

    static get EMAIL_RETRY_DELAYS_MS() {
        return [60 * 60 * 1000, 23 * 60 * 60 * 1000];
    }

    /**
     * The delivery state of one attempt. A send that was SKIPPED (SMTP off,
     * not configured — a configuration fact, not a transient failure) is not
     * retried; an ERROR is retried until EMAIL_MAX_ATTEMPTS, then abandoned.
     */
    static _outcome(sendResult, attempts, now = new Date()) {
        const r = sendResult || {};
        if (r.sent) return { state: 'sent', emailStatus: 'sent', nextAttemptAt: null, error: null };
        if (!r.error) {
            return {
                state: 'failed',
                emailStatus: 'skipped',
                nextAttemptAt: null,
                error: r.skipped || 'not sent',
            };
        }
        const n = Number(attempts) || 1;
        if (n >= NotificationService.EMAIL_MAX_ATTEMPTS) {
            return {
                state: 'failed',
                emailStatus: 'abandoned',
                nextAttemptAt: null,
                error: r.error,
            };
        }
        const delays = NotificationService.EMAIL_RETRY_DELAYS_MS;
        const delay = delays[Math.min(n - 1, delays.length - 1)];
        return {
            state: 'failed',
            emailStatus: 'retry',
            nextAttemptAt: new Date(now.getTime() + delay),
            error: r.error,
        };
    }

    /**
     * An error message fit for the audit row: every e-mail address masked
     * (« a***@domain »), length capped. A single forward pass, no regular
     * expression over the message: an SMTP server's reply cannot make it slow.
     */
    static _safeError(e) {
        if (e == null) return null;
        const s = String(e).slice(0, 2000);
        const local = (c) => /[A-Za-z0-9._%+-]/.test(c);
        let out = '';
        let i = 0;
        while (i < s.length) {
            const at = s.indexOf('@', i);
            if (at < 0) {
                out += s.slice(i);
                break;
            }
            let start = at;
            while (start > i && local(s[start - 1])) start--;
            out += start < at ? `${s.slice(i, start)}${s[start]}***@` : s.slice(i, at + 1);
            i = at + 1;
        }
        return out.slice(0, 500);
    }

    /** What a deferred / retried mail keeps on its row (the logo is re-attached at send time). */
    static _storable(rendered) {
        const r = rendered || {};
        return { subject: r.subject, html: r.html, text: r.text, headers: r.headers || {} };
    }

    /** The email-channel delivery-audit row (best-effort; never throws). */
    static async _recordEmail({
        userType,
        userId,
        kind,
        locale,
        payload,
        state,
        emailStatus,
        attempts,
        nextAttemptAt,
        lastError,
        pending,
    }) {
        try {
            const body = {
                ...(payload && typeof payload === 'object' ? payload : {}),
                ...(pending
                    ? {
                          [NotificationService.PENDING_EMAIL_KEY]:
                              NotificationService._storable(pending),
                      }
                    : {}),
            };
            await NotificationService._bestEffort(() =>
                db.run(
                    `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, sent_at,
                                                email_status, email_attempts, next_attempt_at, last_error)
                     VALUES (?, ?, 'email', ?, ?, ?, ?, ${state === 'sent' ? 'now()' : 'NULL'}, ?, ?, ?, ?)`,
                    [
                        userType,
                        userId,
                        kind,
                        NotificationService._lang(locale),
                        JSON.stringify(body),
                        state,
                        emailStatus,
                        Number(attempts) || 0,
                        nextAttemptAt || null,
                        NotificationService._safeError(lastError),
                    ]
                )
            );
        } catch {
            /* notification audit is best-effort */
        }
    }

    /**
     * Run a best-effort statement in its own SAVEPOINT when inside a
     * transaction, so a failure it raises (and the caller swallows) does not
     * abort the statements that follow it in the same notification.
     */
    static _bestEffort(fn) {
        return typeof db.runInSavepoint === 'function' ? db.runInSavepoint(fn) : fn();
    }

    /**
     * Mark the in-app row of this event as already e-mailed: the daily digest
     * lists only what the person has NOT received by e-mail yet. The row is
     * the latest in-app row of this kind for the recipient — the one step 1 of
     * _notify wrote, in the same savepoint.
     */
    static async _markEmailed(userType, userId, kind) {
        try {
            await NotificationService._bestEffort(() =>
                db.run(
                    `UPDATE notifications SET email_status = 'emailed'
                      WHERE id = (SELECT id FROM notifications
                                   WHERE user_type = ? AND user_id = ? AND channel = 'inapp' AND kind = ?
                                   ORDER BY id DESC LIMIT 1)`,
                    [userType, userId, kind]
                )
            );
        } catch {
            /* best-effort */
        }
    }

    /** E-mail tier of a kind, from the catalogue: 'immediate' | 'digest' | 'none'. */
    static _tier(kind) {
        return catalogue.tierOf(kind);
    }

    /** Mandatory kind (safety, security)? From the catalogue. */
    static _isMandatory(kind) {
        return catalogue.isMandatory(kind);
    }

    /**
     * The language of a mail: the recipient's (`locale`, when the caller knows
     * it), else the site's mail language (App Settings → E-mail,
     * `mailDefaultLanguage`), else French. ONE language per mail.
     */
    static async _mailLang(locale) {
        return require('../utils/emailTemplate').mailLang(locale);
    }

    /**
     * Build an absolute URL for a relative in-app link, for use in emails where a
     * bare path is not clickable.
     *
     * Delegates to the ONE resolver (utils/emailTemplate.baseUrl) that every other
     * outbound mail already uses. This used to read `BASE_URL` directly while the
     * digest/credential mails read `APP_BASE_URL` — the name documented in
     * .env.example — so an admin who configured the documented variable still got
     * bare relative paths here, unclickable in every notification email. The shared
     * resolver accepts both names and falls back to the machine hostname, so a link
     * is always absolute.
     */
    static absUrl(link) {
        return require('../utils/emailTemplate').absUrl(link);
    }

    // ---- In-app notification centre (reads the `notifications` inbox) ----------
    // Recipient identity: employees/managers → ('employee', employees.id);
    // admins/superadmins → ('admin', admins.id). Only the 'inapp' channel rows are
    // the user-facing inbox (the 'email' rows are a delivery audit).
    /**
     * `sinceHours` bounds the window (default: unbounded, the inbox behaviour).
     * The daily digest passes 24 and `excludeEmailed` (an item the person
     * already received by e-mail on its own, or in an earlier digest, is not
     * repeated) — see sendDigest.
     */
    static async listInApp({
        userType,
        userId,
        limit = 20,
        unreadOnly = false,
        sinceHours = null,
        excludeEmailed = false,
    }) {
        const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const hours = Number(sinceHours) > 0 ? Math.floor(Number(sinceHours)) : null;
        return db.all(
            `SELECT id, kind, payload, state, locale, read_at, created_at, email_status
               FROM notifications
              WHERE user_type = ? AND user_id = ? AND channel = 'inapp'
                    AND ${NotificationService.VISIBLE_SQL}
                    ${unreadOnly ? 'AND read_at IS NULL' : ''}
                    ${hours ? `AND created_at >= now() - interval '${hours} hours'` : ''}
                    ${excludeEmailed ? 'AND email_status IS NULL' : ''}
              ORDER BY created_at DESC
              LIMIT ?`,
            [userType, userId, lim]
        );
    }

    /**
     * the inbox is a LIST, so it
     * gets the same server-side filters + paging as every other admin list. The
     * 100-row cap of listInApp silently hid everything older; a person with 159
     * campaign reminders could not reach the one access review underneath.
     *
     * `family` is the part of the kind before the dot (cycle, sa, access...), which
     * is how the kinds are actually namespaced.
     */
    static _inAppWhere({ unreadOnly, readOnly, family }) {
        const where = [
            "channel = 'inapp'",
            'user_type = ?',
            'user_id = ?',
            NotificationService.VISIBLE_SQL,
        ];
        if (unreadOnly) where.push('read_at IS NULL');
        if (readOnly) where.push('read_at IS NOT NULL');
        if (family) where.push("split_part(kind, '.', 1) = ?");
        return where.join(' AND ');
    }

    static async countInApp({
        userType,
        userId,
        unreadOnly = false,
        readOnly = false,
        family = null,
    }) {
        const params = [userType, userId];
        if (family) params.push(family);
        const row = await db.get(
            `SELECT COUNT(*) AS c FROM notifications WHERE ${NotificationService._inAppWhere({ unreadOnly, readOnly, family })}`,
            params
        );
        return Number((row && (row.c ?? row.count)) || 0);
    }

    static async listInAppPage({
        userType,
        userId,
        offset = 0,
        limit = 20,
        unreadOnly = false,
        readOnly = false,
        family = null,
    }) {
        const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
        const off = Math.max(Number(offset) || 0, 0);
        const params = [userType, userId];
        if (family) params.push(family);
        return db.all(
            `SELECT id, kind, payload, state, locale, read_at, created_at
               FROM notifications
              WHERE ${NotificationService._inAppWhere({ unreadOnly, readOnly, family })}
              ORDER BY created_at DESC
              LIMIT ${lim} OFFSET ${off}`,
            params
        );
    }

    /** The kind families the signed-in person actually has, for the filter select. */
    static async inAppFamilies({ userType, userId }) {
        const rows = await db.all(
            `SELECT split_part(kind, '.', 1) AS family, COUNT(*) AS c
               FROM notifications
              WHERE channel = 'inapp' AND user_type = ? AND user_id = ?
                    AND ${NotificationService.VISIBLE_SQL}
              GROUP BY 1 ORDER BY 1`,
            [userType, userId]
        );
        return rows.map((r) => ({ family: r.family, count: Number(r.c ?? r.count) }));
    }

    /**
     * The predicate that makes quiet hours REAL on the in-app channel: a row
     * deferred into a quiet window is not in the inbox and not in the bell
     * count until its window ends. `release_at IS NULL` covers rows written
     * before migration 75 — those were never genuinely deferred (the old
     * release job un-snoozed them on its very next tick), so they stay visible
     * rather than being stranded forever.
     */
    static get VISIBLE_SQL() {
        return "(state <> 'snoozed' OR release_at IS NULL OR release_at <= now())";
    }

    /**
     * Mass in-app fan-out (campaign launches, survey invitations) — ONE chunked
     * multi-row INSERT instead of N per-user notify calls, so a 4000-employee
     * cycle-open costs a handful of statements and ZERO email attempts. Always
     * in-app only; use for digest-tier informational kinds.
     */
    static async enqueueBulkInApp({ userType, userIds, kind, locale = 'fr', payload }) {
        const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
        if (!ids.length) return 0;
        NotificationService._checkDeclared(kind);
        const pl = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
        const CHUNK = 500;
        let n = 0;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            const values = slice.map(() => "(?, ?, 'inapp', ?, ?, ?, 'queued')").join(',');
            const params = [];
            for (const uid of slice) params.push(userType, uid, kind, locale, pl);
            await db.run(
                `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state) VALUES ${values}`,
                params
            );
            n += slice.length;
        }
        return n;
    }

    // ---- Per-user preferences (the user's own "don't invade my mailbox" controls) --
    // Stored as wildcard rows in notification_preferences: ('__all__','email') holds
    // the per-user email master switch; ('__all__','inapp') holds quiet hours. This
    // needs no migration — the table already keys on (user_type,user_id,kind,channel).
    static async getUserPrefs({ userType, userId }) {
        const out = { emailEnabled: true, quietStart: null, quietEnd: null };
        try {
            const rows = await db.all(
                "SELECT kind, channel, enabled, quiet_hours_start, quiet_hours_end FROM notification_preferences WHERE user_type = ? AND user_id = ? AND kind = '__all__'",
                [userType, userId]
            );
            // PG returns TIME as 'HH:MM:SS'; the form renders it into an
            // <input type="time">, which round-trips 'HH:MM'. Normalising here
            // keeps what the user sees identical to what they saved.
            const hhmm = (v) => {
                if (!v) return null;
                const m = /^(\d{1,2}):(\d{2})/.exec(String(v));
                return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : null;
            };
            for (const r of rows) {
                if (r.channel === 'email' && r.enabled === false) out.emailEnabled = false;
                if (r.channel === 'inapp') {
                    out.quietStart = hhmm(r.quietHoursStart ?? r.quiet_hours_start);
                    out.quietEnd = hhmm(r.quietHoursEnd ?? r.quiet_hours_end);
                }
            }
        } catch (_) {
            /* defaults */
        }
        return out;
    }

    static async setUserPrefs({ userType, userId, emailEnabled, quietStart, quietEnd }) {
        await db.run(
            `INSERT INTO notification_preferences (user_type, user_id, kind, channel, enabled)
             VALUES (?, ?, '__all__', 'email', ?)
             ON CONFLICT (user_type, user_id, kind, channel) DO UPDATE SET enabled = EXCLUDED.enabled`,
            [userType, userId, emailEnabled !== false]
        );
        await db.run(
            `INSERT INTO notification_preferences (user_type, user_id, kind, channel, enabled, quiet_hours_start, quiet_hours_end)
             VALUES (?, ?, '__all__', 'inapp', true, ?, ?)
             ON CONFLICT (user_type, user_id, kind, channel) DO UPDATE SET
               quiet_hours_start = EXCLUDED.quiet_hours_start, quiet_hours_end = EXCLUDED.quiet_hours_end`,
            [userType, userId, quietStart || null, quietEnd || null]
        );
        return true;
    }

    static async _userEmailAllowed(userType, userId) {
        try {
            const p = await db.get(
                "SELECT enabled FROM notification_preferences WHERE user_type = ? AND user_id = ? AND kind = '__all__' AND channel = 'email'",
                [userType, userId]
            );
            return !p || p.enabled !== false;
        } catch {
            return true;
        }
    }

    static async unreadCount({ userType, userId }) {
        const r = await db.get(
            `SELECT COUNT(*)::int AS c FROM notifications
              WHERE user_type = ? AND user_id = ? AND channel = 'inapp' AND read_at IS NULL
                AND ${NotificationService.VISIBLE_SQL}`,
            [userType, userId]
        );
        return r ? r.c : 0;
    }

    static async markRead({ id, userType, userId }) {
        // Ownership-scoped: a user can only mark their OWN notifications read.
        const { changes } = await db.run(
            `UPDATE notifications SET read_at = now()
              WHERE id = ? AND user_type = ? AND user_id = ? AND channel = 'inapp' AND read_at IS NULL`,
            [Number(id), userType, userId]
        );
        return changes > 0;
    }

    static async markAllRead({ userType, userId }) {
        // A row still inside the recipient's quiet window is NOT in their inbox,
        // so "mark all read" must not swallow it — they have not seen it yet.
        const { changes } = await db.run(
            `UPDATE notifications SET read_at = now()
              WHERE user_type = ? AND user_id = ? AND channel = 'inapp' AND read_at IS NULL
                AND ${NotificationService.VISIBLE_SQL}`,
            [userType, userId]
        );
        return changes || 0;
    }

    /** Fetch one inapp notification the user owns (for the mark-read-then-redirect flow). */
    static async getOwned({ id, userType, userId }) {
        return db.get(
            `SELECT id, kind, payload, read_at FROM notifications
              WHERE id = ? AND user_type = ? AND user_id = ? AND channel = 'inapp'
                AND ${NotificationService.VISIBLE_SQL}`,
            [Number(id), userType, userId]
        );
    }

    /** Look up the destination email address for a recipient. */
    static async _resolveEmail(userType, userId) {
        return (await NotificationService._resolveRecipient(userType, userId)).email;
    }

    /**
     * Resolve a recipient's { email, name, emailStatus } for a courteous,
     * personalised email. name → employee first name / admin display name
     * (best-effort; '' when unknown).
     *
     * Suppression: a recipient who can no longer receive anything — an
     * employee who has left (is_active false), whose record was voided
     * (cancelled_at) or erased (erased_at), an admin whose account is
     * deactivated — resolves to NO address and emailStatus 'suppressed'. The
     * check runs at every attempt, so a mail held by quiet hours or waiting for
     * a retry is never sent to someone who left in the meantime.
     */
    static async _resolveRecipient(userType, userId) {
        if (!userId) return { email: null, name: '', emailStatus: null };
        try {
            if (userType === 'admin') {
                const row = await db.get(
                    'SELECT email, username, is_active FROM admins WHERE id = ?',
                    [userId]
                );
                const name = (row && (row.firstName || row.username)) || '';
                if (row && (row.isActive ?? row.is_active) === false) {
                    return { email: null, name, emailStatus: 'suppressed' };
                }
                return { email: row && row.email ? row.email : null, name, emailStatus: null };
            }
            const row = await db.get(
                'SELECT email, first_name, is_active, cancelled_at, erased_at FROM employees WHERE id = ?',
                [userId]
            );
            const name = (row && (row.firstName || row.first_name)) || '';
            if (
                row &&
                ((row.isActive ?? row.is_active) === false ||
                    row.cancelledAt ||
                    row.cancelled_at ||
                    row.erasedAt ||
                    row.erased_at)
            ) {
                return { email: null, name: '', emailStatus: 'suppressed' };
            }
            return { email: row && row.email ? row.email : null, name, emailStatus: null };
        } catch {
            return { email: null, name: '', emailStatus: null };
        }
    }

    /** Moved to ./notificationCatalogue (the one catalogue of every kind). */
    static get KIND_LABELS() {
        return catalogue.KIND_LABELS;
    }

    /** Moved to ./notificationCatalogue (the one catalogue of every kind). */
    static get KIND_META() {
        return catalogue.KIND_META;
    }

    /** Moved to ./notificationCatalogue (the one catalogue of every kind). */
    static get KIND_POLICY() {
        return catalogue.KIND_POLICY;
    }

    /** Moved to ./notificationCatalogue (the one catalogue of every kind). */
    static get KIND_SUBTITLE() {
        return catalogue.KIND_SUBTITLE;
    }

    /** The complement of a kind's title for this payload, or null (catalogue.subtitleOf). */
    static _kindSubtitle(kind, payload, locale) {
        return catalogue.subtitleOf(kind, payload, locale);
    }

    /**
     * Resolve a KIND_META `title` for a locale. Titles are stored as { fr, en }
     * (older/string titles are returned as-is). FR is primary: it is the fallback
     * whenever the requested language is missing. `locale` may be 'fr', 'en',
     * 'en-US', etc.; only the leading language subtag matters.
     */
    static _localizeTitle(title, locale) {
        return catalogue.localize(title, locale);
    }

    /**
     * The written REASON a decision carried, when the event site put one in the
     * payload — `{ reason }` is the only shape any emitter writes (a cancellation
     * by the reviewer, the refusal or the grant of a request for change). Returns
     * null when there is none.
     *
     * Normalised, never escaped: every surface that prints it escapes on its own
     * (`<%= %>` in the notification centre, `esc` in the bell), and escaping
     * here would show a reader `&amp;` instead of `&`. Folded to one line and
     * capped, because it is rendered inside a single-line title row.
     */
    static _payloadReason(payload) {
        const raw = payload && payload.reason;
        if (raw == null) return null;
        // Folded to ONE line, verbatim otherwise: a run of whitespace (or of any
        // stray control character a pasted reason may carry) becomes one space.
        // The control range IS the point of this expression; no-control-regex
        // exists to catch one typed by accident, which is not the case here.
        const s = String(raw)
            .replace(/[\u0000-\u001F\u007F]+/g, ' ') // eslint-disable-line no-control-regex
            .replace(/\s+/g, ' ')
            .trim();
        if (!s) return null;
        return s.length > 160 ? `${s.slice(0, 159)}…` : s;
    }

    /**
     * Normalise a stored notification row into a display object for the in-app
     * centre / bell: { id, kind, title, body, link, icon, read, createdAt }.
     * `locale` selects the display title language (FR primary fallback).
     *
     * THE REASON IS SHOWN. « Saisie faite sur le mauvais
     * collaborateur. » sat in the payload of notification 1299 and was never put
     * in front of the person it was written for: the row carried a title and
     * nothing else, so a cancellation read exactly like every other cancellation.
     * A decision that states a reason but never shows it is the house rule
     * ("états + motif") half applied. `body` carries it for any surface that can
     * render a second line; the title carries it too, because the two surfaces
     * that exist today — views/pages/notifications/index.ejs and the header bell
     * — print `title` and nothing else.
     *
     * `opts.withReason: false` keeps it OUT: the daily digest e-mail composes its
     * lines from present, and the confidentiality rule written above
     * KIND_MESSAGES is explicit — no reason, comment or rating ever leaves the
     * app by e-mail. The detail stays behind authentication, where clearance is
     * enforced.
     */
    static present(n, locale, opts = {}) {
        let payload = n.payload;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch {
                payload = {};
            }
        }
        payload = payload || {};
        const meta = NotificationService.KIND_META[n.kind] || {};
        // Locale-resolved title (FR primary); fall back to the English KIND_LABELS
        // used for email subjects, then the raw kind.
        const label =
            NotificationService._localizeTitle(meta.title, locale) ||
            NotificationService.KIND_LABELS[n.kind] ||
            n.kind;
        const reason = NotificationService._payloadReason(payload);
        // QA le complément qui NOMME l'objet (aujourd'hui : la campagne
        // et la transition, pour les trois signalements qui partagent le kind
        // `cycle.escalation`). Il n'est pas un motif : il reste dans le titre du
        // récapitulatif e-mail, que `withReason:false` ne fait taire que pour les
        // motifs, jamais pour l'identité de l'objet concerné.
        const subtitle = NotificationService._kindSubtitle(n.kind, payload, locale);
        const link = (meta.forceLink && meta.link) || payload.link || meta.link || '/dashboard';
        const parts = [label, subtitle];
        if (reason && opts.withReason !== false) parts.push(reason);
        return {
            id: Number(n.id),
            kind: n.kind,
            title: parts.filter(Boolean).join(' — '),
            body: reason,
            link,
            icon: meta.icon || 'fa-bell',
            read: !!(n.readAt || n.read_at),
            createdAt: n.createdAt || n.created_at,
        };
    }

    /** HTML-escape for values interpolated into the email body. */
    static _esc(s) {
        return require('../utils/emailTemplate').esc(s);
    }

    /** The product's default name (src/config/product.js), never typed here. */
    static get DEFAULT_APP_NAME() {
        return require('../utils/emailTemplate').defaultAppName();
    }

    /** Content-ID of the inline logo. */
    static get LOGO_CID() {
        return require('../utils/emailTemplate').LOGO_CID;
    }

    /**
     * Resolve tenant branding for emails (best-effort; sensible defaults). The
     * logo stays the stored data URL: it is NEVER put in the HTML — it travels
     * as a CID inline attachment. Overridable (scripts/render-notification-samples.js).
     */
    static async _brand() {
        return require('../utils/emailTemplate').brand();
    }

    /** The logo as a nodemailer inline attachment, or null (see emailTemplate.logoAttachment). */
    static _logoAttachment(brand) {
        return require('../utils/emailTemplate').logoAttachment(brand);
    }

    /** Moved to ./notificationCatalogue (the one catalogue of every kind). */
    static get KIND_MESSAGES() {
        return catalogue.KIND_MESSAGES;
    }

    /** Short, courteous message adapted to the event kind (FR primary). */
    static _kindMessage(kind, locale) {
        return require('../utils/emailTemplate').kindMessage(kind, locale);
    }

    /**
     * The subject line of a mail, in its language: « {app} — {subject} », the
     * kind's catalogue subject. Never built from a payload or from the caller
     * (emailTemplate.subjectFor): no name, no figure, no date, no status.
     */
    static _subjectFor(kind, locale, appName) {
        return require('../utils/emailTemplate').subjectFor(kind, locale, appName);
    }

    /** The kind's title (+ its subtitle) in one language: the headline INSIDE the mail. */
    static _kindHeadline(kind, locale, payload) {
        return require('../utils/emailTemplate').kindHeadline(kind, locale, payload);
    }

    /**
     * THE composer (utils/emailTemplate.compose) — every mail goes through it:
     * one look, one language, one subject pattern, one footer.
     */
    static _compose(spec = {}, ctx = {}) {
        return require('../utils/emailTemplate').compose(spec, ctx);
    }

    /**
     * Catalogue-only entry — { kind, payload, brand, recipientName, locale } →
     * the composed mail with the kind's catalogue title and message (no
     * blocks). A legacy subject / html / text argument is ignored.
     */
    static _render({ kind, payload, brand, recipientName, locale }) {
        return NotificationService._compose(
            { kind, payload, locale },
            { brand: brand || {}, recipientName }
        );
    }

    /**
     * renderEmail — THE e-mail rendering contract (documented on
     * utils/emailTemplate.renderEmail). The branding comes from _brand.
     */
    static async renderEmail(spec = {}) {
        const brand = await NotificationService._brand();
        const locale = await NotificationService._mailLang(spec && spec.locale);
        const { recipientName, ...rest } = spec || {};
        return NotificationService._compose({ ...rest, locale }, { brand, recipientName });
    }

    /** renderEmail blocks → { html, text } (utils/emailTemplate.renderBlocks). */
    static _renderBlocks(blocks, opts) {
        return require('../utils/emailTemplate').renderBlocks(blocks, opts);
    }

    /**
     * Parse a preference row's quiet-hours window into minutes-of-day, or null
     * when there is no usable window. Both ends are required — a half-filled
     * window (start with no end) can never define a period, and silently
     * treating it as "always quiet" or "never quiet" is exactly the kind of
     * invisible behaviour the UI copy promises against; the preferences form
     * therefore stores both or neither.
     *
     * The DB driver camelCases result keys and PG returns TIME as 'HH:MM:SS' —
     * both shapes are accepted. A zero-length window (start === end) is no
     * window at all.
     */
    static _window(pref) {
        const raw = (v) => {
            if (!v) return null;
            const [h, m] = String(v).split(':').map(Number);
            if (!Number.isInteger(h) || h < 0 || h > 23) return null;
            const mins = Number.isInteger(m) && m >= 0 && m <= 59 ? m : 0;
            return h * 60 + mins;
        };
        const start = raw(pref && (pref.quietHoursStart ?? pref.quiet_hours_start));
        const end = raw(pref && (pref.quietHoursEnd ?? pref.quiet_hours_end));
        if (start === null || end === null || start === end) return null;
        return { start, end };
    }

    /**
     * Is `now` inside the window? Wall-clock LOCAL time, not UTC: a user typing
     * "22:00" in the preferences form means 22:00 where the server (and, on an
     * on-prem single-country install, the user) lives. The previous UTC
     * comparison silently shifted every window by the server's offset.
     */
    static _inQuietHours(pref, now = new Date()) {
        const w = NotificationService._window(pref);
        if (!w) return false;
        const mins = now.getHours() * 60 + now.getMinutes();
        return w.start <= w.end ? mins >= w.start && mins < w.end : mins >= w.start || mins < w.end;
    }

    /**
     * The instant a notification raised right now becomes deliverable, or null
     * when quiet hours do not apply. Handles the window that wraps past
     * midnight (22:00 → 07:00 releases tomorrow morning, not this morning).
     */
    static _releaseAt(pref, now = new Date()) {
        const w = NotificationService._window(pref);
        if (!w || !NotificationService._inQuietHours(pref, now)) return null;
        const end = new Date(now.getTime());
        end.setHours(Math.floor(w.end / 60), w.end % 60, 0, 0);
        if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
        return end;
    }

    /** Reserved payload key carrying a rendered-but-deferred email body. */
    static get PENDING_EMAIL_KEY() {
        return '__pendingEmail';
    }

    /**
     * Release everything whose quiet-hours window has ended, and drain the
     * e-mail outbox — the tick that makes "Les notifications reçues pendant
     * cette plage sont différées" true and that retries a failed mail.
     *
     *   in-app : flip 'snoozed' → 'queued', which is what puts the row back in
     *            the inbox and the bell count.
     *   email  : actually SEND the mail that was held back, then record its
     *            outcome. Without this half, deferring email would mean losing
     *            it.
     *   retry  : a mail whose send FAILED is retried 1 h later, then 23 h
     *            later; after the third failure it is marked 'abandoned'.
     *            Nothing is deleted.
     *
     * The old implementation joined notification_preferences on p.kind = n.kind
     * while the quiet window lives on the wildcard ('__all__','inapp') row, so
     * the join matched nothing, the window read as NULL, and EVERY snoozed row
     * was released on the next tick — quiet hours deferred a notification for
     * at most fifteen minutes, and usually for none at all. The window is now
     * resolved once, at enqueue time, into notifications.release_at.
     *
     * `release_at IS NULL` matches rows written before migration 75; they were
     * never genuinely deferred, so they are released rather than stranded.
     */
    static async releaseSnoozed({ limit = 200 } = {}) {
        const out = {
            released: 0,
            emailsSent: 0,
            emailsFailed: 0,
            emailsSkipped: 0,
            retried: 0,
            abandoned: 0,
            failed: 0,
        };

        // 1) In-app — one statement, no N+1, regardless of table size.
        try {
            const r = await db.run(
                `UPDATE notifications SET state = 'queued'
                  WHERE state = 'snoozed' AND channel = 'inapp'
                    AND (release_at IS NULL OR release_at <= now())`
            );
            out.released = (r && r.changes) || 0;
        } catch (_) {
            /* best-effort tick */
        }

        // 2) Email — claim BEFORE sending (same discipline as jobs/reminders.js)
        //    so a second scheduler, or a restart mid-batch, can never double-send.
        //    The claim is a lease ('sending', from now): a process killed between
        //    claim and send leaves a row the retry pass re-claims an hour later,
        //    never a lost mail.
        const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
        let due = [];
        try {
            due =
                (await db.all(
                    `UPDATE notifications SET state = 'queued', email_status = 'sending',
                            next_attempt_at = now()
                      WHERE id IN (
                            SELECT id FROM notifications
                             WHERE state = 'snoozed' AND channel = 'email'
                               AND (release_at IS NULL OR release_at <= now())
                             ORDER BY id
                             LIMIT ?
                             FOR UPDATE SKIP LOCKED)
                      RETURNING id, user_type, user_id, kind, locale, payload`,
                    [lim]
                )) || [];
        } catch (_) {
            due = [];
        }
        const count = (o) => {
            if (o.state === 'sent') out.emailsSent++;
            else if (o.emailStatus === 'abandoned') out.abandoned++;
            else if (o.emailStatus === 'retry') out.emailsFailed++;
            else out.emailsSkipped++; // opt-out, no address, leaver, SMTP off: not a failure
        };
        for (const row of due) count(await NotificationService._attempt(row, 1));

        // 3) Outbox retries. A row left 'sending' by a killed process is
        //    claimable again an hour after its claim. The lease runs from the
        //    CLAIM (next_attempt_at = now()), not from the old due time — else a
        //    row due more than an hour ago would be re-claimable by the next
        //    tick while it is still being sent.
        let retry = [];
        try {
            retry =
                (await db.all(
                    `UPDATE notifications SET email_status = 'sending', next_attempt_at = now()
                      WHERE id IN (
                            SELECT id FROM notifications
                             WHERE channel = 'email'
                               AND ((email_status = 'retry' AND next_attempt_at <= now())
                                 OR (email_status = 'sending' AND next_attempt_at <= now() - interval '1 hour'))
                             ORDER BY next_attempt_at, id
                             LIMIT ?
                             FOR UPDATE SKIP LOCKED)
                      RETURNING id, user_type, user_id, kind, locale, payload, email_attempts`,
                    [lim]
                )) || [];
        } catch (_) {
            retry = [];
        }
        for (const row of retry) {
            const attempts = (Number(row.emailAttempts ?? row.email_attempts) || 0) + 1;
            count(await NotificationService._attempt(row, attempts));
            out.retried++;
        }
        // The job ledger reads `failed` (JobRunService).
        out.failed = out.emailsFailed + out.abandoned;
        return out;
    }

    /** One delivery attempt of a stored email row, and its recorded outcome. */
    static async _attempt(row, attempts) {
        let res;
        try {
            res = await NotificationService._deliverStored(row);
        } catch (e) {
            res = { sent: false, error: (e && e.message) || 'send failed' };
        }
        const o = res.suppressed
            ? {
                  state: 'failed',
                  emailStatus: 'suppressed',
                  nextAttemptAt: null,
                  error: 'recipient inactive, cancelled or erased',
              }
            : NotificationService._outcome(res, attempts);
        try {
            await db.run(
                `UPDATE notifications
                    SET state = ?, sent_at = ${o.state === 'sent' ? 'now()' : 'NULL'},
                        email_status = ?, email_attempts = ?, next_attempt_at = ?, last_error = ?
                  WHERE id = ?`,
                [
                    o.state,
                    o.emailStatus,
                    attempts,
                    o.nextAttemptAt || null,
                    NotificationService._safeError(o.error),
                    Number(row.id),
                ]
            );
        } catch (_) {
            /* delivery audit is best-effort */
        }
        return o;
    }

    /**
     * Send one stored email row (deferred by quiet hours, or queued for a
     * retry). The recipient is re-resolved NOW: a leaver is suppressed, and the
     * opt-out may have been switched OFF while the mail waited — the CURRENT
     * preference wins, except for a mandatory kind.
     * → { sent, skipped?, error?, suppressed? }
     */
    static async _deliverStored(row) {
        const userType = row.userType || row.user_type;
        const userId = Number(row.userId ?? row.user_id);
        let payload = row.payload;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch {
                payload = {};
            }
        }
        payload = payload && typeof payload === 'object' ? payload : {};
        const pending = payload[NotificationService.PENDING_EMAIL_KEY];
        const mandatory = NotificationService._isMandatory(row.kind);
        if (!mandatory && !(await NotificationService._userEmailAllowed(userType, userId)))
            return { sent: false, skipped: 'user_opt_out' };
        const recipient = await NotificationService._resolveRecipient(userType, userId);
        if (recipient.emailStatus === 'suppressed') return { sent: false, suppressed: true };
        if (!recipient.email) return { sent: false, skipped: 'no_address' };

        const brand = await NotificationService._brand();
        // A row whose rendered body was removed (erasure strips it from rows
        // about an erased person) is re-composed from its kind alone.
        const rendered =
            pending && pending.subject && pending.html
                ? pending
                : NotificationService._compose(
                      { kind: row.kind, payload, locale: row.locale, mandatory },
                      { brand, recipientName: recipient.name }
                  );
        const attachments = NotificationService._reviveAttachments(rendered.attachments);
        if (
            String(rendered.html).includes(`cid:${NotificationService.LOGO_CID}`) &&
            !attachments.some((a) => a && a.cid === NotificationService.LOGO_CID)
        ) {
            const logo = NotificationService._logoAttachment(brand);
            if (logo) attachments.push(logo);
        }
        const EmailService = require('./EmailService');
        if (mandatory && !(await EmailService.isEnabled()))
            return { sent: false, skipped: 'disabled' };
        return EmailService.send({
            to: recipient.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            attachments: NotificationService._attachmentsOrNone(attachments),
            headers: rendered.headers || {},
        });
    }

    /** A mail's attachments, or undefined when there is none (the logo is the only one). */
    static _attachmentsOrNone(list) {
        return Array.isArray(list) && list.length ? list : undefined;
    }

    /**
     * Attachments of a mail that went through JSON (a held row): a Buffer was
     * stored as { type: 'Buffer', data: [...] }, or as a base64 string with
     * `encoding: 'base64'`. Anything else unusable is dropped.
     */
    static _reviveAttachments(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const a of list) {
            if (!a || typeof a !== 'object') continue;
            let content = a.content;
            if (content && content.type === 'Buffer' && Array.isArray(content.data))
                content = Buffer.from(content.data);
            else if (typeof content === 'string' && a.encoding === 'base64')
                content = Buffer.from(content, 'base64');
            if (content == null) continue;
            out.push({
                filename: a.filename,
                contentType: a.contentType,
                cid: a.cid,
                contentDisposition: a.contentDisposition,
                content,
            });
        }
        return out;
    }

    /**
     * Run `fn` OUTSIDE the caller's transaction context (on the pool), for
     * fire-and-forget work that must not share the transaction's pg client.
     * A pass-through when there is no open transaction.
     */
    static _outsideTx(fn) {
        const als = db && db._txStore;
        if (
            als &&
            typeof als.exit === 'function' &&
            typeof als.getStore === 'function' &&
            als.getStore()
        )
            return als.exit(fn);
        return fn();
    }

    /** May this kind appear in the daily digest? Never a tier-'none' kind. */
    static _digestible(kind) {
        return catalogue.isDigestible(kind);
    }

    /** Deliver one email row that was held back by quiet hours (boolean, kept for callers). */
    static async _sendDeferredEmail(row) {
        const r = await NotificationService._deliverStored(row);
        return !!(r && r.sent);
    }

    /**
     * Build + send ONE branded rollup email of a user's NEW in-app notifications
     * — the "no mailbox invasion" batching lever (many events → one daily email).
     *
     * The lines are the last 24 hours' unread items that are (a) not tier
     * 'none' — a kind that is never e-mailed is never named in a digest either
     * — and (b) not already e-mailed on their own or listed in an earlier
     * digest; then one line « N actions toujours en attente » for what is older
     * and still unread. No new item ⇒ no mail at all. A person who has left is
     * not written to. Gated by the `digest` email category and the person's own
     * switch. The subject never carries the count.
     */
    static async sendDigest({ userType, userId, locale }) {
        const EmailService = require('./EmailService');
        if (!(await EmailService.isCategoryEnabled('digest'))) return { skipped: 'digest_off' };
        // The per-user opt-out governs the digest FIRST. It is the one email a
        // recipient is most likely to want stopped.
        if (!(await NotificationService._userEmailAllowed(userType, userId)))
            return { skipped: 'user_opt_out' };
        // The window is the LAST 24 HOURS, matching the recipient selection of
        // personal-digest.js: an unread notification is not re-listed at the top
        // of every day's summary. The bell and the notification centre still show
        // everything.
        const rows = await NotificationService.listInApp({
            userType,
            userId,
            limit: 100,
            unreadOnly: true,
            sinceHours: 24,
            excludeEmailed: true,
        });
        const fresh = (rows || []).filter(
            (r) => NotificationService._digestible(r.kind) && !(r.emailStatus || r.email_status)
        );
        if (!fresh.length) return { skipped: 'empty' };
        const recipient = await NotificationService._resolveRecipient(userType, userId);
        if (recipient.emailStatus === 'suppressed') return { skipped: 'suppressed' };
        if (!recipient.email) return { skipped: 'no_address' };
        const brand = await NotificationService._brand();
        const lang = await NotificationService._mailLang(locale);
        const D = NotificationService.DIGEST_TEXT[lang];
        // `withReason: false` — no reason, comment or rating leaves the app by
        // e-mail. The reason stays readable in the notification centre, behind
        // authentication, where clearance is enforced.
        const items = fresh.map((r) => NotificationService.present(r, lang, { withReason: false }));
        const shown = items.slice(0, 20);
        const blocks = [
            { type: 'links', items: shown.map((i) => ({ text: i.title, href: i.link })) },
        ];
        if (items.length > shown.length)
            blocks.push({ type: 'p', text: D.more(items.length - shown.length) });
        const outstanding = await NotificationService._outstandingCount(userType, userId);
        if (outstanding > 0)
            blocks.push({
                type: 'links',
                items: [{ text: D.pending(outstanding), href: '/notifications' }],
            });
        const rendered = NotificationService._compose(
            {
                kind: 'digest.daily',
                title: D.title(items.length),
                intro: D.lead,
                blocks,
                ctaLabel: D.cta,
                ctaUrl: '/notifications',
                locale: lang,
                mandatory: false,
                severity: 'info',
            },
            { brand, recipientName: recipient.name }
        );
        const send = await EmailService.send({
            to: recipient.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            attachments: NotificationService._attachmentsOrNone(rendered.attachments),
            headers: rendered.headers,
        });
        if (send.sent) {
            const ids = fresh.map((r) => Number(r.id)).filter(Boolean);
            if (ids.length) {
                try {
                    await db.run(
                        `UPDATE notifications SET email_status = 'digested'
                          WHERE id IN (${ids.map(() => '?').join(',')}) AND email_status IS NULL`,
                        ids
                    );
                } catch (_) {
                    /* best-effort */
                }
            }
        }
        return {
            sent: !!send.sent,
            count: items.length,
            outstanding,
            skipped: send.sent ? undefined : send.skipped || 'failed',
        };
    }

    /** Unread, visible, digestible items OLDER than the digest window (« toujours en attente »). */
    static async _outstandingCount(userType, userId) {
        try {
            const rows =
                (await db.all(
                    `SELECT kind, COUNT(*)::int AS c FROM notifications
                      WHERE user_type = ? AND user_id = ? AND channel = 'inapp' AND read_at IS NULL
                        AND ${NotificationService.VISIBLE_SQL}
                        AND created_at < now() - interval '24 hours'
                      GROUP BY kind`,
                    [userType, userId]
                )) || [];
            return rows.reduce(
                (a, r) => a + (NotificationService._digestible(r.kind) ? Number(r.c) || 0 : 0),
                0
            );
        } catch (_) {
            return 0;
        }
    }

    /** Mail chrome per language — one language per mail. */
    static get DIGEST_TEXT() {
        const num = (n, lang) => require('../utils/emailTemplate').fmtNum(n, 0, lang);
        return {
            fr: {
                hello: 'Bonjour',
                regards: 'Cordialement',
                team: (app) => `L'équipe ${app}`,
                cta: 'Voir toutes mes notifications',
                title: (n) =>
                    n === 1
                        ? "1 nouveauté pour vous aujourd'hui"
                        : `${num(n, 'fr')} nouveautés pour vous aujourd'hui`,
                lead: 'Voici ce qui est arrivé depuis hier.',
                more: (n) =>
                    n === 1
                        ? 'Et 1 autre dans le centre de notifications.'
                        : `Et ${num(n, 'fr')} autres dans le centre de notifications.`,
                pending: (n) =>
                    n === 1
                        ? '1 notification plus ancienne toujours en attente'
                        : `${num(n, 'fr')} notifications plus anciennes toujours en attente`,
            },
            en: {
                hello: 'Hello',
                regards: 'Kind regards',
                team: (app) => `The ${app} team`,
                cta: 'See all my notifications',
                title: (n) =>
                    n === 1
                        ? '1 new item for you today'
                        : `${num(n, 'en')} new items for you today`,
                lead: 'Here is what arrived since yesterday.',
                more: (n) =>
                    n === 1
                        ? 'And 1 more in the notification centre.'
                        : `And ${num(n, 'en')} more in the notification centre.`,
                pending: (n) =>
                    n === 1
                        ? '1 older notification still waiting'
                        : `${num(n, 'en')} older notifications still waiting`,
            },
        };
    }

    /** 'fr' | 'en' from any locale tag; FR is primary and the fallback. */
    static _lang(locale) {
        return String(locale || 'fr')
            .toLowerCase()
            .startsWith('en')
            ? 'en'
            : 'fr';
    }

    static async digestForUser({ userType, userId, since }) {
        // No lazy release here any more: the visibility predicate below already
        // hides a row only while its quiet window is open and surfaces it the
        // moment the window ends, with or without a scheduler. (The old lazy
        // call also meant a plain READ could trigger org-wide writes — and, now
        // that release sends deferred mail, would have sent email from a GET.)
        return db.all(
            `SELECT id, kind, payload, created_at
             FROM notifications
             WHERE user_type = ? AND user_id = ? AND channel = 'inapp'
               AND created_at >= ?
               AND ${NotificationService.VISIBLE_SQL}
             ORDER BY created_at DESC`,
            [userType, userId, since]
        );
    }
}

module.exports = NotificationService;
