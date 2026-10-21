'use strict';
/**
 * Org chart — behaviour of the page's OWN client module (`OC` in
 * views/pages/org-chart/index.ejs), run in a VM on a minimal document stub, plus
 * the viewerId contract of /api/org-chart.
 *
 * Defect reproduced on the development database: a manager (reader 136) whose 15
 * reports have supervisor_id = 136 and manager_id = 137, 137 sitting just ABOVE
 * the governed perimeter. In manager mode the client treated "parent exists but
 * is not in my list" as "no parent" and drew the whole team as 16 unassigned
 * roots ("16 personnes · 0 équipe · 16 non rattachés"). Second state: an
 * organisation where nobody has a supervisor or a manager recorded rendered a
 * wall of cards under "Organisation" and said nothing about why.
 *
 * These tests exercise reportingRoots() / render() on fixtures of exactly those
 * shapes, in every mode, in both languages. They read the module out of the
 * view (template tags resolved from the locale files) so they follow the real
 * code, and they never pin the source layout.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const VIEW = path.join(ROOT, 'views', 'pages', 'org-chart', 'index.ejs');
const FR = require(path.join(ROOT, 'locales', 'fr', 'talentx.json'));
const EN = require(path.join(ROOT, 'locales', 'en', 'talentx.json'));

// The OC script with its template tags resolved:
//   <%- JSON.stringify(__('talentx:key')) %> -> the locale string
//   <%- JSON.stringify(!!(user && ...)) %>    -> true (a manager/admin reader)
// and the trailing OC.load() (a network call) removed.
function clientSource(dict) {
    const ejs = fs.readFileSync(VIEW, 'utf8');
    // The opening tag still carries its unrendered nonce (<script nonce="<%= cspNonce %>">).
    const scripts = ejs.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g) || [];
    const body = scripts
        .map((s) => s.replace(/^<script nonce="[^"]*">/, '').replace(/<\/script>$/, ''))
        .find((s) => /const OC = \{/.test(s));
    if (!body) throw new Error('OC module not found in the view');
    const missing = [];
    const src = body
        .replace(/<%-\s*JSON\.stringify\(__\('talentx:([a-z0-9_]+)'\)\)\s*%>/g, (_, key) => {
            if (!(key in dict)) missing.push(key);
            return JSON.stringify(key in dict ? dict[key] : `talentx:${key}`);
        })
        // Both spellings of the reader flag: the original inline
        // `JSON.stringify(!!(user && ...))`, and the `json-script` partial that
        // replaced it when the escaping helper was rolled out across the views
        // (a bare JSON.stringify leaves `<` alone, so `</script>` in any
        // reflected value breaks out — see views/partials/json-script.ejs).
        .replace(/<%-\s*JSON\.stringify\(!!\(user[^%]*%>/g, 'true')
        .replace(
            /<%-\s*include\(\s*'[^']*json-script'\s*,\s*\{\s*v:\s*!!\(user[\s\S]*?\}\s*\)\s*%>/g,
            'true'
        )
        .replace(/OC\.load\(\);\s*$/, '');
    if (/<%/.test(src)) throw new Error('unresolved template tag in the OC script');
    return { src, missing };
}

// Just enough DOM for render() and the load-time canvas IIFE.
function fakeDocument() {
    const els = {};
    const el = (id) =>
        (els[id] = els[id] || {
            id,
            innerHTML: '',
            textContent: '',
            value: '',
            style: {},
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            addEventListener() {},
            setPointerCapture() {},
            scrollIntoView() {},
            closest: () => null,
        });
    return { els, getElementById: el, querySelector: () => null, querySelectorAll: () => [] };
}

function boot(nodes, dict = FR, viewerId) {
    const { src, missing } = clientSource(dict);
    expect(missing).toEqual([]); // every key the page reads exists in this locale
    const document = fakeDocument();
    const ctx = {
        document,
        window: { document },
        setTimeout: () => 0,
        console,
        fetch: async () => {
            throw new Error('no network in tests');
        },
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'org-chart/index.ejs#OC', timeout: 5000 });
    const OC = vm.runInContext('OC', ctx);
    OC.init(nodes, viewerId);
    return { OC, document };
}

function draw(OC, document, mode) {
    OC.mode = mode;
    OC.render();
    const html = document.els['oc-tree'].innerHTML;
    return {
        html,
        stats: document.els['oc-stats'].textContent,
        cards: (html.match(/class="oc-node/g) || []).length,
        text: html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
    };
}

const REPORTING_MODES = ['line', 'manager', 'supervisor'];

function person(id, name, extra = {}) {
    return {
        id,
        name,
        number: `E${id}`,
        role: 'Opérateur',
        site: 'Site A',
        department: 'Dept A',
        service: 'Svc A',
        org: 'Svc A · Dept A · Site A',
        managerId: null,
        supervisorId: null,
        isRoot: false,
        ...extra,
    };
}

// Exactly the uat.manager perimeter: reader 136 (manager 137, no supervisor),
// 15 reports with supervisor 136 and manager 137, and 137 NOT in the list.
function governedFixture({ flagViewer = true } = {}) {
    const reader = person(136, 'Lecteur Manager', {
        managerId: 137,
        role: 'Chef de section',
        ...(flagViewer ? { isViewer: true } : {}),
    });
    const reports = Array.from({ length: 15 }, (_, i) =>
        person(200 + i, `Rapport ${String(i + 1).padStart(2, '0')}`, {
            supervisorId: 136,
            managerId: 137,
        })
    );
    return [reader, ...reports];
}

describe('OC client — governed perimeter (reader 136; 15 × supervisor 136 / manager 137; 137 absent)', () => {
    test('line and supervisor modes: the reader is the only root and the 15 are in-mode reports', () => {
        const { OC, document } = boot(governedFixture());
        for (const mode of ['line', 'supervisor']) {
            OC.mode = mode;
            const m = OC.reportingRoots();
            expect(m.roots.map((r) => r.id)).toEqual([136]);
            expect(m.apex && m.apex.id).toBe(136);
            expect((m.kids[136] || []).length).toBe(15);
            expect(m.via).toEqual([]);
            const r = draw(OC, document, mode);
            expect(r.cards).toBe(16);
            expect(r.stats).toContain(`1 ${FR.oc_team_word}`);
            expect(r.stats).not.toContain(FR.oc_unassigned.toLowerCase());
            expect(r.stats).not.toContain(`0 ${FR.oc_team_word}`);
        }
    });

    test('manager mode: the reader is the single apex; the 15 hang under him in a group labelled "via the supervisor line", never as a false manager link', () => {
        const { OC, document } = boot(governedFixture());
        OC.mode = 'manager';
        const m = OC.reportingRoots();
        expect(m.roots.map((r) => r.id)).toEqual([136]); // one apex: the reader
        expect(m.via.map((n) => n.id).sort()).toEqual(
            Array.from({ length: 15 }, (_, i) => 200 + i)
        );
        expect(m.kids[136] || []).toEqual([]); // 136 is NOT drawn as their manager

        const r = draw(OC, document, 'manager');
        expect(r.cards).toBe(17); // 16 people + the labelled group card
        expect(r.stats).toContain(`1 ${FR.oc_team_word}`);
        expect(r.stats).toContain(`15 ${FR.oc_via_supervisor.toLowerCase()}`);
        expect(r.stats).not.toContain(FR.oc_unassigned.toLowerCase());
        expect(r.stats).not.toContain(`0 ${FR.oc_team_word}`);
        expect(r.text).toContain(FR.oc_via_supervisor);
        expect(r.html).not.toContain(FR.oc_unassigned);
        expect(r.html).not.toContain(FR.oc_org); // no virtual "Organisation" apex above the reader
        // The reader comes first, wears the head badge, and is honest about the
        // manager line: 0 direct in this mode, 15 in the team overall.
        expect(r.text.indexOf('Lecteur Manager')).toBeLessThan(
            r.text.indexOf(FR.oc_via_supervisor)
        );
        expect(r.html).toContain(`<span class="oc-root-badge">${FR.oc_head_badge}</span>`);
        expect(r.html).toContain(`title="0 ${FR.oc_direct} · 15 ${FR.oc_total}"`);
        // All 15 are visible: the group is expanded, no collapsed branch anywhere.
        for (let i = 1; i <= 15; i++)
            expect(r.text).toContain(`Rapport ${String(i).padStart(2, '0')}`);
        expect(r.html).not.toContain('data-collapsed');
        expect(r.html).not.toContain('aria-expanded="false"');
    });

    test('structure mode is untouched: site › department › service groups', () => {
        const { OC, document } = boot(governedFixture());
        const r = draw(OC, document, 'structure');
        expect(r.cards).toBe(20); // 16 people + Organisation + 1 site + 1 dept + 1 service
        expect(r.stats).toContain(FR.oc_org_structure);
    });

    test('focus on the reader keeps the via group and counts it', () => {
        const { OC, document } = boot(governedFixture());
        OC.mode = 'manager';
        OC.focusId = 136;
        OC.render();
        const html = document.els['oc-tree'].innerHTML;
        expect((html.match(/class="oc-node/g) || []).length).toBe(17);
        expect(document.els['oc-stats'].textContent).toContain(`16 ${FR.oc_in_focused}`);
        expect(html).toContain(FR.oc_via_supervisor);
    });

    test('the English page draws the same chart with the English labels', () => {
        const { OC, document } = boot(governedFixture(), EN);
        const r = draw(OC, document, 'manager');
        expect(r.cards).toBe(17);
        expect(r.stats).toContain(`1 ${EN.oc_team_word}`);
        expect(r.stats).toContain(`15 ${EN.oc_via_supervisor.toLowerCase()}`);
        expect(r.text).toContain(EN.oc_via_supervisor);
        expect(r.stats).not.toContain(EN.oc_unassigned.toLowerCase());
    });

    test('an explicit viewerId argument is honoured even without the node flag', () => {
        const { OC, document } = boot(governedFixture({ flagViewer: false }), FR, 136);
        const r = draw(OC, document, 'manager');
        expect(r.cards).toBe(17);
        expect(r.stats).toContain(`15 ${FR.oc_via_supervisor.toLowerCase()}`);
    });

    test('without a viewer, a recorded parent that is absent from the list is "outside the displayed scope", not "unassigned"', () => {
        // A scoped admin looking at the same 16 people: no apex, so no "via"
        // group — but their lines ARE recorded (137), so they are not unassigned.
        const { OC, document } = boot(governedFixture({ flagViewer: false }));
        const r = draw(OC, document, 'manager');
        expect(OC.viewerId).toBeNull();
        expect(r.stats).toContain(`16 ${FR.oc_outside.toLowerCase()}`);
        expect(r.stats).not.toContain(FR.oc_unassigned.toLowerCase());
        expect(r.stats).not.toContain(`0 ${FR.oc_team_word}`);
        expect(r.html).toContain(FR.oc_org);
        expect(r.html).not.toContain(FR.oc_via_supervisor);
    });
});

describe('OC client — no reporting line at all (0 of N with a supervisor or a manager)', () => {
    const noLines = () => Array.from({ length: 6 }, (_, i) => person(300 + i, `Personne ${i + 1}`));

    test.each(REPORTING_MODES)(
        '%s mode says so in words (FR) and offers the structure view — no wall of cards',
        (mode) => {
            const { OC, document } = boot(noLines());
            const r = draw(OC, document, mode);
            expect(r.cards).toBe(0);
            expect(r.text).toContain(FR.oc_no_lines);
            expect(r.text).toContain(FR.oc_no_lines_hint);
            expect(r.text).toContain(FR.oc_see_structure);
            // CSP (SA-14): delegated action (public/js/csp-actions.js), no inline onclick.
            expect(r.html).toMatch(/data-on-click="OC\.setMode"\s+data-args="[^"]*structure[^"]*"/);
            expect(r.html).not.toMatch(/\sonclick=/);
            expect(r.stats).toContain(FR.oc_no_lines_stat);
            expect(r.stats).not.toContain(`0 ${FR.oc_team_word}`);
            expect(r.stats).not.toContain(FR.oc_unassigned.toLowerCase());
        }
    );

    test('the same in English', () => {
        const { OC, document } = boot(noLines(), EN);
        const r = draw(OC, document, 'manager');
        expect(r.cards).toBe(0);
        expect(r.text).toContain(EN.oc_no_lines);
        expect(r.text).toContain(EN.oc_see_structure);
        expect(r.stats).toContain(EN.oc_no_lines_stat);
    });

    test('structure mode has something to show for the same people', () => {
        const { OC, document } = boot(noLines());
        const r = draw(OC, document, 'structure');
        expect(r.cards).toBe(10); // 6 people + Organisation + site + dept + service
    });
});

describe('OC client — full perimeter (superadmin shape): "unassigned" keeps its meaning', () => {
    test('a head with two reports plus one person with no line at all', () => {
        const nodes = [
            person(1, 'Tête Un'),
            person(2, 'Rapport A', { supervisorId: 1 }),
            person(3, 'Rapport B', { supervisorId: 1 }),
            person(4, 'Seul Sans Ligne'),
        ];
        const { OC, document } = boot(nodes);
        const r = draw(OC, document, 'line');
        expect(r.cards).toBe(6); // 4 people + Organisation + Unassigned group
        expect(r.stats).toContain(`1 ${FR.oc_team_word}`);
        expect(r.stats).toContain(`1 ${FR.oc_unassigned.toLowerCase()}`);
        expect(r.html).toContain(FR.oc_unassigned);
        expect(r.html).not.toContain(FR.oc_outside);
        expect(r.html).not.toContain(FR.oc_via_supervisor);
        expect(r.html).not.toContain(FR.oc_via_manager);
    });

    test('a childless person whose recorded manager is inactive/absent is "outside the displayed scope", separately from the truly unassigned', () => {
        const nodes = [
            person(1, 'Tête Un'),
            person(2, 'Rapport A', { managerId: 1 }),
            person(3, 'Rapport B', { managerId: 1 }),
            person(4, 'Seul Sans Ligne'),
            person(5, 'Manager Absent', { managerId: 999 }),
        ];
        const { OC, document } = boot(nodes);
        const r = draw(OC, document, 'manager');
        expect(r.cards).toBe(8); // 5 people + Organisation + outside group + unassigned group
        expect(r.stats).toContain(`1 ${FR.oc_outside.toLowerCase()}`);
        expect(r.stats).toContain(`1 ${FR.oc_unassigned.toLowerCase()}`);
    });
});

describe('OrgChartController.data — viewerId contract', () => {
    const mockDb = { all: jest.fn() };
    const mockRbac = { isSuperAdmin: jest.fn(), getFilteredEmployees: jest.fn() };
    const mockEmp = { findGovernedIds: jest.fn() };
    let ctrl;
    beforeAll(() => {
        jest.resetModules();
        jest.doMock(path.join(ROOT, 'src', 'config', 'database'), () => mockDb);
        jest.doMock(path.join(ROOT, 'src', 'services', 'RBACService'), () => mockRbac);
        jest.doMock(path.join(ROOT, 'src', 'models', 'EmployeeModel'), () => mockEmp);
        ctrl = require(path.join(ROOT, 'src', 'controllers', 'OrgChartController'));
    });
    afterAll(() => {
        jest.dontMock(path.join(ROOT, 'src', 'config', 'database'));
        jest.dontMock(path.join(ROOT, 'src', 'services', 'RBACService'));
        jest.dontMock(path.join(ROOT, 'src', 'models', 'EmployeeModel'));
        jest.resetModules();
    });
    const rows = [
        {
            id: 136,
            first_name: 'Lecteur',
            last_name: 'Manager',
            manager_id: 137,
            supervisor_id: null,
            manager_type: 'employee',
        },
        {
            id: 200,
            first_name: 'Rapport',
            last_name: 'Un',
            manager_id: 137,
            supervisor_id: 136,
            manager_type: 'employee',
        },
    ];
    const res = () => ({
        statusCode: 200,
        body: null,
        status(c) {
            this.statusCode = c;
            return this;
        },
        json(o) {
            this.body = o;
            return this;
        },
    });

    test('governed perimeter: viewerId is the reader and only the reader node is flagged', async () => {
        mockRbac.isSuperAdmin.mockReturnValue(false);
        mockEmp.findGovernedIds.mockResolvedValue([200]);
        mockDb.all.mockResolvedValue(rows);
        const r = res();
        await ctrl.data({ user: { id: 136, userType: 'manager' } }, r);
        expect(r.statusCode).toBe(200);
        expect(r.body.scope).toBe('governed');
        expect(r.body.viewerId).toBe(136);
        expect(r.body.nodes.find((n) => n.id === 136).isViewer).toBe(true);
        expect('isViewer' in r.body.nodes.find((n) => n.id === 200)).toBe(false);
        // Nothing beyond the list itself is revealed: the ids the SQL was asked for
        // are the governed ones plus the reader's own.
        expect(mockDb.all.mock.calls[0][1].sort()).toEqual([136, 200]);
    });

    test('superadmin: viewerId is null and no node is flagged (an admin is not a node)', async () => {
        mockRbac.isSuperAdmin.mockReturnValue(true);
        mockDb.all.mockResolvedValue(rows);
        const r = res();
        await ctrl.data({ user: { id: 1, userType: 'admin', role: 'superadmin' } }, r);
        expect(r.body.scope).toBe('all');
        expect(r.body.viewerId).toBeNull();
        expect(r.body.nodes.some((n) => 'isViewer' in n)).toBe(false);
    });
});
