'use strict';

/**
 * KpiGlossaryController — « How is it calculated? » (/kpi/glossary): one page
 * holding the definition of every indicator of the KPI module
 * (src/services/KpiService.js CONTRACTS), each with an anchor (#K1, #K17…) so a
 * report footer can link to it.
 *
 * The page holds definitions only, never a figure. It is module-aware: an
 * indicator whose module is switched off is not listed at all (never shown as
 * "not measured"), and the "See the list" link of an entry is printed only
 * when the reader's navigation offers that page — the same gate as the rail
 * (src/config/navigation.js), so a link never leads into a module that is off
 * or to a page the reader's route guard would refuse. There is no K10: the
 * national-share indicator is not part of IDevelop.
 */

const KpiService = require('../services/KpiService');
const NAV = require('../config/navigation');

/**
 * The entries of the page for the given view locals (user, can, appModules…).
 * Pure apart from the inputs: used by the page and by the stage tests.
 * @returns {Array<{id, key, owner, freshness, module, listHref: string|null}>}
 */
function entries(locals) {
    const L = locals || {};
    const flags = L.appModules && typeof L.appModules === 'object' ? L.appModules : {};
    const visible = NAV.gates(NAV.buildContext(L));
    return KpiService.availableKpis(flags).map((id) => {
        const c = KpiService.CONTRACTS[id];
        const navId = c.list;
        const def = navId && Object.prototype.hasOwnProperty.call(NAV.CATALOGUE, navId);
        const shown = def && Object.prototype.hasOwnProperty.call(visible, navId) && visible[navId];
        return {
            id,
            key: id.toLowerCase(),
            owner: c.owner,
            freshness: c.freshness,
            module: c.module,
            listHref: shown ? NAV.CATALOGUE[navId].href : null,
            // K16: the plan types the organisation's modules allow, with their lists
            planTypes:
                id === 'K16'
                    ? KpiService.availablePlanTypes(flags).map((t) => {
                          const navOk =
                              Object.prototype.hasOwnProperty.call(visible, t.list) &&
                              visible[t.list];
                          return {
                              type: t.type,
                              listHref: navOk ? NAV.CATALOGUE[t.list].href : null,
                          };
                      })
                    : null,
        };
    });
}

const KpiGlossaryController = {
    entries,

    async page(req, res, next) {
        try {
            const threshold = await KpiService.readinessThreshold();
            res.render('pages/kpi/glossary', {
                title: req.t ? req.t('kpi:glossary_title') : 'How is it calculated?',
                entries: entries(res.locals),
                threshold,
                contractVersion: KpiService.CONTRACT_VERSION,
            });
        } catch (err) {
            next(err);
        }
    },
};

module.exports = KpiGlossaryController;
