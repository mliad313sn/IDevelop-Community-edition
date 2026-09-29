'use strict';

/**
 * Lot E — Language, IA and daily ergonomics sweep.
 *
 * These pin the RULES the lot closed, not the prose:
 *   - no English sentence left hard-coded on the three screens that were 100 % EN
 *     (L6-09), on /about (L4-15) or in the session-device description (L6-12);
 *   - every native confirm()/prompt() is gone from views/** (L6-19);
 *   - /admins/:id* only matches a numeric id (L6-24);
 *   - /account/my-access and /action-center redirect (L5C-07);
 *   - /setup is SuperAdmin-only (L5C-08) and its banner follows it;
 *   - the 403 page names contactable SuperAdmins by DISPLAY NAME, never a demo
 *     login and never an e-mail (L5C-12);
 *   - every sidebar href has a help entry (L6-21);
 *   - manage_invitations exists and costs no existing delegate their reach (L6-31);
 *   - the self-assessment counters are server-rendered (L5B-01);
 *   - "Tous les sites" disappears for a one-site scope (L5C-14).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FR = require('../../locales/fr/admin.json');
const EN = require('../../locales/en/admin.json');
const FR_CHROME = require('../../locales/fr/chrome.json');
const EN_CHROME = require('../../locales/en/chrome.json');
const FR_DM = require('../../locales/fr/datamgmt.json');
const EN_DM = require('../../locales/en/datamgmt.json');

describe('L6-09 / L4-15 — the English screens speak the session language', () => {
    const apiKeys = read('views/pages/admin/api-keys.ejs');
    const sso = read('views/pages/app-settings/sso.ejs');
    const sqlc = read('views/pages/data-management/sql-console.ejs');
    const about = read('views/pages/about.ejs');

    test('no hard-coded English sentence survives on the four rewritten views', () => {
        // A sentence = two or more capitalised/lower English words OUTSIDE an EJS tag.
        const visibleProse = (src) =>
            src
                .replace(/<%[\s\S]*?%>/g, ' ') // EJS expressions (they are keys)
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&[a-z#0-9]+;/g, ' ');
        for (const [name, src] of [
            ['api-keys', apiKeys],
            ['sso', sso],
            ['sql-console', sqlc],
            ['about', about],
        ]) {
            const prose = visibleProse(src);
            for (const phrase of [
                'Issued keys',
                'Create key',
                'Last used',
                'Master switch',
                'Back to Settings',
                'Save SSO settings',
                'Restore points',
                'Dry run',
                'Sovereignty',
                'Application version',
                'Enabled',
                'Disabled',
                'Copy this key now',
            ]) {
                expect(`${name}: ${prose.includes(phrase)}`).toBe(`${name}: false`);
            }
        }
    });

    test('the keys those views use exist in BOTH locales, non-empty', () => {
        const used = [apiKeys, sso, sqlc, about].join('\n');
        const keys = [...used.matchAll(/__\('(admin|chrome|datamgmt):([a-z0-9_.]+)'/g)];
        expect(keys.length).toBeGreaterThan(80);
        const dict = { admin: [FR, EN], chrome: [FR_CHROME, EN_CHROME], datamgmt: [FR_DM, EN_DM] };
        const missing = [];
        for (const [, ns, key] of keys) {
            const [fr, en] = dict[ns];
            if (!fr[key] || !en[key]) missing.push(`${ns}:${key}`);
        }
        expect(missing).toEqual([]);
    });

    test('the SSO field labels resolve through a key with the English structure as default', () => {
        const svc = read('src/services/SsoSettingsService.js');
        expect(svc).toMatch(/labelKeyFor\(p\.key, f\.name\)/);
        expect(svc).toMatch(/SSO_FIELD_KEY_OVERRIDES/);
        expect(sso).toMatch(
            /__\('admin:' \+ \(f\.labelKey \|\| ''\), \{ defaultValue: f\.label \}\)/
        );
        for (const k of [
            'sso_f_clientId',
            'sso_f_clientSecret',
            'sso_f_label',
            'sso_f_saml_issuer',
        ]) {
            expect(FR[k]).toBeTruthy();
            expect(EN[k]).toBeTruthy();
        }
    });

    test('L6-12 — the session device description is built from locale keys', () => {
        const auth = read('src/controllers/AuthController.js');
        expect(auth).toMatch(/function describeDevice\(ua, req\)/);
        expect(auth).not.toMatch(/return 'Unknown device'/);
        expect(auth).not.toMatch(/'Unknown OS'/);
        expect(auth).toMatch(/sess_device_on/);
        for (const k of [
            'sess_device_unknown',
            'sess_os_unknown',
            'sess_browser_generic',
            'sess_device_on',
        ]) {
            expect(FR_CHROME[k]).toBeTruthy();
            expect(EN_CHROME[k]).toBeTruthy();
        }
    });

    test('L6-09 — setting descriptions come from locale keys, DB text is the fallback', () => {
        const view = read('views/pages/app-settings/index.ejs');
        expect(view).toMatch(/const settingDesc = /);
        expect(view).toMatch(/admin:set_desc_/);
        expect(view).not.toMatch(/setting\.description \|\| __\('admin:no_description_setting'\)/);
        // a representative sample of the 73 settings actually on this instance
        for (const k of [
            'set_desc_emailOnCoaching',
            'set_desc_onboarding_allowedDomains',
            'set_desc_onboarding_enabled',
            'set_desc_copilotTimeoutMs',
        ]) {
            expect(FR[k]).toBeTruthy();
            expect(EN[k]).toBeTruthy();
            expect(FR[k]).not.toBe(EN[k]);
        }
    });

    test('L6-20 — the five untitled pages pass a title', () => {
        expect(read('src/routes/index.js')).toMatch(/chrome:pt_api_keys/);
        expect(read('src/routes/v2-lms.js')).toMatch(/chrome:pt_lms_hub/);
        expect(read('src/routes/v2-continuity.js')).toMatch(/chrome:pt_continuity/);
        expect(read('src/routes/v2-capability.js')).toMatch(/chrome:pt_talent_suite/);
        expect(read('src/controllers/MakerCheckerController.js')).toMatch(
            /chrome:pt_approvals_queue/
        );
    });
});

describe('L6-19 — one confirmation component, no native dialog left in a view', () => {
    function strip(src) {
        return (
            src
                .replace(/<%#[\s\S]*?%>/g, ' ')
                .replace(/<!--[\s\S]*?-->/g, ' ')
                .replace(/\/\*[\s\S]*?\*\//g, ' ')
                // CRLF tree: `.*$` never reaches a `\r`, so split on /\r?\n/
                .split(/\r?\n/)
                .map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
                .join('\n')
        );
    }
    function walk(dir, out = []) {
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) walk(p, out);
            else if (f.endsWith('.ejs')) out.push(p);
        }
        return out;
    }

    test('views/**/*.ejs contain ZERO native confirm()/prompt()/window.confirm() call sites', () => {
        const offenders = [];
        for (const p of walk(path.join(ROOT, 'views'))) {
            const st = strip(fs.readFileSync(p, 'utf8'));
            const bare = (st.match(/(?:^|[^A-Za-z0-9_.$])(?:confirm|prompt)\s*\(/g) || []).length;
            const win = (st.match(/window\.(?:confirm|prompt)\s*\(/g) || []).length;
            if (bare + win) offenders.push(`${path.relative(ROOT, p)}: ${bare + win}`);
        }
        expect(offenders).toEqual([]);
    });

    test('the destructive ones carry a MANDATORY reason (data-confirm-reason)', () => {
        expect(read('views/pages/admins/show.ejs')).toMatch(
            /revoke-access[\s\S]{0,240}data-confirm-reason="reason"/
        );
        expect(read('views/pages/employees/show.ejs')).toMatch(
            /revoke-access[\s\S]{0,240}data-confirm-reason="reason"/
        );
    });
});

describe('L1-09 — revoking admin access is a STATE with a reason, never a delete', () => {
    const svc = read('src/services/AccountLinkService.js');

    test('the non-hardDelete branch revokes-and-keeps instead of deleting', () => {
        const fn = svc.slice(
            svc.indexOf('async function revokeAdminAccess'),
            svc.indexOf('/** The admin account promoted')
        );
        expect(fn).toMatch(/revokeAllForAdmin\(id, why\)/);
        expect(fn).toMatch(/deactivated_at = now\(\)/);
        expect(fn).toMatch(/deactivation_reason = \?/);
        // deleteByAdminId survives ONLY inside the hardDelete branch
        const soft = fn.slice(fn.indexOf('} else {'), fn.indexOf('DELETE FROM user_identities'));
        expect(soft).not.toMatch(/deleteByAdminId/);
    });

    test('a revocation without a reason is refused with a code', () => {
        const fn = svc.slice(svc.indexOf('async function revokeAdminAccess'));
        expect(fn).toMatch(/code: 'reason_required'/);
    });

    test('the controller translates every outcome code', () => {
        const ctl = read('src/controllers/AdminController.js');
        expect(ctl).toMatch(/flash:adm_revoke_\$\{result\.code/);
        const frFlash = require('../../locales/fr/flash.json');
        const enFlash = require('../../locales/en/flash.json');
        for (const c of [
            'revoked',
            'reason_required',
            'superadmin_only',
            'not_found',
            'last_superadmin',
            'self',
            'failed',
        ]) {
            expect(frFlash[`adm_revoke_${c}`]).toBeTruthy();
            expect(enFlash[`adm_revoke_${c}`]).toBeTruthy();
        }
    });
});

describe('L6-24 / L5C-07 / L5C-08 — routes', () => {
    const routes = read('src/routes/index.js');

    test('every /admins/:id route is constrained to a numeric id', () => {
        const bare = routes
            .split('\n')
            .filter((l) => /router\.(get|post)\('\/admins\/:id(?!\()/.test(l));
        expect(bare).toEqual([]);
        expect((routes.match(/'\/admins\/:id\(\\\\d\+\)/g) || []).length).toBeGreaterThanOrEqual(
            16
        );
    });

    test('the two documented aliases redirect', () => {
        expect(routes).toMatch(
            /router\.get\(\s*'\/account\/my-access'[\s\S]{0,120}redirect\(302, '\/mon-acces'\)/
        );
        expect(routes).toMatch(
            /router\.get\(\s*'\/action-center'[\s\S]{0,120}redirect\(302, '\/notifications'\)/
        );
    });

    test('/setup is SuperAdmin-only and answers with the explanatory 403', () => {
        expect(routes).toMatch(/router\.get\(\s*'\/setup',\s*requireSuperAdminPage/);
        const auth = read('src/middleware/auth.js');
        expect(auth).toMatch(/const requireSuperAdminPage = async \(req, res, next\)/);
        expect(auth).toMatch(/superAdminOnly: true/);
        // and the dashboard banner follows the page, so nobody is nagged to a wall
        expect(read('src/controllers/DashboardController.js')).toMatch(
            /userType === 'admin' && req\.user\.role === 'superadmin'/
        );
    });
});

describe('L5C-12 — the 403 page names a real, contactable person', () => {
    const helper = read('src/utils/contactableAdmins.js');

    test('demo/test/qa logins are excluded and no e-mail is selected', () => {
        const { isFixtureLogin } = require('../../src/utils/contactableAdmins');
        expect(isFixtureLogin('test.super')).toBe(true);
        expect(isFixtureLogin('qa.local')).toBe(true);
        expect(isFixtureLogin('demo.admin')).toBe(true);
        expect(isFixtureLogin('admin')).toBe(false);
        expect(isFixtureLogin('marie.moren')).toBe(false);
        expect(helper).not.toMatch(/a\.email/);
        expect(helper).toMatch(/COALESCE\(a\.is_active, true\) = true/);
        expect(helper).toMatch(/linked_employee_id/);
    });

    test('both refusal paths use the same helper, and employees see it too', () => {
        expect(read('src/middleware/auth.js')).toMatch(
            /contactableAdmins'\)\.contactableGranters\(\)/
        );
        expect(read('src/middleware/rbac.js')).toMatch(
            /contactableAdmins'\)\.contactableGranters\(\)/
        );
        const view = read('views/pages/errors/403-permission.ejs');
        expect(view).toMatch(/<% if \(granters && granters\.length\) \{ %>/);
        expect(view).not.toMatch(/isAdmin && granters/);
        expect(view).toMatch(/g\.displayName/);
    });
});

describe('L6-21 — every sidebar destination has contextual help', () => {
    test('the diff between sidebar hrefs and help.js entries is empty', () => {
        const sidebar = read('views/partials/sidebar.ejs');
        const help = read('public/js/help.js');
        const hrefs = [
            ...new Set(
                [...sidebar.matchAll(/href="(\/[^"<%]*)"/g)]
                    .map((m) => m[1])
                    .filter((h) => !h.startsWith('/lang/'))
            ),
        ];
        const keys = new Set([...help.matchAll(/^\s{8}'(\/[^']*)':\s*\{/gm)].map((m) => m[1]));
        expect(hrefs.length).toBeGreaterThan(40);
        const resolves = (p) => keys.has(p) || [...keys].some((k) => k !== '/' && p.startsWith(k));
        expect(hrefs.filter((h) => !resolves(h))).toEqual([]);
    });

    test('L5B-02 — an employee gets the EMPLOYEE manual, not the admin one', () => {
        const partial = read('views/partials/contextual-help.ejs');
        expect(partial).toMatch(/user && user\.userType === 'employee'/);
        expect(partial).toMatch(/chrome:help_emp_manual_title/);
        expect(partial).toMatch(/chrome:help_e2_open_t/);
        for (const k of [
            'help_emp_manual_title',
            'help_e1_login_d',
            'help_e3_reviews_d',
            'help_e5_help_d',
        ]) {
            expect(FR_CHROME[k]).toBeTruthy();
            expect(EN_CHROME[k]).toBeTruthy();
        }
    });
});

describe('L6-31 — the rail is cut by task and gated on real capabilities', () => {
    const sidebar = read('views/partials/sidebar.ejs');

    test('the four groups exist and the two old ones are gone', () => {
        for (const k of [
            'section_accounts',
            'section_campaigns',
            'section_data',
            'section_settings',
            'section_help',
        ]) {
            expect(sidebar).toContain(`chrome:${k}`);
            expect(FR_CHROME[k]).toBeTruthy();
            expect(EN_CHROME[k]).toBeTruthy();
        }
        expect(sidebar).not.toContain('chrome:section_administration');
        expect(sidebar).not.toContain('chrome:section_configuration');
        // the 13-link wall is gone, so nothing needs to open folded except Talents
        expect(sidebar).toMatch(/CLOSED_BY_DEFAULT = \['section_talent'\]/);
    });

    test('entries are gated through can(), never a hand-written role list', () => {
        expect(sidebar).toMatch(/const _can = \(s\) => \(typeof can === 'function'\) && can\(s\)/);
        for (const slug of [
            'manage_invitations',
            'manage_onboarding',
            'manage_admins',
            'manage_cycles',
            'export_data',
            'import_data',
            'view_system_logs',
            'manage_organization',
            'view_domains_skills',
            'view_roles',
            'view_app_settings',
            'view_employees',
        ]) {
            expect(sidebar).toContain(`_can('${slug}')`);
        }
    });

    test('the pages that had no way in are linked (L1-10, L4-20)', () => {
        for (const href of [
            '/admin/delegation',
            '/setup',
            '/data-management/sql-console',
            '/app-settings/sso',
            '/guide',
            '/about',
        ]) {
            expect(sidebar).toContain(`href="${href}"`);
        }
    });
});

describe('manage_invitations — a real capability that costs no delegate their reach', () => {
    const P = require('../../src/config/permissions');

    test('the slug exists, acts on employees and implies the scoped read', () => {
        expect(P.isValidSlug('manage_invitations')).toBe(true);
        expect(P.expandSlugs(['manage_invitations']).sort()).toEqual([
            'manage_invitations',
            'view_employees',
        ]);
    });

    test('an existing reset_employee_password delegate keeps the invitations console', () => {
        expect(P.expandSlugs(['reset_employee_password'])).toContain('manage_invitations');
        expect(P.expandSlugs(['manage_employees'])).toContain('manage_invitations');
    });

    test('it does NOT grant a password reset by itself', () => {
        expect(P.expandSlugs(['manage_invitations'])).not.toContain('reset_employee_password');
        // the bulk console (which can reset) keeps the stronger grant
        expect(read('src/routes/index.js')).toMatch(
            /'\/admin\/accounts\/bulk',\s*requirePermission\('reset_employee_password'\)/
        );
    });

    test('its label and description are translated in both locales', () => {
        expect(FR.perm.manage_invitations.label).toBeTruthy();
        expect(EN.perm.manage_invitations.label).toBeTruthy();
        expect(FR.perm.manage_invitations.desc).not.toBe(EN.perm.manage_invitations.desc);
    });
});

describe('rule 1 — a measured number, never a placeholder', () => {
    test('L5B-01 — the self-assessment counters are rendered by the server', () => {
        const ctl = read('src/controllers/EmployeePortalController.js');
        expect(ctl).toMatch(/const saTotal = \(skillsWithAssessments \|\| \[\]\)\.length/);
        expect(ctl).toMatch(/selfRatedLevel != null/);
        expect(ctl).toMatch(/saEstimateMin: Math\.max\(1,/);
        const view = read('views/pages/employee/self-assessment.ejs');
        expect(view).toMatch(/id="saRatedCount"><%= saRated %>/);
        expect(view).toMatch(/id="saTotalCount"><%= saTotal %>/);
        expect(view).not.toMatch(/id="saRatedCount">0</);
        expect(view).not.toMatch(/id="saTotalCount">0</);
    });

    test('L5C-14 — "all sites" is hidden when the scope resolves to one site', () => {
        const pages = [
            'views/pages/employees/index.ejs',
            'views/pages/cycles/index.ejs',
            'views/pages/movements/index.ejs',
            'views/pages/qualified/index.ejs',
            'views/pages/admins/accounts.ejs',
            'views/pages/skill-matrix/index.ejs',
            'views/pages/lifecycle/index.ejs',
            'views/pages/dashboard.ejs',
            'views/pages/maker-checker/index.ejs',
        ];
        for (const p of pages) {
            expect(`${p}:${/\.length !== 1\) \{ %>/.test(read(p))}`).toBe(`${p}:true`);
        }
    });

    test('L6-16 — the framework weight is measured, and absent when there is nothing to measure', () => {
        const ctl = read('src/controllers/DomainController.js');
        expect(ctl).toMatch(
            /sd\.weightPct =\s*d\.skillCount > 0\s*\?\s*Math\.round\(\(sd\.skills\.length \/ d\.skillCount\) \* 100\)\s*:\s*null/
        );
        const view = read('views/pages/domains-skills/index.ejs');
        expect(view).toMatch(/sd\.weightPct !== null/);
        expect(view).toMatch(/framework:col_weight/);
        expect(view).toMatch(/framework:label_weight/);
        const frF = require('../../locales/fr/framework.json');
        const enF = require('../../locales/en/framework.json');
        expect(frF.col_weight).toBeTruthy();
        expect(enF.col_weight).toBeTruthy();
    });
});
