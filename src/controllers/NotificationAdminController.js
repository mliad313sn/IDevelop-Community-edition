'use strict';

/**
 * NotificationAdminController — the operator console for every notification the
 * platform produced, in-app and email. SuperAdmin only (route-gated): it exposes
 * who was notified of what across the whole org, which is broader than any
 * scoped admin should see.
 */
const NotificationAdminService = require('../services/NotificationAdminService');
const { parsePage, buildPager } = require('../utils/listTools');
const LogService = require('../services/LogService');
const { safeBackUrl } = require('../utils/safeRedirect');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseFilters(query) {
    const q = query || {};
    const f = {};
    const errors = {};
    const str = (k) => (q[k] != null && String(q[k]).trim() !== '' ? String(q[k]).trim() : null);

    if (NotificationAdminService.CHANNELS.includes(str('channel'))) f.channel = str('channel');
    if (NotificationAdminService.STATES.includes(str('state'))) f.state = str('state');
    if (NotificationAdminService.USER_TYPES.includes(str('userType'))) f.userType = str('userType');
    const kind = str('kind');
    if (kind) f.kind = kind.slice(0, 200);
    const search = str('q');
    if (search) f.q = search.slice(0, 200);

    // Date bounds → timestamps (from = 00:00, to = next-day 00:00) so the query
    // needs no SQL date arithmetic.
    const from = str('from');
    if (from) {
        if (ISO_DATE.test(from) && !Number.isNaN(new Date(from).getTime())) {
            f.from = from;
            f.fromTs = from + ' 00:00:00';
        } else {
            errors.from = true;
        }
    }
    const to = str('to');
    if (to) {
        if (ISO_DATE.test(to) && !Number.isNaN(new Date(to).getTime())) {
            f.to = to;
            const d = new Date(to + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + 1);
            f.toTs = d.toISOString().slice(0, 10) + ' 00:00:00';
        } else {
            errors.to = true;
        }
    }
    return { filters: f, errors };
}

class NotificationAdminController {
    async index(req, res) {
        try {
            const { filters, errors } = parseFilters(req.query);
            const { page, perPage, offset } = parsePage(req.query, {
                perPageOptions: [25, 50, 100, 200],
                defaultPerPage: 50,
            });
            const [total, rows, stats, kinds] = await Promise.all([
                NotificationAdminService.count(filters),
                NotificationAdminService.list(filters, perPage, offset),
                NotificationAdminService.stats(filters),
                NotificationAdminService.distinctKinds(),
            ]);
            const pager = buildPager(req.query, {
                page,
                total,
                perPage,
                basePath: '/admin/notifications',
            });
            res.render('pages/admin/notifications', {
                title: req.t ? req.t('admin:notif_title') : 'Notifications monitor',
                rows,
                stats,
                kinds,
                pager,
                filters,
                filterErrors: errors,
                channels: NotificationAdminService.CHANNELS,
                states: NotificationAdminService.STATES,
                userTypes: NotificationAdminService.USER_TYPES,
                query: req.query || {},
            });
        } catch (err) {
            console.error('Notification monitor error:', err);
            req.flash(
                'error',
                req.t ? req.t('admin:notif_load_error') : 'Error loading the notifications monitor'
            );
            res.redirect('/dashboard');
        }
    }

    async retry(req, res) {
        try {
            const row = await NotificationAdminService.retry(req.params.id);
            if (!row) {
                req.flash(
                    'error',
                    req.t
                        ? req.t('admin:notif_retry_not_eligible')
                        : 'Only a failed notification can be re-queued.'
                );
            } else {
                await LogService.log({
                    adminId: req.user && req.user.id,
                    action: 'NOTIFICATION_RETRIED',
                    entityType: 'notification',
                    entityId: Number(req.params.id) || null,
                    details: 're-queued a failed notification for delivery',
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                }).catch(() => {});
                req.flash(
                    'success',
                    req.t ? req.t('admin:notif_retry_ok') : 'Notification re-queued for delivery.'
                );
            }
        } catch (err) {
            console.error('Notification retry error:', err);
            req.flash(
                'error',
                req.t ? req.t('admin:notif_retry_error') : 'Error re-queuing the notification'
            );
        }
        // Preserve the current filter/page view on return.
        // Same-origin, relative only (safeBackUrl): the raw Referer used to be
        // echoed whenever it merely CONTAINED /admin/notifications, so
        // https://evil.example/admin/notifications was a valid way "back".
        const rel = safeBackUrl(req, '/admin/notifications');
        const back = /^\/admin\/notifications(?:[/?]|$)/.test(rel) ? rel : '/admin/notifications';
        res.redirect(back);
    }
}

module.exports = new NotificationAdminController();
