'use strict';

/**
 * Product identity — the ONE place the product's name, edition and stock
 * legal/brand strings are declared.
 *
 * Everything user-visible that says "which product is this" (page titles, the
 * sidebar wordmark, e-mail subjects, the OpenAPI title, exported workbook
 * metadata, the MFA issuer, log metadata) reads from here, either directly or
 * through src/utils/branding.js. An organisation re-skins the running app from
 * App Settings → Branding without touching code; a FORK that wants a different
 * stock identity edits this file (and docs/BRAND.md) and nothing else.
 *
 * Keep this module dependency-free: it is required at boot, by the logger and
 * by jobs, before the database is available.
 */

const pkg = require('../../package.json');

const PRODUCT = Object.freeze({
    /** Short name — header wordmark, e-mail subject tag, MFA issuer. */
    name: 'IDevelop',
    /** Edition label shown next to the name. */
    edition: 'Community Edition',
    /** Full display name — <title>, meta, About page, API title. */
    fullName: 'IDevelop Community Edition',
    /** Technical slug — log service name, export format ids, file prefixes. */
    slug: 'idevelop',
    /** One-line description — meta description, OpenAPI, package manifests. */
    description:
        'Open-source skills, talent and continuous-performance platform: capability frameworks, ' +
        'assessments, readiness, 9-box calibration, development plans and analytics.',
    /** Line shown on /about. */
    legalNotice: 'Free software — licensed under the GNU AGPL v3.0 or later.',
    license: pkg.license || 'AGPL-3.0-or-later',
    version: pkg.version,
    homepage: pkg.homepage || '',
    /** Default sender for outgoing mail when SMTP has no From configured. */
    defaultMailFrom: 'no-reply@idevelop.invalid',
    /** Stock theme colour (PWA manifest / mobile address bar). */
    themeColor: '#0A0C18',
    accentColor: '#7C6CFF',
});

module.exports = PRODUCT;
