/**
 * PostApprovalReviewController — console + actions for supervisor re-reviews
 * of already-approved scores. Deciding is admin-only (enforced in the service
 * and again by a CHECK constraint in the database).
 */
const Svc = require('../services/PostApprovalReviewService');

function msg(req, key, fallback) {
    return req.t ? req.t(`flash:${key}`, fallback) : fallback;
}

const PostApprovalReviewController = {
    async page(req, res) {
        try {
            const items = await Svc.list(req.user, { state: req.query.state || '' });
            res.render('pages/reviews/post-approval', {
                title: req.t ? req.t('chrome:nav_post_reviews') : 'Post-approval reviews',
                items,
                filterState: req.query.state || '',
                canDecide: req.user.userType === 'admin',
            });
        } catch (e) {
            console.error('[post-approval] page failed:', e && e.message);
            req.flash('error', msg(req, 'generic_error', 'Could not load the re-review queue.'));
            res.redirect('/dashboard');
        }
    },

    async raise(req, res) {
        try {
            await Svc.raise(req.user, {
                selfAssessmentId: req.body.selfAssessmentId,
                proposedLevel: req.body.proposedLevel,
                reason: req.body.reason,
            });
            res.json({ ok: true });
        } catch (e) {
            res.status(400).json({ error: e.userMessage || 'raise_failed' });
        }
    },

    async decide(req, res) {
        try {
            const approve = req.body.decision === 'approve';
            await Svc.decide(req.user, req.params.id, approve, req.body.note);
            req.flash('success', msg(req, 'saved', 'Decision recorded.'));
        } catch (e) {
            req.flash('error', e.userMessage || 'decision_failed');
        }
        res.redirect('/reviews/post-approval');
    },

    async withdraw(req, res) {
        try {
            await Svc.withdraw(req.user, req.params.id);
            req.flash('success', msg(req, 'saved', 'Withdrawn.'));
        } catch (e) {
            req.flash('error', e.userMessage || 'withdraw_failed');
        }
        res.redirect('/reviews/post-approval');
    },
};

module.exports = PostApprovalReviewController;
