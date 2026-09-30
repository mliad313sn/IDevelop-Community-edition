'use strict';

const db = require('../config/database');

/**
 *   NotificationService — write to notifications, respect per-user
 *   preferences and quiet hours.  In-app channel always-on; email
 *   delivery is a Phase-7 add (SMTP) — for now we just mark sent.
 */
class NotificationService {
    static async enqueue({ userType, userId, kind, channel, locale, payload }) {
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
                typeof payload === 'string' ? payload : JSON.stringify(payload),
                state,
                releaseAt,
            ]
        );
        return { state, releaseAt: releaseAt || null };
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
     * and, when email is enabled for the event's domain, sends an email to the
     * recipient. Best-effort: never throws into the calling business logic.
     *
     * @param {object} o
     * @param {'admin'|'employee'} o.userType  recipient type
     * @param {number} o.userId                recipient id (admins.id / employees.id)
     * @param {string} o.kind                  event kind, e.g. 'sa.approved'
     * @param {string} [o.category]            email domain: workflow|validation|talent|lifecycle|coaching|auth
     * @param {string} [o.locale]
     * @param {object} [o.payload]             contextual data for the message
     * @param {string} [o.subject]             explicit subject (else derived from kind)
     * @param {string} [o.html]                explicit HTML body (else derived from kind+payload)
     * @param {string} [o.text]                explicit text body
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
            return { inapp: 'error', email: 'error', error: e && e.message };
        }
    }

    static async _notify({
        userType,
        userId,
        kind,
        category,
        locale,
        payload,
        subject,
        html,
        text,
    }) {
        const result = { inapp: null, email: null };

        // 0) Fan the event out to any external webhook subscribers (best-effort,
        //    non-blocking) — makes the platform event-driven for integration.
        try {
            require('./WebhookService').emit(kind, { userType, userId, category, payload });
        } catch (_) {
            /* never block */
        }

        // 1) Always record the in-app notification (drives the digest UI).
        try {
            const r = await NotificationService.enqueue({
                userType,
                userId,
                kind,
                channel: 'inapp',
                locale,
                payload,
            });
            result.inapp = r && (r.state || r.skipped) ? r.state || r.skipped : 'queued';
        } catch (e) {
            result.inapp = 'error';
        }

        // 2) Email channel — data-driven policy first, then master switch + per-domain
        //    toggle. Policy tiers: 'none' never emails; 'digest' defers to the daily
        //    digest (in-app only now → no per-event inbox spam); 'immediate' (or an
        //    unlisted kind) falls through to category gating and sends now.
        try {
            const tier = NotificationService.KIND_POLICY[kind];
            if (tier === 'none') {
                result.email = 'policy_none';
                return result;
            }
            if (tier === 'digest') {
                result.email = 'digest_deferred';
                return result;
            }
            // Per-user opt-out: the recipient can switch OFF all notification email
            // from their preferences (they still get everything in-app).
            if (!(await NotificationService._userEmailAllowed(userType, userId))) {
                result.email = 'user_opt_out';
                return result;
            }
            const EmailService = require('./EmailService');
            if (!(await EmailService.isCategoryEnabled(category))) {
                result.email = 'disabled';
                return result;
            }
            const recipient = await NotificationService._resolveRecipient(userType, userId);
            if (!recipient.email) {
                result.email = 'no_address';
                return result;
            }
            // Quiet hours apply to EMAIL too — that is the whole point of the
            // promise in the preferences UI. An immediate-tier mail raised at
            // 03:00 is written as a deferred email row and actually sent by the
            // release tick once the window ends, rather than waking the
            // recipient now (or, as before, ignoring their setting entirely).
            const releaseAt = NotificationService._releaseAt(
                await NotificationService._quietPref(userType, userId)
            );
            if (releaseAt) {
                try {
                    // Render NOW and park the result on the email-channel row:
                    // several call sites (cert-expiry, coverage-check, cycle-nudge)
                    // pass their own subject/body, and re-deriving it hours later
                    // from the kind alone would quietly downgrade those messages.
                    // This is the delivery-audit row, not the in-app inbox row —
                    // the inbox payload written in step 1 is untouched.
                    const brandNow = await NotificationService._brand();
                    const pending = NotificationService._render({
                        kind,
                        payload,
                        subject,
                        html,
                        text,
                        brand: brandNow,
                        recipientName: recipient.name,
                        locale,
                    });
                    await db.run(
                        `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, release_at)
                         VALUES (?, ?, 'email', ?, ?, ?, 'snoozed', ?)`,
                        [
                            userType,
                            userId,
                            kind,
                            locale || 'fr',
                            JSON.stringify({
                                ...(payload && typeof payload === 'object' ? payload : {}),
                                [NotificationService.PENDING_EMAIL_KEY]: pending,
                            }),
                            releaseAt,
                        ]
                    );
                    result.email = 'quiet_deferred';
                } catch {
                    result.email = 'error';
                }
                return result;
            }
            const brand = await NotificationService._brand();
            const rendered = NotificationService._render({
                kind,
                payload,
                subject,
                html,
                text,
                brand,
                recipientName: recipient.name,
                locale,
            });
            const sendResult = await EmailService.send({
                to: recipient.email,
                subject: rendered.subject,
                html: rendered.html,
                text: rendered.text,
            });
            const state = sendResult.sent ? 'sent' : 'failed';
            // Record the email-channel notification with its final state.
            try {
                await db.run(
                    `INSERT INTO notifications (user_type, user_id, channel, kind, locale, payload, state, sent_at)
                     VALUES (?, ?, 'email', ?, ?, ?, ?, ${sendResult.sent ? 'now()' : 'NULL'})`,
                    [userType, userId, kind, locale || 'fr', JSON.stringify(payload || {}), state]
                );
            } catch {
                /* notification audit is best-effort */
            }
            result.email = sendResult.sent ? 'sent' : sendResult.skipped || 'failed';
        } catch (e) {
            result.email = 'error';
        }
        return result;
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
        if (!link) return null;
        if (/^https?:\/\//i.test(link)) return link;
        const base = require('../utils/emailTemplate').baseUrl();
        const path = String(link).startsWith('/') ? link : `/${link}`;
        return base ? `${base}${path}` : path;
    }

    // ---- In-app notification centre (reads the `notifications` inbox) ----------
    // Recipient identity: employees/managers → ('employee', employees.id);
    // admins/superadmins → ('admin', admins.id). Only the 'inapp' channel rows are
    // the user-facing inbox (the 'email' rows are a delivery audit).
    /**
     * `sinceHours` bounds the window (default: unbounded, the inbox behaviour).
     * The daily digest passes 24 — see sendDigest.
     */
    static async listInApp({
        userType,
        userId,
        limit = 20,
        unreadOnly = false,
        sinceHours = null,
    }) {
        const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const hours = Number(sinceHours) > 0 ? Math.floor(Number(sinceHours)) : null;
        return db.all(
            `SELECT id, kind, payload, state, locale, read_at, created_at
               FROM notifications
              WHERE user_type = ? AND user_id = ? AND channel = 'inapp'
                    AND ${NotificationService.VISIBLE_SQL}
                    ${unreadOnly ? 'AND read_at IS NULL' : ''}
                    ${hours ? `AND created_at >= now() - interval '${hours} hours'` : ''}
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
     * Resolve a recipient's { email, name } for a courteous, personalised email.
     * name → employee first name / admin display name (best-effort; '' when unknown).
     */
    static async _resolveRecipient(userType, userId) {
        if (!userId) return { email: null, name: '' };
        try {
            if (userType === 'admin') {
                const row = await db.get('SELECT email, username FROM admins WHERE id = ?', [
                    userId,
                ]);
                return {
                    email: row && row.email ? row.email : null,
                    name: (row && (row.firstName || row.username)) || '',
                };
            }
            const row = await db.get('SELECT email, first_name FROM employees WHERE id = ?', [
                userId,
            ]);
            return {
                email: row && row.email ? row.email : null,
                name: (row && (row.firstName || row.first_name)) || '',
            };
        } catch {
            return { email: null, name: '' };
        }
    }

    /** Human-readable subject lines per event kind. */
    static get KIND_LABELS() {
        return {
            // 3.23.21 safety-competency gate transitions
            'safety.blocked': 'Your safety clearance is blocked',
            'safety.expiring': 'Your safety clearance is expiring soon',
            'safety.blocked.team': 'A team member’s safety clearance is blocked',
            'safety.expiring.team': 'A team member’s safety clearance is expiring soon',
            'sa.submitted': 'Self-assessment submitted',
            'sa.changes_requested': 'Changes requested on your self-assessment',
            'sa.approved': 'Your self-assessment was approved',
            'sa.rejected': 'Your self-assessment was rejected',
            'sa.manager_validated': 'Your assessment was validated by management',
            //  / M-05 — the five kinds shipped by the cancellation and
            // request-for-change work with NO catalogue entry at all.
            'sa.cancelled': 'A self-assessment was cancelled',
            'sa.change_request_raised': 'A request for change awaits your decision',
            // the SUBJECT of a request raised by someone else was told
            // nothing at all; only the decider was written to.
            'sa.change_request_raised_on_me': 'A request for change was raised on your assessment',
            'sa.change_request_granted': 'A request for change was granted',
            'sa.change_request_refused': 'A request for change was refused',
            'talent.task.created': 'A follow-up task is assigned to you',
            // Same class as the five above, found by sweeping every kind emitted
            // in src/ and every kind already stored in `notifications`:
            // 'certification.revoked' is raised by CertificationService:187 and
            // had no entry anywhere; 'review.due' has no emitter left but one row
            // still sits in an inbox (notification #1, admin:1) and rendered as
            // its own slug.
            'certification.revoked': 'A certification was revoked',
            'review.due': 'A review is due',
            'review.completed': 'A supervisor review was completed',
            'mc.submitted': 'An action awaits your approval',
            'mc.approved': 'Your submitted action was approved',
            'mc.rejected': 'Your submitted action was rejected',
            'pip.created': 'A Performance Improvement Plan was created',
            'pip.activated': 'Your Performance Improvement Plan is now active',
            'pip.closed': 'A Performance Improvement Plan was closed',
            'idp.created': 'An Individual Development Plan was created',
            'idp.activated': 'Your Individual Development Plan is now active',
            'coaching.created': 'A coaching plan was created',
            'coaching.validated': 'A coaching plan was completed',
            'feedback360.nominate': 'Choose who gives you 360° feedback',
            'feedback360.approve': '360° feedback nominations to approve',
            'feedback360.invited': 'You are asked for 360° feedback',
            'feedback360.reminder': 'A 360° feedback questionnaire is waiting for you',
            'feedback360.closed': 'A 360° feedback report is ready to release',
            'feedback360.released': 'Your 360° feedback report is available',
            'oneonone.topic_added': 'A topic was added to your next one-to-one',
            'ninebox.submitted': 'A 9-box placement was submitted for review',
            'ninebox.approved': 'A 9-box placement was approved',
            'dispute.opened': 'A rating dispute was opened',
            'dispute.escalated': 'A dispute was escalated',
            'dispute.resolved': 'A dispute was resolved',
            'lifecycle.joiner': 'Welcome — your account is ready',
            'lifecycle.mover': 'Your role assignment has changed',
            'cycle.opened': 'An assessment cycle is now open',
            'cycle.closed': 'An assessment cycle has closed',
            'admin.created': 'Your administrator account was created',
        };
    }

    /**
     * Per-kind display metadata for the in-app centre: an icon and a FALLBACK
     * deep link used only when the stored payload has no explicit `link`. Wiring
     * a `link` into the notify payload at the event site is always preferred
     * (it can be id-specific); this map keeps older/link-less rows still clickable.
     */
    static get KIND_META() {
        // `title` carries BOTH languages ({ fr, en }); resolve at render time via
        // NotificationService._localizeTitle(meta.title, locale). FR is primary —
        // it is the fallback whenever a locale/translation is missing.
        return {
            'sa.submitted': {
                icon: 'fa-clipboard-check',
                link: '/supervisor/self-assessment-reviews',
                title: { fr: 'Auto-évaluation à réviser', en: 'Self-assessment to review' },
            },
            'sa.changes_requested': {
                icon: 'fa-pen-to-square',
                link: '/employee/self-assessment',
                title: {
                    fr: 'Modifications demandées sur votre auto-évaluation',
                    en: 'Changes requested on your self-assessment',
                },
            },
            // The three DECISION notifications land on the review page, not on the
            // status list: a decision is only useful next to the level that was
            // retained and the reason given for it. /employee/assessment-status
            // answers "where is my file"; /employee/supervisor-reviews answers
            // "what was decided about me, and why".
            'sa.approved': {
                icon: 'fa-circle-check',
                link: '/employee/supervisor-reviews',
                title: {
                    fr: 'Votre auto-évaluation a été approuvée',
                    en: 'Your self-assessment was approved',
                },
            },
            'sa.rejected': {
                icon: 'fa-circle-xmark',
                link: '/employee/supervisor-reviews',
                title: {
                    fr: 'Votre auto-évaluation a été rejetée',
                    en: 'Your self-assessment was rejected',
                },
            },
            'sa.manager_validated': {
                icon: 'fa-clipboard-check',
                link: '/employee/supervisor-reviews',
                title: {
                    fr: 'Votre évaluation a été validée par le management',
                    en: 'Your assessment was validated by management',
                },
            },
            // ----  / M-05 — les CINQ `kind` livrés sans entrée de catalogue.
            //      Mesuré avant correction : `present` retombait sur `n.kind`, donc
            //      le centre de notifications et la cloche affichaient le slug technique
            //      « sa.cancelled », « sa.change_request_raised »… À L'IDENTIQUE en
            //      français et en anglais — absence de libellé, pas trou de traduction —
            //      avec l'icône générique fa-bell et le lien de repli /dashboard.
            //      Émetteurs : SelfAssessmentWorkflowService (_notifyEmployee),
            //      AssessmentChangeRequestService (_notifyDeciders / _notifyRequester),
            //      DevelopmentTriggerService (_notify).
            //
            //      Le destinataire de `sa.cancelled` est le SUJET : sa ligne est annulée,
            //      aucune revue n'a été décidée (supervisor_reviews n'est pas touchée),
            //      donc l'atterrissage est « où en est mon dossier » et non la page des
            //      décisions de revue.
            'sa.cancelled': {
                icon: 'fa-ban',
                link: '/employee/assessment-status',
                title: {
                    fr: 'Votre auto-évaluation a été annulée',
                    en: 'Your self-assessment was cancelled',
                },
            },
            //      `raised` va au DÉCIDEUR (superviseur, à défaut manager) : sa file.
            'sa.change_request_raised': {
                icon: 'fa-pen-to-square',
                link: '/assessment-changes',
                title: {
                    fr: 'Une demande de modification attend votre décision',
                    en: 'A request for change awaits your decision',
                },
            },
            //      le SUJET d'une demande déposée par son superviseur ne
            //      recevait RIEN (mesuré sur la demande #35 : une seule notification,
            //      pour le décideur). `kind` distinct de `raised` parce que le libellé
            //      de `raised` dit « attend VOTRE décision » : le sujet ne décide rien,
            //      il doit savoir que la réouverture de SON évaluation est demandée.
            'sa.change_request_raised_on_me': {
                icon: 'fa-pen-to-square',
                link: '/assessment-changes',
                title: {
                    fr: 'Une demande de modification a été déposée sur votre évaluation',
                    en: 'A request for change was raised on your assessment',
                },
            },
            //      `granted` est notifié DEUX FOIS — au demandeur (qui peut être le
            //      superviseur) et au sujet — donc le libellé reste neutre : dire
            //      « votre auto-évaluation » mentirait au superviseur demandeur. Le
            //      lien de repli sert le sujet, qui peut de nouveau saisir ; le
            //      demandeur, lui, reçoit /assessment-changes dans son payload.
            'sa.change_request_granted': {
                icon: 'fa-lock-open',
                link: '/employee/self-assessment',
                title: {
                    fr: 'Une demande de modification a été accordée',
                    en: 'A request for change was granted',
                },
            },
            'sa.change_request_refused': {
                icon: 'fa-circle-xmark',
                link: '/assessment-changes',
                title: {
                    fr: 'Votre demande de modification a été refusée',
                    en: 'Your request for change was refused',
                },
            },
            //      la case basse produit une TÂCHE manager, jamais un PIP d'office.
            //      Le libellé ne nomme ni la case, ni la performance, ni le potentiel —
            //      même règle de confidentialité que les autres kinds 9-box.
            'talent.task.created': {
                icon: 'fa-list-check',
                link: '/v2/pip',
                title: {
                    fr: 'Une action de suivi vous est assignée',
                    en: 'A follow-up task is assigned to you',
                },
            },
            'cycle.reminder': {
                icon: 'fa-clock',
                link: '/employee/self-assessment',
                title: { fr: 'Auto-évaluation à soumettre', en: 'Self-assessment to submit' },
            },
            'cycle.escalation': {
                icon: 'fa-triangle-exclamation',
                link: '/supervisor/self-assessment-reviews',
                title: { fr: 'Revues à finaliser', en: 'Reviews to finalize' },
            },
            'review.completed': {
                icon: 'fa-clipboard-check',
                link: '/employee/assessment-status',
                title: { fr: 'Une revue a été complétée', en: 'A review was completed' },
            },
            // ---- Même classe que les cinq `kind` de E-03/M-05, relevée en
            //      balayant TOUS les kinds émis dans src/ et tous ceux déjà
            //      stockés en base : deux autres n'avaient aucune entrée.
            //      `review.due` n'a plus d'émetteur mais une ligne survit dans
            //      une boîte (notification #1, admin:1) et s'affichait
            //      « review.due » ; sa destination est la file de revues du
            //      superviseur, la même que `sa.submitted`.
            'review.due': {
                icon: 'fa-clipboard-list',
                link: '/supervisor/self-assessment-reviews',
                title: { fr: 'Une revue reste à réaliser', en: 'A review is still to be done' },
            },
            //      `certification.revoked` est émis vers l'EMPLOYÉ
            //      (CertificationService:187) avec la compétence et le motif dans
            //      le payload ; il atterrit sur ses propres certifications, comme
            //      `cert.expiry`. Le libellé ne nomme pas la compétence : c'est le
            //      motif, écrit par le décideur, que present rend.
            'certification.revoked': {
                icon: 'fa-id-badge',
                link: '/employee/my-certifications',
                title: {
                    fr: 'Une certification vous a été retirée',
                    en: 'A certification of yours was revoked',
                },
            },
            'mc.submitted': {
                icon: 'fa-user-shield',
                link: '/v2/uam/maker-checker/queue',
                title: {
                    fr: 'Une action attend votre approbation',
                    en: 'An action awaits your approval',
                },
            },
            'mc.approved': {
                icon: 'fa-circle-check',
                link: '/dashboard',
                title: { fr: 'Votre action a été approuvée', en: 'Your action was approved' },
            },
            'mc.rejected': {
                icon: 'fa-circle-xmark',
                link: '/dashboard',
                title: { fr: 'Votre action a été rejetée', en: 'Your action was rejected' },
            },
            'pip.created': {
                icon: 'fa-user-clock',
                link: '/employee/dashboard',
                title: {
                    fr: 'Un plan de performance vous concerne',
                    en: 'A performance plan concerns you',
                },
            },
            'pip.activated': {
                icon: 'fa-user-clock',
                link: '/employee/dashboard',
                title: {
                    fr: 'Votre plan de performance est actif',
                    en: 'Your performance plan is now active',
                },
            },
            'pip.closed': {
                icon: 'fa-user-check',
                link: '/employee/dashboard',
                title: {
                    fr: 'Un plan de performance a été clôturé',
                    en: 'A performance plan was closed',
                },
            },
            'idp.created': {
                icon: 'fa-seedling',
                link: '/v2/idp',
                title: {
                    fr: 'Un plan de développement a été créé',
                    en: 'A development plan was created',
                },
            },
            'idp.activated': {
                icon: 'fa-seedling',
                link: '/v2/idp',
                title: {
                    fr: 'Votre plan de développement est actif',
                    en: 'Your development plan is now active',
                },
            },
            'coaching.created': {
                icon: 'fa-hands-helping',
                link: '/employee/my-coaching',
                title: { fr: 'Un plan de coaching a été créé', en: 'A coaching plan was created' },
            },
            'coaching.validated': {
                icon: 'fa-hands-helping',
                link: '/employee/my-coaching',
                title: {
                    fr: 'Un plan de coaching a été complété',
                    en: 'A coaching plan was completed',
                },
            },
            'feedback360.nominate': {
                icon: 'fa-users-viewfinder',
                link: '/feedback-360',
                title: {
                    fr: 'Choisissez qui vous donne un feedback 360°',
                    en: 'Choose who gives you 360° feedback',
                },
            },
            'feedback360.approve': {
                icon: 'fa-users-viewfinder',
                link: '/feedback-360',
                title: {
                    fr: 'Des propositions d’évaluateurs 360° attendent votre accord',
                    en: '360° feedback nominations await your approval',
                },
            },
            'feedback360.invited': {
                icon: 'fa-comments',
                link: '/feedback-360',
                title: {
                    fr: 'On vous demande un feedback 360°',
                    en: 'You are asked for 360° feedback',
                },
            },
            'feedback360.reminder': {
                icon: 'fa-comments',
                link: '/feedback-360',
                title: {
                    fr: 'Un questionnaire 360° vous attend',
                    en: 'A 360° feedback questionnaire is waiting for you',
                },
            },
            'feedback360.closed': {
                icon: 'fa-users-viewfinder',
                link: '/feedback-360',
                title: {
                    fr: 'Un rapport 360° est prêt à être communiqué',
                    en: 'A 360° feedback report is ready to release',
                },
            },
            'feedback360.released': {
                icon: 'fa-users-viewfinder',
                link: '/feedback-360',
                title: {
                    fr: 'Votre rapport 360° est disponible',
                    en: 'Your 360° feedback report is available',
                },
            },
            'oneonone.topic_added': {
                icon: 'fa-people-arrows',
                link: '/one-on-one',
                title: {
                    fr: 'Un sujet a été ajouté à votre prochain entretien individuel',
                    en: 'A topic was added to your next one-to-one',
                },
            },
            'dispute.opened': {
                icon: 'fa-scale-balanced',
                link: '/employee/assessment-status',
                title: { fr: 'Une contestation a été ouverte', en: 'A dispute was opened' },
            },
            'dispute.escalated': {
                icon: 'fa-scale-balanced',
                link: '/dashboard',
                title: { fr: 'Une contestation a été escaladée', en: 'A dispute was escalated' },
            },
            'dispute.resolved': {
                icon: 'fa-scale-balanced',
                link: '/employee/assessment-status',
                title: { fr: 'Une contestation a été résolue', en: 'A dispute was resolved' },
            },
            'ninebox.disclosed': {
                icon: 'fa-box-open',
                link: '/employee/dashboard',
                title: {
                    fr: 'Votre positionnement talent a été partagé avec vous',
                    en: 'Your talent placement was shared with you',
                },
            },
            // The two 9-box WORKFLOW kinds. They were in KIND_LABELS (email subjects)
            // and the policy map but had NO KIND_META, so present fell through to
            // the raw kind string and the bell rendered a literal "ninebox.approved".
            // Recipients are the reviewer / submitting manager, never the subject, so
            // both land on the manager-side grid (/talent/nine-box, requireManagerOrAdmin
            // — src/routes/index.js:379) and NOT on an employee page. Titles say a
            // placement moved; they never name the box, the performance or the potential.
            'ninebox.submitted': {
                icon: 'fa-box-open',
                link: '/talent/nine-box',
                title: {
                    fr: 'Un positionnement talent attend votre revue',
                    en: 'A talent placement awaits your review',
                },
            },
            'ninebox.approved': {
                icon: 'fa-box-open',
                link: '/talent/nine-box',
                title: {
                    fr: 'Un positionnement talent a été approuvé',
                    en: 'A talent placement was approved',
                },
            },
            'recognition.received': {
                icon: 'fa-award',
                link: '/employee/dashboard',
                title: { fr: 'Vous avez reçu une reconnaissance', en: 'You received recognition' },
            },
            // The expiry ladder alerts the EMPLOYEE four times (90/60/30 days, then
            // expired) because they are the person who must book the revalidation.
            // It used to land on /employee/dashboard, which shows no certification at
            // all — four alerts, nowhere to learn WHICH one or WHEN. It now lands on
            // the employee's own certification page. The TEAM copy goes to the
            // manager, so it lands on /compliance (manager or view_compliance), where
            // the scoped expiring-cert table already lives — never on the employee's
            // own page, which shows the reader's certifications and not their report's.
            'cert.expiry': {
                icon: 'fa-id-badge',
                link: '/employee/my-certifications',
                title: { fr: 'Certification à renouveler', en: 'Certification to renew' },
            },
            'cert.expiry.team': {
                icon: 'fa-id-badge',
                link: '/compliance',
                title: {
                    fr: "Certification d'un collaborateur à renouveler",
                    en: "A team member's certification needs renewal",
                },
            },
            'coverage.breach': {
                icon: 'fa-triangle-exclamation',
                link: '/dashboard',
                title: { fr: 'Couverture insuffisante', en: 'Insufficient coverage' },
            },
            'coverage.predicted': {
                icon: 'fa-triangle-exclamation',
                link: '/dashboard',
                title: { fr: 'Rupture de couverture prévue', en: 'Coverage gap predicted' },
            },
            // Batched variants: past the per-pass alert cap the coverage job sends ONE
            // notice to the manage_compliance audience instead of one page per rule
            // (a bulk rule generation can flip hundreds of rules at once).
            'coverage.breach.batch': {
                icon: 'fa-triangle-exclamation',
                link: '/compliance',
                title: { fr: 'Plusieurs ruptures de couverture', en: 'Multiple coverage breaches' },
            },
            'coverage.predicted.batch': {
                icon: 'fa-triangle-exclamation',
                link: '/compliance',
                title: {
                    fr: 'Plusieurs ruptures de couverture prévues',
                    en: 'Multiple predicted coverage breaches',
                },
            },
            'continuity.successor_ready': {
                icon: 'fa-people-roof',
                link: '/v2/continuity',
                title: { fr: 'Un successeur est prêt', en: 'A successor is ready' },
            },
            'onboarding.submitted': {
                icon: 'fa-user-plus',
                link: '/onboarding',
                title: { fr: "Nouvelle demande d'intégration", en: 'New onboarding request' },
            },
            'lifecycle.joiner': {
                icon: 'fa-door-open',
                link: '/dashboard',
                title: {
                    fr: 'Bienvenue — votre compte est prêt',
                    en: 'Welcome — your account is ready',
                },
            },
            'lifecycle.mover': {
                icon: 'fa-shuffle',
                link: '/employee/dashboard',
                title: { fr: 'Votre affectation a changé', en: 'Your assignment has changed' },
            },
            'cycle.opened': {
                icon: 'fa-calendar-check',
                link: '/employee/self-assessment',
                title: {
                    fr: "Une campagne d'évaluation est ouverte",
                    en: 'An assessment cycle is now open',
                },
            },
            'cycle.closed': {
                icon: 'fa-calendar-xmark',
                link: '/dashboard',
                title: {
                    fr: "Une campagne d'évaluation est clôturée",
                    en: 'An assessment cycle has closed',
                },
            },
            manager_digest: {
                icon: 'fa-chart-line',
                link: '/dashboard',
                title: {
                    fr: 'Récapitulatif hebdomadaire de votre équipe',
                    en: 'Weekly summary of your team',
                },
            },
            dept_digest: {
                icon: 'fa-chart-line',
                link: '/reports/dept-analytics',
                title: { fr: 'Récapitulatif départemental', en: 'Departmental summary' },
            },
            // ONE kind for all four cadences of the department brief — the cadence
            // travels in the payload. Four kinds would make the merge of §4.7
            // (weekly + monthly + quarterly + yearly falling due on 1 January, ONE
            // message) impossible to represent. The kind carries no dot, so it forms
            // its own family through split_part(kind,'.',1) in the notification
            // centre, which is why locales/*/chrome.json carry
            // `notif_family_dept_brief`: without it the raw slug leaks into the
            // family selector (views/pages/notifications/index.ejs:27).
            // The link is the FALLBACK — every brief carries its own
            // `payload.link = /reports/dept-brief/<id>`.
            dept_brief: {
                icon: 'fa-list-check',
                link: '/reports/dept-brief',
                title: { fr: 'Bilan de votre département', en: 'Your department brief' },
            },
            'idp.signoff_needed': {
                icon: 'fa-signature',
                link: '/v2/idp',
                title: {
                    fr: 'Un plan de développement attend votre signature',
                    en: 'A development plan awaits your signature',
                },
            },
            // Learner-facing kinds point at the LEARNER page. They used to point at
            // /v2/lms — the admin console — so the employee the notification was
            // written for was refused by the very link it gave them.
            'lms.assigned': {
                icon: 'fa-graduation-cap',
                link: '/employee/my-learning',
                title: {
                    fr: 'Une formation vous a été assignée',
                    en: 'A training course was assigned to you',
                },
            },
            'lms.due': {
                icon: 'fa-hourglass-half',
                link: '/employee/my-learning',
                title: {
                    fr: 'Une formation assignée reste à démarrer',
                    en: 'An assigned training course is still to start',
                },
            },
            // Goes to the SUPERVISOR, not the learner: a finished course now
            // proposes a level instead of setting one (rulebook §10), and this
            // is the nudge that stops the proposal sitting unseen forever.
            'lms.uplift_proposed': {
                icon: 'fa-user-graduate',
                link: '/v2/lms/uplifts',
                title: {
                    fr: 'Une formation terminée propose une élévation de niveau à valider',
                    en: 'A completed course proposes a level increase for your decision',
                },
            },
            // Recipient-appropriate landings. These four go to EMPLOYEES, and
            // /v2/cap is the manager/admin capability console (requireManagerOrAdmin,
            // src/routes/index.js) — an employee clicking through was bounced to
            // /dashboard. /employee/opportunities is the "Mon évolution" hub that
            // surfaces exactly this content (mobility, surveys, recognition) for
            // them. mobility.application_received stays on /v2/cap: its recipient
            // is the manager who posted the opportunity.
            'mobility.opportunity_posted': {
                icon: 'fa-briefcase',
                link: '/employee/opportunities',
                title: {
                    fr: 'Une nouvelle opportunité pourrait vous correspondre',
                    en: 'A new opportunity may match your profile',
                },
            },
            'mobility.application_received': {
                icon: 'fa-user-check',
                link: '/v2/cap',
                title: {
                    fr: 'Une candidature a été reçue pour votre opportunité',
                    en: 'An application was received for your opportunity',
                },
            },
            'mobility.application_decided': {
                icon: 'fa-clipboard-check',
                link: '/employee/opportunities',
                title: {
                    fr: 'Une décision a été prise sur votre candidature',
                    en: 'A decision was made on your application',
                },
            },
            'survey.published': {
                icon: 'fa-clipboard-question',
                link: '/employee/opportunities',
                title: {
                    fr: 'Une enquête attend votre réponse',
                    en: 'A survey awaits your response',
                },
            },
            'survey.respond': {
                icon: 'fa-clipboard-question',
                link: '/employee/opportunities',
                title: {
                    fr: 'Rappel : une enquête attend votre réponse',
                    en: 'Reminder: a survey awaits your response',
                },
            },
            'lifecycle.leaver': {
                icon: 'fa-door-closed',
                link: '/v2/continuity',
                title: {
                    fr: 'Un départ requiert un plan de passation',
                    en: 'A departure requires a handover plan',
                },
            },
            // 3.23.18 R2 — the leaver cascade (LifecycleService) names the ACTIVE
            // people left without a reviewer. The payload link is per recipient
            // (admin → the leaver's record, line manager → continuity); this is
            // the fallback.
            'safety.blocked': {
                icon: 'fa-helmet-safety',
                link: '/v2/idp',
                title: {
                    fr: 'Votre habilitation sécurité est bloquée',
                    en: 'Your safety clearance is blocked',
                },
            },
            'safety.expiring': {
                icon: 'fa-helmet-safety',
                link: '/v2/idp',
                title: {
                    fr: 'Votre habilitation sécurité arrive à échéance',
                    en: 'Your safety clearance is expiring soon',
                },
            },
            'safety.blocked.team': {
                icon: 'fa-helmet-safety',
                link: '/v2/idp/manage',
                title: {
                    fr: 'Habilitation sécurité bloquée dans votre équipe',
                    en: 'A team member’s safety clearance is blocked',
                },
            },
            'safety.expiring.team': {
                icon: 'fa-helmet-safety',
                link: '/v2/idp/manage',
                title: {
                    fr: 'Habilitation sécurité d’un collaborateur bientôt échue',
                    en: 'A team member’s safety clearance is expiring soon',
                },
            },
            'lifecycle.reports_to_reassign': {
                icon: 'fa-people-arrows',
                link: '/v2/continuity',
                title: {
                    fr: 'Des collaborateurs sont à réaffecter après un départ',
                    en: 'Team members need a new reviewer after a departure',
                },
            },
            'access.review': {
                icon: 'fa-user-shield',
                link: '/admin/access-review',
                title: { fr: 'Revue des accès à réaliser', en: 'Access review to complete' },
            },
            // The two weekly manager nudges raised by jobs/reminders.js. That job
            // deliberately falls back to another kind whenever KIND_META has no
            // entry (kindFor), so until now they borrowed 'ninebox.submitted' /
            // 'cycle.escalation' titles that described a different event. Their own
            // entries make the bell say what actually happened. Counts only — no
            // names, no placements.
            'ninebox.reassess_due': {
                icon: 'fa-box-open',
                link: '/talent/nine-box',
                title: {
                    fr: 'Des positionnements talent sont à revoir',
                    en: 'Talent placements are due for review',
                },
            },
            'talent.plan_due': {
                icon: 'fa-list-check',
                link: '/talent/actions',
                title: {
                    fr: 'Des plans de votre équipe arrivent à échéance',
                    en: 'Plans in your team are coming due',
                },
            },
            // ---- Proactive continuity automation (jobs/succession-review,
            //      jobs/retention-recompute, jobs/reminders handover section,
            //      jobs/planning-digest). Key-person risk is the one exposure the
            //      platform used to surface ONLY to whoever happened to open
            //      /v2/continuity; these four kinds are what now go and find the
            //      responsible person. All four are AGGREGATED (one notification
            //      carrying a count, never one per row) and carry COUNTS ONLY —
            //      no employee name, no risk band, no placement.
            'succession.review_due': {
                icon: 'fa-people-roof',
                link: '/v2/continuity',
                title: {
                    fr: 'Des postes clés attendent votre revue de succession',
                    en: 'Key positions await your succession review',
                },
            },
            'handover.due': {
                icon: 'fa-people-arrows',
                link: '/v2/continuity',
                title: {
                    fr: 'Des plans de passation restent à finaliser',
                    en: 'Handover plans are still to be completed',
                },
            },
            // Retention risk is a `restricted` confidentiality tier (24_continuity.sql):
            // in-app only, count only, and it never names anyone — same rule as 9-box.
            'retention.risk_high': {
                icon: 'fa-user-minus',
                link: '/v2/continuity',
                title: {
                    fr: 'Risque de départ élevé dans votre équipe',
                    en: 'High retention risk in your team',
                },
            },
            'planning.digest': {
                icon: 'fa-calendar-days',
                link: '/dashboard',
                title: {
                    fr: 'Votre point mensuel de planification des effectifs',
                    en: 'Your monthly workforce-planning brief',
                },
            },
            // ---- operations alerts to SuperAdmins.
            //      Raised by JobRunService.alert — de-duplicated per day, in-app
            //      first, rolled into the daily digest e-mail (tier 'digest').
            'ops.job_failed': {
                icon: 'fa-heart-crack',
                link: '/admin/health',
                title: {
                    fr: 'Une tâche planifiée a échoué ou ne tourne plus',
                    en: 'A scheduled job failed or has stopped running',
                },
            },
            'ops.backup_stale': {
                icon: 'fa-database',
                link: '/admin/health',
                title: {
                    fr: 'Sauvegarde de la base absente ou trop ancienne',
                    en: 'Database backup missing or too old',
                },
            },
            'ops.hris_plan_ready': {
                icon: 'fa-people-arrows',
                link: '/admin/integrations/hris',
                title: {
                    fr: 'Synchronisation SIRH : un plan attend votre revue',
                    en: 'HRIS sync: a plan is waiting for your review',
                },
            },
            'ops.hris_sync_alert': {
                icon: 'fa-triangle-exclamation',
                link: '/admin/integrations/hris',
                title: {
                    fr: 'Synchronisation SIRH interrompue',
                    en: 'HRIS sync stopped',
                },
            },
            'ops.smtp_failed': {
                icon: 'fa-envelope-circle-check',
                link: '/admin/health',
                title: {
                    fr: 'L’envoi d’e-mails échoue (SMTP)',
                    en: 'E-mail delivery is failing (SMTP)',
                },
            },
            'ops.license': {
                icon: 'fa-file-contract',
                link: '/admin/license',
                title: {
                    fr: 'Licence expirée ou sièges dépassés',
                    en: 'Licence expired or seats exceeded',
                },
            },
            // ---- 3.23.20 (C2f): security alerts to every SuperAdmin.
            'security.breakglass_signin': {
                icon: 'fa-key',
                link: '/system-logs',
                title: {
                    fr: 'Connexion par l’accès de secours super administrateur',
                    en: 'Super administrator emergency-access sign-in',
                },
            },
            'security.superadmin_sso_refused': {
                icon: 'fa-user-shield',
                link: '/system-logs',
                title: {
                    fr: 'Connexion SSO refusée sur un compte super administrateur',
                    en: 'SSO sign-in refused on a super administrator account',
                },
            },
            'security.superadmin_mfa_changed': {
                icon: 'fa-shield-halved',
                link: '/admins',
                title: {
                    fr: 'Double authentification d’un super administrateur modifiée',
                    en: 'Super administrator two-factor authentication changed',
                },
            },
            'sso.migration_invite': {
                icon: 'fa-right-to-bracket',
                link: '/login',
                title: {
                    fr: 'Connexion avec votre compte d’entreprise : ce qui change',
                    en: 'Signing in with your company account: what changes',
                },
            },
            'security.superadmin_password_reset': {
                icon: 'fa-key',
                link: '/admins',
                title: {
                    fr: 'Mot de passe d’un super administrateur réinitialisé',
                    en: 'Super administrator password reset',
                },
            },
        };
    }

    /**
     * Data-driven channel policy — email TIER per kind (the "no mailbox invasion"
     * core): 'immediate' (send now, still user-controllable via the category
     * toggle), 'digest' (in-app now; the daily digest emails it), 'none' (in-app
     * only, never email — e.g. confidential 9-box). A kind absent here falls back
     * to legacy category gating. Class is implied: obligations/criticals are
     * immediate, informational/engagement are digest.
     */
    static get KIND_POLICY() {
        return {
            // Time-boxed obligation / security / SLA → immediate email
            'sa.changes_requested': 'immediate',
            'sa.rejected': 'immediate',
            'mc.submitted': 'immediate',
            'mc.rejected': 'immediate',
            'dispute.opened': 'immediate',
            'dispute.escalated': 'immediate',
            'dispute.resolved': 'immediate',
            'pip.activated': 'immediate',
            'coverage.breach': 'immediate',
            'coverage.predicted': 'immediate',
            'coverage.breach.batch': 'immediate',
            'coverage.predicted.batch': 'immediate',
            'cert.expiry': 'immediate',
            'cycle.reminder': 'immediate',
            'cycle.escalation': 'immediate',
            // Informational / engagement → daily digest only (no standalone email)
            'sa.submitted': 'digest',
            'sa.approved': 'digest',
            'sa.manager_validated': 'digest',
            'mc.approved': 'digest',
            'review.completed': 'digest',
            'pip.created': 'digest',
            'pip.closed': 'digest',
            'idp.created': 'digest',
            'idp.activated': 'digest',
            'idp.signoff_needed': 'digest',
            'coaching.created': 'digest',
            'coaching.validated': 'digest',
            'feedback360.nominate': 'digest',
            'feedback360.approve': 'digest',
            'feedback360.invited': 'digest',
            'feedback360.reminder': 'digest',
            'feedback360.closed': 'digest',
            'feedback360.released': 'digest',
            'oneonone.topic_added': 'digest',
            'recognition.received': 'digest',
            'continuity.successor_ready': 'digest',
            'onboarding.submitted': 'digest',
            'cert.expiry.team': 'digest',
            'lms.assigned': 'digest',
            'lms.due': 'digest',
            // A decision is pending on a person's official skill level — it
            // belongs in the daily digest, not buried in-app only.
            'lms.uplift_proposed': 'digest',
            'mobility.opportunity_posted': 'digest',
            'mobility.application_received': 'digest',
            'mobility.application_decided': 'immediate',
            'survey.published': 'digest',
            'survey.respond': 'digest',
            // ('idp.signoff_needed' was listed twice — same 'digest' tier both times,
            //  so the duplicate was a no-op that only tripped no-dupe-keys. Removed
            //  here; the surviving declaration is three lines up, tier unchanged.)
            'access.review': 'digest',
            // Manager nudges from jobs/reminders.js — in-app now, rolled into the
            // one daily digest mail; never a standalone email.
            'ninebox.reassess_due': 'digest',
            'talent.plan_due': 'digest',
            // Continuity automation — in-app now, rolled into the one daily digest
            // mail. ('planning.digest' is deliberately ABSENT: like manager_digest
            // and dept_digest it composes its own branded email and is gated by the
            // 'digest' email category, not by a per-kind tier.)
            'succession.review_due': 'digest',
            'handover.due': 'digest',
            'lifecycle.joiner': 'digest',
            'lifecycle.mover': 'digest',
            'lifecycle.leaver': 'digest',
            'safety.blocked': 'immediate',
            'safety.expiring': 'immediate',
            'safety.blocked.team': 'immediate',
            'safety.expiring.team': 'immediate',
            'lifecycle.reports_to_reassign': 'digest',
            'cycle.opened': 'digest',
            'cycle.closed': 'digest',
            // Confidential → in-app only, NEVER email
            // ('ninebox.submitted' was the only 9-box kind with no tier, so it fell
            //  through to category gating and could have been emailed. Added, not
            //  changed: no existing tier is touched.)
            // Retention risk carries a `restricted` confidentiality tier in the
            // schema — it must never leave the app, so it is in-app only. (The
            // job that raises it uses enqueue rather than notify as well, so
            // it never reaches the webhook fan-out either.)
            'ninebox.disclosed': 'none',
            'ninebox.approved': 'none',
            'ninebox.submitted': 'none',
            'retention.risk_high': 'none',
            // ops alerts: in-app now, in the daily digest e-mail when emailOnDigest.
            'ops.job_failed': 'digest',
            'ops.backup_stale': 'digest',
            'ops.hris_plan_ready': 'digest',
            'ops.hris_sync_alert': 'digest',
            'ops.smtp_failed': 'digest',
            'ops.license': 'digest',
            // 3.23.20 (C2f): security alerts to every SuperAdmin — sent now.
            'security.breakglass_signin': 'immediate',
            'security.superadmin_sso_refused': 'immediate',
            'security.superadmin_mfa_changed': 'immediate',
            'security.superadmin_password_reset': 'immediate',
            // 3.23.20: the SSO migration invitation — in-app row written by
            // SsoInviteService (enqueue); its e-mail is composed and sent there.
            'sso.migration_invite': 'none',
            // 'dept_brief' is DELIBERATELY ABSENT — do not add it.
            //
            // Like manager_digest, dept_digest and planning.digest, the department
            // brief composes its OWN branded email and is gated by the 'digest'
            // EMAIL CATEGORY, not by a per-kind tier. A tier of 'digest' here would
            // hit line 131 (`if (tier === 'digest') { result.email =
            // 'digest_deferred'; return result; }`) and the composed brief would
            // never be sent — the monthly, quarterly and yearly cadences would
            // silently become in-app only.
            //
            // This absence is written down because the jest invariant only checks
            // POLICY → META, never META → POLICY: the omission is invisible to the
            // test suite, and the next contributor will reasonably assume it was an
            // oversight. It is not.
        };
    }

    /**
     * QA LE SIGNALEMENT NOMME LA CAMPAGNE.
     *
     * Trois transitions de campagne (verrouillage, proposition de clôture,
     * retard hebdomadaire) réemploient DÉLIBÉRÉMENT le même kind
     * `cycle.escalation` (`jobs/cycle-deadline.js`). Le réemploi est bon — le
     * lien du payload pointe la bonne campagne et la surface de décision est
     * complète — mais la boîte du super-administrateur affichait six lignes
     * RIGOUREUSEMENT identiques, « Revues à finaliser », venues de campagnes
     * différentes : rien ne disait laquelle, ni ce qui venait de se passer.
     *
     * Le mécanisme n'est pas refait : le kind, le ledger, la cadence et le lien
     * ne bougent pas. Seul le LIBELLÉ gagne un complément, construit AU MOMENT
     * DE LA LECTURE à partir du payload (jamais figé en base, sinon la phrase
     * serait gelée dans la langue de l'émetteur — c'est exactement le défaut
     * P2-03) et fourni en FR et en EN dans le même geste.
     *
     * Contrat : retourne une chaîne courte, ou null — et null veut dire « titre
     * inchangé ». Un payload sans code de campagne ne change donc rien.
     */
    static get KIND_SUBTITLE() {
        const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
        return {
            'cycle.escalation': (p, lang) => {
                const code = String((p && p.cycle) || '').trim();
                if (!code) return null;
                const stage = String((p && p.stage) || '');
                const pending = n(p && p.pending);
                const late = n(p && p.overdueDays);
                if (lang === 'en') {
                    if (stage === 'locked')
                        return `campaign ${code} is locked: the reviews are what is left`;
                    if (stage === 'closure_proposed')
                        return `campaign ${code}: a closure is proposed, your decision is awaited`;
                    if (stage === 'overdue')
                        return late
                            ? `campaign ${code} is ${late} day(s) past its deadline`
                            : `campaign ${code} is past its deadline`;
                    if (stage === 'escalation_overdue')
                        return pending
                            ? `campaign ${code}: ${pending} review(s) overdue`
                            : `campaign ${code}: reviews overdue`;
                    return pending
                        ? `campaign ${code}: ${pending} review(s) to finalise`
                        : `campaign ${code}`;
                }
                if (stage === 'locked') return `campagne ${code} verrouillée : restent les revues`;
                if (stage === 'closure_proposed')
                    return `campagne ${code} : une clôture est proposée, votre décision est attendue`;
                if (stage === 'overdue')
                    return late
                        ? `campagne ${code} en retard de ${late} jour(s)`
                        : `campagne ${code} en retard`;
                if (stage === 'escalation_overdue')
                    return pending
                        ? `campagne ${code} : ${pending} revue(s) en retard`
                        : `campagne ${code} : revues en retard`;
                return pending
                    ? `campagne ${code} : ${pending} revue(s) à finaliser`
                    : `campagne ${code}`;
            },
        };
    }

    /** Le complément de libellé d'un kind pour ce payload, ou null. */
    static _kindSubtitle(kind, payload, locale) {
        const build = NotificationService.KIND_SUBTITLE[kind];
        if (typeof build !== 'function') return null;
        let s = null;
        try {
            s = build(
                payload && typeof payload === 'object' ? payload : {},
                NotificationService._lang(locale)
            );
        } catch (_) {
            return null;
        }
        if (s == null) return null;
        // Replié sur une ligne, comme un motif : le titre est une seule ligne.
        s = String(s).replace(/[ -]+/g, ' ').replace(/\s+/g, ' ').trim(); // eslint-disable-line no-control-regex
        if (!s) return null;
        return s.length > 120 ? `${s.slice(0, 119)}…` : s;
    }

    /**
     * Resolve a KIND_META `title` for a locale. Titles are stored as { fr, en }
     * (older/string titles are returned as-is). FR is primary: it is the fallback
     * whenever the requested language is missing. `locale` may be 'fr', 'en',
     * 'en-US', etc.; only the leading language subtag matters.
     */
    static _localizeTitle(title, locale) {
        if (title == null) return null;
        if (typeof title === 'string') return title;
        const lang = NotificationService._lang(locale);
        return title[lang] || title.fr || title.en || null;
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
        const link = payload.link || meta.link || '/dashboard';
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

    /**
     * Build {subject, html, text} for an event. Explicit subject/html/text win;
     * otherwise derive a readable message from the kind label + payload fields.
     */
    /** HTML-escape for values interpolated into the email body. */
    static _esc(s) {
        return String(s == null ? '' : s).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }

    /** Resolve tenant branding for emails (best-effort; sensible defaults). */
    static async _brand() {
        const d = { appName: 'IDevelop', accent: '#5140D9', ink: '#0E1116', logo: '' };
        try {
            const AppSettingsModel = require('../models/AppSettingsModel');
            // Sequential, NOT Promise.all: notify is routinely called from
            // inside db.runTransaction, where every query shares ONE pg client
            // — firing three at once there triggers node-pg's "client is already
            // executing a query" path. These reads are settings-cache hits, so
            // serialising them costs nothing.
            const appName = await AppSettingsModel.getValue('appName', null).catch(() => null);
            const accent = await AppSettingsModel.getValue('brandAccentColor', null).catch(
                () => null
            );
            const logo = await AppSettingsModel.getValue('brandLogo', null).catch(() => null);
            if (appName && String(appName).trim()) d.appName = String(appName).trim();
            if (accent && /^#?[0-9a-fA-F]{6}$/.test(String(accent).trim())) {
                d.accent = String(accent).trim().startsWith('#')
                    ? String(accent).trim()
                    : `#${String(accent).trim()}`;
            }
            if (logo && /^data:image\//.test(String(logo))) d.logo = String(logo);
        } catch (_) {
            /* defaults */
        }
        return d;
    }

    /**
     * The body sentence for an event, FR primary + EN parity.
     *
     * Every kind that can be emailed has one — the generic "Une mise à jour
     * vous concernant est disponible" fallback used to stand in for whole tiers
     * of events (including five immediate-tier ones), so an urgent dispute
     * escalation and a routine plan update read identically and neither told
     * the reader what had happened.
     *
     * The confidentiality rule holds and is the reason these are static
     * sentences: NOTHING from the payload is interpolated, no rating, level,
     * comment, reason, PIP content or 9-box placement ever appears. The mail
     * says what KIND of thing happened and links into the app; the detail
     * stays behind authentication, where clearance is enforced.
     */
    static get KIND_MESSAGES() {
        return {
            // ---- Self-assessment workflow ----
            'sa.submitted': {
                fr: 'Une auto-évaluation a été soumise et attend votre revue. Merci de la traiter dès que possible.',
                en: 'A self-assessment has been submitted and is waiting for your review. Please handle it as soon as you can.',
            },
            'sa.changes_requested': {
                fr: 'Votre responsable a demandé des modifications sur votre auto-évaluation. Merci de la compléter puis de la soumettre à nouveau.',
                en: 'Your manager has requested changes to your self-assessment. Please complete it and submit it again.',
            },
            'sa.approved': {
                fr: 'Bonne nouvelle : votre auto-évaluation a été approuvée. Vous pouvez en consulter le détail.',
                en: 'Good news: your self-assessment has been approved. You can review the details.',
            },
            'sa.rejected': {
                fr: 'Votre auto-évaluation a été rejetée. Consultez les commentaires associés pour la suite à donner.',
                en: 'Your self-assessment was rejected. Open it to read the comments and see what happens next.',
            },
            'sa.manager_validated': {
                fr: 'Votre évaluation a été validée par le management. Vous pouvez en consulter le détail.',
                en: 'Your assessment has been validated by management. You can review the details.',
            },
            'review.completed': {
                fr: "Une revue de votre responsable a été complétée. Le résultat est consultable dans l'application.",
                en: 'A supervisor review has been completed. The outcome is available in the app.',
            },
            'review.due': {
                fr: "Une revue d'évaluation reste à réaliser et attend votre traitement.",
                en: 'An assessment review is still to be done and is waiting for you.',
            },
            // Compétence et motif restent dans l'application : la phrase dit ce qui
            // s'est passé, jamais quelle certification ni pourquoi.
            'certification.revoked': {
                fr: "Une de vos certifications a été retirée. Le motif et la marche à suivre sont consultables dans l'application.",
                en: 'One of your certifications was revoked. The reason and what to do next are available in the app.',
            },
            // ----  / M-05 — annulation et demande de modification.
            //      Comme toutes les autres : phrases STATIQUES, rien du payload n'y est
            //      interpolé. Le motif écrit par le décideur est rendu dans le centre de
            //      notifications (voir present), jamais dans un e-mail.
            'sa.cancelled': {
                fr: "Une auto-évaluation vous concernant a été annulée par votre responsable. Le motif et la suite à donner sont consultables dans l'application.",
                en: 'A self-assessment concerning you was cancelled by your manager. The reason and what happens next are available in the app.',
            },
            'sa.change_request_raised': {
                fr: 'Une demande de modification sur une évaluation validée attend votre décision. Merci de la traiter dès que possible.',
                en: 'A request to change a validated assessment is waiting for your decision. Please handle it as soon as you can.',
            },
            'sa.change_request_raised_on_me': {
                fr: "Une demande de modification a été déposée sur une de vos évaluations. Le motif et la suite donnée sont consultables dans l'application.",
                en: 'A request for change was raised on one of your assessments. The reason and what happens next are available in the app.',
            },
            'sa.change_request_granted': {
                fr: "Une demande de modification a été accordée : l'auto-évaluation concernée est de nouveau modifiable.",
                en: 'A request for change was granted: the self-assessment concerned can be edited again.',
            },
            'sa.change_request_refused': {
                fr: "Votre demande de modification a été refusée. Le motif de la décision est consultable dans l'application.",
                en: 'Your request for change was refused. The reason for the decision is available in the app.',
            },

            // ---- Maker-checker ----
            'mc.submitted': {
                fr: "Une action soumise par un collègue attend votre approbation. Merci de l'examiner à votre convenance.",
                en: 'An action submitted by a colleague is waiting for your approval. Please review it at your convenience.',
            },
            'mc.approved': {
                fr: "L'action que vous avez soumise a été approuvée.",
                en: 'The action you submitted has been approved.',
            },
            'mc.rejected': {
                fr: "L'action que vous avez soumise a été rejetée. Consultez le motif pour la suite à donner.",
                en: 'The action you submitted was rejected. Open it to read the reason and decide what happens next.',
            },

            // ---- Disputes (immediate tier — SLA-bound) ----
            'dispute.opened': {
                fr: 'Une contestation a été ouverte sur une évaluation et attend votre traitement dans le délai prévu.',
                en: 'A rating dispute has been opened and is waiting to be handled within the agreed time limit.',
            },
            'dispute.escalated': {
                fr: 'Une contestation a été escaladée au niveau supérieur : son délai de traitement court désormais pour vous.',
                en: 'A rating dispute has been escalated to the next level — its response deadline now runs for you.',
            },
            'dispute.resolved': {
                fr: "Une contestation a été résolue. La décision et sa justification sont consultables dans l'application.",
                en: 'A rating dispute has been resolved. The decision and its rationale are available in the app.',
            },

            // ---- Performance / development plans ----
            'pip.created': {
                fr: "Un plan d'amélioration de la performance a été créé et vous concerne.",
                en: 'A performance improvement plan has been created and concerns you.',
            },
            'pip.activated': {
                fr: "Un plan de performance vous concernant est désormais actif. Merci d'en prendre connaissance.",
                en: 'A performance plan concerning you is now active. Please take note of it.',
            },
            'pip.closed': {
                fr: "Un plan d'amélioration de la performance a été clôturé.",
                en: 'A performance improvement plan has been closed.',
            },
            'idp.created': {
                fr: 'Un plan de développement individuel a été créé et vous concerne.',
                en: 'An individual development plan has been created and concerns you.',
            },
            'idp.activated': {
                fr: 'Votre plan de développement individuel est désormais actif.',
                en: 'Your individual development plan is now active.',
            },
            'idp.signoff_needed': {
                fr: 'Un plan de développement attend votre signature pour pouvoir démarrer.',
                en: 'A development plan is waiting for your sign-off before it can start.',
            },
            'coaching.created': {
                fr: 'Un plan de coaching a été créé pour vous accompagner.',
                en: 'A coaching plan has been created to support you.',
            },
            'coaching.validated': {
                fr: 'Un plan de coaching a été mené à son terme et validé.',
                en: 'A coaching plan has been completed and validated.',
            },
            'feedback360.nominate': {
                fr: 'Un feedback 360° est lancé pour vous. Proposez les collègues, collaborateurs et autres personnes qui vous répondront.',
                en: 'A 360° feedback round has been launched for you. Propose the colleagues, direct reports and others who will answer.',
            },
            'feedback360.approve': {
                fr: 'Un membre de votre équipe a proposé ses évaluateurs 360°. Validez ou ajustez la liste.',
                en: 'A member of your team has proposed their 360° raters. Approve or adjust the list.',
            },
            'feedback360.invited': {
                fr: 'Un collègue vous demande un feedback 360°. Vos réponses sont regroupées avec celles des autres et restent anonymes.',
                en: 'A colleague asks you for 360° feedback. Your answers are grouped with others and stay anonymous.',
            },
            'feedback360.reminder': {
                fr: 'Un questionnaire de feedback 360° attend encore votre réponse.',
                en: 'A 360° feedback questionnaire is still waiting for your answer.',
            },
            'feedback360.closed': {
                fr: 'Un tour de feedback 360° est clos. Consultez le rapport et communiquez-le à la personne concernée.',
                en: 'A 360° feedback round has closed. Read the report and release it to the person.',
            },
            'feedback360.released': {
                fr: 'Votre rapport de feedback 360° est disponible.',
                en: 'Your 360° feedback report is available.',
            },
            'oneonone.topic_added': {
                fr: 'Un sujet a été ajouté à l’ordre du jour de votre prochain entretien individuel.',
                en: 'A topic has been added to the agenda of your next one-to-one.',
            },
            'talent.plan_due': {
                fr: "Des plans de développement ou de performance de votre équipe arrivent à échéance ou n'ont pas démarré.",
                en: 'Development or performance plans in your team are coming due or have not started.',
            },
            //  / M-05. Comptes et faits seulement : ni la case, ni la
            // performance, ni le potentiel — le détail reste derrière le lien.
            'talent.task.created': {
                fr: "Une action de suivi vous a été assignée à la suite d'une revue talent. Ouvrez-la pour décider de la suite : rien n'est ouvert d'office.",
                en: 'A follow-up task has been assigned to you after a talent review. Open it to decide what happens next: nothing is opened automatically.',
            },
            // Counts only — never a box, a performance level or a potential level.
            'ninebox.reassess_due': {
                fr: "Des positionnements talent de votre équipe n'ont pas été revus depuis la cadence définie.",
                en: 'Talent placements in your team have not been reviewed within the defined cadence.',
            },

            // ---- Campaigns ----
            'cycle.opened': {
                fr: "Une campagne d'évaluation vient d'être ouverte : votre contribution y est attendue.",
                en: 'An assessment cycle has just opened — your contribution is expected.',
            },
            'cycle.reminder': {
                fr: "Une campagne d'évaluation est en cours et attend votre contribution.",
                en: 'An assessment cycle is under way and is waiting for your contribution.',
            },
            'cycle.escalation': {
                fr: 'Des revues de votre périmètre restent à finaliser avant la clôture de la campagne.',
                en: 'Reviews in your scope are still to be finalised before the cycle closes.',
            },
            'cycle.closed': {
                fr: "Une campagne d'évaluation est clôturée. Les résultats consolidés sont disponibles.",
                en: 'An assessment cycle has closed. The consolidated results are available.',
            },

            // ---- Compliance / operations ----
            'cert.expiry': {
                fr: "Une de vos certifications arrive à échéance. Merci d'anticiper son renouvellement.",
                en: 'One of your certifications is approaching its expiry date. Please plan its renewal.',
            },
            'cert.expiry.team': {
                fr: "La certification d'un membre de votre équipe arrive à échéance et doit être renouvelée.",
                en: 'A certification held by a member of your team is approaching expiry and needs renewing.',
            },
            'coverage.breach': {
                fr: "Un seuil de couverture de compétences n'est plus respecté. Une action peut être requise.",
                en: 'A skills-coverage threshold is no longer met. Action may be required.',
            },
            'coverage.predicted': {
                fr: 'Une rupture de couverture de compétences est prévue à court terme sur votre périmètre.',
                en: 'A skills-coverage gap is forecast in the near term for your scope.',
            },
            'coverage.breach.batch': {
                fr: 'Plusieurs règles de couverture sont passées en rupture en une seule passe. Les alertes ont été regroupées ; le détail est sur la page Conformité opérationnelle.',
                en: 'Several coverage rules moved into breach in a single pass. The alerts were batched; the detail is on the Operational Compliance page.',
            },
            'coverage.predicted.batch': {
                fr: 'Plusieurs ruptures de couverture sont prévues à court terme. Les alertes ont été regroupées ; le détail est sur la page Conformité opérationnelle.',
                en: 'Several coverage gaps are forecast in the near term. The alerts were batched; the detail is on the Operational Compliance page.',
            },
            'access.review': {
                fr: 'Une revue des accès vous est assignée et doit être réalisée.',
                en: 'An access review has been assigned to you and needs to be completed.',
            },

            // ---- Learning ----
            'lms.assigned': {
                fr: 'Une formation vous a été assignée. Vous pouvez la démarrer depuis la plateforme.',
                en: 'A training course has been assigned to you. You can start it from the platform.',
            },
            'lms.due': {
                fr: "Une formation qui vous a été assignée n'a pas encore été démarrée.",
                en: 'A training course assigned to you has not been started yet.',
            },
            // No name, no level and no skill in the body: this leaves the
            // platform by e-mail, and the detail belongs behind the link.
            'lms.uplift_proposed': {
                fr: "Une formation terminée par une personne que vous encadrez propose une élévation de niveau. Le niveau officiel reste inchangé tant que vous ne l'avez pas validée.",
                en: 'A course completed by someone you supervise proposes a level increase. The official level stays unchanged until you validate it.',
            },

            // ---- Mobility, surveys, recognition ----
            'mobility.opportunity_posted': {
                fr: "Une nouvelle opportunité interne vient d'être publiée et pourrait correspondre à votre profil.",
                en: 'A new internal opportunity has just been published and may match your profile.',
            },
            'mobility.application_received': {
                fr: 'Une candidature a été déposée sur une opportunité dont vous êtes responsable.',
                en: 'An application has been submitted for an opportunity you own.',
            },
            'mobility.application_decided': {
                fr: "Une décision a été prise sur votre candidature interne. Le détail est consultable dans l'application.",
                en: 'A decision has been made on your internal application. The details are available in the app.',
            },
            'survey.published': {
                fr: "Une enquête vient d'être publiée et attend votre réponse.",
                en: 'A survey has just been published and is waiting for your response.',
            },
            'survey.respond': {
                fr: 'Rappel : une enquête attend toujours votre réponse.',
                en: 'Reminder: a survey is still waiting for your response.',
            },
            'recognition.received': {
                fr: 'Un collègue tient à vous remercier — vous avez reçu une reconnaissance.',
                en: 'A colleague wants to thank you — you have received recognition.',
            },

            // ---- Continuity, lifecycle, onboarding ----
            'continuity.successor_ready': {
                fr: 'Un successeur a atteint le niveau de préparation requis pour un poste clé.',
                en: 'A successor has reached the readiness level required for a key position.',
            },
            'succession.review_due': {
                fr: 'Des postes clés de votre périmètre attendent une revue de succession : plans arrivés à échéance de revue, ou postes critiques sans successeur désigné.',
                en: 'Key positions in your scope are waiting for a succession review: plans that have reached their review date, or critical positions with no named successor.',
            },
            'handover.due': {
                fr: 'Des plans de passation de votre périmètre sont en retard ou arrivent à échéance avec des éléments encore ouverts.',
                en: 'Handover plans in your scope are overdue, or are coming due with items still open.',
            },
            'onboarding.submitted': {
                fr: "Une nouvelle demande d'intégration a été déposée et attend votre décision.",
                en: 'A new onboarding request has been submitted and is waiting for your decision.',
            },
            'lifecycle.joiner': {
                fr: 'Votre compte est prêt : vous pouvez vous connecter et compléter votre profil.',
                en: 'Your account is ready — you can sign in and complete your profile.',
            },
            'lifecycle.mover': {
                fr: 'Votre affectation a changé. Les compétences attendues de votre nouveau poste sont consultables.',
                en: 'Your assignment has changed. The skills expected in your new role are available to review.',
            },
            'lifecycle.leaver': {
                fr: "Un départ a été enregistré et requiert la mise en place d'un plan de passation.",
                en: 'A departure has been recorded and requires a handover plan.',
            },
            'safety.blocked': {
                fr: 'Une ou plusieurs compétences critiques de votre poste ne sont plus couvertes. Consultez votre plan de développement.',
                en: 'One or more critical skills of your role are no longer covered. Please check your development plan.',
            },
            'safety.expiring': {
                fr: 'Un certificat requis pour votre poste arrive à échéance. Prévoyez son renouvellement.',
                en: 'A certificate required for your role is about to expire. Please plan its renewal.',
            },
            'safety.blocked.team': {
                fr: 'L’habilitation sécurité d’un collaborateur de votre équipe est bloquée. Un plan de développement peut être proposé.',
                en: 'A team member’s safety clearance is blocked. A development plan can be proposed.',
            },
            'safety.expiring.team': {
                fr: 'Un certificat requis pour un collaborateur de votre équipe arrive à échéance.',
                en: 'A certificate required for a member of your team is about to expire.',
            },
            'lifecycle.reports_to_reassign': {
                fr: 'Un départ a laissé des collaborateurs sans responsable actif. Désignez-leur un nouveau réviseur.',
                en: 'A departure has left team members without an active reviewer. Please assign them a new one.',
            },
            'admin.created': {
                fr: 'Un compte administrateur a été créé pour vous. Vos identifiants vous parviennent séparément.',
                en: 'An administrator account has been created for you. Your credentials are sent separately.',
            },

            // ---- Rollups (these have their own dedicated emails; kept for parity) ----
            manager_digest: {
                fr: 'Le récapitulatif de votre équipe est disponible.',
                en: 'The summary for your team is available.',
            },
            dept_digest: {
                fr: 'Le récapitulatif de votre département est disponible.',
                en: 'The summary for your department is available.',
            },
            // Counts and rates live in the brief itself, behind authentication —
            // this sentence says what arrived and nothing about what it contains.
            dept_brief: {
                fr: "Le bilan de performance de votre département est disponible : ce qui attend votre décision, ce qu'il y a à relancer, ce qui arrive à échéance, et l'état mesuré de vos départements.",
                en: 'The performance brief for your department is available: what awaits your decision, what needs chasing, what falls due, and the measured state of your departments.',
            },
            'planning.digest': {
                fr: 'Votre point mensuel de planification des effectifs est disponible : échéances de certification, postes critiques sans relève et évolution du risque de départ.',
                en: 'Your monthly workforce-planning brief is available: upcoming certification expiries, critical positions with no bench, and movements in retention risk.',
            },
            // ---- operations alerts (SuperAdmins only) ----
            'ops.job_failed': {
                fr: "Une tâche planifiée a échoué ou n'a pas tourné depuis plus de 36 heures. Consultez la page Santé de l'instance pour le détail et relancez-la.",
                en: 'A scheduled job failed or has not run for more than 36 hours. Open the instance health page for the detail and run it again.',
            },
            'ops.backup_stale': {
                fr: "Aucune sauvegarde de la base de données réussie depuis plus de 36 heures. Vérifiez l'emplacement et l'espace disque, puis lancez une sauvegarde depuis la page Santé de l'instance.",
                en: 'No successful database backup for more than 36 hours. Check the location and the disk space, then run a backup from the instance health page.',
            },
            'ops.hris_plan_ready': {
                fr: "La synchronisation SIRH de la nuit a préparé un plan (arrivées, mobilités, départs, valeurs non rapprochées). Rien n'a été appliqué : relisez-le puis appliquez-le depuis Intégrations → SIRH.",
                en: 'The nightly HRIS sync prepared a plan (joiners, movers, leavers, unmapped values). Nothing was applied: review it, then apply it from Integrations → HRIS.',
            },
            'ops.hris_sync_alert': {
                fr: "La synchronisation SIRH s'est arrêtée sans rien appliquer : l'export n'a pas pu être lu, ou il aurait désactivé plus de salariés que le seuil de sécurité ne l'autorise. Vérifiez l'export puis relancez un essai à blanc.",
                en: 'The HRIS sync stopped without applying anything: the export could not be read, or it would have deactivated more employees than the safety threshold allows. Check the export, then run a new dry run.',
            },
            'ops.smtp_failed': {
                fr: "L'envoi d'e-mails a échoué. Vérifiez la configuration SMTP dans les paramètres et relancez un e-mail de test.",
                en: 'E-mail delivery failed. Check the SMTP settings and send a test e-mail again.',
            },
            'ops.license': {
                fr: "La licence de l'instance est expirée ou le nombre de sièges licenciés est dépassé. Mettez la licence à jour.",
                en: 'The instance licence has expired or the licensed seat count is exceeded. Update the licence.',
            },
            // ---- 3.23.20 (C2f) security alerts to every SuperAdmin ----
            'security.breakglass_signin': {
                fr: "Un super administrateur s'est connecté par l'accès de secours (mot de passe) alors que la connexion SSO est imposée. Si ce n'était pas prévu, vérifiez le journal de sécurité.",
                en: 'A super administrator signed in through the password emergency access while SSO sign-in is enforced. If this was not expected, check the security log.',
            },
            'security.superadmin_sso_refused': {
                fr: 'Une tentative de connexion par SSO à un compte super administrateur a été refusée. Un super administrateur ne se connecte jamais par SSO. Vérifiez le journal de sécurité.',
                en: 'A single sign-on attempt to a super administrator account was refused. A super administrator never signs in with SSO. Check the security log.',
            },
            'security.superadmin_mfa_changed': {
                fr: "La double authentification d'un compte super administrateur a été modifiée (activation, réinitialisation ou code de secours). Si ce n'était pas prévu, vérifiez le journal de sécurité.",
                en: "A super administrator account's two-factor authentication changed (enrolment, reset or recovery). If this was not expected, check the security log.",
            },
            'security.superadmin_password_reset': {
                fr: "Le mot de passe d'un compte super administrateur a été réinitialisé. La double authentification reste exigée. Si ce n'était pas prévu, vérifiez le journal de sécurité.",
                en: "A super administrator account's password was reset. Two-factor authentication is still required. If this was not expected, check the security log.",
            },
        };
    }

    /** Short, courteous message adapted to the event kind (FR primary). */
    static _kindMessage(kind, locale) {
        const lang = NotificationService._lang(locale);
        const m = NotificationService.KIND_MESSAGES[kind];
        if (m) return m[lang] || m.fr;
        return lang === 'en'
            ? 'An update concerning you is available on the platform.'
            : 'Une mise à jour vous concernant est disponible sur la plateforme.';
    }

    /** Wrap body content in the branded, responsive email shell (header + footer). */
    static _shell(inner, brand) {
        const b = brand || {};
        const appName = NotificationService._esc(b.appName || 'IDevelop');
        const accent = b.accent || '#5140D9';
        const ink = b.ink || '#0E1116';
        const header = b.logo
            ? `<img src="${b.logo}" alt="${appName}" style="height:32px;max-width:190px;object-fit:contain;display:block">`
            : `<span style="font-size:19px;font-weight:800;letter-spacing:.3px;color:#ffffff">${appName}</span>`;
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;margin:0;padding:24px 0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(2,20,40,.07)">
      <tr><td style="background:${ink};padding:18px 28px" align="left">${header}</td></tr>
      <tr><td style="height:4px;background:${accent};font-size:0;line-height:0">&nbsp;</td></tr>
      <tr><td style="padding:30px 28px 24px">${inner}</td></tr>
      <tr><td style="padding:16px 28px;background:#fafbfc;border-top:1px solid #eef0f3;color:#9aa2ad;font-size:12px;line-height:1.6">
        Ceci est un message automatique de <strong>${appName}</strong>. Merci de ne pas y répondre.<br>
        <span style="color:#b7bdc6">Automated message from ${appName} — please do not reply. Manage your notification preferences in the app.</span>
      </td></tr>
    </table>
  </td></tr>
</table>`;
    }

    /**
     * The subject line for an event, in the recipient's language.
     *
     * Subjects used to come from KIND_LABELS — an English-only map that covered
     * roughly half the kinds actually emitted, so a French user got either an
     * English subject or, for an uncovered kind, the raw slug
     * ("IDevelop — mobility.application_decided"). KIND_META titles are already
     * bilingual and already cover every kind in KIND_POLICY (a jest invariant),
     * so they are the source of truth; KIND_LABELS survives only as the EN
     * fallback for kinds that predate KIND_META.
     */
    static _subjectFor(kind, locale, appName, payload) {
        const meta = NotificationService.KIND_META[kind] || {};
        const title =
            NotificationService._localizeTitle(meta.title, locale) ||
            NotificationService.KIND_LABELS[kind] ||
            kind;
        // QA même complément qu'en boîte de réception : un objet
        // « Revues à finaliser » qui ne dit pas de quelle campagne il parle
        // oblige à ouvrir le lien pour le savoir. `payload` est facultatif :
        // sans lui, le sujet est exactement celui d'avant.
        const sub = NotificationService._kindSubtitle(kind, payload, locale);
        return `${appName} — ${sub ? `${title} — ${sub}` : title}`;
    }

    static _render({ kind, payload, subject, html, text, brand, recipientName, locale }) {
        const labels = NotificationService.KIND_LABELS;
        const b = brand || { appName: 'IDevelop', accent: '#5140D9', ink: '#0E1116' };
        const appName = b.appName || 'IDevelop';
        const lang = NotificationService._lang(locale);
        const T = NotificationService.DIGEST_TEXT[lang];
        const finalSubject =
            subject || NotificationService._subjectFor(kind, locale, appName, payload);

        // A caller-provided html body is treated as trusted content and wrapped in
        // the branded shell for a consistent, professional look across every email.
        if (html) {
            return {
                subject: finalSubject,
                html: NotificationService._shell(html, b),
                text:
                    text ||
                    html
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim(),
            };
        }

        const data = payload && typeof payload === 'object' ? payload : {};
        const kindMeta = NotificationService.KIND_META[kind] || {};
        const metaTitle = NotificationService._localizeTitle(kindMeta.title, locale);
        // QA le titre du corps nomme la campagne, comme le sujet.
        const metaSub = NotificationService._kindSubtitle(kind, data, locale);
        const headline = NotificationService._esc(
            metaSub
                ? `${metaTitle || labels[kind] || kind} — ${metaSub}`
                : metaTitle || labels[kind] || kind
        );
        // Deep-link CTA: explicit payload link wins, else the per-kind KIND_META link,
        // so every email lands the recipient exactly where the action is. NOTE: we do
        // NOT dump raw payload fields into the body — that reads unprofessionally and
        // risks leaking sensitive detail (PIP summaries, dispute reasons). Detail stays
        // behind the deep link, inside the app.
        const linkAbs = NotificationService.absUrl(data.link || data.url || kindMeta.link);
        const openLabel = lang === 'en' ? `Open in ${appName}` : `Ouvrir dans ${appName}`;
        const ctaLabel = NotificationService._esc(data.cta || openLabel);
        const accent = b.accent || '#5140D9';
        const greeting = recipientName
            ? `${T.hello} ${NotificationService._esc(recipientName)},`
            : `${T.hello},`;
        const message = NotificationService._esc(NotificationService._kindMessage(kind, locale));

        const ctaHtml = linkAbs
            ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 6px"><tr><td style="border-radius:9px;background:${accent}">
                 <a href="${linkAbs}" style="display:inline-block;padding:12px 26px;color:#0E1116;text-decoration:none;font-weight:700;font-size:15px">${ctaLabel} &rarr;</a>
               </td></tr></table>`
            : '';

        const inner = `
            <p style="margin:0 0 16px;color:#5a6472;font-size:15px">${greeting}</p>
            <h1 style="margin:0 0 12px;color:#0E1116;font-size:21px;line-height:1.35;font-weight:700">${headline}</h1>
            <p style="margin:0 0 4px;color:#4a5560;font-size:15px;line-height:1.65">${message}</p>
            ${ctaHtml}
            <p style="margin:26px 0 0;color:#5a6472;font-size:14px;line-height:1.6">${T.regards},<br><strong>${NotificationService._esc(T.team(appName))}</strong></p>`;

        const finalHtml = NotificationService._shell(inner, b);
        const plainHead = metaSub
            ? `${metaTitle || labels[kind] || kind} — ${metaSub}`
            : metaTitle || labels[kind] || kind;
        const finalText =
            `${greeting}\n\n${plainHead}\n\n${NotificationService._kindMessage(kind, locale)}` +
            (linkAbs ? `\n\n${data.cta || openLabel} : ${linkAbs}` : '') +
            `\n\n${T.regards},\n${T.team(appName)}`;

        return { subject: finalSubject, html: finalHtml, text: text || finalText };
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
     * Release everything whose quiet-hours window has ended — the tick that
     * makes "Les notifications reçues pendant cette plage sont différées" true.
     *
     *   in-app : flip 'snoozed' → 'queued', which is what puts the row back in
     *            the inbox and the bell count.
     *   email  : actually SEND the mail that was held back, then record its
     *            outcome. Without this half, deferring email would mean losing
     *            it.
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
        const out = { released: 0, emailsSent: 0, emailsFailed: 0 };

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
        const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
        let due = [];
        try {
            due = await db.all(
                `UPDATE notifications SET state = 'queued'
                  WHERE id IN (
                        SELECT id FROM notifications
                         WHERE state = 'snoozed' AND channel = 'email'
                           AND (release_at IS NULL OR release_at <= now())
                         ORDER BY id
                         LIMIT ?
                         FOR UPDATE SKIP LOCKED)
                  RETURNING id, user_type, user_id, kind, locale, payload`,
                [lim]
            );
        } catch (_) {
            return out;
        }

        for (const row of due) {
            let ok = false;
            try {
                ok = await NotificationService._sendDeferredEmail(row);
            } catch (_) {
                ok = false;
            }
            if (ok) out.emailsSent++;
            else out.emailsFailed++;
            try {
                await db.run(
                    `UPDATE notifications SET state = ?, sent_at = ${ok ? 'now()' : 'NULL'} WHERE id = ?`,
                    [ok ? 'sent' : 'failed', Number(row.id)]
                );
            } catch (_) {
                /* delivery audit is best-effort */
            }
        }
        return out;
    }

    /** Deliver one email row that was held back by quiet hours. */
    static async _sendDeferredEmail(row) {
        const userType = row.userType || row.user_type;
        const userId = Number(row.userId ?? row.user_id);
        // The opt-out may have been switched OFF while the mail sat in the
        // window — honour the CURRENT preference, not the one at enqueue time.
        if (!(await NotificationService._userEmailAllowed(userType, userId))) return false;
        const recipient = await NotificationService._resolveRecipient(userType, userId);
        if (!recipient.email) return false;

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
        const rendered =
            pending && pending.subject && pending.html
                ? pending
                : NotificationService._render({
                      kind: row.kind,
                      payload,
                      brand: await NotificationService._brand(),
                      recipientName: recipient.name,
                      locale: row.locale,
                  });
        const EmailService = require('./EmailService');
        const sendResult = await EmailService.send({
            to: recipient.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
        });
        return !!sendResult.sent;
    }

    /** BullMQ worker target — picks queued, marks sent (email future). */
    static async send(item) {
        await db.run(`UPDATE notifications SET state='sent', sent_at=now() WHERE id = ?`, [
            item.id,
        ]);
        return { id: item.id, state: 'sent' };
    }

    /**
     * Build + send ONE branded rollup email of a user's UNREAD in-app notifications
     * — the "no mailbox invasion" batching lever (many events → one daily email).
     * Gated by the `digest` email category; deep-links every line. Best-effort.
     */
    static async sendDigest({ userType, userId, locale }) {
        const EmailService = require('./EmailService');
        if (!(await EmailService.isCategoryEnabled('digest'))) return { skipped: 'digest_off' };
        // The per-user opt-out governs the digest FIRST. It is the one email a
        // recipient is most likely to want stopped, and it used to be the only
        // one that ignored the switch: notify checked _userEmailAllowed but
        // the daily rollup went out to everyone who had unread items, so
        // "Recevoir les notifications par e-mail = OFF" still produced mail.
        if (!(await NotificationService._userEmailAllowed(userType, userId)))
            return { skipped: 'user_opt_out' };
        // The window is the LAST 24 HOURS, matching the recipient selection of
        // personal-digest.js:48-55 — which filters on `created_at >= now -
        // interval '24 hours'` while this query did not. An unread notification
        // was therefore re-listed at the top of EVERY day's summary until somebody
        // opened it, and with 259 of 262 rows unread on a development database
        // that is the nominal case, not an edge one: the digest turned into the
        // same list every morning, which is how a reader learns to ignore it.
        // The bell and the notification centre still show everything — this bound
        // is the DIGEST's, and it is the difference between "what is new" and
        // "what is outstanding".
        const rows = await NotificationService.listInApp({
            userType,
            userId,
            limit: 20,
            unreadOnly: true,
            sinceHours: 24,
        });
        if (!rows.length) return { skipped: 'empty' };
        const recipient = await NotificationService._resolveRecipient(userType, userId);
        if (!recipient.email) return { skipped: 'no_address' };
        const brand = await NotificationService._brand();
        const appName = NotificationService._esc(brand.appName || 'IDevelop');
        // Written in the language the notifications themselves were raised in
        // (FR primary) rather than always in French.
        const lang = NotificationService._lang(
            locale || (rows[0] && (rows[0].locale || rows[0].locale))
        );
        const T = NotificationService.DIGEST_TEXT[lang];
        // `withReason: false` — la règle écrite au-dessus de KIND_MESSAGES vaut
        // aussi pour ce récapitulatif : ni motif, ni commentaire, ni note ne
        // quitte l'application par e-mail. Mesuré : sans ce drapeau, la ligne
        // composée était « Votre auto-évaluation a été annulée — Saisie faite sur
        // le mauvais collaborateur. », motif compris, dans le HTML ET le texte.
        // Le motif reste lisible dans le centre de notifications, derrière
        // l'authentification, où l'habilitation est vérifiée.
        const items = rows.map((r) => NotificationService.present(r, lang, { withReason: false }));
        const greeting = recipient.name
            ? `${T.hello} ${NotificationService._esc(recipient.name)},`
            : `${T.hello},`;
        const list = items
            .map((i) => {
                const href = NotificationService.absUrl(i.link);
                return `<tr><td style="padding:10px 0;border-bottom:1px solid #eef0f3">
                <a href="${href}" style="color:#0E1116;text-decoration:none;font-weight:600;font-size:15px">${NotificationService._esc(i.title)}</a>
              </td></tr>`;
            })
            .join('');
        const allHref = NotificationService.absUrl('/notifications');
        const inner = `
            <p style="margin:0 0 14px;color:#5a6472;font-size:15px">${greeting}</p>
            <h1 style="margin:0 0 6px;color:#0E1116;font-size:21px;font-weight:700">${T.title}</h1>
            <p style="margin:0 0 16px;color:#4a5560;font-size:15px">${T.lead(`<strong>${items.length}</strong>`)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0">${list}</table>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px"><tr><td style="border-radius:9px;background:${brand.accent || '#5140D9'}">
              <a href="${allHref}" style="display:inline-block;padding:12px 26px;color:#0E1116;text-decoration:none;font-weight:700;font-size:15px">${T.cta} &rarr;</a>
            </td></tr></table>
            <p style="margin:26px 0 0;color:#5a6472;font-size:14px">${T.regards},<br><strong>${T.team(appName)}</strong></p>`;
        const html = NotificationService._shell(inner, brand);
        const text =
            `${greeting}\n\n${T.lead(items.length)}\n` +
            items.map((i) => `- ${i.title} : ${NotificationService.absUrl(i.link)}`).join('\n') +
            `\n\n${T.cta} : ${allHref}\n\n${T.regards},\n${T.team(brand.appName || 'IDevelop')}`;
        const send = await EmailService.send({
            to: recipient.email,
            subject: `${brand.appName || 'IDevelop'} — ${T.title} (${items.length})`,
            html,
            text,
        });
        return {
            sent: !!send.sent,
            count: items.length,
            skipped: send.sent ? undefined : send.skipped || 'failed',
        };
    }

    /** Digest chrome, FR primary + EN parity (the rest of the app's rule). */
    static get DIGEST_TEXT() {
        return {
            fr: {
                hello: 'Bonjour',
                title: 'Votre récapitulatif',
                regards: 'Cordialement',
                team: (app) => `L'équipe ${app}`,
                cta: 'Voir toutes mes notifications',
                lead: (n) => `Vous avez ${n} notification(s) en attente sur la plateforme.`,
            },
            en: {
                hello: 'Hello',
                title: 'Your summary',
                regards: 'Kind regards',
                team: (app) => `The ${app} team`,
                cta: 'See all my notifications',
                lead: (n) => `You have ${n} notification(s) waiting on the platform.`,
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
