'use strict';

/**
 * breadcrumbLabel — ONE way to put a translated label in a breadcrumb trail.
 *
 * `views/partials/breadcrumbs.ejs` prints `crumb.label` verbatim, so a
 * crumb is only ever translated if the controller translates it. Nine controllers
 * passed English literals, which is how the French « Postes » page showed
 * « Accueil › Configuration › Roles ».
 *
 *   breadcrumbs: [
 *     { label: bc(req, 'admin:set_bc_configuration', 'Configuration'), url: '/organization' },
 *     { label: bc(req, 'chrome:pt_roles', 'Roles') },
 *   ]
 *
 * `fallback` is the English literal that used to be hard-coded: it keeps the trail
 * readable when i18n is not attached (tests, early-boot errors) and it is what
 * i18next renders should the key ever go missing — never a raw `namespace:key`.
 */
function bc(req, key, fallback) {
    if (req && typeof req.t === 'function') return req.t(key, { defaultValue: fallback });
    return fallback;
}

module.exports = { bc };
