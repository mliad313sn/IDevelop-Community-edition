'use strict';

/**
 * personal-digest — the daily "no mailbox invasion" rollup.
 *
 * Once per day (around DIGEST_HOUR) sends EACH user who has unread in-app
 * notifications from the last 24h ONE branded email summarising them, each line
 * deep-linked. This is what lets most events be in-app-only: instead of an email
 * per event, the user gets a single digest. Gated by the master email switch,
 * the `digest` category (emailOnDigest) AND — per recipient — the user's own
 * "Recevoir les notifications par e-mail" switch, which this job used to ignore
 * entirely: opting out silenced every per-event mail but not the daily rollup,
 * i.e. the one email a user is most likely to want stopped. Exactly-once per day via a date-claim
 * setting (personalDigestLastSentOn), claimed BEFORE sending so a restart within
 * the hour can't double-send.
 */
const db = require('../config/database');

const ENV_HOUR = Number(process.env.DIGEST_HOUR) || 7;

async function tick() {
    const now = new Date();
    const AppSettingsModel = require('../models/AppSettingsModel');
    let hour = ENV_HOUR;
    try {
        hour = Number(await AppSettingsModel.getValue('digestHour', ENV_HOUR));
    } catch {
        /* env/default */
    }
    if (now.getHours() < hour) return { sent: 0, skipped: 'not_due' };

    // Category gate BEFORE the once-a-day claim. Claiming first burned the day:
    // if an admin switched the digest on later the same day, the claim already
    // said "sent today" and nothing went out until tomorrow.
    const EmailService = require('../services/EmailService');
    if (!(await EmailService.isCategoryEnabled('digest')))
        return { sent: 0, skipped: 'digest_off' };

    // Once-per-day claim (idempotent across the hourly ticks + restarts).
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let last = null;
    try {
        last = await AppSettingsModel.getValue('personalDigestLastSentOn', null);
    } catch {
        /* proceed */
    }
    if (last === today) return { sent: 0, skipped: 'already_sent_today' };
    try {
        await AppSettingsModel.setValue(
            'personalDigestLastSentOn',
            today,
            'string',
            'Last personal-digest send date',
            'notifications'
        );
    } catch {
        /* best-effort */
    }

    const NotificationService = require('../services/NotificationService');
    // Candidate recipients: unread in-app notifications from the last 24h that
    // are actually VISIBLE to them — a notification still inside the recipient's
    // quiet-hours window has not been delivered yet, so it must not drag them
    // into today's digest (and must not be summarised away before they see it).
    // The per-user email opt-out is enforced inside sendDigest, which is the
    // single place that decides whether a given user may be mailed at all.
    //
    // A person is a candidate only for items that MAY leave the app: a kind of
    // tier 'none' (retention risk, 9-box, privacy, performance plans) never
    // makes a summary, so an inbox holding only those triggers no mail at all.
    //
    // Each person's CADENCE (migration 183): daily (the default, as before),
    // weekly (on Monday, covering 7 days) or never. On Monday the candidate
    // window is therefore 7 days; a daily person's summary still lists only the
    // last 24 hours. Before sending, eight summaries in a row left unopened
    // slow the cadence down one notch (daily → weekly → never); the
    // preferences page says so and offers to turn it back on.
    const monday = now.getDay() === 1;
    const rows = await db.all(
        `SELECT user_type AS "userType", user_id AS "userId", array_agg(DISTINCT kind) AS kinds
           FROM notifications
          WHERE channel = 'inapp' AND read_at IS NULL
            AND created_at >= now() - interval '${monday ? '7 days' : '24 hours'}'
            AND (state <> 'snoozed' OR release_at IS NULL OR release_at <= now())
          GROUP BY user_type, user_id`
    );
    const { isDigestible } = require('../services/notificationCatalogue');
    const groups = (rows || []).filter((g) =>
        (Array.isArray(g.kinds) ? g.kinds : []).some((k) => isDigestible(k))
    );
    let sent = 0;
    let optedOut = 0;
    let notDue = 0;
    let steppedDown = 0;
    const cadenceOf = async (g) => {
        try {
            return await NotificationService.digestCadence(g.userType, Number(g.userId));
        } catch (_) {
            return 'daily';
        }
    };
    const due = (c) => c === 'daily' || (c === 'weekly' && monday);
    for (const g of groups) {
        try {
            let cadence = await cadenceOf(g);
            if (!due(cadence)) {
                notDue++;
                continue;
            }
            const s = await NotificationService.digestStepDown({
                userType: g.userType,
                userId: Number(g.userId),
                cadence,
            });
            if (s && s.steppedDown) {
                steppedDown++;
                cadence = s.to;
                if (!due(cadence)) {
                    notDue++;
                    continue;
                }
            }
            const r = await NotificationService.sendDigest({
                userType: g.userType,
                userId: Number(g.userId),
                // a daily summary keeps sendDigest's own 24 h default
                ...(cadence === 'weekly' ? { sinceHours: 168 } : {}),
            });
            if (r && r.sent) sent++;
            else if (r && r.skipped === 'user_opt_out') optedOut++;
        } catch (_) {
            /* never let one recipient break the batch */
        }
    }
    if (process.env.NODE_ENV !== 'test')
        console.log(
            `[personal-digest] recipients: ${groups.length}, emails sent: ${sent}, opted out: ${optedOut}, not due: ${notDue}, stepped down: ${steppedDown}`
        );
    return { sent, recipients: groups.length, optedOut, notDue, steppedDown };
}

module.exports = { tick };
