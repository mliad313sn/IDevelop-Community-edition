'use strict';
/**
 * The one navigation config (src/config/navigation.js) and every surface that
 * reads it: the rail, the breadcrumbs, the quick-search palette, the account
 * menu and the help titles. The REAL partials are rendered with ejs, with the
 * real FR / EN catalogues and fake `user` / `can` / `wsVisible` / module locals.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const NAV = require('../../src/config/navigation');
const P = (f) => path.join(ROOT, 'views/partials', f);

const PERSONAS = {
    employee: { user: { id: 1, userType: 'employee', username: 'emp' }, perms: [] },
    manager: { user: { id: 2, userType: 'manager', username: 'mgr' }, perms: [] },
    hr: {
        user: { id: 3, userType: 'admin', role: 'localadmin', username: 'hr' },
        perms: [
            'view_employees',
            'manage_cycles',
            'manage_invitations',
            'manage_onboarding',
            'view_domains_skills',
            'view_roles',
            'export_data',
        ],
    },
    hse: {
        user: { id: 4, userType: 'admin', role: 'localadmin', username: 'hse' },
        perms: ['view_compliance', 'manage_compliance', 'view_employees'],
    },
    auditor: {
        user: { id: 5, userType: 'admin', role: 'viewer', username: 'aud' },
        perms: ['view_system_logs', 'view_employees'],
    },
    executive: { user: { id: 6, userType: 'admin', role: 'viewer', username: 'exe' }, perms: [] },
    superadmin: {
        user: { id: 7, userType: 'admin', role: 'superadmin', username: 'sa' },
        perms: '*',
    },
};
const ALL_ON = {
    campaigns: true,
    development: true,
    talent: true,
    mobility: true,
    engagement: true,
    ai: true,
    localContent: true,
};

function translator(lang) {
    return (key, o) => {
        const str = String(key);
        const [ns, k] = str.includes(':') ? str.split(':') : ['chrome', str];
        // eslint-disable-next-line security/detect-non-literal-require
        const dict = require(`../../locales/${lang}/${ns}.json`);
        let out = dict[k] !== undefined ? dict[k] : str;
        if (o) for (const [a, b] of Object.entries(o)) out = out.split(`{{${a}}}`).join(String(b));
        return out;
    };
}
function locals(name, o = {}) {
    const p = PERSONAS[name];
    return {
        user: p.user,
        can: (s) => p.perms === '*' || p.perms.includes(s),
        wsVisible: () => true,
        appModules: o.modules || ALL_ON,
        featureLocalContent: o.modules ? !!o.modules.localContent : true,
        sqlConsoleEnabled: true,
        currentPath: o.path || '/nowhere',
        title: o.title,
        breadcrumbs: o.breadcrumbs,
        navConfig: NAV,
        __: translator(o.lang || 'fr'),
        lang: o.lang || 'fr',
        cspNonce: 'n',
        csrfToken: 't',
    };
}
function render(file, L) {
    // `locals` is how the partials reach the whole view scope, as in Express.
    return ejs.render(fs.readFileSync(P(file), 'utf8'), { ...L, locals: L }, { filename: P(file) });
}
const navOf = (html) => html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
const links = (nav) =>
    [
        ...nav.matchAll(
            /<a href="([^"]+)" class="([^"]+)"[^>]*>[\s\S]*?<span class="sidebar-link-text">([^<]*)</g
        ),
    ].map((m) => ({ href: m[1], cls: m[2], label: m[3] }));

describe('« Tableau de bord » is the FIRST entry for every persona and leads to their home', () => {
    const HOME = {
        employee: '/employee/dashboard',
        manager: '/supervisor/dashboard',
        hr: '/dashboard',
        hse: '/dashboard',
        auditor: '/dashboard',
        executive: '/dashboard',
        superadmin: '/dashboard',
    };
    for (const name of Object.keys(PERSONAS)) {
        for (const [lang, label] of [
            ['fr', 'Tableau de bord'],
            ['en', 'Dashboard'],
        ]) {
            test(`${name} (${lang})`, () => {
                const first = links(navOf(render('sidebar.ejs', locals(name, { lang }))))[0];
                expect(first.href).toBe(HOME[name]);
                expect(first.label).toBe(label);
                expect(NAV.homeUrl(PERSONAS[name].user)).toBe(HOME[name]);
            });
        }
    }

    test('it stays first even when every module is off', () => {
        const off = {};
        const first = links(
            navOf(render('sidebar.ejs', locals('superadmin', { modules: off })))
        )[0];
        expect(first.href).toBe('/dashboard');
    });
});

describe('the trees, per persona', () => {
    const sections = (name) =>
        NAV.buildNav(locals(name))
            .tree.filter((t) => t.type === 'section')
            .map((t) => t.key);

    test('manager: team first, own space and help last', () => {
        expect(sections('manager')).toEqual([
            'section_my_team',
            'section_assessments',
            'section_talent',
            'section_safety',
            'section_reports',
            'section_my_space',
            'section_help',
        ]);
    });

    test('a compliance holder without campaign work starts with safety', () => {
        expect(sections('hse')[0]).toBe('section_safety');
        expect(sections('hr')[0]).toBe('section_people');
    });

    test('SuperAdmin: instance administration last before help, closed by default', () => {
        const tree = NAV.buildNav(locals('superadmin')).tree;
        const keys = tree.filter((t) => t.type === 'section').map((t) => t.key);
        expect(keys.slice(-2)).toEqual(['section_system', 'section_help']);
        expect(tree.find((t) => t.key === 'section_system').closedByDefault).toBe(true);
        // a local admin never gets it
        expect(sections('hr')).not.toContain('section_system');
    });

    test('an auditor reads safety first, and its framework section opens by default', () => {
        const tree = NAV.buildNav(locals('auditor')).tree;
        expect(tree.filter((t) => t.type === 'section')[0].key).toBe('section_safety');
        const ref = tree.find((t) => t.key === 'section_reference');
        if (ref) expect(ref.closedByDefault).toBe(false);
    });

    test('« À traiter » is second for manager / HR / HSE / SuperAdmin, never for read-only accounts', () => {
        for (const n of ['manager', 'hr', 'hse', 'superadmin']) {
            const l = links(navOf(render('sidebar.ejs', locals(n))));
            expect(`${n}:${l[1].href}`).toBe(`${n}:/tasks`);
            expect(l[1].label).toBe('À traiter');
        }
        for (const n of ['employee', 'auditor', 'executive']) {
            const hrefs = links(navOf(render('sidebar.ejs', locals(n)))).map((x) => x.href);
            expect(`${n}:${hrefs.includes('/tasks')}`).toBe(`${n}:false`);
        }
        const en = links(navOf(render('sidebar.ejs', locals('manager', { lang: 'en' }))));
        expect(en[1].label).toBe('Tasks');
    });

    test('the « À traiter » entry carries the badge the header fills', () => {
        const nav = navOf(render('sidebar.ejs', locals('manager')));
        expect(nav).toMatch(/data-nav-id="tasks"[\s\S]*?data-nav-badge="tasks" hidden/);
    });

    test('9-box movements sits under the 9-box grid', () => {
        const tree = NAV.buildNav(locals('manager')).tree;
        const talent = tree.find((t) => t.key === 'section_talent');
        const grid = talent.items.find((n) => n.id === 'nine_box');
        expect(grid.children.map((c) => c.href)).toContain('/talent/nine-box/movements');
    });

    test('managers get a main-menu entry for the safety clearances of their team', () => {
        const tree = NAV.buildNav(locals('manager')).tree;
        const safety = tree.find((t) => t.key === 'section_safety');
        expect(safety.items[0].href).toBe('/safety-gate');
    });

    test('the IDevelop-only destinations are placed', () => {
        const sa = new Set(NAV.flatten(NAV.buildNav(locals('superadmin'))).map((x) => x.node.href));
        for (const h of [
            '/feedback-360/manage',
            '/admin/modules',
            '/admin/integrations/hris',
            '/admin/notifications/catalogue',
            '/admin/notifications/metrics',
            '/talent/nine-box/movements',
            '/reports/schedules',
            '/safety-gate',
            '/safety-gate/config',
        ])
            expect(`${h}:${sa.has(h)}`).toBe(`${h}:true`);
        const emp = new Set(NAV.flatten(NAV.buildNav(locals('employee'))).map((x) => x.node.href));
        for (const h of ['/feedback-360', '/one-on-one', '/employee/okr', '/safety-gate/me'])
            expect(`${h}:${emp.has(h)}`).toBe(`${h}:true`);
        const acc = NAV.accountMenu(locals('employee')).map((m) => m.href);
        expect(acc).toContain('/account/notifications');
        expect(acc).toContain('/v2/cap/my-diversity');
    });
});

describe('module and permission gates', () => {
    const hrefsOf = (name, o) =>
        new Set(NAV.flatten(NAV.buildNav(locals(name, o))).map((x) => x.node.href));

    test('a module that is off removes every entry it owns', () => {
        const stage1 = { campaigns: true };
        const h = hrefsOf('superadmin', { modules: stage1 });
        for (const x of [
            '/v2/idp/manage',
            '/v2/pip',
            '/coaching/plans',
            '/feedback-360/manage',
            '/v2/continuity',
            '/exec/key-person',
            '/v2/lifecycle',
            '/v2/cap',
            '/v2/lms',
            '/v2/lms/uplifts',
            '/reports/local-content',
        ])
            expect(`${x}:${h.has(x)}`).toBe(`${x}:false`);
        expect(h.has('/cycles')).toBe(true);
        const noCampaigns = hrefsOf('superadmin', { modules: {} });
        expect(noCampaigns.has('/cycles')).toBe(false);
        // core destinations never depend on a module
        for (const x of ['/v2/slf/disputes', '/v2/uam/maker-checker/queue', '/talent/nine-box'])
            expect(noCampaigns.has(x)).toBe(true);
    });

    test('the talent-suite hub stays while ANY of its modules is on', () => {
        expect(hrefsOf('superadmin', { modules: { ai: true } }).has('/v2/cap')).toBe(true);
        expect(hrefsOf('superadmin', { modules: { campaigns: true } }).has('/v2/cap')).toBe(false);
    });

    test('a SuperAdmin explicitly hiding nav:administration still hides those entries', () => {
        const L = locals('superadmin');
        L.user = { ...L.user, workspacePrefs: { 'nav:administration': false } };
        L.wsVisible = (k) => k !== 'nav:administration';
        const h = new Set(NAV.flatten(NAV.buildNav(L)).map((x) => x.node.href));
        expect(h.has('/admins')).toBe(false);
        expect(h.has('/system-logs')).toBe(false);
        expect(h.has('/organization')).toBe(true); // nav:configuration untouched
    });

    test('a permission-aware default no longer hides a link the route lets in', () => {
        // the default of nav:administration hides it for an admin without one of
        // its permAny grants; « Gestion des données » still follows export_data.
        const L = locals('hr');
        L.wsVisible = (k) => k !== 'nav:administration';
        const h = new Set(NAV.flatten(NAV.buildNav(L)).map((x) => x.node.href));
        expect(h.has('/data-management')).toBe(true);
        expect(h.has('/admin/accounts')).toBe(true);
    });

    test('« Gestion des données » is never shown without export_data or import_data', () => {
        const h = hrefsOf('hse');
        expect(h.has('/data-management')).toBe(false);
    });

    test('the clearance rules page follows manage_compliance', () => {
        expect(hrefsOf('hse').has('/safety-gate/config')).toBe(true);
        expect(hrefsOf('hr').has('/safety-gate/config')).toBe(false);
        expect(hrefsOf('manager').has('/safety-gate/config')).toBe(false);
    });
});

describe('a11y — aria-current, aria-expanded / aria-controls, drawer markup', () => {
    test('exactly one aria-current, on the deepest matching entry; its parents open', () => {
        const nav = navOf(
            render('sidebar.ejs', locals('superadmin', { path: '/data-management/sql-console' }))
        );
        expect((nav.match(/aria-current="page"/g) || []).length).toBe(1);
        expect(nav).toMatch(
            /href="\/data-management\/sql-console" class="sidebar-link sidebar-sublink active" aria-current="page"/
        );
        expect(nav).toMatch(
            /class="sidebar-entry sidebar-hub is-open" data-entry-key="hub_platform"/
        );
        expect(nav).toMatch(
            /class="sidebar-section has-current" data-section-key="section_system"/
        );
    });

    test('a detail page marks its rail entry (aria-current="true", not "page")', () => {
        const nav = navOf(render('sidebar.ejs', locals('hr', { path: '/employees/42' })));
        expect(nav).toMatch(/href="\/employees" class="sidebar-link active" aria-current="true"/);
    });

    test('a manager on /dashboard is on « Indicateurs », on the team view on « Tableau de bord »', () => {
        const a = navOf(render('sidebar.ejs', locals('manager', { path: '/dashboard' })));
        expect(a).toMatch(/href="\/dashboard" class="sidebar-link active" aria-current="page"/);
        const b = navOf(
            render('sidebar.ejs', locals('manager', { path: '/supervisor/dashboard' }))
        );
        expect(b).toMatch(
            /href="\/supervisor\/dashboard" class="sidebar-link active" aria-current="page"/
        );
    });

    test('the person’s own diversity page is not part of the talent suite', () => {
        const nav = navOf(
            render('sidebar.ejs', locals('manager', { path: '/v2/cap/my-diversity' }))
        );
        expect(nav).not.toMatch(/aria-current=/);
    });

    test('every section header and every sub-list toggle names the region it controls', () => {
        const nav = navOf(render('sidebar.ejs', locals('superadmin')));
        const ids = new Set([...nav.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
        const buttons = [
            ...nav.matchAll(
                /<button type="button" class="(sidebar-section-label|sidebar-entry-toggle|sidebar-link sidebar-hub-toggle)"[^>]*>/g
            ),
        ].map((m) => m[0]);
        expect(buttons.length).toBeGreaterThan(10);
        for (const b of buttons) {
            expect(b).toMatch(/aria-expanded="(true|false)"/);
            const c = b.match(/aria-controls="([^"]+)"/);
            expect(c && ids.has(c[1])).toBe(true);
        }
    });

    test('the rail is a <div role="complementary">; drawer script and backdrop ship with it', () => {
        const html = render('sidebar.ejs', locals('employee'));
        expect(html).not.toMatch(/<aside\b/);
        expect(html).toMatch(
            /<div class="sidebar" id="appSidebar" role="complementary" aria-label="Menu de navigation">/
        );
        expect(html).toContain('src="/js/nav-rail.js');
        expect(html).toContain('id="navBackdrop"');
        expect(html).toMatch(/data-nav-storage="sidebarNav\.v3"/);
        const js = fs.readFileSync(path.join(ROOT, 'public/js/nav-rail.js'), 'utf8');
        expect(js).not.toMatch(/\son[a-z]+\s*=/); // CSP: no inline handler
        // modal → role=dialog; closed → back to complementary (never dialog on close)
        expect(js).toMatch(/setAttribute\('role', 'dialog'\)/);
        expect(js).toMatch(/setAttribute\('role', 'complementary'\)/);
        expect(js).toMatch(/setAttribute\('aria-modal', 'true'\)/);
    });

    test('the layout puts the header BEFORE the rail (tab order: skip link → header → rail → main)', () => {
        const layout = fs.readFileSync(path.join(ROOT, 'views/layouts/main.ejs'), 'utf8');
        expect(layout.indexOf("include('../partials/header')")).toBeLessThan(
            layout.indexOf("include('../partials/sidebar')")
        );
    });
});

describe('breadcrumbs — derived from the same config', () => {
    const crumbs = (html) =>
        [
            ...html.matchAll(
                /<(a href="([^"]*)"|span class="breadcrumb-(current|section)"[^>]*)>(?:<i[^>]*><\/i>\s*)?([^<]*)</g
            ),
        ].map((m) => `${m[4].trim()}${m[2] ? ' → ' + m[2] : ''}`);

    test('a detail page: Tableau de bord › section › entry › page; the root is the person’s home', () => {
        const html = render(
            'breadcrumbs.ejs',
            locals('hr', { path: '/employees/42', title: 'Test Person' })
        );
        expect(crumbs(html)).toEqual([
            'Tableau de bord → /dashboard',
            'Collaborateurs',
            'Collaborateurs → /employees',
            'Test Person',
        ]);
    });

    test('a level-2 rail page is placed under its parent entry', () => {
        const html = render(
            'breadcrumbs.ejs',
            locals('manager', {
                path: '/reports/schedules',
                breadcrumbs: [{ label: 'Planification' }],
            })
        );
        expect(crumbs(html)).toEqual([
            'Tableau de bord → /supervisor/dashboard',
            'Rapports',
            'Rapports → /reports/builder',
            'Envois programmés',
        ]);
    });

    test('a rail page itself has no trail; a page outside the rail keeps the controller trail under the same root', () => {
        expect(
            render('breadcrumbs.ejs', locals('hr', { path: '/employees', title: 'X' })).trim()
        ).toBe('');
        const html = render(
            'breadcrumbs.ejs',
            locals('employee', {
                path: '/privacy/notice',
                breadcrumbs: [{ label: 'A', url: '/a' }, { label: 'B' }],
            })
        );
        expect(crumbs(html)).toEqual(['Tableau de bord → /employee/dashboard', 'A → /a', 'B']);
    });

    test('labels are escaped', () => {
        const html = render(
            'breadcrumbs.ejs',
            locals('hr', { path: '/employees/42', title: '<img src=x onerror=alert(1)>' })
        );
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });
});

describe('the palette indexes the config, folded sections and the account menu included', () => {
    const pages = (name, o) => {
        const html = render('command-palette.ejs', locals(name, o));
        return JSON.parse(html.match(/const PAGES = (\[[\s\S]*?\]);/)[1]);
    };

    test('SuperAdmin: a page inside the folded instance section and the account menu are found', () => {
        const p = pages('superadmin');
        expect(p.find((x) => x.href === '/admin/health')).toEqual(
            expect.objectContaining({ group: "Administration de l'instance" })
        );
        expect(p.find((x) => x.href === '/account/sessions')).toEqual(
            expect.objectContaining({ group: 'Mon compte' })
        );
    });

    test('an employee is never offered a page they cannot open', () => {
        const hrefs = pages('employee').map((x) => x.href);
        expect(hrefs).toContain('/safety-gate/me');
        for (const h of ['/employees', '/dashboard', '/tasks', '/mon-acces', '/admin/health'])
            expect(hrefs).not.toContain(h);
    });

    test('a module that is off is not offered either', () => {
        const hrefs = pages('employee', { modules: {} }).map((x) => x.href);
        for (const h of ['/feedback-360', '/one-on-one', '/employee/okr', '/employee/my-coaching'])
            expect(hrefs).not.toContain(h);
    });

    test('the palette and the rail hold the same destinations', () => {
        const rail = links(navOf(render('sidebar.ejs', locals('hr')))).map((l) => l.href);
        const pal = pages('hr').map((x) => x.href);
        expect(pal.slice(0, rail.length)).toEqual(rail);
    });

    test('the « / » trigger is gone; Ctrl/Cmd+K stays; results are written as text', () => {
        const src = fs.readFileSync(P('command-palette.ejs'), 'utf8');
        expect(src).not.toMatch(/e\.key === '\/'/);
        expect(src).toMatch(/\(e\.ctrlKey \|\| e\.metaKey\) && \(e\.key === 'k'/);
        expect(src).toMatch(/aria-label="<%= __\('chrome:cmdk_results_aria'\) %>"/);
        expect(src).toMatch(/node\.querySelector\('span'\)\.textContent = items\[i\]\.label/);
        expect(src).toMatch(/node\.setAttribute\('href', items\[i\]\.href\)/);
        // Escape gives the focus back to the button that opened it.
        expect(src).toMatch(/const back = opener \|\| document\.getElementById\('hdrSearch'\)/);
    });
});

describe('header — account menu, bell, search', () => {
    test('a real account <button> with menu semantics, bell and search buttons', () => {
        const h = render('header.ejs', locals('manager'));
        expect(h).toMatch(
            /<button type="button" class="topbar-user hdr-target" id="hdrAccountBtn" aria-haspopup="menu"/
        );
        expect(h).toMatch(/id="userDropdown" role="menu" aria-labelledby="hdrAccountBtn"/);
        expect(h).toMatch(
            /<button type="button" class="hdr-search hdr-target" id="hdrSearch" data-cmdk-open/
        );
        expect(h).toMatch(
            /<button type="button" class="ac-bell hdr-target" id="acBell" aria-expanded="false" aria-controls="acDropdown"/
        );
        // no inline handler: the header is wired by its nonce'd scripts
        expect(h).not.toMatch(/\son(click|keydown)=/);
        expect(h).toMatch(/aria-label="Menu du compte \(mgr\)"/);
    });

    test('« Tout voir » of the tasks tab: /tasks (manager, admin), dashboard (employee), none (read-only)', () => {
        const foot = (n) => {
            const h = render('header.ejs', locals(n));
            const panel = h.match(
                /id="acPanelTasks"[\s\S]*?<\/div>\s*<a class="ac-foot" href="([^"]+)"/
            );
            return panel ? panel[1] : null;
        };
        expect(foot('manager')).toBe('/tasks');
        expect(foot('hr')).toBe('/tasks');
        expect(foot('employee')).toBe('/employee/dashboard');
        expect(foot('executive')).toBeNull();
    });

    test('a shared-computer session: counts only, no list container', () => {
        const L = { ...locals('manager'), sharedDevice: { beaconToken: 'x' } };
        const h = render('header.ejs', L);
        expect(h).toMatch(/data-kiosk="1"/);
        expect(h).not.toContain('id="acBody"');
        expect(h).not.toContain('id="acNotifs"');
    });

    test('the badge counts actions; unread notifications are a dot; both are in the accessible name', () => {
        const src = fs.readFileSync(P('header.ejs'), 'utf8');
        expect(src).toMatch(/badge\.textContent=shown/);
        expect(src).toMatch(/dot\.hidden = !\(unreadCount>0\)/);
        expect(src).toMatch(/bell\.setAttribute\('aria-label', name\)/);
        expect(src).toMatch(/new CustomEvent\('nav:actions-count'/);
    });
});

describe('help titles use the rail names', () => {
    test('the rail emits the glossary map in the session language', () => {
        const html = render('sidebar.ejs', locals('employee', { lang: 'en' }));
        const map = JSON.parse(
            html.match(/<script type="application\/json" id="navGlossary">([\s\S]*?)<\/script>/)[1]
        );
        expect(map['/tasks']).toBe('Tasks');
        expect(map['/talent/nine-box/movements']).toBe('9-box movements');
        expect(map['/supervisor/dashboard']).toBe('Dashboard');
        expect(map['/feedback-360']).toBe('My 360° feedback');
    });

    test('the local-content page leaves no trace while its module is off', () => {
        const html = render('sidebar.ejs', locals('employee', { modules: { campaigns: true } }));
        expect(html).not.toContain('/reports/local-content');
    });

    test('help.js reads the glossary for its title and escapes it', () => {
        const src = fs.readFileSync(path.join(ROOT, 'public/js/help.js'), 'utf8');
        expect(src).toMatch(/document\.getElementById\('navGlossary'\)/);
        expect(src).toMatch(
            /content = Object\.assign\(\{\}, content, \{ title: escHtml\(glossTitle\) \}\)/
        );
    });
});
