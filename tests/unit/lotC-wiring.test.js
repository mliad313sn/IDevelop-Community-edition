'use strict';

/**
 * Lot C — wiring, screens and migration (L1-03/04/07/10/12/14/15/20/25, L6-07/13).
 *
 * Source-level pins for the things a unit test cannot exercise in a browser:
 * that the new verbs are actually reachable (and not shadowed by a route
 * registered earlier), that the console shows the states an access review needs, that the
 * migration is re-runnable, and that every visible string is a key in BOTH
 * locales.
 */

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const ROUTES = read('src/routes/index.js');
const INDEX_VIEW = read('views/pages/admins/index.ejs');
const SHOW_VIEW = read('views/pages/admins/show.ejs');
const DELEG_VIEW = read('views/pages/admin/delegation.ejs');
const REVIEW_VIEW = read('views/pages/admin/access-review.ejs');
const MIGRATION = read('db/postgres/110_admin_governance.sql');
const FR = require('../../locales/fr/admin.json');
const EN = require('../../locales/en/admin.json');

describe('Lot C — the new verbs are registered, and reachable', () => {
    const block = ROUTES.slice(
        ROUTES.indexOf('// ---- SECTION access —'),
        ROUTES.indexOf('// ---- end SECTION access')
    );

    // Lot E (L6-24) constrained every /admins/:id* route to a NUMERIC id, so the
    // registered path reads `/admins/:id(\d+)/…`. These pins accept the constraint
    // (and require it to stay numeric) instead of the bare `:id` they used to expect.
    const ID = String.raw`\/admins\/:id\(\\\\d\+\)`;
    // `\s*` after the opening paren and between arguments: prettier puts the
    // path on its own line as soon as the guard list overflows, and a pattern
    // that pinned `router.post('` immediately followed by the path then failed
    // on a route that had not moved.
    const POST = String.raw`router\.post\(\s*'`;

    test('the lot owns exactly one contiguous block', () => {
        expect(block.length).toBeGreaterThan(200);
        expect(block).toMatch(new RegExp(POST + ID + String.raw`\/deactivate'`));
        expect(block).toMatch(new RegExp(POST + ID + String.raw`\/reactivate'`));
        expect(block).toMatch(new RegExp(POST + ID + String.raw`\/sessions\/revoke-all'`));
    });

    test('MFA reset is SuperAdmin-only at the router too (defence in depth)', () => {
        expect(block).toMatch(
            new RegExp(POST + ID + String.raw`\/mfa-reset',\s*requireSuperAdmin`)
        );
    });

    test('the list-level paths are NOT shadowed by an earlier registration', () => {
        for (const p of ['/admin/admin-accounts/export.csv', '/admin/admin-accounts/bulk']) {
            const hits = ROUTES.split('\n').filter((l) => l.includes(`'${p}'`));
            expect(hits).toHaveLength(1);
        }
        // `/admins/:id` is registered before this block: a literal segment under
        // /admins/ would be read as an id (Postgres answered pg_strtoint64_safe).
        expect(block).not.toMatch(/router\.get\(\s*'\/admins\/export/);
        // …and /admin/accounts/* belongs to the EMPLOYEE console (Lot B).
        const employeeConsole = ROUTES.search(/router\.get\(\s*'\/admin\/accounts\/export\.csv'/);
        expect(employeeConsole).toBeGreaterThan(-1);
        expect(employeeConsole).toBeLessThan(ROUTES.indexOf('// ---- SECTION access —'));
        expect(INDEX_VIEW).toContain('/admin/admin-accounts/export.csv');
        expect(INDEX_VIEW).toContain('/admin/admin-accounts/bulk');
        expect(INDEX_VIEW).not.toContain('/admin/accounts/export.csv');
    });
});

describe('Lot C — /admins answers the access-review questions', () => {
    test('last sign-in, locked, MFA, expiry are on the row', () => {
        expect(INDEX_VIEW).toMatch(/adm_chip_locked/);
        expect(INDEX_VIEW).toMatch(/adm_expired_on/);
        expect(INDEX_VIEW).toMatch(/lastLoginAt/);
        expect(INDEX_VIEW).toMatch(/mfaEnrolled/);
    });

    test('the four filters, the sortable headers and the export are present', () => {
        for (const name of ['role', 'siteId', 'profile', 'state']) {
            expect(INDEX_VIEW).toMatch(new RegExp(`name="${name}"`));
        }
        expect(INDEX_VIEW).toMatch(/class="sortable"/);
        expect(INDEX_VIEW).toMatch(/adm_export_csv/);
    });

    test('a locked row unlocks from the list, an expiring one extends from it', () => {
        expect(INDEX_VIEW).toMatch(/\/unlock" method="POST"/);
        expect(INDEX_VIEW).toMatch(/\/extend-access" method="POST"/);
    });

    test('the delegation view is linked from the console (the sidebar is another lot)', () => {
        expect(INDEX_VIEW).toContain('href="/admin/delegation"');
        expect(typeof FR.adm_delegation_link).toBe('string');
        expect(typeof EN.adm_delegation_link).toBe('string');
    });

    test('"Supprimer" is gone: the console deactivates with a mandatory reason', () => {
        expect(SHOW_VIEW).toMatch(/\/deactivate" method="POST"/);
        expect(SHOW_VIEW).toMatch(/data-confirm-reason="reason"/);
        expect(SHOW_VIEW).toMatch(/\/reactivate" method="POST"/);
        expect(SHOW_VIEW).not.toMatch(/\/delete" method="POST"/);
    });

    test('no native confirm()/prompt() left in the three console views', () => {
        for (const v of [INDEX_VIEW, SHOW_VIEW, DELEG_VIEW]) {
            const stripped = v.replace(/<%#[\s\S]*?%>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            expect(stripped).not.toMatch(/(^|[^.\w])confirm\(/);
            expect(stripped).not.toMatch(/(^|[^.\w])prompt\(/);
        }
    });

    test('region is offered as a scope grain, and an unknown provenance is labelled', () => {
        expect(SHOW_VIEW).toMatch(/value="region"/);
        expect(SHOW_VIEW).toMatch(/deleg_origin_unknown/);
        expect(SHOW_VIEW).toMatch(/adm_history_origin_backfill/);
        expect(typeof FR.deleg_origin_unknown).toBe('string');
        expect(typeof EN.deleg_origin_unknown).toBe('string');
    });
});

describe('Lot C — the access review attests, and says how far it got', () => {
    test('attestation column, decision and "N of M reviewed"', () => {
        expect(REVIEW_VIEW).toMatch(/ar_th_attested/);
        expect(REVIEW_VIEW).toMatch(/ar_decision_appropriate/);
        expect(REVIEW_VIEW).toMatch(/ar_decision_revoke/);
        expect(REVIEW_VIEW).toMatch(/ar_progress/);
        expect(FR.ar_progress).toMatch(/\{\{n\}\}/);
        expect(EN.ar_progress).toMatch(/\{\{n\}\}/);
    });

    test('"locked out" is one of the named exceptions', () => {
        expect(REVIEW_VIEW).toMatch(/ar_exc_locked/);
        expect(typeof FR.ar_exc_locked).toBe('string');
    });

    test('the delegation page speaks through keys, never a hardcoded French string', () => {
        const svc = read('src/services/DelegationService.js');
        expect(svc).not.toMatch(
            /Compte désactivé|Accès total|Périmètre sans aucun droit|Organisation entière/
        );
        expect(svc).toMatch(/labelKey|key:/);
        expect(DELEG_VIEW).toMatch(/enumLabel\('admin_role'/); // no raw enum on the page
        expect(DELEG_VIEW).toMatch(/data-table-search/);
    });

    test('every adm_/ap_/ar_/deleg_ key exists in both locales', () => {
        const keys = Object.keys(FR).filter((k) => /^(adm_|ap_|ar_|deleg_)/.test(k));
        expect(keys.length).toBeGreaterThan(60);
        keys.forEach((k) => expect(typeof EN[k]).toBe('string'));
        Object.keys(EN)
            .filter((k) => /^(adm_|ap_|ar_|deleg_)/.test(k))
            .forEach((k) => expect(typeof FR[k]).toBe('string'));
    });
});

describe('Lot C — migration 110 is additive, idempotent and stamped', () => {
    test('every DDL statement is re-runnable', () => {
        const ddl = MIGRATION.split('\n').filter((l) => /^\s*(ALTER|CREATE)/.test(l));
        expect(ddl.length).toBeGreaterThan(8);
        ddl.forEach((l) => expect(l).toMatch(/IF NOT EXISTS|IF EXISTS|ADD CONSTRAINT/));
        // constraints are dropped before being (re)added
        const adds = MIGRATION.match(/ADD CONSTRAINT (\w+)/g) || [];
        adds.forEach((a) => {
            const name = a.replace('ADD CONSTRAINT ', '');
            expect(MIGRATION).toContain(`DROP CONSTRAINT IF EXISTS ${name}`);
        });
    });

    test('it never drops a column or deletes a row', () => {
        expect(MIGRATION).not.toMatch(/DROP COLUMN|DELETE FROM|TRUNCATE/);
    });

    test('a revoked row must carry its reason (both or neither)', () => {
        expect(MIGRATION).toMatch(/revoked_at IS NULL AND revoke_reason IS NULL/);
        expect(MIGRATION).toMatch(/length\(btrim\(revoke_reason\)\) > 0/);
    });

    test('the backfill is labelled as such and cannot double-insert', () => {
        const insert = MIGRATION.slice(
            MIGRATION.indexOf('INSERT INTO public.admin_access_events'),
            MIGRATION.indexOf('-- 4) Lockout tunables')
        );
        expect(insert).toMatch(/'backfill'/);
        expect(insert).toMatch(/ADMIN_CREATED', 'ADMIN_UPDATED'/);
        // the guard is on the EVENT table, and it is a plain NOT EXISTS
        expect(insert).toMatch(
            /WHERE NOT EXISTS \(\s*SELECT 1 FROM public\.admin_access_events ev/
        );
        expect(insert).not.toMatch(/WHERE true/);
    });

    test('the two lockout settings are seeded, once', () => {
        for (const key of ['maxLoginAttempts', 'loginLockoutMinutes']) {
            expect(MIGRATION).toContain(`'${key}'`);
        }
        expect(
            MIGRATION.match(/WHERE NOT EXISTS \(SELECT 1 FROM public\.app_settings/g) || []
        ).toHaveLength(2);
    });

    test('it ends with the schema_meta stamp under its own file name', () => {
        expect(MIGRATION.trim()).toMatch(
            /INSERT INTO schema_meta\(key, value\) VALUES \('110_admin_governance', 'applied'\)[\s\S]*ON CONFLICT \(key\) DO UPDATE[\s\S]*;$/
        );
    });
});

describe('Lot C — the operator documentation follows the feature', () => {
    test('help.js has the delegation panel', () => {
        const help = read('public/js/help.js');
        expect(help).toMatch(/'\/admin\/delegation': \{/);
        const panel = help.slice(
            help.indexOf("'/admin/delegation': {"),
            help.indexOf("'/admin/delegation': {") + 4000
        );
        expect(panel).toMatch(/title: L\(/);
        expect(panel).toMatch(/Délégation d/);
    });

    test('the user guide states the deactivate/reactivate rule in both languages', () => {
        const guide = read('src/config/userGuideContent.js');
        expect(guide).toMatch(/Désactiver, jamais supprimer/);
        expect(guide).toMatch(/Deactivate, never delete/);
        expect(guide).toMatch(/\/admin\/delegation/);
    });
});
