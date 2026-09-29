'use strict';

const path = require('path');
let i18next, Backend, middleware;
try {
    i18next = require('i18next');
    Backend = require('i18next-fs-backend');
    middleware = require('i18next-http-middleware');
} catch (_) {
    /* deferred install */
}

const LOCALES_DIR = path.resolve('locales');

async function init() {
    if (!i18next) return null;
    await i18next
        .use(Backend)
        .use(middleware.LanguageDetector)
        .init({
            fallbackLng: 'fr',
            supportedLngs: ['fr', 'en'],
            preload: ['fr', 'en'],
            ns: [
                'common',
                'auth',
                'idp',
                'mc',
                'talent',
                'coaching',
                'pip',
                'mfa',
                // Full-UI translation namespaces (one per surface group)
                'chrome',
                'employee',
                'dash',
                'admin',
                'talentx',
                'flash',
                'compliance',
                'growth',
                // Admin/operator surfaces localized in design review adoption pass
                'datamgmt',
                'assess',
                'syslogs',
                'framework',
                'lms',
                'reports',
                // 3.23.18: nationalisation plans + regulator packs
                'localcontent',
                // 3.23.18: safety-competency gate
                'safety',
                // Executive decision surfaces: key-person risk, exposure by site, board pack
                'exec',
                // Form validation messages (utils/validators.js withMessage keys) —
                'validation',
            ],
            defaultNS: 'common',
            backend: { loadPath: path.join(LOCALES_DIR, '{{lng}}/{{ns}}.json') },
            detection: {
                // An explicit ?lng= (a shared link, the language switch) wins and
                // is then remembered in the cookie.
                order: ['querystring', 'cookie', 'header'],
                lookupQuerystring: 'lng',
                lookupCookie: 'lang',
                caches: ['cookie'],
            },
            interpolation: { escapeValue: false },
        });
    return { handle: middleware.handle(i18next), t: i18next.t.bind(i18next) };
}

module.exports = { init };
