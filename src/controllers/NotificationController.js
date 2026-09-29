'use strict';

/**
 * NotificationController — the in-app Notification Centre (inbox) that finally
 * surfaces the `notifications` table to end users, complementing the live
 * "Action Center" (pending-actions) bell. Every item carries a deep link so one
 * click lands the user exactly where the action is required.
 *
 *   GET  /api/notifications        bell JSON { unread, items }
 *   GET  /notifications            full inbox page
 *   GET  /notifications/:id/go     mark one read, then 302 to its deep link
 *   POST /notifications/read-all   mark every unread notification read
 *
 * Recipient identity: employees/managers are ('employee', employees.id); admins/
 * superadmins are ('admin', admins.id) — the two user_type values the table allows.
 */
const NotificationService = require('../services/NotificationService');

function identity(user) {
    const userType = user && user.userType === 'admin' ? 'admin' : 'employee';
    return { userType, userId: Number(user && user.id) || -1 };
}

// Resolve the request's display language (i18next attaches req.language). Falls
// back to FR — the app is French-first — so in-app titles are shown in the user's
// locale (EN users no longer see French-only bell titles). Only 'fr'/'en' matter.
function locale(req) {
    return (req && (req.language || (req.i18n && req.i18n.language))) || 'fr';
}

// Only permit internal, non-protocol-relative redirect targets (no open redirect).
function safeInternal(link) {
    if (typeof link !== 'string') return '/dashboard';
    if (!link.startsWith('/') || link.startsWith('//')) return '/dashboard';
    return link;
}

class NotificationController {
    /** Bell JSON — unread count + the most recent notifications, presented. */
    async bell(req, res) {
        try {
            const id = identity(req.user);
            const lang = locale(req);
            const [rows, unread] = await Promise.all([
                NotificationService.listInApp({ ...id, limit: 8 }),
                NotificationService.unreadCount(id),
            ]);
            res.json({ unread, items: rows.map((r) => NotificationService.present(r, lang)) });
        } catch (e) {
            res.json({ unread: 0, items: [] });
        }
    }

    /** Full inbox page. */
    async page(req, res) {
        try {
            const id = identity(req.user);
            const lang = locale(req);
            // server-side filters + paging (utils/listTools), like every other
            // list. The old page took the newest 100 and stopped, so a person with 159
            // campaign reminders could not reach anything older than those.
            const { parsePage, buildPager } = require('../utils/listTools');
            const state = ['unread', 'read'].includes(String(req.query.state || ''))
                ? String(req.query.state)
                : '';
            const family = /^[a-z_]{1,32}$/.test(String(req.query.family || ''))
                ? String(req.query.family)
                : '';
            const filters = { state, family };
            const q = {
                unreadOnly: state === 'unread',
                readOnly: state === 'read',
                family: family || null,
            };
            const total = await NotificationService.countInApp({ ...id, ...q });
            const { page, perPage } = parsePage(req.query, {
                perPageOptions: [20, 50, 100],
                defaultPerPage: 20,
            });
            // Clamp the page into range BEFORE querying: ?page=2 on a one-page result
            // must show page 1, not an empty list under a « 1-1 sur 1 » caption.
            const totalPages = Math.max(1, Math.ceil(total / perPage));
            const safePage = Math.min(page, totalPages);
            const rows = await NotificationService.listInAppPage({
                ...id,
                ...q,
                offset: (safePage - 1) * perPage,
                limit: perPage,
            });
            const families = await NotificationService.inAppFamilies(id);
            res.render('pages/notifications/index', {
                title: req.t ? req.t('chrome:notifications_title') : 'Notifications',
                notifications: rows.map((r) => NotificationService.present(r, lang)),
                filters,
                families,
                pager: buildPager(req.query, {
                    page: safePage,
                    total,
                    perPage,
                    basePath: '/notifications',
                }),
                csrfToken: req.csrfToken ? req.csrfToken() : res.locals && res.locals.csrfToken,
            });
        } catch (e) {
            console.error('notifications page error:', e && e.message);
            req.flash &&
                req.flash(
                    'error',
                    req.t ? req.t('flash:notif_load_error') : 'Error loading notifications'
                );
            res.redirect('/dashboard');
        }
    }

    /** Mark one read, then redirect to its deep link (single-click "go there"). */
    async go(req, res) {
        try {
            const id = identity(req.user);
            const n = await NotificationService.getOwned({ id: req.params.id, ...id });
            if (!n) return res.redirect('/notifications');
            await NotificationService.markRead({ id: n.id, ...id }).catch(() => {});
            const link = safeInternal(NotificationService.present(n).link);
            return res.redirect(link);
        } catch (e) {
            return res.redirect('/notifications');
        }
    }

    /** Preferences page — per-user email opt-out + quiet hours. */
    async prefsPage(req, res) {
        try {
            const id = identity(req.user);
            const prefs = await NotificationService.getUserPrefs(id);
            res.render('pages/account/notifications', {
                title: req.t ? req.t('chrome:notif_prefs_title') : 'Préférences de notification',
                prefs,
                csrfToken: req.csrfToken ? req.csrfToken() : res.locals && res.locals.csrfToken,
            });
        } catch (e) {
            console.error('notif prefs page error:', e && e.message);
            req.flash &&
                req.flash(
                    'error',
                    req.t ? req.t('flash:notif_prefs_load_error') : 'Error loading preferences'
                );
            res.redirect('/dashboard');
        }
    }

    /** Save preferences. */
    async savePrefs(req, res) {
        try {
            const id = identity(req.user);
            // Real clock times only — the old /^\d{1,2}:\d{2}$/ accepted "99:99",
            // which stores fine and then silently never matches any moment.
            const hhmm = (v) => {
                const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
                if (!m) return null;
                const h = Number(m[1]);
                const min = Number(m[2]);
                if (h > 23 || min > 59) return null;
                return `${String(h).padStart(2, '0')}:${m[2]}`;
            };
            // Quiet hours need BOTH ends, and a zero-length window is no window.
            // Storing half a window (or 08:00→08:00) would leave the UI showing a
            // configured "plage" that defers nothing — the exact mismatch between
            // promise and behaviour this screen is supposed to avoid. Reject the
            // save instead of quietly keeping a setting that cannot work.
            const start = hhmm(req.body.quietStart);
            const end = hhmm(req.body.quietEnd);
            const partial = (start && !end) || (!start && end) || (start && end && start === end);
            if (partial) {
                req.flash &&
                    req.flash(
                        'error',
                        req.t
                            ? req.t('chrome:notif_prefs_quiet_invalid')
                            : 'Renseignez une heure de début ET une heure de fin différentes, ou laissez les deux vides.'
                    );
                return res.redirect('/account/notifications');
            }
            await NotificationService.setUserPrefs({
                ...id,
                emailEnabled: !(
                    req.body.emailEnabled === undefined ||
                    req.body.emailEnabled === 'off' ||
                    req.body.emailEnabled === '0'
                ),
                quietStart: start,
                quietEnd: end,
            });
            req.flash &&
                req.flash(
                    'success',
                    req.t ? req.t('chrome:notif_prefs_saved') : 'Préférences enregistrées.'
                );
            res.redirect('/account/notifications');
        } catch (e) {
            console.error('notif prefs save error:', e && e.message);
            req.flash &&
                req.flash(
                    'error',
                    req.t ? req.t('flash:notif_prefs_save_error') : 'Error saving preferences'
                );
            res.redirect('/account/notifications');
        }
    }

    /** Mark every unread notification read. */
    async readAll(req, res) {
        try {
            const id = identity(req.user);
            const n = await NotificationService.markAllRead(id);
            if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true, marked: n });
            return res.redirect('/notifications');
        } catch (e) {
            if (req.accepts(['html', 'json']) === 'json')
                return res.status(500).json({ ok: false });
            return res.redirect('/notifications');
        }
    }
}

module.exports = new NotificationController();
