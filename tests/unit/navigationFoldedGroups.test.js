'use strict';
/**
 * The rail after the 4.0.0 port, wave 11 (src/config/navigation.js and the real
 * views/partials/sidebar.ejs):
 *   - every group opens folded, except the one holding the current page; a
 *     read-only account still finds its framework and its reports unfolded;
 *   - the board decisions have their own entry, under the board pack, with the
 *     pack's own gate (the /exec mount), so a link never widens a route;
 *   - the indicator targets no longer share their icon with the person's own
 *     objectives.
 * Invented accounts only.
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const NAV = require('../../src/config/navigation');
const SIDEBAR = path.join(ROOT, 'views/partials/sidebar.ejs');

const PERSONAS = {
    manager: { user: { id: 21, userType: 'manager', username: 'r.okafor' }, perms: [] },
    hr: {
        user: { id: 22, userType: 'admin', role: 'localadmin', username: 'm.lindqvist' },
        perms: ['view_employees', 'manage_cycles', 'view_domains_skills', 'view_roles'],
    },
    auditor: {
        user: { id: 23, userType: 'admin', role: 'viewer', username: 'p.ferreira' },
        perms: ['view_system_logs', 'view_employees'],
    },
    superadmin: {
        user: { id: 24, userType: 'admin', role: 'superadmin', username: 'root.demo' },
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
    return (key) => {
        const str = String(key);
        const [ns, k] = str.includes(':') ? str.split(':') : ['chrome', str];
        // eslint-disable-next-line security/detect-non-literal-require
        const dict = require(`../../locales/${lang}/${ns}.json`);
        return dict[k] !== undefined ? dict[k] : str;
    };
}
function locals(name, o = {}) {
    const p = PERSONAS[name];
    return {
        user: p.user,
        can: (s) => p.perms === '*' || p.perms.includes(s),
        wsVisible: () => true,
        appModules: ALL_ON,
        featureLocalContent: true,
        sqlConsoleEnabled: true,
        currentPath: o.path || '/nowhere',
        navConfig: NAV,
        __: translator(o.lang || 'en'),
        lang: o.lang || 'en',
        cspNonce: 'n',
        csrfToken: 't',
    };
}
function render(L) {
    return ejs.render(fs.readFileSync(SIDEBAR, 'utf8'), { ...L, locals: L }, { filename: SIDEBAR });
}
const sections = (html) =>
    [
        ...html.matchAll(
            /<div class="sidebar-section( has-current)?" data-section-key="([^"]+)" data-closed-default="([01])">/g
        ),
    ].map((m) => ({ key: m[2], current: !!m[1], closed: m[3] === '1' }));

describe('every group opens folded, except the one holding the current page', () => {
    test('the list of folded groups names every group of every persona', () => {
        const keys = new Set();
        for (const tree of Object.values(NAV.SECTIONS))
            for (const k of Object.keys(tree)) keys.add(k);
        for (const k of keys) expect(NAV.CLOSED_BY_DEFAULT).toContain(k);
    });

    test.each(['manager', 'hr', 'superadmin'])(
        '%s: on a page outside the rail, no group is rendered open',
        (who) => {
            const s = sections(render(locals(who)));
            expect(s.length).toBeGreaterThan(3);
            for (const x of s) {
                expect(x.closed).toBe(true);
                expect(x.current).toBe(false);
            }
        }
    );

    test('the group of the current page is marked, so the browser opens it', () => {
        const s = sections(render(locals('hr', { path: '/exec/decisions' })));
        const reports = s.find((x) => x.key === 'section_reports');
        expect(reports.current).toBe(true);
        expect(s.filter((x) => x.current)).toHaveLength(1);
        // the rail script gives the current page's group precedence over the default
        const html = render(locals('hr', { path: '/exec/decisions' }));
        expect(html).toMatch(/if \(holdsCurrent\) open = true;\s*else if \(has\(id\)\)/);
    });

    test('a read-only account finds its framework and its reports unfolded', () => {
        const s = sections(render(locals('auditor')));
        for (const x of s) {
            const open = NAV.OPEN_FOR_READ_ONLY.includes(x.key);
            expect(x.closed).toBe(!open);
        }
        expect(s.some((x) => x.key === 'section_reports' && !x.closed)).toBe(true);
    });
});

describe('the board decisions have a rail entry under the board pack', () => {
    test('the entry points at the decisions page, with its own icon and labels', () => {
        const d = NAV.CATALOGUE.board_decisions;
        expect(d.href).toBe('/exec/decisions');
        expect(d.icon).not.toBe(NAV.CATALOGUE.board_pack.icon);
        for (const lang of ['en', 'fr']) {
            const t = translator(lang);
            expect(t(d.label)).not.toBe(d.label);
            expect(t(d.title)).not.toBe(d.title);
        }
    });

    test.each(Object.keys(PERSONAS))('%s: shown exactly when the board pack is', (who) => {
        const ctx = NAV.buildContext(locals(who));
        const g = NAV.gates(ctx);
        expect(g.board_decisions).toBe(g.board_pack);
    });

    test('an administrator finds it inside the board pack entry, a manager next to it', () => {
        const findParent = (nav, id) => {
            let found = null;
            for (const top of nav.tree) {
                const walk = (nodes, parent) => {
                    for (const n of nodes) {
                        if (n.id === id) found = { parent, section: top.key };
                        walk(n.children || [], n);
                    }
                };
                walk(top.type === 'section' ? top.items : [top], null);
            }
            return found;
        };
        const adm = findParent(NAV.buildNav(locals('hr')), 'board_decisions');
        expect(adm.section).toBe('section_reports');
        expect(adm.parent.id).toBe('board_pack');
        const mgr = findParent(NAV.buildNav(locals('manager')), 'board_decisions');
        expect(mgr.section).toBe('section_reports');
        expect(mgr.parent.id).toBe('indicators');
    });

    test('on the decisions page the trail runs through the board pack', () => {
        const t = NAV.trail(locals('hr', { path: '/exec/decisions' }), 'x');
        const keys = t.map((x) => x.labelKey);
        expect(keys).toContain('exec:bp_title');
        expect(keys[keys.length - 1]).toBe('exec:bd_title');
    });
});

describe('icons say one thing each', () => {
    test('the indicator targets no longer borrow the objectives icon', () => {
        expect(NAV.CATALOGUE.kpi_targets.icon).not.toBe(NAV.CATALOGUE.my_okr.icon);
    });
});
