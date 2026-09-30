'use strict';

/**
 * 3.23.18 — lane U-navigation (UX-03 / UX-17 / UX-05).
 *
 * Behavioural: the REAL sidebar/header partials are rendered with ejs for an
 * employee, a manager, two local admins, a viewer and a SuperAdmin (fake
 * `user` / `can` / `wsVisible` locals), and the rendered HTML is read.
 *
 *   (a) the rail is short: an employee meets ≤ 6 top entries, a manager ≤ 20;
 *   (b) nothing a role could not reach before becomes visible — the new href
 *       set is a subset of the old one (+ the person's own profile, /account,
 *       which is requireAuth for everyone);
 *   (c) nothing a role could reach before disappears — every old href is still
 *       in the rail (as an entry or inside a hub's sub-list);
 *   the five "review" pages sit under ONE hub; each destination has its own
 *   icon; there is ONE account menu; the fold state survives a language switch.
 *
 * BEFORE is the href set the pre-3.23.18 sidebar rendered for each config
 * (captured by rendering that template with these exact locals).
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const SIDEBAR = path.join(ROOT, 'views/partials/sidebar.ejs');
const HEADER = path.join(ROOT, 'views/partials/header.ejs');
const FR = require('../../locales/fr/chrome.json');
const EN = require('../../locales/en/chrome.json');

const ROLES = {
    employee: { user: { userType: 'employee', username: 'emp' }, perms: [] },
    manager: { user: { userType: 'manager', username: 'mgr' }, perms: [] },
    localadmin_ops: {
        user: { userType: 'admin', role: 'localadmin', username: 'la1' },
        perms: [
            'view_employees',
            'manage_cycles',
            'view_compliance',
            'view_app_settings',
            'view_system_logs',
            'export_data',
        ],
    },
    localadmin_people: {
        user: { userType: 'admin', role: 'localadmin', username: 'la2' },
        perms: [
            'manage_invitations',
            'manage_onboarding',
            'manage_admins',
            'view_employees',
            'view_continuity',
            'configure_lms',
            'view_domains_skills',
            'view_roles',
            'manage_organization',
            'import_data',
        ],
    },
    localadmin_none: {
        user: { userType: 'admin', role: 'localadmin', username: 'la3' },
        perms: [],
    },
    viewer: { user: { userType: 'admin', role: 'viewer', username: 'v' }, perms: [] },
    superadmin: { user: { userType: 'admin', role: 'superadmin', username: 'sa' }, perms: '*' },
};

const E = [
    '/about',
    '/employee/assessment-status',
    '/employee/dashboard',
    '/employee/my-certifications',
    '/employee/my-coaching',
    '/employee/my-development',
    '/employee/my-learning',
    '/employee/my-progress',
    '/employee/okr',
    '/employee/opportunities',
    '/employee/self-assessment',
    '/employee/supervisor-reviews',
    '/guide',
    '/notifications',
];
const MGMT = [
    '/benchmark',
    '/coaching/plans',
    '/dashboard',
    '/exec/board-pack',
    '/exec/site-exposure',
    '/movements',
    '/org-chart',
    '/qualified',
    '/reports/builder',
    '/reports/dept-analytics',
    '/supervisor/gap-analysis',
    '/supervisor/self-assessment-reviews',
    '/talent/actions',
    '/talent/career-path',
    '/talent/nine-box',
];
const V2_TEAM = ['/v2/idp/manage', '/v2/lifecycle', '/v2/pip', '/v2/slf/disputes'];
const SA_ONLY = [
    '/admin/access-review',
    '/admin/api-keys',
    '/admin/health',
    '/admin/license',
    '/admin/maintenance',
    '/admin/notifications',
    '/admin/sessions',
    '/admin/sso-migration',
    '/app-settings/sso',
    '/data-management/sql-console',
    '/setup',
];

// Captured from the pre-change template (views/partials/sidebar.ejs @ 3.23.17).
const BEFORE = {
    'employee|v2=false|lc=false': [...E, '/assessment-changes'],
    'employee|v2=true|lc=true': [...E, '/assessment-changes'],
    'manager|v2=false|lc=false': [
        ...E,
        ...MGMT,
        '/about',
        '/assessment-changes',
        '/cancellations',
        '/compliance',
        '/employees',
        '/reviews/post-approval',
        '/skill-matrix',
        '/supervisor/dashboard',
    ],
    'manager|v2=true|lc=true': [
        ...E,
        ...MGMT,
        ...V2_TEAM,
        '/assessment-changes',
        '/cancellations',
        '/compliance',
        '/employees',
        '/reviews/post-approval',
        '/skill-matrix',
        '/supervisor/dashboard',
        '/exec/key-person',
        '/reports/local-content',
        '/v2/cap',
        '/v2/continuity',
    ],
    'localadmin_ops|v2=false|lc=false': [
        ...MGMT,
        '/about',
        '/guide',
        '/notifications',
        '/app-settings',
        '/assessment-changes',
        '/cancellations',
        '/compliance',
        '/cycles',
        '/data-management',
        '/employees',
        '/reviews/post-approval',
        '/skill-matrix',
        '/system-logs',
    ],
    'localadmin_ops|v2=true|lc=true': [
        ...MGMT,
        ...V2_TEAM,
        '/about',
        '/guide',
        '/notifications',
        '/app-settings',
        '/assessment-changes',
        '/cancellations',
        '/compliance',
        '/cycles',
        '/data-management',
        '/employees',
        '/reviews/post-approval',
        '/skill-matrix',
        '/system-logs',
        '/reports/local-content',
    ],
    'localadmin_people|v2=false|lc=false': [
        ...MGMT,
        '/about',
        '/guide',
        '/notifications',
        '/admin/accounts',
        '/admin/delegation',
        '/admins',
        '/data-management',
        '/domains-skills',
        '/employees',
        '/onboarding',
        '/organization',
        '/roles',
        '/skill-matrix',
    ],
    'localadmin_people|v2=true|lc=true': [
        ...MGMT,
        ...V2_TEAM,
        '/about',
        '/guide',
        '/notifications',
        '/admin/accounts',
        '/admin/delegation',
        '/admins',
        '/data-management',
        '/domains-skills',
        '/employees',
        '/onboarding',
        '/organization',
        '/roles',
        '/skill-matrix',
        '/exec/key-person',
        '/reports/local-content',
        '/v2/cap',
        '/v2/continuity',
        '/v2/lms',
    ],
    'localadmin_none|v2=false|lc=false': [...MGMT, '/about', '/guide', '/notifications'],
    'localadmin_none|v2=true|lc=true': [
        ...MGMT,
        ...V2_TEAM,
        '/about',
        '/guide',
        '/notifications',
        '/reports/local-content',
    ],
    'viewer|v2=false|lc=false': [...MGMT, '/about', '/guide', '/notifications'],
    'viewer|v2=true|lc=true': [
        ...MGMT,
        ...V2_TEAM,
        '/about',
        '/guide',
        '/notifications',
        '/reports/local-content',
    ],
    'superadmin|v2=false|lc=false': [
        ...MGMT,
        ...SA_ONLY,
        '/about',
        '/guide',
        '/notifications',
        '/admin/accounts',
        '/admin/delegation',
        '/admins',
        '/app-settings',
        '/assessment-changes',
        '/cancellations',
        '/compliance',
        '/cycles',
        '/data-management',
        '/domains-skills',
        '/employees',
        '/onboarding',
        '/organization',
        '/reviews/post-approval',
        '/roles',
        '/skill-matrix',
        '/system-logs',
    ],
    'superadmin|v2=true|lc=true': [
        ...MGMT,
        ...SA_ONLY,
        ...V2_TEAM,
        '/about',
        '/guide',
        '/notifications',
        '/admin/accounts',
        '/admin/delegation',
        '/admins',
        '/app-settings',
        '/assessment-changes',
        '/cancellations',
        '/compliance',
        '/cycles',
        '/data-management',
        '/domains-skills',
        '/employees',
        '/onboarding',
        '/organization',
        '/reviews/post-approval',
        '/roles',
        '/skill-matrix',
        '/system-logs',
        '/exec/key-person',
        '/reports/local-content',
        '/v2/cap',
        '/v2/continuity',
        '/v2/lms',
        '/v2/uam/maker-checker/queue',
    ],
};
// The only destinations the new rail may ADD: the person's own profile, open to
// every signed-in account (routes/index.js: router.get('/account', requireAuth…)),
// and the 3.23.18 safety-clearances page, for admins holding a compliance grant
// and SuperAdmins (its route: requireManagerOrAnyPermission view/manage_compliance).
// « Mes données » (/employee/my-data) is the person's OWN data register — the
// route is requireEmployeeOrManager and keys on req.user.id — so it is a
// legitimate addition for exactly the two accounts that have a « mine » section.
// Administration → Modules (/admin/modules) is the SuperAdmin's switchboard for
// the optional modules that replaced the boot-time V2_FEATURES gate — its route
// is requireSuperAdminPage, so it is a legitimate SuperAdmin-only addition.
const ALLOWED_ADDITIONS = {
    employee: ['/account', '/employee/my-data'],
    manager: ['/employee/my-data'],
    localadmin_ops: ['/safety-gate'],
    superadmin: ['/safety-gate', '/admin/modules'],
};

// Destinations added by optional modules AFTER the BEFORE sets were captured,
// visible only while their module is on (the `v2=true` configs):
//  - « Mon feedback 360° » (/feedback-360, development) and « Mes entretiens
//    1:1 » (/one-on-one, engagement): the person's OWN space, for the two
//    accounts that have a « mine » section;
//  - the 360° console (/feedback-360/manage, development) in the team plans hub,
//    for every account that sees that hub (managers and admins — the route is
//    requireManagerOrAdmin and lists only rounds inside the caller's scope).
const MODULE_ADDITIONS = {
    employee: ['/feedback-360', '/one-on-one'],
    manager: ['/feedback-360', '/one-on-one', '/feedback-360/manage'],
    localadmin_ops: ['/feedback-360/manage'],
    localadmin_people: ['/feedback-360/manage'],
    localadmin_none: ['/feedback-360/manage'],
    viewer: ['/feedback-360/manage'],
    superadmin: ['/feedback-360/manage'],
};

// Optional modules (config/modules.js). The BEFORE sets were captured with the
// old `v2Features` local: `v2=true` is now "every module on" (what V2_FEATURES=1
// still forces), and `v2=false` is a FRESH install at adoption stage 1
// (campaigns only). Two deliberate differences from the old v2=false rail:
//  - /v2/slf/disputes and /v2/uam/maker-checker/queue are CORE now (their
//    routers are always mounted, never behind a module), so they may appear;
//  - the pre-V2 employee OKR / coaching / growth pages and the coaching console
//    belong to the engagement, development and mobility modules, which stage 1
//    leaves off, so they are expected to disappear.
const ALL_MODULES_ON = {
    campaigns: true,
    development: true,
    talent: true,
    mobility: true,
    engagement: true,
    ai: true,
};
const STAGE_1 = {
    campaigns: true,
    development: false,
    talent: false,
    mobility: false,
    engagement: false,
    ai: false,
};
const CORE_NOW = ['/v2/slf/disputes', '/v2/uam/maker-checker/queue'];
const STAGE_1_HIDDEN = [
    '/employee/okr',
    '/employee/my-coaching',
    '/employee/opportunities',
    '/coaching/plans',
];

function locals(role, { v2, lc, ws = true, currentPath = '/nowhere', lang = 'fr' }) {
    const r = ROLES[role];
    return {
        user: r.user,
        can: (s) => r.perms === '*' || r.perms.includes(s),
        wsVisible: () => ws,
        appModules: { ...(v2 ? ALL_MODULES_ON : STAGE_1), localContent: !!lc },
        sqlConsoleEnabled: true,
        featureLocalContent: lc,
        currentPath,
        __: (k, o) => k + (o && o.name !== undefined ? '|' + o.name : ''),
        cspNonce: 'n',
        csrfToken: 't',
        lang,
    };
}
const render = (file, L) => ejs.render(fs.readFileSync(file, 'utf8'), L, { filename: file });
const navOf = (html) => html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
const hrefs = (nav) => new Set([...nav.matchAll(/<a\s+href="([^"]+)"/g)].map((m) => m[1]));
/** Top-level rows: entry links that are not sub-links, plus hub buttons. */
function topEntries(nav) {
    const links = [
        ...nav.matchAll(/<a\s+href="[^"]+"\s+class="sidebar-link(?![^"]*sidebar-sublink)[^"]*"/g),
    ];
    const hubs = [...nav.matchAll(/class="sidebar-link sidebar-hub-toggle"/g)];
    return links.length + hubs.length;
}
const CONFIGS = Object.keys(BEFORE).map((k) => {
    const [role, v2, lc] = k.split('|');
    return { key: k, role, v2: v2 === 'v2=true', lc: lc === 'lc=true' };
});

describe('UX-03 — the rail is cut by task and keeps every gate', () => {
    test.each(CONFIGS)('$key: no new visibility, nothing lost', ({ key, role, v2, lc }) => {
        const got = hrefs(navOf(render(SIDEBAR, locals(role, { v2, lc }))));
        const before = new Set(BEFORE[key].filter((h) => v2 || !STAGE_1_HIDDEN.includes(h)));
        const allowed = new Set([
            ...before,
            ...(ALLOWED_ADDITIONS[role] || []),
            ...(v2 ? MODULE_ADDITIONS[role] || [] : []),
            ...(v2 ? [] : CORE_NOW),
        ]);
        // (b) nothing a role could not reach before becomes visible
        expect([...got].filter((h) => !allowed.has(h))).toEqual([]);
        // (c) every destination visible before is still reachable in the rail
        expect([...before].filter((h) => !got.has(h))).toEqual([]);
    });

    test.each(Object.keys(MODULE_ADDITIONS))(
        '%s: the 360° / one-to-one entries follow their modules',
        (role) => {
            const on = hrefs(navOf(render(SIDEBAR, locals(role, { v2: true, lc: false }))));
            const off = hrefs(navOf(render(SIDEBAR, locals(role, { v2: false, lc: false }))));
            for (const h of MODULE_ADDITIONS[role]) {
                expect(`${h}:${on.has(h)}`).toBe(`${h}:true`);
                expect(`${h}:${off.has(h)}`).toBe(`${h}:false`);
            }
        }
    );

    test('/safety-gate: admins with a compliance grant and SuperAdmins only', () => {
        const sees = (role) =>
            hrefs(navOf(render(SIDEBAR, locals(role, { v2: true, lc: true })))).has('/safety-gate');
        expect(sees('superadmin')).toBe(true);
        expect(sees('localadmin_ops')).toBe(true); // holds view_compliance
        for (const r of ['employee', 'manager', 'localadmin_people', 'localadmin_none', 'viewer']) {
            expect(`${r}:${sees(r)}`).toBe(`${r}:false`);
        }
    });

    test('a hidden workspace component hides its links for an admin (wsVisible still honoured)', () => {
        const got = hrefs(
            navOf(render(SIDEBAR, locals('superadmin', { v2: true, lc: true, ws: false })))
        );
        expect([...got].sort()).toEqual(['/about', '/guide', '/notifications']);
    });

    test('(a) an employee meets at most six task entries, in the agreed order', () => {
        const nav = navOf(render(SIDEBAR, locals('employee', { v2: true, lc: true })));
        expect(topEntries(nav)).toBeLessThanOrEqual(6);
        const tops = [
            ...nav.matchAll(/<a\s+href="([^"]+)"\s+class="sidebar-link(?![^"]*sidebar-sublink)/g),
        ].map((m) => m[1]);
        expect(tops).toEqual([
            '/employee/dashboard',
            '/employee/self-assessment',
            '/employee/my-development',
            '/employee/my-learning',
            '/account',
            '/guide',
        ]);
        for (const k of [
            'nav_todo',
            'nav_my_assessments',
            'nav_my_plan',
            'nav_my_learning',
            'menu_my_profile',
            'nav_help',
        ]) {
            expect(nav).toContain(`>chrome:${k}<`);
        }
        // the near-synonyms are no longer top entries: they are sub-links
        for (const h of [
            '/employee/assessment-status',
            '/employee/my-progress',
            '/employee/opportunities',
        ]) {
            expect(nav).toMatch(new RegExp(`href="${h}" class="sidebar-link sidebar-sublink`));
        }
    });

    test.each([
        ['manager', 20],
        ['superadmin', 20],
        ['localadmin_people', 20],
    ])('(a) %s sees at most %i top-level rows (was ~45 / ~56 flat links)', (role, max) => {
        const nav = navOf(render(SIDEBAR, locals(role, { v2: true, lc: true })));
        expect(topEntries(nav)).toBeLessThanOrEqual(max);
    });

    test('the review notions sit under ONE « Revues & contestations » hub', () => {
        const nav = navOf(render(SIDEBAR, locals('superadmin', { v2: true, lc: true })));
        const hub = nav.slice(nav.indexOf('data-entry-key="reviews"'));
        const sub = hub.slice(hub.indexOf('id="sbsub-reviews"'), hub.indexOf('</div>'));
        for (const h of [
            '/supervisor/self-assessment-reviews',
            '/assessment-changes',
            '/reviews/post-approval',
            '/v2/slf/disputes',
        ]) {
            expect(sub).toContain(`href="${h}"`);
            // …and nowhere else in the rail: one entry per notion
            expect(nav.split(`href="${h}"`).length - 1).toBe(1);
        }
    });

    test('the section holding the current page opens its hub server-side', () => {
        const nav = navOf(
            render(
                SIDEBAR,
                locals('manager', { v2: true, lc: true, currentPath: '/v2/slf/disputes' })
            )
        );
        expect(nav).toMatch(/sidebar-entry sidebar-hub is-open" data-entry-key="reviews"/);
        expect(nav).toMatch(
            /href="\/v2\/slf\/disputes" class="sidebar-link sidebar-sublink active"/
        );
    });

    test.each(Object.keys(ROLES))('UX-17 — %s: every destination has its own icon', (role) => {
        const nav = navOf(render(SIDEBAR, locals(role, { v2: true, lc: true })));
        const byIcon = new Map();
        for (const m of nav.matchAll(
            /<a\s+href="([^"]+)"[^>]*>\s*<i class="fas (fa-[a-z0-9-]+)"/g
        )) {
            const set = byIcon.get(m[2]) || new Set();
            set.add(m[1]);
            byIcon.set(m[2], set);
        }
        const shared = [...byIcon]
            .filter(([, s]) => s.size > 1)
            .map(([i, s]) => `${i}: ${[...s].join(', ')}`);
        expect(shared).toEqual([]);
    });

    test('every section carries a stable data-section-key', () => {
        const nav = navOf(render(SIDEBAR, locals('superadmin', { v2: true, lc: true })));
        const sections = nav.match(/<div class="sidebar-section"[^>]*>/g);
        expect(sections.length).toBeGreaterThan(3);
        for (const s of sections) expect(s).toMatch(/data-section-key="section_[a-z_]+"/);
    });
});

describe('UX-17 — the fold state is keyed on data-section-key, not on the translated label', () => {
    // A tiny DOM stand-in, enough for the rail script: sections with a label
    // button (whose TEXT depends on the language) and entries with a toggle.
    function fakeClassList(initial = []) {
        const s = new Set(initial);
        return {
            add: (c) => s.add(c),
            remove: (c) => s.delete(c),
            contains: (c) => s.has(c),
            toggle: (c, on) => {
                const v = on === undefined ? !s.has(c) : !!on;
                if (v) s.add(c);
                else s.delete(c);
                return v;
            },
        };
    }
    function fakeButton(text) {
        const attrs = {};
        const handlers = [];
        return {
            textContent: text,
            setAttribute: (k, v) => {
                attrs[k] = String(v);
            },
            getAttribute: (k) => (k in attrs ? attrs[k] : null),
            addEventListener: (_e, fn) => handlers.push(fn),
            click() {
                handlers.forEach((fn) => fn());
            },
        };
    }
    function build(lang) {
        const label = {
            section_talent: { fr: 'Talents', en: 'Talent' },
            section_reports: { fr: 'Rapports', en: 'Reports' },
        };
        const sections = Object.keys(label).map((key) => {
            const btn = fakeButton(label[key][lang]);
            return {
                key,
                btn,
                classList: fakeClassList(),
                getAttribute: (a) => (a === 'data-section-key' ? key : null),
                querySelector: (sel) => (sel === '.sidebar-section-label' ? btn : null),
            };
        });
        const toggle = fakeButton(lang === 'fr' ? 'Revues & contestations' : 'Reviews & disputes');
        const entry = {
            classList: fakeClassList(),
            getAttribute: (a) => (a === 'data-entry-key' ? 'reviews' : null),
            querySelector: (sel) => (sel.includes('toggle') ? toggle : null),
        };
        const nav = {
            classList: fakeClassList(),
            querySelectorAll: (sel) =>
                sel === '.sidebar-section' ? sections : sel === '.sidebar-entry' ? [entry] : [],
        };
        return { nav, sections, entry, toggle };
    }
    function runScript(dom, storage) {
        const html = render(SIDEBAR, locals('manager', { v2: true, lc: true }));
        const src = html.match(/<script nonce="n">([\s\S]*?)<\/script>/)[1];
        const document = { querySelector: () => dom.nav, body: { classList: fakeClassList() } };
        const localStorage = {
            getItem: (k) => (k in storage ? storage[k] : null),
            setItem: (k, v) => {
                storage[k] = v;
            },
        };
        new Function('document', 'localStorage', 'window', src)(document, localStorage, {});
    }

    test('a group opened / an entry unfolded in French is still so after switching to English', () => {
        const storage = {};
        const fr = build('fr');
        runScript(fr, storage);
        const talentFr = fr.sections.find((s) => s.key === 'section_talent');
        expect(talentFr.btn.getAttribute('aria-expanded')).toBe('false'); // folded by default
        talentFr.btn.click();
        fr.sections.find((s) => s.key === 'section_reports').btn.click(); // close Rapports
        fr.toggle.click(); // unfold the reviews hub

        const en = build('en');
        runScript(en, storage);
        expect(
            en.sections.find((s) => s.key === 'section_talent').btn.getAttribute('aria-expanded')
        ).toBe('true');
        expect(
            en.sections.find((s) => s.key === 'section_reports').btn.getAttribute('aria-expanded')
        ).toBe('false');
        expect(en.entry.classList.contains('is-open')).toBe(true);
        expect(en.toggle.getAttribute('aria-expanded')).toBe('true');
    });
});

describe('UX-17 — one account menu', () => {
    test('the sidebar no longer carries a second dropdown; its footer links to the profile', () => {
        const html = render(SIDEBAR, locals('manager', { v2: true, lc: true }));
        expect(html).not.toContain('sidebarUserDropdown');
        expect(html).not.toContain('toggleUserMenu');
        expect(html).toMatch(/<a href="\/account" class="sidebar-user"/);
    });

    test('the header menu offers the same entries to every role (Mon accès: admins only)', () => {
        const menu = (role) => {
            const h = render(HEADER, locals(role, { v2: true, lc: true }));
            const dd = h.slice(h.indexOf('id="userDropdown"'), h.indexOf('</form>'));
            return [...dd.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
        };
        const emp = menu('employee');
        expect(emp).toEqual([
            '/account',
            '/account/notifications',
            '/change-password',
            '/v2/uam/mfa/manage',
            '/account/sessions',
            '/lang/en',
            '/guide',
            '/about',
        ]);
        expect(menu('manager')).toEqual(emp);
        const adm = menu('superadmin');
        expect(adm.filter((h) => h !== '/mon-acces')).toEqual(emp);
        expect(adm).toContain('/mon-acces');
    });
});

describe('UX-05 / i18n — French glossary and key parity', () => {
    test('FR speaks French for the talent acronyms; EN keeps English', () => {
        expect(FR.nav_benchmark).toBe('Comparatif des rôles');
        expect(FR.nav_pip).toBe("Plans d'amélioration (PAP)");
        expect(FR.nav_dev_plans).toBe('Plans de développement (PDI)');
        expect(FR.nav_nine_box).toBe('Grille 9 cases');
        for (const k of [
            'nav_benchmark',
            'nav_pip',
            'nav_dev_plans',
            'nav_nine_box',
            'nav_my_okr',
            'nav_talent_actions_title',
        ]) {
            expect(FR[k]).not.toMatch(/\b(PIP|IDP|9-?Box|OKR|Benchmark|Référentiel)\b/i);
        }
        expect(EN.nav_benchmark).toBe('Benchmark');
        expect(EN.nav_pip).toBe('PIP');
    });

    test('every chrome: key the rail and the header use exists in both locales', () => {
        const src = fs.readFileSync(SIDEBAR, 'utf8') + fs.readFileSync(HEADER, 'utf8');
        const keys = [...new Set([...src.matchAll(/__\('chrome:([a-z0-9_]+)'/g)].map((m) => m[1]))];
        expect(keys.length).toBeGreaterThan(60);
        expect(keys.filter((k) => !FR[k] || !EN[k])).toEqual([]);
        expect(Object.keys(FR).sort()).toEqual(Object.keys(EN).sort());
    });
});
