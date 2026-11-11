'use strict';
/**
 * ONE switch for everything about nationality.
 *
 * Nationality is sensitive: an organisation that does not run the regional
 * local-content option has no reason to collect it, show it or analyse it.
 * IDevelop already has that switch — the optional `localContent` module
 * (Administration → Modules, setting `featureLocalContent`, OFF on a new
 * install). There is no second setting: every nationality touchpoint asks
 * THIS helper, which asks ModuleService.
 *
 * While the module is OFF:
 *   - the nationality fields are hidden on the employee forms and a submitted
 *     value is ignored (never written, never cleared);
 *   - the nationality dimension is left out of the DEI and bias analytics;
 *   - the « My diversity data » page does not offer the field (a value the
 *     person already declared is shown read-only, and can still be withdrawn);
 *   - the local-content routes answer 404 (ModuleService.requireModule).
 * NOTHING is deleted or rewritten: switching the module back on restores every
 * view. A person's OWN nationality stays in their data export (right of
 * access, DSRService) whatever the switch says.
 *
 * The module state is read per request from TTL-cached settings; a change
 * applies on the next request, no restart.
 */

const SETTING_KEY = 'featureLocalContent';
/** Settings that belong to the nationality feature (security-class). */
const NATIONALISATION_SETTING_KEYS = Object.freeze([
    'featureLocalContent',
    'localContentHomeCountry',
]);

/** Is everything about nationality switched on? Any doubt → OFF (fail closed). */
async function isNationalisationEnabled() {
    try {
        return (await require('../services/ModuleService').isOn('localContent')) === true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    SETTING_KEY,
    NATIONALISATION_SETTING_KEYS,
    isNationalisationEnabled,
};
