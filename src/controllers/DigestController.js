'use strict';

/**
 * DigestController — the in-app side of the « What changed » digests
 * (migration 187). Works with SMTP off: the archive IS the message.
 *
 *   GET  /digests              my archived digests and my cadence (« Restore »)
 *   GET  /digests/:id          one archived digest, printed from its STORED payload
 *   POST /digests/preferences  cadence (daily | weekly | off) or restore=1
 *
 * READ GUARDS:
 *   1. OWNERSHIP: a digest is served only to the account it was written for
 *      (403 otherwise; nobody reads someone else's digest).
 *   2. SCOPE REPLAYED AT READ TIME: every snapshot unit the digest described
 *      (organisation, site, department) must still be fully inside the
 *      reader's clearance (NarrativeService.snapshotScopeFor); otherwise the
 *      content is not shown. An archive row never grants access the reader no
 *      longer has.
 *   3. NO NAME IS STORED: the payload holds counts, unit ids and links.
 * Opening a digest stamps persona_digests.opened_at (the read-rate rule).
 * Every redirect is the fixed relative path /digests.
 */

const PersonaDigestService = require('../services/PersonaDigestService');
const NarrativeService = require('../services/NarrativeService');
const { fmtDate } = require('../utils/dateFormat');

const PAGE = '/digests';

function identity(user) {
    return {
        userType: user && user.userType === 'admin' ? 'admin' : 'employee',
        userId: Number(user && user.id) || -1,
    };
}

function t(req, key, opts) {
    return req.t ? req.t(key, opts) : key;
}

function langOf(req, res) {
    const l = String((res && res.locals && res.locals.lang) || (req && req.language) || 'fr');
    return l.startsWith('en') ? 'en' : 'fr';
}

/** A 'YYYY-MM-DD' day in the reader's language (noon: no zone shift). */
function dayLabel(d, lang) {
    const s = String(d || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? fmtDate(new Date(s + 'T12:00:00'), lang) : '';
}

/** Is every unit of the payload still fully inside the reader's clearance? */
async function scopeStillCovered(user, payload) {
    const units = (payload && Array.isArray(payload.units) && payload.units) || [];
    for (const u of units) {
        const screen =
            u.type === 'site'
                ? { siteId: Number(u.id) }
                : u.type === 'department'
                  ? { departmentId: Number(u.id) }
                  : {};
        const ok = await NarrativeService.snapshotScopeFor(user, screen);
        if (!ok || ok.type !== u.type || Number(ok.id) !== Number(u.id)) return false;
    }
    return true;
}

/** Only an app-relative path is printed as a link (never another host). */
function safeHref(h) {
    return typeof h === 'string' && /^\/(?![/\\])/.test(h) ? h : null;
}

const DigestController = {
    async list(req, res, next) {
        try {
            const id = identity(req.user);
            const lang = langOf(req, res);
            const [rows, prefs, enabled] = await Promise.all([
                PersonaDigestService.listOwned(id.userType, id.userId),
                PersonaDigestService.getPrefs(id.userType, id.userId),
                PersonaDigestService.isEnabled(),
            ]);
            const stepdown =
                prefs &&
                prefs.stepdownAt &&
                (!prefs.reactivatedAt || new Date(prefs.stepdownAt) > new Date(prefs.reactivatedAt))
                    ? { date: fmtDate(prefs.stepdownAt, lang) }
                    : null;
            return res.render('pages/digests/index', {
                title: t(req, 'dash:dg_page_title'),
                enabled,
                rows: rows.map((r) => ({
                    id: Number(r.id),
                    title: r.title || null,
                    date: dayLabel(r.periodKey, lang),
                    opened: !!r.openedAt,
                })),
                cadence: PersonaDigestService.effectiveCadence(prefs),
                cadences: PersonaDigestService.CADENCES,
                stepdown,
            });
        } catch (err) {
            return next(err);
        }
    },

    async show(req, res, next) {
        try {
            const id = identity(req.user);
            const lang = langOf(req, res);
            const found = await PersonaDigestService.findOwned(
                req.params.id,
                id.userType,
                id.userId
            );
            if (found.status !== 200) {
                return res.status(found.status).render('pages/digests/show', {
                    title: t(req, 'dash:dg_page_title'),
                    mode: found.status === 403 ? 'forbidden' : 'notfound',
                    digest: null,
                });
            }
            const row = found.row;
            const covered = await scopeStillCovered(req.user, row.payload);
            if (covered) await PersonaDigestService.markOpened(row.id);
            const p = row.payload || {};
            const clean = (list) =>
                (Array.isArray(list) ? list : []).map((x) => ({
                    text: String((x && x.text) || ''),
                    href: safeHref(x && x.href),
                    polarity: x && x.polarity === 'better' ? 'better' : 'worse',
                }));
            return res.render('pages/digests/show', {
                title: p.title || t(req, 'dash:dg_page_title'),
                mode: covered ? 'one' : 'out_of_scope',
                digest: {
                    id: Number(row.id),
                    persona: row.persona,
                    title: p.title || null,
                    period: t(req, 'dash:dg_period', {
                        days: row.windowDays,
                        date: dayLabel(row.periodKey, lang),
                    }),
                    line: p.line || null,
                    // « Since your last summary » (4.0.0 port, wave 7): the
                    // stored lines, printed as they were sent.
                    progress:
                        p.progress && Array.isArray(p.progress.lines) && p.progress.lines.length
                            ? {
                                  title: p.progress.title ? String(p.progress.title) : null,
                                  lines: p.progress.lines.map((x) => ({
                                      text: String((x && x.text) || ''),
                                      polarity: x && x.polarity === 'better' ? 'better' : 'neutral',
                                  })),
                              }
                            : null,
                    changes: clean(p.changes),
                    actions: clean(p.actions),
                    history: (Array.isArray(p.history) ? p.history : [])
                        .map((h) => (h && h.line ? String(h.line) : null))
                        .filter(Boolean),
                },
            });
        } catch (err) {
            return next(err);
        }
    },

    async savePrefs(req, res, next) {
        try {
            const id = identity(req.user);
            const b = req.body || {};
            if (b.restore === '1') {
                await PersonaDigestService.reactivate(id.userType, id.userId);
                if (req.flash) req.flash('success', t(req, 'dash:dg_reactivated'));
            } else {
                const c = typeof b.cadence === 'string' ? b.cadence : '';
                if (!PersonaDigestService.CADENCES.includes(c)) return res.redirect(303, PAGE);
                await PersonaDigestService.setCadence(id.userType, id.userId, c);
                if (req.flash) req.flash('success', t(req, 'dash:dg_cadence_saved'));
            }
            return res.redirect(303, PAGE);
        } catch (err) {
            return next(err);
        }
    },

    _test: { identity, scopeStillCovered, safeHref },
};

module.exports = DigestController;
