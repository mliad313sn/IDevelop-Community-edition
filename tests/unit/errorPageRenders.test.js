'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * The error page could not render itself.
 *
 * `views/pages/error.ejs` is the ONLY page at views/pages/ depth 1 — every other
 * page lives one level deeper (views/pages/<module>/index.ejs), where the
 * '../../partials/...' prefix is correct. That prefix was copied here, so it
 * resolved to views/../partials — outside the view root — and the include threw.
 *
 * Consequence, proven by rendering the template exactly as Express does:
 *
 *   RENDER: FAILED
 *   MESSAGE: ...\views\pages\error.ejs:21
 *   LEAKS_ABSOLUTE_PATH:   true
 *   LEAKS_TEMPLATE_SOURCE: true
 *
 * Every 404 and every HTML 4xx bounced to the dashboard carrying a flash
 * containing the absolute filesystem path AND the template source. After the
 * fix the same render returns a real page (2232 chars) including the manifest.
 *
 * This test renders the template rather than pattern-matching it: a path that
 * only LOOKS right is what caused the defect in the first place.
 */

const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '../..');
const VIEWS = path.join(ROOT, 'views');

const render = (view, locals = {}) =>
    new Promise((resolve) => {
        ejs.renderFile(
            path.join(VIEWS, view),
            {
                lang: 'fr',
                title: 'Page introuvable',
                message: "Cette page n'existe pas.",
                assetVersion: 'test',
                cspNonce: 'test-nonce',
                externalFonts: false,
                __: (k) => k,
                ...locals,
            },
            { views: [VIEWS] },
            (err, html) => resolve({ err, html })
        );
    });

describe('the error page renders', () => {
    test('it renders without throwing', async () => {
        const { err, html } = await render('pages/error.ejs');
        expect(err).toBeNull();
        expect(html.length).toBeGreaterThan(500);
    });

    test('it still pulls in the PWA head, so the fix did not just delete the include', async () => {
        const { html } = await render('pages/error.ejs');
        expect(html).toMatch(/manifest/i);
    });

    test('it shows the caller-supplied title and message', async () => {
        const { html } = await render('pages/error.ejs', {
            title: 'Introuvable',
            message: 'Rien ici.',
        });
        expect(html).toContain('Introuvable');
        expect(html).toContain('Rien ici.');
    });

    test('it offers a way back rather than being a dead end', async () => {
        const { html } = await render('pages/error.ejs');
        expect(html).toMatch(/href="\/dashboard"/);
    });

    test('it never renders an absolute filesystem path or template source', async () => {
        const { err, html } = await render('pages/error.ejs');
        expect(err).toBeNull();
        expect(html).not.toMatch(/[A-Za-z]:\\Users/);
        expect(html).not.toMatch(/<%/);
    });
});
