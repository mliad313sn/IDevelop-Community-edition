'use strict';

const DelegationService = require('../services/DelegationService');

/**
 * Delegation of authority — the readable view.
 *
 * /admins/:id already exists but is an EDIT form: it answers "what shall I grant
 * this person?". This screen answers the two questions governance actually asks
 * and the product could not previously answer:
 *
 *   · for an administrator — what can they really do, and over how many people?
 *   · for a country or site — who holds authority over my people?
 */
class DelegationController {
    async page(req, res) {
        try {
            const [admins, coverage] = await Promise.all([
                DelegationService.buildBreakdown({ viewer: req.user }),
                DelegationService.buildCoverage(),
            ]);

            // Surface the two shapes that mean a delegation does not work, so the
            // reviewer does not have to spot them by reading 40 rows.
            const issues = admins.filter(
                (a) => a.isActive && a.flags.some((f) => f.level === 'warn' || f.level === 'danger')
            );
            const uncovered = coverage.flatMap((c) =>
                c.sites
                    .filter((s) => s.uncovered)
                    .map((s) => ({
                        country: c.countryName,
                        site: s.siteName,
                        headcount: s.headcount,
                    }))
            );

            res.render('pages/admin/delegation', {
                title: req.t ? req.t('chrome:pt_delegation') : "Délégation d'autorité",
                admins,
                coverage,
                issues,
                uncovered,
            });
        } catch (error) {
            console.error('Delegation page error:', error);
            req.flash('error', req.t ? req.t('flash:generic_error') : 'Une erreur est survenue.');
            res.redirect('/dashboard');
        }
    }
}

module.exports = new DelegationController();
