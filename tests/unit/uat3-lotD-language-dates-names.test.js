'use strict';

process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://placeholder:placeholder@localhost:5432/placeholder';

/**
 * UAT3 SECTION operations — language, dates and names on the inherited surfaces.
 *
 * Measured on idevelop through the lot's own server before the change:
 *   M-15  /talent/actions rendered 12 English date tokens (9 distinct: « Tue Sep 15 »,
 *         « Sun Nov 15 », …) in 6 window cells — PG `date` columns pushed through
 *         String(d).slice(0,10): English, truncated, WITHOUT THE YEAR, on a French page.
 *         TWO sites: the PIP window (actions.ejs:50) and the IDP one (:66).
 *   E-13  /employee/self-assessment carried 1 ISO date inside a French sentence
 *         (« clôturée le 2026-08-31 ») while the neighbouring page wrote 31/08/2026.
 *   A-08  /cycles rendered « 0 % % approuvé » (FR) and « 0 %% approved » (EN): the
 *         percent sign was in the helper AND in the key.
 *   A-12  breadcrumb labels were English literals on French pages
 *         (« Accueil › Configuration › Roles », « Outils »→« Tools », …): 9 blocks
 *         in src/controllers, none of them translated by views/partials/breadcrumbs.ejs.
 *   A-10  `flash:saved` and `flash:generic_error` existed in NEITHER locale, so the
 *         cancellation queue flashed the raw word « saved ».
 *   E-08  the per-COMPETENCY lock sentence was used as the CAMPAIGN banner title, and
 *         the rating badge claimed « Validé » on rows whose own Statut column said
 *         « Soumis » (« Validé » is the label of no state at all).
 *   M-16  /cycles/9 named employee 136 « Clara Beatrice NOVAK » 19 times in the roster
 *         and « Beatrice NOVAK Clara » twice in its own filter.
 *   M-20  /employees?export=csv wrote « Jean-Luc MORENO, Daniel » next to a
 *         supervisor cell reading « Clara Beatrice NOVAK » — two formats, one line.
 *
 * After: 0 English date tokens, 0 ISO dates, 0 « % % », French crumbs, both flash keys
 * resolved, a lock badge that states the lock instead of a state it is not, one name
 * order everywhere.
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const viewPath = (p) => path.join(ROOT, 'views', 'pages', p);
const view = (p) => read(path.join('views', 'pages', p));
// Render WITH the view's own filename, or ejs cannot resolve an include() —
// several pages now pull in views/partials/json-script.ejs.
const renderView = (p, data) => ejs.render(view(p), data, { filename: viewPath(p) });
const locale = (lang, ns) => JSON.parse(read(path.join('locales', lang, `${ns}.json`)));

const { fmtDate, fmtPeriodBound } = require('../../src/utils/dateFormat');

/** A `__` that behaves like i18next for these tests: real strings, real interpolation. */
function translator(lang) {
    const cache = {};
    return (key, opts) => {
        const [ns, k] = String(key).split(':');
        cache[ns] = cache[ns] || locale(lang, ns);
        let s = cache[ns][k];
        if (s === undefined)
            return (opts && opts.defaultValue) !== undefined ? opts.defaultValue : key;
        if (opts)
            for (const [name, value] of Object.entries(opts))
                s = s.split(`{{${name}}}`).join(String(value));
        return s;
    };
}

const ENGLISH_DATE =
    /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
/** Source minus its comments — a fixed defect may be NAMED in a comment without coming back. */
const code = (src) =>
    src
        .replace(/<%#[\s\S]*?%>/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

// ---- shared mocks (jest.mock is hoisted: one database mock for the whole file) ----
const mockDb = { get: jest.fn(), all: jest.fn(), run: jest.fn() };
jest.mock('../../src/config/database', () => mockDb);
jest.mock('../../src/models/RoleSkillRequirementModel', () => ({
    findByRoleId: jest.fn(async () => []),
}));
jest.mock('../../src/models/SelfAssessmentModel', () => ({
    findByEmployeeId: jest.fn(async () => []),
}));
jest.mock('../../src/models/SkillAssessmentModel', () => ({
    findByEmployeeId: jest.fn(async () => []),
}));
jest.mock('../../src/models/SupervisorReviewModel', () => ({}));
jest.mock('../../src/services/ReadinessService', () => ({}));
jest.mock('../../src/services/SelfAssessmentService', () => ({}));
jest.mock('../../src/services/TalentConfidentialityService', () => ({}));

// ---------------------------------------------------------------------------
// M-15 — the talent-actions windows, BOTH of them
// ---------------------------------------------------------------------------
describe('M-15 — PIP and IDP windows are dates, in the page language, with their year', () => {
    // node-pg hands a `date` column back as a Date object; that is the input that
    // used to print « Tue Sep 15 ».
    const d = (iso) => new Date(`${iso}T00:00:00`);
    const render = (lang) =>
        renderView('talent/actions.ejs', {
            __: translator(lang),
            lang,
            cspNonce: 'n',
            csrfToken: 'c',
            assetVersion: '1',
            user: { id: 666, userType: 'admin' },
            enumLabel: (v) => v,
            fmtDate,
            pips: [
                {
                    firstName: 'A',
                    lastName: 'B',
                    employeeNumber: 'X1',
                    state: 'cancelled',
                    startsOn: d('2026-09-15'),
                    endsOn: d('2026-11-15'),
                    summary: '',
                },
            ],
            idps: [
                {
                    firstName: 'C',
                    lastName: 'D',
                    employeeNumber: 'X2',
                    status: 'active',
                    priority: 'high',
                    startsOn: d('2026-06-15'),
                    endsOn: null,
                },
            ],
            coaching: [],
            bias: [],
            summary: {
                pipsTotal: 1,
                pipsActive: 0,
                idpsTotal: 1,
                idpsActive: 1,
                coachingTotal: 0,
                coachingActive: 0,
                avgProgress: null,
                byContext: { skill_gap: 0, pip: 0, idp: 0 },
            },
            attention: { pipsProposed: 0, idpsDraft: 0, coachingStalled: 0, biasOpen: 0 },
        });

    test('FR: the PIP window reads dd/MM/yyyy and carries no English token', () => {
        const html = render('fr');
        expect(html).toContain('15/09/2026 → 15/11/2026');
        expect(html).not.toMatch(ENGLISH_DATE);
    });

    test('the IDP window — the second site, missed by the first report — is fixed too', () => {
        const html = render('fr');
        expect(html).toContain('15/06/2026 → —'); // an absent bound stays a dash, never a 0 or a blank
    });

    test('EN renders the same day-first date (one format per product, not per language)', () => {
        const html = render('en');
        expect(html).toContain('15/09/2026 → 15/11/2026');
        expect(html).not.toMatch(ENGLISH_DATE);
    });

    test('the view no longer stringifies a date column', () => {
        expect(view('talent/actions.ejs')).not.toMatch(/String\((?:p|i)\.(?:startsOn|endsOn)\)/);
    });
});

// ---------------------------------------------------------------------------
// M-15, the REST of the class.
//
// The four tests above render `talent/actions.ejs` and nothing else, so they
// could not see that /v2/pip — the page the fixed one LINKS TO, « gérer → » —
// went on serving 10 English tokens on the SAME plans, 8 of the 9 distinct ones
// the report names, headed by:
//   « Olouwafemi Ella Raissa ODOUNHARO | OODO7669 | Annulé | Tue Sep 15 | Sun Nov 15 »
// The defect is one MOTIF, not one view: `String(x).slice(0, 10)` on a value the
// database hands back as a Date object. These tests pin the motif wherever it
// was still live.
// ---------------------------------------------------------------------------
describe('M-15 — the same motif on the neighbouring pages', () => {
    const d = (iso) => new Date(`${iso}T00:00:00`);

    test('/v2/pip: the task date and BOTH window bounds are dd/MM/yyyy, with their year', () => {
        const html = renderView('pip/index.ejs', {
            __: translator('fr'),
            lang: 'fr',
            cspNonce: 'n',
            csrfToken: 'c',
            assetVersion: '1',
            user: { id: 666, userType: 'admin' },
            enumLabel: (v) => v,
            fmtDate,
            employees: [],
            tasks: [
                {
                    id: 1,
                    firstName: 'O',
                    lastName: 'ODOUNHARO',
                    employeeNumber: 'OODO7669',
                    createdAt: d('2026-09-13'),
                },
            ],
            list: [
                {
                    id: 2,
                    firstName: 'Olouwafemi Ella Raissa',
                    lastName: 'ODOUNHARO',
                    employeeNumber: 'OODO7669',
                    state: 'cancelled',
                    startsOn: d('2026-09-15'),
                    endsOn: d('2026-11-15'),
                    summary: '',
                },
                {
                    id: 3,
                    firstName: 'A',
                    lastName: 'B',
                    employeeNumber: 'X',
                    state: 'proposed',
                    startsOn: d('2026-06-15'),
                    endsOn: null,
                    summary: '',
                },
            ],
        });
        expect(html).not.toMatch(ENGLISH_DATE);
        expect(html).toContain('15/09/2026');
        expect(html).toContain('15/11/2026');
        expect(html).toContain('13/09/2026');
        expect(html).toContain('15/06/2026');
        // An absent bound is « — », never « Invalid Date » and never a blank cell.
        expect(html).toContain('—');
    });

    test('the motif is gone from every server-rendered view that carried it', () => {
        for (const p of [
            'pip/index.ejs',
            'capability/index.ejs',
            'slf/disputes.ejs',
            'continuity/index.ejs',
        ]) {
            expect(code(view(p))).not.toMatch(/String\([a-zA-Z_$][\w.$]*\)\.slice\(0,\s*10\)/);
        }
        // cycles/show.ejs froze the close date into a SHOWN dialog sentence.
        expect(code(view('cycles/show.ejs'))).not.toMatch(/String\(cycle\.closedAt\)\.slice/);
        expect(code(view('cycles/show.ejs'))).toMatch(/fmtDate\(cycle\.closedAt\)/);
    });

    test('each of them renders through the product ONE date helper', () => {
        expect(code(view('pip/index.ejs')).match(/fmtDate\(/g)).toHaveLength(3);
        expect(code(view('capability/index.ejs'))).toMatch(/fmtDate\(c\.createdAt\)/);
        expect(code(view('slf/disputes.ejs'))).toMatch(/fmtDate\(d\.openedAt\)/);
        // The continuity handover row is built by the page's own JS, so it gets
        // the same contract in JS: dd/MM/yyyy forced to UTC, « — » when absent.
        expect(code(view('continuity/index.ejs'))).toMatch(/function ctDate\(v\)/);
        expect(code(view('continuity/index.ejs'))).toMatch(/\+ctDate\(h\.dueDate\)\+/);
        // …and its server-side twin, which hid the same motif in a try/catch:
        // a Date object made the reconstructed date invalid and the catch
        // printed « Tue Sep 15 » straight out.
        expect(code(view('continuity/index.ejs'))).toMatch(/function sDate\(v\)/);
        expect(code(view('continuity/index.ejs'))).not.toMatch(/toLocaleDateString\(_sLang\)/);
    });

    test('ctDate answers the same three cases as fmtDate — value, absence, garbage', () => {
        const src = view('continuity/index.ejs');
        const body = src.slice(src.indexOf('function ctDate(v){'));
        // eslint-disable-next-line no-new-func
        const ctDate = new Function(
            `${body.slice(0, body.indexOf('\nconst CONT'))}\nreturn ctDate;`
        )();
        expect(ctDate('2026-09-15')).toBe('15/09/2026');
        expect(ctDate('2026-09-15T00:00:00.000Z')).toBe('15/09/2026');
        expect(ctDate(null)).toBe('—');
        expect(ctDate('not a date')).toBe('—');
    });
});

// ---------------------------------------------------------------------------
// E-13 — ISO dates out of French prose
// ---------------------------------------------------------------------------
describe('E-13 — a campaign close date is written dd/MM/yyyy, in prose and in the refusal', () => {
    jest.doMock('../../src/models/EmployeeModel', () => ({
        findByIdWithOrganization: jest.fn(async () => ({ id: 138, roleId: 7, roleName: 'R' })),
    }));
    const Portal = require('../../src/controllers/EmployeePortalController');
    const req = () => ({
        user: { id: 138, userType: 'employee' },
        t: translator('fr'),
        query: {},
        params: {},
    });
    const res = () => ({
        locals: {},
        render(v, l) {
            this.view = v;
            this.locals = l;
        },
        status() {
            return this;
        },
        json() {
            return this;
        },
    });

    beforeEach(() => {
        mockDb.get.mockReset();
        mockDb.all.mockReset();
    });

    test('an OPEN campaign: the deadline is formatted once, by the controller', async () => {
        mockDb.get.mockResolvedValueOnce({
            id: 9,
            code: '2026-Q3',
            label: '2026-Q3',
            closesAt: '2026-08-31T00:00:00.000Z',
        });
        const r = res();
        await Portal.selfAssessment(req(), r);
        expect(r.locals.cycle.closesAtText).toBe('31/08/2026');
    });

    test('a LOCKED enrolment: same format on the notice the employee reads', async () => {
        mockDb.get.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 9,
            code: '2026-Q3',
            label: '2026-Q3',
            closesAt: '2026-08-31T00:00:00.000Z',
        });
        const r = res();
        await Portal.selfAssessment(req(), r);
        expect(r.locals.lockedCycle.closesAtText).toBe('31/08/2026');
    });

    test('the UTC bound never slides a day (this is why fmtPeriodBound, not a local format)', () => {
        expect(fmtPeriodBound('2026-08-31T00:00:00.000Z')).toBe('31/08/2026');
    });

    test('neither the view nor the controller still builds a date with toISOString().slice(0,10)', () => {
        expect(code(view('employee/self-assessment.ejs'))).not.toMatch(
            /toISOString\(\)\.slice\(0, ?10\)/
        );
        // The ones left in the controller are unreachable catch-fallbacks of
        // toLocaleDateString; what must be gone is the campaign-close sentence.
        expect(code(read('src/controllers/EmployeePortalController.js'))).not.toMatch(
            /date: .*toISOString/
        );
    });
});

// ---------------------------------------------------------------------------
// A-08 — one percent sign, and « — » when nothing is measured
// ---------------------------------------------------------------------------
describe('A-08 — the campaign list prints one percent sign', () => {
    const render = (lang, pct) =>
        renderView('cycles/index.ejs', {
            __: translator(lang),
            lang,
            cspNonce: 'n',
            csrfToken: 'c',
            assetVersion: '1',
            user: { id: 666, userType: 'admin' },
            enumLabel: (a, b) => (b === undefined ? a : b),
            fmtDate,
            canLaunch: true,
            canManage: true,
            scopedCaption: null,
            sites: [],
            filters: { status: '', siteId: '' },
            cycles: [
                {
                    id: 1,
                    code: '2026-Q3',
                    label: '2026-Q3',
                    status: 'locked',
                    openedAt: null,
                    closesAt: null,
                },
            ],
            summaries: {
                1: {
                    active: 76,
                    approved: 0,
                    inReview: 0,
                    inProgress: 1,
                    notStarted: 75,
                    pctApproved: pct,
                    pctInReview: 0,
                    pctInProgress: 1,
                    pctNotStarted: 99,
                },
            },
        });

    test.each(['fr', 'en'])('[%s] a measured 0 renders « 0 % » exactly once', (lang) => {
        const html = render(lang, 0);
        expect(html).not.toMatch(/%\s*%/);
        expect(html).toContain(lang === 'fr' ? '0 % approuvé' : '0 % approved');
    });

    test('an UNMEASURED rate stays a dash and grows no percent sign', () => {
        const html = render('fr', null);
        expect(html).toContain('— approuvé');
        expect(html).not.toMatch(/—\s*%/);
    });

    test('the key carries no percent sign of its own, in either locale', () => {
        for (const lang of ['fr', 'en']) {
            expect(locale(lang, 'admin').cyc_bar_caption).toContain('{{pct}}');
            expect(locale(lang, 'admin').cyc_bar_caption).not.toContain('%');
        }
    });
});

// ---------------------------------------------------------------------------
// A-12 — the whole breadcrumb class, not one page
// ---------------------------------------------------------------------------
describe('A-12 — every breadcrumb label goes through the catalogue', () => {
    const { bc } = require('../../src/utils/breadcrumbLabel');

    test('bc() translates when i18n is attached, and keeps the English literal otherwise', () => {
        expect(bc({ t: translator('fr') }, 'chrome:pt_roles', 'Roles')).toBe('Postes');
        expect(bc({ t: translator('en') }, 'chrome:pt_roles', 'Roles')).toBe('Roles');
        expect(bc(null, 'chrome:pt_roles', 'Roles')).toBe('Roles'); // never a raw namespace:key
    });

    test('no controller passes a hard-coded breadcrumb label any more', () => {
        const dir = path.join(ROOT, 'src', 'controllers');
        const offenders = [];
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            const blocks = src.match(/breadcrumbs\s*:\s*\[[\s\S]{0,600}?\]/g) || [];
            for (const b of blocks) {
                // A literal is `label: 'Something'` / "Something" — a translated label is a
                // call, and a person's name is a template literal or a variable.
                const lits = b.match(/label\s*:\s*['"][^'"]+['"]/g) || [];
                if (lits.length) offenders.push(`${f}: ${lits.join(' | ')}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('the labels the trails now ask for exist in BOTH locales', () => {
        for (const lang of ['fr', 'en']) {
            const chrome = locale(lang, 'chrome');
            for (const k of [
                'pt_roles',
                'pt_employees',
                'pt_data_management',
                'pt_sql_console',
                'pt_skill_matrix',
                'pt_onboarding_queue',
                'pt_bc_tools',
                'pt_bc_administration',
                'nav_dashboard',
            ]) {
                expect(typeof chrome[k]).toBe('string');
                expect(chrome[k].length).toBeGreaterThan(0);
            }
            expect(typeof locale(lang, 'admin').set_bc_configuration).toBe('string');
        }
    });
});

// ---------------------------------------------------------------------------
// A-10 — the two flash keys that did not exist
// ---------------------------------------------------------------------------
describe('A-10 — a flash never renders its own key', () => {
    test.each(['fr', 'en'])(
        '[%s] flash:saved and flash:generic_error resolve to a sentence',
        (lang) => {
            const flash = locale(lang, 'flash');
            for (const k of ['saved', 'generic_error']) {
                expect(typeof flash[k]).toBe('string');
                expect(flash[k]).not.toBe(k);
                expect(flash[k].trim().length).toBeGreaterThan(2);
            }
        }
    );

    test('the keys are the ones the code actually asks for (not orphans)', () => {
        const src = read('src/controllers/CancellationController.js');
        expect(src).toContain("req.t('flash:saved')");
        expect(src).toContain("req.t('flash:generic_error')");
    });

    test('flash:generic_error also covers the three other controllers that call it', () => {
        for (const f of [
            'DelegationController',
            'MovementController',
            'QualifiedPeopleController',
        ]) {
            expect(read(`src/controllers/${f}.js`)).toContain('flash:generic_error');
        }
    });
});

// ---------------------------------------------------------------------------
// E-08 — a badge states the lock; the Statut column states the state
// ---------------------------------------------------------------------------
describe('E-08 — the self-assessment page stops contradicting itself', () => {
    const skill = (status) => ({
        skillId: 300,
        skillName: 'S',
        domainName: 'D',
        requiredLevel: 3,
        isCritical: false,
        selfRatedLevel: 2,
        currentSkillLevel: 2,
        status,
        selfAssessment: { notes: '' },
    });
    const render = (lang, extra) =>
        renderView('employee/self-assessment.ejs', {
            __: translator(lang),
            lang,
            cspNonce: 'n',
            csrfToken: 'c',
            assetVersion: '1',
            user: { id: 138, userType: 'employee' },
            employee: { roleName: 'R' },
            skillsWithAssessments: [skill('submitted')],
            cycle: null,
            lockedCycle: null,
            saTotal: 1,
            saRated: 1,
            saRemaining: 0,
            ...extra,
        });

    test.each(['fr', 'en'])('[%s] a SUBMITTED row is never badged as validated', (lang) => {
        const html = render(lang);
        const emp = locale(lang, 'employee');
        expect(html).toContain(emp.sa_rating_locked);
        expect(html).not.toContain(`> ${emp.sa_locked}<`); // « Validé » / « Validated »
        expect(html).toContain(emp.state_submitted); // the Statut column still says it
    });

    test('the locked-campaign banner has a CAMPAIGN title, not the per-competency sentence', () => {
        const html = render('fr', {
            lockedCycle: {
                code: '2026-Q3',
                label: '2026-Q3',
                closesAt: '2026-08-31T00:00:00.000Z',
                closesAtText: '31/08/2026',
            },
        });
        const emp = locale('fr', 'employee');
        expect(html).toContain(emp.sa_locked_campaign_title);
        expect(html).toContain('clôturée le 31/08/2026');
        expect(html).not.toMatch(ISO_DATE);
        // The competency sentence is still available where it belongs — on the row
        // (compared on its unescaped head: EJS escapes the apostrophe in the title=).
        expect(html).toContain(emp.sa_locked_title.split(':')[0].trim());
    });
});

// ---------------------------------------------------------------------------
// M-16 / M-20 — one name order
// ---------------------------------------------------------------------------
describe('M-16 — the campaign console names a supervisor the same way everywhere', () => {
    const CycleService = require('../../src/services/CycleService');

    test('the supervisor filter labels read given name then family name', async () => {
        mockDb.all.mockReset();
        mockDb.get.mockReset();
        mockDb.all.mockResolvedValue([]);
        mockDb.get.mockResolvedValue({ n: 0 });
        await CycleService.filterOptions(
            9,
            { id: 666, userType: 'admin' },
            { scope: { clause: '', params: [] } }
        );
        const statements = mockDb.all.mock.calls.map((c) => c[0]);
        // 3.23.18 (R1): the filter offers the LIVE responsable `rsp` (employee
        // `rspe`, or an admin named by its linked person `rspae`) — same name order.
        const supervisorSelect = statements.find((s) => /rsp\.id AS id/.test(s));
        expect(supervisorSelect).toBeTruthy();
        expect(supervisorSelect).toMatch(
            /COALESCE\(rspe\.first_name[\s\S]*COALESCE\(rspe\.last_name/
        );
        expect(supervisorSelect).not.toMatch(
            /COALESCE\(rspe\.last_name[\s\S]*COALESCE\(rspe\.first_name/
        );
        expect(supervisorSelect).toMatch(
            /COALESCE\(rspae\.first_name[\s\S]*COALESCE\(rspae\.last_name/
        );
        expect(supervisorSelect).not.toMatch(
            /COALESCE\(rspae\.last_name[\s\S]*COALESCE\(rspae\.first_name/
        );
    });

    test('no SQL in CycleService concatenates the family name first any more', () => {
        // Only an ADJACENT « last || ' ' || first » is the defect; the search index
        // legitimately lists e.last_name … sup.first_name further along the same line.
        expect(code(read('src/services/CycleService.js'))).not.toMatch(
            /last_name[^|]*\|\|\s*' '\s*\|\|\s*(?:TRIM\()?COALESCE\([a-z]+\.first_name/
        );
    });
});

describe('M-20 — the directory export writes the same name as the screen it mirrors', () => {
    const mockEmployeeModel = {
        SORT_COLUMNS: { site: 's.name' },
        findPageWithOrg: jest.fn(async () => ({
            rows: [
                {
                    id: 1,
                    employeeNumber: 'MOUA1184',
                    firstName: 'Daniel',
                    lastName: 'Jean-Luc MORENO',
                    roleName: 'Confirmed Soft/ML Engineer',
                    siteName: 'Riverside',
                    departmentName: 'IT',
                    serviceName: 'Data & Insights',
                    supervisorName: 'Clara Beatrice NOVAK',
                    email: '',
                    username: 'MOUA1184',
                    isActive: true,
                },
            ],
            total: 1,
        })),
        accountStates: jest.fn(async () => new Map()),
        campaignStates: jest.fn(async () => new Map()),
        findGovernedIds: jest.fn(async () => []),
    };
    const mockCsv = jest.fn();

    beforeAll(() => {
        jest.resetModules();
        jest.doMock('../../src/models/EmployeeModel', () => mockEmployeeModel);
        jest.doMock('../../src/services/RBACService', () => ({
            isSuperAdmin: () => true,
            getAdminWithScopes: jest.fn(),
        }));
        jest.doMock('../../src/services/LogService', () => ({ log: jest.fn() }));
        jest.doMock('../../src/controllers/InvitationController', () => ({
            lockoutPolicy: () => ({}),
        }));
        const actualListTools = jest.requireActual('../../src/utils/listTools');
        jest.doMock('../../src/utils/listTools', () => ({
            ...actualListTools,
            csvResponse: mockCsv,
        }));
    });
    afterAll(() => {
        jest.resetModules();
    });

    test('the name cell is « prénom nom », like the supervisor cell of the same row', async () => {
        const Employees = require('../../src/controllers/EmployeeController');
        const req = {
            query: { export: 'csv' },
            path: '/employees',
            user: { id: 666, userType: 'admin' },
            t: translator('fr'),
            ip: '::1',
            get: () => '',
        };
        await Employees.index(req, { render() {}, redirect() {}, locals: {} });
        expect(mockCsv).toHaveBeenCalled();
        const rows = mockCsv.mock.calls[0][3];
        expect(rows[0][1]).toBe('Daniel Jean-Luc MORENO');
        expect(rows[0][1]).not.toContain(','); // no « FAMILY, Given »
        expect(rows[0][6]).toBe('Clara Beatrice NOVAK'); // the supervisor cell it used to disagree with
    });
});
