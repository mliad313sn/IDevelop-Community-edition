/**
 * CancellationController — request/approve queue for cancelling coaching,
 * mentoring, PIP and IDP plans. Deciding is admin-only and scope-checked
 * inside the service; the database enforces the same independently.
 */
const Svc = require('../services/CancellationService');

// Turn an internal error code (e.g. 'requester_cannot_approve') into an actionable,
// localized sentence instead of leaking the raw slug to the user (ticket-generator).
function human(req, code, fallbackCode) {
    const c = code || fallbackCode || 'generic_error';
    if (req.t) {
        const k = 'flash:cx_' + c;
        const t = req.t(k);
        if (t && t !== k) return t;
    }
    return req.t ? req.t('flash:generic_error') : 'The action could not be completed.';
}

const CancellationController = {
    async page(req, res) {
        try {
            const items = await Svc.list(req.user, {
                state: req.query.state || '',
                entityType: req.query.type || '',
            });
            res.render('pages/cancellations/index', {
                title: req.t ? req.t('chrome:nav_cancellations') : 'Cancellations',
                items,
                filters: { state: req.query.state || '', type: req.query.type || '' },
                types: Object.keys(Svc.ENTITIES),
                canDecide: req.user.userType === 'admin',
                me: req.user,
            });
        } catch (e) {
            console.error('[cancellations] page failed:', e && e.message);
            req.flash(
                'error',
                req.t ? req.t('flash:generic_error') : 'Could not load the cancellation queue.'
            );
            res.redirect('/dashboard');
        }
    },

    async request(req, res) {
        try {
            await Svc.request(req.user, {
                entityType: req.body.entityType,
                entityId: req.body.entityId,
                reason: req.body.reason,
            });
            res.json({ ok: true });
        } catch (e) {
            res.status(400).json({ error: human(req, e.userMessage, 'request_failed') });
        }
    },

    async decide(req, res) {
        try {
            await Svc.decide(
                req.user,
                req.params.id,
                req.body.decision === 'approve',
                req.body.note
            );
            req.flash('success', req.t ? req.t('flash:saved') : 'Decision recorded.');
        } catch (e) {
            req.flash('error', human(req, e.userMessage, 'decision_failed'));
        }
        res.redirect('/cancellations');
    },

    async withdraw(req, res) {
        try {
            await Svc.withdraw(req.user, req.params.id);
            req.flash('success', req.t ? req.t('flash:saved') : 'Withdrawn.');
        } catch (e) {
            req.flash('error', human(req, e.userMessage, 'withdraw_failed'));
        }
        res.redirect('/cancellations');
    },
};

module.exports = CancellationController;
