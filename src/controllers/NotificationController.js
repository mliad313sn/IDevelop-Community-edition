'use strict';

/**
 * NotificationController — the in-app Notification Centre (inbox) that finally
 * surfaces the `notifications` table to end users, complementing the live
 * "Action Center" (pending-actions) bell. Every item carries a deep link so one
 * click lands the user exactly where the action is required.
 *
 *   GET  /api/notifications        bell JSON { unread, items } (grouped by day)
 *   GET  /notifications            full inbox page, grouped by day
 *   GET  /notifications/:id/go     mark read and opened, then 302 to its deep link
 *   POST /notifications/read-all   mark every unread notification read (never « opened »)
 *   GET  /account/notifications    the person's preferences (categories × e-mail,
 *                                  summary cadence, e-mail language, .ics, quiet hours)
 *
 * SuperAdmin (migration 183):
 *   GET  /admin/notifications/catalogue           every declared kind, its channels and volume
 *   GET  /admin/notifications/catalogue/preview   the sample mail of one declared kind
 *   POST /admin/notifications/site-quiet-hours    a site's default quiet hours
 *   GET  /admin/notifications/metrics             effectiveness per kind over 30 days
 *
 * Recipient identity: employees/managers are ('employee', employees.id); admins/
 * superadmins are ('admin', admins.id) — the two user_type values the table allows.
 */
const NotificationService = require('../services/NotificationService');
const catalogue = require('../services/notificationCatalogue');

/** The five severity levels of the catalogue. */
const SEVERITIES = ['critique', 'action', 'echeance', 'info', 'favorable'];

/**
 * One icon SHAPE per severity — never colour alone: a triangle for
 * « Critique », a checklist for « Action requise », a clock for « Échéance »,
 * an « i » for « Information », a tick for « Décision favorable ».
 */
const SEVERITY_ICON = {
    critique: 'fa-triangle-exclamation',
    action: 'fa-list-check',
    echeance: 'fa-clock',
    info: 'fa-circle-info',
    favorable: 'fa-circle-check',
};

function severityOf(kind) {
    try {
        const s = catalogue.severityOf(kind);
        if (SEVERITIES.includes(s)) return s;
    } catch (_) {
        /* neutral below */
    }
    return 'info';
}

function langOf(locale) {
    return String(locale || 'fr')
        .toLowerCase()
        .startsWith('en')
        ? 'en'
        : 'fr';
}

/** A translator for the request, with a fixed fallback for unit callers without i18n. */
function translator(req) {
    if (req && typeof req.t === 'function') return (k, o) => req.t(k, o);
    return (k) => k;
}

/** Day number (days since the epoch) of an instant's calendar day in the app's zone. */
function dayNo(x) {
    const { appDayIso } = require('../utils/dateFormat');
    const iso = appDayIso(x);
    if (!iso) return null;
    const [y, m, d] = iso.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function toDate(d) {
    if (d == null || d === '') return null;
    const x = d instanceof Date ? d : new Date(d);
    return Number.isNaN(x.getTime()) ? null : x;
}

/**
 * The day group of an instant relative to `now`, in the app's time zone:
 * 'today', 'yesterday', 'week' (earlier in the same Monday-started week) or
 * 'older'.
 */
function groupOf(createdAt, now) {
    const x = toDate(createdAt);
    if (!x) return 'older';
    const a = dayNo(x);
    const b = dayNo(now || new Date());
    if (a == null || b == null) return 'older';
    const diff = b - a;
    if (diff <= 0) return 'today';
    if (diff === 1) return 'yesterday';
    // 1970-01-01 was a Thursday: (n + 3) % 7 is 0 on a Monday.
    const mondayOf = (n) => n - ((n + 3) % 7);
    if (mondayOf(a) === mondayOf(b)) return 'week';
    return 'older';
}

/**
 * The relative time (« il y a 5 min », « hier à 14:32 », « 28/09/2026 ») and
 * the exact one (« 28/09/2026 14:32 ») for the hover title.
 */
function timeOf(createdAt, locale, now, t) {
    const x = toDate(createdAt);
    if (!x) return { rel: '', exact: '', iso: '' };
    const tr = t || ((k) => k);
    const l = langOf(locale);
    const { fmtDateTime, fmtDate } = require('../utils/dateFormat');
    const n = now || new Date();
    const exact = fmtDateTime(x, l);
    const ms = n.getTime() - x.getTime();
    const g = groupOf(x, n);
    let rel;
    if (ms < 60000) rel = tr('chrome:notif_time_now');
    else if (ms < 3600000) rel = tr('chrome:notif_time_min', { n: Math.floor(ms / 60000) });
    else if (g === 'today') rel = tr('chrome:notif_time_hour', { n: Math.floor(ms / 3600000) });
    else if (g === 'yesterday')
        rel = tr('chrome:notif_time_yesterday', { t: exact.slice(exact.length - 5) });
    else rel = fmtDate(x);
    return { rel, exact, iso: x.toISOString() };
}

/** The kind's own label — no complement, no reason (shared-computer mode). */
function kindLabel(kind, locale) {
    const meta = NotificationService.KIND_META[kind] || {};
    return (
        NotificationService._localizeTitle(meta.title, locale) ||
        NotificationService.KIND_LABELS[kind] ||
        kind
    );
}

/**
 * Rows → display items for the centre and the bell.
 *   opts.shared  shared-computer session: the kind label only, no complement
 *                and no reason.
 *   opts.now     clock (tests).
 *   opts.t       translator (relative times).
 * Duplicates (same kind, same title, same link, same day group) are merged
 * into the newest with `count` = n and `mergedIds` (« ×n »); a merged item is
 * unread when any of its rows is. Opening it marks them all read.
 */
function decorate(rows, locale, opts = {}) {
    const now = opts.now || new Date();
    const shared = !!opts.shared;
    const items = [];
    const byKey = new Map();
    for (const r of rows || []) {
        const p = NotificationService.present(r, locale);
        const label = kindLabel(r.kind, locale);
        const severity = severityOf(r.kind);
        const t = timeOf(p.createdAt, locale, now, opts.t);
        const group = groupOf(p.createdAt, now);
        const title = shared ? label : p.title || label;
        const key = `${group}\u0000${r.kind}\u0000${title}\u0000${shared ? '' : p.link}`;
        const prev = byKey.get(key);
        if (prev) {
            prev.count += 1;
            prev.mergedIds.push(p.id);
            if (!p.read) prev.read = false;
            continue;
        }
        const item = {
            id: p.id,
            kind: r.kind,
            label,
            title,
            severity,
            icon: SEVERITY_ICON[severity],
            read: p.read,
            group,
            rel: t.rel,
            exact: t.exact,
            iso: t.iso,
            count: 1,
            mergedIds: [p.id],
        };
        byKey.set(key, item);
        items.push(item);
    }
    for (const it of items) {
        const others = it.mergedIds.filter((x) => x !== it.id).slice(0, 50);
        it.href = `/notifications/${it.id}/go${others.length ? `?with=${others.join(',')}` : ''}`;
    }
    return items;
}

const GROUP_ORDER = ['today', 'yesterday', 'week', 'older'];

/** Items (newest first) → [{ key, items }] in the fixed group order, empty groups omitted. */
function groupItems(items) {
    return GROUP_ORDER.map((key) => ({ key, items: items.filter((i) => i.group === key) })).filter(
        (g) => g.items.length
    );
}

/** Shared-computer session (sessionActivity): titles only, no detail. */
function isShared(req, res) {
    return !!(
        (res && res.locals && res.locals.sharedDevice) ||
        (req && req.session && req.session.sharedDevice)
    );
}

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
    if (!link.startsWith('/') || link.startsWith('//') || link.startsWith('/\\'))
        return '/dashboard';
    return link;
}

/**
 * `link` with the notification ids in its fragment: `/x` → `/x#nopen=1,2`,
 * `/x#anchor` → `/x#anchor&nopen=1,2` (notif-open.js puts `#anchor` back).
 */
function withOpenFragment(link, ids) {
    const list = (ids || []).filter((x) => Number.isInteger(x) && x > 0);
    if (!list.length) return link;
    const tag = `nopen=${list.join(',')}`;
    return String(link).includes('#') ? `${link}&${tag}` : `${link}#${tag}`;
}

/** 'HH:MM' from a form value, or null (a real clock time only). */
function hhmm(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').slice(0, 5));
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Numbers for the admin pages, in the reader's language. */
function numbers(lang) {
    const { fmtNum } = require('../utils/emailTemplate');
    return {
        num: (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : fmtNum(n, 0, lang)),
        dec: (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : fmtNum(n, 1, lang)),
        pct: (p) =>
            p == null || !Number.isFinite(Number(p))
                ? '—'
                : `${fmtNum(p, 1, lang)}${lang === 'en' ? '%' : ' %'}`,
    };
}

/** opened_at, best-effort — a failure never blocks the redirect. */
async function markOpened(args) {
    try {
        await NotificationService.markOpened(args);
    } catch (_) {
        /* measurement is best-effort */
    }
}

class NotificationController {
    /** Bell JSON — unread count + the most recent notifications, grouped by day. */
    async bell(req, res) {
        const shared = isShared(req, res);
        try {
            const id = identity(req.user);
            const lang = locale(req);
            const [rows, unread] = await Promise.all([
                NotificationService.listInApp({ ...id, limit: 40 }),
                NotificationService.unreadCount(id),
            ]);
            const t = translator(req);
            const items = decorate(rows, lang, { shared, t })
                .slice(0, 8)
                .map((i) => ({
                    id: i.id,
                    href: i.href,
                    title: i.title,
                    severity: i.severity,
                    icon: i.icon,
                    read: i.read,
                    count: i.count,
                    group: i.group,
                    rel: i.rel,
                    exact: i.exact,
                }));
            const groups = {};
            for (const g of GROUP_ORDER) groups[g] = t(`chrome:notif_group_${g}`);
            return res.json({ unread, items, groups, shared });
        } catch (e) {
            return res.json({ unread: 0, items: [], groups: {}, shared });
        }
    }

    /** Full inbox page, grouped by day. */
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
            const family = /^[a-z0-9_]{1,32}$/.test(String(req.query.family || '').slice(0, 33))
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
            const shared = isShared(req, res);
            const notifications = decorate(rows, lang, { shared, t: translator(req) });
            res.render('pages/notifications/index', {
                title: req.t ? req.t('chrome:notifications_title') : 'Notifications',
                notifications,
                groups: groupItems(notifications),
                sharedView: shared,
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

    /**
     * Redirect to the item's deep link. A GET changes nothing: mail-security
     * scanners follow every link of a message, so stamping read / opened here
     * would empty the bell and count the scanner as a reader. The ids travel
     * in the URL fragment (`#nopen=…`), which a browser never sends to a
     * server; the landing page's static script (public/js/notif-open.js)
     * posts them to POST /notifications/opened with the CSRF header. `?with=`
     * carries the ids merged into this item on the page or in the bell.
     */
    async go(req, res) {
        try {
            const id = identity(req.user);
            const n = await NotificationService.getOwned({ id: req.params.id, ...id });
            if (!n) return res.redirect('/notifications');
            const others = String((req.query && req.query.with) || '')
                .slice(0, 1000)
                .split(',')
                .map((x) => Number(x))
                .filter((x) => Number.isInteger(x) && x > 0 && x !== Number(n.id))
                .slice(0, 50);
            const link = safeInternal(NotificationService.present(n).link);
            return res.redirect(withOpenFragment(link, [Number(n.id), ...others]));
        } catch (e) {
            return res.redirect('/notifications');
        }
    }

    /**
     * POST /notifications/opened { ids } — same origin, session CSRF. The
     * landing page reports that the owner really arrived: read + opened_at,
     * ownership-scoped (an id that is not the reader's changes nothing).
     * "Mark all read" never sets opened_at.
     */
    async opened(req, res) {
        try {
            const id = identity(req.user);
            const raw = (req.body && req.body.ids) || '';
            const ids = (Array.isArray(raw) ? raw : String(raw).slice(0, 1000).split(','))
                .slice(0, 51)
                .map((x) => Number(x))
                .filter((x) => Number.isInteger(x) && x > 0);
            let done = 0;
            for (const one of ids) {
                const n = await NotificationService.getOwned({ id: one, ...id });
                if (!n) continue;
                await NotificationService.markRead({ id: n.id, ...id }).catch(() => {});
                await markOpened({ id: n.id, ...id });
                done++;
            }
            return res.json({ ok: true, marked: done });
        } catch (e) {
            return res.status(400).json({ ok: false });
        }
    }

    /**
     * Preferences page — the e-mail switch and quiet hours, the category ×
     * channel grid (mandatory rows greyed), the summary cadence and its
     * step-down notice, the e-mail language, the .ics switch and the site's
     * default quiet hours.
     */
    async prefsPage(req, res) {
        try {
            const id = identity(req.user);
            const prefs = await NotificationService.getPreferenceGrid(id);
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

    /** Save preferences (or « turn the summary back on »). */
    async savePrefs(req, res) {
        try {
            const id = identity(req.user);
            const body = req.body || {};
            if (body.action === 'reactivate_digest') {
                await NotificationService.reactivateDigest(id);
                req.flash &&
                    req.flash(
                        'success',
                        req.t
                            ? req.t('chrome:notif_prefs_digest_reactivated')
                            : 'Récapitulatif réactivé.'
                    );
                return res.redirect('/account/notifications');
            }
            // Quiet hours need BOTH ends, and a zero-length window is no window.
            // Storing half a window (or 08:00→08:00) would leave the UI showing a
            // configured "plage" that defers nothing — the exact mismatch between
            // promise and behaviour this screen is supposed to avoid. Reject the
            // save instead of quietly keeping a setting that cannot work.
            const start = hhmm(body.quietStart);
            const end = hhmm(body.quietEnd);
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
                    body.emailEnabled === undefined ||
                    body.emailEnabled === 'off' ||
                    body.emailEnabled === '0'
                ),
                quietStart: start,
                quietEnd: end,
            });
            if (body.grid === '1') {
                const on = (v) => v === 'on' || v === '1' || v === 'true';
                // A Map keyed by the catalogue's categories only: nothing the
                // form sends is used as a key.
                const categories = new Map();
                for (const key of NotificationService.CATEGORIES) {
                    categories.set(key, { email: on(body[`cat_${key}_email`]) });
                }
                await NotificationService.savePreferenceGrid({
                    ...id,
                    categories,
                    digestCadence: String(body.digestCadence || '').slice(0, 10),
                    emailLocale: String(body.emailLocale || '').slice(0, 5),
                    icsEnabled: on(body.icsEnabled),
                });
            }
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

    /** Mark every unread notification read (never « opened »: nothing was followed). */
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

    /** GET /admin/notifications/catalogue — every declared kind, its channels and volume. */
    async catalogue(req, res) {
        try {
            const lang = langOf(locale(req));
            const rows = await NotificationService.catalogueRows({ days: 30, lang });
            const sites = await NotificationService.siteQuietHours();
            res.render('pages/admin/notification-catalogue', {
                title: req.t ? req.t('chrome:ncat_title') : 'Catalogue des notifications',
                rows,
                sites,
                fmt: numbers(lang),
                csrfToken: req.csrfToken ? req.csrfToken() : res.locals && res.locals.csrfToken,
            });
        } catch (e) {
            console.error('notification catalogue error:', e && e.message);
            req.flash &&
                req.flash(
                    'error',
                    req.t ? req.t('chrome:ncat_load_error') : 'Erreur de chargement'
                );
            res.redirect('/admin/notifications');
        }
    }

    /**
     * GET /admin/notifications/catalogue/preview?kind=…&lang=… — the sample mail
     * of one kind, catalogue wording only (no payload, no person). Only a kind
     * the catalogue declares is rendered. The mail is served sandboxed: no
     * script, no request to anywhere, its inline styles only.
     */
    async cataloguePreview(req, res) {
        const kind = String((req.query && req.query.kind) || '').slice(0, 65);
        if (!catalogue.isDeclared(kind)) return res.status(404).send('');
        try {
            const lang = String((req.query && req.query.lang) || '') === 'en' ? 'en' : 'fr';
            const mail = await NotificationService.renderEmail({ kind, locale: lang });
            res.set('Cache-Control', 'no-store');
            res.set(
                'Content-Security-Policy',
                "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
            );
            return res.type('html').send(mail.html);
        } catch (e) {
            return res.status(500).send('');
        }
    }

    /** POST /admin/notifications/site-quiet-hours — a site's default window. */
    async saveSiteQuietHours(req, res) {
        const body = req.body || {};
        const siteId = Number(body.siteId);
        const start = hhmm(body.quietStart);
        const end = hhmm(body.quietEnd);
        const bad =
            !Number.isInteger(siteId) ||
            siteId <= 0 ||
            (start && !end) ||
            (!start && end) ||
            (start && end && start === end);
        if (bad) {
            req.flash &&
                req.flash(
                    'error',
                    req.t
                        ? req.t('chrome:notif_prefs_quiet_invalid')
                        : 'Renseignez une heure de début ET une heure de fin différentes, ou laissez les deux vides.'
                );
            return res.redirect('/admin/notifications/catalogue#site-quiet');
        }
        try {
            const changed = await NotificationService.setSiteQuietHours({ siteId, start, end });
            if (changed) {
                try {
                    await require('../services/LogService').log({
                        adminId: req.user && req.user.id,
                        action: 'NOTIF_SITE_QUIET_HOURS',
                        entityType: 'site',
                        entityId: siteId,
                        details: start ? `${start}-${end}` : 'cleared',
                        ipAddress: req.ip,
                        userAgent: req.get ? req.get('user-agent') : undefined,
                    });
                } catch (_) {
                    /* the audit line is best-effort here; the setting is saved */
                }
            }
            req.flash &&
                req.flash(
                    'success',
                    req.t ? req.t('chrome:ncat_site_saved') : 'Heures calmes enregistrées.'
                );
        } catch (e) {
            req.flash &&
                req.flash(
                    'error',
                    req.t ? req.t('flash:notif_prefs_save_error') : 'Error saving preferences'
                );
        }
        return res.redirect('/admin/notifications/catalogue#site-quiet');
    }

    /** GET /admin/notifications/metrics — effectiveness per kind over 30 days. */
    async metricsPage(req, res) {
        try {
            const lang = langOf(locale(req));
            const metrics = await NotificationService.metrics({ days: 30 });
            res.render('pages/admin/notification-metrics', {
                title: req.t ? req.t('chrome:nmet_title') : 'Efficacité des notifications',
                metrics,
                fmt: numbers(lang),
            });
        } catch (e) {
            console.error('notification metrics error:', e && e.message);
            req.flash &&
                req.flash(
                    'error',
                    req.t ? req.t('chrome:ncat_load_error') : 'Erreur de chargement'
                );
            res.redirect('/admin/notifications');
        }
    }
}

module.exports = new NotificationController();
module.exports._presentation = {
    SEVERITIES,
    SEVERITY_ICON,
    severityOf,
    groupOf,
    timeOf,
    kindLabel,
    decorate,
    groupItems,
    isShared,
    numbers,
    withOpenFragment,
};
