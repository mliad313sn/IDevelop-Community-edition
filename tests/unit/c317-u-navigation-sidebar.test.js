'use strict';

/**
 * The navigation rail, re-expressed for the one navigation config
 * (src/config/navigation.js).
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
const NAV = require('../../src/config/navigation');

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
/**
 * Destinations the config-driven rail ADDS to the BEFORE sets. Every one is a
 * route the role already opens (proven over HTTP by
 * navigationRouteReachability.test.js):
 *  - « À traiter » (/tasks): managers and admins who can act — never a
 *    read-only account (its route sends them home);
 *  - pages that had no menu entry (9-box movements, scheduled reports,
 *    department brief, gaps and readiness reports): requireManagerOrAdmin;
 *  - /safety-gate for managers (the route admits them) and its rules page for
 *    holders of manage_compliance; « Mon habilitation sécurité » for the two
 *    accounts that have a personal space;
 *  - the SuperAdmin's instance pages: modules, HRIS sync, the notification
 *    catalogue and effectiveness (requireSuperAdmin / requireSuperAdminPage);
 *  - training to approve (/v2/lms/uplifts, development module): managers and
 *    configure_lms holders.
 */
const ORPHANS = [
    '/talent/nine-box/movements',
    '/reports/schedules',
    '/reports/dept-brief',
    '/reports/gaps',
    '/reports/readiness',
];
const ADDED = {
    employee: ['/safety-gate/me'],
    manager: ['/tasks', ...ORPHANS, '/safety-gate', '/safety-gate/me'],
    localadmin_ops: ['/tasks', ...ORPHANS, '/safety-gate'],
    localadmin_people: ['/tasks', ...ORPHANS],
    localadmin_none: ['/tasks', ...ORPHANS],
    viewer: [...ORPHANS],
    superadmin: [
        '/tasks',
        ...ORPHANS,
        '/safety-gate',
        '/safety-gate/config',
        '/admin/modules',
        '/admin/integrations/hris',
        '/admin/notifications/catalogue',
        '/admin/notifications/metrics',
    ],
};
// Added while their module is on (the `v2=true` configs).
const MODULE_ADDITIONS = {
    employee: ['/feedback-360', '/one-on-one'],
    manager: ['/feedback-360', '/one-on-one', '/feedback-360/manage', '/v2/lms/uplifts'],
    localadmin_ops: ['/feedback-360/manage'],
    localadmin_people: ['/feedback-360/manage', '/v2/lms/uplifts'],
    localadmin_none: ['/feedback-360/manage'],
    viewer: ['/feedback-360/manage'],
    superadmin: ['/feedback-360/manage', '/v2/lms/uplifts'],
};
/**
 * Removals, each a documented decision (navigation only — every route is
 * unchanged and each page stays reachable another way):
 *  - /notifications: the bell's « Tout voir » and the palette, for everyone;
 *  - the employee's /account and « Mes données »: the account menu (and the
 *    sidebar footer for the profile);
 *  - a manager's /employee/dashboard (« À faire »): replaced by « À traiter »,
 *    which lists the manager's own actions too;
 *  - read-only accounts: the work queues (they cannot act on them).
 */
const READ_ONLY_QUEUES = [
    '/movements',
    '/supervisor/self-assessment-reviews',
    '/talent/actions',
    '/v2/idp/manage',
    '/v2/lifecycle',
    '/v2/pip',
    '/v2/slf/disputes',
    '/coaching/plans',
];
const REMOVED = {
    employee: ['/notifications', '/account', '/employee/my-data'],
    manager: ['/notifications', '/employee/dashboard', '/employee/my-data'],
    localadmin_ops: ['/notifications'],
    localadmin_people: ['/notifications'],
    localadmin_none: ['/notifications'],
    viewer: ['/notifications', ...READ_ONLY_QUEUES],
    superadmin: ['/notifications'],
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

/** The real catalogue in the session language (namespaced keys included). */
function translator(lang) {
    const cache = new Map();
    const dict = (ns) => {
        const k = lang + ':' + ns;
        if (!cache.has(k)) cache.set(k, require(`../../locales/${lang}/${ns}.json`));
        return cache.get(k);
    };
    return (key, o) => {
        const str = String(key);
        const [ns, k] = str.includes(':') ? str.split(':') : ['chrome', str];
        const v = dict(ns)[k];
        const out = v !== undefined ? v : str;
        return o && o.name !== undefined ? out.replace('{{name}}', o.name) : out;
    };
}

function locals(role, { v2, lc, ws = true, currentPath = '/nowhere', lang = 'fr', prefs } = {}) {
    const r = ROLES[role];
    return {
        user: prefs ? { ...r.user, workspacePrefs: prefs } : r.user,
        can: (s) => r.perms === '*' || r.perms.includes(s),
        wsVisible: typeof ws === 'function' ? ws : () => ws,
        appModules: { ...(v2 ? ALL_MODULES_ON : STAGE_1), localContent: !!lc },
        sqlConsoleEnabled: true,
        featureLocalContent: lc,
        currentPath,
        navConfig: NAV,
        __: translator(lang),
        cspNonce: 'n',
        csrfToken: 't',
        lang,
    };
}
const render = (file, L) => ejs.render(fs.readFileSync(file, 'utf8'), L, { filename: file });
const navOf = (html) => html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
const hrefs = (nav) =>
    new Set([...nav.matchAll(/<a\s+href="([^"]+)"/g)].map((m) => m[1].split('#')[0]));
const allHrefs = (nav) => [...nav.matchAll(/<a\s+href="([^"]+)"/g)].map((m) => m[1].split('#')[0]);
/** Section headers rendered in the rail. */
const topRows = (nav) => (nav.match(/class="sidebar-section[" ]/g) || []).length;
const CONFIGS = Object.keys(BEFORE).map((k) => {
    const [role, v2, lc] = k.split('|');
    return { key: k, role, v2: v2 === 'v2=true', lc: lc === 'lc=true' };
});

describe('the rail keeps every gate (navigation config)', () => {
    test.each(CONFIGS)(
        '$key: no new visibility, nothing lost — except the documented lists',
        ({ key, role, v2, lc }) => {
            const got = hrefs(navOf(render(SIDEBAR, locals(role, { v2, lc }))));
            const before = new Set(BEFORE[key].filter((h) => v2 || !STAGE_1_HIDDEN.includes(h)));
            const allowed = new Set([
                ...before,
                ...(ADDED[role] || []),
                ...(v2 ? MODULE_ADDITIONS[role] || [] : []),
                ...(v2 ? [] : CORE_NOW),
            ]);
            // nothing a role could not reach before becomes visible, except the lists
            expect([...got].filter((h) => !allowed.has(h))).toEqual([]);
            // every destination visible before is still in the rail, except the removals
            const removed = new Set(REMOVED[role] || []);
            expect([...before].filter((h) => !got.has(h) && !removed.has(h))).toEqual([]);
        }
    );

    test.each(Object.keys(MODULE_ADDITIONS))(
        '%s: the 360° / one-to-one / training entries follow their modules',
        (role) => {
            const on = hrefs(navOf(render(SIDEBAR, locals(role, { v2: true, lc: false }))));
            const off = hrefs(navOf(render(SIDEBAR, locals(role, { v2: false, lc: false }))));
            for (const h of MODULE_ADDITIONS[role]) {
                expect(`${h}:${on.has(h)}`).toBe(`${h}:true`);
                expect(`${h}:${off.has(h)}`).toBe(`${h}:false`);
            }
        }
    );

    test('every module-owned destination disappears with its module', () => {
        const M = require('../../src/config/modules');
        const owner = (h) =>
            Object.keys(M.MODULE_PREFIXES).find((k) =>
                M.MODULE_PREFIXES[k].some((p) => h === p || h.startsWith(p + '/'))
            );
        for (const role of Object.keys(ROLES)) {
            for (const off of M.STAGED_MODULES) {
                const mods = { ...ALL_MODULES_ON, [off]: false };
                const L = { ...locals(role, { v2: true, lc: true }), appModules: mods };
                const got = [...hrefs(navOf(render(SIDEBAR, L)))];
                const leaked = got.filter((h) => owner(h) === off);
                expect(`${role}/${off}: ${leaked.join(',')}`).toBe(`${role}/${off}: `);
            }
            const noLc = { ...locals(role, { v2: true, lc: false }) };
            expect(hrefs(navOf(render(SIDEBAR, noLc))).has('/reports/local-content')).toBe(false);
        }
    });

    test('/safety-gate: managers, admins with a compliance grant and SuperAdmins', () => {
        const sees = (role) =>
            hrefs(navOf(render(SIDEBAR, locals(role, { v2: true, lc: true })))).has('/safety-gate');
        expect(sees('superadmin')).toBe(true);
        expect(sees('localadmin_ops')).toBe(true); // holds view_compliance
        expect(sees('manager')).toBe(true); // the route admits managers
        for (const r of ['employee', 'localadmin_people', 'localadmin_none', 'viewer']) {
            expect(`${r}:${sees(r)}`).toBe(`${r}:false`);
        }
    });

    test('an explicitly hidden workspace component hides its links; « Tableau de bord » stays first', () => {
        const hidden = {
            'nav:main': false,
            'nav:team': false,
            'nav:talent': false,
            'nav:tools': false,
            'nav:administration': false,
            'nav:configuration': false,
        };
        const nav = navOf(
            render(
                SIDEBAR,
                locals('superadmin', {
                    v2: true,
                    lc: true,
                    ws: (k) => hidden[k] !== false,
                    prefs: hidden,
                })
            )
        );
        expect(allHrefs(nav)).toEqual(['/dashboard', '/tasks', '/guide', '/about']);
    });

    test('an employee meets at most six task entries, in the agreed order', () => {
        const nav = navOf(render(SIDEBAR, locals('employee', { v2: true, lc: true })));
        expect(nav).not.toMatch(/class="sidebar-section[" ]/); // no group header for the frontline
        const tops = [
            ...nav.matchAll(/<a\s+href="([^"]+)"\s+class="sidebar-link(?![^"]*sidebar-sublink)/g),
        ].map((m) => m[1]);
        expect(tops).toEqual([
            '/employee/dashboard',
            '/employee/self-assessment',
            '/employee/my-development',
            '/employee/my-learning',
            '/safety-gate/me',
            '/guide',
        ]);
        // the near-synonyms are sub-links, not top entries
        for (const h of [
            '/employee/assessment-status',
            '/employee/my-progress',
            '/employee/opportunities',
        ]) {
            expect(nav).toMatch(new RegExp(`href="${h}" class="sidebar-link sidebar-sublink`));
        }
    });

    test.each(['manager', 'superadmin', 'localadmin_people', 'localadmin_ops', 'viewer'])(
        '%s sees at most 10 top-level rows (level-0 entries + section headers)',
        (role) => {
            const built = NAV.buildNav(locals(role, { v2: true, lc: true }));
            expect(built.tree.length).toBeLessThanOrEqual(10);
            const nav = navOf(render(SIDEBAR, locals(role, { v2: true, lc: true })));
            expect(topRows(nav)).toBe(built.tree.filter((t) => t.type === 'section').length);
        }
    );

    test.each(['employee', 'manager', 'superadmin', 'viewer'])(
        '%s: « Tableau de bord » is the first entry and leads to the person’s home',
        (role) => {
            const list = allHrefs(navOf(render(SIDEBAR, locals(role, { v2: true, lc: true }))));
            expect(list[0]).toBe(NAV.homeUrl(ROLES[role].user));
        }
    );

    test.each(Object.keys(ROLES))(
        '%s: one entry per notion — no destination twice in the rail',
        (role) => {
            const list = allHrefs(navOf(render(SIDEBAR, locals(role, { v2: true, lc: true }))));
            expect(list.filter((h, i) => list.indexOf(h) !== i)).toEqual([]);
        }
    );

    test('the section and entry holding the current page are open server-side, the link is aria-current', () => {
        const nav = navOf(
            render(
                SIDEBAR,
                locals('manager', { v2: true, lc: true, currentPath: '/talent/nine-box/movements' })
            )
        );
        expect(nav).toMatch(/class="sidebar-entry is-open" data-entry-key="nine_box"/);
        expect(nav).toMatch(
            /class="sidebar-section has-current" data-section-key="section_talent"/
        );
        expect(nav).toMatch(
            /href="\/talent\/nine-box\/movements" class="sidebar-link sidebar-sublink active" aria-current="page"/
        );
        expect((nav.match(/aria-current=/g) || []).length).toBe(1);
    });

    test.each(Object.keys(ROLES))('%s: every destination has its own icon', (role) => {
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
            .filter(([, v]) => v.size > 1)
            .map(([i, v]) => `${i}: ${[...v].join(', ')}`);
        expect(shared).toEqual([]);
    });

    test('every section carries a stable data-section-key', () => {
        const nav = navOf(render(SIDEBAR, locals('superadmin', { v2: true, lc: true })));
        const sections = nav.match(/<div class="sidebar-section(?: has-current)?"[^>]*>/g);
        expect(sections.length).toBeGreaterThan(5);
        for (const x of sections) expect(x).toMatch(/data-section-key="section_[a-z_]+"/);
    });

    test('a read-only account gets no work queue and no « À traiter »', () => {
        const list = allHrefs(navOf(render(SIDEBAR, locals('viewer', { v2: true, lc: true }))));
        expect(list).not.toContain('/tasks');
        for (const h of READ_ONLY_QUEUES) expect(list).not.toContain(h);
    });

    test('the SQL console entry follows its operator switch', () => {
        const on = hrefs(navOf(render(SIDEBAR, locals('superadmin', { v2: true, lc: true }))));
        const L = { ...locals('superadmin', { v2: true, lc: true }), sqlConsoleEnabled: false };
        const off = hrefs(navOf(render(SIDEBAR, L)));
        expect(on.has('/data-management/sql-console')).toBe(true);
        expect(off.has('/data-management/sql-console')).toBe(false);
    });
});

describe('the fold state is keyed on data-section-key, not on the translated label', () => {
    // A tiny DOM stand-in, enough for the rail script.
    function fakeClassList(initial = []) {
        const set = new Set(initial);
        return {
            add: (c) => set.add(c),
            remove: (c) => set.delete(c),
            contains: (c) => set.has(c),
            toggle: (c, on) => {
                const v = on === undefined ? !set.has(c) : !!on;
                if (v) set.add(c);
                else set.delete(c);
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
    function build(lang, owner = 'o1') {
        const label = {
            section_reference: { fr: 'Référentiel & réglages', en: 'Framework & settings' },
            section_reports: { fr: 'Rapports', en: 'Reports' },
        };
        const sections = Object.keys(label).map((key) => {
            const btn = fakeButton(label[key][lang]);
            return {
                key,
                btn,
                classList: fakeClassList(),
                getAttribute: (a) =>
                    a === 'data-section-key'
                        ? key
                        : a === 'data-closed-default'
                          ? NAV.CLOSED_BY_DEFAULT.includes(key)
                              ? '1'
                              : '0'
                          : null,
                querySelector: (sel) => (sel === '.sidebar-section-label' ? btn : null),
            };
        });
        const toggle = fakeButton(lang === 'fr' ? 'Grille 9 cases' : '9-box grid');
        const entry = {
            classList: fakeClassList(),
            getAttribute: (a) => (a === 'data-entry-key' ? 'nine_box' : null),
            querySelector: (sel) => (sel.includes('toggle') ? toggle : null),
        };
        const nav = {
            classList: fakeClassList(),
            getAttribute: (a) =>
                ({
                    'data-nav-storage': NAV.STORAGE_KEY,
                    'data-nav-owner': owner,
                    'data-nav-legacy': NAV.LEGACY_STORAGE_KEYS.join(','),
                })[a] || null,
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
            removeItem: (k) => {
                delete storage[k];
            },
        };
        new Function('document', 'localStorage', 'window', src)(document, localStorage, {});
    }
    const sec = (dom, key) => dom.sections.find((x) => x.key === key);

    test('a group opened / an entry unfolded in French is still so after switching to English', () => {
        const storage = {};
        const fr = build('fr');
        runScript(fr, storage);
        expect(sec(fr, 'section_reference').btn.getAttribute('aria-expanded')).toBe('false'); // closed by default
        expect(sec(fr, 'section_reports').btn.getAttribute('aria-expanded')).toBe('true');
        sec(fr, 'section_reference').btn.click();
        sec(fr, 'section_reports').btn.click(); // close Rapports
        fr.toggle.click(); // unfold the 9-box entry

        const en = build('en');
        runScript(en, storage);
        expect(sec(en, 'section_reference').btn.getAttribute('aria-expanded')).toBe('true');
        expect(sec(en, 'section_reports').btn.getAttribute('aria-expanded')).toBe('false');
        expect(en.entry.classList.contains('is-open')).toBe(true);
        expect(en.toggle.getAttribute('aria-expanded')).toBe('true');
    });

    test('another person on the same computer starts from the defaults; the old saved state is reset once', () => {
        const storage = { 'sidebarNav.v2': JSON.stringify({ 's:section_talent': false }) };
        const a = build('fr', 'personA');
        runScript(a, storage);
        expect(storage['sidebarNav.v2']).toBeUndefined();
        sec(a, 'section_reports').btn.click(); // A closes Rapports
        const b = build('fr', 'personB');
        runScript(b, storage);
        expect(sec(b, 'section_reports').btn.getAttribute('aria-expanded')).toBe('true');
    });
});

describe('one account menu', () => {
    test('the sidebar carries no second dropdown; its footer links to the profile', () => {
        const html = render(SIDEBAR, locals('manager', { v2: true, lc: true }));
        expect(html).not.toContain('sidebarUserDropdown');
        expect(html).not.toContain('toggleUserMenu');
        expect(html).toMatch(/<a href="\/account" class="sidebar-user"/);
    });

    test('the navigation config holds ONE account-menu list, same order for everyone', () => {
        const menu = (role) => NAV.accountMenu(locals(role, {})).map((m) => m.href);
        const emp = menu('employee');
        expect(emp).toEqual([
            '/account',
            '/account/notifications',
            '/change-password',
            '/v2/uam/mfa/manage',
            '/account/sessions',
            '/employee/my-data',
            '/v2/cap/my-diversity',
            '/notifications',
        ]);
        expect(menu('manager')).toEqual(emp);
        const adm = menu('superadmin');
        expect(adm.filter((h) => h !== '/mon-acces')).toEqual(
            emp.filter((h) => h !== '/v2/cap/my-diversity' && h !== '/employee/my-data')
        );
        expect(adm[1]).toBe('/mon-acces');
        // Guide / À propos live in « Aide » only (one place).
        expect(adm).not.toContain('/guide');
        expect(adm).not.toContain('/about');
    });

    test('the header renders that list (minus Notifications: the bell) + language + sign-out', () => {
        const h = render(HEADER, locals('employee', { v2: true, lc: true }));
        const dd = h.slice(h.indexOf('id="userDropdown"'), h.indexOf('</form>'));
        const got = [...dd.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
        expect(got).toEqual([
            '/account',
            '/account/notifications',
            '/change-password',
            '/v2/uam/mfa/manage',
            '/account/sessions',
            '/employee/my-data',
            '/v2/cap/my-diversity',
            '/lang/en',
        ]);
        expect(dd).toMatch(/role="menu"/);
        expect(h).toMatch(/id="hdrAccountBtn" aria-haspopup="menu" aria-expanded="false"/);
    });

    test('password change is hidden while sign-in is SSO-only', () => {
        const L = { ...locals('employee', {}), passwordChangeAllowed: false };
        expect(NAV.accountMenu(L).map((m) => m.href)).not.toContain('/change-password');
    });
});

describe('i18n — French glossary and key parity', () => {
    test('FR speaks French for the talent acronyms', () => {
        expect(FR.nav_benchmark).toBe('Comparatif des rôles');
        expect(FR.nav_pip).toBe("Plans d'amélioration (PAP)");
        expect(FR.nav_dev_plans).toBe('Plans de développement (PDI)');
        expect(FR.nav_nine_box).toBe('Grille 9 cases');
        expect(FR.nav_tasks).toBe('À traiter');
        for (const k of [
            'nav_benchmark',
            'nav_pip',
            'nav_dev_plans',
            'nav_nine_box',
            'nav_my_okr',
            'nav_talent_actions_title',
            'nav_nine_box_movements',
        ]) {
            expect(FR[k]).not.toMatch(/\b(PIP|IDP|9-?Box|OKR|Benchmark|Référentiel)\b/i);
        }
        expect(EN.nav_tasks).toBe('Tasks');
    });

    test('every key the rail, the config and the header use exists in both locales', () => {
        const src = fs.readFileSync(SIDEBAR, 'utf8') + fs.readFileSync(HEADER, 'utf8');
        const keys = new Set([...src.matchAll(/__\('(chrome:[a-z0-9_]+)'/g)].map((m) => m[1]));
        for (const d of Object.values(NAV.CATALOGUE)) {
            keys.add(NAV.i18nKey(d.label));
            if (d.title) keys.add(NAV.i18nKey(d.title));
        }
        for (const x of Object.values(NAV.SECTIONS))
            for (const k of Object.keys(x)) keys.add(NAV.i18nKey(k));
        for (const m of NAV.ACCOUNT_MENU) keys.add(NAV.i18nKey(m.label));
        keys.add('chrome:nav_breadcrumb_root');
        keys.add('chrome:nav_palette_account');
        expect(keys.size).toBeGreaterThan(100);
        const missing = [...keys].filter((k) => {
            const [ns, key] = k.split(':');
            const fr = require(`../../locales/fr/${ns}.json`);
            const en = require(`../../locales/en/${ns}.json`);
            return !fr[key] || !en[key];
        });
        expect(missing).toEqual([]);
        expect(Object.keys(FR).sort()).toEqual(Object.keys(EN).sort());
    });
});
