/**
 * QualifiedPeopleController — "who can do this, here, today".
 * Scoped inside QualifiedPeopleService.
 */
const Svc = require('../services/QualifiedPeopleService');

const QualifiedPeopleController = {
    async page(req, res) {
        try {
            const opts = {
                skillId: req.query.skillId,
                minLevel: req.query.minLevel || 1,
                siteName: req.query.site || '',
                departmentName: req.query.dept || '',
                certifiedOnly: req.query.certified === '1',
                availableOn: req.query.on || '',
            };
            const [result, options] = await Promise.all([
                opts.skillId
                    ? Svc.find(req.user, opts)
                    : Promise.resolve({ rows: [], skill: null }),
                Svc.filterOptions(req.user),
            ]);
            res.render('pages/qualified/index', {
                title: req.t ? req.t('chrome:nav_qualified') : 'Who is qualified',
                result,
                options,
                filters: opts,
            });
        } catch (e) {
            console.error('[qualified] page failed:', e && e.message);
            req.flash('error', req.t ? req.t('flash:generic_error') : 'Could not run the lookup.');
            res.redirect('/dashboard');
        }
    },

    /** Type-ahead for the skill picker. */
    async skills(req, res) {
        try {
            res.json({ skills: await Svc.searchSkills(req.query.q) });
        } catch (e) {
            res.status(500).json({ error: 'skill_search_failed' });
        }
    },
};

module.exports = QualifiedPeopleController;
