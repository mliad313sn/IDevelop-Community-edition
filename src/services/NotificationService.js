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
 *
 *   Each person chooses (migration 183) which categories reach them by
 *   e-mail, the cadence of their summary, the language of their mails, .ics
 *   attachments and quiet hours (else their site's). Every event carries an
 *   event id and the object it is about, so the effectiveness page can tell
 *   what was opened and acted upon.
 */
class NotificationService {
    static async enqueue({
        userType,
        userId,
        kind,
        channel,
        locale,
        payload,
        eventId,
        refType,
        refId,
        ignoreQuietHours,
    }) {
        NotificationService._checkDeclared(kind);
        // One query for BOTH the kind-specific pref and the user's global ('__all__')
        // pref: kind-specific enable/quiet-hours win, else fall back to the global
        // quiet hours set in the preferences UI. (default = enabled, no quiet hours).
        const prefs = (await NotificationService._prefRows(userType, userId, kind, channel)) || [];
        const specific = prefs.find((p) => p.kind === kind && p.channel === channel);
        if (specific && specific.enabled === false) return { skipped: 'disabled' };

        // Quiet hours DEFER — they are not decoration. `release_at` records the
        // exact instant the window ends; until then the row is invisible in the
        // inbox (see listInApp/unreadCount) and the release tick flips it back to
        // 'queued'. Storing the absolute moment (rather than re-deriving it from
        // preferences later) is what makes deferral self-healing: the row still
        // surfaces on its own even if the scheduler never runs. A person with no
        // window of their own gets their site's (migration 183).
        let quiet = NotificationService._quietSource(prefs, kind, channel);
        if (!NotificationService._window(quiet))
            quiet = await NotificationService._siteQuiet(userType, userId);
        const releaseAt = ignoreQuietHours ? null : NotificationService._releaseAt(quiet);
        const state = releaseAt ? 'snoozed' : 'queued';
        const r = await db.run(
            `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, release_at,
                                        event_id, ref_type, ref_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                eventId || null,
                refType || null,
                refType && refId != null ? String(refId) : null,
            ]
        );
        const id = r && Number(r.lastID) > 0 ? Number(r.lastID) : null;
        return { state, releaseAt: releaseAt || null, id };
    }

    /**
     * The SITE default quiet-hours window of a person (migration 183):
     * employees only, an admin account has no site. Sites carry no time zone,
     * so the window is read in the server's local time, like the personal one.
     * null when there is none or it cannot be read.
     */
    static async _siteQuiet(userType, userId) {
        if (userType !== 'employee' || !userId) return null;
        try {
            const row = await db.get(
                `SELECT s.quiet_hours_start, s.quiet_hours_end
                   FROM employees e JOIN sites s ON s.id = e.site_id
                  WHERE e.id = ?`,
                [userId]
            );
            return row && NotificationService._window(row) ? row : null;
        } catch (_) {
            return null;
        }
    }

    /** The quiet window that applies to a person: their own, else their site's. */
    static async _quietFor(userType, userId) {
        const own = await NotificationService._quietPref(userType, userId);
        if (NotificationService._window(own)) return own;
        return NotificationService._siteQuiet(userType, userId);
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
     *       // or, written for ANY language (the recipient's own, migration 183):
     *       content: (B) => ({ title, intro, blocks, ctaLabel, ctaUrl, preheader }),
     *       calendar,      // { type, date | start, end?, uid? } → a content-free .ics
     *       refType, refId // the object it is about (else from KIND_REF)
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
            const oneLine = (v) => String(v).replace(/\n|\r/g, ' ');
            const msg = NotificationService._safeError(e && e.message) || 'error';
            console.warn(
                `[notify] ${oneLine(a.kind || '?')} → ${oneLine(a.userType || '?')}:${oneLine(a.userId ?? '?')} failed: ${oneLine(msg)}`.slice(
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
            calendar,
            byLocale,
            content,
        } = args || {};
        const result = { inapp: null, email: null };
        // One id per event, shared by its in-app and e-mail rows, and the object
        // it is about (identifiers only), for the measurements (migration 183).
        const eventId = NotificationService._newEventId();
        const ref = NotificationService._refOf(kind, payload, args);
        result.eventId = eventId;

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
        let inappRow = null;
        try {
            const r = await NotificationService._bestEffort(() =>
                NotificationService.enqueue({
                    userType,
                    userId,
                    kind,
                    channel: 'inapp',
                    locale,
                    payload,
                    eventId,
                    refType: ref.refType,
                    refId: ref.refId,
                })
            );
            inappRow = r || null;
            result.inapp = r && (r.state || r.skipped) ? r.state || r.skipped : 'queued';
        } catch (e) {
            result.inapp = 'error';
        }

        // 2) E-mail — the catalogue tier first. 'none' never e-mails; 'digest'
        //    defers to the daily digest; 'immediate' (or a kind absent from
        //    KIND_POLICY) sends now. A MANDATORY kind (safety, security) is sent
        //    now whatever its tier, the recipient's own switches (global and per
        //    category) and the per-domain toggle; the global e-mail switch and
        //    SMTP still apply.
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
            // The category × channel grid: a category switched off for e-mail
            // keeps the event in the app only.
            if (
                !mandatory &&
                !(await NotificationService._categoryAllowed(userType, userId, kind, 'email'))
            ) {
                result.email = 'category_opt_out';
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
                    eventId,
                    ref,
                });
                result.email = 'suppressed';
                return result;
            }
            if (!recipient.email) {
                result.email = 'no_address';
                return result;
            }
            // The recipient's own settings: e-mail language and .ics switch.
            const settings = await NotificationService._settingsRow(userType, userId);
            const mail = NotificationService._mailContent(
                {
                    title,
                    intro,
                    blocks,
                    ctaLabel,
                    ctaUrl,
                    preheader,
                    locale,
                    byLocale,
                    content,
                },
                settings,
                await NotificationService._mailLang(locale)
            );
            const lang = await NotificationService._mailLang(mail.locale);
            const brand = await NotificationService._brand();
            // The button goes through /notifications/:id/go (opened_at) when it
            // points where the in-app row points and that row is already in the
            // inbox (a row still inside its quiet window is not).
            const trackId =
                inappRow && inappRow.id && inappRow.state === 'queued' ? inappRow.id : null;
            const rendered = NotificationService._compose(
                {
                    kind,
                    severity,
                    title: mail.title,
                    intro: mail.intro,
                    blocks: mail.blocks,
                    ctaLabel: mail.ctaLabel,
                    ctaUrl: mail.ctaUrl,
                    preheader: mail.preheader,
                    locale: lang,
                    mandatory,
                    payload,
                    calendar,
                },
                {
                    brand,
                    recipientName: recipient.name,
                    icsEnabled: !settings || settings.icsEnabled !== false,
                    trackId,
                }
            );
            // Quiet hours apply to EMAIL too (the person's window, else their
            // site's). An immediate-tier mail raised at 03:00 is written as a
            // deferred email row (rendered NOW and parked on the row:
            // re-deriving it hours later from the kind alone would lose the
            // caller's blocks) and sent by the release tick once the window
            // ends. This is the delivery-audit row, not the in-app inbox row —
            // the inbox payload written in step 1 is untouched.
            const releaseAt = ignoreQuietHours
                ? null
                : NotificationService._releaseAt(
                      await NotificationService._quietFor(userType, userId)
                  );
            if (releaseAt) {
                try {
                    await db.run(
                        `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, release_at,
                                                    event_id, ref_type, ref_id)
                         VALUES (?, ?, 'email', ?, ?, ?, 'snoozed', ?, ?, ?, ?)`,
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
                            eventId,
                            ref.refType,
                            ref.refId,
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
                eventId,
                ref,
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

    /**
     * What a deferred / retried mail keeps on its row. The logo is re-attached
     * at send time; a small TEXT attachment (the content-free .ics) is kept as
     * is, since it cannot be rebuilt from the row.
     */
    static _storable(rendered) {
        const r = rendered || {};
        const out = { subject: r.subject, html: r.html, text: r.text, headers: r.headers || {} };
        const kept = (Array.isArray(r.attachments) ? r.attachments : []).filter(
            (a) => a && !a.cid && typeof a.content === 'string' && a.content.length <= 16384
        );
        if (kept.length)
            out.attachments = kept.map((a) => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
            }));
        return out;
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
        eventId,
        ref,
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
            const refType = (ref && ref.refType) || null;
            const refId = refType && ref.refId != null ? String(ref.refId) : null;
            await NotificationService._bestEffort(() =>
                db.run(
                    `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, sent_at,
                                                email_status, email_attempts, next_attempt_at, last_error,
                                                event_id, ref_type, ref_id)
                     VALUES (?, ?, 'email', ?, ?, ?, ?, ${state === 'sent' ? 'now()' : 'NULL'}, ?, ?, ?, ?, ?, ?, ?)`,
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
                        eventId || null,
                        refType,
                        refId,
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
     *
     * Quiet hours apply here too: one preferences read per chunk (and one site
     * read for the people without a window of their own), and a person inside
     * their window gets the row 'snoozed' until it ends, exactly as enqueue()
     * would do. Every row gets its own event id and the object it is about.
     */
    static async enqueueBulkInApp({ userType, userIds, kind, locale = 'fr', payload }) {
        const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
        if (!ids.length) return 0;
        NotificationService._checkDeclared(kind);
        const pl = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
        let parsed = payload;
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch (_) {
                parsed = {};
            }
        }
        const ref = NotificationService._refOf(kind, parsed, {});
        const CHUNK = 500;
        const now = new Date();
        let n = 0;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            const quiet = new Map();
            const own = new Set();
            try {
                const prefs =
                    (await db.all(
                        `SELECT user_id, quiet_hours_start, quiet_hours_end
                           FROM notification_preferences
                          WHERE user_type = ? AND kind = '__all__' AND channel = 'inapp'
                            AND user_id IN (${slice.map(() => '?').join(',')})`,
                        [userType, ...slice]
                    )) || [];
                for (const p of prefs) {
                    const uid = Number(p.userId ?? p.user_id);
                    if (NotificationService._window(p)) own.add(uid);
                    const at = NotificationService._releaseAt(p, now);
                    if (at) quiet.set(uid, at);
                }
            } catch (_) {
                /* no preferences readable → deliver now, as before */
            }
            const noOwn = slice.filter((uid) => !own.has(uid));
            if (userType === 'employee' && noOwn.length) {
                try {
                    const sites =
                        (await db.all(
                            `SELECT e.id AS emp_id, s.quiet_hours_start, s.quiet_hours_end
                               FROM employees e JOIN sites s ON s.id = e.site_id
                              WHERE e.id IN (${noOwn.map(() => '?').join(',')})
                                AND s.quiet_hours_start IS NOT NULL AND s.quiet_hours_end IS NOT NULL`,
                            noOwn
                        )) || [];
                    for (const s of sites) {
                        const at = NotificationService._releaseAt(s, now);
                        if (at) quiet.set(Number(s.empId ?? s.emp_id), at);
                    }
                } catch (_) {
                    /* site defaults unreadable → personal windows only */
                }
            }
            // gen_random_uuid() is core since PostgreSQL 13.
            const values = slice
                .map(() => "(?, ?, 'inapp', ?, ?, ?, ?, ?, gen_random_uuid(), ?, ?)")
                .join(',');
            const params = [];
            for (const uid of slice) {
                const at = quiet.get(uid) || null;
                params.push(
                    userType,
                    uid,
                    kind,
                    locale,
                    pl,
                    at ? 'snoozed' : 'queued',
                    at,
                    ref.refType,
                    ref.refId
                );
            }
            await db.run(
                `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, release_at,
                                            event_id, ref_type, ref_id) VALUES ${values}`,
                params
            );
            n += slice.length;
        }
        return n;
    }

    // ---- Measurement, preferences grid, catalogue page (migration 183) ----------

    /** A fresh event id (uuid v4), or null when the runtime has none. */
    static _newEventId() {
        try {
            return require('crypto').randomUUID();
        } catch (_) {
            return null;
        }
    }

    /**
     * The object a kind is about, read from WHITELISTED payload keys when the
     * emitter did not say it (args.refType / args.refId win). Identifiers only,
     * never free text.
     */
    static get KIND_REF() {
        return {
            'cycle.opened': { type: 'cycle', key: 'cycleId' },
            'cycle.reminder': { type: 'cycle', key: 'cycleId' },
            'cycle.escalation': { type: 'cycle', key: 'cycleId' },
            'cycle.team_reminder': { type: 'cycle', key: 'cycleId' },
            'cycle.closed': { type: 'cycle', key: 'cycleId' },
            'cert.expiry': { type: 'skill', key: 'skillId' },
            'cert.expiry.team': { type: 'skill', key: 'skillId' },
            // The development loop (4.0.0 port): the action to validate, the
            // proposal to decide, the completion whose level to decide.
            'idp.action_reported': { type: 'idp_action', key: 'actionId' },
            'idp.proposal_received': { type: 'dev_proposal', key: 'proposalId' },
            'lms.uplift_proposed': { type: 'lms_completion', key: 'completionId' },
        };
    }

    static _refOf(kind, payload, args) {
        const a = args || {};
        const idOk = (v) =>
            (Number.isInteger(v) && v > 0) ||
            (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v));
        if (typeof a.refType === 'string' && /^[a-z_]{1,32}$/.test(a.refType) && idOk(a.refId))
            return { refType: a.refType, refId: String(a.refId) };
        const m = NotificationService.KIND_REF[kind];
        const p = payload && typeof payload === 'object' ? payload : {};
        if (m && idOk(p[m.key])) return { refType: m.type, refId: String(p[m.key]) };
        return { refType: null, refId: null };
    }

    /**
     * Kinds whose « acted upon » is measured: a closing action calls
     * markActed() for them. For every other kind the figure is « not
     * measured », never 0 %.
     */
    static get ACTED_KINDS() {
        return [
            'cycle.opened',
            'cycle.reminder',
            'sa.changes_requested',
            'sa.reset_for_redo',
            'sa.submitted',
            'sa.review_reset',
            'cert.expiry',
            'succession.review_due',
            // The development loop (4.0.0 port, wave 4)
            'idp.action_due',
            'idp.action_reported',
            'idp.proposal_received',
            'lms.uplift_proposed',
        ];
    }

    /** Preference categories (the grid rows), in display order (catalogue). */
    static get CATEGORIES() {
        return catalogue.CATEGORIES;
    }

    /** Rows that are mandatory as a whole: greyed, cannot be switched off. */
    static get MANDATORY_CATEGORIES() {
        return catalogue.MANDATORY_CATEGORIES;
    }

    /** The grid row of a kind (a mandatory kind sits in its mandatory row). */
    static categoryOf(kind) {
        return catalogue.categoryOf(kind);
    }

    /** The person's settings row, or null when none / unreadable. */
    static async _settingsRow(userType, userId) {
        if (!userId) return null;
        try {
            const r = await db.get(
                `SELECT digest_cadence, email_locale, ics_enabled, digest_stepdown_at,
                        digest_stepdown_from, digest_streak_from
                   FROM notification_user_settings WHERE user_type = ? AND user_id = ?`,
                [userType, userId]
            );
            if (!r || typeof r !== 'object') return null;
            const pick = (a, b) => (r[a] !== undefined ? r[a] : r[b]);
            return {
                digestCadence: pick('digestCadence', 'digest_cadence') || null,
                emailLocale: pick('emailLocale', 'email_locale') || null,
                icsEnabled: pick('icsEnabled', 'ics_enabled') !== false,
                stepdownAt: pick('digestStepdownAt', 'digest_stepdown_at') || null,
                stepdownFrom: pick('digestStepdownFrom', 'digest_stepdown_from') || null,
                streakFrom: pick('digestStreakFrom', 'digest_streak_from') || null,
            };
        } catch (_) {
            return null;
        }
    }

    /**
     * The language of ONE recipient's mails: their own choice (Mon compte →
     * Notifications), else the site's mail language (mailDefaultLanguage).
     * For senders that compose a mail per recipient themselves.
     */
    static async recipientLang(userType, userId, fallback) {
        return require('../utils/emailTemplate').recipientLang(userType, userId, fallback);
    }

    /**
     * ONE language per mail, the recipient's when it can be honoured:
     *   - catalogue-worded mail (no title, intro, blocks…): the person's language;
     *   - `content: (B) => ({ title, intro, blocks, ctaLabel, ctaUrl, preheader })`
     *     — the emitter writes the mail for any language; B is
     *     emailTemplate.blocks(lang) for the person's language (else `fallback`);
     *   - `byLocale: { en: { title, … } }` — the emitter supplied that language;
     *   - otherwise the emitter wrote fixed text: its language is kept for the
     *     WHOLE mail, never a French body under English chrome.
     * `fallback` is the emitter's language or the site's (already resolved).
     */
    static _mailContent(content, settings, fallback) {
        const c = content || {};
        const nonEmpty = (v) => v != null && String(v).trim() !== '';
        const userLang = settings && settings.emailLocale ? settings.emailLocale : null;
        if (typeof c.content === 'function') {
            const lang = userLang || c.locale || fallback || 'fr';
            let built = {};
            try {
                built = c.content(require('../utils/emailTemplate').blocks(lang)) || {};
            } catch (_) {
                built = {};
            }
            return {
                title: built.title,
                intro: built.intro,
                blocks: built.blocks,
                ctaLabel: built.ctaLabel,
                ctaUrl: built.ctaUrl != null ? built.ctaUrl : c.ctaUrl,
                preheader: built.preheader,
                locale: lang,
            };
        }
        const explicit =
            nonEmpty(c.title) ||
            nonEmpty(c.intro) ||
            nonEmpty(c.ctaLabel) ||
            nonEmpty(c.preheader) ||
            (Array.isArray(c.blocks) && c.blocks.length > 0);
        let src = c;
        let locale = c.locale || fallback || null;
        if (userLang) {
            const alt = c.byLocale && typeof c.byLocale === 'object' ? c.byLocale[userLang] : null;
            if (alt && typeof alt === 'object') {
                src = { ...c, ...alt };
                locale = userLang;
            } else if (!explicit) {
                locale = userLang;
            }
        }
        return {
            title: src.title,
            intro: src.intro,
            blocks: src.blocks,
            ctaLabel: src.ctaLabel,
            ctaUrl: src.ctaUrl,
            preheader: src.preheader,
            locale,
        };
    }

    /**
     * Is e-mail ON for the kind's category? No row = the default (on). A
     * mandatory category is always on. Unreadable ⇒ the default.
     */
    static async _categoryAllowed(userType, userId, kind, channel = 'email') {
        const cat = NotificationService.categoryOf(kind);
        if (NotificationService.MANDATORY_CATEGORIES.includes(cat)) return true;
        if (channel !== 'email') return false;
        try {
            const r = await db.get(
                `SELECT enabled FROM notification_category_prefs
                  WHERE user_type = ? AND user_id = ? AND category = ? AND channel = 'email'`,
                [userType, userId, cat]
            );
            if (!r || typeof r.enabled !== 'boolean') return true;
            return r.enabled;
        } catch (_) {
            return true;
        }
    }

    /**
     * May this kind reach this person on this channel? In-app always; a
     * mandatory kind always; e-mail = the person's e-mail switch AND the
     * category switch. Any other channel: no.
     */
    static async channelAllowed({ userType, userId, kind, channel }) {
        if (channel === 'inapp') return true;
        if (NotificationService._isMandatory(kind)) return true;
        if (channel !== 'email') return false;
        if (!(await NotificationService._userEmailAllowed(userType, userId))) return false;
        return NotificationService._categoryAllowed(userType, userId, kind, 'email');
    }

    /**
     * The default summary cadence: daily, the cadence every install had before
     * migration 183, so an upgrade changes nothing until the person chooses
     * weekly or never.
     */
    static async defaultCadence() {
        return 'daily';
    }

    /** The effective summary cadence: the person's choice, else the default. */
    static async digestCadence(userType, userId) {
        const s = await NotificationService._settingsRow(userType, userId);
        if (s && ['daily', 'weekly', 'off'].includes(s.digestCadence)) return s.digestCadence;
        return NotificationService.defaultCadence(userType, userId);
    }

    /** Everything the « Mon compte → Notifications » page shows. */
    static async getPreferenceGrid({ userType, userId }) {
        const base = await NotificationService.getUserPrefs({ userType, userId });
        const settings = (await NotificationService._settingsRow(userType, userId)) || {};
        const dflt = await NotificationService.defaultCadence(userType, userId);
        let rows = [];
        try {
            rows =
                (await db.all(
                    `SELECT category, enabled FROM notification_category_prefs
                      WHERE user_type = ? AND user_id = ? AND channel = 'email'`,
                    [userType, userId]
                )) || [];
        } catch (_) {
            rows = [];
        }
        const off = new Set(rows.filter((r) => r.enabled === false).map((r) => r.category));
        const categories = NotificationService.CATEGORIES.map((key) => {
            const mandatory = NotificationService.MANDATORY_CATEGORIES.includes(key);
            return { key, mandatory, email: mandatory ? true : !off.has(key) };
        });
        let siteQuiet = null;
        const sq = await NotificationService._siteQuiet(userType, userId);
        if (sq) {
            const w = NotificationService._window(sq);
            const hm = (m) =>
                `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
            siteQuiet = { start: hm(w.start), end: hm(w.end) };
        }
        const valid = ['daily', 'weekly', 'off'].includes(settings.digestCadence);
        return {
            ...base,
            categories,
            digestCadence: valid ? settings.digestCadence : dflt,
            digestCadenceIsDefault: !valid,
            defaultCadence: dflt,
            emailLocale: settings.emailLocale || null,
            defaultLocale: await NotificationService._mailLang(null),
            icsEnabled: settings.icsEnabled !== false,
            stepdownAt: settings.stepdownAt || null,
            stepdownFrom: settings.stepdownFrom || null,
            siteQuiet,
        };
    }

    /**
     * Save the grid and the settings. Mandatory rows are never written (they
     * cannot be switched off), nor any category the catalogue does not know.
     * Changing the cadence restarts the unopened-summary count and clears a
     * pending step-down notice.
     */
    static async savePreferenceGrid({
        userType,
        userId,
        categories,
        digestCadence,
        emailLocale,
        icsEnabled,
    }) {
        // A Map (the controller) or a plain object; only the catalogue's
        // categories are ever read from it.
        const get = (k) => {
            if (categories instanceof Map) return categories.get(k);
            if (categories && typeof categories === 'object' && Object.hasOwn(categories, k))
                return categories[k];
            return null;
        };
        for (const key of NotificationService.CATEGORIES) {
            if (NotificationService.MANDATORY_CATEGORIES.includes(key)) continue;
            // A category the caller did not mention is left as it is (the
            // preferences form always sends every one of them).
            const c = get(key);
            if (!c || typeof c !== 'object') continue;
            await db.run(
                `INSERT INTO notification_category_prefs (user_type, user_id, category, channel, enabled, updated_at)
                 VALUES (?, ?, ?, 'email', ?, now())
                 ON CONFLICT (user_type, user_id, category, channel)
                 DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
                [userType, userId, key, c.email === true]
            );
        }
        const cadence = ['daily', 'weekly', 'off'].includes(digestCadence) ? digestCadence : null;
        const lang = ['fr', 'en'].includes(emailLocale) ? emailLocale : null;
        const before = await NotificationService._settingsRow(userType, userId);
        const changed = !before || (before.digestCadence || null) !== cadence;
        await db.run(
            `INSERT INTO notification_user_settings (user_type, user_id, digest_cadence, email_locale, ics_enabled,
                                                     digest_streak_from, updated_at)
             VALUES (?, ?, ?, ?, ?, now(), now())
             ON CONFLICT (user_type, user_id) DO UPDATE SET
               digest_cadence = EXCLUDED.digest_cadence,
               email_locale   = EXCLUDED.email_locale,
               ics_enabled    = EXCLUDED.ics_enabled,
               digest_streak_from   = CASE WHEN ? THEN now() ELSE notification_user_settings.digest_streak_from END,
               digest_stepdown_at   = CASE WHEN ? THEN NULL ELSE notification_user_settings.digest_stepdown_at END,
               digest_stepdown_from = CASE WHEN ? THEN NULL ELSE notification_user_settings.digest_stepdown_from END,
               updated_at = now()`,
            [userType, userId, cadence, lang, icsEnabled !== false, changed, changed, changed]
        );
        return true;
    }

    /** « Turn back on »: the cadence before the step-down, and a fresh count. */
    static async reactivateDigest({ userType, userId }) {
        const s = await NotificationService._settingsRow(userType, userId);
        if (!s || !s.stepdownFrom) return false;
        await db.run(
            `UPDATE notification_user_settings
                SET digest_cadence = digest_stepdown_from, digest_stepdown_at = NULL,
                    digest_stepdown_from = NULL, digest_streak_from = now(), updated_at = now()
              WHERE user_type = ? AND user_id = ? AND digest_stepdown_from IS NOT NULL`,
            [userType, userId]
        );
        return true;
    }

    /** How many summaries in a row left unopened slow the cadence down. */
    static get DIGEST_STEPDOWN_AFTER() {
        return 8;
    }

    /**
     * EIGHT summaries in a row with nothing opened since (no
     * /notifications/:id/go by the person after the summary went out) slow the
     * cadence down one notch: daily → weekly → off. The preferences page then
     * says so and offers to turn it back on. Only summaries recorded since
     * migration 183 count (event_id), and only those after the last step-down,
     * reactivation or cadence change.
     * → { steppedDown: true, from, to } | { steppedDown: false, unopened? }.
     */
    static async digestStepDown({ userType, userId, cadence }) {
        const current = cadence || (await NotificationService.digestCadence(userType, userId));
        if (current !== 'daily' && current !== 'weekly') return { steppedDown: false };
        const s = await NotificationService._settingsRow(userType, userId);
        let n = 0;
        try {
            const r = await db.get(
                `SELECT COUNT(*)::int AS c FROM notifications d
                  WHERE d.user_type = ? AND d.user_id = ? AND d.channel = 'email'
                    AND d.kind = 'digest.daily' AND d.state = 'sent' AND d.event_id IS NOT NULL
                    AND d.created_at > COALESCE(?::timestamptz, '-infinity'::timestamptz)
                    AND d.created_at > COALESCE((SELECT max(o.opened_at) FROM notifications o
                                                  WHERE o.user_type = d.user_type AND o.user_id = d.user_id
                                                    AND o.channel = 'inapp'), '-infinity'::timestamptz)`,
                [userType, userId, (s && s.streakFrom) || null]
            );
            n = Number(r && (r.c ?? r.count)) || 0;
        } catch (_) {
            return { steppedDown: false };
        }
        if (n < NotificationService.DIGEST_STEPDOWN_AFTER)
            return { steppedDown: false, unopened: n };
        const to = current === 'daily' ? 'weekly' : 'off';
        await db.run(
            `INSERT INTO notification_user_settings (user_type, user_id, digest_cadence, digest_stepdown_at,
                                                     digest_stepdown_from, digest_streak_from, updated_at)
             VALUES (?, ?, ?, now(), ?, now(), now())
             ON CONFLICT (user_type, user_id) DO UPDATE SET
               digest_cadence = EXCLUDED.digest_cadence,
               digest_stepdown_at = now(),
               digest_stepdown_from = COALESCE(notification_user_settings.digest_stepdown_from, EXCLUDED.digest_stepdown_from),
               digest_streak_from = now(),
               updated_at = now()`,
            [userType, userId, to, current]
        );
        return { steppedDown: true, from: current, to };
    }

    /**
     * The owner followed the notification's link (GET /notifications/:id/go).
     * First open only; scoped to the owner; never called by mark-all-read.
     */
    static async markOpened({ id, userType, userId }) {
        try {
            const r = await db.run(
                `UPDATE notifications SET opened_at = now()
                  WHERE id = ? AND user_type = ? AND user_id = ? AND channel = 'inapp'
                    AND opened_at IS NULL`,
                [Number(id), userType, userId]
            );
            return !!(r && r.changes > 0);
        } catch (_) {
            return false;
        }
    }

    /**
     * The action a notification asked for was DONE. Called by the business
     * services when they close it (self-assessment submitted, review decided,
     * certificate recorded, successor named):
     *
     *   markActed({ refType, refId })                       every open row about that object
     *   markActed({ refType, refId, userType, userId })     … of that person
     *   markActed({ userType, userId, kinds })              that person's open rows of those kinds
     *
     * Stamps acted_at on still-open rows of the last 90 days, every channel of
     * the event. Best-effort: never throws, runs in a savepoint (callers are
     * often inside a transaction). → number of rows stamped.
     */
    static async markActed({ refType, refId, userType, userId, kinds } = {}) {
        const where = ['acted_at IS NULL', "created_at >= now() - interval '90 days'"];
        const params = [];
        const hasRef =
            typeof refType === 'string' &&
            /^[a-z_]{1,32}$/.test(refType) &&
            refId != null &&
            String(refId) !== '';
        const ks = (Array.isArray(kinds) ? kinds : kinds ? [kinds] : [])
            .map(String)
            .filter((k) => catalogue.isDeclared(k))
            .slice(0, 20);
        const hasWho = (userType === 'admin' || userType === 'employee') && Number(userId) > 0;
        if (!hasRef && !(hasWho && ks.length)) return 0;
        if (hasRef) {
            where.push('ref_type = ?', 'ref_id = ?');
            params.push(refType, String(refId).slice(0, 64));
        }
        if (hasWho) {
            where.push('user_type = ?', 'user_id = ?');
            params.push(userType, Number(userId));
        }
        if (ks.length) {
            where.push(`kind IN (${ks.map(() => '?').join(',')})`);
            params.push(...ks);
        }
        try {
            const r = await NotificationService._bestEffort(() =>
                db.run(
                    `UPDATE notifications SET acted_at = now() WHERE ${where.join(' AND ')}`,
                    params
                )
            );
            return (r && r.changes) || 0;
        } catch (_) {
            return 0;
        }
    }

    /** markActed() for a closing hook: fire-and-forget, never throws, never blocks. */
    static actedQuietly(args) {
        return Promise.resolve()
            .then(() => NotificationService.markActed(args))
            .catch(() => 0);
    }

    /** Minimum population before a ratio or a median is shown. */
    static get METRICS_MIN_N() {
        return 5;
    }

    /**
     * The effectiveness of each kind over `days` (default 30): notified,
     * e-mails sent, opened %, acted %, median time to action, e-mail opt-outs
     * of its category, « rarely opened » flag. Only measurable rows (event_id,
     * migration 183) count; people who left, were voided or erased are out of
     * every figure. A ratio over fewer than 5, or « acted » for a kind no
     * closing action records, is NOT a measurement: null and the reason, never
     * 0 %. Aggregates only: no person is named.
     */
    static async metrics({ days = 30 } = {}) {
        const d = Math.min(Math.max(Math.floor(Number(days) || 30), 1), 365);
        const active = `NOT EXISTS (SELECT 1 FROM employees e
                                     WHERE n.user_type = 'employee' AND e.id = n.user_id
                                       AND (e.is_active = false OR e.cancelled_at IS NOT NULL OR e.erased_at IS NOT NULL))`;
        const rows =
            (await db.all(
                // A CTE: the SQL compatibility layer leaves WITH statements alone.
                `WITH per_kind AS (
                 SELECT n.kind,
                        COUNT(*) FILTER (WHERE n.channel = 'inapp')::int AS sent,
                        COUNT(*) FILTER (WHERE n.channel = 'email' AND n.email_status = 'sent')::int AS emailed,
                        COUNT(*) FILTER (WHERE n.channel = 'inapp' AND n.opened_at IS NOT NULL)::int AS opened,
                        COUNT(*) FILTER (WHERE n.channel = 'inapp' AND n.acted_at IS NOT NULL)::int AS acted,
                        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (n.acted_at - n.created_at)))
                            FILTER (WHERE n.channel = 'inapp' AND n.acted_at IS NOT NULL) AS median_s
                   FROM notifications n
                  WHERE n.event_id IS NOT NULL
                    AND n.created_at >= now() - (? || ' days')::interval
                    AND ${active}
                  GROUP BY n.kind)
                 SELECT * FROM per_kind ORDER BY kind`,
                [String(d)]
            )) || [];
        const optOut = new Map();
        let globalOptOut = null;
        let stepDowns = null;
        try {
            const optRows =
                (await db.all(
                    `SELECT p.category, COUNT(*)::int AS c FROM notification_category_prefs p
                      WHERE p.channel = 'email' AND p.enabled = false
                        AND NOT EXISTS (SELECT 1 FROM employees e
                                         WHERE p.user_type = 'employee' AND e.id = p.user_id
                                           AND (e.is_active = false OR e.cancelled_at IS NOT NULL OR e.erased_at IS NOT NULL))
                      GROUP BY p.category`
                )) || [];
            for (const r of optRows) optOut.set(r.category, Number(r.c) || 0);
            const g = await db.get(
                `SELECT COUNT(*)::int AS c FROM notification_preferences p
                  WHERE p.kind = '__all__' AND p.channel = 'email' AND p.enabled = false
                    AND NOT EXISTS (SELECT 1 FROM employees e
                                     WHERE p.user_type::text = 'employee' AND e.id = p.user_id
                                       AND (e.is_active = false OR e.cancelled_at IS NOT NULL OR e.erased_at IS NOT NULL))`
            );
            globalOptOut = Number(g && g.c) || 0;
            const s = await db.get(
                `SELECT COUNT(*)::int AS c FROM notification_user_settings WHERE digest_stepdown_at IS NOT NULL`
            );
            stepDowns = Number(s && s.c) || 0;
        } catch (_) {
            /* the per-kind table still stands */
        }
        const MIN = NotificationService.METRICS_MIN_N;
        const acted = new Set(NotificationService.ACTED_KINDS);
        const kinds = rows.map((r) => {
            const sent = Number(r.sent) || 0;
            const opened = Number(r.opened) || 0;
            const act = Number(r.acted) || 0;
            const mandatory = NotificationService._isMandatory(r.kind);
            const category = NotificationService.categoryOf(r.kind);
            const openedPct = sent >= MIN ? (opened / sent) * 100 : null;
            let actedPct = null;
            let actedReason = null;
            if (!acted.has(r.kind)) actedReason = 'no_hook';
            else if (sent < MIN) actedReason = 'small';
            else actedPct = (act / sent) * 100;
            const med = r.medianS ?? r.median_s;
            return {
                kind: r.kind,
                category,
                mandatory,
                sent,
                emailed: Number(r.emailed) || 0,
                opened,
                openedPct,
                openedReason: openedPct == null ? 'small' : null,
                acted: act,
                actedPct,
                actedReason,
                medianHours:
                    acted.has(r.kind) && act >= MIN && med != null && Number.isFinite(Number(med))
                        ? Number(med) / 3600
                        : null,
                medianReason: !acted.has(r.kind) ? 'no_hook' : act >= MIN ? null : 'small',
                optOuts: mandatory ? null : optOut.get(category) || 0,
                lowOpen: !mandatory && openedPct != null && openedPct < 20,
            };
        });
        return { days: d, kinds, globalOptOut, stepDowns, minN: MIN };
    }

    /**
     * Do the reminders WORK? (4.0.0 port, wave 7.) Read from the exactly-once
     * ledgers (reminder_log, nudge_log) and from what the person then DID, not
     * from notifications.acted_at, over `days` (default 90), per family:
     *   campaign     the person's ladder (D+3, D-7, D-2) → the self-assessment
     *                of that campaign started or submitted within 7 days;
     *   learning     a course assigned and not started → that enrolment
     *                started within 14 days;
     *   development  the owner's own due actions → one of their plan actions
     *                reported done or completed within 14 days.
     * People who left, were voided or erased are out. Fewer than METRICS_MIN_N
     * reminded: no rate (`reason: 'small'`), never 0 %. A ledger that cannot be
     * read: `reason: 'unavailable'`, counts null. Aggregates only, no name.
     * @returns {Promise<{days:number, minN:number, rows:Array<{key, reminded, acted, rate, reason}>}>}
     */
    static async reminderEffectiveness({ days = 90 } = {}) {
        const d = Math.min(Math.max(Math.floor(Number(days) || 90), 7), 365);
        const MIN = NotificationService.METRICS_MIN_N;
        const live = (col) =>
            `JOIN employees e ON e.id = ${col} AND e.is_active AND e.cancelled_at IS NULL AND e.erased_at IS NULL`;
        const families = [
            {
                key: 'campaign',
                sql: `WITH r AS (
                        SELECT rl.target_id AS emp, rl.ref_id AS cyc, rl.sent_at AS at
                          FROM reminder_log rl
                         WHERE rl.kind = ? AND rl.target_type = 'employee'
                           AND rl.sent_at >= now() - (? || ' days')::interval
                        UNION ALL
                        SELECT nl.target_id, nl.cycle_id, nl.sent_at
                          FROM nudge_log nl
                         WHERE nl.target_type = 'employee' AND nl.kind IN ('reminder_7', 'reminder_2')
                           AND nl.sent_at >= now() - (? || ' days')::interval)
                      SELECT COUNT(*)::int AS reminded,
                             COUNT(*) FILTER (WHERE EXISTS (
                                 SELECT 1 FROM cycle_participants p
                                  WHERE p.cycle_id = r.cyc AND p.employee_id = r.emp
                                    AND ((p.started_at > r.at AND p.started_at <= r.at + interval '7 days')
                                      OR (p.submitted_at > r.at AND p.submitted_at <= r.at + interval '7 days')))
                               OR EXISTS (
                                 SELECT 1 FROM self_assessments sa
                                  WHERE sa.cycle_id = r.cyc AND sa.employee_id = r.emp
                                    AND sa.self_rated_level IS NOT NULL
                                    AND sa.created_at > r.at AND sa.created_at <= r.at + interval '7 days'))::int AS acted
                        FROM r ${live('r.emp')}`,
                // the D+3 ledger key of cycle-nudge (bound: the enum guard reads literals)
                params: ['cycle.not_started', String(d), String(d)],
            },
            {
                key: 'learning',
                sql: `SELECT COUNT(*)::int AS reminded,
                             COUNT(*) FILTER (WHERE EXISTS (
                                 SELECT 1 FROM lms_enrollments le
                                  WHERE le.id = rl.ref_id AND le.employee_id = rl.target_id
                                    AND le.started_at > rl.sent_at
                                    AND le.started_at <= rl.sent_at + interval '14 days'))::int AS acted
                        FROM reminder_log rl ${live('rl.target_id')}
                       WHERE rl.kind = 'lms.due' AND rl.target_type = 'employee'
                         AND rl.sent_at >= now() - (? || ' days')::interval`,
                params: [String(d)],
            },
            {
                key: 'development',
                sql: `SELECT COUNT(*)::int AS reminded,
                             COUNT(*) FILTER (WHERE EXISTS (
                                 SELECT 1 FROM idp_actions a JOIN idp_plans p ON p.id = a.idp_id
                                  WHERE p.employee_id = rl.target_id
                                    AND ((a.reported_done_at > rl.sent_at
                                          AND a.reported_done_at <= rl.sent_at + interval '14 days')
                                      OR (a.completed_at > rl.sent_at
                                          AND a.completed_at <= rl.sent_at + interval '14 days'))))::int AS acted
                        FROM reminder_log rl ${live('rl.target_id')}
                       WHERE rl.kind = 'idp.action_due' AND rl.target_type = 'employee'
                         AND rl.sent_at >= now() - (? || ' days')::interval`,
                params: [String(d)],
            },
        ];
        const rows = [];
        for (const f of families) {
            let r = null;
            try {
                r = await db.get(f.sql, f.params);
            } catch (_) {
                rows.push({
                    key: f.key,
                    reminded: null,
                    acted: null,
                    rate: null,
                    reason: 'unavailable',
                });
                continue;
            }
            const reminded = Number(r && r.reminded) || 0;
            const acted = Number(r && r.acted) || 0;
            const enough = reminded >= MIN;
            rows.push({
                key: f.key,
                reminded,
                acted: enough ? acted : null,
                rate: enough ? (100 * acted) / reminded : null,
                reason: enough ? null : 'small',
            });
        }
        return { days: d, minN: MIN, rows };
    }

    /**
     * The catalogue page: one row per declared kind — category, e-mail tier,
     * mandatory flag, severity, webhook rule, title and subject in the reader's
     * language, 30-day in-app volume (null when it could not be read, never 0).
     */
    static async catalogueRows({ days = 30, lang = 'fr' } = {}) {
        const l = NotificationService._lang(lang);
        const vol = new Map();
        let volumesKnown = false;
        try {
            const rows =
                (await db.all(
                    `SELECT kind, COUNT(*)::int AS c FROM notifications
                      WHERE channel = 'inapp' AND created_at >= now() - (? || ' days')::interval
                      GROUP BY kind`,
                    [String(Math.min(Math.max(Number(days) || 30, 1), 365))]
                )) || [];
            for (const r of rows) vol.set(r.kind, Number(r.c) || 0);
            volumesKnown = true;
        } catch (_) {
            /* volumes unknown: shown as « — », never 0 */
        }
        return catalogue.kinds().map((kind) => {
            const d = catalogue.describe(kind) || {};
            return {
                kind,
                title: (d.title && d.title[l]) || kind,
                subject: (d.subject && d.subject[l]) || null,
                family: kind.split('.')[0],
                category: d.category || 'other',
                mandatory: !!d.mandatory,
                tier: d.tier || 'immediate',
                severity: d.severity || 'info',
                webhook: d.webhook || 'never',
                mailOnly: !!d.mailOnly,
                volume: d.mailOnly ? null : volumesKnown ? vol.get(kind) || 0 : null,
            };
        });
    }

    /** Every active site and its default quiet hours (catalogue page). */
    static async siteQuietHours() {
        try {
            const rows =
                (await db.all(
                    `SELECT id, name, quiet_hours_start, quiet_hours_end FROM sites
                      WHERE is_active = true ORDER BY name`
                )) || [];
            // PG returns TIME as 'HH:MM:SS'; <input type="time"> round-trips 'HH:MM'.
            const hm = (v) => {
                const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '').slice(0, 8));
                return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : '';
            };
            return rows.map((r) => ({
                id: Number(r.id),
                name: r.name,
                start: hm(r.quietHoursStart ?? r.quiet_hours_start),
                end: hm(r.quietHoursEnd ?? r.quiet_hours_end),
            }));
        } catch (_) {
            return [];
        }
    }

    /** Set (or clear, with both ends empty) a site's default quiet hours. */
    static async setSiteQuietHours({ siteId, start, end }) {
        const r = await db.run(
            `UPDATE sites SET quiet_hours_start = ?, quiet_hours_end = ?, updated_at = now() WHERE id = ?`,
            [start || null, end || null, Number(siteId)]
        );
        return !!(r && r.changes > 0);
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
        const { recipientName, recipient, ...rest } = spec || {};
        // `recipient` ({ userType, userId }) honours that person's .ics switch
        // and, for a catalogue-worded mail, their e-mail language.
        let icsEnabled = true;
        let locale = rest.locale;
        if (recipient && recipient.userId) {
            const s = await NotificationService._settingsRow(recipient.userType, recipient.userId);
            icsEnabled = !s || s.icsEnabled !== false;
            locale = NotificationService._mailContent(rest, s, rest.locale).locale;
        }
        locale = await NotificationService._mailLang(locale);
        return NotificationService._compose(
            { ...rest, locale },
            { brand, recipientName, icsEnabled }
        );
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
        if (
            !mandatory &&
            !(await NotificationService._categoryAllowed(userType, userId, row.kind, 'email'))
        )
            return { sent: false, skipped: 'category_opt_out' };
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
        return catalogue.isDigestible(kind) && !NotificationService._isSummaryKind(kind);
    }

    /**
     * A summary is never a line of another summary (4.0.0 port, wave 7): the
     * « What changed » points, the department brief and digests and the manager
     * and planning digests compose their own message, and one written in the
     * app only (a weekly brief, an employee's quiet point) must not come back
     * by e-mail inside the daily digest.
     */
    static _isSummaryKind(kind) {
        const k = String(kind || '');
        return (
            k.startsWith('digest.') ||
            k === 'dept_brief' ||
            k === 'dept_digest' ||
            k === 'manager_digest' ||
            k === 'planning.digest'
        );
    }

    /** Deliver one email row that was held back by quiet hours (boolean, kept for callers). */
    static async _sendDeferredEmail(row) {
        const r = await NotificationService._deliverStored(row);
        return !!(r && r.sent);
    }

    /**
     * The campaign-deadline calendar of a summary: the first cycle.opened line
     * carrying cycleId and closesOn → { type: 'campaign_deadline', date, uid }
     * (the same uid as the D-7 / D-2 reminders, so a calendar updates ONE
     * event). null when there is none. Dates and ids only, never caller text.
     */
    static _digestCalendar(rows) {
        for (const r of rows || []) {
            if (!r || r.kind !== 'cycle.opened') continue;
            let p = r.payload;
            if (typeof p === 'string') {
                try {
                    p = JSON.parse(p);
                } catch (_) {
                    p = null;
                }
            }
            const id = p && Number(p.cycleId);
            if (!id || !Number.isInteger(id) || id <= 0 || !p.closesOn) continue;
            const raw = String(p.closesOn).slice(0, 40);
            let date = null;
            if (raw.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(raw)) date = raw;
            else {
                const d = new Date(raw);
                if (!Number.isNaN(d.getTime()))
                    date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
            if (date) return { type: 'campaign_deadline', date, uid: `cycle-${id}-deadline` };
        }
        return null;
    }

    /**
     * Build + send ONE branded rollup email of a user's NEW in-app notifications
     * — the "no mailbox invasion" batching lever (many events → one email).
     *
     * The lines are the window's unread items (the last 24 hours, or the last
     * 7 days for a weekly summary: `sinceHours: 168`) that are (a) not tier
     * 'none' — a kind that is never e-mailed is never named in a digest either
     * — and (b) not already e-mailed on their own or listed in an earlier
     * digest; then one line « N actions toujours en attente » for what is older
     * and still unread. No new item ⇒ no mail at all. A person who has left is
     * not written to. Gated by the `digest` email category and the person's own
     * switch. The subject never carries the count.
     *
     * Each line goes through /notifications/:id/go, which records that the
     * person opened it and redirects to the same page: that is how a summary
     * nobody reads is told from one that is read (no tracking pixel). The
     * summary itself is recorded as an e-mail row (ids of its lines only), which
     * the step-down counts. A campaign launch in the summary carries the
     * deadline .ics unless the person switched .ics off.
     */
    static async sendDigest({ userType, userId, locale, sinceHours = 24 }) {
        const EmailService = require('./EmailService');
        if (!(await EmailService.isCategoryEnabled('digest'))) return { skipped: 'digest_off' };
        // The per-user opt-out governs the digest FIRST. It is the one email a
        // recipient is most likely to want stopped.
        if (!(await NotificationService._userEmailAllowed(userType, userId)))
            return { skipped: 'user_opt_out' };
        const weekly = Number(sinceHours) === 168;
        const windowH = weekly ? 168 : 24;
        const rows = await NotificationService.listInApp({
            userType,
            userId,
            limit: 100,
            unreadOnly: true,
            sinceHours: 24 * (weekly ? 7 : 1),
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
        // The person's e-mail language, else the caller's, else the site's.
        const settings = await NotificationService._settingsRow(userType, userId);
        const lang = await NotificationService._mailLang(
            (settings && settings.emailLocale) || locale
        );
        const D = NotificationService.DIGEST_TEXT[lang];
        // `withReason: false` — no reason, comment or rating leaves the app by
        // e-mail. The reason stays readable in the notification centre, behind
        // authentication, where clearance is enforced.
        const items = fresh.map((r) => NotificationService.present(r, lang, { withReason: false }));
        const shown = items.slice(0, 20);
        const blocks = [
            {
                type: 'links',
                items: shown.map((i) => ({
                    text: i.title,
                    href: i.id > 0 ? `/notifications/${i.id}/go` : i.link,
                })),
            },
        ];
        if (items.length > shown.length)
            blocks.push({ type: 'p', text: D.more(items.length - shown.length) });
        const outstanding = await NotificationService._outstandingCount(userType, userId, windowH);
        if (outstanding > 0)
            blocks.push({
                type: 'links',
                items: [{ text: D.pending(outstanding), href: '/notifications' }],
            });
        const rendered = NotificationService._compose(
            {
                kind: 'digest.daily',
                title: weekly ? D.titleWeek(items.length) : D.title(items.length),
                intro: weekly ? D.leadWeek : D.lead,
                blocks,
                ctaLabel: D.cta,
                ctaUrl: '/notifications',
                locale: lang,
                mandatory: false,
                severity: 'info',
                calendar: NotificationService._digestCalendar(fresh),
            },
            {
                brand,
                recipientName: recipient.name,
                icsEnabled: !settings || settings.icsEnabled !== false,
            }
        );
        const send = await EmailService.send({
            to: recipient.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            attachments: NotificationService._attachmentsOrNone(rendered.attachments),
            headers: rendered.headers,
        });
        // The summary itself is recorded: the delivery audit, and what the
        // step-down counts. The ids of its lines only, no text.
        await NotificationService._recordEmail({
            userType,
            userId,
            kind: 'digest.daily',
            locale: lang,
            payload: {
                ids: fresh
                    .map((r) => Number(r.id))
                    .filter(Boolean)
                    .slice(0, 100),
                hours: windowH,
            },
            state: send.sent ? 'sent' : 'failed',
            emailStatus: send.sent ? 'sent' : send.error ? 'abandoned' : 'skipped',
            attempts: 1,
            lastError: send.sent ? null : send.error || send.skipped || null,
            eventId: NotificationService._newEventId(),
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
    static async _outstandingCount(userType, userId, hours = 24) {
        const h = Number(hours) === 168 ? 168 : 24;
        try {
            const rows =
                (await db.all(
                    `SELECT kind, COUNT(*)::int AS c FROM notifications
                      WHERE user_type = ? AND user_id = ? AND channel = 'inapp' AND read_at IS NULL
                        AND ${NotificationService.VISIBLE_SQL}
                        AND created_at < now() - interval '${h} hours'
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
                titleWeek: (n) =>
                    n === 1
                        ? '1 nouveauté pour vous cette semaine'
                        : `${num(n, 'fr')} nouveautés pour vous cette semaine`,
                lead: 'Voici ce qui est arrivé depuis hier.',
                leadWeek: 'Voici ce qui est arrivé ces sept derniers jours.',
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
                titleWeek: (n) =>
                    n === 1
                        ? '1 new item for you this week'
                        : `${num(n, 'en')} new items for you this week`,
                lead: 'Here is what arrived since yesterday.',
                leadWeek: 'Here is what arrived over the last seven days.',
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
