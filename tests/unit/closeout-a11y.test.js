'use strict';

/**
 * Closeout of the a11y naming residue left open by Lot E (L6-18).
 *
 * Lot E fixed every control its lane-6 evidence NAMED and reported 85 controls
 * still unnamed, on eight pages it did not own. Measured again here before any
 * edit, over HTTP as a signed-in SuperAdmin, with Lot E's own scanner
 * (`committee2/lotE/scan-a11y.js`): /compliance 27, /admins/1 21, /v2/lms 13,
 * /v2/continuity 10, /roles 7, /admins/create 5, /employees 1,
 * /reviews/post-approval 1 — 85. After the fix the same scanner reports 0.
 *
 * An HTTP scan cannot be a unit test (it needs a database and a session), so
 * what is pinned here is the property the scan measured, read off the VIEWS:
 * every rendered form control on those eight pages carries an accessible name.
 * The rule below is deliberately the same one the scanner applies, so the test
 * fails for exactly the reason the scan would fail.
 *
 * Why pin it at all: the names are one attribute each (`for=` / `id=` /
 * `aria-label=`) with no visible effect, so a later edit that moves a field or
 * copies a block loses them silently — nothing on screen changes and no other
 * test notices. This file is the thing that notices.
 */

const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', '..', 'views', 'pages');

// The eight pages Lot E left open, by the view that renders each one.
const OWNED = {
    '/compliance': 'compliance/index.ejs',
    '/admins/:id': 'admins/show.ejs',
    '/admins/create': 'admins/create.ejs',
    '/v2/lms': 'lms/index.ejs',
    '/v2/continuity': 'continuity/index.ejs',
    '/roles': 'roles/index.ejs',
    '/employees': 'employees/index.ejs',
    '/reviews/post-approval': 'reviews/post-approval.ejs',
};

// Lot E's rule (scan-a11y.js): a control is unnamed when it has no aria-label /
// aria-labelledby / title and no <label for> pointing at its id. Hidden inputs
// and buttons carry their name elsewhere; checkbox/radio sit inside their label.
const SKIP_TYPES = /type="(hidden|submit|button|checkbox|radio)"/i;

function readView(rel) {
    return fs.readFileSync(path.join(VIEWS, rel), 'utf8');
}

// Strip <script>/<style>/comments exactly as the scanner strips them from the
// rendered page, so a control that only exists inside a JS string is out of scope.
// Then collapse every remaining EJS tag to a single token: `<%= … %>` carries a
// `>` of its own, so without this a tag regex stops in the middle of an
// attribute and reports a named control as unnamed. The SAME token replaces the
// expression in `id="x-<%= c.id %>"` and in its `for="x-<%= c.id %>"`, so a
// generated pair still matches.
function markup(src) {
    return src
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<%#[\s\S]*?%>/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<%[-=_]?[\s\S]*?[-_]?%>/g, 'EJS');
}

function unnamedControls(src) {
    const main = markup(src);
    const labelFor = new Set([...main.matchAll(/<label[^>]*\bfor="([^"]+)"/gi)].map((m) => m[1]));
    return [...main.matchAll(/<(input|select|textarea)\b[^>]*>/gi)]
        .map((m) => m[0])
        .filter((tag) => !SKIP_TYPES.test(tag))
        .filter((tag) => {
            const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
            const named =
                /aria-label=|aria-labelledby=|title=/.test(tag) || (id && labelFor.has(id));
            return !named;
        })
        .map((tag) => tag.replace(/\s+/g, ' ').slice(0, 120));
}

describe('a11y closeout — every form control on the eight residue pages has a name', () => {
    for (const [route, rel] of Object.entries(OWNED)) {
        test(`${route} (${rel})`, () => {
            expect(unnamedControls(readView(rel))).toEqual([]);
        });
    }
});

describe('a11y closeout — the names are French user-facing wording, not raw keys', () => {
    // Every name must come from a locale lookup or from an existing FR string.
    // A raw `ns:key` token leaking into aria-label would read aloud as gibberish.
    test('no aria-label holds a raw namespace:key token', () => {
        const offenders = [];
        for (const [route, rel] of Object.entries(OWNED)) {
            const src = readView(rel);
            for (const m of src.matchAll(/aria-label="([^"]*)"/g)) {
                // `<%= __('ns:key') %>` is the lookup; a bare `ns:key` is the leak.
                const value = m[1];
                if (/^[a-z][a-z0-9]*:[a-z0-9_]+$/i.test(value.trim()))
                    offenders.push(`${route}: ${value}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('the two sr-only labels carry a real sentence, not an empty span', () => {
        const show = readView('admins/show.ejs');
        const par = readView('reviews/post-approval.ejs');
        // The reset-password field and the auth-policy select sit on inline action
        // rows with no room for a visible label.
        expect(show).toMatch(
            /<label for="admNewPassword" class="sr-only"><%= __\('admin:new_password_placeholder'\) %><\/label>/
        );
        expect(show).toMatch(
            /<label for="admin-auth-policy" class="sr-only"><%= __\('admin:access_identity_auth_policy_title'\) %><\/label>/
        );
        expect(par).toMatch(
            /<label for="par-filter-state" class="sr-only"><%= __\('admin:a11y_par_filter_state'\) %><\/label>/
        );
    });

    test('the new a11y_ keys exist in FR and EN with the same names', () => {
        const pairs = [
            ['admin', ['a11y_par_filter_state']],
            ['lms', ['a11y_map_skill_for', 'a11y_map_level_for']],
        ];
        for (const [ns, keys] of pairs) {
            const fr = require(path.join(__dirname, '..', '..', 'locales', 'fr', `${ns}.json`));
            const en = require(path.join(__dirname, '..', '..', 'locales', 'en', `${ns}.json`));
            for (const k of keys) {
                expect(typeof fr[k]).toBe('string');
                expect(fr[k].length).toBeGreaterThan(3);
                expect(typeof en[k]).toBe('string');
            }
        }
    });
});

describe('a11y closeout — the client-rendered continuity controls are named too', () => {
    // These two are built by the page's own JS, so the HTML scan never sees them;
    // they still reach a real user, so the `for=` is pinned at the source.
    test('succession "add successor" select and handover "add item" input', () => {
        const src = readView('continuity/index.ejs');
        expect(src).toContain("<label for=\"add-succ-'+plan.id+'\">'+CT_T.addSuccessor+'</label>");
        expect(src).toContain("<label for=\"ho-it-'+id+'\">'+CT_T.addItem+'</label>");
    });
});
