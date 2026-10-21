'use strict';

/**
 * PrivacyController: the privacy notice (show, acknowledge, publish), the
 * self-service "my data" download, the objection to profiling and its review.
 *
 * Surfaces:
 *   GET  /privacy/notice                      the notice in force (every signed-in person)
 *   POST /privacy/notice/acknowledge          acknowledge the version in force
 *   GET  /employee/my-data/download           JSON download (employee sessions)
 *   POST /employee/my-data/objection          object to profiling
 *   POST /employee/my-data/objection/withdraw withdraw the objection
 *   POST /compliance/register/privacy-notice  publish a new version (SuperAdmin)
 *   POST /compliance/privacy/objections/:id/review  mark reviewed (SuperAdmin)
 *   POST /compliance/privacy/triggers/:id/resolve   proceed / dismiss (SuperAdmin)
 *
 * Every service refusal carries an exposed status and a code; the code maps to
 * a `compliance:privacy_err_<code>` message.
 */

const Privacy = require('../services/PrivacyService');

function lang(req) {
    return String((req && (req.language || (req.i18n && req.i18n.language))) || 'fr')
        .toLowerCase()
        .startsWith('en')
        ? 'en'
        : 'fr';
}

function errMessage(req, e) {
    const code = (e && e.code) || 'failed';
    const fallback = 'The request could not be completed.';
    if (!req.t) return fallback;
    const k = `compliance:privacy_err_${code}`;
    const s = req.t(k, { defaultValue: '' });
    return s && s !== k ? s : req.t('compliance:privacy_err_failed', { defaultValue: fallback });
}

function flashAndBack(req, res, type, msg, to) {
    if (typeof req.flash === 'function') req.flash(type, msg);
    return res.redirect(303, to);
}

/** Where to return after acknowledging: the page the gate interrupted, same-origin only. */
function returnTo(req) {
    const t = req.session && req.session.privacyReturnTo;
    if (req.session) delete req.session.privacyReturnTo;
    if (typeof t === 'string' && /^\/(?!\/)[^\\\r\n]*$/.test(t) && !t.startsWith('/privacy/'))
        return t;
    return '/';
}

const PrivacyController = {
    async notice(req, res) {
        const current = await Privacy.currentVersion({ fresh: true });
        if (!current) return res.redirect('/');
        const identity = Privacy.identityOf(req.user);
        const acknowledged = identity
            ? await Privacy.hasAcknowledged(identity, current.version)
            : false;
        res.render('pages/employee/privacy-notice', {
            title: req.t ? req.t('compliance:privacy_notice_title') : 'Privacy notice',
            notice: Privacy.present(current, lang(req)),
            acknowledged,
        });
    },

    async acknowledge(req, res) {
        try {
            const r = await Privacy.acknowledge(req.user, req.body && req.body.version, lang(req));
            if (req.session)
                req.session.privacyAck = { t: r.identity.type, id: r.identity.id, v: r.version };
            return res.redirect(303, returnTo(req));
        } catch (e) {
            if (!e || !e.status || e.status >= 500) throw e;
            return flashAndBack(req, res, 'error', errMessage(req, e), '/privacy/notice');
        }
    },

    async download(req, res) {
        let claim;
        try {
            claim = await Privacy.claimExport(req.user, 'json', { ip: req.ip });
        } catch (e) {
            if (!e || !e.status || e.status >= 500) throw e;
            const msg =
                e.code === 'rate_limited' && req.t
                    ? req.t('compliance:privacy_err_rate_limited', { n: e.limit })
                    : errMessage(req, e);
            return flashAndBack(req, res, 'error', msg, '/employee/my-data');
        }
        const out = await Privacy.myDataExport(req.user);
        if (!out) return flashAndBack(req, res, 'error', errMessage(req, {}), '/employee/my-data');
        const day = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="my-data-${out.employeeId}-${day}.json"`
        );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Export-Id', String(claim.id));
        return res.send(JSON.stringify(out, null, 2));
    },

    async object(req, res) {
        try {
            const r = await Privacy.setObjection(req.user, req.body && req.body.reason);
            const key = r.created
                ? 'compliance:privacy_objection_recorded'
                : 'compliance:privacy_objection_already';
            return flashAndBack(req, res, 'success', req.t ? req.t(key) : key, '/employee/my-data');
        } catch (e) {
            if (!e || !e.status || e.status >= 500) throw e;
            return flashAndBack(req, res, 'error', errMessage(req, e), '/employee/my-data');
        }
    },

    async withdraw(req, res) {
        try {
            await Privacy.withdrawObjection(req.user, req.body && req.body.reason);
            const key = 'compliance:privacy_objection_withdrawn';
            return flashAndBack(req, res, 'success', req.t ? req.t(key) : key, '/employee/my-data');
        } catch (e) {
            if (!e || !e.status || e.status >= 500) throw e;
            return flashAndBack(req, res, 'error', errMessage(req, e), '/employee/my-data');
        }
    },

    async publish(req, res) {
        const back = '/compliance/register#privacy-notice';
        try {
            const b = req.body || {};
            const r = await Privacy.publish(
                {
                    titleFr: b.titleFr,
                    titleEn: b.titleEn,
                    bodyFr: b.bodyFr,
                    bodyEn: b.bodyEn,
                    changeNote: b.changeNote,
                },
                `admin:${Number(req.user.id)}`
            );
            const msg = req.t
                ? req.t('compliance:privacy_published', { version: r.version })
                : `Version ${r.version} published`;
            return flashAndBack(req, res, 'success', msg, back);
        } catch (e) {
            if (!e || !e.status || e.status >= 500) throw e;
            return flashAndBack(req, res, 'error', errMessage(req, e), back);
        }
    },

    async markReviewed(req, res) {
        const back = '/compliance/register#privacy-objections';
        try {
            await Privacy.markReviewed(req.user, req.params.id, req.body && req.body.note);
            const key = 'compliance:privacy_reviewed';
            return flashAndBack(req, res, 'success', req.t ? req.t(key) : key, back);
        } catch (e) {
            if (!e || !e.status || e.status >= 500) throw e;
            return flashAndBack(req, res, 'error', errMessage(req, e), back);
        }
    },

    async resolveTrigger(req, res) {
        const back = '/compliance/register#privacy-objections';
        try {
            const b = req.body || {};
            await Privacy.resolveTrigger(
                req.user,
                req.params.id,
                { resolution: b.resolution, reason: b.reason },
                req
            );
            const key = 'compliance:privacy_trigger_resolved';
            return flashAndBack(req, res, 'success', req.t ? req.t(key) : key, back);
        } catch (e) {
            if (!e || !e.status || e.status >= 500) throw e;
            return flashAndBack(req, res, 'error', errMessage(req, e), back);
        }
    },

    /** Locals for the register page's privacy section (SuperAdmin). Never throws. */
    async registerLocals(req) {
        const out = {
            notice: null,
            versions: [],
            acks: null,
            template: Privacy.DEFAULT_TEMPLATE,
            review: { objections: null, triggers: null },
        };
        try {
            const current = await Privacy.currentVersion({ fresh: true });
            out.notice = current;
            out.versions = await Privacy.listVersions();
            out.acks = current ? await Privacy.ackStats(current.version) : null;
        } catch (_) {
            out.notice = null;
        }
        try {
            out.review = await Privacy.reviewOverview(req.user);
        } catch (_) {
            out.review = { objections: null, triggers: null };
        }
        return out;
    },

    /** Locals for the "What is recorded about me" page. Never throws. */
    async myDataLocals(req) {
        const out = { isEmployee: false, objection: null, objectionUnknown: false, notice: null };
        const empId = Privacy.subjectEmployeeId(req.user);
        out.isEmployee = Boolean(empId);
        if (empId) {
            try {
                out.objection = await Privacy.objectionOf(empId);
            } catch (_) {
                out.objectionUnknown = true;
            }
        }
        try {
            const current = await Privacy.currentVersion();
            out.notice = current ? { version: Number(current.version) } : null;
        } catch (_) {
            out.notice = null;
        }
        return out;
    },
};

module.exports = PrivacyController;
