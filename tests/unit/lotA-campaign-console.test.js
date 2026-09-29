'use strict';

// Lot A — the campaign console wiring: routes and their three write tiers, the
// console view, the retired /v2/slf/cycles page, the shared "current campaign"
// resolver and the FR/EN keys the console renders.
// (L2-05/13/15/17/20/24, L5A-02/03/18, L5C-03/05/11, L6-01/02/08/29)
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

const fs = require('fs');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

const routes = R('src/routes/index.js');
const lotA = routes.slice(
    routes.indexOf('// ---- SECTION campaigns'),
    routes.indexOf('// ---- end SECTION campaigns')
);
const show = R('views/pages/cycles/show.ejs');
const list = R('views/pages/cycles/index.ejs');
const form = R('views/pages/cycles/form.ejs');
const controller = R('src/controllers/CycleController.js');
const service = R('src/services/CycleService.js');
const v2slf = R('src/routes/v2-slf.js');
const fr = require('../../locales/fr/admin.json');
const en = require('../../locales/en/admin.json');

/** EJS / HTML / block comments stripped — a marker inside a comment proves nothing. */
const live = (s) =>
    s
        .replace(/<%#[\s\S]*?%>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

describe('routes — one contiguous Lot A block with three write tiers (L2-05, L5C-05/11)', () => {
    // Every registration whose text mentions `needle`, each returned as its
    // WHOLE registration (path + guard list) rather than as "the line that
    // happens to contain the needle". Prettier splits a registration across
    // lines once the guards overflow, and a line-based lookup then finds
    // either nothing or a fragment with no guards on it — the assertions
    // below would report an ungated route as missing rather than as ungated.
    const registrations = (block, needle) => {
        const out = [];
        const re = /router\.(get|post|put|delete|use)\(/g;
        let m;
        while ((m = re.exec(block))) {
            const ends = [block.indexOf('=>', m.index), block.indexOf(';', m.index)].filter(
                (i) => i > -1
            );
            const reg = block.slice(m.index, ends.length ? Math.min(...ends) : m.index + 400);
            if (reg.includes(needle)) out.push(reg);
        }
        return out;
    };
    const registrationOf = (block, needle) => registrations(block, needle)[0];

    test('the block exists once and is closed', () => {
        expect(routes.match(/\/\/ ---- SECTION campaigns/g)).toHaveLength(1);
        expect(routes.match(/\/\/ ---- end SECTION campaigns/g)).toHaveLength(1);
        expect(lotA.length).toBeGreaterThan(500);
    });

    test('lifecycle verbs are gated by the lifecycle guard, not by manage_cycles', () => {
        // `'/cycles'` alone matches the GET list too, which is deliberately on
        // the READ tier — pin the verb for that one, as the old literal
        // `router.post('/cycles'` did.
        const CASES = [
            ["'/cycles/new'", null],
            ["'/cycles'", 'post'],
            ['/relaunch', null],
            ['/reopen', null],
            ['/extend', null],
            ['/lock', null],
            ['/cancel', null],
            ['/close', null],
            ['/relaunch-preview', null],
        ];
        CASES.forEach(([needle, verb]) => {
            const found = registrations(lotA, needle);
            const reg = verb ? found.find((r) => r.startsWith(`router.${verb}(`)) : found[0];
            expect(reg).toBeDefined();
            expect(reg).toContain('_cycLifecycle');
        });
    });

    test('roster control needs manage_cycles; reads are open to a manager too', () => {
        ['exclude-bulk', '/exclude', '/include', '/reviewer'].forEach((verb) => {
            const reg = registrationOf(lotA, verb);
            expect(reg).toBeDefined();
            expect(reg).toContain('_cycWrite');
        });
        expect(lotA).toMatch(/const _cycWrite = requirePermission\('manage_cycles'\)/);
        expect(lotA).toMatch(/const _cycRead = requireManagerOrAnyPermission\('manage_cycles'\)/);
        const list = registrations(lotA, "'/cycles'").find((r) => /^router\.get\(/.test(r));
        expect(list).toBeDefined();
        expect(list).toContain('_cycRead');
    });

    test('the chase is its own tier so a manager can nudge their own reports (L5A-01)', () => {
        const reg = registrationOf(lotA, '/nudge');
        expect(reg).toBeDefined();
        expect(reg).toContain('_cycNudge');
    });

    test('every :id segment is numeric — no string id reaches a bigint column', () => {
        lotA.split('\n')
            .filter((l) => l.startsWith('router.') && l.includes(':id'))
            .forEach((l) => expect(l).toMatch(/:id\(\\\\d\+\)/));
    });

    test('the roster CSV export is routed (L5C-13)', () => {
        expect(lotA).toMatch(/router\.get\(\s*'\/cycles\/:id\(\\\\d\+\)\/export\.csv'/);
    });
});

describe('/v2/slf/cycles is retired, not left as a second door (L2-15, L6-08)', () => {
    test('the page 301-redirects to the console and its view file is gone', () => {
        expect(v2slf).toMatch(/router\.get\(\s*'\/cycles'[\s\S]{0,120}redirect\(301, '\/cycles'\)/);
        expect(fs.existsSync(path.join(__dirname, '../../views/pages/slf/cycles.ejs'))).toBe(false);
    });
    test('the old JSON lifecycle endpoints answer 410 so a stale page cannot bypass the audited close', () => {
        expect(v2slf).toMatch(/'\/cycles\/:id\/open'[\s\S]{0,200}410/);
        expect(v2slf).toMatch(/status\(410\)/);
    });
});

describe('console view — filters, bulk excuse, lifecycle, chase (L6-01/02, L2-01/02)', () => {
    const l = live(show);

    test('the roster filter carries every axis the lane asked for, plus "no supervisor"', () => {
        ['siteId', 'departmentId', 'serviceId', 'roleId', 'supervisorId'].forEach((n) => {
            expect(l).toContain(`name="${n}"`);
        });
        expect(l).toMatch(/value="none"/); // « Sans responsable »
        expect(l).toContain('id="cyc-state"'); // combinable with state
        expect(l).toContain('id="cyc-q"'); // and with search
        expect(l).toContain('data-filter-memory'); // Lot 0 list toolkit
    });

    test('the breakdown rows are links that drive the same filters', () => {
        expect(l).toContain('id="cyc-by-group"');
        expect(l).toContain('id="cyc-by-manager"');
        // Each row links back into the roster with the group + state pre-filtered.
        expect(l).toMatch(/qs\(\{ \[groupParam\]: \[r\.id\], state: 'not_started'/);
        expect(l).toMatch(/qs\(\{ \[groupParam\]: \[r\.id\], state: 'in_review'/);
        // groupParam is derived from the grouping axis, so the same four filters
        // the roster form posts are the ones a breakdown row pre-selects.
        expect(l).toMatch(
            /const groupParam = \{ site: 'siteId', department: 'departmentId', service: 'serviceId', manager: 'supervisorId' \}\[by\]/
        );
        expect(controller).toMatch(/departmentId/);
        expect(controller).toMatch(/serviceId/);
    });

    test('the roster has a checkbox column and a selection bar that names the count', () => {
        expect(l).toContain('id="cyc-check-all"');
        expect(l).toContain('id="cyc-bulk"');
        expect(l).toContain('id="cyc-sel-count"');
        expect(l).toContain('id="cyc-bulk-exclude"'); // « Excuser la sélection (n) »
        expect(l).toContain('id="cyc-filter-exclude"'); // « … tout le filtre »
    });

    test('the excuse dialog asks for a category, a mandatory reason and an optional until-date', () => {
        expect(l).toMatch(/<dialog id="cycDlg"/);
        expect(l).toMatch(/data-dlg-field="category"[\s\S]{0,400}categories\.forEach/);
        expect(l).toMatch(/data-dlg-field="reason"[\s\S]{0,600}cyc_dlg_reason_required/);
        expect(l).toMatch(/data-dlg-field="until"[\s\S]{0,300}type="date"/);
        // The four operator categories come from the service, never hard-coded in the view.
        expect(service).toMatch(
            /const USER_CATEGORIES = \['long_leave', 'departure', 'transfer', 'other'\]/
        );
        expect(controller).toMatch(/USER_CATEGORIES/);
    });

    test('lifecycle buttons exist for every transition the console owns', () => {
        ['cyc-launch', 'cyc-extend', 'cyc-lock', 'cyc-close', 'cyc-reopen', 'cyc-cancel'].forEach(
            (id) => expect(l).toContain(`id="${id}"`)
        );
    });

    test('the chase is offered per person, per manager and for the whole selection', () => {
        expect(l).toContain('data-cyc-nudge');
        expect(l).toContain('data-cyc-nudge-sup');
        expect(l).toContain('id="cyc-nudge-all"');
        expect(l).toContain('id="cyc-bulk-nudge"');
    });

    test('a participant row carries re-inclusion and reviewer assignment (L2-09/10)', () => {
        expect(l).toContain('data-cyc-include');
        expect(l).toContain('data-cyc-reviewer');
    });

    test('dates go through Lot 0 fmtDate and states through enumLabel — no raw enum, no toISOString in a cell', () => {
        expect(l).toMatch(/fmtDate\(cycle\.closesAt\)/);
        expect(l).toMatch(/enumLabel\(/);
        expect(l).not.toMatch(/>\s*<%=\s*cycle\.status\s*%>\s*</);
    });

    test('no native confirm()/prompt() survives in the console (L6-19)', () => {
        expect(l).not.toMatch(/(^|[^.\w])confirm\s*\(/);
        expect(l).not.toMatch(/(^|[^.\w])prompt\s*\(/);
    });

    test('the campaign list filters by status and site and offers « Nouvelle campagne » (L5C-17)', () => {
        const li = live(list);
        expect(li).toMatch(/name="status"/);
        expect(li).toMatch(/\/cycles\/new/);
        expect(li).toMatch(/fmtDate\(c\.closesAt\)/);
    });

    test('the create/edit form validates code and both dates client-side too (L2-18)', () => {
        const f = live(form);
        expect(f).toMatch(/name="code"[\s\S]{0,120}required/);
        expect(f).toMatch(/name="opensAt"[\s\S]{0,120}required/);
        expect(f).toMatch(/name="closesAt"[\s\S]{0,120}required/);
    });
});

describe('honesty of the numbers (L2-24, L2-13, product rule 1)', () => {
    test('_pct is the only percentage source and it returns null on an empty denominator', () => {
        expect(service).toMatch(/static _pct\(n, d\)[\s\S]{0,220}if \(!den\) return null/);
    });

    test('the console renders « — » rather than 0 % when nothing is measured', () => {
        expect(live(show)).toMatch(/—/);
        expect(live(show)).toMatch(/!=\s*null|!==\s*null|== null|=== null/);
    });

    test('one shared resolver decides what "the current campaign" is: open, else locked', () => {
        expect(service).toMatch(/static async findCurrent\(\)/);
        expect(service).toMatch(/findCurrent[\s\S]{0,400}'open'[\s\S]{0,200}'locked'/);
        expect(R('src/services/DashboardService.js')).toMatch(
            /getOpenCampaignCycle\(\)[\s\S]{0,200}CycleService'\)\.findCurrent\(\)/
        );
        expect(R('src/controllers/DeptAnalyticsController.js')).toMatch(
            /CycleService'\)\.findCurrent\(\)/
        );
    });

    test('the manager digest follows a locked campaign and says so (L2-13)', () => {
        const d = R('src/jobs/manager-digest.js');
        expect(d).toMatch(/cycle\.status === 'locked'/);
        expect(d).toMatch(/verrouillée/);
    });

    test('the roster CSV goes through the Lot 0 csvResponse (BOM + formula guard)', () => {
        expect(controller).toMatch(/csvResponse\(/);
        expect(controller).toMatch(
            /require\('\.\.\/utils\/listTools'\)|from '\.\.\/utils\/listTools'|listTools/
        );
    });
});

describe('review queue and the manager landing page (L2-17, L5A-02/03, L5C-17)', () => {
    const wf = R('src/services/SelfAssessmentWorkflowService.js');
    const rev = live(R('views/pages/supervisor/self-assessment-review.ejs'));

    test('reviewQueue takes a cycle filter and returns the campaign code', () => {
        expect(wf).toMatch(/async reviewQueue\(user, \{ cycleId \} = \{\}\)/);
        expect(wf).toMatch(/cycleId === 'none'[\s\S]{0,80}cycle_id IS NULL/);
        expect(wf).toMatch(/cyc\.code AS cycle_code/);
        expect(wf).toMatch(/async reviewQueueByEmployee\(user, opts = \{\}\)/);
    });

    test('the review page offers a cycle select and a "not yet submitted" tab', () => {
        expect(rev).toMatch(/id="sa-cycle"/);
        expect(rev).toMatch(/data-sa-tab="pending"/);
    });

    test('/api/my-actions carries a campaign item that reads the ROSTER, with an overdue variant', () => {
        const ta = R('src/controllers/TalentActionsController.js');
        expect(ta).toMatch(/CycleService[\s\S]{0,200}findCurrent\(\)/);
        expect(ta).toMatch(/states\.not_started\.count/);
        expect(ta).toMatch(/camp_ac_not_started_overdue/);
        expect(ta).toMatch(/href: `\/cycles\/\$\{cycle\.id\}\?state=not_started`/);
    });
});

describe('FR/EN parity of everything the console says', () => {
    const used = new Set();
    [
        show,
        list,
        form,
        R('views/pages/supervisor/self-assessment-review.ejs'),
        controller,
        service,
        R('src/controllers/TalentActionsController.js'),
    ]
        .join('\n')
        // Literal keys only — `'admin:cyc_cat_' + c` is a prefix built at render
        // time and is covered by the exclusion-category test below.
        .replace(/['"`]admin:((?:cyc|camp)_[a-z0-9_]*[a-z0-9])['"`]/g, (m, k) => {
            used.add(k);
            return m;
        });

    test('the console really does use the cyc_/camp_ namespace', () => {
        expect(used.size).toBeGreaterThan(40);
    });

    test('every key the console renders exists in FR and in EN', () => {
        const missingFr = [...used].filter((k) => !(k in fr));
        const missingEn = [...used].filter((k) => !(k in en));
        expect({ missingFr, missingEn }).toEqual({ missingFr: [], missingEn: [] });
    });

    test('no FR value is left as English placeholder text for the lifecycle verbs', () => {
        [
            ['cyc_reopen', /rouvrir/i],
            ['cyc_extend', /éten|échéance|report/i],
            ['cyc_close', /clôtur/i],
        ]
            .filter(([k]) => k in fr)
            .forEach(([k, re]) => expect(fr[k]).toMatch(re));
    });

    test('the exclusion categories are translated on both sides, never shown raw', () => {
        ['long_leave', 'departure', 'transfer', 'other', 'deactivated', 'erased'].forEach((c) => {
            const k = `cyc_cat_${c}`;
            expect(fr[k]).toBeDefined();
            expect(en[k]).toBeDefined();
            expect(fr[k]).not.toBe(c);
        });
    });
});
